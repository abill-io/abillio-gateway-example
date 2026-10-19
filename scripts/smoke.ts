// The story without a browser: proves the key, mints a link, and — given an
// engagement that is already payable — issues, pays and settles. Exits 1 on
// the first error so it can gate a release. The state lives in memory only:
// every run mints its own keys, so it is a new invoice and a new payment each
// time, and data/state.json is never touched.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AbillioError, createApi, type Api } from '../lib/abillio.ts';
import { loadEnv } from '../lib/env.ts';
import { defaultState } from '../lib/store.ts';
import { checkKey } from '../steps/01-key.ts';
import { returnUrlFor, startOnboarding } from '../steps/02-onboard.ts';
import { draftInvoice, findSelfClient, invoiceRequest, issueInvoice } from '../steps/03-issue.ts';
import { DEFAULT_COMPANY, findPayout, fundWallet, payInvoice, readPayout, simulatePayout } from '../steps/04-pay.ts';

export type SmokeOptions = { returnUrl: string; engagementId: string | null; company: string; log: (line: string) => void };

// An engagement of another account, or one that does not exist, is refused
// with a 404 or a 403 on the first call that names it, the draft. A 403 can
// also be the key lacking the action, so its own hint stays beside this one.
export const WRONG_ENGAGEMENT = 'check SMOKE_ENGAGEMENT_ID: the engagement must belong to this account';

export async function runSmoke(api: Api, opts: SmokeOptions): Promise<void> {
  const state = defaultState();
  const key = await checkKey(api);
  opts.log(`key ok: ${key.account.name} (${key.account.slug}), sandbox=${key.account.is_sandbox}`);
  if (!key.account.is_sandbox) throw new Error('refusing to run the smoke against a non-sandbox account');
  const email = `smoke+${Date.now().toString(36)}@example.com`;
  const session = await startOnboarding(api, state, { first_name: 'Smoke', last_name: 'Test', email, tax_country: 'LV', locale: 'en' }, opts.returnUrl);
  opts.log(`onboarding link minted for ${email}: ${session.url}`);
  const engagementId = opts.engagementId;
  if (!engagementId) {
    opts.log('set SMOKE_ENGAGEMENT_ID to a payable engagement to also issue, pay and settle');
    return;
  }
  const self = await findSelfClient(api, key.account.id);
  const request = invoiceRequest(engagementId, { description: 'Smoke test', unit_price: '10.00', currency_code: 'EUR' }, new Date());
  const draft = await draftInvoice(api, state, request, self.id).catch((err: unknown) => {
    if (err instanceof AbillioError && (err.status === 403 || err.status === 404)) err.hint = [err.hint, WRONG_ENGAGEMENT].filter(Boolean).join('\n');
    throw err;
  });
  const issued = await issueInvoice(api, state, engagementId, draft.id);
  opts.log(`issued ${issued.number} (${issued.status}), ${issued.total} ${issued.currency}`);
  // The deposit lands on one company's balance row, and the payment draws on
  // the row of the company that issued the invoice: SMOKE_COMPANY when the
  // engagement's freelancer is served by another one than the default.
  await fundWallet(api, '50.00', 'EUR', opts.company);
  opts.log(`wallet funded: 50.00 EUR on ${opts.company}`);
  const payment = await payInvoice(api, state, issued.id);
  opts.log(`paid ${issued.number}: operation ${payment.operation_id}`);
  const payout = await findPayout(api, engagementId, issued.id);
  if (!payout) throw new Error('no payout was created for the paid invoice');
  opts.log(`payout ${payout.id} created (${payout.status})`);
  await simulatePayout(api, state, engagementId, payout.id, 'paid');
  // The gate is the payout as Abillio holds it afterwards, not the simulator's answer.
  const settled = await readPayout(api, engagementId, payout.id);
  if (settled.status !== 'paid') throw new Error(`payout ${settled.id} reads ${settled.status}, not paid`);
  opts.log(`payout ${settled.id} ${settled.status}`);
}

// What goes to stderr: Abillio's envelope line by line, or the error and its
// causes. fetch() fails with "fetch failed" and keeps the reason (DNS, a
// refused connection, TLS) in `cause`.
export function describeError(err: unknown): string[] {
  if (err instanceof AbillioError) {
    return [
      `${err.status} ${err.code}: ${err.message}`,
      ...err.blockers.map(blocker => `  blocker ${blocker.code}: ${blocker.message}`),
      ...(err.hint ? err.hint.split('\n') : []),
      ...(err.requestId ? [`request_id ${err.requestId}`] : []),
    ];
  }
  const lines = [err instanceof Error ? err.message : String(err)];
  for (let cause = err instanceof Error ? err.cause : undefined; cause !== undefined; cause = cause instanceof Error ? cause.cause : undefined) {
    lines.push(`  cause: ${causeText(cause)}`);
  }
  return lines;
}

// A cause in its own words. A refused or unreachable host reaches fetch() as
// an AggregateError with no message, one error per address it tried, so its
// code and those errors are what say why.
function causeText(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const code = (cause as { code?: unknown }).code;
  const text = cause.message || (typeof code === 'string' ? code : '');
  const tried = cause instanceof AggregateError ? cause.errors.map(e => (e instanceof Error ? e.message : String(e))).join('; ') : '';
  if (text && tried) return `${text} (${tried})`;
  return text || tried || cause.name;
}

async function main(): Promise<void> {
  try {
    const env = loadEnv();
    await runSmoke(createApi(env), {
      returnUrl: returnUrlFor(env.publicUrl, env.port),
      engagementId: process.env.SMOKE_ENGAGEMENT_ID || null,
      company: process.env.SMOKE_COMPANY || DEFAULT_COMPANY,
      log: line => console.log(line),
    });
  } catch (err) {
    for (const line of describeError(err)) console.error(line);
    process.exitCode = 1;
  }
}

// Whether node was started with this file. Real paths on both sides: started
// through a symlink, node resolves the module to its real path but leaves
// argv as typed, and a string comparison would skip main() and exit 0.
function startedAsScript(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedAsScript()) {
  await main();
} else if (process.env.npm_lifecycle_event === 'smoke') {
  // `npm run smoke` that never reached main() must not pass a release gate.
  console.error('scripts/smoke.ts did not recognise itself as the script node started, so nothing ran.');
  process.exitCode = 1;
}
