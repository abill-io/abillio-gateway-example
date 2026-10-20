import type { State } from '../lib/store.ts';
import { esc, page } from './layout.ts';
import { stepStatuses } from './partials.ts';

// The partner's own sign-up page, built from the same parts as the back
// office: the form is the one primary action, and the session status sits in
// a console beside it, as the trace does there.
export function joinPage(state: State, abillioOrigin: string | null): string {
  const f = state.freelancer;
  return page('Join Brightline Tutors', `<main id="main" class="join">
    <section class="panel join-card" aria-labelledby="join-title">
      <h1 id="join-title">Teach with Brightline Tutors</h1>
      <p class="lede">This is the partner's own sign-up page. The form posts to the partner's server, which mints an Abillio onboarding session; the browser only opens the link Abillio returns.</p>
      <p class="note">This demo is shared: what you type here is shown to everyone who opens it. Keep the made-up name and the @example.com address, and use test details in the popup.</p>
      <form id="join" class="join-form" data-origin="${esc(abillioOrigin ?? '')}" data-session="${f ? 'stored' : ''}">
        <label>First name <input name="first_name" required value="Anna"></label>
        <label>Last name <input name="last_name" required value="Ozola"></label>
        <label class="wide">E-mail <input name="email" type="email" required value="${esc(`anna+${Date.now().toString(36)}@example.com`)}"></label>
        <label>Tax country <select name="tax_country"><option>LV</option><option>EE</option><option>LT</option><option>DE</option></select></label>
        <label>Language <select name="locale"><option value="lv">Latviešu</option><option value="en">English</option></select></label>
        <button class="wide">Continue with Abillio</button>
      </form>
      <p id="popup-note" class="note" aria-live="polite"></p>
    </section>
    <section class="console" id="session" aria-labelledby="session-title">
      <h2 id="session-title">Session status</h2>
      <p class="muted">The server polls <code>GET /onboarding/sessions/{id}</code> every 3 s until <code>can_be_paid</code> is true. The popup also posts a message when it closes.</p>
      <div id="status">${f ? `<p>Session <code>${esc(f.session_id)}</code> for <b>${esc(f.email)}</b>.</p>` : '<p class="empty">No session yet.</p>'}</div>
    </section>
  </main>
  <script src="/public/popup.js"></script>`, { current: 'join', steps: stepStatuses(state) });
}
