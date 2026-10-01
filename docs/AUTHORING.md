# Adding a species

A species is mostly data in its own folder. You describe a skeleton, sculpt a body out of signed
distance field (SDF) primitives, paint a coat, and fill in motion tables. The core does the
meshing, skin weights, dual-quaternion skinning, fur and other coverings, eyes, IK, gaits and
actions. The cheetah (`src/species/cheetah/`) is the worked example and sets the quality bar. Read it
alongside this guide.

The README covers the public API; this guide covers how a species is built and checked (§9).

## 1. Folder layout

```
src/species/<id>/
  index.js        the species module (default export): metadata, variation, and wiring
  rig.js          joints + bones (reference individual, bind pose)
  sculpt.js       SDF primitives
  regions.js      meshing plan (cell sizes, overlapping regions, rigid jaw)
  coat.js         per-vertex colours, patterns, fur length and flow
  motion.js       gait table and action tuning for the body plan's engine
```

Register the loader in `src/registry.js` (`<id>: () => import('./species/<id>/index.js')`) and add
the id to `SpeciesId` in `src/index.d.ts`. Keep a species change inside its folder plus those two
lines. Core changes (`src/core/`) affect every species: send them as a separate pull request and run
the metrics on the species they touch.

## 2. Coordinates and scale

Metres, bind pose standing on y = 0, facing +Z, left = +X. Model the **reference individual**
(an average adult, usually female or unsexed) at its real size. Seeded variation (size, proportions,
sex, age) comes later through `variation()`. The core scales motion by dynamic similarity, so you
never write separate tables for big and small individuals.

`rig.unit` is the animal's characteristic length relative to the cheetah (shoulder height / 0.76 m,
or body length / 1.3 m for legless animals). The core multiplies its internal distances by it
(skin-weight blend widths, axial softening), so a rat (unit ~0.1) and a horse (unit ~2.1) both
skin well. Set it correctly.

## 3. Skeleton (`rig.js`)

Use `buildRig()` from `core/rig/rig.js`. Joints are given for the left side only (`...L`), and the
right side is mirrored. Bones are `[name, headJoint, tailJoint, parent, { region, group }]`, with
`{S}` expanding to L and R.

Quadrupeds (paws and hooves, rabbit, frog): use `quadrupedBones()` and `quadrupedLimbs()` from
`core/rig/quadruped.js`. The quadruped engine expects exactly those names: nose, occiput, neckMid,
neckBase, chestMid, thoraxRear, lumbarMid, lumbosacral, tailBase, scapTop / shoulder / elbow / wrist
/ mcp / ftoe, hip / knee / hock / mtp / htoe, jawHinge / jawTip, earBase / earTip, tail0..N. Hoofed
animals use the same names: metacarpus = front cannon, fpaw = pastern + hoof, and likewise at the
hind. Tail length is free (`tailChain()` builds tail0..N from pitch angles and lengths). Set the
tail segment count to what the tail needs to bend smoothly (cheetah 10, dog 8, horse 6 dock bones,
pig 4, bear 2).

Other body plans (bird, swimmer, snake, spider) have their own bone conventions, documented at the
top of their engine in `core/motion/<plan>.js`.

The `axial` chain (nose → tail tip) drives the spine, neck and tail skin weights; list its joints
and the bones between them. `limbs` sets up the harmonic limb blend fields. Start from the
cheetah's numbers:
- front `{ tCore: 0.55, aCore: 0.04, aBody: -0.07 }`;
- hind `{ tCore: 0.52, aCore: 0.022, aBody: -0.045, midX: 0.008 }`.

`appendages` are rigidly skinned parts blended by SDF distance (ears, horns if they are part of
the skin). `webTags` lists primitive tags that span limb and body (flank fold, thigh front, scapular
muscle) and so must never anchor the limb core.

Get the proportions from measurements: shoulder height, body length, limb segment lengths, head
length. Cite the source in a comment next to each number. Check the bind pose in a side view against the side
reference photo (see §9) **before** sculpting.

## 4. Sculpt (`sculpt.js`)

`sculpt(model, rig, params)` adds primitives to an `SDFModel`:
- `m.ell({ c, r: [rx, ry, rz], axis, up, bone, group, part, tag, k, carve, bias, thin })`: ellipsoid.
- `m.sphere({ c, rad, ... })`, and `m.cone({ a, b, ra, rb, ... })`, a round cone (tapered capsule).
- `m.lens({...})`: almond aperture (eyelids); use `sculptEyeSocket()` from `core/sdf/eyeSocket.js`.

