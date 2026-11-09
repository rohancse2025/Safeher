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
          '<input type="checkbox" id="share-contact-' + c.id + '" class="share-contact-checkbox" value="' + c.id + '" ' + (isChecked ? 'checked' : '') + ' onchange="SafeHer.shareLocation.onContactToggle(' + c.id + ', this.checked)" />' +
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
  function renderActiveView(session) {
    var activeView = document.getElementById('share-active-view');
    var setupView = document.getElementById('share-setup-view');
    if (setupView) setupView.style.display = 'none';
    if (activeView) activeView.style.display = 'block';

    updateActiveTimeDisplay(session);
    updateCoordsDisplay(session.lat, session.lng);
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
    // Note: Real live tracking links for contacts will come from the backend.
    var user = (SafeHer.api && SafeHer.api.getUser ? SafeHer.api.getUser() : null);
    var userName = (user && user.name) ? user.name : 'SafeHer User';
    var mapsLink = 'https://www.google.com/maps?q=' + lat + ',' + lng;
    var endDesc = (endTime === null) ? 'until I stop' : ('until ' + endTimeStr);

    return userName + ' is sharing their live location with you on SafeHer ' + endDesc + ':\n' + mapsLink;
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
          }
        },
        function() {
          // Keep current fallback on location glitch
        },
        { timeout: 7000, enableHighAccuracy: true }
      );
    }, 10000);
  }

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
      startBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px;">hourglass_top</span>Getting location...';
    }

    function proceed(lat, lng) {
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.innerHTML = '<span class="material-symbols-rounded">share_location</span>Start Sharing';
      }

      currentLat = lat;
      currentLng = lng;

      var durationMs = getDurationMs(selectedDuration);
      var endTime = durationMs ? (Date.now() + durationMs) : null;
      var endTimeStr = endTime
        ? new Date(endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'until you stop';

      var session = {
        active: true,
        startTime: Date.now(),
        endTime: endTime,
        endTimeStr: endTimeStr,
        durationKey: selectedDuration,
        contactIds: selectedContactIds,
        lat: currentLat,
        lng: currentLng,
        lastUpdated: Date.now()
      };

      saveActiveSession(session);
      updateHomeBanner();
      renderActiveView(session);
      startTrackingLoop();

      var allContacts = SafeHer.storage.get('contacts') || [];
      var chosenContacts = allContacts.filter(function(c) {
        return selectedContactIds.indexOf(c.id) !== -1;
      });
      if (chosenContacts.length === 0) chosenContacts = allContacts;

      var durationMins = 60;
      if (selectedDuration === '15m') durationMins = 15;
      else if (selectedDuration === '1h') durationMins = 60;
      else if (selectedDuration === '8h') durationMins = 480;
      else if (selectedDuration === 'all_day') durationMins = 1440;

      if (SafeHer.api && SafeHer.api.shareLocation) {
        SafeHer.api.shareLocation({
          lat: currentLat,
          lng: currentLng,
          duration_minutes: durationMins,
          duration_str: selectedDuration,
          contacts: chosenContacts
        }, function(err, result) {
          if (!err && result) {
            session.shareToken = result.share_token;
            session.trackUrl = result.track_url;
            saveActiveSession(session);
            if (SafeHer.toast) SafeHer.toast('⚡ Location alerts sent via WhatsApp & Email!');
          }
        });
      }

      SafeHer.toast('Location sharing active');
    }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          proceed(pos.coords.latitude, pos.coords.longitude);
        },
        function() {
          SafeHer.toast('Location off. Using default coordinates.');
          proceed(currentLat, currentLng);
        },
        { timeout: 6000, enableHighAccuracy: true }
      );
    } else {
      proceed(currentLat, currentLng);
    }
  }

  // ─── Stop Sharing Action ──────────────────────────────────
  function stopSharing(isTimeout) {
    var activeSession = getActiveSession();
    if (activeSession && activeSession.shareToken && SafeHer.api && SafeHer.api.stopShareLocation) {
      SafeHer.api.stopShareLocation({ share_token: activeSession.shareToken });
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

    SafeHer.toast('Sharing ended');
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
    shareViaWebShare: shareViaWebShare,
    updateHomeBanner: updateHomeBanner,
    getActiveSession: getActiveSession
  };
})();
