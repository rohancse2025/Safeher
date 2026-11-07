// js/home.js – Home screen: greeting, geolocation, SOS button, tile navigation

SafeHer.home = (function() {
  var sosActive  = false;
  var locFetched = false;   // fetch once per session

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

  // ── Location via Geolocation + Nominatim ───────────────
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

    var timedOut = false;
    var timer = setTimeout(function() {
      timedOut = true;
      setLocText('Location off', true);
    }, 5000);

    navigator.geolocation.getCurrentPosition(
      function(pos) {
        clearTimeout(timer);
        if (timedOut) return;

        locFetched = true;
        var lat = pos.coords.latitude.toFixed(5);
        var lon = pos.coords.longitude.toFixed(5);

        // Nominatim reverse geocoding (OpenStreetMap)
        // Backend endpoint: GET /api/location/reverse?lat=&lon=
        fetch(
          'https://nominatim.openstreetmap.org/reverse?format=json&lat=' +
          lat + '&lon=' + lon + '&zoom=10'
        )
          .then(function(r) { return r.json(); })
          .then(function(data) {
            var a     = data.address || {};
            var city  = a.city || a.town || a.village || a.county || '';
            var state = a.state || '';
            setLocText(city ? city + (state ? ', ' + state : '') : 'Location found', false);
          })
          .catch(function() { setLocText('Location off', true); });
      },
      function() {
        clearTimeout(timer);
        setLocText('Location off', true);
      },
      { timeout: 5000 }
    );
  }

  function retryLocation() {
    locFetched = false;
    fetchLocation(true);
  }

  // ── Refresh (runs each time Home is shown) ─────────────
  function refresh() {
    // 1. User Name Greeting
    var user = null;
    if (SafeHer.api && SafeHer.api.getUser) user = SafeHer.api.getUser();
    if (!user && SafeHer.storage) {
      try { user = SafeHer.storage.get('user'); } catch(e) {}
    }
    if (!user && SafeHer.storage) {
      try { user = SafeHer.storage.get('profile'); } catch(e) {}
    }

    var rawName = (user && (user.name || user.full_name)) ? (user.name || user.full_name) : '';
    if (!rawName) {
      try { rawName = localStorage.getItem('safeher_user_name') || ''; } catch(e) {}
    }

    var firstName = rawName ? rawName.trim().split(' ')[0] : 'there';
    var nameEl = document.getElementById('home-name');
    if (nameEl) {
      nameEl.textContent = firstName;
    }

    // 2. Trusted Contacts Count
    var cachedContacts = (SafeHer.api && SafeHer.api.getContacts) ? SafeHer.api.getContacts(function(err, list) {
      if (!err && list) {
        updateContactsCount(list.length);
      }
    }) : [];
    updateContactsCount((cachedContacts && cachedContacts.length) ? cachedContacts.length : 0);

    // 3. Nearby Volunteers Count
    if (SafeHer.api && SafeHer.api.getAvailableVolunteersCount) {
      var liveLoc = (SafeHer.api && SafeHer.api.getLiveLocation) ? SafeHer.api.getLiveLocation() : null;
      var coords = (liveLoc && liveLoc.lat) ? { lat: liveLoc.lat, lng: liveLoc.lng } : null;

      SafeHer.api.getAvailableVolunteersCount(function(err, count) {
        var vEl = document.getElementById('home-volunteers-count');
        var vSub = document.getElementById('home-volunteers-sub');
        var finalCount = (!err && count !== undefined && count !== null) ? count : 0;
        if (vEl) vEl.textContent = finalCount;
        if (vSub) vSub.textContent = finalCount > 0 ? (finalCount === 1 ? '1 nearby & ready' : finalCount + ' nearby & ready') : 'Tap to become one';
      }, coords);
    }

    if (SafeHer.shareLocation && SafeHer.shareLocation.updateHomeBanner) {
      SafeHer.shareLocation.updateHomeBanner();
    }

    if (SafeHer.sos && SafeHer.sos.updateUneasyBanner) {
      SafeHer.sos.updateUneasyBanner();
    }
  }

  function updateContactsCount(count) {
    var cEl = document.getElementById('home-contacts-count');
    var cSub = document.getElementById('home-contacts-sub');
    var n = (typeof count === 'number') ? count : 0;
    if (cEl) cEl.textContent = n;
    if (cSub) {
      cSub.textContent = n > 0 ? (n + ' saved') : 'Tap to add';
    }
  }

  // ── Init (called once at DOMContentLoaded) ─────────────
  function init() {
    SafeHer.router.onShow('home', function() {
      refresh();
      fetchLocation();
    });
  }

  return {
    init: init,
    refresh: refresh,
    updateContactsCount: updateContactsCount,
    triggerSOS: triggerSOS,
    setSOSActive: setSOSActive,
    retryLocation: retryLocation
  };
})();
