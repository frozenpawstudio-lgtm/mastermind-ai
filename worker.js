import { Agent, routeAgentRequest } from "agents";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

/*
 * V9 truth states. Only these values may be stored or displayed.
 * Anything unrecognised collapses to UNKNOWN instead of being persisted.
 */
const TRUTH_STATES = [
  "CONNECTED",
  "NOT_CONNECTED",
  "NOT_CONFIGURED",
  "PARTIALLY_CONNECTED",
  "NEEDS_REAUTH",
  "EXPIRED",
  "REJECTED",
  "UNAVAILABLE",
  "PLANNED"
];

const VERIFICATION_STATES = ["VERIFIED", "PARTIALLY_VERIFIED", "UNVERIFIED", "REJECTED"];
const ELIGIBILITY_STATES = ["ELIGIBLE", "POTENTIALLY_ELIGIBLE", "NOT_ELIGIBLE", "UNKNOWN"];
const OWNER_FIT_STATES = ["FIT", "POTENTIAL_FIT", "NOT_FIT", "UNKNOWN"];
const DECISION_STATES = ["SELECT", "NEEDS_REVIEW", "REJECT"];

const VOICE_STATES = [
  "VOICE_ACTIVE",
  "VOICE_NOT_CONFIGURED",
  "VOICE_NOT_CONNECTED",
  "VOICE_UNAVAILABLE",
  "VOICE_NEEDS_REAUTH",
  "VOICE_ERROR"
];

const ELIGIBILITY_ALIASES = {
  ELIGIBLE: "ELIGIBLE",
  POTENTIALLY_ELIGIBLE: "POTENTIALLY_ELIGIBLE",
  POTENTIALLYELIGIBLE: "POTENTIALLY_ELIGIBLE",
  MAYBE: "POTENTIALLY_ELIGIBLE",
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  INELIGIBLE: "NOT_ELIGIBLE",
  UNKNOWN: "UNKNOWN",
  PENDING: "UNKNOWN"
};

const OWNER_FIT_ALIASES = {
  FIT: "FIT",
  POTENTIAL_FIT: "POTENTIAL_FIT",
  POTENTIALFIT: "POTENTIAL_FIT",
  MAYBE: "POTENTIAL_FIT",
  NOT_FIT: "NOT_FIT",
  UNFIT: "NOT_FIT",
  UNKNOWN: "UNKNOWN",
  PENDING: "UNKNOWN"
};

function normalizeFromAliases(value, aliases) {
  if (value === null || value === undefined) return "UNKNOWN";
  const key = String(value).trim().toUpperCase().replace(/[\s-]+/g, "_");
  return aliases[key] || "UNKNOWN";
}

function normalizeEligibility(value) {
  return normalizeFromAliases(value, ELIGIBILITY_ALIASES);
}

function normalizeOwnerFit(value) {
  return normalizeFromAliases(value, OWNER_FIT_ALIASES);
}

function normalizeVerification(value) {
  const key = String(value === null || value === undefined ? "" : value).trim().toUpperCase().replace(/[\s-]+/g, "_");
  return VERIFICATION_STATES.includes(key) ? key : "UNVERIFIED";
}

function normalizeDecision(value) {
  const key = String(value === null || value === undefined ? "" : value).trim().toUpperCase().replace(/[\s-]+/g, "_");
  return DECISION_STATES.includes(key) ? key : "NEEDS_REVIEW";
}

/*
 * Permission boundary: SERVICE -> CAPABILITY -> SCOPE -> RISK -> APPROVAL.
 * Mutations that change Owner-controlled state require an explicit Owner
 * credential (OWNER_API_TOKEN). Reads never do.
 */
const RISK = { READ: "READ", MUTATE: "MUTATE", OWNER_CONTROLLED: "OWNER_CONTROLLED" };

function hasOwnerToken(env) {
  return !!(env && typeof env.OWNER_API_TOKEN === "string" && env.OWNER_API_TOKEN.trim().length > 0);
}

function tokensMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function extractOwnerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return bearer || request.headers.get("X-Owner-Token") || "";
}

function isSameOriginRequest(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const u = new URL(request.url);
    return o.protocol === u.protocol && o.host === u.host;
  } catch {
    return false;
  }
}

/*
 * Returns null when the request may proceed, otherwise an error Response.
 * Services that are not configured are reported as NOT_CONFIGURED, never
 * silently treated as if a real capability existed.
 */
function authorizeRequest(request, env, risk) {
  if (risk === RISK.READ) return null;

  const method = request.method.toUpperCase();
  if (method === "GET" || method === "OPTIONS" || method === "HEAD") return null;

  const configured = hasOwnerToken(env);
  const presented = extractOwnerToken(request);

  // No credential configured at runtime: authorization is NOT_CONFIGURED.
  // The state is reported truthfully instead of pretending the boundary is
  // enforced. The Owner must configure OWNER_API_TOKEN to activate it.
  if (!configured) return null;

  if (tokensMatch(presented, env.OWNER_API_TOKEN)) return null;

  // Owner-controlled actions never fall back to same-origin alone: a
  // consequential mutation must present the Owner credential.
  const denied = json(
    {
      ok: false,
      error:
        risk === RISK.OWNER_CONTROLLED
          ? "Owner authorization required. This Owner-controlled action is DENIED."
          : "Owner authorization required for this action.",
      authorization: "CONFIGURED",
      action: "DENIED"
    },
    401
  );

  if (risk === RISK.OWNER_CONTROLLED) return denied;

  // Ordinary mutations accept a same-origin Owner browser session.
  if (isSameOriginRequest(request)) return null;
  return denied;
}

const SYSTEM_PROMPT = `
You are MasterMind AI, a personal AI agent.

You understand Hindi, Hinglish and English.

Your job:
- Understand the user's goal.
- Break complex work into practical tasks.
- Research when needed.
- Use connected tools only when actually available.
- Never claim an action was completed unless a real tool succeeded.
- Never invent tool results.
- Never expose passwords, OTPs, API keys or tokens.
- Ask before sensitive or irreversible actions.
- Give practical next steps.
`;

/*
 * Connection foundation (Phase 1 supporting foundation).
 *
 * A listed service is NOT a connected service. Each entry declares only its
 * declared support level; the live state is resolved at runtime by
 * resolveServiceState(), which may only return CONNECTED when an actual
 * verified runtime binding exists.
 */
const SERVICE_REGISTRY = {
  workers_ai: {
    name: "Cloudflare Workers AI",
    kind: "ai",
    supported: true,
    binding: "AI"
  },
  browser_run: {
    name: "Cloudflare Browser Rendering",
    kind: "browser",
    supported: true,
    binding: "BROWSER"
  },
  durable_object: {
    name: "Cloudflare Durable Object (MasterMindAgent)",
    kind: "storage",
    supported: true,
    binding: "MasterMindAgent"
  },
  web_search: {
    name: "Web Search",
    kind: "search",
    supported: false,
    binding: null
  },
  github: { name: "GitHub", kind: "source_control", supported: false, binding: null },
  cloudflare: { name: "Cloudflare Account API", kind: "cloud", supported: false, binding: null },
  openhands: { name: "OpenHands", kind: "engineering", supported: false, binding: null },
  jules: { name: "Jules", kind: "engineering", supported: false, binding: null },
  google_ai_studio: { name: "Google AI Studio / Gemini API", kind: "ai", supported: false, binding: null },
  email: { name: "Email", kind: "communication", supported: false, binding: null },
  calendar: { name: "Calendar", kind: "communication", supported: false, binding: null },
  youtube: { name: "YouTube", kind: "media", supported: false, binding: null },
  upwork: { name: "Upwork", kind: "earning_platform", supported: false, binding: null },
  fiverr: { name: "Fiverr", kind: "earning_platform", supported: false, binding: null },
  voice_provider: {
    name: "Voice Provider",
    kind: "voice",
    supported: false,
    binding: "VOICE"
  }
};

/*
 * Resolve the honest runtime state of a service.
 * CONNECTED requires the declared runtime binding to actually exist.
 */
function resolveServiceState(env, key) {
  const entry = SERVICE_REGISTRY[key];
  if (!entry) {
    return { service: key, state: "UNAVAILABLE", verified: false, reason: "Unknown service" };
  }

  if (!entry.supported || !entry.binding) {
    return {
      service: key,
      name: entry.name,
      state: "NOT_CONFIGURED",
      verified: false,
      reason: "No supported connection adapter is configured for this service."
    };
  }

  const binding = env ? env[entry.binding] : undefined;
  if (!binding) {
    return {
      service: key,
      name: entry.name,
      state: "NOT_CONNECTED",
      verified: false,
      reason: `Runtime binding ${entry.binding} is not available.`
    };
  }

  if (key === "workers_ai") {
    if (typeof binding.run !== "function") {
      return { service: key, name: entry.name, state: "UNAVAILABLE", verified: false, reason: "AI binding has no run() capability." };
    }
    return { service: key, name: entry.name, state: "CONNECTED", verified: true, reason: "AI binding exposes run()." };
  }

  if (key === "browser_run") {
    if (typeof binding.quickAction !== "function") {
      return { service: key, name: entry.name, state: "UNAVAILABLE", verified: false, reason: "Browser binding has no quickAction() capability." };
    }
    return { service: key, name: entry.name, state: "CONNECTED", verified: true, reason: "Browser binding exposes quickAction()." };
  }

  if (key === "durable_object") {
    if (typeof binding.idFromName !== "function") {
      return { service: key, name: entry.name, state: "UNAVAILABLE", verified: false, reason: "Durable Object binding is not usable." };
    }
    return { service: key, name: entry.name, state: "CONNECTED", verified: true, reason: "Durable Object namespace binding is usable." };
  }

  return { service: key, name: entry.name, state: "UNAVAILABLE", verified: false, reason: "No verification routine for this service." };
}

function connectionReport(env) {
  const services = Object.keys(SERVICE_REGISTRY).map((key) => resolveServiceState(env, key));
  return {
    states: TRUTH_STATES,
    services,
    connectedCount: services.filter((s) => s.state === "CONNECTED").length,
    note: "Listing a service does not mean it is connected. Only a verified runtime binding reports CONNECTED."
  };
}

/*
 * Voice foundation (Phase 1 supporting foundation).
 * Voice is only VOICE_ACTIVE when a real verified voice binding exists.
 * Without a configured provider the honest state is VOICE_NOT_CONFIGURED.
 */
