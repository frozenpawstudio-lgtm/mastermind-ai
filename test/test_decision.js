import assert from "node:assert";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";

async function runDecisionEngineTests() {
  console.log(`Starting Earning Decision Engine API tests against ${BASE_URL}...`);

  // 1. Health check
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  assert.strictEqual(healthRes.status, 200, "Health check failed");
  console.log("✓ Health check passed");

  // TEST SCENARIO 1: Strong verified opportunity -> SELECT
  console.log("\n--- Scenario 1: Strong verified opportunity -> SELECT ---");
  const strongOppRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "upwork",
      title: "Senior Full-Stack Cloudflare Engineer Needed",
      url: "https://upwork.com/jobs/strong-1",
      platform: "Upwork",
      description: "Build robust Cloudflare Agent with Durable Objects",
      eligibility_status: "eligible",
      owner_fit_status: "fit"
    })
  });
  assert.strictEqual(strongOppRes.status, 201);
  const strongOpp = (await strongOppRes.json()).data;

  // Add FACT evidence to enable VERIFIED status
  const factEvidenceRes = await fetch(`${BASE_URL}/api/opportunities/${strongOpp.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "FACT",
      source: "platform_api",
      content: "Client payment verified, 100% hire rate, verified contract ID 99201"
    })
  });
  assert.strictEqual(factEvidenceRes.status, 201);

  // P5-01: a create payload cannot persist ELIGIBLE/FIT without FACT evidence,
  // so the positive verdicts are asserted after FACT evidence exists, through
  // the dedicated eligibility / owner-fit endpoints.
  await fetch(`${BASE_URL}/api/opportunities/${strongOpp.id}/eligibility`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "ELIGIBLE" })
  });
  await fetch(`${BASE_URL}/api/opportunities/${strongOpp.id}/owner-fit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "FIT" })
  });

  // Evaluate decision
  const strongDecisionRes = await fetch(`${BASE_URL}/api/opportunities/${strongOpp.id}/decision`, { method: "POST" });
  assert.strictEqual(strongDecisionRes.status, 200);
  const strongDecisionJson = await strongDecisionRes.json();
  assert.strictEqual(strongDecisionJson.ok, true);
  const strongDec = strongDecisionJson.data;

  assert.strictEqual(strongDec.decision, "SELECT", "Strong verified opportunity must be SELECT");
  assert.strictEqual(strongDec.score, 100, "Strong verified score must be 100");
  assert.strictEqual(strongDec.verificationStatus, "VERIFIED");
  assert.strictEqual(strongDec.unknowns.length, 0, "Strong opportunity should have 0 unknowns");
  assert.ok(strongDec.reasons.length > 0, "Reasons should explain decision");
  console.log("✓ Strong verified opportunity correctly evaluated to SELECT (Score: 100)");

  // TEST SCENARIO 2: Clearly unsuitable/rejected opportunity -> REJECT
  console.log("\n--- Scenario 2: Unsuitable / rejected opportunity -> REJECT ---");
  const rejectedOppRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "spam",
      title: "Unfit Malicious Task",
      eligibility_status: "ineligible",
      owner_fit_status: "unfit"
    })
  });
  const rejectedOpp = (await rejectedOppRes.json()).data;

  const rejectedDecisionRes = await fetch(`${BASE_URL}/api/opportunities/${rejectedOpp.id}/decision`, { method: "POST" });
  assert.strictEqual(rejectedDecisionRes.status, 200);
  const rejectedDec = (await rejectedDecisionRes.json()).data;

  assert.strictEqual(rejectedDec.decision, "REJECT", "Ineligible/unfit opportunity must be REJECT");
  assert.strictEqual(rejectedDec.score, 0, "Score should be 0");
  assert.ok(rejectedDec.reasons.some(r => r.includes("ineligible") || r.includes("unfit") || r.includes("REJECT")), "Reasons must explain rejection");
  console.log("✓ Unsuitable opportunity correctly evaluated to REJECT");

  // TEST SCENARIO 3: Missing critical information -> NEEDS_REVIEW
  console.log("\n--- Scenario 3: Missing critical information -> NEEDS_REVIEW ---");
  const missingInfoOppRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "inbound",
      title: "Unclear Consulting Inquiry",
      eligibility_status: "pending",
      owner_fit_status: "pending"
    })
  });
  const missingInfoOpp = (await missingInfoOppRes.json()).data;

  const missingDecisionRes = await fetch(`${BASE_URL}/api/opportunities/${missingInfoOpp.id}/decision`, { method: "POST" });
  assert.strictEqual(missingDecisionRes.status, 200);
  const missingDec = (await missingDecisionRes.json()).data;

  assert.strictEqual(missingDec.decision, "NEEDS_REVIEW", "Missing info opportunity must evaluate to NEEDS_REVIEW");
  assert.ok(missingDec.unknowns.length > 0, "Unknowns list must document missing information");
  console.log("✓ Missing info opportunity correctly evaluated to NEEDS_REVIEW with unknowns documented");

  // TEST SCENARIO 4: Unverified opportunity cannot receive a false VERIFIED state
  console.log("\n--- Scenario 4: Truth Rule: Unverified cannot receive false VERIFIED status ---");
  const falseVerifyRes = await fetch(`${BASE_URL}/api/opportunities/${missingInfoOpp.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verification_status: "VERIFIED" })
  });
  assert.strictEqual(falseVerifyRes.status, 400, "Direct status change to VERIFIED without FACT evidence must fail");
  console.log("✓ Setting VERIFIED status without evidence rejected properly");

  // TEST SCENARIO 5: Assumption-only evidence does not become VERIFIED
  console.log("\n--- Scenario 5: Assumption-only evidence does not become VERIFIED ---");
  const assumptionOppRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "blog",
      title: "Potential Freelance Gig",
      eligibility_status: "eligible",
      owner_fit_status: "fit"
    })
  });
  const assumptionOpp = (await assumptionOppRes.json()).data;

  const addAssumptionRes = await fetch(`${BASE_URL}/api/opportunities/${assumptionOpp.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "ASSUMPTION",
      source: "client_profile_guess",
      content: "Assume client has budget based on company size"
    })
  });
  assert.strictEqual(addAssumptionRes.status, 201);

  const assumptionDecRes = await fetch(`${BASE_URL}/api/opportunities/${assumptionOpp.id}/decision`, { method: "POST" });
  const assumptionDec = (await assumptionDecRes.json()).data;
  assert.strictEqual(assumptionDec.verificationStatus, "PARTIALLY_VERIFIED");
  assert.notStrictEqual(assumptionDec.verificationStatus, "VERIFIED", "Assumption-only evidence must NOT yield VERIFIED status");
  assert.strictEqual(assumptionDec.decision, "NEEDS_REVIEW", "Assumption-only evidence must not evaluate to SELECT");
  console.log("✓ Assumption-only evidence evaluates to PARTIALLY_VERIFIED / NEEDS_REVIEW (not VERIFIED/SELECT)");

  // TEST SCENARIO 6: Hypothesis-only evidence does not become VERIFIED
  console.log("\n--- Scenario 6: Hypothesis-only evidence does not become VERIFIED ---");
  const hypothesisOppRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "forum",
      title: "Hypothetical Project Opportunity",
      eligibility_status: "eligible",
      owner_fit_status: "fit"
    })
  });
  const hypothesisOpp = (await hypothesisOppRes.json()).data;

  await fetch(`${BASE_URL}/api/opportunities/${hypothesisOpp.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "HYPOTHESIS",
      source: "forum_post",
      content: "Hypothesis: client will accept remote work"
    })
  });

  const hypothesisDecRes = await fetch(`${BASE_URL}/api/opportunities/${hypothesisOpp.id}/decision`, { method: "POST" });
  const hypothesisDec = (await hypothesisDecRes.json()).data;
  assert.strictEqual(hypothesisDec.verificationStatus, "PARTIALLY_VERIFIED");
  assert.notStrictEqual(hypothesisDec.verificationStatus, "VERIFIED");
  assert.strictEqual(hypothesisDec.decision, "NEEDS_REVIEW");
  console.log("✓ Hypothesis-only evidence evaluates to PARTIALLY_VERIFIED / NEEDS_REVIEW");

  // TEST SCENARIO 7: FACT evidence is handled correctly
  console.log("\n--- Scenario 7: FACT evidence handled correctly ---");
  const factOnlyOppRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "upwork",
      title: "Direct Verified Client Job",
      eligibility_status: "eligible",
      owner_fit_status: "fit"
    })
  });
  const factOnlyOpp = (await factOnlyOppRes.json()).data;

  await fetch(`${BASE_URL}/api/opportunities/${factOnlyOpp.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "FACT",
      source: "official_api",
      content: "Verified payment method & contract agreement"
    })
  });

  // P5-01: as in scenario 1, the ELIGIBLE/FIT verdicts must be asserted after
  // FACT evidence exists rather than through the create payload.
  await fetch(`${BASE_URL}/api/opportunities/${factOnlyOpp.id}/eligibility`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "ELIGIBLE" })
  });
  await fetch(`${BASE_URL}/api/opportunities/${factOnlyOpp.id}/owner-fit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "FIT" })
  });

  const factDecRes = await fetch(`${BASE_URL}/api/opportunities/${factOnlyOpp.id}/decision`, { method: "POST" });
  const factDec = (await factDecRes.json()).data;
  assert.strictEqual(factDec.verificationStatus, "VERIFIED");
  assert.strictEqual(factDec.decision, "SELECT");
  console.log("✓ FACT evidence handled correctly -> VERIFIED -> SELECT");

  // TEST SCENARIO 8: Mixed FACT + non-FACT evidence follows verification rules
  console.log("\n--- Scenario 8: Mixed FACT + non-FACT evidence follows verification rules ---");
  await fetch(`${BASE_URL}/api/opportunities/${factOnlyOpp.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "ASSUMPTION",
      source: "user_note",
      content: "Assuming client wants 2-week turn-around"
    })
  });

  const mixedDecRes = await fetch(`${BASE_URL}/api/opportunities/${factOnlyOpp.id}/decision`, { method: "POST" });
  const mixedDec = (await mixedDecRes.json()).data;
  assert.strictEqual(mixedDec.verificationStatus, "PARTIALLY_VERIFIED", "Mixed FACT + non-FACT should evaluate to PARTIALLY_VERIFIED");
  assert.strictEqual(mixedDec.decision, "NEEDS_REVIEW", "Mixed evidence opportunity should require review");
  console.log("✓ Mixed FACT + non-FACT evidence correctly evaluated to PARTIALLY_VERIFIED / NEEDS_REVIEW");

  // TEST SCENARIOS 9 & 10: Score determinism & reproducibility
  console.log("\n--- Scenarios 9 & 10: Deterministic scoring & Reproducibility ---");
  const eval1 = (await (await fetch(`${BASE_URL}/api/opportunities/${strongOpp.id}/decision`, { method: "POST" })).json()).data;
  const eval2 = (await (await fetch(`${BASE_URL}/api/opportunities/${strongOpp.id}/decision`, { method: "GET" })).json()).data;

  assert.strictEqual(eval1.score, eval2.score, "Score must be identical");
  assert.strictEqual(eval1.decision, eval2.decision, "Decision must be identical");
  assert.deepStrictEqual(eval1.factors, eval2.factors, "Factors breakdown must be identical");
  console.log("✓ Decision Engine score and output are 100% deterministic and reproducible");

  // TEST SCENARIO 11: Reasons explain the decision
  console.log("\n--- Scenario 11: Reasons explain decision ---");
  assert.ok(Array.isArray(eval1.reasons) && eval1.reasons.length >= 3, "Reasons must contain detailed factor explanations");
  console.log("✓ Reasons clearly explain the decision process");

  // TEST SCENARIO 12: Unknown values remain UNKNOWN
  console.log("\n--- Scenario 12: Unknown values remain UNKNOWN ---");
  assert.ok(Array.isArray(missingDec.unknowns) && missingDec.unknowns.length >= 2, "Missing fields must be present in unknowns array");
  assert.ok(missingDec.unknowns.some(u => u.includes("UNKNOWN") || u.includes("pending")), "Unknown items explicitly noted");
  console.log("✓ Unknown values preserved as UNKNOWN without invented data");

  // TEST SCENARIO 13: No invented earning value
  console.log("\n--- Scenario 13: No invented earning value ---");
  assert.strictEqual(strongDec.factors.earningPotential, undefined, "No fake earning values added to factors");
  assert.ok(strongDec.verificationLimitations.some(l => l.includes("did not spend money")), "Verification limitations explicitly stated");
  console.log("✓ Confirmed no invented earning values or fake capabilities");

  // Cleanup created opportunities
  await fetch(`${BASE_URL}/api/opportunities/${strongOpp.id}`, { method: "DELETE" });
  await fetch(`${BASE_URL}/api/opportunities/${rejectedOpp.id}`, { method: "DELETE" });
  await fetch(`${BASE_URL}/api/opportunities/${missingInfoOpp.id}`, { method: "DELETE" });
  await fetch(`${BASE_URL}/api/opportunities/${assumptionOpp.id}`, { method: "DELETE" });
  await fetch(`${BASE_URL}/api/opportunities/${hypothesisOpp.id}`, { method: "DELETE" });
  await fetch(`${BASE_URL}/api/opportunities/${factOnlyOpp.id}`, { method: "DELETE" });

  console.log("\nALL EARNING DECISION ENGINE TESTS PASSED SUCCESSFULLY!");
}

runDecisionEngineTests().catch((err) => {
  console.error("Decision Engine Test failure:", err);
  process.exit(1);
});
