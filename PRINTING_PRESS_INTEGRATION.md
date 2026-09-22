# Printing Press CLI Integration for Trading-CoPilot

**Date:** 2026-09-06  
**Status:** Integration Framework  
**Scope:** NSE India Market Data → MNQ Trading Thesis Validation

---

## Overview

The **printing-press-library** provides real-time NSE India market data (equity quotes, indices, corporate actions, portfolio analysis) without API keys. This document maps all available CLI commands to Trading-CoPilot trading workflows.

**Key Insight:** While MNQ trades US Nasdaq futures, Indian institutional activity (delivery %, sector breadth, index attribution) serves as a **leading indicator** for global market rotations affecting MNQ. This integration adds a cross-market validation layer.

---

## Installation & Setup

### Prerequisites

```bash
# Install printing-press CLI
npx -y @mvanhorn/printing-press-library install nse-india --cli-only

# Verify installation
nse-india-pp-cli --version

# Expected output: nse-india-pp-cli version X.X.X
```

### PATH Configuration

Ensure the CLI is in your system PATH:

```bash
# Windows
set PATH=%PATH%;%LOCALAPPDATA%\Programs\PrintingPress\bin

# Verify access from any directory
nse-india-pp-cli --help
```

---

## CLI Command Reference

All commands use `--agent` flag for JSON output (machine-readable).

### SECTION 1: CORE MARKET DATA (7 Basic Commands)

#### 1.1 Market Status
```bash
nse-india-pp-cli market --agent
```

**Output:**
```json
{
  "meta": {"source": "live", "synced_at": "2026-09-05T16:00:00Z"},
  "results": {
    "capitalMarket": "CLOSED",
    "nifty50": 23897.7,
    "nifty50Change": 0.1,
    "marketCap": "₹48.78 lakh crore"
  }
}
```

**Trading-CoPilot Use:**
- Pre-session GO/NO-GO checklist
- Verify NSE market status → informs global risk-on/off sentiment
- Timing reference for IST-to-EST correlation

**Integration Point:** `app/market-data.js` → `getMarketStatus()`

---

#### 1.2 Stock Quote (Single Symbol)
```bash
nse-india-pp-cli equity quote --symbol RELIANCE --agent
```

**Output:**
```json
{
  "meta": {"source": "live"},
  "results": [{
    "symbol": "RELIANCE",
    "lastPrice": 1322,
    "dayHigh": 1333,
    "dayLow": 1304.1,
    "yearHigh": 1611.8,
    "yearLow": 1249.8,
    "change": 19.5,
    "changePercent": 1.5,
    "delivery": 66,
    "volume": 2500000,
    "margin": 12.5
  }]
}
```

**Trading-CoPilot Use:**
- Monitor key Indian mega-caps (RELIANCE, TCS, INFY, HDFC)
- Cross-reference delivery % with MNQ sector bias
- Volume confirmation for institutional accumulation signals

**Integration Point:** `app/market-data.js` → `getStockQuote(symbol)`

**Workflow:**
```javascript
// Check if RELIANCE (largest MNQ proxy in India) is accumulating
const rel = await getStockQuote('RELIANCE');
if (rel.delivery > 60 && rel.changePercent > 0) {
  jessi.verdict = "Institutional accumulation in India → MNQ bullish bias confirmed";
}
```

---

#### 1.3 Symbol Lookup
```bash
nse-india-pp-cli symbol-lookup RELIANCE --agent
nse-india-pp-cli symbol-lookup "Infosys" --agent
```

**Output:**
```json
{
  "results": {
    "symbol": "INFY",
    "name": "Infosys Limited",
    "isin": "INE009A01021",
    "industry": "IT Services",
    "boardStatus": "Main"
  }
}
```

**Trading-CoPilot Use:**
- Validate symbol names before bulk queries
- Match Indian IT stocks to US Nasdaq sectors
- Industry classification for sector allocation

**Integration Point:** `app/market-data.js` → `lookupSymbol(query)`

---

#### 1.4 List All Indices
```bash
nse-india-pp-cli indices list --agent
```

**Output:**
```json
{
  "results": [
    {"id": "NIFTY50", "name": "NIFTY 50", "type": "broad"},
    {"id": "NIFTYIT", "name": "NIFTY IT", "type": "sector"},
    {"id": "NIFTYBANK", "name": "NIFTY BANK", "type": "sector"},
    {"id": "NIFTYENERGY", "name": "NIFTY ENERGY", "type": "sector"}
    // ... 100+ more indices
  ]
}
```

