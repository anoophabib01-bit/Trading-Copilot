'use strict';
const fs = require('fs');
const backtest = require('G:/MNQ-CoPilot/app/backtest');
const detectors = require('G:/MNQ-CoPilot/app/detectors');
const rules = JSON.parse(fs.readFileSync('G:/MNQ-CoPilot/app/rules.json','utf8'));
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const bars = load('G:/MNQ-CoPilot/DATA/bars/mnq_60.json');
const span = (bars[bars.length-1].time-bars[0].time)/86400;
const buf = rules.playbooks.stopBufferPoints || 3;
const rr = rules.playbooks.targetR || 2;
const horizon = rules.playbooks.outcomeHorizonBars || 12;
const pv = backtest.MNQ_POINT_VALUE;
const minPts = rules.playbooks.minRiskPoints || 0;
const maxUsd = rules.perTradeMaxLoss || Infinity;
const pad = (v,n)=>String(v).padEnd(n);

function atrSma(period=14){
  const tr = new Array(bars.length).fill(0);
  for (let i=0;i<bars.length;i++){ const b=bars[i]; tr[i]= i===0?(b.high-b.low):Math.max(b.high-b.low, Math.abs(b.high-bars[i-1].close), Math.abs(b.low-bars[i-1].close)); }
  const out = new Array(bars.length).fill(NaN);
  for (let i=period-1;i<bars.length;i++){ let s=0; for(let k=i-period+1;k<=i;k++) s+=tr[k]; out[i]=s/period; }
  return out;
}
const atr = atrSma(14);

function scoreTrades(trades){ return backtest.score(trades, rules, {contracts:1, spanDays:span}); }
function fmt(s){
  const win = s.winRate!=null ? (s.winRate*100).toFixed(0)+'%' : 'n/a';
  const net = s.netUsd!=null ? (s.netUsd<0?'-':'')+'$'+Math.abs(s.netUsd).toFixed(0) : 'n/a';
  const pf = s.profitFactor!=null ? s.profitFactor : 'n/a';
  const tpd = s.frequency ? s.frequency.tradeableSetupsPerDay : 'n/a';
  return pad(s.filled,6)+pad(win,6)+pad(net,8)+pad(pf,6)+pad(tpd,9);
}

// ── Experiment 1: SFP raid -> strong displacement, market entry at disp close ──
function runSfpDisp(dispN, windowW){
  const trades=[], blocked=[]; let pending=null; let raids=0; const seen=new Set();
  const warmup=40;
  for (let i=warmup;i<bars.length;i++){
    const visible=bars.slice(0,i+1), bar=bars[i];
    const swings=detectors.getSwingLevels(visible);
    const sfp=detectors.detectSFPFromBars(visible,{highs:swings.swingHighs,lows:swings.swingLows});
    if (sfp){ raids++; pending={dir:sfp.direction, wick:sfp.wick, level:sfp.level, at:i}; }
    if (!pending) continue;
    if (i - pending.at > windowW){ pending=null; continue; }
    if (i === pending.at) continue;
    const dir=pending.dir, wick=pending.wick;
    if (!(atr[i]>0)) continue;
    const body=Math.abs(bar.close-bar.open);
    const dirOk = (dir==='BULLISH' && bar.close>bar.open) || (dir==='BEARISH' && bar.close<bar.open);
    if (!(body >= dispN*atr[i] && dirOk)) continue;
    const entry=bar.close;
    const stop = dir==='BULLISH' ? wick-buf : wick+buf;
    const risk = dir==='BULLISH' ? entry-stop : stop-entry;
    if (risk<=0){ pending=null; continue; }
    const target = dir==='BULLISH' ? entry+risk*rr : entry-risk*rr;
    pending=null;
    const id=dir+':'+i; if(seen.has(id)) continue; seen.add(id);
    const riskUsd = risk*pv*1;
    if (minPts && risk<minPts){ blocked.push('risk-too-small'); continue; }
    if (riskUsd>maxUsd){ blocked.push('risk-too-big'); continue; }
    const plan={playbook:'B', direction:dir, entry, stop, target, requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push(Object.assign({setupId:id,time:bar.time},plan,sim));
  }
  return {raids, blocked:blocked.length, trades, score:scoreTrades(trades)};
}

// ── Experiment 2: mean-reversion rejection at N-bar support/resistance ──
function runMeanRev(lookback){
  const trades=[], blocked=[]; const seen=new Set(); const warmup=lookback+2;
  for (let i=warmup;i<bars.length;i++){
    const bar=bars[i];
    let lo=Infinity, hi=-Infinity;
    for (let k=i-lookback;k<i;k++){ lo=Math.min(lo,bars[k].low); hi=Math.max(hi,bars[k].high); }
    let dir=null, stop=null;
    if (bar.low < lo && bar.close > lo && bar.close > bar.open){ dir='BULLISH'; stop=bar.low-buf; }
    else if (bar.high > hi && bar.close < hi && bar.close < bar.open){ dir='BEARISH'; stop=bar.high+buf; }
    if (!dir) continue;
    const entry=bar.close;
    const risk = dir==='BULLISH' ? entry-stop : stop-entry;
    if (risk<=0) continue;
    const target = dir==='BULLISH' ? entry+risk*rr : entry-risk*rr;
    const id=dir+':'+i; if(seen.has(id)) continue; seen.add(id);
    const riskUsd=risk*pv*1;
    if (minPts && risk<minPts){ blocked.push('risk-too-small'); continue; }
    if (riskUsd>maxUsd){ blocked.push('risk-too-big'); continue; }
    const plan={playbook:'MR', direction:dir, entry, stop, target, requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push(Object.assign({setupId:id,time:bar.time},plan,sim));
  }
  return {blocked:blocked.length, trades, score:scoreTrades(trades)};
}

console.log('1H bars', bars.length, '| span', span.toFixed(1), 'days | stop-buf', buf+'pt, target', rr+'R, horizon', horizon, 'bars');
console.log('');
console.log('EXPERIMENT 1: SFP raid -> displacement (market entry), dispN = body/ATR14, window', '3 bars');
console.log('  dispN        raids   filled  win%    net$     PF   trades/day');
for (const n of [0.3,0.6,1.0,1.5,2.0]){
  const r = runSfpDisp(n, 3);
  console.log('  '+pad(n,8)+pad(r.raids,8)+fmt(r.score)+'   (blocked '+r.blocked+')');
}
console.log('');
console.log('EXPERIMENT 2: mean-reversion rejection at N-bar support/resistance');
console.log('  lookback   filled  win%    net$     PF   trades/day');
for (const L of [5,10,20]){
  const r = runMeanRev(L);
  console.log('  '+pad(L,8)+fmt(r.score)+'   (blocked '+r.blocked+')');
}
