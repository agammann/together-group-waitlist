import { createHash } from 'node:crypto';

const SANDBOX_API = 'https://api-m.sandbox.paypal.com';
const SAFE_ISSUES = new Set([
  'INSTRUMENT_DECLINED', 'PAYER_ACTION_REQUIRED', 'ORDER_NOT_APPROVED',
  'ORDER_ALREADY_CAPTURED', 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID',
  'DUPLICATE_INVOICE_ID', 'UNPROCESSABLE_ENTITY', 'INVALID_REQUEST',
  'AUTHENTICATION_FAILURE', 'NOT_AUTHORIZED', 'PERMISSION_DENIED',
  'INTERNAL_SERVER_ERROR', 'SERVICE_UNAVAILABLE', 'RATE_LIMIT_REACHED',
]);
const DEFINITIVE_CAPTURE_FAILURES = new Set([
  'INSTRUMENT_DECLINED', 'PAYER_ACTION_REQUIRED', 'ORDER_NOT_APPROVED',
]);

export class PayPalError extends Error {
  constructor(message, { code = 'PAYPAL_ERROR', status = 502, definitive = false } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.code = code;
    this.status = status;
    this.definitive = definitive;
  }
}

function invalid(message) {
  return new PayPalError(message, { code: 'PAYPAL_INVALID_INPUT', status: 400, definitive: true });
}

function identifier(value, label, max = 127) {
  if (typeof value !== 'string' || !new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(value)) {
    throw invalid(`A valid ${label} is required.`);
  }
  return value;
}

function amountCents(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw invalid('The server must supply a positive total in cents.');
  }
  return value;
}

