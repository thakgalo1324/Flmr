package com.flmr.trader;

import com.flmr.trader.engine.Candle;
import com.flmr.trader.engine.ChartReader;
import com.flmr.trader.engine.PriceScale;
import com.flmr.trader.engine.Strategy;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** Observe -> analyse -> decide -> execute -> manage. Runs on its own thread inside the service. */
final class Bot {
    private final FlmrService svc;
    private final Mt5Driver drv;
    private Overlay ov;
    private volatile boolean running, auto, scanNow, debugNow, dumpNow;
    private Thread th;
    private long lastScan, lastTradeMs;
    private String lastKey = "";
    private int dayCount;
    private String day = "";
    private int openDir; // +1 buy, -1 sell, 0 unknown/none
    private long openSince; // time the oldest tracked trade was opened

    // kept for the DEBUG button
    private FlmrService.Shot lastShot;
    private ChartReader.Result lastRead;
    private List<double[]> lastLabels;
    private PriceScale lastScale;
    private int[] lastRegion = new int[5];
    private String lastSummary = "";

    Bot(FlmrService svc) {
        this.svc = svc;
        this.drv = new Mt5Driver(svc);
    }

    void attach(Overlay o) { ov = o; }

    boolean isAuto() { return auto; }

    void setAuto(boolean on) {
        auto = on;
        if (on) { lastScan = 0; Flog.i(Cfg.b(svc, Cfg.DRY, true) ? "AUTO on (paper: no orders)" : "AUTO on (LIVE orders)"); }
        else Flog.i("AUTO off");
        if (ov != null) ov.refresh();
    }

    void requestScan() { scanNow = true; }
    void requestDebug() { debugNow = true; }
    void requestDump() { dumpNow = true; }

    void start() {
        if (running) return;
        running = true;
        th = new Thread(this::loop, "flmr-bot");
        th.start();
    }

