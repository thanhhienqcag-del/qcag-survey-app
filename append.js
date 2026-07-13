const fs = require('fs');
const content = `

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
        document.getElementById('pickedCoords').textContent = \`\${loc.lat.toFixed(6)}, \${loc.lng.toFixed(6)}\`;
        _updateSaveBtn();
        reverseGeocode(loc.lat, loc.lng, (addr) => {
          document.getElementById('pickedCoords').textContent = addr || \`\${loc.lat.toFixed(6)}, \${loc.lng.toFixed(6)}\`;
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
`;
fs.appendFileSync('g:/10. Code/QCAG-Production Main/QCAG-Production/App-2-KS-Khao-Sat/frontend/app/js/shared/location.js', content);
