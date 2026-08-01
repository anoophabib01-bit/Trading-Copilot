# Graph Report - .  (2026-07-08)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 280 nodes · 594 edges · 19 communities (16 shown, 3 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 19
- Community 20

## God Nodes (most connected - your core abstractions)
1. `addSystemMessage()` - 26 edges
2. `broadcast()` - 18 edges
3. `TelegramBridge` - 18 edges
4. `setupWsEvents()` - 16 edges
5. `setupChatListeners()` - 14 edges
6. `handleEngulfSignal()` - 12 edges
7. `handlePlaybookBSignal()` - 11 edges
8. `logTradeForm()` - 11 edges
9. `MCPBridge` - 10 edges
10. `handleFVGSignal()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `setupWsEvents()` --calls--> `addSystemMessage()`  [EXTRACTED]
  renderer/app.js → renderer/app.js  _Bridges community 6 → community 3_
- `setupWsEvents()` --calls--> `applyMechanicalAnalysis()`  [EXTRACTED]
  renderer/app.js → renderer/app.js  _Bridges community 6 → community 1_
- `setupWsEvents()` --calls--> `handleEngulfSignal()`  [EXTRACTED]
  renderer/app.js → renderer/app.js  _Bridges community 6 → community 5_
- `setupWsEvents()` --calls--> `handleSFPSweep()`  [EXTRACTED]
  renderer/app.js → renderer/app.js  _Bridges community 6 → community 19_
- `setupChatListeners()` --calls--> `checkForPatternWarnings()`  [EXTRACTED]
  renderer/app.js → renderer/app.js  _Bridges community 3 → community 5_

## Import Cycles
- None detected.

## Communities (19 total, 3 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (33): broadcastNewsStatus(), classifyNewsEvents(), claudeAgent, computeNewsStatus(), CONFIG_PATH, ENGULF_TFS, engulfMonitors, fetchForexFactoryCalendar() (+25 more)

### Community 1 - "Community 1"
Cohesion: 0.12
Nodes (26): addPatternAlert(), appendToolIndicator(), applyMechanicalAnalysis(), autoResize(), ENGULF_MONS, fillInput(), finalizeAssistantBubble(), isCautionText() (+18 more)

### Community 2 - "Community 2"
Cohesion: 0.09
Nodes (17): Anthropic, buildSystemPrompt(), ClaudeAgent, mcpBridge, TV_TOOLS, { app, BrowserWindow, ipcMain, nativeTheme }, claudeAgent, CONFIG_PATH (+9 more)

### Community 3 - "Community 3"
Cohesion: 0.18
Nodes (21): addSystemMessage(), addUserMessage(), appendFinalToolTick(), appendToCurrentBubble(), escHtml(), handleCsvFileSelected(), handleKey(), loadSettings() (+13 more)

### Community 5 - "Community 5"
Cohesion: 0.19
Nodes (16): buildContextMessage(), cancelStreaming(), checkForPatternWarnings(), closeEngulfPopup(), getSizeFromProfit(), handleEngulfSignal(), handleFVGSignal(), handlePlaybookBSignal() (+8 more)

### Community 6 - "Community 6"
Cohesion: 0.21
Nodes (15): applyConfig(), applyMode(), buildTradePips(), closeSettings(), computeMechanicalGoNogo(), getSessionWindow(), refreshPrice(), _renderMode() (+7 more)

### Community 7 - "Community 7"
Cohesion: 0.25
Nodes (13): ensureDir(), fs, listSessions(), logTrade(), path, readSession(), sessionPath(), startSession() (+5 more)

### Community 8 - "Community 8"
Cohesion: 0.17
Nodes (11): dependencies, @anthropic-ai/sdk, express, node-telegram-bot-api, ws, description, main, name (+3 more)

### Community 9 - "Community 9"
Cohesion: 0.29
Nodes (10): cleanup(), connect(), emit(), handleServerMsg(), off(), onDone(), onErr(), rawSend() (+2 more)

### Community 10 - "Community 10"
Cohesion: 0.27
Nodes (12): broadcast(), checkFVGSignal(), handleEngulfToggle(), handleFVGToggle(), handleSFPToggle(), startEngulfMonitor(), startFVGMonitor(), startMCP() (+4 more)

### Community 11 - "Community 11"
Cohesion: 0.25
Nodes (11): checkEngulfingSignal(), classifyTrendFromBars(), detectEngulfFromBars(), flattenIndicatorText(), get4HTrend(), getBarsFromMultiTF(), getCurrentPriceMechanical(), getTrendForTF() (+3 more)

### Community 12 - "Community 12"
Cohesion: 0.20
Nodes (11): handleChat(), handleConfigSet(), handleMCPCall(), handleModeSwitch(), handleScreenshot(), handleSessionStart(), handleSessionTrade(), loadConfig() (+3 more)

### Community 14 - "Community 14"
Cohesion: 0.31
Nodes (9): checkSFPSignal(), detectFVGFromBars(), detectSFPFromBars(), extractBarsArray(), getFullBars(), getNearestKeyLevelMechanical(), getPDHPDL(), getSwingLevels() (+1 more)

### Community 15 - "Community 15"
Cohesion: 0.25
Nodes (8): barTimeToDate(), checkSessionPrep(), drawLevelLine(), getAsiaHighLow(), istNowMinutesAndDate(), markLondonLevels(), startSessionPrepScheduler(), toISTFractionalHour()

### Community 16 - "Community 16"
Cohesion: 0.33
Nodes (6): computeCsvDisciplineReport(), findColumn(), parseCsvRows(), parsePnl(), parseTradovateTimestamp(), splitCsvLine()

### Community 19 - "Community 19"
Cohesion: 0.17
Nodes (12): checkEngulfNow(), checkFVGNow(), checkSFPNow(), handleSFPSweep(), renderSFPHistory(), requestNotificationPermission(), toggleEngulfMonitor(), toggleFVGMonitor() (+4 more)

## Knowledge Gaps
- **53 isolated node(s):** `Anthropic`, `mcpBridge`, `TV_TOOLS`, `{ app, BrowserWindow, ipcMain, nativeTheme }`, `path` (+48 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `TelegramBridge` connect `Community 4` to `Community 7`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Why does `MCPBridge` connect `Community 13` to `Community 2`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **What connects `Anthropic`, `mcpBridge`, `TV_TOOLS` to the rest of the system?**
  _54 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06456456456456457 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.12169312169312169 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09333333333333334 - nodes in this community are weakly interconnected._