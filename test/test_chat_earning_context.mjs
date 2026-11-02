import assert from "node:assert";
import { register } from "node:module";

/*
 * Regression test for the /api/chat earning-context path.
 *
 * Defect: buildEarningContextForEnv() read the opportunity list and Owner
 * profile from the Durable Object with a credential-less internal request.
 * Once those reads became Owner-only, the DO answered 401, so the model was
 * told "0 opportunities" no matter what was persisted. The call site also
 * omitted `await`, so the resolved context never reached the model at all.
 *
 * This test drives the real edge handler in-process with a fake AI binding
 * (no billed Workers AI) and a fake Durable Object stub that records the
 * request headers it receives. It asserts:
 *   1. the authorized chat path forwards the credential and the model prompt
 *      carries the real opportunity count + Owner profile;
 *   2. an unauthenticated chat call fails closed and never reaches the DO;
 *   3. private opportunity reads stay Owner-only at the edge;
 *   4. the DO read states stay distinguishable: successful authorized read,
 *      empty-but-retrieved data, invalid credential, failed read, missing
 *      profile and unreadable payload. A failed read must never be reported as
 *      a genuine zero-opportunity result.
 */

const OWNER_TOKEN = "regression-test-owner-token";
const OPPORTUNITY_COUNT = 2;

