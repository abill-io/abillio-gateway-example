// Step 2 — the freelancer joins. The partner's site collects what it knows,
// mints an onboarding session, opens Abillio's link in a popup and then asks
// the session where things stand. The engagement is looked up by the e-mail
// the link was minted for: the session answer carries no engagement id.
import { createHash } from 'node:crypto';
import type { Api } from '../lib/abillio.ts';
import { idempotencyKeyFor, type RequirementItem, type Requirements, type State } from '../lib/store.ts';

export type JoinForm = { first_name: string; last_name: string; email: string; tax_country: string; locale: 'lv' | 'en' };
export type OnboardingBody = { email: string; locale: 'lv' | 'en'; return_url: string; prefill: { first_name: string; last_name: string; tax_country: string } };

export type SessionStatus = {
  state: 'awaiting_freelancer' | 'in_progress' | 'complete' | 'expired';
  can_be_paid: boolean;
  purpose: string;
  requirements: { key: string; state: string }[];
};

// What POST /onboarding/sessions/ answers, a first link's mint or an update
// link's (steps/02b-requirements.ts).
export type SessionOut = { session_id: string; url: string; status: string; purpose: string };
type EngagementRow = { id: string; status: string; counterparty: { email: string; servicing_company: { slug: string } | null }; compliance: { can_be_paid: boolean }; requirements?: Requirements | null };

export function returnUrlFor(publicUrl: string | null, port: number): string {
  return `${publicUrl ?? `http://localhost:${port}`}/back`;
}

// What of an engagement's `requirements` is still open: the list while its
// `status` is not `complete`, else null. A list Abillio could not work out
// arrives as `null` and never comes here: it proves nothing either way.
export function openRequirements(requirements: Requirements): Requirements | null {
  return requirements.status === 'complete' ? null : requirements;
}

// What POST /onboarding/sessions/ sends for this form.
export function onboardingBody(form: JoinForm, returnUrl: string): OnboardingBody {
  return {
    email: form.email,
    locale: form.locale,
    return_url: returnUrl,
    prefill: { first_name: form.first_name, last_name: form.last_name, tax_country: form.tax_country },
  };
}

// The action a mint is keyed on: the address plus a digest of the exact body,
// a first link's (`onboardingBody`) or an update link's (`updateLinkBody`,
// steps/02b-requirements.ts). The route spends the key as soon as Abillio
// answers (`once`): every answered press mints again, and only a mint whose
// answer was lost keeps its key, for the identical retry to replay. Abillio
// holds that key to the body it first saw, and a different body under it is a
// 409 for good; with the digest a changed form is a new attempt instead. The
// routes' keyed() and startOnboarding / startUpdate all derive it here, so the
// key they claim and send cannot drift apart.
export function onboardingAction(body: { email: string }): string {
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 8);
  return `onboard:${body.email.toLowerCase()}:${digest}`;
}

export async function startOnboarding(api: Api, state: State, form: JoinForm, returnUrl: string): Promise<{ session_id: string; url: string; origin: string }> {
  const body = onboardingBody(form, returnUrl);
  const session = await api<SessionOut>('POST', '/onboarding/sessions/', body, { idempotencyKey: idempotencyKeyFor(state, onboardingAction(body)) });
  return { session_id: session.session_id, url: session.url, origin: new URL(session.url).origin };
}

export async function readSession(api: Api, sessionId: string): Promise<SessionStatus> {
  return api<SessionStatus>('GET', `/onboarding/sessions/${encodeURIComponent(sessionId)}`);
}

export async function findEngagement(api: Api, email: string) {
  const page = await api<{ items: EngagementRow[] }>('GET', `/engagements/?search=${encodeURIComponent(email)}`);
  const row = page.items.find(item => item.counterparty.email.toLowerCase() === email.toLowerCase());
  if (!row) return null;
  return { id: row.id, status: row.status, can_be_paid: row.compliance.can_be_paid, servicing_company_slug: row.counterparty.servicing_company?.slug ?? null, requirements: row.requirements ?? null };
}

// A stored list's items by what they mean, read off each item's own `state`:
// a `due` one needs doing now, an `upcoming` one blocks nothing yet and is
// merely worth doing in the same link (billing details a gateway freelancer
// never gives in the first-time lane, say). A state the sample does not know
// counts as due, so it never passes for done.
export function splitRequirements(requirements: Requirements | null): { due: RequirementItem[]; upcoming: RequirementItem[] } {
  const items = requirements ? [...requirements.due, ...requirements.upcoming] : [];
  return { due: items.filter(item => item.state !== 'upcoming'), upcoming: items.filter(item => item.state === 'upcoming') };
}

// Step 2 is done once Abillio says the freelancer can be paid and nothing a
// simulation reopened (step 2b) is due. `can_be_paid` alone is not enough: it
// is about payouts, and a withdrawn mandate stops invoicing only. What is
// only upcoming blocks nothing.
export function setupDone(f: State['freelancer']): boolean {
  return f !== null && f.can_be_paid && splitRequirements(f.requirements).due.length === 0;
}
