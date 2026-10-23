// ====================================================================
// js/flows/detail-flow.js — request detail view, comments, design viewer,
//                           zoom overlay, upload handlers
// ====================================================================
'use strict';

// Ownership guard: only allow viewing requests that belong to currentSession.
// Ownership guard: only allow viewing requests that belong to currentSession.
function safeParseComments(raw, fallback = []) {
  if (!raw) return fallback;
  if (Array.isArray(raw)) return raw;
  try {
    let p = JSON.parse(raw);
    if (typeof p === 'string') {
      try {
        const p2 = JSON.parse(p);
        if (Array.isArray(p2)) p = p2;
      } catch (_) { }
    }
    if (Array.isArray(p)) return p;
    if (typeof p === 'string' && p.trim() && p.trim() !== '[]') {
      return [{
        authorRole: 'heineken',
        authorName: 'Sale Heineken',
        text: p.trim(),
        commentType: 'edit-request',
        editCategories: [],
        createdAt: new Date().toISOString()
      }];
    }
    return fallback;
  } catch (e) {
    if (typeof raw === 'string' && raw.trim() && raw.trim() !== '[]' && !raw.trim().startsWith('{') && !raw.trim().startsWith('[')) {
      return [{
        authorRole: 'heineken',
        authorName: 'Sale Heineken',
        text: raw.trim(),
        commentType: 'edit-request',
        editCategories: [],
        createdAt: new Date().toISOString()
      }];
    }
    return fallback;
  }
}

function isRequestOwnedByCurrentSession(request) {
  try {
    if (!request) return false;
    const role = (currentSession && currentSession.role) ? String(currentSession.role).toLowerCase() : '';
    if (role === 'qcag' || role === 'admin') {
      return true;
    }
    const reqOwner = typeof request.requester === 'object' && request.requester !== null
      ? request.requester
      : JSON.parse(request.requester || '{}');
    if (!currentSession) return false;
    const curCode = String(currentSession.saleCode || currentSession.userCode || '').trim().toLowerCase();
    const ownerCode = String(reqOwner.saleCode || reqOwner.userCode || '').trim().toLowerCase();
    if (curCode && ownerCode && curCode === ownerCode) return true;
    const curPhone = String(currentSession.phone || '').replace(/\D/g, '');
    const ownerPhone = String(reqOwner.phone || request.phone || '').replace(/\D/g, '');
    if (curPhone && ownerPhone && curPhone.length >= 9 && ownerPhone.length >= 9 && curPhone === ownerPhone) return true;
    return false;
  } catch (e) { return false; }
}

// ── Pending comment images (Sale Heineken) ────────────────────────────
let _detailCommentPendingImages = [];

function _renderDetailCommentPreview() {
  const previewEl = document.getElementById('detailCommentImgPreview');
  const sendBtn = document.getElementById('detailCommentSendBtn');
  const textarea = document.getElementById('detailCommentInput');
  if (!previewEl) return;
  if (_detailCommentPendingImages.length === 0) {
    previewEl.innerHTML = '';
    previewEl.classList.add('hidden');
    if (sendBtn && textarea) {
      const hasContent = textarea.value.trim().length > 0;
      sendBtn.classList.toggle('has-text', hasContent);
      sendBtn.classList.toggle('is-active', hasContent);
    }
    setTimeout(updateEditFabPosition, 30);
    return;
  }
  previewEl.classList.remove('hidden');
  previewEl.innerHTML = _detailCommentPendingImages.map((src, i) =>
    `<div class="qcag-preview-item chat-preview-item">` +
    `<img src="${src}" class="chat-preview-thumb">` +
    `<button type="button" onclick="_removeDetailCommentImage(${i})" class="chat-preview-del" title="Xóa ảnh">` +
    `<svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"/></svg>` +
    `</button>` +
    `</div>`
  ).join('');
  if (sendBtn) {
    sendBtn.classList.add('has-text');
    sendBtn.classList.add('is-active');
  }
  setTimeout(updateEditFabPosition, 30);
}

function _removeDetailCommentImage(index) {
  _detailCommentPendingImages.splice(index, 1);
  _renderDetailCommentPreview();
}

function onDetailChatInputChanged(textarea) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  const sendBtn = document.getElementById('detailCommentSendBtn');
  if (sendBtn) {
    const hasContent = textarea.value.trim().length > 0 || (_detailCommentPendingImages && _detailCommentPendingImages.length > 0);
    sendBtn.classList.toggle('has-text', hasContent);
    sendBtn.classList.toggle('is-active', hasContent);
  }
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

// ── Helper: Gửi ghi chú nguyên tử lên /notes 3NF (Zero Race-Condition) ─────
async function _sendNoteToBackend(backendId, noteData) {
  try {
    const base = (window.dataSdk && window.dataSdk._baseUrl) || '';
    const resp = await fetch(base + '/api/ks/requests/' + encodeURIComponent(backendId) + '/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteData)
    });
    const res = await resp.json();
    if (res && res.ok) return { ok: true, data: res.data };
  } catch (e) {
    console.warn('[notes API fallback to SDK]', e);
  }
  return { ok: false };
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
  let comments = safeParseComments(
    (currentDetailRequest && currentDetailRequest.__backendId === backendId && currentDetailRequest.comments)
      ? currentDetailRequest.comments
      : request.comments,
    []
  );

  const authorRole = (currentSession && currentSession.role) || 'heineken';
  let authorName = (currentSession && (currentSession.saleName || currentSession.name || currentSession.phone)) || '';
  if (!authorName) {
    const reqObj = (() => { try { return JSON.parse(request.requester || '{}'); } catch (_) { return {}; } })();
    authorName = reqObj.saleName || reqObj.name || reqObj.phone || request.createdByName || (authorRole === 'qcag' ? 'QCAG' : 'Sale');
  }

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
  const nowIso = new Date().toISOString();

  // 1. Gửi ghi chú nguyên tử tới 3NF notes API (chỉ gửi tin nhắn mới < 300 bytes)
  const noteRes = await _sendNoteToBackend(backendId, {
    text: text,
    authorName: authorName,
    authorRole: authorRole,
    noteType: 'comment',
    images: uploadedImgs
  });

  // 2. Fallback sang SDK chỉ khi direct note post thất bại
  if (!noteRes.ok && window.dataSdk) {
    await window.dataSdk.update({
      __backendId: request.__backendId,
      comments: commentsJson,
      updatedAt: nowIso
    });
  }

  const idx = allRequests.findIndex(r => r.__backendId === backendId);
  if (idx !== -1) { Object.assign(allRequests[idx], { comments: commentsJson, updatedAt: nowIso }); }
  if (currentDetailRequest && currentDetailRequest.__backendId === backendId) {
    Object.assign(currentDetailRequest, { comments: commentsJson, updatedAt: nowIso });
  }
  saveAllRequestsToStorage();

  hideLoadingOverlay();
  showToast('Đã gửi bình luận');

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
  textarea.style.height = 'auto';
  _detailCommentPendingImages = [];
  _renderDetailCommentPreview();
  const sendBtn = document.getElementById('detailCommentSendBtn');
  if (sendBtn) {
    sendBtn.classList.remove('has-text');
    sendBtn.classList.remove('is-active');
  }

  const request = allRequests[reqIdx];
  let comments = safeParseComments(
    (currentDetailRequest && currentDetailRequest.__backendId === backendId && currentDetailRequest.comments)
      ? currentDetailRequest.comments
      : request.comments,
    []
  );

  const authorRole = (currentSession && currentSession.role) || 'heineken';
  let authorName = (currentSession && (currentSession.saleName || currentSession.name || currentSession.phone)) || '';
  if (!authorName) {
    const reqObj = (() => { try { return JSON.parse(request.requester || '{}'); } catch (_) { return {}; } })();
    authorName = reqObj.saleName || reqObj.name || reqObj.phone || request.createdByName || (authorRole === 'qcag' ? 'QCAG' : 'Sale');
  }

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
  const nowIso = new Date().toISOString();

  // 1. Gửi ghi chú nguyên tử tới 3NF notes API (chỉ gửi tin nhắn mới < 300 bytes)
  const noteRes = await _sendNoteToBackend(backendId, {
    text: text,
    authorName: authorName,
    authorRole: authorRole,
    noteType: 'comment',
    images: uploadedImgs
  });

  // 2. Fallback sang SDK chỉ khi direct note post thất bại
  if (!noteRes.ok && window.dataSdk) {
    await window.dataSdk.update({
      __backendId: request.__backendId,
      comments: commentsJson,
      updatedAt: nowIso
    });
  }

  const idx = allRequests.findIndex(r => r.__backendId === backendId);
  if (idx !== -1) { Object.assign(allRequests[idx], { comments: commentsJson, updatedAt: nowIso }); }
  if (currentDetailRequest && currentDetailRequest.__backendId === backendId) {
    Object.assign(currentDetailRequest, { comments: commentsJson, updatedAt: nowIso });
  }
  saveAllRequestsToStorage();

  hideLoadingOverlay();
  showToast('Đã gửi bình luận');

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
}

// ── Heineken MQ quick-jump hint ──────────────────────────────────────

