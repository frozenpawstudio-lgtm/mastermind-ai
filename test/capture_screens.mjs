/*
 * Before/after screenshot capture for the mobile-first design review.
 *
 * Usage:
 *   node test/capture_screens.mjs <label>
 *
 * Writes PNGs to .agent_tmp/screens/<label>/ at 360, 390 and 412 px widths for
 * Home, Chat, Earning, Research, Tools and Profile.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { launchBrowser, newPage, closeBrowser, sleep, MOBILE_WIDTHS } from "./ui_harness.mjs";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const label = process.argv[2] || "run";
const outDir = `/workspace/project/mastermind-ai/.agent_tmp/screens/${label}`;
mkdirSync(outDir, { recursive: true });

const TABS = [
  { name: "home", selector: '#dock button[data-nav="home"]' },
  { name: "chat", selector: '#dock button[data-nav="chat"]' },
  { name: "earning", selector: '#dock button[data-nav="tools"]' },
  { name: "research", selector: '#dock button[data-nav="tasks"]', then: '#subnav button[data-sub="research"]' },
  { name: "profile", selector: '#dock button[data-nav="profile"]' }
];

const browser = await launchBrowser({ windowWidth: 390, windowHeight: 900 });

try {
  for (const device of MOBILE_WIDTHS) {
    const page = await newPage(browser, { width: device.width, height: device.height, dpr: 2 });
    await page.goto(`${BASE_URL}/`, { settleMs: 1800 });

    for (const tab of TABS) {
      const clicked = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(tab.selector)});
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!clicked) {
        console.log(`SKIP ${tab.name} (${device.label}px): navigation target not present`);
        continue;
      }
      if (tab.then) {
        await sleep(400);
        await page.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(tab.then)});
          if (el) el.click();
        })()`);
      }
      await sleep(1200);
      const path = `${outDir}/${tab.name}-${device.label}px.png`;
      await page.screenshot({ path, fullPage: true });
      console.log(`captured ${path}`);
    }
    await page.close();
  }
} finally {
  await closeBrowser(browser);
}

console.log(`\nScreenshots written to ${outDir}`);
