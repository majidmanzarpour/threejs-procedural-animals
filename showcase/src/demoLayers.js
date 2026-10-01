// "How it's made" layers for the demo reel. The library is not changed: the showcase patches the
// animal's own coat materials (a wipe in rest space with a glowing front, and hair that grows out of
// the skin) and draws the other layers from the animal's own data:
//   prims    the SDF primitives riding on their bones (they assemble one by one, and melt away as a
//            wipe passes)
//   clay     the meshed skin, flat-shaded, skinned with the animal's own dual quaternions (optionally a
//            lower-resolution build of the same individual: the skeleton is the same for every tier)
//   wire     its wireframe
//   weights  skin weights: every vertex coloured by the bones it follows (bone colours by limb)
//   xray     a fresnel ghost of the body, for the skeleton inside
//   skel     bones, joints and the motion engine's IK targets (drawn on top, post.overlay)
//   coat     the animal itself: clipped by the wipe, hair length scaled by `grow`
// A wipe runs along a rest-space axis (bind pose, metres): every layer takes { axis, front, side }
// (side +1 keeps the part below the front along the axis, -1 the part above) and glows at the front.
import * as THREE from 'three';
import { DQS_GLSL, DQS_ATTR_GLSL } from '../../src/core/render/dqs.js';
import { UNDERWATER_GLSL } from './terrain.js';

// ------------------------------------------------------------------ colours per bone group
const GROUP_COL = {
  axial: 0xe3a23b, neck: 0xe8b04a, head: 0xf0c060, jaw: 0xe0683a, tail: 0xe07f3a,
  FL: 0x55c6e6, FR: 0x3f8fe0, HL: 0x86dc62, HR: 0x3fae68, earL: 0xe07fc0, earR: 0xc86fd8,
  // (the wings in the limbs' cool family: violet and pink wings over the amber body read as a parrot)
  wingL: 0x5fb4d0, wingR: 0x4a8fc4,
};
export function groupColor(g) {
  if (GROUP_COL[g] !== undefined) return new THREE.Color(GROUP_COL[g]);
  let h = 0;
  for (const c of String(g)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.62, 0.62);
}

// ------------------------------------------------------------------ coat patch
const CLIP_DECL = /* glsl */ `
uniform vec4 uRevealPlane;   // xyz: rest-space axis (unit), w: position of the front along it (m); radial: xyz centre, w radius
uniform vec4 uRevealParams;  // x: on, y: glow band (m), z: glow strength, w: +1 keeps the part below the front, -1 above, +-2 band, +-3 radial (+3 keeps the inside)
uniform vec3 uRevealColor;
uniform vec2 uGrow;          // x: hair growth 0..1, y: growth band behind the reveal front (m; 0 = everywhere at once)
uniform float uRevealWidth;  // band mode (side +-2): half-width of the band round the front (m)
// > 0 where this surface is clipped away. side +1: keeps below the front, -1 above, +2 inside a band, -2 outside it
float demoRevealS(vec3 rest) {
  float w = uRevealParams.w;
  if (abs(w) > 2.5) return (length(rest - uRevealPlane.xyz) - uRevealPlane.w) * sign(w);
  float d = dot(rest, uRevealPlane.xyz) - uRevealPlane.w;
  return abs(w) > 1.5 ? (abs(d) - uRevealWidth) * sign(w) : d * w;
}
float demoGrow(vec3 rest) {
  float g = uGrow.x;
  if (uRevealParams.x > 0.5 && uGrow.y > 0.0) g *= smoothstep(0.0, uGrow.y, -demoRevealS(rest));
  return g;
}
`;

// the lake's light for what swims in it (the same absorption as the lake bed: terrain.js); one set of
// uniforms for every animal, off (w 0) except in the reel's water shots
export const WATER_UNIFORMS = {
  uDemoWater: { value: new THREE.Vector4(0.45, 0.09, 0.07, 0) },
  uDemoWaterCol: { value: new THREE.Color(0.01, 0.03, 0.03) },
  uDemoSun: { value: new THREE.Vector3(0, 1, 0) },
  uDemoWL: { value: -1e4 },
};
const WATER_DECL = /* glsl */ `
uniform vec4 uDemoWater;
uniform vec3 uDemoWaterCol;
uniform vec3 uDemoSun;
uniform float uDemoWL;
${UNDERWATER_GLSL}
`;

export function makeRevealUniforms() {
  return {
    uRevealPlane: { value: new THREE.Vector4(0, 0, 1, 0) },
    uRevealParams: { value: new THREE.Vector4(0, 0.03, 0, 1) },
    uRevealColor: { value: new THREE.Color(1.0, 0.62, 0.22) },
    uGrow: { value: new THREE.Vector2(1, 0) },
    uRevealWidth: { value: 0.2 },
  };
}

