// Motion scenarios for the headless metrics and the smoke test. A scenario is a list of phases:
//   { t: seconds, record: bool, start?(a, env), each?(a, t, env), until?(env) -> bool }
// run in order at a fixed dt (env.dt) on a fresh animal. Only recorded phases are measured; they are
// contiguous. Phases must not assume a frame rate (tools/metrics.mjs runs every scenario at 60 Hz and
// again at a higher sampling rate for the pop / jitter checks).
import * as THREE from 'three';
import { POSTURES } from './gaits.mjs';

const DEG = Math.PI / 180;

export function playAction(a, env, name, opts = {}) {
  const st = { name, done: false, t0: env.time, tEnd: null, error: null };
  const o = { ...opts };
  const p = a.state.position, h = a.state.heading;
  if (name === 'attack' && !o.target) o.target = new THREE.Vector3(p.x + Math.sin(h) * 1.5 * env.S, p.y + 0.3 * env.S, p.z + Math.cos(h) * 1.5 * env.S);
  if (name === 'hit' && !o.direction) o.direction = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h));
  let r;
  try { r = a.play(name, o); } catch (e) { st.done = true; st.error = String(e && e.message || e); return st; }
  if (r && typeof r.then === 'function') r.then(() => { st.done = true; st.tEnd = env.time; }, (e) => { st.done = true; st.error = String(e && e.message || e); });
  else { st.done = true; st.tEnd = env.time; }
  env.actions.push(st);
  return st;
}

/**
 * @param info { gaits: [{name, speed}], actions: [...], S, plan }
 * @returns [{ name, kind, terrain, phases, speedClass? }]
 */
