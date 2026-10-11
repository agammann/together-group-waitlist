import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal, PayPalError, paypalRequestId, verifyCapture } from '../lib/paypal.mjs';
import { createQwen } from '../lib/qwen.mjs';

const request = { requestId: 'req-1', offerId: 'offer-1', totalCents: 6400, currency: 'USD',
  returnUrl: 'http://127.0.0.1:3000/payment/return', cancelUrl: 'http://127.0.0.1:3000/payment/cancel' };
const expected = { orderId: 'ORDER123', totalCents: 6400, currency: 'USD', requestId: 'req-1', offerId: 'offer-1' };
const completed = () => ({ id: 'ORDER123', intent: 'CAPTURE', status: 'COMPLETED', purchase_units: [{
  reference_id: 'offer-1', custom_id: 'req-1', invoice_id: 'offer-1', amount: { currency_code: 'USD', value: '64.00' },
  payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED', final_capture: true,
    amount: { currency_code: 'USD', value: '64.00' }, supplementary_data: { related_ids: { order_id: 'ORDER123' } } }] },
}] });
const created = () => ({ id: 'ORDER123', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123' }] });
const token = () => ({ access_token: 'TEST_TOKEN', expires_in: 3600 });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function paypalMock(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    assert.ok(next, `Unexpected provider request: ${url}`);
    return next;
  };
  return { calls, provider: createPayPal({ clientId: 'TEST_ID', clientSecret: 'TEST_SECRET', fetchImpl }) };
}

test('PayPal defaults to sandbox and readiness reveals no credentials', () => {
  const provider = createPayPal();
  assert.deepEqual(provider.readiness(), { configured: false, mode: 'sandbox', baseUrl: 'https://api-m.sandbox.paypal.com', ready: false });
  assert.throws(() => createPayPal({ baseUrl: 'https://api-m.paypal.com' }), /only the PayPal sandbox/);
  assert.throws(() => createPayPal({ baseUrl: 'https://api-m.sandbox.paypal.com@evil.example' }), /only the PayPal sandbox/);
  assert.throws(() => createPayPal({ baseUrl: 'https://api-m.sandbox.paypal.com/extra' }), /only the PayPal sandbox/);
});

test('PayPal unconfigured checkout makes no network request', async () => {
  let calls = 0;
  const provider = createPayPal({ fetchImpl: () => { calls++; } });
  await assert.rejects(provider.createOrder(request), error => error.code === 'PAYPAL_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('PayPal create uses server total, references, and current approval experience', async () => {
  const { provider, calls } = paypalMock([response(token()), response(created())]);
  assert.deepEqual(await provider.createOrder(request), { orderId: 'ORDER123', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123' });
  const body = JSON.parse(calls[1].body);
  assert.equal(body.intent, 'CAPTURE');
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'USD', value: '64.00' });
  assert.equal(body.purchase_units[0].custom_id, 'req-1');
  assert.equal(body.purchase_units[0].invoice_id, 'offer-1');
  assert.equal(body.purchase_units[0].reference_id, 'offer-1');
  assert.equal(body.payment_source.paypal.experience_context.user_action, 'PAY_NOW');
  assert.equal(body.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING');
  assert.equal(calls[1].redirect, 'error');
  assert.equal(calls[1].headers['PayPal-Request-Id'], paypalRequestId('create', 'offer-1'));
  assert.notEqual(paypalRequestId('create', 'offer-1'), paypalRequestId('capture', 'offer-1'));
});

test('PayPal retries preserve idempotency headers and reuse a cached token', async () => {
  const { provider, calls } = paypalMock([response(token()), response(created()), response(created()), response(completed()), response(completed())]);
  await provider.createOrder(request);
  await provider.createOrder(request);
  await provider.captureOrder('ORDER123', { requestKey: 'offer-1' });
  await provider.captureOrder('ORDER123', { requestKey: 'offer-1' });
  assert.equal(calls.filter(call => call.url.endsWith('/token')).length, 1);
  assert.equal(calls[1].headers['PayPal-Request-Id'], calls[2].headers['PayPal-Request-Id']);
  assert.equal(calls[3].headers['PayPal-Request-Id'], calls[4].headers['PayPal-Request-Id']);
});

test('PayPal one 401 refreshes token and preserves capture request identity', async () => {
  const { provider, calls } = paypalMock([response(token()), response({ name: 'AUTHENTICATION_FAILURE' }, 401),
    response({ access_token: 'REFRESH_TOKEN', expires_in: 3600 }), response(completed())]);
  await provider.captureOrder('ORDER123', { requestKey: 'offer-1' });
  assert.equal(calls.length, 4);
  assert.equal(calls[1].headers['PayPal-Request-Id'], calls[3].headers['PayPal-Request-Id']);
  assert.equal(calls[3].headers.Authorization, 'Bearer REFRESH_TOKEN');
});

test('PayPal expired tokens are refreshed', async () => {
  const { provider, calls } = paypalMock([response({ access_token: 'SHORT_TOKEN', expires_in: 1 }), response(created()), response(token()), response(created())]);
  await provider.createOrder(request);
  await provider.createOrder(request);
  assert.equal(calls.filter(call => call.url.endsWith('/token')).length, 2);
});

test('PayPal rejects nonlocal HTTP callbacks and invalid cents before any request', async () => {
  const { provider, calls } = paypalMock([]);
  await assert.rejects(provider.createOrder({ ...request, totalCents: 64.1 }), /positive total in cents/);
  await assert.rejects(provider.createOrder({ ...request, currency: 'EUR' }), /books in USD/);
  await assert.rejects(provider.createOrder({ ...request, returnUrl: 'http://evil.example' }), /HTTPS or the local app/);
  assert.equal(calls.length, 0);
});

for (const href of [
  'https://www.paypal.com/checkoutnow?token=ORDER123',
  'https://www.sandbox.paypal.com.evil.example/checkoutnow?token=ORDER123',
  'https://www.sandbox.paypal.com/checkoutnow?token=OTHERORDER',
  'https://www.sandbox.paypal.com/signin?token=ORDER123',
]) {
  test(`PayPal rejects unsafe or mismatched approval URL ${href}`, async () => {
    const order = created();
    order.links[0].href = href;
    const { provider } = paypalMock([response(token()), response(order)]);
    await assert.rejects(provider.createOrder(request), error => error.code === 'PAYPAL_INVALID_APPROVAL_URL');
  });
}

test('PayPal verified receipt contains only payment evidence, no payer personal data', () => {
  const order = completed();
  order.payer = { email_address: 'private@example.com' };
  assert.deepEqual(verifyCapture(order, expected), { verified: true, providerStatus: 'COMPLETED', orderId: 'ORDER123', capturedAmountCents: 6400, currency: 'USD', captureId: 'CAPTURE123' });
});

const mismatchCases = [
  ['wrong order ID', order => { order.id = 'OTHERORDER'; }],
  ['approved order without capture', order => { order.status = 'APPROVED'; }],
  ['authorization instead of capture', order => { order.intent = 'AUTHORIZE'; }],
  ['wrong request reference', order => { order.purchase_units[0].custom_id = 'other-request'; }],
  ['wrong invoice', order => { order.purchase_units[0].invoice_id = 'other-offer'; }],
  ['wrong purchase unit', order => { order.purchase_units[0].reference_id = 'other-offer'; }],
  ['wrong order amount', order => { order.purchase_units[0].amount.value = '63.99'; }],
  ['wrong capture amount', order => { order.purchase_units[0].payments.captures[0].amount.value = '65.00'; }],
  ['wrong currency', order => { order.purchase_units[0].payments.captures[0].amount.currency_code = 'EUR'; }],
  ['pending capture', order => { order.purchase_units[0].payments.captures[0].status = 'PENDING'; }],
  ['partial capture', order => { order.purchase_units[0].payments.captures[0].final_capture = false; }],
  ['duplicate capture', order => { order.purchase_units[0].payments.captures.push({ ...order.purchase_units[0].payments.captures[0] }); }],
  ['multiple purchase units', order => { order.purchase_units.push({ ...order.purchase_units[0] }); }],
  ['wrong related order', order => { order.purchase_units[0].payments.captures[0].supplementary_data.related_ids.order_id = 'OTHERORDER'; }],
  ['amount exponent', order => { order.purchase_units[0].payments.captures[0].amount.value = '6.4e1'; }],
];
for (const [label, change] of mismatchCases) {
  test(`PayPal verification rejects ${label} and retains reconciliation`, () => {
    const order = completed();
    change(order);
    assert.throws(() => verifyCapture(order, expected), error => error.code === 'PAYPAL_UNVERIFIED_CAPTURE' && error.definitive === false);
  });
}

test('PayPal definitive funding rejection is distinct from ambiguous failures', async () => {
  const { provider } = paypalMock([response(token()), response({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED', description: 'SECRET_BODY_DO_NOT_SHOW' }] }, 422)]);
  await assert.rejects(provider.captureOrder('ORDER123'), error => {
    assert.equal(error.code, 'INSTRUMENT_DECLINED');
    assert.equal(error.status, 422);
    assert.equal(error.definitive, true);
    assert.ok(!error.message.includes('SECRET_BODY_DO_NOT_SHOW'));
    return true;
  });
});

for (const failure of [
  new Error('TEST_SECRET and private provider error'),
  response({ name: 'INTERNAL_SERVER_ERROR', message: 'TEST_SECRET' }, 500),
  response({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, 422),
  response({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'UNRECOGNIZED_SECRET' }] }, 422),
]) {
  test('PayPal ambiguous failure keeps capture reconciliation and sanitizes provider text', async () => {
    const { provider } = paypalMock([response(token()), failure]);
    await assert.rejects(provider.captureOrder('ORDER123'), error => error instanceof PayPalError && error.definitive === false && !error.message.includes('TEST_SECRET') && !error.code.includes('SECRET'));
  });
}

test('PayPal fetch timeout is bounded and ambiguous', async () => {
  const provider = createPayPal({ clientId: 'TEST_ID', clientSecret: 'TEST_SECRET', timeoutMs: 10,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private timeout')))) });
  await assert.rejects(provider.getOrder('ORDER123'), error => error.code === 'PAYPAL_TIMEOUT' && error.definitive === false);
});

const sessions = [
  { id: 'sat-am', title: 'Clay morning', startsAt: '2026-10-17T10:00:00-07:00', priceCents: 3200 },
  { id: 'sat-pm', title: 'Clay afternoon', startsAt: '2026-10-17T14:00:00-07:00', priceCents: 3200 },
  { id: 'sun-pm', title: 'Sunday clay', startsAt: '2026-10-18T14:00:00-07:00', priceCents: 3600 },
  { id: 'wed-pm', title: 'Wednesday clay', startsAt: '2026-10-21T14:00:00-07:00', priceCents: 3200 },
  { id: 'sat-next', title: 'Next Saturday clay', startsAt: '2026-10-24T15:00:00-07:00', priceCents: 3500 },
  { id: 'sun-premium', title: 'Sunday premium', startsAt: '2026-10-25T15:00:00-07:00', priceCents: 4500 },
];
const preferences = () => ({ groupSize: 2, sessionIds: ['sat-pm', 'sun-pm', 'sat-next'], maxTotalCents: 7500,
  rationale: 'Two people, weekend afternoons, at most $75 total.', warnings: [] });
const qwenResponse = value => response({ done: true, message: { role: 'assistant', content: JSON.stringify(value) } });

test('Qwen request is local, deterministic, structured, and grounded in dated session metadata', async () => {
  let call;
  const provider = createQwen({ fetchImpl: async (url, init) => { call = { url, ...init }; return qwenResponse(preferences()); } });
  const result = await provider.parsePreferences({ text: 'two of us any weekend afternoon up to $75 total', sessions });
  assert.equal(call.url, 'http://127.0.0.1:11434/api/chat');
  const body = JSON.parse(call.body);
  assert.equal(body.model, 'qwen3.5:4b-q4_K_M');
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
  assert.equal(body.options.temperature, 0);
  assert.deepEqual(body.format.properties.sessionIds.items.enum, ['sat-pm', 'sun-pm', 'sat-next', 'sun-premium']);
  for (const session of sessions) assert.ok(body.messages[0].content.includes(session.id));
  assert.match(body.messages[0].content, /Saturday, October 17, 2026/);
  assert.match(body.messages[0].content, /2:00 PM/);
  assert.match(body.messages[0].content, /America\/Los_Angeles/);
  assert.equal(result.groupSize, 2);
  assert.equal(result.maxTotalCents, 7500);
  assert.deepEqual(result.sessionIds, ['sat-pm', 'sun-pm', 'sat-next']);
  assert.ok(Number.isInteger(result.durationMs));
});

test('Qwen missing budget and group size remain null with review warnings', async () => {
  const provider = createQwen({ fetchImpl: async () => qwenResponse({ groupSize: null, sessionIds: ['sat-pm'], maxTotalCents: null, rationale: 'Saturday afternoon.', warnings: [] }) });
  const result = await provider.parsePreferences({ text: 'Saturday afternoon please', sessions });
  assert.equal(result.groupSize, null);
  assert.equal(result.maxTotalCents, null);
  assert.ok(result.warnings.some(warning => warning.includes('group size')));
  assert.ok(result.warnings.some(warning => warning.includes('budget')));
  assert.ok(!Object.hasOwn(result, 'customerName'));
  assert.ok(!Object.hasOwn(result, 'email'));
});

test('Qwen can return no matching dates without inventing a session', async () => {
  const provider = createQwen({ fetchImpl: async () => qwenResponse({ ...preferences(), sessionIds: [], rationale: 'No supplied Friday sessions.', warnings: [] }) });
  const result = await provider.parsePreferences({ text: 'two people on Friday for $75 total', sessions });
  assert.deepEqual(result.sessionIds, []);
  assert.ok(result.warnings.some(warning => /acceptable dates/.test(warning)));
});

for (const [label, change] of [
  ['unknown session', value => { value.sessionIds = ['invented']; }],
  ['duplicate session', value => { value.sessionIds = ['sat-pm', 'sat-pm']; }],
  ['too many people', value => { value.groupSize = 7; }],
  ['fractional cents', value => { value.maxTotalCents = 7500.1; }],
  ['unaffordable session', value => { value.sessionIds = ['sun-premium']; }],
  ['morning for afternoon', value => { value.sessionIds = ['sat-am']; }],
  ['weekday for weekend', value => { value.sessionIds = ['wed-pm']; }],
  ['invented budget amount', value => { value.maxTotalCents = 7600; }],
  ['invented identity', value => { value.customerName = 'Somebody'; }],
  ['payment instruction', value => { value.pay = true; }],
]) {
  test(`Qwen refuses ${label} before returning a reviewable proposal`, async () => {
    const value = preferences();
    change(value);
    const provider = createQwen({ fetchImpl: async () => qwenResponse(value) });
    await assert.rejects(provider.parsePreferences({ text: 'two of us any weekend afternoon up to $75 total', sessions }), error => error.code === 'QWEN_INVALID_RESULT');
  });
}

test('Qwen refuses an invented budget when the customer did not mention one', async () => {
  const provider = createQwen({ fetchImpl: async () => qwenResponse(preferences()) });
  await assert.rejects(provider.parsePreferences({ text: 'two of us any weekend afternoon', sessions }), error => error.code === 'QWEN_INVALID_RESULT');
});

test('Qwen readiness checks the exact installed model', async () => {
  const provider = createQwen({ fetchImpl: async () => response({ models: [{ name: 'qwen3.5:4b-q4_K_M' }] }) });
  assert.equal((await provider.readiness()).ready, true);
  const missing = createQwen({ fetchImpl: async () => response({ models: [{ name: 'other-model' }] }) });
  assert.equal((await missing.readiness()).ready, false);
});

test('Qwen cannot use a remote model endpoint', () => {
  assert.throws(() => createQwen({ baseUrl: 'https://remote.example' }), /local Ollama/);
});

test('Qwen unavailable remains an explicit manual fallback and sanitizes errors', async () => {
  const provider = createQwen({ fetchImpl: async () => { throw new Error('private local path'); } });
  assert.equal((await provider.readiness()).ready, false);
  await assert.rejects(provider.parsePreferences({ text: 'two people for $75', sessions }), error => error.code === 'QWEN_UNAVAILABLE' && !error.message.includes('private local path'));
});

test('Qwen enforces a bounded local timeout', async () => {
  const provider = createQwen({ timeoutMs: 10, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')))) });
  await assert.rejects(provider.parsePreferences({ text: 'two people for $75', sessions }), error => error.code === 'QWEN_TIMEOUT');
});
