#!/usr/bin/env node
// Headless motion, skinning and performance metrics for one species, judged against tools/thresholds.json.
//
//   node tools/metrics.mjs <species> [--seed N | --seeds 1-8 | --seeds 1,3,5] [--quality low] [--stretch-quality high]
//                           [--only gait,action:sit] [--no-perf] [--no-stretch] [--no-holes] [--thresholds file] [--out dir] [--json]
//
// --seeds runs one child process per seed (reports in <out>/seeds/<N>/) and prints, for every check,
// the worst value over the seeds and the seed it came from (report <out>/<species>-seeds.md / .json);
// it fails if any seed fails any check.
//
// Runs in Node (createAnimal with worker:false; three.js math only, no WebGL). Scenarios: every gait at
// steady state (flat, and the two slowest on bumpy ground), accelerate + hard stop, turns, idle, every
// action standing, attack / jump while running, death on uneven sloped ground, follow mode.
// Writes out/metrics/<species>.json and .md, prints PASS/FAIL per metric, exits 1 on any FAIL.
// Distances are normalised by the body scale S (mean leg-chain length) so species of any size share
// thresholds; angular rates are normalised by dynamic similarity (x sqrt(S / 0.8 m)).
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { parseArgs, loadThresholds, mkdirp, OUT, fmt, die } from './lib/common.mjs';
import { analyseBody, jointList, jointPositions, legStates, REF_LEG_LENGTH } from './lib/body.mjs';
import { makeGround, waterFor } from './lib/terrain.mjs';
import { gaitSpeeds, requiredActions } from './lib/gaits.mjs';
import { buildScenarios } from './lib/scenarios.mjs';
import { CpuSkin, snapshotPose } from './lib/skin.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['help', 'no-perf', 'no-stretch', 'no-holes', 'json', 'quiet'], alias: { h: 'help', s: 'seed', q: 'quality', o: 'out' } });
if (args.help || !args._[0]) {
  console.log('usage: node tools/metrics.mjs <species> [--seed N | --seeds a-b | --seeds a,b,c] [--quality low] [--stretch-quality high] [--only a,b] [--no-perf] [--no-stretch] [--no-holes] [--thresholds file] [--out dir]');
  process.exit(args.help ? 0 : 2);
}
const speciesId = args._[0];
if (args.seeds) await multiSeed(); // --seeds a-b | a,b,c: one run per seed, worst per check (never returns)
const seed = +(args.seed ?? 1);
const variant = args.variant; // species variant (e.g. snake --variant rattlesnake)
const reportId = speciesId + (variant ? '-' + variant : '');
const Q = args.quality || 'low';
const QS = args['stretch-quality'] || 'high';
// Motion is sampled at 60 Hz, or faster where a body plan's motion needs it (thresholds.json plans:
// a fish's tail beats at up to ~15 Hz, which a 60 Hz sampling cannot tell from jitter). Performance is
// always measured per 60 Hz frame.
const DT60 = 1 / 60;
let DT = DT60;
const TH = loadThresholds(args.thresholds);
// pops and jitter are judged on a second run of every scenario sampled at HZ: popHz (240 Hz) for an
// animal of the reference size popRefLength (the cheetah, S = 0.774 m), and at the dynamically similar
// rate popHz x sqrt(popRefLength / S) for any other size (a rabbit 436 Hz, a horse 168 Hz), so every
// size is sampled at the same number of samples per stride.
const PHZ = TH.motion.popHz ?? 240;
let HZ = +(args.hz ?? PHZ);
let DTH = 1 / HZ;
const outDir = mkdirp(path.resolve(args.out || path.join(OUT, 'metrics')));
const T0 = Date.now();
const say = (...a) => { if (!args.quiet) console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a); };

