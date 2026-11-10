import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, VM, Interpreter } from '../src/index.js';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const example = (n) => fs.readFileSync(path.join(root, 'examples', n + '.mob'), 'utf8');
export const exampleNames = () => fs.readdirSync(path.join(root, 'examples')).filter((f) => f.endsWith('.mob')).map((f) => f.slice(0, -4));

/** Run a program on both engines and return a comparable summary. */
export function runBoth(src, { fuel } = {}) {
  const { ast, program } = build(src);
  const it = new Interpreter(ast, fuel ? { fuel } : {});
  let iErr = null;
  try { it.run(1); } catch (e) { if (e.kind !== 'runtime') throw e; iErr = e; }
  const vm = new VM(program);
  const origin = vm.fingerprint();
  const initial = vm.snapshot();
  vm.run();
  return { ast, program, it, iErr, vm, origin, initial };
}
