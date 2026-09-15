# How MNQ Co-Pilot Works — A Plain-Language Guide

**Who this is for:** you don't need to know how to trade, or how to code, to understand this
document. It's written for a human assistant who's never traded before, or anyone new picking up
this app for the first time. By the end you should understand *why* this app exists, *what* it
watches for, and *why* it says no as often as it says yes.

---

## Part 1 — Why this app exists at all

Anoop trades futures — specifically **MNQ** (a smaller version of the Nasdaq-100 stock index) and
**MGC** (a smaller version of gold). Futures are contracts to buy or sell something at a set price
in the future; you don't need to know the mechanics beyond that the price moves up and down all
day, and you make or lose money based on which way you bet and how much you bet.

He trades on money that isn't fully his own yet — a **prop firm** account (currently Apex Trader
Funding). A prop firm lends you their capital to trade with, but only after you pass an
**evaluation**: hit a profit target without losing more than a fixed amount. Blow through that
loss limit even once and the evaluation is over — you start again from zero, and usually pay a fee
to try again.

Here is the uncomfortable fact this whole app is built around: **losing money isn't usually what
fails an evaluation. Losing control is.** Read this real sentence from Anoop's own trading rules:

> *"the size guard is too small or off which was the reason for account to blow up... i can handle
> 6 but yesterday i took 20 size which was unacceptable."*

He didn't lose because his strategy was wrong. He lost because in the moment, under stress, he
took a position **ten times bigger** than his own rule allowed. That's not a math problem. That's
a human problem — the same one that makes people check their phone "just once" during a diet, or
have "just one more" drink. In trading, that instinct has a name: **revenge trading** — trying to
win back a loss immediately, bigger, right now, before you've calmed down enough to think clearly.

**MNQ Co-Pilot exists to be the thing that says no when Anoop, in the heat of the moment, can't say
no to himself.** Everything else in this document is really just describing different shapes of
that one idea.

---

## Part 2 — The trading ideas you need, explained simply

You don't need a finance degree. You need about six ideas, and none of them are complicated once
they're explained without jargon.

### Candles and timeframes

A **candle** is just a snapshot of price movement over a fixed period — it shows where price
opened, where it closed, and the highest/lowest point it touched in between. A green candle means
price went up over that period; red means it went down.

A **timeframe** is how long each snapshot covers. A "5-minute candle" summarizes five minutes of
trading; a "1-hour candle" summarizes an hour. The app watches the *same* market on *several*
different timeframes at once — 5 minutes, 15 minutes, 30 minutes, 1 hour — because a move that
looks big on a 5-minute chart might be nothing on a 1-hour chart, and vice versa. Zooming out tells
you the weather; zooming in tells you what's happening right this second.

### Bias — which way the market is "supposed" to move

**Bias** just means: right now, does the evidence suggest price is more likely to keep going up,
or keep going down? Nobody knows the future, but you can read the recent pattern of highs and lows
and get a reasonable lean.

The pattern the app reads is called **HH-HL** (higher-highs, higher-lows) for an upward bias, and
**LL-LH** (lower-lows, lower-highs) for a downward bias — plain English: each new swing high is
higher than the last one, AND each new swing low is also higher than the last one. That's what
"the market is going up" actually looks like, mechanically, on a chart. When neither pattern is
clean — say, a new high AND a new low at the same time — the market is genuinely undecided, and
the honest answer is "unclear," not a guess dressed up as an opinion.

### Support, resistance, and "sweeping" a level

A **level** is a price where the market has previously turned around — a floor it bounced off of,
or a ceiling it got rejected from. Traders watch these because price often reacts to them again.

A **sweep** (or **liquidity raid**) is when price pushes just past one of these levels — enough to
trigger the stop-losses of everyone positioned against that break — and then reverses right back.
It looks like a trap, because often it is one: bigger players push price just far enough to force
weaker hands out, then take it the other way. Several of the app's strategies specifically wait
for this pattern, because a reversal right after a sweep is a real, repeatable behavior, not a
guess.

### Risk per trade, and why size matters more than being "right"

