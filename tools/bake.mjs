#!/usr/bin/env node
// procedural-animals-bake: build an individual and store it as a .animal file that loads instantly.
//
//   procedural-animals-bake <species> [--seed 3] [--quality high] [--sex male|female] [--age adult|juvenile] [-o out.animal]
//   procedural-animals-bake --verify file.animal            (read back an existing file and check it loads)
//
// After writing, the file is read back and verified: every array identical (type, length, bytes), the
// header identical, and it loads with createAnimal(species, { baked }) and animates without NaN.
// Load it in a game with:  createAnimal('<species>', { baked: await (await fetch(url)).arrayBuffer() })
import fs from 'fs';
import path from 'path';
import { createAnimal, buildAnimalData, loadSpecies, writeBake, readBake, QUALITY } from '../src/index.js';
import { ARRAY_KEYS } from '../src/core/build/pipeline.js';

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); o[k] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true); }
    else o._.push(a);
  }
  return o;
}
const fail = (msg) => { console.error('procedural-animals-bake: ' + msg); process.exit(1); };
const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

/** Verify a bake buffer against the source data (optional). Returns a list of problems. */
export async function verifyBake(buf, source = null) {
  const problems = [];
  let back;
  try { back = readBake(buf); } catch (e) { return ['readBake: ' + e.message]; }
  for (const k of ARRAY_KEYS) {
    const a = back[k];
    if (!a || !ArrayBuffer.isView(a)) { problems.push(`${k}: missing`); continue; }
    if (!source) continue;
    const s = source[k];
    if (a.constructor !== s.constructor) problems.push(`${k}: type ${a.constructor.name} != ${s.constructor.name}`);
    else if (a.length !== s.length) problems.push(`${k}: length ${a.length} != ${s.length}`);
    else {
      const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(s.buffer, s.byteOffset, s.byteLength);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { problems.push(`${k}: bytes differ at ${i}`); break; }
    }
  }
  if (source) {
    const hdr = (d) => JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => !ARRAY_KEYS.includes(k))));
    if (hdr(back) !== hdr(source)) problems.push('header differs from the built data');
  }
  // loads and animates
  try {
    const a = await createAnimal(back.species, { baked: buf, quality: back.quality });
    a.move({ speed: 2 });
    for (let i = 0; i < 60; i++) a.update(1 / 60);
    const e = a.render.skeleton.bones.flatMap((b) => Array.from(b.matrixWorld.elements));
    if (!e.every(Number.isFinite)) problems.push('NaN in bone matrices after loading');
    if (a.stats.vertices !== back.nV) problems.push('vertex count mismatch after loading');
    a.dispose();
  } catch (e) { problems.push('createAnimal({ baked }) failed: ' + e.message); }
  return problems;
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help || (!o._[0] && !o.verify)) {
    console.log('usage: procedural-animals-bake <species> [--seed N] [--quality ' + Object.keys(QUALITY).join('|') + '] [--sex male|female] [--age adult|juvenile] [-o file.animal]\n       procedural-animals-bake --verify file.animal');
    process.exit(o.help ? 0 : 2);
  }
  if (o.verify) {
    if (!fs.existsSync(o.verify)) fail(`no such file: ${o.verify}`);
    const buf = toArrayBuffer(fs.readFileSync(o.verify));
    const problems = await verifyBake(buf);
    if (problems.length) fail('verification FAILED:\n  ' + problems.join('\n  '));
    const h = readBake(buf);
    console.log(`OK ${o.verify}: ${h.species} seed ${h.seed} ${h.quality}, ${h.nV} vertices, loads and animates`);
    return;
  }
  const speciesId = o._[0];
  const quality = o.quality || 'high';
  if (!QUALITY[quality]) fail(`unknown quality "${quality}" (${Object.keys(QUALITY).join(', ')})`);
  const seed = o.seed !== undefined ? +o.seed : 1;
  if (!Number.isFinite(seed)) fail('--seed must be a number');
  const species = await loadSpecies(speciesId).catch((e) => fail(e.message));
  const out = o.out || `${speciesId}-${seed}-${quality}.animal`;
  const t0 = Date.now();
  const data = await buildAnimalData(species, { seed, quality, sex: o.sex, age: o.age, worker: false });
  const t1 = Date.now();
  const buf = writeBake(data);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, new Uint8Array(buf));
  // read back from disk and verify
  const disk = toArrayBuffer(fs.readFileSync(out));
  const problems = await verifyBake(disk, data);
  if (problems.length) fail(`round trip FAILED for ${out}:\n  ` + problems.join('\n  '));
  const t2 = Date.now();
  const tl = Date.now();
  const a = await createAnimal(speciesId, { baked: disk });
  const loadMs = Date.now() - tl;
  a.dispose();
  console.log(`OK ${out}: ${speciesId} seed ${seed} ${quality}, ${data.nV} vertices, ${(disk.byteLength / 1048576).toFixed(2)} MB; build ${t1 - t0} ms, verify ${t2 - t1} ms, load from bake ${loadMs} ms (round trip identical)`);
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) main().catch((e) => fail(e.stack || e.message));
