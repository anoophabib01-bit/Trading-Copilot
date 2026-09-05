'use strict';
/**
 * seed-chat-archive.js — one-shot: carry the surviving chat_transcript.json
 * turns into the new append-only archive (2026-09-03).
 *
 * DATA/chat_transcript.json is a rolling 40-turn window that gets overwritten
 * wholesale (see app/chat-archive.js's header for why that is not a record).
 * Those 40 turns are all that is left of every conversation before today, so
 * they are worth keeping — but they must be labelled honestly:
 *
 *   - They carry NO per-message timestamp. The file has one `savedAt` for the
 *     whole array, so every seeded row is stamped with it and flagged
 *     `meta.seeded`. The times are the time of the SAVE, not of each message,
 *     and nothing downstream should read them as real message times.
 *   - They are user/assistant only. Every system message, watcher alert and
 *     trade ticket from before today was never persisted anywhere and cannot
 *     be recovered.
 *
 * Idempotent: rows are given deterministic ids, and a re-run appends nothing
 * if those ids are already present. Safe to run against a live install — it
 * only ever appends to DATA/chat_archive/, which the running server does not
 * hold open.
 *
 *   node scripts/seed-chat-archive.js           # dry run, prints what it would do
 *   node scripts/seed-chat-archive.js --write   # actually append
 */

const fs = require('fs');
const path = require('path');
const { resolveDataDir } = require('../resolve-data-dir');
const chatArchive = require('../chat-archive');

const WRITE = process.argv.includes('--write');
const DATA_DIR = resolveDataDir().dir;
const SRC = path.join(DATA_DIR, 'chat_transcript.json');

function main() {
  console.log('DATA_DIR:', DATA_DIR);

  let src;
  try { src = JSON.parse(fs.readFileSync(SRC, 'utf8')); }
  catch (e) { console.log('No readable chat_transcript.json — nothing to seed.'); return; }

  const messages = Array.isArray(src && src.messages) ? src.messages : [];
  if (!messages.length) { console.log('chat_transcript.json holds no messages — nothing to seed.'); return; }

  const savedAt = Number(src.savedAt) || Date.now();
  const day = chatArchive.tradingDayStamp(savedAt);
  console.log(`Found ${messages.length} message(s), savedAt ${new Date(savedAt).toISOString()} -> trading day ${day}`);

  // Already seeded? Deterministic ids make this a plain membership check.
  const existing = new Set(chatArchive.readDayRaw(DATA_DIR, day).map(r => r.id));
  const rows = [];
  messages.forEach((m, i) => {
    const id = 'seed-' + savedAt + '-' + i;
    if (existing.has(id)) return;
    // A vision turn's content is an array of blocks, not a string.
    let text = m.content;
    if (Array.isArray(text)) {
      text = text.map(b => (b && b.type === 'text') ? b.text : '[' + ((b && b.type) || 'block') + ']').join('\n');
    }
    text = String(text == null ? '' : text).trim();
    if (!text) return;
    rows.push({
      id,
      seq: 0,
      role: m.role === 'user' ? 'user' : 'assistant',
      classes: 'seeded-from-chat_transcript',
      text,
      clientTs: savedAt,
      // The flag matters: these timestamps are the save time, not the moment
      // each message was actually said. Anything that later reasons about
      // timing must be able to tell these apart from captured rows.
      meta: { seeded: true, source: 'chat_transcript.json', savedAt: new Date(savedAt).toISOString() }
    });
  });

  if (!rows.length) { console.log('Nothing new to seed — already present in the archive.'); return; }

  if (!WRITE) {
    console.log(`DRY RUN — would append ${rows.length} row(s) to chat_archive/${day}.jsonl`);
    rows.slice(0, 3).forEach(r => console.log('  ', r.role, JSON.stringify(r.text).slice(0, 90)));
    console.log('Re-run with --write to apply.');
    return;
  }

  const res = chatArchive.appendRecords(DATA_DIR, rows, { nowMs: savedAt, slot: null, mode: null });
  console.log(res.ok
    ? `Appended ${res.written} row(s) to chat_archive/${res.days.join(', ')}.jsonl`
    : `FAILED: ${res.error}`);
  console.log('Archive now:', chatArchive.stats(DATA_DIR));
}

main();
