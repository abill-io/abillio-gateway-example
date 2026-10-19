// Step 5 — hearing from Abillio. With a public URL the sample registers a
// webhook channel (secret generated here, never returned by Abillio) and a
// subscription naming every engagement event; without one it polls the
// same reads the earlier steps make and reports what changed.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Api } from '../lib/abillio.ts';
import { idempotencyKeyFor, type Keyed, type State, type StoredEvent } from '../lib/store.ts';
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

export async function connectWebhooks(api: Api, keyed: Keyed, state: State, publicUrl: string, secret: string = randomBytes(32).toString('hex')) {
  const url = `${publicUrl}/webhooks/abillio`;
  if (state.webhook) {
    if (state.webhook.url !== url) {
      const { channel_id, secret: existing } = state.webhook;
      await keyed(state, `webhook:patch:${url}`, () => api('PATCH', `/accounts/notifications/channels/${encodeURIComponent(channel_id)}`, { destination: url, secret: existing }, { idempotencyKey: idempotencyKeyFor(state, `webhook:patch:${url}`) }));
    }
    return { ...state.webhook, url };
  }
  const channel = await keyed(state, 'webhook:channel', () => api<{ id: string }>('POST', '/accounts/notifications/channels/', { name: 'gateway-example', kind: 'webhook', destination: url, secret, is_enabled: true }, { idempotencyKey: idempotencyKeyFor(state, 'webhook:channel') }));
  const subscription = await keyed(state, 'webhook:subscription', () => api<{ id: string }>('POST', '/accounts/notifications/subscriptions/', { name: 'gateway-example', channel_uuids: [channel.id], event_types: SUBSCRIBED_EVENTS }, { idempotencyKey: idempotencyKeyFor(state, 'webhook:subscription') }));
  return { channel_id: channel.id, subscription_id: subscription.id, secret, url };
}

export async function sendTestDelivery(api: Api, channelId: string): Promise<void> {
  // A new key each time: every press is a new test delivery on purpose.
  await api('POST', `/accounts/notifications/channels/${encodeURIComponent(channelId)}/test`, undefined, { idempotencyKey: randomUUID() });
}

// The same reads the steps make, compared with what the state remembers.
// Each change is reported under the name the webhook would have used, so the
// page reads the same with or without a public URL.
export async function pollForEvents(api: Api, state: State): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  const now = () => new Date().toISOString();
  const f = state.freelancer;
  if (!f) return out;
  const seen = (type: string, marker: string) => state.events.some(e => e.via === 'poll' && e.event_type === type && e.dedupe_key === marker);
  const session = await api<{ state: string; can_be_paid: boolean }>('GET', `/onboarding/sessions/${encodeURIComponent(f.session_id)}`);
  if (session.can_be_paid && !seen('engagement.onboarding.completed', f.session_id)) {
    out.push({ received_at: now(), event_type: 'engagement.onboarding.completed', data: { session_id: f.session_id, can_be_paid: true, purpose: 'onboarding' }, via: 'poll', dedupe_key: f.session_id });
  }
  if (f.engagement_id && state.invoice) {
    const invoice = await readInvoice(api, state.invoice.id);
    if (invoice.status !== state.invoice.status) {
      const type = invoice.status === 'paid' ? 'engagement.invoice.paid' : 'engagement.invoice.status_changed';
      out.push({ received_at: now(), event_type: type, data: { invoice_uuid: state.invoice.id, old_status: state.invoice.status, new_status: invoice.status }, via: 'poll', dedupe_key: `${state.invoice.id}:${invoice.status}` });
      state.invoice.status = invoice.status;
    }
  }
  if (f.engagement_id && state.payout) {
    const payout = await readPayout(api, f.engagement_id, state.payout.id);
    if (payout.status !== state.payout.status) {
      const type = payout.status === 'paid' ? 'engagement.payout.completed' : payout.status === 'processing' ? 'engagement.payout.processing' : payout.status === 'rejected' ? 'engagement.payout.failed' : 'engagement.payout.status_changed';
      out.push({ received_at: now(), event_type: type, data: { payout_uuid: state.payout.id, status: payout.status }, via: 'poll', dedupe_key: `${state.payout.id}:${payout.status}` });
      state.payout.status = payout.status;
    }
  }
  state.events.push(...out);
  return out;
}
