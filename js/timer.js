// js/timer.js – Safe Timer with circular countdown ring, localStorage persistence, and auto-SOS
//
// Note: In mobile browsers, timers can pause when the screen is locked or browser is minimized.
// Real-time background server-side monitoring requires a backend service.

SafeHer.timer = (function() {
  var timerInterval = null;
  var currentTimer = null;
  var CIRCUMFERENCE = 552.92; // 2 * PI * 88

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(totalSecs) {
    var s = Math.max(0, Math.floor(totalSecs));
    var hours = Math.floor(s / 3600);
    var mins = Math.floor((s % 3600) / 60);
    var secs = s % 60;

    var mm = (mins < 10 ? '0' : '') + mins;
    var ss = (secs < 10 ? '0' : '') + secs;

    if (hours > 0) {
      var hh = (hours < 10 ? '0' : '') + hours;
      return hh + ':' + mm + ':' + ss;
    }
    return mm + ':' + ss;
  }

  function updateRingProgress(remaining, total) {
    var ring = document.getElementById('timer-ring-progress');
    if (!ring || total <= 0) return;

    var frac = Math.max(0, Math.min(1, remaining / total));
    var offset = CIRCUMFERENCE * (1 - frac);
    ring.style.strokeDashoffset = offset;
  }

  function populateContactsSelect(selectedId) {
    var select = document.getElementById('timer-contact-select');
    if (!select) return;

    var contacts = (SafeHer.api && SafeHer.api.getContacts) ? SafeHer.api.getContacts() : [];
    var html = '<option value="all">All Trusted Contacts (' + contacts.length + ')</option>';

    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      var label = c.name + (c.relation ? ' (' + c.relation + ')' : '');
      var isSel = (selectedId && String(selectedId) === String(c.id)) ? ' selected' : '';
      html += '<option value="' + escapeHtml(c.id) + '"' + isSel + '>' + escapeHtml(label) + '</option>';
    }

    select.innerHTML = html;
  }

  function showSetupView() {
    var setupEl = document.getElementById('timer-setup-view');
    var runningEl = document.getElementById('timer-running-view');
    if (setupEl) setupEl.style.display = 'block';
    if (runningEl) runningEl.style.display = 'none';
    populateContactsSelect();
  }

  function showRunningView() {
    var setupEl = document.getElementById('timer-setup-view');
    var runningEl = document.getElementById('timer-running-view');
    if (setupEl) setupEl.style.display = 'none';
    if (runningEl) runningEl.style.display = 'block';
  }

  function setPresetMinutes(mins) {
    var input = document.getElementById('timer-custom-minutes');
    if (input) input.value = mins;

    var chips = document.querySelectorAll('.timer-chip');
    chips.forEach(function(chip) {
      var cMins = parseInt(chip.dataset.mins, 10);
      chip.classList.toggle('active', cMins === mins);
    });
  }

  function start() {
    var input = document.getElementById('timer-custom-minutes');
    var mins = input ? parseInt(input.value, 10) : 15;

    if (!mins || isNaN(mins) || mins <= 0) {
      SafeHer.toast('Please choose a valid duration in minutes');
      return;
    }

    var contactSelect = document.getElementById('timer-contact-select');
    var contactId = contactSelect ? contactSelect.value : 'all';
    var contactName = 'All Trusted Contacts';

    if (contactId !== 'all' && contactSelect && contactSelect.selectedIndex >= 0) {
      contactName = contactSelect.options[contactSelect.selectedIndex].text;
    }

    var totalSeconds = mins * 60;
    var targetTime = Date.now() + totalSeconds * 1000;

    currentTimer = {
      minutes: mins,
      totalSeconds: totalSeconds,
      targetTime: targetTime,
      contactId: contactId,
      contactName: contactName,
      status: 'running'
    };

    if (SafeHer.api && SafeHer.api.setSafeTimer) {
      SafeHer.api.setSafeTimer(currentTimer, function(err, saved) {
        if (!err && saved && saved.backendTimerId && currentTimer) {
          currentTimer.backendTimerId = saved.backendTimerId;
        }
      });
    }

    SafeHer.toast('Safe Timer started for ' + mins + 'm');
    beginCountdown();
  }

  function beginCountdown() {
    clearInterval(timerInterval);
    showRunningView();

    var displayEl = document.getElementById('timer-countdown-display');
    var contactInfoEl = document.getElementById('timer-running-contact');
    var expiryInfoEl = document.getElementById('timer-running-expiry');

    if (contactInfoEl) {
      contactInfoEl.textContent = 'Alerting: ' + (currentTimer.contactName || 'All Contacts');
    }

    if (expiryInfoEl) {
      var expiryDate = new Date(currentTimer.targetTime);
      expiryInfoEl.textContent = 'SOS activates at ' + expiryDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function tick() {
      if (!currentTimer) {
        clearInterval(timerInterval);
        return;
      }

      var remaining = Math.round((currentTimer.targetTime - Date.now()) / 1000);

      if (remaining <= 0) {
        clearInterval(timerInterval);
        timerInterval = null;

        if (displayEl) displayEl.textContent = '00:00';
        updateRingProgress(0, currentTimer.totalSeconds);

        if (SafeHer.api && SafeHer.api.clearSafeTimer) {
          SafeHer.api.clearSafeTimer();
        }
        currentTimer = null;

        showSetupView();
        SafeHer.toast('Safe Timer expired! Starting SOS...');

        // Automatically start the SOS countdown
        SafeHer.router.go('home');
        if (SafeHer.sos && SafeHer.sos.startCountdown) {
          SafeHer.sos.startCountdown();
        }
        return;
      }

      if (displayEl) displayEl.textContent = formatTime(remaining);
      updateRingProgress(remaining, currentTimer.totalSeconds);
    }

    tick();
    timerInterval = setInterval(tick, 1000);
  }

  function cancel() {
    clearInterval(timerInterval);
    timerInterval = null;

    if (SafeHer.api && SafeHer.api.clearSafeTimer) {
      SafeHer.api.clearSafeTimer();
    }
    currentTimer = null;

    showSetupView();
    SafeHer.toast('Safe Timer cancelled');
  }

  function checkSavedTimer() {
    if (!SafeHer.api || !SafeHer.api.getSafeTimer) return;

    var saved = SafeHer.api.getSafeTimer();
    if (saved && saved.targetTime && saved.status === 'running') {
      var remaining = Math.round((saved.targetTime - Date.now()) / 1000);
      if (remaining > 0) {
        currentTimer = saved;
        beginCountdown();
      } else {
        SafeHer.api.clearSafeTimer();
        currentTimer = null;
        showSetupView();
        SafeHer.toast('Safe Timer expired while away! Starting SOS...');
        SafeHer.router.go('home');
        if (SafeHer.sos && SafeHer.sos.startCountdown) {
          SafeHer.sos.startCountdown();
        }
      }
    } else {
      if (!currentTimer) {
        showSetupView();
        if (SafeHer.api && SafeHer.api.getActiveTimer) {
          SafeHer.api.getActiveTimer(function(err, active) {
            if (!err && active && active.deadline) {
              var target = new Date(active.deadline).getTime();
              var rem = Math.round((target - Date.now()) / 1000);
              if (rem > 0) {
                currentTimer = {
                  minutes: Math.ceil(rem / 60),
                  totalSeconds: rem,
                  targetTime: target,
                  contactId: active.contact_id,
                  contactName: 'Contact #' + active.contact_id,
                  backendTimerId: active.id,
                  status: 'running'
                };
                SafeHer.api.setSafeTimer(currentTimer);
                beginCountdown();
              }
            }
          });
        }
      }
    }
  }

  function init() {
    SafeHer.router.onShow('safe-timer', function() {
      checkSavedTimer();
    });

    // Check timer on page startup
    checkSavedTimer();
  }

  return {
    init: init,
    start: start,
    cancel: cancel,
    setPresetMinutes: setPresetMinutes,
    getCurrentTimer: function() { return currentTimer; }
  };
})();
