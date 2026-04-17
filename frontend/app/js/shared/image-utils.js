// ====================================================================
// js/shared/image-utils.js — image file reading and preview rendering
// ====================================================================
'use strict';

// ── Compress a File/Blob to a smaller JPEG data URL ─────────────────────
// Returns a Promise<string> (data:image/jpeg;base64,...).
// Default: max 1600px on longest side, JPEG quality 0.82 (~200-400KB per image).
// This prevents 5-15MB raw camera photos from bloating the upload payload.
function _compressImageFile(file, maxDim, quality) {
  maxDim  = maxDim  || 1600;
  quality = quality || 0.82;
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function () { reject(new Error('FileReader error')); };
    reader.onload = function (evt) {
      var img = new Image();
      img.onerror = function () { reject(new Error('Image decode error')); };
      img.onload = function () {
        try {
          var w = img.naturalWidth  || img.width;
          var h = img.naturalHeight || img.height;
          // Downscale if either dimension exceeds maxDim
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
          var dataUrl = canvas.toDataURL('image/jpeg', quality);
          resolve(dataUrl);
        } catch (e) {
          reject(e);
        }
      };
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// Compress an array of File objects → array of base64 data URLs (JPEG).
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
  files.forEach(file => {
    const blobUrl = URL.createObjectURL(file);
    statusImages.push(blobUrl);
    _statusImageFiles.push(file);
    renderImagePreviews('statusImagesPreview', statusImages, 'status');
  });
  input.value = '';
}

function handleWarrantyImages(input) {
  const files = Array.from(input.files);
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      warrantyImages.push(e.target.result);
      renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');
    };
    reader.readAsDataURL(file);
  });
  input.value = '';
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
    warrantyImages.splice(idx, 1);
    renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');
  }
}
