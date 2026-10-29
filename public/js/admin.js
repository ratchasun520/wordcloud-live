import { $, el, api, storage, clock, norm, TYPE_LABEL, fmtTime, secondsLeft } from "./common.js";
import { WordCloud } from "./cloud.js";
import { AmbientMusic } from "./music.js";
import { qrSvg } from "./qr.js";
import { pop, retrigger, confetti } from "./fx.js";

const TOKEN_KEY = "wc-admin-token";
const POLL_MS = 2000;
const ADVANCE_LABEL = { manual: "ผู้ดูแลกดเลื่อนเอง", auto: "เลื่อนอัตโนมัติ" };

// The admin must enter the password on every visit. The token lives only in this
// tab (sessionStorage) and is kept only when the page is reloaded, so a projector
// refresh mid-game does not log out, but opening /admin again always asks.
const session = {
  get() {
    try {
      return JSON.parse(sessionStorage.getItem(TOKEN_KEY));
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
  del() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode */
    }
  },
};
storage.del(TOKEN_KEY); // tokens saved by older versions in localStorage
const navType = (performance.getEntriesByType?.("navigation")[0] || {}).type;
if (navType !== "reload") session.del();
let token = session.get();
let data = null;
let pollTimer = null;
let aiOn = storage.get("wc-ai") ?? true;
let musicOn = storage.get("wc-music") ?? true;

// settings state
let projects = [];
let selectedId = storage.get("wc-selected-project");
let projectsSig = "";
let saving = 0;
let saveVersion = 0;
let editingQid = null;

const music = new AmbientMusic();
const cloud = new WordCloud($("#cloud"));
const namesCloud = new WordCloud($("#namesCloud"), { sizeFloor: 0.5 });
namesCloud.setEmptyText("");
const maps = { qid: null, server: {}, local: {} };
const clusterState = { busy: false, last: 0, backoffUntil: 0 };
let tableSig = "";
let lastQid = null;
let seenRows = new Set();
let celebratedEnd = false;

// ---------- join links + QR: one per project ----------
const joinUrlFor = (projectId) => `${location.origin}/play?p=${encodeURIComponent(projectId)}`;
const shortUrl = (u) => u.replace(/^https?:\/\//, "");
const qrCache = new Map();
const qrFor = (url) => {
  if (!qrCache.has(url)) qrCache.set(url, qrSvg(url));
  return qrCache.get(url);
};
let lobbyQrFor = null;
let lobbyUrl = "";
function setLobbyQr(projectId) {
  if (!projectId || projectId === lobbyQrFor) return;
  lobbyQrFor = projectId;
  lobbyUrl = joinUrlFor(projectId);
  $("#joinUrl").textContent = shortUrl(lobbyUrl);
  $("#joinUrl2").textContent = shortUrl(lobbyUrl);
  $("#qrLobby").innerHTML = qrFor(lobbyUrl);
  $("#qrBig").innerHTML = qrFor(lobbyUrl);
}

async function copyText(btn, text, selectEl) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "คัดลอกแล้ว";
  } catch {
    const r = document.createRange();
    r.selectNodeContents(selectEl);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    btn.textContent = "กด Ctrl+C เพื่อคัดลอก";
  }
  setTimeout(() => (btn.textContent = label), 2000);
}
$("#btnCopy").addEventListener("click", () => copyText($("#btnCopy"), lobbyUrl, $("#joinUrl")));
$("#btnCopyProject").addEventListener("click", () =>
  copyText($("#btnCopyProject"), joinUrlFor(selected().id), $("#projectLink")),
);

// Browsers only allow sound after a click, so every click also unlocks audio.
document.addEventListener("pointerdown", () => {
  if (musicOn) music.unlock();
});

