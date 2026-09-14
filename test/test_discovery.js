import assert from "node:assert";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";

async function runDiscoveryTests() {
  console.log(`Starting Opportunity Discovery API tests against ${BASE_URL}...`);

  // 1. Health check
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  assert.strictEqual(healthRes.status, 200, "Health check failed");
  console.log("✓ Health check passed");

  // TEST 1: Discovery Status Check (GET /api/opportunities/discover)
  console.log("\n--- Test 1: Discovery Status Check ---");
  const statusRes = await fetch(`${BASE_URL}/api/opportunities/discover`);
  assert.strictEqual(statusRes.status, 200, "Discovery GET status should return 200");
  const statusJson = await statusRes.json();
  assert.strictEqual(statusJson.ok, true);
  assert.ok(statusJson.data.discoveryStatus, "Must report discoveryStatus");
  assert.ok(typeof statusJson.data.liveDiscoveryConnected === "boolean", "Must report liveDiscoveryConnected boolean");
  assert.ok(statusJson.data.message, "Must include informative message");
  console.log("✓ Discovery status check passed:", statusJson.data.discoveryStatus);

  // TEST 2: Discover and Store Structured Opportunity Record
  console.log("\n--- Test 2: Discover & Store Structured Opportunity Record ---");
  const oppPayload = {
    source: "upwork_rss",
    platform: "Upwork",
    items: [
      {
        title: "Cloudflare Worker & Durable Objects Specialist Needed",
        url: "https://upwork.com/jobs/~01982abc345",
        description: "Looking for an expert developer to implement Workers AI + Durable Object agent.",
        earning_model: "hourly",
        risk: "low",
        effort: "medium",
        cost: "zero",
        earning_potential: "$50-$80/hr"
      }
    ]
  };

  const discoverRes = await fetch(`${BASE_URL}/api/opportunities/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(oppPayload)
  });
  assert.strictEqual(discoverRes.status, 200, "POST /api/opportunities/discover failed");
  const discoverJson = await discoverRes.json();
  assert.strictEqual(discoverJson.ok, true);
  assert.strictEqual(discoverJson.data.discoveredCount, 1);
  const createdOpp = discoverJson.data.opportunities[0];

  assert.ok(createdOpp.id, "Created opportunity must have an ID");
  assert.strictEqual(createdOpp.title, oppPayload.items[0].title);
  assert.strictEqual(createdOpp.url, oppPayload.items[0].url);
  assert.strictEqual(createdOpp.verification_status, "UNVERIFIED", "Newly discovered opportunity must default to UNVERIFIED");
  assert.strictEqual(createdOpp.eligibility_status, "pending", "Eligibility must default to pending");
  assert.strictEqual(createdOpp.owner_fit_status, "pending", "Owner fit must default to pending");
  assert.strictEqual(createdOpp.earning_model, "hourly");
  assert.strictEqual(createdOpp.risk, "low");
  assert.strictEqual(createdOpp.effort, "medium");
  assert.ok(createdOpp.discovered_at, "Must populate discovered_at");
  console.log("✓ Structured opportunity discovered and stored successfully:", createdOpp.id);

  // TEST 3: Duplicate Handling by URL
  console.log("\n--- Test 3: Duplicate Handling by URL ---");
  const duplicateUrlRes = await fetch(`${BASE_URL}/api/opportunities/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "Upwork",
      items: [
        {
          title: "Duplicate Job Submission with Same URL",
          url: "https://upwork.com/jobs/~01982abc345",
          description: "Attempting to re-ingest job with same URL"
        }
      ]
    })
  });
  assert.strictEqual(duplicateUrlRes.status, 200);
  const duplicateUrlJson = await duplicateUrlRes.json();
  assert.strictEqual(duplicateUrlJson.data.duplicatesCount, 1, "Duplicates count must be 1");
  const dupResult = duplicateUrlJson.data.opportunities[0];
  assert.strictEqual(dupResult.id, createdOpp.id, "Duplicate must return existing opportunity ID");
  assert.strictEqual(dupResult.duplicate, true, "Duplicate flag must be true");
  console.log("✓ Duplicate handling by URL passed; preserved existing ID:", dupResult.id);

  // TEST 4: Duplicate Handling by Title + Platform
  console.log("\n--- Test 4: Duplicate Handling by Title + Platform ---");
  const duplicateTitleRes = await fetch(`${BASE_URL}/api/opportunities/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "Upwork",
      items: [
        {
          title: "Cloudflare Worker & Durable Objects Specialist Needed",
          url: "", // empty URL but same title and platform
          description: "Attempting to re-ingest job with same title and platform"
        }
      ]
    })
  });
  assert.strictEqual(duplicateTitleRes.status, 200);
  const duplicateTitleJson = await duplicateTitleRes.json();
  assert.strictEqual(duplicateTitleJson.data.duplicatesCount, 1);
  assert.strictEqual(duplicateTitleJson.data.opportunities[0].id, createdOpp.id);
  console.log("✓ Duplicate handling by title + platform passed");

  // TEST 5: Invalid / Incomplete Data Rejection (Missing Title)
  console.log("\n--- Test 5: Invalid / Incomplete Data Rejection ---");
  const invalidRes = await fetch(`${BASE_URL}/api/opportunities/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [
        {
          url: "https://example.com/no-title-job",
          description: "Missing required title field"
        }
      ]
    })
  });
  assert.strictEqual(invalidRes.status, 400, "Missing title must return HTTP 400");
  const invalidJson = await invalidRes.json();
  assert.strictEqual(invalidJson.ok, false);
  assert.ok(invalidJson.error.includes("title is required"), "Error message must cite missing title");
  console.log("✓ Incomplete opportunity data without title rejected properly with HTTP 400");

  // TEST 6: Complete Workflow Sequence (DISCOVER -> STORE -> VERIFY -> ELIGIBILITY -> OWNER FIT -> DECISION ENGINE)
  console.log("\n--- Test 6: Complete End-to-End Sequence Integration ---");
  // Step 1: DISCOVER & STORE
  const workflowRes = await fetch(`${BASE_URL}/api/opportunities/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "Fiverr",
      items: [
        {
          title: "Full Workflow Cloudflare Migration Gig",
          url: "https://fiverr.com/gigs/cloudflare-migration-99",
          description: "Migrate Express backend to Cloudflare Workers DO SQLite",
          earning_model: "fixed_price",
          earning_potential: "$500"
        }
      ]
    })
  });
  assert.strictEqual(workflowRes.status, 200);
  const workflowOpp = (await workflowRes.json()).data.opportunities[0];
  assert.strictEqual(workflowOpp.verification_status, "UNVERIFIED");

  // Initial decision before evidence/eligibility:
  const initialDecRes = await fetch(`${BASE_URL}/api/opportunities/${workflowOpp.id}/decision`, { method: "POST" });
  const initialDec = (await initialDecRes.json()).data;
  assert.strictEqual(initialDec.decision, "NEEDS_REVIEW", "Unverified/pending opportunity must start as NEEDS_REVIEW");

  // Step 2: VERIFY (Add FACT evidence)
  await fetch(`${BASE_URL}/api/opportunities/${workflowOpp.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classification: "FACT",
      source: "client_escrow",
      content: "Client escrow funded $500 verified by platform ID 88302"
    })
  });

  // Step 3: ELIGIBILITY & Step 4: OWNER FIT
  await fetch(`${BASE_URL}/api/opportunities/${workflowOpp.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eligibility_status: "eligible",
      owner_fit_status: "fit"
    })
  });

  // Step 5: DECISION ENGINE
  const finalDecRes = await fetch(`${BASE_URL}/api/opportunities/${workflowOpp.id}/decision`, { method: "POST" });
  const finalDec = (await finalDecRes.json()).data;
  assert.strictEqual(finalDec.verificationStatus, "VERIFIED");
  assert.strictEqual(finalDec.decision, "SELECT");
  assert.strictEqual(finalDec.score, 100);
  console.log("✓ Complete workflow sequence passed: DISCOVER -> STORE -> VERIFY -> ELIGIBILITY -> OWNER FIT -> DECISION ENGINE (SELECT)");

  // Clean up created opportunities
  await fetch(`${BASE_URL}/api/opportunities/${createdOpp.id}`, { method: "DELETE" });
  await fetch(`${BASE_URL}/api/opportunities/${workflowOpp.id}`, { method: "DELETE" });

  console.log("\nALL OPPORTUNITY DISCOVERY TESTS PASSED SUCCESSFULLY!");
}

runDiscoveryTests().catch((err) => {
  console.error("Discovery Test failure:", err);
  process.exit(1);
});
