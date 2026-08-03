// POST /api/chat
// Verifies the caller's Google sign-in, then runs the request on Cloudflare
// Workers AI (free daily allowance, runs inside Cloudflare — no external API key).
// Returns Anthropic-shaped output { content:[{type:"text",text}] } so the client
// needs no changes.
//
// Setup:
//   1) Pages project -> Settings -> Functions -> Bindings -> add "Workers AI"
//      with the Variable name  AI
//   2) Set env var GOOGLE_CLIENT_ID (same as index.html) for the sign-in check.
// Optional env:
//   WORKERS_AI_MODEL   default "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
//   ALLOWED_EMAILS     comma-separated allowlist
//   ALLOWED_DOMAIN     restrict to one workspace domain

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const gate = await verifyGoogle(request, env);
    if (gate.error) return json({ error: gate.error }, gate.status);

    if (!env.AI)
      return json({ error: "Workers AI binding 'AI' is not configured" }, 500);

    const payload = await request.json();
    const model = env.WORKERS_AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

    // Anthropic-style body -> Workers AI chat messages (text only)
    const messages = [];
    if (payload.system) messages.push({ role: "system", content: String(payload.system) });
    for (const m of payload.messages || []) {
      const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
      messages.push({ role, content: flatten(m.content) });
    }

    let result;
    try {
      result = await env.AI.run(model, {
        messages,
        max_tokens: Math.min(Number(payload.max_tokens) || 1500, 4096),
      });
    } catch (e) {
      return json({ error: "Workers AI error: " + String(e) }, 502);
    }

    let text = result && (result.response != null ? result.response : result.text);
    if (text != null && typeof text !== "string") text = JSON.stringify(text);
    text = text || "";
    if (!text) return json({ error: "Model returned no text" }, 502);

    return json({ content: [{ type: "text", text }] });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

// Anthropic content (string | block[]) -> plain text
function flatten(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((b) => (b && b.type === "text" ? b.text || "" : "")).join("\n");
  return "";
}

async function verifyGoogle(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: "Missing sign-in token", status: 401 };

  const info = await fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token)
  ).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  if (!info || !info.sub) return { error: "Invalid sign-in token", status: 401 };
  if (env.GOOGLE_CLIENT_ID && info.aud !== env.GOOGLE_CLIENT_ID)
    return { error: "Token audience mismatch", status: 401 };
  if (info.exp && Date.now() / 1000 > Number(info.exp))
    return { error: "Sign-in expired", status: 401 };

  const email = (info.email || "").toLowerCase();
  if (env.ALLOWED_EMAILS) {
    const allow = env.ALLOWED_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.includes(email))
      return { error: "This account is not on the allowlist", status: 403 };
  }
  if (env.ALLOWED_DOMAIN) {
    const dom = env.ALLOWED_DOMAIN.toLowerCase();
    if (!email.endsWith("@" + dom)) return { error: "Domain not allowed", status: 403 };
  }
  return { sub: info.sub, email };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}