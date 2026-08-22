# Research: @chanellethetrader — and why the premise of this request doesn't hold

**Researched:** 2026-08-13 · **For:** Anoop Habib
**Request as given:** *"deep research of this page and how she built the automated system for trading props"*

---

## The finding, before anything else

**There is no automated system.** Not a hidden one, not an undocumented one — the claim
is contradicted by her own website, in her own words.

Her site, `chanellethetrader.com`, closes with this disclaimer:

> "I will not message you first on social media, I will never ask you to send me money,
> nor do I have Telegram or signals group. **I only teach people how to trade themselves.**"

That last clause is the whole answer. She sells *manual discretionary* trading education.
The word "automated" does not appear anywhere in her public material. If this research file
had been written to the brief as phrased — "how she built the automated system" — every
technical detail in it would have been invented, because there is no source material to
draw from.

This matters more than usual here. `TRUST-PROTOCOL.md` Rule 1 in this repo exists because
a component stated something it could not verify and cost real money. The same standard
applies to a research document: a confidently-written architecture write-up of a system
that does not exist is the identical failure, in prose instead of code.

---

## What she actually is (verified)

| Item | Detail | Source |
|---|---|---|
| Real name | Chanelle Helle-Nielsen | Instagram display name |
| Market | Futures (also references forex, gold) | Own bio / TikTok tags |
| Based | New Zealand | Search result summary |
| Named strategy | "Golden Hour Strategy" | TikTok/IG content references |
| Method | Manual, discretionary, session-timing based | Own disclaimer |
| Site built with | Lovable (no-code AI site builder) | `og:title` is a raw project UUID |

### Her actual revenue model — three streams

Taken verbatim in substance from her landing page:

1. **Prop firm affiliate.** *"Trade up to $6,000,000 of capital. Use code **CHANELLE**
   for 80% off my #1 prop firm."* She earns commission on evaluation purchases.
2. **Paid community.** *"Financial Freedom Country Club"* — *"Join 200+ successful traders
   getting my complete A-Z system, live trading sessions, and 1-on-1 support."*
   Positioned as *"$0 to $10K/month."*
3. **Low-ticket ebook.** *"Forex Freedom Formula"* at $28, framed as
   *"Understand Trading in 60 Minutes."*

This is a standard creator-education funnel: free short-form video → $28 ebook →
recurring community → affiliate commission on prop evaluations. It is not, on the
evidence, a trading-technology operation.

---

## The conflict of interest you need to see clearly

**Stream 1 pays her when people buy prop firm evaluations.** Not when they pass. Not when
they get a payout. When they *buy*.

Set that against your own numbers, which are recorded in this repo and are not in dispute:

- **$1,225.50** spent on prop evaluations to date
- **$0** received in payouts
- **16 accounts** breached
- Current funded account balance **$48,567**, floor **$48,456** — cushion of roughly **$111**

You are the exact customer that an evaluation-affiliate funnel is optimised to acquire.
The "80% off" framing lowers the barrier to buying the next one, and buying the next one
is the specific behaviour that has cost you $1,225.50 so far.

I am not claiming she is dishonest. Her disclaimer is unusually clean — no signals group,
no DMs, no asking for money directly — which is more than many accounts in this space
offer. The point is structural, not moral: **her incentive is evaluation volume, and your
problem is evaluation volume.**

---

## What "Golden Hour" appears to be (low confidence)

Public references are limited to short-form video titles and hashtags. No rule set, no
entry/exit criteria, no backtest, and no verified track record are publicly available.
From the name and her session-timing content, it is most likely a *time-of-day filter* —
restricting trading to one high-liquidity window.

**If that is what it is, you already have the mechanism.** `rules.json` in this repo holds
`sessionWindowsIST`, and your app already enforces session windows. You would not be
buying a strategy; you would be buying a specific window number, which you can derive from
your own fill history for free.