**Trading-CoPilot Use:**
- Build a cached index list for quick lookups
- Filter by sector (IT, BANK, AUTO, etc.) for sector-specific analysis
- Reference for broader index-driver analysis

**Integration Point:** `app/market-data.js` → `listIndices()` (cached at startup)

---

#### 1.5 Index Constituents (Stocks in an Index)
```bash
nse-india-pp-cli indices constituents --index "NIFTY 50" --agent
```

**Output:**
```json
{
  "results": [
    {
      "symbol": "RELIANCE",
      "lastPrice": 1322,
      "yearHigh": 1611.8,
      "yearLow": 1249.8,
      "change1Y": 5.5,
      "change30D": 2.3
    },
    // ... 49 more stocks
  ]
}
```

**Trading-CoPilot Use:**
- Bulk fetch all NIFTY 50 stocks for breadth analysis
- Identify momentum leaders vs. laggards
- Filter for "stocks near 52W high" → early strength signals

**Integration Point:** `app/market-data.js` → `getIndexConstituents(indexName)`

**Workflow:**
```javascript
// Find NIFTY 50 stocks approaching 52W highs (breakout signal)
const constituents = await getIndexConstituents('NIFTY 50');
const nearHighs = constituents.filter(s => 
  ((s.yearHigh - s.lastPrice) / s.yearHigh * 100) < 5
);
console.log(`${nearHighs.length} stocks within 5% of 52W high`);
// Expected: 3-7 stocks = early breakout; 15+ = peak/reversal risk
```

---

#### 1.6 Corporate Actions (Dividends, Splits, Bonuses)
```bash
nse-india-pp-cli corporate actions --symbol RELIANCE --agent
```

**Output:**
```json
{
  "results": {
    "dividends": [
      {
        "exDate": "2026-09-10",
        "recordDate": "2026-09-15",
        "paymentDate": "2026-10-01",
        "dividend": 15.5,
        "yield": 1.2
      }
    ],
    "bonuses": [],
    "splits": []
  }
}
```

**Trading-CoPilot Use:**
- Flag dividend ex-dates → impacts stock price gaps
- Anticipate delivery % shifts around ex-dates
- Build event calendar for risk management

**Integration Point:** `app/market-data.js` → `getCorporateActions(symbol)`

---

#### 1.7 Corporate Announcements & Filings
```bash
nse-india-pp-cli corporate announcements --symbol TCS --agent
```

**Output:**
```json
{
  "results": [
    {
      "date": "2026-09-05",
      "type": "Financial Results",
      "title": "Q2 FY2027 Results",
      "link": "https://nsearchives.nseindia.com/..."
    },
    {
      "date": "2026-08-20",
      "type": "Board Meeting",
      "title": "Dividend Announcement"
    }
  ]
}
```

**Trading-CoPilot Use:**
- Monitor earnings calendar for key mega-caps
- Detect unexpected announcements (surprise corporate actions)
- Track insider trading disclosures for conviction signals

**Integration Point:** `app/market-data.js` → `getCorporateAnnouncements(symbol)`

---

### SECTION 2: TRADING TOOLS (F&O & Advanced)

#### 2.1 Futures & Options (F&O Contracts)
```bash
nse-india-pp-cli equity derivatives --symbol RELIANCE --agent
```

**Output:**
```json
{
  "results": {
    "futures": {
      "29-Sep-2026": {
        "lastPrice": 1334.2,
        "openInterest": 258071,
        "volume": 31009,
        "change": 18.6
      }
    },
    "callOptions": {
      "1340": {"lastPrice": 20.65, "openInterest": 95000},
      "1350": {"lastPrice": 16.40, "openInterest": 120000}
    },
    "putOptions": {
      "1310": {"lastPrice": 14.30, "openInterest": 88000}
    }
  }
}
```

**Trading-CoPilot Use:**
- Analyze India F&O open interest → positioning signals
- Compare put/call ratios for sentiment
- Track implied volatility for option-selling setups
- Cross-reference with MNQ option volume

**Integration Point:** `app/market-data.js` → `getDerivatives(symbol)`

---

#### 2.2 Most Active Stocks (Movers)
```bash
nse-india-pp-cli movers --agent
```

**Output:**
```json
{
  "results": [
    {"rank": 1, "symbol": "PCJEWELLER", "volume": 50000000, "changePercent": 8.5},
    {"rank": 2, "symbol": "IDEA", "volume": 45000000, "changePercent": -3.2},
    // ... top 20 most active
  ]
}
```

