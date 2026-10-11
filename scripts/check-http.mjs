import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createApplication } from '../server.mjs';

export const HTTP_TEST_START = Date.parse('2026-10-10T19:00:00Z');
export const sampleRequest = (extra = {}) => ({ customerName: 'Maya', groupSize: 2, sessionIds: ['session-1', 'session-2'], maxTotalCents: 7500, note: 'Two places together.', ...extra });

/** Test double only: no provider network calls or sandbox credentials. */
export function createStubPayPal() {
  const orders = new Map();
  const byRequestKey = new Map();
  const calls = { create: [], capture: [], get: [] };
  let behavior = 'success';
  let createGate;
  return {
    calls, orders,
    config: () => ({ configured: true, mode: 'test-stub' }),
    setBehavior(value) { behavior = value; },
    setCreateGate(promise) { createGate = promise; },
    approve(orderId) { orders.get(orderId).status = 'APPROVED'; },
    async createOrder(input) {
      calls.create.push(structuredClone(input));
      if (createGate) await createGate;
      if (byRequestKey.has(input.requestKey)) return structuredClone(byRequestKey.get(input.requestKey));
      const orderId = `ORDER_STUB_${String(orders.size + 1).padStart(3, '0')}`;
      const amount = { currency_code: input.currency, value: (input.totalCents / 100).toFixed(2) };
      orders.set(orderId, { id: orderId, intent: 'CAPTURE', status: 'CREATED', purchase_units: [{ reference_id: input.offerId, custom_id: input.requestId, invoice_id: input.offerId, amount }] });
      const result = { orderId, approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` };
      byRequestKey.set(input.requestKey, result);
      return structuredClone(result);
    },
    async captureOrder(orderId, options) {
      calls.capture.push({ orderId, ...options });
      const order = orders.get(orderId);
      if (!order) throw Object.assign(new Error('Stub order was not found.'), { status: 404, definitive: false });
      if (order.status === 'COMPLETED') return structuredClone(order);
      if (order.status !== 'APPROVED' || behavior === 'decline') {
        throw Object.assign(new Error('The stub provider did not capture the order.'), { status: 422, code: 'INSTRUMENT_DECLINED', definitive: true });
      }
      if (behavior === 'unknown-before-capture') throw Object.assign(new Error('Stub connection ended before confirmation.'), { status: 503, code: 'PAYPAL_NETWORK', definitive: false });
      const unit = order.purchase_units[0];
      unit.payments = { captures: [{ id: `CAPTURE_${orderId}`, status: 'COMPLETED', final_capture: true, amount: structuredClone(unit.amount), supplementary_data: { related_ids: { order_id: orderId } } }] };
      order.status = 'COMPLETED';
      if (behavior === 'mismatch') unit.payments.captures[0].amount.value = '0.01';
      if (behavior === 'unknown-after-capture') throw Object.assign(new Error('Stub capture succeeded but confirmation was lost.'), { status: 503, code: 'PAYPAL_NETWORK', definitive: false });
      return structuredClone(order);
    },
    async getOrder(orderId) {
      calls.get.push(orderId);
      return structuredClone(orders.get(orderId));
    },
  };
}

export async function createHttpHarness({ demoMode = true, paypal = createStubPayPal() } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'together-http-'));
  let now = HTTP_TEST_START;
  const qwenCalls = [];
  const qwen = {
    config: () => ({ model: 'qwen-test-stub', local: true }),
    readiness: async () => ({ ready: true, model: 'qwen-test-stub', local: true }),
    async parsePreferences(input) {
      qwenCalls.push(structuredClone(input));
      return { groupSize: 2, sessionIds: input.sessions.filter(({ id }) => id !== 'session-3').map(({ id }) => id), maxTotalCents: 7500, rationale: 'Test preferences selected weekend afternoons.', warnings: [], model: 'qwen-test-stub', durationMs: 1 };
    },
  };
  const app = await createApplication({ dataFile: path.join(temporary, 'state.json'), clock: () => now, demoMode, paypal, qwen });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  async function request(method, route, { cookie, payload, headers = {}, origin = baseUrl, rawBody } = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers },
      ...(method === 'POST' ? { body: rawBody ?? JSON.stringify(payload ?? {}) } : {}),
    });
    const text = await response.text();
    const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
    const setCookies = response.headers.getSetCookie();
    return { status: response.status, body: data, headers: response.headers, cookie: setCookies.length ? setCookies.map((value) => value.split(';')[0]).join('; ') : null };
  }
  return {
    app, baseUrl, paypal, qwenCalls, request,
    requestWithHost(route, host) {
      return new Promise((resolve, reject) => {
        const outgoing = httpRequest(`${baseUrl}${route}`, { headers: { Host: host } }, (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
          response.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.end();
      });
    },
    advance(milliseconds) { now += milliseconds; },
    async join(input = sampleRequest()) { return request('POST', '/api/requests', { payload: input }); },
    async close() {
      await app.close();
      assert.ok(path.resolve(temporary).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
      assert.ok(path.basename(temporary).startsWith('together-http-'));
      await rm(temporary, { recursive: true, force: true });
    },
  };
}

export async function checkBuiltFrontend(harness) {
  const root = await harness.request('GET', '/');
  assert.equal(root.status, 200, 'The production root must serve the frontend. Run pnpm build before checking the production server.');
  assert.match(root.headers.get('content-type') || '', /^text\/html/);
  assert.match(root.body, /<title>Together[^<]*<\/title>/);
  assert.match(root.body, /<div id="root"><\/div>/);
  for (const route of ['/?payment=return&token=ignored', '/studio/demo/preview']) {
    const page = await harness.request('GET', route);
    assert.equal(page.status, 200, `${route} must serve the frontend entry page.`);
    assert.match(page.headers.get('content-type') || '', /^text\/html/);
    assert.equal(page.body, root.body);
  }
  const references = [...root.body.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)].map((match) => match[1]);
  assert.ok(references.some((reference) => reference.endsWith('.js')), 'The built HTML must reference its JavaScript bundle.');
  assert.ok(references.some((reference) => reference.endsWith('.css')), 'The built HTML must reference its stylesheet.');
  for (const reference of [...new Set([...references, '/studio.png'])]) {
    const asset = await harness.request('GET', reference);
    assert.equal(asset.status, 200, `The referenced asset ${reference} must be served.`);
    assert.ok(asset.body.length > 0);
    if (reference.endsWith('.js')) assert.match(asset.headers.get('content-type') || '', /javascript/);
    else if (reference.endsWith('.css')) assert.match(asset.headers.get('content-type') || '', /^text\/css/);
    else assert.match(asset.headers.get('content-type') || '', /^image\//);
  }
}

export async function runHttpSmoke() {
  const harness = await createHttpHarness();
  try {
    await checkBuiltFrontend(harness);
    const first = await harness.request('GET', '/api/state');
    assert.equal(first.status, 200);
    assert.equal(first.body.sessions.length, 6);
    const joined = await harness.join();
    assert.equal(joined.status, 201);
    assert.equal(joined.body.request.status, 'waiting');
    const opened = await harness.request('POST', '/api/studio/release', { cookie: joined.cookie, payload: { sessionId: 'session-1', count: 1 } });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.request.status, 'offered');
    assert.equal(opened.body.sessions[0].heldSeats, 2);
    const created = await harness.request('POST', '/api/paypal/orders', { cookie: joined.cookie });
    assert.equal(created.status, 200);
    harness.paypal.approve(created.body.orderId);
    const captured = await harness.request('POST', '/api/paypal/capture', { cookie: joined.cookie, payload: { orderId: created.body.orderId } });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.request.status, 'booked');
    assert.equal(captured.body.sessions[0].bookedSeats, 8);
    assert.equal(captured.body.sessions[0].heldSeats, 0);
    console.log('Production root, callback route, SPA fallback, and built assets passed. HTTP integration scenario passed with stub Qwen and payment providers. No PayPal sandbox capture was performed.');
  } finally { await harness.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runHttpSmoke();
