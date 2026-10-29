import { getStore } from "@netlify/blobs";
import { createApi } from "../lib/core.mjs";

export default async (req) => {
  const store = getStore({ name: "wordcloud-live", consistency: "strong" });
  const api = createApi({
    store,
    env: {
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    },
  });
  return api(req);
};

export const config = { path: "/api/*" };
