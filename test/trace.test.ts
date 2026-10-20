import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Trace, type TraceEntry } from '../lib/trace.ts';
import { tracePanel } from '../views/partials.ts';

const get = (path: string, responseBody: unknown, at: string): TraceEntry => ({ at, method: 'GET', path, requestBody: null, status: 200, responseBody, idempotencyKey: null, replayed: false, error: null });
const pay = (at: string): TraceEntry => ({ at, method: 'POST', path: '/accounts/wallet/pay-invoice/', requestBody: { invoice_uuid: 'inv-1' }, status: 200, responseBody: { created: true }, idempotencyKey: 'k', replayed: false, error: null });

test('an identical GET again folds into its earlier entry, which moves up with a count; another answer, or any POST, is an entry of its own', () => {
  const trace = new Trace();
  trace.push(get('/onboarding/sessions/s1', { state: 'in_progress' }, 't1'));
  trace.push(get('/accounts/invoices/inv-1/', { status: 'pending' }, 't2'));
  trace.push(get('/onboarding/sessions/s1', { state: 'in_progress' }, 't3'));
  trace.push(get('/accounts/invoices/inv-1/', { status: 'pending' }, 't4'));
  trace.push(get('/accounts/invoices/inv-1/', { status: 'paid' }, 't5'));
  trace.push(pay('t6'));
  trace.push(pay('t7'));
  assert.deepEqual(trace.list().map(e => [e.method, e.path, e.at, e.count ?? 1]), [
    ['GET', '/onboarding/sessions/s1', 't3', 2],
    ['GET', '/accounts/invoices/inv-1/', 't4', 2],
    ['GET', '/accounts/invoices/inv-1/', 't5', 1],
    ['POST', '/accounts/wallet/pay-invoice/', 't6', 1],
    ['POST', '/accounts/wallet/pay-invoice/', 't7', 1],
  ]);
  assert.ok(tracePanel(trace.list()).includes('×2'), 'the page shows the count');
});

test("the polls cannot push the walk's own calls out of the last fifty", () => {
  const trace = new Trace();
  trace.push(pay('t0'));
  // An hour of polling without a public URL: the session, the invoice and the payout every 5 s.
  for (let tick = 1; tick <= 720; tick++) {
    trace.push(get('/onboarding/sessions/s1', { state: 'complete' }, `t${tick}`));
    trace.push(get('/accounts/invoices/inv-1/', { status: 'paid' }, `t${tick}`));
    trace.push(get('/engagements/e1/payouts/p1', { status: 'pending' }, `t${tick}`));
  }
  assert.deepEqual(trace.list().map(e => [e.path, e.count ?? 1]), [
    ['/accounts/wallet/pay-invoice/', 1],
    ['/onboarding/sessions/s1', 720],
    ['/accounts/invoices/inv-1/', 720],
    ['/engagements/e1/payouts/p1', 720],
  ]);
});
