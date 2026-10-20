(() => {
  // A direct step link must work even when that step is folded. Open
  // enclosing disclosures too, for links to trace or stored-state details.
  const revealTarget = () => {
    const target = document.getElementById(location.hash.slice(1));
    if (!target) return;
    let details = target.closest('details');
    while (details) {
      details.open = true;
      details = details.parentElement?.closest('details');
    }
  };
  revealTarget();
  window.addEventListener('hashchange', revealTarget);
})();
