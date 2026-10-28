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
 *   3. private opportunity reads stay Owner-only at the edge.
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

function makeEnv(record) {
  const stubFetch = async (request) => {
    record.push({
      url: request.url,
      authorization: request.headers.get("Authorization"),
      ownerHeader: request.headers.get("X-Owner-Token")
    });
    if (request.headers.get("Authorization") !== `Bearer ${OWNER_TOKEN}`) {
      return Response.json(
        { ok: false, error: "Owner authorization required.", authorization: "CONFIGURED", action: "DENIED" },
        { status: 401 }
      );
    }
    if (request.url.includes("/owner/profile")) {
      return Response.json({ ok: true, data: { skills: "testing", location: "local" } });
    }
    return Response.json({
      ok: true,
      data: Array.from({ length: OPPORTUNITY_COUNT }, (_, i) => ({
        id: `opp_${i}`,
        title: `Seeded opportunity ${i}`,
        verification_status: "UNVERIFIED",
        eligibility_status: "UNKNOWN",
        owner_fit_status: "UNKNOWN",
        score: 0,
        decision: "NEEDS_REVIEW"
      }))
    });
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

  console.log(`✓ chat earning-context regression: passed (count=${OPPORTUNITY_COUNT}, credential forwarded, denials closed)`);
}

run().catch((err) => {
  console.error("✗ chat earning-context regression failed");
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
