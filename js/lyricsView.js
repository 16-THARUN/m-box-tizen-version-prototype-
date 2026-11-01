/**
 * lyricsView.js — lyrics on the TV, in time with what the TV plays.
 *
 * Where the lyrics come from (whichever arrives first):
 *  1. The phone sends them:  {"action":"LYRICS","trackId":"<id>","lrc":"[00:12.30]line..."}
 *     or "lines":[{"t":12.3,"text":"line"}...]  or  "text":"plain lyrics" (not timed).
 *  2. The TV asks the phone:  GET <song url>/lyrics  -> the same JSON, or LRC / plain text.
 *     404/202 = not ready: asked again after 5 s, then left alone.
 * Shown with the Lyrics button on the TV, or {"action":"SET_LYRICS","on":true} from the phone.
 * Timed lines follow the TV's own playback position (the same smooth clock as the visualizer),
 * so they stay in time even though the player reports its position only every few hundred ms.
 */
var LyricsView = (function () {
  var npEl, panel, listEl, msgEl;
  var on = false, lines = [], synced = false, forKey = null, curIdx = -2, source = '', loading = false;
  var pending = {}, pendingOrder = [];
  var raf = null, lastTop = null;
  var LEAD = 0.15;                       // show a line a moment early: it reads as "on time"
  var onViewChange = null;

  function log(m) { if (window.__debugLog) window.__debugLog(m); }

  function init() {
    npEl = document.getElementById('nowPlaying');
    panel = document.getElementById('lyricsPanel');
    listEl = document.getElementById('lyricsList');
    msgEl = document.getElementById('lyricsMsg');
    var saved = null; try { saved = localStorage.getItem('mbox_lyrics_on'); } catch (e) {}
    if (saved === '1') setOn(true, 'saved');
    setInterval(watchTrack, 400);
  }

  // ---------- which song ----------
  function keyOf(t) { return t ? String(t.originalUri || t.uri || t.id || '') : null; }
  function watchTrack() {
    var t = typeof Player !== 'undefined' ? Player.currentTrack() : null;
    var k = keyOf(t);
    if (k === forKey) return;
    forKey = k; lines = []; synced = false; curIdx = -2; source = ''; lastTop = null;
    render();
    if (!t) return;
    var p = t.phoneId != null && pending[String(t.phoneId)];
    if (p) { apply(p, 'phone'); return; }
    if (t.isPhoneStream) fetchLyrics(t, k, 0);
  }
  function fetchLyrics(t, key, n) {
    var parts = String(t.originalUri || t.uri).split('?');
    var url = parts[0] + '/lyrics' + (parts[1] ? '?' + parts[1] : '');
    loading = true; render();
    try {
      var x = new XMLHttpRequest();
      x.open('GET', url, true); x.timeout = 6000;
      x.onload = function () {
        if (forKey !== key || lines.length) return;
        if (x.status === 200 && x.responseText) {
          var data; try { data = JSON.parse(x.responseText); } catch (e) { data = { lrc: x.responseText }; }
          loading = false;
          if (!apply(data, 'TV asked the phone')) { log('Lyrics: the phone’s answer had no lines'); render(); }
          return;
        }
        again('HTTP ' + x.status);
      };
      x.onerror = function () { again('network error'); };
      x.ontimeout = function () { again('timed out'); };
      x.send();
    } catch (e) { again(e.message); }
    function again(why) {
      if (forKey !== key || lines.length) return;
      if (n === 0) { setTimeout(function () { if (forKey === key && !lines.length) fetchLyrics(t, key, 1); }, 5000); return; }
      loading = false; render();
      log('Lyrics: none from the phone for “' + t.title + '” (' + why + ')');
    }
  }

  /** LYRICS message from the phone. */
  function setFromPhone(msg) {
    var id = msg.trackId != null ? msg.trackId : msg.id;
    var t = typeof Player !== 'undefined' ? Player.currentTrack() : null;
    var forCurrent = (id == null) || (t && t.phoneId != null && String(t.phoneId) === String(id)) || (msg.url && t && keyOf(t) === msg.url);
    if (!forCurrent) {                                      // lyrics sent ahead for a song that isn't on yet
      var k = String(id); pending[k] = msg; pendingOrder.push(k);
      while (pendingOrder.length > 12) delete pending[pendingOrder.shift()];
      return;
    }
    apply(msg, 'phone');
  }

  // ---------- parsing ----------
  function apply(data, from) {
    var parsed = parse(data);
    if (!parsed.lines.length) return false;
    lines = parsed.lines; synced = parsed.synced; curIdx = -2; source = from; loading = false; lastTop = null;
    log('Lyrics: ' + lines.length + ' lines, ' + (synced ? 'timed' : 'not timed') + ' (from the ' + from + ')');
    render();
    return true;
  }
  function parse(d) {
    if (typeof d === 'string') d = { lrc: d };
    d = d || {};
    if (Array.isArray(d.lines) && d.lines.length) {
      var out = [], timed = false;
      d.lines.forEach(function (l) {
        if (typeof l === 'string') { out.push({ t: null, text: l }); return; }
        var t = l.t != null ? Number(l.t) : l.time != null ? Number(l.time) : l.startMs != null ? Number(l.startMs) / 1000 : l.start != null ? Number(l.start) : null;
        if (t != null && !isNaN(t)) timed = true;
        out.push({ t: isNaN(t) ? null : t, text: String(l.text != null ? l.text : (l.words != null ? l.words : '')) });
      });
      if (timed && d.synced !== false) { out = out.filter(function (l) { return l.t != null; }).sort(function (a, b) { return a.t - b.t; }); return { lines: out, synced: true }; }
      return { lines: out, synced: false };
    }
    var text = d.lrc || d.syncedLyrics || d.text || d.plainLyrics || d.lyrics || '';
    return parseLrc(String(text));
  }
  function parseLrc(text) {
    var offset = 0, out = [], plain = [];
    var mo = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(text); if (mo) offset = Number(mo[1]) / 1000;
    text.split(/\r?\n/).forEach(function (row) {
      var re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g, m, times = [], last = 0;
      while ((m = re.exec(row))) { times.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0)); last = re.lastIndex; }
      if (times.length) {
        var words = row.slice(last).replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();   // drop word-timing tags
        times.forEach(function (t) { out.push({ t: Math.max(0, t - offset), text: words }); });
      } else if (!/^\s*\[[a-z]+:/i.test(row)) plain.push(row.trim());
    });
    if (out.length) { out.sort(function (a, b) { return a.t - b.t; }); return { lines: out, synced: true }; }
    plain = plain.filter(function (l, i) { return l || (i > 0 && plain[i - 1]); });
    return { lines: plain.map(function (l) { return { t: null, text: l }; }), synced: false };
  }

  // ---------- drawing ----------
  function render() {
    if (!listEl) return;
    listEl.innerHTML = '';
    lines.forEach(function (l, i) {
      var d = document.createElement('div');
      d.className = 'lyr-line' + (l.text ? '' : ' lyr-gap');
      d.textContent = l.text || '♪';
      listEl.appendChild(d);
    });
    listEl.classList.toggle('lyr-plain', !synced);
    if (msgEl) msgEl.textContent = lines.length ? '' : (loading ? 'Looking for lyrics…' : 'No lyrics for this song');
    curIdx = -2; lastTop = null;
  }
  // Same idea as the visualizer clock: run on the screen's clock, pulled gently towards the player's reports.
  var clk = { pos: 0, at: 0, raw: NaN, rawAt: 0, key: null };
  function mediaPos() {
    var raw = Player.getCurrentTime(), now = performance.now();
    if (raw !== clk.raw) { clk.raw = raw; clk.rawAt = now; }
    if (!Player.isPlaying() || !clk.at || clk.key !== forKey) { clk.pos = raw; clk.at = now; clk.key = forKey; return raw; }
    var dt = Math.min(0.1, (now - clk.at) / 1000); clk.at = now;
    var est = clk.raw + Math.min(0.75, (now - clk.rawAt) / 1000), pred = clk.pos + dt, err = est - pred;
    clk.pos = Math.abs(err) > 0.35 ? est : pred + err * Math.min(1, dt * 5);
    return clk.pos;
  }
  function lineAt(pos) {
    var lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (lines[mid].t <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function tick() {
    raf = null;
    if (!on) return;
    raf = requestAnimationFrame(tick);
    if (!lines.length || !panel || typeof Player === 'undefined' || ScreenManager.current() !== 'nowPlaying') return;
    var pos = mediaPos(), h = panel.clientHeight, kids = listEl.children, top;
    if (synced) {
      var idx = lineAt(pos + LEAD);
      if (idx !== curIdx) {
        for (var i = 0; i < kids.length; i++) {
          kids[i].classList.toggle('lyr-current', i === idx);
          kids[i].classList.toggle('lyr-past', i < idx);
        }
        curIdx = idx;
      }
      var el = kids[Math.max(0, idx)];
      if (!el) return;
      top = h * 0.42 - (el.offsetTop + el.offsetHeight / 2);
    } else {                                            // not timed: scroll through at the song's pace
      var dur = Player.getDuration() || 1, frac = Math.max(0, Math.min(1, pos / dur));
      top = h * 0.3 - frac * Math.max(0, listEl.scrollHeight - h * 0.4);
    }
    if (lastTop === null || Math.abs(top - lastTop) > 0.5) { listEl.style.transform = 'translateY(' + top.toFixed(1) + 'px)'; lastTop = top; }
  }

  // ---------- on / off ----------
  function setOn(v, why) {
    v = !!v;
    if (v === on && why !== 'saved') return;
    on = v;
    if (npEl) npEl.classList.toggle('np-lyrics', on);
    document.body.classList.toggle('lyrics-on', on);
    var btn = document.getElementById('btnLyrics'); if (btn) btn.classList.toggle('active', on);
    try { localStorage.setItem('mbox_lyrics_on', on ? '1' : '0'); } catch (e) {}
    lastTop = null; curIdx = -2;
    if (on && !raf) raf = requestAnimationFrame(tick);
    if (why !== 'saved') log('Lyrics: ' + (on ? 'shown' : 'hidden') + ' (' + why + ')');
    if (onViewChange && why !== 'phone' && why !== 'saved') onViewChange(on);
  }
  function toggle() { setOn(!on, 'TV remote'); }

  return {
    init: init, setFromPhone: setFromPhone, setOn: setOn, toggle: toggle,
    setOnViewChange: function (fn) { onViewChange = fn; },
    status: function () { return { on: on, available: lines.length > 0, synced: synced, lines: lines.length, current: curIdx, source: source }; },
    _parse: parse
  };
})();
