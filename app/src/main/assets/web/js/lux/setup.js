import { h, field, toast, toggle, sheet } from './ui.js';
import { B, native } from './native.js';

const NOTE = { ok: 'Connected', unconfigured: 'Not connected yet', offline: 'Cannot reach the server. Check your internet. If it keeps happening the server may be off.',
  badcode: 'That code is not recognised. Check it and enter it again.', locked: 'Too many wrong codes. Try again in 10 minutes.' };

// The code looks like K7M-4QX-9TD. Dashes are added as you type.
const fmt = v => { const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 9); return [c.slice(0, 3), c.slice(3, 6), c.slice(6, 9)].filter(Boolean).join('-'); };

export function mountSetup(root, applyTheme, getTheme) {
  const body = h('div');
  let busy = false;
  function render() {
    const link = B.link(), me = B.user();
    const code = h('input', { type: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: 'XXX-XXX-XXX', maxlength: '11',
      style: { fontSize: '22px', letterSpacing: '2px', textAlign: 'center', fontFamily: 'monospace' }, oninput: e => { e.target.value = fmt(e.target.value); } });
    const connect = async () => {
      if (busy) return;
      if (code.value.replace(/-/g, '').length !== 9) { toast('Enter your 9 character code'); return; }
      busy = true; toast('Connecting');
      const r = await B.connect(code.value);
      busy = false;
      toast(r.ok ? 'Connected' : (r.error || 'Failed'));
      if (r.ok) setTimeout(() => window.__go && window.__go(B.info().login ? 'live' : 'account'), 600);
      render();
    };
    const card = me
      ? h('div', { class: 'card' }, h('h2', {}, 'Your code'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'num', style: { fontSize: '22px', letterSpacing: '2px' } }, me), h('div', { class: 'small mute' }, NOTE[link] || '')),
          h('button', { class: 'btn ghost sm', onclick: () => { B.signOut(); toast('Disconnected'); render(); } }, 'Disconnect')),
        h('div', { class: 'small faint', style: { margin: '12px 0' } }, 'Your broker login and your trades belong to this code only. Nobody else sees them.'),
        h('button', { class: 'btn ghost sm', onclick: () => sheet({ title: 'Delete your account?', body: 'This removes your broker login and your private MT5 from the server. Open trades stay open at your broker with their stops.',
          actions: [{ label: 'Cancel' }, { label: 'Delete', solid: true, run: async () => { const r = await B.deleteAccount(); toast(r.ok ? 'Account deleted' : r.error); render(); } }] }) }, 'Delete account'))
      : h('div', { class: 'card' }, h('h2', {}, 'Enter your code'),
        h('p', { class: 'small mute', style: { margin: '-6px 0 14px' } }, 'You were given a code like K7M-4QX-9TD. That is all you need. Then add your broker login in the Account tab.'),
        field('Code', code), note(link),
        h('div', { class: 'btns', style: { marginTop: '6px' } }, h('button', { class: 'btn solid', onclick: connect }, 'Connect')));

    body.replaceChildren(...[
      h('h1', {}, 'Connect'), h('p', { class: 'lead' }, 'One code links this phone to your trading account on the server.'),
      card,
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', {}, 'Light appearance'), h('div', { class: 'small mute' }, 'Black on white')), toggle(getTheme() === 'light', on => applyTheme(on ? 'light' : 'dark'), 'Light appearance'))),
      !native ? h('div', { class: 'small faint', style: { textAlign: 'center' } }, 'Preview mode. Install the Android app to trade.') : null].filter(Boolean));
  }
  const note = link => (link === 'badcode' || link === 'locked' || link === 'offline' ? h('div', { class: 'small', style: { color: '#e0605a', marginTop: '8px' } }, NOTE[link]) : null);
  render();
  root.append(body);
  return { render };
}
