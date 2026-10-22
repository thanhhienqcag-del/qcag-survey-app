// ====================================================================
// js/shared/location.js — Leaflet map picker, GPS, Nominatim geocoding
// ====================================================================
'use strict';

// Module-level state (used only within location features)
let lMap = null;
let lMarker = null;
let pickedLatLng = null;
let locCurrentTab = 'gps';
let searchDebounce = null;
let _osmLayer = null;
let _satLayer = null;
let _labelsLayer = null; // Transparent POI/label overlay for satellite mode
// Default map mode: set to 'satellite' so map opens in satellite view
let _currentMapMode = 'satellite'; // 'normal' or 'satellite'

function openLocationModal() {
  setMapExifStatus(null);
  document.getElementById('mapModal').classList.remove('hidden');
  document.getElementById('mapModal').classList.add('flex');
  // Default to map selection tab (user wants to pick on map first)
  switchLocTab('map');
  setTimeout(() => {
    if (lMap) lMap.invalidateSize();
  }, 200);
}

function closeMapModal() {
  document.getElementById('mapModal').classList.add('hidden');
  document.getElementById('mapModal').classList.remove('flex');
}

function _setPickedCoordsSub(lat, lng) {
  const el = document.getElementById('pickedLatLngText');
  if (!el) return;
  if (lat != null && lng != null && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
    el.textContent = `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
    el.style.display = 'inline';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

function switchLocTab(tab) {
  locCurrentTab = tab;
  document.getElementById('locPanelGPS').classList.toggle('hidden', tab !== 'gps');
  document.getElementById('locPanelMap').classList.toggle('hidden', tab !== 'map');
  const gpsBtn = document.getElementById('locTabGPS');
  const mapBtn = document.getElementById('locTabMap');
  const activeClass = 'flex-1 py-2 rounded-lg text-sm font-semibold bg-gray-900 dark:bg-emerald-600 text-white shadow-sm';
  const inactiveClass = 'flex-1 py-2 rounded-lg text-sm font-medium border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300';

  if (gpsBtn) gpsBtn.className = tab === 'gps' ? activeClass : inactiveClass;
  if (mapBtn) mapBtn.className = tab === 'map' ? activeClass : inactiveClass;

  if (tab === 'map') {
    initLeafletMap();
  }
}

function initLeafletMap() {
  const latVal = parseFloat(document.getElementById('outletLat').value || 0);
  const lngVal = parseFloat(document.getElementById('outletLng').value || 0);
  const hasCoords = !!(latVal && lngVal);

  if (lMap) {
    setTimeout(() => { lMap.invalidateSize(); }, 200);
    if (hasCoords) {
      lMap.setView([latVal, lngVal], 16);
      if (!lMarker) lMarker = L.marker([latVal, lngVal]).addTo(lMap);
      else lMarker.setLatLng([latVal, lngVal]);
      pickedLatLng = { lat: latVal, lng: lngVal };
      document.getElementById('pickedCoords').textContent = `${latVal.toFixed(6)}, ${lngVal.toFixed(6)}`;
      _setPickedCoordsSub(latVal, lngVal);
    } else {
      // Chưa có vị trí đã lưu → xóa ghim cũ (chưa save) khỏi bản đồ
      pickedLatLng = null;
      if (lMarker) { lMarker.remove(); lMarker = null; }
      document.getElementById('pickedCoords').textContent = 'Tap vào bản đồ để chọn vị trí';
      _setPickedCoordsSub(null, null);
    }
    _updateSaveBtn();
    return;
  }

  let cachedCenter = null;
  try {
    const cached = localStorage.getItem('ks_last_gps_location');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.lat && parsed.lng) {
        cachedCenter = [parseFloat(parsed.lat), parseFloat(parsed.lng)];
      }
    }
  } catch (e) {}

  const defaultCenter = hasCoords ? [latVal, lngVal] : (cachedCenter ? cachedCenter : [10.7769, 106.7009]);
  // Create map with increased maxZoom to allow deeper zoom levels (will upscale tiles
  // if provider doesn't supply native tiles at that zoom).
  lMap = L.map('mapContainer', { zoomControl: true, maxZoom: 25 }).setView(defaultCenter, hasCoords ? 18 : (cachedCenter ? 15 : 17));

  _osmLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    attribution: '&copy; Google Maps',
    subdomains: '0123',
    maxZoom: 25,
    maxNativeZoom: 21,
    keepBuffer: 6
  });
  _satLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    attribution: '&copy; Google Maps Satellite',
    subdomains: '0123',
    maxZoom: 25,
    maxNativeZoom: 21,
    keepBuffer: 6
  });
  // Note: Google Hybrid layer (lyrs=y) already includes sharp Vietnamese street & place labels built-in
  _labelsLayer = null;

  // Add the default layer
  if (_currentMapMode === 'satellite') {
    _satLayer.addTo(lMap);
  } else {
    _osmLayer.addTo(lMap);
  }
  _updateMapLayerToggle();

  // Ensure Leaflet recalculates size after modal layout settles — prevents
  // blank map tiles when container was hidden or had no size at init time.
  setTimeout(() => {
    try { lMap.invalidateSize(); } catch (e) {}
  }, 220);

  // Auto-center on current GPS if no saved location
  if (!hasCoords && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      try {
        localStorage.setItem('ks_last_gps_location', JSON.stringify({ lat, lng }));
      } catch (e) {}
      if (!pickedLatLng && lMap) {
        lMap.setView([lat, lng], 15);
        if (!lMarker) lMarker = L.marker([lat, lng]).addTo(lMap);
        else lMarker.setLatLng([lat, lng]);
        pickedLatLng = { lat, lng };
        document.getElementById('pickedCoords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        _setPickedCoordsSub(lat, lng);
        _updateSaveBtn();
        reverseGeocode(lat, lng, (addr) => {
          if (addr) document.getElementById('pickedCoords').textContent = addr;
        });
      }
    }, (err) => {
      console.warn('[GPS] Map auto-center geolocation error:', err);
      // Only alert if we don't even have a cached center, or if permission denied explicitly
      if (err.code === 1) {
        showToast('Bị từ chối quyền định vị. Vui lòng cấp quyền vị trí trong cài đặt trình duyệt.');
      }
    }, { timeout: 8000, enableHighAccuracy: true });
  }

  lMap.on('click', function (e) {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    pickedLatLng = { lat, lng };
    if (!lMarker) lMarker = L.marker([lat, lng]).addTo(lMap);
    else lMarker.setLatLng([lat, lng]);
    document.getElementById('pickedCoords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    _setPickedCoordsSub(lat, lng);
    _updateSaveBtn();
    reverseGeocode(lat, lng, (addr) => {
      document.getElementById('pickedCoords').textContent = addr || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    });
  });

  if (hasCoords) {
    lMarker = L.marker([latVal, lngVal]).addTo(lMap);
    pickedLatLng = { lat: latVal, lng: lngVal };
    document.getElementById('pickedCoords').textContent = `${latVal.toFixed(6)}, ${lngVal.toFixed(6)}`;
    _setPickedCoordsSub(latVal, lngVal);
  } else {
    pickedLatLng = null;
    _setPickedCoordsSub(null, null);
  }
  _updateSaveBtn();
}

function _updateSaveBtn() {
  const btn = document.getElementById('saveLocationBtn');
  if (!btn) return;
  if (pickedLatLng) {
    btn.disabled = false;
    btn.classList.remove('opacity-40', 'cursor-not-allowed');
  } else {
    btn.disabled = true;
    btn.classList.add('opacity-40', 'cursor-not-allowed');
  }
}

function reverseGeocode(lat, lng, cb) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
  fetch(url)
    .then(r => r.json())
    .then(d => cb(d.display_name || null))
    .catch(() => cb(null));
}

function toggleMapLayer() {
  if (!lMap) return;
  if (_currentMapMode === 'satellite') {
    _currentMapMode = 'normal';
    if (_satLayer) lMap.removeLayer(_satLayer);
    if (_labelsLayer) lMap.removeLayer(_labelsLayer);
    if (_osmLayer) _osmLayer.addTo(lMap);
  } else {
    _currentMapMode = 'satellite';
    if (_osmLayer) lMap.removeLayer(_osmLayer);
    if (_satLayer) _satLayer.addTo(lMap);
    if (_labelsLayer) _labelsLayer.addTo(lMap); // labels on top of satellite
  }
  _updateMapLayerToggle();
}

function _updateMapLayerToggle() {
  var btn = document.getElementById('mapLayerToggleBtn');
  if (!btn) return;
  if (_currentMapMode === 'satellite') {
    btn.innerHTML = '<svg class="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/></svg> <span class="map-layer-text">Bản đồ</span>';
    btn.title = 'Chuyển sang bản đồ thường';
  } else {
    btn.innerHTML = '<svg class="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> <span class="map-layer-text">Vệ tinh</span>';
    btn.title = 'Chuyển sang chế độ vệ tinh';
  }
}

function searchMapAddress(query) {
  clearTimeout(searchDebounce);
  const resultsEl = document.getElementById('mapSearchResults');
  if (!query || query.length < 3) { resultsEl.classList.add('hidden'); return; }
  searchDebounce = setTimeout(() => {
    fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&countrycodes=vn`)
      .then(r => r.json())
      .then(results => {
        if (!results.length) { resultsEl.classList.add('hidden'); return; }
        resultsEl.innerHTML = results.map(r => `
          <div onclick="selectSearchResult(${r.lat},${r.lon},'${r.display_name.replace(/'/g, "\\'")}')"
               class="px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 border-b last:border-b-0">
            ${r.display_name}
          </div>`).join('');
        resultsEl.classList.remove('hidden');
      })
      .catch(() => resultsEl.classList.add('hidden'));
  }, 400);
}

