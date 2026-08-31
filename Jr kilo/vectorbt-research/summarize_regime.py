import json

with open("regime_sweep_results.json", "r", encoding="utf-8-sig") as f:
    data = json.load(f)

total_bars = sum(data["regime_distribution"].values())
print("=== REGIME DISTRIBUTION ===")
for regime, count in data["regime_distribution"].items():
    pct = count / total_bars * 100
    print(f"  {regime}: {count} bars ({pct:.1f}%)")

print()
print("=== PROFITABLE COMBOS ===")
profitable = [r for r in data["results"] if r["net_pnl"] > 0]
print(f"Profitable: {len(profitable)} / {len(data['results'])}")
for r in profitable[:15]:
    p = r["params"]
    strategy = p.get("strategy", "breakout")
    regime = p.get("regime_filter", "all")
    print(f"  {strategy} | ADX>={p['adx_min']} lb={p['lookback']} regime={regime} | trades={r['trades']} net=${r['net_pnl']:+.2f} PF={r['profit_factor']:.2f}")

print()
print("=== BEST RESULT ===")
if data["best"]:
    best = data["best"]
    p = best["params"]
    strategy = p.get("strategy", "breakout")
    regime = p.get("regime_filter", "all")
    print(f"Strategy: {strategy}")
    print(f"ADX>={p['adx_min']} lookback={p['lookback']} regime={regime}")
    print(f"Trades: {best['trades']} | Net P&L: ${best['net_pnl']:+.2f} | PF: {best['profit_factor']:.2f}")
    print(f"Win Rate: {best['win_rate']*100:.1f}% | Max DD: ${best['max_drawdown']:+.2f}")
else:
    print("No profitable combos found.")
