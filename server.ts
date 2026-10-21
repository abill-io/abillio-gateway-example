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
import { startedAsScript } from './lib/script.ts';
import { appendEvent, defaultState, forgetIdempotencyKey, loadState, updateState, type KeyedOptions, type State, type Store, type StoredEvent } from './lib/store.ts';
import { Trace, trace as processTrace } from './lib/trace.ts';
import { dedupeKey, parseDelivery, verifySignature } from './lib/webhooks.ts';
import { checkKey, type KeyReport } from './steps/01-key.ts';
import { findEngagement, onboardingAction, onboardingBody, openRequirements, readSession, returnUrlFor, setupDone, startOnboarding, type JoinForm } from './steps/02-onboard.ts';
import { REQUIREMENT_SIMULATIONS, simulateRequirement, simulateRequirementAction, startUpdate, updateLinkBody } from './steps/02b-requirements.ts';
import { draftInvoice, findSelfClient, invoiceRequest, issueInvoice, pendingRequest } from './steps/03-issue.ts';
import { DEFAULT_COMPANY, PAYOUT_OUTCOMES, findPayout, fundWallet, payAction, payInvoice, readInvoice, readPayout, simulateAction, simulatePayout } from './steps/04-pay.ts';
import { WEBHOOK_ACTIONS, aboutThisWalk, connectWebhooks, pollForEvents, recordCompletion, recordPoll, sendTestDelivery, type PollResult } from './steps/05-events.ts';
import { latestUpdate, type UpdateSummary } from './lib/updates.ts';
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
  // ALLOW_PRODUCTION=1: the write routes may act on a production account.
  allowProduction: boolean;
  // The key and ABILLIO_ACCOUNT this process signs with (from loadEnv): a
  // stored key check counts only for the same two.
  keyId: string;
  account: string;
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
  // no foreign page can make one send neither. This server's origin is two:
  // behind a TLS edge the request URL reads http (the Node adapter takes the
  // scheme from the socket, not X-Forwarded-Proto), while the browser's Origin
  // is the https address it opened, PUBLIC_URL's. A browser that sends no
  // Sec-Fetch-Site (Safari before 16.4) is judged on Origin alone.
  const publicOrigin = originOf(deps.publicUrl);
  const crossSite = csrf({ origin: (origin, c) => origin === new URL(c.req.url).origin || origin === publicOrigin });
  app.use(async (c, next) => (c.req.header('origin') === undefined && c.req.header('sec-fetch-site') === undefined ? next() : crossSite(c, next)));
  let lastKey: KeyReport | null = null;
  const refreshListeners = new Set<(update: UpdateSummary | null) => void>();
  // One place that says "the page has an update": the webhook receiver and
  // the poller end up here.
  const notifyStored = () => {
    deps.onStored();
    const update = latestUpdate(deps.state.load());
    for (const fn of refreshListeners) fn(update);
  };
  // Which stored events reload the page: one about this walk, and a test
  // delivery, which a button asked for. A reset re-creates Abillio's demo
  // freelancers, and the subscription hears their invoice events too: stored
  // and shown, they would otherwise reload every open back office for a walk
  // nobody here started.
  const announced = (s: State, e: StoredEvent) => e.event_type === 'channel.test' || aboutThisWalk(s, e);
  // The account the stored key check found, if that check was made with the
  // key and the ABILLIO_ACCOUNT this process signs with. A check made with
  // others says nothing about the account reached now, so the guard below and
  // the page both read it as no check at all.
  const boundAccount = (s: State): State['account'] =>
    s.account && s.account.key_id === deps.keyId && s.account.env_account === deps.account ? s.account : null;
  // What a page or /api/state may show of the state: everything except the
  // webhook signing secret, connected or still pending, the API key id the
  // key check was made with, and the freelancer's onboarding link. On the
  // hosted copy every visitor sees this page; the secret is what lets
  // someone forge a delivery, the key id is the credential's name, kept out
  // of sight like the rest of .env, and the link is the freelancer's to open
  // (guide §9) and to act on (a first link: they agree; an update link: the
  // mailed code signs them in), so whoever took it from here first could act
  // on it before them. The account is the bound one, so the page gates its
  // buttons as the guard does.
  const mask = (secret: string) => '…' + secret.slice(-4);
  const publicState = (s: State): State => {
    const account = boundAccount(s);
    return {
      ...s,
      account: account && { ...account, key_id: mask(account.key_id) },
      freelancer: s.freelancer && { ...s.freelancer, session_url: mask(s.freelancer.session_url) },
      webhook: s.webhook && { ...s.webhook, secret: mask(s.webhook.secret) },
      webhook_request: s.webhook_request && { ...s.webhook_request, secret: mask(s.webhook_request.secret) },
    };
  };

  // `c.html` is typed `Response | Promise<Response>` (it also takes a
  // Promise<string>); a route handler returns either.
  const render = (c: { req: { path: string }; html: (s: string) => Response | Promise<Response> }, error: unknown = null) => {
    const actionSteps: Record<string, number> = { key: 1, onboard: 2, issue: 3, pay: 4, events: 5 };
    const actionStep = actionSteps[c.req.path.split('/')[2] ?? ''];
    return c.html(companyPage({ state: publicState(deps.state.load()), trace: deps.trace.list(), key: lastKey, error, publicUrl: deps.publicUrl, focusStep: error ? actionStep : undefined, abillioOrigin: deps.abillioOrigin() }));
  };

  // One keyed call. The key is claimed in the store BEFORE the call, so an
  // overlapping press, a restart or a crash mid-call reuses it instead of
  // minting a second one. Afterwards only an answer Abillio itself composed —
  // an enveloped 4xx, but not an idempotency_* one — proves the key is spent
  // and forgets it; an answer from its idempotency layer (bare, or an
  // idempotency_* code: it still holds the key for an earlier attempt), a 5xx
  // or a network failure leave the outcome unknown, and the key stays, so the
  // next press replays. Only this action's key is written, never the whole
  // map: another tab (or, on the hosted copy, another visitor) may have
  // stored keys meanwhile. The forget, and whatever `onRefused` clears with it
  // in the same write, happens only while the stored key is still the one
  // this call sent: a newer one, and what came with it, belong to another
  // press. `once` marks an action that is an event, not a state (a sandbox
  // simulation, an onboarding mint whose single-use link may already be
  // spent): after any settled answer, a success too, its key is forgotten,
  // so the next press plays it again; only an unknown outcome keeps it, so a
  // blind retry replays.
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

  // The fonts carry their version in the file name, so a browser may keep
  // them for a year: every button press is a full page load. The stylesheet
  // and the scripts are not versioned and keep the default revalidation.
  // (Set around serveStatic: its onFound hook runs after the response exists.)
  app.use('/public/fonts/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('/public/*', serveStatic({ root: './' }));

  // Every route that writes to Abillio runs only against a sandbox account.
  // The sample mints links, invoices and payments with whatever key it is
  // given, and a key pasted from production would make them real. The key
  // check stores which kind of account the key reaches; until there is a
  // check for this process's key and ABILLIO_ACCOUNT (boundAccount), nothing
  // is sent. ALLOW_PRODUCTION=1 is the way past for a partner who means it.
  const sandboxRefusal = (): string | null => {
    if (deps.allowProduction) return null;
    const account = boundAccount(deps.state.load());
    if (account?.is_sandbox === true) return null;
    return account?.is_sandbox === false
      ? 'This back office runs against sandbox accounts only (the key belongs to a production account).'
      : 'Check the key first (step 1): this back office runs against sandbox accounts only.';
  };
  // What the join page's note says of a failed /join or /join/status: the
  // envelope's code and message, and the hint (a 403 names the key's
  // permissions), since the join page has no error box.
  const joinErrorText = (err: unknown): string =>
    err instanceof AbillioError ? [`${err.code}: ${err.message}`, err.hint].filter(Boolean).join(' — ') : String(err);

  // The two mints, /join and step 2's update link, answer the page's fetch in
  // plain text; the others render the back office.
  for (const path of ['/join', '/steps/onboard/update-link']) {
    app.post(path, async (c, next) => {
      const refusal = sandboxRefusal();
      if (refusal) return c.text(refusal, 403);
      await next();
    });
  }
  for (const path of ['/steps/onboard/simulate', '/steps/issue', '/steps/pay/*', '/steps/events/*', '/reset']) {
    app.post(path, async (c, next) => {
      const refusal = sandboxRefusal();
      if (refusal) return render(c, new Error(refusal));
      await next();
    });
  }

  // Liveness for the container orchestrator: no Abillio call, no state read.
  app.get('/healthz', c => c.text('ok'));

  // A status check: the session's answer and, once the freelancer has agreed,
  // the engagement's row, and what they change of the stored freelancer. The
  // join page's poll makes one every 3 s, the back office one on load, and
  // step 2's update-link follow one every 3 s. Either read can fail (a 401, a
  // network blip); each caller says what that means for its page.
  async function checkStatus(f: NonNullable<State['freelancer']>) {
    const status = await readSession(deps.api, f.session_id);
    // Abillio knows the engagement from when they agree, still `invited`, and
    // its status moves as the freelancer goes on (`active` once they can be
    // paid), so from then on every check reads it too.
    const engagement = status.state === 'awaiting_freelancer' ? null : await findEngagement(deps.api, f.email);
    // Only what the answers change from what this check started with is
    // written: a completion stored while the reads were out
    // (recordCompletion) is newer than they are, and stays.
    const learned: Partial<NonNullable<State['freelancer']>> = {};
    if (status.can_be_paid !== f.can_be_paid) learned.can_be_paid = status.can_be_paid;
    if (engagement && engagement.id !== f.engagement_id) learned.engagement_id = engagement.id;
    if (engagement && engagement.status !== f.engagement_status) learned.engagement_status = engagement.status;
    if (engagement && engagement.servicing_company_slug !== f.servicing_company_slug) learned.servicing_company_slug = engagement.servicing_company_slug;
    // What a simulation reopened (step 2b) is followed on the engagement's own
    // list until it closes: each check keeps what is still open, and nothing
    // once the list reads `complete`. A list Abillio could not work out
    // (`null`) proves nothing and changes nothing, and a walk with nothing
    // reopened is not followed at all: a first onboarding goes by
    // `can_be_paid`.
    if (engagement?.requirements && f.requirements && engagement.id === f.engagement_id) {
      const open = openRequirements(engagement.requirements);
      if (JSON.stringify(open) !== JSON.stringify(f.requirements)) learned.requirements = open;
    }
    if (Object.keys(learned).length) {
      deps.state.update(s => {
        // Only for the session this check read: a newer join replaced it.
        if (!s.freelancer || s.freelancer.session_id !== f.session_id) return;
        // Steps 3 and 4 belong to one engagement; another one starts them over.
        if (learned.engagement_id && s.freelancer.engagement_id !== learned.engagement_id) { s.invoice = null; s.invoice_request = null; s.payout = null; }
        const { requirements, ...rest } = learned;
        Object.assign(s.freelancer, rest);
        // The list only over the one this check compared: a simulation
        // pressed while the reads were out stored a newer one.
        if (requirements !== undefined && JSON.stringify(s.freelancer.requirements) === JSON.stringify(f.requirements)) {
          s.freelancer.requirements = requirements;
          if (!requirements) s.freelancer.reopened_after_session = null;
        }
      });
    }
    return { status, engagement };
  }

  // Until step 2 is done (the stored freelancer cannot be paid yet, or what a
  // simulation reopened is still open), every load makes that status check
  // too: the join page's poll stores the answer only while the join page is
  // open, and on a public URL with no webhook connected nothing else would.
  // Only once the key is checked, as the page counts it (boundAccount). A
  // failed read does not fail the page: it renders what is stored, and the
  // trace shows the refused call.
  app.get('/', async c => {
    const s = deps.state.load();
    const f = s.freelancer;
    if (f && !setupDone(f) && boundAccount(s)) {
      try {
        await checkStatus(f);
      } catch {
        // Nothing learned; the page below is what is stored.
      }
    }
    return render(c);
  });

  app.post('/steps/key', async c => {
    try {
      lastKey = await checkKey(deps.api);
      const { id, name, slug, is_sandbox } = lastKey.account;
      deps.state.update(s => { s.account = { id, name, slug, is_sandbox: is_sandbox === true, key_id: deps.keyId, env_account: deps.account }; });
      return render(c);
    } catch (err) {
      // A check that fails leaves nothing known about the account the key
      // reaches, so an earlier answer is forgotten with it.
      lastKey = null;
      deps.state.update(s => { s.account = null; });
      return render(c, err);
    }
  });

  // The join page reads the state the way the back office does (publicState):
  // its progress line counts the key check only for this process's key.
  app.get('/join', c => c.html(joinPage(publicState(deps.state.load()), deps.abillioOrigin())));

  app.post('/join', async c => {
    const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email ?? '')) return c.text('e-mail looks wrong', 422);
    const locale = form.locale === 'en' ? 'en' : 'lv';
    const state = deps.state.load();
    const join: JoinForm = { first_name: form.first_name ?? '', last_name: form.last_name ?? '', email: form.email, tax_country: form.tax_country || 'LV', locale };
    const returnUrl = returnUrlFor(deps.publicUrl, deps.port);
    try {
      // keyed() claims the key of this exact body (onboardingAction), and
      // `once` spends it on any answer: the link is single-use and may be
      // spent already, so each press mints a new one, and only a lost answer
      // leaves the key for the identical retry to replay. startOnboarding
      // derives the same action and sends that key.
      const session = await keyed(state, onboardingAction(onboardingBody(join, returnUrl)), () => startOnboarding(deps.api, state, join, returnUrl), { once: true });
      // The same freelancer (the same address) keeps their engagement, and with
      // it steps 3 and 4 and whatever a simulation reopened on it (step 2b),
      // which only Abillio closes. Another one's engagement is looked up by
      // /join/status, which starts those steps over once it finds a different
      // one. Whether the freelancer can be paid is the new session's to say.
      deps.state.update(s => {
        const previous = s.freelancer?.email.toLowerCase() === form.email.toLowerCase() ? s.freelancer : null;
        s.freelancer = { email: form.email, session_id: session.session_id, session_url: session.url, engagement_id: previous?.engagement_id ?? null, engagement_status: previous?.engagement_status ?? null, can_be_paid: false, servicing_company_slug: previous?.servicing_company_slug ?? null, requirements: previous?.requirements ?? null, reopened_after_session: previous?.reopened_after_session ?? null };
      });
      return c.json(session);
    } catch (err) {
      return c.text(joinErrorText(err), 502);
    }
  });

  app.get('/join/status', async c => {
    const f = deps.state.load().freelancer;
    if (!f) return c.json({ state: 'none', can_be_paid: false, requirements: [] });
    // Either Abillio read can fail (a 401, a network blip). The answer is then
    // a 502 with the error text, which the page's poll skips before asking
    // again on its next tick, instead of an unhandled 500.
    try {
      const { status, engagement } = await checkStatus(f);
      return c.json({ ...status, engagement_id: engagement?.id ?? f.engagement_id });
    } catch (err) {
      return c.text(joinErrorText(err), 502);
    }
  });

  // Step 2b. A requirement simulation is an event, like the payout's: its key
  // is spent on any settled answer (`once`), so the same button pressed again
  // after the freelancer has put it right plays again instead of replaying.
  // Abillio answers with the engagement as the company reads it, and what it
  // says is stored only onto the walk the press acted on, with the session
  // stored at that moment: whatever that link's completion says, however late
  // it comes in, predates the reopen (recordCompletion). A replayed answer
  // (after a lost one) can be older than the engagement; while something is
  // open every load reads the engagement again (checkStatus), so it does not
  // stay.
  app.post('/steps/onboard/simulate', async c => {
    const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
    const simulation = REQUIREMENT_SIMULATIONS.find(s => s.outcome === form.outcome);
    const state = deps.state.load();
    const engagementId = state.freelancer?.engagement_id;
    if (!simulation || !engagementId) return render(c, new Error('Pick one of the three outcomes once a freelancer has joined (step 2).'));
    try {
      const engagement = await keyed(state, simulateRequirementAction(engagementId, simulation), () => simulateRequirement(deps.api, state, engagementId, simulation), { once: true });
      deps.state.update(s => {
        if (s.freelancer?.engagement_id !== engagementId) return;
        s.freelancer.can_be_paid = engagement.can_be_paid;
        s.freelancer.engagement_status = engagement.status;
        // A list Abillio could not work out (`null`) proves nothing: the
        // stored one stays.
        if (engagement.requirements) s.freelancer.requirements = openRequirements(engagement.requirements);
        // The link stored now predates this reopen; kept while something is open.
        s.freelancer.reopened_after_session = s.freelancer.requirements ? s.freelancer.session_id : null;
      });
      return render(c);
    } catch (err) { return render(c, err); }
  });

  // Send a new link: the join page's mint for the address already stored,
  // with `purpose: "update"` (steps/02b-requirements.ts). Keyed and spent like
  // the first mint (`once`): Abillio hands back the same link while it is
  // open, and a new one once it is spent. The new session replaces the stored
  // one on the same freelancer, so the status check, the poll and the
  // completion event follow it; the engagement, `can_be_paid` and what is open
  // stay until Abillio says otherwise. The answer, with the link, goes only to
  // the browser that pressed, as /join's does, and a refusal comes back as
  // text for the note under the button. A page out of date gets 409, and
  // popup.js loads it again: nobody is stored any more, or Abillio lists
  // nothing left to complete (`requirements_complete`), which makes the list
  // the page shows stale, so it goes.
  app.post('/steps/onboard/update-link', async c => {
    const state = deps.state.load();
    const f = state.freelancer;
    if (!f) return c.text('Nobody has joined yet: there is no address to send a link to.', 409);
    const body = updateLinkBody(f.email, returnUrlFor(deps.publicUrl, deps.port));
    try {
      const session = await keyed(state, onboardingAction(body), () => startUpdate(deps.api, state, body), { once: true });
      deps.state.update(s => {
        if (!s.freelancer || s.freelancer.email.toLowerCase() !== f.email.toLowerCase()) return;
        s.freelancer.session_id = session.session_id;
        s.freelancer.session_url = session.url;
      });
      return c.json(session);
    } catch (err) {
      if (err instanceof AbillioError && err.code === 'requirements_complete') {
        deps.state.update(s => {
          if (!s.freelancer || s.freelancer.email.toLowerCase() !== f.email.toLowerCase()) return;
          s.freelancer.requirements = null;
          s.freelancer.reopened_after_session = null;
        });
        return c.text(joinErrorText(err), 409);
      }
      return c.text(joinErrorText(err), 502);
    }
  });

  app.post('/steps/issue', async c => {
    const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
    const state = deps.state.load();
    const engagementId = state.freelancer?.engagement_id;
    if (!engagementId || !state.account) return render(c, new Error('Join a freelancer first (step 2) and check the key (step 1).'));
    // The walk this press acts on. A Start over, or another freelancer found
    // by /join/status, can move it on while a call is out; from then on the
    // press writes nothing and sends nothing more, since what it would store
    // belongs to a walk that is no longer the page's.
    const onThisWalk = (s: State) => s.freelancer?.engagement_id === engagementId;
    const movedOn = () => render(c, new Error('The walk moved on while this press was out (a Start over, or another freelancer joined), so the press stopped there and stored nothing on the new walk.'));
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
        let here = false;
        const request = deps.state.update(s => {
          if (!onThisWalk(s)) return;
          here = true;
          s.invoice_request = s.invoice_request?.engagement_id === engagementId ? s.invoice_request : fresh;
        }).invoice_request ?? fresh;
        if (!here) return movedOn();
        // On a certain refusal nothing was drafted, so the request goes with the
        // key and the form is free again (only this engagement's request).
        const drafted = await keyed(state, `draft:${request.engagement_id}`, () => draftInvoice(deps.api, state, request, self.id), { onRefused: s => { if (s.invoice_request?.engagement_id === request.engagement_id) s.invoice_request = null; } });
        invoice = { id: drafted.id, number: drafted.number, status: drafted.status, public_url: drafted.public_url };
        const stored = invoice;
        // Another press may have stored this draft, and issued it, meanwhile.
        let still = false;
        deps.state.update(s => {
          if (!onThisWalk(s)) return;
          still = true;
          s.invoice ??= stored;
        });
        if (!still) return movedOn();
      }
      const id = invoice.id;
      const issued = await keyed(state, `issue:${id}`, () => issueInvoice(deps.api, state, engagementId, id));
      // The answer replaces only the draft it issued, on the walk it was
      // issued for. Past the draft a press just shows the replay: its answer is
      // the first issue's, which can be older than what a later step stored.
      let issuedHere = false;
      deps.state.update(s => {
        if (!onThisWalk(s)) return;
        issuedHere = true;
        if (s.invoice?.id === id && s.invoice.status === 'draft') s.invoice = { id, number: issued.number, status: issued.status, public_url: issued.public_url };
      });
      return issuedHere ? render(c) : movedOn();
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
      // `once` spent the key before this read: if the read fails, the stored
      // payout stays stale until a poll tick (no PUBLIC_URL) or the next Pay
      // or Simulate reads it again.
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
    const traceLine = (status: number, error: string) => deps.trace.push({ at: new Date(deps.now()).toISOString(), method: 'WEBHOOK', path: '/webhooks/abillio', requestBody: null, status, responseBody: null, idempotencyKey: null, replayed: false, error });
    if (!verdict.ok) {
      traceLine(verdict.status, `refused: ${verdict.reason}`);
      return c.text(verdict.reason, verdict.status);
    }
    // Signed with our secret, but neither an event nor a test delivery: the
    // guide's rule for what a receiver does not route on is to answer 2xx and
    // drop it (§10). A 4xx would count as a failed delivery, and ten in a row
    // disable the channel.
    const delivery = parseDelivery(raw);
    if (!delivery) {
      traceLine(200, 'dropped: signed correctly, but neither an event nor a test delivery');
      return c.text('ok', 200);
    }
    const key = dedupeKey(delivery.event_type, raw);
    // The test delivery has a constant body and no retries: every press is a
    // new one on purpose, so it is never deduped. Real events carry their
    // emission time inside the body, so distinct emissions never collide.
    // Decided inside the write, against what is stored by then: two copies
    // that arrive together are stored once, and the page is told once. A
    // completion is recorded with its event (recordCompletion).
    const event: StoredEvent = { received_at: new Date(deps.now()).toISOString(), event_type: delivery.event_type, data: delivery.data, via: 'webhook', dedupe_key: key };
    let stored = false;
    const after = deps.state.update(s => {
      if (delivery.event_type !== 'channel.test' && s.events.some(e => e.dedupe_key === key)) return;
      appendEvent(s, event);
      recordCompletion(s, event);
      stored = true;
    });
    if (stored && announced(after, event)) notifyStored();
    return c.text('ok', 200);
  });

  // The polling fallback runs inside the app so it shares `notifyStored`. It
  // is off whenever webhooks are on, and in the tests unless one drives it;
  // `unref()` keeps it from holding the process open. One tick at a time:
  // behind a slow Abillio a tick would otherwise start while the last one is
  // still out, and two would write what they found over each other.
  if (deps.pollIntervalMs !== null) {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const found = await pollForEvents(deps.api, deps.state.load(), deps.now);
        // Written onto the state as it is by now, which the routes may have
        // moved on meanwhile (recordPoll says what it may write). A row's new
        // status is this walk's; an event is announced like a delivery.
        if (found.events.length || found.changes.length) {
          let written: PollResult = { events: [], changes: [] };
          const after = deps.state.update(s => { written = recordPoll(s, found); });
          if (written.changes.length || written.events.some(e => announced(after, e))) notifyStored();
        }
      } catch (err) {
        console.warn('poll failed:', (err as Error).message);
      } finally {
        running = false;
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

  app.get('/back', c => c.html(page('Back', '<main id="main" class="one-col"><section class="panel"><h1>Thanks — you can close this window.</h1><p class="muted">Abillio sends the freelancer here when the popup has no opener to post to.</p></section></main>')));

  app.get('/api/state', c => c.json(publicState(deps.state.load())));
  app.get('/api/trace', c => c.json(deps.trace.list()));

  // `refresh` fires only when something was STORED (a webhook, a poll): a
  // button's own request renders its page itself, and a refresh on every
  // traced call would reload the page mid-request and throw the answer away.
  app.get('/events', c =>
    streamSSE(c, async stream => {
      const send = (update: UpdateSummary | null) => stream.writeSSE({ event: 'refresh', data: JSON.stringify(update) });
      refreshListeners.add(send);
      stream.onAbort(() => { refreshListeners.delete(send); });
      // Compare this snapshot with the rendered page on every connection.
      // This catches events missed between rendering and opening the stream,
      // including when the capped log's total count no longer changes.
      await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(latestUpdate(deps.state.load())) });
      while (!stream.aborted) await stream.sleep(15_000);
    }),
  );

  // Start over: Abillio puts the sandbox's demo data back as it was seeded,
  // and the sample forgets this walk. A new key each press: a reset is meant
  // to run again. A refused reset forgets nothing, since the sandbox still
  // holds the walk.
  app.post('/reset', async c => {
    try {
      await deps.api('POST', '/accounts/sandbox/reset', undefined, { idempotencyKey: randomUUID() });
    } catch (err) {
      return render(c, err);
    }
    // The account belongs to the key, not to the walk, so it stays, and the
    // next walk needs no new key check. The webhook channel and subscription
    // are the account's, not demo data, so they outlive the reset and are
    // kept, with a request still pending from a connect that stopped mid-way
    // and the keys it went out under: re-sent under a new key, that request
    // would create a second channel or subscription. Everything else starts
    // over.
    deps.state.update(s => {
      const idempotency: Record<string, string> = {};
      for (const action of Object.values(WEBHOOK_ACTIONS)) if (s.idempotency[action]) idempotency[action] = s.idempotency[action];
      const keep = { account: s.account, webhook: s.webhook, webhook_request: s.webhook_request, idempotency };
      Object.assign(s, defaultState(), keep);
    });
    return c.redirect('/', 302);
  });

  return app;
}

function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
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
    allowProduction: env.allowProduction,
    keyId: env.keyId,
    account: env.account,
  });
  serve({ fetch: app.fetch, port: env.port }, info => {
    console.log(`Abillio gateway example on http://localhost:${info.port}` + (env.publicUrl ? ` (public: ${env.publicUrl})` : ' (no PUBLIC_URL: webhooks off, polling on)'));
  });
}

if (startedAsScript(import.meta.url)) main();
