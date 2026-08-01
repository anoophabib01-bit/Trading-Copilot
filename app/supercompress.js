'use strict';
// Wraps the SuperCompress API (https://www.supercompress.dev) — compresses a
// block of context against a query before it's folded into a Claude prompt.
// Used for book-search results, which can otherwise run long.

const ENDPOINT = 'https://www.supercompress.dev/api/v1/compress';

let apiKey = null;

function init(key) {
  apiKey = key || null;
}

function isReady() { return !!apiKey; }

// Falls back to the original context on any failure (missing key, network
// error, non-2xx) so a SuperCompress outage never breaks book search.
async function compress(context, query) {
  if (!apiKey || !context) return context;

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ context, query })
    });
    if (!res.ok) return context;
    const data = await res.json();
    return (data && data.compressed_text) || context;
  } catch {
    return context;
  }
}

module.exports = { init, isReady, compress };
