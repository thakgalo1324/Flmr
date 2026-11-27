// MQL5 subset interpreter: compiles the AST from parse.js into JS closures. The EA's trade calls go to a host (live bridge or backtest).
import { parse, MqlError } from './parse.js';
import { CONSTS } from './consts.js';
import { makeLib } from './lib.js';
export { MqlError };

const INT_T = new Set(['char', 'uchar', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'datetime', 'color']);
const cat = t => !t ? '?' : INT_T.has(t) || /^ENUM_/.test(t) ? 'i' : t === 'bool' ? 'b' : t === 'double' || t === 'float' ? 'd' : t === 'string' ? 's' : t === 'void' ? 'v' : 'o:' + t;
const trunc = v => { v = +v; return v < 0 ? Math.ceil(v) : Math.floor(v); };
const coerceTo = t => { const c = cat(t); return c === 'i' ? (v => (typeof v === 'number' ? (Number.isFinite(v) ? trunc(v) : 0) : typeof v === 'boolean' ? +v : Number.isFinite(+v) ? trunc(+v) : 0)) : c === 'b' ? (v => !!v) : c === 'd' ? (v => (typeof v === 'number' ? v : +v || 0)) : c === 's' ? (v => (v === undefined || v === null ? '' : String(v))) : (v => v); };
const defaultOf = (t, vm) => { const c = cat(t); return c === 'i' || c === 'd' ? 0 : c === 'b' ? false : c === 's' ? '' : (vm.makeObject(t)); };
export const mkArr = (a = []) => { a.s = false; return a; };
const idxGet = (a, i) => { if (!Array.isArray(a)) throw new MqlError('index used on something that is not an array'); i = trunc(i); const k = a.s ? a.length - 1 - i : i; if (k < 0 || k >= a.length) { const e = new MqlError(`array out of range (index ${i}, size ${a.length})`); e.fatal = true; throw e; } return a[k]; };
const idxSet = (a, i, v) => { i = trunc(i); const k = a.s ? a.length - 1 - i : i; if (k < 0 || k >= a.length) { const e = new MqlError(`array out of range (index ${i}, size ${a.length})`); e.fatal = true; throw e; } a[k] = v; };

