// The demo reel's cast and shot list. Format: see the comment block at the top of demo.js. Every number
// here is meant to be tweaked: shot lengths are multiples of 0.5 s (120 BPM), positions are world
// metres (the lake is at x 15, z 13, radius ~10; the sun sets towards -X), camera angles are degrees.
//
// Camera rig S.orbit({ actor, frame, a: {...}, b: {...}, ease }): spherical coordinates around the
// tracked animal, interpolated a -> b over the shot. frame 'heading': az 0 is in front of the animal,
// 90 its left side (it faces left in the frame), -90 its right side, 180 behind; el: elevation (deg),
// d: distance (m) or fit: multiples of the distance at which the animal's bounding sphere fills the
// frame; head: 0 body centre .. 1 head; y / lead / side: target offsets (m, animal frame).
// S.path({ actor, keys }) is the keyframed version, S.fixed({ pos, pos1, actor | look, fov }) a
// (slowly moving) fixed camera. Everything the animals do is feature-detected (S.play returns false
// for a missing action).
//
// Light: the whole reel is one evening (LOOK below: one sky grade, one haze, one bounce fill). Every
// animal is turned with lit(camAz, rel): its heading for a camera at orbit azimuth camAz with the sun
// at `rel` degrees from the view direction (0 into the sun, 180 behind the camera; < 0 the sun on the
// left of the frame). The sun stays on the left through the reel and rel changes gradually from shot
// to shot: 3/4 front light (-100 .. -135) for coats, 3/4 back light (-15 .. -50) for the rim-lit
// moments (the opening, the roar, the shore, the crow, the finale).
import * as THREE from 'three';

const DEG = Math.PI / 180;
/** heading (radians) pointing towards the sun at a time of day (showcase/src/environment.js) */
export const sunAz = (tod) => { const a = (-100 + 200 * tod + 180) * DEG; return Math.atan2(Math.sin(a), Math.cos(a)); };
const TOD = 0.978;           // golden hour: the sun ~10 deg up in the west
const SUN = sunAz(TOD);       // heading towards the sun
const OPEN_TOD = 0.992;       // the opening: the sun ~6 deg up
const OPEN_SUN = sunAz(OPEN_TOD);
/** the heading that shows an animal from orbit azimuth camAz (deg) with the sun at rel (deg) from the
 *  view direction (> 0: the sun on the right of the frame, < 0 on the left) */
const lit = (camAz, rel, sun = SUN) => sun + (rel - camAz) * DEG - Math.PI;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const LAKE = { x: 15, z: 13 };
const towardLake = (x, z) => Math.atan2(LAKE.x - x, LAKE.z - z);
const FISH = { x: 15.6, z: 11.6 }; // over the lake's flat sandy floor (3.2 m down): the school reads against bright sand
// the eagle's feathers grow back over these shot seconds (its skin weights before)
const EAGLE_FEATHERS = [1.1, 2.6];
// the horses' echelon: the grey on the far side and ahead, the buckskin on the near side and behind
const HGREY = { side: 2.8, back: -1.7 }, HBUCK = { side: -2.6, back: 3.2 };
// (a tighter echelon for portrait crops: the wide one left three small horses in a strip of a tall frame)
const HGREY_P = { side: 1.9, back: -1.3 }, HBUCK_P = { side: -1.8, back: 2.4 };
const hSlots = (S) => (S.portrait ? [HGREY_P, HBUCK_P] : [HGREY, HBUCK]);
// the opening: the lion walks out of the low sun towards a camera in front of him
const OPEN = { x: -45, z: -38, h: lit(22, -14, OPEN_SUN) };
// the boar charges at a camera that waits ahead of it on a long lens
const BOAR = { x: 58, z: -62, h: lit(30, -155) };

// The reel's one evening look (every shot; a shot's `look: {...}` overrides parts of it, merged):
//   sky: the visible sky's grade (demo.js patchSky): knee (soft ceiling of the sky radiance: no white
//        plateau round a low sun), low / high (tints at the horizon / overhead), sat (saturation of the
//        sky), warm (the sunset band towards the sun), disc (the sun disc's peak), halo ([core, core width
//        (rad), aureole, aureole width]: the shaped glow round the sun), gain, clouds (cover)
//   fog: the haze colour (the distant plains sink into it), hills: the distant ranges' colour (flat)
//   fill: the animals' camera-side bounce light (the coat's uFill: lifts the side turned from the sun)
//   hemi: sky light on the world (scale), post: the grade (warm split tone, saturation, sky grad,
//   vignette), exposure (scale), props: the showcase's set pieces (dead tree, fence, logs, rocks),
//   trees: { r } (a clearing without acacias round the subject, laid at the cut), water: the lake seen
//   from above or below its surface in the water shots, ripples: the water rings
export const LOOK = {
  sky: { knee: 0.3, low: [1.15, 0.88, 0.84], high: [0.84, 0.93, 1.03], sat: 0.78, warm: 0.6, warmTint: [1.0, 0.7, 0.36], disc: 8, halo: [1.6, 0.018, 0.45, 0.16], haloColor: [1.0, 0.68, 0.38], gain: 0.9, clouds: 0.26 },
  fog: [0.5, 0.4, 0.36],
  // the distant ranges: unlit, unfogged dusk silhouettes (lit and fogged they read as pale snow peaks)
  hills: { color: [0.2, 0.18, 0.2], emissive: [0.155, 0.13, 0.14] },
  fill: 1.7,
  hemi: 1,
  post: { warm: 0.9, sat: 1.08, skyGrad: 0.08, vignette: 0.28 },
  // (+0.37 EV over the earlier grade, which read murky on phone screens: mean luma ~70 / 255)
  exposure: 1.45,
  props: false,
  // no acacia within r metres of the subject (their low-poly canopies read as faceted blobs close up,
  // and at mid distance they kept landing right behind an animal's head); the far ones stay
  trees: { r: 220 },
  // the lake in the water shots (a shot with water > 0): sigma - absorption per metre (red goes first:
  // clear water turns teal with depth), color - the deep water's own colour (linear), caustic -
  // [strength, cells per metre, fade per metre of depth, speed]
  water: { sigma: [0.42, 0.1, 0.085], color: [0.004, 0.018, 0.02], caustic: [0.9, 1.4, 0.12, 1] },
  // the water rings' colour (linear) and opacity
  ripples: [0.05, 0.06, 0.06, 0.25],
};

// the end card: the title lockup and this repository line (&repo= / record.mjs --repo override it)
export const END_CARD = {
  repo: 'github.com/majidmanzarpour/threejs-procedural-animals',
};

// the one short name a species' shot shows (the reel keeps text to a minimum; a shot's title.name wins)
export const NAMES = {
  lion: 'Lion', cheetah: 'Cheetah', fox: 'Red fox', bear: 'Grizzly', cat: 'Cat', dog: 'Dog', rat: 'Rat',
  wolf: 'Wolf', horse: 'Horse', deer: 'Deer', crow: 'Crow', pig: 'Pig', boar: 'Wild boar', chicken: 'Chicken',
  goat: 'Goat', eagle: 'Bald eagle', sheep: 'Sheep', fish: 'Fish', shark: 'Great white', cow: 'Cow',
  frog: 'Bullfrog', rabbit: 'Rabbit', snake: 'Rattlesnake', spider: 'Tarantula',
};

