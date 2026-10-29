import { $, el, api, storage, clock, norm, TYPE_LABEL, fmtTime, secondsLeft } from "./common.js";
import { WordCloud } from "./cloud.js";
import { AmbientMusic } from "./music.js";
import { qrSvg } from "./qr.js";
import { pop, retrigger, confetti } from "./fx.js";

const TOKEN_KEY = "wc-admin-token";
const POLL_MS = 2000;

let token = storage.get(TOKEN_KEY);
let data = null;
let questions = [];
let questionsSig = "";
let savingQuestions = 0;
let editingId = null;
let pollTimer = null;
let aiOn = storage.get("wc-ai") ?? true;
let musicOn = storage.get("wc-music") ?? true;

const music = new AmbientMusic();
const cloud = new WordCloud($("#cloud"));
const maps = { qid: null, server: {}, local: {} };
const clusterState = { busy: false, last: 0, backoffUntil: 0 };
let renderedPids = new Set();
let tableSig = "";
let lastQid = null;
let seenRows = new Set();
let celebratedEnd = false;

// ---------- join link + QR ----------
const joinUrl = location.origin + "/play";
$("#joinUrl").textContent = joinUrl.replace(/^https?:\/\//, "");
$("#joinUrl2").textContent = joinUrl.replace(/^https?:\/\//, "");
const svg = qrSvg(joinUrl);
$("#qrLobby").innerHTML = svg;
$("#qrBig").innerHTML = svg;

$("#btnCopy").addEventListener("click", async () => {
  const b = $("#btnCopy");
  try {
    await navigator.clipboard.writeText(joinUrl);
    b.textContent = "คัดลอกแล้ว";
  } catch {
    const r = document.createRange();
    r.selectNodeContents($("#joinUrl"));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    b.textContent = "กด Ctrl+C เพื่อคัดลอก";
  }
  setTimeout(() => (b.textContent = "คัดลอกลิงก์"), 2000);
});

// Browsers only allow sound after a click, so every click also unlocks audio.
document.addEventListener("pointerdown", () => {
  if (musicOn) music.unlock();
});

// ---------- login ----------
function showLogin(message) {
  stopPolling();
  token = null;
  storage.del(TOKEN_KEY);
  $("#topbar").hidden = true;
  $("#app").hidden = true;
  $("#viewLogin").hidden = false;
  const err = $("#loginError");
  err.hidden = !message;
  err.textContent = message || "";
  setTimeout(() => $("#password").focus(), 50);
}

function showApp() {
  $("#viewLogin").hidden = true;
  $("#topbar").hidden = false;
  $("#app").hidden = false;
  startPolling();
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#btnLogin");
  btn.disabled = true;
  $("#loginError").hidden = true;
  try {
    const res = await api("/login", { method: "POST", body: { password: $("#password").value } });
    token = res.token;
    storage.set(TOKEN_KEY, token);
    $("#password").value = "";
    showApp();
  } catch (err) {
    $("#loginError").textContent = err.message;
    $("#loginError").hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$("#btnLogout").addEventListener("click", () => showLogin());

// ---------- tabs ----------
function selectTab(name) {
  const stage = name === "stage";
  $("#tabStage").setAttribute("aria-selected", String(stage));
  $("#tabQuestions").setAttribute("aria-selected", String(!stage));
  $("#viewStage").hidden = !stage;
  $("#viewQuestions").hidden = stage;
  if (stage) requestAnimationFrame(() => cloud.layout());
}
$("#tabStage").addEventListener("click", () => selectTab("stage"));
$("#tabQuestions").addEventListener("click", () => selectTab("questions"));
$("#btnGoQuestions").addEventListener("click", () => selectTab("questions"));

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
  try {
    const res = await api("/admin/overview", { token });
    clock.sync(res.state.serverNow, sent, Date.now());
    data = res;
    $("#netError").hidden = true;
    if (!savingQuestions) setQuestions(res.questions);
    render();
  } catch (err) {
    if (err.status === 401) return showLogin("หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่");
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
    if (err.status === 401) return showLogin("หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่");
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
  lobby: "ล็อบบี้",
  countdown: "กำลังเริ่ม",
  live: "กำลังรับคำตอบ",
  closed: "ปิดรับคำตอบ",
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
  $("#stageLobby").hidden = phase !== "lobby";
  $("#stageLive").hidden = !inQuestion;
  $("#stageEnded").hidden = phase !== "ended";
  if (!inQuestion && document.body.classList.contains("present")) setPresent(false);

  // lobby
  const players = data.players;
  pop($("#playerCount"), players.length);
  const pids = new Set(players.map((p) => p.pid));
  const namesBox = $("#playerNames");
  if ([...renderedPids].some((p) => !pids.has(p))) {
    namesBox.textContent = "";
    renderedPids = new Set();
  }
  for (const p of players) {
    if (!renderedPids.has(p.pid)) {
      namesBox.append(el("span", { text: p.name }));
      renderedPids.add(p.pid);
    }
  }
  const qn = questions.length;
  $("#lobbyInfo").textContent = qn
    ? `ชุดคำถามมี ${qn} ข้อ เกมจะเริ่มเมื่อกด “เริ่มเกม” เท่านั้น ผู้เล่นจะเห็นคำถามพร้อมกัน`
    : "ยังไม่มีคำถาม เพิ่มคำถามในแท็บ “คำถาม” ก่อนเริ่มเกม";
  $("#btnStart").disabled = !qn;

  // question
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
      retrigger($(".qband"), "rise");
      clusterState.backoffUntil = 0;
      $("#aiNote").textContent = "";
    }
    $("#qNo").textContent = `ข้อ ${s.qIndex + 1}/${s.total} · ${TYPE_LABEL[q.type]}`;
    $("#qText").textContent = q.text;
    const last = s.qIndex + 1 >= s.total;
    $("#btnNext").textContent = last ? "จบเกม" : "ข้อถัดไป";
    $("#btnClose").disabled = phase === "closed";
    $("#btnAI").hidden = q.type === "choice";
    $("#thGroup").hidden = q.type === "choice" || !aiOn;
    cloud.setEmptyText(phase === "closed" ? "ไม่มีคำตอบสำหรับข้อนี้" : "รอคำตอบแรก…");

    const res = data.results;
    if (res && res.questionId === q.id) {
      maps.server = { ...maps.server, ...res.map };
      renderResults(q, res.answers, players.length);
      maybeCluster(q, res.answers);
    }
  }

  if (phase === "ended" && !celebratedEnd) {
    celebratedEnd = true;
    setTimeout(() => confetti({ count: 160, power: 1.2 }), 200);
  } else if (phase !== "ended") celebratedEnd = false;
  if (phase === "ended") {
    $("#endedInfo").textContent = `มีผู้เล่นทั้งหมด ${players.length} คน`;
  }

  updateMusic(phase);
  tick();
}

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
  $("#answeredCount").textContent = `ตอบแล้ว ${answers.length} จาก ${playerCount} คน`;

  const showGroup = q.type !== "choice" && aiOn;
  const rows = [...answers].reverse().map((a) => {
    const labels = [...new Set(a.values.map(labelOf))];
    return { a, labels };
  });
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
  const unmapped = answers.some((a) => a.values.some((v) => !map[norm(v)]));
  if (!unmapped) return;
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
    if (err.status === 401) return showLogin("หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่");
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
  const cd = $("#countdown");
  cd.hidden = phase !== "countdown";
  if (phase === "countdown") pop($("#countNum"), Math.max(1, secondsLeft(s.startedAt)));
  const left = phase === "countdown" ? total : secondsLeft(s.endsAt);
  $("#clockNum").textContent = phase === "closed" ? "0" : left;
  $("#clockLabel").textContent = phase === "closed" ? "หมดเวลา" : "วินาที";
  const low = phase === "live" && left <= 10;
  $("#clock").classList.toggle("low", low);
  $("#timebar").classList.toggle("low", low);
  const frac = phase === "countdown" ? 1 : Math.max(0, Math.min(1, (s.endsAt - clock.now()) / (total * 1000)));
  $("#timebarFill").style.transform = `scaleX(${frac})`;
  $("#statusText").textContent = PHASE_TEXT[phase];
  $("#btnClose").disabled = phase === "closed";
  updateMusic(phase);
}
let lastTickPhase = null;
setInterval(() => {
  const p = localPhase();
  if (p !== lastTickPhase) {
    lastTickPhase = p;
    if (data) render();
    // Pull fresh results right after the timer runs out.
    if (p === "closed" && token) setTimeout(poll, 600);
  } else tick();
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
$("#btnLobby").addEventListener("click", () => control("lobby"));
$("#btnEndedLobby").addEventListener("click", () => control("lobby"));
$("#btnRestart").addEventListener("click", () => {
  music.unlock();
  control("start");
});

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
twoStep($("#btnReset"), "ล้างผู้เล่นและคำตอบทั้งหมด", "แตะอีกครั้งเพื่อยืนยันการล้าง", () => {
  renderedPids = new Set();
  $("#playerNames").textContent = "";
  control("reset");
});

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
  if (!aiOn) $("#aiNote").textContent = "ปิด AI แล้ว ระบบนับเฉพาะคำที่เขียนเหมือนกันทุกตัวอักษร";
  else $("#aiNote").textContent = "";
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
  try {
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  } catch {
    /* optional */
  }
  setTimeout(() => cloud.layout(), 300);
}
$("#btnPresent").addEventListener("click", () => setPresent(!document.body.classList.contains("present")));
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && document.body.classList.contains("present")) setPresent(false);
});

