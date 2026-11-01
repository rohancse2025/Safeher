// js/sos.js – SOS countdown, alert dispatch, live tracking, Leaflet map, and alert history

SafeHer.sos = (function() {
  var countdownSecs = 5;
  var countdownInterval = null;
  var liveTrackingInterval = null;
  var currentAlertId = null;
  var mapInstance = null;
  var markerInstance = null;
  var currentLat = null;
  var currentLng = null;
  var currentAlertTime = '';

  // Fallback location: Bengaluru (12.9716, 77.5946)
  var BENGALURU_LAT = 12.9716;
  var BENGALURU_LNG = 77.5946;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Emergency Message Builder ────────────────────────────
  function buildAlertMessage() {
    var user = SafeHer.api.getUser();
    var userName = user && user.name ? user.name : 'SafeHer User';
    var time = currentAlertTime || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var lat = currentLat || BENGALURU_LAT;
    var lng = currentLng || BENGALURU_LNG;
    var mapsUrl = 'https://www.google.com/maps?q=' + lat + ',' + lng;

    return 'EMERGENCY: ' + userName + ' triggered an SOS alert on SafeHer at ' + time + '. Location: ' + mapsUrl;
  }

  // ─── 5-4-3-2-1 Countdown ─────────────────────────────────
  function startCountdown() {
    countdownSecs = 5;
    var overlay = document.getElementById('sos-countdown-overlay');
    var numEl = document.getElementById('sos-countdown-num');
    if (!overlay || !numEl) {
      console.warn('SOS overlay or number element not found');
      return;
    }

    numEl.textContent = countdownSecs;
    overlay.classList.add('active');

    clearInterval(countdownInterval);
    countdownInterval = setInterval(function() {
      countdownSecs--;
      if (countdownSecs > 0) {
        numEl.textContent = countdownSecs;
      } else {
        clearInterval(countdownInterval);
        overlay.classList.remove('active');
        triggerActiveAlert();
      }
    }, 1000);
  }

  function cancelCountdown() {
    clearInterval(countdownInterval);
    var overlay = document.getElementById('sos-countdown-overlay');
    if (overlay) overlay.classList.remove('active');
    SafeHer.toast('SOS alert cancelled');
  }

  // ─── Trigger Active SOS ──────────────────────────────────
  function triggerActiveAlert() {
    if (SafeHer.home && SafeHer.home.setSOSActive) {
      SafeHer.home.setSOSActive(true);
    }

    // Try geolocation with fallback
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          onLocationResolved(pos.coords.latitude, pos.coords.longitude, false);
        },
        function() {
          SafeHer.toast('Location off. Using Bengaluru fallback.');
          onLocationResolved(BENGALURU_LAT, BENGALURU_LNG, true);
        },
        { timeout: 7000 }
      );
    } else {
      SafeHer.toast('Geolocation unsupported. Using Bengaluru fallback.');
      onLocationResolved(BENGALURU_LAT, BENGALURU_LNG, true);
    }
  }

  function onLocationResolved(lat, lng, isFallback) {
    currentLat = lat;
    currentLng = lng;

    var now = new Date();
    var timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    currentAlertTime = timeStr;

    // Save alert into alert history via api.js
    // POST /api/alerts
    var newAlert = SafeHer.api.addAlert({
      time: timeStr,
      timestamp: Date.now(),
      lat: lat,
      lng: lng,
      status: 'active'
    });
    currentAlertId = newAlert ? newAlert.id : Date.now();

    // Render screen
    var timeEl = document.getElementById('sos-alert-time');
    if (timeEl) timeEl.textContent = timeStr;

    updateMap(lat, lng);
    updateGmapsLink(lat, lng);
    renderNotifiedContacts();

    // Switch to SOS active screen
    SafeHer.router.go('sos-active');
    SafeHer.toast('Emergency alert triggered!');

    // Start 10-second location updates
    startTrackingInterval();
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
      setTimeout(function() {
        if (mapInstance) mapInstance.invalidateSize();
      }, 200);
    }
  }

  function updateGmapsLink(lat, lng) {
    var link = document.getElementById('sos-gmaps-link');
    if (link) {
      link.href = 'https://www.google.com/maps?q=' + lat + ',' + lng;
    }
  }

  function renderNotifiedContacts() {
    var listEl = document.getElementById('sos-notified-list');
    if (!listEl) return;

    var contacts = SafeHer.api.getContacts();
    if (!contacts || contacts.length === 0) {
      listEl.innerHTML = '<p class="prototype-note" style="text-align:left;">No emergency contacts added yet.</p>';
      return;
    }

    var message = buildAlertMessage();
    var encodedMessage = encodeURIComponent(message);

    var html = '';
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      var rawPhone = (c.phone || '').replace(/\D/g, '');
      // Format 10 digit Indian number for wa.me/91<phone>
      var waPhone = rawPhone.length === 10 ? '91' + rawPhone : rawPhone;
      var waUrl = 'https://wa.me/' + waPhone + '?text=' + encodedMessage;
      var smsUrl = 'sms:' + rawPhone + '?body=' + encodedMessage;
      var initial = (c.name || '?').charAt(0).toUpperCase();

      html += '<div class="sos-notified-item">' +
        '<div class="sos-notified-left">' +
          '<div class="sos-notified-avatar">' + escapeHtml(initial) + '</div>' +
          '<span class="sos-notified-name">' + escapeHtml(c.name) + '</span>' +
        '</div>' +
        '<div class="sos-contact-btns">' +
          '<a class="sos-btn-wa" href="' + waUrl + '" target="_blank" rel="noopener noreferrer">WhatsApp</a>' +
          '<a class="sos-btn-sms" href="' + smsUrl + '">SMS</a>' +
        '</div>' +
      '</div>';
    }

    listEl.innerHTML = html;
  }

  // ─── Share to All ─────────────────────────────────────────
  function shareToAll() {
    var message = buildAlertMessage();

    if (navigator.share) {
      navigator.share({
        title: 'Emergency SOS - SafeHer',
        text: message
      }).then(function() {
        SafeHer.toast('Alert shared');
      }).catch(function(err) {
        if (err.name !== 'AbortError') {
          copyAlertMessageFallback(message);
        }
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
      // Fallback text copy for older browsers
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

  // ─── Live Location Tracking (every 10s) ───────────────────
  function startTrackingInterval() {
    clearInterval(liveTrackingInterval);
    liveTrackingInterval = setInterval(function() {
      if (!navigator.geolocation) return;

      navigator.geolocation.getCurrentPosition(
        function(pos) {
          currentLat = pos.coords.latitude;
          currentLng = pos.coords.longitude;

          // PUT /api/alerts/:id
          if (currentAlertId) {
            SafeHer.api.updateAlert(currentAlertId, {
              lat: currentLat,
              lng: currentLng
            });
          }

          updateMap(currentLat, currentLng);
          updateGmapsLink(currentLat, currentLng);
          renderNotifiedContacts();
        },
        function() {
          // Keep current lat/lng on temporary GPS failure
        },
        { timeout: 5000 }
      );
    }, 10000);
  }

  function stopTrackingInterval() {
    clearInterval(liveTrackingInterval);
    liveTrackingInterval = null;
  }

  // ─── End Alert ("I'm Safe") ──────────────────────────────
  function endAlert() {
    stopTrackingInterval();

    if (currentAlertId) {
      // PUT /api/alerts/:id
      SafeHer.api.updateAlert(currentAlertId, { status: 'resolved' });
      currentAlertId = null;
    }

    if (SafeHer.home && SafeHer.home.setSOSActive) {
      SafeHer.home.setSOSActive(false);
    }

    SafeHer.toast("Alert ended. You're marked safe.");
    SafeHer.router.go('home');
  }

  function init() {
    SafeHer.router.onShow('sos-active', function() {
      if (mapInstance) {
        setTimeout(function() { mapInstance.invalidateSize(); }, 200);
      }
    });
  }

  return {
    init: init,
    startCountdown: startCountdown,
    cancelCountdown: cancelCountdown,
    endAlert: endAlert,
    shareToAll: shareToAll
  };
})();
