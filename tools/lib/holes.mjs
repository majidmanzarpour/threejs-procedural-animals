// Exposed holes in the SDF-meshed skin: open boundary edges (an edge used by one triangle) that a viewer
// can see. Every meshed region is a closed surface except where it is cut on purpose, and a cut is only
// excused when something really covers it:
//  - a cross-fade clip: the cut lies in the half of the band the fade hides (fade < 0.5) AND another
//    surface (another region, or the eyelid patch / main surface of the same region) shows there
//    (a vertex with fade >= 0.5 within two cells);
//  - a rigid part's rear ring (the jaw inside the head): the cut lies inside another part's solid AND
//    that part's mesh encloses it (a ray from the cut along each of the 6 axis directions crosses the
//    part's triangles an odd number of times; a covering part that was cut away there itself, e.g. a
//    bill tip cut by two region boxes, does not excuse it).
// Anything else is a hole: a region box that cuts the sculpt (a horn, the top of a neck, a bill tip), a
// clip on the visible side of its band. Through such a hole the viewer looks into the body (the base is
// drawn front faces only), which reads as a dent or a missing part.
// Folded skin (reported separately, a diagnostic): a sliver of flesh thinner than a cell (a lid shell cut
// by an aperture of the same radius, a pinched crease) can fold over without leaving an open edge, and a
// viewer then sees the back of the skin there (red in the 'holes' view). Candidates are drawn triangles
// with no flesh half a cell behind them (the part's SDF > 0 there); one counts when a ray from just behind
// it, into its back hemisphere, leaves the body without passing out through a drawn surface. Extra (non-SDF) surfaces such as
// feather cards are not part of the check; a cluster lying under them is marked (`underCards`: extra
// vertices within 1.5 cm), since the cards may hide it from most angles.
//
//   meshHoles(species, { seed, variant, quality }) -> { exposed, open, clusters: [{ region, n, extMm, atMm,
//     box, why, underCards, vertex }], folded: { tris, areaMm2, clusters: [{ region, n, areaMm2, atMm,
//     vertex, viewDir }] }, data, refPos }   (viewDir: where a viewer sees the fold's back face from)
//   (why: 'box' the region box cuts the sculpt, 'band' a band clip nothing covers, 'cover' inside a
//   part whose mesh does not enclose it, 'open' anything else; box: the box faces it touches)
//
// furWalls(data, refPos): where the fur length changes faster than the skin runs (the shells then stand up
// as a wall: a pad with a hard rim, a sunken ring round an eye). Per visible edge between two furred
// vertices, in reference space (hair length / size^0.35, edges of refPos): slope = |L1 - L2| / edge
// length; walls are edges steeper than 1.05 (45 degrees, with room for rounding) where the longer hair
// is >= 3 mm. A diagnostic, not a limit. The pipeline limits the slope (core/build/furSlope.js): hair up
// to 25 mm may rise 1 m per m of skin, longer hair proportionally faster (manes, ruffs and fleeces keep
// a ~2.5 cm bevel), so `wallEdges` counts walls of hair < 25 mm (faces: should be ~0 after the limit),
// `longWallEdges` the steeper bevels of long hair (on purpose) and `maxSlope` the steepest short-hair
// edge.
import { prepare, meshJob, finish } from '../../src/core/build/pipeline.js';
import { SDFModel } from '../../src/core/sdf/sdf.js';

