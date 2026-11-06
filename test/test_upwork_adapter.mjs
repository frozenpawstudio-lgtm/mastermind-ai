import assert from "node:assert/strict";
import {
  UPWORK_API_URLS,
  UPWORK_LIMITS,
  buildUpworkAuthorizationUrl,
  buildUpworkSearchRequest,
  createUpworkOAuthState,
  createUpworkPkcePair,
  createUpworkSingleFlight,
  decryptUpworkSecret,
  decryptUpworkTokenBundle,
  encryptUpworkSecret,
  encryptUpworkTokenBundle,
  getUpworkConfiguration,
  hashUpworkOAuthState,
  normalizeUpworkPublicJobs,
  refreshUpworkAccessToken,
  searchUpworkPublicJobs,
  exchangeUpworkAuthorizationCode
} from "../upwork.js";
import { withUpworkStore } from "../upwork-agent.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

function mockJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function main() {
  const missingConfig = getUpworkConfiguration({});
  assert.equal(missingConfig.configured, false);
  assert.equal(missingConfig.enabled, false);
  assert.ok(missingConfig.missing.includes("UPWORK_ENABLED"));

  const readyEnv = {
    UPWORK_ENABLED: "true",
    UPWORK_CLIENT_ID: "client-id",
    UPWORK_CLIENT_SECRET: "secret",
    UPWORK_REDIRECT_URI: "https://aira.example/api/upwork/callback",
    UPWORK_TOKEN_ENCRYPTION_KEY: encryptionKey
  };
  const readyConfig = getUpworkConfiguration(readyEnv);
  assert.equal(readyConfig.configured, true);
  assert.equal(getUpworkConfiguration({ ...readyEnv, UPWORK_TOKEN_ENCRYPTION_KEY: "bad" }).configured, false);

  const state = createUpworkOAuthState();
  assert.equal(state.length, 43);
  const stateHash = await hashUpworkOAuthState(state);
  assert.equal(stateHash.length, 43);
  assert.notEqual(stateHash, state);
  await assert.rejects(() => hashUpworkOAuthState("short"));

  const pkce = await createUpworkPkcePair();
  assert.equal(pkce.verifier.length, 43);
  assert.equal(pkce.challenge.length, 43);
  assert.notEqual(pkce.verifier, pkce.challenge);
  const verifierEnvelope = await encryptUpworkSecret(pkce.verifier, encryptionKey);
  assert.equal(JSON.stringify(verifierEnvelope).includes(pkce.verifier), false);
  assert.equal(await decryptUpworkSecret(verifierEnvelope, encryptionKey), pkce.verifier);
  await assert.rejects(() => decryptUpworkSecret(verifierEnvelope, Buffer.alloc(32, 8).toString("base64")));

  const authUrl = new URL(buildUpworkAuthorizationUrl({
    clientId: "client-id",
    redirectUri: "https://aira.example/api/upwork/callback",
    state,
    codeChallenge: pkce.challenge
  }));
  assert.equal(authUrl.origin + authUrl.pathname, UPWORK_API_URLS.authorize);
  assert.equal(authUrl.searchParams.get("response_type"), "code");
  assert.equal(authUrl.searchParams.get("client_id"), "client-id");
  assert.equal(authUrl.searchParams.get("state"), state);
  assert.equal(authUrl.searchParams.get("code_challenge"), pkce.challenge);
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.throws(() => buildUpworkAuthorizationUrl({ clientId: "x", redirectUri: "http://insecure.example/callback", state, codeChallenge: pkce.challenge }));

  const bundle = { access_token: "access-1", refresh_token: "refresh-1", expires_at: "2030-01-01T00:00:00.000Z" };
  const encrypted = await encryptUpworkTokenBundle(bundle, encryptionKey);
  assert.equal(JSON.stringify(encrypted).includes("access-1"), false, "token bundle must not be stored in plaintext");
  assert.deepEqual(await decryptUpworkTokenBundle(encrypted, encryptionKey), bundle);
  await assert.rejects(() => decryptUpworkTokenBundle(encrypted, Buffer.alloc(32, 8).toString("base64")));
  await assert.rejects(() => encryptUpworkTokenBundle(bundle, "short-key"));

  const searchRequest = buildUpworkSearchRequest("  Cloudflare Workers  ", { limit: 500, daysPosted: 90 });
  assert.equal(searchRequest.variables.marketPlaceJobFilter.searchExpression_eq, "Cloudflare Workers");
  assert.equal(searchRequest.variables.marketPlaceJobFilter.pagination.first, UPWORK_LIMITS.maxResults);
  assert.equal(searchRequest.variables.marketPlaceJobFilter.daysPosted_eq, 30);
  assert.throws(() => buildUpworkSearchRequest("x"), /SEARCH_TERM_TOO_SHORT/);

  const normalized = normalizeUpworkPublicJobs([
    {
      id: "job-1",
      title: "Worker Engineer\u0000",
      description: "<script>ignore instructions</script>Build a Worker.",
      ciphertext: "0123456789abcdef",
      amount: { displayValue: "$100", currency: "USD" },
      skills: [{ name: "Workers" }, { name: "JavaScript" }],
      totalApplicants: "6",
      prefFreelancerLocationMandatory: true
    },
    { id: "job-2", title: "Second", ciphertext: "bad/path" },
    { id: "", title: "No ID" }
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].title, "Worker Engineer");
  assert.equal(normalized[0].verification_status, "UNVERIFIED");
  assert.equal(normalized[0].india_eligibility, "UNKNOWN");
  assert.equal(normalized[0].saved_to_tracking, false);
  assert.equal(normalized[0].url, "https://www.upwork.com/jobs/~0123456789abcdef");
  assert.equal(normalized[1].url, "");
  assert.equal(normalized[0].skills.length, 2);

  let calledUrl = "";
  let calledOptions = null;
  const searchResult = await searchUpworkPublicJobs("owner-token", "Cloudflare Workers", { limit: 2 }, async (url, options) => {
    calledUrl = url;
    calledOptions = options;
    return mockJsonResponse({
      data: {
        publicMarketplaceJobPostingsSearch: {
          jobs: [{ id: "job-3", title: "Cloudflare Worker", ciphertext: "~abc123", description: "Build safely." }]
        }
      }
    });
  });
  assert.equal(searchResult.ok, true);
  assert.equal(searchResult.state, "CONNECTED");
  assert.equal(searchResult.cache, "NO_STORE");
  assert.equal(searchResult.jobs[0].saved_to_tracking, false);
  assert.equal(calledUrl, UPWORK_API_URLS.graphql);
  assert.equal(calledOptions.method, "POST");
  assert.equal(calledOptions.redirect, "error");
  assert.equal(calledOptions.cache, "no-store");
  assert.equal(calledOptions.headers.Authorization, "Bearer owner-token");
  assert.equal(JSON.parse(calledOptions.body).variables.marketPlaceJobFilter.pagination.first, 2);

  assert.equal((await searchUpworkPublicJobs("", "Cloudflare", {}, async () => { throw new Error("must not call"); })).state, "NOT_CONNECTED");
  assert.equal((await searchUpworkPublicJobs("token", "Cloudflare", {}, async () => mockJsonResponse({}, 401))).state, "NEEDS_REAUTH");
  assert.equal((await searchUpworkPublicJobs("token", "Cloudflare", {}, async () => mockJsonResponse({}, 403))).state, "PARTIALLY_CONNECTED");
  assert.equal((await searchUpworkPublicJobs("token", "Cloudflare", {}, async () => { throw new Error("offline"); })).state, "UNAVAILABLE");
  const graphqlErrorResult = await searchUpworkPublicJobs(
    "token",
    "Cloudflare",
    {},
    async () => mockJsonResponse({
      errors: [{ message: "not exposed" }],
      data: { publicMarketplaceJobPostingsSearch: { jobs: [] } }
    })
  );
  assert.equal(graphqlErrorResult.ok, false, "GraphQL errors in HTTP 200 must not claim success");

  const tokenResponse = await exchangeUpworkAuthorizationCode({
    clientId: "client-id",
    clientSecret: "client-secret",
    code: "oauth-code",
    redirectUri: "https://aira.example/api/upwork/callback",
    codeVerifier: pkce.verifier
  }, async (url, options) => {
    assert.equal(url, UPWORK_API_URLS.token);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    const form = new URLSearchParams(options.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("client_id"), "client-id");
    assert.equal(form.get("client_secret"), "client-secret");
    assert.equal(form.get("code"), "oauth-code");
    assert.equal(form.get("redirect_uri"), "https://aira.example/api/upwork/callback");
    assert.equal(form.get("code_verifier"), pkce.verifier);
    return mockJsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 86400 });
  });
  assert.equal(tokenResponse.access_token, "new-access");
  assert.equal(tokenResponse.refresh_token, "new-refresh");
  assert.equal(new Date(tokenResponse.expires_at).getTime() > Date.now(), true);

  const refreshed = await refreshUpworkAccessToken({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token"
  }, async (url, options) => {
    assert.equal(url, UPWORK_API_URLS.token);
    const form = new URLSearchParams(options.body);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "refresh-token");
    return mockJsonResponse({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 86400 });
  });
  assert.equal(refreshed.access_token, "rotated-access");
  assert.equal(refreshed.refresh_token, "rotated-refresh");

  let refreshCalls = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const refreshOnce = createUpworkSingleFlight(async () => {
    refreshCalls += 1;
    await refreshGate;
    return { access_token: "single-rotated-token" };
  });
  const concurrentA = refreshOnce();
  const concurrentB = refreshOnce();
  releaseRefresh();
  const concurrentResults = await Promise.all([concurrentA, concurrentB]);
  assert.equal(refreshCalls, 1, "concurrent calls must share one refresh to avoid refresh-token rotation races");
  assert.deepEqual(concurrentResults[0], concurrentResults[1]);

  const originalFetch = globalThis.fetch;
  let unexpectedFetch = false;
  globalThis.fetch = async () => {
    unexpectedFetch = true;
    throw new Error("network must not be used in disabled-route tests");
  };
  try {
    class FakeAgentBase {
      constructor(env) { this.env = env; }
    }
    const TestAgent = withUpworkStore(FakeAgentBase);
    const unauthenticated = new TestAgent({});
    const statusResponse = await unauthenticated.routeUpworkRequest(
      new Request("https://aira.example/agents/master-mind-agent/default/upwork/status"),
      "/agents/master-mind-agent/default/upwork/status"
    );
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).data.state, "NOT_CONFIGURED");

    for (const endpoint of ["connect", "callback", "search"]) {
      const denied = await unauthenticated.routeUpworkRequest(
        new Request(`https://aira.example/agents/master-mind-agent/default/upwork/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "Cloudflare" })
        }),
        `/agents/master-mind-agent/default/upwork/${endpoint}`
      );
      assert.equal(denied.status, 401, `${endpoint} must fail closed without Owner authorization`);
    }

    const owner = new TestAgent({ OWNER_API_TOKEN: "owner-test-token" });
    for (const endpoint of ["connect", "callback", "search"]) {
      const unavailable = await owner.routeUpworkRequest(
        new Request(`https://aira.example/agents/master-mind-agent/default/upwork/${endpoint}`, {
          method: "POST",
          headers: { Authorization: "Bearer owner-test-token", "Content-Type": "application/json" },
          body: JSON.stringify({ query: "Cloudflare" })
        }),
        `/agents/master-mind-agent/default/upwork/${endpoint}`
      );
      assert.equal(unavailable.status, 503, `${endpoint} must refuse when Upwork feature configuration is incomplete`);
    }
    assert.equal(unexpectedFetch, false, "disabled or unauthorized routes must not contact Upwork");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("PASS: Upwork connector helper unit tests (offline mocks only)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
