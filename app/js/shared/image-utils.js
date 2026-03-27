// ====================================================================
// js/shared/image-utils.js — image file reading and preview rendering
// ====================================================================
'use strict';

function handleOldContentImages(input) {
  const files = Array.from(input.files);
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      oldContentImages.push(e.target.result);
      renderImagePreviews('oldContentPreview', oldContentImages, 'oldContent');
    };
    reader.readAsDataURL(file);
  });
  input.value = '';
}

function handleStatusImages(input) {
  const files = Array.from(input.files);
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      statusImages.push(e.target.result);
      renderImagePreviews('statusImagesPreview', statusImages, 'status');
    };
    reader.readAsDataURL(file);
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
    oldContentImages.splice(idx, 1);
    renderImagePreviews('oldContentPreview', oldContentImages, 'oldContent');
  } else if (type === 'status') {
    statusImages.splice(idx, 1);
    renderImagePreviews('statusImagesPreview', statusImages, 'status');
  } else if (type === 'warranty') {
    warrantyImages.splice(idx, 1);
    renderImagePreviews('warrantyImagesPreview', warrantyImages, 'warranty');
  }
}
