// Kanairy server. Runs on your VPS next to MT5.
//   EA  <--(127.0.0.1:eaPort, token)-->  this server  <--(appPort, signed requests)-->  Kanairy phone app
// No dependencies. Needs Node 18 or newer.
import { parseSignal, planOrders } from './signals.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { patchSection } from './mt5ini.js';
import { createVM } from './mql/interp.js';
import { LiveHost } from './mql/live.js';
import { TF_SEC, TF } from './mql/consts.js';
import { parseInputs, parsePyInputs, patchPySource, parseSet, renderSet, applyValues } from './ea-tools.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// KANAIRY_HOME lets the gateway run one copy of this server per person, each with its own settings and data.
const HOME = process.env.KANAIRY_HOME || DIR;
const DATA = path.join(HOME, 'data');
fs.mkdirSync(DATA, { recursive: true });
const CFG_FILE = path.join(HOME, 'config.json');
const STATE_FILE = path.join(DATA, 'state.json');
const SECRET_FILE = path.join(DATA, 'secrets.json');
const INI_FILE = path.join(DATA, 'kanairy-start.ini');

// ---------- config (created on first run) ----------
const rnd = n => crypto.randomBytes(n).toString('hex');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { /* first run */ }
const defaults = {
  appKey: rnd(16), eaToken: rnd(12), appPort: 8766, eaPort: 80,
  mt5Path: 'C:\\Program Files\\MetaTrader 5\\terminal64.exe',
  mt5DataDir: '', // File > Open Data Folder in MT5, e.g. C:\\Users\\you\\AppData\\Roaming\\MetaQuotes\\Terminal\\ABC123
  allowLive: false,
  autoLaunch: true, // start MT5 by itself when the server starts, and again if it dies
  appHost: '0.0.0.0', eaHost: '127.0.0.1', // the gateway gives each person their own private addresses
  portable: false, // true = this server owns a private MT5 copy (one per person)
  quiet: false,
};
let fresh = false;
for (const [k, v] of Object.entries(defaults)) if (cfg[k] === undefined) { cfg[k] = v; fresh = true; }
// MetaTrader's WebRequest only talks to the standard web ports (80 for http), so the EA bridge lives on port 80.
if (!cfg.eaPort || Number(cfg.eaPort) === 8765) { cfg.eaPort = 80; fresh = true; }
if (fresh) fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
// Every private address (127.0.1.1 to 127.0.1.10) plus plain 127.0.0.1, so MT5 already allows them all, for every account.
const allowList = () => { const a = ['127.0.0.1', 'localhost']; for (let i = 1; i <= 10; i++) a.push('127.0.1.' + i); return a.flatMap(h => ['http://' + h, 'https://' + h]).join(';'); };
const eaUrl = () => 'http://' + (cfg.eaHost || '127.0.0.1') + (Number(cfg.eaPort) === 80 ? '' : ':' + cfg.eaPort);

// ---------- strategy engine (the same code as the app's Strategy lab) ----------
globalThis.window = globalThis;
await import('./engine/engine.js');
const evalStrategy = (candles, strat) => JSON.parse(globalThis.__eval(JSON.stringify(candles), JSON.stringify(strat)));

// ---------- persistent state ----------
const GUARD_KEYS = ['hub_lot', 'hub_max_open', 'hub_burst', 'hub_cooldown', 'hub_max_day', 'hub_daily_loss', 'hub_max_spread', 'hub_lot_per_1k', 'hub_lot_cap', 'hub_max_total_lots', 'hub_risk_pct'];
const GUARD_DEFAULTS = { hub_lot: 0, hub_max_open: 3, hub_burst: 1, hub_cooldown: 0, hub_max_day: 200, hub_daily_loss: 0, hub_max_spread: 0, hub_lot_per_1k: 0, hub_lot_cap: 0.1, hub_max_total_lots: 0, hub_risk_pct: 0 };
// ea = an imported .mq5 expert advisor. mode 'kanairy' runs KanairyEA with your XML rules; mode 'custom' runs the imported EA by itself.
const FILTER_DEFAULT = { on: true, maxSpread: 0.35, windows: '' }; // maxSpread in dollars for gold (0.35 = 35 points); windows are UTC like 21:55-23:05
const EA_DEFAULT = { mode: 'kanairy', engine: '', lang: 'mq5', name: '', state: 'none', log: '', hasPreset: false, inputs: [], values: {} };
let S = { guards: { ...GUARD_DEFAULTS }, strategy: null, rev: 0, feed: [], login: '', server: '', symbol: 'XAUUSD', tf: 'M1', hasPw: false, day: 0, dayTrades: 0, wins: 0, losses: 0, dayPnl: 0, ea: { ...EA_DEFAULT } };
try { S = { ...S, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; S.guards = { ...GUARD_DEFAULTS, ...S.guards }; S.ea = { ...EA_DEFAULT, ...S.ea }; } catch { /* first run */ }
S.filter = { ...FILTER_DEFAULT, ...(S.filter || {}) };
S.sig = { mode: 'off', lots: 0.01, both: false, list: [], ...(S.sig || {}) };
if (S.ea.state === 'compiling') { S.ea.state = 'failed'; S.ea.log = 'Compile was interrupted. Import the file again.'; } // server restarted mid-compile
const isPy = () => isCustom() && S.ea.lang === 'py';
const isCustom = () => S.ea.mode === 'custom' && S.ea.state === 'ok' && !!S.ea.name && S.ea.engine !== 'server';
// engine 'server': the pasted .mq5 is read and run by this server, MT5 only carries out the orders through KanairyEA
const isSrv = () => S.ea.mode === 'custom' && S.ea.state === 'ok' && !!S.ea.name && S.ea.engine === 'server';
let saveT = null;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(STATE_FILE, JSON.stringify(S), () => {}), 400); };

