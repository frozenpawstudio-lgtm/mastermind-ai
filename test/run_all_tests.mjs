/*
 * Runs the complete backend API suite in a deterministic order.
 *
 * The suites talk to a locally running worker and mutate real local state, so
 * they must not run in parallel. Each suite is a separate Node process.
 *
 * Isolation. All suites share one worker, so two kinds of leftover state can
 * make an otherwise-correct suite fail:
 *
 *   1. Opportunity records persisted by an earlier run (or a crashed run) break
 *      the suites that assert on a lone or empty opportunity set.
 *   2. The shared chat rate-limit window (30 requests / 60 s) can already be
 *      exhausted by an earlier suite or command, so a later suite that expects
 *      authorized /api/chat to return 200 receives 429 instead.
 *
 * The runner restores both preconditions rather than weakening any assertion:
 *
 *   - before each suite it removes leftover opportunity fixtures;
 *   - before a suite that calls owner /api/chat it waits for a fresh
 *     rate-limit window, aligned to the same epoch boundary the worker uses.
 *
 * Cleanup runs only against a local worker; a non-local TEST_BASE_URL is left
 * untouched and a warning is printed.
 *
 * Usage:
 *   OWNER_API_TOKEN=<token> node test/run_all_tests.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN || "";
const RATE_LIMIT_WINDOW_MS = 60_000;

/*
 * `ownerChat: true` marks a suite that calls owner-authenticated /api/chat and
 * therefore needs headroom in the shared rate-limit window. The dedicated
 * rate-limit suite is run separately (see AGENTS.md): it deliberately drives the
 * bucket over the limit, so it is not part of this regression list.
 */
const SUITES = [
  { file: "test_opportunities.js" },
  { file: "test_verification.js" },
  { file: "test_decision.js" },
  { file: "test_discovery.js" },
  { file: "test_eligibility_owner_fit.js" },
  { file: "test_prepare.js" },
  { file: "test_compare.js" },
  { file: "test_opportunity_tracking.mjs" },
  { file: "test_rejection_memory.mjs" },
  { file: "test_tracking_ui.mjs" },
  { file: "test_v9_foundations.js", ownerChat: true },
  { file: "test_p5_data_integrity.js" },
  { file: "test_phase0_security.js" },
  { file: "test_security_surface.js" },
  { file: "test_asset_exposure.js" }
];

function isLocalTarget(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

/*
 * Remove opportunity fixtures left by an earlier or crashed run so suites that
 * assume a clean table see one. Only ever runs against a local worker.
 */
async function cleanupOpportunities() {
  if (process.env.AIRA_TEST_NO_CLEANUP === "1") {
    return { skipped: "AIRA_TEST_NO_CLEANUP=1" };
  }
  if (!OWNER_TOKEN) {
    return { skipped: "OWNER_API_TOKEN not set" };
  }
  if (!isLocalTarget(BASE_URL)) {
    return { skipped: `non-local target ${BASE_URL} left untouched` };
  }
  let rows;
  try {
    const res = await fetch(`${BASE_URL}/api/opportunities`, {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` }
    });
    if (!res.ok) return { skipped: `list responded ${res.status}` };
    const body = await res.json();
    rows = Array.isArray(body?.data) ? body.data : [];
  } catch (error) {
    return { skipped: `list failed: ${error.message}` };
  }
  let removed = 0;
  for (const row of rows) {
    if (!row || !row.id) continue;
    try {
      const del = await fetch(`${BASE_URL}/api/opportunities/${row.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${OWNER_TOKEN}` }
      });
      if (del.ok) removed++;
    } catch {
      /* leave the record; the suite will report the real failure */
    }
  }
  return { removed, total: rows.length };
}

/*
 * Guarantee an owner-authenticated chat suite starts in a fresh window.
 *
 * Checking only `allowed === false` is not enough: a window that is merely
 * "not over the limit" can still be too full for a suite that makes many chat
 * calls (test_v9_foundations.js issues 22). The probe itself consumes one unit,
 * so a genuinely fresh window reports count === 1; anything higher means an
 * earlier run, suite or command already spent quota in this window, and we wait
 * for the next boundary. The boundary is aligned to the same epoch the worker
 * uses (`windowStart = now - now % 60`), so no further probing is needed.
 */
async function ensureRateLimitHeadroom() {
  if (!OWNER_TOKEN) {
    console.log("  preflight: rate-limit headroom check skipped (OWNER_API_TOKEN not set)");
    return;
  }
  if (!isLocalTarget(BASE_URL)) {
    console.log(`  preflight: rate-limit headroom check skipped (non-local target ${BASE_URL})`);
    return;
  }

  const checkUrl = `${BASE_URL}/agents/master-mind-agent/default/rate-limit/check`;

  async function probeCount() {
    try {
      const res = await fetch(checkUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${OWNER_TOKEN}` }
      });
      if (res.status !== 200) return null;
      const body = await res.json();
      return typeof body?.count === "number" ? body.count : null;
    } catch {
      return null;
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const count = await probeCount();
    if (count !== null && count <= 1) {
      console.log("  preflight: rate-limit window is fresh");
      return;
    }

    const msToBoundary = RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
    const waitMs = msToBoundary + 1000;
    console.log(
      `  preflight: rate-limit window already has ${count === null ? "unknown" : count} unit(s), waiting ${Math.round(waitMs / 1000)}s for a fresh one`
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  console.log("  preflight: warning: could not confirm a fresh rate-limit window");
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const results = [];
for (const suite of SUITES) {
  console.log(`\n=== ${suite.file} ===`);

  const cleanup = await cleanupOpportunities();
  if (cleanup.removed !== undefined) {
    console.log(`  preflight: removed ${cleanup.removed}/${cleanup.total} leftover opportunity fixture(s)`);
  } else {
    console.log(`  preflight: opportunity cleanup skipped (${cleanup.skipped})`);
  }

  if (suite.ownerChat) {
    await ensureRateLimitHeadroom();
  }

  const code = await run(suite.file);
  results.push({ suite: suite.file, code });
}

console.log("\n=== summary ===");
for (const r of results) {
  console.log(`${r.code === 0 ? "PASS" : "FAIL"}  ${r.suite}`);
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} suites passed`);
if (failed.length > 0) process.exitCode = 1;

