// Möbius IDE — a time-travel debugger with no history buffer.
import { build, VM, Interpreter, showProgram, invertProgram, formatInstr, OPS } from '../src/index.js';

const EXAMPLES = window.MOBIUS_EXAMPLES; // [{name, src}]
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => n.toLocaleString('en-US');

const S = {
  ast: null, program: null, vm: null,
  run: 0,             // +1 playing forward, -1 playing backward, 0 paused
  seek: null,         // target t for the timeline
  maxT: 0,
  speed: 4,
  lineMode: false,
  epoch: 'main',      // 'main' or 'main⁻¹'
  dirty: true,
};
const SPEEDS = [1, 3, 10, 40, 200, 1000, 5000, 30000, 200000, 2000000];
const SPEED_LABEL = ['1', '3', '10', '40', '200', '1k', '5k', '30k', '200k', 'max'];

// ---------------------------------------------------------------- editor
const KW = /\b(procedure|int|stack|const|if|then|else|fi|from|do|loop|until|call|uncall|local|delocal|push|pop|skip|write|unwrite|plot|unplot)\b/;
function highlight(src) {
  return src.split('\n').map((line) => {
    let out = '', i = 0;
    const re = /(\/\/@.*$)|(\/\/.*$)|\b(procedure|int|stack|const|if|then|else|fi|from|do|loop|until|call|uncall|local|delocal|push|pop|skip|write|unwrite|plot|unplot)\b|\b(size|top|empty|sqrt|abs)\b|(0x[0-9a-fA-F_]+|0b[01_]+|\d[\d_]*|'(?:\\.|[^'])')|(<=>|\+=|-=|\^=)/g;
    let m;
    while ((m = re.exec(line))) {
      out += esc(line.slice(i, m.index));
      const cls = m[1] ? 'prag' : m[2] ? 'com' : m[3] ? (/^(call|uncall)$/.test(m[3]) ? 'kw2' : 'kw') : m[4] ? 'bi' : m[5] ? 'num' : 'upd';
      out += `<span class="${cls}">${esc(m[0])}</span>`;
      i = m.index + m[0].length;
    }
    return out + esc(line.slice(i));
  });
}
function renderEditor(activeLine = 0, errLine = 0) {
  const ta = $('#src');
  const lines = highlight(ta.value);
  const dirCls = S.vm && S.vm.dir < 0 ? 'back' : 'fwd';
  $('#hl').innerHTML = lines.map((l, i) => {
    const n = i + 1;
    const cls = n === errLine ? 'ln err' : n === activeLine ? `ln active ${dirCls}` : 'ln';
    return `<div class="${cls}"><span class="gut">${n}</span>${l || ' '}</div>`;
  }).join('');
  syncScroll();
}
function syncScroll() { $('#hl').scrollTop = $('#src').scrollTop; $('#hl').scrollLeft = $('#src').scrollLeft; }
function revealLine(n) {
  if (!n) return;
  const ta = $('#src');
  const lh = 19;
  const y = (n - 1) * lh;
  if (y < ta.scrollTop + 20 || y > ta.scrollTop + ta.clientHeight - 60) ta.scrollTop = Math.max(0, y - ta.clientHeight / 2);
}

// ---------------------------------------------------------------- compile
function compileNow() {
  stop();
  const src = $('#src').value;
  try {
    const { ast, program } = build(src);
    S.ast = ast; S.program = program; S.vm = new VM(program);
    S.maxT = 0; S.epoch = 'main'; S.origin = S.vm.fingerprint();
    S.vm.status = 'ready';
    $('#err').textContent = '';
    $('#err').classList.remove('show');
    $('#inverse').innerHTML = highlight(showProgram(invertProgram(ast))).map((l) => `<div>${l || ' '}</div>`).join('');
    $('#title').textContent = ast.meta.title || 'untitled program';
    $('#desc').textContent = ast.meta.desc || '';
    $('#stat-code').textContent = `${fmt(program.code.length)} instructions · ${program.procAt.size} procedures`;
    buildGlobals();
    renderEditor();
    buildListing();
    S.dirty = true;
    $('#verify-out').innerHTML = '';
  } catch (e) {
    S.vm = null;
    $('#err').textContent = e.message;
    $('#err').classList.add('show');
    renderEditor(0, e.line || 0);
    revealLine(e.line);
    $('#listing').innerHTML = '';
  }
  renderAll();
}

// ---------------------------------------------------------------- control loop
function stop() { S.run = 0; S.seek = null; updateButtons(); }
function play(d) { if (!S.vm) return; S.seek = null; S.run = S.run === d ? 0 : d; if (S.vm.status === 'trap' && d > 0) S.run = 0; updateButtons(); }

