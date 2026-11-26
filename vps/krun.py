"""Runs a Python bot with the Kanairy guard installed:  python krun.py bot.run.py"""
import os, runpy, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
script = sys.argv[1]
try:
    import kguard
    kguard.install()
except ImportError:
    print("MetaTrader5 package missing: pip install MetaTrader5", flush=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(script)))
sys.argv = [script]
runpy.run_path(script, run_name="__main__")
