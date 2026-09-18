import assert from "node:assert";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";

async function runTests() {
  console.log(`Starting Earning Agent Flow, Intent Precision & Safety Tests against ${BASE_URL}...`);

  // 1. Health check precheck
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  assert.strictEqual(healthRes.status, 200, "Health check should return 200 OK");
  console.log("✓ Health check passed");

  // 2. Test Genuine Earning Commands (Should trigger earning intent & orchestration)
  const genuinePrompts = [
    "AIRA, mujhe kamai karni hai",
    "I want to earn money",
    "find earning opportunities",
    "mujhe freelance work chahiye"
  ];

  for (const prompt of genuinePrompts) {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: prompt })
    });
    assert.strictEqual(res.status, 200, `Chat request for '${prompt}' should return 200 OK`);
    const data = await res.json();
    assert.strictEqual(data.mode, "earning-agent-orchestrated", `Response mode for '${prompt}' should be earning-agent-orchestrated`);
    assert(data.intents.includes("earning"), `Intents for '${prompt}' must include 'earning'`);
  }
  console.log("✓ Genuine earning commands intent detection passed");

  // 3. Test Informational Questions (Should NOT trigger earning intent)
  const infoPrompts = [
    "what is a job?",
    "explain freelance work in simple terms"
  ];

  for (const prompt of infoPrompts) {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: prompt })
    });
    assert.strictEqual(res.status, 200, `Chat request for '${prompt}' should return 200 OK`);
    const data = await res.json();
    assert.strictEqual(data.mode, "legacy-api", `Informational prompt '${prompt}' should use legacy-api mode`);
    assert(!data.intents.includes("earning"), `Informational prompt '${prompt}' should NOT include 'earning' intent`);
  }
  console.log("✓ Intent precision passed (informational questions do not trigger earning intent)");

  // 4. Test Truthfulness Rule: NOT_CONNECTED discovery state
  const earningChatRes = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "AIRA, mujhe kamai karni hai." })
  });
  const chatData = await earningChatRes.json();
  const discoveryState = chatData.earningOperator.discoveryState;
  assert.strictEqual(discoveryState.status, "NOT_CONNECTED", "Discovery status must be NOT_CONNECTED");
  assert.strictEqual(discoveryState.connected, false, "Discovery connected must be false");
  console.log("✓ Truthfulness rule passed: NOT_CONNECTED discovery status verified");

  // 5. Test Upwork/Fiverr Manual Submission Lock & Safety Flags
  const locks = chatData.earningOperator.locks;
  assert.strictEqual(locks.upworkFiverrManualSubmissionOnly, true, "Upwork/Fiverr manual submission lock must be true");
  assert.strictEqual(locks.noSilentSpending, true, "No silent spending lock must be true");
  assert.strictEqual(locks.factVerificationRequiredForSelect, true, "Fact verification requirement must be true");
  console.log("✓ Safety & Submission Lock passed: Upwork/Fiverr manual submission lock confirmed");

  console.log("\nALL EARNING AGENT FLOW, INTENT PRECISION & SAFETY TESTS PASSED SUCCESSFULLY!");
}

runTests().catch(err => {
  console.error("\nTest failure:", err);
  process.exit(1);
});
