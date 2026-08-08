// ═══════════════════════════════════════════════════════════════════════════════
// BOOKS INDEX (2026-07-27) — the trader's trading book library, searchable by both
// agents (Jessi/groq-agent.js and the Claude analysis agent/claude-agent.js).
// Books live as plain .txt in data/books/ (extracted once from PDFs the user
// uploaded — Stock Market Wizards, Trading in the Zone, Intraday Trading
// Techniques, Prop Trading Secrets, TradeApp's Guide to Proprietary Trading).
//
// Deliberately NO embeddings / vector DB / network call — same philosophy as
// the Journal tab's hand-rolled canvas charts: zero new dependencies, fully
// offline, and a personal 5-book library doesn't need a vector index to be
// useful. Search is chunked keyword scoring (word-overlap + phrase bonus),
// which is plenty precise at this corpus size (~1,300 chunks total).
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const BOOKS_DIR = path.join(__dirname, 'data', 'books');
const CHUNK_WORDS = 220;      // ~ a long paragraph / short passage
const CHUNK_OVERLAP = 40;     // words of overlap so a passage split at chunk
                               // boundary isn't lost entirely from either side

const TITLES = {
  stock_market_wizards: 'Stock Market Wizards — Jack Schwager',
  trading_in_the_zone: 'Trading in the Zone — Mark Douglas',
  intraday_trading_techniques: 'Intraday Trading Techniques',
  prop_trading_secrets: 'Prop Trading Secrets — Kathy Lien & Etienne Crete',
  tradeapp_prop_trading_guide: "TradeApp's Guide to Proprietary Trading",
};

let CHUNKS = null; // lazy-built on first search, cached for process lifetime

function stopwordSet() {
  return new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
    'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by',
    'from', 'as', 'that', 'this', 'it', 'its', 'i', 'you', 'your', 'my', 'me',
    'if', 'not', 'no', 'do', 'did', 'does', 'have', 'has', 'had', 'will', 'would',
    'can', 'could', 'should', 'so', 'than', 'then', 'there', 'their', 'they',
    'what', 'when', 'which', 'who', 'how', 'was', 'into', 'about', 'up', 'out',
    'just', 'more', 'one', 'also']);
}
const STOP = stopwordSet();

function tokenize(str) {
  return (str.toLowerCase().match(/[a-z0-9']+/g) || []);
}

function buildChunksForBook(key) {
  const file = path.join(BOOKS_DIR, key + '.txt');
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch (e) { return []; }
  // collapse to a flat word stream so chunk boundaries are consistent
  // regardless of how the PDF extraction broke lines/pages.
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0, idx = 0;
  while (i < words.length) {
    const slice = words.slice(i, i + CHUNK_WORDS);
    if (!slice.length) break;
    const chunkText = slice.join(' ');
    chunks.push({
      book: key,
      title: TITLES[key] || key,
      chunkIdx: idx++,
      text: chunkText,
      tokens: tokenize(chunkText),
    });
    i += (CHUNK_WORDS - CHUNK_OVERLAP);
  }
  return chunks;
}

function ensureIndex() {
  if (CHUNKS) return CHUNKS;
  let files = [];
  try { files = fs.readdirSync(BOOKS_DIR).filter(f => f.endsWith('.txt')); } catch (e) {}
  const all = [];
  files.forEach(f => {
    const key = f.replace(/\.txt$/, '');
    all.push(...buildChunksForBook(key));
  });
  CHUNKS = all;
  return CHUNKS;
}

// Score a chunk against a query: word-overlap count (stopwords excluded),
// weighted 3x if the exact multi-word phrase appears verbatim.
function scoreChunk(chunk, queryTokens, queryLower) {
  let score = 0;
  const seen = {};
  chunk.tokens.forEach(t => {
    if (STOP.has(t)) return;
    if (queryTokens.includes(t)) {
      seen[t] = (seen[t] || 0) + 1;
    }
  });
  Object.keys(seen).forEach(t => { score += Math.min(seen[t], 3); }); // cap per-word spam
  if (queryLower.length > 3 && chunk.text.toLowerCase().includes(queryLower)) score += 8;
  return score;
}

/**
 * Search the book library for passages relevant to `query`.
 * @param {string} query - free-text question or topic
 * @param {object} opts - { limit: number, book: string|null (restrict to one book key) }
 * @returns {Array<{book, title, chunkIdx, text, score}>}
 */
function searchBooks(query, opts) {
  opts = opts || {};
  const limit = opts.limit || 4;
  const chunks = ensureIndex();
  const queryTokens = tokenize(query).filter(t => !STOP.has(t));
  const queryLower = query.toLowerCase().trim();
  if (!queryTokens.length) return [];
  const pool = opts.book ? chunks.filter(c => c.book === opts.book) : chunks;
  const scored = pool
    .map(c => ({ c, score: scoreChunk(c, queryTokens, queryLower) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map(x => ({
    book: x.c.book,
    title: x.c.title,
    chunkIdx: x.c.chunkIdx,
    text: x.c.text,
    score: x.score,
  }));
}

function listBooks() {
  ensureIndex();
  const counts = {};
  (CHUNKS || []).forEach(c => { counts[c.book] = (counts[c.book] || 0) + 1; });
  return Object.keys(TITLES)
    .filter(k => counts[k])
    .map(k => ({ key: k, title: TITLES[k], chunks: counts[k] }));
}

module.exports = { searchBooks, listBooks, TITLES };