// live (not persisted)
const L = { running: false, killPending: false, lastSync: 0, sym: '', tf: '', bid: 0, ask: 0, bal: 0, eq: 0, spread: 0, hedge: true, pos: [], signal: 'WAIT', err: '', lastBarT: 0, at: true, evalAt: 0, lastEntryMs: 0, launchedAt: 0, relaunches: 0, eaSeen: 0, badToken: 0, mt5Up: false, wasConn: false, owner: null };

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
let wrongSymLog = 0;
function sync(r) {
  rollDay();
  if (isCustom()) return { cmds: [], run: false, ignore: 'custom-ea' }; // an imported EA is in charge, KanairyEA must stay idle
  const now = Date.now(), sym = String(r.sym || ''), cid = String(r.cid || sym);
  // Only the symbol chosen in the app may trade, and only one chart at a time.
  if (S.symbol && sym && !sym.toUpperCase().startsWith(S.symbol.toUpperCase())) {
    if (now - wrongSymLog > 30000) { wrongSymLog = now; log(`Ignoring an EA on ${sym}. Kanairy trades ${S.symbol} only. Remove KanairyEA from the ${sym} chart.`); addFeed('sys', `Ignored EA on ${sym} (trading ${S.symbol} only)`); }
    return { cmds: [], run: false, ignore: 'symbol' };
  }
  if (L.owner && L.owner.cid !== cid && now - L.owner.at < 10000) return { cmds: [], run: false, dup: true };
  L.owner = { cid, at: now };
  L.lastSync = Date.now();
  L.sym = r.sym || L.sym; L.tf = r.tf || L.tf;
  L.bid = +r.bid || 0; L.ask = +r.ask || 0; L.bal = +r.bal || 0; L.eq = +r.eq || 0; L.spread = +r.spread || 0;
  L.hedge = r.hedge !== false;
  L.at = r.at !== false;
  L.pos = Array.isArray(r.pos) ? r.pos : [];
  const out = { cmds: [], run: L.running };
  if (L.killPending) { out.cmds.push({ a: 'closeall' }); L.killPending = false; return out; }
  if (isSrv()) { srvSync(r, out); return out; }
  if (!L.running) return out;
  runSignals(out.cmds);
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
  L.evalAt = Date.now();
  decide(sig, out.cmds); // the loaded strategy always trades; the Signals feature queues its own orders separately
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
  let burst = Math.max(1, Math.min(10, Math.floor(g('hub_burst')))); if (!L.hedge) burst = 1;
  const allow = Math.min(burst, g('hub_max_open') - open, g('hub_max_day') - S.dayTrades);
  if (allow <= 0) return;
  const atr = sig.atr;
  if (!(atr > 0)) { L.err = 'ATR not ready'; return; }
  const slAtr = sig.slAtr || 1.5, tpAtr = sig.tpAtr || 0;
  let lots = g('hub_lot') > 0 ? g('hub_lot') : (sig.lots || 0.01);
  // Optional compounding: lots grow with equity (lots per 1,000 of account currency), never above the cap.
  if (g('hub_lot_per_1k') > 0 && L.eq > 0) {
    const step = 0.01, cap = g('hub_lot_cap') > 0 ? g('hub_lot_cap') : 0.1;
    lots = Math.min(cap, Math.max(step, Math.floor((L.eq / 1000) * g('hub_lot_per_1k') / step) * step));
    lots = +lots.toFixed(2);
  }
  // Risk-based sizing (gold): the lot is chosen so that a stop-out costs about hub_risk_pct % of equity. Wide stops (volatile markets) get smaller lots,
  // the lot grows as the account grows and shrinks after losses. Never increases after a loss. A fixed lot (hub_lot) always wins over this.
  if (g('hub_risk_pct') > 0 && g('hub_lot') <= 0 && L.eq > 0 && String(S.symbol || '').toUpperCase().startsWith('XAU') && atr * slAtr > 0) {
    const cap = g('hub_lot_cap') > 0 ? g('hub_lot_cap') : 0.1;
    lots = +Math.min(cap, Math.max(0.01, Math.floor((L.eq * g('hub_risk_pct') / 100) / (atr * slAtr * 100) / 0.01 + 1e-9) * 0.01)).toFixed(2);
  }
  // Hard ceiling on all open volume together.
  let n = allow;
  if (g('hub_max_total_lots') > 0) {
    const openLots = L.pos.reduce((a, p) => a + (+p[2] || 0), 0);
    n = Math.min(n, Math.floor((g('hub_max_total_lots') - openLots + 1e-9) / lots));
    if (n <= 0) { L.err = 'Total lot ceiling reached'; return; }
  }
  // Ratchet mode: the target no longer closes the trade. The EA lets it run, then raises the stop one step at a time (step = trail x stop distance).
  const ratchet = sig.trail > 0 && tpAtr > 0;
  for (let i = 0; i < n; i++) cmds.push(ratchet
    ? { a: buy ? 'buy' : 'sell', lots, sl: atr * slAtr, tp: 0, tg: +(atr * tpAtr).toFixed(5), tr: +(atr * slAtr * sig.trail).toFixed(5) }
    : { a: buy ? 'buy' : 'sell', lots, sl: atr * slAtr, tp: tpAtr > 0 ? atr * tpAtr : 0 });
  S.dayTrades += n; L.lastEntryMs = now;
  addFeed('signal', L.signal + ' signal x' + n + ' @ ' + lots + ' lots', buy ? 'buy' : 'sell', lots);
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
  L.running = !!on; if (on) { L.err = ''; L.lastBarT = 0; L.evalAt = 0; }
  addFeed('sys', on ? 'Bot started' : 'Bot stopped');
}
function status() {
  rollDay();
  const now = Date.now();
  return {
    run: L.running, conn: L.lastSync > 0 && now - L.lastSync < 6000, age: L.lastSync ? Math.round((now - L.lastSync) / 1000) : -1,
    sym: L.sym, tf: L.tf, bid: L.bid, ask: L.ask, bal: L.bal, eq: L.eq, spread: L.spread, hedge: L.hedge, pos: L.pos,
    evalAge: L.evalAt ? Math.round((now - L.evalAt) / 1000) : -1,
    dayPnl: +S.dayPnl.toFixed(2), dayTrades: S.dayTrades, wins: S.wins, losses: S.losses, signal: L.signal,
    err: L.err || (L.running && L.lastSync > 0 && now - L.lastSync < 6000 && L.at === false ? 'AutoTrading is OFF in MT5. On the VPS, click the Algo Trading button so it turns green.' : ''),
    strategy: S.strategy ? S.strategy.name : '', rev: S.rev,
    info: { login: S.login, server: S.server, hasPw: S.hasPw, symbol: S.symbol, tf: S.tf, allowLive: !!cfg.allowLive, mt5Ready: !!cfg.mt5Path && !!cfg.mt5DataDir, portable: !!cfg.portable },
    cfg: S.guards,
    mt5Up: L.mt5Up, hint: hint(now), filter: S.filter, mon: monStatus(), cost: costStats(),
    ea: { mode: isCustom() || isSrv() ? 'custom' : 'kanairy', engine: S.ea.engine || '', srv: isSrv() ? srvInfo() : null, lang: S.ea.lang || 'mq5', name: S.ea.name, state: S.ea.state, log: S.ea.log, hasPreset: !!S.ea.hasPreset, inputs: (S.ea.inputs || []).map(i => ({ name: i.name, type: i.type, kind: i.kind, def: i.def, comment: i.comment, value: (S.ea.values || {})[i.name] ?? i.def })), running: isSrv() ? L.running : isCustom() && (S.ea.lang === 'py' ? !!(PY.child && PY.child.exitCode === null) : L.mt5Up && !L.stopped) },
  };
}

// Plain-language reason why the EA is not connected, shown in the app.
function hint(now = Date.now()) {
  if (isSrv() && !(L.lastSync > 0 && now - L.lastSync < 6000)) return 'Waiting for MT5. Make sure MT5 is open on the VPS with KanairyEA on the chart.';
  if (isSrv() && SV.vm && SV.vm.halted) return 'The bot stopped itself: ' + (SV.vm.error || 'error');
  if (isCustom()) {
    if (!S.login || !S.server || !S.hasPw) return 'Add your broker login in Account, then tap Launch MT5.';
    if (process.platform === 'win32' && !L.mt5Up) return L.launchedAt && now - L.launchedAt < 60000 ? 'MT5 is starting. Give it a minute.' : 'MT5 is not running on the server. Tap Launch MT5.';
    return `Running your imported EA "${S.ea.name}" inside MT5. It trades on its own, so watch it in the MT5 app.`;
  }
  if (L.lastSync > 0 && now - L.lastSync < 6000) return '';
  if (!cfg.mt5Path || !cfg.mt5DataDir) return 'MT5 was not found on the server. Open MT5 once on the VPS, then restart Kanairy server.';
  if (!S.login || !S.server || !S.hasPw) return 'Add your broker login in Account, then tap Launch MT5.';
  if (process.platform === 'win32' && !L.mt5Up) return L.launchedAt && now - L.launchedAt < 60000 ? 'MT5 is starting. Give it a minute.' : 'MT5 is not running on the server. Tap Launch MT5.';
  if (L.badToken && now - L.badToken < 20000) return 'The EA is calling with the wrong token. Tap Launch MT5 so it is set again.';
  if (L.lastSync > 0) return 'The EA stopped answering. Check MT5 is logged in and Algo Trading is on.';
  if (L.eaSeen && now - L.eaSeen < 20000) return 'The EA is reaching the server but not syncing. Tap Launch MT5.';
  return 'MT5 is open but the EA has not called in. On the VPS, check the chart for a smiley face and Algo Trading on.';
}

// Also write the WebRequest allow-list straight into MT5's own settings, so it does not depend on the startup file alone.
function patchCommon() {
  if (!cfg.mt5DataDir) return;
  try {
    const f = path.join(cfg.mt5DataDir, 'config', 'common.ini');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const cur = fs.existsSync(f) ? fs.readFileSync(f) : Buffer.alloc(0);
    const next = patchSection(cur, 'Experts', { Enabled: 1, AllowLiveTrading: 1, Account: 0, Profile: 0, WebRequest: 1, WebRequestUrl: allowList() });
    if (!cur.equals(next)) fs.writeFileSync(f, next);
  } catch (e) { log('Could not update MT5 settings:', e.message); }
}

