// Random reversible-program generator for differential testing.
// Programs are well-formed (they pass the static checker) but their runtime
// assertions are random, so many of them fault: the property under test is that
// the compiled VM and the reference interpreter agree on *which* ones fault and,
// for the rest, on every bit of the final store and output tape.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export function genProgram(seed) {
  const R = rng(seed);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const int = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
  const SCAL = ['a', 'b', 'c', 'd'];
  let localId = 0;

  function expr(vars, depth) {
    const r = R();
    if (depth <= 0 || r < 0.3) {
      const k = R();
      if (k < 0.35 || !vars.length) return String(int(-20, 40));
      if (k < 0.8) return pick(vars);
      if (k < 0.9) return `arr[${int(0, 4)}]`;
      return pick(['size(arr)', 'size(st)', 'empty(st)']);
    }
    if (r < 0.4) return `arr[(${expr(vars, depth - 1)}) % 6]`; // sometimes out of bounds on purpose
    if (r < 0.48) return pick(['-', '!', '~']) + `(${expr(vars, depth - 1)})`;
    if (r < 0.53) return `${pick(['sqrt', 'abs'])}(${expr(vars, depth - 1)})`;
    if (r < 0.56) return 'top(st)';
    const op = pick(['+', '-', '*', '+', '-', '/', '%', '&', '|', '^', '<<', '>>', '>>>', '<', '<=', '>', '>=', '=', '!=', '&&', '||']);
    return `(${expr(vars, depth - 1)} ${op} ${expr(vars, depth - 1)})`;
  }

  function block(scal, depth, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(...stmt(scal, depth));
    return out;
  }
  let allowCalls = true;
  function stmt(scal, depth) {
    const r = R();
    const tgtScalar = pick(scal);
    const others = scal.filter((v) => v !== tgtScalar);
    if (r < 0.32) return [`${tgtScalar} ${pick(['+=', '-=', '^='])} ${expr(others, 2)}`];
    if (r < 0.42) return [`arr[(${expr(scal, 1)}) % 5] ${pick(['+=', '-=', '^='])} ${expr(scal, 2)}`];
    if (r < 0.48) return [`${tgtScalar} <=> ${pick(others)}`];
    if (r < 0.52) return [`arr[${int(0, 4)}] <=> ${R() < 0.5 ? `arr[${int(0, 4)}]` : pick(scal)}`];
    if (r < 0.57) return [`write ${expr(scal, 2)}`];
    if (depth > 0 && r < 0.68) {
      const c = expr(scal, 2);
      const assert = R() < 0.6 ? c : expr(scal, 2);
      return [`if ${c} then`, ...indent(block(scal, depth - 1, int(0, 3))), `else`, ...indent(block(scal, depth - 1, int(0, 2))), `fi ${assert}`];
    }
    if (depth > 0 && r < 0.76) {
      const i = `i${localId++}`;
      const k = int(0, 5);
      return [`local int ${i} = 0`, `from ${i} = 0 do`, ...indent(block(scal, depth - 1, int(0, 2))), `loop`,
        ...indent([...block(scal, depth - 1, int(0, 2)), `${i} += 1`]), `until ${i} = ${k}`, `delocal int ${i} = ${k}`];
    }
    if (depth > 0 && r < 0.82) {
      const t = `t${localId++}`;
      const e = expr(scal, 1);
      return [`local int ${t} = ${e}`, ...indent(block([...scal, t], depth - 1, int(0, 2))), `delocal int ${t} = ${R() < 0.7 ? e : expr(scal, 1)}`];
    }
    if (r < 0.88) {
      const t = `p${localId++}`;
      return [`local int ${t} = ${expr(scal, 1)}`, `push(${t}, st)`, `delocal int ${t} = 0`];
    }
    if (r < 0.92) {
      const t = `q${localId++}`;
      return [`local int ${t} = 0`, `pop(${t}, st)`, `${tgtScalar} += ${t}`, `push(${t}, st)`, `delocal int ${t} = 0`];
    }
    const args = shuffle(scal.slice(), R).slice(0, 2);
    if (args.length < 2 || !allowCalls) return ['skip'];
    return [`${pick(['call', 'uncall'])} helper(${args[0]}, ${args[1]}, arr)`];
  }

  allowCalls = false;
  const helperBody = block(['x', 'y', 'a', 'b'], 1, int(1, 4)).map((l) => l.replace(/\barr\b/g, 'z'))
    .map((l) => l.replace(/size\(z\)/g, 'size(z)'));
  const lines = [
    `int a = ${int(-50, 50)}`, `int b = ${int(-50, 50)}`, `int c = ${int(-50, 50)}`, `int d = ${int(-50, 50)}`,
    `int arr[5] = {${[0, 0, 0, 0, 0].map(() => int(-9, 9)).join(', ')}}`,
    `stack st[12]`,
    `procedure main()`,
    ...(allowCalls = true, []),
    ...indent([`local int s0 = ${int(1, 9)}`, `push(s0, st)`, `delocal int s0 = 0`, ...block(SCAL, 3, int(2, 7))]),
    `procedure helper(int x, int y, int z[])`,
    ...indent(helperBody.length ? helperBody : ['skip']),
  ];
  return lines.join('\n') + '\n';
}
const indent = (ls) => ls.map((l) => '  ' + l);
function shuffle(a, R) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
