import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assertInvariants, createBookingService, seedSessions } from '../lib/booking.mjs';
import { createStore } from '../lib/store.mjs';

const START = Date.parse('2026-10-10T19:00:00Z');
const S1 = 'session-1';
const S2 = 'session-2';

function fixture(filePath) {
  let now = START;
  const store = createStore({ filePath });
  const service = createBookingService({ store, clock: () => now });
  return { service, store, advance: (milliseconds) => { now += milliseconds; } };
}

const requestInput = (extra = {}) => ({ customerName: 'Maya', groupSize: 2, sessionIds: [S1, S2], maxTotalCents: 7500, note: 'Together, please.', ...extra });

async function hold(fixture, extra) {
  const joined = await fixture.service.join(requestInput(extra));
  if (joined.request.status === 'waiting') await fixture.service.releaseSeats(joined.request.sessionIds[0], 1);
  return joined;
}

async function prepareCapture(fixture, joined, orderId = 'PAYPAL_ORDER_001') {
  const checkout = await fixture.service.beginCheckout(joined.request.id, joined.token);
  await fixture.service.attachOrder(joined.request.id, joined.token, { offerId: checkout.offerId, orderId, approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=example' });
  return fixture.service.beginCapture(joined.request.id, joined.token, { orderId });
}

const verifiedReceipt = (orderId = 'PAYPAL_ORDER_001', captureId = 'CAPTURE_001') => ({ orderId, captureId, verified: true, providerStatus: 'COMPLETED', capturedAmountCents: 6400, currency: 'USD' });

test('six future weekend sessions use Pacific time across the daylight saving transition', () => {
  const sessions = seedSessions(START);
  assert.equal(sessions.length, 6);
  assert.equal(sessions[0].startsAt, '2026-10-17T21:00:00.000Z');
  assert.equal(sessions[2].startsAt, '2026-10-24T17:00:00.000Z');
  assert.equal(sessions[5].startsAt, '2026-11-01T22:00:00.000Z');
  assert.deepEqual(sessions.map(({ priceCents }) => priceCents), [3200, 3200, 3400, 3200, 3600, 3200]);
  assert.ok(sessions.every(({ capacity, bookedSeats }) => capacity === 8 && bookedSeats === 7));
});

test('two people wait through single availability and receive an indivisible two-seat hold', async () => {
  const f = fixture();
  const joined = await f.service.join(requestInput());
  assert.equal(joined.request.status, 'waiting');
  assert.equal(joined.token.length, 43);
  await f.service.releaseSeats(S1, 1);
  const snapshot = await f.service.snapshot({ requestId: joined.request.id, token: joined.token });
  assert.equal(snapshot.request.status, 'offered');
  assert.equal(snapshot.request.offer.sessionId, S1);
  assert.equal(snapshot.request.offer.totalCents, 6400);
  assert.equal(snapshot.sessions[0].heldSeats, 2);
  assert.equal(snapshot.sessions[0].availableSeats, 0);
  assertInvariants(await f.store.read());
});

test('a release respects selected dates and the total group budget', async () => {
  const f = fixture();
  const lowBudget = await f.service.join(requestInput({ maxTotalCents: 6300 }));
  const expensiveOnly = await f.service.join(requestInput({ customerName: 'Ari', sessionIds: ['session-5'], maxTotalCents: 7000 }));
  const wrongDate = await f.service.join(requestInput({ customerName: 'Nina', sessionIds: ['session-6'] }));
  await f.service.releaseSeats(S1, 1);
  await f.service.releaseSeats('session-5', 1);
  const snapshot = await f.service.snapshot({ studio: true });
  assert.ok([lowBudget, expensiveOnly, wrongDate].every(({ request }) => snapshot.requests.find(({ id }) => id === request.id).status === 'waiting'));
  assert.equal(snapshot.sessions[0].availableSeats, 2);
  assert.equal(snapshot.sessions[4].availableSeats, 2);
});

test('eligible FIFO is deterministic and a flexible group leaves a scarce date for a constrained group', async () => {
  const f = fixture();
  await f.service.releaseSeats(S1, 1);
  await f.service.releaseSeats(S2, 1);
  const blocker1 = await f.service.join(requestInput({ customerName: 'Earlier A', sessionIds: [S1] }));
  const blocker2 = await f.service.join(requestInput({ customerName: 'Earlier B', sessionIds: [S2] }));
  const flexible = await f.service.join(requestInput({ customerName: 'Flexible' }));
  const constrained = await f.service.join(requestInput({ customerName: 'Constrained', sessionIds: [S1] }));
  f.advance(10 * 60_000);
  const snapshot = await f.service.snapshot({ studio: true });
  const find = (joined) => snapshot.requests.find(({ id }) => id === joined.request.id);
  assert.equal(find(blocker1).status, 'expired');
  assert.equal(find(blocker2).status, 'expired');
  assert.equal(find(flexible).offer.sessionId, S2);
  assert.equal(find(constrained).offer.sessionId, S1);
  assert.equal(snapshot.stats.heldSeats, 4);
});

test('simultaneous openings and joining never allocate more than capacity', async () => {
  const f = fixture();
  const joined = await Promise.all(Array.from({ length: 12 }, (_, index) => f.service.join(requestInput({ customerName: `Group ${index}`, sessionIds: [S1] }))));
  await Promise.all(Array.from({ length: 7 }, () => f.service.releaseSeats(S1, 1)));
  const snapshot = await f.service.snapshot({ studio: true });
  assert.equal(snapshot.sessions[0].bookedSeats, 0);
  assert.equal(snapshot.sessions[0].heldSeats, 8);
  assert.equal(snapshot.sessions[0].availableSeats, 0);
  assert.equal(snapshot.requests.filter(({ status }) => status === 'offered').length, 4);
  const firstIds = new Set(joined.slice(0, 4).map(({ request }) => request.id));
  assert.ok(snapshot.requests.filter(({ status }) => status === 'offered').every(({ id }) => firstIds.has(id)));
  await assert.rejects(f.service.releaseSeats(S1, 1), { code: 'INVALID_RELEASE' });
  assertInvariants(await f.store.read());
});

test('expiry releases the entire group and only explicit retry creates a fresh offer', async () => {
  const f = fixture();
  const joined = await hold(f);
  const before = await f.service.snapshot({ requestId: joined.request.id, token: joined.token });
  f.advance(10 * 60_000);
  const after = await f.service.snapshot({ requestId: joined.request.id, token: joined.token });
  assert.equal(after.request.status, 'expired');
  assert.equal(after.sessions[0].heldSeats, 0);
  assert.equal(after.sessions[0].availableSeats, 2);
  await assert.rejects(f.service.beginCheckout(joined.request.id, joined.token), { code: 'OFFER_UNAVAILABLE' });
  const retried = await f.service.retry(joined.request.id, joined.token);
  assert.equal(retried.status, 'offered');
  assert.notEqual(retried.offer.id, before.request.offer.id);
});

test('customer cancellation releases a hold and invalidates checkout created in flight', async () => {
  const f = fixture();
  const joined = await hold(f);
  const checkout = await f.service.beginCheckout(joined.request.id, joined.token);
  await f.service.cancel(joined.request.id, joined.token);
  await assert.rejects(f.service.attachOrder(joined.request.id, joined.token, { offerId: checkout.offerId, orderId: 'PAYPAL_ORDER_LATE', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow' }), { code: 'OFFER_UNAVAILABLE' });
  const snapshot = await f.service.snapshot();
  assert.equal(snapshot.sessions[0].availableSeats, 2);
  assert.equal(snapshot.sessions[0].heldSeats, 0);
});

test('expired offers cannot begin payment capture even with a valid owned order', async () => {
  const f = fixture();
  const joined = await hold(f);
  const intent = await f.service.beginCheckout(joined.request.id, joined.token);
  await f.service.attachOrder(joined.request.id, joined.token, { offerId: intent.offerId, orderId: 'PAYPAL_ORDER_001', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow' });
  f.advance(10 * 60_000);
  await assert.rejects(f.service.beginCapture(joined.request.id, joined.token, { orderId: 'PAYPAL_ORDER_001' }), { code: 'OFFER_UNAVAILABLE' });
  const snapshot = await f.service.snapshot({ requestId: joined.request.id, token: joined.token });
  assert.equal(snapshot.request.status, 'expired');
  assert.equal(snapshot.sessions[0].heldSeats, 0);
});

test('capture is reserved once, uncertain outcomes retain seats past expiry, and verified payment books once', async () => {
  const f = fixture();
  const joined = await hold(f);
  const checkout = await f.service.beginCheckout(joined.request.id, joined.token);
  await f.service.attachOrder(joined.request.id, joined.token, { offerId: checkout.offerId, orderId: 'PAYPAL_ORDER_001', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow' });
  const attempts = await Promise.all(Array.from({ length: 3 }, () => f.service.beginCapture(joined.request.id, joined.token, { orderId: 'PAYPAL_ORDER_001' })));
  assert.deepEqual(attempts.map(({ action }) => action), ['capture', 'reconcile', 'reconcile']);
  f.advance(15 * 60_000);
  await f.service.failCapture(joined.request.id, { orderId: 'PAYPAL_ORDER_001', definitive: false });
  await assert.rejects(f.service.cancel(joined.request.id, joined.token), { code: 'PAYMENT_PENDING' });
  const pending = await f.service.snapshot({ requestId: joined.request.id, token: joined.token });
  assert.equal(pending.request.status, 'reconciling');
  assert.equal(pending.sessions[0].heldSeats, 2);
  await assert.rejects(f.service.completeCapture(joined.request.id, { ...verifiedReceipt(), capturedAmountCents: 1 }), { code: 'UNVERIFIED_PAYMENT' });
  await assert.rejects(f.service.completeCapture(joined.request.id, { ...verifiedReceipt(), verified: false }), { code: 'UNVERIFIED_PAYMENT' });
  const booked = await f.service.completeCapture(joined.request.id, verifiedReceipt());
  assert.equal(booked.receipt.paymentMode, 'sandbox');
  await f.service.completeCapture(joined.request.id, verifiedReceipt());
  const final = await f.service.snapshot();
  assert.equal(final.sessions[0].bookedSeats, 8);
  assert.equal(final.sessions[0].heldSeats, 0);
  assert.equal(final.stats.totalBookings, 1);
  await assert.rejects(f.service.releaseSeats(S1, 7), { code: 'INVALID_RELEASE' });
  assertInvariants(await f.store.read());
});

test('a definitive no-payment outcome frees an expired reservation', async () => {
  const f = fixture();
  const joined = await hold(f);
  await prepareCapture(f, joined);
  f.advance(11 * 60_000);
  await f.service.failCapture(joined.request.id, { orderId: 'PAYPAL_ORDER_001', definitive: true, reason: 'The provider declined the capture.' });
  const snapshot = await f.service.snapshot({ requestId: joined.request.id, token: joined.token });
  assert.equal(snapshot.request.status, 'expired');
  assert.equal(snapshot.sessions[0].availableSeats, 2);
});

test('tokens stay private and an order belongs to exactly one offer including after retry', async () => {
  const f = fixture();
  const a = await hold(f, { sessionIds: [S1] });
  const checkout = await f.service.beginCheckout(a.request.id, a.token);
  await f.service.attachOrder(a.request.id, a.token, { offerId: checkout.offerId, orderId: 'PAYPAL_ORDER_001', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow' });
  await assert.rejects(f.service.snapshot({ requestId: a.request.id, token: 'incorrect-token-that-is-long-enough' }), { code: 'UNAUTHORIZED' });
  const publicState = await f.service.snapshot();
  assert.equal(publicState.request, null);
  assert.deepEqual(publicState.requests, []);
  const studio = await f.service.snapshot({ studio: true });
  assert.ok(!JSON.stringify(studio).includes(a.token));
  assert.ok(!JSON.stringify(studio).includes('tokenHash'));
  await f.service.cancel(a.request.id, a.token);
  const fresh = await f.service.retry(a.request.id, a.token);
  await assert.rejects(f.service.attachOrder(a.request.id, a.token, { offerId: fresh.offer.id, orderId: 'PAYPAL_ORDER_001', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow' }), { code: 'ORDER_OWNERSHIP' });
  const b = await hold(f, { customerName: 'Other', sessionIds: [S2] });
  await assert.rejects(f.service.beginCapture(b.request.id, b.token, { orderId: 'PAYPAL_ORDER_001' }), { code: 'ORDER_OWNERSHIP' });
});

test('local scenario receipts remain explicitly simulated and cannot become sandbox receipts', async () => {
  const f = fixture();
  const joined = await hold(f);
  const booked = await f.service.simulateBooking(joined.request.id, joined.token);
  assert.equal(booked.status, 'booked');
  assert.equal(booked.receipt.paymentMode, 'simulation');
  assert.equal(booked.receipt.provider, 'local-scenario');
  assert.equal(booked.receipt.captureId, undefined);
  await f.service.simulateBooking(joined.request.id, joined.token);
  assert.equal((await f.service.snapshot()).sessions[0].bookedSeats, 8);
  await assert.rejects(f.service.completeCapture(joined.request.id, verifiedReceipt()), { code: 'ORDER_OWNERSHIP' });
});

test('atomic persistence survives reopening and a failed transaction leaves the prior data intact', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'together-booking-'));
  const filePath = join(folder, 'state.json');
  try {
    const first = fixture(filePath);
    const joined = await hold(first);
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(raw.requests.length, 1);
    assert.equal(raw.requests[0].tokenHash.length, 64);
    assert.ok(!JSON.stringify(raw).includes(joined.token));
    const second = fixture(filePath);
    const reopened = await second.service.snapshot({ requestId: joined.request.id, token: joined.token });
    assert.equal(reopened.request.status, 'offered');
    assert.equal(reopened.sessions[0].heldSeats, 2);
    await assert.rejects(second.store.transaction(({ state }) => { state.sessions[0].bookedSeats = 100; throw new Error('rollback'); }), /rollback/);
    assert.equal((await second.store.read()).sessions[0].bookedSeats, 6);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).sessions[0].bookedSeats, 6);
  } finally {
    assert.ok(resolve(folder).startsWith(`${resolve(tmpdir())}${sep}`));
    assert.ok(folder.includes('together-booking-'));
    await rm(folder, { recursive: true, force: true });
  }
});
