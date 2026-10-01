// Sky, sun, fog, image-based lighting from the sky, distant hills, acacias, and small effects
// (footfall dust, water rings). Animals are lit by the sun and hemisphere lights and by their share of
// the sky's light (animalSH, see updateEnvLight / makeAnimalLight).
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';
import { terrainHeight, vnoise2, hash2, LAKE, WATER_LEVEL } from './noise.js';

const smooth = THREE.MathUtils.smoothstep;
// the savanna's mean albedo (terrain.js: dry grass and straw, some soil), linear
const GROUND_ALBEDO = new THREE.Color(0.3, 0.2, 0.075);
const lerp = THREE.MathUtils.lerp;

export class Environment {
  constructor(renderer, scene, { shadowSize = 2048, envSize = 128, tod = 0.15 } = {}) {
    this.renderer = renderer;
    this.envSize = envSize;
    this.scene = scene;
    const tame = (m) => { m.fragmentShader = m.fragmentShader.replace('760.0 * sundisc', '38.0 * sundisc'); m.needsUpdate = true; };
    this.sky = new Sky();
    this.sky.scale.setScalar(4500);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 9;
    u.rayleigh.value = 2.2;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.86;
    if (u.cloudCoverage) { u.cloudCoverage.value = 0.32; u.cloudDensity.value = 0.5; u.cloudScale.value = 0.00018; }
    this.sky.material.depthWrite = false;
    tame(this.sky.material);
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 2.5;
    this.setShadowExtent(3.4);
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xa9c1e0, 0x5a4630, 0.22);
    scene.add(this.hemi);
    this.sunDir = new THREE.Vector3();
    this.sunColor = new THREE.Color();
    this.skyAmb = new THREE.Color();
    this.groundAmb = new THREE.Color();

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(1000);
    tame(this.envSky.material);
    this.envSky.material.uniforms.showSunDisc.value = 0;
    this.envScene.add(this.envSky);
    scene.fog = new THREE.Fog(0xcdb28c, 70, 2400);

