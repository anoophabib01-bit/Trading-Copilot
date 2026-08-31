# DSH Backtesting - CONFIRMED STRATEGY SPEC (v1)

> Study output. Nothing wired to live trading. This is the exact rule set the
> 60-day backtest will implement, built from Anoop's confirmed answers + research.

## Confirmed answers (final)
| Question | Decision |
|---|---|
| Playbooks | ALL (A, B, C) - study all, keep what works |
| Window | Mon London -> Fri NY (full week, both sessions) |
| Exit | FIXED 1:1 to 1:2 reward:risk (Anoop chose fixed R over key-level exit) |
| Key levels (confluence) | 4H swing highs/lows + PDH/PDL + EQH/EQL |
| Signal / bias | 30M signal, 4H bias |
| 1H role | 4H bias -> 1H structure/confirmation -> 30M entry (3-TF stack) |
| Data | 60 trading days |
| Size | 1 contract, always (until changed) |
| Consistency | $3,000 target; 40% rule = $1,200 max single day; >=3 profitable days |
| Instrument | MNQ + MGC (pick by daily bias, ONE per day - Rule #9) |

## The strategy (merged rule set the backtest will code)

BIAS (4H):
  - Bull = HH-HL, Bear = LL-LH. No clean structure = no trade that day.
  - Pick the instrument (MNQ or MGC) whose 4H structure is cleaner (daily bias).
  - ONE instrument per day.

1H CONFIRMATION (key driver - the decision timeframe):
  - 1H structure must AGREE with 4H bias.
  - A fresh 1H zone (order block / FVG) must exist on the bias side and NOT be
    already swept this session (already-swept = spent fuel = no trade).
  - Displacement present: the move away from the zone had body >= 1.5x 1H ATR.
  - No opposing 1H structure break since the zone formed.

30M ENTRY TRIGGER:
  - Playbook A: full-range engulf candle closes on 30M at/near the 1H zone,
    agreeing with bias, passing Playbook-C validity gate.
  - Playbook B: SFP (liquidity raid) into the zone, then displacement leaves an
    FVG; LIMIT entry on the retrace into the gap (requires fill).
  - Playbook C: validity gate applied to every engulf (swing location, takes out
    both prior extremes, liquidity not already swept).

RISK MODEL (exact):
  - Stop: 1 tick beyond the ENTRY candle extreme (above/below entry candle);
    further of entry-candle wick vs zone edge. Min distance >= 0.25x 1H ATR.
  - Target: FIXED 1:1 to 1:2 R from the stop distance (Anoop's choice).
  - 1 contract always.

QUALITY GATE (quality over quantity - trade only >=5/6 confirmations):
  1. Fresh 1H OB + FVG overlap (or OB exactly at a 4H level).
  2. SFP/sweep into the zone (no sweep = chasing = skip).
  3. Reversal candle body >= 60% of 1H ATR after the sweep.
  4. Entry inside a kill zone (NY open / NY close windows).
  5. Entry within 25% of the zone's range (not mid-zone).
  6. 4H + 1H + 30M all agree.

HARD LIMITS (already in rules.json, kept):
  - Flatten ALL trades at 03:00 IST (flattenByISTMinutes: 180).
  - <= 10 trades/day. Break-even band +-$100 (outside it = a real trade).
  - Max 2 contracts (we use 1). Commission $0.95/side ($1.90 round turn).
  - Daily loss tiers -$250/-$350/-$500. Session windows London + NY.

## Consistency plan (how to actually clear the 50K eval)
- Best-day / total profit <= 40% => max bankable day = $1,200.
- Safe shape: 4-5 days of $600-$800 each (best-day ratio ~20-27%, wide buffer).
- Hard stop-trading at +$1,000/day; risk capped ~$750/day (cap-vs-loss asymmetry).
- $600-$800/day on MNQ ($2/point) ~= 300-400 pts ~= 2-4 solid trades at 2-4R.

## Reconciliation note (important)
- Earlier you said 'exit at key levels, no fixed R'; in the clarifying question
  you chose 'TP = fixed 1:1 to 1:2 R'. v1 codes FIXED R as the take-profit.
  The key levels (4H swings, PDH/PDL, EQH/EQL) are used as ENTRY confluences +
  bias anchors + invalidation, not the TP. This is flagged as the #1 thing to
  re-test later (fixed R vs scale-at-key-level hybrid) - it is in scope to change.

## Next steps (the backtest phase)
1. Implement this spec as a Pine v5 strategy on TradingView (60 days, 30M/1H/4H).
2. Run in Strategy Tester; measure win rate, profit factor, net after commission,
   trades/day, and whether it clears the +-$100 band and $3,000 target.
3. Compare A vs B vs C and tune the quality gate (confirmations required).
4. Iterate (this file is versioned; modification is in scope).