// ---------- login ----------
const loginCard = $("#loginForm");
const loginDemo = (() => {
  // A small live cloud on the login panel, so the page shows what it controls.
  const WORDS = [
    ["ความยั่งยืน", 9], ["สุขภาพจิต", 8], ["ความเท่าเทียม", 6], ["การวิจัย", 6], ["ชุมชน", 5],
    ["ความเข้าใจ", 5], ["การรับฟัง", 4], ["ข้อมูล", 4], ["นวัตกรรม", 3], ["ความร่วมมือ", 4],
    ["จิตวิทยา", 6], ["ความหวัง", 3], ["การเรียนรู้", 3], ["ความปลอดภัย", 2], ["AI", 2],
  ];
  const bag = WORDS.flatMap(([w, n]) => Array(n).fill(w));
  let cloudObj = null;
  let timer = null;
  let counts = new Map();
  let votes = 0;
  const vote = () => {
    if (votes >= 55) {
      counts = new Map();
      votes = 0;
    }
    const w = bag[Math.floor(Math.random() * bag.length)];
    counts.set(w, (counts.get(w) || 0) + 1);
    votes++;
    cloudObj.update([...counts].map(([text, count]) => ({ text, count })));
  };
  return {
    start() {
      if (!cloudObj) {
        cloudObj = new WordCloud($("#loginCloud"));
        cloudObj.setEmptyText("");
        for (let i = 0; i < 16; i++) vote();
      }
      if (!timer && !matchMedia("(prefers-reduced-motion: reduce)").matches) timer = setInterval(vote, 1500);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
})();

// Gentle parallax on the login panel.
$("#loginVisual").addEventListener("pointermove", (e) => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width - 0.5;
  const y = (e.clientY - r.top) / r.height - 0.5;
  $(".lv-blobs").style.transform = `translate(${x * -30}px, ${y * -30}px)`;
  $("#loginCloud").style.transform = `translate(${x * 12}px, ${y * 12}px)`;
});

function showLogin(message) {
  stopPolling();
  token = null;
  session.del();
  document.body.classList.add("logged-out");
  $("#topbar").hidden = true;
  $("#app").hidden = true;
  const shell = $("#viewLogin");
  shell.classList.remove("leaving");
  loginCard.classList.remove("leaving", "unlocked", "shake");
  shell.hidden = false;
  const err = $("#loginError");
  err.hidden = !message;
  err.textContent = message || "";
  loginDemo.start();
  setTimeout(() => $("#password").focus(), 50);
}
function showApp() {
  loginDemo.stop();
  document.body.classList.remove("logged-out");
  $("#viewLogin").hidden = true;
  $("#topbar").hidden = false;
  $("#app").hidden = false;
  selectTab("settings");
  startPolling();
}

$("#btnShowPw").addEventListener("click", () => {
  const input = $("#password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("#btnShowPw").setAttribute("aria-pressed", String(show));
  $("#btnShowPw").setAttribute("aria-label", show ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน");
  input.focus();
});
const capsCheck = (e) => {
  if (typeof e.getModifierState === "function") $("#capsNote").hidden = !e.getModifierState("CapsLock");
};
$("#password").addEventListener("keydown", capsCheck);
$("#password").addEventListener("keyup", capsCheck);
const expired = () => showLogin("หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่");

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#btnLogin");
  const err = $("#loginError");
  if (!$("#password").value) {
    err.textContent = "กรุณาใส่รหัสผ่าน";
    err.hidden = false;
    retrigger(loginCard, "shake");
    $("#password").focus();
    return;
  }
  btn.classList.add("loading");
  btn.querySelector(".lbl").textContent = "กำลังตรวจสอบ…";
  err.hidden = true;
  try {
    const res = await api("/login", { method: "POST", body: { password: $("#password").value } });
    token = res.token;
    session.set(token);
    $("#password").value = "";
    // Unlock animation, then into the app.
    loginCard.classList.add("unlocked", "leaving");
    $("#viewLogin").classList.add("leaving");
    btn.querySelector(".lbl").textContent = "ยินดีต้อนรับ";
    const wait = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 850;
    setTimeout(showApp, wait);
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
    retrigger(loginCard, "shake");
    $("#password").select();
  } finally {
    btn.classList.remove("loading");
    setTimeout(() => (btn.querySelector(".lbl").textContent = "เข้าสู่ระบบ"), 900);
  }
});
$("#btnLogout").addEventListener("click", () => showLogin());

// ---------- tabs ----------
function selectTab(name) {
  const stage = name === "stage";
  $("#tabStage").setAttribute("aria-selected", String(stage));
  $("#tabSettings").setAttribute("aria-selected", String(!stage));
  $("#viewStage").hidden = !stage;
  $("#viewSettings").hidden = stage;
  if (stage) requestAnimationFrame(() => cloud.layout());
}
$("#tabStage").addEventListener("click", () => selectTab("stage"));
$("#tabSettings").addEventListener("click", () => selectTab("settings"));
$("#btnGoStage").addEventListener("click", () => selectTab("stage"));

// ---------- polling ----------
function startPolling() {
  stopPolling();
  poll();
}
function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}
async function poll() {
  clearTimeout(pollTimer);
  if (!token) return;
  const sent = Date.now();
  const version = saveVersion;
  try {
    const res = await api("/admin/overview", { token });
    clock.sync(res.state.serverNow, sent, Date.now());
    data = res;
    $("#netError").hidden = true;
    // Skip project data that was read before our latest save finished.
    if (!saving && version === saveVersion) setProjects(res.projects);
    render();
  } catch (err) {
    if (err.status === 401) return expired();
    $("#netError").textContent = err.message;
    $("#netError").hidden = false;
  }
  pollTimer = setTimeout(poll, document.hidden ? POLL_MS * 2 : POLL_MS);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && token) poll();
});

