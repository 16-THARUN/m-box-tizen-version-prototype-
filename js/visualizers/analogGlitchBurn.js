/* Cinematic Glitch Burn — the phone app's glitch-burn clip as a full-screen background, brighter and
 * faster with the bass, with a side-jolt on hits. (The equalizer stripes on top were removed on request.) */
VisualizerRegistry.push({
  id: 'cinematic-glitch-burn',
  aliases: ['analog-glitch-burn', 'Analog Glitch Burn'],
  name: 'Cinematic Glitch Burn',
  category: 'Premium Video Background', backdrop: 'glitch_burn',
  draw: function (ctx, w, h, freq, time, t) {
    var bass = VisUtil.energy(freq, 0, 0.06), all = VisUtil.energy(freq, 0, 0.5);
    var hit = bass > 0.62 && Math.sin(t * 37) > 0.6;
    ctx.save();
    if (hit) ctx.translate((Math.random() * 2 - 1) * 14, 0);
    VideoBackdrop.draw(ctx, w, h, 'glitch_burn', all, 0.32 + bass * 0.5);
    ctx.restore();
  }
});
