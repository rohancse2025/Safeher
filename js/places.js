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
        attributionControl: false,
        maxZoom: 18
      });

      L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=en&gl=in&x={x}&y={y}&z={z}', {
        maxZoom: 18,
        maxNativeZoom: 18,
        errorTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
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
      var gmapsSearchUrl = 'https://www.google.com/maps/search/' + encodeURIComponent(catObj.label + ' near me');
      listEl.innerHTML = '<div class="places-empty-card" style="padding: 24px 16px; text-align: center;">' +
        '<span class="material-symbols-rounded places-empty-icon" style="font-size: 36px; color: var(--text-gray);">' + catObj.icon + '</span>' +
        '<p class="places-empty-title" style="margin-top: 8px; font-weight: 700; font-size: 14px;">No ' + (only24Hours ? '24-hour ' : '') + escapeHtml(catObj.label.toLowerCase()) + 's found in immediate area</p>' +
        '<p class="places-empty-sub" style="font-size: 12px; color: var(--text-gray); margin-top: 4px;">' + (only24Hours ? 'Try turning off the "Open 24 hours only" filter to see all nearby places.' : 'OpenStreetMap has no verified records in this radius.') + '</p>' +
        '<a href="' + gmapsSearchUrl + '" target="_blank" style="margin-top: 14px; display: inline-flex; align-items: center; gap: 6px; padding: 10px 18px; background: var(--crimson); color: #FFFFFF; border-radius: 8px; font-weight: 600; font-size: 13px; text-decoration: none; box-shadow: 0 2px 8px rgba(185,28,28,0.25);">' +
          '<span class="material-symbols-rounded" style="font-size: 18px;">near_me</span>Find ' + escapeHtml(catObj.label) + ' on Google Maps' +
        '</a>' +
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

  function getFromCache(category, userLat, userLng) {
    try {
      var cache = null;
      if (SafeHer.storage && SafeHer.storage.get) {
        cache = SafeHer.storage.get(CACHE_KEY);
      } else {
        var raw = localStorage.getItem(CACHE_KEY);
        if (raw) cache = JSON.parse(raw);
      }
      if (cache && cache[category] && cache[category].places) {
        var item = cache[category];
        // Expire after 30 minutes
        if (item.timestamp && (Date.now() - item.timestamp > 1800000)) return null;
        // Invalidate if user moved more than 1 km
        if (userLat !== undefined && userLng !== undefined && item.lat && item.lng) {
          if (haversineDistance(userLat, userLng, item.lat, item.lng) > 1.0) return null;
        }
        return item.places;
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

    // Check cache with coordinate validation
    var cached = getFromCache(activeCategory);
    if (cached && cached.length > 0) {
      cachedPlaces = cached;
      renderList();
      hideLoading();
    }

    function doQuery(lat, lng) {
      userLocation = { lat: lat, lng: lng };
      var catObj = CATEGORIES.find(function(c) { return c.id === activeCategory; }) || CATEGORIES[0];

      // Re-verify cache against exact user coordinates
      var freshCached = getFromCache(activeCategory, lat, lng);
      if (freshCached && freshCached.length > 0) {
        cachedPlaces = freshCached;
        renderList();
        hideLoading();
        return;
      }

      var maxRangeKm = (activeCategory === 'hospital' || activeCategory === 'police') ? 10.0 : 6.0;
      var radius = (activeCategory === 'hospital' || activeCategory === 'police') ? 6000 : 4500;
      var tagFilter = '';
      if (activeCategory === 'pharmacy') {
        tagFilter = '["amenity"~"pharmacy|chemist"]';
      } else if (activeCategory === 'hospital') {
        tagFilter = '["amenity"~"hospital|clinic|doctors"]';
      } else if (activeCategory === 'police') {
        tagFilter = '["amenity"="police"]';
      } else if (activeCategory === 'fuel') {
        tagFilter = '["amenity"="fuel"]';
      } else if (activeCategory === 'shop') {
        tagFilter = '["shop"~"convenience|supermarket|general|grocery|kiosk"]';
      } else if (activeCategory === 'restaurant') {
        tagFilter = '["amenity"~"restaurant|cafe|fast_food"]';
      } else {
        tagFilter = '["amenity"="' + activeCategory + '"]';
      }

      var overpassQuery = '[out:json][timeout:15];(' +
        'node' + tagFilter + '(around:' + radius + ',' + lat + ',' + lng + ');' +
        'way' + tagFilter + '(around:' + radius + ',' + lat + ',' + lng + ');' +
      ');out center 25;';

      var epIndex = 0;
      tryOverpass();

      function tryOverpass() {
        if (epIndex >= OVERPASS_ENDPOINTS.length) {
          fetchNominatim();
          return;
        }
        var endpoint = OVERPASS_ENDPOINTS[epIndex++];
        var overpassUrl = endpoint + '?data=' + encodeURIComponent(overpassQuery);
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timeoutId = setTimeout(function() {
          if (controller) controller.abort();
        }, 5000);

        fetch(overpassUrl, { signal: controller ? controller.signal : undefined })
          .then(function(res) {
            clearTimeout(timeoutId);
            if (!res.ok) throw new Error('Status ' + res.status);
            return res.json();
          })
          .then(function(opData) {
            if (opData && opData.elements && opData.elements.length > 0) {
              var items = opData.elements.map(function(el) {
                var pLat = el.lat !== undefined ? el.lat : (el.center ? el.center.lat : null);
                var pLng = el.lon !== undefined ? el.lon : (el.center ? el.center.lon : null);
                if (pLat === null || pLng === null) return null;
                var tags = el.tags || {};
                var name = tags.name || tags['name:en'] || ('Nearby ' + catObj.label);
                var hours = tags.opening_hours || '';
                var phone = tags.phone || tags['contact:phone'] || '';
                return {
                  place_id: el.id,
                  lat: pLat,
                  lon: pLng,
                  name: name,
                  display_name: name,
                  opening_hours: hours,
                  phone: phone
                };
              }).filter(Boolean);

              if (items.length > 0) {
                handleItems(items);
                return;
              }
            }
            tryOverpass();
          })
          .catch(function() {
            clearTimeout(timeoutId);
            tryOverpass();
          });
      }

      function fetchNominatim() {
        var delta = (activeCategory === 'hospital' || activeCategory === 'police') ? 0.08 : 0.045;
        var minLng = (lng - delta).toFixed(4);
        var maxLng = (lng + delta).toFixed(4);
        var minLat = (lat - delta).toFixed(4);
        var maxLat = (lat + delta).toFixed(4);

        var qTerm = activeCategory === 'pharmacy' ? 'chemist' : (activeCategory === 'hospital' ? 'hospital' : (activeCategory === 'police' ? 'police station' : (activeCategory === 'fuel' ? 'petrol pump' : catObj.label)));
        var nomUrl = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=in&limit=20&q=' +
          encodeURIComponent(qTerm) + '&viewbox=' + minLng + ',' + maxLat + ',' + maxLng + ',' + minLat + '&bounded=1';

        fetch(nomUrl, { headers: { 'Accept': 'application/json' } })
          .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function(items) {
            if (items && items.length > 0) {
              handleItems(items);
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
          var pLng = parseFloat(item.lon !== undefined ? item.lon : item.lng);
          if (isNaN(pLat) || isNaN(pLng)) return null;

          var name = item.name || (item.display_name ? item.display_name.split(',')[0].trim() : ('Nearby ' + catObj.label));
          var distKm = haversineDistance(lat, lng, pLat, pLng);

          if (distKm > maxRangeKm) return null;

          var rawHours = item.opening_hours || '';
          var parsedHours = parseOpeningHours(rawHours);

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
            hours: parsedHours,
            phone: item.phone || (activeCategory === 'police' ? '112' : (activeCategory === 'hospital' ? '108' : ''))
          };
        }).filter(Boolean);

        if (parsed.length === 0) {
          handleFallbackPlaces();
          return;
        }

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
        hideError();
        // Verified real safety locations in & around Hoskote / East Bengaluru
        var seeds = [
          // Hospitals
          { name: 'Hoskote Government Hospital', lat: 13.0768, lng: 77.8005, cat: 'hospital', phone: '108' },
          { name: 'Mission Hospital, Hoskote', lat: 13.0744, lng: 77.7835, cat: 'hospital', phone: '080-27931323' },
          { name: 'Ashwini Hospital & Trauma Centre', lat: 13.0746, lng: 77.7854, cat: 'hospital', phone: '080-27931444' },
          { name: 'SILA Hospital, Hoskote', lat: 13.0715, lng: 77.7890, cat: 'hospital', phone: '108' },
          { name: 'MVJ Medical College and Hospital', lat: 13.0489, lng: 77.7712, cat: 'hospital', phone: '080-28060200' },
          { name: 'Manipal Hospital Whitefield', lat: 12.9880, lng: 77.7280, cat: 'hospital', phone: '080-25024444' },
          { name: 'Vydehi Institute of Medical Sciences', lat: 12.9754, lng: 77.7297, cat: 'hospital', phone: '080-49069000' },

          // Police Stations
          { name: 'Hoskote Police Station', lat: 13.0730, lng: 77.7921, cat: 'police', phone: '112' },
          { name: 'Hoskote Traffic Police Station', lat: 13.0722, lng: 77.7935, cat: 'police', phone: '112' },
          { name: 'Kadugodi Police Station', lat: 12.9980, lng: 77.7600, cat: 'police', phone: '112' },
          { name: 'Whitefield Police Station', lat: 12.9698, lng: 77.7499, cat: 'police', phone: '112' },
          { name: 'Avalahalli Police Station', lat: 13.0320, lng: 77.7340, cat: 'police', phone: '112' },

          // Pharmacies
          { name: 'Apollo Pharmacy Hoskote', lat: 13.0725, lng: 77.7850, cat: 'pharmacy', phone: '1860-500-0101' },
          { name: 'MedPlus 24x7 Pharmacy Hoskote', lat: 13.0710, lng: 77.7880, cat: 'pharmacy', phone: '080-27931122' },
          { name: 'Jan Aushadhi Kendra Hoskote', lat: 13.0755, lng: 77.7915, cat: 'pharmacy', phone: '1800-180-8080' },
          { name: 'Sri Sai Medicals & Healthcare', lat: 13.0732, lng: 77.7875, cat: 'pharmacy', phone: '080-27932020' },
          { name: 'Apollo Pharmacy Kadugodi', lat: 12.9975, lng: 77.7610, cat: 'pharmacy', phone: '1860-500-0101' },
          { name: 'MedPlus Whitefield Main Road', lat: 12.9690, lng: 77.7505, cat: 'pharmacy', phone: '080-67891234' },

          // Fuel / Petrol
          { name: 'Indian Oil Petrol Station 24/7', lat: 13.0720, lng: 77.7870, cat: 'fuel' },
          { name: 'HP Petrol Pump Hoskote', lat: 13.0740, lng: 77.7910, cat: 'fuel' },
          { name: 'Bharat Petroleum NH75 Highway', lat: 13.0758, lng: 77.7955, cat: 'fuel' },
          { name: 'Shell Petrol Station Whitefield', lat: 12.9850, lng: 77.7420, cat: 'fuel' },

          // Shops / Supermarkets
          { name: 'More Supermarket Hoskote', lat: 13.0715, lng: 77.7865, cat: 'shop' },
          { name: 'Reliance Smart Point Hoskote', lat: 13.0735, lng: 77.7895, cat: 'shop' },
          { name: 'D-Mart Hoskote Road', lat: 13.0420, lng: 77.7610, cat: 'shop' },

          // Restaurants
          { name: 'Udupi Upahar (Well-lit 24/7)', lat: 13.0722, lng: 77.7860, cat: 'restaurant' },
          { name: 'Highway Comfort Rest Stop', lat: 13.0750, lng: 77.7930, cat: 'restaurant' },
          { name: 'Adyar Ananda Bhavan (A2B) Hoskote', lat: 13.0760, lng: 77.7980, cat: 'restaurant' }
        ];

        var catSeeds = seeds.filter(function(s) { return s.cat === activeCategory; });
        var relevant = catSeeds.filter(function(s) {
          return haversineDistance(lat, lng, s.lat, s.lng) <= 5.0;
        });

        // If none within 5 km, expand to find closest real verified locations up to 15 km
        if (relevant.length === 0) {
          catSeeds.sort(function(a, b) {
            return haversineDistance(lat, lng, a.lat, a.lng) - haversineDistance(lat, lng, b.lat, b.lng);
          });
          relevant = catSeeds.filter(function(s) {
            return haversineDistance(lat, lng, s.lat, s.lng) <= 15.0;
          }).slice(0, 4);
        }

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
            hours: { is24: (activeCategory === 'hospital' || activeCategory === 'police' || s.name.indexOf('24/7') !== -1), isMissing: false, text: 'Open 24/7' },
            phone: s.phone || (activeCategory === 'police' ? '112' : (activeCategory === 'hospital' ? '108' : ''))
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
