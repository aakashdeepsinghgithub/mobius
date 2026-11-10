// The Möbius Reversible Machine.
//
// step()   : the transition function T.
// unstep() : T⁻¹, computed *from the current state alone*. There is no trace,
//            no snapshot, no undo log: the machine is a bijection, so the past
//            is a pure function of the present. `historyBytes` is always 0.
import { OP, NREG, SP, BRANCHES } from './isa.js';
import { isqrt } from './errors.js';

const {
  START, HALT, ADD, SUB, ADDI, NEG, XOR, SWAP, EXCH, XLI, XLD, XADDI, XADD, XSUB, XMUL, XDIV, XMOD, XAND, XIOR, XXOR,
  XSHL, XSHR, XSRL, XSLT, XSLE, XSGT, XSGE, XSEQ, XSNE, XNEG, XNOT, XBNOT, XSQRT, XABS, BRA, RBRA, BEQ, BNE, SWAPBR,
  OUT, UNOUT, PLOT, UNPLOT, TRAPNZ, TRAPZ, CHKZ,
} = OP;

export class VM {
  constructor(program, { memSize = 1 << 16 } = {}) {
    this.program = program;
    this.code = program.code;
    this.memSize = memSize;
    this.reset();
  }
  reset() {
    this.R = new Int32Array(NREG);
    this.M = new Int32Array(this.memSize);
    for (const [a, v] of this.program.data) this.M[a] = v;
    this.R[SP] = this.program.stackBase;
    this.pc = this.program.entry;
    this.br = 0;
    this.dir = 1;
    this.t = 0;               // signed clock: +1 per step, -1 per unstep
    this.tape = [];
    this.status = 'ready';    // ready | halted | start | trap
    this.fault = null;
    this.executed = 0;        // total instructions executed in either direction (stats only)
  }
  get historyBytes() { return 0; }

  /** Begin executing main *backwards* (the inverse program) from the current store. */
  reverseFromOrigin() { this.pc = this.program.entry; this.br = 0; this.dir = -1; this.status = 'ready'; this.fault = null; }

  isHalted() {
    const o = this.code[this.pc]?.o;
    return (o === HALT && this.dir === 1) || (o === START && this.dir === -1);
  }

  // Execute instruction `ins` in effective direction d. Returns an error string
  // (and leaves the state untouched) or null on success.
  exec(ins, d) {
    const R = this.R, M = this.M;
    const { rd, ra, rb, imm } = ins;
    switch (ins.o) {
      case START: case HALT: return null;
      case ADD: R[rd] = d > 0 ? R[rd] + R[ra] : R[rd] - R[ra]; return null;
      case SUB: R[rd] = d > 0 ? R[rd] - R[ra] : R[rd] + R[ra]; return null;
      case ADDI: R[rd] = R[rd] + d * imm; return null;
      case NEG: R[rd] = -R[rd]; return null;
      case XOR: R[rd] ^= R[ra]; return null;
      case SWAP: { const t = R[rd]; R[rd] = R[ra]; R[ra] = t; return null; }
      case EXCH: {
        const a = R[ra];
        if (a < 0 || a >= M.length) return `memory address ${a} out of range`;
        const t = R[rd]; R[rd] = M[a]; M[a] = t; return null;
      }
      case XLI: R[rd] ^= imm; return null;
      case XLD: {
        const a = R[ra];
        if (a < 0 || a >= M.length) return `memory address ${a} out of range`;
        R[rd] ^= M[a]; return null;
      }
      case XADDI: R[rd] ^= R[ra] + imm; return null;
      case XADD: R[rd] ^= R[ra] + R[rb]; return null;
      case XSUB: R[rd] ^= R[ra] - R[rb]; return null;
      case XMUL: R[rd] ^= Math.imul(R[ra], R[rb]); return null;
      case XDIV: if (R[rb] === 0) return 'division by zero'; R[rd] ^= (R[ra] / R[rb]) | 0; return null;
      case XMOD: if (R[rb] === 0) return 'division by zero'; R[rd] ^= (R[ra] % R[rb]) | 0; return null;
      case XAND: R[rd] ^= R[ra] & R[rb]; return null;
      case XIOR: R[rd] ^= R[ra] | R[rb]; return null;
      case XXOR: R[rd] ^= R[ra] ^ R[rb]; return null;
      case XSHL: R[rd] ^= R[ra] << (R[rb] & 31); return null;
      case XSHR: R[rd] ^= R[ra] >> (R[rb] & 31); return null;
      case XSRL: R[rd] ^= R[ra] >>> (R[rb] & 31); return null;
      case XSLT: R[rd] ^= +(R[ra] < R[rb]); return null;
      case XSLE: R[rd] ^= +(R[ra] <= R[rb]); return null;
      case XSGT: R[rd] ^= +(R[ra] > R[rb]); return null;
      case XSGE: R[rd] ^= +(R[ra] >= R[rb]); return null;
      case XSEQ: R[rd] ^= +(R[ra] === R[rb]); return null;
      case XSNE: R[rd] ^= +(R[ra] !== R[rb]); return null;
      case XNEG: R[rd] ^= -R[ra]; return null;
      case XNOT: R[rd] ^= +(R[ra] === 0); return null;
      case XBNOT: R[rd] ^= ~R[ra]; return null;
      case XSQRT: R[rd] ^= isqrt(R[ra]); return null;
      case XABS: R[rd] ^= Math.abs(R[ra]); return null;
      case BRA: this.br += imm; return null;
      case RBRA: this.br += imm; this.dir = -this.dir; return null;
      case BEQ: if (R[ra] === R[rb]) this.br += imm; return null;
      case BNE: if (R[ra] !== R[rb]) this.br += imm; return null;
      case SWAPBR: { const t = R[rd]; R[rd] = this.br; this.br = t; return null; }
      case OUT: case UNOUT:
        if ((ins.o === OUT) === (d > 0)) { this.tape.push({ k: 'w', v: R[ra] }); return null; }
        else {
          const last = this.tape[this.tape.length - 1];
          if (!last || last.k !== 'w' || last.v !== R[ra]) return `unwrite ${R[ra]}: tape does not end with that value`;
          this.tape.pop(); return null;
        }
      case PLOT: case UNPLOT:
        if ((ins.o === PLOT) === (d > 0)) { this.tape.push({ k: 'p', x: R[rd], y: R[ra], c: R[rb] }); return null; }
        else {
          const last = this.tape[this.tape.length - 1];
          if (!last || last.k !== 'p' || last.x !== R[rd] || last.y !== R[ra] || last.c !== R[rb]) return `unplot: tape does not end with (${R[rd]}, ${R[ra]})`;
          this.tape.pop(); return null;
        }
      case TRAPNZ: return R[ra] !== 0 ? ins.msg || 'assertion failed' : null;
      case TRAPZ: return R[ra] === 0 ? ins.msg || 'assertion failed' : null;
      case CHKZ:
        for (let r = ra; r <= rb; r++) if (R[r] !== 0) return ins.msg || `register r${r} not clean`;
        return null;
    }
    return `illegal opcode ${ins.o}`;
  }

