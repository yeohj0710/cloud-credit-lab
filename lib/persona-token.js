import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issuePersonaToken({ secret, origin, now = Date.now(), ttlSeconds = 600 }) {
  if (String(secret || "").length < 32) throw new Error("persona_bridge_secret_invalid");
  const normalizedOrigin = new URL(origin).origin;
  const payload = encode({
    aud: "persona-bridge",
    origin: normalizedOrigin,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + Math.min(900, Math.max(60, Number(ttlSeconds) || 600)),
    nonce: randomBytes(12).toString("base64url"),
  });
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyPersonaToken(token, { secret, origin, now = Date.now() }) {
  if (String(secret || "").length < 32) throw new Error("persona_bridge_secret_invalid");
  const [payload, received, extra] = String(token || "").split(".");
  if (!payload || !received || extra) throw new Error("persona_token_invalid");
  const expected = sign(payload, secret);
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("persona_token_invalid");
  let value;
  try { value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new Error("persona_token_invalid"); }
  if (value.aud !== "persona-bridge") throw new Error("persona_token_invalid");
  if (!Number.isFinite(value.exp) || value.exp <= Math.floor(now / 1000)) throw new Error("persona_token_expired");
  if (new URL(value.origin).origin !== new URL(origin).origin) throw new Error("persona_origin_mismatch");
  return value;
}
