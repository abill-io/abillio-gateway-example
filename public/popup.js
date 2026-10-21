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
  // The join page's card shows the form (#join-start) until Abillio confirms
  // the signup, then what happens next in its place (#join-done, with its
  // heading). The popup's own message goes under How this demo connects to
  // Abillio (#popup-message), next to the session's status (views/join.ts).
  // The page and this script are two requests, so the page can come from a
  // server older than the script (a process started before an update, a
  // rolling deploy part way through), without these elements: the note then
  // says it all, as it did before the done card.
  const start = document.getElementById('join-start');
  const done = document.getElementById('join-done');
  const doneTitle = document.getElementById('join-done-title');
  const heard = document.getElementById('popup-message');
  const doneCard = Boolean(start && done && doneTitle);
  let abillioOrigin = form.dataset.origin || null;
  let popup = null;
  let timer = null;
  // The note says up to three things at once: what the popup or the page
  // last said (a blocked popup's link, a refused mint; on the back office,
  // Abillio's message and where the update link stands), where the join
  // page's signup stands, and why the last status check failed, until one
  // succeeds. A failed check must not wipe the link a blocked popup left to
  // open by hand.
  let said = '';
  let progress = '';
  let failure = '';
  const sayNote = () => { note.textContent = [said, progress, failure].filter(Boolean).join(' '); };
  // Whether the join page follows a signup it opened: after its own
  // Continue, or once Abillio's popup has posted to it. Only then does the
  // card speak about the signup. The session stored when the page was opened
  // may be another visitor's (the back office's Try another signup lands
  // here), so what it answers stays in the console.
  let ours = false;
  // Whether Abillio has confirmed that signup: from then on the card says so.
  let finished = false;

  // The status is Abillio's answer relayed by our server. It is still escaped
  // before it becomes HTML, as every value on the server-rendered pages is.
  const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

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

  // The signup the join page opened is done: the done card takes the form's
  // place, and the focus the form held, and nothing the note said about the
  // signup still applies. A page without the done card says it in the note.
  const showDone = () => {
    if (finished) return;
    finished = true;
    said = '';
    progress = doneCard ? '' : 'You’re set up: Abillio confirmed you can be paid. Your Company can now issue your first invoice.';
    if (!doneCard) return;
    start.hidden = true;
    done.hidden = false;
    doneTitle.focus();
  };

  // The join page. The console shows the session as Abillio answers it, its
  // state and its rows by their keys, and until the freelancer can be paid
  // what Abillio is still waiting on. The poll stops once they can be paid or
  // the link is over. For the signup this page opened, the card says it in
  // plain words: what is still open, so a popup closed half way does not read
  // as nothing having happened, and once Abillio confirms they can be paid,
  // the done card.
  const renderJoin = s => {
    const rows = (s.requirements || []).map(r => `<li><code>${esc(r.key)}</code> ${esc(r.state)}</li>`).join('');
    const over = s.can_be_paid || s.state === 'complete' || s.state === 'expired';
    const open = (s.requirements || []).filter(r => r.state !== 'done').map(r => `<code>${esc(r.key)}</code> ${esc(r.state)}`).join(', ');
    const waiting = s.state !== 'none' && !over ? `<p class="muted">Not payable yet${open ? ` — Abillio is still waiting on: ${open}` : ''}. The page keeps asking every 3 s.</p>` : '';
    status.innerHTML = `<p>state <b>${esc(s.state)}</b>, can_be_paid <b>${esc(s.can_be_paid)}</b>${s.engagement_id ? `, engagement <code>${esc(s.engagement_id)}</code>` : ''}</p><ul>${rows}</ul>` +
      (s.can_be_paid ? '<p class="ok">The freelancer can be paid. Go to the <a href="/">back office</a> and issue the first invoice.</p>' : waiting);
    if (over) clearInterval(timer);
    if (!ours || finished) return;
    if (s.can_be_paid || s.state === 'complete') { showDone(); return; }
    const left = (s.requirements || []).filter(r => r.state !== 'done').map(plainRow).join('; ');
    if (s.state === 'expired') progress = 'The link expired before your setup was finished: press Continue with Abillio for a new one.';
    else if (s.state === 'none') progress = 'This walk was reset — reload the page.';
    else progress = `Your setup is not finished yet.${left ? ` Still open: ${left}.` : ''} This page checks again every 3 s.`;
  };

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
    const line = `Abillio says: state ${event.data.state}, can_be_paid ${event.data.can_be_paid} (session ${event.data.session_id}).`;
    if (!join) { said = line; sayNote(); follow(); return; }
    // The join page keeps the line itself in the console and says in the card
    // what it means. The status check that follows stores it on the server.
    if (heard) heard.textContent = line; else said = line;
    ours = true;
    if (event.data.can_be_paid === true || event.data.state === 'complete') showDone();
    sayNote();
    poll();
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
    ours = true;
    progress = '';
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
