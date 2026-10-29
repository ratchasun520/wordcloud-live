// Shared helpers for the admin and player pages.

// Must stay identical to norm() in netlify/lib/core.mjs.
export function norm(s) {
  const base = String(s ?? "").normalize("NFC").toLowerCase();
  const stripped = base
    .replace(/[\s​‌‍﻿]+/g, "")
    .replace(/[!-/:-@[-`{-~‘’“”…·•、。，]+/g, "");
  return stripped || base.trim();
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body, token } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  let res;
  try {
    res = await fetch("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  } catch {
    throw new ApiError("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กำลังลองใหม่", 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new ApiError((data && data.error) || `เกิดข้อผิดพลาด (${res.status})`, res.status);
  return data;
}

export const storage = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

// Server clock offset so every device counts down to the same second.
export const clock = {
  offset: 0,
  sync(serverNow, sentAt, receivedAt) {
    const mid = (sentAt + receivedAt) / 2;
    const next = serverNow - mid;
    this.offset = this.offset === 0 ? next : this.offset * 0.7 + next * 0.3;
  },
  now() {
    return Date.now() + this.offset;
  },
};

export const TYPE_LABEL = { wordcloud: "Word Cloud", choice: "ตัวเลือก", open: "คำตอบยาว" };

export function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function secondsLeft(endsAt) {
  return Math.max(0, Math.ceil((endsAt - clock.now()) / 1000));
}
