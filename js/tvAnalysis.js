/**
 * tvAnalysis.js — the TV's own visualizer data for songs played by AVPlay.
 *
 * AVPlay gives the app no audio, so the visualizer used frames from the
 * phone. On the real TV those frames came from the PHONE's player (its own
 * song and position), so the bars froze and burst at random, and stayed flat
 * after the TV moved to the next song. Here the TV downloads the same FLAC
 * file once more in the background, decodes it (wasm FLAC decoder, MIT,
 * js/flac-decoder.min.js) and builds a spectrum timeline: 20 frames/s, 32
 * bands. The visualizer draws it at the TV's own playback position, so it is
 * in sync with what plays, whatever the phone does.
 *
 *   TvAnalysis.start(url, onReady(timeline), log)  ->  job (job.stop())
 *   timeline = { fps, bands, frames: Uint8Array, count (grows), source: 'tv' }
 */
var TvAnalysis = (function () {
  var FPS = 20, BANDS = 32, N = 2048;

  // ---------- FFT (radix-2, in place) ----------
  var re = new Float32Array(N), im = new Float32Array(N), win = new Float32Array(N), rev = new Uint32Array(N);
  var cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2);
  (function () {
    for (var i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    var bits = Math.log(N) / Math.LN2;
    for (var j = 0; j < N; j++) { var r = 0, x = j; for (var b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[j] = r; }
    for (var k = 0; k < N / 2; k++) { cosT[k] = Math.cos(2 * Math.PI * k / N); sinT[k] = -Math.sin(2 * Math.PI * k / N); }
  })();
  function fft() {
    for (var i = 0; i < N; i++) { var j = rev[i]; if (j > i) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (var size = 2; size <= N; size <<= 1) {
      var half = size >> 1, step = N / size;
      for (var s = 0; s < N; s += size) {
        for (var k = 0; k < half; k++) {
          var c = cosT[k * step], sn = sinT[k * step], a = s + k, b = a + half;
          var tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  function bandEdges(rate) {                     // 32 log-spaced bands, 40 Hz .. 16 kHz
    var e = [], lo = 40, hi = Math.min(16000, rate / 2 - 1);
    for (var i = 0; i <= BANDS; i++) e.push(Math.max(1, Math.round(lo * Math.pow(hi / lo, i / BANDS) * N / rate)));
    return e;
  }

  function start(url, onReady, log) {
    var job = { stopped: false, stop: function () { this.stopped = true; try { if (this.reader) this.reader.cancel(); } catch (e) {} try { if (this.decoder) this.decoder.free(); } catch (e) {} } };
    var lib = window['flac-decoder'];
    if (!lib || typeof fetch === 'undefined') { log('Visualizer: TV analysis not available here'); return null; }
    var t0 = Date.now();
    var timeline = { fps: FPS, bands: BANDS, frames: new Uint8Array(FPS * BANDS * 600), count: 0, source: 'tv', row: new Array(BANDS) };
    var mono = new Float32Array(N * 4), have = 0, hop = 0, edges = null, smooth = new Float32Array(BANDS), announced = false;

    function pushSamples(channelData, rate) {
      if (!hop) { hop = Math.round(rate / FPS); edges = bandEdges(rate); }
      var ch = channelData.length, n = channelData[0].length;
      if (have + n > mono.length) { var bigger = new Float32Array(Math.max(mono.length * 2, have + n)); bigger.set(mono.subarray(0, have)); mono = bigger; }
      for (var i = 0; i < n; i++) { var v = 0; for (var c = 0; c < ch; c++) v += channelData[c][i]; mono[have + i] = v / ch; }
      have += n;
      var used = 0;
      while (have - used >= N) {                              // one frame per hop, window of N samples
        for (var j = 0; j < N; j++) { re[j] = mono[used + j] * win[j]; im[j] = 0; }
        fft();
        if ((timeline.count + 1) * BANDS > timeline.frames.length) { var f2 = new Uint8Array(timeline.frames.length * 2); f2.set(timeline.frames); timeline.frames = f2; }
        var o = timeline.count * BANDS;
        for (var b = 0; b < BANDS; b++) {
          var s = 0, a = edges[b], z = Math.max(a + 1, edges[b + 1]);
          for (var k = a; k < z; k++) { var m = re[k] * re[k] + im[k] * im[k]; if (m > s) s = m; }
          var db = 10 * Math.log(s / (N * N / 16) + 1e-12) / Math.LN10;          // ~0 dB at full scale
          var v2 = Math.max(0, Math.min(1, (db + 70) / 64));
          smooth[b] = v2 > smooth[b] ? v2 : smooth[b] * 0.72 + v2 * 0.28;       // fast attack, gentle release
          timeline.frames[o + b] = Math.round(smooth[b] * 255);
        }
        timeline.count++;
        used += hop;
      }
      if (used) { mono.copyWithin(0, used, have); have -= used; }
      if (!announced && timeline.count >= FPS) { announced = true; onReady(timeline); }
    }

    var Dec = lib.FLACDecoderWebWorker || lib.FLACDecoder;
    function begin(DecoderClass, fallback) {
      var dec;
      try { dec = new DecoderClass(); } catch (e) { if (fallback) return begin(fallback, null); log('Visualizer: TV analysis could not start (' + e.message + ')'); return; }
      job.decoder = dec;
      dec.ready.then(function () {
        if (job.stopped) return;
        return fetch(url).then(function (resp) {
          if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
          var reader = resp.body.getReader(); job.reader = reader;
          function pump() {
            if (job.stopped) return;
            return reader.read().then(function (r) {
              if (job.stopped) return;
              if (r.done) {
                log('Visualizer: TV analysed the whole song (' + (timeline.count / FPS).toFixed(0) + ' s) in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
                if (!announced) { announced = true; onReady(timeline); }
                try { dec.free(); } catch (e) {}
                return;
              }
              return Promise.resolve(dec.decode(r.value)).then(function (out) {
                if (!job.stopped && out && out.samplesDecoded) pushSamples(out.channelData, out.sampleRate);
                return pump();
              });
            });
          }
          return pump();
        });
      }).catch(function (e) {
        if (job.stopped) return;
        if (fallback && DecoderClass !== fallback) { try { dec.free(); } catch (x) {} log('Visualizer: worker decoder failed (' + e.message + ') — decoding on the main thread'); timeline.count = 0; have = 0; return begin(fallback, null); }
        log('Visualizer: TV analysis stopped (' + (e && e.message) + ')');
      });
    }
    begin(Dec, lib.FLACDecoder);
    log('Visualizer: TV is analysing the song itself for an in-sync spectrum');
    return job;
  }

  return { start: start };
})();
