// js/pocket_guard.js – SafeHer PocketGuard: Bluetooth & Wired Earphone Remote Headset SOS Trigger
SafeHer.pocketGuard = (function() {
  var isEnabled = false;
  var silentAudio = null;
  var actionHistory = [];
  var isTesting = false;
  var testClicks = 0;
  var testTimer = null;
  var audioObjectUrl = null;

  var STORAGE_KEY = 'safeher_pocketguard_enabled';
  var TRIGGER_MODE_KEY = 'safeher_pocketguard_action'; // 'silent' | 'emergency'

  // Generate 1-second inaudible silent WAV audio blob URL
  function createSilentAudioUrl() {
    if (audioObjectUrl) return audioObjectUrl;

    try {
      var sampleRate = 8000;
      var numSamples = sampleRate; // 1 second of silence
      var buffer = new ArrayBuffer(44 + numSamples);
      var view = new DataView(buffer);

      function writeString(offset, str) {
        for (var i = 0; i < str.length; i++) {
          view.setUint8(offset + i, str.charCodeAt(i));
        }
      }

      writeString(0, 'RIFF');
      view.setUint32(4, 36 + numSamples, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true); // PCM subchunk size
      view.setUint16(20, 1, true);  // Audio format 1 = PCM
      view.setUint16(22, 1, true);  // 1 channel (mono)
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate, true);
      view.setUint16(32, 1, true);  // Block align
      view.setUint16(34, 8, true);  // 8 bits per sample
      writeString(36, 'data');
      view.setUint32(40, numSamples, true);

      var u8 = new Uint8Array(buffer, 44, numSamples);
      for (var i = 0; i < numSamples; i++) {
        u8[i] = 128; // 8-bit unsigned PCM silence
      }

      var blob = new Blob([buffer], { type: 'audio/wav' });
      audioObjectUrl = URL.createObjectURL(blob);
      return audioObjectUrl;
    } catch(e) {
      console.warn('[SafeHer PocketGuard] createSilentAudioUrl fallback:', e);
      // Minimal valid silent base64 data URI fallback
      return 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    }
  }

  function startSilentAudio(callback) {
    if (!silentAudio) {
      silentAudio = new Audio();
      silentAudio.src = createSilentAudioUrl();
      silentAudio.loop = true;
      silentAudio.volume = 0.01; // inaudible
    }

    var playPromise = silentAudio.play();
    if (playPromise && playPromise.then) {
      playPromise.then(function() {
        setupMediaSession();
        if (callback) callback(true);
      }).catch(function(err) {
        console.warn('[SafeHer PocketGuard] Silent audio autoplay pending user gesture:', err);
        // Still setup mediaSession handlers in case browser allows it
        setupMediaSession();
        if (callback) callback(false);
      });
    } else {
      setupMediaSession();
      if (callback) callback(true);
    }
  }

  function stopSilentAudio() {
    if (silentAudio) {
      silentAudio.pause();
      silentAudio.currentTime = 0;
    }
    clearMediaSession();
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'PocketGuard Active',
        artist: 'Triple-click headset button for Silent SOS',
        album: 'SafeHer Remote Guard',
        artwork: [
          { src: './assets/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: './assets/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });

      navigator.mediaSession.playbackState = 'playing';

      navigator.mediaSession.setActionHandler('play', onRemoteAction);
      navigator.mediaSession.setActionHandler('pause', onRemoteAction);
      navigator.mediaSession.setActionHandler('nexttrack', onRemoteAction);
      navigator.mediaSession.setActionHandler('previoustrack', onRemoteAction);
    } catch(e) {
      console.warn('[SafeHer PocketGuard] MediaSession configuration error:', e);
    }
  }

  function clearMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('nexttrack', null);
      navigator.mediaSession.setActionHandler('previoustrack', null);
    } catch(e) {}
  }

  function onRemoteAction(details) {
    var action = details && details.action ? details.action : 'remote';
    console.log('[SafeHer PocketGuard] Headset action intercepted:', action);

    // Keep loop active so browser doesn't revoke mediaSession permissions
    if (silentAudio && silentAudio.paused) {
      silentAudio.play().catch(function() {});
    }

    var now = Date.now();

    // 1. If in interactive test mode, handle test verification
    if (isTesting) {
      handleTestPress(action);
      return;
    }

    // 2. Direct firmware triple-press:
    // Many Bluetooth headsets (AirPods, Galaxy Buds, Sony, OnePlus) map a triple-tap to 'previoustrack'
    if (action === 'previoustrack') {
      actionHistory = [];
      executeEmergencyTrigger('Triple-tap previoustrack');
      return;
    }

    // 3. Multi-press rolling window:
    // User presses earphone button (play, pause, or nexttrack) 3 times within 2.5 seconds
    actionHistory.push(now);
    actionHistory = actionHistory.filter(function(t) { return now - t <= 2500; });

    if (actionHistory.length >= 3) {
      actionHistory = [];
      executeEmergencyTrigger('3-tap sequence (' + action + ')');
    }
  }

  function executeEmergencyTrigger(reason) {
    console.warn('[SafeHer PocketGuard] Emergency trigger invoked:', reason);

    // Tactile confirmation buzz through clothing: buzz-buzz-buzz
    if ('vibrate' in navigator) {
      navigator.vibrate([200, 100, 200, 100, 300]);
    }

    var mode = 'silent';
    try {
      mode = localStorage.getItem(TRIGGER_MODE_KEY) || 'silent';
    } catch(e) {}

    if (mode === 'emergency') {
      if (SafeHer.sos && SafeHer.sos.startEmergencyMode) {
        SafeHer.sos.startEmergencyMode();
      }
    } else {
      if (SafeHer.sos && SafeHer.sos.startSilentMode) {
        SafeHer.sos.startSilentMode();
      }
    }

    if (SafeHer.toast) {
      SafeHer.toast('PocketGuard: SOS Alert Triggered');
    }
  }

  // ─── Testing / Verification Mode ─────────────────────────────
  function startTestMode() {
    isTesting = true;
    testClicks = 0;
    updateTestUi();

    if (testTimer) clearTimeout(testTimer);
    testTimer = setTimeout(function() {
      if (isTesting && testClicks === 0) {
        stopTestMode();
      }
    }, 20000); // 20s timeout
  }

  function stopTestMode() {
    isTesting = false;
    testClicks = 0;
    if (testTimer) {
      clearTimeout(testTimer);
      testTimer = null;
    }
    updateTestUi();
  }

  function handleTestPress(action) {
    testClicks++;
    if ('vibrate' in navigator) {
      navigator.vibrate(80);
    }

    updateTestUi();

    if (testClicks >= 3 || action === 'previoustrack') {
      // Test passed!
      if ('vibrate' in navigator) {
        navigator.vibrate([150, 80, 250]);
      }
      var statusEl = document.getElementById('pg-test-status');
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:#059669; font-weight:700;">✅ Success! Headset remote trigger verified.</span>';
      }
      setTimeout(function() {
        stopTestMode();
      }, 3000);
    }
  }

  function updateTestUi() {
    var statusEl = document.getElementById('pg-test-status');
    var badge1 = document.getElementById('pg-test-dot-1');
    var badge2 = document.getElementById('pg-test-dot-2');
    var badge3 = document.getElementById('pg-test-dot-3');

    if (!isTesting) {
      if (statusEl) statusEl.innerHTML = 'Press <strong>Test Earphones</strong> and click your headset button 3 times.';
      if (badge1) badge1.style.background = '#E5E7EB';
      if (badge2) badge2.style.background = '#E5E7EB';
      if (badge3) badge3.style.background = '#E5E7EB';
      return;
    }

    if (statusEl) {
      statusEl.innerHTML = 'Listening... Click earphone button (' + testClicks + '/3)';
    }

    if (badge1) badge1.style.background = testClicks >= 1 ? 'var(--crimson)' : '#E5E7EB';
    if (badge2) badge2.style.background = testClicks >= 2 ? 'var(--crimson)' : '#E5E7EB';
    if (badge3) badge3.style.background = testClicks >= 3 ? 'var(--crimson)' : '#E5E7EB';
  }

  // ─── Public State Controls ───────────────────────────────────
  function enable() {
    isEnabled = true;
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch(e) {}

    startSilentAudio(function(success) {
      updateUi();
      if (SafeHer.toast) {
        SafeHer.toast('PocketGuard Active: Triple-press earphone button for SOS');
      }
    });
  }

  function disable() {
    isEnabled = false;
    try {
      localStorage.setItem(STORAGE_KEY, 'false');
    } catch(e) {}

    stopSilentAudio();
    stopTestMode();
    updateUi();
    if (SafeHer.toast) {
      SafeHer.toast('PocketGuard Deactivated');
    }
  }

  function toggle() {
    if (isEnabled) {
      disable();
    } else {
      enable();
    }
  }

  function onToggle(checked) {
    if (checked) {
      enable();
    } else {
      disable();
    }
  }

  function updateUi() {
    // 1. Home quick chip
    var chipText = document.getElementById('home-chip-pocketguard-text');
    var chipBtn = document.getElementById('home-chip-pocketguard');
    if (chipText) {
      chipText.textContent = isEnabled ? 'PocketGuard: ON' : 'PocketGuard: OFF';
    }
    if (chipBtn) {
      chipBtn.classList.toggle('chip-active', isEnabled);
    }

    // 2. Home card elements
    var cardSwitch = document.getElementById('pg-toggle-switch');
    if (cardSwitch) cardSwitch.checked = isEnabled;

    var statusPill = document.getElementById('pg-status-pill');
    if (statusPill) {
      if (isEnabled) {
        statusPill.textContent = 'ACTIVE';
        statusPill.style.background = '#ECFDF5';
        statusPill.style.color = '#059669';
        statusPill.style.border = '1px solid #A7F3D0';
      } else {
        statusPill.textContent = 'OFF';
        statusPill.style.background = '#F3F4F6';
        statusPill.style.color = '#6B7280';
        statusPill.style.border = '1px solid #E5E7EB';
      }
    }

    var detailsRow = document.getElementById('pg-active-details');
    if (detailsRow) {
      detailsRow.style.display = isEnabled ? 'flex' : 'none';
    }

    var iconWrap = document.getElementById('pg-icon-wrap');
    if (iconWrap) {
      iconWrap.style.background = isEnabled ? '#ECFDF5' : '#FFF1F2';
      iconWrap.style.borderColor = isEnabled ? '#A7F3D0' : '#FECDD3';
      var icon = iconWrap.querySelector('.material-symbols-rounded');
      if (icon) {
        icon.style.color = isEnabled ? '#059669' : 'var(--crimson)';
      }
    }

    // 3. Modal elements
    var modalSwitch = document.getElementById('pg-modal-switch');
    if (modalSwitch) modalSwitch.checked = isEnabled;

    var modeSelect = document.getElementById('pg-trigger-action-select');
    if (modeSelect) {
      try {
        var currentMode = localStorage.getItem(TRIGGER_MODE_KEY) || 'silent';
        modeSelect.value = currentMode;
      } catch(e) {}
    }
  }

  function openModal() {
    var modal = document.getElementById('pocketguard-modal');
    if (modal) {
      modal.style.display = 'flex';
      updateUi();
      updateTestUi();
      checkConnectedDevices();
    }
  }

  function closeModal() {
    var modal = document.getElementById('pocketguard-modal');
    if (modal) modal.style.display = 'none';
    stopTestMode();
  }

  function setTriggerAction(action) {
    try {
      localStorage.setItem(TRIGGER_MODE_KEY, action);
    } catch(e) {}
    if (SafeHer.toast) {
      SafeHer.toast(action === 'emergency' ? 'Trigger mode: Siren SOS' : 'Trigger mode: Silent SOS');
    }
  }

  // Detect if Bluetooth or wired audio device is connected
  function checkConnectedDevices() {
    var deviceStatusEl = document.getElementById('pg-device-status');
    if (!deviceStatusEl) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      deviceStatusEl.innerHTML = '<span style="color:#6B7280;">Bluetooth &amp; wired earphones supported</span>';
      return;
    }

    navigator.mediaDevices.enumerateDevices().then(function(devices) {
      var hasAudio = false;
      var hasBluetooth = false;
      devices.forEach(function(d) {
        if (d.kind === 'audioinput' || d.kind === 'audiooutput') {
          hasAudio = true;
          var label = (d.label || '').toLowerCase();
          if (label.indexOf('bluetooth') !== -1 || label.indexOf('wireless') !== -1 || label.indexOf('buds') !== -1 || label.indexOf('airpods') !== -1 || label.indexOf('headset') !== -1) {
            hasBluetooth = true;
          }
        }
      });

      if (hasBluetooth) {
        deviceStatusEl.innerHTML = '<span style="color:#059669; font-weight:600;"><span class="material-symbols-rounded" style="font-size:14px; vertical-align:middle;">bluetooth_connected</span> Wireless Headset Detected</span>';
      } else if (hasAudio) {
        deviceStatusEl.innerHTML = '<span style="color:#059669; font-weight:600;"><span class="material-symbols-rounded" style="font-size:14px; vertical-align:middle;">headphones</span> Headset Audio Ready</span>';
      } else {
        deviceStatusEl.innerHTML = '<span style="color:#6B7280;">Plug in or connect Bluetooth earphones to test remote trigger</span>';
      }
    }).catch(function() {
      deviceStatusEl.innerHTML = '<span style="color:#6B7280;">Bluetooth &amp; wired earphones supported</span>';
    });
  }

  function init() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'true') {
        enable();
      } else {
        updateUi();
      }
    } catch(e) {
      updateUi();
    }
  }

  return {
    init: init,
    enable: enable,
    disable: disable,
    toggle: toggle,
    onToggle: onToggle,
    openModal: openModal,
    closeModal: closeModal,
    startTestMode: startTestMode,
    stopTestMode: stopTestMode,
    setTriggerAction: setTriggerAction,
    isEnabled: function() { return isEnabled; }
  };
})();
