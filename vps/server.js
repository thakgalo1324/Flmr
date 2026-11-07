// Kanairy server. Runs on your VPS next to MT5.
//   EA  <--(127.0.0.1:eaPort, token)-->  this server  <--(appPort, signed requests)-->  Kanairy phone app
// No dependencies. Needs Node 18 or newer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
fs.mkdirSync(DATA, { recursive: true });
const CFG_FILE = path.join(DIR, 'config.json');
const STATE_FILE = path.join(DATA, 'state.json');
const SECRET_FILE = path.join(DATA, 'secrets.json');
const INI_FILE = path.join(DATA, 'kanairy-start.ini');

// ---------- config (created on first run) ----------
const rnd = n => crypto.randomBytes(n).toString('hex');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { /* first run */ }
const defaults = {
  appKey: rnd(16), eaToken: rnd(12), appPort: 8766, eaPort: 8765,
  mt5Path: 'C:\\Program Files\\MetaTrader 5\\terminal64.exe',
  mt5DataDir: '', // File > Open Data Folder in MT5, e.g. C:\\Users\\you\\AppData\\Roaming\\MetaQuotes\\Terminal\\ABC123
  allowLive: false,
};
let fresh = false;
for (const [k, v] of Object.entries(defaults)) if (cfg[k] === undefined) { cfg[k] = v; fresh = true; }
if (fresh) fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));

// ---------- strategy engine (the same code as the app's Strategy lab) ----------
globalThis.window = globalThis;
await import('./engine/engine.js');
const evalStrategy = (candles, strat) => JSON.parse(globalThis.__eval(JSON.stringify(candles), JSON.stringify(strat)));

// ---------- persistent state ----------
const GUARD_KEYS = ['hub_lot', 'hub_max_open', 'hub_burst', 'hub_cooldown', 'hub_max_day', 'hub_daily_loss', 'hub_max_spread'];
const GUARD_DEFAULTS = { hub_lot: 0, hub_max_open: 3, hub_burst: 1, hub_cooldown: 0, hub_max_day: 200, hub_daily_loss: 0, hub_max_spread: 0 };
let S = { guards: { ...GUARD_DEFAULTS }, strategy: null, rev: 0, feed: [], login: '', server: '', symbol: 'XAUUSD', tf: 'M1', hasPw: false, day: 0, dayTrades: 0, wins: 0, losses: 0, dayPnl: 0 };
try { S = { ...S, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; S.guards = { ...GUARD_DEFAULTS, ...S.guards }; } catch { /* first run */ }
let saveT = null;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(STATE_FILE, JSON.stringify(S), () => {}), 400); };

// live (not persisted)
const L = { running: false, killPending: false, lastSync: 0, sym: '', tf: '', bid: 0, ask: 0, bal: 0, eq: 0, spread: 0, hedge: true, pos: [], signal: 'WAIT', err: '', lastBarT: 0, lastEntryMs: 0 };

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
function addFeed(k, text, side = '', lots = 0, price = 0, profit = 0) {
  S.feed.unshift({ t: Date.now(), k, text, side, lots, price, profit });
  S.feed = S.feed.slice(0, 80);
  save();
}
function rollDay() {
  const d = new Date(), key = d.getFullYear() * 1000 + Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  if (S.day !== key) { S.day = key; S.dayTrades = 0; S.wins = 0; S.losses = 0; S.dayPnl = 0; save(); }
}
const g = k => Number(S.guards[k] ?? GUARD_DEFAULTS[k]);