async function control(action, extra = {}) {
  try {
    await api("/admin/control", { method: "POST", token, body: { action, ...extra } });
  } catch (err) {
    if (err.status === 401) return expired();
    $("#netError").textContent = err.message;
    $("#netError").hidden = false;
  }
  await poll();
}

// ---------- phase helpers ----------
function localPhase() {
  if (!data) return "lobby";
  const s = data.state;
  if (!["countdown", "live", "closed"].includes(s.phase)) return s.phase;
  const now = clock.now();
  if (now < s.startedAt) return "countdown";
  if (now <= s.endsAt) return "live";
  return "closed";
}
const PHASE_TEXT = {
  idle: "ยังไม่เปิดห้อง",
  lobby: "เปิดห้องรอผู้เข้าร่วม",
  countdown: "กำลังเริ่ม",
  live: "กำลังรับคำตอบ",
  closed: "แสดงผลลัพธ์",
  ended: "จบเกม",
};

// ---------- render ----------
function render() {
  if (!data) return;
  const phase = localPhase();
  const s = data.state;
  $("#statusText").textContent = PHASE_TEXT[phase] || phase;
  $("#statusChip").classList.toggle("live", phase === "live" || phase === "countdown");

  const inQuestion = ["countdown", "live", "closed"].includes(phase);
  const roomOpen = phase !== "idle";
  // The main screen exists only once a project's room has been opened.
  $("#tabStage").hidden = !roomOpen;
  if (!roomOpen && !$("#viewStage").hidden) selectTab("settings");
  setLobbyQr(s.projectId);
  $("#stageLobby").hidden = phase !== "lobby";
  $("#stageLive").hidden = !inQuestion;
  $("#stageEnded").hidden = phase !== "ended";

  renderLobby();

  if (inQuestion && s.question) {
    const q = s.question;
    if (q.id !== lastQid) {
      lastQid = q.id;
      cloud.clear();
      maps.qid = q.id;
      maps.server = {};
      maps.local = {};
      tableSig = "";
      seenRows = new Set();
      clusterState.backoffUntil = 0;
      $("#aiNote").textContent = "";
      retrigger($(".qband"), "rise");
    }
    $("#qNo").textContent = `ข้อ ${s.qIndex + 1}/${s.total} · ${TYPE_LABEL[q.type]}`;
    $("#qText").textContent = q.text;
    const last = s.qIndex + 1 >= s.total;
    $("#btnNext").textContent = last ? "จบเกม" : s.advance === "auto" ? "ข้ามไปข้อถัดไป" : "ข้อถัดไป";
    $("#btnAI").hidden = q.type === "choice";
    $("#thGroup").hidden = q.type === "choice" || !aiOn;
    cloud.setEmptyText(phase === "closed" ? "ไม่มีคำตอบสำหรับข้อนี้" : "รอคำตอบแรก…");

    const res = data.results;
    if (res && res.questionId === q.id) {
      maps.server = { ...maps.server, ...res.map };
      renderResults(q, res.answers, data.players.length);
      maybeCluster(q, res.answers);
    }
  }

  if (phase === "ended" && !celebratedEnd) {
    celebratedEnd = true;
    setTimeout(() => confetti({ count: 160, power: 1.2 }), 200);
  } else if (phase !== "ended") celebratedEnd = false;
  if (phase === "ended") {
    $("#endedInfo").textContent = `ผู้เข้าร่วม ${data.players.length} คน`;
  }
  if (!inQuestion && phase !== "lobby" && document.body.classList.contains("present")) setPresent(false);

  if (!$("#viewSettings").hidden) renderLaunch();
  updateMusic(phase);
  tick();
}

const GHOST_WORDS = ["ยินดีต้อนรับ", "สแกน QR", "ใส่ชื่อ", "ร่วมสนุก", "พร้อมไหม", "เข้าร่วมเลย", "รอคุณอยู่", "สวัสดี"];
function hashName(t) {
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}
let namesSig = null;
function renderLobby() {
  const players = data.players;
  pop($("#playerCount"), players.length);
  const sig = players.map((p) => p.pid + p.name).join("|");
  if (sig !== namesSig) {
    namesSig = sig;
    const box = $("#namesCloud");
    if (players.length) {
      box.classList.remove("ghost");
      // Same name twice grows a little; otherwise sizes vary gently for rhythm.
      const counts = new Map();
      for (const p of players) counts.set(p.name, (counts.get(p.name) || 0) + 1);
      namesCloud.update([...counts].map(([text, n]) => ({ text, count: n * 3 + (hashName(text) % 3) })));
    } else {
      box.classList.add("ghost");
      namesCloud.update(GHOST_WORDS.map((text, i) => ({ text, count: 1 + ((i * 7) % 4) })));
    }
    const list = $("#playerNames");
    list.textContent = "";
    for (const p of players) list.append(el("li", { text: p.name }));
  }
  $("#namesEmpty").hidden = players.length > 0;
  $("#btnStart").disabled = phaseOfData() !== "lobby";
}
const phaseOfData = () => (data ? localPhase() : "idle");

