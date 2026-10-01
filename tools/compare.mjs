#!/usr/bin/env node
// Render | photo comparison sheets from matching angles.
//
//   node tools/compare.mjs <species> [--seed N] [--quality high] [--views side,front,three-quarter,face]
//                           [--no-overlay] [--out dir]
//
// Reads <refcache>/<species>/index.json; the reference photo folder defaults to ../procedural-animals-refcache
// next to the repository (override it with PROCEDURAL_ANIMALS_REFCACHE; photos are never committed):
//   [{ "file": "side1.jpg", "view": "side|front|three-quarter|face|...", "variant": "goldfish" (optional),
//      "facing": "left|right",            optional: where the animal's head points in the photo
//      "bbox": [x0, y0, x1, y1],          optional: the animal's box in the photo (pixels) -> exact framing
//      "camera": { "azimuth", "elevation", "fov" }  optional: override the matched camera
//      "sex": "male", "age": "juvenile"   optional: build that individual (e.g. a rooster photo) }]
// Views other than side / front / three-quarter / face are skipped. Writes
// out/compare/<species>/<file-stem>_<view>.png (never inside src/, never committed).
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { parseArgs, launchPage, openHarness, evalT, writeDataUrl, mkdirp, OUT, REFCACHE, TOOLS, die } from './lib/common.mjs';

const VIEWS = ['side', 'front', 'three-quarter', 'face'];
const args = parseArgs(process.argv.slice(2), { flags: ['help', 'no-overlay', 'no-rebuild'], alias: { h: 'help', o: 'out', q: 'quality', s: 'seed' } });
if (args.help || !args._[0]) { console.log('usage: node tools/compare.mjs <species> [--seed N] [--quality q] [--views ' + VIEWS.join(',') + '] [--no-overlay] [--out dir]'); process.exit(args.help ? 0 : 2); }
const species = args._[0];
const refDir = path.join(REFCACHE, species);
const indexFile = path.join(refDir, 'index.json');
if (!fs.existsSync(indexFile)) die(`no reference index: ${indexFile} (format: docs/AUTHORING.md, "Reference photos")`);
let index;
try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch (e) { die(`${indexFile}: ${e.message}`); }
if (!Array.isArray(index)) index = index.photos || [];
const wantViews = (args.views || VIEWS.join(',')).split(',');
const photos = index.filter((p) => p && p.file && VIEWS.includes(norm(p.view)) && wantViews.includes(norm(p.view)));
if (!photos.length) die(`no photos with views ${wantViews.join('/')} in ${indexFile}`);
const outDir = mkdirp(path.resolve(args.out || path.join(OUT, 'compare', species)));
if (outDir.split(path.sep).includes('src')) die('refusing to write comparison sheets inside src/');
const tmp = mkdirp(path.join(outDir, 'tmp'));

function norm(v) { v = String(v || '').toLowerCase().replace(/[\s_]/g, '-'); return v === 'threequarter' || v === '3/4' || v === 'three-quarters' ? 'three-quarter' : v; }

// Camera for a photo: azimuth relative to the animal's heading (0 = front, +90 = its left side, which
// faces screen-left). A side photo facing right is the right side (-90).
function cameraFor(p) {
  const v = norm(p.view), f = p.facing === 'right' ? -1 : p.facing === 'left' ? 1 : 0;
  const s = f || 1;
  let cam;
  if (v === 'side') cam = { azimuth: 90 * s, elevation: 4, fov: 22, target: 'body' };
  else if (v === 'three-quarter') cam = { azimuth: 45 * s, elevation: 6, fov: 22, target: 'body' };
  else if (v === 'front') cam = { azimuth: 12 * f, elevation: 5, fov: 22, target: 'body' };
  else cam = { azimuth: 25 * f, elevation: 3, fov: 20, target: 'head' };
  return { ...cam, ...(p.camera || {}) };
}

