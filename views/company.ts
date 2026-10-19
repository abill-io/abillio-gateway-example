import type { State } from '../lib/store.ts';
import type { TraceEntry } from '../lib/trace.ts';
import type { KeyReport } from '../steps/01-key.ts';
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

export function placeholderPanel(n: number, title: string): string {
  return `<section class="panel" id="step-${esc(n)}"><h2>Step ${esc(n)} — ${esc(title)}</h2><p class="muted">Coming in a later task.</p></section>`;
}

export function companyPage(input: CompanyPageInput): string {
  const body = `<main class="two-col">
    <div>
      ${errorBox(input.error)}
      ${keyPanel(input.key, input.state)}
      ${placeholderPanel(2, 'Onboarding')}
      ${placeholderPanel(3, 'Issue')}
      ${placeholderPanel(4, 'Pay')}
      ${placeholderPanel(5, 'Events')}
      <section class="panel"><h2>What we store</h2><p class="muted"><code>data/state.json</code> — the fields a real integration keeps in its own database.</p>${jsonBlock(input.state)}</section>
    </div>
    <aside>${tracePanel(input.trace)}</aside>
  </main>`;
  return page('Back office', body);
}
