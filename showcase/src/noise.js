// Integer-hash value noise with bit-identical JS and GLSL implementations, so the
// terrain the IK samples on the CPU matches the terrain the GPU renders.

export function hash2(ix, iy) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function vnoise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

export const NOISE_GLSL = /* glsl */ `
float nHash2(ivec2 p) {
  uint h = (uint(p.x) * 0x27d4eb2du) ^ (uint(p.y) * 0x165667b1u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h ^= h >> 13u;
  h *= 0xc2b2ae35u;
  h ^= h >> 16u;
  return float(h) * (1.0 / 4294967296.0);
}
float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  ivec2 ii = ivec2(i);
  float a = nHash2(ii), b = nHash2(ii + ivec2(1, 0)), c = nHash2(ii + ivec2(0, 1)), d = nHash2(ii + ivec2(1, 1));
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
`;


// Rolling terrain (cheetah savanna octaves). `detail` fades the small octaves with distance on the GPU.
export function baseHeight(x, z) {
  let h = 2.4 * (vnoise2(x * 0.0065, z * 0.0065) - 0.5);
  h += 0.9 * (vnoise2(x * 0.021 + 5.2, z * 0.021 + 1.3) - 0.5);
  h += 0.22 * (vnoise2(x * 0.085 + 9.1, z * 0.085 + 7.7) - 0.5);
  h += 0.05 * (vnoise2(x * 0.42 + 1.7, z * 0.42 + 3.3) - 0.5);
  return h;
}

// The lake: a basin carved into the rolling ground with a noisy shoreline. The same formula runs in
// GLSL (terrainGLSL below), so feet planted on the CPU land on the ground the GPU draws.
export const LAKE = { x: 15, z: 13, r: 10 };
export const LAKE_B0 = baseHeight(LAKE.x, LAKE.z);
export const WATER_LEVEL = LAKE_B0 - 0.42;
export const LAKE_DEEP = 2.4; // extra depth of the central basin (m)
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function lakeBasin(x, z) {
  const d = Math.hypot(x - LAKE.x, z - LAKE.z) + (vnoise2(x * 0.08 + 3.3, z * 0.08 + 8.1) - 0.5) * 6.0;
  return 1 - smooth(LAKE.r * 0.45, LAKE.r * 1.3, d);
}

export function nearLake(x, z) { return Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r * 1.75; }

export function terrainHeight(x, z) {
  const b = baseHeight(x, z);
  const k = lakeBasin(x, z);
  if (k <= 0) return b;
  // (a deep basin in the middle, ~3.2 m of water: a 4 m great white swims there; the shelf and the
  // shore line, k < 0.5, are unchanged)
  return b + (LAKE_B0 - b) * smooth(0, 0.6, k) - 1.25 * k - LAKE_DEEP * smooth(0.5, 1, k);
}

export const TERRAIN_GLSL = /* glsl */ `
${NOISE_GLSL}
const float LAKE_B0 = ${LAKE_B0.toFixed(7)};
const float WATER_LEVEL = ${WATER_LEVEL.toFixed(7)};
const float LAKE_DEEP = ${LAKE_DEEP.toFixed(3)};
const vec3 LAKE = vec3(${LAKE.x.toFixed(3)}, ${LAKE.z.toFixed(3)}, ${LAKE.r.toFixed(3)});
float lakeBasin(vec2 p) {
  float d = length(p - LAKE.xy) + (vnoise2(p * 0.08 + vec2(3.3, 8.1)) - 0.5) * 6.0;
  return 1.0 - smoothstep(LAKE.z * 0.45, LAKE.z * 1.3, d);
}
// 1 near the lake, 0 far away: shore colours and 'no grass under water' only apply here
float lakeMask(vec2 p) { return 1.0 - smoothstep(LAKE.z * 1.35, LAKE.z * 1.75, length(p - LAKE.xy)); }
float terrainHeight(vec2 p, float detail) {
  float h = 2.4 * (vnoise2(p * 0.0065) - 0.5);
  h += 0.9 * (vnoise2(p * 0.021 + vec2(5.2, 1.3)) - 0.5);
  h += 0.22 * (vnoise2(p * 0.085 + vec2(9.1, 7.7)) - 0.5) * detail;
  h += 0.05 * (vnoise2(p * 0.42 + vec2(1.7, 3.3)) - 0.5) * detail * detail;
  float k = lakeBasin(p);
  return h + (LAKE_B0 - h) * smoothstep(0.0, 0.6, k) - 1.25 * k - LAKE_DEEP * smoothstep(0.5, 1.0, k);
}
`;
