// Step 4 — the company pays the invoice from its wallet; Abillio then creates
// the freelancer's payout on its own. In the sandbox the wallet is funded
// with a simulated deposit and the payout's fate is chosen with a simulator
// that runs the real lifecycle and emits the real events.
import { randomUUID } from 'node:crypto';
import type { Api } from '../lib/abillio.ts';
import { idempotencyKeyFor, type State } from '../lib/store.ts';

// The balance row a deposit credits while the freelancer's serving company is
// not known yet: the Latvian cooperative's.
export const DEFAULT_COMPANY = 'abillio-ks';

// What the sandbox simulator can make of a payout, as the bank would.
export const PAYOUT_OUTCOMES = ['processing', 'paid', 'rejected', 'returned'] as const;
export type PayoutOutcome = (typeof PAYOUT_OUTCOMES)[number];

type BalanceRow = { company_slug: string; available: { amount: string } };
type PayoutRow = { id: string; status: string; invoice_uuid: string | null };

// The stored actions the keys live under: the route claims the one the step sends.
export function payAction(invoiceId: string): string {
  return `pay:${invoiceId}`;
}

export function simulateAction(payoutId: string, outcome: PayoutOutcome): string {
  return `simulate:${payoutId}:${outcome}`;
}

// A deposit is meant to run again at will, like the test delivery, the
// channel's PATCH and Start over, so its key is fresh every press and never
// stored; every other key is tied to the thing it acts on and goes through the
// route's keyed() helper.
export async function fundWallet(api: Api, amount: string, currency: string, companySlug: string, idempotencyKey: string = randomUUID()): Promise<{ company_slug: string; available: string }[]> {
  const rows = await api<BalanceRow[]>(
    'POST',
    '/accounts/wallet/sandbox/simulate-deposit',
    { amount, currency, company: companySlug },
    { idempotencyKey },
  );
  return rows.map(row => ({ company_slug: row.company_slug, available: row.available.amount }));
}

export async function payInvoice(api: Api, state: State, invoiceId: string): Promise<{ created: boolean; operation_id: string }> {
  return api('POST', '/accounts/wallet/pay-invoice/', { invoice_uuid: invoiceId }, { idempotencyKey: idempotencyKeyFor(state, payAction(invoiceId)) });
}

// The invoice is read on the account surface: there is no GET under /engagements/…/invoices/.
export async function readInvoice(api: Api, invoiceId: string): Promise<{ id: string; status: string }> {
  const out = await api<{ id: string; status: string }>('GET', `/accounts/invoices/${encodeURIComponent(invoiceId)}/`);
  return { id: out.id, status: out.status };
}

// The list is asked for this invoice's payout, and the row is still picked by
// `invoice_uuid`, so a server that ignored the filter cannot hand back another
// invoice's payout.
export async function findPayout(api: Api, engagementId: string, invoiceId: string): Promise<{ id: string; status: string } | null> {
  const page = await api<{ items: PayoutRow[] }>('GET', `/engagements/${encodeURIComponent(engagementId)}/payouts/?invoice_uuid=${encodeURIComponent(invoiceId)}`);
  const row = page.items.find(item => item.invoice_uuid === invoiceId);
  return row ? { id: row.id, status: row.status } : null;
}

export async function readPayout(api: Api, engagementId: string, payoutId: string): Promise<{ id: string; status: string }> {
  const out = await api<{ id: string; status: string }>('GET', `/engagements/${encodeURIComponent(engagementId)}/payouts/${encodeURIComponent(payoutId)}`);
  return { id: out.id, status: out.status };
}

export async function simulatePayout(api: Api, state: State, engagementId: string, payoutId: string, outcome: PayoutOutcome): Promise<{ id: string; status: string }> {
  const out = await api<{ id: string; status: string }>(
    'POST',
    `/engagements/${encodeURIComponent(engagementId)}/payouts/${encodeURIComponent(payoutId)}/sandbox/simulate`,
    { outcome },
    { idempotencyKey: idempotencyKeyFor(state, simulateAction(payoutId, outcome)) },
  );
  return { id: out.id, status: out.status };
}
