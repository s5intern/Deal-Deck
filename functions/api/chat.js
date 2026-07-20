// POST /api/chat
// Verifies the caller's Google sign-in, then forwards the request to Anthropic
// using the server-side API key. The key never reaches the browser.
//
// Required Cloudflare env vars (Settings -> Environment variables, mark as Secret):
//   ANTHROPIC_API_KEY   your Anthropic key (sk-ant-...)
//   GOOGLE_CLIENT_ID    same client ID used in index.html
// Optional:
//   ALLOWED_EMAILS      comma-separated allowlist, e.g. "a@x.com,b@x.com"
//   ALLOWED_DOMAIN      restrict to one workspace domain, e.g. "saturnfive.com"

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const gate = await verifyGoogle(request, env);
    if (gate.error) return json({ error: gate.error }, gate.status);

    if (!env.ANTHROPIC_API_KEY)
      return json({ error: "Server is missing ANTHROPIC_API_KEY" }, 500);

    const payload = await request.json();
    payload.max_tokens = Math.min(Number(payload.max_tokens) || 1500, 4096);

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
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