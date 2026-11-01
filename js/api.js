// js/api.js – all data reads and writes go through here.
// Each function notes the real backend endpoint it will replace.
// Replace localStorage bodies with fetch() calls when the server is ready.

SafeHer.api = {

  // ─── Auth / Session ────────────────────────────────────────

  // GET /api/auth/me  →  { id, name, phone, email } or null
  isLoggedIn: function() {
    return !!SafeHer.storage.get('user');
  },

  // GET /api/auth/me
  getUser: function() {
    return SafeHer.storage.get('user');
  },

  // (internal) – persist session locally; JWT stored here in production
  setUser: function(user) {
    SafeHer.storage.set('user', user);
  },

  // POST /api/auth/logout
  clearUser: function() {
    SafeHer.storage.remove('user');
  },

  // PUT /api/auth/me  →  body: { name, phone }
  updateUser: function(data) {
    var user = this.getUser();
    if (!user) return null;
    user.name = data.name;
    user.phone = data.phone;
    this.setUser(user);

    var users = SafeHer.storage.get('users') || [];
    for (var i = 0; i < users.length; i++) {
      if (users[i].id === user.id) {
        users[i].name = data.name;
        users[i].phone = data.phone;
        break;
      }
    }
    SafeHer.storage.set('users', users);
    return user;
  },

  // GET /api/user/notifications  →  { smsAlerts, soundAlarm, liveLocation }
  getNotificationSettings: function() {
    var user = this.getUser();
    var userId = user ? user.id : 'guest';
    var all = SafeHer.storage.get('notification_settings') || {};
    var defaults = { smsAlerts: true, soundAlarm: true, liveLocation: true };
    return all[userId] || defaults;
  },

  // PUT /api/user/notifications  →  body: { smsAlerts, soundAlarm, liveLocation }
  setNotificationSettings: function(settings) {
    var user = this.getUser();
    var userId = user ? user.id : 'guest';
    var all = SafeHer.storage.get('notification_settings') || {};
    all[userId] = settings;
    SafeHer.storage.set('notification_settings', all);
    return settings;
  },

  // POST /api/user/reset  →  resets all local state
  clearAllData: function() {
    SafeHer.storage.clearAll();
  },

  // GET /api/users?phone=xxx  →  user object or null
  findUserByPhone: function(phone) {
    var users = SafeHer.storage.get('users') || [];
    for (var i = 0; i < users.length; i++) {
      if (users[i].phone === phone) return users[i];
    }
    return null;
  },

  // POST /api/auth/register  →  body: { name, phone, email, password }
  // Note: backend will hash the password and return a JWT; plaintext here is demo only.
  registerUser: function(data) {
    var users = SafeHer.storage.get('users') || [];
    var user = {
      id:       Date.now(),
      name:     data.name,
      phone:    data.phone,
      email:    data.email,
      password: data.password   // demo only – backend hashes this
    };
    users.push(user);
    SafeHer.storage.set('users', users);
    SafeHer.api.setUser({ id: user.id, name: user.name, phone: user.phone, email: user.email });
    return user;
  },

  // POST /api/auth/login  →  body: { phone, password }  →  returns { token, user }
  loginUser: function(phone, password) {
    var users = SafeHer.storage.get('users') || [];
    var found = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].phone === phone && users[i].password === password) {
        found = users[i]; break;
      }
    }
    if (!found) return null;
    var session = { id: found.id, name: found.name, phone: found.phone, email: found.email };
    SafeHer.api.setUser(session);
    return session;
  },

  // POST /api/auth/send-otp  →  body: { phone }
  sendOTP: function(phone) {
    // Real OTP will be sent via SMS from the backend
    return true;
  },

  // POST /api/auth/verify-otp  →  body: { phone, otp }
  verifyOTP: function(phone, otp) {
    // Real OTP check on the backend; demo accepts any 4 digits
    return typeof otp === 'string' && /^\d{4}$/.test(otp);
  },

  // ─── Onboarding ────────────────────────────────────────────

  // GET /api/onboarding/status  →  { done: true/false }
  hasSeenOnboarding: function() {
    return !!SafeHer.storage.get('onboarding_done');
  },

  // POST /api/onboarding/complete
  markOnboardingDone: function() {
    SafeHer.storage.set('onboarding_done', true);
  },

  // ─── Contacts ──────────────────────────────────────────────

  // GET /api/contacts  →  [{ id, name, phone, email, relation, userId }]
  getContacts: function() {
    var user = this.getUser();
    var userId = user ? user.id : 'guest';
    var all = SafeHer.storage.get('contacts') || [];
    return all.filter(function(c) {
      return (c.userId || 'guest') === userId;
    });
  },

  // POST /api/contacts  →  body: { name, phone, email, relation }
  addContact: function(contact) {
    var user = this.getUser();
    var userId = user ? user.id : 'guest';
    var all = SafeHer.storage.get('contacts') || [];
    contact.id = Date.now();
    contact.userId = userId;
    all.push(contact);
    SafeHer.storage.set('contacts', all);
    return contact;
  },

  // PUT /api/contacts/:id  →  body: { name, phone, email, relation }
  updateContact: function(id, data) {
    var user = this.getUser();
    var userId = user ? user.id : 'guest';
    var all = SafeHer.storage.get('contacts') || [];
    var updated = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id && (all[i].userId || 'guest') === userId) {
        all[i].name = data.name;
        all[i].phone = data.phone;
        all[i].email = data.email || '';
        all[i].relation = data.relation || 'Other';
        updated = all[i];
        break;
      }
    }
    SafeHer.storage.set('contacts', all);
    return updated;
  },

  // DELETE /api/contacts/:id
  removeContact: function(id) {
    var user = this.getUser();
    var userId = user ? user.id : 'guest';
    var all = SafeHer.storage.get('contacts') || [];
    var filtered = all.filter(function(c) {
      return !(c.id === id && (c.userId || 'guest') === userId);
    });
    SafeHer.storage.set('contacts', filtered);
  },

  // ─── Safety PIN ───────────────────────────────────────────

  // Internal helper to create a random salt
  _generateSalt: function() {
    var arr = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(arr);
    } else {
      for (var i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr).map(function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  },

  // Compute SHA-256 with salt; fallback simple hash if crypto.subtle is unavailable
  hashPin: function(pin, salt, callback) {
    salt = salt || this._generateSalt();
    var text = salt + ':' + pin;

    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      var enc = new TextEncoder().encode(text);
      window.crypto.subtle.digest('SHA-256', enc).then(function(buf) {
        var hashHex = Array.from(new Uint8Array(buf)).map(function(b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
        callback({ salt: salt, hash: hashHex });
      }).catch(function() {
        var fallback = SafeHer.api._fallbackHash(text);
        callback({ salt: salt, hash: fallback });
      });
    } else {
      var fallback = SafeHer.api._fallbackHash(text);
      callback({ salt: salt, hash: fallback });
    }
  },

  _fallbackHash: function(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  },

  // GET /api/user/pin  →  { salt, hash } or null
  getPinData: function() {
    var user = this.getUser();
    var userId = user ? user.id : 'guest';
    var pins = SafeHer.storage.get('user_pins') || {};
    return pins[userId] || null;
  },

  hasPin: function() {
    return !!this.getPinData();
  },

  // POST /api/user/pin  →  body: { salt, hash }
  setPin: function(pin, callback) {
    var self = this;
    this.hashPin(pin, null, function(res) {
      var user = self.getUser();
      var userId = user ? user.id : 'guest';
      var pins = SafeHer.storage.get('user_pins') || {};
      pins[userId] = res;
      SafeHer.storage.set('user_pins', pins);
      if (callback) callback(true);
    });
  },

  // POST /api/user/pin/verify  →  body: { pin }
  verifyPin: function(pin, callback) {
    var pinData = this.getPinData();
    if (!pinData) {
      if (callback) callback(false);
      return;
    }
    this.hashPin(pin, pinData.salt, function(res) {
      var matches = res.hash === pinData.hash;
      if (callback) callback(matches);
    });
  },

  // ─── Alerts & History ──────────────────────────────────────

  // GET /api/alerts  →  [{ id, time, timestamp, lat, lng, status, userId }]
  getAlerts: function() {
    var user = this.getUser();
    var userId = user ? user.id : 'guest';
    var all = SafeHer.storage.get('alerts') || [];
    return all.filter(function(a) {
      return (a.userId || 'guest') === userId;
    });
  },

  // POST /api/alerts  →  body: { time, timestamp, lat, lng, status }
  addAlert: function(alertData) {
    var user = this.getUser();
    var userId = user ? user.id : 'guest';
    var all = SafeHer.storage.get('alerts') || [];
    alertData.id = Date.now();
    alertData.userId = userId;
    all.unshift(alertData);
    SafeHer.storage.set('alerts', all);
    return alertData;
  },

  // PUT /api/alerts/:id  →  body: { status, lat, lng, endTime, mode }
  updateAlert: function(id, data) {
    var all = SafeHer.storage.get('alerts') || [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) {
        if (data.status !== undefined) all[i].status = data.status;
        if (data.lat !== undefined) all[i].lat = data.lat;
        if (data.lng !== undefined) all[i].lng = data.lng;
        if (data.mode !== undefined) all[i].mode = data.mode;
        if (data.endTime !== undefined) all[i].endTime = data.endTime;
        break;
      }
    }
    SafeHer.storage.set('alerts', all);
  },

  // ─── Safety Tips & Self-Defense ───────────────────────────

  // GET /api/tips?category=xxx  →  [{ id, category, icon, title, lines: [] }]
  getTips: function(category) {
    var defaultTips = [
      // General Safety Tips
      {
        id: 1,
        category: 'tips',
        icon: 'commute',
        title: 'Travelling',
        lines: [
          'Share your trip details with someone you trust.',
          'Stay on well-lit and familiar public routes.',
          'Keep your phone charged and easily accessible.'
        ]
      },
      {
        id: 2,
        category: 'tips',
        icon: 'shopping_bag',
        title: 'Shopping',
        lines: [
          'Keep your handbag closed and close to your body.',
          'Stay mindful of crowded areas and emergency exits.',
          'Avoid displaying or counting large amounts of cash.'
        ]
      },
      {
        id: 3,
        category: 'tips',
        icon: 'home',
        title: 'At Home',
        lines: [
          'Lock all doors and windows, especially at night.',
          'Verify visitors before opening the main entrance.',
          'Keep an emergency light and phone near your bed.'
        ]
      },
      {
        id: 4,
        category: 'tips',
        icon: 'public',
        title: 'Online',
        lines: [
          'Do not share your real-time location publicly.',
          'Use strong passwords and two-step verification.',
          'Never share daily routines or personal addresses.'
        ]
      },
      {
        id: 5,
        category: 'tips',
        icon: 'local_taxi',
        title: 'Cab and Auto Rides',
        lines: [
          'Confirm the vehicle registration number before entering.',
          'Share your live ride status with a friend.',
          'Avoid entering vehicles with extra unknown passengers.'
        ]
      },
      // Self-Defense Advice
      {
        id: 6,
        category: 'defense',
        icon: 'visibility',
        title: 'Stay aware of your surroundings',
        lines: [
          'Keep your head up and scan the area around you.',
          'Avoid looking down at your phone while walking alone.',
          'Remove earphones in quiet or poorly lit places.'
        ]
      },
      {
        id: 7,
        category: 'defense',
        icon: 'psychology',
        title: 'Trust your instincts',
        lines: [
          'If a situation or person makes you feel uncomfortable, leave.',
          'Do not hesitate to cross the street or change direction.',
          'Your personal safety is always more important than politeness.'
        ]
      },
      {
        id: 8,
        category: 'defense',
        icon: 'battery_charging_full',
        title: 'Keep your phone charged',
        lines: [
          'Carry a compact power bank when heading out for the day.',
          'Maintain your phone battery above twenty percent.',
          'Ensure emergency contacts are saved and easy to dial.'
        ]
      },
      {
        id: 9,
        category: 'defense',
        icon: 'call',
        title: 'Know your emergency numbers',
        lines: [
          'Remember 112 for national emergency services.',
          'Keep 181 for the women helpline saved on your phone.',
          'Have a quick plan for who to contact first in distress.'
        ]
      },
      {
        id: 10,
        category: 'defense',
        icon: 'storefront',
        title: 'Move to a crowded, lit place',
        lines: [
          'Head toward open stores, pharmacies, or lit transit stops.',
          'Approach security personnel or staff if you feel followed.',
          'Call out loudly for assistance if anyone approaches aggressively.'
        ]
      }
    ];

    var stored = SafeHer.storage.get('tips_list');
    if (!stored || stored.length === 0) {
      stored = defaultTips;
      SafeHer.storage.set('tips_list', stored);
    }

    if (category) {
      return stored.filter(function(t) { return t.category === category; });
    }
    return stored;
  }
};