function effectiveMap() {
  return { ...maps.local, ...maps.server };
}

function buildWords(q, answers) {
  const rawCounts = new Map();
  for (const a of answers) {
    for (const v of a.values) {
      const k = norm(v);
      if (!rawCounts.has(k)) rawCounts.set(k, new Map());
      const m = rawCounts.get(k);
      m.set(v, (m.get(v) || 0) + 1);
    }
  }
  const canonical = (k) => [...rawCounts.get(k).entries()].sort((x, y) => y[1] - x[1])[0][0];
  const map = effectiveMap();
  const labelOf = (v) => {
    if (q.type === "choice") return v;
    const k = norm(v);
    return (aiOn && map[k]) || canonical(k);
  };
  const groups = new Map();
  for (const a of answers) {
    for (const v of a.values) {
      const label = labelOf(v);
      const lk = norm(label);
      if (!groups.has(lk)) groups.set(lk, { text: label, players: new Set() });
      groups.get(lk).players.add(a.pid);
    }
  }
  const words = [...groups.values()].map((g) => ({
    text: g.text.length > 38 ? g.text.slice(0, 36) + "…" : g.text,
    count: g.players.size,
  }));
  return { words, labelOf };
}

function renderResults(q, answers, playerCount) {
  const { words, labelOf } = buildWords(q, answers);
  cloud.update(words);
  const countText = `ตอบแล้ว ${answers.length} จาก ${playerCount} คน`;
  $("#answeredCount").textContent = countText;
  $("#answeredBadge").textContent = countText;

  const showGroup = q.type !== "choice" && aiOn;
  const rows = [...answers].reverse().map((a) => ({ a, labels: [...new Set(a.values.map(labelOf))] }));
  const sig = JSON.stringify([showGroup, rows.map((r) => [r.a.pid, r.a.values, r.labels])]);
  if (sig === tableSig) return;
  tableSig = sig;
  const body = $("#answerRows");
  body.textContent = "";
  if (!rows.length) {
    body.append(el("tr", {}, el("td", { colspan: 4, class: "muted", text: "ยังไม่มีคำตอบ" })));
    return;
  }
  for (const { a, labels } of rows) {
    const groupCell = el("td", { hidden: !showGroup });
    labels.forEach((l, i) => {
      if (i) groupCell.append(" ");
      groupCell.append(el("span", { class: "grp", text: l }));
    });
    const fresh = !seenRows.has(a.pid);
    seenRows.add(a.pid);
    body.append(
      el(
        "tr",
        { class: fresh ? "row-new" : null },
        el("td", { class: "t", text: fmtTime(a.at) }),
        el("td", { class: "n", text: a.name }),
        el("td", { text: a.values.join(" · ") }),
        groupCell,
      ),
    );
  }
}

async function maybeCluster(q, answers) {
  if (!aiOn || q.type === "choice") return;
  const now = Date.now();
  if (clusterState.busy || now - clusterState.last < 4000 || now < clusterState.backoffUntil) return;
  const map = maps.server;
  if (!answers.some((a) => a.values.some((v) => !map[norm(v)]))) return;
  clusterState.busy = true;
  clusterState.last = now;
  const qid = q.id;
  try {
    const res = await api("/admin/cluster", { method: "POST", token, body: { questionId: qid } });
    if (maps.qid !== qid) return;
    const note = $("#aiNote");
    if (res.error) {
      maps.local = res.map;
      clusterState.backoffUntil = Date.now() + 20000;
      note.textContent = `AI ขัดข้องชั่วคราว (${res.error}) จึงรวมเฉพาะคำที่สะกดคล้ายกันไปก่อน จะลองใหม่อัตโนมัติ`;
      note.classList.add("err");
    } else {
      maps.server = { ...maps.server, ...res.map };
      maps.local = {};
      note.classList.remove("err");
      if (res.source === "ai") note.textContent = "AI จัดกลุ่มคำที่ความหมายเหมือนกันให้แล้ว คำในกลุ่มเดียวกันจะนับรวมกัน";
      else if (res.source === "local" && !data.aiAvailable)
        note.textContent = "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ระบบจึงรวมเฉพาะคำที่สะกดคล้ายกัน";
      if (res.pending > 0) clusterState.last = 0;
    }
    render();
  } catch (err) {
    if (err.status === 401) return expired();
    clusterState.backoffUntil = Date.now() + 15000;
  } finally {
    clusterState.busy = false;
  }
}

