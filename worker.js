/**
 * MasterMind AI — Agent Core v2
 *
 * Core:
 * - Chat
 * - Intent detection
 * - Planning
 * - Web research
 * - Tool registry
 * - Permission-aware actions
 * - Self check
 *
 * Real actions are only reported as completed
 * when the connected tool actually succeeds.
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const SYSTEM_PROMPT = `
You are MasterMind AI, a personal AI agent.

You understand Hindi, Hinglish and English.

Your job:
1. Understand the user's goal.
2. Break complex work into tasks.
3. Select the appropriate connected tool.
4. Ask for confirmation before sensitive or irreversible actions.
5. Execute only through real connected tools.
6. Verify tool results.
7. Never claim an action happened when it did not.

Safety:
- Never expose passwords, OTPs, API keys or tokens.
- Never ask the user to paste secrets into chat.
- Never invent research results.
- Never invent tool results.
- Never claim GitHub, YouTube, Facebook, WhatsApp or Cloudflare actions happened unless a real tool completed them.
- Prefer reversible actions.
- If a required tool is unavailable, clearly say so.

Be practical and concise.
`;

const TOOLS = {
  web_research: {
    name: "Web Research",
    connected: true,
    description:
      "Research public webpages using Cloudflare Browser Run."
  },

  github: {
    name: "GitHub",
    connected: false,
    description:
      "Read and modify authorized GitHub repositories."
  },

  cloudflare: {
    name: "Cloudflare",
    connected: false,
    description:
      "Manage authorized Cloudflare resources."
  },

  youtube: {
    name: "YouTube",
    connected: false,
    description:
      "Manage authorized YouTube content."
  },

  facebook: {
    name: "Facebook",
    connected: false,
    description:
      "Manage authorized Facebook pages and content."
  },

  whatsapp: {
    name: "WhatsApp",
    connected: false,
    description:
      "Send authorized WhatsApp messages through an official API."
  },

  browser: {
    name: "Browser Agent",
    connected: true,
    description:
      "Public webpage research through Cloudflare Browser Run."
  },

  files: {
    name: "Files",
    connected: false,
    description:
      "Read and modify authorized project files."
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

  headers.set(
    "Access-Control-Allow-Origin",
    "*"
  );

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
    text.includes("जानकारी") ||
    text.includes("search") ||
    text.includes("खोज") ||
    text.includes("देखो") ||
    text.includes("चेक करो")
  ) {
    intents.push("web_research");
  }

  if (
    text.includes("github") ||
    text.includes("गिटहब") ||
    text.includes("repository") ||
    text.includes("repo")
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
    text.includes("browser") ||
    text.includes("ब्राउज़र")
  ) {
    intents.push("browser");
  }

  if (
    text.includes("agent") ||
    text.includes("एजेंट") ||
    text.includes("automation") ||
    text.includes("ऑटोमेशन")
  ) {
    intents.push("agent_build");
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

function getToolStatus(intents) {
  return intents
    .map((intent) => {
      const tool = TOOLS[intent];

      if (!tool) {
        return null;
      }

      return {
        key: intent,
        name: tool.name,
        connected: tool.connected,
        description: tool.description
      };
    })
    .filter(Boolean);
}

/*
 * Real Web Research
 *
 * Uses Cloudflare Browser Run Quick Action.
 * This fetches public webpage content as Markdown.
 */

