// procedural-animals test harness (browser). Bundled by tools/harness/build.mjs into out/harness.html.
//
// A neutral studio (mid-grey ground with a faint 1-leg-length grid, optional bumpy / sloped terrain,
// a shadow-casting DirectionalLight that follows the animal, a HemisphereLight) and helpers for
// scripted renders, exposed as window.__animals:
//
//   await B.spawn({ species, seed, quality, terrain: 'flat'|'bumpy'|'slope', heading, sex, age }) -> info
//   B.step(n = 1, dt = 1/60) -> snapshot       B.move({ speed, heading, gait }), B.play(name, opts), B.stop()
//   B.view({ azimuth, elevation, fov, target: 'body'|'head'|[x,y,z], fit, track, w, h }) -> { distance }
//        azimuth in degrees relative to the animal's heading: 0 = in front (looking at the face),
//        90 = the animal's left side (it faces screen-left), -90 = right side (faces screen-right)
//   B.render({ w, h, silhouette }) -> { url (PNG data URL), calls, triangles }
//   await B.gaitStrip({ gait, speed, frames: 8, w, h }), await B.actionStrip({ name, running, ... }),
//   await B.turntable({ n: 8, ... }), await B.face({ ... }), B.info()
import * as THREE from 'three';
import { createAnimal, setWorkerFactory, buildAnimalData, loadSpecies, listSpecies, QUALITY } from '../../src/index.js';
import { analyseBody, legStates, jointList, jointPositions } from '../lib/body.mjs';
import { makeGround, waterFor } from '../lib/terrain.mjs';
import { gaitSpeeds, POSTURES } from '../lib/gaits.mjs';
import { CpuSkin } from '../lib/skin.mjs';

/* global __WORKER_SRC__ */
if (typeof __WORKER_SRC__ === 'string' && typeof Worker !== 'undefined') {
  try {
    const url = URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' }));
    setWorkerFactory(() => new Worker(url));
  } catch (e) { console.warn('harness: workers unavailable, building on the main thread', e); }
}

const DEG = Math.PI / 180;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(320, 240);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const BG = new THREE.Color().setRGB(0.66, 0.68, 0.71, THREE.SRGBColorSpace);
const KEY = new THREE.Color().setRGB(0, 1, 0, THREE.SRGBColorSpace);
scene.background = BG;
const camera = new THREE.PerspectiveCamera(20, 4 / 3, 0.05, 2000);
const hemi = new THREE.HemisphereLight(0xdde6f2, 0x5f5a52, 1.15);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3e4, 2.7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(-0.45, 0.8, 0.4).normalize();

// ---------------------------------------------------------------- ground
function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#747474'; g.fillRect(0, 0, 128, 2); g.fillRect(0, 0, 2, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, map: gridTexture() });
let groundMesh = null;
function setGround(kind, S, fn) {
  if (groundMesh) { groundMesh.geometry.dispose(); scene.remove(groundMesh); }
  // the flat studio floor is huge; it is subdivided (and sized by S) so that depth interpolation over
  // its triangles stays accurate next to a small animal seen at a grazing angle
  const size = kind === 'flat' ? Math.min(3000, 4000 * S) : Math.max(30, 60 * S);
  const seg = kind === 'flat' ? 200 : 300;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, fn(x, z));
    uv.setXY(i, x / S, z / S);
  }
  geo.computeVertexNormals();
  groundMesh = new THREE.Mesh(geo, groundMat);
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
}

