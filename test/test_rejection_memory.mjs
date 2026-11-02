import assert from "node:assert";

/*
 * Rejection learning (V9 section 28) and opportunity memory (V9 section 29).
 *
 * Section 28 requires REJECTION -> ANALYZE -> POSSIBLE CAUSE -> LESSON ->
 * STRATEGY UPDATE, and forbids inventing a rejection reason: if no cause can be
 * evidenced the only permitted value is UNKNOWN_REASON. This test asserts that a
 * named cause cannot be stored without evidence text.
 *
 * Section 29 requires that only supported information influences future
 * strategy. This test asserts every memory entry must carry a source reference
 * and a category from the source list, so unsupported assertions cannot enter
 * memory, and that recall returns only matching precedent.
 *
 * Both surfaces are Owner-only: rejection reasons and business memory are
 * private state, so an unauthenticated caller gets 401 on every verb.
 */

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN || "";

let passed = 0;
let failed = 0;
const warnings = [];

async function probe(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`      ${err.message}`);
  }
}

const authPost = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER_TOKEN}` },
  body: JSON.stringify(body)
});

const anonPost = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

const authGet = { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } };

async function createOpportunity(title, platform = "Test") {
  const r = await probe("/api/opportunities", authPost({
    source: "rejection-memory-test",
    title,
    platform,
    description: "rejection/memory regression fixture"
  }));
  assert.strictEqual(r.status, 201, `create opportunity status ${r.status}`);
  return r.body.data.id;
}

async function advanceTo(opportunityId, stages) {
  for (const stage of stages) {
    const r = await probe(`/api/opportunities/${opportunityId}/lifecycle`, authPost({ stage }));
    assert.strictEqual(r.status, 201, `stage ${stage} status ${r.status}`);
  }
}

const TO_REJECTED = [
  "VERIFIED",
  "ELIGIBILITY_CHECKED",
  "SELECTED",
  "PREPARING",
  "APPROVAL_PENDING",
  "APPROVED",
  "ASSESSMENT",
  "REJECTED"
];

async function run() {
  if (!OWNER_TOKEN) {
    console.log("  ! OWNER_API_TOKEN not set — Owner-only assertions will fail");
    warnings.push("OWNER_API_TOKEN missing");
  }

  console.log("\n=== V9 section 28: rejection learning ===");

  const rejectedId = await createOpportunity("rejection-learning-fixture");
  const openId = await createOpportunity("memory-fixture", "upwork");

  try {
    await check("anonymous GET rejection-lessons is refused", async () => {
      const r = await probe(`/api/opportunities/${rejectedId}/rejection-lessons`);
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    });

    await check("anonymous POST rejection-lessons is refused", async () => {
      const r = await probe(`/api/opportunities/${rejectedId}/rejection-lessons`, anonPost({ cause: "PRICE" }));
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    });

    await check("lesson before REJECTED stage is refused", async () => {
      const r = await probe(`/api/opportunities/${rejectedId}/rejection-lessons`, authPost({ cause: "PRICE", evidence: "x" }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
      assert.match(String(r.body.error), /REJECTED/i, "error must name the required stage");
    });

    await check("lesson list for unknown opportunity is an empty list", async () => {
      const r = await probe("/api/opportunities/does-not-exist/rejection-lessons", authGet);
      assert.strictEqual(r.status, 200, `expected 200 list, got ${r.status}`);
      assert.deepStrictEqual(r.body.data, [], "unknown opportunity must yield no lessons");
    });

    await advanceTo(rejectedId, TO_REJECTED);

    await check("named cause without evidence is refused", async () => {
      const r = await probe(`/api/opportunities/${rejectedId}/rejection-lessons`, authPost({ cause: "PRICE" }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
      assert.match(String(r.body.error), /evidence/i, "error must name the missing evidence");
    });

    await check("invented cause is refused", async () => {
      const r = await probe(`/api/opportunities/${rejectedId}/rejection-lessons`, authPost({ cause: "MADE_UP", evidence: "x" }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    });

    await check("UNKNOWN_REASON is accepted without evidence", async () => {
      const r = await probe(`/api/opportunities/${rejectedId}/rejection-lessons`, authPost({ cause: "UNKNOWN_REASON" }));
      assert.strictEqual(r.status, 201, `expected 201, got ${r.status}`);
      assert.strictEqual(r.body.data.cause, "UNKNOWN_REASON");
    });

    await check("named cause with evidence is accepted", async () => {
      const r = await probe(`/api/opportunities/${rejectedId}/rejection-lessons`, authPost({
        cause: "PRICE",
        evidence: "client replied budget too high",
        lesson: "quote a lower tier",
        strategy_update: "offer tiered pricing"
      }));
      assert.strictEqual(r.status, 201, `expected 201, got ${r.status}`);
      assert.strictEqual(r.body.data.cause, "PRICE");
      assert.strictEqual(r.body.data.lesson, "quote a lower tier");
      assert.strictEqual(r.body.data.strategy_update, "offer tiered pricing");
    });

    await check("default cause is UNKNOWN_REASON when omitted", async () => {
      const r = await probe(`/api/opportunities/${rejectedId}/rejection-lessons`, authPost({ lesson: "no reason given" }));
      assert.strictEqual(r.status, 201, `expected 201, got ${r.status}`);
      assert.strictEqual(r.body.data.cause, "UNKNOWN_REASON", "a missing cause must not become an invented one");
    });

    await check("lessons are listed for the opportunity", async () => {
      const r = await probe(`/api/opportunities/${rejectedId}/rejection-lessons`, authGet);
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      assert.ok(Array.isArray(r.body.data), "lessons must be an array");
      assert.ok(r.body.data.length >= 3, `expected >=3 lessons, got ${r.body.data.length}`);
    });

    await check("tracking summary includes rejection lessons", async () => {
      const r = await probe(`/api/opportunities/${rejectedId}/tracking`, authGet);
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      assert.ok(Array.isArray(r.body.data.rejection_lessons), "summary must carry rejection lessons");
      assert.ok(r.body.data.rejection_lessons.length >= 3, "every recorded lesson must be retained");
    });

    await check("rejection lesson is audited", async () => {
      const r = await probe("/api/audit-logs", authGet);
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      const rows = Array.isArray(r.body.data) ? r.body.data : [];
      const found = rows.some((row) => row.action === "REJECTION_LESSON_RECORDED");
      assert.ok(found, "REJECTION_LESSON_RECORDED must appear in the audit log");
    });

    console.log("\n=== V9 section 29: opportunity memory ===");

    await check("anonymous GET memory is refused", async () => {
      const r = await probe("/api/opportunities/memory");
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    });

    await check("anonymous POST memory is refused", async () => {
      const r = await probe("/api/opportunities/memory", anonPost({ category: "SKILL_GAP", summary: "x", source_ref: "y" }));
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    });

    await check("memory entry without source_ref is refused", async () => {
      const r = await probe("/api/opportunities/memory", authPost({ category: "SKILL_GAP", summary: "x" }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
      assert.match(String(r.body.error), /source_ref/i, "error must name the missing source reference");
    });

    await check("memory entry without summary is refused", async () => {
      const r = await probe("/api/opportunities/memory", authPost({ category: "SKILL_GAP", source_ref: "s" }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    });

    await check("memory entry with invented category is refused", async () => {
      const r = await probe("/api/opportunities/memory", authPost({ category: "NOPE", summary: "x", source_ref: "s" }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    });

    await check("memory entry referencing unknown opportunity is refused", async () => {
      const r = await probe("/api/opportunities/memory", authPost({
        category: "APPLICATION_OUTCOME",
        summary: "x",
        source_ref: "s",
        opportunity_id: "does-not-exist"
      }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    });

    await check("valid memory entry is accepted", async () => {
      const r = await probe("/api/opportunities/memory", authPost({
        category: "PLATFORM_PERFORMANCE",
        summary: "Upwork replies slower than Fiverr for this profile",
        source_ref: "opportunity:" + openId,
        opportunity_id: openId,
        platform: "upwork"
      }));
      assert.strictEqual(r.status, 201, `expected 201, got ${r.status}`);
      assert.strictEqual(r.body.data.category, "PLATFORM_PERFORMANCE");
      assert.strictEqual(r.body.data.platform, "upwork");
    });

    await check("memory list returns the entry", async () => {
      const r = await probe("/api/opportunities/memory", authGet);
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      const found = r.body.data.some((e) => e.opportunity_id === openId);
      assert.ok(found, "recorded memory entry must be listed");
    });

    await check("memory list filters by category", async () => {
      const r = await probe("/api/opportunities/memory?category=PLATFORM_PERFORMANCE", authGet);
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      assert.ok(r.body.data.every((e) => e.category === "PLATFORM_PERFORMANCE"), "filter must be honoured");
    });

    await check("recall by platform returns matching precedent", async () => {
      const r = await probe("/api/opportunities/memory/recall", authPost({ platform: "upwork" }));
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      assert.ok(r.body.data.length >= 1, "recall must find the upwork entry");
      assert.ok(r.body.data.every((e) => e.platform === "upwork"), "recall must only return matches");
    });

    await check("recall by opportunity returns matching precedent", async () => {
      const r = await probe("/api/opportunities/memory/recall", authPost({ opportunity_id: openId }));
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      assert.ok(r.body.data.every((e) => e.opportunity_id === openId), "recall must only return matches");
    });

    await check("recall with invented category is refused", async () => {
      const r = await probe("/api/opportunities/memory/recall", authPost({ category: "NOPE" }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    });

    await check("memory entry is audited", async () => {
      const r = await probe("/api/audit-logs", authGet);
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      const rows = Array.isArray(r.body.data) ? r.body.data : [];
      assert.ok(rows.some((row) => row.action === "MEMORY_ENTRY_RECORDED"), "MEMORY_ENTRY_RECORDED must be audited");
    });

    await check("memory write does not shadow the opportunity list route", async () => {
      const r = await probe("/api/opportunities", authGet);
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      assert.ok(Array.isArray(r.body.data), "opportunity list must still return an array");
    });
  } finally {
    for (const id of [rejectedId, openId]) {
      await probe(`/api/opportunities/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${OWNER_TOKEN}` }
      });
    }
  }

  console.log("");
  for (const w of warnings) console.log(`  ! ${w}`);
  console.log(`  rejection/memory test: ${passed} passed, ${failed} failed, ${warnings.length} note(s)`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
