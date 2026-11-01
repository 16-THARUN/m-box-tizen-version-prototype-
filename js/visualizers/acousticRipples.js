/* Acoustic Ripples — phone spec: one ring per beat, spawning at the vinyl edge and growing to about
 * R + 70 dp while fading; at most 6 rings alive. */
(function () {
  var rings = [];
  VisualizerRegistry.push({
    id: 'acoustic-ripples', name: 'Acoustic Ripples', category: 'Vinyl Ecosystem',
    draw: function (c, w, h, freq, time, t, v) {
      var d = VisUtil.dp(v), bt = VisUtil.beat(freq), now = performance.now(), rMax = VisUtil.ringMax(v, 70);
      var lastBorn = rings.length ? rings[rings.length - 1].born : 0;
      if (bt.beat || (now - lastBorn > 1300 && bt.bass > 0.06)) {        // beat, or a soft ring in calm passages
        rings.push({ born: now, s: bt.beat ? Math.min(1, 0.4 + bt.bass) : 0.25 }); if (rings.length > 6) rings.shift();
      }
      rings = rings.filter(function (r) { return now - r.born < 1400; });
      c.save(); c.translate(v.x, v.y);
      rings.forEach(function (r) {
        var k = (now - r.born) / 1400, rad = v.radius + 2 * d + (rMax - v.radius - 2 * d) * (1 - Math.pow(1 - k, 2));
        c.strokeStyle = VisUtil.rgbaTint(k * 0.7, (1 - k) * (0.5 + r.s * 0.5));
        c.lineWidth = (1.5 + r.s * 3 * (1 - k)) * d;
        c.beginPath(); c.arc(0, 0, rad, 0, Math.PI * 2); c.stroke();
      });
      c.restore();
    }
  });
})();