// deterministic runs: the engines may use Math.random for idle behaviour
{ let s = (seed * 2654435761) >>> 0 || 1; Math.random = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const lib = await import('../src/index.js');
const { createAnimal, buildAnimalData, loadSpecies, QUALITY } = lib;
const species = await loadSpecies(speciesId).catch((e) => die(e.message));

// ------------------------------------------------------------------ build + body
const data = await buildAnimalData(species, { seed, variant, quality: Q, worker: false });
const body = analyseBody(data);
const S = body.scale;
const joints = jointList(data);
const nJ = joints.length, nB = data.bones.length;
// Flapping wings (bird plan: bones of region 'wing' and the wings' feather bones) move with large amplitude at 4-10 Hz,
// only 6-15 samples per stroke at 60 Hz: the plain reversal test flags the smooth stroke itself. For
// those joints jitter is measured on the curvature residual r_i = a_i - (a_{i-1} + a_{i+1}) / 2 (a
// smooth stroke at f Hz keeps (1 - cos 2 pi f dt) of a_i, 11 % at 4 Hz; a zig-zag doubles and a
// one-frame pop scores 2x, so pops are caught more strictly than on the other joints).
const periodicJ = Uint8Array.from(joints, (j) => { const b = data.bones[j.bone]; return b.region === 'wing' || (b.region === 'feather' && /^wing/.test(b.group || '')) ? 1 : 0; });
const omegaNorm = Math.sqrt(S / (TH.refLegLength || REF_LEG_LENGTH));
if (args.hz === undefined && TH.motion.popRefLength) {
  const lim = TH.motion.popHzRange || [120, 960];
  HZ = Math.min(lim[1], Math.max(lim[0], Math.round(PHZ * Math.sqrt(TH.motion.popRefLength / S))));
  DTH = 1 / HZ;
}
const probe = await createAnimal(species, { seed, variant, quality: Q, worker: false });
const gaitInfo = gaitSpeeds(probe, body);
const actions = [...(probe.actions || [])];
const plan = species.plan;
probe.dispose();
const PLAN = (TH.plans && TH.plans[plan]) || {};
if (PLAN.sampleHz) DT = 1 / PLAN.sampleHz;
// the swimmer's axial chain (core/rig/swimmer.js names: spine0..N then caudal0..M) for the spine-kink check
const chainOrder = (n) => (n.startsWith('spine') ? 0 : 1000) + +n.replace(/\D/g, '');
const chain = plan === 'swimmer' ? data.bones.map((b, i) => [b.name, i]).filter(([n]) => /^(spine|caudal)\d+$/.test(n)).sort((a, b) => chainOrder(a[0]) - chainOrder(b[0])).map(([, i]) => i) : [];
say(`${speciesId} seed ${seed}: ${data.nV} vertices (${Q}), ${nB} bones, S = ${S.toFixed(3)} m (legs ${body.legs.map((l) => l.key).join(' ') || 'none'}); pops / jitter sampled at ${HZ} Hz`);
say(`gaits: ${gaitInfo.gaits.map((g) => `${g.name} ${g.speed.toFixed(2)} (${g.source})`).join(', ') || 'none'}; actions: ${actions.join(', ') || 'none'}`);

// vertex subset for penetration (visible surface, <= 3000 vertices)
const visible = [];
for (let v = 0; v < data.nV; v++) if (data.coat[v * 4 + 3] >= 0.5) visible.push(v);
const stride = Math.max(1, Math.ceil(visible.length / 3000));
const penVerts = Int32Array.from(visible.filter((_, i) => i % stride === 0));
const toeBindH = Object.fromEntries(body.legs.map((l) => [l.key, data.joints[l.toe][1]]));
const heelBindH = Object.fromEntries(body.legs.map((l) => [l.key, data.joints[data.bones[l.foot].headJ][1]]));

// ------------------------------------------------------------------ scenario runner + recorder
const poses = []; // pose snapshots for the stretch analysis
async function runScenario(sc, dt = DT, full = true) {
  const ground = makeGround(sc.terrain, S);
  const water = waterFor(plan, S);
  const a = await createAnimal(species, { seed, variant, quality: Q, worker: false, ground, water: water || undefined });
  a.motion.setLod?.(0);
  const env = { a, S, dt, time: 0, phaseTime: 0, actions: [], st: null };
  const sk = a.render.skeleton;
  const cpu = new CpuSkin(sk.bind);
  const vbuf = new Float32Array(penVerts.length * 3);
  const frames = { J: [], Q: [], legs: [], speed: [], gait: [], follow: [], contacts: [], trail: [], headTravel: [], gap: [] };
  const bc = bodyContacts(a);
  let nan = 0, penJ = { d: -Infinity }, penV = { d: -Infinity }, surfJ = { d: -Infinity }, surfV = { d: -Infinity }, kink = { d: 0 };
  const legBuf = [];
  const m4 = new THREE.Matrix4(), pp = new THREE.Vector3(), qq = new THREE.Quaternion(), ss = new THREE.Vector3();
  let recIdx = 0;
  const capture = () => {
    const J = jointPositions(sk, joints, body.boneLen, new Float64Array(nJ * 3));
    const Qs = new Float64Array(nB * 4);
    let bad = false;
    for (let i = 0; i < nB; i++) {
      const e = sk.bones[i].matrixWorld.elements;
      for (let k = 0; k < 16; k++) if (!Number.isFinite(e[k])) bad = true;
      m4.copy(sk.bones[i].matrixWorld).decompose(pp, qq, ss);
      Qs[i * 4] = qq.x; Qs[i * 4 + 1] = qq.y; Qs[i * 4 + 2] = qq.z; Qs[i * 4 + 3] = qq.w;
    }
    const sp = a.state.position;
    if (bad || !Number.isFinite(sp.x + sp.y + sp.z)) { nan++; return; }
    if (!full) { frames.J.push(J); frames.Q.push(Qs); frames.speed.push(a.state.speed); return; } // high-rate pass: pose + speed
    // out of the water: skin above the surface while swimming (leaps and surface gulps excepted)
    const wet = water && a.state.grounded !== false && !a.state.breaching;
    for (let j = 0; j < nJ; j++) {
      const d = ground(J[j * 3], J[j * 3 + 2]) - J[j * 3 + 1];
      if (d > penJ.d) penJ = { d, joint: joints[j].name, t: env.time };
      if (wet) { const u = J[j * 3 + 1] - water(J[j * 3], J[j * 3 + 2]); if (u > surfJ.d) surfJ = { d: u, joint: joints[j].name, t: env.time }; }
    }
    // spine kinks: a joint of the axial chain bending much more than its neighbours (second difference
    // of the unit bone directions ~ change of the bend angle from one joint to the next, radians)
    for (let c = 1; c < chain.length - 1; c++) {
      const e0 = sk.bones[chain[c - 1]].matrixWorld.elements, e1 = sk.bones[chain[c]].matrixWorld.elements, e2 = sk.bones[chain[c + 1]].matrixWorld.elements;
      const kx = e2[4] - 2 * e1[4] + e0[4], ky = e2[5] - 2 * e1[5] + e0[5], kz = e2[6] - 2 * e1[6] + e0[6];
      const k = Math.hypot(kx, ky, kz);
      if (k > kink.d) kink = { d: k, bone: data.bones[chain[c]].name, t: env.time };
    }
    if (recIdx % 6 === 0) {
      cpu.setPose(sk.bones.map((b) => b.matrixWorld));
      cpu.skin(data, vbuf, penVerts);
      if (bc) {
        // body-contact gap: every visible vertex of the contact bones (a sparse subset misses the
        // lowest point of a rolled section)
        bc.clear.fill(Infinity);
        cpu.skin(data, bc.buf, bc.verts);
        for (let k = 0; k < bc.verts.length; k++) {
          const b = data.skinIndex[bc.verts[k] * 4], c = bc.buf[k * 3 + 1] - ground(bc.buf[k * 3], bc.buf[k * 3 + 2]);
          if (c < bc.clear[b]) bc.clear[b] = c;
        }
      }
      for (let k = 0; k < penVerts.length; k++) {
        const d = ground(vbuf[k * 3], vbuf[k * 3 + 2]) - vbuf[k * 3 + 1];
        if (d > penV.d) penV = { d, vertex: penVerts[k], bone: data.bones[data.skinIndex[penVerts[k] * 4]].name, t: env.time };
        if (wet) { const u = vbuf[k * 3 + 1] - water(vbuf[k * 3], vbuf[k * 3 + 2]); if (u > surfV.d) surfV = { d: u, bone: data.bones[data.skinIndex[penVerts[k] * 4]].name, t: env.time }; }
      }
    }
    if (recIdx % 10 === 0 && sc.stretch !== false) poses.push(snapshotPose(sk));
    const L = legStates(a, body, legBuf);
    frames.legs.push(L.map((l, li) => {
      let stance = l.stance;
      if (stance === null) stance = l.toe.y - ground(l.toe.x, l.toe.z) < toeBindH[l.key] + 0.02 * S;
      // geometric contact: point on the foot bone (heel/mcp -> toe) nearest the ground, blended
      // continuously: the toe once the heel is lifted by > 1 % S, the middle while the foot is flat
      const e = sk.bones[body.legs[li].foot].matrixWorld.elements;
      const hm = e[13] - ground(e[12], e[14]), ht = l.toe.y - ground(l.toe.x, l.toe.z);
      const w = Math.min(1, Math.max(0, 0.5 + (hm - ht) / (0.02 * S)));
      const gx = e[12] + (l.toe.x - e[12]) * w, gz = e[14] + (l.toe.z - e[14]) * w;
      const lift = Math.min(hm - heelBindH[l.key], ht - toeBindH[l.key]); // height of the foot above its bind contact
      return { stance, lift, x: gx, z: gz, cx: l.contact ? l.contact.x : NaN, cz: l.contact ? l.contact.z : NaN, src: l.source };
    }));
    frames.J.push(J); frames.Q.push(Qs);
    frames.speed.push(a.state.speed); frames.gait.push(a.state.gait);
    if (env.followTarget) frames.follow.push(Math.hypot(sp.x - env.followTarget.x, sp.z - env.followTarget.z));
    if (bc) { frames.contacts.push(bc.flags()); frames.trail.push(bc.trail.length); frames.headTravel.push(bc.travel); frames.gap.push(recIdx % 6 === 0 ? bc.gaps() : null); }
    recIdx++;
  };
  const t0 = performance.now();
  for (const ph of sc.phases) {
    env.phaseTime = 0;
    ph.start?.(a, env);
    const n = Math.round(ph.t / dt);
    for (let i = 0; i < n; i++) {
      ph.each?.(a, env.phaseTime, env);
      a.update(dt);
      env.time += dt; env.phaseTime += dt;
      if (bc) bc.track(ground);
      if (ph.record) capture();
      if ((i & 31) === 31) await null;
      if (ph.until?.(env)) break;
    }
  }
  const ms = performance.now() - t0;
  a.dispose();
  return { sc, frames, nan, penJ, penV, surfJ, surfV, kink, water: !!water, env, ms, dt, bc, ground };
}

// ------------------------------------------------------------------ body contact (legless plans)
// Engines without feet (snake) report state.contacts = [{ key: joint name, contact }] for the body
// points that lie on the ground, head -> tail, and motion.chain (axial bone indices). Measured:
//  contactGap  height of a contact joint above its bind height over the terrain (floating; sinking is
//              the penetration check), all scenarios;
//  pathDev     horizontal distance of every contact joint from the path traced by the most anterior
//              contact point (path following: the body must stay on the head's path), locomotion;
//  bodySlip    sideways (perpendicular to the local body axis) motion of contact joints as a share of
//              the distance they moved, over 1 s windows (lateral undulation without slip is ~0; real
//              snakes slip ~10-17 % on smooth ground), locomotion;
//  kinkMax     curvature discontinuity along motion.chain: |k_i - (k_(i-1) + k_(i+1)) / 2| with k_i the
//              bend vector between consecutive bones (deg), all scenarios.
const LOCO_KINDS = new Set(['gait', 'turn', 'transition', 'follow']);
function bodyContacts(a) {
  const st = a.state.contacts;
  if (!Array.isArray(st) || !st.length || body.legs.length) return null;
  const jIdx = st.map((c) => joints.findIndex((j) => j.name === c.key));
  if (jIdx.some((i) => i < 0)) return null;
  const bindY = jIdx.map((j) => data.joints[joints[j].name][1]);
  // rest arc length of each contact joint from the first one
  const arc = [0];
  for (let k = 1; k < jIdx.length; k++) { const p = data.joints[joints[jIdx[k]].name], q = data.joints[joints[jIdx[k - 1]].name]; arc.push(arc[k - 1] + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])); }
  const buf = new Float64Array(joints.length * 3);
  // skin bones of each contact joint (the bone that starts at it): its lowest skin clears the ground
  const cBone = st.map((c) => data.bones.findIndex((b) => b.headJ === c.key));
  const o = { jIdx, bindY, arc, trail: [], travel: 0, last: null, clear: new Float64Array(data.bones.length).fill(Infinity) };
  // bind clearance of each bone's lowest skin (the sampled subset), subtracted from the posed one
  const bindClear = new Float64Array(data.bones.length).fill(Infinity);
  const isC = new Uint8Array(data.bones.length);
  for (const b of cBone) if (b >= 0) isC[b] = 1;
  const verts = visible.filter((v) => isC[data.skinIndex[v * 4]]);
  o.verts = Int32Array.from(verts);
  o.buf = new Float32Array(verts.length * 3);
  for (const v of verts) { const b = data.skinIndex[v * 4]; bindClear[b] = Math.min(bindClear[b], data.pos[v * 3 + 1]); }
  o.gaps = () => Float64Array.from(cBone, (b) => (b >= 0 ? o.clear[b] - bindClear[b] : NaN));
  o.flags = () => Uint8Array.from(a.state.contacts, (c) => (c.contact ? 1 : 0));
  o.track = () => {
    jointPositions(a.render.skeleton, joints, body.boneLen, buf);
    const k = a.state.contacts.findIndex((c) => c.contact);
    if (k < 0) return;
    const j = jIdx[k], x = buf[j * 3], z = buf[j * 3 + 2];
    const L = o.trail.length ? o.trail[o.trail.length - 1] : null;
    if (!L || Math.hypot(x - L[0], z - L[1]) > 0.001 * S) { if (L) o.travel += Math.hypot(x - L[0], z - L[1]); o.trail.push([x, z, arc[k]]); }
  };
  return o;
}
function bodyMetrics(r, frames, n) {
  const { bc, ground } = r, J = frames.J, loco = LOCO_KINDS.has(r.sc.kind);
  const nc = bc.jIdx.length;
  let gap = 0, gapAt = null, dev = 0, devAt = null, slip = 0, slipAt = null, kink = 0, kinkAt = null;
  // gap: the lowest skin (CPU skinned subset, every 6th frame) of each segment lying on the ground
  for (let f = 0; f < n; f++) {
    const C = frames.contacts[f], G = frames.gap[f];
    if (!G) continue;
    for (let k = 0; k < nc; k++) {
      if (!C[k] || !(G[k] < Infinity)) continue;
      if (G[k] > gap) { gap = G[k]; gapAt = { joint: joints[bc.jIdx[k]].name, t: +(f * DT).toFixed(2), mm: +(G[k] * 1000).toFixed(1) }; }
    }
  }
  if (loco) {
    // path deviation: contact joints the head path has already covered (travel since the start > arc)
    const T = bc.trail;
    for (let f = 0; f < n; f += 2) {
      const C = frames.contacts[f], tn = frames.trail[f], travel = frames.headTravel[f];
      const first = C.indexOf(1);
      if (first < 0 || tn < 3 || !(frames.speed[f] > 0.02 * S)) continue; // path following is judged while moving
      for (let k = first + 1; k < nc; k++) {
        if (!C[k] || bc.arc[k] - bc.arc[first] > travel - 0.01 * S) continue;
        const j = bc.jIdx[k], px = J[f][j * 3], pz = J[f][j * 3 + 2];
        let best = Infinity;
        for (let i = 1; i < tn; i++) {
          const ax = T[i - 1][0], az = T[i - 1][1], bx = T[i][0] - ax, bz = T[i][1] - az;
          const l2 = bx * bx + bz * bz || 1e-12;
          const t = Math.max(0, Math.min(1, ((px - ax) * bx + (pz - az) * bz) / l2));
          const d = Math.hypot(px - ax - bx * t, pz - az - bz * t);
          if (d < best) best = d;
        }
        if (best > dev) { dev = best; devAt = { joint: joints[j].name, t: +(f * DT).toFixed(2), mm: +(best * 1000).toFixed(1) }; }
      }
    }
    // lateral slip per 1 s window
    const W = Math.round(1 / DT);
    for (let k = 2; k < nc - 2; k++) {
      const j = bc.jIdx[k], jp = bc.jIdx[k - 1], jn = bc.jIdx[k + 1], jpp = bc.jIdx[k - 2], jnn = bc.jIdx[k + 2];
      const acc = [], mov = [];
      for (let f = 1; f < n; f++) {
        const on = frames.contacts[f][k] && frames.contacts[f - 1][k] && frames.speed[f] > 0.02 * S;
        // tangent at the middle of the step (the chord of a curved path is parallel to it), 5-point stencil
        const tan5 = (F, c) => 8 * (F[jp * 3 + c] - F[jn * 3 + c]) - (F[jpp * 3 + c] - F[jnn * 3 + c]);
        let tx = tan5(J[f], 0) + tan5(J[f - 1], 0), tz = tan5(J[f], 2) + tan5(J[f - 1], 2);
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const vx = J[f][j * 3] - J[f - 1][j * 3], vz = J[f][j * 3 + 2] - J[f - 1][j * 3 + 2];
        acc.push(on ? Math.abs(vx * tz - vz * tx) : 0);
        mov.push(on ? Math.hypot(vx, vz) : 0);
      }
      let sum = 0, dist = 0;
      for (let f = 0; f < acc.length; f++) {
        sum += acc[f]; dist += mov[f];
        if (f >= W) { sum -= acc[f - W]; dist -= mov[f - W]; }
        // sideways motion as a share of the distance moved (over >= 5 % S of travel)
        const pc = (100 * sum) / Math.max(dist, 0.05 * S);
        if (pc > slip) { slip = pc; slipAt = { joint: joints[j].name, t: +(f * DT).toFixed(2), mm: +(sum * 1000).toFixed(1), moved: +(dist * 1000).toFixed(0) }; }
      }
    }
  }
  // curvature continuity along the axial chain
  const chain = r.env.a?.motion?.chain;
  if (Array.isArray(chain) && chain.length > 3) {
    const nb = chain.length;
    const Y = new Float64Array(nb * 3), K = new Float64Array(nb * 3);
    for (let f = 0; f < n; f++) {
      const Qf = frames.Q[f];
      for (let i = 0; i < nb; i++) {
        const b = chain[i], qx = Qf[b * 4], qy = Qf[b * 4 + 1], qz = Qf[b * 4 + 2], qw = Qf[b * 4 + 3];
        // bone +Y axis from the quaternion
        Y[i * 3] = 2 * (qx * qy - qw * qz); Y[i * 3 + 1] = 1 - 2 * (qx * qx + qz * qz); Y[i * 3 + 2] = 2 * (qy * qz + qw * qx);
      }
      for (let i = 0; i < nb - 1; i++) {
        const a0 = i * 3, b0 = a0 + 3;
        K[a0] = Y[a0 + 1] * Y[b0 + 2] - Y[a0 + 2] * Y[b0 + 1]; K[a0 + 1] = Y[a0 + 2] * Y[b0] - Y[a0] * Y[b0 + 2]; K[a0 + 2] = Y[a0] * Y[b0 + 1] - Y[a0 + 1] * Y[b0];
      }
      for (let i = 1; i < nb - 2; i++) {
        const dx = K[i * 3] - 0.5 * (K[i * 3 - 3] + K[i * 3 + 3]), dy = K[i * 3 + 1] - 0.5 * (K[i * 3 - 2] + K[i * 3 + 4]), dz = K[i * 3 + 2] - 0.5 * (K[i * 3 - 1] + K[i * 3 + 5]);
        const kd = Math.asin(Math.min(1, Math.hypot(dx, dy, dz))) * 180 / Math.PI;
        if (kd > kink) { kink = kd; kinkAt = { bone: data.bones[chain[i]].name, t: +(f * DT).toFixed(2) }; }
      }
    }
  }
  const out = { contactGap: (100 * gap) / S, contactGapAt: gapAt, kinkMax: kink, kinkMaxAt: kinkAt };
  if (loco) Object.assign(out, { pathDev: (100 * dev) / S, pathDevAt: devAt, bodySlip: slip, bodySlipAt: slipAt });
  return out;
}

