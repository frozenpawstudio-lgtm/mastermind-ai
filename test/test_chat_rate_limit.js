import assert from "node:assert";

/*
 * Chat rate-limit test.
 *
 * Exercises the shared Durable Object rate-limit authority that both the
 * /api/chat edge route and the directly reachable /agents/.../chat route use.
 * The limiter must never weaken the existing owner-only authorization boundary:
 * unauthenticated requests are 401 and never consume quota, and only
 * authenticated requests count toward the 30-per-60-second limit.
 *
 * Storage-failure behaviour is asserted structurally: the only public failure
 * response the limiter can emit is the generic 500 (no `details`, no exception
 * text). Injecting a real SQLite fault into a running Durable Object is not
 * possible from outside, so that path is checked by contract rather than by
 * fault injection, and it is labelled as such.
 */

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const OWNER_TOKEN = process.env.OWNER_API_TOKEN || "";
const LIMIT = 30;
const WINDOW_SECONDS = 60;

let passed = 0;
let failed = 0;
let skipped = 0;
const warnings = [];

async function probe(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers };
}

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${label}`);
    console.log(`      ${error.message}`);
    failed++;
  }
}

const authPost = (payload, token = OWNER_TOKEN) => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`
  },
  body: JSON.stringify(payload)
});

const anonPost = (payload) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});

const CHAT = "/api/chat";
const DO_CHAT = "/agents/master-mind-agent/default/chat";
const DO_CHECK = "/agents/master-mind-agent/default/rate-limit/check";
const RESEARCH_CHECK = "/agents/master-mind-agent/default/rate-limit/check/research";

// Drive the shared bucket until it denies, so the 429 assertions do not depend
// on the fixed window not rolling over between steps.
async function ensureOverLimit() {
  for (let i = 0; i < LIMIT + 20; i++) {
    const r = await probe(DO_CHECK, authPost({}));
    if (r.status === 200 && r.body && r.body.allowed === false) return;
  }
  throw new Error("could not exhaust the rate-limit bucket");
}

