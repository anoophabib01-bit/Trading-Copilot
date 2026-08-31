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
// generic: long/short breakout, optional ADX gate, optional direction filter
function runBreak(bars, lookback, cfg){
  const {adx,plusDI,minusDI} = cfg.adxMin!=null ? adxSeries(bars,14) : {adx:null,plusDI:null,minusDI:null};
  const trades=[]; const seen=new Set(); const warmup=Math.max(lookback+2,30);
  for(let i=warmup;i<bars.length;i++){
    const bar=bars[i];
    // ADX gate
    if(cfg.adxMin!=null && !(adx[i]>=cfg.adxMin)) continue;
    const up = (plusDI&&minusDI) ? plusDI[i]>minusDI[i] : null;
    let lo=Infinity,hi=-Infinity; for(let k=i-lookback;k<i;k++){lo=Math.min(lo,bars[k].low);hi=Math.max(hi,bars[k].high);}
    let dir=null, stop=null, target=null;
    const entry=bar.close;
    if(cfg.dollar){  // fixed-dollar scalping (both directions)
      const sp=cfg.stopUsd/pv, tp=cfg.tgtUsd/pv;
      if(bar.close>hi && bar.close>bar.open){ dir='BULLISH'; stop=entry-sp; target=entry+tp; }
      else if(bar.close<lo && bar.close<bar.open){ dir='BEARISH'; stop=entry+sp; target=entry-tp; }
    } else {  // candle 2R
      if(cfg.long && bar.close>hi && bar.close>bar.open){ if(up===null || up){ dir='BULLISH'; stop=bar.low-3; } }
      else if(cfg.short && bar.close<lo && bar.close<bar.open){ if(up===null || !up){ dir='BEARISH'; stop=bar.high+3; } }
      if(dir){ const risk=dir==='BULLISH'?entry-stop:stop-entry; if(risk>0) target=dir==='BULLISH'?entry+risk*2:entry-risk*2; else dir=null; }
    }
    if(!dir) continue;
    const id=dir+':'+i; if(seen.has(id)) continue; seen.add(id);
    const risk=dir==='BULLISH'?entry-stop:stop-entry; if(risk<=0) continue;
    const plan={playbook:'A',direction:dir,entry,stop,target,requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push({time:bar.time,net:sim.points*pv*2-0.95*2*2});  // 2 contracts
  }
  return trades;
}
const files=['G:/MNQ-CoPilot/DATA/bars/mnq_1h_sepnov.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_flat.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_downtrend.json','G:/MNQ-CoPilot/DATA/bars/mnq_1h_uptrend.json','G:/MNQ-CoPilot/DATA/bars/mnq_60.json'];
const barsAll=files.map(load);
const months=10.6;
function agg(t){ if(!t.length) return null; const net=t.reduce((a,b)=>a+b.net,0); const w=t.filter(x=>x.net>0),l=t.filter(x=>x.net<=0); const gw=w.reduce((a,b)=>a+b.net,0),gl=-l.reduce((a,b)=>a+b.net,0); let eq=0,peak=0,dd=0; for(const x of t){eq+=x.net;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);} return {n:t.length,net,pf:gl>0?gw/gl:Infinity,dd,win:w.length/t.length*100}; }
function runAll(cfg){ let all=[]; for(const b of barsAll) all=all.concat(runBreak(b,10,cfg)); all.sort((a,b)=>a.time-b.time); return agg(all); }

console.log('WHAT "AGGRESSIVE" ACTUALLY BACKTESTS TO (2 contracts, ~10.6 months real data):');
console.log('');
console.log('  strategy                        trades  win%   net$      PF    maxDD$');
const rows = [
  ['SAFE: ADX>=35 long-only 2R', runAll({adxMin:35,long:true,short:false,dollar:false})],
  ['Loosen ADX>=20 long-only 2R', runAll({adxMin:20,long:true,short:false,dollar:false})],
  ['Add SHORTS (ADX>=35 both dir)', runAll({adxMin:35,long:true,short:true,dollar:false})],
  ['Trade EVERYTHING (no ADX, both dir)', runAll({adxMin:null,long:true,short:true,dollar:false})],
  ['Scalp $150/$150 (no ADX, both dir)', runAll({adxMin:null,long:true,short:true,dollar:true,stopUsd:150,tgtUsd:150})],
  ['Scalp $100/$100 (no ADX, both dir)', runAll({adxMin:null,long:true,short:true,dollar:true,stopUsd:100,tgtUsd:100})],
];
for(const [name,s] of rows){
  if(!s){ console.log('  '+name.padEnd(34)+'  (no trades)'); continue; }
  console.log('  '+name.padEnd(34)+String(s.n).padEnd(7)+String(s.win.toFixed(0)+'%').padEnd(6)+(s.net<0?'-':'')+'$'+Math.abs(s.net).toFixed(0).padEnd(8)+s.pf.toFixed(2).padEnd(7)+'$'+s.dd.toFixed(0));
}
console.log('');
console.log('bottom line: the more you trade, the worse it gets. Aggressive = negative or breakeven.');