export function meshHoles(species, opts) {
  const prep = prepare(species, opts);
  const jobs = prep.reg.jobs.map((_, i) => meshJob(species, opts, i, prep));
  const d = finish(species, opts, jobs, prep);
  const order = prep.reg.jobs.flat().map((r) => r.name);
  const regDef = Object.fromEntries(prep.reg.jobs.flat().map((r) => [r.name, r]));
  const parts = jobs.flat().sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name));
  const partNames = [...new Set(prep.model.prims.map((p) => p.part || 'body'))];
  const solids = Object.fromEntries(partNames.map((pn) => [pn, prep.model.forPart(pn)]));
  // every meshed vertex: region, surface group (region x patch), fade; a hash grid for coverage queries
  let nAll = 0;
  for (const p of parts) { p.v0 = nAll; nAll += p.count; }
  const refPos = concatPositions(parts);
  const vReg = new Int16Array(nAll), vGroup = new Int32Array(nAll), fade = new Float32Array(nAll);
  const hOf = parts.map((p) => regDef[p.name].h);
  parts.forEach((p, pi) => {
    for (let i = 0; i < p.count; i++) {
      const v = p.v0 + i;
      vReg[v] = pi; vGroup[v] = pi * 2 + (p.patch && p.patch[i] ? 1 : 0); fade[v] = d.coat[v * 4 + 3];
    }
  });
  const hMax = Math.max(...hOf), G = 2 * hMax;
  const vgrid = new Map(), gk = (x, y, z) => `${Math.floor(x / G)},${Math.floor(y / G)},${Math.floor(z / G)}`;
  for (let v = 0; v < nAll; v++) {
    if (fade[v] < 0.5) continue;
    const k = gk(refPos[v * 3], refPos[v * 3 + 1], refPos[v * 3 + 2]);
    let l = vgrid.get(k); if (!l) vgrid.set(k, (l = [])); l.push(v);
  }
  // a surface other than `group` that shows (fade >= 0.5) within two cells of (x, y, z)
  const coveredByOther = (x, y, z, group, h) => {
    const gx = Math.floor(x / G), gy = Math.floor(y / G), gz = Math.floor(z / G);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const w of vgrid.get(`${gx + dx},${gy + dy},${gz + dz}`) || []) {
        if (vGroup[w] === group) continue;
        const r = 2 * Math.max(h, hOf[vReg[w]]);
        const ex = refPos[w * 3] - x, ey = refPos[w * 3 + 1] - y, ez = refPos[w * 3 + 2] - z;
        if (ex * ex + ey * ey + ez * ez < r * r) return true;
      }
    }
    return false;
  };
  // visibility: rays against every triangle the renderer draws (final space, feather cards included)
  const vis = makeVisibility(d);
  let exposedTotal = 0, openTotal = 0;
  const clusters = [];
  const extraStart = nAll; // feather cards etc. follow the SDF surfaces in the finished data
  const size = d.params.size || 1; // (reference -> final space, for the ray offsets)
  for (const p of parts) {
    const R = regDef[p.name], myPart = R.part || 'body';
    const I = p.indices, P = p.positions, v0 = p.v0;
    const cnt = new Map();
    for (let i = 0; i < I.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const u = I[i + e], v = I[i + ((e + 1) % 3)];
        const k = u < v ? u * 4294967296 + v : v * 4294967296 + u;
        cnt.set(k, (cnt.get(k) || 0) + 1);
      }
    }
    const margin = R.h * 0.5;
    const pts = [];
    for (const [k, c] of cnt) {
      if (c !== 1) continue;
      openTotal++;
      const u = Math.floor(k / 4294967296), v = k % 4294967296;
      const x = (P[u * 3] + P[v * 3]) / 2, y = (P[u * 3 + 1] + P[v * 3 + 1]) / 2, z = (P[u * 3 + 2] + P[v * 3 + 2]) / 2;
      let why = 'open';
      if (fade[v0 + u] < 0.5 || fade[v0 + v] < 0.5) {
        // a cut in the hidden half of a cross-fade band: hidden where the surface taking over shows
        if (coveredByOther(x, y, z, vGroup[v0 + u], R.h)) continue;
        why = 'band';
      } else {
        // any other cut: can a line of sight from outside reach the opening? (rays from just under the
        // skin: a jaw's rear ring inside the head, a cut under another region's surface, are hidden)
        if (!vis.seen(v0 + u, v0 + v, 0.25 * R.h * size)) continue;
        let inside = Infinity;
        for (const pn of partNames) if (pn !== myPart) inside = Math.min(inside, SDFModel.evalList(solids[pn], x, y, z));
        if (inside < -margin) why = 'cover'; // inside another part's solid, whose mesh does not close over it
      }
      pts.push([x, y, z, v0 + u, why]);
    }
    exposedTotal += pts.length;
    if (pts.length) {
      // single-linkage clusters at 3 cells, via a voxel hash
      const L = 3 * R.h, key = (q) => `${Math.floor(q[0] / L)},${Math.floor(q[1] / L)},${Math.floor(q[2] / L)}`;
      const grid = new Map();
      pts.forEach((q, i) => { const kk = key(q); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(i); });
      const lab = new Int32Array(pts.length).fill(-1);
      let nc = 0;
      for (let i = 0; i < pts.length; i++) {
        if (lab[i] >= 0) continue;
        lab[i] = nc;
        const st = [i], members = [];
        while (st.length) {
          const a = st.pop(); members.push(a);
          const [gx, gy, gz] = key(pts[a]).split(',').map(Number);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            for (const j of grid.get(`${gx + dx},${gy + dy},${gz + dz}`) || []) {
              if (lab[j] >= 0) continue;
              if (Math.hypot(pts[a][0] - pts[j][0], pts[a][1] - pts[j][1], pts[a][2] - pts[j][2]) < L) { lab[j] = nc; st.push(j); }
            }
          }
        }
        const bb = [0, 1, 2].map((ax) => [Math.min(...members.map((m) => pts[m][ax])), Math.max(...members.map((m) => pts[m][ax]))]);
        const box = [];
        for (let ax = 0; ax < 3; ax++) {
          if (bb[ax][0] - R.bmin[ax] < 2.5 * R.h) box.push('xyz'[ax] + '-');
          if (R.bmax[ax] - bb[ax][1] < 2.5 * R.h) box.push('xyz'[ax] + '+');
        }
        const whys = new Map();
        for (const m of members) whys.set(pts[m][4], (whys.get(pts[m][4]) || 0) + 1);
        const why = box.length ? 'box' : [...whys.entries()].sort((a2, b2) => b2[1] - a2[1])[0][0];
        // feather cards (extra surfaces, final space) over the cluster
        const rv = pts[members[0]][3];
        let underCards = 0;
        const r2 = (0.015 * (d.params.size || 1)) ** 2;
        for (let w = extraStart; w < d.nV; w++) {
          const ex = d.pos[w * 3] - d.pos[rv * 3], ey = d.pos[w * 3 + 1] - d.pos[rv * 3 + 1], ez = d.pos[w * 3 + 2] - d.pos[rv * 3 + 2];
          if (ex * ex + ey * ey + ez * ez < r2) underCards++;
        }
        clusters.push({
          region: p.name, n: members.length,
          extMm: +(Math.max(...bb.map((b) => b[1] - b[0])) * 1000).toFixed(1),
          atMm: bb.map((b) => Math.round(((b[0] + b[1]) / 2) * 1000)), // reference space
          box: box.join(''), why, underCards,
          vertex: rv, // a vertex on the hole's rim (index into the finished data, for views)
        });
        nc++;
      }
    }
  }
  clusters.sort((a, b) => b.n - a.n);
  // ---- folded skin: drawn triangles with no flesh behind them whose back face a viewer sees
  const folded = { tris: 0, areaMm2: 0, clusters: [] };
  const fpts = [];
  for (const p of parts) {
    const h = regDef[p.name].h, I = p.indices, P = p.positions, v0 = p.v0;
    const lists = p.listIds.map((ids) => Array.from(ids, (q) => prep.model.prims[q]));
    for (let i = 0; i < I.length; i += 3) {
      const a = I[i], b = I[i + 1], c = I[i + 2];
      if (fade[v0 + a] < 0.5 || fade[v0 + b] < 0.5 || fade[v0 + c] < 0.5) continue;
      const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
      const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz); if (nl < 1e-14) continue;
      const k = (0.5 * h) / nl;
      const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3 - nx * k, cy = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3 - ny * k, cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3 - nz * k;
      if (SDFModel.evalList(lists[p.listIndex[a]], cx, cy, cz) <= 0) continue;
      if (!vis.backSeen(v0 + a, v0 + b, v0 + c)) continue;
      // (the side a viewer sees its back from: against its winding normal, in the finished data's space)
      const A = v0 + a, Bv = v0 + b, Cv = v0 + c, dp = d.pos;
      const ex = dp[Bv * 3] - dp[A * 3], ey = dp[Bv * 3 + 1] - dp[A * 3 + 1], ez = dp[Bv * 3 + 2] - dp[A * 3 + 2];
      const gx = dp[Cv * 3] - dp[A * 3], gy = dp[Cv * 3 + 1] - dp[A * 3 + 1], gz = dp[Cv * 3 + 2] - dp[A * 3 + 2];
      const wx = ey * gz - ez * gy, wy = ez * gx - ex * gz, wz = ex * gy - ey * gx, wl = Math.hypot(wx, wy, wz) || 1;
      fpts.push({ region: p.name, area: nl / 2, at: [cx, cy, cz], vertex: A, viewDir: [-wx / wl, -wy / wl, -wz / wl] });
    }
  }
  if (fpts.length) {
    const L = 0.01, vox = new Map(), kk = (q) => q.map((x) => Math.floor(x / L)).join(',');
    for (const f of fpts) { const k2 = kk(f.at); if (!vox.has(k2)) vox.set(k2, []); vox.get(k2).push(f); }
    const lab = new Set();
    for (const k0 of vox.keys()) {
      if (lab.has(k0)) continue;
      lab.add(k0);
      const st = [k0], mem = [];
      while (st.length) {
        const k1 = st.pop(); mem.push(...vox.get(k1));
        const [x, y, z] = k1.split(',').map(Number);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const nk = `${x + dx},${y + dy},${z + dz}`;
          if (vox.has(nk) && !lab.has(nk)) { lab.add(nk); st.push(nk); }
        }
      }
      folded.clusters.push({
        region: mem[0].region, n: mem.length, areaMm2: +(mem.reduce((s2, f) => s2 + f.area, 0) * 1e6).toFixed(1),
        atMm: [0, 1, 2].map((ax) => Math.round((mem.reduce((s2, f) => s2 + f.at[ax], 0) / mem.length) * 1000)), vertex: mem[0].vertex, viewDir: mem[0].viewDir,
      });
    }
    folded.clusters.sort((x, y) => y.areaMm2 - x.areaMm2);
    folded.tris = fpts.length;
    folded.areaMm2 = +(fpts.reduce((s2, f) => s2 + f.area, 0) * 1e6).toFixed(1);
  }
  return { exposed: exposedTotal, open: openTotal, clusters, folded, data: d, refPos };
}
// Lines of sight into an opening. Every triangle of the finished data (final space) that the renderer
// draws (the base keeps fade >= 0.5; feather cards always) goes into a sparse grid. From a point just
// under the open edge, rays in 26 directions: the opening is seen from outside when some ray leaves the
// body without passing out through a drawn surface (a surface it passes out through faces a viewer on
// that ray; one it enters through is a back face, culled).
function makeVisibility(d) {
  const P = d.pos, I = d.index, nT = I.length / 3, F = (v) => d.coat[v * 4 + 3];
  let el = 0;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < d.nV; v++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[v * 3 + k]); mx[k] = Math.max(mx[k], P[v * 3 + k]); }
  for (let t = 0; t < Math.min(nT, 5000); t++) { const a = I[t * 3], b = I[t * 3 + 1]; el += Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]); }
  const C = Math.max(6 * (el / Math.min(nT, 5000)), 1e-4);
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((mx[k] - mn[k]) / C) + 1));
  const cellKey = (i, j, k) => (i * dims[1] + j) * dims[2] + k;
  const grid = new Map();
  for (let t = 0; t < nT; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(P[a * 3 + k], P[b * 3 + k], P[c * 3 + k]) - mn[k]) / C));
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(P[a * 3 + k], P[b * 3 + k], P[c * 3 + k]) - mn[k]) / C));
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
      const key = cellKey(i, j, k);
      let l = grid.get(key); if (!l) grid.set(key, (l = [])); l.push(t);
    }
  }
  const dirs = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    if (!x && !y && !z) continue;
    const l = Math.hypot(x, y, z); dirs.push([x / l + 1.3e-4, y / l + 2.9e-4, z / l - 1.7e-4]);
  }
  const stamp = new Int32Array(nT);
  let ray = 0;
  // does a ray from o along r leave through a drawn surface before it leaves the box?
  // (skipA / skipB: an open edge, every triangle using one of its vertices is skipped; skipT: [a, b, c], only
  // that triangle is skipped)
  const blocked = (o, r, skipA, skipB, skipT = null) => {
    ray++;
    let i = Math.floor((o[0] - mn[0]) / C), j = Math.floor((o[1] - mn[1]) / C), k = Math.floor((o[2] - mn[2]) / C);
    const step = r.map((q) => (q > 0 ? 1 : -1));
    const next = [0, 1, 2].map((q) => { const cell = [i, j, k][q] + (r[q] > 0 ? 1 : 0); return (mn[q] + cell * C - o[q]) / r[q]; });
    const dt = r.map((q) => Math.abs(C / q));
    for (let guard = 0; guard < 4096; guard++) {
      if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) return false;
      const l = grid.get(cellKey(i, j, k));
      const tExit = Math.min(next[0], next[1], next[2]);
      if (l) for (const t of l) {
        if (stamp[t] === ray) continue;
        stamp[t] = ray;
        const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
        if (a === skipA || b === skipA || c === skipA || a === skipB || b === skipB || c === skipB) continue;
        if (skipT && (a === skipT[0] || a === skipT[1] || a === skipT[2]) && (b === skipT[0] || b === skipT[1] || b === skipT[2]) && (c === skipT[0] || c === skipT[1] || c === skipT[2])) continue;
        const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
        const e2x = P[c * 3] - P[a * 3], e2y = P[c * 3 + 1] - P[a * 3 + 1], e2z = P[c * 3 + 2] - P[a * 3 + 2];
        // the surface must face a viewer on the ray: the ray leaves through it (n . r > 0)
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        if (nx * r[0] + ny * r[1] + nz * r[2] <= 0) continue;
        const px = r[1] * e2z - r[2] * e2y, py = r[2] * e2x - r[0] * e2z, pz = r[0] * e2y - r[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-20) continue;
        const tx = o[0] - P[a * 3], ty = o[1] - P[a * 3 + 1], tz = o[2] - P[a * 3 + 2];
        const u = (tx * px + ty * py + tz * pz) / det;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const w = (r[0] * qx + r[1] * qy + r[2] * qz) / det;
        if (w < 0 || u + w > 1) continue;
        const s = (e2x * qx + e2y * qy + e2z * qz) / det;
        if (s <= 1e-6) continue;
        // drawn there? (the base discards its hidden half of a band)
        if (F(a) * (1 - u - w) + F(b) * u + F(c) * w < 0.5) continue;
        return true;
      }
      if (tExit === next[0]) { i += step[0]; next[0] += dt[0]; } else if (tExit === next[1]) { j += step[1]; next[1] += dt[1]; } else { k += step[2]; next[2] += dt[2]; }
    }
    return false;
  };
  return {
    // open edge (u, v) (finished-data indices): is its opening seen from outside? (depth: how far under
    // the skin the rays start, along the normal of the one triangle using the edge)
    seen(u, v, depth) {
      const ox = (P[u * 3] + P[v * 3]) / 2, oy = (P[u * 3 + 1] + P[v * 3 + 1]) / 2, oz = (P[u * 3 + 2] + P[v * 3 + 2]) / 2;
      const nx = d.nrm[u * 3] + d.nrm[v * 3], ny = d.nrm[u * 3 + 1] + d.nrm[v * 3 + 1], nz = d.nrm[u * 3 + 2] + d.nrm[v * 3 + 2];
      const nl = Math.hypot(nx, ny, nz) || 1;
      const o = [ox - (nx / nl) * depth, oy - (ny / nl) * depth, oz - (nz / nl) * depth];
      for (const r of dirs) if (!blocked(o, r, u, v)) return true;
      return false;
    },
    // triangle (a, b, c): is its back face seen from outside? (rays from just behind it into its back
    // hemisphere that leave the body without passing out through a drawn surface)
    backSeen(a, b, c) {
      const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
      const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz); if (nl < 1e-14) return false;
      nx /= nl; ny /= nl; nz /= nl;
      const o = [(P[a * 3] + P[b * 3] + P[c * 3]) / 3 - nx * 1e-5, (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3 - ny * 1e-5, (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3 - nz * 1e-5];
      const tri = [a, b, c];
      for (const r of dirs) if (r[0] * nx + r[1] * ny + r[2] * nz < -0.2 && !blocked(o, r, -1, -1, tri)) return true;
      return false;
    },
  };
}
function concatPositions(parts) {
  const n = parts.reduce((a, p) => a + p.count, 0), out = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) { out.set(p.positions, o * 3); o += p.count; }
  return out;
}