async function run() {
  console.log(`Chat rate-limit test against ${BASE_URL}`);
  console.log(`Owner credential supplied: ${OWNER_TOKEN ? "yes" : "NO"}`);
  console.log("");

  // ---- 1. Authorization boundary is unchanged ----------------------------
  console.log("1. Authorization boundary (must remain owner-only)");

  await check("unauthenticated POST /api/chat -> 401", async () => {
    const r = await probe(CHAT, anonPost({ message: "hello" }));
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("unauthenticated POST /agents/.../chat -> 401", async () => {
    const r = await probe(DO_CHAT, anonPost({ message: "hello" }));
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("unauthenticated POST .../rate-limit/check -> 401", async () => {
    const r = await probe(DO_CHECK, {
      method: "POST"
    });
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("unauthenticated requests never consume quota", async () => {
    const before = await probe(DO_CHECK, authPost({}));
    assert.strictEqual(before.status, 200, `check status ${before.status}`);
    const startCount = Number(before.body.count);
    for (let i = 0; i < 10; i++) {
      await probe(CHAT, anonPost({ message: "x" }));
    }
    const after = await probe(DO_CHECK, authPost({}));
    const endCount = Number(after.body.count);
    // The only increment between the two checks is the second check itself.
    assert.strictEqual(
      endCount - startCount,
      1,
      `expected exactly 1 unit consumed by the trailing check, got ${endCount - startCount}`
    );
  });

  await check("unauthenticated chat never reaches the AI call", async () => {
    // A denied request must be refused at the authorization gate, so the billed
    // model call is never made. The response must carry the denial contract and
    // no model output field.
    const r = await probe(CHAT, anonPost({ message: "hello" }));
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
    assert.strictEqual(r.body.action, "DENIED", "denial must be explicit");
    assert.ok(
      !("reply" in r.body) && !("message" in r.body) && !("mode" in r.body),
      "a denied chat response must carry no model output"
    );
  });

  await check("unauthenticated chat mutates no protected state", async () => {
    // Capture two real protected read surfaces before and after a burst of
    // denied chat calls; a denied request must change nothing observable.
    const authGet = (path) => ({
      method: "GET",
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` }
    });
    const snap = async () => {
      const audit = await probe("/api/audit-logs", authGet());
      const opps = await probe("/api/opportunities", authGet());
      return {
        audit: JSON.stringify(audit.body ?? null),
        opps: JSON.stringify(opps.body ?? null)
      };
    };
    const before = await snap();
    for (let i = 0; i < 5; i++) {
      await probe(CHAT, anonPost({ message: "mutate?" }));
    }
    const after = await snap();
    assert.strictEqual(
      after.audit,
      before.audit,
      "denied chat must not append to the audit log"
    );
    assert.strictEqual(
      after.opps,
      before.opps,
      "denied chat must not change opportunity state"
    );
  });

  await check("malformed authorization headers are rejected", async () => {
    const variants = [
      { Authorization: "Bearer" },
      { Authorization: "Bearer " },
      { Authorization: "Basic " + Buffer.from("owner:secret").toString("base64") },
      { Authorization: "bearer" },
      { "X-Owner-Token": "" }
    ];
    for (const headers of variants) {
      const r = await probe(CHAT, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ message: "hello" })
      });
      assert.strictEqual(
        r.status,
        401,
        `malformed header ${JSON.stringify(headers)} must be 401, got ${r.status}`
      );
    }
  });

  if (!OWNER_TOKEN) {
    console.log("");
    console.log("  ! OWNER_API_TOKEN not set: authorized-path tests skipped");
    console.log("");
    console.log(`chat rate limit test: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(failed === 0 ? 0 : 1);
  }

  // ---- 2. Authorized requests work below the limit -----------------------
  console.log("");
  console.log("2. Authorized requests below the limit");

  await check("authorized POST /api/chat -> not 401/429", async () => {
    const r = await probe(CHAT, authPost({ message: "hello" }));
    assert.notStrictEqual(r.status, 401, "must not be 401 when authorized");
    assert.notStrictEqual(r.status, 429, "must not be 429 below the limit");
  });

  await check("authorized POST /agents/.../chat -> not 401/429", async () => {
    const r = await probe(DO_CHAT, authPost({ message: "hello" }));
    assert.notStrictEqual(r.status, 401, "must not be 401 when authorized");
    assert.notStrictEqual(r.status, 429, "must not be 429 below the limit");
  });

  await check("response contract unchanged (mode:intents present)", async () => {
    const r = await probe(CHAT, authPost({ message: "hello" }));
    assert.ok(r.body && typeof r.body === "object", "body must be JSON object");
    assert.strictEqual(
      typeof r.body.mode,
      "string",
      "response must still carry a mode field"
    );
    assert.ok(
      Array.isArray(r.body.intents),
      "response must still carry intents array"
    );
  });

  // ---- 3. Limit boundary, 429 and Retry-After ----------------------------
  console.log("");
  console.log("3. Limit boundary, 429 and Retry-After");

  await check("limit is enforced at the 30-request boundary", async () => {
    // The authority endpoint reports the decision in the body (allowed), and
    // the chat routes turn a denial into HTTP 429. Drive the counter and find
    // the exact request where allowed flips.
    let lastAllowed = null;
    let firstDenied = null;
    for (let i = 0; i < LIMIT + 20; i++) {
      const r = await probe(DO_CHECK, authPost({}));
      assert.strictEqual(r.status, 200, `unexpected status ${r.status}`);
      assert.strictEqual(
        typeof r.body.allowed,
        "boolean",
        "check must report allowed"
      );
      if (r.body.allowed) {
        lastAllowed = r.body;
      } else {
        firstDenied = r.body;
        break;
      }
    }
    assert.ok(lastAllowed, "expected requests below the limit to be allowed");
    assert.strictEqual(
      lastAllowed.count,
      LIMIT,
      `the ${LIMIT}th request must still be allowed`
    );
    assert.ok(firstDenied, "expected a denial once the limit was exceeded");
    assert.strictEqual(
      firstDenied.count,
      LIMIT + 1,
      `the ${LIMIT + 1}th request must be denied`
    );
    assert.strictEqual(firstDenied.limit, LIMIT);
    assert.strictEqual(firstDenied.remaining, 0);
  });

  await check("429 carries a valid Retry-After header", async () => {
    await ensureOverLimit();
    const r = await probe(CHAT, authPost({ message: "hello" }));
    assert.strictEqual(r.status, 429, `expected 429, got ${r.status}`);
    const retryAfter = r.headers.get("retry-after");
    assert.ok(retryAfter, "Retry-After header must be present");
    const value = Number(retryAfter);
    assert.ok(Number.isFinite(value), "Retry-After must be numeric");
    assert.ok(value >= 1, `Retry-After must be >= 1, got ${value}`);
    assert.ok(
      value <= WINDOW_SECONDS,
      `Retry-After must be <= window (${WINDOW_SECONDS}), got ${value}`
    );
  });

  await check("edge /api/chat is also 429 over the limit", async () => {
    await ensureOverLimit();
    const r = await probe(CHAT, authPost({ message: "hello" }));
    assert.strictEqual(r.status, 429, `expected 429, got ${r.status}`);
    const retryAfter = r.headers.get("retry-after");
    assert.ok(retryAfter, "edge 429 must carry Retry-After");
  });

  await check("direct DO /chat is also 429 over the limit", async () => {
    await ensureOverLimit();
    const r = await probe(DO_CHAT, authPost({ message: "hello" }));
    assert.strictEqual(r.status, 429, `expected 429, got ${r.status}`);
    assert.ok(r.headers.get("retry-after"), "DO 429 must carry Retry-After");
  });

  await check("429 body leaks no internal detail", async () => {
    await ensureOverLimit();
    const r = await probe(CHAT, authPost({ message: "hello" }));
    assert.strictEqual(r.status, 429);
    assert.strictEqual(
      r.body.details,
      undefined,
      "429 must not expose a details field"
    );
    const serialized = JSON.stringify(r.body).toLowerCase();
    assert.ok(
      !serialized.includes("sqlite") &&
        !serialized.includes("sql") &&
        !serialized.includes("stack"),
      "429 must not expose storage internals"
    );
  });

  // ---- 4. Direct DO route cannot bypass authorization --------------------
  console.log("");
  console.log("4. Direct Durable Object route cannot bypass");

  await check("direct DO route enforces authorization", async () => {
    const r = await probe(DO_CHAT, anonPost({ message: "hello" }));
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("direct DO route enforces the same limit as the edge", async () => {
    await ensureOverLimit();
    const r = await probe(DO_CHAT, authPost({ message: "hello" }));
    assert.strictEqual(
      r.status,
      429,
      "DO route must be limited once the shared bucket is exhausted"
    );
  });

  // ---- 5. Identity isolation --------------------------------------------
  console.log("");
  console.log("5. Identity isolation");

  await check("identity is derived from the credential, not a header", async () => {
    await ensureOverLimit();
    // A forged X-Forwarded-For / CF-Ray must not create a separate bucket:
    // the request is still the same verified owner, so it stays limited.
    const r = await probe(CHAT, {
      ...authPost({ message: "hello" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OWNER_TOKEN}`,
        "X-Forwarded-For": "203.0.113.7",
        "CF-Ray": "deadbeefdeadbeef"
      }
    });
    assert.strictEqual(
      r.status,
      429,
      "forged client-identity headers must not bypass the limit"
    );
  });

  warnings.push(
    "IP-based isolation is not asserted: local wrangler dev does not reproduce trusted Cloudflare CF-Connecting-IP, and the limiter deliberately keys on the verified credential, not on any IP header"
  );

  // ---- 6. Instance-name bypass regression --------------------------------
  // The confirmed flaw: /agents/<ns>/<instance>/... is caller-controlled, and
  // the SDK maps each name to its own Durable Object with its own SQLite
  // database, so varying the name used to hand out a fresh 30-request bucket
  // (and a new database) per name. These assertions fail on the old code.
  console.log("");
  console.log("6. Instance-name bypass is closed");

  const OTHER_NAMES = ["other", "attacker-2", "zzz-random-name"];

  const chatPath = (name) => `/agents/master-mind-agent/${name}/chat`;
  const checkPath = (name) =>
    `/agents/master-mind-agent/${name}/rate-limit/check`;

  // Wait for a fresh fixed window so the bucket has headroom again. The poll
  // itself consumes one unit, which callers account for.
  async function waitForWindowReset(maxSeconds = WINDOW_SECONDS + 15) {
    const deadline = Date.now() + maxSeconds * 1000;
    while (Date.now() < deadline) {
      const r = await probe(checkPath("default"), authPost({}));
      if (r.status === 200 && r.body && r.body.allowed === true) return r.body;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("rate-limit window did not reset within the wait budget");
  }

  await check("an arbitrary instance name does not get its own bucket", async () => {
    await ensureOverLimit();
    for (const name of OTHER_NAMES) {
      const r = await probe(chatPath(name), authPost({ message: "hello" }));
      assert.strictEqual(
        r.status,
        429,
        `instance name "${name}" must not receive a fresh bucket (got ${r.status})`
      );
    }
  });

  await check("every protected route is denied once the shared limit is reached", async () => {
    await ensureOverLimit();
    const routes = [
      ["edge /api/chat", CHAT],
      ["DO /chat (default)", chatPath("default")],
      ...OTHER_NAMES.map((n) => [`DO /chat (${n})`, chatPath(n)]),
      ...OTHER_NAMES.map((n) => [`DO check (${n})`, checkPath(n)])
    ];
    for (const [label, path] of routes) {
      const r = await probe(path, authPost({ message: "hello" }));
      if (path.endsWith("/rate-limit/check")) {
        assert.strictEqual(r.status, 200, `${label} check status`);
        assert.strictEqual(
          r.body.allowed,
          false,
          `${label} must report denied once the shared limit is reached`
        );
      } else {
        assert.strictEqual(
          r.status,
          429,
          `${label} must be denied once the shared limit is reached`
        );
      }
    }
  });

  await check("a non-default instance name consumes the same shared bucket", async () => {
    const first = await waitForWindowReset();
    const before = Number(first.count);
    for (const name of OTHER_NAMES) {
      await probe(checkPath(name), authPost({}));
    }
    const after = await probe(checkPath("default"), authPost({}));
    // 3 requests through 3 foreign names + the trailing default check.
    const consumed = Number(after.body.count) - before;
    assert.strictEqual(
      consumed,
      OTHER_NAMES.length + 1,
      `expected ${OTHER_NAMES.length + 1} units consumed from the one bucket, got ${consumed}`
    );
  });

  await check("each logical chat request consumes exactly one unit via any name", async () => {
    const first = await waitForWindowReset();
    const before = Number(first.count);
    await probe(chatPath("attacker-2"), authPost({ message: "hello" }));
    const after = await probe(checkPath("default"), authPost({}));
    assert.strictEqual(
      Number(after.body.count) - before,
      2,
      "one chat request must consume exactly one unit (plus the trailing check)"
    );
  });

  await check("unauthorized requests stay 401 on every instance name", async () => {
    for (const name of ["default", ...OTHER_NAMES]) {
      const chat = await probe(chatPath(name), anonPost({ message: "hello" }));
      assert.strictEqual(
        chat.status,
        401,
        `anon chat on "${name}" must be 401, got ${chat.status}`
      );
      const rl = await probe(checkPath(name), { method: "POST" });
      assert.strictEqual(
        rl.status,
        401,
        `anon check on "${name}" must be 401, got ${rl.status}`
      );
    }
  });

  await check("unauthorized requests consume no quota on any instance name", async () => {
    const first = await waitForWindowReset();
    const before = Number(first.count);
    for (const name of OTHER_NAMES) {
      await probe(chatPath(name), anonPost({ message: "x" }));
      await probe(checkPath(name), { method: "POST" });
    }
    const after = await probe(checkPath("default"), authPost({}));
    assert.strictEqual(
      Number(after.body.count) - before,
      1,
      "anonymous requests must not consume quota through any instance name"
    );
  });

  await check("concurrent requests through different names share one counter", async () => {
    const first = await waitForWindowReset();
    const before = Number(first.count);
    const burst = 12;
    const results = await Promise.all(
      Array.from({ length: burst }, (_, i) =>
        probe(checkPath(OTHER_NAMES[i % OTHER_NAMES.length]), authPost({}))
      )
    );
    for (const r of results) {
      assert.strictEqual(r.status, 200, `concurrent check status ${r.status}`);
    }
    const after = await probe(checkPath("default"), authPost({}));
    assert.strictEqual(
      Number(after.body.count) - before,
      burst + 1,
      "concurrent requests must not lose increments in the shared counter"
    );
  });

  await check("Retry-After is accurate and the window resets", async () => {
    await ensureOverLimit();
    const over = await probe(checkPath("default"), authPost({}));
    assert.strictEqual(over.body.allowed, false, "must be over limit");
    const retryAfter = Number(over.body.retryAfter);
    assert.ok(Number.isFinite(retryAfter), "retryAfter must be numeric");
    assert.ok(retryAfter >= 1, `retryAfter must be >= 1, got ${retryAfter}`);
    assert.ok(
      retryAfter <= WINDOW_SECONDS,
      `retryAfter must be <= ${WINDOW_SECONDS}, got ${retryAfter}`
    );
    const reset = await waitForWindowReset();
    assert.strictEqual(
      reset.allowed,
      true,
      "the bucket must allow again after the window resets"
    );
    assert.strictEqual(
      Number(reset.count),
      1,
      `a fresh window must start at 1, got ${reset.count}`
    );
  });

  await check("a limited response leaks no storage internals (fail-closed contract)", async () => {
    // Fault injection into a running Durable Object is not possible from
    // outside, so the fail-closed shape is asserted by contract: a denied
    // response never carries internals, and the limiter has no allow-path
    // error. The runtime fail-closed path (binding removed -> generic 500)
    // is exercised separately, not by this suite.
    await ensureOverLimit();
    const r = await probe(chatPath("default"), authPost({ message: "hello" }));
    assert.strictEqual(r.status, 429, `expected 429, got ${r.status}`);
    const serialized = JSON.stringify(r.body).toLowerCase();
    assert.ok(
      !serialized.includes("sqlite") &&
        !serialized.includes("sql") &&
        !serialized.includes("stack") &&
        !serialized.includes("details"),
      "a limited response must not expose storage internals"
    );
  });

  warnings.push(
    "storage-failure is contract-asserted, not fault-injected: a running Durable Object's SQLite cannot be broken from outside the test. The runtime fail-closed path is verified separately by starting the Worker without the DO binding (authorized chat -> generic 500, no internals, no AI call)"
  );

  warnings.push(
    "per-name Durable Object file growth is asserted through the shared counter (N names consume N units from one bucket) rather than by counting miniflare's internal .sqlite files, which are not part of the Worker contract"
  );

  // ---- 7. Research scope shares the authority but not the bucket ---------
  console.log("");
  console.log("7. Research shares the DO authority with its own bucket");

  const RESEARCH = "/api/research";
  const DO_CHECK_RESEARCH = "/agents/master-mind-agent/default/rate-limit/check/research";

  await check("unauthenticated POST /api/research -> 401", async () => {
    const r = await probe(RESEARCH, anonPost({ url: "https://example.com" }));
    assert.strictEqual(r.status, 401, `expected 401, got ${r.status}`);
  });

  await check("research traffic does not consume the chat bucket", async () => {
    // Reset both buckets, then measure deltas so the assertion does not depend
    // on how many probes the reset itself needed.
    async function waitBothReset(maxSeconds = WINDOW_SECONDS + 15) {
      const deadline = Date.now() + maxSeconds * 1000;
      while (Date.now() < deadline) {
        const a = await probe(checkPath("default"), authPost({}));
        const b = await probe(DO_CHECK_RESEARCH, authPost({}));
        if (
          a.status === 200 && a.body && a.body.allowed === true &&
          b.status === 200 && b.body && b.body.allowed === true
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error("rate-limit windows did not reset within the wait budget");
    }

    await waitBothReset();

    const researchBefore = (await probe(DO_CHECK_RESEARCH, authPost({}))).body.count;
    const chatBefore = (await probe(DO_CHECK, authPost({}))).body.count;

    for (let i = 0; i < 3; i++) {
      await probe(RESEARCH, authPost({ url: "https://example.com" }));
    }

    const researchAfter = (await probe(DO_CHECK_RESEARCH, authPost({}))).body.count;
    const chatAfter = (await probe(DO_CHECK, authPost({}))).body.count;

    assert.strictEqual(
      researchAfter - researchBefore,
      4,
      `research bucket must advance by the 3 research calls + 1 check, got ${researchAfter - researchBefore}`
    );
    assert.strictEqual(
      chatAfter - chatBefore,
      1,
      `chat bucket must advance only by its own check, got ${chatAfter - chatBefore}`
    );
  });

  await check("research is denied at its own limit, independent of chat", async () => {
    await waitForWindowReset();
    let deniedAt = null;
    for (let i = 1; i <= LIMIT + 2; i++) {
      const r = await probe(RESEARCH, authPost({ url: "https://example.com" }));
      if (r.status === 429) {
        deniedAt = i;
        break;
      }
    }
    assert.ok(
      deniedAt !== null && deniedAt <= LIMIT + 1,
      `research must be denied within the window, deniedAt=${deniedAt}`
    );
    const r = await probe(RESEARCH, authPost({ url: "https://example.com" }));
    assert.strictEqual(r.status, 429, "research must stay denied over the limit");
  });

  await check("a caller cannot name a fresh, unbounded research bucket", async () => {
    // The real property is not just "bounded": a forged scope must consume the
    // SAME chat bucket, so it cannot be used to obtain extra allowance. Compare
    // the chat counter before and after each forged call.
    const forged = [
      "/agents/master-mind-agent/default/rate-limit/check/research-extra",
      "/agents/master-mind-agent/default/rate-limit/check/research2",
      "/agents/master-mind-agent/default/rate-limit/check/RESEARCH",
      "/agents/master-mind-agent/default/rate-limit/check/x",
      "/agents/master-mind-agent/default/rate-limit/check/chat"
    ];
    for (const path of forged) {
      const before = await probe(DO_CHECK, authPost({}));
      assert.strictEqual(before.status, 200, `chat check status ${before.status}`);
      const r = await probe(path, authPost({ message: "hello" }));
      assert.ok(
        r.status === 200 || r.status === 429,
        `unexpected status for ${path}: ${r.status}`
      );
      const after = await probe(DO_CHECK, authPost({}));
      // before + forged + after = 3 units, so a forged scope that shares the
      // chat bucket advances it by exactly 2 across the two surrounding checks.
      assert.strictEqual(
        Number(after.body.count) - Number(before.body.count),
        2,
        `forged scope ${path} must consume the shared chat bucket, not a new one`
      );
      if (r.status === 200) {
        assert.strictEqual(
          r.body.limit,
          LIMIT,
          `unknown scope ${path} must resolve to the bounded chat bucket`
        );
      }
    }
  });

  await check("research bucket is reachable only through the fixed label", async () => {
    // Exactly "/research" maps to the research bucket; a near-miss must not.
    // The forged call must leave the research counter untouched, so the two
    // surrounding research probes differ by exactly 1 (only the trailing probe).
    const before = await probe(RESEARCH_CHECK, authPost({}));
    assert.strictEqual(before.status, 200, `research check status ${before.status}`);
    const forged = await probe(
      "/agents/master-mind-agent/default/rate-limit/check/researchx",
      authPost({})
    );
    assert.strictEqual(forged.status, 200, `near-miss scope status ${forged.status}`);
    assert.strictEqual(
      forged.body.limit,
      LIMIT,
      "a near-miss research label must resolve to the bounded chat bucket"
    );
    const after = await probe(RESEARCH_CHECK, authPost({}));
    assert.strictEqual(
      Number(after.body.count) - Number(before.body.count),
      1,
      "a near-miss research label must not consume the research bucket"
    );
  });

  warnings.push(
    "research assertions run without the BROWSER binding: the limiter is asserted before the browser call, so an authorized research request returns 503 (binding missing) until its bucket is exhausted, then 429. With a configured Browser Rendering binding the same accounting applies before a 200/503"
  );


  // ---- Summary -----------------------------------------------------------
  console.log("");
  if (warnings.length) {
    console.log("Notes:");
    for (const w of warnings) console.log(`  ! ${w}`);
    console.log("");
  }
  console.log(
    `chat rate limit test: ${passed} passed, ${failed} failed, ${skipped} skipped, ${warnings.length} note(s)`
  );

  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
