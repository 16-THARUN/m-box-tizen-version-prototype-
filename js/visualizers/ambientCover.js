/* Ambient Cover — the calm Now Playing screen (see ambientView.js). The canvas draws nothing:
 * the cover, title and buttons are laid out by CSS, and nothing is redrawn every frame. */
VisualizerRegistry.push({
  id: 'ambient-cover', aliases: ['ambient', 'calm', 'Calm Cover'], name: 'Ambient Cover', category: 'Calm Now Playing',
  ambient: true,
  draw: function () {}
});
