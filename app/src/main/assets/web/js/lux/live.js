import { h, icon, fmt, px, sgn, clock, sheet, toast } from './ui.js';
import { B } from './native.js';

export function mountLive(root, go, setPill) {
  const bigNum = h('span', { class: 'num' }, '0.00');
  const sign = h('small', {}, '');
  const big = h('div', { class: 'big' }, sign, bigNum);
  const bal = h('b', { class: 'num' }, '–'), eqt = h('b', { class: 'num' }, '–');
  const hero = h('div', { class: 'hero' }, big, h('div', { class: 'cap' }, 'Today'),
    h('div', { class: 'duo' }, h('div', {}, bal, h('span', {}, 'Balance')), h('div', {}, eqt, h('span', {}, 'Equity'))));

  // crown: press and hold to start, tap to stop
  const face = h('div', { class: 'face' }, h('div', {}, h('b', {}, 'Start'), h('i', {}, 'Hold')));
  const crown = h('div', { class: 'crown off', role: 'button', tabindex: '0', 'aria-label': 'Start or stop the bot' },
    (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 184 184');
      s.innerHTML = '<circle class="track" cx="92" cy="92" r="86"/><circle class="prog" cx="92" cy="92" r="86"/>'; return s; })(), face);
  const hint = h('div', { class: 'hint' }, '');
  let holdT = null, S = { run: false }, canStart = false;
  const stop = () => { B.run(false); toast('Stopped. Open trades keep their stops.'); };
  const begin = () => { if (S.run) return; if (!canStart) return; crown.classList.add('hold'); holdT = setTimeout(() => { crown.classList.remove('hold'); holdT = null; B.run(true); toast('Started'); tick(); }, 760); };
  const cancel = () => { if (holdT) { clearTimeout(holdT); holdT = null; } crown.classList.remove('hold'); };
  crown.addEventListener('pointerdown', e => { e.preventDefault(); if (S.run) { stop(); tick(); } else begin(); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => crown.addEventListener(ev, cancel));
  crown.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); if (S.run) { stop(); tick(); } else if (canStart) { B.run(true); tick(); } } });

  const steps = h('div', { class: 'card' });
  const trio = h('div', { class: 'trio' });
  const posCard = h('div', { class: 'card' }), feedCard = h('div', { class: 'card' });
  const kill = h('button', { class: 'btn ghost wide', onclick: () => sheet({ title: 'Close all and stop?', body: 'Every open trade closes at market and the bot stops.',
    actions: [{ label: 'Cancel' }, { label: 'Close all', solid: true, run: () => { B.kill(); toast('Closing all trades'); } }] }) }, 'Close all and stop');

  root.append(hero, h('div', { class: 'crownwrap' }, crown), hint, steps, trio, posCard, feedCard, h('div', { style: { height: '8px' } }), kill);

  let info = {}, infoAt = 0, feedSig = '';
  const step = (done, title, sub, action, label) => h('div', { class: 'step' + (done ? ' done' : '') },
    h('div', { class: 'tick' }, done ? icon('check', 15) : null), h('div', { class: 'grow' }, h('div', {}, title), h('div', { class: 'small mute' }, sub)),
    !done && action ? h('button', { class: 'btn sm', onclick: action }, label) : null);

  function paintPositions(st) {
    const rows = (st.pos || []).map(p => h('li', { class: 'li' },
      h('div', { class: 'badge ' + (p[1] === 0 ? 'buy' : '') }, icon(p[1] === 0 ? 'up' : 'down', 18)),
      h('div', {}, h('div', { class: 't' }, (p[1] === 0 ? 'Buy ' : 'Sell ') + fmt(p[2])), h('div', { class: 's num' }, 'at ' + px(p[3]))),
      h('div', { class: 'r pnl ' + (p[6] >= 0 ? 'up' : 'down') }, sgn(p[6]))));
    posCard.replaceChildren(h('h2', {}, 'Open trades'), rows.length ? h('ul', { class: 'list' }, rows) : h('div', { class: 'empty' }, st.run ? 'Watching the market. Nothing open yet.' : 'No open trades.'));
  }
  function paintFeed(items) {
    const sig = items.length + ':' + (items[0] ? items[0].t : 0);
    if (sig === feedSig) return;
    const first = feedSig === '';
    feedSig = sig;
    const rows = items.slice(0, 14).map((f, i) => h('li', { class: 'li' + (i === 0 && !first ? ' feedrow' : '') },
      h('div', { class: 'badge ' + (f.side === 'buy' ? 'buy' : '') }, f.k === 'sys' ? '•' : f.k === 'signal' ? '◎' : icon(f.side === 'buy' ? 'up' : 'down', 18)),
      h('div', { class: 'grow' }, h('div', { class: 't' }, f.text), h('div', { class: 's num' }, clock(f.t) + (f.price ? '   ' + px(f.price) : ''))),
      f.k === 'close' ? h('div', { class: 'r pnl ' + (f.profit >= 0 ? 'up' : 'down') }, sgn(f.profit)) : null));
    feedCard.replaceChildren(h('h2', {}, 'Activity'), rows.length ? h('ul', { class: 'list' }, rows) : h('div', { class: 'empty' }, 'Trades appear here the moment they happen.'));
  }

  function tick() {
    const st = B.status();
    if (Date.now() - infoAt > 4000) { info = B.info(); infoAt = Date.now(); }
    const linked = st.link === 'ok', acct = !!(info.login && info.hasPw), ea = !!st.conn, running = !!st.run;
    S = { ...st, run: running };
    canStart = linked && acct && !running;   // Start also opens MT5 on the server if it is not open yet
    // hero
    const v = st.dayPnl || 0;
    sign.textContent = v < 0 ? '−' : v > 0 ? '+' : '';
    bigNum.textContent = fmt(Math.abs(v));
    bal.textContent = st.bal ? fmt(st.bal) : '–'; eqt.textContent = st.eq ? fmt(st.eq) : '–';
    // crown
    crown.classList.toggle('run', running);
    crown.classList.toggle('off', !running && !canStart);
    face.firstChild.firstChild.textContent = running ? 'Stop' : 'Start';
    face.firstChild.lastChild.textContent = running ? 'Tap' : 'Hold';
    hint.textContent = running ? (st.err || (ea ? 'Trading ' + (st.sym || 'gold') + ' on every tick' : 'Started. Opening MT5 on the server, this takes about a minute.'))
      : !linked ? (st.link === 'badcode' ? 'Your code is not recognised. Check it in Connect' : 'Enter your code in Connect') : !acct ? 'Add your broker login in Account' : 'Hold the crown to start';
    setPill(running ? 'live' : ea ? 'ready' : 'idle', !linked ? ({ unconfigured: 'No code', offline: 'Server offline', badcode: 'Wrong code', locked: 'Locked' }[st.link] || 'No code') : running ? 'Running' : ea ? 'Ready' : 'Stopped');
    // checklist, only until everything is ready
    if (linked && acct) steps.style.display = 'none';
    else {
      steps.style.display = '';
      steps.replaceChildren(h('h2', {}, 'Get ready'),
        step(linked, 'Your code', linked ? 'Connected as ' + (st.user || B.user()) : 'Enter the code you were given', () => go('setup'), 'Open'),
        step(acct, 'Broker account', acct ? info.login + ' on ' + info.server : 'Add your MT5 login so the server can trade for you', () => go('account'), 'Add'));
    }
    const wr = st.wins + st.losses ? Math.round(st.wins / (st.wins + st.losses) * 100) + '%' : '–';
    trio.replaceChildren(h('div', {}, h('b', { class: 'num' }, String(st.dayTrades || 0)), h('span', {}, 'Orders sent')), h('div', {}, h('b', { class: 'num' }, wr), h('span', {}, 'Win rate')), h('div', {}, h('b', { class: 'num' }, String((st.pos || []).length)), h('span', {}, 'Open now')));
    paintPositions(st);
    paintFeed(B.feed());
  }
  tick();
  return { tick };
}
