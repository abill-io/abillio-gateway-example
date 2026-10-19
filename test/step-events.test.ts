import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUBSCRIBED_EVENTS, connectWebhooks, pollForEvents, recordPoll, sendTestDelivery } from '../steps/05-events.ts';
import { AbillioError, type Api } from '../lib/abillio.ts';
import { defaultState, idempotencyKeyFor, type Keyed, type State, type StoredEvent } from '../lib/store.ts';
import { memoryState } from './helpers.ts';

// The step tests check the calls and their keys; the claim-before-call and
// forget-on-verified-failure behaviour of the real keyed() is server.ts's and
// is covered there.
const passThrough: Keyed = (state, action, call) => { idempotencyKeyFor(state, action); return call(); };

test('the subscription lists every engagement event the guide names', () => {
  for (const e of ['engagement.onboarding.started', 'engagement.onboarding.completed', 'engagement.kyc.updated', 'engagement.requirements_updated', 'engagement.commission.accepted', 'engagement.commission.credited', 'engagement.commission.reversed', 'engagement.invoice.confirmed', 'engagement.invoice.status_changed', 'engagement.invoice.paid', 'engagement.payout.processing', 'engagement.payout.completed', 'engagement.payout.failed', 'bulk_invoice.completed']) {
    assert.ok(SUBSCRIBED_EVENTS.includes(e), e);
  }
});

test('connectWebhooks creates a channel with a 64-hex secret and a subscription; a second call with a new url patches the channel', async () => {
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const api = (async (method: string, path: string, body: Record<string, unknown>) => {
    calls.push({ method, path, body });
    if (path === '/accounts/notifications/channels/') return { id: 'ch1' };
    if (path === '/accounts/notifications/subscriptions/') return { id: 'sub1' };
    if (path === '/accounts/notifications/channels/ch1') return { id: 'ch1' };
    if (method === 'POST' && path === '/accounts/notifications/channels/ch1/test') return { success: true };
    throw new Error(path);
  }) as Api;
  const store = memoryState();
  await connectWebhooks(api, passThrough, store, 'https://a.trycloudflare.com');
  const first = store.load().webhook!;
  assert.match(first.secret, /^[0-9a-f]{64}$/);
  assert.equal(first.url, 'https://a.trycloudflare.com/webhooks/abillio');
  assert.equal(calls[0].body.kind, 'webhook');
  assert.equal(calls[0].body.secret, first.secret);
  assert.deepEqual(calls[1].body.channel_uuids, ['ch1']);
  assert.deepEqual(calls[1].body.event_types, SUBSCRIBED_EVENTS);
  await connectWebhooks(api, passThrough, store, 'https://b.trycloudflare.com');
  assert.equal(store.load().webhook?.channel_id, 'ch1');
  assert.equal(calls.at(-1)?.method, 'PATCH');
  assert.equal(calls.at(-1)?.body.destination, 'https://b.trycloudflare.com/webhooks/abillio');
  await sendTestDelivery(api, 'ch1');
});

test('pollForEvents reports what changed since the stored state, named like the real events', async () => {
  const state = defaultState();
  state.freelancer = { email: 'anna@example.com', session_id: 's1', session_url: 'https://new.abillio.dev/s/t', engagement_id: 'e1', servicing_company_slug: 'abillio-ks' };
  state.invoice = { id: 'inv-1', number: 'A-1', status: 'approved', public_url: 'u' };
  state.payout = { id: 'p1', status: 'pending' };
  const api = (async (_m: string, path: string) => {
    if (path === '/onboarding/sessions/s1') return { state: 'complete', can_be_paid: true, purpose: 'onboarding', requirements: [] };
    if (path === '/accounts/invoices/inv-1/') return { id: 'inv-1', status: 'paid' };
    if (path === '/engagements/e1/payouts/p1') return { id: 'p1', status: 'paid' };
    throw new Error(path);
  }) as Api;
  const clock = () => Date.UTC(2026, 9, 19, 12);
  const found = await pollForEvents(api, state, clock);
  assert.deepEqual(found.events.map(e => e.event_type), ['engagement.onboarding.completed', 'engagement.invoice.paid', 'engagement.payout.completed']);
  assert.ok(found.events.every(e => e.via === 'poll' && e.received_at === '2026-10-19T12:00:00.000Z'), 'received at the injected clock');
  assert.deepEqual(found.changes, [{ kind: 'invoice', id: 'inv-1', from: 'approved', to: 'paid' }, { kind: 'payout', id: 'p1', from: 'pending', to: 'paid' }]);
  assert.equal(state.invoice.status, 'approved', "the poll reports a change; writing it is the caller's");
  recordPoll(state, found);
  const again = await pollForEvents(api, state, clock);
  assert.deepEqual(again, { events: [], changes: [] }, 'nothing changed since the first poll was recorded, so nothing is reported');
});

