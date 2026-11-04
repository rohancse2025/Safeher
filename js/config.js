// js/config.js – Backend server configuration and runtime flags
window.SafeHer = window.SafeHer || {};

(function() {
  var defaultApiBase = 'http://localhost:5000';
  if (typeof window !== 'undefined' && window.location && window.location.hostname) {
    var host = window.location.hostname;
    // When accessed from a phone or other device over the local network (e.g. 192.168.x.x, 10.x.x.x)
    if (host && host !== 'localhost' && host !== '127.0.0.1' && !host.endsWith('.github.io')) {
      defaultApiBase = window.location.protocol + '//' + host + ':5000';
    }
  }

  // Allow manual override via localStorage if configured
  var storedApi = '';
  try {
    storedApi = localStorage.getItem('safeher_api_base');
  } catch (e) {}

  window.SafeHerConfig = {
    API_BASE: storedApi || defaultApiBase,
    USE_BACKEND: true
  };
  window.SafeHer.config = window.SafeHerConfig;
})();
