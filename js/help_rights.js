// js/help_rights.js – Help & Rights: Helplines, Laws, File FIR, Tools, Complaint Generator, and Evidence Checklist
// Fully multilingual (English, Kannada, Hindi), offline-ready, and backed by localStorage

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
      titleKey: 'scenStalkingTitle',
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
      titleKey: 'scenStreetTitle',
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
      titleKey: 'scenWorkplaceTitle',
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
      titleKey: 'scenDomesticTitle',
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
      titleKey: 'scenAssaultTitle',
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
      titleKey: 'scenOnlineTitle',
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
      titleKey: 'scenAcidTitle',
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

  // ─── 6 Prescribed Evidence Checklist Items ────────────────────
  var EVIDENCE_ITEMS = [
    {
      id: 'ev_item_1',
      defaultTitle: 'Save screenshots and voice notes',
      defaultDesc: 'Capture uncropped screenshots with timestamps and back up audio files or voice notes to secure storage.'
    },
    {
      id: 'ev_item_2',
      defaultTitle: "Don't delete messages",
      defaultDesc: 'Keep original message threads, emails, and SMS intact as primary digital evidence without alterations.'
    },
    {
      id: 'ev_item_3',
      defaultTitle: 'Note date, time and place',
      defaultDesc: 'Write down exact timestamps, dates, and street or landmark locations while details are fresh.'
    },
    {
      id: 'ev_item_4',
      defaultTitle: 'Keep medical records if any',
      defaultDesc: 'Preserve doctor prescriptions, treatment receipts, and Medico-Legal Case (MLC) examination slips.'
    },
    {
      id: 'ev_item_5',
      defaultTitle: 'Write down witness details',
      defaultDesc: 'Record names, phone numbers, shop addresses, or vehicle registration numbers of witnesses.'
    },
    {
      id: 'ev_item_6',
      defaultTitle: 'Note any CCTV nearby',
      defaultDesc: 'Identify traffic cameras, ATM booths, commercial shops, or residential doorbell cameras overlooking the area.'
    }
  ];

  // ─── Translation & Data Access Helpers ───────────────────────
  function t(key, fallback) {
    if (window.SafeHer && window.SafeHer.i18n && window.SafeHer.i18n.t) {
      var val = window.SafeHer.i18n.t(key);
      if (val && val !== key) return val;
    }
    return fallback !== undefined ? fallback : key;
  }

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
    return t('hrDisclaimer',
      (window.SafeHer && window.SafeHer.helpdata && window.SafeHer.helpdata.DISCLAIMER_TEXT) ||
      window.DISCLAIMER_TEXT ||
      'General information, not legal advice. Laws and numbers can change. Last checked: November 2026. If you are in danger, call 112.'
    );
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
      var tId = tabs[i];
      var btn = document.getElementById('hr-tab-btn-' + tId);
      var pane = document.getElementById('hr-tab-pane-' + tId);
      if (btn) btn.classList.toggle('active', tId === tabId);
      if (pane) pane.style.display = (tId === tabId) ? 'block' : 'none';
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

  // ─── Laws Tab Logic (Preserving law section numbers) ────────
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

        // Section numbers kept unchanged; plain meaning translated through i18n
        var meaningKey = 'law_' + law.bns_section.replace('-', '_') + '_meaning';
        var translatedMeaning = t(meaningKey, law.meaning);

        html += '<div class="hr-law-card ' + (isExpanded ? 'expanded' : '') + '" onclick="SafeHer.helpRights.toggleLawExpand(' + i + ')">';
        html += '<div class="hr-law-header">';
        html += '<div class="hr-law-tags">';
        html += '<span class="hr-bns-tag">BNS Sec ' + escapeHtml(law.bns_section) + '</span>';
        html += '<span class="hr-ipc-tag">(old IPC ' + escapeHtml(law.old_ipc) + ')</span>';
        html += '</div>';
        html += '<span class="material-symbols-rounded hr-expand-icon">' + (isExpanded ? 'expand_less' : 'expand_more') + '</span>';
        html += '</div>';

        html += '<h4 class="hr-law-title">' + escapeHtml(law.title) + '</h4>';
        html += '<p class="hr-law-meaning">' + escapeHtml(translatedMeaning) + '</p>';

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
        var olMeaningKey = (ol.title.indexOf('POSH') !== -1) ? 'law_posh_meaning' :
                          (ol.title.indexOf('Domestic') !== -1) ? 'law_domestic_meaning' : 'law_dowry_meaning';
        var transOtherMeaning = t(olMeaningKey, ol.meaning || ol.note);

        otherHtml += '<div class="hr-other-law-card">';
        otherHtml += '<div class="hr-other-law-title">' + escapeHtml(ol.title) + '</div>';
        if (transOtherMeaning) {
          otherHtml += '<p class="hr-other-law-desc">' + escapeHtml(transOtherMeaning) + '</p>';
        }
        otherHtml += '</div>';
      }
      otherContainer.innerHTML = otherHtml;
    }
  }

  // ─── File FIR Tab Logic (Preserving BNSS sections) ───────────
  function renderFirTab() {
    var container = document.getElementById('hr-fir-stepper');
    if (!container) return;

    var rights = getFirRights();
    var html = '';

    for (var i = 0; i < rights.length; i++) {
      var r = rights[i];
      var stepKey = 'fir_step_' + (i + 1);
      var translatedStepText = t(stepKey, r.text);

      html += '<div class="hr-step-item">';
      html += '<div class="hr-step-num-wrap">';
      html += '<div class="hr-step-number">' + (r.point || (i + 1)) + '</div>';
      if (i < rights.length - 1) {
        html += '<div class="hr-step-line"></div>';
      }
      html += '</div>';

      html += '<div class="hr-step-content">';
      html += '<p class="hr-step-text">' + escapeHtml(translatedStepText) + '</p>';
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

    var scenarioTitle = t(sc.titleKey, sc.title);

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
    html += '<h3 class="hr-guide-title">' + escapeHtml(scenarioTitle) + '</h3>';
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

    // (3) Related laws (Section numbers intact)
    html += '<div class="hr-guide-section">';
    html += '<h4 class="hr-guide-section-title"><span class="material-symbols-rounded">gavel</span> 3. Related laws</h4>';
    html += '<div class="hr-guide-laws-list">';
    for (var m = 0; m < matchedLaws.length; m++) {
      var law = matchedLaws[m];
      var lawMean = t('law_' + law.bns_section.replace('-', '_') + '_meaning', law.meaning);
      html += '<div class="hr-mini-law-card">';
      html += '<div class="hr-law-tags">';
      html += '<span class="hr-bns-tag">BNS Sec ' + escapeHtml(law.bns_section) + '</span>';
      html += '<span class="hr-ipc-tag">(old IPC ' + escapeHtml(law.old_ipc) + ')</span>';
      html += '</div>';
      html += '<div class="hr-mini-law-title">' + escapeHtml(law.title) + '</div>';
      html += '<div class="hr-mini-law-meaning">' + escapeHtml(lawMean) + '</div>';
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
    html += '<span class="material-symbols-rounded">edit_document</span> ' + escapeHtml(t('hrPrepareComplaint', 'Prepare my complaint')) + '</button>';
    html += '</div>';

    container.innerHTML = html;
  }

  // ─── Tool 1: Complaint Letter Generator ───────────────────────
  function prepareComplaint(scenarioId) {
    closeScenario();
    if (SafeHer.router && SafeHer.router.go) {
      SafeHer.router.go('complaint-letter');
      setTimeout(function() {
        var sel = document.getElementById('complaint-incident-type');
        if (sel && scenarioId) {
          sel.value = scenarioId;
        }
        prefillUserData();
        generateComplaintLetter();
      }, 50);
    }
  }

  function prefillUserData() {
    var user = (SafeHer.api && SafeHer.api.getUser) ? SafeHer.api.getUser() : null;
    var nameInput = document.getElementById('complaint-complainant-name');
    var phoneInput = document.getElementById('complaint-complainant-phone');
    var dtInput = document.getElementById('complaint-datetime');

    if (user) {
      if (nameInput && !nameInput.value) nameInput.value = user.name || '';
      if (phoneInput && !phoneInput.value) phoneInput.value = user.phone || '';
    }

    if (dtInput && !dtInput.value) {
      // Default to current date and time
      var now = new Date();
      var year = now.getFullYear();
      var month = String(now.getMonth() + 1).padStart(2, '0');
      var day = String(now.getDate()).padStart(2, '0');
      var hours = String(now.getHours()).padStart(2, '0');
      var minutes = String(now.getMinutes()).padStart(2, '0');
      dtInput.value = year + '-' + month + '-' + day + 'T' + hours + ':' + minutes;
    }
  }

  function generateComplaintLetter() {
    var name = (document.getElementById('complaint-complainant-name') || {}).value || '';
    var phone = (document.getElementById('complaint-complainant-phone') || {}).value || '';
    var station = (document.getElementById('complaint-police-station') || {}).value || '';
    var incidentType = (document.getElementById('complaint-incident-type') || {}).value || 'harassment';
    var dt = (document.getElementById('complaint-datetime') || {}).value || '';
    var place = (document.getElementById('complaint-place') || {}).value || '';
    var accused = (document.getElementById('complaint-accused') || {}).value || '';
    var description = (document.getElementById('complaint-description') || {}).value || '';
    var witnesses = (document.getElementById('complaint-witnesses') || {}).value || '';

    // Evidence checkboxes
    var evidenceList = [];
    if (document.getElementById('complaint-ev-screenshots') && document.getElementById('complaint-ev-screenshots').checked) {
      evidenceList.push('Screenshots of chats/posts');
    }
    if (document.getElementById('complaint-ev-voicenotes') && document.getElementById('complaint-ev-voicenotes').checked) {
      evidenceList.push('Voice notes / Audio recordings');
    }
    if (document.getElementById('complaint-ev-photos') && document.getElementById('complaint-ev-photos').checked) {
      evidenceList.push('Photographs');
    }
    if (document.getElementById('complaint-ev-medical') && document.getElementById('complaint-ev-medical').checked) {
      evidenceList.push('Medical examination report (MLC)');
    }
    if (document.getElementById('complaint-ev-messages') && document.getElementById('complaint-ev-messages').checked) {
      evidenceList.push('SMS / Direct Message threads');
    }

    var now = new Date();
    var todayStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    var formattedDt = dt ? dt.replace('T', ' at ') : todayStr;

    // Map incident type to descriptive title
    var scMap = {
      stalking: 'Being followed or stalked',
      street: 'Street harassment',
      workplace: 'Harassment at workplace',
      domestic: 'Domestic violence or dowry harassment',
      assault: 'Sexual assault',
      online: 'Online harassment or morphed images',
      acid: 'Acid attack',
      other: 'Harassment and Criminal Offence'
    };
    var incidentTitle = scMap[incidentType] || incidentType;

    var stationStr = station.trim() ? station.trim() : '<Police Station Name / District>';
    var complainantNameStr = name.trim() ? name.trim() : '<Your Full Name>';
    var complainantPhoneStr = phone.trim() ? phone.trim() : '<Your Phone Number>';
    var placeStr = place.trim() ? place.trim() : '<Location / Address of Incident>';
    var accusedStr = accused.trim() ? accused.trim() : 'Unknown / Unidentified person(s)';
    var descStr = description.trim() ? description.trim() : '[Detailed description of what happened, actions taken, and statements made]';
    var witnessStr = witnesses.trim() ? witnesses.trim() : 'None / Bystanders at the scene';
    var evidenceStr = evidenceList.length > 0 ? evidenceList.join(', ') : 'None attached at this stage';

    // Format formal letter without inserting law section numbers automatically
    var letter = 'To,\n' +
      'The Station House Officer,\n' +
      stationStr + '\n\n' +
      'Date: ' + todayStr + '\n\n' +
      'Subject: Complaint regarding ' + incidentTitle + '\n\n' +
      'Respected Sir / Madam,\n\n' +
      'I, ' + complainantNameStr + ', residing at [My Address], contact phone: ' + complainantPhoneStr + ', wish to lodge a formal complaint regarding the following incident:\n\n' +
      '1. Date and Time of Incident:\n' +
      '   ' + formattedDt + '\n\n' +
      '2. Place of Occurrence:\n' +
      '   ' + placeStr + '\n\n' +
      '3. Details of Accused (if known):\n' +
      '   ' + accusedStr + '\n\n' +
      '4. Description of Incident:\n' +
      '   ' + descStr + '\n\n' +
      '5. Witnesses:\n' +
      '   ' + witnessStr + '\n\n' +
      '6. Available Evidence Attached / Preserved:\n' +
      '   ' + evidenceStr + '\n\n' +
      'I respectfully request you to register a formal First Information Report (FIR) on the basis of this complaint, initiate a prompt investigation into the matter, and provide me with a free signed copy of the FIR as mandated under Section 173(2) of the Bharatiya Nagarik Suraksha Sanhita (BNSS).\n\n' +
      'Note: The relevant legal section numbers are to be determined and assigned by the investigating police authority upon registration of the FIR.\n\n' +
      'Yours faithfully,\n\n' +
      '(Signature)\n' +
      complainantNameStr + '\n' +
      'Phone: ' + complainantPhoneStr + '\n';

    var previewEl = document.getElementById('complaint-preview-text');
    if (previewEl) {
      previewEl.value = letter;
    }

    var printEl = document.getElementById('complaint-print-letter-content');
    if (printEl) {
      printEl.textContent = letter;
    }
  }

  function copyComplaintLetter() {
    var previewEl = document.getElementById('complaint-preview-text');
    if (!previewEl) return;
    copyText(previewEl.value, 'Complaint Letter');
  }

  function shareComplaintLetter() {
    var previewEl = document.getElementById('complaint-preview-text');
    var letterText = previewEl ? previewEl.value : '';
    if (!letterText) return;

    if (navigator.share) {
      navigator.share({
        title: 'Formal Police Complaint',
        text: letterText
      }).catch(function(err) {
        if (err.name !== 'AbortError') {
          copyComplaintLetter();
        }
      });
    } else {
      copyComplaintLetter();
    }
  }

  function printComplaintLetter() {
    generateComplaintLetter();
    window.print();
  }

  // ─── Tool 2: Evidence Checklist with localStorage Persistence ─
  var STORAGE_KEY_CHECKLIST = 'safeher_evidence_checklist_state';

  function getChecklistState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY_CHECKLIST);
      return raw ? JSON.parse(raw) : {};
    } catch(e) {
      return {};
    }
  }

  function saveChecklistState(state) {
    try {
      localStorage.setItem(STORAGE_KEY_CHECKLIST, JSON.stringify(state));
    } catch(e) {}
  }

  function renderEvidenceChecklist() {
    var container = document.getElementById('evidence-checklist-items-wrap');
    if (!container) return;

    var state = getChecklistState();
    var checkedCount = 0;
    var html = '';

    for (var i = 0; i < EVIDENCE_ITEMS.length; i++) {
      var item = EVIDENCE_ITEMS[i];
      var isChecked = !!state[item.id];
      if (isChecked) checkedCount++;

      var title = t(item.id + '_title', item.defaultTitle);
      var desc = t(item.id + '_desc', item.defaultDesc);

      html += '<label class="evidence-check-item ' + (isChecked ? 'checked' : '') + '">';
      html += '<input type="checkbox" id="' + item.id + '" ' + (isChecked ? 'checked' : '') + ' onchange="SafeHer.helpRights.onEvidenceCheckChange(\'' + item.id + '\', this.checked)">';
      html += '<div class="evidence-check-text">';
      html += '<strong>' + (i + 1) + '. ' + escapeHtml(title) + '</strong>';
      html += '<p>' + escapeHtml(desc) + '</p>';
      html += '</div>';
      html += '</label>';
    }

    container.innerHTML = html;

    var countBadge = document.getElementById('evidence-checked-count');
    if (countBadge) {
      countBadge.textContent = checkedCount + ' of ' + EVIDENCE_ITEMS.length + ' items collected';
    }
  }

  function onEvidenceCheckChange(itemId, isChecked) {
    var state = getChecklistState();
    state[itemId] = isChecked;
    saveChecklistState(state);

    var count = 0;
    for (var i = 0; i < EVIDENCE_ITEMS.length; i++) {
      if (state[EVIDENCE_ITEMS[i].id]) count++;
    }

    var countBadge = document.getElementById('evidence-checked-count');
    if (countBadge) {
      countBadge.textContent = count + ' of ' + EVIDENCE_ITEMS.length + ' items collected';
    }

    var label = document.getElementById(itemId);
    if (label && label.closest) {
      var parent = label.closest('.evidence-check-item');
      if (parent) parent.classList.toggle('checked', isChecked);
    }
  }

  function resetEvidenceChecklist() {
    saveChecklistState({});
    renderEvidenceChecklist();
    if (SafeHer.toast) SafeHer.toast('Evidence checklist reset');
  }

  // ─── Re-render Everything (for Language Changes) ──────────────
  function render() {
    // Fill disclaimer text on every tab
    var disclaimers = document.querySelectorAll('.hr-disclaimer-box');
    var discText = getDisclaimer();
    for (var i = 0; i < disclaimers.length; i++) {
      disclaimers[i].innerHTML = '<span class="material-symbols-rounded">info</span><p>' + escapeHtml(discText) + '</p>';
    }

    renderHelplinesList();
    renderLawsList();
    renderFirTab();
    renderEvidenceChecklist();
    generateComplaintLetter();
  }

  // ─── Initialization ──────────────────────────────────────────
  function init() {
    render();

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
        render();
      });
      SafeHer.router.onShow('complaint-letter', function() {
        prefillUserData();
        generateComplaintLetter();
      });
      SafeHer.router.onShow('evidence-checklist', function() {
        renderEvidenceChecklist();
      });
    }
  }

  return {
    init: init,
    render: render,
    switchTab: switchTab,
    setCategory: setCategory,
    setHelplineSearch: setHelplineSearch,
    setLawsSearch: setLawsSearch,
    toggleLawExpand: toggleLawExpand,
    openScenario: openScenario,
    closeScenario: closeScenario,
    prepareComplaint: prepareComplaint,
    prefillUserData: prefillUserData,
    generateComplaintLetter: generateComplaintLetter,
    copyComplaintLetter: copyComplaintLetter,
    shareComplaintLetter: shareComplaintLetter,
    printComplaintLetter: printComplaintLetter,
    renderEvidenceChecklist: renderEvidenceChecklist,
    onEvidenceCheckChange: onEvidenceCheckChange,
    resetEvidenceChecklist: resetEvidenceChecklist,
    copyText: copyText
  };

})();
