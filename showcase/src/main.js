// three.js Procedural Animals showcase: every species and every action in one living scene. Uses only the public API
// (createAnimal, listSpecies, loadSpecies, setWorkerFactory, QUALITY) and feature-detects optional
// parts of the Animal (actions, gaits, state.legs, render.setDebug / setCoverings / setQuality,
// motion.debug.targets, attachments), so new species and engines show up without changes here.
import * as THREE from 'three';
import { createAnimal, listSpecies, loadSpecies, setWorkerFactory, QUALITY } from '../../src/index.js';
import { World } from './world.js';
import { CameraRig } from './cameraRig.js';
import { ContactShadows } from './contactShadows.js';
import { DebugViews } from './debugViews.js';
import { Pilot, gaitTable } from './pilot.js';
import { Footfalls } from './footfalls.js';
import { gameCode, highlight } from './codegen.js';
import { describe, forward, left, headPosition, footPositions } from './subject.js';
import { runDemo } from './demo.js';
import { AdaptiveQuality } from './adaptive.js';

/* global __WORKER_SRC__ */
if (typeof __WORKER_SRC__ === 'string') {
  const url = URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' }));
  setWorkerFactory(() => new Worker(url));
}

const $ = (id) => document.getElementById(id);
const T0 = performance.now();
const marks = (window.__marks = { script: Math.round(T0) });
const mark = (k) => { marks[k] = Math.round(performance.now() - T0); };
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
// ?demo: the release demo reel (demo.js) takes over the page: no UI, its own sizing, loop and loader
const DEMO = params.has('demo');
const GROUPS = [['paws', 'Paws'], ['hooves', 'Hooves'], ['birds', 'Birds'], ['swimmers', 'Swimmers'], ['others', 'Others']];
// (the pixel ratio and the grass go first; the hero's coat tier (shellDrop: fewer shells, no fins) only on
// the last steps: dropping the fins and half the shells of the hero, close to the camera, is the most
// visible change of all, and on a desktop it came at the second step (tier 2), so a heavy close-up flipped
// between a hairy and a smooth animal every few seconds; phones keep their earlier shell drop at tier 2)
const TIERS = [
  { pr: 1.75, grass: 1.0, shellDrop: 0 },
  { pr: 1.4, grass: 0.7, shellDrop: 0 },
  { pr: 1.1, grass: 0.45, shellDrop: 0, phoneDrop: 1 },
  { pr: 0.85, grass: 0.3, shellDrop: 1 },
  { pr: 0.7, grass: 0.16, shellDrop: 2 },
];
const QORDER = ['hero', 'high', 'medium', 'low', 'crowd'];
const qualityNames = Object.keys(QUALITY || {}).length ? QORDER.filter((q) => QUALITY[q]) : QORDER;

// ------------------------------------------------------------------ device
const canvas = $('gl');
// (the demo renders the scene into its own multisampled target, the canvas only gets the graded
// full-screen pass: no canvas MSAA; &record reads the canvas back after every frame)
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !DEMO, powerPreference: 'high-performance', preserveDrawingBuffer: TEST || (DEMO && params.has('record')) });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.72;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.info.autoReset = false;
let gpu = '';
try {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
} catch (e) { /* not available */ }
const softwareGPU = /swiftshader|llvmpipe|software|basic render/i.test(gpu);
const phone = Math.min(window.innerWidth, window.innerHeight) < 600;
const touch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const lightGPU = /mali|adreno|powervr|apple gpu|videocore|intel/i.test(gpu);
const weak = phone || lightGPU || (navigator.deviceMemory && navigator.deviceMemory < 4) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
const autoQuality = softwareGPU ? 'low' : weak ? 'medium' : 'high';
// (?tier=0..4 pins the adaptive tier: no adaptation, for reproducible captures)
const pinTier = params.has('tier') ? Math.max(0, Math.min(4, +params.get('tier') | 0)) : null;
let tier = pinTier ?? (TEST ? 3 : softwareGPU ? 4 : phone ? 2 : weak ? 1 : 0);
const dprCap = TEST ? 1 : phone ? 2 : 2;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.03, 6000);
camera.position.set(4, 1.6, 5);
const cameraB = new THREE.PerspectiveCamera(36, 1, 0.03, 6000);
const grassK = +(params.get('grass') ?? (DEMO ? 1 : softwareGPU ? 0.25 : phone ? 0.5 : 1));
const world = new World(renderer, scene, { grassNear: Math.round(90000 * grassK), grassFar: Math.round(40000 * grassK), shadowSize: DEMO ? 2048 : phone || softwareGPU ? 1024 : 2048, envSize: softwareGPU ? 64 : 128, tod: +(params.get('tod') ?? 0.15) });
mark('world');
const env = world.env;
const fog = scene.fog;
// cameras stay above the ground and above the lake surface
const rig = new CameraRig(camera, canvas, (x, z) => { const w = world.waterAt(x, z); return w == null ? world.ground(x, z) : Math.max(w + 0.05, world.ground(x, z)); }, (x, z) => world.ground(x, z));
rig.sunDir = env.sunDir;
const contact = new ContactShadows(world.ground, (x, z) => world.normal(x, z));
scene.add(contact.mesh);
mark('contact');
const pilot = new Pilot(world);
// the hero stands still until the viewer drives it; ?autopilot starts it wandering on its own
pilot.mode = params.has('autopilot') && params.get('autopilot') !== '0' ? 'auto' : 'manual';
pilot.camera = camera;
const footfalls = new Footfalls($('gaitCanvas'), $('gaitName'), $('gaitTitle'));
const marker = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.24, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe3a23b, transparent: true, opacity: 0.9, depthWrite: false }));
marker.visible = false;
scene.add(marker);

// ------------------------------------------------------------------ state
const S = {
  species: params.get('species') || 'cheetah',
  seed: +(params.get('seed') ?? 1) >>> 0,
  sex: params.get('sex') || '',
  age: params.get('age') || 'adult',
  variant: params.get('variant') || '', // species variant (e.g. ?species=snake&variant=rattlesnake)
  quality: params.get('quality') || 'auto',
  timeScale: 1,
  coverings: true, skeleton: false, weights: false, sdf: false, footfalls: true, perf: params.has('perf'),
  crowd: false, crowdN: 30,
  compare: false, cmpSpecies: null, cmpSeed: 2,
};
const meta = {}; // species id -> { id, name, latin, group, plan }
let hero = null, heroInfo = null, heroGaits = null, debug = null;
let heroToken = 0;
const crowd = { members: [], token: 0, building: false, cpuMs: 0 };
const cmp = { animal: null, info: null, token: 0, offset: new THREE.Vector3() };
let pendingAction = null;
const activeActions = new Set();
let firstFrameMs = null, firstAnimalFrameMs = null;

const resolvedQuality = () => (S.quality === 'auto' ? autoQuality : S.quality);

// ------------------------------------------------------------------ lighting shim
// The coat materials use the scene lights; while the core still carries its own sun/sky uniforms we
// keep them in sync so the animals match the world. Feature-detected: a no-op once they are gone.
const eyeAmb = new THREE.Color();
function syncLighting(a) {
  if (!a) return;
  const u = a.render?.uniforms;
  if (u) {
    u.uSunDir?.value.copy(env.sunDir);
    u.uSunColor?.value.copy(env.sunColor).multiplyScalar(env.sun.intensity);
    u.uSkyColor?.value.copy(env.skyAmb);
    u.uGroundColor?.value.copy(env.groundAmb);
  }
  // the sky's diffuse light, as the terrain gets it from scene.environment
  // (?envlight=0: off, the old look, for comparisons)
  a.render?.setEnvironmentLight?.(params.get('envlight') === '0' ? null : env.animalSH || null);
  eyeAmb.copy(env.skyAmb).add(env.groundAmb).multiplyScalar(0.9);
  a.render?.eyeRig?.syncEnvironment?.(scene.environment, eyeAmb);
}
const allAnimals = () => [hero, cmp.animal, ...crowd.members.map((m) => m.animal)].filter(Boolean);
// the sky's light probe is read back asynchronously: hand it to every animal when it lands
// (?envk=, ?envsat=: the animals' share of the sky light and its saturation, see Environment.makeAnimalLight)
if (params.has('envk')) env.animalSky.gain = +params.get('envk');
if (params.has('envsat')) env.animalSky.sat = +params.get('envsat');
env.makeAnimalLight();
env.onLight = () => allAnimals().forEach(syncLighting);
if (env.envSH) env.onLight();