function selectSearchResult(lat, lng, name) {
  lat = parseFloat(lat); lng = parseFloat(lng);
  pickedLatLng = { lat, lng };
  if (lMap) {
    lMap.setView([lat, lng], 17);
    if (!lMarker) {
      lMarker = L.marker([lat, lng]).addTo(lMap);
    } else {
      lMarker.setLatLng([lat, lng]);
    }
  }
  document.getElementById('pickedCoords').textContent = name;
  document.getElementById('mapSearchResults').classList.add('hidden');
  document.getElementById('mapSearchInput').value = '';
  _updateSaveBtn();
}

function useCurrentLocation() {
  if (!navigator.geolocation) {
    document.getElementById('gpsStatus').textContent = 'Trình duyệt không hỗ trợ định vị';
    return;
  }

  const statusEl = document.getElementById('gpsStatus');
  const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const httpsUrl = 'https://' + location.hostname + ':' + (parseInt(location.port || 80) + 443) + location.pathname;

  statusEl.textContent = 'Đang lấy vị trí...';

  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    try {
      localStorage.setItem('ks_last_gps_location', JSON.stringify({ lat, lng }));
    } catch (e) {}
    document.getElementById('outletLat').value = lat;
    document.getElementById('outletLng').value = lng;
    statusEl.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    reverseGeocode(lat, lng, (addr) => {
      const display = addr ? addr.split(',').slice(0, 3).join(', ') : `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      setLocationPreview(display, lat, lng);
      statusEl.textContent = display;
    });
    closeMapModal();
    showToast('Đã lưu vị trí hiện tại');
  }, (err) => {
    const httpsHint = !isSecure
      ? '<br><a href="' + httpsUrl + '" style="color:#2563eb;text-decoration:underline">Mở bản HTTPS</a> để định vị hoạt động trên iPhone.'
      : '';
    if (err.code === 1) {
      statusEl.innerHTML =
        '<b>Bị từ chối quyền định vị.</b><br>' +
        'iPhone: Cài đặt → Quyền riêng tư → Dịch vụ định vị → BẬT, rồi Safari → Cho phép.<br>' +
        'Android: Cho phép khi trình duyệt hỏi.' + httpsHint;
    } else if (err.code === 2) {
      statusEl.innerHTML = 'Không lấy được tín hiệu GPS. Kiểm tra cài đặt vị trí.' + httpsHint;
    } else if (err.code === 3) {
      statusEl.innerHTML = 'Quá thời gian chờ GPS. Bấm thử lại.' + httpsHint;
    } else {
      statusEl.innerHTML = 'Không lấy được vị trí: ' + (err.message || 'Lỗi') + httpsHint;
    }
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

// Copy current map center/zoom to clipboard as a permalink
function copyMapUrl() {
  try {
    if (!lMap) {
      showToast && showToast('Bản đồ chưa sẵn sàng');
      return;
    }
    // Prefer the user-picked pin if available, otherwise use map center
    let lat, lng;
    if (typeof pickedLatLng === 'object' && pickedLatLng && pickedLatLng.lat && pickedLatLng.lng) {
      lat = Number(pickedLatLng.lat).toFixed(6);
      lng = Number(pickedLatLng.lng).toFixed(6);
    } else {
      const center = lMap.getCenter();
      lat = Number(center.lat).toFixed(6);
      lng = Number(center.lng).toFixed(6);
    }
    const z = Number(lMap.getZoom());
    // Use Google Maps search permalink which shows a pin at the lat,lng
    const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}&zoom=${z}`;
    // Try modern clipboard API first
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(url).then(function () {
        showToast && showToast('Đã sao chép liên kết Google Maps');
      }).catch(function () {
        _fallbackCopy(url);
      });
    } else {
      _fallbackCopy(url);
    }
  } catch (e) {
    console.warn('copyMapUrl error', e);
    showToast && showToast('Không thể sao chép URL');
  }
}

