// Drives the animals: autopilot (wander, stop, look around, occasional actions, trips to the lake to
// drink, perching for birds), manual control (WASD / arrows / touch joystick, camera-relative, plus
// climb for flyers and swimmers) and click-to-move. It produces commands; the app applies them to the
// hero and, in compare mode, mirrors them onto the second animal.
import * as THREE from 'three';
import { forward } from './subject.js';

const rand = (a, b) => a + Math.random() * (b - a);
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// Typical speeds (m/s) for a cheetah-sized animal; scaled by sqrt(size) for others. Species can
// override by exposing gaits as objects: { name, speed } (or { name, min, max }).
const GAIT_SPEED = {
  stand: 0, idle: 0, walk: 1.25, amble: 2, pace: 2.8, trot: 3, tolt: 3, rack: 3, canter: 5.6, lope: 5.6, gallop: 13,
  bound: 6, pronk: 5, sprint: 27, hop: 2.5, run: 5, swim: 1.2, cruise: 1.6, burst: 5, glide: 9, soar: 9, fly: 8,
  flap: 7, hover: 0.4, slither: 0.8, crawl: 0.4, sidewind: 1, concertina: 0.3, waddle: 0.6, scuttle: 0.5,
};
const GAIT_MAX = { gallop: 27, sprint: 30, burst: 8, fly: 14 };

export function gaitTable(animal, info) {
  const k = Math.sqrt(Math.max(0.05, info.scale));
  // the engine's named speeds (animal.gears: { walk, trot, ... } in m/s for this individual) first
  const gears = animal.gears && typeof animal.gears === 'object' ? animal.gears : {};
  let list = Object.entries(gears).filter(([, v]) => Number.isFinite(v) && v > 0).map(([name, speed]) => ({ name, speed, max: speed }));
  if (!list.length) {
    const raw = Array.isArray(animal.gaits) ? animal.gaits : [];
    list = raw.map((g, i) => {
      if (g && typeof g === 'object') {
        const name = g.name || g.id || 'gait ' + (i + 1);
        const speed = g.speed ?? (g.min != null && g.max != null ? (g.min + g.max) / 2 : GAIT_SPEED[name] != null ? GAIT_SPEED[name] * k : (i + 1) * 1.3 * k);
        return { name, speed, max: g.max ?? (GAIT_MAX[name] ? GAIT_MAX[name] * k : speed * 1.3) };
      }
      const name = String(g);
      const speed = GAIT_SPEED[name] != null ? GAIT_SPEED[name] * k : (i + 1) * 1.3 * k;
      return { name, speed, max: GAIT_MAX[name] ? GAIT_MAX[name] * k : speed * 1.3 };
    }).filter((g) => g.speed > 0);
  }
  list.sort((a, b) => a.speed - b.speed);
  const top = list.length ? Math.max(...list.map((g) => g.max)) : 3 * k;
  // flyers: the flight gear (the fastest, or one named fly / soar / glide); the rest are ground gears
  const air = info.flyer ? list.find((g) => /fly|flight|soar|glide/.test(g.name)) || list[list.length - 1] : null;
  const ground = air ? list.filter((g) => g !== air) : list;
  return { list, max: top * 1.15, walk: list[0]?.speed || 1.2 * k, fly: air ? air.speed : 0, ground, top: ground.length ? ground[ground.length - 1].speed : top };
}

const POSTURES = new Set(['sit', 'lie', 'sleep', 'perch', 'coil']);
const AUTO_SKIP = new Set(['idle', 'stand', 'death', 'hit', 'land', 'takeoff', 'drink', 'perch']);
// swimmer one-shots that carry the body fast and far (leaps out of the water, dashes)
const SWIM_DASH = new Set(['jump', 'burst', 'attack']);

export class Pilot {
  constructor(world) {
    this.world = world;
    this.mode = 'auto';
    this.cruise = 0;
    this.gait = null;
    this.keys = new Set();
    this.stick = { x: 0, y: 0, active: false };
    this.climbBtn = 0;
    this.camera = null;
    this.target = null;
    this.onAction = null; // (name, opts) => void
    this.onStatus = null;
    this.lookT = 0;
    this.look = null;
  }