// jitter and pops of one recorded pose sequence sampled every dt seconds
//  jitter: frame-to-frame reversal of the 2nd difference a_i = p_{i+1} - 2 p_i + p_{i-1} of every joint;
//          jitter_i = max(0, -a_i . a_{i+1}) / max(|a_i|, |a_{i+1}|) (a zig-zag or a one-sample pop; a
//          single impact or a smooth oscillation does not reverse from one sample to the next)
//  pops:   angular velocity of every bone relative to its parent, and its change between samples
//  Both are divided by max(1, sqrt(Fr / popFroude)), Fr = v^2 / (g S) at that sample: above Fr ~ 4
//  (canter -> gallop) a stance lasts ~ S / v, so every limb rate grows with v / S ~ sqrt(Fr)
//  ("Speed normalisation of pops")
const FR0 = TH.motion.popFroude ?? 4;
function jitterPops(frames, dt) {
  const n = frames.J.length;
  const out = {};
  const kv = new Float64Array(n);
  for (let i = 0; i < n; i++) { const v = frames.speed[i] || 0; kv[i] = 1 / Math.max(1, Math.sqrt(v * v / (9.81 * S) / FR0)); }
  let jmax = 0, jarg = null;
  const jall = [];
  const acc0 = (i, j) => { const o = j * 3, A = frames.J[i - 1], B = frames.J[i], C = frames.J[i + 1]; return [C[o] - 2 * B[o] + A[o], C[o + 1] - 2 * B[o + 1] + A[o + 1], C[o + 2] - 2 * B[o + 2] + A[o + 2]]; };
  const accR = (i, j) => { const a = acc0(i, j), p = acc0(i - 1, j), q = acc0(i + 1, j); return [a[0] - 0.5 * (p[0] + q[0]), a[1] - 0.5 * (p[1] + q[1]), a[2] - 0.5 * (p[2] + q[2])]; };
  for (let j = 0; j < nJ; j++) {
    const per = periodicJ[j];
    const acc = per ? accR : acc0;
    const i0 = per ? 2 : 1, i1 = per ? n - 2 : n - 1;
    if (i1 - i0 < 2) continue;
    let prev = acc(i0, j);
    for (let i = i0 + 1; i < i1; i++) {
      const cur = acc(i, j);
      const dot = prev[0] * cur[0] + prev[1] * cur[1] + prev[2] * cur[2];
      const m = Math.max(Math.hypot(...prev), Math.hypot(...cur), 1e-12);
      const v = (Math.max(0, -dot) / m) * kv[i];
      jall.push(v);
      if (v > jmax) { jmax = v; jarg = { joint: joints[j].name, t: +(i * dt).toFixed(3) }; }
      prev = cur;
    }
  }
  jall.sort((x, y) => x - y);
  out.jitterMax = (100 * jmax) / S;
  out.jitterP99 = jall.length ? (100 * jall[Math.floor(jall.length * 0.99)]) / S : 0;
  out.jitterAt = jarg;
  let wmax = 0, amax = 0, warg = null, aarg = null;
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), dq = new THREE.Quaternion(), rel = new THREE.Quaternion(), prevRel = new THREE.Quaternion(), inv = new THREE.Quaternion();
  const w = [0, 0, 0], prevW = [0, 0, 0];
  for (let b = 0; b < nB; b++) {
    const p = body.parentIndex[b];
    if (p < 0) continue;
    for (let i = 0; i < n; i++) {
      const Qf = frames.Q[i];
      qa.set(Qf[p * 4], Qf[p * 4 + 1], Qf[p * 4 + 2], Qf[p * 4 + 3]).invert();
      qb.set(Qf[b * 4], Qf[b * 4 + 1], Qf[b * 4 + 2], Qf[b * 4 + 3]);
      rel.copy(qa).multiply(qb);
      if (i > 0) {
        dq.copy(rel).multiply(inv.copy(prevRel).invert());
        if (dq.w < 0) { dq.x = -dq.x; dq.y = -dq.y; dq.z = -dq.z; dq.w = -dq.w; }
        const sn = Math.hypot(dq.x, dq.y, dq.z);
        const ang = 2 * Math.atan2(sn, dq.w);
        const k = sn > 1e-12 ? ang / sn / dt : 0;
        w[0] = dq.x * k; w[1] = dq.y * k; w[2] = dq.z * k;
        const wm = (ang / dt) * omegaNorm * kv[i];
        if (wm > wmax) { wmax = wm; warg = { bone: data.bones[b].name, t: +(i * dt).toFixed(3) }; }
        if (i > 1) {
          const am = Math.hypot(w[0] - prevW[0], w[1] - prevW[1], w[2] - prevW[2]) * omegaNorm * kv[i];
          if (am > amax) { amax = am; aarg = { bone: data.bones[b].name, t: +(i * dt).toFixed(3) }; }
        }
        prevW[0] = w[0]; prevW[1] = w[1]; prevW[2] = w[2];
      }
      prevRel.copy(rel);
    }
  }
  out.popAngVel = wmax; out.popAngVelAt = warg;
  out.popAngAcc = amax; out.popAngAccAt = aarg;
  return out;
}

