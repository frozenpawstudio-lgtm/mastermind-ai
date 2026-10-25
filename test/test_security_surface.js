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

  // ---- 4. Owner-gated surface: asserted (formerly WARN-only) -------------
  console.log("");
  console.log("4. Owner-gated surface (missing / invalid / valid credential)");

  const DO_CHAT = "/agents/master-mind-agent/default/chat";
  const DO_PROFILE = "/agents/master-mind-agent/default/owner/profile";
  const gated = [
    { path: "/api/owner/profile", method: "GET", label: "owner profile (personal criteria)" },
    { path: DO_PROFILE, method: "GET", label: "direct DO owner profile" },
    { path: "/api/chat", method: "POST", label: "chat (AI quota)", payload: { message: "security-surface-probe" } },
    { path: "/api/research", method: "POST", label: "research (browser quota)", payload: { url: "https://example.com" } },
    { path: DO_CHAT, method: "POST", label: "direct DO chat (AI quota + memory write)", payload: { message: "security-surface-probe" } }
  ];
  const reqFor = (g, headers) => g.method === "POST"
    ? { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(g.payload) }
    : { method: "GET", headers };

  for (const g of gated) {
    await check(`${g.method} ${g.path} without credential -> 401 (${g.label})`, async () => {
      const r = await probe(g.path, reqFor(g, {}));
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
      assert.ok(!r.body || r.body.data === undefined, "response leaked data");
    });
    await check(`${g.method} ${g.path} with invalid credential -> 401`, async () => {
      const r = await probe(g.path, reqFor(g, { Authorization: "Bearer not-the-owner-token" }));
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    });
    await check(`${g.method} ${g.path} token in query string is ignored -> 401`, async () => {
      const r = await probe(`${g.path}?token=${encodeURIComponent(OWNER_TOKEN || "x")}`, reqFor(g, {}));
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    });
    if (OWNER_TOKEN) {
      await check(`${g.method} ${g.path} with valid credential is not rejected`, async () => {
        const r = await probe(g.path, reqFor(g, { Authorization: `Bearer ${OWNER_TOKEN}` }));
        assert.notStrictEqual(r.status, 401, "valid Owner credential was rejected");
        assert.notStrictEqual(r.status, 403, "valid Owner credential was forbidden");
      });
    } else {
      console.log(`  - NOT RUN: valid-credential case for ${g.path} (OWNER_API_TOKEN not supplied to the test)`);
    }
  }

  // Public-by-design read, still measured and reported (not asserted).
  const disc = await probe("/api/opportunities/discover", { method: "GET" });
  console.log(`  info GET /api/opportunities/discover -> ${disc.status} (public discovery status, measured)`);
  if (disc.status >= 200 && disc.status < 300) {
    warnings.push("GET /api/opportunities/discover is readable without a credential (discovery status only)");
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
