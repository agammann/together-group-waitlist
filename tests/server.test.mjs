import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBuiltFrontend, createHttpHarness, sampleRequest } from '../scripts/check-http.mjs';

async function withHarness(run, options) {
  const harness = await createHttpHarness(options);
  try { await run(harness); } finally { await harness.close(); }
}

async function offered(harness, input = sampleRequest()) {
  const joined = await harness.join(input);
  assert.equal(joined.status, 201);
  const opened = await harness.request('POST', '/api/studio/release', { cookie: joined.cookie, payload: { sessionId: input.sessionIds[0], count: 1 } });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.request.status, 'offered');
  return { cookie: joined.cookie, request: opened.body.request };
}

async function checkout(harness, joined) {
  const created = await harness.request('POST', '/api/paypal/orders', { cookie: joined.cookie });
  assert.equal(created.status, 200);
  return created.body.orderId;
}

test('production root, payment callback, SPA route, and built frontend assets are served', async () => {
  await withHarness(checkBuiltFrontend);
});

test('HTTP writes require the local origin and JSON; browser sessions receive private cookies', async () => {
  await withHarness(async (h) => {
    assert.equal((await h.request('POST', '/api/requests', { payload: sampleRequest(), origin: 'https://example.com' })).status, 403);
    assert.equal((await h.request('POST', '/api/requests', { payload: sampleRequest(), headers: { 'Content-Type': 'text/plain' } })).status, 403);
    assert.equal((await h.request('POST', '/api/requests', { rawBody: '{broken' })).status, 400);
    assert.equal((await h.requestWithHost('/api/state', 'outside.invalid:1234')).status, 403);
    const joined = await h.join();
    assert.equal(joined.status, 201);
    assert.ok(joined.headers.getSetCookie().every((value) => /HttpOnly/.test(value) && /SameSite=Lax/.test(value)));
    assert.equal(joined.body.token, undefined);
    assert.equal(joined.body.request.tokenHash, undefined);
    const own = await h.request('GET', '/api/state', { cookie: joined.cookie });
    assert.equal(own.body.request.id, joined.body.request.id);
    const anonymous = await h.request('GET', '/api/state');
    assert.equal(anonymous.body.request, null);
    assert.deepEqual(anonymous.body.requests, []);
    assert.equal((await h.request('POST', '/api/requests', { cookie: joined.cookie, payload: sampleRequest() })).status, 409);
    assert.equal((await h.request('POST', '/api/paypal/orders')).status, 401);
  });
});

test('HTTP matching holds the full group, expiry releases it, and retry is explicit', async () => {
  await withHarness(async (h) => {
    const joined = await offered(h);
    const own = await h.request('GET', '/api/state', { cookie: joined.cookie });
    assert.equal(own.body.sessions[0].heldSeats, 2);
    assert.equal(own.body.sessions[0].availableSeats, 0);
    h.advance(10 * 60_000);
    const expired = await h.request('GET', '/api/state', { cookie: joined.cookie });
    assert.equal(expired.body.request.status, 'expired');
    assert.equal(expired.body.sessions[0].heldSeats, 0);
    assert.equal(expired.body.sessions[0].availableSeats, 2);
    assert.equal((await h.request('POST', '/api/paypal/orders', { cookie: joined.cookie })).status, 409);
    const retried = await h.request('POST', '/api/requests/retry', { cookie: joined.cookie });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.request.status, 'offered');
    assert.notEqual(retried.body.request.offer.id, joined.request.offer.id);
  });
});

test('Qwen HTTP drafts use the canonical schedule and cannot reserve or book seats', async () => {
  await withHarness(async (h) => {
    const parsed = await h.request('POST', '/api/preferences', { payload: { text: 'two of us any weekend afternoon up to $75 total' } });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.body.groupSize, 2);
    assert.equal(h.qwenCalls[0].sessions.length, 6);
    assert.equal(h.qwenCalls[0].timeZone, 'America/Los_Angeles');
    const state = await h.request('GET', '/api/studio');
    assert.equal(state.body.requests.length, 0);
    assert.equal(state.body.stats.heldSeats, 0);
    assert.equal(state.body.providers.qwen.ready, true);
  });
});