// ------------------------------------------------------------------ per-scenario metrics
function analyse(r, rHi) {
  const { frames } = r;
  const n = frames.J.length;
  const out = { name: r.sc.name, kind: r.sc.kind, frames: n, nanFrames: r.nan + (rHi ? rHi.nan : 0) };
  // pops / jitter: judged at the high sampling rate; the game-rate values are kept for information
  const lo = jitterPops(frames, r.dt);
  const hi = rHi ? jitterPops(rHi.frames, rHi.dt) : lo;
  Object.assign(out, hi);
  out.hz = Math.round(1 / (rHi || r).dt);
  out.at60 = { jitterMax: lo.jitterMax, jitterP99: lo.jitterP99, jitterAt: lo.jitterAt, popAngVel: lo.popAngVel, popAngVelAt: lo.popAngVelAt, popAngAcc: lo.popAngAcc, popAngAccAt: lo.popAngAccAt };
  // stance foot slide: horizontal drift of the foot's ground contact (geometric, see capture) from its
  // position just after touchdown; and the same for the engine's reported contact point (state.legs)
  const fastFr = TH.motion.slideFastFroude ?? 18;
  let slow = 0, fast = 0, slowArg = null, fastArg = null, sum = 0, cnt = 0, cslide = 0, cslideArg = null, lifted = 0;
  const liftTol = 0.015 * S;
  const src = frames.legs[0] ? frames.legs[0].map((l) => l.src) : [];
  for (let l = 0; l < body.legs.length; l++) {
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const on = i < n && frames.legs[i][l].stance;
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        const end = i - 1; // last stance frame
        // measured from the touchdown frame through the last stance frame (a paw the leg can no longer
        // reach is dragged there); every stance of >= 2 frames (a sprinting paw is down for 2-3 frames)
        if (end - start >= 1) {
          const a0 = frames.legs[start][l];
          let d = 0, dc = 0;
          for (let f = start + 1; f <= end; f++) {
            const c = frames.legs[f][l];
            // a planted foot may roll onto its toe (heel lift) but its lowest point stays on the ground:
            // rising off it (the leg cannot reach the plant) counts as slide, like horizontal drift
            const up = Math.max(0, c.lift - Math.max(0, a0.lift));
            if (c.lift > liftTol) lifted = Math.max(lifted, c.lift);
            d = Math.max(d, Math.hypot(c.x - a0.x, c.z - a0.z, up));
            if (Number.isFinite(c.cx) && Number.isFinite(a0.cx)) dc = Math.max(dc, Math.hypot(c.cx - a0.cx, c.cz - a0.cz));
          }
          let v = 0; for (let f = start; f <= end; f++) v += frames.speed[f]; v /= end - start + 1;
          const pct = (100 * d) / S, Fr = (v * v) / (9.81 * S);
          sum += pct; cnt++;
          const at = { leg: body.legs[l].key, t: +(start * DT).toFixed(3), frames: end - start + 1, speed: +v.toFixed(2) };
          if (Fr < fastFr) {
            if (pct > slow) { slow = pct; slowArg = at; }
            if ((100 * dc) / S > cslide) { cslide = (100 * dc) / S; cslideArg = at; }
          } else if (pct > fast) { fast = pct; fastArg = at; }
        }
        start = -1;
      }
    }
  }
  out.slideMax = slow; out.slideAt = slowArg; out.slideFastMax = fast; out.slideFastAt = fastArg;
  if (!body.legs.length) { out.slideMax = out.slideFastMax = undefined; } // legless: no stance checks
  out.slideMean = cnt ? sum / cnt : 0; out.stances = cnt; out.stanceSource = src[0] || 'none';
  out.contactSlideMax = body.legs.length ? cslide : undefined; out.contactSlideAt = cslideArg;
  if (r.water) {
    out.surfaceJoints = (100 * Math.max(0, r.surfJ.d)) / S; out.surfaceJointsAt = r.surfJ.joint ? { joint: r.surfJ.joint, mm: +(r.surfJ.d * 1000).toFixed(1), t: +r.surfJ.t.toFixed(2) } : null;
    out.surfaceVerts = (100 * Math.max(0, r.surfV.d)) / S; out.surfaceVertsAt = r.surfV.bone ? { bone: r.surfV.bone, mm: +(r.surfV.d * 1000).toFixed(1), t: +r.surfV.t.toFixed(2) } : null;
  }
  if (chain.length) { out.spineKink = r.kink.d; out.spineKinkAt = r.kink.bone ? { bone: r.kink.bone, t: +r.kink.t.toFixed(2) } : null; }
  out.stanceLift = (100 * lifted) / S; // informational: foot flagged stance but above the ground
  out.penJoints = (100 * Math.max(0, r.penJ.d)) / S; out.penJointsAt = r.penJ.joint ? { joint: r.penJ.joint, mm: +(r.penJ.d * 1000).toFixed(1), t: +r.penJ.t.toFixed(2) } : null;
  out.penVerts = (100 * Math.max(0, r.penV.d)) / S; out.penVertsAt = r.penV.bone ? { bone: r.penV.bone, vertex: r.penV.vertex, mm: +(r.penV.d * 1000).toFixed(1), t: +r.penV.t.toFixed(2) } : null;
  if (frames.follow.length) { const e = frames.follow.slice(30); out.followErr = (100 * Math.max(0, ...e)) / S; }
  const sp = frames.speed; out.speedMean = sp.length ? sp.reduce((x, y) => x + y, 0) / sp.length : 0;
  out.gaitsSeen = [...new Set(frames.gait.filter(Boolean))];
  out.actionErrors = r.env.actions.filter((s) => s.error).map((s) => `${s.name}: ${s.error}`);
  out.actionEnded = r.env.actions.map((s) => ({ name: s.name, done: s.done, duration: s.tEnd !== null ? +(s.tEnd - s.t0).toFixed(2) : null }));
  if (r.bc && frames.contacts.length) Object.assign(out, bodyMetrics(r, frames, n));
  out.simMsPerFrame = r.ms / Math.max(1, n);
  return out;
}

