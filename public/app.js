(() => {
  // Set once a button's form is on its way: its answer is a fresh page anyway.
  let submitting = false;
  let resumeUpdates = () => {};
  // The buttons a submit disabled, so they and only they come back.
  const disabled = new Set();
  // A form whose navigation was abandoned (stopped, a dead connection) or a
  // page restored from the back/forward cache: no answer is coming, so the
  // buttons are usable again and stored events refresh the page again.
  const settle = () => {
    submitting = false;
    for (const b of disabled) { b.disabled = false; b.classList.remove('is-working'); }
    disabled.clear();
    resumeUpdates();
  };
  window.addEventListener('pageshow', event => { if (event.persisted) settle(); });

  // Show what arrived before refreshing. Never replace an edited form, an
  // action in flight, or an error the reader is still trying to resolve.
  // Navigation is always GET /: reloading a POST route would resend a step.
  // The join page follows its own session and does not listen to this stream.
  const live = document.querySelector('main[data-events]');
  if (live) {
    const notice = live.querySelector('[data-live-update]');
    const title = notice.querySelector('[data-update-title]');
    const detail = notice.querySelector('[data-update-detail]');
    const refreshButton = notice.querySelector('[data-update-refresh]');
    const eventLink = notice.querySelector('[data-update-link]');
    const rendered = JSON.parse(notice.dataset.update);
    const receiptKey = 'gateway-example-refreshed-update';
    let pending = null;
    let hasEdits = false;
    let refreshTimer = null;
    const focusedField = () => /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');
    const hasError = () => Boolean(live.querySelector('.error-box'));
    const receipt = update => {
      const at = new Date(update.receivedAt);
      const time = Number.isNaN(at.getTime()) ? '' : ` · ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      return `${update.via === 'webhook' ? 'Webhook received' : 'Update found by polling'}${time}`;
    };
    if (rendered) {
      let refreshed = false;
      try {
        refreshed = sessionStorage.getItem(receiptKey) === rendered.key;
        sessionStorage.removeItem(receiptKey);
      } catch { /* The receipt still shows when storage is unavailable. */ }
      detail.textContent = `${receipt(rendered)}${refreshed ? ' · View refreshed.' : ''}`;
    }
    const refresh = () => {
      if (pending) {
        try { sessionStorage.setItem(receiptKey, pending.key); } catch { /* Optional feedback across navigation. */ }
      }
      location.replace('/');
    };
    const showPending = () => {
      if (!pending) return;
      clearTimeout(refreshTimer);
      refreshTimer = null;
      notice.hidden = false;
      notice.classList.add('is-pending');
      title.textContent = pending.title;
      eventLink.hidden = true;
      const hold = submitting || hasEdits || focusedField() || hasError();
      refreshButton.hidden = submitting || !hold;
      let next = 'Refreshing view…';
      if (submitting) next = 'Waiting for your current action to finish.';
      else if (hasEdits) next = 'Your unsent changes are kept. Refresh when ready.';
      else if (focusedField()) next = 'Finish with the form, then refresh when ready.';
      else if (hasError()) next = 'Refresh when you have finished reviewing the error.';
      detail.textContent = `${receipt(pending)} · ${next}`;
      if (!hold) {
        refreshTimer = setTimeout(() => {
          if (submitting || hasEdits || focusedField() || hasError()) showPending();
          else refresh();
        }, 1200);
      }
    };
    const receive = event => {
      let update;
      try { update = JSON.parse(event.data); } catch { return; }
      if (!update || typeof update.key !== 'string' || typeof update.title !== 'string' || update.key === rendered?.key) return;
      pending = update;
      showPending();
    };
    for (const form of live.querySelectorAll('form')) {
      const edited = () => { hasEdits = true; showPending(); };
      form.addEventListener('input', edited);
      form.addEventListener('change', edited);
    }
    refreshButton.addEventListener('click', () => {
      if (hasEdits && !confirm('Refresh the view and discard your unsent changes?')) return;
      refresh();
    });
    resumeUpdates = showPending;
    const source = new EventSource('/events');
    source.addEventListener('refresh', receive);
    source.addEventListener('snapshot', receive);
  }

  for (const form of document.querySelectorAll('form')) {
    form.addEventListener('submit', event => {
      // A form that asks first (Start over) sends nothing on a "no", and its
      // button stays usable.
      if (form.dataset.confirm && !confirm(form.dataset.confirm)) { event.preventDefault(); return; }
      // The pressed button reads "Working…" (style.css) while its page is on
      // the way. Not on a form the page sends itself (the join page): nothing
      // replaces that page, and its own status line says what happens.
      const pressed = event.defaultPrevented ? null : event.submitter;
      // Disabled AFTER the browser has read the form data: a button disabled
      // inside the submit handler drops its own name/value (the simulate
      // outcome buttons rely on it).
      setTimeout(() => {
        for (const b of form.querySelectorAll('button')) if (!b.disabled) { b.disabled = true; disabled.add(b); }
        if (pressed && disabled.has(pressed)) pressed.classList.add('is-working');
      }, 0);
      // A form the page sends itself (the join page's fetch) navigates nowhere.
      if (event.defaultPrevented) return;
      submitting = true;
      // An answer replaces this page within seconds; still here after 30 s,
      // the navigation was abandoned. The trade-off: a request slower than
      // that gets its buttons back while it is still out, and a second press
      // then goes out under the same stored key, so Abillio replays it rather
      // than doing it twice (the deposit and the test delivery, which take a
      // fresh key each press, would run again); without the timeout a page
      // whose navigation died would stay disabled and deaf to new events.
      setTimeout(settle, 30_000);
    });
  }
})();
