const $ = (selector) => document.querySelector(selector);
const state = { session: null, personas: [], messages: [], busy: false };

function setConnection(kind, text) {
  const badge = $("#connectionBadge");
  badge.className = `connection ${kind}`;
  badge.querySelector("span").textContent = text;
}

function setNotice(kind, title, detail) {
  const notice = $("#notice");
  notice.className = `notice ${kind}`;
  notice.innerHTML = "";
  const strong = document.createElement("strong");
  const span = document.createElement("span");
  strong.textContent = title;
  span.textContent = detail;
  notice.append(strong, span);
}

function setEnabled(enabled) {
  $("#personaSelect").disabled = !enabled;
  $("#messageInput").disabled = !enabled || state.busy;
  $("#sendButton").disabled = !enabled || state.busy;
  $("#stopButton").disabled = !enabled || state.busy;
  $("#startButton").disabled = state.busy;
}

function appendBubble(role, text, extraClass = "") {
  const article = document.createElement("article");
  const paragraph = document.createElement("p");
  article.className = `bubble ${role} ${extraClass}`.trim();
  paragraph.textContent = text;
  article.append(paragraph);
  $("#messages").append(article);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return article;
}

async function getSession() {
  const response = await fetch("/api/persona-session", { credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) { location.assign("/login.html?next=/persona.html"); throw new Error("authentication_required"); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "persona_session_unavailable");
  state.session = data;
  return data;
}

async function bridge(path, options = {}, retry = true) {
  if (!state.session || Date.parse(state.session.expires_at) - Date.now() < 30_000) await getSession();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 150_000);
  try {
    const response = await fetch(`${state.session.bridge_url}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${state.session.token}`, ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && retry) { await getSession(); return bridge(path, options, false); }
    if (!response.ok) throw new Error(data.error || `bridge_http_${response.status}`);
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("request_timeout");
    throw error;
  } finally { clearTimeout(timer); }
}

function friendlyError(code) {
  return {
    persona_session_unavailable: ["연결 설정이 아직 없어요", "Vercel 환경변수와 터널 주소를 확인해 주세요."],
    FailedToFetch: ["사용자 PC에 연결할 수 없어요", "PC가 켜져 있고 로컬 브리지가 실행 중인지 확인해 주세요."],
    request_timeout: ["답변 시간이 초과됐어요", "모델을 다시 켠 뒤 한 번 더 시도해 주세요."],
    model_files_missing: ["모델 파일을 찾지 못했어요", "로컬 모델과 LoRA 어댑터 경로를 확인해 주세요."],
    model_start_failed: ["로컬 모델을 시작하지 못했어요", "GPU 메모리를 사용하는 다른 프로그램을 닫고 다시 시도해 주세요."],
    model_loading: ["로컬 모델을 불러오고 있어요", "잠시 기다린 뒤 다시 눌러 주세요."],
    rate_limited: ["요청이 너무 많아요", "잠시 기다린 뒤 다시 보내 주세요."],
    persona_not_found: ["가명 화자를 찾지 못했어요", "목록을 새로 불러온 뒤 다시 선택해 주세요."],
  }[code] || ["대화를 이어가지 못했어요", "연결 상태를 확인하고 다시 시도해 주세요."];
}

async function connect() {
  setConnection("pending", "PC 연결 확인 중");
  try {
    await getSession();
    const data = await bridge("/api/personas", { method: "GET", timeout: 12_000 });
    state.personas = data.personas || [];
    const select = $("#personaSelect");
    select.innerHTML = "";
    for (const persona of state.personas) {
      const option = document.createElement("option");
      option.value = persona.alias;
      option.textContent = `${persona.alias} · 대화 ${Number(persona.message_count).toLocaleString("ko-KR")}개`;
      select.append(option);
    }
    if (!state.personas.length) throw new Error("persona_not_found");
    setConnection("online", data.model_status === "ready" ? "모델 실행 중" : "PC 연결됨");
    setNotice("ready", "대화할 준비가 됐어요", data.model_status === "ready" ? "바로 메시지를 보낼 수 있어요." : "첫 메시지를 보내면 로컬 모델을 자동으로 켭니다.");
    setEnabled(true);
  } catch (error) {
    const [title, detail] = friendlyError(error.message === "Failed to fetch" ? "FailedToFetch" : error.message);
    setConnection("offline", "PC 연결 안 됨");
    setNotice("error", title, detail);
    setEnabled(false);
  }
}

