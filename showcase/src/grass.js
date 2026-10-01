// Instanced grass blades in a wrapping tile that follows the focus point. Two tiles make the LOD:
// a dense near tile with thin blades and a sparse far ring with wider ones. Placement, clumping,
// colour, wind and push-back from animals all come from gl_InstanceID (no per-instance buffers).
// No grass grows under the lake or on the beach.
import * as THREE from 'three';
import { TERRAIN_GLSL, terrainHeight } from './noise.js';

export const MAX_PUSH = 10;

class GrassTile {
  constructor({ count, tile, inner = 0, widthMul = 1, segs = 5 }) {
    const pos = [], uv = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pos.push(-0.5, t, 0, 0.5, t, 0);
      uv.push(0, t, 1, t);
    }
    const idx = [];
    for (let i = 0; i < segs; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    g.setIndex(idx);
    g.instanceCount = count;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geometry = g;
    this.maxCount = count;
    this.uniforms = {
      uFocus: { value: new THREE.Vector2() },
      uTile: { value: tile },
      uInner: { value: inner },
      uWidthMul: { value: widthMul },
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(1.0, 0.35) },
      uPush: { value: Array.from({ length: MAX_PUSH }, () => new THREE.Vector4(0, -1000, 0, 1e-4)) },
      uCount: { value: count },
      uCam: { value: new THREE.Vector3() },
      uCamLift: { value: 0 },
      // a mown clearing (x, z, radius, height factor inside) and a global height factor (demo reel)
      uMow: { value: new THREE.Vector4(0, 0, 0, 1) },
      uGrassScale: { value: 1 },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.6 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
uniform vec2 uFocus; uniform float uTile; uniform float uInner; uniform float uWidthMul; uniform float uTime; uniform vec2 uWind;
uniform vec4 uPush[${MAX_PUSH}]; uniform float uCount; uniform vec3 uCam; uniform float uCamLift; uniform vec4 uMow; uniform float uGrassScale;
varying vec3 vGrassCol; varying float vGrassT;
${TERRAIN_GLSL}
float gh(float n) { uint h = uint(int(n * 1000.0)) * 0x9E3779B1u; h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u; return float(h) * (1.0 / 4294967296.0); }
`)
        .replace('#include <beginnormal_vertex>', `
  float id = float(gl_InstanceID);
  float side = ceil(sqrt(uCount));
  vec2 cell = vec2(mod(id, side), floor(id / side));
  vec2 jit = vec2(gh(id * 1.31), gh(id * 2.77 + 4.1));
  vec2 local = (cell + jit) / side * uTile;
  vec2 origin = uFocus - uTile * 0.5;
  vec2 wxz = origin + mod(local - origin, uTile);
  float dist = length(wxz - uFocus);
  float clump = vnoise2(wxz * 0.9 + 3.0);
  float patchN = vnoise2(wxz * 0.12 + 17.0);
  float bare = smoothstep(0.55, 0.8, vnoise2(wxz * 0.09 + 11.0) * 0.7 + vnoise2(wxz * 0.23 + 3.1) * 0.3);
  float h0 = terrainHeight(wxz, 1.0);
  float lakeNear = 1.0 - smoothstep(LAKE.z * 1.1, LAKE.z * 2.2, length(wxz - LAKE.xy));
  float hgt = mix(0.12, 0.62, pow(clump, 1.3)) * mix(0.55, 1.35, patchN) * (1.0 - 0.75 * bare);
  hgt *= 0.75 + 0.5 * gh(id * 5.3);
  hgt *= 1.0 - smoothstep(uTile * 0.3, uTile * 0.48, dist);
  hgt *= smoothstep(uInner * 0.85, uInner * 1.1, dist);
  hgt *= smoothstep(0.35, 0.7, mix(10.0, h0 - WATER_LEVEL, lakeMask(wxz)));
  hgt *= uGrassScale;
  if (uMow.z > 0.0) hgt *= mix(uMow.w, 1.0, smoothstep(uMow.z, uMow.z * 2.2, length(wxz - uMow.xy)));
  float camD = length(wxz - uCam.xz);
  hgt *= smoothstep(0.9, 2.6, camD + uCamLift * 2.0);
  float width = mix(0.014, 0.026, gh(id * 7.9)) * (0.6 + hgt * 1.4) * uWidthMul * mix(1.0, 2.2, smoothstep(4.0, 22.0, dist));
  float ang = gh(id * 3.7) * 6.2831;
  vec2 dir = vec2(cos(ang), sin(ang));
  float t = position.y;
  float gust = vnoise2(wxz * 0.18 - uWind * uTime * 0.9);
  float sway = sin(uTime * 2.3 + wxz.x * 1.7 + wxz.y * 1.3) * 0.25 + (gust - 0.4) * 1.3;
  vec2 lean = dir.yx * vec2(1.0, -1.0) * (0.15 + 0.25 * gh(id * 9.1)) + uWind * sway * 0.35;
  vec2 push = vec2(0.0);
  float squash = 0.0;
  for (int i = 0; i < ${MAX_PUSH}; i++) {
    vec2 d = wxz - uPush[i].xz;
    float r = uPush[i].w;
    float l = length(d);
    float k = (1.0 - smoothstep(r * 0.4, r, l)) * step(abs(uPush[i].y - h0), 3.0);
    push += (l > 1e-4 ? d / l : vec2(0.0)) * k * 0.9;
    squash = max(squash, k);
  }
  lean += push;
  float bendAmt = t * t;
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 off = vec3(lean.x, 0.0, lean.y) * hgt * bendAmt;
  float yy = t * hgt * (1.0 - 0.35 * dot(lean, lean) * bendAmt) * (1.0 - 0.5 * squash);
  vec3 sideV = vec3(-dir.y, 0.0, dir.x);
  float wt = width * (1.0 - t * 0.85);
  vec3 p = vec3(wxz.x, h0, wxz.y) + up * yy + off + sideV * position.x * wt;
  vec3 objectNormal = normalize(vec3(dir.x, 0.0, dir.y) * 0.3 + up);
  vGrassT = t;
  vec3 c1 = vec3(0.50, 0.33, 0.11), c2 = vec3(0.40, 0.26, 0.08), c3 = vec3(0.27, 0.21, 0.07), c4 = vec3(0.56, 0.42, 0.18);
  float cr = gh(id * 11.3);
  vGrassCol = cr < 0.4 ? mix(c1, c2, cr / 0.4) : cr < 0.85 ? mix(c2, c3, (cr - 0.4) / 0.45) : c4;
  vGrassCol = mix(vGrassCol, c1 * 1.1, patchN * 0.4);
  vGrassCol = mix(vGrassCol, vec3(0.2, 0.24, 0.07), lakeNear * 0.6);
`)
        .replace('#include <begin_vertex>', 'vec3 transformed = p;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vGrassCol; varying float vGrassT;`)
        .replace('#include <color_fragment>', `diffuseColor.rgb *= vGrassCol * mix(0.3, 1.2, vGrassT);`)
        .replace('#include <normal_fragment_begin>', `float faceDirection = 1.0; vec3 normal = normalize(vNormal); vec3 nonPerturbedNormal = normal;`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          #if NUM_DIR_LIGHTS > 0
          {
            vec3 Ld = directionalLights[0].direction;
            vec3 Vd = normalize(vViewPosition);
            float back = pow(clamp(dot(Vd, Ld), 0.0, 1.0), 3.0);
            reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[0].color * back * 0.9 * vGrassT;
          }
          #endif`);
    };
    mat.customProgramCacheKey = () => 'pa-grass';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  setDensity(k) {
    const n = Math.max(1000, Math.round(this.maxCount * k));
    this.geometry.instanceCount = n;
    this.uniforms.uCount.value = n;
  }
}

