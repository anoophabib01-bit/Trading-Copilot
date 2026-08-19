const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// crash-logger.js patches the GLOBAL console object and tracks patch state in
// a module-level flag. Each test needs a fresh require of the module (cache
// cleared) so tests don't interfere with each other's console patches.
function freshLogger() {
  delete require.cache[require.resolve('../crash-logger.js')];
  return require('../crash-logger.js');
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crash-logger-test-'));
}

test('logFileNameFor produces one file per IST calendar day', () => {
  const CL = freshLogger();
  // 2026-08-13 19:30 UTC == 2026-08-14 01:00 IST — same boundary logic this
  // app already uses elsewhere (checklist-logic.js tradingDayIST).
  const name1 = CL.logFileNameFor(new Date('2026-08-13T18:25:00Z')); // 23:55 IST
  const name2 = CL.logFileNameFor(new Date('2026-08-13T19:30:00Z')); // 01:00 IST next day
  assert.strictEqual(name1, 'server-2026-08-13.log');
  assert.strictEqual(name2, 'server-2026-08-14.log');
});

test('THE FIX: console.error still prints to the console exactly as before', () => {
  const CL = freshLogger();
  const dir = tmpDir();
  const restore = CL.installConsoleMirror(dir);
  try {
    let captured = null;
    const realWrite = process.stderr.write;
    process.stderr.write = (chunk) => { captured = String(chunk); return true; };
    try {
      console.error('CRASH-GUARD test message');
    } finally {
      process.stderr.write = realWrite;
    }
    assert.ok(captured && captured.includes('CRASH-GUARD test message'),
      'console.error must still write to the real console — mirroring must never replace it');
  } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('THE POINT: console.error is ALSO durably written to disk', () => {
  const CL = freshLogger();
  const dir = tmpDir();
  const restore = CL.installConsoleMirror(dir);
  try {
    console.error('a crash that would previously vanish with the window');
    const files = fs.readdirSync(dir);
    assert.strictEqual(files.length, 1);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.match(content, /\[error\]/);
    assert.match(content, /a crash that would previously vanish with the window/);
  } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('error objects are logged with their full stack, not just the message', () => {
  const CL = freshLogger();
  const dir = tmpDir();
  const restore = CL.installConsoleMirror(dir);
  try {
    const err = new Error('boom');
    console.error('[CRASH-GUARD] uncaughtException (process kept alive):', err);
    const files = fs.readdirSync(dir);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.match(content, /Error: boom/);
    assert.match(content, /at /); // a stack frame line
  } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('log.warn.error each mirror independently and are all captured', () => {
  const CL = freshLogger();
  const dir = tmpDir();
  const restore = CL.installConsoleMirror(dir);
  try {
    console.log('info line');
    console.warn('warn line');
    console.error('error line');
    const files = fs.readdirSync(dir);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.match(content, /\[log\] info line/);
    assert.match(content, /\[warn\] warn line/);
    assert.match(content, /\[error\] error line/);
  } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('calling installConsoleMirror twice does not double-write every log line', () => {
  const CL = freshLogger();
  const dir = tmpDir();
  const restore1 = CL.installConsoleMirror(dir);
  const restore2 = CL.installConsoleMirror(dir); // simulates a module required twice
  try {
    console.error('single line');
    const files = fs.readdirSync(dir);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    const matches = content.match(/single line/g) || [];
    assert.strictEqual(matches.length, 1);
  } finally { restore2(); restore1(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restore() puts back the original console functions', () => {
  const CL = freshLogger();
  const dir = tmpDir();
  const originalError = console.error;
  const restore = CL.installConsoleMirror(dir);
  assert.notStrictEqual(console.error, originalError);
  restore();
  assert.strictEqual(console.error, originalError);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unwritable logs directory degrades to console-only, does not throw', () => {
  const CL = freshLogger();
  // A file where a directory is expected — mkdirSync/createWriteStream will
  // fail for every write. Mirroring must swallow that, not crash the app it
  // exists to keep alive.
  const dir = tmpDir();
  const blockerPath = path.join(dir, 'blocked');
  fs.writeFileSync(blockerPath, 'not a directory');
  const restore = CL.installConsoleMirror(blockerPath); // treating the FILE as the logs dir
  try {
    assert.doesNotThrow(() => console.error('should not throw even though disk logging is broken'));
  } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pruneOldLogs deletes only server-*.log files older than the cutoff', () => {
  const CL = freshLogger();
  const dir = tmpDir();
  try {
    const oldFile = path.join(dir, 'server-2020-01-01.log');
    const newFile = path.join(dir, 'server-2026-08-13.log');
    const unrelated = path.join(dir, 'not-a-log.txt');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(newFile, 'new');
    fs.writeFileSync(unrelated, 'ignore me');
    const oldTime = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, oldTime, oldTime);

    CL.pruneOldLogs(dir, 14);

    assert.strictEqual(fs.existsSync(oldFile), false);
    assert.strictEqual(fs.existsSync(newFile), true);
    assert.strictEqual(fs.existsSync(unrelated), true); // never touches non-log files
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pruneOldLogs on a missing directory does not throw', () => {
  const CL = freshLogger();
  assert.doesNotThrow(() => CL.pruneOldLogs('/definitely/does/not/exist', 14));
});

// ── Real process-kill test (2026-08-13, autoplan Eng review) ────────────────
// Every test above proves the WRITE call is synchronous. None of them prove
// the log survives the process actually dying — the one claim this whole
// module exists for, and the one thing the plan doc flagged as verified only
// via an informal `node -e` manual check, never an automated test.
//
// FIRST DRAFT of this test spawned a child and had the PARENT send an
// external SIGKILL after a fixed busy-wait — that raced the OS's actual
// process-spawn timing and was flaky (passed most runs, failed one run in
// testing here). Rewritten: the CHILD calls process.exit(1) on itself
// immediately after the write. process.exit() is documented to NOT wait for
// the event loop or pending I/O to drain — so if the write inside
// console.error() were actually buffered/async under the hood, this exact
// call would very plausibly lose it. spawnSync blocks the parent until the
// child (which exits itself, no external kill needed) is fully done, so
// there is no timing race left to be flaky about.
const { spawnSync } = require('child_process');

test('REAL PROCESS EXIT: the crash line survives process.exit() with zero event-loop drain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-logger-killtest-'));
  try {
    const script = `
      const CL = require(${JSON.stringify(require.resolve('../crash-logger.js'))});
      CL.installConsoleMirror(${JSON.stringify(dir)});
      console.error('SURVIVES-ABRUPT-EXIT marker line');
      process.exit(1); // no graceful shutdown, no chance for async I/O to flush
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1, 'child should have exited via process.exit(1) as scripted');

    const files = fs.readdirSync(dir);
    assert.strictEqual(files.length, 1);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.match(content, /SURVIVES-ABRUPT-EXIT marker line/,
      'the log line must be on disk even though the process exited with zero event-loop drain');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
