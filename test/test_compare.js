import assert from "node:assert";

/*
 * COMPARE stage tests (Phase-1 Earning Operator).
 *
 * COMPARE is read-only: it ranks persisted engine outputs and must never
 * mutate opportunities, evidence, owner profile, score, decision or any other
 * state. These tests assert:
 *   - the ranking is deterministic and uses only engine-owned facts,
 *   - an unevaluated opportunity stays UNVERIFIED / UNKNOWN / score 0 /
 *     NEEDS_REVIEW (never silently upgraded),
 *   - SELECT ranks above NEEDS_REVIEW, which ranks above REJECT,
 *   - exact-state ties are broken deterministically by stable opportunity id,
 *   - a compare call leaves every persisted record byte-for-byte unchanged.
 *
 * Zero-opportunity coverage is conditional: the suite asserts the empty
 * contract whenever the worker has no persisted opportunities (a fresh local
 * worker), and skips that assertion otherwise. A local worker is required
 * (see README).
 */

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const authHeaders = OWNER_TOKEN ? { Authorization: `Bearer ${OWNER_TOKEN}` } : {};

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

function postJson(path, payload) {
  return getJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(payload)
  });
}

function del(path) {
  return getJson(path, { method: "DELETE", headers: authHeaders });
}

async function createOpportunity(title) {
  const created = await postJson("/api/opportunities", {
    source: "compare_test",
    title,
    platform: "CompareTest",
    description: "COMPARE stage test record"
  });
  assert.strictEqual(created.res.status, 201, `Create must respond 201 for ${title}`);
  return created.body.data;
}

async function addFact(oppId, content) {
  const res = await postJson(`/api/opportunities/${oppId}/evidence`, {
    classification: "FACT",
    source: "compare_test",
    content
  });
  assert.strictEqual(res.res.status, 201, "FACT evidence create must respond 201");
  return res.body.data;
}

