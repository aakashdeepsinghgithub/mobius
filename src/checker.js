// Static semantics. Reversibility is mostly *syntactic* in Möbius: if a program
// passes these checks, every statement denotes a partial bijection on stores.
import { MobiusError } from './errors.js';

export function exprVars(e, out = new Set()) {
  switch (e.t) {
    case 'var': out.add(e.name); break;
    case 'idx': out.add(e.name); exprVars(e.index, out); break;
    case 'builtin': out.add(e.name); break;
    case 'bin': exprVars(e.l, out); exprVars(e.r, out); break;
    case 'un': exprVars(e.e, out); break;
  }
  return out;
}

export function check(prog) {
  const { globals, procs } = prog;
  const gscope = new Map();
  for (const g of globals) {
    if (gscope.has(g.name)) throw new MobiusError('static', `global '${g.name}' declared twice`, g.line);
    if (procs.has(g.name)) throw new MobiusError('static', `'${g.name}' is both a global and a procedure`, g.line);
    gscope.set(g.name, g.kind);
  }
  const main = procs.get('main');
  if (!main) throw new MobiusError('static', `program has no 'procedure main()'`);
  if (main.params.length) throw new MobiusError('static', `main must take no parameters`, main.line);

  for (const proc of procs.values()) {
    const scope = [new Map(gscope), new Map()];
    for (const prm of proc.params) {
      if (scope[1].has(prm.name)) throw new MobiusError('static', `duplicate parameter '${prm.name}'`, prm.line);
      scope[1].set(prm.name, prm.kind);
    }
    const lookup = (name, line) => {
      for (let i = scope.length - 1; i >= 0; i--) if (scope[i].has(name)) return scope[i].get(name);
      throw new MobiusError('static', `undeclared variable '${name}'`, line);
    };
    const want = (name, kind, line, what) => {
      const k = lookup(name, line);
      if (k !== kind) throw new MobiusError('static', `${what}: '${name}' is ${article(k)}, expected ${article(kind)}`, line);
    };
    const chkExpr = (e) => {
      switch (e.t) {
        case 'num': return;
        case 'var': want(e.name, 'int', e.line, 'in expression'); return;
        case 'idx': want(e.name, 'array', e.line, 'indexing'); chkExpr(e.index); return;
        case 'builtin': {
          const k = lookup(e.name, e.line);
          if (e.fn === 'size' && k === 'int') throw new MobiusError('static', `size() needs an array or stack`, e.line);
          if ((e.fn === 'top' || e.fn === 'empty') && k !== 'stack') throw new MobiusError('static', `${e.fn}() needs a stack`, e.line);
          return;
        }
        case 'bin': chkExpr(e.l); chkExpr(e.r); return;
        case 'un': chkExpr(e.e); return;
      }
    };
    const chkLval = (lv) => {
      if (lv.index) { want(lv.name, 'array', lv.line, 'indexing'); chkExpr(lv.index); }
      else want(lv.name, 'int', lv.line, 'assignment target');
    };
    const chkBlock = (b) => b.forEach(chk);
    function chk(s) {
      switch (s.t) {
        case 'skip': return;
        case 'update': {
          chkLval(s.target); chkExpr(s.expr);
          // The defining restriction of reversible update: x += f(x) has no inverse.
          if (!s.target.index && exprVars(s.expr).has(s.target.name))
            throw new MobiusError('static', `'${s.target.name}' may not appear on the right of its own ${s.op}= (the update would not be invertible)`, s.line);
          // a[i] += f(a[j]) is allowed: whether it reads the cell it writes is only
          // known at run time, where both engines check it (see CHKZ).
          return;
        }
        case 'swap': {
          chkLval(s.a); chkLval(s.b);
          for (const side of [s.a, s.b]) if (side.index) {
            const vs = exprVars(side.index);
            for (const other of [s.a, s.b]) if (!other.index && vs.has(other.name))
              throw new MobiusError('static', `swap index may not depend on swapped variable '${other.name}'`, s.line);
          }
          return;
        }
        case 'if': chkExpr(s.cond); chkBlock(s.then); chkBlock(s.else); chkExpr(s.assert); return;
        case 'loop': chkExpr(s.from); chkBlock(s.doBody); chkBlock(s.loopBody); chkExpr(s.until); return;
        case 'call': case 'uncall': {
          const callee = procs.get(s.name);
          if (!callee) throw new MobiusError('static', `unknown procedure '${s.name}'`, s.line);
          if (callee.params.length !== s.args.length)
            throw new MobiusError('static', `'${s.name}' takes ${callee.params.length} argument(s), got ${s.args.length}`, s.line);
          const seen = new Set();
          s.args.forEach((a, i) => {
            want(a, callee.params[i].kind, s.line, `argument ${i + 1} of ${s.name}`);
            if (seen.has(a)) throw new MobiusError('static', `'${a}' passed twice to '${s.name}' (aliased references break reversibility)`, s.line);
            seen.add(a);
          });
          return;
        }
        case 'local': {
          chkExpr(s.init);
          if (exprVars(s.init).has(s.name) && !hasName(scope, s.name)) throw new MobiusError('static', `'${s.name}' used in its own initializer`, s.line);
          scope.push(new Map([[s.name, 'int']]));
          chkBlock(s.body);
          chkExpr(s.final);
          if (exprVars(s.final).has(s.name)) throw new MobiusError('static', `delocal expression for '${s.name}' may not mention '${s.name}' itself`, s.endLine ?? s.line);
          scope.pop();
          return;
        }
        case 'push': case 'pop':
          want(s.v, 'int', s.line, `${s.t}`); want(s.s, 'stack', s.line, `${s.t}`); return;
        case 'write': case 'unwrite': chkExpr(s.e); return;
        case 'plot': case 'unplot': chkExpr(s.x); chkExpr(s.y); chkExpr(s.c); return;
        default: throw new MobiusError('static', `unknown statement ${s.t}`, s.line);
      }
    }
    chkBlock(proc.body);
  }
  return prog;
}

function hasName(scope, n) { return scope.some((m) => m.has(n)); }
function article(k) { return k === 'int' ? 'an int' : k === 'array' ? 'an array' : 'a stack'; }
