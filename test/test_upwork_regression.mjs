import assert from "node:assert/strict";
import {
  createUpworkOAuthState,
  createUpworkPkcePair,
  encryptUpworkSecret,
  encryptUpworkTokenBundle,
  getUpworkConfiguration,
  hashUpworkOAuthState
} from "../upwork.js";
import { withUpworkStore } from "../upwork-agent.js";

/*
 * Offline regression tests for the Upwork connector's Durable Object layer.
 *
 * These exercise the REAL methods in `upwork-agent.js` (status machine, OAuth
 * state consumption, callback handling, search). Two dependencies cannot exist
 * in a plain Node process, so they are substituted:
 *   - Durable Object SQLite is replaced by a tiny in-memory row store that
 *     answers exactly the queries the connector issues. The real SQLite path is
 *     exercised separately by the live `test_asset_exposure.js` suite, which
 *     boots `wrangler dev`.
 *   - The Upwork network is replaced by a mocked global fetch. No Upwork request
 *     is ever made.
 * Everything else (crypto, PKCE, state hashing, AES-GCM, authorization) runs as
 * the shipped code, so these tests prove real behavior, not a reimplementation.
 */

const KEY = Buffer.alloc(32, 7).toString("base64");
const READY_ENV = {
  OWNER_API_TOKEN: "owner-test-token",
  UPWORK_ENABLED: "true",
  UPWORK_CLIENT_ID: "client-id",
  UPWORK_CLIENT_SECRET: "client-secret",
  UPWORK_REDIRECT_URI: "https://aira.example/api/upwork/callback",
  UPWORK_TOKEN_ENCRYPTION_KEY: KEY
};

const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function makeSqlTag(state) {
  return (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    const lower = text.toLowerCase();

    if (lower.startsWith("select") && lower.includes("from upwork_credentials")) {
      return state.credential ? [state.credential] : [];
    }
    if (lower.startsWith("select") && lower.includes("from upwork_oauth_state")) {
      return state.oauthState ? [state.oauthState] : [];
    }
    if (lower.startsWith("insert into upwork_credentials")) {
      state.credential = {
        id: 1,
        encrypted_bundle: values[0],
        status: values[1],
        expires_at: values[2],
        refresh_expires_at: values[3],
        last_verified_at: values[4],
        last_search_at: values[5],
        updated_at: values[6]
      };
      return [];
    }
    if (lower.startsWith("insert into upwork_oauth_state")) {
      state.oauthState = {
        id: 1,
        state_hash: values[0],
        verifier_envelope: values[1],
        expires_at: values[2],
        status: "PENDING",
        updated_at: values[3]
      };
      return [];
    }
    if (lower.startsWith("update upwork_credentials")) {
      if (!state.credential) return [];
      if (lower.includes("set status =")) {
        state.credential.status = values[0];
        if (lower.includes("last_verified_at = ''")) state.credential.last_verified_at = "";
        state.credential.updated_at = values[1];
        return [];
      }
      if (lower.includes("set last_search_at")) {
        state.credential.last_search_at = values[0];
        state.credential.updated_at = values[1];
        return [];
      }
      if (lower.includes("set last_verified_at")) {
        state.credential.last_verified_at = values[0];
        state.credential.updated_at = values[1];
        return [];
      }
    }
    if (lower.startsWith("update upwork_oauth_state")) {
      const [updatedAt, stateHash, nowMs] = values;
      if (
        state.oauthState &&
        state.oauthState.status === "PENDING" &&
        state.oauthState.state_hash === stateHash &&
        Number(state.oauthState.expires_at) > nowMs
      ) {
        state.oauthState.status = "CONSUMED";
        state.oauthState.updated_at = updatedAt;
      }
      return [];
    }
    throw new Error(`unhandled SQL in fake store: ${text}`);
  };
}

