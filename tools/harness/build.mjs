// Builds the test harness page: out/harness.html (src + tools/harness/harness.js, worker inlined).
//   node tools/harness/build.mjs [--min]
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

export async function buildHarness({ minify = false, out = path.join(ROOT, 'out', 'harness.html') } = {}) {
  const t0 = Date.now();
  const common = { bundle: true, format: 'iife', minify, write: false, target: ['es2020'], legalComments: 'none', logLevel: 'error', absWorkingDir: ROOT };
  const worker = await esbuild.build({ ...common, entryPoints: [path.join(ROOT, 'src', 'worker.js')] });
  const workerSrc = worker.outputFiles[0].text;
  const res = await esbuild.build({ ...common, entryPoints: [path.join(HERE, 'harness.js')], define: { __WORKER_SRC__: JSON.stringify(workerSrc) } });
  const js = res.outputFiles[0].text.replace(/<\/script>/g, '<\\/script>');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>procedural-animals harness</title>
<style>html,body{margin:0;background:#222;overflow:hidden}canvas{display:block}</style></head>
<body><script>${js}</script></body></html>`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  return { out, kb: Math.round(html.length / 1024), ms: Date.now() - t0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await buildHarness({ minify: process.argv.includes('--min') });
  console.log(`harness built: ${path.relative(process.cwd(), r.out)} (${r.kb} KB, ${r.ms} ms)`);
}