test('HTTP checkout reuses its order and a callback or paid flag cannot create a booking', async () => {
  await withHarness(async (h) => {
    const joined = await offered(h);
    const orderId = await checkout(h, joined);
    const repeated = await h.request('POST', '/api/paypal/orders', { cookie: joined.cookie });
    assert.equal(repeated.body.orderId, orderId);
    assert.equal(h.paypal.calls.create.length, 1);
    assert.equal(h.paypal.calls.create[0].totalCents, 6400);
    assert.equal(h.paypal.calls.create[0].offerId, joined.request.offer.id);
    assert.equal(h.paypal.calls.create[0].requestId, joined.request.id);
    const callbackFlags = await h.request('GET', `/api/state?payment=return&token=${orderId}&PayerID=STUB`, { cookie: joined.cookie });
    assert.equal(callbackFlags.status, 200);
    assert.equal((await h.request('GET', `/api/paypal/capture?orderId=${orderId}`, { cookie: joined.cookie })).status, 404);
    assert.equal((await h.request('POST', '/api/paypal/capture', { cookie: joined.cookie, payload: { paid: true, providerStatus: 'COMPLETED' } })).status, 400);
    const state = await h.request('GET', '/api/state', { cookie: joined.cookie });
    assert.equal(state.body.request.status, 'offered');
    assert.equal(state.body.request.receipt, undefined);
    assert.equal(h.paypal.calls.capture.length, 0);
  });
});

test('provider-approved HTTP capture verifies the complete order and books exactly once', async () => {
  await withHarness(async (h) => {
    const joined = await offered(h);
    const orderId = await checkout(h, joined);
    h.paypal.approve(orderId);
    const responses = await Promise.all(Array.from({ length: 3 }, () => h.request('POST', '/api/paypal/capture', { cookie: joined.cookie, payload: { orderId } })));
    assert.ok(responses.every(({ status, body }) => status === 200 && body.request.status === 'booked'));
    assert.equal(h.paypal.calls.capture.length, 1);
    assert.equal(h.paypal.calls.get.length, 1);
    const repeated = await h.request('POST', '/api/paypal/capture', { cookie: joined.cookie, payload: { orderId } });
    assert.equal(repeated.status, 200);
    assert.equal(h.paypal.calls.capture.length, 1);
    assert.equal(repeated.body.sessions[0].bookedSeats, 8);
    assert.equal(repeated.body.sessions[0].heldSeats, 0);
    assert.equal(repeated.body.stats.totalBookings, 1);
    assert.equal(repeated.body.request.receipt.captureMode, 'provider-verified');
  });
});

test('an ambiguous HTTP capture retains all seats and reconciliation finds the completed order without recapturing', async () => {
  await withHarness(async (h) => {
    const joined = await offered(h);
    const orderId = await checkout(h, joined);
    h.paypal.approve(orderId);
    h.paypal.setBehavior('unknown-after-capture');
    const failed = await h.request('POST', '/api/paypal/capture', { cookie: joined.cookie, payload: { orderId } });
    assert.equal(failed.status, 503);
    h.advance(15 * 60_000);
    const pending = await h.request('GET', '/api/state', { cookie: joined.cookie });
    assert.equal(pending.body.request.status, 'reconciling');
    assert.equal(pending.body.sessions[0].heldSeats, 2);
    assert.equal((await h.request('POST', '/api/requests/cancel', { cookie: joined.cookie })).status, 409);
    const reconciled = await h.request('POST', '/api/paypal/capture', { cookie: joined.cookie, payload: { orderId } });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.request.status, 'booked');
    assert.equal(h.paypal.calls.capture.length, 1);
    assert.equal(h.paypal.calls.get.length, 1);
  });
});

test('HTTP rejects a foreign order before provider capture and rejects a mismatched capture amount', async () => {
  await withHarness(async (h) => {
    const a = await offered(h, sampleRequest({ sessionIds: ['session-1'] }));
    const orderId = await checkout(h, a);
    const b = await offered(h, sampleRequest({ customerName: 'Other', sessionIds: ['session-2'] }));
    const foreign = await h.request('POST', '/api/paypal/capture', { cookie: b.cookie, payload: { orderId } });
    assert.equal(foreign.status, 409);
    assert.equal(foreign.body.code, 'ORDER_OWNERSHIP');
    assert.equal(h.paypal.calls.capture.length, 0);
    h.paypal.approve(orderId);
    h.paypal.setBehavior('mismatch');
    const mismatch = await h.request('POST', '/api/paypal/capture', { cookie: a.cookie, payload: { orderId } });
    assert.equal(mismatch.status, 502);
    const pending = await h.request('GET', '/api/state', { cookie: a.cookie });
    assert.equal(pending.body.request.status, 'reconciling');
    assert.equal(pending.body.sessions[0].heldSeats, 2);
    assert.equal(pending.body.stats.totalBookings, 0);
  });
});

