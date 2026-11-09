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

  // Tap counter window for overlay
  var tapTimes = [];
  var silentPendingTimer = null;
  var wakeLock = null;

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

  // ─── Mode Detection from Tap Count ─────────────────────────
  // Evaluates taps within a 2-second window
  // 1 tap on SOS button: starts normal countdown
  // 3 taps (SOS tap + 2 taps on overlay within 2s): switches to Silent mode
  // 5 taps (SOS tap + 4 taps on overlay within 2s): switches immediately to Emergency mode
  function registerTap() {
    var now = Date.now();
    tapTimes.push(now);
    tapTimes = tapTimes.filter(function(t) { return now - t <= 2000; });

    var count = tapTimes.length;
    if (count >= 5) {
      if (silentPendingTimer) {
        clearTimeout(silentPendingTimer);
        silentPendingTimer = null;
      }
      tapTimes = [];
      clearInterval(countdownInterval);
      countdownInterval = null;
      var overlay = document.getElementById('sos-countdown-overlay');
      if (overlay) overlay.classList.remove('active');
      startEmergencyMode();
      return 'emergency';
    } else if (count >= 3) {
      if (silentPendingTimer) {
        clearTimeout(silentPendingTimer);
      }
      silentPendingTimer = setTimeout(function() {
        silentPendingTimer = null;
        tapTimes = [];
        clearInterval(countdownInterval);
        countdownInterval = null;
        var overlay = document.getElementById('sos-countdown-overlay');
        if (overlay) overlay.classList.remove('active');
        startSilentMode();
      }, 400);
      return 'silent_pending';
    }
    // 1 or 2 taps: stay in countdown
    return 'normal';
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
    var user = SafeHer.api.getUser();
    var userName = user && user.name ? user.name : 'SafeHer User';
    var time = currentAlertTime || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var lat = currentLat || BENGALURU_LAT;
    var lng = currentLng || BENGALURU_LNG;
    var mapsUrl = 'https://www.google.com/maps?q=' + lat + ',' + lng;

    var active = (SafeHer.api && SafeHer.api.getActiveSos) ? SafeHer.api.getActiveSos() : null;
    var trackPart = '';
    if (active && active.shareToken) {
      trackPart = ' Live Tracking: ' + window.location.origin + '/track.html?t=' + active.shareToken;
    }

    return 'EMERGENCY: ' + userName + ' triggered an SOS alert on SafeHer at ' + time + '. Location: ' + mapsUrl + trackPart;
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

    currentMode = 'normal';
    tapTimes = [Date.now()]; // first tap on the SOS button counts
    countdownSecs = 5;

    var numEl = document.getElementById('sos-countdown-num');
    if (!overlay || !numEl) return;

    numEl.textContent = countdownSecs;
    overlay.classList.add('active');

    clearInterval(countdownInterval);
    countdownInterval = setInterval(function() {
      countdownSecs--;
      if (countdownSecs > 0) {
        numEl.textContent = countdownSecs;
      } else {
        clearInterval(countdownInterval);
        countdownInterval = null;
        overlay.classList.remove('active');
        triggerActiveAlert('normal');
      }
    }, 1000);
  }

  function cancelCountdown() {
    if (silentPendingTimer) {
      clearTimeout(silentPendingTimer);
      silentPendingTimer = null;
    }
    clearInterval(countdownInterval);
    countdownInterval = null;
    tapTimes = [];
    var overlay = document.getElementById('sos-countdown-overlay');
    if (overlay) overlay.classList.remove('active');
    SafeHer.toast('SOS alert cancelled');
  }

  function onOverlayTap(e) {
    if (e.target && e.target.classList.contains('sos-countdown-cancel')) return;
    registerTap();
  }

  // ─── Trigger Active SOS ──────────────────────────────────
  function triggerActiveAlert(mode) {
    currentMode = mode || 'normal';
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
        if (typeof err === 'string' && err.toLowerCase().indexOf('too many alerts') !== -1) {
          // Abuse limit hit: cancel active alert state and show modal
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

        // When SOS creation fails after 3 retries, show offline emergency fallback
        if (isOfflineFallback || (typeof err === 'string' && err.indexOf('failed after 3 attempts') !== -1)) {
          showOfflineFallback();
        }
      }
      if (!err && created && created.id) {
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
      renderSilentMode();
      if (SafeHer.vault && SafeHer.vault.startSilentSession) {
        SafeHer.vault.startSilentSession(currentAlertId);
      } else if (SafeHer.vault && SafeHer.vault.startSession) {
        SafeHer.vault.startSession('audio', currentAlertId);
      }
    } else if (currentMode === 'emergency') {
      renderEmergencyMode();
      if (SafeHer.vault && SafeHer.vault.startEmergencySession) {
        SafeHer.vault.startEmergencySession(currentAlertId);
      } else if (SafeHer.vault && SafeHer.vault.getSettings().enabled) {
        var vSettings = SafeHer.vault.getSettings();
        if (vSettings.recordEmergencyVideo) {
          SafeHer.vault.startSession('video', currentAlertId);
        } else if (vSettings.recordSilentAudio) {
          SafeHer.vault.startSession('audio', currentAlertId);
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

  // ─── Silent Mode ──────────────────────────────────────────
  // Note: in production, silent background alert push to contacts will be handled via the backend.
  var silentTapTimes = [];

  function startSilentMode() {
    triggerActiveAlert('silent');
  }

  function renderSilentMode() {
    SafeHer.router.go('silent-mode');

    // Request Screen Wake Lock
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(function(lock) {
        wakeLock = lock;
      }).catch(function() {});
    }

    // Try requestFullscreen
    var docEl = document.documentElement;
    if (docEl.requestFullscreen) {
      docEl.requestFullscreen().catch(function() {});
    }
  }

  function onSilentScreenTap() {
    if (navigator.vibrate) {
      try { navigator.vibrate(35); } catch(e) {}
    }
    var now = Date.now();
    silentTapTimes.push(now);
    silentTapTimes = silentTapTimes.filter(function(t) { return now - t <= 2500; });

    if (silentTapTimes.length >= 3) {
      silentTapTimes = [];
      SafeHer.askPin(
        function(enteredPin) {
          // Correct PIN -> end alert
          endAlertSilently(enteredPin);
        },
        function() {
          // Wrong PIN or cancelled -> return silently to black screen
        },
        { blackTheme: true }
      );
    }
  }

  function endAlertSilently(enteredPin) {
    hideOfflineFallback();
    if (silentPendingTimer) {
      clearTimeout(silentPendingTimer);
      silentPendingTimer = null;
    }
    stopTrackingInterval();
    stopDurationCounter();
    stopVolunteerStatusPolling();
    releaseWakeLock();
    if (SafeHer.vault && SafeHer.vault.endSession) {
      SafeHer.vault.endSession();
    }

    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function() {});
    }

    var alertIdForFeedback = currentAlertId;
    var respondersForFeedback = (currentAlertResponders && currentAlertResponders.length > 0) ? currentAlertResponders.slice() : [];

    if (currentAlertId) {
      if (SafeHer.api && SafeHer.api.endAlert) {
        SafeHer.api.endAlert(currentAlertId, enteredPin || '');
      } else {
        SafeHer.api.updateAlert(currentAlertId, {
          status: 'resolved',
          endTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });
      }
      currentAlertId = null;
    }

    if (SafeHer.api && SafeHer.api.clearActiveSos) {
      SafeHer.api.clearActiveSos();
    }

    if (SafeHer.home && SafeHer.home.setSOSActive) {
      SafeHer.home.setSOSActive(false);
    }

    renderResponders([]);
    renderContactsResponding([]);

    if (alertIdForFeedback && respondersForFeedback.length > 0) {
      startFeedbackQueue(alertIdForFeedback, respondersForFeedback);
    } else {
      SafeHer.toast('SOS ended');
      SafeHer.router.go('home');
    }
  }

  // ─── Emergency Mode ───────────────────────────────────────
  function startEmergencyMode() {
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
    SafeHer.askPin(function() {
      stopSiren();
      stopVibration();
      finishEndingAlert();
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
    var encodedMessage = encodeURIComponent(message);

    var user = SafeHer.api.getUser();
    var userName = user && user.name ? user.name : 'SafeHer User';

    var html = '';
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      var rawPhone = (c.phone || '').replace(/\D/g, '');
      var initial = (c.name || '?').charAt(0).toUpperCase();

      html += '<div class="sos-notified-item">' +
        '<div class="sos-notified-left">' +
          '<div class="sos-notified-avatar">' + escapeHtml(initial) + '</div>' +
          '<div class="sos-notified-info">' +
            '<span class="sos-notified-name" style="font-weight:600;">' + escapeHtml(c.name) + '</span>' +
            (c.email ? '<span class="sos-notified-email" style="display:block;font-size:10px;color:#555;line-height:1.2;">' + escapeHtml(c.email) + '</span>' : '') +
            (rawPhone ? '<span class="sos-notified-phone" style="display:block;font-size:10px;color:#777;line-height:1.2;">' + escapeHtml(rawPhone) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="sos-contact-btns">' +
          (c.email ? '<span class="sos-badge-sent" title="Dispatched automatically via Gmail SMTP"><span class="material-symbols-rounded" style="font-size:13px;">mark_email_read</span>Email Sent</span>' : '') +
          (rawPhone ? '<span class="sos-badge-sent" title="Dispatched automatically via WhatsApp API"><span class="material-symbols-rounded" style="font-size:13px;">chat</span>WhatsApp Sent</span>' : '') +
        '</div>' +
      '</div>';
    }

    listEl.innerHTML = html;
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
    SafeHer.askPin(function(enteredPin) {
      finishEndingAlert(enteredPin);
    });
  }

  function finishEndingAlert(enteredPin) {
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
        SafeHer.api.endAlert(currentAlertId, enteredPin || '');
      } else {
        SafeHer.api.updateAlert(currentAlertId, {
          status: 'resolved',
          endTime: endTimeStr
        });
      }
      currentAlertId = null;
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
      SafeHer.router.go('home');
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
    if (!subEl) return;

    var n = (activeSos && activeSos.volunteersEnRoute) ? activeSos.volunteersEnRoute : 0;
    if (n > 0) {
      subEl.textContent = n + ' volunteer' + (n > 1 ? 's are' : ' is') + ' on the way';
      var box = subEl.parentElement;
      if (box) {
        var icon = box.querySelector('.material-symbols-rounded');
        if (icon) icon.textContent = 'directions_run';
      }
    } else {
      subEl.textContent = 'Waiting for volunteers...';
      var box = subEl.parentElement;
      if (box) {
        var icon = box.querySelector('.material-symbols-rounded');
        if (icon) icon.textContent = 'hourglass_top';
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

    var overlay = document.getElementById('sos-countdown-overlay');
    if (overlay) {
      overlay.onclick = onOverlayTap;
    }
  }

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
    if (!listEl) return;

    if (!responders || !Array.isArray(responders) || responders.length === 0) {
      listEl.innerHTML = '<p style="font-size: 12px; color: var(--text-gray); margin: 0; text-align: center; padding: 8px 0;">Waiting for volunteers to respond...</p>';
      if (countEl) countEl.textContent = '0 coming';
      return;
    }

    if (countEl) {
      countEl.textContent = responders.length + (responders.length === 1 ? ' coming' : ' coming');
    }

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

    listEl.innerHTML = html;

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
    startEmergencyMode: startEmergencyMode,
    onSilentScreenTap: onSilentScreenTap,
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