function _fallbackCopy(text) {
  try {
    var ta = document.createElement('textarea');
    ta.style.position = 'fixed'; ta.style.left = '-99999px'; ta.value = text;
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, ta.value.length);
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) showToast && showToast('Đã sao chép liên kết Google Maps');
    else showToast && showToast('Không thể sao chép liên kết Google Maps');
  } catch (e) {
    console.warn('fallback copy failed', e);
    showToast && showToast('Không thể sao chép URL');
  }
}

function savePickedLocation() {
  if (!pickedLatLng) { showToast('Bạn vui lòng chọn định vị điểm bán trước'); return; }
  try {
    localStorage.setItem('ks_last_gps_location', JSON.stringify({ lat: pickedLatLng.lat, lng: pickedLatLng.lng }));
  } catch (e) {}
  document.getElementById('outletLat').value = pickedLatLng.lat;
  document.getElementById('outletLng').value = pickedLatLng.lng;
  const locSourceEl = document.getElementById('locationSource');
  if (locSourceEl) locSourceEl.value = 'manual';
  const displayText = document.getElementById('pickedCoords').textContent;
  setLocationPreview(displayText, pickedLatLng.lat, pickedLatLng.lng);
  closeMapModal();
  showToast('Đã lưu vị trí');
  if (typeof window._onLocationPicked === 'function') {
    const cb = window._onLocationPicked;
    window._onLocationPicked = null;
    cb(pickedLatLng.lat, pickedLatLng.lng);
  }
}