// ---------------------------------------------------------------- water surface (swimmers)
const waterMat = new THREE.MeshStandardMaterial({ color: 0x6f9fb8, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
let waterMesh = null;
function setWater(level, S) {
  if (waterMesh) { waterMesh.geometry.dispose(); scene.remove(waterMesh); waterMesh = null; }
  if (level === null || level === undefined) return;
  const geo = new THREE.PlaneGeometry(Math.max(30, 80 * S), Math.max(30, 80 * S), 40, 40);
  geo.rotateX(-Math.PI / 2);
  waterMesh = new THREE.Mesh(geo, waterMat);
  waterMesh.position.y = level;
  waterMesh.renderOrder = 20;
  scene.add(waterMesh);
}

// ---------------------------------------------------------------- animal state
const H = {
  animal: null, body: null, joints: null, jbuf: null, S: 0.8, ground: () => 0, terrain: 'flat',
  time: 0, footsteps: [], events: [], action: null, track: null, lastView: null,
};

async function spawn(o = {}) {
  const species = o.species || 'cheetah';
  if (H.animal) { H.animal.dispose(); H.animal = null; }
  const t0 = performance.now();
  const opts = { seed: o.seed ?? 1, quality: o.quality || 'high', sex: o.sex, age: o.age, variant: o.variant, worker: o.worker };
  const data = await buildAnimalData(species, opts);
  const body = analyseBody(data);
  H.S = body.scale;
  H.terrain = o.terrain || 'flat';
  H.ground = makeGround(H.terrain, H.S);
  setGround(H.terrain, H.S, H.ground);
  // swimmers get a water volume (surface WATER_DEPTH x S above the ground, see tools/lib/terrain.mjs)
  const sp = await loadSpecies(species);
  H.water = waterFor(sp.plan, H.S);
  setWater(H.water ? H.water(0, 0) : null, H.S);
  const a = await createAnimal(species, { ...opts, ground: H.ground, water: H.water || undefined, heading: (o.heading || 0) * DEG, position: o.position ? new THREE.Vector3(...o.position) : undefined });
  const buildMs = performance.now() - t0;
  scene.add(a.object);
  H.animal = a; H.body = body; H.joints = jointList(data); H.jbuf = new Float64Array(H.joints.length * 3);
  H.time = 0; H.footsteps = []; H.events = []; H.action = null; H.track = null;
  a.on('footstep', (e) => H.footsteps.push({ t: H.time, foot: e.foot }));
  for (const ev of ['actionStart', 'actionEnd', 'land', 'takeoff', 'death', 'attackHit']) a.on(ev, (e) => H.events.push({ t: H.time, type: ev, name: e.name }));
  a.update(0);
  return info({ buildMs });
}

function info(extra = {}) {
  const a = H.animal;
  if (!a) return null;
  const g = gaitSpeeds(a, H.body);
  return {
    species: a.id, seed: a.seed, quality: a.quality, vertices: a.stats.vertices, triangles: a.stats.triangles, bones: a.stats.bones,
    gaits: g.gaits, missingGaits: g.missing, actions: a.actions || [], legs: H.body.legs.map((l) => ({ key: l.key, length: +l.length.toFixed(3) })),
    scale: H.S, height: H.body.height, length: H.body.length, variant: a.params?.variant, plan: a.species?.plan, ...extra,
  };
}

function snapshot() {
  const a = H.animal, s = a.state;
  const legs = legStates(a, H.body);
  return {
    t: +H.time.toFixed(3), pos: [s.position.x, s.position.y, s.position.z], heading: s.heading, speed: s.speed, gait: s.gait,
    action: s.action ?? null, stance: legs.map((l) => (l.stance === null ? '?' : l.stance ? 'T' : '-')).join(''),
  };
}

function step(n = 1, dt = 1 / 60) {
  const a = H.animal;
  for (let i = 0; i < n; i++) { a.update(dt); H.time += dt; }
  return snapshot();
}
// step with microtask flushes so action promises can resolve between frames
async function stepAsync(seconds, dt = 1 / 60, until = null) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    H.animal.update(dt); H.time += dt;
    if ((i & 7) === 7) await null;
    if (until && until()) break;
  }
}

function play(name, opts = {}) {
  const a = H.animal;
  const st = { name, done: false, t0: H.time, tEnd: null };
  H.action = st;
  const o = { ...opts };
  if (name === 'attack' && !o.target) { const p = a.state.position, h = a.state.heading; o.target = new THREE.Vector3(p.x + Math.sin(h) * 1.5 * H.S, p.y + 0.3 * H.S, p.z + Math.cos(h) * 1.5 * H.S); }
  if (name === 'hit' && !o.direction) o.direction = new THREE.Vector3(1, 0, 0.2).normalize();
  let r;
  try { r = a.play(name, o); } catch (e) { st.done = true; st.error = String(e); return st; }
  if (r && typeof r.then === 'function') r.then(() => { st.done = true; st.tEnd = H.time; }, (e) => { st.done = true; st.error = String(e); });
  else { st.done = true; st.tEnd = H.time; }
  return st;
}

