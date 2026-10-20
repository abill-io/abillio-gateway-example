(() => {
  const root = document.documentElement;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const storageKey = 'gateway-example-theme';
  let choice = null;
  let toggle;

  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') choice = saved;
  } catch {
    // The switch still works when browser storage is unavailable.
  }

  const apply = () => {
    const theme = choice ?? (systemTheme.matches ? 'dark' : 'light');
    root.dataset.theme = theme;
    if (toggle) {
      const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
      toggle.dataset.mode = theme;
    }
  };

  // Run before the stylesheet so a saved choice is used on the first paint.
  apply();
  systemTheme.addEventListener('change', () => {
    if (!choice) apply();
  });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return;
    choice = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : null;
    apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    toggle = document.querySelector('[data-theme-toggle]');
    if (!toggle) return;
    apply();
    toggle.hidden = false;
    toggle.addEventListener('click', () => {
      choice = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(storageKey, choice); } catch { /* Use this page's choice. */ }
      apply();
    });
  }, { once: true });
})();
