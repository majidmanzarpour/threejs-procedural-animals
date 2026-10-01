// A few set pieces near the start: rocks, fallen logs, a dead tree and an old fence line. The tree's
// branches and the post tops are perch points for birds (exposed as `perches`).
import * as THREE from 'three';
import { terrainHeight, vnoise2, LAKE } from './noise.js';
import { mergeColored, colorize, limb } from './environment.js';

function rockGeometry(seed, r, flat) {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const p = g.attributes.position;
  const cols = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = vnoise2(x * 1.6 + seed, z * 1.6 + y * 1.3 - seed) * 0.5 + vnoise2(x * 4 + seed * 2, y * 4 + z * 3) * 0.18;
    const k = 0.72 + n;
    const yy = y < -0.2 ? -0.2 - (y + 0.2) * 0.3 : y;
    p.setXYZ(i, x * r * k, yy * r * flat * k, z * r * k * 1.1);
    const sh = 0.8 + 0.3 * n;
    const moss = Math.max(0, y) * vnoise2(x * 3 + seed, z * 3) * 0.6;
    cols[i * 3] = (0.16 - moss * 0.06) * sh; cols[i * 3 + 1] = (0.12 - moss * 0.005) * sh; cols[i * 3 + 2] = (0.085 - moss * 0.05) * sh;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

function logGeometry(len, rad, seed) {
  const bark = new THREE.Color(0.09, 0.065, 0.045);
  const parts = [];
  const g = new THREE.CylinderGeometry(rad, rad * 1.1, len, 12, 8, false);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + (vnoise2(Math.atan2(z, x) * 3 + seed, y * 2) - 0.5) * 0.25;
    p.setXYZ(i, x * n, y, z * n);
  }
  g.rotateZ(Math.PI / 2);
  parts.push(colorize(g, bark));
  parts.push(limb(new THREE.Vector3(len * 0.15, 0, 0), new THREE.Vector3(len * 0.3, rad * 3.5, rad * 1.2), rad * 0.35, rad * 0.12, bark, 6));
  return mergeColored(parts);
}

export class Props {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'props';
    this.perches = [];
    this.obstacles = [];
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
    const place = (g, x, z, rotY = 0, sink = 0.05, cast = true) => {
      const m = new THREE.Mesh(g, mat);
      m.position.set(x, terrainHeight(x, z) - sink, z);
      m.rotation.y = rotY;
      m.castShadow = cast;
      m.receiveShadow = true;
      this.group.add(m);
      return m;
    };
    // rocks
    const rocks = [[-4.5, 5, 0.55, 0.6], [-5.6, 5.9, 0.3, 0.7], [7, -5, 0.8, 0.5], [6.2, 5.4, 0.35, 0.8], [LAKE.x - 7.5, LAKE.z - 5.2, 0.6, 0.55], [LAKE.x + 3, LAKE.z - 8.5, 0.45, 0.6], [-9, -3, 1.1, 0.45], [12, -9, 0.5, 0.7], [-2, 13, 0.4, 0.65]];
    rocks.forEach(([x, z, r, f], i) => { place(rockGeometry(i * 3.7 + 1, r, f), x, z, i * 1.3, r * 0.25); this.obstacles.push({ x, z, r: r * 1.2 }); });
    // fallen logs
    place(logGeometry(3.2, 0.2, 2), -3, -6.5, 0.5, 0.06);
    this.obstacles.push({ x: -3, z: -6.5, r: 1.6 });
    place(logGeometry(2.4, 0.16, 5), LAKE.x - 9, LAKE.z + 4, 2.1, 0.05);
    this.obstacles.push({ x: LAKE.x - 9, z: LAKE.z + 4, r: 1.2 });

    // dead tree (perch)
    const tx = -7.5, tz = 9.5, ty = terrainHeight(tx, tz);
    const wood = new THREE.Color(0.13, 0.1, 0.08);
    const parts = [];
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const trunkTop = V(0.3, 3.1, -0.1);
    parts.push(limb(V(0, -0.3, 0), V(0.12, 1.6, 0), 0.24, 0.17, wood, 9));
    parts.push(limb(V(0.12, 1.6, 0), trunkTop, 0.17, 0.08, wood, 8));
    const branches = [
      [V(0.12, 1.55, 0), V(1.5, 2.15, 0.35), 0.1, 0.035],
      [V(0.2, 2.2, -0.05), V(-1.3, 2.65, 0.4), 0.08, 0.03],
      [V(0.25, 2.7, -0.1), V(0.7, 3.3, -1.1), 0.06, 0.025],
      [V(1.5, 2.15, 0.35), V(2.2, 2.5, 0.1), 0.035, 0.02],
    ];
    for (const [a, b, r0, r1] of branches) parts.push(limb(a, b, r0, r1, wood, 7));
    const tree = place(mergeColored(parts), tx, tz, 0, 0);
    tree.updateMatrixWorld();
    const perchOn = (a, b, t, kind) => {
      const p = a.clone().lerp(b, t);
      p.y += 0.03;
      this.perches.push({ position: p.applyMatrix4(tree.matrixWorld), kind });
    };
    perchOn(branches[0][0], branches[0][1], 0.7, 'branch');
    perchOn(branches[1][0], branches[1][1], 0.75, 'branch');
    perchOn(branches[2][0], branches[2][1], 0.8, 'branch');
    this.perches.push({ position: trunkTop.clone().applyMatrix4(tree.matrixWorld), kind: 'snag' });
    this.obstacles.push({ x: tx, z: tz, r: 0.6 });
    this.tree = { x: tx, y: ty, z: tz };

    // old fence posts along a line (perches + a bit of scale reference)
    const post = new THREE.Color(0.12, 0.085, 0.06);
    for (let i = 0; i < 6; i++) {
      const x = -14 + i * 2.6, z = -2 + i * 0.9 + Math.sin(i * 1.7) * 0.2;
      const h = 1.15 + Math.sin(i * 2.3) * 0.08;
      const g = colorize(new THREE.CylinderGeometry(0.06, 0.075, h + 0.3, 7), post);
      g.translate(0, (h + 0.3) / 2 - 0.3, 0);
      const m = place(g, x, z, 0, 0);
      m.rotation.z = Math.sin(i * 3.1) * 0.06;
      m.updateMatrixWorld();
      this.perches.push({ position: new THREE.Vector3(0, h + 0.01, 0).applyMatrix4(m.matrixWorld), kind: 'post' });
      this.obstacles.push({ x, z, r: 0.25 });
    }
  }

  nearestPerch(p) {
    let best = null, bd = Infinity;
    for (const q of this.perches) {
      const d = q.position.distanceToSquared(p);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }
}
