// js/auth.js – welcome, register, otp verify, signup-success, login screens
// Real OTP sending and authentication will come from the backend API.
// Currently uses localStorage (via api.js) for demo purposes.

SafeHer.auth = (function() {
  var pendingUser  = null;   // holds registration data until OTP is verified
  var resendTimer  = null;

  // ─── Navigation ───────────────────────────────────────────
  function showRegister() { SafeHer.router.go('register'); }
  function showLogin()    { SafeHer.router.go('login');    }

  // ─── Error helpers ─────────────────────────────────────────
  function setErr(id, msg) {
    var el = document.getElementById(id);
    if (el) el.textContent = msg;
  }
  function clearErrs(ids) {
    ids.forEach(function(id) { setErr(id, ''); });
  }

  // ─── Register ─────────────────────────────────────────────
  function submitRegister() {
    var name    = document.getElementById('reg-name').value.trim();
    var phone   = document.getElementById('reg-phone').value.trim();
    var email   = document.getElementById('reg-email').value.trim();
    var pass    = document.getElementById('reg-pass').value;
    var confirm = document.getElementById('reg-confirm').value;

    clearErrs(['err-name','err-phone','err-email','err-pass','err-confirm']);
    var ok = true;

    if (!name) {
      setErr('err-name', 'Name is required'); ok = false;
    }
    if (!phone) {
      setErr('err-phone', 'Phone is required'); ok = false;
    } else if (!/^\d{10}$/.test(phone)) {
      setErr('err-phone', 'Enter a valid 10-digit number'); ok = false;
    }
    if (!email) {
      setErr('err-email', 'Email is required'); ok = false;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErr('err-email', 'Enter a valid email'); ok = false;
    }
    if (!pass) {
      setErr('err-pass', 'Password is required'); ok = false;
    } else if (pass.length < 6) {
      setErr('err-pass', 'At least 6 characters required'); ok = false;
    }
    if (!confirm) {
      setErr('err-confirm', 'Please confirm your password'); ok = false;
    } else if (pass !== confirm) {
      setErr('err-confirm', 'Passwords do not match'); ok = false;
    }
    if (!ok) return;

    if (SafeHer.api.findUserByPhone(phone)) {
      setErr('err-phone', 'This number is already registered');
      return;
    }

    pendingUser = { name: name, phone: phone, email: email, password: pass };

    // POST /api/auth/send-otp  →  will trigger real SMS from backend
    SafeHer.api.sendOTP(phone);

    var hint = document.getElementById('otp-phone-hint');
    if (hint) hint.textContent = 'Code sent to +91 ' + phone.slice(0, 5) + 'XXXXX';

    clearOTPBoxes();
    startOTPTimer();
    SafeHer.router.go('verify-otp');
    focusFirstOTP();
  }

  // ─── OTP ──────────────────────────────────────────────────
  function clearOTPBoxes() {
    document.querySelectorAll('.otp-box').forEach(function(b) { b.value = ''; });
  }

  function focusFirstOTP() {
    var first = document.querySelector('.otp-box');
    if (first) setTimeout(function() { first.focus(); }, 350);
  }

  function startOTPTimer() {
    clearInterval(resendTimer);
    var secs      = 30;
    var timerEl   = document.getElementById('otp-timer-text');
    var resendBtn = document.getElementById('otp-resend-btn');

    if (timerEl)   { timerEl.textContent = 'Resend OTP in ' + secs + 's'; timerEl.style.display = 'inline'; }
    if (resendBtn) resendBtn.style.display = 'none';

    resendTimer = setInterval(function() {
      secs--;
      if (secs > 0) {
        if (timerEl) timerEl.textContent = 'Resend OTP in ' + secs + 's';
      } else {
        clearInterval(resendTimer);
        if (timerEl)   timerEl.style.display   = 'none';
        if (resendBtn) resendBtn.style.display  = 'inline';
      }
    }, 1000);
  }

  function resendOTP() {
    // POST /api/auth/send-otp  →  backend resends the SMS
    clearOTPBoxes();
    focusFirstOTP();
    startOTPTimer();
    SafeHer.toast('OTP resent');
  }

  function submitOTP() {
    var boxes = document.querySelectorAll('.otp-box');
    var otp   = '';
    boxes.forEach(function(b) { otp += b.value; });

    setErr('err-otp', '');
    if (!/^\d{4}$/.test(otp)) {
      setErr('err-otp', 'Enter the 4-digit code');
      return;
    }

    // POST /api/auth/verify-otp  →  real verification on backend
    // Demo: any 4 digits are accepted
    if (!pendingUser) {
      SafeHer.toast('Session expired. Please register again.');
      SafeHer.router.go('register');
      return;
    }

    SafeHer.api.registerUser(pendingUser);
    pendingUser = null;
    clearInterval(resendTimer);
    SafeHer.router.go('signup-success');
  }

  // ─── Signup success ────────────────────────────────────────
  function continueAfterSignup() {
    SafeHer.router.go('home');
  }

  // ─── Login ────────────────────────────────────────────────
  function submitLogin() {
    var phone = document.getElementById('login-phone').value.trim();
    var pass  = document.getElementById('login-pass').value;

    clearErrs(['err-login-phone', 'err-login-pass', 'err-login']);
    var ok = true;

    if (!phone) {
      setErr('err-login-phone', 'Phone is required'); ok = false;
    } else if (!/^\d{10}$/.test(phone)) {
      setErr('err-login-phone', 'Enter a valid 10-digit number'); ok = false;
    }
    if (!pass) {
      setErr('err-login-pass', 'Password is required'); ok = false;
    }
    if (!ok) return;

    // POST /api/auth/login  →  backend returns JWT on success
    var user = SafeHer.api.loginUser(phone, pass);
    if (!user) {
      setErr('err-login', 'Incorrect phone number or password');
      return;
    }
    SafeHer.router.go('home');
  }

  // ─── Logout ───────────────────────────────────────────────
  function logout() {
    SafeHer.api.clearUser();
    SafeHer.router.go('auth');
  }

  // ─── OTP input wiring ─────────────────────────────────────
  function wireOTPBoxes() {
    var boxes = document.querySelectorAll('.otp-box');

    boxes.forEach(function(box, i) {
      // Allow only one digit; auto-advance
      box.addEventListener('input', function() {
        this.value = this.value.replace(/\D/g, '').slice(0, 1);
        if (this.value && i < boxes.length - 1) boxes[i + 1].focus();
      });

      // Backspace goes back
      box.addEventListener('keydown', function(e) {
        if (e.key === 'Backspace' && !this.value && i > 0) boxes[i - 1].focus();
      });

      // Paste handler (works on any box)
      box.addEventListener('paste', function(e) {
        e.preventDefault();
        var raw    = (e.clipboardData || window.clipboardData).getData('text');
        var digits = raw.replace(/\D/g, '').slice(0, 4);
        boxes.forEach(function(b, j) { b.value = digits[j] || ''; });
        var last = Math.min(digits.length, boxes.length - 1);
        boxes[last].focus();
      });
    });
  }

  function init() {
    wireOTPBoxes();
  }

  return {
    showRegister:       showRegister,
    showLogin:          showLogin,
    submitRegister:     submitRegister,
    submitOTP:          submitOTP,
    resendOTP:          resendOTP,
    continueAfterSignup: continueAfterSignup,
    submitLogin:        submitLogin,
    logout:             logout,
    init:               init
  };
})();
