#!/usr/bin/env node
// Möbius command-line driver.
import fs from 'node:fs';
import { build, VM, Interpreter, showProgram, invertProgram, formatInstr, MobiusError } from '../src/index.js';

const USAGE = `mobius — a reversible language, compiler and reversible machine

usage:
  mobius run <file.mob>        compile, run forward on the MRM, print globals + tape
  mobius uncall <file.mob>     run forward, then execute main⁻¹ on the result (round trip)
  mobius rewind <file.mob>     run forward, then unstep (T⁻¹) back to t = 0 with zero history
  mobius invert <file.mob>     print the inverse program I[p] as Möbius source
  mobius asm <file.mob>        print the MRM assembly listing
  mobius interp <file.mob>     run on the reference AST interpreter instead
  mobius verify <file.mob>     check T⁻¹∘T = id at every step, and VM ≡ interpreter`;

const [cmd, file] = process.argv.slice(2);
if (!cmd || !file) { console.log(USAGE); process.exit(cmd ? 1 : 0); }

const show = (snap) => Object.entries(snap).map(([k, v]) => `  ${k.padEnd(10)} = ${Array.isArray(v) ? '[' + v.join(', ') + ']' : v}`).join('\n');
const tape = (t) => (t.length ? '  tape: ' + t.slice(0, 40).map((e) => (e.k === 'w' ? e.v : `(${e.x},${e.y})`)).join(' ') + (t.length > 40 ? ` … (${t.length} entries)` : '') : '');

try {
  const src = fs.readFileSync(file, 'utf8');
  const { ast, program } = build(src);
  const vm = new VM(program);
  const t0 = performance.now();
  switch (cmd) {
    case 'run': {
      vm.run();
      report(vm, t0);
      console.log(show(vm.snapshot())); console.log(tape(vm.tape));
      break;
    }
    case 'uncall': {
      vm.run(); report(vm, t0);
      console.log('after main:\n' + show(vm.snapshot()));
      vm.reverseFromOrigin(); vm.run();
      console.log(`after main⁻¹ (status ${vm.status}):\n` + show(vm.snapshot()));
      break;
    }
    case 'rewind': {
      const f0 = vm.fingerprint();
      vm.run(); report(vm, t0);
      const t1 = performance.now();
      const n = vm.runBack();
      console.log(`unstepped ${n} instructions in ${(performance.now() - t1).toFixed(0)} ms using ${vm.historyBytes} bytes of history`);
      console.log(`machine state identical to t = 0: ${vm.fingerprint() === f0}`);
      break;
    }
    case 'invert': console.log(showProgram(invertProgram(ast))); break;
    case 'asm': {
      program.code.forEach((ins, a) => {
        if (program.procAt.has(a)) console.log(`\n${program.procAt.get(a)}:`);
        console.log(`${String(a).padStart(6)}  ${formatInstr(ins, a).padEnd(34)} ${ins.note ? '; ' + ins.note : ins.line ? '; line ' + ins.line : ''}`);
      });
      break;
    }
    case 'interp': {
      const it = new Interpreter(ast).run(1);
      console.log(show(it.snapshot())); console.log(tape(it.tape));
      break;
    }
    case 'verify': {
      const f0 = vm.fingerprint();
      let n = 0;
      for (;;) {
        const before = vm.fingerprint();
        if (!vm.step()) break;
        const after = vm.fingerprint();
        vm.unstep();
        if (vm.fingerprint() !== before) throw new Error(`T⁻¹(T(s)) ≠ s at t = ${n}, pc = ${vm.pc}`);
        vm.step();
        if (vm.fingerprint() !== after) throw new Error(`T(T⁻¹(s)) ≠ s at t = ${n}`);
        n++;
      }
      report(vm, t0);
      const it = new Interpreter(ast).run(1);
      const same = JSON.stringify(it.snapshot()) === JSON.stringify(vm.snapshot()) && JSON.stringify(it.tape) === JSON.stringify(vm.tape);
      vm.runBack();
      console.log(`✓ T⁻¹∘T = id and T∘T⁻¹ = id on all ${n} reachable states`);
      console.log(`${same ? '✓' : '✗'} compiled VM agrees with the reference interpreter`);
      console.log(`${vm.fingerprint() === f0 ? '✓' : '✗'} full rewind restores t = 0 exactly`);
      if (!same) process.exit(1);
      break;
    }
    default: console.log(USAGE); process.exit(1);
  }
} catch (e) {
  if (e instanceof MobiusError) { console.error(e.message); process.exit(2); }
  throw e;
}

function report(vm, t0) {
  const ms = performance.now() - t0;
  const where = vm.fault ? ` — fault at line ${vm.fault.line}: ${vm.fault.msg}` : '';
  console.log(`${vm.status} after ${vm.t} instructions (${ms.toFixed(0)} ms)${where}`);
}
