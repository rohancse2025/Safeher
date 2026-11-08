// js/config.js – Backend server configuration and runtime flags
window.SafeHer = window.SafeHer || {};

(function() {
  // Primary Cloud Backend URL (Runs 24/7 in Cloud - No laptop required!)
  var CLOUD_BACKEND_URL = 'https://safeher-dwkj.onrender.com';

  var isGitHubPages = typeof window !== 'undefined' && window.location && window.location.hostname && window.location.hostname.endsWith('.github.io');
  var isLocalHost = typeof window !== 'undefined' && window.location && window.location.hostname && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  var defaultApiBase = CLOUD_BACKEND_URL;
  if (isLocalHost) {
    defaultApiBase = 'http://localhost:5000';
  } else {
    defaultApiBase = CLOUD_BACKEND_URL;
  }

  // Sanitize storedApi from localStorage
  var storedApi = '';
  try {
    storedApi = (localStorage.getItem('safeher_api_base') || '').trim();
    if (storedApi === 'null' || storedApi === 'undefined' || !storedApi) {
      storedApi = '';
      localStorage.removeItem('safeher_api_base');
    }

    // If on GitHub Pages, ALWAYS force Cloud Backend URL and purge any dead local IPs or old examples
    if (isGitHubPages || (!isLocalHost && storedApi.indexOf('http://') === 0)) {
      storedApi = CLOUD_BACKEND_URL;
      localStorage.setItem('safeher_api_base', CLOUD_BACKEND_URL);
    }

    // Clean up any old placeholder example URLs
    if (storedApi.indexOf('safeher-backend.onrender.com') !== -1) {
      storedApi = CLOUD_BACKEND_URL;
      localStorage.setItem('safeher_api_base', CLOUD_BACKEND_URL);
    }
  } catch (e) {}

  window.SafeHerConfig = {
    API_BASE: storedApi || CLOUD_BACKEND_URL || defaultApiBase,
    CLOUD_BACKEND_URL: CLOUD_BACKEND_URL,
    USE_BACKEND: true
  };
  window.SafeHer.config = window.SafeHerConfig;
})();
