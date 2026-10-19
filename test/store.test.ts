import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultState, loadState, saveState, updateState, idempotencyKeyFor, forgetIdempotencyKey } from '../lib/store.ts';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'gw-')), 'state.json');
}

test('a missing file reads as the default state', () => {
  const state = loadState(tempFile());
  assert.deepEqual(state, defaultState());
});

test('save then load round-trips, and the file is pretty JSON', () => {
  const file = tempFile();
  const state = defaultState();
  state.account = { id: 'a1', name: 'Acme', slug: 'acme', is_sandbox: true };
  saveState(state, file);
  assert.deepEqual(loadState(file), state);
  assert.match(readFileSync(file, 'utf8'), /\n  "account": \{/);
});

test('updateState applies the change and persists it', () => {
  const file = tempFile();
  const after = updateState(s => { s.events.push({ received_at: 't', event_type: 'x', data: {}, via: 'poll' }); }, file);
  assert.equal(after.events.length, 1);
  assert.equal(loadState(file).events.length, 1);
});

test('writes go through a temp file so a crash never leaves a half-written state', () => {
  const file = tempFile();
  saveState(defaultState(), file);
  assert.ok(!existsSync(file + '.tmp'));
  assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')));
});

test('a corrupt file is reported, not silently replaced', () => {
  const file = tempFile();
  writeFileSync(file, '{not json');
  assert.throws(() => loadState(file), /state\.json is not valid JSON/);
});

test('idempotency keys are minted once per action and reused', () => {
  const state = defaultState();
  const first = idempotencyKeyFor(state, 'issue:eng-1');
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(idempotencyKeyFor(state, 'issue:eng-1'), first);
  assert.notEqual(idempotencyKeyFor(state, 'pay:inv-1'), first);
});

test('a forgotten key is minted afresh, so the next press is a new attempt', () => {
  const state = defaultState();
  const first = idempotencyKeyFor(state, 'onboard:anna@example.com');
  forgetIdempotencyKey(state, 'onboard:anna@example.com');
  assert.notEqual(idempotencyKeyFor(state, 'onboard:anna@example.com'), first);
});