// Đã loại bỏ nút Xem MQ trôi nổi và logic tự cuộn để tránh giật màn hình

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
  const _safeArray = val => {
    if (Array.isArray(val)) return val;
    if (!val || typeof val !== 'string') return [];
    try { const parsed = JSON.parse(val); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; }
  };
  const rawItems = _safeArray(request2.items);
  const items = rawItems;
  const statusImgs = _safeArray(request2.statusImages);
  const designImgs = _safeArray(request2.designImages);
  const acceptanceImgs = _safeArray(request2.acceptanceImages);
  const oldContentImgs = _safeArray(request2.oldContentImages);
  const date = new Date(request.createdAt);

  const reqContentClean = (request2.content && typeof request2.content === 'string') ? request2.content.trim() : '';
  const hasActualContent = Boolean(reqContentClean && reqContentClean !== '[]' && reqContentClean !== '{}' && reqContentClean !== 'null' && reqContentClean !== 'undefined');
  const checkOldBool = val => val === true || val === 1 || String(val).toLowerCase() === 'true' || String(val) === '1';
  const hasExplicitOldContent = Boolean(
    checkOldBool(request2.oldContent) || checkOldBool(request2.old_content) ||
    checkOldBool(request2.isOldContent) || checkOldBool(request2.is_old_content) ||
    checkOldBool(request2.useOldContent) || checkOldBool(request2.use_old_content)
  );

  const scInfo = (typeof qcagResolveSignageContent === 'function')
    ? qcagResolveSignageContent(request2)
    : {
        hasSignage: Array.isArray(items) && items.length > 0,
        hasSignageContent: hasActualContent || hasExplicitOldContent,
        isOld: hasExplicitOldContent || (Array.isArray(items) && items.length > 0 && !hasActualContent),
        rawContent: reqContentClean,
        oldExtra: (request2.oldContentExtra || request2.old_content_extra || '').trim(),
        displayText: reqContentClean || 'Nội dung cũ',
        oldImgs: oldContentImgs
      };

  const isReqOldContent = scInfo.isOld;
  const isNonSignageEmpty = !scInfo.hasSignageContent;

  // Determine which requester info to show: use the stored request.requester only
  const parsedRequester = (() => { try { return JSON.parse(request.requester || 'null'); } catch (e) { return null; } })();
  const displayRequester = parsedRequester || null;
  const hasRequesterInfo = displayRequester && (displayRequester.saleName || displayRequester.saleCode || displayRequester.phone || displayRequester.role);
  const isMobile = (window.innerWidth || 0) < 768 || (typeof isQcagMobileMode === 'function' && isQcagMobileMode());
  let requesterHtml = '';
  if (hasRequesterInfo) {
    const rawRole = String(displayRequester.role || '').toLowerCase();
    const isQcagRequester = rawRole === 'qcag' && !displayRequester.saleName && !displayRequester.saleCode;
    const isHeinekenRequester = !isQcagRequester; // Tất cả các yêu cầu tạo bởi Sale/Sales/Heineken hoặc có thông tin Sale
    const pos = displayRequester.isTBA ? 'TBA' : 'Sale';
    const regionVal = displayRequester.region || request.region || '';
    const regionStr = (typeof qcagFormatRegionDisplay === 'function' ? qcagFormatRegionDisplay(regionVal) : regionVal) || '';
    const saleName = displayRequester.saleName || displayRequester.name || request.createdByName || '';
    const saleCode = displayRequester.saleCode || request.saleCode || '';
    const phone = displayRequester.phone || request.phone || '';
    const ssName = displayRequester.ssName || request.ssName || '';
    const ssCode = displayRequester.ssCode || request.ssCode || '';
    const ssText = ssName ? `${ssName}${ssCode ? ` (${ssCode})` : ''}` : '';
    // Chỗ chữ Sale/Sales hiển thị tên Khu vực mà Sale đã chọn theo đúng chuẩn tham khảo
    const badgeText = regionStr || pos;
    const ssLineDesktop = ssText ? `<div class="truncate"><span class="text-gray-500">SS/SE:</span> <span class="font-medium">${escapeHtml(ssText)}</span></div>` : '';

    if (isMobile) {
      if (isHeinekenRequester) {
        requesterHtml = `
          <div class="bg-gray-50 rounded-xl p-4 hk-requester-card">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-medium">Người yêu cầu</h3>
              <span class="hk-requester-badge">${escapeHtml(badgeText)}</span>
            </div>
            <div class="space-y-2 text-sm">
              <div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">Tên Sale:</span> <span class="hk-field-val font-semibold">${escapeHtml(saleName || '-')}</span></div>
              ${saleCode ? `<div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">Mã Sale:</span> <span class="hk-field-val font-semibold">${escapeHtml(saleCode)}</span></div>` : ''}
              ${phone ? `<div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">SĐT:</span> <span class="hk-field-val font-semibold">${escapeHtml(phone)}</span></div>` : ''}
              ${ssText ? `<div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">SS/SE:</span> <span class="hk-field-val font-semibold">${escapeHtml(ssText)}</span></div>` : ''}
            </div>
          </div>`;
      } else if (isQcagRequester) {
        requesterHtml = `
          <div class="bg-gray-50 rounded-xl p-4 hk-requester-card">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-medium">Người yêu cầu</h3>
              <span class="hk-requester-badge">QCAG</span>
            </div>
            <div class="space-y-2 text-sm">
              <div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">Vai trò:</span> <span class="hk-field-val font-semibold">QCAG</span></div>
              ${phone ? `<div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">SĐT:</span> <span class="hk-field-val font-semibold">${escapeHtml(phone)}</span></div>` : ''}
            </div>
          </div>`;
      } else {
        requesterHtml = `
          <div class="bg-gray-50 rounded-xl p-4 hk-requester-card">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-medium">Người yêu cầu</h3>
              <span class="hk-requester-badge">${escapeHtml(badgeText)}</span>
            </div>
            <div class="space-y-2 text-sm">
              <div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">Tên:</span> <span class="hk-field-val font-semibold">${escapeHtml(saleName || phone || '')}</span></div>
              ${saleCode ? `<div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">Mã:</span> <span class="hk-field-val font-semibold">${escapeHtml(saleCode)}</span></div>` : ''}
              ${phone ? `<div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">SĐT:</span> <span class="hk-field-val font-semibold">${escapeHtml(phone)}</span></div>` : ''}
              ${ssText ? `<div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">SS/SE:</span> <span class="hk-field-val font-semibold">${escapeHtml(ssText)}</span></div>` : ''}
            </div>
          </div>`;
      }
    } else {
      // desktop: two-column grid
      if (isHeinekenRequester) {
        requesterHtml = `
          <div class="hk-detail-card hk-requester-card rounded-xl p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-medium flex items-center gap-2">
                <svg class="w-4 h-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                <span>Người yêu cầu</span>
              </h3>
              <span class="hk-requester-badge">${escapeHtml(badgeText)}</span>
            </div>
            <div class="grid grid-cols-2 gap-2.5 text-sm">
              <div class="truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">Tên Sale:</span> <span class="font-semibold text-gray-900 dark:text-gray-100">${escapeHtml(saleName || '-')}</span></div>
              <div class="truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">Mã Sale:</span> <span class="font-bold text-blue-600 dark:text-blue-400 font-mono">${escapeHtml(saleCode || '-')}</span></div>
              <div class="truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">SĐT:</span> <span class="font-semibold text-gray-800 dark:text-gray-200">${escapeHtml(phone || '-')}</span></div>
              <div class="truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">Khu vực:</span> <span class="font-medium text-gray-700 dark:text-gray-300">${escapeHtml(regionStr || '-')}</span></div>
              <div class="truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">Chức vụ:</span> <span class="font-medium text-gray-700 dark:text-gray-300">${escapeHtml(pos)}</span></div>
              ${ssLineDesktop}
            </div>
          </div>`;
      } else if (isQcagRequester) {
        requesterHtml = `
          <div class="hk-detail-card hk-requester-card rounded-xl p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-medium flex items-center gap-2">
                <svg class="w-4 h-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                <span>Người yêu cầu</span>
              </h3>
              <span class="hk-requester-badge">QCAG</span>
            </div>
            <div class="text-sm"><span class="text-gray-500 dark:text-gray-400 font-medium">QCAG</span> — <span class="font-medium text-gray-900 dark:text-gray-100">${escapeHtml(phone || '-')}</span></div>
          </div>`;
      } else {
        requesterHtml = `
          <div class="hk-detail-card hk-requester-card rounded-xl p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-medium flex items-center gap-2">
                <svg class="w-4 h-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                <span>Người yêu cầu</span>
              </h3>
              <span class="hk-requester-badge">${escapeHtml(badgeText)}</span>
            </div>
            <div class="grid grid-cols-2 gap-2.5 text-sm">
              <div class="truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">Tên/Phone:</span> <span class="font-semibold text-gray-900 dark:text-gray-100">${escapeHtml(saleName || phone)}</span></div>
              <div class="truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">Mã:</span> <span class="font-bold text-blue-600 dark:text-blue-400 font-mono">${escapeHtml(saleCode || '-')}</span></div>
              ${ssLineDesktop}
            </div>
          </div>`;
      }
    }
  }
  else {
    // Show placeholder when creator info is missing instead of hiding the whole block
    requesterHtml = `
      <div class="hk-detail-card hk-requester-card rounded-xl p-4">
        <h3 class="font-medium mb-3 flex items-center gap-2 text-gray-900 dark:text-gray-100">
          <svg class="w-4 h-4 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
          <span>Người yêu cầu</span>
        </h3>
        <div class="text-sm text-gray-500 dark:text-gray-400">Không xác định</div>
      </div>`;
  }

  let comments = safeParseComments(request2.comments, []);
  const mobileTabsHtml = isMobile ? `
    <div id="mobileTabsBar" class="mobile-tabs-sticky">
      <button id="mobileTabDetailBtn" class="mobile-tab-btn active" onclick="switchDetailMobileTab('detail')">Chi Tiết</button>
      <button id="mobileTabCommentBtn" class="mobile-tab-btn" onclick="switchDetailMobileTab('comment')">Bình Luận<span id="mobileCommentBadge" class="mobile-tab-badge">${comments.length}</span></button>
    </div>
  ` : '';

  let deletePendingBannerHtml = '';
  if (request2.deleteRequested) {
    const delTimeStr = request2.deleteRequestedAt ? new Date(request2.deleteRequestedAt).toLocaleString('vi-VN') : '';
    deletePendingBannerHtml = `
      <div class="hk-delete-pending-banner">
        <div class="hk-delete-pending-header">
          <div class="hk-delete-pending-title">Đang chờ QCAG duyệt xóa</div>
          <button type="button" onclick="cancelDeleteRequest()" class="hk-delete-cancel-btn">✕ Hủy yêu cầu</button>
        </div>
        ${delTimeStr ? `<div class="hk-delete-pending-time">Gửi lúc: ${escapeHtml(delTimeStr)}</div>` : ''}
        <div class="hk-delete-pending-reason"><strong>Lý do:</strong> ${escapeHtml(request2.deleteReason || 'Không có')}</div>
      </div>
    `;
  }

  let mainContentHtml = '';

  if (isMobile) {
    // ── MOBILE LAYOUT: Dải thẻ xếp dọc gọn nhẹ ──
    const designPrimaryImg = (Array.isArray(designImgs) && designImgs.length > 0) ? designImgs[0] : '';
    mainContentHtml = `
      <div class="space-y-4">
        ${deletePendingBannerHtml}
        ${requesterHtml}
        <div class="bg-gray-50 rounded-xl p-4 hk-outlet-card">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-medium">Thông tin Outlet</h3>
            ${(request.outletLat && request.outletLng) ? `
              <button type="button" onclick="openSavedLocation(${request.outletLat},${request.outletLng})" class="hk-detail-loc-btn" title="Xem trên Google Maps">
                <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                <span>Xem vị trí</span>
              </button>
            ` : ''}
          </div>
          <div class="space-y-2 text-sm">
            <div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">Mã Outlet:</span> <span class="hk-field-val font-bold">${escapeHtml(request.outletCode || '---')}</span></div>
            <div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">Tên:</span> <span class="hk-field-val font-semibold uppercase">${escapeHtml(request.outletName || '')}</span></div>
            <div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px] flex-shrink-0">Địa chỉ:</span> <span class="hk-field-val font-medium">${escapeHtml(request.address || '')}</span></div>
            <div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">SĐT:</span> <span class="hk-field-val font-semibold">${escapeHtml(request.phone || '-')}</span></div>
            <div class="flex items-baseline gap-2"><span class="hk-field-label text-gray-500 min-w-[75px]">Ngày tạo:</span> <span class="hk-field-val font-medium">${date.toLocaleDateString('vi-VN')}</span></div>
          </div>
        </div>

        ${request.type === 'new' && items.length > 0 ? `
          <div class="bg-gray-50 rounded-xl p-4 hk-items-card">
            <h3 class="font-medium mb-3 hk-items-header">Hạng mục yêu cầu <span class="text-gray-500 text-sm hk-items-count">(${items.length})</span></h3>
            <div class="w-full">
              <div class="space-y-3 hk-items-mobile-list">
                ${items.map((item, idx) => {
                  const isOther = item.type === 'Hạng mục khác' || String(item.type || '').toLowerCase().includes('khác');
                  const requestText = isOther ? (item.otherContent || item.other_content || '') : (item.note || item.notes || '');
                  return `
                    <div class="hk-item-box rounded-xl p-3">
                      <div class="flex items-start justify-between">
                        <div class="flex-1">
                          <div class="flex items-center justify-between">
                            <div class="hk-item-title text-sm font-medium"><span class="hk-item-seq">${idx + 1}.</span> ${escapeHtml(getItemDisplayName(item))}</div>
                            <div class="hk-pole-badge">${item.poles ? (item.poles + ' trụ') : '0 trụ'}</div>
                          </div>
                          <div class="hk-item-grid mt-2 text-sm text-gray-600 grid grid-cols-2 gap-2">
                            <div><span class="hk-item-label text-gray-500 text-xs">Brand</span><div class="hk-item-val font-medium">${!isOther ? (item.brand || '-') : '-'}</div></div>
                            <div><span class="hk-item-label text-gray-500 text-xs">Hình thức</span><div class="hk-item-val font-medium">${!isOther ? (item.action || '-') : '-'}</div></div>
                            <div><span class="hk-item-label text-gray-500 text-xs">Kích thước</span><div class="hk-item-val font-medium">${!isOther ? (item.survey ? `<span class="qcag-survey-badge">Khảo sát</span>` : (item.useOldSize ? '<span class="qcag-oldsize-badge">KT cũ</span>' : (typeof qcagFormatDimensionText === 'function' ? qcagFormatDimensionText(item.width, item.height) : `${parseFloat(item.width) || item.width}m x ${parseFloat(item.height) || item.height}m`))) : '-'}</div></div>
                            <div><span class="hk-item-label text-gray-500 text-xs">Yêu cầu</span><div class="hk-item-val text-sm text-gray-600">${requestText ? escapeHtml(requestText) : '-'}</div></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          </div>

          <div class="bg-gray-50 dark:bg-slate-800/60 rounded-xl p-4 border border-gray-200 dark:border-slate-700/60">
            <div class="flex items-center justify-between mb-2">
              <h3 class="font-medium text-gray-900 dark:text-gray-100">Nội dung bảng hiệu</h3>
            </div>
            ${(() => {
              if (scInfo.hasSignageContent) {
                let inner = '';
                if (scInfo.isOld) {
                  inner += `
                    <div class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-500 dark:text-amber-400 border border-amber-500/40 text-xs font-semibold mb-2">
                      <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      <span>Nội dung cũ</span>
                    </div>`;
                  if (scInfo.oldExtra) {
                    inner += `<div class="text-xs text-amber-600 dark:text-amber-300 font-medium mb-1.5">Yêu cầu thêm: ${escapeHtml(scInfo.oldExtra)}</div>`;
                  }
                  if (scInfo.rawContent) {
                    inner += `<p class="text-sm whitespace-pre-wrap font-medium text-gray-800 dark:text-gray-100 mb-2">${escapeHtml(scInfo.rawContent)}</p>`;
                  }
                  if (scInfo.oldImgs && scInfo.oldImgs.length > 0) {
                    inner += `
                      <div class="flex flex-wrap gap-2 mt-2">
                        ${scInfo.oldImgs.map(img => `<img src="${img}" class="w-20 h-20 object-cover rounded-lg cursor-pointer" onclick="showImageFull(this.src, false)">`).join('')}
                      </div>`;
                  }
                } else {
                  inner = `<p class="text-sm whitespace-pre-wrap font-medium text-gray-800 dark:text-gray-100">${escapeHtml(scInfo.rawContent)}</p>`;
                }
                return inner;
              }
              return `<p class="text-sm whitespace-pre-wrap text-gray-400 dark:text-gray-500 italic">Hạng mục này không có nội dung</p>`;
            })()}
          </div>
        ` : ''}

        ${request.type === 'warranty' ? `
          <div class="bg-gray-50 rounded-xl p-4">
            <h3 class="font-medium mb-3">Nội dung yêu cầu bảo hành</h3>
            <p class="text-sm">${request.content}</p>
          </div>
        ` : ''}

        <div class="bg-gray-50 rounded-xl p-4">
          <h3 class="font-medium mb-3">Ảnh hiện trạng</h3>
          ${statusImgs.length > 0 ? `
            <div class="flex flex-wrap gap-2">
              ${statusImgs.map(img => `<img src="${img}" class="w-20 h-20 object-cover rounded-lg cursor-pointer" onclick="showImageFull(this.src, false)" onerror="_imgBrokenFallback(this)">`).join('')}
            </div>
          ` : '<p class="text-sm text-gray-500">Chưa có ảnh</p>'}
        </div>

        ${request.type === 'new' ? `
          <div id="mqSection" class="bg-gray-50 rounded-xl p-4">
            <div class="flex items-center justify-between gap-3 mb-3">
              <div class="flex items-center gap-1.5 min-w-0">
                <h3 class="text-sm font-bold text-gray-900 mq-section-title truncate">Thiết kế Maquette</h3>
                ${designImgs.length > 1 ? `<span class="text-[11px] text-gray-400 font-mono flex-shrink-0">(${designImgs.length})</span>` : ''}
              </div>
              ${(currentSession && String(currentSession.role || '').toLowerCase() === 'heineken') ? `
                <button type="button" onclick="window._editRequestOrigin='detail'; openEditRequestSheet();" class="mq-edit-badge-btn flex-shrink-0" title="Gửi yêu cầu chỉnh sửa thiết kế tới QCAG">
                  <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                  <span>Yêu cầu chỉnh sửa</span>
                </button>
              ` : (designImgs.length > 0 ? `<span class="text-xs text-gray-500 font-medium flex-shrink-0">${designImgs.length} bản vẽ</span>` : '')}
            </div>

            ${designPrimaryImg ? (() => {
              const isPendingEdit = Boolean(request.editingRequestedAt || request.isPendingEdit || (typeof getRequestDesignState === 'function' && getRequestDesignState(request) === 'editing') || (typeof qcagDesktopIsPendingEditRequest === 'function' && qcagDesktopIsPendingEditRequest(request)));
              return `
              <div class="mq-display-card">
                <div class="mq-display-frame mq-thumb-editing-wrap" onclick="viewDesign('${request.__backendId}')" title="${isPendingEdit ? 'Đang chỉnh sửa - Nhấn để xem toàn màn hình' : 'Nhấn để xem toàn màn hình'}">
                  <img id="mqMainPreviewImg" src="${designPrimaryImg}" class="mq-display-img ${isPendingEdit ? 'mq-img-editing' : ''}" alt="Bản vẽ Maquette" onerror="_imgBrokenFallback(this)">
                  ${isPendingEdit ? `<span class="mq-editing-badge-overlay"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Đang chỉnh sửa</span>` : ''}
                </div>`;
            })() + `
                ${designImgs.length > 1 ? `
                  <div class="mq-thumbnails-row">
                    ${designImgs.map((img, idx) => `
                      <img src="${img}" onclick="event.stopPropagation(); document.getElementById('mqMainPreviewImg').src='${img}'; this.parentElement.querySelectorAll('img').forEach(el=>el.classList.remove('active')); this.classList.add('active');" class="mq-thumb-item ${idx === 0 ? 'active' : ''}" alt="Bản vẽ ${idx + 1}" onerror="_imgBrokenFallback(this)">
                    `).join('')}
                  </div>
                ` : ''}
              </div>
            ` : `
              <div class="mq-preview-empty-full">
                <svg class="w-7 h-7 text-gray-400 mb-1 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                <span class="mq-empty-title font-semibold text-xs text-gray-600">Chưa có bản vẽ thiết kế</span>
                <span class="mq-empty-sub text-[11px] text-gray-400 font-normal">QCAG đang xử lý maquette</span>
              </div>
            `}

            ${(currentSession && String(currentSession.role || '').toLowerCase() === 'heineken') ? '' :
            '<label class="w-full py-3 mt-3 border-2 border-dashed border-gray-300 rounded-xl text-gray-500 font-medium flex items-center justify-center gap-2 cursor-pointer active:bg-gray-100">\n          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">\n            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>\n          </svg>\n          Upload thiết kế\n          <input type="file" accept="image/*" multiple class="hidden" onchange="uploadDesign(this)">\n        </label>'}
          </div>
        ` : ''}

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
      </div>
    `;
  } else {
    // ── DESKTOP LAYOUT: LƯỚI 4 HÀNG ĐỐI XỨNG CÂN BẰNG (4-ROW BALANCED GRID) ──
    const designPrimaryImg = (Array.isArray(designImgs) && designImgs.length > 0) ? designImgs[0] : '';
    mainContentHtml = `
      <div class="space-y-4">
        ${deletePendingBannerHtml}

        <!-- HÀNG 1: Người yêu cầu (50%) & Thông tin Outlet (50%) -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          ${requesterHtml}
          <div class="hk-detail-card hk-outlet-card rounded-xl p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-medium flex items-center gap-2 text-gray-900 dark:text-gray-100">
                <svg class="w-4 h-4 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
                <span>Thông tin Outlet</span>
              </h3>
              ${(request.outletLat && request.outletLng) ? `
                <button type="button" onclick="openSavedLocation(${request.outletLat},${request.outletLng})" class="hk-detail-loc-btn" title="Xem trên Google Maps">
                  <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                  <span>Xem vị trí</span>
                </button>
              ` : ''}
            </div>
            <div class="grid grid-cols-2 gap-2.5 text-sm">
              <div class="truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">Outlet Code:</span> <span class="font-bold text-blue-600 dark:text-blue-400 font-mono">${escapeHtml(request.outletCode || '---')}</span></div>
              <div class="truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">Tên quán:</span> <span class="font-bold uppercase text-gray-900 dark:text-gray-100">${escapeHtml(request.outletName || '')}</span></div>
              <div class="truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">SĐT quán:</span> <span class="font-semibold text-gray-800 dark:text-gray-200">${escapeHtml(request.phone || request.outletPhone || '-')}</span></div>
              <div class="truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">Ngày tạo:</span> <span class="font-medium text-gray-700 dark:text-gray-300">${date.toLocaleDateString('vi-VN')}</span></div>
              <div class="col-span-2 truncate"><span class="text-gray-500 dark:text-gray-400 font-medium">Địa chỉ:</span> <span class="font-medium text-gray-800 dark:text-gray-200" title="${escapeHtml(request.address || '')}">${escapeHtml(request.address || '-')}</span></div>
            </div>
          </div>
        </div>

        <!-- HÀNG 2: Bảng Hạng mục yêu cầu Full Width -->
        ${request.type === 'new' && items.length > 0 ? `
          <div class="hk-detail-card hk-items-card rounded-xl p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="font-medium flex items-center gap-2 text-gray-900 dark:text-gray-100">
                <svg class="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
                <span>Hạng mục yêu cầu</span>
                <span class="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400 font-semibold font-mono">${items.length}</span>
              </h3>
            </div>
            <div class="overflow-x-auto rounded-lg border border-gray-200/80 dark:border-gray-800">
              <table class="hk-items-desktop-table w-full text-left border-collapse text-sm">
                <thead>
                  <tr class="border-b border-gray-200 dark:border-gray-700/60 text-xs uppercase font-bold text-gray-600 dark:text-gray-400 bg-gray-100/80 dark:bg-gray-800/60">
                    <th class="py-2.5 px-3 w-12 text-center">STT</th>
                    <th class="py-2.5 px-3">Hạng mục</th>
                    <th class="py-2.5 px-3">Brand</th>
                    <th class="py-2.5 px-3">Hình thức</th>
                    <th class="py-2.5 px-3 text-center">Số trụ</th>
                    <th class="py-2.5 px-3">Kích thước</th>
                    <th class="py-2.5 px-3">Yêu cầu / Ghi chú</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 dark:divide-gray-800/60 font-medium">
                  ${items.map((item, idx) => {
                    const isOther = item.type === 'Hạng mục khác' || String(item.type || '').toLowerCase().includes('khác');
                    const brandText = !isOther ? (item.brand || '-') : '-';
                    const actionText = !isOther ? (item.action || '-') : '-';
                    const polesText = !isOther ? (item.poles ? (item.poles + ' trụ') : '0 trụ') : '-';
                    const sizeHtml = !isOther ? (item.survey ? `<span class="qcag-survey-badge">Khảo sát</span>` : (item.useOldSize ? '<span class="qcag-oldsize-badge">KT cũ</span>' : `<span class="font-mono text-xs font-semibold">${typeof qcagFormatDimensionText === 'function' ? qcagFormatDimensionText(item.width, item.height) : `${parseFloat(item.width) || item.width}m x ${parseFloat(item.height) || item.height}m`}</span>`)) : '-';
                    const reqNote = isOther ? (item.otherContent || item.other_content || '-') : (item.note || item.notes || '-');
                    return `
                      <tr class="hover:bg-gray-50/80 dark:hover:bg-gray-800/40 transition-colors">
                        <td class="py-2.5 px-3 text-center text-gray-400 font-mono">${idx + 1}</td>
                        <td class="py-2.5 px-3 font-semibold text-gray-900 dark:text-gray-100">${escapeHtml(getItemDisplayName(item))}</td>
                        <td class="py-2.5 px-3"><span class="hk-brand-badge">${escapeHtml(brandText)}</span></td>
                        <td class="py-2.5 px-3 text-gray-600 dark:text-gray-300">${escapeHtml(actionText)}</td>
                        <td class="py-2.5 px-3 text-center text-gray-600 dark:text-gray-300 font-mono">${escapeHtml(polesText)}</td>
                        <td class="py-2.5 px-3 text-gray-900 dark:text-gray-100">${sizeHtml}</td>
                        <td class="py-2.5 px-3 text-gray-600 dark:text-gray-300 max-w-xs truncate" title="${escapeHtml(reqNote)}">${escapeHtml(reqNote)}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}

        ${request.type === 'warranty' ? `
          <div class="hk-detail-card rounded-xl p-4">
            <h3 class="font-medium mb-3 flex items-center gap-2 text-gray-900 dark:text-gray-100">
              <svg class="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
              <span>Nội dung yêu cầu bảo hành</span>
            </h3>
            <p class="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">${escapeHtml(request.content || '')}</p>
          </div>
        ` : ''}

        <!-- HÀNG 3: Báo giá QCAG (50%) & Nội dung bảng hiệu (50%) -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div id="quoteBridgeSection" class="hk-detail-card quote-bridge-section rounded-xl p-4 cursor-pointer">
            <div class="quote-bridge-head flex items-center justify-between mb-3">
              <div class="quote-bridge-head-left flex items-center gap-2">
                <svg class="w-4 h-4 quote-bridge-icon text-sky-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                <h3 class="font-medium quote-bridge-title text-sky-950 dark:text-sky-200">Báo giá QCAG</h3>
              </div>
              <div id="quoteBridgeHeadMeta" class="quote-bridge-head-meta"></div>
            </div>
            <div id="quoteBridgeContent" class="text-sm quote-bridge-content">Đang tải...</div>
          </div>

          <div class="hk-detail-card rounded-xl p-4">
            <div class="flex items-center justify-between mb-2">
              <h3 class="font-medium flex items-center gap-2 text-gray-900 dark:text-gray-100">
                <svg class="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                <span>Nội dung bảng hiệu</span>
              </h3>
            </div>
            ${(() => {
              if (scInfo.hasSignageContent) {
                let inner = '';
                if (scInfo.isOld) {
                  inner += `
                    <div class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-500 dark:text-amber-400 border border-amber-500/40 text-xs font-semibold mb-2">
                      <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      <span>Nội dung cũ</span>
                    </div>`;
                  if (scInfo.oldExtra) {
                    inner += `<div class="text-xs text-amber-600 dark:text-amber-300 font-medium mb-1.5">Yêu cầu thêm: ${escapeHtml(scInfo.oldExtra)}</div>`;
                  }
                  if (scInfo.rawContent) {
                    inner += `<div class="text-sm leading-relaxed whitespace-pre-wrap font-medium text-gray-800 dark:text-gray-100 mb-2">${escapeHtml(scInfo.rawContent)}</div>`;
                  }
                  if (scInfo.oldImgs && scInfo.oldImgs.length > 0) {
                    inner += `
                      <div class="flex flex-wrap gap-2 mt-2">
                        ${scInfo.oldImgs.map(img => `<img src="${img}" class="w-16 h-16 object-cover rounded-lg cursor-pointer border border-gray-200 dark:border-gray-700 hover:opacity-80 transition-opacity" onclick="showImageFull(this.src, false)">`).join('')}
                      </div>`;
                  }
                } else {
                  inner = `<div class="text-sm leading-relaxed whitespace-pre-wrap text-gray-800 dark:text-gray-100">${escapeHtml(scInfo.rawContent)}</div>`;
                }
                return inner;
              }
              return `<div class="text-sm leading-relaxed whitespace-pre-wrap text-gray-400 dark:text-gray-500 italic">Hạng mục này không có nội dung</div>`;
            })()}
          </div>
        </div>

        <!-- HÀNG 4: MQ Thiết kế (50%) & Ảnh hiện trạng (50%) -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div id="mqSection" class="hk-detail-card rounded-xl p-4 flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between gap-3 mb-3">
                <div class="flex items-center gap-1.5 min-w-0">
                  <svg class="w-4 h-4 text-indigo-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                  <h3 class="text-sm font-bold text-gray-900 dark:text-gray-100 mq-section-title truncate">Thiết kế Maquette</h3>
                  ${designImgs.length > 1 ? `<span class="text-[11px] text-gray-400 font-mono flex-shrink-0">(${designImgs.length})</span>` : ''}
                </div>
                ${(currentSession && String(currentSession.role || '').toLowerCase() === 'heineken') ? `
                  <button type="button" onclick="window._editRequestOrigin='detail'; openEditRequestSheet();" class="mq-edit-badge-btn flex-shrink-0" title="Gửi yêu cầu chỉnh sửa thiết kế tới QCAG">
                    <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                    <span>Yêu cầu chỉnh sửa</span>
                  </button>
                ` : (designImgs.length > 0 ? `<span class="text-xs text-gray-500 font-medium flex-shrink-0">${designImgs.length} bản vẽ</span>` : '')}
              </div>

              ${designPrimaryImg ? (() => {
                const isPendingEdit = Boolean(request.editingRequestedAt || request.isPendingEdit || (typeof getRequestDesignState === 'function' && getRequestDesignState(request) === 'editing') || (typeof qcagDesktopIsPendingEditRequest === 'function' && qcagDesktopIsPendingEditRequest(request)));
                return `
                <div class="mq-display-card">
                  <div class="mq-display-frame mq-thumb-editing-wrap cursor-pointer" onclick="viewDesign('${request.__backendId}')" title="${isPendingEdit ? 'Đang chỉnh sửa - Nhấn để xem toàn màn hình' : 'Nhấn để xem toàn màn hình'}">
                    <img id="mqMainPreviewImg" src="${designPrimaryImg}" class="mq-display-img object-contain w-full h-[220px] rounded-lg bg-black/40 ${isPendingEdit ? 'mq-img-editing' : ''}" alt="Bản vẽ Maquette" onerror="_imgBrokenFallback(this)">
                    ${isPendingEdit ? `<span class="mq-editing-badge-overlay"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Đang chỉnh sửa</span>` : ''}
                  </div>`;
              })() + `
                  ${designImgs.length > 1 ? `
                    <div class="mq-thumbnails-row mt-2 flex gap-2 overflow-x-auto pb-1">
                      ${designImgs.map((img, idx) => `
                        <img src="${img}" onclick="event.stopPropagation(); document.getElementById('mqMainPreviewImg').src='${img}'; this.parentElement.querySelectorAll('img').forEach(el=>el.classList.remove('active')); this.classList.add('active');" class="mq-thumb-item w-12 h-12 rounded object-cover cursor-pointer border ${idx === 0 ? 'border-blue-500 ring-2 ring-blue-500/30' : 'border-gray-200 dark:border-gray-700'}" alt="Bản vẽ ${idx + 1}" onerror="_imgBrokenFallback(this)">
                      `).join('')}
                    </div>
                  ` : ''}
                </div>
              ` : `
                <div class="mq-preview-empty-full h-[220px] rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-800 flex flex-col items-center justify-center p-4">
                  <svg class="w-8 h-8 text-gray-400 mb-1 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                  <span class="mq-empty-title font-semibold text-xs text-gray-600 dark:text-gray-300">Chưa có bản vẽ thiết kế</span>
                  <span class="mq-empty-sub text-[11px] text-gray-400 font-normal">QCAG đang xử lý maquette</span>
                </div>
              `}
            </div>

            ${(currentSession && String(currentSession.role || '').toLowerCase() === 'heineken') ? '' :
            '<label class="w-full py-2.5 mt-3 border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 font-medium flex items-center justify-center gap-2 cursor-pointer transition-colors">\n      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>\n      Upload thiết kế\n      <input type="file" accept="image/*" multiple class="hidden" onchange="uploadDesign(this)">\n    </label>'}
          </div>

          <div class="hk-detail-card rounded-xl p-4 flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between mb-3">
                <h3 class="font-medium flex items-center gap-2 text-gray-900 dark:text-gray-100">
                  <svg class="w-4 h-4 text-emerald-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                  <span>Ảnh hiện trạng</span>
                  ${statusImgs.length > 0 ? `<span class="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400 font-semibold font-mono">(${statusImgs.length})</span>` : ''}
                </h3>
                ${statusImgs.length > 1 ? `<span class="text-xs text-blue-600 dark:text-blue-400 font-medium cursor-pointer hover:underline" onclick="showImageFull(${JSON.stringify(statusImgs).replace(/"/g, '&quot;')}, false, 0)">Xem tất cả (${statusImgs.length})</span>` : ''}
              </div>

              ${statusImgs.length > 0 ? `
                <div class="hk-status-preview-box relative rounded-lg overflow-hidden h-[220px] bg-black/40 cursor-pointer group" onclick="showImageFull(${JSON.stringify(statusImgs).replace(/"/g, '&quot;')}, false, 0)" title="Bấm để xem album ảnh phóng to">
                  <img src="${statusImgs[0]}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" alt="Ảnh hiện trạng" onerror="_imgBrokenFallback(this)">
                  ${statusImgs.length > 1 ? `
                    <div class="absolute bottom-2 right-2 px-2.5 py-1 rounded-md bg-black/70 text-white text-xs font-semibold backdrop-blur-sm flex items-center gap-1 shadow">
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                      <span>+${statusImgs.length - 1} ảnh</span>
                    </div>
                  ` : ''}
                </div>
              ` : `
                <div class="h-[220px] rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-800 flex flex-col items-center justify-center p-4">
                  <svg class="w-8 h-8 text-gray-400 mb-1 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                  <span class="text-xs text-gray-500 dark:text-gray-400 font-medium">Chưa có ảnh hiện trạng</span>
                </div>
              `}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  let html = `
    <div class="detail-two-col">
      <div class="detail-main">
        ${mainContentHtml}
      </div>
  `;

  // Comments column — Modern Chat Hub (Đồng bộ chuẩn Desktop QCAG)
  const _myRole = (currentSession && currentSession.role) || '';
  const _myName = (currentSession && (currentSession.saleName || currentSession.name || currentSession.phone)) || '';
  const _isQcagRole = String(_myRole).toLowerCase() === 'qcag';

  // Xác định tên đối tác hiển thị trên header chat
  let _chatPartnerName = '';
  if (_isQcagRole) {
    const reqObj = (() => { try { return JSON.parse(request2.requester || '{}'); } catch (_) { return {}; } })();
    _chatPartnerName = reqObj.saleName || reqObj.name || request2.createdByName || 'Sale Heineken';
  } else {
    _chatPartnerName = 'QCAG Thiết Kế';
  }

  const commentsListHtml = comments.length === 0
    ? `
      <div class="chat-empty-state">
        <div class="chat-empty-icon-wrap">
          <svg class="chat-empty-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
          </svg>
        </div>
        <div class="chat-empty-title">Chưa có trao đổi nào</div>
        <div class="chat-empty-desc">Gửi tin nhắn hoặc đính kèm ảnh để trao đổi trực tiếp giữa Heineken & QCAG</div>
      </div>
    `
    : (() => {
      let lastDateKey = '';
      return comments.map(c => {
        const rawAuthor = (c.authorName || '').trim();
        const rawRole = String(c.authorRole || '').toLowerCase();
        const cType = String(c.commentType || '').toLowerCase();
        const text = String(c.text || '').trim();

        // 1. Tin nhắn Hệ Thống
        const isSystem = (
          cType === 'system' ||
          rawRole === 'system' ||
          rawRole === 'hệ thống' ||
          rawAuthor.toLowerCase().includes('hệ thống') ||
          text.startsWith('[HỆ THỐNG]') ||
          text.startsWith('Hệ thống:')
        );

        const cDate = c.createdAt ? new Date(c.createdAt) : new Date();
        const dateTimeStr = !isNaN(cDate.getTime())
          ? `${String(cDate.getHours()).padStart(2, '0')}:${String(cDate.getMinutes()).padStart(2, '0')} ${String(cDate.getDate()).padStart(2, '0')}/${String(cDate.getMonth() + 1).padStart(2, '0')}/${cDate.getFullYear()}`
          : '';

        // Phân tách ngày (Date divider)
        let dateDividerHtml = '';
        const dateKey = !isNaN(cDate.getTime()) ? cDate.toDateString() : '';
        if (dateKey && dateKey !== lastDateKey) {
          lastDateKey = dateKey;
          const now = new Date();
          const isToday = cDate.toDateString() === now.toDateString();
          const yesterday = new Date(now);
          yesterday.setDate(yesterday.getDate() - 1);
          const isYesterday = cDate.toDateString() === yesterday.toDateString();
          let dateLabel = '';
          if (isToday) dateLabel = 'Hôm nay';
          else if (isYesterday) dateLabel = 'Hôm qua';
          else dateLabel = cDate.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
          dateDividerHtml = `<div class="qcag-chat-date-divider"><span>${dateLabel}</span></div>`;
        }

        if (isSystem) {
          let sysText = text.replace(/^\[HỆ THỐNG\]\s*/i, '').replace(/^Hệ thống:\s*/i, '').trim();
          let formattedSysHtml = escapeHtml(sysText);
          const dashMatch = sysText.match(/^(.*?sửa hạng mục\s*#?\d*.*?)\s*[—–-]\s*(.*)$/i);
          if (dashMatch) {
            const lead = dashMatch[1].trim();
            const rest = dashMatch[2].trim();
            const items = rest.split(';').map(s => s.trim()).filter(Boolean);
            if (items.length > 0) {
              formattedSysHtml = `
                <div class="qcag-sys-lead">${escapeHtml(lead)}:</div>
                <div class="qcag-sys-bullet-list">
                  ${items.map(it => `<div class="qcag-sys-bullet-row"><span class="qcag-sys-bullet">•</span><span class="qcag-sys-bullet-text">${escapeHtml(it)}</span></div>`).join('')}
                </div>
              `;
            }
          } else if (sysText.includes(';') && (sysText.toLowerCase().includes('hạng mục') || sysText.toLowerCase().includes('sửa'))) {
            const items = sysText.split(';').map(s => s.trim()).filter(Boolean);
            if (items.length > 1) {
              formattedSysHtml = `
                <div class="qcag-sys-bullet-list">
                  ${items.map(it => `<div class="qcag-sys-bullet-row"><span class="qcag-sys-bullet">•</span><span class="qcag-sys-bullet-text">${escapeHtml(it)}</span></div>`).join('')}
                </div>
              `;
            }
          }

          return dateDividerHtml + `
            <div class="qcag-chat-system-row">
              <div class="qcag-chat-system-card">
                <div class="qcag-sys-head">
                  <div class="qcag-sys-badge-wrap">
                    <svg class="qcag-sys-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                    <span class="qcag-sys-badge">Hệ Thống</span>
                  </div>
                  <span class="qcag-sys-time">${escapeHtml(dateTimeStr)}</span>
                </div>
                <div class="qcag-sys-text">${formattedSysHtml}</div>
              </div>
            </div>
          `;
        }

        // Nhận diện nhân sự QCAG vs Sale chính xác
        const authorLower = String(rawAuthor || '').toLowerCase().trim();
        const reqObj = (() => { try { return JSON.parse(request2.requester || '{}'); } catch (_) { return {}; } })();
        const reqSaleName = String(reqObj.saleName || reqObj.name || request2.createdByName || '').toLowerCase().trim();

        const isKnownQcagMember = (
          authorLower === 'phong' ||
          authorLower.includes('phong') ||
          authorLower.includes('trần huỳnh phong') ||
          authorLower.includes('đoàn minh thái') ||
          authorLower.includes('đòan minh thái') ||
          authorLower.includes('thanh hiển') ||
          authorLower.includes('nguyễn thanh hiển') ||
          authorLower.includes('võ thị mến') ||
          authorLower.includes('mến') ||
          authorLower.includes('mỹ linh') ||
          authorLower.includes('thảo võ') ||
          authorLower === 'thảo' ||
          authorLower.includes('qcag') ||
          authorLower.includes('designer') ||
          authorLower.includes('thiết kế')
        );

        let isQcagAuthor = false;
        if (reqSaleName && (authorLower === reqSaleName || authorLower.includes(reqSaleName) || reqSaleName.includes(authorLower))) {
          isQcagAuthor = false;
        } else if (rawRole === 'sale' || rawRole === 'heineken' || rawRole === 'sales') {
          isQcagAuthor = false;
        } else if (isKnownQcagMember) {
          isQcagAuthor = true;
        } else if (cType === 'edit-resolved' || /QCAG\s+(đã\s+)?chỉnh\s+sửa\s+xong/i.test(text)) {
          isQcagAuthor = true;
        } else {
          isQcagAuthor = false;
        }

        let isMine = false;
        if (_isQcagRole) {
          isMine = isQcagAuthor;
        } else {
          if (!isQcagAuthor) {
            if (_myName && (rawAuthor === _myName || String(rawAuthor).includes(_myName))) {
              isMine = true;
            } else if (!rawAuthor || rawAuthor === 'Sale Heineken' || rawAuthor === 'Người dùng' || rawAuthor === 'heineken') {
              isMine = true;
            }
          }
        }

        let displayName = rawAuthor;
        if (isQcagAuthor) {
          if (!displayName || displayName === 'QCAG' || displayName === 'unknown') {
            displayName = 'QCAG Thiết Kế';
          }
        } else {
          if (!displayName || displayName === 'Sale Heineken' || displayName === 'Người dùng' || displayName === 'heineken' || displayName === 'unknown') {
            displayName = reqObj.saleName || reqObj.name || request2.createdByName || 'Sale Heineken';
          }
        }

        const roleTag = isQcagAuthor ? 'QCAG Thiết Kế' : 'Sale Heineken';
        const roleCls = isQcagAuthor ? 'role-qcag' : 'role-sale';
        const images = Array.isArray(c.images) ? c.images.filter(Boolean) : [];
        const readBy = Array.isArray(c.readBy) ? c.readBy : [];
        const readText = isMine ? (readBy.length > 0 ? 'Đã đọc' : 'Chưa đọc') : '';

        // Phân loại Yêu Cầu Chỉnh Sửa vs Đã Chỉnh Sửa Xong
        const isEditResolved = isQcagAuthor && (cType === 'edit-resolved' || /QCAG\s+(đã\s+)?chỉnh\s+sửa\s+xong/i.test(text));
        const isEditRequest = (!isSystem && (cType === 'edit-request' || /^yêu\s+cầu\s+chỉnh\s+sửa/i.test(text)));

        // 2. Thẻ Yêu Cầu Sửa
        if (isEditRequest) {
          const catsArr = Array.isArray(c.editCategories) ? c.editCategories : [];
          let displayText = text;
          displayText = displayText.replace(/^Yêu\s+cầu\s+chỉnh\s+sửa\s+được\s+gửi\s+từ\s+[^\n\r]+[\n\r]*/i, '').trim();
          if (displayText.startsWith('Yêu cầu chỉnh sửa: ')) {
            displayText = displayText.slice('Yêu cầu chỉnh sửa: '.length).trim();
          } else if (displayText === 'Yêu cầu chỉnh sửa') {
            displayText = '';
          }
          const displayTextStr = escapeHtml(displayText);
          const catsHtml = catsArr.length > 0 ? `<div class="qcag-chat-edit-cats">${catsArr.map(ct => `<span class="qcag-chat-cat-tag">${escapeHtml(ct)}</span>`).join('')}</div>` : '';
          const imagesHtml = images.length > 0
            ? `<div class="qcag-chat-images-grid">${images.map(img => `<img src="${escapeHtml(img)}" alt="đính kèm" onclick="showImageFull(this.src,false)">`).join('')}</div>`
            : '';
          const editLabelText = isQcagAuthor ? 'QCAG yêu cầu sửa' : 'Sale yêu cầu sửa';
          const editRowSide = isMine ? 'is-mine' : 'is-other';

          return dateDividerHtml + `
            <div class="qcag-chat-msg-row ${editRowSide} is-edit-request">
              <div class="qcag-chat-bubble edit-request-card">
                <div class="qcag-chat-bubble-top">
                  <span class="qcag-chat-author-name">${escapeHtml(displayName)}</span>
                  <span class="qcag-chat-role-tag ${roleCls}">${escapeHtml(roleTag)}</span>
                </div>
                ${catsHtml}
                ${displayTextStr ? `<div class="qcag-chat-text">${displayTextStr}</div>` : ''}
                ${imagesHtml}
                <div class="qcag-chat-bubble-footer is-split">
                  <div class="qcag-chat-footer-status is-edit-request" title="${escapeHtml(editLabelText)}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                    <span>${escapeHtml(editLabelText)}</span>
                  </div>
                  <div class="qcag-chat-footer-right">
                    <span class="qcag-chat-bubble-time">${escapeHtml(dateTimeStr)}</span>
                    ${readText ? `<span class="qcag-chat-read-status">${escapeHtml(readText)}</span>` : ''}
                  </div>
                </div>
              </div>
            </div>
          `;
        }

        // 3. Thẻ Đã Chỉnh Sửa Xong
        if (isEditResolved) {
          const resolvedText = escapeHtml(text || 'QCAG đã chỉnh sửa xong theo yêu cầu của Sale Heineken.');
          return dateDividerHtml + `
            <div class="qcag-chat-msg-row ${isMine ? 'is-mine' : 'is-other'} is-edit-resolved">
              <div class="qcag-chat-bubble edit-resolved-card">
                <div class="qcag-chat-bubble-top">
                  <span class="qcag-chat-author-name">${escapeHtml(displayName)}</span>
                  <span class="qcag-chat-role-tag role-qcag">QCAG Thiết Kế</span>
                </div>
                <div class="qcag-chat-text">${resolvedText}</div>
                ${images.length > 0 ? `
                  <div class="qcag-chat-images-grid">
                    ${images.map(img => `<img src="${escapeHtml(img)}" alt="đính kèm" onclick="showImageFull(this.src,false)">`).join('')}
                  </div>
                ` : ''}
                <div class="qcag-chat-bubble-footer is-split">
                  <div class="qcag-chat-footer-status is-edit-resolved" title="Đã hoàn tất chỉnh sửa">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    <span>Đã chỉnh sửa</span>
                  </div>
                  <div class="qcag-chat-footer-right">
                    <span class="qcag-chat-bubble-time">${escapeHtml(dateTimeStr)}</span>
                    ${readText ? `<span class="qcag-chat-read-status">${escapeHtml(readText)}</span>` : ''}
                  </div>
                </div>
              </div>
            </div>
          `;
        }

        // 4. Thẻ Tin Nhắn Chat Thông Thường
        return dateDividerHtml + `
          <div class="qcag-chat-msg-row ${isMine ? 'is-mine' : 'is-other'}">
            <div class="qcag-chat-bubble">
              <div class="qcag-chat-bubble-top">
                <span class="qcag-chat-author-name">${escapeHtml(displayName)}</span>
                <span class="qcag-chat-role-tag ${roleCls}">${escapeHtml(roleTag)}</span>
              </div>
              <div class="qcag-chat-text">${escapeHtml(text)}</div>
              ${images.length > 0 ? `
                <div class="qcag-chat-images-grid">
                  ${images.map(img => `<img src="${escapeHtml(img)}" alt="đính kèm" onclick="showImageFull(this.src,false)">`).join('')}
                </div>
              ` : ''}
              <div class="qcag-chat-bubble-footer">
                <span class="qcag-chat-bubble-time">${escapeHtml(dateTimeStr)}</span>
                ${readText ? `<span class="qcag-chat-read-status">${escapeHtml(readText)}</span>` : ''}
              </div>
            </div>
          </div>
        `;
      }).join('');
    })();

  html += `
    <div class="detail-comments-col">
      <div class="qcag-chat-card">
        <div class="qcag-chat-head">
          <div class="qcag-chat-head-main">
            <div class="qcag-chat-head-icon" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
            </div>
            <div class="qcag-chat-head-meta">
              <span class="qcag-chat-head-title">Trao đổi Heineken ↔ QCAG</span>
              <span class="qcag-chat-head-sub">
                <span class="qcag-chat-online-dot"></span>
                <span class="qcag-chat-sale-name">${escapeHtml(_chatPartnerName)}</span>
                <span class="qcag-chat-sub-sep">•</span>
                <span class="qcag-chat-count-label">${comments.length} tin</span>
              </span>
            </div>
          </div>
          <span class="qcag-comments-count-badge">${comments.length}</span>
        </div>
        <div id="detailCommentsList" class="qcag-comment-timeline">
          ${commentsListHtml}
        </div>
        <div class="qcag-chat-input-wrap">
          <div class="qcag-chat-composer" id="detailChatComposer">
            <div id="detailCommentImgPreview" class="qcag-upload-preview hidden"></div>
            <textarea id="detailCommentInput" rows="1" placeholder="Nhập tin nhắn trao đổi... (Enter để gửi)" oninput="onDetailChatInputChanged(this); if(typeof updateEditFabPosition==='function')updateEditFabPosition();" onkeydown="if(event.key==='Enter'&&!event.shiftKey&&window.innerWidth>=768){event.preventDefault();addDetailComment('${request.__backendId}');}"></textarea>
            <div class="qcag-composer-bottom">
              <span class="qcag-composer-hint">Shift+Enter xuống dòng</span>
              <div class="qcag-composer-actions">
                <label class="qcag-attach-btn" title="Đính kèm ảnh">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
                  <input type="file" accept="image/*" multiple class="hidden" onchange="handleDetailCommentImagePick(this)">
                </label>
                <button id="detailCommentSendBtn" onclick="addDetailComment('${request.__backendId}')" class="qcag-send-plane-btn" type="button" title="Gửi tin nhắn (Enter)">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"></line>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  html += '</div>'; // close .detail-two-col
 
  const content = document.getElementById('detailContent');
  if (content) {
    content.innerHTML = html;
  }
  showScreen('detailScreen');

  // Update detail delete button and MQ edit buttons lock state
  try {
    _applyRequestLockUI(request2);
  } catch (_) { }

  // Đã di dời nút Yêu cầu chỉnh sửa lên header Maquette; xóa bỏ hoàn toàn nút bottom FAB khỏi DOM
  try {
    const fab = document.getElementById('editRequestFab');
    if (fab) fab.remove();
  } catch (e) { }

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

  // Tự động cuộn mượt xuống phần MQ thiết kế khi vào chi tiết (thay thế nút Xem MQ thủ công)
  if (isMobile) {
    setTimeout(() => {
      try {
        const detailContent = document.getElementById('detailContent');
        const target = document.getElementById('mqSection');
        if (target && detailContent && !detailContent.classList.contains('chat-mode')) {
          const hasMqImg = target.querySelector('.mq-preview-img, img');
          if (hasMqImg) {
            const top = target.getBoundingClientRect().top - detailContent.getBoundingClientRect().top + detailContent.scrollTop - 12;
            detailContent.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
          }
        }
      } catch (_) { }
    }, 260);
  }

  // Auto-scroll chat timeline to bottom on desktop & mobile
  setTimeout(() => {
    const list = document.getElementById('detailCommentsList');
    if (list) list.scrollTop = list.scrollHeight;
  }, 100);

  // Load bridge / quotation status asynchronously (non-blocking)
  _loadBridgeStatus(request.__backendId).catch(function () { });
}

// ── Bridge / Quotation status loader ─────────────────────────────────

const QUOTE_PERSISTENT_KEY = 'ks_qcag_quotes_persistent_cache';

window.__qcagQuoteListCache = window.__qcagQuoteListCache || null;
window.__qcagQuoteCacheTime = window.__qcagQuoteCacheTime || 0;
window.__qcagQuoteListLoaded = window.__qcagQuoteListLoaded || false;

/**
 * _resolveQcagStatus — Ánh xạ trạng thái QCAG theo đúng thuật toán computeQCAGStatus từ App 1.
 * Vòng đời: Chưa có báo giá -> Chưa có SPO -> Chờ Admin/ASM duyệt -> Chờ ra đơn hàng -> Đã ra đơn hàng -> Đang sản xuất -> Hoàn thành.
 */
function _resolveQcagStatus(q) {
  if (!q) return { label: 'Chưa có báo giá', cls: 'hk-status-badge hk-status-amber bg-amber-500/20 text-amber-300 border border-amber-500/40' };

  // Priority 0: Cancellation status
  const cancelSt = String(q.cancellation_status || q.cancellationStatus || '').toLowerCase().trim();
  if (cancelSt === 'requested') return { label: 'Báo hủy', cls: 'hk-status-badge hk-status-red bg-red-600/30 text-red-300 border border-red-500/50' };
  if (cancelSt === 'confirmed' || cancelSt === 'recreated') return { label: 'Chờ tạo đơn', cls: 'hk-status-badge hk-status-sky bg-sky-600/30 text-sky-300 border border-sky-500/50' };

  // Priority 1: Production Approval
  const prodAppr = String(q.production_approval_status || q.productionApprovalStatus || '').toLowerCase().trim();
  if (prodAppr === 'approved') return { label: 'Đã duyệt sản xuất', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
  if (prodAppr === 'rejected') return { label: 'Từ chối sản xuất', cls: 'hk-status-badge hk-status-red bg-red-600/30 text-red-300 border border-red-500/50' };
  if (prodAppr === 'pending' || prodAppr === 'pending_production') return { label: 'Chờ duyệt sản xuất', cls: 'hk-status-badge hk-status-sky bg-sky-600/30 text-sky-300 border border-sky-500/50' };

  // Priority 2: Explicit QCAG status from DB / UI
  const qcagStRaw = String(q.qcag_override_status || q.qcagOverrideStatus || q.qcag_status || q.qcagStatus || '').trim();
  const qcagStLower = qcagStRaw.toLowerCase();
  if (qcagStRaw) {
    if (qcagStLower.includes('tạm hủy') || qcagStLower.includes('tam huy')) return { label: 'Tạm Hủy', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };
    if (qcagStLower === 'hủy' || qcagStLower === 'huy' || qcagStLower.includes('báo hủy') || qcagStLower.includes('bao huy')) return { label: 'Báo hủy', cls: 'hk-status-badge hk-status-red bg-red-600/30 text-red-300 border border-red-500/50' };
    if (qcagStLower.includes('chờ tạo đơn') || qcagStLower.includes('cho tao don') || qcagStLower.includes('chờ đh') || qcagStLower.includes('cho dh')) return { label: 'Chờ tạo đơn', cls: 'hk-status-badge hk-status-sky bg-sky-600/30 text-sky-300 border border-sky-500/50' };
    if (qcagStLower.includes('thi công xong') || qcagStLower.includes('đã lắp đặt') || qcagStLower.includes('hoàn thành') || qcagStLower.includes('hoan thanh')) return { label: 'Hoàn thành', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
    if (qcagStLower.includes('đang sản xuất') || qcagStLower.includes('dang san xuat') || qcagStLower.includes('đang làm')) return { label: 'Đang sản xuất', cls: 'hk-status-badge hk-status-violet bg-violet-600/30 text-violet-300 border border-violet-500/50' };
    if (qcagStLower.includes('đã ra đơn') || qcagStLower.includes('da ra don')) return { label: 'Đã ra đơn hàng', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
    return { label: qcagStRaw, cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
  }

  // Priority 3: SPO Lifecycle (App 1 standard computeQCAGStatus)
  const spoNumber = String(q.spo_number || q.spoNumber || q.spo_no || q.spoNo || '').trim();
  const rawSpoStatus = String(q.spo_status || q.spoStatus || '').trim();
  const rs = rawSpoStatus.toLowerCase();
  const orderNumber = String(q.order_number || q.orderNumber || '').trim();
  const hasSpo = !!spoNumber;
  const hasOrder = !!orderNumber;

  if (!hasSpo) {
    return { label: 'Chưa có SPO', cls: 'hk-status-badge hk-status-slate bg-slate-600/30 text-slate-300 border border-slate-500/50' };
  }

  if (!rawSpoStatus) {
    return { label: 'Chưa cập nhật trạng thái', cls: 'hk-status-badge hk-status-slate bg-slate-600/30 text-slate-300 border border-slate-500/50' };
  }

  const HUY_STATUSES = [
    'sales rep rejected', 'sign maker rejected', 'sales admin rejected',
    'area sales manager rejected', 'sales admin cancelled',
    'sales supervisor cancelled', 'store keeper cancelled',
    'area sales manager cancelled', 'sales rep cancelled'
  ];
  if (HUY_STATUSES.includes(rs) || rs.includes('cancel') || rs.includes('reject') || rs.includes('từ chối') || rs.includes('hủy')) {
    if (hasOrder) return { label: 'Khẩn cấp', cls: 'hk-status-badge hk-status-red bg-red-600/30 text-red-300 border border-red-500/50' };
    return { label: 'Hủy', cls: 'hk-status-badge hk-status-red bg-red-600/30 text-red-300 border border-red-500/50' };
  }

  if (rs.includes('revised') || rs.includes('rivised') || rs.includes('sửa')) {
    if (!hasOrder) return { label: 'Chờ duyệt lại', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };
    return { label: 'Đang sửa SPO', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };
  }

  if (rs.includes('finish') || rs.includes('hoàn thành')) return { label: 'Hoàn thành', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
  if (rs === 'sales rep accepted' || rs.includes('sale đã nghiệm thu')) return { label: 'Sale đã nghiệm thu', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
  if (rs === 'sign maker installed signage' || rs.includes('chờ sale nghiệm thu')) return { label: 'Chờ sale nghiệm thu', cls: 'hk-status-badge hk-status-sky bg-sky-600/30 text-sky-300 border border-sky-500/50' };

  const isApprovedOrVariation = rs === 'area sales manager approved...' || rs.includes('checked variation') || rs.includes('approved') || rs.includes('duyệt');
  if (isApprovedOrVariation) {
    if (!hasOrder) return { label: 'Chờ ra đơn hàng', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };
    return { label: 'Đã ra đơn hàng', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
  }

  if (rs === 'sales supervisor verified') return { label: 'Chờ QCAG up MQ', cls: 'hk-status-badge hk-status-sky bg-sky-600/30 text-sky-300 border border-sky-500/50' };
  if (rs === 'sign maker checked marquette') return { label: 'Chờ Admin duyệt', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };
  if (rs === 'sales admin full checked') return { label: 'Chờ ASM duyệt', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };

  // Fallback to Sale confirmation or raw SPO status
  if (q.is_confirmed == 1 || q.isConfirmed == 1) return { label: 'Sale đã xác nhận', cls: 'hk-status-badge hk-status-blue bg-blue-600/30 text-blue-300 border border-blue-500/50' };
  if (rawSpoStatus) return { label: rawSpoStatus, cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };

  // Mặc định khi đã có báo giá nhưng chưa có SPO
  return { label: 'Chưa có SPO', cls: 'hk-status-badge hk-status-slate bg-slate-600/30 text-slate-300 border border-slate-500/50' };
}
window._resolveQcagStatus = _resolveQcagStatus;

/**
 * _checkRequestLockState — Kiểm tra trạng thái khóa của yêu cầu khảo sát theo vòng đời đơn hàng / sản xuất.
 * Khi yêu cầu đã ra đơn hàng, đang sản xuất, hoặc hoàn thành thi công:
 * -> Khóa nút xóa yêu cầu (không cho hủy tự do khi vật tư đã xuất)
 * -> Khóa nút yêu cầu chỉnh sửa Maquette (không cho sửa bản vẽ khi xưởng đã/đang làm theo bản vẽ cũ)
 */
function _checkRequestLockState(req) {
  if (!req) return { isLocked: false, isProduced: false, orderNo: '', label: '', reason: '' };

  // 1. Nếu đang chờ duyệt xóa
  if (req.deleteRequested) {
    return { isLocked: true, isDeletePending: true, isProduced: false, orderNo: '', label: 'Chờ xóa', reason: 'Yêu cầu đang chờ QCAG duyệt xóa' };
  }

  // 2. Tìm quote tương ứng
  const matches = (q) => {
    if (!q) return false;
    const qTk = String(q.tk_code || q.tkCode || q.request_tk_code || q.requestTkCode || '').trim();
    const qTkDigits = qTk.replace(/\D/g, '');
    const qCode = String(q.quote_code || q.quoteCode || q.id || '').trim();
    const qOutlet = String(q.outlet_code || q.outletCode || '').trim();
    const targetQuoteCode = String(req.quoteCode || req.quote_code || '').trim();
    const targetTk = String(req.tkCode || req.tk_code || '').trim();
    const targetOutlet = String(req.outletCode || req.outlet_code || '').trim();
    const isOfficialTk = /^TK/i.test(targetTk);
    const targetTkDigits = isOfficialTk ? targetTk.replace(/\D/g, '') : '';

    if (targetQuoteCode && qCode && (qCode === targetQuoteCode)) return true;
    if (isOfficialTk && targetTk && qTk && (qTk.toLowerCase() === targetTk.toLowerCase())) return true;
    if (isOfficialTk && targetTkDigits && targetTkDigits.length >= 4 && qTkDigits && qTkDigits === targetTkDigits) return true;
    if (targetOutlet && targetOutlet !== '---' && targetOutlet !== 'Chưa có code' && qOutlet && (qOutlet === targetOutlet)) return true;
    return false;
  };

  let q = null;
  if (req.bridge) {
    q = req.bridge;
  }
  if (!q && req.__backendId && window._quoteDataMap && window._quoteDataMap[req.__backendId]) {
    q = window._quoteDataMap[req.__backendId];
  }
  if (!q && Array.isArray(window.__qcagQuoteListCache)) {
    q = window.__qcagQuoteListCache.find(matches);
  }

  if (q) {
    const orderNo = String(q.order_number || q.orderNumber || '').trim();
    const qcagStRaw = String(q.qcag_override_status || q.qcagOverrideStatus || q.qcag_status || q.qcagStatus || '').trim().toLowerCase();
    const prodAppr = String(q.production_approval_status || q.productionApprovalStatus || '').trim().toLowerCase();
    const resolvedStatus = _resolveQcagStatus(q);
    const resolvedLabel = resolvedStatus ? resolvedStatus.label : '';

    const hasOrder = !!orderNo && orderNo !== '---' && orderNo !== 'null' && orderNo !== 'Chưa có code';
    const isInProduction = resolvedLabel === 'Đang sản xuất' || qcagStRaw.includes('đang sản xuất') || qcagStRaw.includes('dang san xuat') || qcagStRaw.includes('đang làm');
    const isProduced = resolvedLabel === 'Đã ra đơn hàng' || hasOrder || qcagStRaw.includes('đã ra đơn') || qcagStRaw.includes('da ra don') || prodAppr === 'approved';
    const isDone = resolvedLabel === 'Hoàn thành' || resolvedLabel === 'Sale đã nghiệm thu' || qcagStRaw.includes('hoàn thành') || qcagStRaw.includes('thi công xong') || qcagStRaw.includes('đã lắp đặt');

    if (isInProduction) {
      return { isLocked: true, isProduced: true, isInProduction: true, orderNo, label: 'Đang sản xuất', reason: 'Yêu cầu đang sản xuất' + (orderNo ? ` (${orderNo})` : '') + ', không thể chỉnh sửa thiết kế hoặc yêu cầu xóa' };
    }
    if (isProduced) {
      return { isLocked: true, isProduced: true, isInProduction: false, orderNo, label: 'Đã ra đơn hàng', reason: 'Yêu cầu đã ra đơn hàng' + (orderNo ? ` (${orderNo})` : '') + ', không thể chỉnh sửa thiết kế hoặc yêu cầu xóa' };
    }
    if (isDone) {
      return { isLocked: true, isProduced: true, isDone: true, orderNo, label: 'Hoàn thành', reason: 'Yêu cầu đã hoàn thành thi công, không thể chỉnh sửa hoặc yêu cầu xóa' };
    }
  }

  return { isLocked: false, isProduced: false, orderNo: '', label: '', reason: '' };
}
window._checkRequestLockState = _checkRequestLockState;

/**
 * _applyRequestLockUI — Đồng bộ trạng thái khóa lên các nút bấm trong màn hình chi tiết yêu cầu
 */
function _applyRequestLockUI(req) {
  if (!req) return;
  const lock = _checkRequestLockState(req);

  // 1. Nút Xóa yêu cầu ở góc Header
  const detailDeleteBtn = document.getElementById('detailDeleteBtn');
  if (detailDeleteBtn) {
    if (lock.isLocked) {
      detailDeleteBtn.classList.add('opacity-40', 'pointer-events-none', 'cursor-not-allowed');
      detailDeleteBtn.setAttribute('title', lock.reason);
    } else {
      detailDeleteBtn.classList.remove('opacity-40', 'pointer-events-none', 'cursor-not-allowed');
      detailDeleteBtn.setAttribute('title', 'Xóa yêu cầu');
    }
  }

  // 2. Nút Yêu cầu chỉnh sửa Maquette trong MQ Section
  const mqEditBtns = document.querySelectorAll('.mq-edit-badge-btn');
  mqEditBtns.forEach(btn => {
    if (lock.isProduced) {
      btn.classList.add('opacity-40', 'pointer-events-none', 'cursor-not-allowed');
      btn.setAttribute('title', lock.reason);
      btn.setAttribute('disabled', 'disabled');
      const span = btn.querySelector('span');
      if (span) span.textContent = lock.label || 'Đã ra đơn';
    } else {
      btn.classList.remove('opacity-40', 'pointer-events-none', 'cursor-not-allowed');
      btn.removeAttribute('disabled');
      btn.setAttribute('title', 'Gửi yêu cầu chỉnh sửa thiết kế tới QCAG');
      const span = btn.querySelector('span');
      if (span) span.textContent = 'Yêu cầu chỉnh sửa';
    }
  });
}
window._applyRequestLockUI = _applyRequestLockUI;


// Initialize RAM cache instantly from localStorage on script execution
(function _initQuoteCacheFromLocalStorage() {
  try {
    const raw = localStorage.getItem(QUOTE_PERSISTENT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.data) && parsed.data.length > 0) {
        window.__qcagQuoteListCache = parsed.data;
        window.__qcagQuoteCacheTime = parsed.timestamp || 0;
        window.__qcagQuoteListLoaded = true;
      }
    }
  } catch (e) {
    console.warn('Failed to load quote cache from localStorage', e);
  }
  // SWR: Tự động kích hoạt revalidate ngầm ngay khi app khởi động để kéo báo giá mới nhất
  setTimeout(() => {
    if (typeof _fetchApp1QuoteListWithCache === 'function') {
      _fetchApp1QuoteListWithCache(true).catch(() => {});
    }
  }, 150);
})();

let _quoteFetchInFlight = null;

async function _fetchApp1QuoteListWithCache(force = false) {
  const now = Date.now();
  const CACHE_TTL = 30 * 1000; // 30 giây cache để đảm bảo cập nhật nhanh nhất

  if (!force && window.__qcagQuoteListCache && (now - window.__qcagQuoteCacheTime < CACHE_TTL)) {
    window.__qcagQuoteListLoaded = true;
    return window.__qcagQuoteListCache;
  }

  if (_quoteFetchInFlight) {
    return _quoteFetchInFlight;
  }

  _quoteFetchInFlight = (async () => {
    const app1Base = 'https://qcag-backend-staging-493469512136.asia-southeast1.run.app';
    let allQuotes = [];

    const sessionCode = (typeof currentSession !== 'undefined' && currentSession) ? (currentSession.saleCode || currentSession.userCode || '') : '';
    const sessionPhone = (typeof currentSession !== 'undefined' && currentSession) ? (currentSession.phone || '') : '';
    const sessionName = (typeof currentSession !== 'undefined' && currentSession) ? (currentSession.saleName || currentSession.name || currentSession.username || '') : '';

    try {
      let url1 = app1Base + '/pending-orders?summary=1';
      if (sessionCode) url1 += '&sale_code=' + encodeURIComponent(sessionCode);
      if (sessionPhone) url1 += '&sale_phone=' + encodeURIComponent(sessionPhone);
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 2500) : null;
      const res = await fetch(url1, { signal: controller ? controller.signal : undefined }).catch(() => null);
      if (timer) clearTimeout(timer);
      if (res && res.ok) {
        const json = await res.json().catch(() => null);
        if (json && json.ok && Array.isArray(json.data)) {
          for (const order of json.data) {
            const quotes = Array.isArray(order.quotes) ? order.quotes : [];
            allQuotes.push(...quotes);
          }
        }
      }
    } catch (e) {
      // App 1 pending-orders fetch timed out or offline
    }

    try {
      let url2 = app1Base + '/quotations?lite=1&limit=1000';
      if (sessionCode) url2 += '&sale_code=' + encodeURIComponent(sessionCode);
      if (sessionPhone) url2 += '&sale_phone=' + encodeURIComponent(sessionPhone);
      if (sessionName) url2 += '&sale_name=' + encodeURIComponent(sessionName);
      const res2 = await fetch(url2);
      if (res2.ok) {
        const json2 = await res2.json();
        if (Array.isArray(json2)) {
          allQuotes.push(...json2);
        }
      }
    } catch (e) {
      console.warn('App 1 quotations fetch warning:', e);
    }

    if (allQuotes.length > 0) {
      // Slim down quotes for cache to protect mobile localStorage quota (prevent QuotaExceededError)
      const slimQuotes = allQuotes.map(q => ({
        id: q.id,
        quote_code: q.quote_code || q.quoteCode,
        tk_code: q.tk_code || q.tkCode,
        request_tk_code: q.request_tk_code || q.requestTkCode,
        outlet_code: q.outlet_code || q.outletCode,
        outlet_name: q.outlet_name || q.outletName,
        total_amount: q.total_amount || q.totalAmount || q.amount || q.quote_total,
        spo_number: q.spo_number || q.spoNumber,
        spo_status: q.spo_status || q.spoStatus,
        qcag_status: q.qcag_status || q.qcagStatus,
        qcag_override_status: q.qcag_override_status || q.qcagOverrideStatus,
        production_approval_status: q.production_approval_status || q.productionApprovalStatus,
        cancellation_status: q.cancellation_status || q.cancellationStatus,
        is_confirmed: q.is_confirmed || q.isConfirmed,
        order_number: q.order_number || q.orderNumber,
        created_by_name: q.created_by_name,
        created_at: q.created_at
      }));

      window.__qcagQuoteListCache = slimQuotes;
      window.__qcagQuoteCacheTime = now;
      try {
        localStorage.setItem(QUOTE_PERSISTENT_KEY, JSON.stringify({
          timestamp: now,
          data: slimQuotes
        }));
      } catch (e) { }
    }

    window.__qcagQuoteListLoaded = true;
    try {
      window.dispatchEvent(new CustomEvent('qcag:quotes-loaded', { detail: { quotes: allQuotes } }));
    } catch (e) { }

    return window.__qcagQuoteListCache || [];
  })().finally(() => {
    _quoteFetchInFlight = null;
  });

  return _quoteFetchInFlight;
}

async function _loadBridgeStatus(backendId) {
  const section = document.getElementById('quoteBridgeSection');
  const contentEl = document.getElementById('quoteBridgeContent');
  const headMetaEl = document.getElementById('quoteBridgeHeadMeta');
  if (!section || !contentEl || !backendId) return;

  section.classList.remove('hidden');

  const req = (typeof allRequests !== 'undefined' && Array.isArray(allRequests))
    ? (allRequests.find(r => r && (r.__backendId === backendId || String(r.id) === String(backendId))) || currentDetailRequest)
    : currentDetailRequest;

  const targetTk = req ? String(req.tkCode || req.tk_code || '').trim() : '';
  const isOfficialTk = /^TK/i.test(targetTk);
  const targetTkDigits = isOfficialTk ? targetTk.replace(/\D/g, '') : '';
  const targetQuoteCode = req ? String(req.quoteCode || req.quote_code || '').trim() : '';
  const targetOutlet = req ? String(req.outletCode || req.outlet_code || '').trim() : '';

  const showFallback = (msg) => {
    if (headMetaEl) {
      const qCode = targetQuoteCode;
      const tkCode = targetTk;
      headMetaEl.innerHTML = `
        <div class="flex flex-col items-end text-xs font-mono">
          ${qCode ? `<span class="quote-bridge-meta-item"><span class="quote-bridge-meta-label">Mã BG:</span> <span class="quote-bridge-meta-bg font-bold">${ksEscapeHtml(qCode)}</span></span>` : ''}
          ${tkCode ? `<span class="quote-bridge-meta-item"><span class="quote-bridge-meta-label">Mã TK:</span> <span class="quote-bridge-meta-tk font-bold">${ksEscapeHtml(tkCode)}</span></span>` : ''}
        </div>
      `;
    }
    contentEl.innerHTML = `
      <div class="space-y-2 text-sm">
        <div class="quote-bridge-row flex items-center justify-between gap-3 min-w-0">
          <span class="quote-bridge-label text-xs font-semibold flex-shrink-0">Trạng thái QCAG:</span>
          <span class="quote-bridge-status-empty text-xs font-medium">---</span>
        </div>
        <div class="quote-bridge-row flex items-center justify-between gap-3">
          <span class="quote-bridge-label text-xs font-semibold">Tổng tiền báo giá:</span>
          <span class="quote-bridge-amount-empty text-sm font-semibold">---</span>
        </div>
        <div class="quote-bridge-footer quote-bridge-footer-empty pt-2 border-t flex items-center justify-between text-xs font-semibold">
          <span class="quote-bridge-btn-empty-label">Chưa có báo giá</span>
          <span class="quote-bridge-btn-empty-sub text-[11px]">Đang chờ QCAG</span>
        </div>
      </div>
    `;
    section.onclick = null;
    section.classList.remove('quote-bridge-interactive');
    section.removeAttribute('title');
  };

  try {
    const matches = (q) => {
      if (!q) return false;
      const qTk = String(q.tk_code || q.tkCode || q.request_tk_code || q.requestTkCode || '').trim();
      const qTkDigits = qTk.replace(/\D/g, '');
      const qCode = String(q.quote_code || q.quoteCode || q.id || '').trim();
      const qOutlet = String(q.outlet_code || q.outletCode || '').trim();

      if (targetQuoteCode && qCode && (qCode === targetQuoteCode)) return true;
      if (isOfficialTk && targetTk && qTk && (qTk.toLowerCase() === targetTk.toLowerCase())) return true;
      if (isOfficialTk && targetTkDigits && targetTkDigits.length >= 4 && qTkDigits && qTkDigits === targetTkDigits) return true;
      if (targetOutlet && targetOutlet !== '---' && targetOutlet !== 'Chưa có code' && qOutlet && (qOutlet === targetOutlet)) return true;
      return false;
    };

    let quoteData = null;

    // 1. Check embedded bridge in request
    if (req && req.bridge && matches(req.bridge)) {
      quoteData = req.bridge;
    }

    // 2. Check cached quote in window._quoteDataMap by backendId
    if (!quoteData && backendId && window._quoteDataMap && window._quoteDataMap[backendId]) {
      const candidate = window._quoteDataMap[backendId];
      if (matches(candidate)) quoteData = candidate;
    }

    // 3. Check cached quote by quoteCode
    if (!quoteData && targetQuoteCode && window._quoteDataMap && window._quoteDataMap[targetQuoteCode]) {
      const candidate = window._quoteDataMap[targetQuoteCode];
      if (matches(candidate)) quoteData = candidate;
    }

    // 4. Check cached quotes list window.__qcagQuoteListCache
    if (!quoteData && Array.isArray(window.__qcagQuoteListCache)) {
      quoteData = window.__qcagQuoteListCache.find(matches);
    }

    // 5. Fetch live/cached quote data from App 1 backend
    if (!quoteData) {
      if (typeof _fetchApp1QuoteListWithCache === 'function') {
        const cachedQuotes = await _fetchApp1QuoteListWithCache();
        if (Array.isArray(cachedQuotes)) {
          quoteData = cachedQuotes.find(matches);
        }
      }

      // 6. Fallback direct API lookup if not found in list cache
      if (!quoteData) {
        const queryParams = [];
        if (targetQuoteCode) queryParams.push('quote_code=' + encodeURIComponent(targetQuoteCode));
        if (targetTk) queryParams.push('tk_code=' + encodeURIComponent(targetTk));
        if (targetOutlet && targetOutlet !== '---' && targetOutlet !== 'Chưa có code') queryParams.push('outlet_code=' + encodeURIComponent(targetOutlet));

        if (queryParams.length > 0) {
          try {
            const app1Base = 'https://qcag-backend-staging-493469512136.asia-southeast1.run.app';
            const directRes = await fetch(app1Base + '/quotations?' + queryParams.join('&')).catch(() => null);
            if (directRes && directRes.ok) {
              const directJson = await directRes.json().catch(() => null);
              if (Array.isArray(directJson) && directJson.length > 0) {
                quoteData = directJson.find(matches) || directJson[0];
                if (quoteData && Array.isArray(window.__qcagQuoteListCache)) {
                  if (!window.__qcagQuoteListCache.some(q => q && q.quote_code === quoteData.quote_code)) {
                    window.__qcagQuoteListCache.push(quoteData);
                  }
                }
              }
            }
          } catch (e) {
            console.warn('Direct quote fallback error:', e);
          }
        }
      }
    }

    if (!quoteData) {
      showFallback('QCAG chưa tạo báo giá cho yêu cầu này.');
      return;
    }

    const q = quoteData;
    const quoteCode = q.quote_code || q.quoteCode || targetQuoteCode || '---';
    const tkCode = q.tk_code || q.tkCode || targetTk || '---';
    const totalNum = Number(q.total_amount || q.totalAmount || q.amount || q.quote_total) || 0;
    const totalStr = totalNum > 0 ? (totalNum.toLocaleString('vi-VN') + ' đ') : 'Chưa có tổng tiền';
    // Status badge determination (dùng hàm chung _resolveQcagStatus theo vòng đời quotation)
    const { label: statusLabel, cls: statusCls } = _resolveQcagStatus(q);

    // 1. Update Header Meta (Mã BG & Mã TK)
    if (headMetaEl) {
      headMetaEl.innerHTML = `
        <div class="flex flex-col items-end text-xs font-mono">
          ${quoteCode ? `<span class="quote-bridge-meta-item"><span class="quote-bridge-meta-label">Mã BG:</span> <span class="quote-bridge-meta-bg font-bold">${ksEscapeHtml(quoteCode)}</span></span>` : ''}
          ${tkCode ? `<span class="quote-bridge-meta-item"><span class="quote-bridge-meta-label">Mã TK:</span> <span class="quote-bridge-meta-tk font-bold">${ksEscapeHtml(tkCode)}</span></span>` : ''}
        </div>
      `;
    }

    // Cache dữ liệu báo giá để openFullMobileQuoteModal sử dụng
    window.__ksQuoteModalCache = window.__ksQuoteModalCache || {};
    window.__ksQuoteModalCache[String(backendId)] = q;
    window._lastLoadedQuoteData = q;
    if (backendId) {
      window._quoteDataMap = window._quoteDataMap || {};
      window._quoteDataMap[backendId] = q;
    }
    if (q.quote_code || q.quoteCode) {
      window._quoteDataMap = window._quoteDataMap || {};
      window._quoteDataMap[q.quote_code || q.quoteCode] = q;
    }
    if (req) {
      req.bridge = q;
    }

    // Cho phép bấm vào toàn bộ khối báo giá để mở Modal chi tiết
    section.classList.add('quote-bridge-interactive');
    section.setAttribute('title', 'Bấm để xem chi tiết báo giá');
    section.onclick = () => openFullMobileQuoteModal(String(backendId), q);

    // 2. Update Báo giá QCAG Status Card Content
    contentEl.innerHTML = `
      <div class="space-y-2 text-sm">
        <div class="quote-bridge-row flex items-center justify-between gap-3 min-w-0">
          <span class="quote-bridge-label text-xs font-semibold flex-shrink-0">Trạng thái QCAG:</span>
          <span class="quote-bridge-status-badge inline-flex items-center px-2 py-0.5 text-[11px] font-bold rounded-md border ${statusCls} text-center leading-snug whitespace-nowrap overflow-hidden truncate max-w-[65%]">${ksEscapeHtml(statusLabel)}</span>
        </div>
        <div class="quote-bridge-row flex items-center justify-between gap-3">
          <span class="quote-bridge-label text-xs font-semibold">Tổng tiền báo giá:</span>
          <span class="quote-bridge-amount text-[15px] font-bold font-numeric">${ksEscapeHtml(totalStr)}</span>
        </div>
        ${q.spo_number ? `
          <div class="quote-bridge-spo-row flex items-center justify-between text-xs pt-2 border-t">
            <span class="quote-bridge-spo-label">SPO #: <strong class="quote-bridge-spo-val font-bold">${ksEscapeHtml(q.spo_number)}</strong></span>
            <span class="quote-bridge-spo-creator">${q.created_by_name ? `Tạo bởi: ${ksEscapeHtml(q.created_by_name)}` : ''}</span>
          </div>
        ` : ''}
        <div class="quote-bridge-footer pt-2 border-t flex items-center justify-between text-xs font-semibold">
          <span class="quote-bridge-footer-action">Bấm để xem chi tiết</span>
          <span class="text-sm">↗</span>
        </div>
      </div>
    `;

    // Đồng bộ trạng thái khóa đơn hàng/sản xuất lên nút Xóa và nút Sửa Maquette
    try {
      _applyRequestLockUI(req || currentDetailRequest);
    } catch (_) { }

    // Compact Mobile Quote Slot đã được loại bỏ, thông tin báo giá hiển thị đầy đủ tại #quoteBridgeSection ở cuối trang

  } catch (e) {
    console.error('Error loading bridge status:', e);
    showFallback('Không tải được dữ liệu báo giá.');
  }
}

window._quoteDataMap = window._quoteDataMap || {};

async function openFullMobileQuoteModal(backendId, directQuoteData) {
  let req = (typeof allRequests !== 'undefined' && Array.isArray(allRequests))
    ? allRequests.find(r => r && (
        (backendId && String(r.__backendId || '') === String(backendId)) ||
        (backendId && String(r.id || '') === String(backendId)) ||
        (backendId && r.tkCode && String(r.tkCode).toLowerCase() === String(backendId).toLowerCase()) ||
        (backendId && r.tk_code && String(r.tk_code).toLowerCase() === String(backendId).toLowerCase())
      ))
    : (typeof currentDetailRequest !== 'undefined' ? currentDetailRequest : null);
  if (!req && window._dv_currentDesignReq) {
    req = window._dv_currentDesignReq;
  }

  const targetTk = req ? String(req.tkCode || req.tk_code || '').trim() : '';
  const isOfficialTk = /^TK/i.test(targetTk);
  const targetTkDigits = isOfficialTk ? targetTk.replace(/\D/g, '') : '';
  const targetQuoteCode = req ? String(req.quoteCode || req.quote_code || '').trim() : '';
  const targetOutlet = req ? String(req.outletCode || req.outlet_code || '').trim() : '';

  const isMatchingQuote = (candidate) => {
    if (!candidate) return false;
    const cQuote = String(candidate.quote_code || candidate.quoteCode || candidate.id || '').trim();
    const cTk = String(candidate.tk_code || candidate.tkCode || '').trim();
    const cTkDigits = cTk.replace(/\D/g, '');
    const cOutlet = String(candidate.outlet_code || candidate.outletCode || '').trim();

    if (targetQuoteCode && cQuote && targetQuoteCode === cQuote) return true;
    if (isOfficialTk && targetTk && cTk && targetTk.toLowerCase() === cTk.toLowerCase()) return true;
    if (isOfficialTk && targetTkDigits && targetTkDigits.length >= 4 && cTkDigits && cTkDigits === targetTkDigits) return true;
    if (targetOutlet && targetOutlet !== '---' && cOutlet && targetOutlet === cOutlet) return true;
    return false;
  };

  let q = null;
  // 1. Dữ liệu truyền trực tiếp
  if (directQuoteData) {
    q = directQuoteData;
  }
  // 2. Cache theo backendId chính xác
  if (!q && backendId && window._quoteDataMap && window._quoteDataMap[backendId]) {
    const candidate = window._quoteDataMap[backendId];
    if (!req || isMatchingQuote(candidate)) q = candidate;
  }
  // 3. Embedded bridge trong request
  if (!q && req && req.bridge && isMatchingQuote(req.bridge)) {
    q = req.bridge;
  }
  // 4. Cache theo quoteCode
  if (!q && targetQuoteCode && window._quoteDataMap && window._quoteDataMap[targetQuoteCode]) {
    const candidate = window._quoteDataMap[targetQuoteCode];
    if (isMatchingQuote(candidate)) q = candidate;
  }
  // 5. Khớp trong danh sách cached quotes
  if (!q && Array.isArray(window.__qcagQuoteListCache)) {
    q = window.__qcagQuoteListCache.find(isMatchingQuote);
  }

  // 6. Nếu chưa có báo giá khớp, fetch trực tiếp cho yêu cầu này (hỗ trợ Xem Nhanh ngoài danh sách)
  if (!q && (targetTk || targetQuoteCode || targetOutlet || backendId)) {
    try {
      if (typeof showToast === 'function') showToast('Đang tải báo giá...');
      if (typeof _fetchApp1QuoteListWithCache === 'function') {
        const cachedQuotes = await _fetchApp1QuoteListWithCache();
        if (Array.isArray(cachedQuotes)) {
          q = cachedQuotes.find(isMatchingQuote);
        }
      }
      if (!q) {
        const queryParams = [];
        if (targetQuoteCode) queryParams.push('quote_code=' + encodeURIComponent(targetQuoteCode));
        if (targetTk) queryParams.push('tk_code=' + encodeURIComponent(targetTk));
        if (targetOutlet && targetOutlet !== '---') queryParams.push('outlet_code=' + encodeURIComponent(targetOutlet));
        if (queryParams.length > 0) {
          const app1Base = 'https://qcag-backend-staging-493469512136.asia-southeast1.run.app';
          const r = await fetch(app1Base + '/quotations?' + queryParams.join('&')).catch(() => null);
          if (r && r.ok) {
            const list = await r.json().catch(() => null);
            if (Array.isArray(list) && list.length > 0) {
              q = list.find(isMatchingQuote) || list[0];
            }
          }
        }
      }
    } catch (e) {
      console.warn('Error fetching quote on-demand:', e);
    }
  }

  if (!q) {
    if (typeof showToast === 'function') showToast('Yêu cầu này chưa có báo giá từ QCAG');
    return;
  }

  if (backendId) {
    window._quoteDataMap = window._quoteDataMap || {};
    window._quoteDataMap[backendId] = q;
  }
  if (q.quote_code) {
    window._quoteDataMap = window._quoteDataMap || {};
    window._quoteDataMap[q.quote_code] = q;
  }
  window._lastLoadedQuoteData = q;

  // Resolve request matching quotation if not already found
  if (!req && typeof allRequests !== 'undefined' && Array.isArray(allRequests)) {
    const qTk = String(q.tk_code || q.tkCode || '').trim();
    const qQuote = String(q.quote_code || q.quoteCode || '').trim();
    const qOutlet = String(q.outlet_code || q.outletCode || '').trim();
    req = allRequests.find(r => {
      if (!r) return false;
      if (qQuote && (r.quoteCode === qQuote || r.quote_code === qQuote)) return true;
      if (qTk && (r.tkCode === qTk || r.tk_code === qTk)) return true;
      if (qOutlet && qOutlet !== '---' && (r.outletCode === qOutlet || r.outlet_code === qOutlet)) return true;
      return false;
    });
  }
  if (!req && typeof currentDetailRequest !== 'undefined' && currentDetailRequest) {
    req = currentDetailRequest;
  }

  window._currentModalQuote = q;
  if (req) {
    window.currentDetailRequest = req;
    window._currentModalQuoteReq = req;
  }

  const totalNum = Number(q.total_amount || q.totalAmount || q.amount || q.quote_total) || 0;
  const totalStr = totalNum > 0 ? (totalNum.toLocaleString('vi-VN') + ' đ') : 'Chưa có tổng tiền';
  const outletName = q.outlet_name || q.outletName || (req ? req.outletName : 'Outlet');
  const outletCode = q.outlet_code || q.outletCode || (req ? req.outletCode : '---');
  const address = q.address || (req ? req.address : '');
  const quoteCode = q.quote_code || q.quoteCode || (req ? req.quoteCode : '---');
  const tkCode = q.tk_code || q.tkCode || (req ? req.tkCode : '---');
  const phone = q.phone || (req ? (req.phone || req.outletPhone) : '');
  const areaName = q.area || (req && (req.area || req.region || req.province || req.district)) || '';
  const channelName = (req && (req.channel || req.outletType)) || q.outlet_type || q.sale_type || '';

  // Xử lý chuẩn xác Nội dung bảng hiệu (Tuyệt đối không lấy notes hệ thống)
  const checkOldBool = val => val === true || val === 1 || String(val).toLowerCase() === 'true' || String(val) === '1';
  const isOldContent = Boolean(
    (req && (checkOldBool(req.oldContent) || checkOldBool(req.old_content) || checkOldBool(req.isOldContent) || checkOldBool(req.is_old_content) || checkOldBool(req.useOldContent) || checkOldBool(req.use_old_content))) ||
    (q && (checkOldBool(q.old_content) || checkOldBool(q.oldContent)))
  );

  let rawContent = (req && (req.content || req.signContent || req.signboard_content)) || q.signboard_content || q.content || '';
  if (typeof rawContent === 'string') {
    rawContent = rawContent.trim();
    // Bỏ qua nếu là JSON log, JSON array rỗng hoặc rác
    if (rawContent.startsWith('[{') || rawContent === '[]' || rawContent === '{}' || rawContent === 'null' || rawContent === 'undefined' || rawContent === '""') {
      rawContent = '';
    }
  } else if (Array.isArray(rawContent)) {
    rawContent = rawContent.filter(x => typeof x === 'string' && !x.startsWith('{')).join(' • ');
  } else {
    rawContent = '';
  }

  const oldExtra = (req && (req.oldContentExtra || req.old_content_extra)) ? String(req.oldContentExtra || req.old_content_extra).trim() : '';

  let items = [];
  if (Array.isArray(q.items)) {
    items = q.items;
  } else if (typeof q.items === 'string') {
    try { items = JSON.parse(q.items); } catch (_) { items = []; }
  }
  if ((!items || items.length === 0) && req) {
    if (Array.isArray(req.items)) items = req.items;
    else if (typeof req.items === 'string') {
      try { items = JSON.parse(req.items); } catch (_) { items = []; }
    }
  }

  const scInfo = (typeof qcagResolveSignageContent === 'function')
    ? qcagResolveSignageContent(req ? Object.assign({}, q, req, { items }) : Object.assign({}, q, { items }))
    : null;
  let signContentText = '';
  if (scInfo) {
    signContentText = scInfo.displayText;
  } else if (rawContent) {
    signContentText = rawContent;
  } else if (isOldContent) {
    signContentText = oldExtra ? `Nội dung cũ (${oldExtra})` : 'Nội dung cũ';
  } else {
    signContentText = 'Hạng mục này không có nội dung';
  }

  let quoteImages = [];
  const rawImgs = q.images || q.image_url || q.qcag_image_url || q.designImages || q.design;
  if (Array.isArray(rawImgs)) {
    quoteImages = rawImgs;
  } else if (typeof rawImgs === 'string') {
    try {
      const parsed = JSON.parse(rawImgs);
      if (Array.isArray(parsed)) quoteImages = parsed;
      else if (rawImgs.startsWith('http')) quoteImages = [rawImgs];
    } catch (_) {
      if (rawImgs.startsWith('http')) quoteImages = [rawImgs];
    }
  }
  if (quoteImages.length === 0 && req) {
    const reqDesign = req.design || req.designImages;
    if (Array.isArray(reqDesign)) quoteImages = reqDesign;
    else if (typeof reqDesign === 'string') {
      try {
        const parsed = JSON.parse(reqDesign);
        if (Array.isArray(parsed)) quoteImages = parsed;
        else if (reqDesign.startsWith('http')) quoteImages = [reqDesign];
      } catch (_) {
        if (reqDesign.startsWith('http')) quoteImages = [reqDesign];
      }
    }
  }

  const existing = document.getElementById('fullMobileQuoteModal');
  if (existing) existing.remove();

  // Status badge determination (dùng hàm chung _resolveQcagStatus theo vòng đời quotation)
  const { label: statusLabel, cls: statusCls } = _resolveQcagStatus(q);

  const tableRowsHtml = items.map((it, idx) => {
    const codeStr = it.code ? `${it.code}` : `${idx + 1}`;
    const content = ksEscapeHtml(it.content || it.name || 'Hạng mục');
    const brand = ksEscapeHtml(it.brand || '');
    const width = it.width ? `${it.width}m` : '';
    const height = it.height ? `${it.height}m` : '';
    const sizeStr = (width || height) ? `${width || '-'} x ${height || '-'}` : '-';
    const qtyStr = `${it.quantity || 1} ${it.unit || 'm²'}`;
    const priceNum = Number(it.price || 0);
    const priceStr = priceNum > 0 ? (priceNum.toLocaleString('vi-VN') + ' đ') : '---';
    const totalNumItem = Number(it.total || (priceNum * (Number(it.quantity) || 1))) || 0;
    const totalItemStr = totalNumItem > 0 ? (totalNumItem.toLocaleString('vi-VN') + ' đ') : '---';

    let brandClass = 'brand-default';
    const bb = String(it.brand || '').toLowerCase().trim();
    if (bb.indexOf('heineken') !== -1) brandClass = 'brand-heineken';
    else if (bb.indexOf('tiger') !== -1) brandClass = 'brand-tiger';
    else if (bb.indexOf('bivina') !== -1) brandClass = 'brand-bivina';
    else if (bb.indexOf('bia việt') !== -1 || bb.indexOf('bia viet') !== -1) brandClass = 'brand-biaviet';
    else if (bb.indexOf('larue') !== -1) brandClass = 'brand-larue';
    else if (bb.indexOf('strongbow') !== -1) brandClass = 'brand-strongbow';
    else if (bb.indexOf('shopname') !== -1) brandClass = 'brand-shopname';

    const bBadge = brand ? `<span class="qcag-brand-badge ${brandClass} text-[11px] px-2 py-0.5 rounded-md font-bold inline-block">${brand}</span>` : '';

    return `
      <tr class="transition-colors">
        <td class="hk-tbl-code text-center font-bold whitespace-nowrap">${ksEscapeHtml(codeStr)}</td>
        <td class="hk-tbl-name whitespace-nowrap">
          <span class="font-bold mobile-quote-item-title whitespace-nowrap">${content}</span>
        </td>
        <td class="hk-tbl-center text-center whitespace-nowrap">${bBadge || '<span class="text-gray-400 text-xs font-normal">-</span>'}</td>
        <td class="hk-tbl-center text-center font-medium whitespace-nowrap">${ksEscapeHtml(sizeStr)}</td>
        <td class="hk-tbl-center text-center font-semibold whitespace-nowrap">${ksEscapeHtml(qtyStr)}</td>
        <td class="hk-tbl-right text-right font-medium whitespace-nowrap">${ksEscapeHtml(priceStr)}</td>
        <td class="hk-tbl-right text-right font-bold mobile-quote-total-val whitespace-nowrap pr-6">${ksEscapeHtml(totalItemStr)}</td>
      </tr>
    `;
  }).join('');

  const itemsHtml = items.map((it, idx) => {
    const codeStr = it.code ? `${it.code}. ` : `${idx + 1}. `;
    const content = ksEscapeHtml(it.content || it.name || 'Hạng mục');
    const brand = ksEscapeHtml(it.brand || '');
    const width = it.width ? `${it.width}m` : '-';
    const height = it.height ? `${it.height}m` : '-';
    const qty = `${it.quantity || 1} ${it.unit || 'm²'}`;
    const priceNum = Number(it.price || 0);
    const priceStr = priceNum > 0 ? (priceNum.toLocaleString('vi-VN') + ' đ') : '---';
    const totalNumItem = Number(it.total || (priceNum * (Number(it.quantity) || 1))) || 0;
    const totalItemStr = totalNumItem > 0 ? (totalNumItem.toLocaleString('vi-VN') + ' đ') : '---';

    let brandClass = 'brand-default';
    const bb = String(it.brand || '').toLowerCase().trim();
    if (bb.indexOf('heineken') !== -1) brandClass = 'brand-heineken';
    else if (bb.indexOf('tiger') !== -1) brandClass = 'brand-tiger';
    else if (bb.indexOf('bivina') !== -1) brandClass = 'brand-bivina';
    else if (bb.indexOf('bia việt') !== -1 || bb.indexOf('bia viet') !== -1) brandClass = 'brand-biaviet';
    else if (bb.indexOf('larue') !== -1) brandClass = 'brand-larue';
    else if (bb.indexOf('strongbow') !== -1) brandClass = 'brand-strongbow';
    else if (bb.indexOf('shopname') !== -1) brandClass = 'brand-shopname';

    return `
      <div class="full-mqm-item-card rounded-xl p-3 space-y-2">
        <div class="flex items-start justify-between gap-2.5">
          <div class="font-bold text-xs full-mqm-item-name flex-1 min-w-0" title="${codeStr}${content}">
            <span class="full-mqm-item-code whitespace-nowrap">${codeStr}</span><span class="full-mqm-item-text">${content}</span>
          </div>
          ${brand ? `<span class="qcag-brand-badge ${brandClass} text-[11px] px-2 py-0.5 rounded-md font-bold flex-shrink-0 leading-tight mt-0.5">${brand}</span>` : ''}
        </div>
        <div class="grid grid-cols-2 gap-2 text-xs full-mqm-item-grid pt-1 border-t">
          <div><span class="full-mqm-label">Kích thước:</span> <strong class="full-mqm-val">${width} x ${height}</strong></div>
          <div><span class="full-mqm-label">Số lượng:</span> <strong class="full-mqm-val">${qty}</strong></div>
          <div><span class="full-mqm-label">Đơn giá:</span> <span class="full-mqm-val">${priceStr}</span></div>
          <div class="whitespace-nowrap"><span class="full-mqm-label">Thành tiền:</span> <strong class="full-mqm-item-total font-bold font-numeric whitespace-nowrap">${totalItemStr}</strong></div>
        </div>
      </div>
    `;
  }).join('');

  let firstMqUrl = '';
  if (quoteImages.length > 0) {
    const raw0 = quoteImages[0];
    firstMqUrl = typeof raw0 === 'string' ? raw0 : (raw0 && (raw0.data || raw0.url || raw0.src));
  }


  const isDesktop = window.innerWidth >= 1024;
  const modalHtml = isDesktop ? `
    <div id="fullMobileQuoteModal" class="full-mobile-quote-modal fixed inset-0 z-[6000] flex items-center justify-center p-0 lg:p-4 bg-black/80 backdrop-blur-md animate-fadeIn select-none" style="z-index:6000">
      <div class="hk-quote-dialog w-full h-full lg:w-[1560px] lg:max-w-[97vw] lg:h-[88vh] lg:max-h-[88vh] lg:rounded-2xl flex flex-col overflow-hidden shadow-2xl">
        
        <!-- Header Desktop -->
        <div class="mobile-quote-header px-5 lg:px-6 py-3.5 flex items-center justify-between flex-shrink-0 border-b">
          <div class="min-w-0 flex-1 flex items-center gap-3">
            <h2 class="text-base lg:text-lg font-extrabold mobile-quote-header-title uppercase tracking-wider">Chi Tiết Báo Giá</h2>
          </div>
          <div class="flex items-center gap-3 lg:gap-4 flex-shrink-0">
            <div class="text-xs font-semibold mobile-quote-header-codes pr-1">
              ${tkCode ? `<span class="mobile-quote-tk-badge text-amber-500 font-bold">${ksEscapeHtml(String(tkCode).toUpperCase().startsWith('TK') ? tkCode : 'Mã TK: ' + tkCode)}</span>` : ''}
              ${(tkCode && quoteCode) ? `<span class="opacity-40 px-1">·</span>` : ''}
              ${quoteCode ? `<span class="mobile-quote-code-badge text-sky-500 font-bold">Mã BG: ${ksEscapeHtml(quoteCode)}</span>` : ''}
            </div>
            <button onclick="closeFullMobileQuoteModal()" class="w-8 h-8 rounded-full mobile-quote-close-btn flex items-center justify-center text-sm font-bold shadow-sm transition-colors active:scale-95 bg-red-600 hover:bg-red-700 text-white" title="Đóng">✕</button>
          </div>
        </div>

        <!-- Content Body (2 Columns on Desktop) -->
        <div class="hk-quote-modal-content-grid flex-1 overflow-hidden">
          
          <!-- Left Sidebar (2 Blocks: Outlet Card + MQ Preview) -->
          <div class="hk-quote-modal-sidebar flex flex-col gap-4 overflow-y-auto p-4 lg:p-5 h-full">
            
            <!-- Block 1: Thông tin Outlet Card (Bố cục thông tin đầy đặn, chuẩn Design System) -->
            <div class="hk-modal-outlet-card rounded-xl p-4 lg:p-4.5 text-xs flex flex-col gap-3 flex-shrink-0">
              <!-- Header Outlet -->
              <div class="flex items-center justify-between pb-2 border-b border-gray-200 dark:border-slate-800/80">
                <span class="mobile-quote-section-title text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5">
                  <svg class="w-3.5 h-3.5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
                  <span>Thông tin Outlet</span>
                </span>
                <span class="font-extrabold text-sky-400 font-mono text-sm px-2 py-0.5 rounded bg-sky-950/40 border border-sky-500/30 tracking-wide">${ksEscapeHtml(outletCode || '---')}</span>
              </div>

              <!-- Tên Quán to nổi bật -->
              <div class="text-[15px] lg:text-base font-extrabold mobile-quote-val leading-snug" title="${ksEscapeHtml(outletName)}">${ksEscapeHtml(outletName)}</div>

              <!-- Hộp Nội dung Bảng hiệu (Dành riêng cho Sale check nhanh) -->
              <div class="hk-outlet-subcard p-2.5 rounded-lg flex flex-col gap-1 border text-left">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-1.5 text-amber-400 font-bold text-[11px] uppercase tracking-wider">
                    <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                    <span>Nội dung bảng hiệu</span>
                  </div>
                </div>
                <div class="mobile-quote-val text-xs leading-relaxed break-words font-medium ${signContentText === 'Hạng mục này không có nội dung' ? 'text-slate-400 dark:text-slate-500 italic' : 'text-slate-200'} text-left whitespace-pre-wrap">${ksEscapeHtml(signContentText)}</div>
              </div>

              <!-- Hộp SĐT & Địa chỉ Outlet (Cùng bậc) -->
              <div class="hk-outlet-subcard p-2.5 rounded-lg flex flex-col gap-2 border">
                <!-- SĐT -->
                <div class="flex items-center gap-1.5 text-xs">
                  <svg class="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
                  <span class="mobile-quote-lbl text-slate-400 font-medium">SĐT:</span>
                  <span class="mobile-quote-val font-bold text-slate-100">${ksEscapeHtml(phone || '---')}</span>
                </div>
                <!-- Địa chỉ -->
                ${address ? `
                  <div class="flex items-start gap-1.5 pt-2 border-t border-slate-700/50 dark:border-slate-800/80 text-[11.5px] leading-relaxed break-words">
                    <svg class="w-3.5 h-3.5 text-sky-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                    <div>
                      <span class="mobile-quote-lbl text-slate-400 font-medium">Địa chỉ: </span>
                      <span class="mobile-quote-val text-slate-200 font-normal">${ksEscapeHtml(address)}</span>
                    </div>
                  </div>
                ` : ''}
              </div>
            </div>

            <!-- Block 2: Maquette Image Card (Mở rộng tự nhiên, lấp đầy chiều cao còn lại) -->
            ${firstMqUrl ? `
              <div class="mobile-quote-summary-card hk-modal-mq-card rounded-xl p-4 flex flex-col flex-1 min-h-[280px] mt-0">
                <div class="text-[11px] font-bold mobile-quote-section-title mb-2.5 flex items-center justify-between flex-shrink-0">
                  <span>HÌNH ẢNH MAQUETTE / THIẾT KẾ</span>
                  <span class="text-[11px] text-sky-400 font-semibold cursor-pointer hover:underline" onclick="if (typeof openMqImagePreview === 'function') openMqImagePreview('${ksEscapeHtml(firstMqUrl)}'); else if (typeof showImageFull === 'function') showImageFull('${ksEscapeHtml(firstMqUrl)}', false);">phóng to full 100% ↗</span>
                </div>
                <div class="hk-mq-rect-box flex-1 flex items-center justify-center bg-black/60 rounded-xl overflow-hidden border border-slate-700/60 p-2 w-full cursor-pointer min-h-[230px]" onclick="if (typeof openMqImagePreview === 'function') openMqImagePreview('${ksEscapeHtml(firstMqUrl)}'); else if (typeof showImageFull === 'function') showImageFull('${ksEscapeHtml(firstMqUrl)}', false);">
                  <img src="${ksEscapeHtml(firstMqUrl)}" class="w-full h-full object-contain cursor-pointer hover:scale-[1.02] transition-transform" alt="Maquette Báo Giá">
                </div>
              </div>
            ` : `
              <div class="mobile-quote-summary-card hk-modal-mq-card rounded-xl p-4 flex flex-col items-center justify-center text-gray-500 text-xs gap-2 flex-1 min-h-[240px] mt-0">
                <svg class="w-10 h-10 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                <span>Chưa có hình ảnh Maquette</span>
              </div>
            `}
          </div>

          <!-- Right Main Area (Items Table on Desktop) -->
          <div class="hk-quote-modal-main-table hk-quote-modal-main flex flex-col flex-1 overflow-hidden p-4 lg:p-5">
            <!-- Header Bảng: Tiêu đề bên trái, Trạng thái & Tổng tiền bên phải (đúng vị trí viền đỏ) -->
            <div class="flex items-center justify-between pb-3 flex-shrink-0 gap-4 flex-wrap">
              <h3 class="text-[13px] font-bold mobile-quote-section-title uppercase tracking-wider flex-shrink-0">Danh sách hạng mục (${items.length})</h3>
              
              <!-- Cụm Trạng thái QCAG & Tổng tiền đưa lên ngang hàng tiêu đề -->
              <div class="flex items-center flex-wrap gap-x-5 gap-y-1.5 text-xs ml-auto">
                <div class="flex items-center gap-2">
                  <span class="mobile-quote-lbl text-xs font-medium">Trạng thái QCAG:</span>
                  <span class="px-2.5 py-0.5 text-xs font-bold rounded-lg border ${statusCls}">${ksEscapeHtml(statusLabel)}</span>
                </div>
                <div class="flex items-center gap-2">
                  <span class="mobile-quote-lbl text-xs font-medium">Tổng tiền:</span>
                  <span class="text-lg lg:text-xl font-extrabold mobile-quote-total-val font-numeric font-mono text-amber-400">${ksEscapeHtml(totalStr)}</span>
                </div>
                ${q.spo_number ? `
                  <div class="flex items-center gap-1.5 text-xs border-l border-gray-200 dark:border-slate-700/80 pl-3">
                    <span class="mobile-quote-lbl">Số SPO:</span>
                    <strong class="mobile-quote-val font-bold text-slate-200">${ksEscapeHtml(q.spo_number)}</strong>
                  </div>
                ` : ''}
              </div>
            </div>

            <!-- Desktop Table View -->
            <div class="flex-1 overflow-y-auto rounded-xl border hk-quote-table-wrap">
              <table class="hk-quote-desktop-table w-full">
                <thead>
                  <tr>
                    <th class="w-12 text-center whitespace-nowrap">STT</th>
                    <th class="text-left whitespace-nowrap">Tên Hạng Mục</th>
                    <th class="w-24 text-center whitespace-nowrap">Brand</th>
                    <th class="w-28 text-center whitespace-nowrap">Kích Thước</th>
                    <th class="w-20 text-center whitespace-nowrap">Số Lượng</th>
                    <th class="w-28 text-right whitespace-nowrap">Đơn Giá</th>
                    <th class="w-32 text-right whitespace-nowrap pr-6">Thành Tiền</th>
                  </tr>
                </thead>
                <tbody>
                  ${tableRowsHtml || (q._fullDetailFetched ? '<tr><td colspan="7" class="text-center py-8 text-gray-400 whitespace-nowrap">Báo giá này chưa có chi tiết hạng mục</td></tr>' : (q.quote_code ? '<tr><td colspan="7" class="text-center py-8 text-gray-400 whitespace-nowrap"><div class="inline-flex items-center gap-2"><div class="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin"></div><span>Đang tải chi tiết hạng mục...</span></div></td></tr>' : '<tr><td colspan="7" class="text-center py-8 text-gray-400 whitespace-nowrap">Không có thông tin hạng mục</td></tr>'))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Sticky Bottom Bar Desktop (Chỉ còn 2 nút bấm thao tác góc phải) -->
        <div class="mobile-quote-bottom-bar flex items-center justify-end gap-3 px-5 lg:px-6 py-3 flex-shrink-0 border-t">
          ${(() => {
            const lock = _checkRequestLockState(req || currentDetailRequest);
            if (lock.isProduced) {
              return `<button type="button" disabled class="py-2.5 px-5 rounded-xl full-mqm-edit-btn text-xs font-bold inline-flex items-center gap-2 shadow-sm w-auto flex-initial" title="${ksEscapeHtml(lock.reason)}">
                <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                <span>${ksEscapeHtml(lock.label || 'Đã ra đơn')}</span>
              </button>`;
            }
            return `<button onclick="window._editRequestOrigin='quote_modal'; openEditRequestSheet();" class="py-2.5 px-5 rounded-xl full-mqm-edit-btn text-xs font-bold active:scale-95 transition-all inline-flex items-center gap-2 shadow-md w-auto flex-initial">
              <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
              <span>Yêu cầu chỉnh sửa</span>
            </button>`;
          })()}
          <button onclick="closeFullMobileQuoteModal()" class="py-2.5 px-6 rounded-xl full-mqm-close-btn text-xs font-bold active:scale-95 transition-all shadow-sm w-auto flex-initial">
            <span>Đóng</span>
          </button>
        </div>
      </div>
    </div>
  ` : `
    <div id="fullMobileQuoteModal" class="full-mobile-quote-modal fixed inset-0 z-[6000] flex flex-col overflow-hidden animate-fadeIn select-none" style="z-index:6000">
      <!-- Fixed Sticky Header Mobile -->
      <div class="full-mqm-header sticky top-0 z-20 px-4 py-3 border-b flex items-start justify-between shadow-sm backdrop-blur-md">
        <div class="min-w-0 pr-2">
          <!-- 1. Tên Shop to nổi bật -->
          <h2 class="full-mqm-title text-base sm:text-lg font-extrabold truncate leading-tight">${ksEscapeHtml(outletName)}</h2>
          <!-- 2. Outletcode - Mã BG - Mã TK -->
          <div class="full-mqm-meta text-xs font-semibold truncate mt-1">
            <span class="full-mqm-outlet-code font-bold text-sky-400">${ksEscapeHtml(outletCode || '---')}</span>
            ${quoteCode ? `<span class="full-mqm-sep text-gray-400"> - </span><span class="full-mqm-codes">Mã BG: ${ksEscapeHtml(quoteCode)}</span>` : ''}
            ${tkCode ? `<span class="full-mqm-sep text-gray-400"> - </span><span class="full-mqm-tk text-amber-400">${ksEscapeHtml(String(tkCode).toUpperCase().startsWith('TK') ? tkCode : 'Mã TK: ' + tkCode)}</span>` : ''}
          </div>
          <!-- 3. SĐT & Địa chỉ -->
          ${phone ? `<div class="full-mqm-addr text-xs truncate mt-0.5"><span class="opacity-75">SĐT: </span><span class="font-bold text-slate-200 dark:text-slate-100">${ksEscapeHtml(phone)}</span></div>` : ''}
          ${address ? `<div class="full-mqm-addr text-xs truncate mt-0.5" title="${ksEscapeHtml(address)}"><span class="opacity-75">Địa chỉ: </span>${ksEscapeHtml(address)}</div>` : ''}
        </div>
        <button onclick="closeFullMobileQuoteModal()" class="w-9 h-9 rounded-full bg-red-600 hover:bg-red-700 active:bg-red-800 text-white flex items-center justify-center text-base font-bold shadow-md active:scale-95 flex-shrink-0" title="Đóng">✕</button>
      </div>

      <!-- Scrollable Body Mobile (Cuộn toàn bộ từ Overview -> Maquette -> Danh Sách Hạng Mục) -->
      <div class="full-mqm-body flex-1 overflow-y-auto p-4 space-y-4">
        <!-- 1. Overview: Trạng thái & Tổng tiền -->
        <div class="full-mqm-overview rounded-xl p-3.5 space-y-2.5">
          <div class="full-mqm-status-row flex items-center justify-between border-b pb-2">
            <span class="full-mqm-label text-xs font-medium">Trạng thái QCAG:</span>
            <span class="px-2.5 py-0.5 text-xs font-bold rounded-lg border ${statusCls}">${ksEscapeHtml(statusLabel)}</span>
          </div>
          <div class="flex items-center justify-between pt-0.5">
            <span class="full-mqm-label text-xs font-medium">Tổng tiền báo giá:</span>
            <span class="full-mqm-total-price text-lg font-extrabold font-numeric text-amber-400">${ksEscapeHtml(totalStr)}</span>
          </div>
          ${q.spo_number ? `
            <div class="flex items-center justify-between pt-1 border-t text-xs">
              <span class="full-mqm-label">Số SPO: <strong class="font-bold text-slate-200">${ksEscapeHtml(q.spo_number)}</strong></span>
              <span class="full-mqm-label">${q.created_by_name ? `Người tạo: ${ksEscapeHtml(q.created_by_name)}` : ''}</span>
            </div>
          ` : ''}
        </div>

        <!-- 2. HÌNH ẢNH MAQUETTE / THIẾT KẾ Section -->
        ${firstMqUrl ? `
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <h3 class="full-mqm-section-title text-xs font-bold tracking-wider uppercase">HÌNH ẢNH MAQUETTE / THIẾT KẾ</h3>
              <button type="button" onclick="if (typeof openMqImagePreview === 'function') openMqImagePreview('${ksEscapeHtml(firstMqUrl)}'); else if (typeof showImageFull === 'function') showImageFull('${ksEscapeHtml(firstMqUrl)}', false);" class="text-[11px] font-semibold text-sky-400 hover:text-sky-300 transition-colors flex items-center gap-1">phóng to full 100% ↗</button>
            </div>
            <div class="full-mqm-mq-card rounded-xl p-2.5 flex flex-col gap-2.5">
              <div class="relative w-full aspect-video bg-black/40 rounded-lg border border-gray-700/50 overflow-hidden flex items-center justify-center cursor-pointer group" onclick="if (typeof openMqImagePreview === 'function') openMqImagePreview('${ksEscapeHtml(firstMqUrl)}'); else if (typeof showImageFull === 'function') showImageFull('${ksEscapeHtml(firstMqUrl)}', false);">
                <img src="${ksEscapeHtml(firstMqUrl)}" class="full-mqm-mq-img w-full h-full object-contain transition-transform group-hover:scale-[1.02]" alt="Maquette báo giá">
              </div>
            </div>
          </div>
        ` : ''}

        <!-- 3. Danh sách hạng mục chi tiết (Cards Mobile) -->
        <div class="flex items-center justify-between pt-1">
          <h3 class="full-mqm-section-title text-xs font-bold tracking-wider uppercase">Danh sách hạng mục (${items.length})</h3>
        </div>

        <div class="space-y-2.5">
          ${itemsHtml || (q._fullDetailFetched ? '<div class="text-center py-6 text-xs text-gray-400">Báo giá này chưa có chi tiết hạng mục</div>' : (q.quote_code ? '<div class="text-center py-6 text-xs text-gray-400 flex items-center justify-center gap-2"><div class="w-3.5 h-3.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin"></div><span>Đang tải chi tiết hạng mục...</span></div>' : '<div class="text-center py-6 text-xs text-gray-400">Không có thông tin hạng mục</div>'))}
        </div>
      </div>

      <!-- Bottom Bar Mobile -->
      <div class="full-mqm-bottom-bar border-t flex items-center justify-center p-3 flex-shrink-0">
        ${(() => {
          const lock = _checkRequestLockState(req || currentDetailRequest);
          if (lock.isProduced) {
            return `<button type="button" disabled class="full-mqm-edit-btn w-full py-3.5 px-4 rounded-xl text-sm font-bold flex items-center justify-center gap-2 shadow-sm" title="${ksEscapeHtml(lock.reason)}">
              <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
              <span>${ksEscapeHtml(lock.label || 'Đã ra đơn')}</span>
            </button>`;
          }
          return `<button onclick="window._editRequestOrigin='quote_modal'; openEditRequestSheet();" class="full-mqm-edit-btn w-full py-3.5 px-4 rounded-xl text-sm font-bold active:scale-95 transition-all flex items-center justify-center gap-2 shadow-md">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
            <span>Yêu cầu chỉnh sửa</span>
          </button>`;
        })()}
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);

  // If items are empty (lite mode cached), lazy-load full quotation details ONCE asynchronously
  const hasLoadedItems = Array.isArray(items) && items.length > 0;
  if (!hasLoadedItems && !q._fullDetailFetched && (q.id || q.quote_code)) {
    const qTarget = q.quote_code ? ('quote_code=' + encodeURIComponent(q.quote_code)) : (q.id ? ('id=' + encodeURIComponent(q.id)) : '');
    if (qTarget) {
      const app1Base = 'https://qcag-backend-staging-493469512136.asia-southeast1.run.app';
      fetch(app1Base + '/quotations?' + qTarget)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          const fullQ = Array.isArray(data) ? (data.find(x => x.quote_code === q.quote_code) || data[0]) : data;
          if (fullQ) {
            fullQ._fullDetailFetched = true;
            // Cache full details to prevent repeated network transfers
            if (backendId) window._quoteDataMap[backendId] = fullQ;
            if (fullQ.quote_code) window._quoteDataMap[fullQ.quote_code] = fullQ;
            const currentModal = document.getElementById('fullMobileQuoteModal');
            if (currentModal) {
              openFullMobileQuoteModal(backendId, fullQ);
            }
          }
        })
        .catch(err => {
          console.warn('Lazy quote fetch warning:', err);
          q._fullDetailFetched = true;
        });
    }
  }

  // Hide floating FAB edit button while quote modal is open
  try {
    const fab = document.getElementById('editRequestFab');
    if (fab) fab.classList.add('hidden');
  } catch (_) { }
}

function closeFullMobileQuoteModal() {
  const modal = document.getElementById('fullMobileQuoteModal');
  if (modal) modal.remove();

  // Đóng luôn viewer ảnh MQ (nếu có) để hiện lại danh sách đúng như yêu cầu
  if (typeof closeDvZoom === 'function') {
    closeDvZoom();
  }
  if (typeof closeDesignModal === 'function') {
    closeDesignModal();
  }

  // Nút Yêu cầu chỉnh sửa đã di dời cố định lên header Maquette; đảm bảo nút bottom FAB không bao giờ hiện lại
  try {
    const fab = document.getElementById('editRequestFab');
    if (fab) fab.remove();
  } catch (_) { }
}

window.openFullMobileQuoteModal = openFullMobileQuoteModal;
window.closeFullMobileQuoteModal = closeFullMobileQuoteModal;

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
    const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(ua);
    if (isMobile && typeof ksBuildQuotePreviewSvgDataUrl === 'function') {
      try {
        src = ksBuildQuotePreviewSvgDataUrl(data);
      } catch (e) {
        src = null;
      }
    }
    // Chỉ kích hoạt overlay nếu cần render canvas nặng (chạy bất đồng bộ)
    if (!src) {
      if (typeof showLoadingOverlay === 'function') {
        showLoadingOverlay('Đang mở preview báo giá...', 'Đang render ảnh');
      }
      try {
        src = await ksBuildQuotePreviewImageDataUrl(data);
      } finally {
        if (typeof hideLoadingOverlay === 'function') {
          hideLoadingOverlay();
        }
      }
    }
    if (src) {
      window.__ksQuoteRenderImageCache = window.__ksQuoteRenderImageCache || {};
      window.__ksQuoteRenderImageCache[key] = src;
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
      } catch (e) { }
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
  } catch (e) { }
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
    // FAB bottom đã được di dời lên header Maquette; giữ luôn hidden
    try {
      const fab = document.getElementById('editRequestFab');
      if (fab) fab.classList.add('hidden');
      detachFabListeners();
    } catch (e) { }
  } else {
    commentBtn.classList.add('active');
    detailBtn.classList.remove('active');
    mainCol.style.display = 'none';
    commentsCol.style.display = '';
    if (detailContent) detailContent.classList.add('chat-mode');
    // FAB bottom đã được di dời lên header Maquette; giữ luôn hidden
    try {
      const fab = document.getElementById('editRequestFab');
      if (fab) fab.classList.add('hidden');
      detachFabListeners();
    } catch (e) { }
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
    closeEditRequestSheet();
  } catch (e) { }
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
  } catch (e) { }
  const files = Array.from(input.files);
  if (!files || files.length === 0) return;
  const file = files[files.length - 1];

  showLoadingOverlay('Đang upload thiết kế...', 'Vui lòng chờ trong giây lát');

  // Determine GCS subfolder: use mqFolder from request (e.g. 'mq-12345678'),
  // or fall back to generating from outletCode
  const mqSubfolder = currentDetailRequest.mqFolder ||
    ('mq-' + String(currentDetailRequest.outletCode || 'NEWOUTLET').replace(/[^a-zA-Z0-9]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 32));

  // Compress immediately (WebP preferred) — much faster upload
  let dataUrl;
  try {
    dataUrl = await _compressImageFile(file, 2048, 0.88);
  } catch (_) {
    dataUrl = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
  }

  let finalUrl = dataUrl;
  // Upload compressed image to GCS
  if (window.dataSdk && window.dataSdk.uploadImage && currentDetailRequest.__backendId) {
    try {
      const uploaded = await window.dataSdk.uploadImage(dataUrl, file.name || 'mq.webp', currentDetailRequest.__backendId, mqSubfolder);
      if (typeof uploaded === 'string' && uploaded.trim()) {
        finalUrl = uploaded;
      } else if (uploaded && typeof uploaded.url === 'string' && uploaded.url.trim()) {
        finalUrl = uploaded.url;
      }
    } catch (e) {
      console.warn('[detail-flow] uploadDesign GCS failed, keeping base64:', e);
    }
  }

  const updated = {
    __backendId: currentDetailRequest.__backendId,
    designImages: JSON.stringify([finalUrl]),
    designFilename: file.name,
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

function qcagRefreshDesignModalComments(request) {
  try {
    const comments = safeParseComments(request ? request.comments : null, []);
    const commentsEl = document.getElementById('designComments');
    if (commentsEl) {
      if (!comments || comments.length === 0) {
        commentsEl.innerHTML = '<div class="text-sm text-gray-400">Chưa có bình luận</div>';
      } else {
        commentsEl.innerHTML = comments.map(c => {
          const isEditReq = String(c.commentType || '').toLowerCase() === 'edit-request';
          const isResolved = String(c.commentType || '').toLowerCase() === 'edit-resolved';
          const cImgs = Array.isArray(c.images) ? c.images : [];
          const catsArr = Array.isArray(c.editCategories) ? c.editCategories : [];
          return `
          <div class="comment-item">
            <div class="comment-meta"><strong>${escapeHtml(c.authorName || c.authorRole || 'Người dùng')}</strong> <span class="comment-role">${escapeHtml(c.authorRole || '')}</span> <span class="comment-time">${new Date(c.createdAt).toLocaleString('vi-VN')}</span></div>
            ${isEditReq ? `<div class="cer-tag-inline" style="margin-bottom:4px;"><span class="cer-tag-main">Yêu cầu chỉnh sửa</span></div>` : ''}
            ${isResolved ? `<div class="cer-tag-inline" style="margin-bottom:4px;"><span class="cer-tag-main" style="background:#10b981;color:#fff;">Đã chỉnh sửa</span></div>` : ''}
            ${catsArr.length > 0 ? `<div class="cer-cats-inline" style="margin-bottom:4px;">${catsArr.map(ct => escapeHtml(ct)).join(', ')}</div>` : ''}
            <div class="comment-body">${escapeHtml(c.text || '')}</div>
            ${cImgs.length > 0 ? `<div class="comment-imgs" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${cImgs.map(img => `<img src="${escapeHtml(img)}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;cursor:pointer;" onclick="showImageFull(this.src,false)">`).join('')}</div>` : ''}
          </div>
        `;
        }).join('');
      }
      // auto-scroll to bottom of comments
      setTimeout(() => { if (commentsEl) commentsEl.scrollTop = commentsEl.scrollHeight; }, 30);
    }
  } catch (e) { /* ignore */ }
}
window.qcagRefreshDesignModalComments = qcagRefreshDesignModalComments;

async function viewDesign(id) {
  let request = allRequests.find(r => r.__backendId === id);
  if (!request) return;
  // ownership enforcement: only the creator can view design images
  if (!isRequestOwnedByCurrentSession(request)) {
    showToast('Không có quyền xem yêu cầu này');
    return;
  }

  // Fetch real URLs first if placeholder
  let designImages = request.designImages || '[]';
  if (designImages === '["..."]' && window.dataSdk && typeof window.dataSdk.getOne === 'function') {
    try {
      const r = await window.dataSdk.getOne(id);
      if (r && r.isOk && r.data) {
        request = Object.assign({}, request, r.data);
        ['designImages', 'oldContentImages', 'statusImages', 'acceptanceImages'].forEach(k => {
          if (request[k] === '["..."]') request[k] = '[]';
        });
        const idx = allRequests.findIndex(x => x && (x.__backendId === id || x.id === id));
        if (idx !== -1) allRequests[idx] = request;
      }
    } catch (e) { /* fall through */ }
  }

  let designImgs = [];
  try {
    designImgs = (Array.isArray(request.designImages) ? request.designImages : JSON.parse(request.designImages || '[]')).filter(u => u && u !== '...');
  } catch (_) {
    designImgs = [];
  }

  if (designImgs.length > 0) {
    window._dv_currentDesignReq = request;
    showImageFull(designImgs, true, 0);
  } else {
    showToast('Yêu cầu này chưa có ảnh MQ');
  }
}

function closeDesignModal() {
  const modal = document.getElementById('designModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.style.display = 'none';
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

  window._zoomRotationCache = window._zoomRotationCache || {};
  let rotationAngle = window._zoomRotationCache[src] || 0;

  const req = window._dv_currentDesignReq || (typeof currentDetailRequest !== 'undefined' ? currentDetailRequest : null);

  let outletName = 'Bản vẽ Maquette';
  let outletCode = '---';
  let address = '';
  let itemsHtml = '';
  let saleName = 'Chưa có';
  let designerName = 'Chưa có';
  let createdDateStr = '';
  let statusBadgeText = 'Đã có MQ';
  let qcagBadge = { label: 'Chưa có báo giá', cls: 'hk-status-badge hk-status-amber bg-amber-500/20 text-amber-300 border border-amber-500/40' };
  let qData = null;

  if (req) {
    outletName = req.outletName || 'Bản vẽ Maquette';
    outletCode = req.outletCode || '---';
    address = req.address || '';

    // Lấy qData từ cache và bridge
    const targetTk = String(req.tkCode || req.tk_code || '').trim().toLowerCase();
    const targetQuote = String(req.quoteCode || req.quote_code || '').trim();
    const targetBackendId = req.__backendId || req.id;

    if (window._quoteDataMap) {
      if (targetBackendId && window._quoteDataMap[targetBackendId]) qData = window._quoteDataMap[targetBackendId];
      if (!qData && targetQuote && window._quoteDataMap[targetQuote]) qData = window._quoteDataMap[targetQuote];
      if (!qData && targetTk && window._quoteDataMap[targetTk]) qData = window._quoteDataMap[targetTk];
    }
    if (!qData && req.bridge) qData = req.bridge;
    if (!qData && typeof window !== 'undefined' && Array.isArray(window.__qcagQuoteListCache)) {
      qData = window.__qcagQuoteListCache.find(q => q && (
        (targetQuote && (String(q.quote_code || q.quoteCode || '').trim() === targetQuote)) ||
        (targetTk && (String(q.tk_code || q.tkCode || '').trim().toLowerCase() === targetTk))
      ));
    }

    // QCAG Status resolution
    if (typeof getCardQuoteBadge === 'function') {
      const b = getCardQuoteBadge(req);
      if (b && b.label && b.label !== '...') {
        qcagBadge = b;
      }
    }
    if (!qcagBadge || qcagBadge.label === 'Chưa có báo giá') {
      if (qData) {
        qcagBadge = _resolveQcagStatus(qData);
      } else if (req.type === 'warranty') {
        qcagBadge = { label: 'Bảo hành', cls: 'hk-status-badge hk-status-amber bg-amber-500/20 text-amber-300 border border-amber-500/40' };
      } else if (req.delete_requested || req.deleteRequested) {
        qcagBadge = { label: 'Chờ xóa', cls: 'hk-status-badge hk-status-red bg-red-600/30 text-red-300 border border-red-500/50' };
      } else {
        qcagBadge = _resolveQcagStatus(null);
      }
    }

    // Items - bóc tách chi tiết từng hạng mục
    try {
      const parsedItems = typeof req.items === 'string' ? JSON.parse(req.items || '[]') : (req.items || []);
      if (Array.isArray(parsedItems) && parsedItems.length > 0) {
        itemsHtml = parsedItems.map((it, idx) => {
          const itType = it.type || it.itemType || it.category || it.name || `Hạng mục ${idx + 1}`;
          const itAction = it.action && it.action !== '-' ? it.action : '';
          const itBrand = it.brand && it.brand !== '-' ? it.brand : '';

          let dims = '';
          if (it.survey) {
            dims = 'Khảo sát';
          } else if (it.useOldSize) {
            dims = 'KT cũ';
          } else if ((it.width || it.w) && (it.height || it.h)) {
            dims = `${it.width || it.w}m × ${it.height || it.h}m`;
          } else if (it.dimensions) {
            dims = it.dimensions;
          }

          const poles = (it.poles !== undefined && it.poles !== null && it.poles !== '' && Number(it.poles) > 0) ? `${it.poles} trụ` : '';
          const note = it.type === 'Hạng mục khác' ? (it.otherContent || '') : (it.note || it.notes || '');

          return `
            <div class="dv-zoom-item-card">
              <div class="dv-zoom-item-header">
                <span class="dv-zoom-item-num">${idx + 1}</span>
                <span class="dv-zoom-item-title">${escapeHtml(itType)}</span>
                ${itAction ? `<span class="dv-zoom-item-tag action">${escapeHtml(itAction)}</span>` : ''}
              </div>
              <div class="dv-zoom-item-pills">
                ${itBrand ? `<span class="dv-zoom-item-pill brand"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path></svg>${escapeHtml(itBrand)}</span>` : ''}
                ${dims ? `<span class="dv-zoom-item-pill dims"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>${escapeHtml(dims)}</span>` : ''}
                ${poles ? `<span class="dv-zoom-item-pill poles">${escapeHtml(poles)}</span>` : ''}
              </div>
              ${note ? `<div class="dv-zoom-item-note"><span class="opacity-60">Ghi chú:</span> ${escapeHtml(note)}</div>` : ''}
            </div>
          `;
        }).join('');
      }
    } catch (_) { }
    if (!itemsHtml) {
      itemsHtml = '<div class="dv-zoom-item-card"><div class="dv-zoom-item-header"><span class="dv-zoom-item-title">Chưa có thông tin hạng mục</span></div></div>';
    }

    // Personnel
    try {
      const requester = typeof req.requester === 'string' ? JSON.parse(req.requester || '{}') : (req.requester || {});
      saleName = requester.saleName || requester.name || req.saleName || requester.phone || 'Chưa có';
    } catch (_) {
      saleName = req.saleName || 'Chưa có';
    }
    designerName = req.designCreatedBy || req.designLastEditedBy || req.designerName || 'Chưa có';
    if (req.createdAt) {
      try { createdDateStr = new Date(req.createdAt).toLocaleDateString('vi-VN'); } catch (_) { }
    }
  }

  const isQcag = (typeof isQCAGSession === 'function' && isQCAGSession()) ||
                 (typeof currentSession !== 'undefined' && currentSession && String(currentSession.role || '').toLowerCase() === 'qcag');
  const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 1024;
  const isHeinekenRole = typeof currentSession !== 'undefined' && currentSession && String(currentSession.role || '').toLowerCase() === 'heineken';

  // Sidebar chi tiết thiết kế ("dv-zoom-right-col") CHỈ DÀNH RIÊNG cho Sale Heineken trên Desktop xem bản vẽ Maquette (showContent === true)
  // Toàn bộ màn hình QCAG Desktop và các loại ảnh album / hiện trạng / nghiệm thu / chat:
  // TUYỆT ĐỐI dùng giao diện Center Canvas nguyên bản của QCAG, căn giữa toàn màn hình!
  const shouldShowRightCol = isHeinekenRole && isDesktop && Boolean(showContent) && Boolean(req);

  const overlay = document.createElement('div');
  overlay.id = 'dvZoomOverlay';

  const hasDesignReq = Boolean(req && (req.tkCode || req.outletName || window._dv_currentDesignReq));

  if (!shouldShowRightCol) {
    // ── GIAO DIỆN CENTER CANVAS NGUYÊN BẢN CỦA QCAG (Không lệch 1 bên, đầy đủ nút tròn góc phải) ──
    overlay.className = 'dv-zoom-classic-center';
    overlay.innerHTML = `
      <img id="dvZoomImg" src="${src}" class="dv-zoom-img" draggable="false" style="opacity:0;transition:opacity .18s ease" decoding="async">
      <button type="button" class="dv-zoom-close" title="Đóng (Esc)">✕</button>
      <button type="button" class="dv-zoom-dvhc-btn" id="dvZoomDvhcBtn" title="Tra cứu ĐVHC">🗺️</button>
      <button type="button" class="dv-zoom-rotate-btn rotate-right" id="dvZoomRotateRight" title="Xoay phải 90° ↻">↻</button>
      <button type="button" class="dv-zoom-rotate-btn rotate-left" id="dvZoomRotateLeft" title="Xoay trái 90° ↺">↺</button>
      <button type="button" class="dv-zoom-copy-btn" id="dvZoomCopyBtn" title="Sao chép ảnh vào Clipboard (Ctrl+C)">⎘</button>
      <div class="dv-zoom-scale" id="dvZoomScale">100%</div>
      <div class="dv-zoom-hint">Cuộn chuột để phóng to • Kéo để di chuyển • Nhấp đúp để đặt lại</div>
      ${imgs.length > 1 ? `
      <button type="button" id="dvZoomPrevBtn" class="dv-zoom-nav-btn prev" title="Ảnh trước">❮</button>
      <button type="button" id="dvZoomNextBtn" class="dv-zoom-nav-btn next" title="Ảnh sau">❯</button>
      ` : ''}
    `;

    // Thanh hành động dưới đáy cho Mobile nếu xem Maquette
    if (showContent && !isDesktop) {
      const showContentBar = document.createElement('div');
      showContentBar.className = 'dv-zoom-bottom';
      const inner = document.createElement('div');
      inner.className = 'dv-zoom-bottom-inner';

      if (isHeinekenRole) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'dv-zoom-btn dv-zoom-btn-edit';
        editBtn.innerHTML = '<svg class="dv-zoom-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg><span>Yêu cầu chỉnh sửa</span>';
        editBtn.onclick = (e) => {
          try { e.stopPropagation(); } catch (ex) { }
          window._editRequestOrigin = 'design';
          if (window._dv_currentDesignReq) currentDetailRequest = window._dv_currentDesignReq;
          openEditRequestSheet();
        };
        inner.appendChild(editBtn);
      }

      const shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'dv-zoom-btn dv-zoom-btn-share';
      shareBtn.innerHTML = '<svg class="dv-zoom-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg><span>Chia sẻ Zalo</span>';
      shareBtn.onclick = async (e) => {
        try { e.stopPropagation(); } catch (ex) { }
        _handleZoomShare(imgs[currentIndex], req);
      };
      inner.appendChild(shareBtn);

      if (req && (req.__backendId || req.id || req.tkCode || req.quoteCode)) {
        const quoteBtn = document.createElement('button');
        quoteBtn.type = 'button';
        quoteBtn.className = 'dv-zoom-btn dv-zoom-btn-quote';
        quoteBtn.innerHTML = '<svg class="dv-zoom-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"></path></svg><span>Xem chi tiết báo giá</span>';
        quoteBtn.onclick = (e) => {
          try { e.stopPropagation(); } catch (ex) { }
          const targetId = req.__backendId || req.id || req.tkCode || req.tk_code;
          const quoteObj = qData || (req && req.bridge) || (window._quoteDataMap && targetId ? window._quoteDataMap[targetId] : null);
          if (typeof openFullMobileQuoteModal === 'function') {
            openFullMobileQuoteModal(targetId, quoteObj);
          } else if (typeof window.openFullMobileQuoteModal === 'function') {
            window.openFullMobileQuoteModal(targetId, quoteObj);
          }
        };
        inner.appendChild(quoteBtn);
      }
      showContentBar.appendChild(inner);
      overlay.appendChild(showContentBar);
    }
  } else {
    // ── GIAO DIỆN 2 CỘT SPLIT VIEW RIÊNG CHO HEINEKEN SALE TRÊN DESKTOP ──
    overlay.className = 'dv-zoom-split-layout';
    overlay.innerHTML = `
      <!-- CỘT TRÁI: Fit 90%, Zoom 1000%, Kéo tự do -->
      <div class="dv-zoom-left-col" id="dvZoomLeftCol">
        <div class="dv-zoom-viewport" id="dvZoomViewport">
          <img id="dvZoomImg" src="${src}" class="dv-zoom-img" draggable="false" style="opacity:0;transition:opacity .18s ease" decoding="async">
        </div>

        <button type="button" class="dv-zoom-close" title="Đóng (Esc)">✕</button>
        <button type="button" class="dv-zoom-dvhc-btn" id="dvZoomDvhcBtn" title="Tra cứu ĐVHC">🗺️</button>
        <button type="button" class="dv-zoom-rotate-btn rotate-right" id="dvZoomRotateRight" title="Xoay phải 90° ↻">↻</button>
        <button type="button" class="dv-zoom-rotate-btn rotate-left" id="dvZoomRotateLeft" title="Xoay trái 90° ↺">↺</button>
        <button type="button" class="dv-zoom-copy-btn" id="dvZoomCopyBtn" title="Sao chép ảnh vào Clipboard (Ctrl+C)">⎘</button>
        <div class="dv-zoom-scale" id="dvZoomScale">100%</div>

        <!-- Navigation mũi tên -->
        ${imgs.length > 1 ? `
        <button type="button" id="dvZoomPrevBtn" class="dv-zoom-nav-btn prev" title="Ảnh trước">❮</button>
        <button type="button" id="dvZoomNextBtn" class="dv-zoom-nav-btn next" title="Ảnh sau">❯</button>
        ` : ''}

        <!-- Filmstrip dải ảnh đáy nếu có nhiều ảnh -->
        ${imgs.length > 1 ? `
        <div class="dv-zoom-filmstrip">
          ${imgs.map((im, idx) => `
            <div class="dv-zoom-film-card ${idx === currentIndex ? 'active' : ''}" onclick="window._dvSwitchZoomImg(${idx})" title="Ảnh ${idx + 1}">
              <img src="${im}" alt="Ảnh ${idx + 1}">
            </div>
          `).join('')}
        </div>
        ` : ''}
      </div>

      <!-- CỘT PHẢI: CHI TIẾT THIẾT KẾ CHO HEINEKEN SALE -->
      <div class="dv-zoom-right-col" id="dvZoomRightCol">
        <div class="dv-zoom-panel-header">
          <div class="dv-zoom-header-top">
            <h3 class="dv-zoom-panel-title">Chi Tiết Thiết Kế</h3>
            <button type="button" class="dv-zoom-close dv-zoom-close-desktop" title="Đóng (Esc)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
          <div class="dv-zoom-qcag-status-row">
            <span class="dv-zoom-qcag-label">Trạng thái QCAG:</span>
            <span class="dv-zoom-qcag-badge ${qcagBadge.cls}">${escapeHtml(qcagBadge.label)}</span>
          </div>
        </div>

        <div class="dv-zoom-panel-body">
          <div class="dv-zoom-info-card">
            <div class="dv-zoom-card-label">THÔNG TIN OUTLET</div>
            <div class="dv-zoom-outlet-name">${escapeHtml(outletName)}</div>
            <div class="dv-zoom-outlet-code">
              <span class="opacity-70">Outlet Code:</span>
              <strong>${escapeHtml(outletCode)}</strong>
            </div>
            ${address ? `<div class="dv-zoom-address"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg><span>${escapeHtml(address)}</span></div>` : ''}
          </div>

          <div class="dv-zoom-info-card">
            <div class="dv-zoom-card-label">HẠNG MỤC THIẾT KẾ</div>
            <div class="dv-zoom-item-list">
              ${itemsHtml}
            </div>
          </div>

          <div class="dv-zoom-info-card">
            <div class="dv-zoom-card-label">TIẾN ĐỘ & NHÂN SỰ</div>
            <div class="dv-zoom-meta-row">
              <span>Người gửi (Sale):</span>
              <strong>${escapeHtml(saleName)}</strong>
            </div>
            <div class="dv-zoom-meta-row">
              <span>Thiết kế (QCAG):</span>
              <strong>${escapeHtml(designerName)}</strong>
            </div>
            ${createdDateStr ? `<div class="dv-zoom-meta-row"><span>Ngày gửi:</span><strong>${createdDateStr}</strong></div>` : ''}
          </div>
        </div>

        <div class="dv-zoom-panel-footer">
          <button type="button" class="dv-zoom-btn dv-zoom-btn-edit" id="dvPanelBtnEdit">
            <svg class="dv-zoom-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            <span>Yêu cầu chỉnh sửa</span>
          </button>
          <button type="button" class="dv-zoom-btn dv-zoom-btn-share" id="dvPanelBtnShare">
            <svg class="dv-zoom-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
            <span>Chia sẻ Zalo</span>
          </button>
          ${req && req.__backendId ? `
          <button type="button" class="dv-zoom-btn dv-zoom-btn-quote" id="dvPanelBtnQuote">
            <svg class="dv-zoom-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"></path></svg>
            <span>Xem chi tiết báo giá</span>
          </button>
          ` : ''}
        </div>
      </div>
    `;
  }

  async function _handleZoomShare(targetSrc, requestObj) {
    showToast('Đang chuẩn bị ảnh chia sẻ...');
    try {
      const backendBase = (window.__env && window.__env.BACKEND_URL) || 'https://ks-backend-staging-493469512136.asia-southeast1.run.app';
      const useProxy = targetSrc.startsWith('http') && !targetSrc.startsWith(window.location.origin) && !targetSrc.includes('localhost') && !targetSrc.includes('127.0.0.1');
      const targetUrl = useProxy
        ? `${backendBase}/api/ks/proxy-image?url=${encodeURIComponent(targetSrc)}`
        : targetSrc;

      const response = await fetch(targetUrl);
      if (!response.ok) throw new Error('Tải ảnh thất bại');
      const originalBlob = await response.blob();

      const imgObj = new Image();
      imgObj.crossOrigin = 'anonymous';
      const blobUrl = URL.createObjectURL(originalBlob);

      const jpegBlob = await new Promise((resolve, reject) => {
        imgObj.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = imgObj.naturalWidth || imgObj.width;
            canvas.height = imgObj.naturalHeight || imgObj.height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(imgObj, 0, 0);
            canvas.toBlob(b => {
              if (b) resolve(b);
              else reject(new Error('Canvas to Blob failed'));
            }, 'image/jpeg', 0.92);
          } catch (err) { reject(err); }
        };
        imgObj.onerror = () => reject(new Error('Load image failed'));
        imgObj.src = blobUrl;
      });

      URL.revokeObjectURL(blobUrl);

      const tkCode = requestObj ? (requestObj.tkCode || requestObj.tk_code) : 'design';
      const filename = `MQ_${tkCode}.jpg`;
      const file = new File([jpegBlob], filename, { type: 'image/jpeg' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: `Maquette ${requestObj?.outletName || ''}`,
          text: `Thiết kế Maquette: ${requestObj?.outletName || ''}`
        });
        return;
      }

      // Desktop / unsupported Web Share fallback:
      // Try copying PNG image directly to clipboard for Zalo PC paste (Ctrl+V)
      let copied = false;
      if (navigator.clipboard && window.ClipboardItem) {
        try {
          const pngBlob = await new Promise((resolve, reject) => {
            const canvas = document.createElement('canvas');
            canvas.width = imgObj.naturalWidth || imgObj.width;
            canvas.height = imgObj.naturalHeight || imgObj.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imgObj, 0, 0);
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas PNG failed')), 'image/png');
          });
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
          copied = true;
          showToast('Đã sao chép ảnh vào Clipboard! Bạn có thể dán (Ctrl+V) vào Zalo.');
        } catch (clipErr) {
          console.warn('Clipboard image copy failed, using link fallback:', clipErr);
        }
      }

      if (!copied) {
        await navigator.clipboard.writeText(targetSrc);
        showToast('Đã sao chép liên kết hình ảnh vào bộ nhớ tạm!');
      }
    } catch (err) {
      try {
        await navigator.clipboard.writeText(targetSrc);
        showToast('Đã sao chép liên kết hình ảnh!');
      } catch (_) {
        showToast('Không thể chia sẻ hình ảnh');
      }
    }
  }

  document.body.appendChild(overlay);

  // Wire up all close buttons (both mobile and desktop)
  try {
    overlay.querySelectorAll('.dv-zoom-close').forEach(cb => {
      cb.addEventListener('click', (ev) => {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (ex) { }
        closeDvZoom();
        closeDesignModal();
      });
    });
  } catch (e) { /* ignore */ }

  let scale = 1, tx = 0, ty = 0;
  const MAX = 10, MIN = 0.5; // Up to 1000% zoom
  let isDragging = false, dragStartX = 0, dragStartY = 0;
  let lastDist = null;
  let lastTap = 0;

  const img = document.getElementById('dvZoomImg');
  const scaleEl = document.getElementById('dvZoomScale');
  if (img) {
    apply(false);
  }

  // Fade in once loaded
  if (img) {
    img.onload = () => { img.style.opacity = '1'; };
    img.onerror = () => { img.style.opacity = '1'; };
    if (img.complete) {
      img.style.opacity = '1';
    }
  }

  function apply(animated) {
    img.style.transition = animated ? 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rotationAngle}deg)`;
    const pct = Math.round(scale * 100);
    if (scaleEl) scaleEl.textContent = pct + '%';
  }

  function clamp() {
    if (scale <= 1) { tx = 0; ty = 0; return; }
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const padX = Math.max((scale - 1) * vpW * 0.65, 250);
    const padY = Math.max((scale - 1) * vpH * 0.65, 250);
    tx = Math.max(-padX, Math.min(padX, tx));
    ty = Math.max(-padY, Math.min(padY, ty));
  }

  // Nút Tra cứu ĐVHC
  const dvhcBtns = overlay.querySelectorAll('.dv-zoom-dvhc-btn, #dvZoomDvhcBtn');
  dvhcBtns.forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (typeof qcagDesktopToggleDVHCLookup === 'function') {
        qcagDesktopToggleDVHCLookup();
      }
    };
  });

  // Nút Xoay phải 90°
  const rotateRightBtns = overlay.querySelectorAll('.dv-zoom-rotate-btn.rotate-right, #dvZoomRotateRight, #dvToolRotateRight');
  rotateRightBtns.forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      rotationAngle = (rotationAngle + 90) % 360;
      window._zoomRotationCache[imgs[currentIndex]] = rotationAngle;
      apply(true);
    };
  });

  // Nút Xoay trái 90°
  const rotateLeftBtns = overlay.querySelectorAll('.dv-zoom-rotate-btn.rotate-left, #dvZoomRotateLeft, #dvToolRotateLeft');
  rotateLeftBtns.forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      rotationAngle = (rotationAngle - 90 + 360) % 360;
      window._zoomRotationCache[imgs[currentIndex]] = rotationAngle;
      apply(true);
    };
  });

  // Nút Sao chép ảnh vào Clipboard
  const copyBtns = overlay.querySelectorAll('.dv-zoom-copy-btn, #dvZoomCopyBtn, #dvToolCopy');
  copyBtns.forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (typeof qcagCopyImageToClipboard === 'function') {
        qcagCopyImageToClipboard(imgs[currentIndex], img, btn);
      } else {
        try {
          navigator.clipboard.writeText(imgs[currentIndex]);
          showToast('Đã sao chép liên kết hình ảnh!');
        } catch (_) {
          showToast('Không thể sao chép hình ảnh');
        }
      }
    };
  });


  // Floating Tools Bar actions (nếu có trên giao diện Heineken Split)
  const toolFit = overlay.querySelector('#dvToolFit');
  if (toolFit) {
    toolFit.onclick = (e) => {
      e.stopPropagation();
      scale = 1; tx = 0; ty = 0; apply(true);
    };
  }
  const tool100 = overlay.querySelector('#dvTool100');
  if (tool100) {
    tool100.onclick = (e) => {
      e.stopPropagation();
      scale = 1; tx = 0; ty = 0; apply(true);
    };
  }
  const toolZoomIn = overlay.querySelector('#dvToolZoomIn');
  if (toolZoomIn) {
    toolZoomIn.onclick = (e) => {
      e.stopPropagation();
      scale = Math.min(MAX, scale * 1.25); clamp(); apply(true);
    };
  }
  const toolZoomOut = overlay.querySelector('#dvToolZoomOut');
  if (toolZoomOut) {
    toolZoomOut.onclick = (e) => {
      e.stopPropagation();
      scale = Math.max(MIN, scale * 0.8); clamp(); apply(true);
    };
  }
  const toolDownload = overlay.querySelector('#dvToolDownload');
  if (toolDownload) {
    toolDownload.onclick = (e) => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = src;
      const dlName = (req && req.tkCode) ? `${req.tkCode}_${currentIndex + 1}.jpg` : `image_${currentIndex + 1}.jpg`;
      a.download = dlName;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
  }

  // Panel footer action buttons (Heineken Split)
  const panelBtnEdit = overlay.querySelector('#dvPanelBtnEdit');
  if (panelBtnEdit) {
    panelBtnEdit.onclick = (e) => {
      try { e.stopPropagation(); } catch (ex) { }
      window._editRequestOrigin = 'design';
      if (req) currentDetailRequest = req;
      openEditRequestSheet();
    };
  }
  const panelBtnShare = overlay.querySelector('#dvPanelBtnShare');
  if (panelBtnShare) {
    panelBtnShare.onclick = (e) => {
      try { e.stopPropagation(); } catch (ex) { }
      _handleZoomShare(imgs[currentIndex], req);
    };
  }
  const panelBtnQuote = overlay.querySelector('#dvPanelBtnQuote');
  if (panelBtnQuote && req) {
    panelBtnQuote.onclick = (e) => {
      try { e.stopPropagation(); } catch (ex) { }
      const targetId = req.__backendId || req.id || req.tkCode || req.tk_code;
      const quoteObj = qData || (req && req.bridge) || (window._quoteDataMap && targetId ? window._quoteDataMap[targetId] : null);
      if (typeof openFullMobileQuoteModal === 'function') {
        openFullMobileQuoteModal(targetId, quoteObj);
      } else if (typeof window.openFullMobileQuoteModal === 'function') {
        window.openFullMobileQuoteModal(targetId, quoteObj);
      }
    };
  }

  window._dvSwitchZoomImg = (idx) => {
    if (idx >= 0 && idx < imgs.length) {
      currentIndex = idx;
      scale = 1; tx = 0; ty = 0;
      img.src = imgs[idx];
      img.style.opacity = '0';
      rotationAngle = window._zoomRotationCache[imgs[idx]] || 0;
      setTimeout(() => { img.style.opacity = '1'; apply(true); }, 80);
      overlay.querySelectorAll('.dv-zoom-film-card').forEach((c, i) => {
        c.classList.toggle('active', i === idx);
      });
    }
  };

  overlay.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.88;
    scale = Math.max(MIN, Math.min(MAX, scale * factor));
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

  img.addEventListener('dblclick', () => {
    if (scale > 1) {
      scale = 1; tx = 0; ty = 0; apply(true);
    } else {
      scale = 2; clamp(); apply(true);
    }
  });

  function navigateZoom(dir) {
    if (imgs.length <= 1) return;
    currentIndex = (currentIndex + dir + imgs.length) % imgs.length;
    rotationAngle = window._zoomRotationCache[imgs[currentIndex]] || 0;
    if (scale > 1) { scale = 1; tx = 0; ty = 0; }
    img.style.opacity = '0';
    setTimeout(() => {
      img.onload = () => { img.style.opacity = '1'; };
      img.src = imgs[currentIndex];
      apply(true);
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
    if (e.key === 'Escape') {
      closeDvZoom();
      if (typeof closeDesignModal === 'function') closeDesignModal();
      document.removeEventListener('keydown', onKey);
    }
    if (e.key === 'ArrowLeft' && scale === 1) { navigateZoom(-1); }
    if (e.key === 'ArrowRight' && scale === 1) { navigateZoom(1); }
  }
  document.addEventListener('keydown', onKey);
}

function closeDvZoom() {
  const overlay = document.getElementById('dvZoomOverlay');
  if (overlay) overlay.remove();
  try { window._dv_lastClosedAt = Date.now(); } catch (e) { /* ignore */ }
  if (typeof closeDesignModal === 'function') {
    closeDesignModal();
  }
}

// ── Delete Approval Flow Handlers ─────────────────────────────────────

function deleteCurrentRequest() {
  if (!currentDetailRequest) return;
  const lock = _checkRequestLockState(currentDetailRequest);
  if (lock.isDeletePending) {
    showToast('Yêu cầu này đang chờ QCAG duyệt xóa!');
    return;
  }
  if (lock.isProduced) {
    showToast(lock.reason || 'Yêu cầu đã ra đơn hàng hoặc đang sản xuất, không thể yêu cầu xóa!');
    return;
  }

  const reasonInput = document.getElementById('deleteReasonInput');
  const errorMsg = document.getElementById('deleteReasonError');
  if (reasonInput) {
    reasonInput.value = '';
    reasonInput.style.borderColor = '';
  }
  if (errorMsg) errorMsg.classList.add('hidden');
  document.getElementById('deleteModal').classList.remove('hidden');
  setTimeout(() => { if (reasonInput) reasonInput.focus(); }, 150);
}

function closeDeleteModal() {
  const modal = document.getElementById('deleteModal');
  if (modal) modal.classList.add('hidden');
  const errorMsg = document.getElementById('deleteReasonError');
  if (errorMsg) errorMsg.classList.add('hidden');
}

async function confirmDeleteRequest() {
  if (!currentDetailRequest || !window.dataSdk) {
    showToast('Không thể gửi yêu cầu xóa');
    closeDeleteModal();
    return;
  }
  const reasonInput = document.getElementById('deleteReasonInput');
  const errorMsg = document.getElementById('deleteReasonError');
  const reason = (reasonInput ? reasonInput.value : '').trim();
  if (!reason) {
    if (reasonInput) {
      reasonInput.style.borderColor = '#ef4444';
      reasonInput.focus();
    }
    if (errorMsg) errorMsg.classList.remove('hidden');
    return;
  }

  const reqSnapshot = currentDetailRequest;
  const sess = (typeof currentSession !== 'undefined' && currentSession) ? currentSession : {};
  const saleName = sess.saleName || sess.name || '';
  const saleCode = sess.saleCode || '';
  const salePhone = sess.phone || '';

  const updatedPayload = Object.assign({}, reqSnapshot, {
    deleteRequested: true,
    deleteReason: reason,
    deleteRequestedAt: new Date().toISOString(),
    deleteRequestedBy: saleName,
    deleteRequestedPhone: salePhone,
    deleteRequestedSaleCode: saleCode,
    deleteStatus: 'pending'
  });

  const result = await window.dataSdk.update(updatedPayload);
  if (result && result.isOk) {
    closeDeleteModal();
    currentDetailRequest = updatedPayload;
    showToast('Đã gửi yêu cầu xóa tới QCAG');

    // Notify QCAG via push notification
    try {
      if (typeof sendPushNotification === 'function') {
        const outletLabel = reqSnapshot.outletName || reqSnapshot.outletCode || 'Outlet';
        sendPushNotification({
          title: 'Sale yêu cầu xóa khảo sát',
          body: (saleName || 'Sale') + ' yêu cầu xóa: ' + outletLabel + ' - Lý do: ' + reason,
          role: 'qcag',
          data: { type: 'sale_delete_requested', outletName: reqSnapshot.outletName, outletCode: reqSnapshot.outletCode, reason: reason }
        });
      }
    } catch (e) { /* non-fatal */ }

    // Re-render detail screen in place
    showRequestDetail(reqSnapshot.__backendId);
  } else {
    showToast('Lỗi gửi yêu cầu xóa, vui lòng thử lại');
  }
}

async function cancelDeleteRequest() {
  if (!currentDetailRequest || !window.dataSdk) return;
  if (!confirm('Bạn có chắc chắn muốn hủy yêu cầu xóa khảo sát này?')) return;

  const reqSnapshot = currentDetailRequest;
  const updatedPayload = Object.assign({}, reqSnapshot, {
    deleteRequested: false,
    deleteReason: '',
    deleteRequestedAt: null,
    deleteStatus: null
  });

  const result = await window.dataSdk.update(updatedPayload);
  if (result && result.isOk) {
    currentDetailRequest = updatedPayload;
    showToast('Đã hủy yêu cầu xóa');
    showRequestDetail(reqSnapshot.__backendId);
  } else {
    showToast('Lỗi khi hủy yêu cầu xóa');
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
    `<div class="edit-req-img-thumb">` +
    `<img src="${src}">` +
    `<button type="button" onclick="_removeEditRequestImage(${i})">✕</button>` +
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

function attachEditRequestPaste() {
  const ta = document.getElementById('editRequestInput');
  if (!ta || ta._pasteAttached) return;
  ta._pasteAttached = true;
  ta.addEventListener('paste', async (e) => {
    const items = (e.clipboardData || {}).items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        try {
          const dataUrl = await _compressImageFile(file, 1600, 0.82);
          _editRequestPendingImages.push(dataUrl);
        } catch (_) {
          const dataUrl = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = ev => resolve(ev.target.result);
            reader.readAsDataURL(file);
          });
          _editRequestPendingImages.push(dataUrl);
        }
        _renderEditRequestImgPreview();
      }
    }
  });
}

function _resolveCurrentOrQuoteRequest() {
  if (typeof currentDetailRequest !== 'undefined' && currentDetailRequest && currentDetailRequest.__backendId) {
    return currentDetailRequest;
  }
  if (typeof window._currentModalQuoteReq !== 'undefined' && window._currentModalQuoteReq && window._currentModalQuoteReq.__backendId) {
    window.currentDetailRequest = window._currentModalQuoteReq;
    return window.currentDetailRequest;
  }
  const q = window._currentModalQuote || window._lastLoadedQuoteData;
  if (q && typeof allRequests !== 'undefined' && Array.isArray(allRequests)) {
    const qTk = String(q.tk_code || q.tkCode || '').trim().toLowerCase();
    const qTkDigits = qTk.replace(/\D/g, '');
    const qQuote = String(q.quote_code || q.quoteCode || '').trim().toLowerCase();
    const qOutlet = String(q.outlet_code || q.outletCode || '').trim().toLowerCase();

    const found = allRequests.find(r => {
      if (!r) return false;
      const rTk = String(r.tkCode || r.tk_code || '').trim().toLowerCase();
      const rTkDigits = rTk.replace(/\D/g, '');
      const rQuote = String(r.quoteCode || r.quote_code || '').trim().toLowerCase();
      const rOutlet = String(r.outletCode || r.outlet_code || '').trim().toLowerCase();

      if (qQuote && rQuote && qQuote === rQuote) return true;
      if (qTk && rTk && qTk === rTk) return true;
      if (qTkDigits && qTkDigits.length >= 4 && rTkDigits && qTkDigits === rTkDigits) return true;
      if (qOutlet && qOutlet !== '---' && rOutlet && qOutlet === rOutlet) return true;
      return false;
    });

    if (found) {
      window.currentDetailRequest = found;
      window._currentModalQuoteReq = found;
      return found;
    }
  }

  // Fallback: Nếu là báo giá PO tay từ App 1 chưa có survey request trong allRequests
  if (q) {
    const fallbackReq = {
      __backendId: q.id || q.quote_code || q.tk_code,
      quoteCode: q.quote_code,
      tkCode: q.tk_code,
      outletCode: q.outlet_code,
      outletName: q.outlet_name || q.shop_name || 'Outlet',
      address: q.address || '',
      phone: q.phone || '',
      comments: '[]',
      isQuoteOnly: true
    };
    window.currentDetailRequest = fallbackReq;
    return fallbackReq;
  }

  return null;
}

function openEditRequestSheet() {
  const req = _resolveCurrentOrQuoteRequest();
  const isDesktopOrigin = (typeof window !== 'undefined' && window._editRequestOrigin === 'desktop');
  if (req && !isDesktopOrigin) {
    const lock = _checkRequestLockState(req);
    if (lock.isProduced) {
      showToast(lock.reason || 'Yêu cầu đã ra đơn hàng hoặc đang sản xuất, không thể yêu cầu sửa thiết kế!');
      return;
    }
  }
  _editRequestPendingImages = [];
  _renderEditRequestImgPreview();
  const ta = document.getElementById('editRequestInput');
  if (ta) ta.value = '';
  const overlay = document.getElementById('editRequestSheet');
  if (overlay) { overlay.classList.remove('hidden'); requestAnimationFrame(() => overlay.classList.add('sheet-open')); }
  attachEditRequestPaste();
  setTimeout(() => { if (ta) ta.focus(); }, 150);
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

async function submitEditRequest() {
  const ta = document.getElementById('editRequestInput');
  const text = ta ? ta.value.trim() : '';
  if (!text) { showToast('Vui lòng nhập nội dung yêu cầu chỉnh sửa'); return; }

  // Check if triggered from Production Approval Flow (App 2 Production confirmation)
  if (window.__pendingEditIdKey || (currentDetailRequest && (currentDetailRequest.isProductionApproval || String(currentDetailRequest.__backendId || '').startsWith('po_q_')))) {
    const idKey = window.__pendingEditIdKey || (currentDetailRequest && currentDetailRequest.__backendId);
    closeEditRequestSheet();
    if (typeof confirmRequestEditProduction === 'function' && idKey) {
      confirmRequestEditProduction(idKey, text);
    }
    window.__pendingEditIdKey = null;
    return;
  }

  const reqTarget = _resolveCurrentOrQuoteRequest();
  if (!reqTarget) { showToast('Không tìm thấy yêu cầu'); return; }

  const backendId = reqTarget.__backendId;
  const reqIdx = (typeof allRequests !== 'undefined' && Array.isArray(allRequests))
    ? allRequests.findIndex(r => r.__backendId === backendId)
    : -1;

  const request = reqIdx !== -1 ? allRequests[reqIdx] : reqTarget;
  let comments = safeParseComments(
    (request && request.comments) ? request.comments : '[]',
    []
  );

  const authorRole = (currentSession && currentSession.role) || 'heineken';
  let authorName = (currentSession && (currentSession.saleName || currentSession.name || currentSession.phone)) || '';
  if (!authorName) {
    const reqObj = (() => { try { return JSON.parse(request.requester || '{}'); } catch (_) { return {}; } })();
    authorName = reqObj.saleName || reqObj.name || reqObj.phone || request.createdByName || (authorRole === 'qcag' ? 'QCAG' : 'Sale');
  }

  let finalText = text;
  if (String(authorRole).toLowerCase() === 'qcag') {
    const qcName = (currentSession && (currentSession.name || currentSession.phone)) || 'QCAG';
    finalText = `Yêu cầu chỉnh sửa được gửi từ ${qcName}\n\n${text}`;
  }

  closeEditRequestSheet();
  const imgs = _editRequestPendingImages.slice();
  _editRequestPendingImages = [];

  if (imgs.length > 0) {
    showLoadingOverlay('Đang gửi yêu cầu chỉnh sửa...', 'Đang tải hình ảnh lên');
  } else {
    showLoadingOverlay('Đang gửi yêu cầu chỉnh sửa...', 'Vui lòng chờ trong giây lát');
  }

  // Upload images if any
  let uploadedImgs = [];
  if (imgs.length > 0 && window.dataSdk && window.dataSdk.uploadImage && backendId) {
    for (const imgData of imgs) {
      try {
        const url = await window.dataSdk.uploadImage(imgData, null, backendId, 'comments');
        uploadedImgs.push(url || imgData);
      } catch (e) {
        uploadedImgs.push(imgData);
      }
    }
  } else {
    uploadedImgs = imgs;
  }

  const comment = {
    authorRole,
    authorName,
    text: finalText,
    commentType: 'edit-request',
    ...(uploadedImgs.length > 0 ? { images: uploadedImgs } : {}),
    createdAt: new Date().toISOString()
  };
  comments.push(comment);

  // 1. Gửi ghi chú nguyên tử tới 3NF notes API (Zero Race-Condition)
  if (backendId) {
    try {
      await _sendNoteToBackend(backendId, {
        text: finalText,
        authorName: authorName,
        authorRole: authorRole,
        noteType: 'edit-request',
        images: uploadedImgs
      });
    } catch (_) { }
  }

  // Nếu là quote-only fallback không có survey request đầy đủ
  if (request.isQuoteOnly) {
    hideLoadingOverlay();
    showToast('Đã gửi yêu cầu chỉnh sửa');
    if (typeof closeFullMobileQuoteModal === 'function') closeFullMobileQuoteModal();
    return;
  }

  // Heineken and QCAG edit-requests must pull request back to processing and clear MQ
  let extraFields = {};
  if (['heineken', 'qcag'].includes(String(authorRole || '').toLowerCase())) {
    const existingDesignImgs = (() => {
      try { return JSON.parse(request.designImages || '[]'); } catch (e) { return []; }
    })();
    const nowIso = new Date().toISOString();
    // Giữ nguyên ngày yêu cầu sửa đầu tiên nếu chuỗi sửa này đang tiếp diễn chưa có thiết kế mới
    const existingEditDate = request.editingRequestedAt || request.editing_requested_at;
    const initialEditDate = (existingEditDate && (!Array.isArray(existingDesignImgs) || existingDesignImgs.length === 0))
      ? existingEditDate
      : nowIso;
    extraFields = {
      editingRequestedAt: initialEditDate,
      editing_requested_at: initialEditDate,
      hasEditRequest: true,
      status: 'processing',
      ...(Array.isArray(existingDesignImgs) && existingDesignImgs.length > 0 ? { designImages: '[]' } : {})
    };
  }

  // Build PATCH payload with ONLY the fields that need to change.
  const updated = {
    __backendId: request.__backendId,
    comments: JSON.stringify(comments),
    ...extraFields,
    updatedAt: new Date().toISOString()
  };

  const handlePostSuccess = () => {
    hideLoadingOverlay();
    showToast('Đã gửi yêu cầu chỉnh sửa');
    if (typeof closeFullMobileQuoteModal === 'function') {
      closeFullMobileQuoteModal();
    }
    // Merge changes into existing record
    if (reqIdx !== -1 && typeof allRequests !== 'undefined') {
      delete allRequests[reqIdx]._cachedPendingEdit;
      Object.assign(allRequests[reqIdx], updated);
    }
    if (typeof currentDetailRequest !== 'undefined' && currentDetailRequest && currentDetailRequest.__backendId === backendId) {
      delete currentDetailRequest._cachedPendingEdit;
      Object.assign(currentDetailRequest, updated);
    }
    if (typeof _qcagDesktopFullRequestCache !== 'undefined' && _qcagDesktopFullRequestCache[backendId]) {
      delete _qcagDesktopFullRequestCache[backendId]._cachedPendingEdit;
      Object.assign(_qcagDesktopFullRequestCache[backendId], updated);
    }
    saveAllRequestsToStorage();

    // Push notification for Edit Request
    try {
      const outletLabel = request.outletName || request.outletCode || 'Outlet';
      if (typeof sendPushNotification === 'function') {
        if (String(authorRole).toLowerCase() === 'heineken') {
          sendPushNotification({
            title: 'Yêu cầu chỉnh sửa mới',
            body: `${authorName} vừa gửi yêu cầu chỉnh sửa cho ${outletLabel}: ${text.slice(0, 100)}`,
            role: 'qcag',
            data: { backendId: backendId }
          });
        } else {
          const reqObj = (() => { try { return JSON.parse(request.requester || '{}'); } catch (_) { return {}; } })();
          sendPushNotification({
            title: 'Yêu cầu chỉnh sửa từ QCAG',
            body: `${authorName} vừa gửi yêu cầu chỉnh sửa cho ${outletLabel}: ${text.slice(0, 100)}`,
            phone: reqObj.phone,
            saleCode: reqObj.saleCode,
            data: { backendId: backendId }
          });
        }
      }
    } catch (e) { /* non-fatal */ }

    // Sync with Production Approvals flow if matching production item exists
    try {
      if (typeof _productionApprovalItems !== 'undefined' && Array.isArray(_productionApprovalItems)) {
        const prodItem = _productionApprovalItems.find(i => (i.__backendId || i.id) == backendId);
        if (prodItem) {
          prodItem.productionApprovalStatus = 'pending-edit';
          prodItem.status = 'pending-edit';
          prodItem.rejectReason = text;
          if (typeof renderProductionApprovalList === 'function') renderProductionApprovalList();
          if (typeof updateProductionApprovalBadge === 'function') updateProductionApprovalBadge();
        }
      }
    } catch (_) { }

    if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
      try {
        if (typeof window !== 'undefined') {
          window._qcagDesktopStatusFilter = 'processing';
          window._qcagRequestsVersion = (window._qcagRequestsVersion || 0) + 1;
          if (window._qcagRequestCodeCache) window._qcagRequestCodeCache.version = 0;
          if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();
          if (typeof openQCAGDesktopRequest === 'function') {
            openQCAGDesktopRequest(backendId, false, true);
          }
        }
      } catch (e) { /* non-fatal */ }
    } else {
      if (typeof showRequestDetail === 'function') {
        showRequestDetail(backendId);
      }
    }
  };

  if (window.dataSdk) {
    const result = await window.dataSdk.update(updated);
    if (result.isOk) {
      handlePostSuccess();
    } else {
      hideLoadingOverlay();
      showToast('Lỗi gửi yêu cầu');
    }
  } else {
    handlePostSuccess();
  }
}

