/* Narrow Bars — phone spec 2B.4: 120 thin bars ~1.2 dp wide, round caps, from R + 4 dp, 2 dp up to
 * ~53 dp; accent at low energy shifting to the light tint, 55–100 % opacity. */
VisualizerRegistry.push({
  id: 'narrow-bars', name: 'Narrow Bars', category: 'Legacy Spectrum',
  draw: function (c, w, h, freq, time, t, v) {
    var d = VisUtil.dp(v), n = 120, L = VisUtil.levels('narrow', freq, n);
    var r0 = v.radius + 4 * d, maxLen = Math.min(53 * d, VisUtil.ringMax(v, 59) - r0);
    c.save(); c.translate(v.x, v.y); c.lineCap = 'round'; c.lineWidth = 1.2 * d;
    for (var i = 0; i < n; i++) {
      var e = L[i], len = 2 * d + e * (maxLen - 2 * d), a = VisUtil.angle(i, n), ca = Math.cos(a), sa = Math.sin(a);
      c.strokeStyle = VisUtil.rgbaTint(e, 0.55 + e * 0.45);
      c.beginPath(); c.moveTo(ca * r0, sa * r0); c.lineTo(ca * (r0 + len), sa * (r0 + len)); c.stroke();
    }
    c.restore();
  }
});
