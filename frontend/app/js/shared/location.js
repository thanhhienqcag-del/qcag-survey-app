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
  document.getElementById('mapModal').classList.remove('hidden');
  document.getElementById('mapModal').classList.add('flex');
  // Default to map selection tab (user wants to pick on map first)
  switchLocTab('map');
}

function closeMapModal() {
  document.getElementById('mapModal').classList.add('hidden');
  document.getElementById('mapModal').classList.remove('flex');
}

function switchLocTab(tab) {
  locCurrentTab = tab;
  document.getElementById('locPanelGPS').classList.toggle('hidden', tab !== 'gps');
  document.getElementById('locPanelMap').classList.toggle('hidden', tab !== 'map');
  document.getElementById('locTabGPS').className = tab === 'gps'
    ? 'flex-1 py-2 rounded-lg text-sm font-medium bg-gray-900 text-white'
    : 'flex-1 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700';
  document.getElementById('locTabMap').className = tab === 'map'
    ? 'flex-1 py-2 rounded-lg text-sm font-medium bg-gray-900 text-white'
    : 'flex-1 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-700';

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
    } else {
      // Chưa có vị trí đã lưu → xóa ghim cũ (chưa save) khỏi bản đồ
      pickedLatLng = null;
      if (lMarker) { lMarker.remove(); lMarker = null; }
      document.getElementById('pickedCoords').textContent = 'Tap vào bản đồ để chọn vị trí';
    }
    _updateSaveBtn();
    return;
  }

  const defaultCenter = hasCoords ? [latVal, lngVal] : [10.7769, 106.7009];
  // Create map with increased maxZoom to allow deeper zoom levels (will upscale tiles
  // if provider doesn't supply native tiles at that zoom).
  lMap = L.map('mapContainer', { zoomControl: true, maxZoom: 25 }).setView(defaultCenter, hasCoords ? 18 : 17);

  _osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 25,
    maxNativeZoom: 19
  });
  _satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri &mdash; Sources: Esri, DigitalGlobe, GeoEye, Earthstar Geographics',
    maxZoom: 25,
    maxNativeZoom: 18
  });
  // Transparent label/POI overlay (tên trường, bệnh viện, công ty,...) cho chế độ vệ tinh
  _labelsLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    attribution: '',
    maxZoom: 25,
    maxNativeZoom: 19,
    opacity: 1,
    pane: 'overlayPane'
  });

  // Add the default layer
  if (_currentMapMode === 'satellite') {
    _satLayer.addTo(lMap);
    _labelsLayer.addTo(lMap); // labels on top of satellite
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
      if (!pickedLatLng && lMap) {
        lMap.setView([pos.coords.latitude, pos.coords.longitude], 15);
      }
    }, () => {}, { timeout: 8000, enableHighAccuracy: false });
  }

  lMap.on('click', function (e) {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    pickedLatLng = { lat, lng };
    if (!lMarker) lMarker = L.marker([lat, lng]).addTo(lMap);
    else lMarker.setLatLng([lat, lng]);
    document.getElementById('pickedCoords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    _updateSaveBtn();
    reverseGeocode(lat, lng, (addr) => {
      document.getElementById('pickedCoords').textContent = addr || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    });
  });

  if (hasCoords) {
    lMarker = L.marker([latVal, lngVal]).addTo(lMap);
    pickedLatLng = { lat: latVal, lng: lngVal };
    document.getElementById('pickedCoords').textContent = `${latVal.toFixed(6)}, ${lngVal.toFixed(6)}`;
  } else {
    pickedLatLng = null;
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
    btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/></svg> Bản đồ';
    btn.title = 'Chuyển sang bản đồ thường';
  } else {
    btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> Vệ tinh';
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
  document.getElementById('outletLat').value = pickedLatLng.lat;
  document.getElementById('outletLng').value = pickedLatLng.lng;
  const locSourceEl = document.getElementById('locationSource');
  if (locSourceEl) locSourceEl.value = 'manual';
  const displayText = document.getElementById('pickedCoords').textContent;
  setLocationPreview(displayText, pickedLatLng.lat, pickedLatLng.lng);
  closeMapModal();
  showToast('Đã lưu vị trí');
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
      lMap.setView([lat, lng], 17);
      if (!lMarker) lMarker = L.marker([lat, lng]).addTo(lMap);
      else lMarker.setLatLng([lat, lng]);
      pickedLatLng = { lat, lng };
      reverseGeocode(lat, lng, (addr) => {
        document.getElementById('pickedCoords').textContent = addr || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      });
    }
  }, 300);
}

function openMapPicker() { switchLocTab('map'); }

// Center Leaflet map on user's current GPS position
function locateMeOnMap() {
  if (!navigator.geolocation || !lMap) return;
  const btn = document.getElementById('locateMeBtn');
  if (btn) btn.textContent = '...';
  navigator.geolocation.getCurrentPosition((pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    lMap.setView([lat, lng], 16);
    if (!lMarker) lMarker = L.marker([lat, lng]).addTo(lMap);
    else lMarker.setLatLng([lat, lng]);
    pickedLatLng = { lat, lng };
    _updateSaveBtn();
    document.getElementById('pickedCoords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    reverseGeocode(lat, lng, (addr) => {
      if (addr) document.getElementById('pickedCoords').textContent = addr;
    });
    if (btn) btn.textContent = '◎';
  }, (err) => {
    if (btn) btn.textContent = '◎';
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
