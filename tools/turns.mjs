#!/usr/bin/env node
// Turn sheets: how the animal turns (body swing, heading overshoot, legs crossing, feet twisting).
//
//   node tools/turns.mjs <species> [--variant v] [--seed N] [--quality medium] [--size 240x180] [--out dir]
//                        [--rows walk,mid,fast,pivot,rev] [--every 0.25] [--frames 8] [--fixed [--zoom 1]] [--views top,low]
//
// Rows (--frames tiles each, --every s apart, starting when the new heading is commanded):
//   walk / mid / fast: the walk, middle and fastest ground gait, moving straight, then a +90 deg heading
//   command (60 deg for the fastest gait); pivot: standing, then a 180 deg heading command at speed 0;
//   rev: a heading reversal (+179 deg) at the walk. Each is seen from above (world-fixed azimuth, the
//   camera centred on the animal) and from a low 3/4 angle (--views picks them). --fixed: the top view
//   keeps one camera for the whole row (framing the ground the row covers, from the command point), so
//   the body's own motion over the ground shows (what it turns about, how far the hindquarters swing);
//   --zoom narrows that framing.
// Each tile is labelled with the time, heading error to the command and yaw rate. Output
// <out>/turns.png (default out/render/<species>[-<variant>]/).
import fs from 'fs';
import path from 'path';
import { parseArgs, launchPage, openHarness, evalT, writeDataUrl, composeSheet, mkdirp, OUT, die } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['help', 'fixed'], alias: { h: 'help', o: 'out', q: 'quality', s: 'seed' } });
if (args.help || !args._[0]) { console.log('usage: node tools/turns.mjs <species> [--variant v] [--seed N] [--quality q] [--size 240x180] [--rows walk,mid,fast,pivot,rev] [--every 0.25] [--frames 8] [--fixed] [--views top,low] [--out dir]'); process.exit(args.help ? 0 : 2); }
const species = args._[0];
const [W, Hh] = (args.size || '240x180').split('x').map(Number);
const every = +(args.every ?? 0.25), frames = +(args.frames ?? 8);
const rowsWanted = String(args.rows || 'walk,mid,fast,pivot').split(',');
const views = String(args.views || 'top,low').split(',');
const outDir = mkdirp(path.resolve(args.out || path.join(OUT, 'render', species + (args.variant ? '-' + args.variant : ''))));
const tmp = mkdirp(path.join(outDir, 'tiles-turns'));
const ctx = await launchPage({ width: W, height: Hh });
let failed = false;
try {
  await openHarness(ctx);
  const info = await evalT(ctx, (o) => window.__animals.spawn(o), { species, seed: +(args.seed ?? 1), quality: args.quality || 'medium', variant: args.variant }, 300000, 'spawn');
  const ground = info.gaits.filter((g) => g.speed > 0);
  if (!ground.length) die('no gaits with a speed');
  const gw = ground[0], gm = ground[Math.floor((ground.length - 1) / 2)], gf = ground[ground.length - 1];
  const R = {
    walk: { g: gw, turn: 90 }, mid: { g: gm, turn: 90 }, fast: { g: gf, turn: gf === gw ? 90 : 60 },
    pivot: { g: null, turn: 179.4 }, rev: { g: gw, turn: 179.4 },
  };
  const runs = rowsWanted.filter((k) => R[k] && (k !== 'mid' || gm !== gw) && (k !== 'fast' || (gf !== gm && gf !== gw) || rowsWanted.length === 1)).map((k) => {
    const { g, turn } = R[k];
    return { key: k, label: g ? `${g.name} ${g.speed.toFixed(2)} m/s, heading +${turn.toFixed(0)} deg` : 'pivot from standing, heading +180 deg', speed: g ? g.speed : 0, gait: g?.name, turn: turn * Math.PI / 180 };
  });
  const rows = [];
  let n = 0;
  for (const r of runs) {
    const res = await evalT(ctx, async (r) => {
      const B = window.__animals, a = B.H.animal;
      await B.ensureStanding();
      // (from a standstill: the previous row may still be braking from a sprint)
      a.move({ speed: 0, heading: a.state.heading });
      await B.stepAsync(8, 1 / 60, () => Math.hypot(a.state.velocity?.x || 0, a.state.velocity?.z || 0) < 0.02 && a.state.speed < 0.02);
      await B.stepAsync(0.6);
      const h0 = a.state.heading;
      if (r.speed > 0) { a.move({ speed: r.speed, heading: h0, gait: r.gait }); await B.stepAsync(2.5); }
      else await B.stepAsync(0.5);
      const hT = a.state.heading + r.turn;
      a.move({ speed: r.speed, heading: hT, gait: r.gait });
      // fixed camera: the ground the row covers (the path of a turn at speed v over the row's duration,
      // and the body around it), seen from above around the command point, shifted half way along
      const p0 = a.state.position.clone(), dur = r.every * (r.frames - 1);
      const reach = Math.min(r.speed * dur, 40 * B.H.S) * 0.5;
      const fx = [p0.x + Math.sin(h0 + r.turn / 2) * reach, p0.y, p0.z + Math.cos(h0 + r.turn / 2) * reach];
      const size = (2 * reach + 1.6 * Math.max(B.H.S, B.H.body.length)) / r.zoom;
      const top = [], low = [];
      for (let i = 0; i < r.frames; i++) {
        const err = Math.atan2(Math.sin(hT - a.state.heading), Math.cos(hT - a.state.heading)) * 180 / Math.PI;
        const lab = `t ${(i * r.every).toFixed(2)} err ${err.toFixed(0)} yaw ${(a.state.yawRate ?? a.motion.yawRate ?? 0).toFixed(2)}`;
        if (r.views.includes('top')) {
          if (r.fixed) B.view({ azimuth: 0, worldAzimuth: true, elevation: 89, fov: 24, fit: 1.0, target: fx, size, w: r.w, h: r.h });
          else B.view({ azimuth: 0, worldAzimuth: true, elevation: 82, fov: 24, fit: 1.25, target: 'body', w: r.w, h: r.h });
          top.push({ url: B.render({ w: r.w, h: r.h }).url, label: lab });
        }
        if (r.views.includes('low')) {
          B.view({ azimuth: 35, worldAzimuth: true, elevation: 8, fov: 24, fit: 1.2, target: 'body', w: r.w, h: r.h });
          low.push({ url: B.render({ w: r.w, h: r.h }).url, label: lab });
        }
        await B.stepAsync(r.every);
      }
      a.stop?.();
      return { top, low };
    }, { ...r, w: W, h: Hh, every, frames, fixed: !!args.fixed, views, zoom: +(args.zoom ?? 1) }, 900000, `turn ${r.label}`).catch((e) => { failed = true; console.error('FAIL ' + e.message); return null; });
    if (!res) continue;
    const save = (tiles, p) => tiles.map((t) => ({ file: writeDataUrl(path.join(tmp, `${p}_${n++}.png`), t.url), label: t.label }));
    if (res.top.length) rows.push({ label: `${r.label}: from above (${args.fixed ? 'fixed camera' : 'world-fixed azimuth, centred on the animal'})`, tiles: save(res.top, 'top') });
    if (res.low.length) rows.push({ label: `${r.label}: low 3/4`, tiles: save(res.low, 'low') });
    console.log(`turn row done: ${r.label}`);
  }
  if (rows.length) composeSheet({ out: path.join(outDir, 'turns.png'), title: `${species}${args.variant ? ' ' + args.variant : ''} - turns (${every} s apart from the heading command)`, rows, cols: frames });
  console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, 'turns.png'))}`);
} catch (e) { failed = true; console.error('ERROR ' + e.message); }
finally { await ctx.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
