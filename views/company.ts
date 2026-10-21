import type { RequirementItem, State } from '../lib/store.ts';
import type { TraceEntry } from '../lib/trace.ts';
import type { KeyReport } from '../steps/01-key.ts';
import { setupDone } from '../steps/02-onboard.ts';
import { REQUIREMENT_SIMULATIONS, type RequirementSimulation } from '../steps/02b-requirements.ts';
import { issueStage, pendingRequest } from '../steps/03-issue.ts';
import { DEFAULT_COMPANY, PAYOUT_OUTCOMES } from '../steps/04-pay.ts';
import { aboutThisWalk } from '../steps/05-events.ts';
import { latestUpdate } from '../lib/updates.ts';
import { esc, page } from './layout.ts';
import { errorBox, jsonBlock, rail, stateTag, stepPanel, stepStatuses, tracePanel, type StepStatus } from './partials.ts';

// `abillioOrigin` is the origin of the stored onboarding link (server.ts's
// deps.abillioOrigin), for step 2's update-link form: popup.js trusts a
// message from there only.
export type CompanyPageInput = { state: State; trace: TraceEntry[]; key: KeyReport | null; error: unknown; publicUrl: string | null; focusStep?: number; abillioOrigin?: string | null };

function integrationDetails(body: string): string {
  return `<details class="integration-details"><summary>Integration details</summary>${body}</details>`;
}

// Every button that writes to Abillio waits for the key check, as the
// server's guard does: the page is handed only a check made with this
// process's key and ABILLIO_ACCOUNT (server.ts's publicState), so a check
// stored under others leaves them all disabled. `ready` is whatever else the
// button's step needs.
function live(state: State, ready = true): string {
  return state.account && ready ? '' : ' disabled';
}

// Each panel takes its step's status from companyPage, which reads them all
// once; called on its own, a panel reads its own.
export function keyPanel(key: KeyReport | null, state: State, status: StepStatus = stepStatuses(state)[0], expanded?: boolean): string {
  const actionTable = (actions: KeyReport['actions']) => `<table class="actions"><thead><tr><th scope="col">Action</th><th scope="col">State</th></tr></thead><tbody>${actions.map(a => `<tr><td><code>${esc(a.id)}</code>${a.needed ? ' <small>needed</small>' : ''}</td><td>${stateTag(a.state)}</td></tr>`).join('')}</tbody></table>`;
  // Permission rows are available with the API explanation, after the action.
  const others = key ? key.actions.filter(a => !a.needed) : [];
  const table = key
    ? actionTable(key.actions.filter(a => a.needed)) + (others.length ? `<details class="others"><summary>The other ${esc(others.length)} actions on this surface</summary>${actionTable(others)}</details>` : '')
    : '';
  // No "signed in as <the key owner's e-mail>": on the hosted copy every
  // visitor sees this page, and that address is not theirs to see.
  const restricted = key?.actions.some(a => a.needed && ['forbidden', 'unavailable'].includes(a.state));
  return stepPanel(1, status, state.account ? `Connected to ${state.account.name}${restricted ? ' · Some required actions are unavailable' : ''}` : 'Confirm which company this demo connects to.', `
    <p class="step-copy">Check the company connection before inviting a freelancer. This demo already has an API key configured.</p>
    <form method="post" action="/steps/key"><button>Check the key</button></form>
    ${state.account ? `<p class="facts">Acting as <b>${esc(state.account.name)}</b> (<code>${esc(state.account.slug)}</code>)${state.account.is_sandbox === true ? ' <span class="tag">sandbox</span>' : state.account.is_sandbox === false ? ' <span class="tag is-bad">production</span>' : ''}.</p>` : ''}
    ${restricted ? '<p class="permission-warning">Some required actions are unavailable. Open Integration details to review the permissions.</p>' : ''}
    ${integrationDetails(`<p><code>GET /me/session/</code> says who the key acts as; <code>GET /me/authorization/</code> lists what it may do. A <b>forbidden</b> row here explains a later 403 before it happens.</p>${table}`)}
  `, expanded);
}