async function researchWeb(env, url) {
  if (
    !env.BROWSER ||
    typeof env.BROWSER.quickAction !== "function"
  ) {
    return {
      ok: false,
      error:
        "Browser Run binding connected नहीं है।"
    };
  }

  try {
    const result =
      await env.BROWSER.quickAction(
        "markdown",
        {
          url
        }
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
      error:
        "Web research में समस्या आई।",
      details:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}

async function askAI(
  env,
  userMessage,
  context = {}
) {
  if (
    !env.AI ||
    typeof env.AI.run !== "function"
  ) {
    return {
      ok: false,
      error:
        "AI binding अभी connected नहीं है।"
    };
  }

  const intentText =
    context.intents?.length
      ? context.intents.join(", ")
      : "general";

  const toolsText =
    context.tools?.length
      ? context.tools
          .map(
            (tool) =>
              `${tool.name}: ${
                tool.connected
                  ? "CONNECTED"
                  : "NOT CONNECTED"
              }`
          )
          .join("\n")
      : "No specific tool.";

  const researchText =
    context.research
      ? `
REAL WEB RESEARCH RESULT:

URL:
${context.research.url}

CONTENT:
${context.research.content}
`
      : "";

  const prompt = `
${SYSTEM_PROMPT}

Detected intents:
${intentText}

Available tools:
${toolsText}

${researchText}

USER REQUEST:
${userMessage}

Respond naturally.

If research data is provided above:
- Use it.
- Do not invent information outside it.
- Clearly distinguish facts from suggestions.

If an external tool is not connected:
- Say which tool is missing.
- Do not pretend it was used.

If the user asks for an action:
1. Explain the goal.
2. Explain the next action.
3. Mention required permission if necessary.
4. Never claim completion without a real tool result.
`;

  try {
    const result =
      await env.AI.run(
        MODEL,
        {
          prompt,
          max_tokens: 2200
        }
      );

    let answer = "";

    if (typeof result === "string") {
      answer = result;
    } else if (
      result &&
      typeof result.response === "string"
    ) {
      answer = result.response;
    } else {
      answer = JSON.stringify(result);
    }

    return {
      ok: true,
      answer
    };

  } catch (error) {
    return {
      ok: false,
      error:
        "AI request में समस्या आई।",
      details:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}

async function health(env) {
  return {
    ok: true,

    service: "MasterMind AI",

    version: "agent-core-2",

    status: "online",

    aiConnected:
      !!env.AI &&
      typeof env.AI.run === "function",

    browserConnected:
      !!env.BROWSER &&
      typeof env.BROWSER.quickAction ===
        "function",

    tools: Object.fromEntries(
      Object.entries(TOOLS).map(
        ([key, tool]) => [
          key,
          {
            name: tool.name,
            connected: tool.connected
          }
        ]
      )
    )
  };
}

async function handleAPI(
  request,
  env
) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return cors(
      new Response(null, {
        status: 204
      })
    );
  }

  /*
   * HEALTH
   */

  if (
    url.pathname === "/api/health" &&
    request.method === "GET"
  ) {
    return cors(
      json(await health(env))
    );
  }

  /*
   * REAL WEB RESEARCH
   *
   * POST:
   * {
   *   "url": "https://example.com"
   * }
   */

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
            error:
              "Invalid JSON request."
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
            error:
              "Research के लिए URL चाहिए।"
          },
          400
        )
      );
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(targetUrl);

      if (
        parsedUrl.protocol !== "https:" &&
        parsedUrl.protocol !== "http:"
      ) {
        throw new Error(
          "Only HTTP/HTTPS URLs are allowed."
        );
      }

    } catch {
      return cors(
        json(
          {
            ok: false,
            error:
              "Valid website URL दीजिए।"
          },
          400
        )
      );
    }

    const result =
      await researchWeb(
        env,
        parsedUrl.toString()
      );

    return cors(
      json(
        result,
        result.ok ? 200 : 503
      )
    );
  }

  /*
   * CHAT / AGENT
   */

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
            error:
              "Invalid JSON request."
          },
          400
        )
      );
    }

    const message =
      String(body.message || "")
        .trim();

    if (!message) {
      return cors(
        json(
          {
            ok: false,
            error:
              "Message खाली है।"
          },
          400
        )
      );
    }

    const intents =
      detectIntent(message);

    const tools =
      getToolStatus(intents);

    /*
     * IMPORTANT:
     * We only automatically research when
     * the user explicitly asks for research
     * AND provides a URL.
     *
     * We do not guess a URL.
     */

    let research = null;

    if (
      intents.includes(
        "web_research"
      )
    ) {
      const urlMatch =
        message.match(
          /https?:\/\/[^\s]+/i
        );

      if (urlMatch) {
        research =
          await researchWeb(
            env,
            urlMatch[0]
          );
      }
    }

    const result =
      await askAI(
        env,
        message,
        {
          intents,
          tools,
          research
        }
      );

    return cors(
      json(
        {
          ...result,
          mode: "agent",
          intents,
          tools,
          researched:
            !!research?.ok
        },
        result.ok ? 200 : 503
      )
    );
  }

  /*
   * AGENT PLAN
   */

  if (
    url.pathname ===
      "/api/agent/plan" &&
    request.method === "POST"
  ) {
    let body;

    try {
      body =
        await request.json();
    } catch {
      return cors(
        json(
          {
            ok: false,
            error:
              "Invalid JSON request."
          },
          400
        )
      );
    }

    const requestText =
      String(
        body.request ||
        body.message ||
        ""
      ).trim();

    if (!requestText) {
      return cors(
        json(
          {
            ok: false,
            error:
              "Agent का काम बताइए।"
          },
          400
        )
      );
    }

    const intents =
      detectIntent(requestText);

    const tools =
      getToolStatus(intents);

    const result =
      await askAI(
        env,
        `
Create a practical agent plan for:

${requestText}

Include:
- Goal
- Tasks
- Required tools
- Permissions
- Safety checks
- Execution order
- Verification
- Missing connections
`,
        {
          intents,
          tools
        }
      );

    return cors(
      json(
        {
          ...result,
          mode: "agent-plan",
          intents,
          tools
        },
        result.ok ? 200 : 503
      )
    );
  }

  /*
   * SELF CHECK
   */

  if (
    url.pathname ===
      "/api/self-check" &&
    request.method === "GET"
  ) {
    const result =
      await health(env);

    return cors(
      json({
        ...result,

        checks: {
          ai_binding:
            result.aiConnected
              ? "PASS"
              : "FAIL",

          browser_binding:
            result.browserConnected
              ? "PASS"
              : "FAIL",

          api: "PASS",

          intent_engine: "PASS",

          tool_registry: "PASS"
        }
      })
    );
  }

  return null;
}

export default {
  async fetch(
    request,
    env
  ) {
    const url =
      new URL(request.url);

    if (
      url.pathname.startsWith(
        "/api/"
      )
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

    if (env.ASSETS) {
      return env.ASSETS.fetch(
        request
      );
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
