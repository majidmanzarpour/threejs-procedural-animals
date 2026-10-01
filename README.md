# three.js Procedural Animals

**[Live showcase](https://majidmanzarpour.github.io/threejs-procedural-animals/)** · [Repository](https://github.com/majidmanzarpour/threejs-procedural-animals) · <!-- demo video link -->

24 animals for three.js, generated entirely in code: no models, no textures, no animation clips.
Call `createAnimal('wolf')`, add it to your scene and steer it.

- **24 species, 6 body plans:** paws, hooves, birds, swimmers, snakes, spiders (plus hoppers). Breeds,
  coats and morphs, both sexes, young animals.
- **Built at runtime:** sculpted from signed distance fields, meshed, rigged, skinned
  (dual-quaternion), covered in fur, feathers or scales, and animated with IK gaits and actions.
- **Seeded individuals:** `seed` picks a repeatable animal with its own size, proportions and coat.
- **From close-ups to crowds:** five quality tiers, from `hero` (~120k vertices) to `crowd`
  (~6k vertices, one draw call).
- **Off the main thread:** builds run in Web Workers, or bake individuals offline for instant loading.

## Install

```sh
npm install procedural-animals three
# until it is published on npm:
npm install github:majidmanzarpour/threejs-procedural-animals three
```

three.js r160+ is the only (peer) dependency. Plain ES modules with TypeScript declarations.

## Quickstart

```js
import * as THREE from 'three';
import { createAnimal } from 'procedural-animals';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9c1e0);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 500);
camera.position.set(6, 3, 8);
const sun = new THREE.DirectionalLight(0xfff3e4, 2.7);
sun.position.set(6, 10, 4);
sun.castShadow = true;
scene.add(sun, new THREE.HemisphereLight(0xdde6f2, 0x5f5a52, 1.15));
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x77736a }));
floor.receiveShadow = true;
scene.add(floor);

async function main() {
  const wolf = await createAnimal('wolf', { seed: 3, quality: 'high' });
  scene.add(wolf.object); // don't move wolf.object yourself: the animal moves itself

  let last = performance.now();
  renderer.setAnimationLoop((now) => {
    const dt = (now - last) / 1000; // seconds
    last = now;
    wolf.move({ speed: wolf.gears.walk, heading: now / 1000 * 0.3 }); // m/s, radians
    wolf.update(dt); // once per frame
    camera.lookAt(wolf.position);
    renderer.render(scene, camera);
  });
}
main(); // no top-level await in the entry module (it can deadlock a Vite production build)
```

Then:

```js
wolf.moveTo(new THREE.Vector3(10, 0, 4), { speed: 3 }); // walk there, emits 'arrive'
wolf.follow(body.position, body.velocity);                // or follow your physics body, every frame
wolf.lookAt(player.position);                             // null to stop
await wolf.play('attack');                                // 'done' | 'interrupted' | 'stopped' | 'refused'
wolf.on('footstep', (e) => sfx.play('step', e.position, e.strength));
wolf.on('attackHit', (e) => damage(e.position, e.direction));
wolf.dispose();                                           // free GPU resources, remove from the scene
```

### Web Workers

`createAnimal` builds in module workers by default and falls back to the calling thread where
`Worker` doesn't exist. With **Vite**:

```js
// vite.config.js
export default {
  worker: { format: 'es' },
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['procedural-animals'] },
};
```

webpack 5 and Parcel 2 need no setup. For other bundlers, bundle the worker yourself and install it:

```sh
npx esbuild node_modules/procedural-animals/src/worker.js --bundle --format=iife --minify --outfile=public/animal-worker.js
```

```js
import { setWorkerFactory } from 'procedural-animals';
setWorkerFactory(() => new Worker('/animal-worker.js'));
```

`createAnimal(id, { worker: false })` builds on the calling thread (blocks for the build time).

### Baking (instant loading)

A build takes 0.4-6 s. Bake individuals ahead of time into `.animal` files and load them in ~20 ms:

```sh
npx procedural-animals-bake wolf --seed 3 --quality high -o public/wolf-3.animal
```

```js
const wolf = await createAnimal('wolf', { baked: fetch('/wolf-3.animal').then((r) => r.arrayBuffer()) });
```

## API

```js
import { createAnimal, listSpecies, loadSpecies, setWorkerFactory, clearBuildCache, QUALITY } from 'procedural-animals';
```

**`createAnimal(species, options)`** (every option is optional)

| option | default | meaning |
| --- | --- | --- |
| `seed` | `1` | the individual (size, proportions, coat; sex, age and variant unless given) |
| `quality` | `'high'` | `'hero' \| 'high' \| 'medium' \| 'low' \| 'crowd'` |
| `variant`, `sex`, `age` | by seed | breed / coat / morph; `'male' \| 'female'`; `'adult' \| 'juvenile'` |
| `ground` | `() => 0` | `(x, z) => y` terrain height, in the space of `animal.object.parent` |
| `water` | none | `(x, z) => y \| null` water surface (swimmers need it; land animals drink and wade) |
| `perches` | `[]` | `Vector3[]` points birds can fly to |
| `position`, `heading` | origin, `0` | start pose (heading in radians, `0` faces +Z) |
| `baked` | none | an `ArrayBuffer` (or a Promise of one) from a `.animal` file |
| `worker` | `true` | `false` builds on this thread |
| `castShadow`, `receiveShadow` | `true` | |

**The animal**

| member | meaning |
| --- | --- |
| `object` | the `Object3D` to add to your scene (keep its transform at identity) |
| `update(dt)` | advance `dt` seconds; call once per frame |
| `move({ speed, heading })`, `stop()`, `moveTo(point, { speed })`, `follow(pos, vel)` | locomotion; the animal picks its gait |
| `lookAt(target)` | track a `Vector3` with the head |
| `play(action, opts)`, `stopAction(name)` | actions; `play` returns a Promise |
| `on(event, fn)`, `off(event, fn)` | events: `footstep`, `attackHit`, `actionStart`, `actionEnd`, `arrive`, `takeoff`, `land`, `death`, `vocalize`, `wingbeat` |
| `setQuality(tier)`, `setLod(0 \| 1 \| 2)` | coat detail on the existing mesh; motion detail for crowds |
| `setDebug(mode, on)`, `setCoverings(on)` | `'albedo' \| 'weights' \| 'material' \| 'bare'`; fur shells on/off |
| `position`, `heading`, `speed`, `velocity`, `state` | current motion state (read only) |
| `gears`, `gaits`, `actions` | this individual's named speeds (m/s), gaits and actions |
| `attachments` | `mouth`, `head`, `back` (+ bird feet, horse `seat` / stirrups / bits) to parent props to |
| `dispose()` | free everything |

**Actions:** every species has `jump`, `sit`, `lie`, `sleep`, `eat`, `drink`, `attack`, `hit`,
`death` and `stand`. Birds add `takeoff`, `land`, `perch`, `glide`, `flap`; swimmers `burst`;
snakes `coil`, `strike`; hoppers `hop`; many species add their own (see below).

**Quality tiers**

| tier | vertices | use |
| --- | ---: | --- |
| `hero` | 110-130k | cinematic close-ups |
| `high` | 65-80k | the player's animal (default) |
| `medium` | 25-32k | mid distance, phones |
| `low` | 11-15k | herds of 10-20 |
| `crowd` | 5-8k | crowds of 100 (with `setLod(2)`), one draw call |

Builds are cached by species, seed, quality and variant, so a herd of 100 from 6 seeds builds 6 times.
CPU cost is ~0.1 ms per animal per frame.

The complete reference (every option, event payload, state field and recipe) is in
[llms.txt](llms.txt), and the types are in [src/index.d.ts](src/index.d.ts).

## Species

| id | plan | variants | extra actions |
| --- | --- | --- | --- |
| `wolf` | paws | grey, black, pale, tawny | snarl / howl body language |
| `dog` | paws | shepherd, retriever, terrier | greet, playbow, sniff, dig |
| `fox` | paws | red, cross, silver, urban | pounce, listen |
| `cat` | paws | mackerel, classic, ginger, black, tuxedo, calico, grey | loaf, groom, knead, stalk, slowblink |
| `lion` | paws | tawny, white | roar, yawn |
| `cheetah` | paws | | sprint gait |
| `bear` | paws | eurasian, grizzly, coastal, black | standup, sniff, dig |
| `rat` | paws | wild, agouti, dark, albino, hooded | rear, groom, scurry, box |
| `rabbit` | hopper | wild, domestic, fawn, black, white, dutch, lop, ... | hop, binky, groom, periscope, thump, flee |
| `horse` | hooves | bay, darkbay, chestnut, black, grey, palomino, dun, buckskin | rideable (`seat`, stirrups) |
| `deer` | hooves | summer, winter | stomp, alert, flee |
| `cow` | hooves | holstein, hereford, angus, jersey, highland | lick, chew, moo, swish, shake |
| `pig` | hooves | largewhite, landrace, duroc, hampshire, berkshire, spotted | wallow, grunt, sniff, root, frolic |
| `sheep` | hooves | whiteface, suffolk, merino, black, shorn | alert, bleat, headshake, stamp, pronk |
| `goat` | hooves | saanen, alpine, pied, nubian, boer | browse, bleat, headshake, paw |
| `boar` | hooves | adult, yearling, piglet | sniff, grunt, headshake |
| `frog` | hopper | bullfrog, bullfrog-pale, common-frog | hop, croak, blink |
| `chicken` | bird | red, leghorn, australorp, barred, buff, speckled | rooster, chick |
| `crow` | bird | american, carrion, hooded | |
| `eagle` | bird | bald, golden | |
| `fish` | swimmer | trout, goldfish, clownfish, bluegill | burst |
| `shark` | swimmer | white, blacktip | burst |
| `snake` | snake | corn, rattlesnake | coil, strike |
| `spider` | spider | wolf, tarantula | |

Import one species directly to bundle only it: `import wolf from 'procedural-animals/species/wolf'`
and `createAnimal(wolf, { seed: 3 })`. String ids load species on demand.

## For AI agents

Read [llms.txt](llms.txt) (complete, dense reference) and [src/index.d.ts](src/index.d.ts). The contract:

1. `const a = await createAnimal(id, { seed, quality, ground, position, heading })` inside an `async` function
2. `scene.add(a.object)` and never transform `a.object` yourself
3. steer with `a.move({ speed, heading })`, `a.moveTo(point)` or `a.follow(pos, vel)` every frame
4. `a.play(action)` for actions
5. `a.update(dt)` once per frame with `dt` in **seconds**; `a.dispose()` when done

Units: metres, seconds, radians, +Y up, heading `0` faces +Z (`Math.atan2(dx, dz)` faces a point).
Read speeds from `a.gears` (names differ per species). `ground` must match the terrain you draw.
Swimmers need `water` and a start position below the surface.

## Showcase

The [live showcase](https://majidmanzarpour.github.io/threejs-procedural-animals/) shows every
species, variant and action, with debug views (skeleton, IK, SDF primitives, skin weights) and a
"use in your game" panel that writes the code for the animal on screen. Add `?demo` for the
two-minute reel.

```sh
npm install
npm run build:showcase   # dist/showcase.html
npm run build:pages      # dist/pages/, deployed to GitHub Pages by .github/workflows/pages.yml
node showcase/record.mjs # render the demo reel to MP4 (needs Chromium and ffmpeg)
```

## Contributing

[docs/AUTHORING.md](docs/AUTHORING.md) explains how a species is built and checked.

```sh
npm test                                   # every species builds, moves and plays every action
node tools/metrics.mjs <id> --seeds 1-4    # motion, skin and performance checks (tools/thresholds.json)
node tools/render.mjs <id> --views turntable,gaits,face,actions
node tools/compare.mjs <id>                # renders beside your local reference photos
```

The browser tools need Chromium (`npx playwright-core install chromium`).

## License

MIT. See [LICENSE](LICENSE).