// ------------------------------------------------------------------ loader / progress
const loader = $('loader');
let loaderOpen = true;
function progressUI(p, step) {
  if (loaderOpen) {
    $('loadBar').style.width = Math.round(p * 100) + '%';
    let seen = false;
    for (const li of document.querySelectorAll('#steps li')) {
      if (li.dataset.k === step) { li.className = 'on'; seen = true; } else li.className = seen ? '' : 'ok';
    }
  } else {
    $('toast').hidden = false;
    $('toastBar').style.width = Math.round(p * 100) + '%';
  }
}
function progressFn(jobsGuess = 3) {
  let meshed = 0;
  return (msg) => {
    const m = String(msg);
    if (m.startsWith('mesh')) { meshed++; progressUI(Math.min(0.55, (meshed / (jobsGuess + 1)) * 0.6), 'mesh'); }
    else if (m === 'finish') progressUI(0.6, 'weights');
    else if (m === 'weights') progressUI(0.68, 'weights');
    else if (m === 'coat') progressUI(0.84, 'coat');
  };
}
function toast(text) { $('toastText').textContent = text; $('toast').hidden = false; $('toastBar').style.width = '4%'; }
function hideToast() { $('toast').hidden = true; }
function showError(e) {
  console.error(e);
  if (loaderOpen) $('err').textContent = String(e && e.message ? e.message : e);
  else { $('toastText').textContent = 'Build failed: ' + (e && e.message ? e.message : e); $('toast').hidden = false; setTimeout(hideToast, 6000); }
}
const latinHTML = (l) => { const [g, ...r] = String(l || '').split(' '); return `<i>${g}</i> ${r.join(' ')}`; };

// ------------------------------------------------------------------ species list
async function loadMeta() {
  const ids = listSpecies();
  await Promise.all(ids.map(async (id) => {
    try {
      const s = await loadSpecies(id);
      meta[id] = { id, name: s.name || id, latin: s.latin || '', group: s.group || 'others', plan: s.plan || 'quadruped', variants: variantsOf(s) };
    } catch (e) { console.warn('showcase: could not load species', id, e); }
  }));
  if (!meta[S.species]) S.species = Object.keys(meta)[0];
  const list = $('speciesList');
  list.innerHTML = '';
  const byGroup = {};
  for (const m of Object.values(meta)) (byGroup[m.group] = byGroup[m.group] || []).push(m);
  const known = GROUPS.map((g) => g[0]);
  const groups = [...GROUPS, ...Object.keys(byGroup).filter((g) => !known.includes(g)).map((g) => [g, g])];
  for (const [g, label] of groups) {
    const items = byGroup[g];
    if (!items) continue;
    items.sort((a, b) => a.name.localeCompare(b.name));
    const div = document.createElement('div');
    div.className = 'sgroup';
    div.innerHTML = `<div class="gl">${label} · ${items.length}</div><div class="items"></div>`;
    for (const m of items) {
      const b = document.createElement('button');
      b.className = 'sp';
      b.dataset.id = m.id;
      b.setAttribute('aria-pressed', String(m.id === S.species));
      b.innerHTML = `<span>${m.name}</span><i>${m.latin}</i>`;
      b.addEventListener('click', () => { if (S.species !== m.id) { setSpecies(m.id); spawnHero(); } });
      div.querySelector('.items').appendChild(b);
    }
    list.appendChild(div);
  }
  const sel = $('cmpSpecies');
  sel.innerHTML = Object.values(meta).map((m) => `<option value="${m.id}">${m.name} · ${m.latin}</option>`).join('');
  sel.value = S.species;
  S.cmpSpecies = S.species;
  buildVariantUI();
}
function setSpecies(id) {
  S.species = id;
  S.variant = '';
  syncSpeciesButtons();
  buildVariantUI();
}
// species.variants: [{ id, name, latin }] (or plain keys); opts.variant picks one
const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
function variantsOf(s) {
  const v = Array.isArray(s?.variants) ? s.variants : [];
  return v.map((x) => (typeof x === 'string' ? { id: x, name: cap(x), latin: '' } : x && (x.id ?? x.key) ? { id: String(x.id ?? x.key), name: x.name || cap(x.id ?? x.key), latin: x.latin || '' } : null)).filter(Boolean);
}
// the variant an individual was built as: params.variant (the contract), else a morph named like a variant
function resolvedVariant(a, m) {
  const vs = m?.variants || [];
  if (!vs.length || !a) return null;
  const p = a.params || {};
  return vs.find((v) => v.id === p.variant) || vs.find((v) => v.id === p.morph) || vs.find((v) => v.id === S.variant) || null;
}
// names shown for the animal on screen: the variant's when it has its own
function namesOf(a, m) {
  const v = resolvedVariant(a, m);
  return { name: v?.name || m?.name || '', latin: v?.latin || m?.latin || '', variant: v };
}
function buildVariantUI() {
  const m = meta[S.species], vs = m?.variants || [];
  $('variantRow').hidden = !vs.length;
  const box = $('variantList');
  box.innerHTML = '';
  if (!vs.length) return;
  const add = (id, name, latin) => {
    const b = document.createElement('button');
    b.className = 'sp';
    b.dataset.v = id;
    b.innerHTML = `<span>${name}</span><i>${latin || '&nbsp;'}</i>`;
    b.addEventListener('click', () => { if (S.variant !== id) { S.variant = id; syncVariantButtons(); spawnHero(); } });
    box.appendChild(b);
  };
  add('', 'From seed', 'the seed decides');
  for (const v of vs) add(v.id, v.name, v.latin);
  syncVariantButtons();
}
function syncVariantButtons() {
  const got = hero && hero.id === S.species ? resolvedVariant(hero, meta[S.species]) : null;
  document.querySelectorAll('#variantList .sp').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === S.variant));
    b.classList.toggle('auto', !S.variant && !!got && b.dataset.v === got.id);
  });
}
const syncSpeciesButtons = () => document.querySelectorAll('#speciesList .sp').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === S.species)));

// ------------------------------------------------------------------ hero
// createAnimal with a fallback: some hosts forbid (blob) workers; then build on the main thread
let workersBroken = false;
async function build(species, opts) {
  if (workersBroken) return createAnimal(species, { ...opts, worker: false });
  try { return await createAnimal(species, opts); } catch (e) {
    if (!/worker/i.test(String(e && e.message))) throw e;
    console.warn('showcase: workers unavailable, building on the main thread', e);
    workersBroken = true;
    return createAnimal(species, { ...opts, worker: false });
  }
}
function animalOpts(info, extra = {}) {
  return {
    ground: world.ground,
    water: world.waterAt,
    perches: world.perches.map((p) => p.position.clone()),
    ...extra,
  };
}

