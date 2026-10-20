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
