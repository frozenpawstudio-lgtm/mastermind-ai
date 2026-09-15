import assert from "node:assert";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";

async function runEligibilityOwnerFitTests() {
  console.log(`Starting Eligibility Engine & Owner Fit Engine API tests against ${BASE_URL}...`);

  // Health check
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  assert.strictEqual(healthRes.status, 200, "Health check failed");
  console.log("✓ Health check passed");

  // 1. UNKNOWN handling when data/evidence missing
  console.log("\n--- Test 1 & 9: UNKNOWN Eligibility when data missing ---");
  const oppUnknownRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "test",
      title: "Synthetic Test Job - Missing Data",
      description: "No evidence provided"
    })
  });
  const oppUnknown = (await oppUnknownRes.json()).data;

  const eligUnknownRes = await fetch(`${BASE_URL}/api/opportunities/${oppUnknown.id}/eligibility`);
  assert.strictEqual(eligUnknownRes.status, 200);
  const eligUnknownJson = await eligUnknownRes.json();
  assert.strictEqual(eligUnknownJson.data.status, "UNKNOWN", "Status should be UNKNOWN when eligibility data is missing");
  console.log("✓ UNKNOWN eligibility correctly evaluated when data missing");

  // 2. UNKNOWN Owner Fit when owner-fit data missing
  console.log("\n--- Test 2 & 10: UNKNOWN Owner Fit when data missing ---");
  const fitUnknownRes = await fetch(`${BASE_URL}/api/opportunities/${oppUnknown.id}/owner-fit`);
  assert.strictEqual(fitUnknownRes.status, 200);
  const fitUnknownJson = await fitUnknownRes.json();
  assert.strictEqual(fitUnknownJson.data.status, "UNKNOWN", "Status should be UNKNOWN when owner fit data is missing");
  console.log("✓ UNKNOWN owner fit correctly evaluated when data missing");

  // 3. Truth Rule: Attempting to force ELIGIBLE without FACT evidence must fail
  console.log("\n--- Test 3: Attempting to force ELIGIBLE status without FACT evidence ---");
  const setEligibleWithoutFactRes = await fetch(`${BASE_URL}/api/opportunities/${oppUnknown.id}/eligibility`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "ELIGIBLE" })
  });
  assert.strictEqual(setEligibleWithoutFactRes.status, 400, "Setting ELIGIBLE without FACT evidence should return 400");
  const setEligibleWithoutFactJson = await setEligibleWithoutFactRes.json();
  assert.ok(setEligibleWithoutFactJson.error.includes("without at least one FACT evidence record"));
  console.log("✓ Direct ELIGIBLE status change without FACT evidence rejected properly");

  // 4. Truth Rule: Attempting to force FIT without FACT evidence must fail
  console.log("\n--- Test 4: Attempting to force FIT status without FACT evidence ---");
  const setFitWithoutFactRes = await fetch(`${BASE_URL}/api/opportunities/${oppUnknown.id}/owner-fit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "FIT" })
  });
  assert.strictEqual(setFitWithoutFactRes.status, 400, "Setting FIT without FACT evidence should return 400");
  console.log("✓ Direct FIT status change without FACT evidence rejected properly");

  // 5. ASSUMPTION evidence -> POTENTIALLY_ELIGIBLE & POTENTIAL_FIT (ASSUMPTION does not become FACT)
  console.log("\n--- Test 5, 11: ASSUMPTION evidence produces POTENTIALLY_ELIGIBLE and POTENTIAL_FIT ---");
  await fetch(`${BASE_URL}/api/opportunities/${oppUnknown.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "ASSUMPTION",
      source: "assumption_source",
      content: "Assume location is eligible based on region"
    })
  });

  const eligAssumptionRes = await fetch(`${BASE_URL}/api/opportunities/${oppUnknown.id}/eligibility`);
  assert.strictEqual((await eligAssumptionRes.json()).data.status, "POTENTIALLY_ELIGIBLE");
  console.log("✓ ASSUMPTION evidence evaluates to POTENTIALLY_ELIGIBLE (does not become FACT)");

  const fitAssumptionRes = await fetch(`${BASE_URL}/api/opportunities/${oppUnknown.id}/owner-fit`);
  assert.strictEqual((await fitAssumptionRes.json()).data.status, "POTENTIAL_FIT");
  console.log("✓ ASSUMPTION evidence evaluates to POTENTIAL_FIT (does not become FACT)");

  // 6. HYPOTHESIS evidence -> POTENTIALLY_ELIGIBLE & POTENTIAL_FIT (HYPOTHESIS does not become FACT)
  console.log("\n--- Test 6, 12: HYPOTHESIS evidence produces POTENTIALLY_ELIGIBLE and POTENTIAL_FIT ---");
  const oppHypoRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "test", title: "Hypothesis Opportunity" })
  });
  const oppHypo = (await oppHypoRes.json()).data;

  await fetch(`${BASE_URL}/api/opportunities/${oppHypo.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "HYPOTHESIS",
      source: "hypo_source",
      content: "Hypothesis: client might accept remote developers"
    })
  });

  const eligHypoRes = await fetch(`${BASE_URL}/api/opportunities/${oppHypo.id}/eligibility`);
  assert.strictEqual((await eligHypoRes.json()).data.status, "POTENTIALLY_ELIGIBLE");
  console.log("✓ HYPOTHESIS evidence evaluates to POTENTIALLY_ELIGIBLE (does not become FACT)");

  const fitHypoRes = await fetch(`${BASE_URL}/api/opportunities/${oppHypo.id}/owner-fit`);
  assert.strictEqual((await fitHypoRes.json()).data.status, "POTENTIAL_FIT");
  console.log("✓ HYPOTHESIS evidence evaluates to POTENTIAL_FIT (does not become FACT)");

  // 7. FACT evidence -> ELIGIBLE & FIT
  console.log("\n--- Test 7: FACT evidence produces ELIGIBLE and FIT ---");
  const oppFactRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "test", title: "Fact Verified Opportunity" })
  });
  const oppFact = (await oppFactRes.json()).data;

  await fetch(`${BASE_URL}/api/opportunities/${oppFact.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "FACT",
      source: "fact_source",
      content: "Client payment verified, location eligible confirmed, owner fit confirmed"
    })
  });

  const eligFactRes = await fetch(`${BASE_URL}/api/opportunities/${oppFact.id}/eligibility`);
  assert.strictEqual((await eligFactRes.json()).data.status, "ELIGIBLE");
  console.log("✓ FACT evidence evaluates to ELIGIBLE");

  const fitFactRes = await fetch(`${BASE_URL}/api/opportunities/${oppFact.id}/owner-fit`);
  assert.strictEqual((await fitFactRes.json()).data.status, "FIT");
  console.log("✓ FACT evidence evaluates to FIT");

  // 8. Ineligible / Unfit FACT evidence -> NOT_ELIGIBLE & NOT_FIT
  console.log("\n--- Test 8: Disqualifying FACT evidence produces NOT_ELIGIBLE and NOT_FIT ---");
  const oppDisqualRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "test", title: "Disqualified Opportunity" })
  });
  const oppDisqual = (await oppDisqualRes.json()).data;

  await fetch(`${BASE_URL}/api/opportunities/${oppDisqual.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "FACT",
      source: "disqual_source",
      content: "Owner is ineligible due to restricted country policy; skill requirement is unfit"
    })
  });

  const eligDisqualRes = await fetch(`${BASE_URL}/api/opportunities/${oppDisqual.id}/eligibility`);
  assert.strictEqual((await eligDisqualRes.json()).data.status, "NOT_ELIGIBLE");
  console.log("✓ Disqualifying FACT evidence evaluates to NOT_ELIGIBLE");

  const fitDisqualRes = await fetch(`${BASE_URL}/api/opportunities/${oppDisqual.id}/owner-fit`);
  assert.strictEqual((await fitDisqualRes.json()).data.status, "NOT_FIT");
  console.log("✓ Disqualifying FACT evidence evaluates to NOT_FIT");

  // 9. Owner Profile constraint mismatch -> NOT_FIT
  console.log("\n--- Test 9: Owner Profile cost constraint mismatch produces NOT_FIT ---");
  await fetch(`${BASE_URL}/api/owner/profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      skills: "JavaScript, Cloudflare Workers",
      max_cost: "$50"
    })
  });

  const oppCostMismatchRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "test",
      title: "Expensive Requirement Job",
      cost: "$500"
    })
  });
  const oppCostMismatch = (await oppCostMismatchRes.json()).data;

  const fitCostMismatchRes = await fetch(`${BASE_URL}/api/opportunities/${oppCostMismatch.id}/owner-fit`);
  const fitCostMismatchJson = await fitCostMismatchRes.json();
  assert.strictEqual(fitCostMismatchJson.data.status, "NOT_FIT");
  assert.ok(fitCostMismatchJson.data.reasons.some(r => r.includes("exceeds Owner max cost limit")));
  console.log("✓ Cost exceeding Owner profile limit correctly evaluated to NOT_FIT");

  // 10. Decision Engine Integration with new engines
  console.log("\n--- Test 10, 13: Decision Engine integration ---");
  // UNKNOWN eligibility + UNKNOWN fit must NOT yield SELECT
  const decisionUnknownRes = await fetch(`${BASE_URL}/api/opportunities/${oppUnknown.id}/decision`, { method: "POST" });
  const decisionUnknownJson = await decisionUnknownRes.json();
  assert.notStrictEqual(decisionUnknownJson.data.decision, "SELECT");
  assert.strictEqual(decisionUnknownJson.data.decision, "NEEDS_REVIEW");
  console.log("✓ UNKNOWN eligibility / owner fit evaluates Decision Engine to NEEDS_REVIEW (never SELECT)");

  // Disqualified opportunity yields REJECT
  const decisionDisqualRes = await fetch(`${BASE_URL}/api/opportunities/${oppDisqual.id}/decision`, { method: "POST" });
  const decisionDisqualJson = await decisionDisqualRes.json();
  assert.strictEqual(decisionDisqualJson.data.decision, "REJECT");
  console.log("✓ Disqualified opportunity evaluates Decision Engine to REJECT");

  // Fully verified, eligible, fit opportunity yields SELECT
  const decisionFactRes = await fetch(`${BASE_URL}/api/opportunities/${oppFact.id}/decision`, { method: "POST" });
  const decisionFactJson = await decisionFactRes.json();
  assert.strictEqual(decisionFactJson.data.decision, "SELECT");
  assert.strictEqual(decisionFactJson.data.score, 100);
  console.log("✓ Fully verified, eligible, fit opportunity evaluates Decision Engine to SELECT");

  // Cleanup
  await fetch(`${BASE_URL}/api/opportunities/${oppUnknown.id}`, { method: "DELETE" });
  await fetch(`${BASE_URL}/api/opportunities/${oppHypo.id}`, { method: "DELETE" });
  await fetch(`${BASE_URL}/api/opportunities/${oppFact.id}`, { method: "DELETE" });
  await fetch(`${BASE_URL}/api/opportunities/${oppDisqual.id}`, { method: "DELETE" });
  await fetch(`${BASE_URL}/api/opportunities/${oppCostMismatch.id}`, { method: "DELETE" });

  console.log("\nALL ELIGIBILITY & OWNER FIT ENGINE TESTS PASSED SUCCESSFULLY!");
}

runEligibilityOwnerFitTests().catch((err) => {
  console.error("Eligibility & Owner Fit Test failure:", err);
  process.exit(1);
});
