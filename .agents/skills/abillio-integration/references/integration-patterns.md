# Integration patterns

Use the target deployment's guide and schema to confirm the details below.
These notes explain decisions that are easy to get wrong when adapting the
example. Repository paths refer to the gateway example.

## 1. Server client and request signing

Start with `lib/abillio.ts` and `test/vectors.json`.

The example uses an Ed25519 **32-byte seed**, represented by 64 hexadecimal
characters. It is not an API bearer token or an already encoded PEM key.
Use the cryptography library appropriate to the target language.

Sign the UTF-8 bytes of this concatenation, without added separators:

```text
timestamp + account + method + full_path_with_query + serialized_body
```

- `timestamp`: Unix seconds, as sent in `X-API-Timestamp`.
- `account`: exactly `X-Account`, or the empty string when omitted.
- `method`: the request's uppercase HTTP method.
- `full_path_with_query`: includes `/company-api/v1`, the exact trailing slash
  and the encoded query string; it excludes the origin.
- `serialized_body`: exactly what is sent, or the empty string for no body.

Send `X-API-Key`, `X-API-Timestamp` and the hexadecimal Ed25519 signature in
`X-API-Signature`; send `X-Account` when selecting an account. Serialize JSON
once. A library that serializes the body again after signing can break the
signature. Give a non-browser client an identifiable User-Agent.

Verify a port against the checked-in vectors, including a request with a
query and a body. The vector seed is a public test fixture, never a usable
integration credential. Keep real keys in server-side secret configuration.

## 2. State and retry decisions

Use a durable operation record scoped to tenant, local business operation and
action. Store its method, path, exact body, idempotency key, lifecycle state
and returned resource IDs. Claim it atomically before the request so parallel
workers, double clicks and restarts cannot create separate attempts.

Separate draft creation, issuing and payment into distinct operations. In a
real application `draft:<engagement>` is too broad: one freelancer may have
many legitimate invoices. Include the local invoice or job identity.

| Outcome | Next action |
|---|---|
| Success | Store the result. Reusing that operation returns its result or safely replays the same request. |
| Timeout, network error, 5xx or an unrecognized proxy response | Preserve the key and original request. Read back known resources; retry only according to the API's replay rules. |
| `idempotency_in_progress` | Bounded backoff, respecting `Retry-After` when present. Keep the same request. If unresolved, reconcile. |
| `idempotency_key_reused`, `idempotency_replay_forbidden`, `idempotency_reconciliation_required` | Stop automatic mutation retries. Read back the original operation; use a new key only after establishing that the action did not happen. |
| A documented refusal known to have made no change | Fix the cause, then follow the target API's rules for a new operation attempt. |

Do not classify every 4xx as proof that nothing happened. `AbillioError.verified`
documents a sample limitation: route-level authorization checks can refuse a
replay after the original action succeeded. A 401/403/404 following an unknown
outcome requires reconciliation, not an automatic key reset.

Persist the full request, including generated dates, client ID, destination
and webhook secret. Recomputing any of these on retry may change the body.
“Start over” clears the demo's local walk; it is not production reconciliation
and does not undo previously created freelancer records or payments.

## 3. Freelancer onboarding and later updates

