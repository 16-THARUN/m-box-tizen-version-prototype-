/**
 * screenManager.js — toggles which top-level screen is visible.
 * Kept deliberately tiny: two screens, one active at a time.
 */
var ScreenManager = (function () {
  var current = 'library';

  function show(name) {
    current = name;
    document.getElementById('libraryScreen').classList.toggle('screen-hidden', name !== 'library');
    document.getElementById('nowPlaying').classList.toggle('screen-hidden', name !== 'nowPlaying');
    document.getElementById('visCanvas').classList.toggle('screen-hidden', name !== 'nowPlaying');

    if (name === 'nowPlaying') { Remote.enterPlayerMode(); VisualizerManager.start(); }
    if (name === 'library') { Remote.enterLibraryMode(); Library.updateMiniPlayer(); VisualizerManager.stop(); }
  }

  return { show: show, current: function () { return current; } };
})();
