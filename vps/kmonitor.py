"""Watches MT5 for any bot (mq5, ex5, py): live spread, filter state, and the real cost of every fill."""
import datetime, json, os, sys, time
import MetaTrader5 as mt5
import kguard

DATA = os.environ.get("KANAIRY_DATA", ".")
SYM = os.environ.get("KANAIRY_SYMBOL", "XAUUSD")
COSTS = os.path.join(DATA, "costs.jsonl")
UTC = datetime.timezone.utc


def put(name, obj):
    p = os.path.join(DATA, name)
    with open(p + ".tmp", "w") as fh:
        json.dump(obj, fh)
    os.replace(p + ".tmp", p)


def seen_tickets():
    s = set()
    try:
        with open(COSTS) as fh:
            for ln in fh:
                try: s.add(json.loads(ln)["ticket"])
                except Exception: pass
    except OSError:
        pass
    return s


def dt(x):
    return datetime.datetime.fromtimestamp(x, UTC)


def ingest(seen, since):
    deals = mt5.history_deals_get(dt(since), dt(time.time() + 3600)) or []
    out = []
    for d in deals:
        if d.ticket in seen or d.symbol != SYM or d.type not in (0, 1) or d.entry not in (0, 1):
            continue
        ms = getattr(d, "time_msc", d.time * 1000)
        ticks = mt5.copy_ticks_range(SYM, dt(ms / 1000 - 2), dt(ms / 1000 + 0.5), mt5.COPY_TICKS_ALL)
        tk = None
        if ticks is not None and len(ticks):
            before = [t for t in ticks if t["time_msc"] <= ms]
            tk = before[-1] if before else ticks[0]
        if tk is None:
            continue
        buy = d.type == 0
        ref = tk["ask"] if buy else tk["bid"]
        slip = (d.price - ref) if buy else (ref - d.price)   # positive = worse than the quote
        rec = dict(t=d.time, ticket=d.ticket, pos=d.position_id, entry=int(d.entry), side="buy" if buy else "sell", vol=d.volume,
                   price=d.price, ref=ref, slip=round(slip, 3), spread=round(tk["ask"] - tk["bid"], 3),
                   comm=round(d.commission, 2), swap=round(d.swap, 2), profit=round(d.profit, 2))
        out.append(rec)
    if out:
        with open(COSTS, "a") as fh:
            for r in out:
                fh.write(json.dumps(r) + "\n"); seen.add(r["ticket"])
    return len(out)


def main():
    os.makedirs(DATA, exist_ok=True)
    while not mt5.initialize():
        put("monitor.json", dict(up=False, err=str(mt5.last_error()), at=time.time()))
        time.sleep(5)
    seen = seen_tickets(); start = time.time() - 60; last_ing = 0
    while True:
        t = mt5.symbol_info_tick(SYM)
        sp = round(t.ask - t.bid, 3) if t else None
        ok, why = kguard.check(sp)
        put("monitor.json", dict(up=True, spread=sp, ok=ok, reason=why, at=time.time()))
        if time.time() - last_ing > 10:
            try: ingest(seen, start)
            except Exception as e: put("monitor.json", dict(up=True, spread=sp, ok=ok, reason=why, err=str(e), at=time.time()))
            last_ing = time.time()
        time.sleep(1)


if __name__ == "__main__":
    main()
