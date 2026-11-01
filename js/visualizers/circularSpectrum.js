/* Circular Spectrum — phone spec D3: 72 thin rays from R + 4 dp, long and spiky on beats, turning
 * with the vinyl. Rays reach up to R + 110 dp but stop above the title. */
VisualizerRegistry.push({
  id: 'circular-spectrum', name: 'Circular Spectrum', category: 'Vinyl Ecosystem',
  draw: function (c, w, h, freq, time, t, v) {
    var d = VisUtil.dp(v), n = 72, L = VisUtil.levels('circ', freq, n), rot = VisUtil.vinylAngle();
    var r0 = v.radius + 4 * d, rMax = VisUtil.ringMax(v, 110), maxLen = rMax - r0;
    c.save(); c.translate(v.x, v.y); c.rotate(rot); c.lineCap = 'round';
    for (var i = 0; i < n; i++) {
      var e = L[i], a = VisUtil.angle(i, n), len = 3 * d + Math.pow(e, 1.3) * maxLen;
      c.strokeStyle = VisUtil.rgbaTint(e * 0.8, 0.45 + e * 0.55);
      c.lineWidth = (1.5 + e) * d;
      c.beginPath(); c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); c.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len)); c.stroke();
    }
    c.restore();
  }
});
