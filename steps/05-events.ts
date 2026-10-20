// Step 5 — hearing from Abillio. With a public URL the sample registers a
// webhook channel (secret generated here, never returned by Abillio) and a
// subscription naming every engagement event; without one it polls the
// same reads the earlier steps make and reports what changed.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Api } from '../lib/abillio.ts';
import { idempotencyKeyFor, type Keyed, type State, type Store, type StoredEvent } from '../lib/store.ts';
import { readSession } from './02-onboard.ts';
import { readInvoice, readPayout } from './04-pay.ts';

export const SUBSCRIBED_EVENTS = [
  'engagement.onboarding.started',
  'engagement.onboarding.completed',
  'engagement.kyc.updated',
  'engagement.requirements_updated',
  'engagement.commission.accepted',
  'engagement.commission.credited',
  'engagement.commission.reversed',
  'engagement.invoice.confirmed',
  'engagement.invoice.status_changed',
  'engagement.invoice.paid',
  'engagement.payout.processing',
  'engagement.payout.completed',
  'engagement.payout.failed',
  'bulk_invoice.completed',
];

// The stored actions the two keyed POSTs of a connect live under. Start over
// (server.ts) keeps their keys with the webhook, so a request still pending
// replays under its own key.
export const WEBHOOK_ACTIONS = { channel: 'webhook:channel', subscription: 'webhook:subscription' } as const;

// Connecting is up to three calls, and each answer is stored as it comes, so
// a press after a partial failure carries on where the last one stopped:
// - the channel. What its POST sends (the destination and a secret generated
//   here) is stored before the first call and re-sent as it is: under a kept
//   key another secret or destination would be another request, which
//   Abillio refuses for good (409). A refusal in Abillio's envelope clears it
//   with the key, so the next press is a new attempt;
// - a move, when the channel points elsewhere (the tunnel restarted on a new
//   URL). A PATCH that sets the destination comes out the same however often
//   it is sent, so each press sends it under a fresh key, like the test
//   delivery: there is nothing to replay, and going back to an earlier URL
//   always moves the channel;
// - the subscription naming every event, for the stored channel.
export async function connectWebhooks(api: Api, keyed: Keyed, store: Store, publicUrl: string, secret: string = randomBytes(32).toString('hex')): Promise<void> {
  const state = store.load();
  const url = `${publicUrl}/webhooks/abillio`;
  let webhook = state.webhook;
  if (!webhook) {
    const fresh = { url, secret };
    const request = store.update(s => { s.webhook_request ??= fresh; }).webhook_request ?? fresh;
    const channel = await keyed(
      state,
      WEBHOOK_ACTIONS.channel,
      () => api<{ id: string }>('POST', '/accounts/notifications/channels/', { name: 'gateway-example', kind: 'webhook', destination: request.url, secret: request.secret, is_enabled: true }, { idempotencyKey: idempotencyKeyFor(state, WEBHOOK_ACTIONS.channel) }),
      { onRefused: s => { s.webhook_request = null; } },
    );
    const created = { channel_id: channel.id, subscription_id: null, secret: request.secret, url: request.url };
    webhook = store.update(s => { s.webhook ??= created; }).webhook ?? created;
  }
  if (webhook.url !== url) {
    const { channel_id, secret: current } = webhook;
    await api('PATCH', `/accounts/notifications/channels/${encodeURIComponent(channel_id)}`, { destination: url, secret: current }, { idempotencyKey: randomUUID() });
    webhook = store.update(s => { if (s.webhook?.channel_id === channel_id) s.webhook.url = url; }).webhook ?? { ...webhook, url };
  }
  if (!webhook.subscription_id) {
    const { channel_id } = webhook;
    const subscription = await keyed(state, WEBHOOK_ACTIONS.subscription, () => api<{ id: string }>('POST', '/accounts/notifications/subscriptions/', { name: 'gateway-example', channel_uuids: [channel_id], event_types: SUBSCRIBED_EVENTS }, { idempotencyKey: idempotencyKeyFor(state, WEBHOOK_ACTIONS.subscription) }));
    store.update(s => {
      if (s.webhook?.channel_id !== channel_id) return;
      s.webhook.subscription_id = subscription.id;
      // Complete: the stored request has done its job.
      s.webhook_request = null;
    });
  }
}

export async function sendTestDelivery(api: Api, channelId: string): Promise<void> {
  // A new key each time: every press is a new test delivery on purpose.
  await api('POST', `/accounts/notifications/channels/${encodeURIComponent(channelId)}/test`, undefined, { idempotencyKey: randomUUID() });
}

export type RowChange = { kind: 'invoice' | 'payout'; id: string; from: string; to: string };
export type PollResult = { events: StoredEvent[]; changes: RowChange[] };

