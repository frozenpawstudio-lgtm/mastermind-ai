import assert from "node:assert";

/*
 * Opportunity tracking surface test (V9 sections 25, 26, 27).
 *
 * The earning workflow used to stop at PREPARE + Owner approval. Sections 25-27
 * require the record to keep an honest history after that point: a lifecycle
 * stage, a payment status, and a follow-up. This test asserts the two properties
 * that keep that history truthful:
 *
 *   1. The surface is Owner-only. Lifecycle history, payment amounts and
 *      follow-up plans are private business state, so an unauthenticated caller
 *      gets 401 on every verb.
 *   2. A claim that asserts a real-world fact needs evidence. SUBMITTED and
 *      CONFIRMED_PAID are refused without FACT evidence, because a status change
 *      is not proof of a submission (section 24) and only real evidence
 *      establishes confirmed payment (section 26).
 *
 * It also asserts the surface cannot be reached by skipping stages, and that it
 * does not shadow the pre-existing single-opportunity routes.
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

const authPatch = (body) => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER_TOKEN}` },
  body: JSON.stringify(body)
});

const anonPost = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

const authGet = { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } };

async function createOpportunity(title) {
  const r = await probe("/api/opportunities", authPost({
    source: "tracking-test",
    title,
    platform: "Test",
    description: "tracking surface regression fixture"
  }));
  assert.strictEqual(r.status, 201, `create opportunity status ${r.status}`);
  return r.body.data.id;
}

async function addFact(opportunityId, content) {
  const r = await probe("/api/evidence", authPost({
    opportunity_id: opportunityId,
    classification: "FACT",
    source: "test fixture",
    content
  }));
  assert.strictEqual(r.status, 201, `add evidence status ${r.status}`);
}

async function run() {
  if (!OWNER_TOKEN) {
    console.log("  ! OWNER_API_TOKEN is not set; the authenticated cases cannot run");
    console.log("  ! (authorization cases are still asserted)");
  }

  const created = [];

  try {
    const id = await createOpportunity("tracking-surface-fixture");
    created.push(id);

    console.log("");
    console.log("1. The tracking surface is Owner-only");
    for (const sub of ["tracking", "lifecycle", "payment", "follow-up"]) {
      await check(`GET /api/opportunities/:id/${sub} -> 401`, async () => {
        const r = await probe(`/api/opportunities/${id}/${sub}`);
        assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
      });
    }

    await check("POST lifecycle without a credential -> 401", async () => {
      const r = await probe(`/api/opportunities/${id}/lifecycle`, anonPost({ stage: "VERIFIED" }));
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    });

    await check("POST payment without a credential -> 401", async () => {
      const r = await probe(`/api/opportunities/${id}/payment`, anonPost({ status: "PENDING" }));
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    });

    await check("POST follow-up without a credential -> 401", async () => {
      const r = await probe(`/api/opportunities/${id}/follow-up`, anonPost({ next_action: "x" }));
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    });

    await check("the direct Durable Object route enforces the same boundary", async () => {
      const r = await probe(`/agents/master-mind-agent/default/opportunities/${id}/tracking`);
      assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    });

    if (!OWNER_TOKEN) {
      warnings.push("authenticated tracking assertions were skipped: OWNER_API_TOKEN not set");
      return;
    }

    console.log("");
    console.log("2. A claim that asserts a real-world fact requires FACT evidence");

    await check("SUBMITTED is refused without FACT evidence", async () => {
      const r = await probe(`/api/opportunities/${id}/lifecycle`, authPost({ stage: "SUBMITTED" }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
      assert.match(String(r.body.error), /FACT evidence/i, "error must name the missing evidence");
    });

    await check("CONFIRMED_PAID is refused without FACT evidence", async () => {
      const r = await probe(`/api/opportunities/${id}/payment`, authPost({ status: "CONFIRMED_PAID" }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
      assert.match(String(r.body.error), /FACT evidence/i, "error must name the missing evidence");
    });

    await check("PENDING payment is accepted without evidence (it asserts no money)", async () => {
      const r = await probe(`/api/opportunities/${id}/payment`, authPost({ status: "PENDING" }));
      assert.strictEqual(r.status, 201, `expected 201, got ${r.status}`);
      assert.strictEqual(r.body.data.status, "PENDING");
    });

    console.log("");
    console.log("3. The lifecycle cannot skip or reverse");

    await check("an unknown stage is rejected", async () => {
      const r = await probe(`/api/opportunities/${id}/lifecycle`, authPost({ stage: "PROFIT" }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    });

    await check("a backwards transition is rejected", async () => {
      await probe(`/api/opportunities/${id}/lifecycle`, authPost({ stage: "VERIFIED" }));
      const r = await probe(`/api/opportunities/${id}/lifecycle`, authPost({ stage: "DISCOVERED" }));
      assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
      assert.match(String(r.body.error), /backwards/i);
    });

    console.log("");
    console.log("4. With FACT evidence the full workflow completes");

    await check("FACT evidence is accepted", async () => {
      await addFact(id, "Submission reference TEST-REF-1 confirmed by the platform");
    });

    await check("the lifecycle advances to SUBMITTED once evidence exists", async () => {
      for (const stage of ["SELECTED", "PREPARING", "APPROVAL_PENDING", "APPROVED", "SUBMITTED"]) {
        const r = await probe(`/api/opportunities/${id}/lifecycle`, authPost({ stage }));
        assert.strictEqual(r.status, 201, `${stage} status ${r.status}`);
        assert.strictEqual(r.body.data.stage, stage);
      }
    });

    await check("CONFIRMED_PAID is accepted once evidence exists", async () => {
      const r = await probe(`/api/opportunities/${id}/payment`, authPost({
        status: "CONFIRMED_PAID", amount: "1000", currency: "INR"
      }));
      assert.strictEqual(r.status, 201, `expected 201, got ${r.status}`);
      assert.strictEqual(r.body.data.status, "CONFIRMED_PAID");
    });

    await check("a follow-up is recorded, and is never described as sent", async () => {
      const r = await probe(`/api/opportunities/${id}/follow-up`, authPost({
        next_action: "Follow up in 7 days", due_at: "2026-12-01", expected_response: "Client reply"
      }));
      assert.strictEqual(r.status, 201, `expected 201, got ${r.status}`);
      assert.strictEqual(r.body.data.status, "OPEN");
      assert.strictEqual(r.body.data.next_action, "Follow up in 7 days");
      assert.strictEqual(
        r.body.data.sent,
        undefined,
        "a follow-up record must not claim a message was sent"
      );
    });

    await check("a follow-up status can be updated", async () => {
      const list = await probe(`/api/opportunities/${id}/follow-up`, authGet);
      const fu = list.body.data[0];
      const r = await probe(`/api/opportunities/${id}/follow-up/${fu.id}`, authPatch({ status: "DONE" }));
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      assert.strictEqual(r.body.data.status, "DONE");
    });

    await check("the tracking summary reports the real stage and confirmed payment", async () => {
      const r = await probe(`/api/opportunities/${id}/tracking`, authGet);
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      assert.strictEqual(r.body.data.current_stage, "SUBMITTED");
      assert.strictEqual(r.body.data.confirmed_payment, true);
      assert.ok(Array.isArray(r.body.data.lifecycle), "lifecycle history must be present");
      assert.ok(r.body.data.lifecycle.length >= 5, "every recorded stage must be retained");
    });

    await check("an unknown opportunity is a 404, not an empty success", async () => {
      const r = await probe("/api/opportunities/does-not-exist/tracking", authGet);
      assert.strictEqual(r.status, 404, `expected 404, got ${r.status}`);
    });

    console.log("");
    console.log("5. The new surface does not shadow the existing routes");

    await check("GET /api/opportunities/:id still returns the single record", async () => {
      const r = await probe(`/api/opportunities/${id}`, authGet);
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      assert.strictEqual(r.body.data.id, id);
      assert.strictEqual(r.body.data.title, "tracking-surface-fixture");
    });

    await check("the lifecycle history is append-only (no stage is rewritten)", async () => {
      const r = await probe(`/api/opportunities/${id}/lifecycle`, authGet);
      const stages = r.body.data.map((row) => row.stage);
      assert.deepStrictEqual(
        stages,
        ["VERIFIED", "SELECTED", "PREPARING", "APPROVAL_PENDING", "APPROVED", "SUBMITTED"],
        "the recorded history must be preserved in order"
      );
    });

    console.log("");
    console.log("6. Every tracking write is audited");

    await check("lifecycle, payment and follow-up writes appear in the audit log", async () => {
      const r = await probe("/api/audit-logs", authGet);
      assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
      const actions = new Set(r.body.data.map((row) => row.action));
      for (const action of ["LIFECYCLE_STAGE_RECORDED", "PAYMENT_RECORDED", "FOLLOW_UP_RECORDED"]) {
        assert.ok(actions.has(action), `${action} must be audited`);
      }
    });
  } finally {
    for (const id of created) {
      await probe(`/api/opportunities/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${OWNER_TOKEN}` }
      });
    }
  }

  console.log("");
  for (const w of warnings) console.log(`  ! ${w}`);
  console.log(`  tracking surface test: ${passed} passed, ${failed} failed, ${warnings.length} note(s)`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