async function runCompareTests() {
  console.log(`Starting COMPARE stage tests against ${BASE_URL}...`);

  const health = await getJson("/api/health");
  assert.strictEqual(health.res.status, 200, "Health check failed");
  console.log("✓ Health check passed");

  const createdIds = [];

  try {
    // --- Zero opportunities (fresh worker only) ---------------------------
    const initialList = await getJson("/api/opportunities");
    assert.strictEqual(initialList.res.status, 200, "Opportunity list must respond 200");
    const initialRows = Array.isArray(initialList.body.data) ? initialList.body.data : [];
    const zeroCompare = await getJson("/api/opportunities/compare");
    assert.strictEqual(zeroCompare.res.status, 200, "Compare must respond 200");
    assert.strictEqual(zeroCompare.body.ok, true, "Compare ok must be true");
    if (initialRows.length === 0) {
      assert.strictEqual(zeroCompare.body.data.comparable, 0, "Empty dataset must report comparable 0");
      assert.deepStrictEqual(zeroCompare.body.data.ranked, [], "Empty dataset must report an empty ranking");
      assert.strictEqual(zeroCompare.body.data.topOpportunityId, null, "Empty dataset must report no top opportunity");
      assert.strictEqual(zeroCompare.body.data.tiedAtTop, false, "Empty dataset cannot tie at the top");
      console.log("✓ Zero-opportunity contract verified (worker had no persisted opportunities)");
    } else {
      console.log(`! Zero-opportunity contract skipped (worker already has ${initialRows.length} persisted opportunities)`);
    }

    // --- One opportunity --------------------------------------------------
    const single = await createOpportunity(`COMPARE single ${Date.now()}`);
    createdIds.push(single.id);
    const oneCompare = await getJson("/api/opportunities/compare");
    assert.strictEqual(oneCompare.res.status, 200);
    const oneEntry = oneCompare.body.data.ranked.find((r) => r.id === single.id);
    assert.ok(oneEntry, "The created opportunity must appear in the ranking");
    assert.strictEqual(oneEntry.rank, 1, "A lone unevaluated opportunity must rank as-is");
    // It has not been evaluated, so it must stay honest — never upgraded.
    assert.strictEqual(oneEntry.verification_status, "UNVERIFIED", "Unevaluated opportunity stays UNVERIFIED");
    assert.strictEqual(oneEntry.eligibility_status, "UNKNOWN", "Unevaluated opportunity stays UNKNOWN");
    assert.strictEqual(oneEntry.owner_fit_status, "UNKNOWN", "Unevaluated opportunity stays UNKNOWN");
    assert.strictEqual(oneEntry.score, 0, "Unevaluated opportunity has engine score 0");
    assert.strictEqual(oneEntry.decision, "NEEDS_REVIEW", "Unevaluated opportunity stays NEEDS_REVIEW");
    console.log("✓ Single unevaluated opportunity ranked honestly (no upgrade)");

    // --- Multiple opportunities: SELECT / NEEDS_REVIEW / REJECT -----------
    const selectOpp = await createOpportunity(`COMPARE select ${Date.now()}`);
    createdIds.push(selectOpp.id);
    await addFact(
      selectOpp.id,
      "Client payment verified, location eligible confirmed, owner fit confirmed"
    );

    const reviewOpp = await createOpportunity(`COMPARE review ${Date.now()}`);
    createdIds.push(reviewOpp.id);

    const rejectOpp = await createOpportunity(`COMPARE reject ${Date.now()}`);
    createdIds.push(rejectOpp.id);
    await addFact(
      rejectOpp.id,
      "Owner is ineligible, banned and restricted country; unfit and not fit for required skill"
    );

    const compare = await getJson("/api/opportunities/compare");
    assert.strictEqual(compare.res.status, 200);
    const ranked = compare.body.data.ranked;
    const byId = new Map(ranked.map((r) => [r.id, r]));

    const selectEntry = byId.get(selectOpp.id);
    const reviewEntry = byId.get(reviewOpp.id);
    const rejectEntry = byId.get(rejectOpp.id);
    assert.ok(selectEntry && reviewEntry && rejectEntry, "All created opportunities must be ranked");

    // Engine states must be exactly what the persisted records say.
    assert.strictEqual(selectEntry.decision, "SELECT", "FACT-driven opportunity must be SELECT");
    assert.strictEqual(reviewEntry.decision, "NEEDS_REVIEW", "Unevaluated opportunity must be NEEDS_REVIEW");
    assert.strictEqual(rejectEntry.decision, "REJECT", "Disqualifying FACT evidence must be REJECT");

    // Ordering: SELECT above NEEDS_REVIEW above REJECT.
    assert.ok(selectEntry.rank < reviewEntry.rank, "SELECT must rank above NEEDS_REVIEW");
    assert.ok(reviewEntry.rank < rejectEntry.rank, "NEEDS_REVIEW must rank above REJECT");
    console.log("✓ Decision ordering SELECT > NEEDS_REVIEW > REJECT verified");

    // --- Different scores -------------------------------------------------
    assert.ok(
      selectEntry.score > reviewEntry.score,
      "A higher engine score must rank above a lower engine score within the same decision band"
    );
    console.log(`✓ Score ordering verified (SELECT score ${selectEntry.score} > NEEDS_REVIEW score ${reviewEntry.score})`);

    // --- Persisted truth matches ranked truth -----------------------------
    const listAfter = await getJson("/api/opportunities");
    const rowsAfter = listAfter.body.data;
    for (const entry of ranked) {
      const persisted = rowsAfter.find((r) => r.id === entry.id);
      assert.ok(persisted, `Ranked opportunity ${entry.id} must still exist`);
      assert.strictEqual(entry.verification_status, persisted.verification_status, "Verification must match persisted state");
      assert.strictEqual(entry.decision, persisted.decision, "Decision must match persisted state");
      assert.strictEqual(entry.score, persisted.score, "Score must match persisted state");
    }
    console.log("✓ Ranked fields match persisted engine outputs exactly");

    // --- Deterministic tie behaviour --------------------------------------
    // Give both records the same fully-evaluated state so they tie at the top
    // of the dataset (alongside selectOpp) and the tie-break must fall back to
    // the stable opportunity id.
    const tieA = await createOpportunity(`COMPARE tie A ${Date.now()}`);
    const tieB = await createOpportunity(`COMPARE tie B ${Date.now()}`);
    createdIds.push(tieA.id, tieB.id);
    for (const id of [tieA.id, tieB.id]) {
      await addFact(
        id,
        "Client payment verified, location eligible confirmed, owner fit confirmed"
      );
    }

    const expectedTieOrder = [tieA.id, tieB.id].sort((a, b) => String(a).localeCompare(String(b)));
    const tieCompare1 = await getJson("/api/opportunities/compare");
    const tieCompare2 = await getJson("/api/opportunities/compare");
    const tieIds1 = tieCompare1.body.data.ranked.filter((r) => r.id === tieA.id || r.id === tieB.id).map((r) => r.id);
    const tieIds2 = tieCompare2.body.data.ranked.filter((r) => r.id === tieA.id || r.id === tieB.id).map((r) => r.id);
    assert.deepStrictEqual(tieIds1, expectedTieOrder, "Identical states must tie-break by stable opportunity id");
    assert.deepStrictEqual(tieIds2, expectedTieOrder, "Tie-break must be stable across calls");

    // Three records now share the identical top state (selectOpp + tieA + tieB).
    const tiedRanked = tieCompare1.body.data.ranked;
    assert.strictEqual(tiedRanked[0].decision, "SELECT", "Tie fixture top entry must be SELECT");
    assert.strictEqual(tiedRanked[0].score, 100, "Tie fixture top entry must carry the engine score");
    assert.strictEqual(tieCompare1.body.data.tiedAtTop, true, "A shared top state must report tiedAtTop");
    assert.strictEqual(tieCompare1.body.data.topOpportunityId, tiedRanked[0].id, "topOpportunityId must be the tie-break winner");

    // tiedWithLeader must flag exactly the entries sharing the leader's state.
    const leader = tiedRanked[0];
    const stateKey = (r) =>
      `${r.decision}|${r.score}|${r.verification_status}|${r.eligibility_status}|${r.owner_fit_status}`;
    const expectedTied = tiedRanked
      .slice(1)
      .filter((r) => stateKey(r) === stateKey(leader))
      .map((r) => r.id)
      .sort();
    const actualTied = tiedRanked
      .filter((r) => r.tiedWithLeader)
      .map((r) => r.id)
      .sort();
    assert.ok(expectedTied.length > 0, "The tie fixture must produce at least one state-equal follower");
    assert.deepStrictEqual(actualTied, expectedTied, "tiedWithLeader must flag exactly the state-equal followers");
    console.log("✓ Deterministic id tie-break and tiedWithLeader semantics verified");

    // --- topOpportunityId consistency on the SELECT fixture ---------------
    assert.strictEqual(compare.body.data.topOpportunityId, ranked[0].id, "topOpportunityId must be the first ranked entry");
    assert.strictEqual(compare.body.data.comparable, ranked.length, "comparable must equal the size of the ranking");
    console.log("✓ topOpportunityId / comparable consistency verified");

    // --- Read-only verification -------------------------------------------
    // COMPARE must leave opportunities, evidence and owner profile untouched.
    const snapshot = async () => JSON.stringify({
      opportunities: (await getJson("/api/opportunities")).body,
      evidence: (await getJson("/api/evidence")).body,
      ownerProfile: (await getJson("/api/owner/profile")).body
    });
    const before = await snapshot();
    await getJson("/api/opportunities/compare");
    await getJson("/api/opportunities/compare");
    const after = await snapshot();
    assert.strictEqual(after, before, "COMPARE must not mutate opportunities, evidence or owner profile");
    console.log("✓ COMPARE is read-only (opportunities, evidence and owner profile unchanged across compare calls)");

    console.log("\nALL COMPARE STAGE TESTS PASSED SUCCESSFULLY!");
  } finally {
    // Cleanup — remove only the records this suite created.
    for (const id of createdIds) {
      await del(`/api/opportunities/${id}`);
    }
    console.log(`Cleanup complete (${createdIds.length} records removed).`);
  }
}

runCompareTests().catch((err) => {
  console.error("COMPARE stage test failure:", err);
  process.exit(1);
});