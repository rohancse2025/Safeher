// js/police.js – Legacy alias routed to SafeHer.places for robust, unified Nearby Places
window.SafeHer = window.SafeHer || {};

if (SafeHer.places) {
  SafeHer.police = SafeHer.places;
} else {
  // If loaded before places.js, define delegator
  SafeHer.police = {
    init: function() { if (SafeHer.places && SafeHer.places.init) SafeHer.places.init(); },
    fetchPlaces: function() { if (SafeHer.places && SafeHer.places.fetchPlaces) SafeHer.places.fetchPlaces(); },
    switchTab: function(cat) { if (SafeHer.places && SafeHer.places.switchCategory) SafeHer.places.switchCategory(cat); },
    retry: function() { if (SafeHer.places && SafeHer.places.retry) SafeHer.places.retry(); }
  };
}
