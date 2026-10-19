import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.ts';
import { Trace } from '../lib/trace.ts';
import { defaultState, type State } from '../lib/store.ts';
import type { Api } from '../lib/abillio.ts';

export function memoryState(initial: State = defaultState()) {
  let current = initial;
  return { load: () => current, update: (fn: (s: State) => void) => { fn(current); return current; } };
}

export function appWith(api: Api, state = memoryState(), publicUrl: string | null = null, onStored: () => void = () => {}, now: () => number = Date.now) {
  const trace = new Trace();
  const app = createApp({ api, state, trace, publicUrl, port: 4000, abillioOrigin: () => 'https://new.abillio.dev', onStored, now, pollIntervalMs: null });
  return { app, trace, state };
}

test('GET / renders the company page with the five step panels', async () => {
  const { app } = appWith((async () => ({})) as Api);
  const res = await app.request('/');
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const title of ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5']) assert.ok(html.includes(title), title);
});

test('POST /steps/key stores the account and shows the actions table; an error renders as the envelope', async () => {
  const api = (async (_m: string, path: string) => {
    if (path === '/me/session/') return { account: { id: 'a1', name: 'Acme', slug: 'acme', is_sandbox: true, kind: 'company' }, is_owner: true, user_email: 'dev@acme.test' };
    if (path === '/me/authorization/') return { actions: { 'freelancers.invite': { state: 'available' } } };
    throw new Error(path);
  }) as Api;
  const { app, state } = appWith(api);
  const res = await app.request('/steps/key', { method: 'POST' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Acme') && html.includes('freelancers.invite'));
  assert.ok(!html.includes('dev@acme.test'), "the key owner's e-mail is not on the page");
  assert.equal(state.load().account?.slug, 'acme');
});

test('GET /api/state returns the stored state as JSON, without the webhook secret', async () => {
  const { app } = appWith((async () => ({})) as Api);
  const res = await app.request('/api/state');
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  assert.deepEqual(await res.json(), defaultState());
  const withSecret = defaultState();
  withSecret.webhook = { channel_id: 'ch1', subscription_id: 'sub1', secret: 'a'.repeat(60) + 'beef', url: 'https://x/webhooks/abillio' };
  const { app: app2 } = appWith((async () => ({})) as Api, memoryState(withSecret));
  const body = await (await app2.request('/api/state')).text();
  assert.ok(!body.includes('a'.repeat(60)), 'the secret never leaves the server');
  assert.ok(body.includes('beef'), 'its last four characters identify it');
  const html = await (await app2.request('/')).text();
  assert.ok(!html.includes('a'.repeat(60)));
});

test('the join page opens the popup from the session url and polls the status', async () => {
  const api = (async (method: string, path: string) => {
    if (method === 'POST' && path === '/onboarding/sessions/') return { session_id: 's1', url: 'https://new.abillio.dev/s/tok', status: 'awaiting_freelancer', purpose: 'onboarding' };
    if (path === '/onboarding/sessions/s1') return { state: 'in_progress', can_be_paid: false, purpose: 'onboarding', requirements: [{ key: 'kyc', state: 'in_progress' }] };
    if (path.startsWith('/engagements/?search=')) return { count: 1, items: [{ id: 'e1', status: 'invited', counterparty: { email: 'anna@example.com', servicing_company: { slug: 'abillio-ks' } }, compliance: { can_be_paid: false } }] };
    throw new Error(`${method} ${path}`);
  }) as Api;
  const { app, state } = appWith(api);
  const form = new URLSearchParams({ first_name: 'Anna', last_name: 'Ozola', email: 'anna@example.com', tax_country: 'LV', locale: 'lv' });
  const created = await app.request('/join', { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { session_id: 's1', url: 'https://new.abillio.dev/s/tok', origin: 'https://new.abillio.dev' });
  assert.equal(state.load().freelancer?.session_id, 's1');
  const status = await app.request('/join/status');
  const body = await status.json();
  assert.equal(body.state, 'in_progress');
  assert.equal(body.engagement_id, 'e1');
  assert.equal(state.load().freelancer?.engagement_id, 'e1');
  const back = await app.request('/back');
  assert.ok((await back.text()).includes('close this window'));
});

test('the join page rejects a malformed e-mail before calling Abillio', async () => {
  let called = false;
  const { app } = appWith((async () => { called = true; return {}; }) as Api);
  const res = await app.request('/join', { method: 'POST', body: new URLSearchParams({ first_name: 'A', last_name: 'B', email: 'nope', tax_country: 'LV', locale: 'lv' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 422);
  assert.equal(called, false);
});
