import assert from "node:assert";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";

async function runTests() {
  console.log(`Starting Earning Agent Flow & Safety Tests against ${BASE_URL}...`);

  // 1. Health check precheck
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  assert.strictEqual(healthRes.status, 200, "Health check should return 200 OK");
  console.log("✓ Health check passed");

  // 2. Test Earning Intent Detection and Orchestration via /api/chat
  const earningChatRes = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "AIRA, mujhe kamai karni hai." })
  });

  assert.strictEqual(earningChatRes.status, 200, "Chat request should return 200 OK");
  const chatData = await earningChatRes.json();

  assert.strictEqual(chatData.ok, true, "Chat response should be ok");
  assert.strictEqual(chatData.mode, "earning-agent-orchestrated", "Response mode should be earning-agent-orchestrated");
  assert(chatData.intents.includes("earning"), "Intents must include 'earning'");
  assert.strictEqual(chatData.workflow, "EARNING_OPERATOR_PHASE_1", "Workflow must be EARNING_OPERATOR_PHASE_1");
  assert(chatData.earningOperator, "Response must include earningOperator payload");
  console.log("✓ Earning intent detection and orchestration passed");

  // 3. Test Truthfulness Rule: NOT_CONNECTED discovery state when no marketplace credentials exist
  const discoveryState = chatData.earningOperator.discoveryState;
  assert.strictEqual(discoveryState.status, "NOT_CONNECTED", "Discovery status must be NOT_CONNECTED");
  assert.strictEqual(discoveryState.connected, false, "Discovery connected must be false");
  console.log("✓ Truthfulness rule passed: NOT_CONNECTED discovery status verified");

  // 4. Test Upwork/Fiverr Manual Submission Lock
  const locks = chatData.earningOperator.locks;
  assert.strictEqual(locks.upworkFiverrManualSubmissionOnly, true, "Upwork/Fiverr manual submission lock must be true");
  assert.strictEqual(locks.noSilentSpending, true, "No silent spending lock must be true");
  assert.strictEqual(locks.factVerificationRequiredForSelect, true, "Fact verification requirement must be true");
  console.log("✓ Safety & Submission Lock passed: Upwork/Fiverr manual submission lock confirmed");

  console.log("\nALL EARNING AGENT FLOW & SAFETY TESTS PASSED SUCCESSFULLY!");
}

runTests().catch(err => {
  console.error("\nTest failure:", err);
  process.exit(1);
});
