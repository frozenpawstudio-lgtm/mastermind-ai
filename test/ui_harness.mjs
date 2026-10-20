/*
 * Minimal Chrome DevTools Protocol harness for real-browser UI verification.
 *
 * It drives the system Chromium (no extra npm dependency) so the mobile layout
 * tests and the before/after screenshots exercise the real application in a
 * real browser engine rather than a DOM shim.
 *
 * The worker must be running locally (see README).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable"
].filter(Boolean);

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener("message", (event) => this.#onMessage(event.data));
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? "")})`));
      else resolve(message.result);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  once(method, sessionId, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`CDP event timeout: ${method}`));
      }, timeoutMs);
      const off = this.onEvent((message) => {
        if (message.method !== method) return;
        if (sessionId && message.sessionId !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(message.params);
      });
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

export async function launchBrowser({ windowWidth = 390, windowHeight = 900 } = {}) {
  const executable = findChrome();
  if (!executable) throw new Error("No Chromium/Chrome binary found. Set CHROME_PATH.");

  const child = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--mute-audio",
      "--remote-debugging-port=0",
      `--window-size=${windowWidth},${windowHeight}`,
      "about:blank"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not report a DevTools endpoint")), 30000);
    child.stderr.on("data", (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1].trim());
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited early with code ${code}`));
    });
  });

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("DevTools socket failed")), { once: true });
  });

  const connection = new CdpConnection(socket);
  connection.child = child;
  return connection;
}

export class Page {
  constructor(connection, sessionId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.consoleErrors = [];
    this.requests = [];
    this.#observe();
  }

  #observe() {
    this.connection.onEvent((message) => {
      if (message.sessionId !== this.sessionId) return;
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.consoleErrors.push({
          source: "console",
          text: (message.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ")
        });
      } else if (message.method === "Runtime.exceptionThrown") {
        this.consoleErrors.push({
          source: "exception",
          text: message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || "unknown"
        });
      } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
        this.consoleErrors.push({ source: "log", text: message.params.entry.text });
      } else if (message.method === "Network.requestWillBeSent") {
        this.requests.push({ method: message.params.request.method, url: message.params.request.url });
      }
    });
  }

  send(method, params = {}) {
    return this.connection.send(method, params, this.sessionId);
  }

  async setViewport(width, height, { deviceScaleFactor = 2, mobile = true } = {}) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
      screenWidth: width,
      screenHeight: height
    });
  }

  async goto(url, { settleMs = 900 } = {}) {
    const loaded = this.connection.once("Page.loadEventFired", this.sessionId);
    await this.send("Page.navigate", { url });
    await loaded;
    await sleep(settleMs);
  }

  /*
   * Installs a local HTML file as the document while keeping the current
   * origin, so the page's relative /api calls still reach the worker. Used to
   * render the committed baseline for a like-for-like layout comparison.
   */
  async installHtml(filePath, url) {
    const loaded = this.connection.once("Page.loadEventFired", this.sessionId);
    await this.send("Page.navigate", { url });
    await loaded;
    await this.send("Page.setDocumentContent", {
      frameId: this.targetId,
      html: readFileSync(filePath, "utf8")
    });
    await sleep(400);
    return true;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  async screenshot({ path, fullPage = true } = {}) {
    const shot = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
      fromSurface: true
    });
    if (path) {
      mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
      writeFileSync(path, Buffer.from(shot.data, "base64"));
    }
    return shot.data;
  }

  clearErrors() {
    this.consoleErrors.length = 0;
  }

  async close() {
    try {
      await this.connection.send("Target.closeTarget", { targetId: this.targetId });
    } catch {
      /* target may already be gone */
    }
  }
}

export async function newPage(connection, { width = 390, height = 900, dpr = 2 } = {}) {
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });

  const page = new Page(connection, sessionId);
  page.targetId = targetId;

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Network.enable");
  await page.setViewport(width, height, { deviceScaleFactor: dpr });
  return page;
}

export async function closeBrowser(connection) {
  connection.close();
  if (connection.child && !connection.child.killed) {
    connection.child.kill("SIGTERM");
    await sleep(300);
  }
}

export { sleep };

export const MOBILE_WIDTHS = [
  { label: "360", width: 360, height: 800 },
  { label: "390", width: 390, height: 844 },
  { label: "412", width: 412, height: 915 }
];

/*
 * Layout audit executed inside the page. It reports horizontal overflow for
 * the document and for every element, plus any element whose content escapes
 * its own box. This is what makes "no horizontal scrolling / no overlapping
 * text" a measurable claim instead of a visual impression.
 */
export const LAYOUT_AUDIT = `(() => {
  const vw = window.innerWidth;
  const de = document.documentElement;
  const offenders = [];
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.position === "fixed" && el.classList.contains("dock")) continue;
    // Visually-hidden helpers intentionally clip their own text.
    if (el.classList.contains("sr-only")) continue;
    if (style.position === "absolute" && (rect.width <= 1 || rect.height <= 1)) continue;
    const overflowRight = rect.right - vw;
    const overflowLeft = -rect.left;
    if (overflowRight > 1 || overflowLeft > 1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: (el.className && String(el.className).slice(0, 60)) || null,
        right: Math.round(rect.right),
        left: Math.round(rect.left),
        width: Math.round(rect.width)
      });
    }
    if (el.scrollWidth - el.clientWidth > 2 && style.overflowX !== "auto" && style.overflowX !== "scroll") {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: (el.className && String(el.className).slice(0, 60)) || null,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        kind: "content-overflow"
      });
    }
  }
  const tiny = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!el.textContent || !el.textContent.trim()) continue;
    if (el.children.length > 0) continue;
    if (el.classList.contains("sr-only")) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const size = parseFloat(style.fontSize);
    if (size && size < 10) {
      tiny.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 40), fontSize: size, text: el.textContent.trim().slice(0, 30) });
    }
  }
  return {
    viewportWidth: vw,
    documentScrollWidth: de.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    horizontalOverflow: de.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1,
    offenders: offenders.slice(0, 25),
    tinyText: tiny.slice(0, 15)
  };
})()`;
