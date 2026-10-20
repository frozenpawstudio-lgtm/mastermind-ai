/*
 * Ad-hoc layout audit used during development to measure horizontal overflow
 * and unreadable text at the three target Android widths.
 */

import { launchBrowser, newPage, closeBrowser, sleep, MOBILE_WIDTHS, LAYOUT_AUDIT } from "./ui_harness.mjs";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const tabs = process.argv.slice(2);
const TAB_LIST = tabs.length ? tabs : ["home", "chat", "earning", "profile"];

const browser = await launchBrowser({ windowWidth: 390, windowHeight: 900 });
try {
  for (const device of MOBILE_WIDTHS) {
    const page = await newPage(browser, { width: device.width, height: device.height, dpr: 2 });
    await page.goto(`${BASE_URL}/`, { settleMs: 1500 });
    for (const tab of TAB_LIST) {
      await page.evaluate(`document.querySelector('#nav-${tab}')?.click()`);
      await sleep(800);
      const audit = await page.evaluate(LAYOUT_AUDIT);
      console.log(`\n### ${tab} @ ${device.label}px -> overflow=${audit.horizontalOverflow} docScrollWidth=${audit.documentScrollWidth}`);
      if (audit.offenders.length) console.log("  offenders:", JSON.stringify(audit.offenders, null, 1));
      if (audit.tinyText.length) console.log("  tiny:", JSON.stringify(audit.tinyText));
    }
    await page.close();
  }
} finally {
  await closeBrowser(browser);
}
