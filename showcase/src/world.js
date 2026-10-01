// The showcase world: terrain + lake + grass + props + sky, and the CPU-side queries the animals and
// the autopilot use (ground height, water surface, shore points, perches, obstacles).
import * as THREE from 'three';
import { terrainHeight, WATER_LEVEL, LAKE, nearLake } from './noise.js';
import { Terrain, Water } from './terrain.js';
import { Grass } from './grass.js';
import { Environment } from './environment.js';
import { Props } from './props.js';

export class World {
  constructor(renderer, scene, { grassNear = 90000, grassFar = 40000, shadowSize = 2048, envSize = 128, tod = 0.15 } = {}) {
    this.scene = scene;
    this.env = new Environment(renderer, scene, { shadowSize, envSize, tod });
    this.terrain = new Terrain();
    scene.add(this.terrain.mesh);
    this.water = new Water();
    scene.add(this.water.mesh);
    this.grass = new Grass({ near: grassNear, far: grassFar });
    scene.add(this.grass.group);
    this.props = new Props();
    scene.add(this.props.group);
    this.waterLevel = WATER_LEVEL;
    this.lake = LAKE;
    this.perches = this.props.perches;
    this.obstacles = this.props.obstacles;
    // the callbacks handed to createAnimal (world space, metres)
    this.ground = (x, z) => terrainHeight(x, z);
    this.waterAt = (x, z) => (nearLake(x, z) && terrainHeight(x, z) < WATER_LEVEL ? WATER_LEVEL : null);
  }

  normal(x, z) {
    const e = 0.25, h0 = terrainHeight(x, z);
    return new THREE.Vector3(h0 - terrainHeight(x + e, z), e, h0 - terrainHeight(x, z + e)).normalize();
  }

  depthAt(x, z) { return nearLake(x, z) ? Math.max(0, WATER_LEVEL - terrainHeight(x, z)) : 0; }

  isWater(x, z) { return nearLake(x, z) && terrainHeight(x, z) < WATER_LEVEL + 0.02; }

  // heading (radians) pointing away from the lake centre (or towards it, for swimmers)
  awayFromLake(p, towards = false) {
    const dx = p.x - LAKE.x, dz = p.z - LAKE.z;
    return towards ? Math.atan2(-dx, -dz) : Math.atan2(dx, dz);
  }

  // a point on the beach, between the animal and the lake, where the water is ankle deep; the beach
  // spot and the straight walk to it keep clear of rocks, logs and posts (the animal knows only the
  // ground height, not the props)
  shorePoint(from, info) {
    const dx = from.x - LAKE.x, dz = from.z - LAKE.z;
    const a0 = Math.atan2(dz, dx);
    const span = info?.span ?? info?.length ?? 1, back = 0.35 * (info?.scale || 1);
    let best = null, first = null;
    for (let k = 0; k < 13 && !best; k++) {
      const a = a0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.12;
      const ux = Math.cos(a), uz = Math.sin(a);
      for (let r = 0; r < LAKE.r * 2.2; r += 0.1) {
        const x = LAKE.x + ux * r, z = LAKE.z + uz * r;
        if (terrainHeight(x, z) > WATER_LEVEL + 0.03) {
          const p = new THREE.Vector3(x + ux * back, 0, z + uz * back);
          p.y = terrainHeight(p.x, p.z);
          if (!first) first = p;
          if (this.clearPath(from, p, 0.6 * span)) best = p;
          break;
        }
      }
    }
    return best || first;
  }

  // true when the segment a -> b (xz) keeps `pad` metres clear of every obstacle
  clearPath(a, b, pad = 0) {
    const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1e-9;
    for (const o of this.obstacles) {
      const t = Math.max(0, Math.min(1, ((o.x - a.x) * ex + (o.z - a.z) * ez) / L2));
      const px = a.x + ex * t - o.x, pz = a.z + ez * t - o.z;
      if (px * px + pz * pz < (o.r + pad) ** 2) return false;
    }
    return true;
  }

  nearestPerch(p) { return this.props.nearestPerch(p); }

  setWaterClarity(k) { this.water.uniforms.uClear.value = k; }

  // the nearest point of open water towards the lake centre (for swimmers' targets and spawns):
  // at least `minDepth` deep, at mid depth unless `y` is given
  wetPoint(p, minDepth = 0.25) {
    const q = new THREE.Vector3(p.x, 0, p.z);
    const dx = LAKE.x - p.x, dz = LAKE.z - p.z, L = Math.hypot(dx, dz) || 1;
    for (let t = 0; t <= L; t += 0.1) {
      q.set(p.x + (dx / L) * t, 0, p.z + (dz / L) * t);
      if (this.depthAt(q.x, q.z) >= minDepth) break;
    }
    const g = terrainHeight(q.x, q.z);
    q.y = Number.isFinite(p.y) && p.y > g && p.y < WATER_LEVEL ? p.y : (g + WATER_LEVEL) / 2;
    return q;
  }

  // start positions: swimmers in the lake, everyone else near the origin, clear of props
  spawnPoint(info, offset = new THREE.Vector3()) {
    if (info.swimmer) {
      const p = new THREE.Vector3(LAKE.x + offset.x * 0.5, WATER_LEVEL - 0.25 * (info.scale || 1), LAKE.z + offset.z * 0.5);
      return this.depthAt(p.x, p.z) > 0.3 ? p : this.wetPoint(p, 0.3);
    }
    const p = new THREE.Vector3(offset.x, 0, offset.z);
    p.y = terrainHeight(p.x, p.z);
    return p;
  }

  update(focus, dt, time, camera, push) {
    this.env.update(focus, dt, camera);
    this.terrain.update(focus);
    this.grass.update(focus, time, push, camera);
    this.water.update(time);
  }
}
