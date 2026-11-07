# Kanairy on your VPS

The VPS runs three things: MT5, the Kanairy EA, and this server. Your phone app only controls it.

    Phone app  --(signed requests, port 8766)-->  Kanairy server  <--(127.0.0.1:8765)-->  KanairyEA in MT5

## Install (Windows VPS)
1. Install **Node.js LTS** from nodejs.org (version 18 or newer).
2. Copy this `vps` folder to the VPS, for example `C:\kanairy`.
3. Double-click `open-firewall.bat` (run as Administrator). Also open **TCP 8766** in your VPS provider's firewall panel.
4. Double-click `start-kanairy.bat`. The first run creates `config.json` and prints your **App address**, **App key** and **EA token**. Keep the window open.
5. Open `config.json` and set:
   - `mt5Path`: the full path to `terminal64.exe`
   - `mt5DataDir`: in MT5 choose File, Open Data Folder, and paste that path
   Then close and run `start-kanairy.bat` again.
6. In MT5: copy `KanairyEA.mq5` (from the `mt5` folder) into `MQL5\Experts` in the data folder, open MetaEditor, press F7 to compile.
7. In MT5: Tools, Options, Expert Advisors, tick **Allow WebRequest** and add `http://127.0.0.1:8765`.
8. In the phone app: Setup, enter `http://YOUR_VPS_IP:8766` and the App key, tap Connect.
9. In the app: Account, enter your broker login, tap **Launch MT5**. The server restarts MT5 with your login and attaches the EA to your symbol. (Or attach KanairyEA to a chart yourself and paste the EA token.)
10. In the app: Strategy, import your XML. Live, hold the crown.

## Keep it running
- Run `start-kanairy.bat` from a **Startup** shortcut or Task Scheduler with "Run only when user is logged on", in the same Windows session that shows MT5. Launching MT5 needs that desktop session.
- Turn on auto-logon for the VPS user so it comes back after a reboot.

## Linux
`node server.js` works the same. MT5 needs Wine there. Set `mt5Path` to the Wine path of `terminal64.exe`.

## Security
- Every app request is signed with your App key and expires in 60 seconds, so nobody can place or replay trades without the key. The key never travels over the network.
- Traffic itself is plain HTTP. Balances and trades are visible to someone on your network path. For privacy put the server behind HTTPS (Caddy or Cloudflare Tunnel) or a VPN such as Tailscale, and use that address in the app.
- The EA port 8765 listens on the VPS only. Do not open it.
- Your broker password is stored encrypted in `data\secrets.json` and written to MT5's start file only while MT5 starts (removed after 90 seconds).
- The EA refuses real accounts unless `allowLive` is `true` in `config.json`. Use a demo account first.
