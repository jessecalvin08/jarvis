// The neural core: a rotating 3D "brain" of named regions, wrapped in arc-reactor rings.
// Regions light up when Jarvis uses the tools they stand for, so you can watch it think.

/** Brain regions, placed roughly where they sit in a real brain (x: right, y: up, z: towards you). */
export const REGIONS = [
  { key: "prefrontal", name: "PREFRONTAL", role: "Reasoning", color: "#fbbf24", pos: [0, 0.3, 1] },
  { key: "language", name: "LANGUAGE", role: "Hearing & speech", color: "#38d6ff", pos: [-1, -0.05, 0.3] },
  { key: "motor", name: "MOTOR CORTEX", role: "Apps & system", color: "#fb7185", pos: [0.05, 1, 0.15] },
  { key: "association", name: "ASSOCIATION", role: "Files & folders", color: "#a78bfa", pos: [1, 0.1, 0.25] },
  { key: "sensory", name: "SENSORY CORTEX", role: "Web & weather", color: "#34d399", pos: [0.35, 0.75, -0.6] },
  { key: "visual", name: "VISUAL CORTEX", role: "Screen & display", color: "#4f7dff", pos: [0, 0.05, -1] },
  { key: "hippocampus", name: "HIPPOCAMPUS", role: "Memory", color: "#e879f9", pos: [0.25, -0.75, 0.35] },
  { key: "comms", name: "COMMS RELAY", role: "Email", color: "#22d3ee", pos: [-0.65, -0.35, -0.65] },
  { key: "cerebellum", name: "CEREBELLUM", role: "Extensions (MCP)", color: "#f97316", pos: [0.3, -0.85, -0.45] },
];
const ARC_PALETTE = ["#38d6ff", "#22d3ee", "#7dd3fc", "#0ea5e9", "#67e8f9", "#a5f3fc", "#38bdf8", "#5eead4", "#bae6fd"];

/** Which region a tool belongs to. */
export function regionForTool(name, category) {
  if (name === "look_at_screen" || category === "display") return "visual";
  return (
    { files: "association", apps: "motor", system: "motor", web: "sensory", memory: "hippocampus", comms: "comms", mcp: "cerebellum" }[category] ??
    "prefrontal"
  );
}

const STATE_COLOR = {
  idle: [56, 214, 255],
  listening: [52, 211, 153],
  thinking: [251, 191, 36],
  working: [255, 159, 67],
  speaking: [56, 214, 255],
  error: [251, 77, 109],
};
const STATE_REGION = { thinking: "prefrontal", working: "prefrontal", listening: "language", speaking: "language" };
const SPIN = { idle: 0.07, listening: 0.1, thinking: 0.36, working: 0.3, speaking: 0.16, error: 0.04 };
const FIRE_RATE = { idle: 5, listening: 8, thinking: 30, working: 24, speaking: 12, error: 2 };

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgba = ([r, g, b], a) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
const norm = ([x, y, z]) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