// Whether an event is about the walk the state holds: it names the stored
// session, engagement, invoice or payout. Not every verified delivery is: a
// reset re-creates Abillio's demo freelancers through the real flows, so the
// subscription also hears their invoice events (guide §13), and a walk left
// behind (another freelancer joined, a Start over) still has events on the
// way. Those are stored like any other, but they are not this walk's.
export function aboutThisWalk(state: State, event: StoredEvent): boolean {
  const ours: [string, string | null | undefined][] = [
    ['session_id', state.freelancer?.session_id],
    ['engagement_id', state.freelancer?.engagement_id],
    ['invoice_uuid', state.invoice?.id],
    ['payout_uuid', state.payout?.id],
  ];
  return ours.some(([key, id]) => Boolean(id) && event.data[key] === id);
}

// The webhook's name for a payout's move, as the backend announces it: a
// return (a paid or processing payout back at pending) is
// `engagement.payout.failed` with status pending. A move no webhook announces
// (to approved, say) gets the sample's own name, so it never passes for an
// event Abillio sends.
function payoutEventName(from: string, to: string): string {
  if (to === 'paid') return 'engagement.payout.completed';
  if (to === 'processing') return 'engagement.payout.processing';
  if (to === 'rejected') return 'engagement.payout.failed';
  if (to === 'pending' && (from === 'paid' || from === 'processing')) return 'engagement.payout.failed';
  return 'poll.payout.status_changed';
}

// The same reads the steps make, compared with what the state remembers. The
// poll writes nothing: it returns the events, named as the webhook names them
// so the page reads the same with or without a public URL, and each row's
// status change, for the caller to record (`recordPoll`). A draft invoice is
// the issue route's, which alone turns it into an issued one and stores its
// number, so the poll leaves it alone. Each read stands alone: one that
// fails is logged once, and the others still report what they found.
export async function pollForEvents(api: Api, state: State, now: () => number = Date.now): Promise<PollResult> {
  const found: PollResult = { events: [], changes: [] };
  const f = state.freelancer;
  if (!f) return found;
  const event = (event_type: string, data: Record<string, unknown>, dedupe_key: string): StoredEvent => ({ received_at: new Date(now()).toISOString(), event_type, data, via: 'poll', dedupe_key });
  const tryRead = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (err) {
      console.warn(`poll: ${what} failed:`, (err as Error).message);
      return null;
    }
  };
  // The session is read until its completion is recorded, by a poll or by a
  // webhook (both carry the session id), and not at all for a freelancer
  // stored without one.
  const completed = state.events.some(e => e.event_type === 'engagement.onboarding.completed' && e.data.session_id === f.session_id);
  if (f.session_id && !completed) {
    const session = await tryRead('the session read', () => readSession(api, f.session_id));
    if (session?.can_be_paid) found.events.push(event('engagement.onboarding.completed', { session_id: f.session_id, can_be_paid: true, purpose: 'onboarding' }, f.session_id));
  }
  const engagementId = f.engagement_id;
  const invoice = state.invoice;
  if (engagementId && invoice && invoice.status !== 'draft') {
    const read = await tryRead('the invoice read', () => readInvoice(api, invoice.id));
    if (read && read.status !== invoice.status) {
      found.events.push(event(read.status === 'paid' ? 'engagement.invoice.paid' : 'engagement.invoice.status_changed', { invoice_uuid: invoice.id, old_status: invoice.status, new_status: read.status }, `${invoice.id}:${read.status}`));
      found.changes.push({ kind: 'invoice', id: invoice.id, from: invoice.status, to: read.status });
    }
  }
  const payout = state.payout;
  if (engagementId && payout) {
    const read = await tryRead('the payout read', () => readPayout(api, engagementId, payout.id));
    if (read && read.status !== payout.status) {
      found.events.push(event(payoutEventName(payout.status, read.status), { payout_uuid: payout.id, status: read.status }, `${payout.id}:${read.status}`));
      found.changes.push({ kind: 'payout', id: payout.id, from: payout.status, to: read.status });
    }
  }
  return found;
}

// What a poll found, written onto the state as it is now, which may have
// moved on while the reads were out (an issue, a payment, a simulation, a
// start over). A row takes only its new status, and only while it is still
// the row the poll compared, at the status it compared from: the issue
// route's guard on its draft, the same pattern. The rest of a row (the number
// an issue stored) is the routes' to write. Events are appended once each by
// their dedupe key; an event without one is never a copy, so it is always
// appended. Answers what was written, for the caller to say so (or not).
export function recordPoll(s: State, found: PollResult): PollResult {
  const written: PollResult = { events: [], changes: [] };
  for (const change of found.changes) {
    const row = change.kind === 'invoice' ? s.invoice : s.payout;
    if (row?.id !== change.id || row.status !== change.from) continue;
    row.status = change.to;
    written.changes.push(change);
  }
  for (const e of found.events) {
    if (!e.dedupe_key || !s.events.some(x => x.dedupe_key === e.dedupe_key)) {
      s.events.push(e);
      written.events.push(e);
    }
  }
  return written;
}
