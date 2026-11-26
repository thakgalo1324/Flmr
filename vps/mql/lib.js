// Built-in MQL5 functions, classes and indicators for the interpreter.
import { CONSTS, TF_SEC, TF_NAME } from './consts.js';
import { MqlError } from './parse.js';

const trunc = v => { v = +v; return v < 0 ? Math.ceil(v) : Math.floor(v); };
const EMPTY = 2147483647;
const mkArr = (a = []) => { a.s = false; return a; };

// ----- indicator maths (same definitions MetaTrader uses)
const sma = (v, p) => { const o = new Array(v.length).fill(NaN); let s = 0, c = 0; for (let i = 0; i < v.length; i++) { s += v[i]; c++; if (c > p) { s -= v[i - p]; c--; } if (c === p) o[i] = s / p; } return o; };
const ema = (v, p) => { const o = new Array(v.length).fill(NaN), k = 2 / (p + 1); let s = 0; for (let i = 0; i < v.length; i++) { if (i < p - 1) { s += v[i]; continue; } if (i === p - 1) { s += v[i]; o[i] = s / p; continue; } o[i] = v[i] * k + o[i - 1] * (1 - k); } return o; };
const smma = (v, p) => { const o = new Array(v.length).fill(NaN); let s = 0; for (let i = 0; i < v.length; i++) { if (i < p - 1) { s += v[i]; continue; } if (i === p - 1) { s += v[i]; o[i] = s / p; continue; } o[i] = (o[i - 1] * (p - 1) + v[i]) / p; } return o; };
const lwma = (v, p) => { const o = new Array(v.length).fill(NaN), den = p * (p + 1) / 2; for (let i = p - 1; i < v.length; i++) { let s = 0; for (let j = 0; j < p; j++) s += v[i - j] * (p - j); o[i] = s / den; } return o; };
const maOf = (m, v, p) => (m === 1 ? ema(v, p) : m === 2 ? smma(v, p) : m === 3 ? lwma(v, p) : sma(v, p));
const priceOf = (S, ap) => { const n = S.c.length; const o = new Array(n); for (let i = 0; i < n; i++) o[i] = ap === 2 ? S.o[i] : ap === 3 ? S.h[i] : ap === 4 ? S.l[i] : ap === 5 ? (S.h[i] + S.l[i]) / 2 : ap === 6 ? (S.h[i] + S.l[i] + S.c[i]) / 3 : ap === 7 ? (S.h[i] + S.l[i] + 2 * S.c[i]) / 4 : S.c[i]; return o; };
const trOf = S => S.c.map((c, i) => i ? Math.max(S.h[i] - S.l[i], Math.abs(S.h[i] - S.c[i - 1]), Math.abs(S.l[i] - S.c[i - 1])) : S.h[i] - S.l[i]);
const ONE = n => new Array(n).fill(NaN);
const IND = {
  MA: (S, a) => { const [p, shift, m, ap] = a; const v = maOf(m, priceOf(S, ap), p); if (!shift) return [v]; const o = ONE(v.length); for (let i = 0; i < v.length; i++) if (i + shift >= 0 && i + shift < v.length) o[i + shift] = v[i]; return [o]; },
  RSI: (S, a) => { const [p, ap] = a; const c = priceOf(S, ap), g = [0], l = [0]; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); } const ag = smma(g.slice(1), p), al = smma(l.slice(1), p); const o = ONE(c.length); for (let i = 0; i < ag.length; i++) if (!Number.isNaN(ag[i])) o[i + 1] = al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]); return [o]; },
  ATR: (S, a) => [sma(trOf(S).map((x, i) => (i ? x : NaN)).slice(1), a[0]).reduce((acc, x, i, arr) => acc, null) ? [] : (() => { const tr = trOf(S); const o = ONE(tr.length); let s = 0; for (let i = 1; i < tr.length; i++) { s += tr[i]; if (i > a[0]) s -= tr[i - a[0]]; if (i >= a[0]) o[i] = s / a[0]; } return o; })()],
  ADX: (S, a) => { const p = a[0], n = S.c.length, tr = trOf(S), pd = new Array(n).fill(0), md = new Array(n).fill(0); for (let i = 1; i < n; i++) { const up = S.h[i] - S.h[i - 1], dn = S.l[i - 1] - S.l[i]; pd[i] = up > dn && up > 0 ? up : 0; md[i] = dn > up && dn > 0 ? dn : 0; }
    const rma = (v) => { const o = ONE(n); let s = 0; for (let i = 1; i <= p; i++) s += v[i]; o[p] = s / p; for (let i = p + 1; i < n; i++) o[i] = (o[i - 1] * (p - 1) + v[i]) / p; return o; };
    const at = rma(tr), pdi = rma(pd).map((x, i) => 100 * x / at[i]), mdi = rma(md).map((x, i) => 100 * x / at[i]); const dx = pdi.map((x, i) => (Number.isNaN(x) ? NaN : 100 * Math.abs(x - mdi[i]) / ((x + mdi[i]) || 1)));
    const adx = ONE(n); let s = 0, c = 0, started = false; for (let i = 0; i < n; i++) { if (Number.isNaN(dx[i])) continue; if (!started) { s += dx[i]; c++; if (c === p) { adx[i] = s / p; started = true; } } else adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p; } return [adx, pdi, mdi]; },
  BANDS: (S, a) => { const [p, shift, dev, ap] = a; const v = priceOf(S, ap), mid = sma(v, p), up = ONE(v.length), lo = ONE(v.length); for (let i = p - 1; i < v.length; i++) { let q = 0; for (let j = 0; j < p; j++) q += (v[i - j] - mid[i]) ** 2; const sd = Math.sqrt(q / p); up[i] = mid[i] + dev * sd; lo[i] = mid[i] - dev * sd; } return [mid, up, lo]; },
  MACD: (S, a) => { const [f, s, sg, ap] = a; const v = priceOf(S, ap), ef = ema(v, f), es = ema(v, s), m = ef.map((x, i) => x - es[i]); const first = m.findIndex(x => !Number.isNaN(x)); const sig = ONE(v.length); if (first >= 0) { const part = sma(m.slice(first), sg); part.forEach((x, i) => { sig[first + i] = x; }); } return [m, sig]; },
  STOCH: (S, a) => { const [kp, dp, sl, m, pf] = a, n = S.c.length, raw = ONE(n); for (let i = kp - 1; i < n; i++) { let hh = -Infinity, ll = Infinity; for (let j = 0; j < kp; j++) { hh = Math.max(hh, S.h[i - j]); ll = Math.min(ll, S.l[i - j]); } raw[i] = hh === ll ? 50 : 100 * (S.c[i] - ll) / (hh - ll); } const first = raw.findIndex(x => !Number.isNaN(x)); const k = ONE(n); if (first >= 0) sma(raw.slice(first), sl).forEach((x, i) => { k[first + i] = x; }); const f2 = k.findIndex(x => !Number.isNaN(x)); const d = ONE(n); if (f2 >= 0) maOf(m, k.slice(f2), dp).forEach((x, i) => { d[f2 + i] = x; }); return [k, d]; },
  CCI: (S, a) => { const [p, ap] = a, v = priceOf(S, ap), m = sma(v, p), o = ONE(v.length); for (let i = p - 1; i < v.length; i++) { let d = 0; for (let j = 0; j < p; j++) d += Math.abs(v[i - j] - m[i]); d /= p; o[i] = d === 0 ? 0 : (v[i] - m[i]) / (0.015 * d); } return [o]; },
  MOM: (S, a) => { const [p, ap] = a, v = priceOf(S, ap), o = ONE(v.length); for (let i = p; i < v.length; i++) o[i] = v[i] / v[i - p] * 100; return [o]; },
  STDDEV: (S, a) => { const [p, shift, m, ap] = a, v = priceOf(S, ap), mm = maOf(m, v, p), o = ONE(v.length); for (let i = p - 1; i < v.length; i++) { let q = 0; for (let j = 0; j < p; j++) q += (v[i - j] - mm[i]) ** 2; o[i] = Math.sqrt(q / p); } return [o]; },
  WPR: (S, a) => { const p = a[0], n = S.c.length, o = ONE(n); for (let i = p - 1; i < n; i++) { let hh = -Infinity, ll = Infinity; for (let j = 0; j < p; j++) { hh = Math.max(hh, S.h[i - j]); ll = Math.min(ll, S.l[i - j]); } o[i] = hh === ll ? -50 : -100 * (hh - S.c[i]) / (hh - ll); } return [o]; },
};
// iATR is a simple average of the true range in MetaTrader (not Wilder smoothing)
IND.ATR = (S, a) => { const tr = trOf(S), p = a[0], o = ONE(tr.length); let s = 0; for (let i = 1; i < tr.length; i++) { s += tr[i]; if (i > p) s -= tr[i - p]; if (i >= p) o[i] = s / p; } return [o]; };

