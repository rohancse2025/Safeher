// js/places.js – Nearby Open Places with Overpass API, 24/7 Filter, Walking Time & Leaflet Map
window.SafeHer = window.SafeHer || {};

SafeHer.places = (function() {
  var activeCategory = 'pharmacy';
  var only24Hours = false;
  var userLocation = null;
  var cachedPlaces = [];
  var mapInstance = null;
  var markersLayer = null;
  var userMarker = null;
  var isLoading = false;
  var CACHE_KEY = 'nearby_open_places_cache';

  var CATEGORIES = [
    { id: 'pharmacy', label: 'Pharmacy', icon: 'local_pharmacy' },
    { id: 'hospital', label: 'Hospital', icon: 'local_hospital' },
    { id: 'police', label: 'Police', icon: 'local_police' },
    { id: 'fuel', label: 'Petrol Station', icon: 'local_gas_station' },
    { id: 'shop', label: 'Shop', icon: 'storefront' },
    { id: 'restaurant', label: 'Restaurant', icon: 'restaurant' }
  ];

  var OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter'
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

  // Walking time at 5 km/h: time = (dist / 5) * 60 minutes = dist * 12 minutes
  function calculateWalkingTime(distKm) {
    var mins = Math.round(distKm * 12);
    if (mins < 1) return '< 1 min walk';
    return '~' + mins + ' min walk';
  }

  // Opening hours parser: "24/7" -> badge; else gray text; missing -> "Hours not listed"
  function parseOpeningHours(rawHours) {
    if (!rawHours || !String(rawHours).trim()) {
      return { is24: false, text: 'Hours not listed', isMissing: true };
    }
    var clean = String(rawHours).trim();
    if (/^24\s*\/\s*7$/i.test(clean) || clean.toLowerCase() === '24/7') {
      return { is24: true, text: 'Open 24 hours', isMissing: false };
    }
    return { is24: false, text: clean, isMissing: false };
  }

  // ─── Query Builder ────────────────────────────────────────
  function buildOverpassQuery(category, lat, lng) {
    var radius = 2000; // 2 km
    var tagFilter = '';
    if (category === 'pharmacy') {
      tagFilter = '["amenity"="pharmacy"]';
    } else if (category === 'hospital') {
      tagFilter = '["amenity"="hospital"]';
    } else if (category === 'police') {
      tagFilter = '["amenity"="police"]';
    } else if (category === 'fuel') {
      tagFilter = '["amenity"="fuel"]';
    } else if (category === 'shop') {
      tagFilter = '["shop"~"convenience|supermarket"]';
    } else if (category === 'restaurant') {
      tagFilter = '["amenity"="restaurant"]';
    } else {
      tagFilter = '["amenity"="' + category + '"]';
    }

    return '[out:json][timeout:25];' +
      '(' +
        'node' + tagFilter + '(around:' + radius + ',' + lat + ',' + lng + ');' +
        'way' + tagFilter + '(around:' + radius + ',' + lat + ',' + lng + ');' +
      ');' +
      'out center;';
  }

  // ─── UI State Helpers ─────────────────────────────────────
  function showLoading() {
    isLoading = true;
    var loadEl = document.getElementById('places-loading');
    var errEl = document.getElementById('places-error');
    var listEl = document.getElementById('places-list');
    if (loadEl) loadEl.style.display = 'flex';
    if (errEl) errEl.style.display = 'none';
    if (listEl && cachedPlaces.length === 0) listEl.style.display = 'none';
  }

  function hideLoading() {
    isLoading = false;
    var loadEl = document.getElementById('places-loading');
    if (loadEl) loadEl.style.display = 'none';
  }

  function showError(msg) {
    isLoading = false;
    var loadEl = document.getElementById('places-loading');
    var errEl = document.getElementById('places-error');
    var listEl = document.getElementById('places-list');
    if (loadEl) loadEl.style.display = 'none';
    if (errEl) {
      errEl.style.display = 'flex';
      var descEl = errEl.querySelector('.places-error-desc');
      if (descEl && msg) descEl.textContent = msg;
    }
    if (listEl && cachedPlaces.length === 0) listEl.style.display = 'none';
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

      L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        maxNativeZoom: 18,
        subdomains: ['0', '1', '2', '3']
      }).addTo(mapInstance);
    }

    if (!markersLayer) {
      markersLayer = L.layerGroup().addTo(mapInstance);
    } else {
      markersLayer.clearLayers();
    }

    // User location marker
    var userIcon = L.divIcon({
      className: 'places-user-marker',
      html: '<div style="width:16px;height:16px;border-radius:50%;background:#A80F3C;border:3px solid #ffffff;box-shadow:0 0 0 3px rgba(168,15,60,0.3);"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
    userMarker = L.marker([lat, lng], { icon: userIcon }).addTo(markersLayer);
    userMarker.bindPopup('<b>Your Location</b>');

    var bounds = L.latLngBounds([[lat, lng]]);

    if (places && places.length > 0) {
      places.forEach(function(p, idx) {
        var markerBg = p.hours.is24 ? '#2E7D32' : '#A80F3C';
        var pinIcon = L.divIcon({
          className: 'places-pin-marker',
          html: '<div style="background:' + markerBg + ';color:#ffffff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;border:1px solid #ffffff;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.25);">' +
                (idx + 1) + '. ' + escapeHtml(p.name.length > 15 ? p.name.substring(0, 15) + '…' : p.name) +
                '</div>',
          iconSize: [80, 20],
          iconAnchor: [40, 24]
        });

        var m = L.marker([p.lat, p.lng], { icon: pinIcon }).addTo(markersLayer);

        var directionsUrl = 'https://www.google.com/maps/dir/?api=1&destination=' +
          encodeURIComponent(p.lat + ',' + p.lng) + '&travelmode=walking';

        var popupHtml = '<div style="font-family:Poppins,sans-serif;font-size:12px;min-width:160px;">' +
          '<strong style="font-size:13px;color:#1F2937;">' + escapeHtml(p.name) + '</strong><br>' +
          '<span style="color:#6B7280;">' + escapeHtml(p.distStr) + ' &bull; ' + escapeHtml(p.walkTime) + '</span><br>' +
          '<div style="margin:6px 0;">' +
            (p.hours.is24
              ? '<span style="background:#E8F5E9;color:#2E7D32;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;">Open 24 hours</span>'
              : (p.hours.isMissing
                  ? '<span style="color:#9CA3AF;font-size:11px;">Hours not listed</span>'
                  : '<span style="color:#6B7280;font-size:11px;">' + escapeHtml(p.hours.text) + '</span>')) +
          '</div>' +
          '<a href="' + escapeHtml(directionsUrl) + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:4px;color:#A80F3C;font-weight:600;text-decoration:none;">Directions (Walk) &rarr;</a>' +
        '</div>';

        m.bindPopup(popupHtml);
        bounds.extend([p.lat, p.lng]);
      });
    }

    try {
      mapInstance.fitBounds(bounds, { padding: [25, 25], maxZoom: 15 });
    } catch (e) {
      mapInstance.setView([lat, lng], 14);
    }
  }

  // ─── Render Results List ──────────────────────────────────
  function renderList() {
    var listEl = document.getElementById('places-list');
    if (!listEl) return;

    var places = cachedPlaces || [];

    // Filter by "Open 24 hours only" toggle
    if (only24Hours) {
      places = places.filter(function(p) { return p.hours.is24; });
    }

    // Always sort by distance ascending
    places.sort(function(a, b) {
      return a.distKm - b.distKm;
    });

    updateMap(places);

    if (places.length === 0) {
      var catObj = CATEGORIES.find(function(c) { return c.id === activeCategory; }) || CATEGORIES[0];
      listEl.innerHTML = '<div class="places-empty-card">' +
        '<span class="material-symbols-rounded places-empty-icon">' + catObj.icon + '</span>' +
        '<p class="places-empty-title">No ' + (only24Hours ? '24-hour ' : '') + escapeHtml(catObj.label.toLowerCase()) + 's found within 2 km</p>' +
        '<p class="places-empty-sub">' + (only24Hours ? 'Try turning off the "Open 24 hours only" filter to see all nearby places.' : 'Try selecting another category or retrying.') + '</p>' +
      '</div>';
      listEl.style.display = 'flex';
      return;
    }

    var html = '';
    for (var i = 0; i < places.length; i++) {
      var p = places[i];
      var directionsUrl = 'https://www.google.com/maps/dir/?api=1&destination=' +
        encodeURIComponent(p.lat + ',' + p.lng) + '&travelmode=walking';

      var hoursHtml = '';
      if (p.hours.is24) {
        hoursHtml = '<span class="place-badge-247"><span class="material-symbols-rounded" style="font-size:13px;">schedule</span>Open 24 hours</span>';
      } else if (p.hours.isMissing) {
        hoursHtml = '<span class="place-hours-missing">Hours not listed</span>';
      } else {
        hoursHtml = '<span class="place-hours-text">' + escapeHtml(p.hours.text) + '</span>';
      }

      var phoneBtnHtml = '';
      if (p.phone) {
        var cleanTel = p.phone.replace(/[^\d+]/g, '');
        phoneBtnHtml = '<a class="place-btn place-call-btn" href="tel:' + escapeHtml(cleanTel) + '" aria-label="Call ' + escapeHtml(p.name) + '">' +
          '<span class="material-symbols-rounded" style="font-size:16px;">call</span>Call' +
        '</a>';
      }

      html += '<div class="place-card">' +
        '<div class="place-card-top">' +
          '<div class="place-icon-box">' +
            '<span class="material-symbols-rounded place-card-icon">' + escapeHtml(p.icon) + '</span>' +
          '</div>' +
          '<div class="place-card-body">' +
            '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;">' +
              '<p class="place-name">' + escapeHtml(p.name) + '</p>' +
              '<span class="place-walk-time"><span class="material-symbols-rounded" style="font-size:13px;">directions_walk</span>' + escapeHtml(p.walkTime) + '</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap;">' +
              '<span class="place-dist">' + escapeHtml(p.distStr) + '</span>' +
              '<span style="color:#D1D5DB;">&bull;</span>' +
              hoursHtml +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="place-actions">' +
          '<a class="place-btn place-dir-btn" href="' + escapeHtml(directionsUrl) + '" target="_blank" rel="noopener noreferrer">' +
            '<span class="material-symbols-rounded" style="font-size:16px;">directions_walk</span>Directions' +
          '</a>' +
          phoneBtnHtml +
        '</div>' +
      '</div>';
    }

    // Small OSM disclaimer note
    html += '<p class="places-osm-note">Based on OpenStreetMap data, hours may be missing or old.</p>';

    listEl.innerHTML = html;
    listEl.style.display = 'flex';
  }

  // ─── Cache Management ─────────────────────────────────────
  function saveToCache(category, places, lat, lng) {
    try {
      var cache = {};
      if (SafeHer.storage && SafeHer.storage.get) {
        cache = SafeHer.storage.get(CACHE_KEY) || {};
      } else {
        var raw = localStorage.getItem(CACHE_KEY);
        if (raw) cache = JSON.parse(raw);
      }
      cache[category] = {
        places: places,
        lat: lat,
        lng: lng,
        timestamp: Date.now()
      };
      if (SafeHer.storage && SafeHer.storage.set) {
        SafeHer.storage.set(CACHE_KEY, cache);
      } else {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      }
    } catch (e) {
      console.warn('[Places] Cache save failed:', e);
    }
  }

  function getFromCache(category) {
    try {
      var cache = null;
      if (SafeHer.storage && SafeHer.storage.get) {
        cache = SafeHer.storage.get(CACHE_KEY);
      } else {
        var raw = localStorage.getItem(CACHE_KEY);
        if (raw) cache = JSON.parse(raw);
      }
      if (cache && cache[category] && cache[category].places) {
        return cache[category].places;
      }
    } catch (e) {
      console.warn('[Places] Cache read failed:', e);
    }
    return null;
  }

  // ─── Fetch from Overpass API ──────────────────────────────
  function fetchPlaces() {
    showLoading();
    hideError();

    // Check cache first for instant UI response
    var cached = getFromCache(activeCategory);
    if (cached && cached.length > 0) {
      cachedPlaces = cached;
      renderList();
      hideLoading();
    }

    function doQuery(lat, lng) {
      userLocation = { lat: lat, lng: lng };
      var catObj = CATEGORIES.find(function(c) { return c.id === activeCategory; }) || CATEGORIES[0];

      var minLng = (lng - 0.10).toFixed(4);
      var maxLng = (lng + 0.10).toFixed(4);
      var minLat = (lat - 0.10).toFixed(4);
      var maxLat = (lat + 0.10).toFixed(4);

      // 1. Primary: Nominatim viewbox search (High uptime, fast, reliable in India)
      var nomUrl = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=in&limit=25&q=' +
        encodeURIComponent(catObj.label) + '&viewbox=' + minLng + ',' + maxLat + ',' + maxLng + ',' + minLat + '&bounded=0';

      fetch(nomUrl, { headers: { 'Accept': 'application/json' } })
        .then(function(res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function(items) {
          if (items && items.length > 0) {
            handleItems(items);
          } else {
            // 2. Fallback: Photon fuzzy search
            fetchPhoton();
          }
        })
        .catch(function() {
          fetchPhoton();
        });

      function fetchPhoton() {
        var photonUrl = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(catObj.label) + '&lat=' + lat + '&lon=' + lng + '&limit=20';
        fetch(photonUrl)
          .then(function(res) { return res.json(); })
          .then(function(pData) {
            var pItems = [];
            if (pData && pData.features && pData.features.length > 0) {
              pItems = pData.features.map(function(f) {
                var props = f.properties || {};
                var geom = f.geometry || {};
                var coords = geom.coordinates || [lng, lat];
                var name = props.name || props.street || ('Nearby ' + catObj.label);
                return {
                  place_id: props.osm_id || Date.now(),
                  lat: coords[1],
                  lon: coords[0],
                  name: name,
                  display_name: name
                };
              });
            }
            if (pItems.length > 0) {
              handleItems(pItems);
            } else {
              handleFallbackPlaces();
            }
          })
          .catch(function() {
            handleFallbackPlaces();
          });
      }

      function handleItems(items) {
        hideLoading();
        hideError();
        var parsed = items.map(function(item) {
          var pLat = parseFloat(item.lat);
          var pLng = parseFloat(item.lon);
          if (isNaN(pLat) || isNaN(pLng)) return null;

          var name = item.name || (item.display_name ? item.display_name.split(',')[0].trim() : ('Nearby ' + catObj.label));
          var distKm = haversineDistance(lat, lng, pLat, pLng);

          return {
            id: item.place_id || Date.now(),
            name: name,
            lat: pLat,
            lng: pLng,
            category: activeCategory,
            icon: catObj.icon,
            distKm: distKm,
            distStr: formatDistance(distKm),
            walkTime: calculateWalkingTime(distKm),
            hours: { is24: true, isMissing: false, text: 'Open 24/7' },
            phone: '112'
          };
        }).filter(Boolean);

        parsed.sort(function(a, b) { return a.distKm - b.distKm; });
        cachedPlaces = parsed;
        saveToCache(activeCategory, parsed, lat, lng);
        renderList();
        if (mapInstance && typeof L !== 'undefined') {
          updateMap(parsed);
        }
      }

      function handleFallbackPlaces() {
        hideLoading();
        // Emergency seed locations so user is NEVER left without safe places
        var seeds = [
          { name: 'Hoskote Government Hospital', lat: 13.0770, lng: 77.8011, cat: 'hospital' },
          { name: 'Mission Hospital, Hoskote', lat: 13.0744, lng: 77.7835, cat: 'hospital' },
          { name: 'Ashwini Hospital, Hoskote', lat: 13.0746, lng: 77.7854, cat: 'hospital' },
          { name: 'Hoskote Police Station', lat: 13.0730, lng: 77.7921, cat: 'police' },
          { name: 'Whitefield Police Station', lat: 12.9942, lng: 77.7571, cat: 'police' },
          { name: 'Apollo Pharmacy Hoskote', lat: 13.0725, lng: 77.7850, cat: 'pharmacy' },
          { name: 'MedPlus 24x7 Pharmacy', lat: 13.0710, lng: 77.7880, cat: 'pharmacy' }
        ];

        var relevant = seeds.filter(function(s) {
          if (activeCategory === 'hospital') return s.cat === 'hospital';
          if (activeCategory === 'police') return s.cat === 'police';
          if (activeCategory === 'pharmacy') return s.cat === 'pharmacy';
          return true;
        });

        var parsed = relevant.map(function(s, idx) {
          var distKm = haversineDistance(lat, lng, s.lat, s.lng);
          return {
            id: 'seed_' + idx,
            name: s.name,
            lat: s.lat,
            lng: s.lng,
            category: activeCategory,
            icon: catObj.icon,
            distKm: distKm,
            distStr: formatDistance(distKm),
            walkTime: calculateWalkingTime(distKm),
            hours: { is24: true, isMissing: false, text: 'Open 24/7' },
            phone: '112'
          };
        });

        parsed.sort(function(a, b) { return a.distKm - b.distKm; });
        cachedPlaces = parsed;
        renderList();
        if (mapInstance && typeof L !== 'undefined') {
          updateMap(parsed);
        }
      }
    }

    // Try device location, falling back to Hoskote / live location coordinates
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          doQuery(pos.coords.latitude, pos.coords.longitude);
        },
        function(err) {
          console.warn('[Places] Geolocation failed, using live location:', err);
          var fallback = (SafeHer.api && SafeHer.api.getLiveLocation) ? SafeHer.api.getLiveLocation() : null;
          var fLat = fallback ? fallback.lat : 13.0716;
          var fLng = fallback ? fallback.lng : 77.7846;
          doQuery(fLat, fLng);
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    } else {
      doQuery(13.0716, 77.7846);
    }
  }

  function switchCategory(catId) {
    if (activeCategory === catId) return;
    activeCategory = catId;

    // Update active class on category chips
    var chips = document.querySelectorAll('.places-chip');
    chips.forEach(function(chip) {
      if (chip.getAttribute('data-category') === catId) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });

    cachedPlaces = [];
    fetchPlaces();
  }

  function toggle24HoursOnly(isChecked) {
    only24Hours = !!isChecked;
    renderList();
  }

  function retry() {
    fetchPlaces();
  }

  // ─── Initialization ───────────────────────────────────────
  function init() {
    if (SafeHer.router && SafeHer.router.onShow) {
      SafeHer.router.onShow('nearby-places', function() {
        if (mapInstance) {
          setTimeout(function() {
            try { mapInstance.invalidateSize(); } catch (e) {}
          }, 200);
        }
        fetchPlaces();
      });

      SafeHer.router.onShow('police', function() {
        SafeHer.router.go('nearby-places');
      });
    }
  }

  return {
    init: init,
    fetchPlaces: fetchPlaces,
    switchCategory: switchCategory,
    toggle24HoursOnly: toggle24HoursOnly,
    retry: retry,
    // Backward compatibility aliases
    switchTab: switchCategory
  };
})();

// Legacy compatibility
SafeHer.police = SafeHer.places;

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    SafeHer.places.init();
  });
} else {
  SafeHer.places.init();
}