  /** T: one forward transition in the current direction of time. */
  step() {
    if (this.status === 'trap') return false;
    const ins = this.code[this.pc];
    if (!ins) return this.trap(`pc ${this.pc} outside program`);
    if (this.isHalted()) { this.status = ins.o === HALT ? 'halted' : 'start'; return false; }
    const d = this.dir;
    const err = this.exec(ins, d);
    if (err) return this.trap(err, ins);
    const npc = this.pc + (this.br !== 0 ? this.br : this.dir);
    if (npc < 0 || npc >= this.code.length) { this.undo(ins, d); return this.trap(`jump to ${npc} outside program`, ins); }
    this.pc = npc;
    this.t++;
    this.executed++;
    this.status = 'ready';
    if (this.isHalted()) this.status = this.code[this.pc].o === HALT ? 'halted' : 'start';
    return true;
  }

  /** T⁻¹: reconstruct the previous state from the present one. No history used. */
  unstep() {
    if (this.status === 'trap') { this.status = 'ready'; this.fault = null; } // the faulting step never happened
    const p = this.pc - (this.br !== 0 ? this.br : this.dir);
    const ins = this.code[p];
    if (!ins || ins.o === START || ins.o === HALT) return false; // at an origin: there is no past
    const d = ins.o === RBRA ? -this.dir : this.dir; // the direction that was in force when ins ran
    const err = this.undo(ins, d);
    if (err) return this.trap('cannot unstep: ' + err, ins);
    this.pc = p;
    this.t--;
    this.executed++;
    this.status = 'ready';
    return true;
  }

  undo(ins, d) {
    switch (ins.o) {
      case BRA: this.br -= ins.imm; return null;
      case RBRA: this.br -= ins.imm; this.dir = -this.dir; return null;
      case BEQ: if (this.R[ins.ra] === this.R[ins.rb]) this.br -= ins.imm; return null;
      case BNE: if (this.R[ins.ra] !== this.R[ins.rb]) this.br -= ins.imm; return null;
      default: return this.exec(ins, -d);
    }
  }

  trap(msg, ins) {
    this.status = 'trap';
    this.fault = { msg, pc: this.pc, line: ins?.line ?? 0 };
    return false;
  }

  run(maxSteps = 1e9) {
    let n = 0;
    while (n < maxSteps && this.step()) n++;
    return n;
  }
  runBack(maxSteps = 1e9) {
    let n = 0;
    while (n < maxSteps && this.unstep()) n++;
    return n;
  }

  // A canonical fingerprint of the *entire* machine state (for bijectivity checks).
  fingerprint() {
    let h = 2166136261 >>> 0;
    const mix = (x) => { h ^= x & 0xff; h = Math.imul(h, 16777619); h ^= (x >>> 8) & 0xff; h = Math.imul(h, 16777619); h ^= (x >>> 16) & 0xff; h = Math.imul(h, 16777619); h ^= x >>> 24; h = Math.imul(h, 16777619); };
    mix(this.pc); mix(this.br); mix(this.dir);
    for (let i = 0; i < this.R.length; i++) if (this.R[i]) { mix(i); mix(this.R[i]); }
    for (let i = 0; i < this.M.length; i++) if (this.M[i]) { mix(i); mix(this.M[i]); }
    for (const e of this.tape) { if (e.k === 'w') mix(e.v); else { mix(e.x); mix(e.y); mix(e.c); } }
    mix(this.tape.length);
    return h >>> 0;
  }

  // Values of globals, by name.
  snapshot() {
    const out = {};
    for (const g of this.program.symbols) {
      if (g.kind === 'int') out[g.name] = this.M[g.addr];
      else if (g.kind === 'array') out[g.name] = Array.from(this.M.subarray(g.addr, g.addr + g.size));
      else { const n = this.M[g.addr]; out[g.name] = Array.from(this.M.subarray(g.addr + 2, g.addr + 2 + n)); }
    }
    return out;
  }
  setGlobal(name, value, index = null) {
    const g = this.program.symbols.find((s) => s.name === name);
    if (!g) throw new Error('no global ' + name);
    if (g.kind === 'int') this.M[g.addr] = value | 0;
    else if (g.kind === 'array') this.M[g.addr + index] = value | 0;
  }
  sourceLine() { return this.code[this.pc]?.line ?? 0; }
}

export { BRANCHES };
