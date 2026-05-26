// ====================================================================
// js/flows/detail-flow.js — request detail view, comments, design viewer,
//                           zoom overlay, upload handlers
// ====================================================================
'use strict';

// Ownership guard: only allow viewing requests that belong to currentSession.
function isRequestOwnedByCurrentSession(request) {
  try {
    if (!request) return false;
    const reqOwner = JSON.parse(request.requester || '{}');
    if (!currentSession || !currentSession.saleCode) return false;
    return (reqOwner.saleCode && reqOwner.saleCode === currentSession.saleCode);
  } catch (e) { return false; }
}

// ── Pending comment images (Sale Heineken) ────────────────────────────
let _detailCommentPendingImages = [];

function _renderDetailCommentPreview() {
  const previewEl = document.getElementById('detailCommentImgPreview');
  if (!previewEl) return;
  if (_detailCommentPendingImages.length === 0) {
    previewEl.innerHTML = '';
    previewEl.classList.add('hidden');
    setTimeout(updateEditFabPosition, 30);
    return;
  }
  previewEl.classList.remove('hidden');
  previewEl.innerHTML = _detailCommentPendingImages.map((src, i) =>
    `<div style="position:relative;display:inline-block;margin:2px">`+
    `<img src="${src}" style="width:52px;height:52px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb">`+
    `<button type="button" onclick="_removeDetailCommentImage(${i})" style="position:absolute;top:-4px;right:-4px;width:16px;height:16px;background:#ef4444;color:#fff;border-radius:50%;border:none;font-size:10px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>`+
    `</div>`
  ).join('');
  setTimeout(updateEditFabPosition, 30);
}

function _removeDetailCommentImage(index) {
  _detailCommentPendingImages.splice(index, 1);
  _renderDetailCommentPreview();
}

async function handleDetailCommentImagePick(input) {
  if (!input || !input.files) return;
  const files = Array.from(input.files);
  input.value = '';
  for (const file of files) {
    // Compress immediately on pick (WebP preferred)
    try {
      const dataUrl = await _compressImageFile(file, 1600, 0.82);
      _detailCommentPendingImages.push(dataUrl);
    } catch (_) {
      // Fallback to raw base64
      const dataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.readAsDataURL(file);
      });
      _detailCommentPendingImages.push(dataUrl);
    }
  }
  _renderDetailCommentPreview();
}

// ── Design modal comments ─────────────────────────────────────────────

async function addDesignComment(backendId) {
  const textarea = document.getElementById('designCommentInput');
  if (!textarea) return;
  const text = textarea.value.trim();
  const imgs = _detailCommentPendingImages.slice();
  if (!text && imgs.length === 0) { showToast('Vui lòng nhập nội dung bình luận'); return; }

  if (imgs.length > 0) showLoadingOverlay('Đang gửi bình luận...', 'Đang tải hình ảnh lên');

  const reqIdx = allRequests.findIndex(r => r.__backendId === backendId);
  if (reqIdx === -1) { showToast('Không tìm thấy yêu cầu'); return; }

  // Clear input immediately
  textarea.value = '';
  _detailCommentPendingImages = [];
  _renderDetailCommentPreview();

  const request = allRequests[reqIdx];
  let comments = [];
  try { comments = JSON.parse(request.comments || '[]'); } catch (e) { comments = []; }

  const authorRole = (currentSession && currentSession.role) || 'unknown';
  const authorName = (currentSession && (currentSession.saleName || currentSession.phone)) || 'Người dùng';

  // Upload images if any
  let uploadedImgs = [];
  if (imgs.length > 0 && window.dataSdk && window.dataSdk.uploadImage && backendId) {
    for (const imgData of imgs) {
      try {
        const url = await window.dataSdk.uploadImage(imgData, null, backendId, 'comments');
        uploadedImgs.push(url || imgData);
      } catch (e) { uploadedImgs.push(imgData); }
    }
  } else {
    uploadedImgs = imgs;
  }

  const comment = { authorRole, authorName, text, images: uploadedImgs, createdAt: new Date().toISOString() };
  comments.push(comment);

  // NOTE: Generic comments do NOT auto-clear design images.
  // Only the dedicated "Yêu cầu chỉnh sửa" flow (submitEditRequest) clears MQ images.
  // CRITICAL: Build SLIM PATCH — do NOT spread the full request object.
  // request.statusImages may hold the list-endpoint placeholder '["..."]'
  // which would overwrite real GCS URLs in the database if sent as-is.
  const commentsJson = JSON.stringify(comments);
  const patchPayload = {
    __backendId: request.__backendId,
    comments: commentsJson,
    updatedAt: new Date().toISOString()
  };

  if (window.dataSdk) {
    const result = await window.dataSdk.update(patchPayload);
    if (result.isOk) {
      hideLoadingOverlay();
      showToast('Đã gửi bình luận');
      const idx = allRequests.findIndex(r => r.__backendId === backendId);
      if (idx !== -1) { Object.assign(allRequests[idx], { comments: commentsJson, updatedAt: patchPayload.updatedAt }); }
      // Push notification for comment
      try {
        const outletLabel = request.outletName || request.outletCode || 'Outlet';
        if (String(authorRole).toLowerCase() === 'heineken') {
          sendPushNotification({ title: 'Bình luận mới', body: authorName + ' đã gửi 1 tin nhắn mới trong bình luận ' + outletLabel, role: 'qcag', data: { backendId: backendId } });
        } else {
          const reqObj = (() => { try { return JSON.parse(request.requester || '{}'); } catch (_) { return {}; } })();
          sendPushNotification({ title: 'Bình luận mới', body: authorName + ' đã gửi 1 tin nhắn mới trong bình luận ' + outletLabel, phone: reqObj.phone, saleCode: reqObj.saleCode, data: { backendId: backendId } });
        }
      } catch (e) { /* non-fatal */ }
      showRequestDetail(backendId);
      viewDesign(backendId);
    } else {
      hideLoadingOverlay();
      showToast('Lỗi gửi bình luận');
    }
  } else {
    Object.assign(allRequests[reqIdx], { comments: commentsJson, updatedAt: patchPayload.updatedAt });
    saveAllRequestsToStorage();
    hideLoadingOverlay();
    showToast('Đã gửi bình luận (lưu local)');
    viewDesign(backendId);
  }
}

// ── Detail panel comments ─────────────────────────────────────────────

async function addDetailComment(backendId) {
  const textarea = document.getElementById('detailCommentInput');
  if (!textarea) return;
  const text = textarea.value.trim();
  const imgs = _detailCommentPendingImages.slice();
  if (!text && imgs.length === 0) { showToast('Vui lòng nhập nội dung bình luận'); return; }

  if (imgs.length > 0) showLoadingOverlay('Đang gửi bình luận...', 'Đang tải hình ảnh lên');

  const reqIdx = allRequests.findIndex(r => r.__backendId === backendId);
  if (reqIdx === -1) { showToast('Không tìm thấy yêu cầu'); return; }

  // Clear inputs immediately
  textarea.value = '';
  _detailCommentPendingImages = [];
  _renderDetailCommentPreview();

  const request = allRequests[reqIdx];
  let comments = [];
  try { comments = JSON.parse(request.comments || '[]'); } catch (e) { comments = []; }

  const authorRole = (currentSession && currentSession.role) || 'unknown';
  const authorName = (currentSession && (currentSession.saleName || currentSession.phone)) || 'Người dùng';

  // Upload images if any
  let uploadedImgs = [];
  if (imgs.length > 0 && window.dataSdk && window.dataSdk.uploadImage && backendId) {
    for (const imgData of imgs) {
      try {
        const url = await window.dataSdk.uploadImage(imgData, null, backendId, 'comments');
        uploadedImgs.push(url || imgData);
      } catch (e) { uploadedImgs.push(imgData); }
    }
  } else {
    uploadedImgs = imgs;
  }

  const comment = { authorRole, authorName, text, images: uploadedImgs, createdAt: new Date().toISOString() };
  comments.push(comment);

  // NOTE: Generic comments do NOT auto-clear design images.
  // Only the dedicated "Yêu cầu chỉnh sửa" flow (submitEditRequest) clears MQ images.
  // CRITICAL: Build SLIM PATCH — do NOT spread the full request object.
  // request.statusImages may hold the list-endpoint placeholder '["..."]'
  // which would overwrite real GCS URLs in the database if sent as-is.
  const commentsJson = JSON.stringify(comments);
  const patchPayload = {
    __backendId: request.__backendId,
    comments: commentsJson,
    updatedAt: new Date().toISOString()
  };

  if (window.dataSdk) {
    const result = await window.dataSdk.update(patchPayload);
    if (result.isOk) {
      hideLoadingOverlay();
      showToast('Đã gửi bình luận');
      const idx = allRequests.findIndex(r => r.__backendId === backendId);
      if (idx !== -1) { Object.assign(allRequests[idx], { comments: commentsJson, updatedAt: patchPayload.updatedAt }); }
      // Push notification for comment
      try {
        const outletLabel = request.outletName || request.outletCode || 'Outlet';
        if (String(authorRole).toLowerCase() === 'heineken') {
          sendPushNotification({ title: 'Bình luận mới', body: authorName + ' đã gửi 1 tin nhắn mới trong bình luận ' + outletLabel, role: 'qcag', data: { backendId: backendId } });
        } else {
          const reqObj = (() => { try { return JSON.parse(request.requester || '{}'); } catch (_) { return {}; } })();
          sendPushNotification({ title: 'Bình luận mới', body: authorName + ' đã gửi 1 tin nhắn mới trong bình luận ' + outletLabel, phone: reqObj.phone, saleCode: reqObj.saleCode, data: { backendId: backendId } });
        }
      } catch (e) { /* non-fatal */ }
      showRequestDetail(backendId);
    } else {
      hideLoadingOverlay();
      showToast('Lỗi gửi bình luận');
    }
  } else {
    Object.assign(allRequests[reqIdx], { comments: commentsJson, updatedAt: patchPayload.updatedAt });
    saveAllRequestsToStorage();
    hideLoadingOverlay();
    showToast('Đã gửi bình luận (lưu local)');
    showRequestDetail(backendId);
  }
}

// ── Heineken MQ quick-jump hint ──────────────────────────────────────

let _mqHintScrollHandler = null;
let _mqHintEligible = false;

function hideMqJumpHint() {
  const btn = document.getElementById('mqJumpHintBtn');
  if (btn) btn.classList.add('hidden');
  try {
    const detailContent = document.getElementById('detailContent');
    if (detailContent && _mqHintScrollHandler) detailContent.removeEventListener('scroll', _mqHintScrollHandler);
  } catch (e) {}
  _mqHintScrollHandler = null;
}

