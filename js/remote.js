/**
 * remote.js
 *
 * All D-pad + media-key handling. Three input contexts now:
 *   LIBRARY  - tab row <-> list, Enter plays a track/group
 *   PLAYER   - 2-row grid (seek row / transport row) on Now Playing
 *   SWITCHER - the visualizer overlay, opened from the top of PLAYER
 * Focus is explicit state we track ourselves, not native :focus — far
 * more reliable across Tizen webkit versions.
 */
var Remote = (function () {
  var MODE_PLAYER = 'player';
  var MODE_SWITCHER = 'switcher';
  var mode = MODE_PLAYER;

  var transportOrder = ['shuffle', 'prev', 'play', 'next', 'repeat', 'lyrics'];
  var row = 1;              // player mode: 0 = seek row, 1 = transport row
  var col = 2;               // start on Play
  var switcherIndexBeforeOpen = 0;

  var libRow = 'tabs';       // library mode: 'tabs' | 'list'

  var KEY = {
    LEFT: 37, RIGHT: 39, UP: 38, DOWN: 40, ENTER: 13,
    BACK: 10009,
    MEDIA_PLAY_PAUSE: 10252,
    MEDIA_PLAY: 415, MEDIA_PAUSE: 19, MEDIA_STOP: 413,
    MEDIA_REWIND: 412, MEDIA_FF: 417,
    MEDIA_PREV: 10232, MEDIA_NEXT: 10233,
    SPACE: 32
  };

  function init() {
    registerTizenKeys();

    // Some Tizen WebKit versions won't deliver remote-control key events to
    // JS at all unless something on the page actually has focus, and
    // Samsung's own docs bind the listener to <body> specifically rather
    // than document. Doing both, since either could be the reason nothing
    // was arriving before.
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
    document.body.addEventListener('keydown', onKeyDown);

    wireMouseFallback();
    enterLibraryMode();
    if (window.__debugLog) window.__debugLog('Remote: body focused + listener attached');
  }

  // TEMPORARY — remove once the unresponsive-remote issue is diagnosed.
  function logKeyDebug(e) {
    var line = 'key="' + e.key + '" code=' + e.keyCode + ' screen=' + ScreenManager.current();
    if (window.__debugLog) window.__debugLog(line);
  }

  function registerTizenKeys() {
    if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
    var wanted = [
      'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
      'MediaRewind', 'MediaFastForward', 'MediaTrackPrevious', 'MediaTrackNext'
    ];
    wanted.forEach(function (key) {
      try { tizen.tvinputdevice.registerKey(key); } catch (e) { /* not supported on this profile */ }
    });
  }

  function onKeyDown(e) {
    logKeyDebug(e);

    switch (e.keyCode) {
      case KEY.MEDIA_PLAY_PAUSE: case KEY.MEDIA_PLAY: case KEY.MEDIA_PAUSE:
      case KEY.SPACE:
        Player.togglePlay(); e.preventDefault(); return;
      case KEY.MEDIA_STOP:
        Player.pause(); return;
      case KEY.MEDIA_REWIND:
        Player.seekBy(-10); return;
      case KEY.MEDIA_FF:
        Player.seekBy(10); return;
      case KEY.MEDIA_PREV:
        Player.prev(); return;
      case KEY.MEDIA_NEXT:
        Player.next(); return;
      case KEY.BACK:
        onBack(); return;
    }

    if (ScreenManager.current() === 'library') { handleLibraryKey(e); return; }
    if (mode === MODE_SWITCHER) { handleSwitcherKey(e); return; }
    handlePlayerKey(e);
  }

  // ---------------- LIBRARY mode ----------------

  function handleLibraryKey(e) {
    switch (e.keyCode) {
      case KEY.LEFT:
        if (libRow === 'tabs') Library.prevTab();
        else Library.moveSettingsField(-1);
        e.preventDefault(); break;
      case KEY.RIGHT:
        if (libRow === 'tabs') Library.nextTab();
        else Library.moveSettingsField(1);
        e.preventDefault(); break;
      case KEY.UP:
        if (libRow === 'list') {
          if (Library.selectionAtTop()) { libRow = 'tabs'; }
          else { Library.moveSelection(-1); }
        }
        e.preventDefault(); break;
      case KEY.DOWN:
        if (libRow === 'tabs') { libRow = 'list'; Library.focusFirstRow(); }
        else { Library.moveSelection(1); }
        e.preventDefault(); break;
      case KEY.ENTER:
        if (libRow === 'list') Library.activateSelected();
        e.preventDefault(); break;
    }
  }

  function enterLibraryMode() {
    libRow = 'tabs';
  }

  // ---------------- PLAYER mode ----------------

  function handlePlayerKey(e) {
    switch (e.keyCode) {
      case KEY.LEFT:
        if (row === 0) { Player.seekBy(-5); }
        else { col = Math.max(0, col - 1); applyFocus(); }
        e.preventDefault(); break;
      case KEY.RIGHT:
        if (row === 0) { Player.seekBy(5); }
        else { col = Math.min(transportOrder.length - 1, col + 1); applyFocus(); }
        e.preventDefault(); break;
      case KEY.UP:
        if (row === 1) { row = 0; applyFocus(); }
        else { openSwitcher(); }
        e.preventDefault(); break;
      case KEY.DOWN:
        if (row === 0) { row = 1; applyFocus(); }
        e.preventDefault(); break;
      case KEY.ENTER:
        if (row === 1) activateTransport(transportOrder[col]);
        e.preventDefault(); break;
    }
  }

  function activateTransport(name) {
    switch (name) {
      case 'play': Player.togglePlay(); break;
      case 'prev': Player.prev(); break;
      case 'next': Player.next(); break;
      case 'shuffle': Player.toggleShuffle(); break;
      case 'repeat': Player.cycleRepeat(); break;
      case 'lyrics': if (typeof LyricsView !== 'undefined') LyricsView.toggle(); break;
    }
  }

  function enterPlayerMode() {
    row = 1; col = 2;
    applyFocus();
  }

  function applyFocus() {
    document.querySelectorAll('[data-focusable]').forEach(function (el) {
      el.classList.remove('focused');
    });
    if (row === 0) {
      var handle = document.getElementById('progressHandle');
      if (handle) handle.classList.add('focused');
    } else {
      var el = document.querySelector('[data-focusable="' + transportOrder[col] + '"]');
      if (el) el.classList.add('focused');
    }
  }

  // ---------------- SWITCHER mode ----------------

  function openSwitcher() {
    mode = MODE_SWITCHER;
    switcherIndexBeforeOpen = VisualizerManager.currentIndex();
    document.getElementById('visSwitcher').classList.remove('hidden');
    document.getElementById('visLabel').classList.add('hidden');
  }

  function closeSwitcher(confirm) {
    if (!confirm) VisualizerManager.selectIndex(switcherIndexBeforeOpen);
    mode = MODE_PLAYER;
    document.getElementById('visSwitcher').classList.add('hidden');
    document.getElementById('visLabel').classList.remove('hidden');
    row = 0;
    applyFocus();
  }

  function handleSwitcherKey(e) {
    switch (e.keyCode) {
      case KEY.LEFT:
        VisualizerManager.prev(); scrollSwitcherIntoView(); e.preventDefault(); break;
      case KEY.RIGHT:
        VisualizerManager.next(); scrollSwitcherIntoView(); e.preventDefault(); break;
      case KEY.ENTER: case KEY.DOWN:
        closeSwitcher(true); e.preventDefault(); break;
    }
  }

  function scrollSwitcherIntoView() {
    var focused = document.querySelector('.vis-item.focused');
    if (focused) focused.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  // ---------------- Back / cross-screen ----------------

  function onBack() {
    if (ScreenManager.current() === 'nowPlaying' && mode === MODE_SWITCHER) {
      closeSwitcher(false);
      return;
    }
    if (ScreenManager.current() === 'nowPlaying') {
      ScreenManager.show('library');
      return;
    }
    if (Library.handleBack && Library.handleBack()) return;
    // At the Library screen with nothing above it: exit the app.
    if (typeof tizen !== 'undefined' && tizen.application) {
      try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* ignore outside Tizen */ }
    }
  }

  // ---------------- Desktop-browser convenience ----------------

  function wireMouseFallback() {
    var map = { btnPlay: 'play', btnPrev: 'prev', btnNext: 'next', btnShuffle: 'shuffle', btnRepeat: 'repeat' };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', function () { activateTransport(map[id]); });
    });
  }

  return { init: init, enterPlayerMode: enterPlayerMode, enterLibraryMode: enterLibraryMode };
})();
