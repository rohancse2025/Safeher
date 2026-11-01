// js/profile.js – User profile, editing, notification toggles, alert history, and data management

SafeHer.profile = (function() {
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

  function renderNotifications() {
    var settings = SafeHer.api.getNotificationSettings();
    var smsToggle = document.getElementById('notif-sms');
    var soundToggle = document.getElementById('notif-sound');
    var locToggle = document.getElementById('notif-location');

    if (smsToggle) smsToggle.checked = !!settings.smsAlerts;
    if (soundToggle) soundToggle.checked = !!settings.soundAlarm;
    if (locToggle) locToggle.checked = !!settings.liveLocation;
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
  function renderAlertHistory() {
    var listEl = document.getElementById('profile-alert-history');
    if (!listEl) return;

    var alerts = SafeHer.api.getAlerts();

    if (!alerts || alerts.length === 0) {
      listEl.innerHTML = '<div class="alert-empty-card">' +
        '<span class="material-symbols-rounded alert-empty-icon">history</span>' +
        '<p class="alert-empty-title">No alerts triggered yet</p>' +
        '<p class="alert-empty-sub">Your emergency SOS alerts and mode history will appear here.</p>' +
      '</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < alerts.length; i++) {
      var a = alerts[i];
      var modeLabel = a.mode === 'emergency' ? 'Emergency' : (a.mode === 'silent' ? 'Silent' : 'Normal');
      var modeClass = a.mode === 'emergency' ? 'alert-mode-emergency' : (a.mode === 'silent' ? 'alert-mode-silent' : 'alert-mode-normal');
      var statusLabel = a.status === 'active' ? 'Active' : 'Resolved';
      var statusClass = a.status === 'active' ? 'alert-status-active' : 'alert-status-resolved';

      var dateStr = a.timestamp ? new Date(a.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      var timeStr = a.time || '';

      var mapsLink = (a.lat && a.lng)
        ? '<a href="https://www.google.com/maps?q=' + a.lat + ',' + a.lng + '" target="_blank" rel="noopener noreferrer" class="alert-item-link"><span class="material-symbols-rounded">map</span>Map</a>'
        : '';

      var endedStr = a.endTime ? '<span class="alert-item-ended">Ended ' + escapeHtml(a.endTime) + '</span>' : '';

      html += '<div class="alert-history-item">' +
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
        '</div>' +
      '</div>';
    }

    listEl.innerHTML = html;
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

  // ─── Clear All Data ───────────────────────────────────────
  function confirmClearAllData() {
    if (confirm('Clear all data? This will reset your profile, contacts, safety PIN, and alert history.')) {
      SafeHer.api.clearAllData();
      SafeHer.toast('All data cleared');
      SafeHer.router.go('auth');
    }
  }

  function init() {
    SafeHer.router.onShow('profile', function() {
      render();
    });
  }

  return {
    init: init,
    render: render,
    openEditModal: openEditModal,
    closeEditModal: closeEditModal,
    submitEditForm: submitEditForm,
    saveNotifications: saveNotifications,
    confirmClearAllData: confirmClearAllData
  };
})();
