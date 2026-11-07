// js/api.js – Unified API abstraction layer with Flask backend integration and offline localStorage fallback
// Connects to Flask backend endpoints while preserving identical function signatures across all modules.

SafeHer.api = (function() {

  // ─── Configuration & State ─────────────────────────────────
  function getApiBase() {
    return (window.SafeHerConfig && window.SafeHerConfig.API_BASE) || 'http://localhost:5000';
  }

  function useBackend() {
    return !!(window.SafeHerConfig && window.SafeHerConfig.USE_BACKEND);
  }

  var offlineNotified = false;

  function showOfflineNotice(show) {
    var badge = document.getElementById('offline-mode-badge');
    if (!badge && show) {
      badge = document.createElement('div');
      badge.id = 'offline-mode-badge';
      badge.className = 'offline-mode-badge';
      badge.textContent = 'Offline mode';
      badge.title = 'Backend server unreachable. Tap to configure server URL.';
      badge.style.cursor = 'pointer';
      badge.onclick = function() {
        if (SafeHer.profile && SafeHer.profile.changeServerUrl) {
          SafeHer.profile.changeServerUrl();
        } else {
          var curr = getApiBase();
          var suggested = (window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') ? (window.location.protocol + '//' + window.location.hostname + ':5000') : 'http://10.44.69.36:5000';
          var defaultVal = (curr && curr.indexOf('localhost') === -1) ? curr : suggested;
          var input = prompt('Backend is unreachable at ' + curr + '\n\nTo connect your phone to your laptop on the same Wi-Fi, enter your laptop IP URL:\n(e.g. ' + suggested + ')\n\nOr tap OK to use suggested URL, or "reset" to reset:', defaultVal);
          if (input !== null) {
            var trimmed = input.trim().replace(/\/+$/, '');
            if (!trimmed || trimmed.toLowerCase() === 'reset') {
              try { localStorage.removeItem('safeher_api_base'); } catch (e) {}
            } else {
              try { localStorage.setItem('safeher_api_base', trimmed); } catch (e) {}
            }
            window.location.reload();
          }
        }
      };
      document.body.appendChild(badge);
    }
    if (badge) {
      badge.style.display = show ? 'block' : 'none';
    }
    if (show && !offlineNotified) {
      offlineNotified = true;
      if (SafeHer.toast) SafeHer.toast('Offline mode: Backend unreachable. Tap badge to fix URL.');
    } else if (!show) {
      offlineNotified = false;
    }
  }

  function getToken() {
    try {
      var tok = SafeHer.storage.get('auth_token');
      if (tok) return tok;
    } catch(e) {}
    try {
      return localStorage.getItem('safeher_raw_jwt') || '';
    } catch(e) {
      return '';
    }
  }

  function setToken(token) {
    if (token) {
      SafeHer.storage.set('auth_token', token);
      try { localStorage.setItem('safeher_raw_jwt', token); } catch(e) {}
    } else {
      SafeHer.storage.remove('auth_token');
      try { localStorage.removeItem('safeher_raw_jwt'); } catch(e) {}
    }
  }

  // ─── Network Request Loading Indicator ────────────────────
  var activeRequests = 0;

  function showLoadingIndicator() {
    activeRequests++;
    var bar = document.getElementById('global-loading-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'global-loading-bar';
      bar.className = 'global-loading-bar';
      document.body.appendChild(bar);
    }
    bar.classList.remove('done');
    bar.classList.add('active');
  }

  function hideLoadingIndicator() {
    activeRequests = Math.max(0, activeRequests - 1);
    if (activeRequests === 0) {
      var bar = document.getElementById('global-loading-bar');
      if (bar) {
        bar.classList.remove('active');
        bar.classList.add('done');
        setTimeout(function() {
          if (activeRequests === 0) {
            bar.classList.remove('done');
          }
        }, 300);
      }
    }
  }

  // ─── Network Fetch Helper (10s timeout, loading bar, friendly retry) ──────
  function apiFetch(endpoint, options) {
    if (!useBackend()) {
      showOfflineNotice(true);
      return Promise.reject(new Error('Backend disabled'));
    }

    options = options || {};
    var headers = options.headers || {};
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';

    var token = getToken();
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    options.headers = headers;

    // 10-second timeout on all fetches via AbortController
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutId = null;
    if (controller && !options.signal) {
      options.signal = controller.signal;
      timeoutId = setTimeout(function() {
        controller.abort();
      }, 10000);
    }

    var url = getApiBase().replace(/\/+$/, '') + endpoint;

    var isBackground = !!(options._silent ||
                       endpoint.indexOf('/evidence') !== -1 ||
                       endpoint.indexOf('/chunk') !== -1 ||
                       endpoint.indexOf('/contacts') !== -1 ||
                       endpoint.indexOf('/escorts/active') !== -1 ||
                       endpoint.indexOf('/nearby-alerts') !== -1 ||
                       endpoint.indexOf('/volunteers/count') !== -1 ||
                       endpoint.indexOf('/volunteers/profile') !== -1 ||
                       endpoint.indexOf('/timers/active') !== -1 ||
                       (endpoint.indexOf('/status') !== -1 && endpoint.indexOf('/api/alerts/') !== -1));

    if (!isBackground) {
      showLoadingIndicator();
    }

    return fetch(url, options)
      .then(function(res) {
        if (timeoutId) clearTimeout(timeoutId);
        return res.json().then(function(json) {
          if (!res.ok) {
            var msg = json && json.error ? json.error : ('Request failed with status ' + res.status);
            if (res.status === 401 && endpoint !== '/api/login' && endpoint !== '/api/register') {
              // Token expired
              setToken(null);
            }
            var err = new Error(msg);
            err.status = res.status;
            err.data = json;
            throw err;
          }
          showOfflineNotice(false);
          return json;
        });
      })
      .catch(function(err) {
        if (timeoutId) clearTimeout(timeoutId);

        var isTimeout = (err.name === 'AbortError');
        if (isTimeout) {
          err = new Error('Request timed out after 10 seconds');
          err.isTimeout = true;
        }

        var isNetworkError = (err.name === 'TypeError' || err.message === 'Failed to fetch' || err.message === 'NetworkError' || isTimeout);
        if (isNetworkError) {
          showOfflineNotice(true);
        }

        // Friendly error message with Retry button for failed explicit user requests
        if (!isBackground && err.status !== 401 && err.status !== 404 && err.status !== 405 && err.status !== 429) {
          var friendlyMsg = err.message;
          if (isTimeout) {
            friendlyMsg = 'Request timed out at ' + getApiBase() + '. Start backend.';
          } else if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
            friendlyMsg = 'Unable to reach backend at ' + getApiBase() + '. Start backend.';
          } else if (err.status >= 500) {
            friendlyMsg = 'Server temporarily unavailable.';
          }

          if (SafeHer.showRetryToast) {
            SafeHer.showRetryToast(friendlyMsg, function() {
              return apiFetch(endpoint, options);
            });
          } else if (SafeHer.toast) {
            SafeHer.toast(friendlyMsg);
          }
        }

        throw err;
      })
      .then(function(result) {
        if (!isBackground) hideLoadingIndicator();
        return result;
      }, function(err) {
        if (!isBackground) hideLoadingIndicator();
        throw err;
      });
  }

  // ─── Public API Object ─────────────────────────────────────
  return {

    // ─── Auth & Session ──────────────────────────────────────
    isLoggedIn: function() {
      return !!(getToken() && SafeHer.storage.get('user')) || !!SafeHer.storage.get('user');
    },

    getUser: function() {
      return SafeHer.storage.get('user');
    },

    setUser: function(user) {
      SafeHer.storage.set('user', user);
    },

    clearUser: function() {
      setToken(null);
      SafeHer.storage.remove('user');
    },

    getToken: getToken,
    setToken: setToken,

    // POST /api/register
    registerUser: function(data, callback) {
      var self = this;
      // Local fallback representation
      var localUsers = SafeHer.storage.get('users') || [];
      var fallbackUser = {
        id: Date.now(),
        name: data.name,
        phone: data.phone,
        email: data.email || null,
        password: data.password
      };

      if (!useBackend()) {
        localUsers.push(fallbackUser);
        SafeHer.storage.set('users', localUsers);
        self.setUser({ id: fallbackUser.id, name: fallbackUser.name, phone: fallbackUser.phone, email: fallbackUser.email });
        if (callback) callback(null, fallbackUser);
        return fallbackUser;
      }

      apiFetch('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name,
          phone: data.phone,
          email: data.email || '',
          password: data.password
        })
      }).then(function(json) {
        var resData = json.data || {};
        var user = resData.user || fallbackUser;
        var token = resData.token;
        setToken(token);
        self.setUser(user);

        // Keep local users in sync
        localUsers.push(user);
        SafeHer.storage.set('users', localUsers);

        if (callback) callback(null, user);
      }).catch(function(err) {
        // Fallback to local storage if network unreachable
        if (err.message === 'Failed to fetch' || !err.status) {
          localUsers.push(fallbackUser);
          SafeHer.storage.set('users', localUsers);
          self.setUser({ id: fallbackUser.id, name: fallbackUser.name, phone: fallbackUser.phone, email: fallbackUser.email });
          if (callback) callback(null, fallbackUser);
        } else {
          if (callback) callback(err.message, null);
        }
      });

      return fallbackUser;
    },

    // POST /api/login
    loginUser: function(phone, password, callback) {
      var self = this;
      var users = SafeHer.storage.get('users') || [];
      var localFound = null;
      for (var i = 0; i < users.length; i++) {
        if (users[i].phone === phone && users[i].password === password) {
          localFound = users[i];
          break;
        }
      }

      if (!useBackend()) {
        if (!localFound) {
          if (callback) callback('Incorrect phone number or password', null);
          return null;
        }
        var sess = { id: localFound.id, name: localFound.name, phone: localFound.phone, email: localFound.email };
        self.setUser(sess);
        if (callback) callback(null, sess);
        return sess;
      }

      apiFetch('/api/login', {
        method: 'POST',
        body: JSON.stringify({ phone: phone, password: password })
      }).then(function(json) {
        var resData = json.data || {};
        var user = resData.user;
        var token = resData.token;
        setToken(token);
        self.setUser(user);
        if (callback) callback(null, user);
      }).catch(function(err) {
        // Fallback to local user if offline and local password matches
        if ((err.message === 'Failed to fetch' || !err.status) && localFound) {
          var sess = { id: localFound.id, name: localFound.name, phone: localFound.phone, email: localFound.email };
          self.setUser(sess);
          if (callback) callback(null, sess);
        } else {
          var errMsg = err.message || 'Incorrect phone number or password';
          if (callback) callback(errMsg, null);
        }
      });

      // Synchronous return for legacy callers
      if (localFound) {
        self.setUser(localFound);
        return localFound;
      }
      return null;
    },

    // GET /api/me & PUT /api/me
    updateUser: function(data, callback) {
      var user = this.getUser();
      if (!user) return null;
      user.name = data.name;
      user.phone = data.phone;
      this.setUser(user);

      // Local storage sync
      var users = SafeHer.storage.get('users') || [];
      for (var i = 0; i < users.length; i++) {
        if (users[i].id === user.id) {
          users[i].name = data.name;
          users[i].phone = data.phone;
          break;
        }
      }
      SafeHer.storage.set('users', users);

      if (useBackend() && getToken()) {
        apiFetch('/api/me', {
          method: 'PUT',
          body: JSON.stringify({ name: data.name, phone: data.phone })
        }).then(function(json) {
          if (json.data) SafeHer.storage.set('user', json.data);
          if (callback) callback(null, json.data);
        }).catch(function(err) {
          if (callback) callback(err.message, user);
        });
      } else {
        if (callback) callback(null, user);
      }
      return user;
    },

    deleteAccount: function(pin, callback) {
      if (useBackend() && getToken()) {
        apiFetch('/api/me', {
          method: 'DELETE',
          body: JSON.stringify({ pin: pin })
        }).then(function(json) {
          if (callback) callback(null, json.data);
        }).catch(function(err) {
          if (callback) callback(err.message, null);
        });
      } else {
        if (callback) callback(null, { message: 'Deleted locally' });
      }
    },

    findUserByPhone: function(phone) {
      var users = SafeHer.storage.get('users') || [];
      for (var i = 0; i < users.length; i++) {
        if (users[i].phone === phone) return users[i];
      }
      return null;
    },

    sendOTP: function(phone) {
      return true;
    },

    verifyOTP: function(phone, otp) {
      return typeof otp === 'string' && /^\d{4}$/.test(otp);
    },

    hasSeenOnboarding: function() {
      return !!SafeHer.storage.get('onboarding_done');
    },

    markOnboardingDone: function() {
      SafeHer.storage.set('onboarding_done', true);
    },

    getNotificationSettings: function() {
      var user = this.getUser();
      var userId = user ? user.id : 'guest';
      var all = SafeHer.storage.get('notification_settings') || {};
      var defaults = { smsAlerts: true, soundAlarm: true, liveLocation: true };
      return all[userId] || defaults;
    },

    setNotificationSettings: function(settings) {
      var user = this.getUser();
      var userId = user ? user.id : 'guest';
      var all = SafeHer.storage.get('notification_settings') || {};
      all[userId] = settings;
      SafeHer.storage.set('notification_settings', all);
      return settings;
    },

    clearAllData: function() {
      setToken(null);
      SafeHer.storage.clearAll();
    },

    // ─── Contacts CRUD ─────────────────────────────────────────
    getContacts: function(callback) {
      var user = this.getUser();
      var userId = user ? user.id : 'guest';
      var all = SafeHer.storage.get('contacts') || [];
      var localList = all.filter(function(c) {
        if (!c) return false;
        if (!userId || userId === 'guest') return true;
        if (!c.userId || c.userId === 'guest') return true;
        return String(c.userId) === String(userId);
      });

      if (useBackend()) {
        var query = (userId && userId !== 'guest') ? ('?user_id=' + encodeURIComponent(userId)) : '';
        apiFetch('/api/contacts' + query, { method: 'GET', _silent: true })
          .then(function(json) {
            var serverContacts = (json.data || []).map(function(c) {
              return {
                id: c.id,
                userId: userId,
                name: c.name,
                phone: c.phone,
                email: c.email || '',
                relation: c.relationship || c.relation || 'Other',
                close: !!(c.close || c.is_close)
              };
            });
            if (serverContacts && serverContacts.length > 0) {
              SafeHer.storage.set('contacts', serverContacts);
              localList = serverContacts;
            }
            if (callback) callback(null, localList);
            if (SafeHer.home && SafeHer.home.updateContactsCount) {
              SafeHer.home.updateContactsCount(localList.length);
            }
            if (SafeHer.contacts && SafeHer.contacts.renderList) {
              SafeHer.contacts.renderList(localList);
            }
          })
          .catch(function(err) {
            if (callback) callback(null, localList);
          });
      } else {
        if (callback) callback(null, localList);
      }
      return localList;
    },

    addContact: function(contact, callback) {
      var user = this.getUser();
      var userId = user ? user.id : 'guest';
      var all = SafeHer.storage.get('contacts') || [];
      contact.id = contact.id || Date.now();
      contact.userId = userId;
      all.push(contact);
      SafeHer.storage.set('contacts', all);

      if (SafeHer.home && SafeHer.home.updateContactsCount) {
        SafeHer.home.updateContactsCount(all.length);
      }

      if (useBackend()) {
        var currentUser = this.getUser() || {};
        apiFetch('/api/contacts', {
          method: 'POST',
          body: JSON.stringify({
            name: contact.name,
            phone: contact.phone,
            email: contact.email || '',
            relationship: contact.relation || contact.relationship || 'Other',
            user_id: currentUser.id,
            phone_auth: currentUser.phone
          })
        }).then(function(json) {
          if (json.data && json.data.id) {
            contact.id = json.data.id;
            SafeHer.storage.set('contacts', all);
          }
          if (callback) callback(null, contact);
          if (SafeHer.home && SafeHer.home.refresh) SafeHer.home.refresh();
        }).catch(function(err) {
          if (callback) callback(err.message, contact);
        });
      } else {
        if (callback) callback(null, contact);
        if (SafeHer.home && SafeHer.home.refresh) SafeHer.home.refresh();
      }
      return contact;
    },

    updateContact: function(id, data, callback) {
      var user = this.getUser();
      var userId = user ? user.id : 'guest';
      var all = SafeHer.storage.get('contacts') || [];
      var updated = null;

      for (var i = 0; i < all.length; i++) {
        if (String(all[i].id) === String(id)) {
          all[i].name = data.name;
          all[i].phone = data.phone;
          all[i].email = data.email || '';
          all[i].relation = data.relation || data.relationship || 'Other';
          updated = all[i];
          break;
        }
      }
      SafeHer.storage.set('contacts', all);

      if (SafeHer.home && SafeHer.home.updateContactsCount) {
        SafeHer.home.updateContactsCount(all.length);
      }

      if (useBackend()) {
        var query = (userId && userId !== 'guest') ? ('?user_id=' + encodeURIComponent(userId)) : '';
        apiFetch('/api/contacts/' + id + query, {
          method: 'PUT',
          body: JSON.stringify({
            name: data.name,
            phone: data.phone,
            email: data.email || '',
            relationship: data.relation || data.relationship || 'Other'
          })
        }).then(function() {
          if (callback) callback(null, updated);
          if (SafeHer.home && SafeHer.home.refresh) SafeHer.home.refresh();
        }).catch(function(err) {
          if (callback) callback(err.message, updated);
        });
      } else {
        if (callback) callback(null, updated);
        if (SafeHer.home && SafeHer.home.refresh) SafeHer.home.refresh();
      }
      return updated;
    },

    removeContact: function(id, callback) {
      var user = this.getUser();
      var userId = user ? user.id : 'guest';
      var all = SafeHer.storage.get('contacts') || [];
      var filtered = all.filter(function(c) {
        return String(c.id) !== String(id);
      });
      SafeHer.storage.set('contacts', filtered);

      if (SafeHer.home && SafeHer.home.updateContactsCount) {
        SafeHer.home.updateContactsCount(filtered.length);
      }

      if (useBackend()) {
        var query = (userId && userId !== 'guest') ? ('?user_id=' + encodeURIComponent(userId)) : '';
        apiFetch('/api/contacts/' + id + query, { method: 'DELETE' })
          .then(function() {
            if (callback) callback(null, true);
            if (SafeHer.home && SafeHer.home.refresh) SafeHer.home.refresh();
          })
          .catch(function(err) {
            if (callback) callback(err.message, false);
          });
      } else {
        if (callback) callback(null, true);
        if (SafeHer.home && SafeHer.home.refresh) SafeHer.home.refresh();
      }
    },

    // ─── Safety PIN (Backend Verified) ─────────────────────────
    getPinData: function() {
      var user = this.getUser();
      var userId = user ? user.id : 'guest';
      var pins = SafeHer.storage.get('user_pins') || {};
      return pins[userId] || null;
    },

    hasPin: function() {
      var user = this.getUser();
      if (user && user.has_pin !== undefined) return Boolean(user.has_pin);
      return !!this.getPinData();
    },

    setPin: function(pin, callback, duressPin) {
      var self = this;
      var user = self.getUser();
      var userId = user ? user.id : 'guest';

      // Save local fallback hash
      self.hashPin(pin, null, function(res) {
        var pins = SafeHer.storage.get('user_pins') || {};
        pins[userId] = res;
        SafeHer.storage.set('user_pins', pins);
      });

      if (useBackend() && getToken()) {
        apiFetch('/api/pin/set', {
          method: 'POST',
          body: JSON.stringify({ pin: pin, duress_pin: duressPin || '' })
        }).then(function() {
          if (user) {
            user.has_pin = true;
            self.setUser(user);
          }
          if (callback) callback(true);
        }).catch(function(err) {
          // If offline, fallback was stored
          if (err.message === 'Failed to fetch' || !err.status) {
            if (callback) callback(true);
          } else {
            if (callback) callback(false);
          }
        });
      } else {
        if (callback) callback(true);
      }
    },

    changePin: function(oldPin, newPin, callback, duressPin) {
      if (useBackend() && getToken()) {
        apiFetch('/api/pin/change', {
          method: 'POST',
          body: JSON.stringify({ old_pin: oldPin, new_pin: newPin, duress_pin: duressPin || '' })
        }).then(function() {
          if (callback) callback(true);
        }).catch(function() {
          if (callback) callback(false);
        });
      } else {
        this.setPin(newPin, callback, duressPin);
      }
    },

    verifyPin: function(pin, callback) {
      var self = this;

      if (useBackend() && getToken()) {
        apiFetch('/api/pin/verify', {
          method: 'POST',
          body: JSON.stringify({ pin: pin })
        }).then(function(json) {
          var res = json.data && json.data.result;
          if (res === 'ok' || res === 'duress') {
            if (callback) callback(true, res);
          } else {
            if (json.data && json.data.locked) {
              if (SafeHer.toast) SafeHer.toast('Too many wrong attempts. Locked for 30s.');
            }
            if (callback) callback(false, 'wrong');
          }
        }).catch(function(err) {
          if (err.status === 429) {
            if (SafeHer.toast) SafeHer.toast('Too many wrong attempts. Locked for 30s.');
            if (callback) callback(false, 'locked');
            return;
          }
          // Fallback to local storage verification if offline
          self._verifyPinLocal(pin, callback);
        });
      } else {
        self._verifyPinLocal(pin, callback);
      }
    },

    _verifyPinLocal: function(pin, callback) {
      var pinData = this.getPinData();
      if (!pinData) {
        if (callback) callback(false);
        return;
      }
      this.hashPin(pin, pinData.salt, function(res) {
        var matches = res.hash === pinData.hash;
        if (callback) callback(matches, matches ? 'ok' : 'wrong');
      });
    },

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
          callback({ salt: salt, hash: SafeHer.api._fallbackHash(text) });
        });
      } else {
        callback({ salt: salt, hash: SafeHer.api._fallbackHash(text) });
      }
    },

    _generateSalt: function() {
      var arr = new Uint8Array(16);
      if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(arr);
      } else {
        for (var i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
      }
      return Array.from(arr).map(function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
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

    // ─── Alerts & History ──────────────────────────────────────
    getAlerts: function(callback) {
      var user = this.getUser();
      var userId = user ? user.id : 'guest';
      var all = SafeHer.storage.get('alerts') || [];
      var localList = all.filter(function(a) {
        return (a.userId || 'guest') === userId;
      });

      if (useBackend() && getToken()) {
        apiFetch('/api/alerts', { method: 'GET' })
          .then(function(json) {
            var serverAlerts = (json.data || []).map(function(a) {
              return {
                id: a.id,
                userId: userId,
                mode: a.mode,
                status: a.status,
                lat: a.lat,
                lng: a.lng,
                time: a.started_at,
                timestamp: new Date(a.started_at).getTime() || Date.now(),
                shareToken: a.share_token,
                notifiedCount: a.notified_count,
                duress: a.duress
              };
            });
            SafeHer.storage.set('alerts', serverAlerts);
            if (callback) callback(null, serverAlerts);
          })
          .catch(function(err) {
            if (callback) callback(err.message, localList);
          });
      } else {
        if (callback) callback(null, localList);
      }
      return localList;
    },

    getAlertDetails: function(alertId, callback) {
      if (useBackend() && getToken()) {
        apiFetch('/api/alerts/' + alertId + '/details', { method: 'GET' })
          .then(function(json) {
            if (callback) callback(null, json.data);
          })
          .catch(function(err) {
            if (callback) callback(err.message, null);
          });
      } else {
        var all = SafeHer.storage.get('alerts') || [];
        var match = null;
        for (var i = 0; i < all.length; i++) {
          if (all[i].id == alertId) {
            match = all[i];
            break;
          }
        }
        if (match) {
          if (callback) callback(null, {
            id: match.id,
            mode: match.mode,
            status: match.status,
            started_at: match.time || 'N/A',
            ended_at: match.endTime || 'N/A',
            duration: '05:00',
            contacts_notified: match.notifiedCount || 0,
            volunteers_responded: [],
            route: match.lat && match.lng ? [{ lat: match.lat, lng: match.lng }] : [],
            lat: match.lat,
            lng: match.lng
          });
        } else {
          if (callback) callback('Alert not found', null);
        }
      }
    },

    addAlert: function(alertData, callback) {
      var user = this.getUser();
      var userId = user ? user.id : 'guest';
      var all = SafeHer.storage.get('alerts') || [];
      alertData.id = Date.now();
      alertData.userId = userId;
      all.unshift(alertData);
      SafeHer.storage.set('alerts', all);

      if (useBackend()) {
        var maxRetries = 3;
        var attempt = 0;
        var currentUser = user || {};

        function attemptCreateAlert() {
          attempt++;
          return apiFetch('/api/alerts', {
            method: 'POST',
            body: JSON.stringify({
              mode: alertData.mode || 'normal',
              lat: alertData.lat || 12.9716,
              lng: alertData.lng || 77.5946,
              note: alertData.note || '',
              user_id: currentUser.id || userId,
              phone: currentUser.phone || ''
            }),
            _silent: true // SOS has dedicated retry & fallback UI
          }).then(function(json) {
            if (json.data && json.data.id) {
              alertData.id = json.data.id;
              alertData.shareToken = json.data.share_token;
              alertData.notifiedCount = json.data.notified_count;
              SafeHer.storage.set('alerts', all);
            }
            if (callback) callback(null, alertData, false);
            return alertData;
          }).catch(function(err) {
            // Abuse limit (429): do NOT retry, surface abuse notice
            if (err.status === 429 || (err.message && err.message.toLowerCase().indexOf('too many alerts') !== -1)) {
              var currentAll = SafeHer.storage.get('alerts') || [];
              currentAll = currentAll.filter(function(a) { return a.id !== alertData.id; });
              SafeHer.storage.set('alerts', currentAll);
              if (callback) callback(err.message, alertData, false);
              return;
            }

            // Retry up to 3 times with 1s interval
            if (attempt < maxRetries) {
              console.warn('[SOS] Create attempt ' + attempt + ' failed (' + err.message + '). Retrying in 1s...');
              setTimeout(attemptCreateAlert, 1000);
            } else {
              // Failed 3 times: trigger fallback
              console.error('[SOS] Create failed after 3 attempts. Escalating to offline emergency fallback.');
              err.offlineFallback = true;
              if (callback) callback(err.message, alertData, true);
            }
          });
        }

        attemptCreateAlert();
      } else {
        if (callback) callback(null, alertData, false);
      }
      return alertData;
    },

    updateAlert: function(id, data, callback) {
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

      if (useBackend() && getToken() && data.lat !== undefined && data.lng !== undefined) {
        apiFetch('/api/alerts/' + id + '/location', {
          method: 'POST',
          body: JSON.stringify({ lat: data.lat, lng: data.lng })
        }).then(function(json) {
          if (callback) callback(null, json.data);
        }).catch(function(err) {
          if (callback) callback(err.message, null);
        });
      } else {
        if (callback) callback(null, null);
      }
    },

    endAlert: function(id, pin, callback) {
      var self = this;
      var all = SafeHer.storage.get('alerts') || [];
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === id) {
          all[i].status = 'resolved';
          all[i].endTime = new Date().toLocaleTimeString();
          break;
        }
      }
      SafeHer.storage.set('alerts', all);
      this.clearActiveSos();

      if (useBackend()) {
        var u = this.getUser() || {};
        apiFetch('/api/alerts/' + id + '/end', {
          method: 'POST',
          body: JSON.stringify({ pin: pin, user_id: u.id || null })
        }).then(function(json) {
          if (callback) callback(null, json.data);
        }).catch(function(err) {
          if (callback) callback(err.message, null);
        });
      } else {
        if (callback) callback(null, { status: 'resolved' });
      }
    },

    getActiveSos: function() {
      return SafeHer.storage.get('active_sos') || null;
    },

    setActiveSos: function(data) {
      SafeHer.storage.set('active_sos', data);
      return data;
    },

    clearActiveSos: function() {
      SafeHer.storage.remove('active_sos');
    },

    // ─── Volunteer Network ────────────────────────────────────
    getVolunteerProfile: function() {
      return SafeHer.storage.get('volunteer_profile') || { isAvailable: false, lat: null, lng: null };
    },

    setVolunteerProfile: function(profile, callback) {
      SafeHer.storage.set('volunteer_profile', profile);

      if (useBackend()) {
        var user = this.getUser() || {};
        apiFetch('/api/volunteers/status', {
          method: 'POST',
          body: JSON.stringify({
            available: !!profile.isAvailable,
            lat: profile.lat || null,
            lng: profile.lng || null,
            note: profile.note || '',
            user_id: user.id || null,
            phone: user.phone || '',
            name: user.name || 'Volunteer'
          })
        }).then(function(json) {
          if (json.data) {
            profile.status = json.data.status;
            profile.note = json.data.note;
            SafeHer.storage.set('volunteer_profile', profile);
          }
          if (callback) callback(null, json.data);
        }).catch(function(err) {
          if (callback) callback(err.message, profile);
        });
      } else {
        if (callback) callback(null, profile);
      }
      return profile;
    },

    getVolunteerServerProfile: function(callback) {
      var local = this.getVolunteerProfile();
      if (useBackend()) {
        var user = this.getUser() || {};
        var query = user.id ? ('?user_id=' + encodeURIComponent(user.id)) : '';
        apiFetch('/api/volunteers/profile' + query, { method: 'GET', _silent: true })
          .then(function(json) {
            if (json.data) {
              var merged = {
                isAvailable: json.data.available,
                lat: json.data.lat,
                lng: json.data.lng,
                status: json.data.status || 'pending',
                level: json.data.level || 'provisional',
                badge: json.data.badge || 'Provisional',
                completed_responses: json.data.completed_responses || 0,
                valid_until: json.data.valid_until || null,
                note: json.data.note || '',
                updatedAt: Date.now()
              };
              SafeHer.storage.set('volunteer_profile', merged);
              if (callback) callback(null, merged);
            } else {
              if (callback) callback(null, local);
            }
          })
          .catch(function(err) {
            if (callback) callback(err.message, local);
          });
      } else {
        if (callback) callback(null, local);
      }
    },

    getNearbyAlerts: function(callback) {
      if (useBackend()) {
        var user = this.getUser() || {};
        var query = user.id ? ('?user_id=' + encodeURIComponent(user.id)) : '';
        apiFetch('/api/volunteers/nearby-alerts' + query, { method: 'GET' })
          .then(function(json) {
            if (callback) callback(null, json.data || []);
          })
          .catch(function(err) {
            if (callback) callback(err.message, []);
          });
      } else {
        if (callback) callback(null, []);
      }
    },

    respondToAlert: function(alertId, status, callback) {
      if (useBackend()) {
        var user = this.getUser() || {};
        apiFetch('/api/alerts/' + alertId + '/respond', {
          method: 'POST',
          body: JSON.stringify({
            status: status,
            user_id: user.id || null,
            phone: user.phone || ''
          })
        }).then(function(json) {
          if (callback) callback(null, json.data);
        }).catch(function(err) {
          if (callback) callback(err.message, null);
        });
      } else {
        if (callback) callback(null, { status: status });
      }
    },

    getAlertVolunteerStatus: function(alertId, callback) {
      if (useBackend()) {
        var user = this.getUser() || {};
        var query = user.id ? ('?user_id=' + encodeURIComponent(user.id)) : '';
        apiFetch('/api/alerts/' + alertId + '/status' + query, { method: 'GET' })
          .then(function(json) {
            if (callback) callback(null, json.data);
          })
          .catch(function(err) {
            if (callback) callback(err.message, null);
          });
      } else {
        if (callback) callback(null, null);
      }
    },

    submitVolunteerFeedback: function(alertId, feedbackData, callback) {
      if (useBackend()) {
        apiFetch('/api/alerts/' + alertId + '/volunteer-feedback', {
          method: 'POST',
          body: JSON.stringify(feedbackData)
        }).then(function(json) {
          if (callback) callback(null, json.data);
        }).catch(function(err) {
          if (callback) callback(err.message, null);
        });
      } else {
        if (callback) callback(null, { ok: true });
      }
    },

    fetchResponderSelfieBlobUrl: function(selfieUrl, callback) {
      if (!useBackend() || !selfieUrl) {
        if (callback) callback(null, null);
        return;
      }
      var token = this.getToken ? this.getToken() : null;
      var headers = {};
      if (token) headers['Authorization'] = 'Bearer ' + token;
      var url = selfieUrl.startsWith('http') ? selfieUrl : ((window.BACKEND_URL || 'http://localhost:5000') + (selfieUrl.startsWith('/') ? '' : '/') + selfieUrl);
      fetch(url, {
        headers: headers
      }).then(function(res) {
        if (!res.ok) throw new Error('Selfie fetch failed with status ' + res.status);
        return res.blob();
      }).then(function(blob) {
        var blobUrl = URL.createObjectURL(blob);
        if (callback) callback(null, blobUrl);
      }).catch(function(err) {
        if (callback) callback(err.message, null);
      });
    },

    getAvailableVolunteersCount: function(callback, coords) {
      if (useBackend()) {
        var url = '/api/volunteers/count';
        if (coords && coords.lat != null && coords.lng != null) {
          url += '?lat=' + encodeURIComponent(coords.lat) + '&lng=' + encodeURIComponent(coords.lng);
        }
        apiFetch(url, { method: 'GET', _silent: true })
          .then(function(json) {
            var count = json.data && json.data.available_volunteers !== undefined ? json.data.available_volunteers : 0;
            if (callback) callback(null, count);
          })
          .catch(function(err) {
            if (callback) callback(err.message, 0);
          });
      } else {
        if (callback) callback(null, 0);
      }
    },

    // ─── Safe Timers ──────────────────────────────────────────
    getSafeTimer: function() {
      return SafeHer.storage.get('safe_timer') || null;
    },

    setSafeTimer: function(data, callback) {
      SafeHer.storage.set('safe_timer', data);

      if (useBackend()) {
        var currentUser = this.getUser() || {};
        apiFetch('/api/timers', {
          method: 'POST',
          body: JSON.stringify({
            minutes: data.minutes || (data.totalSeconds ? (data.totalSeconds / 60) : 5),
            contact_id: data.contactId || null,
            user_id: currentUser.id,
            phone: currentUser.phone
          })
        }).then(function(json) {
          if (json.data && json.data.id) {
            data.backendTimerId = json.data.id;
            SafeHer.storage.set('safe_timer', data);
          }
          if (callback) callback(null, data);
        }).catch(function(err) {
          if (callback) callback(err.message, data);
        });
      } else {
        if (callback) callback(null, data);
      }
      return data;
    },

    clearSafeTimer: function(callback) {
      var current = this.getSafeTimer();
      var backendId = current ? current.backendTimerId : null;
      SafeHer.storage.remove('safe_timer');

      if (useBackend() && getToken() && backendId) {
        apiFetch('/api/timers/' + backendId + '/safe', { method: 'POST' })
          .then(function(json) {
            if (callback) callback(null, json.data);
          })
          .catch(function(err) {
            if (callback) callback(err.message, null);
          });
      } else {
        if (callback) callback(null, true);
      }
    },

    getActiveTimer: function(callback) {
      if (useBackend() && getToken()) {
        apiFetch('/api/timers/active', { method: 'GET', _silent: true })
          .then(function(json) {
            if (callback) callback(null, json.data);
          })
          .catch(function(err) {
            if (callback) callback(err.message, null);
          });
      } else {
        var local = this.getSafeTimer();
        if (callback) callback(null, local);
      }
    },

    // ─── Web Push Subscriptions ──────────────────────────────
    getVapidPublicKey: function(callback) {
      if (useBackend()) {
        apiFetch('/api/push/vapid-public-key', { method: 'GET' })
          .then(function(json) {
            var key = json.data && json.data.public_key ? json.data.public_key : null;
            if (callback) callback(null, key);
          })
          .catch(function(err) {
            if (callback) callback(err.message, null);
          });
      } else {
        if (callback) callback('Backend disabled', null);
      }
    },

    subscribePush: function(subData, callback) {
      if (useBackend() && getToken()) {
        apiFetch('/api/push/subscribe', {
          method: 'POST',
          body: JSON.stringify(subData)
        }).then(function(json) {
          if (callback) callback(null, json.data);
        }).catch(function(err) {
          if (callback) callback(err.message, null);
        });
      } else {
        if (callback) callback(null, { message: 'Subscribed locally' });
      }
    },

    unsubscribePush: function(endpoint, callback) {
      if (useBackend() && getToken()) {
        apiFetch('/api/push/unsubscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint: endpoint })
        }).then(function(json) {
          if (callback) callback(null, json.data);
        }).catch(function(err) {
          if (callback) callback(err.message, null);
        });
      } else {
        if (callback) callback(null, { message: 'Unsubscribed locally' });
      }
    },

    // ─── Evidence Vault Endpoints ──────────────────────────────
    registerEvidenceKey: function(publicKey, callback) {
      if (useBackend()) {
        return apiFetch('/api/evidence/key', {
          method: 'POST',
          body: JSON.stringify({ publicKey: publicKey })
        }).then(function(json) {
          if (callback) callback(null, json);
          return json;
        }).catch(function(err) {
          if (callback) callback(err.message, null);
          throw err;
        });
      } else {
        if (callback) callback(null, { ok: true, offline: true });
        return Promise.resolve({ ok: true, offline: true });
      }
    },

    uploadEvidenceChunk: function(chunkData) {
      if (useBackend()) {
        return apiFetch('/api/evidence/chunk', {
          method: 'POST',
          _silent: true,
          body: JSON.stringify(chunkData)
        });
      }
      return Promise.resolve({ ok: true, offline: true });
    },

    verifyEvidenceSession: function(sessionId, callback) {
      if (useBackend()) {
        return apiFetch('/api/evidence/verify/' + encodeURIComponent(sessionId), {
          method: 'GET'
        }).then(function(json) {
          if (callback) callback(null, json);
          return json;
        }).catch(function(err) {
          if (callback) callback(err.message, null);
          return { ok: false, error: err.message };
        });
      } else {
        if (callback) callback(null, { ok: false, error: 'Offline' });
        return Promise.resolve({ ok: false, error: 'Offline' });
      }
    },

    deleteEvidenceSession: function(sessionId, callback) {
      if (useBackend()) {
        return apiFetch('/api/evidence/session/' + encodeURIComponent(sessionId), {
          method: 'DELETE'
        }).then(function(json) {
          if (callback) callback(null, json);
          return json;
        }).catch(function(err) {
          if (callback) callback(err.message, null);
          return { ok: false, error: err.message };
        });
      } else {
        if (callback) callback(null, { ok: true, offline: true });
        return Promise.resolve({ ok: true, offline: true });
      }
    },

    // ─── Auxiliary Features (Tips, Location & I18n) ───────────
    getTips: function(category) {
      var defaultTips = [
        { id: 1, category: 'tips', icon: 'commute', title: 'Travelling', lines: ['Share your trip details with someone you trust.', 'Stay on well-lit and familiar public routes.', 'Keep your phone charged and easily accessible.'] },
        { id: 2, category: 'tips', icon: 'shopping_bag', title: 'Shopping', lines: ['Keep your handbag closed and close to your body.', 'Stay mindful of crowded areas and emergency exits.', 'Avoid displaying or counting large amounts of cash.'] },
        { id: 3, category: 'tips', icon: 'home', title: 'At Home', lines: ['Lock all doors and windows, especially at night.', 'Verify visitors before opening the main entrance.', 'Keep an emergency light and phone near your bed.'] },
        { id: 4, category: 'tips', icon: 'public', title: 'Online', lines: ['Do not share your real-time location publicly.', 'Use strong passwords and two-step verification.', 'Never share daily routines or personal addresses.'] },
        { id: 5, category: 'tips', icon: 'local_taxi', title: 'Cab and Auto Rides', lines: ['Confirm the vehicle registration number before entering.', 'Share your live ride status with a friend.', 'Avoid entering vehicles with extra unknown passengers.'] },
        { id: 6, category: 'defense', icon: 'visibility', title: 'Stay aware of your surroundings', lines: ['Keep your head up and scan the area around you.', 'Avoid looking down at your phone while walking alone.', 'Remove earphones in quiet or poorly lit places.'] },
        { id: 7, category: 'defense', icon: 'psychology', title: 'Trust your instincts', lines: ['If a situation or person makes you feel uncomfortable, leave.', 'Do not hesitate to cross the street or change direction.', 'Your personal safety is always more important than politeness.'] },
        { id: 8, category: 'defense', icon: 'battery_charging_full', title: 'Keep your phone charged', lines: ['Carry a compact power bank when heading out for the day.', 'Maintain your phone battery above twenty percent.', 'Ensure emergency contacts are saved and easy to dial.'] },
        { id: 9, category: 'defense', icon: 'call', title: 'Know your emergency numbers', lines: ['Remember 112 for national emergency services.', 'Keep 181 for the women helpline saved on your phone.', 'Have a quick plan for who to contact first in distress.'] },
        { id: 10, category: 'defense', icon: 'storefront', title: 'Move to a crowded, lit place', lines: ['Head toward open stores, pharmacies, or lit transit stops.', 'Approach security personnel or staff if you feel followed.', 'Call out loudly for assistance if anyone approaches aggressively.'] }
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
    },

    saveLiveLocation: function(coords) {
      SafeHer.storage.set('live_location', coords);
      return coords;
    },

    getLiveLocation: function() {
      return SafeHer.storage.get('live_location') || null;
    },

    getNearbyPlacesCache: function() {
      return SafeHer.storage.get('nearby_places_cache') || null;
    },

    setNearbyPlacesCache: function(cacheData) {
      SafeHer.storage.set('nearby_places_cache', cacheData);
      return cacheData;
    },

    getLanguage: function() {
      return SafeHer.storage.get('app_lang') || 'en';
    },

    setLanguage: function(lang) {
      SafeHer.storage.set('app_lang', lang);
      return lang;
    },

    // ─── Escort Mode Endpoints ──────────────────────────────
    createEscort: function(data, callback) {
      if (!useBackend()) {
        if (callback) callback('Escort mode requires an active connection', null);
        return;
      }
      apiFetch('/api/escorts', {
        method: 'POST',
        body: JSON.stringify(data)
      })
      .then(function(res) {
        if (callback) callback(null, res.data || res);
      })
      .catch(function(err) {
        if (callback) callback(err.message || 'Failed to create escort', null);
      });
    },

    sendEscortPosition: function(id, coords, callback) {
      if (!useBackend()) return;
      apiFetch('/api/escorts/' + id + '/position', {
        method: 'POST',
        body: JSON.stringify(coords),
        _silent: true
      })
      .then(function(res) {
        if (callback) callback(null, res.data || res);
      })
      .catch(function(err) {
        if (callback) callback(err.message || 'Position update error', null);
      });
    },

    checkinEscort: function(id, callback) {
      if (!useBackend()) return;
      apiFetch('/api/escorts/' + id + '/checkin', {
        method: 'POST'
      })
      .then(function(res) {
        if (callback) callback(null, res.data || res);
      })
      .catch(function(err) {
        if (callback) callback(err.message || 'Checkin error', null);
      });
    },

    pauseEscort: function(id, minutes, callback) {
      if (!useBackend()) return;
      apiFetch('/api/escorts/' + id + '/pause', {
        method: 'POST',
        body: JSON.stringify({ minutes: minutes || 10 })
      })
      .then(function(res) {
        if (callback) callback(null, res.data || res);
      })
      .catch(function(err) {
        if (callback) callback(err.message || 'Pause error', null);
      });
    },

    rerouteEscort: function(id, routePoints, callback) {
      if (!useBackend()) return;
      apiFetch('/api/escorts/' + id + '/reroute', {
        method: 'POST',
        body: JSON.stringify({ route: routePoints })
      })
      .then(function(res) {
        if (callback) callback(null, res.data || res);
      })
      .catch(function(err) {
        if (callback) callback(err.message || 'Reroute error', null);
      });
    },

    escalateEscort: function(id, callback) {
      if (!useBackend()) return;
      apiFetch('/api/escorts/' + id + '/escalate', {
        method: 'POST'
      })
      .then(function(res) {
        if (callback) callback(null, res.data || res);
      })
      .catch(function(err) {
        if (callback) callback(err.message || 'Escalate error', null);
      });
    },

    endEscort: function(id, arrived, callback) {
      if (!useBackend()) return;
      apiFetch('/api/escorts/' + id + '/end', {
        method: 'POST',
        body: JSON.stringify({ arrived: !!arrived })
      })
      .then(function(res) {
        if (callback) callback(null, res.data || res);
      })
      .catch(function(err) {
        if (callback) callback(err.message || 'End escort error', null);
      });
    },

    getActiveEscort: function(callback) {
      if (!useBackend()) {
        if (callback) callback(null, null);
        return;
      }
      apiFetch('/api/escorts/active', { method: 'GET', _silent: true })
      .then(function(res) {
        if (callback) callback(null, res.data || null);
      })
      .catch(function(err) {
        if (callback) callback(err.message, null);
      });
    },

    getEscort: function(id, callback) {
      if (!useBackend()) {
        if (callback) callback('No backend', null);
        return;
      }
      apiFetch('/api/escorts/' + id, { method: 'GET', _silent: true })
      .then(function(res) {
        if (callback) callback(null, res.data || null);
      })
      .catch(function(err) {
        if (callback) callback(err.message, null);
      });
    },

    getEscortSummary: function(id, callback) {
      if (!useBackend()) {
        if (callback) callback('No backend', null);
        return;
      }
      apiFetch('/api/escorts/' + id + '/summary', { method: 'GET', _silent: true })
      .then(function(res) {
        if (callback) callback(null, res.data || res);
      })
      .catch(function(err) {
        if (callback) callback(err.message, null);
      });
    },

    notifyEscortArrived: function(id, callback) {
      if (!useBackend()) {
        if (callback) callback('No backend', null);
        return;
      }
      apiFetch('/api/escorts/' + id + '/notify-arrived', { method: 'POST' })
      .then(function(res) {
        if (callback) callback(null, res.data || res);
      })
      .catch(function(err) {
        if (callback) callback(err.message, null);
      });
    },

    isOfflineMode: function() {
      return !useBackend() || !!offlineNotified;
    },

    useBackend: function() {
      return useBackend();
    }
  };
})();
