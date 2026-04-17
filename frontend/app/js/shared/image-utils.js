// ====================================================================
// js/shared/image-utils.js — image file reading and preview rendering
// ====================================================================
'use strict';

// ── Compress a File/Blob to a smaller data URL (WebP preferred, JPEG fallback) ──
// Default: max 1600px on longest side, quality 0.82 (~100-300KB per image).
// WebP is 30-50% smaller than JPEG at similar quality.
function _compressImageFile(file, maxDim, quality) {
  maxDim  = maxDim  || 1600;
  quality = quality || 0.82;
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file);
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
        // Prefer WebP if browser supports it
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

// handleOldContentImages is intentionally a no-op — old_content_images DB column
// was dropped. Images no longer collected for old-content field.
// The toggle shows/hides the oldContentSection textarea only.
function handleOldContentImages(input) {
  if (input) input.value = '';
}

function handleStatusImages(input) {
  const files = Array.from(input.files);
  input.value = '';
  files.forEach(file => {
    // Show instant preview from blob URL while compressing in background
    const blobUrl = URL.createObjectURL(file);
    const idx = statusImages.length;
    statusImages.push(blobUrl);
    _statusImageFiles.push(file);
    renderImagePreviews('statusImagesPreview', statusImages, 'status');
    // Compress in background — replace blob preview with compressed data URL
    _compressImageFile(file, 1600, 0.82).then(function (dataUrl) {
      URL.revokeObjectURL(blobUrl);
      statusImages[idx] = dataUrl;
      // Replace File with a pre-compressed sentinel so submit doesn't re-compress
      _statusImageFiles[idx] = dataUrl;
      renderImagePreviews('statusImagesPreview', statusImages, 'status');
    }).catch(function () { /* keep blob URL as fallback */ });
  });
}

function handleWarrantyImages(input) {
  const files = Array.from(input.files);
  input.value = '';
  files.forEach(file => {
    // Show instant preview from blob URL while compressing in background
    const blobUrl = URL.createObjectURL(file);
    const idx = warrantyImages.length;
    warrantyImages.push(blobUrl);
    renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');
    // Compress in background
    _compressImageFile(file, 1600, 0.82).then(function (dataUrl) {
      URL.revokeObjectURL(blobUrl);
      warrantyImages[idx] = dataUrl;
      renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');
    }).catch(function () {
      // Fallback: read raw if compression fails
      const reader = new FileReader();
      reader.onload = function (e) { warrantyImages[idx] = e.target.result; };
      reader.readAsDataURL(file);
    });
  });
}

function renderImagePreviews(containerId, images, type) {
  const container = document.getElementById(containerId);
  container.innerHTML = images.map((img, idx) => `
    <div class="relative">
      <img src="${img}" class="image-preview rounded-lg object-cover">
      <button onclick="removeImage('${type}', ${idx})" class="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
  `).join('');
}

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
