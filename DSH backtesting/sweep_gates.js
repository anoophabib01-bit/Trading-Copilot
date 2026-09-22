'use strict';
const fs = require('fs');
const backtest = require('G:/Trading-CoPilot/app/backtest');
const detectors = require('G:/Trading-CoPilot/app/detectors');
const spec = require('G:/Trading-CoPilot/app/playbook-spec');
const playbookC = require('G:/Trading-CoPilot/app/playbook-c');
const TOL = 0.0005;

const rules = JSON.parse(fs.readFileSync('G:/Trading-CoPilot/app/rules.json', 'utf8'));
function loadBars(f){ const d = JSON.parse(fs.readFileSync(f,'utf8')); const b = Array.isArray(d)?d:(d.bars||[]); return b.filter(x=>x&&typeof x.time==='number'&&typeof x.close==='number'); }
const b60 = loadBars('G:/Trading-CoPilot/DATA/bars/mnq_60.json');
const b240 = loadBars('G:/Trading-CoPilot/DATA/bars/mnq_240.json');
const spanDays = (b60[b60.length-1].time - b60[0].time)/86400;
const pad = (v,n)=>String(v).padEnd(n);
const bump = (o,k)=>o[k]=(o[k]||0)+1;

function analyze(bars, direction){
  const n = bars.length, engulf = bars[n-1], bull = direction==='BULLISH';
  const { pivotHighs, pivotLows } = playbookC.findPivots(bars.slice(0, n-2));
  if (pivotHighs.length<2 || pivotLows.length<2) return { structure:'unknown' };
  const h1=pivotHighs[pivotHighs.length-2].price, h2=pivotHighs[pivotHighs.length-1].price;
  const l1=pivotLows[pivotLows.length-2].price, l2=pivotLows[pivotLows.length-1].price;
  const structure = (h2>h1&&l2>l1)?'HH-HL':(h2<h1&&l2<l1)?'LL-LH':'mixed';
  const wb = bars.slice(Math.max(0,n-5));
  let atSwing;
  if (bull) atSwing = engulf.low===Math.min(...wb.map(b=>b.low)) || pivotLows.some(p=>Math.abs(p.price-engulf.low)/p.price<TOL);
  else atSwing = engulf.high===Math.max(...wb.map(b=>b.high)) || pivotHighs.some(p=>Math.abs(p.price-engulf.high)/p.price<TOL);
  const ws = Math.max(0,n-10); const liq = bars.slice(ws); let swept=false;
  if (bull){ const lv = pivotHighs.filter(p=>p.i<ws).map(p=>p.price); swept = lv.find(v=>Math.max(...liq.map(b=>b.high))>v*(1+TOL)&&engulf.close<v)!==undefined; }
  else { const lv = pivotLows.filter(p=>p.i<ws).map(p=>p.price); swept = lv.find(v=>Math.min(...liq.map(b=>b.low))<v*(1+TOL)&&engulf.close>v)!==undefined; }
  return { structure, atSwing, swept };
}

