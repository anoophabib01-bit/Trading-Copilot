'use strict';
const fs = require('fs');
const backtest = require('G:/MNQ-CoPilot/app/backtest');
const rules = JSON.parse(fs.readFileSync('G:/MNQ-CoPilot/app/rules.json','utf8'));
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const buf=rules.playbooks.stopBufferPoints||3, rr=rules.playbooks.targetR||2, horizon=rules.playbooks.outcomeHorizonBars||12, pv=backtest.MNQ_POINT_VALUE;
const minPts=rules.playbooks.minRiskPoints||0, maxUsd=rules.perTradeMaxLoss||Infinity;

function adxSeries(bars, period){
  const n=bars.length;
  const tr=new Array(n).fill(0), pDM=new Array(n).fill(0), mDM=new Array(n).fill(0);
  for(let i=1;i<n;i++){ const up=bars[i].high-bars[i-1].high, dn=bars[i-1].low-bars[i].low; pDM[i]=(up>dn&&up>0)?up:0; mDM[i]=(dn>up&&dn>0)?dn:0; tr[i]=Math.max(bars[i].high-bars[i].low, Math.abs(bars[i].high-bars[i-1].close), Math.abs(bars[i].low-bars[i-1].close)); }
  const plusDI=new Array(n).fill(NaN), minusDI=new Array(n).fill(NaN), dx=new Array(n).fill(NaN), adx=new Array(n).fill(NaN);
  let a=0,pd=0,md=0; for(let i=1;i<=period;i++){a+=tr[i];pd+=pDM[i];md+=mDM[i];}
  const di=(i)=>{ plusDI[i]=a>0?100*pd/a:0; minusDI[i]=a>0?100*md/a:0; const s=plusDI[i]+minusDI[i]; dx[i]=s>0?100*Math.abs(plusDI[i]-minusDI[i])/s:0; };
  di(period);
  let dsum=0;
  for(let i=period+1;i<=period*2;i++){ a=a-a/period+tr[i]; pd=pd-pd/period+pDM[i]; md=md-md/period+mDM[i]; di(i); dsum+=dx[i]; }
  adx[period*2]=dsum/period;
  for(let i=period*2+1;i<n;i++){ a=a-a/period+tr[i]; pd=pd-pd/period+pDM[i]; md=md-md/period+mDM[i]; di(i); adx[i]=(adx[i-1]*(period-1)+dx[i])/period; }
  return {adx, plusDI, minusDI};
}
function runRegimeSwitch(bars, lookback, adxMin){
  const {adx, plusDI, minusDI} = adxSeries(bars, 14);
  const trades=[]; const seen=new Set(); const warmup=Math.max(lookback+2, 14*2+2);
  let trendBars=0, totalBars=0;
  for(let i=warmup;i<bars.length;i++){
    totalBars++;
    const bar=bars[i];
    const inTrend = adx[i]>=adxMin; if(inTrend) trendBars++;
    if(!inTrend) continue;
    const up = plusDI[i] > minusDI[i];
    let lo=Infinity, hi=-Infinity;
    for(let k=i-lookback;k<i;k++){lo=Math.min(lo,bars[k].low);hi=Math.max(hi,bars[k].high);}
    let dir=null, stop=null;
    if(up && bar.close>hi && bar.close>bar.open){ dir='BULLISH'; stop=bar.low-buf; }
    else if(!up && bar.close<lo && bar.close<bar.open){ dir='BEARISH'; stop=bar.high+buf; }
    if(!dir) continue;
    const entry=bar.close; const risk=dir==='BULLISH'?entry-stop:stop-entry; if(risk<=0) continue;
    const target=dir==='BULLISH'?entry+risk*rr:entry-risk*rr;
    const id=dir+':'+i; if(seen.has(id)) continue; seen.add(id);
    const ru=risk*pv*1; if(minPts&&risk<minPts) continue; if(ru>maxUsd) continue;
    const plan={playbook:'RS',direction:dir,entry,stop,target,requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push({time:bar.time,dir,net:sim.points*pv*1-0.95*2*1});
  }
  return {trades, trendPct: totalBars?+(trendBars/totalBars*100).toFixed(0):0};
}
function stats(t){ if(!t.length) return 'n=0'; const net=t.reduce((a,b)=>a+b.net,0); const w=t.filter(x=>x.net>0); const l=t.filter(x=>x.net<=0); const gw=w.reduce((a,b)=>a+b.net,0),gl=-l.reduce((a,b)=>a+b.net,0); const pf=gl>0?(gw/gl).toFixed(2):'inf'; return 'n='+t.length+' win '+(w.length/t.length*100).toFixed(0)+'% $'+net.toFixed(0)+' PF'+pf; }
function split(t){ const L=t.filter(x=>x.dir==='BULLISH'), S=t.filter(x=>x.dir==='BEARISH'); return 'L:'+stats(L)+'   S:'+stats(S); }

const files = { 'uptrend(Apr-May)':'G:/MNQ-CoPilot/DATA/bars/mnq_1h_uptrend.json', 'downtrend(Feb-Mar)':'G:/MNQ-CoPilot/DATA/bars/mnq_1h_downtrend.json', 'in-sample(Jun-Aug)':'G:/MNQ-CoPilot/DATA/bars/mnq_60.json', 'flat(Nov-Jan)':'G:/MNQ-CoPilot/DATA/bars/mnq_1h_flat.json' };
console.log('REGIME-SWITCHING breakout (ADX>=threshold, direction +DI vs -DI, L10, 2R):');
for (const adxMin of [20, 25, 30]){
  console.log('=== ADX >= '+adxMin+' ===');
  for (const [name,f] of Object.entries(files)){
    const bars=load(f); const r=runRegimeSwitch(bars,10,adxMin);
    console.log('  '+name.padEnd(18)+' trend% '+String(r.trendPct).padStart(3)+'  TOTAL '+stats(r.trades)+'   | '+split(r.trades));
  }
}
