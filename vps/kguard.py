"""Kanairy spread/session guard for Python bots. Used by krun.py; blocks only NEW orders, never closes or stop changes."""
import json, os, time, datetime

DATA = os.environ.get("KANAIRY_DATA", ".")
SYM = os.environ.get("KANAIRY_SYMBOL", "XAUUSD")
_cache = {"t": 0, "f": {}}


def load_filter():
    if time.time() - _cache["t"] > 2:
        try:
            with open(os.path.join(DATA, "filter.json")) as fh:
                _cache["f"] = json.load(fh)
        except Exception:
            _cache["f"] = {}
        _cache["t"] = time.time()
    return _cache["f"]


def in_window(spec, now=None):
    """spec like '21:55-23:05,12:25-12:40' in UTC."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    m = now.hour * 60 + now.minute
    for part in str(spec or "").split(","):
        part = part.strip()
        if "-" not in part:
            continue
        try:
            a, b = part.split("-")
            a = int(a[:2]) * 60 + int(a[3:5]); b = int(b[:2]) * 60 + int(b[3:5])
        except Exception:
            continue
        if (a <= b and a <= m < b) or (a > b and (m >= a or m < b)):
            return True
    return False


def check(spread, f=None, now=None):
    """Returns (ok, reason). spread is in price units (dollars for gold)."""
    f = f if f is not None else load_filter()
    if not f.get("on", True):
        return True, ""
    ms = float(f.get("maxSpread") or 0)
    if ms > 0 and spread is not None and spread > ms:
        return False, "spread %.2f is above your limit %.2f" % (spread, ms)
    if in_window(f.get("windows"), now):
        return False, "inside a pause window"
    return True, ""


def install():
    import MetaTrader5 as mt5
    real = mt5.order_send

    def guarded(request, *a, **k):
        try:
            opening = isinstance(request, dict) and request.get("action") in (mt5.TRADE_ACTION_DEAL, mt5.TRADE_ACTION_PENDING) and not request.get("position")
            if opening:
                sym = request.get("symbol", SYM)
                t = mt5.symbol_info_tick(sym)
                ok, why = check((t.ask - t.bid) if t else None)
                if not ok:
                    try:
                        with open(os.path.join(DATA, "guard.log"), "a") as fh:
                            fh.write("%d %s\n" % (time.time(), why))
                    except Exception:
                        pass
                    class R:  # looks like a rejected order to the bot
                        retcode = 10006; comment = "Kanairy guard: " + why; order = 0; deal = 0; volume = 0; price = 0
                    return R()
        except Exception:
            pass
        return real(request, *a, **k)

    mt5.order_send = guarded
