import {
  buildUpworkAuthorizationUrl,
  createUpworkOAuthState,
  createUpworkPkcePair,
  createUpworkSingleFlight,
  decryptUpworkSecret,
  decryptUpworkTokenBundle,
  encryptUpworkSecret,
  encryptUpworkTokenBundle,
  exchangeUpworkAuthorizationCode,
  getUpworkConfiguration,
  hashUpworkOAuthState,
  refreshUpworkAccessToken,
  searchUpworkPublicJobs
} from "./upwork.js";

const REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const ACCESS_REFRESH_SKEW_MS = 60_000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SEARCH_COOLDOWN_MS = 5_000;
const STATUS_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CALLBACK_BODY_BYTES = 8_192;
const MAX_SEARCH_BODY_BYTES = 8_192;

function noStoreJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private, max-age=0",
      "Pragma": "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    }
  });
}

async function readSmallJson(request, maxBytes) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > maxBytes) throw new Error("REQUEST_TOO_LARGE");
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("request size limit exceeded");
      throw new Error("REQUEST_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes) || "{}");
}

function publicMessage(code) {
  const messages = {
    UPWORK_NOT_CONNECTED: "Upwork account is not connected yet.",
    UPWORK_NOT_CONFIGURED: "Upwork is not configured yet. The Owner must set up and approve the OAuth app first.",
    UPWORK_CONFIGURATION_INCOMPLETE: "Upwork configuration is incomplete. No request was sent.",
    UPWORK_AUTH_EXPIRED: "Upwork authorization expired. Reconnect the account.",
    UPWORK_READ_SCOPE_REQUIRED: "Upwork did not grant the required read-only job-search scope.",
    UPWORK_RATE_LIMITED: "Upwork rate limit reached. Wait and try again.",
    UPWORK_NETWORK_ERROR: "Upwork could not be reached. No results were saved.",
    UPWORK_API_ERROR: "Upwork search is temporarily unavailable.",
    UPWORK_QUERY_FAILED: "Upwork rejected the read-only search. Check the approved app scope and API access.",
    UPWORK_RESPONSE_TOO_LARGE: "Upwork returned an unexpectedly large response; it was discarded.",
    UPWORK_RESPONSE_INVALID: "Upwork returned an invalid response; no results were saved.",
    UPWORK_REFRESH_FAILED: "Upwork access could not be refreshed. Reconnect the account.",
    UPWORK_REAUTH_REQUIRED: "Upwork authorization is no longer valid. Reconnect the account.",
    UPWORK_SEARCH_TOO_SOON: "Please wait a few seconds before searching again.",
    UPWORK_OAUTH_STATE_INVALID: "The Upwork authorization request is invalid, expired, or already used. Start again.",
    UPWORK_OAUTH_DENIED: "Upwork authorization was cancelled or denied.",
    UPWORK_OAUTH_CODE_MISSING: "Upwork did not return an authorization code. Start again.",
    UPWORK_OAUTH_FAILED: "Upwork authorization could not be completed. Start again."
  };
  return messages[code] || "Upwork connector request could not be completed.";
}

