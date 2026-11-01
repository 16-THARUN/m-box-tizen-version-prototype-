/**
 * app.js — bootstrap
 *
 * Deliberately does NOT touch AudioEngine at all here — no ensureContext(),
 * no attachAudioElement(). Both happen lazily, inside player.js, the
 * moment real playback actually starts. Opening the Web Audio pipeline
 * eagerly at boot was the source of a startup noise artifact on the TV.
 */
window.onload = function () {
  if (window.__debugLog) window.__debugLog('boot: window.onload start');

  VisualizerManager.init();
  Player.init();
  Library.init();
  ScreenManager.show('library');
  Remote.init();
  AmbientView.init();
  LyricsView.init();
  TvVolume.init();
  VisualizerManager.applyDisplay();          // Ambient Cover saved as the last choice: start in it
  if (window.__debugLog) window.__debugLog('boot: UI ready');

  // Phone link: finds the m-box phone on the network (launch data ->
  // last known phone -> subnet scan) and plays whatever it streams.
  RemoteBridge.init();
};