// ------------------------------------------------------------------ run scenarios
const scenarios = buildScenarios({ gaits: gaitInfo.gaits, actions, S, plan }, { only: args.only ? args.only.split(',') : null });
const results = [];
for (const sc of scenarios) {
  const r = await runScenario(sc);
  const rHi = HZ > 60 ? await runScenario(sc, DTH, false) : null;
  const m = analyse(r, rHi);
  results.push(m);
  say(`${sc.name.padEnd(18)} ${String(m.frames).padStart(4)} fr  jitter ${fmt(m.jitterMax, 3)}%  pop ${fmt(m.popAngVel, 1)} rad/s  slide ${fmt(m.slideMax)}%/${fmt(m.slideFastMax)}%  pen ${fmt(m.penJoints)}%/${fmt(m.penVerts)}%${m.followErr !== undefined ? '  follow ' + fmt(m.followErr, 1) + '%' : ''}${m.nanFrames ? '  NaN ' + m.nanFrames : ''}`);
}

// ------------------------------------------------------------------ pattern stretch (CPU DQS of the real mesh)
let stretch = null;
if (!args['no-stretch'] && poses.length) {
  const t0 = performance.now();
  const dS = await buildAnimalData(species, { seed, variant, quality: QS, worker: false });
  const same = JSON.stringify(dS.joints) === JSON.stringify(data.joints) && dS.bones.length === nB;
  if (!same) console.warn(`WARN: ${QS} joints differ from ${Q}; stretch uses poses anyway`);
  const MAXP = TH.stretch?.maxPoses ?? 240;
  const use = poses.length > MAXP ? Array.from({ length: MAXP }, (_, i) => poses[Math.floor((i * poses.length) / MAXP)]) : poses;
  const bind = (await import('../src/core/render/skeleton.js')).createSkeleton(dS).bind;
  const cpu = new CpuSkin(bind);
  const nV = dS.nV, idx = dS.index, nT = idx.length / 3;
  const P = new Float32Array(nV * 3);
  const maxS = new Float32Array(nT).fill(1), maxC = new Float32Array(nT).fill(1);
  const L0 = new Float32Array(nT * 3);
  const ok = new Uint8Array(nT);
  const nearEdge = new Uint8Array(nT);
  const edgeMm = (TH.stretch?.edgeMm ?? 3) / 1000;
  for (let t = 0; t < nT; t++) {
    let vis = true, edge = false;
    for (let e = 0; e < 3; e++) {
      const a = idx[t * 3 + e], b = idx[t * 3 + ((e + 1) % 3)];
      L0[t * 3 + e] = Math.hypot(dS.pos[a * 3] - dS.pos[b * 3], dS.pos[a * 3 + 1] - dS.pos[b * 3 + 1], dS.pos[a * 3 + 2] - dS.pos[b * 3 + 2]);
      if (dS.coat[a * 4 + 3] < 0.5) vis = false;
      if (Math.abs(dS.coat[a * 4]) < edgeMm) edge = true;
    }
    ok[t] = vis && Math.min(L0[t * 3], L0[t * 3 + 1], L0[t * 3 + 2]) > 1e-4 ? 1 : 0;
    nearEdge[t] = edge ? 1 : 0;
  }
  for (const pose of use) {
    cpu.setPose(pose);
    cpu.skin(dS, P);
    for (let t = 0; t < nT; t++) {
      if (!ok[t]) continue;
      for (let e = 0; e < 3; e++) {
        const a = idx[t * 3 + e], b = idx[t * 3 + ((e + 1) % 3)];
        const r = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]) / L0[t * 3 + e];
        if (r > maxS[t]) maxS[t] = r;
        const c = 1 / Math.max(r, 1e-3);
        if (c > maxC[t]) maxC[t] = c;
      }
    }
  }
  let nOk = 0, nEdge = 0;
  // judged: STRETCH (an edge longer than in the bind pose: spots and stripes grow and smear, fur
  // thins) overall and near pattern edges, and COMPRESSION separately (an edge shorter: the skin
  // folds in a flexion crease, inside of the elbow / stifle / groin, where it is out of view); the
  // combined 'distortion' (either) is reported for comparison with the earlier limits
  const c = { s15: 0, s2: 0, s3: 0, c15: 0, c2: 0, c3: 0, d15: 0, d2: 0, d3: 0, e15: 0, e2: 0, ed15: 0, ed2: 0 };
  const clusters = {}, cclusters = {};
  const clusterKey = (t) => { const v = idx[t * 3]; return [0, 1, 2, 3].filter((k) => dS.skinWeight[v * 4 + k] > 0.05).map((k) => dS.bones[dS.skinIndex[v * 4 + k]].name).sort().join('+'); };
  for (let t = 0; t < nT; t++) {
    if (!ok[t]) continue;
    nOk++;
    const d = Math.max(maxS[t], maxC[t]);
    if (maxS[t] > 1.5) c.s15++; if (maxS[t] > 2) c.s2++; if (maxS[t] > 3) c.s3++;
    if (maxC[t] > 1.5) c.c15++; if (maxC[t] > 2) c.c2++; if (maxC[t] > 3) c.c3++;
    if (d > 1.5) c.d15++; if (d > 2) c.d2++; if (d > 3) c.d3++;
    if (nearEdge[t]) { nEdge++; if (maxS[t] > 1.5) c.e15++; if (maxS[t] > 2) c.e2++; if (d > 1.5) c.ed15++; if (d > 2) c.ed2++; }
    if (maxS[t] > 2) { const key = clusterKey(t); clusters[key] = (clusters[key] || 0) + 1; }
    if (maxC[t] > 3) { const key = clusterKey(t); cclusters[key] = (cclusters[key] || 0) + 1; }
  }
  const pct = (x, n) => (n ? (100 * x) / n : 0);
  stretch = {
    quality: QS, triangles: nT, measured: nOk, nearPatternEdge: nEdge, poses: use.length, ms: Math.round(performance.now() - t0),
    stretch15: pct(c.s15, nOk), stretch2: pct(c.s2, nOk), stretch3: pct(c.s3, nOk),
    compress15: pct(c.c15, nOk), compress2: pct(c.c2, nOk), compress3: pct(c.c3, nOk),
    distort15: pct(c.d15, nOk), distort2: pct(c.d2, nOk), distort3: pct(c.d3, nOk),
    edge15: pct(c.e15, nEdge), edge2: pct(c.e2, nEdge), edgeDistort15: pct(c.ed15, nEdge), edgeDistort2: pct(c.ed2, nEdge),
    worstClusters: Object.entries(clusters).sort((a, b) => b[1] - a[1]).slice(0, 8),
    worstCompressClusters: Object.entries(cclusters).sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
  say(`stretch (${QS}, ${use.length} poses, ${stretch.ms} ms): stretched >1.5x ${fmt(stretch.stretch15, 3)}%  >2x ${fmt(stretch.stretch2, 3)}%  >3x ${fmt(stretch.stretch3, 3)}%  near pattern edges >1.5x ${fmt(stretch.edge15, 3)}%  >2x ${fmt(stretch.edge2, 3)}%  compressed <1/2 ${fmt(stretch.compress2, 3)}%  <1/3 ${fmt(stretch.compress3, 3)}%`);
}

