import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.mjs';
import { createBookingService } from './lib/booking.mjs';
import { createPayPal, verifyCapture } from './lib/paypal.mjs';
import { createQwen } from './lib/qwen.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.json':'application/json'};
const inflight = new Map();
function single(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
function cookieNames(req) {
  const port = String(req.headers.host || '').split(':').at(-1);
  return {request:`together_request_${port}`,token:`together_token_${port}`};
}
function clearCookies(req) {
  const names = cookieNames(req);
  return [names.request,names.token].map(name=>`${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
function cookie(req) {
  const entries = (req.headers.cookie || '').split(';').map(x => x.trim().split('='));
  const cookies = Object.fromEntries(entries);
  const names = cookieNames(req);
  return {requestId:cookies[names.request],token:cookies[names.token]};
}
function json(res, status, body, headers={}) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});
  res.end(JSON.stringify(body));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 12000) throw Object.assign(new Error('Request is too large.'),{status:413});
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw Object.assign(new Error('Send a valid JSON request.'),{status:400}); }
}

export async function createApplication({dataFile=path.join(ROOT,'.data/state.json'),clock=Date.now,demoMode=true,paypal,qwen,dev=false}={}) {
  const store = createStore({filePath:dataFile});
  const booking = createBookingService({store,clock});
  paypal ||= createPayPal({clientId:process.env.PAYPAL_CLIENT_ID,clientSecret:process.env.PAYPAL_CLIENT_SECRET});
  qwen ||= createQwen({baseUrl:process.env.OLLAMA_BASE_URL,model:process.env.QWEN_MODEL});
  const vite = dev ? await (await import('vite')).createServer({root:ROOT,server:{middlewareMode:true},appType:'spa'}) : null;
  let aiReady = {ready:false,model:qwen.config().model};
  qwen.readiness().then(v=>{aiReady=v;}).catch(()=>{});
  async function snapshot(req,studio=false,auth=cookie(req)) {
    return {...await booking.snapshot({...auth,studio}),providers:{paypal:paypal.config(),qwen:aiReady},demoMode};
  }
  function studioAllowed() {
    if (!demoMode) throw Object.assign(new Error('Studio tools are available in the local demo only.'),{status:403});
  }
  async function own(req) {
    const auth = cookie(req);
    if (!auth.requestId || !auth.token) throw Object.assign(new Error('Join the waitlist first.'),{status:401});
    return auth;
  }
  async function capture(req,orderId,reconcile=false) {
    const auth = await own(req);
    return single(`capture:${auth.requestId}`,async()=>{
      const intent = await booking.beginCapture(auth.requestId,auth.token,{orderId});
      if (intent.action === 'completed') return intent.request;
      reconcile = reconcile || intent.action === 'reconcile';
      const offer = intent.offer || intent.request?.offer || intent;
      try {
        if (!reconcile) await paypal.captureOrder(orderId,{requestKey:`${offer.id}-capture`});
        let order = await paypal.getOrder(orderId);
        if (reconcile && order.status === 'APPROVED') {
          await paypal.captureOrder(orderId,{requestKey:`${offer.id}-capture`});
          order = await paypal.getOrder(orderId);
        }
        if (reconcile && ['CREATED','SAVED','PAYER_ACTION_REQUIRED','VOIDED'].includes(order.status) && !(order.purchase_units || []).some(unit=>unit.payments?.captures?.length)) {
          throw Object.assign(new Error('PayPal has not approved this order yet. Finish the sandbox checkout while the offer is still held.'),{status:409,code:'PAYMENT_NOT_APPROVED',definitive:true});
        }
        const verified = verifyCapture(order,{orderId,totalCents:offer.totalCents,currency:'USD',requestId:auth.requestId,offerId:offer.id});
        return await booking.completeCapture(auth.requestId,verified);
      } catch (error) {
        await booking.failCapture(auth.requestId,{orderId,definitive:error.definitive === true,reason:error.message});
        throw error;
      }
    });
  }
  const server = http.createServer(async(req,res)=>{
    const host = req.headers.host || '';
    const origin = `http://${host}`;
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    try {
      if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) return json(res,403,{error:'Use the printed local address for this app.'});
      const url = new URL(req.url,origin);
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'POST' && (req.headers.origin !== origin || !String(req.headers['content-type']).startsWith('application/json'))) {
          return json(res,403,{error:'Open the app to make changes.'});
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const auth=cookie(req);
          let state;
          let clear=false;
          try {
            if (Boolean(auth.requestId) !== Boolean(auth.token)) {
              clear=true;
              state=await snapshot(req,false,{});
            } else state=await snapshot(req);
          } catch(error) {
            if (!['NOT_FOUND','UNAUTHORIZED','INVALID_SESSION'].includes(error.code)) throw error;
            clear=true;
            state=await snapshot(req,false,{});
          }
          return json(res,200,state,clear?{'Set-Cookie':clearCookies(req)}:{});
        }
        if (req.method === 'GET' && url.pathname === '/api/studio') {studioAllowed();return json(res,200,await snapshot(req,true));}
        if (req.method !== 'POST') return json(res,404,{error:'Endpoint not found.'});
        const input = await body(req);
        if (url.pathname === '/api/preferences') {
          const state = await booking.snapshot();
          const parsed = await qwen.parsePreferences({text:input.text,sessions:state.sessions,timeZone:'America/Los_Angeles'});
          aiReady={...qwen.config(),ready:true};
          return json(res,200,parsed);
        }
        if (url.pathname === '/api/requests') {
          const previous = await snapshot(req);
          if (previous.request && !['cancelled','expired','booked'].includes(previous.request.status)) throw Object.assign(new Error('Your group is already on the waitlist. Cancel it before making a new request.'),{status:409});
          const result = await booking.join(input);
          const names=cookieNames(req);
          const cookies=[`${names.request}=${result.request.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`,`${names.token}=${result.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`];
          return json(res,201,{request:result.request},{'Set-Cookie':cookies});
        }
        if (url.pathname === '/api/requests/cancel' || url.pathname === '/api/requests/retry') {
          const auth=await own(req);
          const method=url.pathname.endsWith('cancel')?'cancel':'retry';
          await booking[method](auth.requestId,auth.token);
          return json(res,200,await snapshot(req));
        }
        if (url.pathname === '/api/requests/new') {
          const current=await snapshot(req);
          if (current.request && !['booked','cancelled','expired'].includes(current.request.status)) throw Object.assign(new Error('Finish or cancel your current request first.'),{status:409});
          return json(res,200,{ok:true},{'Set-Cookie':clearCookies(req)});
        }
        if (url.pathname === '/api/studio/release') {studioAllowed();await booking.releaseSeats(input.sessionId,input.count);return json(res,200,await snapshot(req,true));}
        if (url.pathname === '/api/studio/expire') {studioAllowed();await booking.expireOffer(input.requestId);return json(res,200,await snapshot(req,true));}
        if (url.pathname === '/api/demo/complete') {studioAllowed();const auth=await own(req);await booking.simulateBooking(auth.requestId,auth.token);return json(res,200,await snapshot(req));}
        if (url.pathname === '/api/paypal/orders') {
          if (!paypal.config().configured) throw Object.assign(new Error('PayPal sandbox needs a client ID and secret in the local .env file. You can still try the labeled demo checkout.'),{status:503});
          const auth=await own(req);
          const result=await single(`order:${auth.requestId}`,async()=>{
            const intent=await booking.beginCheckout(auth.requestId,auth.token);
            const offer=intent.offer || intent.request?.offer || intent;
            if (offer.orderId && offer.approvalUrl) return {orderId:offer.orderId,approvalUrl:offer.approvalUrl};
            try {
              const order=await paypal.createOrder({requestId:auth.requestId,offerId:offer.id,totalCents:offer.totalCents,currency:'USD',returnUrl:`${origin}/?payment=return`,cancelUrl:`${origin}/?payment=cancel`,requestKey:`${offer.id}-create`});
              await booking.attachOrder(auth.requestId,auth.token,{offerId:offer.id,...order});
              return order;
            } catch(error) { if (booking.abortCheckout && error.definitive) await booking.abortCheckout(auth.requestId,auth.token,{offerId:offer.id,reason:error.message});throw error; }
          });
          return json(res,200,result);
        }
        if (url.pathname === '/api/paypal/capture' || url.pathname === '/api/paypal/reconcile') {
          if (typeof input.orderId !== 'string') throw Object.assign(new Error('A PayPal order is required.'),{status:400});
          await capture(req,input.orderId,url.pathname.endsWith('reconcile'));
          return json(res,200,await snapshot(req));
        }
        return json(res,404,{error:'Endpoint not found.'});
      }
      if (vite) return vite.middlewares(req,res,()=>json(res,404,{error:'Page not found.'}));
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      let file = path.resolve(ROOT,'dist',relative);
      const base = path.resolve(ROOT,'dist')+path.sep;
      if (!file.startsWith(base)) return json(res,404,{error:'File not found.'});
      try { if (!(await stat(file)).isFile()) file=path.join(base,'index.html'); }
      catch {file=path.join(base,'index.html');}
      const data=await readFile(file);
      res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':file.endsWith('index.html')?'no-cache':'public, max-age=3600'});
      res.end(data);
    } catch(error) {
      const status=Number.isInteger(error.status) && error.status>=400 && error.status<=599 ? error.status : 500;
      const message = status === 500 ? 'This action could not finish. Refresh and check your booking status before trying again.' : error.message;
      json(res,status,{error:message,code:error.code || 'ACTION_FAILED'});
      if (status===500) console.error('Action failed:',error.name,error.code || '',error.message);
    }
  });
  return {server,booking,store,close:async()=>{await vite?.close();await new Promise(resolve=>server.close(resolve));}};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT || 3210);
  const app=await createApplication({dev:process.argv.includes('--dev'),demoMode:process.env.DEMO_MODE !== 'false',dataFile:process.env.DATA_FILE || undefined});
  app.server.listen(port,'127.0.0.1',()=>console.log(`Together is ready at http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await app.close();process.exit(0);});
}