Every trade needs two numbers before you take it: your **stop** (the price where you admit you're
wrong and get out) and your **size** (how many contracts you're trading). The distance between
your entry and your stop, multiplied by your size, is exactly how much money you lose if you're
wrong.

This is the single most important idea in the whole app: **being right 6 times out of 10 doesn't
save you if the 4 times you're wrong are bigger than the 6 times you're right.** A trader who is
"right" most of the time can still go broke, if their losing trades are allowed to be bigger than
their winning ones. Anoop's own trading history proves this concretely — his data shows that at
2 contracts, funded trading was profitable; at every other size, it lost money overall. Size isn't
a minor detail. It's frequently the difference between a strategy that works and one that doesn't,
even when the underlying idea is sound.

### Discipline vs. outcome — these are not the same thing

This is the idea the app cares about more than any other, and it's the hardest one for a
beginner to accept: **a losing trade that followed every rule is a good trade. A winning trade
that broke the rules is a bad trade — even though it made money.**

Anoop wrote this himself as a hard rule: *"grade the session on plan-adherence, not P&L... broke
the cap or took setups outside the plan and made money anyway = loss, full stop, regardless of
what the account shows."*

Why does this matter? Because luck is real, over any single day. A rule-breaking trade that
happens to work this time teaches you the wrong lesson — it teaches you that breaking the rule
pays. Do that enough times and eventually the luck runs out, usually on a day sized far bigger
than the day before. The app tracks this distinction explicitly: a losing trade with zero rule
violations gets logged as a **disciplined loss** — a genuine positive, not a failure — because
teaching someone that following the rules "doesn't pay" (just because that particular day was red)
is exactly backwards.

---

## Part 3 — What the app actually watches for (the "playbooks")

The app doesn't guess. It watches the chart for a small number of specific, repeatable patterns.
Each pattern is called a **playbook**. Here's what each one is actually looking for, no jargon:

### Playbook A — "The reversal candle"

Watches for a single candle that completely swallows the one before it — its high is higher AND
its low is lower than the previous candle, in the *opposite* direction of what just happened. Think
of it as one candle saying "everything that just happened, I'm undoing, and then some." This is
the most common signal the app produces, checked across several timeframes at once (5-minute,
15-minute, 30-minute, 1-hour).

### Playbook B — "The trap and the follow-through"

This is a two-step pattern. Step one: price sweeps a level (see above — pokes past it, trapping
people, then snaps back). Step two: right after that snap-back, price leaves a visible gap behind
it as it moves — a sign the move has real conviction, not just a bounce. Only when BOTH steps
happen does this playbook consider entering, and even then, the entry is a limit order sitting at
that gap, waiting for price to come back to it — it does not chase.

### Playbook C — "Is this reversal candle actually valid?"

This one doesn't trade anything itself. It's a filter that checks whether a Playbook A candle
(above) is happening in a sensible place — at a genuine swing point, in a structure that actually
supports a reversal — or whether it's just noise. Think of it as a second opinion that can veto
Playbook A's signal, never add one of its own.

### Playbook C-ADX — "Only in a genuinely strong trend"

This one only looks for a very specific, narrow situation: the market is trending strongly (using
a well-known measurement called ADX — think of it as a "how strong is this trend" gauge), moving
in the same direction consistently, and just broke above its recent range on a green candle. It
only trades in the *upward* direction — the data showed that betting on downward breaks of this
exact same pattern actually lost money, so the app doesn't do it. It's currently in "shadow
mode" — it writes down what it *would* have done, without placing any real trade, so its own track
record can be checked before it's ever trusted with real money.

### FVG watcher — "A gap worth knowing about"

Just flags gaps left behind by a fast move, without acting on them. Informational only.

### Power of 3 (AMD) — "Accumulation, Manipulation, Distribution"

This watches for a well-known three-part daily rhythm: the market sits quietly building up orders
early in the day (**Accumulation**), then fakes a move to trap people (**Manipulation** — the same
"sweep" idea from earlier), then makes its real move for the rest of the day (**Distribution**).
Catching the moment it moves from the fake-out into the real move is the whole idea.

**Important thing to understand: none of these fire in isolation.** Above all of them sits one
single check — explained next — that has to agree before some of them are even allowed to act.

---

## Part 4 — The one gate above everything

Before any of the strategies above can act, there's one master question the app asks: **on the
15-minute chart, right now, is the recent pattern of highs and lows clean, and if so, which way?**

If the answer is a clean upward pattern (HH-HL), only upward trades from the gated strategies are
allowed. If it's a clean downward pattern, only downward trades. If the pattern is genuinely mixed
— which happens more often than you'd think, because markets are honestly undecided a lot of the
time — the gated strategies simply stand down and wait. This isn't a bug or a weakness; it's the
app refusing to invent an opinion where the market hasn't actually given one yet.

A 1-hour version of the same check is also read, but it's treated as *evidence*, not a veto — it's
attached to every trade as a fact ("the 1-hour agreed" / "the 1-hour disagreed" / "the 1-hour was
unclear") so a trade taken in a hurry can be judged later against a fuller picture, without letting
a slower chart block a faster, more relevant one.

**Only two of the strategies are actually forced to obey this gate** — the trap-and-follow-through
one (B) and the strong-trend one (C-ADX). The reversal-candle one (A) still checks this gate and
labels every trade with the result, but Anoop deliberately chose to let it fire either direction —
he wants to see every reversal candle and decide for himself whether it's worth trading against the
grain, rather than have the app hide it from him entirely.

---

## Part 5 — The safety rails (this is the actual point of the app)

Everything below exists for one reason: to catch the moment a human being, mid-session, under
stress, is about to do something their calm, rested self already decided not to do.

- **Size cap.** A hard ceiling on how many contracts can go into a single trade. Currently
  adjustable between 2 and 6 by Anoop himself, but **never above 6, no matter what** — that ceiling
  is enforced in the code itself, not just suggested by the interface. Why 6 specifically, and why
  a *range* instead of a fixed number? Because the earlier version of this rule was a fixed "hard
  cap, no exceptions" — and on a bad day, he traded 20 contracts against a cap of 2 anyway. A rule
  that gets ignored isn't a rule. So now he has room to move between 2 and 6 depending on how the
  day is going, but the ceiling above 6 is something the software itself refuses to let happen,
  regardless of what anyone types anywhere.

- **Daily loss tiers.** Three checkpoints as the day gets worse: a caution flag at one loss level
  ("slow down, check your headspace"), a tightening at the next ("only your very best setups from
  here"), and a hard stop at the last one ("close the platform, you are done for today, this is not
  a suggestion"). The idea is to catch the slide *before* it becomes a blow-up, not just stop the
  blow-up after it's already happened.

- **The loss ratchet.** A rule Anoop wrote for himself after noticing his own pattern: *"if I make
  $500 profit today, tomorrow the maximum loss I should face is $500, not $600, $700, or $800."*
  In plain terms — a good day is not license to risk more the next day. If anything, tomorrow's
  ceiling can only ever get tighter after a green day, never looser. This targets a very specific,
  very human failure: a run of good days building false confidence, followed by one day that gives
  it all back and more.

- **Trade count limits.** A hard limit on how many trades can happen in a session and in a day.
  Because more trades isn't more opportunity past a certain point — it's usually a sign of chasing,
  and the data backs this up: fewer trades, not more, tends to characterize the best days.

- **Mandatory breaks between trades.** No re-entering within a fixed window after any trade closes,
  win or lose. This exists specifically to interrupt the revenge-trading impulse — the urge to
  immediately "fix" a loss (or immediately chase a win) before the emotional reaction has had time
  to pass.

- **One instrument per day.** Trading both MNQ and MGC on the same day is banned outright, because
  every past account blow-up on record involved trading both in the same session — splitting focus
  between two markets at once is itself a risk factor, independent of what either market is doing.

- **The oversize guard.** A background watcher that reads the actual broker account — not what the
  app *thinks* is happening, the real numbers from the real trading platform — and can automatically
  reduce a position if it's bigger than the current cap. This is the single most safety-critical
  piece in the app, because it's the one thing that can act *without being asked*, so it has to be
  visibly correct at all times, never silently wrong.

- **The kill switch.** A literal, physical off-button. Click it, and the app force-closes the
  charting application itself — not just its own connection to it — so there's no chart left open
  to act on impulsively. Built at Anoop's own explicit request, in his own words: *"i want you to
  close the tradingview app so that i do not take anymore trades."* It doesn't touch the broker
  account or close any open position — those are managed elsewhere — it exists purely to remove
  temptation from in front of him. Every use is automatically logged into the day's journal entry,
  so a pattern of "how often do I need to use this" becomes visible over time, not just a one-off.

---

## Part 6 — Why it writes everything down

There's a Journal tab where every trading day gets a record: mood, whether the plan was followed,
the main mistake (if any), a free-text note, and one lesson to carry forward. This isn't
busywork — Anoop's own instruction was that whatever he writes here should come back to him as
coaching the next day, specifically so a lesson written once doesn't have to be re-learned the
hard way a second time.

There's also a system called **THE LOOP** that watches for **repeated** patterns specifically —
not just "you were oversized today" but "this is the third time this month you've sized up right
after a loss, and here's what you said to yourself the last two times it happened." Catching a
mistake once is useful. Catching that it's a *pattern* is what actually changes behavior. It only
speaks up on a genuine repeat, and every claim it makes has to point to a real, specific past
trade — it isn't allowed to say "you always do this" without naming exactly when "this" happened
before.

Underneath all of that sits a **chat archive** — a complete, permanent record of literally every
message that has ever appeared in the chat pane: every coaching reply, every alert, every trade
ticket. Nothing in it is ever trimmed or deleted, on purpose. Older versions of this app used to
quietly drop old chat history to save space, which meant a lesson mentioned once, weeks ago, was
simply gone — unrecoverable, not even by searching. Now it's all there, forever, so THE LOOP (and
anyone reviewing the account later) can actually reach back and prove a pattern instead of relying
on memory.

---

## Part 7 — The AI coach, and the "second opinion before a real trade" system

### Jessi — the coach you actually talk to

**Jessi** is the app's main AI persona — the one in the chat box. She isn't a signal generator.
Her job is closer to a disciplined trading mentor sitting next to you: you can ask her to read the
chart, log a trade, explain what a playbook just flagged, or just talk through what happened. She
knows the account's real numbers (balance, today's P&L, how many trades are left, which rules are
currently active) every time she answers, because that context is built fresh into every question
sent to her — she's never working from a stale guess about where the account stands.

There's also a lighter, faster version of her for quick scalping sessions, and a separate persona
that specifically reviews a finished session after the fact and writes up what actually happened.

### The Debate — three perspectives, argued out loud, before a real decision

Before certain trade setups are taken seriously, the app can run something called **the Debate**:
three different AI perspectives argue the SAME moment from three different angles —

- one arguing purely from **discipline and psychology** (is this a good moment to trade at all,
  given the day so far?),
- one arguing purely from **chart structure** (what do the levels and the trend actually say?),
- one arguing from the **Accumulation-Manipulation-Distribution** mechanical read described
  earlier in Part 3.

A fourth AI — **the Judge** — reads all three arguments and writes one final, synthesized verdict.
Only if that verdict is a clear **GO** does it produce a machine-readable trade ticket — a precise
entry, stop, and target — that a human can then choose to confirm. This is deliberately not one
opinion pretending to have considered everything; it's three genuinely separate arguments forced
to disagree with each other out loud, on the record, before anyone acts.

### Why a "GO" from the Judge still isn't automatically a real trade

Even a clean GO verdict, with a full trade ticket attached, still requires a human to press
confirm. And even then, real orders can only go out at all if the app was started in a specific
mode that explicitly allows it (see the **kill switch** and **autonomy** sections) — starting the
app the ordinary way keeps every trade recommendation purely advisory, no matter how confident the
verdict sounds.

---

## Part 8 — How much the app is allowed to act on its own (the autonomy ladder)

This is separate from anything discussed so far, and it's one of the most carefully guarded ideas
in the whole app: **there are four distinct levels of how much the software is allowed to do
without asking**, and moving up a level is never something that happens by accident. You can see
this exact control as four buttons in the titlebar, right next to the account switcher: **YOU —
SHADOW — ASSIST — CONTROL**.

| Rung (button label) | Plain meaning |
|---|---|
| **YOU** | The app only ever comments after the fact. It never speaks before or during a trade — every decision is entirely yours. This is where the app starts every session by default. |
| **SHADOW** | The app privately writes down what it *would* have done — a full trade plan, scored against what actually happened — but places nothing. This is how a new strategy earns trust: by being right on paper first. |
| **ASSIST** | The app proposes a trade ticket, but nothing happens until you personally approve it. It can also print a caution line onto a ticket you're about to confirm ("a major economic report is due in 40 minutes") — it can only ever add caution, never a reason to trade. |
| **CONTROL** | The only rung where the app can place or reduce a real order on its own, and even here it only does so through hard, fail-closed refusal gates — never a reason to act, only a reason to stop. |

**One important detail about how clicking these buttons actually works: your click is a request,
not a guarantee.** Clicking CONTROL asks the app to grant full control — but a separate check
decides whether that request is actually earned yet (has this strategy proven itself in SHADOW
first, for long enough, with a real track record?). If it hasn't, the app can silently grant only
SHADOW instead of what you asked for, and the badge next to the buttons always shows **what you
actually got, not what you clicked**. This is deliberate: a system that quietly gives you what you
asked for, whether or not it's earned, is not actually a safety system.

**As of today, every rung above the lowest (YOU) is switched off.** Nothing in this app places a
real order on its own initiative right now — the one thing that watches the live broker account
and can automatically shrink an oversized position (described in Part 5) is the single narrow
exception, and it can only ever make a position *smaller*, never bigger, never open a new one.

The reason this ladder exists at all, instead of one on/off switch, is the same reasoning behind
everything else in this app: trust has to be earned in stages, on paper, before it's given real
money to act with — and every stage above the bottom one adds exactly one new thing that could go
wrong, on purpose, so that if something ever does go wrong, there's a short, specific list of
suspects instead of "the whole system."

---

## Part 9 — Every tab in the app, in plain words

The app is organized into tabs across the top. Here's what each one is actually for:

- **Analysis** — the live read of the market right now: which way the bias leans, the nearest key
  level, and the step-by-step top-down framework (does the higher timeframe agree, does the lower
  timeframe agree, has price reacted at the zone, has a real trigger candle formed).
- **Checklist** — a pre-session ritual: sleep, stress, whether zones are marked, whether the plan
  is written down *before* trading starts. Some of this can be a hard gate — the app can refuse to
  treat a session as "trading" at all until the checklist is done.
- **Journal** — the daily written record described in Part 6: mood, plan-adherence, mistakes,
  lessons, and now also an automatic log of every time the kill switch was used that day.
- **Brief** — a pre-New-York-session summary of what happened overnight in both MNQ and MGC: the
  gap from yesterday's close, the overnight range, any unusually violent moves, and whether a
  major scheduled economic report (jobs data, inflation numbers, a Federal Reserve announcement)
  falls inside the next 7 days. It deliberately never says "this means go long" or "go short" — it
  only describes what happened and flags *when* something risky is scheduled, never *which way* to
  bet on it.
- **Forensics** — a per-trade autopsy: how far the trade moved in your favor before you exited
  (and how far it kept going after), how far it moved against you, how long it was open, and where
  it sat relative to the day's actual range. This is where "you exited too early" or "you held too
  long" gets proven with real numbers instead of a feeling.
- **Week** — the whole week reviewed together: a calendar of daily results, where the money
  actually came from or went, and a commitment for the coming week that gets checked, not just
  written and forgotten.
- **Insights** — the full history of trading days, one row per day, so a pattern across weeks —
  not just one bad day — becomes visible.
- **Alignment** — your own rules, exactly as the app is actually enforcing them right now, side by
  side with any lessons you've written and "armed" (turned into a live, checkable condition the
  app watches for).
