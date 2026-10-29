import test from "node:test";
import assert from "node:assert/strict";
import { createApi, norm, localCluster, sanitizeQuestion } from "../netlify/lib/core.mjs";
import { norm as clientNorm } from "../public/js/common.js";

function memoryStore() {
  const data = new Map();
  return {
    data,
    async get(key) {
      return data.has(key) ? JSON.parse(data.get(key)) : null;
    },
    async setJSON(key, value) {
      data.set(key, JSON.stringify(value));
    },
    async list({ prefix = "" } = {}) {
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

function client(api) {
  let token = null;
  const call = async (method, path, body, auth = true) => {
    const headers = { "content-type": "application/json" };
    if (auth && token) headers.authorization = "Bearer " + token;
    const res = await api(
      new Request("http://x/api" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    );
    return { status: res.status, body: await res.json() };
  };
  return {
    call,
    async login(pw) {
      const r = await call("POST", "/login", { password: pw }, false);
      token = r.body.token;
      return r;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function useQuestions(c, questions, settings = {}) {
  const r = await c.call("PUT", "/admin/projects", {
    projects: [{ id: "p-test1", name: "ทดสอบ", questions, settings }],
  });
  await c.call("POST", "/admin/control", { action: "open", projectId: "p-test1" });
  return { status: r.status, body: { questions: r.body.projects ? r.body.projects[0].questions : null, ...r.body } };
}

function skipCountdown(store) {
  const st = JSON.parse(store.data.get("state"));
  st.startedAt = Date.now() - 1;
  store.data.set("state", JSON.stringify(st));
  return st;
}

test("norm matches between server and browser", () => {
  for (const s of ["  Health ", "สุขภาพ ดี", "ระบบ-สุขภาพ!", "AI.", "“ยั่งยืน”", "!!!", "การเงิน การคลัง"]) {
    assert.equal(norm(s), clientNorm(s), s);
  }
  assert.equal(norm("ระบบ สุขภาพ"), norm("ระบบสุขภาพ"));
  assert.equal(norm("Health!"), norm("health"));
});

test("local clustering merges typos but not different words", () => {
  const map = localCluster(
    [
      { key: norm("ความยั่งยืน"), raw: "ความยั่งยืน" },
      { key: norm("ความยั่งยืนน"), raw: "ความยั่งยืนน" },
      { key: norm("งบประมาณ"), raw: "งบประมาณ" },
    ],
    {},
  );
  assert.equal(map[norm("ความยั่งยืนน")], "ความยั่งยืน");
  assert.equal(map[norm("งบประมาณ")], "งบประมาณ");
});

test("question validation", () => {
  assert.equal(sanitizeQuestion({ text: "", type: "wordcloud" }), null);
  assert.equal(sanitizeQuestion({ text: "เลือก", type: "choice", options: ["a"] }), null);
  const q = sanitizeQuestion({ text: " ถาม ", type: "wordcloud", seconds: 5, maxWords: 9 });
  assert.equal(q.text, "ถาม");
  assert.equal(q.seconds, 10);
  assert.equal(q.maxWords, 5);
});

test("full game flow with AI grouping", async () => {
  const store = memoryStore();
  let aiCalls = 0;
  const fakeFetch = async (url, opts) => {
    aiCalls++;
    const body = JSON.parse(opts.body);
    const prompt = body.messages[0].content;
    assert.match(prompt, /New answers:/);
    // Group every "health"-like answer under "สุขภาพดี".
    const lines = prompt.split("\n").filter((l) => /^\d+\. /.test(l));
    const out = {};
    for (const l of lines) {
      const [n, ...rest] = l.split(". ");
      const t = rest.join(". ");
      out[n] = /health|สุขภาพ/i.test(t) ? "สุขภาพดี" : t;
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(out) }] }), { status: 200 });
  };
  const api = createApi({ store, env: { ADMIN_PASSWORD: "pw", ANTHROPIC_API_KEY: "k" }, fetchImpl: fakeFetch });
  const c = client(api);

  assert.equal((await c.login("nope")).status, 401);
  assert.equal((await c.login("pw")).status, 200);
  assert.equal((await c.call("GET", "/admin/overview", null, false)).status, 401);

  // Replace default questions with one short word-cloud question.
  const saved = await useQuestions(c, [{ text: "นึกถึงคำว่าอะไร", type: "wordcloud", seconds: 10, maxWords: 2 }]);
  assert.equal(saved.status, 200);
  const qid = saved.body.questions[0].id;

  // Players join while in lobby; they cannot answer yet.
  const p1 = (await c.call("POST", "/join", { name: "เอ" }, false)).body;
  const p2 = (await c.call("POST", "/join", { name: "บี" }, false)).body;
  const p3 = (await c.call("POST", "/join", { name: "ซี" }, false)).body;
  let s = (await c.call("GET", "/state?pid=" + p1.pid, null, false)).body;
  assert.equal(s.phase, "lobby");
  assert.equal(s.joined, true);
  assert.equal((await c.call("POST", "/answer", { pid: p1.pid, questionId: qid, values: ["x"] }, false)).status, 409);

  // Admin starts: 3-second countdown, then live.
  await c.call("POST", "/admin/control", { action: "start" });
  s = (await c.call("GET", "/state?pid=" + p1.pid, null, false)).body;
  assert.equal(s.phase, "countdown");
  assert.equal(s.question.id, qid);
  // Skip the countdown for the test.
  const st = JSON.parse(store.data.get("state"));
  st.startedAt = Date.now() - 1;
  store.data.set("state", JSON.stringify(st));

  const a1 = await c.call("POST", "/answer", { pid: p1.pid, questionId: qid, values: ["Health", "งบประมาณ"] }, false);
  assert.equal(a1.status, 200);
  assert.equal((await c.call("POST", "/answer", { pid: p1.pid, questionId: qid, values: ["again"] }, false)).status, 409);
  await c.call("POST", "/answer", { pid: p2.pid, questionId: qid, values: ["สุขภาพ"] }, false);
  await c.call("POST", "/answer", { pid: p3.pid, questionId: qid, values: ["งบประมาณ ", "", "x", "y"] }, false);

  s = (await c.call("GET", "/state?pid=" + p2.pid, null, false)).body;
  assert.deepEqual(s.answered, ["สุขภาพ"]);

  let ov = (await c.call("GET", "/admin/overview")).body;
  assert.equal(ov.players.length, 3);
  assert.equal(ov.results.answers.length, 3);
  assert.deepEqual(ov.results.answers[2].values, ["งบประมาณ", "x"]); // maxWords 2, empty dropped

  const cl = await c.call("POST", "/admin/cluster", { questionId: qid });
  assert.equal(cl.body.source, "ai");
  assert.equal(cl.body.map[norm("Health")], "สุขภาพดี");
  assert.equal(cl.body.map[norm("สุขภาพ")], "สุขภาพดี");
  assert.equal(aiCalls, 1);
  // Nothing new: no second AI call.
  assert.equal((await c.call("POST", "/admin/cluster", { questionId: qid })).body.source, "none");
  assert.equal(aiCalls, 1);
  ov = (await c.call("GET", "/admin/overview")).body;
  assert.equal(ov.results.map[norm("health")], "สุขภาพดี");

  // Close early: answers rejected after grace.
  await c.call("POST", "/admin/control", { action: "close" });
  await sleep(1600);
  const p4 = (await c.call("POST", "/join", { name: "ดี" }, false)).body;
  assert.equal((await c.call("POST", "/answer", { pid: p4.pid, questionId: qid, values: ["late"] }, false)).status, 409);

  // Next past the last question ends the game.
  await c.call("POST", "/admin/control", { action: "next" });
  assert.equal((await c.call("GET", "/state", null, false)).body.phase, "ended");

  // Reset clears players and answers and starts a new session.
  const oldSession = s.sessionId;
  await c.call("POST", "/admin/control", { action: "reset" });
  ov = (await c.call("GET", "/admin/overview")).body;
  assert.equal(ov.players.length, 0);
  assert.notEqual(ov.state.sessionId, oldSession);
  assert.equal([...store.data.keys()].filter((k) => k.startsWith("answers/")).length, 0);
  s = (await c.call("GET", "/state?pid=" + p1.pid, null, false)).body;
  assert.equal(s.joined, false);
});

test("AI failure falls back without saving", async () => {
  const store = memoryStore();
  const api = createApi({
    store,
    env: { ADMIN_PASSWORD: "pw", ANTHROPIC_API_KEY: "k" },
    fetchImpl: async () => new Response("overloaded", { status: 529 }),
  });
  const c = client(api);
  await c.login("pw");
  const qid = (await useQuestions(c, [{ text: "q", type: "wordcloud", seconds: 30, maxWords: 1 }]))
    .body.questions[0].id;
  await c.call("POST", "/admin/control", { action: "start" });
  const st = JSON.parse(store.data.get("state"));
  st.startedAt = Date.now() - 1;
  store.data.set("state", JSON.stringify(st));
  const p = (await c.call("POST", "/join", { name: "a" }, false)).body;
  await c.call("POST", "/answer", { pid: p.pid, questionId: qid, values: ["คำ"] }, false);
  const r = (await c.call("POST", "/admin/cluster", { questionId: qid })).body;
  assert.equal(r.source, "local");
  assert.match(r.error, /529/);
  assert.equal(store.data.has(`clusters/${st.sessionId}/${qid}`), false);
});

test("choice answers must be one of the options", async () => {
  const store = memoryStore();
  const c = client(createApi({ store, env: { ADMIN_PASSWORD: "pw" } }));
  await c.login("pw");
  const qid = (
    await useQuestions(c, [{ text: "เลือก", type: "choice", options: ["ก", "ข"], seconds: 30 }])
  ).body.questions[0].id;
  await c.call("POST", "/admin/control", { action: "start" });
  const st = JSON.parse(store.data.get("state"));
  st.startedAt = Date.now() - 1;
  store.data.set("state", JSON.stringify(st));
  const p = (await c.call("POST", "/join", { name: "a" }, false)).body;
  assert.equal((await c.call("POST", "/answer", { pid: p.pid, questionId: qid, values: ["ค"] }, false)).status, 400);
  assert.equal((await c.call("POST", "/answer", { pid: p.pid, questionId: qid, values: ["ข"] }, false)).status, 200);
});

test("login without ADMIN_PASSWORD explains the setup step", async () => {
  const c = client(createApi({ store: memoryStore(), env: {} }));
  const r = await c.login("x");
  assert.equal(r.status, 500);
  assert.match(r.body.error, /ADMIN_PASSWORD/);
});

test("old question list becomes the first project", async () => {
  const store = memoryStore();
  await store.setJSON("questions", [{ id: "q-old1", text: "คำถามเดิม", type: "wordcloud", seconds: 30, maxWords: 1, options: [] }]);
  const c = client(createApi({ store, env: { ADMIN_PASSWORD: "pw" } }));
  await c.login("pw");
  const ov = (await c.call("GET", "/admin/overview")).body;
  assert.equal(ov.projects.length, 1);
  assert.equal(ov.projects[0].questions[0].text, "คำถามเดิม");
  assert.equal(ov.state.phase, "idle");
});

test("rooms: one project open at a time, links are per project", async () => {
  const store = memoryStore();
  const c = client(createApi({ store, env: { ADMIN_PASSWORD: "pw" } }));
  await c.login("pw");
  const projects = [
    { id: "p-aaaa1", name: "A", questions: [{ text: "qa", type: "wordcloud", seconds: 30, maxWords: 1 }] },
    { id: "p-bbbb1", name: "B", questions: [{ text: "qb", type: "wordcloud", seconds: 30, maxWords: 1 }], settings: { advance: "auto", resultSeconds: 5 } },
  ];
  assert.equal((await c.call("PUT", "/admin/projects", { projects })).status, 200);
  // Nothing open yet: joining fails, start fails.
  assert.equal((await c.call("POST", "/join", { name: "x", projectId: "p-bbbb1" }, false)).status, 409);
  assert.equal((await c.call("POST", "/admin/control", { action: "start" })).status, 409);
  // Open B.
  await c.call("POST", "/admin/control", { action: "open", projectId: "p-bbbb1" });
  assert.equal((await c.call("GET", "/state?p=p-aaaa1", null, false)).body.phase, "idle");
  assert.equal((await c.call("GET", "/state?p=p-bbbb1", null, false)).body.phase, "lobby");
  assert.equal((await c.call("POST", "/join", { name: "x", projectId: "p-aaaa1" }, false)).status, 409);
  const pl = (await c.call("POST", "/join", { name: "x", projectId: "p-bbbb1" }, false)).body;
  // Re-opening the same room keeps players; clear empties it but keeps it open.
  await c.call("POST", "/admin/control", { action: "open", projectId: "p-bbbb1" });
  assert.equal((await c.call("GET", "/admin/overview")).body.players.length, 1);
  await c.call("POST", "/admin/control", { action: "clear" });
  let ov = (await c.call("GET", "/admin/overview")).body;
  assert.equal(ov.players.length, 0);
  assert.equal(ov.state.phase, "lobby");
  assert.equal(ov.state.projectId, "p-bbbb1");
  assert.ok(pl.pid);
  // Start B; A cannot be opened while B is playing.
  await c.call("POST", "/admin/control", { action: "start" });
  let s = (await c.call("GET", "/state?p=p-bbbb1", null, false)).body;
  assert.equal(s.advance, "auto");
  assert.equal(s.question.text, "qb");
  assert.equal((await c.call("POST", "/admin/control", { action: "open", projectId: "p-aaaa1" })).status, 409);
  // Cannot delete the project whose room is open.
  assert.equal((await c.call("PUT", "/admin/projects", { projects: [projects[0]] })).status, 409);
  // Editing its questions is fine; the game keeps its snapshot.
  assert.equal((await c.call("PUT", "/admin/projects", { projects: [projects[0], { ...projects[1], questions: [] }] })).status, 200);
  s = (await c.call("GET", "/state", null, false)).body;
  assert.equal(s.question.text, "qb");
  // Stop closes the room.
  await c.call("POST", "/admin/control", { action: "stop" });
  ov = (await c.call("GET", "/admin/overview")).body;
  assert.equal(ov.state.phase, "idle");
  assert.equal(ov.state.projectId, null);
});

test("auto mode moves to the next question after the results pause", async () => {
  const store = memoryStore();
  const c = client(createApi({ store, env: { ADMIN_PASSWORD: "pw" } }));
  await c.login("pw");
  await useQuestions(
    c,
    [
      { text: "ข้อหนึ่ง", type: "wordcloud", seconds: 10, maxWords: 1 },
      { text: "ข้อสอง", type: "wordcloud", seconds: 10, maxWords: 1 },
    ],
    { advance: "auto", resultSeconds: 3 },
  );
  await c.call("POST", "/admin/control", { action: "start" });
  // Pretend question 1 ended 4 seconds ago (results pause is 3 s).
  const st = JSON.parse(store.data.get("state"));
  st.startedAt = Date.now() - 14000;
  st.endsAt = Date.now() - 4000;
  store.data.set("state", JSON.stringify(st));
  let s = (await c.call("GET", "/state", null, false)).body;
  assert.equal(s.qIndex, 1);
  assert.equal(s.question.text, "ข้อสอง");
  assert.ok(s.nextAt > s.endsAt);
  // Long after the last question: game ends by itself.
  const st2 = JSON.parse(store.data.get("state"));
  st2.endsAt = Date.now() - 60000;
  store.data.set("state", JSON.stringify(st2));
  s = (await c.call("GET", "/state", null, false)).body;
  assert.equal(s.phase, "ended");
});

test("manual mode waits for the admin", async () => {
  const store = memoryStore();
  const c = client(createApi({ store, env: { ADMIN_PASSWORD: "pw" } }));
  await c.login("pw");
  await useQuestions(c, [
    { text: "1", type: "wordcloud", seconds: 10, maxWords: 1 },
    { text: "2", type: "wordcloud", seconds: 10, maxWords: 1 },
  ]);
  await c.call("POST", "/admin/control", { action: "start" });
  const st = JSON.parse(store.data.get("state"));
  st.startedAt = Date.now() - 610000;
  st.endsAt = Date.now() - 600000;
  store.data.set("state", JSON.stringify(st));
  let s = (await c.call("GET", "/state", null, false)).body;
  assert.equal(s.phase, "closed");
  assert.equal(s.qIndex, 0);
  await c.call("POST", "/admin/control", { action: "next" });
  s = (await c.call("GET", "/state", null, false)).body;
  assert.equal(s.qIndex, 1);
});

test("stop clears players and answers", async () => {
  const store = memoryStore();
  const c = client(createApi({ store, env: { ADMIN_PASSWORD: "pw" } }));
  await c.login("pw");
  const qid = (await useQuestions(c, [{ text: "q", type: "wordcloud", seconds: 30, maxWords: 1 }])).body.questions[0].id;
  const p = (await c.call("POST", "/join", { name: "a" }, false)).body;
  await c.call("POST", "/admin/control", { action: "start" });
  skipCountdown(store);
  assert.equal((await c.call("POST", "/answer", { pid: p.pid, questionId: qid, values: ["x"] }, false)).status, 200);
  await c.call("POST", "/admin/control", { action: "stop" });
  const ov = (await c.call("GET", "/admin/overview")).body;
  assert.equal(ov.state.phase, "idle");
  assert.equal(ov.players.length, 0);
  assert.equal([...store.data.keys()].filter((k) => k.startsWith("answers/") || k.startsWith("players/")).length, 0);
  assert.equal(ov.projects[0].questions.length, 1); // questions are kept
});

test("players and answers are deleted 10 minutes after the game ends", async () => {
  const store = memoryStore();
  const api = createApi({ store, env: { ADMIN_PASSWORD: "pw" } });
  const c = client(api);
  await c.login("pw");
  const qid = (await useQuestions(c, [{ text: "q", type: "wordcloud", seconds: 30, maxWords: 1 }])).body.questions[0].id;
  const p = (await c.call("POST", "/join", { name: "a", projectId: "p-test1" }, false)).body;
  await c.call("POST", "/admin/control", { action: "start" });
  skipCountdown(store);
  await c.call("POST", "/answer", { pid: p.pid, questionId: qid, values: ["x"] }, false);
  await c.call("POST", "/admin/control", { action: "next" }); // past the last question -> ended
  let ov = (await c.call("GET", "/admin/overview")).body;
  assert.equal(ov.state.phase, "ended");
  assert.equal(ov.players.length, 1); // still there right after the finale
  // 11 minutes later (no browser open): the scheduled sweep clears everything.
  const st = JSON.parse(store.data.get("state"));
  st.endedAt = Date.now() - 11 * 60 * 1000;
  store.data.set("state", JSON.stringify(st));
  assert.equal(await api.sweep(), "idle");
  assert.equal([...store.data.keys()].filter((k) => /^(players|answers|clusters)\//.test(k)).length, 0);
  ov = (await c.call("GET", "/admin/overview")).body;
  assert.equal(ov.projects[0].questions.length, 1); // questions are kept
});

test("a room left untouched for 12 hours is cleared", async () => {
  const store = memoryStore();
  const api = createApi({ store, env: { ADMIN_PASSWORD: "pw" } });
  const c = client(api);
  await c.login("pw");
  await useQuestions(c, [{ text: "q", type: "wordcloud", seconds: 30, maxWords: 1 }]);
  await c.call("POST", "/join", { name: "a", projectId: "p-test1" }, false);
  assert.equal(await api.sweep(), "lobby");
  const st = JSON.parse(store.data.get("state"));
  st.updatedAt = Date.now() - 13 * 60 * 60 * 1000;
  store.data.set("state", JSON.stringify(st));
  assert.equal(await api.sweep(), "idle");
  assert.equal([...store.data.keys()].filter((k) => k.startsWith("players/")).length, 0);
});
