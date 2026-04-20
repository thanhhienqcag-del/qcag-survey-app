// ====================================================================
// js/flows/warranty-flow.js — warranty form validation, submit and reset
// ====================================================================
'use strict';

function validateWarrantyTab1() {
  const code = document.getElementById('wOutletCode').value.trim();
  const name = document.getElementById('wOutletName').value.trim();
  const address = document.getElementById('wAddress').value.trim();
  const phone = document.getElementById('wPhone').value.trim();
  if (!code || !name || !address || !phone) {
    showToast('Vui lòng điền đầy đủ thông tin');
    return;
  }
  try {
    if (code !== 'New Outlet' && !/^\d{8}$/.test(code)) { showToast('Mã outlet phải là 8 chữ số'); return; }
  } catch (e) {}
  switchWarrantyTab(2);
}

async function submitWarrantyRequest() {
  const content = document.getElementById('warrantyContent').value.trim();

  if (!content) { showToast('Vui lòng nhập nội dung yêu cầu'); return; }
  if (warrantyImages.length === 0) { showToast('Vui lòng upload ảnh hiện trạng'); return; }
  if (allRequests.length >= 999) { showToast('Đã đạt giới hạn 999 yêu cầu'); return; }

  const btn = document.getElementById('submitWarrantyBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="inline-block animate-spin mr-2">⏳</span> Đang xử lý...';
  showLoadingOverlay('Đang gửi yêu cầu bảo hành...', 'Đang tải hình ảnh lên, vui lòng chờ trong giây lát');

  const request = {
    type: 'warranty',
    outletCode: document.getElementById('wOutletCode').value.trim(),
    outletName: document.getElementById('wOutletName').value.trim(),
    address: document.getElementById('wAddress').value.trim(),
    phone: document.getElementById('wPhone').value.trim(),
    items: '[]',
    content: content,
    oldContent: false,
    oldContentImages: '[]',
    statusImages: JSON.stringify(warrantyImages),
    requester: JSON.stringify(currentSession || {}),
    designImages: '[]',
    acceptanceImages: '[]',
    createdAt: new Date().toISOString(),
    status: 'pending'
  };

  // Pre-generate __backendId so GCS folder paths can be built before dataSdk.create()
  const __preBackendId = 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  request.__backendId = __preBackendId;

  // Upload warranty images to GCS (hien-trang folder)
  if (window.dataSdk && window.dataSdk.uploadImage) {
    try {
      const urls = [];
      for (let i = 0; i < warrantyImages.length; i++) {
        const src = warrantyImages[i];
        if (typeof src === 'string' && src.startsWith('data:')) {
          const url = await window.dataSdk.uploadImage(src, null, __preBackendId, 'hien-trang');
          urls.push(url || src);
        } else {
          urls.push(src);
        }
      }
      request.statusImages = JSON.stringify(urls);
    } catch (uploadErr) {
      console.warn('[warranty-flow] pre-upload failed, keeping base64:', uploadErr);
    }
  }

  if (window.dataSdk) {
    const result = await window.dataSdk.create(request);
    if (result.isOk) {
      try { blurActiveInput(); } catch (e) {}
      hideLoadingOverlay();
      document.getElementById('confirmModal').classList.remove('hidden');
    } else {
      hideLoadingOverlay();
      showToast('Lỗi tạo yêu cầu');
    }
  } else {
    request.__backendId = generateBackendId();
    allRequests.push(request);
    saveAllRequestsToStorage();
    updateRequestCount();
    try { blurActiveInput(); } catch (e) {}
    hideLoadingOverlay();
    document.getElementById('confirmModal').classList.remove('hidden');
  }

  btn.disabled = false;
  btn.textContent = 'Xác nhận yêu cầu';
}

function resetWarrantyForm() {
  document.getElementById('wOutletCode').value = '';
  document.getElementById('wOutletName').value = '';
  document.getElementById('wAddress').value = '';
  document.getElementById('wPhone').value = '';
  document.getElementById('warrantyContent').value = '';
  warrantyImages = [];
  document.getElementById('warrantyImagesPreview').innerHTML = '';
  switchWarrantyTab(1);
}
