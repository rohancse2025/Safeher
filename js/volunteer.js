// js/volunteer.js – Community Volunteers, availability toggle, cross-tab SOS alerting, and response tracking
//
// Note: In production across different devices/phones, real-time volunteer alerting
// requires a backend server with WebSocket, Server-Sent Events (SSE), or Web Push
// notifications. The localStorage 'storage' event provides real-time cross-tab
// communication within the same browser for local testing and demonstration.

SafeHer.volunteer = (function() {
  var dismissedAlertId = null;
  var respondedAlertId = null;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Haversine Distance (in km) ───────────────────────────
  function haversineDistance(lat1, lon1, lat2, lon2) {
    var R = 6371; // Earth radius in km
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function formatDistance(distKm) {
    if (distKm < 1) {
      return Math.round(distKm * 1000) + ' m away';
    }
    return distKm.toFixed(1) + ' km away';
  }

  // ─── Save & Toggle Availability ───────────────────────────
  function toggleAvailable(isAvailable) {
    var descEl = document.getElementById('volunteer-status-desc');
    var posRow = document.getElementById('volunteer-pos-row');
    var posText = document.getElementById('volunteer-pos-text');

    if (isAvailable) {
      function saveWithCoords(lat, lng) {
        var profile = {
          isAvailable: true,
          lat: lat,
          lng: lng,
          updatedAt: Date.now()
        };
        if (SafeHer.api && SafeHer.api.setVolunteerProfile) {
          SafeHer.api.setVolunteerProfile(profile);
        }

        if (descEl) descEl.textContent = 'You are available to help nearby users in distress.';
        if (posRow) posRow.style.display = 'flex';
        if (posText) posText.textContent = 'GPS active: ' + lat.toFixed(4) + ', ' + lng.toFixed(4);

        updateHomeVolunteerCount();
        SafeHer.toast('Available to help enabled');
        checkActiveAlert();
      }

      // Try current GPS location
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          function(pos) {
            saveWithCoords(pos.coords.latitude, pos.coords.longitude);
          },
          function() {
            var fallback = (SafeHer.api && SafeHer.api.getLiveLocation) ? SafeHer.api.getLiveLocation() : null;
            var fLat = fallback ? fallback.lat : 12.9716;
            var fLng = fallback ? fallback.lng : 77.5946;
            saveWithCoords(fLat, fLng);
          },
          { timeout: 6000, enableHighAccuracy: true }
        );
      } else {
        saveWithCoords(12.9716, 77.5946);
      }
    } else {
      var profile = {
        isAvailable: false,
        lat: null,
        lng: null,
        updatedAt: Date.now()
      };
      if (SafeHer.api && SafeHer.api.setVolunteerProfile) {
        SafeHer.api.setVolunteerProfile(profile);
      }

      if (descEl) descEl.textContent = 'Turn on to receive emergency alerts near you.';
      if (posRow) posRow.style.display = 'none';

      hideAlertCard();
      updateHomeVolunteerCount();
      SafeHer.toast('Availability turned off');
    }
  }

  function hideAlertCard() {
    var card = document.getElementById('volunteer-alert-card');
    if (card) card.style.display = 'none';
  }

  function showAlertCardData(alertId, timeStr, distKm, mapsUrl) {
    var card = document.getElementById('volunteer-alert-card');
    var timeEl = document.getElementById('volunteer-alert-time');
    var distEl = document.getElementById('volunteer-alert-dist-text');
    var mapLink = document.getElementById('volunteer-alert-map-link');
    var actionsGroup = document.getElementById('volunteer-alert-actions');
    var respondedBox = document.getElementById('volunteer-responded-status');

    if (timeEl) timeEl.textContent = timeStr || 'Active now';
    if (distEl) distEl.textContent = formatDistance(distKm || 0);
    if (mapLink && mapsUrl) mapLink.href = mapsUrl;

    if (respondedAlertId === alertId) {
      if (actionsGroup) actionsGroup.style.display = 'none';
      if (respondedBox) respondedBox.style.display = 'flex';
    } else {
      if (actionsGroup) actionsGroup.style.display = 'flex';
      if (respondedBox) respondedBox.style.display = 'none';
    }

    if (card) card.style.display = 'block';
  }

  // ─── Cross-Tab Active SOS Detection & Check ───────────────
  function checkLocalActiveAlert(profile) {
    var activeSos = SafeHer.api ? SafeHer.api.getActiveSos() : null;
    if (!activeSos || activeSos.status !== 'active') {
      hideAlertCard();
      return;
    }

    // If volunteer already dismissed this specific alert
    if (dismissedAlertId && dismissedAlertId === activeSos.id) {
      hideAlertCard();
      return;
    }

    var vLat = profile.lat || 12.9716;
    var vLng = profile.lng || 77.5946;
    var sLat = activeSos.lat || 12.9716;
    var sLng = activeSos.lng || 77.5946;

    var distKm = haversineDistance(vLat, vLng, sLat, sLng);

    // Only show if within 2 km
    if (distKm <= 2.0) {
      var mapsUrl = 'https://www.google.com/maps?q=' + sLat + ',' + sLng;
      showAlertCardData(activeSos.id, activeSos.time ? activeSos.time : 'Active now', distKm, mapsUrl);
    } else {
      hideAlertCard();
    }
  }

  function checkActiveAlert() {
    var profile = SafeHer.api ? SafeHer.api.getVolunteerProfile() : { isAvailable: false };
    if (!profile || !profile.isAvailable) {
      hideAlertCard();
      return;
    }

    if (SafeHer.api && SafeHer.api.getNearbyAlerts) {
      SafeHer.api.getNearbyAlerts(function(err, alerts) {
        if (!err && alerts && alerts.length > 0) {
          var firstAlert = alerts[0];
          if (dismissedAlertId && dismissedAlertId === firstAlert.id) {
            hideAlertCard();
            return;
          }
          showAlertCardData(firstAlert.id, firstAlert.started_at, firstAlert.distance_km, firstAlert.maps_url);
          return;
        }
        checkLocalActiveAlert(profile);
      });
      return;
    }

    checkLocalActiveAlert(profile);
  }

  // ─── Volunteer Response: "I'm coming" ─────────────────────
  function respondComing() {
    var activeSos = SafeHer.api ? SafeHer.api.getActiveSos() : null;
    var alertId = (activeSos && activeSos.id) ? activeSos.id : 1;
    respondedAlertId = alertId;

    if (activeSos && activeSos.status === 'active') {
      // Increment volunteers on the way
      var currentCount = activeSos.volunteersEnRoute || 0;
      activeSos.volunteersEnRoute = currentCount + 1;
      activeSos.volunteerStatus = activeSos.volunteersEnRoute + ' volunteer' +
        (activeSos.volunteersEnRoute > 1 ? 's are' : ' is') + ' on the way';

      if (SafeHer.api && SafeHer.api.setActiveSos) {
        SafeHer.api.setActiveSos(activeSos);
      }

      // Also update history alert if present
      if (SafeHer.api && SafeHer.api.updateAlert) {
        SafeHer.api.updateAlert(activeSos.id, {
          volunteersEnRoute: activeSos.volunteersEnRoute,
          volunteerStatus: activeSos.volunteerStatus
        });
      }

      // If SOS screen is open in the same tab, update it directly too
      var sosSubEl = document.getElementById('sos-status-sub');
      if (sosSubEl) {
        var n = activeSos.volunteersEnRoute;
        sosSubEl.textContent = n + ' volunteer' + (n > 1 ? 's are' : ' is') + ' on the way';
      }
    }

    if (SafeHer.api && SafeHer.api.respondToAlert) {
      SafeHer.api.respondToAlert(alertId, 'coming');
    }

    // Update volunteer UI
    var actionsGroup = document.getElementById('volunteer-alert-actions');
    var respondedBox = document.getElementById('volunteer-responded-status');
    if (actionsGroup) actionsGroup.style.display = 'none';
    if (respondedBox) respondedBox.style.display = 'flex';

    SafeHer.toast('Status sent: You are on the way');
  }

  // ─── Volunteer Response: "Can't help" ──────────────────────
  function respondCantHelp() {
    var activeSos = SafeHer.api ? SafeHer.api.getActiveSos() : null;
    var alertId = (activeSos && activeSos.id) ? activeSos.id : 1;
    dismissedAlertId = alertId;

    if (SafeHer.api && SafeHer.api.respondToAlert) {
      SafeHer.api.respondToAlert(alertId, 'cannot');
    }

    hideAlertCard();
    SafeHer.toast('Alert dismissed');
  }

  function updateHomeVolunteerCount() {
    var profile = SafeHer.api ? SafeHer.api.getVolunteerProfile() : null;
    var countEl = document.getElementById('home-volunteers-count');
    if (countEl) {
      countEl.textContent = (profile && profile.isAvailable) ? '1' : '0';
    }

    if (SafeHer.api && SafeHer.api.getAvailableVolunteersCount) {
      SafeHer.api.getAvailableVolunteersCount(function(err, count) {
        if (!err && count !== undefined && countEl) {
          countEl.textContent = String(count);
        }
      });
    }
  }

  function render() {
    var profile = SafeHer.api ? SafeHer.api.getVolunteerProfile() : { isAvailable: false };
    var toggle = document.getElementById('volunteer-available-toggle');
    var descEl = document.getElementById('volunteer-status-desc');
    var posRow = document.getElementById('volunteer-pos-row');
    var posText = document.getElementById('volunteer-pos-text');

    var isAvail = !!(profile && profile.isAvailable);
    if (toggle) toggle.checked = isAvail;

    if (isAvail) {
      if (descEl) descEl.textContent = 'You are available to help nearby users in distress.';
      if (posRow) posRow.style.display = 'flex';
      if (posText && profile.lat && profile.lng) {
        posText.textContent = 'GPS active: ' + profile.lat.toFixed(4) + ', ' + profile.lng.toFixed(4);
      }
    } else {
      if (descEl) descEl.textContent = 'Turn on to receive emergency alerts near you.';
      if (posRow) posRow.style.display = 'none';
    }

    checkActiveAlert();
  }

  function init() {
    // Listen for cross-tab localStorage updates
    window.addEventListener('storage', function(e) {
      if (e.key === 'safeher_active_sos') {
        checkActiveAlert();
      }
    });

    SafeHer.router.onShow('volunteers', function() {
      render();
    });

    SafeHer.router.onShow('home', function() {
      updateHomeVolunteerCount();
    });
  }

  return {
    init: init,
    render: render,
    toggleAvailable: toggleAvailable,
    respondComing: respondComing,
    respondCantHelp: respondCantHelp,
    checkActiveAlert: checkActiveAlert
  };
})();
