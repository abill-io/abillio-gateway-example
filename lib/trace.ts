// The last N calls to Abillio, for the page's "what we just sent / got back"
// panel. Headers (the signature among them) are never recorded, and
// `createApi` replaces body keys named like secrets before pushing
// (`redactForTrace`): the page shows the trace to whoever opens it.
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
};

export class Trace {
  #entries: TraceEntry[] = [];
  #limit: number;
  #listeners = new Set<(entry: TraceEntry) => void>();

  constructor(limit = 50) {
    this.#limit = limit;
  }

  push(entry: TraceEntry): void {
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
