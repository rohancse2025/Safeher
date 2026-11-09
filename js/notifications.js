// js/notifications.js – Alerts and Notifications screen controller
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
    "contact_added": "Welcome & Consent Email",
    "alert_reminders": "Send reminder emails (at 3m & 10m)",
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
    "welcome": "Welcome & Consent Email"
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

  // ── 1. Top Notices ──────────────────────────────────────────
  function loadTopNotices() {
    var container = document.getElementById('notif-top-notices');
    if (!container) return;

    var base = getBaseUrl();
    var headers = getAuthHeaders();

    Promise.all([
      fetch(base + '/api/contacts/coverage', { headers: headers }).then(function(r) { return r.json(); }).catch(function() { return null; }),
      fetch(base + '/api/health/deep', { headers: headers }).then(function(r) { return r.json(); }).catch(function() { return null; })
    ]).then(function(results) {
      var coverageRes = results[0];
      var healthRes = results[1];

      var html = '';

      // Check Rule A: No contact has an email
      var hasEmailContact = false;
      if (coverageRes && coverageRes.ok && coverageRes.data) {
        hasEmailContact = (coverageRes.data.active_email_contacts || 0) > 0;
      }
      if (!hasEmailContact) {
        html += '<div class="notice-box notice-red" style="background:#FEF2F2;border:1.5px solid #F87171;border-radius:10px;padding:12px 14px;margin-bottom:12px;display:flex;align-items:flex-start;gap:10px;">' +
          '<span class="material-symbols-rounded" style="color:#DC2626;font-size:20px;flex-shrink:0;">warning</span>' +
          '<div style="font-size:12px;color:#991B1B;line-height:1.4;">' +
            '<strong>No contact has an email address.</strong> Automated email alerts cannot be sent until you add an email for at least one contact.' +
          '</div>' +
        '</div>';
      }

      // Check Rule B: Email service not configured or failing
      if (healthRes) {
        var emailHealth = healthRes.notifications || (healthRes.checks && healthRes.checks.brevo);
        var isEmailFailing = false;
        var sentToday = 0;

        if (healthRes.notifications) {
          isEmailFailing = !healthRes.notifications.brevo_configured || (healthRes.notifications.failed_last_hour > 5);
          sentToday = healthRes.notifications.sent_today || 0;
        } else if (healthRes.checks && healthRes.checks.brevo) {
          isEmailFailing = !healthRes.checks.brevo.configured || healthRes.checks.brevo.status !== 'ok';
        }

        if (isEmailFailing) {
          html += '<div class="notice-box notice-red" style="background:#FEF2F2;border:1.5px solid #F87171;border-radius:10px;padding:12px 14px;margin-bottom:12px;display:flex;align-items:flex-start;gap:10px;">' +
            '<span class="material-symbols-rounded" style="color:#DC2626;font-size:20px;flex-shrink:0;">error</span>' +
            '<div style="font-size:12px;color:#991B1B;line-height:1.4;">' +
              '<strong>Email service is not configured or encountering errors.</strong> Check your Brevo API key configuration.' +
            '</div>' +
          '</div>';
        }

        // Check Rule C: Gray notice when more than 250 emails were sent today
        if (sentToday > 250) {
          html += '<div class="notice-box notice-gray" style="background:#F3F4F6;border:1.5px solid #D1D5DB;border-radius:10px;padding:12px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;">' +
            '<span class="material-symbols-rounded" style="color:#4B5563;font-size:20px;flex-shrink:0;">info</span>' +
            '<div style="font-size:12px;color:#374151;line-height:1.4;">' +
              'More than 250 alert emails have been sent today (' + sentToday + ' / 300 free daily quota).' +
            '</div>' +
          '</div>';
        }
      }

      container.innerHTML = html;
    });
  }

  // ── 2. Contact Email Status List ────────────────────────────
  function loadContactsStatus() {
    var container = document.getElementById('notif-contacts-status-list');
    if (!container) return;

    var base = getBaseUrl();
    var headers = getAuthHeaders();

    fetch(base + '/api/contacts', { headers: headers })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        var contacts = (res && res.data) ? res.data : [];
        if (!contacts || contacts.length === 0) {
          container.innerHTML = '<p style="font-size:13px;color:var(--text-gray);margin:8px 0;">No contacts added yet. <a href="#" onclick="SafeHer.contacts.openModal(); return false;" style="color:var(--crimson);font-weight:600;">Add your first contact</a></p>';
          return;
        }

        var html = '';
        for (var i = 0; i < contacts.length; i++) {
          var c = contacts[i];
          var email = (c.email || '').trim();
          var status = (c.email_status || 'unknown').toLowerCase();
          var optedOut = !!c.opted_out;

          html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #F3F4F6;">';
          html += '<div>';
          html += '<div style="font-size:13px;font-weight:700;color:var(--text-dark);">' + escapeHtml(c.name) + ' <span style="font-size:11px;font-weight:500;color:var(--text-gray);">(' + escapeHtml(c.relation || 'Contact') + ')</span></div>';

          if (!email) {
            html += '<div style="display:flex;align-items:center;gap:4px;margin-top:2px;">' +
              '<span class="material-symbols-rounded" style="color:#DC2626;font-size:16px;">cancel</span>' +
              '<span style="font-size:12px;color:#DC2626;font-weight:600;">No email, add one</span>' +
            '</div>';
          } else if (status === 'bounced') {
            html += '<div style="display:flex;align-items:center;gap:4px;margin-top:2px;">' +
              '<span class="material-symbols-rounded" style="color:#D97706;font-size:16px;">error</span>' +
              '<span style="font-size:12px;color:#D97706;font-weight:600;">Email bounced, check the address</span>' +
            '</div>';
          } else if (optedOut) {
            html += '<div style="display:flex;align-items:center;gap:4px;margin-top:2px;">' +
              '<span class="material-symbols-rounded" style="color:#6B7280;font-size:16px;">unsubscribe</span>' +
              '<span style="font-size:12px;color:#6B7280;">Opted out by recipient</span>' +
            '</div>';
          } else {
            html += '<div style="display:flex;align-items:center;gap:4px;margin-top:2px;">' +
              '<span class="material-symbols-rounded" style="color:#16A34A;font-size:16px;">check_circle</span>' +
              '<span style="font-size:12px;color:#16A34A;font-weight:600;">' + escapeHtml(email) + ' (OK)</span>' +
            '</div>';
          }

          html += '</div>';
          html += '<div>';
          html += '<button type="button" class="btn btn-sm btn-outline" onclick="SafeHer.contacts.openModal(' + c.id + ')" style="padding:4px 10px;font-size:11px;height:30px;min-height:30px;">Edit</button>';
          html += '</div>';
          html += '</div>';
        }

        container.innerHTML = html;
      })
      .catch(function(err) {
        container.innerHTML = '<p style="font-size:12px;color:#DC2626;">Could not load contacts status.</p>';
      });
  }

  // ── 3. Notification Settings & Switches ─────────────────────
  function loadNotificationSettings() {
    var container = document.getElementById('notif-settings-list');
    if (!container) return;

    var base = getBaseUrl();
    var headers = getAuthHeaders();

    fetch(base + '/api/notification-settings', { headers: headers })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        var settings = (res && res.data && res.data.settings) ? res.data.settings : {};
        var canonicalEvents = [
          "alert_created",
          "alert_uneasy",
          "alert_escalated",
          "alert_ended",
          "volunteer_coming",
          "escort_started",
          "escort_arrived",
          "escort_off_route",
          "escort_missed_checkin",
          "escort_no_signal",
          "escort_late_arrival",
          "escort_ended",
          "timer_expired",
          "share_started",
          "share_ended",
          "ride_started",
          "ride_ended",
          "ride_late",
          "contact_added",
          "alert_reminders"
        ];

        var html = '';
        for (var i = 0; i < canonicalEvents.length; i++) {
          var et = canonicalEvents[i];
          var label = EVENT_LABELS[et] || et;
          var isSos = !!SOS_EVENTS[et];
          var enabled = isSos ? true : (settings[et] !== undefined ? !!settings[et] : true);

          html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid #F3F4F6;">';
          html += '<div style="flex:1;min-width:0;padding-right:12px;">';
          html += '<div style="font-size:13px;font-weight:700;color:var(--text-dark);">' + escapeHtml(label) + '</div>';
          html += '<div style="font-size:11px;color:var(--text-gray);margin-top:1px;">Event key: <code>' + escapeHtml(et) + '</code></div>';
          html += '</div>';

          html += '<div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">';
          html += '<button type="button" class="btn btn-sm btn-secondary" onclick="SafeHer.notifications.sendTest(\'' + escapeHtml(et) + '\')" style="padding:4px 8px;font-size:11px;height:28px;min-height:28px;">Send test</button>';

          if (isSos) {
            html += '<span style="font-size:10px;font-weight:700;background:#FEE2E2;color:#991B1B;padding:3px 8px;border-radius:12px;border:1px solid #FCA5A5;">Always on</span>';
          } else {
            var checkedAttr = enabled ? ' checked' : '';
            html += '<label class="switch" style="margin:0;">' +
              '<input type="checkbox"' + checkedAttr + ' onchange="SafeHer.notifications.toggleSetting(\'' + escapeHtml(et) + '\', this.checked)">' +
              '<span class="slider"></span>' +
            '</label>';
          }

          html += '</div>';
          html += '</div>';
        }

        container.innerHTML = html;
      })
      .catch(function(err) {
        container.innerHTML = '<p style="font-size:12px;color:#DC2626;">Could not load settings.</p>';
      });
  }

  function toggleSetting(eventType, enabled) {
    var base = getBaseUrl();
    var headers = getAuthHeaders();
    var body = { settings: {} };
    body.settings[eventType] = !!enabled;

    fetch(base + '/api/notification-settings', {
      method: 'PUT',
      headers: headers,
      body: JSON.stringify(body)
    })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res && res.ok) {
          SafeHer.toast('Alert setting saved');
        } else {
          SafeHer.toast((res && res.error) || 'Failed to update setting');
          loadNotificationSettings();
        }
      })
      .catch(function() {
        SafeHer.toast('Network error saving setting');
        loadNotificationSettings();
      });
  }

  // ── 4. Send Test Email ──────────────────────────────────────
  function sendTest(eventType) {
    var base = getBaseUrl();
    var headers = getAuthHeaders();

    SafeHer.toast('Sending test email...');

    fetch(base + '/api/notifications/test', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ event_type: eventType })
    })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res && res.ok) {
          SafeHer.toast('Test email sent to your address, check your inbox and spam folder');
          loadDeliveryLog();
        } else {
          SafeHer.toast((res && res.error) || 'Test email failed to send');
        }
      })
      .catch(function() {
        SafeHer.toast('Could not connect to notification service');
      });
  }

  // ── 5. Delivery Log with 10s auto-refresh ───────────────────
  function loadDeliveryLog() {
    var container = document.getElementById('notif-delivery-log-list');
    if (!container) return;

    var base = getBaseUrl();
    var headers = getAuthHeaders();

    fetch(base + '/api/notifications?limit=50', { headers: headers })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        var items = (res && res.data) ? res.data : [];
        if (!items || items.length === 0) {
          container.innerHTML = '<p style="font-size:12px;color:var(--text-gray);margin:12px 0;">No notifications recorded yet.</p>';
          return;
        }

        var html = '<div style="overflow-x:auto;">';
        html += '<table style="width:100%;border-collapse:collapse;font-size:12px;text-align:left;">';
        html += '<thead><tr style="border-bottom:1.5px solid #E5E7EB;color:#4B5563;">' +
          '<th style="padding:8px 6px;">Event</th>' +
          '<th style="padding:8px 6px;">Recipient</th>' +
          '<th style="padding:8px 6px;">Status</th>' +
          '<th style="padding:8px 6px;">Details</th>' +
          '<th style="padding:8px 6px;text-align:right;">Action</th>' +
        '</tr></thead>';
        html += '<tbody>';

        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var rawStatus = (item.status || 'queued').toLowerCase();
          var eventLabel = EVENT_LABELS[item.event_type] || item.event_type;

          var chipBg = '#E5E7EB';
          var chipColor = '#374151';
          if (rawStatus === 'sent') { chipBg = '#DCFCE7'; chipColor = '#166534'; }
          else if (rawStatus === 'delivered') { chipBg = '#DBEAFE'; chipColor = '#1E40AF'; }
          else if (rawStatus === 'failed') { chipBg = '#FEE2E2'; chipColor = '#991B1B'; }
          else if (rawStatus === 'bounced') { chipBg = '#FEF3C7'; chipColor = '#92400E'; }
          else if (rawStatus === 'skipped') { chipBg = '#F3F4F6'; chipColor = '#6B7280'; }
          else if (rawStatus === 'queued' || rawStatus === 'sending') { chipBg = '#EDE9FE'; chipColor = '#5B21B6'; }

          var reason = item.last_error || (rawStatus === 'sent' || rawStatus === 'delivered' ? 'Dispatched via Brevo' : '');
          var recipientDisplay = item.recipient_masked || 'Contact';

          html += '<tr style="border-bottom:1px solid #F3F4F6;">';
          html += '<td style="padding:8px 6px;font-weight:600;color:#1F2937;">' + escapeHtml(eventLabel) + '</td>';
          html += '<td style="padding:8px 6px;color:#4B5563;">' + escapeHtml(recipientDisplay) + '</td>';
          html += '<td style="padding:8px 6px;">' +
            '<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:700;text-transform:capitalize;background:' + chipBg + ';color:' + chipColor + ';">' +
              escapeHtml(rawStatus) +
            '</span>' +
          '</td>';
          html += '<td style="padding:8px 6px;color:#6B7280;font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(reason) + '">' +
            escapeHtml(reason || '—') +
          '</td>';
          html += '<td style="padding:8px 6px;text-align:right;">';

          if (rawStatus === 'failed' || rawStatus === 'bounced') {
            html += '<button type="button" class="btn btn-sm btn-crimson" onclick="SafeHer.notifications.retryNotification(' + item.id + ')" style="padding:3px 8px;font-size:10px;height:24px;min-height:24px;">Retry</button>';
          } else {
            html += '<span style="color:#9CA3AF;">—</span>';
          }

          html += '</td>';
          html += '</tr>';
        }

        html += '</tbody></table></div>';
        container.innerHTML = html;
      })
      .catch(function() {
        container.innerHTML = '<p style="font-size:12px;color:#DC2626;">Could not refresh delivery log.</p>';
      });
  }

  function retryNotification(notifId) {
    var base = getBaseUrl();
    var headers = getAuthHeaders();

    fetch(base + '/api/notifications/' + notifId + '/retry', {
      method: 'POST',
      headers: headers
    })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res && res.ok) {
          SafeHer.toast('Notification requeued for resend');
          loadDeliveryLog();
        } else {
          SafeHer.toast((res && res.error) || 'Failed to retry notification');
        }
      })
      .catch(function() {
        SafeHer.toast('Network error retrying notification');
      });
  }

  // ── 6. Lifecycle & Polling ──────────────────────────────────
  function startPolling() {
    stopPolling();
    refreshTimer = setInterval(function() {
      if (isScreenActive) {
        loadDeliveryLog();
        loadTopNotices();
      }
    }, 10000);
  }

  function stopPolling() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function renderScreen() {
    isScreenActive = true;
    loadTopNotices();
    loadContactsStatus();
    loadNotificationSettings();
    loadDeliveryLog();
    startPolling();
  }

  function init() {
    if (window.SafeHer && SafeHer.router) {
      SafeHer.router.onShow('notifications', function() {
        renderScreen();
      });
    }
  }

  return {
    init: init,
    renderScreen: renderScreen,
    toggleSetting: toggleSetting,
    sendTest: sendTest,
    loadDeliveryLog: loadDeliveryLog,
    retryNotification: retryNotification,
    stopPolling: stopPolling
  };
})();


