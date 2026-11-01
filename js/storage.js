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
  },

  clearAll: function() {
    try {
      var keysToRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('safeher_') === 0) {
          keysToRemove.push(k);
        }
      }
      for (var j = 0; j < keysToRemove.length; j++) {
        localStorage.removeItem(keysToRemove[j]);
      }
    } catch(e) {}
  }
};
