import assert from "node:assert";

/*
 * V9 Phase-1 foundation tests.
 *
 * Covers: response-envelope contracts, Owner profile contract, earning-intent
 * precision (positive + negative), deterministic score protection, status
 * normalization, truthful connection states and authorization boundaries.
 *
 * Requires the local worker to be running (see README test instructions).
 */

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";

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

async function runFoundationTests() {
  console.log(`Starting V9 foundation tests against ${BASE_URL}...`);

  // --- 1. Health contract --------------------------------------------------
  const health = await getJson("/api/health");
  assert.strictEqual(health.res.status, 200, "Health endpoint must respond 200");
  assert.strictEqual(health.body.ok, true, "Health must report ok:true");
  assert.ok(typeof health.body.aiConnected === "boolean", "Health must report a boolean aiConnected");
  assert.ok(typeof health.body.browserConnected === "boolean", "Health must report a boolean browserConnected");
  assert.ok(["CONFIGURED", "NOT_CONFIGURED"].includes(health.body.authorization), "Health must report a truthful authorization state");
  assert.ok(String(health.body.voice || "").startsWith("VOICE_"), "Health must report a VOICE_* state");
  console.log("✓ Health contract passed");

  // --- 2. Connection truth contract ---------------------------------------
  const conns = await getJson("/api/connections");
  assert.strictEqual(conns.res.status, 200, "Connections endpoint must respond 200");
  assert.strictEqual(conns.body.ok, true);
  const services = conns.body.data && conns.body.data.services;
  assert.ok(Array.isArray(services) && services.length > 0, "Connections must return a service list");

  const truthStates = conns.body.data.states;
  for (const svc of services) {
    assert.ok(
      truthStates.includes(svc.state),
      `Service ${svc.service} reported non-truth-state: ${svc.state}`
    );
    assert.ok(typeof svc.verified === "boolean", `Service ${svc.service} must expose verified flag`);
    if (svc.state === "CONNECTED") {
      assert.strictEqual(svc.verified, true, `CONNECTED service ${svc.service} must be verified`);
    }
  }

  // Unconfigured services must NOT be reported as CONNECTED.
  const upwork = services.find((s) => s.service === "upwork");
  assert.ok(upwork, "Upwork must be listed");
  assert.notStrictEqual(upwork.state, "CONNECTED", "Upwork must never be CONNECTED without real verification");
  console.log("✓ Connection truth contract passed");

  // --- 3. Permission contract ---------------------------------------------
  const perms = await getJson("/api/permissions");
  assert.strictEqual(perms.res.status, 200, "Permissions endpoint must respond 200");
  assert.ok(perms.body.data && Array.isArray(perms.body.data.rules), "Permissions must expose rules");
  const manualRule = perms.body.data.rules.find((r) => r.approval === "MANUAL_OWNER_ONLY");
  assert.ok(manualRule, "Upwork/Fiverr final submission must remain MANUAL_OWNER_ONLY");
  console.log("✓ Permission contract passed");

  // --- 4. Voice contract ---------------------------------------------------
  const voice = await getJson("/api/voice");
  assert.strictEqual(voice.res.status, 200, "Voice endpoint must respond 200");
  assert.ok(String(voice.body.data.state).startsWith("VOICE_"), "Voice must report a VOICE_* state");
  assert.strictEqual(voice.body.data.verified, false, "Voice must not claim verification without evidence");
  console.log("✓ Voice contract passed (state:", voice.body.data.state + ")");

  // --- 5. Opportunity list envelope + truthful empty state -----------------
  const list = await getJson("/api/opportunities");
  assert.strictEqual(list.res.status, 200, "Opportunity list must respond 200");
  assert.strictEqual(list.body.ok, true, "Opportunity list must use { ok, data } envelope");
  assert.ok(Array.isArray(list.body.data), "Opportunity list data must be an array");
  console.log("✓ Opportunity envelope contract passed");

  // --- 6. Owner profile contract ------------------------------------------
  // When no profile row exists the endpoint must report that honestly
  // (data:null) rather than fabricating Owner values.
  const profile = await getJson("/api/owner/profile");
  assert.strictEqual(profile.res.status, 200, "Owner profile must respond 200");
  assert.strictEqual(profile.body.ok, true);
  assert.ok(
    "data" in profile.body,
    "Owner profile response must carry a data field"
  );

  if (profile.body.data === null) {
    console.log("✓ Owner profile contract passed (NO PROFILE CONFIGURED — reported honestly)");
  } else {
    assert.strictEqual(typeof profile.body.data, "object", "Owner profile data must be an object when present");
    assert.ok("skills" in profile.body.data, "Owner profile must expose skills");
    assert.ok("max_cost" in profile.body.data, "Owner profile must expose max_cost");
    console.log("✓ Owner profile contract passed");
  }

  // --- 7. Deterministic score protection ----------------------------------
  // When the permission foundation is CONFIGURED, mutations must present the
  // Owner credential. The suite mirrors a real authorized Owner client.
  const ownerToken = process.env.OWNER_API_TOKEN;
  const ownerAuth = ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {};

  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await getJson("/api/opportunities", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ownerAuth },
    body: JSON.stringify({
      source: "v9_test",
      title: `V9 deterministic score test ${unique}`,
      url: `https://v9.example/job/${unique}`,
      platform: "V9Platform",
      score: 99.9,
      decision: "SELECT"
    })
  });
  assert.strictEqual(created.res.status, 201, "Opportunity create must respond 201");
  assert.strictEqual(created.body.data.score, 0, "Client-supplied score must be ignored");
  assert.strictEqual(created.body.data.decision, "NEEDS_REVIEW", "Client-supplied decision must be ignored");

  // Status normalization on write.
  const patched = await getJson(`/api/opportunities/${created.body.data.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...ownerAuth },
    body: JSON.stringify({
      eligibility_status: "maybe",
      owner_fit_status: "unfit",
      score: 100,
      decision: "SELECT"
    })
  });
  assert.strictEqual(patched.res.status, 200, "Opportunity patch must respond 200");
  assert.strictEqual(patched.body.data.eligibility_status, "POTENTIALLY_ELIGIBLE", "\"maybe\" must normalize to POTENTIALLY_ELIGIBLE");
  assert.strictEqual(patched.body.data.owner_fit_status, "NOT_FIT", "\"unfit\" must normalize to NOT_FIT");
  assert.strictEqual(patched.body.data.score, 0, "Client score must remain ignored after patch");
  assert.strictEqual(patched.body.data.decision, "NEEDS_REVIEW", "Client decision must remain ignored after patch");
  console.log("✓ Deterministic score + status normalization passed");

  // --- 8. Earning intent precision (positive) ------------------------------
  const positiveCases = [
    "AIRA mujhe kamai karni hai",
    "Mujhe earning opportunities find karo",
    "Mere liye freelance work dhundo",
    "Mujhe online income opportunities chahiye",
    "मुझे कमाई करनी है",
    "Mujhe paise kamane hain",
    "Find me freelancing gigs",
    "मुझे नौकरी चाहिए",
    "Mujhe job opportunities dhundo",
    "Show me earning opportunities"
  ];

  for (const message of positiveCases) {
    const chat = await getJson("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    assert.strictEqual(chat.res.status, 200, `Chat must respond 200 for: ${message}`);
    assert.strictEqual(
      chat.body.earningIntent,
      true,
      `Genuine earning intent must be detected for: ${message}`
    );
  }
  console.log("✓ Positive earning-intent cases passed");

  // --- 9. Earning intent precision (negative) ------------------------------
  // Informational questions and unrelated engineering commands that merely
  // share vocabulary (project / client / files / build) must not trigger.
  const negativeCases = [
    "I want to learn JavaScript.",
    "What does freelance work involve?",
    "How should freelance work be documented?",
    "What is the best way to get a job?",
    "Tell me about my yearly earnings report.",
    "What are earning opportunities?",
    "Explain earning opportunities",
    "Show me my project files",
    "Start the project build",
    "List my GitHub projects",
    "Find the client library docs",
    "How do I start a project"
  ];

  for (const message of negativeCases) {
    const chat = await getJson("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    assert.strictEqual(chat.res.status, 200, `Chat must respond 200 for: ${message}`);
    assert.strictEqual(
      chat.body.earningIntent,
      false,
      `This must not trigger the earning workflow: ${message}`
    );
  }
  console.log("✓ Negative earning-intent cases passed");

  // --- 10. Destructive endpoint protection --------------------------------
  // The permission foundation has two honest states:
  //   CONFIGURED     -> an owner credential is enforced, so a cross-origin
  //                     destructive call MUST be rejected.
  //   NOT_CONFIGURED -> no credential exists, so the boundary cannot be
  //                     enforced and the system reports that truthfully.
  const authState = perms.body.data.authorizationState;
  assert.ok(
    ["CONFIGURED", "NOT_CONFIGURED"].includes(authState),
    `Authorization state must be truthful, got: ${authState}`
  );

  const evilDelete = await fetch(`${BASE_URL}/api/opportunities/${created.body.data.id}`, {
    method: "DELETE",
    headers: { Origin: "https://evil.example" }
  });

  if (authState === "CONFIGURED") {
    assert.strictEqual(evilDelete.status, 401, "Cross-origin destructive call must be rejected with 401 when authorization is CONFIGURED");
    console.log("✓ Destructive endpoint protection enforced (authorization CONFIGURED)");
  } else {
    assert.ok(
      evilDelete.status === 200 || evilDelete.status === 404,
      "With authorization NOT_CONFIGURED the boundary is not enforced, but the state must be reported instead of faked"
    );
    console.log("! Destructive endpoint protection NOT_CONFIGURED (OWNER_API_TOKEN absent) — reported truthfully, not faked");
  }

  // Reads must remain available without an owner credential in both modes.
  const readAfter = await fetch(`${BASE_URL}/api/opportunities`, {
    headers: { Origin: "https://evil.example" }
  });
  assert.strictEqual(readAfter.status, 200, "Read endpoints must remain available");
  console.log("✓ Read access unaffected by mutation authorization");

  // --- 11. Voice command is blocked without verified voice ----------------
  const voiceCmd = await getJson("/api/voice/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: "AIRA mujhe kamai karni hai" })
  });
  assert.strictEqual(voiceCmd.res.status, 503, "Voice command must be blocked when voice is not VOICE_ACTIVE");
  assert.strictEqual(voiceCmd.body.ok, false, "Blocked voice command must report ok:false");
  assert.strictEqual(voiceCmd.body.action, "BLOCKED", "Blocked voice command must report action BLOCKED");
  console.log("✓ Voice command truthfully BLOCKED (state:", voiceCmd.body.voice.state + ")");

  // Cleanup — retried with an owner credential so a CONFIGURED runtime can
  // tear down the record it created.
  const cleanupToken = process.env.OWNER_API_TOKEN;
  const cleanupHeaders = cleanupToken ? { Authorization: `Bearer ${cleanupToken}` } : {};
  await fetch(`${BASE_URL}/api/opportunities/${created.body.data.id}`, {
    method: "DELETE",
    headers: cleanupHeaders
  });

  console.log("\nALL V9 FOUNDATION TESTS PASSED SUCCESSFULLY!");
}

runFoundationTests().catch((err) => {
  console.error("V9 Foundation test failure:", err);
  process.exit(1);
});