function stepOnce(d) {
  const vm = S.vm;
  if (!vm) return false;
  const ok = d > 0 ? vm.step() : vm.unstep();
  if (vm.t > S.maxT) S.maxT = vm.t;
  return ok;
}
// Step until the source line changes (one "statement" of source-level stepping).
function stepLine(d) {
  const vm = S.vm; if (!vm) return;
  const start = vm.sourceLine();
  let n = 0;
  while (n++ < 5_000_000) {
    if (!stepOnce(d)) break;
    const l = vm.sourceLine();
    if (l && l !== start) break;
  }
  S.dirty = true;
}

function frame() {
  const vm = S.vm;
  if (vm && (S.run || S.seek !== null)) {
    const budget = S.seek !== null ? 1e9 : SPEEDS[S.speed];
    const t0 = performance.now();
    let n = 0;
    while (n < budget) {
      let d = S.run;
      if (S.seek !== null) { if (vm.t === S.seek) { S.seek = null; break; } d = S.seek > vm.t ? 1 : -1; }
      if (!stepOnce(d)) { S.run = 0; S.seek = null; break; }
      n++;
      if ((n & 1023) === 0 && performance.now() - t0 > 14) break;
    }
    S.dirty = true;
    if (!S.run && S.seek === null) updateButtons();
  }
  if (S.dirty) { renderAll(); S.dirty = false; }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- rendering
function renderAll() {
  const vm = S.vm;
  updateButtons();
  if (!vm) { $('#machine').classList.add('off'); return; }
  $('#machine').classList.remove('off');
  const back = vm.dir < 0;
  document.body.classList.toggle('backward', back);
  $('#t').textContent = fmt(vm.t);
  $('#pc').textContent = vm.pc;
  $('#br').textContent = vm.br;
  $('#dir').textContent = back ? '−1  ◀ time reversed' : '+1  ▶';
  $('#hist').textContent = vm.historyBytes + ' bytes';
  $('#naive').textContent = fmt(Math.max(S.maxT, vm.t) * 12) + ' bytes';
  const status = vm.status === 'trap' ? 'FAULT' : vm.status === 'halted' ? 'HALTED (end of main)' : vm.status === 'start' ? (S.epoch === 'main⁻¹' ? 'HALTED (end of main⁻¹)' : 'AT ORIGIN') : vm.t === 0 ? 'AT ORIGIN (t = 0)' : S.run > 0 ? 'RUNNING ▶' : S.run < 0 ? 'REWINDING ◀' : 'PAUSED';
  $('#status').textContent = status;
  $('#status').className = 'chip ' + (vm.status === 'trap' ? 'bad' : vm.status === 'halted' || vm.status === 'start' ? 'good' : S.run ? 'live' : '');
  $('#epoch').textContent = S.epoch === 'main' ? 'executing main' : 'executing main⁻¹ (the inverse program)';
  $('#fault').textContent = vm.fault ? `⚠ line ${vm.fault.line}: ${vm.fault.msg}. Step back (◀) — the faulting step never happened.` : '';
  const tl = $('#timeline');
  tl.max = Math.max(S.maxT, vm.t, 1);
  if (S.seek === null && document.activeElement !== tl) tl.value = vm.t;
  $('#tl-max').textContent = fmt(Math.max(S.maxT, vm.t));
  const line = vm.sourceLine();
  renderEditor(line);
  if (S.run || S.seek !== null || S.follow) revealLine(line);
  renderListing();
  renderRegs();
  renderGlobals();
  renderTape();
  renderPlot();
  renderViz();
}

function updateButtons() {
  const has = !!S.vm;
  document.querySelectorAll('[data-needs-vm]').forEach((b) => (b.disabled = !has));
  $('#b-play').classList.toggle('on', S.run > 0);
  $('#b-rplay').classList.toggle('on', S.run < 0);
  $('#b-play').textContent = S.run > 0 ? '❚❚' : '▶▶';
  $('#b-rplay').textContent = S.run < 0 ? '❚❚' : '◀◀';
  const vm = S.vm;
  $('#b-inverse').disabled = !(vm && vm.br === 0 && (vm.status === 'halted' || vm.t === 0 || vm.status === 'start'));
}

// ---- assembly listing (windowed)
let listingRows = [];
function buildListing() {
  const p = S.program;
  listingRows = p.code.map((ins, a) => {
    const head = p.procAt.has(a) ? `<div class="proc">${esc(p.procAt.get(a))}:</div>` : '';
    return { head, body: `<span class="addr">${a}</span><span class="ins">${esc(formatInstr(ins, a))}</span><span class="note">${esc(ins.note || (ins.msg ? 'assert: ' + ins.msg : ''))}</span>` };
  });
}
function renderListing() {
  const vm = S.vm; if (!vm) return;
  const pc = vm.pc, W = 13;
  const lo = Math.max(0, pc - W), hi = Math.min(listingRows.length, pc + W + 1);
  let h = '';
  for (let a = lo; a < hi; a++) {
    const r = listingRows[a];
    const cls = a === pc ? (vm.dir < 0 ? 'row cur back' : 'row cur') : 'row';
    h += r.head + `<div class="${cls}">${r.body}</div>`;
  }
  $('#listing').innerHTML = h;
}

function renderRegs() {
  const vm = S.vm;
  let h = `<span class="reg"><b>sp</b> ${vm.R[1]}</span><span class="reg"><b>ro</b> ${vm.R[2]}</span>`;
  let k = 0;
  for (let r = 3; r < vm.R.length; r++) if (vm.R[r] !== 0) { if (k++ < 40) h += `<span class="reg live"><b>r${r}</b> ${vm.R[r]}</span>`; }
  if (k > 40) h += `<span class="reg">+${k - 40} more</span>`;
  if (!k) h += `<span class="reg dim">scratch r3–r255 all zero</span>`;
  $('#regs').innerHTML = h;
}

// ---- globals (editable)
function buildGlobals() {
  const p = S.program;
  const vizNames = new Set((S.ast.meta.viz || []).map((v) => v.name));
  $('#globals').innerHTML = p.symbols.map((g) => {
    if (g.kind === 'int') return `<div class="g"><label>${esc(g.name)}</label><input data-g="${esc(g.name)}" class="gi" spellcheck="false"></div>`;
    if (g.kind === 'array' && g.size <= 16 && !vizNames.has(g.name))
      return `<div class="g arr"><label>${esc(g.name)}[${g.size}]</label><div class="cells">${Array.from({ length: g.size }, (_, i) => `<input data-g="${esc(g.name)}" data-i="${i}" class="gi c" spellcheck="false">`).join('')}</div></div>`;
    if (g.kind === 'array') return `<div class="g"><label>${esc(g.name)}[${g.size}]</label><span class="sum" data-sum="${esc(g.name)}"></span></div>`;
    return `<div class="g stk"><label>stack ${esc(g.name)}</label><span class="stack" data-stk="${esc(g.name)}"></span></div>`;
  }).join('');
  document.querySelectorAll('.gi').forEach((inp) => {
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v)) { S.dirty = true; return; }
      S.vm.setGlobal(inp.dataset.g, v | 0, inp.dataset.i !== undefined ? Number(inp.dataset.i) : null);
      flash('Edited the present. The past is now whatever state leads here — step back to see it.');
      S.dirty = true;
    });
  });
}
function renderGlobals() {
  const snap = S.vm.snapshot();
  document.querySelectorAll('.gi').forEach((inp) => {
    if (document.activeElement === inp) return;
    const v = snap[inp.dataset.g];
    const val = inp.dataset.i !== undefined ? v[Number(inp.dataset.i)] : v;
    const s = String(val);
    if (inp.value !== s) { inp.value = s; inp.classList.remove('chg'); void inp.offsetWidth; inp.classList.add('chg'); }
  });
  document.querySelectorAll('[data-sum]').forEach((el) => {
    const a = snap[el.dataset.sum];
    const nz = a.filter((x) => x).length;
    el.textContent = `${nz} nonzero · Σ = ${a.reduce((x, y) => x + y, 0)}`;
  });
  document.querySelectorAll('[data-stk]').forEach((el) => {
    const a = snap[el.dataset.stk];
    el.innerHTML = a.length ? `<span class="dim">${a.length} ▸</span> ` + a.slice(-24).map((x) => `<i>${x}</i>`).join('') : '<span class="dim">empty</span>';
  });
}