const ctx = await launchPage({ width: 640, height: 480 });
let failed = 0, done = 0;
try {
  await openHarness(ctx, { rebuild: !args['no-rebuild'] });
  // photos may name a variant (e.g. a rattlesnake photo for the snake species) and a pose to hold
  // ("action": "coil", played and held for "settle" seconds before the render)
  let cur = null;
  // ("look": [forward, up, left] in units of S from the animal: a look target held during the pose)
  const keyOf = (p) => `${p.variant || args.variant || ''}|${p.sex || ''}|${p.age || ''}|${p.action || ''}|${p.look ? p.look.join(',') : ''}`;
  photos.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  for (const p of photos) {
    const key = keyOf(p);
    if (key !== cur) {
      cur = key;
      const info = await evalT(ctx, (o) => window.__animals.spawn(o), { species, seed: +(args.seed ?? 1), quality: args.quality || 'high', variant: p.variant || args.variant, sex: p.sex, age: p.age }, 300000, 'spawn');
      console.log(`${species}${p.variant ? ' (' + p.variant + ')' : ''}: ${info.vertices} vertices (${info.quality})${p.action ? ', pose ' + p.action : ''}`);
      if (p.look) await evalT(ctx, (L) => {
        const B = window.__animals, a = B.H.animal, s = a.state.position, h = a.state.heading, S = B.H.S;
        a.lookAt(new B.THREE.Vector3(s.x + (Math.sin(h) * L[0] + Math.cos(h) * L[2]) * S, s.y + L[1] * S, s.z + (Math.cos(h) * L[0] - Math.sin(h) * L[2]) * S));
      }, p.look, 30000, 'look');
      if (p.action) await evalT(ctx, (o) => { window.__animals.play(o.a); return window.__animals.stepAsync(o.t); }, { a: p.action, t: p.settle ?? 5 }, 120000, 'pose');
      else if (p.look) await evalT(ctx, () => window.__animals.stepAsync(3), null, 60000, 'look settle');
      await evalT(ctx, () => window.__animals.stepAsync(1.5), null, 60000, 'settle');
    }
    const file = path.join(refDir, p.file);
    if (!fs.existsSync(file)) { console.error(`FAIL ${p.file}: missing`); failed++; continue; }
    const dim = spawnSync('python3', ['-c', `from PIL import Image;im=Image.open(${JSON.stringify(file)});print(im.width,im.height)`], { encoding: 'utf8' });
    const [pw, ph] = dim.stdout.trim().split(' ').map(Number);
    if (!(pw > 0)) { console.error(`FAIL ${p.file}: cannot read image`); failed++; continue; }
    // render at the photo's aspect, <= 640x480
    const k = Math.min(640 / pw, 480 / ph);
    const w = Math.max(64, Math.round(pw * k)), h = Math.max(64, Math.round(ph * k));
    const cam = cameraFor(p);
    try {
      const r = await evalT(ctx, ({ cam, w, h }) => {
        const B = window.__animals;
        B.view({ ...cam, w, h, fit: 1.1 });
        return { img: B.render({ w, h }).url, key: B.render({ w, h, silhouette: true }).url };
      }, { cam, w, h }, 300000, `render ${p.file}`);
      const stem = path.basename(p.file, path.extname(p.file));
      const rf = writeDataUrl(path.join(tmp, stem + '_r.png'), r.img), kf = writeDataUrl(path.join(tmp, stem + '_k.png'), r.key);
      const out = path.join(outDir, `${stem}_${norm(p.view)}.png`);
      const spec = { render: rf, key: kf, photo: file, out, bbox: p.bbox || null, overlay: !args['no-overlay'],
        label: `${species} vs ${p.file} (${norm(p.view)}${p.facing ? ', facing ' + p.facing : ', facing unknown: add "facing"'}) az ${cam.azimuth} el ${cam.elevation}` };
      const sf = path.join(tmp, stem + '.json');
      fs.writeFileSync(sf, JSON.stringify(spec));
      const res = spawnSync('python3', [path.join(TOOLS, 'lib', 'compare.py'), sf], { encoding: 'utf8' });
      if (res.status !== 0) throw new Error(res.stderr || 'compare.py failed');
      console.log(`ok   ${path.relative(process.cwd(), out)}`);
      done++;
    } catch (e) { console.error(`FAIL ${p.file}: ${e.message}`); failed++; }
  }
  if (ctx.errors.length) console.warn('page errors:\n  ' + ctx.errors.slice(0, 8).join('\n  '));
} catch (e) { console.error('ERROR: ' + e.message); failed++; } finally {
  await ctx.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`${failed ? 'FAIL' : 'OK'}: ${done} sheet(s) in ${path.relative(process.cwd(), outDir)}${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