// ---------------------------------------------------------------- camera
const _c = new THREE.Vector3(), _v = new THREE.Vector3();
// flying (bird in the air, a leap): the framing must not reach down to the ground
function airborne() {
  const s = H.animal.state;
  return (s.mode && s.mode !== 'ground' && s.mode !== 'perch') || s.grounded === false || (s.altitude ?? 0) > 0.3 * H.S;
}
const fmtV = (v) => (Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(1));

function targetBox(kind) {
  const a = H.animal, sk = a.render.skeleton;
  const pts = [];
  if (kind === 'head') {
    a.data.bones.forEach((b, i) => {
      if (b.region === 'head' || b.region === 'jaw' || b.region === 'ear') {
        const e = sk.bones[i].matrixWorld.elements, L = H.body.boneLen[i];
        pts.push(new THREE.Vector3(e[12], e[13], e[14]), new THREE.Vector3(e[12] + e[4] * L, e[13] + e[5] * L, e[14] + e[6] * L));
        // the muzzle / beak reaches past the head bone's tip joint
        if (b.region === 'head') pts.push(new THREE.Vector3(e[12] + e[4] * L * 1.3, e[13] + e[5] * L * 1.3, e[14] + e[6] * L * 1.3));
      }
    });
  } else {
    jointPositions(sk, H.joints, H.body.boneLen, H.jbuf);
    for (let j = 0; j < H.joints.length; j++) pts.push(new THREE.Vector3(H.jbuf[j * 3], H.jbuf[j * 3 + 1], H.jbuf[j * 3 + 2]));
  }
  const box = new THREE.Box3().setFromPoints(pts);
  const size = box.getSize(new THREE.Vector3());
  const pad = kind === 'head' ? 0.35 * Math.max(size.x, size.y, size.z) : 0.1 * H.S;
  box.expandByScalar(pad);
  // standing animals are framed down to the ground; swimmers hover and flyers fly, so only the body
  // is framed (a bird at 5 m framed with the ground was a few pixels wide)
  if (kind !== 'head' && !H.water && !airborne()) box.min.y = Math.min(box.min.y, H.ground(box.getCenter(_c).x, _c.z));
  return box;
}

function view(o = {}) {
  const a = H.animal;
  const w = o.w || 320, h = o.h || 240;
  renderer.setSize(w, h);
  const az = (o.azimuth ?? 90) * DEG, el = (o.elevation ?? 6) * DEG, fov = o.fov ?? 20, fit = o.fit ?? 1.08;
  const hd = o.worldAzimuth ? 0 : a.state.heading;
  const dir = new THREE.Vector3(Math.sin(hd + az) * Math.cos(el), Math.sin(el), Math.cos(hd + az) * Math.cos(el));
  let center, d;
  if (o.track && H.track) {
    // the framing offset is kept in the animal's heading frame, so it turns with the animal
    const off = H.track.offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a.state.heading - H.track.h0);
    center = a.state.position.clone().add(off);
    d = H.track.d;
  } else {
    let box;
    if (Array.isArray(o.target)) box = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...o.target), new THREE.Vector3(1, 1, 1).multiplyScalar(o.size || H.S));
    else box = targetBox(o.target || 'body');
    if (o.extraBox) box.union(o.extraBox);
    center = box.getCenter(new THREE.Vector3());
    const f = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, f);
    const tanV = Math.tan((fov * DEG) / 2) / fit, tanH = tanV * (w / h);
    d = 0;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      const x = Math.abs(_v.dot(right)), y = Math.abs(_v.dot(up)), z = _v.dot(dir);
      d = Math.max(d, x / tanH + z, y / tanV + z);
    }
    if (o.distance) d = o.distance;
    if (o.track) H.track = { offset: center.clone().sub(a.state.position), d, h0: a.state.heading };
  }
  camera.fov = fov; camera.aspect = w / h;
  // (nearMin: close-ups of millimetre parts, a spider's eye, need a near plane below the 1 cm default)
  camera.near = Math.max(o.nearMin ?? 0.01, d * 0.05); camera.far = d * 20 + 50;
  camera.position.copy(center).addScaledVector(dir, d);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  H.lastView = { center, d };
  return { distance: d, center: center.toArray() };
}

