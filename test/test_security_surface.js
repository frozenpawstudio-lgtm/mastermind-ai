import assert from "node:assert";

/*
 * Runtime security surface test.
 *
 * Unlike test_phase0_security.js (which covers the approval state machine and
 * audit logging), this suite exercises the *whole* HTTP surface the Worker
 * exposes and asserts the authorization posture of each route against a
 * running Worker.
 *
 * Hard assertions cover the invariants that must always hold:
 *   - every state mutation fails closed without an Owner credential
 *   - evidence, audit-logs and approvals are Owner-only
 *   - CORS never reflects an arbitrary foreign origin
 *
 * The final section measures the unauthenticated read surface of the AI and
 * owner-data routes and prints WARN lines for anything reachable without a
 * credential. Those are reported, not asserted, because whether an owner
 * profile read is public is a product decision (README: "Reads stay public"),
 * not something this test should silently redefine.
 */

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN || "";

let passed = 0;
let failed = 0;
const warnings = [];

async function probe(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers };
}

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${label}`);
    console.log(`      ${error.message}`);
    failed++;
  }
}

const jsonPost = (payload) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});

async function run() {
  console.log(`Security surface test against ${BASE_URL}`);
  console.log(`Owner credential supplied: ${OWNER_TOKEN ? "yes" : "NO"}`);
  console.log("");

  // ---- 1. Mutations must fail closed without a credential ----------------
  console.log("1. Unauthenticated mutations fail closed");

  await check("POST /api/opportunities -> 401", async () => {
    const r = await probe("/api/opportunities", jsonPost({ title: "x" }));
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    assert.strictEqual(r.body.action, "DENIED");
  });

  await check("POST /api/evidence -> 401", async () => {
    const r = await probe("/api/evidence", jsonPost({ opportunity_id: "x", kind: "k" }));
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("GET /api/evidence -> 401", async () => {
    const r = await probe("/api/evidence");
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("POST /api/owner/profile -> 401", async () => {
    const r = await probe("/api/owner/profile", jsonPost({ skills: "x" }));
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("POST /api/approvals -> 401", async () => {
    const r = await probe("/api/approvals", jsonPost({ action: "x" }));
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("GET /api/audit-logs -> 401", async () => {
    const r = await probe("/api/audit-logs");
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("DELETE /api/audit-logs -> not 2xx", async () => {
    const r = await probe("/api/audit-logs", { method: "DELETE" });
    assert.ok(r.status >= 400, `expected an error status, got ${r.status}`);
  });

  await check("POST /api/opportunities/:id/prepare -> 401", async () => {
    const r = await probe("/api/opportunities/unknown-id/prepare", jsonPost({}));
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  // ---- 2. Documented public reads stay available -------------------------
  console.log("");
  console.log("2. Documented public reads");

  for (const path of ["/api/health", "/api/permissions", "/api/opportunities", "/api/connections", "/api/voice"]) {
    await check(`GET ${path} -> 200`, async () => {
      const r = await probe(path);
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
    });
  }

  // ---- 3. CORS must not reflect an arbitrary origin ----------------------
  console.log("");
  console.log("3. CORS origin restriction");

  await check("foreign Origin is not reflected in Access-Control-Allow-Origin", async () => {
    const res = await fetch(`${BASE_URL}/api/health`, {
      headers: { Origin: "https://evil.example.com" }
    });
    const allow = res.headers.get("Access-Control-Allow-Origin");
    assert.notStrictEqual(
      allow,
      "https://evil.example.com",
      "foreign origin was reflected"
    );
    assert.notStrictEqual(allow, "*", "wildcard origin returned");
  });

  // ---- 4. Unauthenticated read surface: measure and report ---------------
  console.log("");
  console.log("4. Unauthenticated read surface (measured, not asserted)");

  const surface = [
    { path: "/api/owner/profile", method: "GET", label: "owner profile (personal criteria)" },
    { path: "/api/opportunities/discover", method: "GET", label: "discovery status" }
  ];

  for (const { path, method, label } of surface) {
    const r = await probe(path, { method });
    const reachable = r.status >= 200 && r.status < 300;
    const hasData = r.body && r.body.data !== null && r.body.data !== undefined;
    console.log(
      `  ${reachable ? "WARN" : " ok "} ${method} ${path} -> ${r.status}` +
        (reachable ? ` (${label}${hasData ? ", returns data" : ", empty"})` : "")
    );
    if (reachable && hasData) {
      warnings.push(`${method} ${path} returns ${label} without a credential`);
    }
  }

  // Chat and research are POST surfaces that consume AI/browser quota.
  const chat = await probe("/api/chat", jsonPost({ message: "security-surface-probe" }));
  console.log(
    `  ${chat.status < 500 ? "WARN" : " ok "} POST /api/chat -> ${chat.status}` +
      (chat.status < 500 ? " (no credential required; consumes AI quota)" : "")
  );
  if (chat.status < 500) {
    warnings.push("POST /api/chat is reachable without a credential and consumes AI quota");
  }

  const research = await probe("/api/research", jsonPost({ url: "https://example.com" }));
  console.log(
    `  ${research.status < 500 ? "WARN" : " ok "} POST /api/research -> ${research.status}` +
      (research.status < 500 ? " (no credential required; drives server-side fetch)" : "")
  );
  if (research.status < 500) {
    warnings.push("POST /api/research is reachable without a credential and drives a server-side fetch");
  }

  // ---- Summary -----------------------------------------------------------
  console.log("");
  if (warnings.length) {
    console.log("Unauthenticated surface warnings:");
    for (const w of warnings) console.log(`  ! ${w}`);
    console.log("");
  }
  console.log(`security surface test: ${passed} passed, ${failed} failed, ${warnings.length} warning(s)`);

  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
