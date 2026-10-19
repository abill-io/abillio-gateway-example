import type { State } from '../lib/store.ts';
import type { TraceEntry } from '../lib/trace.ts';
import type { KeyReport } from '../steps/01-key.ts';
import { issueStage, pendingRequest } from '../steps/03-issue.ts';
import { DEFAULT_COMPANY, PAYOUT_OUTCOMES } from '../steps/04-pay.ts';
import { esc, page } from './layout.ts';
import { errorBox, jsonBlock, rail, stateTag, stepHead, stepStatuses, tracePanel, type StepStatus } from './partials.ts';

export type CompanyPageInput = { state: State; trace: TraceEntry[]; key: KeyReport | null; error: unknown; publicUrl: string | null };

// Each panel takes its step's status from companyPage, which reads them all
// once; called on its own, a panel reads its own.
export function keyPanel(key: KeyReport | null, state: State, status: StepStatus = stepStatuses(state)[0]): string {
  const actionTable = (actions: KeyReport['actions']) => `<table class="actions"><thead><tr><th scope="col">Action</th><th scope="col">State</th></tr></thead><tbody>${actions.map(a => `<tr><td><code>${esc(a.id)}</code>${a.needed ? ' <small>needed</small>' : ''}</td><td>${stateTag(a.state)}</td></tr>`).join('')}</tbody></table>`;
  // The actions the five steps need stay in view; the rest of the surface
  // (well over a hundred rows) folds away, so it does not push the steps off
  // the screen.
  const others = key ? key.actions.filter(a => !a.needed) : [];
  const table = key
    ? actionTable(key.actions.filter(a => a.needed)) + (others.length ? `<details class="others"><summary>The other ${esc(others.length)} actions on this surface</summary>${actionTable(others)}</details>` : '')
    : '';
  // No "signed in as <the key owner's e-mail>": on the hosted copy every
  // visitor sees this page, and that address is not theirs to see.
  return `<section class="panel" id="step-1" aria-labelledby="step-1-title">${stepHead(1, 'Step 1 — Does the key work?', status)}
    <p><code>GET /me/session/</code> says who the key acts as; <code>GET /me/authorization/</code> lists what it may do. A <b>forbidden</b> row here explains a later 403 before it happens.</p>
    <form method="post" action="/steps/key"><button>Check the key</button></form>
    ${state.account ? `<p class="facts">Acting as <b>${esc(state.account.name)}</b> (<code>${esc(state.account.slug)}</code>)${state.account.is_sandbox === true ? ' <span class="tag">sandbox</span>' : state.account.is_sandbox === false ? ' <span class="tag is-bad">production</span>' : ''}.</p>` : ''}
    ${table}
  </section>`;
}

export function onboardingPanel(state: State, status: StepStatus = stepStatuses(state)[1]): string {
  const f = state.freelancer;
  return `<section class="panel" id="step-2" aria-labelledby="step-2-title">${stepHead(2, 'Step 2 — The freelancer joins', status)}
    <p>Happens on <a href="/join">the freelancer's page</a>: <code>POST /onboarding/sessions/</code>, the popup, then <code>GET /onboarding/sessions/{id}</code> until <code>can_be_paid</code>, and <code>GET /engagements/?search=…</code> for the engagement id.</p>
    ${f ? `<p class="facts">Freelancer <b>${esc(f.email)}</b> — session <code>${esc(f.session_id)}</code>, engagement <code>${esc(f.engagement_id ?? '(not yet)')}</code>, served by <code>${esc(f.servicing_company_slug ?? '?')}</code>.</p>` : '<p class="muted">Nobody has joined yet.</p>'}
  </section>`;
}

function issueFields(values: { description: string; unit_price: string; currency_code: string }): string {
  return `<label class="wide">Description <input name="description" value="${esc(values.description)}" required></label>
      <label>Amount <input name="unit_price" class="amount" value="${esc(values.unit_price)}" required pattern="\\d+(\\.\\d{1,2})?"></label>
      <label>Currency <select name="currency_code"><option>${esc(values.currency_code)}</option></select></label>`;
}

