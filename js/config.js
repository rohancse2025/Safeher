// js/config.js – Backend server configuration and runtime flags
window.SafeHer = window.SafeHer || {};

(function() {
  var defaultApiBase = 'http://localhost:5000';
  if (typeof window !== 'undefined' && window.location) {
    // If running on port 5000 directly from Flask server (e.g. http://192.168.x.x:5000 or http://localhost:5000)
    if (window.location.port === '5000' || (window.location.origin && window.location.origin.indexOf(':5000') !== -1)) {
      defaultApiBase = window.location.origin;
    } else if (window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && !window.location.hostname.endsWith('.github.io')) {
      defaultApiBase = window.location.protocol + '//' + window.location.hostname + ':5000';
    }
  }

  // Allow manual override via localStorage if configured
  var storedApi = '';
  try {
    storedApi = (localStorage.getItem('safeher_api_base') || '').trim();
    if (storedApi === 'null' || storedApi === 'undefined' || !storedApi) {
      storedApi = '';
      localStorage.removeItem('safeher_api_base');
    }
  } catch (e) {}

  window.SafeHerConfig = {
    API_BASE: storedApi || defaultApiBase,
    USE_BACKEND: true
  };
  window.SafeHer.config = window.SafeHerConfig;
})();
