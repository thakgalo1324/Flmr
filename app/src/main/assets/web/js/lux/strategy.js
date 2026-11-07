import { h, field, toast, toggle } from './ui.js';
import { B } from './native.js';
import { TEMPLATES, fromXML, toXML, operandText, parseOperand, validate } from '../strategy.js';

const cross = (a, b, dir) => ({ type: 'cross', a: parseOperand(a), b: parseOperand(b), dir });
const cmp = (a, op, b) => ({ type: 'cmp', a: parseOperand(a), op, b: parseOperand(b) });
const STARTER = () => ({ name: 'Gold scalper starter', timeframe: 'M1', risk: { lots: 0.01, slAtr: 1, tpAtr: 1.5, atrPeriod: 14 },
  rules: { enterLong: [cross('ema:5', 'ema:13', 'above'), cmp('rsi:14', '>', '50')], enterShort: [cross('ema:5', 'ema:13', 'below'), cmp('rsi:14', '<', '50')], exitLong: [], exitShort: [] } });

const say = c => c.type === 'cross' ? `${operandText(c.a)} crosses ${c.dir} ${operandText(c.b)}` : `${operandText(c.a)} is ${c.op === '>' ? 'above' : 'below'} ${operandText(c.b)}`;
const SIDES = [['enterLong', 'Buy when'], ['enterShort', 'Sell when'], ['exitLong', 'Close buys when'], ['exitShort', 'Close sells when']];
const GUARDS = [
  ['hub_lot', 'Lot size', '0', 'Leave 0 to use the strategy’s lots'],
  ['hub_max_open', 'Max open trades', '3', 'Across buys and sells'],
  ['hub_burst', 'Orders per signal', '1', 'Fire up to 5 at once (hedging accounts only)'],
  ['hub_cooldown', 'Cooldown (seconds)', '0', 'Pause between entries'],
  ['hub_max_day', 'Max orders a day', '200', ''],
  ['hub_daily_loss', 'Daily loss stop', '0', 'Stops the bot at this loss. 0 means off'],
  ['hub_max_spread', 'Max spread (points)', '0', 'Skip entries when the spread is wider. 0 means off'],
];

export function mountStrategy(root, refresh) {
  let strat = null;
  try { strat = JSON.parse(B.getStrategy() || 'null'); } catch { strat = null; }
  const body = h('div');
  const save = async s => { if (!B.linkOk()) return; strat = s; render(); await B.setStrategy(JSON.stringify(s)); refresh(); };
  const file = h('input', { type: 'file', accept: '.xml,text/xml,application/xml', class: 'sr', onchange: async e => {
    const f = e.target.files[0]; if (!f) return;
    try { await save(fromXML(await f.text())); toast('Loaded ' + strat.name); } catch (er) { toast(er.message); } e.target.value = ''; } });

  function render() {
    const kids = [h('h1', {}, 'Strategy'), h('p', { class: 'lead' }, 'Your rules, in XML. The bot trades exactly what you load here.')];
    // current
    const cur = h('div', { class: 'card' });
    if (strat) {
      cur.append(h('div', { class: 'faint small' }, 'Loaded'), h('h2', { style: { fontStyle: 'italic', fontSize: '26px', margin: '4px 0 4px' } }, strat.name),
        h('div', { class: 'small mute num', style: { marginBottom: '14px' } }, `${strat.timeframe || 'M1'}   ${strat.risk.lots} lots   stop ${strat.risk.slAtr ?? 'auto'} ATR   target ${strat.risk.tpAtr ?? 'none'} ATR`));
      SIDES.forEach(([k, label]) => { if (strat.rules[k].length) cur.append(h('div', { class: 'rule' }, h('b', {}, label + ' '), strat.rules[k].map(say).join(', and ')));});
    } else cur.append(h('h2', {}, 'Nothing loaded'), h('p', { class: 'mute', style: { margin: 0 } }, 'Import an XML file, pick a starter, or paste XML below.'));
    kids.push(cur);

    // load
    const ta = h('textarea', { spellcheck: 'false', 'aria-label': 'Strategy XML', placeholder: '<strategy name="My scalper"> ...' });
    if (strat) ta.value = toXML(strat);
    const load = h('div', { class: 'card' }, h('h2', {}, 'Load rules'),
      h('div', { class: 'chips' }, h('button', { class: 'chip on', onclick: () => file.click() }, 'Import XML file'), h('button', { class: 'chip', onclick: () => save(STARTER()) }, 'Gold scalper starter'),
        Object.entries(TEMPLATES).map(([, f]) => h('button', { class: 'chip', onclick: () => save(f()) }, f().name))), file, ta,
      h('div', { class: 'btns' }, h('button', { class: 'btn solid', onclick: async () => { try { const x = fromXML(ta.value); await save(x); toast('Strategy saved'); } catch (e) { toast(e.message); } } }, 'Save strategy'),
        h('a', { class: 'btn ghost', href: 'classic.html#strategies' }, 'Test in the lab')));
    kids.push(load);

    // guard rails
    const g = h('div', { class: 'card' }, h('h2', {}, 'Guard rails'), h('p', { class: 'mute small', style: { margin: '-6px 0 16px' } }, 'The bot checks these before every order. Each order also carries a stop loss held by your broker.'));
    const grid = h('div', { class: 'grid2' });
    GUARDS.forEach(([k, label, d, hint]) => {
      const i = h('input', { type: 'text', inputmode: 'decimal', value: String(B.getCfg(k, d)) });
      i.onchange = () => { const v = i.value.trim().replace(',', '.'); if (v !== '' && !isNaN(+v) && +v >= 0) B.setCfg(k, v); else { i.value = B.getCfg(k, d); toast('Enter a number'); } };
      grid.append(field(label, i, hint));
    });
    g.append(grid);
    kids.push(g);
    body.replaceChildren(...kids);
  }
  render();
  root.append(body);
  return { render: () => { try { strat = JSON.parse(B.getStrategy() || 'null'); } catch { strat = null; } render(); } };
}
