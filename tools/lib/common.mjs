// Shared helpers for the Node-side tools: paths, argument parsing, headless Chromium, contact sheets.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

export const TOOLS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ROOT = path.dirname(TOOLS);
export const OUT = path.join(ROOT, 'out');
// reference photos for tools/compare.mjs live outside the repository (they are never committed)
export const REFCACHE = process.env.PROCEDURAL_ANIMALS_REFCACHE || path.resolve(ROOT, '../procedural-animals-refcache');
export const CHROME = process.env.PROCEDURAL_ANIMALS_CHROME || findChrome();
// PROCEDURAL_ANIMALS_GL=gpu uses the machine's GPU (Metal on macOS: 10-50x faster than software GL, and what users
// see); PROCEDURAL_ANIMALS_GL=swiftshader the software renderer (deterministic, no GPU needed). Default:
// the GPU on macOS, SwiftShader elsewhere (headless Linux boxes rarely have one).
export const GL = process.env.PROCEDURAL_ANIMALS_GL || (process.platform === 'darwin' ? 'gpu' : 'swiftshader');
export const CHROME_ARGS = [
  ...(GL === 'gpu' ? ['--enable-gpu', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  '--ignore-gpu-blocklist', '--disable-background-networking', '--disable-component-update', '--no-first-run',
];

/** A Chromium binary when PROCEDURAL_ANIMALS_CHROME is not set: a fixed /opt/pw-browsers path, else the newest
 *  Playwright download (headless shell first, then full Chromium) on Linux or macOS. */
export function findChrome() {
  const fixed = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (fs.existsSync(fixed)) return fixed;
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright'), '/opt/pw-browsers'].filter(Boolean);
  const bins = [
    ['chromium_headless_shell-', ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac/chrome-headless-shell', 'chrome-linux/headless_shell', 'chrome-headless-shell-linux64/chrome-headless-shell']],
    ['chromium-', ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']],
  ];
  for (const [prefix, rels] of bins) {
    for (const dir of caches) {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort((a, b) => +b.slice(prefix.length) - +a.slice(prefix.length)); } catch (e) { continue; }
      for (const n of names) for (const r of rels) { const p = path.join(dir, n, r); if (fs.existsSync(p)) return p; }
    }
  }
  return fixed;
}

/** Minimal argv parser: positional args + --key value / --flag / --key=value. */
export function parseArgs(argv = process.argv.slice(2), { flags = [], alias = {} } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.startsWith('-') && a.length > 1 && isNaN(+a)) {
      a = a.replace(/^--?/, '');
      let v;
      if (a.includes('=')) [a, v] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)];
      a = alias[a] || a;
      if (v === undefined) v = flags.includes(a) ? true : argv[++i];
      out[a] = v;
    } else out._.push(a);
  }
  return out;
}

export function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); return d; }

export function die(msg, code = 2) { console.error('ERROR: ' + msg); process.exit(code); }

/** Launch headless Chromium; returns { browser, page, errors, close }. */
export async function launchPage({ width = 320, height = 240 } = {}) {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch (e) { die('playwright-core is not installed (npm install)'); }
  if (!fs.existsSync(CHROME)) die(`Chromium not found at ${CHROME} (set PROCEDURAL_ANIMALS_CHROME)`);
  const browser = await chromium.launch({ executablePath: CHROME, args: CHROME_ARGS, timeout: 60000 });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 400)); else if (process.env.PROCEDURAL_ANIMALS_VERBOSE) console.log('[page] ' + m.text()); });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await browser.close().catch(() => {}); } };
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { close().finally(() => process.exit(130)); });
  return { browser, page, errors, close };
}

/** page.evaluate with a timeout and a readable error (includes page errors so far). */
export async function evalT(ctx, fn, arg, ms = 180000, what = 'page step') {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); });
  try {
    return await Promise.race([ctx.page.evaluate(fn, arg), t]);
  } catch (e) {
    const extra = ctx.errors.length ? '\n  page errors:\n  ' + ctx.errors.slice(-5).join('\n  ') : '';
    throw new Error(`${what}: ${e.message.split('\n')[0]}${extra}`);
  } finally { clearTimeout(timer); }
}

/** Build (if needed) and open the harness page. A rebuild goes to a file of this process's own (several
 *  tools running at once in one checkout would otherwise overwrite each other's page mid-load). */
export async function openHarness(ctx, { rebuild = true } = {}) {
  let html = path.join(OUT, 'harness.html');
  if (rebuild || !fs.existsSync(html)) {
    const { buildHarness } = await import('../harness/build.mjs');
    if (rebuild) html = path.join(OUT, 'harness', `harness-${process.pid}.html`);
    await buildHarness({ out: html });
    if (rebuild) process.once('exit', () => { try { fs.unlinkSync(html); } catch (e) { /* already gone */ } });
  }
  await ctx.page.goto('file://' + html);
  await ctx.page.waitForFunction(() => window.__animals && window.__animals.ready === true, null, { timeout: 60000 })
    .catch((e) => { throw new Error('harness did not become ready: ' + e.message + '\n' + ctx.errors.join('\n')); });
}

/** Write a data: URL PNG to a file. */
export function writeDataUrl(file, url) {
  fs.writeFileSync(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  return file;
}

/**
 * Compose a contact sheet with python3 + PIL.
 * spec: { out, title?, rows: [{ label, tiles: [{ file, label?, sub? }] }], cols?, bg? }
 */
export function composeSheet(spec) {
  const tmp = path.join(mkdirp(path.join(OUT, 'tmp')), `sheet_${process.pid}_${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(spec));
  const r = spawnSync('python3', [path.join(TOOLS, 'lib', 'sheet.py'), tmp], { encoding: 'utf8' });
  fs.rmSync(tmp, { force: true });
  if (r.status !== 0) throw new Error('sheet composition failed: ' + (r.stderr || r.stdout || r.error));
  return spec.out;
}

export function loadThresholds(file = path.join(TOOLS, 'thresholds.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const fmt = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '-' : typeof x === 'number' ? (Math.abs(x) >= 1e4 ? x.toFixed(0) : x.toFixed(d)) : String(x));