**Trading-CoPilot Use:**
- Gauge overall market breadth & activity
- Identify sector rotation (which stocks are getting bought/sold)
- Early warning for volatility expansion/contraction
- Correlate with MNQ intraday volume

**Integration Point:** `app/market-data.js` → `getMovers(limit=20)`

---

### SECTION 3: ADVANCED ANALYSIS (Institutional Signals)

#### 3.1 Delivery Spike (Institutional Accumulation) ⭐ HIGH PRIORITY
```bash
nse-india-pp-cli delivery-spike --threshold 1.5 --agent
```

**Output:**
```json
{
  "results": [
    {
      "symbol": "SBIN",
      "currentDelivery": 72,
      "averageDelivery": 58,
      "spike": 2.4,
      "priceChange": 1.8,
      "volume": 5000000
    },
    // ... other spiking stocks
  ]
}
```

**What it means:**
- Delivery % (institutional holding) is 24% above its 20-day rolling average
- Institutions are **accumulating** at current prices
- Precedes price moves by 2-3 trading sessions

**Trading-CoPilot Use:**
- Early warning signal for Indian sector rotation
- When BANK/IT stocks show delivery spike → expect MNQ to follow 2-3 days later
- Confirms directional bias for your MNQ setup

**Integration Point:** `app/market-data.js` → `getDeliverySpike(threshold=1.5)`

**Workflow:**
```javascript
async function checkInstitutionalBias() {
  const spikes = await getDeliverySpike(1.5);
  
  // Count by sector
  const itSpikes = spikes.filter(s => IT_SYMBOLS.includes(s.symbol)).length;
  const bankSpikes = spikes.filter(s => BANK_SYMBOLS.includes(s.symbol)).length;
  
  if (itSpikes > 5) {
    jessi.context = "IT sector accumulation in India → MNQ bullish confirmation";
  } else if (bankSpikes > 5) {
    jessi.context = "Banking sector accumulation in India → defensive positioning";
  }
}
```

---

#### 3.2 Delivery Divergence (Smart Money vs Retail) ⭐ PATTERN SIGNAL
```bash
nse-india-pp-cli delivery-divergence --lookback 10 --agent
```

**Output:**
```json
{
  "results": [
    {
      "symbol": "RELIANCE",
      "priceDirection": "UP",
      "deliveryDirection": "DOWN",
      "divergence": "Distribution",
      "confidence": 0.85,
      "daysActive": 5
    },
    {
      "symbol": "INFY",
      "priceDirection": "DOWN",
      "deliveryDirection": "UP",
      "divergence": "Accumulation",
      "confidence": 0.92,
      "daysActive": 3
    }
  ]
}
```

**What it means:**
- **Distribution:** Price up but delivery % down = institutions selling into strength → reversal warning
- **Accumulation:** Price down but delivery % up = institutions buying dips → reversal signal
- Strongest when confidence > 0.85 and duration > 2 days

**Trading-CoPilot Use:**
- Spot potential reversals in Indian mega-caps
- When RELIANCE shows distribution → MNQ often peaks 1-2 days later
- When INFY shows accumulation → MNQ often bottoms 1-2 days later

**Integration Point:** `app/market-data.js` → `getDeliveryDivergence(lookback=10)`

**Workflow:**
```javascript
async function checkDivergencePattern() {
  const divergence = await getDeliveryDivergence(10);
  
  const bullish = divergence.filter(d => 
    d.divergence === 'Accumulation' && d.confidence > 0.80
  );
  
  const bearish = divergence.filter(d => 
    d.divergence === 'Distribution' && d.confidence > 0.80
  );
  
  if (bullish.length > bearish.length) {
    jessi.verdict = "Indian institutions accumulating on dips → expect MNQ reversal up";
  } else if (bearish.length > bullish.length) {
    jessi.verdict = "Indian institutions selling into strength → expect MNQ reversal down";
  }
}
```

---

#### 3.3 Sector Breadth Analysis ⭐ BREADTH CONFIRMATION
```bash
nse-india-pp-cli sector-breadth --sector IT --agent
nse-india-pp-cli sector-breadth --sector BANKING --agent
nse-india-pp-cli sector-breadth --sector AUTO --agent
```

