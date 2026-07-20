// /api/data  (GET | PUT | DELETE)   ?key=dd:<userSub>:<name>
// Optional cross-device storage backed by Cloudflare KV.
// Only used when CLOUD_STORAGE = true in index.html.
//
// Setup:
//   1) Create a KV namespace (Workers & Pages -> KV -> Create).
//   2) Bind it to this Pages project as  DEAL_DECK_KV.
//   3) Set GOOGLE_CLIENT_ID (and optional ALLOWED_* vars) as env vars.
//
// Every value is namespaced by the caller's Google user id, and a caller can
// only read/write keys that begin with their own "dd:<sub>:" prefix.
// NOTE: self-contained on purpose (no cross-file imports) so the Pages
// Functions bundle always compiles.

export async function onRequest(context) {
  const { request, env } = context;

  const gate = await verifyGoogle(request, env);
  if (gate.error) return json({ error: gate.error }, gate.status);

  if (!env.DEAL_DECK_KV)
    return json({ error: "KV namespace DEAL_DECK_KV is not bound" }, 500);

  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) return json({ error: "Missing key" }, 400);

  const prefix = "dd:" + gate.sub + ":";
  if (!key.startsWith(prefix))
    return json({ error: "Forbidden key for this account" }, 403);

  const kv = env.DEAL_DECK_KV;

  if (request.method === "GET") {
    const raw = await kv.get(key);
    if (raw == null) return json({}, 404);
    return json({ value: JSON.parse(raw) });
  }
  if (request.method === "PUT") {
    const body = await request.json();
    await kv.put(key, JSON.stringify(body.value));
    return json({ ok: true });
  }
  if (request.method === "DELETE") {
    await kv.delete(key);
    return json({ ok: true });
  }
  return json({ error: "Method not allowed" }, 405);
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