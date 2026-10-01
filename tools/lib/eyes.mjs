// Eye integrity (a diagnostic, not a limit): how each eye sits in the head it is sculpted into.
//
// sculptEyeSocket (core/sdf/eyeSocket.js) adds an orbit hollow, a lid shell of radius r + lid round the
// eyeball and an almond aperture carved from 0.16 r behind the eye centre out to zMax (2 r). Four things
// go wrong in practice:
//  - deep: the head's own primitives (brow, cheek, fat pads, a widened skull) stand well in front of the
//    eyeball. The lids are buried and the aperture becomes a tunnel through the flesh: the eye sits deep
//    in a dark hole, the coat paints lid rims and lashes on the tunnel walls, and where the tunnel barely
//    reaches the surface (the head surface near 2 r) its mouth closes into a ragged membrane (the pig's
//    "ragged dark hole with white fragments");
//  - rolled: the aperture frame's y (the upper lid: blinks, lashes, lid shading) does not point up, so
//    the almond stands on end (a tilt search that ran into its range limit: use apertureTiltAlong);
//  - buried: part of the eyeball inside the aperture lies inside the flesh (the lid shell or a
//    neighbouring primitive clips it);
//  - past the patch: the aperture rim at the skin reaches beyond the fine eyelid patch, so the coarse face
//    mesh draws part of the lid margin (a staircase edge, lashes in blocks).
//
//   eyeDepth(prep, species) -> { eyes: [{ side, r, skinAt, front, tunnelMin, buried, upDot, longElev,
//                                        rimMax, patchIn }], worst }
//   skinAt: where the head surface without the eye primitives crosses the eye axis (m from the centre)
//   front: skinAt - r (m): how far the eyeball's front lies under that surface (< 0: the eye bulges)
//   tunnelMin: smallest distance to material along the axis between r and 3 r (m): ~0 = nearly closed
//   buried: share of the eyeball front inside the aperture that is inside the flesh
//   upDot: the aperture's up axis (upper lid) . world up; longElev: slope of its long axis (rad)
//   rimMax: largest distance from the eye centre to the aperture rim where it meets the skin (m)
//   patchIn: radius (m) inside which the eyelid patch alone draws the skin (R - B; null: no patch)
// A healthy eye: skinAt <= ~1.3 r (the lid shell is the surface), tunnelMin well above a cell,
// upDot > 0.5, rimMax (+ the lid margin the coat paints) inside patchIn.
import { SDFModel } from '../../src/core/sdf/sdf.js';
import { eyeFrameOf } from '../../src/core/sdf/eyeSocket.js';

const EYE_TAGS = new Set(['eyesocket', 'orbit', 'eyelid']);

