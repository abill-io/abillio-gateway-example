import type { State } from '../lib/store.ts';
import { esc, page } from './layout.ts';

export function joinPage(state: State, abillioOrigin: string | null): string {
  const f = state.freelancer;
  return page('Join Acme Tutors', `<main class="one-col">
    <section class="panel">
      <h1>Teach with Acme Tutors</h1>
      <p>This is the partner's own sign-up page. The form posts to the partner's server, which mints an Abillio onboarding session; the browser only opens the link Abillio returns.</p>
      <form id="join" data-origin="${esc(abillioOrigin ?? '')}">
        <label>First name <input name="first_name" required value="Anna"></label>
        <label>Last name <input name="last_name" required value="Ozola"></label>
        <label>E-mail <input name="email" type="email" required value="${esc(f?.email ?? `anna+${Date.now().toString(36)}@example.com`)}"></label>
        <label>Tax country <select name="tax_country"><option>LV</option><option>EE</option><option>LT</option><option>DE</option></select></label>
        <label>Language <select name="locale"><option value="lv">Latviešu</option><option value="en">English</option></select></label>
        <button>Continue with Abillio</button>
      </form>
      <p id="popup-note" class="muted"></p>
    </section>
    <section class="panel" id="session">
      <h2>Session status</h2>
      <p class="muted">The server polls <code>GET /onboarding/sessions/{id}</code> every 3 s until <code>can_be_paid</code> is true. The popup also posts a message when it closes.</p>
      <div id="status">${f ? `<p>Session <code>${esc(f.session_id)}</code> for <b>${esc(f.email)}</b>.</p>` : '<p class="muted">No session yet.</p>'}</div>
    </section>
  </main>
  <script src="/public/popup.js"></script>`);
}
