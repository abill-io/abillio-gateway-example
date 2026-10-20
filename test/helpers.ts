import { spawnSync } from 'node:child_process';
import { defaultState, type State } from '../lib/store.ts';

// Node as `npm start` and `npm run smoke` start it, with nothing in the
// environment but PATH and what the test passes.
export function runNode(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', ...args], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
}

// The two stores the tests hand to the routes and steps, in place of
// data/state.json.
export function memoryState(initial: State = defaultState()) {
  let current = initial;
  return { load: () => current, update: (fn: (s: State) => void) => { fn(current); return current; } };
}

// The key and ABILLIO_ACCOUNT the test app runs with (appWith's Deps). The key
// id is as long as a real one, so a test can tell that the page masks it.
export const TEST_ENV = { keyId: 'key_6f1d0c9a8e7b5d3c2a4f8e6d1bdf', account: '' };

// What the key check stores for a sandbox key under TEST_ENV: every route that
// writes to Abillio runs only on such an account (or with ALLOW_PRODUCTION).
export function sandboxState(): State {
  const s = defaultState();
  s.account = { id: 'a1', name: 'Acme', slug: 'acme', is_sandbox: true, key_id: TEST_ENV.keyId, env_account: TEST_ENV.account };
  return s;
}

// Like data/state.json: every load() is a fresh copy, so a key minted on the
// copy a route loaded is lost unless that route's update() writes it back.
// memoryState hands out one shared object and cannot show that.
export function fileLikeState(initial: State = defaultState()) {
  let saved = structuredClone(initial);
  return {
    load: () => structuredClone(saved),
    update: (fn: (s: State) => void) => { const next = structuredClone(saved); fn(next); saved = next; return structuredClone(next); },
  };
}