**Output:**
```json
{
  "results": {
    "sector": "IT",
    "gainers": 12,
    "decliners": 8,
    "advancedeclineRatio": 1.5,
    "medianChange": 0.8,
    "deliveryBreadth": "Strong",
    "constituents": [...]
  }
}
```

**What it means:**
- **Advance/Decline Ratio > 1.0:** More gainers than decliners = broad-based strength
- **Median % Change:** Central performance (filters outliers)
- **Delivery Breadth:** How many stocks in the sector showing high delivery %

**Trading-CoPilot Use:**
- Validate MNQ directional bias
- If IT sector A/D ratio = 2.0 → MNQ rally is broad, continue
- If IT sector A/D ratio = 0.3 → MNQ rally is narrow/weak, fade

**Integration Point:** `app/market-data.js` → `getSectorBreadth(sector)`

**Workflow:**
```javascript
async function validateMNQBias() {
  const it = await getSectorBreadth('IT');
  const bank = await getSectorBreadth('BANKING');
  
  const totalAdvance = it.gainers + bank.gainers;
  const totalDecline = it.decliners + bank.decliners;
  
  if ((totalAdvance / totalDecline) > 1.5) {
    jessi.confidence += 0.2;  // Broad-based move, trust the bias
  } else if ((totalAdvance / totalDecline) < 0.7) {
    jessi.confidence -= 0.2;  // Narrow move, reduce risk
  }
}
```

---

#### 3.4 Index Driver Analysis ⭐ ATTRIBUTION & CONCENTRATION
```bash
nse-india-pp-cli index-driver --index "NIFTY 50" --agent
```

**Output:**
```json
{
  "results": {
    "indexMove": 24.5,
    "topContributors": [
      {"symbol": "RELIANCE", "points": 12.3, "contribution": 50.2},
      {"symbol": "TCS", "points": 5.8, "contribution": 23.7},
      {"symbol": "INFY", "points": 3.2, "contribution": 13.1}
    ],
    "concentrationRatio": 0.87,
    "broadBasedStrength": "Narrow"
  }
}
```

**What it means:**
- **Concentration Ratio = 0.87:** 87% of the move is driven by top 3-5 stocks
- **Broad-Based Strength = Narrow:** Move is NOT supported by the full index

**Trading-CoPilot Use:**
- When NIFTY moves but concentration is low (< 0.5) → broad rally, trust MNQ continuation
- When NIFTY moves but concentration is high (> 0.8) → single-stock event, fade MNQ
- Helps distinguish true market moves from noise

**Integration Point:** `app/market-data.js` → `getIndexDriver(indexName)`

**Workflow:**
```javascript
async function assessMNQMoveQuality() {
  const driver = await getIndexDriver('NIFTY 50');
  
  if (driver.concentrationRatio > 0.85) {
    jessi.verdict = "NIFTY move is narrow (top 3 stocks) → MNQ move is likely noise, prepare to fade";
  } else if (driver.concentrationRatio < 0.5) {
    jessi.verdict = "NIFTY move is broad-based (20+ stocks) → MNQ move is structural, hold setup";
  }
}
```

---

#### 3.5 Portfolio P&L Tracking
```bash
nse-india-pp-cli portfolio pnl --holdings ~/holdings.csv --agent
```

**CSV Format:**
```csv
symbol,quantity,buyPrice,date
RELIANCE,10,1300,2026-09-01
TCS,5,2200,2026-09-02
INFY,8,2400,2026-09-03
```

**Output:**
```json
{
  "results": {
    "totalPnL": 5240,
    "totalPnLPercent": 2.8,
    "byPosition": [
      {"symbol": "RELIANCE", "pnl": 2200, "pnlPercent": 1.7},
      {"symbol": "TCS", "pnl": 1500, "pnlPercent": 2.3},
      {"symbol": "INFY", "pnl": 1540, "pnlPercent": 3.2}
    ]
  }
}
```

**Trading-CoPilot Use:**
- If you have a small India holdings (portfolio tracker)
- Cross-check: if your India positions are up 3% but MNQ is down → MNQ weakness is temporary
- Real-time validation of directional thesis

**Integration Point:** `app/market-data.js` → `getPortfolioPnL(holdingsFile)`

---

#### 3.6 Portfolio Margin Health
```bash
nse-india-pp-cli portfolio margin-health --holdings ~/holdings.csv --agent
```

**Output:**
```json
{
  "results": {
    "totalMarginRequired": 125000,
    "totalMarginAvailable": 500000,
    "marginUtilization": 25,
    "marginBuffer": "Safe",
    "riskPositions": [
      {"symbol": "RELIANCE", "marginPercent": 40}
    ]
  }
}
```