const fmtNum = (v, d) => (Number.isFinite(+v) ? (+v).toFixed(d) : String(v));
function stringFormat(f, args) {
  let k = 0;
  return String(f).replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?(I64|l|h)?([diufFeEgGsxXc%])/g, (m, flags, w, pr, len, ch) => {
    if (ch === '%') return '%'; let v = args[k++]; let s;
    if (ch === 'd' || ch === 'i' || ch === 'u') s = String(trunc(v)); else if (ch === 'f' || ch === 'F') s = fmtNum(v, pr === undefined ? 6 : +pr); else if (ch === 'e' || ch === 'E') s = (+v).toExponential(pr === undefined ? 6 : +pr); else if (ch === 'g' || ch === 'G') s = String(+(+v).toPrecision(pr === undefined ? 6 : Math.max(1, +pr)));
    else if (ch === 'x') s = trunc(v).toString(16); else if (ch === 'X') s = trunc(v).toString(16).toUpperCase(); else if (ch === 'c') s = String.fromCharCode(trunc(v)); else s = String(v);
    if (w) { const W = +w; s = flags.includes('-') ? s.padEnd(W) : (flags.includes('0') && ch !== 's' ? s.padStart(W, '0') : s.padStart(W)); }
    return s;
  });
}
const pad = n => String(n).padStart(2, '0');
const dtParts = t => { const d = new Date(t * 1000); return { year: d.getUTCFullYear(), mon: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), min: d.getUTCMinutes(), sec: d.getUTCSeconds(), day_of_week: d.getUTCDay(), day_of_year: Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) }; };
const timeToString = (t, mode = 3) => { const p = dtParts(t); const d = `${p.year}.${pad(p.mon)}.${pad(p.day)}`, s = `${pad(p.hour)}:${pad(p.min)}`; return mode & 4 ? `${d} ${s}:${pad(p.sec)}` : mode === 2 ? s : mode === 1 ? d : `${d} ${s}`; };

