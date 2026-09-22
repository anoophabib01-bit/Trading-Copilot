# Marketing: pricing page + free tier spec

Two things live here: the pricing page itself (`pricing.html`), and the reasoning plus the
build spec for the free tier it promises.

---

## 1. The pricing decision

| Tier | Price | Model | Why it exists |
|---|---|---|---|
| **Free** | $0 | — | Lets a stranger see the one thing that is remarkable: the HUD saying NO |
| **Local** | **$149** | one-time | The differentiator. No competitor in this market sells one-time |
| **Cloud** | **$19/mo** | subscription | Where the real recurring cost is: hosting, TradingView connectivity, AI calls |

### Why Local is one-time and Cloud is not

Local costs nothing to run. It lives on the trader's machine, reads their chart through their
own TradingView, and uses their own LLM key. A subscription there would be charging for nothing,
and traders notice that.

Cloud is the opposite. Hosting their data, keeping a TradingView connection alive, and paying
for AI review are all real monthly costs. Billing monthly for it is not a trick.

**Do not collapse these into one model.** The one-time Local tier is the only claim in this
market that no competitor can copy, because their architecture will not allow it. The Cloud tier
is what pays for your time.

### The two anchors on the page

1. **The comparison table.** TradeZella Pro is $531 in year one. Local is $149 once. Every tool
   listed bills again next year; only one does not. The prices in that table were read from the
   vendors' own pricing pages, and the page says so.
2. **The $784.50 / $0 block.** It is the trader's own data, and the arithmetic is the pitch:
   one eval reset costs $150-300, so a single prevented blow-up pays for the product.

### What is deliberately NOT on the page

No profit curve. No win rate. No "members made $X". The entire signal industry runs on
unverifiable performance claims -- one reviewed competitor published a 38%-accuracy month as
+256% profit with no drawdown figure. Refusing to make that claim is a trust position, and it is
stated outright in the FAQ.

---

## 2. Free tier -- build spec

The free tier is not a trial with a timer. It is a **permanently useful, permanently limited**
version. It must be genuinely useful or it will not spread, and genuinely limited or nobody
upgrades.

### What Free includes

| Feature | Behaviour in Free |
|---|---|
| **GO / NO-GO verdict** | Full, live, accurate. This is the hook and must never be degraded |
| **Rules checklist** | Full -- the pre-session ritual and readiness score |
| **Session log** | Full, local only |
| **Discipline score** | Full, including plan-adherence grading |
| **Instruments** | One |
| **Enforcement** | **Advisory only** -- it shows NO-GO, it does not block or interrupt |

### What Free deliberately withholds

| Feature | Why it is paid |
|---|---|
| **Actual enforcement** | The core value. Free advises; Local refuses |
| Cooldown lockout | Enforcement |
| News blackout forcing | Enforcement |
| Oversize guard freezing entries | Enforcement |
| Unlimited instruments | Natural, honest limit |
| Cloud sync and AI review | Real server cost |

### The upgrade moment

Free must produce exactly one repeatable moment of friction: the trader sees **NO-GO**, takes
the trade anyway, and it goes against them. The app then shows them the number.

That screen is the entire upsell. It should say, plainly:

> You were told NO-GO at 10:42. You took it anyway. That trade cost you $X.
> Local would have refused it.

Do not add artificial limits or nag screens. The product should make the case by being right.

### Implementation notes

- The GO/NO-GO engine already exists and is described as mechanical (session window plus HTF
  alignment). Free runs the same code path -- do **not** fork the logic, or the free tier will
  drift and start lying.
- The difference between Free and Local is one boolean at the enforcement call sites, not a
  separate build.
- A licence check on launch (Gumroad or Paddle), validated online once, with a 7-day offline
  grace period. Never ship a client-side keygen.

---

## 3. Objection handling

| Objection | Answer |
|---|---|
| "I already use TradeZella." | Keep it. TradeZella tells you on Sunday what you did wrong on Tuesday. This refuses the trade on Tuesday. Different job, different moment. |
| "Why would I pay if it's free?" | Free tells you. Local stops you. That is the whole difference, and it is the difference between knowing and doing. |
| "How do I know it works?" | You do not, yet. There is a free tier so you can find out before paying, and a 14-day refund if it does not fit. |
| "$149 is a lot for a small tool." | One eval reset is $150-300, and this account has spent $784.50 on resets and taken $0 out. |
| "Can't I just be disciplined?" | You can. You have been trying. The app exists because in the moment, under stress, that has not held -- and there is a recorded session where the size taken was ten times the rule. |
| "Is this financial advice?" | No. It never suggests a trade. It only checks yours against your rules. |

---

## 4. Headline options

The page uses the first. Keep the others for ads and social.

1. **The app that says no when you can't.** (current)
2. Every trading tool sells you more information. This one tells you to stop.
3. You do not have a strategy problem. You have a discipline problem. Here is the proof.
4. It refuses the trade you were about to regret.
5. Your rules, enforced. Not remembered.

---

## 5. Before this page goes live

1. **Decide the repo question.** The GitHub repo is public. Either open-source it deliberately
   and sell support/hosting, or make it private. Do not launch a paid product while the source
   is one clone away.
2. **Build the Free tier.** The page promises it; the page cannot ship before it exists.
3. **Pick a payment processor.** Gumroad is the fastest. Paddle handles VAT and is more
   professional. Either way, the licence check has to work before you take money.
4. **Fix the pricing page's real prices** against the vendors one more time on the day you
   publish, and date the claim.
5. **Decide the entity.** Competitors actively market being a registered company as a trust
   signal. Buyers are handing money to a stranger on the internet.

---

## 6. Honest status of this deliverable

- `pricing.html` is a complete, styled, self-contained page. Verified to render correctly.
- The free tier is **specified, not built**. It is the larger of the two jobs.
- The prices in the comparison table were read from vendor pricing pages during research in this
  session. Re-verify before publishing.
- Nothing here has been shown to a real trader yet. That is still the missing step.
