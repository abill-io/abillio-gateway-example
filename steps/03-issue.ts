// Step 3 — one invoice in the freelancer's name, billed to the company
// itself (the "self-client" Abillio provisions). Two calls, so a draft can be
// reviewed before it becomes a document; each carries its own idempotency key.
import type { Api } from '../lib/abillio.ts';
import { idempotencyKeyFor, type State } from '../lib/store.ts';

export type IssueForm = { description: string; unit_price: string; currency_code: string };
export type InvoiceSummary = { id: string; number: string; status: string; public_url: string; total: string; currency: string };

type ClientRow = { id: string; name: string; company_account_id: string | null };
type InvoiceOut = { id: string; invoice_number: string; status: string; public_url: string; amounts: { total: { amount: string; currency: string } } };

function summary(out: InvoiceOut): InvoiceSummary {
  return { id: out.id, number: out.invoice_number, status: out.status, public_url: out.public_url, total: out.amounts.total.amount, currency: out.amounts.total.currency };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function findSelfClient(api: Api, accountId: string): Promise<{ id: string; name: string }> {
  const page = await api<{ items: ClientRow[] }>('GET', '/accounts/clients/');
  const self = page.items.find(row => row.company_account_id === accountId);
  if (!self) throw new Error('no self-client: Abillio provisions one for every verified company account; check the account on the Key panel');
  return { id: self.id, name: self.name };
}

export async function draftInvoice(api: Api, state: State, engagementId: string, clientId: string, form: IssueForm, today: Date = new Date()): Promise<InvoiceSummary> {
  const due = new Date(today.getTime() + 14 * 86_400_000);
  const out = await api<InvoiceOut>(
    'POST',
    `/engagements/${encodeURIComponent(engagementId)}/invoices/`,
    {
      client_uuid: clientId,
      // `unit_code` is a UN/ECE Rec 20 code, which e-invoicing requires on
      // every line: HUR (hour) for tutoring. Abillio accepts HUR, DAY, MON,
      // C62, ZP and LS, and refuses anything else with a 422.
      items: [{ description: form.description, quantity: '1', unit_price: form.unit_price, unit_code: 'HUR' }],
      currency_code: form.currency_code,
      issued_date: isoDate(today),
      due_date: isoDate(due),
      language: 'en',
    },
    { idempotencyKey: idempotencyKeyFor(state, `draft:${engagementId}`) },
  );
  return summary(out);
}

export async function issueInvoice(api: Api, state: State, engagementId: string, invoiceId: string): Promise<InvoiceSummary> {
  const out = await api<InvoiceOut>(
    'POST',
    `/engagements/${encodeURIComponent(engagementId)}/invoices/${encodeURIComponent(invoiceId)}/issue`,
    undefined,
    { idempotencyKey: idempotencyKeyFor(state, `issue:${invoiceId}`) },
  );
  return summary(out);
}
