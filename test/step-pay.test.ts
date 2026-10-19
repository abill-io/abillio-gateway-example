import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPayout, fundWallet, payInvoice, simulatePayout } from '../steps/04-pay.ts';
import { defaultState } from '../lib/store.ts';
import type { Api } from '../lib/abillio.ts';

test('fundWallet posts amount, currency and the serving company, and reads back the rows', async () => {
  let seen: unknown;
  const api = (async (_m: string, _p: string, body: unknown) => { seen = body; return [{ company_slug: 'abillio-ks', available: { amount: '250.00', currency: 'EUR' }, net_available: { amount: '250.00', currency: 'EUR' } }]; }) as Api;
  const rows = await fundWallet(api, '250.00', 'EUR', 'abillio-ks');
  assert.deepEqual(seen, { amount: '250.00', currency: 'EUR', company: 'abillio-ks' });
  assert.deepEqual(rows, [{ company_slug: 'abillio-ks', available: '250.00' }]);
});

test('payInvoice sends invoice_uuid with an idempotency key tied to the invoice', async () => {
  const calls: { body: unknown; key?: string }[] = [];
  const api = (async (_m: string, _p: string, body: unknown, opts?: { idempotencyKey?: string }) => { calls.push({ body, key: opts?.idempotencyKey }); return { created: true, operation_id: 'op-1' }; }) as Api;
  const state = defaultState();
  assert.deepEqual(await payInvoice(api, state, 'inv-1'), { created: true, operation_id: 'op-1' });
  await payInvoice(api, state, 'inv-1');
  assert.deepEqual(calls[0].body, { invoice_uuid: 'inv-1' });
  assert.equal(calls[0].key, calls[1].key);
});

test('findPayout picks the payout of this invoice; simulatePayout posts the outcome', async () => {
  const api = (async (method: string, path: string, body: unknown) => {
    if (path === '/engagements/e1/payouts/') return { items: [{ id: 'p-other', status: 'paid', invoice_uuid: 'inv-0' }, { id: 'p1', status: 'pending', invoice_uuid: 'inv-1' }] };
    if (method === 'POST' && path === '/engagements/e1/payouts/p1/sandbox/simulate') { assert.deepEqual(body, { outcome: 'paid' }); return { id: 'p1', status: 'paid' }; }
    throw new Error(path);
  }) as Api;
  assert.deepEqual(await findPayout(api, 'e1', 'inv-1'), { id: 'p1', status: 'pending' });
  assert.equal(await findPayout(api, 'e1', 'inv-9'), null);
  assert.deepEqual(await simulatePayout(api, defaultState(), 'e1', 'p1', 'paid'), { id: 'p1', status: 'paid' });
});
