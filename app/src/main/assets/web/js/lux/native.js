// Talks to your Kanairy server on the VPS through the Android app (signed requests).
// In a normal browser (no Android) it runs a small demo so the design can be previewed.
import { HOST } from './host.js';
const N = window.Android || null;
const T = N ? N.token() : '';
export const native = !!N;
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// ---------- request plumbing ----------
let seq = 0;
const pend = new Map();
window.__vpsCb = (id, status, text) => { const f = pend.get(id); if (f) { pend.delete(id); f({ status, text }); } };
function req(method, path, body) {
  return new Promise(res => {
    if (!N) { res({ status: 0, text: '' }); return; }
    const id = ++seq;
    const to = setTimeout(() => { pend.delete(id); res({ status: 0, text: 'timeout' }); }, 30000);
    pend.set(id, r => { clearTimeout(to); res(r); });
    N.vps(T, id, method, path, body ? JSON.stringify(body) : '');
  });
}

// ---------- cache the UI reads from ----------
const C = { status: {}, feed: [], link: N ? 'unconfigured' : 'ok', vps: { url: '', hasKey: false, user: '' }, n: 0, bad: 0, busy: false };
async function poll() {
  if (!N || C.busy) return;
  C.busy = true;
  try {
    C.vps = parse(N.vpsInfo(T), { url: '', hasKey: false, user: '' });
    if (C.vps.url !== HOST) { N.saveVps(T, HOST, ''); C.vps.url = HOST; }
    if (!C.vps.hasKey || !C.vps.user) { C.link = 'unconfigured'; C.status = {}; return; }
    const r = await req('GET', '/api/status');
    if (r.status === 200) {
      C.link = 'ok'; C.bad = 0;
      C.status = parse(r.text, {});
      if (C.n++ % 2 === 0) { const f = await req('GET', '/api/feed'); if (f.status === 200) C.feed = parse(f.text, []); }
    } else if (r.status === 401) { if (++C.bad >= 2) C.link = 'badcode'; }
    else C.link = r.status === 429 ? 'locked' : 'offline';
  } finally { C.busy = false; }
}
if (N) { setInterval(poll, 2500); poll(); }

// ---------- demo (preview only) ----------
const demo = { ea: { mode: 'kanairy', lang: 'mq5', inputs: [], values: {}, name: '', state: 'none', log: '', hasPreset: false }, run: false, pos: [], feed: [], pnl: 0, trades: 0, wins: 0, cfg: {}, strat: null, login: '', server: '', hasPw: false, symbol: 'XAUUSD' };
function demoTick() {
  if (!demo.run) return;
  if (Math.random() < .35 && demo.pos.length < 3) {
    const buy = Math.random() < .5, p = 2314 + Math.random() * 3;
    demo.pos.push([Date.now(), buy ? 0 : 1, 0.01, p, p - 1.1, p + 1.6, 0]);
    demo.feed.unshift({ t: Date.now(), k: 'open', text: (buy ? 'BUY' : 'SELL') + ' opened', side: buy ? 'buy' : 'sell', lots: 0.01, price: p, profit: 0 });
  }
  demo.pos.forEach(p => { p[6] = +(p[6] + (Math.random() - .42) * .9).toFixed(2); });
  if (demo.pos.length && Math.random() < .45) {
    const p = demo.pos.shift();
    demo.pnl += p[6]; demo.trades++; if (p[6] >= 0) demo.wins++;
    demo.feed.unshift({ t: Date.now(), k: 'close', text: (p[1] ? 'SELL' : 'BUY') + ' closed', side: p[1] ? 'sell' : 'buy', lots: p[2], price: p[3], profit: p[6] });
  }
  demo.feed = demo.feed.slice(0, 40);
}
if (!N) setInterval(demoTick, 1800);

// ---------- public API ----------
const LINK_TEXT = { unconfigured: 'Enter your code in the Connect tab first', offline: 'Cannot reach the server. Check your internet, or tell the owner the server may be off', badcode: 'That code is not recognised. Check it in the Connect tab', locked: 'Too many wrong codes. Try again in 10 minutes' };
const linkOk = () => { if (!N || C.link === 'ok') return true; B.onError(LINK_TEXT[C.link] || 'Server not connected'); return false; };

