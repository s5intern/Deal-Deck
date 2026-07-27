// POST /api/chat
// Verifies the caller's Google sign-in, then forwards the request to Google's
// Gemini API (free tier). Translates the Anthropic-style request the client
// sends into Gemini's format, and translates Gemini's reply back into
// Anthropic shape { content:[{type:"text",text}] } so the client needs no changes.
//
// Required Cloudflare env vars (Settings -> Environment variables):
//   GEMINI_API_KEY    free key from aistudio.google.com/apikey   (secret)
//   GOOGLE_CLIENT_ID  same client ID used in index.html (for sign-in check)
// Optional:
//   GEMINI_MODEL      default "gemini-2.0-flash" (must support PDFs/vision)
//   ALLOWED_EMAILS    comma-separated allowlist, e.g. "a@x.com,b@x.com"
//   ALLOWED_DOMAIN    restrict to one workspace domain, e.g. "saturnfive.com"

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const gate = await verifyGoogle(request, env);
    if (gate.error) return json({ error: gate.error }, gate.status);

    if (!env.GEMINI_API_KEY)
      return json({ error: "Server is missing GEMINI_API_KEY" }, 500);

    const payload = await request.json();
    const model = env.GEMINI_MODEL || "gemini-2.0-flash";

    // ----- translate Anthropic-style body -> Gemini body -----
    const contents = (payload.messages || []).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: toParts(m.content),
    }));

    const gemBody = {
      contents,
      generationConfig: {
        maxOutputTokens: Math.min(Number(payload.max_tokens) || 1500, 8192),
      },
    };
    if (payload.system) {
      gemBody.system_instruction = { parts: [{ text: String(payload.system) }] };
    }

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent?key=" +
      encodeURIComponent(env.GEMINI_API_KEY);

    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gemBody),
    });

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok || !data) {
      const msg = (data && data.error && data.error.message) || "Gemini request failed";
      return json({ error: msg }, upstream.status || 502);
    }

    // ----- translate Gemini reply -> Anthropic shape -----
    const cand = (data.candidates && data.candidates[0]) || null;
    const text = cand && cand.content && cand.content.parts
      ? cand.content.parts.map((p) => p.text || "").join("")
      : "";

    if (!text) {
      const reason = cand ? (cand.finishReason || "no text returned") : "no candidates";
      return json({ error: "Gemini returned no text (" + reason + ")" }, 502);
    }

    return json({ content: [{ type: "text", text }] });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

// Anthropic content (string | block[]) -> Gemini parts[]
function toParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (b.type === "text") return { text: b.text || "" };
      if (b.type === "document" && b.source && b.source.type === "base64") {
        return { inline_data: { mime_type: b.source.media_type || "application/pdf", data: b.source.data } };
      }
      if (b.type === "image" && b.source && b.source.type === "base64") {
        return { inline_data: { mime_type: b.source.media_type || "image/png", data: b.source.data } };
      }
      return { text: "" };
    });
  }
  return [{ text: "" }];
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