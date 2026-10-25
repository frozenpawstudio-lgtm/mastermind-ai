import assert from "node:assert";

/*
 * Phase 1 Earning Agent regression tests:
 *  1. eligibility / owner-fit must not accept negated or unresolved evidence
 *  2. legacy /api/chat must receive the persisted earning context (await fix)
 *  3. opportunity / evidence / owner-profile mutations write audit records
 *  4. approval single-use under concurrent use, tampering, reuse
 *
 * Requires a running worker and OWNER_API_TOKEN. Case 2 needs the mock-harness
 * endpoint /__mock/prompts (it cannot be observed through the real API) and is
 * reported NOT RUN when that endpoint is absent. Nothing here proves real
 * workerd behaviour.
 */

const BASE = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const TOKEN = process.env.OWNER_API_TOKEN || "";
let passed = 0, failed = 0, notRun = 0;

async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, data: json && json.data };
}
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function skip(name, why) { notRun++; console.log(`  - NOT RUN: ${name} (${why})`); }

if (!TOKEN) { console.log("OWNER_API_TOKEN not supplied: NOT RUN"); process.exit(1); }
const created = [];
const mkOpp = async (title, extra = {}) => {
  const r = await api("/api/opportunities", { method: "POST", body: { title, ...extra } });
  assert.strictEqual(r.status, 201, `create opportunity: ${r.status}`);
  created.push(r.data.id);
  return r.data;
};
const addFact = (id, content) => api("/api/evidence", { method: "POST", body: { opportunity_id: id, classification: "FACT", source: "regression", content } });

console.log(`Phase 1 regression tests against ${BASE}\n`);

