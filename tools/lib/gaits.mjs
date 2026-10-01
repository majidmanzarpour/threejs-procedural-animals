// Representative steady-state speed for every gait an animal offers, and the canonical action list.
// Sources, in order of preference:
//   1. species.motion.gears     { name: speed } or [{ name, v|speed }]   (named gear speeds for UIs)
//   2. species.motion.gaits     [{ name, v, ... }]  (gait table: v = entry speed of a row). A gait's
//      speed is the middle of its speed band, at most 1.6x its entry speed (walk 0..2.4 -> 1.2).
//   3. defaults by gait name, scaled by dynamic similarity sqrt(leg length / cheetah leg length).
// Gaits listed by animal.gaits but not found anywhere are skipped (reported as such).
import { REF_LEG_LENGTH } from './body.mjs';

const DEFAULTS = { walk: 1.2, amble: 2.0, pace: 3.0, trot: 3.2, tolt: 3.5, canter: 5.6, lope: 5.6, bound: 6, halfbound: 5, gallop: 13, sprint: 24, hop: 2.5, run: 4, swim: 1.5, fly: 10, glide: 12 };

export function gaitSpeeds(animal, body) {
  const m = (animal.species && animal.species.motion) || {};
  const names = (animal.gaits && animal.gaits.length ? animal.gaits : null);
  const out = [];
  const push = (name, speed, source) => { if (Number.isFinite(speed) && speed > 0 && !out.some((g) => g.name === name)) out.push({ name, speed, source }); };
  // 1a. a species variant may carry its own gears (species.motion.variants[params.variant].gears)
  const vg = m.variants && animal.params && m.variants[animal.params.variant] && m.variants[animal.params.variant].gears;
  // 0. the engine's named speeds for THIS individual (animal.gears): already scaled by size (dynamic
  //    similarity), so a piglet or a kit is tested at its own trot, not the adult's
  if (animal.gears && typeof animal.gears === 'object' && Object.keys(animal.gears).length) {
    for (const [n, v] of Object.entries(animal.gears)) if (!names || names.includes(n) || n === 'sprint') push(n, +v, 'animal.gears');
  }
  const gears = out.length ? null : (vg || m.gears);
  if (gears) {
    const list = Array.isArray(gears) ? gears.map((g) => [g.name, g.v ?? g.speed]) : Object.entries(gears);
    for (const [n, v] of list) if (!names || names.includes(n) || n === 'sprint') push(n, +v, vg ? 'motion.variants.gears' : 'motion.gears');
  }
  // 1b. the engine's named speeds for this individual (animal.gears, m/s): engines whose species data
  //     is not in m/s (the swimmer's speeds are in body lengths per second) publish them here
  if (!out.length && animal.gears && typeof animal.gears === 'object') {
    for (const [n, v] of Object.entries(animal.gears)) if (!names || names.includes(n)) push(n, +v, 'animal.gears');
  }
  if (!out.length && Array.isArray(m.gaits) && m.gaits.length && m.gaits[0].name !== undefined && m.gaits[0].v !== undefined) {
    const T = m.gaits;
    const uniq = [...new Set(T.map((g) => g.name))];
    for (const n of uniq) {
      const rows = T.map((g, i) => [g, i]).filter(([g]) => g.name === n);
      const lo = rows[0][0].v;
      const last = rows[rows.length - 1][1];
      const hi = T[last + 1] ? T[last + 1].v : (m.maxSpeed ?? rows[rows.length - 1][0].v * 1.1);
      let v = (lo + hi) / 2;
      if (lo > 0) v = Math.min(v, lo * 1.6);
      push(n, v, 'motion.gaits');
    }
  }
  if (!out.length) {
    const k = Math.sqrt(Math.max(body.legLength || REF_LEG_LENGTH, 0.01) / REF_LEG_LENGTH);
    for (const n of names || ['walk', 'trot']) if (DEFAULTS[n]) push(n, DEFAULTS[n] * k, 'defaults');
  }
  const sizeK = Math.sqrt((animal.params && animal.params.size) || 1);
  const vmax0 = vg ? m.variants[animal.params.variant].maxSpeed : m.maxSpeed;
  const vmax = vmax0 ? vmax0 * sizeK : vmax0;
  if (vmax && out.length && vmax > out[out.length - 1].speed * 1.25 && !out.some((g) => g.name === 'sprint')) push('sprint', vmax * 0.93, 'motion.maxSpeed');
  out.sort((a, b) => a.speed - b.speed);
  const missing = (names || []).filter((n) => !out.some((g) => g.name === n));
  return { gaits: out, missing };
}

export const CANONICAL_ACTIONS = {
  common: ['idle', 'jump', 'sit', 'lie', 'sleep', 'eat', 'drink', 'attack', 'hit', 'death', 'stand'],
  bird: ['takeoff', 'land', 'perch', 'glide', 'flap'],
  swimmer: ['burst'],
  snake: ['coil', 'strike'],
};
// Postures hold until 'stand' (or movement); one-shots end by themselves.
export const POSTURES = ['sit', 'lie', 'sleep', 'death', 'perch', 'coil'];

export function requiredActions(species) {
  return [...CANONICAL_ACTIONS.common, ...(CANONICAL_ACTIONS[species.plan] || [])];
}
