// End-to-end check of the built showcase in headless Chromium (software GL):
//   node showcase/test.mjs [desktop|phone|both] [outDir] [tour,ui]
// Loads dist/showcase.html, reports time to first frame, builds every species (and on desktop every
// variant) with a screenshot each, checks the body-plan HUD (footfall rows = legs, a body-wave trace
// when legless, altitude / depth and climb controls for flyers and swimmers), that swimmers stay in
// the water, flyers fly and perch, the first land animal drinks at the shore, crowds per plan (flock
// airborne, school in the lake, small animals not scattering); then clicks through seeds, actions,
// gaits, cameras, debug views, crowd, compare and the code panel, takes a screenshot of each and
// fails on console errors. Actions/footfalls are also exercised with the engine's own data when the
// current core exposes no actions / state.legs yet (see "shim" below).
import { chromium } from 'playwright-core';
import { CHROME, CHROME_ARGS } from '../tools/lib/common.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] || 'both';
const outDir = process.argv[3] || path.resolve(here, '../out/showcase/test');
fs.mkdirSync(outDir, { recursive: true });
const url = process.env.SHOWCASE_URL || 'file://' + path.resolve(here, '../dist/showcase.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: CHROME, args: [...CHROME_ARGS, '--disable-gpu-sandbox'] });
const results = [];

// part 'tour': species, variants, plan behaviour and plan crowds; part 'ui': everything else. Each part
// gets a fresh page, so no single software-GL session runs for too long.
async function run(name, viewport, extra = {}, part = 'ui') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ...extra });
  const page = await ctx.newPage();
  // software GL on a shared machine can drop to a frame every few seconds: be patient with clicks
  page.setDefaultTimeout(180000);
  const errors = [], logs = [];
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' && !/ERR_FAILED|ERR_BLOCKED|fonts\.g/i.test(t)) errors.push(t); if (m.type() === 'warning' || m.type() === 'info') logs.push(t); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // Google Fonts are blocked here: the page must work with the system fallbacks (and offline)
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
  const timing = await page.evaluate(() => ({ ...window.__timing, marks: window.__marks, gpu: window.proceduralAnimals.gpu, tier: window.proceduralAnimals.tier, quality: window.proceduralAnimals.hero.quality }));
  const R = { name, part, viewport, wallReadyS: (Date.now() - t0) / 1000, timing, steps: [], errors };
  const frames = (n = 2) => page.evaluate((n) => new Promise((res) => { const f0 = window.proceduralAnimals.frames; const chk = () => (window.proceduralAnimals.frames >= f0 + n ? res() : setTimeout(chk, 50)); chk(); }), n);
  let shotN = 0;
  const shot = async (label) => {
    await frames(2);
    const file = path.join(outDir, `${name}-${part}-${String(++shotN).padStart(2, '0')}-${label}.png`);
    await page.screenshot({ path: file, timeout: 400000 });
    R.steps.push({ step: label, file, t: ((Date.now() - t0) / 1000).toFixed(1) });
    console.log(`[${name}/${part}] ${label} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  };
  const step = async (label, fn) => {
    try { const v = await fn(); R.steps.push({ step: label, ok: true, v }); console.log(`[${name}/${part}] ${label}: ok ${v !== undefined ? JSON.stringify(v) : ''}`); }
    catch (e) { R.steps.push({ step: label, ok: false, err: e.message }); errors.push(`${label}: ${e.message}`); console.log(`[${name}/${part}] ${label}: FAIL ${e.message}`); }
  };
  const phone = viewport.width < 600;
  const openTab = async (tab) => {
    if (await page.locator('#panel').isHidden()) await page.click('#panelBtn');
    await page.click(`#tabs button[data-tab="${tab}"]`);
  };
  const closePanel = async () => { if (!(await page.locator('#panel').isHidden())) await page.click('#panelBtn'); };
  // remember the current hero object, then wait until a different one is on screen
  const heroId = () => page.evaluate(() => { window.__prevHero = window.proceduralAnimals.hero; return window.proceduralAnimals.hero.seed + ':' + window.proceduralAnimals.hero.quality + ':' + window.proceduralAnimals.hero.id; });
  const waitHeroChange = async () => page.waitForFunction(() => window.proceduralAnimals.hero && window.proceduralAnimals.hero !== window.__prevHero, null, { timeout: 400000 });

  page.on('crash', () => errors.push('page crashed'));
  try {
  R.home = await page.evaluate(() => window.proceduralAnimals.hero.id); // the page's default species
  await shot('first-frame');
  // defaults on load: the controls are open, autopilot is off and the animal stands where it was built
  await step('defaults', async () => {
    const v = await page.evaluate(() => ({ panel: !document.getElementById('panel').hidden, expanded: document.getElementById('panelBtn').getAttribute('aria-expanded'), autopilot: document.getElementById('autoBtn').getAttribute('aria-pressed'), mode: window.proceduralAnimals.pilot.mode, speed: +window.proceduralAnimals.hero.speed.toFixed(3) }));
    if (!v.panel || v.expanded !== 'true') throw new Error('controls panel is not open on load');
    if (v.autopilot !== 'false' || v.mode !== 'manual') throw new Error('autopilot is on by default');
    if (v.speed > 0.05) throw new Error('the animal is moving on load: ' + v.speed + ' m/s');
    return v;
  });
  // phones show only the active camera button; tapping it cycles orbit -> follow -> director
  const setCam = async (cam) => {
    for (let i = 0; i < 4 && (await page.evaluate(() => window.proceduralAnimals.rig.mode)) !== cam; i++) {
      if (phone) await page.click('#camSeg button[aria-pressed="true"]');
      else await page.click(`#camSeg button[data-cam="${cam}"]`);
    }
  };

  if (part === 'tour') {
  // --- every species on main (and, on desktop, every variant): build, check the body-plan HUD and the
  // world rules (swimmers in the water, flyers fly and perch, land animals drink at the shore), shoot
  const hud = () => page.evaluate(() => {
    const b = window.proceduralAnimals, h = b.hero, i = b.info, W = b.world, p = h.position;
    return {
      id: h.id, title: document.getElementById('tName').textContent.trim(), sub: document.getElementById('tSub').textContent,
      variant: h.params.variant ?? h.params.morph ?? null, plan: i.plan, scale: +i.scale.toFixed(3), span: +i.span.toFixed(3),
      hud: b.footfalls.mode, rows: b.footfalls.rows.length, legs: (h.state.legs || []).length, gaitTitle: document.getElementById('gaitTitle').textContent,
      gaits: [...document.querySelectorAll('#gaitSeg button')].map((x) => x.textContent), gears: Object.keys(h.gears || {}),
      alt: document.getElementById('altStat').hidden ? null : document.getElementById('sAlt').textContent,
      climbUI: !document.getElementById('climb').hidden,
      wet: W.depthAt(p.x, p.z) > 0 && p.y < W.waterLevel, depth: +W.depthAt(p.x, p.z).toFixed(2),
      shadowR: +b.world.env.shadowR.toFixed(3), near: +b.camera.near.toFixed(4),
    };
  });
  const checkPlan = (v) => {
    const bad = [];
    if (v.legs > 0 && (v.hud !== 'legs' || v.rows !== v.legs)) bad.push(`footfall rows ${v.rows} for ${v.legs} legs`);
    if (v.legs === 0 && v.hud !== 'wave') bad.push('legless animal without a body-wave trace');
    if (v.plan === 'swimmer' && !v.wet) bad.push('swimmer out of the water');
    if ((v.plan === 'swimmer' || v.plan === 'bird') && (!v.climbUI || v.alt === null)) bad.push('no climb / altitude HUD');
    const want = v.gears.map((g) => g.toLowerCase());
    if (want.length && want.some((g) => !v.gaits.map((x) => x.toLowerCase()).includes(g))) bad.push('gait buttons ' + v.gaits.join(',') + ' vs gears ' + v.gears.join(','));
    if (Math.abs(v.shadowR - Math.max(0.12, 3.4 * v.scale)) > 0.01) bad.push('shadow extent ' + v.shadowR);
    if (bad.length) throw new Error(bad.join('; '));
  };
  const species = [];
  await step('species list', async () => {
    await openTab('animal');
    for (const id of await page.$$eval('#speciesList .sp', (b) => b.map((x) => x.dataset.id))) species.push(id);
    return await page.$$eval('#speciesList .sp', (b) => b.map((x) => x.dataset.id + ' / ' + x.querySelector('i').textContent));
  });
  const tour = {};
  for (const id of species) {
    await step('species ' + id, async () => {
      await openTab('animal');
      const prev = await heroId();
      if (prev.split(':')[2] !== id) { await page.click(`#speciesList .sp[data-id="${id}"]`); await waitHeroChange(); }
      await closePanel();
      await frames(6);
      const v = await hud();
      checkPlan(v);
      tour[id] = { default: v };
      return v;
    });
    await shot('sp-' + id);
    // variants: desktop builds every one; phones check the list and one variant
    const vids = await page.$$eval('#variantList .sp', (b) => b.map((x) => x.dataset.v).filter(Boolean));
    for (const vid of phone ? vids.slice(-1) : vids) {
      await step(`variant ${id}/${vid}`, async () => {
        await openTab('animal');
        const prev = await heroId();
        await page.click(`#variantList .sp[data-v="${vid}"]`);
        await waitHeroChange(prev);
        await closePanel();
        await frames(4);
        const v = await hud();
        checkPlan(v);
        const latin = await page.$eval(`#variantList .sp[data-v="${vid}"] i`, (x) => x.textContent.trim());
        if (v.variant !== vid) throw new Error(`built ${v.variant}, asked for ${vid}`);
        if (latin && v.title !== latin) throw new Error(`title "${v.title}" is not the variant's "${latin}"`);
        (tour[id].variants = tour[id].variants || {})[vid] = v.title;
        return { title: v.title, sub: v.sub };
      });
      await shot(`sp-${id}-${vid}`);
    }
    // plan-specific behaviour
    const plan = await page.evaluate(() => window.proceduralAnimals.info.plan);
    if (plan === 'bird') {
      await step(id + ' flies', async () => {
        await page.click('#gaitSeg button:last-child'); // the flight gear is the fastest
        await page.waitForFunction(() => window.proceduralAnimals.hero.state.altitude > 1.2, null, { timeout: 400000, polling: 200 });
        await frames(8);
        return await page.evaluate(() => ({ alt: +window.proceduralAnimals.hero.state.altitude.toFixed(2), mode: window.proceduralAnimals.hero.state.mode, speed: +window.proceduralAnimals.hero.speed.toFixed(1), camDist: +window.proceduralAnimals.camera.position.distanceTo(window.proceduralAnimals.hero.position).toFixed(2), status: document.getElementById('statusText').textContent }));
      });
      await shot(id + '-flying');
      await step(id + ' perches', async () => {
        await page.click('#actions .chip[data-action="perch"]');
        await page.waitForFunction(() => window.proceduralAnimals.hero.state.mode === 'perch', null, { timeout: 300000, polling: 250 });
        await frames(10);
        return await page.evaluate(() => { const b = window.proceduralAnimals, p = b.hero.position, q = b.world.nearestPerch(p); return { mode: b.hero.state.mode, distToPerch: +q.position.distanceTo(p).toFixed(3), status: document.getElementById('statusText').textContent }; });
      });
      await shot(id + '-perched');
    } else if (plan === 'swimmer') {
      await step(id + ' stays in the water', async () => {
        await page.click('#gaitSeg button:nth-child(3)'); // the second gear
        let dry = 0;
        for (let k = 0; k < 8; k++) { await frames(4); if (!(await hud()).wet) dry++; }
        await page.click('#gaitSeg button:text-is("Stand")');
        const v = await hud();
        if (dry) throw new Error(`out of the water in ${dry} of 8 samples`);
        return { depth: v.depth, alt: v.alt };
      });
    } else if (id === species[0]) {
      await step(id + ' drinks at the shore', async () => {
        await page.click('#actions .chip[data-action="drink"]');
        const from = await page.evaluate(() => { const b = window.proceduralAnimals, s = b.world.shorePoint(b.hero.position, b.info); return +s.distanceTo(b.hero.position).toFixed(2); });
        // walks to the beach (pending), then drinks there
        await page.waitForFunction(() => !window.proceduralAnimals.pending && window.proceduralAnimals.hero.state.action === 'drink', null, { timeout: 600000, polling: 250 });
        return await page.evaluate((from) => { const b = window.proceduralAnimals, p = b.hero.position, W = b.world, s = W.shorePoint(p, b.info); return { startDistToShore: from, action: b.hero.state.action, distToShore: s ? +s.distanceTo(p).toFixed(2) : null, depthHere: +W.depthAt(p.x, p.z).toFixed(3) }; }, from);
      });
      await shot(id + '-drinking');
    }
  }
  R.tour = tour;
  await openTab('animal');
  await shot('animal-panel');

  }
  if (part === 'ui') {
  // --- seed + sex/age
  await openTab('animal');
  await step('random seed', async () => {
    const prev = await heroId();
    await page.click('#dice');
    await waitHeroChange(prev);
    return await heroId();
  });
  await step('sex + age', async () => {
    let prev = await heroId();
    await page.click('#sexSeg button[data-v="female"]');
    await page.waitForFunction(() => window.proceduralAnimals.hero.params.sex === 'female', null, { timeout: 400000 });
    prev = await heroId();
    await page.click('#ageSeg button[data-v="juvenile"]');
    await page.waitForFunction(() => window.proceduralAnimals.hero.params.age === 'juvenile', null, { timeout: 400000 });
    await shot('juvenile');
    await page.click('#ageSeg button[data-v="adult"]');
    await page.waitForFunction(() => window.proceduralAnimals.hero.params.age === 'adult', null, { timeout: 400000 });
    void prev;
    return await page.evaluate(() => window.proceduralAnimals.hero.params.sex + ' ' + window.proceduralAnimals.hero.params.age);
  });
  await step('quality select', async () => {
    const prev = await heroId();
    await page.selectOption('#quality', 'medium');
    await waitHeroChange(prev);
    return await page.evaluate(() => window.proceduralAnimals.hero.quality);
  });
  await closePanel();

  // --- actions (from animal.actions). Shim: if the core only reports 'idle', present the canonical list
  // so the UI path (buttons -> animal.play) is exercised; play() of unknown actions must not throw.
  await step('actions', async () => {
    const real = await page.evaluate(() => window.proceduralAnimals.hero.actions);
    if (real.filter((a) => a !== 'idle').length < 2) {
      await page.evaluate(() => {
        const m = window.proceduralAnimals.hero.motion;
        Object.defineProperty(m, 'actions', { value: ['idle', 'jump', 'sit', 'lie', 'sleep', 'eat', 'drink', 'attack', 'hit', 'death', 'stand'], configurable: true });
        window.proceduralAnimals.refreshUI();
      });
    }
    const names = await page.$$eval('#actions .chip[data-action]', (b) => b.map((x) => x.dataset.action));
    for (const n of names) { await page.click(`#actions .chip[data-action="${n}"]`); await frames(1); }
    return { engineActions: real, clicked: names, pilot: await page.evaluate(() => window.proceduralAnimals.pilot.mode) };
  });
  await shot('actions');

  // --- gaits + speed slider (+ footfalls from state.legs when present; shim from the engine's legs)
  await step('gaits', async () => {
    const hasLegs = await page.evaluate(() => Array.isArray(window.proceduralAnimals.hero.state.legs));
    if (!hasLegs) await page.evaluate(() => { const m = window.proceduralAnimals.hero.motion; if (m.loco) Object.defineProperty(m.state, 'legs', { get: () => m.loco.legs, configurable: true }); });
    const gaits = await page.$$eval('#gaitSeg button', (b) => b.map((x) => x.textContent));
    const speeds = {};
    for (const g of gaits) {
      await page.click(`#gaitSeg button:text-is("${g}")`);
      await frames(g === 'Stand' ? 1 : 12);
      speeds[g] = await page.evaluate(() => +window.proceduralAnimals.hero.speed.toFixed(2));
    }
    const half = await page.$eval('#speed', (x) => String(+(+x.max * 0.5).toFixed(3)));
    await page.locator('#speed').fill(half);
    await frames(8);
    speeds.sliderHalf = await page.evaluate(() => +window.proceduralAnimals.hero.speed.toFixed(2));
    return { engineHasLegs: hasLegs, gaits, speeds, out: await page.textContent('#speedOut') };
  });
  await page.click(`#gaitSeg button:text-is("${phone ? 'Trot' : 'Canter'}")`).catch(() => {});
  await frames(10);
  await shot('gait-footfalls');

  // --- controls: keyboard, click-to-move, autopilot, joystick (phone)
  await step('keyboard', async () => {
    await page.click('#gaitSeg button:text-is("Stand")');
    await page.focus('#gl');
    await page.keyboard.down('w');
    await frames(10);
    const v = await page.evaluate(() => window.proceduralAnimals.hero.speed);
    await page.keyboard.up('w');
    return { speedWhileW: +v.toFixed(2), mode: await page.evaluate(() => window.proceduralAnimals.pilot.mode) };
  });
  await step('click to move', async () => {
    const box = await page.locator('#gl').boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * (phone ? 0.52 : 0.62));
    await frames(2);
    return await page.evaluate(() => ({ mode: window.proceduralAnimals.pilot.mode, target: window.proceduralAnimals.pilot.target && window.proceduralAnimals.pilot.target.toArray().map((v) => +v.toFixed(1)) }));
  });
  if (phone) {
    await step('joystick', async () => {
      const j = await page.locator('#joy').boundingBox();
      if (!j) throw new Error('no joystick');
      await page.mouse.move(j.x + j.width / 2, j.y + j.height / 2);
      await page.mouse.down();
      await page.mouse.move(j.x + j.width / 2, j.y + 4, { steps: 4 });
      await frames(10);
      const v = await page.evaluate(() => ({ speed: +window.proceduralAnimals.hero.speed.toFixed(2), stick: window.proceduralAnimals.pilot.stick.active }));
      await page.mouse.up();
      return v;
    });
  }
  await step('autopilot', async () => { await page.click('#autoBtn'); return await page.evaluate(() => window.proceduralAnimals.pilot.mode); });

  // --- cameras + time scale
  for (const cam of ['orbit', 'follow', 'director']) {
    await step('camera ' + cam, async () => { await setCam(cam); await frames(6); const m = await page.evaluate(() => window.proceduralAnimals.rig.mode); if (m !== cam) throw new Error('camera is ' + m); return m; });
    await shot('camera-' + cam);
  }
  await step('time scale + time of day', async () => {
    await openTab('world');
    await page.click('#tsSeg button[data-v="0.25"]');
    await page.locator('#tod').fill('0.5');
    await page.click('#tsSeg button[data-v="1"]');
    return await page.evaluate(() => ({ ts: window.proceduralAnimals.state.timeScale, tod: window.proceduralAnimals.world.env.tod }));
  });

  // --- debug views
  await setCam('orbit');
  await page.evaluate(() => { const b = window.proceduralAnimals; const h = b.hero, s = b.info.scale; b.camera.position.set(h.position.x + 2.2 * s, h.position.y + 1.1 * s, h.position.z + 2.6 * s); });
  await openTab('debug');
  for (const [id, label] of [['tSkel', 'skeleton'], ['tWeights', 'weights'], ['tSdf', 'sdf'], ['tCover', 'coverings-off']]) {
    await step('debug ' + label, async () => { await page.click(`label:has(#${id})`); await frames(2); return await page.evaluate((id) => document.getElementById(id).checked, id); });
    if (!phone || label !== 'weights') await shot('debug-' + label);
    await page.click(`label:has(#${id})`);
  }
  await closePanel();

  // --- crowd
  await step('crowd', async () => {
    await openTab('modes');
    await page.locator('#crowdN').fill(phone ? '10' : '20');
    await page.click('label:has(#tCrowd)');
    await page.waitForFunction((n) => window.proceduralAnimals.crowd.length >= n, phone ? 10 : 20, { timeout: 300000 });
    await closePanel();
    await setCam('orbit');
    await page.evaluate(() => { const b = window.proceduralAnimals; const h = b.hero, s = b.info.span * 2; b.camera.position.set(h.position.x + 7 * s, h.position.y + 4.5 * s, h.position.z - 9 * s); });
    await frames(20);
    const hud = await page.evaluate(() => ['pFps', 'pCpu', 'pAnim', 'pCalls', 'pTris', 'pVerts'].map((k) => document.getElementById(k).textContent));
    const spread = await page.evaluate(() => { const b = window.proceduralAnimals, h = b.hero; return +Math.max(...b.crowd.map((a) => Math.hypot(a.position.x - h.position.x, a.position.z - h.position.z) / b.info.span)).toFixed(1); });
    const flyer = await page.evaluate(() => window.proceduralAnimals.info.flyer);
    if (!flyer && spread > 20) throw new Error(`group scattered: ${spread} body spans`);
    return { species: await page.evaluate(() => window.proceduralAnimals.hero.id), fps: hud[0], msPerAnimal: hud[1], animals: hud[2], drawCalls: hud[3], triangles: hud[4], vertices: hud[5], farthestInSpans: spread };
  });
  await shot('crowd');
  await step('crowd off', async () => { await openTab('modes'); await page.click('label:has(#tCrowd)'); return await page.evaluate(() => window.proceduralAnimals.crowd.length); });

  // --- compare
  await step('compare', async () => {
    await page.fill('#cmpSeed', '7');
    await page.click('label:has(#tCompare)');
    await page.waitForFunction(() => !!window.proceduralAnimals.compare, null, { timeout: 400000 });
    await closePanel();
    await page.click('#actions .chip[data-action="sit"]').catch(() => {});
    await frames(6);
    return await page.evaluate(() => ({ a: window.proceduralAnimals.hero.seed, b: window.proceduralAnimals.compare.seed }));
  });
  await shot('compare');
  await step('compare off', async () => { await openTab('modes'); await page.click('label:has(#tCompare)'); return await page.evaluate(() => !!window.proceduralAnimals.compare); });

  }
  if (part === 'tour') {
  // --- crowds per body plan (desktop): a flock in the air, a school in the lake, a tight group of
  // small animals that does not scatter. Measured in body spans so every size is judged the same way.
  const crowdStats = () => page.evaluate(() => {
    const b = window.proceduralAnimals, W = b.world, h = b.hero, span = b.info.span;
    const cs = b.crowd;
    let far = 0, air = 0, wet = 0, altSum = 0;
    for (const a of cs) {
      const p = a.position;
      far = Math.max(far, Math.hypot(p.x - h.position.x, p.z - h.position.z) / span);
      if (a.state.grounded === false) air++;
      altSum += a.state.altitude || 0;
      if (W.depthAt(p.x, p.z) > 0 && p.y < W.waterLevel) wet++;
    }
    return { n: cs.length, farthestInSpans: +far.toFixed(1), airborne: air, meanAlt: +(altSum / Math.max(1, cs.length)).toFixed(2), inWater: wet, word: document.getElementById('crowdLabel').textContent };
  });
  if (!phone) {
    const plans = await page.evaluate(() => { const out = {}; for (const m of Object.values(window.proceduralAnimals.meta)) if (!out[m.plan]) out[m.plan] = m.id; return out; });
    // every body plan except the default hero's (the 'ui' part crowds that one)
    const home = await page.evaluate((id) => window.proceduralAnimals.meta[id].plan, R.home);
    for (const plan of Object.keys(plans).filter((p) => p !== home)) {
      const id = plans[plan];
      if (!id) continue;
      await step(`crowd ${plan} (${id})`, async () => {
        await openTab('animal');
        const prev = await heroId();
        if (prev.split(':')[2] !== id) { await page.click(`#speciesList .sp[data-id="${id}"]`); await waitHeroChange(); }
        await openTab('modes');
        await page.locator('#crowdN').fill('10');
        await page.click('label:has(#tCrowd)');
        await page.waitForFunction(() => window.proceduralAnimals.crowd.length >= 10, null, { timeout: 400000, polling: 500 });
        await closePanel();
        await frames(plan === 'bird' ? 70 : 30);
        const st = await crowdStats();
        await setCam('orbit');
        await page.evaluate((plan) => {
          const b = window.proceduralAnimals, h = b.hero, s = b.info.span;
          const c = b.crowd.reduce((v, a) => v.add(a.position), h.position.clone().multiplyScalar(0)).multiplyScalar(1 / Math.max(1, b.crowd.length));
          // frame the whole group: distance from its extent
          const ext = Math.max(...b.crowd.map((a) => a.position.distanceTo(c)));
          const d = 2.1 * ext + 4 * s;
          b.rig.controls.target.copy(c);
          b.camera.position.set(c.x + d * 0.6, c.y + d * (plan === 'bird' ? 0.35 : 0.7), c.z - d * 0.8);
          b.camera.lookAt(c);
        }, plan);
        await frames(3);
        if (plan === 'bird' && st.airborne < st.n * 0.7) throw new Error(`only ${st.airborne} of ${st.n} in the air ${JSON.stringify(st)}`);
        if (plan === 'swimmer' && st.inWater < st.n) throw new Error(`${st.n - st.inWater} out of the water`);
        if (plan !== 'bird' && st.farthestInSpans > 20) throw new Error(`group scattered: ${st.farthestInSpans} spans`);
        return st;
      });
      await shot('crowd-' + plan);
      await step(`crowd ${plan} off`, async () => { await openTab('modes'); await page.click('label:has(#tCrowd)'); await closePanel(); await setCam('director'); return await page.evaluate(() => window.proceduralAnimals.crowd.length); });
    }
  }

  }
  if (part === 'ui') {
  // --- code panel
  await step('code panel', async () => {
    await openTab('code');
    const code = await page.textContent('#code');
    await page.click('#copy');
    const needed = ['npm install', 'createAnimal(', 'ground:', 'move(', 'follow(', 'lookAt(', 'play(', "on('footstep'", 'update(', 'dispose()', 'procedural-animals-bake'];
    const missing = needed.filter((k) => !code.includes(k));
    if (missing.length) throw new Error('missing ' + missing.join(', '));
    return { lines: code.split('\n').length, copyLabel: await page.textContent('#copy') };
  });
  await shot('code');

  // layout sanity: nothing important off-screen
  await step('layout', async () => page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight, bad = [];
    for (const id of ['title', 'dock', 'topRight', 'panel']) {
      const el = document.getElementById(id);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) bad.push(`${id} ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
    }
    if (bad.length) throw new Error(bad.join('; '));
    return 'ok';
  }));
  }
  R.finalFps = await page.evaluate(() => window.proceduralAnimals.fps.toFixed(1));
  } catch (e) { errors.push('aborted: ' + e.message); console.log(`[${name}/${part}] ABORTED ${e.message}`); }
  results.push(R);
  await ctx.close().catch(() => {});
}

const parts = (process.argv[4] || 'tour,ui').split(',');
for (const part of parts) {
  if (which === 'desktop' || which === 'both') await run('desktop', { width: 960, height: 600 }, {}, part); // small renders: the machine is shared
  if (which === 'phone' || which === 'both') await run('phone', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }, part);
}
await browser.close();
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`\n== ${r.name}/${r.part} ${r.viewport.width}x${r.viewport.height}: ready in ${r.wallReadyS.toFixed(1)} s wall; first frame ${r.timing.firstFrameMs} ms, first animal frame ${r.timing.firstAnimalFrameMs} ms (build ${r.timing.buildMs} ms), tier ${r.timing.tier}, quality ${r.timing.quality}`);
  console.log(`   steps ok: ${r.steps.filter((s) => s.ok).length}, failed: ${r.steps.filter((s) => s.ok === false).length}, screenshots: ${r.steps.filter((s) => s.file).length}, console errors: ${r.errors.length}`);
  for (const e of r.errors) console.log('   ERROR ' + e);
}
process.exit(results.some((r) => r.errors.length) ? 1 : 0);
