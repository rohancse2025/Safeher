// js/escort.js – Escort Mode: safe journey tracking with route deviation, stationary detection, and automated check-ins

// Part 1 & Part 2: Destination Search (Nominatim), OSRM routing, settings, active journey screen with Web Audio beep, Wake Lock & auto-escalation



SafeHer.escort = (function() {

  'use strict';



  // ─── Internal State ─────────────────────────────────────────

  var activeEscort = null;

  var setupMap = null;

  var activeMap = null;



  var savedLoc = (window.SafeHer && SafeHer.getLastLocation) ? SafeHer.getLastLocation() : null;

  var userOrigin = (savedLoc && savedLoc.lat) ? { lat: savedLoc.lat, lng: savedLoc.lng } : { lat: 12.9716, lng: 77.5946 };

  var currentDest = null; // { lat: number, lng: number, name: string }

  var currentRoutePoints = []; // Array of [lat, lng]

  var selectedCheckin = '10'; // 5, 10, 15, 30 or 'off'

  var selectedDeviation = 200; // 100, 200, 300, 500

  var isPickingOnMap = false;

  var currentTravelMode = 'driving'; // 'driving', 'walking', 'transit'

  var userOverrodeMode = false;



  var polylineLayer = null;

  var startMarker = null;

  var destMarker = null;

  var setupUserMarker = null;

  var setupUserHalo = null;

  var promptModalTimer = null;



  var activePolylineLayer = null;

  var activeUserMarker = null;

  var activeDestMarker = null;



  var gpsWatchId = null;

  var pollIntervalId = null;

  var uiSecondTimer = null;

  var lastSentPositionTime = 0;



  // Local behaviour tracking

  var wakeLock = null;

  var offRouteStartedAt = null;

  var stationaryAnchor = null; // { lat, lng, time }

  var promptModalOpen = false;

  var arrivalPromptShown = false;

  var checkinModalTimer = null;

  var checkinSecsRemaining = 60;

  var lastEndedEscortId = null;



  function isNightModeIST() {

    var now = new Date();

    var istHours;

    try {

      var istStr = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false, hour: 'numeric' });

      istHours = parseInt(istStr, 10);

    } catch (e) {

      var utcHours = now.getUTCHours();

      var utcMins = now.getUTCMinutes();

      var totalIstMins = (utcHours * 60 + utcMins + 330) % 1440;

      istHours = Math.floor(totalIstMins / 60);

    }

    return istHours >= 20 || istHours < 6;

  }



  function applyNightModeDefaults() {

    var badge = document.getElementById('escort-night-mode-badge');

    if (isNightModeIST()) {

      if (badge) badge.style.display = 'flex';



      selectedCheckin = '5';

      var chkContainer = document.getElementById('escort-checkin-chips');

      if (chkContainer) {

        chkContainer.querySelectorAll('.escort-chip').forEach(function(b) {

          b.classList.remove('active');

          if (b.dataset.value === '5') b.classList.add('active');

        });

      }



      selectedDeviation = 150;

      var devContainer = document.getElementById('escort-deviation-chips');

      if (devContainer) {

        devContainer.querySelectorAll('.escort-chip').forEach(function(b) {

          b.classList.remove('active');

          if (b.dataset.value === '150') b.classList.add('active');

        });

      }

    } else {

      if (badge) badge.style.display = 'none';

    }

  }





  // ─── Helpers ────────────────────────────────────────────────

  function escapeHtml(str) {

    if (str === null || str === undefined) return '';

    return String(str)

      .replace(/&/g, '&amp;')

      .replace(/</g, '&lt;')

      .replace(/>/g, '&gt;')

      .replace(/"/g, '&quot;')

      .replace(/'/g, '&#39;');

  }



  function haversineDistM(lat1, lon1, lat2, lon2) {

    var R = 6371000;

    var dLat = (lat2 - lat1) * Math.PI / 180;

    var dLon = (lon2 - lon1) * Math.PI / 180;

    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +

            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *

            Math.sin(dLon / 2) * Math.sin(dLon / 2);

    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;

  }



  // Equirectangular projection for point-to-segment perpendicular distance in meters

  function pointToSegmentDistM(pLat, pLng, aLat, aLng, bLat, bLng) {

    var midLatRad = ((aLat + bLat) / 2.0) * Math.PI / 180.0;

    var cosLat = Math.cos(midLatRad);

    var R = 6371000.0;



    var ax = 0.0;

    var ay = 0.0;

    var bx = (bLng - aLng) * (Math.PI / 180.0) * cosLat * R;

    var by = (bLat - aLat) * (Math.PI / 180.0) * R;



    var px = (pLng - aLng) * (Math.PI / 180.0) * cosLat * R;

    var py = (pLat - aLat) * (Math.PI / 180.0) * R;



    var dx = bx - ax;

    var dy = by - ay;

    var segLenSq = dx * dx + dy * dy;



    if (segLenSq < 1e-6) {

      return Math.hypot(px - ax, py - ay);

    }



    var t = ((px - ax) * dx + (py - ay) * dy) / segLenSq;

    var tClamped = Math.max(0.0, Math.min(1.0, t));



    var closestX = ax + tClamped * dx;

    var closestY = ay + tClamped * dy;



    return Math.hypot(px - closestX, py - closestY);

  }



  function pointToRouteDistM(pLat, pLng, points) {

    if (!points || points.length === 0) return 0;

    if (points.length === 1) return haversineDistM(pLat, pLng, points[0][0], points[0][1]);



    var minD = Infinity;

    for (var i = 0; i < points.length - 1; i++) {

      var d = pointToSegmentDistM(pLat, pLng, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);

      if (d < minD) minD = d;

    }

    return minD;

  }



  function parseDateUtc(str) {

    if (!str) return null;

    try {

      var clean = String(str).trim().replace(' ', 'T');

      if (clean.indexOf('Z') === -1 && clean.indexOf('+') === -1) {

        clean += 'Z';

      }

      var d = new Date(clean);

      return isNaN(d.getTime()) ? null : d;

    } catch (e) {

      return null;

    }

  }



  // ─── Web Audio API Beep & Vibration ────────────────────────

  function playCheckinBeep() {

    try {

      var AudioCtx = window.AudioContext || window.webkitAudioContext;

      if (!AudioCtx) return;

      var ctx = new AudioCtx();

      var osc = ctx.createOscillator();

      var gain = ctx.createGain();

      osc.type = 'sine';

      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5 pitch

      gain.gain.setValueAtTime(0.3, ctx.currentTime);

      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);

      osc.connect(gain);

      gain.connect(ctx.destination);

      osc.start();

      osc.stop(ctx.currentTime + 0.4);

    } catch (e) {}

  }



  function triggerVibration() {

    try {

      if (navigator.vibrate) {

        navigator.vibrate([200, 100, 200, 100, 300]);

      }

    } catch (e) {}

  }



  // ─── Screen Wake Lock API ──────────────────────────────────

  async function requestWakeLock() {

    try {

      if ('wakeLock' in navigator && !wakeLock) {

        wakeLock = await navigator.wakeLock.request('screen');

        wakeLock.addEventListener('release', function() {

          wakeLock = null;

        });

      }

    } catch (err) {}

  }



  function releaseWakeLock() {

    if (wakeLock) {

      wakeLock.release().catch(function() {});

      wakeLock = null;

    }

  }



  document.addEventListener('visibilitychange', function() {

    if (document.visibilityState === 'visible' && activeEscort && !wakeLock) {

      requestWakeLock();

    }

  });



  // ─── LocalStorage Persistence ──────────────────────────────

  function saveActiveEscortToStorage() {

    if (!activeEscort) return;

    try {

      localStorage.setItem('safeher_active_escort', JSON.stringify({

        escort: activeEscort,

        dest: currentDest,

        route: currentRoutePoints

      }));

    } catch (e) {}

  }



  function clearActiveEscortFromStorage() {

    try {

      localStorage.removeItem('safeher_active_escort');

    } catch (e) {}

  }



  function loadActiveEscortFromStorage() {

    try {

      var raw = localStorage.getItem('safeher_active_escort');

      if (!raw) return null;

      return JSON.parse(raw);

    } catch (e) {

      return null;

    }

  }



  function getStoredOrigin() {

    try {

      if (SafeHer.api && SafeHer.api.getLiveLocation) {

        var loc = SafeHer.api.getLiveLocation();

        if (loc && loc.lat && loc.lng) {

          userOrigin = { lat: parseFloat(loc.lat), lng: parseFloat(loc.lng) };

        }

      }

    } catch (e) {}

  }



  var setupWatchId = null;



  function refreshUserOrigin(callback) {

    if (navigator.geolocation) {

      navigator.geolocation.getCurrentPosition(

        function(pos) {

          userOrigin = { lat: pos.coords.latitude, lng: pos.coords.longitude };

          if (SafeHer.api && SafeHer.api.setLiveLocation) {

            SafeHer.api.setLiveLocation(pos.coords.latitude, pos.coords.longitude);

          }

          if (callback) callback(userOrigin, pos.coords.accuracy);

        },

        function(err) {

          console.warn('[GPS] High accuracy timed out, trying network location:', err);

          // If high accuracy GPS timed out (e.g. indoors), try network/cell tower location

          navigator.geolocation.getCurrentPosition(

            function(netPos) {

              userOrigin = { lat: netPos.coords.latitude, lng: netPos.coords.longitude };

              if (callback) callback(userOrigin, netPos.coords.accuracy);

            },

            function() {

              if (callback) callback(userOrigin, 100);

            },

            { enableHighAccuracy: false, timeout: 6000, maximumAge: 0 }

          );

        },

        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }

      );

    } else {

      if (callback) callback(userOrigin, 100);

    }

  }



  function startSetupMapGpsWatch() {

    if (!navigator.geolocation) return;

    if (setupWatchId) navigator.geolocation.clearWatch(setupWatchId);

    setupWatchId = navigator.geolocation.watchPosition(

      function(pos) {

        var lat = pos.coords.latitude;

        var lng = pos.coords.longitude;

        var acc = pos.coords.accuracy;

        var movedFar = !userOrigin || Math.abs(userOrigin.lat - lat) > 0.0005 || Math.abs(userOrigin.lng - lng) > 0.0005;

        userOrigin = { lat: lat, lng: lng };

        if (window.SafeHer && SafeHer.setLastLocation) {

          SafeHer.setLastLocation(lat, lng);

        }

        updateSetupUserMarker(lat, lng, acc);

        if (movedFar && !currentDest && setupMap) {

          setupMap.panTo([lat, lng]);

        }

      },

      function() {},

      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }

    );

  }



  // ??? Setup Map Initialization (Google Maps Style with Live Blue Dot) ?

  function updateSetupUserMarker(lat, lng, accuracy) {

    if (!setupMap || typeof L === 'undefined') return;



    if (!setupUserHalo) {

      setupUserHalo = L.circle([lat, lng], {

        radius: Math.max(25, accuracy || 35),

        color: '#4285F4',

        fillColor: '#4285F4',

        fillOpacity: 0.15,

        weight: 1.5

      }).addTo(setupMap);

    } else {

      setupUserHalo.setLatLng([lat, lng]);

      if (accuracy) setupUserHalo.setRadius(Math.max(25, accuracy));

    }



    if (!setupUserMarker) {

      setupUserMarker = L.circleMarker([lat, lng], {

        radius: 8,

        fillColor: '#4285F4',

        color: '#ffffff',

        weight: 3,

        opacity: 1,

        fillOpacity: 1

      }).addTo(setupMap).bindPopup("You are here (Current Location)");

    } else {

      setupUserMarker.setLatLng([lat, lng]);

    }

  }



  function recenterMap() {

    if (!setupMap) return;

    if (SafeHer.toast) SafeHer.toast("Finding your exact GPS location...");

    refreshUserOrigin(function(origin, acc) {

      updateSetupUserMarker(origin.lat, origin.lng, acc);

      setupMap.flyTo([origin.lat, origin.lng], 17, { animate: true, duration: 0.8 });

      if (SafeHer.toast) SafeHer.toast("Centered on your live location");

    });

  }



  function initSetupMap() {

    var container = document.getElementById('escort-setup-map');

    if (!container) return;



    if (!setupMap && typeof L !== 'undefined') {

      setupMap = L.map('escort-setup-map', {

        zoomControl: true,

        attributionControl: false,

        maxZoom: 18

      }).setView([userOrigin.lat, userOrigin.lng], 16);



      L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=en&gl=in&x={x}&y={y}&z={z}', {

        maxZoom: 18,

        maxNativeZoom: 18,

        errorTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',

        subdomains: ['0', '1', '2', '3']

      }).addTo(setupMap);



      // Tap ANYWHERE on the map at any time to set / change destination (Google Maps style)

      setupMap.on('click', function(e) {

        setDestinationFromLatLng(e.latlng.lat, e.latlng.lng);

      });

    }



    updateSetupUserMarker(userOrigin.lat, userOrigin.lng);

    startSetupMapGpsWatch();



    // Immediately fetch high accuracy GPS and center street-level view

    refreshUserOrigin(function(origin) {

      updateSetupUserMarker(origin.lat, origin.lng);

      if (!currentDest && setupMap) {

        setupMap.setView([origin.lat, origin.lng], 16);

      }

    });



    if (setupMap) {

      setTimeout(function() {

        setupMap.invalidateSize();

      }, 250);

    }

  }



    // ─── Pick on Map Toggle ────────────────────────────────────

  function togglePickOnMap(forceVal) {

    if (typeof forceVal === 'boolean') {

      isPickingOnMap = forceVal;

    } else {

      isPickingOnMap = !isPickingOnMap;

    }



    var btn = document.getElementById('escort-pick-map-btn');

    var hint = document.getElementById('escort-pick-hint');



    if (btn) {

      if (isPickingOnMap) {

        btn.classList.add('btn-primary', 'btn-crimson');

        btn.classList.remove('btn-secondary');

        btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;margin-right:4px;">touch_app</span> Tapping map...';

      } else {

        btn.classList.remove('btn-primary', 'btn-crimson');

        btn.classList.add('btn-secondary');

        btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;margin-right:4px;">pin_drop</span> Pick on map';

      }

    }



    if (hint) {

      hint.style.display = isPickingOnMap ? 'block' : 'none';

    }



    if (setupMap) {

      setupMap.invalidateSize();

    }

  }



  function setDestinationFromLatLng(lat, lng) {

    togglePickOnMap(false);

    var latFixed = parseFloat(lat).toFixed(5);

    var lngFixed = parseFloat(lng).toFixed(5);

    var defaultName = 'Location (' + latFixed + ', ' + lngFixed + ')';



    var input = document.getElementById('escort-dest-input');

    if (input) input.value = 'Locating street...';



    currentDest = { lat: parseFloat(lat), lng: parseFloat(lng), name: defaultName };



    var revUrl = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&zoom=18&addressdetails=1&accept-language=en';

    fetch(revUrl, { headers: { 'Accept': 'application/json' } })

      .then(function(res) { return res.json(); })

      .then(function(data) {

        if (data && (data.display_name || data.address)) {

          var addr = data.address || {};

          var primary = data.name || addr.amenity || addr.school || addr.hospital || addr.shop || addr.building || addr.road || addr.neighbourhood || addr.suburb;

          var road = addr.road || addr.neighbourhood || addr.suburb || addr.town || addr.city || '';

          var fullTitle = '';

          if (primary && road && primary !== road) {

            fullTitle = primary + ', ' + road;

          } else if (primary) {

            fullTitle = primary;

          } else if (data.display_name) {

            fullTitle = data.display_name.split(',').slice(0, 3).join(', ').trim();

          }

          currentDest.name = fullTitle || defaultName;

          if (input) input.value = currentDest.name;

        } else {

          if (input) input.value = defaultName;

        }

        fetchRoute();

      })

      .catch(function() {

        if (input) input.value = defaultName;

        fetchRoute();

      });

  }



  // ??? Destination Search (Photon Fuzzy Geocoder + Nominatim Multilingual Fallback) ?

  function searchDestination(queryOverride) {

    var input = document.getElementById('escort-dest-input');

    var resultsBox = document.getElementById('escort-search-results');

    var btn = document.getElementById('escort-search-btn');

    if (!input || !resultsBox) return;



    if (queryOverride && typeof queryOverride === 'string') {

      input.value = queryOverride;

    }



    var rawQuery = (input.value || '').trim();

    if (!rawQuery) {

      if (SafeHer.toast) SafeHer.toast('Please enter a destination or tap map above');

      return;

    }



    // Strip conversational keywords like "near", "nearby", "approx", "100m" so search finds POIs

    var cleanedQuery = rawQuery.replace(/\b(near\s+me|nearby|near|around|close\s+to|approx\.?|\d+\s*m|\d+\s*meters?)\b/gi, '').replace(/\s+/g, ' ').trim();

    var queryToSearch = cleanedQuery || rawQuery;



    if (btn) {

      btn.disabled = true;

      btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px;">hourglass_top</span> ...';

    }



    resultsBox.style.display = 'block';

    resultsBox.innerHTML = '<div style="padding:10px 12px;font-size:12px;color:var(--text-gray);"><span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle;margin-right:4px;">travel_explore</span>Searching places nearby...</div>';



    var originLat = userOrigin ? userOrigin.lat : null;

    var originLng = userOrigin ? userOrigin.lng : null;

    if ((!originLat || !originLng) && SafeHer.api && SafeHer.api.getLiveLocation) {

      var liveLoc = SafeHer.api.getLiveLocation();

      if (liveLoc && liveLoc.lat) {

        originLat = parseFloat(liveLoc.lat);

        originLng = parseFloat(liveLoc.lng);

        userOrigin = { lat: originLat, lng: originLng };

      }

    }



    // Parallel Multi-Source Search: Biased Photon + Global Photon + Nominatim (English)
    var photonBiased = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(queryToSearch) +
      (originLat && originLng ? ('&lat=' + originLat + '&lon=' + originLng) : '') + '&limit=15';
    var photonGlobal = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(queryToSearch) + '&limit=15';
    var nomUrl = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=in&accept-language=en&limit=15&q=' + encodeURIComponent(queryToSearch);

    function parsePhotonFeatures(pData) {
      if (!pData || !pData.features) return [];
      return pData.features.map(function(f) {
        var props = f.properties || {};
        var geom = f.geometry || {};
        var coords = geom.coordinates || [0, 0];
        var parts = [];
        if (props.name) parts.push(props.name);
        if (props.street) parts.push(props.street);
        if (props.city || props.town || props.county) parts.push(props.city || props.town || props.county);
        if (props.state) parts.push(props.state);
        return {
          lat: coords[1],
          lon: coords[0],
          name: props.name || parts[0] || 'Landmark',
          display_name: parts.join(', ') || props.name || 'Location'
        };
      });
    }

    Promise.allSettled([
      fetch(photonBiased).then(function(r) { return r.json(); }).then(parsePhotonFeatures).catch(function() { return []; }),
      fetch(photonGlobal).then(function(r) { return r.json(); }).then(parsePhotonFeatures).catch(function() { return []; }),
      fetch(nomUrl, { headers: { 'Accept': 'application/json' } }).then(function(r) { return r.json(); }).catch(function() { return []; })
    ]).then(function(settled) {
      var combined = [];
      var seen = {};

      settled.forEach(function(res) {
        if (res.status === 'fulfilled' && Array.isArray(res.value)) {
          res.value.forEach(function(item) {
            var iLat = parseFloat(item.lat);
            var iLon = parseFloat(item.lon);
            if (isNaN(iLat) || isNaN(iLon)) return;
            var key = iLat.toFixed(4) + '_' + iLon.toFixed(4);
            if (!seen[key]) {
              seen[key] = true;
              combined.push(item);
            }
          });
        }
      });

      renderResults(combined);
    }).catch(function() {
      renderResults([]);
    });



    function renderResults(items) {

      if (btn) {

        btn.disabled = false;

        btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px;">search</span> Search';

      }



      var html = '';



      // Always include a one-tap map pin shortcut at top of results

      html += '<div onclick="SafeHer.escort.togglePickOnMap(true)" style="padding:10px 12px;background:#FFF0F3;border-bottom:1.5px solid #FBCFE8;cursor:pointer;display:flex;align-items:center;gap:8px;">' +

        '<span class="material-symbols-rounded" style="color:var(--crimson);font-size:20px;">pin_drop</span>' +

        '<div style="font-size:12px;font-weight:600;color:var(--crimson);">Pick exact destination on map (e.g. 100m away)</div>' +

      '</div>';



      if (!items || items.length === 0) {

        html += '<div style="padding:14px 12px;text-align:center;">' +

          '<div style="font-size:12px;font-weight:600;color:#9E1B32;margin-bottom:4px;">No named landmark found for "' + escapeHtml(rawQuery) + '"</div>' +

          '<div style="font-size:11px;color:var(--text-gray);margin-bottom:10px;">For near places (~100m), tap "Pick on map" to set your pin directly on the building.</div>' +

          '<button type="button" class="btn btn-crimson" onclick="SafeHer.escort.togglePickOnMap(true)" style="padding:6px 14px;font-size:12px;height:32px;border-radius:16px;margin:0 auto;display:inline-flex;align-items:center;gap:4px;">' +

            '<span class="material-symbols-rounded" style="font-size:16px;">pin_drop</span> Tap Map to Select Location' +

          '</button>' +

        '</div>';

        resultsBox.innerHTML = html;

        return;

      }



      // Rank items by keyword match relevance first, then proximity
      var qWords = queryToSearch.toLowerCase().split(/\s+/).filter(Boolean);

      items.forEach(function(item) {
        var itemLat = parseFloat(item.lat);
        var itemLng = parseFloat(item.lon);
        var nameLower = (item.display_name || '').toLowerCase();

        var matchScore = 0;
        qWords.forEach(function(w) {
          if (w.length > 2 && nameLower.indexOf(w) !== -1) {
            matchScore += 2;
          }
        });

        if (originLat && originLng && !isNaN(itemLat) && !isNaN(itemLng)) {
          item._distM = haversineDistM(originLat, originLng, itemLat, itemLng);
        } else {
          item._distM = 999999999;
        }
        item._matchScore = matchScore;
      });

      items.sort(function(a, b) {
        if (b._matchScore !== a._matchScore) {
          return b._matchScore - a._matchScore;
        }
        return a._distM - b._distM;
      });



      items.forEach(function(item, idx) {

        var name = item.display_name;

        var shortName = item.display_name.split(',').slice(0, 3).join(',').trim();

        var distBadge = '';

        if (item._distM < 999999999) {

          var distText = item._distM < 1000 ? (Math.round(item._distM) + ' m') : ((item._distM / 1000).toFixed(1) + ' km');

          distBadge = ' <span style="font-size:11px;font-weight:600;color:#9E1B32;background:#FFE4E6;padding:1px 6px;border-radius:10px;margin-left:6px;"><span class="material-symbols-rounded" style="font-size:12px;vertical-align:middle;margin-right:2px;">near_me</span>' + distText + '</span>';

        }

        html += '<div class="escort-search-item" data-index="' + idx + '" style="padding:8px 12px;border-bottom:1px solid #f1f1f1;cursor:pointer;">' +

          '<div style="font-weight:600;color:var(--crimson);display:flex;align-items:center;justify-content:space-between;">' +

            '<span>' + escapeHtml(shortName) + '</span>' + distBadge +

          '</div>' +

          '<div style="font-size:11px;color:var(--text-gray);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(name) + '</div>' +

        '</div>';

      });

      resultsBox.innerHTML = html;



      var rowEls = resultsBox.querySelectorAll('.escort-search-item');

      rowEls.forEach(function(rowEl) {

        rowEl.addEventListener('click', function() {

          var i = parseInt(rowEl.dataset.index, 10);

          var selected = items[i];

          if (!selected) return;



          var shortName = selected.display_name.split(',').slice(0, 3).join(',').trim();

          input.value = shortName || selected.display_name;

          currentDest = {

            lat: parseFloat(selected.lat),

            lng: parseFloat(selected.lon),

            name: shortName || selected.display_name

          };

          resultsBox.style.display = 'none';

          fetchRoute();

        });

      });

    }

  }



    // ─── Travel Mode Selection ────────────────────────────────

  function setTravelMode(mode, fromClick) {

    if (fromClick) userOverrodeMode = true;

    currentTravelMode = mode || 'driving';

    ['driving', 'walking', 'transit'].forEach(function(m) {

      var btn = document.getElementById('escort-mode-' + m);

      if (btn) {

        if (m === currentTravelMode) btn.classList.add('active');

        else btn.classList.remove('active');

      }

    });

    var autoBadge = document.getElementById('escort-mode-auto-badge');

    if (autoBadge) {

      autoBadge.style.display = (!userOverrodeMode) ? 'inline-block' : 'none';

    }

    if (currentDest) {

      fetchRoute();

    }

  }



  // ─── OSRM Route Fetching & Display ──────────────────────────

  function fetchRoute() {

    if (!currentDest || currentDest.lat === undefined || currentDest.lng === undefined) {

      return;

    }



    var warningBox = document.getElementById('escort-route-warning');

    var infoBox = document.getElementById('escort-route-info');

    var profileLabel = document.getElementById('escort-route-profile-label');

    var distLabel = document.getElementById('escort-route-distance');

    var minsInput = document.getElementById('escort-expected-mins');



    if (warningBox) warningBox.style.display = 'none';



    refreshUserOrigin(function(origin) {

      var startLat = origin.lat;

      var startLng = origin.lng;

      var destLat = currentDest.lat;

      var destLng = currentDest.lng;



      var directDistM = haversineDistM(startLat, startLng, destLat, destLng);

      var directKm = directDistM / 1000.0;



      // Unhide travel mode options

      var modeWrap = document.getElementById('escort-travel-mode-wrap');

      if (modeWrap) modeWrap.style.display = 'block';



      // Auto-detect realistic travel mode based on distance if user has not overridden

      if (!userOverrodeMode) {

        currentTravelMode = (directKm > 2.5) ? 'driving' : 'walking';

        ['driving', 'walking', 'transit'].forEach(function(m) {

          var btn = document.getElementById('escort-mode-' + m);

          if (btn) {

            if (m === currentTravelMode) btn.classList.add('active');

            else btn.classList.remove('active');

          }

        });

        var autoBadge = document.getElementById('escort-mode-auto-badge');

        if (autoBadge) autoBadge.style.display = 'inline-block';

      }



      // Check walk safety warning (walking alone > 5 km is a high safety concern)

      var walkWarn = document.getElementById('escort-walk-warning');

      var walkWarnKm = document.getElementById('escort-walk-warn-km');

      if (walkWarn) {

        if (currentTravelMode === 'walking' && directKm > 5.0) {

          if (walkWarnKm) walkWarnKm.textContent = directKm.toFixed(1) + ' km';

          walkWarn.style.display = 'block';

        } else {

          walkWarn.style.display = 'none';

        }

      }



      var osrmProfile = (currentTravelMode === 'walking') ? 'walking' : 'driving';

      var osrmUrl = 'https://router.project-osrm.org/route/v1/' + osrmProfile + '/' +

        startLng + ',' + startLat + ';' + destLng + ',' + destLat +

        '?overview=full&geometries=geojson';



      fetchWithTimeout(osrmUrl, 7000)

        .then(function(res) {

          if (!res.ok) throw new Error(osrmProfile + ' route HTTP ' + res.status);

          return res.json();

        })

        .then(function(data) {

          if (data && data.code === 'Ok' && data.routes && data.routes.length > 0) {

            var label = (currentTravelMode === 'driving') ? 'Auto / Cab (~30 km/h)' :

                        (currentTravelMode === 'transit') ? 'Public Transit (~22 km/h)' :

                        'Walking (Footpath ~4.5 km/h)';

            applyRouteData(data.routes[0], label, null);

          } else {

            throw new Error('OSRM route unavailable');

          }

        })

        .catch(function() {

          var fallbackProfile = (osrmProfile === 'walking') ? 'driving' : 'walking';

          var fallbackUrl = 'https://router.project-osrm.org/route/v1/' + fallbackProfile + '/' +

            startLng + ',' + startLat + ';' + destLng + ',' + destLat +

            '?overview=full&geometries=geojson';



          fetchWithTimeout(fallbackUrl, 6000)

            .then(function(res2) {

              if (!res2.ok) throw new Error('Fallback HTTP ' + res2.status);

              return res2.json();

            })

            .then(function(drvData) {

              if (drvData && drvData.code === 'Ok' && drvData.routes && drvData.routes.length > 0) {

                applyRouteData(drvData.routes[0], 'Approximate route (' + fallbackProfile + ')', null);

              } else {

                throw new Error('Fallback failed');

              }

            })

            .catch(function() {

              var directPoints = [[startLat, startLng], [destLat, destLng]];

              var estMins;

              if (currentTravelMode === 'driving') {

                estMins = Math.max(5, Math.round((directKm / 30.0) * 60 + 3));

              } else if (currentTravelMode === 'transit') {

                estMins = Math.max(10, Math.round((directKm / 22.0) * 60 + 8));

              } else {

                estMins = Math.max(3, Math.round((directKm / 4.5) * 60));

              }



              applyStraightLineRoute(

                directPoints,

                directDistM,

                estMins,

                'Could not calculate road route from OSRM. Direct path used for tracking.'

              );

            });

        });

    });



    function applyRouteData(routeObj, label, warningMsg) {

      var coords = routeObj.geometry.coordinates || [];

      currentRoutePoints = coords.map(function(pt) {

        return [pt[1], pt[0]];

      });



      if (currentRoutePoints.length < 2) {

        currentRoutePoints = [[userOrigin.lat, userOrigin.lng], [currentDest.lat, currentDest.lng]];

      }



      var distM = routeObj.distance || haversineDistM(userOrigin.lat, userOrigin.lng, currentDest.lat, currentDest.lng);

      var distKm = distM / 1000.0;

      var durMins;



      if (currentTravelMode === 'driving') {

        durMins = Math.max(5, Math.round((distKm / 30.0) * 60 + 3));

      } else if (currentTravelMode === 'transit') {

        durMins = Math.max(10, Math.round((distKm / 22.0) * 60 + 8));

      } else {

        durMins = Math.max(3, Math.round((distKm / 4.5) * 60));

      }



      if (profileLabel) profileLabel.textContent = label;

      if (distLabel) {

        distLabel.textContent = distM >= 1000 ? distKm.toFixed(1) + ' km' : Math.round(distM) + ' m';

      }

      if (minsInput) minsInput.value = durMins;



      var etaText = document.getElementById('escort-route-eta-text');

      if (etaText) {

        var etaTime = new Date(Date.now() + durMins * 60000);

        etaText.textContent = etaTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + durMins + ' min)';

      }



      if (warningBox) {

        if (warningMsg) {

          warningBox.textContent = warningMsg;

          warningBox.style.display = 'block';

        } else {

          warningBox.style.display = 'none';

        }

      }



      if (infoBox) infoBox.style.display = 'block';



      renderSetupMapRoute(currentRoutePoints);

    }



    function applyStraightLineRoute(points, distM, estMins, warningMsg) {

      currentRoutePoints = points;

      var distKm = distM / 1000.0;

      if (profileLabel) profileLabel.textContent = 'Direct Path Route';

      if (distLabel) {

        distLabel.textContent = distM >= 1000 ? distKm.toFixed(1) + ' km' : Math.round(distM) + ' m';

      }

      if (minsInput) minsInput.value = estMins;



      var etaText = document.getElementById('escort-route-eta-text');

      if (etaText) {

        var etaTime = new Date(Date.now() + estMins * 60000);

        etaText.textContent = etaTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + estMins + ' min)';

      }



      if (warningBox) {

        warningBox.textContent = warningMsg;

        warningBox.style.display = 'block';

      }



      if (infoBox) infoBox.style.display = 'block';



      renderSetupMapRoute(currentRoutePoints);

    }

  }



  function fetchWithTimeout(url, timeoutMs) {

    if (typeof AbortController === 'undefined') {

      return fetch(url);

    }

    var controller = new AbortController();

    var id = setTimeout(function() { controller.abort(); }, timeoutMs);

    return fetch(url, { signal: controller.signal })

      .finally(function() { clearTimeout(id); });

  }



  function renderSetupMapRoute(routePoints) {

    if (!setupMap || typeof L === 'undefined' || !routePoints || routePoints.length === 0) return;



    if (polylineLayer) setupMap.removeLayer(polylineLayer);

    if (startMarker) setupMap.removeLayer(startMarker);

    if (destMarker) setupMap.removeLayer(destMarker);



    var startPt = routePoints[0];

    var endPt = routePoints[routePoints.length - 1];



    startMarker = L.circleMarker(startPt, {

      radius: 7,

      fillColor: '#10B981',

      color: '#ffffff',

      weight: 2,

      opacity: 1,

      fillOpacity: 1

    }).addTo(setupMap).bindPopup('Start: Your location');



    destMarker = L.marker(endPt, {

      draggable: true

    }).addTo(setupMap).bindPopup('Destination: ' + escapeHtml((currentDest && currentDest.name) || 'Destination'));



    destMarker.on('dragend', function(e) {

      var pos = e.target.getLatLng();

      setDestinationFromLatLng(pos.lat, pos.lng);

    });



    polylineLayer = L.polyline(routePoints, {

      color: '#9E1B32',

      weight: 5,

      opacity: 0.85,

      lineCap: 'round',

      lineJoin: 'round'

    }).addTo(setupMap);



    setupMap.fitBounds(polylineLayer.getBounds(), { padding: [30, 30], maxZoom: 17 });

  }



  // ─── Settings Controls ─────────────────────────────────────

  function selectCheckin(btn) {

    var container = document.getElementById('escort-checkin-chips');

    if (container) {

      container.querySelectorAll('.escort-chip').forEach(function(b) {

        b.classList.remove('active');

      });

    }

    btn.classList.add('active');

    selectedCheckin = btn.dataset.value;

  }



  function selectDeviation(btn) {

    var container = document.getElementById('escort-deviation-chips');

    if (container) {

      container.querySelectorAll('.escort-chip').forEach(function(b) {

        b.classList.remove('active');

      });

    }

    btn.classList.add('active');

    selectedDeviation = parseInt(btn.dataset.value, 10) || 200;

  }



  function loadContactsList() {

    var listEl = document.getElementById('escort-contacts-list');

    if (!listEl) return;



    if (!SafeHer.api || !SafeHer.api.getContacts) {

      renderEmptyContacts(listEl);

      return;

    }



    SafeHer.api.getContacts(function(err, contacts) {

      var list = (contacts && Array.isArray(contacts)) ? contacts : [];

      if (list.length === 0) {

        renderEmptyContacts(listEl);

        return;

      }



      var html = '';

      list.forEach(function(c) {

        var isClose = !!(c.is_close || c.close || (c.relation && /emergency|family|parent|spouse|close|mom|dad/i.test(c.relation)));



        html += '<label class="escort-contact-row" style="cursor:pointer;">' +

          '<input type="checkbox" class="escort-contact-cb" value="' + c.id + '" checked style="accent-color:var(--crimson);width:16px;height:16px;" />' +

          '<div style="flex:1;min-width:0;">' +

            '<div style="font-size:13px;font-weight:600;color:var(--text-dark);">' +

              escapeHtml(c.name) +

              (isClose ? ' <span style="font-size:10px;background:#FFE4E6;color:#9E1B32;padding:2px 6px;border-radius:10px;font-weight:700;">Close</span>' : '') +

            '</div>' +

            '<div style="font-size:11px;color:var(--text-gray);">' + escapeHtml(c.phone || c.email || '') + '</div>' +

          '</div>' +

        '</label>';

      });

      listEl.innerHTML = html;

    });

  }



  function renderEmptyContacts(listEl) {

    listEl.innerHTML = 

      '<div style="padding:12px 8px;text-align:center;background:#FFF9FA;border-radius:8px;">' +

        '<div style="display:inline-flex;align-items:center;gap:6px;color:#9E1B32;font-size:12px;font-weight:600;margin-bottom:6px;">' +

          '<span class="material-symbols-rounded" style="font-size:18px;">shield</span> Solo Journey Protection' +

        '</div>' +

        '<p style="font-size:11px;color:var(--text-gray);margin:0 0 10px 0;line-height:1.4;">' +

          'No contacts added yet. Your phone will actively monitor your route, detect abnormal stops, and sound local alarms.' +

        '</p>' +

        '<button type="button" class="btn btn-outline" onclick="SafeHer.escort.addDemoContact()" style="padding:6px 14px;font-size:11px;font-weight:600;color:var(--crimson);border-color:var(--crimson);width:auto;margin:0 auto;display:inline-flex;align-items:center;gap:5px;cursor:pointer;">' +

          '<span class="material-symbols-rounded" style="font-size:16px;">person_add</span> + Add Sample Contact (Mom)' +

        '</button>' +

      '</div>';

  }



  function addDemoContact() {

    var sample = {

      name: 'Mom (Trusted Contact)',

      phone: '+91 98765 43210',

      email: 'mom.safeher@example.com',

      relationship: 'Family',

      is_close: true,

      close: 1

    };



    if (SafeHer.api && SafeHer.api.addContact) {

      SafeHer.api.addContact(sample, function() {

        if (SafeHer.toast) SafeHer.toast('Sample contact added and pre-selected!');

        loadContactsList();

      });

    } else {

      var all = (SafeHer.storage && SafeHer.storage.get('contacts')) || [];

      sample.id = Date.now();

      all.push(sample);

      if (SafeHer.storage) SafeHer.storage.set('contacts', all);

      if (SafeHer.toast) SafeHer.toast('Sample contact added and pre-selected!');

      loadContactsList();

    }

  }



  // ─── Start Escort Journey ──────────────────────────────────

  function startEscort() {

    if (!currentDest || currentDest.lat === undefined) {

      if (SafeHer.toast) SafeHer.toast('Please choose a destination first');

      return;

    }



    var minsInput = document.getElementById('escort-expected-mins');

    var expectedMinutes = parseInt(minsInput ? minsInput.value : 30, 10);

    if (!expectedMinutes || expectedMinutes < 1) expectedMinutes = 10;



    var startBtn = document.getElementById('escort-start-btn');

    if (startBtn) {

      startBtn.disabled = true;

      startBtn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px;">hourglass_top</span> Starting Escort...';

    }



    var checkedIds = [];

    document.querySelectorAll('.escort-contact-cb:checked').forEach(function(cb) {

      var val = parseInt(cb.value, 10);

      if (val) checkedIds.push(val);

    });



    var routePayload = currentRoutePoints.length >= 2 ? currentRoutePoints : [

      [userOrigin.lat, userOrigin.lng],

      [currentDest.lat, currentDest.lng]

    ];



    var payload = {

      destination: currentDest.name,

      dest_name: currentDest.name,

      dest_lat: currentDest.lat,

      dest_lng: currentDest.lng,

      route: routePayload,

      expected_minutes: expectedMinutes,

      checkin_interval: selectedCheckin === 'off' ? null : parseInt(selectedCheckin, 10),

      deviation_distance: selectedDeviation,

      contact_ids: checkedIds,

      contacts: SafeHer.storage.get('contacts') || []

    };



    SafeHer.api.createEscort(payload, function(err, result) {

      if (startBtn) {

        startBtn.disabled = false;

        startBtn.innerHTML = '<span class="material-symbols-rounded" style="margin-right:6px;">route</span>Start Escort';

      }



      // Autonomous Local Guardian Fallback when offline or server unreachable

      if (err || !result || !result.id) {

        console.warn('[Escort] Backend unreachable or unauthenticated (' + err + '). Starting Autonomous Local Guardian.');

        var localId = 'local_' + Date.now();

        var localEscort = {

          id: localId,

          is_local_only: true,

          user_id: 'local_user',

          dest_name: currentDest.name,

          dest_lat: currentDest.lat,

          dest_lng: currentDest.lng,

          route: routePayload,

          route_distance_m: haversineDistM(userOrigin.lat, userOrigin.lng, currentDest.lat, currentDest.lng),

          started_at: new Date().toISOString(),

          expected_end: new Date(Date.now() + expectedMinutes * 60000).toISOString(),

          status: 'On route',

          checkin_interval_min: selectedCheckin === 'off' ? null : parseInt(selectedCheckin, 10),

          deviation_m: selectedDeviation,

          tokens: {},

          share_links: {}

        };



        var shareMsg = encodeURIComponent("I started a journey to " + currentDest.name + ". Expected arrival: " + (document.getElementById('escort-route-eta-text') ? document.getElementById('escort-route-eta-text').textContent : (expectedMinutes + ' mins')) + ". Tracking via SafeHer.");

        localEscort.share_links['local'] = 'https://wa.me/?text=' + shareMsg;



        activeEscort = localEscort;

        saveActiveEscortToStorage();

        requestWakeLock();



        if (SafeHer.toast) SafeHer.toast('🛡️ Solo Guardian Active! Your phone is actively tracking your journey.');

        showActiveView(localEscort);

        return;

      }



      activeEscort = result;

      saveActiveEscortToStorage();

      requestWakeLock();



      if (SafeHer.toast) SafeHer.toast('Escort Mode started! Live tracking link sent.');

      showActiveView(result);

    });

  }



  // ─── Active Journey View & Realtime Tracking ───────────────

  function showActiveView(escortData) {

    var setupView = document.getElementById('escort-setup-view');

    var activeView = document.getElementById('escort-active-view');

    if (setupView) setupView.style.display = 'none';

    if (activeView) activeView.style.display = 'block';



    var destNameEl = document.getElementById('escort-active-dest-name');

    if (destNameEl) destNameEl.textContent = escortData.dest_name || 'Destination';



    if (!currentDest) {

      currentDest = {

        lat: escortData.dest_lat,

        lng: escortData.dest_lng,

        name: escortData.dest_name

      };

    }



    // Status chip

    updateActiveStatusChip(escortData.status || 'On route');



    // Share buttons

    renderActiveShareList(escortData);



    // Active Map

    initActiveMap(escortData);



    // Request Screen Wake Lock

    requestWakeLock();



    // Start Realtime GPS tracking and periodic monitor

    startActiveTracking(escortData.id);



    // Start 1-second countdown timer for UI ETA and next check-in

    startUiSecondTimer();

  }



  function renderActiveShareList(escortData) {
    var container = document.getElementById('escort-active-share-list');
    if (!container) return;

    var tokens = escortData.tokens || {};
    var shareLinks = escortData.share_links || {};
    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : null;
    var userName = (user && user.name) ? user.name : 'I';
    var dest = escortData.dest_name || 'destination';

    var etaStr = 'soon';
    if (escortData.expected_end) {
      var endDt = parseDateUtc(escortData.expected_end);
      if (endDt) {
        etaStr = endDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    }

    SafeHer.api.getContacts(function(err, contacts) {
      contacts = contacts || [];
      var chosenContacts = contacts;
      if (escortData.contact_ids && escortData.contact_ids.length > 0) {
        chosenContacts = contacts.filter(function(c) {
          return escortData.contact_ids.indexOf(c.id) !== -1;
        });
        if (chosenContacts.length === 0) chosenContacts = contacts;
      }

      var firstToken = Object.values(tokens)[0] || '';
      var primaryLink = Object.values(shareLinks)[0] || (window.location.origin + '/track.html?t=' + firstToken);
      var msgText = userName + ' started a journey to ' + dest + ', expected by ' + etaStr + '. Track live here: ' + primaryLink;

      if (SafeHer.deliveryTracker && SafeHer.deliveryTracker.mount) {
        SafeHer.deliveryTracker.mount({
          containerId: 'escort-active-share-list',
          contacts: chosenContacts,
          isEscortOrTimer: true,
          isOffline: !!escortData.is_local_only,
          trackingUrl: primaryLink,
          messageText: msgText,
          eventKeyPrefix: escortData.id ? ('escort:' + escortData.id + ':') : 'escort:',
          entityId: escortData.id
        });
      }
    });
  }



  function initActiveMap(escortData) {

    var container = document.getElementById('escort-active-map');

    if (!container || typeof L === 'undefined') return;



    if (!activeMap) {

      activeMap = L.map('escort-active-map', {

        zoomControl: true,

        attributionControl: false,

        maxZoom: 18

      }).setView([escortData.dest_lat, escortData.dest_lng], 14);



      L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=en&gl=in&x={x}&y={y}&z={z}', {

        maxZoom: 18,

        maxNativeZoom: 18,

        errorTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',

        subdomains: ['0', '1', '2', '3']

      }).addTo(activeMap);

    }



    setTimeout(function() { activeMap.invalidateSize(); }, 250);



    if (activePolylineLayer) activeMap.removeLayer(activePolylineLayer);

    if (activeDestMarker) activeMap.removeLayer(activeDestMarker);



    activeDestMarker = L.circleMarker([escortData.dest_lat, escortData.dest_lng], {

      radius: 9,

      fillColor: '#9E1B32',

      color: '#ffffff',

      weight: 2,

      opacity: 1,

      fillOpacity: 1

    }).addTo(activeMap).bindPopup('Destination: ' + escapeHtml(escortData.dest_name || ''));



    if (currentRoutePoints && currentRoutePoints.length >= 2) {

      activePolylineLayer = L.polyline(currentRoutePoints, {

        color: '#9E1B32',

        weight: 5,

        opacity: 0.85

      }).addTo(activeMap);



      activeMap.fitBounds(activePolylineLayer.getBounds(), { padding: [30, 30], maxZoom: 17 });

    }

  }



  // ─── Realtime GPS & Background Position Reporting ───────────

  function startActiveTracking(escortId) {

    stopActiveTracking();



    if (navigator.geolocation) {

      gpsWatchId = navigator.geolocation.watchPosition(

        function(pos) {

          var lat = pos.coords.latitude;

          var lng = pos.coords.longitude;

          updateActiveUserMarker(lat, lng);

          updateProgressDisplay(lat, lng);



          // Local off-route check

          handlePositionOffRouteCheck(lat, lng);



          // Local stationary check

          handleStationaryCheck(lat, lng);



          // Local arrival check

          handleArrivalCheck(lat, lng);



          // Send position to backend every 10 seconds

          var now = Date.now();

          if (now - lastSentPositionTime >= 10000) {

            lastSentPositionTime = now;

            if (activeEscort && !activeEscort.is_local_only) {

              SafeHer.api.sendEscortPosition(escortId, { lat: lat, lng: lng }, function(err, res) {

                if (res && res.status) {

                  if (activeEscort) {

                    activeEscort.status = res.status;

                    if (res.alert_id) activeEscort.alert_id = res.alert_id;

                    saveActiveEscortToStorage();

                  }

                  updateActiveStatusChip(res.status);

                }

              });

            }

          }

        },

        function(err) {

          console.warn('[Escort GPS Watch Error]', err);

        },

        { enableHighAccuracy: true, maximumAge: 5000 }

      );

    }



    // Status polling every 5 seconds (monitors status & contact check-in pings)

    pollIntervalId = setInterval(function() {
      checkEscortResponses();
      if (!activeEscort || !activeEscort.id) return;

      if (activeEscort.is_local_only) {

        // Local check for late arrival

        if (activeEscort.expected_end) {

          var expTime = new Date(activeEscort.expected_end).getTime();

          var nowMs = Date.now();

          if (nowMs > expTime + 10 * 60000 && activeEscort.status !== 'Alerted') {

            activeEscort.status = 'Alerted';

            updateActiveStatusChip('Alerted');

            playBuzzerSound();

            if (SafeHer.toast) SafeHer.toast('⚠️ Late Arrival: Expected time exceeded by 10 mins!');

          }

        }

        return;

      }

      SafeHer.api.getEscort(activeEscort.id, function(err, escort) {

        if (escort) {

          activeEscort.status = escort.status;

          activeEscort.next_checkin_due = escort.next_checkin_due;

          activeEscort.last_checkin_at = escort.last_checkin_at;

          activeEscort.expected_end = escort.expected_end;

          activeEscort.alert_id = escort.alert_id;

          saveActiveEscortToStorage();



          updateActiveStatusChip(escort.status);



          // Check if a contact requested a check-in

          if (escort.checkin_requested_at) {

            var chkModal = document.getElementById('escort-checkin-modal');

            if (chkModal && chkModal.style.display !== 'flex' && !checkinModalTimer) {

              showCheckinModal(escort.checkin_requested_by);

            }

          }



          if (escort.status === 'arrived' || escort.status === 'ended') {

            var endId = activeEscort.id;

            stopActiveTracking();

            stopUiSecondTimer();

            releaseWakeLock();

            clearActiveEscortFromStorage();

            activeEscort = null;

            arrivalPromptShown = false;



            SafeHer.api.getEscortSummary(endId, function(err, summary) {

              showSummaryView(summary || {}, endId);

            });

          }

        }

      });

    }, 5000);

  }



  function stopActiveTracking() {

    if (gpsWatchId !== null && navigator.geolocation) {

      navigator.geolocation.clearWatch(gpsWatchId);

      gpsWatchId = null;

    }

    if (pollIntervalId !== null) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }

    receivedEscortResponses = [];
    var card = document.getElementById('escort-contact-responses-card');
    if (card) card.style.display = 'none';
  }

  // ─── Contact Responses Tracking in Escort Mode ─────────────
  var receivedEscortResponses = [];

  function checkEscortResponses() {
    if (!activeEscort) return;

    try {
      var raw = localStorage.getItem('safeher_response_update');
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.status && (Date.now() - parsed.time < 3600000)) {
          addEscortResponseItem(parsed);
        }
      }
    } catch(e) {}

    var token = (activeEscort.tokens && Object.values(activeEscort.tokens)[0]) || '';
    if (token && window.SafeHerConfig && window.SafeHerConfig.API_BASE) {
      fetch(window.SafeHerConfig.API_BASE.replace(/\/+$/, '') + '/api/track/' + encodeURIComponent(token))
        .then(function(res) { return res.json(); })
        .then(function(json) {
          if (json && json.ok && json.data && json.data.contact_responses) {
            json.data.contact_responses.forEach(function(r) {
              addEscortResponseItem(r);
            });
          }
        })
        .catch(function() {});
    }
  }

  function addEscortResponseItem(resp) {
    var exists = false;
    var respTime = resp.time || resp.timestamp || Date.now();
    for (var i = 0; i < receivedEscortResponses.length; i++) {
      if (receivedEscortResponses[i].status === resp.status && Math.abs(receivedEscortResponses[i].time - respTime) < 5000) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      receivedEscortResponses.unshift({
        name: resp.name || resp.contact || 'Emergency Contact',
        status: resp.status,
        time: respTime
      });
      renderEscortContactResponses();

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

  function renderEscortContactResponses() {
    var card = document.getElementById('escort-contact-responses-card');
    var list = document.getElementById('escort-contact-responses-list');
    var badge = document.getElementById('escort-responses-count-badge');
    if (!card || !list) return;

    if (receivedEscortResponses.length === 0) {
      card.style.display = 'none';
      return;
    }

    card.style.display = 'block';
    if (badge) badge.textContent = receivedEscortResponses.length + (receivedEscortResponses.length === 1 ? ' response' : ' responses');

    var statusLabels = {
      'watching': '👀 Watching your live trip',
      'called': '📞 Called you',
      'on_my_way': '🏃 On the way to you',
      'safe_with_me': '✅ Safe with me / Reached',
      'alerted_police': '🚓 Alerted police',
      'cannot_reach': '⚠️ Cannot reach'
    };

    var html = '';
    for (var i = 0; i < receivedEscortResponses.length; i++) {
      var r = receivedEscortResponses[i];
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
      var bcEscort = new BroadcastChannel('safeher_cross_tab');
      bcEscort.onmessage = function(ev) {
        if (ev && ev.data && ev.data.status) {
          addEscortResponseItem(ev.data);
        }
      };
    }
  } catch(e) {}



  function updateActiveUserMarker(lat, lng) {

    if (!activeMap || typeof L === 'undefined') return;



    if (!activeUserMarker) {

      activeUserMarker = L.circleMarker([lat, lng], {

        radius: 8,

        fillColor: '#3B82F6',

        color: '#ffffff',

        weight: 2,

        opacity: 1,

        fillOpacity: 1

      }).addTo(activeMap).bindPopup("You are here");

    } else {

      activeUserMarker.setLatLng([lat, lng]);

    }

  }



  function updateProgressDisplay(userLat, userLng) {

    if (!activeEscort || !currentDest || currentDest.lat === undefined) return;

    var remDist = haversineDistM(userLat, userLng, currentDest.lat, currentDest.lng);

    var totalDist = activeEscort.route_distance_m || 1000;



    if (!activeEscort._startDist) {

      activeEscort._startDist = Math.max(remDist, totalDist);

    }

    var walked = Math.max(0, activeEscort._startDist - remDist);

    var pct = 0;

    if (activeEscort.status === 'arrived' || remDist <= 30) {

      pct = 100;

    } else if (walked < 50) {

      // Prevent false starting percentage due to GPS settling

      pct = 0;

    } else if (activeEscort._startDist > 50) {

      pct = Math.max(0, Math.min(100, Math.round((walked / activeEscort._startDist) * 100)));

    }



    var textEl = document.getElementById('escort-active-progress-text');

    var barEl = document.getElementById('escort-active-progress-bar');

    if (textEl) textEl.textContent = pct + '%';

    if (barEl) barEl.style.width = pct + '%';

  }



  function updateActiveStatusChip(status) {

    var chipEl = document.getElementById('escort-active-status-chip');

    if (!chipEl) return;



    var text = 'On route';

    var bg = '#9E1B32';



    if (status === 'Paused' || status === 'paused') {

      text = 'Paused';

      bg = '#F59E0B';

    } else if (status === 'Off route' || status === 'off_route') {

      text = 'Off route';

      bg = '#DC2626';

    } else if (status === 'Check-in due' || status === 'checkin_due') {

      text = 'Check-in due';

      bg = '#6A1B9A';

    } else if (status === 'Alerted' || status === 'alerted') {

      text = 'Alerted';

      bg = '#B91C1C';

    } else if (status === 'Arrived' || status === 'arrived') {

      text = 'Arrived';

      bg = '#10B981';

    }



    chipEl.textContent = text;

    chipEl.style.backgroundColor = bg;

  }



  // ─── UI 1-Second Timer for ETA & Check-in ───────────────────

  function startUiSecondTimer() {

    stopUiSecondTimer();

    uiSecondTimer = setInterval(updateUiTimeAndCheckin, 1000);

    updateUiTimeAndCheckin();

  }



  function stopUiSecondTimer() {

    if (uiSecondTimer) {

      clearInterval(uiSecondTimer);

      uiSecondTimer = null;

    }

  }



  function updateUiTimeAndCheckin() {

    if (!activeEscort) return;



    var checkinEl = document.getElementById('escort-active-checkin-countdown');

    if (checkinEl) {

      if (!activeEscort.checkin_interval_min || activeEscort.checkin_interval_min === 'off') {

        checkinEl.textContent = 'Off';

        checkinEl.style.color = '#777777';

      } else if (activeEscort.status === 'paused') {

        checkinEl.textContent = 'Paused';

        checkinEl.style.color = '#F59E0B';

      } else if (activeEscort.next_checkin_due) {

        var dueDt = parseDateUtc(activeEscort.next_checkin_due);

        if (dueDt) {

          var diffSecs = Math.round((dueDt.getTime() - Date.now()) / 1000);

          if (diffSecs <= 0) {

            checkinEl.textContent = 'Due now!';

            checkinEl.style.color = '#9E1B32';

            updateActiveStatusChip('Check-in due');

            var chkModal = document.getElementById('escort-checkin-modal');

            if (chkModal && chkModal.style.display !== 'flex' && !checkinModalTimer) {

              showCheckinModal();

            }

          } else {

            var m = Math.floor(diffSecs / 60);

            var s = diffSecs % 60;

            checkinEl.textContent = m + 'm ' + (s < 10 ? '0' : '') + s + 's';

            checkinEl.style.color = '#9E1B32';

          }

        }

      }

    }



    var etaEl = document.getElementById('escort-active-eta');

    if (etaEl && activeEscort.expected_end) {

      var endDt = parseDateUtc(activeEscort.expected_end);

      if (endDt) {

        etaEl.textContent = endDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      }

    }

  }



  // ─── Local Behaviour: (1) Check-in Due Modal ───────────────

  function showCheckinModal(requestedByName) {

    var modal = document.getElementById('escort-checkin-modal');

    var numEl = document.getElementById('escort-checkin-countdown-num');

    var titleEl = document.getElementById('escort-checkin-modal-title');

    var descEl = document.getElementById('escort-checkin-modal-desc');

    if (!modal) return;



    if (titleEl) titleEl.textContent = 'Check-in: are you OK?';

    if (descEl) {

      if (requestedByName) {

        descEl.innerHTML = '<strong>' + escapeHtml(requestedByName) + '</strong> asked you to check in. Please confirm your safety within 60 seconds.';

      } else {

        descEl.textContent = 'Please confirm your safety. If you don\'t respond, an emergency alert will be sent automatically.';

      }

    }



    playCheckinBeep();

    triggerVibration();



    modal.style.display = 'flex';

    checkinSecsRemaining = 60;

    if (numEl) numEl.textContent = '60s';



    if (checkinModalTimer) clearInterval(checkinModalTimer);

    checkinModalTimer = setInterval(function() {

      checkinSecsRemaining--;

      if (numEl) numEl.textContent = checkinSecsRemaining + 's';

      if (checkinSecsRemaining <= 0) {

        clearInterval(checkinModalTimer);

        checkinModalTimer = null;

        modal.style.display = 'none';



        // Auto-escalate on timeout!

        if (activeEscort && activeEscort.id) {

          SafeHer.api.escalateEscort(activeEscort.id, function() {

            if (SafeHer.toast) SafeHer.toast('Check-in timed out. Emergency SOS activated!');

            updateActiveStatusChip('Alerted');

            if (SafeHer.router) SafeHer.router.go('sos-active');

          });

        }

      }

    }, 1000);

  }



  function confirmCheckinOk() {

    if (checkinModalTimer) {

      clearInterval(checkinModalTimer);

      checkinModalTimer = null;

    }

    var modal = document.getElementById('escort-checkin-modal');

    if (modal) modal.style.display = 'none';



    if (!activeEscort || !activeEscort.id) return;



    if (activeEscort.is_local_only) {

      activeEscort.checkins_done = (activeEscort.checkins_done || 0) + 1;

      activeEscort.last_checkin_at = new Date().toISOString();

      if (activeEscort.checkin_interval_min) {

        activeEscort.next_checkin_due = new Date(Date.now() + activeEscort.checkin_interval_min * 60000).toISOString();

      }

      saveActiveEscortToStorage();

      if (SafeHer.toast) SafeHer.toast("You're safe! Check-in confirmed.");

      updateActiveStatusChip('On route');

      return;

    }



    SafeHer.api.checkinEscort(activeEscort.id, function(err, res) {

      if (err) {

        if (SafeHer.toast) SafeHer.toast('Check-in error: ' + err);

      } else {

        if (SafeHer.toast) SafeHer.toast("You're safe! Next check-in scheduled.");

        if (res && res.next_checkin_due) {

          activeEscort.next_checkin_due = res.next_checkin_due;

          saveActiveEscortToStorage();

        }

        updateActiveStatusChip('On route');

      }

    });

  }



  // ─── Local Behaviour: (2) Off-Route & (3) Stationary ───────

  function handlePositionOffRouteCheck(lat, lng) {

    if (!currentRoutePoints || currentRoutePoints.length < 2 || !activeEscort) return;

    if (activeEscort.status === 'paused' || activeEscort.status === 'alerted') {

      offRouteStartedAt = null;

      return;

    }



    var dist = pointToRouteDistM(lat, lng, currentRoutePoints);

    var threshold = activeEscort.deviation_m || selectedDeviation || 150;



    if (dist > threshold) {

      if (!offRouteStartedAt) {

        offRouteStartedAt = Date.now();

      } else if (Date.now() - offRouteStartedAt >= 10000 && !promptModalOpen) {

        // Trigger check-in prompt after 10s of being off route!

        showPromptModal('off_route');

      }

      updateActiveStatusChip('Off route');

    } else {

      offRouteStartedAt = null;

      if (activeEscort.status !== 'paused' && activeEscort.status !== 'alerted') {

        updateActiveStatusChip('On route');

      }

    }

  }



  function handleStationaryCheck(lat, lng) {

    if (!activeEscort) return;

    if (activeEscort.status === 'paused') {

      stationaryAnchor = { lat: lat, lng: lng, time: Date.now() };

      return;

    }



    if (!stationaryAnchor) {

      stationaryAnchor = { lat: lat, lng: lng, time: Date.now() };

      return;

    }



    var movedDist = haversineDistM(lat, lng, stationaryAnchor.lat, stationaryAnchor.lng);

    if (movedDist >= 30) {

      stationaryAnchor = { lat: lat, lng: lng, time: Date.now() };

    } else {

      if (Date.now() - stationaryAnchor.time >= 300000 && !promptModalOpen) {

        showPromptModal('stationary');

      }

    }

  }



  function showPromptModal(type) {

    promptModalOpen = true;

    var modal = document.getElementById('escort-prompt-modal');

    var titleEl = document.getElementById('escort-prompt-title');

    var descEl = document.getElementById('escort-prompt-desc');

    var countdownEl = document.getElementById('escort-prompt-countdown');

    if (!modal) return;



    if (type === 'stationary') {

      if (titleEl) titleEl.textContent = "Are you safe?";

      if (descEl) descEl.textContent = "You haven't moved for 5 minutes. Are you safe?";

    } else {

      if (titleEl) titleEl.textContent = "Are you safe?";

      if (descEl) descEl.textContent = "Route deviation detected. Are you safe?";

    }



    playCheckinBeep();

    triggerVibration();

    modal.style.display = 'flex';



    // 30-Second Countdown: Auto-escalates and alerts emergency contacts if user does not respond!

    var remaining = 30;

    if (countdownEl) countdownEl.textContent = remaining + 's';

    if (promptModalTimer) clearInterval(promptModalTimer);

    promptModalTimer = setInterval(function() {

      remaining--;

      if (countdownEl) countdownEl.textContent = remaining + 's';

      if (remaining % 3 === 0) {

        playCheckinBeep();

        triggerVibration();

      }

      if (remaining <= 0) {

        clearInterval(promptModalTimer);

        promptModalTimer = null;

        closePromptModal();

        if (SafeHer.toast) SafeHer.toast('No response received! Auto-alerting emergency contacts via WhatsApp!');

        escalate();

      }

    }, 1000);

  }



  function closePromptModal() {

    promptModalOpen = false;

    if (promptModalTimer) {

      clearInterval(promptModalTimer);

      promptModalTimer = null;

    }

    var modal = document.getElementById('escort-prompt-modal');

    if (modal) modal.style.display = 'none';

  }



    function promptOkSameRoute() {

    closePromptModal();

    offRouteStartedAt = null;

    if (stationaryAnchor) stationaryAnchor.time = Date.now();

    if (SafeHer.toast) SafeHer.toast("Safe status confirmed. Continuing escort.");

  }



  function promptReroute() {

    closePromptModal();

    offRouteStartedAt = null;

    if (stationaryAnchor) stationaryAnchor.time = Date.now();



    if (!currentDest || currentDest.lat === undefined) return;

    refreshUserOrigin(function(origin) {

      var walkingUrl = 'https://router.project-osrm.org/route/v1/walking/' +

        origin.lng + ',' + origin.lat + ';' + currentDest.lng + ',' + currentDest.lat +

        '?overview=full&geometries=geojson';



      fetchWithTimeout(walkingUrl, 7000)

        .then(function(res) { return res.json(); })

        .then(function(data) {

          if (data && data.code === 'Ok' && data.routes && data.routes[0]) {

            var pts = data.routes[0].geometry.coordinates.map(function(c) { return [c[1], c[0]]; });

            applyReroute(pts);

          } else {

            fallbackDrivingReroute(origin);

          }

        })

        .catch(function() {

          fallbackDrivingReroute(origin);

        });

    });

  }



  function fallbackDrivingReroute(origin) {

    var drivingUrl = 'https://router.project-osrm.org/route/v1/driving/' +

      origin.lng + ',' + origin.lat + ';' + currentDest.lng + ',' + currentDest.lat +

      '?overview=full&geometries=geojson';



    fetchWithTimeout(drivingUrl, 7000)

      .then(function(res) { return res.json(); })

      .then(function(data) {

        if (data && data.code === 'Ok' && data.routes && data.routes[0]) {

          var pts = data.routes[0].geometry.coordinates.map(function(c) { return [c[1], c[0]]; });

          applyReroute(pts);

        } else {

          var direct = [[origin.lat, origin.lng], [currentDest.lat, currentDest.lng]];

          applyReroute(direct);

        }

      })

      .catch(function() {

        var direct = [[origin.lat, origin.lng], [currentDest.lat, currentDest.lng]];

        applyReroute(direct);

      });

  }



  function applyReroute(newPoints) {

    currentRoutePoints = newPoints;

    if (activePolylineLayer && activeMap) {

      activePolylineLayer.setLatLngs(newPoints);

    }

    if (activeEscort && activeEscort.id) {

      SafeHer.api.rerouteEscort(activeEscort.id, newPoints, function(err) {

        if (err) {

          if (SafeHer.toast) SafeHer.toast("Reroute error: " + err);

        } else {

          if (SafeHer.toast) SafeHer.toast("Route updated to new path.");

          updateActiveStatusChip('On route');

          saveActiveEscortToStorage();

        }

      });

    }

  }



  function promptPause() {

    closePromptModal();

    pause(15);

  }



  function promptEscalate() {

    closePromptModal();

    escalate();

  }



  // ─── Local Behaviour: (4) Arrival Prompt ───────────────────

  function handleArrivalCheck(lat, lng) {

    if (!currentDest || currentDest.lat === undefined || arrivalPromptShown) return;

    var dist = haversineDistM(lat, lng, currentDest.lat, currentDest.lng);



    var totalDist = (activeEscort && activeEscort.route_distance_m) ? activeEscort.route_distance_m : (userOrigin ? haversineDistM(userOrigin.lat, userOrigin.lng, currentDest.lat, currentDest.lng) : 1000);

    // Dynamic threshold: for short trips (< 300m), require getting within 25m or 25% of trip

    var threshold = (totalDist < 300) ? Math.max(20, Math.min(35, totalDist * 0.25)) : 80;



    // Prevent immediate false arrival on startup for short trips (give at least 15s)

    if (activeEscort && activeEscort.started_at) {

      var elapsedSec = (Date.now() - new Date(activeEscort.started_at).getTime()) / 1000;

      if (totalDist < 300 && elapsedSec < 15) {

        return;

      }

    }



    if (dist <= threshold) {

      arrivalPromptShown = true;

      showArrivalModal();

    }

  }



  function showArrivalModal() {

    var modal = document.getElementById('escort-arrival-modal');

    if (modal) {

      playCheckinBeep();

      triggerVibration();

      modal.style.display = 'flex';

    }

  }



  function dismissArrivalPrompt() {

    var modal = document.getElementById('escort-arrival-modal');

    if (modal) modal.style.display = 'none';

  }



  function confirmArrival(arrived) {

    dismissArrivalPrompt();

    callEndEscort(arrived);

  }



  // ─── Journey Controls ──────────────────────────────────────

  function checkin() {

    confirmCheckinOk();

  }



  function pause(mins) {

    if (!activeEscort || !activeEscort.id) return;

    var minutesToPause = mins || 15;



    if (activeEscort.is_local_only) {

      activeEscort.pauses_used = (activeEscort.pauses_used || 0) + 1;

      activeEscort.status = 'paused';

      updateActiveStatusChip('Paused');

      saveActiveEscortToStorage();

      setTimeout(function() {

        if (activeEscort && activeEscort.status === 'paused') {

          activeEscort.status = 'active';

          updateActiveStatusChip('On route');

          saveActiveEscortToStorage();

        }

      }, minutesToPause * 60000);

      if (SafeHer.toast) SafeHer.toast('Journey paused for ' + minutesToPause + ' min.');

      return;

    }



    SafeHer.api.pauseEscort(activeEscort.id, minutesToPause, function(err) {

      if (err) {

        if (SafeHer.toast) SafeHer.toast('Pause failed: ' + err);

      } else {

        if (SafeHer.toast) SafeHer.toast('Journey paused for ' + minutesToPause + ' minutes. Alerts suspended.');

        if (activeEscort) activeEscort.status = 'paused';

        saveActiveEscortToStorage();

        updateActiveStatusChip('Paused');

      }

    });

  }



  function escalate() {

    if (activeEscort) activeEscort.status = 'alerted';

    saveActiveEscortToStorage();

    updateActiveStatusChip('Alerted');



    // Trigger full Emergency SOS Alert (sirens, volunteer dispatch, WhatsApp, emails)

    if (SafeHer.sos && SafeHer.sos.triggerActiveAlert) {

      SafeHer.sos.triggerActiveAlert('emergency');

    } else if (SafeHer.api && SafeHer.api.createAlert) {

      var liveLoc = userOrigin || { lat: 12.9716, lng: 77.5946 };

      SafeHer.api.createAlert({

        mode: 'emergency',

        reason: 'route_deviation',

        lat: liveLoc.lat,

        lng: liveLoc.lng,

        note: 'Escort route deviation detected: user did not respond to safety check'

      }, function() {});

    }



    if (activeEscort && activeEscort.id && String(activeEscort.id).indexOf('local_') === -1) {

      SafeHer.api.escalateEscort(activeEscort.id, function() {});

    }



    if (SafeHer.router) SafeHer.router.go('sos-active');

  }



  function endJourney(arrived) {

    confirmArrival(arrived);

  }



  // ─── Stop Journey Button (PIN Protected if Alert is Active) ─

  function stopJourney() {

    if (!activeEscort || !activeEscort.id) return;



    var isAlertActive = !!(activeEscort.alert_id || activeEscort.status === 'alerted');



    if (isAlertActive && SafeHer.pin && SafeHer.pin.askPin) {

      // PIN protection when emergency alert is active to prevent attacker canceling!

      SafeHer.pin.askPin(

        function(enteredPin) {

          callEndEscort(false);

        },

        function(err) {

          if (SafeHer.toast) SafeHer.toast('Incorrect Safety PIN');

        }

      );

    } else {

      if (confirm('Are you sure you want to stop this journey?')) {

        callEndEscort(false);

      }

    }

  }



  function callEndEscort(arrived) {

    if (!activeEscort || !activeEscort.id) return;

    var escortId = activeEscort.id;

    var startMs = activeEscort.started_at ? new Date(activeEscort.started_at).getTime() : Date.now();

    var durationMins = Math.max(1, Math.round((Date.now() - startMs) / 60000));

    var fallbackSummary = {

      dest_name: activeEscort.dest_name,

      duration_minutes: durationMins,

      distance_m: activeEscort.route_distance_m || 0,

      checkins_done: activeEscort.checkins_done || 0,

      checkins_missed: activeEscort.checkins_missed || 0,

      alert_happened: !!(activeEscort.alert_id || activeEscort.status === 'alerted'),

      arrived: arrived

    };



    if (activeEscort.is_local_only) {

      stopActiveTracking();

      stopUiSecondTimer();

      releaseWakeLock();

      clearActiveEscortFromStorage();

      activeEscort = null;

      arrivalPromptShown = false;

      if (SafeHer.toast) SafeHer.toast(arrived ? 'Arrived safely!' : 'Journey ended.');

      showSummaryView(fallbackSummary, escortId);

      return;

    }



    SafeHer.api.endEscort(escortId, arrived, function(err, res) {

      stopActiveTracking();

      stopUiSecondTimer();

      releaseWakeLock();

      if (SafeHer.deliveryTracker) SafeHer.deliveryTracker.stopAll();

      clearActiveEscortFromStorage();

      activeEscort = null;

      arrivalPromptShown = false;



      if (err) {

        if (SafeHer.toast) SafeHer.toast('Error ending escort: ' + err);

      } else {

        if (SafeHer.toast) SafeHer.toast(arrived ? 'Arrived safely! Contacts notified.' : 'Journey ended.');

      }



      var summary = (res && res.summary) || fallbackSummary;

      showSummaryView(summary, escortId);

    });

  }



  // ─── Journey Summary Screen ────────────────────────────────

  function showSummaryView(summary, escortId) {

    lastEndedEscortId = escortId || (summary && summary.escort_id);



    var setupView = document.getElementById('escort-setup-view');

    var activeView = document.getElementById('escort-active-view');

    var summaryView = document.getElementById('escort-summary-view');



    if (setupView) setupView.style.display = 'none';

    if (activeView) activeView.style.display = 'none';

    if (summaryView) summaryView.style.display = 'block';



    var destEl = document.getElementById('escort-summary-dest');

    if (destEl) destEl.textContent = summary.dest_name || 'Destination';



    var timeEl = document.getElementById('escort-summary-time');

    if (timeEl) {

      var mins = summary.duration_minutes || 0;

      if (mins < 60) {

        timeEl.textContent = mins + ' min' + (mins === 1 ? '' : 's');

      } else {

        var h = Math.floor(mins / 60);

        var m = mins % 60;

        timeEl.textContent = h + ' hr ' + m + ' min' + (m === 1 ? '' : 's');

      }

    }



    var distEl = document.getElementById('escort-summary-distance');

    if (distEl) {

      var distM = summary.distance_m || 0;

      if (distM >= 1000) {

        distEl.textContent = (distM / 1000).toFixed(1) + ' km';

      } else {

        distEl.textContent = Math.round(distM) + ' m';

      }

    }



    var chkEl = document.getElementById('escort-summary-checkins');

    if (chkEl) {

      chkEl.textContent = (summary.checkins_done || 0) + ' done, ' + (summary.checkins_missed || 0) + ' missed';

    }



    var alertsEl = document.getElementById('escort-summary-alerts');

    if (alertsEl) {

      if (summary.alert_happened) {

        alertsEl.innerHTML = '<span style="color:#B91C1C;font-weight:700;">Alert occurred</span>';

      } else {

        alertsEl.innerHTML = '<span style="color:#10B981;font-weight:600;">None</span>';

      }

    }



    var statusMsg = document.getElementById('escort-summary-notify-status');

    if (statusMsg) statusMsg.style.display = 'none';



    var notifyBtn = document.getElementById('escort-summary-notify-btn');

    if (notifyBtn) {

      notifyBtn.disabled = false;

      notifyBtn.innerHTML = '<span class="material-symbols-rounded" style="margin-right:6px;">send</span>Send “Arrived safely” to contacts';

    }

  }



  function sendArrivedSafelyMessage() {
    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : null;
    var userName = (user && (user.name || user.full_name)) ? (user.name || user.full_name) : 'I';
    var dest = (currentDest && currentDest.name) ? currentDest.name : 'my destination';
    var msg = '✅ *SafeHer Safe Arrival Alert*\n\n*' + userName + '* has arrived safely at *' + dest + '*. Journey completed safely!';

    var targetPhone = '';
    var contacts = (SafeHer.api && SafeHer.api.getContacts) ? SafeHer.api.getContacts() : [];
    if (contacts.length > 0 && contacts[0].phone) {
      targetPhone = contacts[0].phone.replace(/\D/g, '');
    }
    if (targetPhone.length === 10) targetPhone = '91' + targetPhone;

    var waUrl = targetPhone
      ? ('https://wa.me/' + targetPhone + '?text=' + encodeURIComponent(msg))
      : ('https://api.whatsapp.com/send?text=' + encodeURIComponent(msg));

    var notifyBtn = document.getElementById('escort-summary-notify-btn');
    var statusMsg = document.getElementById('escort-summary-notify-status');
    if (notifyBtn) {
      notifyBtn.innerHTML = '<span class="material-symbols-rounded" style="margin-right:6px;">check_circle</span>Sent to contacts via WhatsApp';
    }
    if (statusMsg) {
      statusMsg.style.display = 'flex';
      statusMsg.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;">check_circle</span> Safe arrival update sent!';
    }
    if (SafeHer.toast) SafeHer.toast("Opening WhatsApp to notify contacts of safe arrival!");

    if (lastEndedEscortId && SafeHer.api && SafeHer.api.notifyEscortArrived) {
      try { SafeHer.api.notifyEscortArrived(lastEndedEscortId); } catch(e) {}
    }

    window.open(waUrl, '_blank');
  }

  function closeSummary() {

    var summaryView = document.getElementById('escort-summary-view');

    var setupView = document.getElementById('escort-setup-view');

    if (summaryView) summaryView.style.display = 'none';

    if (setupView) setupView.style.display = 'block';

    if (SafeHer.router) SafeHer.router.go('home');

  }



  // ─── Native Web Share & Copy ───────────────────────────────

  function shareNative() {
    if (!activeEscort) return;
    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : null;
    var userName = (user && user.name) ? user.name : 'I';
    var dest = activeEscort.dest_name || 'destination';
    var tokens = activeEscort.tokens || {};
    var firstCid = Object.keys(tokens)[0];
    var token = firstCid ? tokens[firstCid] : '';
    var frontendBase = (window.SafeHerConfig && window.SafeHerConfig.FRONTEND_URL) || 'https://rohancse2025.github.io/Safeher';
    var link = (activeEscort.share_links && activeEscort.share_links[firstCid]) ||
      (frontendBase.replace(/\/+$/, '') + '/track.html' + (token ? ('?t=' + token) : ''));
    var shareText = '🛡️ *SafeHer Ride & Escort Alert*\n\n*' + userName + '* has started a journey to *' + dest + '*.\n\n📍 Follow live journey & GPS here:\n' + link;

    if (navigator.share) {
      navigator.share({
        title: 'SafeHer Escort Mode Journey',
        text: shareText,
        url: link
      }).catch(function() {
        shareWhatsApp();
      });
    } else {
      shareWhatsApp();
    }
  }

  function shareWhatsApp() {
    if (!activeEscort) return;
    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : null;
    var userName = (user && user.name) ? user.name : 'I';
    var dest = activeEscort.dest_name || 'destination';
    var tokens = activeEscort.tokens || {};
    var firstCid = Object.keys(tokens)[0];
    var token = firstCid ? tokens[firstCid] : '';
    var frontendBase = (window.SafeHerConfig && window.SafeHerConfig.FRONTEND_URL) || 'https://rohancse2025.github.io/Safeher';
    var link = (activeEscort.share_links && activeEscort.share_links[firstCid]) ||
      (frontendBase.replace(/\/+$/, '') + '/track.html' + (token ? ('?t=' + token) : ''));
    var shareText = '🛡️ *SafeHer Ride & Escort Alert*\n\n*' + userName + '* has started a journey to *' + dest + '*.\n\n📍 Follow live journey & GPS here:\n' + link;

    var targetPhone = '';
    var contacts = (SafeHer.api && SafeHer.api.getContacts) ? SafeHer.api.getContacts() : [];
    if (activeEscort.contact_ids && activeEscort.contact_ids.length > 0) {
      for (var i = 0; i < contacts.length; i++) {
        if (activeEscort.contact_ids.indexOf(contacts[i].id) !== -1 && contacts[i].phone) {
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
      ? ('https://wa.me/' + targetPhone + '?text=' + encodeURIComponent(shareText))
      : ('https://api.whatsapp.com/send?text=' + encodeURIComponent(shareText));

    window.open(waUrl, '_blank');
  }



  function copyLink(link) {

    if (navigator.clipboard && navigator.clipboard.writeText) {

      navigator.clipboard.writeText(link).then(function() {

        if (SafeHer.toast) SafeHer.toast('Tracking link copied to clipboard!');

      });

    } else {

      window.prompt('Copy tracking link:', link);

    }

  }



  // ─── Open Screen Entrypoint & Auto-Resume from Storage ──────

  function open() {

    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : null;

    if (!user) {

      if (SafeHer.toast) SafeHer.toast('Please log in to use Escort Mode');

      if (SafeHer.router) SafeHer.router.go('login');

      return;

    }



    if (SafeHer.router) {

      SafeHer.router.go('escort');

    }



    // 1. First check localStorage persistence

    var stored = loadActiveEscortFromStorage();

    if (stored && stored.escort && stored.escort.status !== 'arrived' && stored.escort.status !== 'ended') {

      activeEscort = stored.escort;

      if (stored.dest) currentDest = stored.dest;

      if (stored.route) currentRoutePoints = stored.route;

      showActiveView(stored.escort);

      return;

    }



    // 2. Otherwise query backend for active escort

    SafeHer.api.getActiveEscort(function(err, active) {

      if (active && (active.status === 'active' || active.status === 'paused' || active.status === 'alerted')) {

        activeEscort = active;

        currentDest = { lat: active.dest_lat, lng: active.dest_lng, name: active.dest_name };

        try {

          currentRoutePoints = typeof active.route_json === 'string' ? JSON.parse(active.route_json) : (active.route_json || []);

        } catch (e) {

          currentRoutePoints = [];

        }

        saveActiveEscortToStorage();

        showActiveView(active);

      } else {

        clearActiveEscortFromStorage();

        activeEscort = null;

        var setupView = document.getElementById('escort-setup-view');

        var activeView = document.getElementById('escort-active-view');

        var summaryView = document.getElementById('escort-summary-view');

        if (setupView) setupView.style.display = 'block';

        if (activeView) activeView.style.display = 'none';

        if (summaryView) summaryView.style.display = 'none';



        applyNightModeDefaults();

        refreshUserOrigin(function() {

          initSetupMap();

        });

        loadContactsList();

      }

    });

  }



  function goBack() {

    if (SafeHer.router) {

      SafeHer.router.go('home');

    }

  }



  // Auto-restore on app bootstrap if stored escort exists

  function checkStoredEscortOnLoad() {

    var stored = loadActiveEscortFromStorage();

    if (stored && stored.escort && stored.escort.status !== 'arrived' && stored.escort.status !== 'ended') {

      activeEscort = stored.escort;

      if (stored.dest) currentDest = stored.dest;

      if (stored.route) currentRoutePoints = stored.route;

    }

  }



  function switchTravelTab(tab) {

    var escortBtns = document.querySelectorAll('#travel-tab-escort');

    var rideBtns = document.querySelectorAll('#travel-tab-ride');



    if (tab === 'ride') {

      escortBtns.forEach(function(b) { b.classList.remove('active'); });

      rideBtns.forEach(function(b) { b.classList.add('active'); });

      if (SafeHer.router && SafeHer.router.go) {

        SafeHer.router.go('ride');

      }

    } else {

      rideBtns.forEach(function(b) { b.classList.remove('active'); });

      escortBtns.forEach(function(b) { b.classList.add('active'); });

      if (SafeHer.router && SafeHer.router.go) {

        SafeHer.router.go('escort');

      }

    }

  }



  function init() {

    checkStoredEscortOnLoad();

    if (SafeHer.router && SafeHer.router.onShow) {

      SafeHer.router.onShow('escort', function() {

        var escortBtns = document.querySelectorAll('#travel-tab-escort');

        var rideBtns = document.querySelectorAll('#travel-tab-ride');

        escortBtns.forEach(function(b) { b.classList.add('active'); });

        rideBtns.forEach(function(b) { b.classList.remove('active'); });

      });

      SafeHer.router.onShow('ride', function() {

        var escortBtns = document.querySelectorAll('#travel-tab-escort');

        var rideBtns = document.querySelectorAll('#travel-tab-ride');

        rideBtns.forEach(function(b) { b.classList.add('active'); });

        escortBtns.forEach(function(b) { b.classList.remove('active'); });

      });

    }

  }



  if (typeof document !== 'undefined') {

    if (document.readyState === 'loading') {

      document.addEventListener('DOMContentLoaded', checkStoredEscortOnLoad);

    } else {

      checkStoredEscortOnLoad();

    }

  }



  // ─── Public API ────────────────────────────────────────────

  return {

    init: init,

    open: open,

    switchTravelTab: switchTravelTab,

    goBack: goBack,

    recenterMap: recenterMap,

    searchDestination: searchDestination,

    togglePickOnMap: togglePickOnMap,

    selectCheckin: selectCheckin,

    selectDeviation: selectDeviation,

    setTravelMode: function(m) { setTravelMode(m, true); },

    addDemoContact: addDemoContact,

    startEscort: startEscort,

    checkin: checkin,

    pause: pause,

    escalate: escalate,

    endJourney: endJourney,

    stopJourney: stopJourney,

    confirmCheckinOk: confirmCheckinOk,

    promptOkSameRoute: promptOkSameRoute,

    promptReroute: promptReroute,

    promptPause: promptPause,

    promptEscalate: promptEscalate,

    confirmArrival: confirmArrival,

    dismissArrivalPrompt: dismissArrivalPrompt,

    sendArrivedSafelyMessage: sendArrivedSafelyMessage,

    closeSummary: closeSummary,

    shareNative: shareNative,
    shareWhatsApp: shareWhatsApp,
    copyLink: copyLink

  };

})();