function writeStartFiles() {
  const pw = getSecret();
  const ini = ['[Common]', `Login=${S.login}`, `Password=${pw}`, `Server=${S.server}`, 'NewsEnable=0',
    '[Experts]', 'Enabled=1', 'AllowLiveTrading=1', 'AllowDllImport=0', 'Account=0', 'Profile=0', 'WebRequest=1', `WebRequestUrl=${allowList()}`,
    '[StartUp]', ...(isPy() ? [] : [isCustom() ? `Expert=Imported\\${S.ea.name}` : 'Expert=KanairyEA']),
    ...(isPy() ? [] : isCustom() ? (S.ea.hasPreset ? [`ExpertParameters=${S.ea.name}.set`] : []) : ['ExpertParameters=kanairy.set']),
    `Symbol=${S.symbol}`, `Period=${S.tf}`, ''].join('\r\n');
  fs.writeFileSync(INI_FILE, ini, { mode: 0o600 });
  if (cfg.mt5DataDir) {
    const dir = path.join(cfg.mt5DataDir, 'MQL5', 'Presets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kanairy.set'), `InpToken=${cfg.eaToken}\r\nInpHost=${cfg.eaHost || '127.0.0.1'}\r\nInpPort=${cfg.eaPort}\r\nInpAllowLive=${cfg.allowLive ? 'true' : 'false'}\r\n`);
  }
  patchCommon();
  setTimeout(() => fs.unlink(INI_FILE, () => {}), 90000); // MT5 reads it at startup; remove the password afterwards
}

