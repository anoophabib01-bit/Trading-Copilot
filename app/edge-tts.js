'use strict';
// Edge TTS — Microsoft's neural read-aloud voices over the same WebSocket
// endpoint the Edge browser uses. Free, no API key, no documented quota, and
// (unlike Groq's Orpheus, English/Arabic only) it has real Indian-English
// neural voices, which is exactly what the trader asked for ("human interaction
// kind of voice", 2026-07-25).
//
// HONEST CAVEAT, stated up front: this is an UNOFFICIAL endpoint. It's the
// same one every "edge-tts" library uses and has been stable for years, but
// Microsoft owes nobody notice before changing it. That's why the voice
// pipeline treats this as "try first", with browser speechSynthesis as the
// automatic fallback — if this breaks someday, voice mode degrades to the
// browser voice instead of dying.
//
// Uses the `ws` package the app already depends on (server.js's WebSocketServer
// comes from it) — no new dependency.

const WebSocket = require('ws');
const crypto = require('crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

// ── Sec-MS-GEC token (FIX 2026-07-28) ────────────────────────────────────────
// the trader hit "Unexpected server response: 403" on every read-aloud call after a
// restart. Cause: Microsoft added a DRM-style handshake requirement to this
// endpoint — the connection URL must now carry a `Sec-MS-GEC` token and a
// `Sec-MS-GEC-Version`. Requests without them are rejected at the WebSocket
// upgrade with a 403 before any audio is negotiated. The original file
// predates that change, which is why it worked for weeks and then stopped
// without anything in our code changing.
//
// Token recipe (same as every maintained edge-tts client):
//   1. Take current Unix time, round DOWN to the nearest 5 minutes (300s).
//   2. Convert to a Windows file-time: (unix + 11644473600) * 10^7 ticks.
//   3. SHA-256 of (thatNumber + TRUSTED_CLIENT_TOKEN), uppercase hex.
// The 5-minute rounding is what lets the server validate it without our clock
// matching theirs exactly. Token is regenerated per connection, so a long-
// running server never serves a stale one.
const WIN_EPOCH_OFFSET_SEC = 11644473600; // seconds between 1601-01-01 and 1970-01-01
const SEC_MS_GEC_VERSION = '1-130.0.2849.68';

function generateSecMsGec() {
  const nowSec = Math.floor(Date.now() / 1000);
  const rounded = nowSec - (nowSec % 300);           // floor to 5-minute window
  // Plain decimal string, no exponent. The value exceeds 2^53, so it's built
  // with BigInt — a float here loses precision and silently produces a wrong
  // hash, which would look identical to a 403 for the wrong reason.
  const ticksStr = (BigInt(rounded + WIN_EPOCH_OFFSET_SEC) * 10000000n).toString();
  return crypto.createHash('sha256')
    .update(ticksStr + TRUSTED_CLIENT_TOKEN, 'ascii')
    .digest('hex')
    .toUpperCase();
}

function buildWssUrl() {
  return WSS_BASE +
    '?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN +
    '&Sec-MS-GEC=' + generateSecMsGec() +
    '&Sec-MS-GEC-Version=' + SEC_MS_GEC_VERSION;
}

// Curated, verified voice names (full catalogue is ~400 voices).
const VOICES = {
  'en-IN-NeerjaNeural': 'Neerja — Indian English, female (default)',
  'en-IN-PrabhatNeural': 'Prabhat — Indian English, male',
  'en-US-JennyNeural': 'Jenny — US English, female',
  'en-US-GuyNeural': 'Guy — US English, male'
};
const DEFAULT_VOICE = 'en-IN-NeerjaNeural';

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// One WebSocket round trip: text in, MP3 buffer out.
function synthesize(text, voice) {
  const voiceName = VOICES[voice] ? voice : DEFAULT_VOICE;
  const reqId = crypto.randomUUID().replace(/-/g, '');
  const ts = new Date().toUTCString();

  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; try { ws.close(); } catch {} reject(e instanceof Error ? e : new Error(String(e))); } };
    const succeed = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      const buf = Buffer.concat(chunks);
      if (!buf.length) return reject(new Error('Edge TTS returned no audio.'));
      resolve(buf);
    };

    const timer = setTimeout(() => fail(new Error('Edge TTS timed out after 20s.')), 20000);

    const ws = new WebSocket(buildWssUrl(), {
      headers: {
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'
      }
    });

    ws.on('open', () => {
      ws.send(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: OUTPUT_FORMAT } } } })
      );
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voiceName}'>${xmlEscape(text)}</voice></speak>`;
      ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n${ssml}`);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Binary frame: [2-byte BE header length][header text][audio bytes]
        const buf = Buffer.from(data);
        if (buf.length < 2) return;
        const headerLen = buf.readUInt16BE(0);
        const header = buf.slice(2, 2 + headerLen).toString('utf8');
        if (header.includes('Path:audio')) chunks.push(buf.slice(2 + headerLen));
      } else {
        const s = data.toString();
        if (s.includes('Path:turn.end')) { clearTimeout(timer); succeed(); }
      }
    });

    ws.on('error', (e) => { clearTimeout(timer); fail(e); });
    ws.on('close', () => { clearTimeout(timer); if (!settled && chunks.length) succeed(); else if (!settled) fail(new Error('Edge TTS connection closed before audio arrived.')); });
  });
}

// Long replies: split on sentence boundaries into <=800-char pieces (well under
// any practical SSML limit) and synthesize sequentially so playback order holds.
function splitText(text) {
  const sentences = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*\s*/g) || [String(text || '')];
  const parts = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > 800) { if (cur.trim()) parts.push(cur.trim()); cur = s; }
    else cur += s;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

// Public API: text → array of base64 MP3 clips (client plays sequentially).
async function synthesizeClips(text, voice) {
  const parts = splitText(text);
  const clips = [];
  for (const p of parts) {
    const buf = await synthesize(p, voice);
    clips.push(buf.toString('base64'));
  }
  return clips;
}

module.exports = { synthesizeClips, VOICES, DEFAULT_VOICE };
