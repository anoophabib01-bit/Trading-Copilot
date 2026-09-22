# Setup wizard

Standalone pre-flight for a new trader. Runs on **port 7434** and never touches the
trading app, its port (**7433**), or its live UI.

## Run it

Double-click **`SETUP.bat`** in the project root, or:

    node setup/server.js

Then open http://127.0.0.1:7434/ (the launcher opens it for you).

## What it does

1. **Checks the machine** -- Node version, app files, TradingView bridge, TradingView
   Desktop install, CDP port 9222, rules file writability.
2. **Collects your profile** -- name, instruments, firm, account size, timezone.
3. **Collects your firm's limits** -- daily loss limit, drawdown threshold, profit target.
4. **Collects your risk rules** -- trade caps, cooldowns, size caps, max loss per trade.
5. **Collects your session windows** -- when you are allowed to trade at all.
6. **Writes** `app/rules.json` and `app/profile.json`, backing up the previous files.

## What it will not do

- Place, modify or read orders
- Change anything in `app/renderer/` or `app/server.js`
- Send anything off this machine

## Files

| File | Purpose |
|---|---|
| `server.js` | The wizard server. Also the API: `/api/probe`, `/api/current`, `/api/save` |
| `wizard.html` | The whole UI, no dependencies, no build step |
| `backups/` | Timestamped copies of every `rules.json` / `profile.json` it overwrites |

## How rules.json is written

It **patches the existing file** rather than replacing it. Only the keys the wizard owns are
changed; comments, scalper overlays and anything else already in the file are preserved. If
`rules.json` is missing it starts from an empty base.

## API

    GET  /api/probe     -> environment check results
    GET  /api/current   -> current rules.json + profile.json
    POST /api/save      -> { answers: {...} } -> writes both files

## Re-running

Safe. Every run backs up first. Re-run it whenever your firm's limits change or you want
to move a number.
