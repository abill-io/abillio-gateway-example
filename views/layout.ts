import type { StepStatus } from './partials.ts';

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

// A generic home mark for the sample, without a fictional company wordmark.
const HOME_MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#18181b"/><path d="M9 9h5v5H9zM18 9h5v5h-5zM9 18h5v5H9zM18 18h5v5h-5z" fill="#fff"/></svg>';
const FAVICON = `data:image/svg+xml,${encodeURIComponent(HOME_MARK)}`;
const EXTERNAL = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5h6.5V10M12.5 3.5 4 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Preloaded, so both faces arrive with the stylesheet that declares them
// (style.css). A face that comes late re-sets its text, and a code chip that
// ends right at a line's edge can then push a word onto the next line.
const FONT_FILES = ['outfit-v1.100.woff2', 'jetbrains-mono-v2.304.woff2'];

export type PageOptions = {
  // Which of the sample's two pages this is; the top bar marks it.
  current?: 'office' | 'join';
  // The five steps as `stepStatuses` reads them, for the progress line.
  steps?: StepStatus[];
  // Page controls that sit with the progress line. Already escaped markup.
  controls?: string;
};

// "3 of 5 steps done", with one segment per step in that step's status.
export function progressLine(steps: StepStatus[], controls: string): string {
  const done = steps.filter(s => s === 'done').length;
  return `<div class="walk">
    <p class="progress"><span class="progress-track" aria-hidden="true">${steps.map(s => `<span class="is-${esc(s)}"></span>`).join('')}</span>${esc(done)} of ${esc(steps.length)} steps done</p>
    ${controls}
  </div>`;
}

export function page(title: string, body: string, opts: PageOptions = {}): string {
  const here = (name: PageOptions['current']) => (opts.current === name ? ' aria-current="page"' : '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Abillio gateway example</title>
<link rel="icon" href="${esc(FAVICON)}">
${FONT_FILES.map(f => `<link rel="preload" href="/public/fonts/${esc(f)}" as="font" type="font/woff2" crossorigin>`).join('\n')}
<script src="/public/theme.js"></script>
<link rel="stylesheet" href="/public/style.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">
  <a class="home-link" href="/" aria-label="Back office" title="Back office"${here('office')}>${HOME_MARK}</a>
  <nav class="topnav" aria-label="Pages">
    <a href="https://backend.abillio.dev/company-api/" target="_blank" rel="noopener">Abillio company API guide${EXTERNAL}<span class="visually-hidden"> (opens in a new tab)</span></a>
    ${opts.current === 'join' ? '<a class="view-switch" href="/">Back to company view</a>' : '<a class="view-switch" href="/join">Freelancer signup</a>'}
    <button class="theme-toggle secondary" type="button" data-theme-toggle hidden aria-label="Switch color theme">
      <svg class="theme-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>
      <svg class="theme-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14a8.5 8.5 0 0 1-10.5-10.5A8.5 8.5 0 1 0 20.5 14Z"/></svg>
    </button>
  </nav>
</header>
${opts.current === 'office' ? `<section class="office-banner" aria-labelledby="office-title">
  <p class="page-context">Your Company <span aria-hidden="true">/</span> Integration demo</p>
  <h1 id="office-title">Back office</h1>
  <p class="office-intro">See how your company can onboard a freelancer, issue an invoice and pay them through Abillio. You’re in the company view; step 2 lets you try the freelancer’s signup experience.</p>
  ${opts.steps ? progressLine(opts.steps, opts.controls ?? '') : ''}
</section>` : ''}
${body}
<script src="/public/app.js"></script>
</body>
</html>`;
}
