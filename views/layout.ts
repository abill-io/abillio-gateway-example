import type { StepStatus } from './partials.ts';

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

// The sample company's mark, a sun rising over a line: drawn once, used as the
// favicon and in the top bar, so the page needs no image files.
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f766e"/><path d="M9.5 19.5a6.5 6.5 0 0 1 13 0" fill="none" stroke="#faf8f5" stroke-width="2.6" stroke-linecap="round"/><path d="M6.5 23.5h19" stroke="#faf8f5" stroke-width="2.6" stroke-linecap="round"/></svg>';
const FAVICON = `data:image/svg+xml,${encodeURIComponent(MARK)}`;
const EXTERNAL = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5h6.5V10M12.5 3.5 4 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// All three families in one stylesheet request. `display=swap` shows the text
// in the system fallbacks style.css names until the fonts arrive.
const FONTS = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Outfit:wght@500;600&family=Source+Sans+3:wght@400;600;700&display=swap';

export type PageOptions = {
  // Which of the sample's two pages this is; the top bar marks it.
  current?: 'office' | 'join';
  // The five steps as `stepStatuses` reads them, for the progress line.
  steps?: StepStatus[];
  // Page controls that sit with the progress line (the back office's Start
  // over). Markup the view composed, already escaped.
  controls?: string;
};

// "3 of 5 steps done", with one segment per step in that step's status.
function progressLine(steps: StepStatus[], controls: string): string {
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${esc(FONTS)}">
<link rel="stylesheet" href="/public/style.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">
  <a class="brand" href="/"${here('office')}><span class="brand-mark" aria-hidden="true">${MARK}</span><span class="brand-name">Brightline Tutors</span> <span class="brand-role">— back office</span></a>
  ${opts.steps ? progressLine(opts.steps, opts.controls ?? '') : ''}
  <nav class="topnav" aria-label="Pages">
    <a href="/join"${here('join')}>The freelancer's page</a>
    <a href="https://backend.abillio.dev/company-api/" target="_blank" rel="noopener">Abillio company API guide${EXTERNAL}<span class="visually-hidden"> (opens in a new tab)</span></a>
  </nav>
</header>
${body}
<script src="/public/app.js"></script>
</body>
</html>`;
}
