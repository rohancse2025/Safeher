// js/profile.js – User profile, editing, notification toggles, alert history, and data management

SafeHer.profile = (function() {
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setErr(id, msg) {
    var el = document.getElementById(id);
    if (el) el.textContent = msg;
  }

  function clearErrs() {
    setErr('err-profile-name', '');
    setErr('err-profile-phone', '');
  }

  // ─── Render Profile Screen ────────────────────────────────
  function render() {
    renderUserCard();
    renderNotifications();
    renderAlertHistory();
    updateBackendBadge();
  }

  function renderUserCard() {
    var user = SafeHer.api.getUser();
    var nameEl = document.getElementById('profile-name');
    var phoneEl = document.getElementById('profile-phone');
    var avatarEl = document.getElementById('profile-avatar-letter');

    var name = user && user.name ? user.name : 'SafeHer User';
    var phone = user && user.phone ? user.phone : 'Not set';
    var initial = name.charAt(0).toUpperCase();

    if (nameEl) nameEl.textContent = name;
    if (phoneEl) phoneEl.textContent = phone.length === 10 ? '+91 ' + phone : phone;
    if (avatarEl) avatarEl.textContent = initial;
  }

  function urlB64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);

    for (var i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function renderNotifications() {
    var settings = SafeHer.api.getNotificationSettings();
    var smsToggle = document.getElementById('notif-sms');
    var soundToggle = document.getElementById('notif-sound');
    var locToggle = document.getElementById('notif-location');
    var pushToggle = document.getElementById('notif-push');

    if (smsToggle) smsToggle.checked = !!settings.smsAlerts;
    if (soundToggle) soundToggle.checked = !!settings.soundAlarm;
    if (locToggle) locToggle.checked = !!settings.liveLocation;

    if (pushToggle) {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        pushToggle.checked = false;
        pushToggle.disabled = true;
      } else if (Notification.permission === 'denied') {
        pushToggle.checked = false;
      } else {
        navigator.serviceWorker.ready.then(function(reg) {
          reg.pushManager.getSubscription().then(function(sub) {
            pushToggle.checked = !!sub && Notification.permission === 'granted';
          }).catch(function() {
            pushToggle.checked = false;
          });
        }).catch(function() {
          pushToggle.checked = false;
        });
      }
    }
  }

  function togglePushNotifications(enable) {
    var pushToggle = document.getElementById('notif-push');

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      SafeHer.toast('Web Push is not supported in this browser');
      if (pushToggle) pushToggle.checked = false;
      return;
    }

    if (enable) {
      Notification.requestPermission().then(function(permission) {
        if (permission !== 'granted') {
          SafeHer.toast('Notification permission was not granted');
          if (pushToggle) pushToggle.checked = false;
          return;
        }

        navigator.serviceWorker.ready.then(function(reg) {
          SafeHer.api.getVapidPublicKey(function(err, vapidKey) {
            if (err || !vapidKey) {
              SafeHer.toast('Could not fetch server push key');
              if (pushToggle) pushToggle.checked = false;
              return;
            }

            var applicationServerKey;
            try {
              applicationServerKey = urlB64ToUint8Array(vapidKey);
            } catch (convErr) {
              SafeHer.toast('Key conversion error');
              if (pushToggle) pushToggle.checked = false;
              return;
            }

            reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: applicationServerKey
            }).then(function(subscription) {
              var p256dh = '';
              var auth = '';
              try {
                var rawKey = subscription.getKey('p256dh');
                var rawAuth = subscription.getKey('auth');
                if (rawKey) p256dh = btoa(String.fromCharCode.apply(null, new Uint8Array(rawKey)));
                if (rawAuth) auth = btoa(String.fromCharCode.apply(null, new Uint8Array(rawAuth)));
              } catch (keyErr) {}

              SafeHer.api.subscribePush({
                endpoint: subscription.endpoint,
                keys: { p256dh: p256dh, auth: auth }
              }, function(apiErr) {
                if (!apiErr) {
                  SafeHer.toast('Push notifications enabled');
                } else {
                  SafeHer.toast('Push enabled locally, server sync failed');
                }
              });
            }).catch(function(subErr) {
              SafeHer.toast('Subscription failed: ' + subErr.message);
              if (pushToggle) pushToggle.checked = false;
            });
          });
        }).catch(function(swErr) {
          SafeHer.toast('Service worker not ready: ' + swErr.message);
          if (pushToggle) pushToggle.checked = false;
        });
      });
    } else {
      navigator.serviceWorker.ready.then(function(reg) {
        reg.pushManager.getSubscription().then(function(subscription) {
          if (subscription) {
            var endpoint = subscription.endpoint;
            subscription.unsubscribe().then(function() {
              SafeHer.api.unsubscribePush(endpoint, function() {});
              SafeHer.toast('Push notifications disabled');
            }).catch(function(unsubErr) {
              SafeHer.toast('Unsubscribe error: ' + unsubErr.message);
            });
          } else {
            SafeHer.toast('Push notifications disabled');
          }
        }).catch(function() {
          SafeHer.toast('Push notifications disabled');
        });
      });
    }
  }

  function saveNotifications() {
    var sms = document.getElementById('notif-sms').checked;
    var sound = document.getElementById('notif-sound').checked;
    var loc = document.getElementById('notif-location').checked;

    SafeHer.api.setNotificationSettings({
      smsAlerts: sms,
      soundAlarm: sound,
      liveLocation: loc
    });
    SafeHer.toast('Preferences saved');
  }

  // ─── Alert History ────────────────────────────────────────
  function renderAlertHistory(containerId) {
    var targetIds = containerId ? [containerId] : ['profile-alert-history', 'history-screen-list'];
    var elements = [];
    for (var t = 0; t < targetIds.length; t++) {
      var el = document.getElementById(targetIds[t]);
      if (el) elements.push(el);
    }
    if (elements.length === 0) return;

    function buildAlertsHtml(alerts) {
      if (!alerts || alerts.length === 0) {
        return '<div class="alert-empty-card">' +
          '<span class="material-symbols-rounded alert-empty-icon">history</span>' +
          '<p class="alert-empty-title">No alerts triggered yet</p>' +
          '<p class="alert-empty-sub">Your emergency SOS alerts and mode history will appear here.</p>' +
        '</div>';
      }

      var html = '';
      for (var i = 0; i < alerts.length; i++) {
        var a = alerts[i];
        var modeLabel = a.mode === 'emergency' ? 'Emergency' : (a.mode === 'silent' ? 'Silent' : (a.mode === 'timer' ? 'Timer' : (a.mode === 'share_location' ? 'Location' : (a.mode === 'escort' ? 'Escort' : 'Normal'))));
        var modeClass = (a.mode === 'emergency' || a.mode === 'escort') ? 'alert-mode-emergency' : (a.mode === 'silent' ? 'alert-mode-silent' : 'alert-mode-normal');
        var statusLabel = a.status === 'active' ? 'Active' : 'Resolved';
        var statusClass = a.status === 'active' ? 'alert-status-active' : 'alert-status-resolved';

        var dateStr = a.timestamp ? new Date(a.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        var timeStr = a.time || '';

        var mapsLink = (a.lat && a.lng)
          ? '<a href="https://www.google.com/maps?q=' + encodeURIComponent(a.lat) + ',' + encodeURIComponent(a.lng) + '" target="_blank" rel="noopener noreferrer" class="alert-item-link"><span class="material-symbols-rounded">map</span>Map</a>'
          : '';

        var endedStr = a.endTime ? '<span class="alert-item-ended">Ended ' + escapeHtml(a.endTime) + '</span>' : '';

        var alertId = a.id || a.timestamp;
        html += '<div class="alert-history-item" onclick="SafeHer.profile.openAlertDetails(' + alertId + ')" style="cursor: pointer;" title="View alert details">' +
          '<div class="alert-item-top">' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
              '<span class="alert-mode-badge ' + modeClass + '">' + escapeHtml(modeLabel) + '</span>' +
              '<span class="alert-item-time">' + escapeHtml(timeStr) + (dateStr ? ' · ' + escapeHtml(dateStr) : '') + '</span>' +
            '</div>' +
            '<span class="alert-status-badge ' + statusClass + '">' + escapeHtml(statusLabel) + '</span>' +
          '</div>' +
          '<div class="alert-item-bottom">' +
            endedStr +
            mapsLink +
            '<span style="font-size: 11px; color: var(--crimson); font-weight: 600; margin-left: auto;">Details →</span>' +
          '</div>' +
        '</div>';
      }
      return html;
    }

    function updateAll(html) {
      for (var e = 0; e < elements.length; e++) {
        elements[e].innerHTML = html;
      }
    }

    updateAll(buildAlertsHtml(SafeHer.api.getAlerts()));
    if (SafeHer.api && SafeHer.api.getAlerts) {
      SafeHer.api.getAlerts(function(err, serverAlerts) {
        if (!err && serverAlerts) {
          updateAll(buildAlertsHtml(serverAlerts));
        }
      });
    }
  }

  // ─── Edit Profile Modal ───────────────────────────────────
  function openEditModal() {
    clearErrs();
    var user = SafeHer.api.getUser();
    var nameInput = document.getElementById('profile-edit-name');
    var phoneInput = document.getElementById('profile-edit-phone');
    var modal = document.getElementById('profile-edit-modal');

    if (nameInput) nameInput.value = user && user.name ? user.name : '';
    if (phoneInput) phoneInput.value = user && user.phone ? user.phone : '';
    if (modal) modal.style.display = 'flex';
  }

  function closeEditModal() {
    var modal = document.getElementById('profile-edit-modal');
    if (modal) modal.style.display = 'none';
  }

  function submitEditForm() {
    var name = document.getElementById('profile-edit-name').value.trim();
    var phone = document.getElementById('profile-edit-phone').value.trim();

    clearErrs();
    var ok = true;

    if (!name) {
      setErr('err-profile-name', 'Name is required');
      ok = false;
    }

    if (!phone) {
      setErr('err-profile-phone', 'Phone is required');
      ok = false;
    } else if (!/^\d{10}$/.test(phone)) {
      setErr('err-profile-phone', 'Enter a valid 10-digit number');
      ok = false;
    }

    if (!ok) return;

    SafeHer.api.updateUser({ name: name, phone: phone });
    SafeHer.toast('Profile updated');
    closeEditModal();
    renderUserCard();

    // Update greeting on Home screen if home object exists
    var homeNameEl = document.getElementById('home-name');
    if (homeNameEl) {
      homeNameEl.textContent = name.split(' ')[0];
    }
  }

  // ─── Alert Details Screen ─────────────────────────────────
  var detailsMapInstance = null;
  var detailsSourceScreen = 'profile';

  function backFromDetails() {
    SafeHer.router.go(detailsSourceScreen === 'history' ? 'history' : 'profile');
  }

  function openAlertDetails(alertId) {
    if (!SafeHer.api || !SafeHer.api.getAlertDetails) return;
    detailsSourceScreen = SafeHer.router.getCurrent() || 'profile';

    SafeHer.api.getAlertDetails(alertId, function(err, data) {
      if (err || !data) {
        SafeHer.toast('Could not load alert details');
        return;
      }

      SafeHer.router.go('alert-details');

      var badgeEl = document.getElementById('detail-alert-badge');
      var idEl = document.getElementById('detail-alert-id');
      var statusEl = document.getElementById('detail-alert-status');
      var startedEl = document.getElementById('detail-alert-started');
      var endedEl = document.getElementById('detail-alert-ended');
      var durationEl = document.getElementById('detail-alert-duration');
      var contactsEl = document.getElementById('detail-alert-contacts');
      var volListEl = document.getElementById('detail-volunteers-list');

      var modeMap = {
        'normal': 'Normal SOS',
        'silent': 'Silent SOS',
        'emergency': 'Emergency Alarm',
        'timer': 'Safe Timer SOS'
      };

      if (badgeEl) {
        badgeEl.textContent = modeMap[data.mode] || 'Emergency SOS';
        badgeEl.className = 'alert-mode-badge ' + (data.mode === 'emergency' ? 'alert-mode-emergency' : (data.mode === 'silent' ? 'alert-mode-silent' : 'alert-mode-normal'));
      }
      if (idEl) idEl.textContent = '#' + (data.id || alertId);
      if (statusEl) {
        var isResolved = data.status !== 'active';
        statusEl.textContent = isResolved ? 'Resolved' : 'Active';
        statusEl.className = 'alert-status-badge ' + (isResolved ? 'alert-status-resolved' : 'alert-status-active');
      }

      var startStr = data.started_at ? String(data.started_at).replace('T', ' ').slice(0, 19) : 'N/A';
      var endStr = data.ended_at ? String(data.ended_at).replace('T', ' ').slice(0, 19) : (data.status === 'active' ? 'Still Active' : 'Resolved');
      if (startedEl) startedEl.textContent = startStr;
      if (endedEl) endedEl.textContent = endStr;
      if (durationEl) durationEl.textContent = data.duration || 'N/A';
      if (contactsEl) contactsEl.textContent = (data.contacts_notified !== undefined ? data.contacts_notified : 0) + ' contacts notified';

      // Volunteers list
      if (volListEl) {
        var vols = data.volunteers_responded || [];
        if (vols.length === 0) {
          volListEl.innerHTML = '<p style="font-size: 12px; color: var(--text-gray); margin: 0;">No community volunteers responded to this alert.</p>';
        } else {
          var volHtml = '';
          for (var i = 0; i < vols.length; i++) {
            var v = vols[i];
            var isComing = v.status === 'coming';
            volHtml += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-color);font-size:12px;">' +
              '<div>' +
                '<strong>' + escapeHtml(v.name || 'Volunteer') + '</strong>' +
                '<span style="font-size:11px;color:var(--text-gray);display:block;">' + escapeHtml(v.time ? String(v.time).slice(0, 19) : '') + '</span>' +
              '</div>' +
              '<span style="font-weight:600;color:' + (isComing ? 'var(--crimson)' : 'var(--text-gray)') + ';">' +
                (isComing ? "I'm coming" : "Cannot help") +
              '</span>' +
            '</div>';
          }
          volListEl.innerHTML = volHtml;
        }
      }

      // Incident Timeline
      var timelineListEl = document.getElementById('detail-timeline-list');
      if (timelineListEl) {
        var events = data.timeline || [];
        if (events.length === 0) {
          timelineListEl.innerHTML = '<p style="font-size: 12px; color: var(--text-gray); margin: 0;">No timeline events recorded.</p>';
        } else {
          var tHtml = '';
          for (var t = 0; t < events.length; t++) {
            var ev = events[t];
            var timeStr = ev.time ? String(ev.time).slice(11, 19) : '';
            var detailsText = ev.details || (ev.actor_label + ' responded');
            tHtml += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-color);font-size:12px;">' +
              '<div style="display:flex;align-items:center;gap:8px;">' +
                '<span class="material-symbols-rounded" style="color:var(--crimson);font-size:16px;">timeline</span>' +
                '<span style="color:var(--text-dark);font-weight:600;">' + escapeHtml(detailsText) + '</span>' +
              '</div>' +
              '<span style="font-size:11px;color:var(--text-gray);">' + escapeHtml(timeStr) + '</span>' +
            '</div>';
          }
          timelineListEl.innerHTML = tHtml;
        }
      }

      // Render Leaflet route map
      setTimeout(function() {
        renderAlertDetailsMap(data);
      }, 150);
    });
  }

  function renderAlertDetailsMap(data) {
    var mapEl = document.getElementById('alert-details-map');
    if (!mapEl || typeof L === 'undefined') return;

    if (detailsMapInstance) {
      detailsMapInstance.remove();
      detailsMapInstance = null;
    }

    var route = data.route || [];
    var fallbackLat = parseFloat(data.lat) || 12.9716;
    var fallbackLng = parseFloat(data.lng) || 77.5946;

    var centerLat = route.length > 0 ? route[0].lat : fallbackLat;
    var centerLng = route.length > 0 ? route[0].lng : fallbackLng;

    detailsMapInstance = L.map('alert-details-map', {
      center: [centerLat, centerLng],
      zoom: 15,
      zoomControl: false,
      attributionControl: false,
        maxZoom: 18
    });

    L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
      maxZoom: 18,
      maxNativeZoom: 18,
        errorTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      subdomains: ['0', '1', '2', '3']
    }).addTo(detailsMapInstance);

    if (route.length > 1) {
      var latlngs = route.map(function(p) { return [p.lat, p.lng]; });
      var polyline = L.polyline(latlngs, {
        color: '#A80F3C',
        weight: 4,
        opacity: 0.85,
        lineJoin: 'round'
      }).addTo(detailsMapInstance);

      // Start Marker
      var startIcon = L.divIcon({
        className: 'custom-map-icon',
        html: '<div style="background:#2E7D32;color:#FFF;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap;border:1px solid #FFF;">START</div>',
        iconSize: [42, 20],
        iconAnchor: [21, 10]
      });
      L.marker([route[0].lat, route[0].lng], { icon: startIcon }).addTo(detailsMapInstance);

      // End Marker
      var lastIdx = route.length - 1;
      var endIcon = L.divIcon({
        className: 'custom-map-icon',
        html: '<div style="background:#A80F3C;color:#FFF;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap;border:1px solid #FFF;">END</div>',
        iconSize: [36, 20],
        iconAnchor: [18, 10]
      });
      L.marker([route[lastIdx].lat, route[lastIdx].lng], { icon: endIcon }).addTo(detailsMapInstance);

      detailsMapInstance.fitBounds(polyline.getBounds(), { padding: [30, 30] });
    } else {
      L.marker([centerLat, centerLng]).addTo(detailsMapInstance);
      detailsMapInstance.setView([centerLat, centerLng], 15);
    }

    setTimeout(function() {
      if (detailsMapInstance) detailsMapInstance.invalidateSize();
    }, 300);
  }

  // ─── Delete Account & Data ─────────────────────────────────
  function deleteAccountAndData() {
    if (!confirm('Are you sure you want to permanently delete your account and all associated data? This will remove your contacts, alerts, locations, volunteer profile, and timers.')) {
      return;
    }

    SafeHer.askPin(function(enteredPin) {
      SafeHer.api.deleteAccount(enteredPin, function(err) {
        if (err) {
          SafeHer.toast(err);
          return;
        }
        SafeHer.api.clearAllData();
        SafeHer.toast('Account and all data deleted');
        SafeHer.router.go('auth');
      });
    });
  }

  // ─── Clear All Data ───────────────────────────────────────
  function confirmClearAllData() {
    if (confirm('Clear all data? This will reset your profile, contacts, safety PIN, and alert history.')) {
      SafeHer.api.clearAllData();
      SafeHer.toast('All data cleared');
      SafeHer.router.go('auth');
    }
  }

  function updateBackendBadge() {
    var badge = document.getElementById('backend-status-badge');
    if (!badge) return;
    var base = (window.SafeHerConfig && window.SafeHerConfig.API_BASE) || 'http://localhost:5000';
    fetch(base.replace(/\/+$/, '') + '/api/health', { method: 'GET' })
      .then(function(res) {
        if (res.ok) {
          badge.textContent = 'Connected (' + base.replace(/^https?:\/\//, '') + ')';
          badge.style.background = '#e8f5e9';
          badge.style.color = '#2e7d32';
        } else {
          badge.textContent = 'Server Error';
          badge.style.background = '#ffebee';
          badge.style.color = '#c62828';
        }
      })
      .catch(function() {
        badge.textContent = 'Offline (Tap to set IP)';
        badge.style.background = '#fff3e0';
        badge.style.color = '#e65100';
        badge.style.cursor = 'pointer';
        badge.onclick = changeServerUrl;
      });
  }

  function changeServerUrl() {
    var current = (window.SafeHerConfig && window.SafeHerConfig.API_BASE) || 'http://localhost:5000';
    var cloudUrl = (window.SafeHerConfig && window.SafeHerConfig.CLOUD_BACKEND_URL) || '';
    var promptMsg = 'Backend Server URL Configuration:\n\n' +
      '• To run 24/7 WITHOUT laptop: enter your Cloud Server URL (e.g. https://safeher-backend.onrender.com)\n' +
      '• To run locally on laptop: enter http://localhost:5000 or http://192.168.x.x:5000\n' +
      '• Enter "reset" to restore default:';
    var newUrl = window.prompt(promptMsg, current);
    if (newUrl !== null) {
      var trimmed = newUrl.trim().replace(/\/+$/, '');
      if (!trimmed || trimmed.toLowerCase() === 'reset') {
        try { localStorage.removeItem('safeher_api_base'); } catch (e) {}
        var defaultVal = cloudUrl || 'http://localhost:5000';
        if (window.SafeHerConfig) window.SafeHerConfig.API_BASE = defaultVal;
        if (window.SafeHer && window.SafeHer.config) window.SafeHer.config.API_BASE = defaultVal;
        SafeHer.toast('Server URL reset to ' + defaultVal);
      } else {
        try { localStorage.setItem('safeher_api_base', trimmed); } catch (e) {}
        if (window.SafeHerConfig) window.SafeHerConfig.API_BASE = trimmed;
        if (window.SafeHer && window.SafeHer.config) window.SafeHer.config.API_BASE = trimmed;
        SafeHer.toast('Server URL updated! Connecting...');
      }
      updateBackendBadge();
      setTimeout(function() { window.location.reload(); }, 1000);
      return;
    }
  }

  function copyQuickTriggerUrl() {
    var user = SafeHer.api.getUser() || {};
    var base = (window.SafeHerConfig && window.SafeHerConfig.API_BASE) || window.location.origin;
    var url = base.replace(/\/+$/, '') + '/api/alerts/quick?user_id=' + (user.id || 10000);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function() {
        SafeHer.toast('1-Tap Quick SOS URL copied to clipboard!');
      }).catch(function() {
        window.prompt('Copy your 1-Tap Quick SOS URL:', url);
      });
    } else {
      window.prompt('Copy your 1-Tap Quick SOS URL:', url);
    }
  }

  function testBackgroundAlert() {
    var user = SafeHer.api.getUser() || {};
    SafeHer.toast('Sending automated background alert...');
    var base = (window.SafeHerConfig && window.SafeHerConfig.API_BASE) || 'http://localhost:5000';
    fetch(base.replace(/\/+$/, '') + '/api/alerts/quick?user_id=' + (user.id || 10000), { method: 'POST' })
      .then(function(res) { return res.json(); })
      .then(function(json) {
        if (json.ok) {
          SafeHer.toast('Email & WhatsApp alerts dispatched successfully!');
        } else {
          SafeHer.toast('Test failed: ' + (json.error || 'Server error'));
        }
      })
      .catch(function(err) {
        SafeHer.toast('Server unreachable: ' + err.message);
      });
  }

  function init() {
    SafeHer.router.onShow('profile', function() {
      render();
    });
    SafeHer.router.onShow('history', function() {
      renderAlertHistory('history-screen-list');
    });
    SafeHer.router.onShow('alert-details', function() {
      if (detailsMapInstance) {
        detailsMapInstance.invalidateSize();
        setTimeout(function() {
          if (detailsMapInstance) detailsMapInstance.invalidateSize();
        }, 300);
      }
    });
  }

  return {
    init: init,
    render: render,
    renderAlertHistory: renderAlertHistory,
    openEditModal: openEditModal,
    closeEditModal: closeEditModal,
    submitEditForm: submitEditForm,
    saveNotifications: saveNotifications,
    togglePushNotifications: togglePushNotifications,
    openAlertDetails: openAlertDetails,
    backFromDetails: backFromDetails,
    deleteAccountAndData: deleteAccountAndData,
    confirmClearAllData: confirmClearAllData,
    updateBackendBadge: updateBackendBadge,
    changeServerUrl: changeServerUrl,
    copyQuickTriggerUrl: copyQuickTriggerUrl,
    testBackgroundAlert: testBackgroundAlert
  };
})();
