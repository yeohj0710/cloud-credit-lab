import { createServer } from "node:http";
import { existsSync, openSync, closeSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyPersonaToken } from "../../lib/persona-token.js";

const root = resolve(process.env.CGR_RUNNER_ROOT || join(dirname(fileURLToPath(import.meta.url)), "../.."));
const privateDir = join(root, "etc", "kakaotalk-persona");
const artifactRoot = join(root, "artifacts", "cloud-gpu", "kakaotalk-persona");
const modelPath = join(privateDir, "models", "Qwen3-30B-A3B-Q4_K_M.gguf");
const serverPath = join(privateDir, "llama.cpp", "llama-server.exe");
const statePath = join(privateDir, "persona-bridge-state.json");
const idleMinutes = Math.min(120, Math.max(5, Number(process.env.PERSONA_IDLE_TIMEOUT_MINUTES) || 20));
const bridgeSecret = String(process.env.PERSONA_BRIDGE_SECRET || "");
const bridgePort = Math.min(65535, Math.max(1024, Number(process.env.PERSONA_BRIDGE_PORT) || 8090));
const modelPort = Math.min(65535, Math.max(1024, Number(process.env.PERSONA_MODEL_PORT) || 8080));
const rate = new Map();
let modelProcess = null;
let modelStarting = null;
let lastActivity = 0;
let lastModelError = null;

export function allowedWebOrigin(origin) {
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" && (url.hostname === "vercel.app" || url.hostname.endsWith(".vercel.app"))) ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
  } catch { return false; }
}

export function validateChatRequest(value, aliases) {
  if (!value || typeof value !== "object") throw new Error("request_invalid");
  const persona = String(value.persona || "");
  if (!aliases.has(persona)) throw new Error("persona_not_found");
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 20) throw new Error("messages_invalid");
  const messages = value.messages.map((message) => {
    const role = String(message?.role || "");
    const content = String(message?.content || "").trim();
    if (!["user", "assistant"].includes(role) || !content || content.length > 1200) throw new Error("message_invalid");
    return { role, content };
  });
  return { persona, messages };
}

export function buildPersonaPrompt(persona, messages) {
  const transcript = messages.slice(-16).map((message) => `${message.role === "assistant" ? persona : "USER"}: ${message.content}`).join("\n");
  return `<CHAT room="private-web">\n${transcript}\n</CHAT>\n${persona}\uB85C \uB2E4\uC74C \uB2F5\uC7A5\uB9CC \uC791\uC131\uD574.`;
}

export function sanitizeModelReply(value, persona) {
  let text = String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(new RegExp(`^${persona.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`), "").trim();
  if (!text) throw new Error("model_reply_empty");
  return [...text].slice(0, 500).join("");
}

function aliases() {
  const stats = JSON.parse(readFileSync(join(privateDir, "stats.json"), "utf8"));
  return Object.entries(stats.participant_turn_counts || {})
    .map(([alias, count]) => ({ alias, message_count: Number(count) || 0 }))
    .filter((item) => item.message_count >= 20)
    .sort((a, b) => b.message_count - a.message_count);
}

function adapterPath() {
  const stack = [artifactRoot];
  while (stack.length) {
    const current = stack.pop();
    if (!existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "qwen3-30b-a3b-kakao-lora-f16.gguf") return full;
    }
  }
  return "";
}

async function modelReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${modelPort}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch { return false; }
}

function modelState() {
  if (modelStarting) return "loading";
  if (modelProcess && modelProcess.exitCode == null) return "ready";
  return "offline";
}

function saveState(value) {
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(value, null, 2), "utf8");
}

function previousManagedPid() {
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8"));
    const pid = Number(value.model_pid);
    if (pid > 0) { process.kill(pid, 0); return pid; }
  } catch {}
  return 0;
}

async function waitForModel(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await modelReady()) return true;
    if (modelProcess && modelProcess.exitCode != null) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  }
  throw new Error("model_start_failed");
}

async function ensureModel() {
  lastActivity = Date.now();
  if (await modelReady()) return;
  if (modelStarting) return modelStarting;
  modelStarting = (async () => {
    const adapter = adapterPath();
    if (![serverPath, modelPath, adapter].every((path) => path && existsSync(path))) throw new Error("model_files_missing");
    const stdoutPath = join(privateDir, "persona-model.stdout.log");
    const stderrPath = join(privateDir, "persona-model.stderr.log");
    const stdout = openSync(stdoutPath, "a");
    const stderr = openSync(stderrPath, "a");
    try {
      modelProcess = spawn(serverPath, [
        "--model", modelPath,
        "--lora", adapter,
        "--ctx-size", "2048",
        "--n-gpu-layers", "40",
        "--flash-attn", "on",
        "--host", "127.0.0.1",
        "--port", String(modelPort),
      ], { cwd: root, detached: false, windowsHide: true, stdio: ["ignore", stdout, stderr] });
    } finally { closeSync(stdout); closeSync(stderr); }
    lastModelError = null;
    saveState({ bridge_pid: process.pid, model_pid: modelProcess.pid, model_started_at: new Date().toISOString(), idle_timeout_minutes: idleMinutes });
    modelProcess.once("exit", (code) => { if (code && code !== 0) lastModelError = "model_process_exited"; modelProcess = null; });
    await waitForModel();
  })();
  try { await modelStarting; }
  finally { modelStarting = null; }
}

async function terminatePid(pid) {
  if (!pid) return;
  await new Promise((resolveStop) => {
    const command = process.platform === "win32" ? "taskkill.exe" : "kill";
    const args = process.platform === "win32" ? ["/PID", String(pid), "/T", "/F"] : ["-TERM", String(pid)];
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    child.once("exit", resolveStop);
    child.once("error", resolveStop);
  });
}

