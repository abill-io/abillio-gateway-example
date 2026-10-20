# Verify and hand off an integration

Select the checks relevant to the changed feature. Validate behavior rather
than testing that implementation text matches the example.

## Local checks

For changes to this repository:

```bash
npm test
npm run typecheck
```

These do not need Abillio credentials. Use the target application's existing
test tools for an integration in another stack. Port the relevant vectors
and fixtures, not the sample's entire test runner.

## Failure cases worth exercising

| Area | Observable result |
|---|---|
| Request signing | Checked-in Ed25519 vectors match; a changed query or body does not reuse an old signature. |
| Account scope | Another user's or tenant's session, engagement, invoice or payout cannot be accessed or acted on through the local application. |
| Onboarding | An opened/closed popup alone does not mark consent or completion. A wrong-origin or wrong-session message is ignored; the server reads actual status. |
| Update sessions | `can_be_paid: true` with tasks remaining does not become “All updates complete.” |
| Update link lifecycle | An expired or completed link sends no sign-in code. Reusing a still-open session does not create a second local freelancer record. |
| Draft and issue | Restart after draft creation resumes issuing that draft. A blocked issue shows the reasons and creates no second invoice. |
| Concurrent actions | Two submissions of one logical operation claim one durable identity and request; two distinct jobs can each create an invoice. |
| Uncertain outcome | Simulate “server accepted, response lost.” Retry preserves the original key and body; read-back/replay finds the original result. |
| Permanent idempotency conflict | The application stops automatic mutations and offers reconciliation; it does not mint a replacement key to bypass the error. |
| Webhooks | Reject tampered bodies and stale timestamps. A retry with a fresh timestamp is processed once. Valid unrelated events cannot change this user's state. |
| Event ordering | A late pending/processing event cannot overwrite a newer state; current state comes from a read-back. |
| Payout | “Invoice paid, no payout yet” stays distinct from “Payout completed”; rejected and returned outcomes remain visible. |
| Privacy and UI | No private key, webhook secret or bearer session URL in public diagnostics. Failed requests restore usable controls and explain the next action. |

For commission or terms work, add scenarios from the target contract:
consent to 10%, then a 15% proposal and a later link opened without consent
(the accepted rate stays 10%), and an existing account with outstanding terms
(having a plan alone is not acceptance). Do not infer the correct result from
the sample's first-time happy path.

## Live sandbox verification

First read `/me/session/` and verify the selected account is a sandbox.
Use local secret configuration and made-up test details. The hosted demo is
shared by visitors; do not use it as a private fixture.

Run only the sandbox mutations needed for the user's requested verification.
`npm run smoke` creates a new invitation. With `SMOKE_ENGAGEMENT_ID` it also
creates an invoice, funds a sandbox wallet, pays and simulates a payout.
It is not a read-only health check, and every run creates a new walk.
See the README for its settings and `SMOKE_COMPANY`.

Complete the hosted freelancer flow through its normal UI; do not fabricate
consent or acceptance state to make tests pass. If a credential, account,
human interaction or public webhook URL is unavailable, report the exact
unverified step and retain the completed local work.

## Handoff

State:

- the implemented business flow and which API environment/contract it targets;
- configuration names, required permissions and how to start it;
- what is persisted and how retries resume;
- local test results and live sandbox results separately;
- any remaining limitation, such as an unsupported advanced flow or an
  unreleased backend behavior awaiting verification.

For a production deployment, additionally review the guide's
[go-live checks](https://backend.abillio.dev/company-api/#golive), authentication,
storage/concurrency, secret management and recovery in the target application.
Running the demo or validating a skill's format does not establish those.
