/*
 * Post-deploy verification against the LIVE production worker.
 *
 * Drives real Chromium over real HTTPS at mobile widths and asserts the
 * deployed console behaves. This is a production check, distinct from the
 * local suites: it verifies the artifact that is actually serving traffic.
 *
 * Usage:
 *   node test/verify_live.mjs
 *   LIVE_URL=https://... node test/verify_live.mjs
 */

import { launchBrowser, newPage, closeBrowser, sleep, MOBILE_WIDTHS, LAYOUT_AUDIT } from "./ui_harness.mjs";

const LIVE = process.env.LIVE_URL || "https://mastermind-ai.frozenpawstudio.workers.dev";
// The dock exposes home/chat/tools/research/profile; Earning lives under tools.
const SCREENS = [
  { name: "home", selector: '#dock button[data-nav="home"]' },
  { name: "chat", selector: '#dock button[data-nav="chat"]' },
  { name: "earning", selector: '#dock button[data-nav="tools"]' }
];

let pass = 0;
let fail = 0;
const check = (ok, label) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "  \u2713" : "  \u2717"} ${label}`);
};

const browser = await launchBrowser({ windowWidth: 390, windowHeight: 900 });
const page = await newPage(browser, { width: 390, height: 844 });

try {
  for (const device of MOBILE_WIDTHS) {
    await page.setViewport(device.width, device.height);
    for (const screen of SCREENS) {
      page.clearErrors();
      await page.goto(`${LIVE}/`, { settleMs: 2400 });
      await page.evaluate(`(() => { const b = document.querySelector('${screen.selector}'); if (b) b.click(); })()`);
      await sleep(1600);

      const audit = await page.evaluate(LAYOUT_AUDIT);
      check(!audit.horizontalOverflow, `${screen.name} @ ${device.width}px: no horizontal overflow (scrollWidth ${audit.documentScrollWidth})`);
      check(audit.tinyText.length === 0, `${screen.name} @ ${device.width}px: no sub-10px text (${audit.tinyText.length} found)`);

      const errs = page.consoleErrors.filter(
        (e) => !/favicon|status of 40|Failed to load resource/i.test(e.text)
      );
      check(errs.length === 0, `${screen.name} @ ${device.width}px: no console errors${errs.length ? " -> " + JSON.stringify(errs.slice(0, 2)) : ""}`);
    }
  }

  await page.setViewport(390, 844);
  await page.goto(`${LIVE}/`, { settleMs: 2600 });

  const health = await page.evaluate(`fetch('/api/health').then(r => r.status)`);
  check(health === 200, `live page reaches /api/health (HTTP ${health})`);

  const reads = await page.evaluate(`fetch('/api/opportunities').then(r => r.status)`);
  check(reads === 200 || reads === 401, `live /api/opportunities responds (HTTP ${reads})`);

  const denied = await page.evaluate(`fetch('/api/opportunities', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'live-verify-probe', source:'probe'})}).then(r => r.status)`);
  check(denied === 401, `live unauthenticated mutation fails closed (HTTP ${denied})`);

  const claimed = await page.evaluate(`(() => {
    const t = document.body.innerText;
    const read = (id) => (document.getElementById(id) || {}).textContent || "";
    return {
      title: document.title,
      hasPipeline: /DISCOVER/.test(t) && /VERIFY/.test(t) && /OWNER/.test(t),
      revenue: read("home-revenue").trim(),
      payments: read("home-payments").trim(),
      policy: read("home-policy").trim(),
      // A fabricated claim would be a concrete currency amount in the UI.
      moneyAmounts: (t.match(/\\$\\s?\\d[\\d,.]*/g) || []).filter((m) => !/\\$\\s?0\\b/.test(m))
    };
  })()`);
  check(/Operator Console/.test(claimed.title), `live title reflects the new console ("${claimed.title}")`);
  check(claimed.hasPipeline, "live home renders the earning pipeline stages");
  check(
    claimed.moneyAmounts.length === 0,
    `live UI shows no currency amounts (found ${claimed.moneyAmounts.length}${claimed.moneyAmounts.length ? ": " + claimed.moneyAmounts.slice(0, 3).join(", ") : ""})`
  );
  check(
    /DATA NOT AVAILABLE|NOT AVAILABLE|—|-/i.test(claimed.revenue),
    `live "Earned revenue" reports an unavailable state, not a number ("${claimed.revenue}")`
  );
  check(
    /DATA NOT AVAILABLE|NOT AVAILABLE|—|-/i.test(claimed.payments),
    `live "Confirmed payments" reports an unavailable state, not a number ("${claimed.payments}")`
  );
  check(
    /MANUAL OWNER ONLY/i.test(claimed.policy),
    `live submission policy is owner-controlled ("${claimed.policy}")`
  );

  await page.evaluate(`(() => { const b = document.querySelector('#dock button[data-nav="chat"]'); if (b) b.click(); })()`);
  await sleep(1000);
  const before = page.requests.length;
  await page.evaluate(`(() => {
    const i = document.querySelector('#chat-input');
    if (i) { i.value = 'live verification probe'; i.dispatchEvent(new Event('input', { bubbles: true })); }
    const s = document.querySelector('#chat-send');
    if (s) s.click();
  })()`);
  await sleep(3500);
  const sends = page.requests
    .slice(before)
    .filter((r) => r.method === "POST" && /\/api\//.test(r.url));
  check(sends.length <= 1, `live chat tap produced at most one POST (got ${sends.length})`);

  await page.screenshot({ path: "/tmp/live-verify-390.png" });
  console.log(`\nlive verification: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await closeBrowser(browser);
}
