// js/escort.js – Escort Mode: safe journey tracking with route deviation, stationary detection, and automated check-ins
// Part 1: Destination Search (Nominatim), OSRM routing, settings, and journey launch

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
  var lastSentPositionTime = 0;

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

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19
      }).addTo(setupMap);

      // Map click listener for "Pick on map"
      setupMap.on('click', function(e) {
        if (!isPickingOnMap && !destMarker) {
          // If destination hasn't been set yet, allow tapping map directly
          setDestinationFromLatLng(e.latlng.lat, e.latlng.lng);
        } else if (isPickingOnMap) {
          setDestinationFromLatLng(e.latlng.lat, e.latlng.lng);
          togglePickOnMap(false); // disable pick mode after pin placed
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

    // Reverse geocode via Nominatim
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
  // Called ONLY when the Search button is pressed, never on keystroke
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

        // Attach click listeners to result rows
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
      .catch(function(err) {
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

      // 1. Try Walking Route
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
          // 2. Try Driving Route (Fallback labeled "approximate route")
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
              // 3. Fallback to Straight Line with Warning
              var directPoints = [[startLat, startLng], [destLat, destLng]];
              var directDistM = haversineDistM(startLat, startLng, destLat, destLng);
              var estMins = Math.max(5, Math.round((directDistM / 1000) / 4.5 * 60)); // ~4.5 km/h

              applyStraightLineRoute(
                directPoints,
                directDistM,
                estMins,
                'Could not calculate road route from OSRM. Falling back to a direct straight line route.'
              );
            });
        });
    });

    function applyRouteData(routeObj, label, warningMsg) {
      var coords = routeObj.geometry.coordinates || [];
      // OSRM coordinates are [lng, lat], convert to [lat, lng]
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

    // Start Marker (green circle pin)
    startMarker = L.circleMarker(startPt, {
      radius: 7,
      fillColor: '#10B981',
      color: '#ffffff',
      weight: 2,
      opacity: 1,
      fillOpacity: 1
    }).addTo(setupMap).bindPopup('Start: Your location');

    // Dest Marker (crimson pin)
    destMarker = L.circleMarker(endPt, {
      radius: 8,
      fillColor: '#9E1B32',
      color: '#ffffff',
      weight: 2,
      opacity: 1,
      fillOpacity: 1
    }).addTo(setupMap).bindPopup('Destination: ' + escapeHtml((currentDest && currentDest.name) || 'Destination'));

    // Route Polyline
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
        // Pre-select close contacts (flagged is_close, close, or relationship matching family/emergency/parent/spouse/close)
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

    // Collect checked contact IDs
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

      // Save active journey state
      activeEscort = result;
      if (SafeHer.toast) SafeHer.toast('Escort Mode started! Live tracking link sent.');

      // Open active journey view
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
    var etaEl = document.getElementById('escort-active-eta');
    var badgeEl = document.getElementById('escort-active-status-badge');

    if (destNameEl) destNameEl.textContent = escortData.dest_name || 'Destination';
    if (etaEl && escortData.expected_end) {
      try {
        var endDt = new Date(escortData.expected_end.replace(' ', 'T') + (escortData.expected_end.indexOf('Z') === -1 ? 'Z' : ''));
        etaEl.textContent = endDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch (e) {
        etaEl.textContent = escortData.expected_end;
      }
    }
    if (badgeEl) {
      badgeEl.textContent = (escortData.status === 'paused') ? 'Paused' : 'On route';
    }

    // Render Share Links with WhatsApp & SMS buttons per contact
    renderActiveShareList(escortData);

    // Initialize Active Map
    initActiveMap(escortData);

    // Start Realtime GPS tracking and periodic monitor
    startActiveTracking(escortData.id);
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
      try {
        var dt = new Date(escortData.expected_end.replace(' ', 'T') + (escortData.expected_end.indexOf('Z') === -1 ? 'Z' : ''));
        etaStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch (e) {
        etaStr = escortData.expected_end;
      }
    }

    // Retrieve contacts list to pair names and phone numbers with tokens
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

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19
      }).addTo(activeMap);
    }

    setTimeout(function() { activeMap.invalidateSize(); }, 250);

    if (activePolylineLayer) activeMap.removeLayer(activePolylineLayer);
    if (activeDestMarker) activeMap.removeLayer(activeDestMarker);

    // Destination Pin
    activeDestMarker = L.circleMarker([escortData.dest_lat, escortData.dest_lng], {
      radius: 9,
      fillColor: '#9E1B32',
      color: '#ffffff',
      weight: 2,
      opacity: 1,
      fillOpacity: 1
    }).addTo(activeMap).bindPopup('Destination: ' + escapeHtml(escortData.dest_name || ''));

    // Polyline
    if (currentRoutePoints && currentRoutePoints.length >= 2) {
      activePolylineLayer = L.polyline(currentRoutePoints, {
        color: '#9E1B32',
        weight: 5,
        opacity: 0.85
      }).addTo(activeMap);

      activeMap.fitBounds(activePolylineLayer.getBounds(), { padding: [30, 30] });
    }
  }

  function startActiveTracking(escortId) {
    stopActiveTracking();

    // 1. Geolocation Watcher
    if (navigator.geolocation) {
      gpsWatchId = navigator.geolocation.watchPosition(
        function(pos) {
          var lat = pos.coords.latitude;
          var lng = pos.coords.longitude;
          updateActiveUserMarker(lat, lng);

          var now = Date.now();
          // Rate-limit position dispatches to server to every 10 seconds
          if (now - lastSentPositionTime > 10000) {
            lastSentPositionTime = now;
            SafeHer.api.sendEscortPosition(escortId, { lat: lat, lng: lng }, function(err, res) {
              if (res && res.status) {
                updateActiveStatusBadge(res.status);
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

    // 2. Status Polling Interval (every 10 seconds)
    pollIntervalId = setInterval(function() {
      if (!activeEscort || !activeEscort.id) return;
      SafeHer.api.getEscort(activeEscort.id, function(err, escort) {
        if (escort) {
          updateActiveStatusBadge(escort.status);
          if (escort.status === 'arrived' || escort.status === 'ended') {
            stopActiveTracking();
            if (SafeHer.toast) SafeHer.toast('Journey completed safely!');
          }
        }
      });
    }, 10000);
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

  function updateActiveStatusBadge(status) {
    var badgeEl = document.getElementById('escort-active-status-badge');
    if (!badgeEl) return;

    var text = 'On route';
    var bg = '#9E1B32';

    if (status === 'paused') {
      text = 'Paused';
      bg = '#F59E0B';
    } else if (status === 'off_route') {
      text = 'Off route';
      bg = '#DC2626';
    } else if (status === 'alerted') {
      text = 'Alerted';
      bg = '#B91C1C';
    } else if (status === 'arrived') {
      text = 'Arrived';
      bg = '#10B981';
    }

    badgeEl.textContent = text;
    badgeEl.style.backgroundColor = bg;
  }

  // ─── Journey Controls ──────────────────────────────────────
  function checkin() {
    if (!activeEscort || !activeEscort.id) return;
    SafeHer.api.checkinEscort(activeEscort.id, function(err) {
      if (err) {
        if (SafeHer.toast) SafeHer.toast('Check-in failed: ' + err);
      } else {
        if (SafeHer.toast) SafeHer.toast("You're checked in! Next check-in reset.");
      }
    });
  }

  function pause() {
    if (!activeEscort || !activeEscort.id) return;
    SafeHer.api.pauseEscort(activeEscort.id, 10, function(err) {
      if (err) {
        if (SafeHer.toast) SafeHer.toast('Pause failed: ' + err);
      } else {
        if (SafeHer.toast) SafeHer.toast('Journey paused for 10 minutes. Alerts suspended.');
        updateActiveStatusBadge('paused');
      }
    });
  }

  function escalate() {
    if (!activeEscort || !activeEscort.id) return;
    if (confirm('Trigger an Emergency Alert now? This will immediately notify your contacts and emergency services.')) {
      SafeHer.api.escalateEscort(activeEscort.id, function(err) {
        if (err) {
          if (SafeHer.toast) SafeHer.toast('Escalation failed: ' + err);
        } else {
          if (SafeHer.toast) SafeHer.toast('Emergency Alert triggered! Help is notified.');
          updateActiveStatusBadge('alerted');
          if (SafeHer.router) SafeHer.router.go('sos-active');
        }
      });
    }
  }

  function endJourney(arrived) {
    if (!activeEscort || !activeEscort.id) return;
    var msg = arrived ? 'Confirm you have arrived safely?' : 'End this journey?';
    if (!confirm(msg)) return;

    SafeHer.api.endEscort(activeEscort.id, arrived, function(err) {
      stopActiveTracking();
      activeEscort = null;
      if (err) {
        if (SafeHer.toast) SafeHer.toast('Error ending escort: ' + err);
      } else {
        if (SafeHer.toast) SafeHer.toast(arrived ? 'Arrived safely! Contacts notified.' : 'Journey ended.');
      }

      // Return to setup view
      var setupView = document.getElementById('escort-setup-view');
      var activeView = document.getElementById('escort-active-view');
      if (setupView) setupView.style.display = 'block';
      if (activeView) activeView.style.display = 'none';
      if (SafeHer.router) SafeHer.router.go('home');
    });
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

  // ─── Open Screen Entrypoint ────────────────────────────────
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

    // Check if an active escort already exists
    SafeHer.api.getActiveEscort(function(err, active) {
      if (active && (active.status === 'active' || active.status === 'paused' || active.status === 'alerted')) {
        activeEscort = active;
        showActiveView(active);
      } else {
        activeEscort = null;
        var setupView = document.getElementById('escort-setup-view');
        var activeView = document.getElementById('escort-active-view');
        if (setupView) setupView.style.display = 'block';
        if (activeView) activeView.style.display = 'none';

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
    shareNative: shareNative,
    copyLink: copyLink
  };
})();
