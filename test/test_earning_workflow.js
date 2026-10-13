import assert from "node:assert";

/*
 * Phase 1 Earning Workflow test suite.
 *
 * Covers the full earning pipeline (Research -> Discover -> Verify ->
 * Eligibility -> Owner Fit -> Compare -> Score -> Select -> Prepare ->
 * Request Approval -> Execute [manual, approval-gated] -> Verify Outcome ->
 * Track -> Follow up -> Learn/Improve), plus server-enforced transition
 * ordering, authorization boundaries, approval security (mismatch, expiry,
 * single-use replay), evidence honesty (Owner attestation vs independent
 * verification) and regression guards against fabricated state.
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

// Drive an opportunity to a deterministic SELECT using the existing engine.
async function evaluateToSelect(opportunityId) {
  await addFact(opportunityId, "Eligible: verified account and verified location. Owner fit confirmed: skills match verified.");
  await getJson(`/api/opportunities/${opportunityId}/verify`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ status: "VERIFIED" })
  });
  await getJson(`/api/opportunities/${opportunityId}/eligibility`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({})
  });
  await getJson(`/api/opportunities/${opportunityId}/owner-fit`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({})
  });
  const decision = await getJson(`/api/opportunities/${opportunityId}/decision`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({})
  });
  return decision.body.data.decision;
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
  assert.strictEqual(freshData.blocked, false, "A fresh opportunity must not be blocked");
  assert.strictEqual(freshData.derivedState.verificationStatus, "UNVERIFIED");
  assert.strictEqual(freshData.derivedState.decision, "NEEDS_REVIEW");
  assert.strictEqual(freshData.tracking.executed, false);
  assert.strictEqual(freshData.tracking.outcomeVerified, false);
  assert.strictEqual(freshData.tracking.independentlyVerified, false, "Nothing may be independently verified by default");
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

  // --- 3. Server-enforced ordering on a fresh opportunity -----------------
  console.log("3. Testing server-enforced transition ordering (fresh opportunity)...");

  const prepBeforeSelect = await postWorkflow(fresh.id, { action: "mark_prepared" });
  assert.strictEqual(prepBeforeSelect.res.status, 400, "Preparation before a SELECT decision must be rejected");
  assert.match(prepBeforeSelect.body.error, /SELECT/);

  const approvalBeforePrep = await postWorkflow(fresh.id, { action: "request_approval" });
  assert.strictEqual(approvalBeforePrep.res.status, 400, "Approval request before preparation/SELECT must be rejected");
  assert.match(approvalBeforePrep.body.error, /SELECT|preparation/);

  const execBeforePrep = await postWorkflow(fresh.id, { action: "record_execution", approval_id: "x" });
  assert.strictEqual(execBeforePrep.res.status, 400, "Execution before preparation must be rejected");
  assert.match(execBeforePrep.body.error, /preparation|SELECT/);

  const outcomeBeforeExec = await postWorkflow(fresh.id, { action: "record_outcome", outcome: "SUBMITTED_MANUAL" });
  assert.strictEqual(outcomeBeforeExec.res.status, 400, "Outcome before a valid execution record must be rejected");
  assert.match(outcomeBeforeExec.body.error, /execution/);

  const followUpTooEarly = await postWorkflow(fresh.id, { action: "record_follow_up", note: "too early" });
  assert.strictEqual(followUpTooEarly.res.status, 400, "Follow-up before an outcome must be rejected");
  assert.match(followUpTooEarly.body.error, /outcome|TRACK/);

  const lessonTooEarly = await postWorkflow(fresh.id, { action: "record_lesson", lesson: "too early" });
  assert.strictEqual(lessonTooEarly.res.status, 400, "Lesson before a follow-up must be rejected");
  assert.match(lessonTooEarly.body.error, /follow-up|FOLLOW_UP/);

  const unknownAction = await postWorkflow(fresh.id, { action: "frobnicate" });
  assert.strictEqual(unknownAction.res.status, 400, "Unknown workflow action must return 400");
  assert.match(unknownAction.body.error, /Unknown workflow action/);

  const missingOpp = await getJson(`/api/opportunities/does-not-exist/workflow`);
  assert.strictEqual(missingOpp.res.status, 404, "Workflow for unknown opportunity must return 404");

  // A rejected transition must not have advanced the workflow.
  const freshAfter = await getJson(`/api/opportunities/${fresh.id}/workflow`);
  assert.strictEqual(freshAfter.body.data.currentStage, "VERIFY", "Rejected transitions must not advance the workflow");
  assert.strictEqual(freshAfter.body.data.tracking.prepared, false);
  console.log("  ✓ Preparation/approval/execution/outcome/follow-up/lesson all fail-closed before their prerequisites");

  // --- 4. REJECT is a decision, never a completed SELECT ------------------
  console.log("4. Testing REJECT decision handling...");
  const rejectOpp = await createOpportunity({ title: "Rejected opportunity" });
  await getJson(`/api/opportunities/${rejectOpp.id}/verify`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ status: "REJECTED" })
  });
  const rejectDecision = await getJson(`/api/opportunities/${rejectOpp.id}/decision`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({})
  });
  assert.strictEqual(rejectDecision.body.data.decision, "REJECT", "A disqualified opportunity must evaluate to REJECT");

  const rejectWf = await getJson(`/api/opportunities/${rejectOpp.id}/workflow`);
  const rejectData = rejectWf.body.data;
  assert.ok(!rejectData.completedStages.includes("SELECT"), "REJECT must NEVER count as a completed SELECT");
  assert.ok(rejectData.completedStages.includes("COMPARE"), "COMPARE is completed by evaluation");
  assert.ok(rejectData.completedStages.includes("SCORE"), "SCORE is completed by evaluation");
  assert.strictEqual(rejectData.blocked, true, "A rejected opportunity must be marked blocked");
  assert.strictEqual(rejectData.derivedState.decision, "REJECT");

  const rejectPrep = await postWorkflow(rejectOpp.id, { action: "mark_prepared" });
  assert.strictEqual(rejectPrep.res.status, 400, "A rejected opportunity must not be prepared");
  assert.match(rejectPrep.body.error, /REJECT/);

  const rejectApproval = await postWorkflow(rejectOpp.id, { action: "request_approval" });
  assert.strictEqual(rejectApproval.res.status, 400, "A rejected opportunity must not request approval");
  console.log("  ✓ REJECT never counts as SELECT and cannot proceed to preparation/approval");

  // --- 5. Full happy-path pipeline ---------------------------------------
  console.log("5. Testing the full earning pipeline...");
  const opp = await createOpportunity({ title: "Zero-investment affiliate program", platform: "manual", category: "affiliate_referral" });
  const decision = await evaluateToSelect(opp.id);
  assert.strictEqual(decision, "SELECT", "Engine must reach SELECT for a fully satisfied opportunity");

  const afterEval = await getJson(`/api/opportunities/${opp.id}/workflow`);
  for (const stage of ["VERIFY", "ELIGIBILITY", "OWNER_FIT", "COMPARE", "SCORE", "SELECT"]) {
    assert.ok(afterEval.body.data.completedStages.includes(stage), `Stage ${stage} must be completed after evaluation`);
  }
  assert.strictEqual(afterEval.body.data.currentStage, "PREPARE");
  assert.strictEqual(afterEval.body.data.category, "affiliate_referral", "Category set at create must persist");
  assert.strictEqual(afterEval.body.data.blocked, false);
  console.log("  ✓ Evaluation stages derived correctly; category persisted");

  // --- 6. Manual Owner progression ---------------------------------------
  console.log("6. Testing manual Owner progression...");
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

  // --- 7. Outcome + evidence honesty -------------------------------------
  console.log("7. Testing outcome and evidence honesty...");

  // SELECT is a decision, not a terminal outcome.
  const selectOutcome = await postWorkflow(opp.id, { action: "record_outcome", outcome: "SELECT" });
  assert.strictEqual(selectOutcome.res.status, 400, "SELECT must not be accepted as a terminal outcome");
  assert.match(selectOutcome.body.error, /Invalid outcome/);

  const unverified = await postWorkflow(opp.id, { action: "record_outcome", outcome: "SUBMITTED_MANUAL" });
  assert.strictEqual(unverified.body.data.tracking.outcome, "SUBMITTED_MANUAL");
  assert.strictEqual(unverified.body.data.tracking.outcomeVerified, false, "An unverified outcome must not claim verification");
  assert.strictEqual(unverified.body.data.tracking.outcomeEvidenceStatus, "NOT_INDEPENDENTLY_VERIFIED");

  // The Owner cannot self-assert independent verification.
  const fakeVerify = await postWorkflow(opp.id, { action: "record_outcome", outcome: "SUBMITTED_MANUAL", verified: true, evidence: "owner typed this" });
  assert.strictEqual(fakeVerify.res.status, 400, "Owner text must never be recorded as independent verification");
  assert.match(fakeVerify.body.error, /independent|attestation|NOT_INDEPENDENTLY_VERIFIED/i);

  // Owner-entered evidence is recorded as an attestation, never as verification.
  const attested = await postWorkflow(opp.id, { action: "record_outcome", outcome: "SUBMITTED_MANUAL", evidence: "Client replied confirming receipt" });
  assert.strictEqual(attested.body.data.tracking.outcomeVerified, false, "Owner attestation must not set verified=true");
  assert.strictEqual(attested.body.data.tracking.independentlyVerified, false);
  assert.strictEqual(attested.body.data.tracking.outcomeEvidenceStatus, "OWNER_ATTESTED");
  assert.strictEqual(attested.body.data.currentStage, "FOLLOW_UP");
  console.log("  ✓ Owner evidence is an attestation; independent verification is never self-asserted");

  // --- 8. Follow-up, learning and full completion ------------------------
  console.log("8. Testing follow-up, learning and completion...");
  const followUp = await postWorkflow(opp.id, { action: "record_follow_up", note: "Followed up after 3 days" });
  assert.strictEqual(followUp.body.data.currentStage, "LEARN_IMPROVE");

  const lesson = await postWorkflow(opp.id, { action: "record_lesson", lesson: "Short proposals convert better" });
  assert.strictEqual(lesson.body.data.tracking.learned, true);
  assert.strictEqual(lesson.body.data.progress.completed, lesson.body.data.progress.total, "All stages must be completed");
  assert.strictEqual(lesson.body.data.progress.percent, 100);
  assert.ok(lesson.body.data.history.length >= 7, "Workflow history must record each progression");
  assert.strictEqual(lesson.body.data.historyTruncated, false, "A short history must not be reported as truncated");
  console.log("  ✓ Full pipeline reaches 100% with an auditable history");

  // --- 9. Approval security: mismatch, expiry, replay --------------------
  console.log("9. Testing approval security (mismatch / expiry / replay)...");

  // Mismatched opportunity: an approval for A must not authorise execution on B.
  const oppA = await createOpportunity({ title: "Approval owner A" });
  await evaluateToSelect(oppA.id);
  await postWorkflow(oppA.id, { action: "mark_prepared" });
  const approvalA = await postWorkflow(oppA.id, { action: "request_approval" });
  const approvalAId = approvalA.body.data.tracking.approvalId;
  await getJson(`/api/approvals/${approvalAId}/decide`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({ decision: "APPROVED" })
  });

  const oppB = await createOpportunity({ title: "Approval owner B" });
  await evaluateToSelect(oppB.id);
  await postWorkflow(oppB.id, { action: "mark_prepared" });
  const crossExec = await postWorkflow(oppB.id, { action: "record_execution", approval_id: approvalAId });
  assert.strictEqual(crossExec.res.status, 400, "An approval for another opportunity must not authorise execution");
  assert.match(crossExec.body.error, /does not belong|mismatch/i);

  // Consume approval A on its rightful opportunity, then prove it is single-use.
  const execA = await postWorkflow(oppA.id, { action: "record_execution", approval_id: approvalAId });
  assert.strictEqual(execA.body.data.tracking.approvalStatus, "CONSUMED", "A used approval must be CONSUMED");
  const approvalAAfter = await getJson(`/api/approvals/${approvalAId}`, { headers: authHeaders });
  assert.strictEqual(approvalAAfter.body.data.status, "CONSUMED", "The approval record must reflect single-use consumption");
  const replayExec = await postWorkflow(oppA.id, { action: "record_execution", approval_id: approvalAId });
  assert.strictEqual(replayExec.res.status, 400, "A consumed approval must remain unusable (no replay)");

  // Expired approval: an APPROVED approval past its expiry must not authorise execution.
  const oppC = await createOpportunity({ title: "Approval expiry C" });
  await evaluateToSelect(oppC.id);
  await postWorkflow(oppC.id, { action: "mark_prepared" });
  const expiringApproval = await getJson("/api/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      capability: "external_platform_execution",
      action_type: "SUBMIT",
      target_resource_id: oppC.id,
      parameters: { opportunity_id: oppC.id, title: "Approval expiry C" },
      expires_at: new Date(Date.now() + 5000).toISOString()
    })
  });
  assert.strictEqual(expiringApproval.res.status, 201, "Direct approval creation must return 201");
  const expiringId = expiringApproval.body.data.id;
  const decideExpiring = await getJson(`/api/approvals/${expiringId}/decide`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({ decision: "APPROVED" })
  });
  assert.strictEqual(decideExpiring.body.data.status, "APPROVED", "The approval must be approved before it expires");
  await new Promise((resolve) => setTimeout(resolve, 5500));
  const expiredExec = await postWorkflow(oppC.id, { action: "record_execution", approval_id: expiringId });
  assert.strictEqual(expiredExec.res.status, 400, "An expired approval must not authorise execution");
  assert.match(expiredExec.body.error, /EXPIRED/i);
  console.log("  ✓ Mismatched, expired and replayed approvals are all rejected");

  // --- 10. Regression: engine-owned state cannot be fabricated -----------
  console.log("10. Testing regression guards...");
  const rejectOpp2 = await createOpportunity({ title: "No evidence opportunity" });
  const rejectDecision2 = await getJson(`/api/opportunities/${rejectOpp2.id}/decision`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({})
  });
  assert.notStrictEqual(rejectDecision2.body.data.decision, "SELECT", "An opportunity without evidence must never reach SELECT");
  const rejectWf2 = await getJson(`/api/opportunities/${rejectOpp2.id}/workflow`);
  assert.ok(!rejectWf2.body.data.completedStages.includes("SELECT"), "SELECT must not be fabricated for an unverified opportunity");
  console.log("  ✓ Unverified opportunities cannot be shown as SELECTED");

  console.log("\nAll Phase 1 Earning Workflow tests passed.");
}

runEarningWorkflowTests().catch((err) => {
  console.error("Phase 1 Earning Workflow tests FAILED:", err);
  process.exit(1);
});
