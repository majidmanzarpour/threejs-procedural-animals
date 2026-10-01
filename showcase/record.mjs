// Records the demo reel offline: headless Chromium on the GPU renders the reel frame by frame at
// exactly 1/fps of sequence time (showcase/src/demo.js, &record), each frame's canvas is read back and
// posted as raw RGBA to a local server that pipes it into ffmpeg (H.264, yuv420p, BT.709). Writes next
// to the MP4: the cue sheet (JSON + Markdown), the camera path with its smoothness report, frame timings
// and contact sheets (one tile every 0.5 s).
//
//   node showcase/record.mjs [--fps 60] [--size 1920x1080] [--aspect 16:9] [--only cheetah,horse]
//                            [--shots 3-7] [--from 12] [--to 30] [--out out/demo] [--name reel]
//                            [--crf 16] [--preset slow] [--ss 1] [--no-build] [--no-sheets] [--resume]
//                            [--repo github.com/you/repo] [--social 30 | off] [--preview 24 | off]
//   node showcase/record.mjs --stills 1.5,4,9.25 [--size 960x540] ...   single frames as PNG
//   node showcase/record.mjs --live [--from 40] [--seconds 20]           real-time frame times per shot
//   node showcase/record.mjs --analyze --out ... --name ...              rebuild the reports of a recording
//   --social 30 (Mbit/s cap of the <name>-social.mp4 cut; 'off' skips it)  --social-only (remake it)
//   --preview 24 (MB: a small <name>-preview.mp4 to share: H.264, 720 px on the short side, 30 fps,
//   two-pass to fit under that size; 'off' skips it)  --preview-only (remake it)
//
// --aspect 9:16 with no --size renders 1080x1920 (1:1 -> 1080x1080). Runs at low priority (nice 10).
//
// The reel is recorded chain by chain (a shot and the shots that carry on with its cast): every chain
// starts from a seek to its first frame (the director is deterministic) and is encoded to its own part
// in <name>.parts/, so a crashed or stalled browser costs one chain, retried in a fresh browser, and
// --resume carries on with an interrupted recording. The parts are joined without re-encoding.
import { chromium } from 'playwright-core';
import { CHROME, CHROME_ARGS, parseArgs, mkdirp } from '../tools/lib/common.mjs';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = parseArgs(process.argv.slice(2), { flags: ['no-build', 'no-sheets', 'no-titles', 'keep-open', 'analyze', 'live', 'resume', 'keep-parts', 'social-only', 'preview-only'] });
try { os.setPriority(0, 10); } catch (e) { /* already lower */ }

