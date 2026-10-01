// "Under the hood" views for any species: the animated skeleton, the motion engine's IK targets,
// and the SDF primitives riding on their bones. Primitives are stored in reference space; each is
// placed with bone.matrixWorld * scale(final/reference bone length) * inverse(reference bind frame).
import * as THREE from 'three';

const GROUP_COL = { axial: 0xe0a13a, FL: 0x4fb3d9, FR: 0x3b7fd9, HL: 0x7fd95a, HR: 0x3fa65a, earL: 0xd96bb3, earR: 0xd96bb3, jaw: 0xd9533b, wingL: 0x9b7fe0, wingR: 0x7f5fd0, tail: 0xe07f3a };
const colorFor = (g) => {
  if (GROUP_COL[g] !== undefined) return GROUP_COL[g];
  let h = 0;
  for (const c of String(g)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.6, 0.6).getHex();
};

function frameMatrix(o, t) {
  const Y = new THREE.Vector3(t[0] - o[0], t[1] - o[1], t[2] - o[2]).normalize();
  const X = new THREE.Vector3(1, 0, 0);
  X.addScaledVector(Y, -X.dot(Y));
  if (X.lengthSq() < 1e-10) X.set(0, 0, 1).addScaledVector(Y, -Y.z);
  X.normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);
  return new THREE.Matrix4().set(X.x, Y.x, Z.x, o[0], X.y, Y.y, Z.y, o[1], X.z, Y.z, Z.z, o[2], 0, 0, 0, 1);
}

function roundCone(ra, rb, L) {
  const pts = [];
  const n = 8;
  for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / n) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.cos(a) * ra, Math.sin(a) * ra)); }
  for (let i = 0; i <= n; i++) { const a = (i / n) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.cos(a) * rb, L + Math.sin(a) * rb)); }
  return new THREE.LatheGeometry(pts, 16);
}

