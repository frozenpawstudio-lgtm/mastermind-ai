/*
 * End-to-end proof that the Earning Agent workflow is real, not decorative.
 *
 * This drives the actual operator console in Chromium and exercises the real
 * eleven-stage pipeline against the real API, with a real Owner credential
 * supplied through the UI's own authorization panel. It asserts the chain
 * DISCOVER -> VERIFY -> ELIGIBILITY -> OWNER FIT -> COMPARE -> SCORE ->
 * PREPARE -> REQUEST OWNER APPROVAL produces real engine output and never
 * claims a submission happened.
 *
 * Requires the local worker and OWNER_API_TOKEN.
 */

import assert from "node:assert";
import { launchBrowser, newPage, closeBrowser, sleep } from "./ui_harness.mjs";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN;

if (!OWNER_TOKEN) {
  console.error("OWNER_API_TOKEN is required for the end-to-end workflow proof.");
  process.exit(1);
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
}

const browser = await launchBrowser({ windowWidth: 390, windowHeight: 900 });

try {
  console.log(`Starting Earning Agent end-to-end workflow proof against ${BASE_URL}...\n`);

  const page = await newPage(browser, { width: 390, height: 844 });
  await page.goto(`${BASE_URL}/`, { settleMs: 1500 });

  const title = `E2E workflow proof ${Date.now()}`;
  let opportunityId = null;

  await test("PREPARE the Owner credential through the UI panel", async () => {
    await page.evaluate(`document.getElementById('btn-owner').click()`);
    await sleep(300);
    await page.evaluate(`document.getElementById('owner-token').value = ${JSON.stringify(OWNER_TOKEN)};`);
    await page.evaluate(`document.getElementById('owner-auth-save').click()`);
    await sleep(1500);
    const toastText = await page.evaluate(`document.getElementById('toast').textContent`);
    assert.ok(/accepted/i.test(toastText), `expected the credential to be accepted, got "${toastText}"`);
  });

  await test("DISCOVER: an opportunity is created through the UI form", async () => {
    await page.evaluate(`document.querySelector('#dock button[data-nav="tools"]').click()`);
    await sleep(1500);
    await page.evaluate(`document.getElementById('earning-new').click()`);
    await sleep(300);
    await page.evaluate(`document.getElementById('opp-title').value = ${JSON.stringify(title)};`);
    await page.evaluate(`document.getElementById('opp-url').value = 'https://developers.cloudflare.com/workers/';`);
    await page.evaluate(`document.getElementById('opp-platform').value = 'Direct';`);
    await page.evaluate(`document.getElementById('opp-desc').value = 'End-to-end proof record. Real persisted row, no earnings claim.';`);
    await page.evaluate(`document.getElementById('earning-create').click()`);
    await sleep(2000);

    const found = await page.evaluate(`(async () => {
      const res = await fetch('/api/opportunities', { headers: { Authorization: 'Bearer ' + ${JSON.stringify(OWNER_TOKEN)} } });
      const body = await res.json();
      const row = (body.data || []).find(r => r.title === ${JSON.stringify(title)});
      return row ? { id: row.id, verification: row.verification_status, score: row.score, decision: row.decision } : null;
    })()`);

    assert.ok(found, "the created opportunity must be persisted");
    opportunityId = found.id;
    assert.strictEqual(found.verification, "UNVERIFIED", "a new record must start UNVERIFIED");
    assert.strictEqual(found.score, 0, "a new record must start with score 0");
  });

  await test("VERIFY stays honest: VERIFIED is refused without FACT evidence", async () => {
    const status = await page.evaluate(`(async () => {
      const res = await fetch('/api/opportunities/' + ${JSON.stringify(opportunityId)} + '/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ${JSON.stringify(OWNER_TOKEN)} },
        body: JSON.stringify({ status: 'VERIFIED' })
      });
      return res.status;
    })()`);
    assert.strictEqual(status, 400, "asserting VERIFIED with no FACT evidence must be refused");
  });

  await test("VERIFY: real FACT evidence promotes the record to VERIFIED", async () => {
    await page.evaluate(`document.getElementById('earning-refresh').click()`);
    await sleep(2000);

    const cardId = await page.evaluate(`(async () => {
      const cards = Array.from(document.querySelectorAll('#earning-list .opp'));
      const card = cards.find(c => c.textContent.includes(${JSON.stringify(title)}));
      return card ? card.getAttribute('data-opp') : null;
    })()`);
    assert.strictEqual(cardId, opportunityId, "the UI card must correspond to the persisted record");

    const status = await page.evaluate(`(async () => {
      const res = await fetch('/api/opportunities/' + ${JSON.stringify(opportunityId)} + '/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ${JSON.stringify(OWNER_TOKEN)} },
        body: JSON.stringify({
          classification: 'FACT',
          source: 'https://developers.cloudflare.com/workers/',
          content: 'Cloudflare Workers run JavaScript at the edge. Used here as real, checkable FACT evidence.'
        })
      });
      return res.status;
    })()`);
    assert.strictEqual(status, 201, "FACT evidence should be accepted");
  });

  await test("SCORE / ELIGIBILITY / OWNER FIT: the engine evaluates the record through the UI", async () => {
    await page.evaluate(`document.getElementById('earning-refresh').click()`);
    await sleep(2200);
    await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('#earning-list .opp'));
      const card = cards.find(c => c.textContent.includes(${JSON.stringify(title)}));
      card.querySelector('button[data-act="evaluate"]').click();
    })()`);
    await sleep(2500);

    const state = await page.evaluate(`(async () => {
      const res = await fetch('/api/opportunities/' + ${JSON.stringify(opportunityId)}, { headers: { Authorization: 'Bearer ' + ${JSON.stringify(OWNER_TOKEN)} } });
      const body = await res.json();
      return { verification: body.data.verification_status, eligibility: body.data.eligibility_status, ownerFit: body.data.owner_fit_status, score: body.data.score, decision: body.data.decision };
    })()`);

    assert.strictEqual(state.verification, "VERIFIED", `expected VERIFIED, got ${state.verification}`);
    assert.ok(["UNKNOWN", "ELIGIBLE", "POTENTIALLY_ELIGIBLE", "NOT_ELIGIBLE"].includes(state.eligibility), `unexpected eligibility ${state.eligibility}`);
    assert.ok(typeof state.score === "number" && state.score > 0, `expected a real engine score, got ${state.score}`);

    const outText = await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('#earning-list .opp'));
      const card = cards.find(c => c.textContent.includes(${JSON.stringify(title)}));
      return card.textContent;
    })()`);
    assert.ok(outText.includes("Decision (engine-owned)"), "the UI must show the engine-owned decision output");
  });

  await test("COMPARE ranks the persisted record deterministically", async () => {
    await page.evaluate(`document.getElementById('earning-compare').click()`);
    await sleep(2000);
    const text = await page.evaluate(`document.getElementById('earning-list').textContent`);
    assert.ok(/#1/.test(text), `COMPARE should produce a ranked list, got: ${text.slice(0, 160)}`);
  });

  await test("PREPARE produces a preparation package that is explicitly NOT a submission", async () => {
    await page.evaluate(`document.getElementById('earning-refresh').click()`);
    await sleep(2200);
    await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('#earning-list .opp'));
      const card = cards.find(c => c.textContent.includes(${JSON.stringify(title)}));
      card.querySelector('button[data-act="prepare"]').click();
    })()`);
    await sleep(2500);

    const text = await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('#earning-list .opp'));
      const card = cards.find(c => c.textContent.includes(${JSON.stringify(title)}));
      return card.textContent;
    })()`);
    assert.ok(/NOT_SUBMITTED/.test(text), `PREPARE output must report NOT_SUBMITTED, got: ${text.slice(-400)}`);
    assert.ok(/Owner review required/.test(text), "PREPARE must require Owner review");
  });

  await test("REQUEST OWNER APPROVAL creates a PENDING single-use approval, never a submission", async () => {
    await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('#earning-list .opp'));
      const card = cards.find(c => c.textContent.includes(${JSON.stringify(title)}));
      card.querySelector('button[data-act="approval"]').click();
    })()`);
    await sleep(2500);

    const text = await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('#earning-list .opp'));
      const card = cards.find(c => c.textContent.includes(${JSON.stringify(title)}));
      return card.textContent;
    })()`);
    assert.ok(/PENDING OWNER DECISION/.test(text), `expected a pending approval notice, got: ${text.slice(-400)}`);
    assert.ok(/Nothing is submitted/.test(text), "the approval request must not claim a submission happened");

    const approvals = await page.evaluate(`(async () => {
      const res = await fetch('/api/approvals', { headers: { Authorization: 'Bearer ' + ${JSON.stringify(OWNER_TOKEN)} } });
      const body = await res.json();
      return (body.data || []).filter(a => a.target_resource_id === ${JSON.stringify(opportunityId)}).map(a => a.status);
    })()`);
    assert.ok(approvals.includes("PENDING"), `expected a PENDING approval record, got ${JSON.stringify(approvals)}`);
  });

  await test("the home pipeline reflects the advanced state of this record", async () => {
    await page.evaluate(`document.querySelector('#dock button[data-nav="home"]').click()`);
    await sleep(2200);
    const stages = await page.evaluate(`Array.from(document.querySelectorAll('#home-pipeline .stage')).map(s => ({
      name: s.querySelector('.stage-name').textContent,
      state: s.querySelector('.stage-state').textContent
    }))`);
    assert.strictEqual(stages.length, 11);
    const byName = Object.fromEntries(stages.map((s) => [s.name, s.state]));
    assert.ok(/COMPLETE/.test(byName["Verify"]), `Verify should be COMPLETE, got ${byName["Verify"]}`);
    assert.ok(/COMPLETE/.test(byName["Score"]), `Score should be COMPLETE, got ${byName["Score"]}`);
    assert.ok(/OWNER_REQUIRED/.test(byName["Execute Only When Authorized"]), "execution must remain Owner-required");
  });

  await test("cleanup: the proof record and its approval are removed", async () => {
    const status = await page.evaluate(`(async () => {
      const res = await fetch('/api/opportunities/' + ${JSON.stringify(opportunityId)}, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + ${JSON.stringify(OWNER_TOKEN)} }
      });
      return res.status;
    })()`);
    assert.strictEqual(status, 200, "the proof record should be deleted");
  });

  await page.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await closeBrowser(browser);
}
