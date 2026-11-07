// js/home.js – Home screen: greeting, location, active items, finish setup, SOS, tiles, helplines, police, tip, and footer row

SafeHer.home = (function() {
  var sosActive             = false;
  var locFetched            = false;   // fetch once per session
  var locPermissionGranted  = false;
  var lastKnownCoords       = null;
  var activeNowInterval     = null;
  var isPoliceQuerying      = false;

  var POLICE_CACHE_KEY = 'nearby_open_places_cache';

  var FALLBACK_TIPS = [
    { title: 'Stay aware of your surroundings', lines: ['Keep your head up and scan the area around you while commuting.'] },
    { title: 'Share your live ride status', lines: ['Verify the vehicle plate and driver identity before boarding.'] },
    { title: 'Trust your instincts', lines: ['If a situation makes you feel uneasy, move towards a lit, crowded place.'] },
    { title: 'Keep your phone charged', lines: ['Maintain your battery above 20% and carry a compact power bank.'] },
    { title: 'Know your emergency numbers', lines: ['Remember 112 for national emergency and 181 for women helpline.'] },
    { title: 'Move to a lit public space', lines: ['Head towards open stores, pharmacies, or manned transit hubs if followed.'] },
    { title: 'Travelling late night', lines: ['Use Escort Mode to monitor your journey with automated check-ins.'] }
  ];

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

  function haversineDistKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
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
    renderActiveNow();
  }

  // ── 1. Greeting ─────────────────────────────────────────
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

  // ── 2. Geolocation & Nominatim Lookup ───────────────────
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
        locPermissionGranted = true;
        var latNum = pos.coords.latitude;
        var lonNum = pos.coords.longitude;
        lastKnownCoords = { lat: latNum, lng: lonNum };
        if (window.SafeHer) SafeHer.lastKnownLocation = lastKnownCoords;

        updateFinishSetup();
        fetchNearestPolice();

        var lat = latNum.toFixed(5);
        var lon = lonNum.toFixed(5);

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

  // ── 3. Active Now (Between header and SOS section) ───────
  function renderActiveNow() {
    var container = document.getElementById('home-active-now');
    if (!container) return;

    var items = [];

    // (1) SOS (red row, "SOS active")
    var isSos = false;
    try {
      if (SafeHer.sos && SafeHer.sos.isAlertActive && SafeHer.sos.isAlertActive()) isSos = true;
      else if (SafeHer.api && SafeHer.api.getActiveSos && SafeHer.api.getActiveSos()) isSos = true;
      else if (sosActive) isSos = true;
    } catch (e) {}

    if (isSos) {
      items.push({
        type: 'sos',
        text: 'SOS active',
        icon: 'warning',
        isSos: true,
        action: function() {
          if (SafeHer.sos && SafeHer.sos.getCurrentMode && SafeHer.sos.getCurrentMode() === 'silent') {
            SafeHer.router.go('sos-silent');
          } else {
            SafeHer.router.go('sos-active');
          }
        }
      });
    }

    // (2) Escort Mode: "Journey to <destination>, next check-in in mm:ss"
    try {
      var rawEscort = localStorage.getItem('safeher_active_escort');
      if (rawEscort) {
        var parsedEscort = JSON.parse(rawEscort);
        var esc = parsedEscort.escort || parsedEscort;
        if (esc && (esc.status === 'active' || esc.status === 'paused' || esc.status === 'alerted')) {
          var destName = esc.dest_name || (parsedEscort.dest && parsedEscort.dest.name) || 'destination';
          var nextStr = '';
          if (esc.status === 'paused') {
            nextStr = 'paused';
          } else if (esc.next_checkin_due) {
            var dueTime = new Date(esc.next_checkin_due).getTime();
            var diffSec = Math.round((dueTime - Date.now()) / 1000);
            if (diffSec <= 0) {
              nextStr = 'due now';
            } else {
              var em = Math.floor(diffSec / 60);
              var es = diffSec % 60;
              nextStr = (em < 10 ? '0' : '') + em + ':' + (es < 10 ? '0' : '') + es;
            }
          } else {
            nextStr = 'on route';
          }

          var label = 'Journey to ' + destName + ', next check-in in ' + nextStr;
          if (nextStr === 'paused') {
            label = 'Journey to ' + destName + ', paused';
          } else if (nextStr === 'due now') {
            label = 'Journey to ' + destName + ', check-in due now';
          }

          items.push({
            type: 'escort',
            text: label,
            icon: 'route',
            isSos: false,
            action: function() {
              if (SafeHer.escort && SafeHer.escort.open) {
                SafeHer.escort.open();
              } else {
                SafeHer.router.go('escort');
              }
            }
          });
        }
      }
    } catch (e) {}

    // (3) Safe Timer: "Safe timer, mm:ss left"
    try {
      var timer = null;
      if (SafeHer.timer && SafeHer.timer.getCurrentTimer) {
        timer = SafeHer.timer.getCurrentTimer();
      }
      if (!timer && SafeHer.api && SafeHer.api.getSafeTimer) {
        timer = SafeHer.api.getSafeTimer();
      }
      if (!timer && SafeHer.storage) {
        timer = SafeHer.storage.get('safe_timer');
      }

      if (timer && timer.targetTime && timer.status === 'running') {
        var remSec = Math.round((timer.targetTime - Date.now()) / 1000);
        if (remSec > 0) {
          var tm = Math.floor(remSec / 60);
          var ts = remSec % 60;
          var tStr = (tm < 10 ? '0' : '') + tm + ':' + (ts < 10 ? '0' : '') + ts;
          items.push({
            type: 'timer',
            text: 'Safe timer, ' + tStr + ' left',
            icon: 'timer',
            isSos: false,
            action: function() {
              SafeHer.router.go('safe-timer');
            }
          });
        }
      }
    } catch (e) {}

    // (4) Ride Safety: "Ride <vehicle number>, ends by <time>"
    try {
      var rawRide = localStorage.getItem('safeher_active_ride');
      if (rawRide) {
        var ride = JSON.parse(rawRide);
        if (ride && ride.status === 'active') {
          var vehNum = ride.vehicleNumber || 'Cab';
          var endsStr = 'soon';
          if (ride.expectedArrival) {
            var arrDt = new Date(ride.expectedArrival);
            if (!isNaN(arrDt.getTime())) {
              endsStr = arrDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
          }
          items.push({
            type: 'ride',
            text: 'Ride ' + vehNum + ', ends by ' + endsStr,
            icon: 'local_taxi',
            isSos: false,
            action: function() {
              SafeHer.router.go('ride');
            }
          });
        }
      }
    } catch (e) {}

    // (5) Share Location: "Sharing until <time>"
    try {
      var shareSession = null;
      if (SafeHer.shareLocation && SafeHer.shareLocation.getActiveSession) {
        shareSession = SafeHer.shareLocation.getActiveSession();
      } else {
        var rawShare = localStorage.getItem('safeher_share_session');
        if (rawShare) shareSession = JSON.parse(rawShare);
      }

      if (shareSession && shareSession.active) {
        if (shareSession.endTime && Date.now() >= shareSession.endTime) {
          // expired session
        } else {
          var untilStr = shareSession.endTimeStr || 'until stopped';
          if (shareSession.endTime) {
            var sDt = new Date(shareSession.endTime);
            if (!isNaN(sDt.getTime())) {
              untilStr = sDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
          }
          items.push({
            type: 'share',
            text: 'Sharing until ' + untilStr,
            icon: 'share_location',
            isSos: false,
            action: function() {
              SafeHer.router.go('share-location');
            }
          });
        }
      }
    } catch (e) {}

    // Hide the whole section when nothing is active
    if (items.length === 0) {
      container.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    container.style.display = 'flex';
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var rowClass = 'active-now-row' + (it.isSos ? ' active-now-sos' : '');
      html += '<div class="' + rowClass + '" data-idx="' + i + '">' +
        '<div class="active-now-left">' +
          '<span class="material-symbols-rounded active-now-icon">' + it.icon + '</span>' +
          '<span class="active-now-text">' + escapeHtml(it.text) + '</span>' +
        '</div>' +
        '<span class="material-symbols-rounded active-now-chevron">chevron_right</span>' +
      '</div>';
    }
    container.innerHTML = html;

    var rows = container.querySelectorAll('.active-now-row');
    rows.forEach(function(row) {
      row.addEventListener('click', function() {
        var idx = parseInt(row.getAttribute('data-idx'), 10);
        if (items[idx] && items[idx].action) {
          items[idx].action();
        }
      });
    });
  }

  // ── 4. Finish Setup (Below SOS, above tiles) ─────────────
  function updateFinishSetup() {
    var card = document.getElementById('home-finish-setup');
    if (!card) return;

    // "Hide for now" persists until next login in sessionStorage
    if (sessionStorage.getItem('safeher_hide_finish_setup') === 'true') {
      card.style.display = 'none';
      return;
    }

    // 1. Contact check
    var contacts = (SafeHer.api && SafeHer.api.getContacts) ? SafeHer.api.getContacts() : [];
    var contactDone = Boolean(contacts && contacts.length > 0);

    // 2. PIN check
    var pinDone = Boolean(SafeHer.api && SafeHer.api.hasPin && SafeHer.api.hasPin());

    // 3. Notification permission check
    var notifDone = typeof Notification !== 'undefined' && Notification.permission === 'granted';

    function renderSetupCardWithLoc(isLocGranted) {
      var totalDone = (contactDone ? 1 : 0) + (pinDone ? 1 : 0) + (isLocGranted ? 1 : 0) + (notifDone ? 1 : 0);

      // Hide card automatically when all 4 items are done
      if (totalDone === 4) {
        card.style.display = 'none';
        return;
      }

      card.style.display = 'block';
      var progressPercent = Math.round((totalDone / 4) * 100);

      var html = '<div class="finish-setup-header">' +
        '<h4 class="finish-setup-title">Finish setup (' + totalDone + ' of 4)</h4>' +
        '<button type="button" class="finish-setup-hide" id="finish-setup-hide-btn">Hide for now</button>' +
      '</div>' +
      '<div class="finish-setup-progress-track">' +
        '<div class="finish-setup-progress-fill" style="width: ' + progressPercent + '%;"></div>' +
      '</div>' +
      '<div class="finish-setup-list">' +
        // Row 1: Contacts
        '<div class="finish-setup-item">' +
          '<div class="finish-setup-item-left">' +
            '<span class="material-symbols-rounded finish-setup-item-icon ' + (contactDone ? 'done' : 'pending') + '">' +
              (contactDone ? 'check_circle' : 'radio_button_unchecked') +
            '</span>' +
            '<span class="finish-setup-item-text">Add at least 1 trusted contact</span>' +
          '</div>' +
          (contactDone ? '' : '<button type="button" class="finish-setup-do-btn" id="fs-btn-contact">Do it</button>') +
        '</div>' +
        // Row 2: Safety PIN
        '<div class="finish-setup-item">' +
          '<div class="finish-setup-item-left">' +
            '<span class="material-symbols-rounded finish-setup-item-icon ' + (pinDone ? 'done' : 'pending') + '">' +
              (pinDone ? 'check_circle' : 'radio_button_unchecked') +
            '</span>' +
            '<span class="finish-setup-item-text">Set your Safety PIN</span>' +
          '</div>' +
          (pinDone ? '' : '<button type="button" class="finish-setup-do-btn" id="fs-btn-pin">Do it</button>') +
        '</div>' +
        // Row 3: Allow location
        '<div class="finish-setup-item">' +
          '<div class="finish-setup-item-left">' +
            '<span class="material-symbols-rounded finish-setup-item-icon ' + (isLocGranted ? 'done' : 'pending') + '">' +
              (isLocGranted ? 'check_circle' : 'radio_button_unchecked') +
            '</span>' +
            '<span class="finish-setup-item-text">Allow location</span>' +
          '</div>' +
          (isLocGranted ? '' : '<button type="button" class="finish-setup-do-btn" id="fs-btn-loc">Do it</button>') +
        '</div>' +
        // Row 4: Turn on notifications
        '<div class="finish-setup-item">' +
          '<div class="finish-setup-item-left">' +
            '<span class="material-symbols-rounded finish-setup-item-icon ' + (notifDone ? 'done' : 'pending') + '">' +
              (notifDone ? 'check_circle' : 'radio_button_unchecked') +
            '</span>' +
            '<span class="finish-setup-item-text">Turn on notifications</span>' +
          '</div>' +
          (notifDone ? '' : '<button type="button" class="finish-setup-do-btn" id="fs-btn-notif">Do it</button>') +
        '</div>' +
      '</div>';

      card.innerHTML = html;

      // Event listeners
      var hideBtn = document.getElementById('finish-setup-hide-btn');
      if (hideBtn) {
        hideBtn.addEventListener('click', function() {
          sessionStorage.setItem('safeher_hide_finish_setup', 'true');
          card.style.display = 'none';
        });
      }

      var btnContact = document.getElementById('fs-btn-contact');
      if (btnContact) {
        btnContact.addEventListener('click', function() {
          SafeHer.router.go('contacts');
        });
      }

      var btnPin = document.getElementById('fs-btn-pin');
      if (btnPin) {
        btnPin.addEventListener('click', function() {
          if (SafeHer.pin && SafeHer.pin.openSetPin) {
            SafeHer.pin.openSetPin('home', function() {
              updateFinishSetup();
            });
          } else {
            SafeHer.router.go('set-pin');
          }
        });
      }

      var btnLoc = document.getElementById('fs-btn-loc');
      if (btnLoc) {
        btnLoc.addEventListener('click', function() {
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
              function(pos) {
                locPermissionGranted = true;
                lastKnownCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                if (window.SafeHer) SafeHer.lastKnownLocation = lastKnownCoords;
                updateFinishSetup();
                fetchLocation(true);
                fetchNearestPolice();
              },
              function() {
                updateFinishSetup();
              },
              { timeout: 5000 }
            );
          }
        });
      }

      var btnNotif = document.getElementById('fs-btn-notif');
      if (btnNotif) {
        btnNotif.addEventListener('click', function() {
          if (typeof Notification !== 'undefined' && Notification.requestPermission) {
            Notification.requestPermission().then(function() {
              updateFinishSetup();
            });
          }
        });
      }
    }

    // Geolocation permission check via Permissions API
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(function(res) {
        var isGranted = (res && res.state === 'granted') || locPermissionGranted;
        if (res && res.state === 'granted') locPermissionGranted = true;
        renderSetupCardWithLoc(isGranted);
      }).catch(function() {
        renderSetupCardWithLoc(locPermissionGranted || locFetched);
      });
    } else {
      renderSetupCardWithLoc(locPermissionGranted || locFetched);
    }
  }

  // ── 5. Nearest Police Station Card ──────────────────────
  function getSharedPoliceCache() {
    try {
      var cache = null;
      if (SafeHer.storage && SafeHer.storage.get) {
        cache = SafeHer.storage.get(POLICE_CACHE_KEY);
      } else {
        var raw = localStorage.getItem(POLICE_CACHE_KEY);
        if (raw) cache = JSON.parse(raw);
      }
      if (cache && cache.police && cache.police.places && cache.police.places.length > 0) {
        return cache.police;
      }
    } catch (e) {}
    return null;
  }

  function saveSharedPoliceCache(places, lat, lng) {
    try {
      var cache = {};
      if (SafeHer.storage && SafeHer.storage.get) {
        cache = SafeHer.storage.get(POLICE_CACHE_KEY) || {};
      } else {
        var raw = localStorage.getItem(POLICE_CACHE_KEY);
        if (raw) cache = JSON.parse(raw);
      }
      cache.police = {
        places: places,
        lat: lat,
        lng: lng,
        timestamp: Date.now()
      };
      if (SafeHer.storage && SafeHer.storage.set) {
        SafeHer.storage.set(POLICE_CACHE_KEY, cache);
      } else {
        localStorage.setItem(POLICE_CACHE_KEY, JSON.stringify(cache));
      }
    } catch (e) {}
  }

  function renderPoliceStationView(station) {
    var card = document.getElementById('home-police-card');
    if (!card) return;

    var distText = station.distKm < 1 ? Math.round(station.distKm * 1000) + ' m' : station.distKm.toFixed(1) + ' km';
    var walkMins = Math.max(1, Math.round((station.distKm / 5) * 60));
    var dirUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(station.lat + ',' + station.lng) + '&travelmode=walking';
    var phone = station.phone || '';

    var html = '<div class="home-police-header">' +
      '<span class="material-symbols-rounded" style="font-size: 15px;">local_police</span>' +
      '<span>Nearest Police Station</span>' +
    '</div>' +
    '<p class="home-police-name">' + escapeHtml(station.name || 'Police Station') + '</p>' +
    '<p class="home-police-meta">' + escapeHtml(distText) + ' &bull; ~' + walkMins + ' min walk (5 km/h)</p>' +
    '<div class="home-police-actions">' +
      '<a href="' + escapeHtml(dirUrl) + '" target="_blank" rel="noopener noreferrer" class="btn btn-secondary home-police-btn">' +
        '<span class="material-symbols-rounded" style="font-size: 14px;">directions_walk</span> Directions' +
      '</a>' +
      (phone ? '<a href="tel:' + escapeHtml(phone) + '" class="btn btn-crimson home-police-btn"><span class="material-symbols-rounded" style="font-size: 14px;">call</span> Call</a>' : '') +
    '</div>';

    card.innerHTML = html;
  }

  function renderPoliceFallback() {
    var card = document.getElementById('home-police-card');
    if (!card) return;
    card.innerHTML = '<a href="#" class="home-police-fallback-link" onclick="SafeHer.router.go(\'nearby-places\'); return false;">' +
      '<span class="material-symbols-rounded" style="font-size: 18px;">local_police</span>' +
      '<span>Find nearby police stations &rarr;</span>' +
    '</a>';
  }

  function fetchNearestPolice() {
    var card = document.getElementById('home-police-card');
    if (!card) return;

    // 1. Check shared cache (valid for 30 minutes)
    var cached = getSharedPoliceCache();
    if (cached && cached.places && cached.places.length > 0) {
      var ageMs = Date.now() - (cached.timestamp || 0);
      if (ageMs < 30 * 60 * 1000) {
        renderPoliceStationView(cached.places[0]);
        return;
      }
    }

    // 2. Check user coords
    var lat = lastKnownCoords ? lastKnownCoords.lat : null;
    var lng = lastKnownCoords ? lastKnownCoords.lng : null;

    if (lat === null || lng === null) {
      if (navigator.geolocation) {
        card.innerHTML = '<div class="home-police-placeholder">Looking for nearest police station...</div>';
        navigator.geolocation.getCurrentPosition(
          function(pos) {
            lastKnownCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            if (window.SafeHer) SafeHer.lastKnownLocation = lastKnownCoords;
            queryOverpassPolice(pos.coords.latitude, pos.coords.longitude);
          },
          function() {
            renderPoliceFallback();
          },
          { timeout: 5000, maximumAge: 60000 }
        );
      } else {
        renderPoliceFallback();
      }
      return;
    }

    queryOverpassPolice(lat, lng);
  }

  function queryOverpassPolice(lat, lng) {
    var card = document.getElementById('home-police-card');
    if (!card) return;

    if (isPoliceQuerying) return;
    isPoliceQuerying = true;

    card.innerHTML = '<div class="home-police-placeholder">Looking for nearest police station...</div>';

    var query = '[out:json][timeout:8];(node["amenity"="police"](around:3000,' + lat + ',' + lng + ');way["amenity"="police"](around:3000,' + lat + ',' + lng + '););out center 8;';
    var endpoint = 'https://overpass-api.de/api/interpreter';

    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function() {
      if (controller) controller.abort();
    }, 8000);

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: 'data=' + encodeURIComponent(query),
      signal: controller ? controller.signal : undefined
    })
    .then(function(res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(json) {
      isPoliceQuerying = false;
      var elements = (json && json.elements) ? json.elements : [];
      if (!elements || elements.length === 0) {
        renderPoliceFallback();
        return;
      }

      var places = [];
      for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        var pLat = el.lat !== undefined ? el.lat : (el.center ? el.center.lat : null);
        var pLng = el.lon !== undefined ? el.lon : (el.center ? el.center.lon : null);
        if (pLat === null || pLng === null) continue;

        var tags = el.tags || {};
        var name = tags.name || tags['name:en'] || tags['operator'] || 'Police Station';
        var phone = tags.phone || tags['contact:phone'] || tags['contact:mobile'] || tags['telephone'] || '';
        var distKm = haversineDistKm(lat, lng, pLat, pLng);

        places.push({
          id: el.id,
          name: name,
          lat: pLat,
          lng: pLng,
          category: 'police',
          distKm: distKm,
          phone: phone
        });
      }

      if (places.length === 0) {
        renderPoliceFallback();
        return;
      }

      places.sort(function(a, b) { return a.distKm - b.distKm; });
      saveSharedPoliceCache(places, lat, lng);
      renderPoliceStationView(places[0]);
    })
    .catch(function(err) {
      isPoliceQuerying = false;
      clearTimeout(timer);
      var cached = getSharedPoliceCache();
      if (cached && cached.places && cached.places.length > 0) {
        renderPoliceStationView(cached.places[0]);
      } else {
        renderPoliceFallback();
      }
    });
  }

  // ── 6. Tip of the Day Card ──────────────────────────────
  function renderTipOfTheDay() {
    var card = document.getElementById('home-tip-card');
    if (!card) return;

    var allTips = [];
    if (SafeHer.api && SafeHer.api.getTips) {
      try {
        allTips = SafeHer.api.getTips() || [];
      } catch (e) {}
    }
    if (!allTips || allTips.length === 0) {
      allTips = FALLBACK_TIPS;
    }

    var now = new Date();
    var start = new Date(now.getFullYear(), 0, 0);
    var diff = (now - start) + ((start.getTimezoneOffset() - now.getTimezoneOffset()) * 60 * 1000);
    var oneDay = 1000 * 60 * 60 * 24;
    var dayOfYear = Math.floor(diff / oneDay);

    var tip = allTips[dayOfYear % allTips.length];
    var title = tip.title || 'Safety Tip';
    var line = (tip.lines && tip.lines.length > 0) ? tip.lines[0] : (tip.desc || title);

    var html = '<div class="home-tip-header">' +
      '<span class="material-symbols-rounded" style="font-size: 15px;">lightbulb</span>' +
      '<span>Tip of the day</span>' +
    '</div>' +
    '<h4 class="home-tip-title">' + escapeHtml(title) + '</h4>' +
    '<p class="home-tip-desc">' + escapeHtml(line) + '</p>' +
    '<a href="#" class="home-tip-link" onclick="SafeHer.router.go(\'tips\'); return false;">More tips &rarr;</a>';

    card.innerHTML = html;
  }

  // ── 7. Footer Row: Contacts & Volunteers ────────────────
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

  // ── 8. Emergency Info Screen Helpers ────────────────────
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
    renderActiveNow();
    updateFinishSetup();
    fetchNearestPolice();
    renderTipOfTheDay();

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

    // 5-second polling for active states
    if (activeNowInterval) clearInterval(activeNowInterval);
    activeNowInterval = setInterval(function() {
      var currentScreen = (SafeHer.router && SafeHer.router.getCurrentScreen) ? SafeHer.router.getCurrentScreen() : '';
      if (!currentScreen || currentScreen === 'home') {
        renderActiveNow();
      }
    }, 5000);
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
    renderEmergencyInfo: renderEmergencyInfo,
    renderActiveNow: renderActiveNow,
    updateFinishSetup: updateFinishSetup,
    fetchNearestPolice: fetchNearestPolice,
    renderTipOfTheDay: renderTipOfTheDay
  };
})();
