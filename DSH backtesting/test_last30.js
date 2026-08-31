'use strict';
const fs = require('fs');
const backtest = require('G:/MNQ-CoPilot/app/backtest');
const rules = JSON.parse(fs.readFileSync('G:/MNQ-CoPilot/app/rules.json','utf8'));
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const buf=rules.playbooks.stopBufferPoints||3, rr=rules.playbooks.targetR||2, horizon=rules.playbooks.outcomeHorizonBars||12, pv=backtest.MNQ_POINT_VALUE;
const minPts=rules.playbooks.minRiskPoints||0, maxUsd=rules.perTradeMaxLoss||Infinity;
function adxSeries(bars, period){
  const n=bars.length; const tr=new Array(n).fill(0),pDM=new Array(n).fill(0),mDM=new Array(n).fill(0);
  for(let i=1;i<n;i++){const up=bars[i].high-bars[i-1].high,dn=bars[i-1].low-bars[i].low;pDM[i]=(up>dn&&up>0)?up:0;mDM[i]=(dn>up&&dn>0)?dn:0;tr[i]=Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close));}
  const plusDI=new Array(n).fill(NaN),minusDI=new Array(n).fill(NaN),dx=new Array(n).fill(NaN),adx=new Array(n).fill(NaN);
  let a=0,pd=0,md=0;for(let i=1;i<=period;i++){a+=tr[i];pd+=pDM[i];md+=mDM[i];}
  const di=(i)=>{plusDI[i]=a>0?100*pd/a:0;minusDI[i]=a>0?100*md/a:0;const s=plusDI[i]+minusDI[i];dx[i]=s>0?100*Math.abs(plusDI[i]-minusDI[i])/s:0;};
  di(period);let ds=0;for(let i=period+1;i<=period*2;i++){a=a-a/period+tr[i];pd=pd-pd/period+pDM[i];md=md-md/period+mDM[i];di(i);ds+=dx[i];}
  adx[period*2]=ds/period;for(let i=period*2+1;i<n;i++){a=a-a/period+tr[i];pd=pd-pd/period+pDM[i];md=md-md/period+mDM[i];di(i);adx[i]=(adx[i-1]*(period-1)+dx[i])/period;}
  return {adx,plusDI,minusDI};
}
function runLongAdx(bars, lookback, adxMin){
  const {adx,plusDI,minusDI}=adxSeries(bars,14); const trades=[]; const seen=new Set(); const warmup=Math.max(lookback+2,30);
  for(let i=warmup;i<bars.length;i++){
    const bar=bars[i];
    if(!(adx[i]>=adxMin && plusDI[i]>minusDI[i])) continue;
    let hi=-Infinity; for(let k=i-lookback;k<i;k++) hi=Math.max(hi,bars[k].high);
    if(!(bar.close>hi && bar.close>bar.open)) continue;
    const entry=bar.close, stop=bar.low-buf; const risk=entry-stop; if(risk<=0) continue;
    const target=entry+risk*rr; const id='L'+i; if(seen.has(id)) continue; seen.add(id);
    const ru=risk*pv*1; if(minPts&&risk<minPts) continue; if(ru>maxUsd) continue;
    const plan={playbook:'RS-L',direction:'BULLISH',entry,stop,target,requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push({time:bar.time,net:sim.points*pv*1-0.95*2*1});
  }
  return trades;
}
const bars = load('G:/MNQ-CoPilot/DATA/bars/mnq_60.json');
const lastTime = bars[bars.length-1].time;
const cutoff = lastTime - 30*86400;
const all = runLongAdx(bars, 10, 35);
const last30 = all.filter(t => t.time >= cutoff);
const sum = t => t.reduce((a,b)=>a+b.net,0);
console.log('Most recent data span:', new Date(bars[0].time*1000).toISOString().slice(0,10), '->', new Date(lastTime*1000).toISOString().slice(0,10));
console.log('ADX>=35 strategy, lookback 10:');
console.log('  full 65-day window: '+all.length+' trades, net $'+sum(all).toFixed(0));
console.log('  LAST 30 DAYS:       '+last30.length+' trades, net $'+sum(last30).toFixed(0));
for (const t of last30) console.log('    '+new Date(t.time*1000).toISOString().slice(0,10)+'  $'+t.net.toFixed(0));
