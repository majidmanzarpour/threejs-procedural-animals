// CPU dual-quaternion skinning, a line-by-line port of the GPU path (core/render/dqs.js): bind-space
// scale pre-pass, then the rigid DQ blend with antipodality fix against the first influence.
// Works from the skeleton contract only (bones[i].matrixWorld and the bind matrices), so it does not
// depend on the renderer's texture layout.
import * as THREE from 'three';

export class CpuSkin {
  /** @param bind  array of THREE.Matrix4 (bind pose world matrices, skeleton.bind) */
  constructor(bind) {
    const n = (this.n = bind.length);
    this.D = new Float64Array(n * 20);
    this.bindQinv = []; this.bindT = []; this.bindR = [];
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (const m of bind) {
      m.decompose(p, q, s);
      this.bindQinv.push(q.clone().invert());
      this.bindT.push(p.clone());
      this.bindR.push(new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q)));
    }
    this._p = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._t = new THREE.Vector3();
    this._A = new THREE.Matrix3(); this._S = new THREE.Matrix3(); this._RT = new THREE.Matrix3(); this._m = new THREE.Matrix4();
  }

  /** Load a pose: `mats` is either an array of Matrix4 or a flat Float32Array/Float64Array of n*16. */
  setPose(mats) {
    const d = this.D, p = this._p, q = this._q, s = this._s, t = this._t;
    for (let i = 0; i < this.n; i++) {
      const M = mats.length === this.n && mats[0].isMatrix4 ? mats[i] : this._m.fromArray(mats, i * 16);
      M.decompose(p, q, s);
      q.multiply(this.bindQinv[i]);
      t.copy(this.bindT[i]).applyQuaternion(q).negate().add(p);
      const o = i * 20, qx = q.x, qy = q.y, qz = q.z, qw = q.w, tx = t.x, ty = t.y, tz = t.z;
      d[o] = qx; d[o + 1] = qy; d[o + 2] = qz; d[o + 3] = qw;
      d[o + 4] = 0.5 * (qw * tx + ty * qz - tz * qy);
      d[o + 5] = 0.5 * (qw * ty + tz * qx - tx * qz);
      d[o + 6] = 0.5 * (qw * tz + tx * qy - ty * qx);
      d[o + 7] = -0.5 * (tx * qx + ty * qy + tz * qz);
      if (Math.abs(s.x - 1) + Math.abs(s.y - 1) + Math.abs(s.z - 1) < 1e-5) {
        d.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], o + 8);
      } else {
        const R = this.bindR[i];
        this._S.set(s.x, 0, 0, 0, s.y, 0, 0, 0, s.z);
        this._RT.copy(R).transpose();
        const e = this._A.multiplyMatrices(R, this._S).multiply(this._RT).elements;
        const b = this.bindT[i];
        d[o + 8] = e[0]; d[o + 9] = e[3]; d[o + 10] = e[6]; d[o + 11] = b.x - (e[0] * b.x + e[3] * b.y + e[6] * b.z);
        d[o + 12] = e[1]; d[o + 13] = e[4]; d[o + 14] = e[7]; d[o + 15] = b.y - (e[1] * b.x + e[4] * b.y + e[7] * b.z);
        d[o + 16] = e[2]; d[o + 17] = e[5]; d[o + 18] = e[8]; d[o + 19] = b.z - (e[2] * b.x + e[5] * b.y + e[8] * b.z);
      }
    }
  }

  /**
   * Skin vertices of `data` (pos, skinIndex, skinWeight) into out (Float32Array nV*3).
   * @param verts optional Int32Array of vertex indices (out is then packed: out[k*3] = vertex verts[k])
   */
  skin(data, out, verts = null) {
    const D = this.D, pos = data.pos, SI = data.skinIndex, SW = data.skinWeight;
    const N = verts ? verts.length : data.nV;
    for (let k = 0; k < N; k++) {
      const v = verts ? verts[k] : k;
      const px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2];
      let sx = 0, sy = 0, sz = 0, r0 = 0, r1 = 0, r2 = 0, r3 = 0, d0 = 0, d1 = 0, d2 = 0, d3 = 0, ws = 0;
      const b0 = SI[v * 4] * 20;
      const a0 = D[b0], a1 = D[b0 + 1], a2 = D[b0 + 2], a3 = D[b0 + 3];
      for (let j = 0; j < 4; j++) {
        const w = SW[v * 4 + j];
        if (!(w > 0)) continue;
        const o = SI[v * 4 + j] * 20;
        ws += w;
        sx += w * (D[o + 8] * px + D[o + 9] * py + D[o + 10] * pz + D[o + 11]);
        sy += w * (D[o + 12] * px + D[o + 13] * py + D[o + 14] * pz + D[o + 15]);
        sz += w * (D[o + 16] * px + D[o + 17] * py + D[o + 18] * pz + D[o + 19]);
        const s = D[o] * a0 + D[o + 1] * a1 + D[o + 2] * a2 + D[o + 3] * a3 < 0 ? -w : w;
        r0 += s * D[o]; r1 += s * D[o + 1]; r2 += s * D[o + 2]; r3 += s * D[o + 3];
        d0 += s * D[o + 4]; d1 += s * D[o + 5]; d2 += s * D[o + 6]; d3 += s * D[o + 7];
      }
      ws = Math.max(ws, 1e-5);
      sx /= ws; sy /= ws; sz /= ws;
      const L = Math.max(Math.hypot(r0, r1, r2, r3), 1e-6);
      const qx = r0 / L, qy = r1 / L, qz = r2 / L, qw = r3 / L, dx = d0 / L, dy = d1 / L, dz = d2 / L, dw = d3 / L;
      const tx = 2 * (qw * dx - dw * qx + (qy * dz - qz * dy));
      const ty = 2 * (qw * dy - dw * qy + (qz * dx - qx * dz));
      const tz = 2 * (qw * dz - dw * qz + (qx * dy - qy * dx));
      // v + 2 q x (q x v + w v)
      const cx = qy * sz - qz * sy + qw * sx, cy = qz * sx - qx * sz + qw * sy, cz = qx * sy - qy * sx + qw * sz;
      out[k * 3] = sx + 2 * (qy * cz - qz * cy) + tx;
      out[k * 3 + 1] = sy + 2 * (qz * cx - qx * cz) + ty;
      out[k * 3 + 2] = sz + 2 * (qx * cy - qy * cx) + tz;
    }
    return out;
  }
}

/** Snapshot of the skeleton's world matrices as a flat Float32Array (n*16). */
export function snapshotPose(skeleton, out = new Float32Array(skeleton.bones.length * 16)) {
  skeleton.bones.forEach((b, i) => out.set(b.matrixWorld.elements, i * 16));
  return out;
}
