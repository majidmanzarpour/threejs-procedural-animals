// Gait HUD, body-plan aware:
// - legs: a footfall (Hildebrand-style) diagram, one row per foot (2 for birds, 4 for quadrupeds, 8
//   for spiders, whatever animal.state.legs holds), filled while the foot is on the ground. Without
//   state.legs it falls back to touchdown ticks from 'footstep' events.
// - no legs (swimmers, snakes): a body-wave trace, the lateral offset of five points along the axial
//   chain (head -> tail) over time, so the travelling wave of a slithering snake or the tail beat of
//   a fish reads at a glance; the label carries the engine's undulation / tail-beat frequency.
import * as THREE from 'three';

const HIST = 180, RATE = 90;
const _p = new THREE.Vector3();

function legName(l, i) { return String(l.name ?? l.foot ?? l.key ?? l.id ?? l.def?.key ?? 'L' + (i + 1)); }
function legDown(l) {
  if (typeof l === 'boolean') return l;
  if (typeof l.stance === 'boolean') return l.stance;
  if (typeof l.contact === 'boolean') return l.contact;
  if (typeof l.grounded === 'boolean') return l.grounded;
  if (typeof l.down === 'boolean') return l.down;
  if (typeof l.state === 'string') return l.state === 'stance' || l.state === 'plant' || l.state === 'planted';
  if (typeof l.phase === 'string') return l.phase === 'stance';
  return false;
}
const ORDER = ['FL', 'LF', 'FR', 'RF', 'HL', 'LH', 'HR', 'RH'];
const QUAD = /^([FH][LR]|[LR][FH])$/;
// front / hind colouring for quadruped keys, left / right for everything else (birds, spiders)
function rowColor(name) {
  if (QUAD.test(name)) return /F/.test(name) ? '#e3a23b' : '#f3ebdd';
  return /^L(?![a-z])|[a-z0-9_]L$|^left|Left$/.test(name) ? '#e3a23b' : '#f3ebdd';
}
function rowLabel(name) {
  const m = /^leg([LR])$/i.exec(name);
  return m ? m[1].toUpperCase() : name.slice(0, 4);
}