test('HTTP cancellation while checkout is being created prevents late attachment and capture', async () => {
  await withHarness(async (h) => {
    const joined = await offered(h);
    let finish;
    h.paypal.setCreateGate(new Promise((resolve) => { finish = resolve; }));
    const pending = h.request('POST', '/api/paypal/orders', { cookie: joined.cookie });
    while (!h.paypal.calls.create.length) await new Promise((resolve) => setTimeout(resolve, 5));
    const cancelled = await h.request('POST', '/api/requests/cancel', { cookie: joined.cookie });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.request.status, 'cancelled');
    assert.equal(cancelled.body.sessions[0].availableSeats, 2);
    finish();
    assert.equal((await pending).status, 409);
    const orderId = [...h.paypal.orders.keys()][0];
    assert.equal((await h.request('POST', '/api/paypal/capture', { cookie: joined.cookie, payload: { orderId } })).status, 409);
    assert.equal(h.paypal.calls.capture.length, 0);
  });
});

test('HTTP studio tools and scenario booking are disabled outside demo mode', async () => {
  await withHarness(async (h) => {
    const joined = await h.join();
    assert.equal((await h.request('GET', '/api/studio', { cookie: joined.cookie })).status, 403);
    assert.equal((await h.request('POST', '/api/studio/release', { payload: { sessionId: 'session-1', count: 1 } })).status, 403);
    assert.equal((await h.request('POST', '/api/demo/complete', { cookie: joined.cookie })).status, 403);
    assert.equal((await h.request('GET', '/api/state', { cookie: joined.cookie })).body.request.status, 'waiting');
  }, { demoMode: false });
});

test('HTTP local scenario receipts are visible as simulations and reserve seats once', async () => {
  await withHarness(async (h) => {
    const joined = await offered(h);
    const simulated = await h.request('POST', '/api/demo/complete', { cookie: joined.cookie });
    assert.equal(simulated.status, 200);
    assert.equal(simulated.body.request.receipt.paymentMode, 'simulation');
    assert.equal(simulated.body.request.receipt.provider, 'local-scenario');
    assert.equal(simulated.body.request.receipt.captureId, undefined);
    assert.equal(simulated.body.sessions[0].bookedSeats, 8);
    const repeated = await h.request('POST', '/api/demo/complete', { cookie: joined.cookie });
    assert.equal(repeated.body.sessions[0].bookedSeats, 8);
    assert.equal(h.paypal.calls.capture.length, 0);
  });
});

test('HTTP starting another visit clears only finished customer cookies and preserves prior bookings', async () => {
  await withHarness(async (h) => {
    const waiting = await h.join();
    assert.equal((await h.request('POST', '/api/requests/new', { cookie: waiting.cookie })).status, 409);
    await h.request('POST', '/api/requests/cancel', { cookie: waiting.cookie });
    const cleared = await h.request('POST', '/api/requests/new', { cookie: waiting.cookie });
    assert.equal(cleared.status, 200);
    assert.ok(cleared.headers.getSetCookie().every((value) => value.includes('Max-Age=0')));
    assert.equal((await h.request('GET', '/api/state', { cookie: cleared.cookie })).body.request, null);
    const next = await h.join(sampleRequest({ customerName: 'Next visit' }));
    assert.notEqual(next.body.request.id, waiting.body.request.id);
    await h.request('POST', '/api/studio/release', { cookie: next.cookie, payload: { sessionId: 'session-1', count: 1 } });
    assert.equal((await h.request('POST', '/api/requests/new', { cookie: next.cookie })).status, 409);
    await h.request('POST', '/api/demo/complete', { cookie: next.cookie });
    const afterBooked = await h.request('POST', '/api/requests/new', { cookie: next.cookie });
    assert.equal(afterBooked.status, 200);
    const studio = await h.request('GET', '/api/studio', { cookie: afterBooked.cookie });
    assert.equal(studio.body.request, null);
    assert.equal(studio.body.requests.length, 2);
    assert.equal(studio.body.stats.totalBookings, 1);
    assert.equal(studio.body.sessions[0].bookedSeats, 8);
  });
});

test('HTTP expiry rejects an owned order before capture and permits clearing the finished request', async () => {
  await withHarness(async (h) => {
    const joined = await offered(h);
    const orderId = await checkout(h, joined);
    h.paypal.approve(orderId);
    h.advance(10 * 60_000);
    const capture = await h.request('POST', '/api/paypal/capture', { cookie: joined.cookie, payload: { orderId } });
    assert.equal(capture.status, 409);
    assert.equal(h.paypal.calls.capture.length, 0);
    const state = await h.request('GET', '/api/state', { cookie: joined.cookie });
    assert.equal(state.body.request.status, 'expired');
    assert.equal(state.body.sessions[0].availableSeats, 2);
    assert.equal((await h.request('POST', '/api/requests/new', { cookie: joined.cookie })).status, 200);
  });
});