**Trading-CoPilot Use:**
- If you trade India stocks alongside MNQ
- Ensure India positions don't blow margin during gap moves
- Coordinate leverage across both portfolios

**Integration Point:** `app/market-data.js` → `getMarginHealth(holdingsFile)`

---

### SECTION 4: WORKFLOW MAPPING

#### Weekly Pattern-Memory Integration

**Monday EOD:**
```javascript
async function weeklyContextUpdate() {
  const indexDriver = await getIndexDriver('NIFTY 50');
  const divergence = await getDeliveryDivergence(5);
  const itBreadth = await getSectorBreadth('IT');
  
  return {
    weekPattern: {
      concentrationRisk: indexDriver.concentrationRatio,
      institutionalFlip: divergence.length > 3,
      techStrength: itBreadth.advancedeclineRatio,
      source: 'printing-press',
      timestamp: new Date()
    }
  };
}

// Add to pattern-memory.js
const weeklyContext = await weeklyContextUpdate();
pattern.metadata.push({
  key: 'india_market_context',
  value: weeklyContext,
  confidence: 0.7
});
```

---

#### Daily Pre-Session GO/NO-GO

```javascript
async function sessionGONOGO() {
  const checks = {
    marketStatus: (await getMarketStatus()).capitalMarket === 'OPEN',
    indexDriver: (await getIndexDriver('NIFTY 50')).concentrationRatio < 0.8,
    deliverySentiment: (await getDeliverySpike(1.5)).length < 15,
    divergence: (await getDeliveryDivergence(5)).length < 8
  };
  
  const passCount = Object.values(checks).filter(v => v).length;
  
  return {
    go: passCount >= 3,  // Need 3/4 checks to pass
    context: {
      marketOpening: checks.marketStatus,
      broadBasedMove: checks.indexDriver,
      institutionalCalmness: checks.deliverySentiment,
      noReversal: checks.divergence
    }
  };
}
```

---

#### Intraday Trade Setup Validation

```javascript
async function validateSetup(mnqBias, entryLevel) {
  const sectorBreadth = await getSectorBreadth(
    mnqBias === 'bullish' ? 'IT' : 'BANKING'
  );
  const divergence = await getDeliveryDivergence(3);
  const indexDriver = await getIndexDriver('NIFTY 50');
  
  const validations = {
    breadthSupport: sectorBreadth.advancedeclineRatio > 1.0,
    noReversal: !divergence.some(d => d.divergence === 'Distribution' && d.confidence > 0.85),
    broadMove: indexDriver.concentrationRatio < 0.75
  };
  
  return {
    setupValid: Object.values(validations).every(v => v),
    validations,
    recommendation: Object.values(validations).every(v => v) 
      ? `${mnqBias} setup validated by India market structure`
      : `${mnqBias} setup questionable — check divergence/breadth`,
    context: { sectorBreadth, divergence, indexDriver }
  };
}
```

---

#### Post-Trade Analysis (Why Did It Work/Fail?)

```javascript
async function analyzeTradeResult(tradeResult, timeOfTrade) {
  const historicalContext = await getDeliveryDivergence(10);
  const indexMovement = await getIndexDriver('NIFTY 50');
  
  return {
    explanation: tradeResult.profitable 
      ? `Trade won because India institutions were accumulating (delivery up ${historicalContext.filter(d => d.divergence === 'Accumulation').length} signals)`
      : `Trade lost because India institutions were distributing (delivery down ${historicalContext.filter(d => d.divergence === 'Distribution').length} signals)`,
    pattern: {
      divergenceAlignment: historicalContext.some(d => d.confidence > 0.85),
      indexConcentration: indexMovement.concentrationRatio,
      breadth: indexMovement.broadBasedStrength
    }
  };
}
```

---

### SECTION 5: IMPLEMENTATION CODE