function setLocationPreview(displayText, lat, lng) {
  document.getElementById('outletLat').value = lat;
  document.getElementById('outletLng').value = lng;
  const previewText = document.getElementById('locationPreviewText');
  const actionBtn = document.getElementById('locationActionBtn');
  if (previewText) {
    previewText.textContent = displayText;
    previewText.classList.remove('hidden');
    previewText.classList.remove('text-gray-500');
    previewText.classList.add('text-green-600', 'font-semibold');
  }
  if (actionBtn) {
    actionBtn.textContent = displayText;
    actionBtn.onclick = function () { openSavedLocation(lat, lng); };
    actionBtn.classList.remove('hidden');
  }
  // also update the single outlet locate button label (fixed-size, ellipsis)
  const outletBtn = document.getElementById('btn-locate-outlet');
  if (outletBtn) {
    outletBtn.textContent = displayText;
    outletBtn.title = displayText;
  }
  const locLabel = document.getElementById('outletLocationLabel');
  if (locLabel) {
    locLabel.textContent = 'Đã xác định vị trí thành công:';
    locLabel.classList.remove('text-red-600');
    locLabel.classList.add('text-green-600');
  }
}

function clearLocationPreview() {
  try {
    document.getElementById('outletLat').value = '';
    document.getElementById('outletLng').value = '';
    const previewText = document.getElementById('locationPreviewText');
    const actionBtn = document.getElementById('locationActionBtn');
    if (actionBtn) { actionBtn.classList.add('hidden'); actionBtn.textContent = ''; }
    if (previewText) {
      previewText.classList.remove('hidden');
      previewText.textContent = 'Chưa có vị trí';
      previewText.classList.remove('text-green-600', 'font-semibold');
      previewText.classList.add('text-gray-500');
    }
    const outletBtn = document.getElementById('btn-locate-outlet');
    if (outletBtn) { outletBtn.textContent = 'Chọn định vị Outlet'; outletBtn.title = 'Chọn định vị Outlet'; }
    const locLabel = document.getElementById('outletLocationLabel');
    if (locLabel) {
      locLabel.textContent = 'Ảnh không có GPS (EXIF không chứa tọa độ), vui lòng chọn vị trí thủ công:';
      locLabel.classList.remove('text-green-600');
      locLabel.classList.add('text-red-600');
    }
  } catch (e) {}
}