export function buildScenarios(info, { only = null } = {}) {
  const S = info.S;
  const G = info.gaits;
  const out = [];
  const add = (sc) => { if (!only || only.some((o) => sc.name === o || sc.kind === o || sc.name.startsWith(o))) out.push(sc); };
  const top = G.length ? G[G.length - 1] : { name: 'walk', speed: 1 };
  const fastNonTop = G.length > 1 ? G[G.length - 1] : top;
  const slow = G.length ? G[0] : { name: 'walk', speed: 1 };
  const mid = G.length ? G[Math.min(G.length - 1, Math.floor(G.length / 2))] : slow;

  // steady gaits
  for (const g of G) {
    add({ name: `gait:${g.name}`, kind: 'gait', terrain: 'flat', speed: g.speed, phases: [
      { t: 10, record: false, start: (a) => a.move({ speed: g.speed, gait: g.name }), until: (e) => e.phaseTime > 3 && Math.abs(e.a.state.speed - g.speed) < 0.03 * g.speed + 0.03 },
      { t: 1, record: false },
      { t: 3, record: true },
    ] });
  }
  // uneven ground at the two slowest gaits
  for (const g of G.slice(0, 2)) {
    add({ name: `bumpy:${g.name}`, kind: 'gait', terrain: 'bumpy', speed: g.speed, phases: [
      { t: 3, record: false, start: (a) => a.move({ speed: g.speed, gait: g.name }) },
      { t: 4, record: true },
    ] });
  }
  // accelerate from standstill to the top gait, then a hard stop
  add({ name: 'accel-stop', kind: 'transition', terrain: 'flat', phases: [
    { t: 1, record: false },
    { t: 6, record: true, start: (a) => a.move({ speed: top.speed }) },
    { t: 4, record: true, start: (a) => a.stop() },
  ] });
  // turns: 90 degree heading changes left then right, at the slowest and the fastest gait
  for (const g of [slow, fastNonTop].filter((x, i, arr) => arr.indexOf(x) === i)) {
    add({ name: `turn:${g.name}`, kind: 'turn', terrain: 'flat', speed: g.speed, phases: [
      { t: 4, record: false, start: (a) => a.move({ speed: g.speed, heading: 0 }) },
      { t: 3, record: true, start: (a) => a.move({ speed: g.speed, heading: 90 * DEG }) },
      { t: 3, record: true, start: (a) => a.move({ speed: g.speed, heading: -45 * DEG }) },
    ] });
  }
  // swimmers: climb to the surface and dive to the bed at cruising speed (clearance, no breach)
  if (info.plan === 'swimmer') {
    add({ name: `climb:${mid.name}`, kind: 'turn', terrain: 'bumpy', speed: mid.speed, phases: [
      { t: 2, record: false, start: (a) => a.move({ speed: mid.speed, heading: 0 }) },
      { t: 4, record: true, start: (a) => a.move({ speed: mid.speed, heading: 0.6, climb: 1 }) },
      { t: 5, record: true, start: (a) => a.move({ speed: mid.speed, heading: -0.4, climb: -1 }) },
      { t: 3, record: true, start: (a) => a.move({ speed: 0, climb: 0 }) },
    ] });
  }
  // idle (automatic)
  add({ name: 'idle', kind: 'action', terrain: 'flat', phases: [{ t: 1, record: false }, { t: 6, record: true }] });
  // actions standing
  const acts = info.actions.filter((x) => x !== 'idle' && x !== 'stand');
  const hasStand = info.actions.includes('stand');
  for (const name of acts) {
    const posture = POSTURES.includes(name);
    const phases = [
      { t: 1, record: false },
      { t: posture ? 4 : 6, record: true, start: (a, e) => { e.st = playAction(a, e, name); }, until: (e) => !posture && e.st.done && e.time > (e.st.tEnd ?? e.time) + 0.5 },
    ];
    if (posture && hasStand) phases.push({ t: 4, record: true, start: (a, e) => { e.st2 = playAction(a, e, 'stand'); } });
    add({ name: `action:${name}`, kind: name === 'death' ? 'death' : 'action', terrain: 'flat', phases });
  }
  // attack and jump while running
  for (const name of ['attack', 'jump'].filter((x) => acts.includes(x))) {
    add({ name: `run-${name}`, kind: 'action', terrain: 'flat', speed: mid.speed, phases: [
      { t: 3, record: false, start: (a) => a.move({ speed: mid.speed }) },
      { t: 4, record: true, start: (a, e) => { e.st = playAction(a, e, name); } },
    ] });
  }
  // death on uneven, sloped ground (walk a bit first so it falls mid-stride)
  if (acts.includes('death')) {
    add({ name: 'death-uneven', kind: 'death', terrain: 'slope', phases: [
      { t: 2, record: false, start: (a) => a.move({ speed: slow.speed }) },
      { t: 5, record: true, start: (a, e) => { a.stop(); e.st = playAction(a, e, 'death'); } },
      ...(hasStand ? [{ t: 4, record: true, start: (a, e) => { playAction(a, e, 'stand'); } }] : []),
    ] });
  }
  // death from a run (momentum: the body brakes and collapses; no revival while the run is still
  // requested), then stand up and run on
  // (birds: the middle ground gait; flight gaits get their own scenario below)
  const FLY = /^(fly|glide|soar)$/;
  const groundG = info.plan === 'bird' ? G.filter((g) => !FLY.test(g.name) && g.name !== 'sprint') : G;
  const midG = groundG.length ? groundG[Math.min(groundG.length - 1, Math.floor(groundG.length / 2))] : mid;
  if (acts.includes('death')) {
    // (stretch: false - a motion-robustness check; its poses are not added to the stretch analysis,
    // whose limits were set on the canonical scenarios: action:death and death-uneven already put the
    // collapsed and lying poses in, and the transient collapse poses of a run would only add the
    // mirrored side of the same poses)
    add({ name: 'run-death', kind: 'death', terrain: 'flat', speed: midG.speed, stretch: false, phases: [
      { t: 3, record: false, start: (a) => a.move({ speed: midG.speed, gait: midG.name }) },
      { t: 4, record: true, start: (a, e) => { e.st = playAction(a, e, 'death'); } },
      ...(hasStand ? [{ t: 4, record: true, start: (a, e) => { a.move({ speed: 0 }); playAction(a, e, 'stand'); } }] : []),
    ] });
  }
  // birds: killed in flight (falls limp, hits the ground and settles; no revival), then stand
  const flyG = info.plan === 'bird' ? G.find((g) => g.name === 'fly') : null;
  if (acts.includes('death') && flyG) {
    add({ name: 'fly-death', kind: 'death', terrain: 'flat', speed: flyG.speed, stretch: false, phases: [
      { t: 5, record: false, start: (a) => a.move({ speed: flyG.speed, climb: 1 }), until: (e) => e.phaseTime > 2.5 && (e.a.state.altitude ?? 0) > 1.5 * e.S },
      { t: 6, record: true, start: (a, e) => { a.move({ speed: flyG.speed, climb: 0 }); e.st = playAction(a, e, 'death'); } },
      ...(hasStand ? [{ t: 4, record: true, start: (a, e) => { a.move({ speed: 0 }); playAction(a, e, 'stand'); } }] : []),
    ] });
  }
  // follow mode: an external body on a circle with varying speed and a jerky (noisy) position
  add({ name: 'follow', kind: 'follow', terrain: 'flat', phases: [
    { t: 7, record: true, each: (a, t, e) => {
      const R = 6 * S;
      const v = mid.speed * (0.5 + 0.5 * Math.sin(t * 0.8));
      e.fAng = (e.fAng || 0) + (v / R) * (e.dt || 1 / 60);
      const jx = 0.004 * S * Math.sin(t * 97.0), jz = 0.004 * S * Math.cos(t * 83.0); // physics jitter
      const pos = new THREE.Vector3(R * Math.sin(e.fAng) + jx, 0, R - R * Math.cos(e.fAng) + jz);
      const vel = new THREE.Vector3(Math.cos(e.fAng) * v, 0, Math.sin(e.fAng) * v);
      a.follow(pos, vel);
      e.followTarget = pos;
    } },
  ] });
  return out;
}