// Every demo animal gets the same patched programs (shared, compiled once); with the uniforms at their
// defaults the coat renders exactly as before.
export function patchCoat(animal) {
  const R = animal.render;
  if (!R || R._demoPatched) return;
  R._demoPatched = true;
  const U = makeRevealUniforms();
  R.demo = { uniforms: U, ok: true, grow: false };
  const mats = [R.materials?.base, R.materials?.shells, R.materials?.fins, R.materials?.membrane].filter(Boolean);
  for (const m of mats) {
    if (!m.isShaderMaterial) continue;
    let vs = m.vertexShader, fs = m.fragmentShader;
    const mainF = fs.lastIndexOf('void main()');
    const outF = fs.lastIndexOf('gl_FragColor = vec4(col, alpha);');
    if (mainF < 0 || outF < 0 || !/\bvRest\b/.test(fs)) { R.demo.ok = false; continue; }
    const wet = /\bvWorldPos\b/.test(fs) ? 'if (uDemoWater.w > 0.0) col = demoUnderwater(col, vWorldPos, cameraPosition, uDemoSun, uDemoWater, uDemoWaterCol, uDemoWL, 1.0);\n  ' : '';
    fs = fs.slice(0, outF) + `if (uRevealParams.x > 0.5) { float rvS = demoRevealS(vRest); col += uRevealColor * exp(-abs(rvS) / max(uRevealParams.y, 1e-4)) * uRevealParams.z; }\n  ` + wet + fs.slice(outF);
    const open = fs.indexOf('{', mainF);
    fs = fs.slice(0, mainF) + CLIP_DECL + (wet ? WATER_DECL : '') + fs.slice(mainF, open + 1) + `\n  if (uRevealParams.x > 0.5 && demoRevealS(vRest) > 0.0) discard;` + fs.slice(open + 1);
    const mainV = vs.lastIndexOf('void main()');
    if (mainV >= 0) {
      vs = vs.slice(0, mainV) + CLIP_DECL + vs.slice(mainV);
      const a = 'float L = aCoat.z * uFurScale;', b = 'float L = iCoat.z * uFurScale;';
      if (vs.includes(a)) { vs = vs.replace(a, 'float L = aCoat.z * uFurScale * demoGrow(position);'); R.demo.grow = true; }
      else if (vs.includes(b)) { vs = vs.replace(b, 'float L = iCoat.z * uFurScale * demoGrow(iPos);'); R.demo.grow = true; }
    }
    m.vertexShader = vs;
    m.fragmentShader = fs;
    Object.assign(m.uniforms, U, WATER_UNIFORMS);
    m.needsUpdate = true;
  }
  // the coat's shadow casters (the base skin and the fin membranes share one depth material) clipped by
  // the same wipe
  const old = R.base?.customDepthMaterial;
  if (old && R.demo.ok && R.uniforms?.uDQ) {
    const depth = clipDepthMaterial({ uClip: U.uRevealPlane, uClipP: U.uRevealParams, uClipW: U.uRevealWidth }, { uDQ: R.uniforms.uDQ });
    animal.object.traverse((o) => { if (o.customDepthMaterial === old) o.customDepthMaterial = depth; });
    R.demo.depth = depth;
  }
}

// set a coat's wipe / growth; clip: { axis: [x,y,z], front, side, band, glow } or null
const _ax = new THREE.Vector3();
export function setCoatReveal(animal, clip, grow = 1, growBand = 0) {
  const U = animal.render?.demo?.uniforms;
  if (!U) return;
  if (clip) {
    if (clip.center) _ax.fromArray(clip.center); else _ax.fromArray(clip.axis).normalize();
    U.uRevealPlane.value.set(_ax.x, _ax.y, _ax.z, clip.front);
    U.uRevealParams.value.set(1, clip.band ?? 0.03, clip.glow ?? 1.5, clip.side ?? 1);
    U.uRevealWidth.value = clip.width ?? 0.2;
    if (clip.color) U.uRevealColor.value.set(clip.color);
  } else U.uRevealParams.value.x = 0;
  U.uGrow.value.set(grow, growBand);
  // (the shells' and fins' own hair length also fades their opacity: nothing to do when grow is 1)
}

