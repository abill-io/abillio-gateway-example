import type { TraceEntry } from '../lib/trace.ts';
import { AbillioError } from '../lib/abillio.ts';
import { esc } from './layout.ts';

export function jsonBlock(value: unknown): string {
  return `<pre class="json">${esc(JSON.stringify(value, null, 2))}</pre>`;
}

export function tracePanel(entries: TraceEntry[]): string {
  const rows = [...entries].reverse().map(e => `
    <details class="trace ${e.error ? 'is-error' : ''}" ${e === entries.at(-1) ? 'open' : ''}>
      <summary><code>${esc(e.method)} ${esc(e.path)}</code> → <b>${esc(e.status ?? 'network error')}</b>${e.replayed ? ' <span class="tag">Idempotent-Replay</span>' : ''}${e.idempotencyKey ? ` <small>Idempotency-Key ${esc(e.idempotencyKey)}</small>` : ''} <small>${esc(e.at)}</small></summary>
      ${e.requestBody !== null ? `<h4>Request body</h4>${jsonBlock(e.requestBody)}` : ''}
      <h4>Response</h4>${jsonBlock(e.responseBody)}
      ${e.error ? `<p class="error">${esc(e.error)}</p>` : ''}
    </details>`).join('');
  return `<section id="trace" class="panel"><h2>What we sent to Abillio</h2><p class="muted">Newest first. Signatures are not shown; everything else is exactly the wire.</p>${rows || '<p class="muted">Nothing yet — press a button.</p>'}</section>`;
}

export function errorBox(err: unknown): string {
  if (!err) return '';
  if (err instanceof AbillioError) {
    const blockers = err.blockers.length
      ? `<ul class="blockers">${err.blockers.map(b => `<li><code>${esc(b.code)}</code> ${esc(b.message)}${b.capability ? ` <small>(${esc(b.capability)})</small>` : ''}</li>`).join('')}</ul>`
      : '';
    const fields = Object.entries(err.fieldErrors ?? {}).map(([f, m]) => `<li><code>${esc(f)}</code> ${esc(Array.isArray(m) ? m.join('; ') : m)}</li>`).join('');
    return `<div class="error-box"><b>${esc(err.status)} ${esc(err.code)}</b> — ${esc(err.message)}${err.hint ? `<p>${esc(err.hint)}</p>` : ''}${blockers}${fields ? `<ul>${fields}</ul>` : ''}${err.requestId ? `<small>request_id ${esc(err.requestId)}</small>` : ''}</div>`;
  }
  return `<div class="error-box">${esc((err as Error).message ?? String(err))}</div>`;
}
