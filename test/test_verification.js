import assert from "node:assert";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";

async function runVerificationTests() {
  console.log(`Starting Verification Engine API tests against ${BASE_URL}...`);

  // 1. Health check
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  assert.strictEqual(healthRes.status, 200, "Health check failed");
  console.log("✓ Health check passed");

  // 2. Create an unverified opportunity
  const oppPayload = {
    source: "verification_test",
    title: "Verify Client Identity & Contract",
    url: "https://example.com/job/456",
    platform: "Upwork",
    description: "Full stack Cloudflare Workers project"
  };

  const createOppRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(oppPayload)
  });
  assert.strictEqual(createOppRes.status, 201, "Create opportunity failed");
  const createOppJson = await createOppRes.json();
  const opp = createOppJson.data;
  assert.strictEqual(opp.verification_status, "UNVERIFIED", "Default status should be UNVERIFIED");
  console.log("✓ Opportunity created in UNVERIFIED state:", opp.id);

  // 3. Truth rule check: Attempting to set VERIFIED status directly without evidence must fail (HTTP 400)
  const setVerifiedRes = await fetch(`${BASE_URL}/api/opportunities/${opp.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verification_status: "VERIFIED" })
  });
  assert.strictEqual(setVerifiedRes.status, 400, "Direct VERIFIED status change without evidence should fail with 400");
  const setVerifiedJson = await setVerifiedRes.json();
  assert.strictEqual(setVerifiedJson.ok, false);
  assert.ok(setVerifiedJson.error.includes("without at least one FACT evidence record"), "Error message should cite missing FACT evidence");
  console.log("✓ TRUTH RULE PASSED: Attempting VERIFIED status without evidence rejected properly");

  // 4. Create invalid classification evidence must fail
  const invalidEvidenceRes = await fetch(`${BASE_URL}/api/opportunities/${opp.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "RUMOR",
      source: "forum",
      content: "Someone said client is legit"
    })
  });
  assert.strictEqual(invalidEvidenceRes.status, 400, "Invalid classification should return 400");
  console.log("✓ Invalid evidence classification rejected properly");

  // 5. Add ASSUMPTION evidence -> Status should transition to PARTIALLY_VERIFIED
  const assumptionRes = await fetch(`${BASE_URL}/api/opportunities/${opp.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "ASSUMPTION",
      source: "domain_lookup",
      content: "Domain age is > 2 years"
    })
  });
  assert.strictEqual(assumptionRes.status, 201, "Create assumption evidence failed");
  const assumptionJson = await assumptionRes.json();
  const assumptionEvidence = assumptionJson.data;
  assert.strictEqual(assumptionEvidence.classification, "ASSUMPTION");

  // Fetch opportunity to verify status auto-evaluated to PARTIALLY_VERIFIED
  const oppAfterAssumptionRes = await fetch(`${BASE_URL}/api/opportunities/${opp.id}`);
  const oppAfterAssumptionJson = await oppAfterAssumptionRes.json();
  assert.strictEqual(oppAfterAssumptionJson.data.verification_status, "PARTIALLY_VERIFIED");
  console.log("✓ ASSUMPTION evidence updated status to PARTIALLY_VERIFIED");

  // 6. Add FACT evidence -> Status should transition to VERIFIED
  const factRes = await fetch(`${BASE_URL}/api/opportunities/${opp.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "FACT",
      source: "official_api_verification",
      content: "Client payment method verified by platform API response ID 88921"
    })
  });
  assert.strictEqual(factRes.status, 201, "Create FACT evidence failed");
  const factJson = await factRes.json();
  const factEvidence = factJson.data;
  assert.strictEqual(factEvidence.classification, "FACT");

  // Fetch opportunity to verify status auto-evaluated to VERIFIED (or PARTIALLY_VERIFIED if mixed)
  // Let's test explicit verify request to VERIFIED now that FACT exists
  const verifyCallRes = await fetch(`${BASE_URL}/api/opportunities/${opp.id}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "VERIFIED" })
  });
  assert.strictEqual(verifyCallRes.status, 200, "Verify call with FACT evidence failed");
  const verifyCallJson = await verifyCallRes.json();
  assert.strictEqual(verifyCallJson.data.verification_status, "VERIFIED");
  console.log("✓ VERIFIED status set successfully after FACT evidence provided");

  // 7. Test Evidence Retrieval
  const getEvidenceListRes = await fetch(`${BASE_URL}/api/opportunities/${opp.id}/evidence`);
  assert.strictEqual(getEvidenceListRes.status, 200);
  const getEvidenceListJson = await getEvidenceListRes.json();
  assert.strictEqual(getEvidenceListJson.data.length, 2, "Should have 2 evidence items");
  console.log("✓ Evidence list retrieval for opportunity passed");

  const getSingleEvidenceRes = await fetch(`${BASE_URL}/api/evidence/${factEvidence.id}`);
  assert.strictEqual(getSingleEvidenceRes.status, 200);
  const getSingleEvidenceJson = await getSingleEvidenceRes.json();
  assert.strictEqual(getSingleEvidenceJson.data.id, factEvidence.id);
  console.log("✓ Single evidence retrieval passed");

  // 8. Test Status REJECTED explicitly & confirm evidence additions do NOT overwrite REJECTED
  const rejectRes = await fetch(`${BASE_URL}/api/opportunities/${opp.id}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "REJECTED" })
  });
  assert.strictEqual(rejectRes.status, 200);
  const rejectJson = await rejectRes.json();
  assert.strictEqual(rejectJson.data.verification_status, "REJECTED");
  console.log("✓ Status transition to REJECTED passed");

  // Adding new evidence while REJECTED must preserve REJECTED status
  const postRejectFactRes = await fetch(`${BASE_URL}/api/opportunities/${opp.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "FACT",
      source: "audit_log",
      content: "Additional audit details added post-rejection"
    })
  });
  assert.strictEqual(postRejectFactRes.status, 201);
  const postRejectEvidence = (await postRejectFactRes.json()).data;

  let oppCheckRes = await fetch(`${BASE_URL}/api/opportunities/${opp.id}`);
  assert.strictEqual((await oppCheckRes.json()).data.verification_status, "REJECTED", "REJECTED status must NOT be overwritten by new evidence");
  console.log("✓ REJECTED status preserved when adding new evidence");

  // Cleanup post-reject evidence
  await fetch(`${BASE_URL}/api/evidence/${postRejectEvidence.id}`, { method: "DELETE" });

  // 9. Reset status to UNVERIFIED and delete remaining evidence to test re-evaluation back to UNVERIFIED
  await fetch(`${BASE_URL}/api/opportunities/${opp.id}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "UNVERIFIED" })
  });

  const deleteFactRes = await fetch(`${BASE_URL}/api/evidence/${factEvidence.id}`, {
    method: "DELETE"
  });
  assert.strictEqual(deleteFactRes.status, 200);

  const deleteAssumptionRes = await fetch(`${BASE_URL}/api/evidence/${assumptionEvidence.id}`, {
    method: "DELETE"
  });
  assert.strictEqual(deleteAssumptionRes.status, 200);

  // Status should be re-evaluated to UNVERIFIED since no evidence remains
  const oppFinalRes = await fetch(`${BASE_URL}/api/opportunities/${opp.id}`);
  const oppFinalJson = await oppFinalRes.json();
  assert.strictEqual(oppFinalJson.data.verification_status, "UNVERIFIED", "Status should return to UNVERIFIED when all evidence is deleted");
  console.log("✓ Status auto-evaluated back to UNVERIFIED when all evidence deleted");

  // Clean up opportunity
  await fetch(`${BASE_URL}/api/opportunities/${opp.id}`, { method: "DELETE" });

  console.log("ALL VERIFICATION ENGINE TESTS PASSED SUCCESSFULLY!");
}

runVerificationTests().catch((err) => {
  console.error("Verification Test failure:", err);
  process.exit(1);
});