    this.hills = makeHills();
    scene.add(this.hills);
    this.trees = new Trees();
    scene.add(this.trees.group);
    this.dust = new Dust();
    scene.add(this.dust.points);
    this.ripples = new Ripples();
    scene.add(this.ripples.mesh);
    this.time = 0;
    this.animalSky = { gain: 0.3, sat: 0.5 };
    this.setTimeOfDay(tod);
  }

  // r: half size (m) of the shadow frustum round the focus. The biases scale with it (they are tuned
  // for the cheetah at r = 3.4 m): a fixed 2 cm depth bias and normal offset would lift a 3 cm spider's
  // shadow clean off the ground (peter-panning), and a horse's would acne.
  // thin (optional): the subject's height (m). A long flat body gets a big frustum for its length but
  // is only a few cm tall (a 1.3 m snake is 2.5 cm): biases scaled by r alone (~1.4 cm each) would
  // swallow its whole shadow, so they are also held to a fraction of that height, but not under
  // ~1 / 0.5 shadow texels (acne on the body itself).
  setShadowExtent(r, thin = Infinity) {
    const sc = this.sun.shadow.camera;
    sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 1; sc.far = 40 + r * 4;
    sc.updateProjectionMatrix();
    const k = r / 3.4, texel = (2 * r) / this.sun.shadow.mapSize.x;
    const bias = Math.min(0.021 * k, Math.max(0.06 * thin, 1.0 * texel));
    this.sun.shadow.bias = -bias / (sc.far - sc.near);
    this.sun.shadow.normalBias = Math.min(0.02 * k, Math.max(0.04 * thin, 0.5 * texel));
    this.shadowR = r;
  }

  // t in [0,1]: 0 = sunrise, 0.5 = noon, 1 = sunset
  // updateEnv = false skips the (costly) sky environment map; call again with true when the slider settles
  setTimeOfDay(t, updateEnv = true) {
    this.tod = t;
    const elev = lerp(3, 64, Math.sin(Math.PI * THREE.MathUtils.clamp(t, 0, 1)) ** 0.8);
    const azim = lerp(-100, 100, t) + 180;
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), THREE.MathUtils.degToRad(azim));
    const su = this.sky.material.uniforms, eu = this.envSky.material.uniforms;
    su.sunPosition.value.copy(this.sunDir);
    eu.sunPosition.value.copy(this.sunDir);
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'cloudCoverage', 'cloudDensity', 'cloudScale']) if (eu[k] && su[k]) eu[k].value = su[k].value;
    const low = 1 - smooth(elev, 3, 35);
    this.sunColor.setRGB(1.0, lerp(0.9, 0.6, low), lerp(0.78, 0.34, low));
    this.sun.color.copy(this.sunColor);
    // a little auto-exposure: a high sun would otherwise bleach the savanna
    this.exposure = lerp(0.72, 0.56, smooth(elev, 30, 64));
    this.sun.intensity = lerp(2.5, 2.4, low) * smooth(elev, 0, 5) + 0.15;
    this.skyAmb.setRGB(lerp(0.3, 0.36, low), lerp(0.36, 0.32, low), lerp(0.46, 0.36, low));
    this.groundAmb.setRGB(0.26, 0.19, 0.11).multiplyScalar(lerp(1, 0.8, low));
    this.hemi.color.copy(this.skyAmb);
    this.hemi.groundColor.copy(this.groundAmb);
    this.scene.fog.color.setRGB(lerp(0.56, 0.74, low), lerp(0.55, 0.53, low), lerp(0.5, 0.4, low));
    if (!updateEnv) return;
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0.03, 0.1, 100, { size: this.envSize });
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.18;
    this.updateEnvLight();
  }

  // The sky's diffuse light as spherical harmonics, for the animals' coat materials: three.js lights only
  // its own standard materials (the ground, grass, props) with scene.environment, so without this the
  // animals had nothing but the weak hemisphere fill and their shaded sides went near-black. The same sky
  // scene as the environment map, projected from a small cube render (read back asynchronously), in two
  // passes: the sky alone, then with the savanna under it (the sky shader's colour below the horizon is
  // haze, blue; the ground's bounce is warm), lit by the sun and that sky. onLight() fires when it is
  // ready (main.js passes it to every animal).
  updateEnvLight() {
    if (!this.cubeRT) {
      this.cubeRT = new THREE.WebGLCubeRenderTarget(32, { type: THREE.HalfFloatType });
      this.cubeCam = new THREE.CubeCamera(0.1, 3000, this.cubeRT);
      // (inside the sky box, half size 500: a disc of 450 m 1 m down leaves a 0.13 degree gap)
      this.bounce = new THREE.Mesh(new THREE.CircleGeometry(450, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ fog: false, toneMapped: false }));
      this.bounce.position.y = -1;
      this.bounce.visible = false;
      this.envScene.add(this.bounce);
    }
    const ticket = (this.lightTicket = (this.lightTicket || 0) + 1);
    const probe = async (ground) => {
      this.bounce.visible = ground;
      this.cubeCam.update(this.renderer, this.envScene);
      this.bounce.visible = false;
      return (await LightProbeGenerator.fromCubeRenderTarget(this.renderer, this.cubeRT)).sh;
    };
    (async () => {
      const sky = await probe(false);
      if (ticket !== this.lightTicket) return;
      // ground radiance (in the sky map's units, which scene.environmentIntensity scales) =
      // albedo x (sun + sky irradiance on flat ground) / pi
      const I = this.scene.environmentIntensity || 1;
      const E = sky.getIrradianceAt(new THREE.Vector3(0, 1, 0), new THREE.Vector3()).multiplyScalar(I);
      const sunE = this.sun.intensity * Math.max(0, this.sunDir.y);
      const c = this.bounce.material.color;
      c.setRGB(E.x + this.sunColor.r * sunE, E.y + this.sunColor.g * sunE, E.z + this.sunColor.b * sunE).multiply(GROUND_ALBEDO).multiplyScalar(1 / (Math.PI * I));
      const sh = await probe(true);
      if (ticket !== this.lightTicket) return;
      this.envSH = sh;
      this.makeAnimalLight();
      this.onLight?.();
    })().catch((e) => console.warn('environment light probe failed', e));
  }

  // The animals' share of the sky light (animalSH, for setEnvironmentLight). The coat shader draws the sun
  // at full strength on the albedo (no 1/pi Lambert factor, unlike three.js's standard materials) and the
  // sky's irradiance with it, so the ground's own share would wash every animal out (a pink pig turned
  // white, a frog pale blue): the sky is scaled so that its mean irradiance against the sun matches the
  // studio the species are tuned in (tools/harness: hemisphere 0.21 of the sun's luminance; here 0.2 at
  // the default hour with gain 0.3), and this sky's strong Rayleigh blue is half desaturated (luminance
  // kept), about the studio sky's tint.
  makeAnimalLight() {
    if (!this.envSH) return;
    const { gain, sat } = this.animalSky;
    const k = gain * this.scene.environmentIntensity;
    this.animalSH ||= new THREE.SphericalHarmonics3();
    this.envSH.coefficients.forEach((c, i) => {
      const L = 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
      this.animalSH.coefficients[i].set(L + (c.x - L) * sat, L + (c.y - L) * sat, L + (c.z - L) * sat).multiplyScalar(k);
    });
  }

  update(focus, dt, camera) {
    this.time += dt;
    const u = this.sky.material.uniforms;
    if (u.time) u.time.value = this.time;
    // snap the shadow frustum to texels so the shadows do not shimmer while the camera moves
    const r = this.shadowR, texel = (2 * r) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.position.set(fx, focus.y, fz).addScaledVector(this.sunDir, 20 + r * 2);
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.target.updateMatrixWorld();
    this.sky.position.copy(camera.position);
    this.hills.position.set(camera.position.x, 0, camera.position.z);
    this.trees.update(focus);
    this.dust.update(dt, this.sunColor);
    this.ripples.update(dt);
  }
}

