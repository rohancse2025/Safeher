// js/app.js – router, toast, and app bootstrap

var SafeHer = window.SafeHer || {};

/* ─── XSS Sanitizer ──────────────────────────────────────── */
SafeHer.escapeHtml = function(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

/* ─── Global Location Cache ──────────────────────────────── */
SafeHer.getLastLocation = function() {
  try {
    var raw = localStorage.getItem('safeher_last_location');
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.lat === 'number' && typeof parsed.lng === 'number') {
        return parsed;
      }
    }
  } catch(e) {}
  return null;
};

SafeHer.setLastLocation = function(lat, lng) {
  if (!lat || !lng) return;
  try {
    var nLat = parseFloat(lat);
    var nLng = parseFloat(lng);
    if (!isNaN(nLat) && !isNaN(nLng) && (nLat !== 12.9716 || nLng !== 77.5946)) {
      localStorage.setItem('safeher_last_location', JSON.stringify({
        lat: nLat,
        lng: nLng,
        updatedAt: Date.now()
      }));
    }
  } catch(e) {}
};

/* ─── Router ─────────────────────────────────────────────── */
SafeHer.router = (function() {
  // screens where the bottom nav must stay hidden
  var NO_NAV = [
    'splash', 'onboarding',
    'auth', 'register', 'verify-otp', 'signup-success', 'login',
    'fake-call', 'location', 'live-location', 'share-location', 'map',
    'helplines', 'help-rights', 'complaint-letter', 'evidence-checklist', 'nearby-places', 'police', 'volunteers', 'safe-timer',
    'evidence', 'sos-active', 'silent-mode', 'emergency-mode', 'set-pin', 'change-pin', '404', 'history', 'ride', 'ride-check', 'record-evidence', 'evidence-vault', 'escort', 'notifications'
  ];

  var current = null;
  var hooks   = {};   // onShow callbacks keyed by screen id

  function go(id, force) {
    // Block router screen change and fading while Silent SOS is active (unless force=true)
    if (!force) {
      try {
        if (localStorage.getItem('safeher_silent_sos_active') === 'true') {
          console.log('[SafeHer Router] Screen change blocked in Silent SOS (flag active):', id);
          return;
        }
      } catch(e) {}
      if (SafeHer.sos && SafeHer.sos.getState) {
        var s = SafeHer.sos.getState();
        if (s === 'silent' || s === 'pin') {
          console.log('[SafeHer Router] Screen change blocked in Silent SOS:', id);
          return;
        }
      }
    }

    if (id === 'helplines') {
      id = 'help-rights';
    }
    if (id === 'live-location') {
      id = 'map';
    }
    if (id === 'police') {
      id = 'nearby-places';
    }

    var prev = document.querySelector('.screen.active');
    var next = document.getElementById('screen-' + id);
    if (!next) {
      console.warn('SafeHer: no screen #screen-' + id);
      if (id !== 'home' && document.getElementById('screen-home')) {
        return go('home', force);
      }
      return;
    }

    if (prev && prev.id === 'screen-map' && SafeHer.map && SafeHer.map.stopTracking) {
      SafeHer.map.stopTracking();
    }

    if (prev) prev.classList.remove('active');
    next.classList.add('active');
    current = id;

    var nav = document.getElementById('bottom-nav');
    if (NO_NAV.indexOf(id) !== -1) {
      nav.classList.add('hidden');
    } else {
      nav.classList.remove('hidden');
      document.querySelectorAll('.nav-item').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.screen === id);
      });
    }

    if (id === 'help-rights' && SafeHer.helpRights && SafeHer.helpRights.render) {
      SafeHer.helpRights.render();
    }

    if (hooks[id]) hooks[id]();
  }

  function onShow(id, fn) { hooks[id] = fn; }
  function getCurrent()   { return current; }

  return { go: go, onShow: onShow, getCurrent: getCurrent };
})();

/* ─── Toast with Optional Retry Action ────────────────────── */
SafeHer.toast = (function() {
  var timer = null;
  return function(msg, onRetry) {
    var el = document.getElementById('toast');
    if (!el) return;
    clearTimeout(timer);

    if (typeof onRetry === 'function') {
      el.innerHTML = '';
      var textSpan = document.createElement('span');
      textSpan.className = 'toast-msg';
      textSpan.textContent = msg;
      el.appendChild(textSpan);

      var retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'toast-retry-btn';
      retryBtn.textContent = 'Retry';
      retryBtn.onclick = function(e) {
        e.stopPropagation();
        el.classList.remove('show', 'has-action');
        onRetry();
      };
      el.appendChild(retryBtn);
      el.classList.add('has-action');
    } else {
      el.textContent = msg;
      el.classList.remove('has-action');
    }

    el.classList.add('show');
    timer = setTimeout(function() {
      el.classList.remove('show', 'has-action');
    }, (typeof onRetry === 'function') ? 7000 : 3200);
  };
})();

