/*
 * F1 regression: agent-route guard (WebSocket upgrade + instance-name restriction).
 *
 * LABEL: this is a MOCK/STATIC test. It copies worker.js to an OS temp directory
 * next to a stub "agents" module (the real SDK is not installed here and no
 * network is used), then calls the Worker's fetch() directly. It proves ROUTING
 * ORDER only: that the guard rejects before routeAgentRequest is reached. It does
 * NOT prove how the real Agents SDK / workerd behaves. Real-runtime verification
 * of the WebSocket surface remains BLOCKED until wrangler/workerd is available.
 *
 * No token appears in any URL, header sent over a network, or output: the only
 * credential used is a random disposable value generated in-process.
 */
import assert from "node:assert";
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const workerSrc = join(here, "..", "worker.js");
const dir = mkdtempSync(join(tmpdir(), "aira-route-guard-"));
let passed = 0, failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

try {
  copyFileSync(workerSrc, join(dir, "worker.js"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(dir, "node_modules", "agents"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "agents", "package.json"), JSON.stringify({ name: "agents", type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", "agents", "index.js"), `
    export class Agent { constructor(){} }
    globalThis.__sdkCalls = [];
    export async function routeAgentRequest(req) {
      const p = new URL(req.url).pathname;
      if (/^\\/agents(\\/|$)/i.test(p)) { globalThis.__sdkCalls.push(p); return new Response("SDK_REACHED", { status: 200 }); }
      return null;
    }
  `);
  const mod = await import(pathToFileURL(join(dir, "worker.js")).href);
  const worker = mod.default;
  const calls = () => globalThis.__sdkCalls;
  const reset = () => { globalThis.__sdkCalls.length = 0; };
  const disposable = randomUUID();
  const env = { OWNER_API_TOKEN: disposable };
  const call = (path, init = {}, e = env) => worker.fetch(new Request("https://aira.test" + path, init), e);

  console.log("Agent-route guard (MOCK stub of the agents SDK; routing order only)\n");

  console.log("--- WebSocket / protocol upgrade ---");
  for (const [label, path, headers] of [
    ["default instance, Upgrade: websocket", "/agents/master-mind-agent/default", { Upgrade: "websocket", Connection: "Upgrade" }],
    ["default instance with a sub-path", "/agents/master-mind-agent/default/state", { Upgrade: "websocket" }],
    ["upgrade on a non-agent path", "/api/chat", { Upgrade: "websocket" }],
    ["Sec-WebSocket-Key without Upgrade", "/agents/master-mind-agent/default", { "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" }],
    ["Upgrade with a valid-looking owner credential", "/agents/master-mind-agent/default", { Upgrade: "websocket", Authorization: `Bearer ${disposable}` }]
  ]) {
    await test(`${label} -> 403 and SDK not reached`, async () => {
      reset();
      const r = await call(path, { headers });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(calls().length, 0, "routeAgentRequest was reached");
      const body = await r.text();
      assert.ok(!body.includes(disposable) && !body.includes(path), "response echoed request data");
    });
  }

  console.log("\n--- Instance-name restriction ---");
  for (const path of [
    "/agents/master-mind-agent/other",
    "/agents/master-mind-agent/Default",
    "/agents/master-mind-agent/%64efault",
    "/agents/master-mind-agent/default%2Fx",
    "/agents/master-mind-agent/default%00",
    "//agents/master-mind-agent/random-instance",
    "/agents/other-agent/default",
    "/agents/master-mind-agent",
    "/agents",
    "/AGENTS/master-mind-agent/not-default"
  ]) {
    await test(`${path} -> 404 and SDK not reached`, async () => {
      reset();
      const r = await call(path, { method: "POST", body: "{}" });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(calls().length, 0, "routeAgentRequest was reached");
    });
  }

  console.log("\n--- Default instance still routed (HTTP) ---");
  for (const path of ["/agents/master-mind-agent/default", "/agents/master-mind-agent/default/chat", "/agents/MASTER-MIND-AGENT/default/opportunities"]) {
    await test(`${path} reaches the SDK router`, async () => {
      reset();
      const r = await call(path, { method: "GET" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(calls().length, 1);
    });
  }

  console.log("\n--- Existing Owner-only HTTP routes stay protected ---");
  // GET /api/owner/profile is authorised inside the Durable Object (needs the DO
  // binding); it is covered by test_owner_auth_regressions.mjs on the full mock harness.
  for (const [method, path] of [["POST", "/api/chat"], ["POST", "/api/research"]]) {
    const body = method === "POST" ? JSON.stringify({ message: "x", url: "https://example.com" }) : undefined;
    const hdr = { "Content-Type": "application/json" };
    await test(`${method} ${path} without credential -> 401`, async () => {
      assert.strictEqual((await call(path, { method, body, headers: hdr })).status, 401);
    });
    await test(`${method} ${path} with wrong credential -> 401`, async () => {
      assert.strictEqual((await call(path, { method, body, headers: { ...hdr, Authorization: "Bearer wrong" } })).status, 401);
    });
    await test(`${method} ${path} fails closed when OWNER_API_TOKEN is unconfigured -> 401`, async () => {
      assert.strictEqual((await call(path, { method, body, headers: { ...hdr, Authorization: `Bearer ${disposable}` } }, {})).status, 401);
    });
  }

  console.log("\n--- Static ordering ---");
  await test("guard is invoked before routeAgentRequest inside fetch()", async () => {
    const src = readFileSync(workerSrc, "utf8");
    const fetchStart = src.indexOf("export default {");
    const g = src.indexOf("guardAgentRoute(request)", fetchStart);
    const r = src.indexOf("routeAgentRequest(", fetchStart);
    assert.ok(g > fetchStart && r > g, `guard@${g} routeAgentRequest@${r}`);
  });
  await test("guard never logs or echoes request data", async () => {
    const src = readFileSync(workerSrc, "utf8");
    const s = src.indexOf("function guardAgentRoute");
    const body = src.slice(s, src.indexOf("export default {", s));
    assert.ok(!/console\./.test(body), "console call in guard");
    assert.ok(!/request\.url[^\n]*\bjson\b|error:\s*`/.test(body), "template echo in guard");
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log("NOT RUN (BLOCKED, needs real workerd): actual WebSocket handshake against the Agents SDK, state-sync exposure, hibernation/reconnect behaviour.");
process.exit(failed ? 1 : 0);