#### File: `app/market-data.js`
```javascript
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class MarketDataClient {
  constructor() {
    this.cache = {};
    this.cacheExpiry = 60000; // 1 minute
  }

  async _runCLI(command) {
    try {
      const { stdout } = await execAsync(`nse-india-pp-cli ${command} --agent`);
      return JSON.parse(stdout).results;
    } catch (error) {
      console.error(`CLI Error: ${command}`, error.message);
      return null;
    }
  }

  async getMarketStatus() {
    return this._cachedCall('market', () => this._runCLI('market'));
  }

  async getStockQuote(symbol) {
    return this._cachedCall(`quote-${symbol}`, () => 
      this._runCLI(`equity quote --symbol ${symbol}`)[0]
    );
  }

  async lookupSymbol(query) {
    return this._runCLI(`symbol-lookup "${query}"`);
  }

  async listIndices() {
    return this._cachedCall('indices', () => this._runCLI('indices list'));
  }

  async getIndexConstituents(indexName) {
    return this._cachedCall(`constituents-${indexName}`, () => 
      this._runCLI(`indices constituents --index "${indexName}"`)
    );
  }

  async getCorporateActions(symbol) {
    return this._runCLI(`corporate actions --symbol ${symbol}`);
  }

  async getCorporateAnnouncements(symbol) {
    return this._runCLI(`corporate announcements --symbol ${symbol}`);
  }

  async getDerivatives(symbol) {
    return this._runCLI(`equity derivatives --symbol ${symbol}`);
  }

  async getMovers(limit = 20) {
    return this._cachedCall('movers', () => 
      this._runCLI('movers').slice(0, limit)
    );
  }

  async getDeliverySpike(threshold = 1.5) {
    return this._runCLI(`delivery-spike --threshold ${threshold}`);
  }

  async getDeliveryDivergence(lookback = 10) {
    return this._runCLI(`delivery-divergence --lookback ${lookback}`);
  }

  async getSectorBreadth(sector) {
    return this._runCLI(`sector-breadth --sector ${sector}`);
  }

  async getIndexDriver(indexName = 'NIFTY 50') {
    return this._runCLI(`index-driver --index "${indexName}"`);
  }

  async getPortfolioPnL(holdingsFile) {
    return this._runCLI(`portfolio pnl --holdings ${holdingsFile}`);
  }

  async getMarginHealth(holdingsFile) {
    return this._runCLI(`portfolio margin-health --holdings ${holdingsFile}`);
  }

  // Internal cache helper
  _cachedCall(key, fn) {
    const cached = this.cache[key];
    const now = Date.now();
    
    if (cached && (now - cached.timestamp) < this.cacheExpiry) {
      return Promise.resolve(cached.data);
    }
    
    return fn().then(data => {
      this.cache[key] = { data, timestamp: now };
      return data;
    });
  }
}

module.exports = new MarketDataClient();
```

---

#### File: `app/jessi-market-tools.js`
```javascript
// Add to Jessi agent's tool definitions
const marketTools = {
  check_india_breadth: {
    description: "Check if Indian IT/Banking sectors are advancing (breadth confirmation)",
    inputSchema: {
      properties: {
        sector: {
          type: "string",
          enum: ["IT", "BANKING", "AUTO", "PHARMA", "ENERGY"],
          description: "Sector to analyze"
        }
      }
    },
    handler: async (sector) => {
      const breadth = await require('./market-data').getSectorBreadth(sector);
      return {
        sector,
        ratio: breadth.advancedeclineRatio,
        assessment: breadth.advancedeclineRatio > 1.2 
          ? `Strong ${sector} breadth (${breadth.gainers} gainers vs ${breadth.decliners} decliners)`
          : `Weak ${sector} breadth — concentration risk`
      };
    }
  },

  check_institutional_accumulation: {
    description: "Detect if Indian institutions are accumulating or distributing",
    inputSchema: {
      properties: {
        threshold: { type: "number", default: 1.5 },
        lookback: { type: "number", default: 5 }
      }
    },
    handler: async (threshold, lookback) => {
      const [spike, divergence] = await Promise.all([
        require('./market-data').getDeliverySpike(threshold),
        require('./market-data').getDeliveryDivergence(lookback)
      ]);
      
      const accumulating = divergence.filter(d => d.divergence === 'Accumulation').length;
      const distributing = divergence.filter(d => d.divergence === 'Distribution').length;
      
      return {
        accumulationSignals: accumulating,
        distributionSignals: distributing,
        netSentiment: accumulating > distributing ? 'Bullish' : 'Bearish',
        spikeCount: spike.length,
        recommendation: accumulating > distributing 
          ? "Institutions accumulating — favor long MNQ setups"
          : "Institutions distributing — favor short MNQ setups"
      };
    }
  },

  check_index_quality: {
    description: "Validate if NIFTY move is broad-based or concentrated in mega-caps",
    inputSchema: {},
    handler: async () => {
      const driver = await require('./market-data').getIndexDriver('NIFTY 50');
      return {
        move: driver.indexMove,
        concentration: driver.concentrationRatio,
        quality: driver.concentrationRatio < 0.6 
          ? "Broad-based (20+ stocks driving move)"
          : "Narrow (top 3-5 stocks only)",
        recommendation: driver.concentrationRatio < 0.6
          ? "Trust the move — broad support for MNQ continuation"
          : "Be cautious — single-stock event, may fade"
      };
    }
  }
};

module.exports = marketTools;
```

