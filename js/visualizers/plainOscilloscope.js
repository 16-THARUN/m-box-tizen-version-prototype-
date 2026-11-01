/* Plain Oscilloscope — phone spec 2B.5: one closed line around the record at R + 18 dp, pushed in and
 * out by the waveform (up to ±30 dp), lightly smoothed and mirrored left/right (no seam); a 4.7 dp
 * glow at 18 % under a 1.6 dp light-tint line, plus a faint resting guide circle. */
(function () {
  var N = 128, pts = new Float32Array(N + 1), sm = new Float32Array(N + 1);
  VisualizerRegistry.push({
    id: 'plain-oscilloscope', name: 'Plain Oscilloscope', category: 'Legacy Waveform',
    draw: function (c, w, h, freq, time, t, v) {
      var d = VisUtil.dp(v), base = v.radius + 18 * d, amp = Math.min(30 * d, VisUtil.ringMax(v, 59) - base - 2 * d);
      var M = time.length, half = N / 2;
      for (var i = 0; i <= half; i++) {                             // one half from the waveform...
        var s = 0, cnt = 0, from = Math.floor(i / half * (M * 0.5)), to = Math.min(M - 1, from + 6);
        for (var k = from; k <= to; k++) { s += (time[k] - 128) / 128; cnt++; }
        pts[i] = cnt ? s / cnt : 0;
      }
      for (var j = half + 1; j <= N; j++) pts[j] = pts[N - j];       // ...mirrored: closed and symmetric
      for (var q = 0; q <= N; q++) sm[q] += (pts[q] - sm[q]) * 0.5;
      c.save(); c.translate(v.x, v.y);
      c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 1;
      c.beginPath(); c.arc(0, 0, base, 0, Math.PI * 2); c.stroke();
      function path() {
        c.beginPath();
        for (var p = 0; p <= N; p++) {
          var a = VisUtil.angle(p, N), r = base + Math.max(-1, Math.min(1, sm[p] * 1.5)) * amp;
          if (p === 0) c.moveTo(Math.cos(a) * r, Math.sin(a) * r); else c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        c.closePath();
      }
      c.lineJoin = 'round';
      path(); c.strokeStyle = VisUtil.rgbaTint(0.3, 0.18); c.lineWidth = 4.7 * d; c.stroke();
      path(); c.strokeStyle = VisUtil.rgbaTint(1, 1); c.lineWidth = 1.6 * d; c.stroke();
      c.restore();
    }
  });
})();
