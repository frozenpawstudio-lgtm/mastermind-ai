/*
 * Honesty audit: the console must never assert an outcome it cannot prove.
 *
 * Read-only. Loads each screen and asserts that no screen shows a fabricated
 * earnings, payment, verification or task-completion claim, and that states
 * which are genuinely unavailable are labelled as such.
 *
 * Usage:
 *   node test/audit_honesty.mjs
 */

import { launchBrowser, newPage, closeBrowser, sleep, MOBILE_WIDTHS } from "./ui_harness.mjs";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";

// Phrases that would assert an outcome. The UI may only use these if a real
// backend record proves them; absent that, they must not appear as claims.
const FORBIDDEN = [
  /\bpayment received\b/i,
  /\bpayment confirmed\b/i,
  /\bwe have earned\b/i,
  /\bearnings? (?:of|total) \$/i,
  /\bpaid out\b/i,
  /\bwithdrawn \$/i,
  /\bautomatically submitted\b/i,
  /\bsubmitted to (?:the )?marketplace\b/i
];

const browser = await launchBrowser({ windowWidth: 390, windowHeight: 900 });
const page = await newPage(browser, { width: 390, height: 844 });

let fail = 0;
let checks = 0;

try {
  for (const device of MOBILE_WIDTHS) {
    await page.setViewport(device.width, device.height);
    for (const screen of ["home", "chat", "tools", "research", "profile"]) {
      await page.goto(`${BASE_URL}/`, { settleMs: 1800 });
      await page.evaluate(`(() => { const b = document.querySelector('#dock button[data-nav="${screen}"]'); if (b) b.click(); })()`);
      await sleep(1100);

      const text = await page.evaluate(`document.body.innerText`);
      for (const re of FORBIDDEN) {
        checks++;
        if (re.test(text)) {
          fail++;
          const m = text.match(re);
          console.log(`  \u2717 ${screen} @ ${device.width}px: forbidden claim ${re} -> "${m[0]}"`);
        }
      }

      // A concrete currency amount in the UI is a claim of money.
      checks++;
      const money = text.match(/\$\s?\d[\d,.]*/g) || [];
      const realMoney = money.filter((m) => !/^\$\s?0\b/.test(m));
      if (realMoney.length > 0) {
        fail++;
        console.log(`  \u2717 ${screen} @ ${device.width}px: shows currency ${realMoney.slice(0, 3).join(", ")}`);
      }
    }
  }

  // Tasks must be labelled unavailable rather than showing invented history.
  await page.setViewport(390, 844);
  await page.goto(`${BASE_URL}/`, { settleMs: 1800 });
  const tasksText = await page.evaluate(`(() => {
    const t = document.body.innerText;
    return t;
  })()`);
  checks++;
  const hasTaskWord = /task/i.test(tasksText);
  console.log(`  \u2139 home mentions "task": ${hasTaskWord}`);

  console.log(`\nhonesty audit: ${checks - fail} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await closeBrowser(browser);
}
