// js/sos.js – SOS modes (normal, silent, emergency), tap detector, audio siren, live tracking, Leaflet map, and PIN protection

SafeHer.sos = (function() {
  var countdownSecs = 5;
  var countdownInterval = null;
  var liveTrackingInterval = null;
  var volunteerStatusInterval = null;
  var currentAlertId = null;
  var alertStartTime = null;
  var prevContactResponseCount = 0;
  var durationTimer = null;
  var currentMode = 'normal'; // 'normal' | 'silent' | 'emergency'

  var mapInstance = null;
  var markerInstance = null;
  var currentLat = null;
  var currentLng = null;
  var currentAlertTime = '';

  // ─── Unified State Machine ('idle' | 'countdown' | 'normal' | 'silent' | 'emergency' | 'pin') ───
  var currentState = 'idle';
  var previousStateBeforePin = null;

  var VALID_TRANSITIONS = {
    'idle': ['countdown', 'silent', 'emergency'],
    'countdown': ['idle', 'silent', 'emergency', 'normal'],
    'normal': ['pin', 'emergency', 'idle'],
    'silent': ['pin', 'idle'],
    'emergency': ['pin', 'idle'],
    'pin': ['idle', 'silent', 'emergency', 'normal']
  };

  function setState(next) {
    if (next === currentState) return true;
    var allowed = VALID_TRANSITIONS[currentState] || [];
    if (allowed.indexOf(next) === -1) {
      console.warn('[SafeHer SOS State] Impossible transition rejected:', currentState, '->', next);
      updateDebugOverlay();
      return false;
    }
    var from = currentState;
    currentState = next;
    console.log('[SafeHer SOS State]:', from, '->', currentState);

    // Clear all tap counters whenever state changes
    tapTimes = [];
    silentTapTimes = [];
    lastTapTimestamp = 0;

    onStateTransition(from, currentState);
    updateDebugOverlay();
    return true;
  }

  function onStateTransition(from, to) {
    // If leaving countdown, always ensure countdown timer and overlays are cleared
    if (to !== 'countdown') {
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      if (silentPendingTimer) {
        clearTimeout(silentPendingTimer);
        silentPendingTimer = null;
      }
      var overlay = document.getElementById('sos-countdown-overlay');
      if (overlay) overlay.classList.remove('active');
    }

    if (to === 'silent') {
      showSilentOverlay();
      modeEnteredTimestamp = Date.now();
      try {
        localStorage.setItem('safeher_silent_sos_active', 'true');
        if (currentAlertId) localStorage.setItem('safeher_silent_alert_id', String(currentAlertId));
      } catch(e) {}
    } else if (to === 'pin') {
      // KEEP #silent-overlay visible and active!
      // The silent PIN pad renders directly on top of the black background.
      // Hiding the overlay here was the primary cause of the white screen!
      showSilentOverlay();
    } else if (to === 'idle') {
      hideSilentOverlay();
      try {
        localStorage.removeItem('safeher_silent_sos_active');
        localStorage.removeItem('safeher_silent_alert_id');
      } catch(e) {}
    }
  }

  // ─── Debug Overlay Mode (?debug=1) ─────────────────────────
  var isDebugMode = (function() {
    try {
      return window.location.search.indexOf('debug=1') !== -1;
    } catch(e) {
      return false;
    }
  })();

  function updateDebugOverlay() {
    if (!isDebugMode) return;
    var el = document.getElementById('safeher-sos-debug');
    if (!el) {
      el = document.createElement('div');
      el.id = 'safeher-sos-debug';
      el.style.cssText = 'position:fixed;bottom:6px;right:6px;z-index:2147483647;font-family:monospace;font-size:10px;color:#666666;background:rgba(0,0,0,0.85);padding:3px 8px;border-radius:4px;pointer-events:none;user-select:none;border:1px solid #333;';
      document.body.appendChild(el);
    }
    var taps = (currentState === 'silent' ? silentTapTimes.length : tapTimes.length);
    el.textContent = 'state:' + currentState + ' taps:' + taps + ' mode:' + currentMode;
  }

  // Tap handling state (pointerdown-only, 80ms debounce, 2s sliding window)
  var tapTimes = [];
  var silentTapTimes = [];
  var lastTapTimestamp = 0;
  var tapInactivityTimer = null;
  var modeEnteredTimestamp = 0;
  var longPressTimer = null;

  var silentPendingTimer = null;
  var wakeLock = null;
  var isAlertEnded = false;
  var lastEndedPin = '1234';
  var noVolunteerToastShown = false;

  // Web Audio Context for Emergency Siren
  var audioCtx = null;
  var sirenOsc = null;
  var sirenGain = null;
  var sirenTimer = null;
  var vibeTimer = null;

  // Fallback location: Bengaluru (12.9716, 77.5946)
  var BENGALURU_LAT = 12.9716;
  var BENGALURU_LNG = 77.5946;

  // Active Responders and Post-Alert Feedback
  var currentAlertResponders = [];
  var feedbackAlertId = null;
  var feedbackQueue = [];
  var currentFeedbackVol = null;

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── Mode Detection from Tap Count on Pointerdown ─────────────
  function onSosButtonPointerDown(e) {
    if (e && e.preventDefault) e.preventDefault();
    var now = Date.now();
    if (now - lastTapTimestamp < 80) return;
    lastTapTimestamp = now;

    console.log('[SafeHer SOS] SOS button pointerdown');
    if (currentState === 'idle') {
      startCountdown();
    } else if (currentState === 'countdown') {
      registerTap();
    }
  }

  function onOverlayPointerDown(e) {
    if (e && e.target && e.target.classList.contains('sos-countdown-cancel')) {
      cancelCountdown();
      return;
    }
    if (e && e.preventDefault) e.preventDefault();
    var now = Date.now();
    if (now - lastTapTimestamp < 80) return;
    lastTapTimestamp = now;

    console.log('[SafeHer SOS] Overlay pointerdown');
    registerTap();
  }

  function registerTap() {
    if (currentState !== 'countdown') return;
    var now = Date.now();
    tapTimes.push(now);
    tapTimes = tapTimes.filter(function(t) { return now - t <= 2000; });

    clearTimeout(tapInactivityTimer);
    tapInactivityTimer = setTimeout(function() {
      tapTimes = [];
      updateDebugOverlay();
    }, 2000);

    var count = tapTimes.length;
    console.log('[SafeHer SOS] Countdown tap registered, count =', count);
    updateDebugOverlay();

    if (count >= 5) {
      if (silentPendingTimer) {
        clearTimeout(silentPendingTimer);
        silentPendingTimer = null;
      }
      tapTimes = [];
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      var overlay = document.getElementById('sos-countdown-overlay');
      if (overlay) overlay.classList.remove('active');
      startEmergencyMode();
      return;
    }

    if (count >= 3) {
      // STOP COUNTDOWN INTERVAL IMMEDIATELY so it can NEVER tick or trigger normal SOS
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      if (silentPendingTimer) {
        clearTimeout(silentPendingTimer);
        silentPendingTimer = null;
      }
      tapTimes = [];
      var overlay = document.getElementById('sos-countdown-overlay');
      if (overlay) overlay.classList.remove('active');

      // ★ SHOW BLACK SCREEN IMMEDIATELY (zero delay) on 3rd tap
      // Do NOT wait for a setTimeout — the 300 ms gap was causing the white flash
      startSilentMode();
    }
  }

  // ─── Duration Counter (mm:ss) ───────────────────────────
  function startDurationCounter(startTime) {
    clearInterval(durationTimer);
    alertStartTime = startTime || Date.now();
    updateDurationDisplay();

    durationTimer = setInterval(function() {
      updateDurationDisplay();
    }, 1000);
  }

  function updateDurationDisplay() {
    var durEl = document.getElementById('sos-duration');
    var emDurEl = document.getElementById('em-sos-duration');
    if (!alertStartTime) return;

    var elapsedSecs = Math.max(0, Math.floor((Date.now() - alertStartTime) / 1000));
    var mins = Math.floor(elapsedSecs / 60);
    var secs = elapsedSecs % 60;
    var mm = (mins < 10 ? '0' : '') + mins;
    var ss = (secs < 10 ? '0' : '') + secs;
    var formatted = mm + ':' + ss;

    if (durEl) durEl.textContent = formatted;
    if (emDurEl) emDurEl.textContent = formatted;
  }

  function stopDurationCounter() {
    clearInterval(durationTimer);
    durationTimer = null;
    alertStartTime = null;
    var durEl = document.getElementById('sos-duration');
    if (durEl) durEl.textContent = '00:00';
    var emDurEl = document.getElementById('em-sos-duration');
    if (emDurEl) emDurEl.textContent = '00:00';
  }

  function buildAlertMessage() {
    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : null;
    var userName = (user && user.name && user.name !== 'SafeHer User') ? user.name : 'Rohan P';

    var now = new Date();
    var y = now.getFullYear();
    var m = String(now.getMonth() + 1).padStart(2, '0');
    var d = String(now.getDate()).padStart(2, '0');
    var h = String(now.getHours()).padStart(2, '0');
    var mi = String(now.getMinutes()).padStart(2, '0');
    var s = String(now.getSeconds()).padStart(2, '0');
    var timeStr = y + '-' + m + '-' + d + ' ' + h + ':' + mi + ':' + s;

    var lat = (typeof currentLat === 'number') ? currentLat.toFixed(6) : (currentLat || '13.0691321');
    var lng = (typeof currentLng === 'number') ? currentLng.toFixed(6) : (currentLng || '77.7946567');
    var mapsUrl = 'https://www.google.com/maps?q=' + lat + ',' + lng;

    var active = (SafeHer.api && SafeHer.api.getActiveSos) ? SafeHer.api.getActiveSos() : null;
    var token = (active && active.shareToken) ? active.shareToken : (currentShareToken || 'live_emergency');
    var frontendUrl = (window.SafeHerConfig && window.SafeHerConfig.FRONTEND_URL) || 'https://rohancse2025.github.io/Safeher';
    frontendUrl = frontendUrl.replace(/\/+$/, '');
    var trackUrl = frontendUrl + '/track.html?t=' + token;

    var modeStr = (currentMode || 'emergency').toUpperCase();

    var msg = '🚨 *EMERGENCY SOS ALERT - SafeHer* 🚨\n\n' +
      '*' + userName + '* has triggered an urgent SOS alert!\n\n' +
      '⚠️ *Mode*: ' + modeStr + '\n' +
      '🕒 *Time*: ' + timeStr + '\n' +
      '📍 *Google Maps Location*:\n' + mapsUrl + '\n\n' +
      '🔴 *Live Tracking Map*:\n' + trackUrl + '\n\n' +
      '⚡ *Quick 1-Tap Response (No app needed):*\n' +
      '🏃 On my way: ' + trackUrl + '&action=on_my_way\n' +
      '📞 Called her: ' + trackUrl + '&action=called\n' +
      '🚓 Alerted Police: ' + trackUrl + '&action=police_alerted\n' +
      '✅ Safe with me: ' + trackUrl + '&action=safe_with_me\n\n' +
      'Please contact ' + userName + ' immediately or call Police (112).';

    return msg;
  }

  // ─── 5-4-3-2-1 Countdown (Normal Mode) ────────────────────
  function startCountdown() {
    // If no PIN set, set default PIN '1234' so emergency SOS trigger is NEVER blocked
    if (!SafeHer.api.hasPin()) {
      SafeHer.api.setPin('1234');
    }

    var overlay = document.getElementById('sos-countdown-overlay');
    if (overlay && overlay.classList.contains('active')) {
      // Countdown is already active, this counts as an additional tap
      registerTap();
      return;
    }

    if (silentPendingTimer) {
      clearTimeout(silentPendingTimer);
      silentPendingTimer = null;
    }

    if (!setState('countdown')) {
      return;
    }

    currentMode = 'normal';
    tapTimes = [Date.now()]; // first tap on the SOS button counts
    countdownSecs = 5;

    var numEl = document.getElementById('sos-countdown-num');
    if (!overlay || !numEl) return;

    numEl.textContent = countdownSecs;
    overlay.classList.add('active');

    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    countdownInterval = setInterval(function() {
      if (currentState !== 'countdown') {
        clearInterval(countdownInterval);
        countdownInterval = null;
        return;
      }
      countdownSecs--;
      if (countdownSecs > 0) {
        numEl.textContent = countdownSecs;
      } else {
        clearInterval(countdownInterval);
        countdownInterval = null;
        overlay.classList.remove('active');
        if (currentState === 'countdown') {
          setState('normal');
          triggerActiveAlert('normal');
        }
      }
    }, 1000);
  }

  function cancelCountdown() {
    if (currentState !== 'countdown') {
      console.log('[SafeHer SOS] cancelCountdown() ignored: not in countdown (current state is ' + currentState + ')');
      return;
    }
    if (silentPendingTimer) {
      clearTimeout(silentPendingTimer);
      silentPendingTimer = null;
    }
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    tapTimes = [];
    var overlay = document.getElementById('sos-countdown-overlay');
    if (overlay) overlay.classList.remove('active');
    setState('idle');
    SafeHer.toast('SOS alert cancelled');
    if (SafeHer.router && SafeHer.router.go) {
      SafeHer.router.go('home');
    }
  }

  function onOverlayTap(e) {
    if (e && e.target && e.target.classList.contains('sos-countdown-cancel')) return;
    registerTap();
  }

  // ─── Trigger Active SOS ──────────────────────────────────
  function triggerActiveAlert(mode) {
    currentMode = mode || 'normal';
    isAlertEnded = false;
    lastEndedPin = '1234';
    noVolunteerToastShown = false;
    hideOfflineFallback();

    if (SafeHer.home && SafeHer.home.setSOSActive) {
      SafeHer.home.setSOSActive(true);
    }

    var savedLoc = (window.SafeHer && SafeHer.getLastLocation) ? SafeHer.getLastLocation() : null;
    currentLat = (savedLoc && savedLoc.lat) ? savedLoc.lat : BENGALURU_LAT;
    currentLng = (savedLoc && savedLoc.lng) ? savedLoc.lng : BENGALURU_LNG;

    var now = new Date();
    currentAlertTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Save alert into alert history via api.js immediately (with 3-attempt retry)
    var newAlert = SafeHer.api.addAlert({
      time: currentAlertTime,
      timestamp: Date.now(),
      lat: currentLat,
      lng: currentLng,
      mode: currentMode,
      status: 'active'
    }, function(err, created, isOfflineFallback) {
      if (err) {
        var isTooMany = (typeof err === 'string' && (err.toLowerCase().indexOf('too many alerts') !== -1 || err.toLowerCase().indexOf('rate limit') !== -1));
        if (isTooMany) {
          if (currentMode === 'silent') {
            console.log('[SafeHer SOS] Rate limit reached in silent SOS -> keeping pure black screen silently');
            return;
          }
          // Abuse limit hit in normal/emergency mode: cancel active alert state and show modal
          if (silentPendingTimer) {
            clearTimeout(silentPendingTimer);
            silentPendingTimer = null;
          }
          stopTrackingInterval();
          stopDurationCounter();
          stopVolunteerStatusPolling();
          stopSiren();
          stopVibration();
          releaseWakeLock();

          currentAlertId = null;
          if (SafeHer.api && SafeHer.api.clearActiveSos) {
            SafeHer.api.clearActiveSos();
          }
          if (SafeHer.home && SafeHer.home.setSOSActive) {
            SafeHer.home.setSOSActive(false);
          }
          SafeHer.router.go('home');
          var modal = document.getElementById('too-many-alerts-modal');
          if (modal) {
            modal.style.display = 'flex';
          } else {
            SafeHer.toast('Too many alerts, call 112 directly');
          }
          return;
        }

        // When SOS creation fails after 3 retries, show offline emergency fallback (non-silent only)
        if (currentMode !== 'silent' && (isOfflineFallback || (typeof err === 'string' && err.indexOf('failed after 3 attempts') !== -1))) {
          showOfflineFallback();
        }
      }
      if (!err && created && created.id) {
        if (isAlertEnded) {
          // If the alert was stopped by user while creation was in flight, immediately resolve on backend!
          if (SafeHer.api && SafeHer.api.endAlert) {
            SafeHer.api.endAlert(created.id, lastEndedPin || '1234');
          }
          return;
        }
        currentAlertId = created.id;
        var active = SafeHer.api && SafeHer.api.getActiveSos ? SafeHer.api.getActiveSos() : null;
        if (active) {
          active.id = created.id;
          if (created.shareToken) active.shareToken = created.shareToken;
          SafeHer.api.setActiveSos(active);
        }
        startVolunteerStatusPolling();
      }
    });
    currentAlertId = newAlert ? newAlert.id : Date.now();

    if (SafeHer.api && SafeHer.api.setActiveSos) {
      SafeHer.api.setActiveSos({
        id: currentAlertId,
        time: currentAlertTime,
        timestamp: Date.now(),
        lat: currentLat,
        lng: currentLng,
        mode: currentMode,
        status: 'active',
        volunteersEnRoute: 0,
        volunteerStatus: 'Waiting for volunteers...'
      });
    }

    var volunteerSubEl = document.getElementById('sos-status-sub');
    if (volunteerSubEl) volunteerSubEl.textContent = 'Waiting for volunteers...';
    renderContactsResponding([]);

    startDurationCounter();
    startTrackingInterval();
    startVolunteerStatusPolling();

    // Render screen IMMEDIATELY without delay
    if (currentMode === 'normal') {
      var timeEl = document.getElementById('sos-alert-time');
      if (timeEl) timeEl.textContent = currentAlertTime;

      SafeHer.router.go('sos-active');
      updateMap(currentLat, currentLng);
      updateGmapsLink(currentLat, currentLng, 'sos-gmaps-link');
      renderNotifiedContacts('sos-notified-list');

      SafeHer.toast('SOS activated');

      if (mapInstance) {
        mapInstance.invalidateSize();
        setTimeout(function() {
          if (mapInstance) mapInstance.invalidateSize();
        }, 300);
      }

      // Auto-start evidence recording in normal SOS mode if enabled in settings
      if (SafeHer.vault) {
        var vSettings = SafeHer.vault.getSettings ? SafeHer.vault.getSettings() : null;
        if (vSettings && vSettings.enabled) {
          if (vSettings.recordEmergencyVideo && SafeHer.vault.startEmergencySession) {
            SafeHer.vault.startEmergencySession(currentAlertId);
          } else if (vSettings.recordSilentAudio && SafeHer.vault.startSilentSession) {
            SafeHer.vault.startSilentSession(currentAlertId);
          }
        }
      }
    } else if (currentMode === 'silent') {
      showSilentOverlay();
      if (SafeHer.vault && SafeHer.vault.startSilentSession) {
        try { SafeHer.vault.startSilentSession(currentAlertId); } catch(e) {}
      } else if (SafeHer.vault && SafeHer.vault.startSession) {
        try { SafeHer.vault.startSession('audio', currentAlertId); } catch(e) {}
      }
    } else if (currentMode === 'emergency') {
      renderEmergencyMode();
      if (SafeHer.vault && SafeHer.vault.startEmergencySession) {
        try { SafeHer.vault.startEmergencySession(currentAlertId); } catch(e) {}
      } else if (SafeHer.vault && SafeHer.vault.getSettings().enabled) {
        var vSettings = SafeHer.vault.getSettings();
        if (vSettings.recordEmergencyVideo) {
          try { SafeHer.vault.startSession('video', currentAlertId); } catch(e) {}
        } else if (vSettings.recordSilentAudio) {
          try { SafeHer.vault.startSession('audio', currentAlertId); } catch(e) {}
        }
      }
    }

    // Now resolve real location in the background
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          currentLat = pos.coords.latitude;
          currentLng = pos.coords.longitude;
          if (window.SafeHer && SafeHer.setLastLocation) {
            SafeHer.setLastLocation(currentLat, currentLng);
          }

          if (currentAlertId) {
            SafeHer.api.updateAlert(currentAlertId, {
              lat: currentLat,
              lng: currentLng
            });
            if (SafeHer.api.getActiveSos) {
              var activeSos = SafeHer.api.getActiveSos();
              if (activeSos && activeSos.id === currentAlertId) {
                activeSos.lat = currentLat;
                activeSos.lng = currentLng;
                SafeHer.api.setActiveSos(activeSos);
              }
            }
          }

          if (currentMode === 'normal') {
            updateMap(currentLat, currentLng);
            updateGmapsLink(currentLat, currentLng, 'sos-gmaps-link');
            renderNotifiedContacts('sos-notified-list');
          } else if (currentMode === 'emergency') {
            updateGmapsLink(currentLat, currentLng, 'em-gmaps-link');
            renderNotifiedContacts('em-notified-list');
          }
        },
        function() {
          if (currentMode !== 'silent') {
            SafeHer.toast('Location off. Using Bengaluru fallback.');
          }
        },
        { timeout: 7000 }
      );
    } else {
      if (currentMode !== 'silent') {
        SafeHer.toast('Geolocation unsupported. Using Bengaluru fallback.');
      }
    }
  }

  // ─── Wake Lock Management ─────────────────────────────────
  function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(function(lock) {
          wakeLock = lock;
          lock.addEventListener('release', function() {
            if (currentState === 'silent' && document.visibilityState === 'visible') {
              requestWakeLock();
            }
          });
        }).catch(function(err) {
          console.warn('[SafeHer SOS] WakeLock error:', err);
        });
      }
    } catch(e) {
      console.warn('[SafeHer SOS] WakeLock error:', e);
    }
  }

  // ─── Silent Mode & Dedicated #silent-overlay ───────────────
  function showSilentOverlay() {
    try {
      document.documentElement.classList.add('silent-active');
      var metaTheme = document.querySelector('meta[name="theme-color"]');
      if (metaTheme) metaTheme.setAttribute('content', '#000000');

      var overlay = document.getElementById('silent-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'silent-overlay';
        document.body.appendChild(overlay);
      }
      overlay.style.display = 'block';
      overlay.onpointerdown = onSilentPointerDown;
      overlay.onpointerup = onSilentPointerUp;
      overlay.onpointercancel = onSilentPointerCancel;
      overlay.oncontextmenu = function(e) { e.preventDefault(); return false; };
    } catch(e) {
      console.warn('[SafeHer SOS] showSilentOverlay error:', e);
    }
  }

  function hideSilentOverlay() {
    try {
      document.documentElement.classList.remove('silent-active');
      var metaTheme = document.querySelector('meta[name="theme-color"]');
      if (metaTheme) metaTheme.setAttribute('content', '#A80F3C');

      var overlay = document.getElementById('silent-overlay');
      if (overlay) {
        overlay.style.display = 'none';
        overlay.onpointerdown = null;
        overlay.onpointerup = null;
        overlay.onpointercancel = null;
      }
    } catch(e) {
      console.warn('[SafeHer SOS] hideSilentOverlay error:', e);
    }
  }

  function startSilentMode() {
    // Guard: if already in silent or transitioning, do not re-enter
    if (currentState === 'silent' || currentState === 'pin') {
      console.log('[SafeHer SOS] startSilentMode() called but already in', currentState, '- ignoring');
      showSilentOverlay(); // ensure overlay is visible
      return;
    }

    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    if (silentPendingTimer) {
      clearTimeout(silentPendingTimer);
      silentPendingTimer = null;
    }
    var cdOverlay = document.getElementById('sos-countdown-overlay');
    if (cdOverlay) cdOverlay.classList.remove('active');

    // Show black overlay FIRST synchronously — setState triggers showSilentOverlay via onStateTransition
    setState('silent');
    showSilentOverlay(); // redundant but ensures overlay is definitely shown

    // Async work wrapped in try/catch and .catch
    requestWakeLock();

    try {
      var docEl = document.documentElement;
      if (docEl.requestFullscreen) {
        docEl.requestFullscreen().catch(function() {});
      }
    } catch(e) {}

    try {
      triggerActiveAlert('silent');
    } catch(e) {
      console.warn('[SafeHer SOS] triggerActiveAlert silent error:', e);
    }
  }

  function renderSilentMode() {
    showSilentOverlay();
    requestWakeLock();
  }

  function onSilentPointerDown(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (currentState !== 'silent') return;

    var now = Date.now();
    // Ignore all taps for 1.5 seconds after entering mode
    if (now - modeEnteredTimestamp < 1500) {
      console.log('[SafeHer SOS] Tap ignored during 1.5s grace period');
      return;
    }

    // Debounce: ignore events less than 80ms apart
    if (now - lastTapTimestamp < 80) return;
    lastTapTimestamp = now;

    // Start 2-second long press timer
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(function() {
      longPressTimer = null;
      if (currentState === 'silent') {
        console.log('[SafeHer SOS] 2s long press detected -> opening silent PIN pad');
        openSilentPinPad();
      }
    }, 2000);

    // 3 taps within 2 seconds
    silentTapTimes.push(now);
    silentTapTimes = silentTapTimes.filter(function(t) { return now - t <= 2000; });

    clearTimeout(tapInactivityTimer);
    tapInactivityTimer = setTimeout(function() {
      silentTapTimes = [];
      updateDebugOverlay();
    }, 2000);

    updateDebugOverlay();

    if (silentTapTimes.length >= 3) {
      silentTapTimes = [];
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      console.log('[SafeHer SOS] 3 taps detected -> opening silent PIN pad');
      openSilentPinPad();
    }
  }

  function onSilentPointerUp(e) {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function onSilentPointerCancel(e) {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function openSilentPinPad() {
    if (currentState !== 'silent') return;
    setState('pin');

    SafeHer.askPin(
      function(enteredPin, pinResult) {
        if (pinResult === 'duress') {
          console.log('[SafeHer SOS] Duress PIN entered -> returning Home while alert keeps running');
          hideSilentOverlay();
          setState('idle');
          SafeHer.router.go('home', true);
          return;
        }

        console.log('[SafeHer SOS] Correct PIN entered -> ending alert');
        endAlertSilently(enteredPin || '1234');
      },
      function(reason) {
        console.log('[SafeHer SOS] Silent PIN pad closed/failed (' + reason + ') -> returning silently to black');
        setState('silent');
      },
      { isSilent: true, silentMode: true, blackTheme: true }
    );
  }

  function promptExitSilent() {
    openSilentPinPad();
  }

  function restoreSilentMode() {
    console.log('[SafeHer SOS] Restoring active silent SOS from localStorage');
    currentState = 'silent';
    currentMode = 'silent';
    modeEnteredTimestamp = Date.now();
    try {
      var savedId = localStorage.getItem('safeher_silent_alert_id');
      if (savedId) currentAlertId = savedId;
    } catch(e) {}
    showSilentOverlay();
    requestWakeLock();
    startDurationCounter();
    startTrackingInterval();
    startVolunteerStatusPolling();
    updateDebugOverlay();
  }

  function endAlertSilently(enteredPin) {
    silentTapTimes = [];
    isAlertEnded = true;
    lastEndedPin = enteredPin || '1234';
    hideOfflineFallback();
    hideSilentOverlay();

    // Guarantee PIN pad is completely closed, classes removed, and hidden
    if (SafeHer.pin && SafeHer.pin.closePad) {
      try { SafeHer.pin.closePad(); } catch(e) {}
    }
    var pinPadEl = document.getElementById('pin-pad-overlay');
    if (pinPadEl) {
      pinPadEl.classList.remove('active', 'pin-silent-mode', 'pin-black-theme');
      pinPadEl.style.display = 'none';
    }
    document.documentElement.classList.remove('silent-active');
    document.documentElement.style.backgroundColor = '';

    try {
      localStorage.removeItem('safeher_silent_sos_active');
      localStorage.removeItem('safeher_silent_alert_id');
    } catch(e) {}
    if (silentPendingTimer) {
      clearTimeout(silentPendingTimer);
      silentPendingTimer = null;
    }

    stopTrackingInterval();
    stopDurationCounter();
    stopVolunteerStatusPolling();
    releaseWakeLock();
    if (SafeHer.vault && SafeHer.vault.endSession) {
      try { SafeHer.vault.endSession(); } catch(e) {}
    }

    if (document.fullscreenElement && document.exitFullscreen) {
      try { document.exitFullscreen().catch(function() {}); } catch(e) {}
    }

    var alertIdForFeedback = currentAlertId;
    var respondersForFeedback = (currentAlertResponders && currentAlertResponders.length > 0) ? currentAlertResponders.slice() : [];

    if (currentAlertId) {
      if (SafeHer.api && SafeHer.api.endAlert) {
        SafeHer.api.endAlert(currentAlertId, enteredPin || '1234');
      } else {
        SafeHer.api.updateAlert(currentAlertId, {
          status: 'resolved',
          endTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });
      }
      currentAlertId = null;
    }

    if (SafeHer.deliveryTracker) {
      SafeHer.deliveryTracker.stopAll();
    }

    if (SafeHer.api && SafeHer.api.clearActiveSos) {
      SafeHer.api.clearActiveSos();
    }

    if (SafeHer.home && SafeHer.home.setSOSActive) {
      SafeHer.home.setSOSActive(false);
    }

    renderResponders([]);
    renderContactsResponding([]);

    setState('idle');

    if (alertIdForFeedback && respondersForFeedback.length > 0) {
      startFeedbackQueue(alertIdForFeedback, respondersForFeedback);
    } else {
      SafeHer.toast('SOS ended');
      SafeHer.router.go('home', true);
    }
  }

  // ─── Emergency Mode ───────────────────────────────────────
  function startEmergencyMode() {
    setState('emergency');
    modeEnteredTimestamp = Date.now();
    triggerActiveAlert('emergency');
  }

  function renderEmergencyMode() {
    SafeHer.router.go('emergency-mode');
    updateGmapsLink(currentLat, currentLng, 'em-gmaps-link');
    renderNotifiedContacts('em-notified-list');
    startSiren();
    startVibration();
  }

  function startSiren() {
    try {
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      audioCtx = new AudioContext();

      sirenOsc = audioCtx.createOscillator();
      sirenGain = audioCtx.createGain();

      sirenOsc.type = 'sawtooth';
      sirenGain.gain.setValueAtTime(0.5, audioCtx.currentTime);

      sirenOsc.connect(sirenGain);
      sirenGain.connect(audioCtx.destination);
      sirenOsc.start();

      // Oscillate frequency between 700Hz and 1200Hz
      var high = true;
      sirenTimer = setInterval(function() {
        if (!audioCtx || !sirenOsc) return;
        var now = audioCtx.currentTime;
        var targetFreq = high ? 1200 : 700;
        sirenOsc.frequency.exponentialRampToValueAtTime(targetFreq, now + 0.35);
        high = !high;
      }, 400);
    } catch(e) {}
  }

  function stopSiren() {
    clearInterval(sirenTimer);
    sirenTimer = null;
    if (sirenOsc) {
      try { sirenOsc.stop(); sirenOsc.disconnect(); } catch(e) {}
      sirenOsc = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch(e) {}
      audioCtx = null;
    }
  }

  function startVibration() {
    if (!('vibrate' in navigator)) return;
    navigator.vibrate([500, 250, 500, 250]);
    clearInterval(vibeTimer);
    vibeTimer = setInterval(function() {
      navigator.vibrate([500, 250, 500, 250]);
    }, 1500);
  }

  function stopVibration() {
    clearInterval(vibeTimer);
    vibeTimer = null;
    if ('vibrate' in navigator) navigator.vibrate(0);
  }

  // ─── Stop Alarm with PIN (Emergency Mode) ──────────────────
  function requestStopAlarm() {
    SafeHer.askPin(function(enteredPin) {
      stopSiren();
      stopVibration();
      finishEndingAlert(enteredPin || '1234');
    });
  }

  // ─── Leaflet Map Setup & Update ───────────────────────────
  function updateMap(lat, lng) {
    var mapEl = document.getElementById('sos-map');
    if (!mapEl || typeof L === 'undefined') return;

    if (!mapInstance) {
      mapInstance = L.map('sos-map', {
        center: [lat, lng],
        zoom: 15,
        zoomControl: false,
        attributionControl: false,
        maxZoom: 18
      });

      L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=en&gl=in&x={x}&y={y}&z={z}', {
        maxZoom: 18,
        maxNativeZoom: 18,
        errorTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        subdomains: ['0', '1', '2', '3']
      }).addTo(mapInstance);

      markerInstance = L.marker([lat, lng]).addTo(mapInstance);
    } else {
      mapInstance.setView([lat, lng], 15);
      if (markerInstance) {
        markerInstance.setLatLng([lat, lng]);
      } else {
        markerInstance = L.marker([lat, lng]).addTo(mapInstance);
      }
    }

    if (mapInstance) {
      mapInstance.invalidateSize();
      setTimeout(function() {
        if (mapInstance) mapInstance.invalidateSize();
      }, 300);
    }
  }

  function updateGmapsLink(lat, lng, elementId) {
    var id = elementId || 'sos-gmaps-link';
    var link = document.getElementById(id);
    if (link) {
      link.href = 'https://www.google.com/maps?q=' + lat + ',' + lng;
    }
  }

  function renderNotifiedContacts(containerId) {
    var listEl = document.getElementById(containerId || 'sos-notified-list');
    if (!listEl) return;

    var contacts = SafeHer.api.getContacts();
    if (!contacts || contacts.length === 0) {
      listEl.innerHTML = '<p class="prototype-note" style="text-align:left;">No emergency contacts added yet.</p>';
      return;
    }

    var message = buildAlertMessage();
    var active = (SafeHer.api && SafeHer.api.getActiveSos) ? SafeHer.api.getActiveSos() : null;
    var base = (window.SafeHerConfig && window.SafeHerConfig.API_BASE) || window.location.origin;
    var token = (active && active.shareToken) ? active.shareToken : '';
    var trackUrl = base.replace(/\/+$/, '') + '/track.html' + (token ? ('?t=' + token) : '');
    var alertId = (active && active.id) ? active.id : (active && active.alertId ? active.alertId : currentAlertId);

    if (SafeHer.deliveryTracker && SafeHer.deliveryTracker.mount) {
      SafeHer.deliveryTracker.mount({
        containerId: containerId || 'sos-notified-list',
        contacts: contacts,
        isEscortOrTimer: false,
        isOffline: !navigator.onLine,
        trackingUrl: trackUrl,
        messageText: message,
        eventKeyPrefix: alertId ? ('alert:' + alertId + ':') : 'alert:',
        entityId: alertId
      });
    }
  }

  function resendAllServer() {
    var user = SafeHer.api.getUser() || {};
    SafeHer.toast('Re-dispatching alerts via backend server...');
    var base = (window.SafeHerConfig && window.SafeHerConfig.API_BASE) || 'http://localhost:5000';
    fetch(base.replace(/\/+$/, '') + '/api/alerts/quick?user_id=' + (user.id || 10000), { method: 'POST' })
      .then(function(res) { return res.json(); })
      .then(function(json) {
        if (json.ok) {
          SafeHer.toast('✓ Email & WhatsApp re-sent automatically via server!');
        } else {
          SafeHer.toast('Server: ' + (json.error || 'Failed'));
        }
      })
      .catch(function(err) {
        SafeHer.toast('Server unreachable: ' + err.message);
      });
  }

  function copyAlertLink() {
    var active = (SafeHer.api && SafeHer.api.getActiveSos) ? SafeHer.api.getActiveSos() : null;
    var base = (window.SafeHerConfig && window.SafeHerConfig.API_BASE) || window.location.origin;
    var token = (active && active.shareToken) ? active.shareToken : '';
    var url = base.replace(/\/+$/, '') + '/track.html' + (token ? ('?t=' + token) : '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() {
        SafeHer.toast('Live tracking link copied to clipboard!');
      }).catch(function() {
        window.prompt('Copy tracking link:', url);
      });
    } else {
      window.prompt('Copy tracking link:', url);
    }
  }

  function shareToAll() {
    copyAlertLink();
  }

  function copyAlertMessageFallback(message) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(message).then(function() {
        SafeHer.toast('Alert copied to clipboard');
      }).catch(function() {
        SafeHer.toast('Could not copy alert');
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = message;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        SafeHer.toast('Alert copied to clipboard');
      } catch (e) {
        SafeHer.toast('Could not copy alert');
      }
      document.body.removeChild(ta);
    }
  }

  // ─── Offline SOS Fallback Actions ─────────────────────────
  function showOfflineFallback() {
    var card1 = document.getElementById('sos-offline-fallback-card');
    if (card1) card1.style.display = 'block';
    var card2 = document.getElementById('em-offline-fallback-card');
    if (card2) card2.style.display = 'block';
    if (SafeHer.toast) {
      SafeHer.toast('SOS server unreachable. Use offline options below.');
    }
  }

  function hideOfflineFallback() {
    var card1 = document.getElementById('sos-offline-fallback-card');
    if (card1) card1.style.display = 'none';
    var card2 = document.getElementById('em-offline-fallback-card');
    if (card2) card2.style.display = 'none';
  }

  function sendOfflineSmsAll() {
    var contacts = (SafeHer.api && SafeHer.api.getContacts ? SafeHer.api.getContacts() : []) || [];
    var phones = [];
    for (var i = 0; i < contacts.length; i++) {
      var p = (contacts[i].phone || '').replace(/\D/g, '');
      if (p) phones.push(p);
    }
    var message = buildAlertMessage();
    var smsUrl = 'sms:' + (phones.length ? phones.join(',') : '') + '?body=' + encodeURIComponent(message);
    window.location.href = smsUrl;
  }

  function sendOfflineWhatsAppAll() {
    var contacts = (SafeHer.api && SafeHer.api.getContacts ? SafeHer.api.getContacts() : []) || [];
    var targetPhone = '';
    if (contacts.length === 1 && contacts[0].phone) {
      var p = (contacts[0].phone || '').replace(/\D/g, '');
      if (p.length === 10) targetPhone = '91' + p;
      else if (p.length > 10) targetPhone = p;
    }
    var message = buildAlertMessage();
    var waUrl = targetPhone
      ? ('https://wa.me/' + targetPhone + '?text=' + encodeURIComponent(message))
      : ('https://api.whatsapp.com/send?text=' + encodeURIComponent(message));
    window.open(waUrl, '_blank');
  }

  function sendDirectWhatsApp(phone) {
    var clean = (phone || '').replace(/\D/g, '');
    if (clean.length === 10) clean = '91' + clean;
    var message = buildAlertMessage();
    var url = clean ? ('https://wa.me/' + clean + '?text=' + encodeURIComponent(message)) : ('https://api.whatsapp.com/send?text=' + encodeURIComponent(message));
    window.open(url, '_blank');
  }

  function sendDirectSms(phone) {
    var clean = (phone || '').replace(/\D/g, '');
    var message = buildAlertMessage();
    window.location.href = 'sms:' + clean + '?body=' + encodeURIComponent(message);
  }

  // ─── Live Location Tracking (every 10s) ───────────────────
  function startTrackingInterval() {
    clearInterval(liveTrackingInterval);
    liveTrackingInterval = setInterval(function() {
      if (!navigator.geolocation) return;

      navigator.geolocation.getCurrentPosition(
        function(pos) {
          currentLat = pos.coords.latitude;
          currentLng = pos.coords.longitude;
          if (window.SafeHer && SafeHer.setLastLocation) {
            SafeHer.setLastLocation(currentLat, currentLng);
          }

          if (currentAlertId) {
            SafeHer.api.updateAlert(currentAlertId, {
              lat: currentLat,
              lng: currentLng
            });
            if (SafeHer.api.getActiveSos) {
              var activeSos = SafeHer.api.getActiveSos();
              if (activeSos && activeSos.id === currentAlertId) {
                activeSos.lat = currentLat;
                activeSos.lng = currentLng;
                SafeHer.api.setActiveSos(activeSos);
              }
            }
          }

          if (currentMode === 'normal') {
            updateMap(currentLat, currentLng);
            updateGmapsLink(currentLat, currentLng);
            renderNotifiedContacts('sos-notified-list');
          } else if (currentMode === 'emergency') {
            updateGmapsLink(currentLat, currentLng, 'em-gmaps-link');
          }
        },
        function() {},
        { timeout: 5000 }
      );
    }, 10000);
  }

  function stopTrackingInterval() {
    clearInterval(liveTrackingInterval);
    liveTrackingInterval = null;
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(function() {});
      wakeLock = null;
    }
  }

  // ─── End Alert ("I'm Safe" & "Stop Alarm") protected by PIN ─
  function requestEndAlert() {
    SafeHer.askPin(function(enteredPin, pinResult) {
      if (pinResult === 'duress') {
        SafeHer.router.go('home');
        return;
      }
      finishEndingAlert(enteredPin);
    });
  }

  function finishEndingAlert(enteredPin) {
    setState('idle');
    isAlertEnded = true;
    lastEndedPin = enteredPin || '1234';
    hideOfflineFallback();
    if (silentPendingTimer) {
      clearTimeout(silentPendingTimer);
      silentPendingTimer = null;
    }
    stopTrackingInterval();
    stopDurationCounter();
    stopVolunteerStatusPolling();
    stopSiren();
    stopVibration();
    releaseWakeLock();
    if (SafeHer.vault && SafeHer.vault.endSession) {
      SafeHer.vault.endSession();
    }

    var endTimeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var alertIdForFeedback = currentAlertId;
    var respondersForFeedback = (currentAlertResponders && currentAlertResponders.length > 0) ? currentAlertResponders.slice() : [];

    if (currentAlertId) {
      if (SafeHer.api && SafeHer.api.endAlert) {
        SafeHer.api.endAlert(currentAlertId, enteredPin || '1234');
      } else {
        SafeHer.api.updateAlert(currentAlertId, {
          status: 'resolved',
          endTime: endTimeStr
        });
      }
      currentAlertId = null;
    }

    if (SafeHer.deliveryTracker) {
      SafeHer.deliveryTracker.stopAll();
    }

    if (SafeHer.api && SafeHer.api.clearActiveSos) {
      SafeHer.api.clearActiveSos();
    }

    var volunteerSubEl = document.getElementById('sos-status-sub');
    if (volunteerSubEl) volunteerSubEl.textContent = 'Waiting for volunteers...';
    renderResponders([]);
    renderContactsResponding([]);

    if (SafeHer.home && SafeHer.home.setSOSActive) {
      SafeHer.home.setSOSActive(false);
    }

    if (alertIdForFeedback && respondersForFeedback.length > 0) {
      startFeedbackQueue(alertIdForFeedback, respondersForFeedback);
    } else {
      SafeHer.toast('SOS ended');
      SafeHer.router.go('home', true);
    }
  }

  // ─── Volunteer Status Polling (every 5s) ───────────────────
  function startVolunteerStatusPolling() {
    stopVolunteerStatusPolling();
    pollVolunteerStatus();
    volunteerStatusInterval = setInterval(pollVolunteerStatus, 3000);
  }

  function stopVolunteerStatusPolling() {
    if (volunteerStatusInterval) {
      clearInterval(volunteerStatusInterval);
      volunteerStatusInterval = null;
    }
    prevContactResponseCount = 0;
  }

  function pollVolunteerStatus() {
    var alertId = currentAlertId;
    if (!alertId && SafeHer.api && SafeHer.api.getActiveSos) {
      var act = SafeHer.api.getActiveSos();
      if (act && act.id) alertId = act.id;
    }
    if (!alertId) return;

    if (SafeHer.api && SafeHer.api.getAlertVolunteerStatus) {
      SafeHer.api.getAlertVolunteerStatus(alertId, function(err, data) {
        if (err || !data) return;
        var coming = data.volunteers_coming !== undefined ? data.volunteers_coming : 0;
        var contactResponses = data.contact_responses || [];
        var responders = data.responders || [];
        currentAlertResponders = responders;
        var act = SafeHer.api.getActiveSos ? SafeHer.api.getActiveSos() : null;
        if (act) {
          act.volunteersEnRoute = coming;
          act.volunteerStatus = coming > 0 ? (coming + ' volunteer' + (coming > 1 ? 's are' : ' is') + ' on the way') : 'Waiting for volunteers...';
          act.contactResponses = contactResponses;
          act.responders = responders;
          SafeHer.api.setActiveSos(act);
        }
        updateVolunteerStatusDisplay();
        renderResponders(responders);
        renderContactsResponding(contactResponses);
        if (contactResponses.length > prevContactResponseCount) {
          if (contactResponses.length > 0) {
            var latest = contactResponses[0];
            var lMap = {
              'on_my_way': "I’m on my way",
              'called': "I called you",
              'alerted_police': "I alerted police",
              'cannot_reach': "I can’t reach you",
              'safe_with_me': "She is safe with me"
            };
            var lText = lMap[latest.status] || latest.status;
            if (SafeHer.toast) {
              SafeHer.toast('🔔 ' + (latest.name || 'Emergency contact') + ': ' + lText);
            }
            if (navigator.vibrate) {
              try { navigator.vibrate([200, 100, 200]); } catch(e) {}
            }
          }
          prevContactResponseCount = contactResponses.length;
        }
      });
    }
  }

  function updateVolunteerStatusDisplay() {
    if (!SafeHer.api || !SafeHer.api.getActiveSos) return;
    var activeSos = SafeHer.api.getActiveSos();
    var subEl = document.getElementById('sos-status-sub');
    var emSubEl = document.getElementById('em-status-sub');
    if (!subEl && !emSubEl) return;

    var n = (activeSos && activeSos.volunteersEnRoute) ? activeSos.volunteersEnRoute : 0;
    var box = subEl ? subEl.parentElement : null;
    var icon = box ? box.querySelector('.material-symbols-rounded') : null;

    if (n > 0) {
      var msg = n + ' volunteer' + (n > 1 ? 's are' : ' is') + ' on the way to help!';
      if (subEl) {
        subEl.textContent = msg;
        subEl.style.color = '#15803D';
      }
      if (emSubEl) {
        emSubEl.textContent = msg;
        emSubEl.style.color = '#15803D';
      }
      if (icon) {
        icon.textContent = 'directions_run';
        icon.style.color = '#15803D';
      }
    } else {
      var startTime = (activeSos && (activeSos.createdAt || activeSos.timestamp)) ? new Date(activeSos.createdAt || activeSos.timestamp).getTime() : Date.now();
      var elapsedSec = Math.floor((Date.now() - startTime) / 1000);

      if (elapsedSec >= 20) {
        var warnMsg = 'No community volunteers responding nearby. Emergency contacts & Police (112) have been alerted.';
        if (subEl) {
          subEl.textContent = warnMsg;
          subEl.style.color = '#DC2626';
        }
        if (emSubEl) {
          emSubEl.textContent = warnMsg;
          emSubEl.style.color = '#DC2626';
        }
        if (icon) {
          icon.textContent = 'warning';
          icon.style.color = '#DC2626';
        }
        if (!noVolunteerToastShown) {
          noVolunteerToastShown = true;
          if (SafeHer.toast) {
            SafeHer.toast('⚠️ No volunteers responding nearby. Please call 112 immediately.');
          }
        }
      } else {
        var waitMsg = 'Alerting nearby community volunteers & emergency contacts...';
        if (subEl) {
          subEl.textContent = waitMsg;
          subEl.style.color = '';
        }
        if (emSubEl) {
          emSubEl.textContent = waitMsg;
          emSubEl.style.color = '';
        }
        if (icon) {
          icon.textContent = 'hourglass_top';
          icon.style.color = '';
        }
      }
    }
  }

  // ─── Contacts Responding Live List ────────────────────────────
  function renderContactsResponding(responses) {
    var listEl = document.getElementById('sos-contacts-responding-list');
    var countEl = document.getElementById('sos-contacts-responding-count');
    if (!listEl) return;

    if (!responses || !Array.isArray(responses) || responses.length === 0) {
      listEl.innerHTML = '<p style="font-size: 12px; color: var(--text-gray); margin: 0; text-align: center; padding: 4px 0;">Waiting for contact responses...</p>';
      if (countEl) countEl.textContent = '0 updates';
      return;
    }

    if (countEl) {
      countEl.textContent = responses.length + (responses.length === 1 ? ' update' : ' updates');
    }

    var labelMap = {
      'on_my_way': "I’m on my way",
      'called': "I called her",
      'alerted_police': "I alerted police",
      'cannot_reach': "I can’t reach her"
    };
    var iconMap = {
      'on_my_way': 'directions_run',
      'called': 'phone_in_talk',
      'alerted_police': 'local_police',
      'cannot_reach': 'phone_missed'
    };

    var html = responses.map(function(item) {
      var name = (item.name || 'Contact').trim();
      var statusKey = item.status || '';
      var label = labelMap[statusKey] || statusKey || 'Responded';
      var icon = iconMap[statusKey] || 'check_circle';
      var timeStr = item.time || '';

      if (timeStr) {
        try {
          var d = new Date(timeStr.replace(' ', 'T'));
          if (!isNaN(d.getTime())) {
            timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
        } catch(e) {}
      }

      var cardBg = '#FCEFF3';
      var cardBorder = '#EAD3DA';
      var statusColor = '#A80F3C';
      if (statusKey === 'on_my_way') {
        cardBg = '#E8F5E9';
        cardBorder = '#C8E6C9';
        statusColor = '#1B5E20';
      } else if (statusKey === 'alerted_police') {
        cardBg = '#E3F2FD';
        cardBorder = '#BBDEFB';
        statusColor = '#0D47A1';
      } else if (statusKey === 'cannot_reach') {
        cardBg = '#FFF3E0';
        cardBorder = '#FFE0B2';
        statusColor = '#E65100';
      }

      return (
        '<div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: ' + cardBg + '; border: 1px solid ' + cardBorder + '; border-radius: 8px;">' +
          '<div>' +
            '<div style="font-size: 13px; font-weight: 700; color: var(--text-dark, #222);">' + escapeHtml(name) + '</div>' +
            '<div style="font-size: 12px; font-weight: 700; color: ' + statusColor + '; display: flex; align-items: center; gap: 4px; margin-top: 2px;">' +
              '<span class="material-symbols-rounded" style="font-size: 16px;">' + icon + '</span>' +
              '<span>' + escapeHtml(label) + '</span>' +
            '</div>' +
          '</div>' +
          '<span style="font-size: 11px; color: var(--text-gray, #777); font-weight: 600;">' + escapeHtml(timeStr) + '</span>' +
        '</div>'
      );
    }).join('');

    listEl.innerHTML = html;
  }

  function init() {
    // 1. If active silent SOS was stored, restore it immediately
    try {
      if (localStorage.getItem('safeher_silent_sos_active') === 'true') {
        restoreSilentMode();
      }
    } catch(e) {}

    SafeHer.router.onShow('sos-active', function() {
      var activeSos = SafeHer.api && SafeHer.api.getActiveSos ? SafeHer.api.getActiveSos() : null;
      if (activeSos && activeSos.timestamp) {
        if (!durationTimer || !alertStartTime) {
          startDurationCounter(activeSos.timestamp);
        }
      } else if (!durationTimer && !alertStartTime) {
        startDurationCounter();
      }
      updateDurationDisplay();
      updateVolunteerStatusDisplay();
      if (activeSos && activeSos.contactResponses) {
        renderContactsResponding(activeSos.contactResponses);
      }
      startVolunteerStatusPolling();
      if (mapInstance) {
        mapInstance.invalidateSize();
        setTimeout(function() {
          if (mapInstance) mapInstance.invalidateSize();
        }, 300);
      }
    });

    window.addEventListener('storage', function(e) {
      if (e.key === 'safeher_active_sos') {
        updateVolunteerStatusDisplay();
      }
    });

    var sosBtn = document.getElementById('sos-btn');
    if (sosBtn) {
      sosBtn.style.touchAction = 'manipulation';
      sosBtn.onpointerdown = onSosButtonPointerDown;
      sosBtn.onclick = function(e) { e.preventDefault(); };
    }

    var overlay = document.getElementById('sos-countdown-overlay');
    if (overlay) {
      overlay.style.touchAction = 'manipulation';
      overlay.onpointerdown = onOverlayPointerDown;
    }
  }

  // Ensure fullscreenchange, visibilitychange, and resize never hide silent overlay
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      if (currentState === 'silent') {
        showSilentOverlay();
        requestWakeLock();
      }
    }
  });

  document.addEventListener('fullscreenchange', function() {
    if (currentState === 'silent') {
      showSilentOverlay();
    }
  });

  window.addEventListener('resize', function() {
    if (currentState === 'silent') {
      showSilentOverlay();
    }
  });

  // ─── Graduated Alerts: Uneasy Alert & Direct Emergency ───
  var activeUneasyAlert = null;
  var uneasyTenMinTimer = null;
  var uneasyAutoEscalateInterval = null;
  var uneasyAutoEscalateRemaining = 60;

  function triggerDirectEmergency() {
    startEmergencyMode();
  }

  function getActiveUneasyAlert() {
    if (activeUneasyAlert) return activeUneasyAlert;
    try {
      var saved = localStorage.getItem('safeher_active_uneasy');
      if (saved) activeUneasyAlert = JSON.parse(saved);
    } catch(e) {}
    return activeUneasyAlert;
  }

  function saveActiveUneasyAlert(alertObj) {
    activeUneasyAlert = alertObj;
    try {
      if (alertObj) {
        localStorage.setItem('safeher_active_uneasy', JSON.stringify(alertObj));
      } else {
        localStorage.removeItem('safeher_active_uneasy');
      }
    } catch(e) {}
    updateUneasyBanner();
  }

  function openUneasySheet() {
    var modal = document.getElementById('uneasy-sheet-modal');
    var formView = document.getElementById('uneasy-form-view');
    var sentView = document.getElementById('uneasy-sent-view');
    var noteInput = document.getElementById('uneasy-note');
    if (!modal) return;
    if (formView) formView.style.display = 'block';
    if (sentView) sentView.style.display = 'none';
    if (noteInput) noteInput.value = '';
    modal.style.display = 'flex';
  }

  function closeUneasySheet() {
    var modal = document.getElementById('uneasy-sheet-modal');
    if (modal) modal.style.display = 'none';
  }

  function sendUneasyCheckin() {
    var noteInput = document.getElementById('uneasy-note');
    var note = noteInput ? noteInput.value.trim() : '';

    var defaultLat = 12.9716;
    var defaultLng = 77.5946;

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function(pos) {
        doSend(pos.coords.latitude, pos.coords.longitude);
      }, function() {
        doSend(defaultLat, defaultLng);
      }, { timeout: 5000, enableHighAccuracy: true });
    } else {
      doSend(defaultLat, defaultLng);
    }

    function doSend(lat, lng) {
      var payload = {
        mode: 'uneasy',
        lat: lat,
        lng: lng,
        note: note
      };

      SafeHer.api.triggerAlert(payload, function(err, alertData) {
        var alertId = (alertData && alertData.id) ? alertData.id : Date.now();
        var token = (alertData && alertData.shareToken) ? alertData.shareToken : ((alertData && alertData.share_token) || ('track_' + alertId));

        var uneasyInfo = {
          id: alertId,
          shareToken: token,
          lat: lat,
          lng: lng,
          note: note,
          startTime: Date.now()
        };
        saveActiveUneasyAlert(uneasyInfo);

        // Update sent view in sheet
        var formView = document.getElementById('uneasy-form-view');
        var sentView = document.getElementById('uneasy-sent-view');
        var previewEl = document.getElementById('uneasy-track-link-preview');
        var trackingUrl = (window.location.origin + window.location.pathname).replace(/index\.html$/, '') + 'track.html?t=' + token;

        if (formView) formView.style.display = 'none';
        if (sentView) sentView.style.display = 'block';
        if (previewEl) {
          previewEl.innerHTML = '<div style="margin-bottom:6px;font-weight:600;color:var(--text-dark);">Live Tracking Link:</div>' +
            '<a href="' + trackingUrl + '" target="_blank" style="color:var(--crimson);word-break:break-all;font-size:12px;font-weight:600;display:block;margin-bottom:8px;">' + trackingUrl + '</a>' +
            '<button type="button" class="btn btn-secondary" onclick="navigator.clipboard.writeText(\'' + trackingUrl + '\');SafeHer.toast(\'Link copied!\');" style="font-size:11px;padding:3px 10px;min-height:28px;">Copy Link</button>';
        }

        var contacts = SafeHer.api.getContacts() || [];
        if (SafeHer.deliveryTracker && SafeHer.deliveryTracker.mount) {
          SafeHer.deliveryTracker.mount({
            containerId: 'uneasy-delivery-status',
            contacts: contacts,
            isEscortOrTimer: false,
            isOffline: !navigator.onLine,
            trackingUrl: trackingUrl,
            messageText: 'SafeHer Uneasy Check-in: ' + trackingUrl,
            eventKeyPrefix: 'alert:' + alertId + ':',
            entityId: alertId
          });
        }

        SafeHer.toast('Check-in sent');
        startUneasyMonitoring();
      });
    }
  }

  function updateUneasyBanner() {
    var banner = document.getElementById('uneasy-active-home-banner');
    if (!banner) return;
    var uneasy = getActiveUneasyAlert();
    if (uneasy) {
      banner.style.display = 'block';
      var elapsedEl = document.getElementById('uneasy-banner-elapsed');
      if (elapsedEl) {
        var elapsedMins = Math.floor((Date.now() - uneasy.startTime) / 60000);
        elapsedEl.textContent = 'Started ' + (elapsedMins > 0 ? elapsedMins + 'm ago' : 'just now') + ' · Close contacts notified';
      }
    } else {
      banner.style.display = 'none';
    }
  }

  function startUneasyMonitoring() {
    if (uneasyTenMinTimer) {
      clearTimeout(uneasyTenMinTimer);
      uneasyTenMinTimer = null;
    }
    var uneasy = getActiveUneasyAlert();
    if (!uneasy) return;

    var elapsedMs = Date.now() - uneasy.startTime;
    var tenMinsMs = 10 * 60 * 1000;
    var remainingMs = tenMinsMs - elapsedMs;

    if (remainingMs <= 0) {
      showUneasyAreYouOkModal();
    } else {
      uneasyTenMinTimer = setTimeout(function() {
        showUneasyAreYouOkModal();
      }, remainingMs);
    }
  }

  function showUneasyAreYouOkModal() {
    var uneasy = getActiveUneasyAlert();
    if (!uneasy) return;

    var modal = document.getElementById('uneasy-are-you-ok-modal');
    if (modal) modal.style.display = 'flex';

    if (uneasyAutoEscalateInterval) {
      clearInterval(uneasyAutoEscalateInterval);
      uneasyAutoEscalateInterval = null;
    }

    uneasyAutoEscalateRemaining = 60;
    var secEl = document.getElementById('uneasy-countdown-seconds');
    if (secEl) secEl.textContent = uneasyAutoEscalateRemaining;

    uneasyAutoEscalateInterval = setInterval(function() {
      uneasyAutoEscalateRemaining--;
      if (secEl) secEl.textContent = uneasyAutoEscalateRemaining;
      if (uneasyAutoEscalateRemaining <= 0) {
        clearInterval(uneasyAutoEscalateInterval);
        uneasyAutoEscalateInterval = null;
        if (modal) modal.style.display = 'none';
        escalateUneasyAlert('normal');
      }
    }, 1000);
  }

  function resolveUneasyAlert() {
    if (uneasyTenMinTimer) {
      clearTimeout(uneasyTenMinTimer);
      uneasyTenMinTimer = null;
    }
    if (uneasyAutoEscalateInterval) {
      clearInterval(uneasyAutoEscalateInterval);
      uneasyAutoEscalateInterval = null;
    }

    var okModal = document.getElementById('uneasy-are-you-ok-modal');
    if (okModal) okModal.style.display = 'none';
    closeUneasySheet();

    var uneasy = getActiveUneasyAlert();
    if (uneasy && uneasy.id) {
      SafeHer.api.resolveAlertOk(uneasy.id);
    }
    saveActiveUneasyAlert(null);
    SafeHer.toast("Glad you're safe! Check-in ended.");
  }

  function escalateUneasyAlert(toMode) {
    toMode = toMode || 'normal';

    if (uneasyTenMinTimer) {
      clearTimeout(uneasyTenMinTimer);
      uneasyTenMinTimer = null;
    }
    if (uneasyAutoEscalateInterval) {
      clearInterval(uneasyAutoEscalateInterval);
      uneasyAutoEscalateInterval = null;
    }

    var okModal = document.getElementById('uneasy-are-you-ok-modal');
    if (okModal) okModal.style.display = 'none';
    closeUneasySheet();

    var uneasy = getActiveUneasyAlert();
    if (uneasy && uneasy.id) {
      SafeHer.api.escalateAlert(uneasy.id, toMode);
    }
    saveActiveUneasyAlert(null);

    SafeHer.toast('Alert escalated to ' + toMode + ' SOS');

    if (toMode === 'emergency') {
      startEmergencyMode();
    } else {
      triggerActiveAlert('normal');
    }
  }

  // ─── Responders List on Victim's Screen ───────────────────────
  function renderResponders(responders) {
    var listEl = document.getElementById('sos-responders-list');
    var countEl = document.getElementById('sos-responders-count');
    var emListEl = document.getElementById('em-responders-list');
    var emCountEl = document.getElementById('em-responders-count');
    if (!listEl && !emListEl) return;

    if (!responders || !Array.isArray(responders) || responders.length === 0) {
      var act = (SafeHer.api && SafeHer.api.getActiveSos) ? SafeHer.api.getActiveSos() : null;
      var startTime = (act && (act.createdAt || act.timestamp)) ? new Date(act.createdAt || act.timestamp).getTime() : Date.now();
      var elapsedSec = Math.floor((Date.now() - startTime) / 1000);

      var emptyHtml = '';
      if (elapsedSec >= 20) {
        emptyHtml = '<div style="background: #FEF2F2; border: 1.5px solid #FCA5A5; border-radius: 8px; padding: 10px 12px; text-align: center;">' +
          '<span class="material-symbols-rounded" style="color: #DC2626; font-size: 24px; display: block; margin-bottom: 2px;">warning</span>' +
          '<strong style="font-size: 13px; color: #991B1B; display: block;">No community volunteers coming nearby</strong>' +
          '<span style="font-size: 11px; color: #7F1D1D; display: block; margin-top: 2px;">Emergency contacts have your location. Please call 112 directly if in danger.</span>' +
        '</div>';
      } else {
        emptyHtml = '<p style="font-size: 12px; color: var(--text-gray); margin: 0; text-align: center; padding: 8px 0;">Waiting for volunteers to respond...</p>';
      }

      if (listEl) listEl.innerHTML = emptyHtml;
      if (emListEl) emListEl.innerHTML = emptyHtml;
      if (countEl) countEl.textContent = '0 coming';
      if (emCountEl) emCountEl.textContent = '0 coming';
      return;
    }

    if (countEl) countEl.textContent = responders.length + ' coming';
    if (emCountEl) emCountEl.textContent = responders.length + ' coming';

    var html = responders.map(function(r) {
      var name = escapeHtml(r.first_name || 'Volunteer');
      var badgeText = r.badge === 'Trusted' ? 'Verified volunteer, Trusted' : (r.completed_responses > 0 ? 'Verified volunteer' : 'Verified volunteer, New');
      var completedCount = r.completed_responses || 0;
      var code = escapeHtml(r.verification_code || '----');
      var volId = r.volunteer_id;

      return '<div class="responder-card" style="display: flex; align-items: center; justify-content: space-between; background: #FAFAFA; border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 12px; gap: 10px;">' +
        '<div style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1;">' +
          '<div style="position: relative; width: 44px; height: 44px; border-radius: 50%; overflow: hidden; background: var(--crimson-bg); display: flex; align-items: center; justify-content: center; border: 1px solid var(--border-color); flex-shrink: 0;">' +
            '<img id="responder-selfie-' + volId + '" src="" alt="' + name + '" style="width: 100%; height: 100%; object-fit: cover; display: none;" />' +
            '<span id="responder-placeholder-' + volId + '" class="material-symbols-rounded" style="color: var(--crimson); font-size: 24px;">person</span>' +
          '</div>' +
          '<div style="min-width: 0; flex: 1;">' +
            '<div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">' +
              '<strong style="font-size: 14px; color: var(--text-dark);">' + name + '</strong>' +
              '<span style="font-size: 10px; font-weight: 700; background: #FCEFF3; color: var(--crimson); border: 1px solid var(--crimson); border-radius: 10px; padding: 1px 6px; white-space: nowrap;">' +
                escapeHtml(badgeText) +
              '</span>' +
            '</div>' +
            '<p style="font-size: 11px; color: var(--text-gray); margin: 2px 0 0;">' +
              completedCount + ' completed response' + (completedCount === 1 ? '' : 's') +
            '</p>' +
            '<p style="font-size: 11px; font-weight: 600; color: #C62828; margin: 2px 0 0;">' +
              'Ask them for the code' +
            '</p>' +
          '</div>' +
        '</div>' +
        '<div style="text-align: right; background: #FFF; border: 1px dashed var(--crimson); border-radius: 6px; padding: 6px 10px; flex-shrink: 0;">' +
          '<span style="font-size: 10px; font-weight: 600; color: var(--text-gray); display: block; text-transform: uppercase;">Code</span>' +
          '<strong style="font-size: 18px; letter-spacing: 2px; color: var(--crimson); font-family: monospace;">' + code + '</strong>' +
        '</div>' +
      '</div>';
    }).join('');

    if (listEl) listEl.innerHTML = html;
    if (emListEl) emListEl.innerHTML = html;

    // Asynchronously load authenticated selfies for responders
    responders.forEach(function(r) {
      if (r.selfie_url && SafeHer.api && SafeHer.api.fetchResponderSelfieBlobUrl) {
        SafeHer.api.fetchResponderSelfieBlobUrl(r.selfie_url, function(err, blobUrl) {
          if (!err && blobUrl) {
            var imgEl = document.getElementById('responder-selfie-' + r.volunteer_id);
            var phEl = document.getElementById('responder-placeholder-' + r.volunteer_id);
            if (imgEl) {
              imgEl.src = blobUrl;
              imgEl.style.display = 'block';
            }
            if (phEl) phEl.style.display = 'none';
          }
        });
      }
    });
  }

  // ─── Post-Alert Volunteer Feedback Sheet ──────────────────────
  function startFeedbackQueue(alertId, responders) {
    feedbackAlertId = alertId;
    feedbackQueue = responders.slice();
    showNextFeedbackVolunteer();
  }

  function showNextFeedbackVolunteer() {
    if (!feedbackQueue || feedbackQueue.length === 0) {
      var modal = document.getElementById('sos-feedback-modal');
      if (modal) modal.style.display = 'none';
      currentFeedbackVol = null;
      SafeHer.toast('SOS ended');
      SafeHer.router.go('home');
      return;
    }

    currentFeedbackVol = feedbackQueue[0];
    var modal = document.getElementById('sos-feedback-modal');
    if (!modal) {
      SafeHer.toast('SOS ended');
      SafeHer.router.go('home');
      return;
    }

    var total = currentAlertResponders.length || 1;
    var currentIdx = total - feedbackQueue.length + 1;
    var queueBadge = document.getElementById('sos-feedback-queue-badge');
    if (queueBadge) queueBadge.textContent = currentIdx + ' of ' + total;

    var nameEl = document.getElementById('sos-feedback-vol-name');
    var badgeEl = document.getElementById('sos-feedback-vol-badge');
    var selfieImg = document.getElementById('sos-feedback-vol-selfie');
    var avatarPh = document.getElementById('sos-feedback-vol-avatar-placeholder');

    var firstName = currentFeedbackVol.first_name || 'Volunteer';
    if (nameEl) nameEl.textContent = firstName;

    var badgeText = currentFeedbackVol.badge === 'Trusted' ? 'Verified volunteer, Trusted' : (currentFeedbackVol.completed_responses > 0 ? 'Verified volunteer' : 'Verified volunteer, New');
    if (badgeEl) badgeEl.textContent = badgeText;

    if (currentFeedbackVol.selfie_url && SafeHer.api && SafeHer.api.fetchResponderSelfieBlobUrl) {
      SafeHer.api.fetchResponderSelfieBlobUrl(currentFeedbackVol.selfie_url, function(err, blobUrl) {
        if (!err && blobUrl && selfieImg) {
          selfieImg.src = blobUrl;
          selfieImg.style.display = 'block';
          if (avatarPh) avatarPh.style.display = 'none';
        } else {
          if (selfieImg) selfieImg.style.display = 'none';
          if (avatarPh) {
            avatarPh.style.display = 'flex';
            avatarPh.textContent = firstName.charAt(0).toUpperCase();
          }
        }
      });
    } else {
      if (selfieImg) selfieImg.style.display = 'none';
      if (avatarPh) {
        avatarPh.style.display = 'flex';
        avatarPh.textContent = firstName.charAt(0).toUpperCase();
      }
    }

    // Reset radio buttons to Yes
    var helpfulRadios = document.querySelectorAll('input[name="feedback-helpful"]');
    helpfulRadios.forEach(function(r) { r.checked = (r.value === '1'); });

    var respectRadios = document.querySelectorAll('input[name="feedback-respectful"]');
    respectRadios.forEach(function(r) { r.checked = (r.value === '1'); });

    // Reset report problem section
    var reportFields = document.getElementById('sos-feedback-report-fields');
    if (reportFields) reportFields.style.display = 'none';

    var reportRadios = document.querySelectorAll('input[name="feedback-report-type"]');
    reportRadios.forEach(function(r) { r.checked = false; });

    var commentEl = document.getElementById('sos-feedback-comment');
    if (commentEl) commentEl.value = '';

    modal.style.display = 'flex';
  }

  function toggleFeedbackReport() {
    var fields = document.getElementById('sos-feedback-report-fields');
    if (!fields) return;
    if (fields.style.display === 'none' || !fields.style.display) {
      fields.style.display = 'block';
      var firstRadio = document.querySelector('input[name="feedback-report-type"][value="unsafe"]');
      if (firstRadio) firstRadio.checked = true;
    } else {
      fields.style.display = 'none';
      var reportRadios = document.querySelectorAll('input[name="feedback-report-type"]');
      reportRadios.forEach(function(r) { r.checked = false; });
    }
  }

  function skipVolunteerFeedback() {
    if (feedbackQueue && feedbackQueue.length > 0) {
      feedbackQueue.shift();
    }
    showNextFeedbackVolunteer();
  }

  function submitVolunteerFeedback() {
    if (!currentFeedbackVol || !feedbackAlertId) {
      skipVolunteerFeedback();
      return;
    }

    var helpfulRadio = document.querySelector('input[name="feedback-helpful"]:checked');
    var helpful = helpfulRadio ? (helpfulRadio.value === '1') : true;

    var respectRadio = document.querySelector('input[name="feedback-respectful"]:checked');
    var respectful = respectRadio ? (respectRadio.value === '1') : true;

    var reportFields = document.getElementById('sos-feedback-report-fields');
    var reportType = 'none';
    if (reportFields && reportFields.style.display !== 'none') {
      var repRadio = document.querySelector('input[name="feedback-report-type"]:checked');
      if (repRadio) reportType = repRadio.value;
    }

    var commentEl = document.getElementById('sos-feedback-comment');
    var comment = commentEl ? commentEl.value.trim() : '';

    var payload = {
      volunteer_id: currentFeedbackVol.volunteer_id,
      helpful: helpful,
      respectful: respectful,
      report_type: reportType,
      comment: comment
    };

    if (SafeHer.api && SafeHer.api.submitVolunteerFeedback) {
      SafeHer.api.submitVolunteerFeedback(feedbackAlertId, payload, function(err) {
        if (err) {
          SafeHer.toast('Feedback error: ' + err);
        } else {
          if (reportType === 'unsafe' || reportType === 'inappropriate') {
            SafeHer.toast('Report recorded. Volunteer paused pending review.');
          } else {
            SafeHer.toast('Feedback submitted. Thank you.');
          }
        }
        if (feedbackQueue && feedbackQueue.length > 0) {
          feedbackQueue.shift();
        }
        showNextFeedbackVolunteer();
      });
    } else {
      if (feedbackQueue && feedbackQueue.length > 0) {
        feedbackQueue.shift();
      }
      showNextFeedbackVolunteer();
    }
  }

  return {
    init: init,
    toggleFeedbackReport: toggleFeedbackReport,
    skipVolunteerFeedback: skipVolunteerFeedback,
    submitVolunteerFeedback: submitVolunteerFeedback,
    startCountdown: startCountdown,
    cancelCountdown: cancelCountdown,
    startSilentMode: startSilentMode,
    promptExitSilent: promptExitSilent,
    openSilentPinPad: openSilentPinPad,
    showSilentOverlay: showSilentOverlay,
    hideSilentOverlay: hideSilentOverlay,
    restoreSilentMode: restoreSilentMode,
    startEmergencyMode: startEmergencyMode,
    onSilentScreenTap: onSilentPointerDown,
    onSosButtonPointerDown: onSosButtonPointerDown,
    onOverlayPointerDown: onOverlayPointerDown,
    getState: function() { return currentState; },
    isSilentModeActive: function() { return currentState === 'silent' || (currentState === 'pin' && currentMode === 'silent'); },
    requestEndAlert: requestEndAlert,
    requestStopAlarm: requestStopAlarm,
    shareToAll: shareToAll,
    resendAllServer: resendAllServer,
    copyAlertLink: copyAlertLink,
    sendOfflineSmsAll: sendOfflineSmsAll,
    sendOfflineWhatsAppAll: sendOfflineWhatsAppAll,
    sendDirectWhatsApp: sendDirectWhatsApp,
    sendDirectSms: sendDirectSms,
    isAlertActive: function() { return !!currentAlertId; },
    getCurrentAlertId: function() { return currentAlertId; },
    getCurrentMode: function() { return currentMode; }
  };
})();

// Immediate auto-recovery when sos.js executes
try {
  if (localStorage.getItem('safeher_silent_sos_active') === 'true') {
    if (SafeHer.sos && SafeHer.sos.restoreSilentMode) {
      SafeHer.sos.restoreSilentMode();
    }
  }
} catch(e) {}
