// The story without a browser: proves the key, mints a link, and — given an
// engagement that is already payable — issues, pays and settles. Exits 1 on
// the first error so it can gate a release. The state lives in memory only:
// every run mints its own keys, so it is a new invoice and a new payment each
// time, and data/state.json is never touched.
import { AbillioError, createApi } from '../lib/abillio.ts';
import { loadEnv } from '../lib/env.ts';
import { defaultState } from '../lib/store.ts';
import { checkKey } from '../steps/01-key.ts';
import { returnUrlFor, startOnboarding } from '../steps/02-onboard.ts';
import { draftInvoice, findSelfClient, invoiceRequest, issueInvoice } from '../steps/03-issue.ts';
import { DEFAULT_COMPANY, findPayout, fundWallet, payInvoice, simulatePayout } from '../steps/04-pay.ts';

const state = defaultState();

try {
  const env = loadEnv();
  const api = createApi(env);
  const key = await checkKey(api);
  console.log(`key ok: ${key.account.name} (${key.account.slug}), sandbox=${key.account.is_sandbox}`);
  if (!key.account.is_sandbox) throw new Error('refusing to run the smoke against a non-sandbox account');
  const email = `smoke+${Date.now().toString(36)}@example.com`;
  const session = await startOnboarding(api, state, { first_name: 'Smoke', last_name: 'Test', email, tax_country: 'LV', locale: 'en' }, returnUrlFor(env.publicUrl, env.port));
  console.log(`onboarding link minted for ${email}: ${session.url}`);
  const engagementId = process.env.SMOKE_ENGAGEMENT_ID;
  if (!engagementId) {
    console.log('set SMOKE_ENGAGEMENT_ID to a payable engagement to also issue, pay and settle');
    process.exit(0);
  }
  const self = await findSelfClient(api, key.account.id);
  const draft = await draftInvoice(api, state, invoiceRequest(engagementId, { description: 'Smoke test', unit_price: '10.00', currency_code: 'EUR' }, new Date()), self.id);
  const issued = await issueInvoice(api, state, engagementId, draft.id);
  console.log(`issued ${issued.number} (${issued.status}), ${issued.total} ${issued.currency}`);
  // The deposit lands on one company's balance row, and the payment draws on
  // the row of the company that issued the invoice: SMOKE_COMPANY when the
  // engagement's freelancer is served by another one than the default.
  const company = process.env.SMOKE_COMPANY ?? DEFAULT_COMPANY;
  await fundWallet(api, '50.00', 'EUR', company);
  console.log(`wallet funded: 50.00 EUR on ${company}`);
  const payment = await payInvoice(api, state, issued.id);
  console.log(`paid ${issued.number}: operation ${payment.operation_id}`);
  const payout = await findPayout(api, engagementId, issued.id);
  if (!payout) throw new Error('no payout was created for the paid invoice');
  console.log(`payout ${payout.id} created (${payout.status})`);
  const settled = await simulatePayout(api, state, engagementId, payout.id, 'paid');
  console.log(`payout ${settled.id} ${settled.status}`);
} catch (err) {
  if (err instanceof AbillioError) {
    console.error(`${err.status} ${err.code}: ${err.message}`);
    for (const blocker of err.blockers) console.error(`  blocker ${blocker.code}: ${blocker.message}`);
    if (err.hint) console.error(err.hint);
    if (err.requestId) console.error(`request_id ${err.requestId}`);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
}
