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

  // PUT /api/alerts/:id  →  body: { status, lat, lng }
  updateAlert: function(id, data) {
    var all = SafeHer.storage.get('alerts') || [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) {
        if (data.status !== undefined) all[i].status = data.status;
        if (data.lat !== undefined) all[i].lat = data.lat;
        if (data.lng !== undefined) all[i].lng = data.lng;
        break;
      }
    }
    SafeHer.storage.set('alerts', all);
  },

  // GET /api/tips  →  [{ id, title, body }]
  getTips: function() {
    return SafeHer.storage.get('tips') || [];
  }
};