function makeHills() {
  const seg = 384, rings = 8;
  const pos = [], col = [], idx = [];
  for (let r = 0; r <= rings; r++) {
    const rad = lerp(1400, 2300, r / rings);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a), rr = r / rings;
      let n = 0, amp = 0.55, f = 2.5;
      for (let o = 0; o < 5; o++) { n += amp * (1 - Math.abs(vnoise2(cx * f + 10 + rr * 2, cz * f + 10 - rr) * 2 - 1)); amp *= 0.5; f *= 2.1; }
      const range = vnoise2(cx * 1.2 + 4, cz * 1.2 + 4);
      const ridge = Math.pow(Math.max(0, n - 0.35), 1.6) * 520 * Math.sin(rr * Math.PI) * (0.25 + range) + (r === 0 || r === rings ? -40 : 0);
      pos.push(cx * rad, ridge - 30, cz * rad);
      const shade = 0.85 + 0.15 * rr;
      col.push(0.2 * shade, 0.2 * shade, 0.22 * shade);
    }
  }
  for (let r = 0; r < rings; r++)
    for (let i = 0; i < seg; i++) {
      const a = r * (seg + 1) + i, b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  m.frustumCulled = false;
  return m;
}

// ---------------------------------------------------------------------------------------- acacias
export function mergeColored(list) {
  let n = 0;
  const flat = list.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of flat) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of flat) {
    pos.set(g.attributes.position.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.computeVertexNormals();
  return m;
}

export function colorize(g, c) {
  const a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}

export function limb(a, b, r0, r1, color, radial = 7) {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r1, r0, d.length(), radial, 1, true);
  g.translate(0, d.length() / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
  g.translate(a.x, a.y, a.z);
  return colorize(g, color);
}

function acaciaGeometry(seed) {
  let s = seed;
  const R = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const parts = [];
  const bark = new THREE.Color(0.09, 0.075, 0.06);
  const H = 3.2 + R() * 2.2, W = 3.2 + R() * 2.8;
  const fork = new THREE.Vector3((R() - 0.5) * 0.6, H * 0.45, (R() - 0.5) * 0.6);
  parts.push(limb(new THREE.Vector3(0, -0.2, 0), fork, 0.2, 0.14, bark));
  const nb = 3 + Math.floor(R() * 3);
  const tips = [];
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * Math.PI * 2 + R() * 0.8;
    const tip = new THREE.Vector3(Math.cos(a) * W * (0.35 + 0.35 * R()), H * (0.85 + 0.15 * R()), Math.sin(a) * W * (0.35 + 0.35 * R()));
    parts.push(limb(fork, tip, 0.1, 0.045, bark));
    tips.push(tip);
  }
  const leaf = new THREE.Color(0.075, 0.09, 0.03);
  const blobs = 7 + Math.floor(R() * 6);
  for (let i = 0; i < blobs; i++) {
    const t = tips[i % tips.length];
    const c = t.clone().add(new THREE.Vector3((R() - 0.5) * W * 0.6, 0.2 + R() * 0.35, (R() - 0.5) * W * 0.6));
    const r = 0.9 + R() * 1.1;
    const g = new THREE.IcosahedronGeometry(1, 2);
    const p = g.attributes.position;
    const cols = new Float32Array(p.count * 3);
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      const n = 0.75 + 0.5 * vnoise2(x * 2.3 + i * 7 + seed, z * 2.3 + y * 1.7);
      p.setXYZ(k, c.x + x * r * n * 1.25, c.y + y * r * 0.34 * n, c.z + z * r * n * 1.25);
      const sh = 0.75 + 0.35 * (y * 0.5 + 0.5);
      cols[k * 3] = leaf.r * sh; cols[k * 3 + 1] = leaf.g * sh * (0.9 + 0.2 * n); cols[k * 3 + 2] = leaf.b * sh;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    g.deleteAttribute('uv');
    parts.push(g);
  }
  return mergeColored(parts);
}

