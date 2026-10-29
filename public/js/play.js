import { $, $$, el, api, storage, clock, secondsLeft } from "./common.js";
import { AmbientMusic } from "./music.js";
import { pop, stagger, confetti, CHECK_SVG, letterIn, sparkles } from "./fx.js";
import { WordCloud } from "./cloud.js";

// Each project has its own link: /play?p=<projectId>
const PROJECT = new URLSearchParams(location.search).get("p") || "";
const KEY = "wc-player" + (PROJECT ? ":" + PROJECT : "");
const POLL_MS = 2000;

let me = storage.get(KEY) || null; // { pid, name, sessionId } or { name, pending: true }
let st = null; // last /state
let formFor = null; // question key the answer form was built for
let choice = null;
let pollTimer = null;
let sending = false;
let renaming = false;
let musicOn = false;
let sentKey = null;
let celebratedEnd = false;
let welcomed = false; // the welcome screen comes first after scanning
let topic = null;
let titleLoaded = false;
const music = new AmbientMusic();

const screens = ["sWelcome", "sJoin", "sWait", "sCount", "sQuestion", "sSent", "sEnded"];
function show(id) {
  for (const s of screens) $("#" + s).hidden = s !== id;
  document.querySelector(".phone").classList.toggle("welcoming", id === "sWelcome");
  if (id === "sWelcome") welcomeDemo.start();
  else welcomeDemo.stop();
}