function renderTape() {
  const vm = S.vm;
  const w = [];
  let p = 0;
  for (const e of vm.tape) { if (e.k === 'w') w.push(e.v); else p++; }
  $('#tape').innerHTML = w.length ? w.slice(-60).map((v) => `<i>${v}</i>`).join('') : `<span class="dim">${p ? p + ' plotted points' : 'nothing written yet'}</span>`;
  $('#tape-n').textContent = `${vm.tape.length} entries`;
}

const COLORS = ['#f5b14c', '#4cc9f0', '#ff6b9a', '#9be564', '#c792ea', '#ffd166'];
function renderPlot() {
  const vm = S.vm, cv = $('#plot');
  const pts = vm.tape.filter((e) => e.k === 'p');
  $('#plot-wrap').style.display = pts.length || S.ast.meta.plot ? '' : 'none';
  if (!pts.length && !S.ast.meta.plot) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.fillStyle = '#07090d'; ctx.fillRect(0, 0, W, H);
  let b = S.ast.meta.plot && S.ast.meta.plot.length === 4 ? S.ast.meta.plot : null;
  if (!b) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of pts) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const pad = Math.max(x1 - x0, y1 - y0, 10) * 0.08;
    b = [x0 - pad, x1 + pad, y0 - pad, y1 + pad];
  }
  const sx = (x) => ((x - b[0]) / (b[1] - b[0])) * W, sy = (y) => H - ((y - b[2]) / (b[3] - b[2])) * H;
  const last = new Map();
  ctx.lineWidth = 1.1;
  for (const q of pts) {
    const prev = last.get(q.c);
    ctx.strokeStyle = COLORS[((q.c % COLORS.length) + COLORS.length) % COLORS.length] + 'aa';
    if (prev) { ctx.beginPath(); ctx.moveTo(sx(prev.x), sy(prev.y)); ctx.lineTo(sx(q.x), sy(q.y)); ctx.stroke(); }
    last.set(q.c, q);
  }
  for (const [c, q] of last) {
    ctx.fillStyle = COLORS[((c % COLORS.length) + COLORS.length) % COLORS.length];
    ctx.beginPath(); ctx.arc(sx(q.x), sy(q.y), 4.5, 0, Math.PI * 2); ctx.fill();
  }
  $('#plot-n').textContent = `${pts.length} points`;
}

