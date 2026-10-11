import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const TIMEZONE = 'America/Los_Angeles';
const RESERVED = new Set(['offered', 'capturing', 'reconciling']);

export class BookingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
    this.status = status;
  }
}

const reject = (code, message, status = 400) => { throw new BookingError(code, message, status); };
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const publicRequest = (request) => {
  if (!request) return null;
  const { tokenHash: secret, sequence, ...safe } = request;
  return structuredClone(safe);
};

function localParts(timestamp) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp)).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]));
}

function studioTime(year, month, day, hour, minute) {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  for (let index = 0; index < 3; index += 1) {
    const parts = localParts(guess);
    const observed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += desired - observed;
  }
  return new Date(guess).toISOString();
}

function initialState(now) {
  const today = localParts(now);
  const names = ['Wheel basics', 'Wheel basics', 'Clay & coffee', 'Wheel basics', 'Glaze together', 'Wheel basics'];
  const currentDay = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  const firstSaturday = ((6 - currentDay + 7) % 7) + 7;
  const offsets = [firstSaturday, firstSaturday + 1, firstSaturday + 7, firstSaturday + 8, firstSaturday + 14, firstSaturday + 15];
  const sessions = offsets.map((offset, index) => {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const startsAt = studioTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), index === 2 ? 10 : 14, 0);
    return {
      id: `session-${index + 1}`, title: names[index], startsAt,
      endsAt: new Date(Date.parse(startsAt) + 90 * 60_000).toISOString(),
      durationMinutes: 90, priceCents: [3200, 3200, 3400, 3200, 3600, 3200][index],
      currency: 'USD', capacity: 8, bookedSeats: 7,
    };
  });
  return {
    version: 1, studio: { id: 'stillwater', name: 'Stillwater Ceramics', timezone: TIMEZONE, currency: 'USD' },
    sessions, requests: [], activity: [], orders: {}, nextSequence: 1,
  };
}

export function seedSessions(now = Date.now()) {
  return initialState(now).sessions;
}

function heldSeats(state, sessionId) {
  return state.requests.reduce((sum, request) => sum + (RESERVED.has(request.status) && request.offer?.sessionId === sessionId ? request.groupSize : 0), 0);
}

function sessionView(state, session) {
  const held = heldSeats(state, session.id);
  return { ...session, heldSeats: held, availableSeats: session.capacity - session.bookedSeats - held };
}

function audit(state, now, type, message, extra = {}) {
  state.activity.unshift({ id: randomUUID(), at: new Date(now).toISOString(), type, message, ...extra });
  state.activity = state.activity.slice(0, 100);
}

export function assertInvariants(state) {
  const orders = new Map();
  const captures = new Map();
  for (const session of state.sessions) {
    const held = heldSeats(state, session.id);
    if (!Number.isInteger(session.bookedSeats) || session.bookedSeats < 0 || session.bookedSeats + held > session.capacity) {
      throw new Error(`Seat invariant failed for ${session.id}`);
    }
    const paidSeats = state.requests.filter((request) => request.status === 'booked' && request.offer?.sessionId === session.id).reduce((sum, request) => sum + request.groupSize, 0);
    if (paidSeats > session.bookedSeats) throw new Error(`Booking invariant failed for ${session.id}`);
  }
  for (const request of state.requests) {
    if (RESERVED.has(request.status) || request.status === 'booked') {
      const session = state.sessions.find(({ id }) => id === request.offer?.sessionId);
      if (!session || !request.sessionIds.includes(session.id) || request.offer.totalCents !== session.priceCents * request.groupSize || request.offer.totalCents > request.maxTotalCents) {
        throw new Error(`Group or budget invariant failed for ${request.id}`);
      }
    }
    if (request.offer?.orderId) {
      if (orders.has(request.offer.orderId) && orders.get(request.offer.orderId) !== request.id) throw new Error('Order ownership invariant failed');
      orders.set(request.offer.orderId, request.id);
    }
    if (request.receipt?.captureId) {
      if (captures.has(request.receipt.captureId)) throw new Error('Capture uniqueness invariant failed');
      captures.set(request.receipt.captureId, request.id);
    }
  }
  return true;
}

