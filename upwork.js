const UPWORK_AUTHORIZE_URL = "https://www.upwork.com/ab/account-security/oauth2/authorize";
const UPWORK_TOKEN_URL = "https://www.upwork.com/api/v3/oauth2/token";
const UPWORK_GRAPHQL_URL = "https://api.upwork.com/graphql";
const UPWORK_SEARCH_QUERY = `query AiraPublicUpworkSearch($marketPlaceJobFilter: PublicMarketplaceJobPostingsSearchFilter!) {
  publicMarketplaceJobPostingsSearch(marketPlaceJobFilter: $marketPlaceJobFilter) {
    jobs {
      id
      title
      description
      ciphertext
      createdDateTime
      type
      amount { displayValue currency }
      skills { name }
      category
      subcategory
      contractorTier
      jobStatus
      totalApplicants
      prefFreelancerLocationMandatory
    }
  }
}`;

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_SEARCH_TERM_LENGTH = 120;
const MAX_RESULTS = 10;

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeEncryptionKey(secret) {
  const value = String(secret || "").trim();
  if (!value) throw new Error("UPWORK_TOKEN_ENCRYPTION_KEY is not configured.");
  let raw;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    raw = Uint8Array.from(value.match(/.{2}/g), (byte) => parseInt(byte, 16));
  } else {
    try {
      raw = base64UrlDecode(value);
    } catch {
      throw new Error("UPWORK_TOKEN_ENCRYPTION_KEY must be a base64 or hex 32-byte key.");
    }
  }
  if (raw.byteLength !== 32) throw new Error("UPWORK_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return raw;
}

export function getUpworkConfiguration(env = {}) {
  const enabled = String(env.UPWORK_ENABLED || "").toLowerCase() === "true";
  const missing = [];
  if (!enabled) missing.push("UPWORK_ENABLED");
  if (!env.UPWORK_CLIENT_ID) missing.push("UPWORK_CLIENT_ID");
  if (!env.UPWORK_CLIENT_SECRET) missing.push("UPWORK_CLIENT_SECRET");
  if (!env.UPWORK_REDIRECT_URI) missing.push("UPWORK_REDIRECT_URI");
  if (!env.UPWORK_TOKEN_ENCRYPTION_KEY) missing.push("UPWORK_TOKEN_ENCRYPTION_KEY");

  let redirectUriValid = false;
  if (env.UPWORK_REDIRECT_URI) {
    try {
      const redirect = new URL(env.UPWORK_REDIRECT_URI);
      redirectUriValid = redirect.protocol === "https:" && redirect.hostname.length > 0 && !redirect.username && !redirect.password && !redirect.search && !redirect.hash;
    } catch {
      redirectUriValid = false;
    }
    if (!redirectUriValid && !missing.includes("UPWORK_REDIRECT_URI")) {
      missing.push("UPWORK_REDIRECT_URI (must be an HTTPS URL)");
    }
  }

  if (env.UPWORK_TOKEN_ENCRYPTION_KEY) {
    try {
      decodeEncryptionKey(env.UPWORK_TOKEN_ENCRYPTION_KEY);
    } catch {
      missing.push("UPWORK_TOKEN_ENCRYPTION_KEY (must be a valid 32-byte key)");
    }
  }
  return { enabled, configured: missing.length === 0 && redirectUriValid, missing };
}

