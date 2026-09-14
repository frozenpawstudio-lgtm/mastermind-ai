import assert from "node:assert";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";

async function runDiscoveryTests() {
  console.log(`Starting Opportunity Discovery API tests against ${BASE_URL}...`);

  // 1. Health Check
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  assert.strictEqual(healthRes.status, 200, "Health check failed");
  console.log("✓ Health check passed");

  // 2. Connectivity & Status Check: GET /api/opportunities/discover
  console.log("\n--- Scenario 1: GET /api/opportunities/discover status & connectivity ---");
  const getDiscoverRes = await fetch(`${BASE_URL}/api/opportunities/discover`);
  assert.strictEqual(getDiscoverRes.status, 200, "GET /discover should return HTTP 200");
  const getDiscoverJson = await getDiscoverRes.json();
  assert.strictEqual(getDiscoverJson.ok, true);
  assert.strictEqual(getDiscoverJson.status, "NOT_CONNECTED", "Status should report NOT_CONNECTED when external search tools absent");
  assert.strictEqual(getDiscoverJson.connectivity, "NOT_CONNECTED", "Connectivity should report NOT_CONNECTED");
  assert.strictEqual(getDiscoverJson.connected, false);
  assert.ok(getDiscoverJson.message.includes("NOT_CONNECTED"), "Message must explain NOT_CONNECTED status");
  console.log("✓ GET /discover truthfully reports NOT_CONNECTED status");

  // 3. Process Legitimate Discovery Input: POST /api/opportunities/discover
  console.log("\n--- Scenario 2: POST /api/opportunities/discover with valid opportunity ---");
  const discoveryInput = {
    opportunities: [
      {
        source: "discovery_test",
        title: "Build Cloudflare Workers AI Plugin",
        url: "https://example.com/job/discover-101",
        platform: "Upwork",
        description: "Need a skilled engineer to build an AI integration plugin on Workers.",
        earning_model: "Fixed Price",
        risk: "Low",
        effort: "Medium",
        cost: "Free tier Workers",
        earning_potential: "$500 - $1,000",
        discovered_at: new Date().toISOString()
      }
    ]
  };

  const postDiscoverRes = await fetch(`${BASE_URL}/api/opportunities/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(discoveryInput)
  });
  assert.strictEqual(postDiscoverRes.status, 200, "POST /discover failed");
  const postDiscoverJson = await postDiscoverRes.json();
  assert.strictEqual(postDiscoverJson.ok, true);
  assert.strictEqual(postDiscoverJson.connectivity, "NOT_CONNECTED");
  assert.strictEqual(postDiscoverJson.summary.totalInput, 1);
  assert.strictEqual(postDiscoverJson.summary.discoveredCount, 1);
  assert.strictEqual(postDiscoverJson.summary.duplicateCount, 0);

  const discoveredOpp = postDiscoverJson.discovered[0];
  assert.ok(discoveredOpp.id, "Discovered opportunity should have an ID");
  assert.strictEqual(discoveredOpp.title, "Build Cloudflare Workers AI Plugin");
  assert.strictEqual(discoveredOpp.url, "https://example.com/job/discover-101");
  assert.strictEqual(discoveredOpp.platform, "Upwork");
  assert.strictEqual(discoveredOpp.verification_status, "UNVERIFIED", "Newly discovered item must preserve UNVERIFIED state");
  assert.strictEqual(discoveredOpp.eligibility_status, "pending", "Newly discovered item must preserve pending eligibility state");
  assert.strictEqual(discoveredOpp.owner_fit_status, "pending", "Newly discovered item must preserve pending owner fit state");
  assert.strictEqual(discoveredOpp.earning_model, "Fixed Price");
  assert.strictEqual(discoveredOpp.risk, "Low");
  assert.strictEqual(discoveredOpp.effort, "Medium");
  assert.strictEqual(discoveredOpp.cost, "Free tier Workers");
  assert.strictEqual(discoveredOpp.earning_potential, "$500 - $1,000");
  assert.ok(discoveredOpp.discovered_at, "discovered_at should be populated");
  console.log("✓ Valid opportunity successfully ingested and saved via Discovery Engine:", discoveredOpp.id);

  // 4. Duplicate Prevention by URL
  console.log("\n--- Scenario 3: Prevent Duplicate Opportunity by URL ---");
  const duplicateUrlInput = {
    opportunities: [
      {
        source: "discovery_test",
        title: "Different Title Same URL",
        url: "https://example.com/job/discover-101", // Same URL
        platform: "Upwork",
        description: "Duplicate check by URL test"
      }
    ]
  };

  const dupUrlRes = await fetch(`${BASE_URL}/api/opportunities/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(duplicateUrlInput)
  });
  assert.strictEqual(dupUrlRes.status, 200);
  const dupUrlJson = await dupUrlRes.json();
  assert.strictEqual(dupUrlJson.summary.discoveredCount, 0, "Duplicate URL must not create a new opportunity");
  assert.strictEqual(dupUrlJson.summary.duplicateCount, 1, "Duplicate count must be 1");
  assert.strictEqual(dupUrlJson.duplicates[0].existingId, discoveredOpp.id);
  assert.ok(dupUrlJson.duplicates[0].reason.includes("URL"), "Reason should specify duplicate URL match");
  console.log("✓ Prevented duplicate opportunity by URL match");

  // 5. Duplicate Prevention by Title + Platform
  console.log("\n--- Scenario 4: Prevent Duplicate Opportunity by Title + Platform ---");
  const duplicateTitlePlatformInput = {
    opportunities: [
      {
        source: "discovery_test",
        title: "Build Cloudflare Workers AI Plugin", // Same Title
        url: "https://example.com/job/different-url-999", // Different URL
        platform: "Upwork", // Same Platform
        description: "Duplicate check by Title + Platform test"
      }
    ]
  };

  const dupTitleRes = await fetch(`${BASE_URL}/api/opportunities/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(duplicateTitlePlatformInput)
  });
  assert.strictEqual(dupTitleRes.status, 200);
  const dupTitleJson = await dupTitleRes.json();
  assert.strictEqual(dupTitleJson.summary.discoveredCount, 0, "Duplicate Title+Platform must not create a new opportunity");
  assert.strictEqual(dupTitleJson.summary.duplicateCount, 1, "Duplicate count must be 1");
  assert.strictEqual(dupTitleJson.duplicates[0].existingId, discoveredOpp.id);
  assert.ok(dupTitleJson.duplicates[0].reason.includes("Title and Platform"), "Reason should specify Title and Platform match");
  console.log("✓ Prevented duplicate opportunity by Title + Platform match");

  // 6. Validation of required fields
  console.log("\n--- Scenario 5: Validation of required opportunity data ---");
  const invalidInput = {
    opportunities: [
      {
        source: "discovery_test",
        // Missing title!
        url: "https://example.com/job/no-title"
      }
    ]
  };

  const invalidRes = await fetch(`${BASE_URL}/api/opportunities/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(invalidInput)
  });
  assert.strictEqual(invalidRes.status, 400, "Missing title in single item discover POST should return 400 error");
  const invalidJson = await invalidRes.json();
  assert.strictEqual(invalidJson.ok, false);
  assert.ok(invalidJson.error.includes("Title is required"));
  console.log("✓ Field validation rejected missing required title properly");

  // 7. Integration with Verification and Decision Engines
  console.log("\n--- Scenario 6: Integration with Verification Engine & Decision Engine ---");
  // Update eligibility & owner fit for decision evaluation
  await fetch(`${BASE_URL}/api/opportunities/${discoveredOpp.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eligibility_status: "eligible",
      owner_fit_status: "fit"
    })
  });

  // Add FACT evidence
  const evidenceRes = await fetch(`${BASE_URL}/api/opportunities/${discoveredOpp.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "FACT",
      source: "official_api",
      content: "Verified contract offer with payment method verified"
    })
  });
  assert.strictEqual(evidenceRes.status, 201);

  // Run Decision Engine evaluation
  const decisionRes = await fetch(`${BASE_URL}/api/opportunities/${discoveredOpp.id}/decision`, {
    method: "POST"
  });
  assert.strictEqual(decisionRes.status, 200);
  const decisionJson = await decisionRes.json();
  assert.strictEqual(decisionJson.data.verificationStatus, "VERIFIED");
  assert.strictEqual(decisionJson.data.decision, "SELECT");
  assert.strictEqual(decisionJson.data.score, 100);
  console.log("✓ Discovered opportunity seamlessly integrates with Verification and Decision Engines");

  // 8. Cleanup
  console.log("\n--- Scenario 7: Cleanup ---");
  const deleteRes = await fetch(`${BASE_URL}/api/opportunities/${discoveredOpp.id}`, {
    method: "DELETE"
  });
  assert.strictEqual(deleteRes.status, 200);
  console.log("✓ Discovered test opportunity cleaned up");

  console.log("\nALL OPPORTUNITY DISCOVERY TESTS PASSED SUCCESSFULLY!");
}

runDiscoveryTests().catch((err) => {
  console.error("Discovery Test failure:", err);
  process.exit(1);
});
