/**
 * _videoBackdrop.js — the "Premium Video Background" clips, played as a
 * flipbook on the visualizer canvas.
 *
 * Why not a <video> element: on Samsung TVs only one media player runs at a
 * time, so starting a background video can stop the music (AVPlay or <audio>).
 * Instead each clip is a pack of small JPEG frames (videos/<name>.bin + .json,
 * made from the phone app's clips). Frames are decoded one at a time
 * (createImageBitmap), so memory stays at a frame or two. The clip runs faster
 * with the music's energy and loops.
 */
var VideoBackdrop = (function () {
  var packs = {};

  function load(name) {
    var p = packs[name];
    if (p) return p;
    p = packs[name] = { state: 'loading', meta: null, data: null, bmp: {}, curIdx: 0, pending: false, clock: 0, last: 0, mix: null };
    function get(url, type, cb) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', url, true); x.responseType = type;
        x.onload = function () { cb(x.status === 200 || x.status === 0 ? x.response : null); };
        x.onerror = function () { cb(null); };
        x.send();
      } catch (e) { cb(null); }
    }
    get('videos/' + name + '.json', 'text', function (txt) {
      try { p.meta = JSON.parse(txt); } catch (e) { p.state = 'failed'; return; }
      get('videos/' + name + '.bin', 'arraybuffer', function (buf) {
        if (!buf) { p.state = 'failed'; return; }
        p.data = new Uint8Array(buf); p.state = 'ready';
        if (window.__debugLog) window.__debugLog('Visualizer: video background "' + name + '" ready (' + p.meta.frames.length + ' frames)');
      });
    });
    return p;
  }

  // Two frames are kept decoded (the one on screen and the next), and the picture fades from one
  // to the next between them, so a 10-12 fps clip moves smoothly at the screen's 60 fps.
  function decode(p, idx) {
    if (p.pending || p.bmp[idx]) return;
    var f = p.meta.frames[idx]; if (!f) return;
    p.pending = true;
    var blob = new Blob([p.data.subarray(f[0], f[0] + f[1])], { type: 'image/jpeg' });
    function done(img, release) {
      p.pending = false;
      p.bmp[idx] = { img: img, release: release || null };
      var keep = {}; keep[p.curIdx] = 1; keep[(p.curIdx + 1) % p.meta.frames.length] = 1; keep[idx] = 1;
      Object.keys(p.bmp).forEach(function (k) {
        if (keep[k]) return;
        var e = p.bmp[k]; delete p.bmp[k];
        if (e.img && e.img.close) try { e.img.close(); } catch (x) {}
        if (e.release) e.release();
      });
    }
    if (window.createImageBitmap) {
      createImageBitmap(blob).then(function (bmp) { done(bmp); }, function () { p.pending = false; });
    } else {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { done(img, function () { URL.revokeObjectURL(url); }); };
      img.onerror = function () { p.pending = false; URL.revokeObjectURL(url); };
      img.src = url;
    }
  }

  /** Draw clip `name` covering the canvas. energy 0..1 speeds it up; alpha = opacity. */
  function draw(c, w, h, name, energy, alpha) {
    var p = load(name);
    if (p.state !== 'ready') return false;
    if (!p.bmp) { p.bmp = {}; p.curIdx = 0; }
    var n = p.meta.frames.length, now = performance.now();
    var dt = p.last ? Math.min(0.1, (now - p.last) / 1000) : 0;
    p.last = now;
    var idx = Math.floor(p.clock) % n, nxt = (idx + 1) % n;
    if (!p.bmp[idx]) decode(p, idx);
    else if (!p.bmp[nxt]) decode(p, nxt);
    // run the clip clock (calm: slower, loud: faster), but never past a frame that isn't decoded yet
    var adv = dt * p.meta.fps * (0.55 + Math.min(1, energy) * 0.9);
    if (p.bmp[idx] && p.bmp[nxt]) p.clock += adv;
    else p.clock = Math.min(p.clock + adv, Math.floor(p.clock) + 0.999);
    idx = Math.floor(p.clock) % n; nxt = (idx + 1) % n;
    var a = p.bmp[idx], b = p.bmp[nxt], frac = p.clock - Math.floor(p.clock);
    if (a) p.curIdx = idx;
    else a = p.bmp[p.curIdx];
    if (!a) return false;
    var iw = p.meta.width, ih = p.meta.height, s = Math.max(w / iw, h / ih);
    // blend the two frames at the clip's own size (cheap), then draw that once, full screen
    if (!p.mix) { p.mix = document.createElement('canvas'); p.mix.width = iw; p.mix.height = ih; p.mctx = p.mix.getContext('2d'); }
    var m = p.mctx;
    m.globalAlpha = 1; m.drawImage(a.img, 0, 0, iw, ih);
    if (b && b !== a && frac > 0.01) { m.globalAlpha = frac; m.drawImage(b.img, 0, 0, iw, ih); m.globalAlpha = 1; }
    c.save();
    c.globalAlpha = Math.max(0, Math.min(1, alpha));
    c.drawImage(p.mix, (w - iw * s) / 2, (h - ih * s) / 2, iw * s, ih * s);
    c.restore();
    return true;
  }

  return { draw: draw, preload: load };
})();
