import { h, field, toast, toggle } from './ui.js';
import { B, native } from './native.js';

const NOTE = { ok: 'Connected to your server', unconfigured: 'Not connected yet', offline: 'Cannot reach the server. Check the address, that the server is running, and that port 8766 is open', badkey: 'Reached the server, but it rejected the key' };

export function mountSetup(root, applyTheme, getTheme) {
  const body = h('div');
  function render() {
    const v = B.vps();
    const url = h('input', { type: 'text', value: v.url || '', autocapitalize: 'off', autocomplete: 'off', placeholder: 'http://123.45.67.89:8766' });
    const key = h('input', { type: 'password', autocomplete: 'off', placeholder: v.hasKey ? 'Saved. Type to replace' : 'App key from the server window' });
    const note = h('div', { class: 'small mute', style: { marginTop: '12px' } }, NOTE[B.link()] || '');
    const connect = () => {
      if (!url.value.trim()) { toast('Enter your server address'); return; }
      if (!v.hasKey && !key.value.trim()) { toast('Enter the app key'); return; }
      B.saveVps(url.value, key.value); key.value = '';
      note.textContent = 'Connecting';
      B.pollNow(); setTimeout(() => { B.pollNow(); setTimeout(() => { note.textContent = NOTE[B.link()] || ''; toast(B.link() === 'ok' ? 'Connected' : (NOTE[B.link()] || '')); render(); }, 1500); }, 600);
    };
    body.replaceChildren(
      h('h1', {}, 'Setup'), h('p', { class: 'lead' }, 'Connect the app to the Kanairy server on your VPS.'),
      h('div', { class: 'card' }, h('h2', {}, 'Your server'), field('Address', url, 'Your VPS public IP and port, as printed by the server'), field('App key', key, 'Printed by the server the first time it runs. Stored encrypted on this phone.'),
        h('div', { class: 'btns', style: { marginTop: '6px' } }, h('button', { class: 'btn solid', onclick: connect }, 'Connect')), note),
      h('div', { class: 'card' }, h('h2', {}, 'On the VPS'),
        ...['Install Node.js and copy the vps folder. Run start-kanairy.bat.', 'Set mt5Path and mt5DataDir in config.json.', 'Compile KanairyEA.mq5 in MetaEditor. In MT5 allow WebRequest for http://127.0.0.1:8765.', 'Open TCP port 8766 in the VPS firewall.'].map((t, i) => h('div', { class: 'rule' }, h('b', {}, (i + 1) + '.  '), t)),
        h('div', { class: 'small faint', style: { marginTop: '10px' } }, 'Full steps are in README-VPS.md.')),
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', {}, 'Light appearance'), h('div', { class: 'small mute' }, 'Black on white')), toggle(getTheme() === 'light', on => applyTheme(on ? 'light' : 'dark'), 'Light appearance'))),
      h('div', { class: 'card flat' }, h('div', { class: 'small mute', style: { marginBottom: '12px' } }, 'The earlier Kanairy that reads the MT5 Android screen is still here.'), h('a', { class: 'btn ghost sm', href: 'classic.html' }, 'Open classic mode')),
      !native ? h('div', { class: 'small faint', style: { textAlign: 'center' } }, 'Preview mode. Install the Android app to trade.') : null);
  }
  render();
  root.append(body);
  return { render };
}
