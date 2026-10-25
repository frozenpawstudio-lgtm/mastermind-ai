/*
 * Owner-auth regression tests (API + real-browser UI).
 *
 * Covers: chat / research / Durable Object chat / owner profile authorization
 * (missing, invalid, valid credential); lazy profile loading on bootstrap;
 * honest "authorization required" UI states that send NO request; profile
 * refresh after successful authorization; token never persisted.
 *
 * Requires a running worker and OWNER_API_TOKEN exported. Without the token
 * the valid-credential cases are reported NOT RUN (never counted as passed).
 * The "OWNER_API_TOKEN unconfigured => fail closed" case needs a worker started
 * WITHOUT a token; it cannot be exercised by this script and is reported NOT RUN.
 */

import assert from "node:assert";
import { launchBrowser, newPage, closeBrowser, sleep } from "./ui_harness.mjs";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN || "";

let passed = 0;
let failed = 0;
let notRun = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
}
function skip(name, why) {
  notRun++;
  console.log(`  - NOT RUN: ${name} (${why})`);
}

async function call(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

console.log(`Owner-auth regression tests against ${BASE_URL}\n`);
console.log("--- API: chat / research / DO chat / profile ---");

const DO = "/agents/master-mind-agent/default";
const routes = [
  ["POST /api/chat", "/api/chat", "POST", { message: "AIRA, mujhe kamai karni hai" }],
  ["POST /api/research", "/api/research", "POST", { url: "https://example.com" }],
  ["POST DO chat", `${DO}/chat`, "POST", { message: "status?" }],
  ["GET /api/owner/profile", "/api/owner/profile", "GET"],
  ["GET DO owner profile", `${DO}/owner/profile`, "GET"]
];

for (const [label, path, method, body] of routes) {
  await test(`${label}: missing token -> 401, no data`, async () => {
    const r = await call(path, { method, body });
    assert.strictEqual(r.status, 401);
    assert.ok(!r.json || (r.json.data === undefined && r.json.answer === undefined && r.json.memoryMessages === undefined));
  });
  await test(`${label}: invalid token -> 401`, async () => {
    const r = await call(path, { method, body, token: "wrong-token-value" });
    assert.strictEqual(r.status, 401);
  });
  if (OWNER_TOKEN) {
    await test(`${label}: valid token is accepted (not 401/403)`, async () => {
      const r = await call(path, { method, body, token: OWNER_TOKEN });
      assert.ok(r.status !== 401 && r.status !== 403, `got ${r.status}`);
    });
  } else {
    skip(`${label}: valid token`, "OWNER_API_TOKEN not supplied");
  }
}

if (OWNER_TOKEN) {
  await test("DO chat: unauthenticated call does not write memory", async () => {
    const before = await call(`${DO}/chat`, { method: "POST", token: OWNER_TOKEN, body: { message: "memory baseline" } });
    assert.strictEqual(before.status, 200);
    const base = before.json.memoryMessages;
    const anon = await call(`${DO}/chat`, { method: "POST", body: { message: "anon write attempt" } });
    assert.strictEqual(anon.status, 401);
    const after = await call(`${DO}/chat`, { method: "POST", token: OWNER_TOKEN, body: { message: "memory check" } });
    assert.ok(after.json.memoryMessages <= Math.min(40, base + 2),
      `memory grew by anonymous call: ${base} -> ${after.json.memoryMessages}`);
  });
  await test("approval single-use + tamper protections still enforced", async () => {
    const opp = (await call("/api/opportunities", { method: "POST", token: OWNER_TOKEN, body: { title: "auth-regression approval probe" } })).json.data;
    const id = "appr_authreg_" + Date.now();
    const params = { approval_id: id, execute: true };
    await call("/api/approvals", { method: "POST", token: OWNER_TOKEN, body: { id, capability: "external_platform_execution", action_type: "SUBMIT", target_resource_id: opp.id, parameters: params } });
    await call(`/api/approvals/${id}/decide`, { method: "POST", token: OWNER_TOKEN, body: { decision: "APPROVED" } });
    const tamper = await call(`/api/opportunities/${opp.id}/prepare`, { method: "POST", token: OWNER_TOKEN, body: { ...params, extra: "tampered" } });
    assert.strictEqual(tamper.status, 403, "tampered parameters must be rejected");
    const used = await call(`/api/opportunities/${opp.id}/prepare`, { method: "POST", token: OWNER_TOKEN, body: params });
    assert.strictEqual(used.status, 200);
    const reuse = await call(`/api/opportunities/${opp.id}/prepare`, { method: "POST", token: OWNER_TOKEN, body: params });
    assert.strictEqual(reuse.status, 403, "consumed approval must not be reusable");
    await call(`/api/opportunities/${opp.id}`, { method: "DELETE", token: OWNER_TOKEN });
  });
}
skip("fail-closed when OWNER_API_TOKEN is unconfigured", "needs a worker started without a token; not exercisable here");

console.log("\n--- UI: lazy profile, authorization-required states ---");

const browser = await launchBrowser({ windowWidth: 390, windowHeight: 900 });
try {
  const page = await newPage(browser, { width: 390, height: 844 });
  // Record every fetch made by the page (path + whether a credential header was attached).
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { window.__reqs = []; const f = window.fetch; window.fetch = function (u, o) {
      try { const h = (o && o.headers) || {}; window.__reqs.push({ path: String(u), auth: !!(h.Authorization || h["X-Owner-Token"]) }); } catch (e) {}
      return f.apply(this, arguments); }; })();`
  });
  await page.goto(`${BASE_URL}/`, { settleMs: 1800 });
  const reqs = () => page.evaluate(`window.__reqs.map(r => r.path + (r.auth ? ' [auth]' : ''))`);
  const count = (list, needle) => list.filter((p) => p.includes(needle)).length;
  const nav = async (s) => { await page.evaluate(`document.querySelector('#dock button[data-nav="${s}"]').click()`); await sleep(900); };

  await test("bootstrap without a token does not fetch /api/owner/profile", async () => {
    assert.strictEqual(count(await reqs(), "/api/owner/profile"), 0);
  });

  await test("Profile screen says authorization required (not 'unavailable') and sends no profile request", async () => {
    await nav("profile");
    const txt = await page.evaluate(`document.getElementById('profile-fields').innerText`);
    assert.ok(/AUTHORIZATION REQUIRED/i.test(txt), txt);
    assert.ok(!/PROFILE UNAVAILABLE/i.test(txt), txt);
    assert.strictEqual(count(await reqs(), "/api/owner/profile"), 0);
  });

  await test("Chat without a token shows authorization-required and sends NO /api/chat request", async () => {
    await nav("chat");
    await page.evaluate(`document.getElementById('chat-input').value = 'AIRA, mujhe kamai karni hai'; document.getElementById('chat-send').click();`);
    await sleep(700);
    const log = await page.evaluate(`document.getElementById('chat-log') ? document.getElementById('chat-log').innerText : document.body.innerText`);
    assert.ok(/Owner authorization required/i.test(log), log.slice(-300));
    assert.strictEqual(count(await reqs(), "/api/chat"), 0);
  });

  await test("Research without a token shows authorization-required and sends NO /api/research request", async () => {
    await page.evaluate(`document.querySelector('#dock button[data-nav="tasks"]').click()`);
    await sleep(500);
    await page.evaluate(`document.querySelector('#subnav button[data-sub="research"]').click()`);
    await sleep(700);
    await page.evaluate(`document.getElementById('research-url').value = 'https://example.com'; document.getElementById('research-run').click();`);
    await sleep(600);
    const txt = await page.evaluate(`document.getElementById('research-result').innerText`);
    assert.ok(/AUTHORIZATION REQUIRED/i.test(txt), txt);
    assert.strictEqual(count(await reqs(), "/api/research"), 0);
  });

  await test("invalid token is rejected and still triggers no profile request", async () => {
    await page.evaluate(`document.getElementById('owner-token').value = 'definitely-wrong-token'; document.getElementById('owner-auth-save').click();`);
    await sleep(900);
    assert.strictEqual(count(await reqs(), "/api/owner/profile"), 0);
    assert.strictEqual(await page.evaluate(`document.getElementById('owner-token').value`), "");
  });

  if (OWNER_TOKEN) {
    await test("valid token: profile is fetched (with credential) only after authorization", async () => {
      const before = count(await reqs(), "/api/owner/profile");
      await page.evaluate(`document.getElementById('owner-token').value = ${JSON.stringify(OWNER_TOKEN)}; document.getElementById('owner-auth-save').click();`);
      await sleep(1500);
      const list = await reqs();
      assert.ok(count(list, "/api/owner/profile [auth]") > before, JSON.stringify(list.slice(-6)));
      await nav("profile");
      const txt = await page.evaluate(`document.getElementById('profile-fields').innerText`);
      assert.ok(!/AUTHORIZATION REQUIRED/i.test(txt), txt);
    });

    await test("valid token: chat now sends /api/chat with the credential", async () => {
      await nav("chat");
      await page.evaluate(`document.getElementById('chat-input').value = 'status check'; document.getElementById('chat-send').click();`);
      await sleep(1500);
      assert.ok(count(await reqs(), "/api/chat [auth]") >= 1);
    });

    await test("token is never persisted (localStorage, sessionStorage, cookie, URL)", async () => {
      const blob = await page.evaluate(`JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie, location.href])`);
      assert.ok(!blob.includes(OWNER_TOKEN), "token found in browser storage or URL");
    });

    await test("clearing the credential returns Profile to authorization-required", async () => {
      await page.evaluate(`document.getElementById('owner-auth-clear').click()`);
      await sleep(600);
      await nav("profile");
      const txt = await page.evaluate(`document.getElementById('profile-fields').innerText`);
      assert.ok(/AUTHORIZATION REQUIRED/i.test(txt), txt);
    });
  } else {
    skip("UI valid-token cases (profile refresh, chat with credential, persistence, clear)", "OWNER_API_TOKEN not supplied");
  }
  await page.close();
} finally {
  await closeBrowser(browser);
}

console.log(`\n${passed} passed, ${failed} failed, ${notRun} not run`);
process.exit(failed > 0 ? 1 : 0);
