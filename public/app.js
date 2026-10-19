(() => {
  // A stored webhook or poll result refreshes the page — by navigating to
  // the page's GET address, never `reload()`: after a button the URL is the
  // POST route, and reloading that would re-send the step.
  const source = new EventSource('/events');
  source.addEventListener('refresh', () => location.replace(location.pathname.startsWith('/join') ? '/join' : '/'));
  for (const form of document.querySelectorAll('form')) {
    // Disabled AFTER the browser has read the form data: a button disabled
    // inside the submit handler drops its own name/value (the simulate
    // outcome buttons rely on it).
    form.addEventListener('submit', () => setTimeout(() => { for (const b of form.querySelectorAll('button')) b.disabled = true; }, 0));
  }
})();
