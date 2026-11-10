// Möbius → MRM compiler.
//
// The whole compiler is built from one idea: a *straight-line reversible
// sequence* S can be undone by I(S) = reverse(S) with each instruction inverted.
// Expressions are compiled "Bennett style": compute every intermediate into a
// fresh register (S), use the result, then run I(S) to scrub all garbage.
// Statement-level control flow uses paired come-from branches so that the
// same code runs correctly in both directions of time.
import { MobiusError } from './errors.js';
import { OP, OPS, R0, SP, RO, FIRST_SCRATCH, NREG, XBIN, XUN, invertInstr, BRANCHES } from './isa.js';

let labelCounter = 0;
const fresh = (p = 'L') => `${p}${++labelCounter}`;

/** I(S): reverse a straight-line reversible sequence, renaming its internal labels. */
export function invertSeq(items) {
  const map = new Map();
  for (const it of items) if (it.lbl) map.set(it.lbl, fresh());
  const out = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = invertInstr(items[i]);
    if (it.lbl) it.lbl = map.get(it.lbl);
    if (it.tgt && map.has(it.tgt)) it.tgt = map.get(it.tgt);
    out.push(it);
  }
  return out;
}

class Regs {
  constructor(start = FIRST_SCRATCH) { this.next = start; this.hi = start - 1; }
  alloc(line) {
    if (this.next >= NREG) throw new MobiusError('static', `expression too complex: ran out of the ${NREG - FIRST_SCRATCH} scratch registers`, line);
    const r = this.next++;
    if (r > this.hi) this.hi = r;
    return r;
  }
}

