import { isAuthorized } from "../lib/auth.js";
import { issuePersonaToken } from "../lib/persona-token.js";

function requestOrigin(request) {
  const forwarded = String(request.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(request.headers?.["x-forwarded-host"] || request.headers?.host || "").split(",")[0].trim();
  if (!host || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) throw new Error("request_host_invalid");
  return `${forwarded === "http" ? "http" : "https"}://${host}`;
}

function bridgeUrl() {
  const value = new URL(String(process.env.PERSONA_BRIDGE_URL || ""));
  if (value.protocol !== "https:" || value.username || value.password || value.search || value.hash) {
    throw new Error("persona_bridge_url_invalid");
  }
  return value.origin;
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") return response.status(405).json({ error: "method_not_allowed" });
  if (!(await isAuthorized(request))) return response.status(401).json({ error: "authentication_required" });
  try {
    const origin = requestOrigin(request);
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const token = issuePersonaToken({ secret: process.env.PERSONA_BRIDGE_SECRET, origin, ttlSeconds: 600 });
    return response.status(200).json({ ok: true, bridge_url: bridgeUrl(), token, expires_at: new Date(expiresAt).toISOString() });
  } catch (error) {
    const code = String(error?.message || "persona_session_unavailable");
    return response.status(503).json({ error: code });
  }
}
