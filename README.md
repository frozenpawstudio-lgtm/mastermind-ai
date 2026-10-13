# mastermind-ai
My personal MasterMind AI Agent website

## Phase 1 scope

Phase 1 is the **Earning Agent / Earning Operator** only, supported by three
owner-authorized foundations: Connection, Permission/Authorization, and Voice.
Phase 2 and later phases are **not implemented**.

## Truthful states

AIRA reports only states it can verify. A listed service is not a connected
service. Published truth states include: CONNECTED, NOT_CONNECTED,
NOT_CONFIGURED, PARTIALLY_CONNECTED, NEEDS_REAUTH, EXPIRED, REJECTED,
UNAVAILABLE, PLANNED. Voice uses VOICE_ACTIVE, VOICE_NOT_CONFIGURED,
VOICE_NOT_CONNECTED, VOICE_UNAVAILABLE, VOICE_NEEDS_REAUTH, VOICE_ERROR.

Nothing is reported as CONNECTED or VOICE_ACTIVE without verified runtime
evidence.

## Environment configuration

Never commit secrets. `OWNER_API_TOKEN` must be supplied through Cloudflare
runtime secrets (`wrangler secret put OWNER_API_TOKEN` or an uncommitted
`.dev.vars`). When it is absent, the permission foundation reports
`NOT_CONFIGURED` and authorization is not enforced.

`.dev.vars` and `.dev.vars.*` are listed in `.gitignore` and `.assetsignore` so
local secrets are neither committed nor served as static assets.

`ALLOWED_ORIGINS` is an optional comma-separated allow-list of extra browser
origins permitted to call the mutation APIs. Same-origin requests are always
allowed.

## API surface

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/health` | GET | Runtime health and truthful connection flags |
| `/api/self-check` | GET | Binding + foundation states |
| `/api/connections` | GET | Connection foundation report |
| `/api/permissions` | GET | Permission model and authorization state |
| `/api/voice` | GET | Voice foundation state |
| `/api/voice/command` | POST | Voice command intake (requires VOICE_ACTIVE) |
| `/api/opportunities` | GET/POST | Opportunity list / create |
| `/api/opportunities/:id` | GET/PATCH/DELETE | Opportunity record |
| `/api/opportunities/discover` | GET/POST | Discovery intake (truthful NOT_CONNECTED state) |
| `/api/opportunities/:id/decision` | POST | Deterministic decision evaluation. POST-only; GET returns 405 and does not mutate |
| `/api/opportunities/:id/eligibility` | POST | Eligibility evaluation. POST-only; GET returns 405 and does not mutate |
| `/api/opportunities/:id/owner-fit` | POST | Owner-fit evaluation. POST-only; GET returns 405 and does not mutate |
| `/api/opportunities/compare` | GET | Read-only deterministic ranking of persisted opportunities (COMPARE) |
| `/api/opportunities/:id/prepare` | POST | Owner-reviewable preparation package (PREPARE). Preparation only — never submits |
| `/api/evidence` | GET/POST/DELETE | Owner-only structured evidence records (valid Owner credential required) |
| `/api/owner/profile` | GET/POST | Owner profile record |
| `/api/audit-logs` | GET | Owner-only append-only audit log |
| `/api/approvals`, `/api/approvals/:id`, `/api/approvals/:id/decide` | GET/POST | Owner-only approval records and decisions |
| `/api/chat` | POST | AIRA conversation |

Authorization is applied by each route's declared risk, not by HTTP method.
Opportunity list, a single opportunity, COMPARE and discovery status are public
reads. Every other endpoint — including audit logs, approval records, evidence
reads, and all state-changing evaluations — requires a valid Owner credential.
State-changing evaluations are POST-only and never mutate state through GET.

Decision score and decision are owned by the deterministic decision engine.
Client-supplied values are ignored.

Upwork/Fiverr final submission is **manual and Owner-controlled**. AIRA never
auto-submits, never bypasses CAPTCHA/MFA/OTP or platform controls, and never
spends money silently.

## Tests

The suites under `test/` expect a locally running worker:

```bash
npx wrangler dev --local --port 8787
node test/test_opportunities.js
node test/test_verification.js
node test/test_decision.js
node test/test_discovery.js
node test/test_eligibility_owner_fit.js
node test/test_prepare.js
node test/test_compare.js
node test/test_v9_foundations.js
node test/test_p5_data_integrity.js
node test/test_phase0_security.js
node test/test_earning_workflow.js
```

Set `TEST_BASE_URL` to point the suites at another host.

## Earning Workflow (Phase 1 Earning Operator)

The Owner-visible earning pipeline is exposed through the Earning tab and the
`/api/opportunities/:id/workflow` endpoint:

`RESEARCH → DISCOVER → VERIFY → ELIGIBILITY → OWNER_FIT → COMPARE → SCORE →
SELECT → PREPARE → REQUEST_APPROVAL → EXECUTE → VERIFY_OUTCOME → TRACK →
FOLLOW_UP → LEARN_IMPROVE`

- `GET /api/opportunities/:id/workflow` returns a read-only derived view. The
  stages completed are computed from persisted engine state; a new opportunity
  truthfully stops at `VERIFY`.
- `POST /api/opportunities/:id/workflow` advances the manual Owner steps
  (`mark_prepared`, `request_approval`, `record_execution`, `record_outcome`,
  `record_follow_up`, `record_lesson`). It requires the Owner credential.
- `EXECUTE` is a **manual Owner action**. AIRA never submits, contacts a
  platform, creates an account, spends money or bypasses CAPTCHA/MFA/OTP.
  Recording execution requires an `APPROVED`, single-use Owner approval, and
  the approval is consumed on use.
- An outcome can only be marked verified with supporting evidence. A submission
  never implies success.
- External automated discovery is `NOT_CONNECTED`. The UI offers a manual /
  source-input workflow instead of fabricating search results.

