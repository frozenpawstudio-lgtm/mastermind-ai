/*
 * Seeds a small, clearly-labelled demonstration record through the real API so
 * the Earning Agent screen can be reviewed with a populated card.
 *
 * This creates LOCAL persisted state only. It does not deploy anything, does
 * not touch production, and every record it creates is marked source
 * "screenshot-seed" and removed by the matching cleanup run.
 *
 * Usage:
 *   node test/seed_demo_record.mjs          # create
 *   node test/seed_demo_record.mjs --clean  # remove
 */

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const headers = { "Content-Type": "application/json" };
if (OWNER_TOKEN) headers.Authorization = `Bearer ${OWNER_TOKEN}`;

const SOURCE = "screenshot-seed";

async function json(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function clean() {
  const list = await json("/api/opportunities");
  const rows = Array.isArray(list.body?.data) ? list.body.data : [];
  const mine = rows.filter((r) => r.source === SOURCE);
  for (const row of mine) {
    await json(`/api/opportunities/${row.id}`, { method: "DELETE", headers });
  }
  console.log(`cleanup: removed ${mine.length} seeded record(s)`);
}

async function seed() {
  const existing = await json("/api/opportunities");
  const rows = Array.isArray(existing.body?.data) ? existing.body.data : [];
  if (rows.some((r) => r.source === SOURCE)) {
    console.log("seed: a demonstration record already exists, nothing to do");
    return;
  }

  const created = await json("/api/opportunities", {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: SOURCE,
      title: "Cloudflare Workers + Durable Objects integration (demonstration record)",
      url: "https://developers.cloudflare.com/durable-objects/",
      platform: "Direct",
      description:
        "Demonstration record for UI review. It is a real persisted row, not a claim of earnings. Add FACT evidence to move it through VERIFY -> ELIGIBILITY -> OWNER FIT -> SCORE.",
      earning_model: "Fixed price (not confirmed)",
      cost: "NOT CONFIRMED",
      risk: "NOT ASSESSED",
      effort: "NOT ASSESSED"
    })
  });

  if (created.status !== 201) {
    console.log(`seed: could not create the record (HTTP ${created.status}). ${created.body?.error || ""}`);
    console.log("seed: the permission foundation requires the Owner credential on mutations.");
    return;
  }

  const id = created.body.data.id;
  console.log(`seed: created opportunity ${id}`);

  // One FACT evidence record from a real, checkable source. This is what lets
  // the deterministic chain legitimately reach VERIFIED / ELIGIBLE / FIT.
  const evidence = await json(`/api/opportunities/${id}/evidence`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      classification: "FACT",
      source: "https://developers.cloudflare.com/durable-objects/",
      content:
        "Cloudflare Durable Objects provide strongly consistent storage and coordination. This record is used only to demonstrate the verification chain in the operator console."
    })
  });
  console.log(`seed: evidence -> HTTP ${evidence.status}`);

  const decision = await json(`/api/opportunities/${id}/decision`, { method: "POST", headers, body: "{}" });
  console.log(`seed: decision -> ${decision.body?.data?.decision} score ${decision.body?.data?.score}`);
}

if (process.argv.includes("--clean")) await clean();
else await seed();
