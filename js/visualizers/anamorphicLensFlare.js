/* Anamorphic Lens Flare — the phone app's lens-flare clip as the background; it gets brighter with
 * the highs and runs faster with the music. (The drawn streak and ghost circles were removed on request.) */
VisualizerRegistry.push({
  id: 'anamorphic-lens-flare', name: 'Anamorphic Lens Flare', category: 'Premium Video Background', backdrop: 'lens_flare',
  draw: function (c, w, h, freq, time, t, v) {
    // phone spec: on each beat the clip swells 1.00 -> 1.03 and back (~250 ms) from the vinyl's centre;
    // brightness 80 % -> 100 % with the highs
    var hi = VisUtil.energy(freq, 0.15, 0.5), bt = VisUtil.beat(freq), s = 1 + 0.03 * (bt.pulse > 0 ? Math.sin((1 - bt.pulse) * Math.PI) : 0);
    c.save(); c.translate(v.x, v.y); c.scale(s, s); c.translate(-v.x, -v.y);
    VideoBackdrop.draw(c, w, h, 'lens_flare', VisUtil.energy(freq, 0, 0.5), 0.8 + Math.min(1, hi * 1.6) * 0.2);
    c.restore();
  }
});
