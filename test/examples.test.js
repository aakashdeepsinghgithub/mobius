import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, VM, Interpreter } from '../src/index.js';
import { example, exampleNames, runBoth } from './util.js';

for (const name of exampleNames()) {
  test(`${name}: VM and reference interpreter agree, and time runs both ways`, () => {
    const { ast, it, iErr, vm, origin, initial } = runBoth(example(name));
    assert.equal(iErr, null, `interpreter failed: ${iErr?.message}`);
    assert.equal(vm.status, 'halted', `vm: ${vm.fault?.msg}`);
    assert.deepEqual(vm.snapshot(), it.snapshot(), 'final stores differ');
    assert.deepEqual(vm.tape, it.tape, 'output tapes differ');
    const final = vm.snapshot();

    // 1. T⁻¹ (unstep) walks all the way back to the origin with no history.
    const fwd = vm.t;
    const back = vm.runBack();
    assert.equal(back, fwd, 'unstep count must equal step count');
    assert.equal(vm.fingerprint(), origin, 'unstepping did not restore the exact initial machine state');

    // 2. The inverse *program* (uncall main), started from the final store, yields the initial store.
    const vm2 = new VM(vm.program);
    vm2.run();               // final store + full output tape
    vm2.reverseFromOrigin(); // now execute main⁻¹ on it (it consumes the tape: unwrite)
    vm2.run();
    assert.equal(vm2.status, 'start', `inverse run: ${vm2.fault?.msg}`);
    assert.deepEqual(vm2.snapshot(), initial);
    assert.equal(vm2.tape.length, 0);

    // 3. Same thing in the interpreter: run I[main] on the final store.
    const it2 = new Interpreter(ast);
    it2.run(1); it2.run(-1);
    assert.deepEqual(it2.snapshot(), initial);
    assert.notDeepEqual(final, initial, 'example should do something');
  });
}

test('TEA example matches a reference TEA implementation bit-for-bit', () => {
  const { program } = build(example('cipher'));
  const vm = new VM(program);
  const before = vm.snapshot();
  vm.run();
  const key = before.key.map((x) => x >>> 0);
  const ref = [];
  for (let b = 0; b < before.data.length; b += 2) {
    let v0 = before.data[b] >>> 0, v1 = before.data[b + 1] >>> 0, sum = 0;
    for (let i = 0; i < 32; i++) {
      sum = (sum + 0x9e3779b9) >>> 0;
      v0 = (v0 + ((((v1 << 4) + key[0]) ^ (v1 + sum) ^ ((v1 >>> 5) + key[1])) >>> 0)) >>> 0;
      v1 = (v1 + ((((v0 << 4) + key[2]) ^ (v0 + sum) ^ ((v0 >>> 5) + key[3])) >>> 0)) >>> 0;
    }
    ref.push(v0 | 0, v1 | 0);
  }
  assert.deepEqual(vm.snapshot().data, ref);
});

test('Bennett: collatz leaves no garbage', () => {
  const { vm } = runBoth(example('collatz'));
  const s = vm.snapshot();
  assert.equal(s.answer, 111);
  assert.equal(s.n, 27);
  assert.deepEqual(s.trail, []);
  assert.equal(s.steps, 0);
});

test('Lehmer: decoding is uncall of encoding', () => {
  const { vm } = runBoth(example('lehmer'));
  const s = vm.snapshot();
  assert.deepEqual([...s.perm].sort(), [0, 1, 0, 2, 1, 4, 3, 2].sort());
  assert.deepEqual([...s.code].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('every single step of fib is undone exactly by unstep', () => {
  const { program } = build(example('fib'));
  const vm = new VM(program);
  let n = 0;
  for (;;) {
    const before = vm.fingerprint();
    if (!vm.step()) break;
    const after = vm.fingerprint();
    vm.unstep();
    assert.equal(vm.fingerprint(), before, `unstep(step(s)) != s at t=${n}`);
    vm.step();
    assert.equal(vm.fingerprint(), after);
    n++;
  }
  assert.ok(n > 1000);
});
