// Adaptive quality with hysteresis (the showcase's pixel ratio, grass density and the hero's coat tier).
//
// The frame time is averaged over windows of `window` seconds. A window over `slowMs` steps one tier
// down at once; `upAfter` seconds of windows under `fastMs` step one tier up. An upgrade that is undone
// within `failWithin` seconds (the better tier is too slow for this view) is not tried again for
// `backoff` seconds, doubling with every further failure up to `backoffMax`, unless the hero becomes
// much smaller on screen than when it failed (the cost of a coat follows its size on screen: zooming out
// earns another try). Without this memory a view that was fast at one tier and slow at the next went up
// and down for ever, every ~13 s on a 120 Hz display, and the hero's fur appeared and disappeared with it.
//
// Pure logic (no DOM, no three.js).
export class AdaptiveQuality {
  constructor({ tiers, start = 0, min = 0, window = 2.5, slowMs = 32, fastMs = 14, upAfter = 10, failWithin = 8, backoff = 20, backoffMax = 320, smaller = 0.6 } = {}) {
    Object.assign(this, { tiers, tier: start, min, window, slowMs, fastMs, upAfter, failWithin, backoff, backoffMax, smaller });
    this.t = 0; this.acc = 0; this.n = 0; this.good = 0;
    this.reset();
  }

  /** Forget failed upgrades (a new hero, a new quality setting). */
  reset() { this.fails = 0; this.blockUntil = -Infinity; this.lastUp = -Infinity; this.screen = 0; this.good = 0; }

  /** One frame: dt (s, real), now (s), screen = the hero's size on screen (any unit, e.g. its height
   *  over the view's half height). Returns +1 (step down: tier + 1), -1 (step up) or 0. */
  sample(dt, now, screen = 1) {
    this.t += dt; this.acc += dt; this.n++;
    if (this.t <= this.window) return 0;
    const ms = (this.acc / this.n) * 1000, span = this.t;
    this.t = 0; this.acc = 0; this.n = 0;
    if (ms > this.slowMs && this.tier < this.tiers - 1) {
      if (now - this.lastUp < this.failWithin) {
        this.fails++;
        this.blockUntil = now + Math.min(this.backoffMax, this.backoff * 2 ** (this.fails - 1));
        this.screen = screen;
      }
      this.tier++; this.good = 0;
      return 1;
    }
    if (ms < this.fastMs && this.tier > this.min) {
      const blocked = now < this.blockUntil && !(screen < this.smaller * this.screen);
      if (blocked) { this.good = 0; return 0; }
      this.good += span;
      if (this.good > this.upAfter) { this.tier--; this.lastUp = now; this.good = 0; return -1; }
      return 0;
    }
    this.good = 0;
    return 0;
  }
}
