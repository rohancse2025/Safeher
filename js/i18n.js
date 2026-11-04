// js/i18n.js – Multi-language support: English, Kannada, and Hindi

SafeHer.i18n = (function() {
  var currentLang = 'en';

  var translations = {
    en: {
      // Navigation
      navHome: 'Home',
      navContacts: 'Contacts',
      navTips: 'Tips',
      navProfile: 'Profile',

      // Home Screen
      homeEmergencyTitle: 'Are you in emergency?',
      homeEmergencySub: 'Press the SOS button and your contacts will be alerted',
      homeYouAreSafe: 'You are safe',
      homeLiveLocation: 'Live Location',
      homeShareLocation: 'Share Location',
      homeHistory: 'History',
      homeCallPolice: 'Help & Rights',
      homeHelpRights: 'Help & Rights',
      homeNearbyPlaces: 'Nearby Places',
      homeVolunteers: 'Volunteers',
      homeSafeTimer: 'Safe Timer',
      homeFakeCall: 'Fake Call',
      homeTips: 'Tips',
      homeEvidence: 'Evidence',
      homeTrustedContacts: 'Trusted contacts:',
      homeVolunteersNearby: 'Volunteers nearby:',

      // SOS
      sosActivated: 'SOS Activated',
      sosAlertActive: 'SOS Alert Active',
      sosAlertSentDesc: 'Your emergency location and alert have been sent to your trusted contacts.',
      sosCall112: 'Call 112',
      sosImSafe: 'I’m Safe',
      sosCancel: 'Cancel',
      sosWaitingVolunteers: 'Waiting for volunteers...',
      sosOneVolunteerOnWay: '1 volunteer is on the way',

      // Contacts
      contactsTitle: 'Emergency Contacts',
      addContact: 'Add Contact',

      // Profile & Settings
      profileTitle: 'Profile & Settings',
      editProfile: 'Edit Profile',
      securitySection: 'Security',
      changePin: 'Change Safety PIN',
      languageSection: 'Language',
      selectLanguage: 'App Language',
      notificationsSection: 'Emergency Notifications',
      alertHistorySection: 'SOS Alert History',
      aboutSection: 'About',
      logout: 'Log Out',
      clearAllData: 'Clear All Data',

      // Safe Timer
      safeTimerTitle: 'Safe Timer',
      startSafeTimer: 'Start Safe Timer',

      // Actions & Generic
      call: 'Call',
      directions: 'Directions',
      retry: 'Retry',
      save: 'Save',

      // Help & Rights Screen
      hrScreenTitle: 'Help & Rights',
      hrWhatHappened: 'What happened?',
      hrWhatHappenedSub: 'Tap a situation for instant advice, helplines, laws, and reporting steps:',
      hrTabHelplines: 'Helplines',
      hrTabLaws: 'Laws',
      hrTabFir: 'File FIR',
      hrTabTools: 'Tools',
      hrSearchHelplines: 'Search helplines by name, number, service...',
      hrSearchLaws: 'Search laws by BNS section, IPC, or title...',
      hrCatAll: 'All',
      hrCatEmergency: 'Emergency',
      hrCatWomen: 'Women',
      hrCatChild: 'Child',
      hrCatCyber: 'Cyber',
      hrCatLegal: 'Legal',
      hrCatHealth: 'Health',
      hrNearestStation: 'Nearest police station',
      hrWomenStation: 'Women police station',
      hrPrepareComplaint: 'Prepare my complaint',
      hrComplaintLetter: 'Complaint Letter',
      hrEvidenceChecklist: 'Evidence Checklist',
      hrDisclaimer: 'General information, not legal advice. Laws and numbers can change. Last checked: November 2026. If you are in danger, call 112.',

      // Scenarios
      scenStalkingTitle: 'Being followed or stalked',
      scenStreetTitle: 'Street harassment',
      scenWorkplaceTitle: 'Harassment at workplace',
      scenDomesticTitle: 'Domestic violence or dowry harassment',
      scenAssaultTitle: 'Sexual assault',
      scenOnlineTitle: 'Online harassment or morphed images',
      scenAcidTitle: 'Acid attack',

      // Law Plain Meanings (Section numbers and titles kept unchanged)
      law_63_70_meaning: 'Sexual offences including gang rape (70)',
      law_74_meaning: "Assault or force meant to outrage a woman's modesty",
      law_75_meaning: 'Unwelcome sexual advances, demands or remarks',
      law_76_meaning: 'Assault or force with intent to disrobe a woman',
      law_77_meaning: 'Watching or capturing private images without consent',
      law_78_meaning: 'Following or contacting repeatedly against her wishes',
      law_79_meaning: "Words, sounds or gestures that insult a woman's modesty",
      law_80_meaning: 'Death of a woman within seven years of marriage linked to dowry harassment',
      law_85_86_meaning: 'Cruelty towards a married woman (86 defines cruelty)',
      law_124_meaning: 'Acid attacks',
      law_posh_meaning: 'Workplace harassment; Internal or Local Complaints Committee',
      law_domestic_meaning: 'Protection of women from domestic violence',
      law_dowry_meaning: 'Prohibition of giving or taking dowry',

      // BNSS FIR Steps (Section numbers kept unchanged)
      fir_step_1: 'FIR for cognizable offences is under Section 173 BNSS (old Section 154 CrPC).',
      fir_step_2: 'Zero FIR: can be registered at any police station regardless of where the offence happened.',
      fir_step_3: 'e-FIR: can be given electronically; the complainant signs within three days.',
      fir_step_4: 'For offences such as rape, sexual harassment, voyeurism and stalking, the information is recorded by a woman police officer.',
      fir_step_5: 'The complainant gets a free copy of the FIR (Section 173(2)).',
      fir_step_6: 'If police refuse, remedies exist under Sections 173(4) and 175(3): write to the Superintendent of Police or approach a Magistrate.',

      // Evidence Checklist items
      ev_item_1_title: 'Save screenshots and voice notes',
      ev_item_1_desc: 'Capture uncropped screenshots with timestamps and back up audio files or voice notes to secure storage.',
      ev_item_2_title: "Don't delete messages",
      ev_item_2_desc: 'Keep original message threads, emails, and SMS intact as primary digital evidence without alterations.',
      ev_item_3_title: 'Note date, time and place',
      ev_item_3_desc: 'Write down exact timestamps, dates, and street or landmark locations while details are fresh.',
      ev_item_4_title: 'Keep medical records if any',
      ev_item_4_desc: 'Preserve doctor prescriptions, treatment receipts, and Medico-Legal Case (MLC) examination slips.',
      ev_item_5_title: 'Write down witness details',
      ev_item_5_desc: 'Record names, phone numbers, shop addresses, or vehicle registration numbers of witnesses.',
      ev_item_6_title: 'Note any CCTV nearby',
      ev_item_6_desc: 'Identify traffic cameras, ATM booths, commercial shops, or residential doorbell cameras overlooking the area.'
    },

    kn: {
      // Navigation
      navHome: 'ಮುಖಪುಟ',
      navContacts: 'ಸಂಪರ್ಕಗಳು',
      navTips: 'ಸಲಹೆಗಳು',
      navProfile: 'ಪ್ರೊಫೈಲ್',

      // Home Screen
      homeEmergencyTitle: 'ನೀವು ತುರ್ತು ಪರಿಸ್ಥಿತಿಯಲ್ಲಿದ್ದೀರಾ?',
      homeEmergencySub: 'SOS ಬಟನ್ ಒತ್ತಿರಿ, ನಿಮ್ಮ ಸಂಪರ್ಕಗಳಿಗೆ ಎಚ್ಚರಿಕೆ ಹೋಗುತ್ತದೆ',
      homeYouAreSafe: 'ನೀವು ಸುರಕ್ಷಿತವಾಗಿದ್ದೀರಿ',
      homeLiveLocation: 'ಲೈವ್ ಸ್ಥಳ',
      homeShareLocation: 'ಸ್ಥಳ ಹಂಚಿಕೊಳ್ಳಿ',
      homeHistory: 'ಇತಿಹಾಸ',
      homeCallPolice: 'ಸಹಾಯ ಮತ್ತು ಹಕ್ಕುಗಳು',
      homeHelpRights: 'ಸಹಾಯ ಮತ್ತು ಹಕ್ಕುಗಳು',
      homeNearbyPlaces: 'ಹತ್ತಿರದ ಸ್ಥಳಗಳು',
      homeVolunteers: 'ಸ್ವಯಂಸೇವಕರು',
      homeSafeTimer: 'ಸುರಕ್ಷಿತ ಟೈಮರ್',
      homeFakeCall: 'ನಕಲಿ ಕರೆ',
      homeTips: 'ಸಲಹೆಗಳು',
      homeEvidence: 'ಸಾಕ್ಷ್ಯ',
      homeTrustedContacts: 'ವಿಶ್ವಾಸಾರ್ಹ ಸಂಪರ್ಕಗಳು:',
      homeVolunteersNearby: 'ಹತ್ತಿರದ ಸ್ವಯಂಸೇವಕರು:',

      // SOS
      sosActivated: 'SOS ಸಕ್ರಿಯಗೊಂಡಿದೆ',
      sosAlertActive: 'SOS ಎಚ್ಚರಿಕೆ ಸಕ್ರಿಯವಾಗಿದೆ',
      sosAlertSentDesc: 'ನಿಮ್ಮ ತುರ್ತು ಸ್ಥಳ ಮತ್ತು ಎಚ್ಚರಿಕೆಯನ್ನು ನಿಮ್ಮ ಸಂಪರ್ಕಗಳಿಗೆ ಕಳುಹಿಸಲಾಗಿದೆ.',
      sosCall112: '112 ಕರೆ ಮಾಡಿ',
      sosImSafe: 'ನಾನು ಸುರಕ್ಷಿತ',
      sosCancel: 'ರದ್ದುಮಾಡಿ',
      sosWaitingVolunteers: 'ಸ್ವಯಂಸೇವಕರಿಗಾಗಿ ಕಾಯಲಾಗುತ್ತಿದೆ...',
      sosOneVolunteerOnWay: '1 ಸ್ವಯಂಸೇವಕರು ಬರುತ್ತಿದ್ದಾರೆ',

      // Contacts
      contactsTitle: 'ತುರ್ತು ಸಂಪರ್ಕಗಳು',
      addContact: 'ಸಂಪರ್ಕ ಸೇರಿಸಿ',

      // Profile & Settings
      profileTitle: 'ಪ್ರೊಫೈಲ್ ಮತ್ತು ಸೆಟ್ಟಿಂಗ್ಸ್',
      editProfile: 'ಪ್ರೊಫೈಲ್ ತಿದ್ದು',
      securitySection: 'ಸುರಕ್ಷತೆ',
      changePin: 'ಸುರಕ್ಷತಾ ಪಿನ್ ಬದಲಾಯಿಸಿ',
      languageSection: 'ಭಾಷೆ',
      selectLanguage: 'ಆ್ಯಪ್ ಭಾಷೆ',
      notificationsSection: 'ತುರ್ತು ಅಧಿಸೂಚನೆಗಳು',
      alertHistorySection: 'SOS ಎಚ್ಚರಿಕೆ ಇತಿಹಾಸ',
      aboutSection: 'ಮಾಹಿತಿ',
      logout: 'ಲಾಗ್ ಔಟ್',
      clearAllData: 'ಎಲ್ಲ ಡೇಟಾ ಅಳಿಸಿ',

      // Safe Timer
      safeTimerTitle: 'ಸುರಕ್ಷಿತ ಟೈಮರ್',
      startSafeTimer: 'ಟೈಮರ್ ಪ್ರಾರಂಭಿಸಿ',

      // Actions & Generic
      call: 'ಕರೆ ಮಾಡಿ',
      directions: 'ದಾರಿ',
      retry: 'ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ',
      save: 'ಉಳಿಸಿ',

      // Help & Rights Screen
      hrScreenTitle: 'ಸಹಾಯ ಮತ್ತು ಹಕ್ಕುಗಳು',
      hrWhatHappened: 'ಏನಾಯಿತು?',
      hrWhatHappenedSub: 'ತ್ವರಿತ ಸಲಹೆ, ಸಹಾಯವಾಣಿ, ಕಾನೂನು ಮತ್ತು ದೂರು ನೀಡುವ ಹಂತಗಳಿಗಾಗಿ ಆಯ್ಕೆಮಾಡಿ:',
      hrTabHelplines: 'ಸಹಾಯವಾಣಿಗಳು',
      hrTabLaws: 'ಕಾನೂನುಗಳು',
      hrTabFir: 'ಎಫ್‌ಐಆರ್ ದಾಖಲಿಸಿ',
      hrTabTools: 'ಸಾಧನಗಳು',
      hrSearchHelplines: 'ಹೆಸರು, ಸಂಖ್ಯೆ ಅಥವಾ ಸೇವೆಯ ಮೂಲಕ ಹುಡುಕಿ...',
      hrSearchLaws: 'BNS ಸೆಕ್ಷನ್, IPC ಅಥವಾ ಶೀರ್ಷಿಕೆಯ ಮೂಲಕ ಹುಡುಕಿ...',
      hrCatAll: 'ಎಲ್ಲವೂ',
      hrCatEmergency: 'ತುರ್ತು',
      hrCatWomen: 'ಮಹಿಳೆಯರು',
      hrCatChild: 'ಮಕ್ಕಳು',
      hrCatCyber: 'ಸೈಬರ್',
      hrCatLegal: 'ಕಾನೂನು',
      hrCatHealth: 'ಆರೋಗ್ಯ',
      hrNearestStation: 'ಹತ್ತಿರದ ಪೊಲೀಸ್ ಠಾಣೆ',
      hrWomenStation: 'ಮಹಿಳಾ ಪೊಲೀಸ್ ಠಾಣೆ',
      hrPrepareComplaint: 'ನನ್ನ ದೂರು ಸಿದ್ಧಪಡಿಸಿ',
      hrComplaintLetter: 'ದೂರು ಪತ್ರ',
      hrEvidenceChecklist: 'ಸಾಕ್ಷ್ಯ ಪರಿಶೀಲನಾ ಪಟ್ಟಿ',
      hrDisclaimer: 'ಸಾಮಾನ್ಯ ಮಾಹಿತಿ, ಕಾನೂನು ಸಲಹೆಯಲ್ಲ. ಕಾನೂನುಗಳು ಮತ್ತು ಸಂಖ್ಯೆಗಳು ಬದಲಾಗಬಹುದು. ಕೊನೆಯದಾಗಿ ಪರಿಶೀಲಿಸಲಾಗಿದೆ: ನವೆಂಬರ್ 2026. ನೀವು ಅಪಾಯದಲ್ಲಿದ್ದರೆ 112 ಗೆ ಕರೆ ಮಾಡಿ.',

      // Scenarios
      scenStalkingTitle: 'ಹಿಂಬಾಲಿಸುವುದು ಅಥವಾ ಸ್ಟಾಕಿಂಗ್',
      scenStreetTitle: 'ರಸ್ತೆ ಕಿರುಕುಳ',
      scenWorkplaceTitle: 'ಕೆಲಸದ ಸ್ಥಳದಲ್ಲಿ ಕಿರುಕುಳ',
      scenDomesticTitle: 'ಕೌಟುಂಬಿಕ ಹಿಂಸೆ ಅಥವಾ ವರದಕ್ಷಿಣೆ ಕಿರುಕುಳ',
      scenAssaultTitle: 'ಲೈಂಗಿಕ ದೌರ್ಜನ್ಯ',
      scenOnlineTitle: 'ಆನ್‌ಲೈನ್ ಕಿರುಕುಳ ಅಥವಾ ಮಾರ್ಫ್ ಮಾಡಿದ ಚಿತ್ರಗಳು',
      scenAcidTitle: 'ಆಸಿಡ್ ದಾಳಿ',

      // Law Plain Meanings (Section numbers and titles kept unchanged)
      law_63_70_meaning: 'ಗ್ಯಾಂಗ್ ರೇಪ್ (70) ಸೇರಿದಂತೆ ಲೈಂಗಿಕ ಅಪರಾಧಗಳು',
      law_74_meaning: 'ಮಹಿಳೆಯ ಘನತೆಗೆ ಧಕ್ಕೆ ತರುವ ಉದ್ದೇಶದಿಂದ ಹಲ್ಲೆ ಅಥವಾ ಬಲಪ್ರಯೋಗ',
      law_75_meaning: 'ಅನಪೇಕ್ಷಿತ ಲೈಂಗಿಕ ಪ್ರಸ್ತಾಪಗಳು, ಬೇಡಿಕೆಗಳು ಅಥವಾ ಅವಹೇಳನಕಾರಿ ಮಾತುಗಳು',
      law_76_meaning: 'ಮಹಿಳೆಯ ಬಟ್ಟೆ ಕಳಚುವ ಉದ್ದೇಶದಿಂದ ಹಲ್ಲೆ ಅಥವಾ ಬಲಪ್ರಯೋಗ',
      law_77_meaning: 'ಒಪ್ಪಿಗೆಯಿಲ್ಲದೆ ಖಾಸಗಿ ಚಿತ್ರಗಳನ್ನು ನೋಡುವುದು ಅಥವಾ ಸೆರೆಹಿಡಿಯುವುದು',
      law_78_meaning: 'ಇಷ್ಟವಿಲ್ಲದಿದ್ದರೂ ಪದೇ ಪದೇ ಹಿಂಬಾಲಿಸುವುದು ಅಥವಾ ಸಂಪರ್ಕಿಸುವುದು',
      law_79_meaning: 'ಮಹಿಳೆಯ ಘನತೆಯನ್ನು ಅವಮಾನಿಸುವ ಪದಗಳು, ಶಬ್ದಗಳು ಅಥವಾ ಸನ್ನೆಗಳು',
      law_80_meaning: 'ವರದಕ್ಷಿಣೆ ಕಿರುಕುಳಕ್ಕೆ ಸಂಬಂಧಿಸಿದಂತೆ ಮದುವೆಯಾದ ಏಳು ವರ್ಷಗಳಲ್ಲಿ ಮಹಿಳೆಯ ಸಾವು',
      law_85_86_meaning: 'ವಿವಾಹಿತ ಮಹಿಳೆಯ ಮೇಲೆ ಕ್ರೌರ್ಯ (ಸೆಕ್ಷನ್ 86 ಕ್ರೌರ್ಯವನ್ನು ವ್ಯಾಖ್ಯಾನಿಸುತ್ತದೆ)',
      law_124_meaning: 'ಆಸಿಡ್ ದಾಳಿಗಳು',
      law_posh_meaning: 'ಕೆಲಸದ ಸ್ಥಳದಲ್ಲಿ ಕಿರುಕುಳ; ಆಂತರಿಕ ಅಥವಾ ಸ್ಥಳೀಯ ದೂರು ಸಮಿತಿ',
      law_domestic_meaning: 'ಕೌಟುಂಬಿಕ ಹಿಂಸಾಚಾರದಿಂದ ಮಹಿಳೆಯರ ರಕ್ಷಣೆ',
      law_dowry_meaning: 'ವರದಕ್ಷಿಣೆ ಕೊಡುವುದು ಅಥವಾ ತೆಗೆದುಕೊಳ್ಳುವುದನ್ನು ನಿಷೇಧಿಸುವುದು',

      // BNSS FIR Steps (Section numbers kept unchanged)
      fir_step_1: 'ಗಂಭೀರ ಅಪರಾಧಗಳಿಗೆ FIR ದಾಖಲಿಸುವುದು Section 173 BNSS (ಹಳೆಯ Section 154 CrPC) ಅಡಿಯಲ್ಲಿದೆ.',
      fir_step_2: 'Zero FIR: ಅಪರಾಧ ಎಲ್ಲಿಯೇ ನಡೆದಿದ್ದರೂ ಯಾವುದೇ ಪೊಲೀಸ್ ಠಾಣೆಯಲ್ಲಿ ದಾಖಲಿಸಬಹುದು.',
      fir_step_3: 'e-FIR: ಎಲೆಕ್ಟ್ರಾನಿಕ್ ರೂಪದಲ್ಲಿ ನೀಡಬಹುದು; ದೂರುದಾರರು ಮೂರು ದಿನಗಳಲ್ಲಿ ಸಹಿ ಮಾಡಬೇಕು.',
      fir_step_4: 'ರೇಪ್, ಲೈಂಗಿಕ ಕಿರುಕುಳ, ವಾಯುರಿಸಂ ಮತ್ತು ಸ್ಟಾಕಿಂಗ್ ಮುಂತಾದ ಅಪರಾಧಗಳಿಗೆ ಮಹಿಳಾ ಪೊಲೀಸ್ ಅಧಿಕಾರಿಯೇ ಹೇಳಿಕೆ ದಾಖಲಿಸಿಕೊಳ್ಳಬೇಕು.',
      fir_step_5: 'ದೂರುದಾರರಿಗೆ FIR ನ ಉಚಿತ ಪ್ರತಿಯನ್ನು ನೀಡಲಾಗುತ್ತದೆ (Section 173(2)).',
      fir_step_6: 'ಪೊಲೀಸರು ನಿರಾಕರಿಸಿದರೆ Sections 173(4) ಮತ್ತು 175(3) ರ ಅಡಿಯಲ್ಲಿ ಪರಿಹಾರಗಳಿವೆ: ಎಸ್ಪಿ (Superintendent of Police) ಅವರಿಗೆ ಬರೆಯಿರಿ ಅಥವಾ ಮ್ಯಾಜಿಸ್ಟ್ರೇಟ್ ಅನ್ನು ಸಂಪರ್ಕಿಸಿ.',

      // Evidence Checklist items
      ev_item_1_title: 'ಸ್ಕ್ರೀನ್‌ಶಾಟ್‌ಗಳು ಮತ್ತು ವಾಯ್ಸ್ ನೋಟ್‌ಗಳನ್ನು ಉಳಿಸಿ',
      ev_item_1_desc: 'ದಿನಾಂಕ ಮತ್ತು ಸಮಯದೊಂದಿಗೆ ಸ್ಕ್ರೀನ್‌ಶಾಟ್‌ಗಳನ್ನು ತೆಗೆದು ಸುರಕ್ಷಿತವಾಗಿ ಬ್ಯಾಕಪ್ ಮಾಡಿ.',
      ev_item_2_title: 'ಸಂದೇಶಗಳನ್ನು ಅಳಿಸಬೇಡಿ',
      ev_item_2_desc: 'ಮೂಲ ಚಾಟ್‌ಗಳು, ಇಮೇಲ್‌ಗಳು ಮತ್ತು ಕರೆ ಲಾಗ್‌ಗಳನ್ನು ಡಿಜಿಟಲ್ ಪುರಾವೆಯಾಗಿ ಸಂರಕ್ಷಿಸಿ.',
      ev_item_3_title: 'ದಿನಾಂಕ, ಸಮಯ ಮತ್ತು ಸ್ಥಳವನ್ನು ಬರೆದಿಡಿ',
      ev_item_3_desc: 'ನೆನಪಿರುವಾಗಲೇ ನಿಖರವಾದ ದಿನಾಂಕ, ಸಮಯ ಮತ್ತು ಸ್ಥಳದ ವಿವರಗಳನ್ನು ದಾಖಲಿಸಿಕೊಳ್ಳಿ.',
      ev_item_4_title: 'ವೈದ್ಯಕೀಯ ದಾಖಲೆಗಳಿದ್ದರೆ ಇಟ್ಟುಕೊಳ್ಳಿ',
      ev_item_4_desc: 'ವೈದ್ಯರ ಪ್ರಿಸ್ಕ್ರಿಪ್ಷನ್‌ಗಳು, ಚಿಕಿತ್ಸೆಯ ರಸೀದಿಗಳು ಮತ್ತು MLC ಪತ್ರಗಳನ್ನು ಭದ್ರವಾಗಿಡಿ.',
      ev_item_5_title: 'ಸಾಕ್ಷಿಗಳ ವಿವರಗಳನ್ನು ಬರೆದುಕೊಳ್ಳಿ',
      ev_item_5_desc: 'ಘಟನೆಯನ್ನು ನೋಡಿದ ಜನರ ಹೆಸರುಗಳು, ಫೋನ್ ನಂಬರ್‌ಗಳು ಅಥವಾ ವಾಹನ ಸಂಖ್ಯೆಗಳನ್ನು ನಮೂದಿಸಿ.',
      ev_item_6_title: 'ಹತ್ತಿರದಲ್ಲಿರುವ ಸಿಸಿಟಿವಿಯನ್ನು ಗಮನಿಸಿ',
      ev_item_6_desc: 'ಟ್ರಾಫಿಕ್ ಕ್ಯಾಮೆರಾಗಳು, ಎಟಿಎಂ ಅಥವಾ ಅಂಗಡಿಗಳ ಸಿಸಿಟಿವಿ ಕ್ಯಾಮೆರಾಗಳನ್ನು ಗುರುತಿಸಿ.'
    },

    hi: {
      // Navigation
      navHome: 'होम',
      navContacts: 'संपर्क',
      navTips: 'टिप्स',
      navProfile: 'प्रोफ़ाइल',

      // Home Screen
      homeEmergencyTitle: 'क्या आप आपात स्थिति में हैं?',
      homeEmergencySub: 'SOS बटन दबाएं, आपके संपर्कों को सूचना भेजी जाएगी',
      homeYouAreSafe: 'आप सुरक्षित हैं',
      homeLiveLocation: 'लाइव लोकेशन',
      homeShareLocation: 'लोकेशन शेयर करें',
      homeHistory: 'इतिहास',
      homeCallPolice: 'सहायता और अधिकार',
      homeHelpRights: 'सहायता और अधिकार',
      homeNearbyPlaces: 'नजदीकी स्थान',
      homeVolunteers: 'स्वयंसेवक',
      homeSafeTimer: 'सेफ टाइमर',
      homeFakeCall: 'फेक कॉल',
      homeTips: 'टिप्स',
      homeEvidence: 'साक्ष्य',
      homeTrustedContacts: 'विश्वसनीय संपर्क:',
      homeVolunteersNearby: 'आसपास स्वयंसेवक:',

      // SOS
      sosActivated: 'SOS सक्रिय हुआ',
      sosAlertActive: 'SOS अलर्ट सक्रिय',
      sosAlertSentDesc: 'आपकी आपातकालीन लोकेशन और अलर्ट संपर्कों को भेज दिया गया है।',
      sosCall112: '112 पर कॉल करें',
      sosImSafe: 'मैं सुरक्षित हूँ',
      sosCancel: 'रद्द करें',
      sosWaitingVolunteers: 'स्वयंसेवकों की प्रतीक्षा है...',
      sosOneVolunteerOnWay: '1 स्वयंसेवक रास्ते में है',

      // Contacts
      contactsTitle: 'आपातकालीन संपर्क',
      addContact: 'संपर्क जोड़ें',

      // Profile & Settings
      profileTitle: 'प्रोफ़ाइल और सेटिंग्स',
      editProfile: 'प्रोफ़ाइल एडिट करें',
      securitySection: 'सुरक्षा',
      changePin: 'सुरक्षा पिन बदलें',
      languageSection: 'भाषा',
      selectLanguage: 'ऐप की भाषा',
      notificationsSection: 'आपातकालीन सूचनाएं',
      alertHistorySection: 'SOS अलर्ट हिस्ट्री',
      aboutSection: 'ऐप के बारे में',
      logout: 'लॉग आउट',
      clearAllData: 'सभी डेटा हटाएं',

      // Safe Timer
      safeTimerTitle: 'सेफ टाइमर',
      startSafeTimer: 'सेफ टाइमर शुरू करें',

      // Actions & Generic
      call: 'कॉल करें',
      directions: 'रास्ता देखें',
      retry: 'पुनः प्रयास करें',
      save: 'सहेजें',

      // Help & Rights Screen
      hrScreenTitle: 'सहायता और अधिकार',
      hrWhatHappened: 'क्या हुआ?',
      hrWhatHappenedSub: 'त्वरित सलाह, हेल्पलाइन, कानून और रिपोर्टिंग चरणों के लिए टैप करें:',
      hrTabHelplines: 'हेल्पलाइन',
      hrTabLaws: 'कानून',
      hrTabFir: 'एफआईआर दर्ज करें',
      hrTabTools: 'टूल्स',
      hrSearchHelplines: 'नाम, नंबर या सेवा द्वारा खोजें...',
      hrSearchLaws: 'बीएनएस धारा, आईपीसी या शीर्षक द्वारा खोजें...',
      hrCatAll: 'सभी',
      hrCatEmergency: 'आपातकालीन',
      hrCatWomen: 'महिलाएं',
      hrCatChild: 'बच्चे',
      hrCatCyber: 'साइबर',
      hrCatLegal: 'कानूनी',
      hrCatHealth: 'स्वास्थ्य',
      hrNearestStation: 'नजदीकी पुलिस स्टेशन',
      hrWomenStation: 'महिला पुलिस स्टेशन',
      hrPrepareComplaint: 'मेरी शिकायत तैयार करें',
      hrComplaintLetter: 'शिकायत पत्र',
      hrEvidenceChecklist: 'साक्ष्य चेकलिस्ट',
      hrDisclaimer: 'सामान्य जानकारी, कानूनी सलाह नहीं। कानून और नंबर बदल सकते हैं। अंतिम जांच: नवंबर 2026। यदि आप खतरे में हैं, तो 112 पर कॉल करें।',

      // Scenarios
      scenStalkingTitle: 'पीछा करना या घूरना',
      scenStreetTitle: 'सड़क पर उत्पीड़न',
      scenWorkplaceTitle: 'कार्यस्थल पर उत्पीड़न',
      scenDomesticTitle: 'घरेलू हिंसा या दहेज प्रताड़ना',
      scenAssaultTitle: 'यौन हमला',
      scenOnlineTitle: 'ऑनलाइन उत्पीड़न या मॉर्फ्ड तस्वीरें',
      scenAcidTitle: 'एसिड हमला',

      // Law Plain Meanings (Section numbers and titles kept unchanged)
      law_63_70_meaning: 'गैंग रेप (70) सहित यौन अपराध',
      law_74_meaning: 'महिला की लज्जा भंग करने के इरादे से हमला या बल प्रयोग',
      law_75_meaning: 'अवांछित यौन चेष्टाएं, मांग या अनुचित टिप्पणियां',
      law_76_meaning: 'महिला को विवस्त्र करने के इरादे से हमला या बल प्रयोग',
      law_77_meaning: 'सहमति के बिना निजी तस्वीरें देखना या खींचना',
      law_78_meaning: 'इच्छा के विरुद्ध बार-बार पीछा करना या संपर्क करना',
      law_79_meaning: 'शब्द, ध्वनियां या इशारे जो महिला की गरिमा का अपमान करते हैं',
      law_80_meaning: 'दहेज प्रताड़ना से जुड़ी शादी के सात साल के भीतर महिला की मृत्यु',
      law_85_86_meaning: 'विवाहित महिला के साथ क्रूरता (धारा 86 क्रूरता को परिभाषित करती है)',
      law_124_meaning: 'एसिड हमले',
      law_posh_meaning: 'कार्यस्थल पर उत्पीड़न; आंतरिक या स्थानीय शिकायत समिति',
      law_domestic_meaning: 'घरेलू हिंसा से महिलाओं का संरक्षण',
      law_dowry_meaning: 'दहेज लेने या देने पर रोक',

      // BNSS FIR Steps (Section numbers kept unchanged)
      fir_step_1: 'संज्ञेय अपराधों के लिए प्राथमिकी Section 173 BNSS (पुरानी Section 154 CrPC) के तहत दर्ज होती है।',
      fir_step_2: 'Zero FIR: घटना कहीं भी हुई हो, किसी भी पुलिस स्टेशन में दर्ज कराई जा सकती है।',
      fir_step_3: 'e-FIR: इलेक्ट्रॉनिक रूप से दी जा सकती है; शिकायतकर्ता को तीन दिनों के भीतर हस्ताक्षर करना होता है।',
      fir_step_4: 'बलात्कार, यौन उत्पीड़न, ताक-झांक और पीछा करने जैसे अपराधों के लिए जानकारी महिला पुलिस अधिकारी द्वारा दर्ज की जाती है।',
      fir_step_5: 'शिकायतकर्ता को FIR की निःशुल्क प्रति प्राप्त होती है (Section 173(2))।',
      fir_step_6: 'यदि पुलिस इनकार करती है, तो Sections 173(4) और 175(3) के तहत उपाय उपलब्ध हैं: पुलिस अधीक्षक (SP) को लिखें या मजिस्ट्रेट से संपर्क करें।',

      // Evidence Checklist items
      ev_item_1_title: 'स्क्रीनशॉट और वॉयस नोट्स सुरक्षित रखें',
      ev_item_1_desc: 'समय और तारीख के साथ स्क्रीनशॉट लें और ऑडियो फाइलों का सुरक्षित बैकअप रखें।',
      ev_item_2_title: 'संदेश न हटाएं',
      ev_item_2_desc: 'मूल चैट, ईमेल और कॉल रिकॉर्ड्स को प्राथमिक डिजिटल साक्ष्य के रूप में सुरक्षित रखें।',
      ev_item_3_title: 'तारीख, समय और स्थान नोट करें',
      ev_item_3_desc: 'याद रहते ही सटीक समय, तारीख और घटनास्थल के लैंडमार्क लिख लें।',
      ev_item_4_title: 'यदि कोई मेडिकल रिकॉर्ड है तो रखें',
      ev_item_4_desc: 'डॉक्टर के पर्चे, इलाज की रसीदें और मेडिको-लीगल केस (MLC) रिपोर्ट सुरक्षित रखें।',
      ev_item_5_title: 'गवाहों का विवरण लिखें',
      ev_item_5_desc: 'घटना देखने वाले लोगों के नाम, फोन नंबर या वाहन नंबर नोट कर लें।',
      ev_item_6_title: 'आसपास किसी सीसीटीवी को नोट करें',
      ev_item_6_desc: 'ट्रैफिक कैमरे, एटीएम या दुकानों के सीसीटीवी कैमरों की स्थिति नोट करें।'
    }
  };

  function t(key) {
    if (translations[currentLang] && translations[currentLang][key]) {
      return translations[currentLang][key];
    }
    return (translations.en && translations.en[key]) ? translations.en[key] : key;
  }

  function applyTranslations() {
    if (document.documentElement) {
      document.documentElement.lang = currentLang || 'en';
    }

    var elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(function(el) {
      var key = el.getAttribute('data-i18n');
      var translated = t(key);
      if (translated) {
        el.textContent = translated;
        if (currentLang && currentLang !== 'en') {
          el.setAttribute('lang', currentLang);
        } else {
          el.removeAttribute('lang');
        }
      }
    });

    // Update select element if present
    var selectEl = document.getElementById('profile-language-select');
    if (selectEl) {
      selectEl.value = currentLang;
    }

    if (SafeHer.helpRights && SafeHer.helpRights.render) {
      SafeHer.helpRights.render();
    }
  }

  function setLanguage(lang) {
    if (!translations[lang]) lang = 'en';
    currentLang = lang;

    if (SafeHer.api && SafeHer.api.setLanguage) {
      SafeHer.api.setLanguage(lang);
    }

    applyTranslations();
  }

  function getLanguage() {
    return currentLang;
  }

  function init() {
    var savedLang = (SafeHer.api && SafeHer.api.getLanguage) ? SafeHer.api.getLanguage() : 'en';
    if (translations[savedLang]) {
      currentLang = savedLang;
    } else {
      currentLang = 'en';
    }
    applyTranslations();
  }

  return {
    init: init,
    t: t,
    setLanguage: setLanguage,
    getLanguage: getLanguage,
    applyTranslations: applyTranslations
  };
})();