function openSavedLocation(latArg, lngArg) {
  setMapExifStatus(null);
  let lat = typeof latArg !== 'undefined' ? parseFloat(latArg) : parseFloat(document.getElementById('outletLat').value || 0);
  let lng = typeof lngArg !== 'undefined' ? parseFloat(lngArg) : parseFloat(document.getElementById('outletLng').value || 0);
  if (!lat || !lng) { showToast('Không có vị trí đã lưu'); return; }
  document.getElementById('outletLat').value = lat;
  document.getElementById('outletLng').value = lng;
  document.getElementById('mapModal').classList.remove('hidden');
  document.getElementById('mapModal').classList.add('flex');
  switchLocTab('map');
  setTimeout(() => {
    if (lMap) {
      lMap.invalidateSize();
      lMap.setView([lat, lng], 17);
      if (!lMarker) lMarker = L.marker([lat, lng]).addTo(lMap);
      else lMarker.setLatLng([lat, lng]);
      pickedLatLng = { lat, lng };
      reverseGeocode(lat, lng, (addr) => {
        document.getElementById('pickedCoords').textContent = addr || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      });
    }
  }, 200);
}

function openMapPicker() { switchLocTab('map'); }

const LOCATE_ICON_SVG = '<svg class="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><circle cx="12" cy="12" r="8"></circle><line x1="12" y1="2" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="22"></line><line x1="2" y1="12" x2="4" y2="12"></line><line x1="20" y1="12" x2="22" y2="22"></line></svg> <span>Hiện tại</span>';

// Center Leaflet map on user's current GPS position
function locateMeOnMap() {
  if (!navigator.geolocation || !lMap) return;
  const btn = document.getElementById('locateMeBtn');
  const span = btn ? btn.querySelector('span') : null;
  const svg = btn ? btn.querySelector('svg') : null;
  const originalText = span ? span.textContent : 'Hiện tại';

  if (btn) {
    btn.disabled = true;
    if (span) span.textContent = 'Đang lấy...';
    if (svg) svg.classList.add('animate-spin');
  }

  const restoreBtn = () => {
    if (btn) {
      btn.disabled = false;
      if (span) span.textContent = originalText;
      if (svg) svg.classList.remove('animate-spin');
    }
  };

  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    try {
      localStorage.setItem('ks_last_gps_location', JSON.stringify({ lat, lng }));
    } catch (e) {}
    lMap.setView([lat, lng], 16);
    if (!lMarker) lMarker = L.marker([lat, lng]).addTo(lMap);
    else lMarker.setLatLng([lat, lng]);
    pickedLatLng = { lat, lng };
    _updateSaveBtn();
    document.getElementById('pickedCoords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    _setPickedCoordsSub(lat, lng);
    reverseGeocode(lat, lng, (addr) => {
      if (addr) document.getElementById('pickedCoords').textContent = addr;
    });
    restoreBtn();
  }, (err) => {
    restoreBtn();
    showToast('Không lấy được vị trí');
  }, { enableHighAccuracy: true, timeout: 10000 });
}