export function createVM(source, host, opts = {}) {
  const prog = parse(source);
  const vm = { prog, host, halted: false, error: '', warnings: [], printed: [], handles: [], G: [], inputs: [], timer: 0 };
  const lib = makeLib(vm);
  vm.lib = lib;
  const funcsC = new Map();      // user functions: {params, nslots, run}
  const globalsIdx = new Map();  // name -> {slot,type}
  const classC = new Map();      // user struct/class: {def, fields, methods: Map}
  const unknownCalls = new Set();

  vm.makeObject = (t) => {
    if (lib.classes[t]) return lib.classes[t]();
    const sd = prog.structs.get(t);
    if (sd) { const o = { __t: t }; const chain = []; for (let d = sd; d; d = d.base ? prog.structs.get(d.base) : null) chain.unshift(d); for (const d of chain) for (const f of d.fields) { o[f.name] = f.dims ? mkArr() : defaultOf(f.type, vm); } return o; }
    if (lib.structs[t]) return lib.structs[t]();
    if (prog.enums.has(t)) return 0;
    return null;
  };
  vm.log = m => { vm.printed.push(m); if (vm.printed.length > 200) vm.printed.shift(); if (host.log) host.log(m); };
  const fatal = m => { const e = new MqlError(m); e.fatal = true; throw e; };

  // ---------- compile-time scope handling
  let scopes = [], nslots = 2, curClass = null, curFnName = '';
  const pushScope = () => scopes.push(new Map()); const popScope = () => scopes.pop();
  const declLocal = (name, type, extra) => { const v = { slot: nslots++, type, local: true, ...extra }; scopes[scopes.length - 1].set(name, v); return v; };
  const lookup = name => { for (let i = scopes.length - 1; i >= 0; i--) { const v = scopes[i].get(name); if (v) return v; } return globalsIdx.get(name) || null; };
  const fieldOf = (cls, name) => { for (let d = prog.structs.get(cls); d; d = d.base ? prog.structs.get(d.base) : null) { const f = d.fields.find(x => x.name === name); if (f) return f; } return null; };

  // ---------- expressions: return {f, t}
  const num = (v, isInt) => ({ f: () => v, t: isInt ? 'i' : 'd' });
  function enumConst(name) { for (const [en, list] of prog.enums) { const hit = list.find(x => x.k === name); if (hit) return en; } return null; }
  function cx(n) {
    switch (n.k) {
      case 'num': return num(n.v, n.int);
      case 'str': { const v = n.v; return { f: () => v, t: 's' }; }
      case 'bool': { const v = n.v; return { f: () => v, t: 'b' }; }
      case 'name': return cName(n);
      case 'un': { const e = cx(n.e), f = e.f; switch (n.op) { case '!': return { f: x => !f(x), t: 'b' }; case '-': return { f: x => -f(x), t: e.t }; case '+': return e; case '~': return { f: x => ~f(x), t: 'i' }; } break; }
      case 'bin': return cBin(n);
      case 'cond': { const c = cx(n.c).f, a = cx(n.a), b = cx(n.b); return { f: x => (c(x) ? a.f(x) : b.f(x)), t: a.t === 'd' || b.t === 'd' ? 'd' : a.t }; }
      case 'cast': return cCast(n);
      case 'assign': return cAssign(n);
      case 'pre': case 'post': return cIncDec(n);
      case 'call': return cCall(n);
      case 'mcall': return cMCall(n);
      case 'idx': { const a = cx(n.e), i = cx(n.i).f, af = a.f; return { f: x => idxGet(af(x), i(x)), t: a.elem || '?' , elem: undefined }; }
      case 'mem': { const o = cx(n.o), of = o.f, nm = n.name; let t = '?'; if (o.t && o.t.startsWith('o:')) { const fd = fieldOf(o.t.slice(2), nm); if (fd) t = cat(fd.type); else if (o.t === 'o:MqlRates' || o.t === 'o:MqlTick' || o.t === 'o:MqlDateTime') t = nm === 'time' || nm === 'tick_volume' || nm === 'volume' || nm === 'time_msc' || nm === 'year' || nm === 'mon' || nm === 'day' || nm === 'hour' || nm === 'min' || nm === 'sec' || nm === 'day_of_week' || nm === 'day_of_year' || nm === 'spread' || nm === 'real_volume' ? 'i' : 'd'; }
        return { f: x => { const o = of(x); if (o === null || o === undefined) fatal('object used before it was created'); return o[nm]; }, t }; }
      case 'new': { const t = n.type, args = n.args.map(a => cx(a).f); return { f: x => { const o = vm.makeObject(t); const cm = classC.get(t); if (cm && cm.methods.has('__ctor')) callMethod(o, '__ctor', args.map(a => a(x))); else if (lib.classes[t] && o.__init) o.__init(...args.map(a => a(x))); return o; }, t: 'o:' + t }; }
      case 'delete': return { f: () => 0, t: 'v' };
      case 'seq': { const fs = n.list.map(e => cx(e).f); return { f: x => { let r; for (const f of fs) r = f(x); return r; }, t: '?' }; }
      case 'arrinit': return { f: x => mkArr(n.items.map(i => cx(i).f(x))), t: 'a' };
    }
    throw new MqlError('unsupported expression ' + n.k, n.line);
  }
  function cName(n) {
    const nm = n.name, v = lookup(nm);
    if (v) { const s = v.slot, t = cat(v.type), el = v.elem;
      const r = v.ref ? { f: f => f[s].get(), t } : v.local ? { f: f => f[s], t } : { f: () => vm.G[s], t };
      if (v.arr) r.elem = cat(v.type); return r; }
    if (curClass) { const fd = fieldOf(curClass, nm); if (fd) return { f: f => f[1][nm], t: cat(fd.type) }; }
    if (nm === '_Symbol') return { f: () => host.symbol, t: 's' };
    if (nm === '_Point') return { f: () => host.quote().point, t: 'd' };
    if (nm === '_Digits') return { f: () => host.quote().digits, t: 'i' };
    if (nm === '_Period') return { f: () => host.periodCode, t: 'i' };
    if (nm === '_LastError') return { f: () => vm.lastError | 0, t: 'i' };
    if (nm === '_StopFlag') return { f: () => 0, t: 'i' };
    if (nm in CONSTS) { const c = CONSTS[nm]; return { f: () => c, t: Number.isInteger(c) && !/^(DBL_|M_|EMPTY)/.test(nm) ? 'i' : 'd' }; }
    const en = enumConst(nm); if (en) { const val = enumVal(nm); return { f: () => val, t: 'i' }; }
    if (lib.funcs[nm] || funcsC.has(nm) || prog.funcs.has(nm)) throw new MqlError(`"${nm}" is a function name used without ()`, n.line);
    throw new MqlError(`unknown name "${nm}"`, n.line);
  }
  const enumCache = new Map();
  function enumVal(name) { if (enumCache.has(name)) return enumCache.get(name); for (const [, list] of prog.enums) { let cur = 0; for (const it of list) { if (it.e) cur = trunc(cx(it.e).f([])); enumCache.set(it.k, cur); cur++; } } return enumCache.get(name); }
  function cBin(n) {
    const l = cx(n.l), r = cx(n.r), lf = l.f, rf = r.f, op = n.op;
    const dbl = l.t === 'd' || r.t === 'd' || (l.t === '?' || r.t === '?') && op === '/';
    switch (op) {
      case '&&': return { f: x => !!lf(x) && !!rf(x), t: 'b' };
      case '||': return { f: x => !!lf(x) || !!rf(x), t: 'b' };
      case '==': return { f: x => lf(x) == rf(x), t: 'b' }; case '!=': return { f: x => lf(x) != rf(x), t: 'b' };
      case '<': return { f: x => lf(x) < rf(x), t: 'b' }; case '>': return { f: x => lf(x) > rf(x), t: 'b' };
      case '<=': return { f: x => lf(x) <= rf(x), t: 'b' }; case '>=': return { f: x => lf(x) >= rf(x), t: 'b' };
      case '+': if (l.t === 's' || r.t === 's') return { f: x => String(lf(x)) + String(rf(x)), t: 's' }; return { f: x => lf(x) + rf(x), t: dbl ? 'd' : 'i' };
      case '-': return { f: x => lf(x) - rf(x), t: dbl ? 'd' : 'i' };
      case '*': return { f: x => lf(x) * rf(x), t: dbl ? 'd' : 'i' };
      case '/': if (dbl) return { f: x => { const d = rf(x); if (d === 0) fatal('zero divide'); return lf(x) / d; }, t: 'd' }; return { f: x => { const d = rf(x); if (d === 0) fatal('zero divide'); return trunc(lf(x) / d); }, t: 'i' };
      case '%': return { f: x => { const d = rf(x); if (d === 0) fatal('zero divide'); return lf(x) % d; }, t: dbl ? 'd' : 'i' };
      case '&': return { f: x => bit(lf(x), rf(x), 0), t: 'i' }; case '|': return { f: x => bit(lf(x), rf(x), 1), t: 'i' }; case '^': return { f: x => bit(lf(x), rf(x), 2), t: 'i' };
      case '<<': return { f: x => Number(BigInt(trunc(lf(x))) << BigInt(trunc(rf(x)))), t: 'i' }; case '>>': return { f: x => Number(BigInt(trunc(lf(x))) >> BigInt(trunc(rf(x)))), t: 'i' };
    }
    throw new MqlError('unsupported operator ' + op, n.line);
  }
  const bit = (a, b, k) => { a = trunc(a); b = trunc(b); if (Math.abs(a) < 2147483648 && Math.abs(b) < 2147483648) return k === 0 ? a & b : k === 1 ? a | b : a ^ b; const A = BigInt(a), B = BigInt(b); return Number(k === 0 ? A & B : k === 1 ? A | B : A ^ B); };
  function cCast(n) {
    const t = n.type, c = cat(t);
    if (n.ctor && (prog.structs.has(t) || lib.classes[t] || lib.structs[t])) return { f: () => vm.makeObject(t), t: 'o:' + t };
    const e = cx(n.e), f = e.f, co = coerceTo(t);
    return { f: x => co(f(x)), t: c };
  }
  // lvalues
  function lval(n) {
    if (n.k === 'name') {
      const v = lookup(n.name);
      if (v) { const s = v.slot, co = coerceTo(v.type), t = cat(v.type);
        if (v.ref) return { get: f => f[s].get(), set: (f, x) => f[s].set(co(x)), t, ref: f => f[s] };
        if (v.local) return { get: f => f[s], set: (f, x) => { f[s] = co(x); }, t, ref: f => ({ get: () => f[s], set: x => { f[s] = co(x); } }) };
        return { get: () => vm.G[s], set: (f, x) => { vm.G[s] = co(x); }, t, ref: () => ({ get: () => vm.G[s], set: x => { vm.G[s] = co(x); } }) }; }
      if (curClass) { const fd = fieldOf(curClass, n.name); if (fd) { const co = coerceTo(fd.type), nm = n.name; return { get: f => f[1][nm], set: (f, x) => { f[1][nm] = co(x); }, t: cat(fd.type), ref: f => ({ get: () => f[1][nm], set: x => { f[1][nm] = co(x); } }) }; } }
      throw new MqlError(`cannot assign to "${n.name}"`, n.line);
    }
    if (n.k === 'idx') { const a = cx(n.e), af = a.f, i = cx(n.i).f; return { get: f => idxGet(af(f), i(f)), set: (f, x) => idxSet(af(f), i(f), x), t: '?', ref: f => { const arr = af(f), k = i(f); return { get: () => idxGet(arr, k), set: x => idxSet(arr, k, x) }; } }; }
    if (n.k === 'mem') { const o = cx(n.o), of = o.f, nm = n.name; return { get: f => of(f)[nm], set: (f, x) => { of(f)[nm] = x; }, t: '?', ref: f => { const ob = of(f); return { get: () => ob[nm], set: x => { ob[nm] = x; } }; } }; }
    throw new MqlError('this cannot be assigned to', n.line);
  }
  function cAssign(n) {
    const L = lval(n.l), r = cx(n.r), rf = r.f, op = n.op;
    if (op === '=') { const isStruct = r.t && r.t.startsWith('o:') && prog.structs.has(r.t.slice(2)); return { f: f => { let v = rf(f); if (isStruct && v) v = { ...v }; L.set(f, v); return v; }, t: L.t }; }
    const bop = op.slice(0, -1), tmp = { k: 'bin', op: bop, l: n.l, r: n.r, line: n.line };
    const e = cBin(tmp); const ef = e.f; const isI = L.t === 'i';
    if (isI && bop === '/') { return { f: f => { const v = trunc(ef(f)); L.set(f, v); return v; }, t: L.t }; }
    return { f: f => { const v = ef(f); L.set(f, v); return L.get(f); }, t: L.t };
  }
  function cIncDec(n) {
    const L = lval(n.e), d = n.op === '++' ? 1 : -1, pre = n.k === 'pre';
    return { f: f => { const o = L.get(f); L.set(f, o + d); return pre ? L.get(f) : o; }, t: L.t };
  }
  // calls
  function argSpec(n, params) { // compile args; by-ref params get a ref
    return n.args.map((a, i) => { const p = params && params[i]; if (p && p.ref && (a.k === 'name' || a.k === 'idx' || a.k === 'mem')) { const L = lval(a); return { f: f => L.ref(f), ref: true }; } return { f: cx(a).f }; });
  }
  function cCall(n) {
    const nm = n.name;
    const uf = prog.funcs.get(nm);
    if (uf) {
      const specs = argSpec(n, uf.params), ret = cat(uf.ret);
      return { f: f => { const fn = funcsC.get(nm); const args = new Array(specs.length); for (let i = 0; i < specs.length; i++) args[i] = specs[i].f(f); return callUser(fn, args); }, t: ret };
    }
    const lf = lib.funcs[nm];
    if (!lf) { if (curClass) { const m = findMethod(curClass, nm); if (m) return cMCall({ k: 'mcall', o: { k: 'name', name: '__this__' }, name: nm, args: n.args, line: n.line }); } unknownCalls.add(nm); throw new MqlError(`"${nm}" is not supported yet by the Kanairy server`, n.line); }
    const refs = lf.refs || [];
    const specs = n.args.map((a, i) => refs.includes(i) && (a.k === 'name' || a.k === 'idx' || a.k === 'mem') ? { f: lval(a).ref, ref: true } : { f: cx(a).f });
    const fn = lf.fn, k = specs.length;
    if (k === 0) return { f: () => fn(), t: cat(lf.ret) };
    if (k === 1) { const a0 = specs[0].f; return { f: f => fn(a0(f)), t: cat(lf.ret) }; }
    if (k === 2) { const a0 = specs[0].f, a1 = specs[1].f; return { f: f => fn(a0(f), a1(f)), t: cat(lf.ret) }; }
    return { f: f => { const a = new Array(k); for (let i = 0; i < k; i++) a[i] = specs[i].f(f); return fn(...a); }, t: cat(lf.ret) };
  }
  function findMethod(cls, name) { for (let d = prog.structs.get(cls); d; d = d.base ? prog.structs.get(d.base) : null) { const m = d.methods.find(x => x.name === name && x.body); if (m) return { m, owner: d.name }; } return null; }
  function cMCall(n) {
    const nm = n.name;
    const o = n.o.k === 'name' && n.o.name === '__this__' ? { f: f => f[1], t: 'o:' + curClass } : cx(n.o), of = o.f;
    let userParams = null;
    if (o.t && o.t.startsWith('o:')) { const fm = findMethod(o.t.slice(2), nm); if (fm) userParams = fm.m.params; }
    const specs = argSpec(n, userParams);
    let ret = '?'; if (o.t && o.t.startsWith('o:')) { const fm = findMethod(o.t.slice(2), nm); if (fm) ret = cat(fm.m.ret); else if (lib.methodRet[o.t.slice(2) + '.' + nm]) ret = lib.methodRet[o.t.slice(2) + '.' + nm]; }
    return { f: f => { const ob = of(f); if (ob === null || ob === undefined) fatal(`"${nm}" called on an object that was never created`); const args = specs.map(s => s.f(f)); return callMethod(ob, nm, args); }, t: ret };
  }
  function callMethod(ob, name, args) {
    const cls = ob.__t;
    for (let d = prog.structs.get(cls); d; d = d.base ? prog.structs.get(d.base) : null) { const key = d.name + '::' + name; const fn = classC.get(key); if (fn) return callUser(fn, args, ob); }
    if (ob.__m && ob.__m[name]) return ob.__m[name](...args);
    if (name === '__ctor') return undefined;
    throw new MqlError(`method "${name}" is not supported on ${cls || 'this object'}`);
  }
  let depth = 0;
  function callUser(fn, args, self) {
    if (++depth > 200) { depth = 0; fatal('stack overflow'); }
    const f = new Array(fn.nslots); f[0] = undefined; f[1] = self;
    for (let i = 0; i < fn.params.length; i++) { const p = fn.params[i]; f[p.slot] = i < args.length ? (p.ref ? args[i] : p.co(args[i])) : (p.def ? p.def(f) : p.dv()); }
    try { fn.body(f); } finally { depth--; }
    return f[0];
  }
  // ---------- statements: return 0 ok, 1 break, 2 continue, 3 return
  function cs(n) {
    switch (n.k) {
      case 'block': { if (!n.noScope) pushScope(); const body = n.body.map(cs); if (!n.noScope) popScope(); const k = body.length; return f => { for (let i = 0; i < k; i++) { const r = body[i](f); if (r) return r; } return 0; }; }
      case 'expr': { const e = cx(n.e).f; return f => { e(f); return 0; }; }
      case 'decl': return cDecl(n);
      case 'if': { const c = cx(n.c).f, a = cs(n.a), b = n.b ? cs(n.b) : null; return f => (c(f) ? a(f) : b ? b(f) : 0); }
      case 'for': { pushScope(); const init = n.init ? cs(n.init.k === 'expr' ? { k: 'expr', e: n.init.e } : n.init) : null, c = n.c ? cx(n.c).f : null, step = n.step ? cx(n.step).f : null, body = cs(n.body); popScope();
        return f => { if (init) init(f); let guard = 0; while (!c || c(f)) { const r = body(f); if (r === 1) break; if (r === 3) return 3; if (step) step(f); if (++guard > 1e7) fatal('loop does not end'); } return 0; }; }
      case 'while': { const c = cx(n.c).f, body = cs(n.body); return f => { let g = 0; while (c(f)) { const r = body(f); if (r === 1) break; if (r === 3) return 3; if (++g > 1e7) fatal('loop does not end'); } return 0; }; }
      case 'dowhile': { const c = cx(n.c).f, body = cs(n.body); return f => { let g = 0; do { const r = body(f); if (r === 1) break; if (r === 3) return 3; if (++g > 1e7) fatal('loop does not end'); } while (c(f)); return 0; }; }
      case 'switch': { const e = cx(n.e).f; const cases = n.cases.map(c => ({ test: c.test ? cx(c.test).f : null, body: c.body.map(cs) })); return f => { const v = e(f); let start = cases.findIndex(c => c.test && c.test(f) == v); if (start < 0) start = cases.findIndex(c => !c.test); if (start < 0) return 0; for (let i = start; i < cases.length; i++) for (const b of cases[i].body) { const r = b(f); if (r === 1) return 0; if (r) return r; } return 0; }; }
      case 'break': return () => 1; case 'continue': return () => 2;
      case 'return': { if (!n.e) return () => 3; const e = cx(n.e).f, co = coerceTo(curRet); return f => { f[0] = co(e(f)); return 3; }; }
    }
    throw new MqlError('unsupported statement ' + n.k, n.line);
  }
  function cDecl(n) {
    const t = n.type; const isArr = !!n.dims || (n.init && n.init.k === 'arrinit');
    if (n.isStatic && !isGlobalCtx) { // static local: one shared slot
      const g = { slot: vm.G.length, type: t, arr: isArr }; vm.G.push(undefined); scopes[scopes.length - 1].set(n.name, g); const init = initFn(n, isArr); const done = { v: false }; const s = g.slot; return f => { if (!done.v) { done.v = true; vm.G[s] = init(f); } return 0; }; }
    const init = initFn(n, isArr);
    const v = declLocal(n.name, t, { arr: isArr }); const s = v.slot; return f => { f[s] = init(f); return 0; };
  }
  function initFn(n, isArr) {
    const t = n.type, co = coerceTo(t);
    if (isArr) { const size = n.dims && n.dims[0] ? cx(n.dims[0]).f : null; const ini = n.init && n.init.k === 'arrinit' ? n.init.items.map(i => cx(i).f) : null; return f => { const a = mkArr(); if (ini) for (const i of ini) a.push(co(i(f))); else if (size) { const k = trunc(size(f)); for (let i = 0; i < k; i++) a.push(defaultOf(t, vm)); } return a; }; }
    if (n.init) { const e = cx(n.init); const isStruct = e.t && e.t.startsWith('o:') && prog.structs.has(e.t.slice(2)); const ef = e.f; return f => { const v = ef(f); return isStruct && v && n.init.k !== 'new' ? { ...v } : co(v); }; }
    return () => defaultOf(t, vm);
  }
  // ---------- build the program
  let isGlobalCtx = true, curRet = 'void';
  // globals
  for (const g of prog.globals) { globalsIdx.set(g.name, { slot: vm.G.length, type: g.type, arr: !!g.dims || (g.init && g.init.k === 'arrinit'), isInput: g.isInput }); vm.G.push(undefined); }
  // user functions and methods
  function compileFn(def, cls) {
    scopes = []; nslots = 2; curClass = cls || null; curRet = def.ret; pushScope();
    const params = def.params.map(p => { const v = declLocal(p.name || ('_p' + nslots), p.type, { ref: p.ref && !p.arr, arr: p.arr }); return { slot: v.slot, ref: p.ref && !p.arr, co: coerceTo(p.type), dv: () => defaultOf(p.type, vm), def: p.def ? (() => { const e = cx(p.def).f; return f => coerceTo(p.type)(e(f)); })() : null }; });
    const body = def.body ? cs(def.body) : () => 0; popScope();
    return { params, nslots, body };
  }
  for (const [name, def] of prog.funcs) { const fnDef = { ...def }; funcsC.set(name, null); fnDef._name = name; }
  try {
    for (const [name, def] of prog.funcs) { curFnName = name; isGlobalCtx = false; funcsC.set(name, compileFn(def, null)); }
    for (const [cn, sd] of prog.structs) { classC.set(cn, { methods: new Set(sd.methods.map(m => m.name)) }); for (const m of sd.methods) { if (!m.body) continue; curFnName = cn + '::' + m.name; isGlobalCtx = false; classC.set(cn + '::' + m.name, compileFn(m, cn)); } }
  } finally { isGlobalCtx = true; }
  // global initialisers (run at start)
  scopes = []; nslots = 2; curClass = null; pushScope();
  const gInit = prog.globals.map(g => { const idx = globalsIdx.get(g.name); const init = initFn(g, idx.arr); const s = idx.slot; return f => { vm.G[s] = init(f); }; });
  const gFrame = new Array(nslots + 64);
  vm.inputs = prog.inputs.map(d => ({ name: d.name, type: d.type, kind: cat(d.type) === 'b' ? 'bool' : cat(d.type) === 'i' ? 'int' : cat(d.type) === 'd' ? 'num' : cat(d.type) === 's' ? 'str' : 'other', def: null, comment: d.comment || '', node: d, slot: globalsIdx.get(d.name).slot, enumName: prog.enums.has(d.type) || /^ENUM_/.test(d.type) ? d.type : '' }));
  vm.reset = () => { for (const g of gInit) g(gFrame); vm.halted = false; vm.error = ''; for (const i of vm.inputs) { if (i.def === null) i.def = fmt(vm.G[i.slot], i); } vm.handles.length = 0; vm.timer = 0; };
  const fmt = (v, i) => i.kind === 'bool' ? String(!!v) : String(v);
  vm.defaults = () => { vm.reset(); return vm.inputs.map(i => ({ name: i.name, type: i.type, kind: i.kind, def: i.def, comment: i.comment })); };
  // set an input from text (app settings / .set file); returns false if the text is not valid for the type
  vm.setInput = (name, text) => {
    const i = vm.inputs.find(x => x.name === name); if (!i) return false; const s = String(text).trim();
    if (i.kind === 'bool') { if (!/^(true|false|0|1)$/i.test(s)) return false; vm.G[i.slot] = /^(true|1)$/i.test(s); return true; }
    if (i.kind === 'int' || i.kind === 'num') { let v = Number(s); if (!Number.isFinite(v)) { const c = i.enumName && (CONSTS[s] ?? enumConstVal(s)); if (c === undefined || c === null) return false; v = c; } vm.G[i.slot] = i.kind === 'int' ? trunc(v) : v; return true; }
    vm.G[i.slot] = s; return true;
  };
  const enumConstVal = s => { try { return enumVal(s); } catch { return undefined; } };
  const guard = (name, ...args) => {
    if (vm.halted) return undefined; const fn = funcsC.get(name); if (!fn) return undefined;
    try { return callUser(fn, args); } catch (e) { depth = 0; vm.error = e.message || String(e); if (e.fatal || e instanceof MqlError) { vm.halted = true; } else vm.halted = true; vm.log('EA stopped: ' + vm.error); return undefined; }
  };
  vm.has = n => funcsC.has(n);
  vm.init = () => { const r = guard('OnInit'); return r === undefined ? 0 : r; };
  vm.tick = () => guard('OnTick');
  vm.timerTick = () => guard('OnTimer');
  vm.deinit = (reason = 0) => { const was = vm.halted; vm.halted = false; guard('OnDeinit', reason); vm.halted = was; };
  vm.unsupported = [...prog.unsupported];
  return vm;
}
