/**
 * remoteBridge.js — the phone link
 *
 * ONE connection between m-box Tizen and the m-box phone app:
 *   - The PHONE hosts the server (fixed port 8787):
 *       GET  /mbox/hello   -> identifies it as an m-box phone (for discovery)
 *       WS   /cast-bridge  -> control channel (this file)
 *   - Audio + artwork travel separately over plain HTTP URLs the phone
 *     sends in PLAY_TRACK; the TV's <audio> element fetches them directly.
 *
 * How the TV finds the phone, in order:
 *   1. The phone launched this app and passed senderIp/port (app control)
 *   2. The last phone we successfully connected to (saved)
 *   3. A subnet scan (PhoneDiscovery) — no typing needed
 * If a connected phone disappears (e.g. its IP changed), we retry twice,
 * then rescan automatically and reconnect to it at its new address.
 *
 * Global name kept as RemoteBridge so player.js/library.js work unchanged.
 */
var RemoteBridge = (function () {
  var PHONE_PORT = 8787;
  var DEFAULT_WS_PATH = '/cast-bridge';
  var KEY_HOST = 'mbox_phone_host';
  var KEY_PORT = 'mbox_phone_port';
  var KEY_NAME = 'mbox_phone_name';
  var KEY_PATH = 'mbox_phone_wspath';
  var CONNECT_TIMEOUT_MS = 5000;
  var RETRIES_BEFORE_RESCAN = 2;
  var BACKGROUND_RESCAN_MS = 30000;

  var ws = null;
  var phone = null;            // {host, port, name, wsPath}
  var status = 'idle';         // idle | connecting | connected | scanning | not-found | choose
  var failures = 0;
  var retryTimer = null;
  var rescanTimer = null;
  var connectTimer = null;
  var stateTimer = null;
  var foundPhones = [];
  var listeners = [];

  // ---------- public API ----------

  function init() {
    if (typeof TvVolume !== 'undefined') TvVolume.setOnChange(function (st, from) { sendEvent('VOLUME', Object.assign({ from: from }, st)); });
    if (typeof LyricsView !== 'undefined') LyricsView.setOnViewChange(function (on) { sendEvent('LYRICS_VIEW', { on: on }); });
    if (Player.setOnTrackChange) {
      Player.setOnTrackChange(function (t, index, count, reason) {
        remember('now playing ' + (index + 1) + '/' + count + ': ' + t.title + ' (' + reason + ')');
        sendEvent('TRACK_CHANGED', { queueId: queueId, index: index, count: count, reason: reason,
          id: t.phoneId != null ? t.phoneId : null, url: t.originalUri || t.uri, title: t.title, artist: t.artist,
          durationSec: t.durationSec || null, isPlaying: Player.isPlaying() });
        pushState();
      });
    }
    if (Player.setOnStreamError) {
      // At most one STREAM_ERROR per file + failure type per 30 s: the phone
      // re-sends PLAY_TRACK on every STREAM_ERROR, so a track that keeps
      // failing (e.g. Dolby on AVPlay) would otherwise retry forever.
      var lastErrors = {};
      Player.setOnStreamError(function (track, reason, q) {
        reason = reason || 'UNKNOWN';
        q = q || {};
        var key = track.uri + '|' + reason + '|' + queueId;   // identical failure in the same queue only
        var now = Date.now();
        if (lastErrors[key] && now - lastErrors[key] < 30000) {
          remember('error repeated \u2014 not re-reported: ' + String(reason).slice(0, 60));
          return;
        }
        lastErrors[key] = now;
        sendEvent('STREAM_ERROR', { id: track.id, phoneId: track.phoneId != null ? track.phoneId : null,
          queueIndex: q.queueIndex != null ? q.queueIndex : null, willSkip: !!q.willSkip, url: track.originalUri || track.uri, reason: reason });
        if (q.willSkip) remember('song can\u2019t play \u2014 told the phone the TV will skip it');
      });
    }

    // The phone may open the app again while it's already running (new
    // senderIp, or after the link dropped): re-read the launch data then.
    window.addEventListener('appcontrol', function () { checkLaunchData('opened again by the phone'); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (status === 'connected' && !launchDataPhone()) sendTvReady('back on screen');   // opened by hand: still tell the phone
      checkLaunchData('back on screen'); reconnectNow('app back on screen');
    });
    window.addEventListener('online', function () { reconnectNow('TV network is back'); });

    var launched = launchDataPhone();
    if (launched) { connectLaunched(launched); return; }

    var saved = savedPhone();
    if (saved) { connectTo(saved); return; }

    scanAndConnect({ auto: true });
  }

  /** Manual scan from Settings. */
  function scanAndConnect(opts) {
    opts = opts || {};
    clearTimers();
    setStatus('scanning');
    foundPhones = [];

    var early = false;
    var saved0 = savedPhone();
    var started = PhoneDiscovery.scan({
      onFound: function (p) {
        foundPhones.push(p); notify();
        // The phone we were using is back: connect now, don't wait ~10 s for the scan to finish.
        if (!early && saved0 && (p.name === saved0.name || p.host === saved0.host)) { early = true; connectTo(p); }
      },
      onDone: function (phones) {
        if (early) return;
        foundPhones = phones;
        if (!phones.length) {
          setStatus('not-found');
          var tr = Player.currentTrack();
          // Auto-connect only (no Settings): look again every 10 s for the first 3 minutes
          // without a phone (or while a song waits), then every 30 s.
          if (!notFoundSince) notFoundSince = Date.now();
          var wait = (tr && tr.isPhoneStream) || Date.now() - notFoundSince < 180000 ? 10000 : BACKGROUND_RESCAN_MS;
          if (opts.auto) rescanTimer = setTimeout(function () { scanAndConnect({ auto: true }); }, wait);
          return;
        }
        var saved = savedPhone();
        var match = saved && phones.filter(function (p) { return p.name === saved.name; })[0];
        if (match) { connectTo(match); return; }
        if (phones.length === 1) { connectTo(phones[0]); return; }
        // Several phones and none used before: there is no picker any more, so take the first one that answered.
        if (window.__debugLog) window.__debugLog('PhoneLink: ' + phones.length + ' m-box phones found \u2014 connecting to ' + phones[0].name);
        connectTo(phones[0]);
      }
    });
    if (!started) {
      // A scan is already running (its results go to the earlier caller):
      // check again shortly instead of waiting forever.
      setStatus('scanning');
      rescanTimer = setTimeout(function () { if (status !== 'connected') scanAndConnect(opts); }, 3000);
    }
  }

  function connectTo(p) {
    clearTimers();
    closeSocket();
    phone = { host: p.host, port: p.port || PHONE_PORT, name: p.name || p.host, wsPath: p.wsPath || DEFAULT_WS_PATH };
    var url = 'ws://' + phone.host + ':' + phone.port + phone.wsPath;
    setStatus('connecting');
    if (window.__debugLog) window.__debugLog('PhoneLink: connecting to ' + url);
    if (!lostShown) toast('Connecting to ' + phone.name + '\u2026', 'connecting:' + phone.host);

    try { ws = new WebSocket(url); } catch (e) { onLinkFailed(); return; }

    var thisWs = ws;
    connectTimer = setTimeout(function () {
      if (thisWs.readyState !== WebSocket.OPEN) { try { thisWs.close(); } catch (e) {} }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = function () {
      clearTimeout(connectTimer);
      failures = 0;
      savePhone(phone);
      setStatus('connected');
      if (window.__debugLog) window.__debugLog('PhoneLink: connected to ' + phone.name);
      wasConnected = true; lostShown = false; notFoundSince = 0;
      startHeartbeat(thisWs);
      toast('Connected to ' + phone.name, 'connected:' + phone.host);
      markLaunch('connected to the phone');
      if (splashEl && splashEl.classList.contains('show')) setSplashText('Connected to ' + phone.name, 'Getting your song ready\u2026');
      sendTvReady('connected');
      fetchFeatures(phone);
      setTimeout(function () { if (Player.resumeAfterReconnect) Player.resumeAfterReconnect(); }, 500);
      stateTimer = setInterval(pushState, 1000);
    };
    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      handleMessage(msg);
    };
    ws.onclose = function () {
      if (ws !== thisWs) return; // superseded by a newer connection
      clearTimeout(connectTimer);
      if (stateTimer) { clearInterval(stateTimer); stateTimer = null; }
      stopHeartbeat();
      if (wasConnected && !lostShown) { lostShown = true; wasConnected = false; toast('Lost connection to phone \u2014 reconnecting\u2026', 'lost'); }
      onLinkFailed();
    };
    ws.onerror = function () {};
  }

  /** Manual IP entry from Settings (fallback). */
  function setConfig(host, port) {
    connectTo({ host: host, port: port || PHONE_PORT, name: host });
  }

  function getConfig() {
    var p = phone || savedPhone();
    return p ? { host: p.host, port: p.port } : { host: '192.168.1.2', port: PHONE_PORT };
  }

  function getStatus() { return status; }
  function getPhone() { return phone; }
  function getFoundPhones() { return foundPhones.slice(); }
  function onChange(fn) { listeners.push(fn); }

  function sendEvent(type, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({
        type: 'event', event: type, eventType: type,
        payload: payload || {}, timestamp: Date.now()
      }));
    } catch (e) {}
  }

  // ---------- incoming messages ----------

  var recent = [];   // last few messages from the phone, shown in Settings for diagnosis

  function remember(label) {
    var d = new Date();
    var ts = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    recent.unshift(ts + '  ' + label);
    if (recent.length > 5) recent.length = 5;
    if (window.__debugLog) window.__debugLog('from phone: ' + label);
    notify();
  }

  function handleMessage(msg) {
    if (!msg) return;
    if (msg.type === 'command') { // command vocabulary (bridgeShared)
      remember('command ' + msg.action);
      if (BridgeShared.handleCommand(msg)) pushState();
      return;
    }

    // High-rate visualizer frames from the phone (used while the TV can't
    // analyse audio itself, i.e. AVPlay). Silent: no log, no state push.
    var rawAction = String(msg.action || msg.type || msg.command || '').toUpperCase();
    if (handleExtra(rawAction, msg)) return;
    if (rawAction === 'VIS_FRAME') { VisualizerManager.setRemoteFrame(msg.bands, msg.wave, 'phone', msg.t != null ? msg.t : msg.position, msg.trackId != null ? msg.trackId : msg.id); return; }
    if (rawAction === 'SET_VISUALIZER' || rawAction === 'VISUALIZER') {
      var picked = VisualizerManager.selectBy(msg.id || msg.name || msg.visualizer, msg.index, true);
      remember('SET_VISUALIZER ' + (picked ? picked.name : 'unknown: ' + (msg.id || msg.name)));
      pushState();
      return;
    }

    // Accept the variations a phone build might use: action/type/command,
    // any letter case, and a few synonyms for "play this URL".
    var raw = msg.action || msg.type || msg.command || '';
    var action = String(raw).toUpperCase();
    var url = msg.url || msg.streamUrl || msg.uri || null;
    if (url && !msg.url) msg.url = url;
    if ((action === 'PLAY' || action === 'LOAD' || action === 'LOAD_TRACK' || action === 'PLAY_URL' ||
         action === 'CAST' || action === 'PLAYREMOTETRACK' || action === 'PLAY_REMOTE_TRACK') && url) action = 'PLAY_TRACK';
    if (action === 'PLAY' && !url) action = 'RESUME';
    if (!action && url) action = 'PLAY_TRACK';

    if (!((action === 'PAUSE' || action === 'RESUME') && inFlood())) {
      remember(action ? action + (url ? ' ' + shortUrl(url) : '') + (msg.codec ? ' [' + msg.codec + ']' : '')
                      : 'unrecognised: ' + JSON.stringify(msg).slice(0, 80));
    }

    switch (action) {
      case 'PLAY_TRACK': playFromPhone(msg); break;
      case 'PAUSE':
        lastPauseAt = Date.now();                // also while ignored: a PLAY_TRACK right after it is part of the loop
        // A PAUSE while already paused changes nothing: it must not count toward the
        // loop guard (seen on the real TV: repeated no-op RESUMEs made the guard
        // swallow the viewer's real PAUSE, so the TV kept playing).
        if (!Player.isPlaying() && !inFlood()) { if (Player.markPausedByUser) Player.markPausedByUser(); break; }   // already stopped: just remember the intent, no echo
        if (floodGuard('PAUSE')) break;
        if (!Player.isPlaying()) break;
        Player.pause(); break;
      case 'RESUME':
        if (Player.currentTrack() && Player.isPlaying()) { if (inFlood()) floodGuard('RESUME'); break; }   // already playing: a no-op; only counts while a loop is already running
        if (floodGuard('RESUME')) break;
        if (!Player.currentTrack()) {
          // The phone thinks the TV has its song loaded, but it never got one.
          // Tell it plainly so it can send PLAY_TRACK (with url) instead.
          // Only NEED_TRACK: the phone answers each of these with a PLAY_TRACK,
          // so sending STREAM_ERROR too produced a double PLAY_TRACK.
          sendEvent('NEED_TRACK', { reason: 'NO_TRACK_LOADED: send PLAY_TRACK with url before RESUME' });
          break;
        }
        if (Player.isPlaying()) break;           // already playing: nothing to do
        Player.resume(); break;
      case 'LOAD_QUEUE': loadQueueFromPhone(msg); break;
      case 'NEXT': Player.next('next') ? Player.play() : sendEvent('QUEUE_ENDED', { index: Player.queueInfo().index, count: Player.queueInfo().length }); break;
      case 'PREV': Player.prev(); if (!Player.isPlaying()) Player.play(); break;
      case 'SKIP_TO': if (Player.skipTo(Number(msg.index))) Player.play(); break;
      case 'SET_REPEAT': Player.setRepeat(String(msg.mode || 'off').toLowerCase()); break;
      case 'SET_SHUFFLE': Player.setShuffleFlag(!!msg.on); break;       // the phone sends the shuffled order itself (LOAD_QUEUE)
      case 'QUEUE_ADD': Player.insertTracks((msg.items || []).filter(hasUrl).map(toTrack),
                          msg.playNext ? Player.queueInfo().index + 1 : (msg.at != null ? Number(msg.at) : null)); break;
      case 'QUEUE_REMOVE': Player.removeAt(Number(msg.index)); break;
      case 'SEEK': if (seekGuard(msg)) break; Player.seek(Number(msg.position) || 0); break;
      case 'STOP': Player.pause(); ScreenManager.show('library'); break;
      default:
        sendEvent('UNKNOWN_MESSAGE', { received: raw || null });
        return;
    }
    pushState();
  }

  /**
   * Flood guard. A phone build can get into a loop that fires PAUSE/RESUME
   * back and forth several times a second (seen on the real TV: FLAC stuck
   * at 0:00 "Buffering…", because every toggle restarts the TV's media
   * pipeline). 4+ PAUSE/RESUME within 3 s is not a human; while that's
   * happening, keep playing and ignore the toggles until they stop for 2 s.
   * Returns true if this message should be ignored.
   */
  var toggleTimes = [], floodUntil = 0, floodIgnored = 0, lastPauseAt = 0;
  function inFlood() { return Date.now() < floodUntil; }
  function floodGuard(action) {
    var now = Date.now();
    toggleTimes.push(now);
    while (toggleTimes.length && now - toggleTimes[0] > 3000) toggleTimes.shift();
    var wasFlood = inFlood();
    if (toggleTimes.length >= 4) floodUntil = now + 2000;
    if (!inFlood()) {
      if (floodIgnored) { remember('flood ended \u2014 ignored ' + floodIgnored + ' PAUSE/RESUME'); floodIgnored = 0; }
      return false;
    }
    if (!wasFlood) {
      remember('PAUSE/RESUME loop from phone \u2014 ignoring, keeping playback running');
      sendEvent('COMMAND_FLOOD', { reason: 'PAUSE/RESUME loop detected (4+ in 3 s); TV is ignoring them and keeps playing' });
    }
    floodIgnored++;
    if (Player.currentTrack() && !Player.isPlaying()) Player.resume(); // the phone's last intent was to play this track
    return true;
  }

  /**
   * SEEK echo guard. Seen on the real TV (QN85C, "Odysseus"): the position
   * stuck at 0:09-0:10 and play/pause flickered 3-4 times a second. The phone
   * moved its progress bar to the TV's reported position and its slider
   * listener sent that (already old) position straight back as a SEEK, so
   * every second the TV jumped back ~1 s. A seek to where the TV already is,
   * or to a position the TV itself reported in the last few seconds, is an
   * echo, not the user: ignore it. Real drags (further than 3 s) still work.
   */
  var reported = [], seekTimes = [], seekIgnored = 0, seekStormLogged = false;
  function noteReported(t) {
    var now = Date.now();
    reported.push({ at: now, t: t });
    while (reported.length && now - reported[0].at > 4000) reported.shift();
  }
  function seekGuard(msg) {
    var now = Date.now(), want = Number(msg.position) || 0, cur = Player.getCurrentTime();
    seekTimes.push(now);
    while (seekTimes.length && now - seekTimes[0] > 5000) seekTimes.shift();
    var echo = Math.abs(want - cur) < 3;
    for (var i = 0; !echo && i < reported.length; i++) if (Math.abs(reported[i].t - want) < 0.75 && want <= cur) echo = true;
    if (!echo) { if (seekIgnored) endSeekStorm(); return false; }
    seekIgnored++;
    if (seekIgnored === 1 || (seekTimes.length >= 3 && !seekStormLogged)) {
      if (seekTimes.length >= 3) {
        seekStormLogged = true;
        remember('SEEK loop from phone \u2014 it keeps sending back the TV\u2019s own position; ignoring');
        sendEvent('COMMAND_FLOOD', { reason: 'SEEK echo loop: phone sends the TV\u2019s reported position back as SEEK (' + seekTimes.length + ' in 5 s); TV ignores seeks within 3 s of where it is' });
      } else {
        remember('ignored SEEK to ' + fmt(want) + ' (already at ' + fmt(cur) + ') \u2014 echo');
      }
    }
    clearTimeout(seekGuard.t);
    seekGuard.t = setTimeout(endSeekStorm, 3000);
    return true;
  }
  function endSeekStorm() {
    if (seekIgnored > 1) remember('SEEK echoes stopped \u2014 ignored ' + seekIgnored);
    seekIgnored = 0; seekStormLogged = false;
  }
  function fmt(sec) { sec = Math.floor(sec || 0); return Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + sec % 60; }

  /**
   * LOAD_QUEUE {queueId, items:[{id,url,title,artist,album,durationSec,artworkUrl,mimeType,codec,bitDepth,sampleRate,channels}],
   *             index, position, repeat:'off'|'all'|'one', shuffle:bool, paused:bool}
   * The TV keeps the whole playlist and moves to the next song by itself when
   * one ends (like Spotify Connect): no gap waiting for the phone, and it keeps
   * going while the phone screen is off. The phone sends the order to play in
   * (already shuffled if shuffle is on). If the song at `index` is the one
   * already playing, it keeps playing (new order / added songs, no restart).
   */
  var queueId = null;
  function hasUrl(m) { return m && (m.url || m.uri); }
  function toTrack(m) { return BridgeShared.makeRemoteTrack(m, m.url || m.uri); }
  function loadQueueFromPhone(msg) {
    lastQueueAt = Date.now();
    hideLaunchSplash('song arrived'); markLaunch('song arrived (LOAD_QUEUE)');
    var items = (msg.items || msg.tracks || []).filter(hasUrl);
    if (!items.length) { sendEvent('UNKNOWN_MESSAGE', { received: 'LOAD_QUEUE without items' }); return; }
    var index = Math.max(0, Math.min(items.length - 1, Number(msg.index) || 0));
    queueId = msg.queueId || null;
    if (msg.repeat != null) Player.setRepeat(String(msg.repeat).toLowerCase());
    if (msg.shuffle != null) Player.setShuffleFlag(!!msg.shuffle);
    var want = items[index], cur = Player.currentTrack(), pos = Number(msg.position);
    var same = cur && !(Player.hasFailed && Player.hasFailed()) &&
      (cur.originalUri === (want.url || want.uri) || cur.uri === (want.url || want.uri) || (want.id != null && cur.phoneId === want.id));
    remember('queue of ' + items.length + ' from phone, start at ' + (index + 1) + (same ? ' (same song \u2014 kept playing)' : ''));
    if (same) {
      Player.replaceQueueKeepCurrent(items.map(toTrack), index);
      if (!isNaN(pos) && msg.position != null && Math.abs(pos - Player.getCurrentTime()) > 5) Player.seek(pos);
      if (!msg.paused && !Player.isPlaying()) Player.resume();
      if (msg.paused && Player.isPlaying()) Player.pause();
      sendEvent('QUEUE_LOADED', { queueId: queueId, index: index, count: items.length, kept: true });
      return;
    }
    var tracks = items.map(toTrack);
    tracks[index].startAt = isNaN(pos) ? 0 : pos;
    BridgeShared.playQueueFromPhone(items.map(function (m, i) { var c = {}; for (var k in m) c[k] = m[k]; if (i === index) c.startAt = tracks[index].startAt; return c; }), index, !!msg.paused);
    if (msg.paused) remember('queue loaded paused at ' + fmt(tracks[index].startAt) + ' \u2014 waiting for RESUME');
    sendEvent('QUEUE_LOADED', { queueId: queueId, index: index, count: items.length, kept: false });
    sendEvent('TRACK_CHANGED', { queueId: queueId, index: index, count: items.length, reason: 'load',
      id: want.id != null ? want.id : null, url: want.url || want.uri, title: want.title || null, artist: want.artist || null,
      durationSec: want.durationSec || null, isPlaying: Player.isPlaying() });
  }

  function shortUrl(u) {
    var m = String(u).match(/^https?:\/\/([^\/]+)(\/[^?]*)?/);
    return m ? m[1] + (m[2] || '') : String(u).slice(0, 40);
  }

  /**
   * The fix for "music plays but the TV doesn't show it": route phone
   * tracks through BridgeShared.playTrackFromUri, which loads the queue
   * with title/artist/album/artwork AND switches to Now Playing (which
   * starts the visualizer). The old Player.loadAndPlay path only set the
   * audio src.
   */
  var lastQueueAt = 0, lastPT = { url: null, at: 0 }, echoIgnored = 0;
  function playFromPhone(msg) {
    hideLaunchSplash('song arrived'); markLaunch('song arrived (PLAY_TRACK)');
    if (!msg.url) return;
    var prevPT = lastPT; lastPT = { url: msg.url, at: Date.now() };

    // Same track already loaded/playing? A phone re-sending PLAY_TRACK must
    // not restart it (seen on the real TV: the re-send kept resetting the
    // <audio> -> AVPlay fallback, so 24-bit FLAC never got to play).
    // Only while it's actively playing: after a pause/STOP, picking the same
    // song again should start it fresh. Same id decides when the phone sends
    // one; otherwise the same URL.
    var cur = Player.currentTrack();
    // Same URL = same file on the phone (/audio/<mediaId>), even if the phone
    // sends a different id each time. Same id also counts.
    // Paused or still loading counts too: on the real TV a phone that answers
    // the TV's state with PAUSE + PLAY_TRACK reloaded the file every second
    // (position stuck at 0:09, play/pause icon flickering). The same song is
    // resumed (and moved if the phone asks for a position > 5 s away, e.g.
    // 0:00 to start over), never reloaded. Only a track that failed or lost
    // its stream is loaded again.
    var sameTrack = cur && !(Player.hasFailed && Player.hasFailed() && !Player.isAwaitingReconnect()) &&
      (cur.uri === msg.url || cur.originalUri === msg.url || (msg.id != null && cur.id === 'remote_' + msg.id));
    if (sameTrack && Player.isAwaitingReconnect && Player.isAwaitingReconnect()) {
      Player.resumeAfterReconnect();               // stream was lost: reload at the remembered position
      remember('(same track \u2014 stream was lost, resuming)');
      sendEvent('PLAYBACK_STARTED', { url: msg.url, id: msg.id || null, backend: Player.getBackendName(), duplicate: true,
        currentTime: Player.getCurrentTime(), duration: Player.getDuration(), isPlaying: true });
      return;
    }
    var qi = Player.queueInfo ? Player.queueInfo() : null;
    if (qi && qi.fromPhone) {
      for (var f = 0; f < qi.items.length; f++) {
        var ft = qi.items[f];
        if ((ft.originalUri === msg.url || ft.uri === msg.url || (msg.id != null && ft.phoneId === msg.id)) &&
            ft.failed && Date.now() - (ft.failedAt || 0) < 15000) {
          remember('ignored PLAY_TRACK for a song that just failed: ' + (ft.title || shortUrl(msg.url)));
          pushState();
          return;
        }
      }
    }
    if (!sameTrack && qi && qi.fromPhone && qi.length > 1) {
      for (var j = 0; j < qi.items.length; j++) {
        var it = qi.items[j];
        if (it.originalUri === msg.url || it.uri === msg.url || (msg.id != null && it.phoneId === msg.id)) {
          remember('(song is in the queue \u2014 jumped to ' + (j + 1) + '/' + qi.length + ')');
          if (Player.skipTo(j)) { if (msg.position) it.startAt = Number(msg.position) || 0; Player.play(); }
          sendEvent('PLAYBACK_STARTED', { url: msg.url, id: msg.id || null, backend: Player.getBackendName(),
            currentTime: Number(msg.position) || 0, duration: Number(msg.durationSec) || 0, isPlaying: true, queueIndex: j });
          return;
        }
      }
    }
    if (sameTrack) {
      // Echo guard (seen in the phone's Logcat 2026-10-20 23:09: LOAD_QUEUE, then the same song as
      // PLAY_TRACK 6 times in 2 s, "reason: track change", position 0.0). The phone was answering the
      // TV's own reports with the song again. Right after a LOAD_QUEUE, or a repeat of the PLAY_TRACK
      // we just handled, the same song is ignored completely: no seek back to 0:00 and no reply
      // (a reply is what the phone reacts to).
      var nowT = Date.now();
      if (Player.isPlaying() && (nowT - lastQueueAt < 5000 || (prevPT.url === msg.url && nowT - prevPT.at < 4000))) {
        echoIgnored++;
        if (nowT - lastPauseAt < 1500) floodGuard('PLAY_TRACK');   // still part of a PAUSE/PLAY loop: keep the loop guard on
        if (echoIgnored === 1 || echoIgnored % 10 === 0) remember('ignored repeated PLAY_TRACK for the song already playing (' + echoIgnored + ' so far) \u2014 phone echo');
        return;
      }
      var wasPlaying = Player.isPlaying();
      // PAUSE then the same PLAY_TRACK within 1.5 s is a toggle echo, not a person
      if (Date.now() - lastPauseAt < 1500 && floodGuard('PLAY_TRACK')) {
        sendEvent('PLAYBACK_STARTED', { url: msg.url, id: msg.id || null, backend: Player.getBackendName(), duplicate: true,
          currentTime: Player.getCurrentTime(), duration: Player.getDuration(), isPlaying: true });
        return;
      }
      var want = Number(msg.position);
      if (!isNaN(want) && msg.position != null && Math.abs(want - Player.getCurrentTime()) > 5) Player.seek(want);
      if (!wasPlaying) Player.resume();
      remember(wasPlaying ? '(same track \u2014 kept playing, not restarted)' : '(same track \u2014 resumed, not reloaded)');
      // Include the real position: this phone build resets its progress bar from PLAYBACK_STARTED
      sendEvent('PLAYBACK_STARTED', { url: msg.url, id: msg.id || null, backend: Player.getBackendName(), duplicate: true,
        currentTime: Player.getCurrentTime(), duration: Player.getDuration(), isPlaying: Player.isPlaying() });
      return;
    }
    // Player picks the backend: Dolby (E-AC-3 / JOC / AC-3) -> AVPlay,
    // everything else -> <audio> + Web Audio. Start position is applied by
    // the player once the chosen backend is ready.
    BridgeShared.playTrackFromUri({
      id: msg.id,
      title: msg.title,
      artist: msg.artist,
      album: msg.album,
      durationSec: msg.durationSec,
      artworkUrl: msg.artworkUrl,
      mimeType: msg.mimeType,
      codec: msg.codec,
      channels: msg.channels,
      sampleRate: msg.sampleRate,
      sourceSampleRate: msg.sourceSampleRate,
      bitDepth: msg.bitDepth,
      bitrate: msg.bitrate,
      isJoc: msg.isJoc,
      atmosObjects: msg.atmosObjects,
      startAt: Number(msg.position) || 0
    }, msg.url);
    sendEvent('PLAYBACK_STARTED', { url: msg.url, id: msg.id || null, backend: Player.getBackendName(),
      currentTime: Number(msg.position) || 0, duration: Number(msg.durationSec) || 0, isPlaying: true });
  }

  /** Name the phone shows in its "Play on" list. Samsung ProductInfo API
   *  (privilege .../productinfo): getModel() = short model name, getRealModel()
   *  = full model code. Falls back to "m-box TV" off-device or on any error. */
  function tvIdentity() {
    var model = null, realModel = null;
    try {
      if (typeof webapis !== 'undefined' && webapis.productinfo) {
        try { model = webapis.productinfo.getModel(); } catch (e) {}
        try { realModel = webapis.productinfo.getRealModel(); } catch (e) {}
      }
    } catch (e) {}
    var label = model || realModel;
    return {
      device: 'm-box Tizen',
      deviceName: window.MBOX_EMULATOR ? 'm-box TV Emulator' : (label ? 'Samsung ' + label : 'm-box TV'),
      model: model || null,
      realModel: realModel || null
    };
  }

  var features = [];
  /** What the phone app supports (e.g. "tvsafe"), from GET /mbox/hello. */
  function fetchFeatures(p) {
    features = [];
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://' + p.host + ':' + p.port + '/mbox/hello', true);
      xhr.timeout = 3000;
      xhr.onload = function () {
        try {
          var info = JSON.parse(xhr.responseText);
          features = Array.isArray(info.features) ? info.features : [];
          if (info.name && phone) {
            phone.name = info.name;
            savePhone(phone);
            toast('Connected to ' + phone.name, 'connected:' + phone.host);
          }
        } catch (e) {}
        if (window.__debugLog) window.__debugLog('PhoneLink: phone features: ' + (features.length ? features.join(', ') : 'none'));
      };
      xhr.send();
    } catch (e) {}
  }
  function phoneSupports(f) { return features.indexOf(f) !== -1; }

  var stateSeq = 0;
  /** Phone-side single source of truth: STATE goes out at once when something the phone shows
   *  changes (song, playing/paused, queue position, volume, lyrics, display), not only every second. */
  var lastSig = '';
  function stateSig() {
    var t = Player.currentTrack(), q = Player.queueInfo ? Player.queueInfo() : null, v = typeof TvVolume !== 'undefined' ? TvVolume.state() : null;
    return [t ? (t.originalUri || t.uri) : '', Player.isPlaying(), q ? q.index : -1, q ? q.length : 0, q ? q.repeat : '',
      v ? v.level + '/' + v.muted : '', typeof LyricsView !== 'undefined' ? LyricsView.status().on : '',
      VisualizerManager.display ? VisualizerManager.display() : '', Player.isLoading && Player.isLoading()].join('|');
  }
  setInterval(function () {
    if (launchT0 && !launchMarks['music playing'] && Player.isPlaying() && Player.getCurrentTime() > 0.3 && !(Player.isLoading && Player.isLoading())) markLaunch('music playing');
    if (status !== 'connected') return;
    var s = stateSig();
    if (s !== lastSig) { lastSig = s; pushState(); }
  }, 150);

  /** Volume, lyrics and the calm screen. Returns true when the message was one of these. */
  function handleExtra(a, msg) {
    switch (a) {
      case 'SET_VOLUME': TvVolume.set(msg.level != null ? msg.level : msg.volume); remember('SET_VOLUME ' + (msg.level != null ? msg.level : msg.volume)); return true;
      case 'VOLUME_UP': TvVolume.up(msg.steps); return true;
      case 'VOLUME_DOWN': TvVolume.down(msg.steps); return true;
      case 'SET_MUTE': case 'MUTE': TvVolume.mute(msg.on != null ? !!msg.on : (msg.muted != null ? !!msg.muted : null)); return true;
      case 'GET_VOLUME': sendEvent('VOLUME', TvVolume.state()); return true;
      case 'LYRICS': LyricsView.setFromPhone(msg); return true;
      case 'SET_LYRICS': case 'SHOW_LYRICS': LyricsView.setOn(msg.on == null ? true : !!msg.on, 'phone'); remember(a + ' ' + (msg.on == null ? true : !!msg.on)); return true;
      case 'HIDE_LYRICS': LyricsView.setOn(false, 'phone'); return true;
      case 'SET_DISPLAY': VisualizerManager.setDisplay(msg.mode || msg.display, true); remember('SET_DISPLAY ' + (msg.mode || msg.display)); return true;
      case 'GET_STATE': pushState(); return true;
      case 'HANDOFF': case 'STOP_CASTING': {
        // The phone takes the music back ("Play on: This phone"). First tell it EXACTLY what the TV
        // was playing — song, position, queue — so the phone continues THAT song, not its old one
        // (seen on the real TV: the phone went back to "Kutti Story" at 0:00 while the TV played
        // "Thalapathy Vetri Kondan"). Then the TV pauses and goes back to its library.
        var ht = Player.currentTrack(), hq = Player.queueInfo ? Player.queueInfo() : null;
        sendEvent('HANDOFF_STATE', {
          trackId: ht && ht.phoneId != null ? ht.phoneId : null, url: ht ? (ht.originalUri || ht.uri) : null,
          title: ht ? ht.title : null, artist: ht ? ht.artist : null,
          position: +Player.getSmoothTime().toFixed(3), duration: Player.getDuration(), isPlaying: Player.isPlaying(),
          queueId: queueId, queueIndex: hq ? hq.index : -1, queueLength: hq ? hq.length : 0,
          queueIds: hq && hq.items ? hq.items.map(function (x) { return x.phoneId != null ? x.phoneId : null; }) : [],
          repeat: hq ? hq.repeat : 'off', shuffle: hq ? hq.shuffle : false
        });
        remember('HANDOFF to the phone' + (ht ? ' \u2014 ' + ht.title + ' at ' + Player.getSmoothTime().toFixed(1) + ' s' : ''));
        if (Player.isPlaying()) Player.pause();
        if (Player.markPausedByUser) Player.markPausedByUser();
        toast('Continuing on ' + (phone && phone.name ? phone.name : 'the phone'), 'handoff');
        ScreenManager.show('library');
        return true;
      }
      case 'PING': {                                       // clock check: the phone measures the round trip
        var tr = Player.currentTrack();
        sendEvent('PONG', { id: msg.id != null ? msg.id : null, t: msg.t != null ? msg.t : null,
          position: +Player.getSmoothTime().toFixed(3), isPlaying: Player.isPlaying(),
          trackId: tr && tr.phoneId != null ? tr.phoneId : null, seq: stateSeq });
        return true;
      }
    }
    return false;
  }

  function pushState() {
    var track = Player.currentTrack();
    noteReported(Player.getCurrentTime());
    var q = Player.queueInfo ? Player.queueInfo() : null;
    var vol = typeof TvVolume !== 'undefined' ? TvVolume.state() : null, ly = typeof LyricsView !== 'undefined' ? LyricsView.status() : null;
    sendEvent('STATE', {
      seq: ++stateSeq,
      artist: track ? track.artist : null, album: track ? track.album : null,
      buffering: !!(Player.isLoading && Player.isLoading()),
      volume: vol ? vol.level : null, muted: vol ? vol.muted : null, volumeSupported: vol ? vol.supported : false,
      lyricsOn: ly ? ly.on : false, lyricsAvailable: ly ? ly.available : false,
      display: VisualizerManager.display ? VisualizerManager.display() : 'vinyl',
      trackId: track && track.phoneId != null ? track.phoneId : null,
      url: track ? (track.originalUri || track.uri) : null,
      queueId: queueId, queueIndex: q ? q.index : -1, queueLength: q ? q.length : 0,
      repeat: q ? q.repeat : 'off', shuffle: q ? q.shuffle : false,
      isPlaying: Player.isPlaying(),
      currentTime: Player.getCurrentTime(),   // works for both <audio> and AVPlay
      position: +Player.getSmoothTime().toFixed(3),   // smoother: use this one for the phone's progress bar / lyrics
      duration: Player.getDuration(),
      backend: Player.getBackendName(),
      visualizer: VisualizerManager.currentName ? VisualizerManager.currentName() : null,
      visualizerId: VisualizerManager.currentId ? VisualizerManager.currentId() : null,
      title: track ? track.title : null,
      screen: ScreenManager.current()
    });
  }

  // ---------- connection lifecycle ----------

  function onLinkFailed() {
    failures++;
    setStatus('connecting');
    if (failures <= RETRIES_BEFORE_RESCAN && phone) {
      retryTimer = setTimeout(function () { connectTo(phone); }, 3000);
    } else {
      failures = 0;
      if (window.__debugLog) window.__debugLog('PhoneLink: phone unreachable — rescanning network');
      scanAndConnect({ auto: true });
    }
  }

  /** Connect to a phone that launched us: take its real name from /mbox/hello first ("Phone" otherwise). */
  function connectLaunched(p) {
    lastLaunchHost = p.host;
    // Connect at once; the phone's name (/mbox/hello) arrives in parallel — waiting for it first
    // cost up to 1.5 s on every launch.
    p.name = p.name && p.name !== 'Phone' ? p.name : p.host;
    showLaunchSplash(p.name);
    connectTo(p);
    helloName(p, function (name) { if (name) { p.name = name; if (phone && phone.host === p.host) { phone.name = name; savePhone(phone); } setSplashText('Connected to ' + name, 'Getting your song ready\u2026'); } });
  }

  // ---------- opened by the phone: splash straight away, like Spotify ----------
  // Seen in the Spotify video: one tap on the phone, the TV switches to Spotify's splash, then the song
  // continues on the TV from the same second (~30 s in total there). M-Box shows its own splash while
  // it connects and loads the song, instead of the library, and logs how long each step took.
  var splashEl = null, splashTimer = null, launchT0 = 0, launchMarks = {};
  function showLaunchSplash(name) {
    launchT0 = Date.now(); launchMarks = {};
    if (!splashEl) {
      splashEl = document.createElement('div'); splashEl.id = 'launchSplash';
      splashEl.innerHTML = '<div class="ls-disc"></div><div class="ls-brand">M-Box</div><div class="ls-line1"></div><div class="ls-line2"></div>';
      document.body.appendChild(splashEl);
    }
    splashEl.classList.add('show');
    setSplashText('Connecting to ' + (name || 'your phone') + '\u2026', '');
    clearTimeout(splashTimer);
    splashTimer = setTimeout(function () {                       // the phone never sent a song
      hideLaunchSplash('no song');
      toast(status === 'connected' ? 'Connected \u2014 pick a song on the phone' : 'Couldn\u2019t reach the phone \u2014 still trying', 'splash');
    }, 25000);
  }
  function setSplashText(a, b) {
    if (!splashEl) return;
    splashEl.querySelector('.ls-line1').textContent = a || '';
    splashEl.querySelector('.ls-line2').textContent = b || '';
  }
  function markLaunch(what) {
    if (!launchT0 || launchMarks[what]) return;
    launchMarks[what] = Date.now() - launchT0;
    if (window.__debugLog) window.__debugLog('Launch: ' + what + ' after ' + (launchMarks[what] / 1000).toFixed(1) + ' s');
    // the phone shows these in its cast debug log next to its own steps (tap -> wake -> open -> ...)
    if (status === 'connected') sendEvent('LAUNCH_TIMING', { step: what, ms: launchMarks[what], all: launchMarks });
  }
  function hideLaunchSplash(why) {
    clearTimeout(splashTimer);
    if (splashEl && splashEl.classList.contains('show')) { splashEl.classList.remove('show'); if (why) markLaunch('splash closed (' + why + ')'); }
  }
  var lastLaunchHost = null;
  /** TV_READY: what this TV can do. Sent on connect, and again when M-Box is opened again / comes
   *  back to the front while still connected — the phone then sends the song (seen on the real TV:
   *  M-Box was only in the background, its connection stayed open, and the phone sent nothing). */
  function sendTvReady(why) {
    sendEvent('TV_READY', Object.assign(tvIdentity(), {
      reason: why,
      capabilities: ['queue', 'volume', 'lyrics', 'ambient', 'spectrum', 'state-on-change', 'ping', 'handoff'],
      volume: typeof TvVolume !== 'undefined' ? TvVolume.state() : null,
      display: VisualizerManager.display ? VisualizerManager.display() : 'vinyl',
      lyricsOn: typeof LyricsView !== 'undefined' ? LyricsView.status().on : false
    }));
  }
  function checkLaunchData(why) {
    var p = launchDataPhone();
    if (!p) return;
    var differs = !phone || p.host !== phone.host || Number(p.port) !== Number(phone.port);
    if (!differs && status === 'connected') {
      // Opened again by the same phone while still connected (M-Box was in the background):
      // show the splash and say TV_READY again, so the phone sends the song now.
      if (/opened again/.test(why)) showLaunchSplash(phone.name);
      sendTvReady(why);
      pushState();
      return;
    }
    if (window.__debugLog) window.__debugLog('PhoneLink: ' + why + ' \u2014 ' + (differs ? 'new phone at ' + p.host + ':' + p.port : 'not connected') + ', connecting now');
    connectLaunched(p);
  }
  function helloName(p, cb) {
    var done = false;
    function fin(n) { if (!done) { done = true; cb(n); } }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://' + p.host + ':' + (p.port || PHONE_PORT) + '/mbox/hello', true);
      xhr.timeout = 1500;
      xhr.onload = function () { try { fin(JSON.parse(xhr.responseText).name || null); } catch (e) { fin(null); } };
      xhr.onerror = xhr.ontimeout = function () { fin(null); };
      xhr.send();
    } catch (e) { fin(null); }
    setTimeout(function () { fin(null); }, 1800);
  }

  function launchDataPhone() {
    var ip = appControlValue('senderIp');
    var port = appControlValue('port');
    if (!ip) {                                         // Samsung deep link: data arrives as PAYLOAD (JSON or "a=b&c=d")
      var raw = appControlValue('PAYLOAD') || appControlValue('payload') || appControlValue('metaTag');
      if (raw) {
        try { var j = JSON.parse(raw); if (j && j.values) j = typeof j.values === 'string' ? JSON.parse(j.values) : j.values;
              ip = j.senderIp || j.ip; port = j.port || port; } catch (e) {
          var m1 = /senderIp=([\d.]+)/.exec(raw), m2 = /port=(\d+)/.exec(raw);
          ip = m1 && m1[1]; port = (m2 && m2[1]) || port;
        }
      }
      if (ip && !port) port = PHONE_PORT;
      if (ip && window.__debugLog) window.__debugLog('PhoneLink: launched by the phone at ' + ip + ':' + port);
    }
    if (!ip || !port) return null;
    return { host: ip, port: Number(port), name: 'Phone', wsPath: DEFAULT_WS_PATH };
  }

  function appControlValue(key) {
    if (typeof tizen === 'undefined' || !tizen.application) return null;
    try {
      var req = tizen.application.getCurrentApplication().getRequestedAppControl();
      var data = req && req.appControl && req.appControl.data;
      if (!data) return null;
      for (var i = 0; i < data.length; i++) {
        if (data[i] && data[i].key === key) {
          var v = data[i].value;
          return Array.isArray(v) ? v[0] : v;
        }
      }
    } catch (e) {}
    return null;
  }

  function savedPhone() {
    var host = localStorage.getItem(KEY_HOST);
    if (!host) return null;
    return {
      host: host,
      port: parseInt(localStorage.getItem(KEY_PORT), 10) || PHONE_PORT,
      name: localStorage.getItem(KEY_NAME) || host,
      wsPath: localStorage.getItem(KEY_PATH) || DEFAULT_WS_PATH
    };
  }

  function savePhone(p) {
    localStorage.setItem(KEY_HOST, p.host);
    localStorage.setItem(KEY_PORT, String(p.port));
    localStorage.setItem(KEY_NAME, p.name);
    localStorage.setItem(KEY_PATH, p.wsPath);
  }

  function closeSocket() {
    if (!ws) return;
    var old = ws;
    ws = null;
    try { old.onclose = null; old.close(); } catch (e) {}
  }

  /**
   * 1. Heartbeat. A phone that vanishes without closing the connection (app
   * killed, Wi-Fi off, phone asleep) can leave the socket looking open for
   * minutes. Every 10 s the TV asks the phone's /mbox/hello; two misses in a
   * row = gone: close the socket, so the normal retry -> rescan path runs.
   */
  var heartbeatTimer = null, heartbeatMisses = 0, notFoundSince = 0;
  function startHeartbeat(sock) {
    stopHeartbeat();
    heartbeatMisses = 0;
    heartbeatTimer = setInterval(function () {
      if (ws !== sock || !phone) { stopHeartbeat(); return; }
      var p = phone, done = false;
      function result(ok) {
        if (done) return; done = true;
        if (ws !== sock) return;
        if (ok) { heartbeatMisses = 0; return; }
        heartbeatMisses++;
        if (heartbeatMisses >= 2) {
          if (window.__debugLog) window.__debugLog('PhoneLink: phone stopped answering (2 missed checks) \u2014 reconnecting');
          stopHeartbeat();
          try { sock.close(); } catch (e) {}
          // a half-open socket may never fire onclose: force the reconnect path
          setTimeout(function () { if (ws === sock) { ws = null; if (stateTimer) { clearInterval(stateTimer); stateTimer = null; } if (wasConnected && !lostShown) { lostShown = true; wasConnected = false; toast('Lost connection to phone \u2014 reconnecting\u2026', 'lost'); } onLinkFailed(); } }, 1500);
        }
      }
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'http://' + p.host + ':' + p.port + '/mbox/hello', true);
        xhr.timeout = 3000;
        xhr.onload = function () { result(xhr.status === 200); };
        xhr.onerror = xhr.ontimeout = function () { result(false); };
        xhr.send();
      } catch (e) { result(false); }
    }, 10000);
  }
  function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

  /** 3. Not connected and something changed (TV network back, app back on screen): try right away. */
  function reconnectNow(why) {
    if (status === 'connected' || status === 'connecting') return;
    if (window.__debugLog) window.__debugLog('PhoneLink: ' + why + ' \u2014 looking for the phone now');
    var saved = savedPhone();
    failures = 0;
    if (saved) connectTo(saved); else scanAndConnect({ auto: true });
  }

  function clearTimers() {
    stopHeartbeat();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null; }
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (stateTimer) { clearInterval(stateTimer); stateTimer = null; }
  }

  function setStatus(s) { status = s; notify(); }

  /** Small 3 s status message on every screen (Now Playing included). The
   *  same message isn't repeated within 15 s (reconnect retries every 3 s). */
  var wasConnected = false, lostShown = false, toastEl = null, toastTimer = null, lastToast = { key: null, at: 0 };
  function toast(text, key) {
    var now = Date.now();
    if (splashEl && splashEl.classList.contains('show') && /^(connect|connecting)/.test(String(key || ''))) return;   // the splash already says it
    if (key && lastToast.key === key && now - lastToast.at < 15000) return;
    lastToast = { key: key, at: now };
    if (window.__debugLog) window.__debugLog('Toast: ' + text);
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'mboxToast';
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:9998;padding:14px 28px;' +
        'border-radius:28px;background:rgba(20,20,24,.88);color:#fff;font:500 24px/1.3 sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);' +
        'pointer-events:none;transition:opacity .3s;opacity:0;max-width:70%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, 3000);
  }
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  return {
    init: init,
    scanAndConnect: scanAndConnect,
    connectTo: connectTo,
    setConfig: setConfig,
    getConfig: getConfig,
    getStatus: getStatus,
    getPhone: getPhone,
    getFoundPhones: getFoundPhones,
    onChange: onChange,
    getRecentMessages: function () { return recent.slice(); },
    phoneSupports: phoneSupports,
    sendEvent: sendEvent
  };
})();
