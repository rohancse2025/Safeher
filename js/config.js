// js/config.js – Backend server configuration and runtime flags
window.SafeHer = window.SafeHer || {};

(function() {
  // Primary Cloud Backend URL (Runs 24/7 in Cloud - No laptop required!)
  // Set your deployed Render / Railway / Koyeb backend URL here:
  var CLOUD_BACKEND_URL = 'https://safeher-dwkj.onrender.com';

  var defaultApiBase = 'http://localhost:5000';
  if (typeof window !== 'undefined' && window.location) {
    // If running on port 5000 directly from Flask server (e.g. http://192.168.x.x:5000 or http://localhost:5000)
    if (window.location.port === '5000' || (window.location.origin && window.location.origin.indexOf(':5000') !== -1)) {
      defaultApiBase = window.location.origin;
    } else if (window.location.hostname && window.location.hostname.endsWith('.github.io')) {
      // Running on GitHub Pages (e.g. on mobile phone or public web)
      if (CLOUD_BACKEND_URL) {
        defaultApiBase = CLOUD_BACKEND_URL;
      }
    } else if (window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
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
    // Clean up stale localhost if running on GitHub Pages on phone when cloud URL exists
    if (typeof window !== 'undefined' && window.location && window.location.hostname && window.location.hostname.endsWith('.github.io') && CLOUD_BACKEND_URL) {
      if (storedApi.indexOf('localhost') !== -1 || storedApi.indexOf('127.0.0.1') !== -1) {
        storedApi = CLOUD_BACKEND_URL;
        try { localStorage.setItem('safeher_api_base', CLOUD_BACKEND_URL); } catch (e) {}
      }
    }
  } catch (e) {}

  window.SafeHerConfig = {
    API_BASE: storedApi || CLOUD_BACKEND_URL || defaultApiBase,
    CLOUD_BACKEND_URL: CLOUD_BACKEND_URL,
    USE_BACKEND: true
  };
  window.SafeHer.config = window.SafeHerConfig;
})();
