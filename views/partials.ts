import type { State } from '../lib/store.ts';
import type { TraceEntry } from '../lib/trace.ts';
import { AbillioError } from '../lib/abillio.ts';
import { setupDone } from '../steps/02-onboard.ts';
import { issueStage } from '../steps/03-issue.ts';
import { aboutThisWalk } from '../steps/05-events.ts';
import { esc } from './layout.ts';

export type StepStatus = 'done' | 'active' | 'current' | 'upcoming';

// Where the walk stands, read off the stored state: the key check stored the
// account (1), Abillio says the freelancer can be paid and nothing a
// simulation reopened is due (2, `setupDone`), the invoice is past its draft
// (3) and paid (4), and Abillio has told us something about this walk, by
// webhook or poll (5): what a reset sends about its demo freelancers, or a
// test delivery, does not count. Step 2 is under way from the join until
// then, since the engagement is known from when they agree, long before they
// can be paid, and again while a reopened requirement is open (step 2b). The
// first step neither done nor under way is the current one: while the
// freelancer onboards, step 3 is up next (a 409 there lists what they still
// owe). A later step can be done before an earlier one (events come in while
// the freelancer onboards).
export function stepStatuses(state: State): StepStatus[] {
  const done = [
    Boolean(state.account),
    setupDone(state.freelancer),
    issueStage(state) === 'issued',
    state.invoice?.status === 'paid',
    state.events.some(e => aboutThisWalk(state, e)),
  ];
  const underWay = (i: number) => i === 1 && Boolean(state.freelancer) && !done[1];
  const current = done.findIndex((d, i) => !d && !underWay(i));
  return done.map((d, i) => (d ? 'done' : underWay(i) ? 'active' : i === current ? 'current' : 'upcoming'));
}

const STATUS_LABEL: Record<StepStatus, string> = { done: 'Done', active: 'In progress', current: 'Up next', upcoming: 'Not yet' };

const STEP_TITLES = [
  'Step 1 — Does the key work?',
  'Step 2 — The freelancer joins',
  "Step 3 — Issue an invoice in the freelancer's name",
  'Step 4 — Pay it from the wallet',
  'Step 5 — Hear from Abillio',
];

// A step panel's head: its title, and where it stands in words, so the status
// does not rest on the rail marker's colour alone.
export function stepHead(n: number, status: StepStatus): string {
  const label = esc(STATUS_LABEL[status]);
  return `<h2 id="step-${esc(n)}-title">${esc(STEP_TITLES[n - 1])}</h2><span class="step-status">${status === 'done' ? `<span class="visually-hidden">${label}</span>${CHECK}` : label}</span>`;
}

// Native disclosures keep every step accessible without JavaScript. The
// summary retains the result when a completed step is folded away.
export function stepPanel(n: number, status: StepStatus, hint: string, body: string, expanded = status === 'current' || status === 'active'): string {
  return `<details class="panel step-panel" id="step-${n}"${expanded ? ' open' : ''}>
    <summary class="step-head">${stepHead(n, status)}<span class="step-hint">${esc(hint)}</span></summary>
    <div class="step-body">${body}</div>
  </details>`;
}

const OK = new Set(['available', 'active', 'paid', 'complete', 'completed']);
const BAD = new Set(['forbidden', 'unavailable', 'rejected', 'returned', 'failed', 'cancelled', 'canceled', 'expired', 'overdue']);

// A state or status Abillio answered, as a tag: successful states read in
// green, refusals in red, other states in gray.
export function stateTag(value: string): string {
  const tone = OK.has(value) ? 'ok' : BAD.has(value) ? 'bad' : 'neutral';
  return `<code class="state is-${tone}">${esc(value)}</code>`;
}

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Keep the step number on the left; its completion check is in the summary.
export function rail(statuses: StepStatus[], panels: string[]): string {
  return `<ol class="rail">${panels.map((panel, i) => `<li class="step is-${esc(statuses[i])}"><span class="step-marker" aria-hidden="true">${esc(i + 1)}</span>${panel}</li>`).join('')}</ol>`;
}

export function jsonBlock(value: unknown): string {
  return `<pre class="json">${esc(JSON.stringify(value, null, 2))}</pre>`;
}

export function tracePanel(entries: TraceEntry[]): string {
  const rows = [...entries].reverse().map(e => `
    <details class="trace"${e === entries.at(-1) ? ' open' : ''}>
      <summary><span class="trace-call"><code><span class="method">${esc(e.method)}</span> ${esc(e.path)}</code> → <b class="${esc(statusClass(e.status))}">${esc(e.status ?? 'network error')}</b>${e.replayed ? ' <span class="tag">Idempotent-Replay</span>' : ''}${(e.count ?? 1) > 1 ? ` <span class="tag" title="The same read, answered the same, ${esc(e.count)} times">×${esc(e.count)}</span>` : ''}</span><span class="trace-meta">${e.idempotencyKey ? `<small>Idempotency-Key ${esc(e.idempotencyKey)}</small> ` : ''}<small>${esc(e.at)}</small></span></summary>
      ${e.requestBody !== null ? `<h3>Request body</h3>${jsonBlock(e.requestBody)}` : ''}
      <h3>Response</h3>${jsonBlock(e.responseBody)}
      ${e.error ? `<p class="error">${esc(e.error)}</p>` : ''}
    </details>`).join('');
  return `<section id="trace" class="console-section" aria-labelledby="trace-title"><h2 id="trace-title">What we sent to Abillio</h2><details class="trace-note"><summary>Newest first. Headers are not shown.</summary><p class="muted">Secrets read <code>[redacted]</code> everywhere, and in Abillio's answers so do the onboarding link (the freelancer's to open) and the keys named for personal data: e-mail addresses, first, last and legal names, contact persons, phone numbers, addresses, bank accounts, personal codes, registration and VAT numbers. Display names and free text (notes, descriptions, invite messages) stay readable, and what you type on the join page shows as typed in the request. Everything else is exactly the wire.</p></details>${rows || '<p class="empty">Nothing yet — press a button.</p>'}</section>`;
}

// The answer's class, so the status reads as a colour too: 2xx went through,
// anything else (or no answer at all) did not.
function statusClass(status: number | null): string {
  return status === null ? 'code is-bad' : status < 300 ? 'code is-ok' : status < 400 ? 'code is-neutral' : 'code is-bad';
}

export function errorBox(err: unknown): string {
  if (!err) return '';
  if (err instanceof AbillioError) {
    const blockers = err.blockers.length
      ? `<ul class="blockers">${err.blockers.map(b => `<li><span class="blocker-message">${esc(b.message)}</span><span class="blocker-meta"><code>${esc(b.code)}</code>${b.capability ? ` <small>(${esc(b.capability)})</small>` : ''}</span></li>`).join('')}</ul>`
      : '';
    const fields = Object.entries(err.fieldErrors ?? {}).map(([f, m]) => `<li><code>${esc(f)}</code> ${esc(Array.isArray(m) ? m.join('; ') : m)}</li>`).join('');
    return `<div class="error-box" role="alert"><p class="error-title">${esc(err.message)}</p><p class="error-code"><code>${esc(err.status)} ${esc(err.code)}</code></p>${err.hint ? `<p>${esc(err.hint)}</p>` : ''}${blockers}${fields ? `<ul class="fields-errors">${fields}</ul>` : ''}${err.requestId ? `<small>request_id ${esc(err.requestId)}</small>` : ''}</div>`;
  }
  return `<div class="error-box" role="alert"><p class="error-title">${esc((err as Error).message ?? String(err))}</p></div>`;
}
