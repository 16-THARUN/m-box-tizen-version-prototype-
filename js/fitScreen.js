/**
 * fitScreen.js — PC browser only (recording / demos): the app is laid out for exactly 1920x1080
 * like the TV. In a smaller browser window it didn't fit (2026-11-01), so scale the whole page to
 * the window, centred, with black bars. Does nothing on the TV or the Tizen emulator.
 * window.__fit = {s, ox, oy} lets code that measures the screen map back to 1920x1080 coordinates.
 */
(function () {
  if (typeof tizen !== 'undefined') return;
  function fit() {
    var b = document.body, h = document.documentElement;
    if (!b) return;
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    var ox = (window.innerWidth - 1920 * s) / 2, oy = (window.innerHeight - 1080 * s) / 2;
    h.style.width = '100%'; h.style.height = '100%'; h.style.overflow = 'hidden'; h.style.background = '#000';
    b.style.transformOrigin = '0 0';
    b.style.transform = 'translate(' + ox + 'px,' + oy + 'px) scale(' + s + ')';
    window.__fit = { s: s, ox: ox, oy: oy };
  }
  window.addEventListener('resize', fit);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fit); else fit();
})();