export class Grass {
  constructor({ near = 90000, far = 40000 } = {}) {
    this.near = new GrassTile({ count: near, tile: 44, widthMul: 1 });
    this.far = new GrassTile({ count: far, tile: 130, inner: 19, widthMul: 2.2, segs: 3 });
    this.group = new THREE.Group();
    this.group.add(this.near.mesh, this.far.mesh);
    this.tiles = [this.near, this.far];
  }
  get visible() { return this.group.visible; }
  set visible(v) { this.group.visible = v; }
  setDensity(k) { for (const t of this.tiles) t.setDensity(k); }
  /** Shorter grass in a soft circle (x, z, radius, height factor inside; r = 0: off) and overall. */
  setMow(x = 0, z = 0, r = 0, k = 1, scale = 1) { for (const t of this.tiles) { t.uniforms.uMow.value.set(x, z, r, k); t.uniforms.uGrassScale.value = scale; } }
  update(focus, time, pushPoints, camera) {
    let lift = 0;
    if (camera) lift = Math.max(0, camera.position.y - terrainHeight(camera.position.x, camera.position.z) - 0.6);
    for (const t of this.tiles) {
      const u = t.uniforms;
      u.uFocus.value.set(focus.x, focus.z);
      if (camera) { u.uCam.value.copy(camera.position); u.uCamLift.value = lift; }
      u.uTime.value = time;
      const arr = u.uPush.value;
      for (let i = 0; i < MAX_PUSH; i++) {
        const p = pushPoints[i];
        if (p) arr[i].set(p.x, p.y, p.z, p.r);
        else arr[i].set(0, -1000, 0, 1e-4);
      }
    }
  }
}