function render(o = {}) {
  if (o.w && o.h) { renderer.setSize(o.w, o.h); camera.aspect = o.w / o.h; camera.updateProjectionMatrix(); }
  const c = H.lastView ? H.lastView.center : H.animal.state.position;
  const r = 2.2 * Math.max(H.S, H.body.length * 0.7);
  sun.position.copy(c).addScaledVector(SUN_DIR, 6 * r);
  sun.target.position.copy(c);
  sun.target.updateMatrixWorld();
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -r; sc.right = sc.top = r; sc.near = Math.min(0.1, r); sc.far = 14 * r;
  sun.shadow.normalBias = 0.026 * H.S; // 0.02 m for the cheetah; a few-millimetre spider needs a proportional offset
  sc.updateProjectionMatrix();
  const sil = !!o.silhouette;
  if (groundMesh) groundMesh.visible = !sil && !o.noGround;
  if (waterMesh) waterMesh.visible = !sil && !o.noWater;
  scene.background = sil ? KEY : BG;
  renderer.shadowMap.enabled = !sil;
  renderer.render(scene, camera);
  const calls = renderer.info.render.calls, triangles = renderer.info.render.triangles;
  const url = renderer.domElement.toDataURL('image/png');
  if (sil) { scene.background = BG; renderer.shadowMap.enabled = true; if (groundMesh) groundMesh.visible = true; if (waterMesh) waterMesh.visible = true; }
  return { url, calls, triangles };
}

