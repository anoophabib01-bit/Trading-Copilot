'use strict';
const fs = require('fs');
const backtest = require('G:/MNQ-CoPilot/app/backtest');
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

function runBreakout(lookback){
  const trades=[], blocked=[]; const seen=new Set(); const warmup=lookback+2;
  for (let i=warmup;i<bars.length;i++){
    const bar=bars[i];
    let lo=Infinity, hi=-Infinity;
    for (let k=i-lookback;k<i;k++){ lo=Math.min(lo,bars[k].low); hi=Math.max(hi,bars[k].high); }
    let dir=null, stop=null;
    if (bar.close > hi && bar.close > bar.open){ dir='BULLISH'; stop=bar.low-buf; }
    else if (bar.close < lo && bar.close < bar.open){ dir='BEARISH'; stop=bar.high+buf; }
    if (!dir) continue;
    const entry=bar.close;
    const risk = dir==='BULLISH' ? entry-stop : stop-entry;
    if (risk<=0) continue;
    const target = dir==='BULLISH' ? entry+risk*rr : entry-risk*rr;
    const id=dir+':'+i; if(seen.has(id)) continue; seen.add(id);
    const riskUsd=risk*pv*1;
    if (minPts && risk<minPts){ blocked.push('small'); continue; }
    if (riskUsd>maxUsd){ blocked.push('big'); continue; }
    const plan={playbook:'BRK', direction:dir, entry, stop, target, requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    // net USD per trade (1 contract, commission both sides)
    const net = sim.points * pv * 1 - 0.95*2*1;
    trades.push(Object.assign({setupId:id,time:bar.time,entryTime:bar.time,exitTime:bars[Math.min(bars.length-1,(sim.entryIdx!=null?sim.entryIdx:0)+sim.bars)].time, side:dir==='BULLISH'?'long':'short', entryPrice:entry, exitPrice:entry+(dir==='BULLISH'?sim.points:-sim.points), net, dir}, sim));
  }
  return {blocked:blocked.length, trades};
}

for (const L of [5,10]){
  const r = runBreakout(L);
  const t = r.trades;
  const netAll = t.reduce((a,b)=>a+b.net,0);
  const wins = t.filter(x=>x.net>0), losses = t.filter(x=>x.net<=0);
  const gw = wins.reduce((a,b)=>a+b.net,0), gl = -losses.reduce((a,b)=>a+b.net,0);
  // equity path for max DD
  let eq=0, peak=0, maxDD=0;
  for (const x of t){ eq+=x.net; peak=Math.max(peak,eq); maxDD=Math.max(maxDD,peak-eq); }
  // per-day (UTC date) consistency
  const byDay = {};
  for (const x of t){ const d = new Date(x.time*1000).toISOString().slice(0,10); byDay[d]=(byDay[d]||0)+x.net; }
  const days = Object.values(byDay);
  const maxDay = Math.max(...days), minDay = Math.min(...days);
  const posDays = days.filter(d=>d>0).length;
  const consistency = netAll>0 ? (maxDay/netAll) : null;
  // long vs short
  const longs = t.filter(x=>x.dir==='BULLISH'), shorts = t.filter(x=>x.dir==='BEARISH');
  const lnet = longs.reduce((a,b)=>a+b.net,0), snet = shorts.reduce((a,b)=>a+b.net,0);
  const lw = longs.filter(x=>x.net>0).length, sw = shorts.filter(x=>x.net>0).length;
  // max trades in one day
  const byDayCnt = {};
  for (const x of t){ const d=new Date(x.time*1000).toISOString().slice(0,10); byDayCnt[d]=(byDayCnt[d]||0)+1; }
  const maxTradesDay = Math.max(...Object.values(byDayCnt));
  // break-even band
  const bandCount = t.filter(x=>Math.abs(x.net)<=100).length;

  console.log('=== BREAKOUT lookback '+L+' (65 days, 1 contract, $0.95/side, 0.5pt slip, 03:00 IST flatten) ===');
  console.log('  trades', t.length, '| win', (t.filter(x=>x.net>0).length/t.length*100).toFixed(0)+'%', '| net $'+netAll.toFixed(0), '| PF '+(gl>0?(gw/gl).toFixed(2):'inf'));
  console.log('  avg win $'+ (wins.length?(gw/wins.length).toFixed(0):'n/a')+' / avg loss $'+(losses.length?(gl/losses.length).toFixed(0):'n/a'));
  console.log('  max drawdown $'+maxDD.toFixed(0), '| trades/day '+(t.length/span).toFixed(2), '| max trades in one day '+maxTradesDay);
  console.log('  target/stop/timeout/flattened:', t.filter(x=>x.outcome==='target').length, t.filter(x=>x.outcome==='stop').length, t.filter(x=>x.outcome==='timeout').length, t.filter(x=>x.outcome==='flattened').length);
  console.log('  LONG:  '+longs.length+' trades, $'+lnet.toFixed(0)+', '+((longs.length?lw/longs.length*100:0).toFixed(0))+'% win');
  console.log('  SHORT: '+shorts.length+' trades, $'+snet.toFixed(0)+', '+((shorts.length?sw/shorts.length*100:0).toFixed(0))+'% win');
  console.log('  per-day: '+days.length+' days, best +$'+maxDay.toFixed(0)+', worst $'+minDay.toFixed(0)+', '+posDays+' profitable days');
  console.log('  consistency (bestDay/total): '+ (consistency!=null?(consistency*100).toFixed(0)+'%':'n/a')+'   [40% rule: must be <=40%]');
  console.log('  break-even band (+-$100) trades: '+bandCount+' of '+t.length);
  console.log('');
}
