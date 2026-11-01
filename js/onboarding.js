// js/onboarding.js – 3-slide onboarding with dot indicators and swipe support

SafeHer.onboarding = (function() {
  var current = 0;
  var total   = 3;
  var touchStartX = 0;

  function goTo(idx) {
    current = idx;

    // Slide the strip
    var slider = document.getElementById('onboard-slider');
    if (slider) slider.style.transform = 'translateX(-' + (100 / total * idx) + '%)';

    // Dots
    document.querySelectorAll('.onboard-dot').forEach(function(d, i) {
      d.classList.toggle('active', i === idx);
    });

    // Button label
    var btn = document.getElementById('onboard-btn');
    if (btn) btn.textContent = idx === total - 1 ? 'Get Started' : 'Next';

    // Hide Skip on last slide
    var skipBtn = document.getElementById('onboard-skip');
    if (skipBtn) skipBtn.style.visibility = idx === total - 1 ? 'hidden' : 'visible';
  }

  function next() {
    if (current < total - 1) {
      goTo(current + 1);
    } else {
      finish();
    }
  }

  function finish() {
    SafeHer.api.markOnboardingDone();
    SafeHer.router.go('auth');
  }

  function init() {
    // Next / Get Started button
    var btn = document.getElementById('onboard-btn');
    if (btn) btn.addEventListener('click', next);

    // Skip button
    var skipBtn = document.getElementById('onboard-skip');
    if (skipBtn) skipBtn.addEventListener('click', finish);

    // Dot clicks
    document.querySelectorAll('.onboard-dot').forEach(function(d, i) {
      d.addEventListener('click', function() { goTo(i); });
    });

    // Touch swipe
    var slider = document.getElementById('onboard-slider');
    if (slider) {
      slider.addEventListener('touchstart', function(e) {
        touchStartX = e.touches[0].clientX;
      }, { passive: true });

      slider.addEventListener('touchend', function(e) {
        var dx = e.changedTouches[0].clientX - touchStartX;
        if (dx < -50 && current < total - 1) goTo(current + 1);
        if (dx >  50 && current > 0)         goTo(current - 1);
      }, { passive: true });
    }

    goTo(0);
  }

  return { init: init };
})();
