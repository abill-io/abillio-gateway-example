// `data/state.json` is the partner's database in this sample: everything a
// real integration would keep in its own tables, in one readable file. It is
// written whole, through a temp file and a rename, so a crash mid-write leaves
// the previous version intact.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type StoredEvent = {
  received_at: string;
  event_type: string;
  data: Record<string, unknown>;
  via: 'webhook' | 'poll';
  dedupe_key?: string;
};

// What the partner asked Abillio to draft, dated once. It is stored before the
// first draft call, and a retry re-sends exactly this: under a kept key a later
// day or an edited form would make it a different request, which Abillio
// refuses (409).
export type InvoiceRequest = {
  engagement_id: string;
  description: string;
  unit_price: string;
  currency_code: string;
  issued_date: string;
  due_date: string;
};

export type State = {
  // From the key check. `is_sandbox` is what every route that writes to
  // Abillio asks before it does (server.ts); `key_id` and `env_account` are
  // the key and the ABILLIO_ACCOUNT the check was made with, since the answer
  // is about them: with either changed in .env, it no longer counts.
  account: { id: string; name: string; slug: string; is_sandbox: boolean; key_id: string; env_account: string } | null;
  freelancer: {
    email: string;
    session_id: string;
    session_url: string;
    engagement_id: string | null;
    servicing_company_slug: string | null;
  } | null;
  invoice: { id: string; number: string; status: string; public_url: string } | null;
  invoice_request: InvoiceRequest | null;
  payout: { id: string; status: string } | null;
  // Stored as soon as Abillio answers the channel POST, before the
  // subscription exists (subscription_id null until it does).
  webhook: { channel_id: string; subscription_id: string | null; secret: string; url: string } | null;
  // What the channel POST sends, decided once and stored before the first
  // call, like `invoice_request`: a retry under a kept key re-sends exactly
  // this. Cleared with the key on a refusal, and once the webhook is complete.
  webhook_request: { url: string; secret: string } | null;
  idempotency: Record<string, string>;
  events: StoredEvent[];
};

const DEFAULT_FILE = process.env.STATE_FILE || join(process.cwd(), 'data', 'state.json');

export function defaultState(): State {
  return { account: null, freelancer: null, invoice: null, invoice_request: null, payout: null, webhook: null, webhook_request: null, idempotency: {}, events: [] };
}

export function loadState(file: string = DEFAULT_FILE): State {
  if (!existsSync(file)) return defaultState();
  const raw = readFileSync(file, 'utf8');
  try {
    return { ...defaultState(), ...(JSON.parse(raw) as Partial<State>) };
  } catch {
    throw new Error(`${file}: state.json is not valid JSON — fix it or delete it to start over.`);
  }
}

export function saveState(state: State, file: string = DEFAULT_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, file);
}

export function updateState(mutate: (state: State) => void, file: string = DEFAULT_FILE): State {
  const state = loadState(file);
  mutate(state);
  saveState(state, file);
  return state;
}

// One key per action, kept, so a second click on the same button replays the
// first answer instead of creating a second invoice or payment.
export function idempotencyKeyFor(state: State, action: string): string {
  const existing = state.idempotency[action];
  if (existing) return existing;
  const minted = randomUUID();
  state.idempotency[action] = minted;
  return minted;
}

// The event log keeps the newest EVENT_LIMIT events. On the hosted copy anyone
// can make Abillio send a test delivery, every write rewrites the whole file
// and the page renders the log, so it must not grow without bound. Both
// writers, the webhook receiver and the poll, append through here.
export const EVENT_LIMIT = 200;
export function appendEvent(state: State, event: StoredEvent): void {
  state.events.push(event);
  if (state.events.length > EVENT_LIMIT) state.events.splice(0, state.events.length - EVENT_LIMIT);
}

// Where a route reads and writes the state: data/state.json in the app, an
// object in the tests.
export type Store = { load: () => State; update: (fn: (s: State) => void) => State };

// The shape of createApp's keyed() helper (server.ts): a step that sends a
// keyed call takes it, so the route alone decides when a key is claimed and
// when it is forgotten. `once` spends the key on any settled answer (an
// action that is an event); `onRefused` clears what came with the key, in the
// same write, when the answer is a refusal Abillio composed itself (an
// enveloped 4xx whose code is not `idempotency_*`: AbillioError.verified).
export type KeyedOptions = { once?: boolean; onRefused?: (s: State) => void };
export type Keyed = <T>(state: State, action: string, call: () => Promise<T>, opts?: KeyedOptions) => Promise<T>;

// Abillio keeps the key of a call it answered with an error spent: a retry
// with that key is a 409. Forgetting it makes the next press mint a new key,
// so it is a new attempt.
export function forgetIdempotencyKey(state: State, action: string): void {
  delete state.idempotency[action];
}
