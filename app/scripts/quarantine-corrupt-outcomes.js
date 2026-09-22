'use strict';
const fs = require('fs');
const path = require('path');
const dir = 'G:/Trading-CoPilot/DATA/signals';
const NL = String.fromCharCode(10);
const files = fs.readdirSync(dir).filter(f => f.endsWith('.outcomes.jsonl'));
let quarantined = 0;
for (const f of files) {
  const p = path.join(dir, f);
  const rows = fs.readFileSync(p, 'utf8').split(NL).filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const good = [], bad = [];
  for (const r of rows) {
    if (Number.isFinite(r.level) && r.level > 0 && (r.mfe > 0.02 * r.level || r.mae > 0.02 * r.level)) bad.push(r); else good.push(r);
  }
  if (bad.length) {
    fs.writeFileSync(p, good.map(r => JSON.stringify(r)).join(NL) + (good.length ? NL : ''), 'utf8');
    fs.appendFileSync(p.replace('.outcomes.jsonl', '.outcomes.quarantine.jsonl'), bad.map(r => JSON.stringify(Object.assign({}, r, { quarantined: 'F0.1 sanity bound exceeded' }))).join(NL) + NL, 'utf8');
    quarantined += bad.length;
  }
}
console.log('quarantined=' + quarantined);