export function compile(prog, opts = {}) {
  const { checks = true } = opts;
  // ---------------- data layout ----------------
  const symbols = [];
  const data = [];
  const gbind = new Map();
  let addr = 16; // low memory left unused so that address 0 is never a valid cell
  for (const g of prog.globals) {
    if (g.kind === 'int') {
      gbind.set(g.name, { where: 'global', kind: 'int', addr });
      symbols.push({ name: g.name, kind: 'int', addr });
      if (g.init) data.push([addr, g.init | 0]);
      addr += 1;
    } else if (g.kind === 'array') {
      data.push([addr, g.size]); // length header lives just below element 0
      const base = addr + 1;
      gbind.set(g.name, { where: 'global', kind: 'array', addr: base, size: g.size });
      symbols.push({ name: g.name, kind: 'array', addr: base, size: g.size });
      if (g.init) g.init.forEach((v, i) => { if (v) data.push([base + i, v | 0]); });
      addr = base + g.size;
    } else {
      gbind.set(g.name, { where: 'global', kind: 'stack', addr, cap: g.cap });
      symbols.push({ name: g.name, kind: 'stack', addr, cap: g.cap });
      data.push([addr + 1, g.cap]); // [len, cap, elements...]
      addr += 2 + g.cap;
    }
  }
  const stackBase = addr + 16;

  // ---------------- code generation ----------------
  const code = [];
  const procLabel = (n) => `proc_${n}`;
  code.push({ op: 'START', line: 0 });
  code.push({ op: 'BRA', tgt: procLabel('main'), line: prog.procs.get('main').line, note: 'call main' });
  code.push({ op: 'HALT', line: 0 });
  const entry = 1;

  for (const proc of prog.procs.values()) {
    const ctx = { proc, depth: 1, k: proc.params.length, scopes: [new Map()] };
    proc.params.forEach((p, i) => ctx.scopes[0].set(p.name, { where: 'param', kind: p.kind, i }));
    const top = fresh('top_'), bot = fresh('bot_');
    const L = proc.line;
    code.push({ op: 'BRA', lbl: top, tgt: bot, line: L, note: `${proc.name}: come-from (return path)` });
    code.push({ op: 'SWAPBR', rd: RO, lbl: procLabel(proc.name), line: L, proc: proc.name, note: `${proc.name}: entry / exit` });
    code.push({ op: 'NEG', rd: RO, line: L });
    code.push({ op: 'EXCH', rd: RO, ra: SP, line: L, note: 'push return offset' });
    code.push({ op: 'ADDI', rd: SP, imm: 1, line: L });
    for (const s of proc.body) code.push(...stmt(s, ctx));
    code.push({ op: 'ADDI', rd: SP, imm: -1, line: L });
    code.push({ op: 'EXCH', rd: RO, ra: SP, line: L, note: 'pop return offset' });
    code.push({ op: 'BRA', lbl: bot, tgt: top, line: L, note: `${proc.name}: return` });
  }

  // ---------------- statements ----------------
  function lookup(ctx, name) {
    for (let i = ctx.scopes.length - 1; i >= 0; i--) if (ctx.scopes[i].has(name)) return ctx.scopes[i].get(name);
    if (gbind.has(name)) return gbind.get(name);
    throw new MobiusError('static', `undeclared '${name}'`);
  }

  function stmt(s, ctx) {
    const line = s.line;
    const E = (op, f = {}) => ({ op, line, ...f });
    switch (s.t) {
      case 'skip': return [];
      case 'update': {
        const regs = new Regs();
        const S = [];
        const ra = lvalAddr(s.target, S, regs, ctx, line);
        const re = expr(s.expr, S, regs, ctx);
        const t = regs.alloc(line);
        const opn = s.op === '+' ? 'ADD' : s.op === '-' ? 'SUB' : 'XOR';
        const body = [E('EXCH', { rd: t, ra }), E(opn, { rd: t, ra: re }), E('EXCH', { rd: t, ra })];
        return wrapClean([...S, ...body, ...invertSeq(S)], regs, line, 'update reads the cell it modifies (aliasing) — not invertible');
      }
      case 'swap': {
        const regs = new Regs();
        const S = [];
        const a = lvalAddr(s.a, S, regs, ctx, line);
        const b = lvalAddr(s.b, S, regs, ctx, line);
        const same = regs.alloc(line);
        S.push(E('XSEQ', { rd: same, ra: a, rb: b }));
        const t = regs.alloc(line);
        const body = guard('BNE', same, [E('EXCH', { rd: t, ra: a }), E('EXCH', { rd: t, ra: b }), E('EXCH', { rd: t, ra: a })], line);
        return wrapClean([...S, ...body, ...invertSeq(S)], regs, line, 'swap index depends on a swapped cell — not invertible');
      }
      case 'if': {
        const rt = FIRST_SCRATCH;
        const T = fresh('if_'), Lelse = fresh('else_'), TJ = fresh('tj_'), Lexit = fresh('fi_');
        const out = [];
        out.push(E('TRAPNZ', { ra: rt, msg: 'if (run backward): entry condition disagrees with the branch taken' }));
        out.push(...cond(s.cond, rt, ctx, line));
        out.push(E('BEQ', { ra: rt, rb: R0, lbl: T, tgt: Lelse, note: 'if: false → else' }));
        out.push(E('XLI', { rd: rt, imm: 1 }));
        for (const x of s.then) out.push(...stmt(x, ctx));
        out.push(E('XLI', { rd: rt, imm: 1, line: s.assert.line ?? line }));
        out.push(E('BRA', { lbl: TJ, tgt: Lexit, note: 'then: jump to fi' }));
        out.push(E('BEQ', { ra: rt, rb: R0, lbl: Lelse, tgt: T, note: 'else: come-from' }));
        for (const x of s.else) out.push(...stmt(x, ctx));
        out.push(E('BNE', { ra: rt, rb: R0, lbl: Lexit, tgt: TJ, note: 'fi: come-from then' }));
        out.push(...cond(s.assert, rt, ctx, line));
        out.push(E('TRAPNZ', { ra: rt, msg: 'if: exit assertion (fi) disagrees with the branch taken' }));
        return out;
      }
      case 'loop': {
        const rt = FIRST_SCRATCH;
        const A = fresh('from_'), B = fresh('back_'), C = fresh('until_'), D = fresh('exit_');
        const e1 = () => cond(s.from, rt, ctx, line);
        const e2 = () => cond(s.until, rt, ctx, line);
        const out = [];
        out.push(E('TRAPNZ', { ra: rt, msg: 'loop (run backward): exit condition false on final iteration' }));
        out.push(...e1());
        out.push(E('TRAPZ', { ra: rt, msg: 'loop: entry assertion (from) is false on entry' }));
        out.push(E('BEQ', { ra: rt, rb: R0, lbl: A, tgt: B, note: 'from: come-from loop-back' }));
        out.push(...e1());
        for (const x of s.doBody) out.push(...stmt(x, ctx));
        out.push(...e2());
        out.push(E('BNE', { ra: rt, rb: R0, lbl: C, tgt: D, note: 'until: true → exit' }));
        out.push(E('TRAPNZ', { ra: rt, msg: 'loop (run backward): exit condition true inside loop' }));
        out.push(...e2());
        for (const x of s.loopBody) out.push(...stmt(x, ctx));
        out.push(...e1());
        out.push(E('TRAPNZ', { ra: rt, msg: 'loop: entry assertion (from) is true on re-entry' }));
        out.push(E('BRA', { lbl: B, tgt: A, note: 'loop back' }));
        out.push(E('BNE', { ra: rt, rb: R0, lbl: D, tgt: C, note: 'exit: come-from until' }));
        out.push(...e2());
        out.push(E('TRAPNZ', { ra: rt, msg: 'loop: internal' }));
        return out;
      }
      case 'call': case 'uncall': {
        // Push argument addresses (each computed, copied, and its garbage scrubbed).
        const P = [];
        const d0 = ctx.depth;
        for (const a of s.args) {
          const regs = new Regs(FIRST_SCRATCH + 1);
          const S = [];
          const r = varAddr(a, S, regs, ctx, line);
          const c = FIRST_SCRATCH;
          P.push(...S, E('XOR', { rd: c, ra: r }), ...invertSeq(S), E('EXCH', { rd: c, ra: SP }), E('ADDI', { rd: SP, imm: 1 }));
          ctx.depth++;
        }
        ctx.depth = d0;
        const jump = E(s.t === 'call' ? 'BRA' : 'RBRA', { tgt: procLabel(s.name), note: `${s.t} ${s.name}` });
        return [...P, jump, ...invertSeq(P)];
      }
      case 'local': {
        const c = FIRST_SCRATCH;
        const mk = (e, ln) => {
          const regs = new Regs(FIRST_SCRATCH + 1);
          const S = [];
          const r = expr(e, S, regs, ctx);
          return [...S, { op: 'XOR', rd: c, ra: r, line: ln }, ...invertSeq(S)];
        };
        const out = [];
        out.push(E('TRAPNZ', { ra: c, msg: `local ${s.name} (run backward): value does not match initializer` }));
        out.push(...mk(s.init, line));
        out.push(E('EXCH', { rd: c, ra: SP, note: `local ${s.name}` }), E('ADDI', { rd: SP, imm: 1 }));
        const dj = ctx.depth;
        ctx.depth++;
        ctx.scopes.push(new Map([[s.name, { where: 'local', kind: 'int', dj }]]));
        for (const x of s.body) out.push(...stmt(x, ctx));
        ctx.depth--;
        ctx.scopes.pop();
        const el = s.endLine ?? line;
        out.push({ op: 'ADDI', rd: SP, imm: -1, line: el }, { op: 'EXCH', rd: c, ra: SP, line: el, note: `delocal ${s.name}` });
        out.push(...mk(s.final, el));
        out.push({ op: 'TRAPNZ', ra: c, line: el, msg: `delocal ${s.name}: value does not match the delocal expression` });
        return out;
      }
      case 'push': case 'pop': {
        const code = pushCode(s, ctx, line);
        return s.t === 'push' ? code : invertSeq(code);
      }
      case 'write': case 'unwrite': {
        const regs = new Regs(); const S = [];
        const r = expr(s.e, S, regs, ctx);
        return [...S, E(s.t === 'write' ? 'OUT' : 'UNOUT', { ra: r }), ...invertSeq(S)];
      }
      case 'plot': case 'unplot': {
        const regs = new Regs(); const S = [];
        const x = expr(s.x, S, regs, ctx), y = expr(s.y, S, regs, ctx), c = expr(s.c, S, regs, ctx);
        return [...S, E(s.t === 'plot' ? 'PLOT' : 'UNPLOT', { rd: x, ra: y, rb: c }), ...invertSeq(S)];
      }
    }
    throw new MobiusError('static', `cannot compile ${s.t}`, line);
  }

  // A statement bracketed by symmetric "all scratch clean" checks. If an update
  // reads the cell it writes (possible through reference aliasing), the
  // uncompute leaves garbage, and this catches it — in either direction.
  function wrapClean(items, regs, line, msg) {
    if (!checks || regs.hi < FIRST_SCRATCH) return items;
    const c = { op: 'CHKZ', ra: FIRST_SCRATCH, rb: regs.hi, line, msg };
    return [{ ...c }, ...items, { ...c }];
  }

  // Executes `body` only when reg is zero ('BNE' guard) / nonzero ('BEQ' guard).
  // reg must be unchanged by body; the construct is its own mirror image.
  function guard(kind, reg, body, line) {
    const a = fresh('g_'), b = fresh('g_');
    return [{ op: kind, ra: reg, rb: R0, lbl: a, tgt: b, line }, ...body, { op: kind, ra: reg, rb: R0, lbl: b, tgt: a, line }];
  }

  // rt ^= (e != 0), leaving all other registers clean.
  function cond(e, rt, ctx, line) {
    const regs = new Regs(rt + 1);
    const S = [];
    const r = expr(e, S, regs, ctx);
    return [...S, { op: 'XSNE', rd: rt, ra: r, rb: R0, line: e.line ?? line }, ...invertSeq(S)];
  }

  // ---- addresses ----
  function paramCell(b, S, regs, ctx, line) {
    // the cell holding the address of parameter i
    const t = regs.alloc(line);
    S.push({ op: 'XADDI', rd: t, ra: SP, imm: -(ctx.depth + ctx.k - b.i), line });
    return t;
  }
  function varAddr(name, S, regs, ctx, line) {
    const b = lookup(ctx, name);
    if (b.where === 'global') { const r = regs.alloc(line); S.push({ op: 'XLI', rd: r, imm: b.addr, line }); return r; }
    if (b.where === 'local') { const r = regs.alloc(line); S.push({ op: 'XADDI', rd: r, ra: SP, imm: b.dj - ctx.depth, line }); return r; }
    if (b.where === 'param') {
      const t = paramCell(b, S, regs, ctx, line);
      const r = regs.alloc(line);
      S.push({ op: 'XLD', rd: r, ra: t, line });
      return r;
    }
    throw new MobiusError('static', `'${name}' cannot be referenced here (delocal expressions may only read it)`, line);
  }
  function arrayLen(name, base, S, regs, ctx, line) {
    const b = lookup(ctx, name);
    const r = regs.alloc(line);
    if (b.where === 'global') { S.push({ op: 'XLI', rd: r, imm: b.size, line }); return r; }
    const t = regs.alloc(line);
    S.push({ op: 'XADDI', rd: t, ra: base, imm: -1, line });
    S.push({ op: 'XLD', rd: r, ra: t, line });
    return r;
  }
  function elemAddr(name, index, S, regs, ctx, line) {
    const b = lookup(ctx, name);
    if (b.where === 'global' && index.t === 'num') {
      if (index.v < 0 || index.v >= b.size) throw new MobiusError('static', `index ${index.v} out of bounds for '${name}'[${b.size}]`, line);
      const r = regs.alloc(line); S.push({ op: 'XLI', rd: r, imm: b.addr + index.v, line }); return r;
    }
    const base = varAddr(name, S, regs, ctx, line);
    const i = expr(index, S, regs, ctx);
    if (checks) {
      const n = arrayLen(name, base, S, regs, ctx, line);
      const lo = regs.alloc(line), hi = regs.alloc(line), bad = regs.alloc(line);
      S.push({ op: 'XSLT', rd: lo, ra: i, rb: R0, line }, { op: 'XSGE', rd: hi, ra: i, rb: n, line },
        { op: 'XIOR', rd: bad, ra: lo, rb: hi, line }, { op: 'TRAPNZ', ra: bad, line, msg: `index out of bounds for '${name}'` });
    }
    const r = regs.alloc(line);
    S.push({ op: 'XADD', rd: r, ra: base, rb: i, line });
    return r;
  }
  function lvalAddr(lv, S, regs, ctx, line) {
    return lv.index ? elemAddr(lv.name, lv.index, S, regs, ctx, line) : varAddr(lv.name, S, regs, ctx, line);
  }

  // ---- expressions: compute into fresh registers, keep intermediates ----
  function expr(e, S, regs, ctx) {
    const line = e.line ?? 0;
    switch (e.t) {
      case 'num': {
        if (e.v === 0) return R0;
        const r = regs.alloc(line); S.push({ op: 'XLI', rd: r, imm: e.v, line }); return r;
      }
      case 'var': {
        const b = lookup(ctx, e.name);
        if (b.where === 'reg') return b.reg; // a delocal'd variable, currently held in a register
        const a = varAddr(e.name, S, regs, ctx, line);
        const r = regs.alloc(line); S.push({ op: 'XLD', rd: r, ra: a, line }); return r;
      }
      case 'idx': {
        const a = elemAddr(e.name, e.index, S, regs, ctx, line);
        const r = regs.alloc(line); S.push({ op: 'XLD', rd: r, ra: a, line }); return r;
      }
      case 'builtin': {
        const b = lookup(ctx, e.name);
        if (e.fn === 'size' && b.kind === 'array') {
          if (b.where === 'global') { const r = regs.alloc(line); S.push({ op: 'XLI', rd: r, imm: b.size, line }); return r; }
          return arrayLen(e.name, varAddr(e.name, S, regs, ctx, line), S, regs, ctx, line);
        }
        const base = varAddr(e.name, S, regs, ctx, line);
        const n = regs.alloc(line);
        S.push({ op: 'XLD', rd: n, ra: base, line });
        if (e.fn === 'size') return n;
        if (e.fn === 'empty') { const r = regs.alloc(line); S.push({ op: 'XSEQ', rd: r, ra: n, rb: R0, line }); return r; }
        S.push({ op: 'TRAPZ', ra: n, line, msg: `top() of empty stack '${e.name}'` });
        const t = regs.alloc(line), a = regs.alloc(line), r = regs.alloc(line);
        S.push({ op: 'XADD', rd: t, ra: base, rb: n, line }, { op: 'XADDI', rd: a, ra: t, imm: 1, line }, { op: 'XLD', rd: r, ra: a, line });
        return r;
      }
      case 'un': {
        const a = expr(e.e, S, regs, ctx);
        const r = regs.alloc(line); S.push({ op: XUN[e.op], rd: r, ra: a, line }); return r;
      }
      case 'bin': {
        if (e.op === '&&' || e.op === '||') {
          const l = expr(e.l, S, regs, ctx);
          const r = regs.alloc(line);
          if (e.op === '||') S.push({ op: 'XSNE', rd: r, ra: l, rb: R0, line });
          const inner = [];
          const rr = expr(e.r, inner, regs, ctx);
          inner.push({ op: 'XSNE', rd: r, ra: rr, rb: R0, line });
          // &&: evaluate right side only if l != 0;  ||: only if l == 0
          S.push(...guard(e.op === '&&' ? 'BEQ' : 'BNE', l, inner, line));
          return r;
        }
        const a = expr(e.l, S, regs, ctx);
        const b = expr(e.r, S, regs, ctx);
        const r = regs.alloc(line);
        S.push({ op: XBIN[e.op], rd: r, ra: a, rb: b, line });
        return r;
      }
    }
    throw new MobiusError('static', `cannot compile expression ${e.t}`, line);
  }

  function pushCode(s, ctx, line) {
    const regs = new Regs(); const S = [];
    const ax = varAddr(s.v, S, regs, ctx, line);
    const bs = varAddr(s.s, S, regs, ctx, line);
    const n = regs.alloc(line), capA = regs.alloc(line), cap = regs.alloc(line), full = regs.alloc(line), t1 = regs.alloc(line), slot = regs.alloc(line);
    S.push({ op: 'XLD', rd: n, ra: bs, line }, { op: 'XADDI', rd: capA, ra: bs, imm: 1, line }, { op: 'XLD', rd: cap, ra: capA, line },
      { op: 'XSGE', rd: full, ra: n, rb: cap, line }, { op: 'TRAPNZ', ra: full, line, msg: `push: stack '${s.s}' is full` },
      { op: 'XADD', rd: t1, ra: bs, rb: n, line }, { op: 'XADDI', rd: slot, ra: t1, imm: 2, line });
    const t = regs.alloc(line);
    const move = [
      { op: 'TRAPNZ', ra: t, line, msg: `pop: target '${s.v}' must be zero` }, // only reachable when running as pop
      { op: 'EXCH', rd: t, ra: ax, line }, { op: 'EXCH', rd: t, ra: slot, line },
      { op: 'TRAPNZ', ra: t, line, msg: `push: stack slot not clean` },
    ];
    const S2 = []; const r2 = new Regs(regs.next);
    const bs2 = varAddr(s.s, S2, r2, ctx, line);
    const bump = [
      { op: 'EXCH', rd: t, ra: bs2, line }, { op: 'ADDI', rd: t, imm: 1, line },
      { op: 'TRAPZ', ra: t, line, msg: `pop: stack '${s.s}' is empty` },
      { op: 'EXCH', rd: t, ra: bs2, line },
    ];
    regs.hi = Math.max(regs.hi, r2.hi);
    return wrapClean([...S, ...move, ...invertSeq(S), ...S2, ...bump, ...invertSeq(S2)], regs, line, 'push/pop aliasing');
  }

  // ---------------- assembly ----------------
  const where = new Map();
  code.forEach((ins, a) => { if (ins.lbl) { if (where.has(ins.lbl)) throw new Error('dup label ' + ins.lbl); where.set(ins.lbl, a); } });
  const procAt = new Map();
  for (const p of prog.procs.keys()) procAt.set(where.get(procLabel(p)), p);
  const out = code.map((ins, a) => {
    const o = OP[ins.op];
    if (o === undefined) throw new Error('bad op ' + ins.op);
    let imm = ins.imm ?? 0;
    if (BRANCHES.has(o)) {
      if (!where.has(ins.tgt)) throw new Error('unresolved label ' + ins.tgt);
      imm = where.get(ins.tgt) - a;
    }
    const fin = { o, op: ins.op, rd: ins.rd ?? 0, ra: ins.ra ?? 0, rb: ins.rb ?? 0, imm: imm | 0, line: ins.line ?? 0 };
    if (ins.msg) fin.msg = ins.msg;
    if (ins.note) fin.note = ins.note;
    if (ins.lbl) fin.label = ins.lbl;
    validate(fin, a);
    return fin;
  });
  return { code: out, data, symbols, stackBase, entry, procAt, meta: prog.meta, source: prog };
}

// Injectivity side-conditions: an instruction like  r5 ^= r5 + 1  is not a bijection.
function validate(ins, a) {
  const { op, rd, ra, rb } = ins;
  const shape = OPS[ins.o][1];
  if (shape.startsWith('rd ra') && op !== 'SWAP' && !op.includes('PLOT') && rd === ra) throw new Error(`internal: ${op} r${rd}, r${ra} at ${a} is not injective`);
  if (shape === 'rd ra rb' && op.startsWith('X') && rd === rb) throw new Error(`internal: ${op} writes its own operand at ${a}`);
  if (shape.startsWith('rd') && !op.includes('PLOT') && rd === R0) throw new Error(`internal: ${op} writes r0 at ${a}`);
}
