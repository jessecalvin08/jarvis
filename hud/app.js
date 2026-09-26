import { Core } from "./core.js";
import { Voice } from "./voice.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ───────────────────────────────────────── per-browser preferences
const PREFS_KEY = "jarvis.prefs";
const prefs = (() => {
  const defaults = { speak: true, wake: true, sfx: true, theme: "neural", voice: "" };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return defaults;
  }
})();
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
}

// ───────────────────────────────────────── state
const core = new Core($("core"), $("core-readout"));
core.setTheme(prefs.theme);

let hello = null;
let ws = null;
let connected = false;
let serverState = "idle";
let shownState = "";
let stateSince = Date.now();
let listening = false;
let speaking = false;
let errorUntil = 0;
let reply = "";
let lastInputWasVoice = false;
let turnOpen = false;
let engaged = false;
const cpuHistory = [];
const approvalQueue = [];

const voice = new Voice({
  lang: "en-US",
  wakeWord: "jarvis",
  onCommand: handleVoiceCommand,
  onInterim: (text) => {
    const el = $("t-user");
    el.classList.toggle("interim", !!text);
    if (text) el.textContent = text;
  },
  onListenChange: (on) => {
    listening = on;
    $("mic").classList.toggle("active", on);
    renderState();
  },
  onSpeakingChange: (on) => {
    speaking = on;
    renderState();
    // Conversation mode: after Jarvis answers a spoken request, listen for a follow-up without the wake word.
    if (!on && !turnOpen && lastInputWasVoice && approvalQueue.length === 0) voice.activate(7000);
  },
  onLevel: (v) => {
    core.setLevel(v);
    $("mic").style.setProperty("--level", v.toFixed(3));
  },
  onSpectrum: (s) => core.setSpectrum(s),
  onError: (msg) => toast(msg, "error"),
});
voice.speakEnabled = prefs.speak;
voice.wakeMode = prefs.wake;
voice.sfx = prefs.sfx;
voice.voiceName = prefs.voice;

// ───────────────────────────────────────── websocket
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => setLink(true);
  ws.onclose = () => {
    setLink(false);
    setTimeout(connect, 1500);
  };
  ws.onmessage = (m) => {
    try {
      handle(JSON.parse(m.data));
    } catch (err) {
      console.error(err);
    }
  };
}

function send(ev) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  else toast("Not connected to the Jarvis server.", "error");
}

function setLink(on) {
  connected = on;
  $("link-dot").classList.toggle("on", on);
  $("link-text").textContent = on ? "ONLINE" : "OFFLINE";
  if (!on) serverState = "idle";
  renderState();
}

function handle(ev) {
  switch (ev.type) {
    case "hello":
      return onHello(ev);
    case "state":
      serverState = ev.state;
      if (ev.state !== "idle") turnOpen = true;
      return renderState();
    case "user":
      voice.stop();
      turnOpen = true;
      reply = "";
      $("t-user").classList.remove("interim");
      $("t-user").textContent = ev.text;
      $("t-reply").textContent = "";
      logLine("user", ev.text);
      return;
    case "delta":
      reply += ev.text;
      showReply(reply);
      voice.feed(ev.text);
      return;
    case "turn_end":
      turnOpen = false;
      voice.flush();
      if (ev.text.trim()) logLine("bot", ev.text.trim());
      $("session-cost").textContent = `$${ev.sessionCostUsd.toFixed(3)}${ev.costUsd ? ` · LAST $${ev.costUsd.toFixed(3)}` : ""}`;
      if (!voice.speaking && !voice.queue.length && lastInputWasVoice && approvalQueue.length === 0) voice.activate(7000);
      return;
    case "tool_start":
      return opStart(ev);
    case "tool_end":
      return opEnd(ev);
    case "approval":
      approvalQueue.push(ev);
      if (approvalQueue.length === 1) showApproval();
      return;
    case "approval_done":
      return closeApproval(ev.id);
    case "panel":
      return showCard(ev.panel);
    case "error":
      errorUntil = Date.now() + 2500;
      core.flash();
      renderState();
      setTimeout(renderState, 2600);
      toast(ev.message, "error");
      showReply(ev.message);
      logLine("err", ev.message);
      voice.blip("error");
      if (ev.message.length < 220) voice.say(ev.message);
      return;
    case "notice":
      return toast(ev.message);
    case "announce":
      toast(`⏰ ${ev.text}`, "announce", 15000);
      voice.blip("wake");
      voice.say(ev.text);
      logLine("bot", ev.text);
      return;
    case "stats":
      return renderStats(ev.stats);
    case "inbox":
      return renderInbox(ev);
    case "memory":
      return renderMemory(ev.items);
    case "tools":
      return renderArsenal(ev.tools);
    case "reset":
      reply = "";
      $("t-user").textContent = "";
      $("t-reply").textContent = "";
      $("display").innerHTML = "";
      core.setCardsVisible(false);
      $("ops").innerHTML = "";
      toast("New conversation started.");
      return;
  }
}

