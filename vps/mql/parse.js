// MQL5 subset: lexer + parser. Produces an AST for interp.js. Anything outside the subset throws MqlError with a line number.
export class MqlError extends Error { constructor(m, line) { super(line ? `line ${line}: ${m}` : m); this.line = line; } }

const BASE_TYPES = new Set(['void', 'bool', 'char', 'uchar', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double', 'string', 'datetime', 'color']);
const MODS = new Set(['input', 'sinput', 'extern', 'static', 'const', 'virtual', 'volatile']);
const OPS = ['>>=', '<<=', '...', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '->', '::', '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~', '?', ':', ';', ',', '.', '(', ')', '[', ']', '{', '}'];

export function lex(src) {
  const toks = [], defs = new Map(); let i = 0, line = 1; const n = src.length;
  const unsupported = [];
  const push = (t, v, x) => toks.push({ t, v, line, ...x });
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '#') { // preprocessor line
      let j = i; while (j < n && src[j] !== '\n') { if (src[j] === '\\' && src[j + 1] === '\n') { j += 2; line++; continue; } j++; }
      const txt = src.slice(i, j).replace(/\/\/.*$/, '').trim(); i = j;
      let m;
      if ((m = /^#\s*define\s+([A-Za-z_]\w*)\s+(.+)$/.exec(txt))) defs.set(m[1], m[2].trim());
      else if (/^#\s*define\s+[A-Za-z_]\w*\s*\(/.test(txt)) unsupported.push(`macro with parameters (line ${line}): ${txt.slice(0, 40)}`);
      else if (/^#\s*import/.test(txt)) unsupported.push('#import (a DLL or library)');
      else if ((m = /^#\s*include\s+"(.+)"/.exec(txt))) unsupported.push(`#include "${m[1]}" (a local file)`);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < n && /[\w]/.test(src[j])) j++; const w = src.slice(i, j); i = j;
      if (defs.has(w)) { const sub = lex(defs.get(w)).toks; for (const s of sub) toks.push({ ...s, line }); } else push('id', w); continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      if (c === '0' && /[xX]/.test(src[i + 1] || '')) { j = i + 2; while (j < n && /[0-9a-fA-F]/.test(src[j])) j++; push('num', parseInt(src.slice(i, j), 16), { int: true }); i = j; continue; }
      while (j < n && /[0-9]/.test(src[j])) j++; let isInt = true;
      if (src[j] === '.') { isInt = false; j++; while (j < n && /[0-9]/.test(src[j])) j++; }
      if (/[eE]/.test(src[j] || '') && /[-+0-9]/.test(src[j + 1] || '')) { isInt = false; j += 2; while (j < n && /[0-9]/.test(src[j])) j++; }
      push('num', parseFloat(src.slice(i, j)), { int: isInt }); i = j; if (/[fF]/.test(src[i] || '') && !isInt) i++; continue;
    }
    if (c === '"') { let j = i + 1, s = ''; while (j < n && src[j] !== '"') { if (src[j] === '\\') { const e = src[j + 1]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e; j += 2; } else s += src[j++]; } push('str', s); i = j + 1; continue; }
    if (c === "'") { let j = i + 1, s = ''; while (j < n && src[j] !== "'") { if (src[j] === '\\') { const e = src[j + 1]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; j += 2; } else s += src[j++]; } push('num', s.length ? s.charCodeAt(0) : 0, { int: true }); i = j + 1; continue; }
    let op = null; for (const o of OPS) if (src.startsWith(o, i)) { op = o; break; }
    if (!op) throw new MqlError(`unexpected character "${c}"`, line);
    push('op', op); i += op.length;
  }
  push('eof', '');
  return { toks, unsupported };
}

export function parse(src) {
  const { toks, unsupported } = lex(src); let p = 0;
  const userTypes = new Set(), enums = new Map();
  for (let k = 0; k < toks.length - 1; k++) if (toks[k].t === 'id' && (toks[k].v === 'struct' || toks[k].v === 'class' || toks[k].v === 'enum') && toks[k + 1].t === 'id') userTypes.add(toks[k + 1].v);
  const cur = () => toks[p], peek = (o = 1) => toks[Math.min(p + o, toks.length - 1)];
  const err = m => { throw new MqlError(m, cur().line); };
  const isOp = v => cur().t === 'op' && cur().v === v;
  const isId = v => cur().t === 'id' && cur().v === v;
  const eat = v => { if (isOp(v)) { p++; return true; } return false; };
  const expect = v => { if (!eat(v)) err(`expected "${v}" but found "${cur().v}"`); };
  const ident = () => { if (cur().t !== 'id') err(`expected a name but found "${cur().v}"`); return toks[p++].v; };
  const isTypeName = tk => tk.t === 'id' && (BASE_TYPES.has(tk.v) || userTypes.has(tk.v) || /^(ENUM_\w+|Mql\w+|C[A-Z]\w+)$/.test(tk.v));

  function typeSpec() { // [const] type [&]
    let isConst = false; while (cur().t === 'id' && MODS.has(cur().v)) { if (cur().v === 'const') isConst = true; p++; }
    if (!isTypeName(cur())) err(`unknown type "${cur().v}"`);
    const name = toks[p++].v; let ptr = false; if (isOp('*')) { p++; ptr = true; }
    return { name, ptr, isConst };
  }
  function params() {
    const out = []; expect('(');
    if (isId('void') && peek().v === ')') p++;
    while (!isOp(')')) {
      const ty = typeSpec(); let ref = false; if (eat('&')) ref = true;
      let name = ''; if (cur().t === 'id') name = ident();
      let arr = false; if (eat('[')) { expect(']'); arr = true; }
      let def = null; if (eat('=')) def = expr();
      out.push({ type: ty.name, ref, name, arr, def }); if (!eat(',')) break;
    }
    expect(')'); return out;
  }
  // ----- expressions (precedence climbing)
  const BIN = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
  function expr() { return assign(); }
  function assign() {
    const l = ternary();
    if (cur().t === 'op' && /^(=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<=|>>=)$/.test(cur().v)) { const op = toks[p++].v, line = cur().line; const r = assign(); return { k: 'assign', op, l, r, line }; }
    return l;
  }
  function ternary() { const c = bin(0); if (eat('?')) { const a = assign(); expect(':'); const b = assign(); return { k: 'cond', c, a, b }; } return c; }
  function bin(lv) {
    if (lv >= BIN.length) return unary();
    let l = bin(lv + 1);
    while (cur().t === 'op' && BIN[lv].includes(cur().v)) { const op = toks[p++].v, line = cur().line; const r = bin(lv + 1); l = { k: 'bin', op, l, r, line }; }
    return l;
  }
  function unary() {
    const line = cur().line;
    if (cur().t === 'op') {
      const v = cur().v;
      if (v === '!' || v === '-' || v === '+' || v === '~') { p++; return { k: 'un', op: v, e: unary(), line }; }
      if (v === '++' || v === '--') { p++; return { k: 'pre', op: v, e: unary(), line }; }
      if (v === '&') { p++; return unary(); }
      if (v === '(' && isTypeName(peek()) && ((peek(2).t === 'op' && peek(2).v === ')') || (peek(2).t === 'op' && peek(2).v === '&'))) { p++; const ty = typeSpec(); expect(')'); return { k: 'cast', type: ty.name, e: unary(), line }; }
    }
    if (isId('new')) { p++; const ty = ident(); let args = []; if (isOp('(')) args = callArgs(); return { k: 'new', type: ty, args, line }; }
    if (isId('delete')) { p++; return { k: 'delete', e: unary(), line }; }
    return postfix();
  }
  function callArgs() { expect('('); const a = []; while (!isOp(')')) { a.push(assign()); if (!eat(',')) break; } expect(')'); return a; }
  function postfix() {
    let e = primary();
    for (;;) {
      const line = cur().line;
      if (isOp('(') && e.k === 'name') { e = { k: 'call', name: e.name, args: callArgs(), line }; }
      else if (isOp('[')) { p++; const i = expr(); expect(']'); e = { k: 'idx', e, i, line }; }
      else if (isOp('.') || isOp('->')) { p++; const m = ident(); if (isOp('(')) e = { k: 'mcall', o: e, name: m, args: callArgs(), line }; else e = { k: 'mem', o: e, name: m, line }; }
      else if (isOp('++') || isOp('--')) { const op = toks[p++].v; e = { k: 'post', op, e, line }; }
      else break;
    }
    return e;
  }
  function primary() {
    const t = cur(), line = t.line;
    if (t.t === 'num') { p++; return { k: 'num', v: t.v, int: !!t.int }; }
    if (t.t === 'str') { p++; let s = t.v; while (cur().t === 'str') s += toks[p++].v; return { k: 'str', v: s }; }
    if (t.t === 'op' && t.v === '(') { p++; const e = expr(); expect(')'); return e; }
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') { p++; return { k: 'bool', v: t.v === 'true' }; }
      if (t.v === 'NULL') { p++; return { k: 'num', v: 0, int: true }; }
      if (isTypeName(t) && peek().t === 'op' && peek().v === '(') { p++; const a = callArgs(); return { k: 'cast', type: t.v, e: a[0] || { k: 'num', v: 0, int: true }, line, ctor: true, args: a }; }
      if (peek().t === 'op' && peek().v === '::') { p += 2; const m = ident(); return { k: 'name', name: m, line }; }
      p++; return { k: 'name', name: t.v, line };
    }
    err(`unexpected "${t.v}"`);
  }
  // ----- statements
  function block() { expect('{'); const out = []; while (!isOp('}')) { if (cur().t === 'eof') err('missing }'); out.push(stmt()); } expect('}'); return { k: 'block', body: out }; }
  function isDeclStart() {
    let q = p; while (toks[q].t === 'id' && MODS.has(toks[q].v)) q++;
    if (!isTypeName(toks[q])) return false;
    let r = q + 1; if (toks[r].t === 'op' && (toks[r].v === '*' || toks[r].v === '&')) r++;
    return toks[r].t === 'id';
  }
  function declarators(ty, line, extra) {
    const out = [];
    do {
      let ptr = false; if (eat('*')) ptr = true; eat('&');
      const name = ident(); let dims = null;
      if (eat('[')) { dims = []; if (!isOp(']')) dims.push(expr()); expect(']'); if (isOp('[')) err('multi-dimensional arrays are not supported yet'); }
      let init = null; if (eat('=')) init = isOp('{') ? arrInit() : assign(); else if (isOp('(') && !dims) { init = { k: 'new', type: ty.name, args: callArgs(), line }; }
      out.push({ k: 'decl', type: ty.name, name, dims, init, ptr, line, ...extra });
    } while (eat(','));
    return out;
  }
  function arrInit() { expect('{'); const a = []; while (!isOp('}')) { a.push(assign()); if (!eat(',')) break; } expect('}'); return { k: 'arrinit', items: a }; }
  function stmt() {
    const line = cur().line;
    if (isOp('{')) return block();
    if (eat(';')) return { k: 'block', body: [] };
    if (cur().t === 'id') {
      const v = cur().v;
      if (v === 'if') { p++; expect('('); const c = expr(); expect(')'); const a = stmt(); let b = null; if (isId('else')) { p++; b = stmt(); } return { k: 'if', c, a, b }; }
      if (v === 'for') { p++; expect('('); let init = null; if (!isOp(';')) { init = isDeclStart() ? { k: 'block', body: declarators(typeSpec(), line), noScope: true } : { k: 'expr', e: exprList() }; } expect(';'); const c = isOp(';') ? null : expr(); expect(';'); const step = isOp(')') ? null : exprList(); expect(')'); return { k: 'for', init, c, step, body: stmt() }; }
      if (v === 'while') { p++; expect('('); const c = expr(); expect(')'); return { k: 'while', c, body: stmt() }; }
      if (v === 'do') { p++; const body = stmt(); if (!isId('while')) err('expected while'); p++; expect('('); const c = expr(); expect(')'); eat(';'); return { k: 'dowhile', c, body }; }
      if (v === 'switch') { p++; expect('('); const e = expr(); expect(')'); expect('{'); const cases = []; let curCase = null; while (!isOp('}')) { if (isId('case')) { p++; const t = ternary(); expect(':'); curCase = { test: t, body: [] }; cases.push(curCase); } else if (isId('default')) { p++; expect(':'); curCase = { test: null, body: [] }; cases.push(curCase); } else { if (!curCase) err('statement before case'); curCase.body.push(stmt()); } } expect('}'); return { k: 'switch', e, cases }; }
      if (v === 'break') { p++; eat(';'); return { k: 'break' }; }
      if (v === 'continue') { p++; eat(';'); return { k: 'continue' }; }
      if (v === 'return') { p++; let e = null; if (!isOp(';')) e = expr(); eat(';'); return { k: 'return', e, line }; }
      if (isDeclStart()) { const ty = typeSpec(); const ds = declarators(ty, line, { isStatic: false }); expect(';'); return { k: 'block', body: ds, noScope: true }; }
    }
    const e = exprList(); expect(';'); return { k: 'expr', e };
  }
  function exprList() { const e = expr(); if (isOp(',')) { const list = [e]; while (eat(',')) list.push(expr()); return { k: 'seq', list }; } return e; }
  // ----- top level
  const prog = { inputs: [], globals: [], funcs: new Map(), structs: new Map(), enums: new Map(), unsupported };
  function structDecl(kind) {
    const name = ident(); let base = null; if (eat(':')) { if (isId('public') || isId('private') || isId('protected')) p++; base = ident(); }
    expect('{'); const fields = [], methods = []; 
    while (!isOp('}')) {
      if ((isId('public') || isId('private') || isId('protected')) && peek().v === ':') { p += 2; continue; }
      let isVirtual = false; while (cur().t === 'id' && MODS.has(cur().v)) { p++; }
      if (isOp('~')) { p++; ident(); params(); if (isOp('{')) block(); else eat(';'); continue; }
      if (cur().t === 'id' && cur().v === name && peek().v === '(') { p++; const ps = params(); let body = null; if (eat(':')) { while (!isOp('{')) p++; } if (isOp('{')) body = block(); else eat(';'); methods.push({ name: '__ctor', ret: 'void', params: ps, body }); continue; }
      const ty = typeSpec(); const line = cur().line;
      if (cur().t === 'id' && peek().v === '(') { const mname = ident(); const ps = params(); let body = null; while (isId('const')) p++; if (isOp('{')) body = block(); else eat(';'); methods.push({ name: mname, ret: ty.name, params: ps, body }); }
      else { fields.push(...declarators(ty, line)); expect(';'); }
    }
    expect('}'); eat(';'); prog.structs.set(name, { name, base, fields, methods, kind });
  }
  function enumDecl() {
    const name = ident(); expect('{'); let v = 0; const list = [];
    while (!isOp('}')) { const k = ident(); if (eat('=')) { const e = ternary(); list.push({ k, e }); } else list.push({ k, e: null }); if (!eat(',')) break; }
    expect('}'); eat(';'); prog.enums.set(name, list);
  }
  while (cur().t !== 'eof') {
    if (isId('struct') || isId('class')) { const kind = toks[p++].v; structDecl(kind); continue; }
    if (isId('enum')) { p++; enumDecl(); continue; }
    if (isId('template')) err('templates are not supported');
    if (isId('input') && peek().t === 'id' && peek().v === 'group') { p += 2; if (cur().t === 'str') p++; continue; }
    const startTok = cur(); const mods = new Set(); let q = p; while (toks[q].t === 'id' && MODS.has(toks[q].v)) { mods.add(toks[q].v); q++; }
    const ty = typeSpec(); const line = cur().line;
    if (cur().t === 'id' && peek().v === '(') {
      const name = ident(); const ps = params(); while (isId('const')) p++; let body = null; if (isOp('{')) body = block(); else eat(';');
      if (body) prog.funcs.set(name, { name, ret: ty.name, params: ps, body, line });
      continue;
    }
    const ds = declarators(ty, line, { isInput: mods.has('input') || mods.has('sinput'), isStatic: mods.has('static') }); expect(';');
    // the comment after an input line ("// lots per trade") is used as its label in the app
    for (const d of ds) { if (d.isInput) { prog.inputs.push(d); } prog.globals.push(d); }
  }
  // attach trailing comments to inputs (cheap second pass over the raw source)
  const lines = src.split(/\r?\n/);
  for (const d of prog.inputs) { const l = lines[d.line - 1] || ''; const m = /\/\/\s*(.*)$/.exec(l); d.comment = m ? m[1].trim().slice(0, 120) : ''; }
  return prog;
}