Read the guide's [gateway flow](https://backend.abillio.dev/company-api/#gateway)
and [engagements](https://backend.abillio.dev/company-api/#engagements).
The sample code is in `steps/02-onboard.ts` and `public/popup.js`; the update
link after a requirement reopens is `steps/02b-requirements.ts` (README step 2b).

- Create the session on the server with the user's permitted prefill and an
  application-controlled `return_url`. Keep the session tied to the local user.
- The API returns the hosted URL. Do not build one from a guessed token or
  assume session status includes an engagement ID.
- If looking up the engagement by email, verify an exact match in the response
  and persist its ID. Implement pagination where needed.
- Opening the popup is not consent. Abillio handles consent, terms,
  commission acceptance and identity/payment-method checks.
- The popup message is a signal to read server-side status. Check its origin,
  `source` marker, session ID and the expected popup window when available.
  A message or return-page visit must not itself authorize issuing or payment.
- Handle popup blocking, closing, expired links and a failed status request
  with an explicit next action and bounded polling.

For an update session, check its `purpose` and the documented completion state.
Do not reuse the demo's first-onboarding shortcut that stops on `can_be_paid`:
an update can still have documents or other tasks outstanding after payment
readiness is true. Read the engagement's `requirements` and its blocking
capabilities; `null` is not proof of completion.

Wait for the update session's `state: "complete"` or its completion event,
then read back current state. Only an open, unexpired update link can send a
sign-in code or reopen; a completed link is spent. Creating another update
session may return the same still-usable link, so a new request does not
necessarily mean a new session ID. Confirm the reuse window in the target
contract.

The session's progress rows and the engagement's requirements object are
different API shapes. Use the schema for each. Keep `can_be_paid`,
requirements completion and the invoice issue response separate.

Commission changes and terms acceptance are governed by the current backend
contract. Consent on an onboarding link accepts the rate its consent screen
showed, even if activation happens later. Opening a later link must not replace
that agreed rate. A subsequent proposal remains `commission.rate` with
`pending: true`; invoices use `accepted_rate` until the freelancer accepts
the change. Do not accept a proposal on the freelancer's behalf.

An account's existing plan or an opened consent page does not prove that its
current Service Terms were accepted. Keep the hosted flow responsible for
showing the applicable terms and recording acceptance; do not infer that from
a prefilled tax country or from the company integration's own checkbox.

## 4. Invoices, payments and payouts

The sample bills the company itself. `steps/03-issue.ts` finds its self-client
by `company_account_id`, not its display name. A real client list must be
paginated; the sample's first 100 rows are a convenience.

| Purpose | Example path, relative to `/company-api/v1` |
|---|---|
| Create a draft in a freelancer's name | `POST /engagements/{engagement_id}/invoices/` |
| Issue the existing draft | `POST /engagements/{engagement_id}/invoices/{invoice_id}/issue` |
| Read an invoice | `GET /accounts/invoices/{invoice_id}/` |
| Pay an invoice billed to this company | `POST /accounts/wallet/pay-invoice/` |
| Find the invoice's payout | `GET /engagements/{engagement_id}/payouts/?invoice_uuid={invoice_id}` |
| Read that payout | `GET /engagements/{engagement_id}/payouts/{payout_id}` |

Confirm request fields against the schema. Use decimal strings for money and
quantities, an explicit currency, and supported unit codes. Use the returned
invoice totals; do not reproduce tax or fee calculations from the sandbox
example. Keep balances separate by currency and serving company.

Store the draft ID before issuing, so retrying issue cannot create another
draft. Present all `error.blockers` when issuing is refused. Payment readiness
alone does not prove permission to issue.

A company's wallet pays invoices billed to that company. A third-party buyer
requires the [intermediary flow](https://backend.abillio.dev/company-api/#intermediary).
Do not pay through the company's wallet merely because it created the invoice.

Paying an invoice and sending the freelancer's payout are separate actions.
Automatic payout may be blocked or absent. Match a returned payout to the
invoice, show waiting/failed/returned states, and do not create a manual payout
as a fallback without checking the documented flow and existing transfers.
Read the [payout guide](https://backend.abillio.dev/company-api/#paying) first.

## 5. Webhooks and read-back

Read `lib/webhooks.ts`, `steps/05-events.ts` and the receiver in `server.ts`.

1. Generate and securely store the signing secret before creating the channel.
   Persist the exact channel request and reuse it after an uncertain outcome.
   A channel's name is unique per account and kind, and the channel outlives
   a sandbox reset: when the create answers 409 for the name, adopt the listed
   channel (point it at the receiver with a new secret) and keep a subscription
   that already delivers to it instead of adding a second one.
2. Verify the unmodified body bytes with HMAC-SHA256 over
   `X-Timestamp + "." + raw_body`; compare with `v1` from `X-Signature` in
   constant time. Validate the timestamp against the documented window
   (300 seconds in the example). Parse JSON only after verification.
3. Handle the real event envelope (`event`, `data`, account metadata)
   separately from a channel test (`event_type: "channel.test"`).
4. Durably store/deduplicate before acknowledging receipt. The current sender
   retries the same body with a new signature timestamp; the example's key
   is event type plus SHA-256 of the raw body, not signature or timestamp.
5. Correlate the receiving account and resource IDs with local tenant records.
   A valid delivery can concern another engagement in the same account.
6. Treat events as prompts to read current resource state. Duplicate, delayed
   or reordered delivery must not regress invoice or payout status.

Subscribe only to the events the feature needs. Connect the receiver before
the first invitation when possible. If polling is used, distinguish observed
changes from delivered events and bound retry intervals.

## 6. Replace demo shortcuts deliberately

| This sample | A real company application |
|---|---|
| One shared walk in `data/state.json` | Durable database records per tenant, freelancer and business operation; transaction/uniqueness rules for concurrent writers |
| Public `/`, `/api/state` and `/api/trace` | Authenticated authorization boundaries; private diagnostic access with PII and credential redaction |
| In-memory request trace and bounded event list | Durable operation/audit records and webhook receipt storage appropriate to recovery needs |
| One invoice per engagement in the walk | One operation identity per intended invoice, allowing repeated work without duplicate retries |
| Sandbox deposit, payout and requirement simulators | Real funding instructions, actual payout status and requirements that change on their own clock; no simulator calls outside sandbox |
| Fixed sample company and EUR examples | Selected account, actual buyer, currency and serving company from the API |

The example intentionally displays some entered names, email addresses and
free text. Its trace redaction is not a privacy boundary for a multi-user
application. Protect private keys, webhook secrets, full session URLs and
personal data in logs and UI as well as in database access.