// ---------- question manager ----------
function setQuestions(list) {
  const sig = JSON.stringify(list);
  if (sig === questionsSig) return;
  questionsSig = sig;
  questions = list;
  renderQList();
}

function renderQList() {
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
      if (editingId === q.id) resetForm();
      saveQuestions(questions.filter((x) => x.id !== q.id), "ลบคำถามแล้ว");
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
        { class: "qitem" + (editingId === q.id ? " editing" : "") },
        el("span", { class: "idx", text: i + 1 }),
        el("div", {}, el("div", { class: "qt", text: q.text }), meta),
        acts,
      ),
    );
  });
}

function move(i, d) {
  const list = [...questions];
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  saveQuestions(list, "จัดลำดับใหม่แล้ว");
}

async function saveQuestions(list, okText) {
  savingQuestions++;
  const prev = questions;
  questions = list;
  renderQList();
  try {
    const res = await api("/admin/questions", { method: "PUT", token, body: { questions: list } });
    questionsSig = "";
    savingQuestions--;
    setQuestions(res.questions);
    $("#savedNote").textContent = `${okText} · บันทึกเมื่อ ${fmtTime(Date.now())}`;
    if (data) render();
    return true;
  } catch (err) {
    savingQuestions--;
    if (err.status === 401) {
      showLogin("หมดเวลาการเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่");
      return false;
    }
    questions = prev;
    renderQList();
    $("#formError").textContent = err.message;
    $("#formError").hidden = false;
    return false;
  }
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
  editingId = q.id;
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

function resetForm() {
  editingId = null;
  $("#qForm").reset();
  $("#editorTitle").textContent = "เพิ่มคำถาม";
  $("#btnSaveQ").textContent = "เพิ่มคำถาม";
  $("#btnCancelQ").hidden = true;
  $("#formError").hidden = true;
  syncTypeFields();
  renderQList();
}
$("#btnCancelQ").addEventListener("click", resetForm);
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
  const q = {
    id: editingId || undefined,
    text,
    type,
    options: type === "choice" ? options : [],
    seconds,
    maxWords: Number($("#fMax").value),
  };
  const list = editingId ? questions.map((x) => (x.id === editingId ? { ...q, id: editingId } : x)) : [...questions, q];
  $("#btnSaveQ").disabled = true;
  const ok = await saveQuestions(list, editingId ? "แก้ไขคำถามแล้ว" : "เพิ่มคำถามแล้ว");
  $("#btnSaveQ").disabled = false;
  if (ok) resetForm();
});

// ---------- boot ----------
syncTypeFields();
if (token) showApp();
else showLogin();