try {
  console.log("--- 1. Eligibility / owner-fit text handling ---");
  const negElig = ["Owner is NOT YET eligible", "eligibility not verified", "eligible: no", "eligibility pending", "eligibility unclear"];
  for (const text of negElig) {
    await test(`eligibility not ELIGIBLE for "${text}"`, async () => {
      const o = await mkOpp("elig-neg " + text);
      await addFact(o.id, text);
      const r = await api(`/api/opportunities/${o.id}/eligibility`, { method: "POST", body: {} });
      assert.notStrictEqual(r.data.status, "ELIGIBLE", JSON.stringify(r.data).slice(0, 200));
    });
  }
  const negFit = ["fit NO", "owner fit not verified", "fit: no", "fit pending", "fit unclear", "Owner fit confirmed? NO"];
  for (const text of negFit) {
    await test(`owner-fit not FIT for "${text}"`, async () => {
      const o = await mkOpp("fit-neg " + text);
      await addFact(o.id, text);
      const r = await api(`/api/opportunities/${o.id}/owner-fit`, { method: "POST", body: {} });
      assert.notStrictEqual(r.data.status, "FIT", JSON.stringify(r.data).slice(0, 200));
    });
  }
  await test("contradictory negative evidence never yields SELECT", async () => {
    const o = await mkOpp("contradiction probe");
    await addFact(o.id, "Owner is NOT YET eligible; requirements unclear.");
    await addFact(o.id, "Owner fit confirmed? NO - not verified yet.");
    const r = await api(`/api/opportunities/${o.id}/decision`, { method: "POST", body: {} });
    assert.notStrictEqual(r.data.decision, "SELECT", JSON.stringify(r.data).slice(0, 200));
  });
  await test("positive controls still work: 'eligibility confirmed' -> ELIGIBLE, 'fit confirmed' -> FIT", async () => {
    const o = await mkOpp("positive control");
    await addFact(o.id, "eligibility confirmed by platform terms page");
    await addFact(o.id, "owner fit confirmed against profile");
    const e = await api(`/api/opportunities/${o.id}/eligibility`, { method: "POST", body: {} });
    const f = await api(`/api/opportunities/${o.id}/owner-fit`, { method: "POST", body: {} });
    assert.strictEqual(e.data.status, "ELIGIBLE");
    assert.strictEqual(f.data.status, "FIT");
  });

  console.log("\n--- 2. Legacy /api/chat earning context ---");
  const probe = await fetch(BASE + "/__mock/prompts").catch(() => null);
  if (probe && probe.ok) {
    await test("legacy /api/chat prompt carries saved opportunities (status is not {})", async () => {
      const title = "ctx-probe-" + Date.now();
      await mkOpp(title);
      const r = await api("/api/chat", { method: "POST", body: { message: "AIRA, mujhe kamai karni hai" } });
      assert.strictEqual(r.status, 200);
      const prompts = await (await fetch(BASE + "/__mock/prompts")).json();
      const last = String(prompts[prompts.length - 1] || "");
      assert.ok(last.includes(title), "saved opportunity title missing from the model prompt");
    });
  } else {
    skip("legacy /api/chat context reaches the model", "needs mock-harness /__mock/prompts; not observable via the real API");
  }

  console.log("\n--- 3. Audit records for mutations ---");
  const auditCount = async (action) => {
    const r = await api("/api/audit-logs?action=" + encodeURIComponent(action));
    return Array.isArray(r.data) ? r.data.filter((x) => x.action === action).length : -1;
  };
  const expectAudit = async (action, fn) => {
    const before = await auditCount(action);
    await fn();
    const after = await auditCount(action);
    assert.ok(before >= 0 && after === before + 1, `${action}: ${before} -> ${after}`);
  };
  let oid, eid;
  await test("create opportunity writes OPPORTUNITY_CREATED", async () => {
    await expectAudit("OPPORTUNITY_CREATED", async () => { oid = (await mkOpp("audit probe")).id; });
  });
  await test("update opportunity writes OPPORTUNITY_UPDATED", async () => {
    await expectAudit("OPPORTUNITY_UPDATED", async () => { await api(`/api/opportunities/${oid}`, { method: "PUT", body: { notes: "x" } }); });
  });
  await test("create evidence writes EVIDENCE_CREATED", async () => {
    await expectAudit("EVIDENCE_CREATED", async () => { const r = await addFact(oid, "audit evidence"); eid = r.data && r.data.id; });
  });
  await test("delete evidence writes EVIDENCE_DELETED", async () => {
    await expectAudit("EVIDENCE_DELETED", async () => { await api(`/api/evidence/${eid}`, { method: "DELETE" }); });
  });
  await test("owner profile write writes OWNER_PROFILE_UPDATED without leaking values", async () => {
    const secretish = "UNIQUE_PROFILE_VALUE_" + Date.now();
    await expectAudit("OWNER_PROFILE_UPDATED", async () => { await api("/api/owner/profile", { method: "POST", body: { skills: secretish } }); });
    const logs = await api("/api/audit-logs?action=OWNER_PROFILE_UPDATED");
    assert.ok(!JSON.stringify(logs.data).includes(secretish), "profile value leaked into audit details");
  });
  await test("delete opportunity writes OPPORTUNITY_DELETED", async () => {
    await expectAudit("OPPORTUNITY_DELETED", async () => { await api(`/api/opportunities/${oid}`, { method: "DELETE" }); });
  });
  await test("audit log stays append-only (PUT/DELETE rejected)", async () => {
    const d = await api("/api/audit-logs", { method: "DELETE" });
    const p = await api("/api/audit-logs", { method: "PUT", body: {} });
    assert.strictEqual(d.status, 405); assert.strictEqual(p.status, 405);
  });

  console.log("\n--- 4. Approval single-use ---");
  const mkApproval = async (oppId, params) => {
    const id = "appr_p1_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    const p = { approval_id: id, execute: true, ...(params || {}) };
    await api("/api/approvals", { method: "POST", body: { id, capability: "external_platform_execution", action_type: "SUBMIT", target_resource_id: oppId, parameters: p } });
    await api(`/api/approvals/${id}/decide`, { method: "POST", body: { decision: "APPROVED" } });
    return { id, params: p };
  };
  await test("20 concurrent uses of one approval -> exactly one success, status CONSUMED, one APPROVAL_CONSUMED audit", async () => {
    const o = await mkOpp("concurrency probe");
    const a = await mkApproval(o.id);
    const before = await auditCount("APPROVAL_CONSUMED");
    const rs = await Promise.all(Array.from({ length: 20 }, () => api(`/api/opportunities/${o.id}/prepare`, { method: "POST", body: a.params })));
    assert.strictEqual(rs.filter((r) => r.status === 200).length, 1, rs.map((r) => r.status).join(","));
    assert.strictEqual(rs.filter((r) => r.status === 403).length, 19);
    assert.strictEqual((await api(`/api/approvals/${a.id}`)).data.status, "CONSUMED");
    assert.strictEqual((await auditCount("APPROVAL_CONSUMED")) - before, 1);
  });
  await test("tampered parameters rejected and approval stays APPROVED", async () => {
    const o = await mkOpp("tamper probe");
    const a = await mkApproval(o.id);
    const r = await api(`/api/opportunities/${o.id}/prepare`, { method: "POST", body: { ...a.params, extra: "tampered" } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await api(`/api/approvals/${a.id}`)).data.status, "APPROVED");
  });
  await test("consumed approval cannot be reused", async () => {
    const o = await mkOpp("reuse probe");
    const a = await mkApproval(o.id);
    assert.strictEqual((await api(`/api/opportunities/${o.id}/prepare`, { method: "POST", body: a.params })).status, 200);
    assert.strictEqual((await api(`/api/opportunities/${o.id}/prepare`, { method: "POST", body: a.params })).status, 403);
  });
  skip("consume fails closed when the SQL layer cannot confirm the claimed row", "needs a SQL layer without RETURNING support; not injectable over HTTP");
  skip("true parallel double-consume on the Durable Object runtime", "needs real workerd; the mock SQL layer is synchronous");
} finally {
  for (const id of created) await api(`/api/opportunities/${id}`, { method: "DELETE" }).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed, ${notRun} not run`);
process.exit(failed ? 1 : 0);
