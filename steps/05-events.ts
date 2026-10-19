// Step 5 — hearing from Abillio. With a public URL the sample registers a
// webhook channel (secret generated here, never returned by Abillio) and a
// subscription naming every engagement event; without one it polls the
// same reads the earlier steps make and reports what changed.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Api } from '../lib/abillio.ts';
import { idempotencyKeyFor, type Keyed, type State, type Store, type StoredEvent } from '../lib/store.ts';
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

// Connecting is up to three calls, and each answer is stored as it comes, so
// a press after a partial failure carries on where the last one stopped:
// - the channel. What its POST sends (the destination and a secret generated
//   here) is stored before the first call and re-sent as it is: under a kept
//   key another secret or destination would be another request, which
//   Abillio refuses for good (409). A refusal in Abillio's envelope clears it
//   with the key, so the next press is a new attempt;
// - a move, when the channel points elsewhere (the tunnel restarted on a new
//   URL). A move is an event, not a state: a settled one spends its key
//   (`once`), so going back to an earlier URL moves the channel again instead
//   of replaying the first move;
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
      'webhook:channel',
      () => api<{ id: string }>('POST', '/accounts/notifications/channels/', { name: 'gateway-example', kind: 'webhook', destination: request.url, secret: request.secret, is_enabled: true }, { idempotencyKey: idempotencyKeyFor(state, 'webhook:channel') }),
      { onRefused: s => { s.webhook_request = null; } },
    );
    const created = { channel_id: channel.id, subscription_id: null, secret: request.secret, url: request.url };
    webhook = store.update(s => { s.webhook ??= created; }).webhook ?? created;
  }
  if (webhook.url !== url) {
    const { channel_id, secret: current } = webhook;
    const action = `webhook:patch:${url}`;
    await keyed(state, action, () => api('PATCH', `/accounts/notifications/channels/${encodeURIComponent(channel_id)}`, { destination: url, secret: current }, { idempotencyKey: idempotencyKeyFor(state, action) }), { once: true });
    webhook = store.update(s => { if (s.webhook?.channel_id === channel_id) s.webhook.url = url; }).webhook ?? { ...webhook, url };
  }
  if (!webhook.subscription_id) {
    const { channel_id } = webhook;
    const subscription = await keyed(state, 'webhook:subscription', () => api<{ id: string }>('POST', '/accounts/notifications/subscriptions/', { name: 'gateway-example', channel_uuids: [channel_id], event_types: SUBSCRIBED_EVENTS }, { idempotencyKey: idempotencyKeyFor(state, 'webhook:subscription') }));
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

// The same reads the steps make, compared with what the state remembers.
// Each change is reported under the name the webhook would have used, so the
// page reads the same with or without a public URL. A payout status no
// webhook announces (approved, or pending again after a return) is reported
// as `poll.payout.status_changed`, the sample's own name, so it never passes
// for an event Abillio sends. Each read stands alone: one that fails is
// logged, and the others still report what they found.
export async function pollForEvents(api: Api, state: State): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  const now = () => new Date().toISOString();
  const f = state.freelancer;
  if (!f) return out;
  const tryRead = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (err) {
      console.warn(`poll: ${what} failed:`, (err as Error).message);
      return null;
    }
  };
  const seen = (type: string, marker: string) => state.events.some(e => e.via === 'poll' && e.event_type === type && e.dedupe_key === marker);
  const session = await tryRead('the session read', () => api<{ state: string; can_be_paid: boolean }>('GET', `/onboarding/sessions/${encodeURIComponent(f.session_id)}`));
  if (session?.can_be_paid && !seen('engagement.onboarding.completed', f.session_id)) {
    out.push({ received_at: now(), event_type: 'engagement.onboarding.completed', data: { session_id: f.session_id, can_be_paid: true, purpose: 'onboarding' }, via: 'poll', dedupe_key: f.session_id });
  }
  const engagementId = f.engagement_id;
  const invoice = state.invoice;
  if (engagementId && invoice) {
    const read = await tryRead('the invoice read', () => readInvoice(api, invoice.id));
    if (read && read.status !== invoice.status) {
      const type = read.status === 'paid' ? 'engagement.invoice.paid' : 'engagement.invoice.status_changed';
      out.push({ received_at: now(), event_type: type, data: { invoice_uuid: invoice.id, old_status: invoice.status, new_status: read.status }, via: 'poll', dedupe_key: `${invoice.id}:${read.status}` });
      invoice.status = read.status;
    }
  }
  const payout = state.payout;
  if (engagementId && payout) {
    const read = await tryRead('the payout read', () => readPayout(api, engagementId, payout.id));
    if (read && read.status !== payout.status) {
      const type = read.status === 'paid' ? 'engagement.payout.completed' : read.status === 'processing' ? 'engagement.payout.processing' : read.status === 'rejected' ? 'engagement.payout.failed' : 'poll.payout.status_changed';
      out.push({ received_at: now(), event_type: type, data: { payout_uuid: payout.id, status: read.status }, via: 'poll', dedupe_key: `${payout.id}:${read.status}` });
      payout.status = read.status;
    }
  }
  state.events.push(...out);
  return out;
}