- **Ladder** — a day-by-day plan toward the evaluation's profit target: type in each real day's
  result and watch your cushion above the drawdown floor update automatically, so you can see
  whether you're actually on pace before the deadline arrives. (This is a *different* ladder from
  the autonomy one in Part 8 — same word, two unrelated ideas; worth remembering which is which.)
- **Rules** — a plain readout of every number currently in force: size cap, loss tiers, trade
  limits, session windows — the actual enforced values, not a document that might have drifted out
  of sync with them.
- **Roadmap** — a 90-day self-improvement calendar, broken into three named stages: *"One Clean
  Rep"* (the first three weeks — just execute one good trade cleanly), *"Size the Winner, Not the
  Ego"* (the next month — sizing decisions, not ego decisions), and *"Funded Is a Different Sport"*
  (the final month — funded accounts genuinely require a different mindset than eval accounts).
  This clock runs independently of any single account's own evaluation deadline; it's tracking
  *skill*, not one account's countdown.
- **Lifetime** — one continuous, read-only record spanning every account ever traded on this
  setup, including old blown or archived ones, with each account's boundaries clearly marked. The
  point is a single honest long-run picture — you cannot quietly "forget" a bad account by opening
  a new one, because it stays visible in the lifetime record.
- **Cost** — every fee actually paid across every account attempt, ever, against every payout
  actually received. This is the number that answers the hardest, most honest question a funded
  trader can ask themselves: *am I actually ahead, across everything, or just ahead on the account
  I happen to be looking at today?*

