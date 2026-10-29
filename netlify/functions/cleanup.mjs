// Scheduled cleanup: every 15 minutes (UTC cron), apply the automatic-clear
// rules so players and answers are deleted even if every browser was closed.
import { getStore } from "@netlify/blobs";
import { createApi } from "../lib/core.mjs";

export default async () => {
  const store = getStore({ name: "wordcloud-live", consistency: "strong" });
  const api = createApi({ store, env: {} });
  const phase = await api.sweep();
  console.log("cleanup checked, phase:", phase);
};

export const config = { schedule: "*/15 * * * *" };
