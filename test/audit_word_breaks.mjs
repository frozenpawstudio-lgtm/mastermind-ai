/*
 * Detects words that are broken mid-word by CSS wrapping.
 *
 * A word is "broken" when a text node's rendered line boxes split a single
 * space-delimited token across two lines. We measure this by walking the
 * element's own text, laying it out with a range per character, and checking
 * whether any token spans more than one client rect.
 *
 * Usage: node test/audit_word_breaks.mjs [screen ...]
 */

import { launchBrowser, newPage, closeBrowser, sleep } from "./ui_harness.mjs";

const BASE = process.env.AIRA_BASE_URL || "http://127.0.0.1:8787/";
const WIDTHS = [360, 390, 412];
const SCREENS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["home", "chat", "earning", "research", "tools", "tasks", "profile"];

const PROBE = `(() => {
  const broken = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) continue;
    const el = node.parentElement;
    if (!el) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;

    // Split into tokens, tracking each token's offset in the text node.
    const re = /\\S+/g;
    let m;
    while ((m = re.exec(raw))) {
      const token = m[0];
      if (token.length < 4) continue;
      // A hyphen or slash is a legitimate break opportunity in CSS, so
      // "single-use" splitting after the hyphen is correct typography,
      // not a mid-word break. Only flag tokens with no such break point.
      if (/[-\/]/.test(token)) continue;
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + token.length);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (rects.length > 1) {
        // Token spans multiple line boxes => it was broken mid-word.
        const lines = new Set(rects.map((r) => Math.round(r.top)));
        if (lines.size > 1) {
          broken.push({ token, lines: lines.size, cls: el.className || el.tagName });
        }
      }
    }
  }
  return broken;
})()`;

const browser = await launchBrowser({ windowWidth: 400, windowHeight: 900 });
let failures = 0;

try {
  for (const width of WIDTHS) {
    const page = await newPage(browser, { width, height: 900 });
    await page.goto(BASE, { settleMs: 1800 });
    for (const screen of SCREENS) {
      const ok = await page.evaluate(`(() => {
        const btn = document.querySelector('[data-goto="${screen}"]') || document.querySelector('[data-nav="${screen}"]');
        if (btn) { btn.click(); return true; }
        return false;
      })()`);
      if (ok) await sleep(700);
      const broken = await page.evaluate(PROBE);
      if (broken.length) {
        failures += broken.length;
        console.log(`  x ${screen} @ ${width}px: ${broken.length} mid-word break(s)`);
        for (const b of broken.slice(0, 8)) console.log(`      "${b.token}" (${b.cls})`);
      } else {
        console.log(`  v ${screen} @ ${width}px: no mid-word breaks`);
      }
    }
    await page.close();
  }
} finally {
  await closeBrowser(browser);
}

console.log(`\nword-break audit: ${failures} mid-word break(s) across ${WIDTHS.length} widths`);
process.exit(failures ? 1 : 0);
