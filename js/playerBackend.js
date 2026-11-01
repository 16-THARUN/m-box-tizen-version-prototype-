/**
 * playerBackend.js
 *
 * Two playback backends behind one interface, used by player.js:
 *
 *   load(url, mimeType), play(), pause(), seek(seconds), stop(),
 *   getCurrentTime(), getDuration(), isPlaying(), getFormat(), name
 *   handlers: onReady, onTimeUpdate, onEnded, onError(reason), onWaiting
 *
 * Html5AudioBackend — <audio> + Web Audio (analyser drives the visualizers).
 *   Web Audio decodes to PCM inside the app, so the soundbar only ever
 *   receives stereo PCM from this path. Fine for MP3/FLAC/Opus/etc.
 *
 * AvplayBackend — Samsung webapis.avplay. Plays through the TV's native
 *   media pipeline, which can pass the original Dolby bitstream (E-AC-3 /
 *   E-AC-3 JOC "Atmos" / AC-3) to an eARC soundbar. No PCM reaches the app,
 *   so the visualizers can't react while it's active.
 *
 * AVPlay needs no special privilege on 2015+ TVs (Samsung docs); network
 * URLs only need http://tizen.org/privilege/internet (already declared).
 * AVPlay does not run on the TV emulator — real TV only.
 */
