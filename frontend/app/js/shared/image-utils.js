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
    var reader = new FileReader();
    reader.onload = function(e) {
      var arr = new Uint8Array(e.target.result);
      if (arr[0] === 0xFF && arr[1] === 0xD8 && arr[2] === 0xFF) { resolve('image/jpeg'); }
      else if (arr[0] === 0x89 && arr[1] === 0x50 && arr[2] === 0x4E && arr[3] === 0x47) { resolve('image/png'); }
      else if (arr[0] === 0x52 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x46 && arr[8] === 0x57 && arr[9] === 0x45 && arr[10] === 0x42 && arr[11] === 0x50) { resolve('image/webp'); }
      else if (arr.length >= 12 && arr[4] === 0x66 && arr[5] === 0x74 && arr[6] === 0x79 && arr[7] === 0x70 && ((arr[8] === 0x68 && arr[9] === 0x65 && arr[10] === 0x69 && arr[11] === 0x63) || (arr[8] === 0x68 && arr[9] === 0x65 && arr[10] === 0x69 && arr[11] === 0x78))) { resolve('image/heic'); }
      else { resolve(null); }
    };
    reader.onerror = function() { resolve(null); };
    reader.readAsArrayBuffer(file.slice(0, 12));
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
      quality: 0.8,
    });
    // heic2any can return an array if the HEIC contains multiple images
    return Array.isArray(result) ? result[0] : result;
  } catch (e) {
    console.error('HEIC conversion failed:', e);
    throw e;
  }
}

// ── Compress a File/Blob to a smaller data URL (WebP preferred, JPEG fallback) ──
// Default: max 1600px on longest side, quality 0.82 (~100-300KB per image).
// WebP is 30-50% smaller than JPEG at similar quality.
function _compressImageFile(file, maxDim, quality) {
  maxDim  = maxDim  || 1600;
  quality = quality || 0.82;
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
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Image decode error')); };
      img.onload = function () {
        try {
          URL.revokeObjectURL(url);
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
          ctx.drawImage(img, 0, 0, w, h);
          var dataUrl = '';
          try {
            dataUrl = canvas.toDataURL('image/webp', quality);
            if (!dataUrl || dataUrl.indexOf('data:image/webp') !== 0) throw new Error('webp unsupported');
          } catch (_e) {
            dataUrl = canvas.toDataURL('image/jpeg', quality);
          }
          resolve(dataUrl);
        } catch (e) {
          reject(e);
        }
      };
      img.src = url;
    }

    Promise.resolve()
      .then(function () { return _detectImageMimeByMagic(file); })
      .then(function (detectedMime) {
        if (detectedMime === 'image/heic') {
          return _convertHeicToJpeg(file);
        }
        if (detectedMime && detectedMime !== file.type) {
          try {
            return new File([file], file.name || 'image', { type: detectedMime });
          } catch (e) {
            return new Blob([file], { type: detectedMime });
          }
        }
        return file;
      })
      .catch(function () {
        return file;
      })
      .then(processImageBlob)
      .catch(function (err) {
        reject(err);
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
    if (_isBrowserRenderable(realMime)) {
      return _compressImageFile(file, 1600, 0.82).then(function (dataUrl) {
        return { previewValue: dataUrl, uploadValue: dataUrl };
      }).catch(function () {
        return new Promise(function (resolve) {
          var reader = new FileReader();
          reader.onload = function (e) {
            var raw = e.target.result || '';
            resolve({ previewValue: raw, uploadValue: raw });
          };
          reader.onerror = function () { resolve(null); };
          reader.readAsDataURL(file);
        });
      });
    }

    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var raw = e.target.result || '';
        var uploadValue = raw.replace(/^data:[^;]+/, 'data:image/heic');
        var label = file.name || 'ảnh';
        resolve({ previewValue: _HEIC_SENTINEL_PREFIX + label, uploadValue: uploadValue });
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(file);
    });
  });
}

