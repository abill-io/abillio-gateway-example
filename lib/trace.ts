// The last N calls to Abillio, for the page's "what we just sent / got back"
// panel. Headers (the signature among them) are never recorded, and
// `createApi` replaces body keys named like secrets or like personal data
// before pushing (`redactForTrace`): the page shows the trace to whoever opens it.
export type TraceEntry = {
  at: string;
  method: string;
  path: string;
  requestBody: unknown;
  status: number | null;
  responseBody: unknown;
  idempotencyKey: string | null;
  replayed: boolean;
  error: string | null;
  // How many identical GETs this entry stands for (see push); absent is one.
  count?: number;
};

// The same read with the same answer: what a poll sends every few seconds.
// An error envelope's request_id names the request, not the answer, and is
// new every time, so it is left out of the comparison.
function sameRead(a: TraceEntry, b: TraceEntry): boolean {
  return a.method === 'GET' && b.method === 'GET' && a.path === b.path && a.status === b.status && a.error === b.error
    && answerOf(a) === answerOf(b);
}

function answerOf(entry: TraceEntry): string {
  return JSON.stringify(entry.responseBody, (key, value) => (key === 'request_id' ? undefined : value));
}

export class Trace {
  #entries: TraceEntry[] = [];
  #limit: number;
  #listeners = new Set<(entry: TraceEntry) => void>();

  constructor(limit = 50) {
    this.#limit = limit;
  }

  // An identical GET again (the poller, or the join page's status check, with
  // nothing new to say) folds into the entry of the last one, which moves up
  // to newest with a count: without a public URL the polls alone would push
  // the walk's own calls out of the last fifty within minutes. Any other call,
  // and a read whose answer changed, is an entry of its own.
  push(entry: TraceEntry): void {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (!sameRead(this.#entries[i], entry)) continue;
      const [earlier] = this.#entries.splice(i, 1);
      entry = { ...entry, count: (earlier.count ?? 1) + 1 };
      break;
    }
    this.#entries.push(entry);
    if (this.#entries.length > this.#limit) this.#entries.shift();
    for (const fn of this.#listeners) fn(entry);
  }

  list(): TraceEntry[] {
    return [...this.#entries];
  }

  last(): TraceEntry | null {
    return this.#entries.at(-1) ?? null;
  }

  subscribe(fn: (entry: TraceEntry) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}

export const trace = new Trace();
