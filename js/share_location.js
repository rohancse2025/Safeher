// js/share_location.js – Share Location screen with contacts selection, duration picker, live map, WhatsApp/SMS/WebShare integration, and localStorage persistence

SafeHer.shareLocation = (function() {
  var STORAGE_KEY = 'safeher_share_session';
  var selectedDuration = '1h'; // '15m' | '1h' | '4h' | 'stop'
  var selectedContactIds = [];
  var positionInterval = null;
  var countdownInterval = null;
  var mapInstance = null;
  var markerInstance = null;
  var currentLat = 12.9716;
  var currentLng = 77.5946;

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getDurationMs(key) {
    switch(key) {
      case '15m': return 15 * 60 * 1000;
      case '1h':  return 60 * 60 * 1000;
      case '4h':  return 4 * 60 * 60 * 1000;
      case 'stop': return null;
      default: return 60 * 60 * 1000;
    }
  }

  function getActiveSession() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return (parsed && parsed.active) ? parsed : null;
    } catch(e) {
      return null;
    }
  }

  function saveActiveSession(session) {
    try {
      if (session) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch(e) {}
  }

  // ─── Home Banner Synchronizer ─────────────────────────────
  function updateHomeBanner() {
    var banner = document.getElementById('home-sharing-banner');
    var textEl = document.getElementById('home-sharing-banner-text');
    if (!banner || !textEl) return;

    var session = getActiveSession();
    if (session && session.active) {
      // Check if session expired
      if (session.endTime && Date.now() >= session.endTime) {
        stopSharing(true);
        return;
      }
      var msg = (session.endTime === null)
        ? 'Sharing location until you stop'
        : ('Sharing location until ' + session.endTimeStr);
      textEl.textContent = msg;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  // ─── Render Setup View ────────────────────────────────────
  function renderSetupView() {
    var activeView = document.getElementById('share-active-view');
    var setupView = document.getElementById('share-setup-view');
    if (activeView) activeView.style.display = 'none';
    if (setupView) setupView.style.display = 'block';

    // Duration chips
    var chips = document.querySelectorAll('.share-duration-chip');
    chips.forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.duration === selectedDuration);
    });

    // Contacts checkboxes list
    var contacts = (SafeHer.api && SafeHer.api.getContacts ? SafeHer.api.getContacts() : []) || [];
    if ((!contacts || contacts.length === 0) && SafeHer.storage && SafeHer.storage.get) {
      contacts = SafeHer.storage.get('contacts') || [];
    }
    var listEl = document.getElementById('share-setup-contacts-list');
    if (!listEl) return;

    if (contacts.length === 0) {
      listEl.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-gray); font-size: 13px;">' +
        '<p style="margin: 0 0 10px;">No saved emergency contacts found.</p>' +
        '<button type="button" class="btn btn-secondary" onclick="SafeHer.router.go(\'contacts\')" style="padding: 8px 14px; font-size: 13px;">' +
          '<span class="material-symbols-rounded" style="font-size: 16px;">person_add</span>Add Contacts' +
        '</button>' +
      '</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      var isChecked = selectedContactIds.length === 0 || selectedContactIds.indexOf(c.id) !== -1;
      var initial = (c.name || '?').charAt(0).toUpperCase();

      html += '<div class="share-setup-contact-item">' +
        '<label class="share-contact-check-label" for="share-contact-' + c.id + '">' +
          '<input type="checkbox" id="share-contact-' + c.id + '" class="share-contact-checkbox" value="' + c.id + '" ' + (isChecked ? 'checked' : '') + ' onchange="SafeHer.shareLocation.onContactToggle(\'' + escapeHtml(c.id || c.phone) + '\', this.checked)" />' +
          '<div class="share-contact-avatar">' + escapeHtml(initial) + '</div>' +
          '<div class="share-contact-info">' +
            '<span class="share-contact-name">' + escapeHtml(c.name) + '</span>' +
            '<span class="share-contact-phone">' + escapeHtml(c.phone || '') + '</span>' +
          '</div>' +
        '</label>' +
      '</div>';
    }
    listEl.innerHTML = html;

    // Default select all if first time
    if (selectedContactIds.length === 0) {
      selectedContactIds = contacts.map(function(c) { return c.id; });
    }
  }

  // ─── Render Active Sharing View ───────────────────────────
  function updateLiveLinkDisplay(session) {
    var urlEl = document.getElementById('share-live-link-url');
    if (!urlEl) return;
    var trackUrl = (session && session.trackUrl) ? session.trackUrl : (window.location.origin + '/track.html');
    urlEl.textContent = trackUrl;
  }

  function copyLiveLink() {
    var session = getActiveSession();
    var trackUrl = (session && session.trackUrl) ? session.trackUrl : (window.location.origin + '/track.html');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(trackUrl).then(function() {
        SafeHer.toast('Tracking link copied to clipboard!');
      }).catch(function() {
        window.prompt('Copy tracking link:', trackUrl);
      });
    } else {
      window.prompt('Copy tracking link:', trackUrl);
    }
  }

  function renderActiveView(session) {
    var activeView = document.getElementById('share-active-view');
    var setupView = document.getElementById('share-setup-view');
    if (setupView) setupView.style.display = 'none';
    if (activeView) activeView.style.display = 'block';

    updateActiveTimeDisplay(session);
    updateCoordsDisplay(session.lat, session.lng);
    updateLiveLinkDisplay(session);
    renderActiveContactsList(session);
    initMap(session.lat, session.lng);
  }

  function updateActiveTimeDisplay(session) {
    var el = document.getElementById('share-time-left');
    if (!el) return;

    if (!session || session.endTime === null) {
      el.textContent = 'Sharing active until you stop';
      return;
    }

    var diff = session.endTime - Date.now();
    if (diff <= 0) {
      stopSharing(true);
      return;
    }

    var mins = Math.floor(diff / 60000);
    var hours = Math.floor(mins / 60);
    var remMins = mins % 60;

    var remStr = '';
    if (hours > 0) {
      remStr = hours + 'h ' + remMins + 'm left';
    } else {
      var secs = Math.floor((diff % 60000) / 1000);
      remStr = mins + 'm ' + secs + 's left';
    }

    el.textContent = remStr + ' (until ' + session.endTimeStr + ')';
  }

  function updateCoordsDisplay(lat, lng) {
    var coordsEl = document.getElementById('share-active-coords');
    if (coordsEl) {
      coordsEl.textContent = 'GPS: ' + lat.toFixed(5) + ', ' + lng.toFixed(5);
    }
  }

  // ─── Active Contacts Sharing Buttons ──────────────────────
  function renderActiveContactsList(session) {
    var listEl = document.getElementById('share-active-contacts-list');
    if (!listEl) return;

    var allContacts = (SafeHer.api && SafeHer.api.getContacts ? SafeHer.api.getContacts() : []) || [];
    var selectedContacts = allContacts.filter(function(c) {
      return !session.contactIds || session.contactIds.length === 0 || session.contactIds.indexOf(c.id) !== -1;
    });

    if (selectedContacts.length === 0) {
      selectedContacts = allContacts;
    }

    var message = buildShareMessage(session.lat, session.lng, session.endTime, session.endTimeStr);
    var encodedMsg = encodeURIComponent(message);

    var html = '';
    for (var i = 0; i < selectedContacts.length; i++) {
      var c = selectedContacts[i];
      var rawPhone = (c.phone || '').replace(/\D/g, '');
      var waPhone = rawPhone.length === 10 ? ('91' + rawPhone) : rawPhone;
      var waUrl = 'https://wa.me/' + waPhone + '?text=' + encodedMsg;
      var smsUrl = 'sms:' + rawPhone + '?body=' + encodedMsg;
      var initial = (c.name || '?').charAt(0).toUpperCase();

      html += '<div class="share-active-contact-item">' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<div class="share-contact-avatar">' + escapeHtml(initial) + '</div>' +
          '<div class="share-contact-info">' +
            '<span class="share-contact-name">' + escapeHtml(c.name) + '</span>' +
            '<span class="share-contact-phone">' + escapeHtml(c.phone || '') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="share-contact-actions" style="display:flex;align-items:center;gap:6px;">' +
          '<span style="background:#E8F5E9;color:#2E7D32;padding:4px 8px;border-radius:12px;font-size:10px;font-weight:700;display:inline-flex;align-items:center;gap:3px;"><span class="material-symbols-rounded" style="font-size:12px;">check_circle</span> Dispatched</span>' +
          '<a href="' + escapeHtml(waUrl) + '" target="_blank" rel="noopener noreferrer" class="btn-share-action btn-share-wa" style="padding:4px 8px;font-size:11px;" aria-label="Chat via WhatsApp with ' + escapeHtml(c.name) + '">Chat</a>' +
        '</div>' +
      '</div>';
    }
    listEl.innerHTML = html;
  }

  // ─── Build Message ────────────────────────────────────────
  function buildShareMessage(lat, lng, endTime, endTimeStr) {
    var user = (SafeHer.api && SafeHer.api.getUser ? SafeHer.api.getUser() : null);
    var userName = (user && (user.name || user.full_name)) ? (user.name || user.full_name) : 'SafeHer User';
    var session = getActiveSession();
    var frontendBase = (window.SafeHerConfig && window.SafeHerConfig.FRONTEND_URL) || 'https://rohancse2025.github.io/Safeher';
    var trackLink = (session && session.trackUrl) ? session.trackUrl : (frontendBase.replace(/\/+$/, '') + '/track.html');
    var mapsLink = 'https://www.google.com/maps?q=' + lat + ',' + lng;
    var endDesc = (endTime === null) ? 'until I stop' : ('until ' + endTimeStr);

    var sep = trackLink.indexOf('?') !== -1 ? '&' : '?';
    var watchLink = trackLink + sep + 'action=watching';
    var callLink = trackLink + sep + 'action=called';
    var safeLink = trackLink + sep + 'action=safe_with_me';

    return '📍 *SafeHer Live Location Sharing*\n\n' +
      '*' + userName + '* is sharing their live location with you ' + endDesc + '.\n\n' +
      '🗺️ *Live Tracking Map & Status*:\n' + trackLink + '\n\n' +
      '💬 *Tap to Respond to ' + userName + ' Instantly:*\n' +
      '👀 *I\'m Watching*: ' + watchLink + '\n' +
      '📞 *I Called Her*: ' + callLink + '\n' +
      '✅ *Safe With Me*: ' + safeLink + '\n\n' +
      '📍 *Google Maps Pin*:\n' + mapsLink;
  }

  function shareViaWhatsApp() {
    var session = getActiveSession();
    var lat = session ? session.lat : (currentLat || 12.9716);
    var lng = session ? session.lng : (currentLng || 77.5946);
    var endTime = session ? session.endTime : null;
    var endTimeStr = session ? session.endTimeStr : 'until I stop';

    var message = buildShareMessage(lat, lng, endTime, endTimeStr);

    var targetPhone = '';
    var contacts = (SafeHer.api && SafeHer.api.getContacts) ? SafeHer.api.getContacts() : [];
    if (session && session.contactIds && session.contactIds.length > 0) {
      for (var i = 0; i < contacts.length; i++) {
        if (session.contactIds.indexOf(contacts[i].id) !== -1 && contacts[i].phone) {
          targetPhone = contacts[i].phone.replace(/\D/g, '');
          break;
        }
      }
    }
    if (!targetPhone && contacts.length > 0 && contacts[0].phone) {
      targetPhone = contacts[0].phone.replace(/\D/g, '');
    }
    if (targetPhone.length === 10) targetPhone = '91' + targetPhone;

    var waUrl = targetPhone
      ? ('https://wa.me/' + targetPhone + '?text=' + encodeURIComponent(message))
      : ('https://api.whatsapp.com/send?text=' + encodeURIComponent(message));

    try {
      window.location.href = waUrl;
    } catch(e) {
      window.open(waUrl, '_blank');
    }
  }

  // ─── Leaflet Map Management ───────────────────────────────
  function initMap(lat, lng) {
    var container = document.getElementById('share-live-map');
    if (!container || typeof L === 'undefined') return;

    if (!mapInstance) {
      mapInstance = L.map('share-live-map', {
        zoomControl: false,
        attributionControl: false,
        maxZoom: 18
      }).setView([lat, lng], 15);

      L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=en&gl=in&x={x}&y={y}&z={z}', {
        maxZoom: 18,
        maxNativeZoom: 18,
        errorTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        subdomains: ['0', '1', '2', '3']
      }).addTo(mapInstance);

      var icon = L.divIcon({
        className: 'custom-share-marker',
        html: '<div style="width:16px;height:16px;background:#A80F3C;border:2.5px solid #FFFFFF;border-radius:50%;box-shadow:0 0 0 5px rgba(168,15,60,0.35);"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });

      markerInstance = L.marker([lat, lng], { icon: icon }).addTo(mapInstance);
    } else {
      mapInstance.setView([lat, lng], 15);
      if (markerInstance) {
        markerInstance.setLatLng([lat, lng]);
      }
    }

    setTimeout(function() {
      if (mapInstance) mapInstance.invalidateSize();
    }, 250);
  }

  // ─── Position Watcher (every 10s) ─────────────────────────
  function startTrackingLoop() {
    clearInterval(positionInterval);
    clearInterval(countdownInterval);

    // 1-second countdown display update
    countdownInterval = setInterval(function() {
      var session = getActiveSession();
      if (!session) {
        clearInterval(countdownInterval);
        return;
      }
      if (session.endTime && Date.now() >= session.endTime) {
        stopSharing(true);
      } else {
        updateActiveTimeDisplay(session);
      }
    }, 1000);

    // 10-second position update
    positionInterval = setInterval(function() {
      checkContactResponses();
      if (!navigator.geolocation) return;

      navigator.geolocation.getCurrentPosition(
        function(pos) {
          currentLat = pos.coords.latitude;
          currentLng = pos.coords.longitude;

          var session = getActiveSession();
          if (session) {
            session.lat = currentLat;
            session.lng = currentLng;
            session.lastUpdated = Date.now();
            saveActiveSession(session);

            updateCoordsDisplay(currentLat, currentLng);
            if (mapInstance && markerInstance) {
              markerInstance.setLatLng([currentLat, currentLng]);
              mapInstance.panTo([currentLat, currentLng]);
            }
            if (session.shareId && SafeHer.api && SafeHer.api.updateSharePosition) {
              SafeHer.api.updateSharePosition(session.shareId, currentLat, currentLng);
            }
          }
        },
        function() {
          // Keep current fallback on location glitch
        },
        { timeout: 7000, enableHighAccuracy: true }
      );
    }, 5000);
  }

  // ─── Contact Responses Tracking ────────────────────────────
  var receivedResponses = [];

  function checkContactResponses() {
    var session = getActiveSession();
    if (!session || !session.active) return;

    try {
      var raw = localStorage.getItem('safeher_response_update');
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.status && (Date.now() - parsed.time < 3600000)) {
          addResponseItem(parsed);
        }
      }
    } catch(e) {}

    var apiBase = (window.SafeHerConfig && window.SafeHerConfig.API_BASE) ? window.SafeHerConfig.API_BASE.replace(/\/+$/, '') : '';
    if (apiBase) {
      var authTok = (SafeHer.auth && SafeHer.auth.getToken) ? SafeHer.auth.getToken() : localStorage.getItem('safeher_token');
      var authHeaders = { 'Content-Type': 'application/json' };
      if (authTok) authHeaders['Authorization'] = 'Bearer ' + authTok;

      fetch(apiBase + '/api/shares/active', { headers: authHeaders })
        .then(function(res) { return res.json(); })
        .then(function(json) {
          if (json && json.ok && json.data && json.data.contact_responses) {
            json.data.contact_responses.forEach(function(r) {
              addResponseItem(r);
            });
          }
        })
        .catch(function() {});

      if (session.shareToken) {
        fetch(apiBase + '/api/track/' + encodeURIComponent(session.shareToken))
          .then(function(res) { return res.json(); })
          .then(function(json) {
            if (json && json.ok && json.data && json.data.contact_responses) {
              json.data.contact_responses.forEach(function(r) {
                addResponseItem(r);
              });
            }
          })
          .catch(function() {});
      }
    }
  }

  function addResponseItem(resp) {
    var exists = false;
    var respTime = resp.time || resp.timestamp || Date.now();
    for (var i = 0; i < receivedResponses.length; i++) {
      if (receivedResponses[i].status === resp.status && Math.abs(receivedResponses[i].time - respTime) < 5000) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      receivedResponses.unshift({
        name: resp.name || resp.contact || 'Emergency Contact',
        status: resp.status,
        time: respTime
      });
      renderContactResponses();

      var statusLabels = {
        'watching': '👀 Watching your live trip',
        'called': '📞 Called you',
        'on_my_way': '🏃 On the way to you',
        'safe_with_me': '✅ Safe with me / Reached',
        'alerted_police': '🚓 Alerted police'
      };
      var sText = statusLabels[resp.status] || resp.status;
      if (SafeHer.toast) {
        SafeHer.toast('🔔 ' + (resp.name || 'Contact') + ': ' + sText);
      }
      if (navigator.vibrate) {
        navigator.vibrate([150, 100, 150]);
      }
    }
  }

  function renderContactResponses() {
    var card = document.getElementById('share-contact-responses-card');
    var list = document.getElementById('share-contact-responses-list');
    var badge = document.getElementById('share-responses-count-badge');
    if (!card || !list) return;

    if (receivedResponses.length === 0) {
      card.style.display = 'none';
      return;
    }

    card.style.display = 'block';
    if (badge) badge.textContent = receivedResponses.length + (receivedResponses.length === 1 ? ' response' : ' responses');

    var statusLabels = {
      'watching': '👀 Watching your live trip',
      'called': '📞 Called you',
      'on_my_way': '🏃 On the way to you',
      'safe_with_me': '✅ Safe with me / Reached',
      'alerted_police': '🚓 Alerted police',
      'cannot_reach': '⚠️ Cannot reach'
    };

    var html = '';
    for (var i = 0; i < receivedResponses.length; i++) {
      var r = receivedResponses[i];
      var label = statusLabels[r.status] || r.status;
      var timeStr = new Date(r.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      html += '<div style="display:flex;align-items:center;justify-content:space-between;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:8px 10px;">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<div style="width:28px;height:28px;border-radius:50%;background:#DCFCE7;color:#15803D;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:12px;">' +
            escapeHtml((r.name.charAt(0) || 'C').toUpperCase()) +
          '</div>' +
          '<div>' +
            '<div style="font-size:12px;font-weight:700;color:#1F2937;">' + escapeHtml(r.name) + '</div>' +
            '<div style="font-size:11px;font-weight:600;color:#047857;">' + escapeHtml(label) + '</div>' +
          '</div>' +
        '</div>' +
        '<span style="font-size:10px;color:#6B7280;">' + timeStr + '</span>' +
      '</div>';
    }
    list.innerHTML = html;
  }

  try {
    if (window.BroadcastChannel) {
      var bc = new BroadcastChannel('safeher_cross_tab');
      bc.onmessage = function(ev) {
        if (ev && ev.data && ev.data.status) {
          addResponseItem(ev.data);
        }
      };
    }
  } catch(e) {}

  // ─── Start Sharing Action ─────────────────────────────────
  function startSharing() {
    var checkedBoxes = document.querySelectorAll('.share-contact-checkbox:checked');
    selectedContactIds = [];
    checkedBoxes.forEach(function(box) {
      selectedContactIds.push(parseInt(box.value, 10));
    });

    if (selectedContactIds.length === 0) {
      SafeHer.toast('Please select at least one contact');
      return;
    }

    var startBtn = document.getElementById('btn-start-sharing');
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px;">hourglass_top</span>Starting...';
    }

    var user = (SafeHer.api && SafeHer.api.getUser ? SafeHer.api.getUser() : null);
    var userName = (user && (user.name || user.full_name)) ? (user.name || user.full_name) : 'SafeHer User';

    // 1. Generate unique share token immediately for tracking link
    var shareToken = 'share_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    var frontendBase = (window.SafeHerConfig && window.SafeHerConfig.FRONTEND_URL) || 'https://rohancse2025.github.io/Safeher';
    var trackUrl = frontendBase.replace(/\/+$/, '') + '/track.html?t=' + shareToken;

    var durationMs = getDurationMs(selectedDuration);
    var endTime = durationMs ? (Date.now() + durationMs) : null;
    var endTimeStr = endTime
      ? new Date(endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'until you stop';

    var untilStopped = (selectedDuration === 'stop');
    var durationMins = 60;
    if (selectedDuration === '15m') durationMins = 15;
    else if (selectedDuration === '1h') durationMins = 60;
    else if (selectedDuration === '4h') durationMins = 240;
    else if (selectedDuration === '8h') durationMins = 480;
    else if (selectedDuration === 'all_day') durationMins = 1440;
    if (untilStopped) durationMins = null;

    // Use current or cached location
    var initLat = currentLat || (SafeHer.getLastLocation ? SafeHer.getLastLocation().lat : 12.9716);
    var initLng = currentLng || (SafeHer.getLastLocation ? SafeHer.getLastLocation().lng : 77.5946);

    var session = {
      active: true,
      startTime: Date.now(),
      endTime: endTime,
      endTimeStr: endTimeStr,
      durationKey: selectedDuration,
      contactIds: selectedContactIds,
      lat: initLat,
      lng: initLng,
      lastUpdated: Date.now(),
      shareId: null,
      shareToken: shareToken,
      trackUrl: trackUrl,
      isOffline: !navigator.onLine
    };

    saveActiveSession(session);

    // Save fallback tracking session in localStorage
    try {
      localStorage.setItem('safeher_track_session_' + shareToken, JSON.stringify({
        type: 'share',
        first_name: userName,
        owner_name: userName,
        status: 'active',
        latest_lat: initLat,
        latest_lng: initLng,
        last_update_time: 'Just now',
        started_at: new Date().toISOString(),
        is_contact: true,
        contact_first_name: 'Contact',
        contact_name: 'Emergency Contact'
      }));
    } catch(e) {}

    updateHomeBanner();
    renderActiveView(session);
    startTrackingLoop();

    // Start Live Sentinel™ ambient audio uplink for trusted contacts
    if (SafeHer.sentinel && typeof SafeHer.sentinel.start === 'function') {
      try {
        SafeHer.sentinel.start(shareToken, shareToken);
      } catch(e) {
        console.warn('[ShareLocation] Live Sentinel start non-fatal:', e);
      }
    }

    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<span class="material-symbols-rounded">share_location</span>Start Sharing (Auto WhatsApp)';
    }

    // 2. Auto-dispatch in background via server (like SOS - no app switching required!)
    SafeHer.toast('Starting live location... Alerting contacts automatically via WhatsApp');

    // 3. Background GPS refinement
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          currentLat = pos.coords.latitude;
          currentLng = pos.coords.longitude;
          var curSess = getActiveSession();
          if (curSess) {
            curSess.lat = currentLat;
            curSess.lng = currentLng;
            saveActiveSession(curSess);
            updateCoordsDisplay(currentLat, currentLng);
            if (mapInstance && markerInstance) {
              markerInstance.setLatLng([currentLat, currentLng]);
              mapInstance.panTo([currentLat, currentLng]);
            }
          }
        },
        function() {},
        { timeout: 5000, enableHighAccuracy: true }
      );
    }

    // 4. Background backend registration
    var allContacts = (SafeHer.api && SafeHer.api.getContacts ? SafeHer.api.getContacts() : []) || [];
    if ((!allContacts || allContacts.length === 0) && SafeHer.storage && SafeHer.storage.get) {
      allContacts = SafeHer.storage.get('contacts') || [];
    }
    var activeContacts = allContacts;
    if (selectedContactIds && selectedContactIds.length > 0) {
      activeContacts = allContacts.filter(function(c) {
        return selectedContactIds.indexOf(c.id) !== -1 || selectedContactIds.indexOf(String(c.id)) !== -1;
      });
      if (!activeContacts || activeContacts.length === 0) activeContacts = allContacts;
    }
    var contactPhones = activeContacts.map(function(c) { return c.phone; }).filter(Boolean);

    var sharePayload = {
      contact_ids: selectedContactIds,
      contacts: activeContacts,
      phones: contactPhones,
      duration_minutes: durationMins,
      until_stopped: untilStopped,
      lat: initLat,
      lng: initLng,
      token: shareToken,
      user_name: userName
    };

    if (SafeHer.api && SafeHer.api.shareLocation) {
      SafeHer.api.shareLocation(sharePayload, function(err, result) {
        if (err || !result) {
          console.warn('[ShareLocation] Backend share queued offline:', err);
          if (SafeHer.offlineQueue) {
            SafeHer.offlineQueue.enqueue({
              url: '/api/shares',
              method: 'POST',
              body: sharePayload
            });
          }
          session.isOffline = true;
          saveActiveSession(session);
          return;
        }

        var shareData = result.data || result;
        session.shareId = shareData.id || null;
        if (shareData.tokens && shareData.tokens.length > 0) {
          session.shareToken = shareData.tokens[0].token;
          session.trackUrl = shareData.tokens[0].track_url;
        }
        if (SafeHer.sentinel && typeof SafeHer.sentinel.updateAlertId === 'function') {
          try {
            SafeHer.sentinel.updateAlertId(shareData.id, session.shareToken);
          } catch(e) {}
        }
        session.isOffline = false;
        saveActiveSession(session);
        updateLiveLinkDisplay(session);
        renderActiveContactsList(session);
      });
    }

    SafeHer.toast('Location sharing active');
  }

  // ─── Stop Sharing Action ──────────────────────────────────
  function stopSharing(isTimeout) {
    if (SafeHer.sentinel && typeof SafeHer.sentinel.stop === 'function') {
      try {
        SafeHer.sentinel.stop();
      } catch(e) {}
    }

    var activeSession = getActiveSession();
    var allContacts = (SafeHer.api && SafeHer.api.getContacts ? SafeHer.api.getContacts() : []) || [];
    if ((!allContacts || allContacts.length === 0) && SafeHer.storage && SafeHer.storage.get) {
      allContacts = SafeHer.storage.get('contacts') || [];
    }
    var stopPhones = allContacts.map(function(c) { return c.phone; }).filter(Boolean);
    var u = (SafeHer.api && SafeHer.api.getUser ? SafeHer.api.getUser() : null);
    var uName = (u && (u.name || u.full_name)) ? (u.name || u.full_name) : 'SafeHer User';

    if (SafeHer.api && SafeHer.api.stopShareLocation) {
      SafeHer.api.stopShareLocation({
        share_id: activeSession ? activeSession.shareId : null,
        token: activeSession ? activeSession.shareToken : null,
        contacts: allContacts,
        phones: stopPhones,
        user_name: uName
      });
    }
    if (SafeHer.deliveryTracker) {
      SafeHer.deliveryTracker.stopAll();
    }
    clearInterval(positionInterval);
    clearInterval(countdownInterval);
    positionInterval = null;
    countdownInterval = null;

    if (mapInstance) {
      mapInstance.remove();
      mapInstance = null;
      markerInstance = null;
    }

    saveActiveSession(null);
    updateHomeBanner();
    renderSetupView();

    receivedResponses = [];
    var respCard = document.getElementById('share-contact-responses-card');
    if (respCard) respCard.style.display = 'none';

    SafeHer.toast('Sharing ended');
  }

  function promptStopSharing() {
    var modal = document.getElementById('share-stop-modal');
    if (modal) {
      modal.style.display = 'flex';
    } else {
      stopSharing(false);
    }
  }

  function stopSharingAndNotifyWhatsApp() {
    var modal = document.getElementById('share-stop-modal');
    if (modal) modal.style.display = 'none';

    var session = getActiveSession();
    var user = (SafeHer.api && SafeHer.api.getUser ? SafeHer.api.getUser() : null);
    var userName = (user && (user.name || user.full_name)) ? (user.name || user.full_name) : 'SafeHer User';
    var message = '✅ *SafeHer Location Update*\n\n*' + userName + '* has arrived safely and stopped sharing their live location. All is well!';

    var targetPhone = '';
    var contacts = (SafeHer.api && SafeHer.api.getContacts) ? SafeHer.api.getContacts() : [];
    if (session && session.contactIds && session.contactIds.length > 0) {
      for (var i = 0; i < contacts.length; i++) {
        if (session.contactIds.indexOf(contacts[i].id) !== -1 && contacts[i].phone) {
          targetPhone = contacts[i].phone.replace(/\D/g, '');
          break;
        }
      }
    }
    if (!targetPhone && contacts.length > 0 && contacts[0].phone) {
      targetPhone = contacts[0].phone.replace(/\D/g, '');
    }
    if (targetPhone.length === 10) targetPhone = '91' + targetPhone;

    var waUrl = targetPhone
      ? ('https://wa.me/' + targetPhone + '?text=' + encodeURIComponent(message))
      : ('https://api.whatsapp.com/send?text=' + encodeURIComponent(message));

    stopSharing(false);
    try {
      window.location.href = waUrl;
    } catch(e) {
      window.open(waUrl, '_blank');
    }
  }

  // ─── Web Share API & Clipboard Fallback ───────────────────
  function shareViaWebShare() {
    var session = getActiveSession();
    var lat = session ? session.lat : currentLat;
    var lng = session ? session.lng : currentLng;
    var endTime = session ? session.endTime : null;
    var endTimeStr = session ? session.endTimeStr : 'until I stop';

    var message = buildShareMessage(lat, lng, endTime, endTimeStr);
    var mapsUrl = 'https://www.google.com/maps?q=' + lat + ',' + lng;

    if (navigator.share) {
      navigator.share({
        title: 'SafeHer Live Location',
        text: message,
        url: mapsUrl
      }).then(function() {
        SafeHer.toast('Link shared');
      }).catch(function(err) {
        if (err.name !== 'AbortError') {
          copyToClipboard(message);
        }
      });
    } else {
      copyToClipboard(message);
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        SafeHer.toast('Location link copied to clipboard');
      }).catch(function() {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      SafeHer.toast('Location link copied to clipboard');
    } catch(e) {
      SafeHer.toast('Could not copy link');
    }
    document.body.removeChild(ta);
  }

  // ─── Interaction Handlers ─────────────────────────────────
  function selectDuration(key) {
    selectedDuration = key;
    var chips = document.querySelectorAll('.share-duration-chip');
    chips.forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.duration === key);
    });
  }

  function onContactToggle(id, isChecked) {
    var idx = selectedContactIds.indexOf(id);
    if (isChecked && idx === -1) {
      selectedContactIds.push(id);
    } else if (!isChecked && idx !== -1) {
      selectedContactIds.splice(idx, 1);
    }
  }

  function toggleAllContacts() {
    var contacts = (SafeHer.api && SafeHer.api.getContacts ? SafeHer.api.getContacts() : []) || [];
    var checkboxes = document.querySelectorAll('.share-contact-checkbox');
    var allChecked = true;
    checkboxes.forEach(function(b) { if (!b.checked) allChecked = false; });

    var newState = !allChecked;
    checkboxes.forEach(function(b) { b.checked = newState; });
    selectedContactIds = newState ? contacts.map(function(c) { return c.id; }) : [];

    var btn = document.getElementById('btn-toggle-all-contacts');
    if (btn) btn.textContent = newState ? 'Deselect All' : 'Select All';
  }

  // ─── Init (runs at bootstrap) ─────────────────────────────
  function render() {
    var session = getActiveSession();
    if (session && session.active) {
      if (session.endTime && Date.now() >= session.endTime) {
        stopSharing(true);
      } else {
        renderActiveView(session);
      }
    } else {
      renderSetupView();
    }
  }

  function init() {
    var session = getActiveSession();
    if (session && session.active) {
      if (session.endTime && Date.now() >= session.endTime) {
        saveActiveSession(null);
        updateHomeBanner();
      } else {
        currentLat = session.lat || currentLat;
        currentLng = session.lng || currentLng;
        updateHomeBanner();
        startTrackingLoop();
      }
    } else {
      updateHomeBanner();
    }

    SafeHer.router.onShow('share-location', function() {
      render();
      if (SafeHer.api && SafeHer.api.getContacts) {
        SafeHer.api.getContacts(function(err, fetched) {
          if (!err && fetched) {
            render();
          }
        });
      }
    });
  }

  return {
    init: init,
    render: render,
    selectDuration: selectDuration,
    onContactToggle: onContactToggle,
    toggleAllContacts: toggleAllContacts,
    startSharing: startSharing,
    stopSharing: stopSharing,
    promptStopSharing: promptStopSharing,
    stopSharingAndNotifyWhatsApp: stopSharingAndNotifyWhatsApp,
    shareViaWhatsApp: shareViaWhatsApp,
    shareViaWebShare: shareViaWebShare,
    copyLiveLink: copyLiveLink,
    updateHomeBanner: updateHomeBanner,
    getActiveSession: getActiveSession
  };
})();
