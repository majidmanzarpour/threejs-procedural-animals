// Ground and lake surfaces. The ground is a camera-following grid displaced on the GPU with the same
// height function the animals get as `ground(x, z)` on the CPU (noise.js), so feet land on what you see.
import * as THREE from 'three';
import { TERRAIN_GLSL, terrainHeight, WATER_LEVEL, LAKE } from './noise.js';

// Light under water. demoUnderwater: what reaches the eye from a point under the surface - its lit
// colour dimmed along the sun's path down to it and the view path back up (both refracted at the
// surface), plus the water's own colour over the view path (single scattering, Beer-Lambert per
// channel). demoCaustic: the network of light lines the waves focus on the bed (two drifting cellular
// layers, bright at the cell edges; mean ~0.55).
export const UNDERWATER_GLSL = /* glsl */ `
vec3 demoUnderwater(vec3 col, vec3 wp, vec3 cam, vec3 sunDir, vec4 wat, vec3 watCol, float wl, float mask) {
  float dW = wl - wp.y;
  if (dW <= 0.0 || mask <= 0.0) return col;
  vec3 V = cam - wp;
  float dist = length(V);
  V /= max(dist, 1e-4);
  float Lv = cam.y < wl ? dist : dW / sqrt(max(1.0 - (1.0 - V.y * V.y) / 1.777, 0.05));
  float Ls = dW / sqrt(max(1.0 - (1.0 - sunDir.y * sunDir.y) / 1.777, 0.05));
  vec3 Tv = exp(-wat.xyz * Lv), Ts = exp(-wat.xyz * Ls);
  vec3 wet = col * Tv * Ts + watCol * (1.0 - Tv);
  return mix(col, wet, wat.w * mask * smoothstep(0.0, 0.03, dW));
}
vec2 demoCHash(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
float demoCEdge(vec2 p, float t) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = 0.5 + 0.42 * sin(t + 6.2831853 * demoCHash(i + g));
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  }
  return sqrt(d2) - sqrt(d1);
}
float demoCaustic(vec2 p, float t) {
  p += 0.14 * vec2(sin(p.y * 1.7 + t * 0.9), sin(p.x * 1.9 - t * 0.7));
  float a = demoCEdge(p, t), b = demoCEdge(p * 1.43 + vec2(5.2, 1.3), t * 1.21 + 2.0);
  return 1.1 * exp(-a * 6.0) + 0.9 * exp(-b * 7.0);
}
`;

