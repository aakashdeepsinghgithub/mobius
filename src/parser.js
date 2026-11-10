// Möbius front-end: lexer + recursive-descent parser producing a plain-object AST.
import { MobiusError, BINOPS, UNOPS } from './errors.js';

const KEYWORDS = new Set([
  'procedure', 'int', 'stack', 'const', 'if', 'then', 'else', 'fi', 'from', 'do', 'loop', 'until',
  'call', 'uncall', 'local', 'delocal', 'push', 'pop', 'skip', 'write', 'unwrite', 'plot', 'unplot',
]);
// Longest-first so that '<=>' wins over '<=' and '>>>' over '>>'.
const OPS = ['<=>', '>>>', '+=', '-=', '^=', '<=', '>=', '!=', '==', '&&', '||', '<<', '>>',
  '+', '-', '*', '/', '%', '&', '|', '^', '<', '>', '=', '!', '~', '(', ')', '[', ']', '{', '}', ',', ';'];
export const BUILTINS = new Set(['size', 'top', 'empty', 'sqrt', 'abs']);

export function lex(src) {
  const toks = [];
  const pragmas = [];
  let i = 0, line = 1, col = 1;
  const adv = (n = 1) => { for (let k = 0; k < n; k++) { if (src[i] === '\n') { line++; col = 1; } else col++; i++; } };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { adv(); continue; }
    if (c === '/' && src[i + 1] === '/') {
      let j = i; while (j < src.length && src[j] !== '\n') j++;
      const text = src.slice(i, j);
      if (text.startsWith('//@')) pragmas.push({ line, text: text.slice(3).trim() });
      adv(j - i); continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) throw new MobiusError('syntax', 'unterminated comment', line, col);
      adv(j + 2 - i); continue;
    }
    const L = line, C = col;
    if (/[0-9]/.test(c)) {
      let m = /^(0x[0-9a-fA-F_]+|0b[01_]+|[0-9_]+)/.exec(src.slice(i));
      const raw = m[1].replace(/_/g, '');
      let v = raw.startsWith('0b') ? parseInt(raw.slice(2), 2) : Number(raw);
      if (!Number.isFinite(v) || v > 0xffffffff) throw new MobiusError('syntax', `integer literal ${m[1]} does not fit in 32 bits`, L, C);
      toks.push({ k: 'num', v: v | 0, line: L, col: C });
      adv(m[1].length); continue;
    }
    if (c === "'") {
      const m = /^'(\\.|[^\\'])'/.exec(src.slice(i));
      if (!m) throw new MobiusError('syntax', 'bad character literal', L, C);
      const body = m[1];
      const map = { '\\n': 10, '\\t': 9, '\\0': 0, "\\'": 39, '\\\\': 92 };
      toks.push({ k: 'num', v: body.length === 1 ? body.charCodeAt(0) : (map[body] ?? body.charCodeAt(1)), line: L, col: C });
      adv(m[0].length); continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const w = m[0];
      toks.push({ k: KEYWORDS.has(w) ? 'kw' : 'id', v: w, line: L, col: C });
      adv(w.length); continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new MobiusError('syntax', `unexpected character '${c}'`, L, C);
    toks.push({ k: 'op', v: op === '==' ? '=' : op, line: L, col: C });
    adv(op.length);
  }
  toks.push({ k: 'eof', v: '<end of file>', line, col });
  return { toks, pragmas };
}

// Binary precedence table (higher binds tighter). '&&'/'||' short-circuit.
const PREC = [
  ['||'], ['&&'], ['|'], ['^'], ['&'], ['=', '!='], ['<', '<=', '>', '>='], ['<<', '>>', '>>>'], ['+', '-'], ['*', '/', '%'],
];