Every primitive needs `bone` (skinning) and `group`: 'axial', a limb id ('FL', ...), or an
appendage group ('earL'). `part` selects the surface it belongs to: 'body', or 'jaw' for a
separately meshed lower jaw. `k` is the smooth-union blend radius, and 0 gives a hard union.
`carve: true` subtracts (nostrils, ear cups, mouth). `tag` names the part for the coat painter and
the weights. `thin: true` marks thin parts (ears, fins, tail tips) that the core inflates at coarse
quality tiers so they don't vanish.

Lessons from the cheetah:
- **Sculpt relative to joints** (`lerp(J.shoulderL, J.elbowL, 0.4)`), not absolute numbers, so the
  sculpt follows the skeleton.
- **Muscles make the silhouette.** The shoulder, triceps, thigh and hamstring masses and the flank
  fold are separate ellipsoids with generous `k`. A leg made of one cone per bone looks like a
  mannequin.
- **Webs:** blend limbs into the body over a wide region (flank fold, thigh front, scapular muscle,
  `k` 0.05-0.06). Otherwise patterns tear at the hips and shoulders when the leg swings.
- **Head:** model it in head-local coordinates (`HEAD_O`), measured from profile and frontal
  photos: nose tip, eye centres, chin, skull top, occiput. Put the eyes in sockets with lids
  (`sculptEyeSocket`). Give the lower jaw its own part so the mouth can open. Carve nostrils. Match
  the lip line to the photos.
- **Feet:** separate toes and pads (paws), or a hoof cone with a coronet band and dew claws (hooves).
- Keep the primitive count sane (the cheetah uses 128).

## 5. Meshing plan (`regions.js`)

`regions(rig, params, Q)` returns `{ jobs, fade }`. Each job runs in its own worker. `Q.res`
multiplies every cell size (quality tier), and `Q.eyePatches` says whether to add fine eyelid
patches. Copy the cheetah's structure:
- body at ~0.7 % of shoulder height (cheetah 5.4 mm);
- head at about half that, overlapping the body across the upper neck and cross-faded by `fade()`;
- eyelid patches at ~1 mm (scaled by size);
- the jaw as a rigid region.

Budgets per tier (vertices): hero ≤ 130k, high ≤ 80k, medium ≤ 32k, low ≤ 15k, crowd ≤ 8k. Tune the
cell sizes to your animal's size to land inside them.

## 6. Coat (`coat.js`)

`coat(ctx)` gets the finished reference-space mesh: `pos`, `nrm`, `index`, `lists` (the SDF
primitives near each vertex), `regionOf`/`regionNames`, `weights` (`dominant`, `axialS`, `segT`,
`limbMember`, `limbWhich`, `neighbors`, `axialLengths`), `rig`, `params`, `rng` and `model`. It
returns, per vertex:
- `comb`: flow direction;
- `tint`: rgb + material id;
- `pattern`: SDF, < 0 inside;
- `patternColor`: rgb + intensity;
- `mark`: crisp lines, drawn in `species.render.markColor`;
- `furLen`: metres;
- `surf`: gloss, feature size, agouti, undercoat/iridescence.

Material ids (`MAT` in `core/build/coatKit.js`):

| id | material | used for |
| --- | --- | --- |
| 0 | FUR | |
| 1 | NOSE | nose leather |
| 2 | DARK_SKIN | lids, lips |
| 3 | MOUTH | |
| 4 | SKIN | pig, rat tail, bird legs if not scaled |
| 5 | KERATIN | hoof, horn, beak, claw |
| 6 | SCALES | |
| 7 | WET_SKIN | frog |
| 8 | CHITIN | |
| 9 | FEATHER | contour shingles on the body |

Helpers in `coatKit.js`: `srgb(0xRRGGBB)` gives linear rgb, and there are `mix3`, `poissonFeatures`
+ `featureDistance` (spots and rosettes grown on the real surface), `projectToSurface`,
`distPolyline` (tear lines, stripes along a path) and `smoothField`.

What reads as the real thing:
- **Colours:** sample them from several reference photos in neutral light and keep the hex values in
  `coat.js`, noting where they came from. Real coats are desaturated; photos under warm light lie.
- **Countershading:** dark dorsal, light ventral, blended by normal and height, never a hard line.
- **Flow (`comb`):** follows the animal's hair tracts. Hair runs nose → tail along the body, down
  the legs, and outward from the nose on the face; whorls where tracts meet.
- **Fur length by region:** short on the face and lower legs, longer on the neck ruff, belly fringe,
  back of the thighs and tail. A mane or wool is just long `furLen` plus clumping.
- **Patterns** stay crisp through the SDF: spots, stripes, patches (piebald dogs, Holstein cows,
  pinto horses) and sharp marks (eye rims, tear lines, lips, nose edges).
