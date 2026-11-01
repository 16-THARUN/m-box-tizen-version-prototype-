/* Liquid Spline — phone spec B11: a smooth closed blob around the vinyl, 64 points, radius
 * R + 8 dp + band x 40 dp (symmetric), Catmull-Rom curve, 25 % fill, 2 dp line at 80 %.
 * The vinyl sits on top, so the blob only shows around it. */
VisualizerRegistry.push({
  id: 'liquid-spline', name: 'Liquid Spline', category: 'Minimalist Waveform',
  draw: function (c, w, h, freq, time, t, v) {
    var d = VisUtil.dp(v), n = 64, L = VisUtil.levels('spline', freq, n);
    var r0 = v.radius + 8 * d, amp = Math.min(40 * d, VisUtil.ringMax(v, 59) - r0), P = [];
    for (var i = 0; i < n; i++) {
      var a = VisUtil.angle(i, n) + Math.sin(t * 0.6 + i * 0.4) * 0.01, r = r0 + L[i] * amp;
      P.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    c.save(); c.translate(v.x, v.y);
    c.beginPath(); c.moveTo(P[0][0], P[0][1]);
    for (var k = 0; k < n; k++) {                                       // Catmull-Rom -> cubic Bezier
      var p0 = P[(k - 1 + n) % n], p1 = P[k], p2 = P[(k + 1) % n], p3 = P[(k + 2) % n];
      c.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
    c.closePath();
    c.fillStyle = VisUtil.rgbaTint(0.2, 0.25); c.fill();
    c.strokeStyle = VisUtil.rgbaTint(0.5, 0.8); c.lineWidth = 2 * d; c.stroke();
    c.restore();
  }
});