async function spawnHero() {
  const token = ++heroToken;
  const m = meta[S.species] || { name: S.species, latin: '', plan: 'quadruped' };
  const q = resolvedQuality();
  const pv = (m.variants || []).find((v) => v.id === S.variant);
  if (loaderOpen) { $('loadName').innerHTML = latinHTML(pv?.latin || m.latin || m.name); progressUI(0.03, 'mesh'); }
  else toast(`Building ${(pv?.name || m.name).toLowerCase()} · seed ${S.seed} · ${q}`);
  // keep the old animal's place; swimmers start in the lake, land animals out of it
  const swimmer = m.plan === 'swimmer';
  let pos, heading = hero ? hero.heading : 0.6;
  if (hero && !!heroInfo?.swimmer === swimmer) { pos = hero.position.clone(); if (!swimmer) pos.y = world.ground(pos.x, pos.z); }
  else pos = world.spawnPoint({ swimmer, scale: 1 });
  if (!swimmer && world.depthAt(pos.x, pos.z) > 0.02) pos = world.spawnPoint({ swimmer: false });
  if (swimmer && world.depthAt(pos.x, pos.z) < 0.3) pos = world.wetPoint(pos, 0.3);
  const t0 = performance.now();
  let a;
  try {
    a = await build(S.species, animalOpts(null, {
      seed: S.seed, quality: q, sex: S.sex || undefined, age: S.age || undefined, variant: S.variant || undefined,
      position: pos, heading, onProgress: progressFn(),
    }));
  } catch (e) {
    if (token === heroToken) { showError(e); hideLater(); }
    return;
  }
  if (token !== heroToken) { a.dispose(); return; }
  progressUI(0.95, 'gpu');
  const buildMs = a.data?.stats?.buildMs || performance.now() - t0;
  // swap (a cruise speed means nothing to another species: stop, keep the seed / quality settings)
  if (hero && hero.id !== a.id) { pilot.cruise = 0; pilot.gait = null; $('speed').value = 0; }
  if (hero) { hero.dispose(); debug?.dispose(); }
  hero = a;
  hero.buildWallMs = performance.now() - t0;
  heroInfo = describe(hero);
  // a big swimmer (a 4 m great white) that was placed in shallow water moves to the deep basin, at
  // mid depth
  if (heroInfo.swimmer && world.depthAt(hero.position.x, hero.position.z) < Math.max(0.3, 0.35 * heroInfo.span) && hero.motion.reset) {
    const p = world.spawnPoint({ swimmer: true, scale: heroInfo.scale });
    const g = world.ground(p.x, p.z);
    p.y = Math.max(g + 0.5 * (world.waterLevel - g), world.waterLevel - Math.max(0.25, 0.4 * heroInfo.span));
    hero.motion.reset(p, hero.heading);
  }
  heroGaits = gaitTable(hero, heroInfo);
  if (!S.variant) syncVariantButtons();
  scene.add(hero.object);
  hero.object.userData.showcase = 'hero';
  debug = new DebugViews(scene, hero, heroInfo);
  applyDebug();
  resetAdapt();
  if (tierShellDrop()) applyTier();
  syncLighting(hero);
  wireEvents(hero, true);
  rig.setScale(heroInfo.scale);
  cameraB.near = camera.near;
  cameraB.updateProjectionMatrix();
  rig.cut();
  rig.focus.copy(hero.position);
  camera.position.copy(hero.position).add(new THREE.Vector3(3.5, 1.2, 4).multiplyScalar(heroInfo.scale));
  pilot.attach(hero, heroInfo, heroGaits);
  footfalls.reset(heroInfo);
  pendingAction = null;
  marker.visible = false;
  activeActions.clear();
  buildActionsUI();
  buildGaitUI();
  updateTitle(buildMs);
  updateCode();
  setShadows();
  // climb / dive buttons for flyers and swimmers (also on desktop: Space / C do the same)
  $('climb').hidden = !(heroInfo.flyer || heroInfo.swimmer);
  $('climb').querySelector('[data-c="1"]').setAttribute('aria-label', heroInfo.swimmer ? 'Rise' : 'Climb');
  $('climb').querySelector('[data-c="-1"]').setAttribute('aria-label', heroInfo.swimmer ? 'Dive' : 'Descend');
  $('altStat').hidden = !(heroInfo.flyer || heroInfo.swimmer);
  document.querySelector('.climbHint').hidden = !(heroInfo.flyer || heroInfo.swimmer);
  $('climbWord').textContent = heroInfo.swimmer ? 'rise / dive' : 'climb / descend';
  $('altK').textContent = heroInfo.swimmer ? 'depth m' : 'alt m';
  $('crowdLabel').textContent = `${cap(groupWord(heroInfo))} of this species`;
  document.body.classList.toggle('swimmerHero', !!heroInfo.swimmer);
  world.setWaterClarity?.(heroInfo.swimmer ? 1 : 0);
  if (S.crowd) rebuildCrowd();
  if (S.compare && (!cmp.animal || cmp.linked)) spawnCompare(true);
  hideLater();
}
function hideLater() {
  if (loaderOpen) {
    requestAnimationFrame(() => {
      loader.classList.add('done');
      loaderOpen = false;
      setTimeout(() => { loader.hidden = true; }, 900);
    });
  } else setTimeout(hideToast, 250);
}

function updateTitle(buildMs) {
  const m = meta[S.species] || {};
  const d = hero.data, p = hero.params || {};
  const N = namesOf(hero, m);
  $('tName').innerHTML = latinHTML(N.latin || N.name);
  $('tSub').textContent = [N.name, 'seed ' + S.seed, p.sex, p.age, hero.quality].filter(Boolean).join(' · ');
  const st = d.stats || {};
  $('buildNote').innerHTML = `Built in your browser in <b>${(buildMs / 1000).toFixed(1)} s</b>: <b>${(d.nV || 0).toLocaleString()}</b> vertices, <b>${Math.round((d.index?.length || 0) / 3).toLocaleString()}</b> triangles from <b>${st.prims ?? d.prims?.length ?? '–'}</b> SDF primitives, <b>${d.bones?.length || '–'}</b> bones. Plan: <b>${m.plan}</b>${N.variant ? `, variant <b>${N.variant.id}</b>` : ''}.`;
  document.title = `${N.name} · THREE.JS PROCEDURAL ANIMALS`;
}

// ------------------------------------------------------------------ events
const _dir = new THREE.Vector3();
function wireEvents(a, isHero) {
  const info = () => (a === hero ? heroInfo : a === cmp.animal ? cmp.info : null);
  a.on('footstep', (e) => {
    const inf = info() || heroInfo;
    const p = e.position;
    if (!p) return;
    if (a === hero) footfalls.onFootstep(e, simTime);
    if (world.isWater(p.x, p.z) && p.y < world.waterLevel + 0.1 * inf.scale) env.ripples.emit(p, 0.6 * inf.scale + (e.speed || 0) * 0.05);
    else if ((e.speed || 0) > 4.5 * Math.sqrt(inf.scale)) env.dust.emit(p, forward(a.heading, _dir), e.speed, Math.min(10, Math.round(e.speed / 3)), inf.scale);
  });
  // swimmers leaving / re-entering the water ring the surface
  for (const type of ['takeoff', 'land']) a.on(type, (e) => { const inf = info() || heroInfo; if (inf.swimmer && e.position) env.ripples.emit(e.position, 1.5 * inf.span + 0.1); });
  if (!isHero) return;
  a.on('actionStart', (e) => { activeActions.add(e.name); syncActionChips(); });
  a.on('actionEnd', (e) => { activeActions.delete(e.name); syncActionChips(); });
  a.on('death', () => { activeActions.add('death'); syncActionChips(); });
}

// ------------------------------------------------------------------ actions
function actionList() { return (hero?.actions || []).filter((n) => n !== 'idle'); }
function buildActionsUI() {
  const box = $('actions');
  box.innerHTML = '';
  const list = actionList();
  if (!list.length) {
    box.innerHTML = '<span class="chip" aria-disabled="true" style="opacity:.6">no actions yet for this species (idle only)</span>';
    return;
  }
  list.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (name === 'death' ? ' warn' : '');
    b.dataset.action = name;
    b.textContent = name;
    b.title = i < 9 ? `${name} (key ${i + 1})` : name;
    b.addEventListener('click', () => playAction(name, true));
    box.appendChild(b);
  });
}
// posture chips follow motion.state.posture (a lying animal that is asked to move stands up and the
// Lie chip goes off); one-shot chips are on while the action runs (state.action) or was just pressed
const POSTURE_CHIPS = { sit: 'sit', lie: 'lie', sleep: 'sleep', death: 'dead', coil: 'coil', perch: 'perch' };
let chipKey = '';
function syncActionChips() {
  const st = hero?.state || {};
  chipKey = (st.posture || '') + '|' + (st.action || '') + '|' + [...activeActions].join(',');
  document.querySelectorAll('#actions .chip[data-action]').forEach((b) => {
    const n = b.dataset.action, pst = POSTURE_CHIPS[n];
    const on = pst ? st.posture === pst || (n === 'perch' && st.mode === 'perch') : activeActions.has(n) || st.action === n;
    b.classList.toggle('on', on);
  });
}
function syncActionChipsIfChanged() {
  const st = hero?.state || {};
  if ((st.posture || '') + '|' + (st.action || '') + '|' + [...activeActions].join(',') !== chipKey) syncActionChips();
}
function actionOpts(name, a) {
  if (name === 'perch') {
    const p = world.nearestPerch(a.position);
    if (p) return { target: p.position.clone(), position: p.position.clone() };
  }
  if (name === 'attack' || name === 'strike') {
    const inf = a === hero ? heroInfo : a === cmp.animal ? cmp.info : heroInfo;
    return { target: a.position.clone().addScaledVector(forward(a.heading), 0.6 * inf.span + 0.2 * inf.scale) };
  }
  return {};
}
function playOn(a, name) {
  try {
    const r = a.play(name, actionOpts(name, a));
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (e) { console.warn('showcase: action failed', name, e); }
}
function playAction(name, fromUser = false) {
  if (!hero) return;
  if (fromUser) {
    if (pilot.mode === 'auto') { pilot.setMode('manual'); pilot.cruise = 0; syncControls(); }
    // postures and perching / landing take over locomotion: stop cruising so they are not overridden
    if (/^(sit|lie|sleep|perch|land|coil|death)$/.test(name) && (pilot.cruise > 0 || pilot.target)) {
      pilot.setCruise(0, null); pilot.target = null; $('speed').value = 0; marker.visible = false; syncControls();
    }
    // drinking needs water: walk to the shore first, then drink
    if (name === 'drink' && !heroInfo.swimmer && !heroInfo.flyer) {
      const shore = world.shorePoint(hero.position, heroInfo);
      if (shore && shore.distanceTo(hero.position) > 0.6 * heroInfo.span + 0.1 * heroInfo.scale) {
        pendingAction = 'drink';
        sendTo(shore);
        return;
      }
    }
  }
  for (const a of [hero, cmp.animal]) if (a) playOn(a, name);
  activeActions.add(name);
  syncActionChips();
  setTimeout(() => { if (!hero?.state?.action || hero.state.action !== name) { activeActions.delete(name); syncActionChips(); } }, 1500);
  updateCode(name);
}
pilot.onAction = (name) => playAction(name);
pilot.onStatus = () => {};

// ------------------------------------------------------------------ gaits & speed
function buildGaitUI() {
  const seg = $('gaitSeg');
  seg.innerHTML = '';
  const add = (label, speed, gait) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.speed = speed;
    b.dataset.gait = gait || '';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { pilot.setCruise(speed, gait || null); $('speed').value = speed; syncControls(); updateCode(); });
    seg.appendChild(b);
  };
  add('Stand', 0, '');
  for (const g of heroGaits.list) add(g.name, +g.speed.toFixed(2), g.name);
  const sp = $('speed');
  sp.max = String(+heroGaits.max.toPrecision(3));
  sp.step = 'any'; // a spider's 0.2 m/s and a cheetah's 30 m/s on the same slider
  sp.value = pilot.cruise;
  syncControls();
}
function syncControls() {
  $('autoBtn').setAttribute('aria-pressed', String(pilot.mode === 'auto'));
  const manual = pilot.mode === 'manual';
  document.querySelectorAll('#gaitSeg button').forEach((b) => {
    const on = manual && (b.dataset.gait ? b.dataset.gait === pilot.gait : pilot.cruise === 0);
    b.setAttribute('aria-pressed', String(on));
  });
  const v = +$('speed').value;
  $('speedOut').textContent = v > 0 && v < 0.95 ? `${(v * 100).toFixed(0)} cm/s · ${(v * 3.6).toFixed(1)} km/h` : `${v.toFixed(1)} m/s · ${(v * 3.6).toFixed(0)} km/h`;
}
$('speed').addEventListener('input', (e) => { pilot.setCruise(+e.target.value, null); syncControls(); });
$('speed').addEventListener('change', () => updateCode());
$('autoBtn').addEventListener('click', () => {
  if (pilot.mode === 'auto') { pilot.setMode('manual'); pilot.cruise = 0; $('speed').value = 0; }
  else pilot.setMode('auto');
  pendingAction = null;
  syncControls();
});

