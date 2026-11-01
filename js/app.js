// js/app.js – router, toast, and app bootstrap

var SafeHer = window.SafeHer || {};

/* ─── Router ─────────────────────────────────────────────── */
SafeHer.router = (function() {
  // screens where the bottom nav must stay hidden
  var NO_NAV = [
    'splash', 'onboarding',
    'auth', 'register', 'verify-otp', 'signup-success', 'login',
    'fake-call', 'location', 'live-location', 'share-location',
    'helplines', 'nearby-places', 'volunteers', 'safe-timer',
    'sos-active', 'silent-mode', 'emergency-mode', 'set-pin', 'change-pin'
  ];

  var current = null;
  var hooks   = {};   // onShow callbacks keyed by screen id

  function go(id) {
    var prev = document.querySelector('.screen.active');
    var next = document.getElementById('screen-' + id);
    if (!next) { console.warn('SafeHer: no screen #screen-' + id); return; }

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

    if (hooks[id]) hooks[id]();
  }

  function onShow(id, fn) { hooks[id] = fn; }
  function getCurrent()   { return current; }

  return { go: go, onShow: onShow, getCurrent: getCurrent };
})();

/* ─── Toast ──────────────────────────────────────────────── */
SafeHer.toast = (function() {
  var timer = null;
  return function(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(function() { el.classList.remove('show'); }, 3000);
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

  SafeHer.onboarding.init();
  SafeHer.auth.init();
  SafeHer.pin.init();
  SafeHer.home.init();
  SafeHer.contacts.init();
  SafeHer.tips.init();
  SafeHer.profile.init();
  SafeHer.sos.init();

  // Check for SOS shortcut launch (?sos=1)
  var urlParams = new URLSearchParams(window.location.search);
  var isSosShortcut = urlParams.get('sos') === '1';

  SafeHer.router.go('splash');
  setTimeout(function() {
    if (isSosShortcut) {
      SafeHer.router.go('home');
      SafeHer.sos.startCountdown();
    } else if (SafeHer.api.isLoggedIn()) {
      SafeHer.router.go('home');
    } else if (SafeHer.api.hasSeenOnboarding()) {
      SafeHer.router.go('auth');
    } else {
      SafeHer.router.go('onboarding');
    }
  }, 2000);
});
