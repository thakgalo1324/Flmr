# Kanairy

Android trading robot for MT5. Floats over the MT5 app, reads the chart from the screen, runs the strategy you activate in the Strategy lab, and places the trades. No PC, no VPS, no trading server.

## Build the APK (phone only)
Push this folder to GitHub (keep `.github`). Open Actions, wait for the green tick, then Releases and tap `Kanairy.apk`.

## First run
1. Open Kanairy, Home, Setup: allow restricted settings, switch Kanairy on in Accessibility, set battery to Unrestricted.
2. Strategy lab: pick a template or import XML, press **Use for live trading**.
3. Open MT5 on a candle chart, press Launch / Show overlay. Kanairy finds the chart area and zooms by itself.
4. Stay in Paper mode, press Scan now, check the signal and Debug image.
5. If it cannot open the ticket: Teach New Order button once. Failures save a report to Downloads/Kanairy and Pictures/Kanairy, send those to the developer.
6. Turn Live orders on (demo account first), then Auto trading.

## How it works
- Screen capture (accessibility screenshot) at native resolution, price axis read on-device with ML Kit after 3x upscale, contrast stretch and sharpen.
- Candles read from pixels, converted to prices using the axis.
- Strategy lab XML runs in a hidden copy of the lab's own JavaScript engine, so what you test is what trades.
- Execution: accessibility tree first, OCR tap fallback, taught tap position, Quotes menu route.
- Safety: Paper mode default, max open, daily cap, cooldown, one trade per signal candle, time stop, values verified before Buy/Sell.
