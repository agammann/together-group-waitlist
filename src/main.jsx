import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/dm-sans/latin-600.css';
import '@fontsource/dm-sans/latin-700.css';
import './style.css';

const money = cents => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(cents/100);
const when = value => new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',weekday:'short',month:'short',day:'numeric'}).format(new Date(value));
const time = value => new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'}).format(new Date(value));
function Arrow({back=false}) {return <svg aria-hidden="true" viewBox="0 0 24 24" className={`arrow ${back?'back':''}`}><path d="M3 12h17m-6-6 6 6-6 6"/></svg>;}
function Check() {return <svg aria-hidden="true" viewBox="0 0 20 20" className="check"><circle cx="10" cy="10" r="10"/><path d="m5.5 10 3 3 6-6"/></svg>;}
function PayPal() {return <span className="paypal-word" aria-label="PayPal"><b>Pay</b><b>Pal</b></span>;}
async function api(url, data) {
  const response=await fetch(url,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json();
  if (!response.ok) throw new Error(result.error || 'This action could not finish. Please try again.');
  return result;
}
function App() {
  const [view,setView]=useState('customer');
  const [state,setState]=useState(null);
  const [studio,setStudio]=useState(null);
  const [name,setName]=useState('');
  const [groupSize,setGroupSize]=useState(2);
  const [budget,setBudget]=useState('75.00');
  const [dates,setDates]=useState(null);
  const [prompt,setPrompt]=useState('Two of us, any weekend afternoon, up to $75 total.');
  const [draft,setDraft]=useState(null);
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [seconds,setSeconds]=useState(Date.now());
  const returning=useRef(false);
  const refresh=useCallback(async()=>{
    const data=await api('/api/state');
    setState({...data,clockOffset:Date.parse(data.serverNow)-Date.now()});
    setDates(previous=>previous ?? data.sessions.filter(x=>new Date(x.startsAt).toLocaleTimeString('en-US',{timeZone:'America/Los_Angeles',hour12:false,hour:'2-digit'})>='12').map(x=>x.id));
    if (view==='studio' && data.demoMode) setStudio(await api('/api/studio'));
    return data;
  },[view]);
  useEffect(()=>{refresh().catch(e=>setError(e.message));const id=setInterval(()=>refresh().catch(()=>{}),3500);return()=>clearInterval(id);},[refresh]);
  useEffect(()=>{const id=setInterval(()=>setSeconds(Date.now()),1000);return()=>clearInterval(id);},[]);
  const act=async(label,fn)=>{
    setBusy(label);setError('');setNotice('');
    try {await fn();await refresh();}
    catch(e){setError(e.message);await refresh().catch(()=>{});}
    finally{setBusy('');}
  };
  useEffect(()=>{
    const params=new URLSearchParams(location.search);
    if (!state || returning.current || !params.has('payment')) return;
    returning.current=true;
    if(params.get('payment')==='cancel') {setNotice('PayPal checkout was cancelled. Your places stay held until the timer ends.');history.replaceState({},'',location.pathname);return;}
    const orderId=params.get('token');
    history.replaceState({},'',location.pathname);
    if(orderId) act('Confirming PayPal payment',()=>api('/api/paypal/capture',{orderId}));
    else setError('No PayPal order was returned. Use Check payment status to verify your booking.');
  },[state]);
  const own=state?.request;
  useEffect(()=>{
    if (own && own.status!=='cancelled') {
      setGroupSize(own.groupSize);setBudget((own.maxTotalCents/100).toFixed(2));setDates(own.sessionIds);setPrompt(own.note || '');
    }
  },[own?.id]);
  const chosen=state?.sessions.filter(x=>(dates || []).includes(x.id)) || [];
  const heldSession=state?.sessions.find(x=>x.id===own?.offer?.sessionId);
  const ends=own?.offer ? Math.max(0,Math.min(state.holdMinutes*60,Math.ceil((Date.parse(own.offer.expiresAt)-(seconds+(state.clockOffset||0)))/1000))) : 0;
  const countdown=`${Math.floor(ends/60)}:${String(ends%60).padStart(2,'0')}`;
  const maxCents=Math.round(Number(budget)*100);
  const active=own && own.status!=='cancelled';
  const toggleDate=id=>{setDraft(null);setDates(previous=>previous.includes(id)?previous.filter(x=>x!==id):[...previous,id]);};
  const parse=()=>act('Finding your preferences',async()=>setDraft(await api('/api/preferences',{text:prompt})));
  const apply=()=>{if(draft.groupSize!=null)setGroupSize(draft.groupSize);if(draft.maxTotalCents!=null)setBudget((draft.maxTotalCents/100).toFixed(2));setDates(draft.sessionIds);setDraft(null);setNotice('Preferences applied. Review your dates, group size, and budget before joining.');};
  const join=()=>act('Joining the waitlist',async()=>{
    if (!name.trim()) throw new Error('Tell us your name so the studio can recognize your group.');
    if (!chosen.length) throw new Error('Choose at least one date that works for everyone.');
    if (!Number.isFinite(maxCents) || maxCents<=0) throw new Error('Enter a maximum total greater than zero.');
    if (!chosen.some(session=>session.priceCents*groupSize<=maxCents)) throw new Error(`Your group needs at least ${money(Math.min(...chosen.map(session=>session.priceCents))*groupSize)} for these dates. Raise the budget or choose another date.`);
    await api('/api/requests',{customerName:name.trim(),groupSize,sessionIds:dates,maxTotalCents:maxCents,note:prompt.slice(0,1000)});
    setNotice('Your group is on the waitlist. We’ll hold every place together when a date opens.');
  });
  const pay=()=>act('Opening PayPal sandbox',async()=>{const result=await api('/api/paypal/orders',{});location.assign(result.approvalUrl);});
  if (!state) return <main className="loading"><div className="brand">Together</div><p>{error || 'Getting the studio ready…'}</p></main>;
  return <>
    <header className="header"><a className="brand" href="/" aria-label="Together home"><svg aria-hidden="true" viewBox="0 0 54 36"><circle cx="18" cy="18" r="14"/><circle cx="35" cy="18" r="14"/></svg>Together</a><nav aria-label="View"><button className={view==='customer'?'selected':''} onClick={()=>setView('customer')}>Customer</button>{state.demoMode && <button className={view==='studio'?'selected':''} onClick={()=>setView('studio')}>Studio</button>}</nav><span className="studio-name">Stillwater Studio</span></header>
    <main className="container">
      {view==='customer' ? <>
        <section className="hero"><div><h1>Good things happen together.</h1><p>One waitlist. A few dates. Room for everyone.</p></div><img src="/studio.png" alt="Hands shaping a bowl on a pottery wheel in a sunlit studio"/></section>
        {(error||notice||busy) && <div className={`notice ${error?'error':''}`} role={error?'alert':'status'}>{error || busy || notice}{!busy && <button aria-label="Dismiss message" onClick={()=>{setError('');setNotice('');}}>×</button>}</div>}
        <div className="customer-grid"><section className="preferences"><h2>Find room for your group</h2><p className="intro">Choose every date that works. We keep your group together.</p>
          <label className="prompt-label" htmlFor="plans">Describe your plans</label><div className="prompt-row"><textarea id="plans" rows="1" value={prompt} maxLength={1000} onChange={e=>setPrompt(e.target.value)} disabled={!!active}/><button className="outline" onClick={parse} disabled={!!busy||!!active||!prompt.trim()}>{busy==='Finding your preferences'?'Reading your plans…':'Use my preferences'}</button></div>
          {draft && <div className="draft"><h3>Does this sound right?</h3><p>We matched your plans to the studio’s schedule. Review the dates, group size, and total before applying.</p><div className="draft-summary"><span>{draft.groupSize || 'Choose'} places together</span><span>{draft.sessionIds.length} acceptable dates</span><span>{draft.maxTotalCents!=null?money(draft.maxTotalCents):'Set your budget'} total</span></div>{draft.warnings?.map((text,i)=><p className="muted" key={i}>{text}</p>)}<button className="primary" onClick={apply}>Apply these preferences <Check/></button><button className="text-button" onClick={()=>setDraft(null)}>Keep my choices</button></div>}
          <div className="section-top"><h3>Choose your dates</h3><span>All times Pacific</span></div><div className="date-list">
            {state.sessions.map(session=>{
              const selected=(dates || []).includes(session.id);
              const costly=groupSize*session.priceCents>maxCents;
              const past=new Date(session.startsAt).getTime()<=Date.now();
              return <label key={session.id} className={`date-row ${selected?'checked':''} ${past?'past':''}`}><input type="checkbox" checked={selected} onChange={()=>toggleDate(session.id)} disabled={!!active||past} aria-label={`${when(session.startsAt)}, ${session.title}, ${money(session.priceCents)} per person`}/><span className="date-day">{when(session.startsAt)}</span><span className="date-time">{time(session.startsAt)}<span className="end-time"> – {time(session.endsAt)}</span></span><span className="session-title">{session.title}<small>{costly?'Above your group budget':'90 minutes · materials included'}</small></span><span className="price">{money(session.priceCents).replace('.00','')}<small>per person</small></span><span className={`availability ${session.availableSeats>=groupSize?'enough':''}`}>{session.availableSeats} {session.availableSeats===1?'place':'places'} left</span></label>;
            })}
          </div><p className="helper">Select a date even if there aren’t enough places yet. Your group stays together.</p>
        </section><aside className="booking-panel" aria-label="Your booking">
          {(!own || own.status==='cancelled') ? <><h2>Your group, one booking.</h2><form onSubmit={e=>{e.preventDefault();join();}}><label className="field"><span>Your name</span><input autoComplete="name" value={name} onChange={e=>setName(e.target.value)} maxLength={80} placeholder="Alex Morgan" required/></label><div className="field"><label htmlFor="places">Places together</label><div className="stepper"><button type="button" aria-label="Fewer places" disabled={groupSize<=1} onClick={()=>setGroupSize(x=>x-1)}>−</button><input id="places" value={groupSize} aria-label="Places together" readOnly/><button type="button" aria-label="More places" disabled={groupSize>=6} onClick={()=>setGroupSize(x=>x+1)}>+</button></div></div><label className="field"><span>Maximum total</span><div className="currency"><span>$</span><input type="number" min="1" max="2000" step="0.01" value={budget} onChange={e=>setBudget(e.target.value)} required aria-label="Maximum total"/></div></label><div className="promises"><p><Check/>{chosen.length} acceptable {chosen.length===1?'date':'dates'}</p><p><Check/>No split groups</p><p><Check/>You approve before paying.</p></div><button className="primary" type="submit" disabled={!!busy||!chosen.length}>Join the waitlist <Arrow/></button></form><PaymentInfo/><p className="quiet">Local studio demo · PayPal sandbox</p></> : <BookingStatus own={own} session={heldSession} countdown={countdown} state={state} busy={busy} act={act} pay={pay} />}
        </aside></div><section className="steps" aria-label="How it works"><div><span>01</span><p><b>Choose your dates</b><small>Tell us what works for your group.</small></p><Arrow/></div><div><span>02</span><p><b>Get a group offer</b><small>We’ll watch for space and keep your group together.</small></p><Arrow/></div><div><span>03</span><p><b>Approve with PayPal</b><small>You choose whether to book.</small></p></div></section>
      </> : <Studio state={studio || state} busy={busy} error={error} notice={notice} act={act} setView={setView}/>}
    </main><footer>Made for a little flexibility, and a lot of togetherness.<span>Stillwater Studio · Pacific time · USD</span></footer>
  </>;
}
function PaymentInfo() {return <div className="payment-info"><PayPal/><h3>Pay only after a match</h3><p>When your places open, we hold them all for 10 minutes. You choose whether to book.</p></div>;}
function BookingStatus({own,session,countdown,state,busy,act,pay}) {
  const [consent,setConsent]=useState(false);
  useEffect(()=>setConsent(false),[own.offer?.id]);
  const safe=own.status==='offered';
  return <div className="status-panel">
    <span className={`status ${own.status}`}>{({waiting:'On the waitlist',offered:'Your group has a place',capturing:'Confirming payment',reconciling:'Checking with PayPal',booked:'You’re booked together',expired:'Your offer has expired',cancelled:'Cancelled'})[own.status]}</span>
    <h2>{own.status==='waiting'?'Good company. Worth the wait.':own.status==='offered'?'There’s room for all of you.':own.status==='booked'?'See you at the wheel.':own.status==='expired'?'Let’s find another opening.':'Your places are protected.'}</h2>
    <p className="group-name">{own.customerName} · {own.groupSize} {own.groupSize===1?'place':'places'} together</p>
    {own.status==='waiting' && <><div className="wait-illustration" aria-hidden="true"><div/><div/></div><p>We’re watching {own.sessionIds.length} acceptable dates for your whole group, up to {money(own.maxTotalCents)} total.</p><p className="muted">One place opening isn’t enough for a group of two. We wait until everyone fits.</p><div className="hint">Try the Studio view: release a place on one of your chosen dates to see a group offer appear.</div></>}
    {own.offer && ['offered','capturing','reconciling','booked'].includes(own.status) && <div className="offer-details"><h3>{session?.title || 'Your session'}</h3><p>{session?when(session.startsAt):''}</p><p>{session?`${time(session.startsAt)} – ${time(session.endsAt)} · Pacific`:''}</p><div className="total"><span>{own.groupSize} places · total</span><strong>{money(own.offer.totalCents)}</strong></div>{safe && <div className="timer"><span>All your places held for</span><b>{countdown}</b></div>}</div>}
    {safe && <><label className="consent"><input type="checkbox" id="consent" checked={consent} onChange={e=>setConsent(e.target.checked)}/>I approve this date and {money(own.offer.totalCents)} total for my whole group.</label><button id="paypal-action" className="paypal-button" disabled={!consent||!!busy||!state.providers.paypal.configured} onClick={pay}>Approve with <PayPal/><Arrow/></button><p className="quiet">Sandbox checkout · no real money</p>{state.demoMode && !own.offer.orderId && <button className="outline demo-checkout" disabled={!consent||!!busy} onClick={()=>act('Completing simulated booking',()=>api('/api/demo/complete',{}))}>Try demo checkout (no payment)</button>}{!state.providers.paypal.configured && <p className="muted">PayPal sandbox credentials aren’t configured. The demo checkout is available.</p>}</>}
    {['capturing','reconciling'].includes(own.status) && <><p>Your group’s places stay reserved while the server checks the order. Refreshing will keep this booking safe.</p><button className="primary" disabled={!!busy} onClick={()=>act('Checking payment status',()=>api('/api/paypal/reconcile',{orderId:own.offer.orderId}))}>Check payment status <Arrow/></button></>}
    {safe && own.offer.orderId && <button className="outline" disabled={!!busy} onClick={()=>act('Checking payment status',()=>api('/api/paypal/reconcile',{orderId:own.offer.orderId}))}>Already approved? Check payment status</button>}
    {own.status==='expired' && <><p>The 10-minute hold ended. All {own.groupSize} places have been released. No payment was taken.</p><button className="primary" disabled={!!busy} onClick={()=>act('Rejoining the waitlist',()=>api('/api/requests/retry',{}))}>Rejoin with these preferences <Arrow/></button><button className="text-button" disabled={!!busy} onClick={()=>act('Changing your preferences',()=>api('/api/requests/new',{}))}>Change your preferences</button></>}
    {own.status==='booked' && <><div className="receipt"><Check/><h3>Every place confirmed.</h3><p>{own.receipt?.paymentMode==='simulation'?'Demo booking · no payment was made':'PayPal sandbox payment confirmed'}</p><p className="receipt-id">Booking {own.id.slice(0,8)}</p>{own.receipt?.captureId && <p className="receipt-id">Capture {own.receipt.captureId}</p>}</div><p className="muted">This confirmation is saved locally and survives a restart.</p><button className="outline" disabled={!!busy} onClick={()=>act('Starting a new request',()=>api('/api/requests/new',{}))}>Plan another visit</button></>}
    {['waiting','offered'].includes(own.status) && <button className="text-button cancel" disabled={!!busy} onClick={()=>act('Cancelling your request',()=>api('/api/requests/cancel',{}))}>Cancel this request</button>}
  </div>;
}
function Studio({state,busy,error,notice,act,setView}) {
  const stats=state.stats || {};
  return <><section className="studio-hero"><div><h1>Make room for everyone.</h1><p>Release places. Match a whole group. Keep every booking in view.</p></div><button className="outline" onClick={()=>setView('customer')}><Arrow back/>Back to customer</button></section>{(error||notice||busy) && <div className={`notice ${error?'error':''}`} role={error?'alert':'status'}>{error || busy || notice}</div>}<section className="stats-strip" aria-label="Studio totals">{[[state.sessions.length,'Upcoming sessions'],[stats.waiting||0,'Waiting groups'],[stats.offered||0,'Active holds'],[stats.booked||0,'Booked groups']].map(([value,label])=><div key={label}><strong>{value}</strong><span>{label}</span></div>)}</section>
    <div className="studio-grid"><section className="schedule"><div className="section-top"><h2>Your schedule</h2><span>All times Pacific</span></div><div className="table-wrap"><table><thead><tr><th>Date</th><th>Session</th><th>Occupancy</th><th>Action</th></tr></thead><tbody>{state.sessions.map(session=><tr key={session.id}><td><strong>{when(session.startsAt).split(',')[0]}</strong><small>{when(session.startsAt).split(',')[1]}</small></td><td><b>{session.title}</b><small>{time(session.startsAt)} – {time(session.endsAt)}</small></td><td><div className="occupancy"><span>{session.bookedSeats+session.heldSeats} of {session.capacity}</span><div className="meter"><i style={{width:`${100*session.bookedSeats/session.capacity}%`}}/><em style={{width:`${100*session.heldSeats/session.capacity}%`}}/></div></div><small>{session.availableSeats} open{session.heldSeats?` · ${session.heldSeats} held`:''}</small></td><td><button className="outline" disabled={!!busy||session.bookedSeats===0} onClick={()=>act('Releasing a place',()=>api('/api/studio/release',{sessionId:session.id,count:1}))} aria-label={`Release 1 place on ${when(session.startsAt)}`}>Release 1 place</button></td></tr>)}</tbody></table></div></section>
    <aside className="queue-panel"><h2>Group queue</h2><div className="queue-list">{!(state.requests || []).length ? <p className="empty">A little room for possibility.<br/><span>Customer requests will appear here.</span></p> : [...state.requests].reverse().map(request=><article className="queue-entry" key={request.id}><div className="queue-name"><h3>{request.customerName}</h3><span className={`status ${request.status}`}>{request.status}</span></div><p>{request.groupSize} places together</p><small>{request.sessionIds.length} acceptable dates · {money(request.maxTotalCents)} maximum</small><p className="queue-note">{request.status==='waiting'?`Needs ${request.groupSize} places in one session.`:request.status==='offered'?`Holding all ${request.groupSize} places together.`:request.status==='booked'?(request.receipt?.paymentMode==='simulation'?'Demo booking · no payment':'PayPal sandbox confirmed'):request.status==='expired'?'The full group hold has been released.':request.status==='reconciling'?'Seats protected pending payment check.':request.status==='cancelled'?'Cancelled by customer.':'Checking the payment.'}</p>{request.status==='offered' && <button className="text-button" disabled={!!busy||!!request.offer?.orderId} onClick={()=>act('Expiring the demo hold',()=>api('/api/studio/expire',{requestId:request.id}))}>Expire this offer (demo)</button>}</article>)}</div><section className="activity"><h3>Recent activity</h3>{(state.activity || []).slice(0,4).map((entry,index)=><p key={entry.id || index}>{entry.message || entry.type}<small>{entry.at?time(entry.at):entry.createdAt?time(entry.createdAt):'Just now'}</small></p>)}</section></aside></div><section className="whole-group"><svg aria-hidden="true" viewBox="0 0 40 50"><path d="M10 45c5-16 14-23 17-38M15 29C1 28 6 17 9 16c7 2 7 9 6 13m7-10c-9-4-6-14-2-16 5 5 5 10 2 16m-7 17c4-12 12-10 17-11-2 8-11 11-17 11"/></svg><div><h3>A whole-group promise.</h3><p>Offers reserve every place together. Expired offers release the hold. Payments are confirmed by PayPal.</p></div></section><p className="studio-foot">Local studio demo · PayPal sandbox</p></>;
}
createRoot(document.getElementById('root')).render(<App/>);