// What a requirement is called on the page: the requirements registry's own
// names. The kinds are an open list, so one this sample does not know is said
// by its own name.
const REQUIREMENT_NAMES = new Map([
  ['identity_verification', 'identity verification'],
  ['payout_method', 'payout method'],
  ['membership_fee', 'membership fee'],
  ['tax_residency', 'tax residency'],
  ['mandate', 'invoicing mandate'],
  ['document_signature', 'document signature'],
  ['billing_details', 'billing details'],
]);

// One open item in plain words: what, and Abillio's word for where it stands
// (`detail`, a word for a human, never branched on), with the deadline of one
// still ahead. `detail` and `due_at` are optional in the schema. The caller
// escapes the line.
function plainRequirement(item: RequirementItem): string {
  const what = REQUIREMENT_NAMES.get(item.kind) ?? item.kind.replaceAll('_', ' ');
  const how = [(item.detail ?? '').replaceAll('_', ' '), item.state === 'upcoming' && item.due_at ? `due ${item.due_at.slice(0, 10)}` : ''].filter(Boolean).join(', ');
  return how ? `${what} (${how})` : what;
}

// Step 2's sandbox buttons, one per outcome the requirement simulator plays.
const SIMULATION_LABELS: Record<RequirementSimulation['outcome'], string> = {
  expired: 'Identity lapses',
  removed: 'Payout method removed',
  revoked: 'Mandate withdrawn',
};

export function onboardingPanel(state: State, publicUrl: string | null, status: StepStatus = stepStatuses(state)[1], expanded?: boolean, abillioOrigin: string | null = null): string {
  const f = state.freelancer;
  const done = setupDone(f);
  // What a simulation reopened (step 2b), due first, in plain words.
  const open = f?.requirements ? [...f.requirements.due, ...f.requirements.upcoming].map(plainRequirement).join('; ') : '';
  const hint = f ? `${f.email} · ${done ? 'Ready to be paid' : open ? 'Setup needs attention' : 'Setup in progress'}` : 'Try the signup page your freelancers would use.';
  const signup = `<a class="button-link${f ? ' secondary' : ''}" href="/join">${f ? 'Open freelancer signup' : 'Register & connect with Abillio'}</a>`;
  // With a public URL the server does not poll: until webhooks are connected,
  // the freelancer's progress reaches this page only when it is opened (the
  // status check server.ts makes on load).
  const unheard = publicUrl && !state.webhook && f && !done ? `<p class="muted">Webhooks are not connected yet, so this page learns about the freelancer's progress only when it is opened. Connect them in step 5 to hear about it as it happens.</p>` : '';
  const copy = !f
    ? 'Now try the freelancer’s side. They sign up on your company’s page, then connect with Abillio to complete their account and payout setup.'
    : done
      ? 'Freelancer setup is complete. Continue with the invoice in step 3.'
      : open
        ? 'Something the freelancer had set up needs doing again. Send them a new link: Abillio’s window asks only for what is listed, and this step is done again once they finish it.'
        : 'The freelancer has started connecting with Abillio. Their setup needs to be completed before they can receive payments.';
  const facts = f
    ? `<p class="facts"><b>${esc(f.email)}</b> — ${done ? 'Abillio confirms this freelancer is ready to be paid.' : open ? `Setup needs attention: ${esc(open)}.` : 'Setup is in progress. Finish the Abillio window already opened for this freelancer; their status updates automatically.'}</p>`
    : '<p class="muted">Nobody has joined yet.</p>';
  // Send a new link opens Abillio's window from the click (public/popup.js),
  // as the join page's Continue does; the link reaches only that browser.
  const resend = f && open
    ? `<form method="post" action="/steps/onboard/update-link" id="update-link" data-origin="${esc(abillioOrigin ?? '')}"><button${live(state)}>Send a new link</button></form>
    <p class="step-help">Opens Abillio’s window for ${esc(f.email)}, where they complete only what is listed.</p>
    <p id="popup-note" class="note" aria-live="polite"></p>`
    : '';
  // Optional sandbox controls, like step 4's payout outcomes: each plays one
  // way a freelancer who could be paid stops counting as set up (step 2b).
  const later = done
    ? `<details class="sandbox-tools"><summary>What happens later</summary><p class="muted">Optional sandbox controls: make something the freelancer set up stop counting, as it can in production, then send them a new link to put it right.</p>
    <form method="post" action="/steps/onboard/simulate" class="outcomes">${REQUIREMENT_SIMULATIONS.map(s => `<button name="outcome" value="${esc(s.outcome)}"${live(state)}>${esc(SIMULATION_LABELS[s.outcome])}</button>`).join(' ')}</form></details>`
    : '';
  return stepPanel(2, status, hint, `
    <p class="step-copy">${copy}</p>
    ${facts}${unheard}
    ${resend}${later}
    ${state.account ? (f ? `<details class="sandbox-tools"><summary>Try another signup</summary><p class="muted">Opening the signup page again starts another signup; it does not resume the existing Abillio window.</p>${signup}</details>` : `${signup}<p class="step-help">This opens the freelancer view. Return to the company view after setup to issue their invoice.</p>`) : '<p class="muted">Check the company connection in step 1 to begin.</p>'}
    ${integrationDetails(`<p>Happens on <a href="/join">the freelancer's page</a>: <code>POST /onboarding/sessions/</code>, the popup, then <code>GET /onboarding/sessions/{id}</code> until <code>can_be_paid</code>, and <code>GET /engagements/?search=…</code> for the engagement id. Later, in the sandbox, <code>POST /engagements/{id}/requirements/sandbox/simulate</code> reopens a requirement, and the same <code>POST /onboarding/sessions/</code> with <code>purpose: "update"</code> sends the freelancer back to complete it.</p>
    ${f ? `<p class="facts">Freelancer <b>${esc(f.email)}</b> — session <code>${esc(f.session_id)}</code>, engagement <code>${esc(f.engagement_id ?? '(not yet)')}</code>${f.engagement_status ? ` ${stateTag(f.engagement_status)}` : ''}, can_be_paid <code>${esc(f.can_be_paid)}</code>${f.requirements ? `, requirements ${stateTag(f.requirements.status)}` : ''}, served by <code>${esc(f.servicing_company_slug ?? '?')}</code>.</p>` : ''}`)}
  `, expanded);
}

