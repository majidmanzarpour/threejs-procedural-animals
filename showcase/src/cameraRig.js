// Cameras: 'orbit' (free orbit around the animal, it does not follow the heading), 'follow' (a chase
// camera behind the animal you can still drag around) and 'director' (automatic wildlife-documentary
// shots, ported from the cheetah page). All distances scale with the animal's size.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { forward, left } from './subject.js';

const lerp = (a, b, t) => a + (b - a) * t;
const _F = new THREE.Vector3(), _L = new THREE.Vector3();

export class CameraRig {
  // ground(x, z): the lowest camera height (terrain, or the water surface over the lake);
  // bed(x, z): the terrain itself, the floor of a chase camera following a swimmer under water
  constructor(camera, dom, ground, bed = ground) {
    this.camera = camera;
    this.ground = ground;
    this.bed = bed;
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.mode = 'director';
    this.focus = new THREE.Vector3();
    this.focusY = null;
    this.shot = null;
    this.shotT = 0;
    this.shotDur = 0;
    this.smoothPos = new THREE.Vector3();
    this.sunDir = null;
    this.firstShot = true;
    this.scale = 1;
    this.followOffset = new THREE.Vector3();
    this.onMode = null;
    this.controls.addEventListener('start', () => { if (this.mode === 'director') this.setMode('orbit'); this.dragging = true; });
    this.controls.addEventListener('end', () => { this.dragging = false; if (this.mode === 'follow') this._captureFollow(); });
    this.controls.enabled = false;
  }

  setScale(s) {
    this.scale = s;
    this.controls.minDistance = 0.6 * s;
    this.controls.maxDistance = 40 * Math.max(1, s);
    // near plane follows the animal's size (a 3 cm spider seen from 15 cm), far stays at the horizon
    const near = THREE.MathUtils.clamp(0.03 * s, 0.002, 0.03);
    if (Math.abs(this.camera.near - near) > 1e-6) { this.camera.near = near; this.camera.updateProjectionMatrix(); }
  }

  setMode(m) {
    if (m === this.mode) return;
    const prev = this.mode;
    this.mode = m;
    this.controls.enabled = m !== 'director';
    if (m !== 'director') {
      this.controls.target.copy(this.focus);
      if (prev === 'director' && m === 'follow') this.followOffset.set(0, 0, 0);
      this._heading = null;
    } else this.shot = null;
    if (this.onMode) this.onMode(m);
  }

  _captureFollow() {
    // remember where the user put the camera relative to the animal's heading
    const d = this.camera.position.clone().sub(this.focus);
    const h = this._heading ?? 0;
    this.followOffset.set(d.dot(left(h, _L)), d.y, d.dot(forward(h, _F)));
  }

  fitFov(f) {
    const a = this.camera.aspect;
    if (a >= 1.5) return f;
    const k = Math.pow(1.5 / a, 0.6);
    return Math.min(72, (2 * Math.atan(Math.tan((f * Math.PI) / 360) * k) * 180) / Math.PI);
  }

  cut() { this.shot = null; this.focusY = null; this.firstShot = true; }

  pickShot(sub) {
    const v = sub.speed / Math.max(0.3, Math.sqrt(this.scale));
    const shots = sub.flying ? ['trackSide', 'lowChase', 'orbit', 'front34']
      : v > 8 ? ['trackSide', 'trackSide', 'lowChase', 'aheadLow'] : v > 0.3 ? ['front34', 'trackSide', 'lowChase', 'front34'] : ['orbit', 'head', 'front34', 'orbit'];
    let s = shots[Math.floor(Math.random() * shots.length)];
    if (this.shot && s === this.shot.name && Math.random() < 0.7) s = shots[(shots.indexOf(s) + 1) % shots.length];
    if (this.firstShot) s = 'front34';
    let side = Math.random() < 0.5 ? 1 : -1;
    let seed = Math.random() * 10;
    if (this.sunDir && (this.firstShot || Math.random() < 0.9)) {
      const Lf = left(sub.heading, _L);
      const d = Lf.x * this.sunDir.x + Lf.z * this.sunDir.z;
      if (Math.abs(d) > 0.12) side = Math.sign(d);
      seed = Math.atan2(this.sunDir.z, this.sunDir.x) + (Math.random() - 0.5) * 1.0 - side * 0.35;
    }
    this.shot = { name: s, side, seed };
    this.shotT = 0;
    this.shotDur = s === 'trackSide' ? 7 : s === 'head' ? 5 : this.firstShot ? 9 : 6.5;
    this.firstShot = false;
    this.lastSpeedClass = v > 8 ? 2 : v > 0.3 ? 1 : 0;
  }

