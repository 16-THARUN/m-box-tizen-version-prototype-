/**
 * scratch.js — a short vinyl-scratch sound when the viewer seeks (remote
 * FF/RW or the phone's seek bar), like the phone app's playVinylSound().
 * The phone's version plays res/raw/vinyl_scratch; the TV has no copy of that
 * sound, so it is made here: filtered noise swept down then up (~0.35 s).
 * Its own small Web Audio context: never touches the music player.
 */
var Scratch = (function () {
  var ctx = null, noise = null, lastAt = 0;
  function context() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { return null; }
    var len = Math.floor(ctx.sampleRate * 0.5), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noise = buf;
    return ctx;
  }
  function play() {
    var now = Date.now();
    if (now - lastAt < 600) return;                     // one scratch per seek gesture
    lastAt = now;
    var c = context(); if (!c) return;
    try {
      if (c.state === 'suspended' && c.resume) c.resume();
      var t = c.currentTime, src = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
      src.buffer = noise;
      bp.type = 'bandpass'; bp.Q.value = 6;
      bp.frequency.setValueAtTime(2600, t);
      bp.frequency.exponentialRampToValueAtTime(500, t + 0.14);    // "wicka" down…
      bp.frequency.exponentialRampToValueAtTime(1900, t + 0.32);   // …and back up
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.15);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
      src.connect(bp); bp.connect(g); g.connect(c.destination);
      src.start(t); src.stop(t + 0.38);
      if (window.__scratchCount != null) window.__scratchCount++;
    } catch (e) {}
  }
  return { play: play };
})();