const HAIRY = new Set([0, 4, 8, 9]);
export function furWalls(d, refPos = null, { slope = 1.05, minLen = 0.003, free = 0.025 } = {}) {
  const pos = refPos || d.pos, I = d.index, nV = refPos ? refPos.length / 3 : d.nV;
  // hair length in the space of the edges (the pipeline scales furLen by size^0.35 after the coat)
  const lk = refPos ? 1 / Math.pow(d.params?.size || 1, 0.35) : 1;
  const seen = new Set(), walls = [];
  let edges = 0, longWalls = 0, maxSlope = 0;
  for (let i = 0; i < I.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const u = I[i + e], v = I[i + ((e + 1) % 3)];
      if (u >= nV || v >= nV) continue;
      const k = u < v ? u * 4294967296 + v : v * 4294967296 + u;
      if (seen.has(k)) continue;
      seen.add(k);
      if (d.coat[u * 4 + 3] < 0.5 || d.coat[v * 4 + 3] < 0.5) continue;
      if (!HAIRY.has(Math.round(d.tint[u * 4 + 3])) || !HAIRY.has(Math.round(d.tint[v * 4 + 3]))) continue;
      const Lu = d.coat[u * 4 + 2] * lk, Lv = d.coat[v * 4 + 2] * lk;
      if (Lu <= 0 || Lv <= 0) continue;
      edges++;
      const len = Math.hypot(pos[u * 3] - pos[v * 3], pos[u * 3 + 1] - pos[v * 3 + 1], pos[u * 3 + 2] - pos[v * 3 + 2]);
      if (len < 1e-5 || Math.max(Lu, Lv) < minLen) continue;
      const s = Math.abs(Lu - Lv) / len;
      if (Math.max(Lu, Lv) >= free) { if (s > slope) longWalls++; continue; }
      if (s > maxSlope) maxSlope = s;
      if (s > slope) walls.push({ s, len, at: [(pos[u * 3] + pos[v * 3]) / 2, (pos[u * 3 + 1] + pos[v * 3 + 1]) / 2, (pos[u * 3 + 2] + pos[v * 3 + 2]) / 2], L: Math.max(Lu, Lv) });
    }
  }
  // cluster the wall edges (voxels of 1 cm, merged by adjacency)
  const L = 0.01, key = (q) => q.map((x) => Math.floor(x / L)).join(',');
  const cells = new Map();
  for (const w of walls) { const kk = key(w.at); if (!cells.has(kk)) cells.set(kk, []); cells.get(kk).push(w); }
  const lab = new Map(), clusters = [];
  for (const start of cells.keys()) {
    if (lab.has(start)) continue;
    const st = [start], members = [];
    lab.set(start, clusters.length);
    while (st.length) {
      const c = st.pop(); members.push(...cells.get(c));
      const [x, y, z] = c.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const nk = `${x + dx},${y + dy},${z + dz}`;
        if (cells.has(nk) && !lab.has(nk)) { lab.set(nk, clusters.length); st.push(nk); }
      }
    }
    const lenMm = members.reduce((a, w) => a + w.len, 0) * 1000;
    const c = [0, 1, 2].map((a) => Math.round((members.reduce((acc, w) => acc + w.at[a], 0) / members.length) * 1000));
    clusters.push({ n: members.length, lenMm: Math.round(lenMm), atMm: c, maxSlope: +Math.max(...members.map((w) => w.s)).toFixed(1), maxLenMm: +(Math.max(...members.map((w) => w.L)) * 1000).toFixed(1) });
  }
  clusters.sort((a, b) => b.lenMm - a.lenMm);
  return { edges, wallEdges: walls.length, wallPct: edges ? +((100 * walls.length) / edges).toFixed(2) : 0, longWallEdges: longWalls, maxSlope: +maxSlope.toFixed(2), clusters: clusters.slice(0, 10) };
}
export const fmtWall = (c) => `${c.n} edges (${c.lenMm} mm of edges, slope up to ${c.maxSlope}, hair ${c.maxLenMm} mm) at [${c.atMm.join(',')}] mm`;

export const fmtFold = (c) => `${c.region} ${c.n} triangles ${c.areaMm2} mm2 at [${c.atMm.join(',')}] mm`;
export const fmtHole = (c) => `${c.region} ${c.n} edges ${c.extMm} mm at [${c.atMm.join(',')}] mm${c.box ? ' (region box ' + c.box + ')' : c.why === 'band' ? ' (band clip, nothing covers it)' : c.why === 'cover' ? ' (inside a part whose mesh is open there)' : ''}${c.underCards ? ' under feather cards' : ''}`;
