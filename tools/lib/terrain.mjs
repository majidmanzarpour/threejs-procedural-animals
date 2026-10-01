// Test grounds shared by the harness and the Node metrics. Heights scale with the animal's body
// scale S (leg length, metres) so a rat and a horse meet comparable unevenness.
//   flat   : y = 0
//   bumpy  : overlapping sine bumps, amplitude ~6 % of S, wavelengths ~1.5 - 4 S
//   slope  : bumpy on a 8 degree incline along +X (for death / lying on uneven ground)
export function makeGround(kind = 'flat', S = 0.8) {
  if (kind === 'flat' || !kind) return () => 0;
  const a = 0.06 * S, w = 1 / S;
  const bumps = (x, z) =>
    a * (0.55 * Math.sin(1.7 * w * x + 0.3) * Math.cos(1.3 * w * z - 0.7) +
      0.3 * Math.sin(3.1 * w * (x + 0.6 * z) + 1.1) +
      0.25 * Math.cos(2.3 * w * (z - 0.4 * x) + 2.0));
  if (kind === 'bumpy') return bumps;
  if (kind === 'slope') { const t = Math.tan((8 * Math.PI) / 180); return (x, z) => bumps(x, z) + t * x; }
  throw new Error(`unknown terrain "${kind}" (flat | bumpy | slope)`);
}
export const TERRAINS = ['flat', 'bumpy', 'slope'];

// Water for swimmers: a flat surface WATER_DEPTH x S above y = 0 (S = body scale; for a legless
// animal S = body length / 4, so the column is ~3 body lengths deep: room to cruise, leap and rest).
export const WATER_DEPTH = 12;
export function waterFor(plan, S) {
  if (plan !== 'swimmer') return null;
  const level = WATER_DEPTH * S;
  return () => level;
}
