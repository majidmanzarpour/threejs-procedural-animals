// Cross-fade seams: how far two overlapping surfaces lie apart where they hand over.
//
// Regions overlap and cross-fade (a fine head over the coarse neck, eyelid patches over the face):
// the base of each surface is drawn where its fade >= 0.5, the two halves meeting at the midline of
// the band. The surfaces approximate the same SDF at different cell sizes, so at the midline they do
// not coincide: the coarse one bridges creases and cuts chords inside convex skin, by up to ~0.4 of
// its cell in a crease. Seen at a grazing angle the step between them is a thin slit into the body
// (a red line in the 'holes' debug view).
//
// The renderer closes it with a skirt (render/coatMaterial.js): past the midline, down to fade 0.1,
// the base sinks along its normal (quadratically, by up to `sink` metres) instead of stopping, so the
// surface that is handing over dives under the one taking over (which wins the depth test) and every
// ray through the step lands on skin. `measureSeams` sizes the sink from the real mismatch of this individual's
// surfaces (bind pose, reference space): rays along the normal of every band vertex against the
// other surfaces' band triangles. Shells and fins keep cross-fading on the true surfaces.

// groups: a region's main surface and its eyelid patches are separate surfaces
const groupOf = (regionOf, patchOf, v) => regionOf[v] * 2 + (patchOf && patchOf[v] ? 1 : 0);

/**
 * @param {object} m { pos, nrm, index, nV, fade, regionOf, patchOf, hOf: region index -> cell size (m) }
 * @returns {{ sink: number, max: number, p99: number, samples: number, hBand: number }} metres (reference space)
 */
export function measureSeams({ pos, nrm, index, nV, fade, regionOf, patchOf, hOf }) {
  const res = { sink: 0, max: 0, p99: 0, samples: 0, hBand: 0 };
  // band triangles (some vertex fades, some vertex shows) and the coarsest cell of a banded region
  const tri = [];
  let hBand = 0;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    if (a >= nV || b >= nV || c >= nV) continue;
    const fm = Math.min(fade[a], fade[b], fade[c]), fM = Math.max(fade[a], fade[b], fade[c]);
    if (fM <= 0.02 || fm >= 0.98) continue;
    tri.push(i);
    hBand = Math.max(hBand, hOf[regionOf[a]] || 0);
  }
  if (!tri.length || !(hBand > 0)) return res;
  res.hBand = hBand;
  const range = 0.75 * hBand; // search depth along the normal
  // hash grid of band triangles
  const G = Math.max(range, 0.004), grid = new Map();
  const key = (x, y, z) => (Math.floor(x / G) + 4096) * 67108864 + (Math.floor(y / G) + 4096) * 8192 + (Math.floor(z / G) + 4096);
  for (let t = 0; t < tri.length; t++) {
    const i = tri[t], a = index[i], b = index[i + 1], c = index[i + 2];
    const x0 = Math.floor(Math.min(pos[a * 3], pos[b * 3], pos[c * 3]) / G), x1 = Math.floor(Math.max(pos[a * 3], pos[b * 3], pos[c * 3]) / G);
    const y0 = Math.floor(Math.min(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1]) / G), y1 = Math.floor(Math.max(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1]) / G);
    const z0 = Math.floor(Math.min(pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2]) / G), z1 = Math.floor(Math.max(pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2]) / G);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = (x + 4096) * 67108864 + (y + 4096) * 8192 + (z + 4096);
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(t);
    }
  }
  const offs = [];
  const seen = new Set();
  for (let v = 0; v < nV; v++) {
    const f = fade[v];
    if (!(f > 0.3 && f < 0.7)) continue;
    const g = groupOf(regionOf, patchOf, v);
    const ox = pos[v * 3], oy = pos[v * 3 + 1], oz = pos[v * 3 + 2], nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
    seen.clear();
    let best = Infinity;
    for (let s = -1; s <= 1.001; s += 0.25) {
      const k = key(ox + nx * s * range, oy + ny * s * range, oz + nz * s * range);
      const l = grid.get(k);
      if (!l) continue;
      for (const t of l) {
        if (seen.has(t)) continue;
        seen.add(t);
        const i = tri[t], a = index[i], b = index[i + 1], c = index[i + 2];
        if (groupOf(regionOf, patchOf, a) === g) continue;
        // Moller-Trumbore, both directions along the normal
        const e1x = pos[b * 3] - pos[a * 3], e1y = pos[b * 3 + 1] - pos[a * 3 + 1], e1z = pos[b * 3 + 2] - pos[a * 3 + 2];
        const e2x = pos[c * 3] - pos[a * 3], e2y = pos[c * 3 + 1] - pos[a * 3 + 1], e2z = pos[c * 3 + 2] - pos[a * 3 + 2];
        const px = ny * e2z - nz * e2y, py = nz * e2x - nx * e2z, pz = nx * e2y - ny * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-14) continue;
        const tx = ox - pos[a * 3], ty = oy - pos[a * 3 + 1], tz = oz - pos[a * 3 + 2];
        const u = (tx * px + ty * py + tz * pz) / det;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const w = (nx * qx + ny * qy + nz * qz) / det;
        if (w < 0 || u + w > 1) continue;
        const d = (e2x * qx + e2y * qy + e2z * qz) / det;
        if (Math.abs(d) > range || Math.abs(d) >= Math.abs(best)) continue;
        // the surface taking over here: its fade complements this one (not the far side of a thin part)
        const fo = fade[a] * (1 - u - w) + fade[b] * u + fade[c] * w;
        if (Math.abs(f + fo - 1) > 0.3) continue;
        best = d;
      }
    }
    if (Number.isFinite(best)) offs.push(Math.abs(best));
  }
  res.samples = offs.length;
  if (!offs.length) { res.sink = 0.1 * hBand; return res; }
  offs.sort((x, y) => x - y);
  res.max = offs[offs.length - 1];
  res.p99 = offs[Math.min(offs.length - 1, Math.floor(0.99 * offs.length))];
  // cover the creases (99th percentile: a few hits land on another fold of the skin) with room for
  // skinning differences in motion; never deeper than 0.4 of the coarse cell
  res.sink = Math.min(0.4 * hBand, Math.max(0.1 * hBand, 1.5 * res.p99));
  return res;
}
