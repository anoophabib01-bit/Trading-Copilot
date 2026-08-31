import sys
import json
import time
import argparse
from pathlib import Path

try:
    import pandas as pd
    import numpy as np
except ImportError as e:
    print(json.dumps({"error": f"Missing dependency: {e}"}))
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
DATA_DIR = PROJECT_ROOT / "DATA"
RULES_PATH = DATA_DIR / "rules.json"
CSV_PATH = SCRIPT_DIR / "vectorbt_input.csv"


def load_rules() -> dict:
    if RULES_PATH.exists():
        with open(RULES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def load_data(timeframe: str = "60") -> pd.DataFrame:
    if not CSV_PATH.exists():
        raise FileNotFoundError(f"vectorbt_input.csv not found at {CSV_PATH}. Run export_bars.py first.")
    df = pd.read_csv(CSV_PATH, parse_dates=["timestamp"], dtype={"timeframe": str})
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df[df["timeframe"] == str(timeframe)].copy()
    df.sort_values("timestamp", inplace=True)
    df.reset_index(drop=True, inplace=True)
    return df


def compute_adx(high, low, close, window=14):
    plus_dm = np.diff(high, prepend=high[0])
    minus_dm = np.diff(low, prepend=low[0])
    plus_dm = np.where((plus_dm > minus_dm) & (plus_dm > 0), plus_dm, 0)
    minus_dm = np.where((minus_dm > plus_dm) & (minus_dm > 0), minus_dm, 0)

    tr1 = high - low
    tr2 = np.abs(high - np.insert(close, 0, close[0])[:-1])
    tr3 = np.abs(low - np.insert(close, 0, close[0])[:-1])
    tr = np.maximum(tr1, np.maximum(tr2, tr3))

    alpha = 1.0 / window
    smoothed_tr = np.zeros_like(tr)
    smoothed_plus = np.zeros_like(plus_dm)
    smoothed_minus = np.zeros_like(minus_dm)

    smoothed_tr[0] = np.sum(tr[:window])
    smoothed_plus[0] = np.sum(plus_dm[:window])
    smoothed_minus[0] = np.sum(minus_dm[:window])

    for i in range(1, len(tr)):
        smoothed_tr[i] = smoothed_tr[i-1] + alpha * (tr[i] - smoothed_tr[i-1])
        smoothed_plus[i] = smoothed_plus[i-1] + alpha * (plus_dm[i] - smoothed_plus[i-1])
        smoothed_minus[i] = smoothed_minus[i-1] + alpha * (minus_dm[i] - smoothed_minus[i-1])

    di_plus = 100 * smoothed_plus / np.where(smoothed_tr == 0, 1, smoothed_tr)
    di_minus = 100 * smoothed_minus / np.where(smoothed_tr == 0, 1, smoothed_tr)
    dx = 100 * np.abs(di_plus - di_minus) / np.where((di_plus + di_minus) == 0, 1, (di_plus + di_minus))

    adx = np.zeros_like(dx)
    adx[:window] = np.nan
    adx_val = np.mean(dx[:window])
    adx[window-1] = adx_val
    for i in range(window, len(dx)):
        adx[i] = (adx[i-1] * (window - 1) + dx[i]) / window

    return adx, di_plus, di_minus


def donchian_high(high, window):
    return pd.Series(high).rolling(window=window, min_periods=window).max().shift(1).values


def simulate_trades(df: pd.DataFrame, adx_min: int, lookback: int, rules: dict) -> dict:
    high = df["high"].values
    low = df["low"].values
    close = df["close"].values
    open_ = df["open"].values
    timestamps = df["timestamp"].values

    adx_val, di_plus, di_minus = compute_adx(high, low, close, window=14)
    dc_high = donchian_high(high, lookback)

    commission_per_side = float(rules.get("commissionPerContractPerSide", 0.95))
    round_turn_commission = commission_per_side * 2
    slippage = 0.5

    stop_points = 3.0
    target_r = float(rules.get("playbooks", {}).get("targetR", 2.0))
    target_points = stop_points * target_r

    daily_cap_per_2 = float(rules.get("dshV2", {}).get("dailyCapPer2Contracts", 1000))
    size = 1
    daily_cap = daily_cap_per_2 * (size / 2)

    flatten_ist_min = int(rules.get("flattenByISTMinutes", 180))

    def ist_minutes(ts):
        dt = pd.Timestamp(ts)
        if dt.tzinfo is None:
            dt = dt.tz_localize("UTC")
        ist = dt.tz_convert("Asia/Kolkata")
        return ist.hour * 60 + ist.minute

    trades = []
    i = lookback + 14
    daily_pnl = 0.0
    current_day = None

    while i < len(df):
        ts = timestamps[i]
        day_key = pd.Timestamp(ts).date().isoformat()
        if day_key != current_day:
            current_day = day_key
            daily_pnl = 0.0

        if daily_pnl >= daily_cap:
            i += 1
            continue

        if adx_val[i] >= adx_min and di_plus[i] > di_minus[i] and close[i] > dc_high[i] and close[i] > open_[i]:
            entry_price = close[i]
            stop_price = low[i] - stop_points
            target_price = entry_price + target_points
            entry_idx = i

            trade_pnl = None
            exit_idx = None
            exit_reason = None
            exit_price = None

            for j in range(i + 1, len(df)):
                if low[j] <= stop_price:
                    trade_pnl = -(stop_points + slippage) * size
                    exit_reason = "stop"
                    exit_idx = j
                    exit_price = stop_price
                    break
                if high[j] >= target_price:
                    trade_pnl = (target_points - slippage) * size
                    exit_reason = "target"
                    exit_idx = j
                    exit_price = target_price
                    break
                ist_min_j = ist_minutes(timestamps[j])
                if ist_min_j >= flatten_ist_min:
                    trade_pnl = (close[j] - entry_price - slippage) * size
                    exit_reason = "flatten"
                    exit_idx = j
                    exit_price = close[j]
                    break

            if trade_pnl is None:
                trade_pnl = (close[-1] - entry_price - slippage) * size
                exit_reason = "end_of_data"
                exit_idx = len(df) - 1
                exit_price = close[-1]

            trade_pnl -= round_turn_commission * size
            daily_pnl += trade_pnl

            trades.append({
                "entry_time": str(timestamps[entry_idx]),
                "exit_time": str(timestamps[exit_idx]),
                "entry_price": float(entry_price),
                "exit_price": float(exit_price),
                "exit_reason": exit_reason,
                "pnl": float(trade_pnl),
                "size": size,
            })
            i = exit_idx + 1
            continue

        i += 1

    trades_df = pd.DataFrame(trades) if trades else pd.DataFrame(columns=["entry_time", "exit_time", "entry_price", "exit_price", "exit_reason", "pnl", "size"])

    if len(trades_df) == 0:
        return {
            "params": {"adx_min": adx_min, "lookback": lookback},
            "trades": 0,
            "win_rate": 0.0,
            "net_pnl": 0.0,
            "profit_factor": 0.0,
            "max_drawdown": 0.0,
            "expectancy": 0.0,
            "avg_win": 0.0,
            "avg_loss": 0.0,
            "trades_detail": [],
        }

    wins = trades_df[trades_df["pnl"] > 0]
    losses = trades_df[trades_df["pnl"] <= 0]

    gross_profit = float(wins["pnl"].sum()) if len(wins) > 0 else 0.0
    gross_loss = abs(float(losses["pnl"].sum())) if len(losses) > 0 else 0.0
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else (float("inf") if gross_profit > 0 else 0.0)

    equity = trades_df["pnl"].cumsum()
    rolling_max = equity.cummax()
    drawdown = equity - rolling_max
    max_drawdown = float(drawdown.min())

    expectancy = float(trades_df["pnl"].mean())

    return {
        "params": {"adx_min": adx_min, "lookback": lookback},
        "trades": len(trades_df),
        "win_rate": float(len(wins) / len(trades_df)),
        "net_pnl": float(trades_df["pnl"].sum()),
        "profit_factor": float(profit_factor),
        "max_drawdown": max_drawdown,
        "expectancy": expectancy,
        "avg_win": float(wins["pnl"].mean()) if len(wins) > 0 else 0.0,
        "avg_loss": float(losses["pnl"].mean()) if len(losses) > 0 else 0.0,
        "trades_detail": trades_df.to_dict("records"),
    }


def run_sweep(timeframe: str = "60"):
    start = time.time()
    rules = load_rules()
    df = load_data(timeframe)
    print(f"Loaded {len(df)} bars for timeframe {timeframe}", file=sys.stderr)

    adx_values = [25, 30, 35, 40]
    lookback_values = [5, 10, 15, 20]

    results = []
    for adx_min in adx_values:
        for lookback in lookback_values:
            print(f"Sweeping adx_min={adx_min}, lookback={lookback}...", file=sys.stderr)
            res = simulate_trades(df, adx_min, lookback, rules)
            results.append(res)

    best = max(results, key=lambda r: r["net_pnl"]) if results else None

    runtime = round(time.time() - start, 3)
    output = {
        "results": results,
        "best": best,
        "runtime_sec": runtime,
        "timeframe": timeframe,
        "bar_count": len(df),
        "date_range": {
            "start": str(df["timestamp"].iloc[0]) if len(df) > 0 else None,
            "end": str(df["timestamp"].iloc[-1]) if len(df) > 0 else None,
        },
    }

    print(json.dumps(output, default=str))
    return output


def main():
    parser = argparse.ArgumentParser(description="DSH V2 VectorBT parameter sweep")
    parser.add_argument("--timeframe", default="60", help="Bar timeframe to use (default: 60)")
    args = parser.parse_args()
    run_sweep(args.timeframe)


if __name__ == "__main__":
    main()
