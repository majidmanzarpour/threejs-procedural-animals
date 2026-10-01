// Species-agnostic facts about a built animal, derived only from the public Animal object
// (animal.data, animal.render.skeleton, animal.state): size, feet, head position, frames.
import * as THREE from 'three';

const _v = new THREE.Vector3();

export function describe(animal) {
  const d = animal.data;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const P = d.pos;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const height = Math.max(0.02, y1 - Math.min(0, y0)), length = Math.max(0.02, z1 - z0), width = Math.max(0.02, x1 - x0);
  // the cheetah (the reference) is ~0.9 m tall at the head and ~2 m nose to tail tip; a 3 cm spider
  // is ~0.02 of that, a horse ~1.4x
  const scale = THREE.MathUtils.clamp(Math.max(height / 0.9, length / 2.0, width / 1.2), 0.008, 12);
  const J = d.joints;
  const bones = d.bones;
  const hasChild = new Set(bones.map((b) => b.parent).filter(Boolean));
  const boneLen = bones.map((b) => { const h = J[b.headJ], t = J[b.tailJ]; return h && t ? Math.hypot(t[0] - h[0], t[1] - h[1], t[2] - h[2]) : 0.05 * scale; });
  const plan = animal.species?.plan || 'quadruped';
  const swimmer = plan === 'swimmer';
  // feet: leaf bones whose tips touch the ground in the bind pose (relative threshold: works for a
  // spider's tarsi and a horse's hooves alike); swimmers have none
  const head = bones.findIndex((b) => /^head$/i.test(b.name));
  const legs = Array.isArray(animal.state?.legs) ? animal.state.legs.length : -1;
  const span = Math.max(length, width);
  // ...but only the ones at a leg: a legless body has none (a snake's tongue tip, fang and tail tip
  // all lie low in the bind pose), and with the engine's leg contacts (state.legs[].contact, world)
  // a candidate must lie near one of them (drops an eagle's folded primaries and tail feathers, a
  // rat's tail tip; keeps toes, hooves, paws, a spider's tarsi and palps)
  const feet = [];
  if (!swimmer && legs !== 0) {
    bones.forEach((b, i) => {
      const t = J[b.tailJ];
      if (!hasChild.has(b.name) && t && t[1] < height * 0.13 + 0.004 * scale) feet.push(i);
    });
    const L = legContactsLocal(animal);
    if (L.length && feet.length > L.length) {
      const R = Math.max(0.2 * height, 0.12 * span);
      const near = feet.filter((i) => { const t = J[bones[i].tailJ]; return L.some(([x, z]) => Math.hypot(t[0] - x, t[2] - z) <= R); });
      if (near.length >= L.length) feet.splice(0, feet.length, ...near);
    }
  }
  const chain = axialChain(animal);
  return {
    height, length, width, scale, feet, boneLen, head, plan, legs: legs >= 0 ? legs : feet.length,
    flyer: plan === 'bird', swimmer, legless: legs === 0 || (legs < 0 && !feet.length),
    // horizontal footprint (legs included): crowd spacing, grass push, contact shadows
    span,
    chain,
    // a legless land body (a snake) lies on the ground along its whole length: its contact shadow
    // follows the body axis (see bodyAxis)
    axis: legs === 0 && !swimmer ? axisProfile(animal, chain, head) : null,
    center: new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
  };
}

// the engine's leg contacts (state.legs[].contact, world) in the animal's bind frame (x, z)
function legContactsLocal(animal) {
  const legs = animal.state?.legs, p = animal.position, h = animal.heading;
  if (!Array.isArray(legs) || !p || !Number.isFinite(h)) return [];
  const c = Math.cos(h), s = Math.sin(h), out = [];
  for (const l of legs) {
    const q = l?.contact;
    if (!q || !Number.isFinite(q.x + q.z)) return [];
    const dx = q.x - p.x, dz = q.z - p.z;
    out.push([dx * c - dz * s, dx * s + dz * c]);
  }
  return out;
}

// The body axis of a legless body, head tip -> tail tip, as points on the skeleton ({ bone, tip }:
// the bone's origin, or its tail when tip), with the bind-pose half width `hw` and belly depth below
// the axis `under` of the body round each segment (vertices binned to their nearest segment).
function axisProfile(animal, chain, head) {
  const d = animal.data, bones = d.bones, J = d.joints;
  if (!chain || chain.length < 2) return null;
  const pts = [];
  if (head >= 0 && !chain.includes(head)) pts.push({ bone: head, tip: true }, { bone: head, tip: false });
  for (const i of chain) pts.push({ bone: i, tip: false });
  pts.push({ bone: chain[chain.length - 1], tip: true });
  const bindOf = (q) => J[q.tip ? bones[q.bone].tailJ : bones[q.bone].headJ];
  // drop repeated points (the head's origin is the first spine joint)
  const P = [];
  for (const q of pts) {
    const b = bindOf(q);
    if (!b) continue;
    const prev = P.length ? bindOf(P[P.length - 1]) : null;
    if (prev && Math.hypot(b[0] - prev[0], b[1] - prev[1], b[2] - prev[2]) < 1e-5) continue;
    P.push(q);
  }
  const n = P.length - 1;
  if (n < 1) return null;
  const A = P.map(bindOf);
  const hw = new Float32Array(n), under = new Float32Array(n);
  // (a sample of ~20k vertices is plenty for a width profile: ~10 ms for a hero-quality snake)
  const pos = d.pos, stride = 3 * Math.max(1, Math.floor(pos.length / 3 / 20000));
  for (let v = 0; v < pos.length; v += stride) {
    const x = pos[v], y = pos[v + 1], z = pos[v + 2];
    let best = Infinity, bk = 0, bx = 0, by = 0, bz = 0;
    for (let k = 0; k < n; k++) {
      const a = A[k], b = A[k + 1];
      const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
      const ll = ex * ex + ey * ey + ez * ez || 1e-12;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey + (z - a[2]) * ez) / ll));
      const px = a[0] + ex * t, py = a[1] + ey * t, pz = a[2] + ez * t;
      const dd = (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2;
      if (dd < best) { best = dd; bk = k; bx = px; by = py; bz = pz; }
    }
    hw[bk] = Math.max(hw[bk], Math.hypot(x - bx, z - bz));
    under[bk] = Math.max(under[bk], by - y);
  }
  // segments no vertex chose (very short ones) take their neighbour's size
  for (let k = 0; k < n; k++) if (!hw[k]) { hw[k] = hw[k - 1] || hw[k + 1] || 0.01; under[k] = under[k - 1] || under[k + 1] || 0; }
  return { pts: P, hw, under };
}

