/*
 * Real-browser UI tests for the AIRA operator console.
 *
 * These tests drive the real application in Chromium against the locally
 * running worker. They are NOT simulations of the UI: navigation, chat,
 * authorization, error handling and layout are exercised through the real DOM
 * and the real HTTP API.
 *
 * Requires:
 *   - the worker running locally (npx wrangler dev --local --port 8787)
 *   - OWNER_API_TOKEN exported when the permission foundation is configured
 *
 * Set TEST_BASE_URL to point at another host.
 */

import assert from "node:assert";
import { launchBrowser, newPage, closeBrowser, sleep, MOBILE_WIDTHS, LAYOUT_AUDIT } from "./ui_harness.mjs";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN;

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
  console.log(`Starting AIRA UI tests against ${BASE_URL}...\n`);

  /* ------------------------------------------------------------------ */
  console.log("--- Navigation ---");

  {
    const page = await newPage(browser, { width: 390, height: 844 });
    await page.goto(`${BASE_URL}/`, { settleMs: 1500 });

    await test("home screen is active on load", async () => {
      const active = await page.evaluate(`document.querySelector('.screen.active').id`);
      assert.strictEqual(active, "screen-home");
    });

    for (const nav of ["chat", "tools", "tasks", "profile", "home"]) {
      await test(`dock button "${nav}" activates screen-${nav}`, async () => {
        await page.evaluate(`document.querySelector('#dock button[data-nav="${nav}"]').click()`);
        await sleep(700);
        const active = await page.evaluate(`document.querySelector('.screen.active').id`);
        assert.strictEqual(active, `screen-${nav}`, `expected screen-${nav}, got ${active}`);
        const current = await page.evaluate(`document.querySelector('#dock button[data-nav="${nav}"]').getAttribute('aria-current')`);
        assert.strictEqual(current, "true", "dock button should be marked aria-current");
      });
    }

    await test("subnav appears only on research/tasks/audit and switches sections", async () => {
      await page.evaluate(`document.querySelector('#dock button[data-nav="tools"]').click()`);
      await sleep(400);
      let visible = await page.evaluate(`document.getElementById('subnav').classList.contains('visible')`);
      assert.strictEqual(visible, false, "subnav should be hidden on tools");

      await page.evaluate(`document.querySelector('#dock button[data-nav="tasks"]').click()`);
      await sleep(400);
      visible = await page.evaluate(`document.getElementById('subnav').classList.contains('visible')`);
      assert.strictEqual(visible, true, "subnav should be visible on research");

      await page.evaluate(`document.querySelector('#subnav button[data-sub="tasks"]').click()`);
      await sleep(400);
      const active = await page.evaluate(`document.querySelector('.screen.active').id`);
      assert.strictEqual(active, "screen-tasks");

      await page.evaluate(`document.querySelector('#subnav button[data-sub="audit"]').click()`);
      await sleep(400);
      const audit = await page.evaluate(`document.querySelector('.screen.active').id`);
      assert.strictEqual(audit, "screen-audit");
    });

    await test("home quick-action buttons navigate", async () => {
      await page.evaluate(`document.querySelector('#dock button[data-nav="home"]').click()`);
      await sleep(500);
      await page.evaluate(`document.querySelector('[data-goto="research"]').click()`);
      await sleep(500);
      const active = await page.evaluate(`document.querySelector('.screen.active').id`);
      assert.strictEqual(active, "screen-research");
    });

    await page.close();
  }

  /* ------------------------------------------------------------------ */
  console.log("\n--- Chat: one request per tap ---");

  {
    const page = await newPage(browser, { width: 390, height: 844 });
    await page.goto(`${BASE_URL}/`, { settleMs: 1500 });

    // Chat is Owner-gated: the app sends no /api/chat request until the Owner
    // credential has been accepted for this session (held in memory only).
    if (OWNER_TOKEN) {
      await page.evaluate(`document.getElementById('owner-token').value = ${JSON.stringify(OWNER_TOKEN)}; document.getElementById('owner-auth-save').click();`);
      await sleep(1500);
    }

    await test("chat send issues exactly one POST /api/chat per tap", async () => {
      await page.evaluate(`document.querySelector('#dock button[data-nav="chat"]').click()`);
      await sleep(500);

      // Count only requests triggered by our own taps.
      await page.evaluate(`window.__chatPosts = 0; window.__origFetch = window.fetch;
        window.fetch = function(...args) {
          const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
          const init = args[1] || {};
          if (String(url).indexOf("/api/chat") !== -1 && String(init.method || "").toUpperCase() === "POST") {
            window.__chatPosts++;
          }
          return window.__origFetch.apply(this, args);
        };`);

      await page.evaluate(`document.getElementById('chat-input').value = 'What is your status?';`);
      await page.evaluate(`document.getElementById('chat-send').click()`);
      await sleep(9000);

      const posts = await page.evaluate(`window.__chatPosts`);
      assert.strictEqual(posts, 1, `expected exactly 1 POST /api/chat, got ${posts}`);
    });

    await test("a second tap while in flight does not add a request", async () => {
      // Re-arm the counter and tap twice quickly.
      await page.evaluate(`window.__chatPosts = 0;`);
      await page.evaluate(`document.getElementById('chat-input').value = 'Double tap check';`);
      await page.evaluate(`(() => {
        const btn = document.getElementById('chat-send');
        btn.click();
        btn.click();
        btn.click();
      })()`);
      await sleep(9000);
      const posts = await page.evaluate(`window.__chatPosts`);
      assert.strictEqual(posts, 1, `expected exactly 1 POST for rapid multi-tap, got ${posts}`);
    });

    await test("chat renders an OWNER bubble and an AIRA reply or explicit error", async () => {
      const owner = await page.evaluate(`document.querySelectorAll('#chat-log .msg.owner').length`);
      assert.ok(owner >= 2, `expected owner bubbles, got ${owner}`);
      const aira = await page.evaluate(`document.querySelectorAll('#chat-log .msg.aira').length`);
      assert.ok(aira >= 2, `expected AIRA bubbles, got ${aira}`);
      const empty = await page.evaluate(`Array.from(document.querySelectorAll('#chat-log .msg.aira .bubble')).some(b => b.textContent.trim().length === 0)`);
      assert.strictEqual(empty, false, "no AIRA bubble may be empty");
    });

    await test("chat clear empties history", async () => {
      await page.evaluate(`document.getElementById('chat-clear').click()`);
      await sleep(300);
      const msgs = await page.evaluate(`document.querySelectorAll('#chat-log .msg').length`);
      assert.strictEqual(msgs, 1, "clear should leave only the ready message");
    });

    await test("an API error is displayed in the conversation", async () => {
      // Force a failing chat endpoint and assert the error surfaces visibly.
      await page.evaluate(`window.fetch = function(url, init) {
        if (String(url).indexOf('/api/chat') !== -1) {
          return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'SIMULATED_BACKEND_FAILURE' }), { status: 500, headers: { 'content-type': 'application/json' } }));
        }
        return window.__origFetch.apply(this, arguments);
      };`);
      await page.evaluate(`document.getElementById('chat-input').value = 'error path check';`);
      await page.evaluate(`document.getElementById('chat-send').click()`);
      await sleep(1200);
      const shown = await page.evaluate(`Array.from(document.querySelectorAll('#chat-log .msg.aira')).map(m => m.textContent).join('|')`);
      assert.ok(shown.includes("SIMULATED_BACKEND_FAILURE"), "backend error text must be visible in the conversation");
      await page.evaluate(`window.fetch = window.__origFetch;`);
    });

    await page.close();
  }

  /* ------------------------------------------------------------------ */
  console.log("\n--- Earning Agent ---");

  {
    const page = await newPage(browser, { width: 390, height: 844 });
    await page.goto(`${BASE_URL}/`, { settleMs: 1500 });

    await test("earning screen loads real opportunities from the API", async () => {
      await page.evaluate(`document.querySelector('#dock button[data-nav="tools"]').click()`);
      await sleep(1800);
      const pillText = await page.evaluate(`document.getElementById('earning-connectivity').textContent`);
      assert.ok(/DISCOVERY/.test(pillText), `connectivity pill should report discovery state, got "${pillText}"`);
      const hasState = await page.evaluate(`document.querySelectorAll('#earning-list .opp, #earning-list .state-box').length > 0`);
      assert.strictEqual(hasState, true, "earning list must show either cards or an explicit state box");
    });

    await test("the eleven-stage workflow is documented on the earning screen", async () => {
      const note = await page.evaluate(`document.querySelector('#screen-tools .tiny-note').textContent`);
      for (const stage of ["DISCOVER", "VERIFY", "CHECK ELIGIBILITY", "CHECK OWNER FIT", "COMPARE", "SCORE", "PREPARE", "REQUEST OWNER APPROVAL", "EXECUTE ONLY WHEN AUTHORIZED", "VERIFY RESULT", "TRACK FOLLOW-UP"]) {
        assert.ok(note.includes(stage), `workflow text should mention ${stage}`);
      }
    });

    await test("the home pipeline renders all eleven stages", async () => {
      await page.evaluate(`document.querySelector('#dock button[data-nav="home"]').click()`);
      await sleep(1500);
      const stages = await page.evaluate(`document.querySelectorAll('#home-pipeline .stage').length`);
      assert.strictEqual(stages, 11, `expected 11 pipeline stages, got ${stages}`);
      const names = await page.evaluate(`Array.from(document.querySelectorAll('#home-pipeline .stage-name')).map(n => n.textContent)`);
      assert.deepStrictEqual(names, [
        "Discover", "Verify", "Check Eligibility", "Check Owner Fit", "Compare",
        "Score", "Prepare", "Request Owner Approval", "Execute Only When Authorized",
        "Verify Result", "Track Follow-up"
      ]);
    });

    await test("owner-only mutation without a credential is refused and reported", async () => {
      await page.evaluate(`document.querySelector('#dock button[data-nav="tools"]').click()`);
      await sleep(1500);

      // Create a record so there is something to act on.
      const create = await page.evaluate(`(async () => {
        const res = await fetch('/api/opportunities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'UI test opportunity ' + Date.now(), source: 'ui-test' })
        });
        return res.status;
      })()`);
      // 401 when the permission foundation is configured; 201 when it is not.
      assert.ok(create === 401 || create === 201, `unexpected create status ${create}`);

      await page.evaluate(`document.getElementById('earning-refresh').click()`);
      await sleep(1800);

      const outcome = await page.evaluate(`(async () => {
        const btn = document.querySelector('#earning-list button[data-act="approval"]');
        if (!btn) return { missing: true };
        btn.click();
        return { missing: false };
      })()`);

      if (outcome.missing) {
        console.log("      (no opportunity card available to test the approval path; skipped)");
        return;
      }

      await sleep(900);
      const shown = await page.evaluate(`Array.from(document.querySelectorAll('#earning-list .state-box, #earning-list .row')).map(n => n.textContent).join(' | ')`);
      assert.ok(/OWNER AUTHORIZATION REQUIRED|OWNER_CREDENTIAL|DENIED/i.test(shown), `expected an explicit authorization message, got: ${shown}`);
    });

    await test("COMPARE is read-only and reports its result", async () => {
      await page.evaluate(`document.getElementById('earning-compare').click()`);
      await sleep(1800);
      const text = await page.evaluate(`document.getElementById('earning-list').textContent`);
      assert.ok(/COMPARE|Score/i.test(text), `COMPARE should render a ranking or an explicit empty state, got: ${text.slice(0, 120)}`);
    });

    await page.close();
  }

  /* ------------------------------------------------------------------ */
  console.log("\n--- Owner authorization (memory only) ---");

  {
    const page = await newPage(browser, { width: 390, height: 844 });
    await page.goto(`${BASE_URL}/`, { settleMs: 1500 });

    await test("owner panel opens from the top bar", async () => {
      const hiddenBefore = await page.evaluate(`document.getElementById('owner-auth-panel').hidden`);
      await page.evaluate(`document.getElementById('btn-owner').click()`);
      await sleep(250);
      const hiddenAfter = await page.evaluate(`document.getElementById('owner-auth-panel').hidden`);
      assert.notStrictEqual(hiddenBefore, hiddenAfter, "panel visibility should toggle");
    });

    await test("no credential is written to localStorage, sessionStorage, cookies or the URL", async () => {
      const storage = await page.evaluate(`JSON.stringify({
        ls: Object.keys(localStorage).length ? localStorage : null,
        ss: Object.keys(sessionStorage).length ? sessionStorage : null,
        cookie: document.cookie,
        href: location.href,
        hash: location.hash,
        search: location.search
      })`);
      const parsed = JSON.parse(storage);
      assert.strictEqual(parsed.ls, null, `localStorage must stay empty, found: ${storage}`);
      assert.strictEqual(parsed.ss, null, `sessionStorage must stay empty, found: ${storage}`);
      assert.strictEqual(parsed.cookie, "", `cookies must stay empty, found: ${parsed.cookie}`);
      assert.strictEqual(parsed.search, "", `URL query must stay empty, found: ${parsed.search}`);
      assert.strictEqual(parsed.hash, "", `URL hash must stay empty, found: ${parsed.hash}`);
    });

    if (OWNER_TOKEN) {
      await test("a wrong credential is rejected and not retained", async () => {
        await page.evaluate(`document.getElementById('owner-token').value = 'definitely-wrong-token';`);
        await page.evaluate(`document.getElementById('owner-auth-save').click()`);
        await sleep(1200);
        const note = await page.evaluate(`document.getElementById('toast').textContent`);
        assert.ok(/rejected/i.test(note), `expected a rejection message, got "${note}"`);
        const retained = await page.evaluate(`document.getElementById('owner-token').value`);
        assert.strictEqual(retained, "", "the input must be cleared after a rejection");
      });

      await test("a valid credential authorizes the session and the token is not exposed in the DOM", async () => {
        await page.evaluate(`document.getElementById('owner-token').value = ${JSON.stringify(OWNER_TOKEN)};`);
        await page.evaluate(`document.getElementById('owner-auth-save').click()`);
        await sleep(1500);
        const state = await page.evaluate(`document.getElementById('profile-auth-pill').textContent`);
        await page.evaluate(`document.querySelector('#dock button[data-nav="profile"]').click()`);
        await sleep(1200);
        const authPill = await page.evaluate(`document.getElementById('profile-auth-pill').textContent`);
        assert.ok(/AUTHORIZED/.test(authPill), `expected AUTHORIZED after a valid credential, got "${authPill}" (was "${state}")`);

        const html = await page.evaluate(`document.documentElement.outerHTML`);
        assert.strictEqual(html.includes(OWNER_TOKEN), false, "the owner token must never appear in the DOM");

        const stored = await page.evaluate(`JSON.stringify({ ls: Object.keys(localStorage), ss: Object.keys(sessionStorage), cookie: document.cookie })`);
        assert.strictEqual(stored, '{"ls":[],"ss":[],"cookie":""}', `credential storage must stay empty, got ${stored}`);
      });

      await test("owner-only audit log is readable once authorized", async () => {
        await page.evaluate(`document.querySelector('#dock button[data-nav="tasks"]').click()`);
        await sleep(400);
        await page.evaluate(`document.querySelector('#subnav button[data-sub="audit"]').click()`);
        await sleep(1800);
        const text = await page.evaluate(`document.getElementById('audit-list').textContent`);
        assert.strictEqual(/OWNER AUTHORIZATION REQUIRED/.test(text), false, `audit should be readable when authorized, got: ${text.slice(0, 120)}`);
      });
    } else {
      await test("owner-only audit log is refused without a credential (OWNER_API_TOKEN not set)", async () => {
        await page.evaluate(`document.querySelector('#dock button[data-nav="tasks"]').click()`);
        await sleep(400);
        await page.evaluate(`document.querySelector('#subnav button[data-sub="audit"]').click()`);
        await sleep(1500);
        const text = await page.evaluate(`document.getElementById('audit-list').textContent`);
        assert.ok(/OWNER AUTHORIZATION REQUIRED/.test(text), `expected an authorization gate, got: ${text.slice(0, 120)}`);
      });
    }

    await page.close();
  }

  /* ------------------------------------------------------------------ */
  console.log("\n--- Profile / Tools / Research / Tasks content ---");

  {
    const page = await newPage(browser, { width: 390, height: 844 });
    await page.goto(`${BASE_URL}/`, { settleMs: 1500 });

    await test("profile shows real connection states from /api/connections", async () => {
      await page.evaluate(`document.querySelector('#dock button[data-nav="profile"]').click()`);
      await sleep(1800);
      const items = await page.evaluate(`document.querySelectorAll('#connections-list .list-item').length`);
      assert.ok(items > 0, "connection list should render real services");
      const text = await page.evaluate(`document.getElementById('connections-list').textContent`);
      assert.ok(/CONNECTED|NOT_CONNECTED|NOT_CONFIGURED|UNAVAILABLE|PLANNED/.test(text), "connection states must be truthful states");
    });

    await test("profile never claims earnings or invented figures", async () => {
      const text = await page.evaluate(`document.getElementById('screen-profile').textContent`);
      assert.strictEqual(/earned/i.test(text), false, "profile must not claim earnings");
      assert.strictEqual(/\$\d/.test(text), false, "profile must not show invented money amounts");
    });

    await test("voice foundation reports a truthful state", async () => {
      const text = await page.evaluate(`document.getElementById('voice-body').textContent`);
      assert.ok(/VOICE_/.test(text) || /Provider/.test(text), `voice section should report a truthful state, got: ${text.slice(0, 120)}`);
    });

    await test("tasks screen clearly reports UNAVAILABLE and does not invent counts", async () => {
      await page.evaluate(`document.querySelector('#dock button[data-nav="tasks"]').click()`);
      await sleep(400);
      await page.evaluate(`document.querySelector('#subnav button[data-sub="tasks"]').click()`);
      await sleep(700);
      const text = await page.evaluate(`document.getElementById('screen-tasks').textContent`);
      assert.ok(/TASK TRACKING UNAVAILABLE/.test(text), "tasks must report UNAVAILABLE");
      assert.ok(/DATA NOT AVAILABLE/.test(text), "tasks must not invent a completed count");
    });

    await test("research reports the real browser binding state", async () => {
      await page.evaluate(`document.querySelector('#dock button[data-nav="tasks"]').click()`);
      await sleep(400);
      await page.evaluate(`document.querySelector('#subnav button[data-sub="research"]').click()`);
      await sleep(1800);
      const pillText = await page.evaluate(`document.getElementById('research-binding').textContent`);
      assert.ok(/BROWSER (CONNECTED|NOT CONNECTED)/.test(pillText), `research binding pill should be truthful, got "${pillText}"`);
    });

    await page.close();
  }

  /* ------------------------------------------------------------------ */
  console.log("\n--- Layout at 360 / 390 / 412 px ---");

  for (const device of MOBILE_WIDTHS) {
    const page = await newPage(browser, { width: device.width, height: device.height });
    await page.goto(`${BASE_URL}/`, { settleMs: 1500 });

    for (const screen of ["home", "chat", "tools", "research", "profile"]) {
      await test(`${screen} at ${device.label}px: no horizontal overflow, no sub-10px text`, async () => {
        // Research and Audit live under the Tasks hub, so open the hub first
        // and then the sub-section tab.
        if (screen === "research" || screen === "tasks" || screen === "audit") {
          await page.evaluate(`document.querySelector('#dock button[data-nav="tasks"]').click()`);
          await sleep(400);
          await page.evaluate(`document.querySelector('#subnav button[data-sub="${screen}"]').click()`);
        } else {
          await page.evaluate(`document.querySelector('#dock button[data-nav="${screen}"]').click()`);
        }
        await sleep(1300);
        const audit = await page.evaluate(LAYOUT_AUDIT);
        assert.strictEqual(audit.horizontalOverflow, false, `document overflows: ${JSON.stringify(audit)}`);
        assert.strictEqual(audit.offenders.length, 0, `offending elements: ${JSON.stringify(audit.offenders)}`);
        assert.strictEqual(audit.tinyText.length, 0, `unreadable text: ${JSON.stringify(audit.tinyText)}`);
      });
    }
    await page.close();
  }

  /* ------------------------------------------------------------------ */
  console.log("\n--- Console cleanliness ---");

  {
    const page = await newPage(browser, { width: 390, height: 844 });
    page.clearErrors();
    await page.goto(`${BASE_URL}/`, { settleMs: 2000 });
    for (const screen of ["chat", "tools", "research", "profile", "home"]) {
      if (screen === "research") {
        await page.evaluate(`document.querySelector('#dock button[data-nav="tasks"]').click()`);
        await sleep(500);
        await page.evaluate(`document.querySelector('#subnav button[data-sub="research"]').click()`);
      } else {
        await page.evaluate(`document.querySelector('#dock button[data-nav="${screen}"]').click()`);
      }
      await sleep(1400);
    }

    await test("no browser console errors during a full navigation sweep", async () => {
      const errors = page.consoleErrors.filter((e) => !/favicon/i.test(e.text));
      assert.strictEqual(errors.length, 0, `console errors: ${JSON.stringify(errors)}`);
    });

    await page.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await closeBrowser(browser);
}
