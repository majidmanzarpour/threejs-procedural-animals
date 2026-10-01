// Demo reel camera toolkit: easing curves, a velocity-aware subject tracker, framing from the animal's
// own size (bounding box / head pose), and the safety constraints (above the terrain and the water, never
// inside an animal). Every camera move of the reel is an analytic function of shot time evaluated
// against a smoothed subject frame, so the path has no hidden state that could jump between frames.
import * as THREE from 'three';

export const clamp = THREE.MathUtils.clamp;
export const lerp = THREE.MathUtils.lerp;
const TAU = Math.PI * 2;

// easing curves: u in [0, 1]
export const ease = {
  linear: (u) => u,
  // smootherstep: zero velocity and acceleration at both ends (for moves that start and stop in-shot)
  inOut: (u) => { u = clamp(u, 0, 1); return u * u * u * (u * (u * 6 - 15) + 10); },
  sine: (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(u, 0, 1)),
  // decelerating (a move already under way at the cut that settles), accelerating (leaves at the cut)
  out: (u) => { u = clamp(u, 0, 1); return 1 - (1 - u) ** 3; },
  outSine: (u) => Math.sin((Math.PI / 2) * clamp(u, 0, 1)),
  in: (u) => { u = clamp(u, 0, 1); return u * u * u; },
  inSine: (u) => 1 - Math.cos((Math.PI / 2) * clamp(u, 0, 1)),
  // slow drift through the whole shot, a little faster in the middle (for moves across cuts)
  drift: (u) => { u = clamp(u, 0, 1); return 0.7 * u + 0.3 * (0.5 - 0.5 * Math.cos(Math.PI * u)); },
};
export const easeOf = (e) => (typeof e === 'function' ? e : ease[e] || ease.inOut);
/** lerp a -> b along an easing curve */
export const tween = (a, b, u, e = 'inOut') => a + (b - a) * easeOf(e)(u);
export const angLerp = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** 0 -> 1 -> 0 envelope: rises over [a, b], holds, falls over [c, d] (with smoothstep edges) */
export const envelope = (t, a, b, c, d) => smoothstep(a, b, t) * (1 - smoothstep(c, d, t));

export const forward = (h, v = new THREE.Vector3()) => v.set(Math.sin(h), 0, Math.cos(h));
export const left = (h, v = new THREE.Vector3()) => v.set(Math.cos(h), 0, -Math.sin(h));

// A vector that follows a raw signal like a critically damped spring (natural frequency w, rad/s) with a
// velocity feed-forward: zero lag for a subject moving at constant velocity (a cheetah at 27 m/s is
// framed where it is, not metres behind), while the camera's acceleration stays continuous when the
// animal changes speed abruptly (a hop, a take-off, a strike) and fast wobble (gait bob, wing beats)
// is filtered out. kv: how fast the velocity reference follows the subject's own velocity.
export class Tracker {
  constructor(w = 3, kv = 3) {
    this.w = w; this.kv = kv; this.soft = 1;
    this.p = new THREE.Vector3();
    this.v = new THREE.Vector3();
    this.vs = new THREE.Vector3();
    this.rawV = new THREE.Vector3();
    this._prev = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this.init = false;
  }
  reset(p, v = null) { this.p.copy(p); this._prev.copy(p); if (v) { this.v.copy(v); this.vs.copy(v); } else { this.v.set(0, 0, 0); this.vs.set(0, 0, 0); } this.init = true; }
  // raw: position now; rawVel (optional): the subject's own velocity (else differentiated)
  update(raw, dt, rawVel = null) {
    if (!this.init) { this.reset(raw, rawVel); return this.p; }
    if (!(dt > 0)) return this.p;
    if (rawVel) this.rawV.copy(rawVel); else this.rawV.copy(raw).sub(this._prev).divideScalar(dt);
    this._prev.copy(raw);
    const w = this.w * this.soft, kv = this.kv * this.soft;
    this.vs.lerp(this.rawV, 1 - Math.exp(-dt * kv));
    // semi-implicit substeps (stable for any frame time)
    const n = Math.max(1, Math.ceil((dt * w) / 0.2)), h = dt / n;
    for (let i = 0; i < n; i++) {
      this._a.copy(raw).sub(this.p).multiplyScalar(w * w).addScaledVector(this.vs, 2 * w).addScaledVector(this.v, -2 * w);
      this.v.addScaledVector(this._a, h);
      this.p.addScaledVector(this.v, h);
    }
    return this.p;
  }
}

