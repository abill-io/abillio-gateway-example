import { defaultState, type State } from '../lib/store.ts';

// The two stores the tests hand to the routes and steps, in place of
// data/state.json.
export function memoryState(initial: State = defaultState()) {
  let current = initial;
  return { load: () => current, update: (fn: (s: State) => void) => { fn(current); return current; } };
}

// The key and ABILLIO_ACCOUNT the test app runs with (appWith's Deps).
export const TEST_ENV = { keyId: 'key_1', account: '' };

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
