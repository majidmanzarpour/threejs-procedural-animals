#!/usr/bin/env node
// Contact sheets of a species in the neutral studio (one headless page load for all views).
//
//   node tools/render.mjs <species> [--seed N] [--quality q] [--views turntable,gaits,face,actions,tiers]
//                          [--out dir] [--size 320x240] [--terrain flat|bumpy] [--gaits walk,trot] [--actions sit,lie]
//                          [--variant key] (species with variants, e.g. fish trout / goldfish)
//
// Views:  turntable  8 views around the standing animal, long lens
//         gaits      per gait (animal.gaits): 8 frames over one stride, side view tracking the animal
//         face       front, 3/4 and side of the head
//         closeup    face integrity: tight head close-ups from 5 angles, rows 'fur' / 'bare' (no shells,
//                    no fins) / 'holes' (the base two-sided, back faces red: any gap in the skin shows
//                    red). Run it at the tiers users see: --quality hero and --quality medium.
//                    --modes fur,bare,holes picks the rows (default all three).
// --timeout S: seconds allowed per page step (default 600; a hero close-up on a loaded machine needs more).
//         actions    key frames of every action (animal.actions); attack / jump also while running
//         tiers      the same individual at every quality tier (vertices, triangles, draw calls, build time)
//         holes      (opt-in) the exposed mesh holes the metrics find at this tier (tools/lib/holes.mjs):
//                    each cluster framed on its rim from 3 angles, as rendered and in the 'holes' debug
//                    view, to judge whether fur or a feather card covers it (--max-holes N, default 4),
//                    plus the two biggest patches of folded skin (back faces on show, no open edge)
//         eyes       (opt-in) eye integrity: each eye framed tight down its socket axis, toward the nose, toward
//                    the ear and from above, as rendered and base only (lids held open, gaze straight);
//                    a sunken, clipped or missing eyeball or a ragged aperture shows here (--max-eyes N)
// Output: <out>/<view>.png (default out/render/<species>/). Default quality: medium (~3 s per tile with
// software GL; high is ~10 s per tile).
import fs from 'fs';
import path from 'path';
import { parseArgs, launchPage, openHarness, evalT, writeDataUrl, composeSheet, mkdirp, OUT, die } from './lib/common.mjs';

