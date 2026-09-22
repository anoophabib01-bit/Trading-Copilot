/* ═══════════════════════════════════════════════════════════════════════════
   LEFT RAIL — collapsed rows, flyouts, and the live mirror   (2026-09-03)

   Anoop asked for the left column's boxes to become click-to-open popups so
   the column stops being a wall of text, with ONE exception pinned open:
   "i need 'since your last exit' to me constant".

   THE ONE DESIGN RULE THIS FILE OBEYS
   The flyout bodies are the ORIGINAL sections. They were not moved, cloned or
   re-templated — #stat-pnl, #stat-balance-funded, #news-list, #gonogo-badge and
   every other id still sit exactly where they always did, and the ~200 code
   paths in app.js/ws-client.js that write to them keep working untouched,
   whether a flyout is open or shut. (A `display:none` node still accepts
   textContent; nothing in this app gates a write on visibility.)

   This file therefore only ever READS those sections and MIRRORS a summary
   into the collapsed row. It never becomes a second source of truth for a
   number. If the mirror ever disagrees with the flyout, the flyout is right —
   that is the whole point of mirroring the DOM instead of the state object.

   Why a MutationObserver rather than calling a sync from each update path:
   the same reason chat-archive.js watches #messages instead of instrumenting
   111 call sites. Watching the output makes completeness structural. A future
   panel that writes a new number into Today is mirrored without anyone
   remembering to add a call here.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var GAP = 8;        // px between the column's right edge and the flyout
  var MIN_TOP = 56;   // never tuck a flyout under the title bar
  var openId = null;
  var scrim = null;

  function $(id) { return document.getElementById(id); }
  function txt(id) { var e = $(id); return e ? (e.textContent || '').trim() : ''; }
  function shown(el) { return !!el && el.style.display !== 'none'; }

  // ── Open / close ─────────────────────────────────────────────────────────
  function anchorFor(flyId) {
    return document.querySelector('[data-fly="' + flyId + '"]');
  }

  function position(fly, anchor) {
    var panel = $('left-panel');
    if (!panel || !anchor) return;
    var p = panel.getBoundingClientRect();
    var a = anchor.getBoundingClientRect();
    fly.style.left = Math.round(p.right + GAP) + 'px';
    // Measure AFTER it is displayed, then pull it up if it would run off the
    // bottom. The More-actions popover is anchored near the floor of the
    // window, so this clamp is what makes it open upward instead of clipping.
    var h = fly.getBoundingClientRect().height;
    var top = a.top;
    var maxTop = window.innerHeight - h - 12;
    if (top > maxTop) top = maxTop;
    if (top < MIN_TOP) top = MIN_TOP;
    fly.style.top = Math.round(top) + 'px';
  }

  function close() {
    if (!openId) return;
    var fly = $(openId);
    var anchor = anchorFor(openId);
    if (fly) fly.classList.remove('open');
    if (anchor) { anchor.classList.remove('open'); anchor.setAttribute('aria-expanded', 'false'); }
    if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
    openId = null;
  }

  function open(flyId) {
    if (openId === flyId) { close(); return; }
    close();
    var fly = $(flyId);
    var anchor = anchorFor(flyId);
    if (!fly) return;
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.id = 'lp-scrim';
      scrim.addEventListener('mousedown', close);
    }
    document.body.appendChild(scrim);
    fly.classList.add('open');
    if (anchor) { anchor.classList.add('open'); anchor.setAttribute('aria-expanded', 'true'); }
    position(fly, anchor);
    openId = flyId;
  }

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest && e.target.closest('[data-fly]');
    if (trigger) { e.preventDefault(); open(trigger.getAttribute('data-fly')); return; }
    // A button inside the More-actions popover has done its job by the time
    // this bubbles (inline onclick fires first, on the target), so closing
    // here is safe and saves him a second click to dismiss it.
    var inPop = e.target.closest && e.target.closest('.qa-fly .qa-btn');
    if (inPop) close();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openId) close();
  });

  // Anything that moves the anchor invalidates a fixed-position flyout. Close
  // rather than chase it: a panel that silently drifts away from the row it
  // belongs to is worse than one that needs a second click.
  window.addEventListener('resize', close);
  document.addEventListener('DOMContentLoaded', function () {
    var sc = $('left-scroll');
    if (sc) sc.addEventListener('scroll', close, { passive: true });
  });

  // ── The mirror ───────────────────────────────────────────────────────────
  // Reads the (possibly hidden) sections and writes one summary line per row.
  function setText(id, s) { var e = $(id); if (e && e.textContent !== s) e.textContent = s; }
  function setTone(id, tone) {
    var e = $(id);
    if (!e) return;
    e.classList.remove('green', 'red', 'amber');
    if (tone) e.classList.add(tone);
  }
  function toneOf(el) {
    if (!el) return '';
    if (el.classList.contains('red')) return 'red';
    if (el.classList.contains('green')) return 'green';
    if (el.classList.contains('amber')) return 'amber';
    return '';
  }
  function rowState(rowId, cls) {
    var r = $(rowId);
    if (!r) return;
    r.classList.remove('alert', 'warn');
    if (cls) r.classList.add(cls);
  }

  function syncAccount() {
    var fly = $('fly-account');
    if (!fly) return;
    var isFunded = shown(fly.querySelector('.funded-only'));
    setText('lp-k-account', txt('account-section-title') || 'Account');
    if (isFunded) {
      setText('lp-v-account', txt('stat-balance-funded') || '—');
      setText('lp-sub-account', 'Floor ' + (txt('stat-floor-funded') || '—') +
                                ' · buffer ' + (txt('stat-buffer-funded') || '—') +
                                ' · stop ' + (txt('stat-daystop-funded') || '—'));
    } else {
      setText('lp-v-account', txt('stat-balance-eval') || '—');
      setText('lp-sub-account', 'Floor ' + (txt('stat-floor-eval') || '—') +
                                ' · target ' + (txt('stat-remaining-eval') || '—') +
                                ' · stop ' + (txt('stat-daystop-eval') || '—'));
    }
  }

  function syncToday() {
    var badge = $('gonogo-badge');
    var pill = $('lp-v-gonogo');
    var state = '';
    if (badge) {
      state = badge.classList.contains('nogo') ? 'nogo'
            : badge.classList.contains('go') ? 'go'
            : 'pending';
      if (pill) {
        pill.textContent = state === 'nogo' ? 'NO-GO' : state === 'go' ? 'GO' : 'PENDING';
        pill.className = 'lp-pill ' + state;
      }
    }
    var pnl = $('stat-pnl');
    setText('lp-v-pnl', pnl ? (pnl.textContent || '').trim() : '$0');
    setTone('lp-v-pnl', toneOf(pnl));

    var trades = txt('stat-trades');
    var lim = txt('trade-limit-label');
    var parts = [];
    if (trades) parts.push(trades + (lim ? ' ' + lim : '') + ' trades');
    var size = txt('stat-size'); if (size) parts.push(size);
    var brk = txt('stat-break'); if (brk && brk !== '—') parts.push('break ' + brk);
    // Day plan, summarised on the COLLAPSED row (2026-09-19). The rows themselves
    // live in the flyout; this line is so the plan is visible without opening it —
    // Anoop opened the panel and reported not seeing the new rows at all, and a
    // summary that survives collapsing is the honest fix for that.
    var chunk = txt('stat-evalchunk'); if (chunk && chunk !== '—') parts.push('chunk ' + chunk);
    var stops = txt('stat-stopsleft'); if (stops && stops !== '—') parts.push(stops);
    // A NO-GO is the one thing that must survive collapsing, so its reason —
    // not the row's usual stat line — is what the summary shows.
    var badgeTxt = badge ? (badge.textContent || '').trim() : '';
    setText('lp-sub-today', state === 'nogo' && badgeTxt ? badgeTxt : parts.join(' · '));
    rowState('lp-row-today-anchor', state === 'nogo' ? 'alert' : '');
  }

  function syncNews() {
    var banner = $('news-blackout-banner');
    var list = $('news-list');
    if (shown(banner)) {
      setText('lp-v-news', 'NO-TRADE');
      setText('lp-sub-news', (banner.textContent || '').trim());
      rowState('lp-row-news-anchor', 'alert');
      return;
    }
    // The row is about TODAY's risk; the flyout behind it lists the whole week
    // (2026-09-03). Counting `.news-item.high` in the list would therefore make
    // the row read "15 red" on a Monday-to-Friday view of a quiet Thursday, so
    // the counts come from the explicit dataset contract renderNewsPanel
    // publishes instead of being re-derived from the markup.
    var ds = list ? list.dataset : {};
    var n = parseInt(ds.todayRed, 10) || 0;
    var hol = parseInt(ds.todayHoliday, 10) || 0;
    var weekN = parseInt(ds.weekRed, 10) || 0;
    setText('lp-v-news', n ? n + ' red' : (hol ? 'holiday' : 'clear'));

    // Today first, then what is still coming this week — the answer to "am I
    // clear right now" and "what am I walking into" are different questions and
    // he asked for both.
    var sub = '';
    var todayEl = list ? list.querySelector('.news-day.is-today') : null;
    var next = todayEl ? todayEl.querySelector('.news-item.high:not(.is-past)') : null;
    if (next) {
      var t = next.querySelector('.news-time');
      var title = next.querySelector('.news-title');
      sub = 'Next: ' + (title ? title.textContent.trim() : '') + (t ? ' ' + t.textContent.trim() : '');
    } else if (hol && todayEl) {
      var h = todayEl.querySelector('.news-item.holiday');
      sub = h ? h.textContent.trim() : 'Bank holiday today';
    } else if (list && list.querySelector('.no-patterns')) {
      sub = list.querySelector('.no-patterns').textContent.trim();
    } else {
      sub = 'Nothing left today';
    }
    var ahead = weekN - n;
    if (ahead > 0) sub += ' · ' + ahead + ' more red later this week';
    setText('lp-sub-news', sub);
    rowState('lp-row-news-anchor', n ? 'warn' : '');
  }

  // The pinned exit box hides itself on UNKNOWN / COOLING / NO_READ (see
  // renderExitDrift in app.js). Mirroring its display into the placeholder here
  // — rather than editing renderExitDrift's three return paths — keeps that
  // function the single decider of whether there is anything honest to say.
  function syncExitIdle() {
    var box = $('exit-drift-box');
    var idle = $('exit-drift-idle');
    if (!box || !idle) return;
    idle.style.display = shown(box) ? 'none' : '';
  }

  var queued = false;
  function syncAll() {
    queued = false;
    try { syncAccount(); } catch (e) { console.warn('[left-rail] account sync:', e.message); }
    try { syncToday(); } catch (e) { console.warn('[left-rail] today sync:', e.message); }
    try { syncNews(); } catch (e) { console.warn('[left-rail] news sync:', e.message); }
    try { syncExitIdle(); } catch (e) { console.warn('[left-rail] exit sync:', e.message); }
  }
  function queue() { if (!queued) { queued = true; requestAnimationFrame(syncAll); } }

  function init() {
    // Rows carry an id only so rowState() can tint them; the click target is
    // the [data-fly] attribute, which is what the delegated handler reads.
    var map = { 'fly-today': 'lp-row-today-anchor', 'fly-news': 'lp-row-news-anchor' };
    Object.keys(map).forEach(function (fly) {
      var el = anchorFor(fly);
      if (el && !el.id) el.id = map[fly];
    });

    // Observe the section bodies, never the rows — writing a row inside an
    // observed subtree would re-trigger the observer forever.
    var opts = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] };
    ['fly-account', 'fly-today', 'fly-news'].forEach(function (id) {
      var el = $(id);
      if (el) new MutationObserver(queue).observe(el, opts);
    });
    var box = $('exit-drift-box');
    if (box) new MutationObserver(queue).observe(box, { attributes: true, attributeFilter: ['style'] });

    syncAll();
    // One slow backstop. Everything above is event-driven; this only exists so
    // a value written by some path that mutates nothing observable (a direct
    // style rewrite on an ancestor, say) cannot leave the rail lying for an
    // entire session. 5s is invisible to him and free.
    setInterval(queue, 5000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.LeftRail = { open: open, close: close, sync: syncAll };
})();
