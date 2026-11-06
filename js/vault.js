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
  var chunkIntervalTimer = null;
  var isRecording = false;
  var uploadQueue = [];
  var isProcessingUploadQueue = false;
  var currentFacingMode = 'user'; // 'user' | 'environment'
  var isAudioOnlyMode = false;
  var previewMediaStream = null;
  var visibleSessionElapsedTimer = null;
  var visibleSessionSeconds = 0;
  var previousScreenBeforeEvidence = 'profile';

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

  // Strict check: Discreet recording is ONLY permitted inside an active SOS started by the user!
  function isUserSosActive() {
    if (SafeHer.sos && typeof SafeHer.sos.isAlertActive === 'function') {
      return SafeHer.sos.isAlertActive();
    }
    if (SafeHer.api && SafeHer.api.getActiveSos) {
      var sos = SafeHer.api.getActiveSos();
      return !!(sos && sos.status === 'active');
    }
    return false;
  }

  // Check mic and camera permissions via navigator.permissions.query without prompting
  async function areEmergencyPermissionsGranted() {
    if (!navigator.permissions || !navigator.permissions.query) {
      return false;
    }
    try {
      var micP = await navigator.permissions.query({ name: 'microphone' });
      var camP = await navigator.permissions.query({ name: 'camera' });
      return !!(micP && micP.state === 'granted' && camP && camP.state === 'granted');
    } catch (e) {
      return false;
    }
  }

  // Check microphone permission via navigator.permissions.query without prompting
  async function isMicrophonePermissionGranted() {
    if (!navigator.permissions || !navigator.permissions.query) {
      return false;
    }
    try {
      var res = await navigator.permissions.query({ name: 'microphone' });
      return !!(res && res.state === 'granted');
    } catch (e) {
      // If query throws or descriptor unsupported -> do NOT prompt; skip recording
      return false;
    }
  }

  // ─── 8a. Silent SOS Audio Recording (Discreet & Standalone 10s Chunks) ───
  // When Silent mode starts and the setting “Record audio quietly during Silent SOS” is on
  // and the microphone permission is already “granted” (check with navigator.permissions.query),
  // start an audio session with no on-screen change at all: the screen stays pure black,
  // no text, no sound, no vibration, no toast.
  // If the permission isn’t already granted, do not ask and do not show anything; skip recording.
  // Record in standalone 10-second chunks by stopping and restarting the MediaRecorder every 10 seconds
  // so each chunk is a playable file, encrypt each chunk, add it to the hash chain, and queue it for upload.
  // Strict Constraint: This recording must only run inside an active SOS the user started;
  // do not create any other way to start discreet recording.
  async function startSilentSession(alertId) {
    // 1. Strict guard: Must only run inside an active SOS the user started
    if (!isUserSosActive()) {
      return;
    }
    if (!alertId && SafeHer.sos && typeof SafeHer.sos.getCurrentAlertId === 'function') {
      alertId = SafeHer.sos.getCurrentAlertId();
    }
    if (!alertId) {
      return;
    }

    // 2. Setting check: “Record audio quietly during Silent SOS”
    var settings = getSettings();
    if (!settings.enabled || !settings.recordSilentAudio) {
      return;
    }

    // 3. Technical support check
    if (!isSupported()) {
      return;
    }

    // 4. Permission check via navigator.permissions.query
    // If permission isn't already granted, do NOT ask and do NOT show anything; skip recording!
    var granted = await isMicrophonePermissionGranted();
    if (!granted) {
      return;
    }

    // 5. End any previous session quietly (no toast, no sound)
    if (activeSession) {
      endSession();
    }

    var mimeType = getSupportedAudioMime();
    var sessionId = 'vault_silent_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    var maxDurationMs = 15 * 60 * 1000; // 15 mins audio limit

    var sessionRecord = {
      id: sessionId,
      alertId: alertId,
      kind: 'audio',
      startedAt: new Date().toISOString(),
      endedAt: null,
      mime: mimeType,
      isSilent: true
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
      kind: 'audio',
      mime: mimeType,
      currentIndex: 0,
      prevHash: '0'.repeat(64),
      startTime: Date.now(),
      isSilent: true
    };
    isRecording = true;

    // Auto-stop at 15-minute duration limit
    sessionLimitTimer = setTimeout(function() {
      endSession();
    }, maxDurationMs);

    // Acquire audio stream: mic permission is already "granted", so no prompt is shown!
    try {
      currentMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      endSession();
      return;
    }

    // Begin standalone 10-second chunk recording cycle
    recordNextSilentChunk();
  }

  function recordNextSilentChunk() {
    if (!activeSession || !activeSession.isSilent || !isUserSosActive()) {
      endSession();
      return;
    }

    // Ensure audio track is active and not ended
    if (!currentMediaStream || currentMediaStream.getAudioTracks().every(function(t) { return t.readyState === 'ended'; })) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function(newStream) {
        currentMediaStream = newStream;
        recordNextSilentChunk();
      }).catch(function() {
        endSession();
      });
      return;
    }

    var mimeType = activeSession.mime;
    var recorderOptions = mimeType ? { mimeType: mimeType } : {};

    try {
      var recorder = new MediaRecorder(currentMediaStream, recorderOptions);
      currentMediaRecorder = recorder;
      var chunkParts = [];

      recorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) {
          chunkParts.push(e.data);
        }
      };

      // By stopping the recorder every 10 seconds, the browser writes container headers,
      // guaranteeing each chunk is a standalone, playable media file!
      recorder.onstop = async function() {
        if (chunkParts.length > 0 && activeSession) {
          var standaloneBlob = new Blob(chunkParts, { type: mimeType });
          try {
            var chunkRecord = await addChunk(standaloneBlob);
            if (chunkRecord) {
              queueUpload(chunkRecord);
            }
          } catch (ex) {}
        }
      };

      // Start without timeslice argument so whole 10s chunk is cleanly packaged on stop()
      recorder.start();

      clearTimeout(chunkIntervalTimer);
      chunkIntervalTimer = setTimeout(function() {
        if (!activeSession || !isUserSosActive()) {
          endSession();
          return;
        }

        // Stopping finalizes the container into a standalone playable chunk
        if (recorder && recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch (e) {}
        }

        // Immediately begin the next 10-second standalone chunk
        recordNextSilentChunk();
      }, 10000);

    } catch (err) {
      endSession();
    }
  }

  // ─── 8c. Visible Audio and Video Recording (Manual & Emergency SOS) ───
  // Uses 480p video at ~400 kbps and standalone 10-second chunks (stop and restart
  // the recorder every 10 seconds), encrypted and hash-chained in IndexedDB.
  // Stopping requires PIN during an active SOS; outside an SOS, stopping is free.
  async function startEmergencySession(alertId) {
    var settings = getSettings();
    if (!settings.enabled || !settings.recordEmergencyVideo) {
      return;
    }
    var granted = await areEmergencyPermissionsGranted();
    if (!granted) {
      return; // Do not ask, do not show anything; skip auto-start
    }
    await startVisibleRecording({ isAudioOnly: false, alertId: alertId });
  }

  function openEvidenceScreen(fromScreen) {
    previousScreenBeforeEvidence = fromScreen || 'profile';
    if (SafeHer.router && SafeHer.router.go) {
      SafeHer.router.go('record-evidence');
    }
    onOpenEvidenceScreen();
  }

  function onOpenEvidenceScreen() {
    updateStorageDisplay();
    updateTimeDisplay();
    updateVisibleRecordingUI(isRecording && activeSession && !activeSession.isSilent);

    var sosNote = document.getElementById('evidence-sos-note');
    if (sosNote) sosNote.style.display = isUserSosActive() ? 'block' : 'none';

    var audioToggle = document.getElementById('evidence-audio-only-toggle');
    if (audioToggle) audioToggle.checked = isAudioOnlyMode;

    if (isRecording && activeSession && !activeSession.isSilent) {
      if (currentMediaStream) {
        bindPreviewStream(currentMediaStream);
      }
    } else {
      startPreviewStream();
    }
  }

  function exitEvidenceScreen() {
    if (!isRecording) {
      stopPreviewStream();
      SafeHer.router.go(previousScreenBeforeEvidence || 'profile');
      return;
    }
    if (isUserSosActive()) {
      SafeHer.router.go(previousScreenBeforeEvidence || 'sos-active');
    } else {
      SafeHer.router.go(previousScreenBeforeEvidence || 'profile');
    }
  }

  async function switchCamera() {
    currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';
    if (isAudioOnlyMode) return;

    if (isRecording && activeSession && !activeSession.isSilent) {
      try {
        if (currentMediaStream) {
          currentMediaStream.getVideoTracks().forEach(function(t) { t.stop(); });
        }
        var newStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: currentFacingMode
          }
        });
        currentMediaStream = newStream;
        bindPreviewStream(newStream);

        if (currentMediaRecorder && currentMediaRecorder.state !== 'inactive') {
          try { currentMediaRecorder.stop(); } catch (e) {}
        }
        recordNextVisibleChunk();
      } catch (e) {}
    } else {
      startPreviewStream();
    }
  }

  function toggleAudioOnly(checked) {
    isAudioOnlyMode = !!checked;
    updateEvidenceUIElements();
    updateTimeDisplay();

    if (isRecording && activeSession && !activeSession.isSilent) {
      activeSession.isAudioOnly = isAudioOnlyMode;
      activeSession.mime = isAudioOnlyMode ? getSupportedAudioMime() : getSupportedVideoMime();
      if (currentMediaRecorder && currentMediaRecorder.state !== 'inactive') {
        try { currentMediaRecorder.stop(); } catch (e) {}
      }
      recordNextVisibleChunk();
    } else {
      startPreviewStream();
    }
  }

  function updateEvidenceUIElements() {
    var videoEl = document.getElementById('evidence-camera-preview');
    var placeholderEl = document.getElementById('evidence-audio-placeholder');
    var switchCamBtn = document.getElementById('evidence-switch-cam-btn');
    var flipOverlayBtn = document.getElementById('evidence-camera-flip-overlay-btn');

    if (isAudioOnlyMode) {
      if (videoEl) videoEl.style.display = 'none';
      if (placeholderEl) placeholderEl.style.display = 'flex';
      if (switchCamBtn) switchCamBtn.style.display = 'none';
      if (flipOverlayBtn) flipOverlayBtn.style.display = 'none';
    } else {
      if (videoEl) videoEl.style.display = 'block';
      if (placeholderEl) placeholderEl.style.display = 'none';
      if (switchCamBtn) switchCamBtn.style.display = 'inline-flex';
      if (flipOverlayBtn) flipOverlayBtn.style.display = 'flex';
    }
  }

  async function startPreviewStream() {
    updateEvidenceUIElements();
    if (isAudioOnlyMode) {
      stopPreviewStream();
      return;
    }

    if (isRecording && currentMediaStream) {
      bindPreviewStream(currentMediaStream);
      return;
    }

    stopPreviewStream();
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: currentFacingMode
        },
        audio: false
      });
      previewMediaStream = stream;
      bindPreviewStream(stream);
    } catch (e) {}
  }

  function stopPreviewStream() {
    if (previewMediaStream) {
      try {
        previewMediaStream.getTracks().forEach(function(t) { t.stop(); });
      } catch (e) {}
      previewMediaStream = null;
    }
    var videoEl = document.getElementById('evidence-camera-preview');
    if (videoEl && !isRecording) {
      videoEl.srcObject = null;
    }
  }

  function bindPreviewStream(stream) {
    var videoEl = document.getElementById('evidence-camera-preview');
    if (videoEl && stream) {
      if (videoEl.srcObject !== stream) {
        videoEl.srcObject = stream;
      }
      videoEl.play().catch(function() {});
    }
  }

  function toggleManualRecording() {
    if (isRecording && activeSession && !activeSession.isSilent) {
      requestStopRecording();
    } else {
      startVisibleRecording({ isAudioOnly: isAudioOnlyMode });
    }
  }

  function requestStopRecording() {
    // Constraint: During an active SOS, stopping requires the PIN; outside an SOS, stopping is free.
    if (isUserSosActive()) {
      if (SafeHer.askPin) {
        SafeHer.askPin(
          function(enteredPin) {
            stopVisibleRecording();
            if (SafeHer.toast) SafeHer.toast('Recording stopped and secured in Vault');
          },
          function() {
            if (SafeHer.toast) SafeHer.toast('Safety PIN required to stop recording during an active SOS');
          }
        );
      } else {
        stopVisibleRecording();
      }
    } else {
      stopVisibleRecording();
      if (SafeHer.toast) SafeHer.toast('Recording stopped and secured in Vault');
    }
  }

  async function startVisibleRecording(opts) {
    opts = opts || {};
    var isAudio = opts.isAudioOnly !== undefined ? opts.isAudioOnly : isAudioOnlyMode;
    var alertId = opts.alertId || (SafeHer.sos && SafeHer.sos.getCurrentAlertId ? SafeHer.sos.getCurrentAlertId() : null);

    if (activeSession) {
      endSession();
    }
    stopPreviewStream();

    var mimeType = isAudio ? getSupportedAudioMime() : getSupportedVideoMime();
    var maxDurationMs = isAudio ? (15 * 60 * 1000) : (3 * 60 * 1000); // 15 mins audio, 3 mins video
    var sessionId = 'vault_vis_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    var sessionRecord = {
      id: sessionId,
      alertId: alertId || null,
      kind: isAudio ? 'audio' : 'video',
      startedAt: new Date().toISOString(),
      endedAt: null,
      mime: mimeType,
      isSilent: false
    };

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
      kind: isAudio ? 'audio' : 'video',
      mime: mimeType,
      currentIndex: 0,
      prevHash: '0'.repeat(64),
      startTime: Date.now(),
      isSilent: false,
      isAudioOnly: isAudio
    };
    isRecording = true;
    visibleSessionSeconds = 0;

    sessionLimitTimer = setTimeout(function() {
      stopVisibleRecording();
      if (SafeHer.toast) SafeHer.toast('Maximum recording duration reached. Evidence secured.');
    }, maxDurationMs);

    // 480p video constraints
    var constraints = isAudio ? { audio: true } : {
      audio: true,
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: currentFacingMode
      }
    };

    try {
      currentMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      bindPreviewStream(currentMediaStream);
    } catch (err) {
      endSession();
      if (SafeHer.toast) SafeHer.toast('Camera / microphone access failed');
      return;
    }

    updateVisibleRecordingUI(true);

    clearInterval(visibleSessionElapsedTimer);
    visibleSessionElapsedTimer = setInterval(function() {
      visibleSessionSeconds++;
      updateTimeDisplay();
    }, 1000);
    updateTimeDisplay();
    updateStorageDisplay();

    recordNextVisibleChunk();
  }

  function recordNextVisibleChunk() {
    if (!activeSession || activeSession.isSilent) {
      return;
    }

    if (!currentMediaStream) {
      endSession();
      return;
    }

    var mimeType = activeSession.mime;
    var isAudio = activeSession.isAudioOnly;

    // Use 480p video at about 400 kbps
    var recorderOptions = {
      mimeType: mimeType
    };
    if (!isAudio) {
      recorderOptions.videoBitsPerSecond = 400000; // ~400 kbps
    }

    try {
      var recorder = new MediaRecorder(currentMediaStream, recorderOptions);
      currentMediaRecorder = recorder;
      var chunkParts = [];

      recorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) {
          chunkParts.push(e.data);
        }
      };

      // By stopping every 10 seconds, each chunk is a standalone, playable media file
      recorder.onstop = async function() {
        if (chunkParts.length > 0 && activeSession) {
          var standaloneBlob = new Blob(chunkParts, { type: mimeType });
          try {
            var chunkRecord = await addChunk(standaloneBlob);
            if (chunkRecord) {
              queueUpload(chunkRecord);
            }
          } catch (ex) {}
        }
      };

      recorder.start();

      clearTimeout(chunkIntervalTimer);
      chunkIntervalTimer = setTimeout(function() {
        if (!activeSession) return;

        if (recorder && recorder.state !== 'inactive') {
          try { recorder.stop(); } catch (e) {}
        }

        recordNextVisibleChunk();
      }, 10000);

    } catch (err) {
      endSession();
    }
  }

  function stopVisibleRecording() {
    clearInterval(visibleSessionElapsedTimer);
    visibleSessionElapsedTimer = null;
    visibleSessionSeconds = 0;

    endSession();
    updateVisibleRecordingUI(false);
    updateTimeDisplay();

    if (document.getElementById('screen-record-evidence') && document.getElementById('screen-record-evidence').classList.contains('active')) {
      startPreviewStream();
    }
  }

  function updateVisibleRecordingUI(recording) {
    var recBadge = document.getElementById('evidence-rec-badge');
    var startStopBtn = document.getElementById('evidence-start-stop-btn');
    var sosNote = document.getElementById('evidence-sos-note');

    if (recBadge) recBadge.style.display = recording ? 'inline-flex' : 'none';
    if (sosNote) sosNote.style.display = (recording && isUserSosActive()) ? 'block' : 'none';

    if (startStopBtn) {
      if (recording) {
        startStopBtn.innerHTML = '<span class="material-symbols-rounded">stop</span>Stop Recording' + (isUserSosActive() ? ' (PIN Required)' : '');
        startStopBtn.style.background = '#374151';
        startStopBtn.style.borderColor = '#374151';
      } else {
        startStopBtn.innerHTML = '<span class="material-symbols-rounded">fiber_manual_record</span>Start Recording';
        startStopBtn.style.background = 'var(--crimson)';
        startStopBtn.style.borderColor = 'var(--crimson)';
      }
    }
  }

  function updateTimeDisplay() {
    var elapsedEl = document.getElementById('evidence-elapsed-timer');
    var remainingEl = document.getElementById('evidence-remaining-time');

    var isAudio = activeSession ? activeSession.isAudioOnly : isAudioOnlyMode;
    var maxSeconds = isAudio ? (15 * 60) : (3 * 60);

    if (isRecording && activeSession && !activeSession.isSilent) {
      var remSeconds = Math.max(0, maxSeconds - visibleSessionSeconds);
      if (elapsedEl) elapsedEl.textContent = formatTimer(visibleSessionSeconds);
      if (remainingEl) remainingEl.textContent = formatTimer(remSeconds) + (isAudio ? ' (Audio max 15m)' : ' (Video max 3m)');
    } else {
      if (elapsedEl) elapsedEl.textContent = '00:00';
      if (remainingEl) remainingEl.textContent = isAudio ? '15:00 (Audio only)' : '03:00 (480p Video)';
    }
  }

  function formatTimer(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updateStorageDisplay() {
    var storageEl = document.getElementById('evidence-storage-info');
    if (!storageEl) return;

    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function(est) {
        var quota = est.quota || 0;
        var usage = est.usage || 0;
        var freeBytes = Math.max(0, quota - usage);
        var freeGb = freeBytes / (1024 * 1024 * 1024);
        var freeMb = freeBytes / (1024 * 1024);
        if (freeGb >= 1.0) {
          storageEl.textContent = freeGb.toFixed(1) + ' GB available';
        } else {
          storageEl.textContent = Math.round(freeMb) + ' MB available';
        }
      }).catch(function() {
        storageEl.textContent = 'Storage info unavailable';
      });
    } else {
      storageEl.textContent = 'Storage info unavailable';
    }
  }

  // ─── 8b. General Session (Emergency Video / Audio) ─────────
  async function startSession(kind, alertId) {
    // If Silent mode is active or silent audio requested, route directly to startSilentSession
    if (kind === 'silent_audio' || (SafeHer.sos && SafeHer.sos.getCurrentMode && SafeHer.sos.getCurrentMode() === 'silent')) {
      return startSilentSession(alertId);
    }

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

    // Warn if storage is low for non-silent sessions
    checkStorageSpace();

    var sessionId = 'vault_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    var sessionRecord = {
      id: sessionId,
      alertId: alertId || null,
      kind: kind,
      startedAt: new Date().toISOString(),
      endedAt: null,
      mime: mimeType,
      isSilent: false
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
      startTime: Date.now(),
      isSilent: false
    };

    // Auto-stop at duration limit
    sessionLimitTimer = setTimeout(function() {
      endSession();
    }, maxDurationMs);

    try {
      var constraints = isVideo ? { audio: true, video: { facingMode: 'user' } } : { audio: true };
      var stream = await navigator.mediaDevices.getUserMedia(constraints);
      currentMediaStream = stream;

      var recorderOptions = mimeType ? { mimeType: mimeType } : {};
      var recorder = new MediaRecorder(stream, recorderOptions);
      currentMediaRecorder = recorder;

      recorder.ondataavailable = async function(e) {
        if (e.data && e.data.size > 0 && activeSession) {
          var record = await addChunk(e.data);
          if (record) queueUpload(record);
        }
      };

      recorder.onerror = function() {
        endSession();
      };

      recorder.start(5000); // 5s timeslice for emergency video
      isRecording = true;
    } catch (err) {
      endSession();
    }
  }

  async function addChunk(blob) {
    if (!activeSession) return null;
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
      return record;
    } catch (e) {
      console.warn('[Vault] Chunk encryption error:', e);
      return null;
    }
  }

  // ─── Upload Queue ──────────────────────────────────────────
  function queueUpload(chunkRecord) {
    if (!chunkRecord) return;
    uploadQueue.push(chunkRecord);
    processUploadQueue();
  }

  async function processUploadQueue() {
    if (isProcessingUploadQueue || uploadQueue.length === 0) return;
    isProcessingUploadQueue = true;
    try {
      while (uploadQueue.length > 0) {
        var chunk = uploadQueue[0];
        if (SafeHer.api && typeof SafeHer.api.uploadEvidenceChunk === 'function') {
          try {
            await SafeHer.api.uploadEvidenceChunk(chunk);
            chunk.uploaded = true;
            getDB(function(err, db) {
              if (!err && db) {
                try {
                  var tx = db.transaction([CHUNKS_STORE], 'readwrite');
                  tx.objectStore(CHUNKS_STORE).put(chunk);
                } catch (e) {}
              }
            });
          } catch (e) {
            break;
          }
        }
        uploadQueue.shift();
      }
    } finally {
      isProcessingUploadQueue = false;
    }
  }

  function endSession() {
    if (sessionLimitTimer) {
      clearTimeout(sessionLimitTimer);
      sessionLimitTimer = null;
    }
    if (chunkIntervalTimer) {
      clearTimeout(chunkIntervalTimer);
      chunkIntervalTimer = null;
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

  // ─── Page Visibility Change ────────────────────────────────
  // If the page becomes hidden and then visible again, restart the recorder seamlessly.
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      if (activeSession && activeSession.isSilent && isUserSosActive()) {
        if (!currentMediaRecorder || currentMediaRecorder.state === 'inactive') {
          clearTimeout(chunkIntervalTimer);
          recordNextSilentChunk();
        }
      }
    }
  });

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
      SafeHer.router.onShow('record-evidence', function() {
        onOpenEvidenceScreen();
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
    startSilentSession: startSilentSession,
    startEmergencySession: startEmergencySession,
    areEmergencyPermissionsGranted: areEmergencyPermissionsGranted,
    openEvidenceScreen: openEvidenceScreen,
    exitEvidenceScreen: exitEvidenceScreen,
    onOpenEvidenceScreen: onOpenEvidenceScreen,
    switchCamera: switchCamera,
    toggleAudioOnly: toggleAudioOnly,
    toggleManualRecording: toggleManualRecording,
    requestStopRecording: requestStopRecording,
    startVisibleRecording: startVisibleRecording,
    stopVisibleRecording: stopVisibleRecording,
    isMicrophonePermissionGranted: isMicrophonePermissionGranted,
    isUserSosActive: isUserSosActive,
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
