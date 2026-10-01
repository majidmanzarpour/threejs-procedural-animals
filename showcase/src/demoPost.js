// Demo reel post pass. The scene renders linear HDR into a multisampled half-float target; a bloom mip
// chain (13-tap downsample with a Karis-averaged, soft-threshold prefilter, tent upsample) makes the
// sun and the rim-lit fur glow; one full-screen pass then does what the showcase's renderer does on
// screen (exposure + ACES filmic, sRGB), adds a trailer grade (teal shadows, golden highlights, a
// little saturation and contrast, a sky grad and a vignette), the whip-pan blur, the fade to black and
// the titles (a 2D canvas, demoTitles.js) on top. So everything the recorder captures is one canvas.
import * as THREE from 'three';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DOWN = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;      // 1 / source size
uniform float uPrefilter; // 1: first level (Karis average + threshold)
uniform vec4 uThresh;     // x threshold, y knee, z exposure, w clamp
varying vec2 vUv;
vec3 T(vec2 o) { return texture2D(tSrc, vUv + uTexel * o).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d) {
  float wa = 1.0 / (1.0 + luma(a)), wb = 1.0 / (1.0 + luma(b)), wc = 1.0 / (1.0 + luma(c)), wd = 1.0 / (1.0 + luma(d));
  return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
}
void main() {
  vec3 a = T(vec2(-2.0, -2.0)), b = T(vec2(0.0, -2.0)), c = T(vec2(2.0, -2.0));
  vec3 d = T(vec2(-1.0, -1.0)), e = T(vec2(1.0, -1.0));
  vec3 f = T(vec2(-2.0, 0.0)), g = T(vec2(0.0, 0.0)), h = T(vec2(2.0, 0.0));
  vec3 i = T(vec2(-1.0, 1.0)), j = T(vec2(1.0, 1.0));
  vec3 k = T(vec2(-2.0, 2.0)), l = T(vec2(0.0, 2.0)), m = T(vec2(2.0, 2.0));
  vec3 col;
  if (uPrefilter > 0.5) {
    col = karis(d, e, i, j) * 0.5 + karis(a, b, f, g) * 0.125 + karis(b, c, g, h) * 0.125 + karis(f, g, k, l) * 0.125 + karis(g, h, l, m) * 0.125;
    col *= uThresh.z;
    // firefly / sun clamp: the sun disc is thousands of units bright, its glow must not flood the frame
    float mx = max(col.r, max(col.g, col.b));
    col *= min(1.0, uThresh.w / max(mx, 1e-5));
    float br = max(col.r, max(col.g, col.b));
    float soft = clamp(br - uThresh.x + uThresh.y, 0.0, 2.0 * uThresh.y);
    soft = soft * soft / (4.0 * uThresh.y + 1e-5);
    col *= max(soft, br - uThresh.x) / max(br, 1e-5);
  } else {
    col = (d + e + i + j) * 0.125 + g * 0.125 + (a + c + k + m) * 0.03125 + (b + f + h + l) * 0.0625;
  }
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

const UP = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 d = uTexel * uRadius;
  vec3 s = texture2D(tSrc, vUv - d).rgb + 2.0 * texture2D(tSrc, vUv + vec2(0.0, -d.y)).rgb + texture2D(tSrc, vUv + vec2(d.x, -d.y)).rgb
    + 2.0 * texture2D(tSrc, vUv + vec2(-d.x, 0.0)).rgb + 4.0 * texture2D(tSrc, vUv).rgb + 2.0 * texture2D(tSrc, vUv + vec2(d.x, 0.0)).rgb
    + texture2D(tSrc, vUv + vec2(-d.x, d.y)).rgb + 2.0 * texture2D(tSrc, vUv + vec2(0.0, d.y)).rgb + texture2D(tSrc, vUv + d).rgb;
  gl_FragColor = vec4(s / 16.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uBloom;     // bloom strength
uniform vec2 uBlur;       // whip-pan blur (uv units, full extent)
uniform float uFade;      // 0 image .. 1 black
uniform float uGrade;     // grade strength 0..1
uniform float uWarm;      // golden highlights / teal shadows amount
uniform float uSat;       // saturation
uniform float uVignette;
uniform float uSkyGrad;
uniform float uAspect;
uniform float uFrame;
uniform float uWhite;     // 0 .. 1 flash to warm white
uniform float uGrain;     // film grain amplitude (8-bit code values, mid tones)
uniform float uGrainPx;   // film grain size (px): the grain is smooth value noise on a lattice this wide
varying vec2 vUv;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
// three.js ACESFilmicToneMapping, with our own exposure uniform
vec3 acesFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= uExposure / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 srgbOETF(vec3 c) {
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// smooth value noise in [0, 1] (the film grain: blobs ~uGrainPx wide survive a video encoder, where
// single-pixel noise is the first thing it throws away)
float vnoiseG(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec3 sceneAt(vec2 uv) { return texture2D(tScene, uv).rgb + texture2D(tBloom, uv).rgb * uBloom; }

void main() {
  vec3 c;
  if (dot(uBlur, uBlur) > 1e-8) {
    // directional blur for whip pans: a box along the pan, centre-weighted a little
    c = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 32; i++) {
      float t = (float(i) + 0.5) / 32.0 - 0.5;
      float w = 1.0 - 0.6 * abs(t) * 2.0;
      c += sceneAt(vUv + uBlur * t) * w;
      wsum += w;
    }
    c /= wsum;
  } else {
    c = sceneAt(vUv);
  }
  c = acesFilmic(c);
  // grade (display-referred linear): split toning, teal shadows and golden highlights, then saturation
  float l = luma(c);
  vec3 tone = mix(vec3(0.93, 1.0, 1.07), vec3(1.07, 1.0, 0.86), smoothstep(0.02, 0.6, l));
  // (a blue sky keeps its blue: the golden highlight tint turned it olive; land, fur and the warm sky
  // round the sun keep the full split tone)
  float blue = smoothstep(0.02, 0.3, (c.b - c.r) / max(l, 1e-3));
  tone = mix(tone, vec3(0.97, 1.0, 1.04), blue * smoothstep(0.08, 0.3, l));
  vec3 g = c * mix(vec3(1.0), tone, uWarm);
  float lg = luma(g);
  g = mix(vec3(lg), g, uSat);
  c = mix(c, max(g, 0.0), uGrade);
  c = srgbOETF(clamp(c, 0.0, 1.0));
  // gentle S-curve, a graduated filter over the sky and a vignette
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.32 * uGrade);
  c *= 1.0 - uSkyGrad * smoothstep(0.55, 1.0, vUv.y);
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0) / max(uAspect, 1.0);
  c *= 1.0 - uVignette * pow(clamp(length(q) * 1.35, 0.0, 1.0), 2.6);
  c = mix(c, vec3(1.0, 0.93, 0.8), uWhite);
  c = mix(c, vec3(0.0), uFade);
  // the last step before the 8-bit target: triangular (TPDF) dither of +-1 code value, which leaves no
  // contour rings in the sky's smooth gradients, plus a fine film grain weighted to the mid tones (its
  // own TPDF, uGrain code values) that survives the H.264 encode and a platform's re-encode, where a
  // sub-code dither alone is smoothed away and the rings come back. Fresh noise every frame.
  vec2 fc = gl_FragCoord.xy;
  float f0 = uFrame * 17.31;
  float d = hash12(fc + f0) + hash12(fc * 1.37 + f0 + 11.1) - 1.0;
  vec2 go = vec2(hash12(vec2(uFrame, 3.7)), hash12(vec2(uFrame, 9.1))) * 512.0;
  float gr = (vnoiseG(fc / uGrainPx + go) + vnoiseG(fc / (uGrainPx * 0.7) + go.yx + 7.3) - 1.0) * 1.6;
  float lm = luma(c);
  float mid = clamp(4.0 * lm * (1.0 - lm), 0.0, 1.0);
  c += (d + gr * uGrain * (0.35 + 0.65 * mid)) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}
`;

// final pass: FXAA on the graded image (live profile: no MSAA), then the titles, crisp, on top
const fxaaBody = FXAAShader.fragmentShader.slice(0, FXAAShader.fragmentShader.lastIndexOf('void main()'));
const FINAL = /* glsl */ `
precision highp float;
${fxaaBody}
uniform sampler2D tTitles;
uniform float uHasTitles;
uniform float uFxaa;
uniform float uFrame;
void main() {
  vec3 c = uFxaa > 0.5 ? ApplyFXAA(tDiffuse, resolution.xy, vUv).rgb : texture2D(tDiffuse, vUv).rgb;
  if (uHasTitles > 0.5) {
    vec4 t = texture2D(tTitles, vUv);
    c = mix(c, t.rgb, t.a);
    // the titles' soft scrims are 8-bit gradients: dither them like the scene (no rings in the sky)
    vec3 p3 = fract(vec3(gl_FragCoord.xyx + uFrame * 7.13) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    c += (fract((p3.x + p3.y) * p3.z) - 0.5) / 255.0 * min(1.0, t.a * 40.0);
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

const LEVELS = 6;

export class DemoPost {
  // w, h: output size (the canvas drawing buffer); ss: supersampling of the scene render (1 .. 2)
  constructor(renderer, w, h, { ss = 1, samples = 4, fxaa = false } = {}) {
    this.renderer = renderer;
    this.ss = ss;
    this.ldr = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false });
    this.ldr.texture.minFilter = THREE.LinearFilter;
    this.ldr.texture.magFilter = THREE.LinearFilter;
    this.ldr.texture.generateMipmaps = false;
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: true, stencilBuffer: false });
    this.rt.texture.minFilter = THREE.LinearFilter;
    this.rt.texture.magFilter = THREE.LinearFilter;
    this.rt.texture.generateMipmaps = false;
    const mipRT = () => { const r = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false }); r.texture.minFilter = THREE.LinearFilter; r.texture.magFilter = THREE.LinearFilter; r.texture.generateMipmaps = false; return r; };
    this.mips = Array.from({ length: LEVELS }, mipRT);
    this.uniforms = {
      tScene: { value: this.rt.texture },
      tBloom: { value: this.mips[0].texture },
      uExposure: { value: 0.72 },
      uBloom: { value: 0.035 },
      uBlur: { value: new THREE.Vector2() },
      uFade: { value: 0 },
      uGrade: { value: 1 },
      uWarm: { value: 0.85 },
      uSat: { value: 1.1 },
      uVignette: { value: 0.3 },
      uSkyGrad: { value: 0.1 },
      uAspect: { value: w / h },
      uFrame: { value: 0 },
      uWhite: { value: 0 },
      // (measured: a sky gradient of a 1080p60 recording had 89 % identical neighbouring pixels in the
      // CRF 16 H.264 file with a sub-code dither alone, 44 % with this grain (36 % before encoding))
      uGrain: { value: 2.5 },
      uGrainPx: { value: 2.2 },
    };
    this.bloomThreshold = 2.0; // in exposed scene units (the sun, sunlit rims; not the lit ground)
    this.bloomKnee = 1.0;
    this.bloomClamp = 10;
    const quadMat = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra });
    this.material = quadMat(FRAG, this.uniforms);
    this.finalUniforms = { tDiffuse: { value: this.ldr.texture }, resolution: { value: new THREE.Vector2() }, tTitles: { value: null }, uHasTitles: { value: 0 }, uFxaa: { value: fxaa ? 1 : 0 }, uFrame: this.uniforms.uFrame };
    this.final = quadMat(FINAL, this.finalUniforms);
    this.down = quadMat(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 }, uThresh: { value: new THREE.Vector4() } });
    this.up = quadMat(UP, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } }, { blending: THREE.AdditiveBlending, transparent: true });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // overlay: drawn over the scene with its own depth (skeletons seen through the body)
    this.overlay = new THREE.Scene();
    this.overlaySun = new THREE.DirectionalLight(0xffffff, 2);
    this.overlayHemi = new THREE.HemisphereLight(0xa9c1e0, 0x5a4630, 1.2);
    this.overlay.add(this.overlaySun, this.overlaySun.target, this.overlayHemi);
    this.setSize(w, h);
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    this.rt.setSize(Math.round(w * this.ss), Math.round(h * this.ss));
    this.ldr.setSize(w, h);
    if (this.finalUniforms) this.finalUniforms.resolution.value.set(1 / w, 1 / h);
    let mw = Math.max(1, Math.round(w / 2)), mh = Math.max(1, Math.round(h / 2));
    for (const m of this.mips) { m.setSize(mw, mh); mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1); }
    this.uniforms.uAspect.value = w / h;
  }

  setTitles(tex) {
    this.finalUniforms.tTitles.value = tex;
    this.finalUniforms.uHasTitles.value = tex ? 1 : 0;
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  bloom() {
    const r = this.renderer;
    const D = this.down.uniforms, U = this.up.uniforms;
    // prefilter + downsample chain
    let src = this.rt.texture, sw = this.rt.width, sh = this.rt.height;
    for (let i = 0; i < this.mips.length; i++) {
      D.tSrc.value = src;
      D.uTexel.value.set(1 / sw, 1 / sh);
      D.uPrefilter.value = i === 0 ? 1 : 0;
      D.uThresh.value.set(this.bloomThreshold, this.bloomKnee, this.uniforms.uExposure.value / 0.6, this.bloomClamp);
      this._pass(this.down, this.mips[i]);
      src = this.mips[i].texture; sw = this.mips[i].width; sh = this.mips[i].height;
    }
    // upsample: every level adds the (tent-filtered) level below it
    r.autoClear = false;
    for (let i = this.mips.length - 2; i >= 0; i--) {
      const s = this.mips[i + 1];
      U.tSrc.value = s.texture;
      U.uTexel.value.set(1 / s.width, 1 / s.height);
      this._pass(this.up, this.mips[i]);
    }
    r.autoClear = true;
  }

  render(scene, camera) {
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.clear(true, true, false);
    r.render(scene, camera);
    if (this.overlay.children.some((o) => o.visible && !o.isLight)) {
      r.autoClear = false;
      r.clearDepth();
      r.render(this.overlay, camera);
      r.autoClear = true;
    }
    if (this.uniforms.uBloom.value > 0) this.bloom();
    this._pass(this.material, this.ldr);
    this.quad.material = this.final;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
    this.uniforms.uFrame.value = (this.uniforms.uFrame.value + 1) % 1000;
  }

  dispose() {
    this.rt.dispose(); this.ldr.dispose();
    for (const m of this.mips) m.dispose();
    this.material.dispose(); this.down.dispose(); this.up.dispose(); this.final.dispose();
    this.quad.geometry.dispose();
  }
}
