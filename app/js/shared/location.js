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
    }
    return;
  }

  const defaultCenter = hasCoords ? [latVal, lngVal] : [10.7769, 106.7009];
  lMap = L.map('mapContainer', { zoomControl: true }).setView(defaultCenter, hasCoords ? 16 : 14);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(lMap);

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
    reverseGeocode(lat, lng, (addr) => {
      document.getElementById('pickedCoords').textContent = addr || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    });
  });

  if (hasCoords) {
    lMarker = L.marker([latVal, lngVal]).addTo(lMap);
    pickedLatLng = { lat: latVal, lng: lngVal };
    document.getElementById('pickedCoords').textContent = `${latVal.toFixed(6)}, ${lngVal.toFixed(6)}`;
  }
}

function reverseGeocode(lat, lng, cb) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
  fetch(url)
    .then(r => r.json())
    .then(d => cb(d.display_name || null))
    .catch(() => cb(null));
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

function savePickedLocation() {
  if (!pickedLatLng) { showToast('Vui lòng chọn một vị trí trên bản đồ'); return; }
  document.getElementById('outletLat').value = pickedLatLng.lat;
  document.getElementById('outletLng').value = pickedLatLng.lng;
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
  if (previewText) previewText.classList.add('hidden');
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
}

function clearLocationPreview() {
  try {
    document.getElementById('outletLat').value = '';
    document.getElementById('outletLng').value = '';
    const previewText = document.getElementById('locationPreviewText');
    const actionBtn = document.getElementById('locationActionBtn');
    if (actionBtn) { actionBtn.classList.add('hidden'); actionBtn.textContent = ''; }
    if (previewText) { previewText.classList.remove('hidden'); previewText.textContent = 'Chưa có vị trí'; }
    const outletBtn = document.getElementById('btn-locate-outlet');
    if (outletBtn) { outletBtn.textContent = 'Chọn định vị Outlet'; outletBtn.title = 'Chọn định vị Outlet'; }
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
