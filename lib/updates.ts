import { createHash } from 'node:crypto';
import type { State, StoredEvent } from './store.ts';
import { aboutThisWalk } from '../steps/05-events.ts';

export type UpdateSummary = {
  key: string;
  title: string;
  receivedAt: string;
  via: StoredEvent['via'];
};

const TITLES: Record<string, string> = {
  'channel.test': 'Test delivery received',
  'engagement.onboarding.started': 'Freelancer setup started',
  'engagement.onboarding.completed': 'Freelancer setup completed',
  'engagement.kyc.updated': 'Identity check updated',
  'engagement.requirements_updated': 'Freelancer requirements updated',
  'engagement.invoice.confirmed': 'Invoice confirmed',
  'engagement.invoice.status_changed': 'Invoice status updated',
  'engagement.invoice.paid': 'Invoice payment confirmed',
  'engagement.payout.processing': 'Payout is processing',
  'engagement.payout.completed': 'Payout completed',
  'engagement.payout.failed': 'Payout needs attention',
  'poll.payout.status_changed': 'Payout status updated',
};

// The live notice carries no event payload or private identifiers. Its key
// also detects a missed update once the capped event log reaches 200 entries.
export function latestUpdate(state: State): UpdateSummary | null {
  const event = [...state.events].reverse().find(e => e.event_type === 'channel.test' || aboutThisWalk(state, e));
  if (!event) return null;
  return {
    key: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
    title: TITLES[event.event_type] ?? 'New update from Abillio',
    receivedAt: event.received_at,
    via: event.via,
  };
}
