// js/map.js – Leaflet live map, watchPosition tracking, link copy, Web Share, and permission handling

SafeHer.map = (function() {
  var watchId = null;
  var currentPos = null;
  var mapInstance = null;
  var markerInstance = null;
  var circleInstance = null;
  var sampleMarkersGroup = null;

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setElementText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function showLoading() {
    var loadingEl = document.getElementById('map-loading');
    var errorEl = document.getElementById('map-error-card');
    var contentEl = document.getElementById('map-content');
    if (loadingEl) loadingEl.style.display = 'flex';
    if (errorEl) errorEl.style.display = 'none';
    if (contentEl && !currentPos) contentEl.style.display = 'none';
  }

  function showError(msg) {
    var loadingEl = document.getElementById('map-loading');
    var errorEl = document.getElementById('map-error-card');
    var contentEl = document.getElementById('map-content');
    var errorMsgEl = document.getElementById('map-error-msg');

    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'flex';
    if (contentEl && !currentPos) contentEl.style.display = 'none';
    if (errorMsgEl) errorMsgEl.textContent = msg;
  }

  function showMapContent() {
    var loadingEl = document.getElementById('map-loading');
    var errorEl = document.getElementById('map-error-card');
    var contentEl = document.getElementById('map-content');

    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'block';
  }

  function updateLeafletMap(lat, lng, accuracy) {
    var mapEl = document.getElementById('live-map');
    if (!mapEl || typeof L === 'undefined') return;

    if (!mapInstance) {
      mapInstance = L.map('live-map', {
        center: [lat, lng],
        zoom: 16,
        zoomControl: false,
        attributionControl: false
      });

      L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
        maxZoom: 20,
        maxNativeZoom: 18,
        subdomains: ['0', '1', '2', '3']
      }).addTo(mapInstance);

      markerInstance = L.marker([lat, lng]).addTo(mapInstance);

      if (accuracy) {
        circleInstance = L.circle([lat, lng], {
          radius: accuracy,
          color: '#A80F3C',
          fillColor: '#FCEFF3',
          fillOpacity: 0.35,
          weight: 1
        }).addTo(mapInstance);
      }
    } else {
      mapInstance.setView([lat, lng]);
      if (markerInstance) {
        markerInstance.setLatLng([lat, lng]);
      } else {
        markerInstance = L.marker([lat, lng]).addTo(mapInstance);
      }

      if (accuracy) {
        if (circleInstance) {
          circleInstance.setLatLng([lat, lng]);
          circleInstance.setRadius(accuracy);
        } else {
          circleInstance = L.circle([lat, lng], {
            radius: accuracy,
            color: '#A80F3C',
            fillColor: '#FCEFF3',
            fillOpacity: 0.35,
            weight: 1
          }).addTo(mapInstance);
        }
      }
    }

    // Render sample safety markers around user's location
    renderSampleSafetyMarkers(lat, lng);

    // Invalidate map size so Leaflet renders full tiles correctly inside dynamic containers
    mapInstance.invalidateSize();
    setTimeout(function() {
      if (mapInstance) mapInstance.invalidateSize();
    }, 200);
    setTimeout(function() {
      if (mapInstance) mapInstance.invalidateSize();
    }, 500);
  }

  // Note: Real safety zone data would come from user reports in the backend.
  function renderSampleSafetyMarkers(lat, lng) {
    if (!mapInstance || typeof L === 'undefined') return;

    if (!sampleMarkersGroup) {
      sampleMarkersGroup = L.layerGroup().addTo(mapInstance);
    } else {
      sampleMarkersGroup.clearLayers();
    }

    var samples = [
      // 2 Green (Safe)
      { lat: lat + 0.0022, lng: lng + 0.0018, label: 'Safe', color: '#2E7D32', sub: 'Well-lit area' },
      { lat: lat - 0.0019, lng: lng - 0.0021, label: 'Safe', color: '#2E7D32', sub: 'Active patrol zone' },
      // 2 Orange (Moderate)
      { lat: lat + 0.0016, lng: lng - 0.0025, label: 'Moderate', color: '#F57C00', sub: 'Moderate activity' },
      { lat: lat - 0.0024, lng: lng + 0.0019, label: 'Moderate', color: '#F57C00', sub: 'Low lighting' },
      // 2 Red (Be careful)
      { lat: lat + 0.0031, lng: lng + 0.0028, label: 'Be careful', color: '#D32F2F', sub: 'Isolated stretch' },
      { lat: lat - 0.0029, lng: lng - 0.0026, label: 'Be careful', color: '#D32F2F', sub: 'Caution reported' }
    ];

    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      var m = L.circleMarker([s.lat, s.lng], {
        radius: 8,
        fillColor: s.color,
        color: '#FFFFFF',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9
      });

      var popupHtml = '<div style="font-family: Poppins, sans-serif; font-size: 13px; text-align: center;">' +
        '<b style="color: ' + s.color + ';">' + escapeHtml(s.label) + '</b><br>' +
        '<span style="font-size: 11px; color: #777;">' + escapeHtml(s.sub) + '</span><br>' +
        '<span style="display: inline-block; font-size: 10px; background: #FCEFF3; color: #A80F3C; font-weight: 600; padding: 2px 6px; border-radius: 4px; margin-top: 4px;">Sample data</span>' +
      '</div>';

      m.bindPopup(popupHtml);
      m.bindTooltip(s.label + ' (Sample data)', { direction: 'top', offset: [0, -6] });
      sampleMarkersGroup.addLayer(m);
    }
  }

  function onPositionUpdate(pos) {
    var lat = pos.coords.latitude;
    var lng = pos.coords.longitude;
    var acc = Math.round(pos.coords.accuracy || 0);

    currentPos = {
      lat: lat,
      lng: lng,
      accuracy: acc,
      timestamp: Date.now()
    };

    if (SafeHer.api && SafeHer.api.saveLiveLocation) {
      SafeHer.api.saveLiveLocation(currentPos);
    }

    showMapContent();
    updateLeafletMap(lat, lng, acc);

    var coordsStr = lat.toFixed(5) + ', ' + lng.toFixed(5);
    setElementText('map-coords-text', coordsStr);

    var accStr = acc > 0 ? 'Accurate to ' + acc + 'm' : 'Live GPS signal locked';
    setElementText('map-accuracy-text', accStr);
  }

  function onPositionError(err) {
    var msg = 'Unable to retrieve your location. Please check your GPS and internet connection.';

    if (err) {
      if (err.code === 1 || err.code === err.PERMISSION_DENIED) {
        msg = 'Location permission was denied. Please allow location access in your browser or device settings to view your live position.';
      } else if (err.code === 2 || err.code === err.POSITION_UNAVAILABLE) {
        msg = 'Location signal is unavailable. Please make sure device GPS / location services are turned on.';
      } else if (err.code === 3 || err.code === err.TIMEOUT) {
        msg = 'Location request timed out. Please tap Retry to try again.';
      }
    }

    showError(msg);
  }

  function startTracking() {
    if (!navigator.geolocation) {
      showError('Geolocation is not supported by your browser.');
      return;
    }

    showLoading();

    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }

    watchId = navigator.geolocation.watchPosition(
      onPositionUpdate,
      onPositionError,
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000
      }
    );
  }

  function stopTracking() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  function retry() {
    stopTracking();
    startTracking();
  }

  function getGoogleMapsUrl() {
    if (!currentPos) return null;
    return 'https://www.google.com/maps?q=' + currentPos.lat + ',' + currentPos.lng;
  }

  function copyTextToClipboard(text, successMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        SafeHer.toast(successMsg || 'Location link copied');
      }).catch(function() {
        fallbackCopy(text, successMsg);
      });
    } else {
      fallbackCopy(text, successMsg);
    }
  }

  function fallbackCopy(text, successMsg) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      SafeHer.toast(successMsg || 'Location link copied');
    } catch (e) {
      SafeHer.toast('Could not copy link');
    }
    document.body.removeChild(ta);
  }

  function copyLocationLink() {
    var url = getGoogleMapsUrl();
    if (!url) {
      SafeHer.toast('Waiting for GPS location...');
      return;
    }
    copyTextToClipboard(url, 'Location link copied');
  }

  function shareLiveLocation() {
    var url = getGoogleMapsUrl();
    if (!url) {
      SafeHer.toast('Waiting for GPS location...');
      return;
    }

    var shareData = {
      title: 'SafeHer Live Location',
      text: 'Here is my live location: ' + url,
      url: url
    };

    if (navigator.share) {
      navigator.share(shareData).catch(function(err) {
        if (err && err.name === 'AbortError') {
          return;
        }
        copyTextToClipboard(url, 'Location link copied');
      });
    } else {
      copyTextToClipboard(url, 'Location link copied');
    }
  }

  function init() {
    SafeHer.router.onShow('map', function() {
      startTracking();
      if (mapInstance) {
        setTimeout(function() { mapInstance.invalidateSize(); }, 150);
        setTimeout(function() { mapInstance.invalidateSize(); }, 400);
      }
    });

    SafeHer.router.onShow('live-location', function() {
      SafeHer.router.go('map');
    });

    SafeHer.router.onShow('share-location', function() {
      SafeHer.router.go('map');
    });
  }

  return {
    init: init,
    startTracking: startTracking,
    stopTracking: stopTracking,
    retry: retry,
    copyLocationLink: copyLocationLink,
    shareLiveLocation: shareLiveLocation,
    getCurrentPos: function() { return currentPos; }
  };
})();
