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

  await check("GET /api/owner/profile -> 401", async () => {
    const r = await probe("/api/owner/profile");
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("POST /api/chat -> 401", async () => {
    const r = await probe("/api/chat", jsonPost({ message: "security-surface-probe" }));
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("POST /api/research -> 401", async () => {
    const r = await probe("/api/research", jsonPost({ url: "https://example.com" }));
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

  // ---- 1b. Private opportunity reads must fail closed --------------------
  // The opportunity list and a single record carry private business data
  // (title, source URL, platform, score, decision). They must never be
  // readable without an Owner credential, at the edge or in the Durable Object.
  console.log("");
  console.log("1b. Private opportunity reads fail closed");

  await check("GET /api/opportunities (list) -> 401", async () => {
    const r = await probe("/api/opportunities");
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    assert.strictEqual(r.body.action, "DENIED");
  });

  await check("GET /api/opportunities/:id (single record) -> 401", async () => {
    const r = await probe("/api/opportunities/private-record-probe");
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    assert.strictEqual(r.body.action, "DENIED");
  });

  await check("GET /api/opportunities/:id does not leak record fields", async () => {
    const r = await probe("/api/opportunities/private-record-probe");
    const text = JSON.stringify(r.body);
    for (const field of ["title", "source_url", "platform", "score", "decision"]) {
      assert.ok(!text.includes(`"${field}"`), `refused read must not expose "${field}"`);
    }
  });

  await check("invalid token on GET /api/opportunities -> 401", async () => {
    const r = await probe("/api/opportunities", { headers: { Authorization: "Bearer not-the-owner-token" } });
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("foreign Origin does not open the opportunity list", async () => {
    const r = await probe("/api/opportunities", { headers: { Origin: "https://evil.example.com" } });
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  // A valid Owner credential must still read the private surface.
  if (OWNER_TOKEN) {
    await check("GET /api/opportunities with the Owner credential -> 200", async () => {
      const r = await probe("/api/opportunities", { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      assert.ok(Array.isArray(r.body.data), "Owner list read must return the { ok, data } envelope");
    });
  } else {
    console.log("  (skipped Owner-positive read check: OWNER_API_TOKEN not supplied)");
  }

  // ---- 2. Documented public reads stay available -------------------------
  console.log("");
  console.log("2. Documented public reads");

  for (const path of ["/api/health", "/api/permissions", "/api/connections", "/api/voice"]) {
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

  // ---- 4. Read surface: measure and report --------------------------------
  console.log("");
  console.log("4. Read surface without a credential (measured, not asserted)");

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

  // Chat and research consume billed AI / Browser Rendering quota and are
  // Owner-only. They are asserted as 401 in section 3; log the measured status
  // here so a regression shows up as a warning as well.
  for (const { path, body } of [
    { path: "/api/chat", body: { message: "security-surface-probe" } },
    { path: "/api/research", body: { url: "https://example.com" } }
  ]) {
    const r = await probe(path, jsonPost(body));
    const open = r.status < 400;
    console.log(`  ${open ? "WARN" : " ok "} POST ${path} -> ${r.status}`);
    if (open) {
      warnings.push(`POST ${path} is reachable without a credential and consumes billed quota`);
    }
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