function renderViz() {
  const vizs = S.ast.meta.viz || [];
  const host = $('#viz');
  if (host.dataset.key !== S.program.code.length + ':' + vizs.length) {
    host.dataset.key = S.program.code.length + ':' + vizs.length;
    host.innerHTML = vizs.map((v, i) => `<figure><canvas id="viz${i}" width="240" height="240"></canvas><figcaption>${esc(v.name)}</figcaption></figure>`).join('');
  }
  host.style.display = vizs.length ? '' : 'none';
  const snap = S.vm.snapshot();
  vizs.forEach((v, i) => {
    const a = snap[v.name]; if (!a) return;
    const w = v.width || Math.ceil(Math.sqrt(a.length)), h = Math.ceil(a.length / w);
    const cv = document.getElementById('viz' + i), ctx = cv.getContext('2d');
    const cs = Math.floor(Math.min(cv.width / w, cv.height / h));
    ctx.fillStyle = '#07090d'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = i % 2 ? '#4cc9f0' : '#f5b14c';
    for (let k = 0; k < a.length; k++) if (a[k]) ctx.fillRect((k % w) * cs, Math.floor(k / w) * cs, cs - (cs > 3 ? 1 : 0), cs - (cs > 3 ? 1 : 0));
  });
}

let flashTimer = 0;
function flash(msg) { const f = $('#flash'); f.textContent = msg; f.classList.add('show'); clearTimeout(flashTimer); flashTimer = setTimeout(() => f.classList.remove('show'), 4200); }