// ---------- clock (runs between polls) ----------
function tick() {
  if (!data) return;
  const phase = localPhase();
  const s = data.state;
  if (!["countdown", "live", "closed"].includes(phase)) return;
  const total = s.question ? s.question.seconds : 1;
  $("#countdown").hidden = phase !== "countdown";
  // The question stays hidden until the countdown ends.
  $("#qText").classList.toggle("veiled", phase === "countdown");
  if (phase === "countdown") {
    $("#countLabel").textContent = `คำถามข้อที่ ${s.qIndex + 1} กำลังจะเริ่ม`;
    pop($("#countNum"), Math.max(1, secondsLeft(s.startedAt)));
  }
  let num;
  let label;
  if (phase === "countdown") {
    num = total;
    label = "วินาที";
  } else if (phase === "live") {
    num = secondsLeft(s.endsAt);
    label = "วินาที";
  } else if (s.nextAt) {
    num = secondsLeft(s.nextAt);
    label = s.qIndex + 1 >= s.total ? "วินาทีก่อนจบเกม" : "วินาทีก่อนข้อถัดไป";
  } else {
    num = 0;
    label = "หมดเวลา";
  }
  $("#clockNum").textContent = num;
  $("#clockLabel").textContent = label;
  const low = phase === "live" && num <= 10;
  $("#clock").classList.toggle("low", low);
  $("#timebar").classList.toggle("low", low);
  const frac = phase === "countdown" ? 1 : Math.max(0, Math.min(1, (s.endsAt - clock.now()) / (total * 1000)));
  $("#timebarFill").style.transform = `scaleX(${frac})`;
  $("#statusText").textContent = PHASE_TEXT[phase];
  $("#btnClose").disabled = phase === "closed";
  updateMusic(phase);
}
let lastTickPhase = null;
let fastPollFor = 0;
setInterval(() => {
  const p = localPhase();
  if (p !== lastTickPhase) {
    lastTickPhase = p;
    if (data) render();
    if (p === "closed" && token) setTimeout(poll, 600);
  } else tick();
  // Auto mode: ask the server right when the results pause is over.
  if (data && data.state.nextAt && clock.now() > data.state.nextAt + 200 && token && fastPollFor !== data.state.nextAt) {
    fastPollFor = data.state.nextAt;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 100);
  }
}, 250);

// ---------- music ----------
function updateMusic(phase) {
  const want = musicOn && phase === "live";
  if (want && !music.playing) {
    if (music.ctx) music.play();
  } else if (!want && music.playing) music.stop();
  const btn = $("#btnMusic");
  btn.classList.toggle("on", musicOn);
  btn.setAttribute("aria-pressed", String(musicOn));
  btn.textContent = musicOn && want && !music.ready ? "เพลงเบาๆ (แตะเพื่อเปิดเสียง)" : "เพลงเบาๆ";
}

// ---------- stage controls ----------
$("#btnStart").addEventListener("click", () => {
  music.unlock();
  control("start");
});
$("#btnNext").addEventListener("click", () => control("next"));
$("#btnClose").addEventListener("click", () => control("close"));
$("#btnExtend").addEventListener("click", () => control("extend", { seconds: 15 }));

function twoStep(btn, label, confirmLabel, action) {
  let armed = null;
  btn.addEventListener("click", () => {
    if (armed) {
      clearTimeout(armed);
      armed = null;
      btn.classList.remove("confirm");
      btn.textContent = label;
      action();
      return;
    }
    btn.classList.add("confirm");
    btn.textContent = confirmLabel;
    armed = setTimeout(() => {
      armed = null;
      btn.classList.remove("confirm");
      btn.textContent = label;
    }, 4000);
  });
}
const stopGame = async () => {
  if (document.body.classList.contains("present")) setPresent(false);
  await control("stop");
  selectTab("settings");
};
const clearPlayers = () => control("clear");
twoStep($("#btnStop"), "หยุดเกม", "แตะอีกครั้ง: หยุดและล้างข้อมูล", stopGame);
twoStep($("#btnEndedStop"), "หยุดเกมและล้างข้อมูล", "แตะอีกครั้งเพื่อยืนยัน", stopGame);
twoStep($("#btnClearLobby"), "ล้างรายชื่อผู้เข้าร่วม", "แตะอีกครั้งเพื่อล้าง", clearPlayers);

function setToggle(btn, on) {
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
}
setToggle($("#btnAI"), aiOn);
$("#btnAI").addEventListener("click", () => {
  aiOn = !aiOn;
  storage.set("wc-ai", aiOn);
  setToggle($("#btnAI"), aiOn);
  tableSig = "";
  cloud.sig = "";
  $("#aiNote").classList.remove("err");
  $("#aiNote").textContent = aiOn ? "" : "ปิด AI แล้ว ระบบนับเฉพาะคำที่เขียนเหมือนกันทุกตัวอักษร";
  render();
});
$("#btnMusic").addEventListener("click", () => {
  musicOn = !musicOn;
  storage.set("wc-music", musicOn);
  if (musicOn) music.unlock();
  updateMusic(localPhase());
});