const ALL_VIEWS = ['turntable', 'gaits', 'face', 'closeup', 'actions', 'tiers'];
const EXTRA_VIEWS = ['holes', 'eyes'];
const args = parseArgs(process.argv.slice(2), { flags: ['help', 'no-rebuild'], alias: { h: 'help', o: 'out', q: 'quality', s: 'seed' } });
if (args.help || !args._[0]) {
  console.log('usage: node tools/render.mjs <species> [--seed N] [--quality hero|high|medium|low|crowd] [--views ' + ALL_VIEWS.join(',') + '] [--out dir] [--size 320x240] [--terrain flat|bumpy] [--gaits a,b] [--actions a,b] [--variant v] [--modes fur,bare,holes] [--timeout seconds] [--max-holes N] [--max-eyes N]');
  process.exit(args.help ? 0 : 2);
}
const species = args._[0];
const seed = +(args.seed ?? 1);
const quality = args.quality || 'medium';
const views = (args.views || ALL_VIEWS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
for (const v of views) if (!ALL_VIEWS.includes(v) && !EXTRA_VIEWS.includes(v)) die(`unknown view "${v}" (${ALL_VIEWS.concat(EXTRA_VIEWS).join(', ')})`);
const [W, Hh] = (args.size || '320x240').split('x').map(Number);
if (!(W > 32 && Hh > 32 && W <= 960 && Hh <= 600)) die('--size must be within 33x33 .. 960x600');
const outDir = mkdirp(path.resolve(args.out || path.join(OUT, 'render', species + (args.variant ? '-' + args.variant : ''))));
const tmp = mkdirp(path.join(outDir, 'tiles'));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

const ctx = await launchPage({ width: W, height: Hh });
const results = [];
let failed = false;
try {
  await openHarness(ctx, { rebuild: !args['no-rebuild'] });
  const spawnOpts = { species, seed, quality, terrain: args.terrain || 'flat', variant: args.variant };
  const info = await evalT(ctx, (o) => window.__animals.spawn(o), spawnOpts, 300000, 'spawn');
  log(`${species} seed ${seed} ${quality}: ${info.vertices} vertices, ${info.triangles} triangles, build ${(info.buildMs / 1000).toFixed(1)} s`);
  log(`gaits: ${info.gaits.map((g) => `${g.name} ${g.speed.toFixed(1)} m/s`).join(', ') || 'none'}${info.missingGaits.length ? ' (no speed for ' + info.missingGaits.join(', ') + ')' : ''}`);
  log(`actions: ${info.actions.join(', ') || 'none'}`);
  let n = 0;
  // legless plans (snakes) read from above: the wave and the coils lie in the ground plane
  const legless = !info.legs.length;
  const saveTiles = (tiles, prefix) => tiles.map((t) => ({ file: writeDataUrl(path.join(tmp, `${prefix}_${n++}.png`), t.url), label: t.label, sub: t.sub }));
  const sheet = (view, rows, title) => {
    const out = path.join(outDir, `${view}.png`);
    composeSheet({ out, title: `${species}${args.variant ? ' ' + args.variant : ''} seed ${seed} ${quality} - ${title}`, rows, cols: 8 });
    results.push(out);
    log(`wrote ${path.relative(process.cwd(), out)}`);
  };
  const stepMs = 1000 * (+args.timeout || 600);
  const step = async (label, fn, arg, ms = stepMs) => {
    try { return await evalT(ctx, fn, arg, ms, label); } catch (e) { failed = true; console.error(`FAIL ${label}: ${e.message}`); return null; }
  };

  for (const view of views) {
    if (view === 'turntable') {
      const r = await step('turntable', (o) => window.__animals.turntable(o), { w: W, h: Hh, ...(legless ? { elevation: 28, fov: 16 } : {}) });
      if (r) sheet('turntable', [{ label: 'turntable (azimuth relative to heading, 0 = front, 90 = left side)', tiles: saveTiles(r.tiles, 'tt') }], 'turntable');
    } else if (view === 'face') {
      const r = await step('face', (o) => window.__animals.face(o), { w: W, h: Hh, ...(legless ? { views: [{ label: 'front', azimuth: 0, elevation: 14 }, { label: '3/4', azimuth: 40, elevation: 14 }, { label: 'side', azimuth: 90, elevation: 10 }] } : {}) });
      if (r) sheet('face', [{ label: 'head', tiles: saveTiles(r.tiles, 'face') }], 'face');
    } else if (view === 'closeup') {
      const modes = args.modes ? args.modes.split(',').filter((m) => ['fur', 'bare', 'holes'].includes(m)) : undefined;
      const r = await step('closeup', (o) => window.__animals.closeup(o), { w: W, h: Hh, modes, ...(legless ? { views: [{ label: 'front', azimuth: 0, elevation: 20 }, { label: '3/4', azimuth: 40, elevation: 16 }, { label: 'side', azimuth: 90, elevation: 10 }, { label: 'low', azimuth: 30, elevation: 3 }] } : {}) });
      if (r) sheet('closeup', r.rows.map((row) => ({ label: row.mode === 'fur' ? 'as rendered' : row.mode === 'bare' ? 'base only (no shells / fins)' : 'holes: back faces of the base in red (red = a gap in the skin)', tiles: saveTiles(row.tiles, 'close') })), 'face close-ups');
    } else if (view === 'gaits') {
      const want = args.gaits ? args.gaits.split(',') : null;
      const rows = [];
      for (const g of info.gaits.filter((g) => !want || want.includes(g.name))) {
        const r = await step(`gait ${g.name}`, (o) => window.__animals.gaitStrip(o), { gait: g.name, speed: g.speed, frames: 8, w: W, h: Hh, ...(legless ? { elevation: 55, fov: 24 } : {}) });
        const fv = (v) => (Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(1));
        if (r) { rows.push({ label: `${g.name}  target ${fv(g.speed)} m/s, actual ${fv(r.speed)} m/s, stride ${r.period.toFixed(3)} s (${r.freq.toFixed(2)} Hz); stance FL FR HL HR`, tiles: saveTiles(r.tiles, 'gait') }); log(`gait ${g.name} done`); }
      }
      if (rows.length) sheet('gaits', rows, 'gait strips (one stride, side view)');
      else console.warn('no gait strips (animal.gaits empty?)');
    } else if (view === 'actions') {
      const want = args.actions ? args.actions.split(',') : null;
      const acts = info.actions.filter((a) => a !== 'stand' && (!want || want.includes(a)));
      const rows = [];
      const mid = info.gaits.length ? info.gaits[Math.min(info.gaits.length - 1, Math.floor(info.gaits.length / 2))].speed : 3;
      const jobs = acts.map((a) => ({ name: a })).concat(['attack', 'jump'].filter((a) => acts.includes(a)).map((a) => ({ name: a, running: true, speed: mid })));
      for (const j of jobs) {
        const r = await step(`action ${j.name}${j.running ? ' (running)' : ''}`, (o) => window.__animals.actionStrip(o), { ...j, w: W, h: Hh, ...(legless ? { elevation: 32 } : {}) });
        if (r) {
          rows.push({ label: `${j.name}${j.running ? ` while running ${j.speed.toFixed(1)} m/s` : ''}  ${r.error ? 'ERROR ' + r.error : r.duration !== null ? `ended after ${r.duration.toFixed(2)} s` : 'no end event'}`, tiles: saveTiles(r.tiles, 'act') });
          log(`action ${j.name}${j.running ? ' running' : ''} done`);
        }
      }
      if (rows.length) sheet('actions', rows, 'actions (key frames)');
      else console.warn('no action strips (animal.actions is empty or only idle/stand)');
    } else if (view === 'holes') {
      const { meshHoles } = await import('./lib/holes.mjs');
      const { loadSpecies } = await import('../src/index.js');
      const hq = meshHoles(await loadSpecies(species), { seed, variant: args.variant, quality });
      const cl = hq.clusters.slice(0, +(args['max-holes'] || 4));
      // (folded skin: back faces on show without an open edge, the biggest clusters over 1 mm2)
      const fl = hq.folded.clusters.filter((c) => c.areaMm2 >= 1).slice(0, 2);
      log(`holes: ${hq.exposed} exposed open edges in ${hq.clusters.length} clusters, folded skin ${hq.folded.areaMm2} mm2 in ${hq.folded.clusters.length} clusters at ${quality}`);
      if (!cl.length && !fl.length) continue;
      const r = await step('holes', (o) => window.__animals.holeViews(o), { w: W, h: Hh, clusters: cl.map((c) => ({ vertex: c.vertex, ext: c.extMm / 1000, label: `${c.region} ${c.n} edges ${c.extMm} mm${c.box ? ' (box ' + c.box + ')' : ''}` })).concat(fl.map((c) => ({ vertex: c.vertex, ext: Math.sqrt(c.areaMm2) / 1000, label: `folded ${c.region} ${c.n} tris ${c.areaMm2} mm2`, dir: c.viewDir }))) });
      if (r) sheet('holes', r.rows.map((row) => ({ label: `${row.mode === 'fur' ? 'as rendered' : 'holes view (back faces red)'}: ${row.label}`, tiles: saveTiles(row.tiles, 'hole') })), 'exposed mesh holes');
    } else if (view === 'eyes') {
      const modes = args.modes ? args.modes.split(',').filter((m) => ['fur', 'bare'].includes(m)) : undefined;
      const r = await step('eyes', (o) => window.__animals.eyeViews(o), { w: W, h: Hh, modes, maxEyes: +(args['max-eyes'] || 2) });
      if (r) sheet('eyes', r.rows.map((row) => ({ label: row.mode === 'fur' ? 'as rendered (lids held open)' : 'base only (no shells / fins)', tiles: saveTiles(row.tiles, 'eye') })), 'eye close-ups');
    } else if (view === 'tiers') {
      const r = await step('tiers', (o) => window.__animals.tiers(o), { spawn: spawnOpts, w: W, h: Hh }, Math.max(900000, stepMs));
      if (r) sheet('tiers', [{ label: 'quality tiers (calls include the shadow pass)', tiles: saveTiles(r.tiles, 'tier') }], 'quality tiers');
    }
  }
  if (ctx.errors.length) { console.warn('page errors:\n  ' + ctx.errors.slice(0, 10).join('\n  ')); }
} catch (e) {
  failed = true;
  console.error('ERROR: ' + e.message);
} finally {
  await ctx.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
log(`${failed ? 'FAIL' : 'OK'} ${results.length} sheet(s) in ${path.relative(process.cwd(), outDir) || '.'}`);
process.exit(failed ? 1 : 0);
