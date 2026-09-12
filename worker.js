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
    "GET,POST,OPTIONS"
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

  const toolsText = Object.entries(TOOLS)
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
        verification_status TEXT NOT NULL DEFAULT 'unverified',
        eligibility_status TEXT NOT NULL DEFAULT 'pending',
        owner_fit_status TEXT NOT NULL DEFAULT 'pending',
        score REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
    const verification_status = String(data.verification_status || "unverified").trim();
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
      rows = rows.filter(r => r.verification_status === filters.verification_status);
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
    const verification_status = data.verification_status !== undefined ? String(data.verification_status).trim() : existing.verification_status;
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
    this.sql`DELETE FROM opportunities WHERE id = ${id};`;
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