---

## Part 10 — Every "mode" in the app, in one place

The word "mode" gets used for several genuinely different switches in this app. They're easy to
mix up because a few of them even sit next to each other in the titlebar, so this part collects
every one of them, what it actually controls, and — importantly — which ones you can click and
which ones are deliberately locked away from a casual click.

### Account size — 50K / 100K / 150K

Three buttons in the titlebar. This just says how big the underlying account is — a bigger account
has a bigger profit target and a bigger allowed drawdown, proportionally. Clicking one switches
which account you're looking at and working with.

### Eval vs. Funded

Two buttons right beside the size buttons. **Eval** means this specific account is still trying to
pass its evaluation test. **Funded** means it already has, and is now trading with the firm's real
capital. These carry genuinely different rules underneath — a funded account's size cap and loss
limits are deliberately tighter than an eval account's, because the money behind it is real
already, not something still being auditioned for. Anoop's own trading data is blunt about why:
every contract size except one specific size loses money on his funded accounts, while a wider
range works during eval. The rules for each stage are pulled from that evidence, not a guess.

### Standard vs. Scalper — a rulebook choice, not a live switch

This is the one worth being careful about, because it *used* to be a titlebar toggle and no longer
is. **Standard** and **Scalper** are two different trading-style rulebooks — Scalper trades faster,
holds positions for a much shorter window, and runs its own tighter loss tiers; Standard is the
slower, more patient rulebook. At one point you could flip between them with a click mid-session.
That button was deliberately removed — changing which rulebook is active silently changes several
numbers at once (how many trades you're allowed, how long you can hold a position, where the loss
tiers sit), with nothing on screen making that change obvious in the moment. So today, which
rulebook is active is pinned in the app's configuration file, changed only on purpose, in writing
— not something that can be bumped by an accidental click during a live session. As of today, the
account runs on the **Scalper** rulebook.

