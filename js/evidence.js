// js/evidence.js – Audio Evidence recorder with MediaRecorder API, IndexedDB local storage, and audio playback

SafeHer.evidence = (function() {
  var DB_NAME = 'SafeHerEvidenceDB';
  var DB_VERSION = 1;
  var STORE_NAME = 'recordings';

  var mediaRecorder = null;
  var audioChunks = [];
  var recordStream = null;
  var recordInterval = null;
  var recordSeconds = 0;
  var isRecording = false;

  var currentAudio = null;
  var playingId = null;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDuration(sec) {
    var s = Math.max(0, Math.floor(sec));
    var m = Math.floor(s / 60);
    var rem = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (rem < 10 ? '0' : '') + rem;
  }

  // ─── IndexedDB Storage ────────────────────────────────────
  function getDB(callback) {
    if (!window.indexedDB) {
      callback(new Error('IndexedDB not supported'));
      return;
    }
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = function(e) {
      callback(null, e.target.result);
    };
    req.onerror = function(e) {
      callback(e.target.error);
    };
  }

  function saveToDB(record, callback) {
    getDB(function(err, db) {
      if (err) { if (callback) callback(err); return; }
      var tx = db.transaction(STORE_NAME, 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      var req = store.put(record);
      req.onsuccess = function() { if (callback) callback(null, record); };
      req.onerror = function(e) { if (callback) callback(e.target.error); };
    });
  }

  function getAllFromDB(callback) {
    getDB(function(err, db) {
      if (err) { callback(err, []); return; }
      var tx = db.transaction(STORE_NAME, 'readonly');
      var store = tx.objectStore(STORE_NAME);
      var req = store.getAll();
      req.onsuccess = function(e) {
        var items = e.target.result || [];
        items.sort(function(a, b) { return b.timestamp - a.timestamp; });
        callback(null, items);
      };
      req.onerror = function(e) { callback(e.target.error, []); };
    });
  }

  function deleteFromDB(id, callback) {
    getDB(function(err, db) {
      if (err) { if (callback) callback(err); return; }
      var tx = db.transaction(STORE_NAME, 'readwrite');
      var store = tx.objectStore(STORE_NAME);
      var req = store.delete(id);
      req.onsuccess = function() { if (callback) callback(null); };
      req.onerror = function(e) { if (callback) callback(e.target.error); };
    });
  }

  // ─── MediaRecorder Recording ──────────────────────────────
  function startRecording() {
    var deniedEl = document.getElementById('evidence-mic-denied');
    if (deniedEl) deniedEl.style.display = 'none';

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMicDenied('Audio recording is not supported in this browser.');
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function(stream) {
        recordStream = stream;
        audioChunks = [];

        var mimeType = 'audio/webm';
        if (typeof MediaRecorder.isTypeSupported === 'function') {
          if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            mimeType = 'audio/webm;codecs=opus';
          } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
            mimeType = 'audio/ogg;codecs=opus';
          } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
            mimeType = 'audio/mp4';
          }
        }

        try {
          mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
        } catch(e) {
          mediaRecorder = new MediaRecorder(stream);
        }

        mediaRecorder.ondataavailable = function(e) {
          if (e.data && e.data.size > 0) {
            audioChunks.push(e.data);
          }
        };

        mediaRecorder.onstop = function() {
          var blobType = mediaRecorder.mimeType || 'audio/webm';
          var blob = new Blob(audioChunks, { type: blobType });
          var dur = recordSeconds;

          var now = new Date();
          var dateStr = now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) +
                        ' at ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

          var record = {
            id: Date.now(),
            timestamp: Date.now(),
            dateStr: dateStr,
            durationSec: dur,
            durationStr: formatDuration(dur),
            blob: blob
          };

          saveToDB(record, function(err) {
            if (!err) {
              SafeHer.toast('Evidence recording saved');
              renderRecordings();
            } else {
              SafeHer.toast('Could not save recording');
            }
          });

          // Clean up stream tracks
          if (recordStream) {
            recordStream.getTracks().forEach(function(t) { t.stop(); });
            recordStream = null;
          }
        };

        mediaRecorder.start(200); // 200ms slices
        isRecording = true;
        recordSeconds = 0;

        updateRecordUI(true);

        clearInterval(recordInterval);
        recordInterval = setInterval(function() {
          recordSeconds++;
          var timerEl = document.getElementById('evidence-timer-display');
          if (timerEl) timerEl.textContent = formatDuration(recordSeconds);
        }, 1000);
      })
      .catch(function(err) {
        var msg = 'Microphone permission was denied. Please allow microphone access in your browser or device settings to record safety evidence.';
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          msg = 'No microphone device was detected on your device.';
        }
        showMicDenied(msg);
      });
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder) return;
    isRecording = false;

    clearInterval(recordInterval);
    recordInterval = null;

    if (mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }

    updateRecordUI(false);
  }

  function toggleRecord() {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  function showMicDenied(msg) {
    var deniedEl = document.getElementById('evidence-mic-denied');
    var msgEl = document.getElementById('evidence-denied-msg');
    if (msgEl) msgEl.textContent = msg;
    if (deniedEl) deniedEl.style.display = 'block';
    updateRecordUI(false);
  }

  function updateRecordUI(recording) {
    var btn = document.getElementById('btn-record-evidence');
    var pulseEl = document.getElementById('evidence-recording-pulse');
    var statusEl = document.getElementById('evidence-status-label');
    var timerEl = document.getElementById('evidence-timer-display');

    if (recording) {
      if (btn) {
        btn.classList.add('recording');
        btn.innerHTML = '<span class="material-symbols-rounded">stop</span>Stop Recording';
      }
      if (pulseEl) pulseEl.style.display = 'inline-block';
      if (statusEl) statusEl.textContent = 'Recording safety audio...';
      if (timerEl) timerEl.textContent = '00:00';
    } else {
      if (btn) {
        btn.classList.remove('recording');
        btn.innerHTML = '<span class="material-symbols-rounded">mic</span>Start Recording';
      }
      if (pulseEl) pulseEl.style.display = 'none';
      if (statusEl) statusEl.textContent = 'Tap to record audio evidence';
      if (timerEl) timerEl.textContent = '00:00';
    }
  }

  // ─── Playback & List ──────────────────────────────────────
  function playRecording(id) {
    if (playingId === id && currentAudio) {
      // Toggle pause
      currentAudio.pause();
      currentAudio = null;
      playingId = null;
      updatePlayIcons();
      return;
    }

    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
      playingId = null;
    }

    getAllFromDB(function(err, items) {
      var item = null;
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === id) { item = items[i]; break; }
      }
      if (!item || !item.blob) {
        SafeHer.toast('Recording audio not found');
        return;
      }

      var url = URL.createObjectURL(item.blob);
      currentAudio = new Audio(url);
      playingId = id;
      updatePlayIcons();

      currentAudio.onended = function() {
        currentAudio = null;
        playingId = null;
        updatePlayIcons();
        URL.revokeObjectURL(url);
      };

      currentAudio.onerror = function() {
        SafeHer.toast('Playback error');
        currentAudio = null;
        playingId = null;
        updatePlayIcons();
      };

      currentAudio.play().catch(function() {
        SafeHer.toast('Could not play audio');
        currentAudio = null;
        playingId = null;
        updatePlayIcons();
      });
    });
  }

  function updatePlayIcons() {
    var buttons = document.querySelectorAll('.evidence-play-btn');
    buttons.forEach(function(b) {
      var bId = parseInt(b.dataset.id, 10);
      var icon = b.querySelector('.material-symbols-rounded');
      if (icon) {
        if (playingId === bId) {
          icon.textContent = 'pause';
        } else {
          icon.textContent = 'play_arrow';
        }
      }
    });
  }

  function deleteRecord(id) {
    if (playingId === id && currentAudio) {
      currentAudio.pause();
      currentAudio = null;
      playingId = null;
    }
    deleteFromDB(id, function(err) {
      if (!err) {
        SafeHer.toast('Recording deleted');
        renderRecordings();
      }
    });
  }

  function renderRecordings() {
    var listEl = document.getElementById('evidence-records-list');
    var emptyEl = document.getElementById('evidence-records-empty');
    if (!listEl) return;

    getAllFromDB(function(err, items) {
      if (!items || items.length === 0) {
        if (emptyEl) emptyEl.style.display = 'flex';
        listEl.innerHTML = '';
        return;
      }

      if (emptyEl) emptyEl.style.display = 'none';

      var html = '';
      for (var i = 0; i < items.length; i++) {
        var rec = items[i];
        var isPlaying = (playingId === rec.id);
        var playIcon = isPlaying ? 'pause' : 'play_arrow';

        html += '<div class="evidence-item-card">' +
          '<div class="evidence-item-info">' +
            '<div class="evidence-item-icon-box">' +
              '<span class="material-symbols-rounded">mic</span>' +
            '</div>' +
            '<div class="evidence-item-text">' +
              '<p class="evidence-item-date">' + escapeHtml(rec.dateStr) + '</p>' +
              '<p class="evidence-item-duration">' + escapeHtml(rec.durationStr) + '</p>' +
            '</div>' +
          '</div>' +
          '<div class="evidence-item-actions">' +
            '<button class="evidence-play-btn" data-id="' + rec.id + '" onclick="SafeHer.evidence.playRecording(' + rec.id + ')" aria-label="Play recording">' +
              '<span class="material-symbols-rounded">' + playIcon + '</span>' +
            '</button>' +
            '<button class="evidence-delete-btn" onclick="SafeHer.evidence.deleteRecord(' + rec.id + ')" aria-label="Delete recording">' +
              '<span class="material-symbols-rounded">delete</span>' +
            '</button>' +
          '</div>' +
        '</div>';
      }

      listEl.innerHTML = html;
    });
  }

  function init() {
    SafeHer.router.onShow('evidence', function() {
      renderRecordings();
    });
  }

  return {
    init: init,
    toggleRecord: toggleRecord,
    startRecording: startRecording,
    stopRecording: stopRecording,
    playRecording: playRecording,
    deleteRecord: deleteRecord,
    renderRecordings: renderRecordings
  };
})();