function formatName(name) {
  return /^[a-z]{3,8}$/i.test(name) ? `${name.toUpperCase().split("").join(".")}.` : name.toUpperCase();
}

function onHello(h) {
  const first = !hello;
  hello = h;
  const brand = formatName(h.assistantName);
  $("brand-name").textContent = brand;
  $("boot-name").textContent = brand;
  document.title = brand;
  $("model-name").textContent = h.model;
  $("wake-hint").textContent = `“${h.wakeWord.toUpperCase()}” OR SPACE`;
  $("input").placeholder = `Type a command, or say “${h.wakeWord[0].toUpperCase()}${h.wakeWord.slice(1)}…”`;
  const banner = $("banner");
  banner.hidden = !h.setupProblem;
  banner.textContent = h.setupProblem ? `⚠ SETUP NEEDED — ${h.setupProblem}` : "";
  voice.lang = h.speechLang;
  voice.wakeWord = h.wakeWord;
  voice.wakeRe = new RegExp(`\\b(?:hey |hi |ok |okay )?${h.wakeWord}\\b[,.!?]?`, "i");
  voice.sttProvider = h.stt.provider;
  voice.ttsProvider = h.tts.provider;
  $("tts-note").textContent = {
    elevenlabs: "Speaking with your ElevenLabs voice. The browser voice is only a fallback.",
    kokoro: "Speaking with Kokoro on this computer (offline). The browser voice is only a fallback.",
    browser: "Tip: set TTS_PROVIDER=kokoro in .env for an offline British voice, or add an ElevenLabs key.",
  }[h.tts.provider];
  $("comms-status").textContent = h.gmail ? "GMAIL" : "GMAIL · OFFLINE";
  if (!h.gmail) {
    $("comms-count").textContent = "--";
    $("comms-sub").textContent = "ADD APP PASSWORD";
  }
  renderArsenal(h.tools);
  renderMemory(h.memory);
  if (h.busy) serverState = "thinking";
  renderState();
  if (first) boot(h);
}

// ───────────────────────────────────────── state rendering
const STATE_LABEL = { idle: "STANDBY", listening: "LISTENING", thinking: "THINKING", working: "EXECUTING", speaking: "SPEAKING", error: "FAULT" };

function renderState() {
  let s = serverState;
  if (speaking) s = "speaking";
  else if (listening && s === "idle") s = "listening";
  if (Date.now() < errorUntil) s = "error";
  if (!connected) s = "error";
  if (s === shownState) return;
  shownState = s;
  stateSince = Date.now();
  document.body.dataset.state = s;
  core.setState(s);
  const label = connected ? STATE_LABEL[s] : "OFFLINE";
  $("status-text").textContent = label;
  $("core-state").textContent = label;
}

function showReply(text) {
  $("t-reply").textContent = text.length > 240 ? `…${text.slice(-240).replace(/^\S*\s/, "")}` : text;
}

// ───────────────────────────────────────── operations feed + arsenal
const CATEGORY_ORDER = ["files", "apps", "system", "comms", "web", "memory", "display", "mcp"];

