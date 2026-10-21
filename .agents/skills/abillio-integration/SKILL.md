---
name: abillio-integration
description: Build, extend, or debug a company's Abillio Company API integration using the gateway example. Use for freelancer onboarding, invoices, wallet payments, payouts, webhooks, or porting the example to another stack. This skill builds integration software; it is not for operating a user's Abillio account through MCP.
---

# Build an Abillio integration

Turn the user's business flow into working integration code in their existing
stack. Use this repository as a worked example, and the current Company API
contract for request fields and behavior.

## Establish the flow and the contract

Infer the target project, language, framework and deployment environment from
the request and repository. Clarify only missing decisions that change the
implementation: who pays the invoice (the company or its client), whether the
company takes commission, and which parts of the flow are required.

Explain the intended flow briefly in the user's language, then implement the
requested scope. Missing sandbox credentials need not block local code and
mocked tests; identify them as a prerequisite for the live sandbox check.

Use these sources:

- [Company API guide](https://backend.abillio.dev/company-api/): workflows,
  permissions, errors, completion rules and production requirements.
- [OpenAPI schema](https://backend.abillio.dev/company-api/openapi.json):
  exact methods, paths, request and response fields.
- [Interactive reference](https://backend.abillio.dev/company-api/docs).
- [Hosted demo](https://demo.abillio.dev/): the five-step experience.
- [Example source](https://github.com/abill-io/abillio-gateway-example):
  implementation patterns and test vectors.

Use the guide and schema for the **target API deployment**. The links above
are the staging reference; production uses the host supplied with the
company's key. An unreleased backend branch, the hosted demo and a local
checkout can differ. Record which contract/version you used. Where they
disagree, resolve the affected behavior before relying on it; if the target
contract cannot be read, state the assumption and keep that path unverified.
Do not turn comments in this sample into guarantees about a newer deployment.

## Find the relevant working example

Paths below are relative to the gateway example's repository root. When this
skill is copied to another project, locate a checkout of the example or use
the linked repository; the target project is not necessarily that checkout.
Read the files for the current feature, not the whole sample.

| Task | Example and useful tests |
|---|---|
| Settings, signing, API errors | `.env.example`, `lib/env.ts`, `lib/abillio.ts`, `test/abillio.test.ts`, `test/vectors.json` |
| Account and permissions | `steps/01-key.ts`, `test/step-key.test.ts` |
| Signup link and session | `steps/02-onboard.ts`, `public/popup.js`, `test/step-onboard.test.ts`, `test/popup.test.ts` |
| Update link after onboarding | `steps/02b-requirements.ts`, `public/popup.js`, `test/step-requirements.test.ts`, `test/popup.test.ts` |
| Draft and issue invoice | `steps/03-issue.ts`, `test/step-issue.test.ts` |
| Pay and follow payout | `steps/04-pay.ts`, `test/step-pay.test.ts` |
| Webhook signature and delivery | `lib/webhooks.ts`, `steps/05-events.ts`, `test/webhooks.test.ts`, `test/step-events.test.ts` |
| Durable operation state and retries | `lib/store.ts`, `server.ts` (`keyed` and action routes), `test/server.test.ts` |
| User experience and live updates | `views/`, `public/app.js`, `lib/updates.ts`, `test/app.test.ts` |
| Sandbox walkthrough | `scripts/smoke.ts`, README “The smoke test” |

For protocol details, retry decisions and the differences between this demo
and a real application, read [Integration patterns](references/integration-patterns.md).
For validation and handoff, read [Verification](references/verification.md).

## Build the smallest complete path

Adapt the sample to the user's stack and storage. Do not replace their app with
Hono or require Node just to use the API.

1. **Connect the company.** Keep the signing key on the server. Read the
   account and permission preview, verify the selected account, and identify
   the exact actions needed for this flow.
2. **Connect the freelancer.** Associate the local user with an onboarding
   session and engagement. Open Abillio's hosted flow and read back its status
   from the server. Keep consent, required tasks and payment readiness distinct.
3. **Create the invoice.** Select the correct buyer, persist the draft operation,
   then issue separately. Surface every issue blocker with a useful next action.
4. **Pay and follow the payout.** Match the invoice to the company, currency and
   relevant wallet balance. Persist the payment attempt and follow the payout
   separately from the invoice's paid status.
5. **Receive updates.** Connect webhooks before the first invitation when a
   receiver is available. Verify, durably deduplicate, correlate and read back
   current resources. Use polling when appropriate for local development or
   recovery, without manufacturing authoritative webhook history.

For a narrower request, implement only the relevant steps and dependencies.
For third-party buyers, commission, update sessions, bulk operations or manual
payouts, read that feature's current guide section and schema first: the
sample's happy path does not implement all of them.

## Keep these decisions explicit

- Sign and send the same serialized bytes. Never put the private key in
  frontend code or expose the onboarding URL in public traces.
- Persist one operation identity, idempotency key and request before sending
  a mutation. An uncertain outcome requires read-back or a safe replay, not
  an automatically generated new key.
- An opened link is not consent. Let Abillio collect the freelancer's consent,
  terms acceptance and personal checks. Do not infer acceptance of a changed
  commission from link creation or page opening.
- `can_be_paid`, a completed requirements list, permission to issue an invoice
  and a completed payout answer different questions.
- The API's account permissions do not replace authorization in the company's
  own application. Bind actions and returned IDs to the authenticated user
  and tenant.
- The public demo has shared state and diagnostic screens. A real application
  needs private, scoped data and durable per-operation storage.
- Build and validate locally first. Keep the example's production guard;
  enabling production writes, publishing a deployment or running a live
  mutation must be within the user's requested scope.

## Deliver a reviewable integration

Include the code, configuration names with placeholders, storage changes,
relevant tests, and a short setup/run guide. Keep normal UI language focused
on what the company or freelancer should do; put IDs, error codes and raw
payloads in authorized technical details.

Report what actually ran: local checks, mocked protocol tests and live sandbox
checks separately. Name any unavailable credentials or deployment-dependent
behavior. Do not claim production readiness from a passing demo walkthrough.
