import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../server.ts';
import { Trace } from '../lib/trace.ts';
import { defaultState, type State } from '../lib/store.ts';
import { AbillioError, type Api } from '../lib/abillio.ts';
import { fileLikeState, memoryState, sandboxState } from './helpers.ts';

export function appWith(api: Api, state = memoryState(), publicUrl: string | null = null, onStored: () => void = () => {}, now: () => number = Date.now, pollIntervalMs: number | null = null, allowProduction = false) {
  const trace = new Trace();
  const app = createApp({ api, state, trace, publicUrl, port: 4000, abillioOrigin: () => 'https://new.abillio.dev', onStored, now, pollIntervalMs, allowProduction });
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
  assert.deepEqual(state.load().account, { id: 'a1', name: 'Acme', slug: 'acme', is_sandbox: true }, 'with whether it is a sandbox, which every write route asks');
});

test('GET /api/state returns the stored state as JSON, without the webhook secret', async () => {
  const { app } = appWith((async () => ({})) as Api);
  const res = await app.request('/api/state');
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  assert.deepEqual(await res.json(), defaultState());
  const withSecret = defaultState();
  withSecret.webhook = { channel_id: 'ch1', subscription_id: 'sub1', secret: 'a'.repeat(60) + 'beef', url: 'https://x/webhooks/abillio' };
  withSecret.webhook_request = { url: 'https://x/webhooks/abillio', secret: 'c'.repeat(60) + 'f00d' };
  const { app: app2 } = appWith((async () => ({})) as Api, memoryState(withSecret));
  const body = await (await app2.request('/api/state')).text();
  assert.ok(!body.includes('a'.repeat(60)), 'the secret never leaves the server');
  assert.ok(!body.includes('c'.repeat(60)), "nor does a pending channel request's");
  assert.ok(body.includes('beef') && body.includes('f00d'), 'their last four characters identify them');
  const html = await (await app2.request('/')).text();
  assert.ok(!html.includes('a'.repeat(60)) && !html.includes('c'.repeat(60)));
});

