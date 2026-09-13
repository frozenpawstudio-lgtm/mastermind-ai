import { Agent, routeAgentRequest } from "agents";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

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

const TOOLS = {
  web_research: {
    name: "Web Research",
    connected: true
  },

  browser: {
    name: "Browser Agent",
    connected: true
  },

  github: {
    name: "GitHub",
    connected: false
  },

  cloudflare: {
    name: "Cloudflare",
    connected: false
  },

  youtube: {
    name: "YouTube",
    connected: false
  },

  facebook: {
    name: "Facebook",
    connected: false
  },

  whatsapp: {
    name: "WhatsApp",
    connected: false
  },

  files: {
    name: "Files",
    connected: false
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function cors(response) {
  const headers = new Headers(response.headers);

  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

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

  const dynamicTools = {
    ...TOOLS,
    web_research: {
      name: "Web Research",
      connected: !!(env.BROWSER && typeof env.BROWSER.quickAction === "function")
    },
    browser: {
      name: "Browser Agent",
      connected: !!(env.BROWSER && typeof env.BROWSER.quickAction === "function")
    }
  };

  const toolsText = Object.entries(dynamicTools)
    .map(
      ([key, tool]) =>
        `${key}: ${
          tool.connected
            ? "CONNECTED"
            : "NOT CONNECTED"
        }`
    )
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

  const prompt = `
${SYSTEM_PROMPT}

AVAILABLE TOOLS:
${toolsText}

DETECTED INTENTS:
${(context.intents || []).join(", ")}

${researchText}

USER REQUEST:
${userMessage}

Instructions:
- Answer in the user's language.
- Make a practical plan when the request is complex.
- If a required tool is not connected, clearly say so.
- Never pretend that an external action happened.
- If research is supplied, use only the supplied research as factual evidence.
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
        eligibility_status TEXT NOT NULL DEFAULT 'pending',
        owner_fit_status TEXT NOT NULL DEFAULT 'pending',
        score REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`;
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
      this._dbInitialized = true;
    }
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
    const updatedOpp = this.evaluateVerificationStatus(opportunityId);
    if (!updatedOpp) {
      throw new Error("Opportunity not found");
    }

    const evidenceList = this.getEvidenceForOpportunity(opportunityId);
    const factCount = evidenceList.filter(e => e.classification === "FACT").length;
    const assumptionCount = evidenceList.filter(e => e.classification === "ASSUMPTION").length;
    const hypothesisCount = evidenceList.filter(e => e.classification === "HYPOTHESIS").length;
    const hasFact = factCount > 0;

    const verificationStatus = String(updatedOpp.verification_status || "UNVERIFIED").toUpperCase();
    const eligibilityStatus = String(updatedOpp.eligibility_status || "pending").toLowerCase();
    const ownerFitStatus = String(updatedOpp.owner_fit_status || "pending").toLowerCase();

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
    if (eligibilityStatus === "ineligible") {
      factors.eligibility.points = 0;
      reasons.push("Eligibility status is ineligible.");
    } else if (eligibilityStatus === "eligible") {
      factors.eligibility.points = 30;
      reasons.push("Eligibility status is eligible.");
    } else {
      factors.eligibility.points = 0;
      reasons.push("Eligibility status is pending or unknown.");
      unknowns.push("Eligibility status is UNKNOWN / pending.");
    }

    // 3. Owner Fit scoring
    if (ownerFitStatus === "unfit") {
      factors.ownerFit.points = 0;
      reasons.push("Owner-fit status is unfit.");
    } else if (ownerFitStatus === "fit") {
      factors.ownerFit.points = 30;
      reasons.push("Owner-fit status is fit.");
    } else {
      factors.ownerFit.points = 0;
      reasons.push("Owner-fit status is pending or unknown.");
      unknowns.push("Owner-fit status is UNKNOWN / pending.");
    }

    // 4. Additional evidence tracking
    if (evidenceList.length === 0) {
      unknowns.push("No supporting evidence records found.");
    }

    const totalScore = Math.round((factors.verification.points + factors.eligibility.points + factors.ownerFit.points) * 10) / 10;

    // Implementation decision thresholds
    // SELECT threshold: score >= 80.0, VERIFIED status, hasFact evidence, eligible, fit
    // REJECT threshold: REJECTED status OR ineligible OR unfit OR score < 30.0
    // NEEDS_REVIEW threshold: missing/unknown info, unverified/partially verified status, or score 30.0..79.9
    let decision = "NEEDS_REVIEW";

    const isHardRejected = verificationStatus === "REJECTED" || eligibilityStatus === "ineligible" || ownerFitStatus === "unfit";

    if (isHardRejected) {
      decision = "REJECT";
      reasons.push("Decision threshold evaluated to REJECT due to explicit disqualification (REJECTED status, ineligible, or unfit).");
    } else if (verificationStatus === "VERIFIED" && hasFact && eligibilityStatus === "eligible" && ownerFitStatus === "fit" && totalScore >= 80.0) {
      decision = "SELECT";
      reasons.push("Decision threshold evaluated to SELECT: all verification, eligibility, and owner-fit criteria are fully satisfied.");
    } else {
      decision = "NEEDS_REVIEW";
      reasons.push("Decision threshold evaluated to NEEDS_REVIEW: key information is missing, pending, unverified, or requires Owner review.");
    }

    this.sql`UPDATE opportunities SET score = ${totalScore}, updated_at = ${new Date().toISOString()} WHERE id = ${opportunityId};`;

    return {
      opportunityId,
      decision,
      score: totalScore,
      factors,
      reasons,
      unknowns,
      verificationStatus: updatedOpp.verification_status,
      verificationLimitations: [
        "Decision engine evaluates opportunity based on existing deterministic criteria and verified evidence records only.",
        "No money was spent, no accounts were created, and no external submissions were made.",
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

    let verification_status = data.verification_status
      ? this.validateVerificationStatus(data.verification_status)
      : "UNVERIFIED";

    if (verification_status === "VERIFIED") {
      const hasFact = this.hasFactEvidence(id);
      if (!hasFact) {
        throw new Error("Cannot set status to VERIFIED without at least one FACT evidence record.");
      }
    }

    const eligibility_status = String(data.eligibility_status || "pending").trim();
    const owner_fit_status = String(data.owner_fit_status || "pending").trim();
    const score = typeof data.score === "number" ? data.score : 0;
    const created_at = data.created_at || new Date().toISOString();
    const updated_at = data.updated_at || created_at;

    this.sql`INSERT INTO opportunities (
      id, source, title, url, platform, description,
      verification_status, eligibility_status, owner_fit_status,
      score, created_at, updated_at
    ) VALUES (
      ${id}, ${source}, ${title}, ${url}, ${platform}, ${description},
      ${verification_status}, ${eligibility_status}, ${owner_fit_status},
      ${score}, ${created_at}, ${updated_at}
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
      const norm = String(filters.verification_status).trim().toUpperCase();
      rows = rows.filter(r => String(r.verification_status).toUpperCase() === norm);
    }
    if (filters.eligibility_status) {
      rows = rows.filter(r => r.eligibility_status === filters.eligibility_status);
    }
    if (filters.owner_fit_status) {
      rows = rows.filter(r => r.owner_fit_status === filters.owner_fit_status);
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

    const eligibility_status = data.eligibility_status !== undefined ? String(data.eligibility_status).trim() : existing.eligibility_status;
    const owner_fit_status = data.owner_fit_status !== undefined ? String(data.owner_fit_status).trim() : existing.owner_fit_status;
    const score = typeof data.score === "number" ? data.score : existing.score;
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

    this.evaluateVerificationStatus(opportunityId);

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

  deleteEvidence(id) {
    this.initDb();
    const existing = this.getEvidence(id);
    if (!existing) {
      return false;
    }
    const opportunityId = existing.opportunity_id;
    this.sql`DELETE FROM evidence WHERE id = ${id};`;
    if (opportunityId && this.getOpportunity(opportunityId)) {
      this.evaluateVerificationStatus(opportunityId);
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

    if (url.pathname.includes("/opportunities")) {
      const parts = url.pathname.split("/opportunities");
      const subpath = parts[1] || "";

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

    if (url.pathname.includes("/evidence")) {
      const parts = url.pathname.split("/evidence");
      const subpath = parts[1] || "";
      const idMatch = subpath.match(/^\/([^\/]+)$/);
      const targetId = idMatch ? idMatch[1] : null;

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

      const result = await runAI(
        this.env,
        message,
        {
          intents,
          research
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
        researched: !!research?.ok,
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

async function handleAPI(request, env) {
  const url = new URL(request.url);

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

  if (url.pathname.startsWith("/api/evidence")) {
    if (!env.MasterMindAgent) {
      return cors(
        json({ ok: false, error: "MasterMindAgent binding is missing" }, 500)
      );
    }
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
        version: "agent-core-3",
        aiConnected:
          !!env.AI &&
          typeof env.AI.run === "function",
        browserConnected:
          !!env.BROWSER &&
          typeof env.BROWSER.quickAction ===
            "function",
        realAgent:
          "MasterMindAgent"
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
          research
        }
      );

    return cors(
      json({
        ...result,
        mode: "legacy-api",
        intents,
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
              : "FAIL",

          browser_binding:
            env.BROWSER &&
            typeof env.BROWSER.quickAction ===
              "function"
              ? "PASS"
              : "FAIL",

          agent_class: "PASS",

          durable_object_binding:
            env.MasterMindAgent
              ? "AVAILABLE"
              : "CHECK_BINDING",

          api: "PASS"
        }
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
