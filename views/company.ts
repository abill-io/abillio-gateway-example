import type { State } from '../lib/store.ts';
import type { TraceEntry } from '../lib/trace.ts';
import type { KeyReport } from '../steps/01-key.ts';
import { issueStage, pendingRequest } from '../steps/03-issue.ts';
import { esc, page } from './layout.ts';
import { errorBox, jsonBlock, tracePanel } from './partials.ts';

export type CompanyPageInput = { state: State; trace: TraceEntry[]; key: KeyReport | null; error: unknown; publicUrl: string | null };

export function keyPanel(key: KeyReport | null, state: State): string {
  const table = key
    ? `<table><tr><th>Action</th><th>State</th></tr>${key.actions.map(a => `<tr class="${a.needed ? 'needed' : ''} state-${esc(a.state)}"><td><code>${esc(a.id)}</code>${a.needed ? ' <small>needed</small>' : ''}</td><td>${esc(a.state)}</td></tr>`).join('')}</table>`
    : '';
  // No "signed in as <the key owner's e-mail>": on the hosted copy every
  // visitor sees this page, and that address is not theirs to see.
  return `<section class="panel" id="step-1"><h2>Step 1 — Does the key work?</h2>
    <p><code>GET /me/session/</code> says who the key acts as; <code>GET /me/authorization/</code> lists what it may do. A <b>forbidden</b> row here explains a later 403 before it happens.</p>
    <form method="post" action="/steps/key"><button>Check the key</button></form>
    ${state.account ? `<p>Acting as <b>${esc(state.account.name)}</b> (<code>${esc(state.account.slug)}</code>)${key?.account.is_sandbox ? ' <span class="tag">sandbox</span>' : ''}.</p>` : ''}
    ${table}
  </section>`;
}

export function onboardingPanel(state: State): string {
  const f = state.freelancer;
  return `<section class="panel" id="step-2"><h2>Step 2 — The freelancer joins</h2>
    <p>Happens on <a href="/join">the freelancer's page</a>: <code>POST /onboarding/sessions/</code>, the popup, then <code>GET /onboarding/sessions/{id}</code> until <code>can_be_paid</code>, and <code>GET /engagements/?search=…</code> for the engagement id.</p>
    ${f ? `<p>Freelancer <b>${esc(f.email)}</b> — session <code>${esc(f.session_id)}</code>, engagement <code>${esc(f.engagement_id ?? '(not yet)')}</code>, served by <code>${esc(f.servicing_company_slug ?? '?')}</code>.</p>` : '<p class="muted">Nobody has joined yet.</p>'}
  </section>`;
}

function issueFields(values: { description: string; unit_price: string; currency_code: string }): string {
  return `<label>Description <input name="description" value="${esc(values.description)}" required></label>
      <label>Amount <input name="unit_price" value="${esc(values.unit_price)}" required pattern="\\d+(\\.\\d{1,2})?"></label>
      <label>Currency <select name="currency_code"><option>${esc(values.currency_code)}</option></select></label>`;
}

