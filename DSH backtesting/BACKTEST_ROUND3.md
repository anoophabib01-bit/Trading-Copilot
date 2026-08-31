# DSH Backtesting - Round 3 findings (gate sweep + SFP/FVG, 65 days real data)

## Experiment 1: gate-strictness sweep (Playbook A, 1H engulf, 65 days)
Toggled each C-gate requirement + the 4H gate, reusing the EXACT detectors and the
harness's pessimistic fill/scoring. 80 engulf candidates total.

| Config | Setups | Filled | Win% | Net (1c) | PF | Trades/day |
|---|---|---|---|---|---|---|
| strict (current) | 1 | 1 | 0% | -$270 | 0 | 0.02 |
| -swing | 3 | 3 | 33% | -$71 | 0.81 | 0.05 |
| -sweep | 1 | 1 | 0% | -$270 | 0 | 0.02 |
| -swing-sweep | 3 | 3 | 33% | -$71 | 0.81 | 0.05 |
| -structure (4H only) | 3 | 3 | 33% | -$71 | 0.81 | 0.05 |
| engulf only | 62 | 62 | 35% | -$1,579 | 0.75 | 0.95 |

STRICT REJECTION BREAKDOWN (79 rejections):
  against/unclear-4H(unclear)  57 (72%)  <- the 4H trend read is 'unclear' 72% of the time
  against/unclear-4H(bullish)   9 (11%)  <- 4H readable but disagreed
  against/unclear-4H(bearish)   8 (10%)
  not-at-swing                  4 (5%)
  structure-mixed               1 (1%)

KEY: the binding constraint is NOT the Playbook-C gate. 94% of rejections come from
the 4H trend gate, and 72% of those are a 5-bar 4H read returning 'unclear' (noise,
not signal). The C gate itself (structure + at-swing + sweep) barely filters at all.

## Experiment 2: Playbook B (SFP + displacement FVG) on 1H, 65 days
  liquidity raids: 335 (~5/day) | blocked by risk: 44 (30 too-big, 14 too-small)
  setups: 6 | filled: 3 | never-filled: 3 (retrace never came)
  win: 0% | net -$342.70 | PF 0 | maxDD $342.70 | 0 targets / 3 stops

## THE DEFINITIVE CONCLUSION (3 rounds of evidence)
1. The 1H engulf setup (Playbook A) has NO edge at ANY gate strictness on 65 days -
   even fully relaxed it is PF 0.75 and -$1,579. Tuning the gates cannot rescue it
   because the ENTRY itself has negative expectancy.
2. The SFP+FVG setup (Playbook B) has no edge either (1H: -$342, 3 stops; 30M: -$103).
3. The 4H 'trend' gate is noise (72% unclear on a 5-bar read) - it adds no signal,
   it only cuts the already-tiny sample.
4. 'Quality over quantity' is NOT the problem. The entries themselves are negative.

## What this means (honest, and it matters)
- No amount of gate-tuning or quality-filtering will make the current playbooks
  clear a $3,000 eval, because their entries lose money net of commission on real
  data. This is the finding the honest harness exists to produce - and it is the
  opposite of a sell-side backtest.
- To get to profitable, the ENTRY needs to change, not the filters. Candidates
  from the research: OB+FVG+SFP CONFLUENCE (all three, not SFP+FVG alone),
  displacement-first entries, or a mean-reversion/range-fade instead of a
  breakout-chase. None of those are the current detector.

## Still missing / honest limits
- 30M data for 60 days still unobtainable offline (get_history=1h max; chart=live).
  B/LTF on 30M were only tested on 8.5 days. Unlikely to flip to profitable given
  1H shows no edge, but not disproven.
- A profitable intraday edge may not exist in this 65-day regime for THESE entries
  at all - that is a legitimate finding, not a failure to look.