  attach(animal, info, gaits) {
    this.animal = animal;
    this.info = info;
    this.gaits = gaits;
    this.actions = new Set(animal.actions || []);
    this.target = null;
    if (this.mode === 'target') { this.mode = 'manual'; this.cruise = 0; }
    if (this.mode === 'auto') this.enter('idle', rand(2, 4));
  }

  setMode(m) {
    this.mode = m;
    this.target = null;
    if (m === 'auto') this.enter('wander', rand(5, 8));
  }

  setCruise(speed, gait = null) {
    this.cruise = Math.max(0, speed);
    this.gait = gait;
    if (this.mode !== 'manual') { this.mode = 'manual'; this.target = null; }
  }

  setTarget(p) {
    this._tT = 0;
    this.target = p.clone();
    this.mode = 'target';
  }

  enter(state, dur, extra = {}) {
    this.state = state;
    this.stateT = 0;
    this.stateDur = dur;
    this.zig = rand(0, 6.28);
    this.baseHeading = (this.animal?.heading || 0) + rand(-0.9, 0.9);
    Object.assign(this, { tripTarget: null, posture: null, played: false, actionName: null }, extra);
    this.onStatus?.();
  }

  next() {
    const A = this.animal, acts = this.actions, info = this.info;
    const r = Math.random();
    const oneShots = [...acts].filter((a) => !AUTO_SKIP.has(a) && !POSTURES.has(a));
    const postures = [...acts].filter((a) => POSTURES.has(a) && a !== 'perch');
    if (acts.has('drink') && !info.swimmer && !info.flyer && r < 0.14) {
      const shore = this.world.shorePoint(A.position, info);
      if (shore && shore.distanceTo(A.position) / this.tripSpeed() < 22) return this.enter('trip', 30, { tripTarget: shore, tripAction: 'drink' });
    }
    if (info.flyer && this.gaits.fly && r > 0.72) return this.enter('fly', rand(12, 20), { alt: rand(3, 7) * Math.max(0.5, Math.sqrt(info.scale * 4)) });
    if (acts.has('perch') && info.flyer && r < 0.3) {
      const p = this.world.nearestPerch(A.position);
      if (p) return this.enter('perch', rand(8, 12), { tripTarget: p.position });
    }
    if (r < 0.3 && (oneShots.length || postures.length)) {
      const pool = [...oneShots, ...oneShots, ...postures];
      const name = pool[Math.floor(Math.random() * pool.length)];
      // a swimmer leaps and dashes only toward open water (a breach carries a shark several metres):
      // with the shore close ahead it first swims out toward the middle of the lake
      if (info.swimmer && SWIM_DASH.has(name) && !this.openWaterAhead(A.heading)) {
        return this.enter('wander', rand(4, 6), { baseHeading: this.world.awayFromLake(A.position, true) });
      }
      return this.enter('action', POSTURES.has(name) ? rand(5, 8) : rand(2.5, 4), { actionName: name, posture: POSTURES.has(name) ? name : null });
    }
    if (r < 0.55) return this.enter('idle', rand(3, 6));
    if (r < 0.8) return this.enter('wander', rand(6, 10));
    return this.enter('run', rand(3, 5));
  }

  // open water along `heading` for a swimmer: at least ~3 body lengths (and 2 m) of water deeper than
  // its body ahead
  openWaterAhead(heading) {
    const A = this.animal, info = this.info, W = this.world;
    const F = forward(heading), reach = Math.max(3 * info.length, 2), need = Math.max(0.6 * info.height, 0.05);
    for (let d = 0.5 * info.length; d <= reach + 1e-6; d += Math.max(0.1, info.length * 0.5)) {
      if (W.depthAt(A.position.x + F.x * d, A.position.z + F.z * d) < need) return false;
    }
    return true;
  }

