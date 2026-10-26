// ====================================================================
// js/shared/image-utils.js — image file reading and preview rendering
// ====================================================================
'use strict';

/**
 * Detects real MIME type by checking magic bytes.
 */
var _HEIC_SENTINEL_PREFIX = '__heic__:';

function _isLikelyHeicLikeUrl(url) {
  var value = String(url || '').toLowerCase();
  return value.indexOf('data:image/heic') === 0 ||
    value.indexOf('data:image/heif') === 0 ||
    /(?:\.heic|\.heif|\.bin)(?:$|[?#])/.test(value) ||
    value.indexOf('contenttype=image%2fheic') !== -1 ||
    value.indexOf('content-type=image%2fheic') !== -1 ||
    value.indexOf('contenttype=image/heic') !== -1 ||
    value.indexOf('content-type=image/heic') !== -1;
}

function _copyTextToClipboard(text) {
  var value = String(text || '');
  if (!value) return Promise.reject(new Error('empty_text'));
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(value);
  }
  return new Promise(function (resolve, reject) {
    try {
      var textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', 'readonly');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!ok) throw new Error('copy_failed');
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

function _copyBrokenImageUrl(encodedUrl, event) {
  if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
  var rawUrl = '';
  try {
    rawUrl = decodeURIComponent(String(encodedUrl || ''));
  } catch (e) {
    rawUrl = String(encodedUrl || '');
  }
  if (!rawUrl) {
    if (typeof showToast === 'function') showToast('Không có URL để copy');
    return false;
  }
  _copyTextToClipboard(rawUrl).then(function () {
    if (typeof showToast === 'function') showToast('Đã copy URL ảnh');
  }).catch(function () {
    if (typeof showToast === 'function') showToast('Không thể copy URL ảnh');
  });
  return false;
}

function _detectImageMimeByMagic(file) {
  return new Promise(function(resolve) {
    if (!file) return resolve(null);
    var ext = (file.name || '').toLowerCase();
    var mime = (file.type || '').toLowerCase();
    if (ext.endsWith('.heic') || ext.endsWith('.heif') || mime === 'image/heic' || mime === 'image/heif') {
      return resolve('image/heic');
    }
    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var arr = new Uint8Array(e.target.result);
        if (arr[0] === 0xFF && arr[1] === 0xD8 && arr[2] === 0xFF) { return resolve('image/jpeg'); }
        if (arr[0] === 0x89 && arr[1] === 0x50 && arr[2] === 0x4E && arr[3] === 0x47) { return resolve('image/png'); }
        if (arr[0] === 0x52 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x46 && arr[8] === 0x57 && arr[9] === 0x45 && arr[10] === 0x42 && arr[11] === 0x50) { return resolve('image/webp'); }
        if (arr.length >= 12 && arr[4] === 0x66 && arr[5] === 0x74 && arr[6] === 0x79 && arr[7] === 0x70) {
          var brand = String.fromCharCode(arr[8], arr[9], arr[10], arr[11]).toLowerCase();
          if (['heic', 'heix', 'hevc', 'hevm', 'heim', 'heis', 'mif1', 'msf1'].indexOf(brand) !== -1) {
            return resolve('image/heic');
          }
        }
        resolve(file.type || null);
      } catch (err) {
        resolve(file.type || null);
      }
    };
    reader.onerror = function() { resolve(file.type || null); };
    reader.readAsArrayBuffer(file.slice(0, 16));
  });
}

function _isBrowserRenderable(mime) {
  return mime === 'image/jpeg' || mime === 'image/png' ||
         mime === 'image/gif'  || mime === 'image/webp';
}

/**
 * Converts HEIC to JPEG.
 */
async function _convertHeicToJpeg(heicFile) {
  if (typeof heic2any === 'undefined') {
    console.warn('heic2any not loaded.');
    throw new Error('heic2any_not_loaded');
  }
  try {
    const result = await heic2any({
      blob: heicFile,
      toType: 'image/jpeg',
      quality: 0.82,
    });
    // heic2any can return an array if the HEIC contains multiple images
    return Array.isArray(result) ? result[0] : result;
  } catch (e) {
    console.error('HEIC conversion failed:', e);
    throw e;
  }
}

// ── Compress a File/Blob to a smaller data URL (WebP preferred, JPEG fallback) ──
function _compressImageFile(file, maxDim, quality, forceJpeg) {
  maxDim  = maxDim || 1920;
  quality = quality || 0.85;
  return new Promise(function (resolve, reject) {
    function createObjectUrl(blob) {
      try {
        return URL.createObjectURL(blob);
      } catch (e) {
        return null;
      }
    }

    function processImageBlob(blob) {
      var url = createObjectUrl(blob);
      if (!url) return reject(new Error('Unable to create object URL')); 
      var img = new Image();
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Image decode error'));
      };
      img.onload = function () {
        try {
          var w = img.naturalWidth  || img.width;
          var h = img.naturalHeight || img.height;
          if (w > maxDim || h > maxDim) {
            var ratio = Math.min(maxDim / w, maxDim / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          var canvas = document.createElement('canvas');
          canvas.width  = w;
          canvas.height = h;
          var ctx = canvas.getContext('2d');
          if (!ctx) {
            URL.revokeObjectURL(url);
            return reject(new Error('Canvas 2D context unavailable'));
          }
          ctx.drawImage(img, 0, 0, w, h);
          var dataUrl = '';
          if (forceJpeg) {
            dataUrl = canvas.toDataURL('image/jpeg', quality);
          } else {
            try {
              dataUrl = canvas.toDataURL('image/webp', quality);
              if (!dataUrl || dataUrl.indexOf('data:image/webp') !== 0) throw new Error('webp unsupported');
            } catch (_e) {
              dataUrl = canvas.toDataURL('image/jpeg', quality);
            }
          }
          URL.revokeObjectURL(url);
          resolve(dataUrl);
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.src = url;
    }

    _detectImageMimeByMagic(file).then(function (detectedMime) {
      if (detectedMime === 'image/heic') {
        var testUrl = createObjectUrl(file);
        if (testUrl) {
          var testImg = new Image();
          testImg.onload = function () {
            URL.revokeObjectURL(testUrl);
            processImageBlob(file);
          };
          testImg.onerror = function () {
            URL.revokeObjectURL(testUrl);
            _convertHeicToJpeg(file).then(processImageBlob).catch(reject);
          };
          testImg.src = testUrl;
          return;
        }
        return _convertHeicToJpeg(file).then(processImageBlob).catch(reject);
      }
      processImageBlob(file);
    }).catch(function () {
      processImageBlob(file);
    });
  });
}

// Compress an array of File objects → array of data URLs.
// Skips files that fail to compress (logs warning).
async function _compressImageFiles(files, maxDim, quality) {
  var results = [];
  for (var i = 0; i < files.length; i++) {
    try {
      var dataUrl = await _compressImageFile(files[i], maxDim, quality);
      if (dataUrl) results.push(dataUrl);
    } catch (e) {
      console.warn('[compress] failed for file', i, '— skipping:', e);
    }
  }
  return results;
}

function _processImageFile(file) {
  return _detectImageMimeByMagic(file).then(function (realMime) {
    var isHeic = (realMime === 'image/heic');

    if (isHeic) {
      return _compressImageFile(file, 1600, 0.85).then(function (dataUrl) {
        return { previewValue: dataUrl, uploadValue: dataUrl };
      }).catch(function (heicErr) {
        console.warn('[HEIC] Conversion fallback:', heicErr);
        return new Promise(function (resolve) {
          var reader = new FileReader();
          reader.onload = function (e) {
            var raw = e.target.result || '';
            var uploadValue = raw.replace(/^data:[^;]+/, 'data:image/heic');
            var label = file.name || 'ảnh';
            resolve({ previewValue: _HEIC_SENTINEL_PREFIX + label, uploadValue: uploadValue });
          };
          reader.onerror = function () {
            try {
              var u = URL.createObjectURL(file);
              resolve({ previewValue: u, uploadValue: file });
            } catch (_) {
              resolve(null);
            }
          };
          reader.readAsDataURL(file);
        });
      });
    }

    // Normal images (JPEG, PNG, WebP)
    // Compress once to 1600px with high quality (0.85).
    // The resulting compressedUrl (~150-300KB) is ALREADY optimized for both preview and upload!
    return _compressImageFile(file, 1600, 0.85, true).then(function (compressedUrl) {
      var uploadUrl = compressedUrl;

      // Optional: attempt piexif injection ONLY if piexif is loaded and format is JPEG
      if (typeof piexif !== 'undefined' && (realMime === 'image/jpeg' || (file.type && file.type === 'image/jpeg'))) {
        try {
          readRawDataUrl(file).then(function (rawDataUrl) {
            try {
              var exifObj = piexif.load(rawDataUrl);
              if (exifObj) {
                delete exifObj["thumbnail"];
                if (exifObj["0th"]) {
                  exifObj["0th"][piexif.ImageIFD.Orientation || 274] = 1;
                }
                var exifStr = piexif.dump(exifObj);
                var injected = piexif.insert(exifStr, compressedUrl);
                if (injected && injected.startsWith('data:image/jpeg')) {
                  uploadUrl = injected;
                }
              }
            } catch (e) {
              console.warn('[EXIF] piexif skipped:', (e && e.message) || e);
            }
          }).catch(function () {});
        } catch (_) {}
      }

      // Return compressedUrl directly as previewValue — NEVER do a second canvas compression!
      return { previewValue: compressedUrl, uploadValue: uploadUrl };
    }).catch(function (compressErr) {
      console.warn('[compress] _compressImageFile failed, falling back to raw:', compressErr);
      return readRawDataUrl(file).then(function (rawDataUrl) {
        return { previewValue: rawDataUrl, uploadValue: rawDataUrl };
      }).catch(function () {
        try {
          var u = URL.createObjectURL(file);
          return { previewValue: u, uploadValue: file };
        } catch (_) {
          return null;
        }
      });
    });
  });
}

// handleOldContentImages is intentionally a no-op — old_content_images DB column
// was dropped. Images no longer collected for old-content field.
// The toggle shows/hides the oldContentSection textarea only.
function handleOldContentImages(input) {
  if (input) input.value = '';
}

async function handleStatusImages(input) {
  if (!input || !input.files || input.files.length === 0) return;
  const rawFiles = Array.from(input.files);

  // Background location extraction from GPS / EXIF (does not block image processing)
  try {
    processBatchLocations(rawFiles);
  } catch (locErr) {
    console.warn('[GPS] processBatchLocations error:', locErr);
  }

  // Sequentially process each selected file with guaranteed instant preview
  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    const slotIndex = statusImages.length;

    // 1. Immediately create a lightweight object URL so the user INSTANTLY sees preview
    let instantPreview = '';
    try {
      instantPreview = URL.createObjectURL(file);
    } catch (_) {
      instantPreview = _HEIC_SENTINEL_PREFIX + (file.name || 'ảnh');
    }
    statusImages.push(instantPreview);
    _statusImageFiles.push('');
    renderImagePreviews('statusImagesPreview', statusImages, 'status');

    // 2. Process & compress in background
    try {
      const result = await _processImageFile(file);
      if (result && (result.previewValue || result.uploadValue)) {
        if (instantPreview && instantPreview.startsWith('blob:') && result.previewValue !== instantPreview) {
          try { URL.revokeObjectURL(instantPreview); } catch (_) {}
        }
        statusImages[slotIndex] = result.previewValue || result.uploadValue;
        _statusImageFiles[slotIndex] = result.uploadValue || result.previewValue;
      } else {
        const raw = await readRawDataUrl(file).catch(() => '');
        if (raw) {
          statusImages[slotIndex] = raw;
          _statusImageFiles[slotIndex] = raw;
        } else {
          _statusImageFiles[slotIndex] = file;
        }
      }
    } catch (procErr) {
      console.warn('[handleStatusImages] error processing file, fallback to raw:', procErr);
      try {
        const raw = await readRawDataUrl(file);
        statusImages[slotIndex] = raw;
        _statusImageFiles[slotIndex] = raw;
      } catch (_) {
        _statusImageFiles[slotIndex] = file;
      }
    }

    renderImagePreviews('statusImagesPreview', statusImages, 'status');
  }

  // 3. CRITICAL: Clear input.value ONLY AFTER all files are completely processed into memory.
  // Never clear before reading, which would revoke Android SAF content URI permissions.
  try { input.value = ''; } catch (_) {}
}

async function handleWarrantyImages(input) {
  if (!input || !input.files || input.files.length === 0) return;
  const rawFiles = Array.from(input.files);

  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    const slotIndex = warrantyImages.length;

    let instantPreview = '';
    try {
      instantPreview = URL.createObjectURL(file);
    } catch (_) {
      instantPreview = _HEIC_SENTINEL_PREFIX + (file.name || 'ảnh');
    }
    warrantyImages.push(instantPreview);
    renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');

    try {
      const result = await _processImageFile(file);
      if (result && (result.previewValue || result.uploadValue)) {
        if (instantPreview && instantPreview.startsWith('blob:') && result.previewValue !== instantPreview) {
          try { URL.revokeObjectURL(instantPreview); } catch (_) {}
        }
        warrantyImages[slotIndex] = result.previewValue || result.uploadValue;
      } else {
        const raw = await readRawDataUrl(file).catch(() => '');
        if (raw) {
          warrantyImages[slotIndex] = raw;
        }
      }
    } catch (procErr) {
      console.warn('[handleWarrantyImages] error processing file:', procErr);
      try {
        const raw = await readRawDataUrl(file);
        warrantyImages[slotIndex] = raw;
      } catch (_) {}
    }

    renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');
  }

  try { input.value = ''; } catch (_) {}
}

function renderImagePreviews(containerId, images, type) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = images.map(function (img, idx) {
    var isHeic = typeof img === 'string' && img.indexOf(_HEIC_SENTINEL_PREFIX) === 0;
    var label = isHeic ? img.slice(_HEIC_SENTINEL_PREFIX.length) : '';
    var isProcessing = isHeic && (label.indexOf('ảnh') !== -1 || label.indexOf('Đang') !== -1);
    var mediaHtml;

    if (isHeic) {
      mediaHtml = '<div style="' +
        'width:80px;height:80px;background:#1e293b;border-radius:8px;' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'gap:4px;padding:6px;box-sizing:border-box;border:1px solid #334155;">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5">' +
        '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
        '<circle cx="8.5" cy="8.5" r="1.5"/>' +
        '<polyline points="21 15 16 10 5 21"/>' +
        '</svg>' +
        '<span style="font-size:9px;color:#94a3b8;text-align:center;word-break:break-all;max-width:90%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">' +
        (isProcessing ? 'Đang xử lý...' : _escapeHtmlAttr(label)) +
        '</span>' +
        '</div>';
    } else {
      mediaHtml = '<img src="' + img + '" class="image-preview rounded-lg object-cover" style="width:80px;height:80px;display:block;" onerror="_imgBrokenFallback(this)">';
    }

    return '<div class="relative inline-block" style="width:80px;height:80px;">' +
      mediaHtml +
      '<button type="button" onclick="removeImage(\'' + type + '\', ' + idx + ')" class="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center shadow z-10">' +
        '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>' +
        '</svg>' +
      '</button>' +
    '</div>';
  }).join('');
}

function _escapeHtmlAttr(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _renderBrokenImageFallbackHtml(src) {
  var rawSrc = String(src || '');
  var encodedSrc = encodeURIComponent(rawSrc);
  var label = _isLikelyHeicLikeUrl(rawSrc) ? 'HEIC / .bin' : 'Ảnh lỗi';
  return '<div style="' +
    'width:100%;height:80px;background:#1e293b;border-radius:8px;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'gap:4px;padding:8px;box-sizing:border-box;border:1px solid #334155;">' +
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5">' +
    '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
    '<circle cx="8.5" cy="8.5" r="1.5"/>' +
    '<polyline points="21 15 16 10 5 21"/>' +
    '<line x1="2" y1="2" x2="22" y2="22"/>' +
    '</svg>' +
    '<span style="font-size:10px;color:#94a3b8;">' + _escapeHtmlAttr(label) + '</span>' +
    '<button type="button" onclick="return _copyBrokenImageUrl(\'' + encodedSrc + '\', event)" style="' +
      'margin-top:2px;padding:2px 8px;border-radius:999px;border:1px solid #475569;' +
      'background:#0f172a;color:#e2e8f0;font-size:10px;font-weight:600;cursor:pointer;">' +
      'Copy URL' +
    '</button>' +
    '</div>';
}

// Fallback for images that cannot be rendered (e.g. old .bin HEIC files stored on GCS).
// Replaces the broken img with a simple grey placeholder icon.
function _imgBrokenFallback(el) {
  if (!el) return;
  el.onerror = null;
  var originalSrc = String(el.currentSrc || el.src || '');
  var parent = el.parentNode;
  if (parent) {
    var placeholder = document.createElement('div');
    placeholder.style.cssText = 'width:100%;height:80px;';
    placeholder.innerHTML = _renderBrokenImageFallbackHtml(originalSrc);
    parent.replaceChild(placeholder, el);
  }
}

window._copyBrokenImageUrl = _copyBrokenImageUrl;

function removeImage(type, idx) {
  if (type === 'oldContent') {
    // old_content_images column dropped — no-op
    return;
  } else if (type === 'status') {
    try { URL.revokeObjectURL(statusImages[idx]); } catch (e) {}
    statusImages.splice(idx, 1);
    _statusImageFiles.splice(idx, 1);
    renderImagePreviews('statusImagesPreview', statusImages, 'status');
  } else if (type === 'warranty') {
    try { URL.revokeObjectURL(warrantyImages[idx]); } catch (e) {}
    warrantyImages.splice(idx, 1);
    renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');
  }
}

// ── GPS and EXIF metadata extraction helper functions ──
function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // meters
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function applyLocationToForm(loc) {
  const latInput = document.getElementById('outletLat');
  const lngInput = document.getElementById('outletLng');
  const sourceInput = document.getElementById('locationSource');
  if (latInput) latInput.value = loc.lat;
  if (lngInput) lngInput.value = loc.lng;
  if (sourceInput) sourceInput.value = loc.source;

  try {
    localStorage.setItem('ks_last_gps_location', JSON.stringify({ lat: loc.lat, lng: loc.lng }));
  } catch (e) {}

  if (typeof setLocationPreview === 'function') {
    const labelText = loc.source === 'device_gps' ? 'GPS Thiết bị' : 'Đọc từ ảnh (EXIF)';
    setLocationPreview(labelText, loc.lat, loc.lng);
  }
  if (typeof showToast === 'function') {
    showToast('Đã tự động lấy vị trí từ ' + (loc.source === 'device_gps' ? 'GPS thiết bị' : 'GPS ảnh'));
  }
}

function processBatchLocations(files) {
  // 1. Check if Outlet Code already set the location (locked)
  if (window.isOutletLockedLocation) {
    console.log('[GPS] Location is locked by Outlet Code, skipping EXIF.');
    return;
  }
  
  // 2. Or if coordinates are manually set already
  const currentLat = document.getElementById('outletLat') ? document.getElementById('outletLat').value : '';
  const currentLng = document.getElementById('outletLng') ? document.getElementById('outletLng').value : '';
  if (currentLat && currentLng) {
    console.log('[GPS] Coordinates already set, skipping auto-fetch.');
    return;
  }

  const promises = files.map(function(file) {
    const isCaptured = (Date.now() - file.lastModified) < 30000;
    if (isCaptured) {
      return getDeviceLocation().then(function(loc) {
        if (loc) return loc;
        return getExifLocation(file);
      });
    } else {
      return getExifLocation(file);
    }
  });

  Promise.all(promises).then(function(results) {
    const validLocs = results.filter(function(l) { return l && l.lat && l.lng; });
    if (validLocs.length === 0) return; // No EXIF, leaving blank

    // Clustering logic (radius 300m)
    let clusters = [];
    validLocs.forEach(function(loc) {
      let added = false;
      for (var i = 0; i < clusters.length; i++) {
        const center = clusters[i][0];
        if (getHaversineDistance(loc.lat, loc.lng, center.lat, center.lng) <= 300) {
          clusters[i].push(loc);
          added = true;
          break;
        }
      }
      if (!added) {
        clusters.push([loc]);
      }
    });

    if (clusters.length === 1) {
      applyLocationToForm(clusters[0][0]);
    } else if (clusters.length > 1) {
      const centerCoords = clusters.map(function(c) { return c[0]; });
      if (typeof showMultiLocationPicker === 'function') {
        showMultiLocationPicker(centerCoords);
      } else {
        // Fallback if not implemented yet
        applyLocationToForm(clusters[0][0]);
      }
    }
  }).catch(function(err) {
    console.warn('[GPS] Batch location extraction error:', err);
  });
}

function getDeviceLocation() {
  return new Promise(function (resolve) {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          source: 'device_gps'
        });
      },
      function (err) {
        console.warn('[GPS] Device Geolocation error:', err);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

function getExifLocation(file) {
  return new Promise(function (resolve) {
    if (typeof EXIF === 'undefined') {
      console.warn('[GPS] EXIF library is not loaded');
      return resolve(null);
    }
    try {
      EXIF.getData(file, function () {
        const lat = EXIF.getTag(this, "GPSLatitude");
        const lon = EXIF.getTag(this, "GPSLongitude");
        const latRef = EXIF.getTag(this, "GPSLatitudeRef") || "N";
        const lonRef = EXIF.getTag(this, "GPSLongitudeRef") || "E";

        if (lat && lon) {
          const convertDMSToDD = function (dms, ref) {
            const parseVal = function(v) {
              if (v && v.numerator !== undefined && v.denominator !== undefined) {
                return v.denominator === 0 ? 0 : (v.numerator / v.denominator);
              }
              return Number(v) || 0;
            };
            let dd = parseVal(dms[0]) + parseVal(dms[1])/60 + parseVal(dms[2])/3600;
            if (ref === "S" || ref === "W") {
              dd = -dd;
            }
            return dd;
          };
          try {
            const decimalLat = convertDMSToDD(lat, latRef);
            const decimalLng = convertDMSToDD(lon, lonRef);
            resolve({
              lat: decimalLat,
              lng: decimalLng,
              source: 'photo_exif'
            });
          } catch (err) {
            console.warn('[GPS] Failed to convert EXIF DMS to DD:', err);
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    } catch (e) {
      console.warn('[GPS] EXIF.getData failed:', e);
      resolve(null);
    }
  });
}

function checkHasExif(file) {
  return new Promise(function (resolve) {
    if (typeof EXIF === 'undefined') return resolve(false);
    try {
      EXIF.getData(file, function () {
        const allTags = EXIF.getAllTags(this);
        resolve(allTags && Object.keys(allTags).length > 0);
      });
    } catch (e) {
      console.warn('[GPS] EXIF tags check failed:', e);
      resolve(false);
    }
  });
}

function readRawDataUrl(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function (e) { resolve(e.target.result); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