// A freelancer with an approved invoice and a pending payout; Abillio answers
// that the session is complete and both were paid, unless `answers` says
// otherwise for a path.
function polled(answers: Record<string, () => unknown> = {}) {
  const state = defaultState();
  state.freelancer = { email: 'anna@example.com', session_id: 's1', session_url: 'https://new.abillio.dev/s/t', engagement_id: 'e1', servicing_company_slug: 'abillio-ks' };
  state.invoice = { id: 'inv-1', number: 'A-1', status: 'approved', public_url: 'u' };
  state.payout = { id: 'p1', status: 'pending' };
  const reads: Record<string, () => unknown> = {
    '/onboarding/sessions/s1': () => ({ state: 'complete', can_be_paid: true, purpose: 'onboarding', requirements: [] }),
    '/accounts/invoices/inv-1/': () => ({ id: 'inv-1', status: 'paid' }),
    '/engagements/e1/payouts/p1': () => ({ id: 'p1', status: 'paid' }),
    ...answers,
  };
  const api = (async (_m: string, path: string) => {
    const read = reads[path];
    if (!read) throw new Error(path);
    return read();
  }) as Api;
  return { state, api };
}

test('the session is read until its completion is recorded, by a poll or by a webhook, and never without a session id', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const completed = (via: StoredEvent['via']): StoredEvent => ({
    received_at: '2026-10-19T12:00:00.000Z', event_type: 'engagement.onboarding.completed', via,
    data: { session_id: 's1', can_be_paid: true, purpose: 'onboarding' },
    dedupe_key: via === 'poll' ? 's1' : 'engagement.onboarding.completed:0f1e',
  });
  const cases: [string, (s: State) => void][] = [
    ['recorded by a poll', s => { s.events.push(completed('poll')); }],
    ['recorded by a webhook', s => { s.events.push(completed('webhook')); }],
    // A freelancer stored by hand, without a session: GET /onboarding/sessions/ is a 405.
    ['no session id', s => { s.freelancer!.session_id = ''; }],
  ];
  for (const [label, prepare] of cases) {
    const { state, api } = polled();
    prepare(state);
    const reads: string[] = [];
    const counting = (async (method: 'GET', path: string) => { reads.push(path); return api(method, path); }) as Api;
    await pollForEvents(counting, state);
    assert.deepEqual(reads, ['/accounts/invoices/inv-1/', '/engagements/e1/payouts/p1'], label);
  }
  assert.equal(warn.mock.callCount(), 0, 'nothing was read that could fail');
});

test('a read that fails is logged once and the poll still reports what the other two found', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const all = ['engagement.onboarding.completed', 'engagement.invoice.paid', 'engagement.payout.completed'];
  for (const [i, failing] of ['/onboarding/sessions/s1', '/accounts/invoices/inv-1/', '/engagements/e1/payouts/p1'].entries()) {
    warn.mock.resetCalls();
    const { state, api } = polled({ [failing]: () => { throw new AbillioError(405, { detail: 'Method not allowed' }, ''); } });
    const found = await pollForEvents(api, state);
    assert.deepEqual(found.events.map(e => e.event_type), all.filter((_, j) => j !== i), `${failing} failed`);
    assert.equal(warn.mock.callCount(), 1, `${failing}: one warning`);
  }
});

test("a payout change is named as the webhook names it, a return included; one no webhook announces gets the sample's own poll. name", async () => {
  const table = [
    ['pending', 'paid', 'engagement.payout.completed'],
    ['pending', 'processing', 'engagement.payout.processing'],
    ['pending', 'rejected', 'engagement.payout.failed'],
    ['paid', 'pending', 'engagement.payout.failed'],
    ['processing', 'pending', 'engagement.payout.failed'],
    ['pending', 'approved', 'poll.payout.status_changed'],
  ];
  for (const [from, to, name] of table) {
    const { state, api } = polled({ '/engagements/e1/payouts/p1': () => ({ id: 'p1', status: to }) });
    state.payout = { id: 'p1', status: from };
    const found = await pollForEvents(api, state);
    assert.equal(found.events.at(-1)?.event_type, name, `${from} → ${to}`);
  }
});

test('recordPoll appends an event that carries no dedupe key, even when a stored one has none either', () => {
  // A key-less event is never a copy of another: two of them must not
  // compare equal on their missing keys.
  const keyless = (event_type: string): StoredEvent => ({ received_at: '2026-10-19T12:00:00.000Z', event_type, data: {}, via: 'poll' });
  const state = defaultState();
  state.events.push(keyless('engagement.invoice.paid'));
  assert.equal(recordPoll(state, { events: [keyless('engagement.payout.completed')], changes: [] }), true);
  assert.deepEqual(state.events.map(e => e.event_type), ['engagement.invoice.paid', 'engagement.payout.completed']);
});
