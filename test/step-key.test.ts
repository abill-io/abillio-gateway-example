import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkKey, NEEDED_ACTIONS } from '../steps/01-key.ts';
import type { Api } from '../lib/abillio.ts';

function fakeApi(answers: Record<string, unknown>): Api {
  return (async (_method: string, path: string) => {
    if (!(path in answers)) throw new Error(`unexpected call ${path}`);
    return answers[path];
  }) as Api;
}

test('reads who the key acts as and marks the actions the sample needs', async () => {
  const report = await checkKey(fakeApi({
    '/me/session/': { account: { id: 'a1', name: 'Acme', slug: 'acme', is_sandbox: true, kind: 'company' }, is_owner: true, user_email: 'dev@acme.test' },
    '/me/authorization/': { actions: { 'freelancers.invite': { state: 'available' }, 'freelancers.view': { state: 'available' }, 'clients.view': { state: 'forbidden', reason_code: 'not_granted' }, 'sandbox.simulate': { state: 'forbidden', reason_code: 'not_granted' }, 'something.else': { state: 'available' } } },
  }));
  assert.equal(report.account.slug, 'acme');
  assert.equal(report.user_email, 'dev@acme.test');
  const sandbox = report.actions.find(a => a.id === 'sandbox.simulate');
  assert.deepEqual(sandbox, { id: 'sandbox.simulate', state: 'forbidden', needed: true });
  assert.deepEqual(report.actions.find(a => a.id === 'clients.view'), { id: 'clients.view', state: 'forbidden', needed: true }, "a key without it is flagged: step 3's self-client lookup reads the clients");
  assert.equal(report.actions.find(a => a.id === 'something.else')?.needed, false);
  // Needed actions come first, in the order the steps use them.
  assert.deepEqual(report.actions.slice(0, NEEDED_ACTIONS.length).map(a => a.id), NEEDED_ACTIONS);
});

test('an action the preview does not list is reported as unavailable, not dropped', async () => {
  const report = await checkKey(fakeApi({
    '/me/session/': { account: { id: 'a1', name: 'Acme', slug: 'acme', is_sandbox: true, kind: 'company' }, is_owner: true, user_email: 'x' },
    '/me/authorization/': { actions: {} },
  }));
  for (const id of NEEDED_ACTIONS) {
    assert.deepEqual(report.actions.find(a => a.id === id), { id, state: 'unavailable', needed: true });
  }
});
