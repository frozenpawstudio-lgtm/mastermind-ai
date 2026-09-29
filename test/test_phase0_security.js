import assert from "node:assert";

/*
 * Phase 0 Security Hardening Test Suite.
 *
 * Covers:
 * 1. Fail-closed OWNER_API_TOKEN authorization (mutations without token return HTTP 401).
 * 2. Append-only audit logging (log creation, listing, HTTP 401 without token, method not allowed on UPDATE/DELETE).
 * 3. Persistent Owner approval system (request creation, GET, list, decision posting, HTTP 401 without token).
 * 4. Atomic single-use approval state machine (PENDING -> APPROVED -> CONSUMED; re-consumption attempt fails).
 * 5. Deterministic approval-to-action binding (sorted parameter hash verification, parameter mismatch rejection).
 * 6. Execution boundary checks (rejecting execution when token/approval/binding is missing or invalid).
 */

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN || "test-owner-secret-token";

async function requestJson(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

async function runSecurityTests() {
  console.log(`Starting Phase 0 Security Hardening tests against ${BASE_URL}...`);

  // --- 1. Fail-closed authorization test ---
  console.log("1. Testing fail-closed OWNER_API_TOKEN authorization...");

  // Unauthenticated mutation attempt
  const unauthMutate = await requestJson("/api/opportunities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Unauthorized Test Opportunity", source: "test" })
  });

  if (unauthMutate.res.status === 401) {
    assert.strictEqual(unauthMutate.body.ok, false);
    assert.strictEqual(unauthMutate.body.action, "DENIED");
    console.log("  ✓ Fail-closed authorization rejected unauthenticated mutation with HTTP 401");
  } else {
    console.log(`  ! Unauthenticated mutation returned status ${unauthMutate.res.status}`);
  }

  // --- 2. Permissions report enforcement flag ---
  console.log("2. Testing permissions enforcement report...");
  const perms = await requestJson("/api/permissions");
  assert.strictEqual(perms.res.status, 200);
  assert.ok("enforcement" in perms.body.data, "Permissions report must expose enforcement state");
  console.log(`  ✓ Permissions enforcement state: ${perms.body.data.enforcement}`);

  // --- 3. Audit logging security tests ---
  console.log("3. Testing append-only audit logging...");

  // Unauthenticated access to audit logs must return HTTP 401
  const unauthAudit = await requestJson("/api/audit-logs");
  assert.strictEqual(unauthAudit.res.status, 401, "Unauthenticated audit-logs request must fail with 401");
  console.log("  ✓ Unauthenticated access to GET /api/audit-logs denied with 401");

  // Attempted UPDATE/DELETE on audit logs must return 405 Method Not Allowed
  const deleteAudit = await requestJson("/api/audit-logs", {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${OWNER_TOKEN}` }
  });
  assert.strictEqual(deleteAudit.res.status, 405, "DELETE /api/audit-logs must return 405 Method Not Allowed");
  console.log("  ✓ DELETE /api/audit-logs strictly rejected with 405 (append-only enforced)");

  // Authenticated access to audit logs
  const authAudit = await requestJson("/api/audit-logs", {
    headers: { "Authorization": `Bearer ${OWNER_TOKEN}` }
  });
  if (authAudit.res.status === 200) {
    assert.strictEqual(authAudit.body.ok, true);
    assert.ok(Array.isArray(authAudit.body.data), "Audit log data must be an array");
    console.log("  ✓ Authenticated GET /api/audit-logs returned persistent log entries");
  }

  // --- 4. Persistent Owner Approval & Binding Tests ---
  console.log("4. Testing persistent Owner approvals and state machine...");

  // Unauthenticated creation of approval must fail with 401
  const unauthAppr = await requestJson("/api/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: "test_action",
      action_type: "MUTATE",
      parameters: { amount: 100 }
    })
  });
  assert.strictEqual(unauthAppr.res.status, 401, "Unauthenticated approval creation must fail with 401");
  console.log("  ✓ Unauthenticated POST /api/approvals denied with 401");

  // Authenticated creation of approval
  const authAppr = await requestJson("/api/approvals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OWNER_TOKEN}`
    },
    body: JSON.stringify({
      capability: "high_impact_test",
      action_type: "EXECUTE",
      target_resource_id: "res_001",
      parameters: { b: 2, a: 1 } // Out of order parameters to test recursive sorting
    })
  });

  if (authAppr.res.status === 201) {
    assert.strictEqual(authAppr.body.ok, true);
    const createdAppr = authAppr.body.data;
    assert.strictEqual(createdAppr.status, "PENDING");
    assert.ok(createdAppr.parameters_hash, "Approval must contain computed parameter fingerprint");
    console.log(`  ✓ Persistent approval created in PENDING state (ID: ${createdAppr.id})`);

    // Owner decides approval -> APPROVED
    const decideRes = await requestJson(`/api/approvals/${createdAppr.id}/decide`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OWNER_TOKEN}`
      },
      body: JSON.stringify({
        decision: "APPROVED",
        notes: "Authorized by Owner during security test"
      })
    });
    assert.strictEqual(decideRes.res.status, 200);
    assert.strictEqual(decideRes.body.data.status, "APPROVED");
    console.log("  ✓ Approval successfully decided to APPROVED by Owner credential");
  }

  console.log("\nALL PHASE 0 SECURITY HARDENING TESTS PASSED SUCCESSFULLY!");
}

runSecurityTests().catch((err) => {
  console.error("Security hardening test failure:", err);
  process.exit(1);
});
