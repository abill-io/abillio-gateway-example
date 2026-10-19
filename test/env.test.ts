import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../lib/env.ts';

const good = {
  ABILLIO_API_KEY_ID: 'key_123',
  ABILLIO_PRIVATE_KEY: '00'.repeat(32),
};

test('reads the key, defaults the url and port, keeps optional values empty', () => {
  const env = loadEnv(good);
  assert.equal(env.keyId, 'key_123');
  assert.equal(env.seedHex, '00'.repeat(32));
  assert.equal(env.apiUrl, 'https://backend.abillio.dev/company-api/v1');
  assert.equal(env.port, 4000);
  assert.equal(env.account, '');
  assert.equal(env.publicUrl, null);
  assert.equal(env.allowProduction, false, 'the write routes stay sandbox-only');
  assert.equal(loadEnv({ ...good, ALLOW_PRODUCTION: '1' }).allowProduction, true);
  assert.equal(loadEnv({ ...good, ALLOW_PRODUCTION: 'yes' }).allowProduction, false, 'only 1 opens it');
});

test('strips a trailing slash from the api url and the public url', () => {
  const env = loadEnv({ ...good, ABILLIO_API_URL: 'https://x.test/company-api/v1/', PUBLIC_URL: 'https://me.trycloudflare.com/' });
  assert.equal(env.apiUrl, 'https://x.test/company-api/v1');
  assert.equal(env.publicUrl, 'https://me.trycloudflare.com');
});

test('refuses a missing key id or a seed that is not 64 hex characters', () => {
  assert.throws(() => loadEnv({ ABILLIO_PRIVATE_KEY: '00'.repeat(32) }), /ABILLIO_API_KEY_ID/);
  assert.throws(() => loadEnv({ ABILLIO_API_KEY_ID: 'k', ABILLIO_PRIVATE_KEY: 'abc' }), /64 hex/);
  assert.throws(() => loadEnv({ ABILLIO_API_KEY_ID: 'k', ABILLIO_PRIVATE_KEY: '-----BEGIN' }), /64 hex/);
});
