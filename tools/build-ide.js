// Bundles the toolchain + IDE into one self-contained HTML file: dist/mobius-ide.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORDER = ['intro', 'fib', 'collatz', 'cipher', 'lehmer', 'sort', 'threebody', 'life'];
const examples = ORDER.map((name) => {
  const src = fs.readFileSync(path.join(root, 'examples', name + '.mob'), 'utf8');
  const title = /\/\/@title (.*)/.exec(src)?.[1] ?? name;
  return { name, label: `${name}.mob — ${title}`, src };
});
const res = await build({ entryPoints: [path.join(root, 'web/ide.js')], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020' });
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const json = JSON.stringify(examples).replace(/<\/script/gi, '<\\/script');
let html = fs.readFileSync(path.join(root, 'web/ide.html'), 'utf8');
html = html.replace('/*__EXAMPLES__*/[]', () => json).replace('/*__BUNDLE__*/', () => js);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/mobius-ide.html'), html);
console.log(`dist/mobius-ide.html  ${(html.length / 1024).toFixed(1)} KiB`);
