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

// ── Design modal comments ─────────────────────────────────────────────

async function addDesignComment(backendId) {
  const textarea = document.getElementById('designCommentInput');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) { showToast('Vui lòng nhập nội dung bình luận'); return; }

  const reqIdx = allRequests.findIndex(r => r.__backendId === backendId);
  if (reqIdx === -1) { showToast('Không tìm thấy yêu cầu'); return; }

  const request = allRequests[reqIdx];
  let comments = [];
  try { comments = JSON.parse(request.comments || '[]'); } catch (e) { comments = []; }

  const authorRole = (currentSession && currentSession.role) || 'unknown';
  const authorName = (currentSession && (currentSession.saleName || currentSession.phone)) || 'Người dùng';
  const comment = { authorRole, authorName, text, createdAt: new Date().toISOString() };
  comments.push(comment);

  // Heineken comment on a request that has MQ → clear design images (request edit)
  // Only clear images the first time Sale requests an edit; do not auto-delete
  // images repeatedly on subsequent edit requests.
  let extraFields = {};
  if (authorRole === 'heineken') {
    let existingDesignImgs = [];
    try { existingDesignImgs = JSON.parse(request.designImages || '[]'); } catch (e) {}
    if (existingDesignImgs.length > 0 && !request.editingRequestedAt) {
      extraFields.designImages = '[]';
      extraFields.editingRequestedAt = new Date().toISOString();
    }
  }

  const updated = { ...request, comments: JSON.stringify(comments), ...extraFields };

  if (window.dataSdk) {
    const result = await window.dataSdk.update(updated);
    if (result.isOk) {
      showToast('Đã gửi bình luận');
      const idx = allRequests.findIndex(r => r.__backendId === backendId);
      if (idx !== -1) { allRequests[idx] = updated; }
      showRequestDetail(backendId);
      viewDesign(backendId);
    } else {
      showToast('Lỗi gửi bình luận');
    }
  } else {
    allRequests[reqIdx] = updated;
    saveAllRequestsToStorage();
    textarea.value = '';
    showToast('Đã gửi bình luận (lưu local)');
    viewDesign(backendId);
  }
}

// ── Detail panel comments ─────────────────────────────────────────────

