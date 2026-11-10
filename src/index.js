// Public API of the Möbius toolchain.
import { parse } from './parser.js';
import { check } from './checker.js';
import { compile } from './compiler.js';
export { MobiusError } from './errors.js';
export { parse, check, compile };
export { VM } from './vm.js';
export { Interpreter } from './interp.js';
export { invertProgram, invertBlock, showProgram, showProc, showExpr } from './inverter.js';
export { OPS, formatInstr } from './isa.js';

/** Source text → checked AST → MRM program. */
export function build(src, opts) {
  const ast = check(parse(src));
  return { ast, program: compile(ast, opts) };
}
