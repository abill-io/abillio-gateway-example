import type { State } from '../lib/store.ts';
import type { TraceEntry } from '../lib/trace.ts';
import { AbillioError } from '../lib/abillio.ts';
import { issueStage } from '../steps/03-issue.ts';
import { aboutThisWalk } from '../steps/05-events.ts';
import { esc } from './layout.ts';

export type StepStatus = 'done' | 'active' | 'current' | 'upcoming';

// Where the walk stands, read off the stored state: the key check stored the
// account (1), Abillio says the freelancer can be paid (2), the invoice is past
// its draft (3) and paid (4), and Abillio has told us something about this
// walk, by webhook or poll (5): what a reset sends about its demo freelancers,
// or a test delivery, does not count. Step 2 is under way from the join until
// then, since the engagement exists as soon as the link is opened, before any
// consent. The first step neither done nor under way is the current one: while
// the freelancer onboards, step 3 is up next (a 409 there lists what they
// still owe). A later step can be done before an earlier one (events come in
// while the freelancer onboards).
export function stepStatuses(state: State): StepStatus[] {
  const done = [
    Boolean(state.account),
    state.freelancer?.can_be_paid === true,
    issueStage(state) === 'issued',
    state.invoice?.status === 'paid',
    state.events.some(e => aboutThisWalk(state, e)),
  ];
  const underWay = (i: number) => i === 1 && Boolean(state.freelancer) && !done[1];
  const current = done.findIndex((d, i) => !d && !underWay(i));
  return done.map((d, i) => (d ? 'done' : underWay(i) ? 'active' : i === current ? 'current' : 'upcoming'));
}

const STATUS_LABEL: Record<StepStatus, string> = { done: 'Done', active: 'In progress', current: 'Up next', upcoming: 'Not yet' };

// A step panel's head: its title, and where it stands in words, so the status
// does not rest on the rail marker's colour alone.
export function stepHead(n: number, title: string, status: StepStatus): string {
  return `<div class="step-head"><h2 id="step-${esc(n)}-title">${esc(title)}</h2><span class="step-status">${esc(STATUS_LABEL[status])}</span></div>`;
}

const OK = new Set(['available', 'active', 'paid', 'complete', 'completed']);
const BAD = new Set(['forbidden', 'unavailable', 'rejected', 'returned', 'failed', 'cancelled', 'canceled', 'expired', 'overdue']);

// A state or status Abillio answered, as a tag: what went through reads in
// the accent, what failed or is refused in red, anything under way in gray.
export function stateTag(value: string): string {
  const tone = OK.has(value) ? 'ok' : BAD.has(value) ? 'bad' : 'neutral';
  return `<code class="state is-${tone}">${esc(value)}</code>`;
}

const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// The numbered rail the five panels hang on: each step's marker (its number,
// a check once done) on one line, so the order and the progress read at a
// glance. A step under way keeps its number.
export function rail(statuses: StepStatus[], panels: string[]): string {
  return `<ol class="rail">${panels.map((panel, i) => `<li class="step is-${esc(statuses[i])}"><span class="step-marker" aria-hidden="true">${statuses[i] === 'done' ? CHECK : esc(i + 1)}</span>${panel}</li>`).join('')}</ol>`;
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
  return `<section id="trace" class="console-section" aria-labelledby="trace-title"><h2 id="trace-title">What we sent to Abillio</h2><p class="muted">Newest first. Headers are not shown. Secrets read <code>[redacted]</code> everywhere, and in Abillio's answers so do the onboarding link (the freelancer's to open) and the keys named for personal data: e-mail addresses, first, last and legal names, contact persons, phone numbers, addresses, bank accounts, personal codes, registration and VAT numbers. Display names and free text (notes, descriptions, invite messages) stay readable, and what you type on the join page shows as typed in the request. Everything else is exactly the wire.</p>${rows || '<p class="empty">Nothing yet — press a button.</p>'}</section>`;
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
      ? `<ul class="blockers">${err.blockers.map(b => `<li><code>${esc(b.code)}</code> ${esc(b.message)}${b.capability ? ` <small>(${esc(b.capability)})</small>` : ''}</li>`).join('')}</ul>`
      : '';
    const fields = Object.entries(err.fieldErrors ?? {}).map(([f, m]) => `<li><code>${esc(f)}</code> ${esc(Array.isArray(m) ? m.join('; ') : m)}</li>`).join('');
    return `<div class="error-box" role="alert"><p class="error-title"><b>${esc(err.status)} ${esc(err.code)}</b> — ${esc(err.message)}</p>${err.hint ? `<p>${esc(err.hint)}</p>` : ''}${blockers}${fields ? `<ul class="fields-errors">${fields}</ul>` : ''}${err.requestId ? `<small>request_id ${esc(err.requestId)}</small>` : ''}</div>`;
  }
  return `<div class="error-box" role="alert"><p class="error-title">${esc((err as Error).message ?? String(err))}</p></div>`;
}