    void stop() { running = false; auto = false; if (th != null) th.interrupt(); }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) { } }

    private void loop() {
        while (running) {
            try {
                if (dumpNow) { dumpNow = false; doDump(); }
                if (debugNow) { debugNow = false; doDebug(); }
                long every = Math.max(5, Cfg.i(svc, Cfg.INTERVAL, 20)) * 1000L;
                boolean timer = auto && System.currentTimeMillis() - lastScan >= every;
                if (scanNow || timer) {
                    scanNow = false;
                    lastScan = System.currentTimeMillis();
                    cycle();
                }
                Thread.sleep(300);
            } catch (InterruptedException e) {
                return;
            } catch (Throwable t) {
                Flog.i("error: " + t.getClass().getSimpleName() + " " + t.getMessage());
                sleep(2000);
            }
        }
    }

    private void doDump() {
        ov.setHidden(true); sleep(150);
        String d = drv.dump();
        ov.setHidden(false);
        String name = "ui_dump_" + new SimpleDateFormat("HHmmss", Locale.US).format(new Date()) + ".txt";
        boolean ok = Files.saveText(svc, name, d);
        Flog.i(ok ? "UI dump saved: Downloads/FLMR/" + name : "UI dump failed");
    }

    private void doDebug() {
        if (lastShot == null) { Flog.i("run SCAN first"); return; }
        android.graphics.Bitmap m = DebugImage.draw(lastShot, lastRegion[0], lastRegion[1], lastRegion[2], lastRegion[3],
                lastRegion[4], lastRead, lastLabels, lastScale, lastSummary);
        String name = "flmr_debug_" + new SimpleDateFormat("HHmmss", Locale.US).format(new Date()) + ".png";
        Flog.i(Files.savePng(svc, name, m) ? "debug image saved: Pictures/FLMR" : "debug save failed");
    }

    private void cycle() throws InterruptedException {
        if (!drv.foreground()) {
            ov.setSignal("WAIT", "MT5 is not in front");
            Flog.i("open MT5 on a chart");
            return;
        }
        ov.setHidden(true);
        sleep(180);
        FlmrService.Shot s = svc.screenshot();
        ov.setHidden(false);
        if (s == null) { Flog.i("no screenshot"); return; }
        lastShot = s;
        if (blank(s.px)) { ov.setSignal("WAIT", "black frame"); Flog.i("black frame, screen secured?"); return; }

        int w = s.w, h = s.h;
        int top = h * Cfg.i(svc, Cfg.M_TOP, 14) / 100, bot = h * Cfg.i(svc, Cfg.M_BOT, 13) / 100;
        int right = w * Cfg.i(svc, Cfg.M_RIGHT, 13) / 100, left = w * Cfg.i(svc, Cfg.M_LEFT, 0) / 100;
        int x0 = left, y0 = top, x1 = w - right, y1 = h - bot, axis = w - right;
        lastRegion = new int[]{x0, y0, x1, y1, axis};

        ChartReader.Result r = ChartReader.read(s.px, w, h, x0, y0, x1, y1, Cfg.i(svc, Cfg.COLOR, 0));
        lastRead = r; lastLabels = null; lastScale = null;
        lastSummary = r.candles.size() + " candles " + r.colors;
        if (r.candles.size() < 41) {
            ov.setSignal("WAIT", "saw " + r.candles.size() + " candles");
            Flog.i("too few candles: zoom out, check colours, press DEBUG");
            return;
        }
        if (r.medianWidth < 3) {
            ov.setSignal("WAIT", "zoom in chart");
            Flog.i("candles too thin (" + r.medianWidth + "px): zoom in a little");
            return;
        }

        List<double[]> labels = PriceOcr.read(s.bmp, axis, y0, w - axis, y1 - y0);
        lastLabels = labels;
        PriceScale sc = PriceScale.fit(labels);
        lastScale = sc;
        if (sc == null) {
            ov.setSignal("WAIT", "price axis unreadable");
            Flog.i("axis OCR failed (" + labels.size() + " labels): press DEBUG");
            return;
        }

        List<Candle> cs = ChartReader.toPrices(r.candles, sc);
        Strategy.Params p = new Strategy.Params();
        p.threshold = Cfg.i(svc, Cfg.THR, 4);
        p.slAtr = Cfg.d(svc, Cfg.SL_ATR, 1.5);
        p.rr = Cfg.d(svc, Cfg.RR, 2.0);
        p.scalp = Cfg.b(svc, Cfg.SCALP, false);
        Strategy.Decision d = Strategy.decide(cs, p, sc.decimals);

        String info = "score " + d.score + "  rsi " + Math.round(d.rsi) + "\n" + d.why;
        if (!d.action.equals("WAIT"))
            info += String.format(Locale.US, "\nSL %." + sc.decimals + "f  TP %." + sc.decimals + "f", d.sl, d.tp);
        ov.setSignal(d.action, info);
        Flog.i(d.action + " score " + d.score + " (" + r.candles.size() + " candles)");

        if (auto && !Cfg.b(svc, Cfg.DRY, true)) timeStop();
        if (!auto || d.action.equals("WAIT")) return;
        trade(d);
    }

    /** Scalp time stop: flatten everything when the oldest trade has been open too long. */
    private void timeStop() {
        double hold = Cfg.d(svc, Cfg.HOLD_MIN, 0);
        if (hold <= 0 || openSince == 0 || System.currentTimeMillis() - openSince < hold * 60000L) return;
        ov.setHidden(true);
        String res = drv.closeAll();
        ov.setHidden(false);
        Flog.i("time stop: " + res);
        openSince = 0; openDir = 0;
    }

    private void trade(Strategy.Decision d) {
        if (d.key.equals(lastKey)) return;
        boolean buy = d.action.equals("BUY");
        int dir = buy ? 1 : -1;
        double lot = Cfg.d(svc, Cfg.LOT, 0.01);

        if (Cfg.b(svc, Cfg.DRY, true)) {
            Flog.i("PAPER " + d.action + " " + lot + " sl " + fmt(d.sl, d.decimals) + " tp " + fmt(d.tp, d.decimals));
            lastKey = d.key;
            return;
        }

        String today = new SimpleDateFormat("yyyyMMdd", Locale.US).format(new Date());
        if (!today.equals(day)) { day = today; dayCount = 0; }
        if (dayCount >= Cfg.i(svc, Cfg.MAX_DAY, 6)) { Flog.i("daily trade cap reached"); return; }

        int open = 0;
        if (Cfg.b(svc, Cfg.POS_CHECK, true)) {
            ov.setHidden(true);
            open = drv.readOpenCount();
            ov.setHidden(false);
            if (open < 0) { Flog.i("cannot read positions, skipping trade"); return; }
        }
        if (open == 0) { openDir = 0; openSince = 0; }

        if (open > 0 && openDir == -dir) {
            ov.setHidden(true);
            String res = drv.closeAll();
            ov.setHidden(false);
            Flog.i("reversal signal: " + res);
            openDir = 0; openSince = 0;
            lastKey = d.key;
            lastTradeMs = System.currentTimeMillis();
            return;
        }
        if (open >= Cfg.i(svc, Cfg.MAX_OPEN, 1)) { Flog.i("max open trades reached"); return; }
        if (System.currentTimeMillis() - lastTradeMs < (long) (Cfg.d(svc, Cfg.COOLDOWN, 15) * 60000L)) { Flog.i("cooldown"); return; }

        ov.setHidden(true);
        String res = drv.openTrade(buy, lot, d.sl, d.tp, d.decimals);
        ov.setHidden(false);
        Flog.i(res);
        lastKey = d.key;
        if (res.startsWith("OK")) { dayCount++; lastTradeMs = System.currentTimeMillis(); openDir = dir; if (openSince == 0) openSince = System.currentTimeMillis(); }
    }

    private static String fmt(double v, int dec) { return String.format(Locale.US, "%." + Math.max(dec, 0) + "f", v); }

    private static boolean blank(int[] px) {
        for (int v : px) {
            int r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
            if (Math.max(r, Math.max(g, b)) > 40) return false;
        }
        return true;
    }
}
