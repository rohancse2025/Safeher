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

/* ─── Router ─────────────────────────────────────────────── */
SafeHer.router = (function() {
  // screens where the bottom nav must stay hidden
  var NO_NAV = [
    'splash', 'onboarding',
    'auth', 'register', 'verify-otp', 'signup-success', 'login',
    'fake-call', 'location', 'live-location', 'share-location', 'map',
    'helplines', 'help-rights', 'complaint-letter', 'evidence-checklist', 'nearby-places', 'police', 'volunteers', 'safe-timer',
    'evidence', 'sos-active', 'silent-mode', 'emergency-mode', 'set-pin', 'change-pin', '404', 'history', 'ride', 'ride-check', 'record-evidence', 'evidence-vault', 'escort'
  ];

  var current = null;
  var hooks   = {};   // onShow callbacks keyed by screen id

  function go(id) {
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
      if (id !== '404' && document.getElementById('screen-404')) {
        return go('404');
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
  // Register Service Worker with relative path
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(function(err) {
      console.warn('SW registration failed:', err);
    });
  }

  // Initialize PWA installation handlers
  if (SafeHer.pwa && SafeHer.pwa.init) {
    SafeHer.pwa.init();
  }

  // Initialize i18n translations first so all screens render with proper language
  SafeHer.i18n.init();

  // Ping cloud backend health immediately on startup to establish online status
  if (SafeHer.api && SafeHer.api.checkHealth) {
    SafeHer.api.checkHealth();
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

  // Handle incoming notification click messages from service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'NAVIGATE_SCREEN' && event.data.screen) {
        SafeHer.router.go(event.data.screen);
      }
    });
  }

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
    if (SafeHer.api.isLoggedIn()) {
      SafeHer.router.go('home');
    } else if (SafeHer.api.hasSeenOnboarding()) {
      SafeHer.router.go('auth');
    } else {
      SafeHer.router.go('onboarding');
    }
  }, 2000);
});