---

#### Integration into `server.js`

```javascript
// At startup, add printing-press context to session
const marketData = require('./market-data');

async function startSession(ws, msg) {
  // ... existing code ...
  
  // New: Prime with India market context
  const primeContext = {
    marketStatus: await marketData.getMarketStatus(),
    breadth: await marketData.getSectorBreadth('IT'),
    divergence: await marketData.getDeliveryDivergence(5),
    movers: await marketData.getMovers(10)
  };
  
  // Pass to Jessi for session context
  const jessi = new JessiAgent({
    ...existingConfig,
    marketContext: primeContext
  });
  
  send(ws, {
    key: 'sessionStarted',
    context: {
      rules: getActiveRules(),
      marketContext: primeContext
    }
  });
}

// Add periodic market monitoring
setInterval(async () => {
  const driver = await marketData.getIndexDriver('NIFTY 50');
  const divergence = await marketData.getDeliveryDivergence(3);
  
  broadcast({
    key: 'marketUpdate',
    niftyConcentration: driver.concentrationRatio,
    divergenceSignals: divergence.length,
    timestamp: new Date()
  });
}, 300000); // Every 5 minutes
```

---

### SECTION 6: DATA SCHEMA MAPPINGS

#### Printing Press Output → Trading-CoPilot Schema

```javascript
// Transform printing-press JSON to Trading-CoPilot internal format
const transformers = {
  marketContext: (ppData) => ({
    timestamp: ppData.meta.synced_at,
    nifty50: ppData.results.nifty50,
    nifty50Change: ppData.results.nifty50Change,
    source: 'printing-press',
    region: 'NSE-India'
  }),

  breadthSignal: (ppData) => ({
    sector: ppData.results.sector,
    strength: ppData.results.advancedeclineRatio > 1.2 ? 'Strong' : ppData.results.advancedeclineRatio > 0.8 ? 'Neutral' : 'Weak',
    gainers: ppData.results.gainers,
    decliners: ppData.results.decliners,
    confidence: Math.min(1, ppData.results.advancedeclineRatio / 2)
  }),

  divergenceSignal: (ppData) => ({
    symbol: ppData.results.symbol,
    type: ppData.results.divergence, // 'Accumulation' or 'Distribution'
    confidence: ppData.results.confidence,
    mnqImplication: ppData.results.divergence === 'Accumulation' ? 'Bullish' : 'Bearish',
    daysActive: ppData.results.daysActive
  }),

  indexQuality: (ppData) => ({
    concentrationRatio: ppData.results.concentrationRatio,
    broadBased: ppData.results.concentrationRatio < 0.6,
    topContributors: ppData.results.topContributors.slice(0, 3),
    moveQuality: ppData.results.concentrationRatio < 0.6 ? 'High' : 'Low'
  })
};
```

---

### SECTION 7: DAILY CHECKLIST

Use this checklist each morning before session start:

```markdown
## Morning Market Diagnostics Checklist

- [ ] **Market Status**: `nse-india-pp-cli market --agent` → NSE open/closed
- [ ] **Index Quality**: `nse-india-pp-cli index-driver --index "NIFTY 50" --agent` → Concentration < 0.7?
- [ ] **Breadth Confirmation**: `nse-india-pp-cli sector-breadth --sector IT --agent` → A/D ratio > 1.0?
- [ ] **Institutional Mood**: `nse-india-pp-cli delivery-divergence --lookback 5 --agent` → More accumulation than distribution?
- [ ] **Delivery Spikes**: `nse-india-pp-cli delivery-spike --threshold 1.5 --agent` → Count < 10?
- [ ] **NIFTY Constituents**: `nse-india-pp-cli indices constituents --index "NIFTY 50" --agent --select symbol,lastPrice,yearHigh` → How many near 52W highs?

### Decision Matrix

| Check | Result | MNQ Bias |
|-------|--------|----------|
| Index Concentration | < 0.6 | Trust the move |
| IT Breadth A/D | > 1.2 | Bullish |
| Divergence Balance | Accumulation > Distribution | Bullish |
| Delivery Spikes | < 8 signals | Normal |
| Near 52W High | 3-7 stocks | Early strength |

**Session GO:** 4/5 checks pass  
**Session NO-GO:** < 3 checks pass
```

