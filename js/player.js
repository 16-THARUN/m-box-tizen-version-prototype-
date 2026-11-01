/**
 * player.js
 *
 * Owns the play queue and the Now Playing UI. Real tracks play through one
 * of two backends (see playerBackend.js):
 *   - html5  : <audio> + Web Audio — visualizers react to the music
 *   - avplay : Samsung AVPlay — for Dolby (E-AC-3 / JOC / AC-3), so the TV
 *              can pass the original bitstream to the eARC soundbar
 * Demo tracks (browser preview only) use AudioEngine's generated tone.
 */
var Player = (function () {
  var queue = [], queueIndex = -1, playing = false, shuffle = false, repeatMode = 'off';
  var demoDurationSec = 0, demoElapsedSec = 0, demoTickInterval = null;
  var vinylEl, progressFill, progressHandle, timeElapsedEl, timeTotalEl;
  var iconPlay, iconPause, trackTitleEl, trackArtistEl, trackFormatEl, btnShuffle, btnRepeat, audioEl;
  var albumArtEl, defaultIconEl, bufferingEl, connectionLostEl, playbackErrorEl, dolbyHintEl;
  var onStreamErrorCallback = null;
  var onTrackChangeCallback = null;   // phone queue: tell the phone which song is playing now
  var phoneQueue = false;             // true when the queue came from the phone (LOAD_QUEUE)
  var upNextEl = null, skipTimer = null;
  var pausedByUser = false, internalPausing = false;   // a pause the viewer/phone asked for vs. one the player did itself
  var screenSaverState = null;
  var retryTimeout = null, retryCount = 0, MAX_RETRIES = 3;
  var html5, avplay, backend = null;
  var html5Flac = 'maybe';           // audioEl.canPlayType('audio/flac'), read at init
  var pendingStartAt = 0;
  var dolbyHintTimer = null;

  function init() {
    vinylEl = byId('vinyl');
    progressFill = byId('progressFill');
    progressHandle = byId('progressHandle');
    timeElapsedEl = byId('timeElapsed');
    timeTotalEl = byId('timeTotal');
    iconPlay = byId('iconPlay');
    iconPause = byId('iconPause');
    trackTitleEl = byId('trackTitle');
    trackArtistEl = byId('trackArtist');
    trackFormatEl = byId('trackFormat');
    btnShuffle = byId('btnShuffle');
    btnRepeat = byId('btnRepeat');
    audioEl = byId('audioEl');
    albumArtEl = byId('albumArt');
    defaultIconEl = byId('vinylDefaultIcon');
    bufferingEl = byId('bufferingIndicator');
    connectionLostEl = byId('connectionLostBanner');
    playbackErrorEl = byId('playbackError');
    dolbyHintEl = byId('dolbyHint');

    var handlers = {
      onReady: onBackendReady,
      onPlayable: function () { hideBuffering(); hideConnectionLost(); },
      onTimeUpdate: onBackendTime,
      onEnded: onEnded,
      onWaiting: onWaiting,
      onError: onBackendError,
      onBands: onAvplayBands
    };
    html5 = PlayerBackends.createHtml5(audioEl, handlers);
    try { html5Flac = audioEl.canPlayType('audio/flac') || ''; } catch (e) { html5Flac = ''; }
    setTimeout(function () { log('Browser <audio> FLAC support: ' + (html5Flac || 'no')); }, 0);
    avplay = PlayerBackends.createAvplay(handlers);
  }

  function byId(id) { return document.getElementById(id); }
  function send(type, payload) {
    if (typeof RemoteBridge !== 'undefined' && RemoteBridge.sendEvent) RemoteBridge.sendEvent(type, payload);
  }
  function setOnStreamError(fn) { onStreamErrorCallback = fn; }
  function setOnTrackChange(fn) { onTrackChangeCallback = fn; }
  function trackChanged(reason) {
    hideUpNext();
    if (skipTimer) { clearTimeout(skipTimer); skipTimer = null; }
    if (onTrackChangeCallback && queue[queueIndex]) onTrackChangeCallback(queue[queueIndex], queueIndex, queue.length, reason);
  }

  // ---------- queue / loading ----------

  function loadQueue(tracks, startIndex, fromPhone, paused) {
    if (!tracks || !tracks.length) return;
    phoneQueue = !!fromPhone;
    if (skipTimer) { clearTimeout(skipTimer); skipTimer = null; }
    hideUpNext();
    queue = tracks.slice();
    queueIndex = Math.max(0, Math.min(queue.length - 1, startIndex || 0));
    retryCount = 0;
    if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null; }
    if (paused) {
      playing = false;
      pausedByUser = true;
      setScreenSaver(true);
      if (iconPlay) iconPlay.style.display = '';
      if (iconPause) iconPause.style.display = 'none';
      if (vinylEl) vinylEl.classList.remove('playing');
    } else {
      playing = true;
      pausedByUser = false;
      setScreenSaver(false);
      if (iconPlay) iconPlay.style.display = 'none';
      if (iconPause) iconPause.style.display = '';
      if (vinylEl) vinylEl.classList.add('playing');
    }
    loadCurrent();
  }

  function loadCurrent() {
    var track = queue[queueIndex];
    if (!track) return;
    trackTitleEl.textContent = track.title;
    trackArtistEl.textContent = track.artist + ' \u00b7 ' + track.album;
    stopDemoTick(); resetProgress(); hideBuffering(); hideConnectionLost(); hidePlaybackError();
    setFormatLabel(''); setPathLabel('');
    updateAlbumArt(track);
    if (typeof VisualizerManager !== 'undefined' && VisualizerManager.setTrack) VisualizerManager.setTrack(track);
    pendingStartAt = Number(track.startAt) || 0;

    // Pre-flight: for lossless/unknown files, read the header first and get a
    // version this TV can play, instead of discovering failure after a stall.
    if (!track.isDemo && track.isPhoneStream && !track.preflightDone &&
        typeof Preflight !== 'undefined' && Preflight.needsCheck(track)) {
      timeTotalEl.textContent = track.durationSec ? formatTime(track.durationSec) : '0:00';
      runPreflight(track);
      return;                                    // loadCurrent() runs again when the check is done
    }
    if (!track.isDemo && track.isPhoneStream && !track.embeddedArtTried && !(typeof Preflight !== 'undefined' && Preflight.needsCheck(track))) sniffId3Art(track);

    if (track.isDemo) {
      switchBackend(null);
      demoDurationSec = track.durationSec || 222; demoElapsedSec = 0;
      timeTotalEl.textContent = formatTime(demoDurationSec);
    } else {
      var dolby = PlayerBackends.isDolbyTrack(track);
      if (dolby && track.dolbySource !== 'file' && /^e-?ac-?3/i.test(String(track.codec || ''))) {
        // the file couldn't tell (no readable 'dec3', e.g. index at the end): use the phone's isJoc / atmosObjects
        if (track.isJoc === true) track.codec = 'E-AC-3 JOC';
        else if (track.isJoc === false) { track.codec = 'E-AC-3'; track.atmosObjects = null; }
        track.dolbySource = 'phone';
      }
      if (dolby && !track.dolbyLogged) {
        track.dolbyLogged = true;
        var dname = PlayerBackends.displayCodec(track.codec) || 'Dolby';
        log('Dolby: ' + dname + (track.isJoc && track.atmosObjects ? ' (' + track.atmosObjects + ' objects)' : '') + ' -> AVPlay passthrough');
      }
      // Dolby is never transcoded or re-routed: the original bitstream goes to AVPlay (eARC passthrough).
      // Only if AVPlay itself failed on it does it fall back to <audio> (stereo), and the screen says so.
      var chosen = dolby && track.dolbyFallback ? html5
        : dolby && PlayerBackends.avplayAvailable() ? avplay : (track.forceBackend || chooseBackend(track));
      if (track.loggedProbeFor !== chosen) {
        track.loggedProbeFor = chosen;
        log('Probe: ' + (track.realContainer || 'not probed') + ' ' + (track.codec || 'codec unknown') +
            ' joc=' + (track.isJoc == null ? '?' : track.isJoc) + ' -> backend ' + chosen.name +
            ' (' + (track.probeNote || (track.preflightDone ? 'no file check result' : 'file not checked: phone said ' + (track.codec || track.mimeType || 'nothing'))) + ')' +
            (track.dolbyFallback ? ' [Dolby fallback: ' + track.dolbyFallback + ']' : ''));
      }
      switchBackend(chosen, dolby && chosen === avplay);
      timeTotalEl.textContent = track.durationSec ? formatTime(track.durationSec) : '0:00';
      showBuffering(); // covers a slow START; cleared once the backend can play
      backend.load(track.uri, track.mimeType, track);
      startStallWatchdog();
      if (dolby) maybeShowDolbyHint(); else hideDolbyHint();
    }
    if (playing) startPlaybackForCurrentTrack();
  }

  // ---------- pre-flight (see preflight.js) ----------
  var preflightToken = 0, prepTimer = null;
  function log(m) { if (window.__debugLog) window.__debugLog(m); }

  function runPreflight(track) {
    track.preflightDone = true;
    track.preflightPending = true;
    track.originalUri = track.originalUri || track.uri;
    if (backend) { backend.stop(); }
    backend = null;                              // no player until the check decides which one
    setStatusChip('Checking file\u2026');
    var token = ++preflightToken;
    Preflight.check(track, function (plan, why) {
      if (token !== preflightToken || queue[queueIndex] !== track) return;      // a newer track took over
      if (plan && plan.info) findEmbeddedArt(track, plan.info); else track.embeddedArtTried = true;
      var pi = plan && plan.info;
      track.probeNote = !plan ? 'probe failed: ' + (why || 'no answer')
        : pi.codecFrom ? 'codec read from the ' + pi.codecFrom
        : pi.tailError ? 'codec details not found: ' + pi.tailError
        : (pi.codec || pi.container !== 'MP4') ? 'read from the start of the file' : 'codec unknown in the file';
      applyPlan(track, plan, why, function () {
        track.preflightPending = false;
        if (token === preflightToken && queue[queueIndex] === track) loadCurrent();
      });
    });
  }

  function applyPlan(track, plan, why, done) {
    // Both ways of reading the file got an HTTP error from the phone (e.g. 404):
    // the file isn't being served, so no player can succeed. Say so right away.
    var http = /^probe failed: HTTP (\d{3})\b.*stream: HTTP (\d{3})/.exec(why || '');
    if (!plan && http) {
      log('Pre-flight: the phone answered HTTP ' + http[1] + ' for this song\u2019s URL \u2014 not trying to play it');
      showPlaybackError('The phone couldn\u2019t provide this file (HTTP ' + http[1] + ')');
      hideBuffering(); track.preflightPending = false;
      failTrack(track, 'PHONE_HTTP_' + http[1] + ': GET ' + (track.originalUri || track.uri) + ' returned ' + http[1]);
      return;
    }
    if (!plan) { log('Pre-flight: couldn\u2019t read the file header (' + (why || 'unknown') + ') \u2014 playing it as is'); done(); return; }
    var info = plan.info;
    track.preflight = plan;

    track.realContainer = plan.container;
    var alac = plan.container === 'MP4' && info.codec === 'ALAC';
    if (plan.container === 'MP4' && info.codec) {
      // What's really inside the .m4a/.mp4. For E-AC-3 the file's 'dec3' box says whether it is
      // Atmos (JOC) and how many objects; the phone's codec / isJoc / atmosObjects are used
      // only when the file can't tell (no 'dec3' in the first part of the file).
      if (info.codec === 'E-AC-3') {
        var phoneJoc = track.isJoc != null ? !!track.isJoc : /joc/i.test(String(track.codec || ''));
        var joc = info.isJoc != null ? info.isJoc : phoneJoc;
        track.isJoc = joc;
        track.atmosObjects = joc ? (info.isJoc != null ? info.atmosObjects : (track.atmosObjects || null)) : null;
        track.dolbySource = info.isJoc != null ? 'file' : 'phone';
        track.codec = joc ? 'E-AC-3 JOC' : 'E-AC-3';
      } else {
        track.codec = info.codec;
      }
      if (info.sampleRate) track.sampleRate = info.sampleRate;
      if (info.dolbyChannels) track.channels = info.dolbyChannels;
      else if (info.channels) track.channels = info.channels;
      track.bitDepth = info.bitDepth || null;
      log('Pre-flight: MP4 containing ' + track.codec + (info.sampleRate ? ' ' + (info.bitDepth ? info.bitDepth + '-bit/' : '') + info.sampleRate + ' Hz/' + track.channels + ' ch' : '') +
          (info.codec === 'E-AC-3' ? (track.dolbySource === 'file' ? ' (from the file\u2019s dec3 box)' : ' (dec3 not readable \u2014 using the phone\u2019s info)') : ''));
      if (!alac) { done(); return; }
    }
    if (plan.container !== 'FLAC' && !alac) {             // e.g. an MP3 saved as .flac: play it as what it is
      if (plan.container === 'MPEG audio') { track.codec = 'MP3'; track.mimeType = 'audio/mpeg'; track.bitDepth = null; }
      else if (plan.container === 'WAV') { track.codec = 'PCM'; track.mimeType = 'audio/wav'; }
      else if (plan.container === 'Ogg') { track.mimeType = 'audio/ogg'; track.bitDepth = null; }
      log('Pre-flight: file is ' + plan.container + (/flac/i.test(String(track.codec) + track.mimeType) ? '' : ''));
      done(); return;
    }

    track.codec = alac ? 'ALAC' : 'FLAC';
    track.bitDepth = info.bitDepth; track.channels = info.channels;
    var desc = track.codec + ' ' + info.bitDepth + '-bit/' + info.sampleRate + ' Hz/' + info.channels + ' ch';
    var supports = typeof RemoteBridge !== 'undefined' && RemoteBridge.phoneSupports && RemoteBridge.phoneSupports('tvsafe');
    var extra = [];
    if (info.avgKbps) extra.push(info.avgKbps + ' kbps avg' + (info.peakKbps ? ', peak ' + info.peakKbps : ''));
    if (info.durationSec) extra.push(Math.floor(info.durationSec / 60) + ':' + ('0' + Math.floor(info.durationSec % 60)).slice(-2));
    if (info.maxBlock) extra.push('block ' + (info.minBlock !== info.maxBlock ? info.minBlock + '\u2013' : '') + info.maxBlock);
    if (info.pictureBytes) extra.push('art ' + Math.round(info.pictureBytes / 1024) + ' KB');
    var notes = (info.notes || []).filter(function (n) { return !/Hz \(TV|channels$|-bit samples|cover art is|continues past/.test(n); });   // already in reasons
    log('Pre-flight: ' + desc + (extra.length ? ' \u00b7 ' + extra.join(' \u00b7 ') : '') +
        (plan.reasons.length ? ' \u2014 ' + plan.reasons.join(', ') : ' \u2014 OK') + (notes.length ? ' (note: ' + notes.join('; ') + ')' : ''));

    if (!supports) {
      track.sampleRate = info.sampleRate;
      if (plan.needsConvert) {
        // This TV can't decode it and this phone app can't convert it: say so now, not after a stall.
        showPlaybackError('Can\u2019t play on the TV: ' + plan.reasons.join(', ') + ' \u2014 needs the updated phone app');
        var why = (info.sampleRate > Preflight.CAPS.maxRate ? 'SAMPLE_RATE_ABOVE_48K: ' : 'UNPLAYABLE_FORMAT: ') + desc + ' (' + plan.reasons.join(', ') + ')';
        hideBuffering(); track.preflightPending = false;
        failTrack(track, why);
        return;
      }
      done(); return;                                      // tag issues only: try it as is (fallbacks still apply)
    }

    if (!plan.needsConvert) {                              // instant & lossless: same audio, no tags/art
      if (alac) { track.sampleRate = info.sampleRate; done(); return; }   // ALAC within limits: play the original
      track.sampleRate = info.sampleRate;
      var strippedUrl = Preflight.strippedUrl(track.originalUri);
      setStatusChip('Checking the phone\u2019s stream\u2026');
      Preflight.verifyCopy(strippedUrl, info, function (bad) {
        if (queue[queueIndex] !== track) return;
        if (bad) {
          log('Pre-flight: the phone\u2019s stripped stream is broken (' + bad + ') \u2014 using the original file');
          send('TVSAFE_BROKEN', { kind: 'stripped', url: strippedUrl, reason: bad });
        } else {
          track.uri = strippedUrl;
        }
        done();
      });
      return;
    }

    // The phone converts once (cached), then we play the result.
    var t0 = Date.now();
    var label = 'Preparing for TV\u2026 (' + plan.reasons.join(', ') + ')';
    setStatusChip(label);
    if (prepTimer) clearInterval(prepTimer);
    prepTimer = setInterval(function () { setStatusChip(label + ' ' + Math.round((Date.now() - t0) / 1000) + ' s'); }, 1000);
    Preflight.prepare(track.originalUri, plan.transforms, function (res, err) {
      clearInterval(prepTimer); prepTimer = null;
      if (queue[queueIndex] !== track) return;
      if (!res) {
        log('Pre-flight: phone couldn\u2019t prepare the file (' + err + ')');
        showPlaybackError('The phone couldn\u2019t prepare this file for the TV (' + err + ')');
        hideBuffering(); track.preflightPending = false;
        failTrack(track, 'PREPARE_FAILED: ' + err);
        return;
      }
      var convertedUrl = res.url;
      Preflight.verifyCopy(convertedUrl, { sampleRate: res.sampleRate || plan.transforms.rate || null }, function (bad) {
        if (queue[queueIndex] !== track) return;
        if (bad) {
          log('Pre-flight: the phone\u2019s converted file is broken (' + bad + ')');
          send('TVSAFE_BROKEN', { kind: 'converted', url: convertedUrl, reason: bad });
          showPlaybackError('The phone\u2019s converted file is broken (' + bad + ')');
          hideBuffering(); track.preflightPending = false;
          failTrack(track, 'PREPARE_FAILED: converted file invalid: ' + bad);
          return;
        }
        useConverted();
      });
      function useConverted() {
      track.uri = convertedUrl;
      if (alac) { track.codec = 'FLAC'; track.realContainer = 'FLAC'; track.mimeType = 'audio/flac'; }   // the phone delivers FLAC
      track.sampleRate = res.sampleRate || plan.transforms.rate || info.sampleRate;
      track.sourceSampleRate = track.sampleRate !== info.sampleRate ? info.sampleRate : null;
      track.bitDepth = res.bitDepth || Math.min(info.bitDepth, Preflight.CAPS.maxBits);
      track.channels = res.channels || Math.min(info.channels, Preflight.CAPS.maxCh);
      log('Pre-flight: ready in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
      done();
      }
    });
  }

  // ---------- backend choice ----------
  //   Dolby (E-AC-3 / JOC / AC-3)          -> AVPlay (bitstream to the soundbar)
  //   Lossless + "Native player" setting   -> AVPlay (TV's own decoder, visualizer off)
  //   everything else                      -> <audio> + Web Audio (reactive visualizers)
  // Real TV (2026-10-09): <audio> reads FLAC headers but never plays them, at
  // 16-bit as at 24-bit. So lossless defaults to AVPlay ("native"); "visualizer"
  // (<audio>) is only used when chosen in Settings. New key on purpose.
  var ENGINE_KEY = 'mbox_lossless_engine_v2';
  function getLosslessEngine() {
    try { return localStorage.getItem(ENGINE_KEY) === 'visualizer' ? 'visualizer' : 'native'; } catch (e) { return 'native'; }
  }
  function setLosslessEngine(v) {
    try { localStorage.setItem(ENGINE_KEY, v === 'native' ? 'native' : 'visualizer'); } catch (e) {}
  }
  // Learned on the real TV: 24-bit FLAC never starts through <audio> but
  // plays through AVPlay. So 24-bit lossless goes to AVPlay directly, and any
  // other format that stalls on <audio> but then plays on AVPlay is
  // remembered (per codec + bit depth) so it skips the 12 s stall next time.
  var PREFER_KEY = 'mbox_prefer_avplay:';
  function profileKey(track) {
    return (PlayerBackends.isLosslessTrack(track) ? 'lossless' : 'other') + ':' + (track.bitDepth || '?') + ':' +
           String(track.codec || track.mimeType || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  var FLAC_ANY = PREFER_KEY + 'flac-any';   // <audio> failed on one FLAC: treat it as unreliable for every FLAC
  function isFlac(track) { return /flac/i.test(String(track.codec || '') + ' ' + String(track.mimeType || '') + ' ' + String(track.realContainer || '')); }
  function learnedAvplay(track) {
    try { return localStorage.getItem(PREFER_KEY + profileKey(track)) === '1' || (isFlac(track) && localStorage.getItem(FLAC_ANY) === '1'); }
    catch (e) { return false; }
  }
  function learnAvplay(track) {
    try { localStorage.setItem(PREFER_KEY + profileKey(track), '1'); if (isFlac(track)) localStorage.setItem(FLAC_ANY, '1'); } catch (e) {}
    if (window.__debugLog) window.__debugLog('Player: learned \u2014 ' + profileKey(track) + ' plays via AVPlay from now on');
  }
  function chooseBackend(track) {
    if (PlayerBackends.isDolbyTrack(track)) return avplay;
    if (!PlayerBackends.avplayAvailable()) return html5;
    if (/alac/i.test(String(track.codec))) return avplay;      // Samsung lists ALAC for its native player; browsers often can't decode it
    // FLAC on this TV: every 24-bit file stalled on <audio> and played on AVPlay.
    // Unknown bit depth is treated the same; only a file the phone reports as
    // 16-bit (or lower) tries <audio> first (with the stall fallback + learning).
    if (PlayerBackends.isLosslessTrack(track) && !/alac/i.test(String(track.codec)) && !html5Flac) return avplay;  // this browser says it can't
    var bits = Number(track.bitDepth);
    if (PlayerBackends.isLosslessTrack(track) &&
        (getLosslessEngine() === 'native' || !bits || bits >= 24)) return avplay;
    if (learnedAvplay(track)) return avplay;
    return html5;
  }

  /** Stops whichever backend was active and tells the visualizer whether
   *  it can react to audio (html5/demo) or not (avplay). */
  function switchBackend(next, dolby) {
    if (backend && backend !== next) backend.stop();
    var changed = backend !== next;
    backend = next;
    if (changed && next) send('VIS_SOURCE', { source: next === avplay ? 'phone' : 'tv' });
    if (VisualizerManager.setExternalDecoder) {
      VisualizerManager.setExternalDecoder(next === avplay,
        dolby ? 'Dolby \u00b7 sent to soundbar' : 'Native player \u00b7 visualizer off');
    }
  }

  // ---------- stall watchdog ----------
  // A stream that never starts (no progress while we intend to play) is
  // treated as a failure, so the fallback/error path runs instead of an
  // endless "Buffering…". 12 s by default.
  var stallTimer = null, stallTicks = 0;
  var HTML5_NO_DATA_MS = 5000;
  function startStallWatchdog() {
    stopStallWatchdog();
    var limitMs = (window.__mboxStallMs || 12000), tickMs = Math.min(1000, limitMs / 4);
    var noDataMs = Math.min(HTML5_NO_DATA_MS, limitMs);
    var silentTicks = 0;
    stallTicks = 0;
    stallTimer = setInterval(function () {
      var track = queue[queueIndex];
      if (!track || track.isDemo || !backend) { stopStallWatchdog(); return; }
      if (getCurrentTime() > 0.2) {                                  // it's playing...
        // ...but through <audio> + Web Audio, a suspended AudioContext means
        // the time runs while nothing reaches the speakers.
        if (backend === html5 && AudioEngine.getState && AudioEngine.getState() === 'suspended') {
          AudioEngine.resume();
          if (++silentTicks === 1) log('Player: <audio> is playing but Web Audio is suspended (silent) \u2014 resuming');
          if (silentTicks * tickMs >= 2000) {
            stopStallWatchdog();
            onBackendError('HTML5_SILENT: Web Audio stayed suspended, so the <audio> output is silent');
          }
          return;
        }
        stopStallWatchdog(); return;
      }
      if (!playing) return;                                          // paused before start: don't count
      stallTicks++;
      var elapsed = stallTicks * tickMs;
      var rs = html5.getReadyState ? html5.getReadyState() : 4;
      if (backend === html5 && rs < 2 && elapsed >= noDataMs) {     // 0 = nothing read, 1 = header only, no sound
        stopStallWatchdog();
        onBackendError('HTML5_NO_DATA: <audio> ' + (rs === 1 ? 'read the header but produced no sound' : 'could not read this stream') +
                       ' in ' + Math.round(elapsed / 1000) + ' s (ready ' + rs + ', load state ' + html5.getNetworkState() + ')');
        return;
      }
      if (elapsed >= limitMs) {
        stopStallWatchdog();
        onBackendError('STALLED: no playback progress after ' + Math.round(limitMs / 1000) + ' s');
      }
    }, tickMs);
  }
  function stopStallWatchdog() { if (stallTimer) { clearInterval(stallTimer); stallTimer = null; } }

  /** Cover on the vinyl. The old cover is cleared first and the new one is
   *  shown only once it has loaded, so a slow or broken artwork URL never
   *  leaves the previous song's cover on screen (seen on the real TV). The
   *  URL gets the song's id, so the TV's image cache can't return another
   *  song's cover when the phone reuses a URL. */
  var artToken = 0;
  function updateAlbumArt(track) {
    if (!albumArtEl) return;
    if (track.embeddedArtUrl && coverFromCache(track) !== track.embeddedArtUrl) track.embeddedArtUrl = null;   // dropped from the cover cache
    var cached = !track.embeddedArtUrl && !track.embeddedArtBroken && coverFromCache(track);
    if (cached) { track.embeddedArtUrl = cached; if (!track.embeddedArtCanvas && coverCanvases[coverKey(track)]) track.embeddedArtCanvas = coverCanvases[coverKey(track)]; }
    var url = track.embeddedArtUrl || (track.artworkUrl && !waitingForEmbeddedArt(track) ? artUrlFor(track) : null);
    var shown = albumArtEl.classList.contains('visible') || (artCanvas && artCanvas.classList.contains('visible'));
    if (url && albumArtEl.__url === url && shown) return;   // same cover already on screen: don't blink it off and on
    if (url && !track.embeddedArtUrl && !/^(https?|data|blob):/i.test(url)) {
      if (track.artBadLogged !== url) { track.artBadLogged = url; log('Artwork: the phone sent an address the TV can\u2019t open (' + String(url).slice(0, 60) + ') \u2014 needs an http:// URL'); }
      url = null;
    }
    var phoneRetry = !track.embeddedArtUrl && /^https?:/i.test(url || '');
    var token = ++artToken;
    albumArtEl.onload = albumArtEl.onerror = null;
    albumArtEl.classList.remove('visible');
    albumArtEl.removeAttribute('src');
    albumArtEl.__url = null;
    if (artCanvas) artCanvas.classList.remove('visible');
    if (defaultIconEl) defaultIconEl.classList.remove('hidden-icon');
    coverChanged();
    if (!url) return;
    if (url === track.embeddedArtUrl && track.embeddedArtCanvas && drawArtToCanvas(track.embeddedArtCanvas)) {
      albumArtEl.__url = url;                                   // the calm screen / Up next still use the URL
      artCanvas.classList.add('visible');
      if (defaultIconEl) defaultIconEl.classList.add('hidden-icon');
      coverChanged();
      return;
    }
    albumArtEl.onload = function () {
      if (token !== artToken) return;
      albumArtEl.__url = url;
      if (phoneRetry) log('Artwork: phone cover loaded (' + albumArtEl.naturalWidth + '\u00d7' + albumArtEl.naturalHeight + ')');
      // The vinyl spins: a big cover (often 1000+ px) scaled down to the 150 px
      // label on every frame sparkles on the TV ("glitchy" cover on the real
      // TV). Draw it once, smoothly, at the label's real size and spin that.
      if (drawArtToCanvas()) { albumArtEl.classList.remove('visible'); artCanvas.classList.add('visible'); }
      else albumArtEl.classList.add('visible');
      if (defaultIconEl) defaultIconEl.classList.add('hidden-icon');
      coverChanged();
    };
    albumArtEl.onerror = function () {
      if (token !== artToken) return;
      if (phoneRetry && !track.artRetried) {                 // the phone may still be making it: one more try
        track.artRetried = true;
        log('Artwork: phone cover didn\u2019t load (' + String(url).split('?')[0].slice(-60) + ') \u2014 trying again');
        setTimeout(function () { if (token === artToken) { albumArtEl.src = url + '&mbxretry=1'; } }, 1500);
        return;
      }
      if (track.embeddedArtUrl && url === track.embeddedArtUrl && track.artworkUrl && !track.embeddedArtBroken) {
        track.embeddedArtBroken = true;
        log('Artwork: the TV couldn\u2019t show the cover from inside \u201c' + track.title + '\u201d (' + String(url).slice(0, 30) + '\u2026) \u2014 using the phone\u2019s cover');
        var k = coverKey(track); if (k && coverCache[k] === url) delete coverCache[k];
        track.embeddedArtUrl = null; track.artWaitOver = true;
        updateAlbumArt(track);
        return;
      }
      log('Artwork: couldn\u2019t load the cover for \u201c' + track.title + '\u201d (' + String(url).split('?')[0].slice(-60) + ') \u2014 showing the default icon');
      albumArtEl.removeAttribute('src');
    };
    albumArtEl.src = url;
  }
  // ---------- the cover inside the file itself ----------
  // Seen on the real TV: the phone's artwork URL for "One Last Push - Leo"
  // returned another album's cover (Minnale). A FLAC file carries its own
  // cover (PICTURE block); pre-flight already knows where it is, so the TV
  // reads it from the file and shows that. The phone's artworkUrl is only
  // used for files without an embedded cover.
  function waitingForEmbeddedArt(track) {
    if (track.artWaitOver) return false;               // the file's cover is slow: show the phone's meanwhile
    if (track.embeddedArtTried) return !!track.embeddedArtLoading;
    // lossless/unknown phone files get a pre-flight; until it has run, don't show the phone's cover
    return !!(track.isPhoneStream && typeof Preflight !== 'undefined' && Preflight.needsCheck(track) && (!track.preflightDone || track.preflightPending));
  }

  // Small covers (300 px JPEG, ~20-40 KB) cached by song file, so a song played again, the
  // "Up next" card and the next song in the queue get their cover at once, and the big
  // original (often 1-10 MB) is decoded only once, off the main thread when the TV can.
  var coverCache = {}, coverOrder = [], COVER_CACHE_MAX = 40;
  var largeCache = {}, largeOrder = [];
  // The decoded cover itself (300 px canvas). Real TV 2026-10-23/25: an <img> could load neither the
  // blob: nor the data: copy of the file's cover, so the vinyl is drawn straight from this canvas.
  var coverCanvases = {};
  function cacheLargeCover(track, url) {
    var k = coverKey(track); if (!k) return;
    if (largeCache[k]) { try { URL.revokeObjectURL(largeCache[k]); } catch (e) {} }
    largeCache[k] = url; largeOrder = largeOrder.filter(function (x) { return x !== k; }); largeOrder.push(k);
    while (largeOrder.length > 6) { var o = largeOrder.shift(); try { URL.revokeObjectURL(largeCache[o]); } catch (e) {} delete largeCache[o]; }
  }
  /** Cover for the calm screen: the 1024 px copy of the file's cover, else what the vinyl shows. */
  function currentCover() {
    var t = queue[queueIndex]; if (!t) return null;
    var small = albumArtEl && albumArtEl.__url && (albumArtEl.classList.contains('visible') || (artCanvas && artCanvas.classList.contains('visible'))) ? albumArtEl.__url : null;
    if (!small) return null;
    return { small: small, large: (t.embeddedArtUrl === small && largeCache[coverKey(t)]) || small };
  }
  var onCoverCb = null;
  function coverChanged() { if (onCoverCb) try { onCoverCb(currentCover()); } catch (e) {} }
  function coverKey(track) { return String(track.originalUri || track.uri || ''); }
  function coverFromCache(track) { var k = coverKey(track); return (k && coverCache[k]) || null; }
  function cacheCover(track, url) {
    var k = coverKey(track); if (!k) return;
    if (coverCache[k] && coverCache[k] !== url && /^blob:/.test(coverCache[k])) { try { URL.revokeObjectURL(coverCache[k]); } catch (e) {} }
    coverCache[k] = url;
    coverOrder = coverOrder.filter(function (x) { return x !== k; }); coverOrder.push(k);
    while (coverOrder.length > COVER_CACHE_MAX) {
      var old = coverOrder.shift(), cur = queue[queueIndex];
      if (cur && coverKey(cur) === old) { coverOrder.push(old); if (coverOrder.length > COVER_CACHE_MAX + 1) break; continue; }
      if (/^blob:/.test(coverCache[old])) { try { URL.revokeObjectURL(coverCache[old]); } catch (e) {} }
      delete coverCache[old]; delete coverCanvases[old];
    }
  }

  /** Looks for the cover inside the file: a FLAC PICTURE block, or an ID3 tag (in front of
   *  MP3s, and in front of some FLACs -- common in Indian soundtrack rips, where the FLAC
   *  has no PICTURE block and the cover lives in the ID3 tag). */
  function findEmbeddedArt(track, info) {
    if (track.embeddedArtTried) return;
    track.embeddedArtTried = true;
    if (coverFromCache(track)) { track.embeddedArtUrl = coverFromCache(track); if (queue[queueIndex] === track) updateAlbumArt(track); return; }
    var pic = null;
    (info && info.blocks || []).forEach(function (b) { if (b.type === 6 && !pic) pic = b; });
    var url = track.originalUri || track.uri;
    if (pic && pic.length >= 32 && pic.length <= 12 * 1024 * 1024) {
      startArtWait(track);
      readBytes(url, pic.offset + 4, pic.offset + 4 + pic.length, function (bytes, how) {
        gotEmbedded(track, bytes && parsePicture(bytes), 'FLAC picture', how);
      });
      return;
    }
    if (info && info.id3Bytes > 10) { readId3Art(track, url, info.id3Bytes); return; }
    if (info && info.container === 'FLAC') log('Artwork: no cover inside “' + track.title + '” — using the phone’s');
  }
  /** Songs without a pre-flight (MP3...): a 10-byte look for an ID3 tag, then its cover. */
  function sniffId3Art(track) {
    if (track.embeddedArtTried || track.isDemo || !track.isPhoneStream) return;
    track.embeddedArtTried = true;
    if (coverFromCache(track)) { track.embeddedArtUrl = coverFromCache(track); if (queue[queueIndex] === track) updateAlbumArt(track); return; }
    var url = track.originalUri || track.uri;
    readBytes(url, 0, 10, function (h) {
      if (!h || h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) return;           // no ID3 tag
      var size = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
      readId3Art(track, url, 10 + size);
    });
  }
  function readId3Art(track, url, tagBytes) {
    if (tagBytes > 16 * 1024 * 1024) return;
    startArtWait(track);
    readBytes(url, 0, tagBytes, function (bytes, how) { gotEmbedded(track, bytes && parseId3Picture(bytes), 'ID3 tag', how); });
  }
  function startArtWait(track) {
    track.embeddedArtLoading = true;
    track.artWaitStart = Date.now();
    setTimeout(function () {
      if (track.embeddedArtLoading && !track.embeddedArtUrl) {
        track.artWaitOver = true;
        log('Artwork: reading the cover inside the file is slow — showing the phone’s meanwhile');
        if (queue[queueIndex] === track) updateAlbumArt(track);
      }
    }, 2500);
  }
  function gotEmbedded(track, img, where, how) {
    if (!img) {
      track.embeddedArtLoading = false;
      log('Artwork: couldn’t read the cover inside “' + track.title + '” (' + where + (how ? ', ' + how : '') + ') — using the phone’s');
      if (queue[queueIndex] === track) updateAlbumArt(track);
      return;
    }
    var ms = Date.now() - (track.artWaitStart || Date.now());
    var big = new Blob([img.data], { type: img.mime });
    makeSmallCover(big, function (small, large, w, h, smallCanvas) {
      track.embeddedArtLoading = false;
      if (smallCanvas) { track.embeddedArtCanvas = smallCanvas; coverCanvases[coverKey(track)] = smallCanvas; }
      // small = data:image/jpeg URL (~20-40 KB). Seen on the real TV 2026-10-23: the <img> could not
      // load the blob:file:/// URL of the cover ("couldn't load the cover for Odysseus").
      var u = small || URL.createObjectURL(big);
      track.embeddedArtUrl = u;
      cacheCover(track, u);
      if (large) cacheLargeCover(track, URL.createObjectURL(large));
      log('Artwork: using the cover inside the file (' + where + ', ' + (w || img.w) + '×' + (h || img.h) + ', ' +
        Math.round(img.data.length / 1024) + ' KB' + (small ? ' → ' + Math.round(small.length * 0.75 / 1024) + ' KB' : '') + (how ? ', ' + how : ', ' + ms + ' ms') + ')');
      if (queue[queueIndex] === track) updateAlbumArt(track);
    });
  }
  /** Big cover -> 300 px JPEG (vinyl label) + 1024 px JPEG (the calm "Ambient Cover" screen),
   *  from one decode. createImageBitmap decodes off the main thread, so the visualizer
   *  doesn't stutter while a 3000 px cover is decoded. cb(small, large, w, h). */
  function makeSmallCover(blob, cb) {
    var SMALL = 300, LARGE = 1024;
    function step(cur, cs, target) {                                    // halve step by step: smooth result
      while (cs / 2 >= target) {
        var half = document.createElement('canvas'); half.width = half.height = Math.floor(cs / 2);
        var hc = half.getContext('2d'); hc.imageSmoothingEnabled = true; if ('imageSmoothingQuality' in hc) hc.imageSmoothingQuality = 'high';
        hc.drawImage(cur, 0, 0, cs, cs, 0, 0, half.width, half.height); cur = half; cs = half.width;
      }
      return { c: cur, s: cs };
    }
    function exportAt(src, size, done, asDataUrl) {
      var out = document.createElement('canvas'); out.width = out.height = Math.min(size, src.s);
      var oc = out.getContext('2d'); oc.imageSmoothingEnabled = true; if ('imageSmoothingQuality' in oc) oc.imageSmoothingQuality = 'high';
      oc.drawImage(src.c, 0, 0, src.s, src.s, 0, 0, out.width, out.height);
      if (asDataUrl) { try { done(out.toDataURL('image/jpeg', 0.9), out); } catch (e) { done(null, out); } return; }
      if (out.toBlob) out.toBlob(function (b) { done(b); }, 'image/jpeg', 0.9); else done(null);
    }
    function fromSource(src, sw, sh, done) {
      try {
        var side = Math.min(sw, sh), sq = document.createElement('canvas');
        sq.width = sq.height = side;
        sq.getContext('2d').drawImage(src, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, side, side);
        var big = step(sq, side, LARGE);
        exportAt(big, LARGE, function (large) {
          var small = step(big.c, big.s, SMALL);
          exportAt(small, SMALL, function (sm, smCanvas) { done(sm, large, sw, sh, smCanvas); }, true);
        });
      } catch (e) { done(null, null, sw, sh); }
    }
    if (window.createImageBitmap) {
      createImageBitmap(blob).then(function (bmp) {
        fromSource(bmp, bmp.width, bmp.height, function (a, l, w, h, c) { try { bmp.close(); } catch (e) {} cb(a, l, w, h, c); });
      }, function () { viaImg(); });
    } else viaImg();
    function viaImg() {
      var u = URL.createObjectURL(blob), im = new Image();
      im.onload = function () { fromSource(im, im.naturalWidth, im.naturalHeight, function (a, l, w, h, c) { URL.revokeObjectURL(u); cb(a, l, w, h, c); }); };
      im.onerror = function () { URL.revokeObjectURL(u); cb(null); };
      im.src = u;
    }
  }
  /** Bytes [start, end) of a phone file. First a Range request (only those bytes); if the phone
   *  doesn't do ranges or the request is refused, a streamed GET that stops once they arrived. */
  function readBytes(url, start, end, cb) {
    var done = false, t0 = Date.now();
    function fin(x, how) { if (!done) { done = true; cb(x, how ? how + ', ' + (Date.now() - t0) + ' ms' : ''); } }
    setTimeout(function () { fin(null, 'gave up after 15 s'); }, 15000);
    var xhr = null;
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Range', 'bytes=' + start + '-' + (end - 1));
      xhr.timeout = 6000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 2 && xhr.status !== 206) { try { xhr.abort(); } catch (e) {} streamed(); }   // whole file coming: don't download it this way
      };
      xhr.onload = function () {
        if (xhr.status === 206 && xhr.response && xhr.response.byteLength >= end - start) fin(new Uint8Array(xhr.response, 0, end - start), 'Range request');
        else streamed();
      };
      xhr.onerror = xhr.ontimeout = function () { streamed(); };
      xhr.send();
    } catch (e) { streamed(); }
    var streaming = false;
    function streamed() {
      if (streaming || done) return; streaming = true;
      try {
        fetch(url).then(function (resp) {
          if (!resp.ok || !resp.body) { fin(null, 'HTTP ' + resp.status); return; }
          var reader = resp.body.getReader(), out = new Uint8Array(end - start), pos = 0;
          function pump() {
            return reader.read().then(function (r) {
              if (r.value) {
                var v = r.value, a = Math.max(start, pos), b = Math.min(end, pos + v.length);
                if (b > a) out.set(v.subarray(a - pos, b - pos), a - start);
                pos += v.length;
              }
              if (r.done || pos >= end || done) { try { reader.cancel(); } catch (e) {} fin(pos >= end ? out : null, 'streamed'); return; }
              return pump();
            });
          }
          return pump();
        }).catch(function () { fin(null, 'network error'); });
      } catch (e) { fin(null, e.message); }
    }
  }
  function sniffMime(d, mime) {
    if (d[0] === 0xFF && d[1] === 0xD8) return 'image/jpeg';
    if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4E && d[3] === 0x47) return 'image/png';
    if (d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46) return 'image/gif';
    if (d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46) return 'image/webp';
    return /^image\//.test(mime || '') ? mime : 'image/jpeg';
  }
  /** FLAC PICTURE block -> {mime, w, h, data}. */
  function parsePicture(b) {
    function u32(o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
    try {
      var o = 4, ml = u32(o); o += 4;
      var mime = ''; for (var i = 0; i < ml && i < 64; i++) mime += String.fromCharCode(b[o + i]); o += ml;
      var dl = u32(o); o += 4 + dl;
      var w = u32(o), h = u32(o + 4); o += 16;
      var len = u32(o); o += 4;
      if (len <= 0 || o + len > b.length || mime === '-->') return null;      // '-->' = a link, not an image
      var data = b.subarray(o, o + len);
      return { mime: sniffMime(data, mime), w: w, h: h, data: data };
    } catch (e) { return null; }
  }
  /** ID3v2.2/2.3/2.4 tag (from byte 0) -> the front cover (APIC/PIC; type 3 preferred) as {mime, data}. */
  function parseId3Picture(b) {
    function ss(o) { return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f); }
    function unsync(x) { var out = new Uint8Array(x.length), n = 0; for (var i = 0; i < x.length; i++) { out[n++] = x[i]; if (x[i] === 0xFF && x[i + 1] === 0x00) i++; } return out.subarray(0, n); }
    try {
      if (!b || b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
      var ver = b[3], flags = b[5], end = Math.min(b.length, 10 + ss(6));
      if ((flags & 0x80) && ver < 4) { b = unsync(b.subarray(0, end)); end = b.length; }
      var o = 10;
      if (flags & 0x40) o += ver === 4 ? ss(10) : 4 + (((b[10] << 24) >>> 0) + (b[11] << 16) + (b[12] << 8) + b[13]);
      var best = null, hdr = ver === 2 ? 6 : 10;
      while (o + hdr <= end) {
        var id = String.fromCharCode.apply(null, Array.prototype.slice.call(b, o, o + (ver === 2 ? 3 : 4)));
        if (!/^[A-Z0-9]{3,4}$/.test(id)) break;                                    // padding
        var size = ver === 2 ? (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5]
          : ver === 4 ? ss(o + 4) : ((b[o + 4] << 24) >>> 0) + (b[o + 5] << 16) + (b[o + 6] << 8) + b[o + 7];
        if (size <= 0) break;
        var d = o + hdr, de = Math.min(end, d + size);
        if (id === 'APIC' || id === 'PIC') {
          var f = b.subarray(d, de), ff = ver === 4 ? b[o + 9] : 0;
          if (ff & 0x01) f = f.subarray(4);                                       // data-length indicator
          if (ff & 0x02) f = unsync(f);
          var enc = f[0], p = 1, mime = '';
          if (id === 'PIC') { mime = String.fromCharCode(f[1], f[2], f[3]) === 'PNG' ? 'image/png' : 'image/jpeg'; p = 4; }
          else { while (p < f.length && f[p] !== 0) mime += String.fromCharCode(f[p++]); p++; }
          var type = f[p++];
          if (enc === 1 || enc === 2) { while (p + 1 < f.length && !(f[p] === 0 && f[p + 1] === 0)) p += 2; p += 2; }
          else { while (p < f.length && f[p] !== 0) p++; p++; }
          var data = f.subarray(p);
          if (data.length > 32 && (!best || (type === 3 && best.type !== 3))) best = { mime: sniffMime(data, mime), data: data, type: type, w: 0, h: 0 };
        }
        o = d + size;
      }
      return best;
    } catch (e) { return null; }
  }

  var artCanvas = null;
  function drawArtToCanvas(source) {
    try {
      var img = source || albumArtEl, label = albumArtEl.parentNode;
      var size = Math.round(((label && label.clientWidth) || 150) * 2);            // 2x for a sharp result
      var sw = source ? source.width : img.naturalWidth, sh = source ? source.height : img.naturalHeight;
      if (!sw || !sh) return false;
      if (!artCanvas) {
        artCanvas = document.createElement('canvas');
        artCanvas.id = 'albumArtCanvas';
        artCanvas.className = 'album-art';
        label.insertBefore(artCanvas, albumArtEl.nextSibling);
      }
      artCanvas.width = artCanvas.height = size;
      // centre square crop (like object-fit: cover), then halve step by step for smooth downscaling
      var side = Math.min(sw, sh), src = document.createElement('canvas'), sctx = src.getContext('2d');
      src.width = src.height = side;
      sctx.drawImage(img, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, side, side);
      var cur = src, cs = side;
      while (cs / 2 >= size) {
        var half = document.createElement('canvas'); half.width = half.height = Math.floor(cs / 2);
        var hctx = half.getContext('2d'); hctx.imageSmoothingEnabled = true; if ('imageSmoothingQuality' in hctx) hctx.imageSmoothingQuality = 'high';
        hctx.drawImage(cur, 0, 0, cs, cs, 0, 0, half.width, half.height);
        cur = half; cs = half.width;
      }
      var ctx = artCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = true; if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(cur, 0, 0, cs, cs, 0, 0, size, size);
      log('Artwork: cover ' + sw + '\u00d7' + sh + ' drawn at ' + size + ' px for the spinning vinyl');
      return true;
    } catch (e) { log('Artwork: smooth cover failed (' + e.message + ') \u2014 showing the image as is'); return false; }
  }

  function artUrlFor(track) {
    var u = String(track.artworkUrl), key = track.phoneId != null ? track.phoneId : (track.id || track.title || '');
    if (/^(data|blob):/i.test(u)) return u;
    return u + (u.indexOf('?') === -1 ? '?' : '&') + 'mbxart=' + encodeURIComponent(String(key));
  }

  // ---------- transport ----------

  function togglePlay() { playing ? pause() : play(); }

  function play() {
    if (!queue[queueIndex]) return;
    playing = true;
    pausedByUser = false;
    setScreenSaver(false);
    vinylEl.classList.add('playing');
    iconPlay.style.display = 'none'; iconPause.style.display = '';
    startPlaybackForCurrentTrack();
  }

  function startPlaybackForCurrentTrack() {
    var track = queue[queueIndex];
    if (!track || track.preflightPending) return;   // starts when the pre-flight check is done
    if (!track.isDemo && !backend) return;
    if (track.isDemo) {
      AudioEngine.resume();
      AudioEngine.startDemoSignal(); AudioEngine.setDemoPlaying(true); startDemoTick();
    } else {
      AudioEngine.setDemoPlaying(false);
      backend.play();
    }
  }

  function pause() {
    var wasPlaying = playing;
    if (!internalPausing) pausedByUser = true;
    playing = false; vinylEl.classList.remove('playing');
    setScreenSaver(true);
    iconPlay.style.display = ''; iconPause.style.display = 'none';
    AudioEngine.setDemoPlaying(false); stopDemoTick();
    var track = queue[queueIndex];
    if (track && !track.isDemo && backend) backend.pause();
    if (wasPlaying) send('PAUSE_STATE', { currentTime: getCurrentTime(), isPlaying: false }); // no echo if nothing changed
  }

  function resume() { if (!playing) play(); }

  /** The player stopped by itself (file can't play): not a pause the viewer asked for. */
  function internalPause() {
    if (!playing) return;
    internalPausing = true;
    try { pause(); } finally { internalPausing = false; }
  }

  /** TV screen saver: off while music plays, back on when paused/stopped/list ended. */
  function setScreenSaver(on) {
    if (screenSaverState === on) return;
    screenSaverState = on;
    try {
      var ac = window.webapis && webapis.appcommon;
      if (!ac || !ac.setScreenSaver) { log('Screen saver: API not available here' + (on ? '' : ' (emulator/browser)')); return; }
      var S = ac.AppCommonScreenSaverState;
      ac.setScreenSaver(on ? S.SCREEN_SAVER_ON : S.SCREEN_SAVER_OFF,
        function () { log('Screen saver: ' + (on ? 'on (not playing)' : 'off (playing)')); },
        function (e) { log('Screen saver: could not turn ' + (on ? 'on' : 'off') + ' (' + (e && (e.name || e.message)) + ')'); });
    } catch (e) { log('Screen saver: could not turn ' + (on ? 'on' : 'off') + ' (' + (e && (e.name || e.message)) + ')'); }
  }

  /** Absolute seek, in seconds (phone SEEK command). */
  function seek(timeSec) {
    var track = queue[queueIndex];
    if (!track) return;
    if (typeof Scratch !== 'undefined') Scratch.play();   // vinyl scratch on a seek, like the phone app
    if (track.isDemo) {
      demoElapsedSec = Math.max(0, Math.min(demoDurationSec, Number(timeSec) || 0));
      renderDemoProgress();
    } else if (backend) {
      backend.seek(Number(timeSec) || 0);
    }
    send('SEEK_RESULT', { currentTime: getCurrentTime(), duration: getDuration(), isPlaying: playing });
  }

  function seekBy(deltaSec) { seek(getCurrentTime() + deltaSec); }

  /** Kept for older phone builds: plays a bare URL. */
  function loadAndPlay(url, startPosition) {
    if (!url) return;
    BridgeShared.playTrackFromUri({ startAt: startPosition }, url);
  }

  /** Next song. A phone queue is played in the order the phone sent (the
   *  phone shuffles it), so both screens always agree on what's next. */
  function next(reason) {
    if (!queue.length) return false;
    if (phoneQueue && queueIndex >= queue.length - 1) {
      if (repeatMode !== 'all') return false;     // end of the playlist
      queueIndex = 0;
    } else {
      queueIndex = pickNextIndex();
    }
    loadCurrent(); trackChanged(reason || 'next');
    return true;
  }
  /** Previous: restart the song if more than 3 s in (like Spotify), else go back one. */
  function prev() {
    if (!queue.length) return;
    if (getCurrentTime() > 3 || (phoneQueue && queueIndex === 0 && repeatMode !== 'all')) { seek(0); return; }
    queueIndex = (queueIndex - 1 + queue.length) % queue.length;
    loadCurrent(); trackChanged('prev');
  }
  function skipTo(index) {
    if (index < 0 || index >= queue.length || index === queueIndex) return false;
    queueIndex = index; loadCurrent(); trackChanged('skip');
    return true;
  }
  /** Replace the queue but keep the current song playing (it's at `index` in the new list). */
  function replaceQueueKeepCurrent(tracks, index) {
    var cur = queue[queueIndex];
    queue = tracks.slice(); queueIndex = index;
    if (cur) queue[index] = cur;                  // keep the live track object (player state, flags)
    phoneQueue = true;
    hideUpNext();
  }
  function insertTracks(tracks, at) {
    if (!queue.length) { loadQueue(tracks, 0, true); play(); trackChanged('load'); return; }
    at = Math.max(0, Math.min(queue.length, at == null ? queue.length : at));
    Array.prototype.splice.apply(queue, [at, 0].concat(tracks));
    if (at <= queueIndex) queueIndex += tracks.length;
    hideUpNext();
  }
  function removeAt(index) {
    if (index < 0 || index >= queue.length || index === queueIndex) return false;
    queue.splice(index, 1);
    if (index < queueIndex) queueIndex--;
    hideUpNext();
    return true;
  }
  function setRepeat(mode) {
    repeatMode = mode === 'all' || mode === 'one' ? mode : 'off';
    btnRepeat.classList.toggle('active', repeatMode !== 'off');
    btnRepeat.classList.toggle('active-one', repeatMode === 'one');
  }
  function setShuffleFlag(on) { shuffle = !!on; btnShuffle.classList.toggle('active', shuffle); }
  function pickNextIndex() {
    if (shuffle && !phoneQueue && queue.length > 1) {
      var i; do { i = Math.floor(Math.random() * queue.length); } while (i === queueIndex);
      return i;
    }
    return (queueIndex + 1) % queue.length;
  }

  function onEnded() {
    hideUpNext();
    if (repeatMode === 'one') { var t = queue[queueIndex]; if (t) t.startAt = 0; loadCurrent(); trackChanged('repeat'); return; }
    var atEnd = queueIndex === queue.length - 1;
    if (atEnd && repeatMode === 'off' && (phoneQueue || !shuffle)) {
      internalPause();
      if (phoneQueue) { send('QUEUE_ENDED', { index: queueIndex, count: queue.length }); log('Queue: end of the list'); }
      setScreenSaver(true);
      return;
    }
    next('ended');
  }

  // ---------- "Up next" + warming up the next song ----------
  // ~25 s before the end: read the next file's header (pre-flight cache), so
  // the next song starts in well under a second. Last 12 s: show "Up next".
  function nearEnd(cur, dur) {
    var left = dur - cur;
    var nxt = phoneQueue ? (queueIndex < queue.length - 1 ? queue[queueIndex + 1] : (repeatMode === 'all' ? queue[0] : null)) : null;
    if (repeatMode === 'one') nxt = null;
    if (!nxt || nxt === queue[queueIndex]) return;
    if (left < 25 && !nxt.warmed && nxt.isPhoneStream && typeof Preflight !== 'undefined' && Preflight.needsCheck(nxt)) {
      nxt.warmed = true;
      log('Queue: getting the next song ready \u2014 ' + nxt.title);
      Preflight.check(nxt, function (plan) { if (plan && plan.info) findEmbeddedArt(nxt, plan.info); });
    } else if (left < 25 && !nxt.warmed && nxt.isPhoneStream) { nxt.warmed = true; sniffId3Art(nxt); }
    if (left < 12 && left > 0.5 && playing) showUpNext(nxt);
  }
  function showUpNext(t) {
    if (!upNextEl) {
      upNextEl = document.createElement('div');
      upNextEl.id = 'upNext';
      upNextEl.style.cssText = 'position:fixed;top:48px;right:56px;z-index:50;max-width:520px;padding:14px 22px;border-radius:14px;' +
        'background:rgba(0,0,0,.55);color:#fff;font:500 24px/1.3 sans-serif;backdrop-filter:blur(8px);transition:opacity .4s;opacity:0';
      document.body.appendChild(upNextEl);
    }
    if (upNextEl.__for === t) return;
    upNextEl.__for = t;
    var text = '<div style="min-width:0;flex:1">' +
      '<div style="font-size:16px;letter-spacing:.12em;opacity:.7">UP NEXT</div>' +
      '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(t.title) + '</div>' +
      '<div style="font-size:18px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(t.artist) + '</div></div>';
    upNextEl.style.display = 'flex'; upNextEl.style.alignItems = 'center'; upNextEl.style.gap = '16px';
    upNextEl.innerHTML = text;
    var thumbUrl = t.embeddedArtUrl || coverFromCache(t) || (t.artworkUrl && /^(https?|data|blob):/i.test(String(t.artworkUrl)) ? t.artworkUrl : null);
    if (thumbUrl) {                                      // small cover on the left; if it fails to load, text only
      var img = document.createElement('img');
      img.alt = ''; img.style.cssText = 'width:72px;height:72px;border-radius:8px;object-fit:cover;flex:none';
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      img.src = thumbUrl;
      upNextEl.insertBefore(img, upNextEl.firstChild);
    }
    setTimeout(function () { if (upNextEl) upNextEl.style.opacity = '1'; }, 20);
  }
  function hideUpNext() { if (upNextEl) { upNextEl.style.opacity = '0'; upNextEl.style.display = 'none'; upNextEl.__for = null; } }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function toggleShuffle() { shuffle = !shuffle; btnShuffle.classList.toggle('active', shuffle); }
  function cycleRepeat() {
    repeatMode = repeatMode === 'off' ? 'all' : (repeatMode === 'all' ? 'one' : 'off');
    btnRepeat.classList.toggle('active', repeatMode !== 'off');
    btnRepeat.classList.toggle('active-one', repeatMode === 'one');
  }

  // ---------- backend events ----------

  function onBackendReady() {
    if (pendingStartAt > 0 && backend) { backend.seek(pendingStartAt); pendingStartAt = 0; }
    var d = backend ? backend.getDuration() : 0;
    if (d) timeTotalEl.textContent = formatTime(d);
    var f = backend ? backend.getFormat() : null;
    setPathLabel(pathText(queue[queueIndex]));
    if (f) {
      setFormatLabel(PlayerBackends.formatLabel(f));
      send('PLAYBACK_FORMAT', f);
    }
  }

  // AVPlay's built-in spectrum (if the TV still provides it): normalise to 0..1
  // with a slowly-decaying peak, and hand it to the visualizer as a TV-side source.
  var bandPeak = 1;
  function onAvplayBands(bands) {
    if (!bands || !bands.length || typeof VisualizerManager === 'undefined') return;
    var mags = [], mx = 0;
    for (var i = 0; i < bands.length; i++) { var v = Math.abs(Number(bands[i]) || 0); mags.push(v); if (v > mx) mx = v; }
    bandPeak = Math.max(bandPeak * 0.995, mx, 1);
    VisualizerManager.setRemoteFrame(mags.map(function (v) { return v / bandPeak; }), null, 'tv');
  }

  function onBackendTime(cur, dur) {
    if (cur > 0.2) stopStallWatchdog();
    var tr = queue[queueIndex];
    if (tr && tr.fallbackTried && tr.forceBackend === avplay && cur > 0.3 && !tr.learned) { tr.learned = true; learnAvplay(tr); }
    var track = queue[queueIndex];
    if (!track || track.isDemo || !dur) return;
    if (cur > 0.5) track.lastPos = cur;
    var pct = (cur / dur) * 100;
    progressFill.style.width = pct + '%'; progressHandle.style.left = pct + '%';
    timeElapsedEl.textContent = formatTime(cur);
    send('PLAYBACK_PROGRESS', { currentTime: cur, duration: dur, isPlaying: playing, trackId: track.phoneId != null ? track.phoneId : (track.id || null), queueIndex: queueIndex });
    if (phoneQueue) nearEnd(cur, dur);
  }

  function onWaiting() {
    var track = queue[queueIndex];
    if (track && !track.isDemo) showBuffering();
  }

  function onBackendError(reason) {
    var track = queue[queueIndex];
    if (!track || track.isDemo) return;
    stopStallWatchdog();
    hideBuffering();
    var dolby = PlayerBackends.isDolbyTrack(track);

    // The connection to the phone dropped (seen on the real TV: the phone's
    // server vanished for ~1.5 min). That's not a codec problem, so don't
    // switch players: remember the position, show "Lost connection", and
    // resume on the same player once the phone is reachable again.
    // Seen 2026-10-25 14:57 (phone app sent to the background): CONNECTION_FAILED, then the retry's
    // "prepare failed (InvalidAccessError)" was taken for a codec problem -> the TV asked the phone
    // for a 16-bit "standard FLAC" and resumed at 0:00. While the phone is unreachable (link down,
    // or a network error in the last 30 s) every failure is a network failure.
    var phoneDown = track.isPhoneStream && (
      (typeof RemoteBridge !== 'undefined' && RemoteBridge.getStatus && RemoteBridge.getStatus() !== 'connected') ||
      (track.netErrAt && Date.now() - track.netErrAt < 30000));
    if (track.isPhoneStream && (isNetworkError(reason) || phoneDown)) {
      track.netErrAt = Date.now();
      var nowAt = getCurrentTime();
      // keep the real position: right after a (re)load the player says 0 although the song was at 3:20
      track.resumeAt = nowAt > 0.5 ? nowAt : (track.lastPos || track.resumeAt || track.startAt || 0);
      if (track.awaitingReconnect) { showConnectionLost(); return; }       // already waiting: don't stack retries
      track.awaitingReconnect = true;
      track.lastBackend = backend;
      showConnectionLost();
      if (window.__debugLog) window.__debugLog('Player: lost the stream (' + reason + ') \u2014 will resume at ' + formatTime(track.resumeAt) + ' when the phone is back');
      if (onStreamErrorCallback) onStreamErrorCallback(track, reason);
      // If the control link is still up, the phone is reachable: try again shortly.
      setTimeout(function () {
        if (track === queue[queueIndex] && track.awaitingReconnect &&
            typeof RemoteBridge !== 'undefined' && RemoteBridge.getStatus() === 'connected') resumeAfterReconnect();
      }, 6000);
      return;
    }

    // AVPlay rejected the file itself: find out what's inside it (async, for diagnosis only).
    if (backend === avplay && typeof FileProbe !== 'undefined' && !track.probed) {
      track.probed = true;
      var probedUri = track.uri, failReason = reason;
      FileProbe.probe(probedUri, function (info) {
        if (!info) return;
        if (window.__debugLog) window.__debugLog('File: ' + info.summary);
        send('FILE_PROBE', { id: track.id || null, url: probedUri, avplayError: failReason, summary: info.summary,
          container: info.container || null, id3Bytes: info.id3Bytes || 0, metadataBytes: info.metadataBytes || null,
          pictureBytes: info.pictureBytes || null, sampleRate: info.sampleRate || null, bitDepth: info.bitDepth || null,
          channels: info.channels || null });
      });
    }

    if (backend === avplay && dolby) {
      // AVPlay couldn't play the Dolby stream: play it decoded to stereo on <audio> rather than
      // not at all -- but never silently: the screen and the log say it is no longer Dolby.
      if (!track.dolbyFallback) {
        // e.g. "AVPLAY_DOLBY_FAILED: prepare failed (PLAYER_ERROR_NOT_SUPPORTED_FORMAT)" -> "prepare failed (PLAYER_ERROR_NOT_SUPPORTED_FORMAT)"
        track.dolbyFallback = String(reason || 'unknown error').replace(/^AVPLAY_(DOLBY_)?FAILED:\s*/, '').slice(0, 90);
        track.fallbackTried = true;                     // if <audio> fails too: don't bounce back to AVPlay
        log('Dolby -> stereo (AVPlay failed: ' + track.dolbyFallback + ')');
        send('BACKEND_FALLBACK', { from: 'avplay', to: 'html5', reason: reason, id: track.id || null, dolby: true });
        track.startAt = getCurrentTime();
        loadCurrent();
        return;
      }
      showPlaybackError('Dolby playback failed on the TV');
      failTrack(track, reason);
      return;
    }

    // Non-Dolby: try the other player once before giving up
    // (<audio> -> AVPlay, or AVPlay -> <audio>), from the same position.
    var other = backend === html5 ? avplay : html5;
    var otherUsable = other === html5 ? !(isFlac(track) && !html5Flac) : PlayerBackends.avplayAvailable();
    if (!track.fallbackTried && otherUsable) {
      track.fallbackTried = true;
      track.forceBackend = other;
      track.startAt = getCurrentTime();
      if (window.__debugLog) window.__debugLog('Player: ' + backend.name + ' failed (' + reason + ') \u2014 trying ' + other.name);
      send('BACKEND_FALLBACK', { from: backend.name, to: other.name, reason: reason, id: track.id || null });
      loadCurrent();
      return;
    }

    // Both players failed on the phone's stripped copy: the copy itself may be
    // what's broken, so try the untouched original once (only when the original
    // is within TV limits; a converted hi-res original would fail anyway).
    if (track.originalUri && track.uri !== track.originalUri && !track.originalTried &&
        track.preflight && !track.preflight.needsConvert) {
      track.originalTried = true;
      track.uri = track.originalUri;
      track.forceBackend = PlayerBackends.avplayAvailable() ? avplay : html5;
      track.startAt = 0;
      log('Player: both players failed on the phone\u2019s stripped stream (' + reason + ') \u2014 trying the original file');
      send('BACKEND_FALLBACK', { from: 'stripped', to: 'original', reason: reason, id: track.id || null });
      loadCurrent();
      return;
    }

    // Final safety net for lossless files: ask the phone for a normalized,
    // standard FLAC (24-bit, 44.1/48 kHz, stereo, standard blocks). Covers
    // in-spec oddities this TV may still reject (8/12/20-bit, unusual rates,
    // huge or variable blocks...).
    var lossless = PlayerBackends.isLosslessTrack(track) || /alac/i.test(String(track.codec));
    var phoneCan = typeof RemoteBridge !== 'undefined' && RemoteBridge.phoneSupports && RemoteBridge.phoneSupports('tvsafe');
    if (lossless && phoneCan && !track.normalizedTried && track.originalUri) {
      track.normalizedTried = true;
      normalizeViaPhone(track, reason);
      return;
    }

    // Both players failed (or no alternative): say why, including the
    // sample-rate limit if the file is above what this TV can decode.
    var rate = Number(track.sampleRate || track.sourceSampleRate || 0);
    if (rate > 48000) reason = 'SAMPLE_RATE_ABOVE_48K: Samsung 2023 TV decoders support up to 48 kHz; send a 48 kHz version (' + reason + ')';

    // Network failures were handled above, so this is the file itself: say so
    // (it used to show "Lost connection to phone", which pointed the wrong way).
    hideConnectionLost();
    showPlaybackError('Can\u2019t play this file on the TV' + (fileDesc(track) ? ' (' + fileDesc(track) + ')' : ''));
    if (!/^SAMPLE_RATE_ABOVE_48K/.test(reason)) reason = 'UNPLAYABLE_FORMAT: ' + reason;
    failTrack(track, reason);      // shows the play button, skips on in a playlist
  }

  function normalizeViaPhone(track, why) {
    track.originalTried = true;
    var src = Number((track.preflight && track.preflight.info && track.preflight.info.sampleRate) || track.sampleRate || 48000);
    var t = { rate: (src === 44100 || src === 48000) ? src : (src % 11025 === 0 ? 44100 : 48000), bits: 24, ch: 2 };
    log('Player: nothing could play this file (' + why + ') \u2014 asking the phone for a standard FLAC (' + t.bits + '-bit/' + t.rate + ' Hz/stereo)');
    send('BACKEND_FALLBACK', { from: 'original', to: 'normalized', reason: why, id: track.id || null });
    setStatusChip('Converting for TV\u2026');
    Preflight.prepare(track.originalUri, t, function (res, err) {
      if (queue[queueIndex] !== track) return;
      if (!res) { giveUp(track, why + '; phone could not convert: ' + err); return; }
      Preflight.verifyCopy(res.url, { sampleRate: res.sampleRate || t.rate }, function (bad) {
        if (queue[queueIndex] !== track) return;
        if (bad) { giveUp(track, why + '; converted copy broken: ' + bad); return; }
        track.uri = res.url; track.codec = 'FLAC'; track.mimeType = 'audio/flac'; track.realContainer = 'FLAC';
        track.sourceSampleRate = src !== t.rate ? src : null;
        track.sampleRate = t.rate; track.bitDepth = 24; track.channels = 2;
        track.forceBackend = PlayerBackends.avplayAvailable() ? avplay : html5;
        track.startAt = 0;
        loadCurrent();
      });
    });
  }

  function giveUp(track, reason) {
    hideBuffering(); hideConnectionLost();
    showPlaybackError('Can\u2019t play this file on the TV' + (fileDesc(track) ? ' (' + fileDesc(track) + ')' : ''));
    failTrack(track, 'UNPLAYABLE_FORMAT: ' + reason);
  }

  /**
   * A song finally failed (every fallback tried). Decide first what the queue
   * will do, so STREAM_ERROR can tell the phone (willSkip) and the phone does
   * not answer with a PLAY_TRACK that would bounce back to the broken song.
   */
  function failTrack(track, reason) {
    var current = queue[queueIndex] === track;
    var decision = queueDecision(track);
    track.failed = true; track.failedAt = Date.now();
    if (onStreamErrorCallback) onStreamErrorCallback(track, reason, { queueIndex: current ? queueIndex : queue.indexOf(track), willSkip: decision === 'skip' });
    internalPause();
    skipIfQueued(track, decision);
  }
  /** 'skip' (next song follows), 'end' (it was the last song) or 'stop' (not a queue, or the viewer had paused). */
  function queueDecision(track) {
    if (!phoneQueue || pausedByUser || queue[queueIndex] !== track) return 'stop';
    return (queueIndex < queue.length - 1 || repeatMode === 'all') ? 'skip' : 'end';
  }

  /** In a playlist, don't stop on a song that can't play: skip to the next one after a moment (like Spotify).
   *  Also while the next song is still loading after an auto-advance; not when the viewer had paused. */
  function skipIfQueued(track, decision) {
    track.failed = true;
    if (!track.failedAt) track.failedAt = Date.now();
    if (decision === 'skip' && !skipTimer) {
      log('Queue: \u201c' + track.title + '\u201d can\u2019t play \u2014 skipping to the next song in 2.5 s');
      skipTimer = setTimeout(function () {
        skipTimer = null;
        if (queue[queueIndex] !== track) return;
        if (pausedByUser) {                       // paused during the countdown: move on, but stay paused
          log('Queue: skipping \u201c' + track.title + '\u201d \u2014 next song loaded paused (viewer paused)');
          next('skipped');
          return;
        }
        log('Queue: skipping \u201c' + track.title + '\u201d (can\u2019t play it) \u2014 next song');
        if (next('skipped')) play();
      }, 2500);
    } else if (decision === 'end') {
      log('Queue: the last song (\u201c' + track.title + '\u201d) can\u2019t play \u2014 end of the list');
      send('QUEUE_ENDED', { index: queueIndex, count: queue.length, reason: 'last song failed' });
      setScreenSaver(true);
    }
  }

  function fileDesc(t) {
    var i = t.preflight && t.preflight.info;            // describe the file itself, not a converted copy
    if (i && i.container === 'FLAC') t = { codec: 'FLAC', bitDepth: i.bitDepth, sampleRate: i.sampleRate };
    var parts = [];
    if (t.codec) parts.push(String(t.codec).toUpperCase() === 'FLAC' ? 'FLAC' : (PlayerBackends.displayCodec(t.codec) || t.codec));
    if (t.bitDepth) parts.push(t.bitDepth + '-bit');
    if (t.sampleRate) parts.push(Math.round(t.sampleRate / 100) / 10 + ' kHz');
    return parts.join(' \u00b7 ');
  }

  function isNetworkError(reason) {
    var r = String(reason || '');
    if (/^HTML5_/.test(r)) return /^HTML5_MEDIA_ERROR: code 2\b/.test(r);   // <audio>: only MediaError code 2 is a network error
    var head = r.split(' (')[0];                                            // ignore free-text details from the player
    return /CONNECTION|NETWORK|TIMEOUT/i.test(head);
  }

  /** Called when the phone link (re)connects, or by a retry: reloads the
   *  current phone track on the same player at the remembered position. */
  function resumeAfterReconnect() {
    var track = queue[queueIndex];
    if (!track || track.isDemo || !track.awaitingReconnect) return false;
    track.awaitingReconnect = false;
    track.startAt = track.resumeAt || 0;
    track.forceBackend = track.lastBackend || null;
    track.fallbackTried = false;
    retryCount = 0;
    if (window.__debugLog) window.__debugLog('Player: phone is back \u2014 resuming at ' + formatTime(track.startAt));
    loadCurrent();
    return true;
  }
  function isAwaitingReconnect() { var t = queue[queueIndex]; return !!(t && t.awaitingReconnect); }

  function scheduleRetry() {
    if (retryTimeout || retryCount >= MAX_RETRIES) return;
    retryCount++;
    retryTimeout = setTimeout(function () {
      retryTimeout = null;
      var track = queue[queueIndex];
      if (!track || !track.isPhoneStream || backend !== html5) return;
      html5.reloadSameUrl(track.uri);
      if (playing) html5.play();
    }, 3000);
  }

  /** Called when a fresh URL arrives for the current phone track. */
  function retryCurrentTrackWithUri(trackId, newUri) {
    var track = queue[queueIndex];
    if (!track || track.id !== trackId) return;
    retryCount = 0;
    if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null; }
    track.uri = newUri; track.originalUri = newUri; track.preflightDone = false;
    track.startAt = getCurrentTime();
    track.fallbackTried = false; track.forceBackend = null; track.originalTried = false; track.normalizedTried = false; track.failed = false;  // new URL: start fresh
    loadCurrent();
  }

  // ---------- time ----------

  function getCurrentTime() {
    var track = queue[queueIndex];
    if (!track) return 0;
    // While the file is checked/loaded, report where it is about to start, not 0:
    // a phone that echoes the TV's position back would otherwise send it to 0:00.
    if (track.preflightPending || !backend) return track.isDemo ? demoElapsedSec : (pendingStartAt || Number(track.startAt) || 0);
    if (track.isDemo) return demoElapsedSec;
    var t = backend.getCurrentTime();
    return (pendingStartAt > 0 && t < 0.05) ? pendingStartAt : t;
  }
  /** Position on the screen's clock, pulled gently towards the player's reports (AVPlay reports
   *  only every 250-500 ms). Sent to the phone as STATE.position / PONG.position. */
  var sclk = { pos: 0, at: 0, raw: NaN, rawAt: 0, key: null };
  function getSmoothTime() {
    var raw = getCurrentTime(), now = (window.performance && performance.now()) || Date.now(), t = queue[queueIndex], key = t ? (t.originalUri || t.uri) : null;
    if (raw !== sclk.raw) { sclk.raw = raw; sclk.rawAt = now; }
    if (!playing || !t || t.preflightPending || !sclk.at || sclk.key !== key) { sclk.pos = raw; sclk.at = now; sclk.key = key; return raw; }
    var dt = Math.min(0.5, (now - sclk.at) / 1000); sclk.at = now;
    var est = sclk.raw + Math.min(0.75, (now - sclk.rawAt) / 1000), pred = sclk.pos + dt, err = est - pred;
    sclk.pos = Math.abs(err) > 0.35 ? est : pred + err * Math.min(1, dt * 5);
    var dur = getDuration(); if (dur && sclk.pos > dur) sclk.pos = dur;
    return sclk.pos;
  }
  function getDuration() {
    var track = queue[queueIndex];
    if (!track || track.preflightPending) return 0;
    if (track.isDemo) return demoDurationSec;
    return backend ? backend.getDuration() : 0;
  }

  // ---------- demo ticker ----------

  function startDemoTick() {
    stopDemoTick();
    demoTickInterval = setInterval(function () {
      demoElapsedSec++;
      if (demoElapsedSec >= demoDurationSec) { onEnded(); return; }
      renderDemoProgress();
    }, 1000);
  }
  function stopDemoTick() { if (demoTickInterval) clearInterval(demoTickInterval); demoTickInterval = null; }
  function renderDemoProgress() {
    var pct = (demoElapsedSec / demoDurationSec) * 100;
    progressFill.style.width = pct + '%'; progressHandle.style.left = pct + '%';
    timeElapsedEl.textContent = formatTime(demoElapsedSec);
  }

  // ---------- UI helpers ----------

  function resetProgress() { progressFill.style.width = '0%'; progressHandle.style.left = '0%'; timeElapsedEl.textContent = '0:00'; }
  function formatTime(sec) {
    sec = Math.floor(sec || 0);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  /** How the sound gets out, next to the format: passthrough vs decoded on the TV. */
  function pathText(track) {
    if (!track || track.isDemo || !backend) return '';
    var dolby = PlayerBackends.isDolbyTrack(track);
    if (backend === avplay) return dolby ? 'AVPlay \u00b7 Dolby passthrough' : 'AVPlay \u00b7 TV decoder';
    if (dolby && track.dolbyFallback) return 'Dolby \u2192 stereo (AVPlay failed: ' + track.dolbyFallback + ')';
    return 'Decoded on TV \u00b7 Stereo';
  }
  var pathEl = null;
  function setPathLabel(text) {
    if (!trackFormatEl) return;
    if (!pathEl) {
      pathEl = document.createElement('div');
      pathEl.id = 'trackPath';
      pathEl.style.cssText = 'margin-top:8px;font-size:16px;letter-spacing:.06em;color:rgba(255,255,255,.62);text-align:center';
      trackFormatEl.parentNode.insertBefore(pathEl, trackFormatEl.nextSibling);
    }
    pathEl.textContent = text || '';
    pathEl.style.display = text ? '' : 'none';
    pathEl.style.color = /failed/.test(text || '') ? '#ff8a6a' : 'rgba(255,255,255,.62)';
  }
  function setFormatLabel(text) {
    if (!trackFormatEl) return;
    trackFormatEl.textContent = text;
    trackFormatEl.classList.toggle('screen-hidden', !text);
  }
  function showBuffering() { if (bufferingEl) bufferingEl.classList.remove('screen-hidden'); }
  function hideBuffering() {
    if (!bufferingEl) return;
    bufferingEl.classList.add('screen-hidden');
    bufferingEl.textContent = 'Buffering\u2026';
  }
  function setStatusChip(text) {
    if (!bufferingEl) return;
    bufferingEl.textContent = text;
    bufferingEl.classList.remove('screen-hidden');
  }
  function showConnectionLost() { if (connectionLostEl) connectionLostEl.classList.remove('screen-hidden'); }
  function hideConnectionLost() { if (connectionLostEl) connectionLostEl.classList.add('screen-hidden'); }
  function showPlaybackError(text) {
    if (!playbackErrorEl) return;
    playbackErrorEl.textContent = text;
    playbackErrorEl.classList.remove('screen-hidden');
  }
  function hidePlaybackError() { if (playbackErrorEl) playbackErrorEl.classList.add('screen-hidden'); }

  /** One-time hint the first time a Dolby track plays. */
  function maybeShowDolbyHint() {
    if (!dolbyHintEl) return;
    try { if (localStorage.getItem('mbox_dolby_hint_shown')) return; localStorage.setItem('mbox_dolby_hint_shown', '1'); } catch (e) {}
    dolbyHintEl.classList.remove('screen-hidden');
    if (dolbyHintTimer) clearTimeout(dolbyHintTimer);
    dolbyHintTimer = setTimeout(function () { dolbyHintEl.classList.add('screen-hidden'); }, 15000);
  }

  function hideDolbyHint() {
    if (dolbyHintTimer) { clearTimeout(dolbyHintTimer); dolbyHintTimer = null; }
    if (dolbyHintEl) dolbyHintEl.classList.add('screen-hidden');
  }

  return {
    init: init, loadQueue: loadQueue, togglePlay: togglePlay, play: play, pause: pause,
    loadAndPlay: loadAndPlay, resume: resume, seek: seek,
    next: next, prev: prev, seekBy: seekBy, toggleShuffle: toggleShuffle, cycleRepeat: cycleRepeat,
    setOnStreamError: setOnStreamError, retryCurrentTrackWithUri: retryCurrentTrackWithUri,
    getCurrentTime: getCurrentTime, getDuration: getDuration, getSmoothTime: getSmoothTime,
    getLosslessEngine: getLosslessEngine, setLosslessEngine: setLosslessEngine,
    resumeAfterReconnect: resumeAfterReconnect, isAwaitingReconnect: isAwaitingReconnect,
    getBackendName: function () { return backend ? backend.name : 'demo'; },
    getFormat: function () { return backend ? backend.getFormat() : null; },
    isPlaying: function () { return playing; },
    markPausedByUser: function () { if (!pausedByUser) log('Player: viewer paused while nothing was playing \u2014 won\u2019t auto-start'); pausedByUser = true; },
    setOnTrackChange: setOnTrackChange, skipTo: skipTo, replaceQueueKeepCurrent: replaceQueueKeepCurrent,
    insertTracks: insertTracks, removeAt: removeAt, setRepeat: setRepeat, setShuffleFlag: setShuffleFlag,
    queueInfo: function () { return { index: queueIndex, length: queue.length, fromPhone: phoneQueue, repeat: repeatMode, shuffle: shuffle, items: queue }; },
    isLoading: function () { var t = queue[queueIndex]; return !!(t && (t.preflightPending || pendingStartAt > 0)); },
    hasFailed: function () { var t = queue[queueIndex]; return !!(t && (t.failed || t.awaitingReconnect)); },
    currentTrack: function () { return queue[queueIndex] || null; },
    currentCover: currentCover, setOnCover: function (fn) { onCoverCb = fn; }
  };
})();
