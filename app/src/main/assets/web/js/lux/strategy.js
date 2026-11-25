import { h, field, toast, toggle, sheet } from './ui.js';
import { B } from './native.js';

// Files saved by MetaEditor are usually UTF-16, so read the bytes and look for the byte-order mark.
const decode = buf => {
  const u = new Uint8Array(buf);
  if (u[0] === 0xFF && u[1] === 0xFE) return new TextDecoder('utf-16le').decode(u.subarray(2));
  if (u[0] === 0xFE && u[1] === 0xFF) return new TextDecoder('utf-16be').decode(u.subarray(2));
  return new TextDecoder('utf-8').decode(u);
};
const b64 = buf => { const u = new Uint8Array(buf); let o = ''; for (let i = 0; i < u.length; i += 0x8000) o += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(o); };
const TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4'];
const KIND = { mq5: 'MQL5 source', ex5: 'compiled MT5 bot', py: 'Python bot' };

export function mountStrategy(root, refresh) {
  const body = h('div');
  let tf = 'M1', draft = {}, shownName = '';

  const pick = h('input', { type: 'file', accept: '.mq5,.ex5,.py,.set', class: 'sr', multiple: true, onchange: async e => {
    const files = [...e.target.files]; e.target.value = '';
    // bot files first, then .set files, so a .set picked together with its bot lands on the right bot
    files.sort((a, b) => /\.set$/i.test(a.name) - /\.set$/i.test(b.name));
    for (const f of files) await load(f);
    paint(); } });

  async function load(f) {
    const n = f.name.toLowerCase();
    if (f.size > 2e6) { toast(f.name + ' is too large'); return; }
    const buf = await f.arrayBuffer();
    let r;
    if (n.endsWith('.set')) {
      r = await B.importPreset(decode(buf));
      toast(r.ok ? `Settings loaded: ${r.applied} applied${r.rejected && r.rejected.length ? ', ' + r.rejected.length + ' not recognised' : ''}` : (r.error || 'Could not read that .set file'));
      if (r.ok) draft = {};
    } else if (n.endsWith('.ex5')) { r = await B.importEx5(f.name, b64(buf)); draft = {}; toast(r.ok ? 'Bot added' : (r.error || 'Import failed')); }
    else if (n.endsWith('.mq5')) { r = await B.importEa(f.name, decode(buf), 'mq5'); draft = {}; toast(r.ok ? 'Reading and compiling on your server' : (r.error || 'Import failed')); }
    else if (n.endsWith('.py')) { r = await B.importEa(f.name, decode(buf), 'py'); draft = {}; toast(r.ok ? 'Python bot added' : (r.error || 'Import failed')); }
    else toast('Use a .mq5, .ex5, .py or .set file');
  }

  const run = () => sheet({ title: 'Run this bot on your VPS?', body: 'The bot trades by itself and places its own orders. Kanairy\'s guard rails and the live-account lock do not control it. Try it on a demo account first, and only run bots you trust.',
    actions: [{ label: 'Cancel' }, { label: 'Run it', solid: true, run: async () => {
      if (Object.keys(draft).length) { const s = await B.setEaValues(draft); if (!s.ok) { toast(s.error || 'Could not save settings'); return; } draft = {}; }
      const m = await B.setEaMode('custom', tf); if (!m.ok) { toast(m.error || 'Could not switch'); return; }
      const r = await B.launch(); toast(r.ok ? 'Starting. Give it a minute.' : (r.error || 'Could not start')); paint(); refresh(); } }] });
  const stop = async () => { const r = await B.stopBot(); toast(r.ok ? 'Bot stopped' : (r.error || 'Could not stop')); paint(); refresh(); };
  const saveSettings = async () => {
    const r = await B.setEaValues(draft);
    if (r.ok) { draft = {}; toast('Settings saved'); } else toast(r.error || 'Could not save');
    paint(); };

  function inputRow(i) {
    const cur = draft[i.name] ?? i.value;
    if (i.kind === 'bool') {
      const t = toggle(cur === 'true', v => { draft[i.name] = v ? 'true' : 'false'; });
      return h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', { class: 't' }, i.name), i.comment ? h('div', { class: 'd' }, i.comment) : null), t);
    }
    const inp = h('input', { type: 'text', inputmode: i.kind === 'int' || i.kind === 'num' ? 'decimal' : 'text', value: String(cur) });
    inp.oninput = () => { draft[i.name] = inp.value; };
    return field(i.name, inp, i.comment || ('default ' + i.def));
  }

  function paint() {
    const ea = B.ea(), lang = ea.lang === 'py' ? 'py' : (ea.inputs && ea.inputs.length ? 'mq5' : 'ex5');
    if (ea.name !== shownName) { shownName = ea.name; draft = {}; }
    const busy = ea.state === 'compiling', custom = ea.mode === 'custom';
    const state = { none: 'No bot yet. Pick a file below.', compiling: 'Compiling on your server…', ok: custom && ea.running ? ea.name + ' is running.' : ea.name + ' is ready.', failed: ea.name ? ea.name + ' did not load.' : 'Import failed.' }[ea.state] || '';
    const kids = [h('h1', {}, 'Strategy'), h('p', { class: 'lead' }, 'Import any bot. Kanairy reads its settings and runs it on your VPS. It trades like an EA, with its own logic.')];

    kids.push(h('div', { class: 'card' }, h('h2', {}, 'Import a bot'),
      h('p', { class: 'mute small', style: { margin: '-6px 0 14px' } }, '.mq5 source (compiled on your server), .ex5, or a .py bot, plus an optional .set settings file. You can pick the bot and its .set together. Bots that need a DLL will not run.'),
      h('div', { class: 'chips' }, h('button', { class: 'chip on', onclick: () => !busy && pick.click() }, 'Choose files')), pick,
      h('div', { class: 'rule', style: { marginTop: '12px' } }, h('b', {}, state), ea.name ? h('span', { class: 'small mute' }, '  ' + KIND[lang]) : null,
        ea.log ? h('div', { class: 'small mute', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } }, ea.log) : null)));

    if (ea.state === 'ok') {
      if (ea.inputs && ea.inputs.length) {
        const s = h('div', { class: 'card' }, h('h2', {}, 'Settings'), h('p', { class: 'mute small', style: { margin: '-6px 0 14px' } }, `${ea.inputs.length} found in the file. Change them here, or load a .set file.`));
        ea.inputs.forEach(i => s.append(inputRow(i)));
        s.append(h('div', { class: 'btns' }, h('button', { class: 'btn ghost', onclick: saveSettings }, 'Save settings')));
        kids.push(s);
      } else kids.push(h('div', { class: 'card' }, h('h2', {}, 'Settings'), h('p', { class: 'mute small', style: { margin: 0 } }, lang === 'ex5' ? 'A compiled .ex5 hides its settings. Load a .set file for it, or it runs with its defaults.' : 'No settings found in this file. For Python, put them at the top as UPPER_CASE constants, for example LOTS = 0.01.')));
      if (lang !== 'py') kids.push(h('div', { class: 'card' }, h('div', { class: 'faint small', style: { marginBottom: '6px' } }, 'Chart timeframe'), h('div', { class: 'chips' }, TFS.map(t => h('button', { class: 'chip' + (tf === t ? ' on' : ''), onclick: () => { tf = t; paint(); } }, t)))));
      kids.push(h('div', { class: 'btns' },
        h('button', { class: 'btn solid', onclick: run }, custom ? 'Restart with these settings' : 'Run it on my VPS'),
        custom ? h('button', { class: 'btn ghost', onclick: stop }, 'Stop') : null));
    }
    // spread guard + real cost of fills
    const g = B.guard(), mon = B.mon(), c = B.cost();
    const gc = h('div', { class: 'card' }, h('h2', {}, 'Spread guard and real costs'),
      h('p', { class: 'mute small', style: { margin: '-6px 0 14px' } }, lang === 'py' ? 'New orders from your Python bot are refused while the spread is too wide or a pause window is on. Closes and stop changes always go through.' : 'For .mq5 and .ex5 bots this only watches and warns. The bot places its own orders, so use its own max-spread setting to block trades. Python bots are blocked for real.'));
    const sp = h('input', { type: 'text', inputmode: 'decimal', value: String(g.maxSpread) });
    const wn = h('input', { type: 'text', value: g.windows || '', placeholder: '21:55-23:05' });
    gc.append(field('Max spread in dollars (0 = off)', sp, 'Gold: 0.35 means 35 points. Wide spreads at rollover and news are caught by this.'), field('Pause windows (UTC, optional)', wn, 'For example 21:55-23:05. Separate several with commas.'),
      h('div', { class: 'btns' }, h('button', { class: 'btn ghost', onclick: async () => { const r = await B.setGuard({ maxSpread: sp.value.trim().replace(',', '.'), windows: wn.value }); toast(r.ok ? 'Guard saved' : (r.error || 'Could not save')); } }, 'Save guard')));
    gc.append(h('div', { class: 'rule', style: { marginTop: '12px' } }, mon.up ? h('span', {}, h('b', {}, 'Spread now $' + (mon.spread ?? '–') + '  '), mon.ok ? 'OK to trade' : 'Paused: ' + mon.reason, mon.blocked ? ' · ' + mon.blocked + ' orders refused' : '') : h('span', { class: 'mute' }, 'Monitor is off. It starts with the bot and needs "pip install MetaTrader5" on the VPS.' + (mon.err ? ' ' + mon.err : ''))));
    gc.append(c.n ? h('div', { class: 'rule' }, h('b', {}, 'Real cost per trade: $' + c.all.toFixed(2) + '  '), `spread ${c.spread.toFixed(2)} + slippage in ${c.slipIn.toFixed(2)} + out ${c.slipOut.toFixed(2)} + commission ${c.comm.toFixed(2)}, from ${c.n} trades. `, c.warn === 'red' ? 'Above about $0.45 most scalping edges disappear.' : c.warn === 'amber' ? 'Getting high. Above $0.45 most scalping edges disappear.' : 'Fine for scalping.') : h('div', { class: 'rule mute' }, 'Real costs show up here after the bot has made some trades.'));
    kids.push(gc);
    body.replaceChildren(...kids);
  }

  let sig = '';
  setInterval(() => { if (!root.classList.contains('on')) return; const e = B.ea(), s = JSON.stringify([e.state, e.log, e.mode, e.running, e.name, (e.inputs || []).length]); if (s !== sig) { sig = s; paint(); } }, 2000);
  paint();
  root.append(body);
  return { render: paint };
}
