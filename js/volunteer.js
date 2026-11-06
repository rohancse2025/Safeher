// js/volunteer.js – Community Volunteers, verification state, 5s polling, and response dispatch

SafeHer.volunteer = (function() {
  var dismissedAlertId = null;
  var respondedAlertId = null;
  var currentAlertId = null;
  var pollingTimer = null;

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── Haversine Distance (in km) ───────────────────────────
  // Note: Kept on the front end for offline/local scenarios; server provides pre-calculated distance_km.
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

  // ─── 5-Second Real-Time Polling ───────────────────────────
  function startPolling() {
    stopPolling();
    pollNearbyAlerts();
    pollingTimer = setInterval(pollNearbyAlerts, 5000);
  }

  function stopPolling() {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
  }

  function pollNearbyAlerts() {
    var profile = SafeHer.api ? SafeHer.api.getVolunteerProfile() : null;
    if (!profile || !profile.isAvailable) {
      hideAlertCard();
      stopPolling();
      return;
    }

    if (!SafeHer.api || !SafeHer.api.getNearbyAlerts) return;

    SafeHer.api.getNearbyAlerts(function(err, alerts) {
      if (!err && alerts && alerts.length > 0) {
        var firstAlert = alerts[0];
        var id = firstAlert.alert_id || firstAlert.id;
        currentAlertId = id;

        if (dismissedAlertId && dismissedAlertId === id) {
          hideAlertCard();
          return;
        }

        // Use precalculated distance_km returned from the server
        showAlertCardData(id, firstAlert.time || firstAlert.started_at, firstAlert.distance_km, firstAlert.maps_link);
      } else {
        hideAlertCard();
      }
    });
  }

  // ─── Save & Toggle Availability ───────────────────────────
  function toggleAvailable(isAvailable) {
    var descEl = document.getElementById('volunteer-status-desc');
    var posRow = document.getElementById('volunteer-pos-row');
    var posText = document.getElementById('volunteer-pos-text');
    var profile = SafeHer.api ? SafeHer.api.getVolunteerProfile() : {};

    if (isAvailable) {
      function saveWithCoords(lat, lng) {
        profile.isAvailable = true;
        profile.lat = lat;
        profile.lng = lng;
        profile.updatedAt = Date.now();

        if (SafeHer.api && SafeHer.api.setVolunteerProfile) {
          SafeHer.api.setVolunteerProfile(profile, function(err, saved) {
            if (saved && saved.status) {
              profile.status = saved.status;
              renderVerificationBadge(saved.status);
            }
          });
        }

        if (descEl) descEl.textContent = 'You are available to help nearby users in distress.';
        if (posRow) posRow.style.display = 'flex';
        if (posText) posText.textContent = 'GPS active: ' + lat.toFixed(4) + ', ' + lng.toFixed(4);

        updateHomeVolunteerCount();
        SafeHer.toast('Available to help enabled');

        // Start 5-second polling for active alerts
        startPolling();
      }

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
      profile.isAvailable = false;
      profile.updatedAt = Date.now();

      if (SafeHer.api && SafeHer.api.setVolunteerProfile) {
        SafeHer.api.setVolunteerProfile(profile);
      }

      if (descEl) descEl.textContent = 'Turn on to receive emergency alerts near you.';
      if (posRow) posRow.style.display = 'none';

      stopPolling();
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
    if (distEl) distEl.textContent = formatDistance(distKm !== undefined ? distKm : 0);
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

  // ─── Volunteer Response: "I'm coming" ─────────────────────
  function respondComing() {
    var alertId = currentAlertId;
    if (!alertId) {
      SafeHer.toast('No active alert selected');
      return;
    }

    respondedAlertId = alertId;

    if (SafeHer.api && SafeHer.api.respondToAlert) {
      SafeHer.api.respondToAlert(alertId, 'coming', function(err) {
        if (err) {
          SafeHer.toast(err);
          return;
        }
      });
    }

    // Update volunteer UI immediately
    var actionsGroup = document.getElementById('volunteer-alert-actions');
    var respondedBox = document.getElementById('volunteer-responded-status');
    if (actionsGroup) actionsGroup.style.display = 'none';
    if (respondedBox) respondedBox.style.display = 'flex';

    SafeHer.toast('Status sent: You are on the way');
  }

  // ─── Volunteer Response: "Can't help" ──────────────────────
  function respondCantHelp() {
    if (currentAlertId) {
      dismissedAlertId = currentAlertId;
      if (SafeHer.api && SafeHer.api.respondToAlert) {
        SafeHer.api.respondToAlert(currentAlertId, 'cannot');
      }
    }
    hideAlertCard();
    SafeHer.toast('Alert dismissed');
  }

  function updateHomeVolunteerCount() {
    var countEl = document.getElementById('home-volunteers-count');
    if (!countEl) return;

    var loc = (SafeHer.api && SafeHer.api.getLiveLocation) ? SafeHer.api.getLiveLocation() : null;
    if (loc && loc.lat != null && loc.lng != null) {
      fetchWithCoords(loc);
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          fetchWithCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        function() {
          fetchWithCoords(null);
        },
        { timeout: 4000, maximumAge: 60000 }
      );
    } else {
      fetchWithCoords(null);
    }

    function fetchWithCoords(coords) {
      if (SafeHer.api && SafeHer.api.getAvailableVolunteersCount) {
        SafeHer.api.getAvailableVolunteersCount(function(err, count) {
          if (!err && count !== undefined && countEl) {
            countEl.textContent = String(count);
          }
        }, coords);
      }
    }
  }

  function renderVerificationBadge(status) {
    var badge = document.getElementById('volunteer-verification-badge');
    var textEl = document.getElementById('volunteer-verification-text');
    var noteBox = document.getElementById('volunteer-note-box');
    var noteInput = document.getElementById('volunteer-note-input');
    var profile = SafeHer.api ? SafeHer.api.getVolunteerProfile() : {};

    if (!badge || !textEl) return;

    if (status === 'approved') {
      badge.style.display = 'inline-flex';
      badge.className = 'volunteer-badge-approved';
      badge.innerHTML = '<span class="material-symbols-rounded" style="font-size:14px;">verified</span> Approved Volunteer';
      if (noteBox) noteBox.style.display = 'none';
    } else {
      // Default: Pending approval
      badge.style.display = 'inline-flex';
      badge.className = 'volunteer-badge-pending';
      badge.innerHTML = '<span class="material-symbols-rounded" style="font-size:14px;">hourglass_top</span> Pending approval';
      if (noteBox) {
        noteBox.style.display = 'block';
        if (noteInput && profile.note) noteInput.value = profile.note;
      }
    }
  }

  function saveNote() {
    var noteInput = document.getElementById('volunteer-note-input');
    var note = noteInput ? noteInput.value.trim() : '';
    if (!note) {
      SafeHer.toast('Please enter a note for verification');
      return;
    }

    var profile = SafeHer.api ? SafeHer.api.getVolunteerProfile() : {};
    profile.note = note;

    if (SafeHer.api && SafeHer.api.setVolunteerProfile) {
      SafeHer.api.setVolunteerProfile(profile, function(err, saved) {
        if (!err) {
          SafeHer.toast('Note submitted. Status: Pending approval');
          renderVerificationBadge((saved && saved.status) || 'pending');
        } else {
          SafeHer.toast('Failed to save note');
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
      startPolling();
    } else {
      if (descEl) descEl.textContent = 'Turn on to receive emergency alerts near you.';
      if (posRow) posRow.style.display = 'none';
      stopPolling();
      hideAlertCard();
    }

    // Render verification state
    renderVerificationBadge(profile.status || 'pending');

    // Trigger volunteer 5-step wizard or status screen
    if (SafeHer.volunteerApply && SafeHer.volunteerApply.initOrRender) {
      SafeHer.volunteerApply.initOrRender();
    }

    // Query backend for latest profile status
    if (SafeHer.api && SafeHer.api.getVolunteerServerProfile) {
      SafeHer.api.getVolunteerServerProfile(function(err, serverProf) {
        if (!err && serverProf) {
          renderVerificationBadge(serverProf.status || 'pending');
        }
      });
    }
  }

  function init() {
    SafeHer.router.onShow('volunteers', function() {
      render();
    });

    SafeHer.router.onShow('home', function() {
      stopPolling();
      updateHomeVolunteerCount();
    });
  }

  return {
    init: init,
    render: render,
    toggleAvailable: toggleAvailable,
    respondComing: respondComing,
    respondCantHelp: respondCantHelp,
    saveNote: saveNote,
    startPolling: startPolling,
    stopPolling: stopPolling
  };
})();
