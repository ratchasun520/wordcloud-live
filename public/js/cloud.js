// Live word cloud: words sized by how many people gave them, laid out on a
// spiral from the centre. Existing words glide to new positions and grow.

const PALETTE = 6;

function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

export class WordCloud {
  // opts.sizeFloor (0..1): smallest word as a share of the size range, for clouds
  // where every word should stay readable (e.g. participant names).
  constructor(el, opts = {}) {
    this.el = el;
    this.sizeFloor = opts.sizeFloor || 0;
    this.nodes = new Map();
    this.counts = new Map();
    this.centers = new Map(); // last centre of each word, so words stay put between updates
    this.words = [];
    this.measure = document.createElement("span");
    this.measure.className = "measure";
    this.measure.setAttribute("aria-hidden", "true");
    el.append(this.measure);
    this.empty = document.createElement("div");
    this.empty.className = "cloud-empty";
    this.empty.textContent = "รอคำตอบแรก…";
    el.append(this.empty);
    let t = null;
    this.ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => this.layout(), 120);
    });
    this.ro.observe(el);
    if (document.fonts) {
      const relayout = () => this.layout();
      document.fonts.ready.then(relayout);
      document.fonts.addEventListener?.("loadingdone", relayout);
    }
  }

  setEmptyText(text) {
    this.empty.textContent = text;
  }

  // words: [{ text, count }]
  update(words) {
    const sig = JSON.stringify(words.map((w) => [w.text, w.count]).sort());
    if (sig === this.sig) return;
    this.sig = sig;
    this.words = words;
    this.layout();
  }

  clear() {
    for (const n of this.nodes.values()) n.remove();
    this.nodes.clear();
    this.counts.clear();
    this.centers.clear();
    this.words = [];
    this.sig = "";
    this.empty.hidden = false;
  }

  layout() {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W || !H) return;
    const words = [...this.words]
      .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "th"))
      .slice(0, 150);
    this.empty.hidden = words.length > 0;

    const keep = new Set(words.map((w) => w.text));
    for (const [text, node] of this.nodes) {
      if (!keep.has(text)) {
        node.classList.add("leave");
        setTimeout(() => node.remove(), 450);
        this.nodes.delete(text);
        this.counts.delete(text);
      }
    }
    if (!words.length) return;

    let placed = null;
    let scale = 1;
    for (let attempt = 0; attempt < 10 && !placed; attempt++) {
      placed = this.place(words, W, H, scale);
      scale *= 0.86;
    }
    if (!placed) return;
    this.centers = new Map(placed.lastCenters || []);

    placed.forEach((p, rank) => {
      let node = this.nodes.get(p.text);
      const fresh = !node;
      if (fresh) {
        node = document.createElement("span");
        node.className = "cw enter";
        node.textContent = p.text;
        node.style.color = `var(--w${(hash(p.text) % PALETTE) + 1})`;
        node.style.fontSize = p.fs + "px";
        node.style.transform = `translate(${p.x}px, ${p.y}px)`;
        this.el.append(node);
        this.nodes.set(p.text, node);
        requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("enter")));
      } else {
        node.style.fontSize = p.fs + "px";
        node.style.transform = `translate(${p.x}px, ${p.y}px)`;
        if (this.counts.get(p.text) !== p.count) {
          node.classList.remove("bump");
          void node.offsetWidth;
          node.classList.add("bump");
        }
      }
      node.style.fontWeight = rank < 3 ? 700 : rank < 12 ? 600 : 500;
      node.style.zIndex = String(1000 - rank);
      node.title = `${p.text} · ${p.count} คน`;
      this.counts.set(p.text, p.count);
    });
  }

  place(words, W, H, scale) {
    const max = words[0].count;
    const min = words[words.length - 1].count;
    const base = Math.min(W, H * 1.7);
    const minFs = Math.max(13, base * 0.026) * scale;
    const maxFs = Math.max(minFs * 1.4, base * 0.14 * scale);
    const cx = W / 2;
    const cy = H / 2;
    const rects = [];
    const out = [];
    const pad = 3;
    for (const w of words) {
      const raw = max === min ? (words.length === 1 ? 1 : 0.4) : (w.count - min) / (max - min);
      const t = this.sizeFloor + (1 - this.sizeFloor) * raw;
      const fs = Math.round(minFs + (maxFs - minFs) * Math.sqrt(t));
      this.measure.style.fontSize = fs + "px";
      this.measure.style.fontWeight = out.length < 3 ? 700 : 600;
      this.measure.textContent = w.text;
      const bw = this.measure.offsetWidth;
      const bh = this.measure.offsetHeight;
      if (bw > W - 8) return null;
      const collides = (x, y) => {
        for (const q of rects) {
          if (x < q.x + q.w + pad && x + bw + pad > q.x && y < q.y + q.h + pad && y + bh + pad > q.y) return true;
        }
        return false;
      };
      const inside = (x, y) => x >= 4 && y >= 4 && x + bw <= W - 4 && y + bh <= H - 4;
      let found = null;
      // Keep a word where it was if it still fits there (it may have grown).
      const prev = this.centers.get(w.text);
      if (prev && prev.W === W && prev.H === H) {
        const x = prev.cx - bw / 2;
        const y = prev.cy - bh / 2;
        if (inside(x, y) && !collides(x, y)) found = { x, y };
        // Grew into a neighbour: look for room close to where it was first.
        for (let i = 1; i < 700 && !found; i++) {
          const a2 = i * 0.35;
          const r2 = i * 0.32;
          const nx = prev.cx + r2 * Math.cos(a2) * 1.4 - bw / 2;
          const ny = prev.cy + r2 * Math.sin(a2) * 0.8 - bh / 2;
          if (inside(nx, ny) && !collides(nx, ny)) found = { x: nx, y: ny };
        }
      }
      const seed = (hash(w.text) % 628) / 100;
      for (let i = 0; i < 5000 && !found; i++) {
        const a = seed + i * 0.17;
        const r = i * 0.55;
        const x = cx + r * Math.cos(a) * (W / H > 1 ? 1.5 : 1) - bw / 2;
        const y = cy + r * Math.sin(a) * 0.9 - bh / 2;
        if (x < 4 || y < 4 || x + bw > W - 4 || y + bh > H - 4) {
          if (r > Math.max(W, H)) break;
          continue;
        }
        let hit = false;
        for (const q of rects) {
          if (x < q.x + q.w + pad && x + bw + pad > q.x && y < q.y + q.h + pad && y + bh + pad > q.y) {
            hit = true;
            break;
          }
        }
        if (!hit) {
          found = { x, y };
          break;
        }
      }
      if (!found) return null;
      out.lastCenters = out.lastCenters || [];
      out.lastCenters.push([w.text, { cx: found.x + bw / 2, cy: found.y + bh / 2, W, H }]);
      rects.push({ x: found.x, y: found.y, w: bw, h: bh });
      out.push({ text: w.text, count: w.count, fs, x: Math.round(found.x), y: Math.round(found.y) });
    }
    return out;
  }
}