// ------------------------------------------------------------------ performance
let perf = null;
if (!args['no-perf'] && !args.only) {
  const { buildSync } = await import('../src/core/build/pipeline.js');
  perf = { tiers: {}, node: process.version };
  // CPU time of this process (user + system), not wall-clock: the tools run on shared machines where
  // wall-clock time says more about the other jobs than about the library; the minimum over batches is the
  // intrinsic cost
  const cpuMs = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1000; };
  for (const q of Object.keys(QUALITY)) {
    const t0 = cpuMs();
    const d = buildSync(species, { seed, variant, quality: q });
    const buildMs = cpuMs() - t0;
    const a = await createAnimal(species, { seed, variant, quality: q, baked: undefined, worker: false });
    let calls = 0;
    a.object.traverse((o) => { if ((o.isMesh || o.isPoints || o.isLine) && o.visible) { let p = o, vis = true; while (p) { if (!p.visible) vis = false; p = p.parent; } if (vis) calls++; } });
    perf.tiers[q] = { buildMs: Math.round(buildMs), vertices: d.nV, triangles: d.index.length / 3, drawCalls: calls };
    a.dispose();
  }
  const timeUpdates = (list, frames) => { const t0 = cpuMs(); for (let f = 0; f < frames; f++) for (const a of list) a.update(DT60); return (cpuMs() - t0) / frames; };
  const run = gaitInfo.gaits.length ? gaitInfo.gaits[gaitInfo.gaits.length - 1].speed : 0;
  // LOD 0: hero tier, top gait, median of 5 batches of 200 updates
  {
    const a = await createAnimal(species, { seed, variant, quality: 'hero', worker: false, water: waterFor(plan, S) || undefined });
    a.motion.setLod?.(0);
    a.move({ speed: run });
    timeUpdates([a], 240);
    const b = []; for (let i = 0; i < 7; i++) b.push(timeUpdates([a], 300));
    b.sort((x, y) => x - y);
    perf.updateLod0Ms = b[0];
    perf.updateLod0MsMedian = b[3];
    a.dispose();
  }
  // crowd: 100 animals at the crowd tier (LOD 2 when the engine supports it), mixed speeds
  {
    const list = [];
    for (let i = 0; i < 100; i++) {
      const a = await createAnimal(species, { seed, variant, quality: 'crowd', worker: false, water: waterFor(plan, S) || undefined, position: new THREE.Vector3((i % 10) * 4 * S, 0, Math.floor(i / 10) * 6 * S) });
      a.motion.setLod?.(2);
      a.move({ speed: gaitInfo.gaits.length ? gaitInfo.gaits[i % gaitInfo.gaits.length].speed : 0, heading: (i * 0.37) % 6.28 });
      list.push(a);
    }
    timeUpdates(list, 60);
    const b = []; for (let i = 0; i < 5; i++) b.push(timeUpdates(list, 60));
    b.sort((x, y) => x - y);
    perf.crowd100Ms = b[0];
    perf.updateCrowdMs = b[0] / 100;
    perf.updateCrowdMsMedian = b[2] / 100;
    perf.crowdLod = typeof list[0].motion.setLod === 'function' ? 2 : 'n/a (no setLod)';
    for (const a of list) a.dispose();
  }
  say(`perf: ${Object.entries(perf.tiers).map(([q, t]) => `${q} ${t.vertices}v/${t.drawCalls}dc/${t.buildMs}ms`).join('  ')}  update LOD0 ${fmt(perf.updateLod0Ms, 3)} ms, crowd ${fmt(perf.updateCrowdMs, 3)} ms/animal (100: ${fmt(perf.crowd100Ms, 1)} ms)`);
}

// ------------------------------------------------------------------ exposed mesh holes (every tier)
// an open edge of a meshed region that is neither hidden by its cross-fade nor buried in another part:
// the viewer sees into the body there (tools/lib/holes.mjs)
let holes = null;
if (!args['no-holes'] && !args.only) {
  const { meshHoles, fmtHole, furWalls, fmtWall, fmtFold } = await import('./lib/holes.mjs');
  holes = { exposed: 0, tiers: {}, folded: { tris: 0, areaMm2: 0, worst: null } };
  for (const q of Object.keys(QUALITY)) {
    const h = meshHoles(species, { seed, variant, quality: q });
    holes.tiers[q] = { exposed: h.exposed, open: h.open, clusters: h.clusters.slice(0, 8), folded: { tris: h.folded.tris, areaMm2: h.folded.areaMm2, clusters: h.folded.clusters.slice(0, 4) } };
    holes.exposed += h.exposed;
    // (folded skin: a diagnostic, not a limit; the tier with the most back face on show)
    if (h.folded.areaMm2 > holes.folded.areaMm2) holes.folded = { tris: h.folded.tris, areaMm2: h.folded.areaMm2, worst: q, clusters: h.folded.clusters.slice(0, 3) };
    if (q === 'high') {
      // (a diagnostic, not a limit: see tools/lib/holes.mjs)
      holes.furWalls = furWalls(h.data, h.refPos);
      say(`fur walls (high, reference space, hair < 25 mm): ${holes.furWalls.wallEdges} edges of ${holes.furWalls.edges} (${holes.furWalls.wallPct} %), steepest ${holes.furWalls.maxSlope}; long-hair bevels steeper than 1: ${holes.furWalls.longWallEdges} edges${holes.furWalls.clusters.length ? '; biggest: ' + holes.furWalls.clusters.slice(0, 3).map(fmtWall).join('; ') : ''}`);
    }
  }
  {
    // (a diagnostic, not a limit: eyes buried under the head surface, see tools/lib/eyes.mjs)
    const { eyeDepth, fmtEyes } = await import('./lib/eyes.mjs');
    const { prepare } = await import('../src/core/build/pipeline.js');
    holes.eyes = eyeDepth(prepare(species, { seed, variant, quality: 'high' }), species);
    say(fmtEyes(holes.eyes));
  }
  const worst = Object.entries(holes.tiers).flatMap(([q, t]) => t.clusters.map((c) => ({ q, c }))).sort((a, b) => b.c.n - a.c.n);
  holes.where = worst.slice(0, 2).map(({ q, c }) => `${q}: ${fmtHole(c)}`).join('; ') || '-';
  say(`mesh holes: ${holes.exposed} exposed open edges over ${Object.keys(QUALITY).length} tiers${holes.exposed ? ' - ' + holes.where : ''}`);
  say(`folded skin (back faces a viewer sees, no open edge; diagnostic): ${holes.folded.worst ? `${holes.folded.areaMm2} mm2 in ${holes.folded.tris} triangles at ${holes.folded.worst}; biggest: ${holes.folded.clusters.map(fmtFold).join('; ')}` : 'none'}`);
}

