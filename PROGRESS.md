# AIRA — MasterMind AI · Progress Record

Truthful, evidence-backed record of implemented vs remaining work. Contains no
secrets. Labels: VERIFIED · PARTIALLY VERIFIED · NOT VERIFIED · UNKNOWN ·
BLOCKED · FAILED.

All test evidence below is **LOCAL** (wrangler dev + miniflare on this machine).
No Production API call was made. Production behaviour is **NOT VERIFIED**.

## Current Git state

- Repository: `frozenpawstudio-lgtm/mastermind-ai`
- Workspace: `/workspace/aira-secpr` (linked worktree; common git dir
  `/workspace/project/mastermind-ai/.git`)
- Branch: `fix/earning-context-owner-credential`
- HEAD: `8b13cb64be4dc9ac85832a4e4081bd25a0f9053b`
- `origin/main`: `9ce413aeb1e485780a1fa384f2d0b3a25c500fc7`
- Committed and pushed on this branch (PR #22). Working tree clean.

Commits on this branch (newest first):

| Commit | Message |
| --- | --- |
| `8b13cb6` | test(phase1): verify security and earning workflow |
| `e05ea0a` | feat(phase1): add owner security, rate limiting and earning tracking |
| `ab0f200` | fix(assets): exclude workspace and source files from served assets |
| `83a7786` | fix(chat): forward Owner credential to earning-context reads and await builder |
| `df54729` | fix(security): require the Owner credential for private reads and billed AI routes |

The last two pre-date this work and were already on the branch.

Second worktree `/workspace/project/mastermind-ai` @ `b5026f1` was **not
modified** (worker.js blob unchanged at `ce649ac2e169299c8d138c7392b901861cb67b18`).

## What is committed vs uncommitted

- **Committed on this branch** (not on `main`): commits `df54729`, `83a7786`
  add the Owner-credential gate to `/api/chat`, `/api/research` and
  `GET /api/owner/profile`. `origin/main:worker.js` gates the profile with
  `RISK.READ` for GET (i.e. public) and has **no** gate at all on `/api/chat`
  or `/api/research` — verified by reading `git show origin/main:worker.js`.
- **Uncommitted (working tree)**: none — everything below is committed on this
  branch and pushed to `origin/fix/earning-context-owner-credential` (PR #22).
  Rate limiting, the scope allowlist, the agent-instance pinning, the
  test-isolation preflight and the V9 §25-27 tracking surface are all in
  `e05ea0a`; their tests and the doc updates are in `8b13cb6`.

## Canonical specification

- `docs/V9_MASTER_SOURCE_OF_TRUTH.txt` at commit `101c8c5` on
  `origin/docs/v9-source-of-truth`; sha256
  `f0bf881b9dca9d0a189e49e9b6ce0e7cfb653656d6b68a9d92c3650f53e1fbf2`,
  97476 bytes, 6662 lines, 145 sections — **VERIFIED** (matches the historical
  checksum).
- `docs/specifications/AIRA_MASTER_MIND_AI_V9_FINAL_WITH_CONNECTION_VOICE.txt`
  is **NOT PRESENT** anywhere in the repository.

## Test-isolation defect: cause and fix

Symptom (reproduced): on a reused database, `test/run_all_tests.mjs` returned
10/11 or 9/11, while a fresh database returned 11/11.

Two independent causes, both reproduced directly:

1. **Leftover opportunity records.** `test_compare.js` asserts a lone
   unevaluated opportunity ranks `rank === 1`. A persisted record from an
   earlier run makes it rank 2: `AssertionError: 2 !== 1`.
2. **Exhausted shared rate-limit window.** `test_v9_foundations.js` makes 22
   owner `/api/chat` calls and asserts each returns 200. If an earlier suite or
   command already spent the 30-request window, the call returns 429:
   `AssertionError: 429 !== 200`.

Fix in `test/run_all_tests.mjs` (restores preconditions; no assertion weakened
or removed):

- Before each suite, leftover opportunity fixtures are deleted via
  `DELETE /api/opportunities/:id`. Only runs against a local target; a non-local
  `TEST_BASE_URL` is left untouched with a printed warning. Opt out with
  `AIRA_TEST_NO_CLEANUP=1`.
- Before a suite flagged `ownerChat: true` (`test_v9_foundations.js`), the
  runner requires a genuinely fresh window. It probes
  `/agents/.../rate-limit/check` and only proceeds when the probe itself is the
  first unit in the window (`count <= 1`); otherwise it waits past the next
  fixed-window boundary, aligned to the same epoch the worker uses
  (`windowStart = now - now % 60`). Checking only "not over the limit" was not
  enough and was caught in testing — a partly-spent window left too little
  headroom for 22 calls.

A wrong `--var OWNER_API_TOKEN=iso-token` (equals instead of `:`) during an early
run caused all 11 suites to fail with 401 `NOT_CONFIGURED`. That was a mistake in
the test command, not a code defect, and it incidentally confirmed the
fail-closed path: with the token unconfigured the Worker denies every protected
route.

## Test results (local)

Server: `wrangler dev --local`, `OWNER_API_TOKEN` set via `--var`.

### `test/run_all_tests.mjs` (12 suites)

| Scenario | Command | Exit | Result |
| --- | --- | --- | --- |
| Fresh DB | `node test/run_all_tests.mjs` | 0 | **12/12 passed** |
| Warm DB, run 1 | `node test/run_all_tests.mjs` | 0 | **12/12 passed** |
| Warm DB, run 2 | `node test/run_all_tests.mjs` | 0 | **12/12 passed** |
| Adversarial A (bucket exhausted + 3 leftovers) | `node test/run_all_tests.mjs` | 0 | **12/12 passed** |

Before the fix, warm/adversarial runs returned 10/11 (429) or 9/11. After the
fix the result is stable across fresh, warm, repeated and adversarial states.

### Other suites

| Command | Exit | Result |
| --- | --- | --- |
| `node test/test_chat_rate_limit.js` | 0 | **32 passed, 0 failed** |
| `node test/test_opportunity_tracking.mjs` | 0 | **23 passed, 0 failed** |
| `node test/test_chat_earning_context.mjs` | 0 | passed |
| `node test/test_earning_workflow_e2e.mjs` | 0 | 10 passed, 0 failed |
| `node test/test_ui_console.mjs` | 0 | 44 passed, 0 failed |
| `node test/audit_honesty.mjs` | 0 | 136 passed, 0 failed |
| `node test/audit_secret_exposure.mjs` | 0 | 0 failures |
| `node test/audit_touch_targets.mjs` | 0 | 0 of 129 under 44×44 px |
| `node test/audit_word_breaks.mjs` | 0 | 0 mid-word breaks at 3 widths |

## V9 source-of-truth audit (this review)

- Canonical source: `docs/V9_MASTER_SOURCE_OF_TRUTH.txt`, present only on the
  remote branch `docs/v9-source-of-truth` (commit `101c8c5`). It is **not** on
  `main` and not in either worktree.
- Identity **VERIFIED**: 97,476 bytes, 6,662 lines, SHA-256
  `f0bf881b9dca9d0a189e49e9b6ce0e7cfb653656d6b68a9d92c3650f53e1fbf2` — an exact
  match to the historical checksum. All 146 sections (0–145) are present with no
  gaps, plus Master Vision A–N and the Final Master Lock.
- The requested path
  `docs/specifications/AIRA_MASTER_MIND_AI_V9_FINAL_WITH_CONNECTION_VOICE.txt`
  does **not** exist on any branch or worktree. It has not been restored.

### Test-integrity defect found and fixed

`test/audit_touch_targets.mjs` printed offenders but never set a nonzero exit
code, so it could not fail a build. It now sets `process.exitCode = 1` when any
control is under 44x44 CSS px. Verified both ways: `MIN=999` exits 1, `MIN=44`
exits 0. `test/layout_audit.mjs` has the same weakness and is left unchanged
pending an Owner decision, because it is an ad-hoc development tool.

### Production drift (NOT VERIFIED, read-only checks only)

Production (https://mastermind-ai.frozenpawstudio.workers.dev) does **not** match
this branch:

| Probe | Production | This branch (local) |
| --- | --- | --- |
| `POST /api/chat` anon | 400 (input validation, no auth) | 401 |
| `GET /api/owner/profile` anon | 200 | 401 |
| `GET /api/opportunities` anon | 200 | 401 |
| `GET /api/evidence`, `/api/audit-logs` anon | 401 | 401 |
| `/pnpm-workspace.yaml`, `/AGENTS.md`, `/worker.js` | 404 | n/a |

So the Owner-only read hardening and the anonymous-chat 401 are **not deployed**.
Asset exclusion is deployed. Production is **NOT VERIFIED** against V9.

## V9 section 25-27: opportunity tracking surface (new, this review)

The earning workflow previously ended at PREPARE plus Owner approval. V9 sections
25 (opportunity tracking), 26 (payment/earning tracking) and 27 (follow-up) were
**not implemented** in `worker.js`; the UI workflow hint ended at
`TRACK FOLLOW-UP` with `owner: true, "not automated"` and nothing behind it.

Implemented in the Durable Object:

- Three append-only tables: `opportunity_lifecycle`, `payment_records`,
  `follow_ups`. Lifecycle history is never rewritten.
- Owner-only routes: `GET|POST /api/opportunities/:id/lifecycle`,
  `.../payment`, `.../follow-up`, `PATCH .../follow-up/:followUpId`, and
  `GET .../tracking` (summary). These are deliberately **absent** from the
  public-read allowlist, so they require the Owner credential at both the
  `/api` edge and the directly reachable `/agents/...` DO path.
- Evidence gates, mirroring the existing rule that `VERIFIED` needs FACT
  evidence: lifecycle stage `SUBMITTED` and payment status `CONFIRMED_PAID` are
  both refused without FACT evidence. `PENDING`/`FAILED`/`UNKNOWN` payments
  assert no money and need none.
- Stage order enforced (no backwards moves; `REJECTED` reachable from any open
  stage). Every write appends an audit-log entry.

Honesty boundary kept: a follow-up records an intended next action and due time
only. It never claims a message was sent, and no route performs a platform
submission (V9 sections 22/23/24).

### Sections 28-29: storage implemented, decision influence NOT implemented

- **§28 rejection learning** — storage implemented: a rejection cause is recorded
  against an opportunity from a fixed `REJECTION_CAUSES` allowlist, validated on
  write, and readable back per opportunity. The learning half is NOT implemented:
  `evaluateDecision` and `comparePersistedOpportunities` never read the stored
  lessons, so a past rejection does not influence a later decision or ranking.
- **§29 opportunity memory** — storage implemented: cross-opportunity memory
  entries are stored from a fixed `MEMORY_CATEGORIES` allowlist and recalled via
  `POST /api/opportunities/memory/recall`. Using that recall as precedent inside
  the decision/ranking path is NOT implemented.

Storage and validation exist and are tested (`test/test_rejection_memory.mjs`,
26 assertions). Decision influence remains unimplemented and is **not faked**:
`recallMemory` is reachable only through its own route, never from
`evaluateDecision`. V9 §28-§29 define no decision algorithm, so none was invented.
These two are therefore reported as storage-only, not as `NOT CONNECTED`.

## Security properties re-verified (local HTTP)

| Property | Observed |
| --- | --- |
| `POST /api/chat` with no credential | 401 |
| `POST /api/chat` with a wrong credential | 401 |
| `POST /api/chat` with a malformed `Bearer` header | 401 |
| `POST /api/chat` with the valid credential | 200 |
| Denied chat body | `action: "DENIED"`, no model output field |
| Denied chat reaches no model and mutates no state | asserted in `test_chat_rate_limit.js` §1 |
| `POST /api/research` with no credential | 401 |
| `POST /api/research` with the valid credential | 503 (BROWSER binding absent locally) |
| `GET /api/owner/profile` with no credential | 401 |
| Missing Durable Object binding, authorized chat | 500 generic, no internals, no AI call |
| Forged rate-limit scope (`/x`, `/aaa`, `/RESEARCH`, `/researchx`) | collapses to the bounded chat bucket; cannot mint a fresh bucket |
| Caller-chosen `/agents/<name>/...` instance | pinned to `default`; shares one bucket |

### Defect found and fixed during this review

The rate-limit scope was selected with `^\/[a-z]{1,16}$`, so any authenticated
caller could mint a fresh 30-request bucket per name (`/x`, `/aaa`, `/abc`…),
each with its own allowance. Reproduced live. Fixed to an exact allowlist —
only `/research` selects its own bucket, everything else collapses to `chat`.
Regression tests added: forged scopes must consume the shared chat counter
(delta of exactly 2 across two surrounding probes), and a near-miss research
label must leave the research counter untouched.

## Remaining limitations

- **Production provenance — NOT VERIFIED.** No local record maps Cloudflare
  Version ID `face4bce-07dd-406e-953c-c4bdb1b28aa1` to a commit. The security
  fixes are absent from `origin/main`. No Production contact was made.
- **Rate-limit race safety — PARTIALLY VERIFIED.** Single atomic UPSERT plus
  per-instance serialization, exercised under miniflare; not verified against a
  real Cloudflare Durable Object.
- **Test-isolation fix is runner-level.** Running a suite directly against a
  warm database can still fail for the two reasons above; only
  `run_all_tests.mjs` restores the preconditions. This is intentional — it keeps
  each suite's own assertions honest.
- **`GET /api/owner/profile`** is public on `main` and is a documented Owner
  decision there; this branch makes it Owner-only (committed). README now
  documents the exact public read surface (runtime/foundation status plus
  discovery status), so the older "Reads stay public" wording no longer
  contradicts the implementation on this branch.
- **Rate limiting is committed** on this branch (commit `e05ea0a`), so it is in
  `origin/fix/earning-context-owner-credential` but **not** in `main` and **not
  deployed**.
- **V9 §25-27 tracking is committed** on this branch (`e05ea0a`). The tracking
  surface is reachable both through the API and through the UI: each opportunity
  card renders a `Track` control that reads `GET .../tracking` and records
  lifecycle, payment and follow-up state. It is **not** merged to `main` and
  **not** deployed.
- **V9 §28 (rejection learning) and §29 (opportunity memory): storage and
  validation are implemented; decision influence is NOT implemented.** Stored
  lessons and memory entries are never read by `evaluateDecision` or
  `comparePersistedOpportunities`, and V9 defines no algorithm for that
  influence, so none was invented.
- **GPT-6 Astra: NOT VERIFIED** (not configured). **Voice:
  `VOICE_NOT_CONFIGURED`.** **Upwork/Fiverr: `supported: false`.** No dedicated
  Builder Agent exists.

## Next permitted task

PR #22 (`fix/earning-context-owner-credential` → `main`) carries the rate
limiting, scope allowlist, agent-instance pinning, test-isolation preflight, the
V9 §25-27 tracking surface and the doc updates. Merging PR #22 and any Cloudflare
deployment each require separate Owner authorization.
