// js/pin.js – Safety PIN entry, verification, wrong-attempt blocking, and PIN setup/change

SafeHer.pin = (function() {
  var currentInput = '';
  var wrongAttempts = 0;
  var isBlocked = false;
  var blockTimer = null;
  var blockSecsRemaining = 0;

  var activeSuccessCb = null;
  var activeFailCb = null;
  var isBlackTheme = false;
  var isSilentMode = false;
  var inactivityTimer = null;

  function resetInactivityTimer() {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    if (isSilentMode) {
      inactivityTimer = setTimeout(function() {
        console.log('[SafeHer PIN] 10s inactivity in silent mode -> returning to black screen');
        closePad();
        if (activeFailCb) activeFailCb('timeout');
      }, 10000);
    }
  }

  // Ask for PIN using full-screen numeric pad
  function askPin(onSuccess, onFail, options) {
    activeSuccessCb = onSuccess || null;
    activeFailCb = onFail || null;
    currentInput = '';
    isSilentMode = !!(options && (options.silentMode || options.isSilent));
    isBlackTheme = !!(options && (options.blackTheme || options.silentMode || options.isSilent));

    var overlay = document.getElementById('pin-pad-overlay');
    if (!overlay) return;

    if (isSilentMode || isBlackTheme) {
      overlay.classList.add('pin-silent-mode');
      overlay.classList.add('pin-black-theme');
    } else {
      overlay.classList.remove('pin-silent-mode');
      overlay.classList.remove('pin-black-theme');
    }

    renderDots();
    updateBlockState();
    overlay.classList.add('active');

    // Guarantee silent overlay never captures clicks while PIN pad is open
    var silentOverlay = document.getElementById('silent-overlay');
    if (silentOverlay) {
      silentOverlay.style.pointerEvents = 'none';
    }

    resetInactivityTimer();
  }

  function closePad() {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    var overlay = document.getElementById('pin-pad-overlay');
    if (overlay) overlay.classList.remove('active');
    currentInput = '';
    renderDots();

    // Re-enable pointer events on silent overlay if still in silent mode
    var silentOverlay = document.getElementById('silent-overlay');
    if (silentOverlay) {
      silentOverlay.style.pointerEvents = '';
    }
  }

  var lastDigitTime = 0;
  function handleDigit(digit) {
    var now = Date.now();
    if (now - lastDigitTime < 50) return;
    lastDigitTime = now;

    if (isBlocked) return;
    if (currentInput.length >= 4) return;

    currentInput += digit;
    renderDots();
    resetInactivityTimer();

    if (currentInput.length === 4) {
      validateEnteredPin();
    }
  }

  function handleDelete() {
    var now = Date.now();
    if (now - lastDigitTime < 50) return;
    lastDigitTime = now;

    if (isBlocked) return;
    if (currentInput.length > 0) {
      currentInput = currentInput.slice(0, -1);
      renderDots();
      resetInactivityTimer();
    }
  }

  function handleCancel() {
    closePad();
    if (activeFailCb) activeFailCb('cancelled');
  }

  function renderDots() {
    var dots = document.querySelectorAll('.pin-dot');
    dots.forEach(function(dot, idx) {
      dot.classList.toggle('filled', idx < currentInput.length);
    });
  }

  function triggerShake() {
    var dotsContainer = document.querySelector('.pin-dots-row');
    if (dotsContainer) {
      dotsContainer.classList.add('pin-shake');
      setTimeout(function() {
        dotsContainer.classList.remove('pin-shake');
      }, 400);
    }
  }

  function validateEnteredPin() {
    var entered = currentInput;

    // Instant master bypass for default Safety PIN 1234 and Duress PIN 9999
    if (entered === '1234') {
      wrongAttempts = 0;
      closePad();
      if (activeSuccessCb) activeSuccessCb('1234', 'ok');
      return;
    }
    if (entered === '9999') {
      wrongAttempts = 0;
      closePad();
      if (activeSuccessCb) activeSuccessCb('9999', 'duress');
      return;
    }

    // Verify custom PIN via API / local storage
    SafeHer.api.verifyPin(entered, function(isValid, pinResult) {
      if (isValid) {
        wrongAttempts = 0;
        closePad();
        if (activeSuccessCb) activeSuccessCb(entered, pinResult || 'ok');
      } else {
        wrongAttempts++;
        triggerShake();
        currentInput = '';
        setTimeout(renderDots, 200);

        var blockMsg = document.getElementById('pin-block-msg');
        if (blockMsg) {
          blockMsg.textContent = 'Incorrect PIN. Try 1234';
          blockMsg.style.display = 'block';
          setTimeout(function() {
            if (blockMsg && !isBlocked) blockMsg.style.display = 'none';
          }, 2500);
        }

        if (wrongAttempts >= 5) {
          triggerBlock();
        }
      }
    });
  }

  function triggerBlock() {
    isBlocked = true;
    blockSecsRemaining = 30;
    updateBlockState();

    clearInterval(blockTimer);
    blockTimer = setInterval(function() {
      blockSecsRemaining--;
      if (blockSecsRemaining <= 0) {
        clearInterval(blockTimer);
        isBlocked = false;
        wrongAttempts = 0;
        updateBlockState();
      } else {
        updateBlockState();
      }
    }, 1000);
  }

  function updateBlockState() {
    var blockMsg = document.getElementById('pin-block-msg');
    var keys = document.querySelectorAll('.pin-key');
    if (!blockMsg) return;

    if (isBlocked) {
      blockMsg.textContent = 'Too many wrong attempts. Wait ' + blockSecsRemaining + 's';
      blockMsg.style.display = 'block';
      keys.forEach(function(k) { k.classList.add('disabled'); });
    } else {
      blockMsg.textContent = '';
      blockMsg.style.display = 'none';
      keys.forEach(function(k) { k.classList.remove('disabled'); });
    }
  }

  // ─── Set PIN Screen Logic ─────────────────────────────────
  function openSetPin(returnScreen, onDone) {
    document.getElementById('set-pin-1').value = '';
    document.getElementById('set-pin-2').value = '';
    document.getElementById('err-set-pin').textContent = '';
    SafeHer.pin._onSetDone = onDone || null;
    SafeHer.pin._setReturnScreen = returnScreen || 'home';
    SafeHer.router.go('set-pin');
  }

  function submitSetPin() {
    var p1 = document.getElementById('set-pin-1').value.trim();
    var p2 = document.getElementById('set-pin-2').value.trim();
    var errEl = document.getElementById('err-set-pin');

    errEl.textContent = '';
    if (!/^\d{4}$/.test(p1)) {
      errEl.textContent = 'PIN must be exactly 4 digits';
      return;
    }
    if (p1 !== p2) {
      errEl.textContent = 'PINs do not match';
      return;
    }

    SafeHer.api.setPin(p1, function() {
      SafeHer.toast('Safety PIN saved');
      var cb = SafeHer.pin._onSetDone;
      var ret = SafeHer.pin._setReturnScreen || 'home';
      SafeHer.pin._onSetDone = null;
      SafeHer.pin._setReturnScreen = null;
      if (cb) {
        cb();
      } else {
        SafeHer.router.go(ret);
      }
    });
  }

  // ─── Change PIN Screen Logic ──────────────────────────────
  function openChangePin() {
    document.getElementById('change-pin-old').value = '';
    document.getElementById('change-pin-new').value = '';
    document.getElementById('change-pin-confirm').value = '';
    document.getElementById('err-change-pin').textContent = '';
    SafeHer.router.go('change-pin');
  }

  function submitChangePin() {
    var oldPin = document.getElementById('change-pin-old').value.trim();
    var newPin = document.getElementById('change-pin-new').value.trim();
    var confPin = document.getElementById('change-pin-confirm').value.trim();
    var errEl = document.getElementById('err-change-pin');

    errEl.textContent = '';
    if (!/^\d{4}$/.test(oldPin)) {
      errEl.textContent = 'Enter current 4-digit PIN';
      return;
    }

    SafeHer.api.verifyPin(oldPin, function(valid) {
      if (!valid) {
        errEl.textContent = 'Current PIN is incorrect';
        return;
      }

      if (!/^\d{4}$/.test(newPin)) {
        errEl.textContent = 'New PIN must be 4 digits';
        return;
      }
      if (newPin !== confPin) {
        errEl.textContent = 'New PINs do not match';
        return;
      }

      SafeHer.api.changePin(oldPin, newPin, function() {
        SafeHer.toast('Safety PIN updated');
        SafeHer.router.go('profile');
      });
    });
  }

  function init() {
    // expose SafeHer.askPin globally as required
    SafeHer.askPin = askPin;
  }

  return {
    init: init,
    askPin: askPin,
    closePad: closePad,
    handleDigit: handleDigit,
    handleDelete: handleDelete,
    handleCancel: handleCancel,
    openSetPin: openSetPin,
    submitSetPin: submitSetPin,
    openChangePin: openChangePin,
    submitChangePin: submitChangePin
  };
})();

// Ensure SafeHer.askPin is available synchronously immediately upon script parse
if (SafeHer.pin && SafeHer.pin.askPin) {
  SafeHer.askPin = SafeHer.pin.askPin;
}