export async function createUpworkPkcePair() {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export function createUpworkOAuthState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashUpworkOAuthState(state) {
  if (typeof state !== "string" || state.length < 32 || state.length > 256) throw new Error("UPWORK_OAUTH_STATE_INVALID");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  return base64UrlEncode(new Uint8Array(digest));
}

export function createUpworkSingleFlight(operation) {
  if (typeof operation !== "function") throw new Error("UPWORK_SINGLE_FLIGHT_REQUIRES_FUNCTION");
  let pending = null;
  return (...args) => {
    if (pending) return pending;
    const run = Promise.resolve().then(() => operation(...args));
    pending = run;
    run.then(
      () => { if (pending === run) pending = null; },
      () => { if (pending === run) pending = null; }
    );
    return run;
  };
}

export function buildUpworkAuthorizationUrl({ clientId, redirectUri, state, codeChallenge }) {
  if (!clientId || !redirectUri || !state || !codeChallenge) throw new Error("Upwork OAuth configuration is incomplete.");
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error("Upwork OAuth redirect URI must be a plain HTTPS callback URL.");
  const url = new URL(UPWORK_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", String(clientId));
  url.searchParams.set("redirect_uri", redirect.toString());
  url.searchParams.set("state", String(state));
  url.searchParams.set("code_challenge", String(codeChallenge));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function encryptUpworkTokenBundle(bundle, secret) {
  const keyBytes = decodeEncryptionKey(secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { v: 1, iv: base64UrlEncode(iv), ciphertext: base64UrlEncode(new Uint8Array(ciphertext)) };
}

export async function encryptUpworkSecret(value, secret) {
  const keyBytes = decodeEncryptionKey(secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(String(value)));
  return { v: 1, iv: base64UrlEncode(iv), ciphertext: base64UrlEncode(new Uint8Array(ciphertext)) };
}

export async function decryptUpworkSecret(envelope, secret) {
  if (!envelope || envelope.v !== 1 || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("Encrypted Upwork secret record is invalid.");
  }
  const keyBytes = decodeEncryptionKey(secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlDecode(envelope.iv) }, key, base64UrlDecode(envelope.ciphertext));
  return new TextDecoder().decode(plaintext);
}

export async function decryptUpworkTokenBundle(envelope, secret) {
  if (!envelope || envelope.v !== 1 || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("Encrypted Upwork credential record is invalid.");
  }
  const keyBytes = decodeEncryptionKey(secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlDecode(envelope.iv) }, key, base64UrlDecode(envelope.ciphertext));
  const bundle = JSON.parse(new TextDecoder().decode(plaintext));
  if (!bundle || typeof bundle.access_token !== "string" || !bundle.access_token) {
    throw new Error("Decrypted Upwork credentials are incomplete.");
  }
  return bundle;
}

async function readLimitedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("UPWORK_RESPONSE_TOO_LARGE");
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response size limit exceeded");
      throw new Error("UPWORK_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function readTokenResponse(response) {
  let body;
  try {
    body = await readLimitedJson(response, 64_000);
  } catch {
    throw new Error("UPWORK_TOKEN_RESPONSE_INVALID");
  }
  const expiresIn = Number(body && body.expires_in);
  if (!response.ok || !body || typeof body.access_token !== "string" || !body.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(response.status === 401 ? "UPWORK_AUTH_DENIED" : "UPWORK_TOKEN_EXCHANGE_FAILED");
  }
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    token_type: typeof body.token_type === "string" ? body.token_type : "Bearer",
    expires_at: new Date(Date.now() + Math.min(24 * 60 * 60, expiresIn) * 1000).toISOString()
  };
}

export async function exchangeUpworkAuthorizationCode({ clientId, clientSecret, code, redirectUri, codeVerifier }, fetchImpl = fetch) {
  if (!clientId || !clientSecret || !code || !redirectUri || !codeVerifier) throw new Error("UPWORK_OAUTH_CONFIGURATION_INCOMPLETE");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: String(clientId),
    client_secret: String(clientSecret),
    code: String(code),
    redirect_uri: String(redirectUri),
    code_verifier: String(codeVerifier)
  });
  const response = await fetchImpl(UPWORK_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  return readTokenResponse(response);
}

export async function refreshUpworkAccessToken({ clientId, clientSecret, refreshToken }, fetchImpl = fetch) {
  if (!clientId || !clientSecret || !refreshToken) throw new Error("UPWORK_REFRESH_CONFIGURATION_INCOMPLETE");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: String(clientId),
    client_secret: String(clientSecret),
    refresh_token: String(refreshToken)
  });
  const response = await fetchImpl(UPWORK_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  return readTokenResponse(response);
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, maxLength);
}

function upworkJobUrl(ciphertext) {
  const raw = cleanText(ciphertext, 160);
  if (!raw || !/^[A-Za-z0-9~_-]+$/.test(raw)) return "";
  const slug = raw.startsWith("~") ? raw : "~" + raw;
  return "https://www.upwork.com/jobs/" + encodeURIComponent(slug);
}