// ---------------------------------------------------------------- verification
async function verify() {
  stop();
  const out = $('#verify-out');
  const program = S.program;
  const vm = new VM(program); // verification always starts from the program's declared initial data
  const f0 = vm.fingerprint();
  const lines = [];
  const say = (s) => { lines.push(s); out.innerHTML = lines.join('<br>'); };
  say('running forward…');
  await tick();
  let t0 = performance.now();
  while (vm.step()) { if ((vm.t & 0x3fffff) === 0) { out.innerHTML = lines.join('<br>') + `<br>… ${fmt(vm.t)} steps`; await tick(); } }
  const tf = performance.now() - t0;
  if (vm.status === 'trap') { say(`✗ program faults at line ${vm.fault.line}: ${esc(vm.fault.msg)}`); return; }
  const n = vm.t;
  lines.pop(); say(`✓ forward: ${fmt(n)} instructions in ${tf.toFixed(0)} ms`);
  // local bijectivity on a sample of steps
  vm.runBack(); let bad = 0; const sample = Math.min(n, 3000), stride = Math.max(1, Math.floor(n / sample));
  say('checking T⁻¹(T(s)) = s on sampled states…'); await tick();
  for (let k = 0; k < sample; k++) {
    const f = vm.fingerprint(); vm.step(); vm.unstep(); if (vm.fingerprint() !== f) bad++;
    for (let j = 0; j < stride && vm.step(); j++);
  }
  lines.pop(); say(`${bad ? '✗' : '✓'} T⁻¹∘T = id on ${fmt(sample)} sampled states (full-state fingerprints)`);
  vm.runBack(); vm.run();
  t0 = performance.now();
  const back = vm.runBack();
  const tb = performance.now() - t0;
  say(`${vm.fingerprint() === f0 && back === n ? '✓' : '✗'} rewound all ${fmt(back)} instructions in ${tb.toFixed(0)} ms — state identical to t = 0, history used: 0 bytes`);
  try {
    const it = new Interpreter(S.ast).run(1);
    vm.run();
    const same = JSON.stringify(it.snapshot()) === JSON.stringify(vm.snapshot()) && JSON.stringify(it.tape) === JSON.stringify(vm.tape);
    say(`${same ? '✓' : '✗'} compiled machine code agrees with the independent AST interpreter`);
    const init = new VM(program).snapshot();
    vm.reverseFromOrigin(); vm.run();
    say(`${JSON.stringify(vm.snapshot()) === JSON.stringify(init) && vm.status === 'start' ? '✓' : '✗'} running main⁻¹ on the output reproduces the input`);
  } catch (e) { say('✗ interpreter: ' + esc(e.message)); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- wiring
function loadExample(i) {
  $('#src').value = EXAMPLES[i].src;
  $('#src').scrollTop = 0;
  compileNow();
}
function init() {
  $('#examples').innerHTML = EXAMPLES.map((e, i) => `<option value="${i}">${esc(e.label)}</option>`).join('');
  $('#examples').addEventListener('change', (e) => loadExample(Number(e.target.value)));
  const ta = $('#src');
  ta.addEventListener('scroll', syncScroll);
  let timer = 0;
  ta.addEventListener('input', () => { renderEditor(); clearTimeout(timer); timer = setTimeout(compileNow, 450); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
  });
  $('#b-reset').onclick = () => { if (!S.vm) return; stop(); S.vm.reset(); S.maxT = 0; S.epoch = 'main'; S.dirty = true; };
  $('#b-rewind').onclick = () => { if (!S.vm) return; S.run = 0; S.seek = 0; S.follow = false; };
  $('#b-end').onclick = () => { if (!S.vm) return; stop(); S.vm.run(); if (S.vm.t > S.maxT) S.maxT = S.vm.t; S.dirty = true; };
  $('#b-play').onclick = () => play(1);
  $('#b-rplay').onclick = () => play(-1);
  $('#b-step').onclick = () => { stop(); S.lineMode ? stepLine(1) : stepOnce(1); S.follow = true; S.dirty = true; };
  $('#b-back').onclick = () => { stop(); S.lineMode ? stepLine(-1) : stepOnce(-1); S.follow = true; S.dirty = true; };
  $('#gran').onchange = (e) => { S.lineMode = e.target.value === 'line'; };
  $('#speed').oninput = (e) => { S.speed = Number(e.target.value); $('#speed-l').textContent = SPEED_LABEL[S.speed] + '/frame'; };
  $('#speed').value = S.speed; $('#speed-l').textContent = SPEED_LABEL[S.speed] + '/frame';
  $('#timeline').oninput = (e) => { if (!S.vm) return; S.run = 0; S.seek = Number(e.target.value); };
  $('#b-inverse').onclick = () => {
    const vm = S.vm; stop();
    vm.reverseFromOrigin(); vm.t = 0; S.maxT = 0; S.epoch = 'main⁻¹';
    flash('Direction bit flipped: ▶▶ now executes main⁻¹ on the current store — the inverse program, run on the machine as-is. (Reset returns to main.)');
    S.dirty = true;
  };
  $('#b-verify').onclick = verify;
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    const grp = b.parentElement.dataset.group;
    document.querySelectorAll(`.tabs[data-group="${grp}"] button`).forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll(`[data-pane="${grp}"]`).forEach((p) => p.classList.toggle('show', p.id === b.dataset.show));
  }));
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight') { $('#b-step').click(); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { $('#b-back').click(); e.preventDefault(); }
    if (e.key === ' ') { play(S.run >= 0 ? 1 : -1); e.preventDefault(); }
    if (e.key === 'Backspace') { play(-1); e.preventDefault(); }
  });
  // ISA reference table
  $('#isa').innerHTML = '<table>' + OPS.map(([n, sh, d]) => `<tr><td>${n}</td><td>${esc(sh)}</td><td>${esc(d)}</td></tr>`).join('') + '</table>';
  loadExample(0);
  requestAnimationFrame(frame);
}
init();