function issueFields(values: { description: string; unit_price: string; currency_code: string }): string {
  return `<label class="wide">Description <input name="description" value="${esc(values.description)}" required></label>
      <label>Amount <input name="unit_price" class="amount" value="${esc(values.unit_price)}" required pattern="\\d+(\\.\\d{1,2})?"></label>
      <label>Currency <select name="currency_code"><option>${esc(values.currency_code)}</option></select></label>`;
}

// The panel offers exactly what the next press will do (`issueStage`): a
// stored request or draft is never shown as a form that would be ignored.
export function issuePanel(state: State, status: StepStatus = stepStatuses(state)[2], expanded?: boolean): string {
  const ready = Boolean(state.freelancer?.engagement_id && state.account);
  const button = (label: string) => `<button${live(state, ready)}>${esc(label)}</button>`;
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
      <div class="fields">${issueFields({ description: 'Services, October', unit_price: '100.00', currency_code: 'EUR' })}</div>
      ${button('Draft and issue')}
    </form>`;
  }
  const hint = inv ? `${stage === 'draft' ? 'Draft saved' : 'Invoice'} · ${inv.number || inv.id} · ${inv.status}` : stage === 'pending' ? 'The last attempt needs a retry to confirm the result.' : 'Create an invoice for the freelancer’s work.';
  return stepPanel(3, status, hint, `
    <p class="step-copy">Your company creates an invoice in the freelancer’s name for the work you are paying them for.</p>
    ${body}
    ${ready ? '' : '<p class="muted">Needs a joined freelancer (step 2) and the key check (step 1).</p>'}
    ${integrationDetails('<p><code>GET /accounts/clients/</code> finds the self-client (the company itself), <code>POST /engagements/{id}/invoices/</code> drafts, <code>POST …/issue</code> issues. A 409 here lists every blocker at once.</p>')}
  `, expanded);
}

export function payPanel(state: State, status: StepStatus = stepStatuses(state)[3], expanded?: boolean): string {
  const inv = state.invoice;
  const payout = state.payout;
  const company = state.freelancer?.servicing_company_slug ?? DEFAULT_COMPANY;
  const payable = Boolean(inv && ['approved', 'pending', 'partial_paid', 'overdue'].includes(inv.status));
  // A paid invoice keeps its button: under the stored key a press replays the
  // payment, which is the idempotency to show.
  const paid = inv?.status === 'paid';
  const payLabel = paid ? 'Pay again — replays the same payment (no second debit)' : `Pay invoice ${inv?.number ?? ''}`;
  const funding = `<details class="sandbox-tools"><summary>Add test funds to the wallet</summary>
    <p class="muted">If the sandbox wallet needs funds, add a test deposit before paying. Each press adds another deposit.</p>
    <form method="post" action="/steps/pay/fund" class="fund"><label>Deposit <input name="amount" class="amount" value="250.00" required pattern="\\d+(\\.\\d{1,2})?"></label> <span class="unit">EUR on <code>${esc(company)}</code></span> <button class="secondary"${live(state)}>Fund the wallet</button></form>
  </details>`;
  const hint = paid ? `Invoice paid${payout ? ` · Payout ${payout.status}` : ' · No payout created'}` : 'Pay the issued invoice from your company wallet.';
  return stepPanel(4, status, hint, `
    <p class="step-copy">Pay from your company’s Abillio wallet. Abillio then handles the freelancer’s payout when their payout method is ready.</p>
    ${paid ? '' : funding}
    <form method="post" action="/steps/pay/pay" class="pay"><button${live(state, payable || paid)}>${esc(payLabel)}</button></form>
    ${paid && !payout ? '<p class="muted">No payout was created for this payment. Abillio creates one only for a verified payout method in the invoice currency; without one, or when it refused the payout, the money waits in the freelancer\'s balance and Abillio raises <code>wallet.auto_payout_blocked</code> with the <code>invoice_uuid</code>. It lands in your Abillio inbox, and on any webhook whose subscription lists it (this sample\'s does not). A payment that puts an invoice on hold creates no payout either: that invoice reads <code>held</code>, and the move is announced as <code>engagement.invoice.status_changed</code>.</p>' : ''}
    ${payout ? `<p class="facts">Payout <code>${esc(payout.id)}</code> — status ${stateTag(payout.status)}</p>
    <details class="sandbox-tools"><summary>Test payout outcomes</summary><p class="muted">Optional sandbox controls to see how your integration handles a bank’s response.</p>
    <form method="post" action="/steps/pay/simulate" class="outcomes">${PAYOUT_OUTCOMES.map(o => `<button name="outcome" value="${esc(o)}"${live(state)}>Simulate ${esc(o)}</button>`).join(' ')}</form></details>` : ''}
    ${integrationDetails(`<p><code>POST /accounts/wallet/sandbox/simulate-deposit</code> funds the sandbox wallet, <code>POST /accounts/wallet/pay-invoice/</code> pays what the invoice still owes, Abillio creates the payout; <code>POST …/payouts/{id}/sandbox/simulate</code> settles it as the bank would.</p>
    ${paid ? funding : ''}`)}
  `, expanded);
}

export function eventsPanel(state: State, publicUrl: string | null, status: StepStatus = stepStatuses(state)[4], expanded?: boolean): string {
  const w = state.webhook;
  // A log, newest first: one line per event, payloads available on demand. An event
  // that names nothing of this walk (a reset's demo freelancers, a walk left
  // behind, a test delivery) says so: step 5 does not count it.
  const rows = [...state.events].reverse().slice(0, 30).map(e => `<li><details><summary><small class="when">${esc(e.received_at)}</small> <code>${esc(e.event_type)}</code> <span class="tags"><span class="tag">${esc(e.via)}</span>${aboutThisWalk(state, e) ? '' : ' <span class="tag">not this walk</span>'}</span></summary>${jsonBlock(e.data)}</details></li>`).join('');
  const count = state.events.filter(e => aboutThisWalk(state, e)).length;
  return stepPanel(5, status, count ? `${count} update${count === 1 ? '' : 's'} received for this walkthrough.` : 'Receive status updates from Abillio.', `
    <p class="step-copy">Your company keeps track of onboarding, invoices and payouts through updates from Abillio.</p>
    <p class="facts">${count ? `${count} update${count === 1 ? '' : 's'} received for this walkthrough.` : 'Waiting for the first update about this walkthrough.'}</p>
    ${!publicUrl ? '<p class="muted">This demo checks for updates automatically every 5 seconds. No action is needed here.</p>' : ''}
    ${publicUrl ? `<div class="button-row"><form method="post" action="/steps/events/connect"><button${live(state)}>${w ? 'Reconnect' : 'Connect webhooks'}</button></form></div>` : ''}
    ${integrationDetails(`
    ${publicUrl
      ? `<p>Public URL <code>${esc(publicUrl)}</code>. <code>POST /accounts/notifications/channels/</code> + <code>POST /accounts/notifications/subscriptions/</code>; deliveries arrive at <code>/webhooks/abillio</code>, signed.</p>
         ${w ? `<form method="post" action="/steps/events/test"><button class="secondary"${live(state)}>Send a test delivery</button></form>` : ''}
         ${w ? `<p class="facts">Channel <code>${esc(w.channel_id)}</code>, subscription <code>${esc(w.subscription_id ?? '(none yet: press Reconnect)')}</code>.</p>` : ''}`
      : `<p class="muted">No <code>PUBLIC_URL</code>: webhooks are off and the server polls every 5 s instead (<code>npm run tunnel</code> prints how to get a public URL).</p>`}
    <ul class="events" id="event-log">${rows || '<li class="empty">Nothing received yet.</li>'}</ul>`)}
  `, expanded);
}

export function companyPage(input: CompanyPageInput): string {
  const steps = stepStatuses(input.state);
  const update = latestUpdate(input.state);
  // Keep one task in view. In-progress onboarding comes before the next
  // company action; an unsuccessful action stays open so it can be corrected.
  const focus = input.focusStep ? input.focusStep - 1 : steps.findIndex(s => s === 'active' || s === 'current');
  // `data-confirm` is asked by app.js, which then leaves the button usable on
  // a "no" (an inline onsubmit would not stop app.js from disabling it).
  // Start over sits with the progress line in the banner: it starts the
  // walk the line counts over.
  const startOver = `<form method="post" action="/reset" data-confirm="Reset the sandbox demo data and forget this walk?"><button class="secondary"${live(input.state)}>Start over</button></form>`;
  // `data-events` identifies the company view for app.js. The receipt's key
  // is compared with the stream snapshot to catch a missed event.
  // Diagnostics remain available after the walkthrough, without competing
  // with the current action.
  const panels = [
    keyPanel(input.key, input.state, steps[0], focus === 0),
    onboardingPanel(input.state, input.publicUrl, steps[1], focus === 1, input.abillioOrigin ?? null),
    issuePanel(input.state, steps[2], focus === 2),
    payPanel(input.state, steps[3], focus === 3),
    eventsPanel(input.state, input.publicUrl, steps[4], focus === 4),
  ];
  const body = `<main id="main" class="office" data-events="${esc(input.state.events.length)}">
      <aside class="live-update" data-live-update data-update="${esc(JSON.stringify(update))}"${update ? '' : ' hidden'}>
        <div class="live-update-copy" role="status" aria-live="polite" aria-atomic="true">
          <p class="live-update-title" data-update-title>${update ? esc(update.title) : ''}</p>
          <p class="live-update-detail" data-update-detail>${update ? `${update.via === 'webhook' ? 'Webhook received' : 'Update found by polling'} · ${esc(update.receivedAt)}` : ''}</p>
        </div>
        <div class="live-update-actions">
          <a href="#event-log" data-update-link>View event</a>
          <button type="button" class="secondary" data-update-refresh hidden>Refresh view</button>
        </div>
      </aside>
      ${errorBox(input.error)}
      ${steps.every(s => s === 'done') ? '<p class="walk-complete"><b>Walkthrough complete.</b> The invoice is paid and updates have been received. Open a step to review the result, or use Start over to try this shared demo from the beginning.</p>' : ''}
      ${rail(steps, panels)}
    <details class="console developer-console" id="integration">
      <summary><span><b>Under the hood</b><span class="console-description">API requests, responses and stored data</span></span></summary>
      ${tracePanel(input.trace)}
      <details class="console-section store-section" id="store"><summary><h2 id="store-title">What we store</h2></summary><p class="muted"><code>data/state.json</code> — the fields a real integration keeps in its own database.</p>${jsonBlock(input.state)}</details>
    </details>
  </main><script src="/public/steps.js"></script><script src="/public/popup.js"></script>`;
  return page('Back office', body, { current: 'office', steps, controls: startOver });
}