function renderArsenal(tools) {
  const groups = {};
  for (const t of tools) (groups[t.category] ??= []).push(t);
  const cats = Object.keys(groups).sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
  $("arsenal").innerHTML = cats
    .map(
      (c) =>
        `<div class="arsenal-group"><div class="g">${esc(c)}</div><div class="chips">${groups[c]
          .map((t) => `<span class="chip${t.risky ? " risky" : ""}" data-tool="${esc(t.name)}" title="${esc(t.description)}${t.risky ? " (asks first)" : ""}">${esc(t.name)}</span>`)
          .join("")}</div></div>`,
    )
    .join("");
  $("tool-count").textContent = `${tools.length} TOOLS · WIRED`;
}

function chip(name, cls, on) {
  document.querySelectorAll(`.chip[data-tool="${CSS.escape(name)}"]`).forEach((el) => el.classList.toggle(cls, on));
}

function opStart(ev) {
  const li = document.createElement("li");
  li.className = "op";
  li.id = `op-${ev.id}`;
  li.innerHTML = `<div class="op-head"><span class="op-name">${esc(ev.name)}</span><span class="op-status">RUNNING</span></div><div class="op-sum">${esc(ev.summary)}</div><div class="op-bar"></div>`;
  const list = $("ops");
  list.querySelector(".empty")?.remove();
  list.prepend(li);
  while (list.children.length > 12) list.lastChild.remove();
  chip(ev.name, "live", true);
  updateOpsCount();
}

function opEnd(ev) {
  let li = $(`op-${ev.id}`);
  if (!li) {
    opStart({ id: ev.id, name: ev.summary.startsWith("Declined") ? "declined" : "tool", summary: ev.summary });
    li = $(`op-${ev.id}`);
  }
  li.classList.add(ev.ok ? "done" : "fail");
  li.querySelector(".op-status").textContent = ev.ok ? `COMPLETE · ${ev.ms < 1000 ? `${ev.ms}ms` : `${(ev.ms / 1000).toFixed(1)}s`}` : "FAILED";
  li.querySelector(".op-sum").textContent = ev.summary;
  const name = li.querySelector(".op-name").textContent;
  chip(name, "live", false);
  chip(name, "hit", true);
  setTimeout(() => chip(name, "hit", false), 1200);
  updateOpsCount();
}

function updateOpsCount() {
  const running = document.querySelectorAll(".op:not(.done):not(.fail)").length;
  $("ops-count").textContent = running ? `${running} ACTIVE` : "IDLE";
}

// ───────────────────────────────────────── display cards
function showCard(panel) {
  const display = $("display");
  const key = panel.id || panel.title;
  display.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
  const card = document.createElement("div");
  card.className = `card${panel.layout === "metrics" ? " metrics" : ""}`;
  card.dataset.key = key;
  card.innerHTML = `
    <div class="card-head">
      <div><div class="card-title">${esc(panel.title)}</div>${panel.subtitle ? `<div class="card-sub">${esc(panel.subtitle)}</div>` : ""}</div>
      <button class="card-close" title="Dismiss">✕</button>
    </div>
    <div class="card-items">${panel.items
      .map(
        (i, idx) => `<div class="card-item${i.path ? " link" : ""}" data-idx="${idx}" ${i.status ? `data-status="${esc(i.status)}"` : ""} title="${esc(i.path ?? "")}">
          <span class="ci-label">${esc(i.label)}</span>${i.value ? `<span class="ci-value">${esc(i.value)}</span>` : "<span></span>"}
          ${i.detail ? `<span class="ci-detail">${esc(i.detail)}</span>` : ""}
        </div>`,
      )
      .join("")}</div>`;
  card.querySelector(".card-close").onclick = () => {
    card.remove();
    core.setCardsVisible(display.children.length > 0);
  };
  card.querySelectorAll(".card-item.link").forEach((row) => {
    row.onclick = () => {
      const item = panel.items[Number(row.dataset.idx)];
      send({ type: "open", path: item.path });
      toast(`Opening ${item.label}`);
    };
  });
  display.prepend(card);
  while (display.children.length > 3) display.lastChild.remove();
  core.setCardsVisible(true);
}

