// js/volunteer.js – Community Volunteers, verification state, 5s polling, and response dispatch



SafeHer.volunteer = (function() {

  var dismissedAlertId = null;

  var respondedAlertId = null;

  var currentAlertId = null;

  var currentVerificationCode = null;

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



  function formatDistanceBand(distKm, distanceBand) {

    if (distanceBand) return distanceBand;

    if (distKm === undefined || distKm === null) return 'Nearby';

    if (distKm < 0.5) return 'under 500m';

    if (distKm < 1.3) return 'about 1 km';

    if (distKm < 1.7) return 'about 1.5 km';

    return 'about 2 km';

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



        showAlertCardData(firstAlert);
        showGlobalBanner(firstAlert);
      } else {
        hideAlertCard();
        hideGlobalBanner();
      }

    });

  }




  // --- Global In-App Alert Banner for Available Volunteers ---
  function showGlobalBanner(alertData) {
    var cur = (SafeHer.router && SafeHer.router.getCurrentScreen) ? SafeHer.router.getCurrentScreen() : '';
    if (cur === 'volunteers') {
      hideGlobalBanner();
      return;
    }
    var banner = document.getElementById('global-volunteer-sos-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'global-volunteer-sos-banner';
      banner.style.cssText = 'position:fixed;top:10px;left:12px;right:12px;background:#B91C1C;color:#FFFFFF;padding:12px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.35);z-index:999999;display:flex;align-items:center;justify-content:space-between;gap:10px;';
      document.body.appendChild(banner);
    }
    var dist = formatDistanceBand(alertData.distance_km, alertData.distance_band);
    banner.innerHTML = '<div style="display:flex;align-items:center;gap:10px;flex:1;">' +
      '<span class="material-symbols-rounded" style="font-size:24px;color:#FEE2E2;">emergency</span>' +
      '<div>' +
        '<strong style="display:block;font-size:13px;letter-spacing:0.5px;">🚨 EMERGENCY SOS NEARBY (' + escapeHtml(dist) + ')</strong>' +
        '<span style="font-size:11px;color:#FECACA;">A user needs assistance. Tap to view location & respond.</span>' +
      '</div>' +
    '</div>' +
    '<button type="button" onclick="SafeHer.volunteer.openAlertFromBanner()" style="background:#FFFFFF;color:#B91C1C;font-weight:700;font-size:12px;padding:8px 14px;border:none;border-radius:6px;cursor:pointer;white-space:nowrap;">Respond</button>';
    banner.style.display = 'flex';
    if (navigator.vibrate) {
      try { navigator.vibrate([200, 100, 200, 100, 400]); } catch(e) {}
    }
  }

  function hideGlobalBanner() {
    var banner = document.getElementById('global-volunteer-sos-banner');
    if (banner) banner.style.display = 'none';
  }

  function openAlertFromBanner() {
    hideGlobalBanner();
    SafeHer.router.go('volunteers');
  }

  // ─── Save & Toggle Availability ───────────────────────────

  function toggleAvailable(isAvailable) {

    var profile = SafeHer.api ? SafeHer.api.getVolunteerProfile() : {};

    var status = profile.status || 'draft';

    if (status === 'suspended') {
      var toggle = document.getElementById('volunteer-available-toggle');
      if (toggle) toggle.checked = false;
      SafeHer.toast('Your account is paused while we review a report');
      return;
    }

    if (status !== 'approved') {
      var toggle = document.getElementById('volunteer-available-toggle');
      if (toggle) toggle.checked = false;
      SafeHer.toast('Approval required: Submit your application and wait for admin approval.');
      return;
    }



    var descEl = document.getElementById('volunteer-status-desc');

    var posRow = document.getElementById('volunteer-pos-row');

    var posText = document.getElementById('volunteer-pos-text');



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

              renderProfileCard(profile);

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



  function showAlertCardData(alertData) {

    var card = document.getElementById('volunteer-alert-card');

    var timeEl = document.getElementById('volunteer-alert-time');

    var distEl = document.getElementById('volunteer-alert-dist-text');

    var approxAreaEl = document.getElementById('volunteer-alert-approx-area');

    var silentWarningEl = document.getElementById('volunteer-alert-silent-warning');

    var actionsGroup = document.getElementById('volunteer-alert-actions');

    var confirmedContainer = document.getElementById('volunteer-confirmed-coming-container');

    var mapLink = document.getElementById('volunteer-alert-map-link');

    var codeDisplay = document.getElementById('volunteer-verification-code-display');



    var alertId = alertData.alert_id || alertData.id;

    currentAlertId = alertId;



    if (timeEl) timeEl.textContent = alertData.time || alertData.started_at || 'Active now';



    // (3) Distance band and approximate area first

    var bandText = formatDistanceBand(alertData.distance_km, alertData.distance_band);

    if (distEl) distEl.textContent = bandText;



    if (approxAreaEl) {

      if (alertData.approximate_area) {

        approxAreaEl.textContent = alertData.approximate_area;

      } else if (alertData.approximate_lat && alertData.approximate_lng) {

        approxAreaEl.textContent = 'Approximate area: ~' + alertData.approximate_lat + ', ' + alertData.approximate_lng;

      } else {

        approxAreaEl.textContent = 'Approximate area (exact location hidden until you confirm)';

      }

    }



    // (4) Silent-mode alerts appear only for Trusted volunteers and carry extra warning

    if (silentWarningEl) {

      if (alertData.mode === 'silent') {

        silentWarningEl.style.display = 'block';

      } else {

        silentWarningEl.style.display = 'none';

      }

    }



    // Has volunteer already responded "coming"?

    var hasRespondedComing = (alertData.responded === true) || (respondedAlertId === alertId);



    if (hasRespondedComing) {

      if (actionsGroup) actionsGroup.style.display = 'none';

      if (confirmedContainer) confirmedContainer.style.display = 'block';



      var destLat = alertData.lat;

      var destLng = alertData.lng;

      var mapsHref = alertData.maps_link || (destLat && destLng ? ('https://www.google.com/maps/dir/?api=1&destination=' + destLat + ',' + destLng) : '#');

      if (mapLink) {

        mapLink.href = mapsHref;

        mapLink.target = '_blank';

      }



      var code = alertData.verification_code || currentVerificationCode || '----';

      if (codeDisplay) codeDisplay.textContent = code;

    } else {

      if (actionsGroup) actionsGroup.style.display = 'flex';

      if (confirmedContainer) confirmedContainer.style.display = 'none';

    }



    if (card) card.style.display = 'block';

  }



  // ─── Volunteer Response: "I'm coming" confirmation modal ──

  function promptSafeConfirm() {

    var modal = document.getElementById('volunteer-safe-modal');

    if (modal) {

      modal.style.display = 'flex';

    } else {

      confirmSafeComing();

    }

  }



  function cancelSafeConfirm() {

    var modal = document.getElementById('volunteer-safe-modal');

    if (modal) modal.style.display = 'none';

  }



  function confirmSafeComing() {

    cancelSafeConfirm();



    var alertId = currentAlertId;

    if (!alertId) {

      SafeHer.toast('No active alert selected');

      return;

    }



    respondedAlertId = alertId;



    if (SafeHer.api && SafeHer.api.respondToAlert) {

      SafeHer.api.respondToAlert(alertId, 'coming', function(err, data) {

        if (err) {

          SafeHer.toast(err);

          return;

        }



        if (data && data.verification_code) {

          currentVerificationCode = data.verification_code;

        }



        // Re-poll nearby alerts immediately to get exact coordinates and directions link

        if (SafeHer.api.getNearbyAlerts) {

          SafeHer.api.getNearbyAlerts(function(pErr, alerts) {

            if (!pErr && alerts && alerts.length > 0) {

              var matching = alerts.find(function(a) { return (a.id || a.alert_id) === alertId; }) || alerts[0];

              matching.responded = true;

              if (currentVerificationCode && !matching.verification_code) {

                matching.verification_code = currentVerificationCode;

              }

              showAlertCardData(matching);

            }

          });

        }

      });

    }



    // Update UI to reveal code and directions

    var actionsGroup = document.getElementById('volunteer-alert-actions');

    var confirmedContainer = document.getElementById('volunteer-confirmed-coming-container');

    if (actionsGroup) actionsGroup.style.display = 'none';

    if (confirmedContainer) confirmedContainer.style.display = 'block';



    SafeHer.toast('Confirmed: You are on the way. Check your 4-digit code.');

  }



  // ─── Volunteer Response: "Can't continue" ─────────────────

  function respondCantContinue() {

    var alertId = currentAlertId || respondedAlertId;

    if (alertId) {

      dismissedAlertId = alertId;

      respondedAlertId = null;

      currentVerificationCode = null;



      if (SafeHer.api && SafeHer.api.respondToAlert) {

        SafeHer.api.respondToAlert(alertId, 'cannot', function(err) {

          if (!err) {

            SafeHer.toast('Response updated: You cannot continue');

          }

        });

      }

    }



    hideAlertCard();

    SafeHer.toast('Response updated: You cannot continue');

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
    var subEl = document.getElementById('home-volunteers-sub');
    if (!countEl) return;

    // 1. Instant 0ms cache rendering
    try {
      var cached = localStorage.getItem('safeher_volunteers_count');
      var localProf = SafeHer.api ? SafeHer.api.getVolunteerProfile() : null;
      if (cached !== null) {
        countEl.textContent = String(cached);
        if (subEl) {
          var cn = Number(cached);
          subEl.textContent = cn > 0 ? (cn === 1 ? '1 nearby & ready' : cn + ' nearby & ready') : 'Tap to become one';
        }
      } else if (localProf && localProf.isAvailable && localProf.status === 'approved') {
        countEl.textContent = '1';
        if (subEl) subEl.textContent = '1 nearby & ready';
      }
    } catch(e) {}

    // 2. Immediate asynchronous query using last known location without waiting
    var loc = (SafeHer.api && SafeHer.api.getLiveLocation) ? SafeHer.api.getLiveLocation() : null;
    if (!loc && SafeHer.storage && SafeHer.storage.get) {
      loc = SafeHer.storage.get('last_location');
    }

    fetchWithCoords(loc);

    function fetchWithCoords(coords) {
      if (SafeHer.api && SafeHer.api.getAvailableVolunteersCount) {
        SafeHer.api.getAvailableVolunteersCount(function(err, count) {
          if (!err && count !== undefined && count !== null && countEl) {
            countEl.textContent = String(count);
            try { localStorage.setItem('safeher_volunteers_count', String(count)); } catch(e) {}
            if (subEl) {
              subEl.textContent = count > 0 ? (count === 1 ? '1 nearby & ready' : count + ' nearby & ready') : 'Tap to become one';
            }
          }
        }, coords);
      }
    }
  }



  // ─── Render Volunteer Badge & Verification Card ───────────

  function renderProfileCard(profile) {

    var status = profile.status || 'draft';

    var level = profile.level || 'provisional';

    var badge = profile.badge || (level === 'trusted' ? 'Trusted' : 'Provisional');

    var completed = profile.completed_responses || 0;

    var validUntil = profile.valid_until;



    // 1. Suspended banner

    var suspendedBox = document.getElementById('volunteer-suspended-box');

    var toggle = document.getElementById('volunteer-available-toggle');



    if (status === 'suspended') {

      if (suspendedBox) suspendedBox.style.display = 'block';

      if (toggle) {

        toggle.checked = false;

        toggle.disabled = true;

      }

      var descEl = document.getElementById('volunteer-status-desc');

      if (descEl) descEl.textContent = 'Your account is paused while we review a report.';

    } else {

      if (suspendedBox) suspendedBox.style.display = 'none';

      if (toggle) {
        toggle.disabled = (status !== 'approved');
      }

    }



    // 2. Badge & Status pill

    var levelBadge = document.getElementById('volunteer-level-badge');

    var levelText = document.getElementById('volunteer-level-text');

    var statusPill = document.getElementById('volunteer-status-pill');

    var completedEl = document.getElementById('volunteer-completed-responses');

    var explanationEl = document.getElementById('volunteer-level-explanation');

    var expiryTextEl = document.getElementById('volunteer-expiry-text');

    var reverifyBtn = document.getElementById('volunteer-reverify-btn');



    if (levelText) levelText.textContent = badge;

    if (levelBadge) {

      if (badge === 'Trusted') {

        levelBadge.style.background = '#E8F5E9';

        levelBadge.style.color = '#2E7D32';

        levelBadge.style.borderColor = '#A5D6A7';

      } else {

        levelBadge.style.background = '#FCEFF3';

        levelBadge.style.color = 'var(--crimson)';

        levelBadge.style.borderColor = 'var(--crimson)';

      }

    }



    if (statusPill) {

      var displayStatus = status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ');

      statusPill.textContent = 'Status: ' + displayStatus;

      if (status === 'approved') {

        statusPill.style.background = '#E8F5E9';

        statusPill.style.color = '#2E7D32';

      } else if (status === 'suspended' || status === 'rejected') {

        statusPill.style.background = '#FFEBEE';

        statusPill.style.color = '#C62828';

      } else {

        statusPill.style.background = '#F0F0F0';

        statusPill.style.color = '#555';

      }

    }



    if (completedEl) {

      completedEl.textContent = completed + ' response' + (completed === 1 ? '' : 's');

    }



    if (explanationEl) {

      explanationEl.textContent = 'Provisional volunteers see an approximate location first. You become Trusted after 3 good responses and 30 days.';

    }



    // Expiration date and Re-verify prompt 30 days before

    if (expiryTextEl) {

      if (validUntil) {

        var dateOnly = String(validUntil).split(' ')[0];

        expiryTextEl.textContent = 'Verification valid until: ' + dateOnly;



        try {

          var expDate = new Date(validUntil.replace(' ', 'T'));

          var now = new Date();

          var diffDays = (expDate - now) / (1000 * 60 * 60 * 24);



          // If within 30 days of expiration or already expired, show "Re-verify" prompt

          if (reverifyBtn) {

            if (diffDays <= 30) {

              reverifyBtn.style.display = 'inline-block';

              reverifyBtn.textContent = diffDays <= 0 ? 'Expired - Re-verify' : 'Re-verify';

            } else {

              reverifyBtn.style.display = 'none';

            }

          }

        } catch (e) {

          if (reverifyBtn) reverifyBtn.style.display = 'none';

        }

      } else {

        expiryTextEl.textContent = status === 'approved' ? 'Verification active' : 'Verification pending';

        if (reverifyBtn) reverifyBtn.style.display = 'none';

      }

    }



    // Admin approval explainer banner

    var approvalBanner = document.getElementById('volunteer-admin-approval-banner');

    if (approvalBanner) {

      if (status !== 'approved' && status !== 'suspended') {

        approvalBanner.style.display = 'block';

      } else {

        approvalBanner.style.display = 'none';

      }

    }

  }



  function demoApproveSelf() {

    var prof = (SafeHer.api && SafeHer.api.getVolunteerProfile) ? SafeHer.api.getVolunteerProfile() : {};

    prof.status = 'approved';

    prof.level = prof.level || 'provisional';

    prof.badge = 'Provisional';

    prof.valid_until = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().split('T')[0];



    if (SafeHer.api && SafeHer.api.setVolunteerProfile) {

      SafeHer.api.setVolunteerProfile(prof);

    }



    if (SafeHer.api && SafeHer.api.apiFetch) {

      SafeHer.api.apiFetch('/api/volunteers/status', {

        method: 'POST',

        headers: { 'Content-Type': 'application/json' },

        body: JSON.stringify({ auto_approve: true, available: false }),

        _silent: true

      }).catch(function() {});



      SafeHer.api.apiFetch('/api/admin/volunteers/approve-all', {

        method: 'POST',

        headers: {

          'Content-Type': 'application/json',

          'X-Admin-Key': 'safeher-admin-secret-key-123'

        },

        _silent: true

      }).catch(function() {});

    }



    renderProfileCard(prof);

    var toggle = document.getElementById('volunteer-available-toggle');

    if (toggle) toggle.disabled = false;

    var descEl = document.getElementById('volunteer-status-desc');

    if (descEl) descEl.textContent = 'Turn on to receive emergency alerts near you.';



    if (SafeHer.toast) {

      SafeHer.toast('Volunteer approved! You can now turn on Available to help.');

    }

  }



  function reverify() {

    if (SafeHer.volunteerApply && SafeHer.volunteerApply.initOrRender) {

      SafeHer.volunteerApply.initOrRender();

    }

    SafeHer.toast('Please review and re-submit your verification details');

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

          renderProfileCard(saved || profile);

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

    if (toggle) {

      toggle.checked = isAvail;

      // Switch works when active

      toggle.disabled = (profile.status === 'suspended');

    }



    if (isAvail && profile.status === 'approved') {

      if (descEl) descEl.textContent = 'You are available to help nearby users in distress.';

      if (posRow) posRow.style.display = 'flex';

      if (posText && profile.lat && profile.lng) {

        posText.textContent = 'GPS active: ' + profile.lat.toFixed(4) + ', ' + profile.lng.toFixed(4);

      }

      startPolling();

    } else {

      if (descEl) {

        if (profile.status === 'suspended') {
          descEl.textContent = 'Your account is paused while we review a report.';
        } else if (profile.status !== 'approved') {
          descEl.textContent = 'Available to help unlocks once your application is approved by Admin.';
        } else {
          descEl.textContent = 'Turn on to receive emergency alerts near you.';
        }

      }

      if (posRow) posRow.style.display = 'none';

      stopPolling();

      hideAlertCard();

    }



    // Render verification state & badge

    renderProfileCard(profile);



    // Trigger volunteer 5-step wizard or status screen

    if (SafeHer.volunteerApply && SafeHer.volunteerApply.initOrRender) {

      SafeHer.volunteerApply.initOrRender();

    }



    // Query backend for latest profile status

    if (SafeHer.api && SafeHer.api.getVolunteerServerProfile) {

      SafeHer.api.getVolunteerServerProfile(function(err, serverProf) {

        if (!err && serverProf) {

          renderProfileCard(serverProf);

          if (toggle) {

            toggle.disabled = (serverProf.status === 'suspended');

            if (serverProf.status === 'suspended') toggle.checked = false;

          }

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

    promptSafeConfirm: promptSafeConfirm,

    cancelSafeConfirm: cancelSafeConfirm,

    confirmSafeComing: confirmSafeComing,

    respondComing: promptSafeConfirm,
    respondCantContinue: respondCantContinue,
    openAlertFromBanner: openAlertFromBanner,

    respondCantHelp: respondCantHelp,

    demoApproveSelf: demoApproveSelf,

    reverify: reverify,

    saveNote: saveNote,

    startPolling: startPolling,

    stopPolling: stopPolling

  };

})();