export const B = {
  onError: () => {},
  link: () => C.link,
  linkOk,
  vps: () => C.vps,
  status() {
    if (!N) return { link: 'ok', svc: true, run: demo.run, conn: true, sym: 'XAUUSD', tf: 'M1', bal: 10000 + demo.pnl, eq: 10000 + demo.pnl + demo.pos.reduce((a, p) => a + p[6], 0), pos: demo.pos, dayPnl: +demo.pnl.toFixed(2), dayTrades: demo.trades, wins: demo.wins, losses: demo.trades - demo.wins, signal: 'WAIT', err: '', strategy: demo.strat ? demo.strat.name : '' };
    return { ...C.status, link: C.link, run: C.link === 'ok' && !!C.status.run, conn: C.link === 'ok' && !!C.status.conn, strategy: C.link === 'ok' ? (C.status.strategy || '') : '' };
  },
  feed: () => (N ? C.feed : demo.feed),
  info: () => (N ? (C.status.info || {}) : { login: demo.login, server: demo.server, hasPw: demo.hasPw, symbol: demo.symbol }),
  pollNow: () => poll(),
  async run(on) { if (!linkOk()) return; if (N) { await req('POST', '/api/run', { on: !!on }); C.status.run = !!on; poll(); } else demo.run = !!on; },
  async kill() { if (!linkOk()) return; if (N) { await req('POST', '/api/kill', {}); C.status.run = false; poll(); } else { demo.run = false; demo.pos = []; } },
  async saveLogin(login, server, password, symbol) {
    if (!linkOk()) return false;
    if (!N) { demo.login = login; demo.server = server; demo.symbol = symbol; if (password) demo.hasPw = true; return true; }
    const r = await req('POST', '/api/login', { login, server, password, symbol });
    poll(); return r.status === 200;
  },
  async clearLogin() { if (!linkOk()) return; if (N) { await req('POST', '/api/login', { clear: true }); poll(); } else { demo.login = ''; demo.server = ''; demo.hasPw = false; } },
  async launch() {
    if (!N) return { ok: false, error: 'Preview only. Install the Android app.' };
    if (!linkOk()) return { ok: false, error: LINK_TEXT[C.link] };
    const r = await req('POST', '/api/launch', {});
    return parse(r.text, { ok: false, error: 'No answer from the server' });
  },
  getCfg: (k, d) => (N ? (C.status.cfg && C.status.cfg[k] !== undefined ? C.status.cfg[k] : d) : (demo.cfg[k] ?? d)),
  async setCfg(k, v) {
    if (!linkOk()) return;
    if (!N) { demo.cfg[k] = v; return; }
    if (C.status.cfg) C.status.cfg[k] = Number(v);
    await req('POST', '/api/cfg', { key: k, value: Number(v) });
  },
  // ---- one code, like K7M-4QX-9TD ----
  user: () => (N ? (C.vps.user || '') : 'ABC-123-XYZ'),
  async connect(code) {
    if (!N) return { ok: true };
    if (!N.saveCode(T, code)) return { ok: false, error: 'A code looks like K7M-4QX-9TD (9 letters and numbers)' };
    N.saveVps(T, HOST, '');
    const r = await req('GET', '/api/me');
    if (r.status === 200) { C.status = {}; C.bad = 0; await poll(); return { ok: true }; }
    N.clearUser(T); poll();
    return { ok: false, error: r.status === 401 ? 'That code is not recognised' : r.status === 429 ? 'Too many wrong codes. Try again in 10 minutes.' : 'Cannot reach the server. Check your internet.' };
  },
  signOut() { if (N) { N.clearUser(T); C.status = {}; C.link = 'unconfigured'; poll(); } },
  async deleteAccount() {
    if (!N) return { ok: true };
    const r = await req('POST', '/api/account/delete', {});
    if (r.status === 200) { N.clearUser(T); C.status = {}; C.link = 'unconfigured'; poll(); return { ok: true }; }
    return { ok: false, error: 'Could not delete. Try again.' };
  },
};
