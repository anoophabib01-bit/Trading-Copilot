# Part 6 — Implementation Runbook (auto-start)

Source: AUDIT_WHY_NO_PAYOUT.md, Part 6. Each step: READ the file first (edit tool requires it),
then make the minimal change, then note what changed. Do them in this order — cheapest/safest
first, biggest code changes last.

## Order & steps

1. sizeCap → 2  (app/rules.json)
   - sizeCap and sizeFloor are already 2. Keep them 2. Do NOT raise.
   - sizeCapMin:2 / sizeCapMax:6 stay as the dial bounds, but leave sizeCap at 2 (the safe default).
   - stageRules.eval.sizeCap = 2 and stageRules.funded.sizeCap = 2 are already correct. Verify only.

2. Remove plain-text API keys  (~/.trading-copilot-config.json)  [CAUTION]
   - First CONFIRM which provider is actually active (CLAUDE.md says DeepSeek is primary; the config
     holds apiKey=Anthropic, groqApiKey, geminiApiKey, omniRouteApiKey, disableOmniRoute:true).
   - Only remove keys that are NOT in use: Anthropic apiKey and omniRouteApiKey are safe to remove
     (both providers removed from code). KEEP geminiApiKey (break-glass fallback) and whatever the
     active DeepSeek credential is (likely an env var — find it before touching anything).
   - If unsure, blank the value but leave the key name, and log it. Do not break the live LLM.

3. Lucid → Tradeify cleanup  (Prop Trading/CLAUDE.md)
   - Firm references: live accounts are Tradeify (TDFY prefix), not Lucid. Update the header/firm lines.
   - Reconcile daily-loss tiers with app/rules.json (base −250/−350/−500 vs scalper −200/−300/−400)
     so the rulebook and engine state the same numbers.

4. Broker reconciliation before scoring  (app/tv-broker-feed.js)
   - Find the fold that produces trade count / contracts / day P&L. Add a drift check: app count vs
     broker order history. On mismatch, set a dataIntegrityHold flag and surface it instead of
     silently scoring. (Evidence: 6 trades/47 contracts vs broker 4/41 on 2026-09-03.)

5. Oversize guard: flatten-to-cap + lock day  (app/oversize-guard.js)
   - Change warn-only to: on oversize, send the reduce-to-cap order AND set a day lock (no further
     entries), not just a warning. oversizeGuard.enabled is already true; keep maxPerDay/cooldown.

6. Signal gating  (app/signal-alert.js + monitors)
   - Chime only on real signals inside the NY edge window (19:00–21:00 IST) with 1H alignment.
   - Suppress the PO3 'still inside the opening range' heartbeat from the chime (it fired ~8x/40min).

7. Payout HUD number  (app/renderer/app.js)
   - One line: funded = $104,000 (payout target), current balance, distance to target, and today's
     consistency allowance (best day ≤ 40% of running total profit). Kill the stale Lucid 52000/800–1200.

8. Enable autonomyModes.assist + take-profit signal  (app/autonomy-modes.js + app/playbook-spec.js)
   - Flip assist.enabled → true, sizes [2].
   - Add the symmetric EXIT/TAKE-PROFIT signal: when a monitored trade hits target (or captures a
     threshold % of the move), emit a 'TAKE PROFIT' line — the entry/exit pair he asked for.

## Guardrails while implementing
- This is a LIVE trading app. Make additive/reversible edits; keep the crash guards in server.js intact.
- After edits, run: cd app && npm test (fast, 1700+ tests) to catch regressions.
- Do NOT change a trading-rule number in code — put it in rules.json and read it from there.
- Before finishing, re-read AUDIT_WHY_NO_PAYOUT.md Part 6 and confirm all 8 are done or explicitly deferred.
