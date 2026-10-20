/*
 * Measurable layout audit comparison: committed baseline vs working tree.
 *
 * The baseline index.html is read from git (HEAD) and written to a temporary
 * served copy, so the audit runs the real rendering engine against both
 * versions and produces hard numbers instead of an impression.
 *
 * Output: .agent_tmp/layout-audit-report.json and a human summary on stdout.
 *
 * Usage:
 *   node test/layout_audit_compare.mjs
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { launchBrowser, newPage, closeBrowser, sleep, MOBILE_WIDTHS, LAYOUT_AUDIT } from "./ui_harness.mjs";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const OUT_DIR = "/workspace/project/mastermind-ai/.agent_tmp";
const SCREENS = ["home", "chat", "tools", "research", "profile"];

mkdirSync(OUT_DIR, { recursive: true });

const baselineHtml = execSync("git show HEAD:index.html", {
  cwd: "/workspace/project/mastermind-ai",
  maxBuffer: 32 * 1024 * 1024
}).toString();

const browser = await launchBrowser({ windowWidth: 390, windowHeight: 900 });

async function auditVersion(label, installPath) {
  const page = await newPage(browser, { width: 390, height: 844 });
  const results = [];

  for (const device of MOBILE_WIDTHS) {
    await page.setViewport(device.width, device.height);
    for (const screen of SCREENS) {
      const installed = await page.installHtml(installPath, `${BASE_URL}/?audit=${label}-${device.width}-${screen}`);
      if (!installed) {
        results.push({ device: device.label, screen, unavailable: true });
        continue;
      }
      await sleep(1600);
      await page.evaluate(`(() => {
        const btn = document.querySelector('#dock button[data-nav="${screen}"]') ||
                    document.querySelector('[data-nav="${screen}"]') ||
                    document.querySelector('#nav-${screen}');
        if (btn) btn.click();
      })()`);
      await sleep(1300);

      const audit = await page.evaluate(LAYOUT_AUDIT);
      results.push({
        device: device.label,
        width: device.width,
        screen,
        horizontalOverflow: audit.horizontalOverflow,
        documentScrollWidth: audit.documentScrollWidth,
        offenderCount: audit.offenders.length,
        offenders: audit.offenders.slice(0, 6),
        tinyTextCount: audit.tinyText.length,
        tinyText: audit.tinyText.slice(0, 6)
      });
    }
  }

  await page.close();
  return { label, results };
}

try {
  const before = await auditVersion("before", "/workspace/project/mastermind-ai/.agent_tmp/baseline-index.html");
  const after = await auditVersion("after", "/workspace/project/mastermind-ai/index.html");

  const summarize = (run) => ({
    label: run.label,
    cells: run.results.length,
    horizontalOverflows: run.results.filter((r) => r.horizontalOverflow).length,
    totalOffenders: run.results.reduce((n, r) => n + (r.offenderCount || 0), 0),
    totalTinyText: run.results.reduce((n, r) => n + (r.tinyTextCount || 0), 0),
    unavailable: run.results.filter((r) => r.unavailable).length
  });

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    widths: MOBILE_WIDTHS.map((d) => d.width),
    screens: SCREENS,
    before: summarize(before),
    after: summarize(after),
    detail: { before: before.results, after: after.results }
  };

  writeFileSync(`${OUT_DIR}/layout-audit-report.json`, JSON.stringify(report, null, 2));

  console.log("AIRA layout audit — committed baseline vs working tree\n");
  console.log(`widths tested : ${report.widths.join(", ")} px`);
  console.log(`screens tested: ${SCREENS.join(", ")}\n`);
  console.log("metric                  before    after");
  console.log("----------------------  --------  --------");
  console.log(`measured cells          ${String(report.before.cells).padStart(8)}  ${String(report.after.cells).padStart(8)}`);
  console.log(`horizontal overflows    ${String(report.before.horizontalOverflows).padStart(8)}  ${String(report.after.horizontalOverflows).padStart(8)}`);
  console.log(`clipping offenders      ${String(report.before.totalOffenders).padStart(8)}  ${String(report.after.totalOffenders).padStart(8)}`);
  console.log(`unreadable text runs    ${String(report.before.totalTinyText).padStart(8)}  ${String(report.after.totalTinyText).padStart(8)}`);
  console.log(`screens not reachable   ${String(report.before.unavailable).padStart(8)}  ${String(report.after.unavailable).padStart(8)}`);
  console.log(`\nfull report: ${OUT_DIR}/layout-audit-report.json`);
} finally {
  await closeBrowser(browser);
}
