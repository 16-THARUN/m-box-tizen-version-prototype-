/**
 * phoneDiscovery.js
 *
 * Finds m-box phones on the local network without typing an IP.
 *
 * Why a subnet scan instead of mDNS/Zeroconf: Tizen's mDNS API
 * (Tizen.Network.Nsd) only exists for Tizen .NET apps, not for Web apps
 * like this one. So instead, the TV reads its own IP (e.g. 192.168.1.4),
 * then probes every address on that /24 for a phone answering
 *   GET http://<ip>:8787/mbox/hello   ->  {"app":"m-box", "name":"...", ...}
 * Addresses with nothing listening fail fast; the whole scan takes a few
 * seconds. Phones that answer are returned as a pickable list.
 */
var PhoneDiscovery = (function () {
  var PHONE_PORT = 8787;
  var HELLO_PATH = '/mbox/hello';
  var PROBE_TIMEOUT_MS = 1500;
  var CONCURRENCY = 32;

  var scanning = false;
  var lastResults = [];

  /** Calls back with the subnet prefixes to scan, e.g. ["192.168.1"].
   *  Normally the TV's own subnet. In the emulator build (window.MBOX_EMULATOR)
   *  the TV sits behind QEMU's private network (10.0.2.15), where no phone can
   *  be, so the phone's Wi-Fi subnets are scanned instead (outgoing connections
   *  from the emulator reach your home network through the PC). */
  function getSubnetPrefix(callback) {
    var saved = prefixOf(localStorage.getItem('mbox_phone_host'));
    var fallback = saved || '192.168.1';
    var emu = window.MBOX_EMULATOR;
    function done(own) {
      var list = [own || fallback];
      if (emu && (!own || /^10\.0\.2$/.test(own) || emu.alwaysScanPhoneSubnets)) {
        list = [];
        if (saved) list.push(saved);
        (emu.phoneSubnets || ['192.168.1']).forEach(function (p) { if (list.indexOf(p) === -1) list.push(p); });
        if (window.__debugLog) window.__debugLog('PhoneDiscovery: emulator (own IP ' + (own ? own + '.x' : 'unknown') + ') \u2014 scanning the phone network instead');
      }
      callback(list);
    }

    if (typeof tizen === 'undefined' || !tizen.systeminfo) { done(null); return; }

    function tryProperty(prop, next) {
      try {
        tizen.systeminfo.getPropertyValue(prop, function (net) {
          var p = prefixOf(net && net.ipAddress);
          if (p) done(p); else next();
        }, function () { next(); });
      } catch (e) { next(); }
    }
    tryProperty('WIFI_NETWORK', function () {
      tryProperty('ETHERNET_NETWORK', function () { done(null); });
    });
  }

  function prefixOf(ip) {
    if (!ip) return null;
    var parts = String(ip).split('.');
    if (parts.length !== 4) return null;
    if (parts.some(function (n) { return n === '' || isNaN(Number(n)); })) return null;
    return parts.slice(0, 3).join('.');
  }

  /** Probes one host. Calls back with a phone object, or null. */
  function probe(host, callback) {
    var done = false;
    function finish(result) { if (!done) { done = true; callback(result); } }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://' + host + ':' + PHONE_PORT + HELLO_PATH, true);
      xhr.timeout = PROBE_TIMEOUT_MS;
      xhr.onload = function () {
        if (xhr.status !== 200) { finish(null); return; }
        try {
          var info = JSON.parse(xhr.responseText);
          if (!info || info.app !== 'm-box') { finish(null); return; }
          finish({
            host: host,
            port: PHONE_PORT,
            name: info.name || host,
            wsPath: info.wsPath || '/cast-bridge'
          });
        } catch (e) { finish(null); }
      };
      xhr.onerror = function () { finish(null); };
      xhr.ontimeout = function () { finish(null); };
      xhr.send();
    } catch (e) { finish(null); }
  }

  /**
   * Scans the whole /24. opts:
   *   onFound(phone)        - each phone as soon as it answers
   *   onProgress(done,total)
   *   onDone(phones[])
   */
  function scan(opts) {
    opts = opts || {};
    if (scanning) return false;
    scanning = true;
    lastResults = [];

    getSubnetPrefix(function (prefixes) {
      if (window.__debugLog) window.__debugLog('PhoneDiscovery: scanning ' + prefixes.map(function (p) { return p + '.1-254'; }).join(', '));
      var hosts = [], savedHost = localStorage.getItem('mbox_phone_host');
      if (savedHost && prefixes.indexOf(prefixOf(savedHost)) !== -1) hosts.push(savedHost);   // the last phone first
      prefixes.forEach(function (prefix) {
        for (var i = 1; i <= 254; i++) { var h = prefix + '.' + i; if (h !== savedHost) hosts.push(h); }
      });

      var next = 0, finished = 0, total = hosts.length;

      function launch() {
        if (next >= total) return;
        var host = hosts[next++];
        probe(host, function (phone) {
          finished++;
          if (phone) {
            lastResults.push(phone);
            if (window.__debugLog) window.__debugLog('PhoneDiscovery: found ' + phone.name + ' at ' + phone.host);
            if (opts.onFound) opts.onFound(phone);
          }
          if (opts.onProgress) opts.onProgress(finished, total);
          if (finished === total) {
            scanning = false;
            if (opts.onDone) opts.onDone(lastResults.slice());
          } else {
            launch();
          }
        });
      }
      for (var c = 0; c < CONCURRENCY; c++) launch();
    });
    return true;
  }

  return {
    scan: scan,
    probe: probe,
    isScanning: function () { return scanning; },
    lastResults: function () { return lastResults.slice(); },
    PHONE_PORT: PHONE_PORT
  };
})();