SafeHer.showRetryToast = function(msg, onRetry) {
  return SafeHer.toast(msg, onRetry);
};

SafeHer.pwa = (function() {
  var deferredPrompt = null;
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                     window.navigator.standalone === true ||
                     document.referrer.indexOf('android-app://') !== -1;

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  function showBanner() {
    if (isStandalone) return;
    if (SafeHer.storage && SafeHer.storage.get('pwa_banner_dismissed')) return;
    var banner = document.getElementById('pwa-install-banner');
    if (banner) banner.style.display = 'block';
  }

  function dismissBanner() {
    var banner = document.getElementById('pwa-install-banner');
    if (banner) banner.style.display = 'none';
    if (SafeHer.storage) SafeHer.storage.set('pwa_banner_dismissed', true);
  }

  function promptInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function(choice) {
        if (choice && choice.outcome === 'accepted') {
          dismissBanner();
          if (SafeHer.toast) SafeHer.toast('SafeHer installed successfully!');
        }
        deferredPrompt = null;
      });
    } else {
      openInstallModal();
    }
  }

  function openInstallModal() {
    var modal = document.getElementById('pwa-install-modal');
    if (!modal) return;
    var iosGuide = document.getElementById('pwa-guide-ios');
    var androidGuide = document.getElementById('pwa-guide-android');
    if (isIOS()) {
      if (iosGuide) iosGuide.style.display = 'block';
      if (androidGuide) androidGuide.style.display = 'none';
    } else {
      if (iosGuide) iosGuide.style.display = 'none';
      if (androidGuide) androidGuide.style.display = 'block';
    }
    modal.style.display = 'flex';
  }

  function closeInstallModal() {
    var modal = document.getElementById('pwa-install-modal');
    if (modal) modal.style.display = 'none';
  }

  function init() {
    window.addEventListener('beforeinstallprompt', function(e) {
      e.preventDefault();
      deferredPrompt = e;
      window.deferredInstallPrompt = e;
      showBanner();
    });

    window.addEventListener('appinstalled', function() {
      deferredPrompt = null;
      window.deferredInstallPrompt = null;
      dismissBanner();
      if (SafeHer.toast) SafeHer.toast('SafeHer installed on your device!');
    });

    if (!isStandalone) {
      setTimeout(showBanner, 1200);
    }
  }

  return {
    init: init,
    promptInstall: promptInstall,
    dismissBanner: dismissBanner,
    openInstallModal: openInstallModal,
    closeInstallModal: closeInstallModal,
    isStandalone: function() { return isStandalone; }
  };
})();