// ---------- secrets (broker password, encrypted with the app key) ----------
function putSecret(plain) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(cfg.appKey, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  fs.writeFileSync(SECRET_FILE, JSON.stringify({ salt: salt.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') }), { mode: 0o600 });
}
function getSecret() {
  try {
    const j = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    const key = crypto.scryptSync(cfg.appKey, Buffer.from(j.salt, 'hex'), 32);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(j.iv, 'hex'));
    d.setAuthTag(Buffer.from(j.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(j.ct, 'hex')), d.final()]).toString('utf8');
  } catch { return ''; }
}

// ---------- the brain: EA sync ----------
function sync(r) {
  rollDay();
  L.lastSync = Date.now();
  L.sym = r.sym || L.sym; L.tf = r.tf || L.tf;
  L.bid = +r.bid || 0; L.ask = +r.ask || 0; L.bal = +r.bal || 0; L.eq = +r.eq || 0; L.spread = +r.spread || 0;
  L.hedge = r.hedge !== false;
  L.pos = Array.isArray(r.pos) ? r.pos : [];
  const out = { cmds: [], run: L.running };
  if (L.killPending) { out.cmds.push({ a: 'closeall' }); L.killPending = false; return out; }
  if (!L.running) return out;
  if (L.lastBarT === 0) out.want = true; // ask the EA for candles now
  const bars = r.bars, barT = +r.barT || 0;
  if (!Array.isArray(bars) || bars.length < 30) return out;
  if (barT && barT === L.lastBarT) return out;
  L.lastBarT = barT;
  if (!S.strategy) { L.err = 'No strategy loaded. Import XML in the app.'; return out; }
  const candles = bars.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
  let sig;
  try { sig = evalStrategy(candles, S.strategy); } catch (e) { L.err = 'Engine error: ' + e.message; return out; }
  if (sig.error) { L.err = sig.error; return out; }
  L.err = '';
  decide(sig, out.cmds);
  return out;
}

function decide(sig, cmds) {
  const rules = S.strategy.rules || {};
  const hasExit = (rules.exitLong || []).length + (rules.exitShort || []).length > 0;
  const enL = !!sig.enterLong, enS = !!sig.enterShort, exL = !!sig.exitLong, exS = !!sig.exitShort;
  L.signal = enL && !enS ? 'BUY' : enS && !enL ? 'SELL' : 'WAIT';
  let nb = L.pos.filter(p => p[1] === 0).length, ns = L.pos.filter(p => p[1] === 1).length;
  if ((exL || (!hasExit && enS)) && nb > 0) { L.pos.filter(p => p[1] === 0).forEach(p => cmds.push({ a: 'close', t: p[0] })); nb = 0; }
  if ((exS || (!hasExit && enL)) && ns > 0) { L.pos.filter(p => p[1] === 1).forEach(p => cmds.push({ a: 'close', t: p[0] })); ns = 0; }
  if (L.signal === 'WAIT') return;
  const buy = L.signal === 'BUY', now = Date.now(), open = nb + ns;
  if (!L.hedge && ((buy && ns > 0) || (!buy && nb > 0))) return;
  if (g('hub_daily_loss') > 0 && S.dayPnl <= -g('hub_daily_loss')) { L.err = 'Daily loss limit reached'; return; }
  if (g('hub_max_spread') > 0 && L.spread > g('hub_max_spread')) { L.err = 'Spread too wide (' + L.spread + ')'; return; }
  if (now - L.lastEntryMs < g('hub_cooldown') * 1000) return;
  let burst = Math.max(1, Math.min(5, Math.floor(g('hub_burst')))); if (!L.hedge) burst = 1;
  const allow = Math.min(burst, g('hub_max_open') - open, g('hub_max_day') - S.dayTrades);
  if (allow <= 0) return;
  const atr = sig.atr;
  if (!(atr > 0)) { L.err = 'ATR not ready'; return; }
  const slAtr = sig.slAtr || 1.5, tpAtr = sig.tpAtr || 0;
  const lots = g('hub_lot') > 0 ? g('hub_lot') : (sig.lots || 0.01);
  for (let i = 0; i < allow; i++) cmds.push({ a: buy ? 'buy' : 'sell', lots, sl: atr * slAtr, tp: tpAtr > 0 ? atr * tpAtr : 0 });
  S.dayTrades += allow; L.lastEntryMs = now;
  addFeed('signal', L.signal + ' signal x' + allow, buy ? 'buy' : 'sell', lots);
}

function eaEvent(e) {
  rollDay();
  const side = String(e.side || '');
  if (e.k === 'close') { S.dayPnl += +e.profit || 0; if ((+e.profit || 0) >= 0) S.wins++; else S.losses++; addFeed('close', side.toUpperCase() + ' closed', side, +e.lots, +e.price, +e.profit); }
  else if (e.k === 'open') addFeed('open', side.toUpperCase() + ' opened', side, +e.lots, +e.price);
  else addFeed('sys', String(e.text || 'EA message'));
  save();
}

// ---------- app API ----------
function setRunning(on) {
  L.running = !!on; if (on) { L.err = ''; L.lastBarT = 0; }
  addFeed('sys', on ? 'Bot started' : 'Bot stopped');
}
function status() {
  rollDay();
  const now = Date.now();
  return {
    run: L.running, conn: L.lastSync > 0 && now - L.lastSync < 6000, age: L.lastSync ? Math.round((now - L.lastSync) / 1000) : -1,
    sym: L.sym, tf: L.tf, bid: L.bid, ask: L.ask, bal: L.bal, eq: L.eq, spread: L.spread, hedge: L.hedge, pos: L.pos,
    dayPnl: +S.dayPnl.toFixed(2), dayTrades: S.dayTrades, wins: S.wins, losses: S.losses, signal: L.signal, err: L.err,
    strategy: S.strategy ? S.strategy.name : '', rev: S.rev,
    info: { login: S.login, server: S.server, hasPw: S.hasPw, symbol: S.symbol, tf: S.tf, allowLive: !!cfg.allowLive, mt5Ready: !!cfg.mt5Path && !!cfg.mt5DataDir },
    cfg: S.guards,
  };
}

function writeStartFiles() {
  const pw = getSecret();
  const ini = ['[Common]', `Login=${S.login}`, `Password=${pw}`, `Server=${S.server}`, 'NewsEnable=0',
    '[Experts]', 'Enabled=1', 'AllowLiveTrading=1', 'AllowDllImport=0', 'Account=0', 'Profile=0', 'WebRequest=1', `WebRequestUrl=http://127.0.0.1:${cfg.eaPort}`,
    '[StartUp]', 'Expert=KanairyEA', 'ExpertParameters=kanairy.set', `Symbol=${S.symbol}`, `Period=${S.tf}`, ''].join('\r\n');
  fs.writeFileSync(INI_FILE, ini, { mode: 0o600 });
  if (cfg.mt5DataDir) {
    const dir = path.join(cfg.mt5DataDir, 'MQL5', 'Presets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kanairy.set'), `InpToken=${cfg.eaToken}\r\nInpPort=${cfg.eaPort}\r\nInpAllowLive=${cfg.allowLive ? 'true' : 'false'}\r\n`);
  }
  setTimeout(() => fs.unlink(INI_FILE, () => {}), 90000); // MT5 reads it at startup; remove the password afterwards
}

