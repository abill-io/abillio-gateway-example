import type { State } from '../lib/store.ts';
import { esc, page, progressLine } from './layout.ts';
import { stepStatuses } from './partials.ts';

// The freelancer sees the partner's invitation and why they need Abillio.
// Integration diagnostics stay available in a disclosure for demo viewers.
export function joinPage(state: State, abillioOrigin: string | null): string {
  const f = state.freelancer;
  return page('Join Your Company', `<main id="main" class="join">
    <section class="join-intro" aria-labelledby="join-title">
      <h1 id="join-title">Work with Your Company</h1>
      <p class="lede">To receive payments for your work, connect with Abillio — our partner for invoicing and payouts.</p>
      <ol class="join-steps">
        <li><span class="join-step-number" aria-hidden="true">1</span><div><h2>Share your details</h2><p>Start with your name, e-mail and tax country so we can begin your setup.</p></div></li>
        <li><span class="join-step-number" aria-hidden="true">2</span><div><h2>Set up your Abillio account</h2><p>Continue in the Abillio window. Complete the requested details, identity checks and payout setup.</p></div></li>
        <li><span class="join-step-number" aria-hidden="true">3</span><div><h2>Get ready to be paid</h2><p>Once Abillio confirms your setup, Your Company can issue invoices in your name and pay you for your work.</p></div></li>
      </ol>
    </section>
    <section class="panel join-card" aria-labelledby="join-form-title">
      <h2 id="join-form-title">Connect with Abillio</h2>
      <p class="join-form-intro">Your first step to receiving payments from Your Company.</p>
      <p class="note">This demo is shared: what you type here is shown to everyone who opens it. Keep the made-up name and the @example.com address, and use test details in the popup.</p>
      <form id="join" class="join-form" data-origin="${esc(abillioOrigin ?? '')}" data-session="${f ? 'stored' : ''}">
        <label>First name <input name="first_name" required value="Anna"></label>
        <label>Last name <input name="last_name" required value="Ozola"></label>
        <label class="wide">E-mail <input name="email" type="email" required value="${esc(`anna+${Date.now().toString(36)}@example.com`)}"></label>
        <label>Tax country <select name="tax_country"><option>LV</option><option>EE</option><option>LT</option><option>DE</option></select></label>
        <label>Language <select name="locale"><option value="lv">Latviešu</option><option value="en">English</option></select></label>
        <button class="wide">Continue with Abillio</button>
      </form>
      <p class="join-handoff">Abillio opens in a separate window. You’ll return here when you finish your setup.</p>
      <p id="popup-note" class="note" aria-live="polite"></p>
    </section>
    <details class="console join-technical" id="session">
      <summary>How this demo connects to Abillio</summary>
      <p class="muted">This is the partner's own sign-up page. The form posts to the partner's server, which mints an Abillio onboarding session; the browser only opens the link Abillio returns.</p>
      ${progressLine(stepStatuses(state), '')}
      <h2 id="session-title">Session status</h2>
      <p class="muted">The server polls <code>GET /onboarding/sessions/{id}</code> every 3 s until <code>can_be_paid</code> is true. The popup also posts a message when it closes.</p>
      <div id="status">${f ? `<p>Session <code>${esc(f.session_id)}</code> for <b>${esc(f.email)}</b>.</p>` : '<p class="empty">No session yet.</p>'}</div>
    </details>
  </main>
  <script src="/public/popup.js"></script>`, { current: 'join' });
}
