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
  assert.equal(state.load().account?.slug, 'acme');
});

test('GET /api/state returns the stored state as JSON', async () => {
  const { app } = appWith((async () => ({})) as Api);
  const res = await app.request('/api/state');
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  assert.deepEqual(await res.json(), defaultState());
});