async function stopModel() {
  const pid = modelProcess?.pid || previousManagedPid();
  await terminatePid(pid);
  modelProcess = null;
  modelStarting = null;
  lastActivity = 0;
  saveState({ bridge_pid: process.pid, model_pid: null, model_stopped_at: new Date().toISOString(), idle_timeout_minutes: idleMinutes });
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

function send(response, status, value, origin = "") {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "x-content-type-options": "nosniff", ...(origin ? corsHeaders(origin) : { "cache-control": "no-store" }) });
  response.end(body);
}

async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new Error("request_invalid"); }
}

function authenticate(request) {
  const origin = String(request.headers.origin || "");
  if (!allowedWebOrigin(origin)) throw new Error("persona_origin_invalid");
  const auth = String(request.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) throw new Error("persona_token_invalid");
  return { origin, claims: verifyPersonaToken(auth.slice(7), { secret: bridgeSecret, origin }) };
}

function enforceRateLimit(key) {
  const now = Date.now();
  const active = (rate.get(key) || []).filter((time) => now - time < 60_000);
  if (active.length >= 24) throw new Error("rate_limited");
  active.push(now);
  rate.set(key, active);
}

async function chat(value, personaList) {
  const parsed = validateChatRequest(value, new Set(personaList.map((item) => item.alias)));
  await ensureModel();
  const prompt = buildPersonaPrompt(parsed.persona, parsed.messages);
  const system = "\uBE44\uACF5\uAC1C \uCE74\uCE74\uC624\uD1A1 \uB300\uD654\uC758 \uB9D0\uD22C\uB97C \uC7AC\uD604\uD55C\uB2E4. \uCC38\uAC00\uC790\uB294 \uAC00\uBA85\uC73C\uB85C\uB9CC \uD45C\uC2DC\uD55C\uB2E4. \uBB38\uB9E5\uC5D0 \uC5C6\uB294 \uAC1C\uC778\uC815\uBCF4\uB098 \uC0AC\uC801 \uC0AC\uC2E4\uC744 \uCD94\uCE21\uD558\uAC70\uB098 \uACF5\uAC1C\uD558\uC9C0 \uC54A\uB294\uB2E4. \uB2F5\uC7A5\uC740 \uCE74\uCE74\uC624\uD1A1 \uD55C\uB450 \uBB38\uC7A5 \uAE38\uC774\uB85C\uB9CC \uC791\uC131\uD55C\uB2E4.";
  const response = await fetch(`http://127.0.0.1:${modelPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local-persona",
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      max_tokens: 128,
      temperature: 0.72,
      top_p: 0.85,
      repeat_penalty: 1.08,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(response.status === 503 ? "model_loading" : "model_inference_failed");
  const result = await response.json();
  lastActivity = Date.now();
  return sanitizeModelReply(result.choices?.[0]?.message?.content, parsed.persona);
}

export function createPersonaBridge() {
  if (bridgeSecret.length < 32) throw new Error("persona_bridge_secret_invalid");
  return createServer(async (request, response) => {
    const path = new URL(request.url || "/", `http://127.0.0.1:${bridgePort}`).pathname;
    if (path === "/healthz" && request.method === "GET") return send(response, 200, { ok: true });
    const origin = String(request.headers.origin || "");
    if (request.method === "OPTIONS") {
      if (!allowedWebOrigin(origin)) return send(response, 403, { error: "persona_origin_invalid" });
      response.writeHead(204, corsHeaders(origin)); return response.end();
    }
    try {
      const { claims } = authenticate(request);
      enforceRateLimit(claims.nonce);
      const personaList = aliases();
      if (path === "/api/personas" && request.method === "GET") {
        return send(response, 200, { ok: true, personas: personaList, model_status: (await modelReady()) ? "ready" : modelState(), idle_timeout_minutes: idleMinutes }, origin);
      }
      if (path === "/api/status" && request.method === "GET") {
        return send(response, 200, { ok: true, model_status: (await modelReady()) ? "ready" : modelState(), last_error: lastModelError }, origin);
      }
      if (path === "/api/model/stop" && request.method === "POST") {
        await stopModel(); return send(response, 200, { ok: true, model_status: "offline" }, origin);
      }
      if (path === "/api/chat" && request.method === "POST") {
        const reply = await chat(await bodyJson(request), personaList);
        return send(response, 200, { ok: true, reply, idle_timeout_minutes: idleMinutes }, origin);
      }
      return send(response, 404, { error: "not_found" }, origin);
    } catch (error) {
      const code = String(error?.message || "bridge_error");
      const status = code.includes("token") || code.includes("origin") ? 401 : code === "rate_limited" ? 429 : code.includes("invalid") || code.includes("not_found") || code === "request_too_large" ? 400 : 503;
      return send(response, status, { error: code }, allowedWebOrigin(origin) ? origin : "");
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(privateDir, { recursive: true });
  const bridge = createPersonaBridge();
  bridge.listen(bridgePort, "127.0.0.1", () => {
    const inheritedModelPid = previousManagedPid() || null;
    if (inheritedModelPid) lastActivity = Date.now();
    saveState({ bridge_pid: process.pid, model_pid: inheritedModelPid, bridge_started_at: new Date().toISOString(), bridge_port: bridgePort, idle_timeout_minutes: idleMinutes });
  });
  const timer = setInterval(async () => {
    if (lastActivity && Date.now() - lastActivity >= idleMinutes * 60_000 && await modelReady()) await stopModel();
  }, 30_000);
  timer.unref();
  const shutdown = async () => { clearInterval(timer); await stopModel(); bridge.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
