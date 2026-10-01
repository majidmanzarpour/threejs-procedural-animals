// The demo reel (three.js procedural animals): a choreographed, deterministic showcase of every species for the release video.
//
//   dist/showcase.html?demo                 play the reel live (builds every animal first, then plays)
//   &aspect=9:16 | 1:1 | 4:5                social crops (default 16:9); &res=1080 caps the render height
//   &only=cheetah,horse                     only the shots featuring these species (ids or shot ids)
//   &shots=3-7,12  |  &from=40              preview parts: shot numbers / ids, or a start time (s)
//   &loop  &wait (start on a key / click)  &hud (frame times, shot, time)  &speed=0.5  &tod=0.95
//   &titles=0 (clean plates)  &repo=github.com/you/repo (the end card's repository line; &repo= : none)
//   &seed=7  &skywarm=0..1
//   &profile=live|record                    live (default in a browser): fur capped at 'high', FXAA, the
//                                           scene at &scale=0.8, fur tier adapted at cuts (&adapt=0: off);
//                                           record: the cast's own tiers (hero close-ups), 4x MSAA
//   &cap=hero|high|medium  &msaa=0|4  &quality=<tier for every actor>
//   &record ...                             driven frame by frame by showcase/record.mjs
// Live keys: Space pause, Left / Right previous / next shot, R restart, H HUD, F fullscreen.
// Console: __demo.stats() (frame times), __demo.cue() (cue sheet), __demo.seek(T).
//
// SHOT LIST FORMAT (showcase/src/demoShots.js; every number there can be tweaked):
//   {
//     id: 'cheetah-sprint',        unique id (&shots=cheetah-sprint)
//     dur: 4,                      length in seconds, a multiple of 0.5 (120 BPM: every cut on a beat)
//     pre: 2,                      seconds the cast is simulated before the cut (it is already running);
//                                  dropped (flagged in the cue sheet) when the previous shot shows one of
//                                  its actors: give the shot a second instance of the animal instead
//     cast: ['cheetah'],           actor keys (CAST in demoShots.js: species, seed, quality, variant, sex,
//                                  age, layers: { mesh: tier } for the "how it's made" layers)
//     keep: true,                  the cast carries on from the previous shot (no re-placing)
//     what: '...',                 one line for the cue sheet
//     title: { actor, at, dur, name } | 'open' | 'end' | null   (name: else NAMES[species] in demoShots.js)
//     caption(S) -> { t, dur, stageT, titleA, title }   "how it's made": one short word for the layer
//     setup(S) {...}               place the cast (S.place(k, x, z, heading)), start moves (S.move /
//                                  S.gear / S.play / S.look / S.input); runs when the pre-roll starts
//     update(S) {...}              per frame: S.t is shot time (negative in the pre-roll), S.at(t, fn)
//     reveal(S) {...}              per frame, while on screen: S.layers(k).set({ prims, clay, wire,
//                                  weights, xray, skel, coat }) with wipes (demoLayers.js)
//     cam(S) -> CamPose            S.orbit({ actor, frame: 'heading' | 'sun' | 'world', headingFrom: 'start',
//                                  pivot: 'start' (tripod), lookAt: 'start' (locked off), anchor: 'ground'
//                                  (leaps inside a steady frame), a: {az, el, d | fit, fov, head, y, lead,
//                                  side}, b: {...}, ease }) | S.path({ actor, keys: [{ t | u, az, el, ...,
//                                  ly }] }) (C1 spline) | S.fixed({ pos, pos1, relGround, actor | look,
//                                  look1, fov, fov1, ease })
//     titleDur (s: the opening title's length when shorter than the shot),
//     tod, exposure (number | t => k: an iris ramp), bloom, warm, skyGrad (number | t => k),
//     skyWarm (0..1 | t => k: the sunset band on the visible sky), clouds (cloud cover of the visible
//     sky, 0..1), dim (t => 0..1: stage dusk for reveals),
//     slow (k | t => k: animal time scale, speed ramps), track (camera follow softness, 1 = default;
//     ptrack: the same for portrait crops),
//     fadeIn / fadeOut (s) | fade (t => 0..1), whipIn / whipOut ({ dir: 1 | -1, d: 0.25 }),
//     grass ({ actor, r, k, scale }: a mown clearing / shorter grass), water (clarity; > 0 also turns on
//     the look's underwater light, LOOK.water: absorption, the water's colour, caustics on the bed), bed
//     (sandy lake bed), focus (S => Vector3: grass / terrain / shadow centre), shadow (m), camClear (m),
//     wide (share of the horizontal field portrait crops keep), pfit (portrait crops: camera distance
//     factor for orbit / path shots), plead (portrait crops: lead room factor, default 0.6), portrait (false | { horizon, tilt, share, maxEl }: portrait crops
//     bring the horizon up to `horizon` of the frame height, see Director.recompose), live ({ tier, scale }: live profile
//     hints for heavy shots),
//     look (overrides of the reel's LOOK: sky grade, haze, hills, bounce fill, post grade), fill (the
//     cast's bounce light, number | t => k), shade (the sun's shadow strength, number | t => k),
//     titleStart / titleY (the opening title's start time and height)
//   }
import * as THREE from 'three';
import { listSpecies, loadSpecies, buildAnimalData } from '../../src/index.js';
import { describe, headPosition, footPositions, bodyCenter } from './subject.js';
import { gaitTable } from './pilot.js';
import { DemoPost } from './demoPost.js';
import { Titles, FONTS } from './demoTitles.js';
import { Tracker, AngleTracker, CamPose, applyPose, ease, easeOf, tween, fitDistance, fovFor, smax, clamp, lerp, envelope, forward, left, angLerp } from './demoCamera.js';
import { CAST, SHOTS, END_CARD, LOOK, NAMES } from './demoShots.js';
import { Layers, patchCoat, WATER_UNIFORMS } from './demoLayers.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ options
function parseOptions(params) {
  const asp = (params.get('aspect') || '16:9').split(':').map(Number);
  const aspect = asp.length === 2 && asp[0] > 0 && asp[1] > 0 ? asp[0] / asp[1] : 16 / 9;
  const list = (k) => (params.get(k) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const o = {
    record: params.has('record'),
    aspect, aspectName: params.get('aspect') || '16:9',
    w: +params.get('w') || 0, h: +params.get('h') || 0,
    res: +params.get('res') || 1080,
    ss: clamp(+(params.get('ss') || 1), 1, 2),
    only: list('only'), shots: list('shots'), from: +(params.get('from') || 0),
    loop: params.has('loop'), wait: params.has('wait'), hud: params.has('hud'),
    speed: +(params.get('speed') || 1), tod: params.has('tod') ? +params.get('tod') : null,
    titles: params.get('titles') !== '0', repo: params.get('repo') ?? END_CARD.repo,
    seed: +(params.get('seed') || 7), quality: params.get('quality') || '',
    fps: +(params.get('fps') || 60),
    skyWarm: params.has('skywarm') ? +params.get('skywarm') : null,
  };
  // profiles: 'record' (offline, record.mjs): the cast's own quality (hero close-ups), MSAA 4x.
  // 'live' (a browser): at most 'high' quality animals and FXAA instead of MSAA (the fur shells are
  // the frame's cost; see the README). &profile=, &msaa=, &quality= override.
  o.profile = params.get('profile') || (o.record ? 'record' : 'live');
  o.msaa = params.has('msaa') ? +params.get('msaa') : o.profile === 'record' ? 4 : 0;
  o.qualityCap = params.get('cap') || (o.profile === 'record' ? 'hero' : 'high');
  // live: the scene renders at this scale of the output (upsampled, FXAA) and the fur's shell count
  // adapts at the cuts to hold the frame rate (&adapt=0 turns that off)
  o.scale = +(params.get('scale') || (o.profile === 'record' ? 1 : 0.8));
  o.adapt = o.profile === 'live' && params.get('adapt') !== '0';
  return o;
}

// Determinism: the reel is recorded chain by chain, each from a seek, and previewed shot by shot, so a
// chain must play the same whatever ran before it. Math.random (blinks, glances, dust) is re-seeded at
// every seek to a chain's start, and an animal placed by a shot gets a fresh idle-behaviour generator
// (motion.rand) seeded from the actor and the shot.
const hashStr = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; };
const xorshift = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
// a seeded Math.random: blinks, dust and anything else that rolls dice on the main thread repeat exactly
function seedRandom(seed) {
  let s = seed >>> 0 || 1;
  Math.random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_CSS = `
body.demo #title, body.demo #topRight, body.demo #panel, body.demo #dock, body.demo #gaitCard, body.demo #perf,
body.demo #vignette, body.demo #toast, body.demo #joy, body.demo #climb, body.demo #split { display: none !important; }
body.demo, body.demo #app { background: #000; }
body.demo canvas#gl { position: absolute; inset: auto; left: 50%; top: 50%; transform: translate(-50%, -50%); }
body.demo.demoCursor canvas#gl { cursor: none; }
#demoHud { position: absolute; left: 12px; top: 12px; z-index: 20; font: 500 12px/1.45 "JetBrains Mono", ui-monospace, monospace; color: #f3ebdd;
  background: rgba(10,8,6,.62); padding: 8px 10px; border-radius: 8px; white-space: pre; pointer-events: none; }
#loader .demoList { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px 12px; margin: 14px 0 16px; font-size: 12px; }
#loader .demoList span { color: rgba(243,235,221,.32); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#loader .demoList span.on { color: var(--paper); }
#loader .demoList span.ok { color: var(--dust); }
#loader .demoCount { font-family: var(--mono); font-size: 12px; color: var(--dust); margin-top: 8px; }
#loader .demoGo { margin-top: 16px; font-size: 13px; color: var(--paper); letter-spacing: .12em; text-transform: uppercase; }
`;

// ------------------------------------------------------------------ entry
export async function runDemo(ctx) {
  const { renderer, scene, camera, world, contact, canvas, params } = ctx;
  const opts = parseOptions(params);
  seedRandom(opts.seed);
  const style = document.createElement('style');
  style.textContent = DEMO_CSS;
  document.head.appendChild(style);
  document.body.classList.add('demo');
  window.__demo = { ready: false, error: null };

  // ---- output size
  const stage = { w: 0, h: 0, cssW: 0, cssH: 0 };
  const sizeStage = () => {
    let W, H;
    if (opts.w && opts.h) { W = opts.w; H = opts.h; }
    else if (opts.record) { W = window.innerWidth; H = window.innerHeight; }
    else {
      // live: fit the aspect into the window; the drawing buffer at the device pixel ratio, capped at &res
      const ww = window.innerWidth, wh = window.innerHeight;
      let cw = ww, ch = ww / opts.aspect;
      if (ch > wh) { ch = wh; cw = wh * opts.aspect; }
      stage.cssW = Math.floor(cw); stage.cssH = Math.floor(ch);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      H = Math.min(Math.round(ch * dpr), opts.aspect >= 1 ? opts.res : Math.round(opts.res / opts.aspect));
      W = Math.round(H * opts.aspect);
    }
    if (opts.record || (opts.w && opts.h)) {
      // exact output size (record.mjs sets the viewport to it)
      const a = opts.aspect;
      if (Math.abs(W / H - a) > 0.01 && !(opts.w && opts.h)) { if (W / H > a) W = Math.round(H * a); else H = Math.round(W / a); }
      stage.cssW = W; stage.cssH = H;
    }
    W -= W % 2; H -= H % 2; // H.264 needs even sizes
    stage.w = W; stage.h = H;
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    canvas.style.width = stage.cssW + 'px';
    canvas.style.height = stage.cssH + 'px';
  };
  sizeStage();
  const post = new DemoPost(renderer, stage.w, stage.h, { ss: opts.ss * opts.scale, samples: opts.msaa, fxaa: opts.msaa === 0 });
  // film grain (code values, mid tones) and its size (px): &grain=, &grainpx=
  if (params.has('grain')) post.uniforms.uGrain.value = +params.get('grain');
  if (params.has('grainpx')) post.uniforms.uGrainPx.value = Math.max(1, +params.get('grainpx'));
  const titles = new Titles(stage.w, stage.h);
  post.setTitles(opts.titles ? titles.texture : null);
  window.addEventListener('resize', () => {
    if (opts.record || (opts.w && opts.h)) return;
    sizeStage(); post.setSize(stage.w, stage.h); titles.setSize(stage.w, stage.h); post.setTitles(opts.titles ? titles.texture : null);
  });

  // ---- the sky: the showcase tames the sun disc (a white blob on screen); the reel's bloom wants a real
  // HDR sun (it is orange at sunset: the disc is the extinction-tinted sun radiance)
  patchSky(world.env);
  // the water rings (a fish breaking the surface, a frog's hop): the showcase's are a bright white, a
  // blown-out arc in the reel's evening light
  const rip = world.env.ripples?.uniforms;
  if (rip && LOOK.ripples) { rip.uColor.value.setRGB(LOOK.ripples[0], LOOK.ripples[1], LOOK.ripples[2]); rip.uAlpha.value = LOOK.ripples[3]; }

  // ---- species facts (names, latin, variants)
  const meta = {};
  await Promise.all(listSpecies().map(async (id) => {
    try { const s = await loadSpecies(id); meta[id] = { id, name: s.name || id, latin: s.latin || '', group: s.group || 'others', plan: s.plan, variants: s.variants || [] }; } catch (e) { console.warn('demo: species', id, e); }
  }));

  // ---- timeline
  const timeline = compileTimeline(SHOTS, CAST, meta, opts);
  if (!timeline.shots.length) throw new Error('demo: no shots match ' + JSON.stringify({ only: opts.only, shots: opts.shots }));

  // ---- loader
  const loader = setupLoader(timeline);
  try { await Promise.race([Promise.all(FONTS.map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 6000))]); } catch (e) { /* fallback fonts */ }

  // ---- cast
  const actors = {};
  const keys = timeline.actorKeys;
  let done = 0;
  const queue = keys.slice();
  const buildOne = async (key) => {
    const c = CAST[key];
    loader.on(key);
    const t0 = performance.now();
    const TIERS = ['hero', 'high', 'medium', 'low', 'crowd'];
    let quality = opts.quality || c.quality || 'high';
    if (!opts.quality && TIERS.indexOf(quality) < TIERS.indexOf(opts.qualityCap)) quality = opts.qualityCap;
    const a = await ctx.build(c.species, ctx.animalOpts(null, {
      seed: c.seed ?? 1, quality, variant: c.variant, sex: c.sex, age: c.age ?? 'adult',
      position: new THREE.Vector3(0, world.ground(0, 0), 0), heading: 0, onProgress: () => {},
    }));
    a.object.visible = false;
    a.object.userData.demoActor = key;
    scene.add(a.object);
    patchCoat(a);
    const info = describe(a);
    const actor = { key, def: c, animal: a, info, gaits: gaitTable(a, info), meta: meta[c.species] || {}, buildMs: performance.now() - t0 };
    actor.track = { g: new Tracker(4, 3), c: new Tracker(3, 2.5), h: new Tracker(4.5, 3.5), hd: new AngleTracker(2.2) };
    if (c.layers) {
      // the clay / wire / weights layer can use a lighter build of the same individual (the skeleton is
      // the same for every tier): a readable wireframe
      const lo = c.layers.mesh && c.layers.mesh !== quality ? await buildAnimalData(c.species, { seed: c.seed ?? 1, quality: c.layers.mesh, variant: c.variant, sex: c.sex, age: c.age ?? 'adult' }) : null;
      actor.layers = new Layers(scene, a, info, { overlay: post.overlay, mesh: lo || undefined });
    }
    if (c.castShadow === false) a.object.traverse((o) => { o.castShadow = false; });
    actors[key] = actor;
    ctx.syncLighting(a);
    loader.ok(key, ++done, keys.length);
  };
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (queue.length) {
      const key = queue.shift();
      try { await buildOne(key); } catch (e) { console.error('demo: build failed', key, e); loader.fail(key); done++; }
    }
  });
  await Promise.all(workers);
  // a species that failed to build: its shots go, the reel closes up around them
  const failed = keys.filter((k) => !actors[k]);
  if (failed.length) {
    const ok = Object.fromEntries(Object.entries(CAST).filter(([k]) => actors[k]));
    Object.assign(timeline, compileTimeline(SHOTS, ok, meta, opts));
    console.warn('demo: built without', failed.join(', '));
  }

  // ---- environment maps for every time of day in the reel (switching at a cut costs nothing then)
  loader.status('Lighting the scene');
  const env = world.env;
  // sharper sky reflections on the lake (the showcase's 128 px maps show as a blocky mosaic at 1080p)
  env.envSize = Math.max(env.envSize || 128, opts.record ? 512 : 256);
  // two maps per time of day: the physical sky lights the scene (as in the showcase), the graded sky
  // (the one on screen) is what the lake reflects
  setSkyGrade(env.sky.material.uniforms, LOOK.sky);
  const envMaps = new Map(), reflMaps = new Map();
  const todOf = (shot) => (opts.tod != null ? opts.tod : shot.tod ?? 0.955);
  const gradeU = env.envSky?.material?.uniforms?.uSkyGrade;
  const makeMaps = (tod) => {
    if (gradeU) gradeU.value = 0;
    env.setTimeOfDay(tod, true);
    envMaps.set(tod, env.envRT);
    env.envRT = null; // keep it (setTimeOfDay would dispose it)
    if (gradeU) { gradeU.value = 1; env.setTimeOfDay(tod, true); reflMaps.set(tod, env.envRT); env.envRT = null; gradeU.value = 0; } else reflMaps.set(tod, envMaps.get(tod));
  };
  for (const sh of timeline.shots) { const tod = todOf(sh); if (!envMaps.has(tod)) makeMaps(tod); }
  // the animals' share of the sky's diffuse light (environment.js updateEnvLight / makeAnimalLight: the
  // showcase reads it back asynchronously whenever the hour changes): one probe per time of day, awaited
  // here, so that nothing lands in the middle of the reel (a recording must be deterministic).
  // &envlight=0: off (the look before it)
  const envSH = new Map();
  const useEnvLight = !!env.updateEnvLight && params.get('envlight') !== '0';
  const probeLight = (tod) => new Promise((res) => {
    if (gradeU) gradeU.value = 0;
    env.setTimeOfDay(tod, false);
    scene.environmentIntensity = 0.18;
    const timer = setTimeout(() => { env.onLight = null; res(null); }, 10000);
    env.onLight = () => { clearTimeout(timer); env.onLight = null; res(env.envSH); };
    env.updateEnvLight();
  });
  if (useEnvLight) for (const tod of envMaps.keys()) { const sh = await probeLight(tod); if (sh) envSH.set(tod, sh); }
  env.onLight = null;
  if (!useEnvLight) { env.envSH = null; env.animalSH = null; }
  let curTod = null;
  const setTod = (tod) => {
    if (tod === curTod) return;
    curTod = tod;
    if (!envMaps.has(tod)) makeMaps(tod); // (probes)
    env.setTimeOfDay(tod, false);
    env._base = { sun: env.sun.intensity, hemi: env.hemi.intensity };
    if (envSH.has(tod)) env.envSH = envSH.get(tod);
    scene.environment = envMaps.get(tod).texture;
    if (world.water?.mesh?.material) world.water.mesh.material.envMap = reflMaps.get(tod).texture;
    scene.environmentIntensity = 0.18;
    for (const k in actors) ctx.syncLighting(actors[k].animal);
  };

  // ---- director
  const D = new Director({ ...ctx, opts, stage, post, titles, timeline, actors, setTod, todOf, meta });
  window.__demo.director = D;

  // ---- warm up: every actor and layer is drawn once (buffers uploaded, programs compiled) before the reel
  loader.status('Warming up the GPU');
  await D.warmUp((i, n) => loader.progress(0.9 + 0.1 * (i / n)));

  // ---- go
  const api = window.__demo;
  Object.assign(api, {
    ready: true, total: timeline.total, fps: opts.fps,
    shots: timeline.shots.map((s) => ({ id: s.id, start: s.start, dur: s.dur, keep: !!s.keep, species: s.speciesList, what: s.what || '' })),
    cue: () => D.cueSheet(),
    seek: (T) => D.seek(T),
    step: (dt) => { D.advance(dt); D.render(); return D.T; },
    frameAt: (T) => { D.seek(T); D.render(); return D.T; },
    camLog: () => D.camLog,
    stats: () => D.liveStats(),
    liveLog: () => ({ log: D.live.log, shots: D.shots.map((s) => s.id) }),
    size: () => ({ w: stage.w, h: stage.h }),
    // read the canvas back and POST it (record.mjs saves it as <name>.png)
    snap: async (name) => {
      const gl = renderer.getContext();
      const buf = new Uint8Array(stage.w * stage.h * 4);
      gl.readPixels(0, 0, stage.w, stage.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      await fetch('/still?name=' + encodeURIComponent(name), { method: 'POST', body: buf });
    },
  });
  loader.close(opts.record);
  if (opts.record) return; // record.mjs drives the frames
  D.seek(opts.from || 0);
  if (opts.wait) { loader.wait(); await new Promise((r) => { const go = () => { window.removeEventListener('keydown', go); window.removeEventListener('pointerdown', go); r(); }; window.addEventListener('keydown', go); window.addEventListener('pointerdown', go); }); loader.close(false); }
  D.startLive();
}

