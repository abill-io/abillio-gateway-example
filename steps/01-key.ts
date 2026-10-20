// Step 1 — does the key work, and may it do what the next four steps do?
// `GET /me/session/` says who the key acts as; `GET /me/authorization/` is
// the key's own preview, one row per action. Both are read-only.
import type { Api } from '../lib/abillio.ts';

// The action ids are the ones the company API's routes declare
// (`@requires_action(...)` in the Abillio backend), in the order the steps
// use them.
export const NEEDED_ACTIONS = [
  'freelancers.invite',                  // POST /onboarding/sessions/ (step 2)
  'freelancers.view',                    // GET /onboarding/sessions/{id} (step 2)
  'engagements.view',                    // GET /engagements/?search=, the engagement lookup (step 2)
  'clients.view',                        // GET /accounts/clients/, the self-client lookup (step 3)
  'invoices.draft.create',               // POST /engagements/{id}/invoices/ (step 3)
  'invoices.issue',                      // POST …/invoices/{id}/issue (step 3)
  'invoices.review.approve',             // the same call approves a self-client invoice (step 3)
  'wallet.payment.execute',              // POST /accounts/wallet/pay-invoice/ (step 4)
  'payouts.view',                        // GET /engagements/{id}/payouts/, the payout lookup and read-back (steps 4, 5)
  'invoices.view',                       // GET /accounts/invoices/{id}/, the invoice read-back (steps 4, 5)
  'sandbox.simulate',                    // simulate-deposit, payout outcomes, reset (steps 4, 10)
  'notifications.channels.manage',       // POST /accounts/notifications/channels/ (step 5)
  'notifications.subscriptions.manage',  // POST /accounts/notifications/subscriptions/ (step 5)
];

export type KeyReport = {
  account: { id: string; name: string; slug: string; is_sandbox: boolean };
  user_email: string;
  actions: { id: string; state: string; needed: boolean }[];
};

type SessionOut = { account: { id: string; name: string; slug: string; is_sandbox: boolean }; user_email: string };
type AuthorizationOut = { actions: Record<string, { state: string }> };

export async function checkKey(api: Api): Promise<KeyReport> {
  const session = await api<SessionOut>('GET', '/me/session/');
  const authorization = await api<AuthorizationOut>('GET', '/me/authorization/');
  const needed = NEEDED_ACTIONS.map(id => ({ id, state: authorization.actions[id]?.state ?? 'unavailable', needed: true }));
  const others = Object.entries(authorization.actions)
    .filter(([id]) => !NEEDED_ACTIONS.includes(id))
    .map(([id, entry]) => ({ id, state: entry.state, needed: false }));
  return { account: session.account, user_email: session.user_email, actions: [...needed, ...others] };
}
