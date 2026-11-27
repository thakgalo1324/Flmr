// Backtest host for the MQL5 interpreter: replays M1 candles as 4 ticks per bar (open, low/high, close) with a fixed spread.
import { TF_SEC } from './consts.js';
const agg = (bars, sec) => { const t = [], o = [], h = [], l = [], c = [], v = []; let key = -1; for (const b of bars) { const k = Math.floor(b.t / sec); if (k !== key) { key = k; t.push(k * sec); o.push(b.o); h.push(b.h); l.push(b.l); c.push(b.c); v.push(1); } else { const j = t.length - 1; if (b.h > h[j]) h[j] = b.h; if (b.l < l[j]) l[j] = b.l; c[j] = b.c; v[j]++; } } return { t, o, h, l, c, v, n: t.length }; };

export class SimHost {
  constructor(bars, { cost = 0.35, symbol = 'XAUUSD', balance = 10000, tfSec = 60, ticks = 4, contract = 100 } = {}) {
    this.bars = bars; this.symbol = symbol; this.cost = cost; this.periodSec = tfSec; this.periodCode = 1; this.ticks = ticks; this.contract = contract;
    this.balance = balance; this.pos = []; this.closed = []; this.nextTicket = 1; this.bid = bars[0].o; this.now = bars[0].t; this.i = 0; this.S = new Map(); this.ptr = new Map();
    this.base = bars; this.M1 = agg(bars, 60); // base series for M1 (mutated for the forming candle)
    this.S.set(60, this.M1);
  }
  get ask() { return this.bid + this.cost; }
  log() {}
  timeSec() { return this.now; }
  quote() { return { bid: this.bid, ask: this.bid + this.cost, point: 0.01, digits: 2, volMin: 0.01, volMax: 100, volStep: 0.01, stopsLevel: 0, tickValue: 1, contract: this.contract }; }
  series(sec) {
    let s = this.S.get(sec); if (!s) { s = agg(this.bars, sec); this.S.set(sec, s); }
    if (sec === 60) { s.n = this.i + 1; return s; }
    let p = this.ptr.get(sec) || 0; while (p + 1 < s.t.length && s.t[p + 1] <= this.now) p++; this.ptr.set(sec, p); s.n = p + 1; return s;
  }
  account() { let fl = 0; for (const p of this.pos) fl += this.pl(p); return { balance: this.balance, equity: this.balance + fl, margin: 0, freeMargin: this.balance + fl, tradeAllowed: true, hedge: true, leverage: 200, login: 1 }; }
  pl(p) { return (p.type === 0 ? this.bid - p.open : p.open - this.ask) * p.volume * this.contract; }
  positions() { return this.pos.map(p => ({ ticket: p.ticket, type: p.type, volume: p.volume, open: p.open, sl: p.sl, tp: p.tp, profit: this.pl(p), swap: 0, magic: p.magic, comment: p.comment, time: p.time })); }
  send(r) {
    if (r.op === 'buy' || r.op === 'sell') { const type = r.op === 'buy' ? 0 : 1, price = type === 0 ? this.ask : this.bid; const vol = Math.max(0.01, Math.round(r.volume * 100) / 100);
      const p = { ticket: this.nextTicket++, type, volume: vol, open: price, sl: +r.sl || 0, tp: +r.tp || 0, magic: r.magic || 0, comment: r.comment || '', time: this.now }; this.pos.push(p); return { retcode: 10009, ticket: p.ticket, price }; }
    const p = this.pos.find(x => x.ticket === r.ticket); if (!p) return { retcode: 10013 };
    if (r.op === 'modify') { p.sl = r.sl; p.tp = r.tp; return { retcode: 10009 }; }
    if (r.op === 'close') { this.closePos(p, p.type === 0 ? this.bid : this.ask); return { retcode: 10009 }; }
    return { retcode: 10013 };
  }
  closePos(p, price) { const pnl = (p.type === 0 ? price - p.open : p.open - price) * p.volume * this.contract; this.balance += pnl; this.closed.push({ pnl, t: this.now, vol: p.volume, type: p.type, open: p.open, price, time: p.time }); this.pos = this.pos.filter(x => x !== p); }
  checkStops() {
    for (const p of [...this.pos]) {
      if (p.type === 0) { if (p.sl && this.bid <= p.sl) this.closePos(p, Math.min(p.sl, this.bid)); else if (p.tp && this.bid >= p.tp) this.closePos(p, p.tp); }
      else { const a = this.ask; if (p.sl && a >= p.sl) this.closePos(p, Math.max(p.sl, a)); else if (p.tp && a <= p.tp) this.closePos(p, p.tp); }
    }
  }
  run(vm, fromT, toT, onBar) {
    let i0 = this.bars.findIndex(b => b.t >= fromT); let i1 = this.bars.length - 1; while (i1 > 0 && this.bars[i1].t >= toT) i1--;
    if (i0 < 0) return; const M = this.M1;
    this.i = i0; this.bid = this.bars[i0].o; this.now = this.bars[i0].t; M.n = i0 + 1; vm.reset(); vm.init();
    for (let i = i0; i <= i1 && !vm.halted; i++) {
      const b = this.bars[i]; this.i = i; M.n = i + 1;
      const fin = { h: M.h[i], l: M.l[i], c: M.c[i] };
      const path = this.ticks === 1 ? [b.o] : b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
      let hh = b.o, ll = b.o;
      for (let k = 0; k < path.length; k++) {
        this.bid = path[k]; this.now = b.t + Math.round(k * 59 / Math.max(1, path.length - 1)); hh = Math.max(hh, this.bid); ll = Math.min(ll, this.bid);
        M.h[i] = hh; M.l[i] = ll; M.c[i] = this.bid; // the forming candle only shows what has happened so far
        this.checkStops(); vm.tick(); this.checkStops();
      }
      M.h[i] = fin.h; M.l[i] = fin.l; M.c[i] = fin.c;
      if (onBar) onBar(i);
    }
    this.bid = this.bars[i1].c; this.now = this.bars[i1].t + 59; for (const p of [...this.pos]) this.closePos(p, p.type === 0 ? this.bid : this.ask);
  }
}
export const stats = (closed, hrs) => { let w = 0, gp = 0, gl = 0, eq = 0, pk = 0, dd = 0; for (const t of closed) { const x = t.pnl; if (x > 0) { w++; gp += x; } else gl -= x; eq += x; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); } const n = closed.length, l = n - w; return { n, perHour: hrs ? n / hrs : 0, win: n ? w / n * 100 : 0, avgW: w ? gp / w : 0, avgL: l ? gl / l : 0, net: gp - gl, pf: gl ? gp / gl : 99, dd }; };