// ------------------------------------------------------------------ click / tap to move
const ray = new THREE.Raycaster();
let down = null, markerT = 0;
function pickGround(e) {
  const r = canvas.getBoundingClientRect();
  let x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  let cam = camera;
  if (S.compare && cmp.animal) {
    const portrait = r.height > r.width;
    const second = portrait ? y > 0.5 : x > 0.5;
    if (portrait) y = (y % 0.5) * 2; else x = (x % 0.5) * 2;
    if (second) cam = cameraB;
  }
  ray.setFromCamera(new THREE.Vector2(x * 2 - 1, -y * 2 + 1), cam);
  const o = ray.ray.origin, d = ray.ray.direction;
  const p = new THREE.Vector3();
  // march the ray over the height field; steps scale with the animal (a spider is clicked from 15 cm)
  const k = Math.min(1, heroInfo?.scale || 1);
  let t = cam.near * 2;
  for (let i = 0; i < 3000; i++) {
    p.copy(o).addScaledVector(d, t);
    const wl = heroInfo?.swimmer ? null : world.waterAt(p.x, p.z);
    const h = wl == null ? world.ground(p.x, p.z) : Math.max(wl, world.ground(p.x, p.z));
    if (p.y < h) {
      if (cam === cameraB) p.sub(cmp.offset);
      return p;
    }
    t += Math.max(0.03 * k, t * 0.01);
    if (t > 600) break;
  }
  return null;
}
function sendTo(p) {
  if (!hero) return;
  const tp = p.clone();
  if (heroInfo.swimmer) {
    // swimmers: the nearest open water, at the depth the animal swims at now
    if (world.depthAt(tp.x, tp.z) < Math.max(0.15, heroInfo.height * 1.5)) tp.copy(world.wetPoint(tp, Math.max(0.15, heroInfo.height * 1.5)));
    tp.y = THREE.MathUtils.clamp(hero.position.y, world.ground(tp.x, tp.z) + heroInfo.height, world.waterLevel - heroInfo.height * 0.6);
  } else if (heroInfo.flyer) tp.y = Math.max(world.ground(tp.x, tp.z), hero.position.y);
  else {
    if (world.depthAt(tp.x, tp.z) > 0.25 * heroInfo.height) { const s = world.shorePoint(tp, heroInfo); if (s) tp.copy(s); }
    tp.y = world.ground(tp.x, tp.z);
  }
  pilot.setTarget(tp);
  marker.position.set(tp.x, (heroInfo.swimmer ? world.waterLevel : world.ground(tp.x, tp.z)) + Math.max(0.002, 0.02 * Math.min(1, heroInfo.scale)), tp.z);
  marker.scale.setScalar(Math.max(0.12, Math.min(3, heroInfo.span * 0.45)));
  marker.visible = true;
  markerT = 0;
  syncControls();
}
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dtp = performance.now() - down.t;
  down = null;
  if (moved > 8 || dtp > 500) return;
  const p = pickGround(e);
  if (p) { pendingAction = null; sendTo(p); }
});

// ------------------------------------------------------------------ keyboard
const KEYS = { w: 'fwd', arrowup: 'fwd', s: 'back', arrowdown: 'back', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right', shift: 'run', e: 'up', pageup: 'up', q: 'down', c: 'down', pagedown: 'down' };
const typing = (e) => e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
window.addEventListener('keydown', (e) => {
  if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') {
    e.preventDefault();
    if (heroInfo && (heroInfo.flyer || heroInfo.swimmer)) pilot.keys.add('up');
    else if (actionList().includes('jump')) playAction('jump', false);
    return;
  }
  if (KEYS[k]) {
    if (e.target && e.target.type === 'range') return;
    pilot.keys.add(KEYS[k]);
    if (['fwd', 'back', 'left', 'right'].includes(KEYS[k]) && pilot.mode !== 'manual') { pilot.setMode('manual'); pilot.cruise = 0; $('speed').value = 0; syncControls(); }
    if (k.startsWith('arrow')) e.preventDefault();
    return;
  }
  if (/^[1-9]$/.test(k)) { const n = actionList()[+k - 1]; if (n) playAction(n, true); return; }
  if (k === 'p') $('autoBtn').click();
  if (k === 'escape') { $('panel').hidden || togglePanel(false); }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === ' ') { pilot.keys.delete('up'); return; }
  if (KEYS[k]) pilot.keys.delete(KEYS[k]);
});
window.addEventListener('blur', () => pilot.keys.clear());

// ------------------------------------------------------------------ touch joystick + climb buttons
if (touch) {
  const joy = $('joy'), knob = joy.querySelector('.knob');
  joy.hidden = false;
  let id = null;
  const R = 50;
  const setKnob = (x, y) => { knob.style.transform = `translate(${x * R}px, ${y * R}px)`; };
  const move = (e) => {
    const r = joy.getBoundingClientRect();
    let x = (e.clientX - (r.left + r.width / 2)) / R, y = (e.clientY - (r.top + r.height / 2)) / R;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    pilot.stick.x = x; pilot.stick.y = y;
    setKnob(x, y);
  };
  joy.addEventListener('pointerdown', (e) => {
    id = e.pointerId;
    joy.setPointerCapture(id);
    pilot.stick.active = true;
    if (pilot.mode !== 'manual') { pilot.setMode('manual'); pilot.cruise = 0; $('speed').value = 0; syncControls(); }
    move(e);
  });
  joy.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
  const end = (e) => { if (e.pointerId !== id) return; id = null; pilot.stick.active = false; pilot.stick.x = pilot.stick.y = 0; setKnob(0, 0); };
  joy.addEventListener('pointerup', end);
  joy.addEventListener('pointercancel', end);
}
// climb / dive buttons (flyers and swimmers; hold to climb)
for (const b of document.querySelectorAll('#climb button')) {
  b.addEventListener('pointerdown', (e) => { try { b.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } pilot.climbBtn = +b.dataset.c; });
  const off = () => { pilot.climbBtn = 0; };
  b.addEventListener('pointerup', off);
  b.addEventListener('pointercancel', off);
  b.addEventListener('lostpointercapture', off);
}

