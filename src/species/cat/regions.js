// Meshing plan: body at 2 mm, head at 1 mm (overlapping across the upper neck and cross-faded),
// eyelid patches at 0.4 mm, and the lower jaw as its own surface so the mouth can open. (The cheetah's
// plan scaled to a cat: 0.7 % of the withers height for the body, the head at half that.)
import { catJoints, HEAD_O } from './rig.js';
import { eyeOf } from './sculpt.js';
import { eyeFrameOf } from '../../core/sdf/eyeSocket.js';
import { lerp, norm, sub, smoothstep } from '../../core/math/vec.js';

// the neck cut is fixed in reference space (joints of the reference individual)
const J0 = catJoints();
export const NECK_CUT = (() => {
  const d = norm(sub(J0.occiput, J0.neckMid));
  const c = lerp(J0.neckMid, J0.occiput, 0.8); // (close to the skull: the fine head mesh stays off the bending neck)
  return { c, d, band: 0.004 };
})();
export const neckS = (x, y, z) => (x - NECK_CUT.c[0]) * NECK_CUT.d[0] + (y - NECK_CUT.c[1]) * NECK_CUT.d[1] + (z - NECK_CUT.c[2]) * NECK_CUT.d[2];

export const eyeCentres = (params) => [1, -1].map((s) => eyeFrameOf(eyeOf(params), HEAD_O, s).c);
const PATCH = { R: 0.0165, B: 0.0025, h: 0.0004 }; // (inner radius 14 mm: the aperture rim at the skin lies at ~12.3 mm)
function eyePatchWeight(centres, x, y, z) {
  let dmin = 1e9;
  for (const c of centres) dmin = Math.min(dmin, Math.hypot(x - c[0], y - c[1], z - c[2]));
  return 1 - smoothstep(PATCH.R - PATCH.B, PATCH.R + PATCH.B, dmin);
}

export const CELL = { body: 0.00205, head: 0.00102 };

export function catRegions(rig, params, Q) {
  const B = NECK_CUT.band, r = Q.res;
  const centres = eyeCentres(params);
  // Without fur shells (crowd tier) the coarse body surface and the head surface do not coincide in
  // the overlap band: each stays visible past the cut by D (the depth test picks the outer one)
  // (the low tier's coarse body cells, 6 mm, leave the same gap at the sides of the neck: both surfaces are
  // drawn across an overlap there as well)
  // (a kitten's big head (x1.28, warped after meshing) spreads the two surfaces further apart in the band: more overlap;
  // so does a longhair's sculpted ruff round the neck: single open edges at the side of the neck at the low tier)
  const D = Q.shells > 0 && r < 2.5 ? 0 : (Q.shells > 0 ? 0.6 : 0.85) * CELL.body * r * (params.juv || params.longhair ? 1.6 : 1);
  // (medium too: Safari on a Mac and phones show medium, and its 2 mm face cells drew the lid margin in steps;
  // the two patches at 1 mm cost ~4.5k vertices of the tier's 32k)
  // (the head and body surfaces reach 3 body cells further across the cut, hidden by the fade, below the hero tier and on
  // kittens: the skin weights are smoothed over each mesh, one-sidedly near a region's edge, so the two surfaces' weights in
  // the band differed by 0.1-0.2 (the coarser the cells, the more; on a kitten, whose head / neck blend is shorter, rig.js,
  // also at hero) and they parted by up to 4.6 mm at the side of the neck when the head turned: red specks at the jowl's
  // outline in the 'holes' view at medium; seed 13: 4.6 -> 1.8 mm medium, 2.9 -> 1.5 high; vertices high <= 76.9k, medium
  // <= 30.2k over seeds 1-40. Hero, without: <= 1.6 mm, within its 130k)
  const M = (params.juv || r > 1.1 ? 3 : 0) * CELL.body * r;
  const patches = Q.eyePatches || (Q.shells > 0 && r <= 2) ? centres.map((c) => ({ c, R: PATCH.R, B: PATCH.B, h: PATCH.h * Math.max(1, r) * (Q.eyePatches ? 1 : 1.25) })) : [];
  const zTail = rig.J['tail' + (Object.keys(rig.J).filter((k) => /^tail\d+$/.test(k)).length - 1)][2];
  return {
    jobs: [
      [{ name: 'body', part: 'body', bmin: [-0.085, -0.012, Math.min(-0.5, zTail - 0.03)], bmax: [0.085, 0.3, 0.2], h: CELL.body * r, F: 4, clip: (x, y, z) => neckS(x, y, z) < B + D + M }],
      [
        { name: 'head', part: 'body', bmin: [-0.065, 0.17, 0.12], bmax: [0.065, 0.325, 0.262], h: CELL.head * r, F: 6, clip: (x, y, z) => neckS(x, y, z) > -B - D - M, patches },
        // (the box takes the whole mandible: its rounded rear ends reach z 0.168, and a cut there showed as an open edge
        // under a big head)
        { name: 'jaw', part: 'jaw', bmin: [-0.03, 0.195, 0.162], bmax: [0.03, 0.228, 0.25], h: CELL.head * r, F: 6, rigidBone: 'jaw' },
      ],
    ],
    fade(x, y, z, name, patch) {
      const sN = neckS(x, y, z);
      if (name === 'body') return 1 - smoothstep(-B, B, sN - D);
      if (name === 'head') {
        let f = smoothstep(-B, B, sN + D);
        if (patches.length) { const ew = eyePatchWeight(centres, x, y, z); f *= patch ? ew : 1 - ew; }
        return f;
      }
      return 1;
    },
  };
}

