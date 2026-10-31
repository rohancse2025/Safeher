/* SafeHer — app.js
   Working: SOS (geolocation + countdown) and Contacts (localStorage).
   All other screens use sample/display-only data.
*/

// Translations: nav labels, screen headings, SOS button text
var T = {
  en: {
    nav_home: 'Home', nav_contacts: 'Contacts', nav_police: 'Police',
    nav_volunteer: 'Volunteer', nav_more: 'More',
    sos: 'SOS',
    h2_login: 'Login', h2_register: 'Register',
    h2_sos_sent: 'SOS Sent', h2_contacts: 'Trusted Contacts',
    h2_location: 'Live Location', h2_nearby: 'Nearby Police and Hospitals',
    h2_helplines: 'Emergency Helplines', h2_volunteer: 'Volunteer Mode',
    h2_timer: 'Safe-Arrival Timer', h2_fakecall: 'Incoming Call',
    h2_language: 'Language Settings'
  },
  kn: {
    nav_home: 'ಮನೆ', nav_contacts: 'ಸಂಪರ್ಕ', nav_police: 'ಪೊಲೀಸ್',
    nav_volunteer: 'ಸ್ವಯಂಸೇವಕ', nav_more: 'ಇನ್ನಷ್ಟು',
    sos: 'SOS',
    h2_login: 'ಲಾಗಿನ್', h2_register: 'ನೋಂದಣಿ',
    h2_sos_sent: 'SOS ಕಳಿಸಲಾಯಿತು', h2_contacts: 'ವಿಶ್ವಾಸಾರ್ಹ ಸಂಪರ್ಕ',
    h2_location: 'ನೇರ ಸ್ಥಳ', h2_nearby: 'ಹತ್ತಿರದ ಪೊಲೀಸ್ ಮತ್ತು ಆಸ್ಪತ್ರೆ',
    h2_helplines: 'ತುರ್ತು ಸಂಖ್ಯೆಗಳು', h2_volunteer: 'ಸ್ವಯಂಸೇವಕ ಮೋಡ್',
    h2_timer: 'ಸುರಕ್ಷಿತ ಆಗಮನ ಟೈಮರ್', h2_fakecall: 'ಒಳಬರುವ ಕರೆ',
    h2_language: 'ಭಾಷಾ ಸೆಟ್ಟಿಂಗ್'
  },
  hi: {
    nav_home: 'होम', nav_contacts: 'संपर्क', nav_police: 'पुलिस',
    nav_volunteer: 'स्वयंसेवक', nav_more: 'अधिक',
    sos: 'SOS',
    h2_login: 'लॉगिन', h2_register: 'रजिस्टर',
    h2_sos_sent: 'SOS भेजा गया', h2_contacts: 'विश्वसनीय संपर्क',
    h2_location: 'लाइव लोकेशन', h2_nearby: 'नजदीकी पुलिस और अस्पताल',
    h2_helplines: 'आपातकालीन हेल्पलाइन', h2_volunteer: 'स्वयंसेवक मोड',
    h2_timer: 'सुरक्षित पहुंचने का टाइमर', h2_fakecall: 'इनकमिंग कॉल',
    h2_language: 'भाषा सेटिंग'
  }
};

var lang     = 'en';
var sosTimer = null;
var sosCount = 5;
var timerInt = null;
var timerSecs = 0;
var volOn    = false;

/* ---- Screen switching ---- */

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) {
    s.classList.remove('active');
  });
  document.getElementById(id).classList.add('active');
  setNavActive(id);
  document.getElementById('more-menu').style.display = 'none';
  // refresh contacts table when navigating to that screen
  if (id === 'screen-contacts') renderContacts();
  // reset fake call UI every time it's opened
  if (id === 'screen-fakecall') resetFakeCall();
}

// highlight the correct bottom nav button
function setNavActive(id) {
  var map = {
    'screen-home':      'nav-home',
    'screen-contacts':  'nav-contacts',
    'screen-nearby':    'nav-police',
    'screen-volunteer': 'nav-volunteer'
  };
  document.querySelectorAll('.nav-btn').forEach(function(b) {
    b.classList.remove('active-nav');
  });
  if (map[id]) document.getElementById(map[id]).classList.add('active-nav');
}

/* ---- Auth (demo — any input accepted) ---- */