- **Low-frequency colour noise** (fbm) breaks up flat areas.
- **No fur walls:** the pipeline shortens hair that rises faster than 1 mm per mm of skin above the hair
  around it (long hair over 25 mm may rise faster: manes and ruffs keep a bevel), so a 5 -> 11 mm switch
  across a plane no longer stands up as a pad with a hard rim. Paint lengths with smooth transitions
  anyway; to keep a crest standing as painted, return `furSlope` (per vertex, Infinity there) from
  `coat()`. The metrics' `fur walls` line shows what is left.

Seeded variation re-seeds pattern layouts and shifts colours within the real range of the species,
breed or morph.

## 7. Eyes

`eyeSpecs(params, rig)` returns one entry per eye: `{ side, spec, headOrigin, bone: 'head', look }`.
`spec` is the geometry (see `core/sdf/eyeSocket.js`). `look` covers:
- `pupil`: 'round' (dogs, wolves, bears, birds, most fish), 'slit' (vertical: cats, foxes, many
  snakes) or 'bar' (horizontal: horse, goat, sheep, deer, cow, frog);
- `pupilSize`: [min, max] as a fraction of the iris radius;
- `iris`: `{ inner, mid, hi, outer }` linear rgb;
- `sclera`: `{ color, visible }`;
- `lids`: 'mammal', 'bird' (nictitating membrane), 'none' (fish, snake) or 'simple' (spider);
- `lidColor`.

Measure eye size and placement from face photos. Wrong eyes kill a face faster than anything else.