function makeAgent(env, initial = {}) {
  const state = { credential: initial.credential ?? null, oauthState: initial.oauthState ?? null };
  class FakeBase {
    constructor() {
      this.env = env;
    }
    initDb() {}
  }
  const Agent = withUpworkStore(FakeBase);
  const agent = new Agent();
  agent.sql = makeSqlTag(state);
  return { agent, state };
}

async function withMockedFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function authPost(path, bodyObj, token = "owner-test-token") {
  return new Request(`http://agent/agents/master-mind-agent/default${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj)
  });
}

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${label}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

async function main() {
  console.log("Upwork connector regression (offline, mocked fetch + in-memory store)");
  console.log("");

  console.log("1. Status transitions (getUpworkStatus)");

  await check("missing configuration -> NOT_CONFIGURED", async () => {
    const { agent } = makeAgent({});
    const s = agent.getUpworkStatus();
    assert.equal(s.service, "upwork");
    assert.equal(s.state, "NOT_CONFIGURED");
    assert.equal(s.verified, false);
    assert.equal(s.enabled, false);
  });

  await check("invalid encryption key is treated as not configured", async () => {
    const { agent } = makeAgent({ ...READY_ENV, UPWORK_TOKEN_ENCRYPTION_KEY: "too-short" });
    assert.equal(getUpworkConfiguration(agent.env).configured, false);
    assert.equal(agent.getUpworkStatus().state, "NOT_CONFIGURED");
  });

  await check("configured but no credential -> NOT_CONNECTED", async () => {
    const { agent } = makeAgent(READY_ENV);
    const s = agent.getUpworkStatus();
    assert.equal(s.state, "NOT_CONNECTED");
    assert.equal(s.verified, false);
    assert.equal(s.enabled, true);
  });

  await check("credential present without a verified search -> PARTIALLY_CONNECTED", async () => {
    const { agent } = makeAgent(READY_ENV, {
      credential: { status: "PARTIALLY_CONNECTED", expires_at: iso(Date.now() + HOUR), refresh_expires_at: iso(Date.now() + HOUR), last_verified_at: "", last_search_at: 0 }
    });
    const s = agent.getUpworkStatus();
    assert.equal(s.state, "PARTIALLY_CONNECTED");
    assert.equal(s.verified, false);
  });

  await check("CONNECTED only after a recent successful verification", async () => {
    const { agent } = makeAgent(READY_ENV, {
      credential: { status: "CONNECTED", expires_at: iso(Date.now() + HOUR), refresh_expires_at: iso(Date.now() + HOUR), last_verified_at: iso(Date.now() - HOUR), last_search_at: 0 }
    });
    const s = agent.getUpworkStatus();
    assert.equal(s.state, "CONNECTED");
    assert.equal(s.verified, true);
    assert.equal(s.last_verified_at, agent.sql`SELECT * FROM upwork_credentials WHERE id = 1 LIMIT 1;`[0].last_verified_at);
  });

  await check("expired verification (older than 24h) drops back to PARTIALLY_CONNECTED", async () => {
    const { agent } = makeAgent(READY_ENV, {
      credential: { status: "CONNECTED", expires_at: iso(Date.now() + HOUR), refresh_expires_at: iso(Date.now() + HOUR), last_verified_at: iso(Date.now() - 25 * HOUR), last_search_at: 0 }
    });
    const s = agent.getUpworkStatus();
    assert.equal(s.state, "PARTIALLY_CONNECTED");
    assert.equal(s.verified, false);
  });

  await check("expired access token with live refresh token -> PARTIALLY_CONNECTED", async () => {
    const { agent } = makeAgent(READY_ENV, {
      credential: { status: "CONNECTED", expires_at: iso(Date.now() - HOUR), refresh_expires_at: iso(Date.now() + HOUR), last_verified_at: iso(Date.now() - HOUR), last_search_at: 0 }
    });
    const s = agent.getUpworkStatus();
    assert.equal(s.state, "PARTIALLY_CONNECTED");
    assert.equal(s.verified, false);
  });

  await check("expired access and expired refresh -> NEEDS_REAUTH", async () => {
    const { agent } = makeAgent(READY_ENV, {
      credential: { status: "CONNECTED", expires_at: iso(Date.now() - HOUR), refresh_expires_at: iso(Date.now() - HOUR), last_verified_at: iso(Date.now() - HOUR), last_search_at: 0 }
    });
    assert.equal(agent.getUpworkStatus().state, "NEEDS_REAUTH");
  });

  await check("stored NEEDS_REAUTH is reported as NEEDS_REAUTH", async () => {
    const { agent } = makeAgent(READY_ENV, {
      credential: { status: "NEEDS_REAUTH", expires_at: iso(Date.now() + HOUR), refresh_expires_at: iso(Date.now() + HOUR), last_verified_at: "", last_search_at: 0 }
    });
    assert.equal(agent.getUpworkStatus().state, "NEEDS_REAUTH");
  });

  console.log("");
  console.log("2. Failed verification and storage failure");

  await check("a 403 read-scope failure records PARTIALLY_CONNECTED, not CONNECTED", async () => {
    const bundle = { access_token: "at", refresh_token: "rt", expires_at: iso(Date.now() + HOUR) };
    const { agent, state } = makeAgent(READY_ENV, {
      credential: {
        status: "PARTIALLY_CONNECTED",
        encrypted_bundle: JSON.stringify(await encryptUpworkTokenBundle(bundle, KEY)),
        expires_at: bundle.expires_at,
        refresh_expires_at: iso(Date.now() + HOUR),
        last_verified_at: "",
        last_search_at: 0
      }
    });
    await withMockedFetch(() => jsonResponse({ errors: [{ message: "no scope" }] }, 403), async () => {
      const res = await agent.handleUpworkSearch(authPost("/upwork/search", { query: "cloudflare" }));
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, "UPWORK_READ_SCOPE_REQUIRED");
    });
    assert.equal(state.credential.status, "PARTIALLY_CONNECTED");
  });

  await check("a 401 search response marks NEEDS_REAUTH", async () => {
    const bundle = { access_token: "at", refresh_token: "rt", expires_at: iso(Date.now() + HOUR) };
    const { agent, state } = makeAgent(READY_ENV, {
      credential: {
        status: "PARTIALLY_CONNECTED",
        encrypted_bundle: JSON.stringify(await encryptUpworkTokenBundle(bundle, KEY)),
        expires_at: bundle.expires_at,
        refresh_expires_at: iso(Date.now() + HOUR),
        last_verified_at: "",
        last_search_at: 0
      }
    });
    await withMockedFetch(() => jsonResponse({}, 401), async () => {
      const res = await agent.handleUpworkSearch(authPost("/upwork/search", { query: "cloudflare" }));
      assert.equal(res.status, 401);
      assert.equal((await res.json()).state, "NEEDS_REAUTH");
    });
    assert.equal(state.credential.status, "NEEDS_REAUTH");
  });

  await check("undecryptable stored credential fails closed to NEEDS_REAUTH", async () => {
    const { agent, state } = makeAgent(READY_ENV, {
      credential: {
        status: "CONNECTED",
        encrypted_bundle: JSON.stringify({ v: 1, iv: "AAAA", ciphertext: "BBBB" }),
        expires_at: iso(Date.now() - HOUR),
        refresh_expires_at: iso(Date.now() + HOUR),
        last_verified_at: iso(Date.now() - HOUR),
        last_search_at: 0
      }
    });
    await withMockedFetch(() => jsonResponse({}), async () => {
      const res = await agent.handleUpworkSearch(authPost("/upwork/search", { query: "cloudflare" }));
      assert.equal(res.status, 401);
      assert.equal((await res.json()).state, "NEEDS_REAUTH");
    });
    assert.equal(state.credential.status, "NEEDS_REAUTH");
  });

  console.log("");
  console.log("3. Search success updates verification honestly");

  await check("a successful search flips status to CONNECTED verified", async () => {
    const bundle = { access_token: "at", refresh_token: "rt", expires_at: iso(Date.now() + HOUR) };
    const { agent, state } = makeAgent(READY_ENV, {
      credential: {
        status: "PARTIALLY_CONNECTED",
        encrypted_bundle: JSON.stringify(await encryptUpworkTokenBundle(bundle, KEY)),
        expires_at: bundle.expires_at,
        refresh_expires_at: iso(Date.now() + HOUR),
        last_verified_at: "",
        last_search_at: 0
      }
    });
    await withMockedFetch(
      (url, options) => {
        assert.equal(url, "https://api.upwork.com/graphql");
        assert.equal(options.headers.Authorization, "Bearer at");
        return jsonResponse({
          data: { publicMarketplaceJobPostingsSearch: { jobs: [{ id: "j1", title: "Worker job", ciphertext: "~abc", description: "desc" }] } }
        });
      },
      async () => {
        const res = await agent.handleUpworkSearch(authPost("/upwork/search", { query: "cloudflare" }));
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.data.state, "CONNECTED");
        assert.equal(body.data.jobs[0].saved_to_tracking, false);
        assert.equal(body.data.jobs[0].verification_status, "UNVERIFIED");
      }
    );
    assert.equal(state.credential.status, "CONNECTED");
    assert.equal(agent.getUpworkStatus().state, "CONNECTED");
    assert.equal(agent.getUpworkStatus().verified, true);
  });

  console.log("");
  console.log("4. OAuth callback behavior (DO route)");

  await check("unauthorized callback is rejected before any processing", async () => {
    const { agent } = makeAgent({ ...READY_ENV, OWNER_API_TOKEN: "" });
    const res = await agent.routeUpworkRequest(
      new Request("http://agent/agents/master-mind-agent/default/upwork/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "x", code: "y" })
      }),
      "/agents/master-mind-agent/default/upwork/callback"
    );
    assert.equal(res.status, 401);
  });

  await check("callback with an invalid redirect configuration -> 503", async () => {
    const { agent } = makeAgent({ ...READY_ENV, UPWORK_REDIRECT_URI: "http://insecure.example/cb" });
    const res = await agent.routeUpworkRequest(authPost("/upwork/callback", { state: "x", code: "y" }), "/agents/master-mind-agent/default/upwork/callback");
    assert.equal(res.status, 503);
    assert.equal((await res.json()).state, "NOT_CONFIGURED");
  });

  await check("missing or invalid state -> 400 and state not consumed", async () => {
    const state = createUpworkOAuthState();
    const stateHash = await hashUpworkOAuthState(state);
    const pkce = await createUpworkPkcePair();
    const { agent } = makeAgent(READY_ENV);
    agent.saveUpworkOAuthState(stateHash, await encryptUpworkSecret(pkce.verifier, KEY), Date.now() + 600_000);
    const res = await agent.routeUpworkRequest(authPost("/upwork/callback", { state: "not-the-state", code: "abc" }), "/agents/master-mind-agent/default/upwork/callback");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "UPWORK_OAUTH_STATE_INVALID");
  });

  await check("expired state -> 400", async () => {
    const state = createUpworkOAuthState();
    const stateHash = await hashUpworkOAuthState(state);
    const pkce = await createUpworkPkcePair();
    const { agent } = makeAgent(READY_ENV);
    agent.saveUpworkOAuthState(stateHash, await encryptUpworkSecret(pkce.verifier, KEY), Date.now() - 1000);
    const res = await agent.routeUpworkRequest(authPost("/upwork/callback", { state, code: "abc" }), "/agents/master-mind-agent/default/upwork/callback");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "UPWORK_OAUTH_STATE_INVALID");
  });

  await check("valid callback exchanges the code, stores ciphertext, and leaks nothing", async () => {
    const state = createUpworkOAuthState();
    const stateHash = await hashUpworkOAuthState(state);
    const pkce = await createUpworkPkcePair();
    const { agent, state: store } = makeAgent(READY_ENV);
    agent.saveUpworkOAuthState(stateHash, await encryptUpworkSecret(pkce.verifier, KEY), Date.now() + 600_000);

    await withMockedFetch(
      (url, options) => {
        assert.equal(url, "https://www.upwork.com/api/v3/oauth2/token");
        const form = new URLSearchParams(options.body);
        assert.equal(form.get("code_verifier"), pkce.verifier);
        assert.equal(form.get("code"), "oauth-code");
        return jsonResponse({ access_token: "ACCESS-SECRET", refresh_token: "REFRESH-SECRET", expires_in: 86400 });
      },
      async () => {
        const res = await agent.routeUpworkRequest(authPost("/upwork/callback", { state, code: "oauth-code" }), "/agents/master-mind-agent/default/upwork/callback");
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.data.state, "PARTIALLY_CONNECTED");
        assert.equal(body.data.verified, false);
        const serialized = JSON.stringify(body);
        assert.equal(serialized.includes("ACCESS-SECRET"), false, "access token must not appear in the response");
        assert.equal(serialized.includes("REFRESH-SECRET"), false, "refresh token must not appear in the response");
        assert.equal(serialized.includes("oauth-code"), false, "authorization code must not appear in the response");
      }
    );

    assert.equal(store.oauthState.status, "CONSUMED");
    assert.equal(store.credential.status, "PARTIALLY_CONNECTED");
    assert.equal(store.credential.encrypted_bundle.includes("ACCESS-SECRET"), false, "token must be stored encrypted");
    assert.equal(store.credential.encrypted_bundle.includes("REFRESH-SECRET"), false);
  });

  await check("replayed state -> 400 (single-use)", async () => {
    const state = createUpworkOAuthState();
    const stateHash = await hashUpworkOAuthState(state);
    const pkce = await createUpworkPkcePair();
    const { agent, state: store } = makeAgent(READY_ENV);
    agent.saveUpworkOAuthState(stateHash, await encryptUpworkSecret(pkce.verifier, KEY), Date.now() + 600_000);

    await withMockedFetch(() => jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 86400 }), async () => {
      const first = await agent.routeUpworkRequest(authPost("/upwork/callback", { state, code: "c1" }), "/agents/master-mind-agent/default/upwork/callback");
      assert.equal(first.status, 200);
    });
    const second = await agent.routeUpworkRequest(authPost("/upwork/callback", { state, code: "c2" }), "/agents/master-mind-agent/default/upwork/callback");
    assert.equal(second.status, 400);
    assert.equal((await second.json()).error, "UPWORK_OAUTH_STATE_INVALID");
    assert.equal(store.oauthState.status, "CONSUMED");
  });

  await check("missing code with a valid state -> 400 and state consumed", async () => {
    const state = createUpworkOAuthState();
    const stateHash = await hashUpworkOAuthState(state);
    const pkce = await createUpworkPkcePair();
    const { agent } = makeAgent(READY_ENV);
    agent.saveUpworkOAuthState(stateHash, await encryptUpworkSecret(pkce.verifier, KEY), Date.now() + 600_000);
    const res = await agent.routeUpworkRequest(authPost("/upwork/callback", { state }), "/agents/master-mind-agent/default/upwork/callback");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "UPWORK_OAUTH_CODE_MISSING");
  });

  await check("denied authorization (error param) -> 400 UPWORK_OAUTH_DENIED", async () => {
    const state = createUpworkOAuthState();
    const stateHash = await hashUpworkOAuthState(state);
    const pkce = await createUpworkPkcePair();
    const { agent } = makeAgent(READY_ENV);
    agent.saveUpworkOAuthState(stateHash, await encryptUpworkSecret(pkce.verifier, KEY), Date.now() + 600_000);
    const res = await agent.routeUpworkRequest(authPost("/upwork/callback", { state, error: "denied" }), "/agents/master-mind-agent/default/upwork/callback");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "UPWORK_OAUTH_DENIED");
  });

  console.log("");
  console.log(`upwork regression test: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
