// Local preview without Netlify: serves public/ and runs the API with an
// in-memory store. Data is lost when the server stops.
//   ADMIN_PASSWORD=1234 node scripts/dev-server.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "../netlify/lib/core.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const port = Number(process.env.PORT) || 8888;

export function memoryStore() {
  const data = new Map();
  return {
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

const api = createApi({
  store: memoryStore(),
  env: {
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "1234",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  },
});

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const pages = { "/": "/index.html", "/admin": "/admin.html", "/play": "/play.html" };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await api(
        new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }),
      );
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const p = pages[url.pathname] || url.pathname;
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const buf = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("ไม่พบหน้า");
    }
  })
  .listen(port, () => console.log(`เปิด http://localhost:${port}/admin (รหัสผ่าน: ${process.env.ADMIN_PASSWORD || "1234"})`));
