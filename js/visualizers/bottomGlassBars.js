/* Bottom Glass Bars — phone spec 2B.1: 28 rounded glass bars around the vinyl, 62 % of their slot
 * wide, from R + 6 dp, 4 dp up to ~52 dp; accent 35 % at the base -> light tint 75 % at the tip,
 * 1 px white outline, a thin white highlight along one side. The ring does not turn. */
VisualizerRegistry.push({
  id: 'bottom-glass-bars', name: 'Bottom Glass Bars', category: 'Minimalist Spectrum',
  draw: function (c, w, h, freq, time, t, v) {
    var d = VisUtil.dp(v), n = 28, L = VisUtil.levels('glass', freq, n);
    var r0 = v.radius + 6 * d, maxLen = Math.min(52 * d, VisUtil.ringMax(v, 59) - r0);
    var bw = Math.min(10 * d, (2 * Math.PI * r0 / n) * 0.62);
    c.save(); c.translate(v.x, v.y);
    for (var i = 0; i < n; i++) {
      var len = 4 * d + L[i] * (maxLen - 4 * d);
      c.save(); c.rotate(VisUtil.angle(i, n) + Math.PI / 2);         // bar grows "up" = outward
      var g = c.createLinearGradient(0, -r0, 0, -r0 - len);
      g.addColorStop(0, VisUtil.rgbaTint(0, 0.35)); g.addColorStop(1, VisUtil.rgbaTint(1, 0.75));
      VisUtil.pill(c, -bw / 2, -r0 - len, bw, len);
      c.fillStyle = g; c.fill();
      c.lineWidth = 1; c.strokeStyle = 'rgba(255,255,255,0.35)'; c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.4)';                           // glass highlight
      c.fillRect(-bw / 2 + bw * 0.18, -r0 - len + bw * 0.5, 1.5 * d, Math.max(0, len - bw));
      c.restore();
    }
    c.restore();
  }
});
