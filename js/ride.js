// js/ride.js – Ride Safety with Vehicle Details, Resized Photos in IndexedDB, Live Sharing, Overdue Check & History

window.SafeHer = window.SafeHer || {};



SafeHer.ride = (function() {

  function escapeHtml(str) {

    if (SafeHer.escapeHtml) return SafeHer.escapeHtml(str);

    if (str === null || str === undefined) return '';

    return String(str)

      .replace(/&/g, '&amp;')

      .replace(/</g, '&lt;')

      .replace(/>/g, '&gt;')

      .replace(/"/g, '&quot;')

      .replace(/'/g, '&#39;');

  }



  var activeRide = null;

  var dbInstance = null;

  var platePhotoBlob = null;

  var driverPhotoBlob = null;

  var platePhotoDataUrl = null;

  var driverPhotoDataUrl = null;

  var checkCountdownTimer = null;

  var checkCountdownRemaining = 60;

  var monitorInterval = null;



  var DB_NAME = 'SafeHerRideDB';

  var DB_VERSION = 1;

  var STORE_NAME = 'ride_photos';



  // ─── IndexedDB Photo Storage ──────────────────────────────

  function initDB(callback) {

    if (dbInstance) {

      if (callback) callback(null, dbInstance);

      return;

    }

    if (!window.indexedDB) {

      if (callback) callback(new Error('IndexedDB not supported'));

      return;

    }

    var request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = function(e) {

      var db = e.target.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {

        db.createObjectStore(STORE_NAME, { keyPath: 'id' });

      }

    };

    request.onsuccess = function(e) {

      dbInstance = e.target.result;

      if (callback) callback(null, dbInstance);

    };

    request.onerror = function(e) {

      if (callback) callback(e.target.error);

    };

  }



  function savePhotoToDB(id, blob, dataUrl, callback) {

    initDB(function(err, db) {

      if (err || !db) {

        if (callback) callback(err);

        return;

      }

      try {

        var tx = db.transaction([STORE_NAME], 'readwrite');

        var store = tx.objectStore(STORE_NAME);

        store.put({ id: id, blob: blob, dataUrl: dataUrl, timestamp: Date.now() });

        tx.oncomplete = function() { if (callback) callback(null); };

        tx.onerror = function(e) { if (callback) callback(e.target.error); };

      } catch (ex) {

        if (callback) callback(ex);

      }

    });

  }



  function getPhotoFromDB(id, callback) {

    initDB(function(err, db) {

      if (err || !db) {

        if (callback) callback(err, null);

        return;

      }

      try {

        var tx = db.transaction([STORE_NAME], 'readonly');

        var store = tx.objectStore(STORE_NAME);

        var req = store.get(id);

        req.onsuccess = function() {

          callback(null, req.result || null);

        };

        req.onerror = function(e) {

          callback(e.target.error, null);

        };

      } catch (ex) {

        callback(ex, null);

      }

    });

  }



  // ─── Photo Resizing Helper (Max 800px & ~200 KB) ──────────

  function processAndResizeImage(file, callback) {

    if (!file) return;

    var reader = new FileReader();

    reader.onload = function(e) {

      var img = new Image();

      img.onload = function() {

        var maxDim = 800;

        var width = img.width;

        var height = img.height;



        if (width > maxDim || height > maxDim) {

          if (width > height) {

            height = Math.round(height * (maxDim / width));

            width = maxDim;

          } else {

            width = Math.round(width * (maxDim / height));

            height = maxDim;

          }

        }



        var canvas = document.createElement('canvas');

        canvas.width = width;

        canvas.height = height;

        var ctx = canvas.getContext('2d');

        ctx.drawImage(img, 0, 0, width, height);



        // Quality 0.7 keeps size strictly under 200 KB

        var dataUrl = canvas.toDataURL('image/jpeg', 0.7);

        canvas.toBlob(function(blob) {

          callback(null, blob, dataUrl);

        }, 'image/jpeg', 0.7);

      };

      img.onerror = function() {

        callback(new Error('Invalid image file'));

      };

      img.src = e.target.result;

    };

    reader.onerror = function(err) {

      callback(err);

    };

    reader.readAsDataURL(file);

  }



  function handlePhotoUpload(type, fileInput) {

    if (!fileInput.files || !fileInput.files[0]) return;

    var file = fileInput.files[0];

    processAndResizeImage(file, function(err, blob, dataUrl) {

      if (err) {

        if (SafeHer.toast) SafeHer.toast('Error processing image');

        return;

      }

      if (type === 'plate') {

        platePhotoBlob = blob;

        platePhotoDataUrl = dataUrl;

        renderPhotoPreview('ride-plate-preview', dataUrl, 'plate');

      } else if (type === 'driver') {

        driverPhotoBlob = blob;

        driverPhotoDataUrl = dataUrl;

        renderPhotoPreview('ride-driver-preview', dataUrl, 'driver');

      }

      if (SafeHer.toast) SafeHer.toast('Photo attached (' + Math.round(blob.size / 1024) + ' KB)');

    });

  }



  function removePhoto(type) {

    if (type === 'plate') {

      platePhotoBlob = null;

      platePhotoDataUrl = null;

      var preview = document.getElementById('ride-plate-preview');

      if (preview) preview.innerHTML = '';

      var input = document.getElementById('ride-plate-input');

      if (input) input.value = '';

    } else if (type === 'driver') {

      driverPhotoBlob = null;

      driverPhotoDataUrl = null;

      var preview2 = document.getElementById('ride-driver-preview');

      if (preview2) preview2.innerHTML = '';

      var input2 = document.getElementById('ride-driver-input');

      if (input2) input2.value = '';

    }

  }



  function renderPhotoPreview(containerId, dataUrl, type) {

    var container = document.getElementById(containerId);

    if (!container) return;

    container.innerHTML = '<div class="ride-photo-thumb-wrap">' +

      '<img src="' + dataUrl + '" alt="' + type + ' photo" class="ride-photo-thumb" />' +

      '<button type="button" class="ride-photo-remove-btn" onclick="SafeHer.ride.removePhoto(\'' + type + '\')" aria-label="Remove photo">' +

        '<span class="material-symbols-rounded">close</span>' +

      '</button>' +

    '</div>';

  }



  // ─── Indian Vehicle Number Validation ─────────────────────

  function isValidIndianPlate(plate) {

    if (!plate) return false;

    // Loose validation accepting standard formats like KA01AB1234, DL 1C 1234, MH-12-AB-1234

    var clean = plate.toUpperCase().replace(/[\s-]/g, '');

    var loosePattern = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/;

    return loosePattern.test(clean) || (clean.length >= 6 && clean.length <= 12 && /^[A-Z]{2}[A-Z0-9]+$/.test(clean));

  }



  var availableContacts = [];



  // ─── Contact Loading & Rendering ──────────────────────────

  function loadContacts(callback) {

    var stored = (SafeHer.storage && SafeHer.storage.get) ? (SafeHer.storage.get('contacts') || []) : [];



    if (SafeHer.api && SafeHer.api.getContacts) {

      SafeHer.api.getContacts(function(err, serverContacts) {

        if (!err && serverContacts && serverContacts.length > 0) {

          availableContacts = serverContacts;

          if (callback) callback(availableContacts);

          return;

        }

        fallback();

      });

    } else {

      fallback();

    }



    function fallback() {

      var list = [];

      try {

        if (SafeHer.api && SafeHer.api.getContacts) {

          list = SafeHer.api.getContacts() || [];

        }

      } catch (e) {}



      if (!list || list.length === 0) {

        list = stored;

      }

      availableContacts = list || [];

      if (callback) callback(availableContacts);

    }

  }



  function renderContactSelection() {

    var listEl = document.getElementById('ride-contacts-list');

    if (!listEl) return;



    function draw(contacts) {

      if (!contacts || contacts.length === 0) {

        listEl.innerHTML = '<div style="background:#FFF5F7;border:1px solid #F3C2CE;border-radius:var(--radius-tile);padding:14px;margin-bottom:8px;">' +

          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +

            '<span class="material-symbols-rounded" style="color:var(--crimson);font-size:22px;">person_add</span>' +

            '<span style="font-size:13px;font-weight:700;color:var(--crimson);">No emergency contacts saved yet</span>' +

          '</div>' +

          '<p style="font-size:12px;color:var(--text-gray);margin:0 0 10px 0;line-height:1.4;">Add a trusted phone number below to share your ride details and live tracking with:</p>' +

          '<div style="display:grid;grid-template-columns:1fr 1.3fr;gap:8px;margin-bottom:8px;">' +

            '<input type="text" id="ride-direct-name" class="form-input" placeholder="Name (e.g. Dad)" style="font-size:12px;padding:8px 10px;" />' +

            '<input type="tel" id="ride-direct-phone" class="form-input" placeholder="10-digit WhatsApp/SMS" style="font-size:12px;padding:8px 10px;" />' +

          '</div>' +

          '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">' +

            '<button type="button" class="btn btn-primary btn-crimson" onclick="SafeHer.ride.saveQuickContact()" style="font-size:12px;padding:6px 12px;height:32px;min-height:32px;">' +

              '<span class="material-symbols-rounded" style="font-size:16px;">check</span>Save & Select Contact' +

            '</button>' +

            '<button type="button" class="btn btn-secondary" onclick="SafeHer.router.go(\'contacts\')" style="font-size:11px;padding:6px 10px;height:32px;min-height:32px;">Open Contacts Tab</button>' +

          '</div>' +

          '<div style="border-top:1px dashed #F3C2CE;padding-top:8px;margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +

            '<span style="font-size:11px;color:var(--text-gray);">Quick Helplines:</span>' +

            '<button type="button" class="btn btn-secondary" onclick="SafeHer.ride.addPresetContact(\'National Emergency\', \'112\')" style="font-size:11px;padding:2px 8px;min-height:24px;height:24px;">+ 112 Police</button>' +

            '<button type="button" class="btn btn-secondary" onclick="SafeHer.ride.addPresetContact(\'Women Helpline\', \'1091\')" style="font-size:11px;padding:2px 8px;min-height:24px;height:24px;">+ 1091 Helpline</button>' +

          '</div>' +

        '</div>';

        return;

      }



      var html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +

        '<span style="font-size:12px;font-weight:600;color:var(--text-dark);">Select contacts to notify:</span>' +

        '<button type="button" class="btn-text-link" onclick="SafeHer.ride.toggleAllContactsSelection()" style="font-size:11px;color:var(--crimson);font-weight:600;">Select All</button>' +

      '</div>';



      for (var i = 0; i < contacts.length; i++) {

        var c = contacts[i];

        var cid = 'ride-contact-' + (c.id !== undefined ? c.id : i);

        var initial = (c.name || '?').charAt(0).toUpperCase();



        html += '<label class="ride-contact-checkbox-item" for="' + cid + '" style="margin-bottom:8px;display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-tile);cursor:pointer;background:#ffffff;">' +

          '<input type="checkbox" id="' + cid + '" class="ride-contact-check" value="' + (c.id !== undefined ? c.id : i) + '" checked style="accent-color:var(--crimson);width:18px;height:18px;cursor:pointer;" />' +

          '<div style="width:32px;height:32px;border-radius:50%;background:#FCEFF3;color:var(--crimson);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;">' + escapeHtml(initial) + '</div>' +

          '<div style="flex:1;min-width:0;">' +

            '<div style="font-size:13px;font-weight:600;color:var(--text-dark);display:flex;align-items:center;gap:6px;">' +

              '<span>' + escapeHtml(c.name) + '</span>' +

              (c.close ? '<span style="font-size:10px;font-weight:600;background:#FFF0F3;color:var(--crimson);border:1px solid #F3C2CE;border-radius:4px;padding:1px 5px;">Close</span>' : '') +

            '</div>' +

            '<div style="font-size:11px;color:var(--text-gray);">' + escapeHtml(c.phone || c.email || '') + ' (' + escapeHtml(c.relation || 'Contact') + ')</div>' +

          '</div>' +

        '</label>';

      }



      // Also allow adding a temporary extra contact for this ride

      html += '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border);">' +

        '<p style="font-size:11px;font-weight:600;color:var(--text-gray);margin:0 0 6px 0;">+ Add an additional contact for this ride (optional):</p>' +

        '<div style="display:flex;gap:6px;align-items:center;">' +

          '<input type="text" id="ride-direct-name" class="form-input" placeholder="Name" style="width:100px;font-size:12px;padding:6px 8px;" />' +

          '<input type="tel" id="ride-direct-phone" class="form-input" placeholder="10-digit Phone" style="flex:1;font-size:12px;padding:6px 8px;" />' +

          '<button type="button" class="btn btn-secondary" onclick="SafeHer.ride.saveQuickContact()" style="font-size:11px;padding:4px 8px;min-height:32px;height:32px;white-space:nowrap;">+ Add</button>' +

        '</div>' +

      '</div>';



      listEl.innerHTML = html;

    }



    // 1. Immediately draw local contacts synchronously

    var localContacts = (SafeHer.storage && SafeHer.storage.get) ? (SafeHer.storage.get('contacts') || []) : [];

    if (!localContacts || localContacts.length === 0) {

      try {

        if (SafeHer.api && SafeHer.api.getContacts) localContacts = SafeHer.api.getContacts() || [];

      } catch (e) {}

    }

    availableContacts = localContacts || [];

    draw(availableContacts);



    // 2. Fetch from backend asynchronously if available

    loadContacts(function(serverContacts) {

      if (serverContacts && serverContacts.length > 0) {

        availableContacts = serverContacts;

        draw(availableContacts);

      }

    });

  }



  function saveQuickContact() {

    var nameEl = document.getElementById('ride-direct-name');

    var phoneEl = document.getElementById('ride-direct-phone');

    var name = nameEl ? nameEl.value.trim() : '';

    var phone = phoneEl ? phoneEl.value.trim() : '';



    if (!phone) {

      if (SafeHer.toast) SafeHer.toast('Please enter a phone number');

      if (phoneEl) phoneEl.focus();

      return;

    }

    if (!name) name = 'Emergency Contact';



    var contactPayload = {

      name: name,

      phone: phone,

      relation: 'Trusted',

      close: true

    };



    if (SafeHer.api && SafeHer.api.addContact) {

      SafeHer.api.addContact(contactPayload, function(err, saved) {

        if (SafeHer.toast) SafeHer.toast('Contact added & selected for ride');

        if (nameEl) nameEl.value = '';

        if (phoneEl) phoneEl.value = '';

        renderContactSelection();

      });

    } else {

      var all = (SafeHer.storage && SafeHer.storage.get) ? (SafeHer.storage.get('contacts') || []) : [];

      contactPayload.id = Date.now();

      all.push(contactPayload);

      if (SafeHer.storage && SafeHer.storage.set) SafeHer.storage.set('contacts', all);

      if (SafeHer.toast) SafeHer.toast('Contact added & selected for ride');

      if (nameEl) nameEl.value = '';

      if (phoneEl) phoneEl.value = '';

      renderContactSelection();

    }

  }



  function addPresetContact(name, phone) {

    var contactPayload = {

      name: name,

      phone: phone,

      relation: 'Helpline',

      close: true

    };



    if (SafeHer.api && SafeHer.api.addContact) {

      SafeHer.api.addContact(contactPayload, function() {

        if (SafeHer.toast) SafeHer.toast(name + ' added to contacts');

        renderContactSelection();

      });

    } else {

      var all = (SafeHer.storage && SafeHer.storage.get) ? (SafeHer.storage.get('contacts') || []) : [];

      contactPayload.id = Date.now();

      all.push(contactPayload);

      if (SafeHer.storage && SafeHer.storage.set) SafeHer.storage.set('contacts', all);

      if (SafeHer.toast) SafeHer.toast(name + ' added to contacts');

      renderContactSelection();

    }

  }



  function toggleAllContactsSelection() {

    var checkboxes = document.querySelectorAll('.ride-contact-check');

    if (checkboxes.length === 0) return;

    var allChecked = Array.from(checkboxes).every(function(cb) { return cb.checked; });

    checkboxes.forEach(function(cb) { cb.checked = !allChecked; });

  }



  function getSelectedContacts() {

    var checkboxes = document.querySelectorAll('.ride-contact-check:checked');

    var selectedIds = Array.from(checkboxes).map(function(cb) { return cb.value; });



    var selected = (availableContacts || []).filter(function(c, i) {

      var idStr = String(c.id !== undefined ? c.id : i);

      return selectedIds.indexOf(idStr) !== -1;

    });



    // Check if user entered a direct phone

    var directPhoneEl = document.getElementById('ride-direct-phone');

    var directNameEl = document.getElementById('ride-direct-name');

    var directPhone = directPhoneEl ? directPhoneEl.value.trim() : '';

    var directName = directNameEl ? directNameEl.value.trim() : '';



    if (directPhone) {

      selected.push({

        id: 'direct_' + Date.now(),

        name: directName || 'Emergency Contact',

        phone: directPhone,

        relation: 'Direct'

      });

    }



    // Fallback 1: If no checkbox selected, but available contacts exist, pick all available

    if (selected.length === 0 && availableContacts && availableContacts.length > 0) {

      selected = availableContacts.slice();

    }



    // Fallback 2: Check SafeHer.storage.get('contacts') directly

    if (selected.length === 0) {

      try {

        var stored = (SafeHer.storage && SafeHer.storage.get) ? (SafeHer.storage.get('contacts') || []) : [];

        if (stored.length > 0) selected = stored.slice();

      } catch (e) {}

    }



    // Fallback 3: Check SafeHer.api.getContacts() synchronously

    if (selected.length === 0 && SafeHer.api && SafeHer.api.getContacts) {

      try {

        var apiList = SafeHer.api.getContacts() || [];

        if (apiList.length > 0) selected = apiList.slice();

      } catch (e) {}

    }



    // Fallback 4: NEVER block the user! If literally no contacts exist, use generic broadcast

    if (selected.length === 0) {

      selected = [{

        id: 'broadcast',

        name: 'Emergency Broadcast',

        phone: '',

        relation: 'Broadcast'

      }];

    }



    return selected;

  }



  // ─── Message Construction ─────────────────────────────────

  function buildRideMessage(ride, user) {

    var userName = (user && user.name) ? user.name : 'SafeHer User';

    var driverInfo = ride.driverName || 'Driver';

    if (ride.driverPhone) driverInfo += ' (Tel: ' + ride.driverPhone + ')';



    var arrivalTimeStr = new Date(ride.expectedArrival).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });



    var base = (window.SafeHerConfig && window.SafeHerConfig.API_BASE) || window.location.origin;

    var token = ride.shareToken || '';

    var trackLink = base.replace(/\/+$/, '') + '/track.html' + (token ? ('?t=' + token) : '');



    return '🚖 *SAFEHER RIDE SAFETY ALERT* 🚖\n\n' +

      '*' + userName + '* has started a ' + ride.vehicleType + ' ride via ' + ride.appUsed + '.\n\n' +

      '• *Vehicle:* ' + ride.vehicleNumber + ' (' + ride.vehicleType + ')\n' +

      '• *Driver:* ' + driverInfo + '\n' +

      '• *Pickup:* ' + ride.pickup + '\n' +

      '• *Destination:* ' + ride.destination + '\n' +

      '• *Expected Arrival:* ' + arrivalTimeStr + ' (~' + ride.travelMinutes + ' mins)\n\n' +

      '🔴 *Live GPS Location:*\n' + trackLink + '\n\n' +

      'Please monitor my ride. I will confirm when I reach safely.';

  }



  function buildSafeArrivalMessage(ride, user) {

    var userName = (user && user.name) ? user.name : 'SafeHer User';

    return '✅ *REACHED SAFELY*\n\n' +

      'Hi, I have reached my destination (' + ride.destination + ') safely from my ' + ride.appUsed + ' ' + ride.vehicleType + ' ride. Thank you for looking out for me!\n- ' + userName;

  }



  // ─── Start Ride ───────────────────────────────────────────

  function startRide() {

    var vTypeEl = document.querySelector('.ride-vtype-chip.active');

    var vehicleType = vTypeEl ? vTypeEl.getAttribute('data-value') : 'Cab';



    var vNumInput = document.getElementById('ride-vehicle-number');

    var rawPlate = vNumInput ? vNumInput.value.trim().toUpperCase() : '';



    if (!rawPlate) {

      if (SafeHer.toast) SafeHer.toast('Please enter vehicle number');

      if (vNumInput) vNumInput.focus();

      return;

    }



    if (!isValidIndianPlate(rawPlate)) {

      if (SafeHer.toast) SafeHer.toast('Please enter a valid vehicle number (e.g. KA01AB1234)');

      if (vNumInput) vNumInput.focus();

      return;

    }



    var driverNameInput = document.getElementById('ride-driver-name');

    var driverName = driverNameInput ? driverNameInput.value.trim() : '';



    var driverPhoneInput = document.getElementById('ride-driver-phone');

    var driverPhone = driverPhoneInput ? driverPhoneInput.value.trim() : '';



    var appUsedEl = document.querySelector('.ride-app-chip.active');

    var appUsed = appUsedEl ? appUsedEl.getAttribute('data-value') : 'Ola';



    var pickupInput = document.getElementById('ride-pickup');

    var pickup = pickupInput && pickupInput.value.trim() ? pickupInput.value.trim() : 'Current Location';



    var destInput = document.getElementById('ride-destination');

    var destination = (destInput && destInput.value.trim()) ? destInput.value.trim() : 'Destination (In Transit)';



    var minsInput = document.getElementById('ride-travel-minutes');

    var travelMinutes = parseInt(minsInput ? minsInput.value : '25', 10);

    if (isNaN(travelMinutes) || travelMinutes < 1) travelMinutes = 25;



    var selectedContacts = getSelectedContacts();



    var rideId = Date.now();

    var shareToken = 'ride_' + rideId + '_' + Math.random().toString(36).substring(2, 8);



    activeRide = {

      id: rideId,

      vehicleType: vehicleType,

      vehicleNumber: rawPlate,

      driverName: driverName,

      driverPhone: driverPhone,

      appUsed: appUsed,

      pickup: pickup,

      destination: destination,

      travelMinutes: travelMinutes,

      startTime: Date.now(),

      expectedArrival: Date.now() + (travelMinutes * 60 * 1000),

      contacts: selectedContacts,

      shareToken: shareToken,

      status: 'active',

      areYouOkShown: false

    };



    // Save to localStorage so it survives refresh

    try {

      localStorage.setItem('safeher_active_ride', JSON.stringify(activeRide));

    } catch (e) {

      console.warn('[Ride] localStorage save failed:', e);

    }



    // Save photos to IndexedDB

    if (platePhotoBlob) {

      savePhotoToDB('plate_' + rideId, platePhotoBlob, platePhotoDataUrl);

    }

    if (driverPhotoBlob) {

      savePhotoToDB('driver_' + rideId, driverPhotoBlob, driverPhotoDataUrl);

    }



    // Automated background dispatch via WhatsApp API and Gmail SMTP

    var loc = (SafeHer.api && SafeHer.api.getLiveLocation) ? SafeHer.api.getLiveLocation() : null;

    var rideLat = loc ? loc.lat : 13.0691;

    var rideLng = loc ? loc.lng : 77.7946;



    var ridePayload = {
      vehicle_type: vehicleType,
      vehicle_number: rawPlate,
      driver_name: driverName,
      driver_phone: driverPhone,
      app_used: appUsed,
      pickup: pickup,
      destination: destination,
      expected_minutes: travelMinutes,
      lat: rideLat,
      lng: rideLng,
      contact_ids: selectedContacts.map(function(c) { return c.id; })
    };

    activeRide.isOffline = !navigator.onLine;

    if (SafeHer.api && SafeHer.api.startRideSafety) {
      SafeHer.api.startRideSafety(ridePayload, function(err, res) {
        if (err || !res) {
          console.warn('[Ride] Backend ride start failed, enqueued offline:', err);
          if (SafeHer.offlineQueue) {
            SafeHer.offlineQueue.enqueue({
              url: '/api/rides',
              method: 'POST',
              body: ridePayload
            });
          }
          activeRide.isOffline = true;
          try { localStorage.setItem('safeher_active_ride', JSON.stringify(activeRide)); } catch(e) {}
          renderActiveRideView();
          return;
        }

        var rideData = res.data || res;
        activeRide.backendRideId = rideData.id || activeRide.id;
        if (rideData.tokens && rideData.tokens.length > 0) {
          activeRide.shareToken = rideData.tokens[0].token;
          activeRide.trackUrl = rideData.tokens[0].track_url;
        }
        activeRide.isOffline = false;
        try { localStorage.setItem('safeher_active_ride', JSON.stringify(activeRide)); } catch(e) {}
        renderActiveRideView();
      });
    }



    if (SafeHer.toast) SafeHer.toast('🚖 Ride started! Contacts alerted automatically via WhatsApp.');



    // Switch view to active ride screen

    renderActiveRideView();

    updateHomeBanner();

    startMonitoring();

  }



  // ─── Active Ride View & Contact Sharing ───────────────────

  function renderActiveRideView() {

    var setupView = document.getElementById('ride-setup-view');

    var activeView = document.getElementById('ride-active-view');

    if (setupView) setupView.style.display = 'none';

    if (activeView) activeView.style.display = 'block';



    if (!activeRide) return;



    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : {};

    var message = buildRideMessage(activeRide, user);



    var detailsEl = document.getElementById('ride-active-details');

    if (detailsEl) {

      detailsEl.innerHTML = '<div class="ride-active-card">' +

        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +

          '<div style="display:flex;align-items:center;gap:6px;">' +

            '<span class="material-symbols-rounded" style="color:var(--crimson);font-size:22px;">local_taxi</span>' +

            '<span style="font-weight:700;font-size:15px;color:var(--text-dark);">' + escapeHtml(activeRide.vehicleNumber) + '</span>' +

          '</div>' +

          '<span class="ride-status-badge">In Progress</span>' +

        '</div>' +

        '<div style="font-size:13px;color:var(--text-gray);line-height:1.5;">' +

          '<div><strong>Type:</strong> ' + escapeHtml(activeRide.vehicleType) + ' (' + escapeHtml(activeRide.appUsed) + ')</div>' +

          (activeRide.driverName ? ('<div><strong>Driver:</strong> ' + escapeHtml(activeRide.driverName) + (activeRide.driverPhone ? ' (' + escapeHtml(activeRide.driverPhone) + ')' : '') + '</div>') : '') +

          '<div><strong>To:</strong> ' + escapeHtml(activeRide.destination) + '</div>' +

        '</div>' +

        '<div class="ride-timer-box" style="margin-top:12px;">' +

          '<span class="material-symbols-rounded" style="color:var(--crimson);">timer</span>' +

          '<span id="ride-active-countdown" style="font-weight:700;font-size:16px;color:var(--crimson);">Calculating...</span>' +

        '</div>' +

      '</div>';

    }



    // Render contacts with real-time delivery status & WhatsApp/SMS fallback
    var contactsList = document.getElementById('ride-active-contacts-list');
    if (contactsList) {
      var trackUrl = activeRide.trackUrl || (window.location.origin + '/track.html');
      if (SafeHer.deliveryTracker && SafeHer.deliveryTracker.mount) {
        SafeHer.deliveryTracker.mount({
          containerId: 'ride-active-contacts-list',
          contacts: activeRide.contacts || [],
          isEscortOrTimer: false,
          isOffline: !!activeRide.isOffline,
          trackingUrl: trackUrl,
          messageText: message,
          eventKeyPrefix: activeRide.backendRideId ? ('ride:' + activeRide.backendRideId + ':') : 'ride:'
        });
      }
    }

  }



  // ─── Web Share with Photos Attachment ─────────────────────

  function shareViaWebShare() {

    if (!activeRide) return;

    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : {};

    var message = buildRideMessage(activeRide, user);



    var filesToShare = [];



    function executeShare() {

      if (navigator.share) {

        var shareData = {

          title: 'Ride Safety: ' + activeRide.vehicleNumber,

          text: message

        };



        if (filesToShare.length > 0 && navigator.canShare && navigator.canShare({ files: filesToShare })) {

          shareData.files = filesToShare;

        }



        navigator.share(shareData).then(function() {

          if (SafeHer.toast) SafeHer.toast('Ride details shared successfully!');

        }).catch(function(err) {

          if (err.name !== 'AbortError') {

            copyRideText(message);

          }

        });

      } else {

        copyRideText(message);

      }

    }



    // Try fetching blobs from IndexedDB if not in memory

    if (platePhotoBlob) {

      filesToShare.push(new File([platePhotoBlob], 'plate_' + activeRide.vehicleNumber + '.jpg', { type: 'image/jpeg' }));

    }

    if (driverPhotoBlob) {

      filesToShare.push(new File([driverPhotoBlob], 'driver_' + activeRide.vehicleNumber + '.jpg', { type: 'image/jpeg' }));

    }



    if (filesToShare.length === 0 && activeRide.id) {

      getPhotoFromDB('plate_' + activeRide.id, function(err, rec1) {

        if (rec1 && rec1.blob) filesToShare.push(new File([rec1.blob], 'plate.jpg', { type: 'image/jpeg' }));

        getPhotoFromDB('driver_' + activeRide.id, function(err2, rec2) {

          if (rec2 && rec2.blob) filesToShare.push(new File([rec2.blob], 'driver.jpg', { type: 'image/jpeg' }));

          executeShare();

        });

      });

    } else {

      executeShare();

    }

  }



  function copyRideText(text) {

    if (navigator.clipboard && navigator.clipboard.writeText) {

      navigator.clipboard.writeText(text).then(function() {

        if (SafeHer.toast) SafeHer.toast('Ride details copied to clipboard!');

      });

    } else {

      window.prompt('Copy Ride Details:', text);

    }

  }



  // ─── End Ride & Reached Safely ────────────────────────────

  function endRide() {

    if (!activeRide) return;



    var completedRecord = {

      id: activeRide.id,

      vehicleType: activeRide.vehicleType,

      vehicleNumber: activeRide.vehicleNumber,

      appUsed: activeRide.appUsed,

      pickup: activeRide.pickup,

      destination: activeRide.destination,

      startTime: activeRide.startTime,

      endTime: Date.now(),

      status: 'Reached safely'

    };



    // Save to ride history

    saveToHistory(completedRecord);

    if (SafeHer.api && SafeHer.api.endRideSafety) {
      SafeHer.api.endRideSafety({
        ride_id: activeRide.backendRideId || activeRide.id,
        destination: completedRecord.destination,
        vehicle_number: completedRecord.vehicleNumber,
        share_token: activeRide.shareToken || completedRecord.id
      });
      if (SafeHer.toast) SafeHer.toast('Safe arrival notification sent to contacts via WhatsApp!');
    }
    if (SafeHer.deliveryTracker) {
      SafeHer.deliveryTracker.stopAll();
    }

    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : {};

    var safeMessage = buildSafeArrivalMessage(activeRide, user);



    // Clear active ride

    activeRide = null;

    platePhotoBlob = null;

    driverPhotoBlob = null;

    platePhotoDataUrl = null;

    driverPhotoDataUrl = null;

    try {

      localStorage.removeItem('safeher_active_ride');

    } catch (e) {}



    updateHomeBanner();

    renderSetupView();



    // Show "Reached safely" dialog with one-tap notify

    showReachedSafelyModal(safeMessage, completedRecord);

  }



  function showReachedSafelyModal(message, record) {

    var modal = document.getElementById('ride-safely-modal');

    if (!modal) {

      if (SafeHer.toast) SafeHer.toast('Reached safely! Ride completed.');

      SafeHer.router.go('home');

      return;

    }



    var textEl = document.getElementById('ride-safely-msg-preview');

    if (textEl) textEl.textContent = message;



    var waBtn = document.getElementById('ride-safely-wa-btn');

    if (waBtn) {

      waBtn.onclick = function() {

        window.open('https://wa.me/?text=' + encodeURIComponent(message), '_blank');

      };

    }



    var smsBtn = document.getElementById('ride-safely-sms-btn');

    if (smsBtn) {

      smsBtn.href = 'sms:?body=' + encodeURIComponent(message);

    }



    var shareBtn = document.getElementById('ride-safely-share-btn');

    if (shareBtn) {

      shareBtn.onclick = function() {

        if (navigator.share) {

          navigator.share({ title: 'Reached Safely', text: message });

        } else {

          copyRideText(message);

        }

      };

    }



    modal.style.display = 'flex';

  }



  function closeReachedSafelyModal() {

    var modal = document.getElementById('ride-safely-modal');

    if (modal) modal.style.display = 'none';

    SafeHer.router.go('home');

  }



  // ─── Overdue Monitoring & "Are you OK?" Check ──────────────

  function startMonitoring() {

    if (monitorInterval) clearInterval(monitorInterval);

    monitorInterval = setInterval(checkRideStatus, 1000);

    checkRideStatus();

  }



  function checkRideStatus() {

    if (!activeRide || activeRide.status !== 'active') return;



    var now = Date.now();

    var diffMs = activeRide.expectedArrival - now;



    // Update countdown in active screen

    var countdownEl = document.getElementById('ride-active-countdown');

    if (countdownEl) {

      if (diffMs > 0) {

        var mins = Math.floor(diffMs / 60000);

        var secs = Math.floor((diffMs % 60000) / 1000);

        countdownEl.textContent = 'Arriving in ' + mins + 'm ' + (secs < 10 ? '0' : '') + secs + 's';

        countdownEl.style.color = 'var(--crimson)';

      } else {

        var overMins = Math.floor(Math.abs(diffMs) / 60000);

        var overSecs = Math.floor((Math.abs(diffMs) % 60000) / 1000);

        countdownEl.textContent = 'Overdue by ' + overMins + 'm ' + (overSecs < 10 ? '0' : '') + overSecs + 's';

        countdownEl.style.color = '#DC2626';

      }

    }



    // Update home banner

    updateHomeBannerCountdown(diffMs);



    // Overdue check: 10 minutes past expected arrival

    var tenMinutesMs = 10 * 60 * 1000;

    if (diffMs < -tenMinutesMs && !activeRide.areYouOkShown) {

      activeRide.areYouOkShown = true;

      try {

        localStorage.setItem('safeher_active_ride', JSON.stringify(activeRide));

      } catch (e) {}

      triggerAreYouOkCheck();

    }

  }



  function triggerAreYouOkCheck() {

    if (SafeHer.router && SafeHer.router.go) {

      SafeHer.router.go('ride-check');

    }



    checkCountdownRemaining = 60;

    var timerEl = document.getElementById('ride-check-countdown-num');

    if (timerEl) timerEl.textContent = checkCountdownRemaining;



    // Play vibration if supported

    if (navigator.vibrate) {

      navigator.vibrate([400, 200, 400, 200, 800]);

    }



    if (checkCountdownTimer) clearInterval(checkCountdownTimer);

    checkCountdownTimer = setInterval(function() {

      checkCountdownRemaining--;

      if (timerEl) timerEl.textContent = checkCountdownRemaining;



      if (checkCountdownRemaining <= 0) {

        clearInterval(checkCountdownTimer);

        // Auto-escalate to normal SOS countdown

        if (SafeHer.toast) SafeHer.toast('No reply: Auto-triggering SOS countdown!');

        if (SafeHer.sos && SafeHer.sos.startEmergencyMode) {

          SafeHer.sos.startEmergencyMode();

        } else if (SafeHer.sos && SafeHer.sos.startCountdown) {

          SafeHer.sos.startCountdown();

        }

      }

    }, 1000);

  }



  function userIsOk() {

    if (checkCountdownTimer) clearInterval(checkCountdownTimer);

    if (!activeRide) {

      SafeHer.router.go('home');

      return;

    }



    // Ask user: Extend ride by 15 mins or End Ride

    var choice = window.confirm('Glad you are safe! Would you like to extend your expected arrival by 15 minutes?\n\nClick OK to add 15 minutes, or Cancel to End Ride now.');

    if (choice) {

      activeRide.expectedArrival = Date.now() + (15 * 60 * 1000);

      activeRide.areYouOkShown = false;

      try {

        localStorage.setItem('safeher_active_ride', JSON.stringify(activeRide));

      } catch (e) {}

      if (SafeHer.toast) SafeHer.toast('Ride arrival extended by 15 minutes');

      SafeHer.router.go('ride');

    } else {

      endRide();

    }

  }



  function userNeedsHelp() {

    if (checkCountdownTimer) clearInterval(checkCountdownTimer);

    if (SafeHer.toast) SafeHer.toast('Emergency SOS triggered from Ride Safety!');

    if (SafeHer.sos && SafeHer.sos.startEmergencyMode) {

      SafeHer.sos.startEmergencyMode();

    } else if (SafeHer.sos && SafeHer.sos.startCountdown) {

      SafeHer.sos.startCountdown();

    }

  }



  // ─── Home Screen Banner ───────────────────────────────────

  function updateHomeBanner() {

    var banner = document.getElementById('ride-active-home-banner');

    if (!banner) return;



    if (!activeRide || activeRide.status !== 'active') {

      banner.style.display = 'none';

      return;

    }



    banner.style.display = 'block';

    var numEl = document.getElementById('ride-banner-veh-num');

    if (numEl) numEl.textContent = activeRide.vehicleNumber + ' (' + activeRide.vehicleType + ')';



    var destEl = document.getElementById('ride-banner-dest');

    if (destEl) destEl.textContent = 'To: ' + activeRide.destination;

  }



  function updateHomeBannerCountdown(diffMs) {

    var timeEl = document.getElementById('ride-banner-time');

    if (!timeEl) return;

    if (diffMs > 0) {

      var mins = Math.floor(diffMs / 60000);

      var secs = Math.floor((diffMs % 60000) / 1000);

      timeEl.textContent = 'Arriving in ' + mins + 'm ' + (secs < 10 ? '0' : '') + secs + 's';

      timeEl.style.color = 'var(--crimson)';

    } else {

      var overMins = Math.floor(Math.abs(diffMs) / 60000);

      timeEl.textContent = 'Overdue by ' + overMins + 'm';

      timeEl.style.color = '#DC2626';

    }

  }



  // ─── Ride History Storage ─────────────────────────────────

  function saveToHistory(record) {

    try {

      var history = getHistory();

      history.unshift(record);

      // Keep up to 30 past rides

      if (history.length > 30) history = history.slice(0, 30);

      localStorage.setItem('safeher_ride_history', JSON.stringify(history));

    } catch (e) {

      console.warn('[Ride] History save failed:', e);

    }

  }



  function getHistory() {

    try {

      var raw = localStorage.getItem('safeher_ride_history');

      return raw ? JSON.parse(raw) : [];

    } catch (e) {

      return [];

    }

  }



  function clearHistory() {

    try {

      localStorage.removeItem('safeher_ride_history');

      renderHistory('ride-history-list');

      if (SafeHer.toast) SafeHer.toast('Ride history cleared');

    } catch (e) {}

  }



  function renderHistory(containerId) {

    var container = document.getElementById(containerId);

    if (!container) return;



    var history = getHistory();

    if (history.length === 0) {

      container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-gray);font-size:13px;border:1px dashed var(--border);border-radius:var(--radius-tile);background:#ffffff;">No ride history recorded yet.</div>';

      return;

    }



    var html = '';

    history.forEach(function(r) {

      var startStr = new Date(r.startTime).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +

                     new Date(r.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      var durationMins = r.endTime ? Math.round((r.endTime - r.startTime) / 60000) : null;



      html += '<div class="ride-history-item">' +

        '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px;">' +

          '<div style="display:flex;align-items:center;gap:6px;">' +

            '<span class="material-symbols-rounded" style="color:var(--crimson);font-size:18px;">local_taxi</span>' +

            '<strong style="font-size:14px;color:var(--text-dark);">' + escapeHtml(r.vehicleNumber) + '</strong>' +

            '<span style="font-size:11px;color:var(--text-gray);">' + escapeHtml(r.vehicleType) + ' (' + escapeHtml(r.appUsed) + ')</span>' +

          '</div>' +

          '<span class="ride-status-badge reached">Reached safely</span>' +

        '</div>' +

        '<div style="font-size:12px;color:var(--text-gray);">' +

          '<div>' + escapeHtml(r.pickup) + ' &rarr; ' + escapeHtml(r.destination) + '</div>' +

          '<div style="margin-top:2px;font-size:11px;color:#9CA3AF;">' + startStr + (durationMins ? (' &bull; ' + durationMins + ' mins') : '') + '</div>' +

        '</div>' +

      '</div>';

    });



    container.innerHTML = html;

  }



  // ─── Setup Screen Reset ───────────────────────────────────

  function renderSetupView() {

    var setupView = document.getElementById('ride-setup-view');

    var activeView = document.getElementById('ride-active-view');

    if (setupView) setupView.style.display = 'block';

    if (activeView) activeView.style.display = 'none';



    renderContactSelection();

  }



  // ─── Chip Click Handlers ──────────────────────────────────

  function selectVehicleType(chipEl) {

    var chips = document.querySelectorAll('.ride-vtype-chip');

    chips.forEach(function(c) { c.classList.remove('active'); });

    chipEl.classList.add('active');

  }



  function selectApp(chipEl) {

    var chips = document.querySelectorAll('.ride-app-chip');

    chips.forEach(function(c) { c.classList.remove('active'); });

    chipEl.classList.add('active');

  }



  // ─── Initialization ───────────────────────────────────────

  function init() {

    // Restore active ride from localStorage

    try {

      var stored = localStorage.getItem('safeher_active_ride');

      if (stored) {

        activeRide = JSON.parse(stored);

      }

    } catch (e) {

      activeRide = null;

    }



    if (activeRide && activeRide.status === 'active') {

      renderActiveRideView();

      updateHomeBanner();

      startMonitoring();

    } else {

      updateHomeBanner();

    }



    // Router hooks

    if (SafeHer.router && SafeHer.router.onShow) {

      SafeHer.router.onShow('ride', function() {

        if (activeRide && activeRide.status === 'active') {

          renderActiveRideView();

        } else {

          renderSetupView();

        }

      });



      SafeHer.router.onShow('home', function() {

        updateHomeBanner();

      });



      SafeHer.router.onShow('profile', function() {

        renderHistory('ride-history-list');

      });

    }



    initDB();



    // Pre-render contact selection so DOM is never blank

    if (document.getElementById('ride-contacts-list')) {

      renderContactSelection();

    }

  }



  return {

    init: init,

    startRide: startRide,

    endRide: endRide,

    handlePhotoUpload: handlePhotoUpload,

    removePhoto: removePhoto,

    shareViaWebShare: shareViaWebShare,

    userIsOk: userIsOk,

    userNeedsHelp: userNeedsHelp,

    selectVehicleType: selectVehicleType,

    selectApp: selectApp,

    renderContactSelection: renderContactSelection,

    saveQuickContact: saveQuickContact,

    addPresetContact: addPresetContact,

    toggleAllContactsSelection: toggleAllContactsSelection,

    renderHistory: renderHistory,

    clearHistory: clearHistory,

    closeReachedSafelyModal: closeReachedSafelyModal

  };

})();



// Auto-initialize when DOM is ready

if (document.readyState === 'loading') {

  document.addEventListener('DOMContentLoaded', function() {

    SafeHer.ride.init();

  });

} else {

  SafeHer.ride.init();

}