$("#startButton").addEventListener("click", async () => {
  if (state.busy) return;
  state.busy = true;
  setEnabled(Boolean(state.personas.length));
  setConnection("pending", "PC 연결·모델 실행 중");
  setNotice("", "PC에 연결하고 모델을 켜고 있어요", "첫 실행은 최대 2분 정도 걸릴 수 있어요.");
  try {
    await getSession();
    const data = await bridge("/api/model/start", { method: "POST", body: "{}", timeout: 180_000 });
    setConnection("online", "모델 실행 중");
    setNotice("ready", "대화할 준비가 되었어요", `아무 요청이 없으면 ${data.idle_timeout_minutes}분 뒤 모델이 자동으로 꺼집니다.`);
    if (!state.personas.length) await connect();
  } catch (error) {
    const code = error.message === "Failed to fetch" ? "FailedToFetch" : error.message;
    const [title, detail] = friendlyError(code);
    setConnection("offline", "PC 연결 안 됨");
    setNotice("error", title, code === "FailedToFetch" ? "PC를 켠 뒤 이 버튼을 다시 눌러 주세요." : detail);
  } finally {
    state.busy = false;
    setEnabled(Boolean(state.personas.length));
  }
});

$("#chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#messageInput");
  const text = input.value.trim();
  const persona = $("#personaSelect").value;
  if (!text || !persona || state.busy) return;
  state.messages.push({ role: "user", content: text });
  appendBubble("user", text);
  input.value = "";
  state.busy = true;
  setEnabled(true);
  setNotice("", "로컬 모델이 답장을 만들고 있어요", "첫 실행이면 모델을 메모리에 올리는 데 최대 2분 정도 걸릴 수 있어요.");
  const pending = appendBubble("assistant", "답장을 만드는 중…", "pending");
  try {
    const data = await bridge("/api/chat", { method: "POST", body: JSON.stringify({ persona, messages: state.messages.slice(-16) }) });
    pending.remove();
    state.messages.push({ role: "assistant", content: data.reply });
    appendBubble("assistant", data.reply);
    setConnection("online", "모델 실행 중");
    setNotice("ready", "답장이 도착했어요", `아무 요청이 없으면 약 ${data.idle_timeout_minutes}분 뒤 모델이 자동으로 꺼집니다.`);
  } catch (error) {
    pending.remove();
    const [title, detail] = friendlyError(error.message === "Failed to fetch" ? "FailedToFetch" : error.message);
    setNotice("error", title, detail);
    appendBubble("assistant", `${title} ${detail}`);
  } finally { state.busy = false; setEnabled(Boolean(state.personas.length)); input.focus(); }
});

$("#clearButton").addEventListener("click", () => {
  state.messages = [];
  $("#messages").innerHTML = "";
  appendBubble("assistant", "새 대화를 시작했어요.");
});

$("#stopButton").addEventListener("click", async () => {
  if (state.busy) return;
  state.busy = true; setEnabled(true);
  try { await bridge("/api/model/stop", { method: "POST", body: "{}", timeout: 15_000 }); setConnection("online", "PC 연결됨"); setNotice("ready", "모델을 껐어요", "다음 메시지를 보내면 다시 자동으로 켭니다."); }
  catch (error) { const [title, detail] = friendlyError(error.message); setNotice("error", title, detail); }
  finally { state.busy = false; setEnabled(Boolean(state.personas.length)); }
});

$("#messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#chatForm").requestSubmit(); }
});

connect();