export function createBookingService({ store, clock = Date.now, holdMinutes = 10 } = {}) {
  if (!store?.transaction) throw new TypeError('A store is required');
  if (!(holdMinutes > 0 && Number.isFinite(holdMinutes))) throw new TypeError('holdMinutes must be positive');
  const getNow = () => {
    const result = clock();
    const value = result instanceof Date ? result.getTime() : typeof result === 'string' ? Date.parse(result) : result;
    if (!Number.isFinite(value)) throw new TypeError('Clock must return a valid timestamp');
    return value;
  };

  function authenticate(state, id, token) {
    const request = state.requests.find((item) => item.id === id);
    if (!request) reject('NOT_FOUND', 'This waitlist request was not found.', 404);
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) reject('UNAUTHORIZED', 'Use the browser that joined this waitlist.', 401);
    const supplied = Buffer.from(tokenHash(token), 'hex');
    const expected = Buffer.from(request.tokenHash, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) reject('UNAUTHORIZED', 'Use the browser that joined this waitlist.', 401);
    return request;
  }

  function expire(state, now) {
    for (const request of state.requests) {
      if (request.status === 'offered' && Date.parse(request.offer.expiresAt) <= now) {
        request.status = 'expired';
        request.updatedAt = new Date(now).toISOString();
        audit(state, now, 'offer-expired', `The ${request.groupSize}-place offer expired and its seats returned to the schedule.`, { requestId: request.id, sessionId: request.offer.sessionId });
      }
    }
  }

  function compatible(state, request, session, now) {
    return Date.parse(session.startsAt) > now && request.sessionIds.includes(session.id) &&
      session.priceCents * request.groupSize <= request.maxTotalCents &&
      session.capacity - session.bookedSeats - heldSeats(state, session.id) >= request.groupSize;
  }

  function match(state, now) {
    const waiting = state.requests.filter(({ status }) => status === 'waiting').sort((a, b) => a.sequence - b.sequence);
    for (const request of waiting) {
      const options = state.sessions.filter((session) => compatible(state, request, session, now)).map((session) => ({
        session,
        contention: waiting.filter((other) => other.id !== request.id && other.status === 'waiting' && compatible(state, other, session, now)).length,
      })).sort((a, b) => a.contention - b.contention || Date.parse(a.session.startsAt) - Date.parse(b.session.startsAt) || a.session.id.localeCompare(b.session.id));
      if (!options.length) continue;
      const { session } = options[0];
      request.status = 'offered';
      request.updatedAt = new Date(now).toISOString();
      request.offer = {
        id: randomUUID(), sessionId: session.id, groupSize: request.groupSize,
        totalCents: session.priceCents * request.groupSize, currency: session.currency,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + holdMinutes * 60_000).toISOString(), checkoutState: 'idle',
      };
      audit(state, now, 'group-matched', `${request.groupSize} places held together for ${session.title}.`, { requestId: request.id, sessionId: session.id });
    }
  }

  async function transact(operation) {
    return store.transaction((context) => {
      const now = getNow();
      if (!context.state) context.state = initialState(now);
      const state = context.state;
      if (state.version !== 1) throw new Error('Unsupported booking data version');
      state.orders ??= {};
      expire(state, now);
      match(state, now);
      const result = operation(state, now);
      match(state, now);
      assertInvariants(state);
      return result;
    });
  }

  function requireOffer(request) {
    if (request.status !== 'offered') reject('OFFER_UNAVAILABLE', 'This offer is no longer available. Retry an expired request to join the queue again.', 409);
  }

  function checkoutIntent(state, request, action) {
    const session = state.sessions.find(({ id }) => id === request.offer.sessionId);
    return {
      action, requestId: request.id, offerId: request.offer.id, sessionId: session.id, sessionTitle: session.title,
      totalCents: request.offer.totalCents, currency: request.offer.currency, expiresAt: request.offer.expiresAt,
      orderId: request.offer.orderId ?? null, approvalUrl: request.offer.approvalUrl ?? null,
      createRequestKey: `offer:${request.offer.id}:create`, captureRequestKey: `offer:${request.offer.id}:capture`,
      offer: structuredClone(request.offer), request: publicRequest(request),
    };
  }

  function book(state, request, now, receipt) {
    const session = state.sessions.find(({ id }) => id === request.offer.sessionId);
    session.bookedSeats += request.groupSize;
    request.status = 'booked';
    request.updatedAt = new Date(now).toISOString();
    request.receipt = { ...receipt, bookedAt: new Date(now).toISOString(), sessionId: session.id, groupSize: request.groupSize, totalCents: request.offer.totalCents, currency: request.offer.currency };
    audit(state, now, receipt.paymentMode === 'simulation' ? 'booking-simulated' : 'booking-paid', `${request.groupSize} places booked together for ${session.title}${receipt.paymentMode === 'simulation' ? ' in the local scenario' : ' with a verified sandbox payment'}.`, { requestId: request.id, sessionId: session.id });
    return publicRequest(request);
  }

  return {
    snapshot({ studio = false, requestId, token } = {}) {
      return transact((state, now) => {
        const own = requestId ? authenticate(state, requestId, token) : null;
        const sessions = state.sessions.map((session) => sessionView(state, session));
        const count = (statuses) => state.requests.filter(({ status }) => statuses.includes(status)).length;
        return {
          studio: structuredClone(state.studio), sessions, request: publicRequest(own),
          requests: studio ? state.requests.map(publicRequest).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) : [],
          activity: studio ? structuredClone(state.activity) : [],
          stats: { waiting: count(['waiting']), offered: count(['offered', 'capturing', 'reconciling']), booked: count(['booked']), expired: count(['expired']), cancelled: count(['cancelled']), heldSeats: sessions.reduce((sum, session) => sum + session.heldSeats, 0), availableSeats: sessions.reduce((sum, session) => sum + session.availableSeats, 0), totalBookings: count(['booked']) },
          serverNow: new Date(now).toISOString(), holdMinutes,
        };
      });
    },

    join({ customerName, groupSize, sessionIds, maxTotalCents, note = '' } = {}) {
      return transact((state, now) => {
        if (typeof customerName !== 'string' || !customerName.trim() || customerName.trim().length > 80) reject('INVALID_NAME', 'Enter a name between 1 and 80 characters.');
        if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 8) reject('INVALID_GROUP', 'Choose a group size from 1 to 8.');
        if (!Array.isArray(sessionIds) || !sessionIds.length || sessionIds.length > 6 || sessionIds.some((id) => typeof id !== 'string' || !state.sessions.some((session) => session.id === id && Date.parse(session.startsAt) > now))) reject('INVALID_SESSIONS', 'Choose at least one upcoming session from this studio.');
        if (!Number.isInteger(maxTotalCents) || maxTotalCents < 1 || maxTotalCents > 1_000_000) reject('INVALID_BUDGET', 'Enter a valid total group budget.');
        if (typeof note !== 'string' || note.length > 1000) reject('INVALID_NOTE', 'Keep your note within 1,000 characters.');
        const token = randomBytes(32).toString('base64url');
        const request = {
          id: randomUUID(), customerName: customerName.trim(), groupSize,
          sessionIds: [...new Set(sessionIds)], maxTotalCents, note: note.trim(),
          status: 'waiting', sequence: state.nextSequence++, tokenHash: tokenHash(token),
          createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
        };
        state.requests.push(request);
        audit(state, now, 'request-joined', `A group of ${groupSize} joined across ${request.sessionIds.length} acceptable dates.`, { requestId: request.id });
        match(state, now);
        return { request: publicRequest(request), token };
      });
    },

    releaseSeats(sessionId, count) {
      return transact((state, now) => {
        const session = state.sessions.find(({ id }) => id === sessionId);
        if (!session) reject('SESSION_NOT_FOUND', 'This session was not found.', 404);
        const paidSeats = state.requests.filter((request) => request.status === 'booked' && request.offer?.sessionId === sessionId).reduce((sum, request) => sum + request.groupSize, 0);
        if (!Number.isInteger(count) || count < 1 || count > session.bookedSeats - paidSeats) reject('INVALID_RELEASE', 'Release only existing studio bookings; paid Together bookings stay reserved.');
        session.bookedSeats -= count;
        audit(state, now, 'seats-opened', `${count} ${count === 1 ? 'place opened' : 'places opened'} in ${session.title}.`, { sessionId });
        match(state, now);
        return sessionView(state, session);
      });
    },

    cancel(requestId, token) {
      return transact((state, now) => {
        const request = authenticate(state, requestId, token);
        if (['capturing', 'reconciling'].includes(request.status)) reject('PAYMENT_PENDING', 'Payment is being checked. Your places remain held until it is resolved.', 409);
        if (request.status === 'booked') reject('ALREADY_BOOKED', 'A completed booking must be managed by the studio.', 409);
        if (request.status !== 'cancelled') {
          request.status = 'cancelled';
          request.updatedAt = new Date(now).toISOString();
          audit(state, now, 'request-cancelled', 'The customer cancelled their waitlist request.', { requestId });
        }
        return publicRequest(request);
      });
    },

    retry(requestId, token) {
      return transact((state, now) => {
        const request = authenticate(state, requestId, token);
        if (!['expired', 'cancelled'].includes(request.status)) reject('RETRY_UNAVAILABLE', 'Only expired or cancelled requests can rejoin.', 409);
        request.status = 'waiting';
        request.sequence = state.nextSequence++;
        request.updatedAt = new Date(now).toISOString();
        delete request.offer;
        delete request.receipt;
        audit(state, now, 'request-retried', 'The customer rejoined the queue with the same dates and budget.', { requestId });
        match(state, now);
        return publicRequest(request);
      });
    },

    expireOffer(requestId) {
      return transact((state, now) => {
        const request = state.requests.find(({ id }) => id === requestId);
        if (!request) reject('NOT_FOUND', 'This waitlist request was not found.', 404);
        requireOffer(request);
        request.offer.expiresAt = new Date(now).toISOString();
        expire(state, now);
        return publicRequest(request);
      });
    },

    beginCheckout(requestId, token) {
      return transact((state, now) => {
        const request = authenticate(state, requestId, token);
        requireOffer(request);
        if (!request.offer.orderId) {
          request.offer.checkoutState = 'creating';
          request.updatedAt = new Date(now).toISOString();
        }
        return checkoutIntent(state, request, request.offer.orderId ? 'existing' : 'create');
      });
    },

    attachOrder(requestId, token, { offerId, orderId, approvalUrl } = {}) {
      return transact((state, now) => {
        const request = authenticate(state, requestId, token);
        requireOffer(request);
        if (request.offer.id !== offerId) reject('OFFER_CHANGED', 'This checkout belongs to an older offer.', 409);
        if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{6,100}$/.test(orderId)) reject('INVALID_ORDER', 'The payment provider returned an invalid order.', 502);
        if (request.offer.orderId && request.offer.orderId !== orderId) reject('ORDER_CHANGED', 'This offer already has a payment order.', 409);
        if (state.requests.some((other) => other.id !== requestId && other.offer?.orderId === orderId)) reject('ORDER_OWNERSHIP', 'This payment order belongs to another request.', 409);
        if (state.orders[orderId] && (state.orders[orderId].requestId !== requestId || state.orders[orderId].offerId !== offerId)) reject('ORDER_OWNERSHIP', 'This payment order belongs to another offer.', 409);
        if (typeof approvalUrl !== 'string') reject('INVALID_APPROVAL', 'The payment provider did not return an approval link.', 502);
        request.offer.orderId = orderId;
        state.orders[orderId] = { requestId, offerId };
        request.offer.approvalUrl = approvalUrl;
        request.offer.checkoutState = 'ready';
        request.updatedAt = new Date(now).toISOString();
        return publicRequest(request);
      });
    },

    abortCheckout(requestId, token, { offerId, reason = '', definitive = true } = {}) {
      return transact((state, now) => {
        const request = authenticate(state, requestId, token);
        if (request.offer?.id !== offerId) reject('OFFER_CHANGED', 'This checkout belongs to an older offer.', 409);
        if (request.status === 'offered' && !request.offer.orderId) {
          request.offer.checkoutState = definitive ? 'idle' : 'creating';
          request.updatedAt = new Date(now).toISOString();
          if (reason) audit(state, now, 'checkout-delayed', String(reason).slice(0, 200), { requestId });
        }
        return publicRequest(request);
      });
    },

    beginCapture(requestId, token, { orderId } = {}) {
      return transact((state, now) => {
        const request = authenticate(state, requestId, token);
        if (!orderId || request.offer?.orderId !== orderId) reject('ORDER_OWNERSHIP', 'This payment order does not belong to your offer.', 409);
        if (request.status === 'booked') return checkoutIntent(state, request, 'completed');
        if (['capturing', 'reconciling'].includes(request.status)) return checkoutIntent(state, request, 'reconcile');
        requireOffer(request);
        request.status = 'capturing';
        request.offer.captureStartedAt = new Date(now).toISOString();
        request.updatedAt = new Date(now).toISOString();
        audit(state, now, 'payment-started', 'The approved payment is being verified; all group places remain held.', { requestId });
        return checkoutIntent(state, request, 'capture');
      });
    },

    completeCapture(requestId, { orderId, verified, providerStatus, capturedAmountCents, currency, captureId } = {}) {
      return transact((state, now) => {
        const request = state.requests.find(({ id }) => id === requestId);
        if (!request) reject('NOT_FOUND', 'This waitlist request was not found.', 404);
        if (!orderId || request.offer?.orderId !== orderId) reject('ORDER_OWNERSHIP', 'The verified payment does not match this offer.', 409);
        if (request.status === 'booked') {
          if (request.receipt?.paymentMode !== 'sandbox' || request.receipt.captureId !== captureId) reject('PAYMENT_CHANGED', 'This booking already has a different receipt.', 409);
          return publicRequest(request);
        }
        if (!['capturing', 'reconciling'].includes(request.status)) reject('CAPTURE_NOT_STARTED', 'Payment was not started while the offer was valid.', 409);
        if (verified !== true || providerStatus !== 'COMPLETED' || capturedAmountCents !== request.offer.totalCents || currency !== request.offer.currency || typeof captureId !== 'string' || !captureId) reject('UNVERIFIED_PAYMENT', 'The payment could not be verified against the held booking.', 409);
        if (state.requests.some((other) => other.id !== requestId && other.receipt?.captureId === captureId)) reject('CAPTURE_OWNERSHIP', 'This payment capture already belongs to another booking.', 409);
        return book(state, request, now, { provider: 'paypal', paymentMode: 'sandbox', captureMode: 'provider-verified', orderId, captureId, providerStatus });
      });
    },

    failCapture(requestId, { orderId, definitive = false, reason = 'Payment confirmation is pending.' } = {}) {
      return transact((state, now) => {
        const request = state.requests.find(({ id }) => id === requestId);
        if (!request) reject('NOT_FOUND', 'This waitlist request was not found.', 404);
        if (!orderId || request.offer?.orderId !== orderId) reject('ORDER_OWNERSHIP', 'This payment order does not belong to this request.', 409);
        if (request.status === 'booked') return publicRequest(request);
        if (!['capturing', 'reconciling'].includes(request.status)) reject('CAPTURE_NOT_STARTED', 'There is no pending payment to resolve.', 409);
        request.status = definitive ? (Date.parse(request.offer.expiresAt) > now ? 'offered' : 'expired') : 'reconciling';
        request.updatedAt = new Date(now).toISOString();
        request.offer.paymentMessage = String(reason).slice(0, 200);
        audit(state, now, definitive ? 'payment-declined' : 'payment-reconciling', definitive ? 'The provider confirmed no payment; the offer follows its original expiry.' : 'Payment outcome is being reconciled. The group places remain reserved.', { requestId });
        return publicRequest(request);
      });
    },

    simulateBooking(requestId, token) {
      return transact((state, now) => {
        const request = authenticate(state, requestId, token);
        if (request.status === 'booked' && request.receipt?.paymentMode === 'simulation') return publicRequest(request);
        requireOffer(request);
        return book(state, request, now, { provider: 'local-scenario', paymentMode: 'simulation', captureMode: 'simulation', receiptId: `simulation-${randomUUID()}` });
      });
    },
  };
}