export class Footfalls {
  constructor(canvas, label, title) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.label = label;
    this.title = title;
    this.reset();
  }
  reset(info = null) {
    this.rows = [];
    this.hist = [];
    this.acc = 0;
    this.ticks = [];
    this.source = 'none';
    this.rowsKey = '';
    this.info = info;
    this.chain = info && info.legless ? pickChain(info.chain) : null;
    this.gain = 0.02;
    this.last = null;
    this.dirty = true;
  }
  get mode() { return this.chain && this.chain.idx.length ? 'wave' : 'legs'; }
  onFootstep(e, t) {
    if (this.mode === 'wave' || this.source === 'legs') return; // state.legs is the truth when present
    const name = String(e.foot ?? 'foot');
    if (!this.rows.includes(name)) { this.rows.push(name); this.sortRows(); }
    this.ticks.push({ name, t });
  }
  sortRows() {
    this.rows.sort((a, b) => {
      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'en', { numeric: true });
    });
  }
  sample(animal, dt, t) {
    this.acc += dt;
    const steps = Math.min(30, Math.floor(this.acc * RATE));
    if (steps <= 0) return;
    this.acc -= steps / RATE;
    if (this.mode === 'wave') this.sampleWave(animal, steps);
    else this.sampleLegs(animal, steps, t);
    if (this.hist.length > HIST) this.hist.splice(0, this.hist.length - HIST);
    const span = HIST / RATE;
    this.ticks = this.ticks.filter((k) => t - k.t < span);
    this.dirty = true;
  }
  sampleLegs(animal, steps, t) {
    const legs = animal?.state?.legs;
    if (Array.isArray(legs) && legs.length) {
      this.source = 'legs';
      const names = legs.map(legName);
      if (names.join() !== this.rowsKey) { this.rows = names.slice(); this.sortRows(); this.rowsKey = names.join(); this.hist = []; }
      const map = {};
      legs.forEach((l, i) => { map[names[i]] = legDown(l); });
      for (let k = 0; k < steps; k++) this.hist.push(this.rows.map((n) => map[n]));
    } else {
      this.source = this.rows.length ? 'events' : 'none';
      for (let k = 0; k < steps; k++) this.hist.push(null);
      this.now = t;
    }
  }
  sampleWave(animal, steps) {
    this.source = 'wave';
    const bones = animal.render?.skeleton?.bones;
    if (!bones) return;
    const h = animal.heading, lx = Math.cos(h), lz = -Math.sin(h);
    const o = animal.position, L = Math.max(0.01, this.info.length);
    this.rows = this.chain.labels;
    const s = this.chain.idx.map((i) => {
      _p.setFromMatrixPosition(bones[i].matrixWorld);
      return ((_p.x - o.x) * lx + (_p.z - o.z) * lz) / L;
    });
    // remove the mean (a turning animal curves as a whole) and keep the wave
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    for (let k = 0; k < s.length; k++) s[k] -= mean;
    // interpolate from the previous sample so a slow frame rate draws a line, not stairs
    const prev = this.last && this.last.length === s.length ? this.last : s;
    for (let k = 1; k <= steps; k++) { const t = k / steps; this.hist.push(s.map((v, j) => prev[j] + (v - prev[j]) * t)); }
    this.last = s;
  }
  draw(gaitName, animal) {
    if (!this.dirty) return;
    this.dirty = false;
    const wave = this.mode === 'wave';
    const rows = this.rows.length ? this.rows : wave ? ['head', 'mid', 'tail'] : ['FL', 'FR', 'HL', 'HR'];
    const n = rows.length;
    // taller card for many legs (a spider's eight rows stay readable)
    const cssH = n <= 5 ? 66 : Math.min(124, 14 * n);
    if (this.cssH !== cssH) { this.cssH = cssH; this.canvas.style.height = cssH + 'px'; this.canvas.height = cssH * 2; }
    const c = this.canvas, g = this.g, W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const rh = H / n, x0 = 44;
    g.font = `500 ${Math.min(18, rh * 0.62)}px JetBrains Mono, monospace`;
    for (let r = 0; r < n; r++) {
      g.fillStyle = 'rgba(243,235,221,0.08)';
      g.fillRect(x0, r * rh + (wave ? 1 : 3), W - x0, rh - (wave ? 2 : 6));
      g.fillStyle = 'rgba(179,165,141,1)';
      g.fillText(wave ? rows[r] : rowLabel(rows[r]), 0, r * rh + rh * 0.68);
    }
    const w = (W - x0) / HIST;
    const L = this.hist.length;
    if (this.source === 'legs') {
      for (let i = 0; i < L; i++) {
        const s = this.hist[i];
        if (!s) continue;
        for (let r = 0; r < n; r++) {
          if (!s[r]) continue;
          g.fillStyle = rowColor(rows[r]);
          g.fillRect(x0 + (HIST - L + i) * w, r * rh + 3, w + 0.6, rh - 6);
        }
      }
    } else if (this.source === 'events') {
      const span = HIST / RATE;
      for (const k of this.ticks) {
        const r = rows.indexOf(k.name);
        if (r < 0) continue;
        const x = x0 + (1 - (this.now - k.t) / span) * (W - x0);
        g.fillStyle = rowColor(k.name);
        g.fillRect(x - 2, r * rh + 3, 4, rh - 6);
      }
    } else if (this.source === 'wave' && L > 1) {
      // auto gain from the recent peak (at least 2 % of the body length full scale)
      let peak = 0.02;
      for (const s of this.hist) for (const v of s) peak = Math.max(peak, Math.abs(v));
      this.gain += (peak - this.gain) * 0.2;
      g.lineWidth = 2.2;
      g.lineJoin = 'round';
      for (let r = 0; r < n; r++) {
        const cy = r * rh + rh / 2, amp = (rh / 2 - 2) / this.gain;
        g.strokeStyle = r === n - 1 ? '#e3a23b' : r === 0 ? '#f3ebdd' : 'rgba(227,162,59,' + (0.45 + 0.4 * (r / (n - 1))) + ')';
        g.beginPath();
        for (let i = 0; i < L; i++) {
          const x = x0 + (HIST - L + i) * w, y = cy - this.hist[i][r] * amp;
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.stroke();
      }
    }
    if (this.title) this.title.textContent = wave ? 'Body wave' : 'Footfalls';
    if (this.label) {
      let txt = gaitName || '';
      if (wave) {
        const f = animal?.state?.stats?.freq;
        if (Number.isFinite(f) && f > 0.05 && gaitName !== 'stand') txt += ` · ${f.toFixed(1)} Hz`;
      } else if (this.source === 'events') txt += ' · touchdowns';
      this.label.textContent = txt;
    }
  }
}

// five evenly spaced points along the chain, labelled head .. tail
function pickChain(chain) {
  if (!Array.isArray(chain) || chain.length < 3) return null;
  const K = Math.min(5, chain.length);
  const idx = [], labels = [];
  const names = K === 5 ? ['head', 'neck', 'mid', 'rear', 'tail'] : K === 4 ? ['head', 'front', 'rear', 'tail'] : ['head', 'mid', 'tail'];
  for (let k = 0; k < K; k++) { idx.push(chain[Math.round((k / (K - 1)) * (chain.length - 1))]); labels.push(names[k]); }
  return { idx, labels };
}