let multiMarkers = [];
function showMultiLocationPicker(locations) {
  if (typeof showToast === 'function') {
    showToast('Vui lòng chạm vào ghim để chọn vị trí chính xác nhất cho các ảnh.', 5000);
  }
  openLocationModal();
  setTimeout(() => {
    if (!lMap) return;
    if (lMarker) { lMap.removeLayer(lMarker); lMarker = null; }
    multiMarkers.forEach(m => lMap.removeLayer(m));
    multiMarkers = [];
    let bounds = L.latLngBounds();
    locations.forEach((loc, index) => {
      let marker = L.marker([loc.lat, loc.lng]).addTo(lMap);
      marker.bindTooltip('Vị trí ' + (index + 1), {permanent: true, direction: 'top'}).openTooltip();
      marker.on('click', function() {
        pickedLatLng = { lat: loc.lat, lng: loc.lng };
        multiMarkers.forEach(m => m.setOpacity(0.5));
        marker.setOpacity(1);
        document.getElementById('pickedCoords').textContent = `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
        _updateSaveBtn();
        reverseGeocode(loc.lat, loc.lng, (addr) => {
          document.getElementById('pickedCoords').textContent = addr || `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`;
        });
      });
      bounds.extend([loc.lat, loc.lng]);
      multiMarkers.push(marker);
    });
    lMap.fitBounds(bounds, { padding: [50, 50] });
    pickedLatLng = null;
    _updateSaveBtn();
    document.getElementById('pickedCoords').textContent = 'Chọn một ghim trên bản đồ';
  }, 500);
}

// ====================================================================
// EXIF Photo GPS Extraction Module (Song song với chọn vị trí bản đồ)
// ====================================================================

function setMapExifStatus(type, message) {
  const el = document.getElementById('mapExifStatus');
  if (!el) return;
  if (!type || !message) {
    el.innerHTML = '';
    return;
  }
  if (type === 'loading') {
    el.innerHTML = `
      <span class="inline-flex items-center gap-1.5 text-blue-600 dark:text-blue-400 font-medium text-xs">
        <svg class="w-3.5 h-3.5 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <span class="truncate">${message}</span>
      </span>`;
  } else if (type === 'success') {
    el.innerHTML = `
      <span class="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-semibold text-xs">
        <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <span class="truncate">${message}</span>
      </span>`;
  } else if (type === 'error') {
    el.innerHTML = `
      <span class="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400 font-medium text-xs" title="${message}">
        <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
        </svg>
        <span class="truncate">${message}</span>
      </span>`;
  }
}

function triggerMapExifPicker() {
  const input = document.getElementById('mapExifFileInput');
  if (input) {
    input.value = ''; // Cho phép chọn lại cùng một file
    input.click();
  }
}

function handleMapExifFileInput(input) {
  if (!input || !input.files || !input.files[0]) return;
  const file = input.files[0];
  processMapExifFile(file);
}

function processMapExifFile(file) {
  if (!file) return;
  setMapExifStatus('loading', 'Đang trích xuất toạ độ GPS từ EXIF...');

  let exifPromise;
  if (typeof getExifLocation === 'function') {
    exifPromise = getExifLocation(file);
  } else if (typeof EXIF !== 'undefined') {
    exifPromise = new Promise(function(resolve) {
      try {
        EXIF.getData(file, function() {
          const lat = EXIF.getTag(this, "GPSLatitude");
          const lon = EXIF.getTag(this, "GPSLongitude");
          const latRef = EXIF.getTag(this, "GPSLatitudeRef") || "N";
          const lonRef = EXIF.getTag(this, "GPSLongitudeRef") || "E";
          if (lat && lon) {
            const parseVal = function(v) {
              if (v && v.numerator !== undefined && v.denominator !== undefined) {
                return v.denominator === 0 ? 0 : (v.numerator / v.denominator);
              }
              return Number(v) || 0;
            };
            let ddLat = parseVal(lat[0]) + parseVal(lat[1]) / 60 + parseVal(lat[2]) / 3600;
            if (latRef === "S" || latRef === "w") ddLat = -ddLat;
            let ddLon = parseVal(lon[0]) + parseVal(lon[1]) / 60 + parseVal(lon[2]) / 3600;
            if (lonRef === "W" || lonRef === "w") ddLon = -ddLon;
            resolve({ lat: ddLat, lng: ddLon });
          } else {
            resolve(null);
          }
        });
      } catch (e) {
        resolve(null);
      }
    });
  } else {
    setMapExifStatus('error', 'Thư viện EXIF chưa sẵn sàng trên trình duyệt');
    return;
  }

  exifPromise.then(function(coords) {
    if (coords && coords.lat && coords.lng) {
      const lat = parseFloat(coords.lat);
      const lng = parseFloat(coords.lng);
      pickedLatLng = { lat: lat, lng: lng };

      if (lMap) {
        lMap.setView([lat, lng], 18);
        if (!lMarker) lMarker = L.marker([lat, lng]).addTo(lMap);
        else lMarker.setLatLng([lat, lng]);
      }

      document.getElementById('pickedCoords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      _setPickedCoordsSub(lat, lng);
      _updateSaveBtn();

      reverseGeocode(lat, lng, function(addr) {
        if (addr) document.getElementById('pickedCoords').textContent = addr;
      });

      setMapExifStatus('success', `Đã lấy GPS từ EXIF: ${lat.toFixed(6)}, ${lng.toFixed(6)} (Đã ghim)`);
      if (typeof showToast === 'function') {
        showToast('Trích xuất GPS từ ảnh thành công!');
      }
    } else {
      setMapExifStatus('error', 'Ảnh không chứa toạ độ GPS trong EXIF — Vui lòng chọn trên bản đồ');
      if (typeof showToast === 'function') {
        showToast('Ảnh không có dữ liệu GPS (EXIF trống)');
      }
    }
  }).catch(function(err) {
    console.warn('[Map EXIF] Lỗi đọc dữ liệu EXIF:', err);
    setMapExifStatus('error', 'Không thể đọc EXIF từ file — Vui lòng chọn trên bản đồ');
  });
}