// ─────────────────────────────────────────────────────────────
// SafeHer.offlineQueue – Resilient Offline Request Dispatcher
// ─────────────────────────────────────────────────────────────
SafeHer.offlineQueue = (function() {
  var STORAGE_KEY = 'safeher_offline_queue';

  function getQueue() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch(e) {
      return [];
    }
  }

  function enqueue(req) {
    var queue = getQueue();
    queue.push({
      id: 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      endpoint: req.endpoint,
      method: req.method || 'POST',
      payload: req.payload || {},
      description: req.description || 'Request',
      timestamp: Date.now()
    });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    } catch(e) {}
  }

  function flush() {
    if (!navigator.onLine) return;
    var queue = getQueue();
    if (!queue || queue.length === 0) return;

    var base = (window.SafeHer && SafeHer.api && SafeHer.api.BASE_URL) || 'https://safeher-dwkj.onrender.com';
    var token = (SafeHer.api && SafeHer.api.getToken) ? SafeHer.api.getToken() : null;

    var remaining = [];
    var pChain = Promise.resolve();

    queue.forEach(function(item) {
      pChain = pChain.then(function() {
        var headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;

        return fetch(base + item.endpoint, {
          method: item.method,
          headers: headers,
          body: JSON.stringify(item.payload)
        }).then(function(res) {
          if (res.ok) {
            if (SafeHer.toast) SafeHer.toast('✓ Dispatched queued ' + item.description);
          } else {
            remaining.push(item);
          }
        }).catch(function() {
          remaining.push(item);
        });
      });
    });

    pChain.then(function() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(remaining));
      } catch(e) {}
    });
  }

  window.addEventListener('online', flush);

  return {
    enqueue: enqueue,
    flush: flush,
    getQueue: getQueue
  };
})();


