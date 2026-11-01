/* OLED Edge Lighting — phone spec B6 / E3: a glow along all four screen edges, symmetric, accent
 * colour, 20 % at rest up to 90 % on the bass, softly falling off inward. */
VisualizerRegistry.push({
  id: 'oled-edge-lighting', name: 'OLED Edge Lighting', category: 'Immersive Full Screen',
  draw: function (c, w, h, freq, time, t, v) {
    var d = VisUtil.dp(v), bt = VisUtil.beat(freq), L = VisUtil.levels('edge', freq, 4);
    var e = Math.min(1, Math.max(L[0], bt.pulse * 0.8)), op = 0.2 + e * 0.7, core = 12 * d, fall = 32 * d + e * 24 * d;
    function edge(x0, y0, x1, y1, rx, ry, rw, rh) {
      var g = c.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, VisUtil.rgbaTint(0.25, op)); g.addColorStop(core / (core + fall), VisUtil.rgbaTint(0, op * 0.55)); g.addColorStop(1, 'rgba(255,106,26,0)');
      c.fillStyle = g; c.fillRect(rx, ry, rw, rh);
    }
    var D = core + fall;
    c.save();
    edge(0, 0, 0, D, 0, 0, w, D);                 // top
    edge(0, h, 0, h - D, 0, h - D, w, D);         // bottom
    edge(0, 0, D, 0, 0, 0, D, h);                 // left
    edge(w, 0, w - D, 0, w - D, 0, D, h);         // right
    c.restore();
  }
});
