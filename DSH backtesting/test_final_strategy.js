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
function fullStats(t){
  if(!t.length) return null;
  const net=t.reduce((a,b)=>a+b.net,0); const w=t.filter(x=>x.net>0), l=t.filter(x=>x.net<=0);
  const gw=w.reduce((a,b)=>a+b.net,0), gl=-l.reduce((a,b)=>a+b.net,0);
  let eq=0,peak=0,dd=0; for(const x of t){eq+=x.net;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
  const byDay={}; for(const x of t){const d=new Date(x.time*1000).toISOString().slice(0,10); byDay[d]=(byDay[d]||0)+x.net;}
  const days=Object.values(byDay); const best=Math.max(...days);
  return {n:t.length, net, win:w.length/t.length*100, pf:gl>0?gw/gl:Infinity, dd, bestDay:best, consistency:net>0?best/net*100:null, days:days.length};
}
const files = { '5th(Sep-Nov up)':'G:/MNQ-CoPilot/DATA/bars/mnq_1h_sepnov.json', 'flat(Nov-Jan)':'G:/MNQ-CoPilot/DATA/bars/mnq_1h_flat.json', 'downtrend(Feb-Mar)':'G:/MNQ-CoPilot/DATA/bars/mnq_1h_downtrend.json', 'uptrend(Apr-May)':'G:/MNQ-CoPilot/DATA/bars/mnq_1h_uptrend.json', 'in-sample(Jun-Aug)':'G:/MNQ-CoPilot/DATA/bars/mnq_60.json' };
console.log('LONG-only breakout L10, ADX>=25 AND +DI>-DI, 2R target, stop beyond candle, 1 contract');
console.log('  regime                n     win%    net$     PF    DD$    bestDay$  consist');
let all=[];
for (const [name,f] of Object.entries(files)){
  const s=fullStats(runLongAdx(load(f),10,25));
  if(!s){ console.log('  '+name+'  (no trades)'); continue; }
  const c = s.consistency!=null ? s.consistency.toFixed(0)+'%' : 'n/a';
  console.log('  '+name.padEnd(20)+String(s.n).padEnd(6)+(s.win.toFixed(0)+'%').padEnd(7)+('$'+s.net.toFixed(0)).padEnd(8)+s.pf.toFixed(2).padEnd(6)+('$'+s.dd.toFixed(0)).padEnd(7)+('$'+s.bestDay.toFixed(0)).padEnd(9)+c);
  all=all.concat(runLongAdx(load(f),10,25));
}
all.sort((a,b)=>a.time-b.time);
const agg=fullStats(all);
console.log('');
console.log('AGGREGATE (5 regimes, ~9 months):');
console.log('  trades '+agg.n+' | net $'+agg.net.toFixed(0)+' | PF '+agg.pf.toFixed(2)+' | maxDD $'+agg.dd.toFixed(0)+' | bestDay $'+agg.bestDay.toFixed(0)+' | consistency '+(agg.consistency!=null?agg.consistency.toFixed(0)+'%':'n/a'));
console.log('  avg per trading-day: $'+(agg.net/(agg.days||1)).toFixed(0)+'  (over '+agg.days+' days with trades)');
