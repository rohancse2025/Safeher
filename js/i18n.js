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
      homeCallPolice: 'Call Police',
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
      save: 'Save'
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
      homeCallPolice: 'ಪೊಲೀಸರಿಗೆ ಕರೆ',
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
      save: 'ಉಳಿಸಿ'
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
      homeCallPolice: 'पुलिस को कॉल करें',
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
      save: 'सहेजें'
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