// The sky model (Preetham) leaves a low sun in a pale, white haze. The reel's sky gets a sunset band:
// the horizon warms towards the sun (uSkyWarm 0..1, per shot: skyWarm) and fades into the model's
// own blue overhead. Only the visible sky: the image-based lighting keeps the physical sky.
// the look's sky grade (LOOK.sky) into the patched sky's uniforms
function setSkyGrade(u, s, { gain = s.gain, warm = s.warm } = {}) {
  if (!u.uSkyKnee) return;
  u.uSkyGain.value = gain;
  u.uSkyWarm.value = warm;
  u.uSkyKnee.value = s.knee;
  u.uSkyLow.value.setRGB(...s.low);
  u.uSkyHigh.value.setRGB(...s.high);
  u.uSkySat.value = s.sat;
  u.uDiscMax.value = s.disc;
  u.uHalo.value.set(...s.halo);
  u.uHaloColor.value.setRGB(...s.haloColor);
  if (s.warmTint) u.uWarmTint.value.setRGB(...s.warmTint);
}

function patchSky(env) {
  patchSkyMaterial(env.sky?.material);
  // the image-based light and the water's reflections see the same graded sky (sharing its uniforms)
  if (env.sky?.material && env.envSky?.material) patchSkyMaterial(env.envSky.material, env.sky.material.uniforms);
}
function patchSkyMaterial(m, share = null) {
  if (!m || m.uniforms.uSunDisc) return;
  m.uniforms.uSunDisc = { value: 420 };
  m.uniforms.uSkyGain = { value: 0.9 };
  m.uniforms.uSkyWarm = { value: 0 };
  m.uniforms.uWarmTint = { value: new THREE.Color(1.0, 0.58, 0.3) };
  // the reel's one evening look, whatever way the camera faces (demoLook): the Mie glow of a low sun is
  // compressed under a soft ceiling (no white plateau round the sun: the disc alone stays hot, for the
  // bloom's halo), the sky is tinted warm at the horizon and a muted teal overhead, and its blue is
  // desaturated (the sky facing away from a setting sun would otherwise read as a blue midday sky)
  m.uniforms.uSkyKnee = { value: 0 };
  m.uniforms.uSkyLow = { value: new THREE.Color(1, 1, 1) };
  m.uniforms.uSkyHigh = { value: new THREE.Color(1, 1, 1) };
  m.uniforms.uSkySat = { value: 1 };
  m.uniforms.uDiscMax = { value: 1e6 };
  // an analytic halo round the sun (the glow the compression takes away, shaped): a hot core that feeds
  // the bloom and a broad warm aureole; x: core strength, y: core width (rad), z: aureole, w: its width
  m.uniforms.uHalo = { value: new THREE.Vector4(0, 0.02, 0, 0.15) };
  m.uniforms.uHaloColor = { value: new THREE.Color(1.0, 0.72, 0.42) };
  if (share) for (const k of ['uSunDisc', 'uSkyGain', 'uSkyWarm', 'uWarmTint', 'uSkyKnee', 'uSkyLow', 'uSkyHigh', 'uSkySat', 'uDiscMax', 'uHalo', 'uHaloColor']) m.uniforms[k] = share[k];
  m.uniforms.uSkyGrade = { value: share ? 0 : 1 };
  let fs = m.fragmentShader;
  fs = fs.replace(/\b\d+(\.\d+)?\s*\*\s*sundisc\b/, 'uSunDisc * sundisc');
  fs = fs.replace('void main() {', 'uniform float uSunDisc;\nuniform float uSkyGain;\nuniform float uSkyWarm;\nuniform vec3 uWarmTint;\nuniform float uSkyKnee;\nuniform vec3 uSkyLow;\nuniform vec3 uSkyHigh;\nuniform float uSkySat;\nuniform float uDiscMax;\nuniform vec4 uHalo;\nuniform vec3 uHaloColor;\nuniform float uSkyGrade;\nvoid main() {');
  fs = fs.replace(/gl_FragColor = vec4\( *texColor, 1\.0 *\);/, `if ( uSkyGrade > 0.5 ) {
      float hz = 1.0 - smoothstep( -0.03, 0.45, direction.y );
      vec2 dh = normalize( direction.xz + vec2( 1e-5 ) ), sh = normalize( vSunDirection.xz + vec2( 1e-5 ) );
      float side = 0.5 + 0.5 * dot( dh, sh );
      float glow = smoothstep( 0.5, 1.0, cosTheta );
      float w = uSkyWarm * clamp( hz * hz * mix( 0.3, 1.0, side * side ) + 0.75 * glow * glow, 0.0, 1.0 );
      // the disc (kept apart: it feeds the bloom) and the sky round it; its ceiling scales the colour
      // (a ceiling per channel turned the orange setting sun into a white disc)
      float dm = max( max( sundiscColor.r, sundiscColor.g ), max( sundiscColor.b, 1e-4 ) );
      vec3 disc = sundiscColor * min( 1.0, uDiscMax / dm );
      vec3 sky = max( texColor - sundiscColor, vec3( 0.0 ) );
      sky *= mix( vec3( 1.0 ), uWarmTint, w );
      float L = dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) );
      if ( uSkyKnee > 0.0 ) sky *= 1.0 / ( 1.0 + L / uSkyKnee );
      float el = clamp( direction.y, 0.0, 1.0 );
      sky *= mix( uSkyLow, uSkyHigh, smoothstep( 0.0, 0.32, el ) );
      float Ls = dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) );
      sky = max( mix( vec3( Ls ), sky, uSkySat ), vec3( 0.0 ) );
      float ang = acos( clamp( cosTheta, -1.0, 1.0 ) );
      float hv = smoothstep( -0.02, 0.02, direction.y ); // (not below the horizon line)
      sky += uHaloColor * ( uHalo.x * exp( -ang / uHalo.y ) + uHalo.z * exp( -ang / uHalo.w ) ) * hv;
      texColor = sky + disc;
    }
    gl_FragColor = vec4( texColor * ( uSkyGrade > 0.5 ? uSkyGain : 1.0 ), 1.0 );`);
  m.fragmentShader = fs;
  m.needsUpdate = true;
}

