// The Möbius Reversible Machine (MRM) instruction set.
//
// Design (in the tradition of Vieri's Pendulum / Frank's PISA):
//   * Every instruction is a bijection on machine states.
//   * Control flow is reversible too: jumps don't write pc directly, they add an
//     offset to the *branch register* br. After each instruction:
//         pc += (br != 0) ? br : dir
//     A jump therefore "flies" until it lands on a matching come-from branch
//     that cancels br back to zero. Landing sites know where you came from.
//   * dir (±1) is the direction of time. Running with dir = -1 executes the
//     inverse of each instruction in reverse order: that is how `uncall` works
//     (RBRA flips dir and jumps into the procedure).
//   * Expression ops have the "XOR-into" form  rd ^= f(ra, rb)  with rd ∉ {ra, rb},
//     which makes them involutions: computing and uncomputing are the same op.
//
// Registers: r0 = constant zero (by convention), r1 = SP, r2 = RO (return offset),
// r3..r255 scratch. All scratch registers are zero between statements.

export const NREG = 256;
export const R0 = 0, SP = 1, RO = 2, FIRST_SCRATCH = 3;

// [name, operand shape, description]
export const OPS = [
  ['START', '', 'program origin (backward execution halts here)'],
  ['HALT', '', 'program end (forward execution halts here)'],
  ['ADD', 'rd ra', 'rd += ra'],
  ['SUB', 'rd ra', 'rd -= ra'],
  ['ADDI', 'rd imm', 'rd += imm'],
  ['NEG', 'rd', 'rd = -rd'],
  ['XOR', 'rd ra', 'rd ^= ra'],
  ['SWAP', 'rd ra', 'rd <-> ra'],
  ['EXCH', 'rd ra', 'rd <-> mem[ra]'],
  ['XLI', 'rd imm', 'rd ^= imm'],
  ['XLD', 'rd ra', 'rd ^= mem[ra]'],
  ['XADDI', 'rd ra imm', 'rd ^= ra + imm'],
  ['XADD', 'rd ra rb', 'rd ^= ra + rb'],
  ['XSUB', 'rd ra rb', 'rd ^= ra - rb'],
  ['XMUL', 'rd ra rb', 'rd ^= ra * rb'],
  ['XDIV', 'rd ra rb', 'rd ^= ra / rb'],
  ['XMOD', 'rd ra rb', 'rd ^= ra % rb'],
  ['XAND', 'rd ra rb', 'rd ^= ra & rb'],
  ['XIOR', 'rd ra rb', 'rd ^= ra | rb'],
  ['XXOR', 'rd ra rb', 'rd ^= ra ^ rb'],
  ['XSHL', 'rd ra rb', 'rd ^= ra << rb'],
  ['XSHR', 'rd ra rb', 'rd ^= ra >> rb'],
  ['XSRL', 'rd ra rb', 'rd ^= ra >>> rb'],
  ['XSLT', 'rd ra rb', 'rd ^= ra < rb'],
  ['XSLE', 'rd ra rb', 'rd ^= ra <= rb'],
  ['XSGT', 'rd ra rb', 'rd ^= ra > rb'],
  ['XSGE', 'rd ra rb', 'rd ^= ra >= rb'],
  ['XSEQ', 'rd ra rb', 'rd ^= ra == rb'],
  ['XSNE', 'rd ra rb', 'rd ^= ra != rb'],
  ['XNEG', 'rd ra', 'rd ^= -ra'],
  ['XNOT', 'rd ra', 'rd ^= !ra'],
  ['XBNOT', 'rd ra', 'rd ^= ~ra'],
  ['XSQRT', 'rd ra', 'rd ^= isqrt(ra)'],
  ['XABS', 'rd ra', 'rd ^= |ra|'],
  ['BRA', 'off', 'br += off'],
  ['RBRA', 'off', 'br += off; dir = -dir'],
  ['BEQ', 'ra rb off', 'if ra == rb: br += off'],
  ['BNE', 'ra rb off', 'if ra != rb: br += off'],
  ['SWAPBR', 'rd', 'rd <-> br'],
  ['OUT', 'ra', 'append ra to tape (inverse: UNOUT)'],
  ['UNOUT', 'ra', 'remove ra from tape end (inverse: OUT)'],
  ['PLOT', 'rd ra rb', 'append point (rd, ra, colour rb) to tape'],
  ['UNPLOT', 'rd ra rb', 'remove point from tape end'],
  ['TRAPNZ', 'ra', 'fault if ra != 0 (no state change)'],
  ['TRAPZ', 'ra', 'fault if ra == 0 (no state change)'],
  ['CHKZ', 'ra rb', 'fault unless registers ra..rb are all zero'],
];
export const OP = Object.fromEntries(OPS.map(([n], i) => [n, i]));
export const OPNAME = OPS.map(([n]) => n);
export const SHAPE = OPS.map(([, s]) => s);

export const BRANCHES = new Set([OP.BRA, OP.RBRA, OP.BEQ, OP.BNE]);
export const XBIN = {
  '+': 'XADD', '-': 'XSUB', '*': 'XMUL', '/': 'XDIV', '%': 'XMOD', '&': 'XAND', '|': 'XIOR', '^': 'XXOR',
  '<<': 'XSHL', '>>': 'XSHR', '>>>': 'XSRL', '<': 'XSLT', '<=': 'XSLE', '>': 'XSGT', '>=': 'XSGE', '=': 'XSEQ', '!=': 'XSNE',
};
export const XUN = { neg: 'XNEG', not: 'XNOT', bnot: 'XBNOT', sqrt: 'XSQRT', abs: 'XABS' };

// Inverse of an instruction *as a code transformation* (used by the compiler's
// "uncompute" and by I[...]). Branch-family instructions are self-inverse
// under the pc += br convention.
export function invertInstr(ins) {
  switch (ins.op) {
    case 'ADD': return { ...ins, op: 'SUB' };
    case 'SUB': return { ...ins, op: 'ADD' };
    case 'ADDI': return { ...ins, imm: (-ins.imm) | 0 };
    case 'OUT': return { ...ins, op: 'UNOUT' };
    case 'UNOUT': return { ...ins, op: 'OUT' };
    case 'PLOT': return { ...ins, op: 'UNPLOT' };
    case 'UNPLOT': return { ...ins, op: 'PLOT' };
    default: return { ...ins };
  }
}

const reg = (r) => (r === SP ? 'sp' : r === RO ? 'ro' : 'r' + r);
export function formatInstr(ins, addr) {
  const shape = typeof ins.op === 'number' ? SHAPE[ins.op] : SHAPE[OP[ins.op]];
  const name = typeof ins.op === 'number' ? OPNAME[ins.op] : ins.op;
  const parts = [];
  for (const f of shape.split(' ').filter(Boolean)) {
    if (f === 'off') parts.push((ins.imm >= 0 ? '+' : '') + ins.imm + (addr !== undefined ? `  → ${addr + ins.imm}` : ''));
    else if (f === 'imm') parts.push(String(ins.imm));
    else parts.push(reg(ins[f]));
  }
  return name.padEnd(7) + parts.join(', ');
}
