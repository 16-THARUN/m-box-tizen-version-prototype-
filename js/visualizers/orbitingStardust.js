/* Orbiting Stardust — phone spec B2 + D5: 28 dots orbiting at R + 12 … R + 60 dp, locked to the vinyl's
 * spin, 2–5 dp from their band, with a short fading trail; on every beat 6–10 sparks fly out
 * from the vinyl edge (60–140 dp over ~600 ms). */
(function () {
  var N = 28, sparks = [];
  VisualizerRegistry.push({
    id: 'orbiting-stardust', name: 'Orbiting Stardust', category: 'Vinyl Ecosystem',
    draw: function (c, w, h, freq, time, t, v) {
      var d = VisUtil.dp(v), L = VisUtil.levels('orbit', freq, N), bt = VisUtil.beat(freq), rot = VisUtil.vinylAngle();
      var rMax = VisUtil.ringMax(v, 140), now = performance.now();
      c.save(); c.translate(v.x, v.y);
      for (var i = 0; i < N; i++) {
        var e = L[i], orbit = v.radius + (12 + (i % 4) * 14 + bt.pulse * 8) * d;
        orbit = Math.min(orbit, rMax);
        for (var k = 2; k >= 0; k--) {                         // 3-dot trail behind each dot
          var a = rot + VisUtil.angle(i, N) - k * 0.05;
          c.fillStyle = VisUtil.rgbaTint(0.3 + e * 0.7, (0.4 + e * 0.6) * (1 - k * 0.32));
          c.beginPath(); c.arc(Math.cos(a) * orbit, Math.sin(a) * orbit, (2 + e * 3) * d * (1 - k * 0.25), 0, Math.PI * 2); c.fill();
        }
      }
      if (bt.beat) { var cnt = 6 + Math.floor(Math.random() * 5); for (var s = 0; s < cnt; s++) sparks.push({ a: Math.random() * Math.PI * 2, dist: (60 + Math.random() * 80) * d, born: now }); }
      sparks = sparks.filter(function (p) { return now - p.born < 600; });
      sparks.forEach(function (p) {
        var k = (now - p.born) / 600, r = Math.min(v.radius + 2 * d + p.dist * (1 - Math.pow(1 - k, 2)), rMax);
        c.fillStyle = VisUtil.rgbaTint(0.8, 1 - k);
        c.beginPath(); c.arc(Math.cos(p.a) * r, Math.sin(p.a) * r, 2.2 * d * (1 - k * 0.5), 0, Math.PI * 2); c.fill();
      });
      c.restore();
    }
  });
})();