// ------------------------------------------------------------------ judge
const checks = [];
const thr = (key, kind) => (TH.kinds && TH.kinds[kind] && TH.kinds[kind][key] !== undefined ? TH.kinds[kind][key] : TH.motion[key] !== undefined ? TH.motion[key] : PLAN[key]);
const MOTION = [
  ['nanFrames', 'frames with NaN', ''],
  ['jitterMax', 'joint jitter max (2nd-difference reversal)', '% S'],
  ['jitterP99', 'joint jitter p99', '% S'],
  ['popAngVel', 'bone angular velocity vs parent', 'rad/s*'],
  ['popAngAcc', 'bone angular velocity change per frame', 'rad/s*'],
  ['slideMax', 'stance foot slide (Froude < ' + (TH.motion.slideFastFroude ?? 18) + ')', '% S'],
  ['slideFastMax', 'stance foot slide (fast)', '% S'],
  ['contactSlideMax', 'engine contact point drift in stance (slow)', '% S'],
  ['penJoints', 'ground penetration, joints', '% S'],
  ['penVerts', 'ground penetration, skin vertices', '% S'],
  ['followErr', 'follow mode position error', '% S'],
  ['contactGap', 'body contact: gap to the ground (legless)', '% S'],
  ['pathDev', 'body contact: distance from the head path', '% S'],
  ['bodySlip', 'body contact: sideways slip / distance moved', '%'],
  ['kinkMax', 'spine curvature discontinuity', 'deg'],
  ['surfaceJoints', 'out of the water, joints (not leaping)', '% S'],
  ['surfaceVerts', 'out of the water, skin vertices (not leaping)', '% S'],
  ['spineKink', 'spine kink (bend change joint to joint)', 'rad'],
];
for (const [key, label, unit] of MOTION) {
  let worst = null, fail = false, any = false;
  for (const r of results) {
    if (r[key] === undefined) continue;
    const lim = thr(key, r.kind);
    if (lim === undefined || lim === null) continue;
    any = true;
    const bad = !(r[key] <= lim);
    if (bad) fail = true;
    if (!worst || (bad && !worst.bad) || (bad === worst.bad && r[key] / (lim || 1e-9) > worst.v / (worst.lim || 1e-9))) worst = { v: r[key], lim, scen: r.name, bad, at: r[key.replace(/Max$|P99$/, '') + 'At'] || r[key + 'At'] || null };
  }
  if (any) checks.push({ key, label, unit, value: worst.v, limit: worst.lim, pass: !fail, where: worst.scen, at: worst.at });
}
{
  const req = TH.requireActions === false ? [] : requiredActions(species);
  const missing = req.filter((x) => !actions.includes(x));
  checks.push({ key: 'actionsMissing', label: 'canonical actions available', unit: 'missing', value: missing.length, limit: 0, pass: missing.length === 0, where: missing.join(' ') || '-' });
  const errs = results.flatMap((r) => r.actionErrors.map((e) => `${r.name}: ${e}`));
  checks.push({ key: 'actionErrors', label: 'actions throw / reject', unit: '', value: errs.length, limit: 0, pass: errs.length === 0, where: errs.slice(0, 3).join('; ') || '-' });
  checks.push({ key: 'gaitsMissing', label: 'gaits with a known speed', unit: 'missing', value: gaitInfo.missing.length, limit: 0, pass: gaitInfo.missing.length === 0 && gaitInfo.gaits.length > 0, where: gaitInfo.missing.join(' ') || (gaitInfo.gaits.length ? '-' : 'no gaits') });
}
if (holes) {
  const lim = TH.mesh?.holesExposed ?? 0;
  checks.push({ key: 'meshHoles', label: 'exposed mesh holes (open edges, all tiers)', unit: 'edges', value: holes.exposed, limit: lim, pass: holes.exposed <= lim, where: holes.where });
}
if (stretch) {
  for (const [key, label] of [['stretch15', 'triangles stretched > 1.5x'], ['stretch2', 'triangles stretched > 2x'], ['stretch3', 'triangles stretched > 3x'], ['edge15', 'near pattern edges stretched > 1.5x'], ['edge2', 'near pattern edges stretched > 2x'], ['compress2', 'triangles compressed < 1/2 (folds)'], ['compress3', 'triangles compressed < 1/3 (folds)']]) {
    const lim = TH.stretch[key];
    if (lim === undefined) continue;
    const cl = key.startsWith('compress') ? stretch.worstCompressClusters : stretch.worstClusters;
    checks.push({ key: 'stretch.' + key, label, unit: '% tris', value: stretch[key], limit: lim, pass: stretch[key] <= lim, where: cl.slice(0, 2).map(([k, n]) => `${k}:${n}`).join(' ') });
  }
}
if (perf) {
  const B = TH.performance;
  for (const [q, t] of Object.entries(perf.tiers)) {
    const b = B.tiers[q];
    if (!b) continue;
    for (const k of ['vertices', 'triangles', 'drawCalls', 'buildMs']) if (b[k] !== undefined) checks.push({ key: `perf.${q}.${k}`, label: `${q}: ${k}`, unit: '', value: t[k], limit: b[k], pass: t[k] <= b[k], where: q });
  }
  checks.push({ key: 'perf.updateLod0Ms', label: 'CPU per update, LOD 0 (hero, top gait)', unit: 'ms', value: perf.updateLod0Ms, limit: B.updateLod0Ms, pass: perf.updateLod0Ms <= B.updateLod0Ms, where: 'node' });
  checks.push({ key: 'perf.updateCrowdMs', label: 'CPU per update, crowd (per animal, 100 animals)', unit: 'ms', value: perf.updateCrowdMs, limit: B.updateCrowdMs, pass: perf.updateCrowdMs <= B.updateCrowdMs, where: `lod ${perf.crowdLod}` });
}

