// js/vault.js – Tamper-Proof Evidence Vault with Zero-Knowledge Client-Side Encryption
// Design:
// 1. Encryption: RSA-OAEP 2048 + Ephemeral AES-GCM per chunk + PBKDF2 (150,000 rounds)
//    - Public key is stored in plain form.
//    - Private key is AES-GCM encrypted using a key derived from user's Safety PIN.
//    - Recording needs NO PIN: each chunk is encrypted with a random AES-GCM key, which is then encrypted with the RSA public key.
//    - Playback REQUIRES the Safety PIN to unwrap the RSA private key and decrypt the chunks.
// 2. Hash Chain: Each chunk stores sha256(ciphertext) and chainHash = sha256(prevHash + sha256), ensuring cryptographic tamper-evidence.
// 3. Storage: IndexedDB 'SafeHerEvidenceVaultDB' with 'sessions' and 'chunks' stores.
// 4. Zero Permission Prompts during SOS: Mic and camera permissions are requested up front in Settings.

window.SafeHer = window.SafeHer || {};
var SafeHer = window.SafeHer;

SafeHer.vault = (function() {
  'use strict';

  var DB_NAME = 'SafeHerEvidenceVaultDB';
  var DB_VERSION = 1;
  var SESSIONS_STORE = 'sessions';
  var CHUNKS_STORE = 'chunks';

  var SETTINGS_KEY = 'safeher_vault_settings';
  var KEYS_KEY = 'safeher_vault_keys';

  var dbInstance = null;
  var activeSession = null;
  var currentMediaRecorder = null;
  var currentMediaStream = null;
  var sessionLimitTimer = null;
  var isRecording = false;

  // ─── 1. Support Detection & MIME Selection ─────────────────
  function isSupported() {
    return !!(
      window.MediaRecorder &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      window.crypto &&
      window.crypto.subtle &&
      window.indexedDB
    );
  }

  function getSupportedAudioMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    var candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/aac'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function getSupportedVideoMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    var candidates = [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  // ─── 2. IndexedDB Initializer ─────────────────────────────
  function getDB(callback) {
    if (dbInstance) {
      if (callback) callback(null, dbInstance);
      return;
    }
    if (!window.indexedDB) {
      if (callback) callback(new Error('IndexedDB not supported'));
      return;
    }

    var req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        var chunkStore = db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' });
        chunkStore.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = function(e) {
      dbInstance = e.target.result;
      if (callback) callback(null, dbInstance);
    };
    req.onerror = function(e) {
      if (callback) callback(e.target.error);
    };
  }

  // ─── 3. Utility Helpers ───────────────────────────────────
  function bufToHex(buffer) {
    var bytes = new Uint8Array(buffer);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i].toString(16);
      hex += (b.length === 1 ? '0' : '') + b;
    }
    return hex;
  }

  function bufToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  function base64ToBuf(base64) {
    var binary = window.atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // ─── 4. Settings Management ───────────────────────────────
  function getSettings() {
    try {
      var stored = localStorage.getItem(SETTINGS_KEY);
      if (stored) return JSON.parse(stored);
    } catch (e) {}
    return {
      enabled: false,
      recordSilentAudio: true,
      recordEmergencyVideo: true,
      micPermission: 'prompt',
      cameraPermission: 'prompt'
    };
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {}
  }

  // ─── 5. Key Management (RSA-OAEP 2048 + PBKDF2) ───────────
  // Generates an RSA-OAEP 2048 keypair. Public key is kept in plain form.
  // Private key is encrypted with AES-GCM using PBKDF2 (150,000 rounds) derived from user's Safety PIN.
  async function generateAndStoreVaultKeys(pin) {
    var cryptoSubtle = window.crypto && window.crypto.subtle;
    if (!cryptoSubtle) throw new Error('Web Crypto API not supported');

    var effectivePin = pin || (SafeHer.api && SafeHer.api.getPin ? SafeHer.api.getPin() : null) || '1234';

    // 1. Generate RSA-OAEP 2048 keypair
    var keyPair = await cryptoSubtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), // 65537
        hash: 'SHA-256'
      },
      true,
      ['encrypt', 'decrypt']
    );

    // 2. Export plain public key (JWK format)
    var publicKeyJwk = await cryptoSubtle.exportKey('jwk', keyPair.publicKey);

    // 3. Export raw private key (PKCS8)
    var privateKeyRaw = await cryptoSubtle.exportKey('pkcs8', keyPair.privateKey);

    // 4. Derive AES-GCM wrapping key from Safety PIN via PBKDF2 (150,000 iterations)
    var salt = window.crypto.getRandomValues(new Uint8Array(16));
    var pinKey = await cryptoSubtle.importKey(
      'raw',
      new TextEncoder().encode(effectivePin),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    var wrappingKey = await cryptoSubtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 150000,
        hash: 'SHA-256'
      },
      pinKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    // 5. Encrypt private key with AES-GCM
    var wrapIv = window.crypto.getRandomValues(new Uint8Array(12));
    var wrappedPrivateKey = await cryptoSubtle.encrypt(
      { name: 'AES-GCM', iv: wrapIv },
      wrappingKey,
      privateKeyRaw
    );

    var keysRecord = {
      publicKeyJwk: publicKeyJwk,
      wrappedPrivateKey: bufToBase64(wrappedPrivateKey),
      salt: bufToBase64(salt),
      wrapIv: bufToBase64(wrapIv),
      createdAt: new Date().toISOString()
    };

    localStorage.setItem(KEYS_KEY, JSON.stringify(keysRecord));
    return keysRecord;
  }

  function getStoredKeys() {
    try {
      var s = localStorage.getItem(KEYS_KEY);
      if (s) return JSON.parse(s);
    } catch (e) {}
    return null;
  }

  async function getPublicKey() {
    var keys = getStoredKeys();
    if (!keys || !keys.publicKeyJwk) {
      keys = await generateAndStoreVaultKeys();
    }
    return await window.crypto.subtle.importKey(
      'jwk',
      keys.publicKeyJwk,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );
  }

  // ─── 6. Unlock Vault (PIN Required) ───────────────────────
  // Uses PBKDF2 to derive the AES wrapping key, unwraps the RSA private key,
  // and returns a decryptor object.
  async function unlock(pin) {
    var cryptoSubtle = window.crypto && window.crypto.subtle;
    if (!cryptoSubtle) throw new Error('Web Crypto API not supported');

    var keys = getStoredKeys();
    if (!keys) throw new Error('Vault keys not initialized');

    var salt = base64ToBuf(keys.salt);
    var wrapIv = base64ToBuf(keys.wrapIv);
    var wrappedPrivateKey = base64ToBuf(keys.wrappedPrivateKey);

    // Derive wrapping key
    var pinKey = await cryptoSubtle.importKey(
      'raw',
      new TextEncoder().encode(pin),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    var unwrappingKey = await cryptoSubtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new Uint8Array(salt),
        iterations: 150000,
        hash: 'SHA-256'
      },
      pinKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    // Attempt to decrypt private key (throws on wrong PIN)
    var unwrappedPrivRaw;
    try {
      unwrappedPrivRaw = await cryptoSubtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(wrapIv) },
        unwrappingKey,
        wrappedPrivateKey
      );
    } catch (err) {
      throw new Error('Incorrect Safety PIN');
    }

    var rsaPrivateKey = await cryptoSubtle.importKey(
      'pkcs8',
      unwrappedPrivRaw,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt']
    );

    // Decrypt a single chunk
    async function decryptChunk(chunk) {
      // 1. Decrypt chunk's AES key with RSA private key
      var chunkKeyRaw = await cryptoSubtle.decrypt(
        { name: 'RSA-OAEP' },
        rsaPrivateKey,
        chunk.encryptedKey
      );

      // 2. Import ephemeral AES key
      var chunkKey = await cryptoSubtle.importKey(
        'raw',
        chunkKeyRaw,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );

      // 3. Decrypt chunk data
      var decryptedData = await cryptoSubtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(chunk.iv) },
        chunkKey,
        chunk.encryptedData
      );

      return decryptedData;
    }

    return {
      rsaPrivateKey: rsaPrivateKey,
      decryptChunk: decryptChunk
    };
  }

  // ─── 7. Chunk Encryption & Hash Chaining ──────────────────
  // Each chunk gets its own random AES-GCM key.
  // Encrypt chunk with AES-GCM.
  // Encrypt AES key with RSA-OAEP public key.
  // Compute sha256 and chainHash = sha256(prevHash + sha256).
  async function encryptAndSaveChunk(blob, sessionId, index, prevHash, mimeType) {
    var cryptoSubtle = window.crypto && window.crypto.subtle;
    if (!cryptoSubtle) return null;

    var arrayBuffer = await blob.arrayBuffer();

    // 1. Generate ephemeral 256-bit AES-GCM key for this chunk
    var chunkKey = await cryptoSubtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    var chunkKeyRaw = await cryptoSubtle.exportKey('raw', chunkKey);

    // 2. Encrypt chunk data with AES-GCM
    var chunkIv = window.crypto.getRandomValues(new Uint8Array(12));
    var encryptedData = await cryptoSubtle.encrypt(
      { name: 'AES-GCM', iv: chunkIv },
      chunkKey,
      arrayBuffer
    );

    // 3. Encrypt AES key with RSA-OAEP public key
    var rsaPub = await getPublicKey();
    var encryptedKey = await cryptoSubtle.encrypt(
      { name: 'RSA-OAEP' },
      rsaPub,
      chunkKeyRaw
    );

    // 4. Compute SHA-256 of ciphertext
    var digest = await cryptoSubtle.digest('SHA-256', encryptedData);
    var sha256Hex = bufToHex(digest);

    // 5. Compute chainHash = sha256(prevHash + sha256)
    var chainInput = new TextEncoder().encode(prevHash + sha256Hex);
    var chainDigest = await cryptoSubtle.digest('SHA-256', chainInput);
    var chainHashHex = bufToHex(chainDigest);

    var chunkRecord = {
      id: sessionId + '_' + index,
      sessionId: sessionId,
      index: index,
      mime: mimeType,
      size: blob.size,
      createdAt: new Date().toISOString(),
      encryptedData: encryptedData,
      encryptedKey: encryptedKey,
      iv: chunkIv,
      sha256: sha256Hex,
      prevHash: prevHash,
      chainHash: chainHashHex,
      uploaded: false
    };

    return new Promise(function(resolve, reject) {
      getDB(function(err, db) {
        if (err || !db) return reject(err || new Error('DB unavailable'));
        try {
          var tx = db.transaction([CHUNKS_STORE], 'readwrite');
          var store = tx.objectStore(CHUNKS_STORE);
          store.put(chunkRecord);
          tx.oncomplete = function() { resolve(chunkRecord); };
          tx.onerror = function(e) { reject(e.target.error); };
        } catch (ex) {
          reject(ex);
        }
      });
    });
  }

  // ─── 8. Session Management ────────────────────────────────
  // Limits: stop at 15 minutes for audio and 3 minutes for video per session.
  async function startSession(kind, alertId) {
    var settings = getSettings();
    if (!settings.enabled) return;
    if (!isSupported()) return;

    // End any existing session first
    if (activeSession) {
      endSession();
    }

    var isVideo = kind === 'video';
    var mimeType = isVideo ? getSupportedVideoMime() : getSupportedAudioMime();
    var maxDurationMs = isVideo ? (3 * 60 * 1000) : (15 * 60 * 1000); // 3 mins video, 15 mins audio

    // Warn if storage is low
    checkStorageSpace();

    var sessionId = 'vault_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    var sessionRecord = {
      id: sessionId,
      alertId: alertId || null,
      kind: kind,
      startedAt: new Date().toISOString(),
      endedAt: null,
      mime: mimeType
    };

    // Save session in IndexedDB
    getDB(function(err, db) {
      if (!err && db) {
        try {
          var tx = db.transaction([SESSIONS_STORE], 'readwrite');
          tx.objectStore(SESSIONS_STORE).put(sessionRecord);
        } catch (e) {}
      }
    });

    activeSession = {
      id: sessionId,
      alertId: alertId,
      kind: kind,
      mime: mimeType,
      currentIndex: 0,
      prevHash: '0'.repeat(64),
      startTime: Date.now()
    };

    // Auto-stop at duration limit
    sessionLimitTimer = setTimeout(function() {
      endSession();
    }, maxDurationMs);

    // Request stream: permissions are pre-granted in Settings, so NO prompt appears!
    // Never show a permission prompt during SOS: if stream fails, catch quietly.
    try {
      var constraints = isVideo ? { audio: true, video: { facingMode: 'user' } } : { audio: true };
      var stream = await navigator.mediaDevices.getUserMedia(constraints);
      currentMediaStream = stream;

      var recorderOptions = mimeType ? { mimeType: mimeType } : {};
      var recorder = new MediaRecorder(stream, recorderOptions);
      currentMediaRecorder = recorder;

      // Slice recording into 5-second encrypted chunks so evidence is preserved incrementally
      recorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0 && activeSession) {
          addChunk(e.data);
        }
      };

      recorder.onerror = function() {
        endSession();
      };

      recorder.start(5000); // Emit chunk every 5 seconds
      isRecording = true;
    } catch (err) {
      // Stream failed or blocked: silently abort without prompting during an emergency
      endSession();
    }
  }

  async function addChunk(blob) {
    if (!activeSession) return;
    var sess = activeSession;
    var idx = sess.currentIndex;
    var prev = sess.prevHash;
    var mime = sess.mime;

    sess.currentIndex++;

    try {
      var record = await encryptAndSaveChunk(blob, sess.id, idx, prev, mime);
      if (record && record.chainHash) {
        sess.prevHash = record.chainHash;
      }
    } catch (e) {
      console.warn('[Vault] Chunk encryption error:', e);
    }
  }

  function endSession() {
    if (sessionLimitTimer) {
      clearTimeout(sessionLimitTimer);
      sessionLimitTimer = null;
    }

    if (currentMediaRecorder && currentMediaRecorder.state !== 'inactive') {
      try {
        currentMediaRecorder.stop();
      } catch (e) {}
    }
    currentMediaRecorder = null;

    if (currentMediaStream) {
      try {
        currentMediaStream.getTracks().forEach(function(t) { t.stop(); });
      } catch (e) {}
    }
    currentMediaStream = null;

    if (activeSession) {
      var endedSessionId = activeSession.id;
      activeSession = null;
      isRecording = false;

      // Update endedAt in DB
      getDB(function(err, db) {
        if (!err && db) {
          try {
            var tx = db.transaction([SESSIONS_STORE], 'readwrite');
            var store = tx.objectStore(SESSIONS_STORE);
            var req = store.get(endedSessionId);
            req.onsuccess = function() {
              if (req.result) {
                var s = req.result;
                s.endedAt = new Date().toISOString();
                store.put(s);
              }
            };
          } catch (e) {}
        }
      });
    }
  }

  // ─── 9. Storage Estimation & Warnings ─────────────────────
  function checkStorageSpace(callback) {
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function(est) {
        var quota = est.quota || 0;
        var usage = est.usage || 0;
        var freeBytes = quota - usage;
        var isLow = freeBytes > 0 && freeBytes < (50 * 1024 * 1024); // Low if under 50 MB

        if (isLow && SafeHer.toast) {
          SafeHer.toast('Warning: Device storage is running low for evidence recording');
        }
        if (callback) callback(null, { usage: usage, quota: quota, isLow: isLow });
      }).catch(function(err) {
        if (callback) callback(err);
      });
    } else {
      if (callback) callback(null, null);
    }
  }

  // ─── 10. Up-Front Permissions Management ──────────────────
  // Asks for microphone permission once up front (and camera permission only when video is enabled),
  // then IMMEDIATELY stops the tracks. Never prompts during an SOS.
  async function requestPermissions(forVideo) {
    var settings = getSettings();
    try {
      if (forVideo) {
        var vStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        vStream.getTracks().forEach(function(t) { t.stop(); });
        settings.micPermission = 'granted';
        settings.cameraPermission = 'granted';
      } else {
        var aStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        aStream.getTracks().forEach(function(t) { t.stop(); });
        settings.micPermission = 'granted';
      }
    } catch (err) {
      if (forVideo) {
        settings.cameraPermission = 'denied';
      } else {
        settings.micPermission = 'denied';
      }
    }
    saveSettings(settings);
    updatePermissionUI();
    return settings;
  }

  async function checkPermissionsStatus() {
    var settings = getSettings();
    if (navigator.permissions && navigator.permissions.query) {
      try {
        var micStatus = await navigator.permissions.query({ name: 'microphone' });
        settings.micPermission = micStatus.state;
      } catch (e) {}
      try {
        var camStatus = await navigator.permissions.query({ name: 'camera' });
        settings.cameraPermission = camStatus.state;
      } catch (e) {}
      saveSettings(settings);
    }
    return settings;
  }

  function updatePermissionUI() {
    var settings = getSettings();
    var micEl = document.getElementById('vault-mic-status');
    var camEl = document.getElementById('vault-cam-status');

    if (micEl) {
      if (settings.micPermission === 'granted') {
        micEl.textContent = 'Granted';
        micEl.style.color = '#059669';
      } else if (settings.micPermission === 'denied') {
        micEl.textContent = 'Denied';
        micEl.style.color = 'var(--crimson)';
      } else {
        micEl.textContent = 'Not requested';
        micEl.style.color = 'var(--text-gray)';
      }
    }

    if (camEl) {
      if (settings.cameraPermission === 'granted') {
        camEl.textContent = 'Granted';
        camEl.style.color = '#059669';
      } else if (settings.cameraPermission === 'denied') {
        camEl.textContent = 'Denied';
        camEl.style.color = 'var(--crimson)';
      } else {
        camEl.textContent = 'Not requested';
        camEl.style.color = 'var(--text-gray)';
      }
    }
  }

  // ─── 11. Profile Settings UI Handlers ─────────────────────
  async function onToggleEnabled(enabled) {
    var settings = getSettings();
    settings.enabled = enabled;
    saveSettings(settings);

    var panel = document.getElementById('vault-enabled-panel');
    if (panel) {
      panel.style.display = enabled ? 'block' : 'none';
    }

    if (enabled) {
      // 1. Ensure vault encryption keys exist
      if (!getStoredKeys()) {
        try {
          await generateAndStoreVaultKeys();
        } catch (e) {}
      }

      // 2. Ask for microphone permission once up front, then immediately stop
      await requestPermissions(false);

      if (SafeHer.toast) {
        SafeHer.toast('Evidence recording enabled');
      }
    } else {
      endSession();
      if (SafeHer.toast) {
        SafeHer.toast('Evidence recording disabled');
      }
    }
  }

  function onToggleSilentAudio(checked) {
    var settings = getSettings();
    settings.recordSilentAudio = checked;
    saveSettings(settings);
  }

  async function onToggleEmergencyVideo(checked) {
    var settings = getSettings();
    settings.recordEmergencyVideo = checked;
    saveSettings(settings);

    // If enabling video, ask for camera permission up front if not already granted
    if (checked && settings.cameraPermission !== 'granted') {
      await requestPermissions(true);
    }
  }

  function renderSettings() {
    var settings = getSettings();
    var enableSwitch = document.getElementById('vault-enable-switch');
    var silentSwitch = document.getElementById('vault-silent-audio-switch');
    var emVideoSwitch = document.getElementById('vault-emergency-video-switch');
    var panel = document.getElementById('vault-enabled-panel');

    if (enableSwitch) enableSwitch.checked = !!settings.enabled;
    if (silentSwitch) silentSwitch.checked = !!settings.recordSilentAudio;
    if (emVideoSwitch) emVideoSwitch.checked = !!settings.recordEmergencyVideo;

    if (panel) {
      panel.style.display = settings.enabled ? 'block' : 'none';
    }

    checkPermissionsStatus().then(function() {
      updatePermissionUI();
    });
  }

  // ─── 12. Retrieval & Deletion ─────────────────────────────
  function getSessions(callback) {
    getDB(function(err, db) {
      if (err || !db) {
        if (callback) callback(err, []);
        return;
      }
      try {
        var tx = db.transaction([SESSIONS_STORE], 'readonly');
        var store = tx.objectStore(SESSIONS_STORE);
        var req = store.getAll();
        req.onsuccess = function() {
          var list = req.result || [];
          list.sort(function(a, b) { return (b.id > a.id ? 1 : -1); });
          if (callback) callback(null, list);
        };
        req.onerror = function(e) {
          if (callback) callback(e.target.error, []);
        };
      } catch (ex) {
        if (callback) callback(ex, []);
      }
    });
  }

  function deleteSession(sessionId, callback) {
    getDB(function(err, db) {
      if (err || !db) {
        if (callback) callback(err);
        return;
      }
      try {
        var tx = db.transaction([SESSIONS_STORE, CHUNKS_STORE], 'readwrite');
        tx.objectStore(SESSIONS_STORE).delete(sessionId);

        // Delete all chunks for this session
        var chunkStore = tx.objectStore(CHUNKS_STORE);
        var idx = chunkStore.index('sessionId');
        var req = idx.openCursor(IDBKeyRange.only(sessionId));
        req.onsuccess = function(e) {
          var cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };

        tx.oncomplete = function() {
          if (callback) callback(null);
        };
        tx.onerror = function(e) {
          if (callback) callback(e.target.error);
        };
      } catch (ex) {
        if (callback) callback(ex);
      }
    });
  }

  // ─── 13. Initialization ───────────────────────────────────
  function init() {
    getDB();
    if (SafeHer.router && SafeHer.router.onShow) {
      SafeHer.router.onShow('profile', function() {
        renderSettings();
      });
    }
  }

  return {
    init: init,
    isSupported: isSupported,
    getSettings: getSettings,
    saveSettings: saveSettings,
    onToggleEnabled: onToggleEnabled,
    onToggleSilentAudio: onToggleSilentAudio,
    onToggleEmergencyVideo: onToggleEmergencyVideo,
    renderSettings: renderSettings,
    requestPermissions: requestPermissions,
    checkPermissionsStatus: checkPermissionsStatus,
    startSession: startSession,
    addChunk: addChunk,
    endSession: endSession,
    unlock: unlock,
    getSessions: getSessions,
    deleteSession: deleteSession,
    checkStorageSpace: checkStorageSpace,
    getSupportedAudioMime: getSupportedAudioMime,
    getSupportedVideoMime: getSupportedVideoMime
  };
})();

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    SafeHer.vault.init();
  });
} else {
  SafeHer.vault.init();
}