// The panel offers exactly what the next press will do (`issueStage`): a
// stored request or draft is never shown as a form that would be ignored.
export function issuePanel(state: State, status: StepStatus = stepStatuses(state)[2]): string {
  const ready = Boolean(state.freelancer?.engagement_id && state.account);
  const button = (label: string) => `<button ${ready ? '' : 'disabled'}>${esc(label)}</button>`;
  const stage = issueStage(state);
  const inv = state.invoice;
  const request = pendingRequest(state);
  let body: string;
  if (inv && stage === 'issued') {
    // Abillio's answer, but still checked before it becomes a link.
    const link = inv.public_url.startsWith('https://') ? `, <a href="${esc(inv.public_url)}" target="_blank" rel="noopener">open the document</a>` : '';
    body = `<p class="facts">Invoice <b>${esc(inv.number || inv.id)}</b> — status ${stateTag(inv.status)}${link}.</p>
    <form method="post" action="/steps/issue">${button('Press again — replays the issue call')}</form>`;
  } else if (inv && stage === 'draft') {
    body = `<p class="facts">Draft <code>${esc(inv.id)}</code> is stored and will be issued as drafted.</p>
    <form method="post" action="/steps/issue">${button('Issue the draft')}</form>`;
  } else if (request && stage === 'pending') {
    body = `<form method="post" action="/steps/issue" class="issue-form">
      <fieldset class="fields" disabled>${issueFields(request)}</fieldset>
      <p class="muted">The last attempt's outcome is unknown (no answer, a server error, or Abillio still holds it); pressing again re-sends the same request under the same key.</p>
      ${button('Retry')}
    </form>`;
  } else {
    body = `<form method="post" action="/steps/issue" class="issue-form">
      <div class="fields">${issueFields({ description: 'Tutoring, October', unit_price: '100.00', currency_code: 'EUR' })}</div>
      ${button('Draft and issue')}
    </form>`;
  }
  return `<section class="panel" id="step-3" aria-labelledby="step-3-title">${stepHead(3, "Step 3 — Issue an invoice in the freelancer's name", status)}
    <p><code>GET /accounts/clients/</code> finds the self-client (the company itself), <code>POST /engagements/{id}/invoices/</code> drafts, <code>POST …/issue</code> issues. A 409 here lists every blocker at once.</p>
    ${body}
    ${ready ? '' : '<p class="muted">Needs a joined freelancer (step 2) and the key check (step 1).</p>'}
  </section>`;
}

export function payPanel(state: State, status: StepStatus = stepStatuses(state)[3]): string {
  const inv = state.invoice;
  const payout = state.payout;
  const company = state.freelancer?.servicing_company_slug ?? DEFAULT_COMPANY;
  const payable = Boolean(inv && ['approved', 'pending', 'partial_paid', 'overdue'].includes(inv.status));
  // A paid invoice keeps its button: under the stored key a press replays the
  // payment, which is the idempotency to show.
  const paid = inv?.status === 'paid';
  const payLabel = paid ? 'Pay again — replays the same payment (no second debit)' : `Pay invoice ${inv?.number ?? ''}`;
  return `<section class="panel" id="step-4" aria-labelledby="step-4-title">${stepHead(4, 'Step 4 — Pay it from the wallet', status)}
    <p><code>POST /accounts/wallet/sandbox/simulate-deposit</code> funds the sandbox wallet, <code>POST /accounts/wallet/pay-invoice/</code> pays what the invoice still owes, Abillio creates the payout; <code>POST …/payouts/{id}/sandbox/simulate</code> settles it as the bank would.</p>
    <form method="post" action="/steps/pay/fund" class="fund"><label>Deposit <input name="amount" class="amount" value="250.00" required pattern="\\d+(\\.\\d{1,2})?"></label> <span class="unit">EUR on <code>${esc(company)}</code></span> <button ${state.account ? '' : 'disabled'}>Fund the wallet</button></form>
    <form method="post" action="/steps/pay/pay" class="pay"><button ${payable || paid ? '' : 'disabled'}>${esc(payLabel)}</button></form>
    ${paid && !payout ? '<p class="muted">No payout was created for this payment: the invoice carries no verified payout method, or Abillio refused the payout. A refusal leaves a <code>wallet.auto_payout_blocked</code> notification in your Abillio inbox; it is an inbox notification, not a webhook event.</p>' : ''}
    ${payout ? `<p class="facts">Payout <code>${esc(payout.id)}</code> — status ${stateTag(payout.status)}</p>
    <form method="post" action="/steps/pay/simulate" class="outcomes">${PAYOUT_OUTCOMES.map(o => `<button name="outcome" value="${esc(o)}">Simulate ${esc(o)}</button>`).join(' ')}</form>` : ''}
  </section>`;
}

