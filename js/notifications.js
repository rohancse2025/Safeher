// js/notifications.js – WhatsApp Alerts & Emergency Dispatch Controller
SafeHer.notifications = (function() {
  var refreshTimer = null;
  var isScreenActive = false;

  var EVENT_LABELS = {
    "alert_created": "Emergency SOS Alert",
    "alert_uneasy": "Uneasy Check-in",
    "alert_escalated": "SOS Alert Escalation",
    "alert_ended": "Alert Ended / Marked Safe",
    "volunteer_coming": "Volunteer Responding",
    "escort_started": "Escort Journey Started",
    "escort_arrived": "Escort Arrived Safely",
    "escort_off_route": "Escort Route Deviation",
    "escort_missed_checkin": "Escort Missed Check-in",
    "escort_no_signal": "Escort Signal Lost",
    "escort_late_arrival": "Escort Overdue Arrival",
    "escort_ended": "Escort Ended",
    "timer_expired": "Safe Timer Expired",
    "share_started": "Live Location Share Started",
    "share_ended": "Live Location Share Ended",
    "ride_started": "Ride Safety Started",
    "ride_ended": "Ride Arrived Safely",
    "ride_late": "Ride Overdue Alert",
    "contact_added": "Contact Added Confirmation",
    "alert_reminders": "Send WhatsApp reminders (at 3m & 10m)",
    "alert_reminder": "Alert Reminder",
    // Aliases
    "sos": "Emergency SOS Alert",
    "sos_safe": "Alert Ended / Marked Safe",
    "escort_start": "Escort Journey Started",
    "escort_safe": "Escort Arrived Safely",
    "escort_alert": "Escort Safety Alert",
    "share_start": "Live Location Share Started",
    "share_stop": "Live Location Share Ended",
    "timer_start": "Safety Timer Started",
    "timer_safe": "Safety Timer Disarmed",
    "ride_start": "Ride Safety Started",
    "ride_safe": "Ride Arrived Safely",
    "welcome": "Contact Added Confirmation"
  };

  var SOS_EVENTS = {
    "alert_created": true,
    "alert_uneasy": true,
    "alert_escalated": true,
    "alert_ended": true,
    "volunteer_coming": true,
    "escort_off_route": true,
    "escort_missed_checkin": true,
    "escort_no_signal": true,
    "escort_late_arrival": true,
    "timer_expired": true,
    "ride_late": true,
    "sos": true,
    "sos_safe": true,
    "escort_alert": true
  };

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getBaseUrl() {
    return (window.SafeHer && SafeHer.api && SafeHer.api.BASE_URL) || 'https://safeher-dwkj.onrender.com';
  }

  function getAuthHeaders() {
    var token = (SafeHer.api && SafeHer.api.getToken) ? SafeHer.api.getToken() : null;
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
  }

  // ── 1. Top Notices (WhatsApp Focused, No Red Email Errors) ────
  function loadTopNotices() {
    var container = document.getElementById('notif-top-notices');
    if (!container) return;

    var html = '<div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:12px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;gap:12px;box-shadow:0 1px 3px rgba(34,197,94,0.08);">' +
      '<div style="width:36px;height:36px;border-radius:50%;background:#DCFCE7;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
        '<span class="material-symbols-rounded" style="color:#16A34A;font-size:22px;">chat</span>' +
      '</div>' +
      '<div style="font-size:12px;color:#166534;line-height:1.4;">' +
        '<strong>100% WhatsApp Emergency Dispatch:</strong> Emergency SOS alerts, live GPS tracking links, and safety check-ins are sent directly to your contacts via WhatsApp.' +
      '</div>' +
    '</div>';

    container.innerHTML = html;
  }

  // ── 2. Contact WhatsApp Status List ──────────────────────────
  function loadContactsStatus() {
    var container = document.getElementById('notif-contacts-status-list');
    if (!container) return;

    var base = getBaseUrl();
    var headers = getAuthHeaders();

    fetch(base + '/api/contacts', { headers: headers })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        var contacts = (res && res.data) || [];
        if (!contacts || contacts.length === 0) {
          container.innerHTML = '<div style="font-size:12px;color:#6B7280;padding:10px 0;text-align:center;">' +
            'No emergency contacts saved yet. Tap "+ Add Contact" above to add your first trusted contact with a mobile number.' +
          '</div>';
          return;
        }

        var html = '<div style="display:flex;flex-direction:column;gap:10px;">';
        for (var i = 0; i < contacts.length; i++) {
          var c = contacts[i];
          var name = c.name || 'Contact';
          var phone = (c.phone || '').trim();
          var initial = (name.charAt(0) || '?').toUpperCase();
          var cleanPhone = phone.replace(/\D/g, '');
          var waPhone = cleanPhone.length === 10 ? ('91' + cleanPhone) : cleanPhone;
          var testMsg = encodeURIComponent('SafeHer Emergency Alert Test: ' + name + ', you are set up as an emergency contact on SafeHer.');
          var testUrl = waPhone ? ('https://wa.me/' + waPhone + '?text=' + testMsg) : '#';

          html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #F3F4F6;">';
          html += '<div style="display:flex;align-items:center;gap:10px;min-width:0;">';
          html += '<div style="width:32px;height:32px;border-radius:50%;background:#FFF0F3;color:var(--crimson);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
            escapeHtml(initial) +
          '</div>';
          html += '<div style="min-width:0;">';
          html += '<div style="font-size:13px;font-weight:600;color:#1F2937;">' + escapeHtml(name) + '</div>';
          html += '<div style="font-size:11px;color:#6B7280;">' + (phone ? escapeHtml(phone) : 'No mobile number') + '</div>';
          html += '</div>';
          html += '</div>';

          html += '<div style="display:flex;align-items:center;gap:6px;">';
          if (phone) {
            html += '<span style="font-size:11px;color:#16A34A;font-weight:700;background:#DCFCE7;padding:3px 8px;border-radius:12px;display:inline-flex;align-items:center;gap:3px;">' +
              '<span class="material-symbols-rounded" style="font-size:13px;color:#25D366;">check_circle</span> WhatsApp Ready</span>';
            html += '<a href="' + escapeHtml(testUrl) + '" target="_blank" rel="noopener noreferrer" class="btn btn-sm" style="font-size:11px;background:#25D366;color:#ffffff;border-radius:6px;padding:4px 8px;text-decoration:none;display:inline-flex;align-items:center;gap:3px;font-weight:600;">' +
              '<span class="material-symbols-rounded" style="font-size:13px;">chat</span> Test</a>';
          } else {
            html += '<button type="button" class="btn btn-sm btn-outline" onclick="SafeHer.contacts.openModal(' + c.id + ')" style="font-size:11px;padding:3px 8px;">Add Phone</button>';
          }
          html += '</div>';
          html += '</div>';
        }
        html += '</div>';
        container.innerHTML = html;
      })
      .catch(function(err) {
        container.innerHTML = '<div style="font-size:12px;color:#DC2626;padding:8px 0;">Error loading contacts: ' + escapeHtml(err.message) + '</div>';
      });
  }

  // ── 3. Notification Settings (WhatsApp Events) ───────────────
  function loadSettings() {
    var container = document.getElementById('notif-settings-list');
    if (!container) return;

    var base = getBaseUrl();
    var headers = getAuthHeaders();

    fetch(base + '/api/notification-settings', { headers: headers })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        var settings = (res && res.data) || {};

        var events = [
          { key: "alert_created", label: "Emergency SOS Alert", sub: "Dispatched instantly when SOS button is pressed or triggered" },
          { key: "alert_uneasy", label: "Uneasy Mode Check-in", sub: "Sent to close emergency contacts during uneasy sessions" },
          { key: "alert_reminders", label: "Urgent Reminder WhatsApp Alerts", sub: "Follow-up reminders sent at 3 min and 10 min if alert is unacknowledged" },
          { key: "escort_started", label: "Escort Mode Journey", sub: "Dispatched when starting a monitored walking or transit journey" },
          { key: "timer_expired", label: "Safe Timer Expiry Alert", sub: "Emergency SOS sent automatically if safety timer countdown expires" },
          { key: "ride_started", label: "Ride Safety Tracking", sub: "Dispatched when boarding cab or auto with vehicle details and live route" },
          { key: "share_started", label: "Live Location Sharing", sub: "Dispatched when sharing live GPS coordinates with contacts" }
        ];

        var html = '<div style="display:flex;flex-direction:column;gap:12px;">';
        for (var i = 0; i < events.length; i++) {
          var ev = events[i];
          var isLocked = (ev.key === 'alert_created');
          var isEnabled = isLocked || (settings[ev.key] !== false);

          html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #F3F4F6;">';
          html += '<div style="padding-right:12px;min-width:0;flex:1;">';
          html += '<div style="font-size:13px;font-weight:600;color:#1F2937;">' + escapeHtml(ev.label) + '</div>';
          html += '<div style="font-size:11px;color:#6B7280;margin-top:2px;">' + escapeHtml(ev.sub) + '</div>';
          html += '</div>';

          html += '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">';
          if (isLocked) {
            html += '<span style="font-size:11px;font-weight:700;color:#16A34A;background:#DCFCE7;padding:3px 8px;border-radius:10px;">Always On</span>';
          } else {
            var checkedAttr = isEnabled ? 'checked' : '';
            html += '<label class="switch">' +
              '<input type="checkbox" ' + checkedAttr + ' onchange="SafeHer.notifications.toggleSetting(\'' + ev.key + '\', this.checked)">' +
              '<span class="slider"></span>' +
            '</label>';
          }
          html += '<button type="button" class="btn btn-sm btn-outline" onclick="SafeHer.notifications.sendTest(\'' + ev.key + '\')" style="font-size:11px;padding:3px 8px;height:26px;min-height:26px;">Test</button>';
          html += '</div>';
          html += '</div>';
        }
        html += '</div>';
        container.innerHTML = html;
      })
      .catch(function(err) {
        container.innerHTML = '<div style="font-size:12px;color:#DC2626;padding:8px 0;">Error loading settings: ' + escapeHtml(err.message) + '</div>';
      });
  }

  function toggleSetting(eventKey, enabled) {
    var base = getBaseUrl();
    var headers = getAuthHeaders();
    var payload = {};
    payload[eventKey] = !!enabled;

    fetch(base + '/api/notification-settings', {
      method: 'PUT',
      headers: headers,
      body: JSON.stringify(payload)
    }).then(function(r) { return r.json(); })
      .then(function(res) {
        if (res && res.ok) {
          SafeHer.toast('WhatsApp notification settings saved');
        } else {
          SafeHer.toast((res && res.error) || 'Failed to update settings');
        }
      })
      .catch(function() {
        SafeHer.toast('Network error saving settings');
      });
  }

  // ── 4. Send Test WhatsApp Alert ──────────────────────────────
  function sendTest(eventType) {
    eventType = eventType || 'alert_created';
    SafeHer.toast('Preparing test WhatsApp alert...');

    var base = getBaseUrl();
    var headers = getAuthHeaders();

    fetch(base + '/api/notifications/test', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ event_type: eventType })
    }).then(function(r) { return r.json(); })
      .then(function(res) {
        if (res && res.ok) {
          SafeHer.toast('Test alert generated! Opening WhatsApp...');
        }
      })
      .catch(function() {});

    // Open WhatsApp test link directly with rich 1-tap response format
    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : null;
    var userName = (user && user.name && user.name !== 'SafeHer User') ? user.name : 'Rohan P';
    var trackUrl = 'https://rohancse2025.github.io/Safeher/track.html?t=test_preview';
    var nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    var fullTestMsg = '🚨 *EMERGENCY SOS ALERT - SafeHer* 🚨\n\n' +
      '*' + userName + '* has triggered an urgent SOS alert!\n\n' +
      '⚠️ *Mode*: EMERGENCY\n' +
      '🕒 *Time*: ' + nowStr + '\n' +
      '📍 *Google Maps Location*:\nhttps://www.google.com/maps?q=13.0691321,77.7946567\n\n' +
      '🔴 *Live Tracking Map*:\n' + trackUrl + '\n\n' +
      '⚡ *Quick 1-Tap Response (No app needed):*\n' +
      '🏃 On my way: ' + trackUrl + '&action=on_my_way\n' +
      '📞 Called her: ' + trackUrl + '&action=called\n' +
      '🚓 Alerted Police: ' + trackUrl + '&action=police_alerted\n' +
      '✅ Safe with me: ' + trackUrl + '&action=safe_with_me\n\n' +
      'Please contact ' + userName + ' immediately or call Police (112).';
    window.open('https://wa.me/?text=' + encodeURIComponent(fullTestMsg), '_blank');
  }

  // ── 5. Delivery Log List ─────────────────────────────────────
  function loadDeliveryLog() {
    var container = document.getElementById('notif-delivery-log-list');
    if (!container) return;

    var base = getBaseUrl();
    var headers = getAuthHeaders();

    fetch(base + '/api/notifications?limit=50', { headers: headers })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        var items = (res && res.data) || [];
        if (!items || items.length === 0) {
          container.innerHTML = '<div style="font-size:12px;color:#6B7280;padding:12px 0;text-align:center;">' +
            'No emergency alert dispatches logged yet.' +
          '</div>';
          return;
        }

        var html = '<div style="display:flex;flex-direction:column;gap:8px;">';
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var evName = EVENT_LABELS[item.event_type] || item.event_type;
          var status = (item.status || 'dispatched').toLowerCase();
          var recipient = item.recipient_masked || (item.contact_name ? item.contact_name.split(' ')[0] : 'Contact');

          var chipBg = '#DCFCE7';
          var chipColor = '#166534';
          var chipLabel = 'Ready';

          if (status === 'sent' || status === 'delivered') {
            chipBg = '#DCFCE7';
            chipColor = '#166534';
            chipLabel = 'Sent';
          } else if (status === 'queued' || status === 'sending') {
            chipBg = '#EDE9FE';
            chipColor = '#5B21B6';
            chipLabel = 'Queued';
          } else if (status === 'failed') {
            chipBg = '#FEE2E2';
            chipColor = '#991B1B';
            chipLabel = 'Failed';
          }

          html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #F3F4F6;">';
          html += '<div style="min-width:0;flex:1;">';
          html += '<div style="font-size:12px;font-weight:600;color:#1F2937;">' + escapeHtml(evName) + '</div>';
          html += '<div style="font-size:11px;color:#6B7280;">To: ' + escapeHtml(recipient) + ' • ' + escapeHtml(item.created_at || '') + '</div>';
          html += '</div>';

          html += '<span style="font-size:10px;font-weight:700;color:' + chipColor + ';background:' + chipBg + ';padding:2px 8px;border-radius:10px;">' +
            escapeHtml(chipLabel) +
          '</span>';
          html += '</div>';
        }
        html += '</div>';
        container.innerHTML = html;
      })
      .catch(function(err) {
        container.innerHTML = '<div style="font-size:12px;color:#DC2626;padding:8px 0;">Error loading log: ' + escapeHtml(err.message) + '</div>';
      });
  }

  function startPolling() {
    isScreenActive = true;
    loadTopNotices();
    loadContactsStatus();
    loadSettings();
    loadDeliveryLog();

    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(function() {
      if (isScreenActive) {
        loadDeliveryLog();
      }
    }, 10000);
  }

  function stopPolling() {
    isScreenActive = false;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  return {
    init: startPolling,
    stopPolling: stopPolling,
    loadTopNotices: loadTopNotices,
    loadContactsStatus: loadContactsStatus,
    loadSettings: loadSettings,
    loadDeliveryLog: loadDeliveryLog,
    toggleSetting: toggleSetting,
    sendTest: sendTest
  };
})();


