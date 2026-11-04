// js/sos.js – SOS modes (normal, silent, emergency), tap detector, audio siren, live tracking, Leaflet map, and PIN protection

SafeHer.sos = (function() {
  var countdownSecs = 5;
  var countdownInterval = null;
  var liveTrackingInterval = null;
  var volunteerStatusInterval = null;
  var currentAlertId = null;
  var alertStartTime = null;
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
    // If no PIN set, prompt to set one first
    if (!SafeHer.api.hasPin()) {
      SafeHer.pin.openSetPin('home', function() {
        startCountdown();
      });
      return;
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

    currentLat = BENGALURU_LAT;
    currentLng = BENGALURU_LNG;

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
    } else if (currentMode === 'silent') {
      renderSilentMode();
    } else if (currentMode === 'emergency') {
      renderEmergencyMode();
    }

    // Now resolve real location in the background
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          currentLat = pos.coords.latitude;
          currentLng = pos.coords.longitude;

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
    var now = Date.now();
    silentTapTimes.push(now);
    silentTapTimes = silentTapTimes.filter(function(t) { return now - t <= 2000; });

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

    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function() {});
    }

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

    SafeHer.toast('SOS ended');
    SafeHer.router.go('home');
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
        attributionControl: false
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19
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
      var waPhone = rawPhone.length === 10 ? '91' + rawPhone : rawPhone;
      var waUrl = 'https://wa.me/' + waPhone + '?text=' + encodedMessage;
      var smsUrl = 'sms:' + rawPhone + '?body=' + encodedMessage;
      var telUrl = rawPhone ? 'tel:' + rawPhone : '#';
      var initial = (c.name || '?').charAt(0).toUpperCase();

      var emailSubject = encodeURIComponent('EMERGENCY: SafeHer SOS Alert from ' + userName);
      var emailUrl = c.email
        ? ('mailto:' + encodeURIComponent(c.email) + '?subject=' + emailSubject + '&body=' + encodedMessage)
        : ('mailto:?subject=' + emailSubject + '&body=' + encodedMessage);

      html += '<div class="sos-notified-item">' +
        '<div class="sos-notified-left">' +
          '<div class="sos-notified-avatar">' + escapeHtml(initial) + '</div>' +
          '<div class="sos-notified-info">' +
            '<a class="sos-notified-name" href="' + escapeHtml(telUrl) + '" title="Call ' + escapeHtml(c.name) + '">' +
              escapeHtml(c.name) +
            '</a>' +
            (c.email ? '<span class="sos-notified-email" style="display:block;font-size:10px;color:#777;line-height:1.2;">' + escapeHtml(c.email) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="sos-contact-btns">' +
          '<a class="sos-btn-wa" href="' + escapeHtml(waUrl) + '" target="_blank" rel="noopener noreferrer">WhatsApp</a>' +
          '<a class="sos-btn-sms" href="' + escapeHtml(smsUrl) + '">SMS</a>' +
          '<a class="sos-btn-email" href="' + escapeHtml(emailUrl) + '" title="Send Emergency Email">Email</a>' +
        '</div>' +
      '</div>';
    }

    listEl.innerHTML = html;
  }

  function shareToAll() {
    var message = buildAlertMessage();
    if (navigator.share) {
      navigator.share({
        title: 'Emergency SOS - SafeHer',
        text: message
      }).then(function() {
        SafeHer.toast('Alert shared');
      }).catch(function(err) {
        if (err.name !== 'AbortError') copyAlertMessageFallback(message);
      });
    } else {
      copyAlertMessageFallback(message);
    }
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
    for (var i = 0; i < contacts.length; i++) {
      var p = (contacts[i].phone || '').replace(/\D/g, '');
      if (p.length === 10) { targetPhone = '91' + p; break; }
      if (p.length > 10) { targetPhone = p; break; }
    }
    var message = buildAlertMessage();
    var waUrl = targetPhone
      ? ('https://wa.me/' + targetPhone + '?text=' + encodeURIComponent(message))
      : ('https://api.whatsapp.com/send?text=' + encodeURIComponent(message));
    window.open(waUrl, '_blank');
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

    var endTimeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

    if (SafeHer.home && SafeHer.home.setSOSActive) {
      SafeHer.home.setSOSActive(false);
    }

    SafeHer.toast('SOS ended');
    SafeHer.router.go('home');
  }

  // ─── Volunteer Status Polling (every 5s) ───────────────────
  function startVolunteerStatusPolling() {
    stopVolunteerStatusPolling();
    pollVolunteerStatus();
    volunteerStatusInterval = setInterval(pollVolunteerStatus, 5000);
  }

  function stopVolunteerStatusPolling() {
    if (volunteerStatusInterval) {
      clearInterval(volunteerStatusInterval);
      volunteerStatusInterval = null;
    }
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
        var act = SafeHer.api.getActiveSos ? SafeHer.api.getActiveSos() : null;
        if (act) {
          act.volunteersEnRoute = coming;
          act.volunteerStatus = coming > 0 ? (coming + ' volunteer' + (coming > 1 ? 's are' : ' is') + ' on the way') : 'Waiting for volunteers...';
          SafeHer.api.setActiveSos(act);
        }
        updateVolunteerStatusDisplay();
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

  return {
    init: init,
    startCountdown: startCountdown,
    cancelCountdown: cancelCountdown,
    startSilentMode: startSilentMode,
    startEmergencyMode: startEmergencyMode,
    onSilentScreenTap: onSilentScreenTap,
    requestEndAlert: requestEndAlert,
    requestStopAlarm: requestStopAlarm,
    shareToAll: shareToAll,
    sendOfflineSmsAll: sendOfflineSmsAll,
    sendOfflineWhatsAppAll: sendOfflineWhatsAppAll
  };
})();
