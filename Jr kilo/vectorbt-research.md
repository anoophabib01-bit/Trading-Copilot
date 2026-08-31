# Jr kilo — VectorBT Deep Research Report

## 1. What VectorBT Is

**VectorBT** (polakowo/vectorbt) is a Python backtesting library that takes a fundamentally different approach from event-driven engines like yours:

| Aspect | VectorBT | MNQ Co-Pilot backtest.js |
|--------|----------|-------------------------|
| **Paradigm** | Vectorized (pandas/NumPy arrays, all instances at once) | Event-driven (bar-by-bar loop) |
| **Speed** | Thousands of configs in seconds | One config at a time |
| **Language** | Python only | Node.js/JavaScript |
| **Core tech** | NumPy + Numba + optional Rust | Pure JS, no native deps |
| **Data model** | DataFrame columns = strategy instances | Single pass per playbook |
| **Complexity** | Simple strategies are 5-10 lines | Complex multi-TF logic is explicit |

### The Core Idea

Instead of looping through bars one strategy at a time (O(n*m) where n=bars, m=strategies), VectorBT packs thousands of strategy configurations into multi-dimensional NumPy arrays and processes them all simultaneously. This turns a 4-hour parameter sweep into a 4-second one.

---

## 2. How It Works Internally

### Data Representation
- All data is pandas DataFrames or NumPy arrays
- Each column can represent a different strategy instance, parameter combo, or symbol
- Example: testing SMA crossover with fast=[10,20,30] and slow=[40,50,60] creates 9 columns in one DataFrame

### Signal Generation
- Indicators return multi-column objects (`vbt.MA.run(price, [10,20,30])`)
- Signals are boolean DataFrames of the same shape
- Entry/exit signals are vectorized operations across all instances

### Portfolio Simulation
- `vbt.Portfolio.from_signals(price, entries, exits, ...)` runs ALL instances in one call
- Returns a Portfolio object with per-instance stats
- No explicit stop/target management in the basic API — it's entry/exit based

### Acceleration
- **NumPy vectorization**: basic operations are array-wide
- **Numba JIT**: complex logic compiled to machine code at runtime
- **Rust engine** (optional): precompiled kernels for hottest paths, no JIT overhead

---

## 3. What It Can Do (Capabilities)

### 3.1 Parameter Optimization (THE KILLER FEATURE)

```python
# Test 10,000 SMA window combinations in ONE call
windows = np.arange(2, 101)
fast_ma, slow_ma = vbt.MA.run_combs(price, window=windows, r=2)
entries = fast_ma.ma_crossed_above(slow_ma)
exits = fast_ma.ma_crossed_below(slow_ma)
pf = vbt.Portfolio.from_signals(price, entries, exits, ...)
# pf now has 10,000 strategy results
```

**For MNQ Co-Pilot**, this means:
- Sweep ADX threshold 25-40 in one call
- Sweep lookback 5-20 in one call  
- Sweep daily cap $500-$2000 in one call
- All combinations tested simultaneously

### 3.2 Walk-Forward Optimization
- Split data into train/test windows
- Optimize on train, test on test
- Built-in example: `examples/WalkForwardOptimization.ipynb`

### 3.3 Multi-Asset / Multi-Timeframe
- Can concatenate multiple symbols into one DataFrame
- Can split time periods for rolling analysis
- Multi-index results let you group by any dimension

### 3.4 Rich Analytics
- Per-trade stats: win rate, profit factor, expectancy, Sharpe, Calmar, Omega
- Drawdown analysis
- Trade listing with entry/exit times, P&L, duration
- QuantStats integration for 100+ metrics

### 3.5 Visualization
- Plotly-based interactive charts
- Heatmaps for parameter sweeps
- Jupyter widgets for dashboards
- Can save animations (GIFs)

### 3.6 Data Sources
- Built-in: Yahoo Finance, Binance, Polygon.io
- Custom: load any DataFrame
- Can export/import DataFrames easily

### 3.7 Indicators
- 100+ built-in indicators (SMA, EMA, RSI, MACD, Bollinger Bands, etc.)
- Integrations: TA-Lib, Pandas TA, TradingView
- Custom indicators: just compute on the DataFrame

---

## 4. What It Cannot Do (Limitations)

