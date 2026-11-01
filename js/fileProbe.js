/**
 * fileProbe.js
 *
 * When AVPlay rejects a file (e.g. PLAYER_ERROR_NOT_SUPPORTED_FORMAT on a
 * 24-bit FLAC that's otherwise like ones that play fine), read the first
 * 256 KB of it from the phone and report what's actually inside, so the
 * cause is known instead of guessed. Typical culprits:
 *   - an ID3v2 tag in front of the FLAC data ("ID3...fLaC")
 *   - very large embedded cover art (PICTURE block of several MB)
 *   - unusual stream parameters (32-bit, >2 channels, odd sample rate)
 */
var FileProbe = (function () {
  var PROBE_BYTES = 262144;

  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }
  function str(b, o, n) { var s = ''; for (var i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; }

  /** MP4/M4A: read the first audio sample entry in 'stsd' (only if the 'moov'
   *  index is near the start of the file, i.e. "fast start" files). */
  var MP4_CODECS = { 'alac': 'ALAC', 'mp4a': 'AAC', 'ec-3': 'E-AC-3', 'ac-3': 'AC-3', 'ac-4': 'AC-4', 'fLaC': 'FLAC', 'Opus': 'Opus', '.mp3': 'MP3' };
  function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
  function parseMp4Audio(b, info) {
    for (var i = 0; i + 40 < b.length; i++) {
      if (b[i] !== 0x73 || str(b, i, 4) !== 'stsd') continue;      // 's' 't' 's' 'd'
      var e = i + 12;                                              // first sample entry (after version/flags + count)
      var fourcc = str(b, e + 4, 4);
      if (!MP4_CODECS[fourcc]) continue;                          // e.g. a video track's stsd: keep looking
      info.codec = MP4_CODECS[fourcc];
      info.channels = (b[e + 24] << 8) | b[e + 25];
      var bits = (b[e + 26] << 8) | b[e + 27];
      var rate = (b[e + 32] << 8) | b[e + 33];                    // 16.16 fixed: can't hold >65535 Hz
      if (fourcc === 'alac' && str(b, e + 40, 4) === 'alac' && e + 72 <= b.length) {
        info.bitDepth = b[e + 53];                                 // ALACSpecificConfig has the real values
        info.channels = b[e + 57];
        info.sampleRate = u32(b, e + 68);
      } else {
        if (info.codec === 'FLAC') info.bitDepth = bits;
        if (rate) info.sampleRate = rate;
      }
      if (fourcc === 'ec-3') parseDec3(b, e, info);
      return;
    }
    info.notes.push('codec details are at the end of the file (no "fast start")');
  }

  /**
   * E-AC-3 'dec3' box (ETSI TS 102 366, Annex F), a child of the 'ec-3' sample entry:
   *   data_rate(13) num_ind_sub(3)
   *   per independent substream: fscod(2) bsid(5) reserved(1) asvc(1) bsmod(3) acmod(3) lfeon(1)
   *                              reserved(3) num_dep_sub(4) + (chan_loc(9) | reserved(1))
   *   optional: reserved(7) flag_ec3_extension_type_a(1) complexity_index_type_a(8)
   * flag_ec3_extension_type_a = Dolby Atmos (JOC); complexity_index_type_a = number of objects.
   * Sets info.isJoc (true/false; null if the box isn't there) and info.atmosObjects.
   */
  var ACMOD_CH = [2, 1, 2, 3, 3, 4, 4, 5];
  function parseDec3(b, entry, info) {
    info.isJoc = null; info.atmosObjects = null;
    var end = Math.min(b.length, entry + u32(b, entry)), p = entry + 36;      // children follow the 36-byte AudioSampleEntry
    while (p + 8 <= end) {
      var sz = u32(b, p);
      if (sz < 8) return;
      if (str(b, p + 4, 4) === 'dec3') {
        var o = p + 8, stop = Math.min(p + sz, b.length);
        if (o + 2 > stop) return;
        var numInd = (b[o + 1] & 0x07) + 1, q = o + 2, ch = 0;
        for (var k = 0; k < numInd; k++) {
          if (q + 3 > stop) return;
          var acmod = (b[q + 1] >> 1) & 0x07, lfe = b[q + 1] & 0x01, numDep = (b[q + 2] >> 1) & 0x0F;
          if (k === 0) ch = ACMOD_CH[acmod] + lfe;
          if (numDep > 0) {                                     // chan_loc(9): extra channels in dependent substreams
            if (q + 4 > stop) return;
            var loc = ((b[q + 2] & 0x01) << 8) | b[q + 3];
            var LOC_CH = [2, 2, 1, 1, 2, 2, 2, 1, 1];           // Lc/Rc, Lrs/Rrs, Cs, Ts, Lsd/Rsd, Lw/Rw, Lvh/Rvh, Cvh, LFE2
            for (var bit = 0; bit < 9; bit++) if (loc & (1 << (8 - bit))) ch += LOC_CH[bit];
            q += 4;
          } else q += 3;
        }
        if (ch && k === numInd) info.dolbyChannels = ch;
        if (q + 2 <= stop) {                                    // the optional Atmos extension is present
          info.isJoc = (b[q] & 0x01) === 1;
          info.atmosObjects = info.isJoc ? b[q + 1] : null;
        } else {
          info.isJoc = false;                                   // box read fully, no extension: plain Dolby Digital Plus
        }
        return;
      }
      p += sz;
    }
  }

  /** Walk the top-level MP4 boxes in the bytes we have (ftyp, free, mdat...).
   *  Returns the file offset of the first box that starts beyond them: with a
   *  big 'mdat' first, that is where the 'moov' index is ("not fast start"). */
  function nextTopLevelBox(b) {
    var i = 0;
    while (i + 8 <= b.length) {
      var size = u32(b, i), type = str(b, i + 4, 4);
      if (size === 1) { if (i + 16 > b.length) return null; size = u32(b, i + 8) * 4294967296 + u32(b, i + 12); }   // 64-bit size
      else if (size === 0) return null;                                    // box runs to the end of the file
      if (size < 8) return null;
      if (type === 'moov') return i;                                      // starts here but is cut off
      i += size;
    }
    return i;
  }

  /** The MP4's codec details sit at the end of the file: read them there.
   *  Range request for [from, from + 8 MB); if Range isn't honoured, a plain
   *  streamed GET read up to that point. Calls back with the updated info. */
  var TAIL_BYTES = 8 * 1024 * 1024;
  function readTail(url, info, cb) {
    var from = info.moovSearchFrom, t0 = Date.now();
    function use(buf, base, how) {
      var b = buf, i = from - base;
      while (i + 8 <= b.length) {
        var size = u32(b, i), type = str(b, i + 4, 4);
        if (size === 1) size = u32(b, i + 8) * 4294967296 + u32(b, i + 12);
        if (size < 8) break;
        if (type === 'moov') {
          var moov = b.subarray(i, Math.min(b.length, i + size));
          var before = info.notes.length;
          parseMp4Audio(moov, info);
          info.notes.splice(before);                                   // drop "details are at the end" from this pass
          if (info.codec) {
            info.codecFrom = 'end of file (' + how + ', ' + (Date.now() - t0) + ' ms)';
            info.notes = info.notes.filter(function (n) { return !/no "fast start"/.test(n); });
          }
          info.summary = summary(info);
          cb(info); return;
        }
        i += size;
      }
      info.tailError = 'no moov box found after byte ' + from + ' (' + how + ')';
      cb(info);
    }
    function streamed(why) {
      if (typeof fetch !== 'function') { info.tailError = why; cb(info); return; }
      fetch(url, { cache: 'no-store' }).then(function (resp) {
        if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
        var reader = resp.body.getReader(), want = from + TAIL_BYTES, parts = [], got = 0, pos = 0;
        function pump() {
          return reader.read().then(function (r) {
            if (r.value) {
              var v = r.value, a = Math.max(from, pos), e = Math.min(want, pos + v.length);
              if (e > a) { parts.push(v.slice(a - pos, e - pos)); got += e - a; }
              pos += v.length;
            }
            if (r.done || pos >= want) {
              try { reader.cancel(); } catch (x) {}
              var all = new Uint8Array(got), o = 0; parts.forEach(function (p) { all.set(p, o); o += p.length; });
              use(all, from, 'streamed GET after ' + why);
              return;
            }
            return pump();
          });
        }
        return pump();
      }).catch(function (e) { info.tailError = why + '; streamed GET: ' + (e && e.message || e); cb(info); });
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Range', 'bytes=' + from + '-' + (from + TAIL_BYTES - 1));
      xhr.responseType = 'arraybuffer';
      xhr.timeout = 8000;
      xhr.onload = function () {
        if (xhr.status === 206) { use(new Uint8Array(xhr.response), from, 'Range request'); return; }
        if (xhr.status === 200) { use(new Uint8Array(xhr.response), 0, 'whole file (Range ignored)'); return; }
        streamed('Range request: HTTP ' + xhr.status);
      };
      xhr.onerror = function () { streamed('Range request: network/CORS error'); };
      xhr.ontimeout = function () { streamed('Range request timed out'); };
      xhr.send();
    } catch (e) { streamed('Range request: ' + e.message); }
  }

  var BLOCK_NAMES = ['STREAMINFO', 'PADDING', 'APPLICATION', 'SEEKTABLE', 'VORBIS_COMMENT (tags)', 'CUESHEET', 'PICTURE (cover art)'];
  function blockName(t) { return BLOCK_NAMES[t] || ('block type ' + t); }

  function parse(b) {
    var info = { container: 'unknown', id3Bytes: 0, notes: [], head: Array.prototype.slice.call(b, 0, Math.min(b.length, 4096)) };
    var off = 0;
    if (str(b, 0, 3) === 'ID3') {                       // ID3v2 header: 10 bytes + syncsafe size (+10 if footer)
      var size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
      off = 10 + size + ((b[5] & 0x10) ? 10 : 0);
      info.id3Bytes = off;
    }
    var tag = str(b, off, 4);
    if (tag === 'fLaC') {
      info.container = 'FLAC';
      // Normal for MP3, but non-standard in front of FLAC — some players reject it.
      if (info.id3Bytes) info.notes.push('ID3v2 tag (' + kb(info.id3Bytes) + ') in front of the FLAC data (non-standard)');
      var p = off + 4, metaBytes = 0, pictureBytes = 0, last = false, blocks = 0;
      while (!last && p + 4 <= b.length) {
        var hdr = b[p]; last = !!(hdr & 0x80); var type = hdr & 0x7f;
        var len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
        if (type === 0 && p + 4 + 34 <= b.length) {     // STREAMINFO (34 bytes)
          var d = p + 4;
          info.minBlock = (b[d] << 8) | b[d + 1];
          info.maxBlock = (b[d + 2] << 8) | b[d + 3];
          info.minFrame = (b[d + 4] << 16) | (b[d + 5] << 8) | b[d + 6];
          info.maxFrame = (b[d + 7] << 16) | (b[d + 8] << 8) | b[d + 9];
          info.sampleRate = (b[d + 10] << 12) | (b[d + 11] << 4) | (b[d + 12] >> 4);
          info.channels = ((b[d + 12] >> 1) & 0x07) + 1;
          info.bitDepth = (((b[d + 12] & 0x01) << 4) | (b[d + 13] >> 4)) + 1;
          info.totalSamples = (b[d + 13] & 0x0F) * 4294967296 + u32(b, d + 14);
          var md5 = 0; for (var m = 18; m < 34; m++) md5 |= b[d + m];
          info.md5Set = md5 !== 0;
          info.streaminfo = Array.prototype.slice.call(b, d, d + 34);   // raw, to verify copies of this file
        }
        if (type === 3) info.seektable = len / 18;
        (info.blocks = info.blocks || []).push({ type: type, offset: p, length: len });
        if (type === 6) pictureBytes += len;
        metaBytes += 4 + len; blocks++;
        p += 4 + len;
      }
      info.metadataBytes = metaBytes; info.pictureBytes = pictureBytes;
      info.audioOffset = last ? p : null;                 // byte where the first audio frame starts
      if (last && p + 6 <= b.length) {
        info.firstFrameOk = b[p] === 0xFF && (b[p + 1] & 0xFE) === 0xF8;
        info.firstFrame = Array.prototype.slice.call(b, p, Math.min(p + 16, b.length));
      }
      if (info.sampleRate && info.totalSamples) info.durationSec = info.totalSamples / info.sampleRate;
      if (info.maxFrame && info.maxBlock && info.sampleRate)              // worst single frame, as a bitrate
        info.peakKbps = Math.round(info.maxFrame * 8 / (info.maxBlock / info.sampleRate) / 1000);
      // Valid but unusual: worth naming, in case a decoder dislikes it
      if (info.minBlock && info.maxBlock && info.minBlock !== info.maxBlock) info.notes.push('variable block size ' + info.minBlock + '\u2013' + info.maxBlock);
      if (info.maxBlock > 16384) info.notes.push('very large blocks (' + info.maxBlock + ' samples)');
      if (info.totalSamples === 0) info.notes.push('length not stored in the file (duration unknown)');
      if (last && info.firstFrameOk === false) info.notes.push('no audio frame where the metadata ends (damaged?)');
      if (!last) info.notes.push('metadata continues past the first ' + kb(PROBE_BYTES) + ' (huge tags/cover art)');
      if (pictureBytes > 1048576) info.notes.push('embedded cover art is ' + kb(pictureBytes));
      if (info.bitDepth && info.bitDepth > 24) info.notes.push(info.bitDepth + '-bit samples (TV decoders support up to 24-bit)');
      if (info.channels && info.channels > 2) info.notes.push(info.channels + ' channels');
      if (info.sampleRate && info.sampleRate > 48000) info.notes.push(info.sampleRate + ' Hz (TV decoders: up to 48 kHz)');
    } else if (str(b, 4, 4) === 'ftyp') {
      info.container = 'MP4';
      parseMp4Audio(b, info);
      if (!info.codec) info.moovSearchFrom = nextTopLevelBox(b);   // index is further on: where to look
    } else if (tag === 'OggS') info.container = 'Ogg';
    else if (tag === 'RIFF') info.container = 'WAV';
    else if (b[off] === 0xff && (b[off + 1] & 0xe0) === 0xe0) info.container = 'MPEG audio';
    else info.notes.push('no recognisable header at byte ' + off + ' ("' + tag.replace(/[^\x20-\x7e]/g, '.') + '")');
    return info;
  }

  function summary(i) {
    var s = i.container + (i.codec && i.container === 'MP4' ? ' (' + i.codec + ')' : '');
    if (i.bitDepth) s += ' ' + i.bitDepth + '-bit/' + i.sampleRate + ' Hz/' + i.channels + ' ch';
    else if (i.sampleRate) s += ' ' + i.sampleRate + ' Hz/' + i.channels + ' ch';
    if (i.avgKbps) s += ', ' + i.avgKbps + ' kbps avg' + (i.peakKbps ? ' (peak ' + i.peakKbps + ')' : '');
    if (i.durationSec) s += ', ' + Math.floor(i.durationSec / 60) + ':' + ('0' + Math.floor(i.durationSec % 60)).slice(-2);
    if (i.maxBlock) s += ', block ' + i.maxBlock;
    if (i.metadataBytes != null) s += ', tags ' + kb(i.metadataBytes) + (i.pictureBytes ? ' (art ' + kb(i.pictureBytes) + ')' : '');
    if (i.notes.length) s += ' \u2014 ' + i.notes.join('; ');
    return s;
  }

  /** Reads the start of `url` and calls back with { summary, ...details } (or null). */
  function finish(bytes, cb, how, totalBytes) {
    var info = parse(bytes);
    if (totalBytes) info.totalBytes = totalBytes;
    if (totalBytes && info.durationSec && info.audioOffset != null)
      info.avgKbps = Math.round((totalBytes - info.audioOffset) * 8 / info.durationSec / 1000);
    info.summary = summary(info);
    info.how = how;
    cb(info);
  }

  /** Reads the first 256 KB of `url` and calls back with { summary, ...details }.
   *  First choice: a plain GET (no custom headers, so no CORS preflight on any
   *  engine), reading the stream until 256 KB arrive, then cancelling. Fallback:
   *  a Range request. Failures carry the exact reason in `summary`. */
  function probe(url, cb, maxBytes) {
    var LIMIT = maxBytes || PROBE_BYTES;
    if (typeof fetch === 'function' && typeof ReadableStream !== 'undefined') {
      fetch(url, { mode: 'cors', cache: 'no-store' }).then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var total = Number(resp.headers.get('Content-Length')) || 0;
        if (!resp.body || !resp.body.getReader) throw new Error('no stream reader');
        var reader = resp.body.getReader(), buf = new Uint8Array(LIMIT), got = 0;
        function pump() {
          return reader.read().then(function (r) {
            if (!r.done && r.value) {
              var n = Math.min(r.value.length, LIMIT - got);
              buf.set(r.value.subarray(0, n), got); got += n;
            }
            if (r.done || got >= LIMIT) {
              try { reader.cancel(); } catch (e) {}
              finish(buf.subarray(0, got), cb, 'stream', total);
              return;
            }
            return pump();
          });
        }
        return pump();
      }).catch(function (e) { probeWithRange(url, cb, 'stream: ' + (e && e.message || e)); });
      return;
    }
    probeWithRange(url, cb, 'no fetch');
  }

  function probeWithRange(url, cb, firstError) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Range', 'bytes=0-' + (PROBE_BYTES - 1));
      xhr.responseType = 'arraybuffer';
      xhr.timeout = 5000;
      xhr.onload = function () {
        if (xhr.status !== 200 && xhr.status !== 206) { cb({ summary: 'probe failed: HTTP ' + xhr.status + ' (' + firstError + ')' }); return; }
        var cr = /\/(\d+)\s*$/.exec(xhr.getResponseHeader('Content-Range') || '');
        finish(new Uint8Array(xhr.response), cb, 'range', cr ? Number(cr[1]) : 0);
      };
      xhr.onerror = function () { cb({ summary: 'probe failed: request blocked or unreachable (' + firstError + '; Range request: network/CORS error)' }); };
      xhr.ontimeout = function () { cb({ summary: 'probe failed: timed out (' + firstError + ')' }); };
      xhr.send();
    } catch (e) { cb({ summary: 'probe failed: ' + e.message + ' (' + firstError + ')' }); }
  }

  return { probe: probe, parse: parse, blockName: blockName, readTail: readTail };
})();