  // sub: { position, heading, speed, head (Vector3), height, flying, swimmer, waterLevel }
  update(dt, sub) {
    let S = this.scale;
    const target = new THREE.Vector3(sub.position.x, 0, sub.position.z);
    const cy = sub.position.y + sub.height * 0.55;
    if (this.focusY === null) this.focusY = cy;
    this.focusY = lerp(this.focusY, cy, 1 - Math.exp(-dt * 4));
    target.y = this.focusY;
    const delta = target.clone().sub(this.focus);
    this.focus.copy(target);
    this._heading = this._heading == null ? sub.heading : this._heading;

    if (this.mode !== 'director') {
      const want = this.fitFov(40);
      if (Math.abs(this.camera.fov - want) > 0.01) { this.camera.fov = want; this.camera.updateProjectionMatrix(); }
      if (this.mode === 'follow' && !this.dragging) {
        // chase: keep the user's offset in the animal's frame, lag the heading a little
        let dh = sub.heading - this._heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        this._heading += dh * (1 - Math.exp(-dt * 2.5));
        // (swimmers: a little above and behind, under the surface - see the water clamp below)
        if (this.followOffset.lengthSq() < 1e-6) this.followOffset.set(1.2 * S, (sub.swimmer ? 0.25 : 0.9) * S, -3.6 * S);
        const F = forward(this._heading, _F), L = left(this._heading, _L);
        const want = this.focus.clone().addScaledVector(L, this.followOffset.x).addScaledVector(F, this.followOffset.z);
        want.y += this.followOffset.y;
        // a swimmer is chased from within the water: a camera that would stand on the shore (a big
        // shark in a small lake) comes in along its offset until it is over water deep enough
        if (sub.swimmer && Number.isFinite(sub.waterLevel)) {
          const deep = (p) => this.bed(p.x, p.z) < sub.waterLevel - 0.25 * Math.min(1, S);
          if (!deep(want)) {
            let lo = 0, hi = 1;
            const q = new THREE.Vector3();
            for (let i = 0; i < 8; i++) { const m = (lo + hi) / 2; q.lerpVectors(this.focus, want, m); if (deep(q)) lo = m; else hi = m; }
            want.lerpVectors(this.focus, want, Math.max(0.15, lo));
          }
        }
        // carry the camera with the animal first (no lag behind a fast flyer), then ease the framing
        this.camera.position.add(delta);
        this.camera.position.lerp(want, 1 - Math.exp(-dt * 6));
      } else {
        this.camera.position.add(delta);
        if (this.mode === 'follow') this._heading = sub.heading;
      }
      this.controls.target.copy(this.focus);
      this.controls.update();
      const under = this.mode === 'follow' && sub.swimmer && Number.isFinite(sub.waterLevel);
      const gy = (under ? this.bed : this.ground)(this.camera.position.x, this.camera.position.z) + 0.15 * Math.min(1, S);
      if (this.camera.position.y < gy) this.camera.position.y = gy;
      // follow a swimmer under water: the chase camera stays below the surface (unless the water is
      // too shallow for it, then half way between the bed and the surface)
      if (under) {
        const top = sub.waterLevel - 0.08 * Math.min(1, S);
        if (this.camera.position.y > top) this.camera.position.y = Math.max(top, (gy + sub.waterLevel) * 0.5);
      }
      return;
    }
    // ---------------- director
    const v = sub.speed / Math.max(0.3, Math.sqrt(this.scale));
    const speedClass = v > 8 ? 2 : v > 0.3 ? 1 : 0;
    this.shotT += dt;
    if (!this.shot || this.shotT > this.shotDur || (speedClass !== this.lastSpeedClass && this.shotT > 1.5)) this.pickShot(sub);
    const F = forward(sub.heading, _F).clone(), Lf = left(sub.heading, _L).clone();
    const s = this.shot.side;
    // flyers get wider shots (wingspan, banked turns)
    if (sub.flying) S *= 1.7;
    const t = this.shotT;
    const pos = new THREE.Vector3();
    let look = this.focus.clone(), fov = 35;
    switch (this.shot.name) {
      case 'trackSide':
        pos.copy(this.focus).addScaledVector(Lf, s * 6.5 * S).addScaledVector(F, (0.6 - t * 0.12) * S);
        pos.y = this.focus.y + 0.45 * S; look.y -= 0.05 * S; fov = 30; break;
      case 'lowChase':
        pos.copy(this.focus).addScaledVector(F, -3.8 * S).addScaledVector(Lf, s * 2.2 * S);
        pos.y = this.focus.y + 0.35 * S; look.addScaledVector(F, 1.2 * S); fov = 42; break;
      case 'aheadLow':
        pos.copy(this.focus).addScaledVector(F, (5.5 - t * 0.35) * S).addScaledVector(Lf, s * 1.8 * S);
        pos.y = this.focus.y + 0.3 * S; fov = 38; break;
      case 'front34':
        pos.copy(this.focus).addScaledVector(F, 2.7 * S).addScaledVector(Lf, s * 2.25 * S);
        pos.y = this.focus.y + 0.2 * S; look.addScaledVector(F, 0.15 * S); fov = 34; break;
      case 'orbit': {
        const a = this.shot.seed + t * 0.12 * s;
        pos.copy(this.focus).add(new THREE.Vector3(Math.cos(a) * 3.6 * S, 0.55 * S, Math.sin(a) * 3.6 * S));
        fov = 38; break;
      }
      case 'head': {
        const hp = sub.head || this.focus;
        const a = sub.heading + s * 0.9;
        pos.copy(hp).add(new THREE.Vector3(Math.sin(a) * 1.25 * S, 0.05 * S, Math.cos(a) * 1.25 * S));
        look = hp.clone().addScaledVector(F, 0.08 * S); look.y -= 0.02 * S;
        fov = 30; break;
      }
    }
    fov = this.fitFov(fov);
    const gy = this.ground(pos.x, pos.z) + 0.75 * Math.min(1.5, S);
    if (pos.y < gy) pos.y = gy;
    if (this.shotT < dt * 1.5) this.smoothPos.copy(pos);
    else { this.smoothPos.add(delta); this.smoothPos.lerp(pos, 1 - Math.exp(-dt * 6)); }
    this.camera.position.copy(this.smoothPos);
    this.camera.lookAt(look);
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = lerp(this.camera.fov, fov, this.shotT < dt * 1.5 ? 1 : 1 - Math.exp(-dt * 3)); this.camera.updateProjectionMatrix(); }
  }
}
