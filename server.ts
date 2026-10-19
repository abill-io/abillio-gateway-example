// The sample's one process: two pages, the step buttons, the webhook receiver
// and an event stream for the page. Everything Abillio-facing is injected so
// the routes are tested with a fake `api` and an in-memory state.
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AbillioError, createApi, type Api } from './lib/abillio.ts';
import { loadEnv } from './lib/env.ts';
import { forgetIdempotencyKey, loadState, updateState, type State } from './lib/store.ts';
import { Trace, trace as processTrace } from './lib/trace.ts';
import { checkKey, type KeyReport } from './steps/01-key.ts';
import { findEngagement, onboardingAction, onboardingBody, readSession, returnUrlFor, startOnboarding, type JoinForm } from './steps/02-onboard.ts';
import { draftInvoice, findSelfClient, invoiceRequest, issueInvoice, pendingRequest } from './steps/03-issue.ts';
import { companyPage } from './views/company.ts';
import { joinPage } from './views/join.ts';
import { page } from './views/layout.ts';

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
  // One place that says "the page should reload": the webhook receiver and
  // the poller (both Task 9) end up here.
  const notifyStored = () => { deps.onStored(); for (const fn of refreshListeners) fn(); };
  // What a page or /api/state may show of the state: everything except the
  // webhook signing secret. On the hosted copy every visitor sees this page,
  // and the secret is what lets someone forge a delivery.
  const publicState = (s: State): State => (s.webhook ? { ...s, webhook: { ...s.webhook, secret: '…' + s.webhook.secret.slice(-4) } } : s);

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
  // with it, belong to another press.
  async function keyed<T>(state: State, action: string, call: () => Promise<T>, onRefused: (s: State) => void = () => {}): Promise<T> {
    let claimed = '';
    deps.state.update(s => { claimed = state.idempotency[action] = s.idempotency[action] ??= randomUUID(); });
    try {
      return await call();
    } catch (err) {
      if (err instanceof AbillioError && err.verified) {
        forgetIdempotencyKey(state, action);
        deps.state.update(s => {
          if (s.idempotency[action] !== claimed) return;
          delete s.idempotency[action];
          onRefused(s);
        });
      }
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
        const drafted = await keyed(state, `draft:${request.engagement_id}`, () => draftInvoice(deps.api, state, request, self.id), s => { s.invoice_request = null; });
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
