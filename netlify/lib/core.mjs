// Core API for the live word cloud. Storage is injected so the same code runs
// on Netlify (Netlify Blobs), on Vercel (Upstash Redis) and in the local dev
// server (in-memory store).
//
// Store interface used here:
//   get(key, { type: "json" }) -> object | null
//   setJSON(key, value)
//   list({ prefix }) -> { blobs: [{ key }] }
//   delete(key)

import crypto from "node:crypto";

export const LIMITS = {
  name: 30,
  word: 40,
  open: 200,
  question: 200,
  option: 60,
  minOptions: 2,
  maxOptions: 8,
  maxQuestions: 30,
  minSeconds: 10,
  maxSeconds: 600,
  maxWords: 5,
  countdownMs: 3000,
  graceMs: 1500,
  tokenHours: 12,
  maxProjects: 20,
  projectName: 60,
  minResultSeconds: 3,
  maxResultSeconds: 120,
  // Privacy: players and answers are deleted automatically
  autoClearAfterEndMs: 10 * 60 * 1000, // 10 minutes after the game ends
  autoClearIdleMs: 12 * 60 * 60 * 1000, // or 12 hours after the admin's last action
};

export const ADVANCE = ["manual", "auto"];

export const TYPES = ["wordcloud", "choice", "open"];

export const DEFAULT_QUESTIONS = [
  {
    id: "q-default-1",
    text: "เมื่อนึกถึง “การวิจัยทางสุขภาพกับการกำหนดนโยบาย” คุณนึกถึงคำว่าอะไร",
    type: "wordcloud",
    maxWords: 3,
    seconds: 60,
    options: [],
  },
  {
    id: "q-default-2",
    text: "ปัจจัยใดสำคัญที่สุดที่ทำให้ผลวิจัยถูกนำไปใช้กำหนดนโยบายสุขภาพ",
    type: "choice",
    maxWords: 1,
    seconds: 30,
    options: [
      "คุณภาพของหลักฐานวิจัย",
      "ผลวิจัยออกมาทันเวลา",
      "การสื่อสารกับผู้กำหนดนโยบาย",
      "ตอบโจทย์ปัญหาจริงของพื้นที่",
      "งบประมาณและทรัพยากร",
      "ความร่วมมือระหว่างนักวิจัยกับหน่วยงาน",
    ],
  },
  {
    id: "q-default-3",
    text: "อุปสรรคใหญ่ที่สุดที่ทำให้งานวิจัยไม่ถูกนำไปใช้กำหนดนโยบายคืออะไร",
    type: "wordcloud",
    maxWords: 2,
    seconds: 60,
    options: [],
  },
  {
    id: "q-default-4",
    text: "คุณจะทำอะไรเพื่อให้งานวิจัยของคุณมีผลต่อนโยบายสุขภาพมากขึ้น",
    type: "open",
    maxWords: 1,
    seconds: 90,
    options: [],
  },
];

export const DEFAULT_SETTINGS = { advance: "manual", resultSeconds: 10 };

function defaultProjects(questions) {
  return [
    {
      id: "p-default",
      name: "การวิจัยทางสุขภาพกับการกำหนดนโยบาย",
      questions: questions || DEFAULT_QUESTIONS,
      settings: { ...DEFAULT_SETTINGS },
    },
  ];
}

// ---------- text helpers (norm must match public/js/common.js) ----------

