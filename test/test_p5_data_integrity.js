import assert from "node:assert";

/*
 * P5 data-integrity tests.
 *
 * P5-01: ELIGIBLE / FIT may never be persisted without FACT evidence.
 * P5-02: mutating evidence recomputes the complete deterministic chain
 *        (verification -> eligibility -> owner fit -> score -> decision) so
 *        that no stale ELIGIBLE / FIT / score / SELECT state survives a
 *        deletion. The chain used is the existing engine's; the fallback state
 *        it derives is asserted as-is, not redefined here.
 *
 * The suite mirrors a real authorized Owner client: when OWNER_API_TOKEN is
 * configured the permission foundation enforces it, so the owner credential is
 * presented on mutations (exactly as test_v9_foundations.js does).
 *
 * The worker must be running locally (see README).
 */

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN;

async function getJson(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

const authHeaders = OWNER_TOKEN ? { Authorization: `Bearer ${OWNER_TOKEN}` } : {};

function postJson(path, payload) {
  return getJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload)
  });
}

function patchJson(path, payload) {
  return getJson(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload)
  });
}

function del(path) {
  return getJson(path, { method: "DELETE", headers: authHeaders });
}

function state(opp) {
  return {
    verification_status: opp.verification_status,
    eligibility_status: opp.eligibility_status,
    owner_fit_status: opp.owner_fit_status,
    score: opp.score,
    decision: opp.decision
  };
}