function launchMt5() {
  if (!S.login || !S.server || !S.hasPw) return { ok: false, error: 'Save your broker login first.' };
  if (!cfg.mt5Path || !fs.existsSync(cfg.mt5Path)) return { ok: false, error: 'MT5 not found. Set mt5Path in config.json on the VPS.' };
  writeStartFiles();
  const start = () => {
    const child = process.platform === 'win32' ? spawn(cfg.mt5Path, ['/config:' + INI_FILE], { detached: true, stdio: 'ignore' }) : spawn('wine', [cfg.mt5Path, '/config:' + INI_FILE], { detached: true, stdio: 'ignore' });
    child.on('error', e => log('MT5 launch failed:', e.message));
    child.unref();
    log('MT5 started');
  };
  if (process.platform === 'win32') execFile('taskkill', ['/IM', 'terminal64.exe', '/F'], () => setTimeout(start, 2500));
  else start();
  addFeed('sys', 'MT5 restarting with your login');
  return { ok: true };
}

const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
function readBody(req, max = 3e6) {
  return new Promise((ok, no) => { let n = 0; const ch = []; req.on('data', c => { n += c.length; if (n > max) { no(new Error('too large')); req.destroy(); } else ch.push(c); }); req.on('end', () => ok(Buffer.concat(ch).toString('utf8'))); req.on('error', no); });
}