class Trees {
  constructor() {
    this.group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    this.meshes = [11, 23, 37, 51].map((s) => {
      const m = new THREE.InstancedMesh(acaciaGeometry(s), mat, 90);
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    });
    this.cell = 48;
    this.lastKey = '';
    // an optional clearing ({ x, z, r }: no tree within r metres of x, z; the demo reel keeps the big
    // low-poly canopies out of its close shots)
    this.clear = null;
  }
  update(focus) {
    const cx = Math.floor(focus.x / this.cell), cz = Math.floor(focus.z / this.cell);
    const C = this.clear;
    const key = cx + ',' + cz + (C ? `|${C.x.toFixed(1)},${C.z.toFixed(1)},${C.r}` : '');
    if (key === this.lastKey) return;
    this.lastKey = key;
    const counts = [0, 0, 0, 0];
    const m4 = new THREE.Matrix4(), sv = new THREE.Vector3();
    const range = 12;
    for (let dz = -range; dz <= range; dz++)
      for (let dx = -range; dx <= range; dx++) {
        const ix = cx + dx, iz = cz + dz;
        if (hash2(ix * 3 + 7, iz * 5 + 1) > 0.3) continue;
        const x = (ix + hash2(ix, iz * 7 + 3)) * this.cell, z = (iz + hash2(ix * 11 + 5, iz)) * this.cell;
        if (Math.hypot(x, z) < 26 || Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r * 2) continue;
        if (C && Math.hypot(x - C.x, z - C.z) < C.r) continue;
        const d = Math.hypot(x - focus.x, z - focus.z);
        if (d > range * this.cell) continue;
        const v = Math.floor(hash2(ix + 99, iz - 17) * 4);
        if (counts[v] >= 90) continue;
        const sc = 0.8 + hash2(ix - 5, iz + 9) * 0.6;
        m4.makeRotationY(hash2(ix * 2, iz * 3) * 6.28).scale(sv.set(sc, sc * (0.85 + 0.3 * hash2(iz, ix)), sc)).setPosition(x, terrainHeight(x, z) - 0.1, z);
        this.meshes[v].setMatrixAt(counts[v]++, m4);
      }
    this.meshes.forEach((m, i) => { m.count = counts[i]; m.instanceMatrix.needsUpdate = true; });
  }
}