/* ─── Init ───────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', function() {
  // Register Service Worker with relative path and update check
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js?v=67').then(function(reg) {
      if (reg && reg.update) reg.update();
    }).catch(function(err) {
      console.warn('SW registration failed:', err);
    });
  }

  // Initialize PWA installation handlers
  if (SafeHer.pwa && SafeHer.pwa.init) {
    SafeHer.pwa.init();
  }

  // Initialize i18n translations first so all screens render with proper language
  SafeHer.i18n.init();

  // Ping cloud backend health immediately on startup to establish online status and start auto-heartbeat
  if (SafeHer.api && SafeHer.api.checkHealth) {
    SafeHer.api.checkHealth();
    setTimeout(function() { if (SafeHer.api && SafeHer.api.checkHealth) SafeHer.api.checkHealth(); }, 2000);
    setTimeout(function() { if (SafeHer.api && SafeHer.api.checkHealth) SafeHer.api.checkHealth(); }, 6000);
    if (SafeHer.api.startHeartbeat) {
      SafeHer.api.startHeartbeat();
    }
  }

  SafeHer.onboarding.init();
  SafeHer.auth.init();
  SafeHer.pin.init();
  SafeHer.home.init();
  SafeHer.contacts.init();
  SafeHer.tips.init();
  SafeHer.profile.init();
  SafeHer.sos.init();
  SafeHer.map.init();
  if (SafeHer.shareLocation) SafeHer.shareLocation.init();
  SafeHer.police.init();
  SafeHer.volunteer.init();
  SafeHer.timer.init();
  SafeHer.fakecall.init();
  SafeHer.evidence.init();
  if (SafeHer.helpRights && SafeHer.helpRights.init) SafeHer.helpRights.init();
  if (SafeHer.places && SafeHer.places.init) SafeHer.places.init();
  if (SafeHer.ride && SafeHer.ride.init) SafeHer.ride.init();
  if (SafeHer.escort && SafeHer.escort.init) SafeHer.escort.init();
  if (SafeHer.vault && SafeHer.vault.init) SafeHer.vault.init();
  if (SafeHer.notifications && SafeHer.notifications.init) SafeHer.notifications.init();

  // Continuous global background GPS acquisition on app launch
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(function(pos) {
      var lat = pos.coords.latitude;
      var lng = pos.coords.longitude;
      SafeHer.setLastLocation(lat, lng);
      if (SafeHer.api && SafeHer.api.saveLiveLocation) {
        SafeHer.api.saveLiveLocation({ lat: lat, lng: lng, accuracy: pos.coords.accuracy, timestamp: Date.now() });
      }
    }, function() {}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });

    navigator.geolocation.watchPosition(function(pos) {
      var lat = pos.coords.latitude;
      var lng = pos.coords.longitude;
      SafeHer.setLastLocation(lat, lng);
      if (SafeHer.api && SafeHer.api.saveLiveLocation) {
        SafeHer.api.saveLiveLocation({ lat: lat, lng: lng, accuracy: pos.coords.accuracy, timestamp: Date.now() });
      }
    }, function() {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  }

  // Handle incoming notification click messages from service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'NAVIGATE_SCREEN' && event.data.screen) {
        SafeHer.router.go(event.data.screen);
      }
    });
  }

  // Check for active silent SOS recovery on startup before rendering
  try {
    if (localStorage.getItem('safeher_silent_sos_active') === 'true') {
      console.log('[SafeHer App] Active Silent SOS detected on startup - restoring black screen');
      SafeHer.router.go('home', true); // Ensure baseline screen is active underneath
      if (SafeHer.sos && SafeHer.sos.restoreSilentMode) {
        SafeHer.sos.restoreSilentMode();
      }
      return;
    }
  } catch(e) {}

  // Check for SOS shortcut launch (?sos=1 or ?sos=quick) or notification screen launch (?screen=...)
  var urlParams = new URLSearchParams(window.location.search);
  var sosParam = urlParams.get('sos');
  var targetScreen = urlParams.get('screen');

  if (sosParam === 'quick') {
    SafeHer.router.go('home');
    if (SafeHer.sos && SafeHer.sos.startEmergencyMode) {
      SafeHer.sos.startEmergencyMode();
    } else if (SafeHer.sos && SafeHer.sos.startCountdown) {
      SafeHer.sos.startCountdown();
    }
    return;
  }

  if (sosParam === '1') {
    SafeHer.router.go('home');
    SafeHer.sos.startCountdown();
    return;
  }

  if (targetScreen) {
    SafeHer.router.go(targetScreen);
    return;
  }

  SafeHer.router.go('splash');
  setTimeout(function() {
    try {
      if (localStorage.getItem('safeher_silent_sos_active') === 'true' ||
          (SafeHer.sos && SafeHer.sos.getState && (SafeHer.sos.getState() === 'silent' || SafeHer.sos.getState() === 'pin'))) {
        console.log('[SafeHer App] Startup navigation aborted: Silent SOS active');
        return;
      }
    } catch(e) {}
    if (SafeHer.api.isLoggedIn()) {
      SafeHer.router.go('home');
    } else if (SafeHer.api.hasSeenOnboarding()) {
      SafeHer.router.go('auth');
    } else {
      SafeHer.router.go('onboarding');
    }
  }, 2000);
});

// ─── Global Error Resilience & Recovery ──────────────────────
window.addEventListener('error', function(e) {
  console.error('[SafeHer Uncaught Error]:', e.error || e.message);
  if (SafeHer.sos && SafeHer.sos.getState && (SafeHer.sos.getState() === 'silent' || SafeHer.sos.getState() === 'pin')) {
    if (SafeHer.sos.showSilentOverlay) SafeHer.sos.showSilentOverlay();
    return;
  }
  showGlobalErrorNotice();
});

window.addEventListener('unhandledrejection', function(e) {
  console.error('[SafeHer Unhandled Rejection]:', e.reason);
  if (SafeHer.sos && SafeHer.sos.getState && (SafeHer.sos.getState() === 'silent' || SafeHer.sos.getState() === 'pin')) {
    if (SafeHer.sos.showSilentOverlay) SafeHer.sos.showSilentOverlay();
    return;
  }
  showGlobalErrorNotice();
});

function showGlobalErrorNotice() {
  if (document.getElementById('global-error-banner')) return;
  var b = document.createElement('div');
  b.id = 'global-error-banner';
  b.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;background:#1F2937;color:#F9FAFB;padding:12px 16px;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.25);z-index:9999999;display:flex;align-items:center;justify-content:space-between;font-family:system-ui,sans-serif;font-size:13px;';
  b.innerHTML = '<span>Something went wrong.</span><button type="button" onclick="location.reload()" style="background:#EF4444;color:#FFF;border:none;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer;font-size:12px;margin-left:8px;">Reload</button>';
  document.body.appendChild(b);
}
