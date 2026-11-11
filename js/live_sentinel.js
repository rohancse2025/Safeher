/**
 * SafeHer - Live Sentinel™
 * Real-Time Ambient Audio Uplink & Situational Audio Monitoring
 * 
 * Silently streams 4-second standalone ambient audio chunks from the victim's
 * phone microphone to the cloud backend during active SOS alerts (Normal, Silent,
 * or Emergency). Emergency contacts can tap 1 button on track.html to listen
 * in real-time with zero app installation.
 */

(function(window) {
  'use strict';

  var SafeHer = window.SafeHer = window.SafeHer || {};

  var STORAGE_KEY = 'safeher_sentinel_settings';
  var isStreaming = false;
  var currentAlertId = null;
  var currentShareToken = null;
  var currentStream = null;
  var currentRecorder = null;
  var audioContext = null;
  var analyserNode = null;
  var animFrameId = null;
  var chunkTimer = null;
  var chunkSeq = 1;
  var lastCalculatedDb = 35;
  var lastNoiseCategory = 'Quiet ambient';
  var isSilentMode = false;

  function getApiBase() {
    if (window.SafeHerConfig && window.SafeHerConfig.API_BASE) {
      return window.SafeHerConfig.API_BASE.replace(/\/+$/, '');
    }
    return window.location.origin;
  }

  function getSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      enabled: true,
      autoUpload: true,
      micPreAuthorized: false
    };
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch (e) {}
  }

  function getBestAudioMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    var candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/aac',
      'audio/ogg'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function classifyNoise(db) {
    if (db < 38) return 'Quiet ambient / stealth';
    if (db < 56) return 'Normal ambient / background';
    if (db < 72) return 'Voices / Speech detected';
    return '⚠️ Loud noise / Alert / Scream';
  }

  function setupAudioAnalysis(stream) {
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      audioContext = new AudioCtx();
      var source = audioContext.createMediaStreamSource(stream);
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 256;
      source.connect(analyserNode);

      var dataArray = new Uint8Array(analyserNode.frequencyBinCount);

      function analyze() {
        if (!isStreaming || !analyserNode) return;
        analyserNode.getByteTimeDomainData(dataArray);

        // Compute RMS
        var sumSquares = 0;
        for (var i = 0; i < dataArray.length; i++) {
          var val = (dataArray[i] - 128) / 128;
          sumSquares += val * val;
        }
        var rms = Math.sqrt(sumSquares / dataArray.length);
        if (rms < 0.001) rms = 0.001;

        // Decibel approximation
        var db = Math.round(20 * Math.log10(rms) + 95);
        if (db < 25) db = 25;
        if (db > 105) db = 105;

        lastCalculatedDb = db;
        lastNoiseCategory = classifyNoise(db);

        // Update in-app uplink badge if visible
        updateUplinkUi(db, lastNoiseCategory);

        animFrameId = requestAnimationFrame(analyze);
      }
      analyze();
    } catch (err) {
      console.warn('[Sentinel] AudioContext analysis error:', err);
    }
  }

  function updateUplinkUi(db, category) {
    if (isSilentMode || document.documentElement.classList.contains('silent-active')) {
      return; // Absolute silence and stealth in Silent SOS
    }
    var indicator = document.getElementById('sentinel-sos-indicator');
    if (indicator) {
      indicator.style.display = 'flex';
      var dbEl = document.getElementById('sentinel-sos-db');
      var catEl = document.getElementById('sentinel-sos-cat');
      if (dbEl) dbEl.textContent = db + ' dB';
      if (catEl) catEl.textContent = category;
    }
  }

  function uploadAudioChunk(blob, seq, db, category) {
    if (!currentAlertId) return;

    var apiBase = getApiBase();
    var formData = new FormData();
    var mime = blob.type || getBestAudioMime() || 'audio/webm';
    var ext = mime.indexOf('mp4') !== -1 ? '.mp4' : '.webm';

    formData.append('audio', blob, 'chunk_' + seq + ext);
    formData.append('sequence', seq);
    formData.append('amplitude_db', db);
    formData.append('noise_level', category);
    formData.append('mime_type', mime);
    formData.append('duration_ms', 4000);

    var tok = currentShareToken || (typeof currentAlertId === 'string' && (currentAlertId.indexOf('share_') === 0 || currentAlertId.indexOf('ride_') === 0 || currentAlertId.indexOf('escort_') === 0) ? currentAlertId : null);
    if (tok) {
      formData.append('share_token', tok);
    }

    var uploadUrl = apiBase + '/api/alerts/' + encodeURIComponent(currentAlertId) + '/live-audio';

    fetch(uploadUrl, {
      method: 'POST',
      body: formData
    })
    .then(function(res) {
      return res.json().catch(function() { return { ok: res.ok }; });
    })
    .then(function(data) {
      if (data && data.ok) {
        // Successfully streamed chunk
      }
    })
    .catch(function(err) {
      // Retain quietly without throwing or disturbing victim
      console.warn('[Sentinel] Chunk upload retry/drop:', err);
    });
  }

  function recordNextChunk() {
    if (!isStreaming || !currentStream) return;

    // Verify audio tracks active
    var tracks = currentStream.getAudioTracks();
    if (!tracks || tracks.length === 0 || tracks.every(function(t) { return t.readyState === 'ended'; })) {
      stop();
      return;
    }

    var mime = getBestAudioMime();
    var recorder = null;

    try {
      if (mime) {
        recorder = new MediaRecorder(currentStream, { mimeType: mime });
      } else {
        recorder = new MediaRecorder(currentStream);
      }
    } catch (e1) {
      try {
        recorder = new MediaRecorder(currentStream);
      } catch (e2) {
        console.warn('[Sentinel] Recorder initialization error:', e2);
        stop();
        return;
      }
    }

    try {
      currentRecorder = recorder;
      var chunkParts = [];

      recorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) {
          chunkParts.push(e.data);
        }
      };

      recorder.onstop = function() {
        if (chunkParts.length > 0) {
          var standaloneBlob = new Blob(chunkParts, { type: mime || 'audio/webm' });
          uploadAudioChunk(standaloneBlob, chunkSeq, lastCalculatedDb, lastNoiseCategory);
          chunkSeq++;
        }
      };

      // Start standalone chunk
      recorder.start();

      clearTimeout(chunkTimer);
      chunkTimer = setTimeout(function() {
        if (!isStreaming) return;
        if (recorder && recorder.state !== 'inactive') {
          try { recorder.stop(); } catch (e) {}
        }
        // Immediately trigger next standalone chunk
        recordNextChunk();
      }, 4000);

    } catch (e) {
      console.warn('[Sentinel] Recorder error:', e);
      stop();
    }
  }

  var sentinelApi = {
    /**
     * Start live sentinel ambient stream for the active SOS.
     */
    start: async function(alertId, shareToken) {
      var settings = getSettings();
      if (!settings.enabled) return;

      if (isStreaming) {
        if (alertId && alertId !== currentAlertId) currentAlertId = alertId;
        if (shareToken) currentShareToken = shareToken;
        return;
      }

      currentAlertId = alertId || (SafeHer.sos && SafeHer.sos.getCurrentAlertId ? SafeHer.sos.getCurrentAlertId() : Date.now());
      currentShareToken = shareToken || null;
      chunkSeq = 1;
      isSilentMode = document.documentElement.classList.contains('silent-active');

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn('[Sentinel] MediaDevices not supported on this browser');
        return;
      }

      try {
        currentStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: true
          }
        });

        isStreaming = true;

        // Remember mic permission granted
        var s = getSettings();
        s.micPreAuthorized = true;
        saveSettings(s);

        setupAudioAnalysis(currentStream);
        recordNextChunk();

        updateSentinelChipUi(true);

      } catch (err) {
        console.warn('[Sentinel] Mic access denied or unavailable:', err);
        isStreaming = false;
        updateSentinelChipUi(false);
      }
    },

    /**
     * Update alertId and token once backend creates it
     */
    updateAlertId: function(alertId, shareToken) {
      if (alertId) currentAlertId = alertId;
      if (shareToken) currentShareToken = shareToken;
    },

    /**
     * Stop live sentinel ambient stream
     */
    stop: function() {
      isStreaming = false;
      clearTimeout(chunkTimer);
      chunkTimer = null;

      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }

      if (currentRecorder && currentRecorder.state !== 'inactive') {
        try { currentRecorder.stop(); } catch (e) {}
      }
      currentRecorder = null;

      if (currentStream) {
        try {
          var tracks = currentStream.getAudioTracks();
          tracks.forEach(function(t) { t.stop(); });
        } catch (e) {}
        currentStream = null;
      }

      if (audioContext && audioContext.state !== 'closed') {
        try { audioContext.close(); } catch (e) {}
        audioContext = null;
      }
      analyserNode = null;

      var indicator = document.getElementById('sentinel-sos-indicator');
      if (indicator) indicator.style.display = 'none';

      updateSentinelChipUi(false);
    },

    /**
     * Pre-authorize microphone with live feedback test
     */
    preAuthorizeMic: async function(onMeterUpdate) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return { ok: false, error: 'Microphone not supported on this device' };
      }
      try {
        var testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        var testCtx = AudioCtx ? new AudioCtx() : null;
        var testSource = testCtx ? testCtx.createMediaStreamSource(testStream) : null;
        var testAnalyser = testCtx ? testCtx.createAnalyser() : null;

        if (testAnalyser && testSource) {
          testAnalyser.fftSize = 256;
          testSource.connect(testAnalyser);
        }

        var s = getSettings();
        s.micPreAuthorized = true;
        saveSettings(s);

        var dataArray = testAnalyser ? new Uint8Array(testAnalyser.frequencyBinCount) : null;
        var testInterval = null;

        if (onMeterUpdate && testAnalyser) {
          testInterval = setInterval(function() {
            testAnalyser.getByteTimeDomainData(dataArray);
            var sum = 0;
            for (var i = 0; i < dataArray.length; i++) {
              var v = (dataArray[i] - 128) / 128;
              sum += v * v;
            }
            var rms = Math.sqrt(sum / dataArray.length);
            var db = Math.round(20 * Math.log10(Math.max(0.001, rms)) + 95);
            onMeterUpdate(Math.min(100, Math.max(25, db)));
          }, 100);
        }

        // Return stop function to clean up
        return {
          ok: true,
          stop: function() {
            if (testInterval) clearInterval(testInterval);
            testStream.getAudioTracks().forEach(function(t) { t.stop(); });
            if (testCtx) try { testCtx.close(); } catch(e) {}
          }
        };
      } catch (err) {
        return { ok: false, error: err.name + ': ' + err.message };
      }
    },

    getStatus: function() {
      return {
        isStreaming: isStreaming,
        alertId: currentAlertId,
        chunkSeq: chunkSeq,
        lastDb: lastCalculatedDb,
        noiseCategory: lastNoiseCategory,
        settings: getSettings()
      };
    },

    getSettings: getSettings,
    saveSettings: saveSettings
  };

  function updateSentinelChipUi(active) {
    var chip = document.getElementById('chip-sentinel-status');
    var dot = document.getElementById('sentinel-chip-dot');
    var s = getSettings();
    var isEnabled = s.enabled;

    if (chip) {
      if (active) {
        chip.classList.add('chip-active');
        if (dot) dot.style.background = '#4CAF50';
        chip.title = 'Live Sentinel: Uplink Active';
      } else if (isEnabled) {
        chip.classList.add('chip-active');
        if (dot) dot.style.background = s.micPreAuthorized ? '#2196F3' : '#4CAF50';
        chip.title = s.micPreAuthorized ? 'Live Sentinel: Ready (Mic authorized)' : 'Live Sentinel: Ready';
      } else {
        chip.classList.remove('chip-active');
        if (dot) dot.style.background = '#9E9E9E';
        chip.title = 'Live Sentinel: OFF';
      }
    }

    var chipText = document.getElementById('home-chip-sentinel-text');
    if (chipText) {
      chipText.textContent = 'Sentinel: ' + (isEnabled ? 'ON' : 'OFF');
    }

    var pill = document.getElementById('sentinel-home-status-pill');
    if (pill) {
      pill.textContent = isEnabled ? 'READY' : 'OFF';
      pill.style.background = isEnabled ? '#ECFDF5' : '#F3F4F6';
      pill.style.color = isEnabled ? '#047857' : '#6B7280';
    }

    var homeSwitch = document.getElementById('sentinel-toggle-switch');
    if (homeSwitch) homeSwitch.checked = isEnabled;

    var modalSwitch = document.getElementById('sentinel-modal-switch');
    if (modalSwitch) modalSwitch.checked = isEnabled;

    var activeDetails = document.getElementById('sentinel-active-details');
    if (activeDetails) {
      activeDetails.style.display = isEnabled ? 'flex' : 'none';
    }
  }

  // Auto-init on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', function() {
    updateSentinelChipUi(false);
  });

  // Modal & Test Controller for index.html UI
  var activeMicTestStop = null;

  window.openSentinelModal = function() {
    var modal = document.getElementById('sentinel-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    var sw = document.getElementById('sentinel-modal-switch');
    if (sw) sw.checked = getSettings().enabled;
  };

  window.closeSentinelModal = function() {
    var modal = document.getElementById('sentinel-modal');
    if (modal) modal.style.display = 'none';
    if (activeMicTestStop) {
      activeMicTestStop();
      activeMicTestStop = null;
    }
  };

  window.toggleSentinelEnabled = function(checked) {
    var s = getSettings();
    s.enabled = checked;
    saveSettings(s);
    updateSentinelChipUi(false);
  };

  window.startSentinelMicTest = async function() {
    var btn = document.getElementById('btn-test-sentinel-mic');
    var statusEl = document.getElementById('sentinel-mic-test-status');
    var meter = document.getElementById('sentinel-mic-meter-fill');

    if (activeMicTestStop) {
      activeMicTestStop();
      activeMicTestStop = null;
      if (btn) btn.textContent = 'Test Mic';
      if (statusEl) statusEl.textContent = 'Microphone test stopped.';
      if (meter) meter.style.width = '0%';
      return;
    }

    if (statusEl) statusEl.textContent = 'Testing... Speak or make sound near your device:';
    if (btn) btn.textContent = 'Stop Test';

    var res = await sentinelApi.preAuthorizeMic(function(db) {
      if (meter) {
        var pct = Math.min(100, Math.max(5, Math.round(((db - 25) / 75) * 100)));
        meter.style.width = pct + '%';
      }
      if (statusEl) {
        statusEl.textContent = 'Audio detected: ' + db + ' dB (' + classifyNoise(db) + ')';
      }
    });

    if (res.ok) {
      activeMicTestStop = res.stop;
      setTimeout(function() {
        if (activeMicTestStop) {
          activeMicTestStop();
          activeMicTestStop = null;
          if (btn) btn.textContent = 'Test Mic';
          if (statusEl) statusEl.textContent = '✅ Microphone is working perfectly for Live Sentinel™!';
          if (meter) meter.style.width = '0%';
        }
      }, 7000);
    } else {
      if (statusEl) statusEl.textContent = '❌ Microphone access error: ' + (res.error || 'Permission denied');
      if (btn) btn.textContent = 'Test Mic';
    }
  };

  SafeHer.sentinel = sentinelApi;

})(window);