export class Terrain {
  constructor() {
    const N = 300;
    const a = 40, R = 1600, b = R - a;
    const g = new THREE.PlaneGeometry(2, 2, N - 1, N - 1);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i), v = p.getZ(i);
      p.setX(i, a * u + b * u * u * u);
      p.setZ(i, a * v + b * v * v * v);
    }
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.snap = (2 * a) / (N - 1);
    // uBed: 0 = the dark mud lake bed, 1 = a clear sandy bed (the demo reel's fish shot), > 1 brighter sand
    // uWet: the gloss of the wet sand at the waterline (roughness; the reel's low backlit sun turns a
    // glossy band into a bright white ring round the lake)
    // Under the lake (the demo reel's water shots; off by default): uWater: xyz the water's absorption
    // (1/m per channel), w strength 0..1; uWaterCol: the colour of deep water (linear radiance, the light
    // the water itself scatters towards the eye); uCaustic: x strength, y cells per metre, z time, w fade
    // with depth (1/m); uSunDir: the sun (the light's path down to the bed)
    this.uniforms = {
      uFocus: { value: new THREE.Vector2() }, uBed: { value: 0 }, uWet: { value: 0.45 },
      uWater: { value: new THREE.Vector4(0.45, 0.09, 0.07, 0) }, uWaterCol: { value: new THREE.Color(0.01, 0.03, 0.03) },
      uCaustic: { value: new THREE.Vector4(0, 1.6, 0, 0.15) }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uFocus = this.uniforms.uFocus;
      sh.uniforms.uBed = this.uniforms.uBed;
      sh.uniforms.uWet = this.uniforms.uWet;
      for (const k of ['uWater', 'uWaterCol', 'uCaustic', 'uSunDir']) sh.uniforms[k] = this.uniforms[k];
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nuniform vec2 uFocus;\nvarying vec3 vWorld;\n${TERRAIN_GLSL}`)
        .replace('#include <beginnormal_vertex>', `
          vec2 wxz = position.xz + uFocus;
          float dist = length(position.xz);
          float detail = 1.0 - smoothstep(60.0, 160.0, dist);
          float e = max(0.25, dist * 0.01);
          float h0 = terrainHeight(wxz, detail);
          float hx = terrainHeight(wxz + vec2(e, 0.0), detail);
          float hz = terrainHeight(wxz + vec2(0.0, e), detail);
          vec3 objectNormal = normalize(vec3(h0 - hx, e, h0 - hz));
          #ifdef USE_TANGENT
          vec3 objectTangent = vec3(1.0, 0.0, 0.0);
          #endif`)
        .replace('#include <begin_vertex>', `vec3 transformed = vec3(wxz.x, h0, wxz.y);\nvWorld = transformed;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\nuniform float uBed;\nuniform float uWet;\nuniform vec4 uWater;\nuniform vec3 uWaterCol;\nuniform vec4 uCaustic;\nuniform vec3 uSunDir;\n${TERRAIN_GLSL}\n${UNDERWATER_GLSL}`)
        .replace('#include <color_fragment>', `
          vec2 w = vWorld.xz;
          float big = vnoise2(w * 0.035);
          float mid = vnoise2(w * 0.23 + 3.1);
          float fine = vnoise2(w * 2.1 + 7.7);
          float fine2 = vnoise2(w * 7.3 + 1.3);
          vec3 straw = vec3(0.44, 0.29, 0.095);
          vec3 dry = vec3(0.34, 0.21, 0.07);
          vec3 soil = vec3(0.27, 0.135, 0.06);
          vec3 dark = vec3(0.13, 0.09, 0.045);
          vec3 olive = vec3(0.21, 0.17, 0.055);
          vec3 lush = vec3(0.16, 0.17, 0.05);
          vec3 sand = vec3(0.36, 0.27, 0.15);
          vec3 mud = vec3(0.12, 0.085, 0.05);
          vec3 col = mix(dry, straw, smoothstep(0.3, 0.75, mid));
          col = mix(col, olive, smoothstep(0.55, 0.85, big) * 0.6);
          float bare = smoothstep(0.55, 0.8, vnoise2(w * 0.09 + 11.0) * 0.7 + mid * 0.3);
          col = mix(col, soil, bare * 0.75);
          // greener ground around the lake, a sandy beach, then wet mud and the lake bed
          float near = 1.0 - smoothstep(LAKE.z * 1.1, LAKE.z * 2.2, length(w - LAKE.xy));
          col = mix(col, lush, near * 0.55 * (0.6 + 0.4 * mid));
          float hw = mix(10.0, vWorld.y - WATER_LEVEL, lakeMask(w));
          col = mix(col, sand, (1.0 - smoothstep(0.12, 0.45 + 0.2 * mid, hw)) * 0.85);
          float bedK = min(uBed, 1.0), bedL = 1.0 + 1.1 * max(uBed - 1.0, 0.0);
          col = mix(col, mix(mud, sand * 0.9, bedK), 1.0 - smoothstep(-0.02, 0.1, hw));
          col = mix(col, mix(mud * 0.6, sand * 0.72 * bedL, bedK), 1.0 - smoothstep(-0.5, -0.05, hw));
          // the fine grain is projected straight down: on a steep slope (the lake's underwater bank) it
          // would smear into vertical streaks, so it fades out there (and in deeper water)
          vec3 gN = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
          float flatK = (1.0 - smoothstep(0.22, 0.55, 1.0 - abs(gN.y))) * mix(1.0, 0.35, (1.0 - smoothstep(-0.6, -0.1, hw)) * lakeMask(w));
          col *= 0.8 + (0.35 * fine + 0.15 * fine2 - 0.25) * flatK + 0.25;
          col = mix(col, dark, smoothstep(0.7, 0.95, fine2) * 0.25 * flatK);
          diffuseColor.rgb *= col;`)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
          if (uCaustic.x > 0.0) {
            float dW = WATER_LEVEL - vWorld.y, lm = lakeMask(vWorld.xz);
            if (dW > 0.0 && lm > 0.0) {
              // the light focused by the waves: the pattern slides with the refracted sun ray's offset
              vec2 q = vWorld.xz - uSunDir.xz / max(uSunDir.y + 0.35, 0.3) * dW * 0.5;
              float c = demoCaustic(q * uCaustic.y, uCaustic.z);
              float k = uCaustic.x * smoothstep(0.0, 0.2, dW) * lm * exp(-dW * uCaustic.w);
              reflectedLight.directDiffuse *= max(0.0, 1.0 + k * (c - 0.55));
            }
          }`)
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
          if (uWater.w > 0.0) gl_FragColor.rgb = demoUnderwater(gl_FragColor.rgb, vWorld, cameraPosition, uSunDir, uWater, uWaterCol, WATER_LEVEL, lakeMask(vWorld.xz));`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, uWet, (1.0 - smoothstep(-0.02, 0.1, vWorld.y - WATER_LEVEL)) * lakeMask(vWorld.xz));`)
        .replace('#include <normal_fragment_maps>', `
          #include <normal_fragment_maps>
          {
            vec3 gN2 = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
            float flatB = 1.0 - smoothstep(0.22, 0.55, 1.0 - abs(gN2.y));
            float bh = (vnoise2(vWorld.xz * 3.1) * 0.02 + vnoise2(vWorld.xz * 11.0) * 0.006) * flatB;
            vec3 dpx = dFdx(vViewPosition), dpy = dFdy(vViewPosition);
            float dhx = dFdx(bh), dhy = dFdy(bh);
            vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
            float det = dot(dpx, r1);
            vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
            vec3 nn = abs(det) * normal - grad;
            if (dot(nn, nn) > 1e-24) normal = normalize(nn);
          }`);
    };
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'terrain';
  }

  update(focus) {
    const s = this.snap;
    this.uniforms.uFocus.value.set(Math.round(focus.x / s) * s, Math.round(focus.z / s) * s);
  }
}

// Lake surface: depth-tinted, with a soft shallow edge and a foam line where it meets the shore;
// reflections come from the sky environment map and the sun's specular.
export class Water {
  constructor() {
    const g = new THREE.CircleGeometry(LAKE.r * 1.75, 160).rotateX(-Math.PI / 2);
    g.translate(LAKE.x, WATER_LEVEL, LAKE.z);
    // uPhys 1 (the demo reel's water shots): a physical surface - the water's body is drawn with the bed
    // (Terrain uWater: absorption and the water's colour), the surface keeps its reflections (not scaled
    // by its opacity: premultiplied output) and the foam line
    this.uniforms = { uTime: { value: 0 }, uClear: { value: 0 }, uPhys: { value: 0 } };
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.06, metalness: 0, transparent: true, depthWrite: false, envMapIntensity: 1.1,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uniforms.uTime;
      sh.uniforms.uClear = this.uniforms.uClear;
      sh.uniforms.uPhys = this.uniforms.uPhys;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vW;\nuniform float uTime;\nuniform float uClear;\nuniform float uPhys;\n${TERRAIN_GLSL}`)
        .replace('#include <color_fragment>', `
          float depth = WATER_LEVEL - terrainHeight(vW.xz, 1.0);
          if (depth < -0.01) discard;
          vec3 shallow = vec3(0.16, 0.15, 0.09), deep = vec3(0.015, 0.035, 0.035);
          diffuseColor.rgb = mix(shallow, deep, smoothstep(0.0, 0.7, depth));
          float foamN = vnoise2(vW.xz * 3.0 + vec2(uTime * 0.3, 0.0));
          float foam = (1.0 - smoothstep(0.0, 0.05 + 0.04 * foamN, depth)) * 0.55;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.52, 0.45), foam);
          diffuseColor.a = mix(0.12, 0.84, smoothstep(0.0, 0.9, depth)) + foam * 0.4;
          // clear water while a swimmer is the subject (it swims under this surface)
          diffuseColor.a *= 1.0 - 0.62 * uClear;
          if (uPhys > 0.5) diffuseColor.a = foam * 0.4;`)
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
          vec3 wSpec = vec3(0.0);
          if (uPhys > 0.5) { wSpec = reflectedLight.directSpecular + reflectedLight.indirectSpecular; gl_FragColor.rgb = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse; }`)
        .replace('#include <premultiplied_alpha_fragment>', 'gl_FragColor.rgb = gl_FragColor.rgb * gl_FragColor.a + wSpec;')
        .replace('#include <normal_fragment_maps>', `
          #include <normal_fragment_maps>
          {
            vec2 p = vW.xz;
            float e = 0.08;
            #define WV(q) (vnoise2((q) * 1.7 + vec2(uTime * 0.35, uTime * 0.2)) * 0.6 + vnoise2((q) * 4.3 - vec2(uTime * 0.25, -uTime * 0.4)) * 0.25)
            float w0 = WV(p), wx = WV(p + vec2(e, 0.0)), wz = WV(p + vec2(0.0, e));
            vec3 nW = normalize(vec3((w0 - wx) * 0.18 / e, 1.0, (w0 - wz) * 0.18 / e));
            normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
          }`);
    };
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.renderOrder = 5;
    this.mesh.name = 'water';
    this.mesh.receiveShadow = false;
  }
  update(time) { this.uniforms.uTime.value = time; }
}

export { terrainHeight };
