/*
 * Runs the complete backend API suite in a deterministic order.
 *
 * The suites talk to a locally running worker and mutate real local state, so
 * they must not run in parallel. Each suite is a separate Node process.
 *
 * Usage:
 *   OWNER_API_TOKEN=<token> node test/run_all_tests.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  "test_opportunities.js",
  "test_verification.js",
  "test_decision.js",
  "test_discovery.js",
  "test_eligibility_owner_fit.js",
  "test_prepare.js",
  "test_compare.js",
  "test_v9_foundations.js",
  "test_p5_data_integrity.js",
  "test_phase0_security.js",
  "test_security_surface.js"
];

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const results = [];
for (const suite of SUITES) {
  console.log(`\n=== ${suite} ===`);
  const code = await run(suite);
  results.push({ suite, code });
}

console.log("\n=== summary ===");
for (const r of results) {
  console.log(`${r.code === 0 ? "PASS" : "FAIL"}  ${r.suite}`);
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} suites passed`);
if (failed.length > 0) process.exitCode = 1;