Worth noting: your Journal's "P&L by hour (IST)" chart already exists and does exactly
this analysis on your real trades. That is a stronger basis for choosing a trading window
than any external strategy, because it is measured on *your* execution rather than someone
else's.

---

## Research limitations — stated, not hidden

- **Instagram could not be read.** The profile is login-walled; both direct fetch and
  Firecrawl (stealth proxy) failed. Nothing in this document comes from her Instagram
  posts themselves.
- **TikTok could not be scraped** — unsupported by the tooling.
- **No verified P&L.** No payout statements, broker records, or third-party verification
  of her trading results are publicly available. Claims like "$0 to $10K/month" are
  marketing copy, not audited figures.
- Everything above is sourced from her own landing page and public search metadata.

---

## The recommendation

**Do not buy an evaluation with the CHANELLE code, or any code, right now.**

Not because of anything about her. Because of your own measured numbers, computed this
morning by `points-tracker.js` from your real 47 trades:

- Expectancy: **−3.52 points per trade**
- avgW:avgL: **0.73 : 1** (you need >1.38 at your 42% win rate just to break even)
- Rolling 10-trade ratio: **0.53 : 1**
- App's own sizing verdict: **"minimum size, no discretion"**

A negative-expectancy process does not become positive by being funded with more capital,
and it does not become positive by adding a new strategy on top. It becomes positive by
fixing the exit — your median win is **+4.5 points** against a median loss of **−10.9
points**.

One thing from her material *is* genuinely worth taking, and it is free: the session-window
discipline implied by "Golden Hour." Run your own hour-by-hour P&L in the Journal tab,
find the window where your expectancy is actually positive, and trade only that. That
costs $0 and it is grounded in your data instead of hers.

**The sweet-spot finding from your own account, for reference:** 2 lots is your only
size bucket with positive expectancy (+3.30 pts/trade across 20 trades). 1 lot, 3–5 lots,
and 6+ lots are all negative.

---

## Sources

