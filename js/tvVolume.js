/**
 * tvVolume.js — the TV's volume, set from the phone's volume buttons.
 *
 * Uses Samsung's tizen.tvaudiocontrol (privilege tv.audio, already in config.xml). With a
 * soundbar on HDMI eARC (Q-Symphony) the TV passes the change on to the soundbar. Changes made
 * with the TV's own remote are reported to the phone too, so its slider follows.
 * Not on a Samsung TV (browser / some emulators): a stand-in volume, reported as supported:false.
 */
var TvVolume = (function () {
  var api = null, level = 50, muted = false, supported = false, onChange = null;
  var osd = null, osdFill = null, osdNum = null, osdTimer = null, lastSetAt = 0;
  // Did the last change from the phone actually take effect? (read back from the TV). With some
  // sound outputs (e.g. a soundbar on HDMI eARC) the app API may be ignored; the phone then uses the
  // TV's own remote-control keys instead (KEY_VOLUP / KEY_VOLDOWN), like the TV remote.
  var result = { asked: null, before: null, after: null, applied: null, error: null }, ignoredLogged = false;
  function noteResult(asked, before, err) {
    result = { asked: asked, before: before, after: level, applied: err ? false : (asked === 'up' ? level > before || before >= 100 : asked === 'down' ? level < before || before <= 0 : typeof asked === 'number' ? level === asked : true), error: err || null };
    if (result.applied === false && !ignoredLogged) { ignoredLogged = true; log('Volume: the TV did not apply the change (asked ' + asked + ', level ' + before + ' -> ' + level + (err ? ', ' + err : '') + ') \u2014 the phone should use the TV remote keys'); }
    if (result.applied) ignoredLogged = false;
  }

  function log(m) { if (window.__debugLog) window.__debugLog(m); }

  function init() {
    try {
      if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
        api = tizen.tvaudiocontrol;
        level = api.getVolume(); muted = !!api.isMute(); supported = true;
        try {
          api.setVolumeChangeListener(function (v) {
            level = v; try { muted = !!api.isMute(); } catch (e) {}
            // TV remote / soundbar: the TV shows its own volume bar, so only tell the phone
            if (Date.now() - lastSetAt > 600) report('tv');
          });
        } catch (e) {}
        log('Volume: TV volume control ready (level ' + level + (muted ? ', muted' : '') + ')');
      } else log('Volume: no TV volume control here (browser/emulator) — using a stand-in');
    } catch (e) { api = null; supported = false; log('Volume: TV volume control unavailable (' + e.message + ')'); }
    osd = document.getElementById('volOsd'); osdFill = document.getElementById('volFill'); osdNum = document.getElementById('volNum');
  }

  function read() { if (api) { try { level = api.getVolume(); muted = !!api.isMute(); } catch (e) {} } }

  function set(v) {
    v = Math.max(0, Math.min(100, Math.round(Number(v))));
    if (isNaN(v)) return;
    lastSetAt = Date.now();
    var before = level, err = null;
    if (api) { try { api.setVolume(v); if (muted && v > 0) api.setMute(false); } catch (e) { err = e.message; log('Volume: setVolume failed (' + e.message + ')'); } read(); }
    else { level = v; if (v > 0) muted = false; }
    noteResult(v, before, err);
    show(); report('phone');
  }
  function step(dir, n) {
    n = Math.max(1, Math.min(10, Number(n) || 1));
    lastSetAt = Date.now();
    if (api && n === 1) {
      var before = level, err = null;
      try { if (dir > 0) api.setVolumeUp(); else api.setVolumeDown(); } catch (e) { err = e.message; log('Volume: step failed (' + e.message + ')'); }
      read(); noteResult(dir > 0 ? 'up' : 'down', before, err); show(); report('phone');
    } else set(level + dir * n);
  }
  function mute(on) {
    lastSetAt = Date.now();
    on = on == null ? !muted : !!on;
    if (api) { try { api.setMute(on); } catch (e) { log('Volume: mute failed (' + e.message + ')'); } read(); }
    else muted = on;
    show(); report('phone');
  }

  function show() {
    if (!osd) return;
    osd.classList.add('show');
    if (osdFill) osdFill.style.height = (muted ? 0 : level) + '%';
    if (osdNum) osdNum.textContent = muted ? 'Muted' : String(level);
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { osd.classList.remove('show'); }, 1600);
  }
  function report(from) { if (onChange) try { onChange(state(), from); } catch (e) {} }
  function state() { read(); return { level: level, muted: muted, supported: supported, applied: result.applied, error: result.error }; }

  return {
    init: init, set: set, up: function (n) { step(1, n); }, down: function (n) { step(-1, n); }, mute: mute,
    state: state, setOnChange: function (fn) { onChange = fn; }
  };
})();