const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FFPROBE = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';
const fps = +(args.fps || 60);
const aspectName = String(args.aspect || '16:9');
const [aw, ah] = aspectName.split(':').map(Number);
let W, H;
if (args.size) [W, H] = String(args.size).split('x').map(Number);
else if (aw && ah && aw < ah) { W = 1080; H = Math.round((1080 * ah) / aw); }
else if (aw && ah && aw === ah) { W = 1080; H = 1080; }
else { H = 1080; W = Math.round((1080 * (aw || 16)) / (ah || 9)); }
W -= W % 2; H -= H % 2;
const outDir = path.resolve(root, args.out || 'out/demo');
const name = args.name || (args.stills ? 'stills' : `reel-${aspectName.replace(':', 'x')}`);
mkdirp(outDir);
const log = (...a) => console.log(`[record ${new Date().toTimeString().slice(0, 8)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// H.264 for delivery: BT.709 conversion (the frames are sRGB) and tags, so players do not guess BT.601
const ENCODE = (crf, preset) => ['-vf', 'vflip,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv',
  '-c:v', 'libx264', '-preset', String(preset), '-crf', String(crf), '-x264-params', 'aq-mode=3',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-threads', '8'];
const ff = (argv, opts = {}) => spawn('nice', ['-n', '10', FFMPEG, '-hide_banner', '-loglevel', 'error', ...argv], { stdio: ['pipe', 'inherit', 'inherit'], ...opts });

// --preview-only: (re)make <name>-preview.mp4 from an existing recording
if (args['preview-only']) {
  previewCut(path.join(outDir, `${name}.mp4`), +(args.preview || 24));
  process.exit(0);
}
// --social-only: (re)make <name>-social.mp4 from an existing recording
if (args['social-only']) {
  socialCut(path.join(outDir, `${name}.mp4`), +(args.social || 30));
  process.exit(0);
}
// --analyze: rebuild the reports (smoothness, cue sheet Markdown, contact sheets) of an existing recording
if (args.analyze) {
  const base = path.join(outDir, name);
  const cue = JSON.parse(fs.readFileSync(base + '.cue.json', 'utf8'));
  const camLog = JSON.parse(fs.readFileSync(base + '.camera.json', 'utf8'));
  const fpsA = +(args.fps || Math.round(1 / Math.max(1e-6, (camLog[camLog.length - 1].T - camLog[0].T) / (camLog.length - 1))));
  fs.writeFileSync(base + '.cue.md', cueMarkdown(cue, base + '.mp4', fpsA));
  const smooth = smoothness(camLog, fpsA);
  const prev = fs.existsSync(base + '.smoothness.json') ? JSON.parse(fs.readFileSync(base + '.smoothness.json', 'utf8')) : {};
  fs.writeFileSync(base + '.smoothness.json', JSON.stringify({ ...prev, smooth }, null, 1));
  log('camera smoothness:', JSON.stringify(smooth.summary));
  if (!args['no-sheets']) contactSheets(base + '.mp4', base, +(args.from || 0));
  process.exit(0);
}

// ---------------------------------------------------------------- build
if (!args['no-build']) {
  const r = spawnSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
const dist = path.join(root, 'dist');

// ---------------------------------------------------------------- server: the page + frame sink
let sink = null; // (buffer, url) => Promise
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && (u.pathname === '/frame' || u.pathname === '/still')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try { await sink?.(Buffer.concat(chunks), u); res.writeHead(200); res.end('ok'); } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    return;
  }
  const f = path.join(dist, decodeURIComponent(u.pathname === '/' ? '/showcase.html' : u.pathname));
  if (!f.startsWith(dist) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---------------------------------------------------------------- browser (relaunched after a crash)
const LIVE = !!args.live;
// (an offline recording pins the showcase's adaptive tier (&tier=0) and the reel uses its own quality profile
// ('record': the cast's own tiers, no adaptation at cuts): no tier ever changes mid-reel)
const q = new URLSearchParams(LIVE ? { demo: '', w: String(W), h: String(H), aspect: aspectName } : { demo: '', record: '', tier: '0', w: String(W), h: String(H), aspect: aspectName, fps: String(fps) });
if (LIVE && args.from !== undefined) q.set('from', String(args.from));
for (const k of ['only', 'shots', 'ss', 'tod', 'repo', 'seed', 'quality', 'profile', 'msaa', 'cap', 'skywarm', 'grain', 'grainpx']) if (args[k] !== undefined) q.set(k, String(args[k]));
// --query "a=1&b" : any other page option (demo.js parseOptions)
if (args.query) for (const [k, v] of new URLSearchParams(String(args.query))) q.set(k, v);
if (args['no-titles']) q.set('titles', '0');
const url = `http://127.0.0.1:${port}/showcase.html?${q.toString().replace(/=(&|$)/g, '$1')}`;
const errors = [];
let browser = null, page = null, chromePid = 0, doom = null;
// the Chromium processes this script started (direct children): killed by pid when a browser hangs
const chromeChildren = () => {
  try {
    return execFileSync('ps', ['-Ao', 'pid=,ppid=,command=']).toString().split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m) => m && +m[2] === process.pid && /chrome/i.test(m[3])).map((m) => +m[1]);
  } catch (e) { return []; }
};
async function openPage() {
  const before = chromeChildren();
  // --expose-gc: the page frees each chunk's frame uploads (demo.js recordChunk)
  browser = await chromium.launch({ executablePath: CHROME, timeout: 120000, args: [...CHROME_ARGS, '--disable-gpu-sandbox', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--js-flags=--expose-gc'] });
  chromePid = chromeChildren().find((p) => !before.includes(p)) || 0;
  page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  // a crashed page or a lost browser fails the step in progress at once (instead of hanging)
  doom = new Promise((_, reject) => {
    page.on('crash', () => reject(new Error('the page crashed')));
    browser.on('disconnected', () => reject(new Error('the browser disconnected')));
  });
  doom.catch(() => {});
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error') { errors.push(t); if (!/ERR_FAILED|fonts\.g/.test(t)) console.log('  page error:', t); } else if ((/^demo/.test(t) || m.type() === 'warning') && !/performance warning|too many errors/.test(t)) console.log('  page:', t); });
  page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('  PAGEERROR', e.message); });
  log('loading', url, `${W}x${H}`);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  await guard(page.waitForFunction(() => window.__demo && (window.__demo.ready || window.__demo.error), null, { timeout: 15 * 60 * 1000, polling: 500 }), 16 * 60 * 1000, 'loading');
  const info = await page.evaluate(() => (window.__demo.error ? { err: window.__demo.error } : { total: window.__demo.total, shots: window.__demo.shots, size: window.__demo.size(), gpu: window.proceduralAnimals?.gpu }));
  if (info.err) throw new Error(info.err);
  log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${info.shots.length} shots, ${info.total.toFixed(2)} s, ${info.size.w}x${info.size.h}, ${info.gpu}`);
  return info;
}
async function closeBrowser() {
  const b = browser, pid = chromePid;
  browser = null; page = null; chromePid = 0;
  if (b) await Promise.race([b.close().catch(() => {}), sleep(10000)]);
  if (pid) try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ }
}
// a page step that fails when the page crashes, the browser goes away or it takes longer than ms
function guard(p, ms, what) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([p, doom, t]).finally(() => clearTimeout(timer));
}
async function finish(code = 0) {
  await closeBrowser();
  server.close();
  process.exit(code);
}

let info = await openPage();

// ---------------------------------------------------------------- --live: real-time playback frame times
if (LIVE) {
  const secs = +(args.seconds || info.total - (+args.from || 0));
  log(`playing live for ${secs.toFixed(1)} s (requestAnimationFrame, profile ${args.profile || 'live'})`);
  await sleep(secs * 1000);
  const { log: L, shots } = await page.evaluate(() => window.__demo.liveLog());
  const pcs = (a) => { const b = a.slice().sort((x, y) => x - y); const p = (k) => b[Math.min(b.length - 1, Math.floor(k * b.length))]; return b.length ? { n: b.length, p50: +p(0.5).toFixed(1), p95: +p(0.95).toFixed(1), p99: +p(0.99).toFixed(1), max: +b[b.length - 1].toFixed(1), fps: +(1000 / (b.reduce((x, y) => x + y, 0) / b.length)).toFixed(1) } : null; };
  const rows = L.slice(30);
  const per = {};
  for (const [T, i, dt, work, tier] of rows) { const k = shots[i]; (per[k] || (per[k] = { dt: [], work: [], tier })).dt.push(dt); per[k].work.push(work); }
  const report = { all: { frame: pcs(rows.map((r) => r[2])), work: pcs(rows.map((r) => r[3])) }, shots: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, { frame: pcs(v.dt), work: pcs(v.work), tier: v.tier }])) };
  fs.writeFileSync(path.join(outDir, `${name}.live.json`), JSON.stringify(report, null, 1));
  log('frame ms (all):', JSON.stringify(report.all));
  for (const [k, v] of Object.entries(report.shots)) console.log(`  ${k.padEnd(16)} frame p50 ${v.frame.p50} p95 ${v.frame.p95} max ${v.frame.max} (${v.frame.fps} fps)  js ${v.work.p50}  fur tier +${v.tier}`);
  await finish(0);
}

// ---------------------------------------------------------------- probes: --eval file.js (page code with D, THREE-free helpers, snap)
if (args.eval) {
  const code = fs.readFileSync(path.resolve(args.eval), 'utf8');
  const dir = mkdirp(path.join(outDir, name));
  sink = (buf, u) => new Promise((resolve, reject) => {
    const file = path.join(dir, (u.searchParams.get('name') || 'snap') + '.png');
    const p = ff(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${info.size.w}x${info.size.h}`, '-i', '-', '-vf', 'vflip', file]);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg ' + c))));
    p.stdin.end(buf);
  });
  const r = await page.evaluate(async (code) => {
    const D = window.__demo.director, snap = window.__demo.snap;
    const fn = new Function('D', 'snap', 'return (async () => {' + code + '})()');
    return fn(D, snap);
  }, code);
  if (r !== undefined) console.log(JSON.stringify(r, null, 1));
  if (errors.length) log('page errors:', errors.slice(0, 10));
  await finish(0);
}

