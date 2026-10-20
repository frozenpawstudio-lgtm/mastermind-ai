/*
 * Secret-exposure audit.
 *
 * Confirms the owner token is never placed in localStorage, sessionStorage,
 * cookies, the URL, the DOM, or the console. Read-only.
 *
 * Usage:
 *   OWNER_API_TOKEN=... node test/audit_secret_exposure.mjs
 * The token is optional; when provided the audit also asserts the exact value
 * does not appear anywhere in the page.
 */

import { launchBrowser, newPage, closeBrowser, sleep } from "./ui_harness.mjs";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const token = process.env.OWNER_API_TOKEN || "";

const browser = await launchBrowser({ windowWidth: 390, windowHeight: 900 });
const page = await newPage(browser, { width: 390, height: 844 });

let fail = 0;
const check = (ok, label) => {
  if (!ok) fail++;
  console.log(`${ok ? "  \u2713" : "  \u2717"} ${label}`);
};

try {
  for (const screen of ["home", "chat", "tools", "research", "profile"]) {
    page.clearErrors();
    await page.goto(`${BASE_URL}/`, { settleMs: 1800 });
    await page.evaluate(`(() => { const b = document.querySelector('#dock button[data-nav="${screen}"]'); if (b) b.click(); })()`);
    await sleep(900);

    const state = await page.evaluate(`(() => ({
      ls: Object.keys(localStorage).map(k => k + '=' + localStorage.getItem(k)),
      ss: Object.keys(sessionStorage).map(k => k + '=' + sessionStorage.getItem(k)),
      cookie: document.cookie,
      html: document.documentElement.outerHTML,
      url: location.href
    }))()`);

    const blob = [state.ls.join("|"), state.ss.join("|"), state.cookie, state.html, state.url].join("\n");

    check(!/bearer\s+[a-z0-9]{16,}/i.test(blob), `${screen}: no bearer token literal in storage/DOM/URL`);
    check(!/owner_api_token\s*[:=]/i.test(state.html), `${screen}: no OWNER_API_TOKEN assignment in DOM`);
    check(state.ls.length === 0, `${screen}: localStorage empty (${state.ls.length} keys)`);
    check(state.ss.length === 0, `${screen}: sessionStorage empty (${state.ss.length} keys)`);
    if (token && token.length >= 16) {
      check(!blob.includes(token), `${screen}: owner token value absent from page`);
    }
    const errBlob = page.consoleErrors.map((e) => e.text).join("\n");
    check(!errBlob.includes(token || "\u0000"), `${screen}: token absent from console output`);
  }

  console.log(`\nsecret-exposure audit: ${fail === 0 ? "passed" : "FAILED"} (${fail} failures)`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await closeBrowser(browser);
}
