// Store for Vercel: Upstash Redis over its REST API (plain fetch, no package).
// Same interface as Netlify Blobs as used by core.mjs, plus getMany().
//
// Env (set automatically when Upstash Redis is connected to the project):
//   KV_REST_API_URL + KV_REST_API_TOKEN, or
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN

const NS = "wc:";
// Players, answers and AI groups expire on their own after a day, even if the
// app never gets the chance to delete them.
const SESSION_TTL_S = 24 * 60 * 60;
// The game state is read on every poll. Keeping it for a moment in memory cuts
// Redis commands a lot; writes from this instance update the copy at once.
const STATE_CACHE_MS = 700;

export function redisConfig(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

const globEscape = (s) => s.replace(/[*?[\]\\]/g, (c) => "\\" + c);
const isSessionKey = (k) => /^(players|answers|clusters)\//.test(k);

export function redisStore({ url, token, fetchImpl = globalThis.fetch }) {
  let stateCache = null; // { raw, at }

  async function call(cmd) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error("redis: " + (data.error || res.status));
    return data.result;
  }

  const parse = (raw) => {
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  return {
    async get(key) {
      if (key === "state" && stateCache && Date.now() - stateCache.at < STATE_CACHE_MS) {
        return parse(stateCache.raw);
      }
      const raw = await call(["GET", NS + key]);
      if (key === "state") stateCache = { raw, at: Date.now() };
      return parse(raw);
    },
    async getMany(keys) {
      const rows = await call(["MGET", ...keys.map((k) => NS + k)]);
      return (rows || []).map(parse);
    },
    async setJSON(key, value) {
      const raw = JSON.stringify(value);
      const cmd = ["SET", NS + key, raw];
      if (isSessionKey(key)) cmd.push("EX", String(SESSION_TTL_S));
      await call(cmd);
      if (key === "state") stateCache = { raw, at: Date.now() };
    },
    async list({ prefix = "" } = {}) {
      const keys = await call(["KEYS", NS + globEscape(prefix) + "*"]);
      return { blobs: (keys || []).map((k) => ({ key: k.slice(NS.length) })) };
    },
    async deleteMany(keys) {
      for (let i = 0; i < keys.length; i += 500) {
        await call(["DEL", ...keys.slice(i, i + 500).map((k) => NS + k)]);
      }
      if (keys.includes("state")) stateCache = null;
    },
    async delete(key) {
      await call(["DEL", NS + key]);
      if (key === "state") stateCache = null;
    },
  };
}
