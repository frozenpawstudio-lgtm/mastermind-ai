# AGENTS.md — AIRA (MasterMind AI)

Mobile-first AI operator interface served by a Cloudflare Worker with Durable
Objects. Owner-gated: state-changing API calls fail closed without an owner
credential.

## Layout

- `worker.js` — Cloudflare Worker + Durable Object API. Authoritative state.
- `index.html` — the application (single file: markup, CSS, JS inline).
- `public/index.html` — served copy. **Must stay byte-identical to
  `index.html`.** After editing `index.html`, run
  `cp index.html public/index.html`.
- `test/` — browser and API suites.

## Local development

The remote AI binding causes a reload loop under plain `wrangler dev`, so run
local mode:

```bash
npx wrangler dev --local --port 8787
```

Tests target `http://127.0.0.1:8787` by default; override with
`AIRA_BASE_URL`.

Owner credential lives in `.dev.vars` as `OWNER_API_TOKEN` (never committed).
Tests that mutate state read it like this:

```bash
export OWNER_API_TOKEN=$(grep '^OWNER_API_TOKEN=' .dev.vars | cut -d= -f2- | tr -d '"'"'" | tr -d '\r')
```

## Tests

```bash
node test/test_ui_console.mjs            # UI behaviour + console cleanliness (needs server)
node test/test_earning_workflow_e2e.mjs  # 11-stage earning workflow (needs OWNER_API_TOKEN)
node test/run_all_tests.mjs              # API regression suites
node test/audit_honesty.mjs              # no invented earnings/metrics
node test/audit_secret_exposure.mjs      # token never reaches the DOM or console
node test/audit_touch_targets.mjs        # >=44px tap targets
node test/audit_word_breaks.mjs          # no mid-word breaks at 360/390/412px
node test/test_security_surface.js       # auth posture of every route + read surface
node test/test_asset_exposure.js         # .assetsignore keeps config/source out of the public surface
node test/layout_audit.mjs home chat tools tasks profile   # no horizontal overflow
node test/capture_screens.mjs <label>    # screenshots to .agent_tmp/screens/<label>/
node test/build_comparison.mjs           # side-by-side before/after sheets
```

There is no `npm test`; run the scripts directly.

## Mobile CSS invariants

- Never use `overflow-wrap: anywhere` on text inside a flex row. It collapses
  the element's min-content width to one character, so flexbox shrinks pills
  and value columns until they break mid-word. Use `overflow-wrap: break-word`
  and let the row wrap (`flex-wrap: wrap`).
- Set an explicit `min-height` for the chat composer; the global `textarea`
  rule is 74px and would otherwise push the send button into the input.
- `.dock` is `position: fixed`. A full-page screenshot renders it mid-page;
  capture with `fullPage: false` to judge bottom-nav placement.

## Security invariants

- Never persist the owner token to localStorage, sessionStorage, cookies, the
  URL or the console. It lives in a module-level variable only.
- Do not bypass owner approval or single-use approval checks to make a control
  look functional.
- Never display an earning, metric, task or payment as real without backend
  evidence. Unimplemented capability must read `NOT CONNECTED` / `NOT VERIFIED`.
- Authorize a read by what it returns, not by its name. The opportunity list, a
  single opportunity and COMPARE all return the same private business fields
  (title, source URL, platform, score, decision), so all three are Owner-only. A
  new read route that exposes a persisted record must be Owner-only too.
- `.assetsignore` is the only thing keeping repository files out of the public
  surface, because `assets.directory` is `"."`. Add any new config, lockfile or
  internal doc to it, and extend `test/test_asset_exposure.js`.

## Known gaps

- `GET /api/owner/profile` is **Owner-only on this branch** (committed here, not
  on `main`, where the GET is still public). The profile holds the Owner's
  personal business criteria, so this branch fails the unauthenticated read
  closed and `test_security_surface.js` asserts 401 for it. README now documents
  the public read surface precisely (runtime/foundation status plus discovery
  status); `main` still carries the older "Reads stay public" wording.

## Security work on this branch (not yet merged to `main`)

Two distinct states, because they were landed differently. Neither is verified
as deployed.

**Committed on this branch** (commits `df54729`, `83a7786`), not on `main`:

- `POST /api/chat` and `POST /api/research` require the Owner credential
  (`RISK.OWNER_CONTROLLED`) before any body parse or billed call (Workers AI,
  Browser Rendering). Unauthenticated requests return 401 and reach no model.

**Uncommitted on this branch** (working tree only):

- Both routes are rate limited through one shared Durable Object authority:
  30 requests / 60 s fixed window, keyed on a hash of the verified credential.
  `/api/chat` and `/api/research` use separate buckets so they cannot starve
  each other. The scope label is a fixed server-side allowlist, so a caller
  cannot mint a fresh bucket by naming one. Missing binding or a storage error
  fails closed (generic 500, no internals, no AI call).
- The direct Durable Object routes (`/agents/.../chat`, `.../rate-limit/check`)
  enforce the same authorization and limit, so the edge gate cannot be bypassed
  by addressing the DO directly. The instance segment of an `/agents/...` path is
  pinned to `default` so a caller cannot obtain a separate bucket per name.
- `test/run_all_tests.mjs` restores two preconditions before each suite
  (leftover opportunity fixtures removed; a fresh rate-limit window for suites
  that call owner `/api/chat`) so results do not depend on a fresh database.

## Opportunity tracking surface (V9 sections 25-27)

The earning workflow previously ended at PREPARE plus Owner approval, leaving the
post-approval half of the V9 lifecycle unrepresented. The following are
uncommitted on this branch.

- Three append-only tables in the Durable Object: `opportunity_lifecycle`,
  `payment_records`, `follow_ups`. The lifecycle history is never rewritten, so
  how a record reached its current stage stays answerable.
- Owner-only routes (absent from the public-read allowlist, so they fall through
  to the MUTATE boundary at both the `/api` edge and the direct DO path):
  `GET|POST /api/opportunities/:id/lifecycle`, `.../payment`, `.../follow-up`,
  `PATCH .../follow-up/:followUpId`, and the read-only `GET .../tracking`.
- Two evidence gates, matching the existing `verifyOpportunity` rule that
  `VERIFIED` needs FACT evidence:
  - lifecycle stage `SUBMITTED` is refused without FACT evidence — a status
    change is not proof of submission (section 24).
  - payment status `CONFIRMED_PAID` is refused without FACT evidence — only real
    evidence establishes confirmed payment (section 26). `PENDING`, `FAILED` and
    `UNKNOWN` are records of expectation or failure and need no evidence.
- Stage order is enforced: a lifecycle may not move backwards, and `REJECTED` is
  reachable from any open stage. Every write appends an audit-log entry.
- A follow-up records an intended next action and due time. It never claims a
  message was sent; sending stays an Owner action (sections 22/23).
