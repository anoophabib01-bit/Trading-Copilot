'use strict';
/* ── lifetime-store.js — the disk half of the lifetime view ──────────────────
 *
 * lifetime-history.js is pure and knows nothing about files. This module finds
 * the sources on disk and hands them over. Split for the same reason
 * week-rollup/week-store are split: the merge rules are the part worth testing
 * exhaustively, and they should not need a temp directory to exercise.
 *
 * SOURCES, in the order they are collected:
 *   DATA/accounts/<slot>/{gr_history,day_trades,balance_ledger,ck_history}.json
 *       every slot found on disk, not a hardcoded s1..s5 — a sixth slot must
 *       appear in history the day it is created, without a code change. That is
 *       the whole point of the ask ("even if I start new eval account in future
 *       it should be same").
 *   DATA/account_archives.json
 *       every archived account, each carrying its own frozen `ls` snapshot.
 *
 * READ-ONLY. This module never writes. The lifetime view is a projection over
 * records that already exist; it owns none of them and must never be able to
 * damage a slot. Any future "repair from lifetime view" feature belongs in a
 * separate module with its own confirmation flow.
 */
const fs = require('fs');
const path = require('path');
const LH = require('./lifetime-history');

function readJson(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; }
}

function safeSlot(slot) { return /^[a-zA-Z0-9_\-]+$/.test(String(slot || '')) ? String(slot) : null; }

/** Every slot directory actually present under DATA/accounts. */
function listSlots(dataDir) {
  const base = path.join(dataDir, 'accounts');
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && safeSlot(e.name))
    .map((e) => e.name)
    .sort();
}

/** One live slot, shaped for lifetime-history.normalizeSource(). */
function readLiveSlot(dataDir, slot) {
  const dir = path.join(dataDir, 'accounts', slot);
  const meta = readJson(path.join(dir, 'meta.json'), {}) || {};
  return {
    kind: 'live',
    slot,
    slotId: slot,
    accountId: meta.accountId || null,
    // A live slot with no meta.json still needs a label or it merges into a
    // single "(unlabelled)" bucket with every other bare slot.
    label: meta.name || ('Slot ' + slot),
    stage: meta.stage || null,
    size: meta.size || null,
    status: meta.status || 'active',
    gr_history: readJson(path.join(dir, 'gr_history.json'), []) || [],
    day_trades: readJson(path.join(dir, 'day_trades.json'), {}) || {},
    balance_ledger: readJson(path.join(dir, 'balance_ledger.json'), {}) || {},
    ck_history: readJson(path.join(dir, 'ck_history.json'), []) || [],
  };
}

/** Archive records, normalised to the same shape. */
function readArchives(dataDir) {
  const raw = readJson(path.join(dataDir, 'account_archives.json'), []) || [];
  const list = Array.isArray(raw) ? raw : (raw.records || raw.archives || []);
  return list.filter(Boolean).map((r) => ({
    kind: 'archive',
    slot: r.slotId || r.slot || '?',
    slotId: r.slotId || r.slot || '?',
    accountId: r.accountId || null,
    label: r.label || null,
    stage: r.stage || null,
    size: r.size || null,
    event: r.event || null,
    archivedAt: r.archivedAt || null,
    ls: r.ls || {},
  }));
}

/** Collect every source on disk. Exported so the WS handler can report counts. */
function collectSources(dataDir) {
  const slots = listSlots(dataDir);
  const live = slots.map((s) => readLiveSlot(dataDir, s));
  const archives = readArchives(dataDir);
  return { slots, sources: live.concat(archives) };
}

/**
 * The whole lifetime record.
 * @returns {{days, accounts, boundaries, conflicts, stats, trades, slots}}
 */
function buildLifetime(dataDir) {
  const { slots, sources } = collectSources(dataDir);
  const merged = LH.mergeLifetime(sources);
  const trades = LH.mergeTrades(sources, merged.days);
  const ledger = LH.mergeLedger(sources, merged.days);
  const checks = LH.mergeChecks(sources, merged.days);
  return Object.assign({}, merged, { trades, ledger, checks, slots });
}

module.exports = { buildLifetime, collectSources, listSlots, readLiveSlot, readArchives };
