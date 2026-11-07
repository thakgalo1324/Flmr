// Talks to your Kanairy server on the VPS through the Android app (signed requests).
// In a normal browser (no Android) it runs a small demo so the design can be previewed.
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
    const to = setTimeout(() => { pend.delete(id); res({ status: 0, text: 'timeout' }); }, 15000);
    pend.set(id, r => { clearTimeout(to); res(r); });
    N.vps(T, id, method, path, body ? JSON.stringify(body) : '');
  });
}

// ---------- cache the UI reads from ----------
const C = { status: {}, feed: [], strat: null, stratRev: -1, link: N ? 'unconfigured' : 'ok', vps: { url: '', hasKey: false }, n: 0, busy: false };
async function poll() {
  if (!N || C.busy) return;
  C.busy = true;
  try {
    C.vps = parse(N.vpsInfo(T), { url: '', hasKey: false });
    if (!C.vps.url || !C.vps.hasKey) { C.link = 'unconfigured'; return; }
    const r = await req('GET', '/api/status');
    if (r.status === 200) {
      C.link = 'ok';
      C.status = parse(r.text, {});
      if (C.status.rev !== C.stratRev) {
        const s = await req('GET', '/api/strategy');
        if (s.status === 200) { C.strat = parse(s.text, {}).strategy || null; C.stratRev = C.status.rev; }
      }
      if (C.n++ % 2 === 0) { const f = await req('GET', '/api/feed'); if (f.status === 200) C.feed = parse(f.text, []); }
    } else C.link = r.status === 401 ? 'badkey' : 'offline';
  } finally { C.busy = false; }
}
if (N) { setInterval(poll, 1500); poll(); }

// ---------- demo (preview only) ----------
const demo = { run: false, pos: [], feed: [], pnl: 0, trades: 0, wins: 0, cfg: {}, strat: null, login: '', server: '', hasPw: false, symbol: 'XAUUSD' };
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
const LINK_TEXT = { unconfigured: 'Connect your server in Setup first', offline: 'Cannot reach your server. Check the address and that it is running', badkey: 'The server rejected your key. Check it in Setup' };
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
  getStrategy: () => { const s = N ? C.strat : demo.strat; return s ? JSON.stringify(s) : ''; },
  async setStrategy(json) {
    if (!linkOk()) return false;
    const s = parse(json, null);
    if (!N) { demo.strat = s; return true; }
    C.strat = s; if (C.status) C.status.strategy = s ? s.name : '';
    const r = await req('POST', '/api/strategy', { strategy: s });
    poll(); return r.status === 200;
  },
  saveVps(url, key) { if (N) N.saveVps(T, url, key); },
};