async function runP5DataIntegrityTests() {
  console.log(`Starting P5 data-integrity tests against ${BASE_URL}...`);

  const health = await getJson("/api/health");
  assert.strictEqual(health.res.status, 200, "Health check failed");
  console.log(`✓ Health check passed (authorization: ${health.body.authorization})`);

  // --- P5-01: create cannot persist ELIGIBLE / FIT without FACT ------------
  console.log("\n--- P5-01: create cannot persist ELIGIBLE/FIT without FACT evidence ---");
  const created = await postJson("/api/opportunities", {
    source: "p5_test",
    title: `P5 create fallback ${Date.now()}`,
    eligibility_status: "eligible",
    owner_fit_status: "fit"
  });
  assert.strictEqual(created.res.status, 201, "Create must respond 201");
  const opp = created.body.data;
  assert.strictEqual(opp.eligibility_status, "UNKNOWN", "ELIGIBLE must fall back to UNKNOWN without FACT evidence");
  assert.strictEqual(opp.owner_fit_status, "UNKNOWN", "FIT must fall back to UNKNOWN without FACT evidence");
  assert.strictEqual(opp.verification_status, "UNVERIFIED", "Create remains UNVERIFIED");
  assert.strictEqual(opp.score, 0, "Create cannot invent a score");
  assert.strictEqual(opp.decision, "NEEDS_REVIEW", "Create cannot invent a decision");
  const oppId = opp.id;

  // --- P5-01: PATCH rejects ELIGIBLE / FIT without FACT --------------------
  console.log("\n--- P5-01: PATCH rejects ELIGIBLE/FIT without FACT evidence ---");
  const patchEligible = await patchJson(`/api/opportunities/${oppId}`, { eligibility_status: "eligible" });
  assert.strictEqual(patchEligible.res.status, 400, "PATCH ELIGIBLE without FACT must be rejected");
  assert.ok(
    String(patchEligible.body.error).includes("without at least one FACT evidence record"),
    "Rejection must cite the missing FACT evidence"
  );

  const patchFit = await patchJson(`/api/opportunities/${oppId}`, { owner_fit_status: "fit" });
  assert.strictEqual(patchFit.res.status, 400, "PATCH FIT without FACT must be rejected");
  assert.ok(
    String(patchFit.body.error).includes("without at least one FACT evidence record"),
    "Rejection must cite the missing FACT evidence"
  );

  // UNKNOWN remains a legal, honest write.
  const patchUnknown = await patchJson(`/api/opportunities/${oppId}`, {
    eligibility_status: "unknown",
    owner_fit_status: "unknown"
  });
  assert.strictEqual(patchUnknown.res.status, 200, "PATCH to UNKNOWN must be allowed");
  assert.strictEqual(patchUnknown.body.data.eligibility_status, "UNKNOWN", "UNKNOWN remains UNKNOWN");
  assert.strictEqual(patchUnknown.body.data.owner_fit_status, "UNKNOWN", "UNKNOWN remains UNKNOWN");
  console.log("✓ Create/PATCH ELIGIBLE+FIT gating and UNKNOWN preservation passed");

  // --- P5-02: evidence create recomputes the full chain --------------------
  console.log("\n--- P5-02: evidence create recomputes verification -> eligibility -> owner fit -> score -> decision ---");
  const evidence = await postJson(`/api/opportunities/${oppId}/evidence`, {
    classification: "FACT",
    source: "p5_test",
    content: "Client payment verified, location eligible confirmed, owner fit confirmed"
  });
  assert.strictEqual(evidence.res.status, 201, "FACT evidence create must respond 201");

  const afterCreate = await getJson(`/api/opportunities/${oppId}`);
  const createdState = state(afterCreate.body.data);
  assert.strictEqual(createdState.verification_status, "VERIFIED", "FACT evidence must drive VERIFIED");
  assert.strictEqual(createdState.eligibility_status, "ELIGIBLE", "Chain must recompute eligibility to ELIGIBLE");
  assert.strictEqual(createdState.owner_fit_status, "FIT", "Chain must recompute owner fit to FIT");
  assert.strictEqual(createdState.score, 100, "Chain must recompute the score");
  assert.strictEqual(createdState.decision, "SELECT", "Chain must recompute the decision to SELECT");
  console.log("✓ Evidence create recomputed the complete chain:", JSON.stringify(createdState));

  // --- P5-02: evidence delete recomputes and clears stale positive state ---
  console.log("\n--- P5-02: evidence delete recomputes the chain and clears stale positive state ---");
  const evidenceId = evidence.body.data.id;
  const deleted = await del(`/api/evidence/${evidenceId}`);
  assert.strictEqual(deleted.res.status, 200, "Evidence delete must respond 200");

  const afterDelete = await getJson(`/api/opportunities/${oppId}`);
  const deletedState = state(afterDelete.body.data);
  // The existing engine's deterministic fallback, asserted as-is.
  assert.strictEqual(deletedState.verification_status, "UNVERIFIED", "Deletion must return verification to UNVERIFIED");
  assert.notStrictEqual(deletedState.eligibility_status, "ELIGIBLE", "No stale ELIGIBLE may survive deletion");
  assert.notStrictEqual(deletedState.owner_fit_status, "FIT", "No stale FIT may survive deletion");
  assert.notStrictEqual(deletedState.decision, "SELECT", "No stale SELECT may survive deletion");
  assert.notStrictEqual(deletedState.score, 100, "Score must be recomputed, not left stale");
  assert.strictEqual(deletedState.eligibility_status, "POTENTIALLY_ELIGIBLE", "Engine fallback is POTENTIALLY_ELIGIBLE");
  assert.strictEqual(deletedState.owner_fit_status, "POTENTIAL_FIT", "Engine fallback is POTENTIAL_FIT");
  assert.strictEqual(deletedState.score, 30, "Engine recomputes the fallback score");
  assert.strictEqual(deletedState.decision, "NEEDS_REVIEW", "Fallback decision is NEEDS_REVIEW");
  console.log("✓ Evidence delete cleared stale positive state:", JSON.stringify(deletedState));

  // Persisted read state must match a fresh derived evaluation.
  const reevaluated = await getJson(`/api/opportunities/${oppId}/decision`);
  assert.strictEqual(reevaluated.res.status, 200, "Decision re-evaluation must respond 200");
  const derived = reevaluated.body.data;
  assert.strictEqual(derived.decision, deletedState.decision, "Persisted decision must match derived decision");
  assert.strictEqual(derived.score, deletedState.score, "Persisted score must match derived score");
  console.log("✓ Persisted and derived decision state are consistent");

  // --- Partial deletion keeps the chain honest -----------------------------
  console.log("\n--- P5-02: partial evidence deletion keeps the chain consistent ---");
  const factA = await postJson(`/api/opportunities/${oppId}/evidence`, {
    classification: "FACT",
    source: "p5_test",
    content: "Verified contract offer"
  });
  const factB = await postJson(`/api/opportunities/${oppId}/evidence`, {
    classification: "FACT",
    source: "p5_test",
    content: "Verified identity document"
  });
  assert.strictEqual(factA.res.status, 201);
  assert.strictEqual(factB.res.status, 201);

  await del(`/api/evidence/${factA.body.data.id}`);
  const afterPartialDelete = await getJson(`/api/opportunities/${oppId}`);
  assert.strictEqual(afterPartialDelete.body.data.verification_status, "VERIFIED", "One FACT record still remains");

  // Removing the last FACT record must clear the positive verdicts again.
  await del(`/api/evidence/${factB.body.data.id}`);
  const afterFullDelete = await getJson(`/api/opportunities/${oppId}`);
  assert.notStrictEqual(afterFullDelete.body.data.eligibility_status, "ELIGIBLE", "No FACT records left, so ELIGIBLE must clear");
  assert.notStrictEqual(afterFullDelete.body.data.owner_fit_status, "FIT", "No FACT records left, so FIT must clear");
  console.log("✓ Partial/full evidence deletion recomputed the chain correctly");

  // --- Cleanup -------------------------------------------------------------
  await del(`/api/opportunities/${oppId}`);

  console.log("\nALL P5 DATA INTEGRITY TESTS PASSED SUCCESSFULLY!");
}

runP5DataIntegrityTests().catch((err) => {
  console.error("P5 data-integrity test failure:", err);
  process.exit(1);
});