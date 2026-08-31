# Intraday Trading Research — MNQ / NQ / GC / MGC (fresh start)

> Web-sourced, cross-checked against my own MNQ backtesting. Research only.

## 1. The strategy families (what the whole internet converges on)
For intraday Nasdaq and Gold futures, the SAME ~7 families dominate. Ranked by
simplicity x reported robustness after fees:

| # | Family | Simplicity | After-fees verdict |
|---|---|---|---|
| 1 | ORB (opening range breakout) 5/15-min | very | best-cited IF filtered |
| 2 | Session high/low breakout (Asia/London/NY) | very | 83-87% take-rates |
| 3 | Trend pullback to EMA (9/21/50) | easy | 58-65% realistic WR |
| 4 | VWAP band fade (+-2 sigma) | medium | PF 1.39 audited |
| 5 | Dual MA crossover | trivial | weak intraday (baseline only) |
| 6 | MGC London-NY overlap (Gold) | medium | PF 1.36 audited on MGC |

## 2. Named traders and their methods
NQ/MNQ:
- ICT (Michael Huddleston) - Smart Money: FVG + order blocks + liquidity sweeps in
  killzones (London 2-5am ET, NY 10-11am / 2-3pm ET). The dominant modern NQ method.
- Al Brooks - price action on 5-min: 'two reasons' rule, signal-bar breaks, 1-2pt stops.
- Trader Dante - multi-timeframe ATR levels (D-ATR) + 'Blind Spots' reaction zones.
- John Grady (Jigsaw) - order flow/footprint (NOT codeable in Pine).
- SMB Capital (Bellafiore/Breitstein) - opening-drive momentum + VWAP plays.
- Patrick Nill - volume/market profile + mental game.

Gold (GC/MGC):
- Market Profile / Auction theory (Jim Dalton lineage) - value area / POC.
- London & NY session flow - the key structural fact: gold moves most at those opens.
- VWAP + EMA reversion; order-flow scalping in high-volatility sessions.
- 'London Gold Signals' and session-based setups.

## 3. The concrete, codeable rules (top 4)

### ORB 5/15-min (rank 1)
- Range = high/low of first 5 (or 15) RTH minutes.
- Long on candle CLOSE above range high; short on close below low.
- Stop = opposite range edge. Target = 1.5x range height (or 50% variant).
- Filters that matter: skip wide-range days (>~0.55% of price); skip Tuesday longs
  (ES data); a dollar max-loss cap.

### Session breakout (rank 2)
- Asia (20:00-02:00 ET) + London (02:00-08:00 ET) ranges.
- Outer high = max(Asia,London high); outer low = min(Asia,London low).
- At NY open (08:00 ET): NY opens ABOVE London midpoint -> trade break of outer HIGH;
  below -> break of outer LOW. Stop = opposite outer level. Target = 2R / measured move.

### EMA pullback (rank 3)
- Trend: 9 > 21 > 50 EMA aligned, price above 21-EMA 60+ min.
- Pullback to 21-EMA + rejection wick + volume >=120-150% avg.
- Enter first candle closing back in trend. Stop 20-35 NQ pts beyond MA. Target 1.5-2R.

### VWAP band fade (rank 4)
- Long at -2sigma VWAP band (with confirmation), short at +2sigma.
- Target VWAP (partial at +-1sigma). Stop at +-3sigma.
- Only in RANGE days (ADX < 25 filter).

### MGC London-NY overlap (Gold-specific, audited)
- Mark 8:00-8:30 ET high/low; long break above with volume surge (short mirror).
- Require overlap range >= 2x pre-overlap range. Trail 1x ATR. TP 2x opening range.
- Hard time-exit 11:30 ET. (Reported: 52% WR, PF 1.36, Sharpe 2.50, maxDD 3.1%).

## 4. THE HONEST REALITY (do not skip)
- The MNQ falsification study (arXiv:2605.04004, 947 days of 5-min data) found 14 common
  OHLCV signal families RARELY clear the bar (t-stat>=2, >=30 trades, positive after costs).
- '37 famous strategies with fees ON' audit: most LOSE mechanically after costs.
- Any claimed win rate >65% on these is almost certainly curve-fit.
- Costs are the killer: 1 tick slippage on a 4-tick target is a 25% haircut.
- Regime dependence is real: Edgeful's MNQ ORB = PF 1.65 over 10 months, PF 1.19 over 5 yrs.

## 5. The shortlist to actually build + test (my call)
1. ORB 5-min + range-size filter + day filter  (MNQ)
2. Session breakout (Asia/London outer + NY-midpoint filter)  (MNQ)
3. MGC London-NY overlap  (Gold — the only MGC-audited setup)
4. VWAP band fade + ADX range filter  (either instrument)

## 6. The step-by-step build plan
1. Code these 4 in Pine (each ~30-80 lines).
2. Backtest each on YOUR data with FULL commission ($0.95/side) + 1-tick slippage.
3. Walk-forward (rolling 6-month), not 5-year optimization.
4. Keep only what clears: >=100 trades, PF >=1.3, maxDD under your $2,000 limit.
5. Paper-trade the survivors 2-4 weeks before any real size.

NOTE: gold-specific trader deep-dive (S2 agent) still running - will append when it lands.
