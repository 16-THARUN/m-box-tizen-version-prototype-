/**
 * visualizerManager.js
 *
 * Owns the canvas render loop and the visualizer selection. Every visualizer
 * in VisualizerRegistry is { id, name, category, draw(ctx, w, h, freq, time, t, vinylRect) }
 * with freq/time = Uint8Array(512) (same shape as a Web Audio AnalyserNode).
 * The registry order matches the phone app's visualizer list.
 *
 * Where the audio data comes from (one source of truth, shared with the phone):
 *   - <audio> backend: the TV analyses the audio itself (AudioEngine) AND
 *     streams compact frames to the phone (VIS_FRAME, ~20 fps) so the phone's
 *     visualizer moves with what the TV is playing.
 *   - AVPlay backend (Dolby / 24-bit FLAC): no audio reaches the app, so the
 *     TV draws from frames the PHONE sends (VIS_FRAME). If none arrive, it
 *     shows a calm non-reactive animation instead of a dead analyser.
 * Selection syncs both ways: SET_VISUALIZER from the phone, VISUALIZER_CHANGED to it.
 */
var VisualizerManager = (function () {
  var canvas, ctx;
  var currentIndex = 0;
  var startTime = performance.now();
  var rafId = null;
  var running = false;
  var STORE_KEY = 'mbox_vis_id';
  var DEFAULT_ID = 'circular-spectrum';
  var BINS = 512;
  // Drawing size: the canvas is drawn at renderScale x the screen size and stretched to fill it.
  // A visualizer that can't hold ~60 fps on the TV drops to 0.75, then 0.5 (remembered per visualizer).
  var cssW = 1920, cssH = 1080, renderScale = 1, scaleFor = {};

  function init() {
    canvas = document.getElementById('visCanvas');
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
    var idx = findIndex(saved) ; if (idx < 0) idx = findIndex(DEFAULT_ID);
    currentIndex = idx < 0 ? 0 : idx;
    buildSwitcherList();
    updateLabel();
    setInterval(sendFrameToPhone, 50);   // 20 fps outbound analysis (cheap; only while relevant)
    // Render loop is NOT started here — it only runs while Now Playing is visible.
  }

  function start() { if (running) return; running = true; loop(); }
  function stop() { running = false; if (rafId) cancelAnimationFrame(rafId); rafId = null; }

  function resize() {
    // PC browser with fitScreen.js: the page is always 1920x1080, scaled to the window.
    if (window.__fit || (typeof tizen === 'undefined' && document.body && /scale\(/.test(document.body.style.transform))) { cssW = 1920; cssH = 1080; }
    else { cssW = window.innerWidth || 1920; cssH = window.innerHeight || 1080; }
    applyScale(); vinylCache = null;
  }
  function applyScale() { canvas.width = Math.round(cssW * renderScale); canvas.height = Math.round(cssH * renderScale); }

  // ---------- data sources ----------

  var remoteFreq = new Uint8Array(BINS), remoteTime = new Uint8Array(BINS).fill(128), remoteAt = -1e9;   // "never" (0 would look fresh during the first seconds after start)
  // What the visualizers draw: remoteFreq/remoteTime are the TARGET (the music data, 20 fps);
  // outFreq/outTime follow it every screen frame -- quick rise, softer fall -- so the bars
  // move smoothly at 60 fps instead of jumping 20 times a second.
  var outFreq = new Float32Array(BINS), outTime = new Float32Array(BINS).fill(128);
  function smoothOut(dt) {
    var up = 1 - Math.exp(-dt / 0.022), down = 1 - Math.exp(-dt / 0.10), wv = 1 - Math.exp(-dt / 0.03);
    for (var i = 0; i < BINS; i++) {
      var d = remoteFreq[i] - outFreq[i];
      outFreq[i] += d * (d > 0 ? up : down);
      outTime[i] += (remoteTime[i] - outTime[i]) * wv;
    }
  }
  // Phone frames can arrive in bursts with gaps (seen on the real TV). Stay
  // in "from phone" mode until frames have been missing for 2.5 s, and fade
  // the last frame smoothly during short gaps instead of flipping to the calm
  // animation and back every half-second.
  var REMOTE_FRESH_MS = 2500;
  var DECAY_AFTER_MS = 120;

  /** Frames from the phone: bands (e.g. 64 values, 0..255 or 0..1, low->high)
   *  and wave (e.g. 64 samples, 0..255 centred on 128, or -1..1). Expanded to
   *  the 512-bin shape every visualizer already expects. */
  var remoteSource = 'phone', tvFrameAt = -1e9;
  function setRemoteFrame(bands, wave, source, t, trackId) {
    source = source || 'phone';
    if (source === 'phone' && timeline) return;              // a synced source (phone spectrum / TV analysis) wins
    if (source === 'phone' && trackId != null && curTrack && curTrack.phoneId != null && String(trackId) !== String(curTrack.phoneId)) { noteMismatch('another song'); return; }
    if (source === 'phone' && t != null && !isNaN(Number(t))) { bufferTimedFrame(Number(t), bands, wave); return; }
    if (source === 'phone') {
      // Untimed live frames: ignored when a synced source exists, and while the
      // TV isn't playing (they come from the phone's clock, not the TV's).
      if (timeline || timedFrames.length) return;
      if (typeof Player !== 'undefined' && !Player.isPlaying()) { remoteAt = performance.now(); remoteSource = 'phone'; return; }
    }
    if (source === 'phone' && performance.now() - tvFrameAt < 500) return;   // the TV's own spectrum wins (exact sync)
    if (source === 'tv') tvFrameAt = performance.now();
    remoteSource = source;
    setRemoteFrameRaw(bands, wave);
    remoteAt = performance.now();
  }
  function setRemoteFrameRaw(bands, wave, knownScale) {
    var scale = knownScale || 1;
    if (bands && bands.length) {
      if (!knownScale) { var bmax = 0; for (var i = 0; i < bands.length; i++) if (bands[i] > bmax) bmax = bands[i]; scale = bmax <= 1.0001 ? 255 : 1; }
      var span = BINS * 0.7, n = bands.length;
      for (var b = 0; b < BINS; b++) {
        var pos = (b / span) * (n - 1);
        var v;
        if (pos >= n - 1) v = bands[n - 1] * Math.max(0, 1 - (pos - (n - 1)) / (n * 0.5));
        else { var i0 = Math.floor(pos), f = pos - i0; v = bands[i0] * (1 - f) + bands[i0 + 1] * f; }
        remoteFreq[b] = Math.max(0, Math.min(255, v * scale));
      }
    }
    if (wave && wave.length) {
      var neg = false; for (var k = 0; k < wave.length; k++) if (wave[k] < 0) { neg = true; break; }
      var m = wave.length;
      for (var j = 0; j < BINS; j++) {
        var p = (j / (BINS - 1)) * (m - 1), j0 = Math.floor(p), fr = p - j0;
        var w = j0 >= m - 1 ? wave[m - 1] : wave[j0] * (1 - fr) + wave[j0 + 1] * fr;
        remoteTime[j] = Math.max(0, Math.min(255, neg || Math.abs(w) <= 1.0001 ? (w + 1) * 127.5 : w));
      }
    } else if (bands && bands.length) {
      // No waveform (TV analysis / phone spectrum only gives bands): build one from the
      // bands, so the waveform visualizers (Liquid Spline, Plain Oscilloscope) move too.
      var ph = performance.now() / 1000, nb2 = bands.length, comps = 8, peak = 0;
      var amps = [], freqs = [], phases = [];
      for (var cI = 0; cI < comps; cI++) {
        var bi = Math.min(nb2 - 1, Math.floor(cI / comps * nb2 * 0.6));
        var av = scale === 1 ? bands[bi] / 255 : bands[bi];
        amps.push(av * (1 - cI * 0.08)); freqs.push(2 + cI * 3); phases.push(ph * (1.3 + cI * 0.9));
        peak += amps[cI];
      }
      var norm = peak > 0 ? Math.min(1, peak / 2.2) / peak : 0;
      for (var q = 0; q < BINS; q++) {
        var v3 = 0, x3 = q / BINS * Math.PI * 2;
        for (var cJ = 0; cJ < comps; cJ++) v3 += amps[cJ] * Math.sin(x3 * freqs[cJ] + phases[cJ]);
        remoteTime[q] = Math.max(0, Math.min(255, 128 + v3 * norm * 110));
      }
    }
  }
  function remoteFresh() { return timeline || timedFresh() || performance.now() - remoteAt < REMOTE_FRESH_MS; }

  // ---------- synced sources for AVPlay songs ----------
  // Live frames from the phone come from the phone's own clock and arrive in
  // bursts over Wi-Fi, so they can't line up with what the TV plays (seen on
  // the real TV: bars jumping, then freezing, even while the TV was paused).
  // Two synced sources, both drawn at the TV's own playback position:
  //  1. Spectrum timeline: GET <song url>/spectrum ->
  //       {"fps":20,"bands":32,"data":"<base64, frames*bands bytes 0..255>"}
  //     (or "frames": [[..32 values..], ...]). Exact sync, no network jitter.
  //  2. VIS_FRAME with "t" (the song position the frame belongs to): buffered
  //     and drawn when the TV reaches that position.
  // Neither: the old live frames, but only while the TV is actually playing.
  var timeline = null, timelineFor = null, timedFrames = [], timedAt = -1e9;
  var curTrack = null, analysisJob = null, analysisTried = false, spectrumChecked = false, mismatchLogged = 0;
  function isFlacTrack(t) {
    return !!t && (t.realContainer === 'FLAC' || /flac/i.test(String(t.codec || '') + ' ' + String(t.mimeType || '') + ' ' + String(t.originalUri || t.uri || '')));
  }
  /** AVPlay song, no synced spectrum from the phone: the TV analyses the FLAC itself. */
  function maybeStartAnalysis() {
    if (analysisTried || timeline || !spectrumChecked || !curTrack || !curTrack.isPhoneStream || !isFlacTrack(curTrack)) return;
    if (typeof TvAnalysis === 'undefined') return;
    analysisTried = true;
    var key = timelineFor;
    analysisJob = TvAnalysis.start(curTrack.originalUri || curTrack.uri, function (tl) {
      if (timelineFor !== key) return;
      timeline = tl; timedFrames = []; lastLabelMode = '';
    }, log);
  }
  function noteMismatch(why) {
    var now = performance.now();
    if (now - mismatchLogged > 10000) { mismatchLogged = now; log('Visualizer: ignoring phone frames (' + why + ') \u2014 they are not for what the TV is playing'); }
  }
  function setTrack(track) {
    var key = track && (track.originalUri || track.uri);
    curTrack = track || null;
    if (key === timelineFor) return;
    if (analysisJob) { try { analysisJob.stop(); } catch (e) {} analysisJob = null; }
    analysisTried = false; spectrumChecked = false;
    timelineFor = key; timeline = null; timedFrames = []; timedAt = -1e9;
    for (var i = 0; i < BINS; i++) { remoteFreq[i] = 0; remoteTime[i] = 128; outFreq[i] = 0; outTime[i] = 128; }
    lastLabelMode = '';
    if (!track || !track.isPhoneStream || !key) return;
    var parts = String(key).split('?');
    var url = parts[0] + '/spectrum' + (parts[1] ? '?' + parts[1] : '');
    // The phone may still be computing the spectrum (404 / 202 / slow): ask again after 5 s
    // and 15 s. Meanwhile FLAC songs use the TV's own analysis; a phone spectrum that
    // arrives later is used only if nothing synced is there yet (e.g. Dolby).
    var RETRY_AT = [5000, 15000];
    function attempt(n) {
      if (timelineFor !== key) return;
      function retryOrGiveUp(what) {
        spectrumChecked = true;
        if (n < RETRY_AT.length) {
          log('Visualizer: no synced spectrum from the phone yet (' + what + ') \u2014 asking again in ' + RETRY_AT[n] / 1000 + ' s');
          setTimeout(function () { attempt(n + 1); }, n === 0 ? RETRY_AT[0] : RETRY_AT[n] - RETRY_AT[n - 1]);
        } else log('Visualizer: no synced spectrum from the phone (' + what + ', after ' + (n + 1) + ' tries)');
      }
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = 8000;
        xhr.onload = function () {
          if (timelineFor !== key) return;
          if (xhr.status !== 200) { retryOrGiveUp('HTTP ' + xhr.status); return; }
          spectrumChecked = true;
          try {
            var j = JSON.parse(xhr.responseText), fps = Number(j.fps) || 20, nb = Number(j.bands) || 32, frames;
            if (j.data) {
              var bin = atob(j.data); frames = new Uint8Array(bin.length);
              for (var k = 0; k < bin.length; k++) frames[k] = bin.charCodeAt(k);
            } else if (j.frames) {
              nb = j.frames[0].length; frames = new Uint8Array(j.frames.length * nb);
              for (var f = 0; f < j.frames.length; f++) for (var b = 0; b < nb; b++) frames[f * nb + b] = j.frames[f][b] > 1.0001 ? j.frames[f][b] : j.frames[f][b] * 255;
            }
            if (!frames || frames.length < nb) throw new Error('empty');
            if (timeline && n > 0) { log('Visualizer: phone spectrum arrived (try ' + (n + 1) + '), keeping the TV\u2019s own analysis'); return; }
            timeline = { fps: fps, bands: nb, frames: frames, count: Math.floor(frames.length / nb), row: new Array(nb), source: 'phone' };
            timedFrames = []; lastLabelMode = '';
            log('Visualizer: synced spectrum loaded (' + timeline.count + ' frames, ' + fps + ' fps, ' + nb + ' bands' + (n ? ', try ' + (n + 1) : '') + ')');
          } catch (e) { log('Visualizer: phone spectrum unreadable (' + e.message + ')'); }
        };
        xhr.onerror = function () { if (timelineFor === key) retryOrGiveUp('network error'); };
        xhr.ontimeout = function () { if (timelineFor === key) retryOrGiveUp('timed out'); };
        xhr.send();
      } catch (e) {}
    }
    attempt(0);
  }
  function bufferTimedFrame(t, bands, wave) {
    // Frames stamped with the PHONE's own position (seen on the real TV: the
    // phone sent frames for its local player while the TV played another song
    // or another part) can't be shown in sync: keep only frames near the TV's position.
    var pos = typeof Player !== 'undefined' ? Player.getCurrentTime() : t;
    if (t < pos - 3 || t > pos + 10) { noteMismatch('their time ' + t.toFixed(1) + ' s, TV at ' + pos.toFixed(1) + ' s'); return; }
    timedFrames.push({ t: t, bands: bands, wave: wave });
    if (timedFrames.length > 200) timedFrames.splice(0, timedFrames.length - 200);
    timedAt = performance.now();
    remoteSource = 'phone';
  }
  function timedFresh() {
    if (!timedFrames.length) return false;
    if (performance.now() - timedAt < REMOTE_FRESH_MS) return true;
    var pos = typeof Player !== 'undefined' ? Player.getCurrentTime() : 0;      // frames sent ahead still cover the TV's position
    return timedFrames[timedFrames.length - 1].t >= pos - 0.5;
  }
  /** Fill remoteFreq/remoteTime for the TV's current position. Returns false when nothing matches. */
  var lastDrawnPos = -1;
  function syncedFrameAt(pos) {
    if (timeline) {
      // Frame k covers [k, k+1)/fps; blend the two frames around the position (frame centres),
      // so the 20 fps data becomes a smooth 60 fps movement without moving it in time.
      var x = pos * timeline.fps - 0.5, i0 = Math.floor(x), f = x - i0;
      if (pos < 0 || Math.floor(pos * timeline.fps) >= timeline.count) return false;
      if (i0 < 0) { i0 = 0; f = 0; }
      var i1 = Math.min(timeline.count - 1, i0 + 1), nb = timeline.bands, o0 = i0 * nb, o1 = i1 * nb;
      for (var b = 0; b < nb; b++) timeline.row[b] = timeline.frames[o0 + b] * (1 - f) + timeline.frames[o1 + b] * f;
      fillFromBands(timeline.row, null, 1);            // 0..255 values (no guessing: quiet parts stay quiet)
      return true;
    }
    if (timedFrames.length) {
      while (timedFrames.length > 1 && timedFrames[0].t < pos - 2) timedFrames.shift();
      var a = null, c = null;
      for (var i = 0; i < timedFrames.length; i++) {
        var fr = timedFrames[i];
        if (fr.t <= pos && (!a || fr.t > a.t)) a = fr;
        if (fr.t > pos && (!c || fr.t < c.t)) c = fr;
      }
      if (a && c && pos - a.t < 0.3 && c.t - pos < 0.3 && c.t > a.t && a.bands && c.bands && a.bands.length === c.bands.length) {
        var k = (pos - a.t) / (c.t - a.t);
        fillFromBands(blend(a.bands, c.bands, k, blendB), a.wave && c.wave && a.wave.length === c.wave.length ? blend(a.wave, c.wave, k, blendW) : (a.wave || c.wave));
        return true;
      }
      var best = a && pos - a.t < 0.3 ? a : c && c.t - pos < 0.3 ? c : null;
      if (best) { fillFromBands(best.bands, best.wave); return true; }
    }
    return false;
  }
  var blendB = [], blendW = [];
  function blend(p, q, k, out) { out.length = p.length; for (var i = 0; i < p.length; i++) out[i] = p[i] * (1 - k) + q[i] * k; return out; }
  /** The player reports its position only every few hundred ms on the TV (AVPlay), so the
   *  position used for drawing runs on the screen's clock and is gently pulled towards
   *  each new report (a jump over 0.35 s, e.g. a seek, is taken at once). */
  var clk = { pos: 0, at: 0, raw: NaN, rawAt: 0, key: null };
  function mediaPos() {
    var raw = Player.getCurrentTime(), now = performance.now();
    if (raw !== clk.raw) { clk.raw = raw; clk.rawAt = now; }
    if (!Player.isPlaying() || !clk.at || clk.key !== timelineFor) { clk.pos = raw; clk.at = now; clk.key = timelineFor; return raw; }
    var dt = Math.min(0.1, (now - clk.at) / 1000); clk.at = now;
    var est = clk.raw + Math.min(0.75, (now - clk.rawAt) / 1000);
    var pred = clk.pos + dt, err = est - pred;
    clk.pos = Math.abs(err) > 0.35 ? est : pred + err * Math.min(1, dt * 5);
    return clk.pos;
  }
  function fillFromBands(bands, wave, knownScale) {
    var at = remoteAt; setRemoteFrameRaw(bands, wave, knownScale); remoteAt = at;
  }
  function log(m) { if (window.__debugLog) window.__debugLog(m); }
  function decayRemote() {
    for (var i = 0; i < BINS; i++) {
      remoteFreq[i] = remoteFreq[i] * 0.9;
      remoteTime[i] = 128 + (remoteTime[i] - 128) * 0.85;
    }
  }

  /** Compact frame of the TV's own analysis, for the phone. */
  var lastSentAt = 0;
  function sendFrameToPhone() {
    if (externalDecoder) return;                                   // AVPlay: nothing to analyse here
    if (typeof RemoteBridge === 'undefined' || RemoteBridge.getStatus() !== 'connected') return;
    if (typeof Player === 'undefined' || !Player.isPlaying() || !Player.currentTrack() || Player.currentTrack().isDemo) return;
    var freq = AudioEngine.getFrequencyData(), time = AudioEngine.getTimeDomainData();
    var bands = new Array(64), wave = new Array(64), per = Math.floor((BINS * 0.7) / 64);
    for (var i = 0; i < 64; i++) {
      var sum = 0; for (var k = 0; k < per; k++) sum += freq[i * per + k] || 0;
      bands[i] = Math.round(sum / per);
      wave[i] = time[i * 8] || 128;
    }
    RemoteBridge.sendEvent('VIS_FRAME', { bands: bands, wave: wave, t: +Player.getCurrentTime().toFixed(2) });
    lastSentAt = performance.now();
  }

  // ---------- render loop ----------

  var lastLabelMode = '';
  var lastFrameAt = 0;
  function loop() {
    if (!running) return;
    var t0 = performance.now(), dt = lastFrameAt ? Math.min(0.1, (t0 - lastFrameAt) / 1000) : 1 / 60;
    lastFrameAt = t0;
    var w = cssW, h = cssH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);     // visualizers keep drawing in screen pixels
    var t = (t0 - startTime) / 1000;
    var vinylRect = getVinylRect();
    var vis = VisualizerRegistry[currentIndex];
    var mode;

    if (vis && (vis.off || vis.ambient)) {
      mode = 'off';                                               // "Normal (Off)" / "Ambient Cover": draw nothing
    } else if (!externalDecoder) {
      mode = 'tv';
      if (vis) vis.draw(ctx, w, h, AudioEngine.getFrequencyData(), AudioEngine.getTimeDomainData(), t, vinylRect);
      if (vis && vis.backdrop) drawScrim(ctx, w, h, vinylRect);
    } else if ((maybeStartAnalysis(), remoteFresh())) {
      var playingNow = typeof Player !== 'undefined' && Player.isPlaying();
      var synced = (timeline || timedFrames.length) ? 'synced' : 'live';
      mode = 'remote-' + remoteSource + '-' + synced;   // label must change when the source does
      if (!playingNow) decayRemote();                  // TV paused/loading: bars settle, never move on their own
      else if (synced === 'synced') { if (!syncedFrameAt(mediaPos())) decayRemote(); }
      else if (performance.now() - remoteAt > DECAY_AFTER_MS) decayRemote();
      smoothOut(dt);
      if (vis) vis.draw(ctx, w, h, outFreq, outTime, t, vinylRect);
      if (vis && vis.backdrop) drawScrim(ctx, w, h, vinylRect);
    } else {
      mode = 'calm';
      // no music data for this song (e.g. Dolby): a video-background visualizer still shows its clip, gently
      if (vis && vis.backdrop && typeof VideoBackdrop !== 'undefined') VideoBackdrop.draw(ctx, w, h, vis.backdrop, 0.25, 0.45);
      drawExternalDecoder(ctx, t, vinylRect);
    }
    if (mode !== lastLabelMode) { lastLabelMode = mode; updateLabel(); }
    measure(t0, performance.now(), mode, vis);
    rafId = requestAnimationFrame(loop);
  }

  /** Phone spec: video styles get a dark shading behind the title, times and controls. */
  function drawScrim(c, w, h, v) {
    var top = v && v.maxR < 1e8 ? v.y + v.radius + Math.max(0, v.maxR - v.radius) * 0.6 : h * 0.55;
    var g = c.createLinearGradient(0, top, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.3, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0.7)');
    c.fillStyle = g; c.fillRect(0, top, w, h - top);
  }

  // ---------- frame rate: measured on the TV, shown next to the debug log ----------
  var meter = { since: 0, n: 0, work: 0, low: 0, logged: 0 }, fpsEl = null, lastFps = 0;
  function measure(t0, t1, mode, vis) {
    if (!meter.since) { meter.since = t0; meter.n = 0; meter.work = 0; return; }
    meter.n++; meter.work += t1 - t0;
    var span = t1 - meter.since;
    if (span < 1000) return;
    var fps = meter.n * 1000 / span, ms = meter.work / meter.n;
    meter.since = t1; meter.n = 0; meter.work = 0; lastFps = fps;
    showFps(fps, ms);
    if (mode === 'off' || mode === 'calm' || !vis) { meter.low = 0; return; }
    // Below ~50 fps for 3 s in a row: draw this visualizer at a lower resolution.
    meter.low = fps < 50 ? meter.low + 1 : 0;
    if (meter.low >= 3 && renderScale > 0.5) {
      renderScale = renderScale > 0.8 ? 0.75 : 0.5; scaleFor[vis.id] = renderScale; applyScale(); meter.low = 0;
      log('Visualizer: ' + vis.name + ' ran at ' + Math.round(fps) + ' fps (' + ms.toFixed(1) + ' ms a frame) \u2014 now drawn at ' + Math.round(renderScale * 100) + '% resolution');
    }
    if (t1 - meter.logged > 30000) { meter.logged = t1; log('Visualizer: ' + vis.name + ' ' + Math.round(fps) + ' fps, ' + ms.toFixed(1) + ' ms a frame' + (renderScale < 1 ? ', ' + Math.round(renderScale * 100) + '% resolution' : '')); }
  }
  function showFps(fps, ms) {
    var dbg = document.getElementById('keyDebug');
    if (!dbg || dbg.style.display === 'none') { if (fpsEl) fpsEl.style.display = 'none'; return; }   // release: no FPS readout
    if (!fpsEl) {
      fpsEl = document.createElement('div'); fpsEl.id = 'visFps';
      fpsEl.style.cssText = 'position:absolute;right:var(--safe,48px);top:var(--safe-v,32px);font:16px monospace;color:#7CFF7C;opacity:.8;z-index:5;pointer-events:none';
      var host = document.getElementById('visLabel'); (host && host.parentNode || document.body).appendChild(fpsEl);
    }
    fpsEl.style.display = dbg && dbg.offsetParent !== null ? '' : 'none';     // only while the debug log is on screen
    fpsEl.textContent = Math.round(fps) + ' fps \u00b7 ' + ms.toFixed(1) + ' ms' + (renderScale < 1 ? ' \u00b7 ' + Math.round(renderScale * 100) + '%' : '');
  }

  // The vinyl spins, so its bounding box grows and shrinks (up to 1.41x) as it turns; the radius
  // comes from its real (unrotated) size. Read twice a second, not on every frame.
  var vinylCache = null, vinylAt = 0;
  function getVinylRect() {
    var now = performance.now();
    if (vinylCache && now - vinylAt < 500) return vinylCache;
    vinylAt = now;
    var vinyl = document.getElementById('vinyl');
    if (!vinyl) {
      var fallback = Math.min(cssW, cssH) * 0.11;
      return (vinylCache = { x: cssW / 2, y: cssH / 2, radius: fallback });
    }
    var rect = vinyl.getBoundingClientRect(), r = (vinyl.offsetWidth || rect.width) / 2;
    var fz = window.__fit, un = function (v, off) { return fz ? (v - off) / fz.s : v; };   // PC browser: page is scaled to fit
    var cx = un(rect.left + rect.width / 2, fz && fz.ox), cy = un(rect.top + rect.height / 2, fz && fz.oy);
    // How far a ring may reach: above the title block, and below the top label (phone: never over
    // the title, top bar, progress bar or controls).
    var info = document.querySelector('#nowPlaying .track-info'), maxR = 1e9;
    if (info) { var ir = info.getBoundingClientRect(); var irTop = un(ir.top, fz && fz.oy); if (ir.height && irTop > cy) maxR = Math.min(maxR, irTop - cy - 14); }
    maxR = Math.min(maxR, cy - 64);
    return (vinylCache = { x: cx, y: cy, radius: r, maxR: maxR });
  }

  // ---------- selection (synced with the phone) ----------

  function current() { return VisualizerRegistry[currentIndex]; }
  function normKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function findIndex(key) {
    var k = normKey(key);
    if (!k) return -1;
    for (var i = 0; i < VisualizerRegistry.length; i++) {
      var v = VisualizerRegistry[i];
      if (normKey(v.id) === k || normKey(v.name) === k) return i;
      if (v.aliases && v.aliases.some(function (a) { return normKey(a) === k; })) return i;
    }
    return -1;
  }

  function apply(i, fromPhone) {
    currentIndex = (i + VisualizerRegistry.length) % VisualizerRegistry.length;
    if (!current().ambient) lastNonAmbient = current().id;
    applyDisplay();
    var want = scaleFor[current().id] || 1;
    if (want !== renderScale && canvas) { renderScale = want; applyScale(); }
    meter.since = 0; meter.low = 0;
    try { localStorage.setItem(STORE_KEY, current().id); } catch (e) {}
    updateLabel();
    highlightSwitcherItem();
    if (!fromPhone && typeof RemoteBridge !== 'undefined') {
      RemoteBridge.sendEvent('VISUALIZER_CHANGED', { id: current().id, name: current().name, index: currentIndex });
    }
  }
  /** "Ambient Cover" switches Now Playing to the calm layout; anything else back to the vinyl. */
  function applyDisplay() { if (typeof AmbientView !== 'undefined') AmbientView.setActive(!!(current() && current().ambient)); }
  var lastNonAmbient = null;
  /** SET_DISPLAY from the phone: "ambient" or "vinyl" (back to the last visualizer used). */
  function setDisplay(mode, fromPhone) {
    if (String(mode).toLowerCase() === 'ambient') { var i = findIndex('ambient-cover'); if (i >= 0) apply(i, !!fromPhone); }
    else if (current() && current().ambient) { var j = findIndex(lastNonAmbient || DEFAULT_ID); apply(j >= 0 ? j : 0, !!fromPhone); }
  }
  function next() { apply(currentIndex + 1, false); }
  function prev() { apply(currentIndex - 1, false); }
  function selectIndex(i) { apply(i, false); }
  /** From the phone: by id/name (preferred) or index. Returns the visualizer or null. */
  function selectBy(key, index, fromPhone) {
    var i = findIndex(key);
    if (i < 0 && index != null && !isNaN(Number(index)) && Number(index) >= 0 && Number(index) < VisualizerRegistry.length) i = Number(index);
    if (i < 0) return null;
    apply(i, !!fromPhone);
    return current();
  }

  function updateLabel() {
    var label = document.getElementById('visLabel');
    if (!label) return;
    var v = current();
    var name = v ? v.name : '';
    if (externalDecoder && !(v && (v.off || v.ambient))) {
      label.classList.add('vis-label--dolby');
      label.textContent = remoteFresh() ? name + (timeline ? (timeline.source === 'tv' ? ' \u00b7 synced (TV)' : ' \u00b7 synced') : timedFrames.length ? ' \u00b7 synced (phone)' : remoteSource === 'tv' ? ' \u00b7 TV analysis' : ' \u00b7 from phone') : externalLabel;
      return;
    }
    label.classList.remove('vis-label--dolby');
    label.textContent = name;
  }

  // ---------- external decoder mode (AVPlay) ----------

  var externalDecoder = false;
  var externalLabel = 'Dolby \u00b7 sent to soundbar';
  function setExternalDecoder(on, label) {
    on = !!on;
    if (label) externalLabel = label;
    if (on === externalDecoder && !label) return;
    externalDecoder = on;
    lastLabelMode = '';
    updateLabel();
  }

  /** Slow "breathing" rings around the vinyl + a gently orbiting arc. */
  function drawExternalDecoder(c, t, v) {
    c.save();
    c.translate(v.x, v.y);
    for (var i = 0; i < 4; i++) {
      var phase = (t * 0.25 + i / 4) % 1;
      c.globalAlpha = 0.28 * (1 - phase);
      c.strokeStyle = '#ff6a1a';
      c.lineWidth = 2;
      c.beginPath(); c.arc(0, 0, v.radius * (1.08 + phase * 0.6), 0, Math.PI * 2); c.stroke();
    }
    var a = t * 0.6;
    c.globalAlpha = 0.55; c.lineWidth = 3; c.lineCap = 'round';
    c.beginPath(); c.arc(0, 0, v.radius * 1.12, a, a + Math.PI * 0.35); c.stroke();
    c.beginPath(); c.arc(0, 0, v.radius * 1.12, a + Math.PI, a + Math.PI * 1.35); c.stroke();
    c.restore();
  }

  // ---------- switcher overlay ----------

  function buildSwitcherList() {
    var list = document.getElementById('visList');
    list.innerHTML = '';
    VisualizerRegistry.forEach(function (vis, i) {
      var item = document.createElement('div');
      item.className = 'vis-item';
      item.dataset.focusable = 'vis-' + i;
      item.tabIndex = 0;
      item.innerHTML = '<div class="vis-item-name">' + vis.name + '</div><div class="vis-item-cat">' + vis.category + '</div>';
      list.appendChild(item);
    });
    highlightSwitcherItem();
  }
  function highlightSwitcherItem() {
    var items = document.querySelectorAll('.vis-item');
    items.forEach(function (el, i) { el.classList.toggle('focused', i === currentIndex); });
  }

  return {
    init: init, start: start, stop: stop,
    next: next, prev: prev, selectIndex: selectIndex, selectBy: selectBy,
    currentIndex: function () { return currentIndex; },
    currentName: function () { return current() ? current().name : null; },
    currentId: function () { return current() ? current().id : null; },
    setRemoteFrame: setRemoteFrame, setTrack: setTrack,
    syncInfo: function () { var s = 0; for (var i = 0; i < 64; i++) s += remoteFreq[i]; return { timeline: timeline ? timeline.count : 0, source: timeline ? timeline.source : null, timed: timedFrames.length, level: Math.round(s / 64), out: (function () { var o = 0; for (var i = 0; i < 64; i++) o += outFreq[i]; return +(o / 64).toFixed(2); })() }; },
    isUsingPhoneFrames: function () { return externalDecoder && remoteFresh(); },
    setExternalDecoder: setExternalDecoder,
    isExternalDecoder: function () { return externalDecoder; },
    count: function () { return VisualizerRegistry.length; },
    applyDisplay: applyDisplay, setDisplay: setDisplay,
    display: function () { return current() && current().ambient ? 'ambient' : 'vinyl'; },
    fps: function () { return { fps: Math.round(lastFps), scale: renderScale }; }
  };
})();
