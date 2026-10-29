import { $, $$, el, api, storage, clock, secondsLeft } from "./common.js";
import { AmbientMusic } from "./music.js";

const KEY = "wc-player";
const POLL_MS = 2000;

let me = storage.get(KEY) || null; // { pid, name, sessionId }
let st = null; // last /state
let formFor = null; // question key the answer form was built for
let choice = null;
let pollTimer = null;
let sending = false;
let renaming = false;
let musicOn = false;
const music = new AmbientMusic();

const screens = ["sJoin", "sWait", "sCount", "sQuestion", "sSent", "sEnded"];
function show(id) {
  for (const s of screens) $("#" + s).hidden = s !== id;
}

function netError(msg) {
  $("#netError").textContent = msg || "";
  $("#netError").hidden = !msg;
}

// ---------- polling ----------
async function poll() {
  clearTimeout(pollTimer);
  const sent = Date.now();
  try {
    const q = me && me.pid ? `?pid=${encodeURIComponent(me.pid)}` : "";
    const res = await api("/state" + q);
    clock.sync(res.serverNow, sent, Date.now());
    st = res;
    netError("");
    if (me && (me.sessionId !== res.sessionId || !res.joined)) {
      // The admin reset the game: join again with the same name.
      const name = me.name;
      me = null;
      storage.set(KEY, { name });
      $("#name").value = name || "";
    }
    render();
  } catch (err) {
    netError(err.message);
  }
  const fast = st && (localPhase() === "countdown" || localPhase() === "live");
  pollTimer = setTimeout(poll, document.hidden ? POLL_MS * 3 : fast ? 1500 : POLL_MS);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});

function localPhase() {
  if (!st) return "lobby";
  if (!["countdown", "live", "closed"].includes(st.phase)) return st.phase;
  const now = clock.now();
  if (now < st.startedAt) return "countdown";
  if (now <= st.endsAt) return "live";
  return "closed";
}

// ---------- render ----------
function render() {
  if (!st) return;
  if (!me || !me.pid || renaming) {
    const saved = storage.get(KEY);
    if (saved && saved.name && !$("#name").value) $("#name").value = saved.name;
    show("sJoin");
    updateMusic("lobby");
    return;
  }
  $("#helloName").textContent = `สวัสดี ${me.name}`;
  const phase = localPhase();
  const q = st.question;
  updateMusic(phase);

  if (phase === "lobby") return show("sWait");
  if (phase === "ended") return show("sEnded");
  if (!q) return show("sWait");

  if (st.answered) return showSent(st.answered, phase === "closed");
  if (phase === "countdown") {
    $("#countNum").textContent = Math.max(1, secondsLeft(st.startedAt));
    return show("sCount");
  }
  if (phase === "closed") {
    $("#sentTitle").textContent = "หมดเวลาตอบข้อนี้";
    $("#doneMark").textContent = "–";
    $("#mine").textContent = "";
    $("#sentNote").textContent = "รอคำถามถัดไปจากผู้ดูแล";
    return show("sSent");
  }
  // live
  const key = q.id + ":" + st.startedAt;
  if (formFor !== key) buildForm(q, key);
  $("#pqNo").textContent = `ข้อ ${st.qIndex + 1}/${st.total}`;
  $("#pqText").textContent = q.text;
  show("sQuestion");
  tick();
}

function showSent(values, closed) {
  $("#sentTitle").textContent = "ส่งคำตอบแล้ว";
  $("#doneMark").textContent = "✓";
  const box = $("#mine");
  box.textContent = "";
  values.forEach((v) => box.append(el("span", { text: v })));
  $("#sentNote").textContent = closed ? "หมดเวลาข้อนี้แล้ว รอคำถามถัดไป" : "ดูผลรวมได้บนจอหลัก รอคำถามถัดไป";
  show("sSent");
}