export class DebugViews {
  constructor(scene, animal, info) {
    this.scene = scene;
    this.animal = animal;
    const data = animal.data;
    const bones = data.bones;
    const s = info.scale;
    this.boneLen = info.boneLen;
    this.disposables = [];
    const track = (x) => { this.disposables.push(x); return x; };

    // skeleton
    const lg = track(new THREE.BufferGeometry());
    this.linePos = new Float32Array(bones.length * 6);
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    const lineCol = new Float32Array(bones.length * 6);
    bones.forEach((b, i) => { const c = new THREE.Color(colorFor(b.group)); lineCol.set([1, 0.95, 0.85, c.r, c.g, c.b], i * 6); });
    lg.setAttribute('color', new THREE.BufferAttribute(lineCol, 3));
    this.lines = new THREE.LineSegments(lg, track(new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 })));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 50;
    this.joints = new THREE.InstancedMesh(track(new THREE.SphereGeometry(0.016 * s, 10, 6)), track(new THREE.MeshBasicMaterial({ color: 0xfdf6e6, depthTest: false })), bones.length);
    this.joints.renderOrder = 51;
    this.joints.frustumCulled = false;
    this.targets = new THREE.InstancedMesh(track(new THREE.SphereGeometry(0.026 * s, 12, 8)), track(new THREE.MeshBasicMaterial({ color: 0xff4a2a, depthTest: false })), 32);
    this.targets.renderOrder = 52;
    this.targets.frustumCulled = false;
    this.targets.count = 0;
    // attachment points (animal.attachments: named Object3Ds riding on bones), when the species has any
    this.attach = Object.values(animal.attachments || {}).filter((o) => o && o.isObject3D);
    this.attachMarks = new THREE.InstancedMesh(track(new THREE.OctahedronGeometry(0.018 * s)), track(new THREE.MeshBasicMaterial({ color: 0x5fe0d0, depthTest: false })), Math.max(1, this.attach.length));
    this.attachMarks.renderOrder = 53;
    this.attachMarks.frustumCulled = false;
    this.attachMarks.count = this.attach.length;
    this.skel = new THREE.Group();
    this.skel.add(this.lines, this.joints, this.targets, this.attachMarks);
    this.skel.visible = false;
    scene.add(this.skel);

    // SDF primitives
    this.sdf = new THREE.Group();
    this.sdf.visible = false;
    this.prims = [];
    const byName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
    const ref = data.refJoints || data.joints;
    const refBindInv = bones.map((b) => (ref[b.headJ] && ref[b.tailJ] ? frameMatrix(ref[b.headJ], ref[b.tailJ]).invert() : new THREE.Matrix4()));
    const ratio = bones.map((b, i) => {
      const h = ref[b.headJ], t = ref[b.tailJ];
      const L = h && t ? Math.hypot(t[0] - h[0], t[1] - h[1], t[2] - h[2]) : 0;
      return L > 1e-5 ? this.boneLen[i] / L : data.params?.size || 1;
    });
    const sphere = track(new THREE.SphereGeometry(1, 20, 14));
    const mats = {};
    for (const p of data.prims || []) {
      if (p.carve || p.type > 1) continue;
      const bi = byName[p.bone];
      if (bi === undefined) continue;
      const mat = mats[p.group] || (mats[p.group] = track(new THREE.MeshStandardMaterial({ color: colorFor(p.group), roughness: 0.45, transparent: true, opacity: 0.55, depthWrite: false })));
      const P = p.P;
      let mesh;
      const bind = new THREE.Matrix4();
      if (p.type === 0) {
        mesh = new THREE.Mesh(sphere, mat);
        bind.makeBasis(new THREE.Vector3(P[3], P[4], P[5]), new THREE.Vector3(P[6], P[7], P[8]), new THREE.Vector3(P[9], P[10], P[11]));
        bind.scale(new THREE.Vector3(P[12], P[13], P[14]));
        bind.setPosition(P[0], P[1], P[2]);
      } else {
        const ba = new THREE.Vector3(P[3], P[4], P[5]);
        mesh = new THREE.Mesh(track(roundCone(P[10], P[11], ba.length())), mat);
        bind.makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), ba.clone().normalize()));
        bind.setPosition(P[0], P[1], P[2]);
      }
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      const local = new THREE.Matrix4().makeScale(ratio[bi], ratio[bi], ratio[bi]).multiply(refBindInv[bi]).multiply(bind);
      this.prims.push({ mesh, local, bi });
      this.sdf.add(mesh);
    }
    scene.add(this.sdf);
    this._m = new THREE.Matrix4();
    this._o = new THREE.Vector3();
    this._y = new THREE.Vector3();
  }

  get active() { return this.skel.visible || this.sdf.visible; }

  update() {
    const sk = this.animal.render?.skeleton;
    if (!sk) return;
    if (this.skel.visible) {
      const m4 = this._m;
      sk.bones.forEach((bone, i) => {
        const mw = bone.matrixWorld;
        const o = this._o.setFromMatrixPosition(mw);
        const y = this._y.setFromMatrixColumn(mw, 1).normalize();
        this.linePos[i * 6] = o.x; this.linePos[i * 6 + 1] = o.y; this.linePos[i * 6 + 2] = o.z;
        this.linePos[i * 6 + 3] = o.x + y.x * this.boneLen[i]; this.linePos[i * 6 + 4] = o.y + y.y * this.boneLen[i]; this.linePos[i * 6 + 5] = o.z + y.z * this.boneLen[i];
        this.joints.setMatrixAt(i, m4.makeTranslation(o.x, o.y, o.z));
      });
      this.lines.geometry.attributes.position.needsUpdate = true;
      this.joints.instanceMatrix.needsUpdate = true;
      const tg = this.animal.motion?.debug?.targets || [];
      const n = Math.min(32, tg.length);
      for (let i = 0; i < n; i++) {
        const p = tg[i];
        if (p && Number.isFinite(p.x)) this.targets.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z));
      }
      this.targets.count = n;
      this.targets.instanceMatrix.needsUpdate = true;
      this.attach.forEach((o, i) => { this._o.setFromMatrixPosition(o.matrixWorld); this.attachMarks.setMatrixAt(i, m4.makeTranslation(this._o.x, this._o.y, this._o.z)); });
      if (this.attach.length) this.attachMarks.instanceMatrix.needsUpdate = true;
    }
    if (this.sdf.visible) {
      for (const p of this.prims) {
        p.mesh.matrix.multiplyMatrices(sk.bones[p.bi].matrixWorld, p.local);
        p.mesh.matrixWorld.copy(p.mesh.matrix);
      }
    }
  }

  dispose() {
    this.skel.removeFromParent();
    this.sdf.removeFromParent();
    this.joints.dispose();
    this.targets.dispose();
    this.attachMarks.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
