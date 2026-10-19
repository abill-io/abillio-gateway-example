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
  await assert.rejects(api('POST', '/x', undefined, { idempotencyKey: 'idem-3' }), (err: AbillioError) => {
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

function answering(status: number, body: unknown) {
  return createApi(env, { fetchImpl: fakeFetch(() => new Response(JSON.stringify(body), { status })), trace: new Trace() });
}

test('field_errors as a map (a domain validation, 400) becomes field -> [message]', async () => {
  const api = answering(400, { error: { code: 'validation_failed', message: 'Validation failed.', field_errors: { secret: 'Secret must be 32 to 128 characters.', url: 'Enter a valid URL.' }, request_id: 'req-2' } });
  await assert.rejects(api('GET', '/x'), (err: AbillioError) => {
    assert.deepEqual(err.fieldErrors, { secret: ['Secret must be 32 to 128 characters.'], url: ['Enter a valid URL.'] });
    return true;
  });
});

test('field_errors as a list of {path, message, code} (a schema validation, 422) is grouped by path', async () => {
  const api = answering(422, {
    error: {
      code: 'validation_failed',
      message: 'Validation failed',
      field_errors: [
        { path: 'email', message: 'value is not a valid email address', code: 'value_error' },
        { path: 'items.0.amount', message: 'Input should be a valid decimal', code: 'decimal_parsing' },
        { path: 'email', message: 'Field required', code: 'missing' },
        { path: '_root', message: 'Value error, name a client or a freelancer', code: 'value_error' },
      ],
    },
  });
  await assert.rejects(api('GET', '/x'), (err: AbillioError) => {
    assert.equal(err.status, 422);
    assert.deepEqual(err.fieldErrors, {
      email: ['value is not a valid email address', 'Field required'],
      'items.0.amount': ['Input should be a valid decimal'],
      _root: ['Value error, name a client or a freelancer'],
    });
    return true;
  });
});

test('a list entry whose path is an array of segments is joined with dots, minus a leading body', async () => {
  const api = answering(422, {
    error: {
      code: 'validation_failed',
      message: 'Validation failed',
      field_errors: [
        { path: ['body', 'items', 0, 'quantity'], message: 'Input should be greater than 0', code: 'greater_than' },
        { path: ['client', 'name'], message: 'Field required', code: 'missing' },
        { path: ['body'], message: 'Input should be a valid dictionary', code: 'dict_type' },
      ],
    },
  });
  await assert.rejects(api('GET', '/x'), (err: AbillioError) => {
    assert.deepEqual(err.fieldErrors, {
      'items.0.quantity': ['Input should be greater than 0'],
      'client.name': ['Field required'],
      _root: ['Input should be a valid dictionary'],
    });
    return true;
  });
});

test('field_errors that is null or absent reads as no field errors', async () => {
  for (const error of [
    { code: 'not_found', message: 'Client not found.', field_errors: null },
    { code: 'not_found', message: 'Client not found.' },
  ]) {
    await assert.rejects(answering(404, { error })('GET', '/clients/c1/'), (err: AbillioError) => {
      assert.deepEqual(err.fieldErrors, {});
      return true;
    });
  }
});

test('a POST or PATCH without an Idempotency-Key is refused before anything is signed or sent', async () => {
  let sent = 0;
  const api = createApi(env, { fetchImpl: fakeFetch(() => { sent += 1; return new Response('{}', { status: 200 }); }), trace: new Trace() });
  for (const method of ['POST', 'PATCH'] as const) {
    const refusal = { message: 'Idempotency-Key is required for POST/PATCH: /clients/' };
    await assert.rejects(api(method, '/clients/', { name: 'Acme' }), refusal);
    await assert.rejects(api(method, '/clients/', { name: 'Acme' }, { idempotencyKey: '' }), refusal);
  }
  assert.equal(sent, 0);
  await api('POST', '/clients/', { name: 'Acme' }, { idempotencyKey: 'idem-4' });
  assert.equal(sent, 1);
});
