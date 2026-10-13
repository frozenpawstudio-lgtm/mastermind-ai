import assert from "node:assert";

/*
 * Phase 1 Earning Workflow test suite.
 *
 * Covers the full earning pipeline (Research -> Discover -> Verify ->
 * Eligibility -> Owner Fit -> Compare -> Score -> Select -> Prepare ->
 * Request Approval -> Execute [manual, approval-gated] -> Verify Outcome ->
 * Track -> Follow up -> Learn/Improve), plus authorization boundaries,
 * failure modes and regression guards against fabricated state.
 *
 * Requires the local worker to be running with OWNER_API_TOKEN configured:
 *   npx wrangler dev --local --port 8787 --var OWNER_API_TOKEN:<token>
 *   OWNER_API_TOKEN=<token> node test/test_earning_workflow.js
 */

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN || "test-owner-secret-token";
const authHeaders = { Authorization: `Bearer ${OWNER_TOKEN}` };

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

async function createOpportunity(fields) {
  const { res, body } = await getJson("/api/opportunities", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ source: "test", title: "Earning workflow test opportunity", ...fields })
  });
  assert.strictEqual(res.status, 201, "Opportunity creation must return 201");
  return body.data;
}

async function addFact(opportunityId, content) {
  const { res } = await getJson(`/api/opportunities/${opportunityId}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ classification: "FACT", source: "test fixture", content })
  });
  assert.strictEqual(res.status, 201, "FACT evidence creation must return 201");
}

async function postWorkflow(opportunityId, body, withAuth = true) {
  return getJson(`/api/opportunities/${opportunityId}/workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(withAuth ? authHeaders : {}) },
    body: JSON.stringify(body)
  });
}

