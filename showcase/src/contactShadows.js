// Soft contact occlusion under feet and bodies (multiplicative decals that follow the terrain).
// Works for any species: feet are the leaf bones that touch the ground in the bind pose (at a leg);
// a legless body (a snake) gets a chain of soft blobs along its whole axis instead of one body blob.
import * as THREE from 'three';
import { footPositions, bodyCenter, bodyAxis } from './subject.js';

const UP = new THREE.Vector3(0, 1, 0);

export class ContactShadows {
  constructor(ground, normal, max = 1024) {
    this.ground = ground;
    this.normal = normal;
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const m = new THREE.ShaderMaterial({
      vertexShader: `varying vec2 vUv; varying float vS;
        void main(){ vUv = uv; vS = instanceColor.r; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec2 vUv; varying float vS;
        void main(){ vec2 d = (vUv - 0.5) * 2.0; float r = dot(d,d); float a = exp(-r * 3.2) * (1.0 - smoothstep(0.7, 1.0, r)) * vS; gl_FragColor = vec4(vec3(1.0 - a), 1.0); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.InstancedMesh(g, m, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.max = max;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._qy = new THREE.Quaternion();
    this._c = new THREE.Color();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._f = new THREE.Vector3();
    this._feet = [];
    this._axis = [];
    this.mesh.setColorAt(0, this._c.setRGB(0, 0, 0));
    this.mesh.count = 0;
  }

  _put(i, x, z, heading, sx, sz, strength, lift = 0.006) {
    const gy = this.ground(x, z);
    this._q.setFromUnitVectors(UP, this.normal(x, z)).multiply(this._qy.setFromAxisAngle(UP, heading));
    this._m.compose(this._p.set(x, gy + lift, z), this._q, this._s.set(sx, 1, sz));
    this.mesh.setMatrixAt(i, this._m);
    this.mesh.setColorAt(i, this._c.setRGB(strength, 0, 0));
  }

  // entries: [{ animal, info, feet: bool, k: strength scale (default 1), always: drawn even while the
  // animal's own object is hidden (the demo reel's "how it's made" layers stand in for it) }]
  update(entries) {
    let i = 0;
    for (const { animal, info, feet, k: km = 1, always = false } of entries) {
      if (!always && !animal.object.visible) continue;
      if (km <= 0.003) continue;
      const s = info.scale;
      const h = animal.heading;
      const lift = 0.0005 + 0.0055 * Math.min(1, s); // decal height above the ground: tiny for tiny animals
      if (info.axis) { i = this._putAxis(i, animal, info, feet ? 1 : 8, lift, km); continue; }
      if (feet) {
        for (const p of footPositions(animal, info, this._feet)) {
          if (i >= this.max - 1) break;
          const above = Math.max(0, p.y - this.ground(p.x, p.z));
          const k = Math.max(0, 1 - above / (0.18 * s)) * 0.55 * km;
          if (k <= 0.01 * km) continue;
          this._put(i++, p.x, p.z, h, (0.13 + above * 0.4) * s, (0.16 + above * 0.4) * s, k, lift);
        }
      }
      if (i >= this.max) break;
      const c = bodyCenter(animal, this._f);
      const above = Math.max(0, c.y - this.ground(c.x, c.z));
      const k = Math.min(0.5, (0.28 * s) / Math.max(0.2 * s, above + 0.55 * s)) * Math.max(0, 1 - above / (3 * s)) * km;
      if (k > 0.01 * km) this._put(i++, c.x, c.z, h, info.width * 2.1 + 0.1 * s, info.length * 0.7, k, lift);
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  // A legless body lying along the ground: soft blobs along its axis (head tip -> tail tip), each as wide
  // as the body there and as long as its segment, fading and spreading where the body is off the
  // ground (a raised head, a strike). `cap`: at most that many blobs (crowd members get a coarse chain).
  // Returns the next free instance.
  _putAxis(i, animal, info, cap, lift, km = 1) {
    const P = bodyAxis(animal, info, this._axis), ax = info.axis, n = P.length - 1;
    if (n < 1) return i;
    const step = cap > 1 && n > cap ? Math.ceil(n / cap) : 1, s = info.scale;
    for (let k = 0; k < n && i < this.max; k += step) {
      const k1 = Math.min(n, k + step), a = P[k], b = P[k1];
      let hw = 0, under = 0;
      for (let j = k; j < k1; j++) { hw = Math.max(hw, ax.hw[j]); under = Math.max(under, ax.under[j]); }
      const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2, dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      // clearance of the belly over the ground at this segment
      const up = Math.max(0, Math.min(a.y - this.ground(a.x, a.z), b.y - this.ground(b.x, b.z)) - under);
      const k0 = 0.34 / (1 + up / (1.5 * hw)) ** 2 * Math.max(0, 1 - up / (8 * hw + 0.15 * s)) * km;
      if (k0 <= 0.01) continue;
      // blobs ~2.4 segments long overlap their neighbours: the strength per blob keeps the sum even
      const sz = Math.max(len, hw) * 2.4 + up, sx = hw * 3.6 + up * 0.8;
      this._put(i++, x, z, Math.atan2(dx, dz), sx, sz, Math.min(0.6, (k0 * Math.max(len, 1e-4)) / (0.495 * sz)), lift);
    }
    return i;
  }
}
