// js/escort.js – Escort Mode: safe journey tracking with route deviation, stationary detection, and automated check-ins
// Part 1 & Part 2: Destination Search (Nominatim), OSRM routing, settings, active journey screen with Web Audio beep, Wake Lock & auto-escalation

SafeHer.escort = (function() {
  'use strict';

  // ─── Internal State ─────────────────────────────────────────
  var activeEscort = null;
  var setupMap = null;
  var activeMap = null;

  var userOrigin = { lat: 12.9716, lng: 77.5946 }; // Default Bangalore coordinates
  var currentDest = null; // { lat: number, lng: number, name: string }
  var currentRoutePoints = []; // Array of [lat, lng]
  var selectedCheckin = '10'; // 5, 10, 15, 30 or 'off'
  var selectedDeviation = 200; // 100, 200, 300, 500
  var isPickingOnMap = false;

  var polylineLayer = null;
  var startMarker = null;
  var destMarker = null;

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

  function refreshUserOrigin(callback) {
    getStoredOrigin();
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          userOrigin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          if (callback) callback(userOrigin);
        },
        function() {
          if (callback) callback(userOrigin);
        },
        { enableHighAccuracy: true, timeout: 7000, maximumAge: 60000 }
      );
    } else {
      if (callback) callback(userOrigin);
    }
  }

  // ─── Setup Map Initialization ──────────────────────────────
  function initSetupMap() {
    var container = document.getElementById('escort-setup-map');
    if (!container) return;

    if (!setupMap && typeof L !== 'undefined') {
      setupMap = L.map('escort-setup-map', {
        zoomControl: true,
        attributionControl: false
      }).setView([userOrigin.lat, userOrigin.lng], 13);

      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 19
      }).addTo(setupMap);

      setupMap.on('click', function(e) {
        if (!isPickingOnMap && !destMarker) {
          setDestinationFromLatLng(e.latlng.lat, e.latlng.lng);
        } else if (isPickingOnMap) {
          setDestinationFromLatLng(e.latlng.lat, e.latlng.lng);
          togglePickOnMap(false);
        }
      });
    }

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
    var latFixed = parseFloat(lat).toFixed(5);
    var lngFixed = parseFloat(lng).toFixed(5);
    var defaultName = 'Pin (' + latFixed + ', ' + lngFixed + ')';

    var input = document.getElementById('escort-dest-input');
    if (input) input.value = 'Locating address...';

    currentDest = { lat: parseFloat(lat), lng: parseFloat(lng), name: defaultName };

    var revUrl = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng;
    fetch(revUrl, { headers: { 'Accept': 'application/json' } })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data && data.display_name) {
          var parts = data.display_name.split(',');
          var cleanName = parts.slice(0, 3).join(',').trim();
          currentDest.name = cleanName || data.display_name;
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

  // ─── Destination Search (Nominatim) ────────────────────────
  function searchDestination() {
    var input = document.getElementById('escort-dest-input');
    var resultsBox = document.getElementById('escort-search-results');
    var btn = document.getElementById('escort-search-btn');
    if (!input || !resultsBox) return;

    var query = (input.value || '').trim();
    if (!query) {
      if (SafeHer.toast) SafeHer.toast('Please enter a destination to search');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px;">hourglass_top</span> ...';
    }

    resultsBox.style.display = 'block';
    resultsBox.innerHTML = '<div style="padding:10px 12px;font-size:12px;color:var(--text-gray);">Searching India locations...</div>';

    var nominatimUrl = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=in&limit=5&q=' + encodeURIComponent(query);

    fetch(nominatimUrl, { headers: { 'Accept': 'application/json' } })
      .then(function(res) { return res.json(); })
      .then(function(items) {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px;">search</span> Search';
        }

        if (!items || items.length === 0) {
          resultsBox.innerHTML = '<div style="padding:10px 12px;font-size:12px;color:var(--text-gray);">No matching locations found in India. Try another query or pick on map.</div>';
          return;
        }

        var html = '';
        items.forEach(function(item, idx) {
          var name = item.display_name;
          var shortName = item.display_name.split(',').slice(0, 3).join(',').trim();
          html += '<div class="escort-search-item" data-index="' + idx + '">' +
            '<div style="font-weight:600;color:var(--crimson);">' + escapeHtml(shortName) + '</div>' +
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
      })
      .catch(function() {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px;">search</span> Search';
        }
        resultsBox.innerHTML = '<div style="padding:10px 12px;font-size:12px;color:#D32F2F;">Search failed. Please check internet connection or pick on map.</div>';
      });
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

      var walkingUrl = 'https://router.project-osrm.org/route/v1/walking/' +
        startLng + ',' + startLat + ';' + destLng + ',' + destLat +
        '?overview=full&geometries=geojson';

      fetchWithTimeout(walkingUrl, 7000)
        .then(function(res) {
          if (!res.ok) throw new Error('Walking route HTTP ' + res.status);
          return res.json();
        })
        .then(function(data) {
          if (data && data.code === 'Ok' && data.routes && data.routes.length > 0) {
            applyRouteData(data.routes[0], 'Walking Route', null);
          } else {
            throw new Error('Walking profile unavailable');
          }
        })
        .catch(function() {
          var drivingUrl = 'https://router.project-osrm.org/route/v1/driving/' +
            startLng + ',' + startLat + ';' + destLng + ',' + destLat +
            '?overview=full&geometries=geojson';

          fetchWithTimeout(drivingUrl, 7000)
            .then(function(res) {
              if (!res.ok) throw new Error('Driving route HTTP ' + res.status);
              return res.json();
            })
            .then(function(drvData) {
              if (drvData && drvData.code === 'Ok' && drvData.routes && drvData.routes.length > 0) {
                applyRouteData(drvData.routes[0], 'Approximate route (driving)', null);
              } else {
                throw new Error('Driving profile unavailable');
              }
            })
            .catch(function() {
              var directPoints = [[startLat, startLng], [destLat, destLng]];
              var directDistM = haversineDistM(startLat, startLng, destLat, destLng);
              var estMins = Math.max(5, Math.round((directDistM / 1000) / 4.5 * 60));

              applyStraightLineRoute(
                directPoints,
                directDistM,
                estMins,
                'Could not calculate road route from OSRM. Falling back to direct straight line.'
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
      var durSec = routeObj.duration || ((distM / 1000) / 4.5 * 3600);
      var durMins = Math.max(5, Math.round(durSec / 60));

      if (profileLabel) profileLabel.textContent = label;
      if (distLabel) {
        distLabel.textContent = distM >= 1000 ? (distM / 1000).toFixed(1) + ' km' : Math.round(distM) + ' m';
      }
      if (minsInput) minsInput.value = durMins;

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
      if (profileLabel) profileLabel.textContent = 'Straight Line Route';
      if (distLabel) {
        distLabel.textContent = distM >= 1000 ? (distM / 1000).toFixed(1) + ' km' : Math.round(distM) + ' m';
      }
      if (minsInput) minsInput.value = estMins;

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

    destMarker = L.circleMarker(endPt, {
      radius: 8,
      fillColor: '#9E1B32',
      color: '#ffffff',
      weight: 2,
      opacity: 1,
      fillOpacity: 1
    }).addTo(setupMap).bindPopup('Destination: ' + escapeHtml((currentDest && currentDest.name) || 'Destination'));

    polylineLayer = L.polyline(routePoints, {
      color: '#9E1B32',
      weight: 5,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(setupMap);

    setupMap.fitBounds(polylineLayer.getBounds(), { padding: [30, 30] });
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
      listEl.innerHTML = '<p style="font-size:12px;color:var(--text-gray);padding:8px;">No contacts API available.</p>';
      return;
    }

    SafeHer.api.getContacts(function(err, contacts) {
      if (err || !contacts || contacts.length === 0) {
        listEl.innerHTML = '<p style="font-size:12px;color:var(--text-gray);padding:8px;">No contacts found. Please add contacts in the Contacts tab.</p>';
        return;
      }

      var html = '';
      contacts.forEach(function(c) {
        var isClose = !!(c.is_close || c.close || (c.relation && /emergency|family|parent|spouse|close/i.test(c.relation)));

        html += '<label class="escort-contact-row" style="cursor:pointer;">' +
          '<input type="checkbox" class="escort-contact-cb" value="' + c.id + '" ' + (isClose ? 'checked' : '') + ' style="accent-color:var(--crimson);width:16px;height:16px;" />' +
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

  // ─── Start Escort Journey ──────────────────────────────────
  function startEscort() {
    if (!currentDest || currentDest.lat === undefined) {
      if (SafeHer.toast) SafeHer.toast('Please choose a destination first');
      return;
    }

    var minsInput = document.getElementById('escort-expected-mins');
    var expectedMinutes = parseInt(minsInput ? minsInput.value : 30, 10);
    if (!expectedMinutes || expectedMinutes < 5) expectedMinutes = 30;

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
      dest_lat: currentDest.lat,
      dest_lng: currentDest.lng,
      route: routePayload,
      expected_minutes: expectedMinutes,
      checkin_interval: selectedCheckin === 'off' ? null : parseInt(selectedCheckin, 10),
      deviation_distance: selectedDeviation,
      contact_ids: checkedIds
    };

    SafeHer.api.createEscort(payload, function(err, result) {
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.innerHTML = '<span class="material-symbols-rounded" style="margin-right:6px;">route</span>Start Escort';
      }

      if (err) {
        if (SafeHer.toast) SafeHer.toast('Error starting escort: ' + err);
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
      var contactMap = {};
      contacts.forEach(function(c) { contactMap[String(c.id)] = c; });

      var tokenEntries = Object.keys(tokens);
      if (tokenEntries.length === 0) {
        container.innerHTML = '<p style="font-size:12px;color:var(--text-gray);margin:0;">No contacts selected for tracking links.</p>';
        return;
      }

      var html = '';
      tokenEntries.forEach(function(cid) {
        var contact = contactMap[String(cid)] || { name: 'Trusted Contact', phone: '' };
        var cToken = tokens[cid];
        var link = shareLinks[cid] || (window.location.origin + '/track.html?t=' + cToken);

        var msgText = userName + ' started a journey to ' + dest + ', expected by ' + etaStr + '. Track live here: ' + link;
        var encodedMsg = encodeURIComponent(msgText);

        var rawPhone = (contact.phone || '').replace(/\D/g, '');
        var waPhone = rawPhone.length === 10 ? '91' + rawPhone : rawPhone;
        var waUrl = 'https://wa.me/' + waPhone + '?text=' + encodedMsg;
        var smsUrl = 'sms:' + rawPhone + '?body=' + encodedMsg;

        html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid #F3C2CE;">' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:13px;font-weight:600;color:var(--text-dark);">' + escapeHtml(contact.name) + '</div>' +
            '<div style="font-size:11px;color:var(--text-gray);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(contact.phone || 'Tracking enabled') + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;">' +
            '<a href="' + waUrl + '" target="_blank" rel="noopener" class="escort-share-btn wa" title="Send WhatsApp message">' +
              '<span>WhatsApp</span>' +
            '</a>' +
            '<a href="' + smsUrl + '" class="escort-share-btn sms" title="Send SMS">' +
              '<span>SMS</span>' +
            '</a>' +
            '<button type="button" class="escort-share-btn copy" onclick="SafeHer.escort.copyLink(\'' + escapeHtml(link) + '\')" title="Copy tracking link">' +
              '<span class="material-symbols-rounded" style="font-size:14px;">content_copy</span>' +
            '</button>' +
          '</div>' +
        '</div>';
      });

      container.innerHTML = html;
    });
  }

  function initActiveMap(escortData) {
    var container = document.getElementById('escort-active-map');
    if (!container || typeof L === 'undefined') return;

    if (!activeMap) {
      activeMap = L.map('escort-active-map', {
        zoomControl: true,
        attributionControl: false
      }).setView([escortData.dest_lat, escortData.dest_lng], 14);

      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 19
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

      activeMap.fitBounds(activePolylineLayer.getBounds(), { padding: [30, 30] });
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
        },
        function(err) {
          console.warn('[Escort GPS Watch Error]', err);
        },
        { enableHighAccuracy: true, maximumAge: 5000 }
      );
    }

    // Status polling every 5 seconds (monitors status & contact check-in pings)
    pollIntervalId = setInterval(function() {
      if (!activeEscort || !activeEscort.id) return;
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
  }

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

    var pct = 0;
    if (activeEscort.status === 'arrived') {
      pct = 100;
    } else if (totalDist > 0) {
      pct = Math.max(0, Math.min(100, Math.round((1.0 - remDist / totalDist) * 100)));
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
    if (activeEscort.status === 'paused') {
      offRouteStartedAt = null;
      return;
    }

    var dist = pointToRouteDistM(lat, lng, currentRoutePoints);
    var threshold = activeEscort.deviation_m || selectedDeviation || 200;

    if (dist > threshold) {
      if (!offRouteStartedAt) {
        offRouteStartedAt = Date.now();
      } else if (Date.now() - offRouteStartedAt >= 60000 && !promptModalOpen) {
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
    if (!modal) return;

    if (type === 'stationary') {
      if (titleEl) titleEl.textContent = "You haven't moved for 5 minutes. Are you OK?";
      if (descEl) descEl.textContent = "We noticed no movement for 5 minutes. Please select an option:";
    } else {
      if (titleEl) titleEl.textContent = "You’ve left the route. Are you OK?";
      if (descEl) descEl.textContent = "We noticed you are away from your planned path. Please select an option:";
    }

    playCheckinBeep();
    triggerVibration();
    modal.style.display = 'flex';
  }

  function closePromptModal() {
    promptModalOpen = false;
    var modal = document.getElementById('escort-prompt-modal');
    if (modal) modal.style.display = 'none';
  }

  function promptOkSameRoute() {
    closePromptModal();
    offRouteStartedAt = null;
    if (stationaryAnchor) stationaryAnchor.time = Date.now();
    if (SafeHer.toast) SafeHer.toast("Continuing on your journey.");
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

    if (dist <= 100) {
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
    if (!activeEscort || !activeEscort.id) return;
    SafeHer.api.escalateEscort(activeEscort.id, function(err) {
      if (err) {
        if (SafeHer.toast) SafeHer.toast('Escalation failed: ' + err);
      } else {
        if (SafeHer.toast) SafeHer.toast('Emergency Alert triggered! Help is notified.');
        if (activeEscort) activeEscort.status = 'alerted';
        saveActiveEscortToStorage();
        updateActiveStatusChip('Alerted');
        if (SafeHer.router) SafeHer.router.go('sos-active');
      }
    });
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
    var fallbackSummary = {
      dest_name: activeEscort.dest_name,
      duration_minutes: 1,
      distance_m: activeEscort.route_distance_m || 0,
      checkins_done: 0,
      checkins_missed: 0,
      alert_happened: !!(activeEscort.alert_id || activeEscort.status === 'alerted'),
      arrived: arrived
    };

    SafeHer.api.endEscort(escortId, arrived, function(err, res) {
      stopActiveTracking();
      stopUiSecondTimer();
      releaseWakeLock();
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
    var notifyBtn = document.getElementById('escort-summary-notify-btn');
    var statusMsg = document.getElementById('escort-summary-notify-status');
    if (!lastEndedEscortId) {
      if (statusMsg) {
        statusMsg.style.display = 'flex';
        statusMsg.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;">check_circle</span> Message sent to your contacts!';
      }
      return;
    }

    if (notifyBtn) {
      notifyBtn.disabled = true;
      notifyBtn.innerHTML = '<span class="material-symbols-rounded" style="margin-right:6px;">hourglass_top</span>Sending...';
    }

    SafeHer.api.notifyEscortArrived(lastEndedEscortId, function(err, res) {
      if (notifyBtn) {
        notifyBtn.innerHTML = '<span class="material-symbols-rounded" style="margin-right:6px;">check_circle</span>Sent to contacts';
      }
      if (statusMsg) {
        statusMsg.style.display = 'flex';
        statusMsg.innerHTML = '<span class="material-symbols-rounded" style="font-size:16px;">check_circle</span> Message sent to your contacts!';
      }
      if (SafeHer.toast) SafeHer.toast("Sent 'Arrived safely' to contacts!");
    });
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
    var link = (activeEscort.share_links && activeEscort.share_links[firstCid]) ||
      (window.location.origin + '/track.html?t=' + token);

    var shareText = userName + ' started an Escort Mode journey to ' + dest + '. Follow live here: ' + link;

    if (navigator.share) {
      navigator.share({
        title: 'SafeHer Escort Mode Journey',
        text: shareText,
        url: link
      }).catch(function() {});
    } else {
      copyLink(link);
    }
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

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', checkStoredEscortOnLoad);
    } else {
      checkStoredEscortOnLoad();
    }
  }

  // ─── Public API ────────────────────────────────────────────
  return {
    open: open,
    goBack: goBack,
    searchDestination: searchDestination,
    togglePickOnMap: togglePickOnMap,
    selectCheckin: selectCheckin,
    selectDeviation: selectDeviation,
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
    copyLink: copyLink
  };
})();