function resolveVoiceState(env) {
  const configured = !!(env && env.VOICE && typeof env.VOICE === "object");

  if (!configured) {
    return {
      state: "VOICE_NOT_CONFIGURED",
      verified: false,
      provider: "NOT_CONFIGURED",
      capabilities: { speech_input: false, speech_output: false },
      limitations: [
        "No voice provider binding is configured.",
        "Microphone capture, speech recognition and voice response are not available.",
        "Voice actions are BLOCKED until a provider is configured and verified."
      ]
    };
  }

  return {
    state: "VOICE_NOT_CONNECTED",
    verified: false,
    provider: "CONFIGURED_BUT_UNVERIFIED",
    capabilities: { speech_input: false, speech_output: false },
    limitations: [
      "A voice binding exists but no runtime verification routine has confirmed it.",
      "VOICE_ACTIVE is only reported after verified runtime evidence."
    ]
  };
}

/*
 * Earning-intent detection.
 *
 * Only explicit earning objectives enter the earning-operation workflow.
 * Informational questions ("I want to learn JavaScript", "What does freelance
 * work involve?", "Tell me about my yearly earnings report") must NOT trigger it.
 */
/*
 * Earning vocabulary is tiered so generic engineering words cannot
 * over-trigger. "project", "client", "files", "build" and bare "काम" are
 * deliberately NOT earning objects, so "Show me my project files" and
 * "Start the project build" never enter the earning workflow.
 */
const EARNING_STRONG_OBJECTS = [
  "kamai",
  "kamaai",
  "kamana",
  "kamane",
  "paisa kamana",
  "paise kamane",
  "paise kamana",
  "earning",
  "earn money",
  "earn income",
  "make money",
  "online income",
  "income",
  "freelance",
  "freelancing",
  "gig",
  "gigs",
  "side hustle",
  "part time",
  "part-time",
  "कमाई",
  "कमाना",
  "कमाने",
  "पैसे",
  "आमदनी",
  "फ्रीलांस"
];

/* Earning-adjacent nouns: only an earning operation alongside an action verb. */
const EARNING_MEDIUM_OBJECTS = [
  "job",
  "jobs",
  "नौकरी",
  "opportunity",
  "opportunities",
  "ऑपर्च्युनिटी",
  "मौका",
  "मौके"
];
/*
 * Real earning action verbs only. Generic engineering verbs ("start", "karo",
 * "शुरू", "दिखाओ") are excluded so unrelated commands do not over-trigger.
 */
const EARNING_ACTION_MARKERS = [
  "find",
  "search",
  "discover",
  "dhundo",
  "dhundh",
  "dhoondo",
  "dhoondh",
  "talash",
  "khoj",
  "khojo",
  "chahiye",
  "chahiyen",
  "apply",
  "get me",
  "show me",
  "list",
  "track",
  "kamai karni",
  "kamai karna",
  "ढूंढो",
  "ढूँो",
  "खोजो",
  "चाहिए",
  "चाहिये"
];

const EARNING_OPERATION_PHRASES = [
  "earning agent",
  "earning operator",
  "earning workflow",
  "earning operation",
  "earning opportunities",
  "find opportunities",
  "discover opportunities",
  "opportunity discovery",
  "kamai karni",
  "kamai karna",
  "kamai karni hai",
  "paise kamane",
  "online income",
  "freelance work dhundo",
  "freelance dhundo",
  "earning opportunities find",
  "earning opportunities dhoondo",
  "kaam chahiye",
  "काम चाहिए",
  "job chahiye",
  "नौकरी चाहिए",
  "मुझे कमाई",
  "कमाई करनी",
  "कमाई करना"
];

/*
 * Informational / learning / reporting intents that mention earning words but
 * are questions rather than earning operations.
 */
const INFORMATIONAL_MARKERS = [
  "what is",
  "what are",
  "what does",
  "what do",
  "how do",
  "how does",
  "how should",
  "how to",
  "how can",
  "tell me about",
  "explain",
  "learn",
  "learning",
  "study",
  "documentation",
  "documented",
  "guide",
  "tutorial",
  "difference between",
  "meaning of",
  "kya hai",
  "kya hota",
  "kaise",
  "kaise kar",
  "samjhao",
  "batao",
  "sikho",
  "sikhna",
  "seekhna",
  "report",
  "yearly",
  "annual",
  "summary of",
  "क्या है",
  "कैसे",
  "समझाओ",
  "बताओ",
  "सीखना",
  "सीखो",
  "रिपोर्ट"
];

function containsAny(text, list) {
  return list.some((marker) => text.includes(marker));
}

function detectEarningIntent(message) {
  const raw = String(message || "");
  const text = raw.toLowerCase();
  const negativeExamples = [];

  const isQuestion = text.includes("?") || containsAny(text, INFORMATIONAL_MARKERS);
  const hasActionMarker = containsAny(text, EARNING_ACTION_MARKERS);

  // Informational framing without a real earning action is never an operation.
  // This gate runs first so "What are earning opportunities?" stays a question
  // even though it contains an explicit earning-operation phrase.
  if (isQuestion && !hasActionMarker) {
    negativeExamples.push("Informational question containing an earning keyword.");
    return { isEarningIntent: false, reason: "Informational question, not an earning operation.", negativeExamples };
  }

  // Unambiguous earning-operation phrases stand on their own, including
  // Hinglish forms such as "kaam chahiye" that use no tiered earning noun.
  if (containsAny(text, EARNING_OPERATION_PHRASES)) {
    return { isEarningIntent: true, reason: "Explicit earning-operation phrase.", negativeExamples };
  }

  const hasStrongObject = containsAny(text, EARNING_STRONG_OBJECTS);
  const hasMediumObject = containsAny(text, EARNING_MEDIUM_OBJECTS);

  if (!hasStrongObject && !hasMediumObject) {
    return { isEarningIntent: false, reason: "No earning object present.", negativeExamples };
  }

  // Strong earning language only needs the absence of informational framing;
  // medium nouns (job/opportunity) additionally require an actionable request.
  if (hasStrongObject) {
    return { isEarningIntent: true, reason: "Explicit earning objective.", negativeExamples };
  }

  if (hasActionMarker) {
    return { isEarningIntent: true, reason: "Earning object combined with an action request.", negativeExamples };
  }

  return { isEarningIntent: false, reason: "Earning object without an action request.", negativeExamples };
}

/*
 * Build the authoritative status context handed to the model.
 * Values are read fresh from persisted state; nothing is inferred or invented.
 */
function buildEarningContext(agent) {
  const opportunities = agent.listOpportunities();
  const states = opportunities.map((o) => ({
    id: o.id,
    title: o.title,
    verification: normalizeVerification(o.verification_status),
    eligibility: normalizeEligibility(o.eligibility_status),
    ownerFit: normalizeOwnerFit(o.owner_fit_status),
    score: typeof o.score === "number" ? o.score : 0,
    decision: normalizeDecision(o.decision)
  }));

  const profile = agent.getOwnerProfile();

  return {
    authority: "PERSISTED_STATE",
    opportunityCount: states.length,
    opportunities: states.slice(0, 20),
    ownerProfile: profile
      ? {
          skills: profile.skills || "",
          experience: profile.experience || "",
          location: profile.location || "",
          max_cost: profile.max_cost || "",
          max_effort: profile.max_effort || "",
          updated_at: profile.updated_at || ""
        }
      : null,
    connections: connectionReport(agent.env).services.map((s) => ({
      service: s.service,
      state: s.state,
      verified: s.verified
    })),
    voice: resolveVoiceState(agent.env).state,
    submissionPolicy: "MANUAL_OWNER_ONLY",
    earnedRevenue: "DATA NOT AVAILABLE",
    confirmedPayments: "DATA NOT AVAILABLE"
  };
}


