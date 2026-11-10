# Möbius

**▶ Try it live:** https://aakashdeepsinghgithub.github.io/mobius/

**A reversible programming language, a compiler, a reversible machine, and a time-travel debugger that keeps no history.**

Normal computers throw information away. `x = 0` erases the old value of `x`, and Landauer's principle says that erasure is what makes computation give off heat. A reversible computer never erases anything. Each step is a bijection on the whole machine state, so the past can be *computed* from the present.

Möbius takes that idea all the way down the stack:

| layer | what it is | file |
|---|---|---|
| Language | A Janus-family reversible imperative language: `+= -= ^= <=>`, `if … fi assertion`, `from … until`, `call`/`uncall`, `local`/`delocal`, stacks, reversible output | `src/parser.js`, `src/checker.js` |
| Inverter | Rewrites any program into its exact inverse, statement by statement | `src/inverter.js` |
| Reference interpreter | Big-step AST semantics, used as an independent oracle | `src/interp.js` |
| ISA | The Möbius Reversible Machine (MRM): 47 instructions, each one a bijection, with control flow that is reversible too | `src/isa.js` |
| VM | `step()` = T, and `unstep()` = T⁻¹ computed from the current state alone | `src/vm.js` |
| Compiler | Möbius → MRM, Bennett-style garbage-free expression code, paired come-from branches | `src/compiler.js` |
| IDE | Single-file browser debugger with step-back, a time scrubber, and `main⁻¹` | `web/`, `dist/mobius-ide.html` |

## The three tricks

**1. Reversible control flow (no `pc := target`).** A jump adds an offset to a branch register `br`. After every instruction the machine does `pc += (br ≠ 0 ? br : dir)`. Each jump lands on a matching *come-from* branch, which cancels `br` back to 0. That means every landing site knows where it was jumped from. `dir = ±1` is the direction of time: with `dir = −1` every instruction runs as its inverse, in reverse order. `uncall p` compiles to `RBRA`, which flips `dir` and jumps into `p`. So uncall really does run the same machine code backwards.

**2. T⁻¹ from the present alone.** The transition function is injective, so the previous state is determined by the current one:

```
p   = pc − (br ≠ 0 ? br : dir)                       // where we came from
d   = (code[p] is RBRA) ? −dir : dir                  // direction that was in force
undo(code[p], d)                                       // exact inverse effect
```

The debugger's ◀ button calls this. Nothing is logged and nothing is snapshotted. `vm.historyBytes` is the literal constant `0`. Rewinding the 54-million-instruction Game of Life run back to t = 0 uses no memory beyond the machine itself.

**3. Bennett-style expression code.** Every expression operation has the form `rd ^= f(ra, rb)` with `rd ∉ {ra, rb}`, so it is its own inverse. The compiler computes all intermediates into fresh registers (sequence S), uses the result, then emits I(S), which is S reversed, to scrub them. Between statements all 253 scratch registers are zero. A symmetric `CHKZ` instruction checks this, and that check also catches aliasing violations at run time in both directions. Short-circuit `&&`/`||` compile to self-mirroring guard blocks.

## Running it

```bash
npm test                               # 27 tests incl. a 600-program differential fuzzer (FUZZ=3000 npm test for more)
node bin/mobius.js run     examples/fib.mob
node bin/mobius.js verify  examples/fib.mob     # proves T⁻¹∘T = id at every reachable state
node bin/mobius.js rewind  examples/threebody.mob
node bin/mobius.js invert  examples/collatz.mob # prints I[p] as source
node bin/mobius.js asm     examples/intro.mob
npm run build                          # → dist/mobius-ide.html (open in a browser)
```

No runtime dependencies. esbuild is used only to bundle the IDE.

## Examples

| | what it shows |
|---|---|
| `intro` | loops, and why there is no assignment |
| `fib` | recursion; `uncall` turns (F(n+1), F(n+2)) back into (0, 0) |
| `collatz` | **Bennett's trick**: compute a non-injective function, copy the answer, uncall to erase the garbage trail |
| `cipher` | **TEA block cipher**. Nobody wrote a decryptor: `uncall tea` *is* decryption. Bit-exact against a reference TEA |
| `lehmer` | permutation → Lehmer code; the decoder is `uncall` of the encoder |
| `sort` | reversible bubble sort; run it backwards and it un-sorts into the original order |
| `threebody` | **Pythagorean three-body problem**: chaotic, yet integer leapfrog is exactly invertible, so the tangle un-tangles back to rest bit-for-bit |
| `life` | **Reversible Game of Life** via Fredkin's second-order trick: the word MOBIUS dissolves into chaos and reassembles |

## What is verified

* **Differential fuzzing.** Thousands of random well-formed programs (random updates, swaps, ifs with random assertions, loops, locals, stacks, reference calls and uncalls). The compiled VM and the reference interpreter must agree on whether the program faults, and if it doesn't, on every bit of the final store and output tape.
* For every successful run: a full `unstep` rewind reproduces the initial *machine fingerprint* (pc, br, dir, every register, every memory cell, the tape). `step∘unstep = id` holds on sampled states. Running `main⁻¹` on the output reproduces the input. **And** the source-level inverse I[p] is compiled separately and run *forward*, and it gives the same pre-image.
* Faulted runs (assertion failures, out-of-bounds, division by zero, aliasing) also rewind exactly to t = 0.
* `I[I[p]] = p`, and pretty-print/parse round-trips, for every example.

## Language reference

```
const K = 5
int x = 3            int a[8] = {1, 2}          stack s[64]

procedure p(int x, int a[], stack s)       // all parameters by reference
  x += e    x -= e    x ^= e                // x may not occur in e
  a[i] += e                                 // reading a[i] itself in e faults at run time
  x <=> y
  if c then … else … fi a                   // a must be true iff the then-branch ran
  from a do … loop … until c                // a: true on entry only. c: exit test
  local int t = e  …  delocal int t = e'    // t must equal e' at delocal
  call q(x, y)     uncall q(x, y)
  push(x, s)       pop(x, s)                // push zeroes x. pop requires x = 0
  write e          plot x, y, colour        // reversible output (inverse: unwrite / unplot)
  skip
```

Expressions: `+ - * / % & | ^ << >> >>> < <= > >= = != && || ! ~ -`, `sqrt abs size top empty`. All arithmetic is int32 with wraparound, and wraparound is what keeps `x += e` a bijection for every `e`.

Pragmas: `//@title`, `//@desc`, `//@viz <array> <width>`, `//@plot xmin xmax ymin ymax`.

## Lineage

Janus (Lutz & Derby 1982; Yokoyama & Glück 2007), PISA / the Pendulum processor (Vieri 1999; Frank 1999), clean Janus→PISA translation (Axelsen 2011), Bennett's reversible computation (1973), Fredkin's second-order reversible cellular automata. Möbius's own contributions are the XOR-into expression ISA with symmetric `CHKZ` alias detection, history-free T⁻¹ stepping as a debugger primitive, and the end-to-end cross-validated toolchain.
