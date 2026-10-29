// Small motion helpers shared by the pages.

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Set text and replay the "pop" animation only when the value changes.
export function pop(el, value) {
  const text = String(value);
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove("pop");
  void el.offsetWidth;
  el.classList.add("pop");
}

// Replay a one-shot animation class.
export function retrigger(el, cls = "rise") {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// Stagger children in with the "rise" entrance.
export function stagger(nodes, startIndex = 0) {
  [...nodes].forEach((n, i) => {
    n.style.setProperty("--i", String(i + startIndex));
    retrigger(n, "rise");
  });
}

function palette() {
  const cs = getComputedStyle(document.documentElement);
  return ["--w1", "--w2", "--w3", "--w4", "--w5", "--w6"].map((v) => cs.getPropertyValue(v).trim() || "#0b6e5f");
}

// Confetti burst from a point (defaults to the top centre of the screen).
export function confetti({ x, y, count = 90, power = 1 } = {}) {
  if (reducedMotion()) return;
  const canvas = document.createElement("canvas");
  canvas.className = "fx-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = innerWidth;
  const H = innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const colors = palette();
  const ox = x ?? W / 2;
  const oy = y ?? H * 0.3;
  const parts = Array.from({ length: count }, () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
    const v = (6 + Math.random() * 9) * power;
    return {
      x: ox,
      y: oy,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      w: 5 + Math.random() * 6,
      h: 3 + Math.random() * 5,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[Math.floor(Math.random() * colors.length)],
      round: Math.random() < 0.35,
    };
  });
  const start = performance.now();
  const life = 2400;
  function frame(t) {
    const k = (t - start) / life;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.32;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - k * k);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.h, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (k < 1) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

export const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------- "thank you" finale ----------

// Split text into grapheme clusters so Thai vowels and tone marks stay on their letter.
function graphemes(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return [...new Intl.Segmenter("th", { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  }
  return Array.from(text);
}

// Fill a heading with per-letter spans that pop in one by one, then light it up.
export function letterIn(el, lines, startDelay = 0) {
  el.textContent = "";
  el.classList.remove("lit");
  let i = 0;
  for (const line of lines) {
    const row = document.createElement("span");
    row.className = "tl";
    for (const g of graphemes(line)) {
      const s = document.createElement("span");
      s.className = "g";
      s.textContent = g === " " ? " " : g;
      s.style.animationDelay = `${startDelay + i * 55}ms`;
      row.append(s);
      i++;
    }
    el.append(row);
  }
  el.setAttribute("aria-label", lines.join(" "));
  const total = startDelay + i * 55 + 900;
  clearTimeout(el._litTimer);
  el._litTimer = setTimeout(() => el.classList.add("lit"), reducedMotion() ? 0 : total);
}

// Twinkling four-point stars scattered across a container.
export function sparkles(container, count = 34) {
  container.textContent = "";
  for (let i = 0; i < count; i++) {
    const s = document.createElement("i");
    const size = 6 + Math.random() * 16;
    s.style.left = `${Math.random() * 100}%`;
    s.style.top = `${Math.random() * 100}%`;
    s.style.width = s.style.height = `${size}px`;
    s.style.animationDelay = `${(Math.random() * 3).toFixed(2)}s`;
    s.style.animationDuration = `${(2 + Math.random() * 2.5).toFixed(2)}s`;
    s.style.setProperty("--c", `var(--w${1 + (i % 6)})`);
    container.append(s);
  }
}

// Count a number up from zero.
export function countUp(el, to, ms = 1400) {
  const target = Number(to) || 0;
  if (reducedMotion() || target === 0) {
    el.textContent = String(target);
    return;
  }
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = String(Math.round(target * eased));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
