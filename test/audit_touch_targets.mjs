/*
 * Touch-target and control audit for Android mobile.
 *
 * Measures every interactive element on every screen at the three target
 * widths and reports anything below the 44x44 CSS px recommendation from the
 * Android/Material guidance. Read-only: it clicks nothing that mutates.
 *
 * Usage:
 *   node test/audit_touch_targets.mjs
 */

import { launchBrowser, newPage, closeBrowser, sleep, MOBILE_WIDTHS } from "./ui_harness.mjs";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const SCREENS = ["home", "chat", "tools", "research", "profile"];
const MIN = 44;

const MEASURE = `(() => {
  const sel = 'button, a[href], input, textarea, select, [role="button"], [data-goto]';
  const nodes = Array.from(document.querySelectorAll(sel));
  const out = [];
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 42),
      w: Math.round(r.width),
      h: Math.round(r.height)
    });
  }
  return out;
})()`;

const browser = await launchBrowser({ windowWidth: 390, windowHeight: 900 });
const page = await newPage(browser, { width: 390, height: 844 });

const offenders = [];
let total = 0;

try {
  for (const device of MOBILE_WIDTHS) {
    await page.setViewport(device.width, device.height);
    for (const screen of SCREENS) {
      await page.goto(`${BASE_URL}/`, { settleMs: 1800 });
      const clicked = await page.evaluate(`(() => {
        const b = document.querySelector('#dock button[data-nav="${screen}"]');
        if (!b) return false; b.click(); return true;
      })()`);
      if (!clicked) {
        console.log(`SKIP ${screen} @ ${device.width}px (no nav target)`);
        continue;
      }
      await sleep(1100);

      const controls = await page.evaluate(MEASURE);
      total += controls.length;
      for (const c of controls) {
        if (c.w < MIN || c.h < MIN) {
          offenders.push({ screen, width: device.width, ...c });
        }
      }
      console.log(`${screen} @ ${device.width}px: ${controls.length} interactive elements`);
    }
  }

  console.log(`\n=== under ${MIN}x${MIN} CSS px (${offenders.length} of ${total}) ===`);
  const byKey = new Map();
  for (const o of offenders) {
    const k = `${o.screen}|${o.tag}|${o.id || o.label}`;
    if (!byKey.has(k)) byKey.set(k, o);
  }
  for (const o of byKey.values()) {
    console.log(`  ${o.screen.padEnd(9)} ${o.tag.padEnd(8)} ${String(o.w).padStart(3)}x${String(o.h).padStart(3)}  ${o.id ? "#" + o.id : ""} ${o.label}`);
  }
} finally {
  await closeBrowser(browser);
}
