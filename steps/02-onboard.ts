// Step 2 — the freelancer joins. The partner's site collects what it knows,
// mints an onboarding session, opens Abillio's link in a popup and then asks
// the session where things stand. The engagement is looked up by the e-mail
// the link was minted for: the session answer carries no engagement id.
import type { Api } from '../lib/abillio.ts';
import { idempotencyKeyFor, type State } from '../lib/store.ts';

export type JoinForm = { first_name: string; last_name: string; email: string; tax_country: string; locale: 'lv' | 'en' };

export type SessionStatus = {
  state: 'awaiting_freelancer' | 'in_progress' | 'complete' | 'expired';
  can_be_paid: boolean;
  purpose: string;
  requirements: { key: string; state: string }[];
};

type SessionOut = { session_id: string; url: string; status: string; purpose: string };
type EngagementRow = { id: string; status: string; counterparty: { email: string; servicing_company: { slug: string } | null }; compliance: { can_be_paid: boolean } };

export function returnUrlFor(publicUrl: string | null, port: number): string {
  return `${publicUrl ?? `http://localhost:${port}`}/back`;
}

export async function startOnboarding(api: Api, state: State, form: JoinForm, returnUrl: string): Promise<{ session_id: string; url: string; origin: string }> {
  const session = await api<SessionOut>(
    'POST',
    '/onboarding/sessions/',
    {
      email: form.email,
      locale: form.locale,
      return_url: returnUrl,
      prefill: { first_name: form.first_name, last_name: form.last_name, tax_country: form.tax_country },
    },
    { idempotencyKey: idempotencyKeyFor(state, `onboard:${form.email.toLowerCase()}`) },
  );
  return { session_id: session.session_id, url: session.url, origin: new URL(session.url).origin };
}

export async function readSession(api: Api, sessionId: string): Promise<SessionStatus> {
  return api<SessionStatus>('GET', `/onboarding/sessions/${encodeURIComponent(sessionId)}`);
}

export async function findEngagement(api: Api, email: string) {
  const page = await api<{ items: EngagementRow[] }>('GET', `/engagements/?search=${encodeURIComponent(email)}`);
  const row = page.items.find(item => item.counterparty.email.toLowerCase() === email.toLowerCase());
  if (!row) return null;
  return { id: row.id, status: row.status, can_be_paid: row.compliance.can_be_paid, servicing_company_slug: row.counterparty.servicing_company?.slug ?? null };
}