// ------------------------------------------------------------------ timeline
function compileTimeline(allShots, cast, meta, opts) {
  const matches = (sh, i) => {
    if (opts.shots.length) {
      return opts.shots.some((q) => {
        const m = /^(\d+)-(\d+)$/.exec(q);
        if (m) return i + 1 >= +m[1] && i + 1 <= +m[2];
        if (/^\d+$/.test(q)) return i + 1 === +q;
        return sh.id === q;
      });
    }
    if (opts.only.length) return opts.only.some((q) => sh.id === q || sh.id.startsWith(q + '-') || (sh.cast || []).some((k) => cast[k]?.species === q || k === q));
    return true;
  };
  const shots = [];
  let T = 0;
  allShots.forEach((sh, i) => {
    if (!matches(sh, i)) return;
    const s = { ...sh, index: i, start: T, cast: (sh.cast || []).filter((k) => cast[k] && meta[cast[k].species]) };
    if ((sh.cast || []).length && !s.cast.length) { console.warn('demo: skipping', sh.id, '(no cast)'); return; }
    s.speciesList = [...new Set(s.cast.map((k) => cast[k].species))];
    // a shot that keeps the previous shot's cast only does so when that shot is in this timeline
    if (s.keep && !(shots.length && shots[shots.length - 1].index === i - 1)) s.keep = false;
    // a pre-roll would re-place an actor the previous shot still shows: start it at the cut instead
    // (give the shot a clone of the actor, same seed, to keep the pre-roll)
    const prev = shots[shots.length - 1];
    if (!s.keep && prev && (s.pre ?? 1) > 0) {
      const shared = s.cast.filter((k) => prev.cast.includes(k));
      if (shared.length) { console.warn(`demo: ${s.id} shares ${shared.join(', ')} with ${prev.id}: no pre-roll`); s.pre = 0; (s.flags = new Set()).add('pre-roll dropped (shares ' + shared.join(', ') + ')'); }
    }
    shots.push(s);
    T += s.dur;
  });
  // species numbering in title order (01 / 24 ...)
  const order = [];
  for (const s of allShots) {
    const k = s.title && typeof s.title === 'object' ? s.title.actor : null;
    const sp = k && cast[k] ? cast[k].species : null;
    if (sp && !order.includes(sp)) order.push(sp);
  }
  const actorKeys = [...new Set(shots.flatMap((s) => s.cast))];
  return { shots, total: T, actorKeys, speciesOrder: order };
}

// ------------------------------------------------------------------ loader UI
function setupLoader(timeline) {
  const L = $('loader');
  L.hidden = false;
  L.classList.remove('done');
  const box = L.querySelector('.box');
  const keys = timeline.actorKeys;
  box.innerHTML = `
    <div class="eyebrow">three.js · demo reel</div>
    <h1><i>Procedural animals</i></h1>
    <p>Building ${keys.length} animals from signed distance fields, right here in your browser. Nothing is downloaded: every body, coat and motion is generated in code.</p>
    <div class="demoList">${keys.map((k) => `<span data-k="${k}">${k}</span>`).join('')}</div>
    <div class="lbar"><i id="loadBar"></i></div>
    <div class="demoCount" id="demoCount">0 / ${keys.length}</div>
    <div id="err"></div>`;
  const bar = box.querySelector('#loadBar'), count = box.querySelector('#demoCount');
  const span = (k) => box.querySelector(`.demoList span[data-k="${CSS.escape(k)}"]`);
  return {
    on: (k) => { const s = span(k); if (s) s.className = 'on'; },
    ok: (k, i, n) => { const s = span(k); if (s) s.className = 'ok'; bar.style.width = Math.round((i / n) * 90) + '%'; count.textContent = `${i} / ${n}`; },
    fail: (k) => { const s = span(k); if (s) { s.className = ''; s.style.textDecoration = 'line-through'; } },
    status: (t) => { count.textContent = t; },
    progress: (p) => { bar.style.width = Math.round(p * 100) + '%'; },
    wait: () => { count.innerHTML = '<div class="demoGo">Press any key to play</div>'; L.classList.remove('done'); L.hidden = false; },
    close: (instant) => {
      if (instant) { L.hidden = true; return; }
      L.classList.add('done');
      setTimeout(() => { L.hidden = true; }, 900);
    },
  };
}

// ------------------------------------------------------------------ director
class Director {
  constructor(o) {
    Object.assign(this, o);
    this.T = 0;
    this.worldTime = 0;
    this.cur = -1;
    this.pose = new CamPose();
    this.prevPose = new CamPose();
    this.aspect = o.stage.w / o.stage.h;
    this.running = new Map(); // shot index -> run state (setup done, cue flags)
    this.camLog = [];
    this.frameN = 0;
    this.focus = new THREE.Vector3();
    this.push = [];
    this.contactEntries = [];
    this._feet = [];
    this.live = { dts: [], works: [], hud: null, paused: false };
    this.sunAz = 0;
    this.warn = new Set();
    this.liveTier = o.opts.adapt ? 1 : 0;
  }

  get shots() { return this.timeline.shots; }
  // the shot on screen at T (never before minShot: after a seek the pre-roll of the target shot
  // overlaps the end of the previous one, which must not start)
  shotAt(T) {
    const S = this.shots;
    for (let i = this.minShot || 0; i < S.length; i++) if (T < S[i].start + S[i].dur - 1e-6) return i;
    return S.length - 1;
  }