function showMqJumpHintIfNeeded() {
  hideMqJumpHint();
  if (!_mqHintEligible) return;

  const detailScreen = document.getElementById('detailScreen');
  const detailContent = document.getElementById('detailContent');
  if (!detailScreen || !detailContent) return;

  let btn = document.getElementById('mqJumpHintBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'mqJumpHintBtn';
    btn.type = 'button';
    btn.className = 'mq-jump-hint';
    // Use a filled, bolder SVG arrow pointing down on the left and label on the right
    btn.innerHTML = '<svg class="mq-jump-hint-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M12 19a1 1 0 01-.707-.293l-6-6a1 1 0 011.414-1.414L11 15.586V4a1 1 0 112 0v11.586l4.293-4.293a1 1 0 011.414 1.414l-6 6A1 1 0 0112 19z"/></svg><span>Xem MQ</span>';
    btn.onclick = () => {
      const target = document.getElementById('mqSection');
      if (target) {
        const top = target.getBoundingClientRect().top - detailContent.getBoundingClientRect().top + detailContent.scrollTop - 12;
        detailContent.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
      hideMqJumpHint();
    };
    detailScreen.appendChild(btn);
  }

  btn.classList.remove('hidden');

  // If user starts scrolling manually, hide the hint immediately
  _mqHintScrollHandler = () => {
    if (detailContent.scrollTop > 0) hideMqJumpHint();
  };
  detailContent.addEventListener('scroll', _mqHintScrollHandler);
}

// ── Request detail view ────────────────────────────────────────────────

async function showRequestDetail(id) {
  const request = allRequests.find(r => r.__backendId === id);
  if (!request) return;
  // ownership enforcement: only the creator can view details
  if (!isRequestOwnedByCurrentSession(request)) {
    showToast('Không có quyền xem yêu cầu này');
    return;
  }

  // Fetch full record (including image columns excluded from list endpoint)
  let fullRequest = request;
  if (window.dataSdk && typeof window.dataSdk.getOne === 'function') {
    try {
      const r = await window.dataSdk.getOne(id);
      if (r && r.isOk && r.data) {
        // Merge full record so detail UI is not limited by compact list payload.
        fullRequest = Object.assign({}, request, r.data);
        // Update local store so subsequent renders are correct
        const idx = allRequests.findIndex(x => x.__backendId === id);
        if (idx !== -1) allRequests[idx] = fullRequest;
      }
    } catch (e) { /* use local data as fallback */ }
    // Strip list-endpoint placeholder values so broken "..." URLs are never rendered
    ['statusImages', 'designImages', 'acceptanceImages', 'oldContentImages'].forEach(k => {
      if (fullRequest[k] === '["..."]') fullRequest[k] = '[]';
    });
  }

  currentDetailRequest = fullRequest;
  const request2 = fullRequest; // alias so rest of function remains unchanged
  const content = document.getElementById('detailContent');
  const items = JSON.parse(request2.items || '[]');
  const statusImgs = JSON.parse(request2.statusImages || '[]');
  const designImgs = JSON.parse(request2.designImages || '[]');
  const acceptanceImgs = JSON.parse(request2.acceptanceImages || '[]');
  const oldContentImgs = JSON.parse(request2.oldContentImages || '[]');
  const date = new Date(request.createdAt);

  // Determine which requester info to show: use the stored request.requester only
  const parsedRequester = (() => { try { return JSON.parse(request.requester || 'null'); } catch (e) { return null; } })();
  const displayRequester = parsedRequester || null;
  const hasRequesterInfo = displayRequester && (displayRequester.saleName || displayRequester.saleCode || displayRequester.phone || displayRequester.role);
  const isMobile = (window.innerWidth || 0) < 768;
  let requesterHtml = '';
  if (hasRequesterInfo) {
    const role = displayRequester.role || 'unknown';
    const pos = displayRequester.isTBA ? 'TBA' : 'Sale';
    const ssLineDesktop = displayRequester.isTBA ? '' : `<div class="truncate"><span class="text-gray-500">SS/SE:</span> <span class="font-medium">${displayRequester.ssName || ''} (${displayRequester.ssCode || ''})</span></div>`;
    const ssLineMobile = displayRequester.isTBA ? '' : `<div class="col-span-2"><div class="text-gray-500">SS/SE</div><div class="font-medium whitespace-normal">${displayRequester.ssName || ''}${displayRequester.ssCode ? ` (${displayRequester.ssCode})` : ''}</div></div>`;
    if (isMobile) {
      // stacked layout for mobile: label on its own line, value below
      if (role === 'heineken') {
        requesterHtml = `
          <div class="bg-blue-50 rounded-xl p-4">
            <h3 class="font-medium mb-3 text-blue-900">Người yêu cầu</h3>
            <div class="grid grid-cols-2 gap-2 text-sm">
              <div>
                <div class="text-gray-500">Tên</div>
                <div class="font-medium truncate">${displayRequester.saleName || ''}</div>
              </div>
              <div>
                <div class="text-gray-500">Mã Sale</div>
                <div class="font-medium truncate">${displayRequester.saleCode || ''}</div>
              </div>
              <div>
                <div class="text-gray-500">SĐT</div>
                <div class="font-medium truncate">${displayRequester.phone || ''}</div>
              </div>
              <div>
                <div class="text-gray-500">Khu vực</div>
                <div class="font-medium truncate">${displayRequester.region || ''}</div>
              </div>
              <div class="col-span-2">
                <div class="text-gray-500">Chức vụ</div>
                <div class="font-medium">${pos}</div>
              </div>
              ${ssLineMobile}
            </div>
          </div>`;
      } else if (role === 'qcag') {
        requesterHtml = `
          <div class="bg-blue-50 rounded-xl p-4">
            <h3 class="font-medium mb-3 text-blue-900">Người yêu cầu</h3>
            <div class="grid grid-cols-2 gap-2 text-sm">
              <div>
                <div class="text-gray-500">Vai trò</div>
                <div class="font-medium">QCAG</div>
              </div>
              <div>
                <div class="text-gray-500">SĐT</div>
                <div class="font-medium truncate">${displayRequester.phone || ''}</div>
              </div>
            </div>
          </div>`;
      } else {
        requesterHtml = `
          <div class="bg-blue-50 rounded-xl p-4">
            <h3 class="font-medium mb-3 text-blue-900">Người yêu cầu</h3>
            <div class="grid grid-cols-2 gap-2 text-sm">
              <div>
                <div class="text-gray-500">Tên/Phone</div>
                <div class="font-medium truncate">${displayRequester.saleName || displayRequester.phone || ''}</div>
              </div>
              <div>
                <div class="text-gray-500">Mã</div>
                <div class="font-medium">${displayRequester.saleCode || ''}</div>
              </div>
            </div>
          </div>`;
      }
    } else {
      // desktop: two-column grid
      if (role === 'heineken') {
        requesterHtml = `
          <div class="bg-blue-50 rounded-xl p-4">
            <h3 class="font-medium mb-3 text-blue-900">Người yêu cầu</h3>
            <div class="grid grid-cols-2 gap-2 text-sm">
              <div class="truncate"><span class="text-gray-500">Tên:</span> <span class="font-medium">${displayRequester.saleName || ''}</span></div>
              <div class="truncate"><span class="text-gray-500">Mã Sale:</span> <span class="font-medium">${displayRequester.saleCode || ''}</span></div>
              <div class="truncate"><span class="text-gray-500">SĐT:</span> <span class="font-medium">${displayRequester.phone || ''}</span></div>
              <div class="truncate"><span class="text-gray-500">Khu vực:</span> <span class="font-medium">${displayRequester.region || ''}</span></div>
              <div class="truncate"><span class="text-gray-500">Chức vụ:</span> <span class="font-medium">${pos}</span></div>
              ${ssLineDesktop}
            </div>
          </div>`;
      } else if (role === 'qcag') {
        requesterHtml = `
          <div class="bg-blue-50 rounded-xl p-4">
            <h3 class="font-medium mb-3 text-blue-900">Người yêu cầu</h3>
            <div class="text-sm"><span class="text-gray-500">QCAG</span> — <span class="font-medium">${displayRequester.phone || ''}</span></div>
          </div>`;
      } else {
        requesterHtml = `
          <div class="bg-blue-50 rounded-xl p-4">
            <h3 class="font-medium mb-3 text-blue-900">Người yêu cầu</h3>
            <div class="grid grid-cols-2 gap-2 text-sm">
              <div class="truncate"><span class="text-gray-500">Tên/Phone:</span> <span class="font-medium">${displayRequester.saleName || displayRequester.phone || ''}</span></div>
              <div class="truncate"><span class="text-gray-500">Mã:</span> <span class="font-medium">${displayRequester.saleCode || ''}</span></div>
            </div>
          </div>`;
      }
    }
  }
  else {
    // Show placeholder when creator info is missing instead of hiding the whole block
    requesterHtml = `
      <div class="bg-blue-50 rounded-xl p-4">
        <h3 class="font-medium mb-3 text-blue-900">Người yêu cầu</h3>
        <div class="text-sm text-gray-600">Không xác định</div>
      </div>`;
  }

  let comments = [];
  try { comments = JSON.parse(request.comments || '[]'); } catch (e) { comments = []; }
  const mobileTabsHtml = isMobile ? `
    <div id="mobileTabsBar" class="mobile-tabs-sticky">
      <button id="mobileTabDetailBtn" class="mobile-tab-btn active" onclick="switchDetailMobileTab('detail')">Chi Tiết</button>
      <button id="mobileTabCommentBtn" class="mobile-tab-btn" onclick="switchDetailMobileTab('comment')">Bình Luận<span id="mobileCommentBadge" class="mobile-tab-badge">${comments.length}</span></button>
    </div>
  ` : '';

  let html = `
    <div class="detail-two-col">
      <div class="detail-main">
        <div class="space-y-4">
          ${requesterHtml}
          <div class="bg-gray-50 rounded-xl p-4">
            <h3 class="font-medium mb-3">Thông tin Outlet</h3>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div class="truncate"><span class="text-gray-500">Mã Outlet:</span> <span class="font-medium">${request.outletCode}</span></div>
              <div class="truncate"><span class="text-gray-500">Tên:</span> <span class="font-medium">${request.outletName}</span></div>
              <div class="col-span-2 truncate"><span class="text-gray-500">Địa chỉ:</span> <span class="font-medium">${request.address}</span></div>
              <div class="truncate"><span class="text-gray-500">SĐT:</span> <span class="font-medium">${request.phone}</span></div>
              <div class="truncate"><span class="text-gray-500">Vị trí:</span> <span class="font-medium">${request.outletLat && request.outletLng ? `<button onclick="openSavedLocation(${request.outletLat},${request.outletLng})" class="px-3 py-1 bg-gray-100 rounded-lg text-sm text-gray-800 hover:bg-gray-200">Xem vị trí</button>` : '<span class="text-gray-400">Chưa có</span>'}</span></div>
              <div class="truncate"><span class="text-gray-500">Ngày tạo:</span> <span class="font-medium">${date.toLocaleDateString('vi-VN')}</span></div>
            </div>
          </div>
  `;

  if (request.type === 'new' && items.length > 0) {
    html += `
      <div class="bg-gray-50 rounded-xl p-4">
        <h3 class="font-medium mb-3">Hạng mục yêu cầu <span class="text-gray-500 text-sm">(${items.length})</span></h3>
        <div class="w-full">
    `;

    if (isMobile) {
      html += `<div class="space-y-3"> ${items.map((item, idx) => {
        const requestText = item.type === 'Hạng mục khác' ? (item.otherContent || '') : (item.note || '');
        return `
        <div class="bg-white rounded-xl p-3 border border-gray-100">
          <div class="flex items-start justify-between">
            <div class="flex-1">
              <div class="flex items-center justify-between">
                <div class="text-sm font-medium">${idx + 1}. ${item.type}</div>
                <div class="text-xs text-gray-500">${item.poles ? (item.poles + ' trụ') : '0 trụ'}</div>
              </div>
              <div class="mt-2 text-sm text-gray-600 grid grid-cols-2 gap-2">
                <div><span class="text-gray-500 text-xs">Brand</span><div class="font-medium">${item.type !== 'Hạng mục khác' ? (item.brand || '-') : '-'}</div></div>
                <div><span class="text-gray-500 text-xs">Hình thức</span><div class="font-medium">${item.type !== 'Hạng mục khác' ? (item.action || '-') : '-'}</div></div>
                <div><span class="text-gray-500 text-xs">Kích thước</span><div class="font-medium">${item.type !== 'Hạng mục khác' ? (item.survey ? `<span class="qcag-survey-badge">Khảo sát</span>` : (item.useOldSize ? 'KT cũ' : `${item.width}m x ${item.height}m`)) : '-'}</div></div>
                <div><span class="text-gray-500 text-xs">Yêu cầu</span><div class="text-sm text-gray-600">${requestText ? escapeHtml(requestText) : '-'}</div></div>
              </div>
            </div>
          </div>
        </div>
      `}).join('')} </div>`;
    } else {
      html += `
        <div class="grid grid-cols-7 gap-4 text-xs text-gray-500 mb-2">
          <div class="font-medium">Số hàng mục</div>
          <div class="font-medium">Hạng mục</div>
          <div class="font-medium">Brand</div>
          <div class="font-medium">Hình thức</div>
          <div class="font-medium">Số trụ</div>
          <div class="font-medium">Kích thước</div>
          <div class="font-medium">Yêu cầu</div>
        </div>
        <div class="space-y-2">
          ${items.map((item, idx) => `
            <div>
                <div class="grid grid-cols-7 gap-4 text-sm items-center border-b border-gray-100 py-2">
                <div class="font-medium">${idx + 1}</div>
                <div class="text-gray-500">${item.type}</div>
                <div class="text-gray-500">${item.type !== 'Hạng mục khác' ? (item.brand || '-') : '-'}</div>
                <div class="text-gray-500">${item.type !== 'Hạng mục khác' ? (item.action || '-') : '-'}</div>
                <div class="text-gray-500">${item.type !== 'Hạng mục khác' ? (item.poles || 0) + ' trụ' : '-'}</div>
                <div class="text-gray-500">${item.type !== 'Hạng mục khác' ? (item.survey ? `<span class="qcag-survey-badge">Khảo sát</span>` : (item.useOldSize ? 'KT cũ' : `${item.width}m x ${item.height}m`)) : '-'}</div>
                <div class="text-gray-500">${item.type === 'Hạng mục khác' ? escapeHtml(item.otherContent || '-') : (item.note ? escapeHtml(item.note) : '-')}</div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    html += `</div></div>`;

    html += `
      <div class="bg-gray-50 rounded-xl p-4">
        <h3 class="font-medium mb-3">Nội dung bảng hiệu</h3>
        ${request.oldContent ? `
          <p class="text-sm text-gray-500 mb-2">Sử dụng nội dung cũ</p>
          ${oldContentImgs.length > 0 ? `
            <div class="flex flex-wrap gap-2">
              ${oldContentImgs.map(img => `<img src="${img}" class="w-20 h-20 object-cover rounded-lg cursor-pointer" onclick="showImageFull(this.src, false)">`).join('')}
            </div>
          ` : ''}
        ` : `<p class="text-sm">${request.content}</p>`}
      </div>
    `;
  }

  if (request.type === 'warranty') {
    html += `
      <div class="bg-gray-50 rounded-xl p-4">
        <h3 class="font-medium mb-3">Nội dung yêu cầu bảo hành</h3>
        <p class="text-sm">${request.content}</p>
      </div>
    `;
  }

  html += `
    <div class="bg-gray-50 rounded-xl p-4">
      <h3 class="font-medium mb-3">Ảnh hiện trạng</h3>
      ${statusImgs.length > 0 ? `
        <div class="flex flex-wrap gap-2">
          ${statusImgs.map(img => `<img src="${img}" class="w-20 h-20 object-cover rounded-lg cursor-pointer" onclick="showImageFull(this.src, false)" onerror="_imgBrokenFallback(this)">`).join('')}
        </div>
      ` : '<p class="text-sm text-gray-500">Chưa có ảnh</p>'}
    </div>
  `;

  if (request.type === 'new') {
    const designPrimaryImg = (Array.isArray(designImgs) && designImgs.length > 0) ? designImgs[0] : '';
    const designSlotHtml = designPrimaryImg
      ? `<img src="${designPrimaryImg}" class="mq-preview-img cursor-pointer" onclick="viewDesign('${request.__backendId}')" alt="Mẫu thiết kế">`
      : '<div class="mq-preview-empty">Chưa có thiết kế</div>';
    html += `
      <div id="mqSection" class="bg-gray-50 rounded-xl p-4">
        <h3 class="font-medium mb-3">Thiết kế</h3>
        <div class="mq-preview-grid mb-3">
          <div class="mq-preview-cell">
            <div class="mq-preview-label">MQ</div>
            ${designSlotHtml}
          </div>
          <div class="mq-preview-cell">
            <div class="mq-preview-label">Báo giá</div>
            <div id="mqQuotePreviewSlot" class="mq-preview-empty">Đang tải báo giá...</div>
          </div>
        </div>
        ${ (currentSession && String(currentSession.role || '').toLowerCase() === 'heineken') ? '' :
          '<label class="w-full py-3 border-2 border-dashed border-gray-300 rounded-xl text-gray-500 font-medium flex items-center justify-center gap-2 cursor-pointer active:bg-gray-100">\n          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">\n            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>\n          </svg>\n          Upload thiết kế\n          <input type="file" accept="image/*" multiple class="hidden" onchange="uploadDesign(this)">\n        </label>' }
      </div>
    `;
  }

  if (request.type === 'warranty') {
    const _isHKRole = currentSession && String(currentSession.role || '').toLowerCase() === 'heineken';
    // Backward-compat: older records had acceptance images stored in designImages by desktop QCAG
    const displayAcceptanceImgs = acceptanceImgs.length > 0 ? acceptanceImgs : designImgs;
    html += `
      <div class="bg-gray-50 rounded-xl p-4">
        <h3 class="font-medium mb-3">Ảnh nghiệm thu</h3>
        ${displayAcceptanceImgs.length > 0 ? `
          <div class="flex flex-wrap gap-2 mb-3">
            ${displayAcceptanceImgs.map(img => `<img src="${img}" class="w-20 h-20 object-cover rounded-lg cursor-pointer" onclick="showImageFull(this.src, false)">`).join('')}
          </div>
        ` : '<p class="text-sm text-gray-500 mb-3">Chưa có ảnh nghiệm thu</p>'}
        ${_isHKRole ? '' : `<label class="w-full py-3 border-2 border-dashed border-gray-300 rounded-xl text-gray-500 font-medium flex items-center justify-center gap-2 cursor-pointer active:bg-gray-100">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
          </svg>
          Upload ảnh nghiệm thu
          <input type="file" accept="image/*" multiple class="hidden" onchange="uploadAcceptance(this)">
        </label>`}
      </div>
    `;
  }

  // Quotation bridge section (async-filled after render)
  html += `
    <div id="quoteBridgeSection" class="quote-bridge-section rounded-xl p-4">
      <div class="quote-bridge-head mb-3">
        <div class="quote-bridge-head-left">
          <svg class="w-4 h-4 quote-bridge-icon flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          <h3 class="font-medium quote-bridge-title">Báo giá QCAG</h3>
        </div>
        <div id="quoteBridgeHeadMeta" class="quote-bridge-head-meta"></div>
      </div>
      <div id="quoteBridgeContent" class="text-sm quote-bridge-content">Đang tải...</div>
    </div>
  `;

  html += '</div></div>'; // close .space-y-4 + .detail-main

  // Comments column — build chat-bubble HTML
  const _myRole = (currentSession && currentSession.role) || '';
  const _myName = (currentSession && (currentSession.saleName || currentSession.phone)) || '';
  const commentsListHtml = comments.length === 0
    ? '<div class="text-sm text-gray-400 px-1">Chưa có bình luận nào</div>'
    : comments.map(c => {
      const isEditRequest = (c.commentType === 'edit-request');
      const isSystem = (String(c.authorRole || '').toLowerCase() === 'system' || String(c.authorRole || '').toLowerCase() === 'hệ thống');
      const isMe = c.authorRole === _myRole && c.authorName === _myName;
      const sideClass = isMe ? 'comment-me' : 'comment-other';
      const authorStr = escapeHtml(c.authorName || c.authorRole || 'Người dùng');
      const roleStr = escapeHtml(c.authorRole || '');
      const timeStr = new Date(c.createdAt).toLocaleString('vi-VN');
      const rawText = (c.text || '').toString().trim();
      const textStr = escapeHtml(rawText);
      // mark very short messages so CSS can enforce a minimum bubble width/height
      const shortClass = rawText.length <= 6 ? ' short' : '';
      if (isSystem) {
        // render system messages centered and without the framed card
        return '<div class="comment-item comment-system">' +
          '<div class="comment-body system-body' + shortClass + '">' + textStr + '</div>' +
          '<div class="comment-time system-time">' + timeStr + '</div>' +
        '</div>';
      }
      if (isEditRequest) {
        const catsArr = (c.editCategories || []);
        // Strip redundant prefix from display text (tag badge already shows it)
        let displayText = rawText;
        if (displayText.startsWith('Yêu cầu chỉnh sửa: ')) {
          displayText = displayText.slice('Yêu cầu chỉnh sửa: '.length).trim();
        } else if (displayText === 'Yêu cầu chỉnh sửa') {
          displayText = '';
        }
        const displayTextStr = escapeHtml(displayText);
        const catsHtml = catsArr.length > 0
          ? '<div class="cer-cats-inline">' + catsArr.map(ct => escapeHtml(ct)).join(', ') + '</div>'
          : '';
        return '<div class="comment-item ' + sideClass + '">' +
          '<div class="comment-meta"><strong>' + authorStr + '</strong>' +
          '<span class="comment-role">' + roleStr + '</span></div>' +
          '<div class="comment-bubble' + shortClass + '">' +
            '<div class="cer-tag-inline">' +
              '<svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>' +
              '<span class="cer-tag-main">Yêu cầu chỉnh sửa</span>' +
            '</div>' +
            catsHtml +
            (displayTextStr ? '<div class="comment-body">' + displayTextStr + '</div>' : '') +
            '<div class="comment-time-inbubble">' + timeStr + '</div>' +
          '</div>' +
        '</div>';
      }
      return '<div class="comment-item ' + sideClass + '">' +
        // keep sender name on top (meta)
        '<div class="comment-meta"><strong>' + authorStr + '</strong>' +
        '<span class="comment-role">' + roleStr + '</span></div>' +
        // message bubble contains body + images + small time at bottom
        '<div class="comment-bubble' + shortClass + '">' +
          (rawText ? '<div class="comment-body">' + textStr + '</div>' : '') +
          (Array.isArray(c.images) && c.images.length > 0
            ? '<div class="comment-imgs">' + c.images.map(img => `<img src="${escapeHtml(img)}" class="comment-img-thumb" onclick="showImageFull(this.src,false)">`).join('') + '</div>'
            : '') +
          '<div class="comment-time-inbubble">' + timeStr + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

  html += `
    <div class="detail-comments-col">
      <div class="bg-white rounded-xl p-4 sticky top-4">
        <div class="flex items-center justify-between">
          <div class="font-medium">Bình luận</div>
          <div class="text-sm text-gray-500">${comments.length} bình luận</div>
        </div>
        <div id="detailCommentsList" class="mt-3 comment-list">
          ${commentsListHtml}
        </div>
        <div class="mt-3">
          <div class="detail-comment-input-box">
            <textarea id="detailCommentInput" rows="1" class="w-full px-3 py-2.5 text-sm resize-none" style="border:none;outline:none;background:transparent;" placeholder="Viết bình luận..." oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px';if(typeof updateEditFabPosition==='function')updateEditFabPosition();"></textarea>
            <div id="detailCommentImgPreview" class="hidden flex flex-wrap gap-1 px-2 pb-2"></div>
          </div>
          <div class="flex items-center justify-between mt-2">
            <label class="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 cursor-pointer hover:bg-gray-50">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
              Ảnh
              <input type="file" accept="image/*" multiple class="hidden" onchange="handleDetailCommentImagePick(this)">
            </label>
            <button onclick="addDetailComment('${request.__backendId}')" class="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm">Gửi</button>
          </div>
        </div>
      </div>
    </div>
  `;

  html += '</div>'; // close .detail-two-col

  content.innerHTML = html;
  showScreen('detailScreen');
  _mqHintEligible = !!(currentSession && String(currentSession.role || '').toLowerCase() === 'heineken' && request.type === 'new');
  // Show edit-request FAB only for 'new' type requests (not warranty)
  try {
    const fab = document.getElementById('editRequestFab');
    const detailContent = document.getElementById('detailContent');
    if (fab) {
      if (request2.type !== 'new') {
        fab.classList.add('hidden');
      } else {
        fab.classList.remove('hidden');
        if (detailContent && detailContent.classList.contains('chat-mode')) {
          fab.classList.remove('fab-right'); fab.classList.add('fab-left');
        } else {
          fab.classList.remove('fab-left'); fab.classList.add('fab-right');
        }
      }
    }
  } catch (e) {}

  // Insert mobile tab bar below the screen header
  if (isMobile) {
    const existing = document.getElementById('mobileTabsBar');
    if (existing) existing.remove();
    // Remember if we were on comment tab before re-render
    const detailContent = document.getElementById('detailContent');
    const wasInCommentMode = detailContent && detailContent.classList.contains('chat-mode');
    const detailScreen = document.getElementById('detailScreen');
    if (detailScreen) {
      const header = detailScreen.querySelector('div');
      if (header) {
        header.insertAdjacentHTML('afterend', mobileTabsHtml);
        switchDetailMobileTab(wasInCommentMode ? 'comment' : 'detail');
      }
    }
  }

  // Heineken only: show quick-jump hint on detail view
  const detailContentNow = document.getElementById('detailContent');
  if (detailContentNow && !detailContentNow.classList.contains('chat-mode')) {
    showMqJumpHintIfNeeded();
  } else {
    hideMqJumpHint();
  }

  // Load bridge / quotation status asynchronously (non-blocking)
  _loadBridgeStatus(request.__backendId).catch(function () {});
}

// ── Bridge / Quotation status loader ─────────────────────────────────

async function _loadBridgeStatus(backendId) {
  const section = document.getElementById('quoteBridgeSection');
  const contentEl = document.getElementById('quoteBridgeContent');
  const headMetaEl = document.getElementById('quoteBridgeHeadMeta');
  const quotePreviewSlot = document.getElementById('mqQuotePreviewSlot');
  if (!section || !contentEl || !backendId) return;

  // Always show the section
  section.classList.remove('hidden');

  const showFallback = (msg) => {
    if (headMetaEl) headMetaEl.innerHTML = '';
    contentEl.innerHTML = `
      <div class="quote-bridge-rows">
        <div class="quote-bridge-row">
          <span class="quote-bridge-label">Trạng thái</span>
          <span class="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full qb-status qb-status-pending">Chờ báo giá</span>
        </div>
      </div>
      <div class="text-xs text-gray-500 mt-2">${msg || 'Chưa có thông tin báo giá từ QCAG'}</div>
    `;
    if (quotePreviewSlot) quotePreviewSlot.textContent = 'Chưa có báo giá';
  };

  try {
    const normalizeBase = (u) => String(u || '').trim().replace(/\/+$/, '');
    const unique = (arr) => {
      const out = [];
      const seen = new Set();
      arr.forEach((x) => {
        if (x == null) return;
        const k = String(x);
        if (seen.has(k)) return;
        seen.add(k);
        out.push(k);
      });
      return out;
    };

    const baseCandidates = (() => {
      const c = [];
      try {
        if (window.__env) {
          if (window.__env.BACKEND_URL) c.push(normalizeBase(window.__env.BACKEND_URL));
          if (Array.isArray(window.__env.BACKEND_URL_CANDIDATES)) {
            window.__env.BACKEND_URL_CANDIDATES.forEach((u) => {
              const x = normalizeBase(u);
              if (x) c.push(x);
            });
          }
        }
      } catch (e) {}
      try {
        if (window.location && window.location.origin && !/^file:/i.test(window.location.origin)) {
          c.push(normalizeBase(window.location.origin));
        }
      } catch (e) {}
      c.push('');
      return unique(c);
    })();

    // Fast-path: if the current detail request already contains embedded bridge
    // data from the backend `GET /api/ks/requests/:id`, use it and avoid extra
    // network calls. This prevents extra egress and loading flicker on mobile.
    let bridgeData = null;
    let hasEndpointResponse = false;
    try {
      if (currentDetailRequest && currentDetailRequest.bridge) {
        bridgeData = currentDetailRequest.bridge;
      }
    } catch (e) { /* ignore */ }

    if (!bridgeData) {
      showFallback('QCAG chưa cập nhật báo giá cho yêu cầu này.');
      return;
    }

    const b = bridgeData;

    const isDeletedInApp1 = (
      String(b.quote_status || '').toLowerCase() === 'deleted' ||
      b.quote_deleted === true
    );
    const effectiveStatus = isDeletedInApp1 ? 'deleted' : String(b.quote_status || '').toLowerCase();
    let renderPreviewData = (!isDeletedInApp1 && b.quote_render_data && typeof b.quote_render_data === 'object')
      ? b.quote_render_data
      : null;
    const previewCandidateUrl = isDeletedInApp1
      ? ''
      : String(b.quote_image_url || b.quote_preview_url || '');

    // If App1 didn't provide a full render payload, synthesize a lightweight
    // renderPreviewData from available bridge fields so App2 can render a
    // consistent preview without extra network calls.
    if (!renderPreviewData && previewCandidateUrl) {
      renderPreviewData = {
        quoteCode: b.quote_code || '',
        outletCode: b.outlet_code || '',
        outletName: b.outlet_name || '',
        area: b.region || b.area || '',
        address: b.address || '',
        outletPhone: b.outlet_phone || '',
        saleCode: b.sale_code || '',
        saleName: b.sale_name || '',
        salePhone: b.sale_phone || '',
        ssName: b.ss_name || '',
        saleType: b.sale_type || 'Sale (SR)',
        spoName: b.spo_name || '',
        totalAmount: b.quote_total != null ? b.quote_total : (b.quote_total_amount || 0),
        items: Array.isArray(b.items) ? b.items : [],
        primaryImage: { data: previewCandidateUrl, name: 'Preview' },
        createdAt: b.quote_confirmed_at || b.created_at || null,
        updatedAt: b.updated_at || null,
      };
    }

    const hasRenderPreview = !!(renderPreviewData && (
      String(renderPreviewData.quoteCode || '').trim() ||
      (Array.isArray(renderPreviewData.items) && renderPreviewData.items.length > 0) ||
      (renderPreviewData.primaryImage && String(renderPreviewData.primaryImage.data || '').trim())
    ));
    if (hasRenderPreview) {
      window.__ksQuoteRenderPreviewCache = window.__ksQuoteRenderPreviewCache || {};
      window.__ksQuoteRenderPreviewCache[String(backendId)] = renderPreviewData;
    }

    // Status badge
    const statusMap = {
      'pending':     { label: 'Chờ báo giá', cls: 'qb-status qb-status-pending' },
      'in_progress': { label: 'Đang báo giá', cls: 'qb-status qb-status-in-progress' },
      'quoted':      { label: 'Đã báo giá', cls: 'qb-status qb-status-quoted' },
      'confirmed':   { label: 'Đã xác nhận', cls: 'qb-status qb-status-confirmed' },
      'deleted':     { label: 'Báo giá đã xóa', cls: 'qb-status qb-status-default' },
    };
    const st = statusMap[effectiveStatus] || { label: effectiveStatus || '—', cls: 'qb-status qb-status-default' };
    const statusBadge = `<span class="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full ${st.cls}">${st.label}</span>`;

    // Format VND
    const fmtVnd = (n) => {
      const num = parseFloat(n);
      if (!n || isNaN(num)) return '—';
      return num.toLocaleString('vi-VN') + ' đ';
    };

    // Format date
    const fmtDate = (d) => {
      if (!d) return '—';
      try { return new Date(d).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
      catch (e) { return d; }
    };

    const viewBtn = ((!isDeletedInApp1 && previewCandidateUrl)
      ? `<button type="button" onclick="openQuotePreviewFromSlot(decodeURIComponent('${encodeURIComponent(previewCandidateUrl)}'))"
           class="quote-bridge-view-btn inline-flex items-center gap-1 px-3 py-1.5 mt-3 text-xs font-semibold rounded-lg transition-colors shadow-sm">
           <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
           Xem báo giá
         </button>`
      : ((!isDeletedInApp1 && hasRenderPreview)
      ? `<button type="button" onclick="openQuotePreviewImageFromBridgeCache(decodeURIComponent('${encodeURIComponent(String(backendId))}'))"
           class="quote-bridge-view-btn inline-flex items-center gap-1 px-3 py-1.5 mt-3 text-xs font-semibold rounded-lg transition-colors shadow-sm">
           <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
           Xem báo giá
         </button>`
      : ''));

    if (headMetaEl) {
      headMetaEl.innerHTML = b.quote_code
        ? `<span class="quote-bridge-head-label">Mã BG:</span> <span class="quote-bridge-head-value">${b.quote_code}</span>`
        : '';
    }

    if (quotePreviewSlot) {
      if (isDeletedInApp1) {
        quotePreviewSlot.textContent = 'Báo giá đã xóa';
      } else if (previewCandidateUrl) {
        const rawPreviewUrl = previewCandidateUrl;
        const safeSrc = rawPreviewUrl.replace(/"/g, '&quot;');
        const encodedPreviewUrl = encodeURIComponent(rawPreviewUrl);
        quotePreviewSlot.innerHTML = `<img src="${safeSrc}" class="mq-preview-img cursor-pointer" alt="Preview báo giá" onclick="openQuotePreviewFromSlot(decodeURIComponent('${encodedPreviewUrl}'))" onerror="this.onerror=null;this.parentElement.textContent='Chưa có báo giá';">`;
      } else if (hasRenderPreview) {
        const thumbHtml = ksBuildQuotePreviewHtml(renderPreviewData);
        quotePreviewSlot.innerHTML = `
          <div class="mq-preview-render-thumb" onclick="openQuotePreviewImageFromBridgeCache(decodeURIComponent('${encodeURIComponent(String(backendId))}'))">
            <div class="mq-preview-render-canvas">${thumbHtml}</div>
            <div class="mq-preview-render-overlay">Xem preview báo giá</div>
          </div>
        `;
      } else {
        quotePreviewSlot.textContent = 'Chưa có báo giá';
      }
    }

    contentEl.innerHTML = `
      <div class="quote-bridge-rows">
        <div class="quote-bridge-row"><span class="quote-bridge-label">Trạng thái</span>${statusBadge}</div>
        ${b.quote_total ? `<div class="quote-bridge-row"><span class="quote-bridge-label">Tổng tiền</span><span class="font-medium quote-bridge-value">${fmtVnd(b.quote_total)}</span></div>` : ''}
        ${b.quoted_by ? `<div class="quote-bridge-row"><span class="quote-bridge-label">Người BG</span><span class="font-medium quote-bridge-value">${b.quoted_by}</span></div>` : ''}
        ${b.quote_confirmed_at ? `<div class="quote-bridge-row"><span class="quote-bridge-label">Ngày xác nhận</span><span class="font-medium quote-bridge-value">${fmtDate(b.quote_confirmed_at)}</span></div>` : ''}
        ${b.tk_code ? `<div class="quote-bridge-row"><span class="quote-bridge-label">Mã TK</span><span class="font-medium font-mono quote-bridge-value">${b.tk_code}</span></div>` : ''}
      </div>
      ${isDeletedInApp1 ? '<div class="text-xs text-gray-500 mt-2">Báo giá này đã bị xóa khỏi hệ thống App 1.</div>' : ''}
      ${viewBtn}
    `;
  } catch (e) {
    showFallback('Không tải được dữ liệu báo giá.');
  }
}

function ksEscapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ksParseNumber(value) {
  if (value == null) return 0;
  const num = Number.parseFloat(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function ksFormatCurrency(amount) {
  const num = Number.isFinite(amount) ? amount : ksParseNumber(amount);
  try {
    return new Intl.NumberFormat('vi-VN').format(Math.round(num)) + ' đ';
  } catch (e) {
    return String(Math.round(num || 0)) + ' đ';
  }
}

function ksFormatDateTime(value, emptyLabel) {
  if (!value) return emptyLabel || '---';
  try {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return emptyLabel || '---';
    return dt.toLocaleString('vi-VN', {
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (e) {
    return emptyLabel || '---';
  }
}

function ksBuildQuotePreviewHtml(data) {
  const safe = data && typeof data === 'object' ? data : {};
  const quoteCode = String(safe.quoteCode || '').trim();
  const outletCode = ksEscapeHtml(safe.outletCode || '---');
  const outletName = ksEscapeHtml(safe.outletName || '---');
  const area = ksEscapeHtml(safe.area || '---');
  const address = ksEscapeHtml(safe.address || 'Chưa có địa chỉ');
  const outletPhone = ksEscapeHtml(safe.outletPhone || '---');
  const saleCode = ksEscapeHtml(safe.saleCode || '---');
  const saleName = ksEscapeHtml(safe.saleName || '---');
  const salePhone = ksEscapeHtml(safe.salePhone || '---');
  const ssName = ksEscapeHtml(safe.ssName || '---');
  const saleType = ksEscapeHtml(safe.saleType || 'Sale (SR)');
  const spoName = String(safe.spoName || '').trim();
  const createdLabel = safe.createdAt ? ksFormatDateTime(safe.createdAt, '---') : 'Chưa lưu';
  const createdTs = safe.createdAt ? new Date(safe.createdAt).getTime() : NaN;
  const updatedTs = safe.updatedAt ? new Date(safe.updatedAt).getTime() : NaN;
  const hasRealUpdate = Number.isFinite(updatedTs) && (!Number.isFinite(createdTs) || Math.abs(updatedTs - createdTs) > 2000);
  const updatedLabel = hasRealUpdate ? ksFormatDateTime(safe.updatedAt, '---') : 'Chưa có cập nhật mới';
  const codeLabel = quoteCode ? `Mã Báo Giá: ${ksEscapeHtml(quoteCode)}` : '<em>Mã Báo Giá: Chưa có mã</em>';

  const items = Array.isArray(safe.items) ? safe.items : [];
  const itemRows = items.length
    ? items.map((item) => {
      const code = ksEscapeHtml(item && item.code ? item.code : '');
      const content = ksEscapeHtml(item && item.content ? item.content : '');
      const brand = ksEscapeHtml(item && item.brand ? item.brand : '');
      const width = ksEscapeHtml(item && item.width ? item.width : '-');
      const height = ksEscapeHtml(item && item.height ? item.height : '-');
      const qty = ksEscapeHtml(item && item.quantity ? item.quantity : '-');
      const unit = ksEscapeHtml(item && item.unit ? item.unit : '-');
      const priceNum = ksParseNumber(item && item.price ? item.price : 0);
      const lineTotal = ksFormatCurrency(ksParseNumber(item && item.quantity ? item.quantity : 0) * priceNum);
      return `
        <div class="quote-preview-row">
          <span class="col code">${code}</span>
          <span class="col content">${content}</span>
          <span class="col brand">${brand}</span>
          <span class="col width">${width}</span>
          <span class="col height">${height}</span>
          <span class="col qty">${qty}</span>
          <span class="col unit">${unit}</span>
          <span class="col price">${ksFormatCurrency(priceNum)}</span>
          <span class="col total">${lineTotal}</span>
        </div>
      `;
    }).join('')
    : '<div class="quote-preview-row empty">Chưa có hạng mục nào</div>';

  const totalAmount = ksFormatCurrency(ksParseNumber(safe.totalAmount || 0));
  const primaryImageUrl = safe.primaryImage && safe.primaryImage.data ? String(safe.primaryImage.data).trim() : '';
  const primaryImageName = safe.primaryImage && safe.primaryImage.name ? String(safe.primaryImage.name) : 'Hình báo giá';
  const imageSection = primaryImageUrl
    ? `<img src="${ksEscapeHtml(primaryImageUrl)}" alt="${ksEscapeHtml(primaryImageName)}">`
    : '<div class="quote-preview-image-placeholder">Non Image</div>';

  const hvnLogoSrc = ksEscapeHtml(ksResolveAssetUrl('app/assets/hvn-logo.svg'));
  const qcagLogoSrc = ksEscapeHtml(ksResolveAssetUrl('app/assets/qcag-logo.svg'));

  return `
    <div class="quote-preview-page">
      <div class="quote-preview-left">
        <div class="quote-preview-header">
          <div class="quote-preview-title-block">
            <div class="quote-preview-hvn-logo-wrap"><img src="${hvnLogoSrc}" class="quote-preview-hvn-logo" alt="HVN" width="231" height="22" style="width: 231px; height: 22px; max-width: 100%; object-fit: contain;"></div>
            <div class="quote-preview-title">Báo giá bảng hiệu</div>
            <div class="quote-preview-meta-row">
              <span>Mã Outlet: ${outletCode}</span>
              <span>Outlet: ${outletName}</span>
              <span>Khu vực: ${area}</span>
            </div>
            <div class="quote-preview-meta-row address-row">
              <span>Địa chỉ: ${address} • SĐT: ${outletPhone}</span>
            </div>
            ${spoName ? `<div class="quote-preview-meta-row spo-name-row"><span class="spo-name"><strong>Tên Outlet trên SPO: ${ksEscapeHtml(spoName)}</strong></span></div>` : ''}
          </div>
          <div class="quote-preview-code-block">
            <div class="quote-preview-code">${codeLabel}</div>
            <div class="quote-preview-dates">
              <div class="quote-preview-date-row">Ngày tạo: ${ksEscapeHtml(createdLabel)}</div>
              <div class="quote-preview-date-row">Cập nhật gần nhất: ${ksEscapeHtml(updatedLabel)}</div>
            </div>
          </div>
        </div>
        <div class="quote-preview-image-frame">${imageSection}</div>
        <div class="quote-preview-items${items.length > 8 ? ' items-compact' : ''}">
          <div class="quote-preview-head">
            <span class="col code">Code</span>
            <span class="col content">Nội dung</span>
            <span class="col brand">Brand</span>
            <span class="col width">Ngang</span>
            <span class="col height">Cao</span>
            <span class="col qty">SL</span>
            <span class="col unit">ĐVT</span>
            <span class="col price">Đơn giá</span>
            <span class="col total">Thành tiền</span>
          </div>
          <div class="quote-preview-line-items">
            ${itemRows}
            <div class="quote-preview-total">Tổng cộng: ${totalAmount}</div>
          </div>
        </div>
      </div>
      <div class="quote-preview-right">
        <div class="quote-preview-card logo"><img class="quote-preview-logo-img" src="${qcagLogoSrc}" alt="QCAG" width="160" height="58" style="max-width: 100%; max-height: 80px; object-fit: contain; display: block; margin: 0 auto; width: 160px; height: 58px;"></div>
        <div class="quote-preview-card">
          <div class="quote-preview-card-title">Thông tin Sale</div>
          <div class="quote-preview-card-row"><span>Loại</span><span>${saleType}</span></div>
          <div class="quote-preview-card-row"><span>Mã</span><span>${saleCode}</span></div>
          <div class="quote-preview-card-row"><span>Tên</span><span>${saleName}</span></div>
          <div class="quote-preview-card-row"><span>SĐT</span><span>${salePhone}</span></div>
          <div class="quote-preview-card-row"><span>Tên SS</span><span>${ssName}</span></div>
        </div>
        <div class="quote-preview-sign">
          <span class="quote-preview-tag">Quảng cáo An Giang báo giá</span>
          <div class="quote-preview-sign-box"></div>
        </div>
        <div class="quote-preview-sign">
          <span class="quote-preview-tag">Heineken Việt Nam duyệt</span>
          <div class="quote-preview-sign-box"></div>
        </div>
      </div>
    </div>
  `;
}

function ksResolveAssetUrl(path) {
  const raw = String(path || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;
  try {
    return new URL(raw, window.location.origin).toString();
  } catch (e) {
    return raw;
  }
}

function ksBuildQuotePreviewSvgDataUrl(data) {
  const html = ksBuildQuotePreviewHtml(data);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${KS_QUOTE_PREVIEW_BASE_WIDTH}" height="${KS_QUOTE_PREVIEW_BASE_HEIGHT}" viewBox="0 0 ${KS_QUOTE_PREVIEW_BASE_WIDTH} ${KS_QUOTE_PREVIEW_BASE_HEIGHT}">
      <foreignObject x="0" y="0" width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" style="width:${KS_QUOTE_PREVIEW_BASE_WIDTH}px;height:${KS_QUOTE_PREVIEW_BASE_HEIGHT}px;overflow:hidden;">
          ${html}
        </div>
      </foreignObject>
    </svg>
  `;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/\n\s*/g, ''));
}

let _ksHtml2CanvasLoader = null;

function ksEnsureHtml2CanvasLoaded() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (_ksHtml2CanvasLoader) return _ksHtml2CanvasLoader;
  _ksHtml2CanvasLoader = new Promise((resolve, reject) => {
    const existing = document.getElementById('ksHtml2CanvasScript');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.html2canvas));
      existing.addEventListener('error', () => reject(new Error('html2canvas_load_failed')));
      return;
    }
    const script = document.createElement('script');
    script.id = 'ksHtml2CanvasScript';
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    script.async = true;
    script.onload = () => resolve(window.html2canvas);
    script.onerror = () => reject(new Error('html2canvas_load_failed'));
    document.head.appendChild(script);
  });
  return _ksHtml2CanvasLoader;
}

async function ksBuildQuotePreviewImageDataUrl(data) {
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-99999px';
  host.style.top = '0';
  host.style.width = `${KS_QUOTE_PREVIEW_BASE_WIDTH}px`;
  host.style.height = `${KS_QUOTE_PREVIEW_BASE_HEIGHT}px`;
  host.style.overflow = 'hidden';
  host.style.pointerEvents = 'none';
  host.style.opacity = '0';
  host.innerHTML = ksBuildQuotePreviewHtml(data);
  document.body.appendChild(host);
  try {
    const html2canvas = await ksEnsureHtml2CanvasLoaded();
    if (typeof html2canvas !== 'function') throw new Error('html2canvas_unavailable');
    const target = host.firstElementChild;
    if (!target) throw new Error('preview_target_missing');
    const canvas = await html2canvas(target, {
      backgroundColor: null,
      useCORS: true,
      allowTaint: false,
      logging: false,
      width: KS_QUOTE_PREVIEW_BASE_WIDTH,
      height: KS_QUOTE_PREVIEW_BASE_HEIGHT,
      scale: Math.min(2, window.devicePixelRatio || 1.5),
      imageTimeout: 20000,
    });
    return canvas.toDataURL('image/png', 0.95);
  } catch (e) {
    return ksBuildQuotePreviewSvgDataUrl(data);
  } finally {
    host.remove();
  }
}

async function openQuotePreviewImageFromBridgeCache(backendId) {
  const key = String(backendId || '').trim();
  if (!key) return;
  const renderCache = window.__ksQuoteRenderPreviewCache || {};
  const imageCache = window.__ksQuoteRenderImageCache || {};
  let src = String(imageCache[key] || '').trim();
  const data = renderCache[key];
  if (!src && data) {
    if (typeof showLoadingOverlay === 'function') {
      showLoadingOverlay('Đang mở preview báo giá...', 'Đang render ảnh');
    }
    src = await ksBuildQuotePreviewImageDataUrl(data);
    window.__ksQuoteRenderImageCache = window.__ksQuoteRenderImageCache || {};
    window.__ksQuoteRenderImageCache[key] = src;
    if (typeof hideLoadingOverlay === 'function') {
      hideLoadingOverlay();
    }
  }
  if (!src) {
    if (typeof hideLoadingOverlay === 'function') {
      hideLoadingOverlay();
    }
    showToast('Không tìm thấy ảnh preview báo giá');
    if (data) {
      openQuotePreviewFromBridgeData(data);
    }
    return;
  }
  if (typeof showImageFull === 'function') {
    let arr = [];
    const request = allRequests.find(r => r.__backendId === key);
    if (request) {
      try {
        const designImgs = JSON.parse(request.designImages || '[]').filter(u => u && u !== '...');
        if (designImgs.length > 0) arr.push(designImgs[0]);
      } catch(e) {}
    }
    arr.push(src);
    showImageFull(arr, true, arr.length - 1);
    return;
  }
  if (data) {
    openQuotePreviewFromBridgeData(data);
    return;
  }
  window.open(src, '_blank', 'noopener,noreferrer');
}

const KS_QUOTE_PREVIEW_BASE_WIDTH = 1123;
const KS_QUOTE_PREVIEW_BASE_HEIGHT = 794;

function ksFitQuotePreviewModal() {
  const stage = document.querySelector('#ksQuotePreviewModal .ks-quote-preview-stage');
  const mount = document.getElementById('ksQuotePreviewMount');
  const inner = document.getElementById('ksQuotePreviewInner');
  if (!stage || !mount || !inner) return;
  const availW = Math.max(320, stage.clientWidth || 0);
  const availH = Math.max(220, stage.clientHeight || 0);
  const scale = Math.min(availW / KS_QUOTE_PREVIEW_BASE_WIDTH, availH / KS_QUOTE_PREVIEW_BASE_HEIGHT, 1);
  const w = Math.max(1, Math.floor(KS_QUOTE_PREVIEW_BASE_WIDTH * scale));
  const h = Math.max(1, Math.floor(KS_QUOTE_PREVIEW_BASE_HEIGHT * scale));
  mount.style.width = `${w}px`;
  mount.style.height = `${h}px`;
  inner.style.transform = `scale(${scale})`;
}

function ksEnsureQuotePreviewModal() {
  let modal = document.getElementById('ksQuotePreviewModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'ksQuotePreviewModal';
  modal.className = 'ks-quote-preview-modal';
  modal.innerHTML = `
    <div class="ks-quote-preview-dialog">
      <button type="button" class="ks-quote-preview-close" aria-label="Đóng" onclick="closeQuotePreviewRenderModal()">×</button>
      <div class="ks-quote-preview-stage">
        <div id="ksQuotePreviewMount" class="ks-quote-preview-mount"></div>
      </div>
    </div>
  `;
  modal.addEventListener('click', (ev) => {
    if (ev.target === modal) closeQuotePreviewRenderModal();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeQuotePreviewRenderModal();
  });
  window.addEventListener('resize', ksFitQuotePreviewModal);
  document.body.appendChild(modal);
  return modal;
}

function openQuotePreviewFromBridgeData(data) {
  const safe = data && typeof data === 'object' ? data : null;
  if (!safe) {
    showToast('Không có dữ liệu preview báo giá');
    return;
  }
  const modal = ksEnsureQuotePreviewModal();
  const mount = document.getElementById('ksQuotePreviewMount');
  if (!mount) return;
  mount.innerHTML = `<div id="ksQuotePreviewInner" class="ks-quote-preview-inner">${ksBuildQuotePreviewHtml(safe)}</div>`;
  modal.classList.add('open');
  requestAnimationFrame(ksFitQuotePreviewModal);
}

function openQuotePreviewFromBridgeCache(backendId) {
  openQuotePreviewImageFromBridgeCache(backendId);
}

function closeQuotePreviewRenderModal() {
  const modal = document.getElementById('ksQuotePreviewModal');
  if (!modal) return;
  modal.classList.remove('open');
}

function openQuotePreviewFromSlot(url) {
  const raw = String(url || '').trim();
  if (!raw) return;
  const lower = raw.toLowerCase();
  const isKnownImageRoute = (
    lower.includes('/images/v/') ||
    lower.includes('/images/') ||
    lower.includes('/uploads/')
  );
  const isImage = /\.(png|jpe?g|webp|gif|avif|bmp|svg)(\?|#|$)/.test(lower)
    || lower.startsWith('data:image/')
    || isKnownImageRoute;
  if (isImage && typeof showImageFull === 'function') {
    showImageFull(raw, false);
    return;
  }
  window.open(raw, '_blank', 'noopener,noreferrer');
}

// ── Mobile tab switching ──────────────────────────────────────────────

// Helpers to position/hide the edit-request FAB so it doesn't cover messages
let _fabScrollHandler = null;
let _fabResizeHandler = null;

function updateEditFabPosition() {
  try {
    const fab = document.getElementById('editRequestFab');
    const input = document.getElementById('detailCommentInput');
    const detailContent = document.getElementById('detailContent');
    if (!fab || !input || !detailContent) return;

    // Measure the whole input bar (textarea + image preview + action row),
    // not just the textarea, so the FAB stays above images too.
    const inputBar = input.closest('.mt-3') || input.parentElement || input;
    const rect = inputBar.getBoundingClientRect();
    const viewportH = window.innerHeight || document.documentElement.clientHeight;

    // If input area is visible near bottom, place FAB just above it
    const visibleThreshold = 120; // px from bottom considered "input area visible"
    if (rect.bottom > viewportH - visibleThreshold) {
      fab.classList.remove('fab-hidden');
      // Compute bottom offset so FAB sits slightly above input.
      // Add 2px extra so FAB appears slightly higher in comment tab.
      const bottomOffset = Math.max(8, viewportH - rect.top + 8) + 2;
      fab.style.bottom = bottomOffset + 'px';
    } else {
      // Input scrolled away — hide FAB so it doesn't cover messages
      fab.classList.add('fab-hidden');
      fab.style.bottom = '';
    }
  } catch (e) { /* ignore */ }
}

function attachFabListeners() {
  detachFabListeners();
  _fabScrollHandler = () => updateEditFabPosition();
  _fabResizeHandler = () => updateEditFabPosition();
  const detailContent = document.getElementById('detailContent');
  if (detailContent) detailContent.addEventListener('scroll', _fabScrollHandler);
  window.addEventListener('resize', _fabResizeHandler);
  // initial position
  setTimeout(updateEditFabPosition, 60);
}

function detachFabListeners() {
  try {
    const detailContent = document.getElementById('detailContent');
    if (detailContent && _fabScrollHandler) detailContent.removeEventListener('scroll', _fabScrollHandler);
    if (_fabResizeHandler) window.removeEventListener('resize', _fabResizeHandler);
  } catch (e) {}
  _fabScrollHandler = null; _fabResizeHandler = null;
}

function switchDetailMobileTab(tab) {
  const detailBtn = document.getElementById('mobileTabDetailBtn');
  const commentBtn = document.getElementById('mobileTabCommentBtn');
  const commentsCol = document.querySelector('.detail-comments-col');
  const mainCol = document.querySelector('.detail-main');
  const detailContent = document.getElementById('detailContent');
  if (!detailBtn || !commentBtn || !commentsCol || !mainCol) return;
  if (tab === 'detail') {
    detailBtn.classList.add('active');
    commentBtn.classList.remove('active');
    mainCol.style.display = '';
    commentsCol.style.display = 'none';
    if (detailContent) detailContent.classList.remove('chat-mode');
    // position FAB at bottom-right for detail tab; remove comment listeners
    try {
      const fab = document.getElementById('editRequestFab');
      if (fab) { fab.classList.remove('fab-left'); fab.classList.add('fab-right'); fab.classList.remove('hidden'); fab.classList.remove('fab-hidden'); fab.style.bottom = ''; }
      detachFabListeners();
      showMqJumpHintIfNeeded();
    } catch (e) {}
  } else {
    commentBtn.classList.add('active');
    detailBtn.classList.remove('active');
    mainCol.style.display = 'none';
    commentsCol.style.display = '';
    if (detailContent) detailContent.classList.add('chat-mode');
    // position FAB at bottom-left for comment tab; attach scroll listeners so FAB sits above input
    try {
      const fab = document.getElementById('editRequestFab');
      if (fab) {
        if (currentDetailRequest && currentDetailRequest.type !== 'new') {
          fab.classList.add('hidden');
        } else {
          fab.classList.remove('fab-right'); fab.classList.add('fab-left'); fab.classList.remove('hidden');
        }
      }
      attachFabListeners();
      hideMqJumpHint();
    } catch (e) {}
    // Auto-scroll to newest comment
    setTimeout(() => {
      const list = document.getElementById('detailCommentsList');
      if (list) list.scrollTop = list.scrollHeight;
    }, 60);
  }
}

// ── Back to list ──────────────────────────────────────────────────────

function backToList() {
  const bar = document.getElementById('mobileTabsBar');
  if (bar) bar.remove();
  // Clear chat-mode so it doesn't bleed into next detail open
  const detailContent = document.getElementById('detailContent');
  if (detailContent) detailContent.classList.remove('chat-mode');
  // Reset pending comment images
  _detailCommentPendingImages = [];
  // Hide FAB and close bottom sheet
  try {
    const fab = document.getElementById('editRequestFab');
    if (fab) fab.classList.add('hidden');
    detachFabListeners();
    hideMqJumpHint();
    closeEditRequestSheet();
  } catch (e) {}
  showScreen('listScreen');
  renderRequestList();
}

// ── Upload handlers ───────────────────────────────────────────────────

async function uploadDesign(input) {
  if (!currentDetailRequest) return;
  // Prevent Heineken sales from uploading MQ (designs)
  try {
    if (currentSession && String(currentSession.role || '').toLowerCase() === 'heineken') {
      showToast('Bạn không có quyền upload thiết kế');
      if (input) input.value = '';
      return;
    }
  } catch (e) {}
  const files = Array.from(input.files);
  const currentImgs = JSON.parse(currentDetailRequest.designImages || '[]');

  showLoadingOverlay('Đang upload thiết kế...', 'Vui lòng chờ trong giây lát');

  // Determine GCS subfolder: use mqFolder from request (e.g. 'mq-12345678'),
  // or fall back to generating from outletCode
  const mqSubfolder = currentDetailRequest.mqFolder ||
    ('mq-' + String(currentDetailRequest.outletCode || 'NEWOUTLET').replace(/[^a-zA-Z0-9]/g, '-').replace(/-{2,}/g,'-').replace(/^-|-$/g,'').slice(0,32));

  for (const file of files) {
    // Compress immediately (WebP preferred) — much faster upload
    let dataUrl;
    try {
      dataUrl = await _compressImageFile(file, 1600, 0.82);
    } catch (_) {
      dataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
      });
    }
    // Upload compressed image to GCS
    if (window.dataSdk && window.dataSdk.uploadImage && currentDetailRequest.__backendId) {
      try {
        const url = await window.dataSdk.uploadImage(dataUrl, null, currentDetailRequest.__backendId, mqSubfolder);
        currentImgs.push(url || dataUrl);
      } catch (e) {
        console.warn('[detail-flow] uploadDesign GCS failed, keeping base64:', e);
        currentImgs.push(dataUrl);
      }
    } else {
      currentImgs.push(dataUrl);
    }
  }

  // Upload mới → xóa cờ editingRequestedAt (quay về trạng thái Có MQ)
  // CRITICAL: Build MINIMAL PATCH — do NOT spread currentDetailRequest.
  // currentDetailRequest.statusImages may be the list-endpoint placeholder
  // '["..."]' which would overwrite real hiện trạng GCS URLs in the database.
  const updated = {
    __backendId: currentDetailRequest.__backendId,
    designImages: JSON.stringify(currentImgs),
    designUpdatedAt: new Date().toISOString(),
    editingRequestedAt: null,
    updatedAt: new Date().toISOString()
  };
  if (window.dataSdk) {
    const result = await window.dataSdk.update(updated);
    if (result.isOk) {
      hideLoadingOverlay();
      showToast('Đã upload thiết kế');
      showRequestDetail(currentDetailRequest.__backendId);
    } else {
      hideLoadingOverlay();
      showToast('Lỗi upload thiết kế');
    }
  } else {
    const idx = allRequests.findIndex(r => r.__backendId === currentDetailRequest.__backendId);
    if (idx !== -1) {
      allRequests[idx] = { ...allRequests[idx], designImages: JSON.stringify(currentImgs), designUpdatedAt: new Date().toISOString(), editingRequestedAt: null };
      currentDetailRequest = allRequests[idx];
      saveAllRequestsToStorage();
      hideLoadingOverlay();
      showToast('Đã upload thiết kế (lưu local)');
      showRequestDetail(currentDetailRequest.__backendId);
    } else {
      hideLoadingOverlay();
      showToast('Không tìm thấy yêu cầu để lưu');
    }
  }
  input.value = '';
}

async function uploadAcceptance(input) {
  if (!currentDetailRequest) return;
  const files = Array.from(input.files);
  const currentImgs = JSON.parse(currentDetailRequest.acceptanceImages || '[]');

  showLoadingOverlay('Đang upload ảnh nghiệm thu...', 'Vui lòng chờ trong giây lát');

  for (const file of files) {
    // Compress immediately (WebP preferred) — much faster upload
    let dataUrl;
    try {
      dataUrl = await _compressImageFile(file, 1600, 0.82);
    } catch (_) {
      dataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
      });
    }
    // Upload to GCS (nghiem-thu folder) if dataSdk available
    if (window.dataSdk && window.dataSdk.uploadImage && currentDetailRequest.__backendId) {
      try {
        const url = await window.dataSdk.uploadImage(dataUrl, null, currentDetailRequest.__backendId, 'nghiem-thu');
        currentImgs.push(url || dataUrl);
      } catch (e) {
        console.warn('[detail-flow] uploadAcceptance GCS failed, keeping base64:', e);
        currentImgs.push(dataUrl);
      }
    } else {
      currentImgs.push(dataUrl);
    }
  }

  // CRITICAL: Build MINIMAL PATCH — do NOT spread currentDetailRequest.
  // statusImages placeholder must never reach the DB and overwrite real hiện trạng URLs.
  const updated = {
    __backendId: currentDetailRequest.__backendId,
    acceptanceImages: JSON.stringify(currentImgs),
    updatedAt: new Date().toISOString()
  };
  if (window.dataSdk) {
    const result = await window.dataSdk.update(updated);
    if (result.isOk) {
      hideLoadingOverlay();
      showToast('Đã upload ảnh nghiệm thu');
      // Navigate to warranty list filtered by "Đã bảo hành" so item appears in correct category
      if (typeof showWarrantyListWithFilter === 'function') showWarrantyListWithFilter('warranty_done');
    } else {
      hideLoadingOverlay();
      showToast('Lỗi upload ảnh nghiệm thu');
    }
  } else {
    const idx = allRequests.findIndex(r => r.__backendId === currentDetailRequest.__backendId);
    if (idx !== -1) {
      allRequests[idx] = { ...allRequests[idx], acceptanceImages: JSON.stringify(currentImgs) };
      currentDetailRequest = allRequests[idx];
      saveAllRequestsToStorage();
      hideLoadingOverlay();
      showToast('Đã upload ảnh nghiệm thu (lưu local)');
      if (typeof showWarrantyListWithFilter === 'function') showWarrantyListWithFilter('warranty_done');
    } else {
      hideLoadingOverlay();
      showToast('Không tìm thấy yêu cầu để lưu');
    }
  }
  input.value = '';
}

// ── Design viewer (modal) ─────────────────────────────────────────────

async function viewDesign(id) {
  let request = allRequests.find(r => r.__backendId === id);
  if (!request) return;
  // ownership enforcement: only the creator can view design images
  if (!isRequestOwnedByCurrentSession(request)) {
    showToast('Không có quyền xem yêu cầu này');
    return;
  }

  // Open modal IMMEDIATELY with spinner — user sees the modal open at once,
  // before any async fetch. This removes the perceived wait time.
  const modal = document.getElementById('designModal');
  const content = document.getElementById('designModalContent');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  content.innerHTML = '<div class="flex items-center justify-center flex-1"><div class="dv-loading-spinner"></div></div>';

  // If designImages is still the list-endpoint placeholder, fetch real URLs first
  let designImages = request.designImages || '[]';
  if (designImages === '["..."]' && window.dataSdk && typeof window.dataSdk.getOne === 'function') {
    try {
      const r = await window.dataSdk.getOne(id);
      if (r && r.isOk && r.data) {
        request = Object.assign({}, request, r.data);
        // Strip any remaining placeholder values
        ['designImages', 'oldContentImages', 'statusImages', 'acceptanceImages'].forEach(k => {
          if (request[k] === '["..."]') request[k] = '[]';
        });
        // Update local store
        const idx = allRequests.findIndex(x => x.__backendId === id);
        if (idx !== -1) allRequests[idx] = request;
      }
    } catch (e) { /* fall through with existing data */ }
  }

  const designImgs = JSON.parse(request.designImages || '[]').filter(u => u && u !== '...');
  const items = JSON.parse(request.items || '[]');
  const oldContentImgs = JSON.parse(request.oldContentImages || '[]').filter(u => u && u !== '...');

  // Update outlet counter (x/y) from the gallery outlet list if available
  const outletList = window._dvOutletList;
  const counterEl = document.getElementById('dvOutletCounter');
  const titleEl = document.getElementById('dvModalTitle');
  if (outletList && outletList.length > 0) {
    window._dvOutletIdx = outletList.findIndex(r => r.__backendId === id);
    if (counterEl && window._dvOutletIdx !== -1) {
      counterEl.textContent = `${window._dvOutletIdx + 1} / ${outletList.length}`;
    }
    if (titleEl) titleEl.textContent = request.outletName || 'Xem Thiết Kế';
  } else {
    if (counterEl) counterEl.textContent = '';
    if (titleEl) titleEl.textContent = 'Xem Thiết Kế';
  }

  // requester info (show sale / requester details prominently)
  const requester = (() => { try { return JSON.parse(request.requester || '{}'); } catch (e) { return {}; } })();
  const requesterLabel = requester && requester.role === 'heineken'
    ? (requester.saleName ? `${escapeHtml(requester.saleName)} (${escapeHtml(requester.saleCode || '')})` : escapeHtml(requester.phone || ''))
    : (requester && requester.role === 'qcag' ? `QCAG — ${escapeHtml(requester.phone || '')}` : '');

  const dotsHtml = designImgs.length > 1
    ? `<div class="dv-dots" id="dvDots">
        ${designImgs.map((_, i) => `<div class="dv-dot${i === 0 ? ' active' : ''}" onclick="dvGoTo(${i})"></div>`).join('')}
       </div>`
    : '';

  content.innerHTML = `
    <div class="dv-wrap flex-1 mode-content" id="dvWrap">
      <div class="dv-media">
        <div class="design-carousel" id="dvCarousel">
          ${designImgs.map((img, i) => `
            <div class="design-slide${i > 0 ? ' dv-slide-loading' : ''}" id="dvSlide${i}">
              <img src="${img}" class="design-img" onclick="showImageFull(this.src, false)" title="Tap để zoom"
                style="cursor:zoom-in;opacity:${i === 0 ? '1' : '0'};transition:opacity 0.28s ease"
                onload="this.style.opacity='1';var s=this.parentElement;if(s)s.classList.remove('dv-slide-loading');"
                onerror="this.style.opacity='0.5';var s=this.parentElement;if(s)s.classList.remove('dv-slide-loading');">
            </div>
          `).join('')}
        </div>
        ${dotsHtml}
      </div>

      <div class="design-info" id="designInfoPanel">
        <div class="dv-handle" onclick="openImageFromModal()">
          <div class="dv-handle-bar"></div>
        </div>
        <div class="info-title">${request.outletName}</div>
        <div class="info-scroll">
          ${requesterLabel ? `<div class="meta-row"><div class="meta-label">Người yêu cầu</div><div class="meta-value">${requesterLabel}</div></div>` : ''}
          <div class="meta-row"><div class="meta-label">Mã Outlet</div><div class="meta-value">${request.outletCode}</div></div>
          <div class="meta-row"><div class="meta-label">Địa chỉ</div><div class="meta-value">${request.address}</div></div>
          <div class="meta-row"><div class="meta-label">SĐT</div><div class="meta-value">${request.phone}</div></div>

          <div class="section-title">Hạng mục</div>
          <div class="space-y-1 text-sm text-gray-700">
            ${items.length > 0 ? items.map((item, idx) => `
              <div>${idx + 1}. ${item.type}${item.brand ? ` • ${item.brand}` : ''}${item.action ? ` • ${item.action}` : ''}${item.poles ? ` • ${item.poles} trụ` : ''}${item.useOldSize ? ' • KT cũ' : (item.width ? ` • ${item.width}×${item.height}m` : '')}${item.otherContent ? ` • ${item.otherContent}` : ''}${item.note ? ` • Yêu cầu: ${item.note}` : ''}</div>
            `).join('') : '<div class="text-gray-400">Không có</div>'}
          </div>

          <div class="section-title">Nội dung bảng hiệu</div>
          <div class="text-sm text-gray-700">
            ${request.oldContent
              ? (oldContentImgs.length > 0
                  ? `<div class="flex flex-wrap">${oldContentImgs.map(img => `<img src="${img}" class="sign-thumb" onclick="showImageFull(this.src, false)">`).join('')}</div>`
                  : '<span class="text-gray-400">Chưa có ảnh nội dung cũ</span>')
              : (request.content || '<span class="text-gray-400">Không có nội dung</span>')}
          </div>

          <div class="section-title" style="margin-top:12px">Trao đổi (Bình luận)</div>
          <div id="designComments" class="comment-list" style="padding-bottom:4px"></div>
        </div>
        <!-- Sticky comment footer – fixed at bottom of info panel -->
        <div class="design-comment-footer">
          <div class="design-comment-input-outer">
            <div id="designCommentImgPreview" class="hidden design-comment-img-preview"></div>
            <textarea id="designCommentInput" rows="2" class="design-comment-input" placeholder="Viết bình luận..."></textarea>
          </div>
          <label class="design-comment-img-btn" title="Đính kèm ảnh">
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            <input type="file" accept="image/*" multiple class="hidden" onchange="handleDetailCommentImagePick(this)">
          </label>
          <button onclick="addDesignComment('${request.__backendId}')" class="design-comment-send">Gửi</button>
        </div>
      </div>
    </div>`;

  // Render existing comments
  try {
    const comments = JSON.parse(request.comments || '[]');
    const commentsEl = document.getElementById('designComments');
    if (commentsEl) {
      if (!comments || comments.length === 0) {
        commentsEl.innerHTML = '<div class="text-sm text-gray-400">Chưa có bình luận</div>';
      } else {
        commentsEl.innerHTML = comments.map(c => `
          <div class="comment-item">
            <div class="comment-meta"><strong>${escapeHtml(c.authorName || c.authorRole || 'Người dùng')}</strong> <span class="comment-role">${escapeHtml(c.authorRole || '')}</span> <span class="comment-time">${new Date(c.createdAt).toLocaleString('vi-VN')}</span></div>
            <div class="comment-body">${escapeHtml(c.text)}</div>
          </div>
        `).join('');
      }
    }
  } catch (e) { /* ignore */ }

  // Set current request so showImageFull can use it
  window._dv_currentDesignReq = request;
  window._prevScreenBeforeDesign = document.getElementById('detailScreen')?.classList.contains('flex') ? 'detail' : 'list';

  // Modal already opened above (with spinner) — no need to re-open here.

  // If no design images but outlet is in waiting/editing state, show placeholder
  const dvState = typeof getRequestDesignState === 'function' ? getRequestDesignState(request) : null;
  if (designImgs.length === 0 && (dvState === 'waiting' || dvState === 'editing')) {
    const stateLabel = dvState === 'editing' ? 'Chỉnh sửa' : 'Thiết kế';
    content.innerHTML = `
      <div id="dvPlaceholder" class="flex flex-col items-center justify-center flex-1 p-8 text-center gap-4" style="touch-action:pan-y">
        <svg class="w-16 h-16 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        <div class="text-white/70 text-base font-semibold">${escapeHtml(request.outletName)}</div>
        <div class="text-white/45 text-sm">đang chờ ${stateLabel}</div>
        <div class="text-white/30 text-xs max-w-xs leading-relaxed">Nếu cần gấp vui lòng liên hệ QCAG qua Zalo để được hỗ trợ.</div>
      </div>`;
    window._dv_currentDesignImgs = [];
    window._dv_currentDesignReq = request;
    // Attach swipe-to-navigate on the placeholder div
    requestAnimationFrame(() => {
      const ph = document.getElementById('dvPlaceholder');
      if (!ph) return;
      let sx = 0, sy = 0;
      ph.addEventListener('touchstart', e => { if (e.touches[0]) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, { passive: true });
      ph.addEventListener('touchend', e => {
        const t = e.changedTouches && e.changedTouches[0]; if (!t) return;
        const dx = t.clientX - sx; const dy = t.clientY - sy;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
          if (dx < 0) navigateDesignRequest(1); else navigateDesignRequest(-1);
        }
      }, { passive: true });
    });
    return;
  }

  if (designImgs.length > 0) {
    showImageFull(designImgs[0]);
  }

  try { window._dv_currentDesignImgs = designImgs.slice(); } catch (e) { window._dv_currentDesignImgs = designImgs; }

  requestAnimationFrame(() => {
    const carousel = document.getElementById('dvCarousel');
    if (carousel && designImgs.length > 1) {
      carousel.addEventListener('scroll', () => {
        const idx = Math.round(carousel.scrollLeft / carousel.offsetWidth);
        document.querySelectorAll('.dv-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
      }, { passive: true });
    }
  });
}

function dvSetMode(mode) {
  const wrap = document.getElementById('dvWrap');
  const imgBtn = document.getElementById('dvModeImage');
  const contentBtn = document.getElementById('dvModeContent');
  if (!wrap) return;
  wrap.classList.remove('mode-image', 'mode-content');
  wrap.classList.add(`mode-${mode}`);
  if (imgBtn) imgBtn.classList.toggle('active', mode === 'image');
  if (contentBtn) contentBtn.classList.toggle('active', mode === 'content');
  const panel = document.getElementById('designInfoPanel');
  if (panel) {
    if (mode === 'content') panel.classList.remove('collapsed');
    else panel.classList.add('collapsed');
  }
}

function closeDesignModal() {
  closeDvZoom();
  const modal = document.getElementById('designModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

function dvGoTo(idx) {
  const carousel = document.getElementById('dvCarousel');
  if (carousel) carousel.scrollTo({ left: idx * carousel.offsetWidth, behavior: 'smooth' });
}

function toggleDesignInfo() {
  const panel = document.getElementById('designInfoPanel');
  if (!panel) return;
  panel.classList.toggle('collapsed');
}

function openImageFromModal() {
  const imgs = window._dv_currentDesignImgs || [];
  if (!imgs || imgs.length === 0) return;
  const panel = document.getElementById('designInfoPanel');
  if (panel) panel.classList.add('collapsed');
  try { showImageFull(imgs[0]); } catch (e) { /* ignore */ }
}

function navigateDesignRequest(delta) {
  // Use gallery outlet list if available (from list/gallery view)
  const outletList = window._dvOutletList;
  if (outletList && outletList.length > 0 && window._dvOutletIdx !== undefined && window._dvOutletIdx !== -1) {
    let newIdx = window._dvOutletIdx + delta;
    if (newIdx < 0) newIdx = outletList.length - 1;
    if (newIdx >= outletList.length) newIdx = 0;
    const nextReq = outletList[newIdx];
    if (nextReq) { viewDesign(nextReq.__backendId); return; }
  }
  // Fall back to detail-based navigation
  if (!currentDetailRequest) return;
  const idx = allRequests.findIndex(r => r.__backendId === currentDetailRequest.__backendId);
  if (idx === -1) return;
  let newIdx = idx + delta;
  if (newIdx < 0) newIdx = allRequests.length - 1;
  if (newIdx >= allRequests.length) newIdx = 0;
  const nextReq = allRequests[newIdx];
  if (!nextReq) return;
  viewDesign(nextReq.__backendId);
}

function addDesignSwipeHandlers() {
  const attachOverlay = () => {
    const overlay = document.getElementById('dvZoomOverlay');
    if (!overlay) return;
    let startX = 0, startY = 0, tracking = false;
    overlay.addEventListener('touchstart', e => {
      if (!e.touches || e.touches.length === 0) return;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY; tracking = true;
    }, { passive: true });
    overlay.addEventListener('touchend', e => {
      if (!tracking) return; tracking = false;
      const touch = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
      if (!touch) return;
      const dx = touch.clientX - startX; const dy = touch.clientY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        const imgEl = document.getElementById('dvZoomImg');
        const canNav = imgEl ? (Math.abs(getCurrentScale(imgEl) - 1) < 0.001) : true;
        if (!canNav) return;
        if (dx < 0) navigateDesignRequest(1); else navigateDesignRequest(-1);
      }
    }, { passive: true });
  };

  attachOverlay();

  const modal = document.getElementById('designModal');
  if (!modal) return;
  let mStartX = 0, mStartY = 0, mTracking = false;
  modal.addEventListener('touchstart', e => {
    if (document.getElementById('dvZoomOverlay')) return;
    if (!e.touches || e.touches.length === 0) return;
    const panel = document.getElementById('designInfoPanel');
    if (panel && panel.classList.contains('collapsed')) return;
    mStartX = e.touches[0].clientX; mStartY = e.touches[0].clientY; mTracking = true;
  }, { passive: true });
  modal.addEventListener('touchend', e => {
    if (!mTracking) return; mTracking = false;
    const touch = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
    if (!touch) return;
    const dx = touch.clientX - mStartX; const dy = touch.clientY - mStartY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) navigateDesignRequest(1); else navigateDesignRequest(-1);
    }
  }, { passive: true });
}

function getCurrentScale(imgEl) {
  const st = window.getComputedStyle(imgEl).transform;
  if (!st || st === 'none') return 1;
  const m = st.match(/matrix\(([^)]+)\)/);
  if (!m) return 1;
  const vals = m[1].split(',').map(parseFloat);
  return vals[0] || 1;
}

document.addEventListener('click', () => setTimeout(addDesignSwipeHandlers, 200));

// ── Zoom overlay ──────────────────────────────────────────────────────

function showImageFull(srcOrArray, showContent = true, startIndex = 0) {
  // Prevent immediate re-open after a recent close (debounce accidental double-open)
  try {
    if (window._dv_lastClosedAt && (Date.now() - window._dv_lastClosedAt) < 500) return;
  } catch (e) { /* ignore */ }

  const imgs = Array.isArray(srcOrArray) ? srcOrArray : [srcOrArray];
  let currentIndex = startIndex >= 0 && startIndex < imgs.length ? startIndex : 0;
  const src = imgs[currentIndex];

  // If the design modal is currently open (we're viewing a request's MQ),
  // ensure the zoom overlay shows the action bar even if caller passed
  // showContent=false (some image thumbnails call showImageFull(..., false)).
  try {
    const dmodal = document.getElementById('designModal');
    if (dmodal && !dmodal.classList.contains('hidden') && window._dv_currentDesignReq) {
      showContent = true;
    }
  } catch (e) { /* ignore */ }

  const overlay = document.createElement('div');
  overlay.id = 'dvZoomOverlay';
  overlay.innerHTML = `
    <img id="dvZoomImg" src="${src}" class="dv-zoom-img" draggable="false" style="opacity:0;transition:opacity .18s ease" decoding="async">
    <button class="dv-zoom-close">✕</button>
    <button class="dv-zoom-dvhc-btn" onclick="(function(e){e.stopPropagation();if(typeof qcagDesktopToggleDVHCLookup==='function')qcagDesktopToggleDVHCLookup();})(event)" title="Tra cứu ĐVHC">🗺️</button>
    <div class="dv-zoom-scale" id="dvZoomScale">100%</div>
    ${imgs.length > 1 ? `
    <button id="dvZoomPrevBtn" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);width:44px;height:44px;background:rgba(0,0,0,0.5);color:#fff;border-radius:50%;font-size:20px;z-index:9999;border:none;pointer-events:auto;display:flex;align-items:center;justify-content:center;">❮</button>
    <button id="dvZoomNextBtn" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);width:44px;height:44px;background:rgba(0,0,0,0.5);color:#fff;border-radius:50%;font-size:20px;z-index:9999;border:none;pointer-events:auto;display:flex;align-items:center;justify-content:center;">❯</button>
    ` : ''}`;
  if (showContent) {
    const showContentBar = document.createElement('div');
    showContentBar.className = 'dv-zoom-bottom';
    const inner = document.createElement('div');
    inner.className = 'dv-zoom-bottom-inner';

    // For Heineken: add "Yêu cầu chỉnh sửa" button (do NOT close zoom)
    if (typeof currentSession !== 'undefined' && currentSession && String(currentSession.role || '').toLowerCase() === 'heineken') {
      const editBtn = document.createElement('button');
      editBtn.className = 'dv-zoom-btn dv-zoom-btn-edit';
      editBtn.textContent = 'Yêu cầu chỉnh sửa';
      editBtn.onclick = (e) => {
        try { e.stopPropagation(); } catch (ex) {}
        window._editRequestOrigin = 'design';
        if (window._dv_currentDesignReq) currentDetailRequest = window._dv_currentDesignReq;
        openEditRequestSheet();
      };
      inner.appendChild(editBtn);
    }

    const viewBtn = document.createElement('button');
    viewBtn.className = 'dv-zoom-btn dv-zoom-btn-view';
    viewBtn.textContent = 'Xem nội dung yêu cầu';
    viewBtn.onclick = (e) => {
      try { e.preventDefault(); e.stopPropagation(); } catch (ex) {}
      closeDvZoom();
      dvSetMode('content');
      // Hide comment section — user just wants to read the request info
      const commentsEl = document.getElementById('designComments');
      if (commentsEl) {
        const sectionTitle = commentsEl.previousElementSibling;
        if (sectionTitle) sectionTitle.style.display = 'none';
        commentsEl.style.display = 'none';
      }
      const footer = document.querySelector('.design-comment-footer');
      if (footer) footer.style.display = 'none';
    };
    inner.appendChild(viewBtn);
    showContentBar.appendChild(inner);
    overlay.appendChild(showContentBar);
  }
  document.body.appendChild(overlay);
  // attach safe handlers to close button (stop propagation so underlying
  // elements don't receive the same click and re-open the modal)
  try {
    const closeBtn = overlay.querySelector('.dv-zoom-close');
    if (closeBtn) closeBtn.addEventListener('click', (ev) => {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (ex) {}
      closeDvZoom();
      closeDesignModal();
    });
  } catch (e) { /* ignore */ }

  let scale = 1, tx = 0, ty = 0;
  const MAX = 10, MIN = 1; // 1000% max zoom
  let isDragging = false, dragStartX = 0, dragStartY = 0;
  let lastDist = null;
  let lastTap = 0;

  const img = document.getElementById('dvZoomImg');
  const scaleEl = document.getElementById('dvZoomScale');

  // Fade in once loaded (cache-hit = nearly instant, network = smooth reveal)
  if (img) {
    img.onload = () => { img.style.opacity = '1'; };
    img.onerror = () => { img.style.opacity = '1'; }; // show broken img rather than hiding
    if (img.complete) {
      img.style.opacity = '1';
    }
  }

  function apply(animated) {
    img.style.transition = animated ? 'transform 0.2s ease' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    scaleEl.textContent = Math.round(scale * 100) + '%';
  }
  function clamp() {
    if (scale <= 1) { tx = 0; ty = 0; return; }
    const pad = (scale - 1) * 500; // larger pan range for high zoom
    tx = Math.max(-pad, Math.min(pad, tx));
    ty = Math.max(-pad, Math.min(pad, ty));
  }

  overlay.addEventListener('wheel', e => {
    e.preventDefault();
    scale = Math.max(MIN, Math.min(MAX, scale * (e.deltaY < 0 ? 1.12 : 0.9)));
    clamp(); apply(false);
  }, { passive: false });

  img.addEventListener('mousedown', e => {
    if (scale <= 1) return;
    isDragging = true;
    dragStartX = e.clientX - tx;
    dragStartY = e.clientY - ty;
    img.classList.add('grabbing');
    e.preventDefault();
  });
  overlay.addEventListener('mousemove', e => {
    if (!isDragging) return;
    tx = e.clientX - dragStartX;
    ty = e.clientY - dragStartY;
    clamp(); apply(false);
  });
  overlay.addEventListener('mouseup', () => { isDragging = false; img.classList.remove('grabbing'); });

  img.addEventListener('dblclick', () => { scale = 1; tx = 0; ty = 0; apply(true); });

  function navigateZoom(dir) {
    if (imgs.length <= 1) return;
    if (scale > 1) { scale = 1; tx = 0; ty = 0; apply(true); }
    currentIndex = (currentIndex + dir + imgs.length) % imgs.length;
    img.style.opacity = '0';
    setTimeout(() => {
      img.onload = () => { img.style.opacity = '1'; }; // Ensure we re-attach just in case
      img.src = imgs[currentIndex];
      if (img.complete) { img.style.opacity = '1'; }
    }, 150);
  }

  if (imgs.length > 1) {
    const prevBtn = document.getElementById('dvZoomPrevBtn');
    const nextBtn = document.getElementById('dvZoomNextBtn');
    if (prevBtn) prevBtn.onclick = (e) => { e.stopPropagation(); navigateZoom(-1); };
    if (nextBtn) nextBtn.onclick = (e) => { e.stopPropagation(); navigateZoom(1); };
  }

  let touchStartX = 0, touchStartY = 0, zoomSwipeThreshold = 50;

  overlay.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      lastDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 280) { scale = 1; tx = 0; ty = 0; apply(true); }
      lastTap = now;
      if (scale > 1) {
        isDragging = true;
        dragStartX = e.touches[0].clientX - tx;
        dragStartY = e.touches[0].clientY - ty;
      }
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }
  }, { passive: true });

  overlay.addEventListener('touchmove', e => {
    if (scale > 1) e.preventDefault(); // only prevent default if zoomed in
    if (e.touches.length === 2 && lastDist !== null) {
      e.preventDefault();
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      scale = Math.max(MIN, Math.min(MAX, scale * (d / lastDist)));
      lastDist = d;
      clamp(); apply(false);
    } else if (e.touches.length === 1 && isDragging) {
      e.preventDefault();
      tx = e.touches[0].clientX - dragStartX;
      ty = e.touches[0].clientY - dragStartY;
      clamp(); apply(false);
    }
  }, { passive: false });

  overlay.addEventListener('touchend', e => {
    if (e.touches.length < 2) lastDist = null;
    if (e.touches.length === 0) {
      isDragging = false;
      if (scale === 1 && imgs.length > 1 && e.changedTouches && e.changedTouches[0]) {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > zoomSwipeThreshold) {
          if (dx < 0) navigateZoom(1); else navigateZoom(-1);
        }
      }
    }
  }, { passive: true });

  function onKey(e) { 
    if (e.key === 'Escape') { closeDvZoom(); document.removeEventListener('keydown', onKey); }
    if (e.key === 'ArrowLeft' && scale === 1) { navigateZoom(-1); }
    if (e.key === 'ArrowRight' && scale === 1) { navigateZoom(1); }
  }
  document.addEventListener('keydown', onKey);
}

function closeDvZoom() {
  const overlay = document.getElementById('dvZoomOverlay');
  if (overlay) overlay.remove();
  try { window._dv_lastClosedAt = Date.now(); } catch (e) { /* ignore */ }
}

// ── Delete handlers ───────────────────────────────────────────────────

function deleteCurrentRequest() {
  document.getElementById('deleteModal').classList.remove('hidden');
}

function closeDeleteModal() {
  document.getElementById('deleteModal').classList.add('hidden');
}

async function confirmDelete() {
  if (!currentDetailRequest || !window.dataSdk || typeof window.dataSdk.delete !== 'function') {
    showToast('Không thể xóa yêu cầu');
    closeDeleteModal();
    return;
  }
  const result = await window.dataSdk.delete(currentDetailRequest);
  if (result.isOk) {
    showToast('Đã xóa yêu cầu');
    closeDeleteModal();
    backToList();
  } else {
    showToast('Lỗi xóa yêu cầu');
  }
}

// ── Edit Request Flow ────────────────────────────────────────────────

let _editRequestCategories = [];

// ── Edit-request pending images ─────────────────────────────────────
let _editRequestPendingImages = [];

function _renderEditRequestImgPreview() {
  const wrap = document.getElementById('editRequestImgPreview');
  if (!wrap) return;
  if (_editRequestPendingImages.length === 0) {
    wrap.innerHTML = ''; wrap.classList.add('hidden'); return;
  }
  wrap.classList.remove('hidden');
  wrap.innerHTML = _editRequestPendingImages.map((src, i) =>
    `<div class="edit-req-img-thumb">`+
    `<img src="${src}">`+
    `<button type="button" onclick="_removeEditRequestImage(${i})">✕</button>`+
    `</div>`
  ).join('');
}

function _removeEditRequestImage(idx) {
  _editRequestPendingImages.splice(idx, 1);
  _renderEditRequestImgPreview();
}

async function handleEditRequestImagePick(input) {
  if (!input || !input.files) return;
  const files = Array.from(input.files);
  input.value = '';
  for (const file of files) {
    // Compress immediately (WebP preferred)
    try {
      const dataUrl = await _compressImageFile(file, 1600, 0.82);
      _editRequestPendingImages.push(dataUrl);
    } catch (_) {
      const dataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.readAsDataURL(file);
      });
      _editRequestPendingImages.push(dataUrl);
    }
  }
  _renderEditRequestImgPreview();
}

function openEditRequestSheet() {
  _editRequestCategories = [];
  _editRequestPendingImages = [];
  _renderEditRequestImgPreview();
  // reset checkboxes
  ['editCat_noiDung', 'editCat_hangMuc', 'editCat_brand'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('checked'); }
  });
  // reset textarea
  const ta = document.getElementById('editRequestInput');
  if (ta) ta.value = '';
  // show step 1, hide step 2
  const s1 = document.getElementById('editSheetStep1');
  const s2 = document.getElementById('editSheetStep2');
  if (s1) s1.classList.remove('hidden');
  if (s2) s2.classList.add('hidden');
  // open overlay
  const overlay = document.getElementById('editRequestSheet');
  if (overlay) { overlay.classList.remove('hidden'); requestAnimationFrame(() => overlay.classList.add('sheet-open')); }
}

function closeEditRequestSheet() {
  const overlay = document.getElementById('editRequestSheet');
  if (!overlay) return;
  overlay.classList.remove('sheet-open');
  setTimeout(() => { overlay.classList.add('hidden'); }, 260);
}

function closeEditRequestSheetOnBackdrop(e) {
  if (e.target === document.getElementById('editRequestSheet')) closeEditRequestSheet();
}

function toggleEditCategory(label) {
  const idMap = { 'Sửa nội dung': 'editCat_noiDung', 'Thay đổi hạng mục': 'editCat_hangMuc', 'Đổi brand': 'editCat_brand' };
  const idx = _editRequestCategories.indexOf(label);
  if (idx === -1) {
    _editRequestCategories.push(label);
  } else {
    _editRequestCategories.splice(idx, 1);
  }
  const checkEl = document.getElementById(idMap[label]);
  if (checkEl) checkEl.classList.toggle('checked', _editRequestCategories.includes(label));
}

function backToEditCategories() {
  document.getElementById('editSheetStep1').classList.remove('hidden');
  document.getElementById('editSheetStep2').classList.add('hidden');
}

function proceedEditRequest() {
  if (_editRequestCategories.length === 0) {
    showToast('Vui lòng chọn ít nhất một nội dung cần chỉnh sửa');
    return;
  }
  const label = document.getElementById('editSheetCategLabel');
  if (label) label.textContent = 'Loại: ' + _editRequestCategories.join(', ');
  document.getElementById('editSheetStep1').classList.add('hidden');
  document.getElementById('editSheetStep2').classList.remove('hidden');
  setTimeout(() => { const ta = document.getElementById('editRequestInput'); if (ta) ta.focus(); }, 100);
}

async function submitEditRequest() {
  const ta = document.getElementById('editRequestInput');
  const text = ta ? ta.value.trim() : '';
  if (!text) { showToast('Vui lòng nhập nội dung yêu cầu chỉnh sửa'); return; }
  if (!currentDetailRequest) { showToast('Không tìm thấy yêu cầu'); return; }

  const backendId = currentDetailRequest.__backendId;
  const reqIdx = allRequests.findIndex(r => r.__backendId === backendId);
  if (reqIdx === -1) { showToast('Không tìm thấy yêu cầu'); return; }

  const request = allRequests[reqIdx];
  let comments = [];
  try { comments = JSON.parse(request.comments || '[]'); } catch (e) { comments = []; }

  const authorRole = (currentSession && currentSession.role) || 'unknown';
  const authorName = (currentSession && (currentSession.saleName || currentSession.phone)) || 'Người dùng';
  const comment = {
    authorRole,
    authorName,
    text,
    commentType: 'edit-request',
    editCategories: [..._editRequestCategories],
    ...(_editRequestPendingImages.length > 0 ? { images: [..._editRequestPendingImages] } : {}),
    createdAt: new Date().toISOString()
  };
  _editRequestPendingImages = [];
  comments.push(comment);

  // Heineken edit-request must pull request back to processing and clear MQ
  let extraFields = {};
  if (String(authorRole || '').toLowerCase() === 'heineken') {
    const existingDesignImgs = (() => {
      try { return JSON.parse(request.designImages || '[]'); } catch (e) { return []; }
    })();
    extraFields = {
      editingRequestedAt: new Date().toISOString(),
      status: 'processing',
      ...(Array.isArray(existingDesignImgs) && existingDesignImgs.length > 0 ? { designImages: '[]' } : {})
    };
  }

  // Build PATCH payload with ONLY the fields that need to change.
  // CRITICAL: Do NOT spread the full request — it may contain placeholder
  // values like '["..."]' for statusImages (from the list endpoint), which
  // would overwrite real GCS URLs in the database.
  const updated = {
    __backendId: request.__backendId,
    comments: JSON.stringify(comments),
    ...extraFields,
    updatedAt: new Date().toISOString()
  };

  closeEditRequestSheet();
  showLoadingOverlay('Đang gửi yêu cầu chỉnh sửa...', 'Vui lòng chờ trong giây lát');

  if (window.dataSdk) {
    const result = await window.dataSdk.update(updated);
    if (result.isOk) {
      hideLoadingOverlay();
      showToast('Đã gửi yêu cầu chỉnh sửa');
      // Merge changes into existing record (don't replace — updated is partial)
      const idx = allRequests.findIndex(r => r.__backendId === backendId);
      if (idx !== -1) Object.assign(allRequests[idx], updated);
      showRequestDetail(backendId);
        // If QCAG desktop UI is open in this session, force it back to 'processing'
        try {
          if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
            if (typeof window !== 'undefined') {
              window._qcagDesktopStatusFilter = 'processing';
              window._qcagRequestsVersion = (window._qcagRequestsVersion || 0) + 1;
              if (window._qcagRequestCodeCache) window._qcagRequestCodeCache.version = 0;
              if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();
            }
          }
        } catch (e) { /* non-fatal */ }
    } else {
      hideLoadingOverlay();
      showToast('Lỗi gửi yêu cầu');
    }
  } else {
    Object.assign(allRequests[reqIdx], updated);
    saveAllRequestsToStorage();
    hideLoadingOverlay();
    showToast('Đã gửi yêu cầu chỉnh sửa (lưu local)');
    showRequestDetail(backendId);
  }
}

