// Reference interpreter: a direct big-step semantics of Möbius over the AST.
// It shares nothing with the compiler/VM except operator definitions, which
// makes it an independent oracle for differential testing.
//
// Backward execution here is done the "textbook" way: uncall p == run I[p.body].
import { MobiusError, BINOPS, UNOPS } from './errors.js';
import { invertBlock, showExpr } from './inverter.js';

export class Interpreter {
  constructor(prog, { fuel = 50_000_000 } = {}) {
    this.prog = prog;
    this.fuel = fuel;
    this.mem = [0];
    this.tape = [];
    this.genv = new Map();
    this.reads = null;
    this.depth = 0;
    this.invCache = new Map();
    for (const g of prog.globals) {
      if (g.kind === 'int') { this.genv.set(g.name, { kind: 'int', addr: this.alloc(g.init) }); }
      else if (g.kind === 'array') {
        const base = this.mem.length;
        for (let i = 0; i < g.size; i++) this.mem.push(g.init && i < g.init.length ? g.init[i] | 0 : 0);
        this.genv.set(g.name, { kind: 'array', addr: base, size: g.size });
      } else {
        const base = this.mem.length;
        for (let i = 0; i <= g.cap; i++) this.mem.push(0);
        this.genv.set(g.name, { kind: 'stack', addr: base, cap: g.cap });
      }
    }
    this.heapTop = this.mem.length;
  }
  alloc(v) { this.mem.push(v | 0); return this.mem.length - 1; }
  fail(msg, line) { throw new MobiusError('runtime', msg, line); }
  burn(line) { if (--this.fuel < 0) this.fail('fuel exhausted (infinite loop?)', line); }

  rd(addr) { if (this.reads) this.reads.add(addr); return this.mem[addr]; }

  // ---- public API ----
  run(direction = 1) {
    const main = this.prog.procs.get('main');
    this.execBlock(direction > 0 ? main.body : this.inverse(main), this.frame(main, []));
    return this;
  }
  inverse(proc) {
    if (!this.invCache.has(proc.name)) this.invCache.set(proc.name, invertBlock(proc.body));
    return this.invCache.get(proc.name);
  }
  frame(proc, bindings) {
    const env = [new Map(this.genv), new Map()];
    proc.params.forEach((p, i) => env[1].set(p.name, bindings[i]));
    return env;
  }
  snapshot() {
    const out = {};
    for (const g of this.prog.globals) {
      const b = this.genv.get(g.name);
      if (b.kind === 'int') out[g.name] = this.mem[b.addr];
      else if (b.kind === 'array') out[g.name] = this.mem.slice(b.addr, b.addr + b.size);
      else { const n = this.mem[b.addr]; out[g.name] = this.mem.slice(b.addr + 1, b.addr + 1 + n); }
    }
    return out;
  }

  // ---- expressions ----
  lookup(env, name) {
    for (let i = env.length - 1; i >= 0; i--) if (env[i].has(name)) return env[i].get(name);
    throw new Error('unbound ' + name);
  }
  index(b, idx, line, name) {
    const size = b.kind === 'array' ? b.size : 0;
    if (idx < 0 || idx >= size) this.fail(`index ${idx} out of bounds for '${name}'[${size}]`, line);
    return b.addr + idx;
  }
  eval(e, env) {
    switch (e.t) {
      case 'num': return e.v;
      case 'var': return this.rd(this.lookup(env, e.name).addr);
      case 'idx': {
        const b = this.lookup(env, e.name);
        return this.rd(this.index(b, this.eval(e.index, env), e.line, e.name));
      }
      case 'builtin': {
        const b = this.lookup(env, e.name);
        if (e.fn === 'size') return b.kind === 'array' ? b.size : this.rd(b.addr);
        const n = this.rd(b.addr);
        if (e.fn === 'empty') return +(n === 0);
        if (n === 0) this.fail(`top() of empty stack '${e.name}'`, e.line);
        return this.rd(b.addr + n);
      }
      case 'un': return UNOPS[e.op](this.eval(e.e, env));
      case 'bin': {
        if (e.op === '&&') return this.eval(e.l, env) !== 0 ? +(this.eval(e.r, env) !== 0) : 0;
        if (e.op === '||') return this.eval(e.l, env) !== 0 ? 1 : +(this.eval(e.r, env) !== 0);
        const v = BINOPS[e.op](this.eval(e.l, env), this.eval(e.r, env));
        if (v === null) this.fail('division by zero', e.line);
        return v;
      }
    }
  }
  lvalAddr(lv, env) {
    const b = this.lookup(env, lv.name);
    return lv.index ? this.index(b, this.eval(lv.index, env), lv.line, lv.name) : b.addr;
  }
  truth(e, env) { return this.eval(e, env) !== 0; }

