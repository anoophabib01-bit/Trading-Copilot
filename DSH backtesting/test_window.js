'use strict';
const fs = require('fs');
const backtest = require('G:/Trading-CoPilot/app/backtest');
const rules = JSON.parse(fs.readFileSync('G:/Trading-CoPilot/app/rules.json','utf8'));
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const buf=rules.playbooks.stopBufferPoints||3, rr=rules.playbooks.targetR||2, horizon=rules.playbooks.outcomeHorizonBars||12, pv=backtest.MNQ_POINT_VALUE;
const minPts=rules.playbooks.minRiskPoints||0, maxUsd=rules.perTradeMaxLoss||Infinity;

function runLong(bars, lookback, hFrom, hTo){ // hours [hFrom, hTo) UTC
  const trades=[]; const seen=new Set(); const warmup=lookback+2;
  for(let i=warmup;i<bars.length;i++){
    const bar=bars[i];
    const h=new Date(bar.time*1000).getUTCHours();
    if(!(h>=hFrom && h<hTo)) continue;
    let lo=Infinity,hi=-Infinity;
    for(let k=i-lookback;k<i;k++){lo=Math.min(lo,bars[k].low);hi=Math.max(hi,bars[k].high);}
    if(!(bar.close>hi && bar.close>bar.open)) continue;
    const entry=bar.close, stop=bar.low-buf; const risk=entry-stop; if(risk<=0) continue;
    const target=entry+risk*rr;
    const id='L'+i; if(seen.has(id)) continue; seen.add(id);
    const ru=risk*pv*1; if(minPts&&risk<minPts) continue; if(ru>maxUsd) continue;
    const plan={playbook:'BRK',direction:'BULLISH',entry,stop,target,requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push({time:bar.time,net:sim.points*pv*1-0.95*2*1});
  }
  return trades;
}
function s(t){ if(!t.length) return 'n=0'; const net=t.reduce((a,b)=>a+b.net,0); const w=t.filter(x=>x.net>0); const l=t.filter(x=>x.net<=0); const gw=w.reduce((a,b)=>a+b.net,0),gl=-l.reduce((a,b)=>a+b.net,0); const pf=gl>0?(gw/gl).toFixed(2):'inf'; return 'n='+t.length+' $'+net.toFixed(0)+' PF'+pf; }

const files = { 'in-sample(Jun-Aug)':'G:/Trading-CoPilot/DATA/bars/mnq_60.json', 'uptrend(Apr-May)':'G:/Trading-CoPilot/DATA/bars/mnq_1h_uptrend.json', 'downtrend(Feb-Mar)':'G:/Trading-CoPilot/DATA/bars/mnq_1h_downtrend.json' };
const windows = [[13,16],[13,15],[13,17],[14,16],[12,17]];
console.log('LONG L10 breakout, stop beyond candle, 2R target. Session-window sensitivity:');
console.log('window(UTC)      ' + Object.keys(files).map(f=>f.padEnd(18)).join(''));
for (const [a,b] of windows){
  let row = (a+'-'+b).padEnd(16);
  for (const f of Object.values(files)){ const bars=load(f); row += s(runLong(bars,10,a,b)).padEnd(18); }
  console.log(row);
}