export class Core {
  constructor(canvas, readout) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.readout = readout;
    this.state = "idle";
    this.level = 0;
    this.targetLevel = 0;
    this.spectrum = null;
    this.color = [...STATE_COLOR.idle];
    this.offsetX = 0;
    this.rotY = 0;
    this.t = 0;
    this.flashAmt = 0;
    this.pulses = [];
    this.bolts = [];
    this.spawnDebt = 0;
    this.kiosk = false;
    this.labels = true;
    this.regions = REGIONS.map((r) => ({ ...r, pos: norm(r.pos), nodes: [], running: new Map(), glow: 0, boost: 0, firing: 0, debt: 0 }));
    this.build(420);
    this.setTheme("neural");

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.last = performance.now();
    requestAnimationFrame((now) => this.frame(now));
    setInterval(() => this.updateStats(), 250);
  }

  build(n) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    this.nodes = [];
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = golden * i;
      // Mostly on the shell, some inside for depth.
      const depth = Math.random() < 0.18 ? 0.35 + Math.random() * 0.45 : 0.88 + Math.random() * 0.16;
      const jitter = () => (Math.random() - 0.5) * 0.08;
      const p = [(Math.cos(th) * r + jitter()) * depth, (y + jitter()) * depth, (Math.sin(th) * r + jitter()) * depth];
      const unit = norm(p);
      let best = 0;
      let bestDot = -Infinity;
      this.regions.forEach((reg, k) => {
        const d = reg.pos[0] * unit[0] + reg.pos[1] * unit[1] + reg.pos[2] * unit[2];
        if (d > bestDot) {
          bestDot = d;
          best = k;
        }
      });
      this.regions[best].nodes.push(i);
      this.nodes.push({ p, cluster: best, act: 0, sx: 0, sy: 0, z: 0 });
    }
    const edges = new Set();
    this.nodes.forEach((a, i) => {
      const dists = this.nodes
        .map((b, j) => [j, (a.p[0] - b.p[0]) ** 2 + (a.p[1] - b.p[1]) ** 2 + (a.p[2] - b.p[2]) ** 2])
        .filter(([j]) => j !== i)
        .sort((x, y) => x[1] - y[1]);
      for (const [j] of dists.slice(0, 3)) edges.add(i < j ? `${i}-${j}` : `${j}-${i}`);
      // A few long-range links inside the same region make it look like a brain, not a mesh.
      if (Math.random() < 0.14) {
        const far = dists.slice(8, 40).find(([j]) => this.nodes[j].cluster === a.cluster);
        if (far) edges.add(i < far[0] ? `${i}-${far[0]}` : `${far[0]}-${i}`);
      }
    });
    this.edges = [...edges].map((k) => k.split("-").map(Number));
    this.adj = this.nodes.map(() => []);
    this.edges.forEach(([a, b], idx) => {
      this.adj[a].push(idx);
      this.adj[b].push(idx);
    });
  }

  setTheme(name) {
    this.theme = name === "arc" ? "arc" : "neural";
    this.palette = this.regions.map((r, i) => hexToRgb(this.theme === "arc" ? ARC_PALETTE[i % ARC_PALETTE.length] : r.color));
  }

  setState(state) {
    this.state = STATE_COLOR[state] ? state : "idle";
  }

  setLevel(v) {
    this.targetLevel = Math.max(0, Math.min(1, v));
  }

  setSpectrum(arr) {
    this.spectrum = arr;
  }

  setCardsVisible(visible) {
    this.cardsVisible = visible;
  }

  setKiosk(on) {
    this.kiosk = on;
  }

  flash() {
    this.flashAmt = 1;
  }

  region(key) {
    return this.regions.find((r) => r.key === key);
  }

  /** A tool started: its region lights up until toolEnd with the same id. */
  toolStart(id, name, category) {
    const r = this.region(regionForTool(name, category));
    r.running.set(id, name);
    r.boost = 1;
  }

  toolEnd(id) {
    for (const r of this.regions) if (r.running.delete(id)) r.boost = Math.max(r.boost, 0.8);
  }

  /** A short burst of activity in one region (a memory saved, mail arrived, a card shown). */
  pulseRegion(key, amount = 1) {
    const r = this.region(key);
    if (r) r.boost = Math.max(r.boost, amount);
  }

  regionStats() {
    return this.regions.map((r, i) => ({
      key: r.key,
      name: r.name,
      role: r.role,
      color: this.palette[i],
      neurons: r.nodes.length,
      firing: r.firing,
      glow: r.glow,
      tool: [...r.running.values()].at(-1) ?? null,
    }));
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = this.canvas.getBoundingClientRect();
    this.w = width;
    this.h = height;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  spawnPulse(fromNode) {
    const from = fromNode ?? ((Math.random() * this.nodes.length) | 0);
    const options = this.adj[from];
    if (!options.length) return;
    const e = options[(Math.random() * options.length) | 0];
    const [a, b] = this.edges[e];
    this.pulses.push({ a: from, b: from === a ? b : a, t: 0, speed: 1.2 + Math.random() * 1.8, hops: 0 });
    this.nodes[from].act = 1;
  }

  /** A jagged discharge between two neurons of an active region. */
  spawnBolt(r) {
    if (r.nodes.length < 2) return;
    const a = r.nodes[(Math.random() * r.nodes.length) | 0];
    const b = r.nodes[(Math.random() * r.nodes.length) | 0];
    if (a === b) return;
    this.bolts.push({ a, b, life: 0.18 + Math.random() * 0.12, age: 0, seed: Math.random() * 1000, cluster: this.nodes[a].cluster });
    this.nodes[a].act = 1;
    this.nodes[b].act = 1;
  }

  updateStats() {
    let total = 0;
    for (const r of this.regions) {
      const lit = r.nodes.filter((i) => this.nodes[i].act > 0.35).length;
      r.firing = r.nodes.length ? (lit / r.nodes.length) * 100 : 0;
      total += lit;
    }
    this.totalFiring = (total / this.nodes.length) * 100;
    if (this.readout) this.readout.textContent = `NODES ${this.nodes.length} · LINKS ${this.edges.length} · FIRING ${this.totalFiring.toFixed(1)}%`;
  }

  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    this.draw(dt);
    requestAnimationFrame((n) => this.frame(n));
  }

  draw(dt) {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    const state = this.state;

    // Smooth everything so state changes glide rather than snap.
    const target = STATE_COLOR[state];
    for (let i = 0; i < 3; i++) this.color[i] += (target[i] - this.color[i]) * Math.min(1, dt * 4);
    const attack = this.targetLevel > this.level ? 18 : 5;
    this.level += (this.targetLevel - this.level) * Math.min(1, dt * attack);
    this.flashAmt *= Math.pow(0.02, dt);
    const targetOffset = this.cardsVisible && w > 820 ? -w * (this.kiosk ? 0.1 : 0.14) : 0;
    this.offsetX += (targetOffset - this.offsetX) * Math.min(1, dt * 3);

    // Region activity: running tools, the current state, and short boosts all feed a smoothed glow.
    const stateRegion = STATE_REGION[state];
    for (const r of this.regions) {
      const want = Math.max(r.running.size ? 1 : 0, r.key === stateRegion ? 0.75 : 0, r.boost);
      r.glow += (want - r.glow) * Math.min(1, dt * (want > r.glow ? 8 : 2.5));
      r.boost *= Math.pow(0.25, dt);
      r.debt += dt * r.glow * 45;
      while (r.debt > 1 && r.nodes.length) {
        r.debt -= 1;
        if (this.pulses.length < 320) this.spawnPulse(r.nodes[(Math.random() * r.nodes.length) | 0]);
      }
      if (r.glow > 0.55 && Math.random() < dt * 9 * r.glow) this.spawnBolt(r);
    }

    const lvl = this.level;
    const col = this.color;
    const cx = w / 2 + this.offsetX;
    const cy = (h - 120) / 2 + 14;
    const base = Math.min(w * 0.85, h - 150) * (this.kiosk ? 0.34 : 0.3);
    const R = base * (1 + lvl * 0.1 + Math.sin(this.t * 1.3) * 0.012);
    this.rotY += dt * (SPIN[state] + lvl * 0.25);
    const rotX = 0.38 + Math.sin(this.t * 0.21) * 0.12;

    ctx.clearRect(0, 0, w, h);

    // Project nodes.
    const cyR = Math.cos(this.rotY), syR = Math.sin(this.rotY), cxR = Math.cos(rotX), sxR = Math.sin(rotX);
    for (const n of this.nodes) {
      const [x, y, z] = n.p;
      const x1 = x * cyR + z * syR;
      const z1 = -x * syR + z * cyR;
      const y2 = y * cxR - z1 * sxR;
      const z2 = y * sxR + z1 * cxR;
      const persp = 2.6 / (2.6 - z2);
      n.sx = cx + x1 * R * persp;
      n.sy = cy - y2 * R * persp;
      n.z = z2;
      n.act *= Math.pow(0.08, dt);
    }

    ctx.globalCompositeOperation = "lighter";

    // Ambient glow behind the core.
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
    glow.addColorStop(0, rgba(col, 0.1 + lvl * 0.18 + this.flashAmt * 0.3));
    glow.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.25, 0, Math.PI * 2);
    ctx.fill();

    // Synapses, batched by region and depth for speed; active regions burn brighter.
    ctx.lineWidth = 0.8;
    for (let bucket = 0; bucket < 3; bucket++) {
      for (let c = 0; c < this.regions.length; c++) {
        ctx.beginPath();
        let any = false;
        for (const [a, b] of this.edges) {
          const na = this.nodes[a];
          if (na.cluster !== c) continue;
          const nb = this.nodes[b];
          const depth = (na.z + nb.z) / 2;
          const bk = depth < -0.33 ? 0 : depth < 0.33 ? 1 : 2;
          if (bk !== bucket) continue;
          ctx.moveTo(na.sx, na.sy);
          ctx.lineTo(nb.sx, nb.sy);
          any = true;
        }
        if (any) {
          const g = this.regions[c].glow;
          ctx.strokeStyle = rgba(this.palette[c], [0.05, 0.12, 0.24][bucket] + lvl * 0.08 + g * [0.08, 0.22, 0.4][bucket]);
          ctx.stroke();
        }
      }
    }

    // Background firing; each arrival can cascade onward like a real neuron.
    this.spawnDebt += dt * (FIRE_RATE[state] + lvl * 90);
    while (this.spawnDebt > 1) {
      this.spawnDebt -= 1;
      if (this.pulses.length < 320) this.spawnPulse();
    }
    const cascade = state === "thinking" || state === "working" ? 0.5 : 0.28;
    const next = [];
    for (const p of this.pulses) {
      p.t += dt * p.speed;
      const A = this.nodes[p.a];
      const B = this.nodes[p.b];
      if (p.t >= 1) {
        B.act = 1;
        if (p.hops < 4 && Math.random() < cascade && next.length < 340) {
          const options = this.adj[p.b];
          const e = this.edges[options[(Math.random() * options.length) | 0]];
          next.push({ a: p.b, b: e[0] === p.b ? e[1] : e[0], t: 0, speed: p.speed, hops: p.hops + 1 });
        }
        continue;
      }
      const x = A.sx + (B.sx - A.sx) * p.t;
      const y = A.sy + (B.sy - A.sy) * p.t;
      const c = this.palette[A.cluster];
      const zf = ((A.z + B.z) / 2 + 1) / 2;
      ctx.fillStyle = rgba(c, 0.18 * zf);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba([255, 255, 255], 0.55 + 0.45 * zf);
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
      next.push(p);
    }
    this.pulses = next;

    // Lightning between neurons of busy regions.
    const bolts = [];
    for (const b of this.bolts) {
      b.age += dt;
      if (b.age > b.life) continue;
      bolts.push(b);
      const A = this.nodes[b.a];
      const B = this.nodes[b.b];
      const fade = 1 - b.age / b.life;
      const dx = B.sx - A.sx;
      const dy = B.sy - A.sy;
      const len = Math.hypot(dx, dy) || 1;
      const segs = Math.max(4, Math.min(14, Math.round(len / 14)));
      ctx.beginPath();
      ctx.moveTo(A.sx, A.sy);
      for (let s = 1; s < segs; s++) {
        const f = s / segs;
        const jag = Math.sin(b.seed + s * 12.9898 + this.t * 60) * len * 0.09;
        ctx.lineTo(A.sx + dx * f + (-dy / len) * jag, A.sy + dy * f + (dx / len) * jag);
      }
      ctx.lineTo(B.sx, B.sy);
      const c = this.palette[b.cluster];
      ctx.strokeStyle = rgba(c, 0.35 * fade);
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = rgba([255, 255, 255], 0.85 * fade);
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
    this.bolts = bolts;

    // Neurons.
    for (const n of this.nodes) {
      const zf = (n.z + 1) / 2;
      const c = this.palette[n.cluster];
      const g = this.regions[n.cluster].glow;
      const size = (0.7 + zf * 1.5) * (1 + n.act * 1.4 + g * 0.3);
      if (n.act > 0.2) {
        ctx.fillStyle = rgba(c, 0.22 * n.act);
        ctx.beginPath();
        ctx.arc(n.sx, n.sy, size * 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = rgba(c, 0.3 + zf * 0.6 + n.act * 0.3 + g * 0.2);
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, size, 0, Math.PI * 2);
      ctx.fill();
    }

    // The heart: a white-hot core tinted by state.
    const coreR = R * (0.13 + lvl * 0.09 + this.flashAmt * 0.05);
    const heart = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.6);
    heart.addColorStop(0, "rgba(255,255,255,0.95)");
    heart.addColorStop(0.25, rgba(col, 0.75));
    heart.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = heart;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 2.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = "source-over";
    if (this.labels && w > 520) this.drawLabels(cx, cy, R);
    this.drawRings(cx, cy, R, dt);
  }

  /** Region names float over their part of the brain, like an annotated scan. */
  drawLabels(cx, cy, R) {
    const { ctx } = this;
    ctx.textBaseline = "middle";
    this.regions.forEach((r, i) => {
      if (!r.nodes.length) return;
      let x = 0;
      let y = 0;
      let z = 0;
      for (const idx of r.nodes) {
        const n = this.nodes[idx];
        x += n.sx;
        y += n.sy;
        z += n.z;
      }
      x /= r.nodes.length;
      y /= r.nodes.length;
      z /= r.nodes.length;
      const facing = Math.max(0, Math.min(1, (z + 0.35) / 0.9));
      const alpha = Math.max(facing * (0.45 + r.glow * 0.55), r.glow * 0.9);
      if (alpha < 0.06) return;

      // Push the label outward from the centre so it sits beside its cluster, not on the core.
      let dx = x - cx;
      let dy = y - cy;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d;
      dy /= d;
      const lx = cx + dx * Math.max(d, R * 0.55) + dx * 26;
      const ly = cy + dy * Math.max(d, R * 0.55) + dy * 18;
      const c = this.palette[i];
      const right = dx >= 0;
      const tool = [...r.running.values()].at(-1);
      const line1 = r.name;
      const line2 = tool ? `▶ ${tool}` : `${r.nodes.length} neurons · ${r.firing.toFixed(1)}%`;

      ctx.strokeStyle = rgba(c, 0.5 * alpha);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(lx, ly);
      ctx.lineTo(lx + (right ? 10 : -10), ly);
      ctx.stroke();
      ctx.fillStyle = rgba(c, alpha);
      ctx.beginPath();
      ctx.arc(x, y, 2.2 + r.glow * 2.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.textAlign = right ? "left" : "right";
      const tx = lx + (right ? 14 : -14);
      ctx.font = `700 ${this.kiosk ? 12 : 11}px 'Orbitron', 'Segoe UI', sans-serif`;
      const wText = Math.max(ctx.measureText(line1).width, 110);
      ctx.fillStyle = `rgba(1,6,12,${0.55 * alpha})`;
      ctx.fillRect(right ? tx - 4 : tx - wText - 4, ly - 12, wText + 8, 28);
      ctx.fillStyle = rgba(r.glow > 0.5 ? [255, 255, 255] : c, alpha);
      ctx.fillText(line1, tx, ly - 4);
      ctx.font = `${this.kiosk ? 11 : 10}px 'JetBrains Mono', monospace`;
      ctx.fillStyle = rgba(c, alpha * 0.85);
      ctx.fillText(line2, tx, ly + 9);
    });
  }

  drawRings(cx, cy, R, dt) {
    const { ctx } = this;
    const col = this.color;
    const t = this.t;
    const lvl = this.level;
    const busy = this.state === "thinking" || this.state === "working";
    const tau = Math.PI * 2;

    // Audio ring: live spectrum while listening/speaking.
    const rAudio = R * 1.14;
    const bars = 96;
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(col, 0.55);
    ctx.beginPath();
    for (let i = 0; i < bars; i++) {
      let v;
      if (this.spectrum && (this.state === "listening" || this.state === "speaking")) {
        const idx = Math.floor((Math.abs(i - bars / 2) / (bars / 2)) * this.spectrum.length * 0.6);
        v = this.spectrum[idx] / 255;
      } else {
        v = lvl * (0.35 + 0.65 * Math.abs(Math.sin(i * 0.7 + t * 9) * Math.cos(i * 0.23 - t * 4)));
      }
      const len = 2 + v * R * 0.2;
      const a = (i / bars) * tau - Math.PI / 2;
      ctx.moveTo(cx + Math.cos(a) * rAudio, cy + Math.sin(a) * rAudio);
      ctx.lineTo(cx + Math.cos(a) * (rAudio + len), cy + Math.sin(a) * (rAudio + len));
    }
    ctx.stroke();

    // Tick ring.
    const rA = R * 1.32;
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(col, 0.3);
    ctx.beginPath();
    ctx.arc(cx, cy, rA, 0, tau);
    ctx.stroke();
    ctx.beginPath();
    const rot = t * 0.05;
    for (let i = 0; i < 120; i++) {
      const a = rot + (i / 120) * tau;
      const len = i % 10 === 0 ? 9 : 4;
      ctx.moveTo(cx + Math.cos(a) * rA, cy + Math.sin(a) * rA);
      ctx.lineTo(cx + Math.cos(a) * (rA + len), cy + Math.sin(a) * (rA + len));
    }
    ctx.strokeStyle = rgba(col, 0.5);
    ctx.stroke();

    // Heavy arc segments - the "reactor".
    const rB = R * 1.46;
    const spinB = -t * (busy ? 1.2 : 0.22);
    ctx.lineWidth = 4;
    ctx.strokeStyle = rgba(col, 0.7);
    for (let k = 0; k < 3; k++) {
      const a0 = spinB + (k * tau) / 3;
      ctx.beginPath();
      ctx.arc(cx, cy, rB, a0, a0 + tau / 3 - 0.45);
      ctx.stroke();
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(col, 0.35);
    for (let k = 0; k < 6; k++) {
      const a0 = -spinB * 0.6 + (k * tau) / 6;
      ctx.beginPath();
      ctx.arc(cx, cy, rB + 8, a0, a0 + 0.5);
      ctx.stroke();
    }
    if (busy) {
      const sweep = t * 4.5;
      const g = ctx.createConicGradient(sweep, cx, cy);
      g.addColorStop(0, rgba(col, 0));
      g.addColorStop(0.12, rgba(col, 0.9));
      g.addColorStop(0.121, rgba(col, 0));
      ctx.strokeStyle = g;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, rB - 9, 0, tau);
      ctx.stroke();
    }

    // Dashed orbit.
    const rC = R * 1.6;
    ctx.save();
    ctx.setLineDash([2, 9]);
    ctx.lineDashOffset = -t * 12;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(col, 0.45);
    ctx.beginPath();
    ctx.arc(cx, cy, rC, 0, tau);
    ctx.stroke();
    ctx.restore();

    // Outer compass with bearings.
    const rD = R * 1.74;
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(col, 0.16);
    ctx.beginPath();
    ctx.arc(cx, cy, rD, 0, tau);
    ctx.stroke();
    ctx.fillStyle = rgba(col, 0.6);
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ["000", "090", "180", "270"].forEach((label, i) => {
      const a = (i * tau) / 4 - Math.PI / 2;
      const x = cx + Math.cos(a) * (rD + 16);
      const y = cy + Math.sin(a) * (rD + 16);
      // Top and bottom bearings sit under the readout and state label, so only the sides get text.
      if (i % 2 === 1) ctx.fillText(label, x, y);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (rD - 5), cy + Math.sin(a) * (rD - 5));
      ctx.lineTo(cx + Math.cos(a - 0.03) * (rD + 5), cy + Math.sin(a - 0.03) * (rD + 5));
      ctx.lineTo(cx + Math.cos(a + 0.03) * (rD + 5), cy + Math.sin(a + 0.03) * (rD + 5));
      ctx.closePath();
      ctx.fill();
    });

    // Side brackets, like a targeting reticle.
    ctx.strokeStyle = rgba(col, 0.4);
    ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      const x = cx + side * (rD + 34);
      ctx.beginPath();
      ctx.moveTo(x - side * 40, cy);
      ctx.lineTo(x, cy);
      ctx.moveTo(x, cy - 26);
      ctx.lineTo(x, cy + 26);
      ctx.stroke();
    }
  }
}
