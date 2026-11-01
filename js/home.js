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
  function setLocText(txt) {
    var el = document.getElementById('home-location');
    if (el) el.textContent = txt;
  }

  function fetchLocation() {
    if (locFetched) return;
    if (!navigator.geolocation) { setLocText('Location off'); return; }

    setLocText('Locating…');
    navigator.geolocation.getCurrentPosition(
      function(pos) {
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
            setLocText(city ? city + (state ? ', ' + state : '') : 'Location found');
          })
          .catch(function() { setLocText('Location off'); });
      },
      function() { setLocText('Location off'); },
      { timeout: 8000 }
    );
  }

  // ── Refresh (runs each time Home is shown) ─────────────
  function refresh() {
    var user   = SafeHer.api.getUser();
    var nameEl = document.getElementById('home-name');
    if (nameEl) {
      var first = user && user.name ? user.name.split(' ')[0] : 'there';
      nameEl.textContent = first;
    }

    var cEl = document.getElementById('home-contacts-count');
    if (cEl) cEl.textContent = SafeHer.api.getContacts().length;
  }

  // ── Init (called once at DOMContentLoaded) ─────────────
  function init() {
    SafeHer.router.onShow('home', function() {
      refresh();
      fetchLocation();
    });
  }

  return { init: init, triggerSOS: triggerSOS, setSOSActive: setSOSActive };
})();
