/**
 * bridgeShared.js
 *
 * Everything about the phone-bridge protocol that doesn't care which
 * transport carries it. Both remoteBridge.js (WiFi/WebSocket) and
 * (formerly also bluetoothBridge.js — removed) call into this — one copy of the
 * message shapes and command handling, two thin transport wrappers around
 * it. Keeps them from drifting out of sync with each other.
 */
var BridgeShared = (function () {
  var BAND_COUNT = 20;

  function buildStateMessage() {
    var track = Player.currentTrack();
    var visList = (typeof VisualizerRegistry !== 'undefined') ? VisualizerRegistry : [];
    var vis = visList[VisualizerManager.currentIndex()] || null;
    return {
      type: 'state',
      screen: ScreenManager.current(),
      track: track ? { title: track.title, artist: track.artist, album: track.album } : null,
      playing: Player.isPlaying(),
      visualizer: vis ? vis.name : null
    };
  }

  function buildLibraryMessage() {
    if (!MediaLibrary.isReady()) return null;
    return {
      type: 'library',
      tracks: MediaLibrary.getTracks().map(stripTrack),
      albums: MediaLibrary.getAlbums().map(stripGroup),
      artists: MediaLibrary.getArtists().map(stripGroup),
      folders: MediaLibrary.getFolders().map(function (g) {
        return { name: g.name, path: g.path, count: g.count, trackIds: g.tracks.map(idOf) };
      })
    };
  }

  function buildAudioMessage() {
    if (!Player.isPlaying()) return null;
    var freq = AudioEngine.getFrequencyData();
    var bands = new Array(BAND_COUNT);
    var span = Math.floor((freq.length * 0.7) / BAND_COUNT);
    for (var i = 0; i < BAND_COUNT; i++) {
      var sum = 0;
      var start = i * span;
      for (var j = 0; j < span; j++) sum += freq[start + j] || 0;
      bands[i] = Math.round((sum / span / 255) * 100) / 100;
    }
    return { type: 'audio', bands: bands };
  }

  function stripTrack(t) {
    return { id: t.id, title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec };
  }
  function stripGroup(g) {
    return { name: g.name, count: g.count, trackIds: g.tracks.map(idOf) };
  }
  function idOf(t) { return t.id; }

  function handleCommand(msg) {
    if (!msg || msg.type !== 'command') return false;
    switch (msg.action) {
      case 'togglePlay': Player.togglePlay(); break;
      case 'next': Player.next(); break;
      case 'prev': Player.prev(); break;
      case 'seekBy': Player.seekBy(msg.value || 0); break;
      case 'toggleShuffle': Player.toggleShuffle(); break;
      case 'cycleRepeat': Player.cycleRepeat(); break;
      case 'nextVisualizer': VisualizerManager.next(); break;
      case 'prevVisualizer': VisualizerManager.prev(); break;
      case 'playTrack': playById(msg.id); break;
      case 'playGroup': playGroupByIds(msg.trackIds); break;
      case 'playRemoteTrack': playRemoteTrack(msg); break;
      case 'back': ScreenManager.show('library'); break;
      default: return false;
    }
    return true;
  }

  /**
   * A track that lives on the PHONE's own library/HTTP server, not the
   * TV's. `Player` treats `track.uri` as an opaque string handed to
   * <audio src> — http:// (WiFi stream) works exactly like file:// or
   * blob: did before, no player.js changes needed for that part.
   * `artworkUrl`, when present, is used by the Now Playing screen to
   * show real album art instead of the default icon.
   */
  function playTrackFromUri(meta, uri) {
    Player.loadQueue([makeRemoteTrack(meta, uri)], 0, true);
    Player.play();
    ScreenManager.show('nowPlaying');
  }

  /** A phone queue (LOAD_QUEUE): the TV plays it through by itself. */
  function playQueueFromPhone(items, index, paused) {
    Player.loadQueue(items.map(function (m) { return makeRemoteTrack(m, m.url || m.uri); }), index, true, paused);
    ScreenManager.show('nowPlaying');
  }

  function makeRemoteTrack(meta, uri) {
    return {
      id: 'remote_' + (meta.id || Date.now()),
      title: meta.title || 'Unknown Track',
      artist: meta.artist || 'Unknown Artist',
      album: meta.album || 'Phone Library',
      durationSec: meta.durationSec || null,
      uri: uri,
      artworkUrl: meta.artworkUrl || null,
      mimeType: meta.mimeType || null,   // e.g. 'audio/mp4' — used to pick html5 vs AVPlay
      codec: meta.codec || null,         // e.g. 'E-AC-3 JOC' — Dolby -> AVPlay
      channels: meta.channels || null,
      sampleRate: meta.sampleRate || null,             // rate actually delivered to the TV
      sourceSampleRate: meta.sourceSampleRate || null, // original file's rate, if the phone converted it
      bitDepth: meta.bitDepth || null,
      bitrate: meta.bitrate || null,
      startAt: Number(meta.startAt) || 0,
      isDemo: false,
      isPhoneStream: /^https?:\/\//i.test(uri),
      phoneId: meta.id != null ? meta.id : null,
      isJoc: meta.isJoc != null ? !!meta.isJoc : null,          // phone's Atmos info: used only if the file can't tell
      atmosObjects: meta.atmosObjects != null ? Number(meta.atmosObjects) : null
    };
  }

  function playRemoteTrack(msg) {
    if (!msg.url) return;
    playTrackFromUri(msg, msg.url);
  }

  function playById(id) {
    var tracks = MediaLibrary.getTracks();
    var index = -1;
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].id === id) { index = i; break; }
    }
    if (index === -1) return;
    Player.loadQueue(tracks, index);
    Player.play();
    ScreenManager.show('nowPlaying');
  }

  function playGroupByIds(trackIds) {
    if (!trackIds || !trackIds.length) return;
    var all = MediaLibrary.getTracks();
    var map = {};
    all.forEach(function (t) { map[t.id] = t; });
    var queue = trackIds.map(function (id) { return map[id]; }).filter(Boolean);
    if (!queue.length) return;
    Player.loadQueue(queue, 0);
    Player.play();
    ScreenManager.show('nowPlaying');
  }

  return {
    playQueueFromPhone: playQueueFromPhone, makeRemoteTrack: makeRemoteTrack,
    buildStateMessage: buildStateMessage,
    buildLibraryMessage: buildLibraryMessage,
    buildAudioMessage: buildAudioMessage,
    handleCommand: handleCommand,
    playTrackFromUri: playTrackFromUri
  };
})();