// ---------------------------------------------------------------------------------------- dust
class Dust {
  constructor(max = 600) {
    this.max = max;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max).fill(99);
    this.life = new Float32Array(max).fill(1);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.uniforms = { uColor: { value: new THREE.Color(0.8, 0.66, 0.46) }, uScale: { value: 600 } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uScale / -mv.z; vA = aAlpha; }`,
      fragmentShader: `uniform vec3 uColor; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d)*4.0; float a = exp(-r*3.0) * vA; if (a < 0.003) discard; gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.i = 0;
    this.live = 0;
  }
  emit(p, dir, speed, n = 6, scale = 1) {
    for (let k = 0; k < n; k++) {
      const i = this.i;
      this.i = (this.i + 1) % this.max;
      this.pos[i * 3] = p.x + (Math.random() - 0.5) * 0.08 * scale;
      this.pos[i * 3 + 1] = p.y + 0.02;
      this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.08 * scale;
      const s = speed * (0.05 + Math.random() * 0.07);
      this.vel[i * 3] = -dir.x * s + (Math.random() - 0.5) * 0.8;
      this.vel[i * 3 + 1] = 0.3 + Math.random() * 0.7;
      this.vel[i * 3 + 2] = -dir.z * s + (Math.random() - 0.5) * 0.8;
      this.age[i] = 0;
      this.life[i] = 0.9 + Math.random() * 1.1;
    }
    this.live = 3;
  }
  update(dt, sunColor) {
    if (this.live <= 0) return;
    this.live -= dt;
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] > this.life[i]) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      const drag = Math.exp(-dt * 2.2);
      this.vel[i * 3] *= drag; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag - 0.25 * dt; this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = 0.12 + t * 0.55;
      this.alpha[i] = Math.sin(Math.PI * Math.min(1, t * 1.4)) * (1 - t) * 0.28;
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = a.aSize.needsUpdate = a.aAlpha.needsUpdate = true;
    if (sunColor) this.uniforms.uColor.value.setRGB(0.55 + 0.25 * sunColor.r, 0.45 + 0.25 * sunColor.g, 0.32 + 0.2 * sunColor.b);
  }
}

// ---------------------------------------------------------------------------------------- water rings
class Ripples {
  constructor(max = 48) {
    this.max = max;
    const g = new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2);
    // (uColor / uAlpha: the demo reel tones the rings down to its evening light)
    this.uniforms = { uColor: { value: new THREE.Color(0.85, 0.88, 0.86) }, uAlpha: { value: 0.35 } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `varying vec2 vUv; varying float vA; void main(){ vUv = uv; vA = instanceColor.r; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uAlpha; varying float vA; void main(){ gl_FragColor = vec4(uColor, vA * uAlpha); }`,
      transparent: true, depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(g, m, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.items = [];
    this.i = 0;
    this._m = new THREE.Matrix4();
    this._c = new THREE.Color();
    for (let i = 0; i < max; i++) { this.mesh.setColorAt(i, this._c.setRGB(0, 0, 0)); this.mesh.setMatrixAt(i, this._m.makeScale(0, 0, 0)); }
  }
  emit(p, size = 1) {
    this.items[this.i] = { x: p.x, z: p.z, t: 0, size };
    this.i = (this.i + 1) % this.max;
  }
  update(dt) {
    if (!this.items.length) return;
    for (let i = 0; i < this.max; i++) {
      const r = this.items[i];
      if (!r) continue;
      r.t += dt;
      const k = r.t / 1.6;
      const s = (0.08 + k * 0.9) * r.size;
      this._m.makeScale(s, 1, s).setPosition(r.x, WATER_LEVEL + 0.004, r.z);
      this.mesh.setMatrixAt(i, this._m);
      this.mesh.setColorAt(i, this._c.setRGB(Math.max(0, 1 - k), 0, 0));
      if (k >= 1) this.items[i] = null;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }
}
