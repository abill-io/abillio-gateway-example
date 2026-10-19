export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Abillio gateway example</title>
<link rel="stylesheet" href="/public/style.css">
</head>
<body>
<header class="top"><a href="/">Brightline Tutors — back office</a> <a href="/join">The freelancer's page</a> <a href="https://backend.abillio.dev/company-api/" target="_blank" rel="noopener">Abillio company API guide</a></header>
${body}
<script src="/public/app.js"></script>
</body>
</html>`;
}