export function norm(s) {
  const base = String(s ?? "").normalize("NFC").toLowerCase();
  const stripped = base
    .replace(/[\s​‌‍﻿]+/g, "")
    .replace(/[!-/:-@[-`{-~‘’“”…·•、。，]+/g, "");
  return stripped || base.trim();
}

export function clean(s, max) {
  return String(s ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function newId(prefix = "") {
  return prefix + crypto.randomBytes(9).toString("base64url");
}

const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const validId = (s) => typeof s === "string" && ID_RE.test(s);

// ---------- similarity for the non-AI fallback ----------

function lev(a, b) {
  const A = Array.from(a);
  const B = Array.from(b);
  if (!A.length) return B.length;
  if (!B.length) return A.length;
  let prev = new Array(B.length + 1);
  for (let j = 0; j <= B.length; j++) prev[j] = j;
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[B.length];
}

export function similarity(a, b) {
  if (a === b) return 1;
  const la = Array.from(a).length;
  const lb = Array.from(b).length;
  const min = Math.min(la, lb);
  const max = Math.max(la, lb);
  if (min < 3) return 0;
  if (a.includes(b) || b.includes(a)) return min / max >= 0.6 ? 0.85 : 0;
  return 1 - lev(a, b) / max;
}

// items: [{ key, raw }], map: { key: label }  ->  { key: label } for the new items
export function localCluster(items, map) {
  const groups = new Map();
  for (const label of Object.values(map)) groups.set(norm(label), label);
  const out = {};
  for (const { key, raw } of items) {
    let best = null;
    let bestScore = 0;
    for (const [gk, label] of groups) {
      const s = similarity(key, gk);
      if (s > bestScore) {
        bestScore = s;
        best = label;
      }
    }
    if (best && bestScore >= 0.8) {
      out[key] = best;
    } else {
      out[key] = raw;
      groups.set(key, raw);
    }
  }
  return out;
}

// ---------- AI grouping through the Anthropic Messages API ----------

async function aiCluster({ question, labels, items, env, fetchImpl }) {
  const model = env.ANTHROPIC_MODEL || "claude-haiku-5-5";
  const numbered = items.map((it, i) => `${i + 1}. ${it.raw}`).join("\n");
  const existing = labels.length ? labels.map((l) => `- ${l}`).join("\n") : "(none yet)";
  const isOpen = question.type === "open";
  const prompt = [
    "You group audience answers for a live word cloud shown on a projector during a workshop in Thailand.",
    `Question: ${question.text}`,
    "",
    "Existing group labels:",
    existing,
    "",
    "New answers:",
    numbered,
    "",
    "For every new answer, give the label of the group it belongs to.",
    "- Reuse an existing label, written exactly as listed, when the answer means the same thing: a synonym, a spelling variant or typo, an abbreviation, a Thai/English equivalent, or the same idea with extra filler words.",
    "- Otherwise create a new concise label in the answer's own language, normally the clearest form of the answer itself.",
    isOpen
      ? "- These are sentence answers: label each with a short theme of 1 to 4 words, and give answers with the same main idea the same theme."
      : "- Keep labels short, at most 4 words.",
    "- Do not merge answers that are related but describe different ideas.",
    "- New answers that mean the same as each other must get the same label.",
    "",
    'Reply with only a JSON object mapping each answer number to its label, for example {"1": "label", "2": "label"}.',
  ].join("\n");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(`AI ตอบกลับ ${res.status} ${detail.slice(0, 160)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = (data.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI ไม่ได้ตอบเป็น JSON");
    const obj = JSON.parse(match[0]);
    const out = {};
    items.forEach((it, i) => {
      const label = clean(obj[String(i + 1)], isOpen ? 60 : LIMITS.word);
      out[it.key] = label || it.raw;
    });
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- auth ----------

function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function makeToken(secret) {
  const exp = Date.now() + LIMITS.tokenHours * 3600 * 1000;
  return `${exp}.${hmac(secret, "admin." + exp)}`;
}

function checkToken(secret, token) {
  if (!secret || typeof token !== "string") return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!exp || exp < Date.now() || !sig) return false;
  const expected = hmac(secret, "admin." + exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- validation ----------

export function sanitizeQuestion(q) {
  if (!q || typeof q !== "object") return null;
  const type = TYPES.includes(q.type) ? q.type : "wordcloud";
  const text = clean(q.text, LIMITS.question);
  if (!text) return null;
  let options = [];
  if (type === "choice") {
    const seen = new Set();
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const t = clean(o, LIMITS.option);
      if (t && !seen.has(norm(t))) {
        seen.add(norm(t));
        options.push(t);
      }
    }
    options = options.slice(0, LIMITS.maxOptions);
    if (options.length < LIMITS.minOptions) return null;
  }
  const seconds = Math.round(Number(q.seconds));
  const maxWords = Math.round(Number(q.maxWords));
  return {
    id: validId(q.id) ? q.id : newId("q-"),
    text,
    type,
    options,
    seconds: Math.min(LIMITS.maxSeconds, Math.max(LIMITS.minSeconds, seconds || 60)),
    maxWords: type === "wordcloud" ? Math.min(LIMITS.maxWords, Math.max(1, maxWords || 1)) : 1,
  };
}

export function sanitizeProject(p) {
  if (!p || typeof p !== "object") return null;
  const questions = [];
  for (const raw of Array.isArray(p.questions) ? p.questions.slice(0, LIMITS.maxQuestions) : []) {
    const q = sanitizeQuestion(raw);
    if (!q) return null;
    questions.push(q);
  }
  const ids = new Set();
  for (const q of questions) {
    if (ids.has(q.id)) q.id = newId("q-");
    ids.add(q.id);
  }
  const s = p.settings || {};
  const rs = Math.round(Number(s.resultSeconds));
  return {
    id: validId(p.id) ? p.id : newId("p-"),
    name: clean(p.name, LIMITS.projectName) || "โปรเจกต์ใหม่",
    questions,
    settings: {
      advance: ADVANCE.includes(s.advance) ? s.advance : "manual",
      resultSeconds: Math.min(LIMITS.maxResultSeconds, Math.max(LIMITS.minResultSeconds, rs || DEFAULT_SETTINGS.resultSeconds)),
    },
  };
}

function validateAnswer(question, values) {
  if (!Array.isArray(values)) values = [values];
  if (question.type === "choice") {
    const pick = clean(values[0], LIMITS.option);
    const hit = question.options.find((o) => o === pick);
    return hit ? [hit] : null;
  }
  if (question.type === "open") {
    const t = clean(values[0], LIMITS.open);
    return t ? [t] : null;
  }
  const out = [];
  const seen = new Set();
  for (const v of values.slice(0, 20)) {
    if (out.length >= question.maxWords) break;
    const t = clean(v, LIMITS.word);
    if (t && !seen.has(norm(t))) {
      seen.add(norm(t));
      out.push(t);
    }
  }
  return out.length ? out : null;
}

function publicQuestion(q) {
  if (!q) return null;
  return { id: q.id, text: q.text, type: q.type, options: q.options, maxWords: q.maxWords, seconds: q.seconds };
}

export function phaseOf(state, now) {
  if (state.status === "idle" || (state.status === "lobby" && !state.projectId)) return "idle";
  if (state.status !== "live") return state.status;
  if (now < state.startedAt) return "countdown";
  if (now <= state.endsAt) return "live";
  return "closed";
}

// ---------- API ----------

export function createApi({ store, env = {}, fetchImpl = globalThis.fetch }) {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  const fail = (status, error) => json({ error }, status);

  const getJSON = async (key) => {
    try {
      return await store.get(key, { type: "json" });
    } catch {
      return null;
    }
  };

  // Stores that can read many keys in one call (Redis MGET) use it; the
  // others read one key at a time.
  async function getMany(keys) {
    if (!keys.length) return [];
    if (store.getMany) {
      try {
        return await store.getMany(keys);
      } catch {
        return keys.map(() => null);
      }
    }
    return Promise.all(keys.map((k) => getJSON(k)));
  }

  async function listJSON(prefix) {
    const { blobs } = await store.list({ prefix });
    const rows = await getMany(blobs.map((b) => b.key));
    return rows.filter(Boolean);
  }

  async function deletePrefix(prefix) {
    const { blobs } = await store.list({ prefix });
    if (!blobs.length) return;
    if (store.deleteMany) return store.deleteMany(blobs.map((b) => b.key));
    await Promise.all(blobs.map((b) => store.delete(b.key)));
  }

  const freshState = () => ({
    status: "idle",
    qIndex: -1,
    question: null,
    questions: [],
    total: 0,
    startedAt: 0,
    endsAt: 0,
    sessionId: newId("s-"),
  });

  // In "auto" mode the game moves on by itself: results stay on screen for
  // resultSeconds, then the next question counts down. The step is computed
  // from stored times, so concurrent readers all write the same result.
  function autoAdvance(st, now) {
    let next = st;
    let changed = false;
    while (next.status === "live" && next.advance === "auto") {
      const nextAt = next.endsAt + (next.resultSeconds || DEFAULT_SETTINGS.resultSeconds) * 1000;
      if (now < nextAt) break;
      const idx = next.qIndex + 1;
      const list = next.questions || [];
      if (idx >= list.length) {
        next = { ...next, status: "ended", question: null, endedAt: nextAt };
      } else {
        const q = list[idx];
        const startedAt = nextAt + LIMITS.countdownMs;
        next = { ...next, qIndex: idx, question: q, startedAt, endsAt: startedAt + q.seconds * 1000 };
      }
      changed = true;
    }
    return changed ? next : null;
  }

  async function getState() {
    let st = await getJSON("state");
    if (!st || !st.sessionId) {
      st = freshState();
      await store.setJSON("state", st);
      return st;
    }
    const now = Date.now();
    const moved = autoAdvance(st, now);
    if (moved) st = moved;
    if (shouldAutoClear(st, now)) {
      await clearSession(st);
      st = freshState();
      await store.setJSON("state", st);
      return st;
    }
    if (moved) await store.setJSON("state", st);
    return st;
  }

  // Delete players and answers on their own: 10 minutes after the finale,
  // or when a room has been left untouched for 12 hours.
  function shouldAutoClear(st, now) {
    if (phaseOf(st, now) === "idle") return false;
    if (st.status === "ended" && st.endedAt && now - st.endedAt > LIMITS.autoClearAfterEndMs) return true;
    if (st.updatedAt && now - st.updatedAt > LIMITS.autoClearIdleMs) return true;
    return false;
  }

  async function getProjects() {
    const list = await getJSON("projects");
    if (Array.isArray(list) && list.length) return list;
    // First run, or data saved before projects existed: wrap the old question list.
    const old = await getJSON("questions");
    return defaultProjects(Array.isArray(old) ? old : null);
  }

  async function clearSession(st) {
    const old = st.sessionId;
    await Promise.all([
      deletePrefix(`players/${old}/`),
      deletePrefix(`answers/${old}/`),
      deletePrefix(`clusters/${old}/`),
    ]);
  }

  const stateView = (st, now) => ({
    phase: phaseOf(st, now),
    sessionId: st.sessionId,
    qIndex: st.qIndex,
    total: st.total,
    question: publicQuestion(st.question),
    startedAt: st.startedAt,
    endsAt: st.endsAt,
    projectId: phaseOf(st, now) === "idle" ? null : st.projectId || null,
    projectName: st.projectName || null,
    advance: st.advance || "manual",
    nextAt: st.status === "live" && st.advance === "auto" ? st.endsAt + (st.resultSeconds || 10) * 1000 : null,
    serverNow: now,
  });

  async function readBody(req) {
    try {
      const text = await req.text();
      if (text.length > 400000) return null;
      return text ? JSON.parse(text) : {};
    } catch {
      return null;
    }
  }

  function isAdmin(req) {
    const h = req.headers.get("authorization") || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    return checkToken(env.ADMIN_PASSWORD, token);
  }

  async function results(st, qid) {
    if (!qid) return { answers: [], map: {} };
    const answers = await listJSON(`answers/${st.sessionId}/${qid}/`);
    answers.sort((a, b) => a.at - b.at);
    const cl = await getJSON(`clusters/${st.sessionId}/${qid}`);
    return { questionId: qid, answers, map: (cl && cl.map) || {} };
  }

  // ---- player routes ----

  async function getStatePublic(url) {
    const now = Date.now();
    const st = await getState();
    const view = stateView(st, now);
    const want = url.searchParams.get("p");
    // t=1: the welcome screen asks for the project's title once.
    let projectTitle;
    if (validId(want) && url.searchParams.get("t") === "1") {
      const proj = (await getProjects()).find((x) => x.id === want);
      projectTitle = proj ? proj.name : null;
    }
    if (validId(want) && view.projectId !== want) {
      return json({ phase: "idle", serverNow: now, joined: false, sessionId: null, question: null, projectTitle });
    }
    const pid = url.searchParams.get("pid");
    let player = null;
    let answered = null;
    if (validId(pid)) {
      const pkey = `players/${st.sessionId}/${pid}`;
      if (st.question && view.phase !== "lobby") {
        const [p, a] = await getMany([pkey, `answers/${st.sessionId}/${st.question.id}/${pid}`]);
        player = p;
        answered = player && a ? a.values : null;
      } else {
        player = await getJSON(pkey);
      }
    }
    return json({ ...view, joined: !!player, name: player ? player.name : null, answered, projectTitle });
  }

  async function join(req) {
    const body = await readBody(req);
    if (!body) return fail(400, "ข้อมูลไม่ถูกต้อง");
    const name = clean(body.name, LIMITS.name);
    if (!name) return fail(400, "กรุณาใส่ชื่อ");
    const st = await getState();
    const open = phaseOf(st, Date.now()) !== "idle";
    if (!open || (validId(body.projectId) && body.projectId !== st.projectId)) {
      return fail(409, "ผู้ดูแลยังไม่เปิดห้องนี้");
    }
    const pid = validId(body.pid) ? body.pid : newId("p-");
    const existing = await getJSON(`players/${st.sessionId}/${pid}`);
    await store.setJSON(`players/${st.sessionId}/${pid}`, {
      pid,
      name,
      joinedAt: existing ? existing.joinedAt : Date.now(),
    });
    return json({ pid, name, sessionId: st.sessionId });
  }

  async function answer(req) {
    const body = await readBody(req);
    if (!body || !validId(body.pid)) return fail(400, "ข้อมูลไม่ถูกต้อง");
    const now = Date.now();
    const st = await getState();
    const q = st.question;
    if (st.status !== "live" || !q || q.id !== body.questionId) return fail(409, "คำถามนี้ปิดไปแล้ว");
    if (now < st.startedAt) return fail(409, "คำถามยังไม่เริ่ม");
    if (now > st.endsAt + LIMITS.graceMs) return fail(409, "หมดเวลาตอบข้อนี้แล้ว");
    const player = await getJSON(`players/${st.sessionId}/${body.pid}`);
    if (!player) return fail(403, "กรุณาเข้าร่วมเกมใหม่อีกครั้ง");
    const key = `answers/${st.sessionId}/${q.id}/${body.pid}`;
    if (await getJSON(key)) return fail(409, "คุณส่งคำตอบข้อนี้แล้ว");
    const values = validateAnswer(q, body.values);
    if (!values) return fail(400, "กรุณาใส่คำตอบ");
    await store.setJSON(key, { pid: body.pid, name: player.name, values, at: now });
    return json({ ok: true, values });
  }

  // ---- admin routes ----

  async function login(req) {
    if (!env.ADMIN_PASSWORD) return fail(500, "ยังไม่ได้ตั้งค่า ADMIN_PASSWORD ในหน้าตั้งค่าของเว็บโฮสต์");
    const body = await readBody(req);
    if (!body || !safeEqual(body.password ?? "", env.ADMIN_PASSWORD)) {
      await new Promise((r) => setTimeout(r, 500));
      return fail(401, "รหัสผ่านไม่ถูกต้อง");
    }
    return json({ token: makeToken(env.ADMIN_PASSWORD) });
  }

  async function overview() {
    const now = Date.now();
    const st = await getState();
    const [projects, players, res] = await Promise.all([
      getProjects(),
      listJSON(`players/${st.sessionId}/`),
      results(st, st.question && st.status === "live" ? st.question.id : null),
    ]);
    players.sort((a, b) => a.joinedAt - b.joinedAt);
    return json({
      state: stateView(st, now),
      projects,
      players: players.map((p) => ({ pid: p.pid, name: p.name, joinedAt: p.joinedAt })),
      results: res,
      aiAvailable: !!env.ANTHROPIC_API_KEY,
    });
  }

  async function saveProjects(req) {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.projects) || !body.projects.length) return fail(400, "ต้องมีอย่างน้อย 1 โปรเจกต์");
    if (body.projects.length > LIMITS.maxProjects) return fail(400, `มีโปรเจกต์ได้สูงสุด ${LIMITS.maxProjects} โปรเจกต์`);
    const out = [];
    const ids = new Set();
    for (const raw of body.projects) {
      const p = sanitizeProject(raw);
      if (!p) return fail(400, "มีคำถามที่ข้อมูลไม่ครบ (ตัวเลือกต้องมีอย่างน้อย 2 ข้อ)");
      if (ids.has(p.id)) p.id = newId("p-");
      ids.add(p.id);
      out.push(p);
    }
    const st = await getState();
    const openId = phaseOf(st, Date.now()) === "idle" ? null : st.projectId;
    if (openId && !out.some((p) => p.id === openId)) return fail(409, "กดหยุดเกมก่อนลบโปรเจกต์ที่กำลังเปิดห้องอยู่");
    await store.setJSON("projects", out);
    return json({ projects: out });
  }

  async function control(req) {
    const body = await readBody(req);
    if (!body) return fail(400, "ข้อมูลไม่ถูกต้อง");
    const now = Date.now();
    let st = await getState();
    const startAt = (idx, questions = st.questions || []) => {
      if (idx < 0 || idx >= questions.length) {
        return { ...st, status: "ended", question: null, endedAt: now };
      }
      const q = questions[idx];
      const startedAt = now + LIMITS.countdownMs;
      return {
        ...st,
        status: "live",
        qIndex: idx,
        question: q,
        questions,
        total: questions.length,
        startedAt,
        endsAt: startedAt + q.seconds * 1000,
      };
    };

    switch (body.action) {
      // Open the room for one project: its QR link starts working and players gather.
      case "open": {
        const project = (await getProjects()).find((p) => p.id === body.projectId);
        if (!project) return fail(404, "ไม่พบโปรเจกต์");
        const phase = phaseOf(st, now);
        if (["countdown", "live", "closed"].includes(phase) && st.projectId !== project.id) {
          return fail(409, "กดหยุดเกมของโปรเจกต์ที่เล่นอยู่ก่อน");
        }
        if (st.projectId === project.id && phase !== "idle" && phase !== "ended") {
          // Already open: keep the players who joined.
          st = { ...st, projectName: project.name };
          break;
        }
        await clearSession(st);
        st = { ...freshState(), status: "lobby", projectId: project.id, projectName: project.name };
        break;
      }
      case "start": {
        if (phaseOf(st, now) !== "lobby") return fail(409, "เปิดห้องจากหน้าตั้งค่าเกมก่อน");
        const project = (await getProjects()).find((p) => p.id === st.projectId);
        if (!project) return fail(404, "ไม่พบโปรเจกต์");
        if (!project.questions.length) return fail(400, "โปรเจกต์นี้ยังไม่มีคำถาม");
        st = {
          ...st,
          projectName: project.name,
          advance: project.settings.advance,
          resultSeconds: project.settings.resultSeconds,
        };
        st = startAt(0, project.questions);
        break;
      }
      // Clear the players but keep the room open.
      case "clear": {
        await clearSession(st);
        st = { ...freshState(), status: st.projectId ? "lobby" : "idle", projectId: st.projectId, projectName: st.projectName };
        break;
      }
      case "next":
        st = startAt(st.qIndex + 1);
        break;
      case "goto":
        st = startAt(Math.round(Number(body.index)));
        break;
      case "close":
        if (st.status === "live") {
          st = { ...st, endsAt: Math.min(st.endsAt, now), startedAt: Math.min(st.startedAt, now) };
        }
        break;
      case "extend": {
        const add = Math.min(120, Math.max(5, Number(body.seconds) || 15)) * 1000;
        if (st.status === "live") st = { ...st, endsAt: Math.max(st.endsAt, now) + add };
        break;
      }
      case "end":
        st = { ...st, status: "ended", question: null, endedAt: now };
        break;
      // Stop the game: players and answers are cleared every time.
      case "stop":
      case "reset": {
        await clearSession(st);
        st = freshState();
        break;
      }
      default:
        return fail(400, "คำสั่งไม่ถูกต้อง");
    }
    st = { ...st, updatedAt: now };
    await store.setJSON("state", st);
    return json({ state: stateView(st, now) });
  }

  async function cluster(req) {
    const body = await readBody(req);
    if (!body) return fail(400, "ข้อมูลไม่ถูกต้อง");
    const st = await getState();
    const qid = body.questionId;
    const q = st.question && st.question.id === qid ? st.question : (st.questions || []).find((x) => x.id === qid);
    if (!q) return fail(404, "ไม่พบคำถาม");
    // Long answers are read as cards, not grouped: no AI work for them.
    if (q.type === "choice" || q.type === "open") return json({ map: {}, source: "none" });

    const ckey = `clusters/${st.sessionId}/${qid}`;
    const { answers } = await results(st, qid);
    const saved = await getJSON(ckey);
    const map = { ...((saved && saved.map) || {}) };

    const rawCounts = new Map();
    for (const a of answers) {
      for (const v of a.values) {
        const k = norm(v);
        if (!rawCounts.has(k)) rawCounts.set(k, new Map());
        const m = rawCounts.get(k);
        m.set(v, (m.get(v) || 0) + 1);
      }
    }
    const items = [];
    for (const [key, m] of rawCounts) {
      if (map[key]) continue;
      const raw = [...m.entries()].sort((x, y) => y[1] - x[1])[0][0];
      items.push({ key, raw });
    }
    if (!items.length) return json({ map, source: "none" });

    const labelCounts = new Map();
    for (const [key, label] of Object.entries(map)) {
      const n = [...(rawCounts.get(key) || new Map()).values()].reduce((s, x) => s + x, 0);
      labelCounts.set(label, (labelCounts.get(label) || 0) + n);
    }
    const labels = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([l]) => l);
    const batch = items.slice(0, 60);

    let added;
    let source = "local";
    let error = null;
    if (env.ANTHROPIC_API_KEY) {
      try {
        added = await aiCluster({ question: q, labels, items: batch, env, fetchImpl });
        source = "ai";
      } catch (e) {
        error = e && e.name === "AbortError" ? "AI ตอบช้าเกินไป" : String((e && e.message) || e);
        // 401/403: the key is wrong or has no access. Retrying will not help.
        const errorCode = e && (e.status === 401 || e.status === 403) ? "ai_auth" : e && e.status === 429 ? "ai_busy" : "ai_error";
        console.error("AI grouping failed:", error);
        added = localCluster(batch, map);
        // Not saved: the next request retries these answers with AI.
        return json({ map: { ...map, ...added }, source: "local", error, errorCode, pending: items.length - batch.length });
      }
    } else {
      added = localCluster(batch, map);
    }

    // Keep one spelling per label so "Health" and "health" stay one group.
    const byNorm = new Map(Object.values(map).map((l) => [norm(l), l]));
    for (const [key, label] of Object.entries(added)) {
      const nk = norm(label);
      if (!byNorm.has(nk)) byNorm.set(nk, label);
      map[key] = byNorm.get(nk);
    }
    await store.setJSON(ckey, { map, updatedAt: Date.now() });
    return json({ map, source, error, pending: items.length - batch.length });
  }

  // ---- router ----

  async function handle(req) {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
      const m = req.method;

      if (m === "GET" && path === "/state") return await getStatePublic(url);
      if (m === "POST" && path === "/join") return await join(req);
      if (m === "POST" && path === "/answer") return await answer(req);
      if (m === "POST" && path === "/login") return await login(req);

      if (path.startsWith("/admin/")) {
        if (!isAdmin(req)) return fail(401, "กรุณาเข้าสู่ระบบใหม่");
        if (m === "GET" && path === "/admin/overview") return await overview();
        if (m === "PUT" && path === "/admin/projects") return await saveProjects(req);
        if (m === "POST" && path === "/admin/control") return await control(req);
        if (m === "POST" && path === "/admin/cluster") return await cluster(req);
      }
      return fail(404, "ไม่พบ");
    } catch (e) {
      console.error(e);
      return fail(500, "เซิร์ฟเวอร์ขัดข้อง ลองใหม่อีกครั้ง");
    }
  }

  // Used by the scheduled cleanup function: reading the state applies the
  // automatic-clear rules even when nobody has the site open.
  handle.sweep = async () => {
    const st = await getState();
    return phaseOf(st, Date.now());
  };
  return handle;
}