// ───────────────────────────────────────── approvals
function showApproval() {
  const a = approvalQueue[0];
  if (!a) return;
  $("approval-tool").textContent = `${a.name.replace(/_/g, " ")} · requested by ${hello?.assistantName ?? "Jarvis"}`;
  $("approval-summary").textContent = a.summary;
  $("approval-detail").textContent = a.detail;
  $("approval").hidden = false;
  voice.blip("approve");
  voice.say(`I need your authorization for that, ${hello?.userTitle ?? "sir"}.`);
  voice.activate(30000);
}

function decide(approved) {
  const a = approvalQueue[0];
  if (!a) return;
  send({ type: "approve", id: a.id, approved });
  closeApproval(a.id);
}

function closeApproval(id) {
  const idx = approvalQueue.findIndex((a) => a.id === id);
  if (idx < 0) return;
  approvalQueue.splice(idx, 1);
  if (idx === 0) {
    $("approval").hidden = true;
    voice.deactivate();
    if (approvalQueue.length) showApproval();
  }
}

$("approve-yes").onclick = () => decide(true);
$("approve-no").onclick = () => decide(false);

// ───────────────────────────────────────── voice commands
const YES = /\b(yes|yeah|yep|yup|sure|authori[sz]e[d]?|approve[d]?|do it|go ahead|confirm(ed)?|proceed|affirmative|send it)\b/i;
const NO = /\b(no|nope|deny|denied|cancel|stop|don'?t|negative|abort)\b/i;
const HUSH = /^(stop|cancel|never ?mind|shut up|quiet|be quiet|silence|that'?s all|abort)[.!]?$/i;

function handleVoiceCommand(text, { wake }) {
  if (approvalQueue.length) {
    if (YES.test(text)) return decide(true);
    if (NO.test(text)) return decide(false);
    voice.activate(20000);
    return;
  }
  if (!text) {
    // Bare wake word: acknowledge and listen.
    voice.stop();
    voice.blip("wake");
    core.flash();
    $("t-user").classList.add("interim");
    $("t-user").textContent = "…";
    return;
  }
  if (HUSH.test(text.trim())) {
    voice.stop();
    send({ type: "abort" });
    return;
  }
  lastInputWasVoice = true;
  if (wake) voice.blip("send");
  send({ type: "user", text });
}

function submitText(text) {
  if (!text.trim()) return;
  lastInputWasVoice = false;
  voice.deactivate();
  voice.blip("send");
  send({ type: "user", text });
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("input");
  submitText(input.value);
  input.value = "";
});

function toggleListen() {
  if (!engaged) return;
  if (!voice.supported) {
    toast("Voice input needs Chrome or Edge. You can still type.", "error");
    return;
  }
  if (voice.isActive()) {
    voice.deactivate();
  } else {
    voice.stop();
    voice.blip("wake");
    voice.activate(10000);
  }
}
$("mic").onclick = toggleListen;
$("core").onclick = toggleListen;
$("comms-btn").onclick = () => submitText("Check my inbox.");

document.addEventListener("keydown", (e) => {
  const typing = document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "SELECT";
  if (!engaged) {
    if (!$("engage").hidden) engage();
    return;
  }
  if (!$("approval").hidden) {
    if (e.key === "y" || e.key === "Y" || e.key === "Enter") decide(true);
    if (e.key === "n" || e.key === "N" || e.key === "Escape") decide(false);
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    if (!$("settings").hidden) return ($("settings").hidden = true);
    if (!$("drawer").hidden) return ($("drawer").hidden = true);
    voice.stop();
    voice.deactivate();
    send({ type: "abort" });
    $("input").blur();
    return;
  }
  if (typing) return;
  if (e.code === "Space") {
    e.preventDefault();
    toggleListen();
  } else if (e.key === "l" || e.key === "L") {
    $("drawer").hidden = !$("drawer").hidden;
  } else if (e.key === "/") {
    e.preventDefault();
    $("input").focus();
  }
});

// ───────────────────────────────────────── widgets
function segBar(el, fraction) {
  if (!el.children.length) el.innerHTML = "<i></i>".repeat(24);
  const on = Math.round(fraction * 24);
  [...el.children].forEach((seg, i) => {
    seg.className = i < on ? `on${fraction > 0.9 ? " hot" : fraction > 0.75 ? " warn" : ""}` : "";
  });
}

function bytes(n) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

function renderStats(s) {
  $("host-name").textContent = s.host.toUpperCase();
  $("cpu-val").textContent = `${s.cpu}%`;
  segBar($("cpu-bar"), s.cpu / 100);
  $("mem-val").textContent = `${bytes(s.memUsed)} / ${bytes(s.memTotal)}`;
  segBar($("mem-bar"), s.memUsed / s.memTotal);
  if (s.disk) {
    $("disk-label").textContent = `DISK ${s.disk.mount}`.toUpperCase();
    $("disk-val").textContent = `${bytes(s.disk.total - s.disk.used)} FREE`;
    segBar($("disk-bar"), s.disk.used / s.disk.total);
  }
  $("net-rx").textContent = s.net ? `${bytes(s.net.rx)}/s` : "—";
  $("net-tx").textContent = s.net ? `${bytes(s.net.tx)}/s` : "—";
  $("battery").textContent = s.battery ? `${Math.round(s.battery.percent)}%${s.battery.charging ? " ⚡" : ""}` : "AC";
  const h = Math.floor(s.uptime / 3600);
  $("uptime").textContent = `${Math.floor(h / 24)}d ${h % 24}h`;
  cpuHistory.push(s.cpu);
  if (cpuHistory.length > 60) cpuHistory.shift();
  drawSpark();
}

function drawSpark() {
  const c = $("cpu-spark");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== w * dpr) {
    c.width = w * dpr;
    c.height = h * dpr;
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (cpuHistory.length < 2) return;
  const step = w / 59;
  const x0 = w - (cpuHistory.length - 1) * step;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(56,214,255,0.35)");
  grad.addColorStop(1, "rgba(56,214,255,0)");
  ctx.beginPath();
  cpuHistory.forEach((v, i) => {
    const x = x0 + i * step;
    const y = h - 2 - (v / 100) * (h - 4);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = "#38d6ff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(w, h);
  ctx.lineTo(x0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

function renderInbox(ev) {
  if (ev.unread == null) {
    $("comms-count").textContent = "!";
    $("comms-sub").textContent = "LOGIN FAILED";
    return;
  }
  $("comms-count").textContent = ev.unread > 999 ? "999+" : String(ev.unread);
  $("comms-sub").textContent = "INBOX";
}

function renderMemory(items) {
  $("memory-count").textContent = `${items.length} ENTR${items.length === 1 ? "Y" : "IES"}`;
  $("memory-list").innerHTML = items.length
    ? items
        .slice(-12)
        .reverse()
        .map((f) => `<li>${esc(f)}</li>`)
        .join("")
    : `<li class="empty">Nothing yet. Say “Jarvis, remember that…”.</li>`;
}

function logLine(kind, text) {
  const div = document.createElement("div");
  div.className = `m ${kind}`;
  div.textContent = text;
  const log = $("log");
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function toast(text, kind = "", ms) {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = text;
  $("toasts").appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 400);
  }, ms ?? (kind === "error" ? 8000 : 4500));
}

function tickClock() {
  const now = new Date();
  $("clock-time").textContent = now.toLocaleTimeString("en-GB", { hour12: false });
  $("clock-date").textContent = now.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  const secs = Math.floor((Date.now() - stateSince) / 1000);
  $("status-timer").textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}
setInterval(tickClock, 1000);
tickClock();

async function loadWeather() {
  try {
    const w = await (await fetch("/api/weather")).json();
    if (w.error) return;
    $("weather").hidden = false;
    $("weather-temp").textContent = `${w.temp}°`;
    $("weather-desc").textContent = w.summary;
    $("weather-place").textContent = w.place.split(",")[0];
  } catch {
    /* offline */
  }
}
loadWeather();
setInterval(loadWeather, 15 * 60_000);

// ───────────────────────────────────────── top-bar actions, drawer, settings
$("btn-log").onclick = () => ($("drawer").hidden = !$("drawer").hidden);
$("drawer-close").onclick = () => ($("drawer").hidden = true);
$("btn-reset").onclick = () => {
  voice.stop();
  send({ type: "reset" });
  $("log").innerHTML = "";
};

function fillVoices() {
  const sel = $("set-voice");
  const voices = voice.voices();
  const current = voice.pickVoice()?.name ?? "";
  sel.innerHTML = voices.map((v) => `<option value="${esc(v.name)}"${v.name === current ? " selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`).join("");
}
speechSynthesis.onvoiceschanged = fillVoices;

$("btn-settings").onclick = () => {
  $("set-speak").checked = prefs.speak;
  $("set-wake").checked = prefs.wake;
  $("set-sfx").checked = prefs.sfx;
  $("set-theme").value = prefs.theme;
  fillVoices();
  $("settings").hidden = false;
};
$("settings-close").onclick = () => ($("settings").hidden = true);
$("set-speak").onchange = (e) => {
  prefs.speak = voice.speakEnabled = e.target.checked;
  if (!prefs.speak) voice.stop();
  savePrefs();
};
$("set-wake").onchange = (e) => {
  prefs.wake = e.target.checked;
  voice.setWakeMode(prefs.wake);
  savePrefs();
};
$("set-sfx").onchange = (e) => {
  prefs.sfx = voice.sfx = e.target.checked;
  savePrefs();
};
$("set-theme").onchange = (e) => {
  prefs.theme = e.target.value;
  core.setTheme(prefs.theme);
  savePrefs();
};
$("set-voice").onchange = (e) => {
  prefs.voice = voice.voiceName = e.target.value;
  savePrefs();
  voice.say("This is how I sound now.");
};

// ───────────────────────────────────────── boot sequence
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function boot(h) {
  const log = $("boot-log");
  const line = async (label, value, cls = "ok") => {
    const dots = ".".repeat(Math.max(2, 26 - label.length));
    log.innerHTML += `&gt; ${esc(label)} ${dots} <span class="${cls}">${esc(value)}</span>\n`;
    await sleep(170);
  };
  log.innerHTML = "";
  await line("NEURAL CORE", "ONLINE");
  await line("LANGUAGE MODEL", h.setupProblem ? "NOT CONFIGURED" : h.model.toUpperCase(), h.setupProblem ? "warn" : "ok");
  await line("TOOLS WIRED", String(h.tools.length));
  await line("MEMORY VAULT", `${h.memory.length} ENTRIES`);
  await line("GMAIL RELAY", h.gmail ? "CONNECTED" : "OFFLINE", h.gmail ? "ok" : "warn");
  await line("VOICE SYNTHESIS", { elevenlabs: "ELEVENLABS", kokoro: "KOKORO · LOCAL", browser: "BROWSER" }[h.tts.provider], "ok");
  await line(
    "SPEECH RECOGNITION",
    !voice.supported ? "UNSUPPORTED - USE CHROME/EDGE" : h.stt.provider === "local" ? "WHISPER · LOCAL" : "BROWSER",
    voice.supported ? "ok" : "warn",
  );
  $("engage").hidden = false;
  $("boot-hint").textContent = "CLICK OR PRESS ANY KEY · ENABLES MICROPHONE AND AUDIO";
}

async function engage() {
  if (engaged) return;
  engaged = true;
  $("boot").classList.add("gone");
  await voice.init();
  if (voice.supported) voice.start();
  const hour = new Date().getHours();
  const part = hour < 5 ? "evening" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const title = hello?.userTitle ?? "sir";
  const greet = hello?.setupProblem
    ? `Good ${part}, ${title}. I'm online, but I need a language model configured before I can help. The details are on screen.`
    : `Good ${part}, ${title}. All systems are online.`;
  showReply(greet);
  voice.say(greet);
}
$("engage").onclick = engage;

connect();
setTimeout(() => {
  if (!hello) $("boot-log").innerHTML = `&gt; CONNECTING TO JARVIS SERVER .......... <span class="warn">WAITING</span>\n`;
}, 1200);