export function normalizeUpworkPublicJobs(rawJobs) {
  if (!Array.isArray(rawJobs)) return [];
  return rawJobs.slice(0, MAX_RESULTS).map((job) => {
    const amount = job && job.amount && typeof job.amount === "object" ? job.amount : {};
    return {
      id: cleanText(job && job.id, 160),
      title: cleanText(job && job.title, 300),
      description: cleanText(job && job.description, 4_000),
      url: upworkJobUrl(job && job.ciphertext),
      source: "Upwork official public marketplace API",
      published_at: cleanText(job && (job.publishedDateTime || job.createdDateTime || job.jobTs), 80),
      job_type: cleanText(job && job.type, 80),
      amount: cleanText(amount.displayValue, 100),
      currency: cleanText(amount.currency, 12),
      skills: Array.isArray(job && job.skills) ? job.skills.map((skill) => cleanText(skill && skill.name, 80)).filter(Boolean).slice(0, 20) : [],
      category: cleanText(job && job.category, 120),
      subcategory: cleanText(job && job.subcategory, 120),
      experience_level: cleanText(job && job.contractorTier, 80),
      status: cleanText(job && job.jobStatus, 40),
      total_applicants: Number.isFinite(Number(job && job.totalApplicants)) ? Number(job.totalApplicants) : null,
      owner_location_restriction: job && typeof job.prefFreelancerLocationMandatory === "boolean" ? job.prefFreelancerLocationMandatory : null,
      verification_status: "UNVERIFIED",
      india_eligibility: "UNKNOWN",
      saved_to_tracking: false
    };
  }).filter((job) => job.id && job.title);
}

export function buildUpworkSearchRequest(searchTerm, options = {}) {
  const term = cleanText(searchTerm, MAX_SEARCH_TERM_LENGTH);
  if (term.length < 2) throw new Error("SEARCH_TERM_TOO_SHORT");
  const first = Math.max(1, Math.min(MAX_RESULTS, Number.parseInt(options.limit, 10) || MAX_RESULTS));
  const daysPosted = options.daysPosted === undefined || options.daysPosted === null || options.daysPosted === ""
    ? null
    : Math.max(1, Math.min(30, Number.parseInt(options.daysPosted, 10) || 1));
  const filter = { searchExpression_eq: term, pagination: { after: "0", first } };
  if (daysPosted !== null) filter.daysPosted_eq = daysPosted;
  return { query: UPWORK_SEARCH_QUERY, variables: { marketPlaceJobFilter: filter } };
}

export async function searchUpworkPublicJobs(accessToken, searchTerm, options = {}, fetchImpl = fetch) {
  if (!accessToken) return { ok: false, state: "NOT_CONNECTED", error: "UPWORK_NOT_CONNECTED" };
  let requestBody;
  try {
    requestBody = buildUpworkSearchRequest(searchTerm, options);
  } catch (error) {
    return { ok: false, state: "INPUT_ERROR", error: error.message };
  }

  let response;
  try {
    response = await fetchImpl(UPWORK_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  } catch {
    return { ok: false, state: "UNAVAILABLE", error: "UPWORK_NETWORK_ERROR" };
  }

  if (response.status === 401) return { ok: false, state: "NEEDS_REAUTH", error: "UPWORK_AUTH_EXPIRED" };
  if (response.status === 403) return { ok: false, state: "PARTIALLY_CONNECTED", error: "UPWORK_READ_SCOPE_REQUIRED" };
  if (response.status === 429) return { ok: false, state: "UNAVAILABLE", error: "UPWORK_RATE_LIMITED" };
  if (!response.ok) return { ok: false, state: "UNAVAILABLE", error: "UPWORK_API_ERROR", httpStatus: response.status };

  let payload;
  try {
    payload = await readLimitedJson(response);
  } catch (error) {
    return { ok: false, state: "UNAVAILABLE", error: error.message === "UPWORK_RESPONSE_TOO_LARGE" ? "UPWORK_RESPONSE_TOO_LARGE" : "UPWORK_RESPONSE_INVALID" };
  }
  const result = payload && payload.data && payload.data.publicMarketplaceJobPostingsSearch;
  if ((Array.isArray(payload && payload.errors) && payload.errors.length > 0) || !result || !Array.isArray(result.jobs)) {
    return { ok: false, state: "UNAVAILABLE", error: "UPWORK_QUERY_FAILED" };
  }
  return {
    ok: true,
    state: "CONNECTED",
    verified: true,
    retrieved_at: new Date().toISOString(),
    cache: "NO_STORE",
    total_count: result.jobs.length,
    jobs: normalizeUpworkPublicJobs(result.jobs),
    note: "Read-only results are transient and are not stored in AIRA tracking. Verify eligibility on Upwork. Applications remain manual Owner actions."
  };
}

export const UPWORK_API_URLS = Object.freeze({ authorize: UPWORK_AUTHORIZE_URL, token: UPWORK_TOKEN_URL, graphql: UPWORK_GRAPHQL_URL });
export const UPWORK_LIMITS = Object.freeze({ maxSearchTermLength: MAX_SEARCH_TERM_LENGTH, maxResults: MAX_RESULTS, maxResponseBytes: MAX_RESPONSE_BYTES });