// ------------------------------------------------------------------ cast (built once, before the reel)
// quality: hero for close-ups, high otherwise; layers: the "how it's made" layers (mesh: the tier the
// clay / wireframe is drawn from)
export const CAST = {
  lion: { species: 'lion', seed: 1, quality: 'hero', sex: 'male', variant: 'tawny', layers: { mesh: 'crowd' } },
  lionB: { species: 'lion', seed: 1, quality: 'hero', sex: 'male', variant: 'tawny' }, // the same lion (a second instance)
  cheetah: { species: 'cheetah', seed: 1, quality: 'hero' },
  fox: { species: 'fox', seed: 1, quality: 'hero', variant: 'red' },
  bear: { species: 'bear', seed: 1, quality: 'hero', variant: 'grizzly', sex: 'male' },
  cat: { species: 'cat', seed: 1, quality: 'hero', variant: 'tuxedo' },
  // the re-roll: one cat, four seeds and coats, swapped on the beat in one locked-off frame
  catR1: { species: 'cat', seed: 2, quality: 'high', variant: 'ginger' },
  catR2: { species: 'cat', seed: 3, quality: 'high', variant: 'calico' },
  catR3: { species: 'cat', seed: 4, quality: 'high', variant: 'grey' },
  catR4: { species: 'cat', seed: 5, quality: 'high', variant: 'mackerel' },
  dog: { species: 'dog', seed: 1, quality: 'hero', variant: 'shepherd' },
  rat: { species: 'rat', seed: 1, quality: 'hero', variant: 'hooded' },
  wolf: { species: 'wolf', seed: 1, quality: 'hero', layers: { mesh: 'crowd' } },
  horseBay: { species: 'horse', seed: 1, quality: 'hero', variant: 'bay' },
  horseRev: { species: 'horse', seed: 1, quality: 'hero', variant: 'bay', layers: { mesh: 'low' } }, // the same bay, with layers
  horseGrey: { species: 'horse', seed: 2, quality: 'high', variant: 'grey' },
  // (a buckskin: golden with black points and mane; the palomino read as a flat yellow cut-out on the gold grass)
  horseBuck: { species: 'horse', seed: 3, quality: 'high', variant: 'buckskin' },
  deer: { species: 'deer', seed: 1, quality: 'hero', sex: 'male', variant: 'winter' },
  goatA: { species: 'goat', seed: 1, quality: 'hero', variant: 'saanen', sex: 'male' },
  goatB: { species: 'goat', seed: 2, quality: 'hero', variant: 'pied', sex: 'male' },
  goatC: { species: 'goat', seed: 3, quality: 'high', variant: 'nubian' },
  goatD: { species: 'goat', seed: 4, quality: 'high', variant: 'boer' },
  sheepA: { species: 'sheep', seed: 1, quality: 'high', variant: 'suffolk' },
  sheepB: { species: 'sheep', seed: 2, quality: 'high', variant: 'merino' },
  sheepC: { species: 'sheep', seed: 3, quality: 'high', variant: 'black' },
  sheepD: { species: 'sheep', seed: 4, quality: 'high', variant: 'whiteface', age: 'juvenile' }, // a lamb (lambs pronk)
  cow: { species: 'cow', seed: 1, quality: 'hero', variant: 'holstein' },
  cowB: { species: 'cow', seed: 2, quality: 'high', variant: 'hereford' },
  cowC: { species: 'cow', seed: 3, quality: 'high', variant: 'highland' },
  // (a Duroc: red-brown reads as a pig in the evening light; the Large White read as plaster)
  pig: { species: 'pig', seed: 1, quality: 'hero', variant: 'duroc' },
  boar: { species: 'boar', seed: 1, quality: 'hero', variant: 'adult', sex: 'male' },
  rooster: { species: 'chicken', seed: 1, quality: 'hero', variant: 'red', sex: 'male' },
  henA: { species: 'chicken', seed: 2, quality: 'high', variant: 'leghorn', sex: 'female' },
  henB: { species: 'chicken', seed: 3, quality: 'high', variant: 'buff', sex: 'female' },
  crow: { species: 'crow', seed: 1, quality: 'hero', variant: 'hooded' },
  eagle: { species: 'eagle', seed: 1, quality: 'hero', variant: 'bald', layers: { mesh: 'medium' } }, // (the low mesh read lumpy under the weights)
  trout: { species: 'fish', seed: 1, quality: 'hero', variant: 'trout' },
  trout2: { species: 'fish', seed: 2, quality: 'high', variant: 'trout' },
  bluegill: { species: 'fish', seed: 3, quality: 'high', variant: 'bluegill' },
  bluegill2: { species: 'fish', seed: 4, quality: 'high', variant: 'bluegill' },
  goldfish: { species: 'fish', seed: 5, quality: 'high', variant: 'goldfish' },
  clownfish: { species: 'fish', seed: 6, quality: 'high', variant: 'clownfish' },
  shark: { species: 'shark', seed: 1, quality: 'hero', variant: 'white', layers: { mesh: 'crowd' } },
  frog: { species: 'frog', seed: 1, quality: 'hero', variant: 'bullfrog', sex: 'male' },
  rabbit: { species: 'rabbit', seed: 1, quality: 'hero' },
  rattlesnake: { species: 'snake', seed: 1, quality: 'hero', variant: 'rattlesnake' },
  tarantula: { species: 'spider', seed: 1, quality: 'hero', variant: 'tarantula', layers: { mesh: 'crowd' } },
  tarantulaB: { species: 'spider', seed: 1, quality: 'high', variant: 'tarantula' }, // the finale's (the shot before it has the first)
};

// ------------------------------------------------------------------ helpers
// a school of fish milling round a drifting centre; each fish steers to its slot
function school(S, keys, cx, cz, y, t, { r = 0.5, spin = 0.25, speed = 0.25 } = {}) {
  const n = keys.length;
  keys.forEach((k, i) => {
    const a = S.a(k);
    if (!a) return;
    const ang = (i / n) * Math.PI * 2 + t * spin * (i % 2 ? 1 : 1.15);
    const rr = r * (0.55 + 0.45 * ((i * 7) % 5) / 4);
    const tx = cx + Math.cos(ang) * rr, tz = cz + Math.sin(ang) * rr, ty = y + Math.sin(t * 0.7 + i) * 0.06;
    const p = a.position;
    const dx = tx - p.x, dz = tz - p.z, dy = ty - p.y;
    const dist = Math.hypot(dx, dz);
    S.move(k, Math.min(speed * 1.8, speed * 0.5 + dist * 0.8), Math.atan2(dx, dz), Math.max(-1, Math.min(1, dy * 3)));
  });
}
// followers keep a slot beside / behind a leader (side: m to the leader's left, back: m behind it)
function formation(S, lead, slots) {
  const L = S.a(lead);
  if (!L) return;
  const h = L.heading, v = L.speed || 0;
  for (const { key, side, back } of slots) {
    const a = S.a(key);
    if (!a) continue;
    const tx = L.position.x + Math.cos(h) * side - Math.sin(h) * back, tz = L.position.z - Math.sin(h) * side - Math.cos(h) * back;
    const dx = tx - a.position.x, dz = tz - a.position.z;
    const along = dx * Math.sin(h) + dz * Math.cos(h), across = dx * Math.cos(h) - dz * Math.sin(h);
    S.move(key, Math.max(0, v + along * 0.8), h + Math.max(-0.25, Math.min(0.25, across * 0.15)));
  }
}
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// smootherstep (C2): speed ramps whose subject the camera tracks keep the camera's jerk continuous
const sm5 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * t * (t * (t * 6 - 15) + 10); };
// a point `side` m to the left of / `ahead` m in front of (x, z) for heading h
const offset = (x, z, h, side, ahead = 0) => [x + Math.cos(h) * side + Math.sin(h) * ahead, z - Math.sin(h) * side + Math.cos(h) * ahead];

// the opening: the lion walks out of the sun made of his SDF primitives (they assemble in the first
// second), then a glowing front sweeps nose to tail and the coat grows back behind it
function openReveal(S, t) {
  const L = S.layers('lion');
  if (!L) return;
  const u = sm(1.2, 2.75, t);
  const st = {};
  // (the front runs on past the tail by the growth band, so the fur is fully grown everywhere when the
  // wipe ends: nothing changes length at once)
  const M = 0.34;
  if (u < 1) st.prims = { build: sm(0.0, 1.15, t), clip: u > 0 ? L.wipe('-z', u, { side: -1, glow: 2.2, margin: M }) : null };
  st.coat = u > 0 ? { on: true, clip: u < 1 ? L.wipe('-z', u, { side: 1, glow: 3, margin: M }) : null, grow: sm(1.3, 3.3, t), growBand: 0.3, eyes: u > L.frontU('-z', L.eyeRest(), M) } : { on: false };
  L.set(st);
}

// the big "how it's made" sequence: SDF primitives -> meshed skin -> skin weights -> skeleton + IK ->
// the coat growing back, one continuous shot (times in shot seconds)
function bigReveal(S, key, t, T = { mesh: 2.6, weights: 4.4, rig: 6.0, coat: 7.6, done: 9.4 }) {
  const L = S.layers(key);
  if (!L) return;
  const W = 1.1; // wipe length (s)
  const wipe = (t0) => Math.min(1, Math.max(0, (t - t0) / W));
  const f = (ax, u, side, glow = 2.5) => L.wipe(ax, u, { side, glow });
  const st = { coat: { on: false } };
  if (t < T.mesh + W) {
    st.prims = { build: sm(-0.7, 1.7, t), clip: t > T.mesh ? f('-z', wipe(T.mesh), -1) : null };
    if (t > T.mesh) { st.clay = { clip: f('-z', wipe(T.mesh), 1) }; st.wire = { alpha: 0.75, clip: f('-z', wipe(T.mesh), 1) }; }
  } else if (t < T.weights + W) {
    st.clay = { clip: t > T.weights ? f('y', wipe(T.weights), -1) : null };
    st.wire = { alpha: 0.75 * (1 - wipe(T.weights)), clip: t > T.weights ? f('y', wipe(T.weights), -1) : null };
    if (t > T.weights) st.weights = { clip: f('y', wipe(T.weights), 1) };
  } else if (t < T.rig + W) {
    st.weights = { clip: t > T.rig ? f('-z', wipe(T.rig), -1) : null };
    if (t > T.rig) { st.xray = { alpha: 1, clip: f('-z', wipe(T.rig), 1) }; st.skel = { alpha: sm(T.rig, T.rig + 0.8, t) }; }
  } else {
    const u = wipe(T.coat);
    const cf = (side, glow = 2.5) => L.wipe('y', u, { side, glow, margin: 0.2 });
    st.xray = { alpha: 1, clip: t > T.coat ? cf(-1) : null };
    st.skel = { alpha: 1 - sm(T.coat + 0.2, T.coat + W, t) };
    if (t > T.coat) st.coat = { on: true, clip: u < 1 ? cf(1, 3) : null, grow: sm(T.coat, T.done, t), growBand: 0.18, eyes: u > L.frontU('y', L.eyeRest(), 0.2) };
  }
  L.set(st);
}
// one word per stage (the reel keeps text to a minimum)
const STAGE_WORDS = ['SDF', 'Mesh', 'Weights', 'Skeleton', 'Fur'];
function bigCaption(S, key, t, T = { mesh: 2.6, weights: 4.4, rig: 6.0, coat: 7.6, done: 9.4 }) {
  if (!S.A(key)) return null;
  const step = t < T.mesh ? 0 : t < T.weights ? 1 : t < T.rig ? 2 : t < T.coat ? 3 : 4;
  const t0 = [0, T.mesh, T.weights, T.rig, T.coat][step];
  const t1 = [T.mesh, T.weights, T.rig, T.coat, T.done + 60][step]; // (finite: sm() of infinities is NaN)
  // each stage's word fades out over the 0.3 s before the next stage and the next fades in after it
  const titleA = sm(t0 + 0.02, t0 + 0.4, t) * (1 - sm(t1 - 0.32, t1 - 0.02, t));
  return { t, dur: T.done + 0.8, stageT: (t - t0) / 1.2, titleA, title: STAGE_WORDS[step] };
}

