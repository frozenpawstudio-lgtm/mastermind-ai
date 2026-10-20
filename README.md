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

## Operator console (UI)

`index.html` is the mobile-first operator console. `public/index.html` is kept
byte-identical; the worker serves the root copy, and the public copy exists so
both asset paths agree.

Screens: Home (real status, the eleven-stage earning pipeline, next recommended
action), Chat (one request per tap), Earning (opportunity cards with source URL,
evidence, eligibility, owner fit, estimated cost, risk and status), Research,
Tasks, Audit and Profile. Tasks reports `TASK TRACKING UNAVAILABLE` because no
task store is connected.

The earning pipeline is rendered from persisted engine state, not from a module
label. A stage reads COMPLETE only when the backend record proves it. Execution,
result verification and follow-up always read OWNER_REQUIRED. The console never
claims earnings, payments, completed tasks or successful submissions, and
unavailable values read `DATA NOT AVAILABLE` or `NOT CONFIGURED`.

### Owner credential handling

The owner token is held in a module-scoped JavaScript variable for the lifetime
of the page. It is never written to `localStorage`, `sessionStorage`, cookies,
the URL or the console, and never rendered into the DOM. Closing the tab
discards it. Reads stay public; every mutation fails closed with HTTP 401
without the credential.

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
```

Backend API suites (mutate real local state, so they run sequentially):

```bash
npm run test:api          # all ten suites, prints a pass/fail summary
```

Individual suites: `test_opportunities.js`, `test_verification.js`,
`test_decision.js`, `test_discovery.js`, `test_eligibility_owner_fit.js`,
`test_prepare.js`, `test_compare.js`, `test_v9_foundations.js`,
`test_p5_data_integrity.js`, `test_phase0_security.js`.

Browser UI suites (real Chromium via the DevTools Protocol, no extra npm
dependencies). Set `OWNER_API_TOKEN` so the Owner-gated paths are exercised:

```bash
OWNER_API_TOKEN=<token> npm run test:ui        # 44 UI, navigation, layout and
                                              # authorization assertions
OWNER_API_TOKEN=<token> npm run test:workflow  # end-to-end proof that the
                                              # eleven-stage earning pipeline is
                                              # real and never fakes a submission
```

Layout measurement:

```bash
npm run test:layout        # per-screen overflow audit at 360/390/412 px
npm run screens after      # writes .agent_tmp/screens/after/*.png
npm run seed               # optional demo record; npm run seed:clean removes it
```

`npm run seed` writes one clearly-labelled local record (`source`
`screenshot-seed`) so the Earning screen can be reviewed populated. Remove it
with `npm run seed:clean` before running `npm run test:api`, because the
compare suite asserts exact counts.

Set `TEST_BASE_URL` to point the suites at another host.

The UI suites drive the real page and the real HTTP API. They are not
simulations. Deployment and Cloudflare production verification are separate
steps that require explicit Owner approval.
