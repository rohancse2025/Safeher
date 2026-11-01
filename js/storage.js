// js/storage.js – thin localStorage wrapper used only by api.js

var SafeHer = window.SafeHer || {};

SafeHer.storage = {
  _key: function(k) { return 'safeher_' + k; },

  get: function(key) {
    try {
      var raw = localStorage.getItem(this._key(key));
      return raw !== null ? JSON.parse(raw) : null;
    } catch(e) {
      return null;
    }
  },

  set: function(key, val) {
    try {
      localStorage.setItem(this._key(key), JSON.stringify(val));
    } catch(e) {}
  },

  remove: function(key) {
    try {
      localStorage.removeItem(this._key(key));
    } catch(e) {}
  }
};
