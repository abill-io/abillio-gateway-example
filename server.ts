// The sample's one process: two pages, the step buttons, the webhook receiver
// and an event stream for the page. Everything Abillio-facing is injected so
// the routes are tested with a fake `api` and an in-memory state.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createApi, type Api } from './lib/abillio.ts';
import { loadEnv } from './lib/env.ts';
import { loadState, updateState, type State } from './lib/store.ts';
import { Trace, trace as processTrace } from './lib/trace.ts';
import { checkKey, type KeyReport } from './steps/01-key.ts';
import { companyPage } from './views/company.ts';

export type Deps = {
  api: Api;
  state: { load: () => State; update: (fn: (s: State) => void) => State };
  trace: Trace;
  publicUrl: string | null;
  port: number;
  abillioOrigin: () => string | null;
  // Called whenever a webhook or a poll stored an event (tests spy on it).
  onStored: () => void;
  // Injected clock, so signature windows are testable.
  now: () => number;
  // The polling fallback runs inside the app on this interval; null = off
  // (tests, and any run with a PUBLIC_URL).
  pollIntervalMs: number | null;
};

export function createApp(deps: Deps): Hono {
  const app = new Hono();
  let lastKey: KeyReport | null = null;
  const refreshListeners = new Set<() => void>();
  // One place that says "the page should reload": the receiver (Task 9),
  // the poller (Task 9) and the trace all end up here.
  const notifyStored = () => { deps.onStored(); for (const fn of refreshListeners) fn(); };

  // `c.html` is typed `Response | Promise<Response>` (it also takes a
  // Promise<string>); a route handler returns either.
  const render = (c: { html: (s: string) => Response | Promise<Response> }, error: unknown = null) =>
    c.html(companyPage({ state: deps.state.load(), trace: deps.trace.list(), key: lastKey, error, publicUrl: deps.publicUrl }));

  app.use('/public/*', serveStatic({ root: './' }));

  app.get('/', c => render(c));

  app.post('/steps/key', async c => {
    try {
      lastKey = await checkKey(deps.api);
      const { id, name, slug } = lastKey.account;
      deps.state.update(s => { s.account = { id, name, slug }; });
      return render(c);
    } catch (err) {
      return render(c, err);
    }
  });

  app.get('/api/state', c => c.json(deps.state.load()));
  app.get('/api/trace', c => c.json(deps.trace.list()));

  app.get('/events', c =>
    streamSSE(c, async stream => {
      const send = () => stream.writeSSE({ event: 'refresh', data: String(Date.now()) });
      refreshListeners.add(send);
      const unsubscribe = deps.trace.subscribe(() => send());
      stream.onAbort(() => { refreshListeners.delete(send); unsubscribe(); });
      while (!stream.aborted) await stream.sleep(15_000);
    }),
  );

  // Tasks 6–10 add their routes above this line; Task 9 uses `notifyStored`.
  void notifyStored;
  return app;
}

export function main(): void {
  const env = loadEnv();
  const app = createApp({
    api: createApi(env),
    state: { load: () => loadState(), update: fn => updateState(fn) },
    trace: processTrace,
    publicUrl: env.publicUrl,
    port: env.port,
    abillioOrigin: () => {
      const url = loadState().freelancer?.session_url;
      return url ? new URL(url).origin : null;
    },
    onStored: () => {},
    now: Date.now,
    pollIntervalMs: env.publicUrl ? null : 5000,
  });
  serve({ fetch: app.fetch, port: env.port }, info => {
    console.log(`Abillio gateway example on http://localhost:${info.port}` + (env.publicUrl ? ` (public: ${env.publicUrl})` : ' (no PUBLIC_URL: webhooks off, polling on)'));
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