// Replace the "agents" dependency with a minimal stub so worker.js can be
// imported in plain Node without the Cloudflare runtime.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec === "agents") return { url: "stub:agents", shortCircuit: true };
        return next(spec, ctx);
      }
      export async function load(url, ctx, next) {
        if (url === "stub:agents") {
          return {
            format: "module",
            shortCircuit: true,
            source: \`
              export class Agent {
                constructor(ctx, env) { this.ctx = ctx; this.env = env; }
              }
              export function routeAgentRequest() { return null; }
            \`
          };
        }
        return next(url, ctx);
      }
    `)
);

const worker = await import(process.env.WORKER_PATH || "../worker.js");

function makeEnv(record, opts = {}) {
  const {
    opportunitiesStatus = 200,
    opportunitiesData = null, // null => default seeded list
    profileStatus = 200,
    profileData = { skills: "testing", location: "local" },
    opportunitiesUnreadable = false,
    requireAuth = true
  } = opts;

  const stubFetch = async (request) => {
    record.push({
      url: request.url,
      authorization: request.headers.get("Authorization"),
      ownerHeader: request.headers.get("X-Owner-Token")
    });
    // The shared rate-limit authority is a separate DO route, not one of the
    // data reads under test, so it always allows here. Without this the
    // limiter would (correctly) fail closed whenever a read-failure status is
    // simulated for every URL, and the read-state matrix could not run.
    if (request.url.includes("/rate-limit/check")) {
      return Response.json({ ok: true, allowed: true, count: 1, limit: 30, remaining: 29, retryAfter: 60 });
    }
    if (requireAuth && request.headers.get("Authorization") !== `Bearer ${OWNER_TOKEN}`) {
      return Response.json(
        { ok: false, error: "Owner authorization required.", authorization: "CONFIGURED", action: "DENIED" },
        { status: 401 }
      );
    }
    if (request.url.includes("/owner/profile")) {
      if (profileStatus !== 200) {
        return Response.json({ ok: false, error: "profile read failed" }, { status: profileStatus });
      }
      return Response.json({ ok: true, data: profileData });
    }
    if (opportunitiesStatus !== 200) {
      return Response.json({ ok: false, error: "opportunity read failed" }, { status: opportunitiesStatus });
    }
    if (opportunitiesUnreadable) {
      return new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    const data =
      opportunitiesData !== null
        ? opportunitiesData
        : Array.from({ length: OPPORTUNITY_COUNT }, (_, i) => ({
            id: `opp_${i}`,
            title: `Seeded opportunity ${i}`,
            verification_status: "UNVERIFIED",
            eligibility_status: "UNKNOWN",
            owner_fit_status: "UNKNOWN",
            score: 0,
            decision: "NEEDS_REVIEW"
          }));
    return Response.json({ ok: true, data });
  };

  return {
    OWNER_API_TOKEN: OWNER_TOKEN,
    MasterMindAgent: {
      idFromName: (name) => name,
      get: () => ({ fetch: stubFetch })
    },
    AI: {
      run: async (model, { prompt }) => {
        record.prompt = prompt;
        return { response: "ack" };
      }
    },
    ASSETS: { fetch: async () => new Response("asset") }
  };
}

async function chat(env) {
  return worker.default.fetch(
    new Request("https://local.test/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER_TOKEN}` },
      body: JSON.stringify({ message: "Show me earning opportunities" })
    }),
    env
  );
}

function countFrom(prompt) {
  const m = String(prompt).match(/"opportunityCount":\s*("[^"]*"|\d+)/);
  return m ? m[1].replace(/^"|"$/g, "") : null;
}

async function run() {
  // --- 1. Authorized chat carries the real context ------------------------
  const record = [];
  const env = makeEnv(record);
  const res = await worker.default.fetch(
    new Request("https://local.test/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER_TOKEN}` },
      body: JSON.stringify({ message: "Show me earning opportunities" })
    }),
    env
  );
  assert.strictEqual(res.status, 200, "authorized chat must respond 200");

  assert.ok(
    record.some((c) => c.authorization === `Bearer ${OWNER_TOKEN}`),
    "internal DO read must forward the caller credential"
  );
  assert.ok(
    record.every((c) => !c.url.includes(OWNER_TOKEN)),
    "credential must never appear in the internal request URL"
  );

  assert.ok(typeof record.prompt === "string", "the model prompt must be captured");
  assert.ok(
    record.prompt.includes(`"opportunityCount": ${OPPORTUNITY_COUNT}`),
    `model prompt must carry the real opportunity count (${OPPORTUNITY_COUNT})`
  );
  assert.ok(
    record.prompt.includes(`"opportunities": [`),
    "model prompt must carry the opportunity list, not an empty status"
  );
  assert.ok(
    !record.prompt.includes("AUTHORITATIVE STATUS (undefined)"),
    "the resolved status object must reach the model, not a pending Promise"
  );

  // --- 2. Unauthenticated chat fails closed and never touches the DO ------
  const deniedRecord = [];
  const deniedEnv = makeEnv(deniedRecord);
  const denied = await worker.default.fetch(
    new Request("https://local.test/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Show me earning opportunities" })
    }),
    deniedEnv
  );
  assert.strictEqual(denied.status, 401, "unauthenticated chat must fail closed");
  assert.strictEqual(deniedRecord.length, 0, "an unauthorized chat must not reach the DO");
  assert.strictEqual(deniedRecord.prompt, undefined, "an unauthorized chat must not call the AI binding");

  // --- 3. Private opportunity reads stay Owner-only at the edge -----------
  const pubRecord = [];
  const pubEnv = makeEnv(pubRecord);
  const listDenied = await worker.default.fetch(
    new Request("https://local.test/api/opportunities"),
    pubEnv
  );
  assert.strictEqual(listDenied.status, 401, "unauthenticated opportunity list must fail closed");
  assert.strictEqual(pubRecord.length, 0, "an unauthorized list read must not reach the DO");

  // --- 4. Read-state matrix: a failed read must not look like an empty one --
  // Empty but successfully retrieved: a real zero.
  const emptyRecord = [];
  const emptyRes = await chat(makeEnv(emptyRecord, { opportunitiesData: [] }));
  assert.strictEqual(emptyRes.status, 200, "empty-but-retrieved chat must respond 200");
  assert.strictEqual(countFrom(emptyRecord.prompt), "0", "an authorized empty read must report a genuine 0");

  // Failed read (authorization/internal error) must be DATA NOT AVAILABLE, not 0.
  for (const status of [401, 500]) {
    const failedRecord = [];
    const failedRes = await chat(makeEnv(failedRecord, { opportunitiesStatus: status }));
    assert.strictEqual(failedRes.status, 200, `chat must still answer when the DO read returns ${status}`);
    assert.strictEqual(
      countFrom(failedRecord.prompt),
      "DATA NOT AVAILABLE",
      `a failed opportunity read (${status}) must be DATA NOT AVAILABLE, never a silent 0`
    );
    assert.ok(
      failedRecord.prompt.includes('"opportunitiesReadStatus": "FAILED"'),
      `a failed opportunity read (${status}) must report opportunitiesReadStatus FAILED`
    );
  }

  // Unreadable 200 payload (not JSON) must also be DATA NOT AVAILABLE.
  const badJsonRecord = [];
  await chat(makeEnv(badJsonRecord, { opportunitiesUnreadable: true }));
  assert.strictEqual(
    countFrom(badJsonRecord.prompt),
    "DATA NOT AVAILABLE",
    "an unreadable payload must be DATA NOT AVAILABLE, never a silent 0"
  );
  assert.ok(
    badJsonRecord.prompt.includes('"opportunitiesReadStatus": "UNREADABLE"'),
    "an unreadable payload must report opportunitiesReadStatus UNREADABLE"
  );

  // Missing Owner profile: opportunities still readable, profile reported absent.
  const noProfileRecord = [];
  const noProfileRes = await chat(makeEnv(noProfileRecord, { profileStatus: 404 }));
  assert.strictEqual(noProfileRes.status, 200, "chat must answer when the Owner profile read fails");
  assert.strictEqual(countFrom(noProfileRecord.prompt), String(OPPORTUNITY_COUNT), "opportunities stay readable without a profile");
  assert.ok(
    noProfileRecord.prompt.includes('"ownerProfileReadStatus": "FAILED"'),
    "a failed Owner profile read must be reported, not silently dropped"
  );
  assert.ok(
    noProfileRecord.prompt.includes('"ownerProfile": null'),
    "a failed Owner profile read must not fabricate profile data"
  );

  // Missing DO binding entirely: the shared rate-limit authority lives in
  // that DO, so chat must fail closed with a generic error rather than run
  // unmetered. No AI call may happen, and no internal detail may leak.
  const noDoRecord = [];
  const noDoRes = await worker.default.fetch(
    new Request("https://local.test/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER_TOKEN}` },
      body: JSON.stringify({ message: "Show me earning opportunities" })
    }),
    { OWNER_API_TOKEN: OWNER_TOKEN, AI: { run: async (m, { prompt }) => { noDoRecord.prompt = prompt; return { response: "ack" }; } }, ASSETS: { fetch: async () => new Response("a") } }
  );
  assert.strictEqual(noDoRes.status, 500, "chat must fail closed when the limiter authority is unavailable");
  assert.strictEqual(noDoRecord.prompt, undefined, "an unmetered chat must not call the AI binding");
  const noDoBody = await noDoRes.json();
  assert.ok(!noDoBody.details, "the fail-closed error must not expose internal details");
  assert.ok(!JSON.stringify(noDoBody).toLowerCase().includes("sql"), "the fail-closed error must not expose storage internals");

  console.log(
    `✓ chat earning-context regression: passed (count=${OPPORTUNITY_COUNT}, credential forwarded, ` +
      `denials closed, read states honest: 0 vs DATA NOT AVAILABLE)`
  );
}

run().catch((err) => {
  console.error("✗ chat earning-context regression failed");
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
