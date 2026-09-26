// The neural core: a rotating 3D graph of "neurons" with synapse pulses, wrapped in arc-reactor rings.
// Everything reacts to Jarvis's state and to the live audio level.

const PALETTES = {
  neural: ["#38d6ff", "#4f7dff", "#e879f9", "#fbbf24", "#34d399", "#fb7185", "#a78bfa"],
  arc: ["#38d6ff", "#22d3ee", "#7dd3fc", "#0ea5e9", "#67e8f9", "#38d6ff", "#a5f3fc"],
};
const STATE_COLOR = {
  idle: [56, 214, 255],
  listening: [52, 211, 153],
  thinking: [251, 191, 36],
  working: [255, 159, 67],
  speaking: [56, 214, 255],
  error: [251, 77, 109],
};
const SPIN = { idle: 0.07, listening: 0.1, thinking: 0.42, working: 0.34, speaking: 0.16, error: 0.04 };
const FIRE_RATE = { idle: 5, listening: 10, thinking: 70, working: 50, speaking: 18, error: 2 };

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgba = ([r, g, b], a) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

export class Core {
  constructor(canvas, readout) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.readout = readout;
    this.state = "idle";
    this.theme = "neural";
    this.level = 0;
    this.targetLevel = 0;
    this.spectrum = null;
    this.color = [...STATE_COLOR.idle];
    this.offsetX = 0;
    this.targetOffsetX = 0;
    this.rotY = 0;
    this.t = 0;
    this.flashAmt = 0;
    this.pulses = [];
    this.spawnDebt = 0;
    this.fired = 0;
    this.build(300);
    this.setTheme("neural");

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.last = performance.now();
    requestAnimationFrame((now) => this.frame(now));
    setInterval(() => this.updateReadout(), 500);
  }

  build(n) {
    const centers = Array.from({ length: 7 }, () => {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      return [s * Math.cos(a), u, s * Math.sin(a)];
    });
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
      let best = 0;
      let bestDot = -Infinity;
      centers.forEach((c, k) => {
        const d = c[0] * p[0] + c[1] * p[1] + c[2] * p[2];
        if (d > bestDot) {
          bestDot = d;
          best = k;
        }
      });
      this.nodes.push({ p, cluster: best, act: 0, sx: 0, sy: 0, z: 0 });
    }
    const edges = new Set();
    this.nodes.forEach((a, i) => {
      const dists = this.nodes
        .map((b, j) => [j, (a.p[0] - b.p[0]) ** 2 + (a.p[1] - b.p[1]) ** 2 + (a.p[2] - b.p[2]) ** 2])
        .filter(([j]) => j !== i)
        .sort((x, y) => x[1] - y[1]);
      for (const [j] of dists.slice(0, 3)) edges.add(i < j ? `${i}-${j}` : `${j}-${i}`);
      // A few long-range links inside the same cluster make it look like a brain, not a mesh.
      if (Math.random() < 0.12) {
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
    this.theme = PALETTES[name] ? name : "neural";
    this.palette = PALETTES[this.theme].map(hexToRgb);
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

  flash() {
    this.flashAmt = 1;
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
    this.fired++;
  }

  updateReadout() {
    if (!this.readout) return;
    const firing = (this.nodes.filter((n) => n.act > 0.35).length / this.nodes.length) * 100;
    this.readout.textContent = `NODES ${this.nodes.length} · LINKS ${this.edges.length} · FIRING ${firing.toFixed(1)}%`;
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
    this.targetOffsetX = this.cardsVisible && w > 820 ? -w * 0.14 : 0;
    this.offsetX += (this.targetOffsetX - this.offsetX) * Math.min(1, dt * 3);

    const lvl = this.level;
    const col = this.color;
    const cx = w / 2 + this.offsetX;
    const cy = (h - 120) / 2 + 14;
    const base = Math.min(w * 0.85, h - 150) * 0.3;
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
      n.sy = cy + y2 * R * persp;
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

    // Synapses, batched by cluster and depth for speed.
    ctx.lineWidth = 0.8;
    for (let bucket = 0; bucket < 3; bucket++) {
      for (let c = 0; c < this.palette.length; c++) {
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
          ctx.strokeStyle = rgba(this.palette[c], [0.05, 0.12, 0.24][bucket] + lvl * 0.08);
          ctx.stroke();
        }
      }
    }

    // Fire new pulses; each arrival can cascade onward like a real neuron.
    this.spawnDebt += dt * (FIRE_RATE[state] + lvl * 90);
    while (this.spawnDebt > 1) {
      this.spawnDebt -= 1;
      if (this.pulses.length < 220) this.spawnPulse();
    }
    const cascade = state === "thinking" || state === "working" ? 0.55 : 0.28;
    const next = [];
    for (const p of this.pulses) {
      p.t += dt * p.speed;
      const A = this.nodes[p.a];
      const B = this.nodes[p.b];
      if (p.t >= 1) {
        B.act = 1;
        if (p.hops < 4 && Math.random() < cascade && next.length < 240) {
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

    // Neurons.
    for (const n of this.nodes) {
      const zf = (n.z + 1) / 2;
      const c = this.palette[n.cluster];
      const size = (0.7 + zf * 1.5) * (1 + n.act * 1.4);
      if (n.act > 0.2) {
        ctx.fillStyle = rgba(c, 0.22 * n.act);
        ctx.beginPath();
        ctx.arc(n.sx, n.sy, size * 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = rgba(c, 0.3 + zf * 0.6 + n.act * 0.3);
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
    this.drawRings(cx, cy, R, dt);
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