// Stop / detect this person's MT5 only. A private (portable) copy is matched by its path, so one person's stop never touches another's.
const psq = x => String(x).replace(/'/g, "''");
const psMatch = () => `Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -ieq '${psq(cfg.mt5Path)}' }`;
function killMt5(cb) {
  if (process.platform !== 'win32') { if (cb) cb(); return; }
  if (cfg.portable) execFile('powershell', ['-NoProfile', '-Command', `${psMatch()} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], () => { if (cb) cb(); });
  else execFile('taskkill', ['/IM', 'terminal64.exe', '/F'], () => { if (cb) cb(); });
}

async function launchMt5() {
  await autoSetup();
  if (!S.login || !S.server || !S.hasPw) return { ok: false, error: 'Save your broker login first.' };
  if (!cfg.mt5Path || !fs.existsSync(cfg.mt5Path)) return { ok: false, error: 'MT5 not found. Set mt5Path in config.json on the VPS.' };
  if (isCustom() && !isPy() && !fs.existsSync(path.join(cfg.mt5DataDir || '', 'MQL5', 'Experts', 'Imported', S.ea.name + '.ex5'))) return { ok: false, error: 'The imported EA is not compiled on the server. Import it again.' };
  L.stopped = false;
  writeStartFiles();
  // MT5 reopens its saved charts, EA included, and that keeps the old EA on the chart. Drop saved charts that hold the other EA so the startup file attaches the right one.
  const cleanCharts = () => {
    try {
      const dir = path.join(cfg.mt5DataDir || '', 'Profiles', 'Charts', 'Default');
      const drop = isCustom() ? /KanairyEA/i : /KanairyEA|Imported\\/i; // always re-attach Kanairy fresh, so it uses this person's own address and key, not inputs saved on an old chart
      for (const f of fs.readdirSync(dir)) if (/\.chr$/i.test(f) && drop.test(readText(path.join(dir, f)))) { fs.unlinkSync(path.join(dir, f)); log('Cleared saved chart', f); }
    } catch { /* no saved charts */ }
  };
  const start = () => {
    cleanCharts();
    const args = [...(cfg.portable ? ['/portable'] : []), '/config:' + INI_FILE];
    const child = process.platform === 'win32' ? spawn(cfg.mt5Path, args, { detached: true, stdio: 'ignore' }) : spawn('wine', [cfg.mt5Path, ...args], { detached: true, stdio: 'ignore' });
    child.on('error', e => log('MT5 launch failed:', e.message));
    child.unref();
    log('MT5 started');
    if (isPy()) { PY.want = true; setTimeout(startPy, 40000); } else stopPy();
    if (isCustom()) setTimeout(startMon, 45000);
    L.launchedAt = Date.now();
  };
  L.launchedAt = Date.now();
  if (process.platform === 'win32') killMt5(() => setTimeout(start, 2500));
  else start();
  addFeed('sys', 'MT5 restarting with your login');
  return { ok: true };
}

// ---------- one-click setup: find MT5, install and compile the EA, show the phone address ----------
const saveCfg = () => fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
function findMt5() {
  if (cfg.portable) return cfg.mt5Path && fs.existsSync(cfg.mt5Path) ? cfg.mt5Path : '';
  if (cfg.mt5Path && fs.existsSync(cfg.mt5Path)) return cfg.mt5Path;
  const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean));
  for (const r of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(r); } catch { continue; }
    for (const d of dirs) {
      if (!/meta\s*trader|mt5/i.test(d)) continue;
      const exe = path.join(r, d, 'terminal64.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return '';
}
function findDataDir(exe) {
  const base = path.join(process.env.APPDATA || '', 'MetaQuotes', 'Terminal');
  const want = path.dirname(exe).toLowerCase();
  let fallback = '';
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return ''; }
  for (const d of dirs) {
    const dir = path.join(base, d);
    if (!fs.existsSync(path.join(dir, 'MQL5'))) continue;
    try {
      const o = fs.readFileSync(path.join(dir, 'origin.txt'));
      const txt = (o[0] === 0xFF ? o.toString('utf16le') : o.toString('utf8')).replace(/^\uFEFF/, '').trim().toLowerCase();
      if (txt === want) return dir;
    } catch { /* no origin file */ }
    fallback = fallback || dir;
  }
  return fallback;
}
// MetaEditor for a private (portable) MT5 must run in portable mode and needs MQL5\\Include (Trade.mqh). A fresh copy has neither yet, so borrow the Include folder from the original MT5.
function meArgs(dst, logf) { return [...(cfg.portable ? ['/portable'] : []), '/compile:' + dst, '/log:' + logf]; }
function ensureIncludes() {
  try {
    if (!cfg.portable || !cfg.mt5DataDir) return;
    const mine = path.join(cfg.mt5DataDir, 'MQL5', 'Include');
    if (fs.existsSync(path.join(mine, 'Trade', 'Trade.mqh'))) return;
    const srcExe = cfg.mt5Source ? path.join(cfg.mt5Source, 'terminal64.exe') : '';
    const from = srcExe && fs.existsSync(srcExe) ? findDataDir(srcExe) : '';
    const inc = from ? path.join(from, 'MQL5', 'Include') : '';
    if (inc && fs.existsSync(inc)) { fs.cpSync(inc, mine, { recursive: true }); log('Copied the MQL5 Include folder for the EA build.'); }
    else log('MQL5 Include folder not found. Open the original MetaTrader 5 once, then press Launch MT5 again.');
  } catch (e) { log('Include copy problem:', e.message); }
}
const compileErrors = f => { try { return readText(f).split(/\r?\n/).filter(l => /error/i.test(l) && !/Result:/i.test(l)).slice(0, 3).join(' | '); } catch { return ''; } };
let compiling = null;
function autoSetup() {
  if (compiling) return compiling;
  return new Promise(done => {
    try {
      const exe = findMt5();
      if (!exe) { log('MT5 not found. Install MetaTrader 5, open it once, then restart this server.'); return done(); }
      let changed = false;
      if (cfg.mt5Path !== exe) { cfg.mt5Path = exe; changed = true; }
      if (!cfg.mt5DataDir || !fs.existsSync(cfg.mt5DataDir)) { cfg.mt5DataDir = cfg.portable ? path.dirname(exe) : findDataDir(exe); changed = !!cfg.mt5DataDir || changed; }
      if (changed) saveCfg();
      if (!cfg.mt5DataDir) { log('MT5 data folder not found. Open MT5 once, close it, then restart this server.'); return done(); }
      log('MT5 found:', exe);
      const src = path.join(DIR, '..', 'mt5', 'KanairyEA.mq5');
      if (!fs.existsSync(src)) { log('KanairyEA.mq5 not found next to the vps folder. Keep the mt5 folder beside vps.'); return done(); }
      const dstDir = path.join(cfg.mt5DataDir, 'MQL5', 'Experts');
      fs.mkdirSync(dstDir, { recursive: true });
      const dst = path.join(dstDir, 'KanairyEA.mq5'), ex5 = path.join(dstDir, 'KanairyEA.ex5');
      const need = !fs.existsSync(dst) || fs.readFileSync(src, 'utf8') !== fs.readFileSync(dst, 'utf8');
      if (need) fs.copyFileSync(src, dst);
      const stale = !fs.existsSync(ex5) || fs.statSync(ex5).mtimeMs < fs.statSync(dst).mtimeMs;
      if (!need && !stale) { log('EA already installed.'); return done(); }
      const me = path.join(path.dirname(exe), 'MetaEditor64.exe');
      if (!fs.existsSync(me)) { log('MetaEditor not found. Open MT5, press F4, open KanairyEA and press F7 to compile it.'); return done(); }
      const t0 = Date.now() - 2000;
      ensureIncludes();
      const clog = path.join(DATA, 'compile.log');
      compiling = new Promise(r => execFile(me, meArgs(dst, clog), () => {
        const okNow = fs.existsSync(ex5) && fs.statSync(ex5).mtimeMs >= t0;
        log(okNow ? 'EA installed and compiled.' : 'EA compile failed. ' + (compileErrors(clog) || 'See data\\compile.log'));
        compiling = null; r(); done();
      }));
    } catch (e) { log('Auto setup problem:', e.message); done(); }
  });
}
// ---------- import your own .mq5 EA: the phone sends the source, this server compiles it and runs it inside MT5 ----------
const TFS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M10', 'M12', 'M15', 'M20', 'M30', 'H1', 'H2', 'H3', 'H4', 'H6', 'H8', 'H12', 'D1', 'W1', 'MN1'];
const cleanName = n => String(n || '').replace(/\.(mq5|ex5|py|set)$/i, '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'ImportedEA';
const readText = f => { try { const b = fs.readFileSync(f); const u16 = (b[0] === 0xFF && b[1] === 0xFE) || (b.length > 3 && b[0] !== 0 && b[1] === 0 && b[3] === 0); return (u16 ? b.toString('utf16le') : b.toString('utf8')).replace(/^﻿/, ''); } catch { return ''; } };
const eaFail = msg => { S.ea.state = 'failed'; S.ea.log = String(msg).slice(0, 700); save(); addFeed('sys', 'EA import failed'); };

async function importEa(name, source, lang) {
  if (lang === 'py') return importPy(name, source);
  const sv = importSrv(name, source); if (sv) return sv;
  if (S.ea.state === 'compiling') return { ok: false, error: 'Still compiling the last file. Wait a moment.' };
  if (typeof source !== 'string' || source.length < 100) return { ok: false, error: 'That file is empty or too small to be an EA.' };
  if (source.length > 1.5e6) return { ok: false, error: 'That file is too large (limit 1.5 MB).' };
  if (source.includes('\u0000') || source.includes('�')) return { ok: false, error: 'That file is not plain MQL5 text. Import the .mq5 source, not a compiled .ex5.' };
  if (!/\bOn(Init|Tick|Timer|Trade|ChartEvent)\s*\(/.test(source)) return { ok: false, error: 'This does not look like an expert advisor (no OnTick or OnInit found).' };
  if (/#import\s+"[^"]*\.dll"/i.test(source)) return { ok: false, error: 'This EA imports a DLL. Kanairy keeps DLLs off on your server for safety, so it cannot run here.' };
  await autoSetup();
  if (!cfg.mt5DataDir) return { ok: false, error: 'MT5 was not found on the server. Open MT5 once on the VPS first.' };
  const me = path.join(path.dirname(cfg.mt5Path || ''), 'MetaEditor64.exe');
  if (!fs.existsSync(me)) return { ok: false, error: 'MetaEditor was not found next to MT5, so the server cannot compile.' };
  const nm = cleanName(name), dir = path.join(cfg.mt5DataDir, 'MQL5', 'Experts', 'Imported');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, nm + '.mq5'), ex5 = path.join(dir, nm + '.ex5'), logf = path.join(DATA, 'ea-compile.log');
  fs.writeFileSync(dst, '﻿' + source, 'utf8');
  try { fs.unlinkSync(ex5); } catch { /* none yet */ }
  try { fs.unlinkSync(logf); } catch { /* none yet */ }
  if (S.ea.name !== nm) { S.ea.hasPreset = false; S.ea.values = {}; }
  S.ea.engine = ''; S.ea.lang = 'mq5'; S.ea.inputs = parseInputs(source);
  { const keep = {}; for (const i of S.ea.inputs) if ((S.ea.values || {})[i.name] !== undefined) keep[i.name] = S.ea.values[i.name]; S.ea.values = keep; }
  S.ea.name = nm; S.ea.state = 'compiling'; S.ea.log = ''; save();
  addFeed('sys', `Compiling imported EA ${nm}`);
  ensureIncludes();
  execFile(me, meArgs(dst, logf), { timeout: 120000 }, () => {
    const out = readText(logf), m = /Result:\s*(\d+)\s*errors?,\s*(\d+)\s*warnings?/i.exec(out);
    const errors = m ? +m[1] : (fs.existsSync(ex5) ? 0 : 1);
    if (fs.existsSync(ex5) && errors === 0) {
      S.ea.state = 'ok'; S.ea.log = m ? `Compiled with ${m[2]} warnings.` : 'Compiled.'; save(); addFeed('sys', `EA ${nm} compiled`); log('Imported EA compiled:', nm);
    } else {
      const lines = out.split(/\r?\n/).filter(l => /error/i.test(l) && !/Result:/i.test(l)).map(l => l.replace(/^[A-Za-z]:\\[^ ]*?\.mq5/i, '').trim()).slice(0, 6);
      eaFail(lines.length ? lines.join('\n') : 'Compile failed. See data\\ea-compile.log on the server.');
    }
  });
  return { ok: true, name: nm, state: 'compiling' };
}

// ---------- Python bots: no compile. The server keeps the script, patches the chosen settings in and runs it next to MT5 ----------
const BOTS = path.join(DATA, 'bots');
// ---------- cost tracking + spread guard: kmonitor.py (any bot) and kguard.py (Python bots) ----------
const MON = { child: null };
function writeFilter() { try { fs.writeFileSync(path.join(DATA, 'filter.json'), JSON.stringify(S.filter)); } catch { /* data dir missing */ } }
function setFilter(f) {
  f = f && typeof f === 'object' ? f : {};
  const ms = f.maxSpread === undefined ? S.filter.maxSpread : Number(f.maxSpread);
  if (!(ms >= 0 && ms <= 20)) return { ok: false, error: 'Max spread must be a number from 0 to 20 dollars. 0 means off.' };
  const w = f.windows === undefined ? S.filter.windows : String(f.windows).trim();
  if (w && !/^\d{2}:\d{2}-\d{2}:\d{2}(\s*,\s*\d{2}:\d{2}-\d{2}:\d{2})*$/.test(w)) return { ok: false, error: 'Pause windows look like 21:55-23:05 (UTC). Separate several with commas.' };
  S.filter = { on: f.on === undefined ? S.filter.on : !!f.on, maxSpread: ms, windows: w };
  writeFilter(); save(); addFeed('sys', 'Spread guard saved'); return { ok: true };
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return null; } };
function monStatus() {
  const m = readJson('monitor.json'), up = !!(m && m.up && Date.now() / 1000 - m.at < 15);
  let blocked = 0; try { blocked = fs.readFileSync(path.join(DATA, 'guard.log'), 'utf8').split('\n').filter(Boolean).length; } catch { /* none */ }
  return { up, spread: up ? m.spread : null, ok: up ? m.ok !== false : true, reason: up ? (m.reason || '') : '', err: m && m.err ? String(m.err).slice(0, 160) : '', blocked };
}
let costCache = { mt: 0, v: null };
function costStats() {
  const f = path.join(DATA, 'costs.jsonl');
  try {
    const st = fs.statSync(f); if (st.mtimeMs === costCache.mt && costCache.v) return costCache.v;
    const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-4000).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const ins = rows.filter(r => r.entry === 0), n = ins.length;
    if (!n) return (costCache = { mt: st.mtimeMs, v: { n: 0 } }).v;
    const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    const spread = avg(ins.map(r => r.spread)), slipIn = avg(ins.map(r => r.slip)), outs = rows.filter(r => r.entry === 1), slipOut = outs.length ? avg(outs.map(r => r.slip)) : 0;
    const vol = avg(rows.map(r => r.vol)) || 0.01, comm = rows.reduce((x, r) => x + Math.abs(r.comm || 0), 0) / n / (vol * 100);
    const all = spread + Math.max(slipIn, -spread) + slipOut + comm, r2 = x => Math.round(x * 100) / 100;
    const v = { n, spread: r2(spread), slipIn: r2(slipIn), slipOut: r2(slipOut), comm: r2(comm), all: r2(all), warn: all > 0.45 ? 'red' : all > 0.35 ? 'amber' : '' };
    return (costCache = { mt: st.mtimeMs, v }).v;
  } catch { return { n: 0 }; }
}
function startMon() {
  if (MON.child && MON.child.exitCode === null) return;
  try {
    writeFilter();
    const env = { ...process.env, KANAIRY_DATA: DATA, KANAIRY_SYMBOL: S.symbol, PYTHONUNBUFFERED: '1' };
    const c = spawn(pyExe(), ['-u', path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'kmonitor.py')], { cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), env, stdio: 'ignore', windowsHide: true });
    MON.child = c; c.on('error', e => log('Monitor could not start:', e.message)); c.on('exit', () => { if (MON.child === c) MON.child = null; });
  } catch (e) { log('Monitor could not start:', e.message); }
}
function stopMon() { if (MON.child && MON.child.exitCode === null) { try { MON.child.kill(); } catch { /* gone */ } } }
const PY = { child: null, want: false, tail: '' };
const pyExe = () => cfg.pythonPath || (process.platform === 'win32' ? 'python' : 'python3');
function stopPy() { PY.want = false; if (PY.child && PY.child.exitCode === null) { try { PY.child.kill(); } catch { /* gone */ } } }
function startPy() {
  if (!isPy() || !PY.want) return;
  if (PY.child && PY.child.exitCode === null) return;
  const w = writePreset(); if (!w.ok) { S.ea.log = w.error; save(); return; }
  const run = path.join(BOTS, S.ea.name + '.run.py');
  const env = { ...process.env, KANAIRY_SYMBOL: S.symbol, KANAIRY_LOGIN: String(S.login), KANAIRY_SERVER: S.server, PYTHONUNBUFFERED: '1' };
  PY.tail = '';
  const env2 = { ...env, KANAIRY_DATA: DATA };
  const krun = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'krun.py');
  const child = spawn(pyExe(), ['-u', krun, run], { cwd: BOTS, env: env2, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  PY.child = child;
  const eat = d => { PY.tail = (PY.tail + String(d)).slice(-600); S.ea.log = PY.tail.trim().split(/\r?\n/).slice(-6).join('\n'); };
  child.stdout.on('data', eat); child.stderr.on('data', eat);
  child.on('error', e => { S.ea.log = 'Could not start Python (' + e.message + '). Install Python on the VPS, or set pythonPath in config.json.'; PY.want = false; save(); });
  child.on('exit', code => { addFeed('sys', `Python bot stopped (code ${code})`); save(); if (PY.want && PY.child === child) setTimeout(startPy, 15000); });
  addFeed('sys', `Python bot ${S.ea.name} started`); log('Python bot started:', S.ea.name);
}
async function importPy(name, source) {
  if (typeof source !== 'string' || source.length < 20) return { ok: false, error: 'That file is empty or too small to be a bot.' };
  if (source.length > 1.5e6) return { ok: false, error: 'That file is too large (limit 1.5 MB).' };
  if (source.includes('\u0000')) return { ok: false, error: 'That is not a Python text file.' };
  const nm = cleanName(name);
  fs.mkdirSync(BOTS, { recursive: true });
  stopPy();
  fs.writeFileSync(path.join(BOTS, nm + '.py'), source, 'utf8');
  if (S.ea.name !== nm || S.ea.lang !== 'py') { S.ea.hasPreset = false; S.ea.values = {}; }
  S.ea.engine = ''; S.ea.lang = 'py'; S.ea.inputs = parsePyInputs(source);
  { const keep = {}; for (const i of S.ea.inputs) if ((S.ea.values || {})[i.name] !== undefined) keep[i.name] = S.ea.values[i.name]; S.ea.values = keep; }
  S.ea.name = nm; S.ea.state = 'ok';
  S.ea.log = /MetaTrader5/.test(source) ? 'Python bot ready. It needs "pip install MetaTrader5" on the VPS.' : 'Python bot ready. This script does not import MetaTrader5, so it cannot place MT5 trades by itself.';
  const w = writePreset(); if (!w.ok) return w;
  save(); addFeed('sys', `Python bot ${nm} added`);
  return { ok: true, name: nm, state: 'ok', lang: 'py', inputs: S.ea.inputs.length };
}

// A compiled .ex5 is not compiled again, only copied into MT5. Kanairy cannot see inside it, so DLLs stay off and it runs only as MT5 allows.
async function importEx5(name, b64) {
  if (S.ea.state === 'compiling') return { ok: false, error: 'Still compiling the last file. Wait a moment.' };
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (buf.length < 1024) return { ok: false, error: 'That file is empty or too small to be an EA.' };
  if (buf.length > 2e6) return { ok: false, error: 'That file is too large (limit 2 MB).' };
  const head = buf.subarray(0, 4).toString('latin1');
  if (head.startsWith('MZ') || head.startsWith('PK') || head.startsWith('<') || head.startsWith('\u007fELF')) return { ok: false, error: 'That is not an .ex5 file (it looks like a program, zip or web page). Unzip it and pick the .ex5 inside.' };
  await autoSetup();
  if (!cfg.mt5DataDir) return { ok: false, error: 'MT5 was not found on the server. Open MT5 once on the VPS first.' };
  const nm = cleanName(name), dir = path.join(cfg.mt5DataDir, 'MQL5', 'Experts', 'Imported');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, nm + '.ex5'), buf);
  try { fs.unlinkSync(path.join(dir, nm + '.mq5')); } catch { /* none */ }
  if (S.ea.name !== nm) { S.ea.hasPreset = false; S.ea.values = {}; }
  S.ea.engine = ''; S.ea.lang = 'mq5'; S.ea.inputs = []; // Kanairy cannot read the inputs of a compiled .ex5; a .set file still works
  S.ea.name = nm; S.ea.state = 'ok'; S.ea.log = 'Compiled file copied to MT5. Kanairy cannot check what is inside it, and DLLs stay off.'; save();
  addFeed('sys', `EA ${nm} (.ex5) added`);
  return { ok: true, name: nm, state: 'ok' };
}

// Write the current settings to MT5's Presets folder as <EA name>.set (UTF-16, as MT5 expects).
function writePreset() {
  if (S.ea.lang === 'py') {
    try {
      fs.mkdirSync(BOTS, { recursive: true });
      fs.writeFileSync(path.join(BOTS, S.ea.name + '.run.py'), patchPySource(fs.readFileSync(path.join(BOTS, S.ea.name + '.py'), 'utf8'), S.ea.inputs || [], S.ea.values || {}), 'utf8');
      S.ea.hasPreset = true; save(); return { ok: true };
    } catch (e) { return { ok: false, error: 'Could not write the bot: ' + e.message }; }
  }
  if (!cfg.mt5DataDir) return { ok: false, error: 'MT5 data folder not found on the server.' };
  const dir = path.join(cfg.mt5DataDir, 'MQL5', 'Presets');
  fs.mkdirSync(dir, { recursive: true });
  const text = renderSet(S.ea.inputs, S.ea.values);
  fs.writeFileSync(path.join(dir, S.ea.name + '.set'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]));
  S.ea.hasPreset = true; save();
  return { ok: true };
}
// A .set file picked in the app: only inputs that exist in the EA and hold a valid value are applied.
function importPreset(text) {
  if (S.ea.engine === 'server' && S.ea.name) return setSrvValues(parseSet(String(text || '')), true);
  if (!S.ea.name) return { ok: false, error: 'Import the EA file first.' };
  if (typeof text !== 'string' || text.length > 2e5) return { ok: false, error: 'That does not look like an MT5 .set settings file.' };
  const set = parseSet(text);
  if (!Object.keys(set).length) return { ok: false, error: 'That does not look like an MT5 .set settings file.' };
  let applied = [], rejected = [];
  if (S.ea.inputs && S.ea.inputs.length) {
    const r = applyValues(S.ea.inputs, S.ea.values || {}, set);
    if (!r.applied.length) return { ok: false, error: 'None of the settings in that file match this EA. Check you picked the .set for the same EA.' };
    S.ea.values = r.values; applied = r.applied; rejected = r.rejected;
  } else { S.ea.values = { ...(S.ea.values || {}), ...set }; applied = Object.keys(set); }   // a compiled .ex5: names unknown, trust the file
  const w = writePreset(); if (!w.ok) return w;
  addFeed('sys', `EA settings loaded (${applied.length} values)`);
  return { ok: true, applied: applied.length, rejected: rejected.slice(0, 8) };
}
// Settings edited one by one in the app.
function setEaValues(vals) {
  if (S.ea.engine === 'server') return setSrvValues(vals);
  if (!S.ea.name || !S.ea.inputs || !S.ea.inputs.length) return { ok: false, error: 'Import the .mq5 file first. Inputs are read from the source.' };
  const r = applyValues(S.ea.inputs, S.ea.values || {}, vals && typeof vals === 'object' ? vals : {});
  if (r.rejected.length) return { ok: false, error: 'Not a valid value for: ' + r.rejected.slice(0, 4).join(', ') };
  S.ea.values = r.values;
  const w = writePreset(); if (!w.ok) return w;
  addFeed('sys', 'EA settings saved');
  return { ok: true, applied: r.applied.length };
}

// ---------- server-run MQL5 bots (paste the code, no compiling) ----------
const SV = { host: null, vm: null, last: '', tickAt: 0, ticks: 0, timerAt: 0, err: '' };
const srvFile = nm => path.join(BOTS, nm + '.mq5');
const tfName = n => Object.keys(TF).find(k => TF[k] === n) || 'M1';
function importSrv(name, source) {
  if (typeof source !== 'string' || source.length < 60) return null;
  if (source.length > 1.5e6) return { ok: false, error: 'That file is too large (limit 1.5 MB).' };
  if (source.includes('\u0000')) return null;
  if (/#import\s+"[^"]*\.dll"/i.test(source)) return { ok: false, error: 'This EA imports a DLL. Kanairy cannot run DLLs, so it cannot run here.' };
  let vm, defs;
  try { vm = createVM(source, new LiveHost()); defs = vm.defaults(); } catch (e) { return { ok: false, error: 'Could not read this code: ' + (e.message || e) }; }
  if (!vm.has('OnTick') && !vm.has('OnTimer')) return { ok: false, error: 'This does not look like an expert advisor (no OnTick found).' };
  const nm = cleanName(name);
  if (vm.unsupported && vm.unsupported.length) return { ok: false, error: 'This bot uses things the server cannot run yet: ' + vm.unsupported.slice(0, 5).join('; ') };
  srvStop(); stopPy();
  fs.mkdirSync(BOTS, { recursive: true });
  fs.writeFileSync(srvFile(nm), source, 'utf8');
  if (S.ea.name !== nm || S.ea.engine !== 'server') { S.ea.values = {}; }
  S.ea.engine = 'server'; S.ea.lang = 'mq5'; S.ea.name = nm; S.ea.state = 'ok'; S.ea.hasPreset = false;
  S.ea.inputs = defs.map(i => ({ name: i.name, n: i.name, type: i.type, kind: i.kind, def: i.def, comment: i.comment }));
  { const keep = {}; for (const i of S.ea.inputs) if ((S.ea.values || {})[i.name] !== undefined) keep[i.name] = S.ea.values[i.name]; S.ea.values = keep; }
  S.ea.mode = 'custom'; L.running = false; L.lastBarT = 0;
  S.ea.log = 'Read by the server. It runs here, no compiling.' + (vm.warnings.length ? ' Note: ' + vm.warnings.slice(0, 2).join('; ') : '');
  save(); addFeed('sys', `Bot ${nm} loaded (runs on the server)`);
  return { ok: true, name: nm, state: 'ok', lang: 'mq5', engine: 'server', inputs: S.ea.inputs.length };
}
function setSrvValues(vals, fromSet) {
  const inputs = S.ea.inputs || [], vv = { ...(S.ea.values || {}) }; let n = 0; const bad = [];
  for (const [k, v] of Object.entries(vals && typeof vals === 'object' ? vals : {})) {
    const i = inputs.find(x => x.name === k); if (!i) continue;
    const t = String(v).trim().replace(/\|.*$/, '');
    let ok = true;
    if (i.kind === 'bool') ok = /^(true|false|0|1)$/i.test(t); else if (i.kind === 'int' || i.kind === 'num') ok = t !== '' && (Number.isFinite(Number(t)) || (!/^(char|uchar|short|ushort|int|uint|long|ulong|double|float|datetime|color)$/.test(i.type || '') && /^[A-Za-z_]\w*$/.test(t)));
    if (!ok) { bad.push(k); continue; }
    vv[k] = t; n++;
  }
  if (fromSet && !n) return { ok: false, error: 'None of the settings in that file match this bot.' };
  if (bad.length && !fromSet) return { ok: false, error: 'Not a valid value for: ' + bad.slice(0, 4).join(', ') };
  S.ea.values = vv; S.ea.hasPreset = true; save(); addFeed('sys', 'Bot settings saved');
  if (L.running && isSrv()) { srvStop(); srvStart(); }   // new settings take effect by restarting the bot
  return { ok: true, applied: n, rejected: bad.slice(0, 8) };
}
function srvInfo() { return { ticks: SV.ticks, halted: !!(SV.vm && SV.vm.halted), error: SV.vm ? SV.vm.error : '', log: SV.host ? SV.host.lastLog.slice(-8) : [], warn: SV.vm ? SV.vm.warnings.slice(0, 3) : [] }; }
function srvStop() {
  if (SV.vm) { try { SV.vm.deinit(0); } catch { /* ignore */ } }
  SV.vm = null; SV.host = null; SV.ticks = 0;
}
function srvStart() {
  srvStop();
  if (!isSrv()) return;
  let src; try { src = fs.readFileSync(srvFile(S.ea.name), 'utf8'); } catch { L.err = 'The bot file is missing. Import it again.'; return; }
  try {
    const host = new LiveHost(); host.symbol = S.symbol || 'XAUUSD'; host.periodSec = TF_SEC[TF[S.tf]] || 60; host.periodCode = TF[S.tf] || 1;
    const vm = createVM(src, host); vm.reset();
    for (const [k, v] of Object.entries(S.ea.values || {})) vm.setInput(k, v);
    SV.host = host; SV.vm = vm; SV.last = ''; SV.timerAt = 0; SV.initDone = false;
  } catch (e) { L.err = 'Could not start the bot: ' + (e.message || e); SV.vm = null; }
}
function srvSync(r, out) {
  if (!SV.host) { if (L.running) srvStart(); if (!SV.host) return; }
  const host = SV.host, vm = SV.vm;
  const tfn = String(r.tf || S.tf), tfSec = TF_SEC[TF[tfn]] || host.periodSec;
  host.periodCode = TF[tfn] || host.periodCode;
  host.ingest(r, tfSec);
  if (!L.running) return;
  if (!SV.initDone) {
    if (!host.nClosed) { out.want = true; return; }   // wait for candles first
    SV.initDone = true; vm.init();
    if (vm.halted) { L.err = 'Bot stopped at start: ' + vm.error; return; }
  }
  if (L.lastBarT === 0) { out.want = true; L.lastBarT = 1; }
  if (vm.halted) { L.err = 'Bot stopped: ' + vm.error; return; }
  const sig = host.bid + '|' + host.ask + '|' + host.nClosed + '|' + host.pos.length;
  if (sig !== SV.last) { SV.last = sig; const t0 = Date.now(); vm.tick(); SV.ticks++; SV.tickAt = Date.now(); if (Date.now() - t0 > 1500) L.err = 'This bot is slow (' + (Date.now() - t0) + ' ms per tick).'; else if (L.err && !vm.halted) L.err = ''; }
  if (vm.timer > 0 && Date.now() - SV.timerAt >= vm.timer * 1000) { SV.timerAt = Date.now(); vm.timerTick(); }
  L.evalAt = Date.now();
  for (const c of host.takeCmds()) out.cmds.push(c);
  if (vm.halted) { L.err = 'Bot stopped: ' + vm.error; addFeed('sys', 'Bot stopped itself: ' + vm.error); }
}


function setEaMode(mode, tf) {
  if (tf !== undefined && tf !== '') { if (!TFS.includes(String(tf))) return { ok: false, error: 'Unknown timeframe.' }; S.tf = String(tf); }
  if (mode === 'custom') {
    if (S.ea.state !== 'ok' || !S.ea.name) return { ok: false, error: 'Paste or import an .mq5 file first.' };
    S.ea.mode = 'custom'; L.running = false; if (S.ea.engine !== 'server') L.lastSync = 0; srvStop();
  } else { srvStop(); S.ea.mode = 'kanairy'; if (S.strategy && S.strategy.timeframe && (tf === undefined || tf === '')) S.tf = S.strategy.timeframe; }
  L.lastBarT = 0; save();
  addFeed('sys', S.ea.mode === 'custom' ? `Mode: imported EA ${S.ea.name} (trades by itself)` : 'Mode: Kanairy strategy');
  return { ok: true, mode: S.ea.mode, tf: S.tf };
}

async function showAddress() {
  let ip = '';
  try { ip = (await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(4000) })).text()).trim(); } catch { /* offline */ }
  console.log('\n  Kanairy server is running.');
  console.log(`  Phone address:  http://${ip || '<your VPS public IP>'}:${cfg.appPort}`);
  console.log(`  App key:        ${cfg.appKey}`);
  console.log(`\n  Also open TCP port ${cfg.appPort} in your VPS provider's firewall (security group).\n`);
}

// ---------- trade signals (pasted in the app, or collected from a channel) ----------
const pubSig = e => ({ id: e.id, t: e.t, from: e.from, status: e.status, note: e.note || '', sig: e.sig });
function ingestSignal(text, from = 'paste') {
  if (S.sig.mode === 'off') return { ok: false, error: 'Signals are switched off. Choose Ask first or Auto in the app.' };
  const t = String(text || '').trim(), key = crypto.createHash('sha1').update(t).digest('hex');
  if (S.sig.list.some(x => x.key === key && Date.now() - x.t < 6 * 3600e3)) return { ok: false, error: 'You already have this signal.' };
  const sig = parseSignal(t);
  if (!sig.ok) return { ok: false, error: sig.reason };
  const auto = S.sig.mode === 'auto';
  const e = { id: crypto.randomBytes(4).toString('hex'), t: Date.now(), key, from, text: t.slice(0, 500), sig, status: auto ? 'queued' : 'pending', note: '', until: auto ? Date.now() + 10 * 60000 : 0 };
  S.sig.list.unshift(e); S.sig.list = S.sig.list.slice(0, 40); save();
  addFeed('signal', `Signal: ${sig.side.toUpperCase()} ${sig.lo}${sig.hi !== sig.lo ? '-' + sig.hi : ''}, SL ${sig.sl}, TP ${sig.tps.join('/')}` + (auto ? '' : ' (waiting for you)'));
  return { ok: true, entry: pubSig(e) };
}
// Runs on every EA sync while the bot is started. Applies the same guard rails as the strategy, then sends market orders (one per take profit).
function runSignals(cmds) {
  const now = Date.now();
  for (const e of S.sig.list) {
    if (e.status === 'pending' && now - e.t > 30 * 60000) { e.status = 'skipped'; e.note = 'Expired before you answered'; save(); continue; }
    if (e.status !== 'queued') continue;
    const skip = why => { e.status = 'skipped'; e.note = why; save(); };
    if (now > e.until) { skip(e.note || 'Price did not reach the entry zone in time'); continue; }
    if (!String(S.symbol || '').toUpperCase().startsWith('XAU')) { skip('This signal is for gold but the app trades ' + S.symbol); continue; }
    if (g('hub_daily_loss') > 0 && S.dayPnl <= -g('hub_daily_loss')) { skip('Daily loss limit reached'); continue; }
    if (g('hub_max_spread') > 0 && L.spread > g('hub_max_spread')) { e.note = 'Spread too wide, waiting'; continue; }
    if (!L.hedge && L.pos.some(p => p[1] === (e.sig.side === 'buy' ? 1 : 0))) { skip('An opposite trade is open and hedging is off'); continue; }
    const room = Math.min(g('hub_max_open') - L.pos.length, g('hub_max_day') - S.dayTrades);
    if (room <= 0) { e.note = 'Open-trade limit reached, waiting'; continue; }
    const p = planOrders(e.sig, { bid: L.bid, ask: L.ask }, { maxOrders: room });
    if (!p.ok) { e.note = p.reason; if (!p.wait) skip(p.reason); continue; }
    const lots = g('hub_lot') > 0 ? g('hub_lot') : (S.sig.lots || 0.01);
    for (const o of p.orders) cmds.push({ a: e.sig.side, lots, sl: o.sl, tp: o.tp });
    e.status = 'done'; e.note = `Sent ${p.orders.length} order${p.orders.length > 1 ? 's' : ''} at ${e.sig.side === 'buy' ? L.ask : L.bid}`;
    S.dayTrades += p.orders.length; L.lastEntryMs = now; save();
    addFeed('signal', `${e.sig.side.toUpperCase()} signal x${p.orders.length} @ ${lots} lots`, e.sig.side, lots);
  }
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
    if (u === '/api/signals') return send(res, 200, { mode: S.sig.mode, lots: S.sig.lots, both: !!S.sig.both, list: S.sig.list.slice(0, 15).map(pubSig) });
    if (u === '/api/strategy' && req.method === 'GET') return send(res, 200, { strategy: S.strategy, rev: S.rev });
    if (u === '/api/strategy') { S.strategy = j.strategy || null; S.rev++; if (S.strategy && S.strategy.timeframe) S.tf = S.strategy.timeframe; L.lastBarT = 0; save(); addFeed('sys', S.strategy ? 'Strategy loaded: ' + S.strategy.name : 'Strategy cleared'); return send(res, 200, { ok: true, rev: S.rev }); }
    if (u === '/api/cfg') { if (!GUARD_KEYS.includes(j.key) || !(Number(j.value) >= 0)) return send(res, 400, { error: 'bad value' }); S.guards[j.key] = Number(j.value); save(); return send(res, 200, { ok: true }); }
    if (u === '/api/run') { setRunning(j.on); if (isSrv()) { if (j.on) srvStart(); else srvStop(); } return send(res, 200, { ok: true }); }
    if (u === '/api/kill') {
      L.running = false; srvStop();
      if (isCustom()) { stopPy(); L.stopped = true; L.mt5Up = false; killMt5(); addFeed('sys', 'Stopped MT5 so the imported EA cannot trade. Open trades stay open with their broker stops.'); }
      else { L.killPending = true; addFeed('sys', 'Kill switch: closing all trades'); }
      return send(res, 200, { ok: true });
    }
    if (u === '/api/ea/import') return send(res, 200, j.ex5 ? await importEx5(j.name, j.ex5) : await importEa(j.name, j.source, j.lang));
    if (u === '/api/filter') return send(res, 200, setFilter(j));
    if (u === '/api/ea/stop') { srvStop(); L.running = false; if (S.ea.engine === 'server') { addFeed('sys', 'Bot stopped'); return send(res, 200, { ok: true }); } stopPy(); stopMon(); L.stopped = true; if (!isPy()) killMt5(); addFeed('sys', 'Bot stopped'); return send(res, 200, { ok: true }); }
    if (u === '/api/ea/preset') return send(res, 200, importPreset(j.text));
    if (u === '/api/ea/values') return send(res, 200, setEaValues(j.values));
    if (u === '/api/ea/mode') return send(res, 200, setEaMode(j.mode, j.tf));
    if (u === '/api/signal') return send(res, 200, ingestSignal(j.text, 'paste'));
    if (u === '/api/signal/mode') {
      if (['off', 'ask', 'auto'].includes(j.mode)) S.sig.mode = j.mode;
      if (j.lots !== undefined) S.sig.lots = Math.max(0.01, Math.min(1, +j.lots || 0.01));
      if (j.both !== undefined) S.sig.both = !!j.both;
      save(); return send(res, 200, { ok: true, mode: S.sig.mode, lots: S.sig.lots, both: S.sig.both });
    }
    if (u === '/api/signal/act') {
      const e = S.sig.list.find(x => x.id === j.id);
      if (!e) return send(res, 200, { ok: false, error: 'Signal not found' });
      if (e.status === 'pending' && j.do === 'approve') { e.status = 'queued'; e.until = Date.now() + 10 * 60000; e.note = L.running ? '' : 'Start the bot so it can place the trades'; }
      else if (['pending', 'queued'].includes(e.status) && j.do === 'skip') { e.status = 'skipped'; e.note = 'Skipped by you'; }
      save(); return send(res, 200, { ok: true });
    }
    if (u === '/api/login') {
      S.login = String(j.login || '').trim(); S.server = String(j.server || '').trim();
      S.symbol = String(j.symbol || S.symbol || 'XAUUSD').toUpperCase().replace(/[^A-Z0-9._]/g, '');
      if (j.tf) S.tf = String(j.tf);
      if (j.password) { putSecret(String(j.password)); S.hasPw = true; }
      if (j.clear) { S.login = ''; S.server = ''; S.hasPw = false; try { fs.unlinkSync(SECRET_FILE); } catch { /* none */ } }
      save(); return send(res, 200, { ok: true });
    }
    if (u === '/api/launch') return send(res, 200, await launchMt5());
    return send(res, 404, { error: 'unknown' });
  } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
});

// ---------- EA listener (this machine only) ----------
const eaServer = http.createServer(async (req, res) => {
  try {
    const tok = String(req.headers['x-token'] || '');
    const a = Buffer.from(tok), b = Buffer.from(cfg.eaToken);
    const body = await readBody(req);
    L.eaSeen = Date.now();
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { if (!L.badToken || Date.now() - L.badToken > 30000) log('EA called with a wrong token. Tap Launch MT5 in the app.'); L.badToken = Date.now(); return send(res, 401, { error: 'bad token' }); }
    if (req.url.startsWith('/ping')) return send(res, 200, { ok: true });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const j = JSON.parse(body || '{}');
    if (req.url.startsWith('/sync')) return send(res, 200, sync(j));
    if (req.url.startsWith('/event')) { eaEvent(j); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'unknown' });
  } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
});

