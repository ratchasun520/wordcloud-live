// Vercel entry: every /api/* request is rewritten here (see vercel.json).
// The game logic is shared with Netlify in netlify/lib/core.mjs; only the
// storage differs (Upstash Redis instead of Netlify Blobs).
import { createApi } from "../netlify/lib/core.mjs";
import { redisConfig, redisStore } from "../vercel/redis-store.mjs";

let api = null;
function getApi() {
  if (api) return api;
  const cfg = redisConfig(process.env);
  if (!cfg) return null;
  api = createApi({ store: redisStore(cfg), env: process.env });
  return api;
}

// vercel.json passes the original path as ?__p=…; put it back on the URL.
function originalRequest(req) {
  const url = new URL(req.url);
  const p = url.searchParams.get("__p");
  if (p == null) return req;
  url.searchParams.delete("__p");
  url.pathname = "/api/" + p.replace(/^\/+/, "");
  return new Request(url, req);
}

export default {
  async fetch(request) {
    const a = getApi();
    if (!a) {
      return Response.json(
        { error: "ยังไม่ได้เชื่อมฐานข้อมูล Upstash Redis กับโปรเจกต์ใน Vercel" },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
    const req = originalRequest(request);
    // Daily Vercel cron: applies the automatic-clear rules even when nobody
    // has the site open.
    if (new URL(req.url).pathname === "/api/cleanup") {
      const phase = await a.sweep();
      return Response.json({ ok: true, phase }, { headers: { "cache-control": "no-store" } });
    }
    return a(req);
  },
};