  // steering helpers: stay in the world, stay dry (or wet, for swimmers), avoid props
  _steer(heading, speed) {
    const A = this.animal, info = this.info, W = this.world;
    const p = A.position;
    const d = Math.hypot(p.x, p.z);
    if (d > 38) heading += angDiff(heading, Math.atan2(-p.x, -p.z)) * Math.min(1, (d - 38) / 10);
    const look = Math.max(2.5 * info.scale, speed * 0.9);
    const F = forward(heading);
    const ax = p.x + F.x * look, az = p.z + F.z * look;
    const wet = W.isWater(ax, az);
    if (!info.flyer && (info.swimmer ? !wet : wet)) {
      const aw = W.awayFromLake(p, info.swimmer);
      heading += angDiff(heading, aw) * 0.6;
    }
    if (!(info.flyer && A.state?.grounded === false)) for (const o of W.obstacles) {
      const dx = o.x - p.x, dz = o.z - p.z, dd = Math.hypot(dx, dz);
      if (dd < o.r + look && dd > 1e-3) {
        const a = Math.atan2(dx, dz), da = angDiff(heading, a);
        if (Math.abs(da) < 0.9) heading -= Math.sign(da || 1) * (0.9 - Math.abs(da)) * 0.8;
      }
    }
    return heading;
  }

  // returns a command: { move: {speed, heading, climb, gait}, look } or { moveTo: point, speed, look }
  update(dt, time) {
    const A = this.animal;
    if (!A) return null;
    const info = this.info, G = this.gaits;
    let speed = 0, heading = A.heading, climb = 0, look = null, gait = null;

    if (this.mode === 'auto') {
      this.stateT += dt;
      if (this.stateT > this.stateDur) {
        if (this.posture && this.actions.has('stand')) this.onAction?.('stand');
        this.next();
      }
      const s = this.state;
      if (s === 'idle') {
        this.lookT -= dt;
        if (this.lookT <= 0) {
          this.lookT = rand(1.2, 3.2);
          if (Math.random() < 0.3 && this.camera) this.look = this.camera.position.clone();
          else {
            const a = A.heading + rand(-1.4, 1.4), R = 12 * info.scale;
            const px = A.position.x + Math.sin(a) * R, pz = A.position.z + Math.cos(a) * R;
            this.look = new THREE.Vector3(px, this.world.ground(px, pz) + rand(0.1, 0.9) * info.scale, pz);
          }
        }
        look = this.look;
      } else if (s === 'wander') {
        speed = G.walk;
        this.baseHeading += Math.sin(time * 0.37 + this.zig) * 0.35 * dt;
        heading = this.baseHeading = this._steer(this.baseHeading, speed);
        if (info.swimmer) climb = Math.sin(time * 0.3 + this.zig) * 0.35;
      } else if (s === 'fly') {
        // a flight: cruise round the area a few metres up, rising and falling a little, then land
        speed = G.fly * Math.min(1, 0.4 + this.stateT / 1.5);
        this.baseHeading += (0.25 + Math.sin(time * 0.21 + this.zig) * 0.35) * dt;
        heading = this.baseHeading = this._steer(this.baseHeading, speed);
        const alt = A.state?.altitude ?? 0;
        climb = THREE.MathUtils.clamp((this.alt + Math.sin(time * 0.4 + this.zig) * 1.2 - alt) * 0.6, -2, 3);
        if (this.stateT > this.stateDur - 3) { speed = 0; climb = 0; }
      } else if (s === 'run') {
        const opts = (G.ground || G.list).slice(1);
        const g = opts.length ? opts[Math.floor(this.zig * 10) % opts.length] : G.list[0];
        speed = (g ? g.speed : G.walk * 2) * Math.min(1, this.stateT / 1.0);
        gait = null;
        this.baseHeading += Math.sin(time * 0.5 + this.zig) * 0.4 * dt;
        heading = this.baseHeading = this._steer(this.baseHeading, speed);
      } else if (s === 'action') {
        if (!this.played) { this.played = true; this.onAction?.(this.actionName); }
      } else if (s === 'trip' || s === 'perch') {
        const T = this.tripTarget;
        const to = new THREE.Vector3(T.x - A.position.x, 0, T.z - A.position.z);
        const dist = to.length();
        if (s === 'perch' && !this.played) { this.played = true; this.onAction?.('perch', { target: T.clone(), position: T.clone() }); }
        if (s === 'trip') {
          if (dist > 0.3 * info.span + 0.04 * info.scale && this.stateT < 25) return { moveTo: T, speed: this.tripSpeed(), look: T };
          if (!this.played) { this.played = true; this.onAction?.(this.tripAction); this.stateDur = this.stateT + 6; }
        }
      }
    } else if (this.mode === 'target' && this.target) {
      const to = this.target.clone().sub(A.position);
      to.y = 0;
      if (to.length() < 0.3 * info.span + 0.02 * info.scale || (to.length() < 1.2 * info.span && (A.speed || 0) < 0.05 * G.walk && (this._tT = (this._tT || 0) + dt) > 1)) { this._tT = 0; this.target = null; this.mode = 'manual'; this.cruise = 0; this.onStatus?.(); }
      else return { moveTo: this.target, speed: this.targetSpeed(to.length()), look: this.target };
    } else {
      // manual: camera-relative direction from keys / joystick; otherwise cruise straight on
      let ix = 0, iz = 0, mag = 0;
      const K = this.keys;
      const kx = (K.has('right') ? 1 : 0) - (K.has('left') ? 1 : 0), kz = (K.has('fwd') ? 1 : 0) - (K.has('back') ? 1 : 0);
      if (this.stick.active && Math.hypot(this.stick.x, this.stick.y) > 0.12) { ix = this.stick.x; iz = -this.stick.y; mag = Math.min(1, Math.hypot(ix, iz)); }
      else if (kx || kz) { ix = kx; iz = kz; mag = 1; }
      if (mag > 0 && this.camera) {
        const cf = new THREE.Vector3();
        this.camera.getWorldDirection(cf);
        cf.y = 0;
        if (cf.lengthSq() < 1e-6) cf.set(0, 0, 1);
        cf.normalize();
        const cr = new THREE.Vector3(-cf.z, 0, cf.x);
        const dir = cf.multiplyScalar(iz).addScaledVector(cr, ix);
        heading = Math.atan2(dir.x, dir.z);
        // flyers: ground gears on the ground, the flight gear once airborne (Shift / a flight gear takes off)
        const airborne = info.flyer && A.state?.grounded === false;
        const cap = info.flyer ? (airborne ? G.fly * 1.1 : G.top) : G.max;
        const base = this.cruise > 0 ? this.cruise : K.has('run') ? (info.flyer ? G.fly : G.max) : this.stick.active ? Math.max(cap * 0.5, G.walk) : G.walk * 1.4;
        speed = this.stick.active && this.cruise <= 0 ? base * mag * mag + G.walk * 0.3 * mag : base * mag;
        gait = this.cruise > 0 ? this.gait : null;
      } else {
        speed = this.cruise;
        gait = this.gait;
        // cruising hands-off: keep going, but steer round the lake (or stay in it), props and the edge
        heading = speed > 0 ? this._steer(A.heading, speed) : A.heading;
      }
    }
    climb = this.climbInput() * (info.flyer ? 2 : 1) || climb;
    // land animals do not wade into deep water (swimmers and flyers go where they like)
    if (speed > 0 && !info.swimmer && !info.flyer) {
      const F = forward(heading), ahead = Math.max(0.6 * info.length, speed * 0.45);
      if (this.world.depthAt(A.position.x + F.x * ahead, A.position.z + F.z * ahead) > 0.3 * info.height) speed = 0;
    }
    return { move: { speed, heading, climb, gait: gait || undefined }, look };
  }

