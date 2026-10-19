import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftInvoice, findSelfClient, invoiceRequest, issueInvoice } from '../steps/03-issue.ts';
import { defaultState } from '../lib/store.ts';
import type { Api } from '../lib/abillio.ts';

const invoiceOut = (status: string) => ({ id: 'inv-1', invoice_number: 'ACME-0001', status, public_url: 'https://new.abillio.dev/invoice/x', amounts: { total: { amount: '100.00', currency: 'EUR' } } });

test('the self-client is the row whose company_account_id is the account itself', async () => {
  const api = (async () => ({ count: 2, items: [
    { id: 'c-third', name: 'Brand Ltd', company_account_id: null },
    { id: 'c-self', name: 'Acme Tutors SIA', company_account_id: 'a1' },
  ] })) as Api;
  assert.deepEqual(await findSelfClient(api, 'a1'), { id: 'c-self', name: 'Acme Tutors SIA' });
  await assert.rejects(findSelfClient((async () => ({ count: 0, items: [] })) as Api, 'a1'), /no self-client/);
});

test('draft then issue, each with its own idempotency key, kept across calls', async () => {
  const calls: { method: string; path: string; body: unknown; key: string | undefined }[] = [];
  const api = (async (method: string, path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
    calls.push({ method, path, body, key: opts?.idempotencyKey });
    return invoiceOut(path.endsWith('/issue') ? 'pending' : 'draft');
  }) as Api;
  const state = defaultState();
  const request = invoiceRequest('e1', { description: 'Tutoring, October', unit_price: '100.00', currency_code: 'EUR' }, new Date('2026-10-19T10:00:00Z'));
  const draft = await draftInvoice(api, state, request, 'c-self');
  assert.deepEqual(draft, { id: 'inv-1', number: 'ACME-0001', status: 'draft', public_url: 'https://new.abillio.dev/invoice/x', total: '100.00', currency: 'EUR' });
  assert.deepEqual(calls[0].body, {
    client_uuid: 'c-self',
    items: [{ description: 'Tutoring, October', quantity: '1', unit_price: '100.00', unit_code: 'HUR' }],
    currency_code: 'EUR', issued_date: '2026-10-19', due_date: '2026-11-02', language: 'en',
  });
  const issued = await issueInvoice(api, state, 'e1', 'inv-1');
  assert.equal(issued.status, 'pending');
  assert.equal(calls[1].path, '/engagements/e1/invoices/inv-1/issue');
  assert.notEqual(calls[0].key, calls[1].key);
  await draftInvoice(api, state, invoiceRequest('e1', { description: 'x', unit_price: '1', currency_code: 'EUR' }, new Date()), 'c-self');
  assert.equal(calls[2].key, calls[0].key, 'a second draft for the same engagement reuses the key');
});
