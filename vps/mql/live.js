// Live host: lets the MQL5 interpreter trade through the KanairyEA bridge in MT5.
// The bridge sends prices, candles and open trades; whatever the bot decides goes back as commands.
import { createVM } from './interp.js';

export class LiveHost {
  constructor() {
    this.symbol = 'XAUUSD'; this.periodSec = 60; this.periodCode = 1;
    this.bid = 0; this.ask = 0; this.bal = 0; this.eq = 0; this.at = true; this.hedge = true;
    this.base = { t: [], o: [], h: [], l: [], c: [], v: [], n: 0 };
    this.cache = new Map(); this.cmds = []; this.pos = []; this.virt = []; this.seen = new Set();
    this.srvOff = 0; this.nextVirt = -1; this.forming = null; this.lastLog = [];
  }
  timeSec() { return Math.floor(Date.now() / 1000) + this.srvOff; }
  log(m) { this.lastLog.push(String(m)); if (this.lastLog.length > 60) this.lastLog.shift(); }
  quote() { return { bid: this.bid, ask: this.ask, point: 0.01, digits: 2, volMin: 0.01, volMax: 100, volStep: 0.01, stopsLevel: 0, tickValue: 1, contract: 100 }; }
  account() { return { balance: this.bal, equity: this.eq, margin: 0, freeMargin: this.eq, tradeAllowed: this.at, hedge: this.hedge, leverage: 100 }; }
  // sync fields from the bridge
  ingest(r, tfSec) {
    this.symbol = String(r.sym || this.symbol); this.bid = +r.bid || this.bid; this.ask = +r.ask || this.ask;
    this.bal = +r.bal || 0; this.eq = +r.eq || 0; this.at = r.at !== false; this.hedge = r.hedge !== false;
    if (tfSec && tfSec !== this.periodSec) { this.periodSec = tfSec; this.base = { t: [], o: [], h: [], l: [], c: [], v: [], n: 0 }; this.cache.clear(); this.forming = null; }
    if (r.st) this.srvOff = +r.st - Math.floor(Date.now() / 1000);
    // trades: [ticket,type,lots,open,sl,tp,profit]
    const list = Array.isArray(r.pos) ? r.pos : [];
    const real = list.map(p => ({ ticket: +p[0], type: +p[1], volume: +p[2], open: +p[3], sl: +p[4] || 0, tp: +p[5] || 0, profit: +p[6] || 0, swap: 0, magic: 0, comment: '', time: this.timeSec() }));
    const fresh = real.some(p => !this.seen.has(p.ticket));
    for (const p of real) this.seen.add(p.ticket);
    if (this.seen.size > 500) this.seen = new Set(real.map(p => p.ticket));
    const now = Date.now();
    this.virt = fresh ? [] : this.virt.filter(v => now - v.at < 4000);
    this.pos = real;
    if (Array.isArray(r.bars) && r.bars.length) this.setBars(r.bars);
    this.tickBar();
  }
  setBars(bars) {
    const b = this.base; b.t.length = b.o.length = b.h.length = b.l.length = b.c.length = b.v.length = 0;
    for (const x of bars) { b.t.push(x[0]); b.o.push(x[1]); b.h.push(x[2]); b.l.push(x[3]); b.c.push(x[4]); b.v.push(x[5] || 0); }
    this.nClosed = b.t.length; this.cache.clear(); this.forming = null;
  }
  // keep a forming candle at the end of the series, built from the live price
  tickBar() {
    const b = this.base; if (!this.nClosed || !this.bid) return;
    const open = b.t[this.nClosed - 1] + this.periodSec;
    if (!this.forming || this.forming.t !== open) {
      b.t.length = b.o.length = b.h.length = b.l.length = b.c.length = b.v.length = this.nClosed;
      this.forming = { t: open }; b.t.push(open); b.o.push(this.bid); b.h.push(this.bid); b.l.push(this.bid); b.c.push(this.bid); b.v.push(1); this.cache.clear();
    }
    const i = this.nClosed;
    if (this.bid > b.h[i]) b.h[i] = this.bid; if (this.bid < b.l[i]) b.l[i] = this.bid; b.c[i] = this.bid; b.v[i]++;
    b.n = this.nClosed + 1;
    for (const s of this.cache.values()) s.n = s.src === 'agg' ? s.n : b.n;
  }
  series(sec) {
    const b = this.base; if (!this.nClosed) return { t: [], o: [], h: [], l: [], c: [], v: [], n: 0 };
    if (sec <= this.periodSec) { b.n = this.forming ? this.nClosed + 1 : this.nClosed; return b; }
    const key = sec + ':' + this.nClosed; let s = this.cache.get(key);
    if (!s) {
      s = { t: [], o: [], h: [], l: [], c: [], v: [], n: 0, src: 'agg', hi: -1 };
      for (let i = 0; i < b.t.length; i++) {
        const k = Math.floor(b.t[i] / sec) * sec;
        if (s.t.length && s.t[s.t.length - 1] === k) { const j = s.t.length - 1; s.h[j] = Math.max(s.h[j], b.h[i]); s.l[j] = Math.min(s.l[j], b.l[i]); s.c[j] = b.c[i]; s.v[j] += b.v[i]; }
        else { s.t.push(k); s.o.push(b.o[i]); s.h.push(b.h[i]); s.l.push(b.l[i]); s.c.push(b.c[i]); s.v.push(b.v[i]); }
      }
      s.n = s.t.length; s.ci = b.t.length - 1; this.cache.set(key, s);
    } else { // refresh the last candle from the forming one
      const j = s.t.length - 1, i = b.t.length - 1;
      if (Math.floor(b.t[i] / sec) * sec === s.t[j]) { s.h[j] = Math.max(s.h[j], b.h[i]); s.l[j] = Math.min(s.l[j], b.l[i]); s.c[j] = b.c[i]; }
    }
    return s;
  }
  positions() { return [...this.pos, ...this.virt]; }
  send(r) {
    if (r.op === 'buy' || r.op === 'sell') {
      const buy = r.op === 'buy', entry = buy ? this.ask : this.bid;
      if (!entry) return { retcode: 10018 };
      const lots = Math.max(0.01, Math.round(r.volume * 100) / 100);
      this.cmds.push({ a: r.op, lots, sl: r.sl ? +Math.abs(entry - r.sl).toFixed(3) : 0, tp: r.tp ? +Math.abs(r.tp - entry).toFixed(3) : 0, raw: 1 });
      const t = this.nextVirt--;
      this.virt.push({ ticket: t, type: buy ? 0 : 1, volume: lots, open: entry, sl: r.sl || 0, tp: r.tp || 0, profit: 0, swap: 0, magic: r.magic || 0, comment: r.comment || '', time: this.timeSec(), at: Date.now() });
      return { retcode: 10009, ticket: t, price: entry };
    }
    const all = this.positions(), p = all.find(x => x.ticket === r.ticket);
    if (!p) return { retcode: 10013 };
    if (r.op === 'close') { if (p.ticket > 0) this.cmds.push({ a: 'close', t: p.ticket }); this.pos = this.pos.filter(x => x !== p); this.virt = this.virt.filter(x => x !== p); return { retcode: 10009 }; }
    if (r.op === 'modify') { p.sl = +r.sl || 0; p.tp = +r.tp || 0; if (p.ticket > 0) this.cmds.push({ a: 'mod', t: p.ticket, sl: p.sl, tp: p.tp }); return { retcode: 10009 }; }
    return { retcode: 10013 };
  }
  takeCmds() { const c = this.cmds; this.cmds = []; return c; }
}

// One running bot: parse + run on the server. Returns a controller used by server.js.
export function startBot(source, values, host) {
  const vm = createVM(source, host);
  for (const [k, v] of Object.entries(values || {})) { try { vm.setInput(k, v); } catch { /* ignore unknown */ } }
  return vm;
}
export { createVM };
