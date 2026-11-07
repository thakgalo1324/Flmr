# Kanairy on your VPS (easy setup)

The VPS runs MT5, the Kanairy EA and this server. Your phone app only controls it.

    Phone app  --(signed requests, port 8766)-->  Kanairy server  <--(127.0.0.1:8765)-->  KanairyEA in MT5

## Setup, three steps
1. Install **MetaTrader 5** on the VPS and open it once (so it creates its data folder). Keep the `vps` and `mt5` folders side by side.
2. Double-click **`start-kanairy.bat`** in the `vps` folder. It does the rest:
   - installs Node.js if missing (if it does, close the window and double-click again),
   - opens port 8766 in Windows Firewall (tap Yes),
   - finds MT5, copies `KanairyEA.mq5` in and compiles it,
   - prints your **Phone address** and **App key**.
3. In your VPS provider's website, open **TCP port 8766** in its firewall (security group). Windows cannot do this part for you.

Then on the phone: Kanairy, Setup, enter the address and key, tap Connect. Account, enter your broker login (demo first), tap Launch MT5.

## Keep it running
- Leave the black window open. Run `start-kanairy.bat` from a Startup shortcut (Win+R, type `shell:startup`) so it comes back after a reboot, and turn on auto-logon for the VPS user.
- Launching MT5 needs the server to run in the same Windows desktop session that shows MT5.

## If something does not work
- `MT5 not found`: install MetaTrader 5, open it once, run the bat again. Or set `mt5Path` and `mt5DataDir` in `config.json` by hand.
- EA did not compile: open MT5, press F4, open KanairyEA, press F7, and read the errors.
- Phone cannot connect: open `http://YOUR_VPS_IP:8766/api/status` in the phone browser. `{"error":"unauthorized"}` means the server is reachable. If the page never loads, port 8766 is closed in the provider firewall.

## Linux
`node server.js` works the same. MT5 needs Wine there. Set `mt5Path` to the Wine path of `terminal64.exe`.

## Security
- Every app request is signed with your App key and expires in 60 seconds, so nobody can place or replay trades without the key. The key never travels over the network.
- Traffic itself is plain HTTP. Balances and trades are visible to someone on your network path. For privacy put the server behind HTTPS (Caddy or Cloudflare Tunnel) or a VPN such as Tailscale, and use that address in the app.
- The EA port 8765 listens on the VPS only. Do not open it.
- Your broker password is stored encrypted in `data\secrets.json` and written to MT5's start file only while MT5 starts (removed after 90 seconds).
- The EA refuses real accounts unless `allowLive` is `true` in `config.json`. Use a demo account first.
