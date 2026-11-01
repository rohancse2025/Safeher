// js/tips.js – Safety Tips and Self-Defense advice tabs

SafeHer.tips = (function() {
  var activeTab = 'tips'; // 'tips' | 'defense'

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function switchTab(tab) {
    activeTab = tab;
    var btnTips = document.getElementById('tab-btn-tips');
    var btnDefense = document.getElementById('tab-btn-defense');

    if (btnTips) btnTips.classList.toggle('active', tab === 'tips');
    if (btnDefense) btnDefense.classList.toggle('active', tab === 'defense');

    render();
  }

  function render() {
    var container = document.getElementById('tips-cards-container');
    if (!container) return;

    var items = SafeHer.api.getTips(activeTab);
    var html = '';

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      html += '<div class="tip-card">' +
        '<div class="tip-card-header">' +
          '<div class="tip-card-icon">' +
            '<span class="material-symbols-rounded">' + escapeHtml(item.icon) + '</span>' +
          '</div>' +
          '<h3 class="tip-card-title">' + escapeHtml(item.title) + '</h3>' +
        '</div>' +
        '<div class="tip-card-body">';

      for (var j = 0; j < item.lines.length; j++) {
        html += '<p class="tip-card-text">' + escapeHtml(item.lines[j]) + '</p>';
      }

      html += '</div></div>';
    }

    container.innerHTML = html;
  }

  function init() {
    SafeHer.router.onShow('tips', function() {
      render();
    });
  }

  return {
    init: init,
    switchTab: switchTab,
    render: render
  };
})();
