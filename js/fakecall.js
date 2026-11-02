// js/fakecall.js – Realistic full-screen fake incoming call with Web Audio API ringtone and vibration

SafeHer.fakecall = (function() {
  var delayTimer = null;
  var callTimer = null;
  var callDuration = 0;
  var audioCtx = null;
  var ringInterval = null;
  var isRinging = false;
  var selectedDelay = 0; // 0 (now), 10, 30

  // ─── Web Audio API Ringtone (No audio files used) ─────────
  function startRingtone() {
    stopRingtone();
    try {
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      audioCtx = new AudioContext();

      isRinging = true;

      function playRingBurst() {
        if (!isRinging || !audioCtx) return;

        // Realistic dual-tone telephone frequency (440Hz + 480Hz)
        var osc1 = audioCtx.createOscillator();
        var osc2 = audioCtx.createOscillator();
        var gain = audioCtx.createGain();

        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(440, audioCtx.currentTime);

        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(480, audioCtx.currentTime);

        gain.gain.setValueAtTime(0, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + 0.05);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime + 1.8);
        gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 1.95);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(audioCtx.destination);

        osc1.start(audioCtx.currentTime);
        osc2.start(audioCtx.currentTime);
        osc1.stop(audioCtx.currentTime + 2.0);
        osc2.stop(audioCtx.currentTime + 2.0);
      }

      playRingBurst();
      ringInterval = setInterval(playRingBurst, 3500);

      // Repeating vibration
      if ('vibrate' in navigator) {
        navigator.vibrate([1000, 800, 1000, 800]);
      }
    } catch (e) {
      console.warn('Web Audio fake ring failed:', e);
    }
  }

  function stopRingtone() {
    isRinging = false;
    if (ringInterval) {
      clearInterval(ringInterval);
      ringInterval = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch(e) {}
      audioCtx = null;
    }
    if ('vibrate' in navigator) {
      navigator.vibrate(0);
    }
  }

  function setDelay(seconds) {
    selectedDelay = seconds;
    var chips = document.querySelectorAll('.fakecall-delay-chip');
    chips.forEach(function(c) {
      var s = parseInt(c.dataset.delay, 10);
      c.classList.toggle('active', s === seconds);
    });
  }

  function setPresetCaller(name) {
    var input = document.getElementById('fakecall-name-input');
    if (input) input.value = name;

    var chips = document.querySelectorAll('.fakecall-caller-chip');
    chips.forEach(function(c) {
      c.classList.toggle('active', c.textContent.trim() === name);
    });
  }

  function scheduleCall() {
    var input = document.getElementById('fakecall-name-input');
    var callerName = (input && input.value.trim()) ? input.value.trim() : 'Mom';

    if (delayTimer) {
      clearTimeout(delayTimer);
      delayTimer = null;
    }

    if (selectedDelay === 0) {
      triggerIncomingCall(callerName);
    } else {
      SafeHer.toast('Fake call scheduled in ' + selectedDelay + ' seconds');
      SafeHer.router.go('home');

      delayTimer = setTimeout(function() {
        triggerIncomingCall(callerName);
      }, selectedDelay * 1000);
    }
  }

  function triggerIncomingCall(callerName) {
    var name = callerName || 'Mom';
    var nameEls = document.querySelectorAll('.fakecall-caller-display');
    nameEls.forEach(function(el) { el.textContent = name; });

    var avatarEl = document.getElementById('fakecall-avatar-letter');
    if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase();

    // Switch views
    var setupEl = document.getElementById('fakecall-setup-view');
    var incomingEl = document.getElementById('fakecall-incoming-view');
    var connectedEl = document.getElementById('fakecall-connected-view');

    if (setupEl) setupEl.style.display = 'none';
    if (connectedEl) connectedEl.style.display = 'none';
    if (incomingEl) incomingEl.style.display = 'flex';

    SafeHer.router.go('fake-call');
    startRingtone();
  }

  function acceptCall() {
    stopRingtone();

    var incomingEl = document.getElementById('fakecall-incoming-view');
    var connectedEl = document.getElementById('fakecall-connected-view');

    if (incomingEl) incomingEl.style.display = 'none';
    if (connectedEl) connectedEl.style.display = 'flex';

    callDuration = 0;
    var durEl = document.getElementById('fakecall-duration-text');
    if (durEl) durEl.textContent = '00:00';

    clearInterval(callTimer);
    callTimer = setInterval(function() {
      callDuration++;
      var mm = Math.floor(callDuration / 60);
      var ss = callDuration % 60;
      if (durEl) {
        durEl.textContent = (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
      }
    }, 1000);
  }

  function declineCall() {
    endCall();
  }

  function endCall() {
    stopRingtone();
    if (delayTimer) {
      clearTimeout(delayTimer);
      delayTimer = null;
    }
    if (callTimer) {
      clearInterval(callTimer);
      callTimer = null;
    }
    callDuration = 0;

    resetViews();
    SafeHer.router.go('home');
  }

  function resetViews() {
    var setupEl = document.getElementById('fakecall-setup-view');
    var incomingEl = document.getElementById('fakecall-incoming-view');
    var connectedEl = document.getElementById('fakecall-connected-view');

    if (setupEl) setupEl.style.display = 'block';
    if (incomingEl) incomingEl.style.display = 'none';
    if (connectedEl) connectedEl.style.display = 'none';
  }

  function init() {
    SafeHer.router.onShow('fake-call', function() {
      // If not currently in a call, show setup
      var incomingEl = document.getElementById('fakecall-incoming-view');
      var connectedEl = document.getElementById('fakecall-connected-view');
      var isCallActive = (incomingEl && incomingEl.style.display === 'flex') ||
                         (connectedEl && connectedEl.style.display === 'flex');
      if (!isCallActive) {
        resetViews();
      }
    });
  }

  return {
    init: init,
    setDelay: setDelay,
    setPresetCaller: setPresetCaller,
    scheduleCall: scheduleCall,
    acceptCall: acceptCall,
    declineCall: declineCall,
    endCall: endCall
  };
})();
