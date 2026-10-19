// Step 4 — the company pays the invoice from its wallet; Abillio then creates
// the freelancer's payout on its own. In the sandbox the wallet is funded
// with a simulated deposit and the payout's fate is chosen with a simulator
// that runs the real lifecycle and emits the real events.
import { randomUUID } from 'node:crypto';
import type { Api } from '../lib/abillio.ts';
import { idempotencyKeyFor, type State } from '../lib/store.ts';

type BalanceRow = { company_slug: string; available: { amount: string } };
type PayoutRow = { id: string; status: string; invoice_uuid: string | null };

// A deposit is the one action meant to run again at will, so its key is fresh
// every press and never stored; every other key is tied to the thing it acts on
// and goes through the route's keyed() helper.
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
  return api('POST', '/accounts/wallet/pay-invoice/', { invoice_uuid: invoiceId }, { idempotencyKey: idempotencyKeyFor(state, `pay:${invoiceId}`) });
}

export async function findPayout(api: Api, engagementId: string, invoiceId: string): Promise<{ id: string; status: string } | null> {
  const page = await api<{ items: PayoutRow[] }>('GET', `/engagements/${encodeURIComponent(engagementId)}/payouts/`);
  const row = page.items.find(item => item.invoice_uuid === invoiceId);
  return row ? { id: row.id, status: row.status } : null;
}

export async function simulatePayout(api: Api, state: State, engagementId: string, payoutId: string, outcome: 'processing' | 'paid' | 'rejected' | 'returned'): Promise<{ id: string; status: string }> {
  const out = await api<{ id: string; status: string }>(
    'POST',
    `/engagements/${encodeURIComponent(engagementId)}/payouts/${encodeURIComponent(payoutId)}/sandbox/simulate`,
    { outcome },
    { idempotencyKey: idempotencyKeyFor(state, `simulate:${payoutId}:${outcome}`) },
  );
  return { id: out.id, status: out.status };
}
