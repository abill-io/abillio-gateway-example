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
      requestBody: body ?? null,
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
    entry.responseBody = parsed;
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
