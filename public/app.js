(() => {
  const source = new EventSource('/events');
  source.addEventListener('refresh', () => location.reload());
  for (const form of document.querySelectorAll('form')) {
    form.addEventListener('submit', () => { for (const b of form.querySelectorAll('button')) b.disabled = true; });
  }
})();
