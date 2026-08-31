'use strict';
const fs = require('fs');
const backtest = require('G:/MNQ-CoPilot/app/backtest');
const rules = JSON.parse(fs.readFileSync('G:/MNQ-CoPilot/app/rules.json','utf8'));
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const pv=backtest.MNQ_POINT_VALUE, horizon=rules.playbooks.outcomeHorizonBars||12;
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
function runDollarAdx(bars, lookback, adxMin, stopUsd, tgtUsd){
  const {adx,plusDI,minusDI}=adxSeries(bars,14); const trades=[]; const seen=new Set(); const warmup=Math.max(lookback+2,30);
  const stopPts=stopUsd/pv, tgtPts=tgtUsd/pv;
  for(let i=warmup;i<bars.length;i++){
    const bar=bars[i];
    if(!(adx[i]>=adxMin && plusDI[i]>minusDI[i])) continue;
    let hi=-Infinity; for(let k=i-lookback;k<i;k++) hi=Math.max(hi,bars[k].high);
    if(!(bar.close>hi && bar.close>bar.open)) continue;
    const entry=bar.close, stop=entry-stopPts, target=entry+tgtPts;
    const id='L'+i; if(seen.has(id)) continue; seen.add(id);
    const plan={playbook:'FD',direction:'BULLISH',entry,stop,target,requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push({time:bar.time,net:sim.points*pv*1-0.95*2*1});
  }
  return trades;
}
const files = ['G:/MNQ-CoPilot/DATA/bars/mnq_1h_sepnov.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_flat.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_downtrend.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_uptrend.json','G:/MNQ-CoPilot/DATA/bars/mnq_60.json'];
const barsAll = files.map(load);
function agg(t){ if(!t.length) return null; const net=t.reduce((a,b)=>a+b.net,0); const w=t.filter(x=>x.net>0),l=t.filter(x=>x.net<=0); const gw=w.reduce((a,b)=>a+b.net,0),gl=-l.reduce((a,b)=>a+b.net,0); let eq=0,peak=0,dd=0; for(const x of t){eq+=x.net;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);} return {n:t.length,net,pf:gl>0?gw/gl:Infinity,dd,win:w.length/t.length*100}; }
console.log('ADX>=35 + LONG breakout, with FIXED DOLLAR SL/TP (vs candle-based 2R baseline):');
console.log('  risk model            trades  win%   net$    PF    DD$');
// baseline: candle 2R is ~66 trades PF 2.65 at 2c; here 1 contract
for (const [stopUsd, tgtUsd] of [[150,225],[200,300],[200,400],[250,500]]){
  let all=[];
  for(const b of barsAll) all=all.concat(runDollarAdx(b,10,35,stopUsd,tgtUsd));
  all.sort((a,b)=>a.time-b.time); const s=agg(all);
  if(!s){ console.log('  $'+stopUsd+'/$'+tgtUsd+'  no trades'); continue; }
  console.log('  $'+String(stopUsd).padEnd(4)+'/$'+String(tgtUsd).padEnd(4)+'       '+String(s.n).padEnd(7)+String(s.win.toFixed(0)+'%').padEnd(6)+'$'+s.net.toFixed(0).padEnd(7)+s.pf.toFixed(2).padEnd(6)+'$'+s.dd.toFixed(0));
}
