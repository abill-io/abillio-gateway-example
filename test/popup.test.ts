import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/popup.js', import.meta.url), 'utf8');

type Answer = () => Response;

// public/popup.js on a join page as the server renders it, in a context with
// just what the script touches: the form, the note, the status console, the
// window, fetch and the timers. `stored` is whether the server rendered the
// page with a session stored (the form's data-session).
function joinPage(stored: boolean, answers: Record<string, Answer>) {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  const button = { disabled: false };
  const form = {
    dataset: { origin: 'https://new.abillio.dev', session: stored ? 'stored' : '' },
    addEventListener: (type: string, fn: (event: unknown) => unknown) => { handlers[type] = fn; },
    querySelectorAll: () => [button],
  };
  const note = { textContent: '' };
  const status = { innerHTML: '' };
  const fetched: string[] = [];
  const ticks: (() => void)[] = [];
  runInNewContext(source, {
    document: { getElementById: (id: string) => ({ join: form, 'popup-note': note, status } as Record<string, unknown>)[id] ?? null },
    window: { addEventListener: () => {}, open: () => ({ location: '', close: () => {} }) },
    fetch: async (url: string) => { fetched.push(url); return answers[url](); },
    setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length; },
    clearInterval: () => {},
    URLSearchParams,
    FormData: class { *[Symbol.iterator]() { yield ['email', 'anna+x@example.com']; } },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { handlers, button, note, status, fetched, ticks, settle };
}

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const inProgress = json({ state: 'in_progress', can_be_paid: false, requirements: [{ key: 'kyc', state: 'in_progress' }], engagement_id: null });

test('with a session stored, the join page asks for its status on load and every 3 s after, so an engagement is found without sending the form again', async () => {
  const page = joinPage(true, { '/join/status': inProgress });
  await page.settle();
  assert.deepEqual(page.fetched, ['/join/status']);
  assert.equal(page.ticks.length, 1, 'and keeps asking');
  assert.match(page.status.innerHTML, /in_progress/);
  const fresh = joinPage(false, {});
  await fresh.settle();
  assert.deepEqual(fresh.fetched, [], 'with nothing stored there is nothing to ask about');
});

test('a status answer that is not OK is said in the note, and the next good one clears it', async () => {
  let refuse = true;
  const page = joinPage(true, { '/join/status': () => (refuse ? new Response('forbidden: Not granted', { status: 502 }) : inProgress()) });
  await page.settle();
  assert.equal(page.note.textContent, 'The status check failed: forbidden: Not granted');
  refuse = false;
  page.ticks[0]();
  await page.settle();
  assert.equal(page.note.textContent, '');
});

test('Continue is given back once the link is minted: each press is a new link, so the freelancer may need another', async () => {
  const page = joinPage(false, {
    '/join': json({ session_id: 's1', url: 'https://new.abillio.dev/s/tok', origin: 'https://new.abillio.dev' }),
    '/join/status': inProgress,
  });
  const submitted = page.handlers.submit({ preventDefault: () => {} });
  // app.js disables the form's button a tick after the submit.
  page.button.disabled = true;
  await submitted;
  assert.equal(page.button.disabled, false);
});
