// Demo reel titles: drawn on a 2D canvas at the output resolution and composited by the post pass
// (demoPost.js), so a recording of the canvas carries them. Everything is a pure function of the
// element's local time: the same frame always draws the same titles. The canvas is redrawn (and
// re-uploaded) only while something animates or changes.
//
// Elements (see Titles.draw): the species' short name, the "how it's made" layer's one word, the
// opening title and the end card (the title lockup and the repository line). Nothing else: the reel
// keeps text to a minimum.
import * as THREE from 'three';

const PAPER = '#f3ebdd', OCHRE = '#e3a23b', GOLD = '#f2c679';
const SERIF = '"Instrument Serif", "Iowan Old Style", Georgia, serif';
const SANS = 'Manrope, system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const outCubic = (u) => 1 - (1 - clamp(u, 0, 1)) ** 3;

export const FONTS = [`400 64px ${SERIF}`, `italic 400 64px ${SERIF}`, `500 24px ${SANS}`, `600 24px ${SANS}`, `700 24px ${SANS}`, `400 20px ${MONO}`, `500 20px ${MONO}`];

export class Titles {
  constructor(w, h) {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.NoColorSpace; // the post pass composites in display space
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = true;
    this.key = '';
    this.setSize(w, h);
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    // type scale from the shorter side (a 9:16 crop keeps readable titles), safe margins from the frame
    this.u = Math.min(w, h) / 1080;
    this.mx = Math.round(Math.max(w * 0.055, 48 * this.u));
    this.my = Math.round(Math.max(h * 0.075, 48 * this.u));
    this.key = '';
    this.texture.dispose();
  }