function doLogin(e) {
  e.preventDefault();
  document.getElementById('bottomnav').style.display = 'flex';
  showScreen('screen-home');
}

function doRegister(e) {
  e.preventDefault();
  document.getElementById('bottomnav').style.display = 'flex';
  showScreen('screen-home');
}

/* ---- SOS (working) ---- */

function startSOS() {
  document.getElementById('sos-btn').style.display = 'none';
  document.getElementById('sos-instruction').style.display = 'none';
  document.getElementById('sos-countdown').style.display = 'block';
  sosCount = 5;
  document.getElementById('countdown-text').textContent = 'Sending SOS in 5...';
  sosTimer = setInterval(function() {
    sosCount--;
    if (sosCount <= 0) {
      clearInterval(sosTimer);
      fireSOS();
    } else {
      document.getElementById('countdown-text').textContent = 'Sending SOS in ' + sosCount + '...';
    }
  }, 1000);
}

function cancelSOS() {
  clearInterval(sosTimer);
  document.getElementById('sos-btn').style.display = 'block';
  document.getElementById('sos-instruction').style.display = 'block';
  document.getElementById('sos-countdown').style.display = 'none';
}

function fireSOS() {
  // try geolocation; fall back to default Bengaluru coords if denied or unavailable
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(showSOSSent, function() {
      showSOSSent({ coords: { latitude: 12.9716, longitude: 77.5946 } });
    }, { timeout: 6000 });
  } else {
    showSOSSent({ coords: { latitude: 12.9716, longitude: 77.5946 } });
  }
}

function showSOSSent(pos) {
  var lat = pos.coords.latitude;
  var lon = pos.coords.longitude;
  var now = new Date();
  var timeStr = now.toLocaleTimeString('en-IN') + ' on ' + now.toLocaleDateString('en-IN');
  var mapUrl  = 'https://maps.google.com/?q=' + lat.toFixed(5) + ',' + lon.toFixed(5);

  // read saved contacts for the notification list
  var contacts = getContacts();
  var names = contacts.length > 0
    ? contacts.map(function(c) { return c.name; }).join(', ')
    : 'No contacts saved. Add contacts in the Contacts tab.';

  document.getElementById('sos-sent-details').innerHTML =
    '<p><strong>Time:</strong> ' + timeStr + '</p>' +
    '<p><strong>Location:</strong> <a href="' + mapUrl + '" target="_blank">Open in Google Maps</a></p>' +
    '<p><strong>Coordinates:</strong> ' + lat.toFixed(5) + ', ' + lon.toFixed(5) + '</p>' +
    '<p><strong>Contacts notified:</strong> ' + names + '</p>';

  // reset SOS button state
  document.getElementById('sos-btn').style.display = 'block';
  document.getElementById('sos-instruction').style.display = 'block';
  document.getElementById('sos-countdown').style.display = 'none';

  showScreen('screen-sos-sent');
}

/* ---- Contacts (working — localStorage) ---- */

function getContacts() {
  try {
    return JSON.parse(localStorage.getItem('safeher_contacts') || '[]');
  } catch (e) {
    return [];
  }
}

function saveContacts(arr) {
  localStorage.setItem('safeher_contacts', JSON.stringify(arr));
}

function addContact(e) {
  e.preventDefault();
  var name  = document.getElementById('c-name').value.trim();
  var phone = document.getElementById('c-phone').value.trim();
  var email = document.getElementById('c-email').value.trim();
  if (!name || !phone) return;
  var arr = getContacts();
  arr.push({ name: name, phone: phone, email: email });
  saveContacts(arr);
  document.getElementById('c-name').value  = '';
  document.getElementById('c-phone').value = '';
  document.getElementById('c-email').value = '';
  renderContacts();
}

function deleteContact(i) {
  var arr = getContacts();
  arr.splice(i, 1);
  saveContacts(arr);
  renderContacts();
}

function renderContacts() {
  var arr = getContacts();
  var div = document.getElementById('contacts-list');
  if (arr.length === 0) {
    div.innerHTML = '<p style="color:#666;margin-top:8px;">No contacts added yet.</p>';
    return;
  }
  var rows = arr.map(function(c, i) {
    return '<tr>' +
      '<td>' + c.name + '</td>' +
      '<td>' + c.phone + '</td>' +
      '<td>' + (c.email || '-') + '</td>' +
      '<td><button onclick="deleteContact(' + i + ')" ' +
      'style="background:#c0392b;color:#fff;border:none;padding:4px 8px;' +
      'cursor:pointer;font-size:0.82em;font-family:Arial,sans-serif;">Delete</button></td>' +
      '</tr>';
  });
  div.innerHTML =
    '<table><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th></th></tr></thead>' +
    '<tbody>' + rows.join('') + '</tbody></table>';
}