### The account picker, and a real near-miss

Prop firm traders often run more than one evaluation at once, or move from a failed evaluation to
a fresh attempt. The app has five separate account "slots," each remembering its own balance,
history, and rules independently — switching between them is deliberate, through an account
picker, never silent.

This exists partly because of a real near-miss: at one point, two different slots were both the
same account size and stage, and the picker showed both as identical, plain text — no way to tell
them apart at a glance. The fix was to make every slot's name visible everywhere an action could
possibly affect it, specifically so a click never lands on the wrong account by accident. If
you're ever unsure which account you're looking at, the header will say its name, not just its
size.

### The autonomy rungs — YOU / SHADOW / ASSIST / CONTROL

Covered in full in Part 8. Worth repeating here only to place it correctly among the others: this
is the one "mode" toggle that decides **who is allowed to act**, not which rulebook is being
followed or which account is being looked at. It sits in the same titlebar, right next to the
account switcher, which is exactly why it's easy to lump in with the rest — but it's answering a
completely different question from every other toggle on this list.

---

## Part 11 — What actually makes this app different from an ordinary trading app

A few design choices, taken together, are what set this apart from a typical charting or signal
app:

1. **It reads the real broker account, not just its own memory of what should have happened.**
   Several of the safety systems (Part 5) work by directly reading TradingView's own broker panel
   — the actual position size, the actual order history — rather than trusting the app's internal
   count of what it thinks you did. An app that only trusts its own memory can drift silently out
   of sync with reality; this one is built to notice when that happens and say so loudly, rather
   than confidently display a wrong number.

