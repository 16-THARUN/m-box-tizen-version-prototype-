/* global tizen */
/**
 * mediaLibrary.js
 *
 * Scans local/USB storage for audio files and reads their tags. Two Tizen
 * Web APIs do the real work here, both confirmed against current Samsung
 * TV docs:
 *   - tizen.filesystem  : list storages, walk directories           (Mandatory on TV)
 *   - tizen.metadata    : read TITLE/ARTIST/ALBUM/DURATION per file (Mandatory on TV)
 *
 * NOTE: this hasn't been run against a real Tizen runtime yet — I don't
 * have one available to test against. The shape of the API (listStorages,
 * resolve, listFiles, createFileHandle/get) is correct per current docs,
 * but every file read is wrapped in try/catch so a mismatched property
 * name skips that one file instead of breaking the scan. If tracks come
 * back empty on real hardware, that's the first place to check.
 *
 * When there's no Tizen runtime at all (e.g. previewing in a desktop
 * browser), scan() falls back to a few demo tracks so the Library screen
 * is still fully testable.
 */
var MediaLibrary = (function () {
  var AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma'];
  var MAX_TRACKS = 2000;   // safety cap for very large USB drives
  var MAX_DEPTH = 8;

  var tracks = [];
  var scanning = false;
  var ready = false;
  var readyListeners = [];

  function isTizenAvailable() {
    return typeof tizen !== 'undefined' && !!tizen.filesystem;
  }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function dirOf(fullPath) {
    var i = fullPath.lastIndexOf('/');
    return i >= 0 ? fullPath.substring(0, i) : fullPath;
  }

  function baseName(path) {
    var i = path.lastIndexOf('/');
    return i >= 0 ? path.substring(i + 1) : path;
  }

  function stripExt(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.substring(0, i) : name;
  }

  function scan(callback) {
    if (scanning) return;
    scanning = true;
    tracks = [];

    if (!isTizenAvailable()) {
      tracks = demoTracks();
      finish(callback);
      return;
    }

    // Safety net: if tizen.filesystem never calls back at all (seen on some
    // emulator configs with no storage set up), don't hang on "Scanning..."
    // forever — finish with whatever we have (possibly zero tracks) after
    // a few seconds instead.
    var settled = false;
    var timeoutId = setTimeout(function () {
      if (settled) return;
      settled = true;
      finish(callback);
    }, 6000);

    function finishOnce(cb) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      finish(cb);
    }

    tizen.filesystem.listStorages(function (storages) {
      var roots = storages
        .filter(function (s) { return s.state === 'MOUNTED' || s.type === 'INTERNAL'; })
        .map(function (s) { return s.label; });

      if (roots.length === 0) { finishOnce(callback); return; }

      var pending = roots.length;
      roots.forEach(function (label) {
        tizen.filesystem.resolve(
          label,
          function (dirHandle) { walkDirectory(dirHandle, 0, settle); },
          function () { settle(); },
          'r'
        );
      });

      function settle() {
        pending--;
        if (pending <= 0) finishOnce(callback);
      }
    }, function () {
      finishOnce(callback);
    });
  }

  function walkDirectory(dirHandle, depth, done) {
    if (depth > MAX_DEPTH || tracks.length >= MAX_TRACKS) { done(); return; }

    dirHandle.listFiles(function (entries) {
      var pending = entries.length;
      if (pending === 0) { done(); return; }

      entries.forEach(function (entry) {
        if (tracks.length >= MAX_TRACKS) { pending--; if (pending <= 0) done(); return; }

        if (entry.isDirectory) {
          walkDirectory(entry, depth + 1, function () {
            pending--; if (pending <= 0) done();
          });
        } else {
          if (AUDIO_EXTENSIONS.indexOf(extOf(entry.name)) !== -1) {
            addTrack(entry);
          }
          pending--; if (pending <= 0) done();
        }
      });
    }, function () { done(); });
  }

  function addTrack(fileHandle) {
    var track = {
      id: 'trk_' + tracks.length,
      title: stripExt(fileHandle.name),
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      durationSec: null,
      folder: dirOf(fileHandle.fullPath),
      fullPath: fileHandle.fullPath,
      uri: (typeof fileHandle.toURI === 'function') ? fileHandle.toURI() : 'file://' + fileHandle.fullPath,
      isDemo: false
    };

    try {
      if (typeof tizen !== 'undefined' && tizen.metadata) {
        var meta = tizen.metadata.createFileHandle(fileHandle.fullPath);
        var t = meta.get('TITLE');
        var ar = meta.get('ARTIST');
        var al = meta.get('ALBUM');
        var dur = meta.get('DURATION');
        if (t) track.title = t;
        if (ar) track.artist = ar;
        if (al) track.album = al;
        if (dur) track.durationSec = Math.round(dur / 1000);
        if (meta.release) meta.release();
      }
    } catch (e) {
      // Tag read failed for this file — keep the filename-derived title and move on.
    }

    tracks.push(track);
  }

  function demoTracks() {
    return [
      { id: 'demo_1', title: 'Sample Track', artist: 'Demo Artist', album: 'M-Box Sampler', durationSec: 222, folder: '/demo', fullPath: null, uri: null, isDemo: true },
      { id: 'demo_2', title: 'Morning Drift', artist: 'Demo Artist', album: 'M-Box Sampler', durationSec: 198, folder: '/demo', fullPath: null, uri: null, isDemo: true },
      { id: 'demo_3', title: 'Late Static', artist: 'Second Artist', album: 'Night Sessions', durationSec: 261, folder: '/demo', fullPath: null, uri: null, isDemo: true },
      { id: 'demo_4', title: 'Glass Corridor', artist: 'Second Artist', album: 'Night Sessions', durationSec: 174, folder: '/demo', fullPath: null, uri: null, isDemo: true }
    ];
  }

  function finish(callback) {
    scanning = false;
    ready = true;
    readyListeners.forEach(function (fn) { fn(tracks); });
    if (callback) callback(tracks);
  }

  function groupBy(keyFn) {
    var map = {};
    var order = [];
    tracks.forEach(function (track) {
      var key = keyFn(track);
      if (!map[key]) { map[key] = { name: key, tracks: [] }; order.push(key); }
      map[key].tracks.push(track);
    });
    return order.map(function (key) {
      var g = map[key];
      return { name: g.name, count: g.tracks.length, tracks: g.tracks };
    });
  }

  return {
    scan: scan,
    onReady: function (fn) { readyListeners.push(fn); },
    isScanning: function () { return scanning; },
    isReady: function () { return ready; },
    getTracks: function () { return tracks; },
    getAlbums: function () { return groupBy(function (t) { return t.album; }); },
    getArtists: function () { return groupBy(function (t) { return t.artist; }); },
    getFolders: function () {
      return groupBy(function (t) { return t.folder; }).map(function (g) {
        return { name: baseName(g.name) || g.name, path: g.name, count: g.count, tracks: g.tracks };
      });
    }
  };
})();
