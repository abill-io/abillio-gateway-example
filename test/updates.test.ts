import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestUpdate } from '../lib/updates.ts';
import { defaultState, type StoredEvent } from '../lib/store.ts';
import { companyPage } from '../views/company.ts';

test('the visible receipt names only this walk or a test delivery and exposes no payload', () => {
  const state = defaultState();
  state.invoice = { id: 'invoice-ours', number: 'DEMO-1', status: 'paid', public_url: '' };
  const ours: StoredEvent = { received_at: '2026-10-20T10:00:00Z', event_type: 'engagement.invoice.paid', via: 'webhook', data: { invoice_uuid: 'invoice-ours', private_note: 'private payload' } };
  state.events = [ours, { ...ours, data: { invoice_uuid: 'invoice-someone-else' } }];
  const summary = latestUpdate(state)!;
  assert.equal(summary.title, 'Invoice payment confirmed');
  assert.equal(summary.via, 'webhook');
  assert.ok(!JSON.stringify(summary).includes('private payload'));
  assert.ok(!JSON.stringify(summary).includes('invoice-ours'));
  const html = companyPage({ state, trace: [], key: null, error: null, publicUrl: null });
  assert.ok(html.indexOf('data-live-update') < html.indexOf('id="step-1"'));
  assert.match(html, /href="#event-log"/);
  state.events.push({ ...ours, event_type: 'channel.test', data: {} });
  assert.equal(latestUpdate(state)?.title, 'Test delivery received');
});

test('an update can be detected when the capped log stays at 200 entries', () => {
  const state = defaultState();
  const event: StoredEvent = { received_at: '2026-10-20T10:00:00Z', event_type: 'channel.test', via: 'webhook', data: {} };
  state.events = Array.from({ length: 200 }, () => ({ ...event }));
  const before = latestUpdate(state)!.key;
  state.events.shift();
  state.events.push({ ...event, received_at: '2026-10-20T10:01:00Z' });
  assert.notEqual(latestUpdate(state)!.key, before);
  assert.equal(state.events.length, 200);
});

test('unrelated events and an empty log do not produce a visible receipt', () => {
  const state = defaultState();
  assert.equal(latestUpdate(state), null);
  state.events = [{ received_at: '2026-10-20T10:00:00Z', event_type: 'engagement.invoice.paid', via: 'webhook', data: { invoice_uuid: 'someone-else' } }];
  assert.equal(latestUpdate(state), null);
});