export function parse(src) {
  const { toks, pragmas } = lex(src);
  let p = 0;
  const consts = new Map();
  const peek = (o = 0) => toks[p + o];
  const at = (k, v) => peek().k === k && (v === undefined || peek().v === v);
  const isOp = (v) => at('op', v);
  const isKw = (v) => at('kw', v);
  const err = (msg, t = peek()) => new MobiusError('syntax', msg, t.line, t.col);
  const expect = (k, v) => {
    if (!at(k, v)) throw err(`expected ${v ?? k} but found '${peek().v}'`);
    return toks[p++];
  };
  const ident = () => expect('id').v;
  const optSemi = () => { while (isOp(';')) p++; };

  // ---------- expressions ----------
  function expr(level = 0) {
    if (level === PREC.length) return unary();
    let l = expr(level + 1);
    while (peek().k === 'op' && PREC[level].includes(peek().v)) {
      const t = toks[p++];
      const r = expr(level + 1);
      l = fold({ t: 'bin', op: t.v, l, r, line: t.line });
    }
    return l;
  }
  function unary() {
    const t = peek();
    if (isOp('-')) { p++; return fold({ t: 'un', op: 'neg', e: unary(), line: t.line }); }
    if (isOp('!')) { p++; return fold({ t: 'un', op: 'not', e: unary(), line: t.line }); }
    if (isOp('~')) { p++; return fold({ t: 'un', op: 'bnot', e: unary(), line: t.line }); }
    return primary();
  }
  function primary() {
    const t = peek();
    if (t.k === 'num') { p++; return { t: 'num', v: t.v, line: t.line }; }
    if (isOp('(')) { p++; const e = expr(); expect('op', ')'); return e; }
    if (t.k === 'id') {
      p++;
      if (BUILTINS.has(t.v) && isOp('(')) {
        p++; const a = expr(); expect('op', ')');
        if (t.v === 'sqrt' || t.v === 'abs') return fold({ t: 'un', op: t.v, e: a, line: t.line });
        if (a.t !== 'var') throw err(`${t.v}() expects a variable name`, t);
        return { t: 'builtin', fn: t.v, name: a.name, line: t.line };
      }
      if (consts.has(t.v)) return { t: 'num', v: consts.get(t.v), line: t.line };
      if (isOp('[')) { p++; const idx = expr(); expect('op', ']'); return { t: 'idx', name: t.v, index: idx, line: t.line }; }
      return { t: 'var', name: t.v, line: t.line };
    }
    throw err(`unexpected '${t.v}' in expression`);
  }
  // Constant folding keeps compiled code small; semantics are identical.
  function fold(n) {
    if (n.t === 'bin' && n.l.t === 'num' && n.r.t === 'num' && BINOPS[n.op]) {
      const v = BINOPS[n.op](n.l.v, n.r.v);
      if (v !== null) return { t: 'num', v, line: n.line };
    }
    if (n.t === 'bin' && (n.op === '&&' || n.op === '||') && n.l.t === 'num' && n.r.t === 'num') {
      const v = n.op === '&&' ? +(n.l.v !== 0 && n.r.v !== 0) : +(n.l.v !== 0 || n.r.v !== 0);
      return { t: 'num', v, line: n.line };
    }
    if (n.t === 'un' && n.e.t === 'num') return { t: 'num', v: UNOPS[n.op](n.e.v), line: n.line };
    return n;
  }
  function constExpr() {
    const t = peek();
    const e = expr();
    if (e.t !== 'num') throw err('expected a compile-time constant', t);
    return e.v;
  }

  // ---------- statements ----------
  function lval() {
    const t = expect('id');
    if (consts.has(t.v)) throw err(`cannot modify constant '${t.v}'`, t);
    if (isOp('[')) { p++; const idx = expr(); expect('op', ']'); return { name: t.v, index: idx, line: t.line }; }
    return { name: t.v, index: null, line: t.line };
  }
  const STOP = new Set(['else', 'fi', 'loop', 'until', 'delocal', 'procedure', 'int', 'stack', 'const']);
  function block() {
    const out = [];
    optSemi();
    while (!at('eof') && !(peek().k === 'kw' && STOP.has(peek().v))) {
      out.push(stmt());
      optSemi();
    }
    return out;
  }
  function stmt() {
    const t = peek();
    const line = t.line;
    if (t.k === 'id') {
      const target = lval();
      if (isOp('<=>')) { p++; return { t: 'swap', a: target, b: lval(), line }; }
      const opTok = peek();
      if (!['+=', '-=', '^='].includes(opTok.v) || opTok.k !== 'op') throw err(`expected '+=', '-=', '^=' or '<=>' after '${target.name}'`);
      p++;
      return { t: 'update', op: opTok.v[0], target, expr: expr(), line };
    }
    if (t.k !== 'kw') throw err(`unexpected '${t.v}' at start of statement`);
    p++;
    switch (t.v) {
      case 'skip': return { t: 'skip', line };
      case 'if': {
        const cond = expr(); expect('kw', 'then');
        const thenB = block();
        let elseB = [];
        if (isKw('else')) { p++; elseB = block(); }
        expect('kw', 'fi');
        const assert = expr();
        return { t: 'if', cond, then: thenB, else: elseB, assert, line };
      }
      case 'from': {
        const from = expr();
        let doB = [], loopB = [];
        if (isKw('do')) { p++; doB = block(); }
        if (isKw('loop')) { p++; loopB = block(); }
        expect('kw', 'until');
        const until = expr();
        return { t: 'loop', from, doBody: doB, loopBody: loopB, until, line };
      }
      case 'call': case 'uncall': {
        const name = ident(); expect('op', '(');
        const args = [];
        if (!isOp(')')) { do { args.push(ident()); } while (isOp(',') && ++p); }
        expect('op', ')');
        return { t: t.v, name, args, line };
      }
      case 'local': {
        if (isKw('int')) p++;
        const name = ident(); expect('op', '=');
        const init = expr();
        const body = block();
        const dt = expect('kw', 'delocal');
        if (isKw('int')) p++;
        const dn = expect('id');
        if (dn.v !== name) throw err(`delocal '${dn.v}' does not match innermost local '${name}' (line ${line})`, dn);
        expect('op', '=');
        const final = expr();
        return { t: 'local', name, init, body, final, line, endLine: dt.line };
      }
      case 'push': case 'pop': {
        expect('op', '('); const v = ident(); expect('op', ','); const s = ident(); expect('op', ')');
        return { t: t.v, v, s, line };
      }
      case 'write': case 'unwrite': return { t: t.v, e: expr(), line };
      case 'plot': case 'unplot': {
        const x = expr(); expect('op', ','); const y = expr();
        let c = { t: 'num', v: 0, line };
        if (isOp(',')) { p++; c = expr(); }
        return { t: t.v, x, y, c, line };
      }
      default: throw err(`unexpected keyword '${t.v}'`, t);
    }
  }

  // ---------- top level ----------
  const globals = [];
  const procs = new Map();
  while (!at('eof')) {
    const t = peek();
    if (isKw('const')) {
      p++; if (isKw('int')) p++;
      const name = ident(); expect('op', '=');
      consts.set(name, constExpr());
      optSemi();
    } else if (isKw('int')) {
      p++;
      const nameTok = expect('id');
      let g;
      if (isOp('[')) {
        p++; const n = constExpr(); expect('op', ']');
        if (n <= 0 || n > 60000) throw err(`array size must be in 1..60000`, nameTok);
        g = { kind: 'array', name: nameTok.v, size: n, init: null, line: nameTok.line };
        if (isOp('=')) {
          p++; expect('op', '{');
          const vals = [];
          if (!isOp('}')) { do { vals.push(constExpr()); } while (isOp(',') && ++p); }
          expect('op', '}');
          if (vals.length > n) throw err(`initializer has ${vals.length} values but '${g.name}' holds ${n}`, nameTok);
          g.init = vals;
        }
      } else {
        g = { kind: 'int', name: nameTok.v, init: 0, line: nameTok.line };
        if (isOp('=')) { p++; g.init = constExpr(); }
      }
      globals.push(g); optSemi();
    } else if (isKw('stack')) {
      p++;
      const nameTok = expect('id');
      let cap = 256;
      if (isOp('[')) { p++; cap = constExpr(); expect('op', ']'); }
      globals.push({ kind: 'stack', name: nameTok.v, cap, line: nameTok.line });
      optSemi();
    } else if (isKw('procedure')) {
      p++;
      const name = ident();
      expect('op', '(');
      const params = [];
      if (!isOp(')')) {
        do {
          const pt = peek();
          if (isKw('int')) {
            p++; const pn = ident();
            if (isOp('[')) { p++; expect('op', ']'); params.push({ kind: 'array', name: pn, line: pt.line }); }
            else params.push({ kind: 'int', name: pn, line: pt.line });
          } else if (isKw('stack')) { p++; params.push({ kind: 'stack', name: ident(), line: pt.line }); }
          else throw err(`expected parameter type 'int' or 'stack'`);
        } while (isOp(',') && ++p);
      }
      expect('op', ')');
      if (procs.has(name)) throw err(`procedure '${name}' defined twice`, t);
      const body = block();
      if (isKw('delocal')) throw err(`'delocal' without matching 'local'`);
      if (!at('eof') && !isKw('procedure') && !isKw('int') && !isKw('stack') && !isKw('const'))
        throw err(`unexpected '${peek().v}' (unbalanced if/fi or from/until?)`);
      procs.set(name, { name, params, body, line: t.line });
    } else {
      throw err(`expected a declaration or procedure, found '${t.v}'`);
    }
  }

  const meta = { title: null, viz: [], plot: null };
  for (const pr of pragmas) {
    const [cmd, ...rest] = pr.text.split(/\s+/);
    if (cmd === 'title') meta.title = rest.join(' ');
    else if (cmd === 'viz') meta.viz.push({ name: rest[0], width: Number(rest[1]) || 0, mode: rest[2] || 'binary' });
    else if (cmd === 'plot') meta.plot = rest.map(Number);
    else if (cmd === 'desc') meta.desc = (meta.desc ? meta.desc + ' ' : '') + rest.join(' ');
  }
  return { globals, procs, consts, meta };
}