test('the join page opens the popup from the session url and polls the status', async () => {
  const api = (async (method: string, path: string) => {
    if (method === 'POST' && path === '/onboarding/sessions/') return { session_id: 's1', url: 'https://new.abillio.dev/s/tok', status: 'awaiting_freelancer', purpose: 'onboarding' };
    if (path === '/onboarding/sessions/s1') return { state: 'in_progress', can_be_paid: false, purpose: 'onboarding', requirements: [{ key: 'kyc', state: 'in_progress' }] };
    if (path.startsWith('/engagements/?search=')) return { count: 1, items: [{ id: 'e1', status: 'invited', counterparty: { email: 'anna@example.com', servicing_company: { slug: 'abillio-ks' } }, compliance: { can_be_paid: false } }] };
    throw new Error(`${method} ${path}`);
  }) as Api;
  const { app, state } = appWith(api, memoryState(sandboxState()));
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
  const { app } = appWith((async () => { called = true; return {}; }) as Api, memoryState(sandboxState()));
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
  const { app } = appWith(api, fileLikeState(sandboxState()));
  const press = async () => (await app.request('/join', { method: 'POST', body: new URLSearchParams({ first_name: 'Anna', last_name: 'Ozola', email: 'Anna@Example.com', tax_country: 'LV', locale: 'lv' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status;
  assert.deepEqual([await press(), await press(), await press(), await press(), await press()], [502, 502, 502, 200, 200]);
  assert.equal(keys[1], keys[0], 'a network failure leaves the outcome unknown: the next press reuses the key');
  assert.equal(keys[2], keys[1], 'so does a bare 409 from the idempotency layer: the key is held by an earlier request');
  assert.notEqual(keys[3], keys[2], 'Abillio refused in its own envelope: the next press is a new attempt');
  assert.equal(keys[4], keys[3], 'after a success a repeated press replays');
});

test('/join writes back only its own key, so a key another press stored meanwhile survives', async () => {
  const store = fileLikeState(sandboxState());
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

test('a changed /join form is a new attempt: the key follows the exact body, so only an identical retry replays', async () => {
  const keys: string[] = [];
  const api = (async (_m: string, _p: string, _b: unknown, opts?: { idempotencyKey?: string }) => {
    keys.push(opts?.idempotencyKey ?? '');
    return { session_id: 's1', url: 'https://new.abillio.dev/s/tok', status: 'awaiting_freelancer', purpose: 'onboarding' };
  }) as Api;
  const { app } = appWith(api, fileLikeState(sandboxState()));
  const join = (locale: string) => app.request('/join', { method: 'POST', body: new URLSearchParams({ first_name: 'Anna', last_name: 'Ozola', email: 'anna@example.com', tax_country: 'LV', locale }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  await join('lv');
  await join('lv');
  await join('en');
  assert.equal(keys[1], keys[0], 'the same form: the same body under the same key');
  assert.notEqual(keys[2], keys[1], 'another locale: another body, so a new attempt with a new key');
});

// --- Step 3 -------------------------------------------------------------------

type App = ReturnType<typeof appWith>['app'];
type Call = { method: string; path: string; body: unknown; key: string };

// A freelancer who joined (engagement e1) on account a1: what the issue route needs.
function joinedState(): State {
  const s = sandboxState();
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

test('re-joining with the same e-mail keeps steps 3 and 4; a different engagement found later starts them over', async () => {
  const sessionFor: Record<string, string> = { 'anna@example.com': 's2', 'ben@example.com': 's3' };
  const api = (async (method: string, path: string, body: unknown) => {
    if (method === 'POST' && path === '/onboarding/sessions/') {
      const id = sessionFor[(body as { email: string }).email.toLowerCase()];
      return { session_id: id, url: `https://new.abillio.dev/s/${id}`, status: 'awaiting_freelancer', purpose: 'onboarding' };
    }
    if (method === 'GET' && path.startsWith('/onboarding/sessions/')) return { state: 'in_progress', can_be_paid: false, purpose: 'onboarding', requirements: [] };
    if (method === 'GET' && path === '/engagements/?search=ben%40example.com') return { count: 1, items: [{ id: 'e2', status: 'invited', counterparty: { email: 'ben@example.com', servicing_company: { slug: 'abillio-ks' } }, compliance: { can_be_paid: false } }] };
    throw new Error(`unexpected ${method} ${path}`);
  }) as Api;
  const initial = joinedState();
  initial.invoice = { id: 'inv-1', number: 'INV-1', status: 'pending', public_url: 'https://new.abillio.dev/invoice/inv-1' };
  initial.invoice_request = { engagement_id: 'e1', description: 'Tutoring, October', unit_price: '100.00', currency_code: 'EUR', issued_date: '2026-10-19', due_date: '2026-11-02' };
  initial.payout = { id: 'p1', status: 'pending' };
  const { app, state } = appWith(api, fileLikeState(initial));
  const join = (email: string) => app.request('/join', { method: 'POST', body: new URLSearchParams({ first_name: 'Anna', last_name: 'Ozola', email, tax_country: 'LV', locale: 'lv' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const steps34 = () => { const s = state.load(); return { invoice: s.invoice, invoice_request: s.invoice_request, payout: s.payout }; };
  const before = steps34();
  assert.equal((await join('Anna@Example.com')).status, 200);
  await app.request('/join/status');
  assert.equal(state.load().freelancer?.session_id, 's2', 'a new session for the same freelancer');
  assert.equal(state.load().freelancer?.engagement_id, 'e1', 'on the same engagement');
  assert.deepEqual(steps34(), before, 'steps 3 and 4 stay as they were');
  assert.equal((await join('ben@example.com')).status, 200);
  await app.request('/join/status');
  assert.equal(state.load().freelancer?.engagement_id, 'e2');
  assert.deepEqual(steps34(), { invoice: null, invoice_request: null, payout: null }, 'another engagement starts steps 3 and 4 over');
});

test('with nothing pending, an empty description or unit price is refused before any call', async () => {
  const abillio = fakeIssueApi();
  const { app, state } = appWith(abillio.api, fileLikeState(joinedState()));
  const forms: Record<string, string>[] = [{ description: ' ', unit_price: '100.00', currency_code: 'EUR' }, { description: 'Tutoring', unit_price: '', currency_code: 'EUR' }, {}];
  for (const form of forms) {
    assert.ok((await (await pressIssue(app, form)).text()).includes('Fill in the description and the unit price'), JSON.stringify(form));
  }
  assert.equal(abillio.calls.length, 0);
  assert.equal(state.load().invoice_request, null);
});

test("a stored request for another engagement is not re-sent: the press drafts the joined freelancer's form", async () => {
  const abillio = fakeIssueApi();
  const initial = joinedState();
  initial.invoice_request = { engagement_id: 'e0', description: 'The previous freelancer', unit_price: '10.00', currency_code: 'EUR', issued_date: '2026-10-01', due_date: '2026-10-15' };
  const { app, state } = appWith(abillio.api, fileLikeState(initial));
  await pressIssue(app);
  const drafts = abillio.drafts();
  assert.equal(drafts.length, 1, 'drafted on e1, not on the stale request\'s e0');
  assert.equal((drafts[0].body as { items: { description: string }[] }).items[0].description, 'Tutoring, October');
  assert.equal(state.load().invoice_request?.engagement_id, 'e1');
});

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
  const edited = { description: 'Edited', unit_price: '90.00', currency_code: 'EUR' };
  // `retry` is the second press's form: an edited one, or none at all, which
  // is what the Retry button sends (its fields sit in a disabled fieldset).
  const cases: { name: string; call: 'draft' | 'issue'; failure: () => Error; kept: boolean; retry: Record<string, string> }[] = [
    { name: 'network failure on the draft', call: 'draft', failure: () => new TypeError('fetch failed'), kept: true, retry: edited },
    { name: 'bare 409 on the draft', call: 'draft', failure: () => new AbillioError(409, { detail: 'A request with this idempotency key is still in progress.' }, ''), kept: true, retry: {} },
    { name: '503 on the issue', call: 'issue', failure: () => new AbillioError(503, null, 'upstream unavailable'), kept: true, retry: edited },
    { name: 'enveloped 422 on the draft', call: 'draft', failure: () => new AbillioError(422, { error: { code: 'validation_failed', message: 'Validation failed' } }, ''), kept: false, retry: edited },
  ];
  for (const { name, call, failure, kept, retry } of cases) {
    let failed = false;
    const abillio = fakeIssueApi(c => {
      const isTheCall = c.method === 'POST' && (call === 'issue' ? c.path.endsWith('/issue') : c.path === '/engagements/e1/invoices/');
      if (isTheCall && !failed) { failed = true; throw failure(); }
    });
    let now = Date.parse('2026-10-19T10:00:00Z');
    const { app, state } = appWith(abillio.api, fileLikeState(joinedState()), null, () => {}, () => now);
    await pressIssue(app);
    // The retry comes a day later.
    now += 86_400_000;
    await pressIssue(app, retry);
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

test('two overlapping presses send one request under one key, whichever got further first', async () => {
  // The first press is held at its draft call (it has stored its request and
  // claimed the key) or at the clients read (it has stored nothing yet); the
  // second press, with another form, runs to the end meanwhile.
  for (const holdAt of ['draft', 'clients read'] as const) {
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let reached = () => {};
    const firstHeld = new Promise<void>(resolve => { reached = resolve; });
    let seen = 0;
    const abillio = fakeIssueApi(async call => {
      const isHeldCall = holdAt === 'draft' ? call.method === 'POST' && call.path === '/engagements/e1/invoices/' : call.method === 'GET';
      if (isHeldCall && ++seen === 1) { reached(); await held; }
    });
    const { app, state } = appWith(abillio.api, fileLikeState(joinedState()));
    const first = pressIssue(app);
    await firstHeld;
    await pressIssue(app, { description: 'Edited', unit_price: '90.00', currency_code: 'EUR' });
    release();
    await first;
    const drafts = abillio.drafts();
    assert.equal(drafts.length, 2, holdAt);
    assert.equal(drafts[1].key, drafts[0].key, `${holdAt}: the key claimed first serves both presses`);
    assert.deepEqual(drafts[1].body, drafts[0].body, `${holdAt}: and so does the request stored first`);
    assert.deepEqual({ id: state.load().invoice?.id, status: state.load().invoice?.status }, { id: 'inv-1', status: 'pending' }, holdAt);
  }
});

test('a refusal forgets only the key its own call sent: a key and a request another press stored meanwhile stay', async () => {
  const store = fileLikeState(joinedState());
  const theirs = { engagement_id: 'e1', description: 'Their press', unit_price: '50.00', currency_code: 'EUR', issued_date: '2026-10-19', due_date: '2026-11-02' };
  const abillio = fakeIssueApi(call => {
    if (call.method !== 'POST') return;
    // While this call is out, another press claims the action afresh and stores its own request.
    store.update(s => { s.idempotency['draft:e1'] = 'their-key'; s.invoice_request = theirs; });
    throw new AbillioError(422, { error: { code: 'validation_failed', message: 'Validation failed' } }, '');
  });
  const { app, state } = appWith(abillio.api, store);
  await pressIssue(app);
  assert.equal(state.load().idempotency['draft:e1'], 'their-key');
  assert.deepEqual(state.load().invoice_request, theirs);
});

// --- Step 4 -------------------------------------------------------------------

function pressSimulate(app: App, outcome: string) {
  return app.request('/steps/pay/simulate', { method: 'POST', body: new URLSearchParams({ outcome }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
}

// joinedState() with invoice inv-1 issued and, once Abillio made one, its payout.
function issuedState(status = 'pending', payout: State['payout'] = null): State {
  const s = joinedState();
  s.invoice = { id: 'inv-1', number: 'INV-1', status, public_url: 'https://new.abillio.dev/invoice/inv-1' };
  s.payout = payout;
  return s;
}

test('the pay routes fund, pay and settle, storing the payout', async () => {
  const deposits: { body: unknown; key: string }[] = [];
  const api = (async (method: string, path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
    if (path === '/accounts/wallet/sandbox/simulate-deposit') { deposits.push({ body, key: opts?.idempotencyKey ?? '' }); return [{ company_slug: 'abillio-services-ou', available: { amount: '250.00' } }]; }
    if (path === '/accounts/wallet/pay-invoice/') return { created: true, operation_id: 'op-1' };
    if (path === '/engagements/e1/payouts/?invoice_uuid=inv-1') return { items: [{ id: 'p1', status: 'pending', invoice_uuid: 'inv-1' }] };
    if (path === '/engagements/e1/payouts/p1/sandbox/simulate') return { id: 'p1', status: 'paid' };
    if (path === '/engagements/e1/payouts/p1') return { id: 'p1', status: 'paid' };
    if (path === '/accounts/invoices/inv-1/') return { id: 'inv-1', invoice_number: 'A-1', status: 'paid', public_url: 'u' };
    throw new Error(`${method} ${path}`);
  }) as Api;
  const initial = sandboxState();
  // Served by the Estonian company, not the default one: the deposit has to land on the freelancer's.
  initial.freelancer = { email: 'anna@example.com', session_id: 's1', session_url: 'https://new.abillio.dev/s/t', engagement_id: 'e1', servicing_company_slug: 'abillio-services-ou' };
  initial.invoice = { id: 'inv-1', number: 'A-1', status: 'approved', public_url: 'u' };
  const { app, state } = appWith(api, memoryState(initial));
  const fund = () => app.request('/steps/pay/fund', { method: 'POST', body: new URLSearchParams({ amount: '250.00' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal((await fund()).status, 200);
  assert.equal((await fund()).status, 200);
  const sent = { amount: '250.00', currency: 'EUR', company: 'abillio-services-ou' };
  assert.deepEqual(deposits.map(d => d.body), [sent, sent], 'the amount, in EUR, on the company serving the freelancer');
  assert.notEqual(deposits[1].key, deposits[0].key, 'a deposit is a new event every press, so each carries a fresh key');
  assert.equal((await app.request('/steps/pay/pay', { method: 'POST' })).status, 200);
  assert.equal(state.load().invoice?.status, 'paid', 'the invoice is read back after paying');
  assert.equal(state.load().payout?.status, 'pending');
  assert.equal((await pressSimulate(app, 'paid')).status, 200);
  assert.equal(state.load().payout?.status, 'paid');
});

test('Pay keeps its key until Abillio refuses the payment itself: a lost answer, a refused lookup after paying and a repeated press all replay', async () => {
  const keys: string[] = [];
  const outcomes: (() => unknown)[] = [
    () => { throw new AbillioError(409, { error: { code: 'insufficient_balance', message: 'Insufficient balance' } }, ''); },
    () => { throw new TypeError('fetch failed'); },
    () => ({ created: true, operation_id: 'op-1' }),
    () => ({ created: true, operation_id: 'op-1' }),
  ];
  const api = (async (method: string, path: string, _b: unknown, opts?: { idempotencyKey?: string }) => {
    if (method === 'POST' && path === '/accounts/wallet/pay-invoice/') { keys.push(opts?.idempotencyKey ?? ''); return outcomes[keys.length - 1](); }
    if (path === '/engagements/e1/payouts/?invoice_uuid=inv-1') {
      // Right after the payment that went through, the lookup is refused in
      // Abillio's envelope: a verified 4xx, but of a read, not of the payment.
      if (keys.length === 3) throw new AbillioError(429, { error: { code: 'rate_limited', message: 'Too many requests' } }, '');
      return { items: [{ id: 'p1', status: 'pending', invoice_uuid: 'inv-1' }] };
    }
    if (path === '/accounts/invoices/inv-1/') return { id: 'inv-1', status: 'paid' };
    throw new Error(`unexpected ${method} ${path}`);
  }) as Api;
  // fileLikeState, like state.json: a key minted on the copy a press loaded is
  // lost unless the route stores it.
  const { app, state } = appWith(api, fileLikeState(issuedState()));
  const press = async () => (await app.request('/steps/pay/pay', { method: 'POST' })).text();
  assert.ok((await press()).includes('insufficient_balance'), 'the refusal is shown as is');
  await press();
  assert.ok((await press()).includes('rate_limited'), 'so is the refused lookup');
  assert.equal(state.load().invoice?.status, 'pending', 'nothing was read back, so Pay is still offered');
  await press();
  assert.equal(keys.length, 4);
  assert.notEqual(keys[1], keys[0], 'refused in its envelope: nothing was paid, so the next press is a new attempt');
  assert.equal(keys[2], keys[1], 'no answer: the payment may have gone through, so the retry sends the same key');
  assert.equal(keys[3], keys[2], 'paid, and only the lookup was refused: the next press replays the payment, never a second one');
  assert.deepEqual({ status: state.load().invoice?.status, payout: state.load().payout }, { status: 'paid', payout: { id: 'p1', status: 'pending' } }, 'and reads both back');
});

test('a simulation is an event: a settled press spends its key, a lost answer keeps it, and what is stored is a fresh read', async () => {
  const sent: { outcome: string; key: string }[] = [];
  let payoutStatus = 'pending';
  const api = (async (method: string, path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
    if (method === 'POST' && path === '/engagements/e1/payouts/p1/sandbox/simulate') {
      const { outcome } = body as { outcome: string };
      sent.push({ outcome, key: opts?.idempotencyKey ?? '' });
      payoutStatus = outcome === 'returned' ? 'pending' : outcome;
      // The first answer is lost on the way back, though the payout moved.
      if (sent.length === 1) throw new TypeError('fetch failed');
      // An answer can be a replay, older than the payout: it is never what gets stored.
      return { id: 'p1', status: 'processing' };
    }
    if (method === 'GET' && path === '/engagements/e1/payouts/p1') return { id: 'p1', status: payoutStatus };
    throw new Error(`unexpected ${method} ${path}`);
  }) as Api;
  const { app, state } = appWith(api, fileLikeState(issuedState('paid', { id: 'p1', status: 'pending' })));
  // paid (no answer), paid again (the retry), returned (the payout reopens), paid.
  for (const outcome of ['paid', 'paid', 'returned', 'paid']) await pressSimulate(app, outcome);
  assert.equal(sent.length, 4);
  assert.equal(sent[1].key, sent[0].key, 'no answer: the outcome is unknown, so the retry sends the same key');
  assert.notEqual(sent[3].key, sent[1].key, 'a settled simulation spends its key: paid after returned is played again, not replayed');
  assert.deepEqual(Object.keys(state.load().idempotency).filter(action => action.startsWith('simulate:')), [], 'no simulate key outlives its answer');
  assert.deepEqual(state.load().payout, { id: 'p1', status: 'paid' }, 'what is stored is the read-back, not the answer');
});

test('the pay and simulate answers are written only while the invoice and payout they acted on are still stored', async () => {
  const store = fileLikeState(issuedState());
  const api = (async (method: string, path: string) => {
    // While the call is out, another freelancer is found: /join/status starts steps 3 and 4 over.
    if (method === 'POST') store.update(s => { s.invoice = null; s.invoice_request = null; s.payout = null; });
    if (path === '/accounts/wallet/pay-invoice/') return { created: true, operation_id: 'op-1' };
    if (path === '/engagements/e1/payouts/?invoice_uuid=inv-1') return { items: [{ id: 'p1', status: 'pending', invoice_uuid: 'inv-1' }] };
    if (path === '/accounts/invoices/inv-1/') return { id: 'inv-1', status: 'paid' };
    if (path === '/engagements/e1/payouts/p1/sandbox/simulate') return { id: 'p1', status: 'paid' };
    if (path === '/engagements/e1/payouts/p1') return { id: 'p1', status: 'paid' };
    throw new Error(`unexpected ${method} ${path}`);
  }) as Api;
  const { app, state } = appWith(api, store);
  await app.request('/steps/pay/pay', { method: 'POST' });
  assert.equal(state.load().payout, null, "the previous invoice's payout is not stored for the next freelancer");
  store.update(s => { s.invoice = issuedState('paid').invoice; s.payout = { id: 'p1', status: 'pending' }; });
  await pressSimulate(app, 'paid');
  assert.equal(state.load().payout, null, "nor is the previous payout's read");
});

// --- Step 5 -------------------------------------------------------------------

test('the webhook receiver stores a correctly signed delivery once, refuses a bad one, and marks the page for refresh', async () => {
  const v = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')).webhook;
  const initial = defaultState();
  initial.webhook = { channel_id: 'ch1', subscription_id: 'sub1', secret: v.secret, url: 'https://x/webhooks/abillio' };
  const stored: string[] = [];
  const { app, state } = appWith((async () => ({})) as Api, memoryState(initial), 'https://x', () => stored.push('refresh'), () => Number(v.timestamp) * 1000 + 1000);
  const deliver = (sig: string, timestamp: string = v.timestamp) => app.request('/webhooks/abillio', { method: 'POST', body: v.body, headers: { 'content-type': 'application/json', 'x-timestamp': timestamp, 'x-signature': sig } });
  assert.equal((await deliver(v.signature_header)).status, 200);
  assert.equal((await deliver(v.signature_header)).status, 200, 'a retry is answered 200');
  assert.equal(state.load().events.length, 1, 'but stored once');
  assert.equal(state.load().events[0].event_type, 'engagement.invoice.paid');
  assert.equal((await deliver('t=1,v1=00')).status, 401);
  assert.equal((await deliver(v.signature_header, String(Number(v.timestamp) - 400))).status, 400, 'a delivery older than 300 s is refused before its signature is checked');
  assert.equal(state.load().events.length, 1);
  assert.equal(stored.length, 1);
});

test('without a PUBLIC_URL there is no connect button, a connect press explains why and calls nothing, and the receiver answers 503', async () => {
  let calls = 0;
  const { app } = appWith((async () => { calls++; return {}; }) as Api, memoryState(sandboxState()));
  const html = await (await app.request('/')).text();
  assert.ok(html.includes('PUBLIC_URL') && !html.includes('Connect webhooks'));
  assert.ok((await (await app.request('/steps/events/connect', { method: 'POST' })).text()).includes('Set PUBLIC_URL (npm run tunnel prints how) and restart to receive webhooks.'));
  assert.equal(calls, 0);
  const refused = await app.request('/webhooks/abillio', { method: 'POST', body: '{}' });
  assert.equal(refused.status, 503);
  assert.equal(await refused.text(), 'webhooks not connected: set PUBLIC_URL and press Connect');
});

test('a form POST from another origin is refused; one from this origin is not, nor is a JSON delivery that carries a foreign Origin', async () => {
  const { app } = appWith((async () => ({})) as Api);
  const foreign = await app.request('http://localhost:4000/steps/key', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(foreign.status, 403);
  const own = await app.request('http://localhost:4000/steps/key', { method: 'POST', headers: { origin: 'http://localhost:4000', 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.notEqual(own.status, 403);
  const delivery = await app.request('http://localhost:4000/webhooks/abillio', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(delivery.status, 503, 'a JSON body is not a form: the guard leaves it to the receiver, which judges it by its signature');
});

test('what a delivery says is escaped on the page: neither its event type nor its payload can add markup', async () => {
  const initial = defaultState();
  initial.events = [{ received_at: '2026-10-19T10:00:00.000Z', event_type: '<script>alert(1)</script>', data: { note: '<img src=x onerror=alert(2)>' }, via: 'webhook', dedupe_key: 'k' }];
  const html = await (await appWith((async () => ({})) as Api, memoryState(initial)).app.request('/')).text();
  assert.ok(!html.includes('<script>alert(1)') && !html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('two copies of a delivery that arrive together are stored once, and the page is told once', async () => {
  const v = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')).webhook;
  const initial = defaultState();
  initial.webhook = { channel_id: 'ch1', subscription_id: 'sub1', secret: v.secret, url: 'https://x/webhooks/abillio' };
  const told: string[] = [];
  // fileLikeState: each request reads its own copy, as two requests read state.json.
  const { app, state } = appWith((async () => ({})) as Api, fileLikeState(initial), 'https://x', () => told.push('refresh'), () => Number(v.timestamp) * 1000 + 1000);
  const deliver = () => app.request('/webhooks/abillio', { method: 'POST', body: v.body, headers: { 'content-type': 'application/json', 'x-timestamp': v.timestamp, 'x-signature': v.signature_header } });
  const answers = await Promise.all([deliver(), deliver()]);
  assert.deepEqual(answers.map(r => r.status), [200, 200]);
  assert.equal(state.load().events.length, 1);
  assert.equal(told.length, 1);
});

type NotificationCall = { method: string; path: string; body: string; key: string };

// Abillio's notification endpoints as the connect press meets them, recording
// each call's exact body and key; `answer` may take over any call first
// (throw to fail it).
function fakeNotificationsApi(answer: (call: NotificationCall) => unknown = () => undefined) {
  const calls: NotificationCall[] = [];
  const api = (async (method: string, path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
    const call = { method, path, body: JSON.stringify(body ?? null), key: opts?.idempotencyKey ?? '' };
    calls.push(call);
    const taken = await answer(call);
    if (taken !== undefined) return taken;
    if (method === 'POST' && path === '/accounts/notifications/channels/') return { id: 'ch1' };
    if (method === 'POST' && path === '/accounts/notifications/subscriptions/') return { id: 'sub1' };
    if (method === 'PATCH' && path === '/accounts/notifications/channels/ch1') return { id: 'ch1' };
    throw new Error(`unexpected ${method} ${path}`);
  }) as Api;
  return {
    api,
    channels: () => calls.filter(c => c.method === 'POST' && c.path === '/accounts/notifications/channels/'),
    subscriptions: () => calls.filter(c => c.method === 'POST' && c.path === '/accounts/notifications/subscriptions/'),
    moves: () => calls.filter(c => c.method === 'PATCH'),
  };
}

function pressConnect(app: App) {
  return app.request('/steps/events/connect', { method: 'POST' });
}

const A = 'https://a.trycloudflare.com';
const B = 'https://b.trycloudflare.com';

test('a refused subscription keeps the channel stored: the next press creates only the subscription, under a new key, and stores it', async () => {
  let refuse = true;
  const fake = fakeNotificationsApi(call => {
    if (call.path === '/accounts/notifications/subscriptions/' && refuse) { refuse = false; throw new AbillioError(403, { error: { code: 'forbidden', message: 'Not granted' } }, ''); }
  });
  const { app, state } = appWith(fake.api, fileLikeState(sandboxState()), A);
  await pressConnect(app);
  const channel = JSON.parse(fake.channels()[0].body);
  assert.deepEqual(state.load().webhook, { channel_id: 'ch1', subscription_id: null, secret: channel.secret, url: `${A}/webhooks/abillio` }, 'the channel is stored as soon as Abillio answers');
  await pressConnect(app);
  assert.equal(fake.channels().length, 1, 'the channel is not created again');
  const [refused, again] = fake.subscriptions();
  assert.notEqual(again.key, refused.key, 'refused in its envelope: the next press is a new attempt');
  assert.equal(state.load().webhook?.subscription_id, 'sub1');
  assert.equal(state.load().webhook_request, null, 'a complete webhook needs no pending request');
});

test('a lost channel answer: the next press re-sends the stored request byte for byte under the same key, then moves the channel to the new URL', async () => {
  let lose = true;
  const fake = fakeNotificationsApi(call => {
    if (call.path === '/accounts/notifications/channels/' && lose) { lose = false; throw new TypeError('fetch failed'); }
  });
  const store = fileLikeState(sandboxState());
  await pressConnect(appWith(fake.api, store, A).app);
  assert.equal(store.load().webhook, null);
  // The tunnel restarted meanwhile, on another URL.
  await pressConnect(appWith(fake.api, store, B).app);
  const [lost, retry] = fake.channels();
  assert.equal(retry.key, lost.key, 'the outcome is unknown, so the retry sends the same key');
  assert.equal(retry.body, lost.body, 'and the same bytes, secret and destination included: Abillio replays instead of refusing another request');
  assert.deepEqual(fake.moves().map(m => JSON.parse(m.body).destination), [`${B}/webhooks/abillio`], 'then the channel is moved to where this server now answers');
  assert.deepEqual(store.load().webhook, { channel_id: 'ch1', subscription_id: 'sub1', secret: JSON.parse(lost.body).secret, url: `${B}/webhooks/abillio` });
});

test('a channel refused in its envelope: the next press is a new attempt, with a new key and a new request', async () => {
  let refuse = true;
  const fake = fakeNotificationsApi(call => {
    if (call.path === '/accounts/notifications/channels/' && refuse) { refuse = false; throw new AbillioError(422, { error: { code: 'validation_error', message: 'Enter a valid URL.' } }, ''); }
  });
  const { app, state } = appWith(fake.api, fileLikeState(sandboxState()), A);
  await pressConnect(app);
  assert.equal(state.load().webhook_request, null, 'the refused request goes with its key');
  await pressConnect(app);
  const [refused, again] = fake.channels();
  assert.notEqual(again.key, refused.key);
  assert.notEqual(JSON.parse(again.body).secret, JSON.parse(refused.body).secret);
  assert.equal(state.load().webhook?.subscription_id, 'sub1');
});

test('each move is a PATCH under a fresh key, so going back and forth moves the channel every time', async () => {
  const fake = fakeNotificationsApi();
  const connected = sandboxState();
  connected.webhook = { channel_id: 'ch1', subscription_id: 'sub1', secret: 'a'.repeat(64), url: `${A}/webhooks/abillio` };
  const store = fileLikeState(connected);
  for (const url of [B, A, B]) await pressConnect(appWith(fake.api, store, url).app);
  assert.deepEqual(fake.moves().map(m => JSON.parse(m.body).destination), [B, A, B].map(u => `${u}/webhooks/abillio`));
  assert.equal(new Set(fake.moves().map(m => m.key)).size, 3, 'back to B is a new move, not a replay of the first one');
  assert.equal(store.load().webhook?.url, `${B}/webhooks/abillio`);
  assert.deepEqual(Object.keys(store.load().idempotency).filter(action => action.startsWith('webhook:patch:')), []);
});

test('a poll writes back only what it found: an event the store no longer has does not come back from its older copy', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const initial = issuedState('pending', { id: 'p1', status: 'pending' });
  initial.events = [{ received_at: '2026-10-19T10:00:00.000Z', event_type: 'channel.test', data: {}, via: 'webhook', dedupe_key: 'before-the-reset' }];
  const store = fileLikeState(initial);
  const api = (async (_m: string, path: string) => {
    if (path === '/onboarding/sessions/s1') {
      // While the poll is out, the partner starts over: the events and steps 3–4 go.
      store.update(s => { s.events = []; s.invoice = null; s.invoice_request = null; s.payout = null; });
      return { state: 'in_progress', can_be_paid: false, purpose: 'onboarding', requirements: [] };
    }
    if (path === '/accounts/invoices/inv-1/') return { id: 'inv-1', status: 'paid' };
    if (path === '/engagements/e1/payouts/p1') return { id: 'p1', status: 'paid' };
    throw new Error(path);
  }) as Api;
  let told!: () => void;
  const stored = new Promise<void>(resolve => { told = resolve; });
  appWith(api, store, null, () => told(), Date.now, 5000);
  t.mock.timers.tick(5000);
  await stored;
  assert.deepEqual(store.load().events.filter(e => e.dedupe_key === 'before-the-reset'), []);
  assert.deepEqual({ invoice: store.load().invoice, payout: store.load().payout }, { invoice: null, payout: null }, 'nor does a row it read');
});

// A poll tick that lands while the issue call is out, both ways round. The
// draft answers with no number, as staging does; the issue with the real one.
for (const order of ['the tick finishes first', 'the route finishes first'] as const) {
  test(`a poll tick during the issue call never loses the issued number (${order})`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const store = fileLikeState(joinedState());
    const settle = () => new Promise(resolve => setImmediate(resolve));
    let issued = false;
    let openGate!: () => void;
    const gate = new Promise<void>(resolve => { openGate = resolve; });
    const row = (number: string, status: string) => ({ id: 'inv-1', invoice_number: number, status, public_url: 'https://new.abillio.dev/invoice/inv-1', amounts: { total: { amount: '121.00', currency: 'EUR' } } });
    const api = (async (method: string, path: string) => {
      if (method === 'GET' && path === '/accounts/clients/?limit=100') return { count: 1, items: [{ id: 'c-self', name: 'Acme', company_account_id: 'a1' }] };
      if (method === 'POST' && path === '/engagements/e1/invoices/') return row('', 'draft');
      if (method === 'POST' && path === '/engagements/e1/invoices/inv-1/issue') {
        issued = true;
        t.mock.timers.tick(5000); // the tick lands while the issue answer travels back
        if (order === 'the tick finishes first') await settle();
        return row('DEMO-1', 'pending');
      }
      if (path === '/onboarding/sessions/s1') return { state: 'in_progress', can_be_paid: false, purpose: 'onboarding', requirements: [] };
      if (path === '/accounts/invoices/inv-1/') {
        if (order === 'the route finishes first') await gate;
        return { id: 'inv-1', status: issued ? 'pending' : 'draft' };
      }
      throw new Error(`${method} ${path}`);
    }) as Api;
    await pressIssue(appWith(api, store, null, () => {}, Date.now, 5000).app);
    openGate();
    await settle();
    assert.deepEqual({ number: store.load().invoice?.number, status: store.load().invoice?.status }, { number: 'DEMO-1', status: 'pending' });
  });
}

test('a poll never sets back what a route moved on meanwhile: it writes a status only over the one it compared', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = fileLikeState(issuedState('pending', { id: 'p1', status: 'pending' }));
  let told!: () => void;
  const stored = new Promise<void>(resolve => { told = resolve; });
  const api = (async (_m: string, path: string) => {
    if (path === '/onboarding/sessions/s1') return { state: 'in_progress', can_be_paid: false, purpose: 'onboarding', requirements: [] };
    if (path === '/accounts/invoices/inv-1/') return { id: 'inv-1', status: 'paid' };
    if (path === '/engagements/e1/payouts/p1') {
      // While the poll reads, the simulate route stores the payout it settled.
      store.update(s => { s.payout = { id: 'p1', status: 'paid' }; });
      return { id: 'p1', status: 'processing' };
    }
    throw new Error(path);
  }) as Api;
  appWith(api, store, null, () => told(), Date.now, 5000);
  t.mock.timers.tick(5000);
  await stored;
  assert.deepEqual(store.load().payout, { id: 'p1', status: 'paid' }, 'the payout the route settled is not set back to what the poll read');
  assert.equal(store.load().invoice?.status, 'paid', 'the invoice, still where the poll found it, takes the new status');
});

test('one poll tick at a time: a tick that finds the last one still waiting on Abillio skips', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let reads = 0;
  let answer!: () => void;
  const slow = new Promise<void>(resolve => { answer = resolve; });
  const api = (async (_m: string, path: string) => {
    if (path === '/onboarding/sessions/s1') { reads++; await slow; return { state: 'in_progress', can_be_paid: false, purpose: 'onboarding', requirements: [] }; }
    throw new Error(path);
  }) as Api;
  appWith(api, fileLikeState(joinedState()), null, () => {}, Date.now, 5000);
  t.mock.timers.tick(5000);
  t.mock.timers.tick(5000);
  assert.equal(reads, 1, 'the second tick found the first still out');
  answer();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5000);
  assert.equal(reads, 2, 'once it is back, the next tick polls again');
});

// --- Start over ---------------------------------------------------------------

test('POST /reset resets the sandbox and the state but keeps the webhook channel, with its pending request and keys', async () => {
  const initial = sandboxState();
  initial.invoice = { id: 'inv-1', number: 'A-1', status: 'paid', public_url: 'u' };
  // A connect that stopped mid-way: the channel exists on Abillio, the
  // subscription's outcome is unknown, so its request and key wait for a replay.
  initial.webhook = { channel_id: 'ch1', subscription_id: null, secret: 'a'.repeat(64), url: 'https://x/webhooks/abillio' };
  initial.webhook_request = { url: 'https://x/webhooks/abillio', secret: 'a'.repeat(64) };
  initial.idempotency = { 'pay:inv-1': 'k-pay', 'webhook:channel': 'k-channel', 'webhook:subscription': 'k-subscription' };
  let answer: () => Promise<unknown> = async () => { throw new AbillioError(403, { error: { code: 'forbidden', message: 'Not allowed.' } }, ''); };
  const keys: (string | undefined)[] = [];
  const api = (async (method: string, path: string, _body?: unknown, opts?: { idempotencyKey?: string }) => {
    if (method === 'POST' && path === '/accounts/sandbox/reset') { keys.push(opts?.idempotencyKey); return answer(); }
    throw new Error(path);
  }) as Api;
  const { app, state } = appWith(api, fileLikeState(initial));

  const refused = await app.request('/reset', { method: 'POST' });
  assert.equal(refused.status, 200);
  assert.ok((await refused.text()).includes('Not allowed.'), 'the refusal is shown');
  assert.deepEqual(state.load(), initial, 'and the walk is kept: the sandbox still holds it');

  answer = async () => ({ ok: true });
  const res = await app.request('/reset', { method: 'POST' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  assert.equal(keys.length, 2);
  assert.ok(keys[0] && keys[1] && keys[0] !== keys[1], 'each press is a new reset, under a new key');
  const after = state.load();
  assert.equal(after.invoice, null);
  assert.equal(after.account, null);
  assert.deepEqual(after.webhook, initial.webhook, 'the channel still exists on Abillio');
  assert.deepEqual(after.webhook_request, initial.webhook_request);
  assert.deepEqual(after.idempotency, { 'webhook:channel': 'k-channel', 'webhook:subscription': 'k-subscription' }, "the webhook's keys stay with its request, so the next Connect replays instead of subscribing twice");
});

// --- Sandbox only ---------------------------------------------------------------

// Every route that writes to Abillio, with a form that gets it past its own checks.
const WRITE_ROUTES: [string, Record<string, string>][] = [
  ['/join', { first_name: 'Anna', last_name: 'Ozola', email: 'anna@example.com', tax_country: 'LV', locale: 'lv' }],
  ['/steps/issue', { description: 'Tutoring, October', unit_price: '100.00', currency_code: 'EUR' }],
  ['/steps/pay/fund', { amount: '250.00' }],
  ['/steps/pay/pay', {}],
  ['/steps/pay/simulate', { outcome: 'paid' }],
  ['/steps/events/connect', {}],
  ['/steps/events/test', {}],
  ['/reset', {}],
];

test('every route that writes to Abillio runs only on a sandbox account, unless ALLOW_PRODUCTION is set', async () => {
  // A walk far enough along that every route has something to send: a joined
  // freelancer, an issued invoice, its payout, a webhook that points elsewhere.
  const walk = (account: State['account']) => {
    const s = issuedState('pending', { id: 'p1', status: 'pending' });
    s.account = account;
    s.webhook = { channel_id: 'ch1', subscription_id: 'sub1', secret: 'a'.repeat(64), url: 'https://old.example/webhooks/abillio' };
    return s;
  };
  const production = { id: 'a1', name: 'Acme', slug: 'acme', is_sandbox: false };
  const cases: { account: State['account']; allowProduction: boolean; refusal: string | null }[] = [
    { account: production, allowProduction: false, refusal: 'This back office runs against sandbox accounts only (the key belongs to a production account).' },
    { account: null, allowProduction: false, refusal: 'Check the key first (step 1): this back office runs against sandbox accounts only.' },
    { account: production, allowProduction: true, refusal: null },
  ];
  for (const { account, allowProduction, refusal } of cases) {
    for (const [path, form] of WRITE_ROUTES) {
      const calls: string[] = [];
      const api = (async (method: string, p: string) => { calls.push(`${method} ${p}`); throw new Error('stop at the first call'); }) as Api;
      const { app } = appWith(api, fileLikeState(walk(account)), 'https://x', () => {}, Date.now, null, allowProduction);
      const text = await (await app.request(path, { method: 'POST', body: new URLSearchParams(form), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).text();
      if (refusal) {
        assert.ok(text.includes(refusal), `${path} refuses: ${refusal}`);
        assert.deepEqual(calls, [], `${path} sends nothing to Abillio`);
      } else {
        assert.ok(calls.length > 0, `${path} goes on to Abillio with ALLOW_PRODUCTION`);
      }
    }
  }
});
