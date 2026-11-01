/**
 * ambientView.js — the calm Now Playing screen ("Ambient Cover" in the visualizer list).
 *
 * Like the Spotify TV screen: the cover fills the right of the screen and drifts very slowly,
 * a blurred, darkened copy of it fills the rest, and the title, artist and a small cover sit at
 * the bottom left. The buttons fade out after 5 s without a key press; the first arrow/OK press
 * only brings them back. Everything moves with CSS transforms (GPU), nothing is redrawn per frame.
 */
var AmbientView = (function () {
  var root = null, thumbEl = null, npEl = null;
  var active = false, idleTimer = null, coverUrl = null;
  var IDLE_MS = 5000;

  function init() {
    npEl = document.getElementById('nowPlaying');
    root = document.getElementById('ambient');
    if (!root || !npEl) return;
    thumbEl = document.getElementById('ambThumb');
    if (typeof Player !== 'undefined' && Player.setOnCover) Player.setOnCover(setCover);
    // Capture phase: runs before remote.js, so a key that only wakes the screen does nothing else.
    document.addEventListener('keydown', onKey, true);
  }

  function setActive(on) {
    on = !!on;
    if (!npEl) return;
    if (on === active) return;
    active = on;
    npEl.classList.toggle('np-ambient', on);
    if (on) { setCover(typeof Player !== 'undefined' && Player.currentCover ? Player.currentCover() : null); wake(); }
    else { npEl.classList.remove('np-idle'); clearTimeout(idleTimer); }
    if (window.__debugLog) window.__debugLog('Display: ' + (on ? 'Ambient Cover (calm screen)' : 'vinyl'));
  }

  // The background (blurred cover + sharp cover fading in from the left + dark shading for the text)
  // is drawn ONCE per song into a 1920x1080 canvas; only that one picture drifts, with a CSS
  // transform. A live CSS blur/mask on a moving full-screen layer was too slow (8 fps in tests).
  var layers = [], front = 0, loadTok = 0;
  function setCover(c) {
    var url = c ? (c.large || c.small) : null;
    if (url === coverUrl) return;
    coverUrl = url;
    if (thumbEl) { if (c && c.small) thumbEl.src = c.small; else thumbEl.removeAttribute('src'); thumbEl.style.visibility = c ? '' : 'hidden'; }
    if (!root) return;
    var tok = ++loadTok;
    if (!url) { show(compose(null)); return; }
    var img = new Image();
    img.onload = function () { if (tok === loadTok) show(compose(img)); };
    img.onerror = function () { if (tok === loadTok) show(compose(null)); };
    img.src = url;
  }
  function show(cv) {
    if (!cv) return;
    var old = layers[front];
    cv.className = 'amb-canvas';
    root.insertBefore(cv, root.firstChild);
    layers.push(cv); front = layers.length - 1;
    requestAnimationFrame(function () { cv.classList.add('on'); });       // fade in over the old one
    if (old) setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); layers = layers.filter(function (x) { return x !== old; }); front = layers.indexOf(cv); }, 900);
  }
  function compose(img) {
    var W = 1920, H = 1080, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var c = cv.getContext('2d');
    try {
      if (img) {
        var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, side = Math.min(iw, ih), sx = (iw - side) / 2, sy = (ih - side) / 2;
        // blurred background: shrink to 32x18, stretch back (smooth scaling = a soft blur)
        var t = document.createElement('canvas'); t.width = 32; t.height = 18;
        var tc = t.getContext('2d'); tc.imageSmoothingEnabled = true;
        tc.drawImage(img, sx, sy + side * 0.22, side, side * 0.5625, 0, 0, 32, 18);
        c.imageSmoothingEnabled = true; if ('imageSmoothingQuality' in c) c.imageSmoothingQuality = 'high';
        c.drawImage(t, 0, 0, 32, 18, -40, -40, W + 80, H + 80);
        c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(0, 0, W, H);
        // sharp cover on the right, full height, fading in from the left
        var a = document.createElement('canvas'); a.width = a.height = H;
        var ac = a.getContext('2d'); ac.imageSmoothingEnabled = true; if ('imageSmoothingQuality' in ac) ac.imageSmoothingQuality = 'high';
        ac.drawImage(img, sx, sy, side, side, 0, 0, H, H);
        ac.globalCompositeOperation = 'destination-in';
        var g = ac.createLinearGradient(0, 0, H, 0); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.38, 'rgba(0,0,0,1)');
        ac.fillStyle = g; ac.fillRect(0, 0, H, H);
        c.drawImage(a, W - H, 0);
      } else {
        var r = c.createRadialGradient(W * 0.7, H * 0.4, 0, W * 0.7, H * 0.4, W * 0.7);
        r.addColorStop(0, '#3a1a0a'); r.addColorStop(1, '#0b0b0d'); c.fillStyle = r; c.fillRect(0, 0, W, H);
      }
      // shading so the title and buttons stay readable
      var b = c.createLinearGradient(0, H, 0, 0); b.addColorStop(0, 'rgba(0,0,0,0.78)'); b.addColorStop(0.42, 'rgba(0,0,0,0.25)'); b.addColorStop(0.62, 'rgba(0,0,0,0)');
      c.fillStyle = b; c.fillRect(0, 0, W, H);
      var l = c.createLinearGradient(0, 0, W, 0); l.addColorStop(0, 'rgba(0,0,0,0.5)'); l.addColorStop(0.55, 'rgba(0,0,0,0)');
      c.fillStyle = l; c.fillRect(0, 0, W, H);
    } catch (e) { if (window.__debugLog) window.__debugLog('Display: couldn’t draw the calm background (' + e.message + ')'); }
    return cv;
  }

  function wake() {
    if (!npEl) return;
    npEl.classList.remove('np-idle');
    clearTimeout(idleTimer);
    if (!active) return;
    idleTimer = setTimeout(function () {
      var playing = typeof Player === 'undefined' || Player.isPlaying();
      var switcherOpen = document.getElementById('visSwitcher') && !document.getElementById('visSwitcher').classList.contains('hidden');
      if (active && playing && !switcherOpen) npEl.classList.add('np-idle'); else wake();
    }, IDLE_MS);
  }

  function onKey(e) {
    if (!active || typeof ScreenManager === 'undefined' || ScreenManager.current() !== 'nowPlaying') return;
    var wasIdle = npEl.classList.contains('np-idle');
    wake();
    // Arrows / OK while the buttons are hidden: just show them (don't seek or press something unseen).
    if (wasIdle && (e.keyCode === 37 || e.keyCode === 38 || e.keyCode === 39 || e.keyCode === 40 || e.keyCode === 13)) {
      e.preventDefault(); e.stopPropagation();
    }
  }

  return { init: init, setActive: setActive, isActive: function () { return active; }, wake: wake };
})();