  // state: { species?: {name,t,dur}, caption?: {title,titleA,stageT,t,dur}, open?: {t,dur}, end?: {t,dur,repo} }
  // returns true when the canvas was redrawn
  draw(state) {
    const key = signature(state);
    if (key === this.key) return false;
    this.key = key;
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);
    if (state.species) this.drawSpecies(state.species);
    if (state.caption) this.drawCaption(state.caption);
    if (state.open) this.drawOpen(state.open);
    if (state.end) this.drawEnd(state.end);
    this.texture.needsUpdate = true;
    return true;
  }

  // a soft elliptical darkening behind a text block (lower thirds over bright grass, the title over the sky)
  scrim(cx, cy, rx, ry, alpha) {
    if (alpha <= 0.002) return;
    const c = this.ctx;
    c.save();
    c.translate(cx, cy);
    c.scale(rx / ry, 1);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, ry);
    g.addColorStop(0, `rgba(6,5,4,${alpha})`);
    g.addColorStop(0.5, `rgba(6,5,4,${alpha * 0.62})`);
    g.addColorStop(1, 'rgba(6,5,4,0)');
    c.fillStyle = g;
    c.fillRect(-ry, -ry, 2 * ry, 2 * ry);
    c.restore();
  }

  // a soft darkening grown from a corner of the frame ('bl', 'tl', 'br'): a lower third or a caption
  // stays legible over bright grass or sky, and the gradient is too wide to read as a smudge
  cornerScrim(corner, alpha, reach = 0.62) {
    if (alpha <= 0.002) return;
    const c = this.ctx;
    const r = Math.max(this.w, this.h) * reach;
    const cx = corner.includes('r') ? this.w : 0, cy = corner.includes('b') ? this.h : 0;
    c.save();
    c.translate(cx, cy);
    c.scale(1.45, 1);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `rgba(6,5,4,${alpha})`);
    g.addColorStop(0.35, `rgba(6,5,4,${alpha * 0.72})`);
    g.addColorStop(0.7, `rgba(6,5,4,${alpha * 0.22})`);
    g.addColorStop(1, 'rgba(6,5,4,0)');
    c.fillStyle = g;
    c.fillRect(-r, -r, 2 * r, 2 * r);
    c.restore();
  }

  _text(str, x, y, font, color, alpha, { spacing = 0, align = 'left', shadow = 0.45, blur = 22 } = {}) {
    if (!(alpha > 0.002) || !str) return 0; // (NaN: nothing; the canvas would keep the last valid alpha)
    const c = this.ctx;
    c.save();
    c.font = font;
    c.letterSpacing = spacing ? `${spacing}px` : '0px';
    c.textAlign = align;
    c.textBaseline = 'alphabetic';
    c.globalAlpha = clamp(alpha, 0, 1);
    if (shadow > 0) { c.shadowColor = `rgba(8,6,4,${shadow})`; c.shadowBlur = blur * this.u; c.shadowOffsetY = 1.5 * this.u; }
    c.fillStyle = color;
    c.fillText(str, x, y);
    const wdt = c.measureText(str).width;
    c.restore();
    return wdt;
  }

  // lower third: the animal's short name (serif) under a short ochre rule that draws in first
  drawSpecies(s) {
    const u = this.u, t = s.t, dur = s.dur;
    const inA = sm(0.15, 0.75, t), out = 1 - sm(dur - 0.55, dur - 0.12, t);
    const a = inA * out;
    if (a <= 0.002) return;
    const x = this.mx, baseY = this.h - this.my;
    const lift = (1 - outCubic((t - 0.15) / 0.8)) * 14 * u - (1 - out) * 6 * u;
    const nameSize = Math.round(60 * u);
    const yName = baseY + lift;
    const c = this.ctx;
    const rw = 56 * u * outCubic((t - 0.05) / 0.5) * out;
    this.cornerScrim('bl', 0.42 * a, 0.42);
    c.save();
    c.globalAlpha = 0.95 * out;
    c.fillStyle = OCHRE;
    c.shadowColor = 'rgba(8,6,4,0.35)'; c.shadowBlur = 10 * u;
    c.fillRect(x, yName - nameSize * 1.02, rw, Math.max(1.5, 2 * u));
    c.restore();
    this._text(s.name, x - 2 * u, yName, `400 ${nameSize}px ${SERIF}`, PAPER, sm(0.2, 0.8, t) * out, { spacing: 0.3 * u });
  }

  // "how it's made": one short word for the layer on screen (SDF, MESH, SKELETON, FUR), top left, with
  // an ochre underline that grows while the stage runs; the words cross-fade (k.titleA) between stages
  drawCaption(k) {
    const u = this.u, t = k.t, dur = k.dur;
    const out = 1 - sm(dur - 0.5, dur - 0.1, t);
    const a = sm(0.1, 0.6, t) * out;
    if (a <= 0.002) return;
    const x = this.mx, y = this.my + 34 * u;
    this.cornerScrim('tl', 0.3 * a, 0.36);
    const st = Number.isFinite(k.titleA) ? k.titleA : sm(0.0, 0.35, k.stageT ?? 1);
    const w = this._text((k.title || '').toUpperCase(), x, y, `600 ${Math.round(30 * u)}px ${SANS}`, PAPER, a * st, { spacing: 10 * u, shadow: 0.55, blur: 18 });
    if (w > 0 && a * st > 0.002) {
      const c = this.ctx;
      c.save();
      c.globalAlpha = clamp(a * st, 0, 1) * 0.95;
      c.fillStyle = OCHRE;
      c.shadowColor = 'rgba(8,6,4,0.35)'; c.shadowBlur = 8 * u;
      c.fillRect(x, y + 16 * u, Math.max(0, w - 10 * u) * outCubic(clamp(k.stageT ?? 1, 0, 1)), Math.max(1.5, 2 * u));
      c.restore();
    }
  }

  // the title lockup "THREE.JS / PROCEDURAL ANIMALS": a small tracked eyebrow over the name in serif
  // capitals, letters rising one by one from `start` (s); `k0`: when the name starts. The name breaks
  // into two lines when it would not fit the frame's width (a 9:16 crop). Returns the block's bottom.
  lockup(cx, cy, t, out, { start = 0.5, k0 = 0.35, maxSize = 118, shadow = 0.62, blur = 46 } = {}) {
    const u = this.u, c = this.ctx;
    const NAME = 'PROCEDURAL ANIMALS';
    const measure = (str, size, sp) => { c.save(); c.font = `400 ${size}px ${SERIF}`; c.letterSpacing = `${sp}px`; const w = c.measureText(str).width; c.restore(); return w; };
    let size = Math.round(maxSize * u), sp = 0.07 * size;
    let lines = [NAME];
    const fit = this.w * 0.86;
    const w1 = measure(NAME, size, sp);
    if (w1 > fit || this.w < this.h) {
      const s2 = size * fit / w1;
      if (s2 >= 0.85 * size && this.w >= this.h) size = Math.floor(s2);
      else { lines = ['PROCEDURAL', 'ANIMALS']; size = Math.floor(Math.min(size * 1.05, size * fit / measure('PROCEDURAL', size, sp))); }
      sp = 0.07 * size;
    }
    const eyeSize = Math.round(Math.max(22 * u, size * 0.27)), eyeSp = eyeSize * 0.55;
    const lh = size * 1.02;
    const top = cy - (lines.length - 1) * lh;
    // eyebrow
    const aE = sm(start, start + 0.8, t) * out;
    this._text('THREE.JS', cx + eyeSp / 2, top - size * 0.98, `700 ${eyeSize}px ${SANS}`, GOLD, aE, { spacing: eyeSp, align: 'center', shadow: Math.min(0.75, shadow + 0.1), blur: 22 });
    let i = 0;
    lines.forEach((line, li) => {
      const total = measure(line, size, sp);
      let x = cx - total / 2 + sp / 2;
      const y = top + li * lh;
      for (const ch of line) {
        const wch = measure(ch, size, sp);
        if (ch !== ' ') {
          const k = start + k0 + i * 0.05;
          const a = sm(k, k + 0.7, t) * out;
          const dy = (1 - outCubic((t - k) / 0.9)) * 16 * u;
          this._text(ch, x, y + dy, `400 ${size}px ${SERIF}`, PAPER, a, { spacing: sp, shadow, blur });
          i++;
        }
        x += wch;
      }
    });
    return top + (lines.length - 1) * lh + size * 0.1;
  }

  drawOpen(o) {
    const t = o.t, dur = o.dur;
    const out = 1 - sm(dur - 0.9, dur - 0.15, t);
    this.lockup(this.w / 2, this.h * (o.y ?? 0.4), t, out, { start: o.start ?? 0.5 });
  }

  drawEnd(e) {
    const u = this.u, t = e.t;
    const bottom = this.lockup(this.w / 2, this.h * (e.y ?? 0.43), t, 1, { start: 0.15, k0: 0.3, maxSize: 104, shadow: 0.4, blur: 30 });
    if (e.repo) this._text(e.repo, this.w / 2, bottom + 62 * u, `500 ${Math.round(Math.min(26 * u, this.w * 0.026))}px ${MONO}`, PAPER, sm(1.6, 2.4, t) * 0.95, { align: 'center', spacing: 0.6 * u, shadow: 0.55 });
  }

  dispose() { this.texture.dispose(); }
}

// a string that changes whenever the drawn image would (times quantised to 1/240 s while animating)
function signature(s) {
  const q = (x) => Math.round(x * 240);
  const parts = [];
  const anim = (e, inEnd, outStart) => (e.t < inEnd || e.t > e.dur - outStart ? q(e.t) : 'hold');
  if (s.species) parts.push('s' + s.species.name + anim(s.species, 1.4, 0.6));
  if (s.caption) parts.push('c' + s.caption.step + s.caption.title + (s.caption.stageT < 1.05 ? q(s.caption.stageT) : 'h') + (s.caption.titleA !== undefined ? 'a' + Math.round(s.caption.titleA * 400) : '') + anim(s.caption, 0.7, 0.55));
  if (s.open) parts.push('o' + (s.open.t > s.open.dur ? 'x' : s.open.t < (s.open.start ?? 0.5) + 2.4 || s.open.t > s.open.dur - 1 ? q(s.open.t) : 'hold'));
  if (s.end) parts.push('e' + (s.end.t < 3 ? q(s.end.t) : 'hold'));
  return parts.join('|');
}
