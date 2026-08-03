import test from "node:test";
import assert from "node:assert/strict";
import { issuePersonaToken, verifyPersonaToken } from "../lib/persona-token.js";
import { allowedWebOrigin, buildPersonaPrompt, sanitizeModelReply, validateChatRequest } from "../examples/kakaotalk_persona/local_bridge.mjs";
import { buildStyleIndex, hasPrivateOverlap, retrieveStyleExamples } from "../lib/persona-style.js";

const secret = "test-secret-that-is-long-enough-for-hmac-123456";

test("persona token is bound to its Vercel origin and expiry", () => {
  const now = Date.parse("2026-08-01T00:00:00Z");
  const token = issuePersonaToken({ secret, origin: "https://example.vercel.app", now, ttlSeconds: 600 });
  const claims = verifyPersonaToken(token, { secret, origin: "https://example.vercel.app", now: now + 1000 });
  assert.equal(claims.origin, "https://example.vercel.app");
  assert.throws(() => verifyPersonaToken(token, { secret, origin: "https://other.vercel.app", now: now + 1000 }), /persona_origin_mismatch/);
  assert.throws(() => verifyPersonaToken(token, { secret, origin: "https://example.vercel.app", now: now + 601_000 }), /persona_token_expired/);
});

test("bridge accepts Vercel and local origins only", () => {
  assert.equal(allowedWebOrigin("https://sample.vercel.app"), true);
  assert.equal(allowedWebOrigin("http://127.0.0.1:3000"), true);
  assert.equal(allowedWebOrigin("https://sample.vercel.app.attacker.test"), false);
  assert.equal(allowedWebOrigin("http://sample.vercel.app"), false);
});

test("chat validation requires a known alias and bounded messages", () => {
  const value = validateChatRequest({ persona: "P_TEST", messages: [{ role: "user", content: "hello" }] }, new Set(["P_TEST"]));
  assert.equal(value.persona, "P_TEST");
  assert.throws(() => validateChatRequest({ persona: "P_OTHER", messages: [{ role: "user", content: "hello" }] }, new Set(["P_TEST"])), /persona_not_found/);
  assert.throws(() => validateChatRequest({ persona: "P_TEST", messages: [{ role: "system", content: "hello" }] }, new Set(["P_TEST"])), /message_invalid/);
});

test("prompt uses the training shape and reply removes the alias prefix", () => {
  const prompt = buildPersonaPrompt("P_TEST", [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }]);
  assert.match(prompt, /<CHAT room="private-web">/);
  assert.match(prompt, /USER: hello/);
  assert.match(prompt, /P_TEST: hi/);
  assert.match(prompt, /P_TEST.*\uB2F5\uC7A5/);
  assert.equal(sanitizeModelReply("P_TEST: short reply", "P_TEST"), "short reply");
  assert.throws(() => sanitizeModelReply("<think>hidden</think>", "P_TEST"), /model_reply_empty/);
});

test("local style retrieval is speaker-specific and query-aware", () => {
  const index = buildStyleIndex([
    { target: "P_TEST", query: "lunch menu", reply: "noodles sound good" },
    { target: "P_TEST", query: "weekend plan", reply: "let's rest at home" },
    { target: "P_OTHER", query: "lunch menu", reply: "salad please" },
  ], { maxPerAlias: 10 });
  const examples = retrieveStyleExamples(index, "P_TEST", "what should we eat for lunch", { limit: 1 });
  assert.deepEqual(examples, ["noodles sound good"]);
});

test("private exemplar overlap is detected before a reply leaves the PC", () => {
  const examples = ["this private phrase must never be copied verbatim"];
  assert.equal(hasPrivateOverlap("private phrase must never be copied", examples, { minLength: 12 }), true);
  assert.equal(hasPrivateOverlap("a newly written short answer", examples, { minLength: 12 }), false);
});

test("prompt can include local style evidence without changing the training transcript shape", () => {
  const prompt = buildPersonaPrompt("P_TEST", [{ role: "user", content: "hello" }], ["short informal example"]);
  assert.match(prompt, /<STYLE_EXAMPLES speaker="P_TEST">/);
  assert.match(prompt, /short informal example/);
  assert.match(prompt, /<CHAT room="private-web">/);
});

test("persona page and middleware keep the remote chat authenticated", async () => {
  const { readFile } = await import("node:fs/promises");
  const [page, client, middleware] = await Promise.all([
    readFile(new URL("../public/persona.html", import.meta.url), "utf8"),
    readFile(new URL("../public/persona.js", import.meta.url), "utf8"),
    readFile(new URL("../middleware.js", import.meta.url), "utf8"),
  ]);
  assert.match(page, /\/api\/persona-session|persona\.js/);
  assert.match(client, /authorization: `Bearer/);
  assert.match(middleware, /"\/persona\.html"/);
  assert.match(middleware, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(middleware, /status: 401/);
  assert.doesNotMatch(page + client, /PERSONA_BRIDGE_SECRET/);
});

test("Windows login startup restores the bridge, tunnel, and Vercel preview", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../examples/kakaotalk_persona/Register-PersonaBridgeStartup.ps1", import.meta.url), "utf8");
  assert.match(script, /New-ScheduledTaskTrigger\s+-AtLogOn/);
  assert.match(script, /-SyncVercel/);
  assert.match(script, /-DeployPreview/);
  assert.match(script, /Register-ScheduledTask/);
  const startScript = await readFile(new URL("../examples/kakaotalk_persona/Start-PersonaBridge.ps1", import.meta.url), "utf8");
  assert.match(startScript, /Microsoft\\WinGet\\Packages/);
});
