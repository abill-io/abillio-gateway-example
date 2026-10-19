import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.ts';
import { Trace } from '../lib/trace.ts';
import { defaultState, type State } from '../lib/store.ts';
import { AbillioError, type Api } from '../lib/abillio.ts';

export function memoryState(initial: State = defaultState()) {
  let current = initial;
  return { load: () => current, update: (fn: (s: State) => void) => { fn(current); return current; } };
}

// Like data/state.json: every load() is a fresh copy, so a key minted on the
// copy a route loaded is lost unless that route's update() writes it back.
// memoryState hands out one shared object and cannot show that.
export function fileLikeState(initial: State = defaultState()) {
  let saved = structuredClone(initial);
  return {
    load: () => structuredClone(saved),
    update: (fn: (s: State) => void) => { const next = structuredClone(saved); fn(next); saved = next; return structuredClone(next); },
  };
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

test('a resubmitted /join reuses the key after a success or a network failure, and mints a new one after an Abillio error', async () => {
  const keys: (string | undefined)[] = [];
  const session = { session_id: 's1', url: 'https://new.abillio.dev/s/tok', status: 'awaiting_freelancer', purpose: 'onboarding' };
  const outcomes: (() => unknown)[] = [
    () => { throw new TypeError('fetch failed'); },
    () => { throw new AbillioError(409, { error: { code: 'requirements_complete', message: 'Nothing left to complete.' } }, ''); },
    () => session,
    () => session,
  ];
  const api = (async (_m: string, _p: string, _b: unknown, opts?: { idempotencyKey?: string }) => {
    keys.push(opts?.idempotencyKey);
    return outcomes[keys.length - 1]();
  }) as Api;
  const { app } = appWith(api, fileLikeState());
  const press = async () => (await app.request('/join', { method: 'POST', body: new URLSearchParams({ first_name: 'Anna', last_name: 'Ozola', email: 'Anna@Example.com', tax_country: 'LV', locale: 'lv' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status;
  assert.deepEqual([await press(), await press(), await press(), await press()], [502, 502, 200, 200]);
  assert.equal(keys[1], keys[0], 'a network failure leaves the outcome unknown: the next press reuses the key');
  assert.notEqual(keys[2], keys[1], 'Abillio answered with an error: the next press is a new attempt');
  assert.equal(keys[3], keys[2], 'after a success a repeated press replays');
});

test('POST /steps/issue drafts and issues in one go and shows a 409 as blockers', async () => {
  let issueCalls = 0;
  const api = (async (method: string, path: string) => {
    if (path === '/accounts/clients/') return { items: [{ id: 'c-self', name: 'Acme', company_account_id: 'a1' }] };
    if (method === 'POST' && path === '/engagements/e1/invoices/') return { id: 'inv-1', invoice_number: 'A-1', status: 'draft', public_url: 'u', amounts: { total: { amount: '100.00', currency: 'EUR' } } };
    if (path === '/engagements/e1/invoices/inv-1/issue') {
      issueCalls += 1;
      const { AbillioError } = await import('../lib/abillio.ts');
      throw new AbillioError(409, { error: { code: 'kyc_missing', message: 'Identity not verified', blockers: [{ code: 'kyc_missing', message: 'Identity not verified', capability: 'send_invoice' }] } }, '');
    }
    throw new Error(`${method} ${path}`);
  }) as Api;
  const initial = defaultState();
  initial.account = { id: 'a1', name: 'Acme', slug: 'acme' };
  initial.freelancer = { email: 'anna@example.com', session_id: 's1', session_url: 'https://new.abillio.dev/s/t', engagement_id: 'e1', servicing_company_slug: 'abillio-ks' };
  const { app, state } = appWith(api, memoryState(initial));
  const res = await app.request('/steps/issue', { method: 'POST', body: new URLSearchParams({ description: 'Tutoring', unit_price: '100.00', currency_code: 'EUR' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const html = await res.text();
  assert.ok(html.includes('kyc_missing') && html.includes('Identity not verified'));
  assert.equal(state.load().invoice?.status, 'draft', 'the draft is kept so a retry only issues');
  assert.equal(issueCalls, 1);
});

test('a 409 on the issue keeps the draft and its key: the next press issues it and a repeated press replays both calls — one invoice', async () => {
  // Abillio as the route meets it: a draft key it has seen answers with that
  // invoice again, a new key creates another; the issue answers 409 with
  // blockers until the freelancer can be paid.
  const draftKeys: string[] = [];
  const issueKeys: string[] = [];
  const invoiceForKey = new Map<string, string>();
  let payable = false;
  const out = (id: string, status: string) => ({ id, invoice_number: id.toUpperCase(), status, public_url: `https://new.abillio.dev/invoice/${id}`, amounts: { total: { amount: '100.00', currency: 'EUR' } } });
  const api = (async (method: string, path: string, _body: unknown, opts?: { idempotencyKey?: string }) => {
    const key = opts?.idempotencyKey ?? '';
    if (path === '/accounts/clients/') return { items: [{ id: 'c-self', name: 'Acme', company_account_id: 'a1' }] };
    if (method === 'POST' && path === '/engagements/e1/invoices/') {
      draftKeys.push(key);
      if (!invoiceForKey.has(key)) invoiceForKey.set(key, `inv-${invoiceForKey.size + 1}`);
      return out(invoiceForKey.get(key)!, 'draft');
    }
    const issue = /^\/engagements\/e1\/invoices\/([^/]+)\/issue$/.exec(path);
    if (method === 'POST' && issue) {
      issueKeys.push(key);
      if (!payable) throw new AbillioError(409, { error: { code: 'kyc_missing', message: 'Identity not verified', blockers: [{ code: 'kyc_missing', message: 'Identity not verified', capability: 'send_invoice' }] } }, '');
      return out(issue[1], 'approved');
    }
    throw new Error(`${method} ${path}`);
  }) as Api;
  const initial = defaultState();
  initial.account = { id: 'a1', name: 'Acme', slug: 'acme' };
  initial.freelancer = { email: 'anna@example.com', session_id: 's1', session_url: 'https://new.abillio.dev/s/t', engagement_id: 'e1', servicing_company_slug: 'abillio-ks' };
  // fileLikeState, like state.json: the draft this press stores never reaches
  // the copy the route loaded.
  const { app, state } = appWith(api, fileLikeState(initial));
  const press = async () => (await app.request('/steps/issue', { method: 'POST', body: new URLSearchParams({ description: 'Tutoring', unit_price: '100.00', currency_code: 'EUR' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).text();
  assert.ok((await press()).includes('kyc_missing'), 'not payable yet: the draft is made, the issue answers the blockers');
  payable = true;
  await press();
  await press();
  assert.equal(draftKeys.length, 2, 'the second press issues the stored draft without drafting again');
  assert.equal(draftKeys[1], draftKeys[0], 'the repeated press replays the first draft instead of making a second invoice');
  assert.deepEqual(state.load().invoice, { id: 'inv-1', number: 'INV-1', status: 'approved', public_url: 'https://new.abillio.dev/invoice/inv-1' });
  assert.notEqual(issueKeys[1], issueKeys[0], 'the 409 spent the first issue key: the next press is a new attempt');
  assert.equal(issueKeys[2], issueKeys[1], 'after the success a repeated press replays the issue');
});

test('a network failure or a 5xx keeps the key the failed call carried: the next press replays that call', async () => {
  const cases: { call: 'draft' | 'issue'; fail: () => never }[] = [
    { call: 'draft', fail: () => { throw new TypeError('fetch failed'); } },
    { call: 'issue', fail: () => { throw new AbillioError(503, null, 'upstream unavailable'); } },
  ];
  const out = (status: string) => ({ id: 'inv-1', invoice_number: 'A-1', status, public_url: 'u', amounts: { total: { amount: '100.00', currency: 'EUR' } } });
  for (const { call, fail } of cases) {
    const keys: string[] = [];
    const api = (async (method: string, path: string, _body: unknown, opts?: { idempotencyKey?: string }) => {
      if (path === '/accounts/clients/') return { items: [{ id: 'c-self', name: 'Acme', company_account_id: 'a1' }] };
      const which =method === 'POST' && path === '/engagements/e1/invoices/' ? 'draft' : method === 'POST' && path === '/engagements/e1/invoices/inv-1/issue' ? 'issue' : null;
      if (!which) throw new Error(`${method} ${path}`);
      if (which === call) {
        keys.push(opts?.idempotencyKey ?? '');
        if (keys.length === 1) fail();
      }
      return out(which === 'issue' ? 'approved' : 'draft');
    }) as Api;
    const initial = defaultState();
    initial.account = { id: 'a1', name: 'Acme', slug: 'acme' };
    initial.freelancer = { email: 'anna@example.com', session_id: 's1', session_url: 'https://new.abillio.dev/s/t', engagement_id: 'e1', servicing_company_slug: 'abillio-ks' };
    const { app, state } = appWith(api, fileLikeState(initial));
    const press = () => app.request('/steps/issue', { method: 'POST', body: new URLSearchParams({ description: 'Tutoring', unit_price: '100.00', currency_code: 'EUR' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    await press();
    await press();
    assert.equal(keys.length, 2, `${call}: called once per press`);
    assert.equal(keys[1], keys[0], `${call}: the outcome is unknown, so the next press sends the same key and replays it if it landed`);
    assert.equal(state.load().invoice?.status, 'approved', `${call}: the retry completes`);
  }
});
