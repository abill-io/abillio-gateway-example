// The only module that talks to Abillio. Signing is the partner guide §1
// verbatim: four headers, Ed25519 over `{timestamp}{account}{method}{path}{body}`.
// Everything else here exists so the page can show what was sent and what
// came back, and so an error reads as the envelope Abillio returned.
import { createPrivateKey, sign } from 'node:crypto';
import type { Env } from './env.ts';
import { Trace, trace as defaultTrace } from './trace.ts';

export type Blocker = { code: string; message: string; capability?: string | null };

export class AbillioError extends Error {
  status: number;
  code: string;
  blockers: Blocker[];
  fieldErrors: Record<string, string[]>;
  requestId: string | null;
  hint: string | null;

  constructor(status: number, envelope: Record<string, unknown> | null, rawText: string) {
    const error = (envelope?.error ?? {}) as Record<string, unknown>;
    const message = typeof error.message === 'string' ? error.message : rawText.slice(0, 200) || `HTTP ${status}`;
    super(message);
    this.name = 'AbillioError';
    this.status = status;
    this.code = typeof error.code === 'string' ? error.code : `http_${status}`;
    this.blockers = Array.isArray(error.blockers) ? (error.blockers as Blocker[]) : [];
    this.fieldErrors = normaliseFieldErrors(error.field_errors);
    this.requestId = typeof error.request_id === 'string' ? error.request_id : null;
    this.hint = hintFor(status, this.code);
  }

  // Whether this answer settles the call's outcome: a refusal Abillio's API
  // composed itself, in its envelope with its own code, below 500. Only then
  // is the idempotency key known to be spent on a request that did nothing.
  // The idempotency layer's answers settle nothing: Abillio still holds the
  // key for an earlier attempt (still in progress, needs reconciliation, used
  // with a different request, a stored answer it may not replay), which an
  // older backend says in a bare `{"detail": …}` and a newer one in the
  // envelope, with an `idempotency_*` code. Those, any other body without
  // the envelope (a proxy's error page) and any 5xx leave the outcome of the
  // keyed request unknown, so its key has to be kept for the retry.
  get verified(): boolean {
    return this.status < 500 && !this.code.startsWith('http_') && !this.code.startsWith('idempotency_');
  }
}

// `error.field_errors` comes in the shapes partner guide §3 lists: a map
// field -> message (a domain validation, 400), a list of {path, message, code}
// (a schema validation, 422), or null. Callers get one shape: field -> messages.
function normaliseFieldErrors(raw: unknown): Record<string, string[]> {
  const byField = new Map<string, string[]>();
  const add = (field: string, message: string) => byField.set(field, [...(byField.get(field) ?? []), message]);
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const { path, message } = (entry ?? {}) as { path?: unknown; message?: unknown };
      if (typeof message === 'string') add(fieldKey(path), message);
    }
  } else if (typeof raw === 'object' && raw !== null) {
    for (const [field, value] of Object.entries(raw)) {
      for (const message of Array.isArray(value) ? value : [value]) {
        if (typeof message === 'string') add(field, message);
      }
    }
  }
  // fromEntries, not indexing: a field called "__proto__" stays an ordinary key.
  return Object.fromEntries(byField);
}

// A schema validation's `path` arrives dotted and relative to the body
// ("items.0.amount", or "_root" when it names no field), so a string is kept
// as it is. Given as segments instead (a raw `loc`), they are joined with dots
// and a leading "body", the request source, is dropped.
function fieldKey(path: unknown): string {
  if (typeof path === 'string') return path || '_root';
  if (Array.isArray(path)) {
    const segments = path.map(String);
    if (segments[0] === 'body') segments.shift();
    return segments.join('.') || '_root';
  }
  return '_root';
}

// The causes a developer meets first, said before they go looking elsewhere.
function hintFor(status: number, code: string): string | null {
  if (status === 401) {
    return 'Abillio refused the signature. The usual causes: this machine\'s clock is more than 300 seconds off, ABILLIO_PRIVATE_KEY is not the seed shown when the key was minted, or the key is bound to another account than ABILLIO_ACCOUNT.';
  }
  if (status === 403) return `The key may not do this (${code}). Compare with GET /me/authorization/ on the Key panel.`;
  if (status === 429) return 'Rate limit reached for this key; wait for Retry-After and send the same request again.';
  return null;
}