// ---------------------------------------------------------------- stills
if (args.stills) {
  const times = String(args.stills).split(',').map(Number).filter((x) => Number.isFinite(x));
  mkdirp(path.join(outDir, name));
  const files = [];
  for (const T of times) {
    const file = path.join(outDir, name, `t${T.toFixed(2).padStart(6, '0')}.png`);
    sink = (buf) => new Promise((resolve, reject) => {
      const p = ff(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${info.size.w}x${info.size.h}`, '-i', '-', '-vf', 'vflip', file]);
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg ' + c))));
      p.stdin.end(buf);
    });
    const shot = await page.evaluate(async (T) => {
      const d = window.__demo;
      d.frameAt(T);
      const gl = window.proceduralAnimals.renderer.getContext();
      const { w, h } = d.size();
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      await fetch('/still', { method: 'POST', body: new Blob([buf]) });
      const D = d.director;
      return D.shots[D.cur].id;
    }, T);
    files.push(file);
    log(`still ${T}s (${shot}) -> ${path.relative(root, file)}`);
  }
  const cue = await page.evaluate(() => window.__demo.cue());
  fs.writeFileSync(path.join(outDir, name, 'cue.json'), JSON.stringify(cue, null, 1));
  if (errors.length) log('page errors:', errors.slice(0, 10));
  await finish(0);
}

// ---------------------------------------------------------------- the reel, chain by chain
const from = +(args.from || 0);
const to = Math.min(info.total, args.to !== undefined ? +args.to : info.total);
const N = Math.round((to - from) * fps);
const mp4 = path.join(outDir, `${name}.mp4`);
const crf = args.crf ?? 16, preset = args.preset || 'slow';
// chains: a shot plus the shots that keep its cast; the frames of the recording (T = from + f / fps)
// are split at the chains' starts
const chains = [];
for (const s of info.shots) {
  if (!s.keep || !chains.length) chains.push({ start: s.start, ids: [s.id] });
  else chains[chains.length - 1].ids.push(s.id);
}
const segs = [];
for (let c = 0; c < chains.length; c++) {
  const f0 = Math.max(0, Math.ceil((chains[c].start - from) * fps - 1e-6));
  const f1 = c + 1 < chains.length ? Math.min(N, Math.ceil((chains[c + 1].start - from) * fps - 1e-6)) : N;
  if (f1 > f0) segs.push({ f0, f1, ids: chains[c].ids });
}
const partsDir = mkdirp(path.join(outDir, `${name}.parts`));
const partFile = (k) => path.join(partsDir, `seg-${String(k).padStart(3, '0')}.mp4`);
const manifestFile = path.join(partsDir, 'manifest.json');
const recKey = JSON.stringify({ url: url.replace(/:\d+\//, '/'), fps, W, H, from, to, crf, preset, shots: info.shots.map((s) => [s.id, s.start, s.dur]) });
let manifest = { key: recKey, segs: {} };
if (args.resume && fs.existsSync(manifestFile)) {
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (m.key === recKey) manifest = m;
  else log('--resume: the recording settings changed, starting over');
}
if (!args.resume) manifest.segs = {};
// stale files (a part that was being written, an older recording): only finished chains stay
for (const f of fs.readdirSync(partsDir)) if (f !== 'manifest.json' && !Object.values(manifest.segs).some((s) => s.done && (s.file === f || s.camera === f))) fs.unlinkSync(path.join(partsDir, f));
const saveManifest = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
saveManifest();
log(`recording ${N} frames (${from}..${to.toFixed(2)} s at ${fps} fps) in ${segs.length} chains -> ${path.relative(root, mp4)}`);

const CH = 120; // frames per page call
const tRec = Date.now();
let framesThisRun = 0;
const doneFrames = () => Object.values(manifest.segs).reduce((n, s) => n + (s.done ? s.frames : 0), 0);
async function recordSegment(k, seg) {
  const n = seg.f1 - seg.f0;
  const file = partFile(k);
  const enc = ff(['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${info.size.w}x${info.size.h}`, '-r', String(fps), '-i', '-', ...ENCODE(crf, preset), file]);
  let encExit = null;
  const encDone = new Promise((r) => enc.on('close', (c) => { encExit = c; r(c); }));
  enc.stdin.on('error', () => {});
  let got = 0;
  sink = (buf) => new Promise((resolve, reject) => {
    if (buf.length !== info.size.w * info.size.h * 4) { reject(new Error('bad frame size ' + buf.length)); return; }
    if (encExit !== null) { reject(new Error('the encoder exited ' + encExit)); return; }
    got++;
    if (enc.stdin.write(buf)) resolve(); else enc.stdin.once('drain', resolve);
  });
  const times = [];
  try {
    for (let j = 0; j < n; j += CH) {
      const m = Math.min(CH, n - j);
      const start = j === 0 ? +(from + seg.f0 / fps).toFixed(6) : null;
      const r = await guard(page.evaluate(({ m, i0, fps, start }) => window.__demo.director.recordChunk({ n: m, i0, fps, start }), { m, i0: seg.f0 + j, fps, start }), 300000, `chain ${k} frames ${j}..${j + m}`);
      times.push(...r.times);
      framesThisRun += m;
      const el = (Date.now() - tRec) / 1000, total = doneFrames() + j + m;
      log(`chain ${k + 1}/${segs.length} (${seg.ids.join(', ')}) ${j + m}/${n}  ·  ${total}/${N} frames ${((total / N) * 100).toFixed(0)}%  ${(framesThisRun / el).toFixed(1)} fps  eta ${(((N - total) * el) / framesThisRun / 60).toFixed(1)} min`);
    }
  } catch (e) {
    try { enc.kill('SIGKILL'); } catch (e2) { /* gone */ }
    throw e;
  }
  enc.stdin.end();
  const code = await encDone;
  if (code !== 0) throw new Error(`the encoder of chain ${k} exited ${code}`);
  if (got !== n) throw new Error(`chain ${k}: ${got} of ${n} frames arrived`);
  const cam = await guard(page.evaluate(() => window.__demo.camLog()), 120000, 'camera log');
  const cue = await guard(page.evaluate(() => window.__demo.cue()), 120000, 'cue sheet');
  const flags = {};
  for (const s of cue.shots) if (seg.ids.includes(s.id) && s.flags.length) flags[s.id] = s.flags;
  fs.writeFileSync(file.replace(/\.mp4$/, '.camera.json'), JSON.stringify(cam));
  manifest.segs[k] = { done: true, frames: n, file: path.basename(file), camera: path.basename(file).replace(/\.mp4$/, '.camera.json'), flags, times };
  saveManifest();
}

for (let k = 0; k < segs.length; k++) {
  const prev = manifest.segs[k];
  if (prev?.done && fs.existsSync(path.join(partsDir, prev.file))) { log(`chain ${k + 1}/${segs.length} (${segs[k].ids.join(', ')}): done before, kept`); continue; }
  for (let attempt = 1; ; attempt++) {
    try {
      if (!page) info = await openPage();
      await recordSegment(k, segs[k]);
      break;
    } catch (e) {
      log(`chain ${k + 1} failed (attempt ${attempt}): ${e.message}`);
      await closeBrowser();
      if (attempt >= 3) { server.close(); process.exit(1); }
    }
  }
}

// ---------------------------------------------------------------- join the parts, reports
const cue = await guard(page ? page.evaluate(() => window.__demo.cue()) : Promise.reject(new Error('no page')), 120000, 'cue sheet').catch(async () => { info = await openPage(); return page.evaluate(() => window.__demo.cue()); });
await closeBrowser();
server.close();
const list = path.join(partsDir, 'list.txt');
fs.writeFileSync(list, segs.map((s, k) => `file '${partFile(k)}'`).join('\n') + '\n');
const cat = spawnSync('nice', ['-n', '10', FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
if (cat.status !== 0) { log('joining the parts failed'); process.exit(1); }
const probe = spawnSync(FFPROBE, ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', mp4], { encoding: 'utf8' });
const nOut = +String(probe.stdout).trim();
log(`joined ${segs.length} parts: ${nOut} frames (expected ${N}) in ${((Date.now() - tRec) / 1000).toFixed(0)} s`);
if (nOut !== N) log('WARNING: frame count mismatch');

// cue sheet (flags from every chain, whichever browser recorded it), camera path, timings
for (const s of cue.shots) {
  const f = new Set(s.flags);
  for (const g of Object.values(manifest.segs)) for (const x of g.flags?.[s.id] || []) f.add(x);
  s.flags = [...f];
}
const camLog = segs.flatMap((s, k) => JSON.parse(fs.readFileSync(path.join(partsDir, manifest.segs[k].camera), 'utf8')));
fs.writeFileSync(path.join(outDir, `${name}.cue.json`), JSON.stringify(cue, null, 1));
fs.writeFileSync(path.join(outDir, `${name}.cue.md`), cueMarkdown(cue, mp4, fps));
fs.writeFileSync(path.join(outDir, `${name}.camera.json`), JSON.stringify(camLog));
const smooth = smoothness(camLog, fps);
const work = segs.flatMap((s, k) => manifest.segs[k].times.map((t) => t.work)).sort((a, b) => a - b);
const timing = { frames: work.length, workMs: { p50: pc(work, 0.5), p95: pc(work, 0.95), p99: pc(work, 0.99), max: work[work.length - 1] } };
fs.writeFileSync(path.join(outDir, `${name}.smoothness.json`), JSON.stringify({ smooth, timing }, null, 1));
log('camera smoothness:', JSON.stringify(smooth.summary));
log('frame work ms (render):', JSON.stringify(timing.workMs));
if (errors.length) log('page errors:', errors.slice(0, 10));
if (nOut === N && !args['keep-parts']) fs.rmSync(partsDir, { recursive: true, force: true });

// ---------------------------------------------------------------- the social cut (bounded bitrate)
if (args.social !== 'off') socialCut(mp4, +(args.social || 30));
if (args.preview !== 'off') previewCut(mp4, +(args.preview || 24));

// ---------------------------------------------------------------- contact sheets (every 0.5 s)
if (!args['no-sheets']) contactSheets(mp4, path.join(outDir, name), from);
log('done:', path.relative(root, mp4));
process.exit(0);

// ---------------------------------------------------------------- helpers
// <name>-social.mp4: the master re-encoded at a capped bitrate (CRF 18, at most 30 Mbit/s: a 2-minute
// 1080p60 reel stays under 450 MB, within X's 512 MB limit; YouTube, LinkedIn and Mastodon take it as
// it is). Tuned to keep the film grain that stops the sky gradients from banding (large dead zones, no
// DCT decimation, dark-biased adaptive quantisation: measured on the opening's sky, 50 % identical
// neighbouring pixels against 88-94 % for a two-pass encode at 16-28 Mbit/s). BT.709 tags kept.
function socialCut(master, mbps) {
  const out = master.replace(/\.mp4$/, '-social.mp4');
  const t0 = Date.now();
  const r = spawnSync('nice', ['-n', '10', FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', master, '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-x264-params', 'aq-mode=3:deadzone-inter=6:deadzone-intra=6:no-dct-decimate=1', '-maxrate', `${mbps}M`, '-bufsize', `${mbps * 2}M`, '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-an', '-movflags', '+faststart', '-threads', '8', out], { stdio: 'inherit' });
  if (r.status !== 0) { log('social cut failed'); return; }
  log(`social cut: ${path.relative(root, out)} (${(fs.statSync(out).size / 1048576).toFixed(0)} MB, at most ${mbps} Mbit/s, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
// a small cut to share (a chat, a social post): 720 px on the short side, 30 fps, H.264 two-pass at the bitrate
// that fits `mb` megabytes (with 4 % to spare for the container)
function previewCut(master, mb) {
  const out = master.replace(/\.mp4$/, '-preview.mp4');
  const t0 = Date.now();
  const probe = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', master], { encoding: 'utf8' });
  let info;
  try { info = JSON.parse(probe.stdout); } catch (e) { log('preview: no probe'); return; }
  const st = info.streams?.[0] || {}, dur = +info.format?.duration || 1;
  const portrait = st.height > st.width;
  const scale = portrait ? 'scale=720:-2:flags=lanczos' : 'scale=-2:720:flags=lanczos';
  const kbps = Math.floor((mb * 8 * 1024 * 0.96) / dur);
  const passlog = out.replace(/\.mp4$/, '.passlog');
  const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', master, '-vf', `fps=30,${scale}`, '-c:v', 'libx264', '-preset', 'slow', '-b:v', `${kbps}k`,
    '-maxrate', `${Math.round(kbps * 1.6)}k`, '-bufsize', `${kbps * 3}k`, '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-passlogfile', passlog,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-an', '-threads', '8'];
  const p1 = spawnSync('nice', ['-n', '10', FFMPEG, ...common, '-pass', '1', '-f', 'mp4', '/dev/null'], { stdio: 'inherit' });
  const p2 = p1.status === 0 ? spawnSync('nice', ['-n', '10', FFMPEG, ...common, '-pass', '2', '-movflags', '+faststart', out], { stdio: 'inherit' }) : p1;
  for (const f of fs.readdirSync(path.dirname(out))) if (f.startsWith(path.basename(passlog))) fs.unlinkSync(path.join(path.dirname(out), f));
  if (p2.status !== 0) { log('preview cut failed'); return; }
  log(`preview: ${path.relative(root, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB, ${kbps} kbit/s, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
function contactSheets(mp4file, base, t0) {
  const dir = mkdirp(base + '-frames');
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', mp4file], { encoding: 'utf8' });
  const m = /, (\d+)x(\d+)[, ]/.exec(probe.stderr || '');
  const portrait = m ? +m[2] > +m[1] : false;
  const tw = portrait ? 216 : 384;
  // exactly the frames at 0, 0.5, 1 ... s (the fps filter would pick the frame nearest to each tile's
  // middle, a quarter of a second off its label)
  const vfps = +((/, ([\d.]+) fps/.exec(probe.stderr || '') || [])[1] || fps);
  const every = Math.max(1, Math.round(vfps / 2));
  const r = spawnSync('nice', ['-n', '10', FFMPEG, '-hide_banner', '-loglevel', 'error', '-i', mp4file, '-vf', `select='not(mod(n\\,${every}))',scale=${tw}:-2`, '-fps_mode', 'vfr', '-start_number', '0', path.join(dir, 'f%04d.png')], { stdio: 'inherit' });
  if (r.status !== 0) { log('frame extraction failed'); return; }
  const py = spawnSync('python3', [path.join(here, 'sheets.py'), dir, base + '.cue.json', base + '-sheet', String(t0), portrait ? '10' : '6', portrait ? '3' : '4'], { stdio: 'inherit' });
  if (py.status !== 0) log('contact sheets failed');
}
function pc(a, p) { return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
function cueMarkdown(cue, file, fps) {
  const f = (x) => { const m = Math.floor(x / 60), s = x - m * 60; return `${m}:${s.toFixed(2).padStart(5, '0')}`; };
  let md = `# three.js Procedural Animals demo reel: cue sheet\n\n${path.basename(file)} · ${cue.total.toFixed(2)} s · ${cue.aspect} · ${fps} fps · every cut on a 120 BPM grid (0.5 s)\n\n`;
  md += '| # | start | dur | shot | species (variants) | what happens | in | out | notes |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
  cue.shots.forEach((s, i) => {
    // cast entries look like "goatA (goat boer, hero)": species plus the variant when there is one
    const vars = {};
    for (const c of s.cast || []) { const m = /\(([a-z]+)(?: ([^,]+))?,/.exec(c); if (m) (vars[m[1]] = vars[m[1]] || new Set()); if (m && m[2]) vars[m[1]].add(m[2]); }
    const sp = s.species.map((x) => (vars[x] && vars[x].size ? `${x} (${[...vars[x]].join(', ')})` : x)).join(', ');
    const prev = cue.shots[i - 1];
    const inT = s.in || (i === 0 ? 'fade in' : prev && prev.transition === 'whip' ? 'whip' : 'cut');
    const outT = i === cue.shots.length - 1 ? 'fade to black' : s.transition;
    md += `| ${s.n} | ${f(s.start)} | ${s.dur} s | ${s.id} | ${sp} | ${s.what} | ${inT} | ${outT} | ${[s.slow !== 1 ? `slow motion (${s.slow})` : '', ...(s.flags || [])].filter(Boolean).join('; ')} |\n`;
  });
  return md;
}

// camera path smoothness, per frame: the acceleration of the camera position (m/s^2, and relative to the
// distance to the look target, 1/s^2: a 1 m/s^2 wobble matters at 0.3 m, not at 30 m) and of the view
// direction (rad/s^2), and the jerk of both (their change per second). Cuts (and the frames next to
// them) and whip pans (deliberate) are skipped.
// A spike is a jolt: a frame whose acceleration stands out from its own neighbourhood (> 3x the median
// of the 6 frames either side, and > 1 / s^2 relative or > 0.5 rad/s^2), the signature of a hitch. A
// sustained, smoothly varying acceleration (an eased push-in, the camera slowing with an animal in a
// slow-motion ramp) is not one; its size shows in the p99 / max figures.
function smoothness(L, fps) {
  const perShot = {};
  const dir = (e) => { const d = [e.l[0] - e.p[0], e.l[1] - e.p[1], e.l[2] - e.p[2]]; const n = Math.hypot(...d) || 1; return d.map((x) => x / n); };
  const rows = []; // [shot, rel, ang, T, acc] per frame, null across cuts and whips
  for (let i = 1; i < L.length - 1; i++) {
    const a = L[i - 1], b = L[i], c = L[i + 1];
    if (b.cut || c.cut || a.shot !== b.shot || b.shot !== c.shot || a.whip || b.whip || c.whip) { rows.push(null); continue; }
    const av = [c.p[0] - 2 * b.p[0] + a.p[0], c.p[1] - 2 * b.p[1] + a.p[1], c.p[2] - 2 * b.p[2] + a.p[2]].map((x) => x * fps * fps);
    const dist = Math.hypot(b.l[0] - b.p[0], b.l[1] - b.p[1], b.l[2] - b.p[2]) || 1;
    const da = dir(a), db = dir(b), dc = dir(c);
    const aw = [dc[0] - 2 * db[0] + da[0], dc[1] - 2 * db[1] + da[1], dc[2] - 2 * db[2] + da[2]].map((x) => x * fps * fps);
    rows.push({ shot: b.shot, T: b.T, av, aw, dist, acc: Math.hypot(...av), rel: Math.hypot(...av) / dist, ang: Math.hypot(...aw) });
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  const all = [], allAng = [], allJerk = [];
  const spikes = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const s = perShot[r.shot] || (perShot[r.shot] = { acc: [], rel: [], ang: [], jerk: [], spikes: 0 });
    s.acc.push(r.acc); s.rel.push(r.rel); s.ang.push(r.ang);
    all.push(r.rel); allAng.push(r.ang);
    const p = rows[i - 1];
    if (p && p.shot === r.shot) {
      const j = Math.hypot(r.av[0] - p.av[0], r.av[1] - p.av[1], r.av[2] - p.av[2]) * fps / r.dist;
      s.jerk.push(j); allJerk.push(j);
    }
    const nb = [], nbA = [];
    for (let k = i - 6; k <= i + 6; k++) { const q = rows[k]; if (k !== i && q && q.shot === r.shot) { nb.push(q.rel); nbA.push(q.ang); } }
    if (nb.length >= 4 && ((r.rel > 1 && r.rel > 3 * med(nb)) || (r.ang > 0.5 && r.ang > 3 * med(nbA)))) { s.spikes++; spikes.push({ T: +r.T.toFixed(3), shot: r.shot, rel: +r.rel.toFixed(2), ang: +r.ang.toFixed(2) }); }
  }
  const st = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? { p50: +pc(s, 0.5).toFixed(3), p99: +pc(s, 0.99).toFixed(3), max: +s[s.length - 1].toFixed(3) } : null; };
  const shots = {};
  for (const [k, v] of Object.entries(perShot)) shots[k] = { acc: st(v.acc), rel: st(v.rel), ang: st(v.ang), jerk: st(v.jerk), spikes: v.spikes };
  return { summary: { rel: st(all), ang: st(allAng), jerk: st(allJerk), spikes: spikes.length }, spikes: spikes.slice(0, 200), shots };
}