// ------------------------------------------------------------------ panel & controls
function togglePanel(open) {
  const p = $('panel');
  p.hidden = !open;
  $('panelBtn').setAttribute('aria-expanded', String(open));
}
$('panelBtn').addEventListener('click', () => togglePanel($('panel').hidden));
// the controls start open; ?panel=0 starts with them closed
if (params.get('panel') === '0') togglePanel(false);
$('panelClose').addEventListener('click', () => togglePanel(false));
function selectTab(name) {
  document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.dataset.tab !== name; });
  $('panel').classList.toggle('wide', name === 'code');
  if (name === 'code') updateCode();
}
document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

const segSelect = (id, fn) => {
  const btns = [...document.querySelectorAll(`#${id} button`)];
  btns.forEach((b) => b.addEventListener('click', () => { btns.forEach((x) => x.setAttribute('aria-pressed', String(x === b))); fn(b.dataset.v, b); }));
  return btns;
};
const setSeg = (id, v) => document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
segSelect('sexSeg', (v) => { S.sex = v; spawnHero(); });
segSelect('ageSeg', (v) => { S.age = v; spawnHero(); });
setSeg('sexSeg', S.sex);
setSeg('ageSeg', S.age);
segSelect('tsSeg', (v) => { S.timeScale = +v; });
const camBtns = [...document.querySelectorAll('#camSeg button')];
const compactCam = matchMedia('(max-width: 760px)');
const CAMS = ['orbit', 'follow', 'director'];
camBtns.forEach((b) => b.addEventListener('click', () => {
  // on phones only the active mode is shown: tapping it cycles to the next camera
  const m = compactCam.matches && b.dataset.cam === rig.mode ? CAMS[(CAMS.indexOf(rig.mode) + 1) % CAMS.length] : b.dataset.cam;
  rig.setMode(m);
}));
rig.onMode = (m) => camBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cam === m)));

$('seed').value = S.seed;
$('seed').addEventListener('change', (e) => { S.seed = Math.max(0, Math.floor(+e.target.value || 0)) >>> 0; e.target.value = S.seed; spawnHero(); });
$('seed').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('dice').addEventListener('click', () => { S.seed = Math.floor(Math.random() * 100000); $('seed').value = S.seed; spawnHero(); });
$('rebuild').addEventListener('click', () => { S.seed = Math.max(0, Math.floor(+$('seed').value || 0)) >>> 0; spawnHero(); });
$('quality').value = S.quality;
const autoOpt = () => { $('quality').querySelector('option[value="auto"]').textContent = `Auto · ${autoQuality}`; };
autoOpt();
$('quality').addEventListener('change', (e) => { S.quality = e.target.value; spawnHero(); });
for (const o of $('quality').options) if (o.value !== 'auto' && !qualityNames.includes(o.value)) o.disabled = true;