// ------------------------------------------------------------------ the finale: all 24 at the lake
// Everyone gathers on the east shore of the lake, the camera to the east of them looking west across the
// water into the low sun: the big ones at the waterline, the hunters and the farm animals in the middle,
// the small ones in front and the tiny ones (tarantula, frog, rat, rattlesnake) right at the lens where
// the crane starts. Rows are staggered so that nobody hides anybody, and the crane (pulling back and up)
// keeps everyone either whole in the frame or, the tiny ones at the end, clearly out of it (below).
// [actor, x, z, heading (0 = +z: left in the frame, pi/2 towards the camera), action | null]
const FINALE = [
  // the waterline (the east shore runs from (22, 6) to (23, 21) round x 25)
  ['bear', 26.0, 20.4, 2.0, null],
  ['horseGrey', 25.8, 16.1, 0.5, 'eat'],
  ['horseBay', 26.2, 13.3, 2.55, null],
  ['cow', 26.0, 10.2, 0.55, 'eat'],
  ['deer', 25.0, 7.6, 2.5, 'drink'],
  // the middle
  ['goatC', 29.0, 17.6, 1.0, 'eat'],
  ['lion', 29.8, 16.8, 1.25, 'lie'],
  ['cheetah', 30.2, 14.6, 1.45, 'sit'],
  ['wolf', 30.0, 12.1, 2.1, null],
  ['sheepB', 28.4, 11.2, 2.3, 'eat'],
  ['pig', 29.3, 9.8, 0.95, 'root'],
  ['boar', 30.4, 8.7, 2.45, null],
  // in front
  ['sheepD', 31.7, 15.25, 1.2, null],
  ['rooster', 32.7, 12.75, 1.9, null],
  ['henA', 33.1, 12.15, 1.0, 'eat'],
  ['dog', 33.9, 14.6, 1.25, 'sit'],
  ['cat', 34.4, 13.2, 1.57, 'sit'],
  ['fox', 34.0, 11.7, 1.85, 'sit'],
  ['rabbit', 34.3, 10.95, 1.25, null],
  // at the lens: big in the first seconds (the crane starts among them, looking down at them), they
  // slide out under the frame as it rises and tilts up to the herd
  ['rat', 37.55, 13.85, 1.9, 'groom'],
  ['rattlesnake', 36.8, 12.75, 1.3, 'coil'],
  ['tarantulaB', 38.3, 13.3, 1.57, null],
  ['frog', 37.95, 12.55, 2.3, 'croak'],
];
// the finale's sun: a wider, warmer glow (the reel's own read as a small pale disc over the herd)
const FIN_SKY = { halo: [2.2, 0.03, 0.62, 0.21] };
const FIN_CAST = [...FINALE.map((r) => r[0]), 'shark', 'trout', 'eagle', 'crow'];
function finaleSetup(S) {
  for (const [k, x, z, h, action, o] of FINALE) {
    S.place(k, x, z, h);
    if (action) S.play(k, action, o || {});
  }
  const wl = S.world.waterLevel;
  // the shark patrols north through the glitter with its dorsal fin out; a trout waits to leap
  S.place('shark', 18.6, 5.4, 0.05, wl - 0.18); S.move('shark', S.gear('shark', 'patrol', 'cruise'), 0.05, 0);
  S.place('trout', 20.2, 11.0, -0.6, wl - 0.35); S.move('trout', S.gear('trout', 'cruise'), -0.6);
  // the eagle circles over the lake (a steady bank, finaleUpdate); the crow crosses low over the herd
  // from left to right in the first seconds (it is out of the frame at the cut: the pre-roll is 3 s)
  const E = FIN_EAGLE, a0 = E.w * -3;
  S.place('eagle', E.x + Math.cos(a0) * E.r, E.z - Math.sin(a0) * E.r, a0, wl + E.y); S.move('eagle', E.v, a0, 0);
  S.place('crow', 25.5, 50, Math.PI + 0.05, S.ground(25.5, 50) + 3.2); S.move('crow', 7.5, Math.PI + 0.05, 0);
}
// the eagle's circle over the lake: centre (x, z), radius r (m), height above the water y, speed v (m/s),
// turn rate w (rad/s: v / r)
const FIN_EAGLE = { x: 17, z: 13.5, r: 6.5, y: 6.2, v: 7.5, w: 7.5 / 6.5 };
function finaleUpdate(S) {
  S.at(1.2, () => S.play('sheepD', 'pronk'));
  S.at(2.0, () => S.input('wolf', 'howl', true));
  S.at(2.6, () => S.play('rooster', 'idle', { behaviour: 'crow' }));
  S.at(3.1, () => S.play('lion', 'yawn'));
  S.at(5.6, () => S.play('trout', 'jump'));
  S.at(4.6, () => S.play('sheepD', 'pronk'));
  S.at(5.2, () => S.input('wolf', 'howl', false));
  // the eagle banks round its circle (heading from the time: a steady turn from the pre-roll on)
  const E = FIN_EAGLE, a = S.a('eagle');
  if (a) { const wl = S.world.waterLevel; S.move('eagle', E.v, E.w * S.t, Math.max(-0.5, Math.min(0.5, (wl + E.y - a.position.y) * 0.8))); }
}
// the crane over the finale and the end card (13 s, eased at both ends): from the tiny ones at the lens,
// up and back to the whole gathering round the glittering lake; over the end card it tilts up a little
// more, so the title sits in the evening sky above the herd. World positions (x, height above the
// ground, z); look targets (x, height above the water, z); tilt: [t0, t1, metres] of extra look height.
const FIN = { T: 13, p0: [39.1, 0.32, 13.05], p1: [42.6, 3.4, 13.2], l0: [33.2, 0.3, 13.0], l1: [27.2, 0.35, 13.1], fov0: 37, fov1: 40, tilt: [7.4, 12.8, 3.6] };
function finaleCam(S, t) {
  const u = sm5(0, 1, t / FIN.T);
  const w = S.world, wl = w.waterLevel;
  const L = (a, b) => a + (b - a) * u;
  const x = L(FIN.p0[0], FIN.p1[0]), z = L(FIN.p0[2], FIN.p1[2]);
  const y = w.ground(x, z) + L(FIN.p0[1], FIN.p1[1]);
  const ly = wl + L(FIN.l0[1], FIN.l1[1]) + FIN.tilt[2] * sm5(FIN.tilt[0], FIN.tilt[1], t);
  return S.fixed({ pos: [x, y, z], look: [L(FIN.l0[0], FIN.l1[0]), ly, L(FIN.l0[2], FIN.l1[2])], fov: L(FIN.fov0, FIN.fov1) });
}

