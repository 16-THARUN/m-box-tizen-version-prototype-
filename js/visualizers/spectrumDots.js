/* Spectrum Dots — phone spec 2B.3: 32 angles x 5 rows from R + 10 dp, rows ~9 dp apart. Unlit dots
 * stay visible (1.6 dp, white 8 %); rows light from the inside out with energy, lit dots 3.2 dp,
 * 35–100 %, accent (inner) -> light tint (outer); the partly lit top row fades in. */
VisualizerRegistry.push({
  id: 'spectrum-dots', name: 'Spectrum Dots', category: 'Legacy Particles',
  draw: function (c, w, h, freq, time, t, v) {
    var d = VisUtil.dp(v), n = 32, rows = 5, L = VisUtil.levels('dots', freq, n);
    var r0 = v.radius + 10 * d, gap = Math.min(9 * d, (VisUtil.ringMax(v, 59) - r0) / (rows - 0.5));
    c.save(); c.translate(v.x, v.y);
    for (var i = 0; i < n; i++) {
      var a = VisUtil.angle(i, n), ca = Math.cos(a), sa = Math.sin(a), lit = L[i] * rows;
      for (var k = 0; k < rows; k++) {
        var r = r0 + k * gap, on = Math.max(0, Math.min(1, lit - k));
        c.fillStyle = 'rgba(255,255,255,0.08)';
        c.beginPath(); c.arc(ca * r, sa * r, 1.6 * d, 0, Math.PI * 2); c.fill();
        if (on > 0.01) {
          c.fillStyle = VisUtil.rgbaTint(k / (rows - 1), (0.35 + 0.65 * L[i]) * on);
          c.beginPath(); c.arc(ca * r, sa * r, (1.6 + 1.6 * on) * d, 0, Math.PI * 2); c.fill();
        }
      }
    }
    c.restore();
  }
});
