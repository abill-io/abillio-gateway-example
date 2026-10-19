(() => {
  // Set once a button's form is on its way: its answer is a fresh page anyway.
  let submitting = false;
  // A stored webhook or poll result refreshes the back office (the page with
  // the trace) — by navigating to its GET address, never `reload()`: after a
  // button the URL is the POST route, and reloading that would re-send the
  // step. Not while a button's request is out: navigating then would throw
  // its answer away (an error box with it), and that answer is rendered from
  // the state as it is by then. The join page follows its session with its
  // own poll, which a reload would stop (and a half-typed form would be
  // lost); /back is the popup's last page. Neither listens.
  if (document.getElementById('trace')) {
    const source = new EventSource('/events');
    source.addEventListener('refresh', () => { if (!submitting) location.replace('/'); });
  }
  for (const form of document.querySelectorAll('form')) {
    form.addEventListener('submit', event => {
      // A form that asks first (Start over) sends nothing on a "no", and its
      // button stays usable.
      if (form.dataset.confirm && !confirm(form.dataset.confirm)) { event.preventDefault(); return; }
      submitting = true;
      // Disabled AFTER the browser has read the form data: a button disabled
      // inside the submit handler drops its own name/value (the simulate
      // outcome buttons rely on it).
      setTimeout(() => { for (const b of form.querySelectorAll('button')) b.disabled = true; }, 0);
    });
  }
})();
