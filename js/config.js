// js/config.js – Backend server configuration and runtime flags
window.SafeHer = window.SafeHer || {};

(function() {
  // Primary Cloud Backend URL (Runs 24/7 in Cloud - No laptop required!)
  var CLOUD_BACKEND_URL = 'https://safeher-dwkj.onrender.com';

  var defaultApiBase = CLOUD_BACKEND_URL;
  if (typeof window !== 'undefined' && window.location) {
    if (window.location.port === '5000' || (window.location.origin && window.location.origin.indexOf(':5000') !== -1)) {
      defaultApiBase = window.location.origin;
    } else if (window.location.hostname && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      defaultApiBase = 'http://localhost:5000';
    } else if (window.location.hostname && window.location.hostname.endsWith('.github.io')) {
      defaultApiBase = CLOUD_BACKEND_URL;
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
    // If running on GitHub Pages (phone or web), NEVER allow dead http:// or local IP addresses!
    if (typeof window !== 'undefined' && window.location && window.location.hostname && window.location.hostname.endsWith('.github.io')) {
      if (!storedApi || storedApi.indexOf('http://') === 0 || storedApi.indexOf('localhost') !== -1 || storedApi.indexOf('127.0.0.1') !== -1 || storedApi.indexOf('10.') !== -1 || storedApi.indexOf('192.168.') !== -1 || storedApi.indexOf('onrender.com') === -1) {
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
