/** Shared helpers for visualizers (namespaced to avoid global clashes). */
var VisUtil = {
  ACCENT: '#ff6a1a',
  /** Average energy 0..1 of band i out of n, across the musically useful bins. */
  band: function (freq, i, n, span) {
    span = span || 0.7;
    var useful = Math.floor(freq.length * span), from = Math.floor(i / n * useful), to = Math.max(from + 1, Math.floor((i + 1) / n * useful));
    var s = 0; for (var k = from; k < to; k++) s += freq[k];
    return s / (to - from) / 255;
  },
  /** Average energy 0..1 between two fractions of the spectrum (e.g. 0..0.08 = bass). */
  energy: function (freq, a, b) {
    var from = Math.floor(freq.length * a), to = Math.max(from + 1, Math.floor(freq.length * b)), s = 0;
    for (var k = from; k < to; k++) s += freq[k];
    return s / (to - from) / 255;
  },
  rgba: function (a) { return 'rgba(255,106,26,' + Math.max(0, Math.min(1, a)).toFixed(3) + ')'; }
};
var VisualizerRegistry = VisualizerRegistry || [];

/* ---------- shared helpers that match the phone app's visualizer spec ----------
 * Sizes follow the phone's dp numbers, scaled so the phone's vinyl radius (≈130 dp) maps to the
 * TV's vinyl radius: VisUtil.dp(v) = v.radius / 130 px per dp (≈1.46 on the TV).
 * Ring styles (phone FIX 2 B / 2B): drawn in a ring from R + 1 dp to R + 59 dp around the vinyl,
 * never over the title or the top label (v.maxR caps every radius).
 * Symmetric mapping (phone FIX 3): angle 0 = top, clockwise; bass at the top and bottom, highs at
 * the left and right; every ring is symmetric left/right and top/bottom. */
VisUtil.TINT = '#ffc3a3';                                     // accent mixed ~60 % toward white
VisUtil.dp = function (v) { return Math.max(0.6, v.radius / 130); };
VisUtil.ringMax = function (v, dpMax) { var d = VisUtil.dp(v); return Math.max(v.radius + 8 * d, Math.min(v.radius + dpMax * d, v.maxR || 1e9)); };
VisUtil.angle = function (i, n) { return -Math.PI / 2 + (i / n) * Math.PI * 2; };
VisUtil.symB = function (i, n) { var m = Math.min(i, n - i) / (n / 2); return Math.min(m, 1 - m) * 2; };   // 0 = bass .. 1 = highs
VisUtil.rgbaTint = function (k, a) {                           // k 0 = accent .. 1 = light tint
  var r = 255, g = Math.round(106 + (195 - 106) * k), b = Math.round(26 + (163 - 26) * k);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';
};
VisUtil._lv = {};
/** n symmetric levels 0..1 for a ring of n positions: 32 bands, auto gain (slow peak over ~3 s),
 *  fast rise / slower fall (phone: attack ~70 %, decay ~22 % per 60 fps frame), time-based. */
VisUtil.levels = function (key, freq, n) {
  var S = VisUtil._lv[key];
  if (!S || S.n !== n) S = VisUtil._lv[key] = { n: n, val: new Float32Array(n), bands: new Float32Array(32), peak: 0.3, at: 0 };
  var now = performance.now(), dt = S.at ? Math.min(0.1, (now - S.at) / 1000) : 1 / 60; S.at = now;
  var mx = 0;
  for (var b = 0; b < 32; b++) { S.bands[b] = VisUtil.band(freq, b, 32); if (S.bands[b] > mx) mx = S.bands[b]; }
  S.peak = Math.max(mx, S.peak * Math.exp(-dt / 3), 0.18);      // auto gain: quiet songs still use the full range
  var g = 1 / S.peak, up = 1 - Math.pow(0.3, dt * 60), down = 1 - Math.pow(0.78, dt * 60);
  for (var i = 0; i < n; i++) {
    var x = VisUtil.symB(i, n) * 31, i0 = Math.floor(x), f = x - i0, i1 = Math.min(31, i0 + 1);
    var target = Math.min(1, (S.bands[i0] * (1 - f) + S.bands[i1] * f) * g);
    var cur = S.val[i]; S.val[i] = cur + (target - cur) * (target > cur ? up : down);
  }
  return S.val;
};
VisUtil._bt = { hist: [], last: 0, prev: 0, at: 0, pulse: 0 };
/** Beat on the bass (35–150 Hz) — spectral flux above mean + 1.5 × std of the last second.
 *  Returns { beat: true on the frame of a beat, pulse: 1 right after a beat, falling to 0 in ~250 ms }. */
VisUtil.beat = function (freq) {
  var B = VisUtil._bt, now = performance.now(), dt = B.at ? Math.min(0.1, (now - B.at) / 1000) : 1 / 60; B.at = now;
  var bass = VisUtil.energy(freq, 0, 0.05), flux = Math.max(0, bass - B.prev); B.prev = bass;
  B.hist.push(flux); if (B.hist.length > 60) B.hist.shift();
  var m = 0, s = 0; B.hist.forEach(function (x) { m += x; }); m /= B.hist.length;
  B.hist.forEach(function (x) { s += (x - m) * (x - m); }); s = Math.sqrt(s / B.hist.length);
  var beat = flux > m + 1.5 * s && flux > 0.02 && bass > 0.2 && now - B.last > 230;
  if (beat) { B.last = now; B.pulse = 1; } else B.pulse = Math.max(0, B.pulse - dt / 0.25);
  return { beat: beat, pulse: B.pulse, bass: bass };
};
/** The vinyl's current spin angle (radians), so on-record styles turn with it. */
VisUtil.vinylAngle = function () {
  var el = document.getElementById('vinyl');
  if (!el) return 0;
  try {
    var an = el.getAnimations ? el.getAnimations() : null;
    if (an && an.length && an[0].currentTime != null) return ((an[0].currentTime % 6000) / 6000) * Math.PI * 2;
    var m = getComputedStyle(el).transform;
    if (m && m !== 'none') { var p = m.split('(')[1].split(',').map(parseFloat); return Math.atan2(p[1], p[0]); }
  } catch (e) {}
  return 0;
};
/** Rounded "pill" rectangle path (x, y = top-left). */
VisUtil.pill = function (c, x, y, wd, ht) {
  var r = Math.min(wd / 2, ht / 2);
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + wd - r, y); c.arc(x + wd - r, y + r, r, -Math.PI / 2, 0);
  c.lineTo(x + wd, y + ht - r); c.arc(x + wd - r, y + ht - r, r, 0, Math.PI / 2);
  c.lineTo(x + r, y + ht); c.arc(x + r, y + ht - r, r, Math.PI / 2, Math.PI);
  c.lineTo(x, y + r); c.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5); c.closePath();
};