  // ---------------------------------------------------------------- warm up
  async warmUp(onProgress) {
    const { renderer, scene, camera, post, actors } = this;
    const list = Object.values(actors);
    const tods = [...new Set(this.shots.map((s) => this.todOf(s)))];
    this.setTod(tods[0]);
    // the look first: it switches the hills' material (a program change) before anything is compiled
    this.applyLook(this.lookOf(this.shots[0]), this.shots[0], 0, 0);
    let i = 0;
    for (const A of list) {
      const a = A.animal;
      const p = new THREE.Vector3(0, this.world.ground(0, 0), 0);
      a.motion.reset?.(p, 0);
      a.update(1 / 60);
      a.object.visible = true;
      if (A.layers) A.layers.warm(true);
      const R = Math.max(0.05, A.info.span * 0.6);
      camera.position.set(R * 2.2, p.y + A.info.height * 0.6 + R * 0.4, R * 2.2);
      camera.lookAt(0, p.y + A.info.height * 0.5, 0);
      camera.near = Math.max(0.002, R * 0.05); camera.far = 6000; camera.updateProjectionMatrix();
      this.world.update(p, 0, 0, camera, []);
      post.render(scene, camera);
      if (A.layers) A.layers.warm(false);
      a.object.visible = false;
      if (++i % 3 === 0) { onProgress(i, list.length); await new Promise((r) => setTimeout(r, 0)); }
    }
    // every layer mode once more, together (the transparent passes, the wipe variants)
    renderer.getContext().finish?.();
    onProgress(1, 1);
  }

  // ---------------------------------------------------------------- shot context (the API shots use)
  ctxFor(shot, run) {
    const D = this;
    const S = {
      D, shot, run, world: this.world, THREE,
      get t() { return run.t; }, get dt() { return run.dt; }, get u() { return clamp(run.t / shot.dur, 0, 1); },
      get sunAz() { return D.sunAz; }, get sunDir() { return D.world.env.sunDir; },
      get portrait() { return D.aspect < 0.95; }, // (a 9:16 / 4:5 crop: shots may stage a tighter group)
      A: (k) => D.actors[k],
      a: (k) => D.actors[k]?.animal,
      info: (k) => D.actors[k]?.info,
      has: (k, action) => !!D.actors[k]?.animal?.actions?.includes(action),
      gear(k, ...names) {
        const A = D.actors[k];
        if (!A) return 0;
        const g = A.animal.gears || {};
        for (const n of names) if (Number.isFinite(g[n]) && g[n] > 0) return g[n];
        const list = A.gaits.list;
        return list.length ? list[list.length - 1].speed : 1;
      },
      ground: (x, z) => D.world.ground(x, z),
      place(k, x, z, heading = 0, y = null) {
        const A = D.actors[k];
        if (!A) return;
        const a = A.animal;
        a.stopAction?.();
        a.move({ speed: 0, heading });
        a.lookAt(null);
        if (a.motion.input) { a.motion.input.howl = false; a.motion.input.crouch = 0; }
        const p = new THREE.Vector3(x, y ?? D.world.ground(x, z), z);
        a.motion.reset?.(p, heading);
        if (typeof a.motion.rand === 'function') a.motion.rand = xorshift(hashStr(`${k}@${shot.id}#${D.opts.seed}`));
        A.placedAt = run.t;
        A.resetTrack = true;
      },
      move(k, speed, heading, climb = 0, gait) { const a = D.actors[k]?.animal; if (a) a.move({ speed, heading: heading ?? a.heading, climb, gait }); },
      moveTo(k, p, speed) { const a = D.actors[k]?.animal; if (a) a.moveTo(p, { speed }); },
      play(k, name, o = {}) {
        const a = D.actors[k]?.animal;
        if (!a) return false;
        const base = name === 'idle' ? true : a.actions?.includes(name);
        if (!base) { const w = `${k}:${name}`; if (!D.warn.has(w)) { D.warn.add(w); console.warn('demo: no action', w); } return false; }
        try { const r = a.play(name, o); r?.catch?.(() => {}); } catch (e) { console.warn('demo: play failed', k, name, e); return false; }
        return true;
      },
      stop(k, name) { D.actors[k]?.animal?.stopAction?.(name); },
      look(k, p) { D.actors[k]?.animal?.lookAt(p || null); },
      input(k, key, v) { const a = D.actors[k]?.animal; if (a?.motion?.input) a.motion.input[key] = v; },
      // fire fn once when shot time passes `time` (the pre-roll has negative times)
      at(time, fn) {
        const key = 'at' + time + ':' + (fn.name || fn.toString().length);
        if (run.fired.has(key)) return;
        if (run.t >= time) { run.fired.add(key); fn(); }
      },
      sub: (k) => D.subject(k),
      // a world point at azimuth az (deg, from the actor's heading), distance d (m), height y above its ground
      camPoint(k, az, d, y) { const a = D.actors[k]?.animal; if (!a) return null; const h = a.heading + az * DEG; return new THREE.Vector3(a.position.x + Math.sin(h) * d, a.position.y + y, a.position.z + Math.cos(h) * d); },
      // camera helpers
      orbit: (spec) => D.camOrbit(S, spec),
      path: (spec) => D.camPath(S, spec),
      fixed: (spec) => D.camFixed(S, spec),
      layers: (k) => D.actors[k]?.layers,
    };
    return S;
  }

  // the tracked frame of an actor (updated after every simulation step)
  subject(k) {
    const A = this.actors[k];
    if (!A) return null;
    return A.frame;
  }

  // ---------------------------------------------------------------- shot lifecycle
  runFor(i) {
    let run = this.running.get(i);
    if (!run) {
      run = { t: -Infinity, dt: 0, fired: new Set(), setupDone: false, state: {} };
      this.running.set(i, run);
    }
    return run;
  }

  startShot(i, t) {
    const shot = this.shots[i];
    const run = this.runFor(i);
    run.t = t; run.dt = 0; run.fired = new Set(); run.setupDone = true; run.state = {};
    run.S = this.ctxFor(shot, run);
    if (!shot.keep) for (const k of shot.cast) { const A = this.actors[k]; if (A) A.owner = i; }
    else for (const k of shot.cast) { const A = this.actors[k]; if (A) A.owner = i; }
    // how tightly the camera follows this shot's cast (track < 1: a softer, lazier follow for leaps)
    for (const k of shot.cast) { const A = this.actors[k]; if (A) for (const tr of Object.values(A.track)) tr.soft = (this.aspect < 0.95 ? shot.ptrack : undefined) ?? shot.track ?? 1; }
    try { shot.setup?.(run.S); } catch (e) { console.error('demo: setup', shot.id, e); }
    return run;
  }

  // simulate shot i's cast by dt at shot time t
  simulate(i, dt) {
    const shot = this.shots[i];
    const run = this.running.get(i);
    const k = typeof shot.slow === 'function' ? shot.slow(run.t) : shot.slow ?? 1;
    const sdt = dt * k;
    run.dt = sdt;
    try { shot.update?.(run.S); } catch (e) { if (!this.warn.has('u' + shot.id)) { this.warn.add('u' + shot.id); console.error('demo: update', shot.id, e); } }
    // the camera's subject trackers restart from the cast's live state half a second before the cut:
    // whatever lag the pre-roll built up (an animal accelerating to a sprint drags the filtered centre
    // metres behind it) is gone, and the filter has settled the gait's bob by the time the shot is on
    // screen. Shots that keep the previous shot's cast carry on with its trackers.
    if (!shot.keep && !run.trackReset && run.t >= -0.5) {
      run.trackReset = true;
      for (const key of shot.cast) { const A = this.actors[key]; if (A && A.owner === i) A.resetTrack = true; }
    }
    for (const key of shot.cast) {
      const A = this.actors[key];
      if (!A || A.owner !== i || A.stepped === this.frameN) continue;
      A.stepped = this.frameN;
      A.animal.update(sdt);
      this.track(A, sdt);
    }
    // the cast's tracked frames at the cut (heading, position): the reference of 'headingFrom: start'
    // and 'pivot: start' camera moves; follows the animals through the pre-roll, frozen from t = 0
    if (!run.start0 || run.t <= 0) {
      run.start0 = run.start0 || {};
      for (const key of shot.cast) { const F = this.actors[key]?.frame; if (F) run.start0[key] = { heading: F.heading, center: F.center.clone(), ground: F.ground.clone(), head: F.head.clone() }; }
    }
    // "how it's made" layers: only the shot on screen drives them
    if (i === this.cur && shot.reveal) {
      try { shot.reveal(run.S); } catch (e) { if (!this.warn.has('r' + shot.id)) { this.warn.add('r' + shot.id); console.error('demo: reveal', shot.id, e); } }
      for (const key of shot.cast) { const L = this.actors[key]?.layers; if (L && (L.group.visible || L.overGroup.visible)) L.update(); }
    }
    return sdt;
  }

  track(A, dt) {
    const a = A.animal, info = A.info;
    const F = A.frame || (A.frame = { ground: new THREE.Vector3(), center: new THREE.Vector3(), head: new THREE.Vector3(), vel: new THREE.Vector3(), heading: 0, rawCenter: new THREE.Vector3(), rawHead: new THREE.Vector3(), info, R: 0.5, scale: info.scale, A });
    const g = a.position;
    bodyCenter(a, F.rawCenter);
    headPosition(a, info, F.rawHead);
    const v = a.velocity || new THREE.Vector3();
    if (A.resetTrack) {
      A.track.g.reset(g, v); A.track.c.reset(F.rawCenter, v); A.track.h.reset(F.rawHead, v); A.track.hd.reset(a.heading);
      A.resetTrack = false;
    } else {
      A.track.g.update(g, dt, v); A.track.c.update(F.rawCenter, dt, v); A.track.h.update(F.rawHead, dt, v); A.track.hd.update(a.heading, dt);
    }
    F.ground.copy(A.track.g.p); F.center.copy(A.track.c.p); F.head.copy(A.track.h.p); F.vel.copy(A.track.g.v); F.heading = A.track.hd.a;
    F.R = 0.5 * Math.hypot(info.length, info.height, info.width * 0.6);
  }

  // ---------------------------------------------------------------- time
  // advance the reel by dt (seconds of sequence time)
  advance(dt) {
    this.frameN++;
    const T0 = this.T;
    let T = T0 + dt;
    // record mode: sequence time is exactly frame / fps (no drift from summing 1/60)
    if (this.opts.record && this.opts.fps) { const q = Math.round(T * this.opts.fps) / this.opts.fps; if (Math.abs(q - T) < 1e-4) T = q; }
    this.T = T;
    const shots = this.shots;
    // the current shot; shots whose pre-roll has begun are started (their cast placed and simulated)
    const ci = this.shotAt(T);
    for (let i = Math.max(0, ci); i < shots.length; i++) {
      const s = shots[i];
      const pre = s.keep ? 0 : s.pre ?? 1;
      if (T < s.start - pre - 1e-6) break;
      const run = this.runFor(i);
      if (!run.setupDone) this.startShot(i, T - s.start);
    }
    // a new shot on screen (visibility first: a reveal sets its layers while it simulates)
    if (ci !== this.cur) this.enterShot(ci);
    for (let i = ci; i < shots.length; i++) {
      const s = shots[i];
      const run = this.running.get(i);
      if (!run?.setupDone) break;
      run.t = T - s.start;
      this.simulate(i, dt);
    }
    const k = this.slowOf(ci);
    this.worldTime += dt * k;
    this.worldDt = dt * k;
  }

