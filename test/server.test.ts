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

test('a resubmitted /join reuses the key after a success, a network failure or a bare 409, and mints a new one after an enveloped refusal', async () => {
  const keys: (string | undefined)[] = [];
  const session = { session_id: 's1', url: 'https://new.abillio.dev/s/tok', status: 'awaiting_freelancer', purpose: 'onboarding' };
  const outcomes: (() => unknown)[] = [
    () => { throw new TypeError('fetch failed'); },
    () => { throw new AbillioError(409, { detail: 'A request with this idempotency key is still in progress.' }, ''); },
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
  assert.deepEqual([await press(), await press(), await press(), await press(), await press()], [502, 502, 502, 200, 200]);
  assert.equal(keys[1], keys[0], 'a network failure leaves the outcome unknown: the next press reuses the key');
  assert.equal(keys[2], keys[1], 'so does a bare 409 from the idempotency layer: the key is held by an earlier request');
  assert.notEqual(keys[3], keys[2], 'Abillio refused in its own envelope: the next press is a new attempt');
  assert.equal(keys[4], keys[3], 'after a success a repeated press replays');
});

test('/join writes back only its own key, so a key another press stored meanwhile survives', async () => {
  const store = fileLikeState();
  const api = (async () => {
    // Another tab's press lands while the onboarding call is in flight.
    store.update(s => { s.idempotency['draft:e9'] = 'another-press'; });
    return { session_id: 's1', url: 'https://new.abillio.dev/s/tok', status: 'awaiting_freelancer', purpose: 'onboarding' };
  }) as Api;
  const { app, state } = appWith(api, store);
  const res = await app.request('/join', { method: 'POST', body: new URLSearchParams({ first_name: 'Anna', last_name: 'Ozola', email: 'anna@example.com', tax_country: 'LV', locale: 'lv' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 200);
  assert.equal(state.load().idempotency['draft:e9'], 'another-press');
});

// --- Step 3 -------------------------------------------------------------------

type App = ReturnType<typeof appWith>['app'];
type Call = { method: string; path: string; body: unknown; key: string };

// A freelancer who joined (engagement e1) on account a1: what the issue route needs.
function joinedState(): State {
  const s = defaultState();
  s.account = { id: 'a1', name: 'Acme', slug: 'acme' };
  s.freelancer = { email: 'anna@example.com', session_id: 's1', session_url: 'https://new.abillio.dev/s/t', engagement_id: 'e1', servicing_company_slug: 'abillio-ks' };
  return s;
}

const kycMissing = () => new AbillioError(409, { error: { code: 'kyc_missing', message: 'Identity not verified', blockers: [{ code: 'kyc_missing', message: 'Identity not verified', capability: 'send_invoice' }] } }, '');

// Abillio as the issue route meets it, idempotency included: a draft key it
// has seen answers with that draft again, a new key drafts another invoice;
// an issue answers `pending`, as staging does for a self-client invoice.
// `answer` may take over any call first (throw to fail it).
function fakeIssueApi(answer: (call: Call) => unknown = () => undefined) {
  const calls: Call[] = [];
  const draftForKey = new Map<string, string>();
  const out = (id: string, status: string) => ({ id, invoice_number: id.toUpperCase(), status, public_url: `https://new.abillio.dev/invoice/${id}`, amounts: { total: { amount: '121.00', currency: 'EUR' } } });
  const api = (async (method: string, path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
    const call = { method, path, body, key: opts?.idempotencyKey ?? '' };
    calls.push(call);
    const taken = await answer(call);
    if (taken !== undefined) return taken;
    if (method === 'GET' && path === '/accounts/clients/?limit=100') return { count: 1, items: [{ id: 'c-self', name: 'Acme', company_account_id: 'a1' }] };
    if (method === 'POST' && path === '/engagements/e1/invoices/') {
      if (!draftForKey.has(call.key)) draftForKey.set(call.key, `inv-${draftForKey.size + 1}`);
      return out(draftForKey.get(call.key)!, 'draft');
    }
    const issue = /^\/engagements\/e1\/invoices\/([^/]+)\/issue$/.exec(path);
    if (method === 'POST' && issue) return out(issue[1], 'pending');
    throw new Error(`unexpected ${method} ${path}`);
  }) as Api;
  return {
    api,
    calls,
    drafts: () => calls.filter(c => c.method === 'POST' && c.path === '/engagements/e1/invoices/'),
    issues: () => calls.filter(c => c.method === 'POST' && c.path.endsWith('/issue')),
  };
}

function pressIssue(app: App, form: Record<string, string> = { description: 'Tutoring, October', unit_price: '100.00', currency_code: 'EUR' }) {
  return app.request('/steps/issue', { method: 'POST', body: new URLSearchParams(form), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
}

test('POST /steps/issue drafts and issues in one go and shows a 409 as blockers', async () => {
  const abillio = fakeIssueApi(call => { if (call.path.endsWith('/issue')) throw kycMissing(); });
  const { app, state } = appWith(abillio.api, memoryState(joinedState()));
  const html = await (await pressIssue(app)).text();
  assert.ok(html.includes('<ul class="blockers"><li><code>kyc_missing</code> Identity not verified <small>(send_invoice)</small></li></ul>'), 'every blocker is a row of the checklist, with whose side it is on');
  assert.equal(state.load().invoice?.status, 'draft', 'the draft is kept so a retry only issues');
  assert.equal(abillio.issues().length, 1);
});

test('one draft per engagement: after a 409 the next press issues the stored draft, and a press after issuing repeats only the issue call', async () => {
  let payable = false;
  const abillio = fakeIssueApi(call => { if (call.path.endsWith('/issue') && !payable) throw kycMissing(); });
  // fileLikeState, like state.json: what a press stores never reaches the
  // copy that press loaded.
  const { app, state } = appWith(abillio.api, fileLikeState(joinedState()));
  assert.ok((await (await pressIssue(app)).text()).includes('kyc_missing'), 'not payable yet: the draft is made, the issue answers the blockers');
  payable = true;
  await pressIssue(app);
  assert.equal(state.load().invoice?.status, 'pending');
  // What a later step's read-back would store; a replayed answer must not undo it.
  state.update(s => { if (s.invoice) s.invoice.status = 'paid'; });
  await pressIssue(app, { description: 'Edited', unit_price: '90.00', currency_code: 'EUR' });
  assert.equal(abillio.drafts().length, 1, 'never drafted again, whatever the form says');
  const keys = abillio.issues().map(c => c.key);
  assert.equal(keys.length, 3);
  assert.notEqual(keys[1], keys[0], 'the 409 spent the first issue key: the next press is a new attempt');
  assert.equal(keys[2], keys[1], 'the press after issuing repeats the issue under its key, so Abillio replays it');
  assert.deepEqual(state.load().invoice, { id: 'inv-1', number: 'INV-1', status: 'paid', public_url: 'https://new.abillio.dev/invoice/inv-1' }, 'the replayed answer is not written over what is stored');
});

test('after a failed keyed call the next press keeps the key while the outcome is unknown, re-sending the stored request byte for byte', async () => {
  const cases: { name: string; call: 'draft' | 'issue'; failure: () => Error; kept: boolean }[] = [
    { name: 'network failure on the draft', call: 'draft', failure: () => new TypeError('fetch failed'), kept: true },
    { name: 'bare 409 on the draft', call: 'draft', failure: () => new AbillioError(409, { detail: 'A request with this idempotency key is still in progress.' }, ''), kept: true },
    { name: '503 on the issue', call: 'issue', failure: () => new AbillioError(503, null, 'upstream unavailable'), kept: true },
    { name: 'enveloped 422 on the draft', call: 'draft', failure: () => new AbillioError(422, { error: { code: 'validation_failed', message: 'Validation failed' } }, ''), kept: false },
  ];
  for (const { name, call, failure, kept } of cases) {
    let failed = false;
    const abillio = fakeIssueApi(c => {
      const isTheCall = c.method === 'POST' && (call === 'issue' ? c.path.endsWith('/issue') : c.path === '/engagements/e1/invoices/');
      if (isTheCall && !failed) { failed = true; throw failure(); }
    });
    let now = Date.parse('2026-10-19T10:00:00Z');
    const { app, state } = appWith(abillio.api, fileLikeState(joinedState()), null, () => {}, () => now);
    await pressIssue(app);
    // The retry comes a day later, with the form edited.
    now += 86_400_000;
    await pressIssue(app, { description: 'Edited', unit_price: '90.00', currency_code: 'EUR' });
    const tried = call === 'issue' ? abillio.issues() : abillio.drafts();
    assert.equal(tried.length, 2, name);
    if (kept) {
      assert.equal(tried[1].key, tried[0].key, `${name}: the outcome is unknown, so the same key goes again`);
      assert.deepEqual(tried[1].body, tried[0].body, `${name}: with the same bytes, whatever the day or the form`);
    } else {
      assert.notEqual(tried[1].key, tried[0].key, `${name}: refused for certain, so the next press is a new attempt`);
      assert.equal((tried[1].body as { items: { description: string }[] }).items[0].description, 'Edited', `${name}: built from the form as it is now`);
    }
    assert.equal(state.load().invoice?.status, 'pending', `${name}: the retry completes`);
  }
});

test('a refused GET of the clients touches no stored key: Abillio saw no keyed call in that press', async () => {
  const abillio = fakeIssueApi(call => { if (call.method === 'GET') throw new AbillioError(429, { error: { code: 'rate_limited', message: 'Too many requests' } }, ''); });
  const initial = joinedState();
  initial.invoice_request = { engagement_id: 'e1', description: 'Tutoring, October', unit_price: '100.00', currency_code: 'EUR', issued_date: '2026-10-19', due_date: '2026-11-02' };
  initial.idempotency = { 'draft:e1': 'kept-after-a-network-failure', 'onboard:anna@example.com': 'k-onboard' };
  const { app, state } = appWith(abillio.api, fileLikeState(initial));
  assert.ok((await (await pressIssue(app)).text()).includes('rate_limited'));
  assert.deepEqual(state.load().idempotency, initial.idempotency);
  assert.deepEqual(state.load().invoice_request, initial.invoice_request, 'and the request still waits to be re-sent');
  assert.equal(abillio.calls.filter(c => c.method === 'POST').length, 0);
});

test('two overlapping presses send the same key: the first claims it in the store before its call goes out', async () => {
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let sent = () => {};
  const firstDraftSent = new Promise<void>(resolve => { sent = resolve; });
  const abillio = fakeIssueApi(async call => {
    if (call.path === '/engagements/e1/invoices/' && abillio.drafts().length === 1) { sent(); await held; }
  });
  const { app, state } = appWith(abillio.api, fileLikeState(joinedState()));
  const first = pressIssue(app);
  await firstDraftSent;
  await pressIssue(app);
  release();
  await first;
  const keys = abillio.drafts().map(c => c.key);
  assert.equal(keys.length, 2);
  assert.equal(keys[1], keys[0], 'the second press found the key the first one claimed, so Abillio holds both to one draft');
  assert.equal(state.load().invoice?.id, 'inv-1');
});
