import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
type Handler = (event?: any) => void;
const update = { key: 'event-1', title: 'Invoice payment confirmed', receivedAt: '2026-10-20T10:00:00Z', via: 'webhook' };

function page(options: { rendered?: typeof update; error?: boolean; stored?: string; storageBlocked?: boolean } = {}) {
  const node = () => ({
    hidden: false, textContent: '', disabled: false,
    handlers: {} as Record<string, Handler>,
    classList: { add() {}, remove() {} },
    addEventListener(type: string, fn: Handler) { this.handlers[type] = fn; },
  });
  const title = node(), detail = node(), refreshButton = node(), link = node(), button = node();
  const parts: Record<string, unknown> = { '[data-update-title]': title, '[data-update-detail]': detail, '[data-update-refresh]': refreshButton, '[data-update-link]': link };
  const notice = { ...node(), dataset: { update: JSON.stringify(options.rendered ?? null) }, querySelector: (s: string) => parts[s] };
  const form = { ...node(), dataset: {}, querySelectorAll: () => [button] };
  const live = { querySelector: (s: string) => s === '[data-live-update]' ? notice : options.error ? {} : null, querySelectorAll: () => [form] };
  const document = { activeElement: { tagName: 'BODY' }, querySelector: () => live, querySelectorAll: () => [form] };
  const handlers: Record<string, Handler> = {};
  const timers = new Map<number, { fn: Handler; delay: number }>();
  let nextTimer = 0, confirmed = false, confirmations = 0;
  const navigation: string[] = [];
  const storage = new Map<string, string>();
  if (options.stored) storage.set('gateway-example-refreshed-update', options.stored);
  runInNewContext(script, {
    document, window: { addEventListener() {} },
    location: { replace: (url: string) => navigation.push(url) },
    sessionStorage: {
      getItem: (key: string) => { if (options.storageBlocked) throw new Error('blocked'); return storage.get(key); },
      setItem: (key: string, value: string) => { if (options.storageBlocked) throw new Error('blocked'); storage.set(key, value); },
      removeItem: (key: string) => storage.delete(key),
    },
    EventSource: class { addEventListener(type: string, fn: Handler) { handlers[type] = fn; } },
    setTimeout: (fn: Handler, delay: number) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    confirm: () => { confirmations++; return confirmed; },
  });
  const runTimers = (delay: number) => {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); }
  };
  const receive = (data: unknown = update, type = 'refresh') => handlers[type]({ data: JSON.stringify(data) });
  return { notice, title, detail, refreshButton, link, form, document, navigation, storage, receive, runTimers,
    confirm: () => { confirmed = true; }, confirmations: () => confirmations };
}

test('a new event is explained before navigation, always to GET /, and its receipt survives navigation', () => {
  const p = page();
  p.receive();
  assert.equal(p.title.textContent, update.title);
  assert.match(p.detail.textContent, /Webhook received.*Refreshing view/);
  assert.deepEqual(p.navigation, []);
  p.runTimers(1200);
  assert.deepEqual(p.navigation, ['/']);
  const next = page({ rendered: update, stored: p.storage.get('gateway-example-refreshed-update') });
  assert.match(next.detail.textContent, /View refreshed/);
  next.receive(update, 'snapshot');
  next.runTimers(1200);
  assert.deepEqual(next.navigation, [], 'the same receipt never causes a refresh loop');
});

test('typing before or during the receipt delay keeps unsent changes until a confirmed refresh', () => {
  for (const typeFirst of [true, false]) {
    const p = page();
    if (typeFirst) p.form.handlers.input();
    p.receive();
    if (!typeFirst) p.form.handlers.change();
    p.runTimers(1200);
    assert.deepEqual(p.navigation, []);
    assert.match(p.detail.textContent, /unsent changes are kept/);
    assert.equal(p.refreshButton.hidden, false);
    p.refreshButton.handlers.click();
    assert.deepEqual(p.navigation, [], 'declining keeps the form and the update');
    p.confirm();
    p.refreshButton.handlers.click();
    assert.deepEqual(p.navigation, ['/']);
  }
});

test('a focused field and a visible error each defer refresh without pretending there are edits', () => {
  for (const error of [false, true]) {
    const p = page({ error });
    if (!error) p.document.activeElement.tagName = 'INPUT';
    p.receive();
    p.runTimers(1200);
    assert.deepEqual(p.navigation, []);
    assert.equal(p.refreshButton.hidden, false);
    p.refreshButton.handlers.click();
    assert.deepEqual(p.navigation, ['/']);
    assert.equal(p.confirmations(), 0);
  }
});

test('an event during submission cannot replace the action response, including a scheduled refresh', () => {
  const p = page();
  p.receive();
  p.form.handlers.submit({ defaultPrevented: false, submitter: null });
  p.runTimers(1200);
  assert.deepEqual(p.navigation, []);
  assert.match(p.detail.textContent, /Waiting for your current action/);
  assert.equal(p.refreshButton.hidden, true);
});

test('reconnection catches a missed event and a burst keeps the latest receipt', () => {
  const p = page({ rendered: update });
  p.receive({ ...update, key: 'event-2', title: 'Payout is processing' }, 'snapshot');
  p.receive({ ...update, key: 'event-3', title: 'Payout completed', via: 'poll' });
  assert.equal(p.title.textContent, 'Payout completed');
  assert.match(p.detail.textContent, /Update found by polling/);
  p.runTimers(1200);
  assert.deepEqual(p.navigation, ['/']);
  assert.equal(p.storage.get('gateway-example-refreshed-update'), 'event-3');
});

test('optional browser storage is not required for receiving an update', () => {
  const p = page({ rendered: update, storageBlocked: true });
  p.receive({ ...update, key: 'new' });
  p.runTimers(1200);
  assert.deepEqual(p.navigation, ['/']);
});
