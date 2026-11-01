/* Quantum Particle Grid — phone spec (video version): the particle clip full screen; on each bass beat
 * it swells 1.00 -> 1.05 and back (~300 ms) from the vinyl's centre, and it gets brighter with the
 * music (75 % -> 100 %). Nothing is drawn over the title or controls. */
VisualizerRegistry.push({
  id: 'quantum-particle-grid', name: 'Quantum Particle Grid', category: 'Premium Video Background', backdrop: 'particle_grid',
  draw: function (c, w, h, freq, time, t, v) {
    var bt = VisUtil.beat(freq), all = VisUtil.energy(freq, 0, 0.5), s = 1 + 0.05 * (bt.pulse > 0 ? Math.sin((1 - bt.pulse) * Math.PI) : 0);
    c.save(); c.translate(v.x, v.y); c.scale(s, s); c.translate(-v.x, -v.y);
    VideoBackdrop.draw(c, w, h, 'particle_grid', all, 0.75 + Math.min(1, all * 1.5) * 0.25);
    c.restore();
  }
});