- [chanellethetrader.com](https://chanellethetrader.com/) — landing page, retrieved 2026-08-13
- [Instagram @chanellethetrader](https://www.instagram.com/chanellethetrader/) — profile name only; content not accessible
- [TikTok @chanellethetrader](https://www.tiktok.com/@chanellethetrader) — video titles via search index only
- [Threads @chanellethetrader](https://www.threads.com/@chanellethetrader)
- [YouTube @ChanelleHelle-Nielsen](https://www.youtube.com/@ChanelleHelle-Nielsen) — not reviewed

---
---

# PART 2 — Automated prop-firm trading via TradingView MCP

**Researched:** 2026-08-21 · **Added at Anoop's request**

## The headline: there is an execution gap, and you are already standing on the wrong side of it

Every TradingView MCP server in existence — including the one this repo is built on —
**reads and controls charts. None of them place broker orders.** That is not a missing
feature, it is the deliberate design boundary.

The upstream project you forked, [`tradesdontlie/tradingview-mcp`](https://github.com/tradesdontlie/tradingview-mcp)
(5.7k stars, MIT), states it plainly. Under *"What This Tool Does Not Do"*:

> Execute real trades (chart interaction only)

And in its disclaimer, under uses the tool **must not** be put to:

> Performing automated trading or algorithmic decision-making using extracted data

**Your local copy has execution tools the upstream explicitly disclaims.** `trading_place_market_order`,
`trading_get_account`, `trading_get_positions`, `trading_get_orders` are live in your MCP
surface. `app/CLAUDE.md` already documents `handleTradeConfirm` as *"the ONLY code path
that can call `trading_place_market_order`"*, gated by `trade-confirm-rules.js`. So you
did not merely install a chart-reader — you extended it across the line the upstream drew.

That is not automatically wrong. It is your machine, your subscription, your risk. But it
means the honest framing of "can I automate prop trading with TradingView MCP?" is: *you
already did the hard part, and the remaining questions are compliance ones, not technical
ones.*

---

## What actually exists in this space (2026)

### 1. Prop firms are starting to ship MCP — read-only

**FundedNext** appears to be the first prop firm to launch its own MCP server, letting
traders connect accounts to Claude, ChatGPT, or Gemini. It is free. Critically, per the
reporting, it provides **read-only access to account information and cannot execute
trades or modify account settings.**

The pattern is worth noting: the first prop firm to touch MCP deliberately shipped it
without an execution path. That is a signal about where the industry considers the
liability line to sit.

### 2. Community TradingView MCP servers — all chart-layer

| Project | What it does | Execution? |
|---|---|---|
| [`tradesdontlie/tradingview-mcp`](https://github.com/tradesdontlie/tradingview-mcp) | Drives TradingView **Desktop** via Chrome DevTools Protocol on port 9222. 78 MCP tools. **This is your base.** | No (by design) |
| [`atilaahmettaner/tradingview-mcp`](https://github.com/atilaahmettaner/tradingview-mcp) | Market data, technical analysis, screeners, backtesting. Hosted or self-host. | No |
| [`bidouilles/mcp-tradingview-server`](https://github.com/bidouilles/mcp-tradingview-server) | Programmatic access to TradingView indicators + market data for strategy development. | No |

### 3. The bridge products that DO execute

Webhook routers such as **PickMyTrade** take TradingView *alerts* and forward them to
live broker and prop-firm accounts. This is the mature, boring, widely-used path:
Pine Script strategy → TradingView alert → webhook → broker API. It does not involve MCP
or an LLM anywhere in the execution path, which is precisely why it is reliable.

**Architecturally this matters.** An LLM in the order path adds latency, non-determinism,
and a failure mode where the model hallucinates a fill. A webhook does not.

---

## Prop firm automation rules — the part that decides everything

Rules differ per firm and change often. **Verify on your firm's own site before going
live; the summaries below are from third-party comparison sites and could be stale.**

| Firm | Bots/EAs | Key constraints |
|---|---|---|
| **Tradeify** *(your current firm)* | Allowed on Select accounts | **Sole ownership verification required** — no shared access, and running the same bot across multiple firms gets flagged. HFT prohibited. EOD drawdown on Select suits most systematic strategies that don't hold through close. |
| **Lucid Trading** *(your previous funded firm)* | Allowed — bots, EAs, copiers, API strategies in any language, no special approval | **≥5 second minimum hold**, and **≥50% of profit must come from trades held >5s.** HFT prohibited with automated detection — repeat offences mean profit removal and account closure. Hedging hard-banned, including across accounts. |
| **Topstep** | Allowed in Combine and Funded | API access via TopstepX (ProjectX-based). Restricts HFT and latency arbitrage. Won't help you debug your bot. |
| **Apex** | Semi-automated and DCA-style allowed | Tighter on **fully autonomous** entry+exit on PA/funded accounts. Core principle: a human decides each entry. |

**Note a conflict in the sources:** one comparison site claims Apex, Topstep and
MyFundedFutures permit algo trading "without restrictions," while more detailed writeups
describe real limits on Apex funded accounts. When sources disagree, the firm's own
support desk is the only authority. Do not deploy on the strength of a comparison table.

### The compliance detail nobody mentions until it bites

**CME Rule 575 requires automated orders to be flagged `isAutomated: true`.** If you route
orders programmatically to a CME product — which MNQ and MGC both are — and do not flag
them, that is an exchange rule issue sitting *underneath* whatever your prop firm's
policy says. Your `handleTradeConfirm` path should be checked against this before it is
ever used unattended.

---

## Where you actually stand — measured, 2026-08-21

Your setup changed materially since Part 1 was written. Current state on disk:

- **You are on a Tradeify $50K evaluation** (`DATA/accounts/s2/meta.json`, name `"Tradify 01"`,
  stage `eval`, balance $50,078.35, floor $48,123). Not the Lucid funded account.
- **The Lucid funded history is gone.** Slot `s3` — which held 2026-08-05 through 08-12,
  the six days behind every number in Part 1 — now contains only `ck_history.json`. Slots
  s1, s3, s4, s5 are all empty shells. `server.js` has a `dataWipeAccount(slotId)` that
  does a recursive delete; whether that ran or the slots were reconfigured, the trade-level
  data is not recoverable from `_backups/` (which holds only source files, no DATA).
- **One trading day is logged:** 2026-08-18. 7 trades, 17 contracts, net **+$123**.

### The genuinely good news, and it is directly relevant to automation

Hold times on 2026-08-18, in seconds: **23, 142, 146, 249, 395, 801, 1774.**

Zero trades under 5 seconds. **100% of gross profit came from trades held longer than 5
seconds.** Against Lucid's 5-second rule that is a clean pass with no margin anxiety —
and against Tradeify's HFT prohibition it is nowhere near the line.

Compare that to the archived $150K eval data still in `account_archives.json`, where one
session recorded `"under5": 20` out of 21 trades. That was a genuine rule-violation risk.
It is gone. Whatever changed between then and 08-18, the holding-time problem — which is
the single most common way an automated or semi-automated futures strategy gets an account
closed — is currently solved.

---

## The recommendation

**Do not build the automation yet.** Not because it can't be done — you have already built
more of it than most people ever will — but because of sequencing.

An automated system multiplies whatever expectancy it is given. As of the last full
measurement (47 trades, Lucid funded, now deleted) that expectancy was **−3.52 points per
trade** with an avgW:avgL of **0.73:1**. Automating a negative-expectancy process does not
fix it; it removes the one thing that was slowing the bleed, which is you getting tired
and stopping.

The order that makes sense:

1. **Rebuild the measurement base.** You have exactly one day of data on Tradeify. The
   `points-tracker.js` module built on 08-13 needs ~20–30 trades before `rollingRatio`
   returns anything trustworthy — it deliberately returns `null` below the window size for
   this reason.
2. **Get the rolling ratio above 1.0 manually.** The sizing tiers in `sizeGuidance()`
   already encode this: below 1.0 is minimum size, no discretion. That rule should govern
   a bot exactly as it governs you.
3. **Confirm Tradeify's automation policy in writing, from Tradeify** — specifically
   whether your account type is a "Select" account, and how they want CME Rule 575
   handled.
4. **Only then** consider letting `handleTradeConfirm` run without a human click — and
   even then, the webhook path (Pine alert → broker) is more reliable than an LLM in the
   order loop.

**One thing to fix regardless of automation:** the data loss. Six days of funded trading
history disappeared and nothing in `_backups/` covers `DATA/`. Before another account is
switched or wiped, `DATA/accounts/` needs a backup that is not the app itself.

---

## Sources — Part 2

- [tradesdontlie/tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) — the upstream project this repo forks
- [AI Wave Reaches Prop Firms as FundedNext Launches MCP Server](https://www.tradingview.com/news/financemagnates:17825c29a094b:0-ai-wave-reaches-prop-firms-as-fundednext-launches-mcp-server/) — TradingView News / Finance Magnates
- [atilaahmettaner/tradingview-mcp](https://github.com/atilaahmettaner/tradingview-mcp)
- [bidouilles/mcp-tradingview-server](https://github.com/bidouilles/mcp-tradingview-server)
- [Connect Claude AI to TradingView Using MCP](https://blog.pickmytrade.trade/connect-claude-to-tradingview/) — PickMyTrade
- [Best Algo Friendly Prop Firms 2026](https://blog.pickmytrade.trade/best-prop-firms-algo-trading-bots-2026/)
- [Prop Firms That Allow Automated Trading & Bots (2026)](https://pickmytrade.io/faq/prop-firm-automation)
- [Futures Prop Firms That Allow Automated Trading — Full Rules Breakdown](https://propfirmpinescripts.com/guides/prop-firms-that-allow-automated-trading.html)
- [Algo Trading Futures Prop Firms 2026: What's Allowed and What's Not](https://propfirmplus.com/algo-trading-on-futures-prop-firms-whats-actually-allowed-in-2026/)
- [Tradeify Review & Trading Rules (2026)](https://fundedwiki.com/tradeify) — FundedWiki
- [Lucid Trading Rules & Payouts (2026)](https://damnpropfirms.com/prop-firms/lucid-trading-rules-payouts/) — Damn Prop Firms
- [Lucid Trading FAQ](https://lucidtrading.com/general-faq/) — firm's own site
- [Is Automated Trading Allowed on Prop Firms? Policy Guide 2026](https://sentinel.redclawey.com/blog/automated-trading-allowed-prop-firms-policy-guide-2026)

---
---

# PART 3 — Tradeify vs Lucid Trading, from the firms' own documentation

**Researched:** 2026-08-21 · Sourced from `lucidtrading.com` and `help.tradeify.co` directly

> **Correction to Part 2.** The third-party comparison sites I used were wrong on
> specifics. Lucid's 5-second rule is not "you must hold 5 seconds" — it is a
> >50%-of-profits test. Tradeify's threshold is **10 seconds, not 5**. This is why
> firm documentation beats comparison blogs, and why Part 2's table should be read
> as superseded by this section.

## Side by side

| | **Tradeify** (current — Select eval) | **Lucid Trading** (previous — funded) |
|---|---|---|
| **Programs** | Growth, Select, Lightning Funded | LucidPro, LucidFlex, LucidDirect (instant), LucidLive (real brokerage) |
| **Microscalping** | >50% of **trades AND profits** must be held **>10 seconds**. **Funded accounts only, not evaluations** | Flagged if >50% of profits come from trades held **≤5 seconds**; enforcement requires confirmed bad faith |
| **Algo / bots** | Allowed if you **own the strategy exclusively**, not shared with other traders or firms, not HFT, and **can prove ownership on request** | Automated strategies and third-party copiers permitted; **trader carries all liability for software errors** |
| **HFT** | Prohibited | Prohibited, with **automated detection**; repeat offences → profits removed, account closed |
| **Hedging** | Prohibited — incl. correlated products and across multiple accounts | Prohibited — incl. across accounts and correlated instruments |
| **Drawdown** | **End-of-day trailing** on all account types; only locks in improvement when you finish the day green | Trailing (MLL); breach is a hard fail |
| **Daily loss limit** | **Select eval: none.** Growth: $1,250 on $50K. Select Daily funded: $1,000 on $50K | Not published in the FAQ; per-plan |
| **Max position ($50K)** | **4 minis = 40 micros.** Full size from day one, no scaling ramp | Per approved-products list |
| **Consistency** | Select eval **40%**, Growth 35%, Lightning funded 20% | LucidPro ≤40%, LucidDirect ≤20%; LucidFlex uses 5 profitable days instead |
| **Overnight** | Not allowed. Flat by **4:45 PM ET** (12:59 PM on early-close days) | Not allowed on sim (Pro/Flex/Direct). Flat by **4:45 PM EST**. LucidLive may hold overnight |
| **Trading day** | 6:00 PM ET → 5:00 PM ET next day. **Two sessions in one calendar day = two trading days** | Resume 6:00 PM EST Sun–Thu |
| **Minimum activity** | **≥1 trade per week**, eval and funded. A 5-second trade satisfies it | **30 days idle = permanently deleted, irreversible** |
| **Profit split** | Per program | **90/10** in your favour |
| **Account limits** | 5 funded active at once | 10 eval / 5 funded per household, 10 combined |
| **Resets** | Available on failed evaluations | Eval only, not funded |

## The four things that actually affect you

### 1. The 10-second rule does not apply yet — but it will, and you already pass it

Tradeify's microscalping test applies to **funded accounts only, not evaluations**. So it
cannot fail your current Select eval. But it gates payouts the moment you convert.

Your 2026-08-18 session, hold times in seconds: **23, 142, 146, 249, 395, 801, 1774.**
Every trade over 10 seconds. **100% of trades and 100% of profit pass**, with the shortest
more than double the threshold.

Set against the archived $150K eval data in `account_archives.json`, which logged
`"under5": 20` out of 21 trades in a single session — that would have failed both firms'
tests outright. The behaviour that was your biggest structural risk is currently gone.
Protect it.

### 2. The consistency rule is the trap you have not hit yet

Select evaluation caps your **biggest single day at 40% of total profit**. With one
profitable day logged, your biggest day is 100% of your total — mathematically failing
until you accumulate more green days.

This has a direct, counter-intuitive consequence: **a huge winning day is a liability.**
If you make $2,000 on one day, you need $5,000 total profit before that day stops blocking
your payout. The rule rewards exactly the behaviour your own data says you need — many
small consistent days rather than one hero session.

### 3. End-of-day trailing drawdown changes your intraday risk maths

Tradeify recalculates the drawdown **only at market close**, and only ratchets it up when
you finish the day profitable. Intraday dips do not move your floor.

Practically: your floor is fixed for the whole session. You can compute exact dollar room
at the open and it will not move under you — unlike an intraday trailing drawdown that
tightens as you go green then punishes a giveback. Your current floor is **$48,123** against
a balance of **$50,078.35** — roughly **$1,955** of room, fixed until close.

`rules.json` should encode this as a session-constant floor, not a live-trailing one.

### 4. Two deadlines nobody will remind you about

**Tradeify: at least one trade per week**, evaluation and funded alike. Their own docs say
a 5-second trade satisfies it.

**Lucid: 30 calendar days without trading and the account is permanently deleted** — their
wording is *"Accounts that are automatically deleted cannot be restored later. Removal is
irreversible."* Your last recorded Lucid activity was **2026-08-12**. That puts the deletion
window around **2026-09-11**. If that funded account still exists and you intend to keep it,
that date matters. If you have already let it go, the $1,225.50 lifetime spend in the Cost
tab needs updating to reflect it.

## Automation verdict for your actual situation

Both firms permit bots. Tradeify's condition is the operative one: **exclusive ownership,
not shared across firms, provable on request.** A private repo on your own G: drive
satisfies that comfortably — but the same bot running on both a Tradeify and a Lucid
account would breach the "not shared with other firms" clause.

Neither firm's rules are what should stop you. What should stop you is that you have
**one day of measured data on this account**, and `points-tracker.js` deliberately returns
`null` from `rollingRatio()` below a 10-trade window precisely so that a sizing decision
cannot be made on a sample this thin.

## Sources — Part 3

- [Lucid Trading — General FAQ](https://lucidtrading.com/general-faq/) — firm's own site, modified 2026-06-04
- [Lucid Trading — Prohibited Microscalping](https://support.lucidtrading.com/en/articles/11404742-prohibited-microscalping)
- [Lucid Trading — Prohibited HFT](https://support.lucidtrading.com/en/articles/11404736-prohibited-high-frequency-trading)
- [Lucid Trading — Permitted Activities](https://support.lucidtrading.com/en/articles/11404728-permitted-activities)
- [Lucid Trading — Inactivity Policy](https://support.lucidtrading.com/en/articles/11404632-inactivity-policy)
- [Tradeify — Essential Trading Rules Overview](https://help.tradeify.co/en/articles/12268167-essential-trading-rules-overview) — firm's own help centre
- [Tradeify — Select Evaluation Accounts](https://help.tradeify.co/en/articles/12853921-select-evaluation-accounts)
- [Tradeify — Consistency Rule](https://help.tradeify.co/en/articles/10468320-rules-consistency-rule)
- [Tradeify — Trailing Max Drawdowns](https://help.tradeify.co/en/articles/10495897-rules-trailing-max-drawdowns)
- [Tradeify — Hedging & Correlated Products](https://help.tradeify.co/en/articles/10495868-rules-hedging-correlated-products)
- [Tradeify — Guidelines for Traders](https://help.tradeify.co/en/articles/10468318-guidelines-for-traders)
