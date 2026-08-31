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
    trades.push({time:bar.time, points:sim.points, outcome:sim.outcome});
  }
  return trades;
}
const files = ['G:/MNQ-CoPilot/DATA/bars/mnq_1h_sepnov.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_flat.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_downtrend.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_uptrend.json','G:/MNQ-CoPilot/DATA/bars/mnq_60.json'];
let all=[];
for(const f of files){ all=all.concat(runLongAdx(load(f),10,35)); }
all.sort((a,b)=>a.time-b.time);

// 2-contract net per trade
const net2 = t => t.points * pv * 2 - 0.95*2*2;   // 2 contracts, commission both sides both contracts
for(const t of all) t.net = net2(t);

const nets = all.map(t=>t.net);
const bestTrade = Math.max(...nets), worstTrade = Math.min(...nets);
// per-day (UTC)
const byDay={}; for(const t of all){const d=new Date(t.time*1000).toISOString().slice(0,10); byDay[d]=(byDay[d]||0)+t.net;}
const dayVals = Object.values(byDay);
const bestDay = Math.max(...dayVals), worstDay = Math.min(...dayVals);
// trades per day
const cntDay={}; for(const t of all){const d=new Date(t.time*1000).toISOString().slice(0,10); cntDay[d]=(cntDay[d]||0)+1;}
const maxTradesDay = Math.max(...Object.values(cntDay));
// total + drawdown
let eq=0,peak=0,dd=0; for(const t of all){eq+=t.net;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}
const total=all.reduce((a,b)=>a+b.net,0);
const wins=all.filter(t=>t.net>0), losses=all.filter(t=>t.net<=0);
const gw=wins.reduce((a,b)=>a+b.net,0), gl=-losses.reduce((a,b)=>a+b.net,0);
// best 6-week (42-day) rolling window
let best6w=0, best6wStart=null;
for(let i=0;i<all.length;i++){ let w=0; for(let j=i;j<all.length && all[j].time-all[i].time<=42*86400; j++) w+=all[j].net; if(w>best6w){best6w=w;best6wStart=new Date(all[i].time*1000).toISOString().slice(0,10);} }
// monthly rate
const spanMonths = (all[all.length-1].time - all[0].time)/86400/30.4;

console.log('=== 2-CONTRACT PROJECTION (ADX>=35, lookback 10, 2R target) ===');
console.log('total trades: '+all.length+'  over '+spanMonths.toFixed(1)+' months');
console.log('total net (2 contracts): $'+total.toFixed(0));
console.log('profit factor: '+(gl>0?(gw/gl).toFixed(2):'inf')+'  |  max drawdown: $'+dd.toFixed(0));
console.log('win rate: '+(wins.length/all.length*100).toFixed(0)+'%');
console.log('');
console.log('--- biggest / biggest-loss ---');
console.log('biggest single TRADE profit: $'+bestTrade.toFixed(0));
console.log('biggest single TRADE loss:   $'+worstTrade.toFixed(0));
console.log('biggest single DAY profit:   $'+bestDay.toFixed(0));
console.log('biggest single DAY loss:     $'+worstDay.toFixed(0));
console.log('max trades in any one day:   '+maxTradesDay+'   (limit = 10/day)');
console.log('');
console.log('--- monthly / 6-week rate ---');
console.log('avg per month (2c): $'+(total/spanMonths).toFixed(0));
console.log('avg per 6 weeks (2c): $'+(total/spanMonths*1.5).toFixed(0));
console.log('BEST 6-week window in the data: $'+best6w.toFixed(0)+'  (starting '+best6wStart+')');
console.log('');
console.log('--- the 30-day math (the honest part) ---');
console.log('to clear $3000 in 30 days with 40% rule: need >= 4-5 days, each <= $1200');
console.log('this strategy trades ~'+(all.length/spanMonths/4.33).toFixed(1)+' trades/week (nowhere near 10/day)');
console.log('best single day ($'+bestDay.toFixed(0)+') already exceeds the $1200/day cap');