// The head and the body surfaces overlap across the neck cut, and the core smooths each surface's skin weights over its
// own mesh (3 neighbour passes: ~1.5 mm on the 1 mm head cells, ~3 mm on the 2 mm body cells), so where the weights curve
// (the occiput blend, the lips group behind the jowl) the two surfaces at one place took head / neck2 shares 0.05-0.07
// apart. Posed, they part where the head bends far against the neck (2.8 mm, hero 3.5, on the side of the cheek of the
// dead blue tom, seed 12; standing 0.2), and at the hand-over the fur rooted on the surface that lies under the other's
// skin loses its roots: a crisp edge across the cheek, the head's fur dark and velvety on one side, the neck's coarse and
// pale on the other, an unsmoothed seam between the parts. Here the body surface near the cut takes the head surface's
// weights at the same place (the closest point on the finer head mesh, barycentric), in full across the cross-fade band
// and fading back to its own over the next 8 mm on the body side.
export function harmonizeSeamWeights({ pos, index, regionOf, regionNames, weights, nV }) {
  const { skinIndex, skinWeight } = weights;
  const bodyR = regionNames.indexOf('body'), headR = regionNames.indexOf('head');
  if (bodyR < 0 || headR < 0) return 0;
  const B = NECK_CUT.band, R = B + 0.008, C = 0.004;
  const sOf = (v) => neckS(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
  // head triangles near the cut, in a hash grid by centroid
  const grid = new Map(), key = (i, j, k) => `${i},${j},${k}`;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    if (a >= nV || regionOf[a] !== headR || regionOf[b] !== headR || regionOf[c] !== headR) continue;
    if (Math.abs(sOf(a)) > R + 0.006) continue;
    const g = [0, 1, 2].map((k) => Math.floor((pos[a * 3 + k] + pos[b * 3 + k] + pos[c * 3 + k]) / 3 / C));
    const kk = key(...g); let l = grid.get(kk); if (!l) grid.set(kk, (l = [])); l.push(t);
  }
  const W0 = Float32Array.from(skinWeight), I0 = Uint16Array.from(skinIndex);
  const P3 = (v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
  let changed = 0;
  for (let v = 0; v < nV; v++) {
    if (regionOf[v] !== bodyR) continue;
    const s = sOf(v);
    if (s < -R || s > R) continue;
    const kMix = s > -B ? 1 : smoothstep(-R, -B, s);
    if (kMix <= 0) continue;
    const p = P3(v), g = p.map((x) => Math.floor(x / C));
    let best = null, bd = 0.004;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const l = grid.get(key(g[0] + a, g[1] + b, g[2] + c)); if (!l) continue;
      for (const t of l) {
        const q = closestOnTri(p, P3(index[t]), P3(index[t + 1]), P3(index[t + 2]));
        if (q.d < bd) { bd = q.d; best = [t, q.u, q.v, q.w]; }
      }
    }
    if (!best) continue;
    const acc = new Map();
    const add = (u, f) => { for (let k = 0; k < 4; k++) { const w = W0[u * 4 + k]; if (w > 0) acc.set(I0[u * 4 + k], (acc.get(I0[u * 4 + k]) || 0) + w * f); } };
    add(v, 1 - kMix);
    add(index[best[0]], kMix * best[1]); add(index[best[0] + 1], kMix * best[2]); add(index[best[0] + 2], kMix * best[3]);
    const top = [...acc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
    let sum = 0; for (const [, w] of top) sum += w;
    for (let k = 0; k < 4; k++) {
      if (k < top.length) { skinIndex[v * 4 + k] = top[k][0]; skinWeight[v * 4 + k] = top[k][1] / sum; } else { skinIndex[v * 4 + k] = 0; skinWeight[v * 4 + k] = 0; }
    }
    changed++;
  }
  return changed;
}

// closest point on triangle abc to p: distance and barycentric weights (Ericson, Real-Time Collision Detection 5.1.5)
function closestOnTri(p, a, b, c) {
  const sub3 = (x, y) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]], dot3 = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ab = sub3(b, a), ac = sub3(c, a), ap = sub3(p, a);
  const d1 = dot3(ab, ap), d2 = dot3(ac, ap);
  let u, v, w;
  if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; } else {
    const bp = sub3(p, b), d3 = dot3(ab, bp), d4 = dot3(ac, bp);
    const cp = sub3(p, c), d5 = dot3(ab, cp), d6 = dot3(ac, cp);
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; }
    else if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); u = 1 - t; v = t; w = 0; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); u = 1 - t; v = 0; w = t; }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / (d4 - d3 + (d5 - d6)); u = 0; v = 1 - t; w = t; }
    else { const den = 1 / (va + vb + vc); v = vb * den; w = vc * den; u = 1 - v - w; }
  }
  const q = [0, 1, 2].map((k) => a[k] * u + b[k] * v + c[k] * w);
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), u, v, w };
}