  // ---- statements ----
  execBlock(b, env) { for (const s of b) this.exec(s, env); }
  exec(s, env) {
    this.burn(s.line);
    switch (s.t) {
      case 'skip': return;
      case 'update': {
        this.reads = new Set();
        const a = this.lvalAddr(s.target, env);
        const v = this.eval(s.expr, env);
        const reads = this.reads; this.reads = null;
        const old = this.mem[a];
        const nv = s.op === '+' ? (old + v) | 0 : s.op === '-' ? (old - v) | 0 : old ^ v;
        if (nv !== old && reads.has(a)) this.fail(`update reads the cell it modifies (aliasing) — not invertible`, s.line);
        this.mem[a] = nv;
        return;
      }
      case 'swap': {
        this.reads = new Set();
        const a = this.lvalAddr(s.a, env), b = this.lvalAddr(s.b, env);
        const reads = this.reads; this.reads = null;
        if (a === b) return;
        const va = this.mem[a], vb = this.mem[b];
        if (va !== vb && (reads.has(a) || reads.has(b))) this.fail(`swap index depends on a swapped cell — not invertible`, s.line);
        this.mem[a] = vb; this.mem[b] = va;
        return;
      }
      case 'if': {
        const c = this.truth(s.cond, env);
        this.execBlock(c ? s.then : s.else, env);
        if (this.truth(s.assert, env) !== c) this.fail(`if: exit assertion '${short(s)}' is ${!c}, but the ${c ? 'then' : 'else'} branch was taken`, s.line);
        return;
      }
      case 'loop': {
        if (!this.truth(s.from, env)) this.fail(`loop: entry assertion is false on entry`, s.line);
        for (;;) {
          this.execBlock(s.doBody, env);
          if (this.truth(s.until, env)) return;
          this.execBlock(s.loopBody, env);
          if (this.truth(s.from, env)) this.fail(`loop: entry assertion is true on re-entry (loop would not be reversible)`, s.line);
          this.burn(s.line);
        }
      }
      case 'call': case 'uncall': {
        const proc = this.prog.procs.get(s.name);
        const binds = s.args.map((a) => this.lookup(env, a));
        const body = s.t === 'call' ? proc.body : this.inverse(proc);
        if (++this.depth > 4000) this.fail('call stack overflow', s.line);
        this.execBlock(body, this.frame(proc, binds));
        this.depth--;
        return;
      }
      case 'local': {
        const addr = this.alloc(this.eval(s.init, env));
        env.push(new Map([[s.name, { kind: 'int', addr }]]));
        this.execBlock(s.body, env);
        const want = this.eval(s.final, env);
        if (this.mem[addr] !== want) this.fail(`delocal ${s.name}: value is ${this.mem[addr]}, but delocal asserts ${want}`, s.endLine ?? s.line);
        env.pop();
        if (addr !== this.mem.length - 1) throw new Error('local discipline broken');
        this.mem.pop();
        return;
      }
      case 'push': {
        const x = this.lookup(env, s.v), st = this.lookup(env, s.s);
        const n = this.mem[st.addr];
        if (n >= st.cap) this.fail(`push: stack '${s.s}' is full (capacity ${st.cap})`, s.line);
        this.mem[st.addr + 1 + n] = this.mem[x.addr];
        this.mem[x.addr] = 0;
        this.mem[st.addr] = n + 1;
        return;
      }
      case 'pop': {
        const x = this.lookup(env, s.v), st = this.lookup(env, s.s);
        const n = this.mem[st.addr];
        if (n === 0) this.fail(`pop: stack '${s.s}' is empty`, s.line);
        if (this.mem[x.addr] !== 0) this.fail(`pop: target '${s.v}' must be zero (it is ${this.mem[x.addr]})`, s.line);
        this.mem[x.addr] = this.mem[st.addr + n];
        this.mem[st.addr + n] = 0;
        this.mem[st.addr] = n - 1;
        return;
      }
      case 'write': this.tape.push({ k: 'w', v: this.eval(s.e, env) }); return;
      case 'unwrite': {
        const v = this.eval(s.e, env), last = this.tape[this.tape.length - 1];
        if (!last || last.k !== 'w' || last.v !== v) this.fail(`unwrite ${v}: tape ends with ${last ? JSON.stringify(last) : 'nothing'}`, s.line);
        this.tape.pop(); return;
      }
      case 'plot': this.tape.push({ k: 'p', x: this.eval(s.x, env), y: this.eval(s.y, env), c: this.eval(s.c, env) }); return;
      case 'unplot': {
        const x = this.eval(s.x, env), y = this.eval(s.y, env), c = this.eval(s.c, env), last = this.tape[this.tape.length - 1];
        if (!last || last.k !== 'p' || last.x !== x || last.y !== y || last.c !== c) this.fail(`unplot (${x},${y}) does not match tape`, s.line);
        this.tape.pop(); return;
      }
    }
  }
}
function short(s) { return showExpr(s.assert); }
