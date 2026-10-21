import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIREMENT_SIMULATIONS, simulateRequirement, startUpdate, updateLinkBody, type SimulatedEngagement } from '../steps/02b-requirements.ts';
import { onboardingAction } from '../steps/02-onboard.ts';
import { defaultState, type Requirements } from '../lib/store.ts';
import type { Api } from '../lib/abillio.ts';

// What the engagement lists once `kind` reopened: one item due.
const reopened = (kind: string): Requirements => ({ status: 'blocked', due: [{ kind, state: 'due', blocks: ['invoices'], detail: 'x', due_at: null, resource_id: null }], upcoming: [] });

test('each simulation posts its own kind and outcome for the engagement, under a UUID claimed as simulate-requirement:<engagement>:<kind>:<outcome>, and answers what the sample keeps of the engagement', async () => {
  const calls: { method: string; path: string; body: unknown; key: string }[] = [];
  const api = (async (method: string, path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
    calls.push({ method, path, body, key: opts?.idempotencyKey ?? '' });
    const { kind } = body as { kind: string };
    // A withdrawn mandate leaves the freelancer payable; the other two do not.
    return { id: 'e1', status: 'active', counterparty: { email: 'anna@example.com' }, compliance: { can_be_paid: kind === 'mandate' }, requirements: reopened(kind) };
  }) as Api;
  const state = defaultState();
  const answers: SimulatedEngagement[] = [];
  for (const simulation of REQUIREMENT_SIMULATIONS) answers.push(await simulateRequirement(api, state, 'e1', simulation));
  assert.deepEqual(calls.map(c => [c.method, c.path, c.body]), [
    ['POST', '/engagements/e1/requirements/sandbox/simulate', { kind: 'identity_verification', outcome: 'expired' }],
    ['POST', '/engagements/e1/requirements/sandbox/simulate', { kind: 'payout_method', outcome: 'removed' }],
    ['POST', '/engagements/e1/requirements/sandbox/simulate', { kind: 'mandate', outcome: 'revoked' }],
  ]);
  assert.deepEqual(state.idempotency, {
    'simulate-requirement:e1:identity_verification:expired': calls[0].key,
    'simulate-requirement:e1:payout_method:removed': calls[1].key,
    'simulate-requirement:e1:mandate:revoked': calls[2].key,
  }, 'each key is stored under its own action');
  assert.ok(calls.every(c => /^[0-9a-f-]{36}$/.test(c.key)), 'and is a UUID, never the action itself');
  assert.deepEqual(answers, [
    { id: 'e1', status: 'active', can_be_paid: false, requirements: reopened('identity_verification') },
    { id: 'e1', status: 'active', can_be_paid: false, requirements: reopened('payout_method') },
    { id: 'e1', status: 'active', can_be_paid: true, requirements: reopened('mandate') },
  ], 'can_be_paid is compliance.can_be_paid; the list is kept as listed while open');
});

test('an update link is the same mint for the stored address with purpose update, keyed like the first mint on the address and a digest of its exact body', async () => {
  const calls: { path: string; body: unknown; key: string }[] = [];
  const api = (async (_m: string, path: string, body: unknown, opts?: { idempotencyKey?: string }) => {
    calls.push({ path, body, key: opts?.idempotencyKey ?? '' });
    return { session_id: 's2', url: 'https://new.abillio.dev/s/tok2', expires_at: '2026-10-22T09:00:00Z', status: 'awaiting_freelancer', purpose: 'update', mode: 'maintenance' };
  }) as Api;
  const state = defaultState();
  const body = updateLinkBody('Anna@Example.com', 'http://localhost:4000/back');
  assert.deepEqual(await startUpdate(api, state, body), { session_id: 's2', url: 'https://new.abillio.dev/s/tok2', origin: 'https://new.abillio.dev', purpose: 'update' });
  assert.deepEqual(calls.map(c => [c.path, c.body]), [['/onboarding/sessions/', { email: 'Anna@Example.com', return_url: 'http://localhost:4000/back', purpose: 'update' }]]);
  const action = onboardingAction(body);
  assert.match(action, /^onboard:anna@example\.com:[0-9a-f]{8}$/);
  assert.equal(state.idempotency[action], calls[0].key, 'the key sent is the one stored under that action');
  assert.notEqual(onboardingAction(updateLinkBody('Anna@Example.com', 'https://demo.abillio.dev/back')), action, 'another return_url is another body, so another attempt');
});
