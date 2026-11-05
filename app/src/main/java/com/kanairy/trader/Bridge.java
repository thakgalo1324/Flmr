package com.kanairy.trader;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONArray;
import org.json.JSONObject;

/** What the Kanairy web UI can ask the phone to do. Only our own bundled pages are loaded, so only they can call this. */
final class Bridge {
    private final MainActivity act;
    private final WebView web;

    Bridge(MainActivity act, WebView web) { this.act = act; this.web = web; }

    private KanairyService svc() { return KanairyService.instance; }

    @JavascriptInterface
    public String status() {
        JSONObject o = new JSONObject();
        try {
            KanairyService s = svc();
            o.put("svc", s != null);
            if (s != null) s.bot().fill(o);
            else o.put("auto", false).put("dry", Cfg.b(act, Cfg.DRY, true)).put("scalp", Cfg.b(act, Cfg.SCALP, false))
                    .put("mode", Cfg.s(act, Cfg.MODE, "lab")).put("action", "WAIT").put("mt5", false);
            PowerManager pm = (PowerManager) act.getSystemService(Context.POWER_SERVICE);
            o.put("battery", pm != null && pm.isIgnoringBatteryOptimizations(act.getPackageName()));
            JSONArray log = new JSONArray();
            for (String l : Flog.tail().split("\n")) if (!l.isEmpty()) log.put(l);
            o.put("log", log);
        } catch (Exception ignored) { }
        return o.toString();
    }

    @JavascriptInterface
    public String events() { return Events.json(act); }

    @JavascriptInterface
    public void setAuto(boolean on) {
        KanairyService s = svc();
        if (s == null) { toast("Turn on Kanairy in Accessibility first"); return; }
        s.bot().setAuto(on);
    }

    private void toast(String m) { act.runOnUiThread(() -> Toast.makeText(act, m, Toast.LENGTH_SHORT).show()); }

    private void go(Intent i) { act.runOnUiThread(() -> { try { act.startActivity(i); } catch (Exception e) { toast("Cannot open that screen"); } }); }

    private void applyScalp(boolean on) {
        String[][] pre = on
                ? new String[][]{{Cfg.THR, "3"}, {Cfg.SL_ATR, "0.8"}, {Cfg.RR, "1.2"}, {Cfg.INTERVAL, "6"}, {Cfg.MAX_OPEN, "3"}, {Cfg.MAX_DAY, "40"}, {Cfg.COOLDOWN, "0.5"}, {Cfg.HOLD_MIN, "5"}}
                : new String[][]{{Cfg.THR, "4"}, {Cfg.SL_ATR, "1.5"}, {Cfg.RR, "2"}, {Cfg.INTERVAL, "20"}, {Cfg.MAX_OPEN, "1"}, {Cfg.MAX_DAY, "6"}, {Cfg.COOLDOWN, "15"}, {Cfg.HOLD_MIN, "0"}};
        for (String[] kv : pre) Cfg.put(act, kv[0], kv[1]);
        Cfg.putB(act, Cfg.SCALP, on);
        toast(on ? "Scalp preset applied. Use a 1 minute chart." : "Normal preset applied");
    }

    @JavascriptInterface
    public void act(String name) {
        final KanairyService s = svc();
        switch (name) {
            case "scan": if (s == null) toast("Turn on Kanairy in Accessibility first"); else s.bot().requestScan(); break;
            case "debug": if (s != null) s.bot().requestDebug(); break;
            case "dump": if (s != null) s.bot().requestDump(); break;
            case "overlay": if (s != null) s.showOverlay(); else toast("Turn on Kanairy in Accessibility first"); break;
            case "teach":
                if (s == null) { toast("Turn on Kanairy in Accessibility first"); break; }
                openMt5();
                toast("Go to the MT5 chart. Tap New Order when the screen dims.");
                s.mainHandler().postDelayed(() -> s.overlay().startTeach(), 5000);
                break;
            case "mt5": openMt5(); break;
            case "a11y": go(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); break;
            case "appinfo": go(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + act.getPackageName()))); break;
            case "battery": go(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); break;
            case "scalp_on": applyScalp(true); break;
            case "scalp_off": applyScalp(false); break;
            default: break;
        }
        if (s != null && s.overlay() != null) s.overlay().refresh();
    }

    private void openMt5() {
        Intent i = act.getPackageManager().getLaunchIntentForPackage(Mt5Driver.PKG);
        if (i == null) toast("MT5 is not installed"); else go(i);
    }

    @JavascriptInterface public String getCfg(String k, String d) { return Cfg.s(act, k, d); }
    @JavascriptInterface public void setCfg(String k, String v) { Cfg.put(act, k, v); }
    @JavascriptInterface public boolean getFlag(String k, boolean d) { return Cfg.b(act, k, d); }

    @JavascriptInterface
    public void setFlag(String k, boolean v) {
        Cfg.putB(act, k, v);
        KanairyService s = svc();
        if (s != null && s.overlay() != null) s.overlay().refresh();
    }

    @JavascriptInterface public String getStrategy() { return Cfg.s(act, Cfg.STRAT, ""); }
    @JavascriptInterface public void setStrategy(String json) { Cfg.put(act, Cfg.STRAT, json == null ? "" : json); }

    @JavascriptInterface
    public boolean saveFile(String name, String text) {
        return Files.saveTextAs(act, name.replaceAll("[^A-Za-z0-9._-]", "_"), text, "text/xml");
    }

    @JavascriptInterface
    public void http(final int id, final String url) {
        new Thread(() -> {
            int status = 0;
            String body = "";
            try {
                if (!url.startsWith("https://")) throw new IllegalArgumentException("https only");
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(12000);
                c.setReadTimeout(20000);
                c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36");
                c.setRequestProperty("Accept", "application/json,text/xml,application/xml,text/html;q=0.9,*/*;q=0.8");
                status = c.getResponseCode();
                InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream();
                if (in != null) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n, total = 0;
                    while ((n = in.read(buf)) > 0 && total < 3_000_000) { bo.write(buf, 0, n); total += n; }
                    body = bo.toString("UTF-8");
                }
            } catch (Exception e) {
                status = 0;
            }
            final int st = status;
            final String b = body;
            web.post(() -> web.evaluateJavascript("window.__http(" + id + "," + st + "," + JSONObject.quote(b) + ")", null));
        }).start();
    }
}