// ---------------------------------------------------------------- composite helpers
function strideFreq() {
  const a = H.animal, s = a.state;
  if (airborne() && s.stats?.flapFreq > 0.05) return s.stats.flapFreq; // flight: one wing beat
  const f = s.stats?.freq ?? a.motion.loco?.stats?.freq;
  if (f > 0.05) return f;
  const byFoot = {};
  for (const e of H.footsteps) (byFoot[e.foot] ||= []).push(e.t);
  const iv = [];
  for (const ts of Object.values(byFoot)) for (let i = Math.max(1, ts.length - 3); i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
  if (iv.length) { iv.sort((x, y) => x - y); return 1 / iv[iv.length >> 1]; }
  return 1;
}

// Reset between rows / sheets: no locomotion, every running action ended (a looping eat does not end
// by itself), a flyer back on the ground, standing (also after death), and the last action faded out,
// so each row shows only its own action.
async function ensureStanding() {
  const a = H.animal;
  a.stop();
  a.stopAction?.();
  const st = () => a.state;
  if (airborne()) {
    if ((a.actions || []).includes('land')) a.play('land');
    await stepAsync(20, 1 / 60, () => !airborne());
  }
  const posture = st().posture || (POSTURES.includes(st().action) ? st().action : null);
  if ((posture && posture !== 'stand') || st().action === 'death') {
    if ((a.actions || []).includes('stand')) { play('stand'); await stepAsync(4, 1 / 60, () => H.action && H.action.done); }
  }
  await stepAsync(4, 1 / 60, () => !st().action && (!st().posture || st().posture === 'stand'));
  H.action = null;
  await stepAsync(0.5);
}

async function gaitStrip(o) {
  const a = H.animal;
  await ensureStanding();
  a.move({ speed: o.speed, gait: o.gait });
  // warm up until the speed settles (max 8 s)
  let t = 0;
  // (flyers: until airborne at speed, up to 12 s; the margin is relative: a 4 cm/s crawl passed an
  // absolute 5 cm/s margin while still standing)
  const tMax = o.speed > 0 && a.species?.plan === 'bird' ? 12 : 8;
  while (t < tMax) { await stepAsync(0.5); t += 0.5; if (t >= 2.5 && Math.abs(a.state.speed - o.speed) < 0.06 * o.speed + 0.01 * H.S) break; }
  await stepAsync(1);
  const f = strideFreq(), T = 1 / f, n = o.frames || 8;
  // swimmers bend in the horizontal plane: look down on them from above-behind
  if (H.water && o.elevation === undefined) { o.elevation = 62; o.azimuth = o.azimuth ?? 150; }
  const sub = Math.max(1, Math.ceil(T / n / (1 / 60))), dt = T / n / sub;
  view({ azimuth: o.azimuth ?? 90, elevation: o.elevation ?? 4, fov: o.fov ?? 16, fit: o.fit ?? 1.12, w: o.w, h: o.h, track: true });
  const tiles = [];
  for (let i = 0; i < n; i++) {
    const s = snapshot();
    view({ azimuth: o.azimuth ?? 90, elevation: o.elevation ?? 4, fov: o.fov ?? 16, w: o.w, h: o.h, track: true });
    const r = render({ w: o.w, h: o.h });
    tiles.push({ url: r.url, label: `${i}/${n} ${s.stance}`, sub: `${fmtV(s.speed)} m/s ${s.gait || ''}` });
    step(sub, dt);
  }
  H.track = null;
  a.stop();
  return { tiles, freq: f, period: T, speed: a.state.speed };
}

async function actionStrip(o) {
  const a = H.animal, name = o.name;
  await ensureStanding();
  const times = o.times || [0.15, 0.4, 0.75, 1.2, 1.8, 2.6];
  if (o.running) {
    a.move({ speed: o.speed });
    await stepAsync(3);
    view({ azimuth: 90, elevation: o.elevation ?? 5, fov: 18, fit: 1.35, w: o.w, h: o.h, track: true });
  } else {
    view({ azimuth: o.azimuth ?? 60, elevation: o.elevation ?? 10, fov: 20, fit: o.fit ?? 1.3, w: o.w, h: o.h, track: true });
  }
  const st = play(name, o.opts || {});
  const tiles = [];
  let t = 0;
  for (const tt of times) {
    const k = Math.max(0, Math.round((tt - t) * 60));
    if (k) { await stepAsync(k / 60); t += k / 60; }
    await null;
    const s = snapshot();
    view({ azimuth: o.running ? 90 : o.azimuth ?? 60, elevation: o.running ? o.elevation ?? 5 : o.elevation ?? 10, fov: o.running ? 18 : 20, w: o.w, h: o.h, track: true });
    const r = render({ w: o.w, h: o.h });
    tiles.push({ url: r.url, label: `${name} ${tt.toFixed(2)}s`, sub: `${s.action || '-'} ${s.stance}` });
    if (st.done && st.tEnd !== null && H.time > st.tEnd + 0.3 && !POSTURES.includes(name)) break;
  }
  H.track = null;
  const res = { tiles, done: st.done, error: st.error || null, duration: st.tEnd !== null ? st.tEnd - st.t0 : null };
  a.stop();
  if (POSTURES.includes(name)) await ensureStanding();
  return res;
}

async function turntable(o = {}) {
  await ensureStanding();
  await stepAsync(o.settle ?? 1);
  const n = o.n || 8, tiles = [];
  for (let i = 0; i < n; i++) {
    const az = (360 / n) * i;
    view({ azimuth: az, elevation: o.elevation ?? 6, fov: o.fov ?? 10, fit: o.fit ?? 1.06, w: o.w, h: o.h });
    tiles.push({ url: render({ w: o.w, h: o.h }).url, label: `${az.toFixed(0)} deg` });
  }
  return { tiles };
}

async function face(o = {}) {
  await ensureStanding();
  await stepAsync(o.settle ?? 1);
  const views = o.views || [{ label: 'front', azimuth: 0 }, { label: '3/4', azimuth: 40 }, { label: 'side', azimuth: 90 }];
  const tiles = [];
  for (const v of views) {
    view({ azimuth: v.azimuth, elevation: v.elevation ?? 4, fov: o.fov ?? 18, fit: o.fit ?? 1.05, target: 'head', w: o.w, h: o.h });
    tiles.push({ url: render({ w: o.w, h: o.h }).url, label: v.label });
  }
  return { tiles };
}

// Face close-ups for the face-integrity check: one row per mode ('fur' as rendered; 'bare' the base
// without shells and fins; 'holes' the base drawn two-sided with its back faces red, so a gap in the
// skin shows red), one column per angle around the head, framed tight on the head.
async function closeup(o = {}) {
  await ensureStanding();
  await stepAsync(o.settle ?? 1);
  const a = H.animal;
  const views = o.views || [
    { label: 'front-right', azimuth: -30, elevation: 2 }, { label: 'front', azimuth: 0, elevation: 4 },
    { label: '3/4 left', azimuth: 40, elevation: 2 }, { label: 'side', azimuth: 85, elevation: 0 },
    { label: 'low 3/4', azimuth: 30, elevation: -10 },
  ];
  const rows = [];
  for (const mode of o.modes || ['fur', 'bare', 'holes']) {
    a.setDebug('bare', mode !== 'fur');
    a.setDebug('holes', mode === 'holes');
    const tiles = [];
    for (const v of views) {
      view({ azimuth: v.azimuth, elevation: v.elevation ?? 2, fov: o.fov ?? 18, fit: o.fit ?? 0.5, target: 'head', w: o.w, h: o.h });
      tiles.push({ url: render({ w: o.w, h: o.h }).url, label: v.label });
    }
    rows.push({ mode, tiles });
  }
  a.setDebug('holes', false);
  a.setDebug('bare', false);
  return { rows };
}

// Views of skin vertices (exposed-hole clusters of tools/lib/holes.mjs): framed tight on each vertex in
// the standing pose, looking down its normal and from 40 degrees to either side, one row as rendered
// and one in the 'holes' debug mode (back faces red), so a flagged hole can be judged by eye (a feather
// card or the fur may cover it).
async function holeViews(o = {}) {
  await ensureStanding();
  await stepAsync(o.settle ?? 1);
  const a = H.animal, d = a.data, sk = a.render.skeleton;
  const cs = new CpuSkin(sk.bind);
  cs.setPose(sk.bones.map((b) => b.matrixWorld));
  const views = [];
  for (const c of o.clusters || []) {
    const v = c.vertex, p = new Float32Array(3), q = new Float32Array(3);
    cs.skin(d, p, Int32Array.of(v));
    const off = 0.01 * H.S;
    // (c.dir, bind space: the side to look from, e.g. a folded patch of skin seen from its back)
    const nb = c.dir || [d.nrm[v * 3], d.nrm[v * 3 + 1], d.nrm[v * 3 + 2]];
    const tip = { pos: Float32Array.of(d.pos[v * 3] + nb[0] * off, d.pos[v * 3 + 1] + nb[1] * off, d.pos[v * 3 + 2] + nb[2] * off), skinIndex: d.skinIndex.subarray(v * 4, v * 4 + 4), skinWeight: d.skinWeight.subarray(v * 4, v * 4 + 4), nV: 1 };
    cs.skin(tip, q);
    const n = new THREE.Vector3(q[0] - p[0], q[1] - p[1], q[2] - p[2]).normalize();
    const az = Math.atan2(n.x, n.z) / DEG, el = Math.max(-60, Math.min(70, Math.asin(Math.max(-1, Math.min(1, n.y))) / DEG + 12));
    const size = Math.max(0.05 * H.S, (c.ext || 0.02) * 3);
    views.push({ c, target: [p[0], p[1], p[2]], size, dirs: [[az, el], [az + 40, el], [az - 40, el]] });
  }
  const rows = [];
  for (const mode of ['fur', 'holes']) {
    a.setDebug('holes', mode === 'holes');
    a.setDebug('bare', mode === 'holes');
    for (const vw of views) {
      const tiles = [];
      for (const [az, el] of vw.dirs) {
        view({ azimuth: az, elevation: el, worldAzimuth: true, target: vw.target, size: vw.size, fov: o.fov ?? 20, fit: 1, w: o.w, h: o.h });
        tiles.push({ url: render({ w: o.w, h: o.h }).url, label: `${vw.c.label || ''} az ${Math.round(az)} el ${Math.round(el)}` });
      }
      rows.push({ mode, label: vw.c.label, tiles });
    }
  }
  a.setDebug('holes', false);
  a.setDebug('bare', false);
  return { rows };
}

// Eye close-ups (eye integrity: a sunken or clipped eyeball, a ragged or closed aperture, an eye lost in
// a hollow): per eye, framed tight on the eyeball down the socket axis, 25 degrees toward the nose, 40
// toward the ear and 30 from above (a brow that hides the eye); rows as rendered and base only (no
// shells: the aperture the sculpt cuts). Blinks and saccades are held (lids open, gaze straight
// ahead) so every tile shows the same open eye.
async function eyeViews(o = {}) {
  await ensureStanding();
  await stepAsync(o.settle ?? 1);
  const a = H.animal, ro = a.render, rig = ro.eyeRig;
  const saved = { ...rig.override };
  Object.assign(rig.override, { blink: 0, gaze: [0, 0], eyelid: 0 });
  a.update(1 / 60);
  const fwd = new THREE.Vector3(Math.sin(a.state.heading), 0, Math.cos(a.state.heading));
  const views = [];
  for (const e of ro.eyes.slice(0, o.maxEyes ?? 2)) {
    e.updateMatrixWorld();
    const p = new THREE.Vector3().setFromMatrixPosition(e.matrixWorld);
    const z = new THREE.Vector3().setFromMatrixColumn(e.matrixWorld, 2).normalize();
    const r = (e.userData.r || 0.01) * (e.userData.scale || 1);
    const az = Math.atan2(z.x, z.z) / DEG, el = Math.asin(Math.max(-1, Math.min(1, z.y))) / DEG;
    // which way (in azimuth) turns the view toward the nose
    const toNose = Math.sign(Math.atan2(z.x * fwd.z - z.z * fwd.x, z.x * fwd.x + z.z * fwd.z)) || 1;
    const name = e.userData.side > 0 ? 'left eye' : 'right eye';
    const target = p.clone().addScaledVector(z, 0.6 * r).toArray();
    views.push({ name, target, size: (o.frame ?? 3.2) * r, dirs: [['axis', az, el], ['nose side', az - toNose * 25, el + 4], ['ear side', az + toNose * 40, el + 4], ['above', az, el + 30]] });
  }
  const rows = [];
  for (const mode of o.modes || ['fur', 'bare']) {
    a.setDebug('bare', mode !== 'fur');
    const tiles = [];
    for (const vw of views) {
      for (const [lab, az, el] of vw.dirs) {
        view({ azimuth: az, elevation: el, worldAzimuth: true, target: vw.target, size: vw.size, fov: o.fov ?? 20, fit: 1, nearMin: 1e-4, w: o.w, h: o.h });
        tiles.push({ url: render({ w: o.w, h: o.h }).url, label: `${vw.name} ${lab}` });
      }
    }
    rows.push({ mode, tiles });
  }
  a.setDebug('bare', false);
  Object.assign(rig.override, saved);
  return { rows };
}

async function tiers(o = {}) {
  const tiles = [];
  for (const q of o.qualities || Object.keys(QUALITY)) {
    const t0 = performance.now();
    const inf = await spawn({ ...o.spawn, quality: q });
    const ms = performance.now() - t0;
    await stepAsync(1);
    view({ azimuth: o.azimuth ?? 40, elevation: 8, fov: 20, fit: 1.06, w: o.w, h: o.h });
    const r = render({ w: o.w, h: o.h });
    tiles.push({ url: r.url, label: q, sub: `${(inf.vertices / 1000).toFixed(1)}k v  ${(inf.triangles / 1000).toFixed(1)}k t  ${r.calls} calls  ${(ms / 1000).toFixed(1)}s` });
  }
  return { tiles };
}

window.__animals = {
  THREE, scene, camera, renderer, hemi, sun, H,
  listSpecies, loadSpecies, QUALITY,
  spawn, info, step, stepAsync, snapshot, play, view, render,
  move: (o) => H.animal.move(o), stop: () => H.animal.stop(), follow: (p, v) => H.animal.follow(new THREE.Vector3(...p), new THREE.Vector3(...v)),
  gaitStrip, actionStrip, turntable, face, closeup, holeViews, eyeViews, tiers, strideFreq, ensureStanding,
  ready: true,
};
