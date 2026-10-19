import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dedupeKey, parseDelivery, verifySignature } from '../lib/webhooks.ts';

const v = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')).webhook;
const body = Buffer.from(v.body, 'utf8');
const at = () => Number(v.timestamp) * 1000 + 5_000;

test('accepts the backend\'s own signature over the raw body', () => {
  const out = verifySignature(v.secret, { timestamp: v.timestamp, signature: v.signature_header }, body, at);
  assert.deepEqual(out, { ok: true, timestamp: Number(v.timestamp) });
});

test('rejects a wrong secret, a tampered body and a re-serialised body', () => {
  assert.equal(verifySignature('b'.repeat(64), { timestamp: v.timestamp, signature: v.signature_header }, body, at).ok, false);
  assert.equal(verifySignature(v.secret, { timestamp: v.timestamp, signature: v.signature_header }, Buffer.from(v.body.replace('100.00', '900.00')), at).ok, false);
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(v.body), null, 2));
  assert.equal(verifySignature(v.secret, { timestamp: v.timestamp, signature: v.signature_header }, reserialised, at).ok, false);
});

test('rejects a stale or missing timestamp with 400 and a bad signature with 401', () => {
  const stale = verifySignature(v.secret, { timestamp: v.timestamp, signature: v.signature_header }, body, () => Number(v.timestamp) * 1000 + 301_000);
  assert.deepEqual(stale, { ok: false, status: 400, reason: 'timestamp outside the 300 s window' });
  assert.deepEqual(verifySignature(v.secret, { timestamp: null, signature: v.signature_header }, body, at), { ok: false, status: 400, reason: 'missing X-Timestamp' });
  const bad = verifySignature(v.secret, { timestamp: v.timestamp, signature: 't=1,v1=00' }, body, at);
  assert.deepEqual(bad, { ok: false, status: 401, reason: 'signature mismatch' });
});

test('dedupe key is the event and the body — the same across retries, different per body — and parseDelivery reads event_type and data', () => {
  const a = dedupeKey('engagement.invoice.paid', body);
  assert.equal(a, dedupeKey('engagement.invoice.paid', body));
  assert.notEqual(a, dedupeKey('engagement.invoice.confirmed', body));
  assert.notEqual(a, dedupeKey('engagement.invoice.paid', Buffer.from('{}')));
  assert.deepEqual(parseDelivery(body), { event_type: 'engagement.invoice.paid', data: { invoice_uuid: 'inv-1', amount: '100.00' } });
  assert.equal(parseDelivery(Buffer.from('nope')), null);
  assert.equal(parseDelivery(Buffer.from('{"data":{}}')), null);
});

// What the backend puts on the wire: a real event is the stored envelope
// `{ event, timestamp, account_id, account_name, data }`; the "send test" button
// sends `{ event_type: 'channel.test', message, channel_name }` and no data.
test('parseDelivery reads a real event, the stored envelope: the type is event, and its timestamp and account ride along in data', () => {
  const envelope = {
    event: 'engagement.invoice.paid',
    timestamp: '2026-10-19T10:15:01.654321Z',
    account_id: '0198f3a2-cccc-7d3a-9b5e-2f4c8a1d6e93',
    account_name: 'Acme SIA',
    data: { invoice_uuid: '0198f3a2-bbbb-7d3a-9b5e-2f4c8a1d6e92', amount: '100.00', status: 'paid' },
  };
  const carried = { timestamp: envelope.timestamp, account_id: envelope.account_id, account_name: envelope.account_name };
  const parse = (sent: object) => parseDelivery(Buffer.from(JSON.stringify(sent)));
  assert.deepEqual(parse(envelope), { event_type: 'engagement.invoice.paid', data: { ...envelope.data, ...carried } });
  // what data already says wins, and a data that is not an object is just empty
  assert.deepEqual(parse({ ...envelope, data: { timestamp: 'from data' } })?.data, { ...carried, timestamp: 'from data' });
  assert.deepEqual(parse({ ...envelope, data: null })?.data, carried);
});

test('parseDelivery reads the channel test delivery, which has no data object: its other keys become data', () => {
  const sent = { event_type: 'channel.test', message: 'This is a test notification from Abillio.', channel_name: 'Gateway example' };
  assert.deepEqual(parseDelivery(Buffer.from(JSON.stringify(sent))), {
    event_type: 'channel.test',
    data: { message: sent.message, channel_name: sent.channel_name },
  });
});

test('parseDelivery answers null when neither event nor event_type is a string, or the body is not an object', () => {
  assert.equal(parseDelivery(Buffer.from('{"event":5,"event_type":7}')), null);
  assert.equal(parseDelivery(Buffer.from('null')), null);
});
