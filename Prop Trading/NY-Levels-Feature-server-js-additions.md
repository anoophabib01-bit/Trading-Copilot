# NY Levels feature — code to add to server.js

Status: **drawLevelLine() fix is already saved in your server.js** (solid lines, right-aligned
price labels). That part is done — you just need to fully restart `node server.js` (not just
refresh the browser tab) for it to take effect, since the old dotted-line code was still
running in memory.

This file has the rest: the new "Mark NY Levels" feature. Paste these into server.js yourself —
I hit repeated, unreliable focus/selection behavior in Notepad's Find/Replace overlay in this
environment tonight (text landing in the wrong place multiple times, caught before anything
was saved) and don't want to gamble further with a file that runs your bot. This is copy-paste
safe on your end.

## What this does

Mirrors your existing "Mark London Levels" button, one session later:
- **Mark London Levels** (existing) marks **Asia session High/Low + PDH/PDL** — reference levels
  for the session before London.
- **Mark NY Levels** (new) marks **London session High/Low + PDH/PDL** — reference levels for
  the session before NY. Same pattern, same drawLevelLine() calls, so it automatically gets the
  solid-line/right-label fix too.

London session window used: 1:30 PM IST (London open) to 7:00 PM IST (NY open) — the same
boundary your CLAUDE.md already uses, one session later than the Asia→London boundary your
existing getAsiaHighLow() uses.

## 1. Add this function — paste directly after the closing `}` of `markLondonLevels()`,
before the `// —— ForexFactory → TradingView chart sync` comment block

```js
// London session convention used here: 1:30 PM IST (London open) to 7:00 PM IST
// (NY open) — mirrors the Asia→London boundary above, one session later.
// Pulling 30 x 15M bars (~7.5 hours) is enough to cover that window when this
// runs at/after NY open without reaching back into the Asia session too.
async function getLondonHighLow() {
  try {
    const bars = await getFullBars('15', 30);
    if (!bars.length) return null;
    const londonBars = bars.filter(b => {
      const h = toISTFractionalHour(barTimeToDate(b.time));
      return h >= 13.5 && h < 19.0;
    });
    if (!londonBars.length) return null;
    return {
      londonHigh: Math.max(...londonBars.map(b => b.high)),
      londonLow: Math.min(...londonBars.map(b => b.low))
    };
  } catch (e) {
    console.error('London H/L fetch error:', e.message);
    return null;
  }
}

async function markNYLevels() {
  if (!mcpBridge.ready) {
    broadcast({ type: 'ny-levels', ok: false, status: 'MCP bridge not ready' });
    return;
  }
  try {
    const pdhpdl = await getPDHPDL();
    const london = await getLondonHighLow();
    if (!pdhpdl && !london) {
      broadcast({ type: 'ny-levels', ok: false, status: 'no bar data available yet' });
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const lines = [];
    if (pdhpdl) {
      lines.push({ label: 'PDH', price: pdhpdl.pdh, color: '#d1293b' });
      lines.push({ label: 'PDL', price: pdhpdl.pdl, color: '#16883f' });
    }
    if (london) {
      lines.push({ label: 'London High', price: london.londonHigh, color: '#3b6fb5' });
      lines.push({ label: 'London Low', price: london.londonLow, color: '#3b6fb5' });
    }

    for (const line of lines) {
      await drawLevelLine(line.price, line.label, line.color, nowSec);
    }

    const summary = lines.map(l => `${l.label} ${l.price.toFixed(2)}`).join(' - ');
    const istTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    const message = `NY prep - marked on chart at ${istTime} IST: ${summary}`;
    broadcast({ type: 'ny-levels', ok: true, time: istTime, lines, message });
    telegramBot.notify(`NY prep: ${message}`);
    console.log(`NY LEVELS MARKED: ${summary}`);
  } catch (e) {
    console.error('Mark NY levels error:', e.message);
    broadcast({ type: 'ny-levels', ok: false, status: 'error: ' + e.message });
  }
}
```

## 2. Add a WebSocket case — find the existing case that looks like this
(search for `mark-london-levels` in the `ws.on('message', ...)` switch statement):

```js
case 'mark-london-levels':
  await markLondonLevels();
  break;
```

Add a sibling case right after it:

```js
case 'mark-ny-levels':
  await markNYLevels();
  break;
```

(If the actual case body differs slightly — e.g. wrapped in a try/catch or with a reqId echoed
back — mirror whatever the London case does exactly, just swapping the function name.)

## 3. Add a button in the renderer

I have not opened the renderer files (`renderer/` folder) yet, so I can't hand you an exact
snippet here — that's the one piece still unverified. Find wherever the "Mark London Levels"
button is defined (likely `renderer/index.html` and/or a renderer `.js` file that sends
`{ type: 'mark-london-levels' }` over the WebSocket on click), duplicate it, and change:
- Button label: "Mark NY Levels"
- WS message type sent: `mark-ny-levels`
- Any result-handling code that listens for `type === 'london-levels'` — duplicate for
  `type === 'ny-levels'` if you want a distinct status line/toast for it.

## After pasting all three pieces

Fully stop and restart `node server.js` (close the terminal/process, not just the browser tab),
then click both "Mark London Levels" and the new "Mark NY Levels" button and confirm on your
live TradingView chart that all lines are solid and labels sit on the right near price.
