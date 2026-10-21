// Step 2b — after onboarding. Something the freelancer set up can stop
// counting later: their identity verification lapses, their only payout
// method goes, they withdraw the invoicing mandate. The engagement's
// `requirements` then list it again, and the company sends them back with an
// update link: the same `POST /onboarding/sessions/` for the same address,
// which Abillio answers with `purpose: "update"`. In the sandbox a simulator
// plays each of the three through the code path production runs, so the
// requirements and the events are the ones production sends.
import type { Api } from '../lib/abillio.ts';
import { idempotencyKeyFor, type Requirements, type State } from '../lib/store.ts';
import { onboardingAction, openRequirements } from './02-onboard.ts';

// What step 2's "What happens later" plays, as the simulator names it. Each
// outcome belongs to one kind, so the form sends the outcome alone. The
// simulator also has `identity_verification`/`expiring`, which stops
// nothing, so the sample leaves it out.
export const REQUIREMENT_SIMULATIONS = [
  { kind: 'identity_verification', outcome: 'expired' },
  { kind: 'payout_method', outcome: 'removed' },
  { kind: 'mandate', outcome: 'revoked' },
] as const;
export type RequirementSimulation = (typeof REQUIREMENT_SIMULATIONS)[number];

// What the sample keeps of the engagement the simulator answers with:
// whether Abillio can pay the freelancer (`compliance.can_be_paid`, payouts
// only) and what is open on their list.
export type SimulatedEngagement = { id: string; status: string; can_be_paid: boolean; requirements: Requirements | null };

type EngagementOut = { id: string; status: string; compliance: { can_be_paid: boolean } | null; requirements: Requirements | null };
type SessionOut = { session_id: string; url: string; status: string; purpose: string };

// The stored action a simulation's key lives under. A simulation is an event,
// not a state: the route spends the key on any settled answer (`once`), so
// the same button pressed again after the freelancer has put it right plays
// again instead of replaying the first answer.
export function simulateRequirementAction(engagementId: string, simulation: RequirementSimulation): string {
  return `simulate-requirement:${engagementId}:${simulation.kind}:${simulation.outcome}`;
}

// The answer is the engagement exactly as GET /engagements/{id} returns it to
// the company, the new list included.
export async function simulateRequirement(api: Api, state: State, engagementId: string, simulation: RequirementSimulation): Promise<SimulatedEngagement> {
  const out = await api<EngagementOut>(
    'POST',
    `/engagements/${encodeURIComponent(engagementId)}/requirements/sandbox/simulate`,
    { kind: simulation.kind, outcome: simulation.outcome },
    { idempotencyKey: idempotencyKeyFor(state, simulateRequirementAction(engagementId, simulation)) },
  );
  return {
    id: out.id,
    status: out.status,
    can_be_paid: out.compliance?.can_be_paid ?? false,
    requirements: out.requirements ? openRequirements(out.requirements) : null,
  };
}

// An update link's body: the address the engagement was minted for, where
// the popup returns, and `purpose: "update"` said outright, so an engagement
// that is not active answers 409 `onboarding_purpose_mismatch` instead of
// getting a first-time link. No prefill and no locale: consent is never asked
// again, and a blank locale follows the freelancer's browser.
export type UpdateLinkBody = { email: string; return_url: string; purpose: 'update' };

export function updateLinkBody(email: string, returnUrl: string): UpdateLinkBody {
  return { email, return_url: returnUrl, purpose: 'update' };
}

// Keyed like the first mint (onboardingAction: the address and a digest of
// the exact body), and spent the same way by the route, on any answer.
export async function startUpdate(api: Api, state: State, body: UpdateLinkBody): Promise<{ session_id: string; url: string; origin: string; purpose: string }> {
  const session = await api<SessionOut>('POST', '/onboarding/sessions/', body, { idempotencyKey: idempotencyKeyFor(state, onboardingAction(body)) });
  return { session_id: session.session_id, url: session.url, origin: new URL(session.url).origin, purpose: session.purpose };
}