// handleOldContentImages is intentionally a no-op — old_content_images DB column
// was dropped. Images no longer collected for old-content field.
// The toggle shows/hides the oldContentSection textarea only.
function handleOldContentImages(input) {
  if (input) input.value = '';
}

function handleStatusImages(input) {
  const files = Array.from(input.files);
  if (files.length === 0) return;

  // Read file data BEFORE clearing input — some Android browsers invalidate
  // File references when input.value is reset.
  var filesToProcess = [];
  for (var i = 0; i < files.length; i++) {
    filesToProcess.push(files[i]);
  }
  input.value = '';

  filesToProcess.forEach(function (file) {
    var idx = statusImages.length;
    statusImages.push(_HEIC_SENTINEL_PREFIX + (file.name || 'ảnh'));
    _statusImageFiles.push('');
    renderImagePreviews('statusImagesPreview', statusImages, 'status');

    _processImageFile(file).then(function (result) {
      if (!result) {
        console.warn('[handleStatusImages] Cannot read file at index', idx);
        statusImages.splice(idx, 1);
        _statusImageFiles.splice(idx, 1);
        renderImagePreviews('statusImagesPreview', statusImages, 'status');
        return;
      }
      statusImages[idx]      = result.previewValue;
      _statusImageFiles[idx] = result.uploadValue;
      renderImagePreviews('statusImagesPreview', statusImages, 'status');
    }).catch(function (err) {
      console.warn('[handleStatusImages] _processImageFile error:', err);
      statusImages.splice(idx, 1);
      _statusImageFiles.splice(idx, 1);
      renderImagePreviews('statusImagesPreview', statusImages, 'status');
    });
  });
}

function handleWarrantyImages(input) {
  const files = Array.from(input.files);
  input.value = '';
  files.forEach(function (file) {
    var idx = warrantyImages.length;
    warrantyImages.push(_HEIC_SENTINEL_PREFIX + (file.name || 'ảnh'));
    renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');

    _processImageFile(file).then(function (result) {
      if (!result) {
        warrantyImages.splice(idx, 1);
        renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');
        return;
      }
      warrantyImages[idx] = result.previewValue;
      renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');
    }).catch(function (err) {
      console.warn('[handleWarrantyImages] _processImageFile error:', err);
      warrantyImages.splice(idx, 1);
      renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');
    });
  });
}

function renderImagePreviews(containerId, images, type) {
  const container = document.getElementById(containerId);
  container.innerHTML = images.map(function (img, idx) {
    var isHeic = typeof img === 'string' && img.indexOf(_HEIC_SENTINEL_PREFIX) === 0;
    var label = isHeic ? img.slice(_HEIC_SENTINEL_PREFIX.length) : '';
    var isProcessing = isHeic && label.indexOf('ảnh') !== -1;
    var mediaHtml;

    if (isHeic) {
      mediaHtml = '<div style="' +
        'width:100%;height:80px;background:#1e293b;border-radius:8px;' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'gap:4px;padding:8px;box-sizing:border-box;border:1px solid #334155;">' +
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5">' +
        '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
        '<circle cx="8.5" cy="8.5" r="1.5"/>' +
        '<polyline points="21 15 16 10 5 21"/>' +
        '</svg>' +
        '<span style="font-size:10px;color:#94a3b8;text-align:center;word-break:break-all;max-width:90%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">' +
        (isProcessing ? 'Đang xử lý...' : _escapeHtmlAttr(label)) +
        '</span>' +
        '<span style="font-size:9px;color:#64748b;">Sẽ được chuyển đổi khi gửi</span>' +
        '</div>';
    } else {
      mediaHtml = '<img src="' + img + '" class="image-preview rounded-lg object-cover" onerror="_imgBrokenFallback(this)">';
    }

    return '<div class="relative">' +
      mediaHtml +
      '<button onclick="removeImage(\'' + type + '\', ' + idx + ')" class="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center">' +
        '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
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