  tripSpeed() {
    const G = this.gaits, list = G.ground || G.list;
    return Math.min(list[1]?.speed || G.walk * 2, G.walk * 2.5);
  }

  targetSpeed(d) {
    const G = this.gaits;
    if (this.cruise > 0) return this.cruise;
    const list = G.list;
    const pick = d > 30 ? list[list.length - 1] : d > 12 ? list[Math.min(2, list.length - 1)] : d > 5 ? list[Math.min(1, list.length - 1)] : list[0];
    return pick ? pick.speed : G.walk;
  }

  climbInput() {
    const K = this.keys;
    return this.climbBtn || ((K.has('up') ? 1 : 0) - (K.has('down') ? 1 : 0));
  }

  get status() {
    if (this.mode === 'auto') {
      const s = this.state;
      if (s === 'action') return 'Autopilot · ' + this.actionName;
      if (s === 'trip') return this.played ? 'Drinking' : 'Heading to the water';
      if (s === 'perch') return 'Perching';
      return { idle: 'Looking around', wander: this.info?.swimmer ? 'Swimming' : 'Wandering', run: 'On the move', fly: 'Flying' }[s] || 'Autopilot';
    }
    if (this.mode === 'target') return 'Heading to target';
    return this.cruise > 0 ? 'Manual · cruising' : 'Manual';
  }
}
