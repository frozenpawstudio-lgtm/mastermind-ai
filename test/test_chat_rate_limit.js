import assert from "node:assert";

const BASE_URL = process.env.AIRA_BASE_URL || "http://127.0.0.1:8787";

async function runChatRateLimitTests() {
  console.log(`Starting POST /api/chat rate-limit tests against ${BASE_URL}...`);

  // 1. Send normal chat request
  const res1 = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.168.100.1"
    },
    body: JSON.stringify({ message: "Hello AIRA rate limit test" })
  });
  assert.strictEqual(res1.status, 200, "First request should return HTTP 200");
  console.log("✓ Normal permitted chat request returned HTTP 200");

  // 2. Flood requests with same IP to trigger rate limit (30 reqs/min limit)
  console.log("Flooding 30 requests to trigger rate limit...");
  for (let i = 0; i < 29; i++) {
    await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "192.168.100.1"
      },
      body: JSON.stringify({ message: `Flood message ${i}` })
    });
  }

  // 31st request should be rate limited (HTTP 429)
  const resLimit = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.168.100.1"
    },
    body: JSON.stringify({ message: "Exceeding limit message" })
  });

  assert.strictEqual(resLimit.status, 429, "31st request should respond HTTP 429");
  assert.strictEqual(resLimit.headers.get("retry-after"), "60", "Retry-After header should be 60");
  const limitData = await resLimit.json();
  assert.strictEqual(limitData.ok, false, "Rate limited ok should be false");
  assert.match(limitData.error, /Rate limit exceeded/i, "Error message should mention rate limit");
  console.log("✓ Rate limit 429 response and Retry-After header verified");

  // 3. Different IP should still be allowed (HTTP 200)
  const resDiffIp = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.168.100.2"
    },
    body: JSON.stringify({ message: "Hello from different IP" })
  });
  assert.strictEqual(resDiffIp.status, 200, "Different IP should not be rate-limited");
  console.log("✓ IP isolation verified");

  console.log("\nALL CHAT RATE LIMIT TESTS PASSED SUCCESSFULLY!\n");
}

runChatRateLimitTests().catch((err) => {
  console.error("Chat rate limit test failure:", err);
  process.exit(1);
});