async function runEarningWorkflowTests() {
  console.log(`Starting Phase 1 Earning Workflow tests against ${BASE_URL}...`);

  // --- 1. Truthful empty workflow on a brand new opportunity --------------
  console.log("1. Testing truthful derived state for a new opportunity...");
  const fresh = await createOpportunity({ title: "Fresh opportunity", platform: "manual" });
  const freshWf = await getJson(`/api/opportunities/${fresh.id}/workflow`);
  assert.strictEqual(freshWf.res.status, 200, "Workflow GET must return 200");
  assert.strictEqual(freshWf.body.ok, true);
  const freshData = freshWf.body.data;
  assert.deepStrictEqual(
    freshData.completedStages,
    ["RESEARCH", "DISCOVER"],
    "A new opportunity must only have RESEARCH + DISCOVER completed"
  );
  assert.strictEqual(freshData.currentStage, "VERIFY", "A new opportunity must be at the VERIFY stage");
  assert.strictEqual(freshData.derivedState.verificationStatus, "UNVERIFIED");
  assert.strictEqual(freshData.derivedState.decision, "NEEDS_REVIEW");
  assert.strictEqual(freshData.tracking.executed, false);
  assert.strictEqual(freshData.truthfulness.runtimePerformedSubmission, false);
  assert.strictEqual(freshData.truthfulness.executionIsManualOwnerAction, true);
  console.log("  ✓ New opportunity truthfully stops at VERIFY (nothing fabricated)");

  // --- 2. Authorization: POST requires Owner credential, GET is public ----
  console.log("2. Testing workflow authorization boundaries...");
  const noAuthPost = await postWorkflow(fresh.id, { action: "mark_prepared" }, false);
  assert.strictEqual(noAuthPost.res.status, 401, "Workflow POST without token must return 401");
  assert.strictEqual(noAuthPost.body.action, "DENIED");
  const publicGet = await getJson(`/api/opportunities/${fresh.id}/workflow`);
  assert.strictEqual(publicGet.res.status, 200, "Workflow GET must be a public read");
  console.log("  ✓ POST is Owner-only (401); GET is a public read");

  // --- 3. Failure modes ---------------------------------------------------
  console.log("3. Testing workflow failure modes...");
  const unknownAction = await postWorkflow(fresh.id, { action: "frobnicate" });
  assert.strictEqual(unknownAction.res.status, 400, "Unknown workflow action must return 400");
  assert.match(unknownAction.body.error, /Unknown workflow action/);

  const badOutcome = await postWorkflow(fresh.id, { action: "record_outcome", outcome: "NOT_A_REAL_OUTCOME" });
  assert.strictEqual(badOutcome.res.status, 400, "Invalid outcome must return 400");

  const execNoApproval = await postWorkflow(fresh.id, { action: "record_execution" });
  assert.strictEqual(execNoApproval.res.status, 400, "Execution without approval_id must return 400");
  assert.match(execNoApproval.body.error, /approval_id is required/);

  const missingOpp = await getJson(`/api/opportunities/does-not-exist/workflow`);
  assert.strictEqual(missingOpp.res.status, 404, "Workflow for unknown opportunity must return 404");
  console.log("  ✓ Unknown action, invalid outcome, missing approval and missing opportunity all rejected");

  // --- 4. Full happy-path pipeline ---------------------------------------
  console.log("4. Testing the full earning pipeline...");
  const opp = await createOpportunity({ title: "Zero-investment affiliate program", platform: "manual", category: "affiliate_referral" });
  await addFact(opp.id, "Eligible: verified account and verified location. Owner fit confirmed: skills match verified.");

  await getJson(`/api/opportunities/${opp.id}/verify`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ status: "VERIFIED" })
  });
  await getJson(`/api/opportunities/${opp.id}/eligibility`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({})
  });
  await getJson(`/api/opportunities/${opp.id}/owner-fit`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({})
  });
  const decision = await getJson(`/api/opportunities/${opp.id}/decision`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({})
  });
  assert.strictEqual(decision.body.data.decision, "SELECT", "Engine must reach SELECT for a fully satisfied opportunity");

  const afterEval = await getJson(`/api/opportunities/${opp.id}/workflow`);
  for (const stage of ["VERIFY", "ELIGIBILITY", "OWNER_FIT", "COMPARE", "SCORE", "SELECT"]) {
    assert.ok(afterEval.body.data.completedStages.includes(stage), `Stage ${stage} must be completed after evaluation`);
  }
  assert.strictEqual(afterEval.body.data.currentStage, "PREPARE");
  assert.strictEqual(afterEval.body.data.category, "affiliate_referral", "Category set at create must persist");
  console.log("  ✓ Evaluation stages derived correctly; category persisted");

  // --- 5. Manual Owner progression ---------------------------------------
  console.log("5. Testing manual Owner progression...");
  const prepared = await postWorkflow(opp.id, { action: "mark_prepared" });
  assert.ok(prepared.body.data.completedStages.includes("PREPARE"));
  assert.strictEqual(prepared.body.data.currentStage, "REQUEST_APPROVAL");

  const approval = await postWorkflow(opp.id, { action: "request_approval" });
  const approvalId = approval.body.data.tracking.approvalId;
  assert.ok(approvalId, "request_approval must create an approval request");
  assert.strictEqual(approval.body.data.tracking.approvalStatus, "PENDING");

  // Execution must be blocked while the approval is still PENDING.
  const pendingExec = await postWorkflow(opp.id, { action: "record_execution", approval_id: approvalId });
  assert.strictEqual(pendingExec.res.status, 400, "Execution with a PENDING approval must be rejected");
  assert.match(pendingExec.body.error, /APPROVED/);

  // Owner approves, then execution can be recorded.
  const decide = await getJson(`/api/approvals/${approvalId}/decide`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ decision: "APPROVED" })
  });
  assert.strictEqual(decide.body.data.status, "APPROVED");

  const executed = await postWorkflow(opp.id, { action: "record_execution", approval_id: approvalId, note: "Submitted manually" });
  assert.strictEqual(executed.body.data.tracking.executed, true);
  assert.strictEqual(executed.body.data.tracking.approvalStatus, "CONSUMED");
  assert.ok(executed.body.data.completedStages.includes("EXECUTE"));
  assert.strictEqual(executed.body.data.currentStage, "VERIFY_OUTCOME");

  // A single-use approval cannot authorise a second execution.
  const reuse = await postWorkflow(opp.id, { action: "record_execution", approval_id: approvalId });
  assert.strictEqual(reuse.res.status, 400, "A consumed approval must not authorise a second execution");
  console.log("  ✓ Prepare -> Request Approval -> approve -> Execute (manual) enforced with single-use approval");

  // --- 6. Outcome verification honesty -----------------------------------
  console.log("6. Testing outcome verification honesty...");
  const unverified = await postWorkflow(opp.id, { action: "record_outcome", outcome: "SUBMITTED_MANUAL" });
  assert.strictEqual(unverified.body.data.tracking.outcome, "SUBMITTED_MANUAL");
  assert.strictEqual(unverified.body.data.tracking.outcomeVerified, false, "An unverified outcome must not claim verification");

  const fakeVerify = await postWorkflow(opp.id, { action: "record_outcome", outcome: "SUBMITTED_MANUAL", verified: true });
  assert.strictEqual(fakeVerify.res.status, 400, "Verifying an outcome without evidence must be rejected");
  assert.match(fakeVerify.body.error, /evidence/);

  const verifiedOutcome = await postWorkflow(opp.id, { action: "record_outcome", outcome: "SUBMITTED_MANUAL", verified: true, evidence: "Client replied confirming receipt" });
  assert.strictEqual(verifiedOutcome.body.data.tracking.outcomeVerified, true);
  assert.strictEqual(verifiedOutcome.body.data.currentStage, "FOLLOW_UP");
  console.log("  ✓ Outcome cannot be marked verified without evidence");

  // --- 7. Follow-up, learning and full completion ------------------------
  console.log("7. Testing follow-up, learning and completion...");
  const followUp = await postWorkflow(opp.id, { action: "record_follow_up", note: "Followed up after 3 days" });
  assert.strictEqual(followUp.body.data.currentStage, "LEARN_IMPROVE");

  const lesson = await postWorkflow(opp.id, { action: "record_lesson", lesson: "Short proposals convert better" });
  assert.strictEqual(lesson.body.data.tracking.learned, true);
  assert.strictEqual(lesson.body.data.progress.completed, lesson.body.data.progress.total, "All stages must be completed");
  assert.strictEqual(lesson.body.data.progress.percent, 100);
  assert.ok(lesson.body.data.history.length >= 7, "Workflow history must record each progression");
  console.log("  ✓ Full pipeline reaches 100% with an auditable history");

  // --- 8. Regression: engine-owned state cannot be fabricated ------------
  console.log("8. Testing regression guards...");
  const rejectOpp = await createOpportunity({ title: "No evidence opportunity" });
  const rejectDecision = await getJson(`/api/opportunities/${rejectOpp.id}/decision`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({})
  });
  assert.notStrictEqual(rejectDecision.body.data.decision, "SELECT", "An opportunity without evidence must never reach SELECT");
  const rejectWf = await getJson(`/api/opportunities/${rejectOpp.id}/workflow`);
  assert.ok(!rejectWf.body.data.completedStages.includes("SELECT"), "SELECT must not be fabricated for an unverified opportunity");
  console.log("  ✓ Unverified opportunities cannot be shown as SELECTED");

  console.log("\nAll Phase 1 Earning Workflow tests passed.");
}

runEarningWorkflowTests().catch((err) => {
  console.error("Phase 1 Earning Workflow tests FAILED:", err);
  process.exit(1);
});
