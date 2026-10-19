// The sample's one process: two pages, the step buttons, the webhook receiver
// and an event stream for the page. Everything Abillio-facing is injected so
// the routes are tested with a fake `api` and an in-memory state.
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { streamSSE } from 'hono/streaming';
import { AbillioError, createApi, type Api } from './lib/abillio.ts';
import { loadEnv } from './lib/env.ts';
import { forgetIdempotencyKey, loadState, updateState, type KeyedOptions, type State, type Store } from './lib/store.ts';
import { Trace, trace as processTrace } from './lib/trace.ts';
import { dedupeKey, parseDelivery, verifySignature } from './lib/webhooks.ts';
import { checkKey, type KeyReport } from './steps/01-key.ts';
import { findEngagement, onboardingAction, onboardingBody, readSession, returnUrlFor, startOnboarding, type JoinForm } from './steps/02-onboard.ts';
import { draftInvoice, findSelfClient, invoiceRequest, issueInvoice, pendingRequest } from './steps/03-issue.ts';
import { DEFAULT_COMPANY, PAYOUT_OUTCOMES, findPayout, fundWallet, payAction, payInvoice, readInvoice, readPayout, simulateAction, simulatePayout } from './steps/04-pay.ts';
import { connectWebhooks, pollForEvents, sendTestDelivery } from './steps/05-events.ts';
import { companyPage } from './views/company.ts';
import { joinPage } from './views/join.ts';
import { page } from './views/layout.ts';

