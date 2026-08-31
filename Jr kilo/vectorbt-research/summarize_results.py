import json

with open("sweep_results_clean.json", "r", encoding="utf-8-sig") as f:
    data = json.load(f)

print("=== SWEEP SUMMARY ===")
print("Timeframe:", data["timeframe"])
print("Bar count:", data["bar_count"])
print("Date range:", data["date_range"]["start"], "to", data["date_range"]["end"])
print("Runtime:", data["runtime_sec"], "s")
print()

print("=== RESULTS BY PARAM COMBO ===")
header = "{:<10} {:<10} {:<8} {:<8} {:<12} {:<10} {:<12} {:<12}".format(
    "ADX Min", "Lookback", "Trades", "Win%", "Net P&L", "PF", "Max DD", "Expectancy"
)
print(header)
print("-" * 80)
for r in data["results"]:
    p = r["params"]
    pf = "inf" if r["profit_factor"] == float("inf") else "{:.2f}".format(r["profit_factor"])
    line = "{:<10} {:<10} {:<8} {:.1f}%    {:>+10.2f}   {:<10} {:>+10.2f}   {:>+10.2f}".format(
        p["adx_min"], p["lookback"], r["trades"], r["win_rate"] * 100,
        r["net_pnl"], pf, r["max_drawdown"], r["expectancy"]
    )
    print(line)

print()
best = data["best"]
print("=== BEST PARAM COMBO ===")
print("ADX Min:", best["params"]["adx_min"], "Lookback:", best["params"]["lookback"])
print("Trades:", best["trades"], "Win Rate:", "{:.1f}%".format(best["win_rate"] * 100))
print("Net P&L: {:+.2f}".format(best["net_pnl"]))
print("Profit Factor:", best["profit_factor"])
print("Max Drawdown:", "{:+.2f}".format(best["max_drawdown"]))
print("Expectancy:", "{:+.2f}".format(best["expectancy"]))

# Count profitable vs losing combos
profitable = [r for r in data["results"] if r["net_pnl"] > 0]
losing = [r for r in data["results"] if r["net_pnl"] <= 0]
print()
print("=== PROFITABILITY VERDICT ===")
print("Profitable combos:", len(profitable), "/", len(data["results"]))
print("Losing combos:", len(losing), "/", len(data["results"]))
if profitable:
    best_profit = max(profitable, key=lambda r: r["net_pnl"])
    print("Best net P&L:", "{:+.2f}".format(best_profit["net_pnl"]), "at", best_profit["params"])
else:
    print("No profitable combos found.")