$("#btnQR").addEventListener("click", () => {
  $("#qrOverlay").hidden = false;
  $("#btnCloseQR").focus();
});
$("#btnCloseQR").addEventListener("click", () => ($("#qrOverlay").hidden = true));
$("#qrOverlay").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("#qrOverlay").hidden = true;
    if (document.body.classList.contains("present")) setPresent(false);
  }
});

function setPresent(on) {
  document.body.classList.toggle("present", on);
  $("#btnPresent").textContent = on ? "ออกจากเต็มจอ" : "เต็มจอ";
  $("#btnPresentLobby").textContent = on ? "ออกจากเต็มจอ" : "เต็มจอ";
  try {
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  } catch {
    /* optional */
  }
  setTimeout(() => cloud.layout(), 300);
}
const togglePresent = () => setPresent(!document.body.classList.contains("present"));
$("#btnPresent").addEventListener("click", togglePresent);
$("#btnPresentLobby").addEventListener("click", togglePresent);
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && document.body.classList.contains("present")) setPresent(false);
});

// ================= settings: projects =================
function setProjects(list) {
  const sig = JSON.stringify(list);
  if (sig === projectsSig) return;
  projectsSig = sig;
  projects = list;
  if (!projects.some((p) => p.id === selectedId)) selectedId = (openProjectId() || (projects[0] && projects[0].id));
  renderSettings();
}
const openProjectId = () => (data && data.state.phase !== "idle" ? data.state.projectId : null);

const selected = () => projects.find((p) => p.id === selectedId) || projects[0];
const gameRunning = () => data && ["countdown", "live", "closed"].includes(localPhase());

function note(text, isError) {
  const n = $("#projectNote");
  n.textContent = text;
  n.style.color = isError ? "var(--warn)" : "";
}

async function saveProjects(list, okText) {
  saving++;
  saveVersion++;
  const prev = projects;
  projects = list;
  renderSettings();
  try {
    const res = await api("/admin/projects", { method: "PUT", token, body: { projects: list } });
    saving--;
    saveVersion++;
    projectsSig = "";
    setProjects(res.projects);
    note(`${okText} · บันทึกเมื่อ ${fmtTime(Date.now())}`);
    $("#savedNote").textContent = `${okText} · บันทึกเมื่อ ${fmtTime(Date.now())}`;
    if (data) renderLobby();
    return true;
  } catch (err) {
    saving--;
    if (err.status === 401) {
      expired();
      return false;
    }
    projects = prev;
    projectsSig = "";
    renderSettings();
    note(err.message, true);
    $("#formError").textContent = err.message;
    $("#formError").hidden = false;
    return false;
  }
}

function updateSelected(patch, okText) {
  const p = selected();
  const list = projects.map((x) => (x.id === p.id ? { ...x, ...patch } : x));
  return saveProjects(list, okText);
}

function renderSettings() {
  const sel = selected();
  if (!sel) return;
  selectedId = sel.id;
  storage.set("wc-selected-project", selectedId);

  // project list
  const box = $("#projectList");
  box.textContent = "";
  for (const p of projects) {
    const item = el(
      "button",
      { type: "button", class: "pitem", role: "option", "aria-selected": String(p.id === selectedId) },
      el("b", { text: p.name }),
      el(
        "small",
        {},
        `${p.questions.length} คำถาม · ${ADVANCE_LABEL[p.settings.advance]}`,
        p.id === openProjectId() ? el("span", { class: "live-tag", text: " · เปิดห้องอยู่" }) : null,
      ),
    );
    item.addEventListener("click", () => {
      selectedId = p.id;
      if (editingQid) resetForm(false);
      renderSettings();
    });
    box.append(item);
  }

  // project form
  const nameInput = $("#pName");
  if (document.activeElement !== nameInput) nameInput.value = sel.name;
  document.querySelector(`input[name="pAdvance"][value="${sel.settings.advance}"]`).checked = true;
  $("#pResultWrap").hidden = sel.settings.advance !== "auto";
  if (document.activeElement !== $("#pResult")) $("#pResult").value = sel.settings.resultSeconds;
  $("#btnDelProject").disabled = projects.length <= 1 || sel.id === openProjectId();
  renderLaunch();
  renderQList();
}

