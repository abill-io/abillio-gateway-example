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

test('while the freelancer cannot be paid, the status says what Abillio is still waiting on and that the page keeps asking; once they can, it says so instead', async () => {
  const done = { key: 'profile', state: 'done' };
  const cases: [string, Record<string, unknown>, string | undefined][] = [
    ['every requirement not done, in order', { state: 'in_progress', can_be_paid: false, requirements: [done, { key: 'kyc', state: 'in_progress' }, { key: 'payout_method', state: 'pending_review' }], engagement_id: 'e1' },
      '<p class="muted">Not payable yet — Abillio is still waiting on: <code>kyc</code> in_progress, <code>payout_method</code> pending_review. The page keeps asking every 3 s.</p>'],
    ['nobody has agreed yet: Abillio lists nothing', { state: 'awaiting_freelancer', can_be_paid: false, requirements: [], engagement_id: null },
      '<p class="muted">Not payable yet. The page keeps asking every 3 s.</p>'],
    ['payable', { state: 'complete', can_be_paid: true, requirements: [done], engagement_id: 'e1' },
      '<p class="ok">The freelancer can be paid. Go to the <a href="/">back office</a> and issue the first invoice.</p>'],
    // An expired link stops the page asking, so it must not say it keeps
    // asking; with nothing stored, there is nothing to wait on.
    ['the link expired', { state: 'expired', can_be_paid: false, requirements: [{ key: 'kyc', state: 'not_started' }], engagement_id: null }, undefined],
    ['nothing stored any more (a Start over)', { state: 'none', can_be_paid: false, requirements: [] }, undefined],
  ];
  for (const [label, answer, says] of cases) {
    const page = joinPage(true, { '/join/status': json(answer) });
    await page.settle();
    assert.equal(page.status.innerHTML.match(/<p class="(?:muted|ok)">[\s\S]*?<\/p>/)?.[0], says, label);
  }
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

// public/popup.js on the back office with step 2's Send a new link: the
// update form (#update-link) and its note, no join form and no status
// console, and a page that can load itself again.
function officePage(answers: Record<string, Answer>) {
  const handlers: Record<string, (event: unknown) => unknown> = {};
  const messages: ((event: unknown) => unknown)[] = [];
  const button = { disabled: false };
  const form = {
    dataset: { origin: 'https://new.abillio.dev' },
    addEventListener: (type: string, fn: (event: unknown) => unknown) => { handlers[type] = fn; },
    querySelectorAll: () => [button],
  };
  const note = { textContent: '' };
  const popup = { location: '', closed: false, close() { this.closed = true; } };
  const fetched: string[] = [];
  const ticks: (() => void)[] = [];
  const stopped: number[] = [];
  const navigation: string[] = [];
  runInNewContext(source, {
    document: { getElementById: (id: string) => ({ 'update-link': form, 'popup-note': note } as Record<string, unknown>)[id] ?? null },
    window: { addEventListener: (type: string, fn: (event: unknown) => unknown) => { if (type === 'message') messages.push(fn); }, open: () => popup },
    location: { replace: (url: string) => { navigation.push(url); } },
    fetch: async (url: string) => { fetched.push(url); return answers[url](); },
    setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length; },
    clearInterval: (id: number | null) => { if (id) stopped.push(id); },
    URLSearchParams,
    FormData: class { *[Symbol.iterator]() {} },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const press = async () => {
    const submitted = handlers.submit({ preventDefault: () => {} });
    // app.js disables the form's button a tick after the submit.
    button.disabled = true;
    await submitted;
    await settle();
  };
  const message = (origin: string, data: unknown) => { for (const fn of messages) fn({ origin, data }); };
  return { button, note, popup, fetched, ticks, stopped, navigation, settle, press, message };
}

const minted = json({ session_id: 's2', url: 'https://new.abillio.dev/s/tok2', origin: 'https://new.abillio.dev', purpose: 'update' });
const updateStatus = (state: string, can_be_paid: boolean) => json({ state, can_be_paid, purpose: 'update', requirements: [{ key: 'kyc', state: state === 'complete' ? 'done' : 'not_started' }], engagement_id: 'e1' });

test('Send a new link opens the popup from the click, points it at the update link and follows the session; once the link has done its job the back office loads again', async () => {
  let status = updateStatus('awaiting_freelancer', false);
  const page = officePage({ '/steps/onboard/update-link': minted, '/join/status': () => status() });
  await page.settle();
  assert.deepEqual(page.fetched, [], 'nothing on load: the stored session may still be the first link, long done');
  await page.press();
  assert.equal(page.popup.location, 'https://new.abillio.dev/s/tok2');
  assert.equal(page.button.disabled, false, 'given back: another press reopens the same link while it is open');
  assert.deepEqual(page.fetched, ['/steps/onboard/update-link', '/join/status']);
  assert.equal(page.ticks.length, 1, 'and keeps asking every 3 s');
  assert.equal(page.note.textContent, 'Waiting for the freelancer in the Abillio window (still open: kyc not_started). This page asks again every 3 s.');
  status = updateStatus('complete', true);
  page.ticks[0]();
  await page.settle();
  assert.deepEqual(page.stopped, [1]);
  assert.deepEqual(page.navigation, ['/'], 'step 2 reads what the server stored');
});

test('an update link is followed on its state, not on can_be_paid: payable with the link still open keeps the page waiting, and an expired link stops it with what to do next', async () => {
  let status = updateStatus('in_progress', true);
  const page = officePage({ '/steps/onboard/update-link': minted, '/join/status': () => status() });
  await page.press();
  assert.deepEqual([page.stopped, page.navigation], [[], []], 'a withdrawn mandate leaves them payable while the link is still open');
  status = updateStatus('expired', false);
  page.ticks[0]();
  await page.settle();
  assert.deepEqual(page.stopped, [1]);
  assert.equal(page.note.textContent, 'The link expired before it was finished: send a new link.');
  assert.deepEqual(page.navigation, []);
});

test('a refused update link is said in the note, the popup closes and the button comes back', async () => {
  const page = officePage({ '/steps/onboard/update-link': () => new Response('requirements_complete: Nothing left to complete.', { status: 502 }) });
  await page.press();
  assert.equal(page.note.textContent, 'Could not send a new link: requirements_complete: Nothing left to complete.');
  assert.equal(page.popup.closed, true);
  assert.equal(page.button.disabled, false);
  assert.deepEqual(page.fetched, ['/steps/onboard/update-link'], 'and nothing is followed');
});

test("on the back office a message from Abillio's popup starts the follow; one from another origin, or without Abillio's marker, is ignored", async () => {
  const page = officePage({ '/join/status': updateStatus('complete', true) });
  page.message('https://evil.example', { source: 'abillio', session_id: 's2', state: 'complete' });
  page.message('https://new.abillio.dev', { source: 'someone', session_id: 's2', state: 'complete' });
  await page.settle();
  assert.deepEqual(page.fetched, []);
  page.message('https://new.abillio.dev', { source: 'abillio', session_id: 's2', purpose: 'update', state: 'complete', can_be_paid: true });
  await page.settle();
  assert.deepEqual(page.fetched, ['/join/status']);
  assert.deepEqual(page.navigation, ['/']);
});