- **Depth:** the eyeball's front must sit at the skin: where the head surface without the eye
  primitives crosses the eye axis should be <= 1.3 r from the eye centre. Deeper (brow, cheek and fat
  pads in front of the ball), the lids are buried and the aperture becomes a tunnel; if its mouth barely
  reaches the skin it meshes into a ragged hole (the pig's). Move the eye out along its axis or thin
  what stands in front.
- **Roll:** set `tilt` with `apertureTiltAlong(EYE, HEAD_O, HZ)` (plus a small roll of your own) rather
  than a search: the frame's y is the upper lid (blinks, lashes, the lid shading), and a search over a
  limited range can stand the almond on end.
- **Eyelid patch:** its inner radius (R - B) must contain the aperture rim at the skin plus the lid
  margin your coat paints (lashes), or the coarse face mesh draws part of it in steps. Keep the
  cross-fade band B at least a face cell wide.
- **Check:** the metrics' `eyes:` line, and `node tools/render.mjs <id> --views eyes --quality hero`.

## 8. Motion (`motion.js`)

Fill in the schema documented at the top of your plan's engine. For quadrupeds that's
`core/motion/quadruped.js` for locomotion and `core/motion/actions.js` for action tuning.

- **gaits:** one row per (gait, speed), sorted by speed, taken from your research: stride frequency,
  duty factor, footfall offsets [FL, FR, HL, HR] relative to HL touchdown, swing heights, body
  bounce, spine flexion. Use real transition speeds. A horse walks, trots, canters and gallops; a
  bear avoids trotting; a rabbit half-bounds with its hind feet together.
- **feet:** 'digitigrade', 'unguligrade' (hooves) or 'plantigrade' (bear, rat hind), plus contact
  and curl.
- **head:** carriage by speed. Grazers must reach the ground.
- **tail:** carriage table by speed plus behaviours: `wag` (dog), `swish` (horse, cow), `flick`
  (cat), `curl` (pig).
- **ears:** mobility, how they flatten, prick toward sounds or a target.
- **actions:** attack style ('bite-lunge', 'pounce', 'charge', 'headbutt', 'kick'), eat style
  ('graze' or 'tear'), jump height and distance, sleep style ('curl' or 'lateral'), and pose
  overrides.

Watch real footage descriptions (and the Muybridge plates where they exist) for signature
behaviours and make sure the tuning shows them: a dog's wag and play bow, a
cat's tail question mark, a horse's tail swish and ear pinning, a pig's snout rooting while eating,
a goat's rearing headbutt.

## 8a. Quadrupeds in depth (paws, hooves, hoppers)

Worked examples: `cheetah` (digitigrade runner, the reference), `wolf` (trotter, body-language
hook), `horse` (hooves, kneeling, riding attachments, behaviour hook), `rabbit` (hopper: plantRest
hind feet, its own hop / jump / groom / periscope actions). Everything below is data in
`species.motion` unless it says hook; the full schema is at the top of `core/motion/quadruped.js`
and `core/motion/actions.js`.

### Scale: `motion.unit`

Species tables (gaits, head carriage, tail radius, body sections, attachment offsets, jump height)
are in **your species' metres at its reference size**; the engine multiplies them by the
individual's `size`. The engine's own constants (clearances, re-step distances, posture offsets
such as `P.fwd` or `P.headRaise`, the timing of its built-in actions) were tuned on the cheetah and
are multiplied by `cfg.k = size x unit`, with `unit` = your reference leg length / the cheetah's.
The engine measures it from the bind skeleton (shoulder -> mcp and hip -> mtp chains / 0.5995 m);
set `motion.unit` only to override (the cheetah sets 1). Horse ~1.9, wolf ~0.92, rabbit 0.3.
Engine speeds that are compared with its own constants use `v / sqrt(k)`; your tables are indexed by
`v / sqrt(size)`.

### Species hooks: `motion.hooks = { actions, update, pose }`

The one place a species adds behaviour. All three are optional; the contract is documented in the
"Species hooks" section of `core/motion/actions.js`.

- `actions: { name: def }` adds actions (the rabbit's `hop`, `binky`, `groom`, `periscope`, `thump`,
  `flee`) or replaces built-ins of the same name (the rabbit's boxing `attack`, its loaf `sleep`).
  `def = { kind: 'oneshot' | 'posture', start, update, apply, onLand?, fade?, fadeIn?, fadeOut?,
  airborne?, needsStand? }`. `airborne: true` for anything that calls `engine.takeOff(vy, vh)`;
  `needsStand: true` makes a sitting animal stand up first. `ONESHOTS` / `POSTURES` are exported so
  you can wrap a built-in (the rabbit's `hit` wraps `ONESHOTS.hit`, its `sleep` calls
  `POSTURES.lie.apply`). New names appear in `animal.actions` and the metrics play them.
- `update(P, dt, layer)` runs every frame after the built-in actions filled the posture parameters
  `P`: body language and style (wolf: tail by mood, hackles `P.furRaise`, snarl, howl idle variant;
  horse: walk head nod, dozing on three legs, fly-swish bursts; rabbit: the crouch that opens up
  when hopping, idle variants that `layer.play()` its own actions, zig-zag steering via
  `engine.wantHeading`). Use `mx(P, key, value, w)` to blend. `P` lengths (`fwd`, `side`, `lift`,
  `headRaise`, `neckReach`) are in engine units (x `cfg.k`): divide by `cfg.unit` to mean your
  species' metres. World points (`P.headPos`, `P.legs[i].target`) are metres.
- `pose(engine, dt)` runs after every bone is written: direct bone edits (the rabbit's snout twitch
  and independent ear swivels). Bones the engine does not know (a `snout`, a dewlap) follow their
  parent rigidly before `pose` runs. Keep it cheap: it runs for every animal of a crowd (exit early
  when there is nothing to do; `engine.lod === 2` is the crowd tier).

### Feet

| knob (`feet.front` / `feet.hind`) | what | examples |
| --- | --- | --- |
| `type` | 'digitigrade', 'unguligrade', 'plantigrade' | cheetah, horse, bear hind |
| `contact` | where the ground contact lies from the foot's back point to the toe | hooves 0.95 |
| `curl` | swing toe curl / hoof flip (deg) | paws 55-65, hooves 70 |
| `flex` | stance carpal flex (deg) | |
| `couple` | share of the toe curl the metacarpus follows (0.6 paws, 0.2 hooves) | |
| `sink` | fetlock sink under load (deg, hooves): comes back up by itself where the leg cannot reach | horse 20 / 16 |
| `hoofFlex` | extra coffin-joint flexion in swing (deg, needs a hoof bone) | horse 25 |
| `swingBack` | the swing path bows back mid-swing (m): long cannons trail behind the knee | horse front 0.25 |
| `heelStrike` | toe-up at touchdown (deg, plantigrade) | bear |
| `retract` | 0..1 swing retraction: the foot meets the ground at ~zero ground speed (2-3 frame stances) | rabbit 0.8 |
| `plantRest` (hind) | metatarsus flat on the ground at rest and in postures, on the toes in motion; the hock stays at its bind height over bumps | rabbit, rodents |
| `elbowDown` (front) | tilts the elbow pole down so a paw raised to the face keeps its elbow below | rabbit 0.4 |
| `lead`, `liftBehind`, `reach` | landing lead, early lift-off, IK reach (leg lengths) | rabbit front lead 0.15 |

**Hooves.** Give each leg a hoof bone below the pastern: joints `fcoffin{S}` / `hcoffin{S}` (the
coffin joint), bones `fpaw{S}` = pastern (fetlock -> coffin joint, region 'limb') and `fhoof{S}` /
`hhoof{S}` = hoof (coffin joint -> toe, region 'foot'); add the hoof bones to the limb's `bones` and
`distal` lists (see `species/horse/rig.js`: `horseBones()` and `horseRig()`). The engine finds them
by name: the hoof stays flat while the fetlock sinks about the coffin joint, breakover rolls the
whole digit about the toe, the hoof flips in swing, the crowd LOD extrapolates the extra joint. A
horse kneels to lie down with `actions.fold.front = { z, k, beta }` (hoof at zS + z leg lengths,
cannon angle k, hoof flip beta) and `actions.lie = { down: 'front', up: 'front' }` (which end goes
down / gets up first; cattle: down 'front', up 'hind'). A long head that already hangs nose-down in
the bind pose grazes with `actions.eat.pitch` (horse 0.88 rad instead of 1.3), and a long-legged
jumper lands on straight legs: `actions.jump.land = [front, hind]` (horse [0.08, 0.12]).

**Hoppers.** Hind feet landing together: same offset for HL and HR in every gait row. The back
flexes in every hop: `flexBlend: [0.3, 1.5]`. Ears go back at the species' own speeds:
`ears.flattenSpeeds`. A crouched resting stance: `actions.idle = { shift: 0.35, restep: false }`.
Running hops and jumps are species actions (`airborne: true`) with scripted world-space foot paths;
keep swinging feet out of the girdle (`smin(y, girdle - 0.55 leg, ...)`, see the rabbit's
`pathAt`) or the leg chain flips through its minimum length. A short neck on long legs (wolf)
reaches the food further ahead: `actions.eat.ahead` (leg lengths ahead of the forefeet, 0.5).

**Torso sections** (`motion.body`): measure them on your mesh (the half width includes the thigh
muscles a body lying on its side rests on; a short script over `data.pos` can measure the bind mesh
at the girdles). Too narrow and a dead or sleeping body sinks into the ground. Tail `radius`
includes the coat (a wolf's brush, a horse's hair).

**Sprint scuff.** `stance.scuff` makes planted paws slide at sprint speed; it is off (amount 0) for
every species now that the engine plants exactly at any speed. Leave it at 0.

### Riding and props: `motion.attachments`

`attachments: { name: { bone, from, to?, t?, offset? } }` adds attachment points at
`lerp(joint from, joint to, t) + offset` (m at the reference size, x = the animal's left), riding on
`bone`. They appear as `animal.attachments[name]` (THREE.Object3D, world matrix updated every frame)
next to the built-in `mouth`, `head`, `back`. The horse defines `back`, `seat` (rider's seat),
`stirrupL/R` and `bitL/R`.

### Skin around the head and neck

The poll (head vs neck2) opens by 60-110 degrees when an animal grazes, sleeps or lies dead, and the
throat under the jaw is far from the axis, so it stretches most. An axial blend override may take a
third value: `blend: { 1: [a, b, lever] }` widens the occiput blend by `lever x` the skin's depth
on the ventral side of the axis (horse 3.5, wolf 2). Check `head+neck2` in the metrics' stretch
clusters before and after. A lever long enough to reach past the next joint (neckMid) is cut there by default: the skull's
share drops to 0 across a line, and a coarse neck creases along it when the head drops or turns (the sheep's
jagged crack in its neck wool). `axial.cascade: { 1: 0.07 }` fades it out over 7 cm (x unit) past that joint
instead (`weights.js`); it spreads the stretch, so check the stretch clusters again. A tail that hangs down behind the thighs or buttocks (horse dock, wolf
brush): set `axial.bodyTail: 0` so body skin blends into the tail only across the tail base (default
1: up to the tail1 joint); tail skin itself never takes limb weights.

## 9. Checks: what "done" means

Run these from the repo root. All tools print PASS/FAIL, and their output goes to `out/`, which is
gitignored.

1. `npm test -- <id>`: builds, runs every action, bake round trip, no NaN.
2. `node tools/metrics.mjs <id>`: every threshold in `tools/thresholds.json` must pass (they were
   set on the cheetah):
   - no joint pops or jitter in any gait or action;
   - stance feet don't slide;
   - patterns don't stretch at the joints;
   - within performance budgets.

   Fix the cause and never loosen a threshold. If you believe a threshold is wrong for your animal,
   explain why in the pull request.
3. `node tools/render.mjs <id> --views turntable,gaits,face,actions,tiers`: look at every sheet.
4. `node tools/compare.mjs <id>`: renders next to your reference photos from matching angles. Add
   `facing` and `bbox` to the entries of `<refcache>/<id>/index.json` for exact framing (see §10). Iterate until the
   silhouette, proportions, colours and face match. Check the silhouette overlay; a 5 % error in leg
   length or head size is visible.
5. Test in the real showcase (`npm run build:showcase`, open `dist/showcase.html`; `node
   showcase/smoke.mjs` and `node showcase/test.mjs` script it): pick your species, play every action,
   every gait, and crowd mode. The showcase is what users see, so test-harness renders are not
   enough: a species has lost all its fur in the live page while the test renders looked fine.
6. Seeded variation: render 6 seeds side by side (the render tool's turntable with `--seed`). A
   herd must not look cloned, and every individual must still look like the species.

Pull requests that add or change a species are reviewed against the same renders, photos and
metrics: include the metrics summary and the contact sheets you looked at.

## 10. Reference photos

Photos stay out of the repo. Keep them in a local cache outside the repository:
`$PROCEDURAL_ANIMALS_REFCACHE/<id>/` (default `../procedural-animals-refcache/<id>/`, next to your
checkout), with an `index.json` that `tools/compare.mjs` reads:

```json
[{ "file": "side1.jpg", "source": "https://...",   // where the photo came from, so anyone can rebuild the cache
   "view": "side|front|three-quarter|face|gait",
   "facing": "left|right",                           // where the head points in the photo
   "bbox": [x0, y0, x1, y1],                         // the animal's box in pixels (enables exact framing)
   "camera": { "azimuth": -70, "elevation": 0, "fov": 20 } }]   // optional override
```

The compare sheet shows `render | photo | photo with the render silhouette in red` in
`out/compare/<id>/`. Everything committed must be original work.

For compare sheets of poses other than standing, an index entry may add `"variant"` (build that
variant), `"action"` + `"settle"` (play and hold a pose, e.g. `"coil"`) and `"look"` ([forward, up,
left] in units of S: a look target held while rendering, e.g. a snake raising its head).

## 11. Body plan: bird

The crow (`src/species/crow/`) is the worked example; `core/motion/bird.js` documents the full
`species.motion` schema at the top and covers walkers/hoppers (crow), ground birds (chicken: set
`flight.sustained: false`, short `maxTime`, a head-bob gait) and soaring raptors (eagle: high
`glideShare`, `soar`, `attack.style: 'talons'`).

- Rig: `core/rig/bird.js` gives the bone list (`birdBones`), limb weight groups (`birdLimbs`), the
  neck chain (`neckChain`, joints on a Bezier S), the wing joints from a folded/bind wing
  configuration (`wingJoints`, elevation / pitch / alpha / elbow / wrist in degrees) and the feather
  bones (`featherJoints`). Every flight feather (primaries, secondaries, rectrices) is its own bone.
- Feathers: export `surfaces` from `index.js` and build them with `featherCards` (two-sided vane
  cards with coverts, rigid to their bones, material VANE). Contour feathers are the coat (mat 9)
  plus short down shells; the flight feathers are real geometry, so the wing fans, folds and splays.
- Motion: give `wing.bind` = the sculpt's wing, `fold` (resting), `glide`; `flap` (cruise) and
  `power` (take-off) strokes with the research frequency/amplitude; feathers with fold/spread angles.
  Gaits: alternating walk rows (`off: [0, 0.5]`) and two-footed hop rows (`off: [0, 0]`).
- Skinning a thick, feathered neck on few segments: widen the axial blends (`axial.blend`) so the
  skull's influence runs down the neck and the neck base blends into the breast; keep the bind neck
  a Bezier (the engine refits it and reproduces it at rest). Pecking and drinking pitch the whole
  body forward (-0.8 rad) rather than folding the neck; this is what keeps `distort3` in budget.
- Close the bill at rest with `head.jawRest` if the sculpted mandible sits open.
- Tuck the legs in cruise flight with `flight.legTuck { back, down, side }` (fractions of the leg
  length along the standing body axis); tune pecking with `actions.eat { reach, billPitch, bodyPitch,
  drop }` (a peck that uses the neck, not the whole body).
- Per-individual motion (sex, age): `motion.individual(params)` returns top-level keys (the chicken's
  rooster attacks with `style: 'spur'` and crows as an idle behaviour; its chick has short wings).
  A rig and sculpt may depend on `params` too (the chicken's `params.form`).
- Poultry plumage: per-feather markings (bars, spangles, shaft streaks, lacing) via `surf.z < 0` and the
  pattern colour on material 9; lower `render.featherEdge` for pale birds. Long display feathers
  (sickles) are rectrices with `arc`. See `src/species/chicken/`.

## 12. Body plan: snake (`plan: 'snake'`)

Engine `core/motion/snake.js`, bones `core/rig/snake.js`, proving species `species/snake/` (corn
snake, `variant: 'rattlesnake'`).

**Bones.** `snakeSpine()` places the spine joints `v0..vN` (v0 = occiput) along -Z from segment
lengths (`snakeSegments()`: uniform, shorter at the tail tip so it can curl) and an axis-height
function; `snakeBones(n)` gives `spine0..spine(n-1)` (v(i) -> v(i+1), spine0 is the root), `head`
(v0 -> nose), `jaw`, `tongue` + `tongueTip` (forked tips) and `fang`; `snakeAxial(n)` is the axial
chain for the skin weights. 40-60 spine bones bend smoothly (the corn snake uses 50). Lay the bind
pose straight with the belly on y = 0: **joint vi's bind height is its axis height above the belly**,
which the engine reads back to keep every part of the body on the terrain. `rig.unit` = total
length / 1.3 m.

**Sculpt tips.** A chain of round cones (radius = half width) with the axis at `flat x half width`
and one very flat carving ellipsoid under the whole body (`r: [0.4, 0.012, 3.2]`, top at y = 0)
gives the loaf cross-section with a flat belly. Put thin tail-tip ellipsoids with `thin: true` over
the last bones and set `params.minThick`, so the tip survives coarse tiers. Model the head in
head-local coordinates around v0; carve the palate under the lip line and mesh the lower jaw as its
own rigid region (`part: 'jaw'`); the tongue (`part: 'tongue'` / `'fork'`), fangs and a rattle are
rigid regions too (rattle on the last spine bone). Eyes: `lids: 'none'`, a round aperture
(`d: 0`) almost as wide as the eyeball. Scales: material 6 with `surf.y` = scale size and `surf.z`
= keel; `surf.z = -1` draws **ventral scutes** (plates one `surf.y` long across the comb). Lay
patterns out in body coordinates (arc length from v0 = `weights.axialS - axialLengths[1]`, angle
around the axis) so they wrap the tube. `species.render` may be a function of `params` (the mark
colour of a morph).

**Motion schema** (top of `core/motion/snake.js`): `maxSpeed`, `accel`, `decel`, `turnRate`,
`minTurnRadius` (x TL), `gears`, `gaits: [{ name, v, wave (x TL), amp (x TL), headLift, stab }]`,
`body: { neck, forebody }`, `tongue`, `breath`, `actions: { strike, coil, sit, eat, drink }`,
`variants: { <variant>: { speedK, ampK, strike, tongue, rattle } }`. Locomotion is path following:
a leader swings about the steered centre point (`state.position`) and lays a trail on the terrain;
the body follows it exactly, so tune the wave, not the body. Actions pose the body as per-joint
lifts, yaw offsets and rolls, re-integrated with exact segment lengths and pinned where the actions
leave the body alone; a coil is a scripted spiral path. Extra state: `state.contacts` (per spine
joint: on the ground or not), `motion.chain` (spine bone indices); the metrics tool uses them for the
legless checks (gap to the ground, distance from the head path, sideways slip, curvature
continuity).

## 13. Body plan: spider (`plan: 'spider'`)

Engine `src/core/motion/spider.js` (the `species.motion` schema is documented at the top of the
file); rig helpers `src/core/rig/spider.js`; example species `src/species/spider/` (wolf spider,
`variant: 'tarantula'`).

- **Bones.** `spiderBones()` / `spiderLimbs()` give the whole skeleton from joint names:
  `prosoma` (root, `pedA` -> `ceph`), `head` (`ceph` -> `front`), `pedicel`, `abdomen`, `spinnerets`,
  `chelicera{L,R}` + `fang{L,R}` (region `jaw`), 8 legs `coxa|troch|femur|patella|tibia|meta|tarsus`
  + `1..4` + `L|R` (group `L1`..`R4`, the tarsus is region `foot`) and palps `palp*{L,R}` (group
  `P{L,R}`, no foot). The metric tools find the eight claws from the foot regions, so no special
  cases are needed.
- **Bind pose.** Give each leg a coxa base, azimuth, length and per-segment elevations, then let
  `solveBindElevations(yBase, lens, el, free, yTip)` solve one segment (the metatarsus for legs, the
  tibia for palps) so the claw rests on the ground; `planarChain` writes the joints.
- **Sculpt.** Tiny animal: pick cell sizes from the leg radius (the distal tarsus is ~0.3 mm) and
  duplicate coxa + trochanter + femur base into the body part so the leg roots blend. Leg cones
  plus a knuckle sphere at each joint read better than capsules. Store pattern distances scaled
  (`x 0.33 / unit`) because the coat shader's AA widths are in metres.
- **Coat.** Chitin (material 8) is hairy: set `furLen` >= 0.65 mm or the shell hairs are discarded;
  a negative `surf.y` means smooth cuticle (no sutures), with `|surf.y|` the pitting scale.
- **Eyes.** `look.lids: 'simple'` gives still glossy domes of any number and size; when they all
  ride on one bone they are merged into one mesh (one draw call).
- **Motion.** Gait rows carry an 8-entry `off` array (touchdown phase per leg, L1..L4 then R1..R4).
  Keep speeds such that the claw moves well under a tenth of a leg per frame at 60 fps, or the
  jitter metric fails; use `latAccelMax` to force wide arcs at speed.

## 14. Body plan: swimmer (fish, sharks)

Engine `core/motion/swimmer.js` (schema at the top of the file), actions `core/motion/swimmerActions.js`,
rig helpers `core/rig/swimmer.js`. Worked example: `src/species/fish/` (four variants in one module).

**Bones.** `swimmerBones()` gives the standard set: an axial chain `head` (spine0 -> snout),
`spine0..N-1`, `caudal0..M-1` (joints `snout`, `spine0..spineN`, `caudal1..M`; `caudal0` = `spineN`,
use `swimmerJointsAlias`), a rigid lower `jaw` (jawHinge -> jawTip, own `part: 'jaw'` surface), an
optional `upperJaw` (protrusion), `operculum{S}` (opHinge -> opEdge, plus `opLow{S}` for the hinge
axis), `pectoral{S}` (pecBase -> pecTip, plus `pecUp{S}` on the base line) and `pelvic{S}` (pelBase ->
pelTip, plus `pelFront{S}`). Paired fins, gill covers and the upper jaw are appendages
(`swimmerAppendages()`); dorsal, anal and adipose fins are skinned to the spine so they follow the
body wave; the caudal fin rides the caudal bones. Use `axialJoints()` / `axialBones()` for the
`axial` chain. A shark's heterocercal tail is just caudal joints that climb into the upper lobe: the
engine reads every segment's rest pitch from the bind pose. 12 spine segments + 2-3 caudal bend
smoothly. `unit` = total length / 1.3.

**Sculpt.** Build the body from a dense chain of elliptic sections along an outline table (top, bottom,
half width per fraction of the standard length: see `fish/variants.js` and `fish/sculpt.js`).
Fins are membranes: `sculptFin()` makes one thin slab (SDF primitive `m.fin`, exact distance, rounded
rim) from its rays (base -> tip in the fin plane); `notch` gives spiny fins their incised membrane.
Keep fins >= ~2 cells thick at the high tier and set `params.minThick` (thin fins are inflated at
coarse tiers). The prim keeps its ray layout (`prim.fin`); `finRayCoords()` gives the coat each vertex's
ray phase and position along the ray. Cut the mouth with two complementary profile prisms (`m.fin`
with a large thickness, `carve: true`): one out of the body, the complement out of the jaw part, so
the lip line matches exactly. Gill slits: a chain of small carvers along the free edge of the gill
cover. Eyes are lidless (`look.lids: 'none'`, aperture `d: 0`), seated in a spherical carve inside a
soft orbit rim.

**Coat.** Scales = material 6 (`surf.y` scale size, `surf.w` iridescence; `render.scaleEdge` tones the
rim contrast), the scaleless head = material 6 with a tiny scale size, fins = material 11 (`MAT.FIN`):
`surf = [gloss, ray phase, along (0 base .. 1 margin), opacity]`, `comb` = ray direction. Membranes are
drawn in their own transparent pass (`core/render/membranes.js`; opaque in the crowd tier). Clamp
pattern / mark SDFs far from features (a huge value makes the shader's antialiasing width explode).

**Motion.** Speeds are in body lengths per second (`speeds`, `maxSpeed`, `burstSpeed`); the engine
publishes `animal.gears` in m/s for the individual. `wave` rows give tail-beat frequency, tail
amplitude, wavelength and the pectoral activity / beat / fold by speed (Bainbridge: f = (U/L + 1) / 0.75
above ~2 BL/s, amplitude ~0.2 L). `envelope: { exp: 3.5 }` (carangiform) or `{ pow: 2.5 }`
(thunniform, stiff front); `flex` limits where turns bend the body. Labriform swimmers (bluegill,
clownfish) keep the tail almost still and scull with the pectorals at low speed. Sharks: `minSpeed`
(obligate ram ventilation: they patrol in circles instead of stopping, and their rest postures keep
swimming), `pectoral.stiff: 1` (hydrofoils), `breath.slits`. Per-variant overrides go in
`motion.variants[key]`. Actions: `burst` (C-start), `jump`, `eat` (`style: 'suction' | 'bottom'`),
`drink` (a gulp at the surface when it is within `reach` body lengths, else the same suction gulp as
eat), `attack`, `hit`, `sit` (hover still), `lie` (rest on the bed), `sleep` (`style: 'bottom' |
'hover' | 'side'`), `death` (rolls onto its side, sinks, settles and conforms to the bed).

**Water.** Pass `createAnimal(id, { ground, water })`; `water(x, z)` returns the surface height or null
where dry (the last known level is kept). Without `water` the water is unbounded. The fish keeps a
clearance from bed and surface, steers over rising ground, and a skin-extent clamp keeps the mesh out
of the bed and below the surface except while leaping or gulping at the surface (`state.breaching`).

**Checks.** The metrics sample swimmers at 240 Hz (`thresholds.json` `plans.swimmer`), skip the foot
checks, and add: skin / joints out of the water (not leaping), spine kinks (bend change from joint to
joint), a `climb` scenario (to the surface and down to a bumpy bed). The harness gives swimmers a water
volume 12 S deep and draws gait strips from above.