let launchSig = "";
function renderLaunch() {
  const sel = selected();
  if (!sel) return;
  const url = joinUrlFor(sel.id);
  const openId = openProjectId();
  const isOpen = sel.id === openId;
  const busyOther = !!openId && !isOpen && gameRunning();
  const sig = [sel.id, isOpen, busyOther, sel.questions.length, openId].join("|");
  if (sig === launchSig) return;
  launchSig = sig;
  $("#projectQr").innerHTML = qrFor(url);
  $("#projectLink").textContent = shortUrl(url);
  $("#openBadge").hidden = !isOpen;
  $("#btnOpenProject").hidden = isOpen;
  $("#btnGoStage").hidden = !isOpen;
  $("#btnOpenProject").disabled = busyOther || !sel.questions.length;
  const note = $("#launchNote");
  if (!sel.questions.length) note.textContent = "เพิ่มคำถามอย่างน้อย 1 ข้อก่อนเริ่มเกม";
  else if (busyOther) note.textContent = "มีโปรเจกต์อื่นกำลังเล่นอยู่ กดหยุดเกมนั้นก่อน";
  else if (isOpen) note.textContent = "ห้องนี้เปิดอยู่ ผู้เล่นสแกน QR นี้เพื่อเข้าร่วมได้";
  else if (openId) note.textContent = "เริ่มเกมโปรเจกต์นี้จะปิดห้องที่เปิดอยู่ และล้างรายชื่อผู้เข้าร่วมเดิม";
  else note.textContent = "ผู้เล่นสแกน QR นี้ได้ตั้งแต่ตอนนี้ และจะเข้าห้องเองเมื่อกดเริ่มเกม";
}

$("#btnOpenProject").addEventListener("click", async () => {
  const id = selected().id;
  music.unlock();
  try {
    await api("/admin/control", { method: "POST", token, body: { action: "open", projectId: id } });
  } catch (err) {
    if (err.status === 401) return expired();
    note(err.message, true);
    return;
  }
  launchSig = "";
  await poll();
  selectTab("stage");
});

$("#pName").addEventListener("change", () => {
  const name = $("#pName").value.trim();
  if (!name) {
    $("#pName").value = selected().name;
    return;
  }
  updateSelected({ name }, "เปลี่ยนชื่อโปรเจกต์แล้ว");
});
document.querySelectorAll('input[name="pAdvance"]').forEach((r) =>
  r.addEventListener("change", () => {
    const sel = selected();
    updateSelected({ settings: { ...sel.settings, advance: r.value } }, `ตั้งเป็น “${ADVANCE_LABEL[r.value]}” แล้ว`);
  }),
);
$("#pResult").addEventListener("change", () => {
  const sel = selected();
  const v = Math.min(120, Math.max(3, Math.round(Number($("#pResult").value) || 10)));
  $("#pResult").value = v;
  updateSelected({ settings: { ...sel.settings, resultSeconds: v } }, "บันทึกเวลาแสดงผลแล้ว");
});
$("#btnNewProject").addEventListener("click", async () => {
  const p = { name: `โปรเจกต์ใหม่ ${projects.length + 1}`, questions: [], settings: { advance: "manual", resultSeconds: 10 } };
  const before = new Set(projects.map((x) => x.id));
  const ok = await saveProjects([...projects, p], "สร้างโปรเจกต์ใหม่แล้ว");
  if (ok) {
    const created = projects.find((x) => !before.has(x.id));
    if (created) {
      selectedId = created.id;
      renderSettings();
      $("#pName").focus();
      $("#pName").select();
    }
  }
});
$("#btnDupProject").addEventListener("click", async () => {
  const src = selected();
  const copy = {
    name: `${src.name} (สำเนา)`.slice(0, 60),
    questions: src.questions.map(({ id, ...q }) => q),
    settings: { ...src.settings },
  };
  const before = new Set(projects.map((x) => x.id));
  const ok = await saveProjects([...projects, copy], "ทำสำเนาโปรเจกต์แล้ว");
  if (ok) {
    const created = projects.find((x) => !before.has(x.id));
    if (created) {
      selectedId = created.id;
      renderSettings();
    }
  }
});
twoStep($("#btnDelProject"), "ลบโปรเจกต์", "ยืนยันลบโปรเจกต์", () => {
  const sel = selected();
  const list = projects.filter((p) => p.id !== sel.id);
  if (!list.length) return;
  selectedId = list[0].id;
  saveProjects(list, `ลบ “${sel.name}” แล้ว`);
});

