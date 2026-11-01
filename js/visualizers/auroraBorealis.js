/* Aurora Borealis — phone spec B5 / D6: two soft glows drifting around the vinyl, 40–90 % with the
 * bass; the vinyl sits in front. Kept off the title area by fading out below the vinyl. */
VisualizerRegistry.push({
  id: 'aurora-borealis', name: 'Aurora Borealis', category: 'Immersive Full Screen',
  draw: function (c, w, h, freq, time, t, v) {
    var bt = VisUtil.beat(freq), L = VisUtil.levels('aurora', freq, 8), bass = Math.max(L[0], L[4]), hi = L[2];
    var R = v.radius;
    c.save(); c.globalCompositeOperation = 'lighter';
    var glows = [
      { a: t * 0.23, dist: R * 1.15, rad: R * (1.9 + bass * 0.7), col: [255, 110, 30], op: 0.4 + bass * 0.5 },
      { a: t * 0.23 + Math.PI, dist: R * 1.05, rad: R * (1.6 + hi * 0.6), col: [255, 60, 90], op: 0.3 + hi * 0.4 }
    ];
    glows.forEach(function (g) {
      var x = v.x + Math.cos(g.a) * g.dist * 1.6, y = v.y + Math.sin(g.a) * g.dist * 0.45;
      var gr = c.createRadialGradient(x, y, 0, x, y, g.rad);
      gr.addColorStop(0, 'rgba(' + g.col.join(',') + ',' + (g.op + bt.pulse * 0.1).toFixed(3) + ')');
      gr.addColorStop(0.55, 'rgba(' + g.col.join(',') + ',' + (g.op * 0.35).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = gr; c.fillRect(x - g.rad, y - g.rad, g.rad * 2, g.rad * 2);
    });
    c.restore();
    // keep the title readable: darken under the vinyl area (like the phone's scrim)
    var top = v.y + R + (v.maxR && v.maxR < 1e8 ? Math.max(0, v.maxR - R) * 0.5 : R * 0.5);
    var s = c.createLinearGradient(0, top, 0, h); s.addColorStop(0, 'rgba(11,11,13,0)'); s.addColorStop(0.35, 'rgba(11,11,13,0.75)'); s.addColorStop(1, 'rgba(11,11,13,0.9)');
    c.fillStyle = s; c.fillRect(0, top, w, h - top);
  }
});