appServer.listen(cfg.appPort, cfg.appHost || '0.0.0.0', () => log(`App API on port ${cfg.appPort}`));
eaServer.on('error', e => log(e.code === 'EADDRINUSE' ? `EA bridge: port ${cfg.eaPort} is used by another program (for example IIS or a web server). Stop it, then restart Kanairy server.` : 'EA bridge error: ' + e.message));
eaServer.listen(cfg.eaPort, cfg.eaHost || '127.0.0.1', () => log(`EA bridge on ${cfg.eaHost || '127.0.0.1'}:${cfg.eaPort}`));
// The first account also answers on plain 127.0.0.1, so an EA compiled before the per-person addresses existed still connects.
if (cfg.eaHost === '127.0.1.1') {
  const alt = http.createServer((q, r) => eaServer.emit('request', q, r));
  alt.on('error', () => { /* port taken: the private address still works */ });
  alt.listen(cfg.eaPort, '127.0.0.1', () => log('EA bridge also on 127.0.0.1:' + cfg.eaPort));
}
autoSetup();
if (!cfg.quiet) showAddress();

// ---------- keep MT5 and the EA alive ----------
function checkMt5() {
  if (process.platform !== 'win32') { L.mt5Up = !L.stopped; return; }
  if (cfg.portable) { execFile('powershell', ['-NoProfile', '-Command', `(${psMatch()} | Measure-Object).Count`], (err, out) => { L.mt5Up = !err && Number(String(out).trim()) > 0; }); return; }
  execFile('tasklist', ['/FI', 'IMAGENAME eq terminal64.exe', '/NH'], (err, out) => { L.mt5Up = !err && /terminal64\.exe/i.test(String(out)); });
}
let firstWatch = true;
function watchdog() {
  if (!L.mt5Up) patchCommon(); // MT5 rewrites its settings when it closes, so put the allowed addresses back while it is down
  const now = Date.now(), conn = L.lastSync > 0 && now - L.lastSync < 6000;
  if (isCustom()) { // imported EA: only keep MT5 itself alive, there is no Kanairy EA connection to wait for
    checkMt5();
    if (process.platform !== 'win32' || cfg.autoLaunch === false || L.stopped) return;
    if (!L.mt5Up && now - L.launchedAt > 45000 && S.login && S.server && S.hasPw && cfg.mt5Path) { log('MT5 is not running. Starting it with your imported EA.'); launchMt5(); }
    return;
  }
  if (conn !== L.wasConn) { L.wasConn = conn; log(conn ? 'EA connected.' : 'EA disconnected.'); addFeed('sys', conn ? 'EA connected' : 'EA disconnected'); }
  if (conn) { L.relaunches = 0; return; }
  checkMt5();
  if (process.platform !== 'win32' || cfg.autoLaunch === false) return;
  if (!S.login || !S.server || !S.hasPw || !cfg.mt5Path) return;
  const sinceLaunch = now - L.launchedAt;
  if (!L.mt5Up && (firstWatch || sinceLaunch > 45000)) { firstWatch = false; log('MT5 is not running. Starting it with your saved login.'); launchMt5(); return; }
  firstWatch = false;
  // MT5 is up but the EA never reported: restart it a couple of times, only if we started it ourselves.
  if (L.mt5Up && L.launchedAt && sinceLaunch > 120000 && L.relaunches < 2) { L.relaunches++; log('EA has not connected. Restarting MT5 (attempt ' + L.relaunches + ').'); launchMt5(); }
}
checkMt5();
setTimeout(() => { try { patchCommon(); } catch { /* MT5 not found yet */ } }, 3000);
setInterval(watchdog, 15000);
setTimeout(watchdog, 4000);