export function eventsPanel(state: State, publicUrl: string | null, status: StepStatus = stepStatuses(state)[4]): string {
  const w = state.webhook;
  // A log, newest first: one line per event, the newest one opened.
  const rows = [...state.events].reverse().slice(0, 30).map((e, i) => `<li><details${i === 0 ? ' open' : ''}><summary><small class="when">${esc(e.received_at)}</small> <code>${esc(e.event_type)}</code> <span class="tag">${esc(e.via)}</span></summary>${jsonBlock(e.data)}</details></li>`).join('');
  return `<section class="panel" id="step-5" aria-labelledby="step-5-title">${stepHead(5, 'Step 5 — Hear from Abillio', status)}
    ${publicUrl
      ? `<p>Public URL <code>${esc(publicUrl)}</code>. <code>POST /accounts/notifications/channels/</code> + <code>POST /accounts/notifications/subscriptions/</code>; deliveries arrive at <code>/webhooks/abillio</code>, signed.</p>
         <div class="button-row"><form method="post" action="/steps/events/connect"><button>${w ? 'Reconnect' : 'Connect webhooks'}</button></form>${w ? '<form method="post" action="/steps/events/test"><button>Send a test delivery</button></form>' : ''}</div>
         ${w ? `<p class="facts">Channel <code>${esc(w.channel_id)}</code>, subscription <code>${esc(w.subscription_id ?? '(none yet: press Reconnect)')}</code>.</p>` : ''}`
      : `<p class="muted">No <code>PUBLIC_URL</code>: webhooks are off and the server polls every 5 s instead (<code>npm run tunnel</code> prints how to get a public URL).</p>`}
    <ul class="events">${rows || '<li class="empty">Nothing received yet.</li>'}</ul>
  </section>`;
}

export function companyPage(input: CompanyPageInput): string {
  const steps = stepStatuses(input.state);
  // `data-confirm` is asked by app.js, which then leaves the button usable on
  // a "no" (an inline onsubmit would not stop app.js from disabling it).
  // Start over sits with the progress line in the top bar: it starts the
  // walk the line counts over.
  const startOver = '<form method="post" action="/reset" data-confirm="Reset the sandbox demo data and forget this walk?"><button class="secondary">Start over</button></form>';
  // `data-events` is how many events this page shows: app.js compares it with
  // the store once its event stream connects, to catch one stored in between.
  // The trace and the stored state share the console on the right, which
  // stays in view while the steps scroll.
  const body = `<main id="main" class="two-col" data-events="${esc(input.state.events.length)}">
    <div class="steps-col">
      <h1 class="visually-hidden">Back office</h1>
      ${errorBox(input.error)}
      ${rail(steps, [
        keyPanel(input.key, input.state, steps[0]),
        onboardingPanel(input.state, steps[1]),
        issuePanel(input.state, steps[2]),
        payPanel(input.state, steps[3]),
        eventsPanel(input.state, input.publicUrl, steps[4]),
      ])}
    </div>
    <aside class="console">
      ${tracePanel(input.trace)}
      <section class="console-section" id="store" aria-labelledby="store-title"><h2 id="store-title">What we store</h2><p class="muted"><code>data/state.json</code> — the fields a real integration keeps in its own database.</p>${jsonBlock(input.state)}</section>
    </aside>
  </main>`;
  return page('Back office', body, { current: 'office', steps, controls: startOver });
}
