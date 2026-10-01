#!/usr/bin/env node
// Smoke test for every registered species (npm test):
//   build at low quality (Node, no workers), 2 s of every gait and every action, no NaN in bone matrices
//   or state, and a bake round trip (identical arrays, loads with createAnimal({ baked }), animates).
//
//   node tools/test.mjs [species ...] [--quality low]
import { createAnimal, buildAnimalData, listSpecies, loadSpecies, writeBake } from '../src/index.js';
import { verifyBake } from './bake.mjs';
import { analyseBody } from './lib/body.mjs';
import { gaitSpeeds } from './lib/gaits.mjs';
import { waterFor } from './lib/terrain.mjs';

const argv = process.argv.slice(2);
const qi = argv.indexOf('--quality');
const quality = qi >= 0 ? argv[qi + 1] : 'low';
const only = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--quality');
const ids = only.length ? only : listSpecies();
const DT = 1 / 60;
let failures = 0;
const t00 = Date.now();

function finiteAnimal(a) {
  const s = a.state;
  if (!Number.isFinite(s.position.x + s.position.y + s.position.z + s.heading + s.speed)) return 'state';
  for (const b of a.render.skeleton.bones) for (const e of b.matrixWorld.elements) if (!Number.isFinite(e)) return 'bone ' + b.name;
  return null;
}

async function runFor(a, seconds, each) {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    each?.(i);
    a.update(DT);
    const bad = finiteAnimal(a);
    if (bad) return `NaN in ${bad} after ${(i * DT).toFixed(2)} s`;
    if ((i & 15) === 15) await null;
  }
  return null;
}

for (const id of ids) {
  const res = [];
  const check = (name, err) => { res.push([name, err]); if (err) failures++; };
  const t0 = Date.now();
  try {
    const species = await loadSpecies(id);
    const data = await buildAnimalData(species, { seed: 1, quality, worker: false });
    check(`build ${quality} (${data.nV} vertices, ${Date.now() - t0} ms)`, data.nV > 0 && data.index.length > 0 ? null : 'empty mesh');
    const body = analyseBody(data);
    const water = waterFor(species.plan, body.scale) || undefined; // swimmers get a water volume
    const probe = await createAnimal(species, { seed: 1, quality, worker: false, water });
    const gaits = gaitSpeeds(probe, body).gaits;
    const actions = probe.actions || [];
    probe.dispose();
    check('idle 2 s', await runFor(await createAnimal(species, { seed: 1, quality, worker: false, water }), 2));
    for (const g of gaits) {
      const a = await createAnimal(species, { seed: 1, quality, worker: false, water });
      a.move({ speed: g.speed, gait: g.name });
      check(`gait ${g.name} ${g.speed.toFixed(1)} m/s 2 s`, await runFor(a, 2));
      a.dispose();
    }
    for (const name of actions) {
      const a = await createAnimal(species, { seed: 1, quality, worker: false, water });
      let err = null, rejected = null;
      try {
        const p = a.play(name, {});
        if (p && typeof p.catch === 'function') p.catch((e) => { rejected = String(e && e.message || e); });
      } catch (e) { err = 'throws: ' + (e && e.message || e); }
      if (!err) err = await runFor(a, 2);
      if (!err && rejected) err = 'promise rejected: ' + rejected;
      if (!err && actions.includes('stand')) { a.play('stand'); err = await runFor(a, 1); }
      check(`action ${name} 2 s`, err);
      a.dispose();
    }
    const buf = writeBake(data);
    const problems = await verifyBake(buf, data);
    check(`bake round trip (${(buf.byteLength / 1048576).toFixed(2)} MB)`, problems.length ? problems.join('; ') : null);
    // corrupt files must be rejected with an error, not crash later
    let rej = null;
    try { const bad = buf.slice(0); new Uint8Array(bad)[0] = 0; (await import('../src/index.js')).readBake(bad); } catch (e) { rej = e; }
    check('bake rejects a corrupt file', rej ? null : 'accepted a file without the BSTA magic');
  } catch (e) {
    check('exception', e.stack || String(e));
  }
  const bad = res.filter((r) => r[1]);
  console.log(`${bad.length ? 'FAIL' : 'PASS'} ${id} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const [name, err] of res) console.log(`  ${err ? 'FAIL' : 'ok  '} ${name}${err ? ': ' + err : ''}`);
}
console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${ids.length} species, ${failures} failure(s), ${((Date.now() - t00) / 1000).toFixed(1)} s`);
process.exit(failures ? 1 : 0);