// ------------------------------------------------------------------ the reel
export const SHOTS = [
  // ============================================================ opening: the lion
  {
    id: 'open', portrait: false, dur: 6.5, pre: 2, cast: ['lion'], title: 'open', titleDur: 6.1, titleStart: 1.5, titleY: 0.25,
    fadeIn: 0.35, tod: OPEN_TOD, bloom: 0.05, skyWarm: 1, clouds: 0.16, fill: 2.1, look: { trees: { r: 0 } }, live: { tier: 2, scale: 0.75 },
    what: 'cold open: the lion walks out of the low sun built of his SDF primitives (they assemble in the first second); a glowing front sweeps nose to tail and the fur grows back; the title rises in the sky above him',
    setup(S) { S.place('lion', OPEN.x, OPEN.z, OPEN.h); S.move('lion', S.gear('lion', 'walk'), OPEN.h); },
    reveal(S) { openReveal(S, S.t); },
    cam: (S) => S.path({ actor: 'lion', frame: 'heading', headingFrom: 'start', keys: [
      { t: 0, az: 22, el: 3, d: 6.2, fov: 30, y: 0.0, ly: 0.75 },
      { t: 6.5, az: 18, el: 2, d: 6.0, ly: 0.66 },
    ] }),
    grass: { scale: 0.75 },
  },
  {
    id: 'lion-roar', portrait: { horizon: 0.36 }, dur: 4, pre: 1.5, cast: ['lionB'], title: { actor: 'lionB', at: 0.4 }, tod: TOD, live: { scale: 0.7 }, fill: 2.2, bloom: 0.05,
    what: 'the big beat: low in front of the lion, his mane rim-lit by the sun behind him; he looks off, then swings his head to the lens as the roar opens; the lens pushes in and the roar plays in slow motion',
    // the first long call of the roar (0.7 .. 1.7 s into the action) in slow motion
    slow: (t) => 1 - 0.55 * sm5(1.0, 1.45, t) * (1 - sm5(2.7, 3.4, t)),
    // he faces a little to the left of the lens; looking off to his right until the roar takes his head
    // (its pose drops the look: the head swings round to the front, towards the lens)
    setup(S) {
      const h = lit(42, -26);
      S.place('lionB', -40, -26, h);
      // (0.8 rad: within the head's own yaw range - further off, the lion turns its whole body round)
      const a = S.a('lionB'), side = h - 0.8;
      S.look('lionB', new S.THREE.Vector3(a.position.x + Math.sin(side) * 12, a.position.y + 1.2, a.position.z + Math.cos(side) * 12));
    },
    update(S) { S.at(0.55, () => { S.look('lionB', null); S.play('lionB', 'roar'); }); },
    cam: (S) => S.path({ actor: 'lionB', frame: 'heading', headingFrom: 'start', keys: [
      { t: 0, az: 46, el: -4, fit: 1.12, fov: 30, head: 0.45 },
      { t: 1.2, az: 42, el: -2, fit: 0.95, head: 0.62 },
      { t: 4, az: 36, el: 0, fit: 0.64, head: 0.82 },
    ] }),
    grass: { scale: 0.65 },
  },
  // ============================================================ the hunters and the small ones
  {
    // pre 6: it accelerates at ~10 m/s2 and holds 27.5 m/s from ~3.2 s after the start
    id: 'cheetah-sprint', pfit: 1.4, dur: 4.5, pre: 6, cast: ['cheetah'], title: { actor: 'cheetah', at: 0.3 }, tod: TOD, look: { trees: { r: 280 } },
    what: 'the cheetah at full sprint, tracked low from the side in the evening light; slow motion in the middle',
    slow: (t) => 1 - 0.68 * sm5(1.1, 2.1, t) * (1 - sm5(3.3, 4.3, t)),
    setup(S) { const h = lit(-84, -120); S.place('cheetah', 40, -150, h); S.move('cheetah', S.gear('cheetah', 'sprint', 'gallop'), h); },
    // (wide enough that the stride is the subject in the slow motion: the sculpted eye reads as a closed
    // slit close up; turning a little to the front three-quarter, low)
    cam: (S) => S.orbit({ actor: 'cheetah', frame: 'heading', a: { az: -80, el: 2, fit: 1.12, fov: 28, lead: 0.45, y: -0.05 }, b: { az: -64, el: 1, fit: 1.0, fov: 28, lead: 0.5, y: -0.05 }, ease: 'drift' }),
    grass: { scale: 0.5 },
  },
  {
    id: 'fox-pounce', pfit: 1.15, dur: 4, pre: 1, cast: ['fox'], title: { actor: 'fox', at: 0.3 }, tod: TOD, whipOut: { dir: 1, d: 0.25 }, live: { tier: 1 },
    what: 'the red fox freezes, ears pricked at a sound in the grass, then leaps forward (low side view)',
    setup(S) { S.place('fox', 35, -40, lit(80, -100)); S.play('fox', 'listen'); },
    update(S) { S.at(0.35, () => S.play('fox', 'pounce')); },
    track: 0.6,
    // ground-anchored: the leap happens inside a steady frame instead of dragging it along
    cam: (S) => S.orbit({ actor: 'fox', frame: 'heading', headingFrom: 'start', anchor: 'ground', anchorY: 0.95, a: { az: 76, el: 3, fit: 1.08, fov: 30, lead: 0.15 }, b: { az: 84, el: 2, fit: 1.48, fov: 30, lead: 0.22 }, ease: 'inOut' }),
    grass: { actor: 'fox', r: 1.8, k: 0.3, scale: 0.7 },
  },
  {
    id: 'bear-stand', pfit: 1.45, plead: -0.4, dur: 3, pre: 1.5, cast: ['bear'], title: { actor: 'bear', at: 0.3 }, tod: TOD, whipIn: { dir: 1, d: 0.25 }, live: { tier: 1, scale: 0.75 },
    what: 'the grizzly lumbers through the grass in profile against the low sun (rim light on the hump), stops and rises onto its hind legs; the lens tilts up to his full height',
    // (seen from the side, a little behind the shoulder, with the sun in the frame: the mass, the hump
    // and the stance read in the rim light, the face stays small and turned away. From the front the
    // standing bear read as a begging teddy)
    setup(S) { const h = lit(108, -16); S.place('bear', -46, -30, h); S.move('bear', S.gear('bear', 'amble', 'walk') * 0.75, h); },
    update(S) {
      S.at(1.15, () => {
        const a = S.a('bear'), h = a.heading;
        S.move('bear', 0, h);
        S.play('bear', 'standup', { duration: 3, target: new S.THREE.Vector3(a.position.x + Math.sin(h) * 30, a.position.y + 2.2, a.position.z + Math.cos(h) * 30) });
      });
    },
    track: 0.8,
    // low in the grass on his left, a little behind the shoulder; as he rises the lens tilts up and
    // eases back so his whole standing height stays in the frame
    cam: (S) => S.orbit({ actor: 'bear', frame: 'heading', headingFrom: 'start', anchor: 'ground', anchorY: 0.45, u0: 0.3, u1: 0.86, a: { az: 104, el: -2, fit: 1.22, fov: 30, lead: 0.25 }, b: { az: 98, el: -5, fit: 1.5, fov: 30, y: 0.55, lead: 0.1 }, ease: 'inOut' }),
    grass: { scale: 0.6 }, look: { trees: { r: 320 } }, fill: 2.2, bloom: 0.045,
  },
  {
    id: 'cat-pounce', pfit: 1.3, dur: 2.5, pre: 1, cast: ['cat'], live: { tier: 1 }, title: { actor: 'cat', at: 0.3 }, tod: TOD,
    what: 'the tuxedo cat stalks low through the grass, then springs (mid shot, three-quarter view)',
    // (seen from its right: it springs to the right of the frame and a little away from the lens, clear
    // of the title in the lower left)
    setup(S) { S.place('cat', 30, -34, lit(-52, -115)); S.play('cat', 'stalk'); },
    // the attack winds up for ~1.8 s: it springs ~1.4 s into the shot, at a point ahead of it
    update(S) { S.at(-0.4, () => S.play('cat', 'attack', { target: S.camPoint('cat', 16, 1.5, 0) })); },
    track: 0.6, ptrack: 1.4, // (portrait: the narrow frame follows the spring closely, or the cat leaves it)
    cam: (S) => S.orbit({ actor: 'cat', frame: 'heading', headingFrom: 'start', anchor: 'ground', anchorY: 0.7, a: { az: -52, el: 4, fit: 1.35, fov: 30, lead: 0.3 }, b: { az: -40, el: 4, fit: 1.35, fov: 30, lead: 0.55 }, ease: 'inOut' }),
    grass: { actor: 'cat', r: 2.0, k: 0.22, scale: 0.65 },
  },
  {
    // "procedural" in one beat: the same cat re-rolled (seed and coat) on every half second, in the same
    // pose and the same locked-off frame; no text, the image says it
    id: 'cat-reroll', dur: 2, pre: 1.6, cast: ['catR1', 'catR2', 'catR3', 'catR4'], tod: TOD, live: { tier: 1 },
    what: 'the re-roll: one sitting cat, a new seed and coat on every beat (ginger, calico, grey, mackerel tabby) in a locked-off frame',
    setup(S) {
      const h = lit(32, -118);
      for (const k of ['catR1', 'catR2', 'catR3', 'catR4']) { S.place(k, 31, -46, h); S.play(k, 'sit'); }
    },
    // one cat on screen at a time (only once the shot is on: its pre-roll runs under the previous shot)
    update(S) {
      if (S.t < 0) return;
      const keys = ['catR1', 'catR2', 'catR3', 'catR4'], i = Math.min(3, Math.floor(S.t / 0.5 + 1e-6));
      keys.forEach((k, j) => { const A = S.A(k); if (A) A.animal.object.visible = j === i; });
    },
    cam: (S) => S.orbit({ actor: 'catR1', frame: 'heading', headingFrom: 'start', pivot: 'start', lookAt: 'start', a: { az: 34, el: 5, fit: 1.05, fov: 30, head: 0.4 }, b: { az: 31, el: 5, fit: 0.95, fov: 30, head: 0.45 }, ease: 'inOut' }),
    grass: { actor: 'catR1', r: 1.6, k: 0.25, scale: 0.6 },
  },
  {
    id: 'dog-play', pfit: 1.25, dur: 3, pre: 1.5, cast: ['dog'], title: { actor: 'dog', at: 0.3 }, tod: TOD, whipOut: { dir: -1, d: 0.25 }, live: { tier: 1, scale: 0.7 },
    what: 'the shepherd canters through the grass in profile, tracked alongside (three-quarter front light on the saddle)',
    // (the play bow read as a crouching hare: the canter in profile is the dog's best look)
    setup(S) { const h = lit(84, -112); S.place('dog', 32, -44, h); S.move('dog', S.gear('dog', 'canter'), h); },
    update(S) { S.move('dog', S.gear('dog', 'canter'), S.run.start0?.dog?.heading ?? S.a('dog').heading); },
    cam: (S) => S.orbit({ actor: 'dog', frame: 'heading', headingFrom: 'start', a: { az: 82, el: 3, fit: 1.3, fov: 30, lead: 0.35 }, b: { az: 70, el: 2, fit: 1.22, fov: 30, lead: 0.45 }, ease: 'drift' }),
    grass: { actor: 'dog', r: 1.6, k: 0.35, scale: 0.7 },
  },
  {
    id: 'rat-shore', portrait: false, pfit: 1.2, plead: 0, dur: 3, pre: 1, cast: ['rat'], title: { actor: 'rat', at: 0.2 }, tod: TOD, whipIn: { dir: -1, d: 0.25 }, fill: 2.2, live: { tier: 1, scale: 0.75 },
    what: 'macro, low along the shore: the hooded rat scurries over the wet sand, the lake glittering behind it',
    camClear: 0.03,
    // on the east shore, running south along the waterline; the camera on its right (east) looks west over
    // the lake towards the low sun
    setup(S) { S.place('rat', 26.0, 13.2, Math.PI + 0.12); S.move('rat', S.gear('rat', 'gallop'), Math.PI + 0.12); },
    update(S) { S.move('rat', S.gear('rat', 'gallop') * (0.8 + 0.2 * Math.cos(S.t * 2.1)), Math.PI + 0.12 + 0.1 * Math.sin(S.t * 1.3)); },
    track: 0.8,
    cam: (S) => S.orbit({ actor: 'rat', frame: 'heading', headingFrom: 'start', anchor: 'ground', anchorY: 0.55, a: { az: -74, el: 9, fit: 1.38, fov: 30, lead: 0.12 }, b: { az: -84, el: 8, fit: 1.26, fov: 30, lead: 0.12 }, ease: 'inOut' }),
  },
  // ============================================================ how it's made: the wolf
  {
    id: 'reveal-wolf', dur: 10, pre: 1, cast: ['wolf'], tod: TOD, bloom: 0.045, live: { tier: 1 },
    what: "how it's made, one continuous shot: SDF primitives -> meshed skin -> skin weights -> skeleton + IK (it starts walking) -> the fur grows back",
    dim: (t) => 0.85 * (1 - sm(7.4, 9.4, t)),
    setup(S) { S.place('wolf', 40, -60, lit(70, -125)); },
    update(S) { S.at(4.6, () => S.move('wolf', S.gear('wolf', 'walk') * 0.8, S.a('wolf').heading)); S.at(8.9, () => S.move('wolf', 0)); S.at(9.5, () => S.input('wolf', 'howl', true)); },
    reveal(S) { bigReveal(S, 'wolf', S.t); },
    caption: (S) => bigCaption(S, 'wolf', S.t),
    cam: (S) => S.orbit({ actor: 'wolf', frame: 'heading', headingFrom: 'start', a: { az: 58, el: 9, fit: 0.9, fov: 30 }, b: { az: 84, el: 5, fit: 0.98, fov: 30, lead: 0.3 }, ease: 'inOut' }),
    grass: { scale: 0.7 },
  },
  {
    id: 'wolf-howl', portrait: { horizon: 0.4 }, dur: 3.5, keep: true, cast: ['wolf'], title: { actor: 'wolf', at: 0.2 }, tod: TOD, live: { tier: 1, scale: 0.75 },
    what: 'the finished wolf stops and howls',
    update(S) { S.at(0, () => S.move('wolf', 0)); },
    cam: (S) => S.orbit({ actor: 'wolf', frame: 'heading', headingFrom: 'start', a: { az: 34, el: -6, fit: 0.95, fov: 30, head: 0.55 }, b: { az: 28, el: -8, fit: 0.84, fov: 30, head: 0.62 }, ease: 'out' }),
    grass: { scale: 0.7 },
  },
  // ============================================================ hooves and wings (the farm animals between stronger shots)
  {
    id: 'horses', pfit: 1.2, dur: 4, pre: 3, cast: ['horseBay', 'horseGrey', 'horseBuck'], title: { actor: 'horseBay', at: 0.3 }, tod: TOD, live: { tier: 3, scale: 0.7 }, wide: 0.9,
    what: 'three horse coats cantering side by side, tracked from the sunny side',
    setup(S) {
      const h = lit(-70, -130), sp = S.gear('horseBay', 'canter');
      const x = -62, z = -70;
      S.place('horseBay', x, z, h);
      const at = (side, back) => [x + Math.cos(h) * side - Math.sin(h) * back, z - Math.sin(h) * side - Math.cos(h) * back];
      const [G, B] = hSlots(S); S.place('horseGrey', ...at(G.side, G.back), h); S.place('horseBuck', ...at(B.side, B.back), h);
      for (const k of ['horseBay', 'horseGrey', 'horseBuck']) S.move(k, sp, h);
    },
    update(S) { const [G, B] = hSlots(S); formation(S, 'horseBay', [{ key: 'horseGrey', ...G }, { key: 'horseBuck', ...B }]); },
    cam: (S) => S.orbit({ actor: 'horseBay', frame: 'heading', headingFrom: 'start', a: { az: -62, el: 5, fit: 1.95, fov: 30, side: 0.3, lead: -1.1 }, b: { az: -76, el: 4, fit: 1.85, fov: 30, side: 0.3, lead: -1.1 }, ease: 'drift' }),
    focus: (S) => S.sub('horseBay').ground,
    shadow: 8, grass: { scale: 0.7 },
  },
  {
    id: 'reveal-horse', pfit: 1.25, dur: 4, pre: 3, cast: ['horseRev'], tod: TOD, bloom: 0.045,
    what: 'match cut to the x-ray: the galloping bay, skeleton and hoof IK targets; the coat sweeps back from nose to tail',
    dim: (t) => 0.8 * (1 - sm(2.4, 3.6, t)),
    setup(S) { const h = lit(-80, -130); S.place('horseRev', -60, -150, h); S.move('horseRev', S.gear('horseRev', 'gallop'), h); },
    reveal(S) {
      const L = S.layers('horseRev'); if (!L) return;
      const u = sm(2.1, 3.3, S.t);
      L.set({ xray: { alpha: 1, clip: u > 0 ? L.wipe('-z', u, { side: -1, glow: 2 }) : null }, skel: { alpha: 1 - sm(2.4, 3.3, S.t) }, coat: { on: u > 0, clip: u > 0 && u < 1 ? L.wipe('-z', u, { side: 1, glow: 2 }) : null, grow: 1, eyes: u > L.frontU('-z', L.eyeRest()) } });
    },
    // the caption moves on to the coat as its wipe starts (2.1 s): the stage names cross-fade
    caption: (S) => {
      const t = S.t, T1 = 2.1, coat = t >= T1;
      const titleA = coat ? sm(T1 + 0.02, T1 + 0.4, t) : sm(0.02, 0.4, t) * (1 - sm(T1 - 0.32, T1 - 0.02, t));
      return { t, dur: 3.6, stageT: (coat ? t - T1 : t) / 1.2, titleA, title: coat ? 'Coat' : 'Skeleton' };
    },
    // match cut: opens on the framing the group shot ends on (the bay, from its right), then closes in
    cam: (S) => S.orbit({ actor: 'horseRev', frame: 'heading', a: { az: -76, el: 4, fit: 1.85, fov: 30, side: 0.3, lead: -1.1 }, b: { az: -86, el: 5, fit: 1.2, fov: 30, lead: 0.3 }, ease: 'out' }),
    grass: { scale: 0.6 },
  },
  {
    id: 'deer-flee', pfit: 1.1, dur: 2.5, pre: 1.5, cast: ['deer'], title: { actor: 'deer', at: 0.2 }, tod: TOD, fill: 2.1, live: { tier: 1 },
    what: 'the white-tailed buck bounds across the savanna against the low sun, tracked from the side (rim light on the antlers and the raised white tail)',
    // (back-lit and at a distance: the antlers and the bounding body read in the rim light, the face is small)
    setup(S) { const h = lit(78, -42); S.place('deer', 34, -52, h); S.play('deer', 'flee'); S.move('deer', S.gear('deer', 'bound', 'gallop'), h); },
    cam: (S) => S.orbit({ actor: 'deer', frame: 'heading', headingFrom: 'start', a: { az: 78, el: 3, fit: 1.75, fov: 30, lead: 0.6 }, b: { az: 88, el: 3, fit: 1.65, fov: 30, lead: 0.6 }, ease: 'drift' }),
    track: 1.2,
    grass: { scale: 0.7 }, look: { trees: { r: 280 } },
  },
  {
    id: 'crow-takeoff', portrait: false, dur: 3, pre: 1, cast: ['crow'], title: { actor: 'crow', at: 0.3 }, tod: TOD, fill: 2.2, live: { tier: 2 },
    what: 'the hooded crow (its grey mantle lit by the low sun) takes off away from the lens in slow motion and climbs over the savanna; a tripod tilts after it',
    slow: (t) => 1 - 0.55 * sm5(0.25, 0.7, t) * (1 - sm5(1.85, 2.45, t)),
    // seen from behind its left shoulder, the sun on the left: it flies away from the camera (a bird
    // flying across near the lens would force a whip-fast pan)
    setup(S) { S.place('crow', 12, -38, lit(150, -115)); },
    update(S) { S.at(0.5, () => { S.play('crow', 'takeoff'); S.move('crow', S.gear('crow', 'fly') * 0.8, S.a('crow').heading, 0.45); }); },
    track: 1.2,
    cam: (S) => S.orbit({ actor: 'crow', frame: 'heading', pivot: 'start', a: { az: 150, el: 4, fit: 1.7, fov: 30, head: 0.2 }, b: { az: 150, el: 4, fit: 1.7, fov: 34, head: 0.2 }, ease: 'inOut' }),
    grass: { actor: 'crow', r: 1.4, k: 0.3, scale: 0.7 },
  },
  {
    id: 'pig-trot', dur: 2.5, pre: 1.5, cast: ['pig'], title: { actor: 'pig', at: 0.25 }, tod: TOD, live: { tier: 1 },
    what: 'a red Duroc pig trots past, ears flapping, tracked from the side (its wild cousin charges next)',
    setup(S) { const h = lit(64, -112); S.place('pig', 26, -28, h); S.move('pig', S.gear('pig', 'trot'), h); },
    cam: (S) => S.orbit({ actor: 'pig', frame: 'heading', headingFrom: 'start', a: { az: 60, el: 5, fit: 1.5, fov: 30 }, b: { az: 72, el: 4, fit: 1.4, fov: 30, lead: 0.2 }, ease: 'inOut' }),
    grass: { actor: 'pig', r: 1.8, k: 0.35, scale: 0.65 },
  },
  {
    id: 'boar-charge', portrait: { horizon: 0.34 }, pfit: 1.1, dur: 3, pre: 1.5, cast: ['boar'], title: { actor: 'boar', at: 0.3 }, tod: TOD, whipOut: { dir: -1, d: 0.25 }, live: { tier: 2, scale: 0.75 },
    what: 'the wild boar charges, tracked low from its front three-quarter; the camera swings round to meet it head on',
    setup(S) { S.place('boar', BOAR.x, BOAR.z, BOAR.h); S.move('boar', S.gear('boar', 'gallop'), BOAR.h); },
    cam: (S) => S.orbit({ actor: 'boar', frame: 'heading', headingFrom: 'start', a: { az: 42, el: 2, fit: 1.45, fov: 30, lead: 0.4 }, b: { az: 14, el: 1, fit: 1.15, fov: 30, lead: 0.3 }, ease: 'inOut' }),
    track: 0.8, grass: { actor: 'boar', r: 3, k: 0.4, scale: 0.5 }, exposure: 1.3, fill: 2.6,
  },
  {
    id: 'rooster', pfit: 1.3, dur: 3, pre: 1.5, cast: ['rooster', 'henA', 'henB'], title: { actor: 'rooster', at: 0.3 }, tod: TOD, whipIn: { dir: -1, d: 0.25 }, live: { tier: 3, scale: 0.7 }, wide: 0.9,
    what: 'the rooster crows; hens scratch and peck in front of him',
    setup(S) {
      const h = lit(24, -130), x = 8, z = -30;
      const at = (side, back) => [x + Math.cos(h) * side - Math.sin(h) * back, z - Math.sin(h) * side - Math.cos(h) * back];
      S.place('rooster', x, z, h); S.place('henA', ...at(0.55, -0.55), h + 1.1); S.place('henB', ...at(-0.62, -0.3), h - 0.9);
      S.play('henA', 'eat'); S.play('henB', 'eat');
    },
    update(S) { S.at(-0.4, () => S.play('rooster', 'idle', { behaviour: 'crow' })); },
    cam: (S) => S.orbit({ actor: 'rooster', frame: 'heading', headingFrom: 'start', a: { az: 28, el: 4, fit: 1.7, fov: 30, head: 0.3 }, b: { az: 20, el: 3, fit: 1.4, fov: 30, head: 0.4 }, ease: 'out' }),
    grass: { actor: 'rooster', r: 1.8, k: 0.2, scale: 0.7 }, shadow: 2,
  },
  {
    id: 'goats', dur: 2.5, pre: 1, cast: ['goatA', 'goatB', 'goatC'], title: { actor: 'goatA', at: 0.25 }, tod: TOD, live: { tier: 3, scale: 0.7 }, wide: 0.7, fill: 2.1,
    what: 'two billy goats rear and clash heads against the low sun, horns in the rim light; a nubian looks on from behind',
    setup(S) {
      // the pair faces across the frame (the camera looks along v, the sun 40 deg to its left: back light,
      // the heads read as horned silhouettes)
      const v = SUN - 40 * DEG, x = -30, z = -50;
      const rx = -Math.cos(v), rz = Math.sin(v); // the camera's right
      S.place('goatA', x - rx * 0.85, z - rz * 0.85, Math.atan2(rx, rz));
      S.place('goatB', x + rx * 0.85, z + rz * 0.85, Math.atan2(-rx, -rz));
      const bx = x + Math.sin(v) * 3.6, bz = z + Math.cos(v) * 3.6;
      S.place('goatC', bx - rx * 2.6, bz - rz * 2.6, v + Math.PI - 0.9);
    },
    update(S) { S.at(0.05, () => { S.play('goatA', 'attack', { target: S.a('goatB').position.clone() }); S.play('goatB', 'attack', { target: S.a('goatA').position.clone() }); }); S.at(0, () => S.look('goatC', S.a('goatA').position.clone())); },
    cam: (S) => {
      const v = SUN - 40 * DEG, x = -30, z = -50;
      const d0 = 7.4, d1 = 6.7;
      return S.fixed({ pos: [x - Math.sin(v) * d0, 0.7, z - Math.cos(v) * d0], pos1: [x - Math.sin(v) * d1 + 0.3 * Math.cos(v), 0.66, z - Math.cos(v) * d1 - 0.3 * Math.sin(v)], relGround: true, look: [x + Math.sin(v) * 0.8, 0.75, z + Math.cos(v) * 0.8], lookRelGround: true, fov: 34 });
    },
    focus: () => V(-30, 0, -50), shadow: 6, grass: { scale: 0.6 },
  },
  {
    id: 'eagle', portrait: false, pfit: 1.3, dur: 7.5, pre: 8, cast: ['eagle'], tod: TOD, bloom: 0.045, live: { tier: 1 }, title: { actor: 'eagle', at: 3.4 },
    what: 'one continuous shot: the eagle soars on flat wings with its skin weights across them; the feathers grow back from the body out to the wingtips; a few deep wing beats, then it banks towards the lens in a glide',
    track: 1,
    // (a light stage dusk: the bird is seen against the sky, which a deep dim turned near black)
    dim: (t) => 0.35 * (1 - sm(1.4, 2.6, t)),
    // soaring (a forced glide: flat plank wings, the slotted primaries up) while the weights and the
    // feathers show, a few deep beats as the title comes in, then a banking glide. (Flapping all the
    // way, the camera kept catching the wing at the top of its stroke: a frozen V.) The glides lose
    // height, so the pre-roll climbs higher first.
    // (a long climb in the pre-roll: the glides sink ~0.9 m/s, and the lens stays below the bird all shot)
    setup(S) { const h = lit(-80, -135); S.place('eagle', -10, -40, h); S.move('eagle', S.gear('eagle', 'fly'), h, 3.5); S.run.state.h = h; },
    update(S) {
      const h = S.run.state.h, v = S.gear('eagle', 'fly');
      // (gliding well before the camera's trackers restart at -0.5 s: a climb that stopped at the cut
      // carried the frame on upwards, the bird sank to the bottom edge in the first frames)
      S.at(-1.6, () => { S.move('eagle', v, h, 0); S.play('eagle', 'glide', { duration: 5.1 }); });
      S.at(3.5, () => S.play('eagle', 'flap', { duration: 1.1 }));
      S.at(4.6, () => S.play('eagle', 'glide', { duration: 4 }));
      if (S.t > 4.4) S.move('eagle', v, h - 0.7 * sm(4.4, 7.5, S.t), 0); // (it banks towards the lens: its back and both wings in plan)
    },
    reveal(S) {
      const L = S.layers('eagle'); if (!L) return;
      // the feathers grow out from the body along the wings to the tips (a sphere round the body
      // centre, in rest space, growing past the wingtips)
      const u = sm(EAGLE_FEATHERS[0], EAGLE_FEATHERS[1], S.t);
      if (u >= 1) { L.set({ coat: { on: true } }); return; }
      L.set({ weights: { clip: u > 0 ? L.radial(u, { side: -1, glow: 3 }) : null }, coat: { on: u > 0, clip: u > 0 ? L.radial(u, { side: 1, glow: 3 }) : null, grow: 1, eyes: u > L.radialU(L.eyeRest()) } });
    },
    // skin weights, then the feathers as they grow (two stages of its own; the names cross-fade)
    caption: (S) => {
      const t = S.t, T1 = EAGLE_FEATHERS[0], fe = t >= T1;
      if (t >= 3.4) return null;
      const titleA = fe ? sm(T1 + 0.02, T1 + 0.4, t) : sm(0.02, 0.4, t) * (1 - sm(T1 - 0.32, T1 - 0.02, t));
      return { t, dur: 3.4, stageT: (fe ? t - T1 : t) / 1.2, titleA, title: fe ? 'Feathers' : 'Weights' };
    },
    // front three-quarter and from below: the spread wings face the lens against the evening sky, the
    // horizon low in the frame (from the side a gliding wing is foreshortened into a raised blade).
    // rScale: the framing radius covers the wingspan (the body's bounding radius left the wings cut);
    // the lens widens as it banks
    cam: (S) => S.path({ actor: 'eagle', frame: 'heading', rScale: 1.25, keys: [
      { t: 0, az: -40, el: -11, fit: 1.0, fov: 32 },
      { t: 3.0, az: -50, el: -9, fit: 1.04, y: 0.05 },
      { t: 4.4, az: -58, el: -8, fit: 1.36, y: 0.22 },
      { t: 7.5, az: -72, el: -6, fit: 1.72, fov: 34, lead: -0.35, y: 0 },
    ] }),
  },
  {
    id: 'sheep', pfit: 1, dur: 2.5, pre: 1, cast: ['sheepA', 'sheepB', 'sheepD'], title: { actor: 'sheepA', at: 0.25 }, tod: TOD, live: { tier: 3, scale: 0.7 }, wide: 0.8, fill: 2.1,
    what: 'sheep graze in the low sun, the wool rim-lit; the lamb pronks',
    setup(S) {
      const x = 44, z = -20, h = lit(18, -48);
      const at = (side, back) => [x + Math.cos(h) * side - Math.sin(h) * back, z - Math.sin(h) * side - Math.cos(h) * back];
      S.place('sheepA', x, z, h); S.place('sheepB', ...at(1.7, 1.5), h + 0.4); S.place('sheepD', ...at(0.9, -1.0), h + 0.2);
      for (const k of ['sheepA', 'sheepB']) S.play(k, 'eat');
    },
    update(S) { S.at(0.15, () => S.play('sheepD', 'pronk')); S.at(1.35, () => S.play('sheepD', 'pronk')); },
    cam: (S) => S.orbit({ actor: 'sheepA', frame: 'heading', headingFrom: 'start', a: { az: 20, el: 6, d: 5.6, fov: 32, lead: -0.7 }, b: { az: 13, el: 5, d: 5.0, fov: 32, lead: -0.7 }, ease: 'inOut' }),
    focus: () => V(44, 0, -21), shadow: 5, grass: { scale: 0.6 },
  },
  // ============================================================ the lake and the small ones
  {
    id: 'fish-school', portrait: false, dur: 3.5, pre: 2, cast: ['trout', 'trout2', 'bluegill', 'bluegill2', 'goldfish', 'clownfish'], title: { actor: 'trout', at: 0.3 }, tod: 0.93, water: 1.5, exposure: 0.8, bed: 1.6, wide: 0.9,
    // (clearer water than the shark's: the sandy floor 3 m down stays bright under the school)
    look: { water: { sigma: [0.2, 0.05, 0.045], caustic: [1.2, 1.2, 0.1, 1] } },
    what: 'looking down through clear water, the sun behind the lens: a mixed school mills over the sandy lake floor, caustics playing on the sand; the trout bursts away',
    setup(S) {
      const keys = ['trout', 'trout2', 'bluegill', 'bluegill2', 'goldfish', 'clownfish'];
      const y = S.world.waterLevel - 0.22;
      keys.forEach((k, i) => { const a = (i / keys.length) * Math.PI * 2; S.place(k, FISH.x + Math.cos(a) * 0.28, FISH.z + Math.sin(a) * 0.28, a + Math.PI / 2, y); });
    },
    update(S) {
      const keys = ['trout2', 'bluegill', 'bluegill2', 'goldfish', 'clownfish'];
      school(S, S.t < 2 ? ['trout', ...keys] : keys, FISH.x, FISH.z, S.world.waterLevel - 0.22, S.t, { r: 0.3, spin: 0.4, speed: 0.2 });
      S.at(2, () => S.play('trout', 'burst'));
    },
    cam: (S) => {
      const u = sm(0, 1, S.t / 3.5), a = SUN + 0.5 - 0.3 * u, r = 0.78 - 0.16 * u, h = 0.82 - 0.14 * u;
      const wl = S.world.waterLevel;
      return S.fixed({ pos: [FISH.x + Math.sin(a) * r, wl + h, FISH.z + Math.cos(a) * r], look: [FISH.x, wl - 0.22, FISH.z], fov: 34 });
    },
    focus: (S) => V(FISH.x, S.world.waterLevel, FISH.z),
  },
  {
    id: 'shark', portrait: false, dur: 4, pre: 3, cast: ['shark'], title: { actor: 'shark', at: 0.3 }, tod: 0.93, water: 1.4, exposure: 0.86, bed: 1.4,
    what: 'the great white cruises just under the glittering surface, its shadow on the lake bed; a scan turns it into its meshed skin and back',
    // up the east half of the lake: the camera, on its west side, stays over deep water all the way
    setup(S) { S.place('shark', 17.4, 5.8, 0.1, S.world.waterLevel - 0.6); S.move('shark', S.gear('shark', 'cruise'), 0.1, 0.2); },
    update(S) { S.move('shark', S.gear('shark', 'cruise'), 0.1 + 0.25 * sm(0, 4, S.t), S.a('shark').position.y < S.world.waterLevel - 0.5 ? 0.3 : -0.1); },
    reveal(S) {
      const L = S.layers('shark'); if (!L) return;
      // a scanner band runs nose to tail: inside it the coat gives way to the meshed skin
      const u = sm(0.7, 3.1, S.t);
      if (u <= 0 || u >= 1) { L.set({ coat: { on: true } }); return; }
      const f = (side) => L.wipe('-z', u, { side, width: 0.32, band: 0.035, glow: 2.2, margin: 0.5 });
      L.clayMat.uniforms.uClay.value.setRGB(0.42, 0.44, 0.46);
      L.set({ clay: { clip: f(2) }, wire: { alpha: 0.5, clip: f(2) }, coat: { on: true, clip: f(-2) } });
    },
    cam: (S) => S.orbit({ actor: 'shark', frame: 'heading', a: { az: -70, el: 16, fit: 1.1, fov: 32 }, b: { az: -55, el: 12, fit: 0.98, fov: 32 }, ease: 'drift' }),
  },
  {
    id: 'cows', dur: 2.5, pre: 1, cast: ['cow'], title: { actor: 'cow', at: 0.25 }, tod: TOD, live: { tier: 1, scale: 0.75 },
    what: 'a holstein in the tall grass lifts its head and moos (three-quarter front light: the pattern reads)',
    setup(S) { S.place('cow', -52, -18, lit(36, -118)); },
    update(S) { S.at(0.15, () => S.play('cow', 'moo')); S.at(0, () => S.play('cow', 'swish')); },
    cam: (S) => S.orbit({ actor: 'cow', frame: 'heading', headingFrom: 'start', a: { az: 40, el: 4, fit: 1.62, fov: 30, head: 0.2 }, b: { az: 33, el: 3, fit: 1.42, fov: 30, head: 0.26 }, ease: 'out' }),
    shadow: 6, grass: { scale: 0.7 },
  },
  {
    id: 'frog', pfit: 1.6, plead: 1, dur: 3, pre: 1, cast: ['frog'], title: { actor: 'frog', at: 0.3 }, tod: TOD, water: 1, bed: 1,
    what: 'the bullfrog croaks on the wet sand at the water\'s edge (its vocal sac swells), then hops along the shore; the tripod pans with it',
    // on the north-east shore; the camera on the land side looks south-west, the water behind the frog
    setup(S) { S.place('frog', 21.0, 23.3, lit(62, -65)); S.play('frog', 'croak'); },
    // (a short hop: it lands inside the locked-off frame)
    update(S) { S.at(1.6, () => S.play('frog', 'hop', { distance: 0.18 })); },
    track: 0.8,
    cam: (S) => S.orbit({ actor: 'frog', frame: 'heading', pivot: 'start', lookAt: 'start', anchor: 'ground', anchorY: 0.6, a: { az: 62, el: 5, fit: 1.8, fov: 30, lead: 0.13 }, b: { az: 62, el: 5, fit: 1.72, fov: 30, lead: 0.13 }, ease: 'inOut' }),
    camClear: 0.035,
  },
  {
    id: 'rabbit-binky', dur: 3, pre: 1, cast: ['rabbit'], title: { actor: 'rabbit', at: 0.3 }, tod: TOD, whipOut: { dir: 1, d: 0.25 }, live: { tier: 2 },
    what: 'the rabbit: a binky in a steady frame, then it bounds away, tracked from the side',
    setup(S) { S.place('rabbit', 26.5, 21.5, lit(84, -100)); },
    update(S) { S.at(0.3, () => S.play('rabbit', 'binky')); S.at(1.6, () => S.move('rabbit', S.gear('rabbit', 'bound'), S.a('rabbit').heading)); },
    cam: (S) => S.orbit({ actor: 'rabbit', frame: 'heading', headingFrom: 'start', anchor: 'ground', anchorY: 0.7, a: { az: 84, el: 5, fit: 2.0, fov: 30 }, b: { az: 92, el: 4, fit: 2.2, fov: 30, lead: 0.2 }, ease: 'inOut' }),
    grass: { actor: 'rabbit', r: 1.4, k: 0.3 },
  },
  {
    id: 'rattlesnake', portrait: { horizon: 0.36 }, pfit: 1.2, dur: 3.5, pre: 2.5, cast: ['rattlesnake'], title: { actor: 'rattlesnake', at: 0.3 }, tod: TOD, whipIn: { dir: 1, d: 0.25 },
    what: 'the diamondback crawls at the lens, cocks its forebody into a low S-coil and strikes along the lens axis (slow motion on the lunge), rim-lit against the low sun',
    // the strike cocks for 0.62 s and lands ~0.18 s later: slow motion from the cocked S-coil through
    // the bite. (No alert coil first: its raised forebody read as a cobra.) Back light: the open mouth
    // stays in shade
    slow: (t) => 1 - 0.72 * sm5(1.15, 1.5, t) * (1 - sm5(2.05, 2.5, t)),
    setup(S) {
      const h = lit(32, -34);
      S.place('rattlesnake', 27.5, 0.0, h); S.move('rattlesnake', S.gear('rattlesnake', 'crawl'), h); S.run.state.h = h;
      // (this instance strikes with a smaller gape than the species' 115 deg: in slow motion the open
      // mouth read as a red slab; the strike itself is the species' own)
      const st = S.a('rattlesnake').motion?.cfg?.strike;
      if (st) st.gape = 70;
    },
    update(S) {
      S.at(0.1, () => S.move('rattlesnake', 0, S.run.state.h));
      // (at a point just to the lens side of straight ahead, low: a lunge, not a rear)
      S.at(0.75, () => S.play('rattlesnake', 'strike', { target: S.camPoint('rattlesnake', 12, 0.5, 0.05) }));
    },
    // front three-quarter, low: the lunge crosses the frame towards the lens and the open mouth is seen
    // from the side (head on it read as a red slab)
    cam: (S) => S.orbit({ actor: 'rattlesnake', frame: 'heading', headingFrom: 'start', a: { az: 34, el: 6, d: 0.9, fov: 30, head: 0.55 }, b: { az: 28, el: 4, d: 0.78, fov: 30, head: 0.62 }, ease: 'out' }),
    grass: { actor: 'rattlesnake', r: 1.2, k: 0.25, scale: 0.7 },
    camClear: 0.02,
  },
  {
    id: 'tarantula', portrait: false, dur: 3.5, pre: 1, cast: ['tarantula'], title: { actor: 'tarantula', at: 0.3 }, tod: TOD, bloom: 0.045, live: { tier: 1, scale: 0.75 },
    what: 'macro, the lake behind it: the tarantula walks towards the lens, its hairs rim-lit; a scan sweeps it into an x-ray of its eight legs and their IK targets, and back',
    camClear: 0.012,
    dim: (t) => 0.55 * sm(0.85, 1.45, t) * (1 - sm(2.45, 3.1, t)),
    // (its shadow fades with the coat: the x-ray is a ghost)
    shade: (t) => 1 - 0.85 * sm(0.95, 1.55, t) * (1 - sm(2.45, 3.05, t)),
    // on the north-east shore, walking up from the water (the lake behind it), in a three-quarter back
    // light that rims its hairs (the camera looks south-west over the lake: v = sun + rel)
    setup(S) { S.place('tarantula', 24.3, 21.4, lit(30, -45)); S.move('tarantula', S.gear('tarantula', 'walk'), lit(30, -45)); },
    reveal(S) {
      const L = S.layers('tarantula'); if (!L) return;
      // one clean front each way, nose to tail, 0.75 s (in 0.9 .. 1.65 s, out 2.35 .. 3.1 s), with a thin,
      // soft glow: a wide band lit whole patches of its pale hairs at once (cream blobs)
      const u1 = sm(0.9, 1.65, S.t), u2 = sm(2.35, 3.1, S.t);
      if (u1 <= 0 || u2 >= 1) { L.set({ coat: { on: true } }); return; }
      const sc = S.A('tarantula').info.scale || 1, M = 0.14 * sc;
      const ue = L.frontU('-z', L.eyeRest(), M);
      const o = (side) => ({ side, glow: 0.45, band: 0.005 * sc, margin: M });
      if (u2 <= 0) L.set({ xray: { alpha: 1, clip: u1 < 1 ? L.wipe('-z', u1, o(1)) : null }, skel: { alpha: u1 }, coat: { on: u1 < 1, clip: u1 < 1 ? L.wipe('-z', u1, o(-1)) : null, eyes: u1 < ue } });
      else L.set({ xray: { alpha: 1, clip: L.wipe('-z', u2, o(-1)) }, skel: { alpha: 1 - u2 }, coat: { on: true, clip: L.wipe('-z', u2, o(1)), eyes: u2 > ue } });
    },
    cam: (S) => S.orbit({ actor: 'tarantula', frame: 'heading', a: { az: 30, el: 12, fit: 1.3, fov: 30 }, b: { az: 18, el: 9, fit: 1.0, fov: 30 }, ease: 'inOut' }),
    fill: 2.4,
  },
  // ============================================================ finale: all 24 at the lake
  {
    id: 'finale', portrait: false, dur: 8, pre: 3, tod: 0.985, bloom: 0.05, look: { sky: FIN_SKY }, live: { tier: 3, scale: 0.65 }, wide: 0.66, fill: 2.1, skyWarm: 1, clouds: 0.2, camClear: 0.05,
    cast: FIN_CAST,
    what: 'the lake at sunset, all 24 species: the herd at the waterline, the hunters resting among them, the small ones at the lens; a shark fin cuts the glitter, a trout leaps, the lamb pronks, the eagle crosses the sky; the camera cranes up from among the small ones',
    setup: finaleSetup,
    update: finaleUpdate,
    cam: (S) => finaleCam(S, S.t),
    focus: () => V(31, 0, 13), shadow: 16, grass: { scale: 0.5 }, water: 0,
  },
  {
    id: 'end', portrait: false, dur: 5, keep: true, tod: 0.985, title: 'end', titleY: 0.31, look: { sky: FIN_SKY }, live: { tier: 3, scale: 0.5 }, wide: 0.66, fill: 2.1, skyWarm: 1, clouds: 0.2, camClear: 0.05,
    cast: FIN_CAST,
    what: 'the crane tilts up to the evening sky: THREE.JS PROCEDURAL ANIMALS and the repository line over the gathering at the lake, then black',
    // (a light dusk over the image while the card reads - the title sits in the sky - then black)
    fade: (t) => 0.3 * sm(0.3, 1.8, t) + 0.7 * sm(4.1, 4.9, t),
    // (the same crane as the finale, carried on: one move over both shots)
    cam: (S) => finaleCam(S, S.t + 8),
    focus: () => V(31, 0, 13), shadow: 16, grass: { scale: 0.5 }, water: 0,
  },
];
