/* Hexagonal Audio Grid — phone spec B12 (the version the phone went back to): hexagons (radius 10 dp)
 * in 3 rings around the vinyl from R + 8 dp, each lit by its band (15 % -> 90 %), growing to 1.2x
 * on beats. */
VisualizerRegistry.push({
  id: 'hexagonal-audio-grid', name: 'Hexagonal Audio Grid', category: 'Geometric',
  draw: function (c, w, h, freq, time, t, v) {
    var d = VisUtil.dp(v), bt = VisUtil.beat(freq), hr = 10 * d, rows = 3, rMax = VisUtil.ringMax(v, 76);
    c.save(); c.translate(v.x, v.y); c.lineWidth = 1;
    for (var k = 0; k < rows; k++) {
      var ring = v.radius + 8 * d + hr + k * hr * 1.75;
      if (ring + hr > rMax) break;
      var n = Math.floor(2 * Math.PI * ring / (hr * 1.9)), L = VisUtil.levels('hex' + k, freq, n), off = (k % 2) * Math.PI / n;
      for (var i = 0; i < n; i++) {
        var a = VisUtil.angle(i, n) + off, e = L[i], x = Math.cos(a) * ring, y = Math.sin(a) * ring;
        var s = hr * (0.92 + (e > 0.6 ? bt.pulse * 0.2 : 0)) * (1 - k * 0.06);
        c.beginPath();
        for (var q = 0; q < 6; q++) { var ha = a + q * Math.PI / 3; if (q === 0) c.moveTo(x + Math.cos(ha) * s, y + Math.sin(ha) * s); else c.lineTo(x + Math.cos(ha) * s, y + Math.sin(ha) * s); }
        c.closePath();
        c.fillStyle = VisUtil.rgbaTint(k / 2, 0.15 + e * 0.75); c.fill();
        c.strokeStyle = 'rgba(255,255,255,' + (0.06 + e * 0.2).toFixed(3) + ')'; c.stroke();
      }
    }
    c.restore();
  }
});