var PlayerBackends = (function () {

  // ---------- Dolby detection ----------

  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function isDolbyCodec(c) {
    c = norm(c);
    return c.indexOf('eac3') === 0 || c.indexOf('ec3') === 0 || c.indexOf('ac3') === 0 ||
           c.indexOf('ac4') === 0 || c.indexOf('dolby') === 0;
  }

  /** Dolby = codec field E-AC-3 / E-AC-3 JOC / AC-3 (/AC-4), or a mimeType
   *  like audio/mp4; codecs="ec-3", or a Dolby-specific mime type. */
  function isDolbyTrack(track) {
    if (!track) return false;
    if (track.codec && isDolbyCodec(track.codec)) return true;
    var mime = String(track.mimeType || '').toLowerCase();
    var m = mime.match(/codecs\s*=\s*"?([^";,]+)/);
    if (m && isDolbyCodec(m[1])) return true;
    return /audio\/(eac3|ac3|ec3|e-ac-3|ac-3|vnd\.dolby)/.test(mime);
  }

  /** Lossless = FLAC / ALAC / WAV / PCM, by codec field or mime type. */
  function isLosslessTrack(track) {
    if (!track) return false;
    if (track.realContainer) return track.realContainer === 'FLAC' || track.realContainer === 'WAV' ||
      (track.realContainer === 'MP4' && /alac/i.test(String(track.codec)));                              // checked: trust the file, not its name
    var c = norm(track.codec) + ' ' + norm(track.mimeType) + ' ' + norm(extOf(track.uri));
    return /flac|alac|wav|lpcm|pcm|aiff/.test(c);
  }

  /** Human-readable codec name from a fourCC / codec string. */
  function codecLabel(raw, hint) {
    // AVPlay can report GStreamer-style names like "audio/x-ffmpeg-parsed-flac",
    // so match by *contains*, in an order where e.g. "flac" wins over the
    // "mpeg" inside "ffmpeg", and "eac3" wins over the "ac3" inside it.
    var h = norm(hint);
    function name(c) {
      if (!c) return null;
      if (c.indexOf('eac3') !== -1 || c.indexOf('ec3') !== -1) return (h.indexOf('joc') !== -1 || c.indexOf('joc') !== -1) ? 'E-AC-3 JOC' : 'E-AC-3';
      if (c.indexOf('ac4') !== -1) return 'AC-4';
      if (c.indexOf('ac3') !== -1) return 'AC-3';
      if (c.indexOf('flac') !== -1) return 'FLAC';
      if (c.indexOf('alac') !== -1) return 'ALAC';
      if (c.indexOf('opus') !== -1) return 'Opus';
      if (c.indexOf('vorbis') !== -1 || c === 'ogg') return 'Vorbis';
      if (c.indexOf('wav') !== -1 || c.indexOf('pcm') !== -1) return 'PCM';
      if (c.indexOf('aac') !== -1 || c.indexOf('mp4a') !== -1) return 'AAC';
      if (c.indexOf('mp3') !== -1 || c.indexOf('mpeg') !== -1) return 'MP3';
      return null;
    }
    var fromRaw = name(norm(raw)), fromHint = name(h);
    if (fromRaw) return fromRaw;
    if (fromHint) return fromHint;
    var plain = String(raw || hint || '').toUpperCase();
    return plain && plain.length <= 12 ? plain : null;   // never show long internal caps strings
  }

  function codecFromMime(mime) {
    var m = String(mime || '').toLowerCase();
    var c = m.match(/codecs\s*=\s*"?([^";,]+)/);
    if (c) return c[1];
    var sub = m.split(';')[0].split('/')[1];
    return sub || null;
  }

  // ---------- HTML5 <audio> backend ----------

  function createHtml5(audioEl, h) {
    var active = false;
    var guard = function (fn) { return function (e) { if (active) fn(e); }; };

    audioEl.addEventListener('timeupdate', guard(function () { h.onTimeUpdate(audioEl.currentTime, audioEl.duration); }));
    audioEl.addEventListener('ended', guard(function () { h.onEnded(); }));
    // Step-by-step timing in the TV log (once per track), so a failure shows where it stopped.
    var t0 = 0, sawMeta = false, sawPlaying = false;
    function dlog(m) { if (window.__debugLog) window.__debugLog('<audio>: ' + m + ' (' + (Date.now() - t0) + ' ms)'); }
    audioEl.addEventListener('loadedmetadata', guard(function () {
      if (!sawMeta) { sawMeta = true; dlog('header read, duration ' + (isFinite(audioEl.duration) ? Math.round(audioEl.duration) + ' s' : 'unknown')); }
      h.onReady();
    }));
    audioEl.addEventListener('playing', guard(function () { if (!sawPlaying) { sawPlaying = true; dlog('sound started'); } }));
    audioEl.addEventListener('canplay', guard(function () { h.onPlayable(); }));
    audioEl.addEventListener('playing', guard(function () { h.onPlayable(); }));
    audioEl.addEventListener('waiting', guard(function () { h.onWaiting(); }));
    audioEl.addEventListener('error', guard(function () {
      var err = audioEl.error, code = err ? err.code : '?';
      var names = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'format not supported' };
      h.onError('HTML5_MEDIA_ERROR: code ' + code + ' (' + (names[code] || '?') + (err && err.message ? ': ' + err.message : '') + ')');
    }));

    var track = null;

    return {
      name: 'html5',
      load: function (url, mimeType, trackInfo) {
        active = true;
        track = trackInfo || {};
        t0 = Date.now(); sawMeta = false; sawPlaying = false;
        audioEl.crossOrigin = 'anonymous'; // must be set BEFORE src, or the analyser reads zeros
        audioEl.src = url;
      },
      play: function () {
        AudioEngine.attachAudioElement(audioEl);
        AudioEngine.resume();
        var p = audioEl.play();
        if (p && p.catch) p.catch(function () {});
      },
      pause: function () { audioEl.pause(); },
      seek: function (sec) {
        if (!audioEl.duration) return;
        audioEl.currentTime = Math.max(0, Math.min(audioEl.duration, sec));
      },
      stop: function () {
        active = false;
        try { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); } catch (e) {}
      },
      reloadSameUrl: function (url) { audioEl.src = url; },
      getCurrentTime: function () { return audioEl.currentTime || 0; },
      // HTMLMediaElement readyState: 0 = nothing yet, 1 = header known, 2+ = has audio to play
      getReadyState: function () { return audioEl.readyState; },
      getNetworkState: function () { return audioEl.networkState; },
      getDuration: function () { return isFinite(audioEl.duration) ? audioEl.duration : 0; },
      isPlaying: function () { return !audioEl.paused; },
      getFormat: function () {
        var raw = track.codec || codecFromMime(track.mimeType) || extOf(track.uri);
        return {
          backend: 'html5',
          codec: codecLabel(raw, track.codec),
          channels: track.channels || null,
          sampleRate: track.sampleRate || null,
          sourceSampleRate: track.sourceSampleRate || null,
          bitDepth: track.bitDepth || null,
          bitrate: track.bitrate || null
        };
      }
    };
  }

  function extOf(url) {
    var m = String(url || '').split('?')[0].match(/\.([a-z0-9]+)$/i);
    return m ? m[1] : null;
  }

  // ---------- Samsung AVPlay backend ----------

  function avplayAvailable() {
    return typeof webapis !== 'undefined' && !!webapis.avplay;
  }

  function createAvplay(h) {
    var prepared = false;
    var wantPlay = false;
    var playing = false;
    var lastMs = 0;
    var durationMs = 0;
    var format = null;
    var hintCodec = null;
    var hintTrack = {};
    var errored = false, soundAnalysis = false, soundAnalysisReported = false;
    var errPrefix = 'AVPLAY_FAILED';
    var opened = false;
    var loadToken = 0;

    function av() { return webapis.avplay; }

    function closeIfOpen() {
      if (!opened) return;
      if (soundAnalysis) { try { av().unsetSoundAnalysisListener(); } catch (e) {} soundAnalysis = false; }
      try { av().stop(); } catch (e) {}
      try { av().close(); } catch (e) {}
      opened = false;
    }

    function readFormat() {
      var info = null;
      try {
        var tracks = av().getTotalTrackInfo() || [];
        for (var i = 0; i < tracks.length; i++) {
          if (tracks[i].type === 'AUDIO') {
            var x = tracks[i].extra_info;
            info = typeof x === 'string' ? JSON.parse(x) : x;
            break;
          }
        }
      } catch (e) { info = null; }
      info = info || {};
      return {
        backend: 'avplay',
        codec: codecLabel(info.fourCC, hintCodec) || codecLabel(hintCodec),
        channels: info.channels ? Number(info.channels) : (hintTrack.channels || null),
        sampleRate: info.sample_rate ? Number(info.sample_rate) : (hintTrack.sampleRate || null),
        sourceSampleRate: hintTrack.sourceSampleRate || null,
        bitDepth: hintTrack.bitDepth || null,               // AVPlay doesn't report bit depth; the phone does
        bitrate: info.bit_rate ? Number(info.bit_rate) : (hintTrack.bitrate || null)
      };
    }

    return {
      name: 'avplay',
      load: function (url, mimeType, trackInfo) {
        var token = ++loadToken;
        prepared = false; wantPlay = false; playing = false; lastMs = 0; durationMs = 0; format = null;
        hintCodec = (trackInfo && trackInfo.codec) || codecFromMime(mimeType) || extOf(url);
        hintTrack = trackInfo || {};
        errored = false;
        errPrefix = isDolbyTrack(hintTrack) ? 'AVPLAY_DOLBY_FAILED' : 'AVPLAY_FAILED';
        closeIfOpen(); // only ONE AVPlay instance — always stop + close first

        if (!avplayAvailable()) { h.onError(errPrefix + ': AVPlay not available on this device'); return; }

        try {
          av().open(url);
          opened = true;
          try { av().setDisplayRect(0, 0, 1, 1); } catch (e) {} // audio only; harmless if unsupported
          av().setListener({
            onbufferingstart: function () { if (token === loadToken) h.onWaiting(); },
            onbufferingcomplete: function () { if (token === loadToken) h.onPlayable(); },
            oncurrentplaytime: function (ms) {
              if (token !== loadToken) return;
              lastMs = ms;
              h.onTimeUpdate(ms / 1000, durationMs / 1000);
            },
            onstreamcompleted: function () {
              if (token !== loadToken) return;
              playing = false;
              h.onEnded();
            },
            onerror: function (type) {
              if (token !== loadToken || errored) return;
              errored = true; playing = false;
              h.onError(errPrefix + ': ' + type);
            },
            // Same error with AVPlay's own explanation (Tizen API: onerrormsg)
            onerrormsg: function (type, msg) {
              if (token !== loadToken || errored) return;
              errored = true; playing = false;
              h.onError(errPrefix + ': ' + type + (msg ? ' (' + msg + ')' : ''));
            },
            onevent: function (type, data) {
              if (window.__debugLog) window.__debugLog('AVPlay event: ' + type + ' ' + (data || ''));
            }
          });
          // Built-in spectrum (31 bands every ~30 ms). Deprecated since Tizen 2.4,
          // so it may be gone: try once, use it if it works, fall back quietly.
          try {
            av().setSoundAnalysisListener({
              ongetbandsarray: function (bands) { if (token === loadToken && h.onBands) h.onBands(bands); }
            });
            soundAnalysis = true;
          } catch (e) {
            soundAnalysis = false;
            if (!soundAnalysisReported && window.__debugLog) { soundAnalysisReported = true; window.__debugLog('AVPlay spectrum: not available on this TV (' + (e.name || e.message) + ')'); }
          }
          av().prepareAsync(function () {
            if (token !== loadToken) return;
            prepared = true;
            try { durationMs = av().getDuration() || 0; } catch (e) { durationMs = 0; }
            format = readFormat();
            h.onReady();
            if (wantPlay) { av().play(); playing = true; h.onPlayable(); }
          }, function (err) {
            if (token !== loadToken) return;
            h.onError(errPrefix + ': prepare failed (' + (err && (err.name || err.message) || err) + ')');
          });
        } catch (e) {
          h.onError(errPrefix + ': ' + (e.name || e.message || e));
        }
      },
      play: function () {
        if (!prepared) { wantPlay = true; return; }
        try { av().play(); playing = true; } catch (e) { h.onError(errPrefix + ': play (' + (e.name || e.message) + ')'); }
      },
      pause: function () {
        wantPlay = false;
        if (!prepared) return;
        try { av().pause(); playing = false; } catch (e) {}
      },
      seek: function (sec) {
        if (!prepared) return;
        var ms = Math.max(0, Math.round(sec * 1000));
        if (durationMs) ms = Math.min(durationMs, ms);
        try { av().seekTo(ms, function () {}, function () {}); lastMs = ms; } catch (e) {}
      },
      stop: function () {
        loadToken++;
        prepared = false; wantPlay = false; playing = false;
        closeIfOpen();
      },
      getCurrentTime: function () { return lastMs / 1000; },
      getDuration: function () { return durationMs / 1000; },
      isPlaying: function () { return playing; },
      getFormat: function () { return format; }
    };
  }

  function rateText(hz) {             // exact: 44100 -> "44.1", 22050 -> "22.05", 11025 -> "11.025", 48000 -> "48"
    return String(Number(hz) / 1000);
  }
  function channelText(n) {
    n = Number(n);
    if (n === 1) return 'Mono';
    if (n === 2) return 'Stereo';
    if (n === 6) return '5.1';
    if (n === 8) return '7.1';
    return n + ' ch';
  }
  /** On-screen codec name only (track.codec and Dolby detection keep "E-AC-3" / "E-AC-3 JOC"). */
  function displayCodec(c) {
    if (!c) return c;
    if (/^e-?ac-?3\s*joc$/i.test(c)) return 'E-AC3 JOC';
    if (/^e-?ac-?3$/i.test(c)) return 'E-AC3';
    return c;
  }
  function formatLabel(f) {
    if (!f || !f.codec) return '';
    var dolby = isDolbyCodec(f.codec);
    var parts = [displayCodec(f.codec)];
    if (f.bitDepth && !dolby) parts.push(f.bitDepth + '-bit');      // Dolby has no bit depth (it showed "16-bit")
    if (dolby && f.channels) parts.push(channelText(f.channels));  // Dolby: "E-AC3 JOC · 5.1 · 48 kHz"
    if (f.sampleRate) {
      var src = Number(f.sourceSampleRate);
      parts.push(src && src !== Number(f.sampleRate)
        ? rateText(src) + ' \u2192 ' + rateText(f.sampleRate) + ' kHz'   // converted by the phone
        : rateText(f.sampleRate) + ' kHz');
    }
    if (f.channels && !dolby) parts.push(channelText(f.channels));
    return parts.join(' \u00b7 ');
  }

  return {
    isDolbyTrack: isDolbyTrack,
    isLosslessTrack: isLosslessTrack,
    avplayAvailable: avplayAvailable,
    createHtml5: createHtml5,
    createAvplay: createAvplay,
    formatLabel: formatLabel, displayCodec: displayCodec
  };
})();