// ------------------------------------------------------------------ report
const pass = checks.every((c) => c.pass);
const report = {
  species: speciesId, seed, quality: Q, date: new Date().toISOString(), pass, scale: S, legs: body.legs.map((l) => ({ key: l.key, length: l.length })),
  gaits: gaitInfo.gaits, actions, stanceSource: results[0]?.stanceSource, checks, scenarios: results, stretch, holes, perf, thresholds: path.relative(process.cwd(), args.thresholds || path.join('tools', 'thresholds.json')),
};
fs.writeFileSync(path.join(outDir, `${reportId}.json`), JSON.stringify(report, null, 1));
const md = [];
md.push(`# ${speciesId} metrics (seed ${seed}, ${Q}) - ${pass ? 'PASS' : 'FAIL'}`, '', `S (leg length) = ${S.toFixed(3)} m; stance from \`${report.stanceSource}\`; ${report.date}`, '');
md.push('| metric | value | limit | unit | result | worst |', '| --- | ---: | ---: | --- | --- | --- |');
for (const c of checks) md.push(`| ${c.label} | ${fmt(c.value, 3)} | ${fmt(c.limit, 3)} | ${c.unit} | ${c.pass ? 'PASS' : '**FAIL**'} | ${c.where || ''}${c.at ? ' ' + JSON.stringify(c.at).replace(/"/g, '') : ''} |`);
md.push('', '## Scenarios', '', '| scenario | frames | speed | jitter max / p99 % | pop rad/s / per frame | slide % (fast %) | stances | pen joints / verts % | follow % | NaN |', '| --- | ---: | ---: | --- | --- | --- | ---: | --- | ---: | ---: |');
for (const r of results) md.push(`| ${r.name} | ${r.frames} | ${fmt(r.speedMean)} | ${fmt(r.jitterMax, 3)} / ${fmt(r.jitterP99, 3)} | ${fmt(r.popAngVel, 1)} / ${fmt(r.popAngAcc, 1)} | ${fmt(r.slideMax)} (${fmt(r.slideFastMax)}) | ${r.stances} | ${fmt(r.penJoints)} / ${fmt(r.penVerts)} | ${r.followErr !== undefined ? fmt(r.followErr, 1) : '-'} | ${r.nanFrames} |`);
if (stretch) md.push('', '## Pattern stretch', '', `${stretch.quality} mesh, ${stretch.measured} visible triangles (${stretch.nearPatternEdge} near pattern edges), ${stretch.poses} poses from all scenarios.`, '', `stretch >1.5x ${fmt(stretch.stretch15, 3)}%, >2x ${fmt(stretch.stretch2, 3)}%, >3x ${fmt(stretch.stretch3, 3)}%; compress >1.5x ${fmt(stretch.compress15, 3)}%, >2x ${fmt(stretch.compress2, 3)}%, >3x ${fmt(stretch.compress3, 3)}%; either (distortion) >1.5x ${fmt(stretch.distort15, 3)}%, >2x ${fmt(stretch.distort2, 3)}%, >3x ${fmt(stretch.distort3, 3)}%. Stretched > 2x by skin bones: ${stretch.worstClusters.map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}. Compressed below 1/3: ${stretch.worstCompressClusters.map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
if (perf) {
  md.push('', '## Performance', '', '| tier | build ms (Node, 1 thread) | vertices | triangles | draw calls |', '| --- | ---: | ---: | ---: | ---: |');
  for (const [q, t] of Object.entries(perf.tiers)) md.push(`| ${q} | ${t.buildMs} | ${t.vertices} | ${t.triangles} | ${t.drawCalls} |`);
  md.push('', `CPU time per update (process CPU time, minimum over batches; median in brackets): LOD 0 ${fmt(perf.updateLod0Ms, 3)} ms (${fmt(perf.updateLod0MsMedian, 3)}); crowd ${fmt(perf.updateCrowdMs, 3)} ms per animal (${fmt(perf.updateCrowdMsMedian, 3)}; 100 animals ${fmt(perf.crowd100Ms, 1)} ms, LOD ${perf.crowdLod}). Build: CPU time of buildSync. Node ${perf.node}.`);
}
fs.writeFileSync(path.join(outDir, `${reportId}.md`), md.join('\n') + '\n');

console.log('');
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.label.padEnd(48)} ${fmt(c.value, 3).padStart(10)} ${c.pass ? '<=' : '> '} ${fmt(c.limit, 3).padEnd(8)} ${c.unit.padEnd(8)} ${c.where || ''}${!c.pass && c.at ? ' ' + JSON.stringify(c.at).replace(/"/g, '') : ''}`);
console.log(`\n${pass ? 'PASS' : 'FAIL'} ${speciesId}: ${checks.filter((c) => c.pass).length}/${checks.length} checks passed; report ${path.relative(process.cwd(), path.join(outDir, reportId + '.md'))}`);
process.exit(pass ? 0 : 1);

// ------------------------------------------------------------------ multi-seed robustness (--seeds)
async function multiSeed() {
  const { spawnSync } = await import('child_process');
  const { fileURLToPath } = await import('url');
  const spec = String(args.seeds);
  const seeds = [];
  for (const part of spec.split(',')) {
    const m = part.match(/^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/);
    if (!m) die(`--seeds: expected "a-b" or "a,b,c", got "${spec}"`);
    const a = +m[1], b = m[2] !== undefined ? +m[2] : a;
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) if (!seeds.includes(k)) seeds.push(k);
  }
  const variant = args.variant, reportId = speciesId + (variant ? '-' + variant : '');
  const outDir = mkdirp(path.resolve(args.out || path.join(OUT, 'metrics')));
  // the child gets every argument except --seeds / --seed / --out
  const argv = process.argv.slice(2), pass = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], key = a.replace(/^--?/, '').split('=')[0];
    if (a.startsWith('-') && ['seeds', 'seed', 's', 'out', 'o'].includes(key)) { if (!a.includes('=')) i++; continue; }
    pass.push(a);
  }
  const T0 = Date.now(), runs = [];
  for (const sd of seeds) {
    const dir = mkdirp(path.join(outDir, 'seeds', String(sd)));
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...pass, '--seed', String(sd), '--out', dir, '--quiet'], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const file = path.join(dir, reportId + '.json');
    if (!fs.existsSync(file) || r.status > 1) { console.log(`seed ${sd}: ERROR (exit ${r.status})\n${(r.stderr || '').slice(-2000)}`); runs.push({ seed: sd, error: true }); continue; }
    const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
    runs.push({ seed: sd, pass: rep.pass, checks: rep.checks, scale: rep.scale });
    const fails = rep.checks.filter((c) => !c.pass);
    console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(5)}s] seed ${sd}: ${rep.pass ? 'PASS' : 'FAIL'} (S = ${rep.scale.toFixed(3)} m)${fails.map((c) => `\n        FAIL ${c.label} ${fmt(c.value, 3)} > ${fmt(c.limit, 3)} ${c.where || ''}${c.at ? ' ' + JSON.stringify(c.at).replace(/"/g, '') : ''}`).join('')}`);
  }
  // worst value per check over the seeds (a failing seed before a passing one, then by value / limit)
  const worst = new Map();
  for (const r of runs) {
    if (r.error) continue;
    for (const c of r.checks) {
      const w = worst.get(c.key), rel = c.value / (c.limit || 1e-9);
      const failSeeds = [...(w?.failSeeds || []), ...(c.pass ? [] : [r.seed])];
      if (!w || (!c.pass && w.pass) || (c.pass === w.pass && rel > w.rel)) worst.set(c.key, { ...c, rel, seed: r.seed, failSeeds });
      else w.failSeeds = failSeeds;
    }
  }
  const checks = [...worst.values()];
  const errors = runs.filter((r) => r.error).map((r) => r.seed);
  const ok = !errors.length && checks.every((c) => c.pass);
  console.log('');
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.label.padEnd(48)} ${fmt(c.value, 3).padStart(10)} ${c.pass ? '<=' : '> '} ${fmt(c.limit, 3).padEnd(8)} ${c.unit.padEnd(8)} seed ${String(c.seed).padEnd(3)} ${c.where || ''}${!c.pass ? ` (failing seeds: ${c.failSeeds.join(',')})` : ''}${!c.pass && c.at ? ' ' + JSON.stringify(c.at).replace(/"/g, '') : ''}`);
  const md = [`# ${reportId} metrics over seeds ${seeds.join(', ')} - ${ok ? 'PASS' : 'FAIL'}`, '', `Worst value per check over the seeds (per-seed reports in \`seeds/<N>/\`).${errors.length ? ` Seeds that did not run: ${errors.join(', ')}.` : ''}`, '',
    '| metric | worst | limit | unit | result | seed | where | failing seeds |', '| --- | ---: | ---: | --- | --- | ---: | --- | --- |',
    ...checks.map((c) => `| ${c.label} | ${fmt(c.value, 3)} | ${fmt(c.limit, 3)} | ${c.unit} | ${c.pass ? 'PASS' : '**FAIL**'} | ${c.seed} | ${c.where || ''}${c.at ? ' ' + JSON.stringify(c.at).replace(/"/g, '') : ''} | ${c.failSeeds.join(', ')} |`),
    '', '| seed | S (m) | result | failing checks |', '| ---: | ---: | --- | --- |',
    ...runs.map((r) => (r.error ? `| ${r.seed} | - | ERROR | - |` : `| ${r.seed} | ${r.scale.toFixed(3)} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.checks.filter((c) => !c.pass).map((c) => c.key).join(', ')} |`))];
  fs.writeFileSync(path.join(outDir, `${reportId}-seeds.md`), md.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, `${reportId}-seeds.json`), JSON.stringify({ species: speciesId, variant, seeds, pass: ok, checks, runs: runs.map((r) => ({ seed: r.seed, pass: r.pass, error: !!r.error, failing: r.checks?.filter((c) => !c.pass).map((c) => c.key) })) }, null, 1));
  console.log(`\n${ok ? 'PASS' : 'FAIL'} ${reportId} over seeds ${seeds.join(',')}: ${checks.filter((c) => c.pass).length}/${checks.length} checks pass on every seed${errors.length ? `; seeds ${errors.join(',')} did not run` : ''}; report ${path.relative(process.cwd(), path.join(outDir, reportId + '-seeds.md'))}`);
  process.exit(ok ? 0 : 1);
}
