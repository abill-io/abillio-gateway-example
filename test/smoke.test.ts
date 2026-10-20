import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbillioError, type Api } from '../lib/abillio.ts';
import { WRONG_ENGAGEMENT, describeError, runSmoke } from '../scripts/smoke.ts';
import { runNode as node } from './helpers.ts';

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

test('a refusal on the engagement points at SMOKE_ENGAGEMENT_ID: a 403 keeps the permission hint too, a 404 is only the id', async () => {
  for (const status of [403, 404]) {
    const envelope = { error: { code: status === 403 ? 'forbidden' : 'not_found', message: 'Object authorization is no longer valid.' } };
    // What the client itself says: a 403 names the key's permissions, a 404 nothing.
    const permission = new AbillioError(status, envelope, '').hint;
    const refused = () => { throw new AbillioError(status, envelope, ''); };
    await assert.rejects(smoke(sandbox({ 'POST /engagements/e1/invoices/': refused })), (err: unknown) => {
      assert.ok(err instanceof AbillioError);
      const hints = [...(permission ? [permission] : []), WRONG_ENGAGEMENT];
      assert.deepEqual(err.hint?.split('\n'), hints, `${status}`);
      assert.deepEqual(describeError(err).slice(1, 1 + hints.length), hints, `${status}: one line each`);
      return true;
    });
  }
});

test("a failed fetch's reason is printed: the error's cause, an AggregateError's code and the errors it gathers", () => {
  const dns = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND backend.abillio.dev') });
  assert.deepEqual(describeError(dns), ['fetch failed', '  cause: getaddrinfo ENOTFOUND backend.abillio.dev']);
  // A refused connection is an AggregateError with no message: one error per address tried.
  const attempts = [new Error('connect ECONNREFUSED ::1:4000'), new Error('connect ECONNREFUSED 127.0.0.1:4000')];
  const refused = new TypeError('fetch failed', { cause: Object.assign(new AggregateError(attempts, ''), { code: 'ECONNREFUSED' }) });
  assert.deepEqual(describeError(refused), ['fetch failed', '  cause: ECONNREFUSED (connect ECONNREFUSED ::1:4000; connect ECONNREFUSED 127.0.0.1:4000)']);
  const uncoded = new TypeError('fetch failed', { cause: new AggregateError(attempts, '') });
  assert.deepEqual(describeError(uncoded), ['fetch failed', '  cause: connect ECONNREFUSED ::1:4000; connect ECONNREFUSED 127.0.0.1:4000']);
});

test('the smoke runs when started through a symlink, and an npm run smoke that never reaches it fails instead of passing', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // No key in the environment: a smoke that runs fails on it; one that never
  // ran would exit 0, and a release gate would pass.
  const dir = mkdtempSync(join(tmpdir(), 'gw-smoke-'));
  try {
    symlinkSync(root, join(dir, 'checkout'));
    const linked = node([join(dir, 'checkout', 'scripts', 'smoke.ts')], {});
    assert.equal(linked.status, 1, linked.stderr);
    assert.match(linked.stderr, /ABILLIO_API_KEY_ID is missing/);
  } finally {
    // unlink, never a recursive remove: that would follow the link into the checkout.
    try { unlinkSync(join(dir, 'checkout')); } catch { /* never linked */ }
    rmdirSync(dir);
  }
  const imported = node(['--input-type=module', '-e', `await import(${JSON.stringify(join(root, 'scripts', 'smoke.ts'))});`], { npm_lifecycle_event: 'smoke' });
  assert.equal(imported.status, 1, imported.stderr);
  assert.match(imported.stderr, /nothing ran/);
});