// ─── Delivery Tracker (1-Tap WhatsApp Emergency Dispatch) ──────
SafeHer.deliveryTracker = (function() {
  var activeTrackers = {};

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function mount(options) {
    var containerId = options.containerId;
    var container = document.getElementById(containerId);
    if (!container) return;

    if (activeTrackers[containerId] && activeTrackers[containerId].timer) {
      clearInterval(activeTrackers[containerId].timer);
      delete activeTrackers[containerId];
    }

    var contacts = options.contacts || (SafeHer.api && SafeHer.api.getContacts ? SafeHer.api.getContacts() : []) || [];
    var isEscortOrTimer = !!options.isEscortOrTimer;
    var isOffline = !!options.isOffline;
    var trackingUrl = options.trackingUrl || window.location.origin;
    var messageText = options.messageText || ('Emergency alert: ' + trackingUrl);
    var eventKeyPrefix = options.eventKeyPrefix || '';
    var entityId = options.entityId || null;

    var contactNames = contacts.map(function(c) { return c.name ? c.name.split(' ')[0] : 'Contact'; }).join(', ');
    if (!contactNames) contactNames = 'your contacts';

    var state = {
      containerId: containerId,
      contacts: contacts,
      contactNames: contactNames,
      isEscortOrTimer: isEscortOrTimer,
      isOffline: isOffline,
      trackingUrl: trackingUrl,
      messageText: messageText,
      eventKeyPrefix: eventKeyPrefix,
      entityId: entityId,
      pollCount: 0,
      maxPolls: 24,
      statusMap: {},
      confirmedSentCount: 0
    };

    activeTrackers[containerId] = state;
    render(state);
  }

  function render(state) {
    var container = document.getElementById(state.containerId);
    if (!container) return;

    var html = '';

    // (A) Offline Banner
    if (state.isOffline) {
      html += '<div style="background:#FFFBEB;border:1.5px solid #FCD34D;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;">' +
        '<span class="material-symbols-rounded" style="color:#D97706;font-size:20px;flex-shrink:0;">cloud_off</span>' +
        '<div style="font-size:12px;color:#92400E;font-weight:600;">' +
          'Offline Mode: Tap WhatsApp button below to alert contacts directly.' +
        '</div>' +
      '</div>';
    }

    // WhatsApp phone resolution
    var encMsg = encodeURIComponent(state.messageText);
    var firstPhone = '';
    for (var j = 0; j < state.contacts.length; j++) {
      if (state.contacts[j].phone) {
        firstPhone = state.contacts[j].phone.replace(/\D/g, '');
        break;
      }
    }
    var waPhone = firstPhone ? (firstPhone.length === 10 ? ('91' + firstPhone) : firstPhone) : '';
    var waUrl = waPhone ? ('https://wa.me/' + waPhone + '?text=' + encMsg) : ('https://wa.me/?text=' + encMsg);
    var smsUrl = firstPhone ? ('sms:' + firstPhone + '?body=' + encMsg) : ('sms:?body=' + encMsg);

    // Primary WhatsApp Alert Action Card (No Red Error Warnings!)
    html += '<div style="background:#FFFFFF;border:1.5px solid #BBF7D0;border-radius:14px;padding:14px 16px;margin-bottom:14px;box-shadow:0 2px 8px rgba(37,211,102,0.12);">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;border-bottom:1px solid #F0FDF4;padding-bottom:8px;">';
    html += '<div style="font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px;color:#15803D;">' +
      '<span class="material-symbols-rounded" style="color:#25D366;font-size:22px;">chat</span>' +
      '<span>WhatsApp Emergency Dispatch</span>' +
    '</div>';
    html += '<span style="font-size:10px;font-weight:700;color:#15803D;background:#DCFCE7;padding:3px 8px;border-radius:10px;display:flex;align-items:center;gap:4px;">' +
      '<span class="material-symbols-rounded" style="font-size:12px;">check_circle</span> Active' +
    '</span>';
    html += '</div>';

    html += '<p style="font-size:12px;color:#4B5563;margin:0 0 12px 0;line-height:1.4;">' +
      'Instant emergency alerts &amp; live GPS tracking links are ready for dispatch via WhatsApp to your emergency contacts.' +
    '</p>';

    // In active monitored sessions (Timer, Escort, Ride), WhatsApp is 100% automated in background!
    if (state.isEscortOrTimer) {
      html += '<div style="background:#F0FDF4;border:1px solid #86EFAC;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;">' +
        '<span class="material-symbols-rounded" style="color:#16A34A;font-size:22px;flex-shrink:0;">sync</span>' +
        '<div style="font-size:12px;color:#166534;line-height:1.4;">' +
          '<strong>Automated WhatsApp Dispatch Active:</strong> Your contacts are monitored and alerted automatically from our server in the background. No manual tap needed.' +
        '</div>' +
      '</div>';
    } else {
      // For active emergency SOS, show prominent 1-tap WhatsApp trigger
      html += '<a href="' + escapeHtml(waUrl) + '" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;justify-content:center;gap:10px;background:#25D366;color:#FFFFFF;padding:12px 16px;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;box-shadow:0 3px 10px rgba(37,211,102,0.3);margin-bottom:12px;">' +
        '<span class="material-symbols-rounded" style="font-size:22px;">chat</span>' +
        '<span>Open WhatsApp Alert (1-Tap Send)</span>' +
      '</a>';
    }

    // Contacts list
    if (state.contacts && state.contacts.length > 0) {
      html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#6B7280;margin-bottom:8px;letter-spacing:0.5px;">Emergency Contacts:</div>';
      html += '<div style="display:flex;flex-direction:column;gap:8px;">';
      for (var i = 0; i < state.contacts.length; i++) {
        var c = state.contacts[i];
        var cName = c.name || 'Contact';
        var cPhone = (c.phone || '').trim();
        var cPhoneClean = cPhone.replace(/\D/g, '');
        var cWaPhone = cPhoneClean.length === 10 ? ('91' + cPhoneClean) : cPhoneClean;
        var perWaUrl = cWaPhone ? ('https://wa.me/' + cWaPhone + '?text=' + encMsg) : waUrl;

        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:#F9FAFB;border-radius:8px;border:1px solid #E5E7EB;">';
        html += '<div style="display:flex;align-items:center;gap:8px;min-width:0;">';
        html += '<div style="width:28px;height:28px;border-radius:50%;background:#FFF0F3;color:var(--crimson);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
          escapeHtml((cName.charAt(0) || '?').toUpperCase()) +
        '</div>';
        html += '<div style="min-width:0;">';
        html += '<div style="font-size:12px;font-weight:600;color:#1F2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(cName) + '</div>';
        if (cPhone) {
          html += '<div style="font-size:11px;color:#6B7280;">' + escapeHtml(cPhone) + '</div>';
        }
        html += '</div>';
        html += '</div>';

        html += '<div style="display:flex;align-items:center;gap:6px;">';
        html += '<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;color:#166534;background:#DCFCE7;padding:3px 8px;border-radius:12px;">' +
          '<span class="material-symbols-rounded" style="font-size:12px;color:#25D366;">verified</span> WhatsApp Ready' +
        '</span>';
        if (cPhone) {
          html += '<a href="' + escapeHtml(perWaUrl) + '" target="_blank" rel="noopener noreferrer" style="font-size:11px;font-weight:600;color:#25D366;background:#FFFFFF;border:1px solid #86EFAC;padding:3px 8px;border-radius:6px;text-decoration:none;display:inline-flex;align-items:center;gap:3px;">' +
            '<span class="material-symbols-rounded" style="font-size:14px;">send</span> Chat</a>';
        }
        html += '</div>';
        html += '</div>';
      }
      html += '</div>';
    }

    html += '</div>';

    // (D) Offline SMS Fallback
    html += '<div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:10px 12px;margin-bottom:12px;">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;">';
    html += '<div style="display:flex;align-items:center;gap:8px;">';
    html += '<span class="material-symbols-rounded" style="color:#2563EB;font-size:20px;">sms</span>';
    html += '<div>';
    html += '<div style="font-size:12px;font-weight:700;color:#1F2937;">Offline SMS Backup</div>';
    html += '<div style="font-size:11px;color:#6B7280;">Use SMS if mobile data or internet is disconnected</div>';
    html += '</div>';
    html += '</div>';
    html += '<a href="' + escapeHtml(smsUrl) + '" class="btn btn-sm btn-outline" style="font-size:11px;padding:4px 10px;text-decoration:none;">Open SMS</a>';
    html += '</div>';
    html += '</div>';

    container.innerHTML = html;
  }

  function stopAll() {
    Object.keys(activeTrackers).forEach(function(k) {
      if (activeTrackers[k].timer) {
        clearInterval(activeTrackers[k].timer);
      }
    });
    activeTrackers = {};
  }

  return {
    mount: mount,
    stopAll: stopAll
  };
})();

SafeHer.delivery = SafeHer.deliveryTracker;