// ------------------------------------------------------------------ shadows that follow the wipes
// A wipe clips a layer per fragment; its shadow has to be clipped the same way, or the whole layer keeps
// casting a shadow while it is wiped away and the shadow vanishes in one frame when the layer is
// hidden (or appears in one frame when a wiped-in layer is switched on). A depth material for the
// shadow pass with the same clip: rest space from the bind-pose position (skinned meshes, dual
// quaternions as the library's own shadow casters) or from a rest matrix (the SDF primitives).
// clipU: { uClip, uClipP, uClipW } (the layers' clip uniforms, or the coat's reveal uniforms)
function clipDepthMaterial(clipU, { uDQ = null, restMat = null } = {}) {
  const m = new THREE.MeshDepthMaterial(); // (three renders shadows into a depth texture: only depth and discard count)
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, clipU);
    if (uDQ) sh.uniforms.uDQ = uDQ;
    if (restMat) sh.uniforms.uRestMat = restMat;
    let vs = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRestD;\n' + (uDQ ? DQS_GLSL + DQS_ATTR_GLSL : '') + (restMat ? 'uniform mat4 uRestMat;\n' : ''));
    vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (restMat ? 'vRestD = (uRestMat * vec4(transformed, 1.0)).xyz;' : 'vRestD = position;') +
      (uDQ ? '\n  { vec3 dn = vec3(0.0, 1.0, 0.0), dt = vec3(1.0, 0.0, 0.0); dqsSkin(transformed, dn, dt); }' : ''));
    sh.vertexShader = vs;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uClip;\nuniform vec4 uClipP;\nuniform float uClipW;\nvarying vec3 vRestD;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (uClipP.x > 0.5) {
          float dd = dot(vRestD, uClip.xyz) - uClip.w;
          float s = abs(uClipP.w) > 2.5 ? (length(vRestD - uClip.xyz) - uClip.w) * sign(uClipP.w) : abs(uClipP.w) > 1.5 ? (abs(dd) - uClipW) * sign(uClipP.w) : dd * uClipP.w;
          if (s > 0.0) discard;
        }`);
  };
  m.customProgramCacheKey = () => `paDemoClipDepth${uDQ ? 'S' : ''}${restMat ? 'R' : ''}`;
  return m;
}

// ------------------------------------------------------------------ the skinned layer mesh
const MESH_VERT = /* glsl */ `
#include <common>
${DQS_GLSL}
${DQS_ATTR_GLSL}
attribute vec4 aCoat;
uniform vec2 uSeam;
uniform sampler2D uBoneCol;
varying vec3 vWorld;
varying vec3 vRest;
varying vec3 vN;
varying vec3 vCol;
varying float vFade;
void main() {
  vec3 p = position, n = normal, t = vec3(1.0, 0.0, 0.0);
  dqsSkin(p, n, t);
  n = normalize(n);
  float seamT = clamp((0.5 - aCoat.w) / max(0.5 - uSeam.y, 1e-3), 0.0, 1.0);
  p -= n * (uSeam.x * seamT * seamT);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vRest = position;
  vN = normalize(mat3(modelMatrix) * n);
  vFade = aCoat.w;
  ivec4 bi = ivec4(skinIndex + 0.5);
  vCol = texelFetch(uBoneCol, ivec2(bi.x, 0), 0).rgb * skinWeight.x + texelFetch(uBoneCol, ivec2(bi.y, 0), 0).rgb * skinWeight.y
       + texelFetch(uBoneCol, ivec2(bi.z, 0), 0).rgb * skinWeight.z + texelFetch(uBoneCol, ivec2(bi.w, 0), 0).rgb * skinWeight.w;
  vCol /= max(skinWeight.x + skinWeight.y + skinWeight.z + skinWeight.w, 1e-4);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const MESH_FRAG = /* glsl */ `
#include <common>
uniform float uMode;      // 0 clay, 1 weights, 2 xray, 3 wire
uniform vec2 uSeam;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uClay;
uniform vec3 uWire;
uniform vec3 uRim;
uniform float uOpacity;
uniform vec4 uClip;       // xyz axis, w front
uniform vec4 uClipP;      // x on, y band, z glow, w side (+-1 half space, +-2 band)
uniform float uClipW;     // band half-width (m)
uniform vec3 uGlow;
varying vec3 vWorld;
varying vec3 vRest;
varying vec3 vN;
varying vec3 vCol;
varying float vFade;
void main() {
  if (vFade < uSeam.y) discard;
  float dd = dot(vRest, uClip.xyz) - uClip.w;
  float s = abs(uClipP.w) > 2.5 ? (length(vRest - uClip.xyz) - uClip.w) * sign(uClipP.w) : abs(uClipP.w) > 1.5 ? (abs(dd) - uClipW) * sign(uClipP.w) : dd * uClipP.w;
  if (uClipP.x > 0.5 && s > 0.0) discard;
  float glow = uClipP.x > 0.5 ? exp(-abs(s) / max(uClipP.y, 1e-4)) * uClipP.z : 0.0;
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 col;
  float a = uOpacity;
  if (uMode > 2.5) {
    col = uWire;
  } else if (uMode > 1.5) {
    vec3 n = normalize(vN);
    float f = pow(1.0 - abs(dot(n, V)), 2.2);
    col = uWire * (0.08 + 1.1 * f);
    a *= 0.1 + 0.9 * f;
  } else {
    vec3 fn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (dot(fn, V) < 0.0) fn = -fn;
    vec3 base = uMode > 0.5 ? vCol : uClay;
    float ndl = max(dot(fn, uSunDir), 0.0);
    float hemi = 0.5 + 0.5 * fn.y;
    float rim = pow(1.0 - max(dot(fn, V), 0.0), 3.0);
    col = base * (uSunCol * ndl + mix(uGround, uSky, hemi)) + rim * uRim * (uMode > 0.5 ? base : vec3(1.0));
  }
  col += uGlow * glow;
  gl_FragColor = vec4(col, a);
}
`;

// ------------------------------------------------------------------ helpers
function frameMatrix(o, t) {
  const Y = new THREE.Vector3(t[0] - o[0], t[1] - o[1], t[2] - o[2]).normalize();
  const X = new THREE.Vector3(1, 0, 0);
  X.addScaledVector(Y, -X.dot(Y));
  if (X.lengthSq() < 1e-10) X.set(0, 0, 1).addScaledVector(Y, -Y.z);
  X.normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);
  return new THREE.Matrix4().set(X.x, Y.x, Z.x, o[0], X.y, Y.y, Z.y, o[1], X.z, Y.z, Z.z, o[2], 0, 0, 0, 1);
}
function roundCone(ra, rb, L, radial = 20) {
  const pts = [];
  const n = 8;
  for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / n) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.cos(a) * ra, Math.sin(a) * ra)); }
  for (let i = 0; i <= n; i++) { const a = (i / n) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.cos(a) * rb, L + Math.sin(a) * rb)); }
  return new THREE.LatheGeometry(pts, radial);
}
function finGeometry(P) {
  const n = P[14] | 0;
  const shape = new THREE.Shape();
  for (let i = 0; i < n; i++) { const u = P[15 + i * 2], v = P[16 + i * 2]; if (i === 0) shape.moveTo(u, v); else shape.lineTo(u, v); }
  const t = Math.max(1e-4, P[12] * 2);
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
  g.translate(0, 0, -t / 2);
  return g;
}
const frac = (x) => x - Math.floor(x);
const easeOutBack = (u) => { const c1 = 1.70158, c3 = c1 + 1; u = Math.min(1, Math.max(0, u)); return 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ Layers
export class Layers {
  // opts: { mesh: data for clay / wire / weights (default: the animal's own), overlay: THREE.Scene }
  constructor(scene, animal, info, opts = {}) {
    this.scene = scene; this.animal = animal; this.info = info; this.opts = opts;
    this.overlay = opts.overlay || scene;
    this.group = new THREE.Group();
    this.group.name = 'demoLayers';
    this.group.visible = false;
    scene.add(this.group);
    this.overGroup = new THREE.Group();
    this.overGroup.visible = false;
    this.overlay.add(this.overGroup);
    this.disposables = [];
    const data = animal.data;
    this.sk = animal.render.skeleton;
    this.boneLen = info.boneLen;
    this.buildBoneColors(data);
    this.buildPrims(data);
    this.buildMesh(opts.mesh || data);
    this.buildSkeleton(data);
    this.span = this.restSpan(data);
    this.state = {};
  }

  track(x) { this.disposables.push(x); return x; }

  buildBoneColors(data) {
    const n = data.bones.length;
    const arr = new Float32Array(Math.max(1, n) * 4);
    // within a group, successive bones step in lightness so blends between neighbours read as gradients
    const seen = {};
    data.bones.forEach((b, i) => {
      const k = (seen[b.group] = (seen[b.group] ?? -1) + 1);
      const c = groupColor(b.group);
      const hsl = {}; c.getHSL(hsl);
      c.setHSL((hsl.h + 0.035 * ((k % 5) - 2) + 1) % 1, Math.min(1, hsl.s * 1.05), Math.min(0.78, Math.max(0.36, hsl.l + 0.09 * ((k % 3) - 1))));
      arr.set([c.r, c.g, c.b, 1], i * 4);
    });
    this.boneColTex = this.track(new THREE.DataTexture(arr, Math.max(1, n), 1, THREE.RGBAFormat, THREE.FloatType));
    this.boneColTex.needsUpdate = true;
    this.boneCols = arr;
  }

  // rest-space extents (the wipe runs between them)
  restSpan(data) {
    const P = data.pos;
    const out = {};
    const axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    for (const [k, a] of Object.entries(axes)) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < P.length; i += 3) { const d = P[i] * a[0] + P[i + 1] * a[1] + P[i + 2] * a[2]; if (d < lo) lo = d; if (d > hi) hi = d; }
      out[k] = [lo, hi];
    }
    return out;
  }
  /** front position for a wipe along axis 'x' | 'y' | 'z' (or '-z' ...) at progress u (0 before .. 1 past) */
  front(axisName, u, band = 0.05) {
    const neg = axisName.startsWith('-');
    const [lo, hi] = this.span[axisName.replace('-', '')];
    const a = neg ? -hi : lo, b = neg ? -lo : hi;
    return { axis: axisVec(axisName), front: a - band + (b - a + 2 * band) * u };
  }
  /** a radial wipe: a sphere round `center` (rest space; default: the body's centroid) growing from 0 to
   *  past the farthest vertex at progress u; side +1 keeps the inside (a coat growing outwards), -1 the
   *  outside. Ready for a layer's `clip`, like wipe(). */
  radial(u, { center, band, side = 1, glow = 2.5, margin } = {}) {
    const S = this.info.scale || 1;
    const c = center || this.restCentroid();
    const P = this.animal.data.pos;
    if (!this._rmax || this._rmaxC !== c) {
      let r = 0;
      for (let i = 0; i < P.length; i += 3) r = Math.max(r, Math.hypot(P[i] - c[0], P[i + 1] - c[1], P[i + 2] - c[2]));
      this._rmax = r; this._rmaxC = c;
    }
    const b = band ?? 0.035 * S, m = margin ?? b * 4;
    const k = smooth(0, 0.15, u) * (1 - smooth(0.85, 1, u));
    return { center: c, front: -m + (this._rmax + 2 * m) * u, side: 3 * Math.sign(side), band: b, glow: glow * k };
  }
  /** the progress u at which the radial front (as radial(), default centre and margin) reaches point p */
  radialU(p, { center, band, margin } = {}) {
    const S = this.info.scale || 1;
    const c = center || this.restCentroid();
    this.radial(0, { center: c });
    const b = band ?? 0.035 * S, m = margin ?? b * 4;
    return (Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) + m) / (this._rmax + 2 * m);
  }
  restCentroid() {
    if (this._centroid) return this._centroid;
    const P = this.animal.data.pos;
    let x = 0, y = 0, z = 0;
    const n = P.length / 3;
    for (let i = 0; i < P.length; i += 3) { x += P[i]; y += P[i + 1]; z += P[i + 2]; }
    return (this._centroid = [0, y / n, z / n]); // (x: the midline)
  }
  /** the progress u at which a wipe's front (axis, margin: as wipe()) reaches the rest-space point p */
  frontU(axisName, p, margin = 0.035 * (this.info.scale || 1) * 4) {
    const neg = axisName.startsWith('-'), k = { x: 0, y: 1, z: 2 }[axisName.replace('-', '')];
    const [lo, hi] = this.span[axisName.replace('-', '')];
    const a = neg ? -hi : lo, b = neg ? -lo : hi;
    return ((neg ? -p[k] : p[k]) - (a - margin)) / (b - a + 2 * margin);
  }
  /** the rest-space centre of the first eye (or the head's end) */
  eyeRest() {
    const e = this.animal.data.eyes?.[0];
    if (e?.c) return e.c;
    const d = this.animal.data, hb = d.bones.find((b) => /^head$/i.test(b.name));
    return hb ? d.joints[hb.tailJ] : [0, 0, 0];
  }
  /** a wipe at progress u (0 before the body .. 1 past it), ready for a layer's `clip`: the front starts
   *  and ends clear of the body and its glow fades in and out at the ends, so nothing snaps on or off
   *  when a stage starts or the clip is dropped. Sizes scale with the animal (a spider is 5 cm). */
  wipe(axisName, u, { band, side = 1, glow = 2.5, width, margin } = {}) {
    const S = this.info.scale || 1;
    const b = band ?? 0.035 * S;
    const f = this.front(axisName, u, margin ?? b * 4);
    const k = smooth(0, 0.15, u) * (1 - smooth(0.85, 1, u));
    return { ...f, side, band: b, glow: glow * k, width: width ?? 0.2 * S };
  }

  // ---------------------------------------------------------------- SDF primitives
  buildPrims(data) {
    const bones = data.bones;
    const byName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
    const ref = data.refJoints || data.joints;
    const refBindInv = bones.map((b) => (ref[b.headJ] && ref[b.tailJ] ? frameMatrix(ref[b.headJ], ref[b.tailJ]).invert() : new THREE.Matrix4()));
    const ratio = bones.map((b, i) => {
      const h = ref[b.headJ], t = ref[b.tailJ];
      const L = h && t ? Math.hypot(t[0] - h[0], t[1] - h[1], t[2] - h[2]) : 0;
      return L > 1e-5 ? this.boneLen[i] / L : data.params?.size || 1;
    });
    const sphere = this.track(new THREE.SphereGeometry(1, 28, 18));
    const mats = {};
    this.primGroup = new THREE.Group();
    this.prims = [];
    const bind = this.sk.bind;
    const tmp = new THREE.Vector3();
    // a wipe clips the primitives in their rest space, per fragment (a primitive the front crosses is
    // cut, never dropped whole), with the same glowing front as the skin layers; every primitive's
    // material shares one program (its rest matrix is its own uniform)
    const clipU = this.primClip = { uClip: { value: new THREE.Vector4(0, 0, 1, 0) }, uClipP: { value: new THREE.Vector4(0, 0.03, 0, 1) }, uClipW: { value: 0.2 }, uGlow: { value: new THREE.Color(1.0, 0.62, 0.22) } };
    const patchPrim = (mat, restMat) => {
      const rest = { value: restMat };
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, clipU);
        sh.uniforms.uRestMat = rest;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform mat4 uRestMat;\nvarying vec3 vRestP;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRestP = (uRestMat * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec4 uClip;\nuniform vec4 uClipP;\nuniform float uClipW;\nuniform vec3 uGlow;\nvarying vec3 vRestP;')
          .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
            float rvD = dot(vRestP, uClip.xyz) - uClip.w;
            float rvS = abs(uClipP.w) > 2.5 ? (length(vRestP - uClip.xyz) - uClip.w) * sign(uClipP.w) : abs(uClipP.w) > 1.5 ? (abs(rvD) - uClipW) * sign(uClipP.w) : rvD * uClipP.w;
            if (uClipP.x > 0.5 && rvS > 0.0) discard;`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            if (uClipP.x > 0.5) totalEmissiveRadiance += uGlow * exp(-abs(rvS) / max(uClipP.y, 1e-4)) * uClipP.z;`);
      };
      mat.customProgramCacheKey = () => 'paDemoPrimClip';
    };
    for (const p of data.prims || []) {
      if (p.carve || p.type === 2) continue;
      const bi = byName[p.bone];
      if (bi === undefined) continue;
      const g = p.group || 'axial';
      // every primitive its own tint of the group colour, so the shapes read one by one
      const hsl = {}; const gc = groupColor(g); gc.getHSL(hsl);
      const r1 = frac(Math.sin((p.id ?? this.prims.length) * 12.9898) * 43758.5453), r2 = frac(Math.sin((p.id ?? this.prims.length) * 78.233) * 12543.1234);
      const col = new THREE.Color().setHSL((hsl.h + (r1 - 0.5) * 0.07 + 1) % 1, Math.min(1, hsl.s * (0.85 + 0.3 * r2)), Math.min(0.8, Math.max(0.3, hsl.l + (r2 - 0.5) * 0.22)));
      const mat = this.track(new THREE.MeshStandardMaterial({ color: col, roughness: 0.28, metalness: 0.0, emissive: col.clone(), emissiveIntensity: 0.25, transparent: false, opacity: 1 }));
      mats[this.prims.length] = mat;
      const P = p.P;
      let geo, center = new THREE.Vector3();
      const m = new THREE.Matrix4();
      if (p.type === 0) {
        geo = sphere;
        m.makeBasis(new THREE.Vector3(P[3], P[4], P[5]), new THREE.Vector3(P[6], P[7], P[8]), new THREE.Vector3(P[9], P[10], P[11]));
        m.scale(new THREE.Vector3(P[12], P[13], P[14]));
        m.setPosition(P[0], P[1], P[2]);
      } else if (p.type === 1) {
        const ba = new THREE.Vector3(P[3], P[4], P[5]);
        const L = ba.length();
        geo = this.track(roundCone(P[10], P[11], L));
        m.makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), ba.clone().normalize()));
        m.setPosition(P[0], P[1], P[2]);
        center.set(0, L / 2, 0);
      } else if (p.type === 3) {
        geo = this.track(finGeometry(P));
        m.makeBasis(new THREE.Vector3(P[3], P[4], P[5]), new THREE.Vector3(P[6], P[7], P[8]), new THREE.Vector3(P[9], P[10], P[11]));
        m.setPosition(P[0], P[1], P[2]);
        geo.computeBoundingBox(); geo.boundingBox.getCenter(center);
      } else continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      const local = new THREE.Matrix4().makeScale(ratio[bi], ratio[bi], ratio[bi]).multiply(refBindInv[bi]).multiply(m);
      // the prim's centre in the final rest space (bind pose): its place in the assembly order
      const rest = tmp.copy(center).applyMatrix4(local).applyMatrix4(bind[bi]).clone();
      const restM = new THREE.Matrix4().multiplyMatrices(bind[bi], local);
      patchPrim(mat, restM);
      mesh.customDepthMaterial = this.track(clipDepthMaterial(clipU, { restMat: { value: restM } }));
      this.prims.push({ mesh, local, bi, center: center.clone(), rest, order: 0, s: 1 });
      this.primGroup.add(mesh);
    }
    // assembly order: from the chest outwards (distance to the body centre), with a little jitter
    const c = new THREE.Vector3();
    for (const q of this.prims) c.add(q.rest);
    c.multiplyScalar(1 / Math.max(1, this.prims.length));
    const R = Math.max(1e-6, ...this.prims.map((q) => q.rest.distanceTo(c)));
    let h = 7;
    for (const q of this.prims) { h = (h * 16807) % 2147483647; q.order = Math.min(1, 0.85 * (q.rest.distanceTo(c) / R) + 0.15 * (h / 2147483647)); }
    this.primMats = Object.values(mats);
    this.group.add(this.primGroup);
    this._m = new THREE.Matrix4(); this._s = new THREE.Matrix4(); this._t = new THREE.Matrix4();
  }

  // ---------------------------------------------------------------- clay / wire / weights / xray mesh
  buildMesh(d) {
    const own = d === this.animal.data;
    const A = own ? this.animal.render.geometry.attributes : null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', own ? A.position : new THREE.BufferAttribute(d.pos, 3));
    g.setAttribute('normal', own ? A.normal : new THREE.BufferAttribute(d.nrm, 3));
    g.setAttribute('skinIndex', own ? A.skinIndex : new THREE.Uint16BufferAttribute(d.skinIndex, 4));
    g.setAttribute('skinWeight', own ? A.skinWeight : new THREE.BufferAttribute(d.skinWeight, 4));
    g.setAttribute('aCoat', own ? A.aCoat : new THREE.BufferAttribute(d.coat, 4));
    g.setIndex(own ? this.animal.render.geometry.index : new THREE.BufferAttribute(d.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.track(g);
    this.meshData = d;
    const U = this.animal.render.uniforms;
    const common = () => ({
      uDQ: U.uDQ, uSeam: { value: Number.isFinite(d.seamSink) ? new THREE.Vector2(d.seamSink, 0.1) : new THREE.Vector2(0, 0.5) },
      uBoneCol: { value: this.boneColTex },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 0.9, 0.8) },
      uSky: { value: new THREE.Color(0.35, 0.4, 0.5) }, uGround: { value: new THREE.Color(0.22, 0.17, 0.12) },
      uClay: { value: new THREE.Color(0.72, 0.69, 0.64) }, uWire: { value: new THREE.Color(0.14, 0.09, 0.05) }, uRim: { value: new THREE.Color(0.9, 0.62, 0.3) },
      uOpacity: { value: 1 }, uMode: { value: 0 },
      uClip: { value: new THREE.Vector4(0, 0, 1, 0) }, uClipP: { value: new THREE.Vector4(0, 0.03, 0, 1) }, uClipW: { value: 0.2 }, uGlow: { value: new THREE.Color(1.0, 0.62, 0.22) },
    });
    const mk = (mode, extra) => this.track(new THREE.ShaderMaterial({ vertexShader: MESH_VERT, fragmentShader: MESH_FRAG, uniforms: { ...common(), uMode: { value: mode } }, ...extra }));
    this.clayMat = mk(0, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.weightsMat = mk(1, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.xrayMat = mk(2, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.wireMat = mk(3, { wireframe: true, transparent: true, depthWrite: false });
    const mesh = (mat, order) => { const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = order; m.visible = false; this.group.add(m); return m; };
    this.clay = mesh(this.clayMat, 0);
    this.clay.castShadow = true;
    const clipOf = (mat) => ({ uClip: mat.uniforms.uClip, uClipP: mat.uniforms.uClipP, uClipW: mat.uniforms.uClipW });
    this.clay.customDepthMaterial = this.track(clipDepthMaterial(clipOf(this.clayMat), { uDQ: U.uDQ }));
    this.weights = mesh(this.weightsMat, 0);
    this.weights.castShadow = true;
    this.weights.customDepthMaterial = this.track(clipDepthMaterial(clipOf(this.weightsMat), { uDQ: U.uDQ }));
    this.xray = mesh(this.xrayMat, 20);
    this.wire = mesh(this.wireMat, 21);
    this.meshMats = [this.clayMat, this.weightsMat, this.xrayMat, this.wireMat];
  }

  // ---------------------------------------------------------------- skeleton overlay
  buildSkeleton(data) {
    const n = data.bones.length;
    const s = this.info.scale;
    // an octahedral bone: head at 0, tail at y = 1, widest at y = 0.15
    const bg = this.track(new THREE.BufferGeometry());
    const w = 0.5;
    const v = [[0, 0, 0], [w, 0.15, 0], [0, 0.15, w], [-w, 0.15, 0], [0, 0.15, -w], [0, 1, 0]];
    const f = [[0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 1, 4], [5, 1, 2], [5, 2, 3], [5, 3, 4], [5, 4, 1]];
    const pos = [];
    for (const t of f) for (const k of t) pos.push(...v[k]);
    bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    bg.computeVertexNormals();
    this.boneMat = this.track(new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1, emissive: 0xffffff, emissiveIntensity: 0.25, flatShading: true, transparent: true, opacity: 1 }));
    this.bones = new THREE.InstancedMesh(bg, this.boneMat, n);
    this.bones.frustumCulled = false;
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) { c.setRGB(this.boneCols[i * 4], this.boneCols[i * 4 + 1], this.boneCols[i * 4 + 2]); this.bones.setColorAt(i, c); }
    this.jointMat = this.track(new THREE.MeshStandardMaterial({ color: 0xfff4e0, roughness: 0.3, emissive: 0xfff4e0, emissiveIntensity: 0.35, transparent: true, opacity: 1 }));
    this.joints = new THREE.InstancedMesh(this.track(new THREE.SphereGeometry(1, 14, 10)), this.jointMat, n);
    this.joints.frustumCulled = false;
    this.targetMat = this.track(new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 1 }));
    this.targets = new THREE.InstancedMesh(this.track(new THREE.TorusGeometry(1, 0.22, 10, 28).rotateX(Math.PI / 2)), this.targetMat, 32);
    this.targets.frustumCulled = false;
    this.targets.count = 0;
    this.overGroup.add(this.bones, this.joints, this.targets);
    this.jointR = 0.014 * s;
    this.targetR = 0.028 * s;
    this.skelMats = [this.boneMat, this.jointMat, this.targetMat];
  }

  // ---------------------------------------------------------------- state
  // st: { prims: { build 0..1, clip, alpha }, clay: { clip, alpha }, wire: { clip, alpha }, weights: { clip },
  //       xray: { alpha }, skel: { alpha }, coat: { on, clip, grow, growBand }, light: { sunDir, sunCol, sky, ground } }
  set(st) {
    this.state = st;
    this.group.visible = true;
    this.overGroup.visible = !!st.skel && (st.skel.alpha ?? 1) > 0.001;
    // mesh layers
    const use = (mesh, mat, L) => {
      mesh.visible = !!L && (L.alpha ?? 1) > 0.001;
      if (!mesh.visible) return;
      const U = mat.uniforms;
      U.uOpacity.value = L.alpha ?? 1;
      mat.transparent = mat === this.xrayMat || mat === this.wireMat || (L.alpha ?? 1) < 0.999;
      setClip(U, L.clip);
    };
    use(this.clay, this.clayMat, st.clay);
    use(this.weights, this.weightsMat, st.weights);
    use(this.xray, this.xrayMat, st.xray);
    use(this.wire, this.wireMat, st.wire);
    // prims
    const P = st.prims;
    this.primGroup.visible = !!P && (P.alpha ?? 1) > 0.001;
    if (P) for (const m of this.primMats) { m.opacity = P.alpha ?? 1; m.transparent = (P.alpha ?? 1) < 0.999; m.depthWrite = true; }
    setClip(this.primClip, P?.clip || null);
    // skeleton
    if (st.skel) for (const m of this.skelMats) m.opacity = st.skel.alpha ?? 1;
    // coat
    const C = st.coat;
    // (a coat whose shaders could not be patched cannot be wiped: it stays hidden until it is whole)
    const on = (!C || C.on !== false) && (this.animal.render.demo?.ok !== false || !C?.clip);
    this.animal.object.visible = on;
    if (C) setCoatReveal(this.animal, C.clip || null, C.grow ?? 1, C.growBand ?? 0);
    else setCoatReveal(this.animal, null, 1, 0);
    if (C && C.eyes !== undefined) for (const e of this.animal.render.eyes || []) e.visible = !!C.eyes && on;
    else for (const e of this.animal.render.eyes || []) e.visible = on && (this.animal.render.quality?.shells ?? 1) > 0;
  }

  // light the layer materials like the scene (they are not lit by three's lights: consistent across stages)
  light(env, dim = 0, sunBase = env.sun.intensity) {
    for (const m of this.meshMats) {
      const U = m.uniforms;
      U.uSunDir.value.copy(env.sunDir);
      U.uSunCol.value.copy(env.sunColor).multiplyScalar(sunBase * 0.75);
      U.uSky.value.copy(env.skyAmb).multiplyScalar(1.3);
      U.uGround.value.copy(env.groundAmb).multiplyScalar(1.1);
    }
    for (const m of this.primMats) m.emissiveIntensity = 0.22 + 0.55 * dim;
  }

  hide() {
    this.group.visible = false;
    this.overGroup.visible = false;
    for (const m of [this.clay, this.weights, this.xray, this.wire]) m.visible = false;
    setCoatReveal(this.animal, null, 1, 0);
    for (const e of this.animal.render.eyes || []) e.visible = (this.animal.render.quality?.shells ?? 1) > 0;
    this.state = {};
  }

  warm(on) {
    // every layer at once (programs compiled, buffers uploaded)
    if (on) {
      this.set({ prims: { build: 1 }, clay: {}, weights: {}, xray: { alpha: 0.5 }, wire: { alpha: 0.5 }, skel: { alpha: 1 }, coat: { on: true, clip: { axis: [0, 0, 1], front: 0, side: 1 }, grow: 0.5, growBand: 0.05 } });
      this.update(0);
    } else this.hide();
  }

  update() {
    if (!this.group.visible && !this.overGroup.visible) return;
    const sk = this.sk;
    const st = this.state;
    // prims ride on their bones; they grow in (assembly); a wipe cuts them per fragment (primClip)
    if (this.primGroup.visible && st.prims) {
      const build = st.prims.build ?? 1;
      for (const q of this.prims) {
        const s = easeOutBack((build - q.order * 0.8) / 0.2);
        q.mesh.visible = s > 0.002;
        if (!q.mesh.visible) continue;
        const M = q.mesh.matrix.multiplyMatrices(sk.bones[q.bi].matrixWorld, q.local);
        if (s < 0.999) {
          this._t.makeTranslation(q.center.x, q.center.y, q.center.z);
          this._s.makeScale(s, s, s);
          M.multiply(this._t).multiply(this._s).multiply(this._t.makeTranslation(-q.center.x, -q.center.y, -q.center.z));
        }
        q.mesh.matrixWorld.copy(M);
      }
    }
    // skeleton
    if (this.overGroup.visible) {
      const m4 = this._m, o = new THREE.Vector3(), sc = new THREE.Vector3(), q = new THREE.Quaternion();
      const S = this.info.scale;
      sk.bones.forEach((bone, i) => {
        const L = Math.max(1e-4, this.boneLen[i]);
        const w = Math.min(L * 0.16, 0.05 * S);
        bone.matrixWorld.decompose(o, q, sc);
        m4.compose(o, q, sc.set(w / 0.5 * 0.5, L, w / 0.5 * 0.5));
        this.bones.setMatrixAt(i, m4);
        this.joints.setMatrixAt(i, m4.compose(o, q, sc.setScalar(this.jointR)));
      });
      this.bones.instanceMatrix.needsUpdate = true;
      this.joints.instanceMatrix.needsUpdate = true;
      const tg = this.animal.motion?.debug?.targets || [];
      const n = Math.min(32, tg.length);
      const id = new THREE.Quaternion();
      let k = 0;
      for (let i = 0; i < n; i++) {
        const p = tg[i];
        if (!p || !Number.isFinite(p.x)) continue;
        this.targets.setMatrixAt(k++, m4.compose(o.set(p.x, p.y + 0.002 * S, p.z), id, sc.setScalar(this.targetR)));
      }
      this.targets.count = k;
      this.targets.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.overGroup.removeFromParent();
    this.bones.dispose(); this.joints.dispose(); this.targets.dispose();
    for (const d of this.disposables) d.dispose?.();
  }
}

function axisVec(name) {
  const neg = name.startsWith('-');
  const k = name.replace('-', '');
  const v = k === 'x' ? [1, 0, 0] : k === 'y' ? [0, 1, 0] : [0, 0, 1];
  return neg ? v.map((x) => -x) : v;
}

function setClip(U, clip) {
  if (!clip) { U.uClipP.value.x = 0; return; }
  if (clip.center) _ax.fromArray(clip.center); else _ax.fromArray(clip.axis).normalize();
  U.uClip.value.set(_ax.x, _ax.y, _ax.z, clip.front);
  U.uClipP.value.set(1, clip.band ?? 0.03, clip.glow ?? 1.5, clip.side ?? 1);
  U.uClipW.value = clip.width ?? 0.2;
}