async function addDetailComment(backendId) {
  const textarea = document.getElementById('detailCommentInput');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) { showToast('Vui lòng nhập nội dung bình luận'); return; }

  const reqIdx = allRequests.findIndex(r => r.__backendId === backendId);
  if (reqIdx === -1) { showToast('Không tìm thấy yêu cầu'); return; }

  const request = allRequests[reqIdx];
  let comments = [];
  try { comments = JSON.parse(request.comments || '[]'); } catch (e) { comments = []; }

  const authorRole = (currentSession && currentSession.role) || 'unknown';
  const authorName = (currentSession && (currentSession.saleName || currentSession.phone)) || 'Người dùng';
  const comment = { authorRole, authorName, text, createdAt: new Date().toISOString() };
  comments.push(comment);

  // Heineken comment on a request that has MQ → clear design images (request edit)
  // Only clear images the first time Sale requests an edit; do not auto-delete
  // images repeatedly on subsequent edit requests.
  let extraFields = {};
  if (authorRole === 'heineken') {
    let existingDesignImgs = [];
    try { existingDesignImgs = JSON.parse(request.designImages || '[]'); } catch (e) {}
    if (existingDesignImgs.length > 0 && !request.editingRequestedAt) {
      extraFields.designImages = '[]';
      extraFields.editingRequestedAt = new Date().toISOString();
    }
  }

  const updated = { ...request, comments: JSON.stringify(comments), ...extraFields };

  if (window.dataSdk) {
    const result = await window.dataSdk.update(updated);
    if (result.isOk) {
      showToast('Đã gửi bình luận');
      const idx = allRequests.findIndex(r => r.__backendId === backendId);
      if (idx !== -1) { allRequests[idx] = updated; }
      showRequestDetail(backendId);
    } else {
      showToast('Lỗi gửi bình luận');
    }
  } else {
    allRequests[reqIdx] = updated;
    saveAllRequestsToStorage();
    textarea.value = '';
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
        // Merge image fields from full record into local object
        fullRequest = Object.assign({}, request, {
          statusImages:     r.data.statusImages     || request.statusImages,
          designImages:     r.data.designImages     || request.designImages,
          acceptanceImages: r.data.acceptanceImages || request.acceptanceImages,
          oldContentImages: r.data.oldContentImages || request.oldContentImages,
        });
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
          ${statusImgs.map(img => `<img src="${img}" class="w-20 h-20 object-cover rounded-lg cursor-pointer" onclick="showImageFull(this.src, false)">`).join('')}
        </div>
      ` : '<p class="text-sm text-gray-500">Chưa có ảnh</p>'}
    </div>
  `;

  if (request.type === 'new') {
    html += `
      <div id="mqSection" class="bg-gray-50 rounded-xl p-4">
        <h3 class="font-medium mb-3">Thiết kế</h3>
        ${designImgs.length > 0 ? `
          <div class="flex flex-wrap gap-2 mb-3">
            ${designImgs.map(img => `<img src="${img}" class="w-20 h-20 object-cover rounded-lg cursor-pointer" onclick="viewDesign('${request.__backendId}')">`).join('')}
          </div>
        ` : '<p class="text-sm text-gray-500 mb-3">Chưa có thiết kế</p>'}
        ${ (currentSession && String(currentSession.role || '').toLowerCase() === 'heineken') ?
          '<div class="px-3 py-2 text-sm text-gray-500 italic">Bạn chỉ có quyền xem thiết kế</div>' :
          '<label class="w-full py-3 border-2 border-dashed border-gray-300 rounded-xl text-gray-500 font-medium flex items-center justify-center gap-2 cursor-pointer active:bg-gray-100">\n          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">\n            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>\n          </svg>\n          Upload thiết kế\n          <input type="file" accept="image/*" multiple class="hidden" onchange="uploadDesign(this)">\n        </label>' }
      </div>
    `;
  }

  if (request.type === 'warranty') {
    html += `
      <div class="bg-gray-50 rounded-xl p-4">
        <h3 class="font-medium mb-3">Ảnh nghiệm thu</h3>
        ${acceptanceImgs.length > 0 ? `
          <div class="flex flex-wrap gap-2 mb-3">
            ${acceptanceImgs.map(img => `<img src="${img}" class="w-20 h-20 object-cover rounded-lg cursor-pointer" onclick="showImageFull(this.src, false)">`).join('')}
          </div>
        ` : '<p class="text-sm text-gray-500 mb-3">Chưa có ảnh nghiệm thu</p>'}
        <label class="w-full py-3 border-2 border-dashed border-gray-300 rounded-xl text-gray-500 font-medium flex items-center justify-center gap-2 cursor-pointer active:bg-gray-100">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
          </svg>
          Upload ảnh nghiệm thu
          <input type="file" accept="image/*" multiple class="hidden" onchange="uploadAcceptance(this)">
        </label>
      </div>
    `;
  }

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
        // message bubble contains body + small time at bottom
        '<div class="comment-bubble' + shortClass + '">' +
          '<div class="comment-body">' + textStr + '</div>' +
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
          <textarea id="detailCommentInput" rows="1" class="w-full px-3 py-2.5 border border-gray-200 rounded-lg bg-white text-sm resize-none" placeholder="Viết bình luận..." oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
          <div class="flex justify-end mt-2">
            <button onclick="addDetailComment('${request.__backendId}')" class="px-4 py-2 bg-gray-900 text-white rounded-lg">Gửi</button>
          </div>
        </div>
      </div>
    </div>
  `;

  html += '</div>'; // close .detail-two-col

  content.innerHTML = html;
  showScreen('detailScreen');
  _mqHintEligible = !!(currentSession && String(currentSession.role || '').toLowerCase() === 'heineken' && request.type === 'new');
  // Show edit-request FAB and position it depending on tab (chat-mode => left, detail => right)
  try {
    const fab = document.getElementById('editRequestFab');
    const detailContent = document.getElementById('detailContent');
    if (fab) {
      fab.classList.remove('hidden');
      if (detailContent && detailContent.classList.contains('chat-mode')) {
        fab.classList.remove('fab-right'); fab.classList.add('fab-left');
      } else {
        fab.classList.remove('fab-left'); fab.classList.add('fab-right');
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

    // Get input rect relative to viewport
    const rect = input.getBoundingClientRect();
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
      if (fab) { fab.classList.remove('fab-right'); fab.classList.add('fab-left'); fab.classList.remove('hidden'); }
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

  // Determine GCS subfolder: use mqFolder from request (e.g. 'mq-12345678'),
  // or fall back to generating from outletCode
  const mqSubfolder = currentDetailRequest.mqFolder ||
    ('mq-' + String(currentDetailRequest.outletCode || 'NEWOUTLET').replace(/[^a-zA-Z0-9]/g, '-').replace(/-{2,}/g,'-').replace(/^-|-$/g,'').slice(0,32));

  for (const file of files) {
    const dataUrl = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
    // Upload to GCS if dataSdk available; fall back to base64
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
  const updated = { ...currentDetailRequest, designImages: JSON.stringify(currentImgs), designUpdatedAt: new Date().toISOString(), editingRequestedAt: null };
  if (window.dataSdk) {
    const result = await window.dataSdk.update(updated);
    if (result.isOk) {
      showToast('Đã upload thiết kế');
      showRequestDetail(currentDetailRequest.__backendId);
    } else {
      showToast('Lỗi upload thiết kế');
    }
  } else {
    const idx = allRequests.findIndex(r => r.__backendId === currentDetailRequest.__backendId);
    if (idx !== -1) {
      allRequests[idx] = { ...allRequests[idx], designImages: JSON.stringify(currentImgs), designUpdatedAt: new Date().toISOString(), editingRequestedAt: null };
      currentDetailRequest = allRequests[idx];
      saveAllRequestsToStorage();
      showToast('Đã upload thiết kế (lưu local)');
      showRequestDetail(currentDetailRequest.__backendId);
    } else {
      showToast('Không tìm thấy yêu cầu để lưu');
    }
  }
  input.value = '';
}

async function uploadAcceptance(input) {
  if (!currentDetailRequest) return;
  const files = Array.from(input.files);
  const currentImgs = JSON.parse(currentDetailRequest.acceptanceImages || '[]');

  for (const file of files) {
    const dataUrl = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
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

  const updated = { ...currentDetailRequest, acceptanceImages: JSON.stringify(currentImgs) };
  if (window.dataSdk) {
    const result = await window.dataSdk.update(updated);
    if (result.isOk) {
      showToast('Đã upload ảnh nghiệm thu');
      showRequestDetail(currentDetailRequest.__backendId);
    } else {
      showToast('Lỗi upload ảnh nghiệm thu');
    }
  } else {
    const idx = allRequests.findIndex(r => r.__backendId === currentDetailRequest.__backendId);
    if (idx !== -1) {
      allRequests[idx] = { ...allRequests[idx], acceptanceImages: JSON.stringify(currentImgs) };
      currentDetailRequest = allRequests[idx];
      saveAllRequestsToStorage();
      showToast('Đã upload ảnh nghiệm thu (lưu local)');
      showRequestDetail(currentDetailRequest.__backendId);
    } else {
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

  // If designImages is still the list-endpoint placeholder, fetch real URLs first
  let designImages = request.designImages || '[]';
  if (designImages === '["..."]' && window.dataSdk && typeof window.dataSdk.getOne === 'function') {
    try {
      const r = await window.dataSdk.getOne(id);
      if (r && r.isOk && r.data) {
        request = Object.assign({}, request, {
          designImages:     r.data.designImages     || request.designImages,
          oldContentImages: r.data.oldContentImages || request.oldContentImages,
          statusImages:     r.data.statusImages     || request.statusImages,
          acceptanceImages: r.data.acceptanceImages || request.acceptanceImages,
        });
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
  const modal = document.getElementById('designModal');
  const content = document.getElementById('designModalContent');

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
          ${designImgs.map(img => `
            <div class="design-slide">
              <img src="${img}" class="design-img" onclick="showImageFull(this.src, false)" title="Tap để zoom" style="cursor:zoom-in">
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
          <textarea id="designCommentInput" rows="2" class="design-comment-input" placeholder="Viết bình luận..."></textarea>
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

  modal.classList.remove('hidden');
  modal.classList.add('flex');

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

function showImageFull(src, showContent = true) {
  // Prevent immediate re-open after a recent close (debounce accidental double-open)
  try {
    if (window._dv_lastClosedAt && (Date.now() - window._dv_lastClosedAt) < 500) return;
  } catch (e) { /* ignore */ }

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
    <img id="dvZoomImg" src="${src}" class="dv-zoom-img" draggable="false">
    <button class="dv-zoom-close">✕</button>
    <div class="dv-zoom-scale" id="dvZoomScale">100%</div>`;
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
  const MAX = 3, MIN = 1;
  let isDragging = false, dragStartX = 0, dragStartY = 0;
  let lastDist = null;
  let lastTap = 0;

  const img = document.getElementById('dvZoomImg');
  const scaleEl = document.getElementById('dvZoomScale');

  function apply(animated) {
    img.style.transition = animated ? 'transform 0.2s ease' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    scaleEl.textContent = Math.round(scale * 100) + '%';
  }
  function clamp() {
    if (scale <= 1) { tx = 0; ty = 0; return; }
    const pad = (scale - 1) * 200;
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
    }
  }, { passive: true });

  overlay.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 2 && lastDist !== null) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      scale = Math.max(MIN, Math.min(MAX, scale * (d / lastDist)));
      lastDist = d;
      clamp(); apply(false);
    } else if (e.touches.length === 1 && isDragging) {
      tx = e.touches[0].clientX - dragStartX;
      ty = e.touches[0].clientY - dragStartY;
      clamp(); apply(false);
    }
  }, { passive: false });

  overlay.addEventListener('touchend', e => {
    if (e.touches.length < 2) lastDist = null;
    if (e.touches.length === 0) { isDragging = false; }
  }, { passive: true });

  function onKey(e) { if (e.key === 'Escape') { closeDvZoom(); document.removeEventListener('keydown', onKey); } }
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
  if (!currentDetailRequest || !window.dataSdk) return;
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

function openEditRequestSheet() {
  _editRequestCategories = [];
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
    createdAt: new Date().toISOString()
  };
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

  const updated = { ...request, comments: JSON.stringify(comments), ...extraFields, updatedAt: new Date().toISOString() };

  closeEditRequestSheet();

  if (window.dataSdk) {
    const result = await window.dataSdk.update(updated);
    if (result.isOk) {
      showToast('Đã gửi yêu cầu chỉnh sửa');
      const idx = allRequests.findIndex(r => r.__backendId === backendId);
      if (idx !== -1) allRequests[idx] = updated;
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
      showToast('Lỗi gửi yêu cầu');
    }
  } else {
    allRequests[reqIdx] = updated;
    saveAllRequestsToStorage();
    showToast('Đã gửi yêu cầu chỉnh sửa (lưu local)');
    showRequestDetail(backendId);
  }
}

