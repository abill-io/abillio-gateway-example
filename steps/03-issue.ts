// Step 3 — one invoice in the freelancer's name, billed to the company
// itself (the "self-client" Abillio provisions). Two calls, so a draft can be
// reviewed before it becomes a document; each carries its own idempotency key.
// Its line names the service it bills, one the freelancer's plan offers.
import type { Api } from '../lib/abillio.ts';
import { idempotencyKeyFor, type InvoiceRequest, type ServiceItem, type State } from '../lib/store.ts';
import { setupDone } from './02-onboard.ts';

// `service_slug` is absent, or empty, when the form offered no service.
export type IssueForm = { service_slug?: string; description: string; unit_price: string; currency_code: string };
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
type ServiceRow = { slug: string; name: string; group: string };
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
  const service = form.service_slug?.trim();
  return {
    engagement_id: engagementId,
    ...(service ? { service_slug: service } : {}),
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

// The services the freelancer's plan offers, which a line may bill in their
// name: one list, not paged, in Abillio's order (by group), and empty when
// the plan offers none. A slug the plan does not offer is refused at the
// draft, with a 400.
export async function listServices(api: Api, engagementId: string): Promise<ServiceItem[]> {
  const rows = await api<ServiceRow[]>('GET', `/engagements/${encodeURIComponent(engagementId)}/services/`);
  return rows.map(row => ({ slug: row.slug, name: row.name, group: row.group }));
}

// The list stored for the joined freelancer's engagement; null while none
// has been read for it.
export function storedServices(state: State): ServiceItem[] | null {
  const services = state.services;
  return services && services.engagement_id === state.freelancer?.engagement_id ? services.items : null;
}

// The engagement whose services the back office reads as it loads, if any:
// the joined freelancer's, once they are ready to be paid (step 2 done, where
// the walk turns to the invoice), while step 3 shows its form and nothing is
// stored for it. So the list is read once per engagement, not on every load.
export function servicesToRead(state: State): string | null {
  const id = state.freelancer?.engagement_id;
  return id && setupDone(state.freelancer) && issueStage(state) === 'idle' && !storedServices(state) ? id : null;
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
      // `service_slug` is the service the line bills, from `listServices`; a
      // request stored without one sends none. `unit_code` is a UN/ECE Rec 20
      // code, which e-invoicing requires on every line: HUR (hour) for
      // tutoring. Abillio accepts HUR, DAY, MON, C62, ZP and LS, and refuses
      // anything else with a 422.
      items: [{ ...(request.service_slug ? { service_slug: request.service_slug } : {}), description: request.description, quantity: '1', unit_price: request.unit_price, unit_code: 'HUR' }],
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