2. **"I don't know" is a real, first-class answer — not something the app avoids saying.** When
   the market's structure is genuinely mixed, the app says "unclear," not a guess dressed up as
   confidence. When the connection to the chart drops, it says "feed down," not a stale number that
   quietly stops updating while looking current. A tool that can never admit uncertainty will
   eventually be confidently wrong at the worst possible moment — this one is built to prefer an
   honest shrug over a false answer.

3. **It scores discipline, not just profit.** Covered in Part 2, worth repeating here because it's
   genuinely unusual: a rule-following loss is logged as a *positive*, and a rule-breaking win is
   logged as a *negative* — because the whole point is building a repeatable process, and a process
   can only be judged by whether it was followed, not by what a single day's luck happened to
   produce.

4. **New strategies have to prove themselves on paper before they touch money.** The "shadow mode"
   idea from Part 8 means a brand-new pattern-detector gets a real, measured track record —
   win rate, average result, how often it would have fired — before anyone decides whether it's
   worth trusting with real size. Most trading tools either work or don't; this one has a formal,
   built-in trial period.

5. **Automation is opt-in, one careful step at a time, and easy to prove is off.** The autonomy
   ladder in Part 8 means nothing in this app quietly gains the ability to trade on its own — every
   step up has to be a deliberate decision, and right now every step above the bottom is switched
   off. Most tools that offer "automatic trading" are all-or-nothing; this one is built so trust
   can be extended gradually, or never, without an all-or-nothing decision forced on the trader.

