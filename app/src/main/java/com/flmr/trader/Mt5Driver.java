package com.flmr.trader;

import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/** Drives the MT5 Android UI through the accessibility tree. Text-matched, so it survives layout shifts. */
final class Mt5Driver {
    static final String PKG = "net.metaquotes.metatrader5";
    private final FlmrService svc;
    private final int screenH;

    Mt5Driver(FlmrService svc) {
        this.svc = svc;
        this.screenH = svc.getResources().getDisplayMetrics().heightPixels;
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) { } }

    // ---------- tree helpers ----------

    boolean foreground() {
        AccessibilityNodeInfo r = svc.getRootInActiveWindow();
        if (r == null || r.getPackageName() == null) return false;
        return PKG.equals(r.getPackageName().toString());
    }

    private List<AccessibilityNodeInfo> all() {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        AccessibilityNodeInfo r = svc.getRootInActiveWindow();
        if (r != null) walk(r, out, 0);
        return out;
    }

    private void walk(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> out, int depth) {
        if (n == null || depth > 40) return;
        out.add(n);
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), out, depth + 1);
    }

    private static String label(AccessibilityNodeInfo n) {
        CharSequence t = n.getText();
        if (t != null && t.length() > 0) return t.toString().trim();
        CharSequence d = n.getContentDescription();
        return d == null ? "" : d.toString().trim();
    }

    private AccessibilityNodeInfo find(Predicate<AccessibilityNodeInfo> p) {
        for (AccessibilityNodeInfo n : all()) if (p.test(n)) return n;
        return null;
    }

    private boolean has(String regex) {
        Pattern p = Pattern.compile(regex, Pattern.CASE_INSENSITIVE);
        return find(n -> p.matcher(label(n)).find()) != null;
    }

    private boolean click(AccessibilityNodeInfo n) {
        if (n == null) return false;
        AccessibilityNodeInfo c = n;
        for (int g = 0; c != null && !c.isClickable() && g < 6; g++) c = c.getParent();
        if (c != null && c.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        return svc.tap(b.exactCenterX(), b.exactCenterY());
    }

    private boolean setText(AccessibilityNodeInfo n, String s) {
        n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, s);
        return n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
    }

    private boolean tapBottomTab(String name) {
        AccessibilityNodeInfo n = find(x -> {
            Rect b = new Rect();
            x.getBoundsInScreen(b);
            return label(x).equalsIgnoreCase(name) && b.centerY() > screenH * 0.8;
        });
        return click(n);
    }

    // ---------- order screen ----------

    private boolean isOrderScreen() {
        return has("stop loss|s/l") && has("take profit|t/p");
    }

    private boolean openOrderScreen() {
        Pattern p = Pattern.compile("new order|new trade", Pattern.CASE_INSENSITIVE);
        AccessibilityNodeInfo n = find(x -> p.matcher(label(x)).find());
        if (n != null && click(n)) return true;
        double fx = Cfg.d(svc, Cfg.NO_X, 0), fy = Cfg.d(svc, Cfg.NO_Y, 0);
        if (fx > 0 && fy > 0) {
            float w = svc.getResources().getDisplayMetrics().widthPixels;
            return svc.tap((float) (w * fx / 100.0), (float) (screenH * fy / 100.0));
        }
        return false;
    }

    private String fieldLabel(AccessibilityNodeInfo n) {
        StringBuilder sb = new StringBuilder();
        if (n.getHintText() != null) sb.append(n.getHintText()).append(' ');
        if (n.getContentDescription() != null) sb.append(n.getContentDescription()).append(' ');
        AccessibilityNodeInfo par = n.getParent();
        if (par != null) {
            int idx = -1;
            for (int i = 0; i < par.getChildCount(); i++) {
                AccessibilityNodeInfo ch = par.getChild(i);
                if (ch != null && ch.equals(n)) { idx = i; break; }
            }
            if (idx > 0) {
                AccessibilityNodeInfo prev = par.getChild(idx - 1);
                if (prev != null) sb.append(label(prev)).append(' ');
            }
            if (par.getContentDescription() != null) sb.append(par.getContentDescription());
        }
        return sb.toString().toLowerCase(Locale.US);
    }

    private static String fmt(double v, int dec) { return String.format(Locale.US, "%." + Math.max(dec, 0) + "f", v); }

    /** Fills the order form and presses Buy/Sell. Returns "OK ..." or an error string. */
    String openTrade(boolean buy, double lot, double sl, double tp, int dec) {
        if (!foreground()) return "MT5 not in front";
        if (!isOrderScreen()) {
            if (!openOrderScreen()) return "cannot open order screen, use DUMP UI or set New Order tap position";
            sleep(1200);
        }
        if (!isOrderScreen()) return "order screen not detected";

        List<AccessibilityNodeInfo> edits = new ArrayList<>();
        for (AccessibilityNodeInfo n : all()) {
            String cn = n.getClassName() == null ? "" : n.getClassName().toString();
            if (n.isEditable() || cn.contains("EditText")) edits.add(n);
        }
        AccessibilityNodeInfo vol = null, slN = null, tpN = null;
        for (AccessibilityNodeInfo n : edits) {
            String l = fieldLabel(n);
            if (vol == null && (l.contains("volume") || l.contains("lot"))) vol = n;
            else if (slN == null && (l.contains("stop loss") || l.contains("s/l"))) slN = n;
            else if (tpN == null && (l.contains("take profit") || l.contains("t/p"))) tpN = n;
        }
        if ((vol == null || slN == null || tpN == null) && edits.size() >= 3) {
            edits.sort((a, b) -> {
                Rect ra = new Rect(), rb = new Rect();
                a.getBoundsInScreen(ra); b.getBoundsInScreen(rb);
                return Integer.compare(ra.top, rb.top);
            });
            vol = edits.get(0); slN = edits.get(1); tpN = edits.get(2);
        }
        if (vol == null || slN == null || tpN == null) return "volume/SL/TP fields not found";

        String sLot = fmt(lot, 2), sSl = fmt(sl, dec), sTp = fmt(tp, dec);
        if (!setText(vol, sLot) || !setText(slN, sSl) || !setText(tpN, sTp)) return "field refused text input";
        sleep(500);
        vol.refresh(); slN.refresh(); tpN.refresh();
        if (!same(vol, lot) || !same(slN, sl) || !same(tpN, tp)) {
            svc.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
            return "field values did not stick, order cancelled";
        }

        final String side = buy ? "buy" : "sell";
        AccessibilityNodeInfo btn = null;
        int bestY = -1;
        for (AccessibilityNodeInfo n : all()) {
            String l = label(n).toLowerCase(Locale.US);
            if (!l.startsWith(side) || l.contains("limit") || l.contains("stop")) continue;
            Rect b = new Rect();
            n.getBoundsInScreen(b);
            if (b.centerY() > bestY) { bestY = b.centerY(); btn = n; }
        }
        if (btn == null) return side + " button not found";
        if (!click(btn)) return side + " click failed";
        sleep(1800);

        if (has("invalid|error|rejected|not enough|no money|off quotes|market closed")) {
            svc.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
            return "broker reported an error";
        }
        if (isOrderScreen()) svc.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
        return "OK " + side + " " + sLot + " sl " + sSl + " tp " + sTp;
    }

    private boolean same(AccessibilityNodeInfo n, double want) {
        try {
            String t = n.getText() == null ? "" : n.getText().toString().replace(',', '.').trim();
            return Math.abs(Double.parseDouble(t) - want) < Math.max(1e-9, Math.abs(want) * 1e-6);
        } catch (Exception e) { return false; }
    }

    // ---------- positions ----------

    private static final Pattern POS = Pattern.compile("^[A-Z0-9._#]+,?\\s+(buy|sell)\\s+[0-9.,]+", Pattern.CASE_INSENSITIVE);

    private List<AccessibilityNodeInfo> positionRows() {
        List<AccessibilityNodeInfo> rows = new ArrayList<>();
        List<Integer> tops = new ArrayList<>();
        for (AccessibilityNodeInfo n : all()) {
            if (!POS.matcher(label(n)).find()) continue;
            Rect b = new Rect();
            n.getBoundsInScreen(b);
            if (tops.contains(b.top)) continue;
            tops.add(b.top);
            rows.add(n);
        }
        return rows;
    }

    /** Number of open positions, or -1 if the Trade tab could not be read. */
    int readOpenCount() {
        if (!foreground()) return -1;
        if (!tapBottomTab("Trade")) return -1;
        sleep(1000);
        int n = positionRows().size();
        tapBottomTab("Chart");
        sleep(800);
        return n;
    }

    /** Best effort: closes open positions one by one through the position menu. */
    String closeAll() {
        if (!foreground()) return "MT5 not in front";
        if (!tapBottomTab("Trade")) return "Trade tab not found";
        sleep(1000);
        int closed = 0;
        Pattern menu = Pattern.compile("^close (position|order).*|^close$", Pattern.CASE_INSENSITIVE);
        Pattern confirm = Pattern.compile("^(close|ok|yes|confirm|close position)$", Pattern.CASE_INSENSITIVE);
        for (int guard = 0; guard < 5; guard++) {
            List<AccessibilityNodeInfo> rows = positionRows();
            if (rows.isEmpty()) break;
            click(rows.get(0));
            sleep(800);
            AccessibilityNodeInfo m = find(x -> menu.matcher(label(x)).find());
            if (m == null) { svc.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK); break; }
            click(m);
            sleep(800);
            AccessibilityNodeInfo c = find(x -> confirm.matcher(label(x)).find() && x.isClickable());
            if (c != null) click(c);
            sleep(1400);
            closed++;
        }
        tapBottomTab("Chart");
        sleep(700);
        return "closed " + closed;
    }

    // ---------- diagnostics ----------

    /** Text dump of everything MT5 exposes right now. */
    String dump() {
        StringBuilder sb = new StringBuilder();
        AccessibilityNodeInfo r = svc.getRootInActiveWindow();
        if (r == null) return "no active window";
        dumpNode(r, 0, sb);
        return sb.toString();
    }

    private void dumpNode(AccessibilityNodeInfo n, int d, StringBuilder sb) {
        if (n == null || d > 40) return;
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        String cn = n.getClassName() == null ? "" : n.getClassName().toString();
        cn = cn.substring(cn.lastIndexOf('.') + 1);
        for (int i = 0; i < d; i++) sb.append(' ');
        sb.append(cn);
        if (n.getViewIdResourceName() != null) sb.append(" id=").append(n.getViewIdResourceName());
        if (n.getText() != null) sb.append(" t='").append(n.getText()).append('\'');
        if (n.getContentDescription() != null) sb.append(" d='").append(n.getContentDescription()).append('\'');
        if (n.getHintText() != null) sb.append(" h='").append(n.getHintText()).append('\'');
        if (n.isClickable()) sb.append(" C");
        if (n.isEditable()) sb.append(" E");
        sb.append(" [").append(b.left).append(',').append(b.top).append(',').append(b.right).append(',').append(b.bottom).append("]\n");
        for (int i = 0; i < n.getChildCount(); i++) dumpNode(n.getChild(i), d + 1, sb);
    }
}