const todOut = () => { const h = 6 + S.tod * 13; $('todOut').textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`; };
S.tod = env.tod;
$('tod').value = S.tod;
todOut();
let todTimer = 0;
$('tod').addEventListener('input', (e) => {
  S.tod = +e.target.value;
  env.setTimeOfDay(S.tod, false);
  todOut();
  clearTimeout(todTimer);
  todTimer = setTimeout(() => { env.setTimeOfDay(S.tod, true); allAnimals().forEach(syncLighting); }, 180);
});
$('tGrass').addEventListener('change', (e) => { world.grass.visible = e.target.checked; });
$('tShadows').addEventListener('change', (e) => { env.sun.castShadow = e.target.checked; });
$('tFog').addEventListener('change', (e) => { scene.fog = e.target.checked ? fog : null; });

function applyDebug() {
  if (!hero) return;
  for (const a of [hero, cmp.animal]) {
    if (!a) continue;
    a.render?.setCoverings?.(S.coverings);
    a.render?.setDebug?.('weights', S.weights);
    a.object.visible = !S.sdf;
  }
  if (debug) { debug.skel.visible = S.skeleton; debug.sdf.visible = S.sdf; }
}
const bindToggle = (id, key, fn) => { const el = $(id); el.checked = !!S[key]; el.addEventListener('change', () => { S[key] = el.checked; (fn || applyDebug)(); }); };
bindToggle('tCover', 'coverings');
bindToggle('tSkel', 'skeleton');
bindToggle('tWeights', 'weights');
bindToggle('tSdf', 'sdf');
bindToggle('tGait', 'footfalls', () => { $('gaitCard').hidden = !S.footfalls; });
bindToggle('tPerf', 'perf', () => { $('perf').hidden = !S.perf; });
$('perf').hidden = !S.perf;

// ------------------------------------------------------------------ code panel
let codeText = '';
function updateCode(lastAction) {
  if (!hero) return;
  const m = meta[S.species] || {};
  const g = pilot.gait;
  const N = namesOf(hero, m);
  codeText = gameCode({
    species: S.species, name: N.name || m.name || S.species, latin: N.latin || m.latin || '', plan: m.plan, seed: S.seed,
    variant: S.variant || '', variantNote: !S.variant && N.variant ? `variant '${N.variant.id}' from the seed` : '',
    quality: hero.quality, sex: S.sex, age: S.age, actions: actionList(), lastAction,
    gait: g, speed: pilot.cruise > 0 ? pilot.cruise : heroGaits?.walk || 1.25,
    buildSec: ((hero.buildWallMs || 0) / 1000).toFixed(1), water: !!heroInfo?.swimmer,
  });
  $('code').innerHTML = highlight(codeText);
}
$('copy').addEventListener('click', async () => {
  const b = $('copy');
  let ok = false;
  try { await navigator.clipboard.writeText(codeText); ok = true; } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = codeText; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
  }
  b.textContent = ok ? 'Copied' : 'Select & copy';
  setTimeout(() => { b.textContent = 'Copy'; }, 1600);
});

// ------------------------------------------------------------------ crowd
// One behaviour per body plan, everything in units of the animal's own size (a cluster of 3 cm
// spiders packs as tightly, relatively, as a herd of horses): land animals follow the hero in a loose
// herd, flocks take off and circle above the hero (or fly with it when it flies), schools mill round
// the hero in the lake and follow it when it swims off.
const groupWord = (info) => (info.flyer ? 'flock' : info.swimmer ? 'school' : info.plan === 'quadruped' ? 'herd' : 'group');
$('crowdN').addEventListener('input', (e) => { S.crowdN = +e.target.value; $('crowdNOut').textContent = S.crowdN; });
$('crowdN').addEventListener('change', () => { if (S.crowd) rebuildCrowd(); });
bindToggle('tCrowd', 'crowd', () => {
  if (S.crowd) { rebuildCrowd(); if (!S.perf) { S.perf = true; $('tPerf').checked = true; $('perf').hidden = false; } }
  else clearCrowd();
  setShadows();
});
// the sun's shadow frustum covers the hero (or the whole crowd) at the hero's scale
function setShadows() {
  if (!heroInfo) return;
  const base = Math.max(0.12, 3.4 * heroInfo.scale);
  env.setShadowExtent(S.crowd ? Math.min(30, Math.max(base, crowd.radius || base * 5)) : base, heroInfo.height);
}
function clearCrowd() {
  crowd.token++;
  for (const m of crowd.members) m.animal.dispose();
  crowd.members.length = 0;
  crowd.building = false;
}
const crowdSpacing = (info) => info.span * (info.flyer ? 2.6 : info.swimmer ? 1.25 : 1.3);
const hash1 = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
async function rebuildCrowd() {
  clearCrowd();
  if (!hero) return;
  const token = crowd.token;
  crowd.building = true;
  const N = S.crowdN, info = heroInfo;
  const seeds = [0, 1, 2, 3, 4, 5].map((k) => (S.seed * 7 + 101 * k + 13) >>> 0);
  const spacing = crowdSpacing(info);
  crowd.spacing = spacing;
  crowd.radius = spacing * Math.sqrt(N + 1) * 0.9 + spacing * 2;
  // flocks circle on a ring a few body lengths above the hero's ground
  // (no tighter than a banked turn at cruise speed allows: r = v^2 / (g tan(bank)), bank ~ 40 deg)
  crowd.ring = Math.max(8 * info.span, spacing * Math.sqrt(N) * 0.6, (heroGaits.fly || 0) ** 2 / 8);
  crowd.alt = Math.max(2.5, 10 * info.span);
  if (info.flyer) crowd.radius = Math.max(crowd.radius, crowd.ring + spacing * 2);
  setShadows();
  // the whole group is the variant the hero is (a school of one kind of fish)
  const variant = S.variant || resolvedVariant(hero, meta[S.species])?.id || undefined;
  const word = groupWord(info);
  toast(`Building a ${word} of ${N} · ${seeds.length} individuals, crowd quality`);
  const t0 = performance.now();
  try {
    for (let i = 0; i < N; i++) {
      const r = spacing * Math.sqrt(i + 2) * 0.9, a = i * 2.39996;
      const L = left(hero.heading), F = forward(hero.heading);
      const sx = Math.cos(a) * r, sz = Math.sin(a) * r - spacing * 1.2;
      const sy = (hash1(i) - 0.5) * spacing * (info.flyer ? 1.2 : 0.8);
      const pos = hero.position.clone().addScaledVector(L, sx).addScaledVector(F, sz);
      if (info.swimmer) {
        if (world.depthAt(pos.x, pos.z) < 0.3) pos.copy(world.wetPoint(pos, 0.3));
        pos.y = THREE.MathUtils.clamp(hero.position.y + sy, world.ground(pos.x, pos.z) + info.height, world.waterLevel - info.height);
      } else {
        if (world.depthAt(pos.x, pos.z) > 0.02) pos.copy(world.spawnPoint(info, new THREE.Vector3(sx, 0, sz)));
        pos.y = world.ground(pos.x, pos.z);
      }
      const a1 = await build(S.species, animalOpts(info, { seed: seeds[i % seeds.length], quality: 'crowd', variant, age: S.age === 'juvenile' && i % 3 ? 'juvenile' : undefined, position: pos, heading: hero.heading + (Math.random() - 0.5) * 0.6, castShadow: !phone }));
      if (token !== crowd.token) { a1.dispose(); return; }
      a1.setLod?.(2);
      scene.add(a1.object);
      syncLighting(a1);
      a1.render?.setCoverings?.(S.coverings);
      const mi = describe(a1);
      crowd.members.push({ animal: a1, info: mi, gaits: gaitTable(a1, mi), slot: new THREE.Vector3(sx, sy, sz), speed: 0, phase: Math.random() * 10, orbit: Math.atan2(sz, sx), i });
      $('toastBar').style.width = Math.round(((i + 1) / N) * 100) + '%';
      $('toastText').textContent = `${cap(word)}: ${i + 1} / ${N}`;
    }
  } catch (e) { showError(e); }
  crowd.building = false;
  crowd.buildMs = performance.now() - t0;
  setTimeout(hideToast, 400);
  $('crowdNote').innerHTML = `A ${word}: <b>${crowd.members.length}</b> animals from <b>${seeds.length}</b> seeds, built in <b>${(crowd.buildMs / 1000).toFixed(1)} s</b> (shared geometry data, one draw call each, crowd motion LOD).`;
}
const _L = new THREE.Vector3(), _F = new THREE.Vector3(), _t = new THREE.Vector3(), _d = new THREE.Vector3();
const clamp = THREE.MathUtils.clamp;
function updateCrowd(dt, time) {
  const M = crowd.members;
  if (!M.length || !hero) return 0;
  const L = left(hero.heading, _L), F = forward(hero.heading, _F);
  const lead = hero.position, leadSpeed = hero.speed || 0;
  const t0 = performance.now();
  const sp = crowd.spacing || heroInfo.span;
  for (let i = 0; i < M.length; i++) {
    const m = M[i], a = m.animal, info = m.info, G = m.gaits, p = a.position;
    if (info.flyer) { flockMember(m, dt, time, lead, leadSpeed, L, F, sp); a.update(dt); continue; }
    const wobA = 0.25 * sp;
    let sx = m.slot.x, sz = m.slot.z;
    if (info.swimmer) {
      // milling: the slots turn round the hero while it hovers, and trail it when it swims
      const still = 1 - clamp(leadSpeed / Math.max(1e-6, G.walk * 1.5), 0, 1);
      const cx = sx, cz = sz + sp * 1.2; // the slot about the disc centre
      m.spin = (m.spin || 0) + (dt * still * G.walk * 1.2) / (Math.hypot(cx, cz) + sp);
      const c = Math.cos(m.spin), s = Math.sin(m.spin);
      sx = cx * c - cz * s; sz = cx * s + cz * c - sp * 1.2 * (1 - still);
    }
    _t.copy(lead).addScaledVector(L, sx + Math.sin(time * 0.13 + m.phase) * wobA).addScaledVector(F, sz + Math.cos(time * 0.11 + m.phase) * wobA);
    if (info.swimmer) {
      if (world.depthAt(_t.x, _t.z) < 2 * info.height) _t.copy(world.wetPoint(_t, 2 * info.height));
      _t.y = clamp(lead.y + m.slot.y, world.ground(_t.x, _t.z) + info.height, world.waterLevel - info.height * 0.8);
    }
    let dx = _t.x - p.x, dz = _t.z - p.z, dy = info.swimmer ? _t.y - p.y : 0;
    // separation from neighbours (a push of up to one body span, never metres)
    const R = info.span * 1.05;
    for (let j = 0; j < M.length; j++) {
      if (j === i) continue;
      const b = M[j].animal.position;
      const ex = p.x - b.x, ez = p.z - b.z, ey = info.swimmer ? p.y - b.y : 0, d2 = ex * ex + ez * ez + ey * ey;
      if (d2 < R * R && d2 > 1e-12) { const d = Math.sqrt(d2), k = ((R - d) / R) * 1.5 * R; dx += (ex / d) * k; dz += (ez / d) * k; dy += (ey / d) * k; }
    }
    const ex = p.x - lead.x, ez = p.z - lead.z, dl = Math.hypot(ex, ez);
    if (dl < R * 1.4 && dl > 1e-9) { dx += (ex / dl) * R; dz += (ez / dl) * R; }
    const dist = Math.hypot(dx, dz);
    const top = G.ground?.length ? G.top : G.list[G.list.length - 1]?.speed || G.walk * 3;
    let want = dist < 0.4 * info.span ? 0 : Math.min(leadSpeed * 1.15 + dist * 0.6, Math.max(leadSpeed * 1.3, G.walk * 2.2), top);
    let heading = dist > 1e-6 ? Math.atan2(dx, dz) : a.heading;
    const ahead = _d.copy(p).addScaledVector(forward(heading), Math.max(info.span, want * 0.5));
    let climb = 0;
    if (info.swimmer) {
      if (world.depthAt(ahead.x, ahead.z) < 1.5 * info.height) { heading = world.awayFromLake(p, true); want = Math.min(want, G.walk); }
      climb = clamp((dy / (dist + info.span)) * 1.5, -1, 1);
    } else if (world.depthAt(ahead.x, ahead.z) > 0.3 * info.height) want = 0;
    m.speed += (want - m.speed) * Math.min(1, dt * 2.5);
    a.move({ speed: m.speed < G.walk * 0.06 ? 0 : m.speed, heading, climb });
    a.update(dt);
  }
  const ms = performance.now() - t0;
  crowd.cpuMs = crowd.cpuMs * 0.9 + (ms / M.length) * 0.1;
  return ms;
}
// a flock: circling a ring above the hero's position (or following the hero when it flies)
function flockMember(m, dt, time, lead, leadSpeed, L, F, sp) {
  const a = m.animal, info = m.info, G = m.gaits, p = a.position;
  const fly = G.fly || G.list[G.list.length - 1]?.speed || 5;
  const heroAir = hero.state?.grounded === false && heroInfo.flyer;
  const gy = world.ground(p.x, p.z);
  if (heroAir) {
    _t.copy(lead).addScaledVector(L, m.slot.x).addScaledVector(F, m.slot.z - sp);
    _t.y = lead.y + m.slot.y;
  } else {
    const ring = crowd.ring + m.slot.x * 0.35;
    m.orbit += (dt * fly * 0.85) / ring;
    const th = m.orbit + 0.35; // aim a little ahead on the ring
    _t.set(lead.x + Math.cos(th) * ring, 0, lead.z + Math.sin(th) * ring);
    _t.y = Math.max(world.ground(_t.x, _t.z), world.waterLevel) + crowd.alt + m.slot.y + Math.sin(time * 0.3 + m.phase) * 0.3 * sp;
  }
  let dx = _t.x - p.x, dz = _t.z - p.z, dy = _t.y - p.y;
  const R = info.span * 1.6;
  for (const o of crowd.members) {
    if (o === m) continue;
    const b = o.animal.position;
    const ex = p.x - b.x, ey = p.y - b.y, ez = p.z - b.z, d2 = ex * ex + ey * ey + ez * ez;
    if (d2 < R * R && d2 > 1e-12) { const d = Math.sqrt(d2), k = ((R - d) / R) * 2 * R; dx += (ex / d) * k; dy += (ey / d) * k; dz += (ez / d) * k; }
  }
  const dist = Math.hypot(dx, dz);
  const heading = dist > 1e-6 ? Math.atan2(dx, dz) : a.heading;
  // always above stall speed once going; the separation / catch-up term trims it
  const along = heroAir ? (dx * Math.sin(hero.heading) + dz * Math.cos(hero.heading)) : dist - sp;
  const want = clamp((heroAir ? Math.max(leadSpeed, fly * 0.8) : fly * 0.95) + along * 0.4, fly * 0.75, fly * 1.3);
  const climb = clamp(dy * 0.8, -2.5, 3) + (p.y - gy < crowd.alt * 0.3 ? 0.8 : 0);
  m.speed += (want - m.speed) * Math.min(1, dt * 2);
  a.move({ speed: m.speed, heading, climb });
}

// ------------------------------------------------------------------ compare
bindToggle('tCompare', 'compare', () => { if (S.compare) spawnCompare(false); else clearCompare(); onResize(); });
$('cmpSeed').value = S.cmpSeed;
$('cmpDice').addEventListener('click', () => { S.cmpSeed = Math.floor(Math.random() * 100000); $('cmpSeed').value = S.cmpSeed; if (S.compare) spawnCompare(false); });
$('cmpBuild').addEventListener('click', () => { S.cmpSeed = Math.max(0, Math.floor(+$('cmpSeed').value || 0)); if (!S.compare) { S.compare = true; $('tCompare').checked = true; onResize(); } spawnCompare(false); });
$('cmpSpecies').addEventListener('change', () => { if (S.compare) spawnCompare(false); });
$('cmpSeed').addEventListener('change', (e) => { S.cmpSeed = Math.max(0, Math.floor(+e.target.value || 0)); if (S.compare) spawnCompare(false); });
function clearCompare() {
  cmp.token++;
  if (cmp.animal) cmp.animal.dispose();
  cmp.animal = null;
  $('split').hidden = true;
}
async function spawnCompare(linked) {
  if (!hero) return;
  const token = ++cmp.token;
  const sp = $('cmpSpecies').value || S.species;
  const m = meta[sp] || { name: sp, latin: '', plan: 'quadruped' };
  const seed = S.cmpSeed === S.seed && sp === S.species ? S.seed + 1 : S.cmpSeed;
  toast(`Building ${m.name.toLowerCase()} · seed ${seed} for comparison`);
  const gap = Math.max(4 * heroInfo.span, 1.2);
  const off = left(hero.heading).multiplyScalar(-gap);
  let pos = hero.position.clone().add(off);
  const swimmer = m.plan === 'swimmer';
  if (swimmer !== !!heroInfo.swimmer || (!swimmer && world.isWater(pos.x, pos.z))) pos = world.spawnPoint({ swimmer, scale: 1 }, off);
  if (swimmer && world.depthAt(pos.x, pos.z) < 0.3) pos = world.wetPoint(pos, 0.3);
  pos.y = swimmer ? (world.depthAt(pos.x, pos.z) > 0 ? hero.position.y : world.waterLevel - 0.2) : world.ground(pos.x, pos.z);
  let a;
  try {
    a = await build(sp, animalOpts(null, { seed, quality: hero.quality, sex: S.sex || undefined, age: S.age || undefined, variant: sp === S.species ? S.variant || undefined : undefined, position: pos, heading: hero.heading, onProgress: () => {} }));
  } catch (e) { if (token === cmp.token) showError(e); return; }
  if (token !== cmp.token || !S.compare) { a.dispose(); return; }
  if (cmp.animal) cmp.animal.dispose();
  cmp.animal = a;
  cmp.linked = linked;
  cmp.info = describe(a);
  cmp.offset.copy(pos).sub(hero.position);
  scene.add(a.object);
  syncLighting(a);
  wireEvents(a, false);
  applyDebug();
  const hn = namesOf(hero, meta[S.species] || {}), cn = namesOf(a, m);
  $('tagA').innerHTML = `${hn.name} · seed ${S.seed} &nbsp;${latinHTML(hn.latin)}`;
  $('tagB').innerHTML = `${cn.name} · seed ${seed} &nbsp;${latinHTML(cn.latin)}`;
  $('split').hidden = false;
  onResize();
  hideToast();
}

// ------------------------------------------------------------------ quality tiers
function tierShellDrop() { const T = TIERS[tier]; return phone && T.phoneDrop !== undefined ? T.phoneDrop : T.shellDrop; }
// transition (s): an adaptive step eases the hero's coat to its new tier (shell count, fin opacity)
function applyTier(transition = 0) {
  const T = TIERS[tier];
  const pr = Math.min(window.devicePixelRatio || 1, dprCap, T.pr);
  renderer.setPixelRatio(TEST ? 1 : pr);
  world.grass.setDensity(T.grass);
  if (hero && hero.render?.setQuality) {
    const qi = Math.min(QORDER.length - 2, QORDER.indexOf(hero.quality) + tierShellDrop());
    const q = QORDER[Math.max(0, qi)];
    if (hero.render.tier !== q) hero.render.setQuality(q, { transition });
  }
  onResize();
}

// adaptive quality with hysteresis (src/adaptive.js): a step up that does not hold is not retried for a
// growing time, unless the hero gets much smaller on screen
const adaptive = new AdaptiveQuality({ tiers: TIERS.length, start: tier, min: phone ? 1 : 0 });
function heroScreen() {
  if (!hero || !heroInfo) return 0;
  const d = Math.max(1e-3, camera.position.distanceTo(hero.position));
  return heroInfo.height / (d * Math.tan((camera.fov * Math.PI) / 360));
}
function resetAdapt() { adaptive.reset(); }

function onResize() {
  if (DEMO) return; // the demo sizes the canvas to its output aspect itself
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  const split = S.compare && cmp.animal;
  const portrait = h > w;
  const aw = split && !portrait ? w / 2 : w, ah = split && portrait ? h / 2 : h;
  camera.aspect = aw / ah;
  camera.updateProjectionMatrix();
  cameraB.aspect = aw / ah;
  cameraB.updateProjectionMatrix();
  const dock = $('dock');
  if (dock) document.documentElement.style.setProperty('--dockH', dock.offsetHeight + 'px');
}
window.addEventListener('resize', onResize);
if (window.ResizeObserver) new ResizeObserver(() => onResize()).observe($('dock'));

// ------------------------------------------------------------------ loop
let simTime = 0, hudT = 0, fps = 0, fpsAcc = 0, fpsN = 0;
const push = [];
const _hp = new THREE.Vector3(), _feet = [];
const contactEntries = [];

let rawDt = 0;
function frame(dtReal) {
  rawDt = Math.max(0, dtReal);
  dtReal = Math.min(Math.max(dtReal, 0), 0.25);
  const dt = Math.min(dtReal, 0.1) * S.timeScale;
  simTime += dt;
  renderer.info.reset();
  let focus;
  if (hero) {
    const cmd = pilot.update(dt, simTime);
    if (cmd) {
      if (cmd.moveTo) {
        hero.moveTo(cmd.moveTo, { speed: cmd.speed });
        if (cmp.animal) cmp.animal.moveTo(cmd.moveTo.clone().add(cmp.offset), { speed: cmd.speed });
      } else {
        hero.move(cmd.move);
        cmp.animal?.move(cmd.move);
      }
      hero.lookAt(cmd.look || null);
      cmp.animal?.lookAt(cmd.look ? cmd.look.clone().add(cmp.offset) : null);
    }
    if (pendingAction && pilot.mode === 'manual' && !pilot.target) { const n = pendingAction; pendingAction = null; playAction(n, false); }
    hero.update(dt);
    cmp.animal?.update(dt);
    syncActionChipsIfChanged();
    const crowdMs = updateCrowd(dt, simTime);
    syncLighting(hero);
    if (cmp.animal) syncLighting(cmp.animal);
    headPosition(hero, heroInfo, _hp);
    rig.update(dtReal, { position: hero.position, heading: hero.heading, speed: hero.speed || 0, head: _hp, height: heroInfo.height, flying: heroInfo.flyer && hero.state?.grounded === false, swimmer: !!heroInfo.swimmer && hero.state?.inWater !== false, waterLevel: world.waterLevel });
    focus = rig.focus;
    // grass push-back from the hero's feet and bodies nearby
    push.length = 0;
    for (const p of footPositions(hero, heroInfo, _feet)) if (push.length < 6) push.push({ x: p.x, y: world.ground(p.x, p.z), z: p.z, r: 0.22 * heroInfo.scale, _y: p.y });
    for (let i = push.length - 1; i >= 0; i--) if (push[i]._y - push[i].y > 0.4 * heroInfo.scale) push.splice(i, 1);
    const hy = world.ground(hero.position.x, hero.position.z);
    if (hero.position.y - hy < heroInfo.height) push.push({ x: hero.position.x, y: hy, z: hero.position.z, r: Math.max(0.3 * Math.min(1, heroInfo.scale * 3), heroInfo.span * 0.3) });
    for (const m of crowd.members) { if (push.length >= 10) break; const p = m.animal.position, gy = world.ground(p.x, p.z); if (p.y - gy < m.info.height && Math.abs(p.x - hero.position.x) + Math.abs(p.z - hero.position.z) < 8) push.push({ x: p.x, y: gy, z: p.z, r: m.info.span * 0.25 }); }
    if (cmp.animal && push.length < 10) { const p = cmp.animal.position; push.push({ x: p.x, y: world.ground(p.x, p.z), z: p.z, r: cmp.info.span * 0.25 }); }
    contactEntries.length = 0;
    contactEntries.push({ animal: hero, info: heroInfo, feet: true });
    if (cmp.animal) contactEntries.push({ animal: cmp.animal, info: cmp.info, feet: true });
    for (const m of crowd.members) contactEntries.push({ animal: m.animal, info: m.info, feet: false });
    contact.update(contactEntries);
    if (debug?.active) debug.update();
    if (S.footfalls) footfalls.sample(hero, dt, simTime);
    crowd.lastMs = crowdMs;
  } else {
    const t = performance.now() / 1000;
    camera.position.set(Math.cos(t * 0.05) * 7, 2.2, Math.sin(t * 0.05) * 7);
    camera.lookAt(0, 0.6, 0);
    focus = new THREE.Vector3(0, 0.5, 0);
  }
  world.update(focus, dt, simTime, camera, push);
  renderer.toneMappingExposure = env.exposure ?? 0.72;
  if (marker.visible) {
    markerT += dtReal;
    marker.material.opacity = Math.max(0, 0.9 - markerT * 0.25) * (pilot.target ? 1 : 0.4);
    if (!pilot.target && markerT > 2) marker.visible = false;
  }
  render();
  if (firstFrameMs === null) { firstFrameMs = performance.now() - T0; mark('firstFrame'); }
  if (hero && firstAnimalFrameMs === null) {
    firstAnimalFrameMs = performance.now() - T0;
    window.__timing = { firstFrameMs: Math.round(firstFrameMs), firstAnimalFrameMs: Math.round(firstAnimalFrameMs), buildMs: hero.data?.stats?.buildMs };
    console.info(`[showcase] first frame ${Math.round(firstFrameMs)} ms, first animal frame ${Math.round(firstAnimalFrameMs)} ms`);
    window.__ready = true;
  }
  // HUD
  fpsAcc += rawDt; fpsN++; // unclamped: a slow machine shows its real frame rate
  hudT += dtReal;
  if (hudT > 0.25) {
    fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
    hudT = 0;
    updateHUD();
  }
  // adaptive quality (pixel ratio, grass density, fur shells)
  // (never in the demo reel: it runs its own loop and quality profile, see demo.js adaptShells)
  if (!TEST && !DEMO && pinTier === null && hero && document.visibilityState === 'visible' && dtReal < 0.5) {
    adaptive.tier = tier;
    const step = adaptive.sample(dtReal, performance.now() / 1000, heroScreen());
    if (step) { tier = adaptive.tier; applyTier(1.2); }
  }
}

function render() {
  const split = S.compare && cmp.animal;
  if (!split) {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.render(scene, camera);
    return;
  }
  // second camera: same framing relative to the second animal
  cameraB.position.copy(camera.position).add(cmp.animal.position).sub(hero.position);
  cameraB.quaternion.copy(camera.quaternion);
  cameraB.fov = camera.fov;
  cameraB.updateProjectionMatrix();
  const w = window.innerWidth, h = window.innerHeight, portrait = h > w;
  renderer.setScissorTest(true);
  if (portrait) {
    renderer.setViewport(0, h / 2, w, h / 2); renderer.setScissor(0, h / 2, w, h / 2); renderer.render(scene, camera);
    renderer.setViewport(0, 0, w, h / 2); renderer.setScissor(0, 0, w, h / 2); renderer.render(scene, cameraB);
  } else {
    renderer.setViewport(0, 0, w / 2, h); renderer.setScissor(0, 0, w / 2, h); renderer.render(scene, camera);
    renderer.setViewport(w / 2, 0, w / 2, h); renderer.setScissor(w / 2, 0, w / 2, h); renderer.render(scene, cameraB);
  }
  renderer.setScissorTest(false);
}

function updateHUD() {
  if (!hero) return;
  const v = hero.speed || 0;
  $('sSpeed').textContent = (v * 3.6).toFixed(v < 2.7 ? 1 : 0);
  const gname = hero.state?.gait || (v > 0.05 ? 'moving' : 'stand');
  $('sGait').textContent = gname;
  $('sFps').textContent = fps ? fps.toFixed(0) : '–';
  const act = hero.state?.action;
  let where = '';
  if (heroInfo.flyer && Number.isFinite(hero.state?.altitude)) {
    const alt = hero.state.altitude;
    $('sAlt').textContent = alt.toFixed(alt < 10 ? 1 : 0);
    if (hero.state.mode === 'perch') where = ' · perched';
    else if (hero.state.grounded === false && alt > 0.2 * heroInfo.height) where = ` · ${alt.toFixed(1)} m up`;
  } else if (heroInfo.swimmer && Number.isFinite(hero.state?.depth)) {
    const dp = Math.max(0, hero.state.depth);
    $('sAlt').textContent = dp.toFixed(2);
    where = hero.state.inWater === false ? ' · out of the water' : ` · ${dp < 1 ? Math.round(dp * 100) + ' cm' : dp.toFixed(1) + ' m'} deep`;
  }
  $('statusText').textContent = pendingAction ? 'Heading to the water' : `${pilot.status}${act && act !== 'idle' && !pilot.status.toLowerCase().includes(act) ? ' · ' + act : ''} · ${gname}${where}`;
  if (S.footfalls) footfalls.draw(gname, hero);
  if (pilot.mode !== 'auto' && $('speed') !== document.activeElement && !pilot.target) { /* keep the slider where the user put it */ }
  if (S.perf) {
    const animals = allAnimals();
    const verts = animals.reduce((s, a) => s + (a.data?.nV || 0), 0);
    const cpu = crowd.members.length ? crowd.cpuMs : (hero.stats?.updateMs || 0);
    $('pFps').textContent = fps.toFixed(0);
    $('pCpu').textContent = cpu.toFixed(3);
    $('pAnim').textContent = animals.length + (crowd.building ? '…' : '');
    $('pCalls').textContent = renderer.info.render.calls;
    $('pTris').textContent = fmtK(renderer.info.render.triangles);
    $('pVerts').textContent = fmtK(verts);
  }
}
const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n));

let lastT = performance.now(), loopErrors = 0, frameCount = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dtReal = (now - lastT) / 1000;
  lastT = now;
  try { frame(dtReal); frameCount++; } catch (e) { if (loopErrors++ < 3) console.error(e); }
}

// ------------------------------------------------------------------ boot
mark('wired');
if (DEMO) {
  // the demo reel: its own loader, director, camera and loop (the showcase UI stays hidden)
  runDemo({ renderer, scene, camera, world, contact, canvas, params, build, animalOpts, syncLighting, gpu }).catch((e) => { (window.__demo = window.__demo || {}).error = String(e && e.stack ? e.stack : e); showError(e); });
} else {
  applyTier();
  mark('tier');
  onResize();
  if (phone) rig.setMode('follow');
  if (params.get('cam')) rig.setMode(params.get('cam'));
  requestAnimationFrame(loop);
  mark('init');
  loadMeta().then(() => { mark('meta'); return spawnHero(); }).catch(showError);
}

// hooks for automated checks and for the curious (console: proceduralAnimals.hero.play('sit'))
window.proceduralAnimals = {
  get hero() { return hero; }, get info() { return heroInfo; }, get crowd() { return crowd.members.map((m) => m.animal); },
  get compare() { return cmp.animal; }, world, rig, pilot, renderer, scene, camera, state: S, meta,
  setSpecies: (id, variant = '') => { setSpecies(id); S.variant = variant; syncVariantButtons(); return spawnHero(); },
  footfalls, get pending() { return pendingAction; },
  playAction, selectTab, togglePanel, frame,
  refreshUI: () => { if (!hero) return; pilot.actions = new Set(hero.actions || []); buildActionsUI(); buildGaitUI(); updateCode(); }, get timing() { return window.__timing; }, get tier() { return tier; },
  get fps() { return fps; }, get frames() { return frameCount; }, gpu,
};
