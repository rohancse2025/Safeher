// js/home.js – Home screen: greeting, geolocation, SOS button, tile navigation, and footer row

SafeHer.home = (function() {
  var sosActive  = false;
  var locFetched = false;   // fetch once per session

  // ── Helper ──────────────────────────────────────────────
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── SOS trigger ─────────────────────────────────────────
  function triggerSOS() {
    if (SafeHer.sos) {
      SafeHer.sos.startCountdown();
    } else {
      SafeHer.toast('SOS triggered');
    }
  }

  function setSOSActive(active) {
    sosActive = !!active;
    var btn     = document.getElementById('sos-btn');
    var dot     = document.getElementById('status-dot');
    var txtEl   = document.getElementById('sos-status-text');

    if (sosActive) {
      if (btn)   btn.classList.add('sos-btn--active');
      if (dot)   dot.className = 'status-dot status-sos';
      if (txtEl) txtEl.textContent = 'SOS active';
    } else {
      if (btn)   btn.classList.remove('sos-btn--active');
      if (dot)   dot.className = 'status-dot status-safe';
      if (txtEl) txtEl.textContent = 'You are safe';
    }
  }

  // ── Greeting (Requirement 1) ───────────────────────────
  function updateGreeting() {
    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : null;
    var helloEl = document.getElementById('home-hello');
    if (!helloEl) return;

    var rawName = (user && user.name) ? String(user.name).trim() : '';
    // Show first name if available; if no name, show just "Hello"
    if (rawName && rawName.toLowerCase() !== 'there' && rawName.toLowerCase() !== 'guest' && rawName.toLowerCase() !== 'user') {
      var first = rawName.split(/\s+/)[0];
      helloEl.innerHTML = 'Hello, <span id="home-name">' + escapeHtml(first) + '</span>';
    } else {
      helloEl.innerHTML = 'Hello';
    }
  }

  // ── Location via Geolocation + Nominatim (Requirement 2) ──
  function setLocText(txt, showEnable) {
    var el = document.getElementById('home-location');
    var enableBtn = document.getElementById('home-loc-enable');
    if (el) el.textContent = txt;
    if (enableBtn) enableBtn.style.display = showEnable ? 'inline' : 'none';
  }

  function fetchLocation(isRetry) {
    if (locFetched && !isRetry) return;
    if (!navigator.geolocation) {
      setLocText('Location off', true);
      return;
    }

    setLocText('Locating...', false);

    var resolved = false;
    // Strict 5-second timeout on entire lookup
    var timer = setTimeout(function() {
      if (!resolved) {
        resolved = true;
        setLocText('Location off', true);
      }
    }, 5000);

    navigator.geolocation.getCurrentPosition(
      function(pos) {
        if (resolved) return;

        locFetched = true;
        var lat = pos.coords.latitude.toFixed(5);
        var lon = pos.coords.longitude.toFixed(5);

        // Reverse geocoding via Nominatim with 3s timeout
        var nomController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var nomTimer = setTimeout(function() {
          if (nomController) nomController.abort();
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            setLocText('Location on', false);
          }
        }, 3000);

        var url = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lon + '&zoom=10';
        fetch(url, { signal: nomController ? nomController.signal : undefined, headers: { 'Accept': 'application/json' } })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            clearTimeout(nomTimer);
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            var a = (data && data.address) || {};
            var city = a.city || a.town || a.village || a.suburb || a.county || '';
            var state = a.state || '';
            setLocText(city ? city + (state ? ', ' + state : '') : 'Location on', false);
          })
          .catch(function() {
            clearTimeout(nomTimer);
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            setLocText('Location off', true);
          });
      },
      function(err) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          setLocText('Location off', true);
        }
      },
      { timeout: 4500, enableHighAccuracy: false, maximumAge: 30000 }
    );
  }

  function retryLocation() {
    locFetched = false;
    fetchLocation(true);
  }

  // ── Footer Row: Contacts & Volunteers (Requirement 4) ───
  function updateFooterRow() {
    var contacts = (SafeHer.api && SafeHer.api.getContacts) ? SafeHer.api.getContacts() : [];
    var count = contacts ? contacts.length : 0;

    var noCard = document.getElementById('home-no-contacts-card');
    var infoRow = document.getElementById('home-contacts-info-row');
    var countEl = document.getElementById('home-contacts-count');

    if (count === 0) {
      if (noCard) noCard.style.display = 'flex';
      if (infoRow) infoRow.style.display = 'none';
    } else {
      if (noCard) noCard.style.display = 'none';
      if (infoRow) infoRow.style.display = 'flex';
      if (countEl) countEl.textContent = String(count);
    }

    updateVolunteerVisibility();
  }

  function updateVolunteerVisibility(val) {
    var volCountEl = document.getElementById('home-volunteers-count');
    var volWrap = document.getElementById('home-volunteers-wrap');
    if (!volWrap) return;

    var count = (val !== undefined) ? val : (volCountEl ? parseInt(volCountEl.textContent, 10) : 0);
    if (isNaN(count)) count = 0;

    if (volCountEl && val !== undefined) {
      volCountEl.textContent = String(val);
    }

    if (count > 0) {
      volWrap.style.display = 'inline';
    } else {
      volWrap.style.display = 'none';
    }
  }

  // ── Emergency Info Screen Helpers (Requirement 3) ───────
  function saveEmergencyInfo() {
    var blood = (document.getElementById('em-info-blood') || {}).value || '';
    var allergies = (document.getElementById('em-info-allergies') || {}).value || '';
    var notes = (document.getElementById('em-info-notes') || {}).value || '';

    var info = {
      blood: blood,
      allergies: allergies,
      notes: notes,
      updatedAt: new Date().toISOString()
    };

    if (SafeHer.storage) {
      SafeHer.storage.set('emergency_info', info);
    }
    if (SafeHer.toast) {
      SafeHer.toast('Emergency Info saved successfully');
    }
  }

  function renderEmergencyInfo() {
    var info = (SafeHer.storage && SafeHer.storage.get('emergency_info')) || {};
    var bloodEl = document.getElementById('em-info-blood');
    var allergiesEl = document.getElementById('em-info-allergies');
    var notesEl = document.getElementById('em-info-notes');

    if (bloodEl && info.blood) bloodEl.value = info.blood;
    if (allergiesEl && info.allergies) allergiesEl.value = info.allergies;
    if (notesEl && info.notes) notesEl.value = info.notes;

    var listEl = document.getElementById('em-info-contacts-list');
    if (listEl) {
      var contacts = (SafeHer.api && SafeHer.api.getContacts) ? SafeHer.api.getContacts() : [];
      if (!contacts || contacts.length === 0) {
        listEl.innerHTML = '<p style="margin: 0; font-size: 12px; color: var(--text-gray);">No emergency contacts added yet. Tap Manage to add contacts.</p>';
      } else {
        var html = '';
        contacts.forEach(function(c) {
          html += '<div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border);">' +
            '<div>' +
              '<div style="font-weight: 600; color: var(--text-dark);">' + escapeHtml(c.name) + '</div>' +
              '<div style="font-size: 11px; color: var(--text-gray);">' + escapeHtml(c.phone || c.email || '') + ' (' + escapeHtml(c.relation || c.relationship || 'Contact') + ')</div>' +
            '</div>' +
            '<a href="tel:' + escapeHtml(c.phone || '') + '" class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px; height: 28px; min-height: 28px; text-decoration: none; display: inline-flex; align-items: center; gap: 4px;">' +
              '<span class="material-symbols-rounded" style="font-size: 14px;">call</span> Call' +
            '</a>' +
          '</div>';
        });
        listEl.innerHTML = html;
      }
    }
  }

  // ── Refresh (runs each time Home is shown) ─────────────
  function refresh() {
    updateGreeting();
    updateFooterRow();

    if (SafeHer.shareLocation && SafeHer.shareLocation.updateHomeBanner) {
      SafeHer.shareLocation.updateHomeBanner();
    }

    if (SafeHer.sos && SafeHer.sos.updateUneasyBanner) {
      SafeHer.sos.updateUneasyBanner();
    }
  }

  // ── Init (called once at DOMContentLoaded) ─────────────
  function init() {
    SafeHer.router.onShow('home', function() {
      refresh();
      fetchLocation();
    });

    SafeHer.router.onShow('emergency-info', function() {
      renderEmergencyInfo();
    });
  }

  return {
    init: init,
    refresh: refresh,
    triggerSOS: triggerSOS,
    setSOSActive: setSOSActive,
    retryLocation: retryLocation,
    updateFooterRow: updateFooterRow,
    updateVolunteerVisibility: updateVolunteerVisibility,
    saveEmergencyInfo: saveEmergencyInfo,
    renderEmergencyInfo: renderEmergencyInfo
  };
})();
