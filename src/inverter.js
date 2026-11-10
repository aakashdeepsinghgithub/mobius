// Program inversion and pretty-printing.
//
// Every Möbius statement has a syntactic inverse, so a whole program can be
// inverted by a purely local, compositional rewrite — no analysis, no search.
//   I[s1; s2]                      = I[s2]; I[s1]
//   I[x += e]                      = x -= e
//   I[if c then a else b fi d]     = if d then I[a] else I[b] fi c
//   I[from c do a loop b until d]  = from d do I[a] loop I[b] until c
//   I[call p]                      = uncall p
//   I[local x = e ... delocal x = f] = local x = f ... delocal x = e
//   I[push(x,s)]                   = pop(x,s)
//   I[write e]                     = unwrite e

const FLIP = { call: 'uncall', uncall: 'call', push: 'pop', pop: 'push', write: 'unwrite', unwrite: 'write', plot: 'unplot', unplot: 'plot' };

export function invertStmt(s, flipCalls = true) {
  const ib = (b) => invertBlock(b, flipCalls);
  switch (s.t) {
    case 'skip': case 'swap': return s;
    case 'update': return { ...s, op: s.op === '+' ? '-' : s.op === '-' ? '+' : '^' };
    case 'if': return { ...s, cond: s.assert, assert: s.cond, then: ib(s.then), else: ib(s.else) };
    case 'loop': return { ...s, from: s.until, until: s.from, doBody: ib(s.doBody), loopBody: ib(s.loopBody) };
    case 'local': return { ...s, init: s.final, final: s.init, body: ib(s.body) };
    case 'call': case 'uncall': if (!flipCalls) return s;
    // fallthrough
    default:
      if (FLIP[s.t]) return { ...s, t: FLIP[s.t] };
      throw new Error('cannot invert ' + s.t);
  }
}
export const invertBlock = (b, flipCalls = true) => b.slice().reverse().map((s) => invertStmt(s, flipCalls));

// The inverse of a whole program: the same call graph, with every procedure body
// inverted. Calls are *not* flipped, because each callee is itself replaced by its
// inverse:  I[call q] = uncall q = run I[q.body] = call q'.
export function invertProgram(prog) {
  const procs = new Map();
  for (const [n, p] of prog.procs) procs.set(n, { ...p, body: invertBlock(p.body, false) });
  return { ...prog, procs };
}

// ---------------- pretty printer ----------------
const PREC = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '=': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8, '>>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };

export function showExpr(e, ctx = 0) {
  switch (e.t) {
    case 'num': return e.v < 0 && ctx > 0 ? `(${e.v})` : String(e.v);
    case 'var': return e.name;
    case 'idx': return `${e.name}[${showExpr(e.index)}]`;
    case 'builtin': return `${e.fn}(${e.name})`;
    case 'un':
      if (e.op === 'sqrt' || e.op === 'abs') return `${e.op}(${showExpr(e.e)})`;
      return ({ neg: '-', not: '!', bnot: '~' }[e.op]) + showExpr(e.e, 11);
    case 'bin': {
      const p = PREC[e.op];
      const s = `${showExpr(e.l, p)} ${e.op} ${showExpr(e.r, p + 1)}`;
      return p < ctx ? `(${s})` : s;
    }
  }
}
const showLval = (lv) => (lv.index ? `${lv.name}[${showExpr(lv.index)}]` : lv.name);

export function showBlock(b, ind = '  ') {
  return b.map((s) => showStmt(s, ind)).join('\n');
}
export function showStmt(s, ind = '  ') {
  const nest = (b) => (b.length ? showBlock(b, ind + '  ') + '\n' : '');
  switch (s.t) {
    case 'skip': return `${ind}skip`;
    case 'update': return `${ind}${showLval(s.target)} ${s.op}= ${showExpr(s.expr)}`;
    case 'swap': return `${ind}${showLval(s.a)} <=> ${showLval(s.b)}`;
    case 'if':
      return `${ind}if ${showExpr(s.cond)} then\n${nest(s.then)}` + (s.else.length ? `${ind}else\n${nest(s.else)}` : '') + `${ind}fi ${showExpr(s.assert)}`;
    case 'loop':
      return `${ind}from ${showExpr(s.from)}` + (s.doBody.length ? ` do\n${nest(s.doBody)}` : '\n') +
        (s.loopBody.length ? `${ind}loop\n${nest(s.loopBody)}` : '') + `${ind}until ${showExpr(s.until)}`;
    case 'call': case 'uncall': return `${ind}${s.t} ${s.name}(${s.args.join(', ')})`;
    case 'local':
      return `${ind}local int ${s.name} = ${showExpr(s.init)}\n${nest(s.body)}${ind}delocal int ${s.name} = ${showExpr(s.final)}`;
    case 'push': case 'pop': return `${ind}${s.t}(${s.v}, ${s.s})`;
    case 'write': case 'unwrite': return `${ind}${s.t} ${showExpr(s.e)}`;
    case 'plot': case 'unplot': return `${ind}${s.t} ${showExpr(s.x)}, ${showExpr(s.y)}, ${showExpr(s.c)}`;
  }
}
export function showProc(p) {
  const params = p.params.map((x) => (x.kind === 'array' ? `int ${x.name}[]` : `${x.kind} ${x.name}`)).join(', ');
  return `procedure ${p.name}(${params})\n${showBlock(p.body)}\n`;
}
export function showProgram(prog) {
  const out = [];
  for (const [n, v] of prog.consts ?? []) out.push(`const ${n} = ${v}`);
  for (const g of prog.globals) {
    if (g.kind === 'int') out.push(`int ${g.name}${g.init ? ' = ' + g.init : ''}`);
    else if (g.kind === 'array') out.push(`int ${g.name}[${g.size}]${g.init ? ' = {' + g.init.join(', ') + '}' : ''}`);
    else out.push(`stack ${g.name}[${g.cap}]`);
  }
  out.push('');
  for (const p of prog.procs.values()) out.push(showProc(p));
  return out.join('\n');
}
