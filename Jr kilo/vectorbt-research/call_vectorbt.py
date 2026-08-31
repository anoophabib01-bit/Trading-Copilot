import sys
import json
import argparse
import time
from pathlib import Path

try:
    import pandas as pd
    import numpy as np
except ImportError as e:
    print(json.dumps({"error": f"Missing dependency: {e}"}))
    sys.exit(1)

from run_sweep import load_rules, load_data, simulate_trades


STRATEGIES = {
    "dsh_v2": run_dsh_v2,
}


def run_dsh_v2(params: dict) -> dict:
    adx_min = int(params.get("adx_min", 35))
    lookback = int(params.get("lookback", 10))
    timeframe = str(params.get("timeframe", "60"))

    start = time.time()
    rules = load_rules()
    df = load_data(timeframe)

    print(f"Running DSH V2: adx_min={adx_min}, lookback={lookback}, timeframe={timeframe}", file=sys.stderr)
    print(f"Loaded {len(df)} bars", file=sys.stderr)

    res = simulate_trades(df, adx_min, lookback, rules)
    res["runtime_sec"] = round(time.time() - start, 3)
    res["timeframe"] = timeframe
    res["bar_count"] = len(df)
    res["date_range"] = {
        "start": str(df["timestamp"].iloc[0]) if len(df) > 0 else None,
        "end": str(df["timestamp"].iloc[-1]) if len(df) > 0 else None,
    }
    return res


def main():
    parser = argparse.ArgumentParser(description="VectorBT strategy runner")
    parser.add_argument("--strategy", required=True, choices=list(STRATEGIES.keys()), help="Strategy name")
    parser.add_argument("--params", required=True, help="JSON string of strategy parameters")
    args = parser.parse_args()

    try:
        params = json.loads(args.params)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON params: {e}"}))
        sys.exit(1)

    if args.strategy not in STRATEGIES:
        print(json.dumps({"error": f"Unknown strategy: {args.strategy}"}))
        sys.exit(1)

    try:
        result = STRATEGIES[args.strategy](params)
        print(json.dumps(result, default=str))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
