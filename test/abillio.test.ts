import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { AbillioError, buildMessage, createApi, signMessage } from '../lib/abillio.ts';
import { Trace } from '../lib/trace.ts';
import type { Env } from '../lib/env.ts';

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));

const env: Env = {
  apiUrl: 'https://api.test/company-api/v1',
  keyId: 'key_1',
  seedHex: vectors.seed_hex,
  account: '',
  publicUrl: null,
  port: 4000,
};

test('builds the message the backend builds and signs it the way the backend verifies', () => {
  for (const c of vectors.requests) {
    const message = buildMessage({ timestamp: c.timestamp, account: c.account, method: c.method, path: c.path, body: c.body });
    assert.equal(message, c.message);
    assert.equal(signMessage(vectors.seed_hex, message), c.signature);
  }
});

test('the derived public key is the one Abillio holds', () => {
  const sig = Buffer.from(vectors.requests[0].signature, 'hex');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(vectors.public_key_hex, 'hex')]);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.ok(verify(null, Buffer.from(vectors.requests[0].message), key, sig));
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

test('sends the four headers, signs path+query and the exact body, and parses JSON', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const api = createApi({ ...env, account: 'acme' }, {
    now: () => 1760000001000,
    fetchImpl: fakeFetch((url, init) => { seen = { url, init }; return new Response('{"session_id":"s1"}', { status: 201, headers: { 'content-type': 'application/json' } }); }),
    trace: new Trace(),
  });
  const out = await api<{ session_id: string }>('POST', '/onboarding/sessions/', { email: 'anna@example.com', locale: 'lv' }, { idempotencyKey: 'idem-1' });
  assert.equal(out.session_id, 's1');
  const headers = new Headers(seen!.init.headers);
  assert.equal(seen!.url, 'https://api.test/company-api/v1/onboarding/sessions/');
  assert.equal(headers.get('x-api-key'), 'key_1');
  assert.equal(headers.get('x-api-timestamp'), '1760000001');
  assert.equal(headers.get('x-account'), 'acme');
  assert.equal(headers.get('idempotency-key'), 'idem-1');
  assert.equal(headers.get('x-api-signature'), vectors.requests[1].signature);
  assert.equal(seen!.init.body, '{"email":"anna@example.com","locale":"lv"}');
});

test('a GET without an account signs an empty account and no body, and keeps the query string', async () => {
  let seen: RequestInit | null = null;
  const api = createApi(env, {
    now: () => 1760000002000,
    fetchImpl: fakeFetch((_url, init) => { seen = init; return new Response('{"items":[]}', { status: 200 }); }),
    trace: new Trace(),
  });
  await api('GET', '/engagements/?search=anna%40example.com');
  const headers = new Headers(seen!.headers);
  assert.equal(headers.get('x-account'), null);
  assert.equal(seen!.body ?? undefined, undefined);
});

test('a non-2xx answer becomes an AbillioError carrying the envelope, and 401 carries the three usual causes', async () => {
  const trace = new Trace();
  const envelope = { error: { code: 'kyc_missing', message: 'Identity not verified', field_errors: null, capability: 'send_invoice', blockers: [{ code: 'kyc_missing', message: 'Identity not verified', capability: 'send_invoice' }], request_id: 'req-9' } };
  const api = createApi(env, { fetchImpl: fakeFetch(() => new Response(JSON.stringify(envelope), { status: 409 })), trace });
  await assert.rejects(api('POST', '/x'), (err: AbillioError) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, 'kyc_missing');
    assert.equal(err.blockers[0].code, 'kyc_missing');
    assert.equal(err.requestId, 'req-9');
    return true;
  });
  const api401 = createApi(env, { fetchImpl: fakeFetch(() => new Response('{"error":{"code":"unauthorized","message":"Invalid signature"}}', { status: 401 })), trace });
  await assert.rejects(api401('GET', '/me/session/'), (err: AbillioError) => {
    assert.match(err.hint ?? '', /300 seconds|seed|another account/);
    return true;
  });
  assert.equal(trace.list().length, 2);
  assert.equal(trace.list()[0].status, 409);
});

test('the trace keeps the request and response but never the signature, and marks replays', async () => {
  const trace = new Trace();
  const api = createApi(env, { fetchImpl: fakeFetch(() => new Response('{"ok":true}', { status: 200, headers: { 'idempotent-replay': 'true' } })), trace });
  await api('POST', '/accounts/wallet/pay-invoice/', { invoice_uuid: 'inv-1' }, { idempotencyKey: 'idem-2' });
  const entry = trace.last()!;
  assert.equal(entry.replayed, true);
  assert.equal(entry.idempotencyKey, 'idem-2');
  assert.deepEqual(entry.requestBody, { invoice_uuid: 'inv-1' });
  assert.ok(!JSON.stringify(entry).includes(vectors.seed_hex));
});