export function makeLib(vm) {
  const host = () => vm.host;
  const warnSym = sym => { if (sym && sym !== '' && sym !== host().symbol && !vm._symWarned) { vm._symWarned = true; vm.warnings.push(`This EA reads another symbol (${sym}). The server only has ${host().symbol}, so it will use that.`); } };
  const tfSec = tf => { tf = trunc(tf); if (tf === 0) return host().periodSec; return TF_SEC[tf] || 60; };
  const S = (sym, tf) => { warnSym(sym); return host().series(tfSec(tf)); };
  const shiftIdx = (s, shift) => s.n - 1 - trunc(shift);
  // ---- indicator handles
  const cache = new WeakMap();
  const handle = (kind, sym, tf, args) => { warnSym(sym); vm.handles.push({ kind, tf: trunc(tf), args }); return vm.handles.length - 1; };
  const bufOf = (h, b) => { const H = vm.handles[h]; if (!H) return null; const s = host().series(tfSec(H.tf)); let m = cache.get(s); if (!m) { m = new Map(); cache.set(s, m); } const key = h; let res = m.get(key); if (!res) { res = IND[H.kind](s, H.args); m.set(key, res); } return { arr: res[b], s }; };
  const num = (v, d) => (v === undefined ? d : v);
  const F = {};
  const def = (name, ret, fn, refs) => { F[name] = { fn, ret, refs }; };
  // math
  def('MathAbs', 'd', Math.abs); def('MathMax', 'd', Math.max); def('MathMin', 'd', Math.min); def('MathFloor', 'd', Math.floor); def('MathCeil', 'd', Math.ceil); def('MathRound', 'd', v => (v < 0 ? -Math.round(-v) : Math.round(v)));
  def('MathSqrt', 'd', v => (v < 0 ? NaN : Math.sqrt(v))); def('MathPow', 'd', Math.pow); def('MathLog', 'd', Math.log); def('MathLog10', 'd', Math.log10); def('MathExp', 'd', Math.exp); def('MathSin', 'd', Math.sin); def('MathCos', 'd', Math.cos); def('MathTan', 'd', Math.tan); def('MathArctan', 'd', Math.atan); def('MathMod', 'd', (a, b) => a % b);
  def('MathIsValidNumber', 'b', v => Number.isFinite(+v)); def('MathRand', 'i', () => Math.floor(Math.random() * 32768)); def('MathSrand', 'v', () => 0);
  def('NormalizeDouble', 'd', (v, d) => { const f = 10 ** trunc(d); return Math.round((+v + (v >= 0 ? 1e-12 : -1e-12)) * f) / f; });
  for (const n of ['fabs', 'floor', 'ceil', 'sqrt', 'pow', 'MathAbs']) { /* C names are not MQL5 */ }
  // strings
  def('StringLen', 'i', s => String(s).length); def('StringSubstr', 's', (s, a, l) => (l === undefined || l < 0 ? String(s).slice(a) : String(s).substr(a, l)));
  def('StringFind', 'i', (s, f, st = 0) => String(s).indexOf(f, st)); def('StringToDouble', 'd', s => parseFloat(s) || 0); def('StringToInteger', 'i', s => trunc(parseFloat(s) || 0));
  def('StringFormat', 's', (f, ...a) => stringFormat(f, a)); def('DoubleToString', 's', (v, d = 8) => fmtNum(v, trunc(d))); def('IntegerToString', 's', (v, w = 0, c = 32) => { const s = String(trunc(v)); return w > 0 ? s.padStart(w, String.fromCharCode(c)) : s; });
  def('TimeToString', 's', (t, m) => timeToString(t, m)); def('StringToTime', 'i', s => { const m = /(\d{4})[.\-](\d{2})[.\-](\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s)); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000 : 0; });
  def('StringToUpper', 'b', (r) => { r.set(String(r.get()).toUpperCase()); return true; }, [0]); def('StringToLower', 'b', (r) => { r.set(String(r.get()).toLowerCase()); return true; }, [0]);
  def('StringReplace', 'i', (r, a, b) => { const s = String(r.get()); const k = s.split(a).length - 1; r.set(s.split(a).join(b)); return k; }, [0]);
  def('StringAdd', 'b', (r, a) => { r.set(String(r.get()) + a); return true; }, [0]); def('StringTrimLeft', 'i', r => { r.set(String(r.get()).trimStart()); return 0; }, [0]); def('StringTrimRight', 'i', r => { r.set(String(r.get()).trimEnd()); return 0; }, [0]);
  def('StringCompare', 'i', (a, b) => (a < b ? -1 : a > b ? 1 : 0)); def('CharToString', 's', c => String.fromCharCode(c)); def('StringGetCharacter', 'i', (s, i) => String(s).charCodeAt(i) || 0); def('StringConcatenate', 's', (r, ...a) => { r.set(a.join('')); return a.join('').length; }, [0]);
  def('StringSplit', 'i', (s, sep, arr) => { const parts = String(s).split(String.fromCharCode(sep)); arr.length = 0; arr.push(...parts); return parts.length; });
  def('EnumToString', 's', v => TF_NAME[trunc(v)] || String(v));
  def('Print', 'v', (...a) => vm.log(a.join(' '))); def('PrintFormat', 'v', (f, ...a) => vm.log(stringFormat(f, a))); def('Alert', 'v', (...a) => vm.log('ALERT ' + a.join(' '))); def('Comment', 'v', () => 0); def('Sleep', 'v', () => 0);
  def('GetTickCount', 'i', () => Date.now() & 0x7fffffff); def('GetTickCount64', 'i', () => Date.now()); def('GetLastError', 'i', () => vm.lastError | 0); def('ResetLastError', 'v', () => { vm.lastError = 0; }); def('MQLInfoString', 's', () => 'Kanairy'); def('MQLInfoInteger', 'i', id => ({ 3: 1, 8: 0, 9: 0, 10: 0, 5: 0, 6: 0, 4: 0, 2: 1 }[trunc(id)] ?? 0));
  // time
  def('TimeCurrent', 'i', () => host().timeSec()); def('TimeTradeServer', 'i', () => host().timeSec()); def('TimeLocal', 'i', () => host().timeSec()); def('TimeGMT', 'i', () => host().timeSec() - (host().gmtOffset || 0));
  def('TimeToStruct', 'b', (t, st) => { Object.assign(st, dtParts(t)); return true; }); def('StructToTime', 'i', st => Date.UTC(st.year, st.mon - 1, st.day, st.hour || 0, st.min || 0, st.sec || 0) / 1000);
  def('TimeDayOfWeek', 'i', t => dtParts(t).day_of_week); def('TimeHour', 'i', t => dtParts(t).hour); def('TimeMinute', 'i', t => dtParts(t).min);
  def('Period', 'i', () => host().periodCode); def('Symbol', 's', () => host().symbol); def('Point', 'd', () => host().quote().point); def('Digits', 'i', () => host().quote().digits); def('PeriodSeconds', 'i', tf => tfSec(tf));
  def('ChartID', 'i', () => 1); def('ChartPeriod', 'i', () => host().periodCode); def('ChartSymbol', 's', () => host().symbol);
  // price series
  const at = (k) => (sym, tf, sh) => { const s = S(sym, tf), i = shiftIdx(s, sh); return i >= 0 && i < s.n ? s[k][i] : 0; };
  def('iOpen', 'd', at('o')); def('iHigh', 'd', at('h')); def('iLow', 'd', at('l')); def('iClose', 'd', at('c')); def('iVolume', 'i', at('v'));
  def('iTime', 'i', (sym, tf, sh) => { const s = S(sym, tf), i = shiftIdx(s, sh); return i >= 0 && i < s.n ? s.t[i] : 0; });
  def('iBars', 'i', (sym, tf) => S(sym, tf).n); def('Bars', 'i', (sym, tf) => S(sym, tf).n);
  def('iBarShift', 'i', (sym, tf, t) => { const s = S(sym, tf); for (let i = s.n - 1; i >= 0; i--) if (s.t[i] <= t) return s.n - 1 - i; return -1; });
  const hl = (isHigh) => (sym, tf, mode, count, start = 0) => { const s = S(sym, tf), key = [, 'o', 'l', 'h', 'c', 'v'][1] ; const arr = mode === 0 ? s.o : mode === 1 ? s.l : mode === 2 ? s.h : mode === 3 ? s.c : s.v; if (count <= 0) count = s.n; let best = -1, bv = isHigh ? -Infinity : Infinity; for (let k = 0; k < count; k++) { const i = s.n - 1 - (start + k); if (i < 0) break; if (isHigh ? arr[i] > bv : arr[i] < bv) { bv = arr[i]; best = start + k; } } return best; };
  def('iHighest', 'i', hl(true)); def('iLowest', 'i', hl(false));
  // copy functions: dest gets count values from `start` shift; series dest -> dest[0] is newest
  const copySeries = (get) => (sym, tf, start, count, arr) => { const s = S(sym, tf); const out = []; for (let k = 0; k < count; k++) { const i = s.n - 1 - (start + k); if (i < 0) break; out.push(get(s, i)); } out.reverse(); arr.length = 0; arr.push(...out); return out.length; };
  def('CopyRates', 'i', (sym, tf, start, count, arr) => { if (arr.__t === undefined && !Array.isArray(arr)) return -1; const s = S(sym, tf); const out = []; for (let k = 0; k < count; k++) { const i = s.n - 1 - (start + k); if (i < 0) break; out.push({ __t: 'MqlRates', time: s.t[i], open: s.o[i], high: s.h[i], low: s.l[i], close: s.c[i], tick_volume: s.v[i], spread: 0, real_volume: 0 }); } out.reverse(); arr.length = 0; arr.push(...out); return out.length; });
  def('CopyTime', 'i', copySeries((s, i) => s.t[i])); def('CopyOpen', 'i', copySeries((s, i) => s.o[i])); def('CopyHigh', 'i', copySeries((s, i) => s.h[i])); def('CopyLow', 'i', copySeries((s, i) => s.l[i])); def('CopyClose', 'i', copySeries((s, i) => s.c[i])); def('CopyTickVolume', 'i', copySeries((s, i) => s.v[i]));
  // arrays
  def('ArraySetAsSeries', 'b', (a, f) => { a.s = !!f; return true; }); def('ArrayIsSeries', 'b', a => !!a.s); def('ArraySize', 'i', a => a.length);
  def('ArrayResize', 'i', (a, n) => { n = trunc(n); const was = a.length; a.length = n; for (let i = was; i < n; i++) a[i] = a.__d ?? 0; return n; });
  def('ArrayInitialize', 'i', (a, v) => { a.fill(v); return a.length; }); def('ArrayFill', 'v', (a, st, n, v) => { for (let i = st; i < st + n && i < a.length; i++) a[i] = v; }); def('ArrayFree', 'v', a => { a.length = 0; });
  def('ArrayCopy', 'i', (d, s, di = 0, si = 0, n = -1) => { const cnt = n < 0 ? s.length - si : n; for (let i = 0; i < cnt; i++) d[di + i] = s[si + i]; return cnt; });
  def('ArrayMaximum', 'i', (a, st = 0, n = -1) => { let b = -1, v = -Infinity; const e = n < 0 ? a.length : st + n; for (let i = st; i < e && i < a.length; i++) if (a[i] > v) { v = a[i]; b = i; } return b; }); def('ArrayMinimum', 'i', (a, st = 0, n = -1) => { let b = -1, v = Infinity; const e = n < 0 ? a.length : st + n; for (let i = st; i < e && i < a.length; i++) if (a[i] < v) { v = a[i]; b = i; } return b; });
  def('ArraySort', 'b', a => { a.sort((x, y) => x - y); return true; });
  // symbol / account / terminal
  const quote = () => host().quote();
  def('SymbolSelect', 'b', () => true); def('SymbolName', 's', () => host().symbol); def('SymbolsTotal', 'i', () => 1);
  def('SymbolInfoDouble', 'd', (sym, id) => { warnSym(sym); const q = quote(); switch (trunc(id)) { case 1: return q.bid; case 2: return q.ask; case 3: return q.bid; case 16: return q.point; case 17: return q.tickValue; case 18: return q.tickSize ?? q.point; case 19: return q.contract; case 20: return q.volMin; case 21: return q.volMax; case 22: return q.volStep; default: return 0; } });
  def('SymbolInfoInteger', 'i', (sym, id) => { const q = quote(); switch (trunc(id)) { case 100: return Math.round((q.ask - q.bid) / q.point); case 101: return q.digits; case 102: return q.stopsLevel; case 103: return q.freezeLevel || 0; case 104: return 4; case 106: case 107: return 1; case 108: return host().timeSec(); case 109: return 7; default: return 0; } });
  def('SymbolInfoString', 's', (sym, id) => (trunc(id) === 200 ? 'XAU' : trunc(id) === 201 ? 'USD' : host().symbol));
  def('SymbolInfoTick', 'b', (sym, t) => { const q = quote(); Object.assign(t, { time: host().timeSec(), bid: q.bid, ask: q.ask, last: q.bid, volume: 0, time_msc: host().timeSec() * 1000 }); return true; });
  def('AccountInfoDouble', 'd', id => { const a = host().account(); switch (trunc(id)) { case 37: return a.balance; case 38: return a.equity; case 39: return a.equity - a.balance; case 40: return a.margin || 0; case 41: return a.freeMargin ?? a.equity; case 42: return a.margin ? a.equity / a.margin * 100 : 0; default: return 0; } });
  def('AccountInfoInteger', 'i', id => { const a = host().account(); switch (trunc(id)) { case 35: return a.leverage || 100; case 32: return 0; case 33: case 34: return a.tradeAllowed === false ? 0 : 1; case 36: return a.hedge === false ? 0 : 2; case 0: return a.login || 0; default: return 0; } });
  def('AccountInfoString', 's', () => 'USD');
  def('TerminalInfoInteger', 'i', id => ({ 3: host().account().tradeAllowed === false ? 0 : 1, 4: 1, 10: 0, 11: 0 }[trunc(id)] ?? 0)); def('TerminalInfoDouble', 'd', () => 0); def('TerminalInfoString', 's', () => '');
  // indicators
  def('iMA', 'i', (sym, tf, p, sh, m, ap) => handle('MA', sym, tf, [trunc(p), trunc(sh), trunc(m), trunc(ap)]));
  def('iRSI', 'i', (sym, tf, p, ap) => handle('RSI', sym, tf, [trunc(p), trunc(ap)]));
  def('iATR', 'i', (sym, tf, p) => handle('ATR', sym, tf, [trunc(p)]));
  def('iADX', 'i', (sym, tf, p) => handle('ADX', sym, tf, [trunc(p)]));
  def('iBands', 'i', (sym, tf, p, sh, dev, ap) => handle('BANDS', sym, tf, [trunc(p), trunc(sh), +dev, trunc(ap)]));
  def('iMACD', 'i', (sym, tf, f, s, sg, ap) => handle('MACD', sym, tf, [trunc(f), trunc(s), trunc(sg), trunc(ap)]));
  def('iStochastic', 'i', (sym, tf, k, d, sl, m, pf) => handle('STOCH', sym, tf, [trunc(k), trunc(d), trunc(sl), trunc(m), trunc(pf)]));
  def('iCCI', 'i', (sym, tf, p, ap) => handle('CCI', sym, tf, [trunc(p), trunc(ap)])); def('iMomentum', 'i', (sym, tf, p, ap) => handle('MOM', sym, tf, [trunc(p), trunc(ap)]));
  def('iStdDev', 'i', (sym, tf, p, sh, m, ap) => handle('STDDEV', sym, tf, [trunc(p), trunc(sh), trunc(m), trunc(ap)])); def('iWPR', 'i', (sym, tf, p) => handle('WPR', sym, tf, [trunc(p)]));
  def('IndicatorRelease', 'b', () => true);
  def('BarsCalculated', 'i', h => { const b = bufOf(h, 0); return b ? b.s.n : -1; });
  def('CopyBuffer', 'i', (h, b, start, count, arr) => { const r = bufOf(h, b); if (!r || !r.arr) return -1; const out = []; for (let k = 0; k < count; k++) { const i = r.s.n - 1 - (start + k); if (i < 0) break; const v = r.arr[i]; if (Number.isNaN(v)) { out.length = 0; break; } out.push(v); } if (out.length < count) { return -1; } out.reverse(); arr.length = 0; arr.push(...out); return out.length; });
  // positions (only this EA's own positions are visible)
  let selPos = null;
  const poss = () => host().positions();
  def('PositionsTotal', 'i', () => poss().length);
  def('PositionGetTicket', 'i', i => { const p = poss()[trunc(i)]; selPos = p || null; return p ? p.ticket : 0; });
  def('PositionSelect', 'b', () => { const p = poss()[0]; selPos = p || null; return !!p; }); def('PositionSelectByTicket', 'b', t => { const p = poss().find(x => x.ticket === trunc(t)); selPos = p || null; return !!p; });
  const pg = id => { const p = selPos; if (!p) return 0; switch (trunc(id)) { case 1: return p.ticket; case 2: return p.time; case 4: return p.type; case 5: return p.magic; case 6: return p.ticket; case 10: return p.volume; case 11: return p.open; case 12: return p.sl; case 13: return p.tp; case 14: return p.type === 0 ? quote().bid : quote().ask; case 15: return p.swap || 0; case 16: return p.profit; case 17: return host().symbol; case 18: return p.comment || ''; default: return 0; } };
  def('PositionGetInteger', 'i', pg); def('PositionGetDouble', 'd', pg); def('PositionGetString', 's', pg);
  def('OrdersTotal', 'i', () => 0); def('OrderSelect', 'b', () => false); def('HistorySelect', 'b', () => false); def('HistoryDealsTotal', 'i', () => 0); def('HistoryOrdersTotal', 'i', () => 0); def('HistorySelectByPosition', 'b', () => false);
  def('OrderSend', 'b', (rq, res) => { const r = trade(rq); Object.assign(res, { retcode: r.retcode, deal: r.ticket || 0, order: r.ticket || 0, volume: rq.volume, price: r.price || 0, comment: r.comment || '' }); return r.retcode === 10009; });
  def('OrderCalcMargin', 'b', () => true); def('OrderCheck', 'b', () => true);
  def('GlobalVariableCheck', 'b', n => vm.gv?.has(n) || false); def('GlobalVariableSet', 'i', (n, v) => { (vm.gv ||= new Map()).set(n, v); return 1; }); def('GlobalVariableGet', 'd', n => vm.gv?.get(n) || 0); def('GlobalVariableDel', 'b', n => vm.gv?.delete(n) || false);
  def('EventSetTimer', 'b', s => { vm.timer = s; return true; }); def('EventSetMillisecondTimer', 'b', ms => { vm.timer = ms / 1000; return true; }); def('EventKillTimer', 'v', () => { vm.timer = 0; }); def('ExpertRemove', 'v', () => { vm.halted = true; });
  for (const n of ['ObjectCreate', 'ObjectSetInteger', 'ObjectSetDouble', 'ObjectSetString', 'ObjectDelete', 'ObjectFind', 'ObjectMove', 'ObjectsDeleteAll', 'ChartRedraw', 'ChartSetInteger', 'ChartGetInteger', 'ChartSetDouble', 'ObjectGetInteger', 'ObjectGetDouble', 'SetIndexBuffer', 'IndicatorSetInteger', 'PlaySound', 'SendNotification', 'SendMail', 'ChartIndicatorAdd', 'TesterStatistics', 'MarketBookAdd', 'FileOpen', 'FileClose']) def(n, 'i', () => 0);
  // ---- trading, shared by CTrade and OrderSend
  const trade = (rq) => {
    const q = quote(); const action = trunc(rq.action), vol = +rq.volume;
    if (action === 6 || action === 7) { const p = poss().find(x => x.ticket === trunc(rq.position)); if (!p) return { retcode: 10013 }; return host().send({ op: 'modify', ticket: p.ticket, sl: +rq.sl || 0, tp: +rq.tp || 0 }); }
    if (action === 1) {
      if (rq.position) { const p = poss().find(x => x.ticket === trunc(rq.position)); if (!p) return { retcode: 10013 }; return host().send({ op: 'close', ticket: p.ticket, volume: vol }); }
      const buy = trunc(rq.type) === 0; return host().send({ op: buy ? 'buy' : 'sell', volume: vol, sl: +rq.sl || 0, tp: +rq.tp || 0, comment: rq.comment || '', magic: rq.magic });
    }
    return { retcode: 10013, comment: 'pending orders are not supported on the server yet' };
  };
  const RC = { 10004: 'Requote', 10006: 'Request rejected', 10009: 'Request completed', 10013: 'Invalid request', 10014: 'Invalid volume', 10016: 'Invalid stops', 10017: 'Trade disabled', 10018: 'Market closed', 10019: 'Not enough money', 10025: 'No changes' };
  const mkTrade = () => { const o = { __t: 'CTrade', _magic: 0, _rc: 0, _rcd: '' };
    const run = rq => { const r = trade(rq); o._rc = r.retcode; o._rcd = r.comment || RC[r.retcode] || ''; o._price = r.price || 0; o._deal = r.ticket || 0; return r.retcode === 10009 || r.retcode === 10008; };
    o.__m = {
      SetExpertMagicNumber: m => { o._magic = m; }, SetDeviationInPoints: () => 0, SetTypeFilling: () => 0, SetTypeFillingBySymbol: () => true, SetAsyncMode: () => 0, SetMarginMode: () => 0, SetLogLevel: () => 0,
      Buy: (v, sym, px, sl, tp, c) => run({ action: 1, type: 0, volume: v, sl, tp, comment: c || '', magic: o._magic }), Sell: (v, sym, px, sl, tp, c) => run({ action: 1, type: 1, volume: v, sl, tp, comment: c || '', magic: o._magic }),
      PositionClose: t => run({ action: 1, position: t }), PositionModify: (t, sl, tp) => run({ action: 7, position: t, sl, tp }),
      PositionClosePartial: (t, v) => run({ action: 1, position: t, volume: v }),
      ResultRetcode: () => o._rc, ResultRetcodeDescription: () => o._rcd, ResultOrder: () => o._deal, ResultDeal: () => o._deal, ResultPrice: () => o._price, ResultVolume: () => 0, ResultComment: () => o._rcd, RequestMagic: () => o._magic, CheckResultRetcode: () => o._rc,
      BuyLimit: () => false, SellLimit: () => false, BuyStop: () => false, SellStop: () => false, OrderDelete: () => false,
    }; return o; };
  const mkPos = () => { const o = { __t: 'CPositionInfo' }; const m = {
    SelectByIndex: i => { const p = poss()[trunc(i)]; o.p = p || null; return !!p; }, Select: () => { const p = poss()[0]; o.p = p || null; return !!p; }, SelectByTicket: t => { const p = poss().find(x => x.ticket === trunc(t)); o.p = p || null; return !!p; },
    Ticket: () => o.p?.ticket || 0, Symbol: () => host().symbol, Magic: () => o.p?.magic || 0, PositionType: () => o.p?.type ?? 0, Volume: () => o.p?.volume || 0, PriceOpen: () => o.p?.open || 0, StopLoss: () => o.p?.sl || 0, TakeProfit: () => o.p?.tp || 0, Profit: () => o.p?.profit || 0, Swap: () => o.p?.swap || 0, Comment: () => o.p?.comment || '', Time: () => o.p?.time || 0, PriceCurrent: () => (o.p?.type === 0 ? quote().bid : quote().ask) };
    o.__m = m; return o; };
  const mkSym = () => { const o = { __t: 'CSymbolInfo' }; o.__m = { Name: n => (n === undefined ? host().symbol : true), Refresh: () => true, RefreshRates: () => true, Select: () => true, Ask: () => quote().ask, Bid: () => quote().bid, Point: () => quote().point, Digits: () => quote().digits, Spread: () => Math.round((quote().ask - quote().bid) / quote().point), StopsLevel: () => quote().stopsLevel, LotsMin: () => quote().volMin, LotsMax: () => quote().volMax, LotsStep: () => quote().volStep, TickValue: () => quote().tickValue, TickSize: () => quote().tickSize ?? quote().point, ContractSize: () => quote().contract, NormalizePrice: v => Math.round(v / quote().point) * quote().point, Time: () => host().timeSec() }; return o; };
  const mkAcc = () => { const o = { __t: 'CAccountInfo' }; o.__m = { Balance: () => host().account().balance, Equity: () => host().account().equity, Profit: () => host().account().equity - host().account().balance, FreeMargin: () => host().account().freeMargin ?? host().account().equity, Margin: () => host().account().margin || 0, Leverage: () => host().account().leverage || 100, Login: () => host().account().login || 0, TradeAllowed: () => true }; return o; };
  const classes = { CTrade: mkTrade, CPositionInfo: mkPos, CSymbolInfo: mkSym, CAccountInfo: mkAcc };
  const structs = {
    MqlRates: () => ({ __t: 'MqlRates', time: 0, open: 0, high: 0, low: 0, close: 0, tick_volume: 0, spread: 0, real_volume: 0 }), MqlTick: () => ({ __t: 'MqlTick', time: 0, bid: 0, ask: 0, last: 0, volume: 0, time_msc: 0 }), MqlDateTime: () => ({ __t: 'MqlDateTime', year: 0, mon: 0, day: 0, hour: 0, min: 0, sec: 0, day_of_week: 0, day_of_year: 0 }),
    MqlTradeRequest: () => ({ __t: 'MqlTradeRequest', action: 0, magic: 0, order: 0, symbol: '', volume: 0, price: 0, stoplimit: 0, sl: 0, tp: 0, deviation: 0, type: 0, type_filling: 0, type_time: 0, expiration: 0, comment: '', position: 0, position_by: 0 }),
    MqlTradeResult: () => ({ __t: 'MqlTradeResult', retcode: 0, deal: 0, order: 0, volume: 0, price: 0, bid: 0, ask: 0, comment: '', request_id: 0 }), MqlTradeCheckResult: () => ({ __t: 'MqlTradeCheckResult', retcode: 0 }),
  };
  const methodRet = { 'CTrade.Buy': 'b', 'CTrade.Sell': 'b', 'CTrade.PositionClose': 'b', 'CTrade.PositionModify': 'b', 'CTrade.ResultRetcode': 'i', 'CTrade.ResultRetcodeDescription': 's', 'CTrade.ResultPrice': 'd', 'CTrade.ResultOrder': 'i', 'CTrade.ResultDeal': 'i', 'CPositionInfo.Ticket': 'i', 'CPositionInfo.Volume': 'd', 'CPositionInfo.PriceOpen': 'd', 'CPositionInfo.StopLoss': 'd', 'CPositionInfo.TakeProfit': 'd', 'CPositionInfo.Profit': 'd', 'CPositionInfo.PositionType': 'i', 'CPositionInfo.Magic': 'i', 'CSymbolInfo.Ask': 'd', 'CSymbolInfo.Bid': 'd', 'CSymbolInfo.Point': 'd', 'CSymbolInfo.Digits': 'i', 'CSymbolInfo.Spread': 'i', 'CAccountInfo.Balance': 'd', 'CAccountInfo.Equity': 'd' };
  return { funcs: F, classes, structs, methodRet };
}