---

### SECTION 8: TROUBLESHOOTING

| Error | Solution |
|-------|----------|
| "command not found" | Add `%LOCALAPPDATA%\Programs\PrintingPress\bin` to PATH |
| Empty JSON output | API rate-limited; retry after 30 seconds |
| Stale data (> 5 min) | Use `nse-india-pp-cli sync --agent` to refresh local cache |
| Negative values in delivery% | Bug in old data; data normalizes on next sync |
| Missing constituents | Index name is case-sensitive: use "NIFTY 50" not "nifty 50" |

---

### SECTION 9: PERFORMANCE & CACHING

```javascript
// Recommended refresh intervals
const refreshIntervals = {
  marketStatus: 60000,      // 1 min
  indexDriver: 300000,      // 5 min (re-runs every 5 min)
  sectorBreadth: 300000,    // 5 min
  deliveryDivergence: 600000, // 10 min
  deliverySpike: 600000,    // 10 min
  indexConstituents: 3600000, // 1 hour (rarely changes intraday)
  corporateActions: 3600000 // 1 hour
};

// Batch queries for efficiency
async function batchMarketContext() {
  const [indexDriver, itBreadth, bankBreadth, divergence, spikes] = await Promise.all([
    marketData.getIndexDriver('NIFTY 50'),
    marketData.getSectorBreadth('IT'),
    marketData.getSectorBreadth('BANKING'),
    marketData.getDeliveryDivergence(5),
    marketData.getDeliverySpike(1.5)
  ]);
  
  return { indexDriver, itBreadth, bankBreadth, divergence, spikes };
  // Saves 4 seconds vs sequential calls
}
```

---

### SECTION 10: NEXT STEPS

1. **Install printing-press CLI** (if not done)
   ```bash
   npx -y @mvanhorn/printing-press-library install nse-india --cli-only
   ```

2. **Copy `app/market-data.js`** into Trading-CoPilot project

3. **Update `app/server.js`**
   - Import `marketData` module
   - Add startup context (see Section 5)
   - Add periodic broadcast (see Section 5)

4. **Update Jessi agent** (claude-agent.js)
   - Add `marketTools` from Section 5
   - Include market context in system prompt

5. **Test with Telegram**
   - Ask Jessi: "Check India market breadth" → should return IT/BANKING A/D ratios
   - Ask Jessi: "Are institutions accumulating?" → should return delivery divergence
   - Ask Jessi: "Is the NIFTY move broad-based?" → should return concentration ratio

6. **Deploy to Pattern-Memory Loop**
   - Add India market context to episode metadata
   - Track which patterns correlate with divergence signals
   - Build "institutional alignment" feature

---

## Summary Table: All Commands

| Command | Frequency | MNQ Use Case | Integration |
|---------|-----------|-------------|-------------|
| `market` | Daily | GO/NO-GO | Session start |
| `equity quote` | Intraday | Mega-cap tracking | Chat/monitoring |
| `symbol-lookup` | On-demand | Symbol validation | Ad-hoc queries |
| `indices list` | Once/week | Index reference | Jessi tool |
| `indices constituents` | 1x/hour | Breadth analysis | Monitoring loop |
| `corporate actions` | Daily | Earnings/dividend calendar | Jessi context |
| `corporate announcements` | Daily | Filings & events | Alert system |
| `equity derivatives` | Intraday | F&O positioning | Optional: option analysis |
| `movers` | Hourly | Activity gauge | Market update broadcast |
| `delivery-spike` | Daily | Institutional accumulation | Pattern-memory |
| `delivery-divergence` | 2-3x/day | Reversal detection | Jessi verdict |
| `sector-breadth` | Hourly | Breadth confirmation | Monitoring loop |
| `index-driver` | Hourly | Move quality | Jessi validation |
| `portfolio pnl` | Optional | Holdings tracking | If applicable |
| `portfolio margin-health` | Optional | Leverage check | If applicable |

---

**Document Version:** 1.0  
**Last Updated:** 2026-09-06  
**Author:** Claude + Anoop Habib  
**Status:** Ready for Integration