// World points of the body axis (Vector3s, reused) for an axis profile.
export function bodyAxis(animal, info, out = []) {
  const ax = info.axis, sk = animal.render?.skeleton;
  if (!ax || !sk) { out.length = 0; return out; }
  while (out.length < ax.pts.length) out.push(new THREE.Vector3());
  out.length = ax.pts.length;
  ax.pts.forEach((q, k) => {
    const m = sk.bones[q.bone].matrixWorld, p = out[k].setFromMatrixPosition(m);
    if (q.tip) p.addScaledVector(_v.setFromMatrixColumn(m, 1), info.boneLen[q.bone]);
  });
  return out;
}

// The axial chain (bone indices, head -> tail) for body-wave traces: the engine's own `motion.chain`
// when it exposes one, else the longest bone path of the skeleton (the spine of a fish or a snake).
export function axialChain(animal) {
  const bones = animal.data?.bones || [];
  const J = animal.data?.joints || {};
  const mc = animal.motion?.chain;
  if (Array.isArray(mc) && mc.length > 2 && mc.every((i) => Number.isInteger(i) && bones[i])) return mc.slice();
  if (!bones.length) return [];
  const idx = new Map(bones.map((b, i) => [b.name, i]));
  const kids = bones.map(() => []);
  bones.forEach((b, i) => { const p = idx.get(b.parent); if (p !== undefined) kids[p].push(i); });
  const len = (i) => { const h = J[bones[i].headJ], t = J[bones[i].tailJ]; return h && t ? Math.hypot(t[0] - h[0], t[1] - h[1], t[2] - h[2]) : 0; };
  // longest downward path from every bone (memoised), then the longest path through the tree
  const down = new Array(bones.length).fill(-1), next = new Array(bones.length).fill(-1);
  const walk = (i) => {
    if (down[i] >= 0) return down[i];
    let best = 0;
    for (const k of kids[i]) { const v = walk(k); if (v > best) { best = v; next[i] = k; } }
    return (down[i] = best + len(i));
  };
  bones.forEach((_, i) => walk(i));
  // the tree's diameter: the longest path through any bone and its two longest child branches
  let best = -1, at = 0, pair = [-1, -1];
  bones.forEach((_, i) => {
    const ks = kids[i].slice().sort((x, y) => down[y] - down[x]);
    const v = len(i) + (ks[0] >= 0 ? down[ks[0]] : 0) + (ks[1] >= 0 ? down[ks[1]] : 0);
    if (v > best) { best = v; at = i; pair = [ks[0] ?? -1, ks[1] ?? -1]; }
  });
  const run = (k) => { const out = []; for (let m = k; m >= 0; m = next[m]) out.push(m); return out; };
  const zOf = (i) => (J[bones[i].headJ] ? J[bones[i].headJ][2] : 0);
  const chain = run(pair[1]).reverse().concat([at], run(pair[0]));
  // head first (largest z)
  if (chain.length > 1 && zOf(chain[0]) < zOf(chain[chain.length - 1])) chain.reverse();
  return chain;
}

export const forward = (h, v = new THREE.Vector3()) => v.set(Math.sin(h), 0, Math.cos(h));
export const left = (h, v = new THREE.Vector3()) => v.set(Math.cos(h), 0, -Math.sin(h));

export function headPosition(animal, info, out = new THREE.Vector3()) {
  const hp = animal.motion?.headPose?.position;
  if (hp && Number.isFinite(hp.x)) return out.copy(hp);
  const sk = animal.render?.skeleton;
  if (sk && info.head >= 0) return out.setFromMatrixPosition(sk.bones[info.head].matrixWorld);
  return out.copy(animal.position).addScaledVector(forward(animal.heading, _v), info.length * 0.4).setY(animal.position.y + info.height * 0.8);
}

export function footPositions(animal, info, out = []) {
  const sk = animal.render?.skeleton;
  out.length = 0;
  if (!sk) return out;
  for (const i of info.feet) {
    const m = sk.bones[i].matrixWorld;
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    const y = new THREE.Vector3().setFromMatrixColumn(m, 1);
    p.addScaledVector(y, info.boneLen[i]);
    out.push(p);
  }
  return out;
}

// The animal's body centre (world) from the skeleton: the mean of the bone origins.
export function bodyCenter(animal, out = new THREE.Vector3()) {
  const sk = animal.render?.skeleton;
  if (!sk || !sk.bones.length) return out.copy(animal.position);
  out.set(0, 0, 0);
  for (const b of sk.bones) { out.x += b.matrixWorld.elements[12]; out.y += b.matrixWorld.elements[13]; out.z += b.matrixWorld.elements[14]; }
  return out.multiplyScalar(1 / sk.bones.length);
}
