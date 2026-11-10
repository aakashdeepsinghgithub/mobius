import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, VM, Interpreter, parse, check, showProgram, invertProgram, compile } from '../src/index.js';
import { genProgram } from './fuzz.js';

const N = Number(process.env.FUZZ ?? 600);

test(`differential fuzzing: ${N} random reversible programs, VM ≡ interpreter, T⁻¹∘T = id`, () => {
  const stats = { ok: 0, fault: 0, staticRejected: 0 };
  for (let seed = 1; seed <= N; seed++) {
    const src = genProgram(seed);
    let built;
    try { built = build(src); } catch (e) {
      if (e.kind === 'static' || e.kind === 'syntax') { stats.staticRejected++; continue; }
      throw e;
    }
    const { ast, program } = built;
    const it = new Interpreter(ast, { fuel: 2e6 });
    let iErr = null;
    try { it.run(1); } catch (e) { if (e.kind !== 'runtime') throw e; iErr = e; }
    const vm = new VM(program);
    const origin = vm.fingerprint();
    const initial = vm.snapshot();
    vm.run(5e7);
    const ctx = `seed ${seed}\n${src}\ninterp: ${iErr?.message}\nvm: ${vm.status} ${vm.fault?.msg} @line ${vm.fault?.line}`;
    assert.equal(vm.status === 'trap', iErr !== null, 'fault disagreement\n' + ctx);
    if (iErr) {
      stats.fault++;
      // Even a faulted run can be rewound to the origin exactly.
      vm.runBack();
      assert.equal(vm.fingerprint(), origin, 'rewind after fault\n' + ctx);
      continue;
    }
    stats.ok++;
    assert.equal(vm.status, 'halted', ctx);
    assert.deepEqual(vm.snapshot(), it.snapshot(), 'store mismatch\n' + ctx);
    assert.deepEqual(vm.tape, it.tape, 'tape mismatch\n' + ctx);
    // Spot-check local bijectivity on a few steps, then full rewind.
    const total = vm.t;
    vm.runBack();
    assert.equal(vm.fingerprint(), origin, 'rewind\n' + ctx);
    for (let k = 0; k < Math.min(total, 40); k++) {
      const f = vm.fingerprint(); vm.step(); vm.unstep();
      assert.equal(vm.fingerprint(), f, 'local bijectivity\n' + ctx);
      vm.step();
    }
    // Inverse program on the final store restores the initial store (VM).
    const v2 = new VM(program); v2.run(); v2.reverseFromOrigin(); v2.run(5e7);
    assert.equal(v2.status, 'start', 'inverse run\n' + ctx + '\n' + v2.fault?.msg);
    assert.deepEqual(v2.snapshot(), initial, 'inverse store\n' + ctx);
    // Source-level inversion: compile I[program] and run it *forward* on the final store.
    const inv = check(parse(showProgram(invertProgram(ast))));
    const ip = compile(inv);
    const v3 = new VM(ip);
    v3.M.set(v2.M.subarray(0, 0)); // fresh
    const fin = new VM(program); fin.run();
    for (const s of program.symbols) {
      const t = ip.symbols.find((q) => q.name === s.name);
      const len = s.kind === 'int' ? 1 : s.kind === 'array' ? s.size : 2 + s.cap;
      v3.M.set(fin.M.subarray(s.addr, s.addr + len), t.addr);
    }
    v3.tape = fin.tape.map((e) => ({ ...e }));
    v3.run(5e7);
    assert.equal(v3.status, 'halted', 'I[p] run\n' + ctx + '\n' + v3.fault?.msg + '\n' + showProgram(invertProgram(ast)));
    assert.deepEqual(v3.snapshot(), initial, 'I[p] forward ≠ p backward\n' + ctx);
  }
  console.log('fuzz stats', stats);
  assert.ok(stats.ok > N * 0.15, 'too few successful programs: ' + JSON.stringify(stats));
});