function dollars(cents) {
  amountCents(cents);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function parseDollars(value) {
  if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function callbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid('A valid checkout return URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw invalid('Checkout callbacks must use HTTPS or the local app.');
  }
  return url.href;
}

export function paypalRequestId(operation, key) {
  if (!['create', 'capture'].includes(operation) || typeof key !== 'string' || !key || key.length > 300) {
    throw invalid('A stable payment request key is required.');
  }
  // Stable across retry, restart, and token refresh; separate operations never share a key.
  return `tg-${operation}-${createHash('sha256').update(`${operation}:${key}`).digest('hex').slice(0, 24)}`;
}

export function verifyCapture(order, { orderId, totalCents, currency = 'USD', requestId, offerId }) {
  identifier(orderId, 'order ID');
  identifier(requestId, 'request ID');
  identifier(offerId, 'offer ID');
  amountCents(totalCents);
  const reject = () => { throw new PayPalError('PayPal payment could not be verified. The seats remain reserved while the order is checked.', { code: 'PAYPAL_UNVERIFIED_CAPTURE', definitive: false }); };
  if (currency !== 'USD' || !order || order.id !== orderId || order.status !== 'COMPLETED' ||
      order.intent !== 'CAPTURE' || !Array.isArray(order.purchase_units) || order.purchase_units.length !== 1) reject();
  const unit = order.purchase_units[0];
  if (unit.reference_id !== offerId || unit.custom_id !== requestId || unit.invoice_id !== offerId ||
      unit.amount?.currency_code !== currency || parseDollars(unit.amount?.value) !== totalCents) reject();
  const captures = unit.payments?.captures;
  if (!Array.isArray(captures) || captures.length !== 1) reject();
  const capture = captures[0];
  if (!capture || typeof capture.id !== 'string' || !/^[A-Za-z0-9_-]{1,127}$/.test(capture.id) ||
      capture.status !== 'COMPLETED' || capture.final_capture !== true ||
      capture.amount?.currency_code !== currency || parseDollars(capture.amount?.value) !== totalCents ||
      (capture.invoice_id !== undefined && capture.invoice_id !== offerId) ||
      (capture.custom_id !== undefined && capture.custom_id !== requestId) ||
      (capture.supplementary_data?.related_ids?.order_id !== undefined &&
       capture.supplementary_data.related_ids.order_id !== orderId)) reject();
  return {
    verified: true, providerStatus: 'COMPLETED', orderId,
    capturedAmountCents: totalCents, currency, captureId: capture.id,
  };
}

export function createPayPal({ clientId = '', clientSecret = '', fetchImpl = globalThis.fetch,
  baseUrl = SANDBOX_API, timeoutMs = 15_000 } = {}) {
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw invalid('PayPal sandbox endpoint is invalid.'); }
  if (endpoint.origin !== SANDBOX_API || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw invalid('This project supports only the PayPal sandbox API.');
  }
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw invalid('Payment provider configuration is invalid.');
  }
  const configured = typeof clientId === 'string' && Boolean(clientId.trim()) &&
    typeof clientSecret === 'string' && Boolean(clientSecret.trim());
  let cachedToken;
  let expiresAt = 0;
  let tokenPromise;

  function config() { return { configured, mode: 'sandbox', baseUrl: SANDBOX_API }; }

  async function transport(path, init, operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${SANDBOX_API}${path}`, { ...init, signal: controller.signal, redirect: 'error' });
      let payload;
      try { payload = await response.json(); } catch {
        throw new PayPalError('PayPal returned an unreadable response. Check the order before retrying.', { code: 'PAYPAL_INVALID_RESPONSE', status: 502 });
      }
      if (!response.ok) {
        const candidate = payload?.details?.find(detail => SAFE_ISSUES.has(detail?.issue))?.issue ?? payload?.name;
        const issue = SAFE_ISSUES.has(candidate) ? candidate : 'PAYPAL_REJECTED';
        const definitive = operation === 'capture' ?
          response.status === 422 && DEFINITIVE_CAPTURE_FAILURES.has(issue) :
          operation !== 'token' && response.status >= 400 && response.status < 500 && response.status !== 429;
        const message = definitive && operation === 'capture' ?
          'PayPal did not capture this payment. Approve the order or choose another sandbox funding source.' :
          'PayPal could not complete the request. Check the order before retrying.';
        throw new PayPalError(message, { code: issue, status: response.status, definitive });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new PayPalError('PayPal returned an invalid response.', { code: 'PAYPAL_INVALID_RESPONSE' });
      }
      return payload;
    } catch (error) {
      if (error instanceof PayPalError) throw error;
      throw new PayPalError('PayPal could not be reached. Check the order before retrying.', { code: controller.signal.aborted ? 'PAYPAL_TIMEOUT' : 'PAYPAL_NETWORK', status: 503, definitive: false });
    } finally { clearTimeout(timer); }
  }

  async function token() {
    if (!configured) throw new PayPalError('PayPal sandbox credentials are not configured.', { code: 'PAYPAL_NOT_CONFIGURED', status: 503, definitive: true });
    if (cachedToken && Date.now() < expiresAt) return cachedToken;
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => {
      const data = await transport('/v1/oauth2/token', {
        method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: 'grant_type=client_credentials',
      }, 'token');
      if (typeof data.access_token !== 'string' || !data.access_token ||
          !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
        throw new PayPalError('PayPal authentication could not be verified.', { code: 'PAYPAL_INVALID_TOKEN' });
      }
      cachedToken = data.access_token;
      expiresAt = Date.now() + Math.max(0, data.expires_in * 1000 - 30_000);
      return cachedToken;
    })();
    try { return await tokenPromise; } finally { tokenPromise = undefined; }
  }

  async function api(path, { method = 'GET', body, requestId } = {}, operation = 'get') {
    // A 401 rejects authorization before payment processing. Refresh once and keep the same request ID.
    for (let attempt = 0; attempt < 2; attempt++) {
      const authorization = await token();
      try {
        return await transport(path, {
          method, headers: { Authorization: `Bearer ${authorization}`, Accept: 'application/json', 'Content-Type': 'application/json', Prefer: 'return=representation', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }, operation);
      } catch (error) {
        if (error.status !== 401 || attempt > 0) throw error;
        cachedToken = undefined;
        expiresAt = 0;
      }
    }
  }

  return {
    config,
    readiness() { return { ...config(), ready: configured }; },
    async createOrder({ requestId, offerId, totalCents, currency = 'USD', returnUrl, cancelUrl, requestKey }) {
      identifier(requestId, 'request ID');
      identifier(offerId, 'offer ID');
      amountCents(totalCents);
      if (currency !== 'USD') throw invalid('This studio books in USD.');
      const order = await api('/v2/checkout/orders', {
        method: 'POST', requestId: paypalRequestId('create', requestKey ?? offerId),
        body: {
          intent: 'CAPTURE', purchase_units: [{ reference_id: offerId, custom_id: requestId, invoice_id: offerId,
            description: 'Together studio group booking', amount: { currency_code: currency, value: dollars(totalCents) } }],
          payment_source: { paypal: { experience_context: { brand_name: 'Together Studio', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', return_url: callbackUrl(returnUrl), cancel_url: callbackUrl(cancelUrl) } } },
        },
      }, 'create');
      const orderId = identifier(order.id, 'PayPal order ID');
      if (!['CREATED', 'PAYER_ACTION_REQUIRED'].includes(order.status)) {
        throw new PayPalError('PayPal did not return an order awaiting customer approval.', { code: 'PAYPAL_INVALID_ORDER' });
      }
      const href = order.links?.find(link => ['approve', 'payer-action'].includes(link.rel))?.href;
      let approval;
      try { approval = new URL(href); } catch { throw new PayPalError('PayPal did not return a valid approval link.', { code: 'PAYPAL_INVALID_APPROVAL_URL' }); }
      if (approval.origin !== 'https://www.sandbox.paypal.com' || approval.pathname !== '/checkoutnow' ||
          approval.username || approval.password || approval.hash || approval.searchParams.get('token') !== orderId) {
        throw new PayPalError('PayPal did not return an approved sandbox checkout link.', { code: 'PAYPAL_INVALID_APPROVAL_URL' });
      }
      return { orderId, approvalUrl: approval.href };
    },
    async captureOrder(orderId, { requestKey } = {}) {
      identifier(orderId, 'order ID');
      return api(`/v2/checkout/orders/${orderId}/capture`, { method: 'POST', body: {}, requestId: paypalRequestId('capture', requestKey ?? orderId) }, 'capture');
    },
    async getOrder(orderId) {
      identifier(orderId, 'order ID');
      return api(`/v2/checkout/orders/${orderId}`);
    },
  };
}