// ================= settings: questions of the selected project =================
function renderQList() {
  const sel = selected();
  const questions = sel.questions;
  $("#qCount").textContent = `(${questions.length} ข้อ)`;
  const box = $("#qList");
  box.textContent = "";
  if (!questions.length) {
    box.append(el("p", { class: "muted", style: "padding:16px", text: "ยังไม่มีคำถาม เพิ่มคำถามแรกจากแบบฟอร์ม" }));
  }
  questions.forEach((q, i) => {
    const meta = el(
      "div",
      { class: "meta" },
      el("span", { class: "chip", text: TYPE_LABEL[q.type] }),
      el("span", { class: "chip", text: `${q.seconds} วินาที` }),
      q.type === "wordcloud" ? el("span", { class: "chip", text: `ส่งได้ ${q.maxWords} คำ` }) : null,
      q.type === "choice" ? el("span", { class: "chip", text: `${q.options.length} ตัวเลือก` }) : null,
    );
    const del = el("button", { class: "btn danger small", type: "button", text: "ลบ" });
    twoStep(del, "ลบ", "ยืนยันลบ", () => {
      if (editingQid === q.id) resetForm(false);
      updateSelected({ questions: questions.filter((x) => x.id !== q.id) }, "ลบคำถามแล้ว");
    });
    const acts = el(
      "div",
      { class: "acts" },
      el("button", {
        class: "btn ghost small",
        type: "button",
        text: "ขึ้น",
        "aria-label": `เลื่อนข้อ ${i + 1} ขึ้น`,
        disabled: i === 0,
        onclick: () => move(i, -1),
      }),
      el("button", {
        class: "btn ghost small",
        type: "button",
        text: "ลง",
        "aria-label": `เลื่อนข้อ ${i + 1} ลง`,
        disabled: i === questions.length - 1,
        onclick: () => move(i, 1),
      }),
      el("button", { class: "btn ghost small", type: "button", text: "แก้ไข", onclick: () => editQuestion(q) }),
      del,
    );
    box.append(
      el(
        "div",
        { class: "qitem" + (editingQid === q.id ? " editing" : "") },
        el("span", { class: "idx", text: i + 1 }),
        el("div", {}, el("div", { class: "qt", text: q.text }), meta),
        acts,
      ),
    );
  });
}

function move(i, d) {
  const list = [...selected().questions];
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  updateSelected({ questions: list }, "จัดลำดับใหม่แล้ว");
}

function currentType() {
  return document.querySelector('input[name="fType"]:checked').value;
}
function syncTypeFields() {
  const t = currentType();
  $("#fOptionsWrap").hidden = t !== "choice";
  $("#fMaxWrap").hidden = t !== "wordcloud";
}
document.querySelectorAll('input[name="fType"]').forEach((r) => r.addEventListener("change", syncTypeFields));

function editQuestion(q) {
  editingQid = q.id;
  $("#editorTitle").textContent = "แก้ไขคำถาม";
  $("#btnSaveQ").textContent = "บันทึกการแก้ไข";
  $("#btnCancelQ").hidden = false;
  $("#fText").value = q.text;
  document.querySelector(`input[name="fType"][value="${q.type}"]`).checked = true;
  $("#fOptions").value = (q.options || []).join("\n");
  $("#fSeconds").value = q.seconds;
  $("#fMax").value = String(q.maxWords || 3);
  $("#formError").hidden = true;
  syncTypeFields();
  renderQList();
  $("#fText").focus();
}

function resetForm(rerender = true) {
  editingQid = null;
  $("#qForm").reset();
  $("#editorTitle").textContent = "เพิ่มคำถาม";
  $("#btnSaveQ").textContent = "เพิ่มคำถาม";
  $("#btnCancelQ").hidden = true;
  $("#formError").hidden = true;
  syncTypeFields();
  if (rerender) renderQList();
}
$("#btnCancelQ").addEventListener("click", () => resetForm());
$("#btnNewQ").addEventListener("click", () => {
  resetForm();
  $("#fText").focus();
});

$("#qForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#formError");
  err.hidden = true;
  const type = currentType();
  const text = $("#fText").value.trim();
  const options = $("#fOptions")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const seconds = Number($("#fSeconds").value);
  const problems = [];
  if (!text) problems.push("ใส่ข้อความคำถาม");
  if (type === "choice" && (options.length < 2 || options.length > 8)) problems.push("ใส่ตัวเลือก 2–8 ข้อ บรรทัดละ 1 ข้อ");
  if (!(seconds >= 10 && seconds <= 600)) problems.push("ตั้งเวลาตอบระหว่าง 10–600 วินาที");
  if (problems.length) {
    err.textContent = "กรุณา" + problems.join(" และ");
    err.hidden = false;
    return;
  }
  const q = { text, type, options: type === "choice" ? options : [], seconds, maxWords: Number($("#fMax").value) };
  const wasEditing = editingQid;
  const current = selected().questions;
  const list = wasEditing ? current.map((x) => (x.id === wasEditing ? { ...q, id: wasEditing } : x)) : [...current, q];
  // Clear the form right away so the next question can be typed while this one saves.
  resetForm(false);
  const ok = await updateSelected({ questions: list }, wasEditing ? "แก้ไขคำถามแล้ว" : "เพิ่มคำถามแล้ว");
  if (!ok && !$("#fText").value) {
    if (wasEditing) editQuestion({ ...q, id: wasEditing });
    else {
      $("#fText").value = q.text;
      document.querySelector(`input[name="fType"][value="${q.type}"]`).checked = true;
      $("#fOptions").value = q.options.join("\n");
      $("#fSeconds").value = q.seconds;
      $("#fMax").value = String(q.maxWords);
      syncTypeFields();
    }
    $("#formError").hidden = false;
  }
});

// ---------- boot ----------
syncTypeFields();
if (token) showApp();
else showLogin();
