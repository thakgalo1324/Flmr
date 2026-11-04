# FLMR AI Trader

Android app that floats over MT5, reads the chart from the screen, decides BUY / SELL / WAIT and places the order in the MT5 Android app. No PC, no VPS, no cloud, no internet permission.

## Build the APK (phone only)
1. Create a GitHub repo, upload this whole folder (keep the `.github` folder).
2. Open the **Actions** tab, wait for "Build FLMR APK" to go green (about 5 min).
3. Open **Releases**, tap `FLMR-AI-Trader.apk` to download and install.

## First run on the Galaxy A06 (Android 16)
1. Open FLMR, tap step 1, in App info tap ⋮ then **Allow restricted settings**.
2. Tap step 2, Installed apps, FLMR, turn on.
3. Tap step 3 and set Battery to Unrestricted.
4. Open an MT5 chart (candles, not line) with about 70 to 120 candles visible.
5. Tap **LAUNCH FLMR + OPEN MT5**. The panel floats over MT5.
6. Stay in **PAPER** mode. Tap SCAN, then DEBUG (saves an annotated image to Pictures/FLMR). Yellow box must cover only candles, cyan box the price axis.
7. Tap **DUMP UI** on the New Order screen and Trade tab (saves to Downloads/FLMR) if buttons are not found.
8. When paper signals look right, turn Paper mode off on a DEMO account first.

## How it decides
Score from trend (EMA20/50), MACD, RSI, candlestick patterns (engulfing, hammer, shooting star, morning/evening star), 20-bar breakouts, swing support/resistance, double top/bottom. Only closed candles count. BUY/SELL needs score >= threshold (default 4). SL = ATR based or beyond recent swing, TP = risk:reward multiple.

## Safety rails
Paper mode default, max open trades, daily cap, cooldown, one trade per signal candle, no trade if price axis cannot be read, order values verified before pressing Buy/Sell.

## Scalp mode
Switch on **Scalp mode** in the app (applies a preset: threshold 3, SL 0.8 ATR, RR 1.2, scan every 6s, up to 3 open trades, 40 per day, 30s cooldown, close all after 5 min). Use a 1 minute chart. Each decision takes roughly 4 to 10 seconds because FLMR reads the screen and taps the MT5 UI, so this is fast minute-level scalping, not tick scalping.
