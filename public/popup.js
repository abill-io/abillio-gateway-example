// Opens the Abillio onboarding link in a popup and listens for the one
// message it posts when it is done. Two checks before trusting the message:
// the sender's origin must be Abillio's (derived server-side from the session
// url) and `data.source` must be "abillio". Everything else is ignored.
(() => {
  const form = document.getElementById('join');
  if (!form) return;
  const note = document.getElementById('popup-note');
  const status = document.getElementById('status');
  let abillioOrigin = form.dataset.origin || null;
  let popup = null;
  let timer = null;
  // The note says two things at once: what the popup or the page last said
  // (a blocked popup's link, Abillio's message), and why the last status
  // check failed, until one succeeds. A failed check must not wipe the link
  // a blocked popup left to open by hand.
  let said = '';
  let failure = '';
  const sayNote = () => { note.textContent = [said, failure].filter(Boolean).join(' '); };

  // The status is Abillio's answer relayed by our server. It is still escaped
  // before it becomes HTML, as every value on the server-rendered pages is.
  const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  const render = s => {
    const rows = (s.requirements || []).map(r => `<li><code>${esc(r.key)}</code> ${esc(r.state)}</li>`).join('');
    status.innerHTML = `<p>state <b>${esc(s.state)}</b>, can_be_paid <b>${esc(s.can_be_paid)}</b>${s.engagement_id ? `, engagement <code>${esc(s.engagement_id)}</code>` : ''}</p><ul>${rows}</ul>` +
      (s.can_be_paid ? '<p class="ok">The freelancer can be paid. Go to the <a href="/">back office</a> and issue the first invoice.</p>' : '');
    if (s.can_be_paid || s.state === 'complete' || s.state === 'expired') clearInterval(timer);
  };

  // A status answer that is not OK (a refused Abillio read, the server
  // unreachable) is said in the note, and the next tick asks again.
  const poll = async () => {
    try {
      const res = await fetch('/join/status');
      if (res.ok) {
        failure = '';
        render(await res.json());
      } else {
        failure = `The status check failed: ${await res.text()}`;
      }
    } catch (err) {
      failure = `The status check failed: ${err.message}`;
    }
    sayNote();
  };

  window.addEventListener('message', event => {
    if (!abillioOrigin || event.origin !== abillioOrigin) return;
    if (!event.data || event.data.source !== 'abillio') return;
    said = `Abillio says: state ${event.data.state}, can_be_paid ${event.data.can_be_paid} (session ${event.data.session_id}).`;
    sayNote();
    poll();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    // Open the window synchronously on the click so browsers allow the popup;
    // the URL is set once the server has minted the session.
    popup = window.open('about:blank', 'abillio', 'popup,width=520,height=760');
    const res = await fetch('/join', { method: 'POST', body: new URLSearchParams(new FormData(form)) });
    if (!res.ok) {
      said = `Could not start: ${await res.text()}`;
      sayNote();
      popup && popup.close();
      // app.js disabled the button a tick after the submit. Nothing navigates
      // away on an error, so give it back for a corrected resubmit.
      for (const b of form.querySelectorAll('button')) b.disabled = false;
      return;
    }
    const session = await res.json();
    abillioOrigin = session.origin;
    said = popup ? '' : `Popup blocked — open ${session.url} yourself.`;
    sayNote();
    if (popup) popup.location = session.url;
    clearInterval(timer);
    timer = setInterval(poll, 3000);
    poll();
  });
})();
