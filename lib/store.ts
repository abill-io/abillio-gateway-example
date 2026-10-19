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

export type State = {
  account: { id: string; name: string; slug: string } | null;
  freelancer: {
    email: string;
    session_id: string;
    session_url: string;
    engagement_id: string | null;
    servicing_company_slug: string | null;
  } | null;
  invoice: { id: string; number: string; status: string; public_url: string } | null;
  payout: { id: string; status: string } | null;
  webhook: { channel_id: string; subscription_id: string; secret: string; url: string } | null;
  idempotency: Record<string, string>;
  events: StoredEvent[];
};

const DEFAULT_FILE = process.env.STATE_FILE || join(process.cwd(), 'data', 'state.json');

export function defaultState(): State {
  return { account: null, freelancer: null, invoice: null, payout: null, webhook: null, idempotency: {}, events: [] };
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