// ─────────────────────────────────────────────────────────────
// SafeHer.deliveryTracker – Real-time Delivery Status Component
// ─────────────────────────────────────────────────────────────
SafeHer.deliveryTracker = (function() {
  var activeTrackers = {}; // containerId -> tracker state

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

    var hasAnyEmail = contacts.some(function(c) {
      return !!(c.email && c.email.trim());
    });

    var state = {
      containerId: containerId,
      contacts: contacts,
      contactNames: contactNames,
      hasAnyEmail: hasAnyEmail,
      isEscortOrTimer: isEscortOrTimer,
      isOffline: isOffline,
      trackingUrl: trackingUrl,
      messageText: messageText,
      eventKeyPrefix: eventKeyPrefix,
      entityId: entityId,
      pollCount: 0,
      maxPolls: 24, // 24 * 2.5s = 60s
      statusMap: {},
      confirmedSentCount: 0
    };

    activeTrackers[containerId] = state;
    render(state);

    if (!isOffline && hasAnyEmail) {
      startPolling(state);
    }
  }

  function render(state) {
    var container = document.getElementById(state.containerId);
    if (!container) return;

    var html = '';

    // (A) Offline Banner (Rule 7)
    if (state.isOffline) {
      html += '<div style="background:#FFFBEB;border:1.5px solid #FCD34D;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;">' +
        '<span class="material-symbols-rounded" style="color:#D97706;font-size:20px;flex-shrink:0;">cloud_off</span>' +
        '<div style="font-size:12px;color:#92400E;font-weight:600;">' +
          'Will send when connected' +
        '</div>' +
      '</div>';
    }

    // (B) Red Box if NO contact has an email (Rule 5)
    if (!state.hasAnyEmail && state.contacts.length > 0) {
      html += '<div style="background:#FEF2F2;border:1.5px solid #F87171;border-radius:10px;padding:12px 14px;margin-bottom:12px;display:flex;align-items:flex-start;gap:10px;">' +
        '<span class="material-symbols-rounded" style="color:#DC2626;font-size:20px;flex-shrink:0;">error</span>' +
        '<div style="font-size:12px;color:#991B1B;line-height:1.4;">' +
          '<strong>No one can be emailed.</strong> Add an email to a contact, or use the buttons below.' +
        '</div>' +
      '</div>';
    }

    // (C) Consistent Status Card (Rule 4)
    var titleHtml = '';
    var isPollingActive = state.pollCount < state.maxPolls && !state.isOffline;

    if (state.confirmedSentCount > 0) {
      titleHtml = '<span class="material-symbols-rounded" style="color:#16A34A;font-size:18px;">check_circle</span> ' +
        '<span style="color:#166534;">Email sent to ' + escapeHtml(state.contactNames) + '</span>';
    } else if (state.isEscortOrTimer) {
      titleHtml = '<span class="material-symbols-rounded" style="color:#4B5563;font-size:18px;">schedule_send</span> ' +
        '<span style="color:#374151;">Alert emails queued for ' + escapeHtml(state.contactNames) + '</span>';
    } else {
      // NEVER show "Alert sent" or "Notified" until backend confirms at least one sent!
      titleHtml = '<span class="material-symbols-rounded" style="color:#D97706;font-size:18px;">hourglass_top</span> ' +
        '<span style="color:#92400E;">Sending...</span>';
    }

    html += '<div style="background:#FFFFFF;border:1.5px solid #E5E7EB;border-radius:12px;padding:12px 14px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;border-bottom:1px solid #F3F4F6;padding-bottom:8px;">';
    html += '<div style="font-size:13px;font-weight:700;display:flex;align-items:center;gap:6px;">' + titleHtml + '</div>';

    if (isPollingActive) {
      html += '<span style="font-size:10px;font-weight:600;color:#6B7280;background:#F3F4F6;padding:2px 6px;border-radius:10px;display:flex;align-items:center;gap:3px;">' +
        '<span class="material-symbols-rounded" style="font-size:12px;">sync</span> live' +
      '</span>';
    }
    html += '</div>';

    // Contacts list
    html += '<div style="display:flex;flex-direction:column;gap:8px;">';
    for (var i = 0; i < state.contacts.length; i++) {
      var c = state.contacts[i];
      var cName = c.name || 'Contact';
      var cEmail = (c.email || '').trim();
      var info = state.statusMap[c.id] || null;

      var statusText = '';
      var statusColor = '#6B7280';
      var statusBg = '#F3F4F6';
      var statusIcon = 'schedule';

      if (!cEmail) {
        statusText = 'No email saved for ' + cName;
        statusColor = '#92400E';
        statusBg = '#FEF3C7';
        statusIcon = 'mail_lock';
      } else if (!info) {
        statusText = 'Sending to ' + cName + '...';
        statusColor = '#5B21B6';
        statusBg = '#EDE9FE';
        statusIcon = 'hourglass_top';
      } else {
        var rawStatus = (info.status || '').toLowerCase();
        if (rawStatus === 'sent') {
          statusText = 'Email sent to ' + cName;
          statusColor = '#166534';
          statusBg = '#DCFCE7';
          statusIcon = 'check_circle';
        } else if (rawStatus === 'delivered') {
          statusText = 'Email delivered to ' + cName;
          statusColor = '#1E40AF';
          statusBg = '#DBEAFE';
          statusIcon = 'mark_email_read';
        } else if (rawStatus === 'failed' || rawStatus === 'bounced') {
          var errReason = info.last_error ? (' (' + info.last_error + ')') : '';
          statusText = 'Email failed' + errReason;
          statusColor = '#991B1B';
          statusBg = '#FEE2E2';
          statusIcon = 'error';
        } else if (rawStatus === 'skipped') {
          statusText = 'No email saved for ' + cName;
          statusColor = '#92400E';
          statusBg = '#FEF3C7';
          statusIcon = 'mail_lock';
        } else {
          statusText = 'Sending to ' + cName + '...';
          statusColor = '#5B21B6';
          statusBg = '#EDE9FE';
          statusIcon = 'hourglass_top';
        }
      }

      html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">';
      html += '<div style="display:flex;align-items:center;gap:8px;min-width:0;">';
      html += '<div style="width:26px;height:26px;border-radius:50%;background:#FFF0F3;color:var(--crimson);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
        escapeHtml((cName.charAt(0) || '?').toUpperCase()) +
      '</div>';
      html += '<div style="font-size:12px;font-weight:600;color:#1F2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(cName) + '</div>';
      html += '</div>';

      html += '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:' + statusColor + ';background:' + statusBg + ';padding:3px 8px;border-radius:12px;flex-shrink:0;">' +
        '<span class="material-symbols-rounded" style="font-size:13px;">' + statusIcon + '</span>' +
        escapeHtml(statusText) +
      '</span>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';

    // (D) Manual WhatsApp & SMS Fallback Buttons with exact text (Rule 6)
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

    html += '<div style="background:#FAFAFA;border:1px solid #E5E7EB;border-radius:12px;padding:12px 14px;margin-bottom:12px;">';
    html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#6B7280;margin-bottom:8px;letter-spacing:0.5px;">Manual Fallback</div>';
    html += '<div style="display:flex;flex-direction:column;gap:8px;">';

    html += '<a href="' + escapeHtml(waUrl) + '" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" style="display:flex;align-items:center;gap:10px;text-align:left;padding:10px 12px;background:#FFFFFF;border:1px solid #D1D5DB;border-radius:8px;text-decoration:none;">' +
      '<span class="material-symbols-rounded" style="color:#25D366;font-size:22px;flex-shrink:0;">chat</span>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:12px;font-weight:700;color:#1F2937;">Send WhatsApp Message</div>' +
        '<div style="font-size:11px;color:#6B7280;">Opens WhatsApp with the message ready. Tap Send</div>' +
      '</div>' +
      '<span class="material-symbols-rounded" style="color:#9CA3AF;font-size:18px;">open_in_new</span>' +
    '</a>';

    html += '<a href="' + escapeHtml(smsUrl) + '" class="btn btn-secondary" style="display:flex;align-items:center;gap:10px;text-align:left;padding:10px 12px;background:#FFFFFF;border:1px solid #D1D5DB;border-radius:8px;text-decoration:none;">' +
      '<span class="material-symbols-rounded" style="color:#2563EB;font-size:22px;flex-shrink:0;">sms</span>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:12px;font-weight:700;color:#1F2937;">Send SMS Alert</div>' +
        '<div style="font-size:11px;color:#6B7280;">Opens SMS with the message ready. Tap Send</div>' +
      '</div>' +
      '<span class="material-symbols-rounded" style="color:#9CA3AF;font-size:18px;">open_in_new</span>' +
    '</a>';

    html += '</div>';
    html += '</div>';

    container.innerHTML = html;
  }

  function startPolling(state) {
    if (state.timer) clearInterval(state.timer);

    function poll() {
      if (!document.getElementById(state.containerId)) {
        clearInterval(state.timer);
        return;
      }

      state.pollCount++;
      if (state.pollCount > state.maxPolls) {
        clearInterval(state.timer);
        render(state);
        return;
      }

      var base = getBaseUrl();
      var headers = getAuthHeaders();
      var q = '?limit=30';
      if (state.eventKeyPrefix) {
        q += '&event_key_prefix=' + encodeURIComponent(state.eventKeyPrefix);
      }
      if (state.entityId && (state.containerId.indexOf('sos') !== -1 || state.containerId.indexOf('uneasy') !== -1)) {
        q += '&alert_id=' + encodeURIComponent(state.entityId);
      }

      fetch(base + '/api/notifications' + q, { headers: headers })
        .then(function(r) { return r.json(); })
        .then(function(res) {
          var items = (res && res.data) ? res.data : [];
          var sentCount = 0;

          items.forEach(function(item) {
            if (item.contact_id) {
              state.statusMap[item.contact_id] = {
                status: (item.status || '').toLowerCase(),
                last_error: item.last_error
              };
              if (item.status === 'sent' || item.status === 'delivered') {
                sentCount++;
              }
            }
          });

          state.confirmedSentCount = sentCount;
          render(state);

          var allTerminal = state.contacts.every(function(c) {
            if (!c.email) return true;
            var st = state.statusMap[c.id] ? state.statusMap[c.id].status : '';
            return st === 'sent' || st === 'delivered' || st === 'failed' || st === 'bounced' || st === 'skipped';
          });
          if (allTerminal && sentCount > 0) {
            clearInterval(state.timer);
          }
        })
        .catch(function() {});
    }

    setTimeout(poll, 1000);
    state.timer = setInterval(poll, 2500);
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
