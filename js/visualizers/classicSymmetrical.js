/* Classic Symmetrical — phone spec 2B.2: 48 bars ~3.3 dp wide, round caps, from R + 5 dp up to ~52 dp,
 * accent -> light tint; a white peak dot ~5 dp beyond each tip that jumps with the bar and falls
 * back with gravity, never below the tip. */
(function () {
  var n = 48, peak = new Float32Array(n), vel = new Float32Array(n), lastAt = 0;
  VisualizerRegistry.push({
    id: 'classic-symmetrical', name: 'Classic Symmetrical', category: 'Legacy Spectrum',
    draw: function (c, w, h, freq, time, t, v) {
      var d = VisUtil.dp(v), L = VisUtil.levels('classic', freq, n), now = performance.now(), dt = lastAt ? Math.min(0.1, (now - lastAt) / 1000) : 1 / 60; lastAt = now;
      var r0 = v.radius + 5 * d, maxLen = Math.min(52 * d, VisUtil.ringMax(v, 59) - r0 - 7 * d);
      c.save(); c.translate(v.x, v.y); c.lineCap = 'round'; c.lineWidth = 3.3 * d;
      for (var i = 0; i < n; i++) {
        var len = 2 * d + L[i] * maxLen, a = VisUtil.angle(i, n), ca = Math.cos(a), sa = Math.sin(a);
        var g = c.createLinearGradient(ca * r0, sa * r0, ca * (r0 + len), sa * (r0 + len));
        g.addColorStop(0, VisUtil.rgbaTint(0, 0.9)); g.addColorStop(1, VisUtil.rgbaTint(1, 1));
        c.strokeStyle = g;
        c.beginPath(); c.moveTo(ca * r0, sa * r0); c.lineTo(ca * (r0 + len), sa * (r0 + len)); c.stroke();
        if (len > peak[i]) { peak[i] = len; vel[i] = 0; }
        else { vel[i] += 260 * d * dt; peak[i] = Math.max(len, peak[i] - vel[i] * dt); }
        var pr = r0 + peak[i] + 5 * d;
        c.fillStyle = 'rgba(255,255,255,0.9)';
        c.beginPath(); c.arc(ca * pr, sa * pr, 1.7 * d, 0, Math.PI * 2); c.fill();
      }
      c.restore();
    }
  });
})();
