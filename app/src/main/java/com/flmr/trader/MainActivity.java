package com.flmr.trader;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import java.util.LinkedHashMap;
import java.util.Map;

public class MainActivity extends Activity {
    private final Map<String, EditText> fields = new LinkedHashMap<>();
    private TextView status;
    private LinearLayout box;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(0xFF0B0F14);
        sv.setOnApplyWindowInsetsListener((v, ins) -> {
            android.graphics.Insets i = ins.getInsets(WindowInsets.Type.systemBars());
            v.setPadding(0, i.top, 0, i.bottom);
            return ins;
        });
        box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(18), dp(18), dp(40));
        sv.addView(box);
        setContentView(sv);

        TextView t = text("FLMR AI Trader", 26, 0xFF16C784, true);
        box.addView(t);
        box.addView(text("Watches your MT5 chart, decides BUY / SELL / WAIT, places the order. All on this phone.", 13, 0xFFB0B8C4, false));

        status = text("", 13, 0xFFF0B90B, true);
        status.setPadding(0, dp(14), 0, dp(6));
        box.addView(status);

        box.addView(label("SETUP"));
        box.addView(btn("1  Allow restricted settings (⋮ menu on next screen)", 0xFF2A3441, v -> startActivity(
                new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())))));
        box.addView(btn("2  Turn on FLMR in Accessibility", 0xFF2A3441, v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))));
        box.addView(btn("3  Set battery to Unrestricted", 0xFF2A3441, v -> startActivity(
                new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())))));

        box.addView(btn("LAUNCH FLMR + OPEN MT5", 0xFF16A34A, v -> launch()));

        box.addView(label("MODE"));
        Switch paper = new Switch(this);
        paper.setText("Paper mode (decide and log, never place orders)");
        paper.setTextColor(Color.WHITE);
        paper.setChecked(Cfg.b(this, Cfg.DRY, true));
        paper.setOnCheckedChangeListener((c, on) -> {
            Cfg.putB(this, Cfg.DRY, on);
            if (FlmrService.instance != null) FlmrService.instance.showOverlay();
            toast(on ? "Paper mode on" : "LIVE mode: orders will be placed");
        });
        box.addView(paper);
        Switch pos = new Switch(this);
        pos.setText("Check open positions before each entry");
        pos.setTextColor(Color.WHITE);
        pos.setChecked(Cfg.b(this, Cfg.POS_CHECK, true));
        pos.setOnCheckedChangeListener((c, on) -> Cfg.putB(this, Cfg.POS_CHECK, on));
        box.addView(pos);

        Switch scalp = new Switch(this);
        scalp.setText("Scalp mode (fast, many small trades, use a 1 minute chart)");
        scalp.setTextColor(Color.WHITE);
        scalp.setChecked(Cfg.b(this, Cfg.SCALP, false));
        scalp.setOnCheckedChangeListener((c, on) -> {
            Cfg.putB(this, Cfg.SCALP, on);
            String[][] pre = on
                    ? new String[][]{{Cfg.THR, "3"}, {Cfg.SL_ATR, "0.8"}, {Cfg.RR, "1.2"}, {Cfg.INTERVAL, "6"}, {Cfg.MAX_OPEN, "3"}, {Cfg.MAX_DAY, "40"}, {Cfg.COOLDOWN, "0.5"}, {Cfg.HOLD_MIN, "5"}}
                    : new String[][]{{Cfg.THR, "4"}, {Cfg.SL_ATR, "1.5"}, {Cfg.RR, "2"}, {Cfg.INTERVAL, "20"}, {Cfg.MAX_OPEN, "1"}, {Cfg.MAX_DAY, "6"}, {Cfg.COOLDOWN, "15"}, {Cfg.HOLD_MIN, "0"}};
            for (String[] kv : pre) {
                Cfg.put(this, kv[0], kv[1]);
                EditText et = fields.get(kv[0]);
                if (et != null) et.setText(kv[1]);
            }
            toast(on ? "Scalp preset applied" : "Normal preset applied");
        });
        box.addView(scalp);

        box.addView(label("STRATEGY"));
        field("Lot size", Cfg.LOT, "0.01");
        field("Stop loss (x ATR)", Cfg.SL_ATR, "1.5");
        field("Take profit (risk:reward)", Cfg.RR, "2");
        field("Signal threshold (score needed)", Cfg.THR, "4");
        field("Scan every (seconds)", Cfg.INTERVAL, "20");
        field("Max open trades", Cfg.MAX_OPEN, "1");
        field("Max trades per day", Cfg.MAX_DAY, "6");
        field("Cooldown between trades (min)", Cfg.COOLDOWN, "15");
        field("Close all after (min, 0 = off)", Cfg.HOLD_MIN, "0");

        box.addView(label("CHART READING"));
        box.addView(text("Candle colours", 12, 0xFFB0B8C4, false));
        Spinner sp = new Spinner(this);
        ArrayAdapter<String> ad = new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item,
                new String[]{"Auto detect", "Green up / Red down", "Blue up / Red down", "Green up / Blue down", "Red up / Green down"});
        sp.setAdapter(ad);
        sp.setSelection(Cfg.i(this, Cfg.COLOR, 0));
        sp.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> p, View v, int pos, long id) { Cfg.put(MainActivity.this, Cfg.COLOR, String.valueOf(pos)); }
            @Override public void onNothingSelected(AdapterView<?> p) { }
        });
        box.addView(sp);
        field("Ignore top of screen (%)", Cfg.M_TOP, "14");
        field("Ignore bottom of screen (%)", Cfg.M_BOT, "13");
        field("Price axis width (%)", Cfg.M_RIGHT, "13");
        field("Ignore left (%)", Cfg.M_LEFT, "0");
        field("New Order button X (%) optional", Cfg.NO_X, "0");
        field("New Order button Y (%) optional", Cfg.NO_Y, "0");

        box.addView(btn("SAVE SETTINGS", 0xFF1F6FEB, v -> { save(); toast("Saved"); }));

        TextView note = text("Start in Paper mode. Use SCAN then DEBUG on the overlay to check FLMR reads your chart correctly. "
                + "Trading is risky and FLMR can lose money. Test on a demo account first.", 11.5f, 0xFF7D8796, false);
        note.setPadding(0, dp(18), 0, 0);
        box.addView(note);
    }

    @Override protected void onResume() {
        super.onResume();
        boolean on = serviceEnabled();
        status.setText(on ? "Accessibility: ON  ·  ready" : "Accessibility: OFF  ·  finish steps 1 and 2");
        status.setTextColor(on ? 0xFF16C784 : 0xFFF0B90B);
    }

    @Override protected void onPause() { super.onPause(); save(); }

    private boolean serviceEnabled() {
        String s = Settings.Secure.getString(getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (s == null) return false;
        String me = new ComponentName(this, FlmrService.class).flattenToString();
        String me2 = new ComponentName(this, FlmrService.class).flattenToShortString();
        return s.contains(me) || s.contains(me2);
    }

    private void launch() {
        save();
        if (!serviceEnabled() || FlmrService.instance == null) {
            toast("Turn on FLMR in Accessibility first");
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            return;
        }
        FlmrService.instance.showOverlay();
        Intent i = getPackageManager().getLaunchIntentForPackage(Mt5Driver.PKG);
        if (i == null) { toast("MT5 is not installed"); return; }
        startActivity(i);
    }

    private void save() {
        for (Map.Entry<String, EditText> e : fields.entrySet()) {
            String v = e.getValue().getText().toString().trim();
            if (!v.isEmpty()) Cfg.put(this, e.getKey(), v);
        }
    }

    private void field(String label, String key, String def) {
        box.addView(text(label, 12, 0xFFB0B8C4, false));
        EditText e = new EditText(this);
        e.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        e.setText(Cfg.s(this, key, def));
        e.setTextColor(Color.WHITE);
        e.setTextSize(15);
        fields.put(key, e);
        box.addView(e);
    }

    private TextView label(String s) {
        TextView t = text(s, 11, 0xFF16C784, true);
        t.setPadding(0, dp(20), 0, dp(6));
        return t;
    }

    private TextView text(String s, float size, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(size);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private TextView btn(String s, int color, View.OnClickListener l) {
        TextView t = text(s, 13, Color.WHITE, true);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(12), dp(14), dp(12), dp(14));
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(10));
        t.setBackground(g);
        t.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(8);
        t.setLayoutParams(lp);
        return t;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }
}