// scalar angle tracker (heading), unwrapped, critically damped
export class AngleTracker {
  constructor(w = 2.5) { this.w = w; this.soft = 1; this.a = 0; this.v = 0; this.init = false; }
  reset(a) { this.a = a; this.v = 0; this.init = true; }
  update(a, dt) {
    if (!this.init) { this.reset(a); return this.a; }
    if (!(dt > 0)) return this.a;
    const w = this.w * this.soft;
    const n = Math.max(1, Math.ceil((dt * w) / 0.2)), h = dt / n;
    for (let i = 0; i < n; i++) {
      const e = Math.atan2(Math.sin(a - this.a), Math.cos(a - this.a));
      this.v += (w * w * e - 2 * w * this.v) * h;
      this.a += this.v * h;
    }
    return this.a;
  }
}

/** Distance at which a sphere of radius r fills `fill` of the frame's smaller extent. */
export function fitDistance(r, fovDeg, aspect, fill = 0.7) {
  const tv = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const th = tv * aspect;
  const t = Math.min(tv, th);
  return r / Math.max(1e-4, fill * t);
}

/** The vertical fov that shows the same horizontal field in a narrower (portrait) frame: shots are
 *  authored for 16:9; a 9:16 or 1:1 crop widens the lens a little instead of cutting the animal. */
export function fovFor(fov, aspect, authored = 16 / 9, keep = 0.65) {
  if (aspect >= authored * 0.98) return fov;
  // keep ~65 % of the authored horizontal field (portrait crops are tighter by design; group shots keep
  // more: shot.wide), vertical fov capped
  const th = Math.tan(THREE.MathUtils.degToRad(fov) / 2) * authored * keep;
  const tv = th / aspect;
  return Math.min(78, THREE.MathUtils.radToDeg(2 * Math.atan(tv)));
}

// smooth max: max(a, b) with a rounded corner of width k (keeps the camera path C1 when a constraint
// engages)
export function smax(a, b, k) {
  if (k <= 0) return Math.max(a, b);
  const h = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1);
  return lerp(b, a, h) + k * h * (1 - h);
}

// ------------------------------------------------------------------ the camera state for one frame
export class CamPose {
  constructor() {
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.fov = 35;
    this.roll = 0;
    this.yawOff = 0; // whip-pan yaw offset (radians, about world up at the camera)
    this.pitchOff = 0;
  }
  copy(o) { this.pos.copy(o.pos); this.look.copy(o.look); this.fov = o.fov; this.roll = o.roll; this.yawOff = o.yawOff; this.pitchOff = o.pitchOff; return this; }
}

const _dir = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
/** Applies a CamPose to a PerspectiveCamera (look direction, then whip yaw, then roll). */
export function applyPose(camera, pose, aspect) {
  camera.position.copy(pose.pos);
  _dir.copy(pose.look).sub(pose.pos);
  if (_dir.lengthSq() < 1e-12) _dir.set(0, 0, -1);
  if (pose.yawOff) _dir.applyAxisAngle(_up, pose.yawOff);
  if (pose.pitchOff) { const r = new THREE.Vector3().crossVectors(_dir, _up).normalize(); _dir.applyAxisAngle(r, pose.pitchOff); }
  _m.lookAt(camera.position, _dir.add(camera.position), _up);
  camera.quaternion.setFromRotationMatrix(_m);
  if (pose.roll) camera.quaternion.multiply(_q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), pose.roll));
  const fov = pose.fov;
  if (Math.abs(camera.fov - fov) > 1e-4 || Math.abs(camera.aspect - aspect) > 1e-6) { camera.fov = fov; camera.aspect = aspect; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld(true);
}

export { TAU };
