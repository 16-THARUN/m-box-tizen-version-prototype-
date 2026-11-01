/**
 * preflight.js — check a lossless/unknown file BEFORE playing it.
 *
 * Instead of trying a player and discovering failure after a 12 s stall,
 * read the file's header first (FileProbe, ~256 KB over Wi-Fi) and decide:
 *   - what the file really is (FLAC / MP3 / MP4 / Ogg / WAV), whatever its name says
 *   - its real bit depth, sample rate, channels, tag/cover-art size
 *   - what the phone must change so this TV can play it
 *
 * The TV's native decoders (Samsung 2023 spec): up to 48 kHz; FLAC up to
 * 2 channels; up to 24-bit. Large cover art / ID3 in front of FLAC data made
 * AVPlay report NOT_SUPPORTED_FORMAT on the real TV.
 *
 * Phone side ("tvsafe" feature, advertised in /mbox/hello):
 *   <audioUrl>?tv=1                       FLAC with tags/art/ID3 stripped, audio bytes untouched (instant)
 *   <audioUrl>/prepare?tv=1&rate=&bits=&ch=   converts once (FFmpeg, cached), replies
 *       {"url": "...", "sampleRate": 48000, "bitDepth": 24, "channels": 2}
 */
var Preflight = (function () {
  var CAPS = { maxRate: 48000, maxBits: 24, maxCh: 2 };
  var PROBE_TIMEOUT_MS = 2500;                  // a file that can't even be read this fast won't play either
  var PREPARE_TIMEOUT_MS = 180000;
  var TAIL_TIMEOUT_MS = 10000;                  // MP4 with its index at the end: one extra read
  var cache = {};                       // original url -> plan (a re-sent PLAY_TRACK won't probe again)

  function needsCheck(track) {
    var s = (String(track.codec || '') + ' ' + String(track.mimeType || '') + ' ' + String(track.uri || '')).toLowerCase();
    if (/flac|alac|wav|pcm|aiff/.test(s)) return true;             // lossless: always check
    if (/audio\/mp4|\.m4a|\.mp4/.test(s)) return true;            // MP4/M4A: find out what's inside (ALAC? Dolby?)
    if (!track.codec && !track.mimeType) return true;               // unknown: check what it is
    return /octet-stream/.test(s);
  }

  function kHz(hz) { var k = Math.round(hz / 100) / 10; return (k % 1 === 0 ? k.toFixed(0) : k) + ' kHz'; }

  /** Turn probe results into a plan. */
  function makePlan(info) {
    var plan = { info: info, container: info.container, codec: info.codec || null, transforms: null, reasons: [], needsConvert: false };
    var alac = info.container === 'MP4' && info.codec === 'ALAC';
    if (info.container !== 'FLAC' && !alac) return plan;          // not lossless: just play it as what it is
    var t = alac ? {} : { strip: true };                           // stripping tags (FLAC only) is lossless and always safe
    if (info.id3Bytes) plan.reasons.push('ID3 tag in front');
    if (info.pictureBytes > 262144 || /continues past/.test((info.notes || []).join(' '))) plan.reasons.push('large cover art');
    if (info.sampleRate > CAPS.maxRate) {
      t.rate = info.sampleRate % 44100 === 0 ? 44100 : 48000;      // whole-number ratio: 88.2/176.4 -> 44.1, 96/192 -> 48
      plan.reasons.push(kHz(info.sampleRate) + ' \u2192 ' + kHz(t.rate));
    }
    if (info.bitDepth > CAPS.maxBits) { t.bits = CAPS.maxBits; plan.reasons.push(info.bitDepth + '-bit \u2192 24-bit'); }
    if (info.channels > CAPS.maxCh) { t.ch = CAPS.maxCh; plan.reasons.push(info.channels + ' ch \u2192 stereo'); }
    plan.transforms = t;
    plan.needsConvert = !!(t.rate || t.bits || t.ch);
    return plan;
  }

  function check(track, cb) {
    var key = track.originalUri || track.uri;
    if (cache[key]) { cb(cache[key]); return; }
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; cb(null, 'no answer within ' + PROBE_TIMEOUT_MS / 1000 + ' s'); } }, PROBE_TIMEOUT_MS);
    FileProbe.probe(key, function (info) {
      if (done) return; done = true; clearTimeout(timer);
      if (!info || !info.container) { cb(null, info && info.summary); return; }
      if (info.container === 'MP4' && !info.codec && info.moovSearchFrom != null && FileProbe.readTail) {
        // codec details at the END of the file (seen with "The True Leader"): read them there
        // before anything is decided -- otherwise a Dolby song can't be recognised from the file.
        var tailDone = false;
        var tailTimer = setTimeout(function () { if (!tailDone) { tailDone = true; info.tailError = 'reading the end of the file took over ' + TAIL_TIMEOUT_MS / 1000 + ' s'; var p0 = makePlan(info); cb(p0); } }, TAIL_TIMEOUT_MS);
        FileProbe.readTail(key, info, function (full) {
          if (tailDone) return; tailDone = true; clearTimeout(tailTimer);
          var p1 = makePlan(full);
          if (full.codec) cache[key] = p1;
          cb(p1);
        });
        return;
      }
      var plan = makePlan(info);
      cache[key] = plan;
      cb(plan);
    });
  }

  function withQuery(url, params) {
    var q = Object.keys(params).filter(function (k) { return params[k] != null; })
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return url + (url.indexOf('?') === -1 ? '?' : '&') + q;
  }
  function strippedUrl(url) { return withQuery(url, { tv: 1 }); }

  /** Ask the phone to convert; calls back with { url, sampleRate, bitDepth, channels } or null. */
  function prepare(url, t, cb) {
    var parts = url.split('?');
    var prepUrl = withQuery(parts[0] + '/prepare' + (parts[1] ? '?' + parts[1] : ''), { tv: 1, rate: t.rate, bits: t.bits, ch: t.ch });
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', prepUrl, true);
      xhr.timeout = PREPARE_TIMEOUT_MS;
      xhr.onload = function () {
        if (xhr.status !== 200) { cb(null, 'HTTP ' + xhr.status); return; }
        try { var r = JSON.parse(xhr.responseText); cb(r && r.url ? r : null, r && r.url ? null : 'no url in reply'); }
        catch (e) { cb(null, 'bad reply'); }
      };
      xhr.onerror = function () { cb(null, 'network error'); };
      xhr.ontimeout = function () { cb(null, 'timed out'); };
      xhr.send();
    } catch (e) { cb(null, e.message); }
  }

  function same(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Name what a broken copy contains where its audio should start, by
   *  matching those bytes against the original file. */
  function whatIsThere(c, orig) {
    var at = c.audioOffset, got = (c.head || []).slice(at, at + 16);
    if (got.length < 4) return '';
    function eq(a, b) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
    if (got[0] === 0x66 && got[1] === 0x4C && got[2] === 0x61 && got[3] === 0x43) return ': the phone put the whole original file (from byte 0) after its header';
    var oh = orig && orig.head;
    if (oh && orig.blocks) {
      for (var i = 0; i < orig.blocks.length; i++) {
        var bl = orig.blocks[i];
        if (bl.offset + got.length <= oh.length && eq(got, oh.slice(bl.offset, bl.offset + got.length)))
          return ': the phone continued from byte ' + bl.offset + ' of the original (its ' + FileProbe.blockName(bl.type) + ' block) instead of the first audio frame at byte ' + orig.audioOffset;
      }
    }
    var hex = got.slice(0, 4).map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join(' ');
    return ': found bytes ' + hex + (orig && orig.audioOffset != null ? ' (the original\u2019s audio starts at byte ' + orig.audioOffset + ')' : '');
  }

  /** Check that a copy of a FLAC the phone serves (stripped or converted) is
   *  real, playable FLAC before handing it to a player. `expect` is either the
   *  original file's probe info (stripped copy: same audio, byte for byte) or
   *  {sampleRate, bitDepth, channels} for a converted copy.
   *  Calls back (null) when fine, or (reason) when not. */
  function verifyCopy(url, expect, cb) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; cb('no answer within 3 s'); } }, 3000);
    FileProbe.probe(url, function (c) {
      if (done) return; done = true; clearTimeout(timer);
      if (!c || !c.container) { cb((c && c.summary) || 'unreadable'); return; }
      if (c.container !== 'FLAC') { cb('not FLAC (starts like ' + c.container + ')'); return; }
      if (c.audioOffset == null) { cb('metadata never ends (missing "last block" flag)'); return; }
      if (!c.firstFrameOk) { cb('no audio frame at byte ' + c.audioOffset + ' where the header ends' + whatIsThere(c, expect)); return; }
      if (expect.streaminfo) {                                         // stripped copy of the same file
        if (!same(c.streaminfo, expect.streaminfo)) { cb('STREAMINFO differs from the original file'); return; }
        if (expect.firstFrame && !same(c.firstFrame, expect.firstFrame.slice(0, c.firstFrame.length))) { cb('first audio frame differs from the original'); return; }
        if (expect.totalBytes && c.totalBytes && expect.audioOffset != null &&
            c.totalBytes - c.audioOffset !== expect.totalBytes - expect.audioOffset) {
          cb('size mismatch: audio part is ' + (c.totalBytes - c.audioOffset) + ' B, original has ' + (expect.totalBytes - expect.audioOffset) + ' B');
          return;
        }
      } else {                                                         // converted copy
        if (expect.sampleRate && c.sampleRate !== expect.sampleRate) { cb('converted file is ' + c.sampleRate + ' Hz, asked for ' + expect.sampleRate); return; }
        if (c.bitDepth > CAPS.maxBits || c.channels > CAPS.maxCh || c.sampleRate > CAPS.maxRate) { cb('converted file is still outside TV limits (' + c.summary + ')'); return; }
      }
      cb(null, c);
    }, 65536);
  }

  return { needsCheck: needsCheck, verifyCopy: verifyCopy, check: check, makePlan: makePlan, strippedUrl: strippedUrl, prepare: prepare, CAPS: CAPS,
           _clearCache: function () { cache = {}; } };
})();