// The panel offers exactly what the next press will do (`issueStage`): a
// stored request or draft is never shown as a form that would be ignored.
export function issuePanel(state: State): string {
  const ready = Boolean(state.freelancer?.engagement_id && state.account);
  const button = (label: string) => `<button ${ready ? '' : 'disabled'}>${esc(label)}</button>`;
  const stage = issueStage(state);
  const inv = state.invoice;
  const request = pendingRequest(state);
  let body: string;
  if (inv && stage === 'issued') {
    // Abillio's answer, but still checked before it becomes a link.
    const link = inv.public_url.startsWith('https://') ? `, <a href="${esc(inv.public_url)}" target="_blank" rel="noopener">open the document</a>` : '';
    body = `<p>Invoice <b>${esc(inv.number || inv.id)}</b> — status <code>${esc(inv.status)}</code>${link}.</p>
    <form method="post" action="/steps/issue">${button('Press again — replays the issue call')}</form>`;
  } else if (inv && stage === 'draft') {
    body = `<p>Draft <code>${esc(inv.id)}</code> is stored and will be issued as drafted.</p>
    <form method="post" action="/steps/issue">${button('Issue the draft')}</form>`;
  } else if (request && stage === 'pending') {
    body = `<form method="post" action="/steps/issue">
      <fieldset disabled>${issueFields(request)}</fieldset>
      <p class="muted">The last attempt's outcome is unknown (no answer, a server error, or Abillio still holds it); pressing again re-sends the same request under the same key.</p>
      ${button('Retry')}
    </form>`;
  } else {
    body = `<form method="post" action="/steps/issue">
      ${issueFields({ description: 'Tutoring, October', unit_price: '100.00', currency_code: 'EUR' })}
      ${button('Draft and issue')}
    </form>`;
  }
  return `<section class="panel" id="step-3"><h2>Step 3 — Issue an invoice in the freelancer's name</h2>
    <p><code>GET /accounts/clients/</code> finds the self-client (the company itself), <code>POST /engagements/{id}/invoices/</code> drafts, <code>POST …/issue</code> issues. A 409 here lists every blocker at once.</p>
    ${body}
    ${ready ? '' : '<p class="muted">Needs a joined freelancer (step 2) and the key check (step 1).</p>'}
  </section>`;
}

export function payPanel(state: State): string {
  const inv = state.invoice;
  const payout = state.payout;
  const company = state.freelancer?.servicing_company_slug ?? 'abillio-ks';
  const canPay = Boolean(inv && ['approved', 'pending', 'partial_paid', 'overdue'].includes(inv.status));
  return `<section class="panel" id="step-4"><h2>Step 4 — Pay it from the wallet</h2>
    <p><code>POST /accounts/wallet/sandbox/simulate-deposit</code> funds the sandbox wallet, <code>POST /accounts/wallet/pay-invoice/</code> pays what the invoice still owes, Abillio creates the payout; <code>POST …/payouts/{id}/sandbox/simulate</code> settles it as the bank would.</p>
    <form method="post" action="/steps/pay/fund" class="inline"><label>Deposit <input name="amount" value="250.00" pattern="\\d+(\\.\\d{1,2})?"></label> EUR on <code>${esc(company)}</code> <button ${state.account ? '' : 'disabled'}>Fund the wallet</button></form>
    <form method="post" action="/steps/pay/pay" class="inline"><button ${canPay ? '' : 'disabled'}>Pay invoice ${esc(inv?.number ?? '')}</button></form>
    ${payout ? `<p>Payout <code>${esc(payout.id)}</code> — status <code>${esc(payout.status)}</code></p>
    <form method="post" action="/steps/pay/simulate" class="inline">${['processing', 'paid', 'rejected', 'returned'].map(o => `<button name="outcome" value="${esc(o)}">Simulate ${esc(o)}</button>`).join(' ')}</form>` : ''}
  </section>`;
}

export function placeholderPanel(n: number, title: string): string {
  return `<section class="panel" id="step-${esc(n)}"><h2>Step ${esc(n)} — ${esc(title)}</h2><p class="muted">Coming in a later task.</p></section>`;
}

export function companyPage(input: CompanyPageInput): string {
  const body = `<main class="two-col">
    <div>
      ${errorBox(input.error)}
      ${keyPanel(input.key, input.state)}
      ${onboardingPanel(input.state)}
      ${issuePanel(input.state)}
      ${payPanel(input.state)}
      ${placeholderPanel(5, 'Events')}
      <section class="panel"><h2>What we store</h2><p class="muted"><code>data/state.json</code> — the fields a real integration keeps in its own database.</p>${jsonBlock(input.state)}</section>
    </div>
    <aside>${tracePanel(input.trace)}</aside>
  </main>`;
  return page('Back office', body);
}