function buildForm(q, key) {
  formFor = key;
  choice = null;
  $("#answerError").hidden = true;
  const box = $("#answerFields");
  box.textContent = "";
  if (q.type === "choice") {
    const list = el("div", { class: "opts", role: "radiogroup", "aria-label": "ตัวเลือก" });
    q.options.forEach((o) => {
      const b = el(
        "button",
        { type: "button", class: "opt", role: "radio", "aria-checked": "false" },
        el("span", { class: "ring", "aria-hidden": "true" }),
        el("span", { text: o }),
      );
      b.addEventListener("click", () => {
        choice = o;
        $$(".opt", list).forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      });
      list.append(b);
    });
    box.append(list);
  } else if (q.type === "open") {
    const ta = el("textarea", { id: "ans0", maxlength: "200", "aria-label": "คำตอบของคุณ", placeholder: "พิมพ์คำตอบของคุณ" });
    const counter = el("div", { class: "counter num", text: "0/200" });
    ta.addEventListener("input", () => (counter.textContent = `${ta.value.length}/200`));
    box.append(el("div", { class: "inputs" }, ta, counter));
  } else {
    const wrap = el("div", { class: "inputs" });
    for (let i = 0; i < q.maxWords; i++) {
      wrap.append(
        el(
          "label",
          { class: "field" },
          el("span", { text: q.maxWords > 1 ? `คำที่ ${i + 1}${i ? " (ไม่บังคับ)" : ""}` : "คำตอบของคุณ" }),
          el("input", {
            type: "text",
            id: "ans" + i,
            maxlength: "40",
            autocomplete: "off",
            enterkeyhint: i + 1 < q.maxWords ? "next" : "send",
            placeholder: "คำสั้นๆ",
          }),
        ),
      );
    }
    box.append(wrap);
  }
}

function tick() {
  if (!st || !me || !me.pid) return;
  const phase = localPhase();
  if (phase === "countdown" && !$("#sCount").hidden) {
    $("#countNum").textContent = Math.max(1, secondsLeft(st.startedAt));
  }
  if (phase === "live" && st.question) {
    const left = secondsLeft(st.endsAt);
    $("#pqLeft").textContent = `เหลือ ${left} วินาที`;
    const frac = Math.max(0, Math.min(1, (st.endsAt - clock.now()) / (st.question.seconds * 1000)));
    $("#pTimebarFill").style.transform = `scaleX(${frac})`;
    $("#pTimebar").classList.toggle("low", left <= 10);
  }
}

let lastPhase = null;
setInterval(() => {
  const p = localPhase();
  if (p !== lastPhase) {
    lastPhase = p;
    render();
  } else tick();
}, 250);

// ---------- join ----------
$("#joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (musicOn) music.unlock();
  const name = $("#name").value.trim();
  const err = $("#joinError");
  if (!name) {
    err.textContent = "กรุณาใส่ชื่อก่อนเข้าร่วม";
    err.hidden = false;
    return;
  }
  err.hidden = true;
  $("#btnJoin").disabled = true;
  try {
    const saved = storage.get(KEY);
    const res = await api("/join", { method: "POST", body: { name, pid: saved && saved.pid } });
    me = { pid: res.pid, name: res.name, sessionId: res.sessionId };
    renaming = false;
    storage.set(KEY, me);
    await poll();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    $("#btnJoin").disabled = false;
  }
});

$("#btnRename").addEventListener("click", () => {
  $("#name").value = me ? me.name : "";
  renaming = true;
  show("sJoin");
  $("#name").focus();
});

// ---------- answer ----------
$("#answerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (sending || !st || !st.question) return;
  const q = st.question;
  let values;
  if (q.type === "choice") values = choice ? [choice] : [];
  else if (q.type === "open") values = [$("#ans0").value.trim()].filter(Boolean);
  else
    values = Array.from({ length: q.maxWords }, (_, i) => ($("#ans" + i) ? $("#ans" + i).value.trim() : "")).filter(
      Boolean,
    );
  const err = $("#answerError");
  if (!values.length) {
    err.textContent = q.type === "choice" ? "กรุณาเลือกหนึ่งตัวเลือก" : "กรุณาใส่คำตอบอย่างน้อย 1 คำ";
    err.hidden = false;
    return;
  }
  err.hidden = true;
  sending = true;
  $("#btnSend").disabled = true;
  try {
    const res = await api("/answer", { method: "POST", body: { pid: me.pid, questionId: q.id, values } });
    st = { ...st, answered: res.values };
    showSent(res.values, false);
  } catch (e2) {
    if (e2.status === 403) {
      me = null;
      render();
    } else {
      err.textContent = e2.message;
      err.hidden = false;
      if (e2.status === 409) setTimeout(poll, 500);
    }
  } finally {
    sending = false;
    $("#btnSend").disabled = false;
  }
});

// ---------- music (off by default on phones, so 30 phones do not play at once) ----------
function updateMusic(phase) {
  const want = musicOn && phase === "live";
  if (want && !music.playing && music.ctx) music.play();
  else if (!want && music.playing) music.stop();
}
$("#btnMusic").addEventListener("click", () => {
  musicOn = !musicOn;
  const b = $("#btnMusic");
  b.classList.toggle("on", musicOn);
  b.setAttribute("aria-pressed", String(musicOn));
  b.textContent = musicOn ? "ปิดเพลง" : "เปิดเพลง";
  if (musicOn) music.unlock();
  updateMusic(localPhase());
});

poll();
