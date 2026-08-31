import sys
import json
import time
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from regime_classifier import classify_regimes, compute_adx, compute_atr, efficiency_ratio
from run_sweep import load_rules, load_data, donchian_high

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
DATA_DIR = PROJECT_ROOT / "DATA"
RULES_PATH = DATA_DIR / "rules.json"
CSV_PATH = SCRIPT_DIR / "vectorbt_input.csv"


def simulate_trade_exit(entry_idx, entry_price, stop_price, target_price, high, low, close, timestamps, size, commission, flatten_ist_min):
    for j in range(entry_idx + 1, len(close)):
        if low[j] <= stop_price:
            pnl = -(entry_price - stop_price + 0.5) * size
            return pnl, j, "stop", stop_price
        if high[j] >= target_price:
            pnl = (target_price - entry_price - 0.5) * size
            return pnl, j, "target", target_price
        dt = pd.Timestamp(timestamps[j])
        if dt.tzinfo is None:
            dt = pd.Timestamp(timestamps[j]).tz_localize("UTC")
        ist = dt.tz_convert("Asia/Kolkata")
        ist_min = ist.hour * 60 + ist.minute
        if ist_min >= flatten_ist_min:
            pnl = (close[j] - entry_price - 0.5) * size
            return pnl, j, "flatten", close[j]
    pnl = (close[-1] - entry_price - 0.5) * size
    return pnl, len(close) - 1, "end_of_data", close[-1]