export function eyeDepth(prep, species) {
  const { params, rig, model, reg } = prep;
  const specs = species.eyeSpecs ? species.eyeSpecs(params, rig) : [];
  // eyelid patches of the regions (at this tier): nearest patch per eye
  const patches = (reg?.jobs || []).flat().flatMap((R) => R.patches || []);
  const out = [];
  for (const e of specs) {
    const E = e.spec;
    if (!E || !(E.r > 0) || !(E.R > 0)) continue;
    const fr = eyeFrameOf(E, e.headOrigin, e.side);
    const part = model.prims.find((p) => p.tag === 'eyesocket')?.part || 'body';
    const body = model.forPart(part);
    const noEye = body.filter((p) => !EYE_TAGS.has(p.tag));
    const off = E.off || 0;
    const at = (u, v, w) => [0, 1, 2].map((k) => fr.c[k] + fr.x[k] * u + fr.y[k] * v + fr.z[k] * w);
    const f = (L, p) => SDFModel.evalList(L, p[0], p[1], p[2]);
    let skinAt = null;
    for (let w = 0; w <= 4 * E.r; w += E.r * 0.01) if (f(noEye, at(0, off, w)) > 0) { skinAt = w; break; }
    let tunnelMin = Infinity;
    for (let w = E.r; w <= 3 * E.r; w += E.r * 0.02) tunnelMin = Math.min(tunnelMin, f(body, at(0, off, w)));
    let n = 0, buried = 0;
    const hw = Math.sqrt(Math.max(0, E.R * E.R - E.d * E.d)), hh = E.R - E.d;
    for (let j = -4; j <= 4; j++) for (let i = -8; i <= 8; i++) {
      const u = (i / 8) * hw, v = (j / 4) * hh;
      if (Math.max(Math.hypot(u, v + E.d) - E.R, Math.hypot(u, v - E.d) - E.R) > 0) continue;
      const rr = Math.hypot(u, v + off);
      if (rr >= E.r) continue;
      n++;
      if (f(body, at(u, v + off, Math.sqrt(E.r * E.r - rr * rr))) < -0.0002) buried++;
    }
    // the aperture rim where it meets the skin: around the almond outline (just outside the carve), the
    // first flesh met coming in along the axis from outside (what a viewer sees of the rim; an orbit
    // hollow inside the head does not count)
    let rimMax = 0;
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * 2 * Math.PI;
      // outline point in direction a: bisect the lens boundary along the ray from the aperture centre
      let lo = 0, hi = E.R * 2;
      for (let it = 0; it < 30; it++) {
        const m = (lo + hi) / 2, u = m * Math.cos(a), v = m * Math.sin(a);
        if (Math.max(Math.hypot(u, v + E.d) - E.R, Math.hypot(u, v - E.d) - E.R) > 0) hi = m; else lo = m;
      }
      const u = 1.04 * lo * Math.cos(a), v = 1.04 * lo * Math.sin(a) + off;
      // (from half a radius above the skin: further out, the line of a forward-looking eye meets the muzzle)
      const w0 = Math.max(skinAt ?? 0, E.r + (E.lid || 0)) + 0.5 * E.r;
      for (let w = w0; w >= -0.16 * E.r; w -= E.r * 0.02) {
        if (f(body, at(u, v, w)) < 0) { if (w < w0) rimMax = Math.max(rimMax, Math.hypot(u, v, w)); break; }
      }
    }
    let patchIn = null;
    for (const p of patches) {
      const dc = Math.hypot(p.c[0] - fr.c[0], p.c[1] - fr.c[1], p.c[2] - fr.c[2]);
      if (dc < E.r && (patchIn === null || p.R - p.B - dc < patchIn)) patchIn = p.R - p.B - dc;
    }
    out.push({
      side: e.side, r: E.r, skinAt, front: skinAt === null ? null : skinAt - E.r, tunnelMin, buried: n ? buried / n : 0,
      upDot: fr.y[1], longElev: Math.asin(Math.max(-1, Math.min(1, fr.x[1]))), rimMax, patchIn,
    });
  }
  // the worst eye: rolled first, then the deepest
  const score = (e) => (e.upDot < 0.5 ? 10 : 0) + (e.skinAt ?? 0) / e.r;
  let worst = null;
  for (const e of out) if (!worst || score(e) > score(worst)) worst = e;
  return { eyes: out, worst };
}

export function eyeProblems(e) {
  const p = [];
  if (e.upDot < 0.5) p.push('rolled');
  if (e.skinAt !== null && e.skinAt > 1.3 * e.r) p.push('deep');
  if (e.skinAt !== null && e.skinAt > 1.1 * e.r && e.tunnelMin < 0.001) p.push('closing');
  if (e.buried > 0.05) p.push('buried');
  if (e.patchIn !== null && e.rimMax > e.patchIn) p.push('past patch');
  return p;
}

export function fmtEyes(ed) {
  const w = ed.worst;
  if (!w) return 'eyes: none';
  const mm = (x) => (x * 1000).toFixed(1);
  const deg = (x) => ((x * 180) / Math.PI).toFixed(0);
  const prob = eyeProblems(w);
  const notes = [];
  if (prob.includes('rolled')) notes.push(`ROLLED: the upper lid axis points ${w.upDot.toFixed(2)} up, the almond's long axis ${deg(Math.abs(w.longElev))} deg from horizontal (set the tilt with apertureTiltAlong)`);
  if (prob.includes('deep')) notes.push('DEEP: the lids are buried and the aperture is a tunnel (move the eye out or carve the orbit; skinAt <= 1.3 r)');
  if (prob.includes('closing')) notes.push('the aperture tunnel nearly closes at its mouth (ragged opening)');
  if (prob.includes('past patch')) notes.push(`the aperture rim (${mm(w.rimMax)} mm from the eye centre) reaches past the eyelid patch (${mm(w.patchIn)} mm): the coarse face mesh draws part of the lid margin`);
  return `eyes: eyeball front ${w.front === null ? '?' : w.front > 0 ? mm(w.front) + ' mm under' : mm(-w.front) + ' mm proud of'} the head surface (surface at ${w.skinAt === null ? '?' : (w.skinAt / w.r).toFixed(2)} r on the axis, r ${mm(w.r)} mm)` +
    `, aperture tunnel min ${mm(w.tunnelMin)} mm, rim ${mm(w.rimMax)} mm${w.patchIn !== null ? ` (patch ${mm(w.patchIn)} mm)` : ''}` +
    `${w.buried > 0.05 ? `, ${Math.round(w.buried * 100)} % of the visible eyeball inside the flesh` : ''}` +
    (notes.length ? ' - ' + notes.join('; ') : '');
}