const seen = new Map();
function appAuth(req, body) {
  const ts = Number(req.headers['x-ts']), nonce = String(req.headers['x-nonce'] || ''), sig = String(req.headers['x-sig'] || '');
  if (!ts || !nonce || !sig || Math.abs(Date.now() - ts) > 60000) return false;
  const exp = crypto.createHmac('sha256', cfg.appKey).update(`${ts}\n${nonce}\n${req.method}\n${req.url}\n${body}`).digest('hex');
  const a = Buffer.from(exp), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  if (seen.has(sig)) return false; // replay
  seen.set(sig, ts);
  for (const [k, v] of seen) if (Date.now() - v > 130000) seen.delete(k);
  return true;
}

const appServer = http.createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    if (!appAuth(req, body)) return send(res, 401, { error: 'unauthorized' });
    const j = body ? JSON.parse(body) : {};
    const u = req.url;
    if (u === '/api/status') return send(res, 200, status());
    if (u === '/api/feed') return send(res, 200, S.feed);
    if (u === '/api/strategy' && req.method === 'GET') return send(res, 200, { strategy: S.strategy, rev: S.rev });
    if (u === '/api/strategy') { S.strategy = j.strategy || null; S.rev++; if (S.strategy && S.strategy.timeframe) S.tf = S.strategy.timeframe; L.lastBarT = 0; save(); addFeed('sys', S.strategy ? 'Strategy loaded: ' + S.strategy.name : 'Strategy cleared'); return send(res, 200, { ok: true, rev: S.rev }); }
    if (u === '/api/cfg') { if (!GUARD_KEYS.includes(j.key) || !(Number(j.value) >= 0)) return send(res, 400, { error: 'bad value' }); S.guards[j.key] = Number(j.value); save(); return send(res, 200, { ok: true }); }
    if (u === '/api/run') { setRunning(j.on); return send(res, 200, { ok: true }); }
    if (u === '/api/kill') { L.running = false; L.killPending = true; addFeed('sys', 'Kill switch: closing all trades'); return send(res, 200, { ok: true }); }
    if (u === '/api/login') {
      S.login = String(j.login || '').trim(); S.server = String(j.server || '').trim();
      S.symbol = String(j.symbol || S.symbol || 'XAUUSD').toUpperCase().replace(/[^A-Z0-9._]/g, '');
      if (j.tf) S.tf = String(j.tf);
      if (j.password) { putSecret(String(j.password)); S.hasPw = true; }
      if (j.clear) { S.login = ''; S.server = ''; S.hasPw = false; try { fs.unlinkSync(SECRET_FILE); } catch { /* none */ } }
      save(); return send(res, 200, { ok: true });
    }
    if (u === '/api/launch') return send(res, 200, launchMt5());
    return send(res, 404, { error: 'unknown' });
  } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
});

// ---------- EA listener (this machine only) ----------
const eaServer = http.createServer(async (req, res) => {
  try {
    const tok = String(req.headers['x-token'] || '');
    const a = Buffer.from(tok), b = Buffer.from(cfg.eaToken);
    const body = await readBody(req);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 401, { error: 'bad token' });
    if (req.url.startsWith('/ping')) return send(res, 200, { ok: true });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const j = JSON.parse(body || '{}');
    if (req.url.startsWith('/sync')) return send(res, 200, sync(j));
    if (req.url.startsWith('/event')) { eaEvent(j); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'unknown' });
  } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
});

appServer.listen(cfg.appPort, '0.0.0.0', () => log(`App API on port ${cfg.appPort}`));
eaServer.listen(cfg.eaPort, '127.0.0.1', () => log(`EA bridge on 127.0.0.1:${cfg.eaPort}`));
console.log('\n  Kanairy server is running.');
console.log(`  App address:  http://<your VPS public IP>:${cfg.appPort}`);
console.log(`  App key:      ${cfg.appKey}`);
console.log(`  EA token:     ${cfg.eaToken}   (only needed if you attach the EA by hand)\n`);