test('customer sessions remain independent when two local ports share a browser cookie jar', async () => {
  await withHarness(async (a) => {
    await withHarness(async (b) => {
      const joinedA = await a.join(sampleRequest({ customerName: 'Port A customer' }));
      const joinedB = await b.join(sampleRequest({ customerName: 'Port B customer' }));
      const browserCookies = `${joinedA.cookie}; ${joinedB.cookie}`;
      const names = (headers) => headers.getSetCookie().map((value) => value.split('=')[0]);
      const namesA = names(joinedA.headers);
      const namesB = names(joinedB.headers);
      assert.ok(namesA.every((name) => !namesB.includes(name)));
      assert.equal((await a.request('GET', '/api/state', { cookie: browserCookies })).body.request.id, joinedA.body.request.id);
      assert.equal((await b.request('GET', '/api/state', { cookie: browserCookies })).body.request.id, joinedB.body.request.id);
      const staleCookies = browserCookies.replace(joinedA.body.request.id, 'unknown-local-request');
      const recovered = await a.request('GET', '/api/state', { cookie: staleCookies });
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.request, null);
      assert.deepEqual(recovered.body.requests, []);
      assert.deepEqual(recovered.body.activity, []);
      assert.ok(!JSON.stringify(recovered.body).includes(joinedA.body.request.id));
      assert.deepEqual(names(recovered.headers), namesA);
      assert.ok(recovered.headers.getSetCookie().every((value) => value.includes('Max-Age=0')));
      assert.equal((await b.request('GET', '/api/state', { cookie: staleCookies })).body.request.id, joinedB.body.request.id);
      await a.request('POST', '/api/requests/cancel', { cookie: browserCookies });
      const cleared = await a.request('POST', '/api/requests/new', { cookie: browserCookies });
      assert.deepEqual(names(cleared.headers), namesA);
      assert.equal((await b.request('GET', '/api/state', { cookie: browserCookies })).body.request.id, joinedB.body.request.id);
    });
  });
});

test('invalid or partial session cookies recover to public state while protected changes still reject them', async () => {
  await withHarness(async (h) => {
    const joined = await h.join(sampleRequest({ customerName: 'Private customer' }));
    const pairs = joined.cookie.split('; ');
    const badToken = `${pairs[0]}; ${pairs[1].split('=')[0]}=invalid-customer-token-long-enough`;
    const invalidCookies = [badToken, pairs[0], pairs[1], joined.cookie.replace(joined.body.request.id, 'request-from-an-old-data-file')];
    for (const cookie of invalidCookies) {
      const recovered = await h.request('GET', '/api/state', { cookie });
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.request, null);
      assert.deepEqual(recovered.body.requests, []);
      assert.deepEqual(recovered.body.activity, []);
      assert.ok(!JSON.stringify(recovered.body).includes('Private customer'));
      assert.equal(recovered.headers.getSetCookie().length, 2);
      assert.ok(recovered.headers.getSetCookie().every((value) => value.includes('Max-Age=0')));
    }
    const denied = await h.request('POST', '/api/requests/cancel', { cookie: badToken });
    assert.equal(denied.status, 401);
    const original = await h.request('GET', '/api/state', { cookie: joined.cookie });
    assert.equal(original.body.request.id, joined.body.request.id);
    assert.equal(original.body.request.status, 'waiting');
  });
});

test('reconciling an unapproved order does not capture or extend the original seat hold', async () => {
  await withHarness(async (h) => {
    const joined = await offered(h);
    const orderId = await checkout(h, joined);
    for (const status of ['CREATED', 'SAVED', 'PAYER_ACTION_REQUIRED', 'VOIDED']) {
      h.paypal.orders.get(orderId).status = status;
      const reconciled = await h.request('POST', '/api/paypal/reconcile', { cookie: joined.cookie, payload: { orderId } });
      assert.equal(reconciled.status, 409);
      assert.equal(reconciled.body.code, 'PAYMENT_NOT_APPROVED');
      const state = await h.request('GET', '/api/state', { cookie: joined.cookie });
      assert.equal(state.body.request.status, 'offered');
      assert.equal(state.body.request.offer.expiresAt, joined.request.offer.expiresAt);
      assert.equal(state.body.sessions[0].heldSeats, 2);
    }
    assert.equal(h.paypal.calls.capture.length, 0);
    h.advance(10 * 60_000);
    const expired = await h.request('GET', '/api/state', { cookie: joined.cookie });
    assert.equal(expired.body.request.status, 'expired');
    assert.equal(expired.body.sessions[0].heldSeats, 0);
    assert.equal(expired.body.sessions[0].availableSeats, 2);
  });
});