export function withUpworkStore(Base) {
  return class UpworkStore extends Base {
    readUpworkCredentialRow() {
      this.initDb();
      const rows = [...this.sql`SELECT * FROM upwork_credentials WHERE id = 1 LIMIT 1;`];
      return rows[0] || null;
    }

    getUpworkStatus() {
      const config = getUpworkConfiguration(this.env || {});
      if (!config.enabled || !config.configured) {
        return {
          service: "upwork",
          name: "Upwork",
          state: "NOT_CONFIGURED",
          verified: false,
          enabled: false,
          note: "Upwork OAuth is disabled or required server-side setup is incomplete."
        };
      }
      const row = this.readUpworkCredentialRow();
      if (!row) {
        return {
          service: "upwork",
          name: "Upwork",
          state: "NOT_CONNECTED",
          verified: false,
          enabled: true,
          note: "Connect the Owner's Upwork account, then run a read-only search to verify the granted scope."
        };
      }
      if (row.status === "NEEDS_REAUTH") {
        return {
          service: "upwork",
          name: "Upwork",
          state: "NEEDS_REAUTH",
          verified: false,
          enabled: true,
          note: "The saved OAuth authorization needs to be renewed."
        };
      }
      const expiresAt = Date.parse(row.expires_at || "");
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        const refreshExpiresAt = Date.parse(row.refresh_expires_at || "");
        if (Number.isFinite(refreshExpiresAt) && refreshExpiresAt > Date.now()) {
          return {
            service: "upwork",
            name: "Upwork",
            state: "PARTIALLY_CONNECTED",
            verified: false,
            enabled: true,
            last_verified_at: row.last_verified_at || null,
            note: "The access token expired. An Owner-triggered read-only search can attempt a secure refresh before contacting the job-search API."
          };
        }
        return {
          service: "upwork",
          name: "Upwork",
          state: "NEEDS_REAUTH",
          verified: false,
          enabled: true,
          note: "The access token is expired; a search must refresh it or the Owner must reconnect."
        };
      }
      const verifiedAt = Date.parse(row.last_verified_at || "");
      if (row.status === "CONNECTED" && Number.isFinite(verifiedAt) && Date.now() - verifiedAt <= STATUS_VERIFICATION_TTL_MS) {
        return {
          service: "upwork",
          name: "Upwork",
          state: "CONNECTED",
          verified: true,
          enabled: true,
          last_verified_at: row.last_verified_at,
          note: "A successful read-only job search verified the Upwork connection. Results are not stored."
        };
      }
      return {
        service: "upwork",
        name: "Upwork",
        state: "PARTIALLY_CONNECTED",
        verified: false,
        enabled: true,
        last_verified_at: row.last_verified_at || null,
        note: "OAuth authorization exists, but a recent successful read-only search has not verified the scope."
      };
    }

    saveUpworkOAuthState(stateHash, verifierEnvelope, expiresAt) {
      this.initDb();
      const now = new Date().toISOString();
      this.sql`INSERT INTO upwork_oauth_state (id, state_hash, verifier_envelope, expires_at, status, updated_at)
        VALUES (1, ${stateHash}, ${JSON.stringify(verifierEnvelope)}, ${expiresAt}, 'PENDING', ${now})
        ON CONFLICT (id) DO UPDATE SET
          state_hash = excluded.state_hash,
          verifier_envelope = excluded.verifier_envelope,
          expires_at = excluded.expires_at,
          status = 'PENDING',
          updated_at = excluded.updated_at;`;
    }

    consumeUpworkOAuthState(stateHash, nowMs = Date.now()) {
      this.initDb();
      const rows = [...this.sql`SELECT state_hash, verifier_envelope, expires_at, status
        FROM upwork_oauth_state WHERE id = 1 LIMIT 1;`];
      const row = rows[0];
      if (!row || row.status !== "PENDING" || row.state_hash !== stateHash || Number(row.expires_at) <= nowMs) return null;
      const updatedAt = new Date(nowMs).toISOString();
      this.sql`UPDATE upwork_oauth_state SET status = 'CONSUMED', updated_at = ${updatedAt}
        WHERE id = 1 AND state_hash = ${stateHash} AND status = 'PENDING' AND expires_at > ${nowMs};`;
      const after = [...this.sql`SELECT status, state_hash FROM upwork_oauth_state WHERE id = 1 LIMIT 1;`][0];
      if (!after || after.status !== "CONSUMED" || after.state_hash !== stateHash) return null;
      return { verifierEnvelope: row.verifier_envelope };
    }

    async saveUpworkTokenBundle(bundle, preserveVerification = false) {
      this.initDb();
      const config = getUpworkConfiguration(this.env || {});
      if (!config.configured) throw new Error("UPWORK_CONFIGURATION_INCOMPLETE");
      const encrypted = await encryptUpworkTokenBundle(bundle, this.env.UPWORK_TOKEN_ENCRYPTION_KEY);
      const existing = this.readUpworkCredentialRow();
      const now = new Date().toISOString();
      const lastVerifiedAt = preserveVerification && existing ? String(existing.last_verified_at || "") : "";
      const currentStatus = preserveVerification && existing ? String(existing.status || "PARTIALLY_CONNECTED") : "PARTIALLY_CONNECTED";
      this.sql`INSERT INTO upwork_credentials
        (id, encrypted_bundle, status, expires_at, refresh_expires_at, last_verified_at, last_search_at, updated_at)
        VALUES (1, ${JSON.stringify(encrypted)}, ${currentStatus}, ${String(bundle.expires_at || "")},
          ${String(bundle.refresh_expires_at || "")}, ${lastVerifiedAt},
          ${preserveVerification && existing ? Number(existing.last_search_at || 0) : 0}, ${now})
        ON CONFLICT (id) DO UPDATE SET
          encrypted_bundle = excluded.encrypted_bundle,
          status = excluded.status,
          expires_at = excluded.expires_at,
          refresh_expires_at = excluded.refresh_expires_at,
          last_verified_at = excluded.last_verified_at,
          last_search_at = excluded.last_search_at,
          updated_at = excluded.updated_at;`;
    }

    setUpworkState(state, clearVerification = false) {
      this.initDb();
      const now = new Date().toISOString();
      if (clearVerification) {
        this.sql`UPDATE upwork_credentials SET status = ${state}, last_verified_at = '', updated_at = ${now} WHERE id = 1;`;
      } else {
        this.sql`UPDATE upwork_credentials SET status = ${state}, updated_at = ${now} WHERE id = 1;`;
      }
    }

    reserveUpworkSearch(nowMs = Date.now()) {
      this.initDb();
      const row = this.readUpworkCredentialRow();
      const lastSearch = Number(row?.last_search_at || 0);
      const waitMs = SEARCH_COOLDOWN_MS - (nowMs - lastSearch);
      if (lastSearch > 0 && waitMs > 0) return { allowed: false, retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) };
      const now = new Date(nowMs).toISOString();
      this.sql`UPDATE upwork_credentials SET last_search_at = ${nowMs}, updated_at = ${now} WHERE id = 1;`;
      return { allowed: true, retryAfter: 0 };
    }

    async refreshUpworkBundleIfNeeded() {
      const config = getUpworkConfiguration(this.env || {});
      if (!config.configured) return { ok: false, state: "NOT_CONFIGURED", error: "UPWORK_CONFIGURATION_INCOMPLETE" };
      const row = this.readUpworkCredentialRow();
      if (!row) return { ok: false, state: "NOT_CONNECTED", error: "UPWORK_NOT_CONNECTED" };
      if (row.status === "NEEDS_REAUTH") return { ok: false, state: "NEEDS_REAUTH", error: "UPWORK_REAUTH_REQUIRED" };

      let bundle;
      try {
        bundle = await decryptUpworkTokenBundle(JSON.parse(row.encrypted_bundle), this.env.UPWORK_TOKEN_ENCRYPTION_KEY);
      } catch {
        this.setUpworkState("NEEDS_REAUTH", true);
        return { ok: false, state: "NEEDS_REAUTH", error: "UPWORK_REAUTH_REQUIRED" };
      }
      const nowMs = Date.now();
      const expiresAt = Date.parse(bundle.expires_at || row.expires_at || "");
      if (Number.isFinite(expiresAt) && expiresAt > nowMs + ACCESS_REFRESH_SKEW_MS) return { ok: true, bundle };

      const refreshExpiresAt = Date.parse(bundle.refresh_expires_at || row.refresh_expires_at || "");
      if (!bundle.refresh_token || !Number.isFinite(refreshExpiresAt) || refreshExpiresAt <= nowMs) {
        this.setUpworkState("NEEDS_REAUTH", true);
        return { ok: false, state: "NEEDS_REAUTH", error: "UPWORK_REAUTH_REQUIRED" };
      }
      let refreshed;
      try {
        refreshed = await refreshUpworkAccessToken({
          clientId: this.env.UPWORK_CLIENT_ID,
          clientSecret: this.env.UPWORK_CLIENT_SECRET,
          refreshToken: bundle.refresh_token
        });
      } catch {
        this.setUpworkState("NEEDS_REAUTH", true);
        return { ok: false, state: "NEEDS_REAUTH", error: "UPWORK_REFRESH_FAILED" };
      }
      const updatedBundle = {
        ...bundle,
        ...refreshed,
        refresh_token: refreshed.refresh_token || bundle.refresh_token,
        refresh_expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString()
      };
      try {
        await this.saveUpworkTokenBundle(updatedBundle, true);
      } catch {
        this.setUpworkState("NEEDS_REAUTH", true);
        return { ok: false, state: "NEEDS_REAUTH", error: "UPWORK_REFRESH_FAILED" };
      }
      return { ok: true, bundle: updatedBundle };
    }

    async getUpworkBundleWithSerializedRefresh() {
      if (!this._upworkRefreshFlight) {
        this._upworkRefreshFlight = createUpworkSingleFlight(() => this.refreshUpworkBundleIfNeeded());
      }
      return this._upworkRefreshFlight();
    }

    async handleUpworkConnect() {
      const config = getUpworkConfiguration(this.env || {});
      if (!config.enabled || !config.configured) {
        return noStoreJson({ ok: false, error: "UPWORK_NOT_CONFIGURED", message: publicMessage("UPWORK_OAUTH_FAILED") }, 503);
      }
      try {
        const state = createUpworkOAuthState();
        const stateHash = await hashUpworkOAuthState(state);
        const pkce = await createUpworkPkcePair();
        const verifierEnvelope = await encryptUpworkSecret(pkce.verifier, this.env.UPWORK_TOKEN_ENCRYPTION_KEY);
        this.saveUpworkOAuthState(stateHash, verifierEnvelope, Date.now() + OAUTH_STATE_TTL_MS);
        const authorizationUrl = buildUpworkAuthorizationUrl({
          clientId: this.env.UPWORK_CLIENT_ID,
          redirectUri: this.env.UPWORK_REDIRECT_URI,
          state,
          codeChallenge: pkce.challenge
        });
        return noStoreJson({ ok: true, data: { authorization_url: authorizationUrl, state: "PENDING", expires_in_seconds: OAUTH_STATE_TTL_MS / 1000 } });
      } catch {
        return noStoreJson({ ok: false, error: "UPWORK_OAUTH_FAILED", message: publicMessage("UPWORK_OAUTH_FAILED") }, 500);
      }
    }

    async handleUpworkCallback(request) {
      const config = getUpworkConfiguration(this.env || {});
      if (!config.enabled || !config.configured) {
        return noStoreJson({ ok: false, error: "UPWORK_NOT_CONFIGURED", state: "NOT_CONFIGURED" }, 503);
      }
      let body;
      try {
        body = await readSmallJson(request, MAX_CALLBACK_BODY_BYTES);
      } catch {
        return noStoreJson({ ok: false, error: "UPWORK_OAUTH_FAILED", message: publicMessage("UPWORK_OAUTH_FAILED") }, 400);
      }
      const state = typeof body.state === "string" ? body.state : "";
      let stateHash;
      try {
        stateHash = await hashUpworkOAuthState(state);
      } catch {
        return noStoreJson({ ok: false, error: "UPWORK_OAUTH_STATE_INVALID", message: publicMessage("UPWORK_OAUTH_STATE_INVALID") }, 400);
      }
      const consumed = this.consumeUpworkOAuthState(stateHash);
      if (!consumed) {
        return noStoreJson({ ok: false, error: "UPWORK_OAUTH_STATE_INVALID", message: publicMessage("UPWORK_OAUTH_STATE_INVALID") }, 400);
      }
      if (body.error) {
        return noStoreJson({ ok: false, error: "UPWORK_OAUTH_DENIED", state: "NOT_CONNECTED", message: publicMessage("UPWORK_OAUTH_DENIED") }, 400);
      }
      const code = typeof body.code === "string" ? body.code.trim() : "";
      if (!code || code.length > 4_096) {
        return noStoreJson({ ok: false, error: "UPWORK_OAUTH_CODE_MISSING", message: publicMessage("UPWORK_OAUTH_CODE_MISSING") }, 400);
      }
      let codeVerifier;
      try {
        const envelope = JSON.parse(consumed.verifierEnvelope);
        codeVerifier = await decryptUpworkSecret(envelope, this.env.UPWORK_TOKEN_ENCRYPTION_KEY);
      } catch {
        return noStoreJson({ ok: false, error: "UPWORK_OAUTH_FAILED", message: publicMessage("UPWORK_OAUTH_FAILED") }, 500);
      }
      try {
        const tokenBundle = await exchangeUpworkAuthorizationCode({
          clientId: this.env.UPWORK_CLIENT_ID,
          clientSecret: this.env.UPWORK_CLIENT_SECRET,
          code,
          redirectUri: this.env.UPWORK_REDIRECT_URI,
          codeVerifier
        });
        const now = Date.now();
        const credentialBundle = {
          ...tokenBundle,
          refresh_expires_at: tokenBundle.refresh_token ? new Date(now + REFRESH_TOKEN_TTL_MS).toISOString() : ""
        };
        await this.saveUpworkTokenBundle(credentialBundle, false);
        return noStoreJson({ ok: true, data: { state: "PARTIALLY_CONNECTED", verified: false, message: "OAuth authorization saved. Run a read-only Upwork search to verify the granted job-search scope." } });
      } catch {
        return noStoreJson({ ok: false, error: "UPWORK_OAUTH_FAILED", state: "NEEDS_REAUTH", message: publicMessage("UPWORK_OAUTH_FAILED") }, 502);
      }
    }

    async handleUpworkSearch(request) {
      const config = getUpworkConfiguration(this.env || {});
      if (!config.enabled || !config.configured) {
        return noStoreJson({ ok: false, error: "UPWORK_NOT_CONFIGURED", state: "NOT_CONFIGURED", message: publicMessage("UPWORK_OAUTH_FAILED") }, 503);
      }
      let body;
      try {
        body = await readSmallJson(request, MAX_SEARCH_BODY_BYTES);
      } catch {
        return noStoreJson({ ok: false, error: "INVALID_JSON" }, 400);
      }
      const query = typeof body.query === "string" ? body.query : "";
      if (query.trim().length < 2 || query.length > 120) {
        return noStoreJson({ ok: false, error: "INVALID_SEARCH_QUERY", message: "Enter 2–120 characters." }, 400);
      }
      const rate = this.reserveUpworkSearch();
      if (!rate.allowed) {
        return noStoreJson({ ok: false, error: "UPWORK_SEARCH_TOO_SOON", message: publicMessage("UPWORK_SEARCH_TOO_SOON"), retry_after: rate.retryAfter }, 429, { "Retry-After": String(rate.retryAfter) });
      }
      const credential = await this.getUpworkBundleWithSerializedRefresh();
      if (!credential.ok) {
        const status = credential.state === "NOT_CONNECTED" ? 409 : credential.state === "NOT_CONFIGURED" ? 503 : 401;
        return noStoreJson({ ok: false, error: credential.error, state: credential.state, message: publicMessage(credential.error) }, status);
      }
      const result = await searchUpworkPublicJobs(credential.bundle.access_token, query, { limit: 10 });
      if (result.ok) {
        this.setUpworkState("CONNECTED", false);
        const now = new Date().toISOString();
        this.sql`UPDATE upwork_credentials SET last_verified_at = ${now}, updated_at = ${now} WHERE id = 1;`;
        return noStoreJson({ ok: true, data: result });
      }
      if (result.state === "NEEDS_REAUTH") this.setUpworkState("NEEDS_REAUTH", true);
      else if (result.state === "PARTIALLY_CONNECTED" || result.error === "UPWORK_QUERY_FAILED") this.setUpworkState("PARTIALLY_CONNECTED", true);
      const status = result.state === "NEEDS_REAUTH" ? 401 : result.error === "UPWORK_READ_SCOPE_REQUIRED" ? 403 : 502;
      return noStoreJson({ ok: false, error: result.error, state: result.state, message: publicMessage(result.error) }, status);
    }

    async routeUpworkRequest(request, pathname) {
      const method = request.method.toUpperCase();
      if (pathname.endsWith("/upwork/status") && method === "GET") {
        return noStoreJson({ ok: true, data: this.getUpworkStatus() });
      }
      if (!pathname.includes("/upwork/")) return null;
      const denied = this.authorizeUpworkRequest(request);
      if (denied) return denied;
      if (pathname.endsWith("/upwork/connect") && method === "POST") return this.handleUpworkConnect();
      if (pathname.endsWith("/upwork/callback") && method === "POST") return this.handleUpworkCallback(request);
      if (pathname.endsWith("/upwork/search") && method === "POST") return this.handleUpworkSearch(request);
      return noStoreJson({ ok: false, error: "METHOD_OR_ROUTE_NOT_ALLOWED" }, 405, { Allow: "GET, POST" });
    }

    authorizeUpworkRequest(request) {
      const ownerToken = this.env && typeof this.env.OWNER_API_TOKEN === "string" ? this.env.OWNER_API_TOKEN : "";
      const auth = request.headers.get("Authorization") || "";
      const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
      const presented = bearer || request.headers.get("X-Owner-Token") || "";
      if (!ownerToken.trim()) return noStoreJson({ ok: false, error: "OWNER_AUTH_NOT_CONFIGURED", action: "DENIED" }, 401);
      if (presented.length !== ownerToken.length) return noStoreJson({ ok: false, error: "OWNER_AUTH_REQUIRED", action: "DENIED" }, 401);
      let diff = 0;
      for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ ownerToken.charCodeAt(i);
      if (diff !== 0) return noStoreJson({ ok: false, error: "OWNER_AUTH_REQUIRED", action: "DENIED" }, 401);
      return null;
    }
  };
}
