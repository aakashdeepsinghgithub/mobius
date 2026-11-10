import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, VM, Interpreter, parse, check, showProgram, invertProgram } from '../src/index.js';
import { example, exampleNames } from './util.js';

const staticErr = (src, re) => assert.throws(() => build(src), (e) => (e.kind === 'static' || e.kind === 'syntax') && re.test(e.message));

test('static checker rejects irreversible constructs', () => {
  staticErr('int x\nprocedure main()\n  x += x + 1', /may not appear on the right/);
  staticErr('int x\nint y\nprocedure f(int a, int b)\n  a += b\nprocedure main()\n  call f(x, x)', /passed twice/);
  staticErr('int x\nprocedure main()\n  y += 1', /undeclared/);
  staticErr('int a[3]\nprocedure main()\n  a += 1', /expected an int/);
  staticErr('int x\nprocedure main()\n  local int t = 1\n  x += t\n  delocal int t = t', /may not mention/);
  staticErr('int x\nprocedure f()\n  skip', /no 'procedure main/);
  staticErr('int x\nprocedure main()\n  if x = 0 then x += 1', /expected fi/);
  staticErr('const K = 3\nprocedure main()\n  K += 1', /constant/);
  staticErr('int a[4]\nprocedure main()\n  a[9] += 1', /out of bounds/);
});

// Each runtime fault must be detected identically by both engines, in the direction it occurs.
const faults = {
  'if exit assertion': ['int x\nprocedure main()\n  if x = 0 then\n    x += 1\n  fi x = 0', /exit assertion/],
  'loop entry assertion on re-entry': ['int i\nprocedure main()\n  from i = 0 loop\n    i -= 1\n    i += 1\n  until i = 3', /entry assertion/],
  'delocal mismatch': ['int x\nprocedure main()\n  local int t = 5\n    x += t\n    t += 1\n  delocal int t = 5', /delocal/],
  'pop from empty stack': ['stack s\nint x\nprocedure main()\n  pop(x, s)', /empty/],
  'pop into nonzero': ['stack s\nint x = 3\nint y = 4\nprocedure main()\n  push(y, s)\n  pop(x, s)', /zero/],
  'stack overflow': ['stack s[2]\nint x\nprocedure main()\n  x += 1\n  push(x, s)\n  x += 1\n  push(x, s)\n  x += 1\n  push(x, s)', /full/],
  'index out of bounds': ['int a[3]\nint i = 3\nprocedure main()\n  a[i] += 1', /bounds/],
  'division by zero': ['int x\nint y\nprocedure main()\n  x += 10 / y', /division by zero/],
  'aliasing through a global': ['int g = 5\nprocedure f(int x)\n  x += g\nprocedure main()\n  call f(g)', /aliasing|invertible/],
  'array self-read': ['int a[3] = {0, 1, 2}\nprocedure main()\n  a[a[0]] += 7', /aliasing|invertible/],
};
for (const [name, [src, re]] of Object.entries(faults)) {
  test(`runtime fault: ${name}`, () => {
    const { ast, program } = build(src);
    assert.throws(() => new Interpreter(ast).run(1), re);
    const vm = new VM(program);
    const o = vm.fingerprint();
    vm.run();
    assert.equal(vm.status, 'trap');
    assert.match(vm.fault.msg, re);
    vm.runBack();
    assert.equal(vm.fingerprint(), o, 'a faulted machine still rewinds exactly');
  });
}

test('uncall with inputs outside the domain faults (partial bijection)', () => {
  // f maps x -> x+1 only when x is even (assertion), so f⁻¹ is defined only on odd inputs.
  const src = 'int x = 4\nprocedure f(int x)\n  if x % 2 = 0 then\n    x += 1\n  fi x % 2 = 1\nprocedure main()\n  uncall f(x)';
  const { ast, program } = build(src);
  assert.throws(() => new Interpreter(ast).run(1), /exit assertion|disagrees/);
  const vm = new VM(program); vm.run();
  assert.equal(vm.status, 'trap');
});

test('inversion is an involution and pretty-printing round-trips', () => {
  for (const n of exampleNames()) {
    const ast = check(parse(example(n)));
    const once = showProgram(invertProgram(ast));
    const twice = showProgram(invertProgram(check(parse(once))));
    assert.equal(twice, showProgram(ast), `${n}: I[I[p]] != p`);
    assert.equal(showProgram(check(parse(showProgram(ast)))), showProgram(ast), `${n}: print/parse not idempotent`);
  }
});

test('machine invariants: scratch, sp, ro and br are clean at halt', () => {
  const { program } = build(example('sort'));
  const vm = new VM(program);
  vm.run();
  assert.equal(vm.status, 'halted');
  for (let r = 3; r < 256; r++) assert.equal(vm.R[r], 0, `r${r} dirty at halt`);
  assert.equal(vm.R[1], program.stackBase, 'sp restored');
  assert.equal(vm.R[2], 0, 'ro clean');
  assert.equal(vm.br, 0);
});