function runConfig(cfg){
  const horizon = rules.playbooks.outcomeHorizonBars||12;
  const warmup = Math.max(playbookC.PBC_HISTORY_BARS,10);
  const trades=[], blocked=[], rejects={}; let candidates=0;
  const seen = new Set();
  for (let i=warmup;i<b60.length;i++){
    const visible=b60.slice(0,i+1), bar=b60[i];
    const engulf=detectors.detectEngulfFromBars(visible); if(!engulf) continue;
    candidates++;
    const dir=engulf.direction;
    if (cfg.need4H){
      const asOf=backtest.htfBarsAsOf(b240,bar.time,4*3600);
      if (asOf.length<5){ bump(rejects,'no-4H-read'); continue; }
      const trend=detectors.classifyTrendFromBars(asOf.slice(-5));
      const agrees=(trend==='bullish'&&dir==='BULLISH')||(trend==='bearish'&&dir==='BEARISH');
      if(!agrees){ bump(rejects,'against/unclear-4H('+trend+')'); continue; }
    }
    const a = analyze(visible.slice(-playbookC.PBC_HISTORY_BARS), dir);
    if (cfg.needStructure){
      const want = dir==='BULLISH'?'HH-HL':'LL-LH';
      if (a.structure==='unknown'){ bump(rejects,'structure-unknown(<2 pivots)'); continue; }
      if (a.structure!==want){ bump(rejects,'structure-'+a.structure); continue; }
    }
    if (cfg.needSwing && a.atSwing===false){ bump(rejects,'not-at-swing'); continue; }
    if (cfg.needNoSweep && a.swept){ bump(rejects,'liquidity-swept'); continue; }
    const setup={direction:dir, bar, barTime:bar.time, entryRef:bar.close};
    const id=spec.setupId('A',setup); if(seen.has(id)) continue; seen.add(id);
    const plan=spec.planEntry('A',setup,rules); if(!plan.plannable){ bump(rejects,'unplannable'); continue; }
    const minPts=rules.playbooks.minRiskPoints||0, maxUsd=rules.perTradeMaxLoss||Infinity;
    const riskUsd=plan.riskPoints*backtest.MNQ_POINT_VALUE*1;
    if (minPts && plan.riskPoints<minPts){ blocked.push('risk-too-small'); continue; }
    if (riskUsd>maxUsd){ blocked.push('risk-too-big'); continue; }
    const sim=backtest.simulateTrade(plan,b60,i,{horizonBars:horizon,slippagePoints:0.5,flattenByISTMinutes:rules.flattenByISTMinutes});
    if(!sim) continue;
    trades.push(Object.assign({setupId:id,time:bar.time},plan,sim));
  }
  return { candidates, setups:trades.length, blocked:blocked.length, score:backtest.score(trades,rules,{contracts:1,spanDays}), rejects, trades };
}

const configs = [
  { name:'strict (current)',   needStructure:true,  needSwing:true,  needNoSweep:true,  need4H:true  },
  { name:'-swing',             needStructure:true,  needSwing:false, needNoSweep:true,  need4H:true  },
  { name:'-sweep',             needStructure:true,  needSwing:true,  needNoSweep:false, need4H:true  },
  { name:'-swing-sweep',       needStructure:true,  needSwing:false, needNoSweep:false, need4H:true  },
  { name:'-structure (4H only)',needStructure:false, needSwing:false, needNoSweep:false, need4H:true  },
  { name:'engulf only',        needStructure:false, needSwing:false, needNoSweep:false, need4H:false },
];

console.log('1H bars', b60.length, '| 4H bars', b240.length, '| span', spanDays.toFixed(1), 'days');
console.log('contracts 1, stop-buffer '+rules.playbooks.stopBufferPoints+'pt, target '+rules.playbooks.targetR+'R, horizon '+rules.playbooks.outcomeHorizonBars+' bars, 03:00 IST flatten');
console.log('');
console.log('config                    cand  setups  blk  filled  win%    net$     PF   trades/day');
const results = {};
for (const cfg of configs){
  const r = runConfig(cfg); results[cfg.name]=r;
  const s = r.score;
  const win = s.winRate!=null ? (s.winRate*100).toFixed(0)+'%' : 'n/a';
  const net = s.netUsd!=null ? (s.netUsd<0?'-':'')+'$'+Math.abs(s.netUsd).toFixed(0) : 'n/a';
  const pf = s.profitFactor!=null ? s.profitFactor : 'n/a';
  const tpd = s.frequency ? s.frequency.tradeableSetupsPerDay : 'n/a';
  console.log(pad(cfg.name,25), pad(r.candidates,6), pad(r.setups,7), pad(r.blocked,5), pad(s.filled,7), pad(win,6), pad(net,8), pad(pf,6), pad(tpd,9));
}
console.log('');
console.log('--- strict rejection breakdown ('+Object.values(results['strict (current)'].rejects).reduce((a,b)=>a+b,0)+' total) ---');
const tot = Object.values(results['strict (current)'].rejects).reduce((a,b)=>a+b,0)||1;
for (const [k,v] of Object.entries(results['strict (current)'].rejects).sort((a,b)=>b[1]-a[1])){
  console.log('  '+pad(k,34)+v+' ('+(v/tot*100).toFixed(0)+'%)');
}