function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;

  let requestOrigin = null;
  try {
    const u = new URL(request.url);
    requestOrigin = `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }

  if (origin === requestOrigin) return origin;

  const extra = env && typeof env.ALLOWED_ORIGINS === "string" ? env.ALLOWED_ORIGINS : "";
  const allowList = extra
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowList.includes(origin)) return origin;

  return null;
}

/*
 * CORS is restricted to the deployment's own origin (plus an optional
 * ALLOWED_ORIGINS allow-list). It no longer reflects every origin with "*",
 * which would have let any site drive the Owner's mutation endpoints.
 */
function applyCors(response, request, env) {
  const headers = new Headers(response.headers);
  const origin = allowedOrigin(request, env);

  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Owner-Token"
    );
  }

  return new Response(response.body, {
    status: response.status,
    headers
  });
}

function detectIntent(message) {
  const text = message.toLowerCase();
  const intents = [];

  if (
    text.includes("research") ||
    text.includes("रिसर्च") ||
    text.includes("search") ||
    text.includes("खोज") ||
    text.includes("जानकारी") ||
    text.includes("चेक")
  ) {
    intents.push("web_research");
  }

  if (
    text.includes("github") ||
    text.includes("गिटहब") ||
    text.includes("repo") ||
    text.includes("repository")
  ) {
    intents.push("github");
  }

  if (
    text.includes("cloudflare") ||
    text.includes("क्लाउडफ्लेयर")
  ) {
    intents.push("cloudflare");
  }

  if (
    text.includes("youtube") ||
    text.includes("यूट्यूब") ||
    text.includes("video") ||
    text.includes("वीडियो")
  ) {
    intents.push("youtube");
  }

  if (
    text.includes("facebook") ||
    text.includes("फेसबुक")
  ) {
    intents.push("facebook");
  }

  if (
    text.includes("whatsapp") ||
    text.includes("व्हाट्सऐप")
  ) {
    intents.push("whatsapp");
  }

  if (
    text.includes("agent") ||
    text.includes("एजेंट") ||
    text.includes("automation") ||
    text.includes("ऑटोमेशन")
  ) {
    intents.push("agent");
  }

  if (
    text.includes("plan") ||
    text.includes("योजना") ||
    text.includes("बनाओ") ||
    text.includes("build") ||
    text.includes("बनाना")
  ) {
    intents.push("planning");
  }

  if (intents.length === 0) {
    intents.push("general");
  }

  return [...new Set(intents)];
}

async function researchWeb(env, url) {
  if (
    !env.BROWSER ||
    typeof env.BROWSER.quickAction !== "function"
  ) {
    return {
      ok: false,
      error: "Browser Run binding connected नहीं है।"
    };
  }

  try {
    const result = await env.BROWSER.quickAction(
      "markdown",
      { url }
    );

    let content = "";

    if (typeof result === "string") {
      content = result;
    } else if (
      result &&
      typeof result.markdown === "string"
    ) {
      content = result.markdown;
    } else if (
      result &&
      typeof result.content === "string"
    ) {
      content = result.content;
    } else {
      content = JSON.stringify(result);
    }

    return {
      ok: true,
      url,
      content: content.slice(0, 20000)
    };
  } catch (error) {
    return {
      ok: false,
      error: "Web research में समस्या आई।",
      details:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}

async function runAI(env, userMessage, context = {}) {
  if (
    !env.AI ||
    typeof env.AI.run !== "function"
  ) {
    return {
      ok: false,
      error: "AI binding connected नहीं है।"
    };
  }

  const toolsText = connectionReport(env)
    .services.map((s) => `${s.service}: ${s.state}`)
    .join("\n");

  const researchText = context.research
    ? `
REAL WEB RESEARCH:

URL:
${context.research.url}

CONTENT:
${context.research.content}
`
    : "";

  const statusText = context.status
    ? `
AUTHORITATIVE STATUS (${context.status.authority}):
${JSON.stringify(context.status, null, 2)}
`
    : "";

  const voiceText = context.voice
    ? `
VOICE STATE:
${context.voice.state}
VERIFIED: ${context.voice.verified}
`
    : "";

  const prompt = `
${SYSTEM_PROMPT}

SERVICE CONNECTION STATES:
${toolsText}

DETECTED INTENTS:
${(context.intents || []).join(", ")}

EARNING OPERATION: ${context.earningIntent ? "YES" : "NO"}

${statusText}
${voiceText}
${researchText}

USER REQUEST:
${userMessage}

Instructions:
- Answer in the user's language.
- Make a practical plan when the request is complex.
- If a required tool is not connected, clearly say so.
- Never pretend that an external action happened.
- If research is supplied, use only the supplied research as factual evidence.
- The AUTHORITATIVE STATUS block above is the only source of truth for
  decision, score, verification, eligibility, owner fit, discovery status,
  opportunity status, connection status and voice status.
- Never claim VERIFIED, CONNECTED, SELECTED, SUBMITTED, EARNED or PAID unless
  the AUTHORITATIVE STATUS block shows that exact verified state.
- Never report revenue, customers, applications, submissions or metrics that
  are not present in the AUTHORITATIVE STATUS block.
- Values shown as UNKNOWN, NOT_CONNECTED, NOT_CONFIGURED, UNAVAILABLE or
  DATA NOT AVAILABLE must be repeated as such; never upgrade them.
- Upwork/Fiverr final submission is a manual Owner action and is never automatic.
`;

  try {
    const result = await env.AI.run(
      MODEL,
      {
        prompt,
        max_tokens: 2200
      }
    );

    const answer =
      typeof result === "string"
        ? result
        : result?.response ||
          JSON.stringify(result);

    return {
      ok: true,
      answer
    };
  } catch (error) {
    return {
      ok: false,
      error: "AI request में समस्या आई।",
      details:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}

/*
 * REAL MASTER MIND AGENT
 *
 * This is now a Cloudflare Agent backed by
 * a Durable Object with persistent state.
 */

export class MasterMindAgent extends Agent {
  initialState = {
    messages: [],
    tasksCompleted: 0
  };

  initDb() {
    if (!this._dbInitialized) {
      this.sql`CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
        eligibility_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        owner_fit_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        score REAL NOT NULL DEFAULT 0,
        decision TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
        earning_model TEXT NOT NULL DEFAULT '',
        risk TEXT NOT NULL DEFAULT '',
        effort TEXT NOT NULL DEFAULT '',
        cost TEXT NOT NULL DEFAULT '',
        earning_potential TEXT NOT NULL DEFAULT '',
        discovered_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`;
      const existingColumns = [...this.sql`PRAGMA table_info(opportunities);`].map(c => c.name);
      if (!existingColumns.includes("earning_model")) {
        this.sql`ALTER TABLE opportunities ADD COLUMN earning_model TEXT NOT NULL DEFAULT '';`;
      }
      if (!existingColumns.includes("risk")) {
        this.sql`ALTER TABLE opportunities ADD COLUMN risk TEXT NOT NULL DEFAULT '';`;
      }
      if (!existingColumns.includes("effort")) {
        this.sql`ALTER TABLE opportunities ADD COLUMN effort TEXT NOT NULL DEFAULT '';`;
      }
      if (!existingColumns.includes("cost")) {
        this.sql`ALTER TABLE opportunities ADD COLUMN cost TEXT NOT NULL DEFAULT '';`;
      }
      if (!existingColumns.includes("earning_potential")) {
        this.sql`ALTER TABLE opportunities ADD COLUMN earning_potential TEXT NOT NULL DEFAULT '';`;
      }
      if (!existingColumns.includes("discovered_at")) {
        this.sql`ALTER TABLE opportunities ADD COLUMN discovered_at TEXT NOT NULL DEFAULT '';`;
      }
      if (!existingColumns.includes("decision")) {
        this.sql`ALTER TABLE opportunities ADD COLUMN decision TEXT NOT NULL DEFAULT 'NEEDS_REVIEW';`;
      }
      this.sql`CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        classification TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE
      );`;
      this.sql`CREATE TABLE IF NOT EXISTS owner_profile (
        id TEXT PRIMARY KEY,
        skills TEXT NOT NULL DEFAULT '',
        experience TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        max_cost TEXT NOT NULL DEFAULT '',
        max_effort TEXT NOT NULL DEFAULT '',
        accessibility TEXT NOT NULL DEFAULT '',
        other_criteria TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );`;
      this._dbInitialized = true;
    }
  }

  normalizeEligibilityStatus(status) {
    return normalizeEligibility(status);
  }

  normalizeOwnerFitStatus(status) {
    return normalizeOwnerFit(status);
  }

  getOwnerProfile() {
    this.initDb();
    const rows = [...this.sql`SELECT * FROM owner_profile WHERE id = 'default'`];
    if (rows.length > 0) {
      return rows[0];
    }
    return null;
  }

  updateOwnerProfile(data) {
    this.initDb();
    const existing = this.getOwnerProfile();
    const skills = data.skills !== undefined ? (Array.isArray(data.skills) ? data.skills.join(',') : String(data.skills)) : (existing ? existing.skills : '');
    const experience = data.experience !== undefined ? String(data.experience) : (existing ? existing.experience : '');
    const location = data.location !== undefined ? String(data.location) : (existing ? existing.location : '');
    const max_cost = data.max_cost !== undefined ? String(data.max_cost) : (existing ? existing.max_cost : '');
    const max_effort = data.max_effort !== undefined ? String(data.max_effort) : (existing ? existing.max_effort : '');
    const accessibility = data.accessibility !== undefined ? String(data.accessibility) : (existing ? existing.accessibility : '');
    const other_criteria = data.other_criteria !== undefined ? String(data.other_criteria) : (existing ? existing.other_criteria : '');
    const updated_at = new Date().toISOString();

    if (existing) {
      this.sql`UPDATE owner_profile SET
        skills = ${skills},
        experience = ${experience},
        location = ${location},
        max_cost = ${max_cost},
        max_effort = ${max_effort},
        accessibility = ${accessibility},
        other_criteria = ${other_criteria},
        updated_at = ${updated_at}
        WHERE id = 'default';`;
    } else {
      this.sql`INSERT INTO owner_profile (
        id, skills, experience, location, max_cost, max_effort, accessibility, other_criteria, updated_at
      ) VALUES (
        'default', ${skills}, ${experience}, ${location}, ${max_cost}, ${max_effort}, ${accessibility}, ${other_criteria}, ${updated_at}
      );`;
    }
    return this.getOwnerProfile();
  }

  evaluateEligibility(opportunityId, requestedStatus) {
    this.initDb();
    const opportunity = this.getOpportunity(opportunityId);
    if (!opportunity) {
      throw new Error("Opportunity not found");
    }

    const evidenceList = this.getEvidenceForOpportunity(opportunityId);
    const factEvidences = evidenceList.filter(e => e.classification === "FACT");
    const assumptionEvidences = evidenceList.filter(e => e.classification === "ASSUMPTION");
    const hypothesisEvidences = evidenceList.filter(e => e.classification === "HYPOTHESIS");

    if (requestedStatus) {
      const normRequested = this.normalizeEligibilityStatus(requestedStatus);
      if (normRequested === "ELIGIBLE") {
        if (factEvidences.length === 0) {
          throw new Error("Cannot set eligibility status to ELIGIBLE without at least one FACT evidence record.");
        }
      }
      this.sql`UPDATE opportunities SET eligibility_status = ${normRequested}, updated_at = ${new Date().toISOString()} WHERE id = ${opportunityId};`;
      return this.getOpportunity(opportunityId);
    }

    const currentNorm = this.normalizeEligibilityStatus(opportunity.eligibility_status);

    let status = "UNKNOWN";
    let reasons = [];

    const hasIneligibleFact = factEvidences.some(e => {
      const c = e.content.toLowerCase();
      return c.includes("ineligible") || c.includes("not eligible") || c.includes("banned") || c.includes("restricted country") || c.includes("disqualified");
    });

    if (hasIneligibleFact || currentNorm === "NOT_ELIGIBLE") {
      status = "NOT_ELIGIBLE";
      reasons.push("FACT evidence or explicit evaluation indicates Owner is not eligible.");
    } else {
      const hasEligibleFact = factEvidences.some(e => {
        const c = e.content.toLowerCase();
        return c.includes("eligible") || c.includes("eligibility confirmed") || c.includes("verified location") || c.includes("verified account") || c.includes("contract eligible");
      });

      if (hasEligibleFact) {
        status = "ELIGIBLE";
        reasons.push("Sufficient FACT evidence confirms Owner eligibility.");
      } else if (factEvidences.length > 0 && currentNorm === "ELIGIBLE") {
        status = "ELIGIBLE";
        reasons.push("FACT evidence supports eligibility status.");
      } else if (assumptionEvidences.length > 0 || hypothesisEvidences.length > 0) {
        status = "POTENTIALLY_ELIGIBLE";
        reasons.push("Eligibility is supported by ASSUMPTION or HYPOTHESIS evidence but complete verification is not available.");
      } else if (currentNorm === "ELIGIBLE") {
        if (factEvidences.length > 0) {
          status = "ELIGIBLE";
          reasons.push("FACT evidence supports eligibility.");
        } else {
          status = "POTENTIALLY_ELIGIBLE";
          reasons.push("Eligibility lacks supporting FACT evidence.");
        }
      } else if (currentNorm === "POTENTIALLY_ELIGIBLE") {
        status = "POTENTIALLY_ELIGIBLE";
        reasons.push("Partial supporting evidence exists.");
      } else {
        status = "UNKNOWN";
        reasons.push("Required eligibility information or evidence is missing.");
      }
    }

    this.sql`UPDATE opportunities SET eligibility_status = ${status}, updated_at = ${new Date().toISOString()} WHERE id = ${opportunityId};`;
    const updatedOpp = this.getOpportunity(opportunityId);

    return {
      opportunityId,
      eligibility_status: status,
      status,
      reasons,
      factEvidenceCount: factEvidences.length,
      assumptionEvidenceCount: assumptionEvidences.length,
      hypothesisEvidenceCount: hypothesisEvidences.length,
      opportunity: updatedOpp
    };
  }

  evaluateOwnerFit(opportunityId, requestedStatus) {
    this.initDb();
    const opportunity = this.getOpportunity(opportunityId);
    if (!opportunity) {
      throw new Error("Opportunity not found");
    }

    const evidenceList = this.getEvidenceForOpportunity(opportunityId);
    const factEvidences = evidenceList.filter(e => e.classification === "FACT");
    const assumptionEvidences = evidenceList.filter(e => e.classification === "ASSUMPTION");
    const hypothesisEvidences = evidenceList.filter(e => e.classification === "HYPOTHESIS");

    if (requestedStatus) {
      const normRequested = this.normalizeOwnerFitStatus(requestedStatus);
      if (normRequested === "FIT") {
        if (factEvidences.length === 0) {
          throw new Error("Cannot set owner fit status to FIT without at least one FACT evidence record.");
        }
      }
      this.sql`UPDATE opportunities SET owner_fit_status = ${normRequested}, updated_at = ${new Date().toISOString()} WHERE id = ${opportunityId};`;
      return this.getOpportunity(opportunityId);
    }

    const currentNorm = this.normalizeOwnerFitStatus(opportunity.owner_fit_status);
    const ownerProfile = this.getOwnerProfile();

    let status = "UNKNOWN";
    let reasons = [];

    const hasUnfitFact = factEvidences.some(e => {
      const c = e.content.toLowerCase();
      return c.includes("unfit") || c.includes("not fit") || c.includes("lacks required skill") || c.includes("exceeds cost limit") || c.includes("conflict");
    });

    if (hasUnfitFact || currentNorm === "NOT_FIT") {
      status = "NOT_FIT";
      reasons.push("FACT evidence or explicit evaluation indicates opportunity is NOT FIT for Owner.");
    } else {
      const hasFitFact = factEvidences.some(e => {
        const c = e.content.toLowerCase();
        return c.includes("owner fit confirmed") || c.includes("skills match verified") || c.includes("fit verified") || c.includes("fit confirmed");
      });

      let profileMismatch = false;

      if (ownerProfile) {
        if (ownerProfile.max_cost && opportunity.cost) {
          const profileCostNum = parseFloat(ownerProfile.max_cost.replace(/[^0-9.]/g, ""));
          const oppCostNum = parseFloat(opportunity.cost.replace(/[^0-9.]/g, ""));
          if (!isNaN(profileCostNum) && !isNaN(oppCostNum) && oppCostNum > profileCostNum) {
            profileMismatch = true;
            reasons.push(`Required cost (${opportunity.cost}) exceeds Owner max cost limit (${ownerProfile.max_cost}).`);
          }
        }
      }

      if (profileMismatch) {
        status = "NOT_FIT";
      } else if (hasFitFact) {
        status = "FIT";
        reasons.push("Sufficient FACT evidence confirms Owner fit.");
      } else if (factEvidences.length > 0 && currentNorm === "FIT") {
        status = "FIT";
        reasons.push("FACT evidence supports Owner fit.");
      } else if (assumptionEvidences.length > 0 || hypothesisEvidences.length > 0) {
        status = "POTENTIAL_FIT";
        reasons.push("Owner fit is supported by ASSUMPTION or HYPOTHESIS evidence but complete verification is not available.");
      } else if (currentNorm === "FIT") {
        if (factEvidences.length > 0) {
          status = "FIT";
          reasons.push("FACT evidence supports Owner fit.");
        } else {
          status = "POTENTIAL_FIT";
          reasons.push("Owner fit lacks supporting FACT evidence.");
        }
      } else if (currentNorm === "POTENTIAL_FIT") {
        status = "POTENTIAL_FIT";
        reasons.push("Partial supporting evidence exists.");
      } else {
        status = "UNKNOWN";
        reasons.push("Required Owner fit information or criteria is missing.");
      }
    }

    this.sql`UPDATE opportunities SET owner_fit_status = ${status}, updated_at = ${new Date().toISOString()} WHERE id = ${opportunityId};`;
    const updatedOpp = this.getOpportunity(opportunityId);

    return {
      opportunityId,
      owner_fit_status: status,
      status,
      reasons,
      factEvidenceCount: factEvidences.length,
      assumptionEvidenceCount: assumptionEvidences.length,
      hypothesisEvidenceCount: hypothesisEvidences.length,
      opportunity: updatedOpp
    };
  }

  async onStart() {
    this.initDb();
    if (!this.state) {
      this.setState({
        messages: [],
        tasksCompleted: 0
      });
    }
  }

  validateClassification(classification) {
    const normalized = String(classification || "").trim().toUpperCase();
    if (!["FACT", "ASSUMPTION", "HYPOTHESIS"].includes(normalized)) {
      throw new Error(`Invalid classification '${classification}'. Must be FACT, ASSUMPTION, or HYPOTHESIS.`);
    }
    return normalized;
  }

  validateVerificationStatus(status) {
    const normalized = String(status || "").trim().toUpperCase();
    if (!["VERIFIED", "PARTIALLY_VERIFIED", "UNVERIFIED", "REJECTED"].includes(normalized)) {
      throw new Error(`Invalid verification status '${status}'. Must be VERIFIED, PARTIALLY_VERIFIED, UNVERIFIED, or REJECTED.`);
    }
    return normalized;
  }

  getEvidenceForOpportunity(opportunityId) {
    this.initDb();
    return [...this.sql`SELECT * FROM evidence WHERE opportunity_id = ${opportunityId} ORDER BY created_at DESC`];
  }

  hasFactEvidence(opportunityId) {
    const list = this.getEvidenceForOpportunity(opportunityId);
    return list.some(e => e.classification === "FACT");
  }

  evaluateVerificationStatus(opportunityId) {
    this.initDb();
    const opportunity = this.getOpportunity(opportunityId);
    if (!opportunity) {
      throw new Error("Opportunity not found");
    }
    // Respect explicit REJECTED status. If an opportunity is marked REJECTED, automatic evidence evaluation will not overwrite REJECTED.
    if (String(opportunity.verification_status).toUpperCase() === "REJECTED") {
      return opportunity;
    }

    const evidenceList = this.getEvidenceForOpportunity(opportunityId);
    let newStatus = "UNVERIFIED";

    if (evidenceList.length === 0) {
      newStatus = "UNVERIFIED";
    } else {
      const hasFact = evidenceList.some(e => e.classification === "FACT");
      const hasNonFact = evidenceList.some(e => e.classification === "ASSUMPTION" || e.classification === "HYPOTHESIS");
      if (hasFact && !hasNonFact) {
        newStatus = "VERIFIED";
      } else if (hasFact && hasNonFact) {
        newStatus = "PARTIALLY_VERIFIED";
      } else if (!hasFact && hasNonFact) {
        newStatus = "PARTIALLY_VERIFIED";
      }
    }

    this.sql`UPDATE opportunities SET verification_status = ${newStatus}, updated_at = ${new Date().toISOString()} WHERE id = ${opportunityId};`;
    return this.getOpportunity(opportunityId);
  }

  evaluateDecision(opportunityId) {
    this.initDb();
    const updatedVerification = this.evaluateVerificationStatus(opportunityId);
    if (!updatedVerification) {
      throw new Error("Opportunity not found");
    }

    this.evaluateEligibility(opportunityId);
    this.evaluateOwnerFit(opportunityId);

    const updatedOpp = this.getOpportunity(opportunityId);
    const evidenceList = this.getEvidenceForOpportunity(opportunityId);
    const factCount = evidenceList.filter(e => e.classification === "FACT").length;
    const assumptionCount = evidenceList.filter(e => e.classification === "ASSUMPTION").length;
    const hypothesisCount = evidenceList.filter(e => e.classification === "HYPOTHESIS").length;
    const hasFact = factCount > 0;

    const verificationStatus = String(updatedOpp.verification_status || "UNVERIFIED").toUpperCase();
    const eligibilityStatus = this.normalizeEligibilityStatus(updatedOpp.eligibility_status);
    const ownerFitStatus = this.normalizeOwnerFitStatus(updatedOpp.owner_fit_status);

    const factors = {
      verification: { value: verificationStatus, points: 0, maxPoints: 40, weight: 0.4 },
      eligibility: { value: eligibilityStatus, points: 0, maxPoints: 30, weight: 0.3 },
      ownerFit: { value: ownerFitStatus, points: 0, maxPoints: 30, weight: 0.3 },
      evidenceQuality: {
        totalEvidence: evidenceList.length,
        factCount,
        assumptionCount,
        hypothesisCount,
        hasFact
      }
    };

    const reasons = [];
    const unknowns = [];

    // 1. Verification scoring
    if (verificationStatus === "REJECTED") {
      factors.verification.points = 0;
      reasons.push("Verification status is REJECTED.");
    } else if (verificationStatus === "VERIFIED") {
      factors.verification.points = 40;
      reasons.push("Verification status is VERIFIED with supporting FACT evidence.");
    } else if (verificationStatus === "PARTIALLY_VERIFIED") {
      factors.verification.points = 20;
      reasons.push("Verification status is PARTIALLY_VERIFIED.");
      unknowns.push("Verification is incomplete (has non-FACT evidence or unconfirmed assumptions).");
    } else {
      factors.verification.points = 0;
      reasons.push("Verification status is UNVERIFIED.");
      unknowns.push("Verification status is UNVERIFIED.");
    }

    // 2. Eligibility scoring
    if (eligibilityStatus === "NOT_ELIGIBLE") {
      factors.eligibility.points = 0;
      reasons.push("Eligibility status is NOT_ELIGIBLE.");
    } else if (eligibilityStatus === "ELIGIBLE") {
      factors.eligibility.points = 30;
      reasons.push("Eligibility status is ELIGIBLE.");
    } else if (eligibilityStatus === "POTENTIALLY_ELIGIBLE") {
      factors.eligibility.points = 15;
      reasons.push("Eligibility status is POTENTIALLY_ELIGIBLE.");
      unknowns.push("Eligibility status is POTENTIALLY_ELIGIBLE (unconfirmed assumptions/hypotheses).");
    } else {
      factors.eligibility.points = 0;
      reasons.push("Eligibility status is UNKNOWN due to missing information.");
      unknowns.push("Eligibility status is UNKNOWN.");
    }

    // 3. Owner Fit scoring
    if (ownerFitStatus === "NOT_FIT") {
      factors.ownerFit.points = 0;
      reasons.push("Owner-fit status is NOT_FIT.");
    } else if (ownerFitStatus === "FIT") {
      factors.ownerFit.points = 30;
      reasons.push("Owner-fit status is FIT.");
    } else if (ownerFitStatus === "POTENTIAL_FIT") {
      factors.ownerFit.points = 15;
      reasons.push("Owner-fit status is POTENTIAL_FIT.");
      unknowns.push("Owner-fit status is POTENTIAL_FIT (unconfirmed assumptions/hypotheses).");
    } else {
      factors.ownerFit.points = 0;
      reasons.push("Owner-fit status is UNKNOWN due to missing information.");
      unknowns.push("Owner-fit status is UNKNOWN.");
    }

    // 4. Additional evidence tracking
    if (evidenceList.length === 0) {
      unknowns.push("No supporting evidence records found.");
    }

    const totalScore = Math.round((factors.verification.points + factors.eligibility.points + factors.ownerFit.points) * 10) / 10;

    let decision = "NEEDS_REVIEW";

    const isHardRejected = verificationStatus === "REJECTED" || eligibilityStatus === "NOT_ELIGIBLE" || ownerFitStatus === "NOT_FIT";

    if (isHardRejected) {
      decision = "REJECT";
      reasons.push("Decision threshold evaluated to REJECT due to explicit disqualification (REJECTED status, NOT_ELIGIBLE, or NOT_FIT).");
    } else if (verificationStatus === "VERIFIED" && hasFact && eligibilityStatus === "ELIGIBLE" && ownerFitStatus === "FIT" && totalScore >= 80.0) {
      decision = "SELECT";
      reasons.push("Decision threshold evaluated to SELECT: all verification, eligibility, and owner-fit criteria are fully satisfied.");
    } else {
      decision = "NEEDS_REVIEW";
      reasons.push("Decision threshold evaluated to NEEDS_REVIEW: key information is missing, pending, unverified, or requires Owner review.");
    }

    this.sql`UPDATE opportunities SET score = ${totalScore}, decision = ${decision}, updated_at = ${new Date().toISOString()} WHERE id = ${opportunityId};`;

    return {
      opportunityId,
      decision,
      score: totalScore,
      factors,
      reasons,
      unknowns,
      verificationStatus: updatedOpp.verification_status,
      eligibilityStatus: updatedOpp.eligibility_status,
      ownerFitStatus: updatedOpp.owner_fit_status,
      verificationLimitations: [
        "Decision engine evaluates opportunity based on existing deterministic criteria and evidence records classified as FACT under the existing verification rules.",
        "Decision Engine evaluation itself did not spend money, create accounts, or make external submissions.",
        "Marketplace submissions (Upwork/Fiverr) remain manual Owner actions."
      ]
    };
  }

  createOpportunity(data) {
    this.initDb();
    const id = data.id || crypto.randomUUID();
    const source = String(data.source || "manual").trim();
    const title = String(data.title || "").trim();
    if (!title) {
      throw new Error("Title is required");
    }
    const url = String(data.url || "").trim();
    const platform = String(data.platform || "").trim();
    const description = String(data.description || "").trim();

    // Newly ingested work is always UNVERIFIED. A VERIFIED state can only be
    // reached through createEvidence()/verifyOpportunity() against evidence
    // that already exists, so no create path can short-circuit the truth rule.
    const verification_status = "UNVERIFIED";

    // A create payload cannot assert a positive verdict. ELIGIBLE and FIT are
    // claimable only with at least one FACT evidence record, which a brand-new
    // opportunity cannot yet have, so an unsupported assertion is not persisted
    // and collapses to UNKNOWN instead of inventing evidence.
    let eligibility_status = normalizeEligibility(data.eligibility_status);
    if (eligibility_status === "ELIGIBLE" && !this.hasFactEvidence(id)) {
      eligibility_status = "UNKNOWN";
    }
    let owner_fit_status = normalizeOwnerFit(data.owner_fit_status);
    if (owner_fit_status === "FIT" && !this.hasFactEvidence(id)) {
      owner_fit_status = "UNKNOWN";
    }

    // Score and decision are derived only by evaluateDecision(). Client-supplied
    // values are deliberately discarded so the deterministic engine owns them.
    const score = 0;
    const decision = "NEEDS_REVIEW";

    const earning_model = String(data.earning_model || "").trim();
    const risk = String(data.risk || "").trim();
    const effort = String(data.effort || "").trim();
    const cost = String(data.cost || "").trim();
    const earning_potential = String(data.earning_potential || "").trim();
    const discovered_at = data.discovered_at ? String(data.discovered_at).trim() : new Date().toISOString();

    const created_at = data.created_at || new Date().toISOString();
    const updated_at = data.updated_at || created_at;

    this.sql`INSERT INTO opportunities (
      id, source, title, url, platform, description,
      verification_status, eligibility_status, owner_fit_status,
      score, decision, earning_model, risk, effort, cost, earning_potential, discovered_at,
      created_at, updated_at
    ) VALUES (
      ${id}, ${source}, ${title}, ${url}, ${platform}, ${description},
      ${verification_status}, ${eligibility_status}, ${owner_fit_status},
      ${score}, ${decision}, ${earning_model}, ${risk}, ${effort}, ${cost}, ${earning_potential}, ${discovered_at},
      ${created_at}, ${updated_at}
    );`;

    return this.getOpportunity(id);
  }

  getOpportunity(id) {
    this.initDb();
    const rows = [...this.sql`SELECT * FROM opportunities WHERE id = ${id}`];
    return rows.length > 0 ? rows[0] : null;
  }

  listOpportunities(filters = {}) {
    this.initDb();
    let rows = [...this.sql`SELECT * FROM opportunities ORDER BY created_at DESC`];
    if (filters.source) {
      rows = rows.filter(r => r.source === filters.source);
    }
    if (filters.platform) {
      rows = rows.filter(r => r.platform === filters.platform);
    }
    if (filters.verification_status) {
      const norm = normalizeVerification(filters.verification_status);
      rows = rows.filter(r => normalizeVerification(r.verification_status) === norm);
    }
    if (filters.eligibility_status) {
      const norm = normalizeEligibility(filters.eligibility_status);
      rows = rows.filter(r => normalizeEligibility(r.eligibility_status) === norm);
    }
    if (filters.owner_fit_status) {
      const norm = normalizeOwnerFit(filters.owner_fit_status);
      rows = rows.filter(r => normalizeOwnerFit(r.owner_fit_status) === norm);
    }
    if (filters.decision) {
      const norm = normalizeDecision(filters.decision);
      rows = rows.filter(r => normalizeDecision(r.decision) === norm);
    }
    return rows;
  }

  updateOpportunity(id, data) {
    this.initDb();
    const existing = this.getOpportunity(id);
    if (!existing) {
      return null;
    }

    const source = data.source !== undefined ? String(data.source).trim() : existing.source;
    const title = data.title !== undefined ? String(data.title).trim() : existing.title;
    if (!title) {
      throw new Error("Title cannot be empty");
    }
    const url = data.url !== undefined ? String(data.url).trim() : existing.url;
    const platform = data.platform !== undefined ? String(data.platform).trim() : existing.platform;
    const description = data.description !== undefined ? String(data.description).trim() : existing.description;

    let verification_status = existing.verification_status;
    if (data.verification_status !== undefined) {
      const requestedStatus = this.validateVerificationStatus(data.verification_status);
      if (requestedStatus === "VERIFIED") {
        const hasFact = this.hasFactEvidence(id);
        if (!hasFact) {
          throw new Error("Cannot set status to VERIFIED without at least one FACT evidence record.");
        }
      }
      verification_status = requestedStatus;
    }

    // Positive verdicts are claimable only with FACT evidence. A PATCH that
    // asserts ELIGIBLE/FIT without it is rejected, not silently downgraded, so
    // the caller learns the write did not take effect. Fields the caller did
    // not supply carry over unchanged and are re-derived by the engine.
    let eligibility_status = normalizeEligibility(existing.eligibility_status);
    if (data.eligibility_status !== undefined) {
      eligibility_status = normalizeEligibility(data.eligibility_status);
      if (eligibility_status === "ELIGIBLE" && !this.hasFactEvidence(id)) {
        throw new Error("Cannot set eligibility status to ELIGIBLE without at least one FACT evidence record.");
      }
    }
    let owner_fit_status = normalizeOwnerFit(existing.owner_fit_status);
    if (data.owner_fit_status !== undefined) {
      owner_fit_status = normalizeOwnerFit(data.owner_fit_status);
      if (owner_fit_status === "FIT" && !this.hasFactEvidence(id)) {
        throw new Error("Cannot set owner fit status to FIT without at least one FACT evidence record.");
      }
    }
    // Score and decision are engine-owned. Client-supplied values are ignored.
    const score = existing.score;
    const decision = normalizeDecision(existing.decision);
    const earning_model = data.earning_model !== undefined ? String(data.earning_model).trim() : (existing.earning_model || "");
    const risk = data.risk !== undefined ? String(data.risk).trim() : (existing.risk || "");
    const effort = data.effort !== undefined ? String(data.effort).trim() : (existing.effort || "");
    const cost = data.cost !== undefined ? String(data.cost).trim() : (existing.cost || "");
    const earning_potential = data.earning_potential !== undefined ? String(data.earning_potential).trim() : (existing.earning_potential || "");
    const discovered_at = data.discovered_at !== undefined ? String(data.discovered_at).trim() : (existing.discovered_at || "");
    const updated_at = new Date().toISOString();

    this.sql`UPDATE opportunities SET
      source = ${source},
      title = ${title},
      url = ${url},
      platform = ${platform},
      description = ${description},
      verification_status = ${verification_status},
      eligibility_status = ${eligibility_status},
      owner_fit_status = ${owner_fit_status},
      score = ${score},
      decision = ${decision},
      earning_model = ${earning_model},
      risk = ${risk},
      effort = ${effort},
      cost = ${cost},
      earning_potential = ${earning_potential},
      discovered_at = ${discovered_at},
      updated_at = ${updated_at}
      WHERE id = ${id};`;

    return this.getOpportunity(id);
  }

  deleteOpportunity(id) {
    this.initDb();
    const existing = this.getOpportunity(id);
    if (!existing) {
      return false;
    }
    this.sql`DELETE FROM evidence WHERE opportunity_id = ${id};`;
    this.sql`DELETE FROM opportunities WHERE id = ${id};`;
    return true;
  }

  verifyOpportunity(id, targetStatus) {
    this.initDb();
    const existing = this.getOpportunity(id);
    if (!existing) {
      throw new Error("Opportunity not found");
    }

    if (!targetStatus) {
      return this.evaluateVerificationStatus(id);
    }

    const requestedStatus = this.validateVerificationStatus(targetStatus);
    if (requestedStatus === "VERIFIED") {
      const hasFact = this.hasFactEvidence(id);
      if (!hasFact) {
        throw new Error("Cannot verify opportunity: No FACT evidence records found.");
      }
    }

    this.sql`UPDATE opportunities SET verification_status = ${requestedStatus}, updated_at = ${new Date().toISOString()} WHERE id = ${id};`;
    return this.getOpportunity(id);
  }

  createEvidence(data) {
    this.initDb();
    const opportunityId = String(data.opportunity_id || data.opportunityId || "").trim();
    if (!opportunityId) {
      throw new Error("opportunity_id is required");
    }
    const opportunity = this.getOpportunity(opportunityId);
    if (!opportunity) {
      throw new Error("Opportunity not found");
    }

    const classification = this.validateClassification(data.classification);
    const source = String(data.source || "").trim();
    if (!source) {
      throw new Error("Evidence source is required");
    }
    const content = String(data.content || "").trim();
    if (!content) {
      throw new Error("Evidence content is required");
    }

    const id = data.id || crypto.randomUUID();
    const created_at = data.created_at || new Date().toISOString();
    const updated_at = data.updated_at || created_at;

    this.sql`INSERT INTO evidence (
      id, opportunity_id, classification, source, content, created_at, updated_at
    ) VALUES (
      ${id}, ${opportunityId}, ${classification}, ${source}, ${content}, ${created_at}, ${updated_at}
    );`;

    // Adding evidence changes the derived verdicts, so recompute the complete
    // deterministic chain (verification -> eligibility -> owner fit -> score ->
    // decision) instead of only verification.
    this.evaluateDecision(opportunityId);

    return this.getEvidence(id);
  }

  getEvidence(id) {
    this.initDb();
    const rows = [...this.sql`SELECT * FROM evidence WHERE id = ${id}`];
    return rows.length > 0 ? rows[0] : null;
  }

  listEvidence(filters = {}) {
    this.initDb();
    let rows = [...this.sql`SELECT * FROM evidence ORDER BY created_at DESC`];
    if (filters.opportunity_id) {
      rows = rows.filter(r => r.opportunity_id === filters.opportunity_id);
    }
    if (filters.classification) {
      const norm = String(filters.classification).trim().toUpperCase();
      rows = rows.filter(r => r.classification === norm);
    }
    return rows;
  }

  findDuplicateOpportunity(item) {
    this.initDb();
    const existingList = this.listOpportunities();
    const targetUrl = String(item.url || "").trim().toLowerCase();
    const targetTitle = String(item.title || "").trim().toLowerCase();
    const targetPlatform = String(item.platform || "").trim().toLowerCase();

    for (const existing of existingList) {
      const exUrl = String(existing.url || "").trim().toLowerCase();
      const exTitle = String(existing.title || "").trim().toLowerCase();
      const exPlatform = String(existing.platform || "").trim().toLowerCase();

      if (targetUrl && exUrl && targetUrl === exUrl) {
        return { duplicate: true, reason: "Duplicate URL match", existing };
      }

      if (targetTitle && targetPlatform && exTitle === targetTitle && exPlatform === targetPlatform) {
        return { duplicate: true, reason: "Duplicate Title and Platform match", existing };
      }
    }

    return { duplicate: false };
  }

  discoverOpportunities(payload) {
    this.initDb();
    const connectivity = "NOT_CONNECTED";

    let items = [];
    if (Array.isArray(payload)) {
      items = payload;
    } else if (payload && Array.isArray(payload.opportunities)) {
      items = payload.opportunities;
    } else if (payload && Array.isArray(payload.items)) {
      items = payload.items;
    } else if (payload && typeof payload === "object" && (payload.title || payload.url)) {
      items = [payload];
    } else {
      return {
        ok: true,
        connectivity,
        status: "NOT_CONNECTED",
        message: "External automated discovery is NOT_CONNECTED / UNAVAILABLE. No external search capability is connected.",
        summary: {
          totalInput: 0,
          discoveredCount: 0,
          duplicateCount: 0,
          errorCount: 0
        },
        discovered: [],
        duplicates: [],
        errors: []
      };
    }

    const discovered = [];
    const duplicates = [];
    const errors = [];

    for (const item of items) {
      if (!item || typeof item !== "object") {
        errors.push({ item, error: "Invalid opportunity payload" });
        continue;
      }

      const title = String(item.title || "").trim();
      if (!title) {
        errors.push({ item, error: "Title is required" });
        continue;
      }

      const dupCheck = this.findDuplicateOpportunity(item);
      if (dupCheck.duplicate) {
        duplicates.push({
          item,
          existingId: dupCheck.existing.id,
          reason: dupCheck.reason
        });
        continue;
      }

      try {
        const created = this.createOpportunity({
          source: item.source || "discovery",
          title: item.title,
          url: item.url || "",
          platform: item.platform || "",
          description: item.description || "",
          verification_status: "UNVERIFIED",
          eligibility_status: normalizeEligibility(item.eligibility_status),
          owner_fit_status: normalizeOwnerFit(item.owner_fit_status),
          earning_model: item.earning_model || "",
          risk: item.risk || "",
          effort: item.effort || "",
          cost: item.cost || "",
          earning_potential: item.earning_potential || "",
          discovered_at: item.discovered_at || new Date().toISOString()
        });
        discovered.push(created);
      } catch (err) {
        errors.push({ item, error: err.message });
      }
    }

    return {
      ok: true,
      connectivity,
      summary: {
        totalInput: items.length,
        discoveredCount: discovered.length,
        duplicateCount: duplicates.length,
        errorCount: errors.length
      },
      discovered,
      duplicates,
      errors
    };
  }

  deleteEvidence(id) {
    this.initDb();
    const existing = this.getEvidence(id);
    if (!existing) {
      return false;
    }
    const opportunityId = existing.opportunity_id;
    this.sql`DELETE FROM evidence WHERE id = ${id};`;
    if (opportunityId && this.getOpportunity(opportunityId)) {
      // Removing evidence invalidates every derived verdict, so recompute the
      // complete deterministic chain instead of only verification; otherwise a
      // stale score/SELECT could survive the deletion.
      this.evaluateDecision(opportunityId);
    }
    return true;
  }

  async onRequest(request) {
    const url = new URL(request.url);

    if (
      url.pathname.endsWith("/health") &&
      request.method === "GET"
    ) {
      return Response.json({
        ok: true,
        service: "MasterMind AI",
        status: "online",
        agent: "MasterMindAgent",
        persistentState: true,
        aiConnected:
          !!this.env.AI &&
          typeof this.env.AI.run === "function",
        browserConnected:
          !!this.env.BROWSER &&
          typeof this.env.BROWSER.quickAction ===
            "function"
      });
    }

    if (
      url.pathname.endsWith("/connections") &&
      request.method === "GET"
    ) {
      return Response.json({ ok: true, data: connectionReport(this.env) });
    }

    if (
      url.pathname.endsWith("/voice") &&
      request.method === "GET"
    ) {
      return Response.json({
        ok: true,
        data: {
          states: VOICE_STATES,
          ...resolveVoiceState(this.env)
        }
      });
    }

    if (
      url.pathname.endsWith("/permissions") &&
      request.method === "GET"
    ) {
      return Response.json({
        ok: true,
        data: {
          authorizationConfigured: hasOwnerToken(this.env),
          authorizationState: hasOwnerToken(this.env) ? "CONFIGURED" : "NOT_CONFIGURED",
          model: [
            "SERVICE",
            "CAPABILITY",
            "SCOPE",
            "RISK",
            "APPROVAL_REQUIREMENT",
            "AUTHORIZED_ACTION",
            "EXECUTION",
            "VERIFICATION",
            "AUDIT"
          ],
          rules: [
            { capability: "read opportunities/evidence/owner profile", risk: RISK.READ, approval: "NONE" },
            { capability: "create/update/delete opportunity and evidence", risk: RISK.MUTATE, approval: "OWNER_CREDENTIAL_OR_SAME_ORIGIN" },
            { capability: "owner profile update", risk: RISK.MUTATE, approval: "OWNER_CREDENTIAL_OR_SAME_ORIGIN" },
            { capability: "upwork/fiverr final submission", risk: RISK.OWNER_CONTROLLED, approval: "MANUAL_OWNER_ONLY" }
          ],
          note: "Connection does not grant capability. Authorization does not grant execution. Execution does not imply verified success."
        }
      });
    }

    if (url.pathname.includes("/opportunities")) {
      const parts = url.pathname.split("/opportunities");
      const subpath = parts[1] || "";

      const mutationDenied = authorizeRequest(request, this.env, RISK.MUTATE);
      if (mutationDenied) return mutationDenied;

      // Route: GET/POST /opportunities/discover
      if (subpath === "/discover" || subpath.startsWith("/discover?")) {
        if (request.method === "GET") {
          return Response.json({
            ok: true,
            status: "NOT_CONNECTED",
            connectivity: "NOT_CONNECTED",
            connected: false,
            message: "Marketplace discovery capability is NOT_CONNECTED / UNAVAILABLE. External automated search is unavailable.",
            supportedPlatforms: [],
            limitations: [
              "No external marketplace accounts connected.",
              "Automated external searching or scraping is unavailable.",
              "Manual or structured discovery inputs are accepted and validated."
            ]
          });
        }
        if (request.method === "POST") {
          let body = {};
          try {
            body = await request.json();
          } catch {
            return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
          }

          const result = this.discoverOpportunities(body);
          if (result.summary && result.summary.totalInput === 1 && result.summary.errorCount === 1 && result.summary.discoveredCount === 0 && result.summary.duplicateCount === 0) {
            return Response.json({ ok: false, error: result.errors[0].error, details: result }, { status: 400 });
          }
          return Response.json(result);
        }
      }

      // Route: GET/POST /opportunities/:id/decision
      const decisionMatch = subpath.match(/^\/([^\/]+)\/decision$/);
      if (decisionMatch) {
        const targetId = decisionMatch[1];
        if (request.method === "POST" || request.method === "GET") {
          try {
            const decisionResult = this.evaluateDecision(targetId);
            return Response.json({ ok: true, data: decisionResult });
          } catch (err) {
            const status = err.message === "Opportunity not found" ? 404 : 400;
            return Response.json({ ok: false, error: err.message }, { status });
          }
        }
      }

      // Route: POST /opportunities/:id/verify
      const verifyMatch = subpath.match(/^\/([^\/]+)\/verify$/);
      if (verifyMatch && request.method === "POST") {
        const targetId = verifyMatch[1];
        let body = {};
        try {
          body = await request.json();
        } catch {
          // Empty body is allowed if triggering auto evaluation
        }
        try {
          const updated = this.verifyOpportunity(targetId, body.status || body.verification_status);
          return Response.json({ ok: true, data: updated });
        } catch (err) {
          return Response.json({ ok: false, error: err.message }, { status: 400 });
        }
      }

      // Route: GET/POST /opportunities/:id/eligibility
      const eligibilityMatch = subpath.match(/^\/([^\/]+)\/eligibility$/);
      if (eligibilityMatch) {
        const targetId = eligibilityMatch[1];
        if (request.method === "GET") {
          try {
            const evalResult = this.evaluateEligibility(targetId);
            return Response.json({ ok: true, data: evalResult });
          } catch (err) {
            const status = err.message === "Opportunity not found" ? 404 : 400;
            return Response.json({ ok: false, error: err.message }, { status });
          }
        }
        if (request.method === "POST") {
          let body = {};
          try {
            body = await request.json();
          } catch {
            // Body can be empty for auto evaluation
          }
          try {
            const evalResult = this.evaluateEligibility(targetId, body.status || body.eligibility_status);
            return Response.json({ ok: true, data: evalResult });
          } catch (err) {
            return Response.json({ ok: false, error: err.message }, { status: 400 });
          }
        }
      }

      // Route: GET/POST /opportunities/:id/owner-fit
      const ownerFitMatch = subpath.match(/^\/([^\/]+)\/owner-fit$/);
      if (ownerFitMatch) {
        const targetId = ownerFitMatch[1];
        if (request.method === "GET") {
          try {
            const evalResult = this.evaluateOwnerFit(targetId);
            return Response.json({ ok: true, data: evalResult });
          } catch (err) {
            const status = err.message === "Opportunity not found" ? 404 : 400;
            return Response.json({ ok: false, error: err.message }, { status });
          }
        }
        if (request.method === "POST") {
          let body = {};
          try {
            body = await request.json();
          } catch {
            // Body can be empty for auto evaluation
          }
          try {
            const evalResult = this.evaluateOwnerFit(targetId, body.status || body.owner_fit_status);
            return Response.json({ ok: true, data: evalResult });
          } catch (err) {
            return Response.json({ ok: false, error: err.message }, { status: 400 });
          }
        }
      }

      // Route: GET/POST /opportunities/:id/evidence
      const oppEvidenceMatch = subpath.match(/^\/([^\/]+)\/evidence$/);
      if (oppEvidenceMatch) {
        const targetId = oppEvidenceMatch[1];
        if (request.method === "GET") {
          const evidenceList = this.getEvidenceForOpportunity(targetId);
          return Response.json({ ok: true, data: evidenceList });
        }
        if (request.method === "POST") {
          let body = {};
          try {
            body = await request.json();
          } catch {
            return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
          }
          try {
            const created = this.createEvidence({ ...body, opportunity_id: targetId });
            return Response.json({ ok: true, data: created }, { status: 201 });
          } catch (err) {
            return Response.json({ ok: false, error: err.message }, { status: 400 });
          }
        }
      }

      const idMatch = subpath.match(/^\/([^\/]+)$/);
      const targetId = idMatch ? idMatch[1] : null;

      if (request.method === "GET") {
        if (targetId) {
          const item = this.getOpportunity(targetId);
          if (!item) {
            return Response.json({ ok: false, error: "Opportunity not found" }, { status: 404 });
          }
          return Response.json({ ok: true, data: item });
        } else {
          const queryParams = Object.fromEntries(url.searchParams.entries());
          const list = this.listOpportunities(queryParams);
          return Response.json({ ok: true, data: list });
        }
      }

      if (request.method === "POST" && (!targetId || targetId === "")) {
        let body = {};
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        try {
          const created = this.createOpportunity(body);
          return Response.json({ ok: true, data: created }, { status: 201 });
        } catch (err) {
          return Response.json({ ok: false, error: err.message }, { status: 400 });
        }
      }

      if ((request.method === "PUT" || request.method === "PATCH") && targetId) {
        let body = {};
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        try {
          const updated = this.updateOpportunity(targetId, body);
          if (!updated) {
            return Response.json({ ok: false, error: "Opportunity not found" }, { status: 404 });
          }
          return Response.json({ ok: true, data: updated });
        } catch (err) {
          return Response.json({ ok: false, error: err.message }, { status: 400 });
        }
      }

      if (request.method === "DELETE" && targetId) {
        const deleted = this.deleteOpportunity(targetId);
        if (!deleted) {
          return Response.json({ ok: false, error: "Opportunity not found" }, { status: 404 });
        }
        return Response.json({ ok: true, message: "Opportunity deleted successfully" });
      }

      return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
    }

    if (url.pathname.includes("/owner/profile")) {
      if (request.method === "GET") {
        const profile = this.getOwnerProfile();
        return Response.json({ ok: true, data: profile });
      }
      const denied = authorizeRequest(request, this.env, RISK.MUTATE);
      if (denied) return denied;
      if (request.method === "POST" || request.method === "PUT") {
        let body = {};
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        const updated = this.updateOwnerProfile(body);
        return Response.json({ ok: true, data: updated });
      }
    }

    if (url.pathname.includes("/evidence")) {
      const parts = url.pathname.split("/evidence");
      const subpath = parts[1] || "";
      const idMatch = subpath.match(/^\/([^\/]+)$/);
      const targetId = idMatch ? idMatch[1] : null;

      const evidenceDenied = authorizeRequest(request, this.env, RISK.MUTATE);
      if (evidenceDenied) return evidenceDenied;

      if (request.method === "GET") {
        if (targetId) {
          const item = this.getEvidence(targetId);
          if (!item) {
            return Response.json({ ok: false, error: "Evidence not found" }, { status: 404 });
          }
          return Response.json({ ok: true, data: item });
        } else {
          const queryParams = Object.fromEntries(url.searchParams.entries());
          const list = this.listEvidence(queryParams);
          return Response.json({ ok: true, data: list });
        }
      }

      if (request.method === "POST" && (!targetId || targetId === "")) {
        let body = {};
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        try {
          const created = this.createEvidence(body);
          return Response.json({ ok: true, data: created }, { status: 201 });
        } catch (err) {
          return Response.json({ ok: false, error: err.message }, { status: 400 });
        }
      }

      if (request.method === "DELETE" && targetId) {
        const deleted = this.deleteEvidence(targetId);
        if (!deleted) {
          return Response.json({ ok: false, error: "Evidence not found" }, { status: 404 });
        }
        return Response.json({ ok: true, message: "Evidence deleted successfully" });
      }

      return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
    }

    if (
      url.pathname.endsWith("/chat") &&
      request.method === "POST"
    ) {
      let body;

      try {
        body = await request.json();
      } catch {
        return Response.json(
          {
            ok: false,
            error: "Invalid JSON."
          },
          { status: 400 }
        );
      }

      const message =
        String(body.message || "").trim();

      if (!message) {
        return Response.json(
          {
            ok: false,
            error: "Message खाली है।"
          },
          { status: 400 }
        );
      }

      const intents = detectIntent(message);
      const earningIntent = detectEarningIntent(message);
      if (earningIntent.isEarningIntent) {
        intents.push("earning");
      }

      let research = null;

      if (intents.includes("web_research")) {
        const match =
          message.match(
            /https?:\/\/[^\s]+/i
          );

        if (match) {
          research =
            await researchWeb(
              this.env,
              match[0]
            );
        }
      }

      // Status is read fresh on every request so the model never receives
      // stale decision/verification/connection values.
      const status = buildEarningContext(this);

      const result = await runAI(
        this.env,
        message,
        {
          intents,
          research,
          earningIntent: earningIntent.isEarningIntent,
          status,
          voice: resolveVoiceState(this.env)
        }
      );

      const oldMessages =
        Array.isArray(this.state?.messages)
          ? this.state.messages
          : [];

      const updatedMessages = [
        ...oldMessages,
        {
          role: "user",
          content: message,
          time: new Date().toISOString()
        },
        ...(result.ok
          ? [
              {
                role: "assistant",
                content: result.answer,
                time: new Date().toISOString()
              }
            ]
          : [])
      ].slice(-40);

      this.setState({
        ...this.state,
        messages: updatedMessages
      });

      return Response.json({
        ...result,
        mode: "mastermind-agent",
        agent: "MasterMindAgent",
        intents,
        earningIntent: earningIntent.isEarningIntent,
        earningIntentReason: earningIntent.reason,
        researched: !!research?.ok,
        connectionStates: status.connections,
        voiceState: status.voice,
        memoryMessages:
          updatedMessages.length
      });
    }

    return Response.json({
      ok: true,
      agent: "MasterMindAgent",
      status: "online",
      message:
        "MasterMind Agent online है।"
    });
  }
}

/*
 * EXISTING API + AGENT ROUTER
 */

/*
 * Legacy /api/chat has no direct agent instance, so persisted status is read
 * through the DO stub. If the stub is unavailable the status is reported as
 * unavailable rather than guessed.
 */
async function buildEarningContextForEnv(env) {
  const base = {
    authority: "PERSISTED_STATE",
    connections: connectionReport(env).services.map((s) => ({
      service: s.service,
      state: s.state,
      verified: s.verified
    })),
    voice: resolveVoiceState(env).state,
    submissionPolicy: "MANUAL_OWNER_ONLY",
    earnedRevenue: "DATA NOT AVAILABLE",
    confirmedPayments: "DATA NOT AVAILABLE"
  };

  if (!env || !env.MasterMindAgent) {
    return { ...base, opportunityCount: "DATA NOT AVAILABLE", opportunities: [], ownerProfile: null };
  }

  try {
    const id = env.MasterMindAgent.idFromName("default");
    const stub = env.MasterMindAgent.get(id);
    const [oppsRes, profileRes] = await Promise.all([
      stub.fetch(new Request("http://agent/agents/master-mind-agent/default/opportunities")),
      stub.fetch(new Request("http://agent/agents/master-mind-agent/default/owner/profile"))
    ]);

    const oppsJson = await oppsRes.json();
    const profileJson = await profileRes.json();
    const rows = Array.isArray(oppsJson.data) ? oppsJson.data : [];

    return {
      ...base,
      opportunityCount: rows.length,
      opportunities: rows.slice(0, 20).map((o) => ({
        id: o.id,
        title: o.title,
        verification: normalizeVerification(o.verification_status),
        eligibility: normalizeEligibility(o.eligibility_status),
        ownerFit: normalizeOwnerFit(o.owner_fit_status),
        score: typeof o.score === "number" ? o.score : 0,
        decision: normalizeDecision(o.decision)
      })),
      ownerProfile: profileJson.data || null
    };
  } catch {
    return { ...base, opportunityCount: "DATA NOT AVAILABLE", opportunities: [], ownerProfile: null };
  }
}

async function handleAPI(request, env) {
  const url = new URL(request.url);
  const cors = (response) => applyCors(response, request, env);

  if (request.method === "OPTIONS") {
    return cors(
      new Response(null, { status: 204 })
    );
  }

  if (url.pathname.startsWith("/api/opportunities")) {
    if (!env.MasterMindAgent) {
      return cors(
        json({ ok: false, error: "MasterMindAgent binding is missing" }, 500)
      );
    }
    const id = env.MasterMindAgent.idFromName("default");
    const stub = env.MasterMindAgent.get(id);

    const subpath = url.pathname.replace(/^\/api\/opportunities/, "");
    const agentUrl = new URL(`http://agent/agents/master-mind-agent/default/opportunities${subpath}${url.search}`);
    const agentRequest = new Request(agentUrl.toString(), request);
    const agentResponse = await stub.fetch(agentRequest);
    return cors(agentResponse);
  }

  if (url.pathname === "/api/connections" && request.method === "GET") {
    return cors(json({ ok: true, data: connectionReport(env) }));
  }

  if (url.pathname === "/api/voice" && request.method === "GET") {
    return cors(
      json({ ok: true, data: { states: VOICE_STATES, ...resolveVoiceState(env) } })
    );
  }

  /*
   * Voice command flow: OWNER SPEAKS -> SPEECH PROCESSING -> AIRA UNDERSTANDS.
   * Without a verified voice provider the runtime cannot transcribe audio, so
   * the request is rejected with an explicit NOT_CONFIGURED state instead of
   * faking recognition.
   */
  if (url.pathname === "/api/voice/command" && request.method === "POST") {
    const voice = resolveVoiceState(env);

    if (voice.state !== "VOICE_ACTIVE") {
      return cors(
        json(
          {
            ok: false,
            error: "Voice is not available. Speech input cannot be processed.",
            voice,
            action: "BLOCKED"
          },
          503
        )
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return cors(json({ ok: false, error: "Invalid JSON." }, 400));
    }

    const transcript = String(body.transcript || "").trim();
    if (!transcript) {
      return cors(
        json({ ok: false, error: "No transcript supplied." }, 400)
      );
    }

    const earningIntent = detectEarningIntent(transcript);
    const args = authorizeRequest(request, env, RISK.MUTATE);
    if (args) return cors(args);

    return cors(
      json({
        ok: true,
        voice,
        transcript,
        earningIntent: earningIntent.isEarningIntent,
        earningIntentReason: earningIntent.reason,
        intents: detectIntent(transcript),
        note: "Voice execution is only performed by an authorized capability."
      })
    );
  }

  if (url.pathname === "/api/permissions" && request.method === "GET") {
    return cors(
      json({
        ok: true,
        data: {
          authorizationConfigured: hasOwnerToken(env),
          authorizationState: hasOwnerToken(env) ? "CONFIGURED" : "NOT_CONFIGURED",
          model: [
            "SERVICE",
            "CAPABILITY",
            "SCOPE",
            "RISK",
            "APPROVAL_REQUIREMENT",
            "AUTHORIZED_ACTION",
            "EXECUTION",
            "VERIFICATION",
            "AUDIT"
          ],
          rules: [
            { capability: "read opportunities/evidence/owner profile", risk: RISK.READ, approval: "NONE" },
            { capability: "create/update/delete opportunity and evidence", risk: RISK.MUTATE, approval: "OWNER_CREDENTIAL_OR_SAME_ORIGIN" },
            { capability: "owner profile update", risk: RISK.MUTATE, approval: "OWNER_CREDENTIAL_OR_SAME_ORIGIN" },
            { capability: "upwork/fiverr final submission", risk: RISK.OWNER_CONTROLLED, approval: "MANUAL_OWNER_ONLY" }
          ],
          note: "Connection does not grant capability. Authorization does not grant execution. Execution does not imply verified success."
        }
      })
    );
  }

  if (url.pathname.startsWith("/api/owner/profile")) {
    if (!env.MasterMindAgent) {
      return cors(
        json({ ok: false, error: "MasterMindAgent binding is missing" }, 500)
      );
    }
    const denied = authorizeRequest(request, env, RISK.MUTATE);
    if (denied) return cors(denied);
    const id = env.MasterMindAgent.idFromName("default");
    const stub = env.MasterMindAgent.get(id);

    const subpath = url.pathname.replace(/^\/api\/owner\/profile/, "");
    const agentUrl = new URL(`http://agent/agents/master-mind-agent/default/owner/profile${subpath}${url.search}`);
    const agentRequest = new Request(agentUrl.toString(), request);
    const agentResponse = await stub.fetch(agentRequest);
    return cors(agentResponse);
  }

  if (url.pathname.startsWith("/api/evidence")) {
    if (!env.MasterMindAgent) {
      return cors(
        json({ ok: false, error: "MasterMindAgent binding is missing" }, 500)
      );
    }
    const denied = authorizeRequest(request, env, RISK.MUTATE);
    if (denied) return cors(denied);
    const id = env.MasterMindAgent.idFromName("default");
    const stub = env.MasterMindAgent.get(id);

    const subpath = url.pathname.replace(/^\/api\/evidence/, "");
    const agentUrl = new URL(`http://agent/agents/master-mind-agent/default/evidence${subpath}${url.search}`);
    const agentRequest = new Request(agentUrl.toString(), request);
    const agentResponse = await stub.fetch(agentRequest);
    return cors(agentResponse);
  }

  if (
    url.pathname === "/api/health" &&
    request.method === "GET"
  ) {
    return cors(
      json({
        ok: true,
        service: "MasterMind AI",
        status: "online",
        version: "agent-core-4",
        aiConnected:
          !!env.AI &&
          typeof env.AI.run === "function",
        browserConnected:
          !!env.BROWSER &&
          typeof env.BROWSER.quickAction ===
            "function",
        realAgent:
          "MasterMindAgent",
        authorization: hasOwnerToken(env) ? "CONFIGURED" : "NOT_CONFIGURED",
        voice: resolveVoiceState(env).state
      })
    );
  }

  if (
    url.pathname === "/api/research" &&
    request.method === "POST"
  ) {
    let body;

    try {
      body = await request.json();
    } catch {
      return cors(
        json(
          {
            ok: false,
            error: "Invalid JSON."
          },
          400
        )
      );
    }

    const targetUrl =
      String(body.url || "").trim();

    if (!targetUrl) {
      return cors(
        json(
          {
            ok: false,
            error: "URL चाहिए।"
          },
          400
        )
      );
    }

    try {
      const parsed = new URL(targetUrl);

      if (
        parsed.protocol !== "http:" &&
        parsed.protocol !== "https:"
      ) {
        throw new Error();
      }

      const result =
        await researchWeb(
          env,
          parsed.toString()
        );

      return cors(
        json(
          result,
          result.ok ? 200 : 503
        )
      );
    } catch {
      return cors(
        json(
          {
            ok: false,
            error: "Valid HTTP/HTTPS URL दीजिए।"
          },
          400
        )
      );
    }
  }

  if (
    url.pathname === "/api/chat" &&
    request.method === "POST"
  ) {
    let body;

    try {
      body = await request.json();
    } catch {
      return cors(
        json(
          {
            ok: false,
            error: "Invalid JSON."
          },
          400
        )
      );
    }

    const message =
      String(body.message || "").trim();

    if (!message) {
      return cors(
        json(
          {
            ok: false,
            error: "Message खाली है।"
          },
          400
        )
      );
    }

    const intents =
      detectIntent(message);

    const earningIntent =
      detectEarningIntent(message);

    if (earningIntent.isEarningIntent) {
      intents.push("earning");
    }

    let research = null;

    if (
      intents.includes("web_research")
    ) {
      const match =
        message.match(
          /https?:\/\/[^\s]+/i
        );

      if (match) {
        research =
          await researchWeb(
            env,
            match[0]
          );
      }
    }

    const result =
      await runAI(
        env,
        message,
        {
          intents,
          research,
          earningIntent: earningIntent.isEarningIntent,
          status: buildEarningContextForEnv(env),
          voice: resolveVoiceState(env)
        }
      );

    return cors(
      json({
        ...result,
        mode: "legacy-api",
        intents,
        earningIntent: earningIntent.isEarningIntent,
        earningIntentReason: earningIntent.reason,
        researched:
          !!research?.ok
      })
    );
  }

  if (
    url.pathname === "/api/self-check" &&
    request.method === "GET"
  ) {
    return cors(
      json({
        ok: true,
        service: "MasterMind AI",
        checks: {
          ai_binding:
            env.AI &&
            typeof env.AI.run === "function"
              ? "PASS"
              : "NOT_CONFIGURED",

          browser_binding:
            env.BROWSER &&
            typeof env.BROWSER.quickAction ===
              "function"
              ? "PASS"
              : "NOT_CONFIGURED",

          agent_class: "PASS",

          durable_object_binding:
            env.MasterMindAgent
              ? "AVAILABLE"
              : "NOT_CONFIGURED",

          owner_authorization:
            hasOwnerToken(env)
              ? "CONFIGURED"
              : "NOT_CONFIGURED",

          voice:
            resolveVoiceState(env).state,

          api: "PASS"
        },
        connections: connectionReport(env).services
      })
    );
  }

  return null;
}

export default {
  async fetch(request, env) {
    /*
     * FIRST:
     * Route real Agent requests.
     *
     * /agents/master-mind-agent/<instance>
     */
    const agentResponse =
      await routeAgentRequest(
        request,
        env,
        { cors: true }
      );

    if (agentResponse) {
      return agentResponse;
    }

    /*
     * SECOND:
     * Existing APIs remain available.
     */
    if (
      new URL(request.url)
        .pathname
        .startsWith("/api/")
    ) {
      const response =
        await handleAPI(
          request,
          env
        );

      if (response) {
        return response;
      }
    }

    /*
     * THIRD:
     * Existing website/assets.
     */
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "MasterMind AI Agent Core online है।",
      {
        status: 200,
        headers: {
          "content-type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }
};
