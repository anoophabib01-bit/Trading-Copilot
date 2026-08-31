# VectorBT Research Pipeline

Self-contained Python research environment for parameter-sweeping trading strategies against the app's existing bar data.

## Setup

```powershell
cd "Jr kilo\vectorbt-research"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Export bars

```powershell
python export_bars.py
```

Reads `DATA/bars/*.json` (wrapped format) and writes `vectorbt_input.csv` with columns `timestamp,open,high,low,close,volume,timeframe,symbol`.

## Run a sweep

```powershell
python run_sweep.py --timeframe 60
```

Sweeps ADX 25-40 and lookback 5-20 for DSH V2 and prints JSON results to stdout.

## Call from Node.js

```powershell
python call_vectorbt.py --strategy dsh_v2 --params '{"adx_min":35,"lookback":10}'
```

Expected stdout contract:

```json
{
  "results": [...],
  "best": {...},
  "runtime_sec": 2.3,
  "timeframe": "60",
  "bar_count": 1037,
  "date_range": {"start": "...", "end": "..."}
}
```

All debug logging goes to stderr.

### Node.js caller sketch

```js
const { execFile } = require('child_process');
const path = require('path');

function runVectorBTSweep(strategy, params) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, '../../Jr kilo/vectorbt-research/call_vectorbt.py');
    const args = ['--strategy', strategy, '--params', JSON.stringify(params)];
    execFile('python', [script, ...args], { encoding: 'utf8', timeout: 120000 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('Invalid JSON from VectorBT: ' + stdout)); }
    });
  });
}
```

## Strategy registry

| Strategy | Description | Default params |
|---|---|---|
| `dsh_v2` | Long-only ADX-gated Donchian breakout | `{"adx_min":35,"lookback":10,"timeframe":"60"}` |

To add a new strategy, add a function to `STRATEGIES` in `call_vectorbt.py` and implement the logic in a shared module.

## Configuration

Risk parameters are read from `app/rules.json` at runtime:
- `commissionPerContractPerSide` — round-turn cost
- `playbooks.targetR` — risk:reward multiplier
- `dshV2.dailyCapPer2Contracts` — intraday P&L cap
- `flattenByISTMinutes` — hard flatten cutoff (03:00 IST)

## Notes

- All new files live under `Jr kilo/vectorbt-research/`.
- No changes to `app/server.js`, `app/backtest.js`, or any live path.
- The Python script fails closed: if a dependency is missing, it returns `{"error": "..."}` JSON on stdout rather than crashing.
