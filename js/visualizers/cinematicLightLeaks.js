/* Cinematic Light Leaks — phone spec B7: 3 warm leaks drifting slowly around the vinyl, brighter on
 * beats; the title stays readable. */
VisualizerRegistry.push({
  id: 'cinematic-light-leaks', name: 'Cinematic Light Leaks', category: 'Immersive Full Screen',
  draw: function (c, w, h, freq, time, t, v) {
    var bt = VisUtil.beat(freq), L = VisUtil.levels('leaks', freq, 8), R = v.radius;
    c.save(); c.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 3; i++) {
      var a = t * (0.09 + i * 0.03) + i * 2.1, e = L[i * 2];
      var x = v.x + Math.cos(a) * R * (2.2 + i * 0.5), y = v.y + Math.sin(a) * R * 0.9;
      var r = R * (2.1 + e * 0.8);
      var g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,' + (120 + i * 20) + ',30,' + (0.18 + e * 0.35 + bt.pulse * 0.15).toFixed(3) + ')');
      g.addColorStop(0.45, 'rgba(200,60,10,' + (0.06 + e * 0.18).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
    }
    c.restore();
    var top = v.y + R * 1.4, s = c.createLinearGradient(0, top, 0, h);
    s.addColorStop(0, 'rgba(11,11,13,0)'); s.addColorStop(0.4, 'rgba(11,11,13,0.7)'); s.addColorStop(1, 'rgba(11,11,13,0.85)');
    c.fillStyle = s; c.fillRect(0, top, w, h - top);
  }
});
