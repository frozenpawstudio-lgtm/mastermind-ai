/*
 * End-to-end UI wiring check for the V9 section 25-27 tracking surface.
 *
 * Creates a real opportunity through the API, opens the Earning tab in a real
 * browser, authorizes the session, presses Track, records a stage, records a
 * payment that needs evidence, and confirms the rendered summary reflects what
 * the backend actually returned. It asserts the UI never shows a confirmed
 * payment the backend refused.
 */

import assert from "node:assert";
import { launchBrowser, newPage, closeBrowser, sleep } from "./ui_harness.mjs";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN || "";

let passed = 0;
let failed = 0;

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

async function createOpportunity(title) {
  const res = await fetch(`${BASE_URL}/api/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({
      source: "tracking-ui-test",
      title,
      platform: "Test",
      description: "tracking UI wiring fixture"
    })
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `create status ${res.status}`);
  return body.data.id;
}

async function run() {
  if (!OWNER_TOKEN) {
    console.log("  ! OWNER_API_TOKEN not set");
    process.exitCode = 1;
    return;
  }

  const id = await createOpportunity("tracking-ui-fixture");
  const browser = await launchBrowser({ windowWidth: 390, windowHeight: 900 });
  const page = await newPage(browser, { width: 390, height: 844, dpr: 2 });

  try {
    await page.goto(`${BASE_URL}/`, { settleMs: 1500 });

    // Authorize the session the same way the UI does: in-memory only.
    await page.evaluate(`(() => {
      const input = document.querySelector('#owner-token');
      if (input) input.value = ${JSON.stringify(OWNER_TOKEN)};
      const btn = document.querySelector('#owner-auth-save');
      if (btn) btn.click();
      return true;
    })()`);
    await sleep(1200);

    await page.evaluate(`document.querySelector('#dock button[data-nav="tools"]')?.click()`);
    await sleep(1800);

    await check("tracking controls render on the opportunity card", async () => {
      const found = await page.evaluate(`(() => {
        const card = document.querySelector('.opp[data-opp="${id}"]');
        if (!card) return { card: false };
        return {
          card: true,
          trackButton: !!card.querySelector('[data-act="track"][data-id="${id}"]')
        };
      })()`);
      assert.ok(found.card, "opportunity card must be rendered");
      assert.ok(found.trackButton, "Track button must exist on the card");
    });

    await check("Track button loads the backend summary and controls", async () => {
      await page.evaluate(`document.querySelector('[data-act="track"][data-id="${id}"]')?.click()`);
      await sleep(1200);
      const state = await page.evaluate(`(() => {
        const out = document.querySelector('[data-out="${id}"]');
        return {
          text: out ? out.textContent : "",
          hasStageSelect: !!document.querySelector('[data-track-stage="${id}"]'),
          hasPaymentSelect: !!document.querySelector('[data-track-payment="${id}"]'),
          hasFollowUp: !!document.querySelector('[data-track-next="${id}"]')
        };
      })()`);
      assert.ok(state.hasStageSelect, "lifecycle stage selector must render");
      assert.ok(state.hasPaymentSelect, "payment selector must render");
      assert.ok(state.hasFollowUp, "follow-up input must render");
      assert.match(state.text, /Current stage/i, "summary must show the current stage row");
    });

    await check("recording a stage updates the rendered summary", async () => {
      await page.evaluate(`(() => {
        const sel = document.querySelector('[data-track-stage="${id}"]');
        if (sel) sel.value = 'SELECTED';
        document.querySelector('[data-act="track-stage"][data-id="${id}"]')?.click();
        return true;
      })()`);
      await sleep(1500);
      const text = await page.evaluate(`document.querySelector('[data-out="${id}"]')?.textContent || ""`);
      assert.match(text, /SELECTED/, "summary must reflect the recorded stage from the backend");
    });

    await check("CONFIRMED_PAID without FACT evidence is refused and not shown as confirmed", async () => {
      await page.evaluate(`(() => {
        const sel = document.querySelector('[data-track-payment="${id}"]');
        if (sel) sel.value = 'CONFIRMED_PAID';
        document.querySelector('[data-act="track-payment"][data-id="${id}"]')?.click();
        return true;
      })()`);
      await sleep(1500);
      const text = await page.evaluate(`document.querySelector('[data-out="${id}"]')?.textContent || ""`);
      assert.doesNotMatch(text, /YES \(evidence recorded\)/, "UI must not claim a confirmed payment the backend refused");
      assert.match(text, /NO EVIDENCE/, "UI must show no evidence of payment");
    });

    await check("recording FACT evidence flips the FACT row to RECORDED", async () => {
      const res = await fetch(`${BASE_URL}/api/opportunities/${id}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER_TOKEN}` },
        body: JSON.stringify({ classification: "FACT", source: "bank statement", content: "payment received 2026-10-24" })
      });
      assert.strictEqual(res.status, 201, `evidence create status ${res.status}`);
      await page.evaluate(`document.querySelector('[data-act="track"][data-id="${id}"]')?.click()`);
      await sleep(1500);
      const text = await page.evaluate(`document.querySelector('[data-out="${id}"]')?.textContent || ""`);
      assert.match(text, /FACT evidence\s*RECORDED/, "FACT evidence row must reflect the recorded evidence");
    });

    await check("CONFIRMED_PAID with FACT evidence is shown as confirmed", async () => {
      await page.evaluate(`(() => {
        const sel = document.querySelector('[data-track-payment="${id}"]');
        if (sel) sel.value = 'CONFIRMED_PAID';
        document.querySelector('[data-act="track-payment"][data-id="${id}"]')?.click();
        return true;
      })()`);
      await sleep(1500);
      const text = await page.evaluate(`document.querySelector('[data-out="${id}"]')?.textContent || ""`);
      assert.match(text, /YES \(evidence recorded\)/, "UI must show confirmed payment once the backend accepted FACT evidence");
    });

    await check("adding a follow-up updates the rendered count", async () => {
      await page.evaluate(`(() => {
        const next = document.querySelector('[data-track-next="${id}"]');
        if (next) next.value = 'Follow up in 7 days';
        document.querySelector('[data-act="track-followup"][data-id="${id}"]')?.click();
        return true;
      })()`);
      await sleep(1500);
      const text = await page.evaluate(`document.querySelector('[data-out="${id}"]')?.textContent || ""`);
      assert.match(text, /Follow-ups/, "summary must keep the follow-up row");
      assert.doesNotMatch(text, /Follow-ups\s*0/, "a recorded follow-up must raise the count");
    });
  } finally {
    await closeBrowser(browser);
    await fetch(`${BASE_URL}/api/opportunities/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` }
    }).catch(() => {});
  }

  console.log("");
  console.log(`  tracking UI test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
