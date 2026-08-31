'use strict';
const fs = require('fs');
const backtest = require('G:/MNQ-CoPilot/app/backtest');
function load(f){const d=JSON.parse(fs.readFileSync(f,'utf8'));const b=Array.isArray(d)?d:(d.bars||[]);return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number');}
const bars = load('G:/MNQ-CoPilot/DATA/bars/gc_15m.json');
const span = (bars[bars.length-1].time-bars[0].time)/86400;
const PV = 10, COMM = 0.95, horizon = 48;  // 48 x 15m = 12 hours

function score(trades){
  let eq=0,peak=0,dd=0,wins=0,losses=0,gw=0,gl=0;
  for(const t of trades){ eq+=t.net; peak=Math.max(peak,eq); dd=Math.max(dd,peak-eq); if(t.net>0){wins++;gw+=t.net;}else{losses++;gl-=t.net;} }
  const n=trades.length; return { n, net:eq, win:n?wins/n*100:0, pf:gl>0?gw/gl:Infinity, dd };
}
function fmt(s){ return 'n='+s.n+' win '+s.win.toFixed(0)+'% net $'+s.net.toFixed(0)+' PF '+(s.pf===Infinity?'inf':s.pf.toFixed(2))+' maxDD $'+s.dd.toFixed(0); }

function runVwap(){
  const trades=[]; const seen=new Set();
  let cumPV=0, cumV=0, lastDay=-1;
  const vwap=new Array(bars.length).fill(0);
  for(let i=0;i<bars.length;i++){ const d=Math.floor(bars[i].time/86400); if(d!==lastDay){cumPV=0;cumV=0;lastDay=d;} const src=(bars[i].high+bars[i].low+bars[i].close)/3; cumPV+=src*bars[i].volume; cumV+=bars[i].volume; vwap[i]=cumV>0?cumPV/cumV:bars[i].close; }
  const dev=new Array(bars.length).fill(0); for(let i=0;i<bars.length;i++) dev[i]=bars[i].close-vwap[i];
  function sd(i,len=20){ if(i<len)return NaN; let m=0; for(let k=i-len+1;k<=i;k++)m+=dev[k]; m/=len; let s=0; for(let k=i-len+1;k<=i;k++)s+=(dev[k]-m)*(dev[k]-m); return Math.sqrt(s/len); }
  for(let i=20;i<bars.length;i++){
    const s=sd(i); if(!(s>0)) continue;
    const lower=vwap[i]-2*s, upper=vwap[i]+2*s, stopDn=vwap[i]-3*s, stopUp=vwap[i]+3*s;
    const b=bars[i], pc=bars[i-1].close;
    let dir=null, entry=b.close, stop=null, target=null;
    if(pc>=lower && b.close<lower){ dir='BULLISH'; stop=stopDn; target=vwap[i]; }
    else if(pc<=upper && b.close>upper){ dir='BEARISH'; stop=stopUp; target=vwap[i]; }
    if(!dir) continue;
    const id=dir+i; if(seen.has(id)) continue; seen.add(id);
    const risk=dir==='BULLISH'?entry-stop:stop-entry; if(risk<=0) continue;
    const plan={playbook:'VWAP',direction:dir,entry,stop,target,requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5});
    if(!sim) continue;
    trades.push({time:b.time,net:sim.points*PV*1-COMM*2});
  }
  return trades;
}
function runAsian(){
  const trades=[]; const seen=new Set();
  let aH=null, aL=null;
  for(let i=0;i<bars.length;i++){
    const b=bars[i]; const h=new Date(b.time*1000).getUTCHours();
    if(h===0){ aH=b.high; aL=b.low; continue; }
    if(h<8){ aH=Math.max(aH,b.high); aL=Math.min(aL,b.low); continue; }
    if(aH==null) continue;
    let dir=null, entry=b.close, stop=null, target=null;
    if(b.low<aL && b.close>aL){ dir='BULLISH'; stop=b.low-0.5; target=aH; }
    else if(b.high>aH && b.close<aH){ dir='BEARISH'; stop=b.high+0.5; target=aL; }
    if(!dir) continue;
    const id=dir+':'+new Date(b.time*1000).toISOString().slice(0,10); if(seen.has(id)) continue; seen.add(id);
    const risk=dir==='BULLISH'?entry-stop:stop-entry; if(risk<=0) continue;
    const plan={playbook:'ASIA',direction:dir,entry,stop,target,requiresFill:false};
    const sim=backtest.simulateTrade(plan,bars,i,{horizonBars:horizon,slippagePoints:0.5});
    if(!sim) continue;
    trades.push({time:b.time,net:sim.points*PV*1-COMM*2});
  }
  return trades;
}

console.log('REAL 15m GOLD (GC) — '+bars.length+' bars, '+span.toFixed(1)+' days | MGC $10/point, $0.95/side, 0.5pt slip');
console.log('');
console.log('  VWAP reversion (2s, 20-bar stdev):');
console.log('    '+fmt(score(runVwap())));
console.log('  Asian range liquidity sweep:');
console.log('    '+fmt(score(runAsian())));
console.log('');
console.log('  WARNING: only ~'+span.toFixed(0)+' days of 15m data (the chart loads max ~300 bars).');
console.log('  This is a REAL 15m read but a TINY sample — directionally useful, not conclusive.');