export type Deps = {
  api: Api;
  state: Store;
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
  // The hosted copy is a public page with no login, so a foreign site must not
  // be able to drive its buttons: Hono's guard refuses a form POST whose
  // Origin is not this server's own. It ignores JSON bodies, so Abillio's
  // webhook deliveries (no Origin, application/json) pass untouched. It also
  // refuses a form POST that carries no Origin at all, which is every client
  // that is not a browser (curl, a script, the tests), so it only judges what
  // a browser sent: browsers put Origin, and Sec-Fetch-Site, on every POST, so
  // no foreign page can make one send neither.
  const crossSite = csrf();
  app.use(async (c, next) => (c.req.header('origin') === undefined && c.req.header('sec-fetch-site') === undefined ? next() : crossSite(c, next)));
  let lastKey: KeyReport | null = null;
  const refreshListeners = new Set<() => void>();
  // One place that says "the page should reload": the webhook receiver and
  // the poller (both Task 9) end up here.
  const notifyStored = () => { deps.onStored(); for (const fn of refreshListeners) fn(); };
  // What a page or /api/state may show of the state: everything except the
  // webhook signing secret, connected or still pending. On the hosted copy
  // every visitor sees this page, and the secret is what lets someone forge a
  // delivery.
  const mask = (secret: string) => '…' + secret.slice(-4);
  const publicState = (s: State): State => ({
    ...s,
    webhook: s.webhook && { ...s.webhook, secret: mask(s.webhook.secret) },
    webhook_request: s.webhook_request && { ...s.webhook_request, secret: mask(s.webhook_request.secret) },
  });

  // `c.html` is typed `Response | Promise<Response>` (it also takes a
  // Promise<string>); a route handler returns either.
  const render = (c: { html: (s: string) => Response | Promise<Response> }, error: unknown = null) =>
    c.html(companyPage({ state: publicState(deps.state.load()), trace: deps.trace.list(), key: lastKey, error, publicUrl: deps.publicUrl }));

  // One keyed call. The key is claimed in the store BEFORE the call, so an
  // overlapping press, a restart or a crash mid-call reuses it instead of
  // minting a second one. Afterwards only an answer Abillio itself composed —
  // an enveloped 4xx — proves the key is spent and forgets it; a bare 409 from
  // its idempotency layer, a 5xx or a network failure leave the outcome
  // unknown, and the key stays, so the next press replays. Only this action's
  // key is written, never the whole map: another tab (or, on the hosted copy,
  // another visitor) may have stored keys meanwhile. The forget, and whatever
  // `onRefused` clears with it in the same write, happens only while the
  // stored key is still the one this call sent: a newer one, and what came
  // with it, belong to another press. `once` marks an action that is an event,
  // not a state (a sandbox simulation): after any settled answer, a success
  // too, its key is forgotten, so the next press plays it again; only an
  // unknown outcome keeps it, so a blind retry replays.
  async function keyed<T>(state: State, action: string, call: () => Promise<T>, opts: KeyedOptions = {}): Promise<T> {
    let claimed = '';
    deps.state.update(s => { claimed = state.idempotency[action] = s.idempotency[action] ??= randomUUID(); });
    const forget = (also: (s: State) => void = () => {}) => {
      forgetIdempotencyKey(state, action);
      deps.state.update(s => {
        if (s.idempotency[action] !== claimed) return;
        delete s.idempotency[action];
        also(s);
      });
    };
    try {
      const answer = await call();
      if (opts.once) forget();
      return answer;
    } catch (err) {
      if (err instanceof AbillioError && err.verified) forget(opts.onRefused);
      throw err;
    }
  }

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

  app.get('/join', c => c.html(joinPage(deps.state.load(), deps.abillioOrigin())));

  app.post('/join', async c => {
    const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email ?? '')) return c.text('e-mail looks wrong', 422);
    const locale = form.locale === 'en' ? 'en' : 'lv';
    const state = deps.state.load();
    const join: JoinForm = { first_name: form.first_name ?? '', last_name: form.last_name ?? '', email: form.email, tax_country: form.tax_country || 'LV', locale };
    const returnUrl = returnUrlFor(deps.publicUrl, deps.port);
    try {
      // keyed() claims and keeps the key of this exact body (onboardingAction);
      // startOnboarding derives the same action and sends that key.
      const session = await keyed(state, onboardingAction(onboardingBody(join, returnUrl)), () => startOnboarding(deps.api, state, join, returnUrl));
      // The same freelancer (the same address) keeps their engagement, and with
      // it steps 3 and 4. Another one's engagement is looked up by /join/status,
      // which starts those steps over once it finds a different one.
      deps.state.update(s => {
        const previous = s.freelancer?.email.toLowerCase() === form.email.toLowerCase() ? s.freelancer : null;
        s.freelancer = { email: form.email, session_id: session.session_id, session_url: session.url, engagement_id: previous?.engagement_id ?? null, servicing_company_slug: previous?.servicing_company_slug ?? null };
      });
      return c.json(session);
    } catch (err) {
      return c.text(err instanceof AbillioError ? `${err.code}: ${err.message}` : String(err), 502);
    }
  });

  app.get('/join/status', async c => {
    const f = deps.state.load().freelancer;
    if (!f) return c.json({ state: 'none', can_be_paid: false, requirements: [] });
    // Either Abillio read can fail (a 401, a network blip). The answer is then
    // a 502 with the error text, which the page's poll skips before asking
    // again on its next tick, instead of an unhandled 500.
    try {
      const status = await readSession(deps.api, f.session_id);
      let engagementId = f.engagement_id;
      if (status.state !== 'awaiting_freelancer' && !engagementId) {
        const engagement = await findEngagement(deps.api, f.email);
        if (engagement) {
          engagementId = engagement.id;
          deps.state.update(s => {
            // Only for the session this poll read: a newer join replaced it.
            if (!s.freelancer || s.freelancer.session_id !== f.session_id) return;
            // Steps 3 and 4 belong to one engagement; another one starts them over.
            if (s.freelancer.engagement_id !== engagement.id) { s.invoice = null; s.invoice_request = null; s.payout = null; }
            s.freelancer.engagement_id = engagement.id;
            s.freelancer.servicing_company_slug = engagement.servicing_company_slug;
          });
        }
      }
      return c.json({ ...status, engagement_id: engagementId });
    } catch (err) {
      return c.text(err instanceof AbillioError ? `${err.code}: ${err.message}` : String(err), 502);
    }
  });

  app.post('/steps/issue', async c => {
    const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
    const state = deps.state.load();
    const engagementId = state.freelancer?.engagement_id;
    if (!engagementId || !state.account) return render(c, new Error('Join a freelancer first (step 2) and check the key (step 1).'));
    try {
      // What a press does follows from what is stored (`issueStage`), so an
      // engagement is drafted for once: with an invoice stored, a draft or an
      // issued one, the press only (re)sends the issue call.
      let invoice = state.invoice;
      if (!invoice) {
        // With nothing pending the form is the request, so it has to be filled in.
        if (!pendingRequest(state) && (!(form.description ?? '').trim() || !(form.unit_price ?? '').trim())) {
          return render(c, new Error('Fill in the description and the unit price.'));
        }
        // The unkeyed read goes first and outside keyed(): its failure says
        // nothing about any key.
        const self = await findSelfClient(deps.api, state.account.id);
        // Decided on what is stored, in the same write: a stored request for
        // this engagement is re-sent as it is (the form is then ignored), even
        // one another press stored meanwhile, so the bytes under the key never
        // change with the day or the form.
        const fresh = invoiceRequest(engagementId, { description: form.description ?? '', unit_price: form.unit_price ?? '', currency_code: form.currency_code || 'EUR' }, new Date(deps.now()));
        const request = deps.state.update(s => { s.invoice_request = s.invoice_request?.engagement_id === engagementId ? s.invoice_request : fresh; }).invoice_request ?? fresh;
        // On a certain refusal nothing was drafted, so the request goes with the
        // key and the form is free again.
        const drafted = await keyed(state, `draft:${request.engagement_id}`, () => draftInvoice(deps.api, state, request, self.id), { onRefused: s => { s.invoice_request = null; } });
        invoice = { id: drafted.id, number: drafted.number, status: drafted.status, public_url: drafted.public_url };
        const stored = invoice;
        // Another press may have stored this draft, and issued it, meanwhile.
        deps.state.update(s => { s.invoice ??= stored; });
      }
      const id = invoice.id;
      const issued = await keyed(state, `issue:${id}`, () => issueInvoice(deps.api, state, engagementId, id));
      // The answer replaces only the draft it issued. Past the draft a press
      // just shows the replay: its answer is the first issue's, which can be
      // older than what a later step stored.
      deps.state.update(s => { if (s.invoice?.id === id && s.invoice.status === 'draft') s.invoice = { id, number: issued.number, status: issued.status, public_url: issued.public_url }; });
      return render(c);
    } catch (err) {
      return render(c, err);
    }
  });

  app.post('/steps/pay/fund', async c => {
    const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
    const state = deps.state.load();
    try {
      await fundWallet(deps.api, form.amount || '250.00', 'EUR', state.freelancer?.servicing_company_slug ?? DEFAULT_COMPANY);
      return render(c);
    } catch (err) { return render(c, err); }
  });

  app.post('/steps/pay/pay', async c => {
    const state = deps.state.load();
    const engagementId = state.freelancer?.engagement_id;
    if (!state.invoice || !engagementId) return render(c, new Error('Issue an invoice first (step 3).'));
    try {
      const invoiceId = state.invoice.id;
      // keyed() claims pay:<invoice> in the store before the call and forgets
      // it only on a verified failure, so a retry after a timeout replays and
      // never pays twice; the GETs stay outside it.
      await keyed(state, payAction(invoiceId), () => payInvoice(deps.api, state, invoiceId));
      // Both reads come before the one write: a failed lookup stores nothing,
      // so the invoice still reads `pending`, Pay stays enabled, and pressing
      // it again replays the payment and reads again.
      const payout = await findPayout(deps.api, engagementId, invoiceId);
      const invoice = await readInvoice(deps.api, invoiceId);
      // Only onto the invoice this press paid: meanwhile another freelancer may
      // have been found, which starts steps 3 and 4 over.
      deps.state.update(s => {
        if (s.invoice?.id !== invoiceId) return;
        s.invoice.status = invoice.status;
        s.payout = payout;
      });
      return render(c);
    } catch (err) { return render(c, err); }
  });

  app.post('/steps/pay/simulate', async c => {
    const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
    const outcome = PAYOUT_OUTCOMES.find(o => o === form.outcome);
    const state = deps.state.load();
    const engagementId = state.freelancer?.engagement_id;
    if (!outcome || !state.payout || !engagementId) return render(c, new Error('Pay the invoice first; then pick an outcome.'));
    try {
      const payoutId = state.payout.id;
      // A simulation is an event, not a state: once answered, its key is spent
      // (`once`), so `paid` after `returned` plays again instead of replaying
      // the first `paid`. An answer can still be a replay (after a lost one)
      // and older than the payout, so what is stored is a fresh read, and only
      // onto the payout it was for.
      await keyed(state, simulateAction(payoutId, outcome), () => simulatePayout(deps.api, state, engagementId, payoutId, outcome), { once: true });
      const payout = await readPayout(deps.api, engagementId, payoutId);
      deps.state.update(s => { if (s.payout?.id === payoutId) s.payout = payout; });
      return render(c);
    } catch (err) { return render(c, err); }
  });

  app.post('/webhooks/abillio', async c => {
    const state = deps.state.load();
    if (!state.webhook) return c.text('webhooks not connected: set PUBLIC_URL and press Connect', 503);
    const raw = Buffer.from(await c.req.arrayBuffer());
    const verdict = verifySignature(state.webhook.secret, { timestamp: c.req.header('x-timestamp') ?? null, signature: c.req.header('x-signature') ?? null }, raw, deps.now);
    if (!verdict.ok) {
      deps.trace.push({ at: new Date(deps.now()).toISOString(), method: 'WEBHOOK', path: '/webhooks/abillio', requestBody: null, status: verdict.status, responseBody: null, idempotencyKey: null, replayed: false, error: `refused: ${verdict.reason}` });
      return c.text(verdict.reason, verdict.status);
    }
    const delivery = parseDelivery(raw);
    if (!delivery) return c.text('not a delivery', 400);
    const key = dedupeKey(delivery.event_type, raw);
    // The test delivery has a constant body and no retries: every press is a
    // new one on purpose, so it is never deduped. Real events carry their
    // emission time inside the body, so distinct emissions never collide.
    // Decided inside the write, against what is stored by then: two copies
    // that arrive together are stored once, and the page is told once.
    let stored = false;
    deps.state.update(s => {
      if (delivery.event_type !== 'channel.test' && s.events.some(e => e.dedupe_key === key)) return;
      s.events.push({ received_at: new Date(deps.now()).toISOString(), event_type: delivery.event_type, data: delivery.data, via: 'webhook', dedupe_key: key });
      stored = true;
    });
    if (stored) notifyStored();
    return c.text('ok', 200);
  });

  // The polling fallback, inside the app so it shares `notifyStored`; off in
  // tests and whenever webhooks are on. `unref()` keeps it from holding the
  // process open.
  if (deps.pollIntervalMs !== null) {
    const timer = setInterval(async () => {
      const state = deps.state.load();
      try {
        const fresh = await pollForEvents(deps.api, state);
        if (fresh.length) {
          // Guarded: the poll's copy may be older than what a route stored
          // meanwhile (a re-join, a new invoice, a start over), so it only
          // updates the rows it polled and appends only this poll's events,
          // each once; anything else in its copy may be gone from the store
          // on purpose.
          deps.state.update(s => {
            if (state.invoice && s.invoice?.id === state.invoice.id) s.invoice = state.invoice;
            if (state.payout && s.payout?.id === state.payout.id) s.payout = state.payout;
            for (const e of fresh) if (!e.dedupe_key || !s.events.some(x => x.dedupe_key === e.dedupe_key)) s.events.push(e);
          });
          notifyStored();
        }
      } catch (err) {
        console.warn('poll failed:', (err as Error).message);
      }
    }, deps.pollIntervalMs);
    timer.unref();
  }

  app.post('/steps/events/connect', async c => {
    if (!deps.publicUrl) return render(c, new Error('Set PUBLIC_URL (npm run tunnel prints how) and restart to receive webhooks.'));
    // connectWebhooks stores each answer as it comes (step 5's file says why).
    try {
      await connectWebhooks(deps.api, keyed, deps.state, deps.publicUrl);
      return render(c);
    } catch (err) { return render(c, err); }
  });

  app.post('/steps/events/test', async c => {
    const state = deps.state.load();
    if (!state.webhook) return render(c, new Error('Connect webhooks first.'));
    try { await sendTestDelivery(deps.api, state.webhook.channel_id); return render(c); } catch (err) { return render(c, err); }
  });

  app.get('/back', c => c.html(page('Back', '<main class="one-col"><section class="panel"><h1>Thanks — you can close this window.</h1><p class="muted">Abillio sends the freelancer here when the popup has no opener to post to.</p></section></main>')));

  app.get('/api/state', c => c.json(publicState(deps.state.load())));
  app.get('/api/trace', c => c.json(deps.trace.list()));

  // `refresh` fires only when something was STORED (a webhook, a poll): a
  // button's own request renders its page itself, and a refresh on every
  // traced call would reload the page mid-request and throw the answer away.
  app.get('/events', c =>
    streamSSE(c, async stream => {
      const send = () => stream.writeSSE({ event: 'refresh', data: String(Date.now()) });
      refreshListeners.add(send);
      stream.onAbort(() => { refreshListeners.delete(send); });
      while (!stream.aborted) await stream.sleep(15_000);
    }),
  );

  // Task 10 adds its routes above this line.
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
