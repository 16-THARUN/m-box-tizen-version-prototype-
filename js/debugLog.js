/**
 * debugLog.js — diagnostic log, kept in memory only (window.__bootLog). Release build: nothing is
 * shown on the TV screen (the on-screen box #keyDebug was removed from index.html, 2026-11-01).
 * Loaded as an external file first, because the inline version of this
 * script did not run on the real TV. Also catches any JS error and shows it.
 */
(function () {
  window.__bootLog = [];
  window.__debugLog = function (line) {
    var d = new Date();
    var ts = ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    if (/^key="/.test(line)) {                       // remote key presses: keep only the last 2, so they
      window.__keyLog = (window.__keyLog || []).slice(-1).concat(ts + ' ' + line);   // don't push Artwork/Lyrics lines off the box
      var el0 = document.getElementById('keyDebug');
      if (el0) el0.textContent = window.__bootLog.concat(window.__keyLog).join('\n');
      return;
    }
    window.__bootLog.unshift(ts + ' ' + line);
    if (window.__bootLog.length > 14) window.__bootLog.length = 14;
    var el = document.getElementById('keyDebug');
    if (el) el.textContent = window.__bootLog.concat(window.__keyLog || []).join('\n');
  };
  window.onerror = function (msg, url, line) {
    var fileName = (url || '').split('/').pop();
    window.__debugLog('JS ERROR: ' + msg + ' @ ' + fileName + ':' + line);
    return false;
  };
  window.__debugLog('boot: debugLog.js loaded');
})();
