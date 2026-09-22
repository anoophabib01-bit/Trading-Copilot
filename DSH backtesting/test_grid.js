'use strict';
const fs = require('fs');
const backtest = require('G:/Trading-CoPilot/app/backtest');
const rules = JSON.parse(fs.readFileSync('G:/Trading-CoPilot/app/rules.json','utf8'));
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
function applyCap(t,cap){const s=[...t].sort((a,b)=>a.time-b.time);const byDay={};const kept=[];for(const x of s){const d=new Date(x.time*1000).toISOString().slice(0,10);const p=byDay[d]||0;if(p>=cap)continue;kept.push(x);byDay[d]=p+x.net;}return kept;}
function agg(t){ if(!t.length) return null; const net=t.reduce((a,b)=>a+b.net,0); const w=t.filter(x=>x.net>0),l=t.filter(x=>x.net<=0); const gw=w.reduce((a,b)=>a+b.net,0),gl=-l.reduce((a,b)=>a+b.net,0); let eq=0,peak=0,dd=0; for(const x of t){eq+=x.net;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);} const byDay={}; for(const x of t){const d=new Date(x.time*1000).toISOString().slice(0,10); byDay[d]=(byDay[d]||0)+x.net;} const days=Object.values(byDay); const best=Math.max(...days); return {n:t.length,net,pf:gl>0?gw/gl:Infinity,dd,consist:net>0?best/net*100:null}; }
const files = ['G:/Trading-CoPilot/DATA/bars/mnq_1h_sepnov.json','G:/Trading-CoPilot/DATA/bars/mnq_1h_flat.json','G:/Trading-CoPilot/DATA/bars/mnq_1h_downtrend.json','G:/Trading-CoPilot/DATA/bars/mnq_1h_uptrend.json','G:/Trading-CoPilot/DATA/bars/mnq_60.json'];
const barsByFile = files.map(load);
const lookbacks=[5,10,15,20], adxMins=[25,30,35,40];

console.log('PARAMETER ROBUSTNESS GRID - LONG-only breakout, +DI>-DI, daily $1000 cap, 2R.');
console.log('cell = net$ (PF, maxDD$, consist%) across 5 regimes (~9 months).');
console.log('');
let header='  lookback\\ADX '; for(const a of adxMins) header += String(a).padStart(13); console.log(header);
for(const lb of lookbacks){
  let row = '  '+String(lb).padEnd(14);
  for(const am of adxMins){
    let all=[];
    for(const b of barsByFile){ let t=runLongAdx(b,lb,am); t=applyCap(t,1000); all=all.concat(t); }
    all.sort((a,b)=>a.time-b.time); const s=agg(all);
    if(!s){ row+=' n=0'.padStart(13); continue; }
    const cell = '$'+s.net.toFixed(0)+' ('+s.pf.toFixed(2)+', $'+s.dd.toFixed(0)+', '+(s.consist!=null?s.consist.toFixed(0):'-')+'%)';
    row += cell.padStart(13);
  }
  console.log(row);
}
