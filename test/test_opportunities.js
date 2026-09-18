import assert from "node:assert";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";

async function runTests() {
  console.log(`Starting Opportunity API tests against ${BASE_URL}...`);

  // 1. Health check
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  assert.strictEqual(healthRes.status, 200, "Health check failed");
  const healthJson = await healthRes.json();
  assert.strictEqual(healthJson.ok, true, "Health check ok is false");
  console.log("✓ Health check passed");

  // 2. Create Opportunity
  const createPayload = {
    source: "manual",
    title: "Build Cloudflare Worker Integration",
    url: "https://example.com/job/123",
    platform: "Upwork",
    description: "Looking for an expert to build a Workers AI + Durable Object agent.",
    verification_status: "UNVERIFIED",
    eligibility_status: "eligible",
    owner_fit_status: "fit",
    score: 88.5
  };

  const createRes = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createPayload)
  });
  assert.strictEqual(createRes.status, 201, "Create opportunity failed");
  const createJson = await createRes.json();
  assert.strictEqual(createJson.ok, true, "Create response ok is false");
  const createdOpp = createJson.data;
  assert.ok(createdOpp.id, "Created opportunity missing ID");
  assert.strictEqual(createdOpp.title, createPayload.title);
  assert.strictEqual(createdOpp.source, createPayload.source);
  assert.strictEqual(createdOpp.verification_status, "UNVERIFIED");
  // Client-supplied score must NOT be trusted; the deterministic engine owns it.
  assert.strictEqual(createdOpp.score, 0, "Client-supplied score must be ignored on create");
  assert.strictEqual(createdOpp.decision, "NEEDS_REVIEW", "Decision defaults to NEEDS_REVIEW until evaluated");
  // Raw status vocabulary is normalized to a V9 truth state.
  assert.strictEqual(createdOpp.eligibility_status, "ELIGIBLE");
  assert.strictEqual(createdOpp.owner_fit_status, "FIT");
  console.log("✓ Opportunity creation passed (client score rejected, statuses normalized):", createdOpp.id);

  // 3. Get Opportunity
  const getRes = await fetch(`${BASE_URL}/api/opportunities/${createdOpp.id}`);
  assert.strictEqual(getRes.status, 200, "Get opportunity failed");
  const getJson = await getRes.json();
  assert.strictEqual(getJson.ok, true);
  assert.strictEqual(getJson.data.id, createdOpp.id);
  assert.strictEqual(getJson.data.title, createPayload.title);
  console.log("✓ Get opportunity passed");

  // 4. List Opportunities
  const listRes = await fetch(`${BASE_URL}/api/opportunities?source=manual`);
  assert.strictEqual(listRes.status, 200, "List opportunities failed");
  const listJson = await listRes.json();
  assert.strictEqual(listJson.ok, true);
  assert.ok(Array.isArray(listJson.data), "List data is not an array");
  const found = listJson.data.find((item) => item.id === createdOpp.id);
  assert.ok(found, "Created opportunity not found in list output");
  console.log("✓ List opportunities passed");

  // 5. Update Opportunity
  const updatePayload = {
    title: "Updated Title for Cloudflare Worker Integration",
    score: 95
  };
  const updateRes = await fetch(`${BASE_URL}/api/opportunities/${createdOpp.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updatePayload)
  });
  assert.strictEqual(updateRes.status, 200, "Update opportunity failed");
  const updateJson = await updateRes.json();
  assert.strictEqual(updateJson.ok, true);
  assert.strictEqual(updateJson.data.title, updatePayload.title);
  // A client PATCH must not be able to raise the decision score.
  assert.strictEqual(updateJson.data.score, 0, "Client-supplied score must be ignored on update");
  console.log("✓ Update opportunity passed (client score rejected)");

  // 6. Delete Opportunity
  const deleteRes = await fetch(`${BASE_URL}/api/opportunities/${createdOpp.id}`, {
    method: "DELETE"
  });
  assert.strictEqual(deleteRes.status, 200, "Delete opportunity failed");
  const deleteJson = await deleteRes.json();
  assert.strictEqual(deleteJson.ok, true);
  console.log("✓ Delete opportunity passed");

  // Verify it is gone
  const getAfterDeleteRes = await fetch(`${BASE_URL}/api/opportunities/${createdOpp.id}`);
  assert.strictEqual(getAfterDeleteRes.status, 404, "Get after delete should return 404");
  console.log("✓ Get after delete verified 404");

  console.log("ALL OPPORTUNITY API TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
