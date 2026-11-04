// js/help_rights.js – Help & Rights screen: Helplines, Laws, File FIR, Tools, and "What happened?" Guide
// Powered strictly by js/helpdata.js

SafeHer.helpRights = (function() {

  var currentTab = 'helplines'; // 'helplines' | 'laws' | 'fir' | 'tools'
  var activeCategory = 'All';
  var helplineSearchQuery = '';
  var lawsSearchQuery = '';
  var expandedLaws = {};
  var activeScenarioId = null;

  // ─── 7 Pre-defined "What Happened?" Scenarios ──────────────────
  var SCENARIOS = [
    {
      id: 'stalking',
      title: 'Being followed or stalked',
      icon: 'directions_walk',
      whatToDo: [
        'Move immediately towards a crowded, well-lit public place or open commercial store.',
        'Avoid quiet streets, unlit shortcuts, or heading directly to an empty home.',
        'Call a trusted contact or helpline to stay on the call and share your live location.'
      ],
      helplineNames: ['Emergency Response', 'Police', 'Women Helpline', 'Women in Distress'],
      bnsSections: ['78', '74'],
      whereToReport: 'Any Police Station or register a Zero FIR at the nearest police station regardless of jurisdiction.',
      complaintType: 'Being followed or stalked'
    },
    {
      id: 'street',
      title: 'Street harassment',
      icon: 'campaign',
      whatToDo: [
        'Prioritize getting to a safe, occupied spot; ask shopkeepers or bystanders for help.',
        'Speak firmly and loudly to attract public attention if it is safe to do so.',
        'Note down the person\'s description, vehicle number, and exact landmark as soon as you are safe.'
      ],
      helplineNames: ['Emergency Response', 'Police', 'Women Helpline'],
      bnsSections: ['74', '75', '79'],
      whereToReport: 'Nearest Police Station or any convenient station via Zero FIR (Section 173 BNSS).',
      complaintType: 'Street harassment'
    },
    {
      id: 'workplace',
      title: 'Harassment at workplace',
      icon: 'business_center',
      whatToDo: [
        'Document every occurrence with exact dates, times, messages, and names of any witnesses.',
        'State clearly in writing that the behavior is unwelcome, if you feel safe doing so.',
        'Speak with a trusted HR representative or colleague to maintain an independent record.'
      ],
      helplineNames: ['NCW Women Helpline', 'Women Helpline', 'Legal Aid (NALSA)', 'Workplace harassment portal SHe-Box'],
      bnsSections: ['75'],
      otherLawTitles: ['POSH Act 2013'],
      whereToReport: 'SHe-Box portal (shebox.nic.in) and the Internal Complaints Committee (ICC) of your organization, or the District Local Complaints Committee (LCC). Police station for physical assault.',
      complaintType: 'Harassment at workplace'
    },
    {
      id: 'domestic',
      title: 'Domestic violence or dowry harassment',
      icon: 'home',
      whatToDo: [
        'If facing violence, move to a safe room or exit to neighbors or public safety immediately.',
        'Keep essential identification, phone, money, and medical records easily accessible.',
        'Contact a helpline or trusted person to explore shelter, medical care, and legal support.'
      ],
      helplineNames: ['Women Helpline', 'NCW Women Helpline', 'Women in Distress', 'Legal Aid (NALSA)', 'Emergency Response'],
      bnsSections: ['85-86', '80'],
      otherLawTitles: ['Protection of Women from Domestic Violence Act 2005', 'Dowry Prohibition Act 1961'],
      whereToReport: 'Nearest Police Station, District Protection Officer, or Magistrate under the Domestic Violence Act. Free legal assistance via Legal Aid (NALSA 15100).',
      complaintType: 'Domestic violence or dowry harassment'
    },
    {
      id: 'assault',
      title: 'Sexual assault',
      icon: 'warning',
      whatToDo: [
        'Move to a safe location immediately and contact someone you trust or call 112.',
        'Avoid bathing, changing clothes, or combing hair before medical examination to preserve forensic evidence.',
        'Seek immediate medical care at a hospital for necessary treatment, medication, and an MLC examination report.'
      ],
      helplineNames: ['Emergency Response', 'Women Helpline', 'Ambulance', 'Legal Aid (NALSA)', 'NCW Women Helpline'],
      bnsSections: ['63-70', '76'],
      whereToReport: 'Any hospital (mandated by law to provide free medical aid) and any Police Station via Zero FIR. Statement recorded by a woman police officer (BNSS Section 173).',
      complaintType: 'Sexual assault'
    },
    {
      id: 'online',
      title: 'Online harassment or morphed images',
      icon: 'phonelink_lock',
      whatToDo: [
        'Take full screenshots capturing URLs, usernames, phone numbers, timestamps, and message text.',
        'Do not delete chat logs, emails, or call records, as they serve as primary digital evidence.',
        'Block the harasser and report the abusive content through the platform\'s safety reporting tool.'
      ],
      helplineNames: ['Cyber Crime Helpline', 'NCW Women Helpline', 'Women Helpline'],
      bnsSections: ['77', '78', '79'],
      whereToReport: 'National Cyber Crime Reporting Portal at cybercrime.gov.in (offers anonymous reporting). Local Cyber Crime Cell or any Police Station via e-FIR / Zero FIR.',
      complaintType: 'Online harassment or morphed images'
    },
    {
      id: 'acid',
      title: 'Acid attack',
      icon: 'medical_services',
      whatToDo: [
        'Immediately rinse the affected skin with continuous running clean water for 20-30 minutes.',
        'Do not apply oils, ointments, or attempt chemical neutralization; gently remove non-adherent clothing.',
        'Call 102 or 112 immediately for emergency medical transport to the nearest hospital.'
      ],
      helplineNames: ['Emergency Response', 'Ambulance', 'Police', 'Legal Aid (NALSA)'],
      bnsSections: ['124'],
      whereToReport: 'Nearest Hospital (mandated by law to provide free immediate medical treatment) and Police Station via Zero FIR.',
      complaintType: 'Acid attack'
    }
  ];

  // ─── Data Access Helpers ─────────────────────────────────────
  function getHelplines() {
    return (window.SafeHer && window.SafeHer.helpdata && window.SafeHer.helpdata.HELPLINES) ||
           window.HELPLINES || [];
  }

  function getLaws() {
    return (window.SafeHer && window.SafeHer.helpdata && window.SafeHer.helpdata.LAWS) ||
           window.LAWS || [];
  }

  function getOtherLaws() {
    return (window.SafeHer && window.SafeHer.helpdata && window.SafeHer.helpdata.OTHER_LAWS) ||
           window.OTHER_LAWS || [];
  }

  function getFirRights() {
    return (window.SafeHer && window.SafeHer.helpdata && window.SafeHer.helpdata.FIR_RIGHTS) ||
           window.FIR_RIGHTS || [];
  }

  function getDisclaimer() {
    return (window.SafeHer && window.SafeHer.helpdata && window.SafeHer.helpdata.DISCLAIMER_TEXT) ||
           window.DISCLAIMER_TEXT ||
           'General information, not legal advice. Laws and numbers can change. Last checked: November 2026. If you are in danger, call 112.';
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function copyText(text, label) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        if (SafeHer.toast) SafeHer.toast('Copied ' + (label || text));
      }).catch(function() {
        fallbackCopy(text, label);
      });
    } else {
      fallbackCopy(text, label);
    }
  }

  function fallbackCopy(text, label) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      if (SafeHer.toast) SafeHer.toast('Copied ' + (label || text));
    } catch (e) {
      if (SafeHer.toast) SafeHer.toast('Unable to copy');
    }
    document.body.removeChild(ta);
  }

  // ─── Tab Switching ───────────────────────────────────────────
  function switchTab(tabId) {
    currentTab = tabId;
    var tabs = ['helplines', 'laws', 'fir', 'tools'];
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var btn = document.getElementById('hr-tab-btn-' + t);
      var pane = document.getElementById('hr-tab-pane-' + t);
      if (btn) btn.classList.toggle('active', t === tabId);
      if (pane) pane.style.display = (t === tabId) ? 'block' : 'none';
    }
  }

  // ─── Helplines Tab Logic ─────────────────────────────────────
  function setCategory(cat) {
    activeCategory = cat;
    var chips = document.querySelectorAll('.hr-category-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].getAttribute('data-category') === cat);
    }
    renderHelplinesList();
  }

  function setHelplineSearch(query) {
    helplineSearchQuery = (query || '').trim().toLowerCase();
    renderHelplinesList();
  }

  function renderHelplinesList() {
    var container = document.getElementById('hr-helplines-list');
    if (!container) return;

    var all = getHelplines();
    var filtered = all.filter(function(item) {
      if (activeCategory !== 'All' && item.category !== activeCategory) {
        return false;
      }
      if (helplineSearchQuery) {
        var matchName = item.name.toLowerCase().indexOf(helplineSearchQuery) !== -1;
        var matchNum = (item.number || '').toLowerCase().indexOf(helplineSearchQuery) !== -1;
        var matchNote = (item.note || '').toLowerCase().indexOf(helplineSearchQuery) !== -1;
        var matchCat = (item.category || '').toLowerCase().indexOf(helplineSearchQuery) !== -1;
        if (!matchName && !matchNum && !matchNote && !matchCat) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="hr-empty-box"><p>No helplines found.</p></div>';
      return;
    }

    // Group alphabetically by first letter of name
    var groups = {};
    for (var i = 0; i < filtered.length; i++) {
      var item = filtered[i];
      var letter = (item.name.charAt(0) || '#').toUpperCase();
      if (!groups[letter]) groups[letter] = [];
      groups[letter].push(item);
    }

    var sortedLetters = Object.keys(groups).sort();
    var html = '';

    for (var l = 0; l < sortedLetters.length; l++) {
      var letter = sortedLetters[l];
      var list = groups[letter];
      html += '<div class="hr-letter-group">';
      html += '<div class="hr-sticky-letter">' + escapeHtml(letter) + '</div>';

      for (var k = 0; k < list.length; k++) {
        var h = list[k];
        html += renderHelplineRow(h);
      }
      html += '</div>';
    }

    container.innerHTML = html;
  }

  function renderHelplineRow(item) {
    var isWebsiteOnly = !item.number;
    var webUrl = '';
    if (item.name.indexOf('SHe-Box') !== -1 || (item.note && item.note.indexOf('shebox.nic.in') !== -1)) {
      webUrl = 'https://shebox.nic.in';
    } else if (item.note && item.note.indexOf('cybercrime.gov.in') !== -1) {
      webUrl = 'https://cybercrime.gov.in';
    }

    var html = '<div class="hr-item-row">';
    html += '<div class="hr-item-main">';
    html += '<div class="hr-item-header">';
    html += '<span class="hr-item-name">' + escapeHtml(item.name) + '</span>';
    html += '<span class="hr-cat-badge">' + escapeHtml(item.category) + '</span>';
    html += '</div>';

    if (item.number) {
      html += '<div class="hr-item-num">' + escapeHtml(item.number) + '</div>';
    } else {
      html += '<div class="hr-item-num hr-num-web">Website portal only</div>';
    }

    if (item.note) {
      html += '<div class="hr-item-note">' + escapeHtml(item.note) + '</div>';
    }
    html += '</div>'; // /.hr-item-main

    // Actions
    html += '<div class="hr-item-actions">';
    if (item.number) {
      html += '<a class="hr-action-btn hr-call-btn" href="tel:' + escapeHtml(item.number) + '" aria-label="Call ' + escapeHtml(item.number) + '">';
      html += '<span class="material-symbols-rounded">call</span><span>Call</span></a>';

      html += '<button type="button" class="hr-action-btn hr-copy-btn" onclick="SafeHer.helpRights.copyText(\'' + escapeHtml(item.number) + '\', \'number\')" aria-label="Copy ' + escapeHtml(item.number) + '">';
      html += '<span class="material-symbols-rounded">content_copy</span><span>Copy</span></button>';
    }

    if (webUrl) {
      html += '<a class="hr-action-btn hr-open-btn" href="' + escapeHtml(webUrl) + '" target="_blank" rel="noopener noreferrer" aria-label="Open ' + escapeHtml(item.name) + '">';
      html += '<span class="material-symbols-rounded">open_in_new</span><span>Open</span></a>';

      if (!item.number) {
        html += '<button type="button" class="hr-action-btn hr-copy-btn" onclick="SafeHer.helpRights.copyText(\'' + escapeHtml(webUrl) + '\', \'portal link\')" aria-label="Copy portal URL">';
        html += '<span class="material-symbols-rounded">content_copy</span><span>Copy</span></button>';
      }
    }
    html += '</div>'; // /.hr-item-actions

    html += '</div>'; // /.hr-item-row
    return html;
  }

  // ─── Laws Tab Logic ──────────────────────────────────────────
  function setLawsSearch(query) {
    lawsSearchQuery = (query || '').trim().toLowerCase();
    renderLawsList();
  }

  function toggleLawExpand(index) {
    expandedLaws[index] = !expandedLaws[index];
    renderLawsList();
  }

  function renderLawsList() {
    var container = document.getElementById('hr-laws-list');
    var otherContainer = document.getElementById('hr-other-laws-list');
    if (!container) return;

    var allLaws = getLaws();
    var filtered = allLaws.filter(function(law) {
      if (!lawsSearchQuery) return true;
      var matchBns = (law.bns_section || '').toLowerCase().indexOf(lawsSearchQuery) !== -1;
      var matchIpc = (law.old_ipc || '').toLowerCase().indexOf(lawsSearchQuery) !== -1;
      var matchTitle = (law.title || '').toLowerCase().indexOf(lawsSearchQuery) !== -1;
      var matchMean = (law.meaning || '').toLowerCase().indexOf(lawsSearchQuery) !== -1;
      return matchBns || matchIpc || matchTitle || matchMean;
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="hr-empty-box"><p>No laws matching search.</p></div>';
    } else {
      var html = '';
      for (var i = 0; i < filtered.length; i++) {
        var law = filtered[i];
        var isExpanded = !!expandedLaws[i];
        html += '<div class="hr-law-card ' + (isExpanded ? 'expanded' : '') + '" onclick="SafeHer.helpRights.toggleLawExpand(' + i + ')">';
        html += '<div class="hr-law-header">';
        html += '<div class="hr-law-tags">';
        html += '<span class="hr-bns-tag">BNS ' + escapeHtml(law.bns_section) + '</span>';
        html += '<span class="hr-ipc-tag">old IPC ' + escapeHtml(law.old_ipc) + '</span>';
        html += '</div>';
        html += '<span class="material-symbols-rounded hr-expand-icon">' + (isExpanded ? 'expand_less' : 'expand_more') + '</span>';
        html += '</div>';

        html += '<h4 class="hr-law-title">' + escapeHtml(law.title) + '</h4>';
        html += '<p class="hr-law-meaning">' + escapeHtml(law.meaning) + '</p>';

        if (isExpanded) {
          html += '<div class="hr-law-details">';
          html += '<p class="hr-law-source"><strong>Source:</strong> ' + escapeHtml(law.source_note || 'Bharatiya Nyaya Sanhita (BNS)') + '</p>';
          html += '<p class="hr-law-checked"><strong>Status:</strong> Valid as of ' + escapeHtml(law.last_checked || 'November 2026') + '</p>';
          html += '</div>';
        }

        html += '</div>'; // /.hr-law-card
      }
      container.innerHTML = html;
    }

    // Render Other Laws
    if (otherContainer) {
      var otherList = getOtherLaws();
      var otherHtml = '';
      for (var j = 0; j < otherList.length; j++) {
        var ol = otherList[j];
        otherHtml += '<div class="hr-other-law-card">';
        otherHtml += '<div class="hr-other-law-title">' + escapeHtml(ol.title) + '</div>';
        if (ol.note || ol.meaning) {
          otherHtml += '<p class="hr-other-law-desc">' + escapeHtml(ol.note || ol.meaning) + '</p>';
        }
        otherHtml += '</div>';
      }
      otherContainer.innerHTML = otherHtml;
    }
  }

  // ─── File FIR Tab Logic ──────────────────────────────────────
  function renderFirTab() {
    var container = document.getElementById('hr-fir-stepper');
    if (!container) return;

    var rights = getFirRights();
    var html = '';

    for (var i = 0; i < rights.length; i++) {
      var r = rights[i];
      html += '<div class="hr-step-item">';
      html += '<div class="hr-step-num-wrap">';
      html += '<div class="hr-step-number">' + (r.point || (i + 1)) + '</div>';
      if (i < rights.length - 1) {
        html += '<div class="hr-step-line"></div>';
      }
      html += '</div>';

      html += '<div class="hr-step-content">';
      html += '<p class="hr-step-text">' + escapeHtml(r.text) + '</p>';
      html += '</div>';
      html += '</div>'; // /.hr-step-item
    }

    container.innerHTML = html;
  }

  // ─── "What Happened?" Interactive Guide Logic ───────────────
  function openScenario(scenarioId) {
    activeScenarioId = scenarioId;
    renderScenarioDetail();
    var modal = document.getElementById('hr-scenario-modal');
    if (modal) {
      modal.style.display = 'block';
      modal.setAttribute('aria-hidden', 'false');
    }
  }

  function closeScenario() {
    activeScenarioId = null;
    var modal = document.getElementById('hr-scenario-modal');
    if (modal) {
      modal.style.display = 'none';
      modal.setAttribute('aria-hidden', 'true');
    }
  }

  function renderScenarioDetail() {
    var container = document.getElementById('hr-scenario-detail-wrap');
    if (!container || !activeScenarioId) return;

    var sc = null;
    for (var i = 0; i < SCENARIOS.length; i++) {
      if (SCENARIOS[i].id === activeScenarioId) {
        sc = SCENARIOS[i];
        break;
      }
    }
    if (!sc) return;

    var allHelplines = getHelplines();
    var matchedHelplines = allHelplines.filter(function(h) {
      return sc.helplineNames.indexOf(h.name) !== -1;
    });

    var allLaws = getLaws();
    var matchedLaws = allLaws.filter(function(l) {
      return sc.bnsSections.indexOf(l.bns_section) !== -1;
    });

    var allOther = getOtherLaws();
    var matchedOther = allOther.filter(function(o) {
      return sc.otherLawTitles && sc.otherLawTitles.indexOf(o.title) !== -1;
    });

    var html = '';
    html += '<div class="hr-guide-header">';
    html += '<span class="material-symbols-rounded hr-guide-icon">' + escapeHtml(sc.icon) + '</span>';
    html += '<div class="hr-guide-title-box">';
    html += '<h3 class="hr-guide-title">' + escapeHtml(sc.title) + '</h3>';
    html += '<p class="hr-guide-subtitle">Immediate emergency instructions & legal remedies</p>';
    html += '</div>';
    html += '</div>';

    // (1) What to do right now
    html += '<div class="hr-guide-section">';
    html += '<h4 class="hr-guide-section-title"><span class="material-symbols-rounded">flash_on</span> 1. What to do right now</h4>';
    html += '<ul class="hr-guide-bullets">';
    for (var j = 0; j < sc.whatToDo.length; j++) {
      html += '<li>' + escapeHtml(sc.whatToDo[j]) + '</li>';
    }
    html += '</ul>';
    html += '</div>';

    // (2) Helplines to call
    html += '<div class="hr-guide-section">';
    html += '<h4 class="hr-guide-section-title"><span class="material-symbols-rounded">phone_in_talk</span> 2. Helplines to call</h4>';
    html += '<div class="hr-guide-helplines-list">';
    for (var k = 0; k < matchedHelplines.length; k++) {
      html += renderHelplineRow(matchedHelplines[k]);
    }
    html += '</div>';
    html += '</div>';

    // (3) Related laws
    html += '<div class="hr-guide-section">';
    html += '<h4 class="hr-guide-section-title"><span class="material-symbols-rounded">gavel</span> 3. Related laws</h4>';
    html += '<div class="hr-guide-laws-list">';
    for (var m = 0; m < matchedLaws.length; m++) {
      var law = matchedLaws[m];
      html += '<div class="hr-mini-law-card">';
      html += '<div class="hr-law-tags">';
      html += '<span class="hr-bns-tag">BNS ' + escapeHtml(law.bns_section) + '</span>';
      html += '<span class="hr-ipc-tag">old IPC ' + escapeHtml(law.old_ipc) + '</span>';
      html += '</div>';
      html += '<div class="hr-mini-law-title">' + escapeHtml(law.title) + '</div>';
      html += '<div class="hr-mini-law-meaning">' + escapeHtml(law.meaning) + '</div>';
      html += '</div>';
    }
    for (var n = 0; n < matchedOther.length; n++) {
      html += '<div class="hr-mini-law-card">';
      html += '<div class="hr-mini-law-title">' + escapeHtml(matchedOther[n].title) + '</div>';
      html += '<div class="hr-mini-law-meaning">' + escapeHtml(matchedOther[n].meaning || matchedOther[n].note) + '</div>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';

    // (4) Where to report
    html += '<div class="hr-guide-section">';
    html += '<h4 class="hr-guide-section-title"><span class="material-symbols-rounded">pin_drop</span> 4. Where to report</h4>';
    html += '<div class="hr-guide-report-box">';
    html += '<p>' + escapeHtml(sc.whereToReport) + '</p>';
    html += '</div>';
    html += '</div>';

    // (5) Prepare my complaint button
    html += '<div class="hr-guide-action-section">';
    html += '<button type="button" class="btn btn-primary hr-prepare-btn" onclick="SafeHer.helpRights.prepareComplaint(\'' + escapeHtml(sc.id) + '\')">';
    html += '<span class="material-symbols-rounded">edit_document</span> Prepare my complaint</button>';
    html += '</div>';

    container.innerHTML = html;
  }

  function prepareComplaint(scenarioId) {
    closeScenario();
    if (SafeHer.router && SafeHer.router.go) {
      SafeHer.router.go('complaint-letter');
      // If scenario was passed, pre-select it
      setTimeout(function() {
        var sel = document.getElementById('complaint-incident-type');
        if (sel && scenarioId) {
          sel.value = scenarioId;
          updateComplaintTemplate();
        }
      }, 50);
    }
  }

  // ─── Tools: Complaint Letter & Evidence Checklist Logic ─────
  function updateComplaintTemplate() {
    var sel = document.getElementById('complaint-incident-type');
    var val = sel ? sel.value : 'other';
    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : null;

    var nameInput = document.getElementById('complaint-complainant-name');
    var phoneInput = document.getElementById('complaint-complainant-phone');
    if (user) {
      if (nameInput && !nameInput.value) nameInput.value = user.name || '';
      if (phoneInput && !phoneInput.value) phoneInput.value = user.phone || '';
    }

    var textEl = document.getElementById('complaint-preview-text');
    if (!textEl) return;

    var now = new Date();
    var dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    var timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    var sc = null;
    for (var i = 0; i < SCENARIOS.length; i++) {
      if (SCENARIOS[i].id === val) {
        sc = SCENARIOS[i];
        break;
      }
    }

    var incidentTitle = sc ? sc.title : 'Incident / Harassment';
    var bnsRef = sc ? ('BNS Sections ' + sc.bnsSections.join(', ') + ' and applicable provisions of Bharatiya Nagarik Suraksha Sanhita (BNSS)') : 'relevant provisions of the Bharatiya Nyaya Sanhita (BNS)';

    var cName = (nameInput && nameInput.value) ? nameInput.value : '[Complainant Name]';
    var cPhone = (phoneInput && phoneInput.value) ? phoneInput.value : '[Phone Number]';

    var sample = 'To,\n' +
      'The Station House Officer (SHO),\n' +
      '[Police Station Name / District]\n\n' +
      'Date: ' + dateStr + '\n\n' +
      'Subject: Formal Complaint and request for registration of FIR regarding ' + incidentTitle + ' under ' + bnsRef + '.\n\n' +
      'Respected Sir / Madam,\n\n' +
      'I, ' + cName + ' (Contact: ' + cPhone + '), wish to lodge a formal complaint regarding the following incident:\n\n' +
      '1. Date & Time of Occurrence: ' + dateStr + ' at approximately ' + timeStr + '\n' +
      '2. Location of Incident: [Specify place, street, landmark, or online handle/URL]\n' +
      '3. Accused Details: [Name, vehicle number, profile handle, physical description, or unknown]\n' +
      '4. Description of Incident:\n' +
      '   [Please describe the sequence of events clearly. State exact words used, actions taken, and witnesses present]\n\n' +
      '5. Preserved Evidence: [Screenshots, call logs, audio recording, witness details, or medical examination]\n\n' +
      'In view of the above cognizable offence, I kindly request you to register a formal FIR under ' + bnsRef + ' and provide me a free signed copy of the FIR as mandated under Section 173(2) of the BNSS.\n\n' +
      'Yours sincerely,\n' +
      cName + '\n' +
      'Phone: ' + cPhone + '\n';

    textEl.value = sample;
  }

  function copyComplaintLetter() {
    var textEl = document.getElementById('complaint-preview-text');
    if (!textEl) return;
    copyText(textEl.value, 'Complaint Letter');
  }

  function toggleEvidenceItem(cb) {
    var items = document.querySelectorAll('.evidence-check-item input[type="checkbox"]');
    var checkedCount = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].checked) checkedCount++;
    }
    var counter = document.getElementById('evidence-checked-count');
    if (counter) {
      counter.textContent = checkedCount + ' of ' + items.length + ' items collected';
    }
  }

  // ─── Initialization ──────────────────────────────────────────
  function init() {
    // Fill disclaimer text on every tab
    var disclaimers = document.querySelectorAll('.hr-disclaimer-box');
    var discText = getDisclaimer();
    for (var i = 0; i < disclaimers.length; i++) {
      disclaimers[i].innerHTML = '<span class="material-symbols-rounded">info</span><p>' + escapeHtml(discText) + '</p>';
    }

    // Render Helplines, Laws, and FIR stepper
    renderHelplinesList();
    renderLawsList();
    renderFirTab();

    // Hook search inputs
    var hSearch = document.getElementById('hr-helplines-search');
    if (hSearch) {
      hSearch.addEventListener('input', function(e) {
        setHelplineSearch(e.target.value);
      });
    }

    var lSearch = document.getElementById('hr-laws-search');
    if (lSearch) {
      lSearch.addEventListener('input', function(e) {
        setLawsSearch(e.target.value);
      });
    }

    // Router hooks
    if (SafeHer.router && SafeHer.router.onShow) {
      SafeHer.router.onShow('help-rights', function() {
        renderHelplinesList();
        renderLawsList();
        renderFirTab();
      });
      SafeHer.router.onShow('complaint-letter', function() {
        updateComplaintTemplate();
      });
    }
  }

  return {
    init: init,
    switchTab: switchTab,
    setCategory: setCategory,
    setHelplineSearch: setHelplineSearch,
    setLawsSearch: setLawsSearch,
    toggleLawExpand: toggleLawExpand,
    openScenario: openScenario,
    closeScenario: closeScenario,
    prepareComplaint: prepareComplaint,
    updateComplaintTemplate: updateComplaintTemplate,
    copyComplaintLetter: copyComplaintLetter,
    toggleEvidenceItem: toggleEvidenceItem,
    copyText: copyText
  };

})();
