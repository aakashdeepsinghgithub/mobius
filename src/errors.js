// Shared error type. `kind` is one of: syntax, static, runtime.
export class MobiusError extends Error {
  constructor(kind, message, line = 0, col = 0) {
    super(line ? `${kind} error (line ${line}${col ? ':' + col : ''}): ${message}` : `${kind} error: ${message}`);
    this.kind = kind;
    this.bare = message;
    this.line = line;
    this.col = col;
  }
}

// All arithmetic in Möbius is two's-complement int32. Wrapping is not a bug:
// modular arithmetic is what keeps `x += e` a bijection for every e.
export const i32 = (x) => x | 0;

export function isqrt(n) {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x | 0;
}

// The single source of truth for binary/unary operator semantics, shared by
// the reference interpreter and the VM so they cannot drift apart.
export const BINOPS = {
  '+': (a, b) => (a + b) | 0,
  '-': (a, b) => (a - b) | 0,
  '*': (a, b) => Math.imul(a, b),
  '/': (a, b) => (b === 0 ? null : (a / b) | 0),
  '%': (a, b) => (b === 0 ? null : (a % b) | 0),
  '&': (a, b) => a & b,
  '|': (a, b) => a | b,
  '^': (a, b) => a ^ b,
  '<<': (a, b) => a << (b & 31),
  '>>': (a, b) => a >> (b & 31),
  '>>>': (a, b) => (a >>> (b & 31)) | 0,
  '<': (a, b) => +(a < b),
  '<=': (a, b) => +(a <= b),
  '>': (a, b) => +(a > b),
  '>=': (a, b) => +(a >= b),
  '=': (a, b) => +(a === b),
  '!=': (a, b) => +(a !== b),
};

export const UNOPS = {
  neg: (a) => (-a) | 0,
  not: (a) => +(a === 0),
  bnot: (a) => ~a,
  sqrt: (a) => isqrt(a),
  abs: (a) => Math.abs(a) | 0,
};
