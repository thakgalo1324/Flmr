package com.flmr.trader;

import android.graphics.Bitmap;
import android.graphics.Rect;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Reads the price axis on-device (ML Kit, bundled model, no network). */
public final class PriceOcr {
    private PriceOcr() {}
    private static final Pattern NUM = Pattern.compile("\\d[\\d.,]*\\d");

    /** Returns {y, price, decimals} per label found in the crop. */
    public static List<double[]> read(Bitmap full, int left, int top, int w, int h) {
        List<double[]> out = new ArrayList<>();
        TextRecognizer rec = null;
        try {
            Bitmap crop = Bitmap.createBitmap(full, left, top, w, h);
            float sc = 2f;
            Bitmap big = Bitmap.createScaledBitmap(crop, (int) (w * sc), (int) (h * sc), true);
            rec = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
            Text t = Tasks.await(rec.process(InputImage.fromBitmap(big, 0)), 10, TimeUnit.SECONDS);
            for (Text.TextBlock b : t.getTextBlocks()) {
                for (Text.Line ln : b.getLines()) {
                    Rect r = ln.getBoundingBox();
                    if (r == null) continue;
                    double[] v = parse(ln.getText());
                    if (v == null) continue;
                    out.add(new double[]{top + r.centerY() / sc, v[0], v[1]});
                }
            }
        } catch (Exception e) {
            Flog.i("ocr failed: " + e.getMessage());
        } finally {
            if (rec != null) rec.close();
        }
        return out;
    }

    static double[] parse(String raw) {
        String s = raw.replace('O', '0').replace('o', '0').replace(" ", "");
        Matcher m = NUM.matcher(s);
        if (!m.find()) return null;
        String t = m.group();
        boolean dot = t.contains("."), com = t.contains(",");
        if (dot && com) t = t.replace(",", "");
        else if (com) t = t.replace(',', '.');
        int dec = t.contains(".") ? t.length() - t.lastIndexOf('.') - 1 : 0;
        try { return new double[]{Double.parseDouble(t), dec}; } catch (Exception e) { return null; }
    }
}
