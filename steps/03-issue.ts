// Step 3 — one invoice in the freelancer's name, billed to the company
// itself (the "self-client" Abillio provisions). Two calls, so a draft can be
// reviewed before it becomes a document; each carries its own idempotency key.
import type { Api } from '../lib/abillio.ts';
import { idempotencyKeyFor, type InvoiceRequest, type State } from '../lib/store.ts';

export type IssueForm = { description: string; unit_price: string; currency_code: string };
export type InvoiceSummary = { id: string; number: string; status: string; public_url: string; total: string; currency: string };

// Where the joined freelancer's invoice stands. It decides what the next press
// does (the route) and what the panel offers, so the two never disagree:
//   idle    nothing asked yet: draft from the form, then issue;
//   pending a draft request is stored but no draft came back: re-send it;
//   draft   a draft is stored: issue it;
//   issued  issued: repeat only the issue call, which Abillio replays.
// An engagement is drafted for once; nothing here ever drafts again.
export type IssueStage = 'idle' | 'pending' | 'draft' | 'issued';

type ClientRow = { id: string; name: string; company_account_id: string | null };
type InvoiceOut = { id: string; invoice_number: string; status: string; public_url: string; amounts: { total: { amount: string; currency: string } } };

function summary(out: InvoiceOut): InvoiceSummary {
  return { id: out.id, number: out.invoice_number, status: out.status, public_url: out.public_url, total: out.amounts.total.amount, currency: out.amounts.total.currency };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// The draft request for one engagement: issued on `today`, due 14 days later.
// Dated here, once; a retry re-sends the stored request, never a fresh one.
export function invoiceRequest(engagementId: string, form: IssueForm, today: Date): InvoiceRequest {
  const due = new Date(today.getTime() + 14 * 86_400_000);
  return {
    engagement_id: engagementId,
    description: form.description,
    unit_price: form.unit_price,
    currency_code: form.currency_code,
    issued_date: isoDate(today),
    due_date: isoDate(due),
  };
}

// The stored draft request that waits to be re-sent: one for the joined
// freelancer's engagement while no draft is stored.
export function pendingRequest(state: State): InvoiceRequest | null {
  const request = state.invoice_request;
  return !state.invoice && request && request.engagement_id === state.freelancer?.engagement_id ? request : null;
}

export function issueStage(state: State): IssueStage {
  if (state.invoice) return state.invoice.status === 'draft' ? 'draft' : 'issued';
  return pendingRequest(state) ? 'pending' : 'idle';
}

export async function findSelfClient(api: Api, accountId: string): Promise<{ id: string; name: string }> {
  // The list cannot be filtered to the self-client. 100 rows are plenty for
  // this sample; a company with more clients pages on with `offset`.
  const page = await api<{ items: ClientRow[] }>('GET', '/accounts/clients/?limit=100');
  const self = page.items.find(row => row.company_account_id === accountId);
  if (!self) throw new Error('no self-client: Abillio provisions one for every verified company account; check the account on the Key panel');
  return { id: self.id, name: self.name };
}

// The body is the stored request plus the self-client id, which is read on
// each press; the same request therefore sends the same bytes.
export async function draftInvoice(api: Api, state: State, request: InvoiceRequest, selfClientId: string): Promise<InvoiceSummary> {
  const out = await api<InvoiceOut>(
    'POST',
    `/engagements/${encodeURIComponent(request.engagement_id)}/invoices/`,
    {
      client_uuid: selfClientId,
      // `unit_code` is a UN/ECE Rec 20 code, which e-invoicing requires on
      // every line: HUR (hour) for tutoring. Abillio accepts HUR, DAY, MON,
      // C62, ZP and LS, and refuses anything else with a 422.
      items: [{ description: request.description, quantity: '1', unit_price: request.unit_price, unit_code: 'HUR' }],
      currency_code: request.currency_code,
      issued_date: request.issued_date,
      due_date: request.due_date,
      language: 'en',
    },
    { idempotencyKey: idempotencyKeyFor(state, `draft:${request.engagement_id}`) },
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
