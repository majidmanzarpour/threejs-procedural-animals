// Quick check: load the built page, wait for the first animal frame, run some JS, screenshot.
//   node showcase/smoke.mjs out.png "<js>" [w h] [query]
// SHOWCASE_URL=http://host/path/ loads that URL instead of dist/showcase.html (e.g. the GitHub Pages
// build served from a sub-path: npm run build:pages, then serve dist/pages).
import { chromium } from 'playwright-core';
import { CHROME, CHROME_ARGS } from '../tools/lib/common.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [out = path.resolve(here, '../out/showcase/smoke.png'), js = '', w = '960', h = '600', query = ''] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: CHROME, args: [...CHROME_ARGS, '--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
const t0 = Date.now();
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const base = process.env.SHOWCASE_URL || 'file://' + path.resolve(here, '../dist/showcase.html');
await page.goto(base + (query ? '?' + query : ''), { waitUntil: 'commit' });
try { await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000 }); } catch (e) { logs.push('TIMEOUT'); }
logs.push('ready ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
if (js) { try { const r = await page.evaluate(js); if (r !== undefined) logs.push('eval: ' + JSON.stringify(r)); } catch (e) { logs.push('EVAL ERROR ' + e.message); } }
await page.screenshot({ path: out, timeout: 240000 });
console.log(logs.slice(-30).join('\n'));
console.log('shot', out, ((Date.now() - t0) / 1000).toFixed(1) + 's');
await browser.close();
