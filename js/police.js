// js/police.js – Nearby Police Stations & Hospitals using Overpass API, Haversine distance, and Leaflet

SafeHer.police = (function() {
  var activeTab = 'police'; // 'police' | 'hospitals'
  var userLocation = null;
  var cachedData = { police: [], hospitals: [] };
  var mapInstance = null;
  var markersGroup = null;
  var isLoading = false;

  var OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

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
    var R = 6371; // Earth's radius in km
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

  // ─── UI State Helpers ─────────────────────────────────────
  function showLoading() {
    isLoading = true;
    var loadEl = document.getElementById('places-loading');
    var errEl = document.getElementById('places-error');
    var listEl = document.getElementById('places-list');
    if (loadEl) loadEl.style.display = 'flex';
    if (errEl) errEl.style.display = 'none';
    if (listEl && cachedData[activeTab].length === 0) listEl.style.display = 'none';
  }

  function hideLoading() {
    isLoading = false;
    var loadEl = document.getElementById('places-loading');
    if (loadEl) loadEl.style.display = 'none';
  }

  function showError() {
    isLoading = false;
    var loadEl = document.getElementById('places-loading');
    var errEl = document.getElementById('places-error');
    var listEl = document.getElementById('places-list');
    if (loadEl) loadEl.style.display = 'none';
    if (errEl) errEl.style.display = 'flex';
    if (listEl && cachedData[activeTab].length === 0) listEl.style.display = 'none';
  }

  function hideError() {
    var errEl = document.getElementById('places-error');
    if (errEl) errEl.style.display = 'none';
  }

  // ─── Map Rendering ────────────────────────────────────────
  function updateMap(places) {
    var mapEl = document.getElementById('places-map');
    if (!mapEl || typeof L === 'undefined') return;

    var lat = userLocation ? userLocation.lat : 12.9716;
    var lng = userLocation ? userLocation.lng : 77.5946;

    if (!mapInstance) {
      mapInstance = L.map('places-map', {
        center: [lat, lng],
        zoom: 14,
        zoomControl: false,
        attributionControl: false
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19
      }).addTo(mapInstance);
    }

    if (!markersGroup) {
      markersGroup = L.layerGroup().addTo(mapInstance);
    } else {
      markersGroup.clearLayers();
    }

    // User location marker
    var userMarker = L.circleMarker([lat, lng], {
      radius: 8,
      fillColor: '#A80F3C',
      color: '#FFFFFF',
      weight: 2,
      opacity: 1,
      fillOpacity: 1
    }).bindPopup('<b>Your Location</b>');
    markersGroup.addLayer(userMarker);

    // Place markers
    var bounds = L.latLngBounds([[lat, lng]]);
    var hasPlaces = places && places.length > 0;

    if (hasPlaces) {
      for (var i = 0; i < places.length; i++) {
        var p = places[i];
        bounds.extend([p.lat, p.lon]);

        var popupHtml = '<div style="font-family: Poppins, sans-serif; font-size: 13px;">' +
          '<b style="color: #333;">' + escapeHtml(p.name) + '</b><br>' +
          '<span style="color: #777; font-size: 12px;">' + escapeHtml(p.distStr) + '</span><br>' +
          '<a href="https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lon + '" target="_blank" rel="noopener noreferrer" style="color: #A80F3C; font-weight: 600; font-size: 12px; text-decoration: none;">Get Directions &rarr;</a>' +
          '</div>';

        var marker = L.marker([p.lat, p.lon]).bindPopup(popupHtml);
        markersGroup.addLayer(marker);
      }

      mapInstance.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
    } else {
      mapInstance.setView([lat, lng], 14);
    }

    mapInstance.invalidateSize();
    setTimeout(function() {
      if (mapInstance) mapInstance.invalidateSize();
    }, 200);
  }

  // ─── Render Place Cards ───────────────────────────────────
  function renderList() {
    var listEl = document.getElementById('places-list');
    if (!listEl) return;

    var places = cachedData[activeTab] || [];

    if (places.length === 0) {
      if (!isLoading) {
        var placeTypeLabel = activeTab === 'police' ? 'police stations' : 'hospitals';
        listEl.innerHTML = '<div class="places-empty-card">' +
          '<span class="material-symbols-rounded places-empty-icon">' + (activeTab === 'police' ? 'local_police' : 'local_hospital') + '</span>' +
          '<p class="places-empty-title">No ' + placeTypeLabel + ' found within 3 km</p>' +
          '<p class="places-empty-sub">Try refreshing or check emergency helplines for immediate assistance.</p>' +
        '</div>';
        listEl.style.display = 'block';
      }
      updateMap([]);
      return;
    }

    var html = '';
    for (var i = 0; i < places.length; i++) {
      var p = places[i];
      var iconName = activeTab === 'police' ? 'local_police' : 'local_hospital';
      var dirUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lon;

      var callBtn = '';
      if (p.phone) {
        var cleanTel = p.phone.replace(/[^0-9+]/g, '');
        callBtn = '<a href="tel:' + escapeHtml(cleanTel) + '" class="btn btn-crimson place-btn place-call-btn">' +
          '<span class="material-symbols-rounded">call</span>Call' +
        '</a>';
      }

      html += '<div class="place-card">' +
        '<div class="place-card-top">' +
          '<div class="place-icon-box">' +
            '<span class="material-symbols-rounded place-card-icon">' + iconName + '</span>' +
          '</div>' +
          '<div class="place-card-body">' +
            '<p class="place-name">' + escapeHtml(p.name) + '</p>' +
            '<p class="place-dist">' + escapeHtml(p.distStr) + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="place-actions">' +
          '<a href="' + escapeHtml(dirUrl) + '" target="_blank" rel="noopener noreferrer" class="btn btn-outline place-btn place-dir-btn">' +
            '<span class="material-symbols-rounded">directions</span>Directions' +
          '</a>' +
          callBtn +
        '</div>' +
      '</div>';
    }

    listEl.innerHTML = html;
    listEl.style.display = 'block';

    updateMap(places);
  }

  // ─── Query Overpass API ───────────────────────────────────
  function queryOverpass(lat, lng, callback) {
    var query = '[out:json][timeout:15];' +
      '(' +
      'node["amenity"="police"](around:3000,' + lat + ',' + lng + ');' +
      'way["amenity"="police"](around:3000,' + lat + ',' + lng + ');' +
      'node["amenity"="hospital"](around:3000,' + lat + ',' + lng + ');' +
      'way["amenity"="hospital"](around:3000,' + lat + ',' + lng + ');' +
      ');' +
      'out center;';

    var endpointIndex = 0;

    function tryFetch() {
      if (endpointIndex >= OVERPASS_ENDPOINTS.length) {
        callback(new Error('All Overpass endpoints failed'));
        return;
      }

      var url = OVERPASS_ENDPOINTS[endpointIndex];
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timeoutId = controller ? setTimeout(function() { controller.abort(); }, 12000) : null;

      var fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'data=' + encodeURIComponent(query)
      };
      if (controller) fetchOptions.signal = controller.signal;

      fetch(url, fetchOptions)
        .then(function(res) {
          if (timeoutId) clearTimeout(timeoutId);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function(data) {
          callback(null, data);
        })
        .catch(function(err) {
          if (timeoutId) clearTimeout(timeoutId);
          endpointIndex++;
          tryFetch();
        });
    }

    tryFetch();
  }

  // ─── Parse Elements & Cache ───────────────────────────────
  function processOverpassData(data, uLat, uLng) {
    var elements = data && data.elements ? data.elements : [];
    var policeList = [];
    var hospitalList = [];

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var lat = el.lat !== undefined ? el.lat : (el.center ? el.center.lat : null);
      var lon = el.lon !== undefined ? el.lon : (el.center ? el.center.lon : null);

      if (lat === null || lon === null) continue;

      var tags = el.tags || {};
      var amenity = tags.amenity;
      var name = tags.name;

      if (!name) {
        name = amenity === 'hospital' ? 'Hospital / Clinic' : 'Police Station';
      }

      var phone = tags.phone || tags['contact:phone'] || tags['emergency:phone'] || '';
      var distKm = haversineDistance(uLat, uLng, lat, lon);

      var placeObj = {
        id: el.id,
        name: name,
        lat: lat,
        lon: lon,
        dist: distKm,
        distStr: formatDistance(distKm),
        phone: phone,
        amenity: amenity
      };

      if (amenity === 'police') {
        policeList.push(placeObj);
      } else if (amenity === 'hospital') {
        hospitalList.push(placeObj);
      }
    }

    // Sort by distance ascending
    policeList.sort(function(a, b) { return a.dist - b.dist; });
    hospitalList.sort(function(a, b) { return a.dist - b.dist; });

    // Limit to 15 items per tab
    cachedData.police = policeList.slice(0, 15);
    cachedData.hospitals = hospitalList.slice(0, 15);

    // Save to localStorage cache via SafeHer.api
    if (SafeHer.api && SafeHer.api.setNearbyPlacesCache) {
      SafeHer.api.setNearbyPlacesCache({
        lat: uLat,
        lng: uLng,
        timestamp: Date.now(),
        police: cachedData.police,
        hospitals: cachedData.hospitals
      });
    }
  }

  // ─── Fetch Nearby Places ──────────────────────────────────
  function fetchPlaces() {
    showLoading();
    hideError();

    function proceedWithLocation(lat, lng) {
      userLocation = { lat: lat, lng: lng };

      queryOverpass(lat, lng, function(err, data) {
        hideLoading();

        if (err || !data) {
          // If network failed, check if we have cached results
          var saved = SafeHer.api ? SafeHer.api.getNearbyPlacesCache() : null;
          if (saved && (saved.police.length > 0 || saved.hospitals.length > 0)) {
            cachedData.police = saved.police || [];
            cachedData.hospitals = saved.hospitals || [];
            SafeHer.toast('Offline – showing cached places');
            hideError();
            renderList();
          } else {
            showError();
          }
          return;
        }

        hideError();
        processOverpassData(data, lat, lng);
        renderList();
      });
    }

    // Try device location, falling back to Bengaluru coordinates
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          proceedWithLocation(pos.coords.latitude, pos.coords.longitude);
        },
        function() {
          // Fallback location on permission denial or error
          var fallback = (SafeHer.api && SafeHer.api.getLiveLocation) ? SafeHer.api.getLiveLocation() : null;
          var fLat = fallback ? fallback.lat : 12.9716;
          var fLng = fallback ? fallback.lng : 77.5946;
          proceedWithLocation(fLat, fLng);
        },
        { timeout: 7000, enableHighAccuracy: true }
      );
    } else {
      proceedWithLocation(12.9716, 77.5946);
    }
  }

  // ─── Tab Switching ────────────────────────────────────────
  function switchTab(tab) {
    if (tab === 'hospital') tab = 'hospitals';
    if (activeTab === tab) return;
    activeTab = tab;

    var btnPolice = document.getElementById('tab-btn-police');
    var btnHospital = document.getElementById('tab-btn-hospital');

    if (btnPolice) btnPolice.classList.toggle('active', tab === 'police');
    if (btnHospital) btnHospital.classList.toggle('active', tab === 'hospitals');

    renderList();
  }

  function retry() {
    fetchPlaces();
  }

  // ─── Initialize ───────────────────────────────────────────
  function init() {
    // Load last successful cached results on startup
    if (SafeHer.api && SafeHer.api.getNearbyPlacesCache) {
      var saved = SafeHer.api.getNearbyPlacesCache();
      if (saved) {
        if (saved.lat && saved.lng) userLocation = { lat: saved.lat, lng: saved.lng };
        if (saved.police) cachedData.police = saved.police;
        if (saved.hospitals) cachedData.hospitals = saved.hospitals;
      }
    }

    SafeHer.router.onShow('nearby-places', function() {
      // If we already have cached places, show them immediately
      if (cachedData.police.length > 0 || cachedData.hospitals.length > 0) {
        renderList();
      }
      fetchPlaces();

      if (mapInstance) {
        setTimeout(function() { mapInstance.invalidateSize(); }, 150);
        setTimeout(function() { mapInstance.invalidateSize(); }, 400);
      }
    });

    SafeHer.router.onShow('police', function() {
      SafeHer.router.go('nearby-places');
    });
  }

  return {
    init: init,
    switchTab: switchTab,
    retry: retry,
    getActiveTab: function() { return activeTab; }
  };
})();
