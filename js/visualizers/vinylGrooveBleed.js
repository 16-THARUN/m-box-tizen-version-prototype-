/* Vinyl Groove Bleed — phone spec D4: one closed spiky outline around the vinyl (a starburst),
 * 96 points, base R + 6 dp, spikes up to 70 dp from the bands (symmetric), 2 dp accent line,
 * turning with the vinyl. */
VisualizerRegistry.push({
  id: 'vinyl-groove-bleed', name: 'Vinyl Groove Bleed', category: 'Vinyl Ecosystem',
  draw: function (c, w, h, freq, time, t, v) {
    var d = VisUtil.dp(v), n = 96, L = VisUtil.levels('groove', freq, n), rot = VisUtil.vinylAngle();
    var r0 = v.radius + 6 * d, maxSp = Math.min(70 * d, VisUtil.ringMax(v, 76) - r0);
    c.save(); c.translate(v.x, v.y); c.rotate(rot);
    c.beginPath();
    for (var i = 0; i <= n; i++) {
      var k = i % n, a = VisUtil.angle(k, n), r = r0 + (k % 2 ? L[k] * maxSp : L[k] * maxSp * 0.35);
      if (i === 0) c.moveTo(Math.cos(a) * r, Math.sin(a) * r); else c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    c.closePath();
    c.fillStyle = VisUtil.rgbaTint(0, 0.12);
    c.fill();
    c.strokeStyle = VisUtil.rgbaTint(0.35, 0.95); c.lineWidth = 2 * d; c.lineJoin = 'round';
    c.stroke();
    c.restore();
  }
});