def run_breakout_strategy(df, adx_min, lookback, rules, regime_filter=None):
    high = df["high"].values
    low = df["low"].values
    close = df["close"].values
    open_ = df["open"].values
    timestamps = df["timestamp"].values

    regimes, adx_val, di_plus, di_minus, atr, er = classify_regimes(high, low, close)
    dc_high = donchian_high(high, lookback)

    commission_per_side = float(rules.get("commissionPerContractPerSide", 0.95))
    round_turn_commission = commission_per_side * 2
    flatten_ist_min = int(rules.get("flattenByISTMinutes", 180))

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

        if regime_filter and regimes[i] != regime_filter:
            i += 1
            continue

        if adx_val[i] >= adx_min and di_plus[i] > di_minus[i] and close[i] > dc_high[i] and close[i] > open_[i]:
            entry_price = close[i]
            stop_points = max(float(rules.get("playbooks", {}).get("minRiskPoints", 8)), atr[i] * 0.5)
            stop_price = low[i] - stop_points
            target_r = float(rules.get("playbooks", {}).get("targetR", 2.0))
            target_price = entry_price + (entry_price - stop_price) * target_r
            size = 1
            risk_per_contract = (entry_price - stop_price) * 2
            if risk_per_contract > float(rules.get("perTradeMaxLoss", 300)):
                i += 1
                continue
            trade_pnl, exit_idx, exit_reason, exit_price = simulate_trade_exit(
                i, entry_price, stop_price, target_price, high, low, close, timestamps, size, round_turn_commission, flatten_ist_min
            )
            trade_pnl -= round_turn_commission * size
            daily_pnl += trade_pnl
            trades.append({
                "entry_time": str(timestamps[i]),
                "exit_time": str(timestamps[exit_idx]),
                "entry_price": float(entry_price),
                "exit_price": float(exit_price),
                "exit_reason": exit_reason,
                "pnl": float(trade_pnl),
                "size": size,
                "regime": regimes[i],
            })
            i = exit_idx + 1
            continue
        i += 1

    trades_df = pd.DataFrame(trades) if trades else pd.DataFrame(columns=["entry_time", "exit_time", "entry_price", "exit_price", "exit_reason", "pnl", "size", "regime"])
    if len(trades_df) == 0:
        return {
            "params": {"adx_min": adx_min, "lookback": lookback, "regime_filter": regime_filter},
            "trades": 0, "win_rate": 0.0, "net_pnl": 0.0, "profit_factor": 0.0,
            "max_drawdown": 0.0, "expectancy": 0.0, "avg_win": 0.0, "avg_loss": 0.0, "trades_detail": []
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
        "params": {"adx_min": adx_min, "lookback": lookback, "regime_filter": regime_filter},
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


def run_pullback_strategy(df, adx_min, lookback, rules, regime_filter=None):
    high = df["high"].values
    low = df["low"].values
    close = df["close"].values
    open_ = df["open"].values
    timestamps = df["timestamp"].values

    regimes, adx_val, di_plus, di_minus, atr, er = classify_regimes(high, low, close)
    dc_low = pd.Series(low).rolling(window=lookback, min_periods=lookback).min().shift(1).values

    commission_per_side = float(rules.get("commissionPerContractPerSide", 0.95))
    round_turn_commission = commission_per_side * 2
    flatten_ist_min = int(rules.get("flattenByISTMinutes", 180))

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

        if regime_filter and regimes[i] != regime_filter:
            i += 1
            continue

        if adx_val[i] >= adx_min and di_plus[i] > di_minus[i] and close[i] < dc_low[i] and close[i] > open_[i]:
            entry_price = close[i]
            stop_points = max(float(rules.get("playbooks", {}).get("minRiskPoints", 8)), atr[i] * 0.5)
            stop_price = low[i] - stop_points
            target_r = float(rules.get("playbooks", {}).get("targetR", 2.0))
            target_price = entry_price + (entry_price - stop_price) * target_r
            size = 1
            risk_per_contract = (entry_price - stop_price) * 2
            if risk_per_contract > float(rules.get("perTradeMaxLoss", 300)):
                i += 1
                continue
            trade_pnl, exit_idx, exit_reason, exit_price = simulate_trade_exit(
                i, entry_price, stop_price, target_price, high, low, close, timestamps, size, round_turn_commission, flatten_ist_min
            )
            trade_pnl -= round_turn_commission * size
            daily_pnl += trade_pnl
            trades.append({
                "entry_time": str(timestamps[i]),
                "exit_time": str(timestamps[exit_idx]),
                "entry_price": float(entry_price),
                "exit_price": float(exit_price),
                "exit_reason": exit_reason,
                "pnl": float(trade_pnl),
                "size": size,
                "regime": regimes[i],
            })
            i = exit_idx + 1
            continue
        i += 1

    trades_df = pd.DataFrame(trades) if trades else pd.DataFrame(columns=["entry_time", "exit_time", "entry_price", "exit_price", "exit_reason", "pnl", "size", "regime"])
    if len(trades_df) == 0:
        return {
            "params": {"adx_min": adx_min, "lookback": lookback, "regime_filter": regime_filter, "strategy": "pullback"},
            "trades": 0, "win_rate": 0.0, "net_pnl": 0.0, "profit_factor": 0.0,
            "max_drawdown": 0.0, "expectancy": 0.0, "avg_win": 0.0, "avg_loss": 0.0, "trades_detail": []
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
        "params": {"adx_min": adx_min, "lookback": lookback, "regime_filter": regime_filter, "strategy": "pullback"},
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

    regimes, _, _, _, _, _ = classify_regimes(df["high"].values, df["low"].values, df["close"].values)
    stats = {r: int(np.sum(regimes == r)) for r in np.unique(regimes)}
    print(f"Regime distribution: {stats}", file=sys.stderr)

    adx_values = [25, 30, 35]
    lookback_values = [5, 10, 15]
    regime_filters = [None, "TREND_UP", "RANGE", "VOLATILE"]

    results = []
    for adx_min in adx_values:
        for lookback in lookback_values:
            for regime in regime_filters:
                print(f"Sweeping breakout adx={adx_min} lb={lookback} regime={regime}...", file=sys.stderr)
                res = run_breakout_strategy(df, adx_min, lookback, rules, regime)
                results.append(res)
                if res["trades"] > 0:
                    print(f"  -> {res['trades']} trades, net ${res['net_pnl']:+.2f}, PF {res['profit_factor']:.2f}", file=sys.stderr)

    for adx_min in adx_values:
        for lookback in lookback_values:
            for regime in ["TREND_UP", "RANGE"]:
                print(f"Sweeping pullback adx={adx_min} lb={lookback} regime={regime}...", file=sys.stderr)
                res = run_pullback_strategy(df, adx_min, lookback, rules, regime)
                results.append(res)
                if res["trades"] > 0:
                    print(f"  -> {res['trades']} trades, net ${res['net_pnl']:+.2f}, PF {res['profit_factor']:.2f}", file=sys.stderr)

    profitable = [r for r in results if r["net_pnl"] > 0]
    best = max(profitable, key=lambda r: r["net_pnl"]) if profitable else None

    runtime = round(time.time() - start, 3)
    output = {
        "results": results,
        "best": best,
        "runtime_sec": runtime,
        "timeframe": timeframe,
        "bar_count": len(df),
        "regime_distribution": stats,
        "date_range": {
            "start": str(df["timestamp"].iloc[0]) if len(df) > 0 else None,
            "end": str(df["timestamp"].iloc[-1]) if len(df) > 0 else None,
        },
    }

    print(json.dumps(output, default=str))
    return output


def main():
    parser = argparse.ArgumentParser(description="Regime-adaptive strategy sweep")
    parser.add_argument("--timeframe", default="60", help="Bar timeframe to use (default: 60)")
    args = parser.parse_args()
    run_sweep(args.timeframe)


if __name__ == "__main__":
    main()
