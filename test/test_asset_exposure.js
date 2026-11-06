import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { statSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

/*
 * Asset-exposure regression test.
 *
 * The Worker is configured with `assets.directory = "."`, so EVERY file in the
 * repository is a candidate static asset. `.assetsignore` is the only thing
 * that keeps project configuration, the lockfile and the Worker source out of
 * the public surface. This suite boots a real local Worker against the
 * repository's own `.assetsignore` and asserts that sensitive/non-public files
 * are NOT served while the application itself still is.
 *
 * It runs its own server so the assertion reflects the committed
 * `.assetsignore`, not whatever a shared dev server happened to load.
 *
 * Usage: node test/test_asset_exposure.js
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const PORT = Number(process.env.ASSET_TEST_PORT || 8862);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// The server and its state directory are removed on SIGINT/SIGTERM too, so a
// Ctrl-C leaves no orphaned `wrangler dev` process or temp directory behind.
let activeServer = null;
let activePersistDir = null;
const onSignal = (signal) => {
  if (activeServer) activeServer.kill("SIGKILL");
  if (activePersistDir) rmSync(activePersistDir, { recursive: true, force: true });
  console.error(`asset exposure test: interrupted by ${signal}`);
  process.exit(130);
};
process.once("SIGINT", () => onSignal("SIGINT"));
process.once("SIGTERM", () => onSignal("SIGTERM"));

/*
 * `node_modules/.bin/wrangler` is a POSIX shell shim, not a JS entry point, so
 * it cannot be spawned with process.execPath. Use the package's real JS entry.
 */
function resolveWranglerEntry() {
  const candidates = [
    join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
    join(repoRoot, "node_modules", "wrangler", "bin", "cf-wrangler.js")
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("could not locate the wrangler JS entry under node_modules/wrangler/bin");
}

// Files that must never be reachable as public assets.
const MUST_BE_EXCLUDED = [
  "worker.js",
  "upwork.js",
  "upwork-agent.js",
  "UPWORK_API_NOTES.md",
  "wrangler.jsonc",
  "package.json",
  "package-lock.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "README.md",
  "AGENTS.md",
  "PROGRESS.md",
  ".assetsignore",
  ".gitignore",
  ".dev.vars",
  "test/test_compare.js",
  "test/run_all_tests.mjs"
];

// The application entry point must still be served.
const MUST_BE_SERVED = ["/"];

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${label}`);
    console.error(`    ${error.message}`);
  }
}

async function waitForServer(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await delay(500);
  }
  return false;
}

async function status(path) {
  const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
  return res.status;
}

async function run() {
  console.log("Asset exposure test");
  console.log(`Repository: ${repoRoot}`);
  console.log("");

  // Durable Object state must live OUTSIDE the repository. `assets.directory`
  // is ".", so a `.wrangler/` write inside the repo is itself a watched-asset
  // change and puts `wrangler dev` into a reload loop that never opens the
  // port. A per-run temp dir also keeps runs isolated from each other.
  const persistDir = await mkdtemp(join(tmpdir(), "aira-asset-test-"));
  activePersistDir = persistDir;
  const cleanupPersist = async () => {
    await rm(persistDir, { recursive: true, force: true }).catch(() => {});
    activePersistDir = null;
  };

  const server = spawn(
    process.execPath,
    [
      resolveWranglerEntry(),
      "dev",
      "--local",
      "--port",
      String(PORT),
      "--persist-to",
      persistDir
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
  );
  activeServer = server;

  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d.toString()));
  server.stderr.on("data", (d) => (serverLog += d.toString()));

  try {
    const ready = await waitForServer();
    if (!ready) {
      throw new Error(`local worker did not start on ${BASE_URL}\n${serverLog.slice(-1500)}`);
    }

    console.log("1. Project configuration and source are not public assets");
    for (const file of MUST_BE_EXCLUDED) {
      await check(`GET /${file} is not served`, async () => {
        const code = await status(`/${file}`);
        assert.ok(
          code === 404 || code === 403,
          `expected 404/403 for /${file}, got ${code} — .assetsignore must exclude it`
        );
      });
    }

    console.log("");
    console.log("2. The application itself is still served");
    for (const path of MUST_BE_SERVED) {
      await check(`GET ${path} is served`, async () => {
        const code = await status(path);
        assert.ok(code === 200 || code === 307, `expected 200/307 for ${path}, got ${code}`);
      });
    }

    console.log("");
    console.log("3. Excluded files never expose their contents");
    for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "AGENTS.md", "worker.js"]) {
      await check(`GET /${file} body does not leak source`, async () => {
        const res = await fetch(`${BASE_URL}/${file}`);
        const body = await res.text();
        assert.ok(
          !body.includes("lockfileVersion") &&
            !body.includes("MasterMindAgent") &&
            !body.includes("allowBuilds"),
          `/${file} leaked project content`
        );
      });
    }

    console.log("");
    console.log("4. Upwork public status is sanitized and consistent");
    await check("GET /api/upwork/status reports NOT_CONFIGURED without credentials", async () => {
      const res = await fetch(`${BASE_URL}/api/upwork/status`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("cache-control") || "", /no-store/i);
      const payload = await res.json();
      assert.equal(payload?.data?.service, "upwork");
      assert.equal(payload?.data?.state, "NOT_CONFIGURED");
      assert.equal(payload?.data?.verified, false);
    });
    await check("GET /api/connections uses the same Upwork status", async () => {
      const res = await fetch(`${BASE_URL}/api/connections`);
      assert.equal(res.status, 200);
      const payload = await res.json();
      const upwork = payload?.data?.services?.find((service) => service.service === "upwork");
      assert.equal(upwork?.state, "NOT_CONFIGURED");
      assert.equal(upwork?.verified, false);
    });
    await check("GET /api/self-check uses the same Upwork status", async () => {
      const res = await fetch(`${BASE_URL}/api/self-check`);
      assert.equal(res.status, 200);
      const payload = await res.json();
      const upwork = payload?.connections?.find((service) => service.service === "upwork");
      assert.equal(upwork?.state, "NOT_CONFIGURED");
      assert.equal(upwork?.verified, false);
    });
  } finally {
    server.kill("SIGTERM");
    await delay(1500);
    if (!server.killed) server.kill("SIGKILL");
    await cleanupPersist();
  }

  console.log("");
  console.log(`asset exposure test: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
