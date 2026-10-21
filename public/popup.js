// Opens the Abillio onboarding link in a popup and listens for the one
// message it posts when it is done. Two forms use it: the join page's
// (#join), which mints a first link for the address typed there, and step
// 2's Send a new link on the back office (#update-link), which mints an
// update link for the freelancer already stored once a requirement has
// reopened (step 2b). Two checks before trusting the message: the sender's
// origin must be Abillio's (derived server-side from the session url) and
// `data.source` must be "abillio". Everything else is ignored.
(() => {
  const join = document.getElementById('join');
  const form = join || document.getElementById('update-link');
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

  // The join page: until the freelancer can be paid, one sentence names what
  // Abillio is still waiting on: a popup closed half way must not read as
  // nothing having happened. The poll stops once they can be paid or the link
  // is over, and the sentence goes with it.
  const renderJoin = s => {
    const rows = (s.requirements || []).map(r => `<li><code>${esc(r.key)}</code> ${esc(r.state)}</li>`).join('');
    const over = s.can_be_paid || s.state === 'complete' || s.state === 'expired';
    const open = (s.requirements || []).filter(r => r.state !== 'done').map(r => `<code>${esc(r.key)}</code> ${esc(r.state)}`).join(', ');
    const waiting = s.state !== 'none' && !over ? `<p class="muted">Not payable yet${open ? ` — Abillio is still waiting on: ${open}` : ''}. The page keeps asking every 3 s.</p>` : '';
    status.innerHTML = `<p>state <b>${esc(s.state)}</b>, can_be_paid <b>${esc(s.can_be_paid)}</b>${s.engagement_id ? `, engagement <code>${esc(s.engagement_id)}</code>` : ''}</p><ul>${rows}</ul>` +
      (s.can_be_paid ? '<p class="ok">The freelancer can be paid. Go to the <a href="/">back office</a> and issue the first invoice.</p>' : waiting);
    if (over) clearInterval(timer);
  };

  // The session's rows in plain words: what step 2 also names, in its words
  // (views/company.ts), the tax country as the join form calls it, and any
  // other key by its own name.
  const ROW_NAMES = new Map([
    ['kyc', 'identity verification'],
    ['payout_method', 'payout method'],
    ['member_fee', 'membership fee'],
    ['country', 'tax country'],
  ]);
  const plainRow = r => `${ROW_NAMES.get(r.key) ?? String(r.key).replaceAll('_', ' ')} (${String(r.state).replaceAll('_', ' ')})`;

  // The back office follows an update link on its `state`, never on
  // `can_be_paid`: a freelancer can be payable while the link still has
  // something to finish (a mandate to grant again, say). Once the link has
  // done its job the page loads itself again, and step 2 reads what the
  // server stored; an expired link, or a walk started over elsewhere (nobody
  // stored any more), stops the follow and says what to do. The note is
  // text, never markup.
  const renderUpdate = s => {
    if (s.state === 'complete' || s.state === 'expired' || s.state === 'none') clearInterval(timer);
    if (s.state === 'complete') { location.replace('/'); return; }
    if (s.state === 'expired') { said = 'The link expired before it was finished: send a new link.'; return; }
    if (s.state === 'none') { said = 'This walk was reset — reload the page.'; return; }
    const open = (s.requirements || []).filter(r => r.state !== 'done').map(plainRow).join('; ');
    said = `Waiting for the freelancer in the Abillio window.${open ? ` Still open: ${open}.` : ''} This page asks again every 3 s.`;
  };

  const render = join ? renderJoin : renderUpdate;

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

  // The popup is 640 by 820, or as much of that as the screen has room for,
  // centred over the window that opened it.
  const popupFeatures = () => {
    const width = Math.min(640, window.screen.availWidth);
    const height = Math.min(820, window.screen.availHeight);
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
    return `popup,width=${width},height=${height},left=${left},top=${top}`;
  };

  // Polls until the session is over (render stops it).
  const follow = () => {
    clearInterval(timer);
    timer = setInterval(poll, 3000);
    poll();
  };
  // The join page follows a session already stored from the start: the
  // engagement is looked up only by this poll, so a page left before the
  // freelancer agreed would otherwise leave step 2 without one until the form
  // is sent again. The back office follows only the link it has just minted,
  // or one whose popup posts back: on load its stored session can be the
  // first link, long done, which says nothing about what reopened since.
  if (join && form.dataset.session) follow();

  window.addEventListener('message', event => {
    if (!abillioOrigin || event.origin !== abillioOrigin) return;
    if (!event.data || event.data.source !== 'abillio') return;
    said = `Abillio says: state ${event.data.state}, can_be_paid ${event.data.can_be_paid} (session ${event.data.session_id}).`;
    sayNote();
    if (join) poll(); else follow();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    // Open the window synchronously on the click so browsers allow the popup;
    // the URL is set once the server has minted the session.
    popup = window.open('about:blank', 'abillio', popupFeatures());
    const res = await fetch(join ? '/join' : '/steps/onboard/update-link', { method: 'POST', body: new URLSearchParams(new FormData(form)) });
    if (!res.ok) {
      popup && popup.close();
      // The update-link route's 409: this page is out of date (Abillio lists
      // nothing left to complete, and the server has dropped the list shown
      // here; or nobody is stored any more), so it loads again.
      if (!join && res.status === 409) { location.replace('/'); return; }
      said = `${join ? 'Could not start' : 'Could not send a new link'}: ${await res.text()}`;
      sayNote();
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
    // Each press mints again, so the button comes back: a freelancer who
    // closed the popup half way goes on where they stopped (an update link
    // still open is handed back as it is).
    for (const b of form.querySelectorAll('button')) b.disabled = false;
    follow();
  });
})();
