/**
 * library.js
 *
 * Owns the Library screen: the tab row and the list beneath it. Selecting
 * a track plays just that track (queue = all tracks in the current Tracks
 * list, so next/prev keep working); selecting an album/artist/folder plays
 * that group as a queue starting from its first track.
 */
var Library = (function () {
  // No Settings tab: the TV connects to the phone by itself (launch data, saved phone, Wi-Fi scan).
  var TABS = ['tracks', 'albums', 'artists', 'folders'];
  var TAB_LABELS = { tracks: 'Tracks', albums: 'Albums', artists: 'Artists', folders: 'Folders', settings: 'Settings' };

  var currentTab = 'tracks';
  var items = [];
  var selectedIndex = 0;

  // Settings tab ("Phone" connection). Two modes, both driven through the
  // same external API remote.js already calls (moveSelection /
  // selectionAtTop / focusFirstRow / activateSelected):
  //   'list'   - rows: [Scan for phones] [each found phone] [Enter IP manually]
  //   'manual' - the old 4-octet + port editor, as a fallback
  var settingsMode = 'list';
  var settingsRows = [];
  var settingsRowIndex = 0;
  var settingsHasFocus = false;
  var settingsFields = [192, 168, 1, 2, 8787];
  var settingsFieldIndex = 0;

  var listEl, statusEl, tabsEl, miniPlayer, miniTitle, miniArtist;

  function init() {
    listEl = document.getElementById('libraryList');
    statusEl = document.getElementById('libraryStatus');
    tabsEl = document.getElementById('libraryTabs');
    miniPlayer = document.getElementById('libraryMiniPlayer');
    miniTitle = document.getElementById('libraryMiniTitle');
    miniArtist = document.getElementById('libraryMiniArtist');

    var cfg = RemoteBridge.getConfig();
    var parts = cfg.host.split('.').map(Number);
    if (parts.length === 4 && parts.every(function (n) { return !isNaN(n); })) {
      settingsFields = [parts[0], parts[1], parts[2], parts[3], cfg.port];
    }

    RemoteBridge.onChange(function () {
      if (currentTab === 'settings') renderSettings();
    });

    highlightTab();
    statusEl.textContent = 'Scanning your media\u2026';
    statusEl.classList.remove('screen-hidden');
    listEl.innerHTML = '';

    MediaLibrary.scan(function () { refresh(); });
  }

  function refresh() {
    items = computeItems();
    selectedIndex = 0;
    render();
  }

  function computeItems() {
    switch (currentTab) {
      case 'tracks': return MediaLibrary.getTracks();
      case 'albums': return MediaLibrary.getAlbums();
      case 'artists': return MediaLibrary.getArtists();
      case 'folders': return MediaLibrary.getFolders();
      default: return [];
    }
  }

  function setTab(tab) {
    currentTab = tab;
    highlightTab();
    settingsMode = 'list';
    settingsHasFocus = false;
    refresh();
  }

  function nextTab() { setTab(TABS[(TABS.indexOf(currentTab) + 1) % TABS.length]); }
  function prevTab() { setTab(TABS[(TABS.indexOf(currentTab) - 1 + TABS.length) % TABS.length]); }

  function highlightTab() {
    tabsEl.querySelectorAll('.library-tab').forEach(function (el) {
      el.classList.toggle('active', el.dataset.tab === currentTab);
    });
  }

  function moveSelection(delta) {
    if (currentTab === 'settings') {
      if (settingsMode === 'manual') { adjustSettingsField(-delta); return; } // Up increases, like a spinner
      settingsRowIndex = Math.max(0, Math.min(settingsRows.length - 1, settingsRowIndex + delta));
      renderSettings();
      return;
    }
    if (!items.length) return;
    selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex + delta));
    highlightSelection();
  }

  function selectionAtTop() {
    if (currentTab === 'settings') {
      if (settingsMode === 'manual') return false; // Up adjusts values here; Back/Enter leave manual mode
      if (settingsRowIndex === 0) { settingsHasFocus = false; renderSettings(); return true; }
      return false;
    }
    return selectedIndex === 0;
  }

  function focusFirstRow() {
    if (currentTab === 'settings') { settingsHasFocus = true; settingsRowIndex = 0; renderSettings(); return; }
    selectedIndex = 0;
    highlightSelection();
  }

  /** Left/Right within the settings tab move between fields. No-op on
   *  every other tab (Left/Right there only switch tabs, unchanged). */
  function moveSettingsField(delta) {
    if (currentTab !== 'settings' || settingsMode !== 'manual') return;
    settingsFieldIndex = Math.max(0, Math.min(settingsFields.length - 1, settingsFieldIndex + delta));
    highlightSettingsField();
  }

  function adjustSettingsField(delta) {
    var idx = settingsFieldIndex;
    var isOctet = idx < 4;
    var min = isOctet ? 0 : 1;
    var max = isOctet ? 255 : 65535;
    settingsFields[idx] = Math.max(min, Math.min(max, settingsFields[idx] + delta));
    renderSettings();
  }

  function highlightSelection() {
    var rows = listEl.querySelectorAll('.library-row');
    rows.forEach(function (el, i) { el.classList.toggle('focused', i === selectedIndex); });
    var focused = rows[selectedIndex];
    if (focused) focused.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function activateSelected() {
    if (currentTab === 'settings') { activateSettingsRow(); return; }
    var item = items[selectedIndex];
    if (!item) return;

    if (currentTab === 'tracks') {
      Player.loadQueue(MediaLibrary.getTracks(), selectedIndex);
    } else {
      Player.loadQueue(item.tracks, 0);
    }
    Player.play();
    ScreenManager.show('nowPlaying');
  }

  function activateSettingsRow() {
    if (settingsMode === 'manual') { applySettingsConfig(); return; }
    var row = settingsRows[settingsRowIndex];
    if (!row) return;
    if (row.kind === 'scan') RemoteBridge.scanAndConnect();
    else if (row.kind === 'phone') RemoteBridge.connectTo(row.phone);
    else if (row.kind === 'engine') Player.setLosslessEngine(Player.getLosslessEngine() === 'native' ? 'visualizer' : 'native');
    else if (row.kind === 'manual') {
      var cfg = RemoteBridge.getConfig();
      var parts = cfg.host.split('.').map(Number);
      if (parts.length === 4 && parts.every(function (n) { return !isNaN(n); })) {
        settingsFields = [parts[0], parts[1], parts[2], parts[3], cfg.port];
      }
      settingsMode = 'manual';
      settingsFieldIndex = 0;
    }
    renderSettings();
  }

  function applySettingsConfig() {
    var host = settingsFields.slice(0, 4).join('.');
    var port = settingsFields[4];
    RemoteBridge.setConfig(host, port);
    settingsMode = 'list';
    renderSettings();
  }

  /** Back key on the Library screen. Returns true if handled here. */
  function handleBack() {
    if (currentTab === 'settings' && settingsMode === 'manual') {
      settingsMode = 'list';
      renderSettings();
      return true;
    }
    return false;
  }

  function render() {
    if (currentTab === 'settings') { renderSettings(); return; }

    var scanning = MediaLibrary.isScanning();
    var empty = !scanning && items.length === 0;

    statusEl.classList.toggle('screen-hidden', !(scanning || empty));
    if (scanning) statusEl.textContent = 'Scanning your media\u2026';
    if (empty) statusEl.textContent = 'No audio found. Connect a USB drive with music and reopen the app.';

    listEl.innerHTML = '';
    items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'library-row'; // focus applied separately by highlightSelection(), only once the list has focus

      if (currentTab === 'tracks') {
        row.innerHTML =
          '<div class="library-row-title">' + escapeHtml(item.title) + '</div>' +
          '<div class="library-row-sub">' + escapeHtml(item.artist) + (item.durationSec ? ' \u00b7 ' + formatTime(item.durationSec) : '') + '</div>';
      } else if (currentTab === 'folders') {
        row.innerHTML =
          '<div class="library-row-title">' + escapeHtml(item.name) + '</div>' +
          '<div class="library-row-sub">' + item.count + ' tracks \u00b7 ' + escapeHtml(item.path) + '</div>';
      } else {
        row.innerHTML =
          '<div class="library-row-title">' + escapeHtml(item.name) + '</div>' +
          '<div class="library-row-sub">' + item.count + ' tracks</div>';
      }
      listEl.appendChild(row);
    });
  }

  function buildSettingsRows() {
    var rows = [{ kind: 'scan' }];
    var phones = RemoteBridge.getFoundPhones();
    var current = RemoteBridge.getPhone();
    if (current && !phones.some(function (p) { return p.host === current.host; })) phones.unshift(current);
    phones.forEach(function (p) { rows.push({ kind: 'phone', phone: p }); });
    rows.push({ kind: 'manual' });
    rows.push({ kind: 'engine' });
    return rows;
  }

  function statusLine() {
    var st = RemoteBridge.getStatus();
    var p = RemoteBridge.getPhone();
    var n = RemoteBridge.getFoundPhones().length;
    switch (st) {
      case 'connected': return 'Connected to ' + p.name + ' (' + p.host + ')';
      case 'connecting': return 'Connecting to ' + (p ? p.name : 'phone') + '\u2026';
      case 'scanning': return 'Searching this Wi-Fi for m-box phones\u2026' + (n ? ' (' + n + ' found)' : '');
      case 'not-found': return 'No m-box phone found. Open m-box on your phone (same Wi-Fi), then scan again.';
      case 'choose': return n + ' phones found \u2014 pick one below.';
      default: return 'Not connected';
    }
  }

  function renderSettings() {
    statusEl.classList.add('screen-hidden');
    var st = RemoteBridge.getStatus();

    if (settingsMode === 'manual') {
      var octets = settingsFields.slice(0, 4).map(function (v, i) {
        return '<span class="settings-field" data-idx="' + i + '">' + v + '</span>' + (i < 3 ? '<span class="settings-sep">.</span>' : '');
      }).join('');
      listEl.innerHTML =
        '<div class="settings-panel">' +
          '<div class="settings-label">Enter your phone\u2019s IP address</div>' +
          '<div class="settings-ip-row">' + octets +
            '<span class="settings-sep settings-sep--colon">:</span>' +
            '<span class="settings-field" data-idx="4">' + settingsFields[4] + '</span>' +
          '</div>' +
          '<div class="settings-status settings-status--' + st + '">' + escapeHtml(statusLine()) + '</div>' +
          '<div class="settings-hint">\u2190 \u2192 field &middot; \u2191 \u2193 adjust &middot; Enter connect &middot; Back cancel</div>' +
        '</div>';
      highlightSettingsField();
      return;
    }

    settingsRows = buildSettingsRows();
    settingsRowIndex = Math.min(settingsRowIndex, settingsRows.length - 1);
    var current = RemoteBridge.getPhone();

    var html = '<div class="settings-panel">' +
      '<div class="settings-label">Phone</div>' +
      '<div class="settings-status settings-status--' + st + '">' + escapeHtml(statusLine()) + '</div>' +
      recentMessagesHtml() +
      '</div>';

    settingsRows.forEach(function (row, i) {
      var title, sub;
      if (row.kind === 'scan') {
        title = st === 'scanning' ? 'Scanning\u2026' : 'Scan for phones';
        sub = 'Find m-box phones on this Wi-Fi';
      } else if (row.kind === 'phone') {
        var isCurrent = current && current.host === row.phone.host && st === 'connected';
        title = row.phone.name;
        sub = row.phone.host + (isCurrent ? ' \u00b7 Connected' : ' \u00b7 Select to connect');
      } else if (row.kind === 'engine') {
        var nat = Player.getLosslessEngine() === 'native';
        title = 'Lossless (FLAC) playback: ' + (nat ? 'Native player' : 'Visualizer');
        sub = nat ? 'TV\u2019s own decoder (recommended: this TV\u2019s browser can\u2019t play FLAC) \u00b7 Enter to switch'
                  : 'Browser <audio> for TV-side visualizers \u00b7 falls back to native in 5 s \u00b7 Enter to switch';
      } else {
        title = 'Enter IP manually';
        sub = 'Fallback if scanning can\u2019t find your phone';
      }
      var focused = settingsHasFocus && i === settingsRowIndex ? ' focused' : '';
      html += '<div class="library-row settings-row' + focused + '">' +
        '<div class="library-row-title">' + escapeHtml(title) + '</div>' +
        '<div class="library-row-sub">' + escapeHtml(sub) + '</div>' +
        '</div>';
    });
    listEl.innerHTML = html;
  }

  function recentMessagesHtml() {
    if (RemoteBridge.getStatus() !== 'connected') return '';
    var msgs = RemoteBridge.getRecentMessages ? RemoteBridge.getRecentMessages() : [];
    var body = msgs.length ? msgs.map(escapeHtml).join('<br>') : 'Nothing received yet \u2014 press Play on the phone';
    return '<div class="settings-recent"><div class="settings-recent-title">Last from phone</div>' + body + '</div>';
  }

  function highlightSettingsField() {
    var fields = listEl.querySelectorAll('.settings-field');
    fields.forEach(function (el, i) { el.classList.toggle('focused', i === settingsFieldIndex); });
  }

  function updateMiniPlayer() {
    var track = Player.currentTrack();
    if (!track) { miniPlayer.classList.add('screen-hidden'); return; }
    miniPlayer.classList.remove('screen-hidden');
    miniTitle.textContent = track.title;
    miniArtist.textContent = track.artist;
  }

  function formatTime(sec) {
    sec = Math.floor(sec || 0);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  return {
    init: init,
    nextTab: nextTab,
    prevTab: prevTab,
    moveSelection: moveSelection,
    moveSettingsField: moveSettingsField,
    selectionAtTop: selectionAtTop,
    focusFirstRow: focusFirstRow,
    activateSelected: activateSelected,
    handleBack: handleBack,
    updateMiniPlayer: updateMiniPlayer
  };
})();