6. **The kill switch is a genuine off-button, not a setting.** Covered in Part 5 — most trading
   software assumes you always want it running. This one was built, on the trader's own explicit
   request, with a way to physically remove the temptation from in front of himself, mid-session,
   in one click — because the honest admission behind the whole app is that the biggest risk to
   the account was never the market. It was the moment a rested, careful plan met a stressed,
   impulsive one.

7. **Nothing important is allowed to fail silently.** Repeated throughout this app's own history:
   a guard that's supposed to protect the account, but quietly stops working without announcing it,
   is worse than no guard at all — because it looks like protection while providing none. Every
   safety system here is built to alarm loudly the moment it can't do its job, rather than fail
   quietly and let a bad moment pass unnoticed.

---

## Part 12 — A short glossary, all in one place

| Term | Plain meaning |
|---|---|
| **MNQ / MGC** | The two markets traded — a smaller Nasdaq-100 contract and a smaller gold contract |
| **Prop firm / evaluation** | A firm that lends you trading capital after you pass a test — hit a profit target without breaching a loss limit |
| **Long / Short** | Betting price goes up (long) or down (short) |
| **Candle / timeframe** | A snapshot of price over a fixed period (5min, 1hr, etc.) |
| **Bias** | Which direction the recent evidence leans — up, down, or genuinely unclear |
| **HH-HL / LL-LH** | The specific pattern of rising or falling swing points that defines an up-trend or down-trend |
| **Support / resistance / level** | A price where the market has reacted before and might again |
| **Sweep / liquidity raid** | Price pokes past a level to trap traders, then reverses |
| **Stop (stop-loss)** | The price where you admit a trade was wrong and exit, capping the loss |
| **Size / contracts** | How much you're betting — more size means both bigger wins and bigger losses |
| **Revenge trading** | Trying to immediately win back a loss, usually bigger and worse-planned than usual |
| **Discipline vs. outcome** | Whether you followed the rules, as distinct from whether you made money — the app cares more about the first |
| **Playbook** | One specific, named, repeatable chart pattern the app watches for |
| **The gate** | The one master check (is the 15-minute trend clean, and which way) that some playbooks must obey before acting |
| **Shadow mode** | A strategy that's tracked and scored, but never places a real trade — a trial period |
| **Oversize guard / kill switch** | The safety systems that can act on their own to stop a mistake from getting worse |
| **Ledger / journal** | The written record of what actually happened, used to catch repeated mistakes and lock in real lessons |
| **Jessi** | The main AI coach you actually talk to in the chat pane |
| **The Debate / the Judge** | Three AI perspectives arguing a trade idea from different angles, synthesized by a fourth into one final verdict |
| **Trade ticket** | The precise entry/stop/target a GO verdict produces — still requires a human to confirm before anything real happens |
| **Autonomy ladder (YOU / SHADOW / ASSIST / CONTROL)** | How much the app is allowed to do without being asked — currently sitting at the bottom rung, YOU, for real trading |
| **Account slot** | One of five separate remembered accounts the app can track — each with its own balance, history and rules |
| **Eval vs. Funded** | Whether a specific account has passed its evaluation test yet, or is still trying to |
| **Standard vs. Scalper** | Which trading-style rulebook is active — a deliberately locked-down choice, not a live titlebar switch, since 2026-09-05 |
| **THE LOOP** | The system that notices when a mistake (or a good habit) repeats, and says so with a specific past example, not a vague accusation |
| **Chat archive** | The complete, permanently-kept record of everything ever said in the chat pane |

---

## The one sentence to remember

**This app is not trying to predict the market. It's trying to make sure that when Anoop is
right, he doesn't lose too much on the times he's wrong — and that when he's tempted to break his
own rules, something in the room says no loud enough for him to hear it.**
