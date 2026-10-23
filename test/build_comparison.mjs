/*
 * Builds side-by-side before/after comparison sheets for the design review.
 *
 * Usage: node test/build_comparison.mjs
 *
 * Writes .agent_tmp/screens/compare-<screen>-390px.png for each screen.
 * Both source images are embedded as file:// URLs, so this needs no extra
 * dependencies beyond the existing browser harness.
 */

import { writeFileSync } from "node:fs";
import { launchBrowser, newPage, closeBrowser, sleep } from "./ui_harness.mjs";

const ROOT = "/workspace/project/mastermind-ai/.agent_tmp/screens";
const SCREENS = ["home", "chat", "earning", "research"];
const WIDTH = "390px";

const browser = await launchBrowser({ windowWidth: 1200, windowHeight: 1000 });

try {
  for (const screen of SCREENS) {
    const before = `file://${ROOT}/v9-before/${screen}-${WIDTH}.png`;
    const after = `file://${ROOT}/v9-after/${screen}-${WIDTH}.png`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #05070f; font-family: -apple-system, Segoe UI, Roboto, sans-serif;
             color: #e9effc; padding: 16px; }
      h1 { font-size: 16px; letter-spacing: 1.4px; text-transform: uppercase; margin: 0 0 12px; color: #7df5ff; }
      .row { display: flex; gap: 16px; align-items: flex-start; }
      figure { margin: 0; }
      figcaption { font-size: 12px; font-weight: 800; letter-spacing: 1.2px; text-transform: uppercase;
                   color: #a9b7d3; margin-bottom: 6px; }
      img { width: 380px; display: block; border-radius: 10px; border: 1px solid rgba(0,229,255,0.28); }
    </style></head><body>
      <h1>${screen} — before vs after (${WIDTH})</h1>
      <div class="row">
        <figure><figcaption>Before</figcaption><img src="${before}"></figure>
        <figure><figcaption>After</figcaption><img src="${after}"></figure>
      </div>
    </body></html>`;
    const tmp = `/tmp/compare-${screen}.html`;
    writeFileSync(tmp, html);

    const page = await newPage(browser, { width: 900, height: 1000, dpr: 2 });
    await page.goto(`file://${tmp}`, { settleMs: 1200 });
    await sleep(900);
    const path = `${ROOT}/compare-${screen}-${WIDTH}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`built ${path}`);
    await page.close();
  }
} finally {
  await closeBrowser(browser);
}
