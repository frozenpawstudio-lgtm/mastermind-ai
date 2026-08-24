/**
 * MasterMind AI — Core Worker
 *
 * यह पहला backend Core है।
 * आगे इसी में:
 * - Agent Builder
 * - Project Builder
 * - Self Check / Repair
 * - Permissions
 * - GitHub
 * - Cloudflare
 * - YouTube / Facebook / WhatsApp
 * - Browser Agent
 * जोड़े जाएंगे।
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

const SYSTEM_PROMPT = `
You are MasterMind AI, a personal AI agent and project-building assistant.

Your job is to understand the user's goal and turn it into practical steps.

You can:
- understand commands in Hindi, Hinglish and English
- plan AI agents
- design applications
- create project plans
- diagnose software problems
- propose safe repairs
- plan integrations
- explain required permissions
- prepare implementation steps

Important:
- Never claim that an action was completed unless the corresponding tool actually completed it.
- Never expose secrets, passwords, OTPs or API keys.
- For destructive or irreversible actions, require user confirmation.
- For external services, use official APIs/OAuth or authorized automation where available.
- If a required tool is not connected yet, clearly say which connection is missing.
- When asked to build an AI agent, create a concrete agent specification and implementation plan.
- When asked to repair MasterMind, diagnose first, propose the repair, then test.
- Prefer safe, reversible changes.
`;

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
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");

  return new Response(response.body, {
    status: response.status,
    headers
  });
}

async function askAI(env, userMessage, mode = "chat") {

  if (!env.AI || typeof env.AI.run !== "function") {
    return {
      ok: false,
      error: "AI binding अभी connected नहीं है।",
      mode
    };
  }

  const modeInstruction = {
    chat: `
Answer the user naturally.
Understand Hindi/Hinglish.
Be practical and concise.
`,

    build_agent: `
The user wants to build an AI agent.

Return:
1. Agent name
2. Purpose
3. Required capabilities
4. Tools/integrations
5. Permissions required
6. Files/components needed
7. Build steps
8. Testing steps
9. Deployment steps

Do not claim that files were actually created unless a file-writing tool exists.
`,

    self_repair: `
The user wants MasterMind to check or repair itself.

Return:
1. What should be checked
2. Possible problems
3. Safe repair plan
4. Tests after repair
5. What requires user approval

Do not claim a repair actually happened without a repair tool.
`,

    project: `
Turn the user's request into a complete software project plan.

Include:
- objective
- architecture
- frontend
- backend
- database/storage if needed
- APIs
- permissions
- security
- testing
- deployment
- future upgrades
`
  };

  const prompt = `
${SYSTEM_PROMPT}

CURRENT MODE:
${modeInstruction[mode] || modeInstruction.chat}

USER REQUEST:
${userMessage}
`;

  try {

    const result = await env.AI.run(MODEL, {
      prompt,
      max_tokens: 1800
    });

    let answer = "";

    if (typeof result === "string") {
      answer = result;
    } else if (result && typeof result.response === "string") {
      answer = result.response;
    } else {
      answer = JSON.stringify(result);
    }

    return {
      ok: true,
      mode,
      answer
    };

  } catch (error) {

    return {
      ok: false,
      mode,
      error: "AI request में समस्या आई।",
      details: error instanceof Error ? error.message : String(error)
    };
  }
}

async function handleAPI(request, env) {

  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }));
  }

  if (url.pathname === "/api/health") {

    return cors(json({
      ok: true,
      service: "MasterMind AI",
      status: "online",
      aiConnected: !!env.AI,
      version: "core-1",
      capabilities: [
        "chat",
        "agent-planning",
        "project-planning",
        "self-check",
        "repair-planning"
      ],
      message: env.AI
        ? "MasterMind Core online है। AI binding connected है।"
        : "MasterMind Core online है, लेकिन AI binding अभी जोड़ना बाकी है।"
    }));
  }

  if (url.pathname === "/api/chat" && request.method === "POST") {

    let body;

    try {
      body = await request.json();
    } catch {
      return cors(json({
        ok: false,
        error: "Invalid JSON request."
      }, 400));
    }

    const message = String(body.message || "").trim();

    if (!message) {
      return cors(json({
        ok: false,
        error: "Message खाली है।"
      }, 400));
    }

    const result = await askAI(env, message, "chat");

    return cors(json(result, result.ok ? 200 : 503));
  }

  if (url.pathname === "/api/build-agent" && request.method === "POST") {

    let body;

    try {
      body = await request.json();
    } catch {
      return cors(json({
        ok: false,
        error: "Invalid JSON request."
      }, 400));
    }

    const requestText = String(
      body.request ||
      body.message ||
      ""
    ).trim();

    if (!requestText) {
      return cors(json({
        ok: false,
        error: "Agent की requirement बताइए।"
      }, 400));
    }

    const result = await askAI(
      env,
      requestText,
      "build_agent"
    );

    return cors(json(result, result.ok ? 200 : 503));
  }

  if (url.pathname === "/api/self-repair" && request.method === "POST") {

    let body = {};

    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const problem = String(
      body.problem ||
      body.message ||
      "MasterMind का complete self-check करो।"
    ).trim();

    const result = await askAI(
      env,
      problem,
      "self_repair"
    );

    return cors(json(result, result.ok ? 200 : 503));
  }

  if (url.pathname === "/api/project-plan" && request.method === "POST") {

    let body;

    try {
      body = await request.json();
    } catch {
      return cors(json({
        ok: false,
        error: "Invalid JSON request."
      }, 400));
    }

    const requestText = String(
      body.request ||
      body.message ||
      ""
    ).trim();

    if (!requestText) {
      return cors(json({
        ok: false,
        error: "Project requirement बताइए।"
      }, 400));
    }

    const result = await askAI(
      env,
      requestText,
      "project"
    );

    return cors(json(result, result.ok ? 200 : 503));
  }

  return null;
}

export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    /*
     * API requests पहले Worker संभालेगा।
     */

    if (url.pathname.startsWith("/api/")) {

      const response = await handleAPI(request, env);

      if (response) {
        return response;
      }
    }

    /*
     * बाकी requests static frontend को जाएँगी।
     *
     * इसके लिए अगले step में ASSETS binding
     * wrangler configuration में जोड़ी जाएगी।
     */

    if (env.ASSETS) {

      return env.ASSETS.fetch(request);
    }

    return new Response(
      "MasterMind AI Core online है। ASSETS binding अभी configure करना बाकी है।",
      {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      }
    );
  }
};
