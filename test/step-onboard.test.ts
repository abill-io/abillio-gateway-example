import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEngagement, readSession, returnUrlFor, startOnboarding } from '../steps/02-onboard.ts';
import { defaultState } from '../lib/store.ts';
import type { Api } from '../lib/abillio.ts';

test('return_url is the public url when there is one, else localhost on the port', () => {
  assert.equal(returnUrlFor('https://me.trycloudflare.com', 4000), 'https://me.trycloudflare.com/back');
  assert.equal(returnUrlFor(null, 4100), 'http://localhost:4100/back');
});

test('startOnboarding mints the session with prefill and return_url, and derives the popup origin', async () => {
  const calls: unknown[] = [];
  const api = (async (method: string, path: string, body: unknown, opts: unknown) => {
    calls.push({ method, path, body, opts });
    return { session_id: 's1', url: 'https://new.abillio.dev/s/tok123', status: 'awaiting_freelancer', purpose: 'onboarding', mode: 'onboarding', expires_at: 'x' };
  }) as Api;
  const out = await startOnboarding(api, defaultState(), { first_name: 'Anna', last_name: 'Ozola', email: 'anna@example.com', tax_country: 'LV', locale: 'lv' }, 'http://localhost:4000/back');
  assert.deepEqual(out, { session_id: 's1', url: 'https://new.abillio.dev/s/tok123', origin: 'https://new.abillio.dev' });
  assert.deepEqual(calls[0], {
    method: 'POST', path: '/onboarding/sessions/',
    body: { email: 'anna@example.com', locale: 'lv', return_url: 'http://localhost:4000/back', prefill: { first_name: 'Anna', last_name: 'Ozola', tax_country: 'LV' } },
    opts: { idempotencyKey: (calls[0] as { opts: { idempotencyKey: string } }).opts.idempotencyKey },
  });
  assert.match((calls[0] as { opts: { idempotencyKey: string } }).opts.idempotencyKey, /^[0-9a-f-]{36}$/);
});

test('readSession returns the status rows; findEngagement matches the counterparty e-mail', async () => {
  const api = (async (_m: string, path: string) => {
    if (path === '/onboarding/sessions/s1') return { state: 'in_progress', can_be_paid: false, purpose: 'onboarding', mode: 'onboarding', requirements: [{ key: 'kyc', state: 'in_progress' }] };
    if (path === '/engagements/?search=anna%40example.com') return { count: 2, items: [
      { id: 'e-other', status: 'active', counterparty: { email: 'other@example.com', servicing_company: { slug: 'abillio-ks' } }, compliance: { can_be_paid: true } },
      { id: 'e1', status: 'invited', counterparty: { email: 'anna@example.com', servicing_company: { slug: 'abillio-ks' } }, compliance: { can_be_paid: false } },
    ] };
    throw new Error(path);
  }) as Api;
  const status = await readSession(api, 's1');
  assert.equal(status.requirements[0].key, 'kyc');
  assert.deepEqual(await findEngagement(api, 'anna@example.com'), { id: 'e1', status: 'invited', can_be_paid: false, servicing_company_slug: 'abillio-ks', requirements: null });
  // A list that reads `complete` comes back as listed: the status check tells
  // a closed list from one Abillio could not work out (`null`).
  const closed = { status: 'complete', due: [], upcoming: [] };
  const listed = (async () => ({ count: 1, items: [{ id: 'e1', status: 'active', counterparty: { email: 'anna@example.com', servicing_company: null }, compliance: { can_be_paid: true }, requirements: closed }] })) as Api;
  assert.deepEqual((await findEngagement(listed, 'anna@example.com'))?.requirements, closed);
  assert.equal(await findEngagement((async () => ({ count: 0, items: [] })) as Api, 'x@example.com'), null);
});
