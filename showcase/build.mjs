// Builds the showcase into one self-contained page:
//   dist/showcase.html       full HTML document
//   dist/showcase.body.html  the same without <html>/<head>/<body> (for artifact hosting)
//   dist/pages/              with --pages: a static site for GitHub Pages (index.html + .nojekyll); the
//                            page has no other files, so it works from any sub-path
// Everything is inlined: three.js, the library, and the build worker (its source becomes a Blob URL that
// is handed to setWorkerFactory). The only external resource is the Google Fonts stylesheet.
//
//   node showcase/build.mjs [--no-min] [--pages]   (npm run build:pages)
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(root, 'dist');
const minify = !process.argv.includes('--no-min');
const pages = process.argv.includes('--pages');
fs.mkdirSync(out, { recursive: true });

const common = {
  bundle: true, format: 'iife', minify, write: false, target: ['es2020'], legalComments: 'none', logLevel: 'warning',
  absWorkingDir: root,
  // the library's default worker URL is never used here (a factory is installed), keep esbuild quiet
  define: { 'import.meta.url': '"about:blank"' },
};
const t0 = Date.now();
const worker = await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/worker.js')] });
const workerSrc = worker.outputFiles[0].text;
const app = await esbuild.build({ ...common, entryPoints: [path.join(here, 'src/main.js')], define: { ...common.define, __WORKER_SRC__: JSON.stringify(workerSrc) } });
const js = app.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const body = fs.readFileSync(path.join(here, 'page.html'), 'utf8').replace('/*__APP__*/', () => js);
const full = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1d1812">
</head>
<body>
${body}
</body>
</html>
`;
fs.writeFileSync(path.join(out, 'showcase.html'), full);
fs.writeFileSync(path.join(out, 'showcase.body.html'), body);
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`showcase: ${kb(Buffer.byteLength(full))} (worker ${kb(workerSrc.length)}, app ${kb(js.length)})${minify ? '' : ' unminified'} in ${Date.now() - t0} ms -> dist/showcase.html, dist/showcase.body.html`);
if (pages) {
  const site = path.join(out, 'pages');
  fs.rmSync(site, { recursive: true, force: true });
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), full);
  fs.writeFileSync(path.join(site, '.nojekyll'), '');
  console.log('pages: dist/pages/index.html (+ .nojekyll)');
}
