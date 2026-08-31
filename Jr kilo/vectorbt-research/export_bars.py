import json
import csv
import sys
from pathlib import Path

try:
    import pandas as pd
except ImportError:
    print("pandas is required. Install with: pip install pandas", file=sys.stderr)
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
BARS_DIR = PROJECT_ROOT / "DATA" / "bars"
OUT_CSV = SCRIPT_DIR / "vectorbt_input.csv"

TIMEFRAME_ALIASES = {
    "mnq_15": "15",
    "mnq_30": "30",
    "mnq_60": "60",
    "mnq_240": "240",
}


def infer_timeframe(filepath: Path) -> str:
    name = filepath.stem
    if name in TIMEFRAME_ALIASES:
        return TIMEFRAME_ALIASES[name]
    if name.startswith("mnq_1h_"):
        return "60"
    return name.split("_")[-1]


def load_bars(filepath: Path) -> tuple:
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        bars = data.get("bars", [])
        tf = data.get("timeframe", infer_timeframe(filepath))
        symbol = data.get("symbol", filepath.stem)
    elif isinstance(data, list):
        bars = data
        tf = infer_timeframe(filepath)
        symbol = filepath.stem
    else:
        return [], infer_timeframe(filepath), filepath.stem
    return [b for b in bars if b and isinstance(b.get("time"), (int, float))], tf, symbol


def main():
    if not BARS_DIR.exists():
        print(f"Bars directory not found: {BARS_DIR}", file=sys.stderr)
        sys.exit(1)

    files = sorted(BARS_DIR.glob("mnq_*.json"))
    if not files:
        print(f"No mnq_*.json files found in {BARS_DIR}", file=sys.stderr)
        sys.exit(1)

    rows = []
    for f in files:
        bars, tf, symbol = load_bars(f)
        print(f"Loaded {len(bars)} bars from {f.name} -> timeframe={tf}", file=sys.stderr)
        for b in bars:
            ts = pd.Timestamp(b["time"], unit="s", tz="UTC")
            rows.append({
                "timestamp": ts.isoformat(),
                "open": float(b["open"]),
                "high": float(b["high"]),
                "low": float(b["low"]),
                "close": float(b["close"]),
                "volume": float(b.get("volume", 0)),
                "timeframe": tf,
                "symbol": symbol,
                "source_file": f.name,
            })

    df = pd.DataFrame(rows)
    df.sort_values(["timeframe", "timestamp"], inplace=True)
    df.drop_duplicates(subset=["timeframe", "timestamp"], keep="first", inplace=True)
    df.to_csv(OUT_CSV, index=False, encoding="utf-8")
    print(f"Wrote {len(df)} rows to {OUT_CSV}", file=sys.stderr)
    print(f"Timeframes: {sorted(df['timeframe'].unique())}", file=sys.stderr)


if __name__ == "__main__":
    main()