  slowOf(i) {
    const s = this.shots[i];
    const run = this.running.get(i);
    return typeof s.slow === 'function' ? s.slow(run?.t ?? 0) : s.slow ?? 1;
  }

  enterShot(i) {
    const prev = this.cur;
    this.cur = i;
    const s = this.shots[i];
    if (this.opts.adapt) this.adaptShells(s, prev >= 0 ? this.shots[prev] : null);
    for (const k in this.actors) {
      const A = this.actors[k];
      const on = s.cast.includes(k) && !s.hide?.includes(k);
      A.animal.object.visible = on;
      if (!on || !s.reveal) A.layers?.hide();
    }
    this.setTod(this.todOf(s));
    this.sunAz = Math.atan2(this.world.env.sunDir.x, this.world.env.sunDir.z);
    this.world.setWaterClarity?.(s.water ?? (s.cast.some((k) => this.actors[k]?.info.swimmer) ? 1 : 0));
    this.cutFrame = this.frameN;
    this.cutFrom = prev;
    // the shot's shadow extent: its cast's size
    const r = Math.max(0.12, ...s.cast.map((k) => 3.4 * (this.actors[k]?.info.scale || 1)));
    // (and its thinnest member's height: a snake's shadow is not swallowed by biases sized for its length)
    const thin = Math.min(...s.cast.map((k) => this.actors[k]?.info.height || Infinity));
    this.world.env.setShadowExtent(s.shadow ?? Math.min(30, r), thin);
    // (the trees' clearing is laid at the shot's first rendered frame: layTrees)
    this.treesFor = -1;
    // drop finished runs (a later seek restarts them)
    for (const [j] of this.running) if (j < i) this.running.delete(j);
  }

  // no acacia (big low-poly canopies) within the look's clearing round the subject; laid once, at the
  // shot's first rendered frame (where its cast stands at the cut: after a seek the shot is entered
  // before its pre-roll has placed anybody), and fixed for the whole shot (never re-laid while the
  // camera moves)
  layTrees(i) {
    const trees = this.world.env.trees, s = this.shots[i];
    this.treesFor = i;
    if (!trees) return;
    const tr = this.lookOf(s).trees?.r ?? 0;
    const run = this.running.get(i);
    const F0 = s.cast.length ? this.subject(s.cast[0]) : null;
    let c = null;
    try { c = s.focus && run?.S ? s.focus(run.S) : F0?.ground; } catch (e) { c = F0?.ground; }
    trees.clear = tr > 0 && c ? { x: c.x, z: c.z, r: tr } : null;
  }