// Live sample cloud on the welcome screen.
const welcomeDemo = (() => {
  const WORDS = [
    ["ความยั่งยืน", 9], ["สุขภาพดี", 8], ["ความเท่าเทียม", 6], ["บุคลากร", 6], ["ป้องกันโรค", 5],
    ["งบประมาณ", 5], ["ดิจิทัล", 4], ["ชุมชน", 4], ["ปฐมภูมิ", 3], ["สุขภาพจิต", 5], ["อสม.", 3],
    ["ข้อมูล", 3], ["สิ่งแวดล้อม", 3], ["นวัตกรรม", 2], ["ธรรมาภิบาล", 2], ["ผู้สูงอายุ", 2], ["AI", 2],
  ];
  const bag = WORDS.flatMap(([w, n]) => Array(n).fill(w));
  let cloudObj = null;
  let timer = null;
  let counts = new Map();
  let votes = 0;
  const vote = () => {
    if (votes >= 60) {
      counts = new Map();
      votes = 0;
    }
    const w = bag[Math.floor(Math.random() * bag.length)];
    counts.set(w, (counts.get(w) || 0) + 1);
    votes++;
    cloudObj.update([...counts].map(([text, count]) => ({ text, count })));
    $("#welcomeCount").textContent = `${votes} คำตอบ`;
  };
  return {
    start() {
      if (!cloudObj) {
        cloudObj = new WordCloud($("#welcomeCloud"));
        cloudObj.setEmptyText("");
        for (let i = 0; i < 18; i++) vote();
      }
      if (!timer && !matchMedia("(prefers-reduced-motion: reduce)").matches) timer = setInterval(vote, 1400);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
})();

function setTopic(text) {
  const t = text || "หัวข้อของวันนี้";
  if (topic === t) return;
  topic = t;
  $("#welcomeTopic").textContent = t;
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
    const params = new URLSearchParams();
    if (me && me.pid) params.set("pid", me.pid);
    if (PROJECT) params.set("p", PROJECT);
    if (PROJECT && !titleLoaded) params.set("t", "1");
    const qs = params.toString();
    const res = await api("/state" + (qs ? "?" + qs : ""));
    clock.sync(res.serverNow, sent, Date.now());
    st = res;
    netError("");
    if (res.projectTitle !== undefined) titleLoaded = true;
    setTopic(res.projectTitle || res.projectName);
    if (me && me.pending) {
      // Name entered before the room opened: join as soon as it does.
      if (res.phase !== "idle") await joinAs(me.name, true);
    } else if (me && (me.sessionId !== res.sessionId || !res.joined)) {
      // The admin stopped or cleared the game: join again with the same name.
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
  if (!st) return "idle";
  if (!["countdown", "live", "closed"].includes(st.phase)) return st.phase;
  const now = clock.now();
  if (now < st.startedAt) return "countdown";
  if (now <= st.endsAt) return "live";
  return "closed";
}

// ---------- render ----------
function render() {
  if (!st) return;
  const phase = localPhase();
  const signedUp = me && (me.pid || me.pending);
  if (!welcomed && !signedUp) return show("sWelcome");
  if (!me || (!me.pid && !me.pending) || renaming) {
    const saved = storage.get(KEY);
    if (saved && saved.name && !$("#name").value) $("#name").value = saved.name;
    $("#joinNote").hidden = phase !== "idle";
    show("sJoin");
    updateMusic("idle");
    return;
  }
  $("#helloName").textContent = `สวัสดี ${me.name}`;
  if (me.pending) {
    $("#waitTitle").textContent = "รอผู้ดูแลเริ่มเกม";
    $("#waitNote").textContent = "ระบบจะพาเข้าห้องให้เองเมื่อผู้ดูแลเริ่มเกม ไม่ต้องรีเฟรช";
    return show("sWait");
  }
  $("#waitTitle").textContent = "รอผู้ดูแลเริ่มคำถาม";
  $("#waitNote").textContent = "คำถามจะขึ้นที่หน้านี้อัตโนมัติ ไม่ต้องรีเฟรช";
  const q = st.question;
  updateMusic(phase);

  if (phase === "lobby" || phase === "idle") return show("sWait");
  if (phase === "ended") {
    if ($("#sEnded").hidden && !celebratedEnd) {
      celebratedEnd = true;
      letterIn($("#thanksTitle"), ["ขอบคุณ", "ที่ร่วมแบ่งปันความคิด"], 200);
      sparkles($("#endedStars"), 22);
      setTimeout(() => confetti({ count: 110 }), 500);
    }
    return show("sEnded");
  }
  celebratedEnd = false;
  if (!q) return show("sWait");

  if (st.answered) return showSent(st.answered, phase === "closed");
  if (phase === "countdown") {
    pop($("#countNum"), Math.max(1, secondsLeft(st.startedAt)));
    return show("sCount");
  }
  if (phase === "closed") {
    if (sentKey === "closed:" + q.id && !$("#sSent").hidden) return;
    sentKey = "closed:" + q.id;
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
  const key = (st && st.question ? st.question.id : "") + ":" + values.join("|");
  $("#sentNote").textContent = closed ? "หมดเวลาข้อนี้แล้ว รอคำถามถัดไป" : "ดูผลรวมได้บนจอหลัก รอคำถามถัดไป";
  if (sentKey === key && !$("#sSent").hidden) return;
  sentKey = key;
  $("#sentTitle").textContent = "ส่งคำตอบแล้ว";
  $("#doneMark").innerHTML = CHECK_SVG;
  const box = $("#mine");
  box.textContent = "";
  values.forEach((v, i) => box.append(el("span", { text: v, style: `--i:${i}` })));
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
    stagger(list.children, 1);
  } else if (q.type === "open") {
    const ta = el("textarea", { id: "ans0", maxlength: "200", "aria-label": "คำตอบของคุณ", placeholder: "พิมพ์คำตอบของคุณ" });
    const counter = el("div", { class: "counter num", text: "0/200" });
    ta.addEventListener("input", () => (counter.textContent = `${ta.value.length}/200`));
    box.append(el("div", { class: "inputs" }, ta, counter));
    stagger([box.firstChild], 1);
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
    stagger(wrap.children, 1);
  }
}

function tick() {
  if (!st || !me || !me.pid) return;
  const phase = localPhase();
  if (phase === "countdown" && !$("#sCount").hidden) {
    pop($("#countNum"), Math.max(1, secondsLeft(st.startedAt)));
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
async function joinAs(name, quiet) {
  const saved = storage.get(KEY);
  try {
    const res = await api("/join", { method: "POST", body: { name, pid: saved && saved.pid, projectId: PROJECT || undefined } });
    me = { pid: res.pid, name: res.name, sessionId: res.sessionId };
    renaming = false;
    storage.set(KEY, me);
    return true;
  } catch (e2) {
    if (e2.status === 409) {
      // Room not open yet: wait and join automatically.
      me = { name, pending: true, pid: saved && saved.pid };
      renaming = false;
      storage.set(KEY, me);
      return false;
    }
    if (!quiet) {
      $("#joinError").textContent = e2.message;
      $("#joinError").hidden = false;
    }
    return false;
  }
}

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
    if (st && st.phase === "idle") {
      const saved = storage.get(KEY);
      me = { name, pending: true, pid: saved && saved.pid };
      renaming = false;
      storage.set(KEY, me);
      render();
    } else {
      await joinAs(name, false);
      await poll();
    }
  } finally {
    $("#btnJoin").disabled = false;
  }
});

$("#btnWelcome").addEventListener("click", () => {
  welcomed = true;
  if (musicOn) music.unlock();
  render();
  setTimeout(() => $("#name").focus(), 60);
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
    requestAnimationFrame(() => {
      const r = $("#doneMark").getBoundingClientRect();
      confetti({ x: r.left + r.width / 2, y: r.top + r.height / 2, count: 70, power: 0.8 });
    });
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