// POST and PATCH must pass an `idempotencyKey`; `createApi` refuses them without one.
export type Api = <T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts?: { idempotencyKey?: string },
) => Promise<T>;

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// What the trace may keep of a body: keys named like secrets or like personal
// data are replaced, because the page serves the trace to whoever opens it (on
// the hosted copy, everyone). Headers are never recorded at all.
//
// One list per direction, and the two differ on purpose. A request body is the
// sample's own: the e-mail and names a visitor types on the join page go out as
// typed, and showing them as typed is the demo. An answer is Abillio's data, not
// the visitor's: GET /accounts/clients/ returns the self-client row, which
// carries the account owner's real e-mail and address, so a response masks every
// key that can hold a person's data, the three the join page types included. A
// request masks only the keys the page never types. `description` (the invoice
// line the visitor types) is on neither list.
const REQUEST_REDACTED_KEYS = new Set([
  'secret', 'private_key', 'password', 'token', 'user_email',
  'iban', 'account_number', 'personal_code', 'registration_number', 'vat_number', 'legal_name',
  'phone', 'phone_number', 'address', 'address_line1', 'address_line2', 'city', 'postal_code',
  // The contact and address spellings of the client row on GET /accounts/clients/.
  'accounting_email', 'contact_person', 'address_formatted', 'address_street', 'address_apartment', 'address_city', 'address_state', 'address_postal_code',
  'address_district', 'address_parish', 'address_village', 'address_coordinates', 'pasts_lv_address_id',
  // E-mail lists on the invoices the sample's own calls return.
  'paid_copy_emails', 'recipient_email',
]);
const RESPONSE_REDACTED_KEYS = new Set([...REQUEST_REDACTED_KEYS, 'email', 'first_name', 'last_name']);

export type TraceDirection = 'request' | 'response';
export function redactForTrace(value: unknown, direction: TraceDirection): unknown {
  if (Array.isArray(value)) return value.map(item => redactForTrace(item, direction));
  if (value && typeof value === 'object') {
    const keys = direction === 'request' ? REQUEST_REDACTED_KEYS : RESPONSE_REDACTED_KEYS;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, keys.has(k) ? '[redacted]' : redactForTrace(v, direction)]));
  }
  return value;
}

export function buildMessage(parts: { timestamp: string; account: string; method: string; path: string; body: string }): string {
  return `${parts.timestamp}${parts.account}${parts.method}${parts.path}${parts.body}`;
}

export function signMessage(seedHex: string, message: string): string {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, Buffer.from(message, 'utf8'), key).toString('hex');
}

export function createApi(
  env: Env,
  options: { fetchImpl?: typeof fetch; now?: () => number; trace?: Trace } = {},
): Api {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const trace = options.trace ?? defaultTrace;
  const base = new URL(env.apiUrl);

  return async function api<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    opts: { idempotencyKey?: string } = {},
  ): Promise<T> {
    // The key has to come from the caller: one minted here would differ on the
    // user's retry, and the retry is what the key is for. Abillio itself would
    // take the call without one, so this is the only place that can refuse it.
    if ((method === 'POST' || method === 'PATCH') && !opts.idempotencyKey) {
      throw new Error(`Idempotency-Key is required for POST/PATCH: ${path}`);
    }
    const url = new URL(base.pathname.replace(/\/$/, '') + path, base.origin);
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Math.floor(now() / 1000));
    const message = buildMessage({ timestamp, account: env.account, method, path: url.pathname + url.search, body: bodyText });
    const headers: Record<string, string> = {
      'X-API-Key': env.keyId,
      'X-API-Timestamp': timestamp,
      'X-API-Signature': signMessage(env.seedHex, message),
      Accept: 'application/json',
    };
    if (env.account) headers['X-Account'] = env.account;
    if (bodyText) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const entry = {
      at: new Date(now()).toISOString(),
      method,
      path: url.pathname + url.search,
      requestBody: redactForTrace(body ?? null, 'request'),
      status: null as number | null,
      responseBody: null as unknown,
      idempotencyKey: opts.idempotencyKey ?? null,
      replayed: false,
      error: null as string | null,
    };

    let response: Response;
    try {
      response = await fetchImpl(url, { method, headers, body: bodyText || undefined });
    } catch (err) {
      entry.error = `network: ${(err as Error).message}`;
      trace.push(entry);
      throw err;
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    entry.status = response.status;
    entry.responseBody = redactForTrace(parsed, 'response');
    entry.replayed = response.headers.get('idempotent-replay') !== null;
    if (!response.ok) {
      const error = new AbillioError(response.status, typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null, text);
      entry.error = `${error.code}: ${error.message}`;
      trace.push(entry);
      throw error;
    }
    trace.push(entry);
    return parsed as T;
  };
}
