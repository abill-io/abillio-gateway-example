import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbillioError, type Api } from '../lib/abillio.ts';
import { WRONG_ENGAGEMENT, describeError, runSmoke } from '../scripts/smoke.ts';

const invoice = (number: string, status: string) => ({ id: 'inv-1', invoice_number: number, status, public_url: 'u', amounts: { total: { amount: '12.10', currency: 'EUR' } } });

// Abillio as the smoke meets it: a sandbox key and a payable engagement e1,
// whose invoice is paid and whose payout settles. `answers` replaces a call.
function sandbox(answers: Record<string, () => unknown> = {}): Api {
  const calls: Record<string, () => unknown> = {
    'GET /me/session/': () => ({ account: { id: 'a1', name: 'Acme', slug: 'acme', is_sandbox: true }, user_email: '' }),
    'GET /me/authorization/': () => ({ actions: {} }),
    'POST /onboarding/sessions/': () => ({ session_id: 's1', url: 'https://new.abillio.dev/s/t', status: 'awaiting_freelancer', purpose: 'onboarding' }),
    'GET /accounts/clients/?limit=100': () => ({ items: [{ id: 'c-self', name: 'Acme', company_account_id: 'a1' }] }),
    'POST /engagements/e1/invoices/': () => invoice('', 'draft'),
    'POST /engagements/e1/invoices/inv-1/issue': () => invoice('DEMO-1', 'pending'),
    'POST /accounts/wallet/sandbox/simulate-deposit': () => [{ company_slug: 'abillio-ks', available: { amount: '50.00' } }],
    'POST /accounts/wallet/pay-invoice/': () => ({ created: true, operation_id: 'op-1' }),
    'GET /engagements/e1/payouts/?invoice_uuid=inv-1': () => ({ items: [{ id: 'p1', status: 'pending', invoice_uuid: 'inv-1' }] }),
    'POST /engagements/e1/payouts/p1/sandbox/simulate': () => ({ id: 'p1', status: 'paid' }),
    'GET /engagements/e1/payouts/p1': () => ({ id: 'p1', status: 'paid' }),
    ...answers,
  };
  return (async (method: string, path: string) => {
    const answer = calls[`${method} ${path}`];
    if (!answer) throw new Error(`unexpected ${method} ${path}`);
    return answer();
  }) as Api;
}

const smoke = (api: Api, lines: string[] = []) => runSmoke(api, { returnUrl: 'http://localhost:4000/back', engagementId: 'e1', company: 'abillio-ks', log: line => lines.push(line) });

test('the smoke passes only when the settled payout reads paid', async () => {
  const lines: string[] = [];
  await smoke(sandbox(), lines);
  assert.equal(lines.at(-1), 'payout p1 paid');
  // The simulation answered, but the payout did not end up paid: the gate fails.
  await assert.rejects(smoke(sandbox({ 'GET /engagements/e1/payouts/p1': () => ({ id: 'p1', status: 'processing' }) })), /payout p1 reads processing, not paid/);
});

test('a 403 or a 404 on the engagement says to check SMOKE_ENGAGEMENT_ID, not the key', async () => {
  for (const status of [403, 404]) {
    const refused = () => { throw new AbillioError(status, { error: { code: status === 403 ? 'forbidden' : 'not_found', message: 'Object authorization is no longer valid.' } }, ''); };
    await assert.rejects(smoke(sandbox({ 'POST /engagements/e1/invoices/': refused })), (err: unknown) => err instanceof AbillioError && err.hint === WRONG_ENGAGEMENT, String(status));
  }
});

test("a failed fetch's reason is printed: it sits in the error's cause", () => {
  const failed = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND backend.abillio.dev') });
  assert.deepEqual(describeError(failed), ['fetch failed', '  cause: getaddrinfo ENOTFOUND backend.abillio.dev']);
});
