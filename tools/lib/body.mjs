// Body analysis shared by the harness (browser) and the Node tools: legs, feet, body scale and
// world-space joint positions of a posed skeleton. Only uses the packed build data contract
// (data.joints, data.bones) and the render skeleton contract (bones[i].matrixWorld).
import * as THREE from 'three';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Reference leg length (m): the cheetah's mean leg chain at size 1. Used to normalise angular
// velocities by dynamic similarity (omega ~ 1/sqrt(size)).
export const REF_LEG_LENGTH = 0.8;

/**
 * @param {object} data packed build data
 * @returns {{ legs, legLength, scale, bbox, height, length, jointNames, boneLen, parentIndex, headBone }}
 *  legs: [{ key, bones:[i..] (girdle -> foot), foot (bone index), toe (joint name), length }]
 *  scale: characteristic length (m) used to normalise distances: mean leg length, or body length / 4
 */
export function analyseBody(data) {
  const J = data.joints;
  const bones = data.bones;
  const index = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  const parentIndex = bones.map((b) => (b.parent != null && index[b.parent] !== undefined ? index[b.parent] : -1));
  const boneLen = bones.map((b) => dist(J[b.headJ], J[b.tailJ]));
  const groups = {};
  bones.forEach((b, i) => { if (b.group && b.group !== 'axial') (groups[b.group] ||= []).push(i); });
  const legs = [];
  for (const [g, idx] of Object.entries(groups)) {
    const feet = idx.filter((i) => bones[i].region === 'foot');
    if (!feet.length) continue;
    // most distal foot bone: the one no other bone of the group hangs from
    const foot = feet.find((f) => !idx.some((j) => parentIndex[j] === f)) ?? feet[feet.length - 1];
    const chain = [];
    for (let i = foot; i >= 0 && bones[i].group === g; i = parentIndex[i]) chain.unshift(i);
    legs.push({ key: g, bones: chain, foot, toe: bones[foot].tailJ, length: chain.reduce((s, i) => s + boneLen[i], 0) });
  }
  // stable order FL, FR, HL, HR ... when those keys exist
  const order = ['FL', 'FR', 'HL', 'HR'];
  legs.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99) || a.key.localeCompare(b.key));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of Object.values(J)) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  const length = max[2] - min[2], height = max[1] - Math.min(0, min[1]);
  const legLength = legs.length ? legs.reduce((s, l) => s + l.length, 0) / legs.length : 0;
  const scale = legLength > 0 ? legLength : Math.max(length, height) / 4;
  const headBone = index.head ?? bones.findIndex((b) => b.region === 'head');
  return { legs, legLength, scale, bbox: { min, max }, height, length, index, parentIndex, boneLen, headBone };
}

/** Unique joints: [{ name, bone, tail }] where the joint is the head (tail=false) or tail of `bone`. */
export function jointList(data) {
  const seen = new Map();
  data.bones.forEach((b, i) => { if (!seen.has(b.headJ)) seen.set(b.headJ, { name: b.headJ, bone: i, tail: false }); });
  data.bones.forEach((b, i) => { if (!seen.has(b.tailJ)) seen.set(b.tailJ, { name: b.tailJ, bone: i, tail: true }); });
  return [...seen.values()];
}

/** World positions of `joints` (from jointList) for the current skeleton pose into `out` (Float64Array n*3). */
export function jointPositions(skeleton, joints, boneLen, out) {
  const B = skeleton.bones;
  for (let j = 0; j < joints.length; j++) {
    const jt = joints[j], e = B[jt.bone].matrixWorld.elements;
    const L = jt.tail ? boneLen[jt.bone] : 0;
    out[j * 3] = e[12] + e[4] * L;
    out[j * 3 + 1] = e[13] + e[5] * L;
    out[j * 3 + 2] = e[14] + e[6] * L;
  }
  return out;
}

const _v = new THREE.Vector3();
/** World position of the tail joint of bone i. */
export function boneTip(skeleton, i, len, target = new THREE.Vector3()) {
  const e = skeleton.bones[i].matrixWorld.elements;
  return target.set(e[12] + e[4] * len, e[13] + e[5] * len, e[14] + e[6] * len);
}
/** World position of the head joint of bone i. */
export function boneHead(skeleton, i, target = new THREE.Vector3()) {
  return target.setFromMatrixPosition(skeleton.bones[i].matrixWorld);
}

/**
 * Leg states for the current frame: [{ key, stance (bool|null), contact (Vector3|null), toe (Vector3) }].
 * Source, in order: motion.state.legs ({ key, stance, contact }), the interim adapter's loco.legs, or
 * null stance (callers fall back to a height test).
 */
export function legStates(animal, body, out = []) {
  const m = animal.motion;
  const sl = m.state && Array.isArray(m.state.legs) ? m.state.legs : null;
  const ll = !sl && m.loco && Array.isArray(m.loco.legs) ? m.loco.legs : null;
  body.legs.forEach((leg, i) => {
    const o = out[i] || (out[i] = { key: leg.key, stance: null, contact: null, toe: new THREE.Vector3(), source: 'none' });
    boneTip(animal.render.skeleton, leg.foot, body.boneLen[leg.foot], o.toe);
    let s = null;
    if (sl) s = sl.find((x) => x && (x.key === leg.key || x.foot === leg.key || x.name === leg.key)) || sl[i];
    if (s) {
      o.stance = s.stance !== undefined ? !!s.stance : s.state !== undefined ? s.state === 'stance' : null;
      o.contact = s.contact || s.plant || s.position || null;
      o.source = 'state.legs';
    } else if (ll) {
      const l = ll.find((x) => x.def && x.def.key === leg.key) || ll[i];
      o.stance = l ? l.state === 'stance' : null;
      o.contact = l ? l.plant : null;
      o.source = 'loco.legs';
    }
  });
  return out;
}

void _v;
