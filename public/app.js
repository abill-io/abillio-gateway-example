(() => {
  // Set once a button's form is on its way: its answer is a fresh page anyway.
  let submitting = false;
  // The buttons a submit disabled, so they and only they come back.
  const disabled = new Set();
  // A form whose navigation was abandoned (stopped, a dead connection) or a
  // page restored from the back/forward cache: no answer is coming, so the
  // buttons are usable again and stored events refresh the page again.
  const settle = () => {
    submitting = false;
    for (const b of disabled) b.disabled = false;
    disabled.clear();
  };
  window.addEventListener('pageshow', event => { if (event.persisted) settle(); });

  // A stored webhook or poll result refreshes the back office (the page with
  // the event count) — by navigating to its GET address, never `reload()`:
  // after a button the URL is the POST route, and reloading that would re-send
  // the step. Not while a button's request is out: navigating then would
  // throw its answer away (an error box with it), and that answer is rendered
  // from the state as it is by then. The join page follows its session with
  // its own poll, which a reload would stop (and a half-typed form would be
  // lost); /back is the popup's last page. Neither listens.
  const live = document.querySelector('main[data-events]');
  if (live) {
    const refresh = () => { if (!submitting) location.replace('/'); };
    const source = new EventSource('/events');
    source.addEventListener('refresh', refresh);
    // An event stored after this page was rendered but before its stream
    // connected was announced to nobody: compare the count once per connection.
    source.addEventListener('open', async () => {
      try {
        const state = await (await fetch('/api/state')).json();
        if (state.events.length !== Number(live.dataset.events)) refresh();
      } catch {
        // The next stored event refreshes the page anyway.
      }
    });
  }

  for (const form of document.querySelectorAll('form')) {
    form.addEventListener('submit', event => {
      // A form that asks first (Start over) sends nothing on a "no", and its
      // button stays usable.
      if (form.dataset.confirm && !confirm(form.dataset.confirm)) { event.preventDefault(); return; }
      // Disabled AFTER the browser has read the form data: a button disabled
      // inside the submit handler drops its own name/value (the simulate
      // outcome buttons rely on it).
      setTimeout(() => {
        for (const b of form.querySelectorAll('button')) if (!b.disabled) { b.disabled = true; disabled.add(b); }
      }, 0);
      // A form the page sends itself (the join page's fetch) navigates nowhere.
      if (event.defaultPrevented) return;
      submitting = true;
      // An answer replaces this page within seconds; still here after 30 s,
      // the navigation was abandoned.
      setTimeout(settle, 30_000);
    });
  }
})();