/* ---- Volunteer (display only) ---- */

function toggleVol() {
  volOn = !volOn;
  document.getElementById('vol-status').textContent = volOn ? 'Available' : 'Unavailable';
  document.getElementById('vol-btn').textContent    = volOn ? 'Set Unavailable' : 'Set Available';
  document.getElementById('vol-alert-card').style.display = volOn ? 'block' : 'none';
}

function respondVol() {
  alert('Response sent. Navigating to Lakshmi R. near Silk Board, Bengaluru.');
}

/* ---- Safe-Arrival Timer (display only) ---- */

function startTimer(e) {
  e.preventDefault();
  var mins = parseInt(document.getElementById('timer-mins').value, 10);
  if (!mins || mins < 1) return;
  if (timerInt) clearInterval(timerInt);
  timerSecs = mins * 60;
  document.getElementById('timer-display').style.display = 'block';
  updateTimerText();
  timerInt = setInterval(function() {
    timerSecs--;
    if (timerSecs <= 0) {
      clearInterval(timerInt);
      document.getElementById('timer-text').textContent = 'Time is up! Please confirm you are safe.';
    } else {
      updateTimerText();
    }
  }, 1000);
}

function updateTimerText() {
  var m = Math.floor(timerSecs / 60);
  var s = timerSecs % 60;
  document.getElementById('timer-text').textContent =
    'Time remaining: ' + m + 'm ' + (s < 10 ? '0' : '') + s + 's';
}

function safeArrival() {
  if (timerInt) clearInterval(timerInt);
  document.getElementById('timer-display').style.display = 'none';
  document.getElementById('timer-mins').value = '';
  alert('Safe arrival confirmed. Timer stopped.');
}

/* ---- Fake Call (display only) ---- */

function resetFakeCall() {
  document.getElementById('fakecall-btns').style.display   = 'flex';
  document.getElementById('fakecall-active').style.display = 'none';
}

function acceptCall() {
  document.getElementById('fakecall-btns').style.display   = 'none';
  document.getElementById('fakecall-active').style.display = 'block';
}

function declineCall() { showScreen('screen-home'); }

function endCall() {
  resetFakeCall();
  showScreen('screen-home');
}

/* ---- Language ---- */

function setLang(code) {
  lang = code;
  var tr = T[code];
  // nav labels
  document.getElementById('nav-home').textContent      = tr.nav_home;
  document.getElementById('nav-contacts').textContent  = tr.nav_contacts;
  document.getElementById('nav-police').textContent    = tr.nav_police;
  document.getElementById('nav-volunteer').textContent = tr.nav_volunteer;
  document.getElementById('nav-more').textContent      = tr.nav_more;
  // SOS button text
  document.getElementById('sos-btn').textContent = tr.sos;
  // screen headings
  document.getElementById('h2-login').textContent     = tr.h2_login;
  document.getElementById('h2-register').textContent  = tr.h2_register;
  document.getElementById('h2-sos-sent').textContent  = tr.h2_sos_sent;
  document.getElementById('h2-contacts').textContent  = tr.h2_contacts;
  document.getElementById('h2-location').textContent  = tr.h2_location;
  document.getElementById('h2-nearby').textContent    = tr.h2_nearby;
  document.getElementById('h2-helplines').textContent = tr.h2_helplines;
  document.getElementById('h2-volunteer').textContent = tr.h2_volunteer;
  document.getElementById('h2-timer').textContent     = tr.h2_timer;
  document.getElementById('h2-fakecall').textContent  = tr.h2_fakecall;
  document.getElementById('h2-language').textContent  = tr.h2_language;
  // confirmation note
  var names = { en: 'English', kn: 'Kannada', hi: 'Hindi' };
  document.getElementById('lang-note').textContent = 'Language set to ' + names[code] + '.';
}

/* ---- More menu toggle ---- */

function toggleMore() {
  var m = document.getElementById('more-menu');
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
}

/* ---- Init ---- */

window.onload = function() {
  showScreen('screen-login');
};