  // live playback: one fur tier fewer (or more) for the next shot when the frame times of the shot that
  // just ended missed (or comfortably met) the display's frame period. Only at cuts: no popping. An actor
  // that was already on screen in the shot before (a continuous chain, the same animal across the cut)
  // eases to its new coat tier (render.setQuality(q, { transition })); one that enters with the cut
  // switches at once. Never in the 'record' profile (opts.adapt is live only): the recording keeps the
  // cast's own tiers from the first frame to the last.
  adaptShells(s, prevShot = null) {
    const L = this.live, TIERS = ['hero', 'high', 'medium', 'low', 'crowd'];
    const ft = L.shotTimes || [];
    if (ft.length >= 30) {
      const mean = ft.reduce((a, b) => a + b, 0) / ft.length;
      const sorted = ft.slice().sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)];
      const period = L.period || 1000 / 60;
      const before = this.liveTier;
      if (mean > period * 1.08 && this.liveTier < 2) this.liveTier++; // (automatic: never below 'low' shells)
      else if (mean < period * 1.01 && p95 < period * 1.1 && this.liveTier > 0 && (this.calm = (this.calm || 0) + 1) >= 3) { this.liveTier--; this.calm = 0; }
      if (mean > period * 1.01) this.calm = 0;
      if (this.liveTier !== before) console.info(`demo: fur tier ${before} -> ${this.liveTier} (mean frame ${mean.toFixed(1)} ms of ${period.toFixed(1)}) at ${s.id}`);
    }
    L.shotTimes = [];
    // a shot may ask for fewer shells / a lower render scale live (herds: many furry animals at once)
    const tier = Math.max(this.liveTier, s.live?.tier ?? 0);
    const scale = s.live?.scale ?? this.opts.scale;
    if (Math.abs(this.post.ss - scale * this.opts.ss) > 1e-3) { this.post.ss = scale * this.opts.ss; this.post.setSize(this.post.w, this.post.h); }
    for (const k of s.cast) {
      const A = this.actors[k];
      if (!A) continue;
      const q = A.animal.quality || 'high';
      const to = TIERS[Math.min(TIERS.length - 1, Math.max(0, TIERS.indexOf(q)) + tier)];
      if (A.animal.render.tier === to) continue;
      const seen = prevShot && prevShot.cast.includes(k) && !prevShot.hide?.includes(k);
      A.animal.render.setQuality?.(to, { transition: seen ? 1.2 : 0 });
    }
  }

  // jump to sequence time T: every shot starts fresh; shots that keep their cast from the previous shot
  // are replayed from the start of that chain
  seek(T) {
    T = clamp(T, 0, this.timeline.total - 1e-6);
    this.minShot = 0; // (a backwards seek: the shot index is found from the start of the timeline)
    let i = this.shotAt(T);
    while (i > 0 && this.shots[i].keep) i--;
    const s = this.shots[i];
    const pre = s.pre ?? 1;
    seedRandom(hashStr(`${s.id}#${this.opts.seed}`));
    this.running.clear();
    this.cur = -1;
    this.minShot = i;
    for (const k in this.actors) this.actors[k].owner = -1;
    const fps = this.opts.fps || 60;
    const h = 1 / fps;
    this.T = s.start - pre - h;
    this.worldTime = this.T;
    // fast-forward (no rendering) at the recording frame rate: the same states a recording reaches
    const n = Math.max(0, Math.round((T - this.T) / h));
    for (let j = 0; j < n; j++) this.advance(h);
    this.advance(T - this.T);
    this.camLog.length = 0;
    return this.T;
  }

  // ---------------------------------------------------------------- camera rigs
  // orbit / push / pull / crane / track: spherical coordinates around a tracked target, interpolated
  // a -> b over the shot with an easing curve. spec:
  //   actor, frame: 'heading' | 'sun' | 'world' (azimuth 0 = in front of the animal / on the sun's side / +Z)
  //   a: { az, el, d | fit, fov, head (0 body centre .. 1 head), y (target lift, m), lead (m ahead) }, b: {...}
  //   ease, u0, u1 (the part of the shot the move spans), look: { head, y, lead } (look target override)
  //   roll (rad), headingFrom: 'start' (freeze the frame's heading at the shot start)
  camOrbit(S, spec) {
    const F = this.subject(spec.actor);
    const pose = this.pose;
    if (!F) return pose;
    const shot = S.shot;
    const u0 = spec.u0 ?? 0, u1 = spec.u1 ?? 1;
    const uu = clamp((S.t / shot.dur - u0) / Math.max(1e-6, u1 - u0), 0, 1);
    const e = easeOf(spec.ease || 'inOut')(uu);
    const A = spec.a || {}, B = spec.b || A;
    const ip = (k, def) => { const x = A[k] ?? def, y = B[k] ?? x; return x + (y - x) * e; };
    const fov = fovFor(ip('fov', 35), this.aspect, 16 / 9, S.shot.wide ?? 0.65);
    const R = F.R * (spec.rScale ?? 1);
    // frame
    const st0 = S.run.start0?.[spec.actor];
    let h0;
    if ((spec.frame || 'heading') === 'heading') h0 = spec.headingFrom === 'start' || spec.pivot === 'start' ? st0?.heading ?? F.heading : F.heading;
    else if (spec.frame === 'sun') h0 = this.sunAz;
    else h0 = spec.frameAngle ?? 0;
    const az = ip('az', 0) * DEG + h0, el = ip('el', 10) * DEG;
    const d = (A.fit !== undefined ? ip('fit', 1) * fitDistance(R, fov, this.aspect, 1) : ip('d', 3)) * this.portraitFit(shot);
    const head = ip('head', 0), y = ip('y', 0), lead = ip('lead', 0) * this.portraitLead(shot), side = ip('side', 0);
    // anchor 'ground': the frame follows the ground under the animal, not its body (leaps and hops
    // happen inside a steady frame)
    const base = spec.anchor === 'ground' ? _b.set(F.ground.x, this.world.ground(F.ground.x, F.ground.z) + (spec.anchorY ?? 0.45) * F.info.height, F.ground.z) : F.center;
    const tgt = _t.copy(base).lerp(F.head, head);
    tgt.y += y;
    const Fw = forward(spec.pivot === 'start' ? h0 : F.heading, _f), Lw = left(spec.pivot === 'start' ? h0 : F.heading, _l);
    tgt.addScaledVector(Fw, lead).addScaledVector(Lw, side);
    // pivot 'start': the camera stands where the orbit put it round the animal's place at the cut and
    // pans to follow it from there (a camera on a tripod)
    const center = spec.pivot === 'start' && st0 ? _p.copy(spec.anchor === 'ground' ? st0.ground : st0.center).setY(spec.anchor === 'ground' ? this.world.ground(st0.ground.x, st0.ground.z) + (spec.anchorY ?? 0.45) * F.info.height + y : st0.center.y + y) : tgt;
    pose.pos.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(d).add(center);
    // look target: the orbit target, or its own blend
    if (spec.look) {
      const L = spec.look;
      const lh = L.head ?? head, ly = L.y ?? y, ll = L.lead ?? lead;
      pose.look.copy(F.center).lerp(F.head, lh);
      pose.look.y += ly;
      pose.look.addScaledVector(Fw, ll);
    } else if (spec.lookAt === 'start' && spec.pivot === 'start' && st0) {
      // a locked-off tripod: the look target stays where the animal was at the cut (+ lead / side)
      pose.look.copy(center).addScaledVector(Fw, lead).addScaledVector(Lw, side);
    } else pose.look.copy(tgt);
    pose.fov = fov;
    pose.roll = (spec.roll ?? 0) * (typeof spec.rollEase === 'string' ? easeOf(spec.rollEase)(uu) : 1);
    pose.yawOff = 0; pose.pitchOff = 0;
    return pose;
  }

  // keyframed orbit: spec.keys = [{ t (s) | u (0..1 of the shot), az, el, d | fit, fov, head, y, lead,
  // side, roll, ly, lh, llead }], every parameter interpolated by a C1 Hermite spline through the keys
  // (Catmull-Rom tangents; zero velocity at the first / last key unless spec.free). ly / lh / llead: a
  // separate look target (y offset, head blend, lead) - a tilt to the sky and back, for example.
  camPath(S, spec) {
    const F = this.subject(spec.actor);
    const pose = this.pose;
    if (!F) return pose;
    const dur = S.shot.dur;
    const keys = spec._keys || (spec._keys = spec.keys.map((k) => ({ ...k, t: k.t ?? (k.u ?? 0) * dur })).sort((a, b) => a.t - b.t));
    const t = clamp(S.t, keys[0].t, keys[keys.length - 1].t);
    const val = (name, def) => {
      // the keys that carry this parameter (others inherit it)
      const K = [];
      let last = def;
      for (const k of keys) { if (k[name] !== undefined) last = k[name]; K.push([k.t, last]); }
      if (K.length === 1) return K[0][1];
      let i = 0;
      while (i < K.length - 2 && t > K[i + 1][0]) i++;
      const [t0, p0] = K[i], [t1, p1] = K[i + 1];
      const h = Math.max(1e-6, t1 - t0), u = clamp((t - t0) / h, 0, 1);
      const slope = (a, b) => (K[b][1] - K[a][1]) / Math.max(1e-6, K[b][0] - K[a][0]);
      const tan = (j) => {
        if (j === 0 || j === K.length - 1) return spec.free ? slope(Math.max(0, j - 1), Math.min(K.length - 1, j + 1)) : 0;
        const a = K[j][0] - K[j - 1][0], b = K[j + 1][0] - K[j][0];
        return (slope(j - 1, j) * b + slope(j, j + 1) * a) / (a + b);
      };
      const m0 = tan(i) * h, m1 = tan(i + 1) * h;
      const u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1;
    };
    const fov = fovFor(val('fov', 35), this.aspect, 16 / 9, S.shot.wide ?? 0.65);
    let h0;
    if ((spec.frame || 'heading') === 'heading') h0 = spec.headingFrom === 'start' ? S.run.start0?.[spec.actor]?.heading ?? F.heading : F.heading;
    else if (spec.frame === 'sun') h0 = this.sunAz;
    else h0 = spec.frameAngle ?? 0;
    const az = val('az', 0) * DEG + h0, el = val('el', 8) * DEG;
    const R = F.R * (spec.rScale ?? 1);
    const d = (keys.some((k) => k.fit !== undefined) ? val('fit', 1) * fitDistance(R, fov, this.aspect, 1) : val('d', 3)) * this.portraitFit(S.shot);
    const head = val('head', 0), y = val('y', 0), lead = val('lead', 0) * this.portraitLead(S.shot), side = val('side', 0);
    const Fw = forward(F.heading, _f), Lw = left(F.heading, _l);
    const tgt = _t.copy(F.center).lerp(F.head, head);
    tgt.y += y;
    tgt.addScaledVector(Fw, lead).addScaledVector(Lw, side);
    pose.pos.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(d).add(tgt);
    if (keys.some((k) => k.ly !== undefined || k.lh !== undefined || k.llead !== undefined)) {
      pose.look.copy(F.center).lerp(F.head, val('lh', head));
      pose.look.y += val('ly', y);
      pose.look.addScaledVector(Fw, val('llead', lead)).addScaledVector(Lw, side);
    } else pose.look.copy(tgt);
    pose.fov = fov;
    pose.roll = val('roll', 0);
    pose.yawOff = 0; pose.pitchOff = 0;
    return pose;
  }

  // a fixed (or slowly drifting) camera position in world space looking at a tracked point
  camFixed(S, spec) {
    const pose = this.pose;
    const uu = clamp(S.t / S.shot.dur, 0, 1);
    const e = easeOf(spec.ease || 'inOut')(uu);
    const p0 = spec.pos, p1 = spec.pos1 || p0;
    pose.pos.set(lerp(p0[0], p1[0], e), lerp(p0[1], p1[1], e), lerp(p0[2], p1[2], e));
    if (spec.relGround) pose.pos.y += this.world.ground(pose.pos.x, pose.pos.z);
    if (spec.actor) {
      const F = this.subject(spec.actor);
      pose.look.copy(F.center).lerp(F.head, spec.head ?? 0);
      pose.look.y += spec.y ?? 0;
    } else if (spec.look) {
      const l0 = spec.look, l1 = spec.look1 || l0;
      pose.look.set(lerp(l0[0], l1[0], e), lerp(l0[1], l1[1], e), lerp(l0[2], l1[2], e));
      if (spec.lookRelGround) pose.look.y += this.world.ground(pose.look.x, pose.look.z);
    }
    pose.fov = fovFor(lerp(spec.fov ?? 35, spec.fov1 ?? spec.fov ?? 35, e), this.aspect, 16 / 9, S.shot.wide ?? 0.65);
    pose.roll = spec.roll ?? 0;
    pose.yawOff = 0; pose.pitchOff = 0;
    return pose;
  }

  // ---------------------------------------------------------------- frame
  render() {
    const { renderer, scene, camera, post, world } = this;
    renderer.info.reset();
    const i = this.cur;
    const shot = this.shots[i];
    const run = this.running.get(i);
    const S = run.S;
    if (this.treesFor !== i) this.layTrees(i);
    // camera
    let pose;
    try { pose = shot.cam ? shot.cam(S) : this.pose; } catch (e) { if (!this.warn.has('c' + shot.id)) { this.warn.add('c' + shot.id); console.error('demo: cam', shot.id, e); } pose = this.pose; }
    this.recompose(pose, shot);
    this.constrain(pose, shot);
    // whip pans: a fast yaw at the end of one shot / the start of the next, blurred
    const t = run.t;
    let blur = 0, yawOff = 0;
    const W = 70 * DEG;
    if (shot.whipOut) {
      const d = shot.whipOut.d ?? 0.25, u = clamp((t - (shot.dur - d)) / d, 0, 1);
      yawOff += (shot.whipOut.dir ?? 1) * W * u * u * u;
      blur = Math.max(blur, u * u);
    }
    if (shot.whipIn) {
      const d = shot.whipIn.d ?? 0.25, u = clamp(t / d, 0, 1);
      yawOff -= (shot.whipIn.dir ?? 1) * W * (1 - u) ** 3;
      blur = Math.max(blur, (1 - u) ** 2);
    }
    pose.yawOff = yawOff;
    applyPose(camera, pose, this.aspect);
    // near plane from the subject's size and distance (a spider seen from 12 cm, a horse from 8 m)
    const F0 = shot.cast.length ? this.subject(shot.cast[0]) : null;
    const dist = F0 ? camera.position.distanceTo(F0.center) : 5;
    // (and from the lens's height over the ground: a camera 10 cm up in the grass must not cut the ground
    // under the bottom of the frame away)
    const camUp = camera.position.y - world.ground(camera.position.x, camera.position.z);
    const near = clamp(Math.min(dist * 0.25, (F0 ? F0.R : 1) * 0.5, Math.max(0.004, camUp * 0.4)), 0.004, 0.3);
    if (Math.abs(camera.near - near) > 1e-5) { camera.near = near; camera.updateProjectionMatrix(); }
    // stage light: a reveal dims the world to dusk (the layers stay lit), the coat brings the sun back
    const env = world.env, base = env._base || { sun: env.sun.intensity, hemi: env.hemi.intensity };
    const dim = shot.dim ? clamp(shot.dim(t), 0, 1) : 0;
    const look = this.lookOf(shot);
    this.applyLook(look, shot, t, dim);
    for (const k of shot.cast) { const L = this.actors[k]?.layers; if (L && (L.group.visible || L.overGroup.visible)) L.light(env, dim, base.sun); }
    // post: exposure, fades, whip blur, grade
    const U = post.uniforms;
    U.uExposure.value = (world.env.exposure ?? 0.72) * (look.exposure ?? 1) * (typeof shot.exposure === 'function' ? shot.exposure(t) : shot.exposure ?? 1);
    let fade = 0;
    if (shot.fadeIn) fade = Math.max(fade, 1 - ease.sine(t / shot.fadeIn));
    if (shot.fadeOut) fade = Math.max(fade, ease.sine((t - (shot.dur - shot.fadeOut)) / shot.fadeOut));
    if (shot.fade) fade = Math.max(fade, shot.fade(t));
    U.uFade.value = clamp(fade, 0, 1);
    U.uBlur.value.set(blur * 0.09 * Math.sign(yawOff || 1), 0);
    U.uBloom.value = shot.bloom ?? 0.035;
    // world: focus on the subject; grass pushed by the feet and bodies of the visible cast
    const focus = this.focus;
    if (shot.focus) focus.copy(shot.focus(S));
    else if (F0) focus.copy(F0.ground);
    // grass: a shot may mow a soft clearing round its subject (small animals) or shorten it overall
    const gr = shot.grass;
    if (gr) {
      const G = gr.actor ? this.subject(gr.actor) : F0;
      world.grass.setMow(G ? G.ground.x : 0, G ? G.ground.z : 0, gr.r ?? 0, gr.k ?? 1, gr.scale ?? 1);
    } else world.grass.setMow(0, 0, 0, 1, 1);
    if (world.terrain.uniforms.uBed) world.terrain.uniforms.uBed.value = shot.bed ?? 0;
    if (world.terrain.uniforms.uWet) world.terrain.uniforms.uWet.value = shot.wet ?? 0.8;
    this.applyWater(shot.water > 0 ? look.water : null);
    world.update(focus, this.worldDt ?? 0, this.worldTime, camera, this.pushFor(shot));
    this.contactFor(shot, t);
    // titles
    if (this.opts.titles) this.titles.draw(this.titleState(shot, run));
    if (post.overlay.children.length > 3) {
      post.overlaySun.position.copy(world.env.sunDir).multiplyScalar(10).add(camera.position);
      post.overlaySun.target.position.copy(camera.position);
      post.overlaySun.target.updateMatrixWorld();
      post.overlaySun.color.copy(world.env.sunColor);
    }
    const t0 = performance.now();
    post.render(scene, camera);
    this.lastRenderMs = performance.now() - t0;
    this.logCamera(pose, shot);
    this.prevPose.copy(pose);
  }

  // portrait crops (9:16, 4:5): a fitted animal fills the narrow width exactly, so a long body, a herd
  // or a spread wing needs more room (shot.pfit: distance factor, default 1); the lead room ahead of a
  // runner shrinks with the width
  portraitFit(shot) { return this.aspect < 0.95 ? shot.pfit ?? 1 : 1; }
  portraitLead(shot) { return this.aspect < 0.95 ? shot?.plead ?? 0.6 : 1; }

  // portrait crops: a shot authored for 16:9 with a low camera puts the horizon near the middle of a tall
  // frame, so its top half is empty sky. The horizon is brought up to shot.portrait.horizon (fraction of
  // the frame height from the top, default 0.3) by raising the camera round its target (the animal keeps
  // its place in the frame and the ground fills in behind it; the orbit elevation is capped at `maxEl`
  // deg). `share` (default 0) gives part of it to a tilt instead (at most `tilt` deg), which lifts the
  // animal with the horizon. Every step is a smooth function of the pose (soft max / min), so the camera
  // path stays C1.
  // shot.portrait: false keeps the authored framing (sky subjects, underwater shots, the title cards).
  recompose(pose, shot) {
    if (this.aspect >= 0.95 || shot.portrait === false) return;
    const P = shot.portrait || {};
    const hT = P.horizon ?? 0.3, tiltMax = (P.tilt ?? 5) * DEG, share = P.share ?? 0, maxEl = (P.maxEl ?? 24) * DEG;
    const v = _rv.copy(pose.pos).sub(pose.look);
    const dist = v.length();
    if (dist < 1e-6) return;
    const hd = Math.hypot(v.x, v.z);
    const el = Math.atan2(v.y, hd); // the view's pitch below the horizontal (look target under the lens > 0)
    const tanV = Math.tan((pose.fov * DEG) / 2);
    const elT = Math.atan((0.5 - hT) * 2 * tanV);
    const k = 2 * DEG;
    const need = smax(elT - el, 0, k); // pitch still missing (soft: no kink where it engages)
    if (need < 1e-5) return;
    const tilt = -smax(-need * share, -tiltMax, k * 0.5); // soft min(need * share, tiltMax)
    // raise: rotate the lens round the look target (same distance), capped
    const el1 = -smax(-(el + (need - Math.max(0, tilt))), -Math.max(el, maxEl), k);
    if (hd > 1e-6) {
      const c = Math.cos(el1) * dist / hd;
      pose.pos.set(pose.look.x + v.x * c, pose.look.y + Math.sin(el1) * dist, pose.look.z + v.z * c);
    }
    // tilt: pitch the look direction down by `tilt` about the lens (the target drops under the centre)
    if (tilt > 1e-5) {
      const d = _rd.copy(pose.look).sub(pose.pos);
      const L = d.length(), h = Math.hypot(d.x, d.z);
      if (h > 1e-6) {
        const a = Math.atan2(d.y, h) - tilt;
        const c = (Math.cos(a) * L) / h;
        pose.look.set(pose.pos.x + d.x * c, pose.pos.y + Math.sin(a) * L, pose.pos.z + d.z * c);
      }
    }
  }

  // the animals' share of the sky light follows the hour and the stage dusk (Environment.makeAnimalLight
  // scales it by scene.environmentIntensity, as three.js scales the sky's light on the ground): it is
  // remade when either changes and handed to the cast (setEnvironmentLight copies it)
  syncEnvLight(shot) {
    const env = this.world.env;
    if (!env.envSH || !env.makeAnimalLight) return;
    const key = env.tod + ':' + this.scene.environmentIntensity.toFixed(5);
    if (this.envKey !== key) { this.envKey = key; env.makeAnimalLight(); this.envGen = (this.envGen || 0) + 1; }
    for (const k of shot.cast || []) {
      const A = this.actors[k];
      if (A && A.envGen !== this.envGen) { A.envGen = this.envGen; A.animal.render?.setEnvironmentLight?.(env.animalSH); }
    }
  }

  // the shot's look: the reel's LOOK with the shot's own `look` merged over it (cached per shot)
  lookOf(shot) {
    if (shot._look) return shot._look;
    const merge = (a, b) => {
      if (!b) return a;
      const o = { ...a };
      for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
      return o;
    };
    return (shot._look = merge(LOOK, shot.look));
  }

  // the look's sky grade, haze, sky light, the cast's bounce fill and the post grade; the shot's own
  // skyWarm / clouds / skyGain / skyGrad / warm (numbers or functions of shot time) win
  applyLook(L, shot, t, dim = 0) {
    const env = this.world.env, base = env._base || { sun: env.sun.intensity, hemi: env.hemi.intensity };
    const val = (x, def) => (typeof x === 'function' ? x(t) : x ?? def);
    env.sun.intensity = base.sun * (1 - 0.82 * dim);
    env.hemi.intensity = base.hemi * (L.hemi ?? 1) * (1 - 0.65 * dim);
    this.scene.environmentIntensity = 0.18 * (1 - 0.65 * dim);
    this.syncEnvLight(shot);
    const u = env.sky.material.uniforms, s = L.sky;
    if (u.uSkyGain) setSkyGrade(u, s, { gain: val(shot.skyGain, s.gain) * (1 - 0.72 * dim), warm: this.opts.skyWarm ?? val(shot.skyWarm, s.warm) });
    const hm = env.hills?.material;
    if (hm && L.hills) {
      if (hm.fog) { hm.fog = false; hm.needsUpdate = true; }
      hm.color.setRGB(...L.hills.color);
      hm.emissive?.setRGB(...L.hills.emissive);
    }
    if (u.cloudCoverage) u.cloudCoverage.value = val(shot.clouds, s.clouds);
    // the sun's shadows (a shot may fade them: the tarantula's x-ray has none)
    if (env.sun.shadow && 'intensity' in env.sun.shadow) env.sun.shadow.intensity = val(shot.shade, 1);
    // the showcase's set pieces (a dead tree, a fence line, logs, rocks) stay out of the reel
    if (this.world.props?.group) this.world.props.group.visible = L.props !== false;
    if (L.fog && this.scene.fog) this.scene.fog.color.setRGB(...L.fog);
    const fill = val(shot.fill, L.fill);
    for (const k of shot.cast || []) { const U = this.actors[k]?.animal?.render?.uniforms; if (U?.uFill) U.uFill.value = fill; }
    const P = this.post.uniforms, p = L.post;
    P.uWarm.value = val(shot.warm, p.warm) * (1 - 0.5 * dim);
    P.uSat.value = p.sat;
    P.uVignette.value = p.vignette + 0.25 * dim;
    P.uSkyGrad.value = val(shot.skyGrad, p.skyGrad);
  }

  // the lake's water in the water shots (LOOK.water): the bed and whatever swims are seen through the
  // water's absorption with its own colour over them, caustics play on the bed, the surface is physical
  // (reflections at full strength, the body of the water drawn with the bed). null: the showcase's lake.
  applyWater(W) {
    const world = this.world, TU = world.terrain.uniforms, sun = world.env.sunDir;
    if (TU.uWater) {
      if (W) {
        TU.uWater.value.set(W.sigma[0], W.sigma[1], W.sigma[2], 1);
        TU.uWaterCol.value.setRGB(...W.color);
        TU.uCaustic.value.set(W.caustic[0], W.caustic[1], this.worldTime * (W.caustic[3] ?? 1), W.caustic[2]);
        TU.uSunDir.value.copy(sun);
      } else { TU.uWater.value.w = 0; TU.uCaustic.value.x = 0; }
    }
    if (world.water?.uniforms?.uPhys) world.water.uniforms.uPhys.value = W ? 1 : 0;
    const U = WATER_UNIFORMS;
    if (W) { U.uDemoWater.value.set(W.sigma[0], W.sigma[1], W.sigma[2], 1); U.uDemoWaterCol.value.setRGB(...W.color); U.uDemoSun.value.copy(sun); U.uDemoWL.value = world.waterLevel; }
    else U.uDemoWater.value.w = 0;
  }

  // look-development probes (record.mjs --eval): render the scene from any camera, no shot logic
  renderManual({ pos, look, fov = 35, focus = null, keys = [], tod = null, titles = null, roll = 0, dim = 0, bloom = 0.035, grade = null }) {
    const { renderer, scene, camera, post, world } = this;
    renderer.info.reset();
    if (tod != null) this.setTod(tod);
    const env = world.env, base = env._base || { sun: env.sun.intensity, hemi: env.hemi.intensity };
    const probeShot = { cast: keys, id: 'probe', look: grade || undefined };
    this.applyLook(this.lookOf(probeShot), probeShot, 0, dim);
    for (const k of keys) { const L = this.actors[k]?.layers; if (L && (L.group.visible || L.overGroup.visible)) L.light(env, dim, base.sun); }
    post.uniforms.uBloom.value = bloom;
    const pose = this.pose;
    pose.pos.set(...pos); pose.look.set(...look); pose.fov = fov; pose.roll = roll; pose.yawOff = 0; pose.pitchOff = 0;
    applyPose(camera, pose, this.aspect);
    const d = camera.position.distanceTo(pose.look);
    camera.near = clamp(d * 0.02, 0.004, 0.3); camera.updateProjectionMatrix();
    const f = focus ? new THREE.Vector3(...focus) : pose.look.clone();
    const shot = probeShot;
    world.update(f, 0, this.worldTime, camera, this.pushFor(shot));
    this.contactFor(shot);
    post.uniforms.uExposure.value = (world.env.exposure ?? 0.72) * (this.lookOf(probeShot).exposure ?? 1);
    post.uniforms.uFade.value = 0; post.uniforms.uBlur.value.set(0, 0);
    this.titles.draw(titles || {});
    post.render(scene, camera);
  }

  // safety net: above the ground (and the water), outside every visible animal's body
  constrain(pose, shot) {
    const w = this.world, p = pose.pos;
    const F0 = shot.cast.length ? this.subject(shot.cast[0]) : null;
    const s = F0 ? Math.min(1, F0.scale) : 1;
    const clear = shot.camClear ?? 0.06 + 0.14 * s;
    const g = w.ground(p.x, p.z);
    const wl = w.waterAt(p.x, p.z);
    let floor = g + clear;
    if (wl != null && !shot.underwater) floor = Math.max(floor, wl + 0.04 + 0.1 * s);
    const y0 = p.y;
    p.y = smax(p.y, floor, clear * 0.5);
    if (p.y - y0 > 0.02 * s + 0.01) this.flag(shot, 'camera lifted above the ground');
    for (const k of shot.cast) {
      const A = this.actors[k];
      if (!A || !A.animal.object.visible) continue;
      const F = A.frame;
      const r = F.R * (shot.camBody ?? 0.55);
      const dx = p.x - F.center.x, dy = p.y - F.center.y, dz = p.z - F.center.z, d = Math.hypot(dx, dy, dz);
      if (d < r && d > 1e-6) { p.x = F.center.x + (dx / d) * r; p.y = F.center.y + (dy / d) * r; p.z = F.center.z + (dz / d) * r; this.flag(shot, 'camera pushed out of ' + k); }
    }
  }

  flag(shot, msg) {
    const key = shot.id + ': ' + msg;
    if (!this.warn.has(key)) { this.warn.add(key); console.warn('demo:', key, 'at', this.T.toFixed(2)); }
    (shot.flags || (shot.flags = new Set())).add(msg);
  }

  pushFor(shot) {
    const push = this.push;
    push.length = 0;
    for (const k of shot.cast) {
      const A = this.actors[k];
      if (!A || !A.animal.object.visible) continue;
      const a = A.animal, info = A.info;
      for (const p of footPositions(a, info, this._feet)) {
        if (push.length >= 8) break;
        const gy = this.world.ground(p.x, p.z);
        if (p.y - gy < 0.4 * info.scale) push.push({ x: p.x, y: gy, z: p.z, r: 0.22 * info.scale });
      }
      const hy = this.world.ground(a.position.x, a.position.z);
      if (push.length < 10 && a.position.y - hy < info.height) push.push({ x: a.position.x, y: hy, z: a.position.z, r: Math.max(0.3 * Math.min(1, info.scale * 3), info.span * (shot.grassPush ?? 0.3)) });
      if (push.length >= 10) break;
    }
    if (shot.clearing) { const c = shot.clearing(this.running.get(this.cur).S); if (c) for (const q of c) if (push.length < 10) push.push(q); }
    return push;
  }

  // soft contact shadows under the visible cast; an animal shown by its "how it's made" layers keeps
  // its contact shadow through every stage (it would otherwise blink off and on as its coat goes), and
  // the shot's shade (the sun's shadow strength) scales them too: the shadows fade together
  contactFor(shot, t = 0) {
    const E = this.contactEntries;
    E.length = 0;
    const shade = typeof shot.shade === 'function' ? shot.shade(t) : shot.shade ?? 1;
    for (const k of shot.cast) {
      const A = this.actors[k];
      if (!A || A.info.swimmer) continue;
      const layered = !!A.layers && (A.layers.group.visible || A.layers.overGroup.visible);
      if (!A.animal.object.visible && !layered) continue;
      E.push({ animal: A.animal, info: A.info, feet: E.length < 6, k: clamp(shade, 0, 1), always: layered });
    }
    this.contact.update(E);
  }

  titleState(shot, run) {
    const t = run.t;
    const st = {};
    const tt = shot.title;
    if (tt === 'open') st.open = { t, dur: shot.titleDur ?? shot.dur, start: shot.titleStart, y: shot.titleY };
    else if (tt === 'end') st.end = { t, dur: shot.dur, repo: this.opts.repo, y: shot.titleY };
    else if (tt && typeof tt === 'object') {
      const A = this.actors[tt.actor];
      if (A) {
        const at = tt.at ?? 0.3, dur = tt.dur ?? shot.dur - at;
        st.species = { t: t - at, dur, name: tt.name || NAMES[A.def.species] || A.meta.name };
      }
    }
    if (shot.caption) {
      const c = shot.caption(run.S);
      if (c) st.caption = c;
    }
    return st;
  }


  logCamera(pose, shot) {
    const cut = this.cutFrame === this.frameN;
    this.camLog.push({ T: +this.T.toFixed(5), shot: shot.id, cut, whip: !!(pose.yawOff), p: [pose.pos.x, pose.pos.y, pose.pos.z], l: [pose.look.x, pose.look.y, pose.look.z], fov: pose.fov });
    if (this.camLog.length > 20000) this.camLog.shift();
  }

  cueSheet() {
    return {
      total: this.timeline.total,
      aspect: this.opts.aspectName,
      shots: this.shots.map((s, i) => ({
        n: i + 1, id: s.id, start: +s.start.toFixed(2), dur: s.dur, end: +(s.start + s.dur).toFixed(2),
        species: s.speciesList, cast: s.cast.map((k) => { const A = this.actors[k]; const v = A && (A.animal.params?.variant ?? A.def.variant); return A ? `${k} (${A.def.species}${v ? ' ' + v : ''}, ${A.animal.quality})` : k; }),
        what: s.what || '', transition: s.whipOut ? 'whip' : s.fadeOut ? 'fade' : 'cut', tod: this.todOf(s), slow: typeof s.slow === 'function' ? 'ramp' : s.slow ?? 1,
        flags: s.flags ? [...s.flags] : [],
      })),
    };
  }

  // ---------------------------------------------------------------- live playback
  startLive() {
    const L = this.live;
    L.log = [];
    let last = performance.now();
    const period = [];
    if (this.opts.hud) { L.hud = document.createElement('div'); L.hud.id = 'demoHud'; document.getElementById('app').appendChild(L.hud); }
    const hudTick = () => {
      if (!L.hud) return;
      const dts = L.dts.slice(-240).sort((a, b) => a - b), works = L.works.slice(-240).sort((a, b) => a - b);
      const pc = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0);
      const s = this.shots[this.cur];
      L.hud.textContent = `T ${this.T.toFixed(2)} / ${this.timeline.total.toFixed(1)}  shot ${this.cur + 1} ${s?.id}\n` +
        `frame ms  p50 ${pc(dts, 0.5).toFixed(1)}  p95 ${pc(dts, 0.95).toFixed(1)}  max ${pc(dts, 1).toFixed(1)}\n` +
        `work ms   p50 ${pc(works, 0.5).toFixed(1)}  p95 ${pc(works, 0.95).toFixed(1)}  max ${pc(works, 1).toFixed(1)}\n` +
        `render ${this.stage.w}x${this.stage.h}  draws ${this.renderer.info.render.calls}`;
    };
    const keyH = (e) => {
      const k = e.key.toLowerCase();
      if (k === ' ') { L.paused = !L.paused; e.preventDefault(); }
      else if (k === 'arrowright') this.seek(this.shots[Math.min(this.shots.length - 1, this.cur + 1)].start);
      else if (k === 'arrowleft') this.seek(this.shots[Math.max(0, this.cur - (this.T - this.shots[this.cur].start < 0.6 ? 1 : 0))].start);
      else if (k === 'r') this.seek(0);
      else if (k === 'h') { if (L.hud) { L.hud.remove(); L.hud = null; } else { L.hud = document.createElement('div'); L.hud.id = 'demoHud'; document.getElementById('app').appendChild(L.hud); } }
      else if (k === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); }
    };
    window.addEventListener('keydown', keyH);
    let hudT = 0;
    const tick = (now) => {
      requestAnimationFrame(tick);
      const raw = Math.max(0, (now - last) / 1000);
      last = now;
      // quantise to the display's frame period: evenly spaced motion when frames are on time
      period.push(raw); if (period.length > 60) period.shift();
      const sorted = period.slice().sort((a, b) => a - b), P = sorted[sorted.length >> 1] || 1 / 60;
      let dt = P > 0.004 && P < 0.05 ? Math.max(1, Math.round(raw / P)) * P : raw;
      dt = Math.min(dt, 1 / 15);
      if (L.paused) dt = 0;
      const w0 = performance.now();
      if (dt > 0 || !this.rendered) {
        this.advance(dt * this.opts.speed);
        if (this.T >= this.timeline.total - 1e-6) { if (this.opts.loop) this.seek(0); else { this.T = this.timeline.total - 1e-6; L.paused = true; } }
        this.render();
        this.rendered = true;
      }
      const work = performance.now() - w0;
      L.dts.push(raw * 1000); L.works.push(work);
      if (dt > 0) { (L.shotTimes || (L.shotTimes = [])).push(raw * 1000); L.period = P * 1000; }
      if (L.log && L.log.length < 40000) L.log.push([+this.T.toFixed(3), this.cur, +(raw * 1000).toFixed(2), +work.toFixed(2), this.liveTier]);
      if (L.dts.length > 20000) { L.dts.shift(); L.works.shift(); }
      hudT += raw;
      if (hudT > 0.25) { hudT = 0; hudTick(); }
    };
    requestAnimationFrame((t) => { last = t; tick(t); });
    document.body.classList.add('demoCursor');
  }

  liveStats() {
    const L = this.live;
    const st = (arr) => { const s = arr.slice(30).sort((a, b) => a - b); const pc = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0); return { n: s.length, p50: pc(0.5), p95: pc(0.95), p99: pc(0.99), max: pc(1), mean: s.reduce((x, y) => x + y, 0) / Math.max(1, s.length) }; };
    return { frame: st(L.dts), work: st(L.works) };
  }

  // ---------------------------------------------------------------- recording (showcase/record.mjs)
  // Renders n frames at exactly 1/fps each (from `start` after a seek, else continuing) and POSTs every
  // frame's raw RGBA rows (bottom-up) to `url`, in order. The readback is pipelined: frame i is read
  // into a pixel-pack buffer (async on the GPU) while frame i-1 is copied out and posted.
  // Each frame goes out as a Blob (6-8 ms per 1080p frame; a typed-array body takes ~200 ms), and the
  // page collects its garbage every 30 frames when record.mjs exposes gc (--js-flags=--expose-gc): the
  // request objects of the uploads hold the frame bytes until a major GC, which a busy render loop
  // never triggers (without it the renderer grew ~15 MB per frame and died ~45 s into a 1080p reel).
  async recordChunk({ n, i0 = 0, fps = 60, start = null, url = '/frame' }) {
    const gl = this.renderer.getContext();
    const W = this.stage.w, H = this.stage.h, bytes = W * H * 4;
    const R = this._rec || (this._rec = { pbo: [0, 1].map(() => { const b = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b); gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ); return b; }), cpu: [new Uint8Array(bytes), new Uint8Array(bytes)], fence: [null, null], pending: null, k: 0 });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const h = 1 / fps;
    if (start !== null && start !== undefined) { this.seek(start); this.camLog.length = 0; this._recFirst = true; }
    const times = [];
    const post = async (k, idx) => {
      // wait for the GPU copy of frame idx, then copy it out and send it
      const f = R.fence[k];
      for (let tries = 0; f && gl.clientWaitSync(f, 0, 0) === gl.TIMEOUT_EXPIRED; tries++) await new Promise((r) => setTimeout(r, tries < 50 ? 0 : 2));
      if (f) gl.deleteSync(f);
      R.fence[k] = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, R.pbo[k]);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, R.cpu[k]);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      if (R.pending) await R.pending; // in order
      const body = gcOk ? new Blob([R.cpu[k]]) : R.cpu[k];
      R.pending = fetch(`${url}?i=${idx}`, { method: 'POST', body }).then((r) => { if (!r.ok) throw new Error('frame upload failed ' + r.status); });
      if (gcOk && ++R.sent % 30 === 0) { await R.pending; window.gc(); }
    };
    const gcOk = typeof window.gc === 'function';
    R.sent = R.sent || 0;
    let prev = null;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      if (!this._recFirst) this.advance(h);
      this._recFirst = false;
      this.render();
      const k = R.k; R.k ^= 1;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, R.pbo[k]);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      R.fence[k] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const t1 = performance.now();
      if (prev) await post(prev.k, prev.idx);
      prev = { k, idx: i0 + i };
      times.push({ work: t1 - t0, total: performance.now() - t0, T: this.T });
    }
    if (prev) await post(prev.k, prev.idx);
    if (R.pending) await R.pending;
    R.pending = null;
    return { times };
  }
}

const _rv = new THREE.Vector3(), _rd = new THREE.Vector3();
const _t = new THREE.Vector3(), _f = new THREE.Vector3(), _l = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3();
export { ease, tween, envelope, angLerp };
