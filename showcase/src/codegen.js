// "Use in your game": copy-paste code for the animal on screen (species, seed, quality, sex, age),
// with a tiny syntax highlighter for the panel.

export function gameCode(s) {
  const q = (v) => (typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(v));
  const opt = [`seed: ${s.seed}`, `quality: ${q(s.quality)}`];
  if (s.variant) opt.push(`variant: ${q(s.variant)}`);
  if (s.sex) opt.push(`sex: ${q(s.sex)}`);
  if (s.age && s.age !== 'adult') opt.push(`age: ${q(s.age)}`);
  const acts = (s.actions || []).filter((a) => a !== 'idle');
  const act = acts.find((a) => a === 'sit') || acts[0] || 'jump';
  const swim = s.plan === 'swimmer', fly = s.plan === 'bird';
  const drinks = (s.actions || []).includes('drink') && !swim;
  const perches = fly || (s.actions || []).includes('perch');
  const gait = s.gait ? `, gait: ${q(s.gait)}` : '';
  const speed = (s.speed || 3).toFixed(1).replace(/\.0$/, '');
  const file = `${s.species}-${s.seed}-${s.quality}.animal`;
  const bakeFlags = [`--seed ${s.seed}`, `--quality ${s.quality}`, s.sex ? `--sex ${s.sex}` : '', s.age && s.age !== 'adult' ? `--age ${s.age}` : '', `--out ${file}`].filter(Boolean).join(' ');
  return `// npm install procedural-animals three
import * as THREE from 'three';
import { createAnimal } from 'procedural-animals';

// ${s.name} (${s.latin}${s.variantNote ? ', ' + s.variantNote : ''}), built procedurally in Web Workers (~${s.buildSec}s here)
const animal = await createAnimal(${q(s.species)}, {
  ${opt.join(', ')},
  ground: (x, z) => terrain.heightAt(x, z),   // your ground height (metres, world space)${swim ? `
  water: (x, z) => lake.surfaceAt(x, z),      // water surface height, or null where dry: it stays in the water` : drinks ? `
  water: (x, z) => lake.surfaceAt(x, z),      // optional: water surface or null (wading, drinking at the shore)` : ''}${perches ? `
  perches: [branchTip, fencePost],            // Vector3s it can fly to and grip: play('perch')` : ''}
  position: new THREE.Vector3(0, ${swim ? '-0.5' : '0'}, 0),${swim ? '    // start it in the water' : ''}
  heading: 0,                                 // radians, 0 faces +Z
});
scene.add(animal.object);                     // it moves itself: keep its transform at identity

// drive it
animal.move({ speed: ${speed}, heading: Math.PI / 2${gait}${fly ? ', climb: 1' : swim ? ', climb: -0.3' : ''} });  // m/s${fly ? `
// climb in m/s; above the fastest ground gear (or climbing) it takes off, below flight speed it lands
// animal.state.mode: 'ground' | 'takeoff' | 'air' | 'landing' | 'perch', animal.state.altitude (m)
animal.play('perch', { target: branchTip });  // fly there and grip it` : swim ? `
// climb -1..1 pitches the swim path; animal.state.depth is metres below the surface
// moveTo targets are 3D for swimmers (clamped into the water column)` : ''}
animal.moveTo(new THREE.Vector3(10, ${swim ? '-0.5' : '0'}, 4), { speed: ${speed} });
animal.follow(body.position, body.velocity);  // or match your own physics body
animal.lookAt(player.position);               // null to stop looking
animal.play(${q(act)});${acts.length ? `                         // ${acts.join(', ')}` : ''}
animal.on('footstep', (e) => sfx.play('step', e.position, e.strength));
animal.on('attackHit', (e) => damage(e.position, e.direction));

// every frame
renderer.setAnimationLoop(() => {
  animal.update(clock.getDelta());
  renderer.render(scene, camera);
});

// when you are done with it
animal.dispose();

// ship it pre-built (no meshing at load time):
${s.variant ? `//   writeBake(await buildAnimalData(${q(s.species)}, { ${opt.join(', ')} }))  // from 'procedural-animals' and 'procedural-animals/bake'
//   (or npx procedural-animals-bake ${s.species} ${bakeFlags} for the default variant)` : `//   npx procedural-animals-bake ${s.species} ${bakeFlags}`}
// const animal = await createAnimal(${q(s.species)}, {
//   baked: fetch('${file}').then((r) => r.arrayBuffer()), ground });
`;
}

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const KW = /\b(import|from|const|let|await|new|return|async|function|null|true|false)\b/g;

export function highlight(code) {
  return code.split('\n').map((line) => {
    let out = '', rest = line;
    // split off a trailing // comment that is not inside a string
    let inS = null, cut = -1;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (inS) { if (c === inS && rest[i - 1] !== '\\') inS = null; continue; }
      if (c === '"' || c === "'" || c === '`') inS = c;
      else if (c === '/' && rest[i + 1] === '/') { cut = i; break; }
    }
    const comment = cut >= 0 ? rest.slice(cut) : '';
    rest = cut >= 0 ? rest.slice(0, cut) : rest;
    const parts = rest.split(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2) out += `<span class="s">${esc(parts[i])}</span>`;
      else out += esc(parts[i]).replace(KW, '<span class="k">$1</span>').replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="n">$1</span>').replace(/\.(\w+)\(/g, '.<span class="f">$1</span>(');
    }
    if (comment) out += `<span class="c">${esc(comment)}</span>`;
    return out;
  }).join('\n');
}