### 4.1 No Complex Multi-Timeframe Logic
VectorBT is fundamentally single-timeframe. The basic `from_signals` API expects one price series. Multi-timeframe strategies (like your 4H bias → 1H structure → 30M entry) require:
- Manually aligning higher-timeframe data to lower-timeframe bars
- Or running separate backtests and joining results
- This is possible but not as clean as your event-driven engine

### 4.2 No Native Limit Order Simulation
The basic portfolio API is market-order based. Limit orders (like Playbook B's FVG fill) require custom order logic or the PRO version.

### 4.3 No Path-Dependent Logic
Vectorized backtesting cannot easily handle:
- State machines that depend on previous bars in a non-vectorizable way
- Complex exit logic that depends on intra-bar price action
- Your shadow resolver's exact bar-by-bar scoring would need reimplementation

### 4.4 Python Only
- Cannot be called directly from Node.js
- Would need a separate Python process, API bridge, or subprocess calls
- Or convert to a standalone research tool

### 4.5 Futures-Specific Features Missing
- No built-in point-value / tick-size handling
- No contract multiplier
- No overnight flatten rules (must be coded manually)
- No session-window filtering (must be coded manually)

### 4.6 License Restriction
- **Apache 2.0 with Commons Clause**
- Free to use for any purpose
- **Cannot sell products/services that derive their value primarily from VectorBT**
- For personal trading research: completely fine
- For a commercial product: would need a commercial license

---

## 5. Can It Replace Your Backtest Engine?

**Short answer: No, not directly.**

### Why Your Engine Is Better for LIVE Validation

| Feature | Your Engine (backtest.js) | VectorBT |
|---------|---------------------------|----------|
| Reuses EXACT live detectors | ✅ Yes | ❌ No — must reimplement |
| Multi-TF alignment (no lookahead) | ✅ Yes | ⚠️ Manual alignment |
| Playbook B limit fill logic | ✅ Yes | ❌ Basic only |
| Overnight flatten enforcement | ✅ Yes | ⚠️ Manual |
| Risk gate (too big/too small) | ✅ Yes | ⚠️ Manual |
| Same-bar stop/target tie-breaking | ✅ Yes | ⚠️ Manual |
| Pessimistic simulation defaults | ✅ Yes | ⚠️ Manual |
| Runs in Node.js | ✅ Yes | ❌ Python only |

Your engine was deliberately built to answer: "Does the code that runs live actually work?" VectorBT answers: "Does this vectorized logic produce profits?" Different questions.

### Why VectorBT Is Better for PARAMETER RESEARCH

| Feature | Your Engine | VectorBT |
|---------|-------------|----------|
| 10,000 parameter combos | ❌ Hours/days | ✅ Seconds |
| ADX threshold sweep | ❌ One at a time | ✅ One call |
| Walk-forward optimization | ❌ Manual | ✅ Built-in |
| Interactive heatmaps | ❌ No | ✅ Yes |
| Multi-symbol comparison | ❌ Manual | ✅ One call |
| Rapid experimentation | ⚠️ Slow | ✅ Fast |

---

## 6. Integration Paths (If You Want to Use It)

### Option A: Standalone Python Research Tool (RECOMMENDED)
Keep VectorBT as a separate research environment:
1. Export OHLCV bars from your app to CSV/JSON
2. Load into VectorBT notebooks for parameter sweeps
3. Identify promising parameter ranges
4. Validate winners in your event-driven engine

**Effort:** Low
**Risk:** None — doesn't touch your live app
**Benefit:** Fast parameter research without rebuilding your engine

### Option B: Python Subprocess from Node.js
Your Node.js app spawns Python scripts:
1. Export bars to file
2. Call `python vectorbt_research.py --config adx_35_40 lookback_5_20`
3. Parse results back into your UI

**Effort:** Medium
**Risk:** Low — isolated subprocess
**Benefit:** Integrated into your workflow

### Option C: Full Reimplementation (NOT RECOMMENDED)
Rewrite your backtest engine in Python using VectorBT:
- Lose the detector-exact guarantee
- Lose multi-TF precision
- Lose all the pessimistic edge cases you fixed

**Effort:** Very high
**Risk:** High — would produce different numbers than live
**Benefit:** None that you don't get from Option A

---

## 7. Should You Clone VectorBT into Jr kilo?

### My Recommendation: NO, but use it as a research tool

**Reasons NOT to clone:**

1. **License friction**: Apache 2.0 with Commons Clause means you can't build a commercial product on it. For personal research it's fine, but cloning into your project creates a dependency you may later regret.

2. **Wrong architecture for your needs**: Your app is Node.js. VectorBT is Python. Cloning it means maintaining a Python codebase you didn't write, which you'd have to understand deeply to trust for prop trading decisions.

3. **You don't need its speed**: DSH's robustness grid was 16 cells. Your current engine handles that fine. You'd need 100+ parameter combinations to justify VectorBT's vectorization.

4. **You'd lose detector-exactness**: The whole point of your engine is that it tests the EXACT code that runs live. VectorBT would require reimplementing your detectors, and a reimplementation is by definition not the same code.

### What you SHOULD do instead:

**Use VectorBT as a standalone research environment:**
1. Install it in a separate Python virtual environment
2. Export your bar data (`DATA/bars/mnq_*.json`) to CSV
3. Run parameter sweeps in Jupyter notebooks
4. When you find promising ranges, validate them in your Node.js engine

This gives you the speed benefit for research without compromising your live-validation guarantee.

---

## 8. Specific Use Cases for MNQ Co-Pilot

### Use Case 1: DSH V2 Parameter Robustness
**Current state:** DSH tested 4-5 values of ADX threshold (30, 35) and lookback (10)
**VectorBT would allow:** Sweep ADX 25-40, lookback 5-20, daily cap $500-$2000 in one 10-second call
**Benefit:** Honest robustness grid instead of cherry-picked values

### Use Case 2: Regime Analysis
**Current state:** DSH manually tested 5 regimes
**VectorBT would allow:** Walk-forward optimization across rolling 3-month windows, testing if ADX filter holds across all regimes
**Benefit:** Answer "does this edge survive regime changes?" with data

### Use Case 3: Multi-Strategy Comparison
**Current state:** Test one playbook at a time
**VectorBT would allow:** Test A/B/C/D + DSH V2 + any new idea simultaneously across all parameter combinations
**Benefit:** See which strategy actually wins, not just which one you tested first

### Use Case 4: Entry/Exit Sensitivity
**Current state:** Fixed 2R target, fixed 3pt stop
**VectorBT would allow:** Test target=1R, 1.5R, 2R, 2.5R, 3R × stop=2pt, 3pt, 4pt, 5pt — all at once
**Benefit:** Find the actual R-multiple sweet spot for MNQ

---

## 9. Concrete Recommendation

### Phase 1: Standalone Research (Do This Now)
1. Install Python 3.10+ and VectorBT in a separate venv
2. Export your existing bar data to CSV
3. Replicate DSH V2 results to verify VectorBT gives same numbers
4. Run the full parameter grid (ADX 25-40, lookback 5-20, etc.)
5. Identify the top 5-10 parameter combinations

### Phase 2: Validate Winners (After Phase 1)
1. Take the top parameter combos from VectorBT
2. Run them through your Node.js backtest engine (the detector-exact one)
3. If they still pass, they're real edges
4. If they fail, VectorBT's vectorization hid a flaw

### Phase 3: Decision Point
- If VectorBT finds edges your engine missed → consider why (lookahead? fill logic?)
- If VectorBT confirms your engine's results → you have a robustness grid
- If neither finds edges → the strategy space is exhausted, move on

---

## 10. Bottom Line

| Question | Answer |
|----------|--------|
| Is VectorBT powerful? | Yes — the vectorization is real, the speed claims are legitimate |
| Should you clone it? | No — wrong language, wrong architecture, license friction |
| Should you use it? | Yes — as a standalone research tool for parameter sweeps |
| Will it replace your engine? | No — your engine is more accurate for live validation |
| Will it help find strategies? | Maybe — but only if you validate its findings with your engine |
| Is it worth the setup time? | Yes — if you're going to do serious parameter research |

**The honest answer:** VectorBT is a research accelerator, not a replacement. Use it to generate hypotheses (parameter combos that look promising), then use your existing engine to validate them rigorously. This is exactly what DSH did manually — VectorBT would just do it 100x faster.
