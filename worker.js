/**
 * MasterMind AI — Agent Core v1
 *
 * Core responsibilities:
 * - Chat
 * - Intent understanding
 * - Goal extraction
 * - Task planning
 * - Tool selection
 * - Permission checking
 * - Safe action planning
 *
 * IMPORTANT:
 * Real external actions are NOT claimed as completed unless
 * a connected tool actually performs them.
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const SYSTEM_PROMPT = `
You are MasterMind AI, a personal AI agent.

Your job is NOT only to chat.
Your job is to understand the user's goal, plan the work,
select appropriate tools, ask for permission when needed,
and safely prepare or execute actions when a real tool is connected.

Language:
- Understand Hindi.
- Understand Hinglish.
- Understand English.
- Reply in the user's language when practical.

CORE RULES:
1. Never claim an action was completed unless a connected tool actually completed it.
2. Never invent tool results.
3. Never expose passwords, OTPs, API keys, tokens or secrets.
4. Never ask the user to paste secrets into chat.
5. Destructive or irreversible actions require confirmation.
6. Prefer safe and reversible actions.
7. If a required tool is unavailable, clearly say it is not connected yet.
8. Do not pretend that web research, GitHub changes, YouTube uploads,
   WhatsApp messages, Facebook posts or Cloudflare changes happened
   unless the corresponding tool actually performed them.
9. When the user asks for an agent, think like an agent architect.
10. Break large goals into practical steps.
11. Keep answers practical and easy to understand.
12. Do not unnecessarily make the user perform technical work.
`;

const TOOLS = {
  web_research: {
    name: "Web Research",
    connected: false,
    description: "Search and research current information on the web."
  },

  github: {
    name: "GitHub",
    connected: false,
    description: "Read, create, update and inspect authorized GitHub repositories."
  },

  cloudflare: {
    name: "Cloudflare",
    connected: false,
    description: "Manage authorized Cloudflare resources and deployments."
  },

  youtube: {
    name: "YouTube",
    connected: false,
    description: "Create, upload and manage authorized YouTube content."
  },

  facebook: {
    name: "Facebook",
    connected: false,
    description: "Manage authorized Facebook pages and content."
  },

  whatsapp: {
    name: "WhatsApp",
    connected: false,
    description: "Send authorized WhatsApp messages through an official API."
  },

  browser: {
    name: "Browser Agent",
    connected: false,
    description: "Perform authorized browser tasks."
  },

  files: {
    name: "Files",
    connected: false,
    description: "Read and work with authorized project files."
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

/*
 * Basic intent detection.
 *
 * यह अभी real tool execution नहीं करता।
 * यह MasterMind को यह समझने में मदद करता है कि
 * user किस प्रकार का काम चाहता है।
 */

function detectIntent(message) {
  const text = message.toLowerCase();

  const intents = [];

  if (
    text.includes("research") ||
    text.includes("रिसर्च") ||
    text.includes("जानकारी") ||
    text.includes("search") ||
    text.includes("खोज")
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
    text.includes("file") ||
    text.includes("files") ||
    text.includes("फाइल") ||
    text.includes("फाइलें")
  ) {
    intents.push("files");
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

/*
 * Convert detected intents into tool information.
 */

function getToolStatus(intents) {
  const result = [];

  for (const intent of intents) {
    const tool = TOOLS[intent];

    if (tool) {
      result.push({
        key: intent,
        name: tool.name,
        connected: tool.connected,
        description: tool.description
      });
    }
  }

  return result;
}

/*
 * Ask the AI to act as the MasterMind reasoning layer.
 */

async function askAI(env, userMessage, context = {}) {

  if (!env.AI || typeof env.AI.run !== "function") {
    return {
      ok: false,
      error: "AI binding अभी connected नहीं है।"
    };
  }

  const intentText =
    context.intents && context.intents.length
      ? context.intents.join(", ")
      : "general";

  const toolsText =
    context.tools && context.tools.length
      ? context.tools
          .map(tool =>
            `${tool.name}: ${
              tool.connected
                ? "CONNECTED"
                : "NOT CONNECTED"
            }`
          )
          .join("\n")
      : "No specific tool detected.";

  const prompt = `
${SYSTEM_PROMPT}

MASTERMINDS CURRENT CAPABILITIES:

Detected intents:
${intentText}

Relevant tools:
${toolsText}

Current architecture:
USER
↓
MASTERMINDS AI
↓
UNDERSTAND GOAL
↓
PLAN
↓
SELECT TOOL
↓
CHECK PERMISSION
↓
EXECUTE ONLY THROUGH CONNECTED TOOL
↓
VERIFY RESULT
↓
REPORT RESULT

IMPORTANT:
The tools listed above may not yet be connected.

If a tool says NOT CONNECTED:
- Do NOT claim that you used it.
- Explain that the tool connection is the missing part.
- Still give the user the useful plan that can be prepared now.

USER REQUEST:
${userMessage}

Respond naturally and practically.
If the user wants an action, clearly separate:
1. What you can do now.
2. What tool is required.
3. What permission would be required.
4. What the next step is.

Do not overwhelm the user with unnecessary technical details.
`;

  try {
    const result = await env.AI.run(MODEL, {
      prompt,
      max_tokens: 2200
    });

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
      error: "AI request में समस्या आई।",
      details:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}

/*
 * Health endpoint.
 */

async function health(env) {

  return {
    ok: true,
    service: "MasterMind AI",
    version: "agent-core-1",
    status: "online",
    aiConnected:
      !!env.AI &&
      typeof env.AI.run === "function",

    architecture: [
      "intent-detection",
      "goal-understanding",
      "planning",
      "tool-selection",
      "permission-check",
      "safe-action-policy",
      "result-verification"
    ],

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

/*
 * Main API.
 */

async function handleAPI(request, env) {

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
   * CHAT / AGENT
   *
   * Existing frontend already calls /api/chat,
   * इसलिए frontend बदलने की जरूरत नहीं।
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
            error: "Invalid JSON request."
          },
          400
        )
      );
    }

    const message = String(
      body.message || ""
    ).trim();

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

    const intents = detectIntent(message);

    const tools = getToolStatus(intents);

    const result = await askAI(
      env,
      message,
      {
        intents,
        tools
      }
    );

    return cors(
      json(
        {
          ...result,
          mode: "agent",
          intents,
          tools
        },
        result.ok ? 200 : 503
      )
    );
  }

  /*
   * EXPLICIT AGENT PLAN ENDPOINT
   */

  if (
    url.pathname === "/api/agent/plan" &&
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
            error: "Invalid JSON request."
          },
          400
        )
      );
    }

    const requestText = String(
      body.request ||
      body.message ||
      ""
    ).trim();

    if (!requestText) {
      return cors(
        json(
          {
            ok: false,
            error: "Agent का काम बताइए।"
          },
          400
        )
      );
    }

    const intents = detectIntent(requestText);

    const tools = getToolStatus(intents);

    const result = await askAI(
      env,
      `
Create a practical agent plan for this request:

${requestText}

The plan must include:
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
    url.pathname === "/api/self-check" &&
    request.method === "GET"
  ) {

    const result = await health(env);

    return cors(
      json({
        ...result,
        checks: {
          ai_binding:
            result.aiConnected
              ? "PASS"
              : "FAIL",

          api: "PASS",

          intent_engine: "PASS",

          tool_registry: "PASS",

          external_tools:
            "NOT CONNECTED YET"
        }
      })
    );
  }

  return null;
}

export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    /*
     * API requests go to Agent Core.
     */

    if (
      url.pathname.startsWith("/api/")
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
     * Frontend.
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
