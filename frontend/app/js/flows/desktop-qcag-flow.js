// ====================================================================
// js/flows/desktop-qcag-flow.js — dedicated desktop UI for QCAG users
// ====================================================================
'use strict';

let _qcagDesktopFilterType = 'new';
let _qcagDesktopListScrollSave = 0; // preserves list scroll across renders
let _qcagDesktopStatusFilter = 'processing';
let _qcagDesktopRegionFilter = 'all';
let _qcagDesktopSearchQuery = '';
let _qcagDesktopCurrentId = null;
let _qcagDesktopPendingCommentImages = [];
let _qcagCommentsCollapsed = false; // collapsible comment panel state
let _qcagDesktopSearchDebounce = null;
let _qcagDesktopFullRequestCache = {};
let _qcagDesktopFullRequestPending = {};
let _qcagDesktopImageBlobUrlCache = {};
let _qcagDesktopImageWarmPending = {};
let _qcagDesktopInitialWarmupPromise = null;

let _qcagRequestsVersion = 0;
let _qcagRequestCodeCache = { version: 0, codes: {} };

// Index of the currently shown old design entry in the carousel
let _qcagOldDesignIdx = 0;

// Guard to prevent double-click on the confirm-complete button
let _qcagMarkProcessedInFlight = false;

// Pagination for left-column request list
const _QCAG_PAGE_SIZE = 10;
let _qcagDesktopListPage = 0;

// Year filter (null = tất cả các năm)
let _qcagDesktopYearFilter = new Date().getFullYear();
// Year currently shown in the dropup picker (not yet applied until user clicks)
let _qcagDesktopYearDropupYear = new Date().getFullYear();
// Sort mode: 'time' | 'sale' | 'tag'
let _qcagDesktopSortMode = 'time';

function isDesktopViewport() {
  return (window.innerWidth || 0) >= 1024;
}

function isQCAGSession() {
  return !!(currentSession && String(currentSession.role || '').toLowerCase() === 'qcag');
}

function shouldUseQCAGDesktop() {
  return isQCAGSession() && isDesktopViewport();
}

function qcagDesktopParseJson(raw, fallback) {
  try { return JSON.parse(raw || ''); } catch (e) { return fallback; }
}

// ── Push notification bell for QCAG desktop ──────────────────────────
function qcagDesktopUpdateBellUI() {
  const dot = document.getElementById('qcagPushBellStatus');
  if (!dot) return;
  if (typeof Notification === 'undefined' || !('PushManager' in window)) {
    dot.className = 'qcag-push-bell-dot off';  // gray — not supported
    return;
  }
  if (Notification.permission === 'granted') {
    dot.className = 'qcag-push-bell-dot on';   // green
  } else if (Notification.permission === 'denied') {
    dot.className = 'qcag-push-bell-dot denied'; // red
  } else {
    dot.className = 'qcag-push-bell-dot off';    // gray — not yet asked
  }
}

async function qcagDesktopTogglePush() {
  if (typeof Notification === 'undefined' || !('PushManager' in window)) {
    showToast('Trình duyệt này không hỗ trợ Push Notification');
    return;
  }
  if (Notification.permission === 'denied') {
    showToast('Thông báo đã bị chặn. Vui lòng mở Cài đặt trình duyệt → Thông báo (Notifications) → cho phép trang này.');
    return;
  }
  if (Notification.permission === 'granted') {
    showToast('✓ Thông báo đã được bật. Bạn sẽ nhận push khi có yêu cầu mới từ Heineken.');
    // Re-subscribe silently (refreshes endpoint + keeps subscription fresh)
    try {
      if (window.pushHelpers && window.pushHelpers.initPush) {
        const phone = currentSession && currentSession.phone || null;
        const role  = currentSession && currentSession.role  || null;
        await window.pushHelpers.initPush(phone, role, null);
      }
    } catch (_) {}
    qcagDesktopUpdateBellUI();
    return;
  }
  // permission === 'default' → ask user
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      showToast('✓ Đã bật thông báo thành công!');
      if (window.pushHelpers && window.pushHelpers.initPush) {
        const phone = currentSession && currentSession.phone || null;
        const role  = currentSession && currentSession.role  || null;
        await window.pushHelpers.initPush(phone, role, null);
      }
    } else if (result === 'denied') {
      showToast('Bạn đã từ chối thông báo. Để bật lại, vào Cài đặt trình duyệt → Thông báo.');
    } else {
      showToast('Bạn chưa cho phép thông báo.');
    }
  } catch (e) {
    showToast('Lỗi khi yêu cầu quyền thông báo: ' + e);
  }
  qcagDesktopUpdateBellUI();
}

function qcagDesktopNormalizeImageUrl(url) {
  const v = String(url || '').trim();
  // Filter out empty strings and the list-endpoint placeholder sentinel '...'
  if (!v || v === '...') return '';
  // `storage.cloud.google.com` often serves HTML/login flow, which breaks <img>.
  // Convert to direct object URL format for browser image rendering.
  return v.replace(
    /^https:\/\/storage\.cloud\.google\.com\/([^/]+)\/(.+)$/i,
    'https://storage.googleapis.com/$1/$2'
  );
}

function qcagDesktopRenderImageUrl(url) {
  const normalized = qcagDesktopNormalizeImageUrl(url);
  if (!normalized) return '';
  return _qcagDesktopImageBlobUrlCache[normalized] || normalized;
}

function qcagDesktopPrepareRenderImageList(rawList) {
  return (Array.isArray(rawList) ? rawList : [])
    .map(qcagDesktopRenderImageUrl)
    .filter(Boolean);
}

function qcagDesktopCollectRequestImageUrls(req) {
  if (!req || typeof req !== 'object') return [];
  const urls = [];
  const pushIfAny = (value) => {
    const normalized = qcagDesktopNormalizeImageUrl(value);
    if (normalized) urls.push(normalized);
  };

  qcagDesktopParseJson(req.statusImages, []).forEach(pushIfAny);
  qcagDesktopParseJson(req.oldContentImages, []).forEach(pushIfAny);
  qcagDesktopParseJson(req.designImages, []).forEach(pushIfAny);
  qcagDesktopParseJson(req.acceptanceImages, []).forEach(pushIfAny);

  const comments = qcagDesktopParseJson(req.comments, []);
  if (Array.isArray(comments)) {
    comments.forEach(c => {
      const images = Array.isArray(c && c.images) ? c.images : [];
      images.forEach(pushIfAny);
    });
  }

  return Array.from(new Set(urls));
}

function qcagDesktopCacheRequest(req) {
  if (!req || !req.__backendId) return;
  _qcagDesktopFullRequestCache[req.__backendId] = req;
}

async function qcagDesktopWarmImage(url) {
  const normalized = qcagDesktopNormalizeImageUrl(url);
  if (!normalized) return '';
  if (_qcagDesktopImageBlobUrlCache[normalized]) return _qcagDesktopImageBlobUrlCache[normalized];
  if (_qcagDesktopImageWarmPending[normalized]) return _qcagDesktopImageWarmPending[normalized];

  _qcagDesktopImageWarmPending[normalized] = (async () => {
    try {
      const response = await fetch(normalized, { cache: 'force-cache' });
      if (response && response.ok) {
        const blob = await response.blob();
        if (blob && blob.size > 0) {
          const blobUrl = URL.createObjectURL(blob);
          _qcagDesktopImageBlobUrlCache[normalized] = blobUrl;
          return blobUrl;
        }
      }
    } catch (e) {
      // fallback to native browser preload
    }

    await new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => resolve();
      img.src = normalized;
    });
    return normalized;
  })();

  try {
    return await _qcagDesktopImageWarmPending[normalized];
  } finally {
    delete _qcagDesktopImageWarmPending[normalized];
  }
}

async function qcagDesktopWarmRequestAssets(req) {
  const urls = qcagDesktopCollectRequestImageUrls(req);
  if (urls.length === 0) return;
  await Promise.all(urls.map(qcagDesktopWarmImage));
}

async function qcagDesktopGetFullRequest(idOrReq) {
  const id = typeof idOrReq === 'string'
    ? idOrReq
    : (idOrReq && idOrReq.__backendId);
  if (!id) return null;

  const base = (typeof idOrReq === 'object' && idOrReq)
    ? idOrReq
    : allRequests.find(r => r.__backendId === id);
  if (!base) return null;

  if (_qcagDesktopFullRequestCache[id]) return _qcagDesktopFullRequestCache[id];
  if (_qcagDesktopFullRequestPending[id]) return _qcagDesktopFullRequestPending[id];

  _qcagDesktopFullRequestPending[id] = (async () => {
    let merged = base;
    if (window.dataSdk && typeof window.dataSdk.getOne === 'function') {
      try {
        const r = await window.dataSdk.getOne(id);
        if (r && r.isOk && r.data) {
          merged = Object.assign({}, base, {
            statusImages: r.data.statusImages || base.statusImages,
            designImages: r.data.designImages || base.designImages,
            acceptanceImages: r.data.acceptanceImages || base.acceptanceImages,
            oldContentImages: r.data.oldContentImages || base.oldContentImages,
          });
          const idx = allRequests.findIndex(x => x.__backendId === id);
          if (idx !== -1) allRequests[idx] = merged;
        }
      } catch (e) {
        merged = base;
      }
    }

    qcagDesktopCacheRequest(merged);
    return merged;
  })();

  try {
    return await _qcagDesktopFullRequestPending[id];
  } finally {
    delete _qcagDesktopFullRequestPending[id];
  }
}

async function qcagDesktopWarmupAllRequestsOnce() {
  if (_qcagDesktopInitialWarmupPromise) return _qcagDesktopInitialWarmupPromise;

  const source = (allRequests || []).slice().filter(r => r && r.__backendId);
  _qcagDesktopInitialWarmupPromise = (async () => {
    if (source.length === 0) return;
    const queue = source.slice();
    const workerCount = Math.max(2, Math.min(4, queue.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const req = queue.shift();
        if (!req) continue;
        const full = await qcagDesktopGetFullRequest(req);
        if (full) await qcagDesktopWarmRequestAssets(full);
      }
    });
    await Promise.all(workers);
  })();

  return _qcagDesktopInitialWarmupPromise;
}

function qcagDesktopInitials(name) {
  const v = String(name || '').trim();
  if (!v) return 'U';
  const parts = v.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0].slice(0, 1) + parts[parts.length - 1].slice(0, 1)).toUpperCase();
}

// Copy outlet code to clipboard and show toast
function qcagCopyOutletCode(code) {
  try {
    if (!code) { showToast('Không có Outlet Code để sao chép'); return; }
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(code)).then(() => {
        showToast('Đã sao chép Outlet Code');
      }).catch(() => {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = String(code);
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); showToast('Đã sao chép Outlet Code'); } catch (e) { showToast('Không thể sao chép'); }
        ta.remove();
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = String(code);
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showToast('Đã sao chép Outlet Code'); } catch (e) { showToast('Không thể sao chép'); }
      ta.remove();
    }
  } catch (e) { console.error('qcagCopyOutletCode', e); showToast('Lỗi sao chép'); }
}

function qcagDesktopDesignState(req) {
  if (req.editingRequestedAt) return 'Chờ chỉnh sửa';
  const designImgs = qcagDesktopParseJson(req.designImages, []);
  return designImgs.length > 0 ? 'Có MQ thiết kế' : 'Chờ MQ thiết kế';
}

// Assign standardized tags for UI-independent classification.
function assignStandardTags(req) {
  if (!req || typeof req !== 'object') return [];
  const tags = [];

  // Common helpers
  const designImgs = qcagDesktopParseJson(req.designImages, []);
  const statusImgs = qcagDesktopParseJson(req.statusImages, []);
  const items = qcagDesktopParseJson(req.items, []);
  const status = String(req.status || 'pending').toLowerCase();

  // Processing / Yêu cầu (new)
  if (String(req.type || '').toLowerCase() === 'new') {
    if (req.editingRequestedAt) {
      tags.push('Chờ chỉnh sửa');
    }
    // any item marked as survey *without* a confirmed surveySize -> Chờ khảo sát
    try {
      if (Array.isArray(items) && items.some(it => !!it.survey && !(it.surveySize && it.surveySize.width && it.surveySize.height))) {
        tags.push('Chờ khảo sát');
      }
    } catch (e) {}
    // No MQ at all -> Chờ thiết kế
    if (!Array.isArray(designImgs) || designImgs.length === 0) {
      tags.push('Chờ thiết kế');
    }
    // Has MQ but not marked done -> Chờ xác nhận
    if (Array.isArray(designImgs) && designImgs.length > 0 && !(status === 'done' || status === 'processed')) {
      tags.push('Chờ xác nhận');
    }
  }

  // Processing / Bảo hành (warranty)
  if (String(req.type || '').toLowerCase() === 'warranty') {
    const _wstat = String(req.status || 'pending').toLowerCase();
    if (_wstat === 'done' || _wstat === 'processed') {
      if (req.warrantyOutOfScope) tags.push('Ngoài phạm vi BH');
      else tags.push('Đã Bảo hành');
    } else {
      tags.push('Chờ kiểm tra');
    }
  }

  // Done tab tags
  if (Array.isArray(designImgs) && designImgs.length > 0 && (status === 'done' || status === 'processed')) {
    tags.push('Đã có MQ');
    // placeholder for external施工 flag (Đã thi công) — controlled by external API later
    if (req.executed === true || req.installed === true || String(req.workStatus || '').toLowerCase() === 'done') {
      tags.push('Đã thi công');
    }
  }

  // warranty done tags are handled above in the warranty block

  // remove duplicates and preserve order
  return Array.from(new Set(tags));
}

function qcagDesktopHasHeinekenEditRequest(req) {
  const comments = qcagDesktopParseJson(req && req.comments, []);
  if (!Array.isArray(comments) || comments.length === 0) return false;

  const latestEditReqIdx = (() => {
    for (let i = comments.length - 1; i >= 0; i -= 1) {
      const c = comments[i] || {};
      if (
        String(c.commentType || '').toLowerCase() === 'edit-request' &&
        String(c.authorRole || '').toLowerCase() === 'heineken'
      ) return i;
    }
    return -1;
  })();

  if (latestEditReqIdx === -1) return false;

  const hasResolvedAfter = comments.some((c, idx) =>
    idx > latestEditReqIdx && String((c && c.commentType) || '').toLowerCase() === 'edit-resolved'
  );

  return !hasResolvedAfter;
}

function qcagDesktopHasLaterEditResolvedComment(comments, index) {
  if (!Array.isArray(comments) || comments.length === 0) return false;
  return comments.some((c, idx) => idx > index && String((c && c.commentType) || '').toLowerCase() === 'edit-resolved');
}

function qcagDesktopIsPendingEditRequest(req) {
  return !!(req && (req.editingRequestedAt || qcagDesktopHasHeinekenEditRequest(req)));
}

function qcagDesktopCanEditItems(req) {
  return !qcagDesktopIsDone(req);
}

function qcagDesktopIsDone(req) {
  if (!req) return false;
  const s = String((req.status || '')).toLowerCase();
  return s === 'done' || s === 'processed';
}

// ── Edit Outlet Info Modal ────────────────────────────────────────────

function qcagEnsureEditOutletModal() {
  if (document.getElementById('qcagEditOutletModal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'qcagEditOutletModal';
  wrap.className = 'qcag-edit-items-modal hidden';
  wrap.innerHTML = `
    <div class="qcag-edit-items-backdrop" onclick="qcagCloseEditOutletModal()"></div>
    <div class="qcag-edit-items-panel">
      <div class="qcag-edit-items-header">Chỉnh sửa thông tin Outlet</div>
      <div class="qcag-edit-items-body">
        <label>Outlet Code
          <input id="qcagEditOutletCode" type="text" maxlength="20" placeholder="Outlet Code"/>
        </label>
        <label>Tên Outlet
          <input id="qcagEditOutletName" type="text" placeholder="Tên Outlet"/>
        </label>
        <label>Số điện thoại Outlet
          <input id="qcagEditOutletPhone" type="tel" inputmode="numeric" placeholder="SĐT Outlet" oninput="this.value=this.value.replace(/[^0-9+]/g,'')"/>
        </label>
        <label>Địa chỉ Outlet
          <input id="qcagEditOutletAddress" type="text" placeholder="Địa chỉ Outlet"/>
        </label>
        <label>Ghi chú (tuỳ chọn)
          <textarea id="qcagEditOutletNote" rows="2" placeholder="Ghi chú chỉnh sửa (không bắt buộc)"></textarea>
        </label>
      </div>
      <div class="qcag-edit-items-actions">
        <button onclick="qcagCloseEditOutletModal()" class="btn">Hủy</button>
        <button onclick="qcagDesktopConfirmEditOutletModal()" class="btn primary">Xác nhận</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
}

function qcagDesktopOpenEditOutletModal() {
  if (!currentDetailRequest) return;
  qcagEnsureEditOutletModal();
  document.getElementById('qcagEditOutletCode').value = currentDetailRequest.outletCode || '';
  document.getElementById('qcagEditOutletName').value = currentDetailRequest.outletName || '';
  document.getElementById('qcagEditOutletPhone').value = currentDetailRequest.phone || '';
  document.getElementById('qcagEditOutletAddress').value = currentDetailRequest.address || '';
  document.getElementById('qcagEditOutletNote').value = '';
  const modal = document.getElementById('qcagEditOutletModal');
  if (modal) modal.classList.remove('hidden');
}

function qcagCloseEditOutletModal() {
  const modal = document.getElementById('qcagEditOutletModal');
  if (modal) modal.classList.add('hidden');
}

async function qcagDesktopConfirmEditOutletModal() {
  if (!currentDetailRequest) return;
  const newCode = (document.getElementById('qcagEditOutletCode').value || '').trim();
  const newName = (document.getElementById('qcagEditOutletName').value || '').trim();
  const newPhone = (document.getElementById('qcagEditOutletPhone').value || '').trim();
  const newAddress = (document.getElementById('qcagEditOutletAddress').value || '').trim();
  const note = (document.getElementById('qcagEditOutletNote').value || '').trim();

  if (!newCode || !newName) {
    showToast('Outlet Code và Tên Outlet không được để trống');
    return;
  }

  qcagCloseEditOutletModal();

  const now = new Date().toISOString();
  const editor = (currentSession && (currentSession.name || currentSession.phone)) || 'QCAG';
  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);

  const changes = [];
  if (newCode !== (currentDetailRequest.outletCode || '')) changes.push(`Outlet Code: ${currentDetailRequest.outletCode || '-'} → ${newCode}`);
  if (newName !== (currentDetailRequest.outletName || '')) changes.push(`Tên Outlet: ${currentDetailRequest.outletName || '-'} → ${newName}`);
  if (newPhone !== (currentDetailRequest.phone || '')) changes.push(`SĐT: ${currentDetailRequest.phone || '-'} → ${newPhone}`);
  if (newAddress !== (currentDetailRequest.address || '')) changes.push(`Địa chỉ: ${currentDetailRequest.address || '-'} → ${newAddress}`);
  if (note) changes.push(`Ghi chú: ${note}`);

  if (changes.length === 0) { showToast('Không có thay đổi nào'); return; }

  comments.push({
    authorRole: 'system',
    authorName: 'Hệ thống',
    text: `QCAG (${editor}) chỉnh sửa thông tin Outlet — ${changes.join('; ')}`,
    createdAt: now
  });

  const updated = {
    ...currentDetailRequest,
    outletCode: newCode,
    outletName: newName,
    phone: newPhone,
    address: newAddress,
    comments: JSON.stringify(comments),
    updatedAt: now
  };

  await qcagDesktopPersistRequest(updated, 'Đã cập nhật thông tin Outlet');
}

// ── Edit Item Modal (edit existing item) ────────────────────────────────

let _qcagEditItemIndex = null;

function qcagEnsureEditSingleItemModal() {
  if (document.getElementById('qcagEditSingleItemModal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'qcagEditSingleItemModal';
  wrap.className = 'qcag-edit-items-modal hidden';
  wrap.innerHTML = `
    <div class="qcag-edit-items-backdrop" onclick="qcagCloseEditSingleItemModal()"></div>
    <div class="qcag-edit-items-panel">
      <div class="qcag-edit-items-header">Sửa hạng mục</div>
      <div class="qcag-edit-items-body">
        <label>Loại bảng hiệu
          <select id="qcagEditSingleItemType" onchange="qcagEditSingleItemOnTypeChange()">
            <option value="">Chọn hạng mục</option>
            ${signTypes.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('')}
          </select>
        </label>
        <div class="qcag-edit-after-type">
          <div class="qcag-edit-grid">
            <label>Hình thức
              <select id="qcagEditSingleItemAction">
                <option value="">Chọn hình thức</option>
                <option value="Làm mới">Làm mới</option>
                <option value="Thay bạt">Thay bạt</option>
              </select>
            </label>
            <label>Brand
              <select id="qcagEditSingleItemBrand">
                <option value="">Chọn brand</option>
                ${allBrands.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}
              </select>
            </label>
          </div>
          <label>Ghi chú / Yêu cầu
            <input id="qcagEditSingleItemNote" type="text" placeholder="Ghi chú"/>
          </label>
          <div class="qcag-edit-grid-3" style="margin-top:8px">
            <label>Chiều ngang (m)
              <input id="qcagEditSingleItemWidth" type="number" step="0.01" min="0" oninput="sanitizeDecimalInput(this)"/>
            </label>
            <label>Chiều cao (m)
              <input id="qcagEditSingleItemHeight" type="number" step="0.01" min="0" oninput="sanitizeDecimalInput(this)"/>
            </label>
            <label>Số trụ
              <input id="qcagEditSingleItemPoles" type="number" min="0" step="1" value="0" oninput="sanitizeIntegerInput(this)"/>
            </label>
          </div>
        </div>
      </div>
      <div class="qcag-edit-items-actions">
        <button onclick="qcagCloseEditSingleItemModal()" class="btn">Hủy</button>
        <button onclick="qcagDesktopConfirmEditSingleItemModal()" class="btn primary">Xác nhận</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
}

function qcagEditSingleItemOnTypeChange() {
  const typeEl = document.getElementById('qcagEditSingleItemType');
  const brandEl = document.getElementById('qcagEditSingleItemBrand');
  const actionEl = document.getElementById('qcagEditSingleItemAction');
  if (!typeEl || !brandEl) return;
  const selectedType = typeEl.value || '';
  if (!selectedType) return;

  const brands = getBrandsForType(selectedType);
  if (Array.isArray(brands) && brands.length > 0) {
    brandEl.innerHTML = `<option value="">Chọn brand</option>${brands.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}`;
    if (brands.length === 1) brandEl.value = brands[0];
  } else {
    brandEl.innerHTML = '<option value="">Chọn brand</option>';
  }
  try {
    if (actionEl) {
      const isLogoType = String(selectedType || '').toLowerCase().includes('logo') || String(selectedType || '').toLowerCase().includes('emblemd');
      if (isLogoType) {
        actionEl.innerHTML = `<option value="">Chọn hình thức</option><option value="Làm mới">Làm mới</option><option value="Sửa chữa">Sửa chữa</option>`;
      } else {
        actionEl.innerHTML = `<option value="">Chọn hình thức</option><option value="Làm mới">Làm mới</option><option value="Thay bạt">Thay bạt</option>`;
      }
    }
  } catch (e) {}
}

function qcagDesktopOpenEditItemModal(index) {
  if (!currentDetailRequest) return;
  qcagEnsureEditSingleItemModal();
  _qcagEditItemIndex = index;

  const items = qcagDesktopParseJson(currentDetailRequest.items, []);
  const item = items[index] || {};

  // Pre-fill type
  const typeEl = document.getElementById('qcagEditSingleItemType');
  typeEl.value = item.type || '';
  // Populate brands/action UI according to type
  qcagEditSingleItemOnTypeChange();
  const brandEl = document.getElementById('qcagEditSingleItemBrand');
  if (brandEl) brandEl.value = item.brand || '';

  // Pre-fill action & note
  document.getElementById('qcagEditSingleItemAction').value = item.action || '';
  document.getElementById('qcagEditSingleItemNote').value = item.note || item.otherContent || '';

  // Pre-fill size fields
  const widthEl  = document.getElementById('qcagEditSingleItemWidth');
  const heightEl = document.getElementById('qcagEditSingleItemHeight');
  const polesEl  = document.getElementById('qcagEditSingleItemPoles');
  if (widthEl)  widthEl.value  = (item.surveySize && item.surveySize.width)  || item.width  || '';
  if (heightEl) heightEl.value = (item.surveySize && item.surveySize.height) || item.height || '';
  if (polesEl)  polesEl.value  = item.poles || 0;

  const modal = document.getElementById('qcagEditSingleItemModal');
  if (modal) modal.classList.remove('hidden');
}

function qcagCloseEditSingleItemModal() {
  const modal = document.getElementById('qcagEditSingleItemModal');
  if (modal) modal.classList.add('hidden');
  _qcagEditItemIndex = null;
}

async function qcagDesktopConfirmEditSingleItemModal() {
  if (_qcagEditItemIndex === null || !currentDetailRequest) return;
  const idx = _qcagEditItemIndex;

  const newType   = (document.getElementById('qcagEditSingleItemType').value   || '').trim();
  const newAction = (document.getElementById('qcagEditSingleItemAction').value  || '').trim();
  const newBrand  = (document.getElementById('qcagEditSingleItemBrand').value   || '').trim();
  const newNote   = (document.getElementById('qcagEditSingleItemNote').value    || '').trim();
  const newWidth  = parseFloat((document.getElementById('qcagEditSingleItemWidth')  || {}).value)  || 0;
  const newHeight = parseFloat((document.getElementById('qcagEditSingleItemHeight') || {}).value) || 0;
  const newPoles  = parseInt((document.getElementById('qcagEditSingleItemPoles')   || {}).value, 10) || 0;

  if (!newType) { showToast('Vui lòng chọn loại hạng mục'); return; }

  qcagCloseEditSingleItemModal();

  const items = qcagDesktopParseJson(currentDetailRequest.items, []);
  if (!items[idx]) { showToast('Không tìm thấy hạng mục'); return; }

  const oldItem = items[idx];
  const now = new Date().toISOString();
  const editor = (currentSession && (currentSession.name || currentSession.phone)) || 'QCAG';

  const changes = [];
  if (newType   !== (oldItem.type   || '')) changes.push(`Loại: ${oldItem.type   || '-'} → ${newType}`);
  if (newBrand  !== (oldItem.brand  || '')) changes.push(`Brand: ${oldItem.brand  || '-'} → ${newBrand}`);
  if (newAction !== (oldItem.action || '')) changes.push(`Hình thức: ${oldItem.action || '-'} → ${newAction}`);
  const oldNote = oldItem.note || oldItem.otherContent || '';
  if (newNote !== oldNote) changes.push(`Ghi chú: ${oldNote || '-'} → ${newNote || '-'}`);
  const oldWidth  = oldItem.width  || 0;
  const oldHeight = oldItem.height || 0;
  const oldPoles  = oldItem.poles  || 0;
  if (newWidth  !== oldWidth)  changes.push(`Chiều ngang: ${oldWidth}m → ${newWidth}m`);
  if (newHeight !== oldHeight) changes.push(`Chiều cao: ${oldHeight}m → ${newHeight}m`);
  if (newPoles  !== oldPoles)  changes.push(`Số trụ: ${oldPoles} → ${newPoles}`);

  items[idx] = {
    ...oldItem,
    type:         newType,
    brand:        newBrand,
    action:       newAction,
    note:         newNote,
    width:        newWidth  || oldItem.width  || undefined,
    height:       newHeight || oldItem.height || undefined,
    poles:        newPoles,
    otherContent: newType === 'Hạng mục khác' ? newNote : (oldItem.otherContent || ''),
    editedByQCAG:   true,
    editedByQCAGBy: editor,
    editedByQCAGAt: now
  };

  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);
  if (changes.length > 0) {
    comments.push({
      authorRole: 'system',
      authorName: 'Hệ thống',
      text: `QCAG (${editor}) sửa hạng mục #${idx + 1} — ${changes.join('; ')}`,
      createdAt: now
    });
  }

  const updated = {
    ...currentDetailRequest,
    items: JSON.stringify(items),
    comments: JSON.stringify(comments),
    updatedAt: now
  };

  await qcagDesktopPersistRequest(updated, 'Đã cập nhật hạng mục');
}

// ── Add Item Modal (existing) ─────────────────────────────────────────

function qcagEnsureEditItemsModal() {
  if (document.getElementById('qcagEditItemsModal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'qcagEditItemsModal';
  wrap.className = 'qcag-edit-items-modal hidden';
  wrap.innerHTML = `
    <div class="qcag-edit-items-backdrop" onclick="qcagCloseEditItemsModal()"></div>
    <div class="qcag-edit-items-panel">
      <div class="qcag-edit-items-header">Thêm hạng mục</div>
      <div class="qcag-edit-items-body">
        <label>
          Loại bảng hiệu
          <select id="qcagEditItemType" onchange="qcagDesktopEditItemsOnTypeChange()">
            <option value="">Chọn hạng mục</option>
            ${signTypes.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('')}
          </select>
        </label>

        <div class="qcag-edit-after-type hidden">
          <div class="qcag-edit-grid">
            <label>
              Hình thức
              <select id="qcagEditItemAction" onchange="qcagEditItemsMaybeValidate()">
                <option value="">Chọn hình thức</option>
                <option value="Làm mới">Làm mới</option>
                <option value="Thay bạt">Thay bạt</option>
              </select>
            </label>

            <label>
              Brand
              <select id="qcagEditItemBrand" onchange="qcagEditItemsMaybeValidate()">
                <option value="">Chọn brand</option>
                ${allBrands.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}
              </select>
            </label>
          </div>

          <label>Yêu cầu
            <input id="qcagEditItemNote" type="text" placeholder="Ghi chú"/>
          </label>

          <div class="qcag-edit-grid-3">
            <label>Chiều ngang (m)
              <input id="qcagEditItemWidth" type="number" step="0.01" min="0" oninput="sanitizeDecimalInput(this); qcagEditItemsMaybeValidate()" />
            </label>
            <label>Chiều cao (m)
              <input id="qcagEditItemHeight" type="number" step="0.01" min="0" oninput="sanitizeDecimalInput(this); qcagEditItemsMaybeValidate()" />
            </label>
            <label>Số trụ
              <input id="qcagEditItemPoles" type="number" min="0" step="1" value="0" oninput="sanitizeIntegerInput(this); qcagEditItemsMaybeValidate()" />
            </label>
          </div>

          </label>
        </div>

        <div class="qcag-edit-other hidden">
          <label>Nội dung yêu cầu
            <textarea id="qcagEditItemOtherContent" rows="3" placeholder="Mô tả chi tiết yêu cầu" class="w-full px-3 py-2.5 border border-gray-200 rounded-lg bg-white text-sm resize-none"></textarea>
          </label>
        </div>
      </div>
      <div class="qcag-edit-items-actions">
        <button onclick="qcagCloseEditItemsModal()" class="btn">Hủy</button>
        <button id="qcagEditItemConfirmBtn" onclick="qcagDesktopConfirmEditItemsModal()" class="btn primary" disabled>Thêm</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
}

function qcagDesktopOpenEditItemsModal() {
  if (!currentDetailRequest || !qcagDesktopCanEditItems(currentDetailRequest)) return;
  qcagEnsureEditItemsModal();
  const typeEl = document.getElementById('qcagEditItemType');
  const actionEl = document.getElementById('qcagEditItemAction');
  const brandEl = document.getElementById('qcagEditItemBrand');
  typeEl.value = '';
  actionEl.value = '';
  brandEl.innerHTML = `<option value="">Chọn brand</option>${allBrands.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}`;
  brandEl.value = '';
  document.getElementById('qcagEditItemNote').value = '';
  document.getElementById('qcagEditItemPoles').value = '0';
  document.getElementById('qcagEditItemWidth').value = '';
  document.getElementById('qcagEditItemHeight').value = '';
  document.getElementById('qcagEditItemOtherContent').value = '';
  const modal = document.getElementById('qcagEditItemsModal');
  if (modal) {
    // hide deferred fields until user selects Type
    const after = modal.querySelector('.qcag-edit-after-type');
    const other = modal.querySelector('.qcag-edit-other');
    if (after) after.classList.add('hidden');
    if (other) other.classList.add('hidden');
    const btn = modal.querySelector('#qcagEditItemConfirmBtn');
    if (btn) btn.disabled = true;
    modal.classList.remove('hidden');
  }
}

function qcagDesktopEditItemsOnTypeChange() {
  const typeEl = document.getElementById('qcagEditItemType');
  const brandEl = document.getElementById('qcagEditItemBrand');
  const modal = document.getElementById('qcagEditItemsModal');
  const after = modal ? modal.querySelector('.qcag-edit-after-type') : null;
  const confirmBtn = modal ? modal.querySelector('#qcagEditItemConfirmBtn') : null;
  if (!typeEl || !brandEl) return;

  const selectedType = typeEl.value || '';
  if (!selectedType) {
    if (after) { after.classList.add('hidden'); after.style.display = 'none'; }
    if (confirmBtn) confirmBtn.disabled = true;
    brandEl.innerHTML = '<option value="">Chọn brand</option>';
    return;
  }

  // If user selected "Hạng mục khác" → show only the other-content textarea and return early
  const otherBlock = modal ? modal.querySelector('.qcag-edit-other') : null;
  if (String(selectedType || '') === 'Hạng mục khác') {
    if (after) { after.classList.add('hidden'); }
    if (otherBlock) { otherBlock.classList.remove('hidden'); }
    if (confirmBtn) confirmBtn.disabled = false;
    return; // skip brands / validate — not needed for "Hạng mục khác"
  }

  // show deferred input fields for all other types
  if (otherBlock) { otherBlock.classList.add('hidden'); }
  if (after) { after.classList.remove('hidden'); after.style.display = ''; }
  if (confirmBtn) confirmBtn.disabled = false;

  const brands = getBrandsForType(selectedType);
  if (!Array.isArray(brands) || brands.length === 0) {
    brandEl.innerHTML = '<option value="">Chọn brand</option>';
    return;
  }
  brandEl.innerHTML = `<option value="">Chọn brand</option>${brands.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}`;
  if (brands.length === 1) {
    brandEl.value = brands[0];
  } else {
    brandEl.value = '';
  }

  // Hide action for Logo types (logos don't require an action)
  try {
    const actionEl = document.getElementById('qcagEditItemAction');
    const actionLabel = actionEl ? actionEl.parentElement : null;
    if (actionEl) {
      const isLogoType = String(selectedType || '').toLowerCase().includes('logo') || String(selectedType || '').toLowerCase().includes('emblemd');
      if (isLogoType) {
        actionEl.innerHTML = `<option value="">Chọn hình thức</option><option value="Làm mới">Làm mới</option><option value="Sửa chữa">Sửa chữa</option>`;
        if (actionLabel) actionLabel.style.display = '';
      } else {
        actionEl.innerHTML = `<option value="">Chọn hình thức</option><option value="Làm mới">Làm mới</option><option value="Thay bạt">Thay bạt</option>`;
        if (actionLabel) actionLabel.style.display = '';
      }
    }
  } catch (e) {}

  qcagEditItemsMaybeValidate();
}

function qcagCloseEditItemsModal() {
  const modal = document.getElementById('qcagEditItemsModal');
  if (modal) modal.classList.add('hidden');
}

function qcagEditItemsMaybeValidate() {
  const modal = document.getElementById('qcagEditItemsModal');
  if (!modal) return false;
  const typeEl = document.getElementById('qcagEditItemType');
  const actionEl = document.getElementById('qcagEditItemAction');
  const brandEl = document.getElementById('qcagEditItemBrand');
  const widthEl = document.getElementById('qcagEditItemWidth');
  const heightEl = document.getElementById('qcagEditItemHeight');
  const polesEl = document.getElementById('qcagEditItemPoles');
  const confirmBtn = modal.querySelector('#qcagEditItemConfirmBtn');
  if (!confirmBtn) return false;

  const typeVal = (typeEl || {}).value || '';
  if (!typeVal) { confirmBtn.disabled = true; return false; }

  // "Hạng mục khác" only needs its textarea — skip action/brand checks
  if (typeVal === 'Hạng mục khác') {
    confirmBtn.disabled = false;
    return true;
  }

  // If logo type, action not required
  // Action is required for all specific item types (except "Hạng mục khác")
  const actionVal = (actionEl || {}).value || '';
  if (!actionVal) { confirmBtn.disabled = true; return false; }

  // Brand required if options present
  const brandVal = (brandEl || {}).value || '';
  if (!brandVal) { confirmBtn.disabled = true; return false; }

  // Width/height/poles accept only numbers (sanitizers on inputs), no further required checks
  confirmBtn.disabled = false;
  return true;
}

async function qcagDesktopConfirmEditItemsModal() {
  if (!currentDetailRequest) return;
  const type = (document.getElementById('qcagEditItemType') || {}).value || '';
  const action = (document.getElementById('qcagEditItemAction') || {}).value || '';
  const brand = (document.getElementById('qcagEditItemBrand') || {}).value || '';
  const note = (document.getElementById('qcagEditItemNote') || {}).value || '';
  const polesVal = parseInt((document.getElementById('qcagEditItemPoles') || {}).value, 10) || 0;
  const width = parseFloat((document.getElementById('qcagEditItemWidth') || {}).value) || 0;
  const height = parseFloat((document.getElementById('qcagEditItemHeight') || {}).value) || 0;
  const survey = false;
  const otherContent = (document.getElementById('qcagEditItemOtherContent') || {}).value || '';

  if (!type) {
    showToast('Vui lòng nhập Loại bảng hiệu');
    return;
  }

  const items = qcagDesktopParseJson(currentDetailRequest.items, []);
  const now = new Date().toISOString();
  items.push({
    type,
    action,
    brand,
    note,
    poles: polesVal,
    width: width || undefined,
    height: height || undefined,
    survey,
    addedByQCAG: true,
    addedByQCAGBy: (currentSession && (currentSession.name || currentSession.phone)) || 'QCAG',
    addedByQCAGAt: now,
    otherContent: type === 'Hạng mục khác' ? otherContent : undefined
  });
  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);
  comments.push({authorRole: 'system', authorName: 'Hệ thống', text: `Thêm hạng mục: ${type}${brand ? ' - ' + brand : ''}${action ? ' - ' + action : ''}`, createdAt: now});

  const updated = {
    ...currentDetailRequest,
    items: JSON.stringify(items),
    comments: JSON.stringify(comments),
    updatedAt: now
  };

  // Close modal immediately and persist in background to keep UI snappy.
  qcagCloseEditItemsModal();
  const confirmBtn = document.getElementById('qcagEditItemConfirmBtn');
  if (confirmBtn) confirmBtn.disabled = true;
  qcagDesktopPersistRequest(updated, 'Đã thêm hạng mục').catch(() => {
    showToast('Không thể thêm hạng mục');
  });
}

async function qcagDesktopRemoveItem(index) {
  if (!currentDetailRequest || !qcagDesktopCanEditItems(currentDetailRequest)) return;
  const items = qcagDesktopParseJson(currentDetailRequest.items, []);
  if (!Array.isArray(items) || index < 0 || index >= items.length) return;

  // Show confirmation modal before deleting
  const itemLabel = items[index] && items[index].type ? items[index].type : `hạng mục số ${index + 1}`;
  const confirmed = await _qcagConfirmDialog(`Xóa hạng mục: ${itemLabel}?`);
  if (!confirmed) return;

  items.splice(index, 1);
  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);
  const now = new Date().toISOString();
  comments.push({authorRole: 'system', authorName: 'Hệ thống', text: `Đã xóa hạng mục số ${index + 1} (${itemLabel})`, createdAt: now});

  const updated = {
    ...currentDetailRequest,
    items: JSON.stringify(items),
    comments: JSON.stringify(comments),
    updatedAt: now
  };

  qcagDesktopPersistRequest(updated, 'Đã xóa hạng mục').catch(() => {});
}

function qcagDesktopInlineChangeBrand(index, newBrand) {
  if (!currentDetailRequest) return;
  if (qcagDesktopIsDone(currentDetailRequest)) {
    showToast('Không thể thay đổi brand — yêu cầu đã hoàn thành');
    _qcagDesktopInPlaceRefresh(currentDetailRequest);
    return;
  }

  const items = qcagDesktopParseJson(currentDetailRequest.items, []);
  if (!Array.isArray(items) || index < 0 || index >= items.length) return;
  const oldBrand = items[index].brand || '';
  if (String(oldBrand || '') === String(newBrand || '')) return;

  items[index].brand = newBrand || '';
  // mark brand-changed metadata and record who made the change
  const now = new Date().toISOString();
  items[index].brandChangedByQCAG = true;
  items[index].brandChangedBy = (currentSession && (currentSession.name || currentSession.phone)) || 'QCAG';
  items[index].brandChangedAt = now;

  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);
  const itemLabel = items[index].type || `hạng mục #${index + 1}`;
  const commentText = `Đổi brand ${itemLabel}: ${oldBrand || '-'} → ${newBrand || '-'} bởi ${(items[index].brandChangedBy)}.`;
  comments.push({authorRole: 'system', authorName: 'Hệ thống', text: commentText, createdAt: now});

  const updated = {
    ...currentDetailRequest,
    items: JSON.stringify(items),
    comments: JSON.stringify(comments),
    updatedAt: now
  };

  // Optimistic UI: update cache + UI immediately, persist in background
  currentDetailRequest = updated;
  qcagDesktopCacheRequest(updated);
  _qcagDesktopInPlaceRefresh(updated);

  qcagDesktopPersistRequest(updated, 'Đã đổi brand').catch(() => {
    showToast('Không thể lưu thay đổi brand');
  });
}

function qcagDesktopFocusInlineBrand(index) {
  const el = document.getElementById('qcagInlineBrandSelect_' + index);
  if (!el) return;
  try { el.focus(); } catch (e) {}
  // Best-effort attempt to hint browsers to open the native dropdown
  try { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); } catch (e) {}
}

async function qcagDesktopAutoSyncEditRequestedFromComments() {
  const list = (allRequests || []).slice();
  if (list.length === 0) return;

  // Only create updates for requests that have a Heineken edit-request
  // and have NOT already been marked via `editingRequestedAt`.
  const candidates = list.filter(req => {
    if (!req || String(req.type || '').toLowerCase() !== 'new') return false;
    if (!qcagDesktopHasHeinekenEditRequest(req)) return false;
    // If an edit was already recorded (editingRequestedAt), skip clearing MQ here.
    if (req.editingRequestedAt) return false;
    return true;
  });

  if (candidates.length === 0) return;

  for (const req of candidates) {
    const updated = {
      ...req,
      editingRequestedAt: req.editingRequestedAt || new Date().toISOString(),
      status: 'processing',
      updatedAt: new Date().toISOString()
    };

    // NOTE: Do NOT clear designImages here. QCAG will upload new MQ images
    // when they complete the edit. Keeping old images allows reference.

    if (window.dataSdk) {
      const result = await window.dataSdk.update(updated);
      if (!result.isOk) continue;
    }

    const idx = allRequests.findIndex(r => r.__backendId === updated.__backendId);
    if (idx !== -1) allRequests[idx] = updated;
  }

  _qcagRequestsVersion += 1;
  _qcagRequestCodeCache.version = 0;
}

function qcagDesktopComputeRequestCodes() {
  if (_qcagRequestCodeCache.version === _qcagRequestsVersion) {
    return _qcagRequestCodeCache.codes;
  }

  const list = (allRequests || []).slice().sort((a, b) => {
    const da = new Date(a.createdAt || 0).getTime();
    const db = new Date(b.createdAt || 0).getTime();
    if (da !== db) return da - db;
    return String(a.__backendId || '').localeCompare(String(b.__backendId || ''));
  });

  const yearCounters = {};
  const codes = {};

  list.forEach(req => {
    const created = new Date(req.createdAt || Date.now());
    const yy = String(created.getFullYear()).slice(-2);
    yearCounters[yy] = (yearCounters[yy] || 0) + 1;
    const seq = String(yearCounters[yy]).padStart(5, '0');
    const key = req.__backendId || `__${created.getTime()}`;
    codes[key] = `TK${yy}.${seq}`;
  });

  _qcagRequestCodeCache = { version: _qcagRequestsVersion, codes };
  return codes;
}

function qcagDesktopStatusBadge(req) {
  // Warranty type has its own independent badge logic
  const _reqType = String(req && req.type || '').toLowerCase();
  if (_reqType === 'warranty') {
    const _ws = String(req && req.status || 'pending').toLowerCase();
    if (_ws === 'done' || _ws === 'processed') {
      if (req.warrantyOutOfScope) return { label: 'Ngoài phạm vi BH', cls: 'warranty-out-of-scope' };
      return { label: 'Đã Bảo hành', cls: 'done' };
    }
    return { label: 'Chờ kiểm tra', cls: 'processing' };
  }

  // Edit request takes highest priority — move back to processing regardless of done state
  if (qcagDesktopIsPendingEditRequest(req)) {
    // mark explicitly as an edit-request badge so we can style it differently
    return { label: 'Chờ chỉnh sửa', cls: 'pending-edit' };
  }

  const designImgs = qcagDesktopParseJson(req && req.designImages, []);
  if (!designImgs || designImgs.length === 0) {
    // no design yet — show explicit "waiting for design" badge
    return { label: 'Chờ thiết kế', cls: 'pending-design' };
  }

  const s = String(req && req.status || 'pending').toLowerCase();
  if (s === 'done' || s === 'processed') return { label: 'Hoàn thành', cls: 'done' };
  // If MQ present but not yet confirmed -> show 'Chờ xác nhận'
  if ((s === 'processing' || s === 'in_progress') && Array.isArray(designImgs) && designImgs.length > 0) return { label: 'Chờ xác nhận', cls: 'pending-confirm' };
  if (s === 'processing' || s === 'in_progress') return { label: 'Đang xử lý', cls: 'processing' };
  return { label: 'Chờ xử lý', cls: 'pending' };
}

function getQCAGDesktopVisibleRequests() {
  let list = (allRequests || []).slice();

  // Apply status filter:
  //   'done'       → completed items WITHOUT a pending edit request
  //   'processing' → items still needing action OR has pending edit request (even if previously done)
  if (_qcagDesktopStatusFilter === 'done') {
    // Show only items explicitly marked done (and not pulled back for editing)
    list = list.filter(r => {
      const status = String(r.status || 'pending').toLowerCase();
      const isDone = status === 'done' || status === 'processed';
      if (!isDone) return false;
      // Warranty type doesn't need MQ to be considered done
      if (String(r.type || '').toLowerCase() === 'warranty') return true;
      // Only treat as done if it has MQ and is explicitly done; edits pull back to processing
      const designImgs = qcagDesktopParseJson(r.designImages, []);
      const hasMq = Array.isArray(designImgs) && designImgs.length > 0;
      const hasEditRequest = qcagDesktopIsPendingEditRequest(r);
      return hasMq && !hasEditRequest;
    });
  }

  // Only show requests based on the active tab (type) and processing rules
  if (_qcagDesktopFilterType === 'new') {
    list = list.filter(r => {
      const typeMatch = String(r.type || '').toLowerCase() === 'new';
      if (!typeMatch) return false;
      if (_qcagDesktopStatusFilter === 'done') return true;
      const status = String(r.status || 'pending').toLowerCase();
      const isDone = status === 'done' || status === 'processed';
      const designImgs = qcagDesktopParseJson(r.designImages, []);
      const needsMq = designImgs.length === 0;
      const needsEdit = qcagDesktopIsPendingEditRequest(r);
      const hasDesignAwaitingConfirm = Array.isArray(designImgs) && designImgs.length > 0 && !isDone;
      // Show items needing MQ, edits, or those with MQ awaiting confirmation in processing
      return needsEdit || needsMq || hasDesignAwaitingConfirm;
    });
  } else if (_qcagDesktopFilterType === 'warranty') {
    list = list.filter(r => {
      const t = String(r.type || '').toLowerCase();
      if (t !== 'warranty') return false;
      if (_qcagDesktopStatusFilter === 'done') return true;
      const status = String(r.status || 'pending').toLowerCase();
      const isDone = status === 'done' || status === 'processed';
      // Show all non-done warranty requests in the processing tab
      return !isDone;
    });
  }

  // Filter by region (support tokens like S4 -> 'South 4', MOT8 -> 'Mondern On Team 8')
  if (_qcagDesktopRegionFilter && _qcagDesktopRegionFilter !== 'all') {
    const token = String(_qcagDesktopRegionFilter || '').toLowerCase();
    const regionPatterns = {
      's4': /south\s*4|\bs4\b/i,
      's5': /south\s*5|\bs5\b/i,
      's16': /south\s*16|\bs16\b/i,
      's17': /south\s*17|\bs17\b/i,
      '24': /south\s*24|\b24\b/i,
      's19': /south\s*19|\bs19\b/i,
      'mot8': /mon?dern\W*on\W*team\W*8|\bmot8\b|modern\W*team\W*8/i,
      'all': /.*/
    };
    const pattern = regionPatterns[token] || new RegExp(token.replace(/[^a-z0-9]/g, ''), 'i');
    list = list.filter(r => {
      const requester = qcagDesktopParseJson(r.requester, {});
      const regionRaw = String(requester.region || r.region || '');
      return pattern.test(regionRaw);
    });
  }

  if (_qcagDesktopSearchQuery) {
    const q = _qcagDesktopSearchQuery;
    list = list.filter(r =>
      String(r.outletName || '').toLowerCase().includes(q) ||
      String(r.outletCode || '').toLowerCase().includes(q) ||
      String(r.address || '').toLowerCase().includes(q)
    );
  }

  if (_qcagDesktopYearFilter !== null) {
    list = list.filter(r => {
      try { return new Date(r.createdAt || 0).getFullYear() === _qcagDesktopYearFilter; }
      catch (e) { return true; }
    });
  }

  if (_qcagDesktopSortMode === 'sale') {
    list.sort((a, b) => {
      const ra = qcagDesktopParseJson(a.requester, {});
      const rb = qcagDesktopParseJson(b.requester, {});
      const na = String(ra.saleName || ra.phone || '').toLowerCase();
      const nb = String(rb.saleName || rb.phone || '').toLowerCase();
      return na.localeCompare(nb, 'vi');
    });
  } else if (_qcagDesktopSortMode === 'tag') {
    list.sort((a, b) => {
      const ta = qcagDesktopStatusBadge(a).label || '';
      const tb = qcagDesktopStatusBadge(b).label || '';
      return ta.localeCompare(tb, 'vi');
    });
  } else {
    list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  }
  // Enrich each request with standardized tags (non-destructive)
  try {
    const enriched = list.map(r => ({ ...r, standardTags: assignStandardTags(r) }));
    return enriched;
  } catch (e) {
    return list;
  }
}

async function openQCAGDesktop() {
  if (!shouldUseQCAGDesktop()) return;
  // Update the push bell indicator on every load
  try { qcagDesktopUpdateBellUI(); } catch (_) {}
  const userLabel = document.getElementById('qcagDesktopUserLabel');
  if (userLabel) {
    // Prefer showing the QCAG employee name if provided; otherwise show phone or default label
    if (currentSession && currentSession.name) {
      userLabel.textContent = currentSession.name;
    } else if (currentSession && currentSession.phone) {
      userLabel.textContent = currentSession.phone;
    } else {
      userLabel.textContent = 'QCAG';
    }
  }

  showScreen('qcagDesktopScreen');
  await qcagDesktopAutoSyncEditRequestedFromComments();
  _qcagRequestsVersion += 1;
  _qcagRequestCodeCache.version = 0;
  renderQCAGDesktopList();
  await qcagDesktopWarmupAllRequestsOnce();

  let requests = getQCAGDesktopVisibleRequests();
  // Extra safety: if viewing 'done' ensure we don't include items without MQ or pulled-back edits
  if (_qcagDesktopStatusFilter === 'done') {
    requests = requests.filter(r => {
      const designImgs = qcagDesktopParseJson(r.designImages, []);
      const hasMq = Array.isArray(designImgs) && designImgs.length > 0;
      const hasEditRequest = qcagDesktopIsPendingEditRequest(r);
      return hasMq && !hasEditRequest;
    });
  }
  if (!_qcagDesktopCurrentId || !requests.find(r => r.__backendId === _qcagDesktopCurrentId)) {
    _qcagDesktopCurrentId = requests[0] ? requests[0].__backendId : null;
  }
  if (_qcagDesktopCurrentId) {
    openQCAGDesktopRequest(_qcagDesktopCurrentId);
  } else {
    const detailEl = document.getElementById('qcagDesktopDetail');
    if (detailEl) detailEl.innerHTML = '<div class="qcag-detail-empty">Chưa có request phù hợp bộ lọc hiện tại</div>';
  }
}

function qcagDesktopOnSearch(value) {
  _qcagDesktopListPage = 0;
  _qcagDesktopSearchQuery = String(value || '').trim().toLowerCase();
  if (_qcagDesktopSearchDebounce) clearTimeout(_qcagDesktopSearchDebounce);
  _qcagDesktopSearchDebounce = setTimeout(() => {
    renderQCAGDesktopList();
  }, 160);
}

function qcagDesktopSetTypeFilter(type) {
  _qcagDesktopListPage = 0;
  _qcagDesktopListScrollSave = 0; // reset scroll when changing filter
  _qcagDesktopFilterType = type || 'new';
  ['new', 'warranty'].forEach(t => {
    const isActive = t === _qcagDesktopFilterType;
    const btn = document.getElementById(`qcagFilter${t === 'new' ? 'New' : 'Warranty'}`);
    if (btn) btn.classList.toggle('active', isActive);
    const detailBtn = document.getElementById(`detailFilter${t === 'new' ? 'New' : 'Warranty'}`);
    if (detailBtn) detailBtn.classList.toggle('active', isActive);
  });
  renderQCAGDesktopList();

  const requests = getQCAGDesktopVisibleRequests();
  if (!requests.find(r => r.__backendId === _qcagDesktopCurrentId)) {
    _qcagDesktopCurrentId = null;
    const first = requests[0] ? requests[0].__backendId : null;
    if (first) {
      openQCAGDesktopRequest(first);
    } else {
      const detailEl = document.getElementById('qcagDesktopDetail');
      if (detailEl) detailEl.innerHTML = '<div class="qcag-detail-empty">Chưa có request phù hợp bộ lọc hiện tại</div>';
    }
  }
}

function qcagDesktopSetRegionFilter(region) {
  _qcagDesktopListPage = 0;
  _qcagDesktopRegionFilter = region || 'all';
  const regions = ['all', 'S4', 'S5', 'S16', 'S17', '24', 'S19', 'MOT8'];
  regions.forEach(r => {
    const btn = document.getElementById(`qcagRegion${r === 'all' ? 'All' : r}`);
    if (btn) btn.classList.toggle('active', r === _qcagDesktopRegionFilter);
  });
  renderQCAGDesktopList();
  const requests = getQCAGDesktopVisibleRequests();
  if (!requests.find(r => r.__backendId === _qcagDesktopCurrentId)) {
    _qcagDesktopCurrentId = null;
    const first = requests[0] ? requests[0].__backendId : null;
    if (first) openQCAGDesktopRequest(first);
    else { const detailEl = document.getElementById('qcagDesktopDetail'); if (detailEl) detailEl.innerHTML = '<div class="qcag-detail-empty">Chưa có request phù hợp bộ lọc hiện tại</div>'; }
  }
}

function qcagDesktopSetStatusFilter(status) {
  _qcagDesktopListPage = 0;
  _qcagDesktopStatusFilter = status || 'processing';
  ['processing', 'done'].forEach(s => {
    const isActive = s === _qcagDesktopStatusFilter;
    const sideBtn = document.getElementById(`qcagStatus${s === 'processing' ? 'Processing' : 'Done'}`);
    if (sideBtn) sideBtn.classList.toggle('active', isActive);
    const detailBtn = document.getElementById(`detailStatus${s === 'processing' ? 'Processing' : 'Done'}`);
    if (detailBtn) detailBtn.classList.toggle('active', isActive);
  });
  renderQCAGDesktopList();

  // When switching between status tabs, clear the currently shown detail
  // so the right-hand panel displays the "no matching request" placeholder
  // until the user explicitly selects a request in the new tab.
  _qcagDesktopCurrentId = null;
  const detailEl = document.getElementById('qcagDesktopDetail');
  if (detailEl) detailEl.innerHTML = '<div class="qcag-detail-empty">Chưa có request phù hợp bộ lọc hiện tại</div>';
}

function qcagDesktopUpdateFilterCounts() {
  let list = (allRequests || []).slice();

  // Apply region filter to counts as well so the small tabs reflect current region selection
  if (_qcagDesktopRegionFilter && _qcagDesktopRegionFilter !== 'all') {
    const token = String(_qcagDesktopRegionFilter || '').toLowerCase();
    const regionPatterns = {
      's4': /south\s*4|\bs4\b/i,
      's5': /south\s*5|\bs5\b/i,
      's16': /south\s*16|\bs16\b/i,
      's17': /south\s*17|\bs17\b/i,
      '24': /south\s*24|\b24\b/i,
      's19': /south\s*19|\bs19\b/i,
      'mot8': /mon?dern\W*on\W*team\W*8|\bmot8\b|modern\W*team\W*8/i,
      'all': /.*/
    };
    const pattern = regionPatterns[token] || new RegExp(token.replace(/[^a-z0-9]/g, ''), 'i');
    list = list.filter(r => {
      const requester = qcagDesktopParseJson(r.requester, {});
      const regionRaw = String(requester.region || r.region || '');
      return pattern.test(regionRaw);
    });
  }

  function matchesStatusForType(r, type) {
    const t = String(r.type || '').toLowerCase();
    if (type && t !== type) return false;
    // Done items are not part of "processing"
    const status = String(r.status || 'pending').toLowerCase();
    const isDone = status === 'done' || status === 'processed';

    if (_qcagDesktopStatusFilter === 'processing') {
      if (t === 'new') {
        const designImgs = qcagDesktopParseJson(r.designImages, []);
        const needsMq = designImgs.length === 0;
        const needsEdit = qcagDesktopIsPendingEditRequest(r);
        // Show items needing MQ, with an edit request, or those that have MQ
        // but are still awaiting confirmation — these should remain visible
        // under the "processing" tab so the tab count matches visible cards.
        const hasDesignAwaitingConfirm = Array.isArray(designImgs) && designImgs.length > 0 && !isDone;
        return needsEdit || needsMq || hasDesignAwaitingConfirm;
      }
      if (t === 'warranty') {
        // Show all non-done warranty requests in processing tab count
        return !isDone;
      }
      return !isDone;
    }

    if (_qcagDesktopStatusFilter === 'done') {
      // Exclude items that were pulled back to processing by an edit request
      const designImgs = qcagDesktopParseJson(r.designImages, []);
      const hasMq = Array.isArray(designImgs) && designImgs.length > 0;
      const hasEditRequest = qcagDesktopIsPendingEditRequest(r);
      return isDone && hasMq && !hasEditRequest;
    }

    return true;
  }

  const newCount = list.filter(r => matchesStatusForType(r, 'new')).length;
  const warrantyCount = list.filter(r => matchesStatusForType(r, 'warranty')).length;

  const newSpan = document.getElementById('qcagNewCount');
  const warrantySpan = document.getElementById('qcagWarrantyCount');
  if (newSpan) newSpan.textContent = String(newCount);
  if (warrantySpan) warrantySpan.textContent = String(warrantyCount);
}

function qcagDesktopGoToPage(p) {
  const requests = getQCAGDesktopVisibleRequests();
  const totalPages = Math.max(1, Math.ceil(requests.length / _QCAG_PAGE_SIZE));
  _qcagDesktopListPage = Math.max(0, Math.min(totalPages - 1, p));
  _qcagDesktopListScrollSave = 0; // reset scroll when changing page
  renderQCAGDesktopList();
}

function renderQCAGDesktopList() {
  qcagDesktopUpdateFilterCounts();
  const listEl = document.getElementById('qcagDesktopRequestList');
  if (!listEl || !shouldUseQCAGDesktop()) return;

  const allVisible = getQCAGDesktopVisibleRequests();
  const totalPages = Math.max(1, Math.ceil(allVisible.length / _QCAG_PAGE_SIZE));
  // Clamp current page in case filter changed and reduced total pages
  if (_qcagDesktopListPage >= totalPages) _qcagDesktopListPage = totalPages - 1;
  if (_qcagDesktopListPage < 0) _qcagDesktopListPage = 0;

  const requests = allVisible.slice(
    _qcagDesktopListPage * _QCAG_PAGE_SIZE,
    (_qcagDesktopListPage + 1) * _QCAG_PAGE_SIZE
  );

  if (allVisible.length === 0) {
    listEl.innerHTML = '<div class="qcag-list-empty">Không có request</div>';
    _qcagDesktopRenderPagination(0, 1, 0);
    return;
  }

  const requestCodes = qcagDesktopComputeRequestCodes();
  listEl.innerHTML = requests.map(req => {
    const statusBadge = qcagDesktopStatusBadge(req);
    const activeCls = req.__backendId === _qcagDesktopCurrentId ? 'active' : '';
    const dateStr = req.createdAt ? new Date(req.createdAt).toLocaleString('vi-VN') : '';
    const requester = qcagDesktopParseJson(req.requester, {});
    const saleName = requester.saleName || requester.phone || '-';
    const region = requester.region || '-';
    const requestKey = req.__backendId || `__${new Date(req.createdAt || 0).getTime()}`;
    const requestCode = requestCodes[requestKey] || '';

    const stdTags = Array.isArray(req.standardTags) ? req.standardTags : (assignStandardTags(req) || []);

    // Determine the single display badge for the item (top-right).
    // Priority: edit-request (handled in qcagDesktopStatusBadge) then survey if present.
    let displayBadge = statusBadge;
    try {
      if (Array.isArray(stdTags) && stdTags.indexOf('Chờ khảo sát') !== -1) {
        displayBadge = { label: 'Chờ khảo sát', cls: 'pending survey' };
      }
    } catch (e) {}

    // Waiting time badge: bottom-right, hidden ONLY for genuinely completed items
    // (statusBadge.cls === 'done' means: has MQ + status=done + no pending edit)
    // Cards with status='done' but NO MQ still appear in processing list and should show badge.
    const isDoneItem = (statusBadge.cls === 'done');
    let waitingBadgeHtml = '';
    let deleteBtnHtml = '';
    if (!isDoneItem) {
      const isPendingEdit = qcagDesktopIsPendingEditRequest(req);
      const dateRef = isPendingEdit
        ? (req.editingRequestedAt || req.createdAt)
        : req.createdAt;
      if (dateRef) {
        const waitDays = Math.floor((Date.now() - new Date(dateRef).getTime()) / 86400000);
        const waitColor = waitDays <= 1 ? 'wait-green' : waitDays <= 3 ? 'wait-orange' : 'wait-red';
        const waitLabel = waitDays === 0 ? 'Hôm nay' : (waitDays === 1 ? '1 ngày' : waitDays + ' ngày');
        const waitNote = isPendingEdit ? ' (chỉnh sửa)' : '';
        waitingBadgeHtml = `<span class="qcag-wait-badge ${waitColor}">${escapeHtml(waitLabel)}${waitNote}</span>`;
      }
    }
    
    if (!isDoneItem) {
      deleteBtnHtml = `<button class="qcag-delete-btn" onclick="(event.stopPropagation(), qcagDesktopDeleteRequest('${req.__backendId}'))" title="Xóa yêu cầu">🗑</button>`;
    }
    return `
      <div role="button" tabindex="0" class="qcag-request-item ${activeCls}" onclick="openQCAGDesktopRequest('${req.__backendId}')">
        <div class="qcag-request-item-top">
          <div class="qcag-request-name">${escapeHtml(req.outletName || '-')} • ${escapeHtml(req.outletCode || '-')}</div>
          <span class="qcag-status-badge ${displayBadge.cls}">${displayBadge.label}</span>
        </div>
        <div class="qcag-request-code"><span class="qcag-sale-name-highlight">${escapeHtml(saleName)}</span> • ${escapeHtml(region)}</div>
        <div class="qcag-request-ss">${(() => { const ss = (requester && requester.ssName) || ''; return ss && ss !== '-' ? 'Tên SS/SE: ' + escapeHtml(ss) : '<span class="qcag-ss-tba">Chức vụ TBA</span>'; })()}</div>
        <div class="qcag-request-footer">
          <div class="qcag-request-footer-left">
            <div class="qcag-request-design">Thời gian: ${escapeHtml(dateStr)}</div>
            <div class="qcag-request-date">Mã: ${escapeHtml(requestCode)}</div>
          </div>
          ${waitingBadgeHtml}${deleteBtnHtml}
        </div>
      </div>
    `;
  }).join('');

  // Preserve list scroll position so clicking an item doesn't jump back to top.
  // Only reset to 0 when the saved scroll was already 0 (initial load / page change).
  listEl.scrollTop = _qcagDesktopListScrollSave || 0;
  _qcagDesktopRenderPagination(_qcagDesktopListPage, totalPages, allVisible.length);
}

function _qcagDesktopRenderPagination(currentPage, totalPages, total) {
  const el = document.getElementById('qcagDesktopListPagination');
  if (!el) return;

  const yr = _qcagDesktopYearFilter;
  const yearLabel = yr !== null ? String(yr) : 'Tất cả';
  const dispYear = _qcagDesktopYearDropupYear;
  const allActiveCls = yr === null ? ' qcag-year-all--active' : '';
  const dispActiveCls = (yr !== null && yr === dispYear) ? ' qcag-year-disp--active' : '';

  let pageNavHtml = '';
  if (totalPages > 1) {
    const from = currentPage * _QCAG_PAGE_SIZE + 1;
    const to   = Math.min((currentPage + 1) * _QCAG_PAGE_SIZE, total);
    pageNavHtml = `
      <button class="qcag-page-btn" onclick="qcagDesktopGoToPage(${currentPage - 1})" ${currentPage === 0 ? 'disabled' : ''}>‹</button>
      <span class="qcag-page-info">${from}–${to} / ${total}</span>
      <button class="qcag-page-btn" onclick="qcagDesktopGoToPage(${currentPage + 1})" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>›</button>
    `;
  } else if (total > 0) {
    pageNavHtml = `<span class="qcag-page-info">${total} yêu cầu</span>`;
  }

  const _sortLabels = { time: 'Thời gian', sale: 'Tên Sale', tag: 'Theo Tag' };
  const _sortLabel  = _sortLabels[_qcagDesktopSortMode] || 'Thời gian';

  el.innerHTML = `
    <div class="qcag-pagination-controls">
      <div class="qcag-year-wrap">
        <button class="qcag-year-btn" id="qcagYearBtn" onclick="qcagDesktopYearBtnToggle()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
          <span id="qcagYearBtnLabel">${escapeHtml(yearLabel)}</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
        </button>
        <div class="qcag-year-dropup hidden" id="qcagYearDropup">
          <div class="qcag-year-dropup-head">Chọn Năm <span class="qcag-year-sel-ind">${yr !== null ? 'đang chọn ' + yr : 'đang xem tất cả'}</span></div>
          <button class="qcag-year-all${allActiveCls}" onclick="qcagDesktopSetYearFilter(null)">Hiển thị tất cả</button>
          <div class="qcag-year-picker">
            <button class="qcag-year-nav" onclick="qcagDesktopYearPickerStep(1)">◀</button>
            <div class="qcag-year-viewport">
              <div class="qcag-year-disp${dispActiveCls}" id="qcagYearDisp" onclick="qcagDesktopApplyDropupYear()" title="Nhấn để chọn năm này">${dispYear}</div>
            </div>
            <button class="qcag-year-nav" onclick="qcagDesktopYearPickerStep(-1)">▶</button>
          </div>
        </div>
      </div>
      <div class="qcag-sort-wrap">
        <button class="qcag-year-btn" id="qcagSortBtn" onclick="qcagDesktopSortBtnToggle()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="15" y2="12"></line><line x1="3" y1="18" x2="9" y2="18"></line></svg>
          <span id="qcagSortBtnLabel">${escapeHtml(_sortLabel)}</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
        </button>
        <div class="qcag-sort-dropup hidden" id="qcagSortDropup">
          <button class="qcag-sort-option${_qcagDesktopSortMode === 'time' ? ' active' : ''}" onclick="qcagDesktopSetSort('time')">Theo thời gian</button>
          <button class="qcag-sort-option${_qcagDesktopSortMode === 'sale' ? ' active' : ''}" onclick="qcagDesktopSetSort('sale')">Tên Sale</button>
          <button class="qcag-sort-option${_qcagDesktopSortMode === 'tag' ? ' active' : ''}" onclick="qcagDesktopSetSort('tag')">Theo Tag</button>
        </div>
      </div>
    </div>
    <div class="qcag-page-nav">${pageNavHtml}</div>
  `;

  // Bind outside-click handler once per pagination element lifetime
  if (!el._yearOutsideClick) {
    el._yearOutsideClick = (e) => {
      const dropupEl = document.getElementById('qcagYearDropup');
      const btnEl    = document.getElementById('qcagYearBtn');
      if (dropupEl && btnEl &&
          !dropupEl.classList.contains('hidden') &&
          !dropupEl.contains(e.target) &&
          !btnEl.contains(e.target)) {
        dropupEl.classList.add('hidden');
      }
      const sortDropupEl = document.getElementById('qcagSortDropup');
      const sortBtnEl    = document.getElementById('qcagSortBtn');
      if (sortDropupEl && sortBtnEl &&
          !sortDropupEl.classList.contains('hidden') &&
          !sortDropupEl.contains(e.target) &&
          !sortBtnEl.contains(e.target)) {
        sortDropupEl.classList.add('hidden');
      }
    };
    document.addEventListener('click', el._yearOutsideClick);
  }
}

function qcagDesktopYearBtnToggle() {
  const dropup = document.getElementById('qcagYearDropup');
  if (!dropup) return;
  if (dropup.classList.contains('hidden')) {
    // Sync picker to current filter year (fallback to current year)
    _qcagDesktopYearDropupYear = _qcagDesktopYearFilter !== null
      ? _qcagDesktopYearFilter
      : new Date().getFullYear();
    const dispEl = document.getElementById('qcagYearDisp');
    if (dispEl) {
      dispEl.textContent = _qcagDesktopYearDropupYear;
      if (_qcagDesktopYearFilter !== null && _qcagDesktopYearDropupYear === _qcagDesktopYearFilter) {
        dispEl.classList.add('qcag-year-disp--active');
      } else {
        dispEl.classList.remove('qcag-year-disp--active');
      }
    }
    // Close sort dropup if open
    const sortDropup = document.getElementById('qcagSortDropup');
    if (sortDropup) sortDropup.classList.add('hidden');
    dropup.classList.remove('hidden');
  } else {
    dropup.classList.add('hidden');
  }
}

function qcagDesktopSetYearFilter(year) {
  _qcagDesktopYearFilter = year;
  _qcagDesktopYearDropupYear = year !== null ? year : new Date().getFullYear();
  _qcagDesktopListPage = 0;
  const dropup = document.getElementById('qcagYearDropup');
  if (dropup) dropup.classList.add('hidden');
  renderQCAGDesktopList();
}

function qcagDesktopApplyDropupYear() {
  qcagDesktopSetYearFilter(_qcagDesktopYearDropupYear);
}

function qcagDesktopSortBtnToggle() {
  const sortDropup = document.getElementById('qcagSortDropup');
  if (!sortDropup) return;
  // Close year dropup if open
  const yearDropup = document.getElementById('qcagYearDropup');
  if (yearDropup) yearDropup.classList.add('hidden');
  sortDropup.classList.toggle('hidden');
}

function qcagDesktopSetSort(mode) {
  _qcagDesktopSortMode = mode || 'time';
  const sortDropup = document.getElementById('qcagSortDropup');
  if (sortDropup) sortDropup.classList.add('hidden');
  _qcagDesktopListPage = 0;
  renderQCAGDesktopList();
}

function qcagDesktopYearPickerStep(dir) {
  const dispEl = document.getElementById('qcagYearDisp');
  if (!dispEl) return;
  // Out animation: when stepping forward (dir>0) we slide current out to left,
  // and new value should slide in from right. Reverse for stepping backward.
  const outCls = dir < 0 ? 'qcag-year-slide-out-right' : 'qcag-year-slide-out-left';
  const inCls  = dir < 0 ? 'qcag-year-slide-in-left'  : 'qcag-year-slide-in-right';

  dispEl.classList.add(outCls);
  const afterOut = () => {
    dispEl.removeEventListener('animationend', afterOut);
    dispEl.classList.remove(outCls);
    _qcagDesktopYearDropupYear += dir;
    dispEl.textContent = _qcagDesktopYearDropupYear;
    if (_qcagDesktopYearFilter !== null && _qcagDesktopYearDropupYear === _qcagDesktopYearFilter) {
      dispEl.classList.add('qcag-year-disp--active');
    } else {
      dispEl.classList.remove('qcag-year-disp--active');
    }
    // play incoming animation from opposite side
    dispEl.classList.add(inCls);
    const afterIn = () => {
      dispEl.removeEventListener('animationend', afterIn);
      dispEl.classList.remove(inCls);
    };
    dispEl.addEventListener('animationend', afterIn);
  };
  dispEl.addEventListener('animationend', afterOut);
}

// Delete request from desktop list (only allowed for non-completed requests)
// Programmatic confirm dialog — works in PWA standalone mode (window.confirm is unreliable).
function _qcagConfirmDialog(message) {
  return new Promise((resolve) => {
    const isDark = document.documentElement.classList.contains('theme-dark')
                || document.documentElement.getAttribute('data-theme') === 'dark';
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(2px);z-index:9999;display:flex;align-items:center;justify-content:center';
    const cardBg     = isDark ? '#0b1220' : '#ffffff';
    const cardBorder = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.04)';
    const textColor  = isDark ? '#e6eef8' : '#111827';
    const subColor   = isDark ? '#9ca3af' : '#6b7280';
    const cancelBg   = isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6';
    const cancelClr  = isDark ? '#e6eef8' : '#374151';
    const cancelBdr  = isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #e5e7eb';
    overlay.innerHTML =
      `<div style="background:${cardBg};border:1px solid ${cardBorder};border-radius:16px;padding:24px 20px 20px;max-width:440px;width:88%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.4)">` +
        `<div style="width:48px;height:48px;border-radius:12px;background:rgba(239,68,68,0.12);display:flex;align-items:center;justify-content:center;margin:0 auto 14px">` +
          `<svg width="22" height="22" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>` +
        `</div>` +
        `<p style="margin-bottom:6px;font-size:15px;font-weight:600;color:${textColor};line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${message}</p>` +
        `<p style="margin-bottom:18px;font-size:12px;color:${subColor}">Hành động này không thể hoàn tác.</p>` +
        `<div style="display:flex;gap:8px">` +
          `<button id="_qcagCancelBtn" style="flex:1;padding:11px;border-radius:10px;background:${cancelBg};border:${cancelBdr};cursor:pointer;font-size:14px;font-weight:500;color:${cancelClr}">Hủy</button>` +
          `<button id="_qcagConfirmBtn" style="flex:1;padding:11px;border-radius:10px;background:#ef4444;color:#fff;border:none;cursor:pointer;font-size:14px;font-weight:600">Xóa</button>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(overlay);
    const cleanup = (result) => { document.body.removeChild(overlay); resolve(result); };
    overlay.querySelector('#_qcagConfirmBtn').onclick = () => cleanup(true);
    overlay.querySelector('#_qcagCancelBtn').onclick  = () => cleanup(false);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
  });
}

async function qcagDesktopDeleteRequest(backendId) {
  try {
    const req = (allRequests || []).find(r => r.__backendId === backendId);
    if (!req) { showToast('Không tìm thấy yêu cầu'); return; }
    const statusBadge = qcagDesktopStatusBadge(req);
    if (statusBadge && statusBadge.cls === 'done') {
      showToast('Không thể xóa request đã hoàn thành');
      return;
    }
    const confirmed = await _qcagConfirmDialog('Bạn có chắc muốn xóa yêu cầu này?');
    if (!confirmed) return;

    if (window.dataSdk && typeof window.dataSdk.delete === 'function') {
      const res = await window.dataSdk.delete(req);
      if (res && res.isOk) {
        showToast('Đã xóa yêu cầu');
      } else {
        showToast('Lỗi khi xóa yêu cầu');
        return;
      }
    } else {
      // local fallback
      const idx = allRequests.findIndex(r => r.__backendId === backendId);
      if (idx !== -1) {
        allRequests.splice(idx, 1);
        try { saveAllRequestsToStorage(); } catch (e) {}
        showToast('Đã xóa yêu cầu');
      }
    }

    // Update UI
    try { _qcagRequestsVersion += 1; _qcagRequestCodeCache.version = 0; } catch (e) {}
    currentDetailRequest = null;
    _qcagDesktopCurrentId = null;
    if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();
    if (typeof renderRequestList === 'function') renderRequestList();
    // Update the detail panel to show the first available request or empty state
    const remaining = getQCAGDesktopVisibleRequests();
    if (remaining.length > 0) {
      openQCAGDesktopRequest(remaining[0].__backendId);
    } else {
      const detailEl = document.getElementById('qcagDesktopDetail');
      if (detailEl) detailEl.innerHTML = '<div class="qcag-detail-empty">Chưa có request phù hợp bộ lọc hiện tại</div>';
    }
  } catch (e) {
    console.warn('qcagDesktopDeleteRequest error', e);
    showToast('Lỗi khi xóa yêu cầu');
  }
}

async function qcagDesktopPersistRequest(updated, successMsg, skipRerender) {
  if (!updated) return false;

  if (window.dataSdk) {
    const result = await window.dataSdk.update(updated);
    if (!result.isOk) {
      showToast('Không thể cập nhật request');
      return false;
    }
  } else {
    const idx = allRequests.findIndex(r => r.__backendId === updated.__backendId);
    if (idx === -1) return false;
    allRequests[idx] = updated;
    saveAllRequestsToStorage();
  }

  const idxAll = allRequests.findIndex(r => r.__backendId === updated.__backendId);
  if (idxAll !== -1) allRequests[idxAll] = updated;
  currentDetailRequest = updated;
  qcagDesktopCacheRequest(updated);
  qcagDesktopWarmRequestAssets(updated).catch(() => {});

  if (successMsg) showToast(successMsg);

  _qcagRequestsVersion += 1;
  _qcagRequestCodeCache.version = 0;

  if (!skipRerender) _qcagDesktopInPlaceRefresh(updated);
  return true;
}

// ── In-place targeted section refresh (thay thế full re-render) ──────
// Cập nhật từng section DOM riêng lẻ thay vì gọi openQCAGDesktopRequest.
// Tránh flicker, tránh nhảy scroll, tránh race condition với onDataChanged.
function _qcagDesktopInPlaceRefresh(updatedRequest) {
  if (!updatedRequest) return;

  // 1. Refresh bảng hạng mục (items table)
  const itemsSec = document.getElementById('qcagItemsSection');
  if (itemsSec) {
    const items = qcagDesktopParseJson(updatedRequest.items, []);
    const canManageItems = qcagDesktopCanEditItems(updatedRequest);
    itemsSec.innerHTML = qcagDesktopBuildItemsHtml(items, canManageItems);
  }

  // 2. Refresh comment timeline
  const timeline = document.getElementById('qcagCommentTimeline');
  if (timeline) {
    const comments = qcagDesktopParseJson(updatedRequest.comments, []);
    timeline.innerHTML = comments.length > 0
      ? comments.map((c, idx) => qcagDesktopCommentHtml(c, comments, idx)).join('')
      : '<div class="qcag-detail-muted">Chưa có bình luận</div>';
    setTimeout(() => { if (timeline) timeline.scrollTop = timeline.scrollHeight; }, 30);
  }

  // 3. Refresh MQ preview + complete button + left list (một lần duy nhất)
  qcagDesktopRefreshMQInPlace(updatedRequest);
}

// ── In-place MQ section refresh (no scroll jump) ─────────────────────
function qcagDesktopRefreshMQInPlace(updatedRequest) {
  const _isWarrantyRefresh = String((updatedRequest && updatedRequest.type) || '').toLowerCase() === 'warranty';
  const designImgs = _isWarrantyRefresh
    ? qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(updatedRequest.acceptanceImages, []))
    : qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(updatedRequest.designImages, []));

  // Rebuild thumb grid in-place
  const previewEl = document.getElementById('qcagMQPreview');
  if (previewEl) {
    previewEl.innerHTML = designImgs.length > 0
      ? designImgs.map((img, i) => `
        <div class="qcag-thumb-item">
          <img src="${img}" onclick="showImageFull(this.src,false)">
          ${_isWarrantyRefresh
            ? `<button type="button" class="qcag-thumb-remove" onclick="qcagDesktopRemoveAcceptanceImage(${i})">✕</button>`
            : `<button type="button" class="qcag-thumb-remove" onclick="qcagDesktopRemoveDesignImage(${i})">✕</button>`
          }
        </div>`).join('')
      : `<div class="qcag-detail-muted">${_isWarrantyRefresh ? 'Chưa có ảnh nghiệm thu' : 'Chưa có MQ'}</div>`;
  }

  // Update the complete button state
  const isSurveySizeIncomplete = qcagDesktopIsSurveySizeIncomplete(updatedRequest);
  const completeBtn = document.querySelector('.qcag-complete-btn');
  if (completeBtn) {
    const isPendingEdit = qcagDesktopIsPendingEditRequest(updatedRequest);
    const reqStatus = String(updatedRequest.status || '').toLowerCase();
    const isDone = (reqStatus === 'done' || reqStatus === 'processed') && !isPendingEdit;

    const disabledTitleBySurvey = isSurveySizeIncomplete ? 'Vui lòng xác nhận kích thước khảo sát trước khi hoàn thành' : '';

    if (isDone) {
      // Trạng thái đã hoàn thành — vô hiệu hoá nút, không cho click lại
      completeBtn.textContent = 'Đã hoàn thành';
      completeBtn.disabled = true;
      completeBtn.classList.add('qcag-complete-btn--disabled');
      completeBtn.title = 'Yêu cầu này đã được hoàn thành';
    } else {
      const label = isPendingEdit ? 'Đã chỉnh sửa' : 'Hoàn thành';
      const disabledTitle = isPendingEdit
        ? 'Vui lòng upload MQ thiết kế trước khi xác nhận đã chỉnh sửa'
        : 'Vui lòng upload MQ thiết kế trước';
      completeBtn.textContent = label;
      if (designImgs.length > 0 && !isSurveySizeIncomplete) {
        completeBtn.disabled = false;
        completeBtn.classList.remove('qcag-complete-btn--disabled');
        completeBtn.removeAttribute('title');
      } else {
        completeBtn.disabled = true;
        completeBtn.classList.add('qcag-complete-btn--disabled');
        completeBtn.title = isSurveySizeIncomplete ? disabledTitleBySurvey : disabledTitle;
      }
    }
  }

  // Refresh survey-size warning line inside MQ footer
  const warningEl = document.querySelector('.qcag-survey-warning');
  if (isSurveySizeIncomplete) {
    if (warningEl) {
      warningEl.textContent = 'Vui lòng xác nhận kích thước khảo sát trước khi hoàn thành.';
    } else {
      const footerLeft = document.querySelector('.qcag-mq-footer-left');
      if (footerLeft) {
        const warningNode = document.createElement('div');
        warningNode.className = 'qcag-survey-warning';
        warningNode.textContent = 'Vui lòng xác nhận kích thước khảo sát trước khi hoàn thành.';
        footerLeft.appendChild(warningNode);
      }
    }
  } else if (warningEl) {
    warningEl.remove();
  }

  // Refresh the left list panel (badge / status)
  renderQCAGDesktopList();
}

async function qcagDesktopSyncReadStatus(request) {
  if (!request || !currentSession) return;
  const me = `qcag:${currentSession.phone || 'unknown'}`;
  const comments = qcagDesktopParseJson(request.comments, []);
  let changed = false;

  const nextComments = comments.map(c => {
    const role = String(c.authorRole || '').toLowerCase();
    if (role === 'qcag') return c;
    const readBy = Array.isArray(c.readBy) ? c.readBy.slice() : [];
    if (!readBy.includes(me)) {
      readBy.push(me);
      changed = true;
      return { ...c, readBy };
    }
    return c;
  });

  if (!changed) return;
  const updated = { ...request, comments: JSON.stringify(nextComments), updatedAt: new Date().toISOString() };
  await qcagDesktopPersistRequest(updated, '');
}

function qcagDesktopCommentHtml(comment, allComments, commentIndex) {
  const author = comment.authorName || comment.authorRole || 'Người dùng';
  const role = String(comment.authorRole || '').toLowerCase();
  const isQCAG = role === 'qcag';
  const avatar = qcagDesktopInitials(author);
  const createdAt = comment.createdAt ? new Date(comment.createdAt).toLocaleString('vi-VN') : '';
  const readBy = Array.isArray(comment.readBy) ? comment.readBy : [];
  const readText = isQCAG ? (readBy.length > 0 ? 'Đã đọc' : 'Chưa đọc') : '';
  const images = qcagDesktopPrepareRenderImageList(Array.isArray(comment.images) ? comment.images : []);
  // Special rendering for edit-request comments (from Sale / Heineken)
  if (String(comment.commentType || '').toLowerCase() === 'edit-resolved') {
    const resolvedText = escapeHtml((comment.text || 'QCAG đã chỉnh sửa xong theo yêu cầu').toString().trim());
    return '<div class="qcag-comment-item ' + (isQCAG ? 'mine' : 'other') + '">' +
      '<div class="qcag-comment-avatar">' + escapeHtml(avatar) + '</div>' +
      '<div class="qcag-comment-col">' +
        '<div class="qcag-comment-meta"><span class="qcag-comment-author">' + escapeHtml(author) + '</span></div>' +
        '<div class="qcag-comment-body">' +
          '<div class="cer-tag-inline"><span class="cer-tag-main">Đã chỉnh sửa</span></div>' +
          '<div class="qcag-comment-text">' + resolvedText + '</div>' +
          (readText ? ('<div class="qcag-comment-read">' + escapeHtml(readText) + '</div>') : '') +
          '<div class="qcag-comment-time-inbubble">' + createdAt + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  if (String(comment.commentType || '').toLowerCase() === 'edit-request') {
    const catsArr = Array.isArray(comment.editCategories) ? comment.editCategories : [];
    const isResolvedLater = qcagDesktopHasLaterEditResolvedComment(allComments, commentIndex);
    let displayText = (comment.text || '').toString().trim();
    if (displayText.startsWith('Yêu cầu chỉnh sửa: ')) displayText = displayText.slice('Yêu cầu chỉnh sửa: '.length).trim();
    else if (displayText === 'Yêu cầu chỉnh sửa') displayText = '';
    const displayTextStr = escapeHtml(displayText);
    const catsHtml = catsArr.length > 0 ? '<div class="cer-cats-inline">' + catsArr.map(ct => escapeHtml(ct)).join(', ') + '</div>' : '';
    const readHtml = readText ? ('<div class="qcag-comment-read">' + escapeHtml(readText) + '</div>') : '';

    return '<div class="qcag-comment-item ' + (isQCAG ? 'mine' : 'other') + '">' +
      '<div class="qcag-comment-avatar">' + escapeHtml(avatar) + '</div>' +
      '<div class="qcag-comment-col">' +
        '<div class="qcag-comment-meta"><span class="qcag-comment-author">' + escapeHtml(author) + '</span></div>' +
        '<div class="qcag-comment-body' + (isResolvedLater ? ' qcag-edit-request-disabled' : '') + '">' +
          '<div class="cer-tag-inline">' +
            '<svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>' +
            '<span class="cer-tag-main">Yêu cầu chỉnh sửa</span>' +
          '</div>' +
          catsHtml +
          (displayTextStr ? '<div class="qcag-comment-text">' + displayTextStr + '</div>' : '') +
          (isResolvedLater ? '<div class="qcag-edit-request-note">Đã được QCAG xử lý</div>' : '') +
          readHtml +
          '<div class="qcag-comment-time-inbubble">' + createdAt + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  return `
    <div class="qcag-comment-item ${isQCAG ? 'mine' : 'other'}">
      <div class="qcag-comment-avatar">${escapeHtml(avatar)}</div>
      <div class="qcag-comment-col">
        <div class="qcag-comment-meta"><span class="qcag-comment-author">${escapeHtml(author)}</span></div>
        <div class="qcag-comment-body">
          <div class="qcag-comment-text">${escapeHtml(comment.text || '')}</div>
          ${images.length > 0 ? `<div class="qcag-comment-images">${images.map(img => `<img src="${img}" onclick="showImageFull(this.src,false)">`).join('')}</div>` : ''}
          ${readText ? `<div class="qcag-comment-read">${readText}</div>` : ''}
          <div class="qcag-comment-time-inbubble">${createdAt}</div>
        </div>
      </div>
    </div>
  `;
}

function qcagDesktopIsSurveySizeIncomplete(request) {
  if (!request) return false;
  const items = qcagDesktopParseJson(request.items, []);
  if (!Array.isArray(items)) return false;
  return items.some(item => item && item.survey && (!item.surveySize || !item.surveySize.width || !item.surveySize.height));
}

function qcagDesktopBuildItemsHtml(items, canManageItems = false) {
  if (!items.length) return '<div class="qcag-detail-muted">Không có hạng mục</div>';
  return `
    <div class="qcag-items-table">
          <div class="qcag-items-head">
            <div>STT</div><div>Loại bảng hiệu</div><div>Hình thức</div><div>Brand</div><div>Kích thước</div><div>Số trụ</div><div>Yêu cầu</div><div></div>
          </div>
      ${items.map((item, idx) => {
        const requestText = item.type === 'Hạng mục khác' ? (item.otherContent || '-') : (item.note || '-');
        let size = '-';
        let sizeExtraNote = '';
        if (item.type !== 'Hạng mục khác') {
          if (item.survey) {
            // If surveySize exists (object with width/height), show it; otherwise show 'Khảo sát' with edit button
            if (item.surveySize && item.surveySize.width && item.surveySize.height) {
              size = `${escapeHtml(String(item.surveySize.width))}m x ${escapeHtml(String(item.surveySize.height))}m`;
              // Always allow editing after a survey size is present
              size = `${size} <button class="qcag-survey-btn" onclick="qcagOpenSurveySizeModal(${idx})" title="Sửa">\
                <svg class="qcag-survey-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\
                  <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z" fill="currentColor"/>\
                </svg>\
              </button>`;
              sizeExtraNote = '<div class="qcag-survey-size-note">Kích thước khảo sát</div>';
            } else {
              size = `<span class="qcag-survey-badge">Khảo sát</span> <button class="qcag-survey-btn" onclick="qcagOpenSurveySizeModal(${idx})" title="Sửa">\
                <svg class="qcag-survey-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">\
                  <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z" fill="currentColor"/>\
                </svg>\
              </button>`;
            }
          } else if (item.useOldSize) {
            size = 'KT cũ';
          } else {
            size = `${item.width || '-'}m x ${item.height || '-'}m`;
          }
        }
        const poles = (item.type !== 'Hạng mục khác') ? ((item.poles || 0) + ' trụ') : '-';
        const sizeHtml = typeof size === 'string' ? size : escapeHtml(String(size));
        const actionCell = canManageItems
          ? `<div class="qcag-item-actions-cell"><button class="qcag-item-edit-btn" onclick="qcagDesktopOpenEditItemModal(${idx})" title="Sửa hạng mục"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button><button class="qcag-item-delete-btn" onclick="qcagDesktopRemoveItem(${idx})" title="Xóa hạng mục">✕</button></div>`
          : '';
        const brandBadge = item && item.brandChangedByQCAG
          ? `<span class="qcag-brand-changed-badge" title="${escapeHtml('Brand được ' + (item.brandChangedBy || 'QCAG') + ' QCAG đổi theo yêu cầu của sale')}"></span>`
          : '';
        const addedBadgeHtml = item && item.addedByQCAG
          ? `<span class="qcag-added-badge" title="${escapeHtml('Hạng mục được thêm bởi ' + (item.addedByQCAGBy || 'QCAG') + ' theo yêu cầu chỉnh sửa' + (item.type ? ': ' + item.type : ''))}"></span>`
          : '';
        const editedBadgeHtml = item && item.editedByQCAG
          ? `<span class="qcag-edited-badge" title="${escapeHtml('Hạng mục được sửa bởi ' + (item.editedByQCAGBy || 'QCAG') + (item.editedByQCAGAt ? ' lúc ' + new Date(item.editedByQCAGAt).toLocaleString('vi-VN') : ''))}"></span>`
          : '';
        const badgesHtml = `${brandBadge}${addedBadgeHtml}${editedBadgeHtml}`;
        return `<div class="qcag-items-row"><div class="qcag-stt-cell"><div class="qcag-stt-num">${idx + 1}</div><div class="qcag-stt-badges">${badgesHtml}</div></div><div>${escapeHtml(item.type || '-')}</div><div>${escapeHtml(item.action || '-')}</div><div>${escapeHtml(item.brand || '-')}</div><div>${sizeHtml}${sizeExtraNote}</div><div>${escapeHtml(poles)}</div><div>${escapeHtml(requestText)}</div>${actionCell}</div>`;
      }).join('')}
    </div>
  `;
}

// Survey size modal utilities
function qcagEnsureSurveyModal() {
  if (document.getElementById('qcagSurveySizeModal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'qcagSurveySizeModal';
  wrap.className = 'qcag-survey-modal hidden';
  wrap.innerHTML = `
    <div class="qcag-survey-backdrop" onclick="qcagCloseSurveySizeModal()"></div>
    <div class="qcag-survey-panel">
      <div class="qcag-survey-header">Nhập kích thước khảo sát</div>
      <div class="qcag-survey-body">
        <label>Chiều ngang (m)<input id="qcagSurveyWidth" type="number" step="0.01" min="0"/></label>
        <label>Chiều cao (m)<input id="qcagSurveyHeight" type="number" step="0.01" min="0"/></label>
      </div>
      <div class="qcag-survey-actions">
        <button onclick="qcagCloseSurveySizeModal()" class="btn">Hủy</button>
        <button onclick="qcagReopenSurveyForItem()" class="btn">Khảo sát lại</button>
        <button onclick="qcagConfirmSurveySize()" class="btn primary">Xác nhận</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
}

let _qcagSurveyEditingIndex = null;
function qcagOpenSurveySizeModal(itemIndex) {
  qcagEnsureSurveyModal();
  _qcagSurveyEditingIndex = itemIndex;
  const wEl = document.getElementById('qcagSurveyWidth');
  const hEl = document.getElementById('qcagSurveyHeight');
  const items = qcagDesktopParseJson(currentDetailRequest.items, []);
  const item = items[itemIndex] || {};
  if (item.surveySize) {
    wEl.value = item.surveySize.width || '';
    hEl.value = item.surveySize.height || '';
  } else {
    wEl.value = '';
    hEl.value = '';
  }
  const modal = document.getElementById('qcagSurveySizeModal');
  if (modal) modal.classList.remove('hidden');
}

function qcagCloseSurveySizeModal() {
  const modal = document.getElementById('qcagSurveySizeModal');
  if (modal) modal.classList.add('hidden');
  _qcagSurveyEditingIndex = null;
}

async function qcagConfirmSurveySize() {
  if (_qcagSurveyEditingIndex === null || !currentDetailRequest) return qcagCloseSurveySizeModal();
  const wEl = document.getElementById('qcagSurveyWidth');
  const hEl = document.getElementById('qcagSurveyHeight');
  const w = parseFloat((wEl && wEl.value) || 0);
  const h = parseFloat((hEl && hEl.value) || 0);
  if (!w || !h) {
    showToast('Vui lòng nhập chiều ngang và chiều cao hợp lệ');
    return;
  }

  const items = qcagDesktopParseJson(currentDetailRequest.items, []);
  if (!items[_qcagSurveyEditingIndex]) return qcagCloseSurveySizeModal();
  items[_qcagSurveyEditingIndex].surveySize = { width: w, height: h };

  // Append a system comment recording this confirmation
  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);
  const now = new Date().toISOString();
  const displayTime = new Date(now).toLocaleString('vi-VN');
  const outletName = currentDetailRequest.outletName || '-';
  const itemType = items[_qcagSurveyEditingIndex].type || `hạng mục #${_qcagSurveyEditingIndex + 1}`;
  const autoCommentText = `Outlet ${outletName}: Xác nhận kích thước khảo sát ${itemType} là ${w}m x ${h}m vào ${displayTime}.`;
  comments.push({ authorRole: 'system', authorName: 'Hệ thống', text: autoCommentText, createdAt: now });

  const updated = { ...currentDetailRequest, items: JSON.stringify(items), comments: JSON.stringify(comments), updatedAt: now };
  const ok = await qcagDesktopPersistRequest(updated, 'Đã lưu kích thước khảo sát');
  if (ok) qcagCloseSurveySizeModal();
}

// Mark the current editing item as needing survey again (remove surveySize)
async function qcagReopenSurveyForItem() {
  if (_qcagSurveyEditingIndex === null || !currentDetailRequest) return qcagCloseSurveySizeModal();
  const items = qcagDesktopParseJson(currentDetailRequest.items, []);
  if (!items[_qcagSurveyEditingIndex]) return qcagCloseSurveySizeModal();

  // Remove confirmed size so item becomes 'Chờ khảo sát'
  try { delete items[_qcagSurveyEditingIndex].surveySize; } catch (e) { items[_qcagSurveyEditingIndex].surveySize = null; }
  items[_qcagSurveyEditingIndex].survey = true;

  // Append a system comment recording this action
  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);
  const now = new Date().toISOString();
  const displayTime = new Date(now).toLocaleString('vi-VN');
  const outletName = currentDetailRequest.outletName || '-';
  const itemType = items[_qcagSurveyEditingIndex].type || `hạng mục #${_qcagSurveyEditingIndex + 1}`;
  const autoCommentText = `Outlet ${outletName}: Đặt lại trạng thái khảo sát cho ${itemType} vào ${displayTime}.`;
  comments.push({ authorRole: 'system', authorName: 'Hệ thống', text: autoCommentText, createdAt: now });

  const updated = { ...currentDetailRequest, items: JSON.stringify(items), comments: JSON.stringify(comments), updatedAt: now };
  const ok = await qcagDesktopPersistRequest(updated, 'Đã đặt lại trạng thái khảo sát');
  if (ok) qcagCloseSurveySizeModal();
}

function qcagToggleComments() {
  _qcagCommentsCollapsed = !_qcagCommentsCollapsed;
  const layout = document.getElementById('qcagDetailLayout');
  const expandTab = document.getElementById('qcagExpandCommentsTab');
  const toggleBtn = document.getElementById('qcagCommentsToggleBtn');
  if (layout) {
    layout.classList.toggle('qcag-chat-collapsed', _qcagCommentsCollapsed);
  }
  if (expandTab) {
    expandTab.style.display = _qcagCommentsCollapsed ? '' : 'none';
  }
  if (!_qcagCommentsCollapsed) {
    setTimeout(() => {
      const timeline = document.getElementById('qcagCommentTimeline');
      if (timeline) timeline.scrollTop = timeline.scrollHeight;
    }, 40);
  }
}

function qcagDesktopAttachCommentPaste() {
  const ta = document.getElementById('qcagCommentInput');
  if (!ta || ta._pasteAttached) return;
  ta._pasteAttached = true;
  ta.addEventListener('paste', (e) => {
    const items = (e.clipboardData || {}).items;
    if (!items) return;
    let hasImage = false;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        hasImage = true;
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = (ev) => {
          _qcagDesktopPendingCommentImages.push(ev.target.result);
          qcagDesktopRenderCommentPreview();
        };
        reader.readAsDataURL(file);
      }
    }
    // Don't prevent default so text paste still works
  });
}

function qcagDesktopRenderCommentPreview() {
  const wrap = document.getElementById('qcagCommentUploadPreview');
  if (!wrap) return;  if (_qcagDesktopPendingCommentImages.length === 0) {
    wrap.innerHTML = '';
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  wrap.innerHTML = _qcagDesktopPendingCommentImages.map((img, idx) => `
    <div class="qcag-preview-item">
      <img src="${img}">
      <button onclick="qcagDesktopRemovePendingCommentImage(${idx})" type="button">✕</button>
    </div>
  `).join('');
}

// ── Old design carousel helpers ─────────────────────────────────────

/**
 * Returns all completed requests for the same outlet that have MQ images,
 * excluding the current request. Sorted oldest first.
 */
function ksGetOldDesignsForOutlet(currentReq) {
  if (!currentReq || !currentReq.outletCode) return [];
  const outletCode = String(currentReq.outletCode).trim().toLowerCase();
  // New Outlet requests have no real outlet code — never show old designs for them
  if (outletCode === 'new outlet') return [];
  const currentId = currentReq.__backendId;
  return (allRequests || [])
    .filter(r => {
      if (r.__backendId === currentId) return false;
      // Exclude 'New Outlet' entries from appearing as past designs
      if (String(r.outletCode || '').trim().toLowerCase() === 'new outlet') return false;
      if (String(r.outletCode || '').trim().toLowerCase() !== outletCode) return false;
      const status = String(r.status || '').toLowerCase();
      if (status !== 'done' && status !== 'processed') return false;
      // Prefer cached full version for image check (avoids placeholder '["..."]')
      const src = (typeof _qcagDesktopFullRequestCache !== 'undefined' && _qcagDesktopFullRequestCache[r.__backendId]) || r;
      const imgs = qcagDesktopParseJson(src.designImages, []);
      // Consider a placeholder value '["..."]' as empty
      if (!Array.isArray(imgs) || imgs.length === 0) return false;
      if (imgs.length === 1 && imgs[0] === '...') return false;
      return true;
    })
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

/**
 * Builds the inner HTML for one old-design carousel entry.
 * @param {object} entry   - old request object
 * @param {number} idx     - 0-based current index
 * @param {number} total   - total number of old requests
 * @param {object} codeMap - { [backendId]: 'TKxx.xxxxx' }
 */
function qcagRenderOldDesignViewer(entry, idx, total, codeMap) {
  if (!entry) return '<div class="qcag-detail-muted">Không có thiết kế cũ</div>';
  // Prefer cached full version for actual image URLs (avoids list placeholder '["..."]')
  const fullEntry = (_qcagDesktopFullRequestCache && entry.__backendId && _qcagDesktopFullRequestCache[entry.__backendId]) || entry;
  const designImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(fullEntry.designImages, []));
  const requester  = qcagDesktopParseJson(entry.requester, {});
  const reqCode    = (codeMap && codeMap[entry.__backendId]) || '-';
  const uploadedBy = entry.designUploadedBy || '-';
  const saleName   = requester.saleName || requester.phone || '-';
  const requestTime = entry.createdAt      ? new Date(entry.createdAt).toLocaleString('vi-VN')      : '-';
  const uploadTime  = entry.designUpdatedAt ? new Date(entry.designUpdatedAt).toLocaleString('vi-VN') : '-';

  let imgsHtml = '<div class="qcag-detail-muted">Không có ảnh</div>';
  if (designImgs.length === 1) {
    imgsHtml = `<div class="qcag-gallery-rep qcag-old-gallery-rep" onclick="showImageFull(this.querySelector('img').src,false)"><img src="${designImgs[0]}" alt="MQ thiết kế cũ"></div>`;
  } else if (designImgs.length > 1) {
    const enc = encodeURIComponent(JSON.stringify(designImgs));
    imgsHtml = `<div class="qcag-gallery-rep qcag-old-gallery-rep" onclick="qcagOpenGalleryEncoded('${enc}',0)"><img src="${designImgs[0]}" alt="MQ thiết kế cũ"><div class="qcag-img-more">+${designImgs.length - 1}</div></div>`;
  }

  return `
    <div class="qcag-old-carousel">
      <div class="qcag-old-viewer">
        <div class="qcag-old-req-code">${escapeHtml(reqCode)}</div>
        <div class="qcag-old-img-area">${imgsHtml}</div>
        <div class="qcag-old-nav-row">
          <button class="qcag-old-nav-btn qcag-old-nav-prev" onclick="qcagOldDesignGo(-1)" ${idx === 0 ? 'disabled' : ''}></button>
          <span class="qcag-old-nav-count">${idx + 1}&nbsp;/&nbsp;${total}</span>
          <button class="qcag-old-nav-btn qcag-old-nav-next" onclick="qcagOldDesignGo(1)" ${idx >= total - 1 ? 'disabled' : ''}></button>
        </div>
      </div>
      <div class="qcag-old-info">
        <div class="qcag-old-info-row"><span>Người upload MQ</span><strong>${escapeHtml(uploadedBy)}</strong></div>
        <div class="qcag-old-info-row"><span>Sale yêu cầu</span><strong>${escapeHtml(saleName)}</strong></div>
        <div class="qcag-old-info-row"><span>Thời gian yêu cầu</span><strong>${escapeHtml(requestTime)}</strong></div>
        <div class="qcag-old-info-row"><span>Thời gian upload MQ</span><strong>${escapeHtml(uploadTime)}</strong></div>
      </div>
    </div>
  `;
}

/** Navigate the old-design carousel by dir (+1 / -1). */
function qcagOldDesignGo(dir) {
  if (!currentDetailRequest) return;
  const oldList = ksGetOldDesignsForOutlet(currentDetailRequest);
  if (oldList.length === 0) return;
  _qcagOldDesignIdx = Math.max(0, Math.min(oldList.length - 1, _qcagOldDesignIdx + dir));
  const codeMap = qcagDesktopComputeRequestCodes();
  const section = document.getElementById('qcagOldDesignSection');
  if (section) {
    section.innerHTML = qcagRenderOldDesignViewer(oldList[_qcagOldDesignIdx], _qcagOldDesignIdx, oldList.length, codeMap);
  }
}

async function openQCAGDesktopRequest(id, keepPendingComment) {
  if (!shouldUseQCAGDesktop()) return;

  // Avoid forcing image re-load when clicking the already selected item.
  // (Keeps status/old-content previews stable unless user selects a different request.)
  if (id && id === _qcagDesktopCurrentId) {
    return;
  }

  // ── Two-phase render ────────────────────────────────────────────────
  // Phase 1: render immediately using list data or in-memory cache (no network wait).
  //   The list endpoint returns image arrays as ['...'] placeholder to save bandwidth.
  //   qcagDesktopNormalizeImageUrl already filters '...' → images show as empty until loaded.
  // Phase 2: if not yet fully cached, fetch full request in background and refresh image
  //   sections in-place so the user sees real images appear without a full re-render.
  const _cachedFull = _qcagDesktopFullRequestCache[id];
  let request = _cachedFull || allRequests.find(r => r.__backendId === id);
  if (!request) return;

  const _needsFullFetch = !_cachedFull;

  // Warm already-known assets in background (no-op if nothing cached yet).
  if (!_needsFullFetch) qcagDesktopWarmRequestAssets(request).catch(() => {});

  const isSameReq = _qcagDesktopCurrentId === id;
  _qcagDesktopCurrentId = id;
  currentDetailRequest = request;
  if (!keepPendingComment) _qcagDesktopPendingCommentImages = [];

  // Save current scroll before re-render so list doesn't jump to top
  const _listForScroll = document.getElementById('qcagDesktopRequestList');
  _qcagDesktopListScrollSave = _listForScroll ? (_listForScroll.scrollTop || 0) : 0;
  renderQCAGDesktopList();

  const detailEl = document.getElementById('qcagDesktopDetail');
  if (!detailEl) return;

  let prevLeftScroll = 0;
  if (isSameReq) {
    const existingLeft = detailEl.querySelector('.qcag-detail-left');
    if (existingLeft) prevLeftScroll = existingLeft.scrollTop || 0;
  }

  const items = qcagDesktopParseJson(request.items, []);
  const statusImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(request.statusImages, []));
  const designImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(request.designImages, []));
  const acceptImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(request.acceptanceImages, []));
  const isWarranty = String(request.type || '').toLowerCase() === 'warranty';
  // For warranty requests, the MQ preview panel shows acceptanceImages
  const mqPreviewImgs = isWarranty ? acceptImgs : designImgs;
  const comments = qcagDesktopParseJson(request.comments, []);
  const isPendingEditRequest = qcagDesktopIsPendingEditRequest(request);
  const canManageItems = qcagDesktopCanEditItems(request);
  const completeBtnLabel = isPendingEditRequest ? 'Đã chỉnh sửa' : 'Hoàn thành';
  const completeBtnDisabledTitle = isPendingEditRequest
    ? 'Vui lòng upload MQ thiết kế trước khi xác nhận đã chỉnh sửa'
    : 'Vui lòng upload MQ thiết kế trước';
  const requester = qcagDesktopParseJson(request.requester, {});
  const statusBadge = qcagDesktopStatusBadge(request);

  detailEl.innerHTML = `
    <div class="qcag-detail-layout${_qcagCommentsCollapsed ? ' qcag-chat-collapsed' : ''}" id="qcagDetailLayout">
      <div class="qcag-detail-left">
        <div class="qcag-card">
          <div class="qcag-card-header">
            <div class="qcag-card-title">Thông tin người yêu cầu</div>
            <div class="qcag-request-time">${request.createdAt ? escapeHtml(new Date(request.createdAt).toLocaleString('vi-VN')) : '-'}</div>
          </div>
          <div class="qcag-requester-grid">
            <div><span>Tên Sale</span><strong>${escapeHtml(requester.saleName || requester.saleName || requester.phone || '-')}</strong></div>
            <div><span>Mã Sale</span><strong>${escapeHtml(requester.saleCode || '-')}</strong></div>
            <div><span>SĐT Sale</span><strong>${escapeHtml(requester.phone || '-')}</strong></div>
            <div><span>Khu vực</span><strong>${escapeHtml(requester.region || '-')}</strong></div>
            <div><span>Tên SS/SE</span><strong>${escapeHtml(requester.ssName || requester.ssName || '-')}</strong></div>
          </div>
        </div>

        <div class="qcag-card">
          <div class="qcag-card-title" style="display:flex;align-items:center;justify-content:space-between;">
            <span>Thông tin Outlet</span>
            <button type="button" class="qcag-edit-outlet-btn" onclick="qcagDesktopOpenEditOutletModal()" title="Chỉnh sửa thông tin Outlet"><svg class="qcag-icon-pencil" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Sửa thông tin</button>
          </div>
            <div class="qcag-outlet-grid">
            <div class="ot-first"><span>Tên Outlet:</span><strong>${escapeHtml(request.outletName || '-')}</strong></div>
            <div class="ot-first"><span>Outlet Code:</span><strong class="qcag-outlet-code">${escapeHtml(request.outletCode || '-')}</strong>
              <button type="button" class="qcag-copy-btn qcag-copy-btn-icon" onclick="qcagCopyOutletCode('${escapeHtml(request.outletCode || '')}')" title="Sao chép Outlet Code">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M16 1H4a2 2 0 0 0-2 2v12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                  <rect x="8" y="5" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
            <div class="ot-first"><span>Định vị:</span><strong>${request.outletLat && request.outletLng ? `<button class="qcag-map-btn" onclick="openSavedLocation(${request.outletLat},${request.outletLng})">Xem map</button>` : 'Không có dữ liệu GPS'}</strong></div>
            <div class="ot-second ot-address"><span>Địa chỉ:</span><strong>${escapeHtml(request.address || '-')}</strong></div>
            <div class="ot-second ot-phone"><span>Điện thoại:</span><strong>${escapeHtml(request.phone || '-')}</strong></div>
          </div>
        </div>

        ${isWarranty ? '' : `<div class="qcag-card">
          <div class="qcag-card-title">
            <span>Hạng mục yêu cầu</span>
            ${canManageItems ? '<button type="button" class="qcag-add-item-btn" onclick="qcagDesktopOpenEditItemsModal()">+ Thêm hạng mục</button>' : ''}
          </div>
          <div id="qcagItemsSection">${qcagDesktopBuildItemsHtml(items, canManageItems)}</div>
        </div>`}

        <div class="qcag-card qcag-card--no-frame">
          <div class="qcag-content-split">
              <div class="qcag-subcard">
                <div class="qcag-card-title">${isWarranty ? 'Nội dung kiểm tra bảo hành' : 'Nội dung bảng hiệu'}</div>
                <div class="qcag-subcard-body">
                  ${(() => {
                    try {
                      const isOld = !!request.oldContent;
                      const oldImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(request.oldContentImages, []));
                      const oldExtra = request.oldContentExtra || '';
                      if (isOld) {
                        // Show "Nội dung cũ" badge + any supplementary text
                        let html = '<div class="qcag-old-content-label">Nội dung cũ</div>';
                        // Backward-compat: still render images if old requests have them
                        if (oldImgs.length > 0) {
                          const encOld = encodeURIComponent(JSON.stringify(oldImgs));
                          const firstOld = oldImgs[0];
                          const moreOld = oldImgs.length > 1 ? (oldImgs.length - 1) : 0;
                          if (oldImgs.length === 1) {
                            html += `<div class="qcag-gallery-rep" onclick="showImageFull(this.querySelector('img').src,false)"><img src="${firstOld}" alt="nội dung cũ"></div>`;
                          } else {
                            html += `<div class="qcag-gallery-rep" onclick="qcagOpenGalleryEncoded('${encOld}',0)"><img src="${firstOld}" alt="nội dung cũ"><div class="qcag-img-more">${moreOld > 0 ? '+' + moreOld : ''}</div></div>`;
                          }
                        }
                        if (oldExtra) {
                          html += `<div class="qcag-supplement"><div class="qcag-supplement-title">Yêu cầu thêm:</div><div class="qcag-content-pre">${escapeHtml(oldExtra)}</div></div>`;
                        }
                        return html;
                      }
                      return request.content ? `<div class="qcag-content-pre">${escapeHtml(request.content)}</div>` : `<div class="qcag-detail-muted">Không có mô tả</div>`;
                    } catch (e) { return `<div class="qcag-detail-muted">Không có mô tả</div>`; }
                  })()}
                </div>
              </div>

            <div class="qcag-subcard">
              <div class="qcag-card-title">Hiện trạng Outlet</div>
              <div class="qcag-subcard-body qcag-content-images">
                <div class="qcag-action-block">
                  <label class="qcag-upload-square qcag-status-upload-square" title="Thêm ảnh hiện trạng">
                    <input type="file" accept="image/*" multiple onchange="qcagDesktopUploadStatusImage(this)">
                    <div class="qcag-upload-plus">+</div>
                  </label>
                  <div id="qcagStatusThumbGrid">
                    ${(() => {
                      if (statusImgs.length === 0) return '<span class="qcag-detail-muted">Đang trống</span>';
                      const enc = encodeURIComponent(JSON.stringify(statusImgs));
                      const first = statusImgs[0];
                      const more = statusImgs.length - 1;
                      if (statusImgs.length === 1) {
                        return `<div class="qcag-gallery-rep" onclick="showImageFull('${first}',false)"><img src="${first}" alt="hiện trạng"></div>`;
                      }
                      return `<div class="qcag-gallery-rep" onclick="qcagOpenGalleryEncoded('${enc}',0)"><img src="${first}" alt="hiện trạng"><div class="qcag-img-more">+${more}</div></div>`;
                    })()}
                  </div>
                  ${isWarranty && request.warrantyOutOfScope && request.warrantyOutOfScopeNote
                    ? `<div class="qcag-warranty-scope-note"><span class="qcag-warranty-scope-label">Ngoài phạm vi:</span> ${escapeHtml(request.warrantyOutOfScopeNote)}</div>`
                    : ''}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="qcag-card">
          <div class="qcag-actions qcag-split-cards">
            <div class="qcag-subcard">
              <div class="qcag-card-title">${isWarranty ? 'Nghiệm thu bảo hành' : 'Upload MQ thiết kế'}</div>
              <div class="qcag-subcard-body">
                <div class="qcag-action-block">
                  <label class="qcag-upload-square" title="${isWarranty ? 'Upload ảnh nghiệm thu' : 'Upload MQ thiết kế'}">
                    <input type="file" accept="image/*" multiple onchange="qcagDesktopUploadMQ(this)">
                    <div class="qcag-upload-plus">+</div>
                  </label>
                  <div id="qcagMQPreview" class="qcag-thumb-grid">
                    ${mqPreviewImgs.length > 0 ? mqPreviewImgs.map((img, i) => `
                      <div class="qcag-thumb-item">
                        <img src="${img}" onclick="showImageFull(this.src,false)">
                        <button type="button" class="qcag-thumb-remove" onclick="${isWarranty ? `qcagDesktopRemoveAcceptanceImage(${i})` : `qcagDesktopRemoveDesignImage(${i})`}">✕</button>
                      </div>
                    `).join('') : `<div class="qcag-detail-muted">${isWarranty ? 'Chưa có ảnh nghiệm thu' : 'Chưa có MQ'}</div>`}
                  </div>
                </div>
                
                <div class="qcag-mq-footer">
                  ${(() => {
                    // ── Warranty type: dedicated footer ──────────────────────
                    if (isWarranty) {
                      const wPerson = request.warrantyPersonName || '';
                      const wTime   = request.processedAt || '';
                      const personLine = wPerson
                        ? `Ng\u01b0\u1eddi b\u1ea3o h\u00e0nh: ${escapeHtml(wPerson)}${wTime ? ' \u2022 ' + escapeHtml(new Date(wTime).toLocaleString('vi-VN')) : ''}`
                        : 'Ng\u01b0\u1eddi b\u1ea3o h\u00e0nh: Ch\u01b0a c\u00f3 th\u00f4ng tin';
                      const personClass = wPerson ? 'qcag-mq-created' : 'qcag-mq-created qcag-mq-empty';
                      const showBtns = _qcagDesktopStatusFilter !== 'done';
                      const btns = showBtns
                        ? `<button onclick="qcagDesktopMarkWarrantyResult(true)" class="qcag-warranty-btn qcag-warranty-btn--out">Ngo\u00e0i ph\u1ea1m vi BH</button><button onclick="qcagDesktopMarkWarrantyResult(false)" class="qcag-warranty-btn qcag-warranty-btn--done">\u0110\u00e3 b\u1ea3o h\u00e0nh</button>`
                        : '';
                      return `<div class="qcag-mq-footer-left"><div class="${personClass}">${personLine}</div></div><div class="qcag-mq-footer-right qcag-warranty-btns">${btns}</div>`;
                    }

                    // ── Normal type: design creator / edited info + complete btn ──
                    const createdBy = request.designCreatedBy || '';
                    const createdAt = request.designCreatedAt || '';
                    const lastEditedBy = request.designLastEditedBy || '';
                    const lastEditedAt = request.designLastEditedAt || '';

                    const displayCreator = createdBy || lastEditedBy || '';
                    const displayCreatorTime = createdBy ? createdAt : (lastEditedAt || '');

                    let showEdited = false;
                    if (lastEditedBy) {
                      if (createdBy) {
                        try {
                          const ca = createdAt ? new Date(createdAt).getTime() : 0;
                          const la = lastEditedAt ? new Date(lastEditedAt).getTime() : 0;
                          if (lastEditedBy !== createdBy || la > ca) showEdited = true;
                        } catch (e) { if (lastEditedBy !== createdBy) showEdited = true; }
                      } else {
                        showEdited = false;
                      }
                    }

                    const creatorLine = displayCreator
                      ? `Thi\u1ebft K\u1ebf: ${escapeHtml(displayCreator)}${displayCreatorTime ? ' \u2022 ' + escapeHtml(new Date(displayCreatorTime).toLocaleString('vi-VN')) : ''}`
                      : 'Thi\u1ebft K\u1ebf: Ch\u01b0a c\u00f3 ng\u01b0\u1eddi thi\u1ebft k\u1ebf';

                    const editedLine = showEdited
                      ? `Ch\u1ec9nh s\u1eeda: ${escapeHtml(lastEditedBy)}${lastEditedAt ? ' \u2022 ' + escapeHtml(new Date(lastEditedAt).toLocaleString('vi-VN')) : ''}`
                      : 'Ch\u1ec9nh s\u1eeda: ch\u01b0a c\u00f3 ch\u1ec9nh s\u1eeda n\u00e0o';

                    const creatorClass = displayCreator ? 'qcag-mq-created' : 'qcag-mq-created qcag-mq-empty';
                    const editedClass = showEdited ? 'qcag-mq-edited' : 'qcag-mq-edited qcag-mq-empty';

                    const isSurveySizeIncomplete = qcagDesktopIsSurveySizeIncomplete(request);
                    const showCompleteBtn = _qcagDesktopStatusFilter !== 'done';
                    const completeDisabled = designImgs.length === 0 || isSurveySizeIncomplete;
                    const completeTitle = isSurveySizeIncomplete
                      ? 'Vui l\u00f2ng x\u00e1c nh\u1eadn k\u00edch th\u01b0\u1edbc kh\u1ea3o s\u00e1t tr\u01b0\u1edbc khi ho\u00e0n th\u00e0nh'
                      : (designImgs.length === 0 ? escapeHtml(completeBtnDisabledTitle) : '');

                    const warning = isSurveySizeIncomplete
                      ? '<div class="qcag-survey-warning">Vui l\u00f2ng x\u00e1c nh\u1eadn k\u00edch th\u01b0\u1edbc kh\u1ea3o s\u00e1t tr\u01b0\u1edbc khi ho\u00e0n th\u00e0nh.</div>'
                      : '';

                    const btn = showCompleteBtn
                      ? `<button onclick="qcagDesktopMarkProcessed()" class="qcag-complete-btn${completeDisabled ? ' qcag-complete-btn--disabled' : ''}" ${completeDisabled ? `disabled title="${completeTitle}"` : ''}>${escapeHtml(completeBtnLabel)}</button>`
                      : '';

                    return `<div class="qcag-mq-footer-left"><div class="${creatorClass}">${creatorLine}</div><div class="${editedClass}">${editedLine}</div>${warning}</div><div class="qcag-mq-footer-right">${btn}</div>`;
                  })()}
                </div>
              </div>
            </div>

            <div class="qcag-subcard">
              <div class="qcag-card-title">Những thiết kế cũ của Outlet</div>
              <div class="qcag-subcard-body" id="qcagOldDesignSection">
                ${(() => {
                  _qcagOldDesignIdx = 0;
                  const oldList = ksGetOldDesignsForOutlet(request);
                  if (oldList.length === 0) return '<div class="qcag-detail-muted">Outlet này chưa có thiết kế nào hoàn thành</div>';
                  const codeMap = qcagDesktopComputeRequestCodes();
                  return qcagRenderOldDesignViewer(oldList[0], 0, oldList.length, codeMap);
                })()}
              </div>
            </div>
          </div>
        </div>
      </div>

      <button id="qcagExpandCommentsTab" class="qcag-expand-comments-tab" onclick="qcagToggleComments()" type="button" ${_qcagCommentsCollapsed ? '' : 'style="display:none"'}>
        ${comments.length > 0 ? `<span class="qcag-comments-count-badge">${comments.length}</span>` : ''}
        <span class="qcag-expand-comments-tab-label">Bình luận ▸</span>
      </button>
      <div class="qcag-detail-right">
        <div class="qcag-chat-card">
          <div class="qcag-chat-head">
            <span>Trao đổi QCAG ↔ Sale Heineken</span>
            <button id="qcagCommentsToggleBtn" class="qcag-comments-toggle-btn" onclick="qcagToggleComments()" type="button">
              Đóng ▶
            </button>
          </div>
          <div id="qcagChatBody" class="qcag-chat-body">
            <div id="qcagCommentTimeline" class="qcag-comment-timeline">
              ${comments.length > 0 ? comments.map((c, idx) => qcagDesktopCommentHtml(c, comments, idx)).join('') : '<div class="qcag-detail-muted">Chưa có bình luận</div>'}
            </div>
            <div class="qcag-chat-input-wrap">
              <div class="qcag-comment-input-box">
                <textarea id="qcagCommentInput" rows="3" placeholder="Nhập bình luận..."></textarea>
                <div id="qcagCommentUploadPreview" class="qcag-upload-preview hidden"></div>
              </div>
              <div class="qcag-chat-actions">
                <label class="qcag-comment-upload">Upload hình
                  <input type="file" accept="image/*" multiple onchange="qcagDesktopPickCommentImages(this)">
                </label>
                <button onclick="qcagDesktopSendComment()" class="qcag-send-btn">Gửi</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  qcagDesktopRenderCommentPreview();
  qcagDesktopAttachCommentPaste();

  if (prevLeftScroll > 0) {
    const newLeft = detailEl.querySelector('.qcag-detail-left');
    if (newLeft) newLeft.scrollTop = prevLeftScroll;
  }

  if (!_qcagCommentsCollapsed) {
    setTimeout(() => {
      const timeline = document.getElementById('qcagCommentTimeline');
      if (timeline) timeline.scrollTop = timeline.scrollHeight;
    }, 40);
  }

  qcagDesktopSyncReadStatus(request);

  // ── Phase 2: background full-request fetch (only when not yet cached) ──
  // Fetches real image URLs to replace ['...'] placeholders, then refreshes
  // status-image and MQ-image sections in-place — no flicker, no scroll jump.
  if (_needsFullFetch) {
    qcagDesktopGetFullRequest(id).then(full => {
      if (!full || _qcagDesktopCurrentId !== id) return;
      currentDetailRequest = full;
      // Refresh hiện trạng (status) images section
      const statusThumbEl = document.getElementById('qcagStatusThumbGrid');
      if (statusThumbEl) {
        const newSImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(full.statusImages, []));
        if (newSImgs.length === 0) {
          statusThumbEl.innerHTML = '<span class="qcag-detail-muted">Đang trống</span>';
        } else {
          const enc = encodeURIComponent(JSON.stringify(newSImgs));
          const first = newSImgs[0];
          if (newSImgs.length === 1) {
            statusThumbEl.innerHTML = `<div class="qcag-gallery-rep" onclick="showImageFull('${first}',false)"><img src="${first}" alt="hiện trạng"></div>`;
          } else {
            statusThumbEl.innerHTML = `<div class="qcag-gallery-rep" onclick="qcagOpenGalleryEncoded('${enc}',0)"><img src="${first}" alt="hiện trạng"><div class="qcag-img-more">+${newSImgs.length - 1}</div></div>`;
          }
        }
      }
      // Refresh MQ / design / acceptance images + complete button state
      qcagDesktopRefreshMQInPlace(full);
      qcagDesktopWarmRequestAssets(full).catch(() => {});
    }).catch(() => {});
  }

  // Background refresh: fetch full data for old design entries so real image URLs replace
  // the '["..."]' placeholder that the list endpoint uses for bandwidth efficiency.
  (async () => {
    const snapshotId = _qcagDesktopCurrentId;
    const oldList = ksGetOldDesignsForOutlet(request);
    if (oldList.length === 0) return;
    // Fetch full data for each old entry (skip if already cached)
    const unfetched = oldList.filter(e => e.__backendId && !_qcagDesktopFullRequestCache[e.__backendId]);
    if (unfetched.length > 0) {
      await Promise.all(unfetched.map(e => qcagDesktopGetFullRequest(e.__backendId).catch(() => {})));
      // Only re-render if this request is still open
      if (_qcagDesktopCurrentId !== snapshotId) return;
      const section = document.getElementById('qcagOldDesignSection');
      if (!section) return;
      const freshList = ksGetOldDesignsForOutlet(currentDetailRequest);
      if (freshList.length === 0) {
        section.innerHTML = '<div class="qcag-detail-muted">Outlet này chưa có thiết kế nào hoàn thành</div>';
      } else {
        const codeMap = qcagDesktopComputeRequestCodes();
        _qcagOldDesignIdx = Math.min(_qcagOldDesignIdx, freshList.length - 1);
        section.innerHTML = qcagRenderOldDesignViewer(freshList[_qcagOldDesignIdx], _qcagOldDesignIdx, freshList.length, codeMap);
      }
    }
  })().catch(() => {});
}

async function qcagDesktopUploadStatusImage(input) {
  if (!currentDetailRequest || !input) return;
  const files = Array.from(input.files || []);
  if (files.length === 0) return;
  input.value = '';

  const currentImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(currentDetailRequest.statusImages, [])).slice();

  for (const file of files) {
    // Compress immediately (WebP preferred) — much faster upload
    let dataUrl;
    try {
      dataUrl = await _compressImageFile(file, 1600, 0.82);
    } catch (_) {
      dataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = (e) => { dataUrl = e.target.result; resolve(); };
        reader.readAsDataURL(file);
      });
    }
    let imageUrl = dataUrl;
    if (window.dataSdk && window.dataSdk.uploadImage && currentDetailRequest.__backendId) {
      try {
        const uploaded = await window.dataSdk.uploadImage(
          dataUrl, file.name || 'status.jpg', currentDetailRequest.__backendId, 'hien-trang'
        );
        if (typeof uploaded === 'string' && uploaded.trim()) {
          imageUrl = uploaded.trim();
        }
      } catch (e) { /* keep base64 fallback */ }
    }
    currentImgs.push(imageUrl);
  }

  const updated = { ...currentDetailRequest, statusImages: JSON.stringify(currentImgs), updatedAt: new Date().toISOString() };
  const ok = await qcagDesktopPersistRequest(updated, 'Đã thêm ảnh hiện trạng', true);
  if (ok) {
    // Refresh the status image section in-place
    const thumbGrid = document.getElementById('qcagStatusThumbGrid');
    if (thumbGrid) {
      const newImgs = qcagDesktopPrepareRenderImageList(currentImgs);
      if (newImgs.length === 0) {
        thumbGrid.innerHTML = '<span class="qcag-detail-muted">Đang trống</span>';
      } else {
        const enc = encodeURIComponent(JSON.stringify(newImgs));
        const first = newImgs[0];
        const more = newImgs.length - 1;
        if (newImgs.length === 1) {
          thumbGrid.innerHTML = `<div class="qcag-gallery-rep" onclick="showImageFull('${first}',false)"><img src="${first}" alt="hiện trạng"></div>`;
        } else {
          thumbGrid.innerHTML = `<div class="qcag-gallery-rep" onclick="qcagOpenGalleryEncoded('${enc}',0)"><img src="${first}" alt="hiện trạng"><div class="qcag-img-more">+${more}</div></div>`;
        }
      }
    }
  }
}

async function qcagDesktopUploadMQ(input) {
  if (!currentDetailRequest || !input) return;
  const files = Array.from(input.files || []);
  if (files.length === 0) return;

  // Only keep a single MQ image: the most recently added file replaces any existing images
  const file = files[files.length - 1];

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

  // Upload to GCS so Sale Heineken can also receive the image URL
  let imageUrl = dataUrl;
  if (window.dataSdk && window.dataSdk.uploadImage && currentDetailRequest.__backendId) {
    showToast('Đang upload MQ...');
    try {
      const mqSubfolder = 'mq-' + String(currentDetailRequest.outletCode || 'OUTLET')
        .replace(/[^a-zA-Z0-9]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 32);
      const uploaded = await window.dataSdk.uploadImage(
        dataUrl, file.name || 'mq.jpg', currentDetailRequest.__backendId, mqSubfolder
      );
      if (typeof uploaded === 'string' && uploaded.trim()) {
        imageUrl = qcagDesktopNormalizeImageUrl(uploaded);
      } else if (uploaded && typeof uploaded.url === 'string' && uploaded.url.trim()) {
        imageUrl = qcagDesktopNormalizeImageUrl(uploaded.url);
      }
    } catch (e) {
      console.warn('[qcagDesktopUploadMQ] GCS upload failed, keeping base64:', e);
    }
  }

  const isWarrantyReq = String((currentDetailRequest.type || '')).toLowerCase() === 'warranty';

  if (isWarrantyReq) {
    // Warranty type: append to acceptanceImages (not designImages)
    const existingAccept = qcagDesktopParseJson(currentDetailRequest.acceptanceImages, []);
    existingAccept.push(imageUrl);
    const updated = {
      ...currentDetailRequest,
      acceptanceImages: JSON.stringify(existingAccept),
      updatedAt: new Date().toISOString()
    };
    const ok = await qcagDesktopPersistRequest(updated, 'Đã upload ảnh nghiệm thu', true);
    if (ok) qcagDesktopRefreshMQInPlace(updated);
    input.value = '';
    return;
  }

  const currentImgs = [imageUrl];

  const isPendingEdit = qcagDesktopIsPendingEditRequest(currentDetailRequest);

  const updated = {
    ...currentDetailRequest,
    designImages: JSON.stringify(currentImgs),
    designUpdatedAt: new Date().toISOString(),
    // Track who last uploaded/edited the MQ (updated on every upload)
    designLastEditedBy: currentSession ? (currentSession.saleName || currentSession.name || currentSession.phone || 'QCAG') : 'QCAG',
    designLastEditedAt: new Date().toISOString(),
    editingRequestedAt: isPendingEdit
      ? (currentDetailRequest.editingRequestedAt || new Date().toISOString())
      : null,
    // Always set to 'processing' after upload — requires explicit confirmation press.
    // Even if status was 'done' (pending-edit flow or anomalous state), the QCAG
    // must press "Đã chỉnh sửa" / "Hoàn thành" to confirm.
    status: 'processing',
    updatedAt: new Date().toISOString()
  };

  const ok = await qcagDesktopPersistRequest(updated, 'Đã upload MQ thiết kế', true);
  if (ok) qcagDesktopRefreshMQInPlace(updated);
  input.value = '';
}

async function qcagDesktopUpdateStatus(status) {
  if (!currentDetailRequest) return;
  const normalized = String(status || 'pending');
  const updated = { ...currentDetailRequest, status: normalized, updatedAt: new Date().toISOString() };
  await qcagDesktopPersistRequest(updated, 'Đã cập nhật trạng thái');
}

async function qcagDesktopMarkProcessed() {
  if (!currentDetailRequest) return;
  // Prevent double-click / concurrent calls
  if (_qcagMarkProcessedInFlight) return;
  _qcagMarkProcessedInFlight = true;
  // Disable button immediately so user gets instant visual feedback
  const _completeBtnEl = document.querySelector('.qcag-complete-btn');
  if (_completeBtnEl) { _completeBtnEl.disabled = true; _completeBtnEl.classList.add('qcag-complete-btn--disabled'); }

  try {
  const isPendingEdit = qcagDesktopIsPendingEditRequest(currentDetailRequest);
  // Must have MQ before marking done
  const designImgs = qcagDesktopParseJson(currentDetailRequest.designImages, []);
  if (!designImgs || designImgs.length === 0) {
    showToast(isPendingEdit
      ? 'Vui lòng upload MQ thiết kế trước khi xác nhận đã chỉnh sửa'
      : 'Vui lòng upload MQ thiết kế trước khi hoàn thành');
    qcagDesktopRefreshMQInPlace(currentDetailRequest);
    return;
  }
  const isSurveySizeIncomplete = qcagDesktopIsSurveySizeIncomplete(currentDetailRequest);
  if (isSurveySizeIncomplete) {
    showToast('Vui lòng xác nhận kích thước khảo sát trước khi hoàn thành');
    qcagDesktopRefreshMQInPlace(currentDetailRequest);
    return;
  }

  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);
  if (isPendingEdit) {
    comments.push({
      authorRole: 'qcag',
      authorName: (currentSession && (currentSession.name || currentSession.phone)) || 'QCAG',
      commentType: 'edit-resolved',
      text: 'QCAG đã chỉnh sửa xong theo yêu cầu của Sale Heineken.',
      readBy: [],
      createdAt: new Date().toISOString()
    });
  }
  const now = new Date().toISOString();
  // If this is the first time a MQ is confirmed (complete), record the creator
  const extraFields = {};
  if (!currentDetailRequest.designCreatedBy) {
    extraFields.designCreatedBy = currentSession ? (currentSession.saleName || currentSession.name || currentSession.phone || 'QCAG') : 'QCAG';
    extraFields.designCreatedAt = now;
  }
  // If this was an edit flow, record the last editor and increment revision counter
  if (isPendingEdit) {
    extraFields.designLastEditedBy = currentSession ? (currentSession.saleName || currentSession.name || currentSession.phone || 'QCAG') : 'QCAG';
    extraFields.designLastEditedAt = now;
    extraFields.editRevisionCount = (currentDetailRequest.editRevisionCount || 0) + 1;
  }

  // Build PATCH payload with ONLY changed fields — avoid sending large image data
  const patchPayload = {
    __backendId: currentDetailRequest.__backendId,
    status: 'done',
    processedAt: now,
    updatedAt: now,
    editingRequestedAt: null,
    comments: JSON.stringify(comments),
    ...extraFields
  };
  // Local state gets full merge for UI
  const updated = { ...currentDetailRequest, ...patchPayload };

  // Persist: send only the slim PATCH payload to backend
  if (window.dataSdk) {
    const result = await window.dataSdk.update(patchPayload);
    if (!result.isOk) {
      showToast('Không thể cập nhật request');
      qcagDesktopRefreshMQInPlace(currentDetailRequest);
      return;
    }
  }
  // Update local state
  const idxAll = allRequests.findIndex(r => r.__backendId === updated.__backendId);
  if (idxAll !== -1) allRequests[idxAll] = updated;
  currentDetailRequest = updated;
  qcagDesktopCacheRequest(updated);
  _qcagRequestsVersion += 1;
  _qcagRequestCodeCache.version = 0;
  qcagDesktopRefreshMQInPlace(updated);

  showToast(isPendingEdit ? '✓ Đã xác nhận chỉnh sửa' : '✓ Đã hoàn thành', 3000);

  // Push notification to Sale Heineken via Vercel function (same VAPID key as subscription)
  // Fire-and-forget so UI is not blocked
  try {
    const reqObj = (() => { try { return JSON.parse(currentDetailRequest.requester || '{}'); } catch (_) { return {}; } })();
    const requesterPhone = reqObj.phone || null;
    const requesterSaleCode = reqObj.saleCode || null;
    const outletLabel = currentDetailRequest.outletName || currentDetailRequest.outletCode || 'Outlet';
    const pushTitle = isPendingEdit
      ? 'QCAG — Đã hoàn thành chỉnh sửa'
      : 'QCAG uploaded to MQ';
    const pushBody = isPendingEdit
      ? `Outlet "${outletLabel}" đã được QCAG chỉnh sửa xong. Vui lòng mở app để kiểm tra MQ.`
      : `Outlet "${outletLabel}" đã có MQ, vui lòng mở app để xem chi tiết`;
    // Use absolute Vercel URL so push works even when QCAG desktop is accessed
    // from localhost (relative URL would go to http://127.0.0.1/api/... which doesn't exist)
    var pushEndpoint = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? 'https://qcag-survey-app.vercel.app/api/ks/push/send'
      : '/api/ks/push/send';
    showToast('⏳ Gửi push → ' + (requesterSaleCode || requesterPhone || 'N/A'), 2000);
    fetch(pushEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: pushTitle,
        body: pushBody,
        data: { backendId: currentDetailRequest.__backendId },
        phone: requesterPhone,
        saleCode: requesterSaleCode,
      })
    }).then(function(r) {
      return r.json().then(function(j) {
        if (j && j.sent > 0) showToast('📲 Push đã gửi (sent:' + j.sent + ')', 3000);
        else showToast('⚠️ Push: ' + JSON.stringify(j), 4000);
      });
    }).catch(function (e) { showToast('❌ Push error: ' + (e && e.message ? e.message : String(e)), 4000); console.warn('[push] confirm-done push error (non-fatal):', e); });
  } catch (pushErr) {
    console.warn('[push] confirm-done push error (non-fatal):', pushErr);
  }

  } finally {
    _qcagMarkProcessedInFlight = false;
  }
}

async function qcagDesktopMarkWarrantyResult(outOfScope) {
  if (!currentDetailRequest) return;
  const isDark = document.documentElement.classList.contains('theme-dark')
              || document.documentElement.getAttribute('data-theme') === 'dark';
  const cardBg    = isDark ? '#0b1220' : '#ffffff';
  const cardBdr   = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.04)';
  const textColor = isDark ? '#e6eef8' : '#111827';
  const subColor  = isDark ? '#9ca3af' : '#6b7280';
  const inputBg   = isDark ? 'rgba(255,255,255,0.05)' : '#f9fafb';
  const inputBdr  = isDark ? 'rgba(255,255,255,0.12)' : '#d1d5db';
  const cancelBg  = isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6';
  const cancelClr = isDark ? '#e6eef8' : '#374151';
  const confirmColor = outOfScope ? '#f97316' : '#059669';

  const title      = outOfScope ? 'Xác nhận: Ngoài phạm vi BH' : 'Xác nhận: Đã bảo hành';
  const btnLabel   = outOfScope ? 'Ngoài phạm vi BH' : 'Đã bảo hành';
  const inputLabel = outOfScope ? 'Lý do ngoài phạm vi (sẽ hiển thị cạnh ảnh):' : 'Tên người bảo hành:';
  const inputPlaceholder = outOfScope ? 'Nhập lý do...' : 'Nhập tên người bảo hành...';
  const inputTag         = outOfScope ? 'textarea' : 'input type="text"';
  const inputClose       = outOfScope ? '</textarea>' : '';
  const inputExtra       = outOfScope ? ' rows="3" style="resize:vertical"' : '';

  const result = await new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(2px);z-index:9999;display:flex;align-items:center;justify-content:center';
    const inputHtml = outOfScope
      ? `<textarea id="_qcagWarrantyInput" rows="3" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid ${inputBdr};background:${inputBg};color:${textColor};font-size:13px;resize:vertical;outline:none" placeholder="${inputPlaceholder}"></textarea>`
      : `<input id="_qcagWarrantyInput" type="text" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid ${inputBdr};background:${inputBg};color:${textColor};font-size:13px;outline:none" placeholder="${inputPlaceholder}">`;
    overlay.innerHTML =
      `<div style="background:${cardBg};border:1px solid ${cardBdr};border-radius:16px;padding:24px 20px 20px;max-width:440px;width:88%;box-shadow:0 20px 60px rgba(0,0,0,0.4)">` +
        `<p style="margin-bottom:4px;font-size:15px;font-weight:700;color:${textColor}">${title}</p>` +
        `<p style="margin-bottom:14px;font-size:12px;color:${subColor}">${inputLabel}</p>` +
        inputHtml +
        `<div style="display:flex;gap:8px;margin-top:14px">` +
          `<button id="_wCancelBtn" style="flex:1;padding:11px;border-radius:10px;background:${cancelBg};border:1px solid ${inputBdr};cursor:pointer;font-size:14px;font-weight:500;color:${cancelClr}">Hủy</button>` +
          `<button id="_wConfirmBtn" style="flex:1;padding:11px;border-radius:10px;background:${confirmColor};color:#fff;border:none;cursor:pointer;font-size:14px;font-weight:600">${btnLabel}</button>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(overlay);
    const cleanup = (val) => { document.body.removeChild(overlay); resolve(val); };
    overlay.querySelector('#_wConfirmBtn').onclick = () => {
      const v = (overlay.querySelector('#_qcagWarrantyInput').value || '').trim();
      cleanup({ confirmed: true, note: v });
    };
    overlay.querySelector('#_wCancelBtn').onclick = () => cleanup(null);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };
    requestAnimationFrame(() => { const inp = overlay.querySelector('#_qcagWarrantyInput'); if (inp) inp.focus(); });
  });

  if (!result || !result.confirmed) return;

  const now = new Date().toISOString();
  const actorName = currentSession ? (currentSession.saleName || currentSession.name || currentSession.phone || 'QCAG') : 'QCAG';
  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);
  comments.push({
    authorRole: 'qcag',
    authorName: 'Hệ thống',
    commentType: 'system',
    text: outOfScope
      ? `QCAG xác nhận ngoài phạm vi bảo hành${result.note ? ': ' + result.note : '.'}`
      : `QCAG xác nhận đã bảo hành xong. Người thực hiện: ${result.note || actorName}.`,
    readBy: [],
    createdAt: now
  });

  const updated = {
    ...currentDetailRequest,
    status: 'done',
    processedAt: now,
    updatedAt: now,
    warrantyOutOfScope: !!outOfScope,
    warrantyOutOfScopeNote: outOfScope ? (result.note || '') : '',
    warrantyPersonName: outOfScope ? '' : (result.note || actorName),
    comments: JSON.stringify(comments)
  };

  const label = outOfScope ? 'Ngoài phạm vi BH' : 'Đã bảo hành';
  await qcagDesktopPersistRequest(updated, label);
}

async function qcagDesktopPickCommentImages(input) {
  if (!input) return;
  const files = Array.from(input.files || []);
  input.value = '';
  for (const file of files) {
    // Compress immediately (WebP preferred)
    try {
      const dataUrl = await _compressImageFile(file, 1600, 0.82);
      _qcagDesktopPendingCommentImages.push(dataUrl);
    } catch (_) {
      // Fallback to raw base64
      await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = (e) => {
          _qcagDesktopPendingCommentImages.push(e.target.result);
          resolve();
        };
        reader.readAsDataURL(file);
      });
    }
  }
  qcagDesktopRenderCommentPreview();
}

async function qcagDesktopRemoveDesignImage(index) {
  if (!currentDetailRequest) return;
  const imgs = qcagDesktopParseJson(currentDetailRequest.designImages, []);
  if (!Array.isArray(imgs) || index < 0 || index >= imgs.length) return;
  imgs.splice(index, 1);
  const updated = { ...currentDetailRequest, designImages: JSON.stringify(imgs), updatedAt: new Date().toISOString() };
  const ok = await qcagDesktopPersistRequest(updated, 'Đã xóa ảnh MQ', true);
  if (ok) qcagDesktopRefreshMQInPlace(updated);
}

async function qcagDesktopRemoveAcceptanceImage(index) {
  if (!currentDetailRequest) return;
  const imgs = qcagDesktopParseJson(currentDetailRequest.acceptanceImages, []);
  if (!Array.isArray(imgs) || index < 0 || index >= imgs.length) return;
  imgs.splice(index, 1);
  const updated = { ...currentDetailRequest, acceptanceImages: JSON.stringify(imgs), updatedAt: new Date().toISOString() };
  const ok = await qcagDesktopPersistRequest(updated, 'Đã xóa ảnh nghiệm thu', true);
  if (ok) qcagDesktopRefreshMQInPlace(updated);
}


function qcagDesktopRemovePendingCommentImage(index) {
  _qcagDesktopPendingCommentImages.splice(index, 1);
  qcagDesktopRenderCommentPreview();
}

async function qcagDesktopSendComment() {
  if (!currentDetailRequest || !currentSession) return;
  const ta = document.getElementById('qcagCommentInput');
  if (!ta) return;

  const text = String(ta.value || '').trim();
  if (!text && _qcagDesktopPendingCommentImages.length === 0) {
    showToast('Nhập nội dung hoặc chọn hình trước khi gửi');
    return;
  }

  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);
  comments.push({
    authorRole: 'qcag',
    authorName: currentSession.phone || 'QCAG',
    text,
    images: _qcagDesktopPendingCommentImages.slice(),
    readBy: [],
    createdAt: new Date().toISOString()
  });

  const updated = { ...currentDetailRequest, comments: JSON.stringify(comments), updatedAt: new Date().toISOString() };

  // Clear immediately so the textarea appears empty right after user hits send
  ta.value = '';
  _qcagDesktopPendingCommentImages = [];
  qcagDesktopRenderCommentPreview();

  const ok = await qcagDesktopPersistRequest(updated, 'Đã gửi bình luận');
  if (!ok) return;

  setTimeout(() => {
    const timeline = document.getElementById('qcagCommentTimeline');
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, 30);
}

function syncQCAGDesktopMode() {
  if (!currentSession || !isQCAGSession()) return;
  if (shouldUseQCAGDesktop()) {
    openQCAGDesktop();
    return;
  }

  const desktopScreen = document.getElementById('qcagDesktopScreen');
  if (desktopScreen && desktopScreen.classList.contains('flex')) {
    showScreen('homeScreen');
  }
}

window.addEventListener('resize', () => {
  syncQCAGDesktopMode();
});

// --- QCAG gallery overlay helpers ---
function qcagOpenGalleryEncoded(encoded, startIndex) {
  try {
    const imgs = JSON.parse(decodeURIComponent(encoded || '[]'));
    qcagOpenGallery(Array.isArray(imgs) ? imgs : [], startIndex || 0);
  } catch (e) { console.error('qcagOpenGalleryEncoded', e); }
}

async function qcagCopyImageToClipboard(src, imgElement, btn) {
  // If called without imgElement but with btn (for backward compatibility)
  if (btn === undefined && imgElement && imgElement.tagName !== 'IMG') {
    btn = imgElement;
    imgElement = null;
  }

  try {
    if (!navigator.clipboard || !window.ClipboardItem) {
      if (typeof showToast === 'function') {
        showToast('Trình duyệt không hỗ trợ copy ảnh. Yêu cầu Desktop HTTPS hoặc localhost.');
      }
      return;
    }

    if (btn) btn.textContent = '...';

    // To prevent "Tainted canvases" error from cross origin images, we must fetch
    // the image explicitly with anonymous CORS mode, AND append a cache buster so
    // the browser doesn't return a cached opaque (non-CORS) reply.
    const blob = await new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // Request CORS headers
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width || 100;
          canvas.height = img.naturalHeight || img.height || 100;
          canvas.getContext('2d').drawImage(img, 0, 0); // No longer tainted if CORS passes
          
          canvas.toBlob(b => {
            if (b) resolve(b);
            else reject(new Error('Tạo dữ liệu ảnh thất bại (toBlob trả về null).'));
          }, 'image/png');
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => {
        reject(new Error('Bảo mật: GCS không cho phép gọi (CORS lỗi). Vui lòng chuột phải -> Copy image.'));
      };
      
      const sep = src.includes('?') ? '&' : '?';
      img.src = src + sep + '_nocache=' + Date.now();
    });

    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob })
    ]);

    if (btn) btn.textContent = '✓ Đã copy';
    setTimeout(() => { if (btn) btn.textContent = '⎘ Copy'; }, 1800);
  } catch (e) {
    console.warn('Image copy failed:', e);
    const msg = e.message || '';
    if (typeof showToast === 'function') {
      showToast(msg.includes('Tainted') || msg.includes('CORS') 
        ? 'Lỗi bảo mật trình duyệt, vui lòng "Chuột phải -> Copy image"'
        : 'Lỗi khi copy ảnh: ' + msg);
    }
    if (btn) btn.textContent = '✗ Lỗi';
    setTimeout(() => { if (btn) btn.textContent = '⎘ Copy'; }, 1800);
  }
}
// qcagCopyImageToClipboard removed — copy-image feature disabled
function qcagOpenGallery(images, startIndex) {
  qcagCloseGallery();
  const wrap = document.createElement('div');
  wrap.id = 'qcagGalleryOverlay';
  wrap.className = 'qcag-gallery-overlay';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'qcag-gallery-close';
  closeBtn.textContent = '✕';
  closeBtn.onclick = function (e) { e.stopPropagation(); qcagCloseGallery(); };
  wrap.appendChild(closeBtn);

  const thumbs = document.createElement('div');
  thumbs.className = 'qcag-gallery-thumbs';
  images.forEach((src, i) => {
    const t = document.createElement('div');
    t.className = 'qcag-gallery-thumb';
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Ảnh ' + (i + 1);
    img.onclick = function (e) { e.stopPropagation(); try { showImageFull(src, false); } catch (err) { console.error(err); } };
    t.appendChild(img);
    // Copy button removed — feature disabled per request
    thumbs.appendChild(t);
  });

  wrap.appendChild(thumbs);

  // prevent clicks inside panel from reaching page (which could trigger logout buttons)
  thumbs.addEventListener('click', function (e) { e.stopPropagation(); });
  document.body.appendChild(wrap);

  // clicking outside the thumbnails panel (i.e. on the overlay) closes the gallery
  wrap.addEventListener('click', function (e) {
    if (e.target === wrap) qcagCloseGallery();
  });

  // focus + keyboard handling
  function onKey(e) { if (e.key === 'Escape') qcagCloseGallery(); }
  document.addEventListener('keydown', onKey);
  wrap._qcag_key = onKey;
}

function qcagCloseGallery() {
  const g = document.getElementById('qcagGalleryOverlay');
  if (!g) return;
  const k = g._qcag_key;
  if (k) document.removeEventListener('keydown', k);
  g.remove();
}

/* =====================================================
   NAV SIDEBAR & PANELS
   ===================================================== */

function qcagToggleNavSidebar() {
  const sidebar = document.getElementById('qcagNavSidebar');
  const backdrop = document.getElementById('qcagNavBackdrop');
  if (!sidebar) return;
  const isOpen = sidebar.classList.contains('is-open');
  if (isOpen) {
    sidebar.classList.remove('is-open');
    backdrop && backdrop.classList.add('hidden');
  } else {
    sidebar.classList.add('is-open');
    backdrop && backdrop.classList.remove('hidden');
  }
}

function qcagCloseNavSidebar() {
  const sidebar = document.getElementById('qcagNavSidebar');
  const backdrop = document.getElementById('qcagNavBackdrop');
  sidebar && sidebar.classList.remove('is-open');
  backdrop && backdrop.classList.add('hidden');
}

let _qcagNavMapInstance = null;
let _qcagNavMapMarkers = []; // [{marker, tooltipHtml, data}]
let _qcagNavMapSearchQ = '';
let _qcagNavTooltipsVisible = false;

function qcagNavShowView(viewName) {
  qcagCloseNavSidebar();
  // Hide all panels first
  ['qcagNavListPanel', 'qcagNavMapPanel', 'qcagNavStatsPanel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  if (viewName === 'list') {
    const panel = document.getElementById('qcagNavListPanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    _qcagNavListSearchQ = '';
    _qcagNavListCurrentPage = 1;
    _qcagNavListSelected.clear();
    const si = document.getElementById('qcagNavListSearch');
    if (si) si.value = '';
    qcagNavRenderList();
  } else if (viewName === 'map') {
    const panel = document.getElementById('qcagNavMapPanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    _qcagNavMapSearchQ = '';
    const si = document.getElementById('qcagNavMapSearch');
    if (si) si.value = '';
    // Defer so the panel is visible before Leaflet measures the container
    setTimeout(() => qcagNavRenderMap(), 80);
  } else if (viewName === 'stats') {
    const panel = document.getElementById('qcagNavStatsPanel');
    if (panel) panel.classList.remove('hidden');
  }
}

function qcagNavClosePanel() {
  ['qcagNavListPanel', 'qcagNavMapPanel', 'qcagNavStatsPanel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
}

// ---------- LIST VIEW -----------------------------------
const _QCAG_LIST_PAGE_SIZE = 25;
let _qcagNavListSearchQ = '';
let _qcagNavListStatusFilter = ''; // empty = all
let _qcagNavListRegionFilter = ''; // empty = all regions
let _qcagNavListCurrentPage = 1;
let _qcagNavListFiltered = []; // filtered rows cache
let _qcagNavListSelected = new Set(); // selected __backendId or indices
let _qcagNavListYearFilter = new Date().getFullYear(); // null = tất cả các năm
let _qcagNavListYearDropupYear = new Date().getFullYear();

function qcagNavListSetStatusFilter(btn, statusCls) {
  _qcagNavListStatusFilter = statusCls;
  _qcagNavListCurrentPage = 1;
  _qcagNavListSelected.clear();
  // update pill active states
  const bar = document.getElementById('qcagNavListFilterBar');
  if (bar) bar.querySelectorAll('.qcag-nav-filter-pill').forEach(b => b.classList.toggle('active', b.dataset.status === statusCls));
  qcagNavRenderList();
}

function qcagNavListSetRegionFilter(region) {
  _qcagNavListRegionFilter = region || '';
  _qcagNavListCurrentPage = 1;
  _qcagNavListSelected.clear();
  // Update region button active states
  const bar = document.getElementById('qcagNavListRegionBar');
  if (bar) bar.querySelectorAll('.qcag-nav-region-pill').forEach(b => b.classList.toggle('active', b.dataset.region === _qcagNavListRegionFilter));
  qcagNavRenderList();
}

function qcagNavListOnSearch(val) {
  _qcagNavListSearchQ = (val || '').toLowerCase().trim();
  _qcagNavListCurrentPage = 1;
  _qcagNavListSelected.clear();
  _qcagNavListRender();
}

function qcagNavListToggleAll(checked) {
  const page = _qcagNavListGetPage();
  page.forEach(({ r }) => {
    const key = r.__backendId || JSON.stringify(r);
    if (checked) _qcagNavListSelected.add(key);
    else _qcagNavListSelected.delete(key);
  });
  _qcagNavListRenderBody();
}

function qcagNavListToggleRow(key, checked) {
  if (checked) _qcagNavListSelected.add(key);
  else _qcagNavListSelected.delete(key);
  _qcagNavListRenderBody();
}

function qcagNavListToggleRowByKey(key) {
  if (_qcagNavListSelected.has(key)) _qcagNavListSelected.delete(key);
  else _qcagNavListSelected.add(key);
  _qcagNavListRenderBody();
}

function qcagNavListClearSelection() {
  _qcagNavListSelected.clear();
  _qcagNavListRenderBody();
}

function qcagNavListGoPage(page) {
  _qcagNavListCurrentPage = page;
  _qcagNavListRenderBody();
  _qcagNavListRenderPagination();
}

function _qcagNavListGetPage() {
  const start = (_qcagNavListCurrentPage - 1) * _QCAG_LIST_PAGE_SIZE;
  return _qcagNavListFiltered.slice(start, start + _QCAG_LIST_PAGE_SIZE);
}

function _qcagNavListBuildStatus(r) {
  // Check "Chờ khảo sát" tag first (mirrors card render logic)
  const stdTags = Array.isArray(r.standardTags) ? r.standardTags : (typeof assignStandardTags === 'function' ? (assignStandardTags(r) || []) : []);
  if (Array.isArray(stdTags) && stdTags.indexOf('Chờ khảo sát') !== -1) {
    return { label: 'Chờ khảo sát', cls: 'survey' };
  }
  return qcagDesktopStatusBadge(r);
}

function qcagNavRenderList() {
  const reqs = (typeof allRequests !== 'undefined' ? allRequests : []) || [];
  const q = _qcagNavListSearchQ;

  const sf = _qcagNavListStatusFilter;
  const rf = _qcagNavListRegionFilter;
  const yf = _qcagNavListYearFilter;

  const regionPatterns = {
    's4':  /south\s*4|\bs4\b/i,
    's5':  /south\s*5|\bs5\b/i,
    's16': /south\s*16|\bs16\b/i,
    's17': /south\s*17|\bs17\b/i,
    '24':  /south\s*24|\b24\b/i,
    's19': /south\s*19|\bs19\b/i,
    'mot8': /mon?dern\W*on\W*team\W*8|\bmot8\b|modern\W*team\W*8/i
  };

  _qcagNavListFiltered = reqs
    .map((r, originalIdx) => ({ r, idx: originalIdx }))
    .filter(({ r }) => {
      // year filter
      if (yf !== null) {
        try { if (new Date(r.createdAt || 0).getFullYear() !== yf) return false; }
        catch(e) { return false; }
      }
      // region filter
      if (rf) {
        const requester = qcagDesktopParseJson(r.requester, {});
        const regionRaw = String(requester.region || r.region || '');
        const pattern = regionPatterns[rf.toLowerCase()] || new RegExp(rf.replace(/[^a-z0-9]/gi, ''), 'i');
        if (!pattern.test(regionRaw)) return false;
      }
      // text search
      if (q) {
        const requester = qcagDesktopParseJson(r.requester, {});
        const textMatch = (
          String(requester.saleCode  || '').toLowerCase().includes(q) ||
          String(requester.saleName  || requester.phone || '').toLowerCase().includes(q) ||
          String(requester.ssName    || '').toLowerCase().includes(q) ||
          String(requester.region    || '').toLowerCase().includes(q) ||
          String(r.outletCode        || '').toLowerCase().includes(q) ||
          String(r.outletName        || '').toLowerCase().includes(q) ||
          _qcagNavListGetBrands(r).toLowerCase().includes(q)
        );
        if (!textMatch) return false;
      }
      // status filter
      if (sf) {
        const status = _qcagNavListBuildStatus(r);
        if (status.cls !== sf) return false;
      }
      return true;
    });

  const countEl = document.getElementById('qcagNavListCount');
  if (countEl) {
    const isFiltered = q || sf || yf !== null;
    countEl.textContent = isFiltered
      ? `${_qcagNavListFiltered.length} / ${reqs.length} yêu cầu`
      : `${reqs.length} yêu cầu`;
  }

  _qcagNavListRenderBody();
  _qcagNavListRenderPagination();
}

function _qcagNavListGetBrands(r) {
  const items = qcagDesktopParseJson(r.items, []);
  const brands = [...new Set((Array.isArray(items) ? items : []).map(it => it && it.brand).filter(Boolean))];
  return brands.join(', ');
}

function _qcagNavListRenderBody() {
  const tbody = document.getElementById('qcagNavListBody');
  if (!tbody) return;

  const page = _qcagNavListGetPage();
  const startIdx = (_qcagNavListCurrentPage - 1) * _QCAG_LIST_PAGE_SIZE;

  if (page.length === 0) {
    const colspan = 12;
    tbody.innerHTML = `<tr><td colspan="${colspan}" style="text-align:center;padding:32px;color:var(--text-soft,#9ca3af)">Không có dữ liệu</td></tr>`;
    return;
  }

  tbody.innerHTML = page.map(({ r, idx }) => {
    const requester = qcagDesktopParseJson(r.requester, {});
    const items = qcagDesktopParseJson(r.items, []);
    const itemArr = Array.isArray(items) ? items : [];
    const totalItems = itemArr.length;
    const brandText = escapeHtml(_qcagNavListGetBrands(r) || '-');
    const status = _qcagNavListBuildStatus(r);
    const key = r.__backendId || JSON.stringify(r);
    const isSelected = _qcagNavListSelected.has(key);
    const hasGps = !!(r.outletLat && r.outletLng);
    const gpsBadge = hasGps
      ? `<a class="qcag-nav-gps-badge has-gps" href="https://www.google.com/maps?q=${parseFloat(r.outletLat)},${parseFloat(r.outletLng)}" target="_blank" rel="noopener" title="Mở Google Maps">📍 Xem map</a>`
      : `<span class="qcag-nav-gps-badge no-gps">Không có</span>`;

    return `<tr class="${isSelected ? 'is-selected' : ''}" data-key="${escapeHtml(key)}" onclick="qcagNavListToggleRowByKey('${escapeHtml(key)}')">
      <td>${idx + 1}</td>
      <td title="${escapeHtml(requester.saleCode || '')}">${escapeHtml(requester.saleCode || '-')}</td>
      <td>${escapeHtml(requester.region || '-')}</td>
      <td title="${escapeHtml(requester.saleName || requester.phone || '')}">${escapeHtml(requester.saleName || requester.phone || '-')}</td>
      <td title="${escapeHtml(requester.ssName || '')}">${escapeHtml(requester.ssName || '-')}</td>
      <td>${escapeHtml(r.outletCode || '-')}</td>
      <td title="${escapeHtml(r.outletName || '')}">${escapeHtml(r.outletName || '-')}</td>
      <td title="${brandText}">${brandText}</td>
      <td style="text-align:center">${totalItems}</td>
      <td><span class="qcag-nav-status-badge ${escapeHtml(status.cls)}">${escapeHtml(status.label)}</span></td>
      <td>${gpsBadge}</td>
    </tr>`;
  }).join('');

  // no check-all checkbox anymore
}

function _qcagNavListRenderPagination() {
  const el = document.getElementById('qcagNavListPagination');
  if (!el) return;
  const total = _qcagNavListFiltered.length;
  const totalPages = Math.max(1, Math.ceil(total / _QCAG_LIST_PAGE_SIZE));
  const cur = _qcagNavListCurrentPage;

  const yr = _qcagNavListYearFilter;
  const yearLabel = yr !== null ? String(yr) : 'Tất cả';
  const dispYear = _qcagNavListYearDropupYear;
  const allActiveCls = yr === null ? ' qcag-year-all--active' : '';
  const dispActiveCls = (yr !== null && yr === dispYear) ? ' qcag-year-disp--active' : '';
  const yrSelText = yr !== null ? 'đang chọn ' + yr : 'đang xem tất cả';

  el.innerHTML = `
    <div class="qcag-year-wrap">
      <button class="qcag-year-btn" id="qcagNavListYearBtn" onclick="qcagNavListYearBtnToggle()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
        <span id="qcagNavListYearBtnLabel">${escapeHtml(yearLabel)}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
      <div class="qcag-year-dropup hidden" id="qcagNavListYearDropup">
        <div class="qcag-year-dropup-head">Chọn Năm <span class="qcag-year-sel-ind" id="qcagNavListYearSel">${yrSelText}</span></div>
        <button class="qcag-year-all${allActiveCls}" onclick="qcagNavListSetYearFilter(null)">Hiển thị tất cả</button>
        <div class="qcag-year-picker">
          <button class="qcag-year-nav" onclick="qcagNavListYearPickerStep(1)">◄</button>
          <div class="qcag-year-viewport">
            <div class="qcag-year-disp${dispActiveCls}" id="qcagNavListYearDisp" onclick="qcagNavListApplyYear()" title="Nhấn để chọn năm này">${dispYear}</div>
          </div>
          <button class="qcag-year-nav" onclick="qcagNavListYearPickerStep(-1)">►</button>
        </div>
      </div>
    </div>
    <button class="qcag-nav-page-btn" onclick="qcagNavListGoPage(${cur - 1})" ${cur === 1 ? 'disabled' : ''}>◀</button>
    <div class="qcag-nav-page-jump">
      <input type="number" class="qcag-nav-page-input" min="1" max="${totalPages}" value="${cur}"
        onchange="qcagNavListGoPageInput(this)"
        onkeydown="if(event.key==='Enter'){qcagNavListGoPageInput(this);this.blur()}"
      >&nbsp;/ ${totalPages}
    </div>
    <button class="qcag-nav-page-btn" onclick="qcagNavListGoPage(${cur + 1})" ${cur === totalPages ? 'disabled' : ''}>▶</button>
    <span class="qcag-nav-page-info">&nbsp;·&nbsp; ${total} yêu cầu</span>
  `;

  if (!el._yearOutsideClick) {
    el._yearOutsideClick = (e) => {
      const dropupEl = document.getElementById('qcagNavListYearDropup');
      const btnEl = document.getElementById('qcagNavListYearBtn');
      if (dropupEl && btnEl &&
          !dropupEl.classList.contains('hidden') &&
          !dropupEl.contains(e.target) &&
          !btnEl.contains(e.target)) {
        dropupEl.classList.add('hidden');
      }
    };
    document.addEventListener('click', el._yearOutsideClick);
  }
}

function qcagNavListGoPageInput(input) {
  const totalPages = Math.max(1, Math.ceil(_qcagNavListFiltered.length / _QCAG_LIST_PAGE_SIZE));
  let page = parseInt(input.value, 10);
  if (isNaN(page)) page = _qcagNavListCurrentPage;
  page = Math.max(1, Math.min(page, totalPages));
  input.value = page;
  qcagNavListGoPage(page);
}

function qcagNavListYearBtnToggle() {
  const dropup = document.getElementById('qcagNavListYearDropup');
  if (!dropup) return;
  if (dropup.classList.contains('hidden')) {
    _qcagNavListYearDropupYear = _qcagNavListYearFilter !== null
      ? _qcagNavListYearFilter
      : new Date().getFullYear();
    const dispEl = document.getElementById('qcagNavListYearDisp');
    if (dispEl) {
      dispEl.textContent = _qcagNavListYearDropupYear;
      dispEl.classList.toggle('qcag-year-disp--active', _qcagNavListYearFilter !== null && _qcagNavListYearDropupYear === _qcagNavListYearFilter);
    }
    dropup.classList.remove('hidden');
  } else {
    dropup.classList.add('hidden');
  }
}

function qcagNavListSetYearFilter(year) {
  _qcagNavListYearFilter = year;
  _qcagNavListYearDropupYear = year !== null ? year : new Date().getFullYear();
  _qcagNavListCurrentPage = 1;
  const dropup = document.getElementById('qcagNavListYearDropup');
  if (dropup) dropup.classList.add('hidden');
  qcagNavRenderList();
}

function qcagNavListApplyYear() {
  qcagNavListSetYearFilter(_qcagNavListYearDropupYear);
}

function qcagNavListYearPickerStep(dir) {
  _qcagNavListYearDropupYear += dir;
  const dispEl = document.getElementById('qcagNavListYearDisp');
  if (dispEl) {
    dispEl.textContent = _qcagNavListYearDropupYear;
    dispEl.classList.toggle('qcag-year-disp--active', _qcagNavListYearFilter !== null && _qcagNavListYearDropupYear === _qcagNavListYearFilter);
  }
  const selEl = document.getElementById('qcagNavListYearSel');
  if (selEl) selEl.textContent = _qcagNavListYearFilter !== null ? 'đang chọn ' + _qcagNavListYearFilter : 'đang xem tất cả';
}

function qcagNavListExportCSV() {
  const reqs = (typeof allRequests !== 'undefined' ? allRequests : []) || [];
  // Use selected rows if any, else all filtered
  let exportList;
  if (_qcagNavListSelected.size > 0) {
    exportList = _qcagNavListFiltered.filter(({ r }) => _qcagNavListSelected.has(r.__backendId || JSON.stringify(r)));
  } else {
    exportList = _qcagNavListFiltered;
  }
  if (exportList.length === 0) { showToast && showToast('Không có dữ liệu để xuất'); return; }

  const header = ['STT', 'Mã TK', 'Khu vực', 'Tên Sale', 'Tên SS', 'Outlet Code', 'Tên Outlet', 'Brand', 'SL hạng mục', 'Trạng thái', 'Định vị (Google Maps)'];
  const csvRows = [header];

  exportList.forEach(({ r, idx }) => {
    const requester = qcagDesktopParseJson(r.requester, {});
    const items = qcagDesktopParseJson(r.items, []);
    const itemArr = Array.isArray(items) ? items : [];
    const brands = [...new Set(itemArr.map(it => it && it.brand).filter(Boolean))].join(', ');
    const status = _qcagNavListBuildStatus(r);
    const gpsUrl = (r.outletLat && r.outletLng)
      ? `https://www.google.com/maps?q=${parseFloat(r.outletLat)},${parseFloat(r.outletLng)}`
      : '';
    csvRows.push([
      idx + 1,
      requester.saleCode || '',
      requester.region || '',
      requester.saleName || requester.phone || '',
      requester.ssName || '',
      r.outletCode || '',
      r.outletName || '',
      brands || '-',
      itemArr.length,
      status.label,
      gpsUrl
    ]);
  });

  const csvContent = '\uFEFF' + csvRows.map(row =>
    row.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')
  ).join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'qcag-danh-sach-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
}

// ---------- MAP VIEW ------------------------------------
function qcagNavMapOnSearch(val) {
  _qcagNavMapSearchQ = (val || '').toLowerCase().trim();
  _qcagNavApplyMapFilter();
}

function _qcagNavApplyMapFilter() {
  const q = _qcagNavMapSearchQ;
  const countEl = document.getElementById('qcagNavMapCount');
  let visible = 0;
  _qcagNavMapMarkers.forEach(({ marker, data }) => {
    const show = !q ||
      data.outletCode.includes(q) ||
      data.outletName.includes(q) ||
      data.saleName.includes(q) ||
      data.saleCode.includes(q) ||
      data.ssName.includes(q) ||
      data.region.includes(q);
    if (show) {
      if (!_qcagNavMapInstance.hasLayer(marker)) marker.addTo(_qcagNavMapInstance);
      visible++;
    } else {
      if (_qcagNavMapInstance.hasLayer(marker)) _qcagNavMapInstance.removeLayer(marker);
    }
  });
  if (countEl) {
    const total = _qcagNavMapMarkers.length;
    countEl.textContent = q ? `${visible} / ${total} điểm` : `${total} điểm có định vị`;
  }
}

function qcagNavRenderMap() {
  const container = document.getElementById('qcagNavMapContainer');
  if (!container) return;

  const reqs = (typeof allRequests !== 'undefined' ? allRequests : []) || [];
  const points = reqs.filter(r => r.outletLat && r.outletLng);
  const countEl = document.getElementById('qcagNavMapCount');
  if (countEl) countEl.textContent = points.length + ' điểm có định vị';

  // Leaflet guard
  if (typeof L === 'undefined') {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:15px;color:#9ca3af">Leaflet chưa được tải</div>';
    return;
  }

  // Destroy previous instance
  if (_qcagNavMapInstance) {
    try { _qcagNavMapInstance.remove(); } catch(e) {}
    _qcagNavMapInstance = null;
  }
  _qcagNavMapMarkers = [];
  container.innerHTML = '';

  const defaultCenter = [10.3, 105.5];
  const map = L.map(container, { center: defaultCenter, zoom: 8 });
  _qcagNavMapInstance = map;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18
  }).addTo(map);

  const latlngs = [];
  points.forEach(r => {
    const lat = parseFloat(r.outletLat);
    const lng = parseFloat(r.outletLng);
    if (isNaN(lat) || isNaN(lng)) return;
    latlngs.push([lat, lng]);
    const requester = qcagDesktopParseJson(r.requester, {});
    const statusBadge = qcagDesktopStatusBadge(r);
    const saleName = escapeHtml(requester.saleName || requester.phone || '-');
    const outletName = escapeHtml(r.outletName || r.outletCode || '-');
    const outletCode = escapeHtml(r.outletCode || '');
    const saleCode = escapeHtml(requester.saleCode || '');
    const ssName = escapeHtml(requester.ssName || '-');
    const region = escapeHtml(requester.region || '-');
    const statusLabel = escapeHtml(statusBadge ? statusBadge.label : '-');

    const popupHtml = `
      <div style="min-width:190px;font-family:inherit">
        <strong style="font-size:13px">${outletName}</strong><br>
        <span style="font-size:12px;color:#6b7280">${outletCode}</span><br>
        <hr style="margin:6px 0;border:none;border-top:1px solid #e5e7eb">
        <div style="font-size:12px">
          <div>Sale: <strong>${saleName}</strong></div>
          <div>Khu vực: <strong>${region}</strong></div>
          <div>Trạng thái: <strong>${statusLabel}</strong></div>
        </div>
      </div>`;

    const tooltipHtml = `
      <div style="font-family:inherit;font-size:11px;line-height:1.5;max-width:160px;pointer-events:none">
        <div style="font-weight:700;color:var(--mtt-name,#111827);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px">${outletName}</div>
        <div style="color:var(--mtt-sale,#374151);margin-top:1px">${saleName}</div>
        <div style="color:var(--mtt-region,#6b7280);font-size:10px;margin-top:1px">${region}</div>
      </div>`;

    const marker = L.marker([lat, lng]).addTo(map).bindPopup(popupHtml);
    marker.bindTooltip(tooltipHtml, {
      permanent: _qcagNavTooltipsVisible,
      direction: 'top',
      offset: [0, -10],
      className: 'qcag-map-marker-label'
    });

    // Store searchable data alongside marker
    _qcagNavMapMarkers.push({
      marker,
      tooltipHtml,
      data: {
        outletCode: (r.outletCode || '').toLowerCase(),
        outletName: (r.outletName || '').toLowerCase(),
        saleName: (requester.saleName || requester.phone || '').toLowerCase(),
        saleCode: (requester.saleCode || '').toLowerCase(),
        ssName: (requester.ssName || '').toLowerCase(),
        region: (requester.region || '').toLowerCase()
      }
    });
  });

  if (latlngs.length > 0) {
    map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
  }

  setTimeout(() => map.invalidateSize(), 100);
  // Apply any pending search filter
  if (_qcagNavMapSearchQ) _qcagNavApplyMapFilter();
  // Sync toggle button state
  _qcagNavSyncTooltipBtn();
}

function qcagNavToggleMapTooltips() {
  _qcagNavTooltipsVisible = !_qcagNavTooltipsVisible;
  _qcagNavMapMarkers.forEach(({ marker, tooltipHtml }) => {
    marker.unbindTooltip();
    marker.bindTooltip(tooltipHtml, {
      permanent: _qcagNavTooltipsVisible,
      direction: 'top',
      offset: [0, -10],
      className: 'qcag-map-marker-label'
    });
  });
  _qcagNavSyncTooltipBtn();
}

function _qcagNavSyncTooltipBtn() {
  const btn = document.getElementById('qcagNavTooltipToggleBtn');
  if (!btn) return;
  btn.classList.toggle('is-active', _qcagNavTooltipsVisible);
  btn.title = _qcagNavTooltipsVisible ? 'Ẩn thẻ thông tin' : 'Hiện thẻ thông tin';
}

// ── Tra cứu ĐVHC 2 cấp (34 tỉnh mới + lịch sử sáp nhập) ─────────────
let _dvhcNewWards  = null; // Map<newCode, {wardName, provinceName}>
let _dvhcOldWards  = null; // Map<oldCode, {wardName, districtName, provinceName}>
let _dvhcMappings  = null; // Map<newCode, oldCode[]>
let _dvhcIndex     = null; // [{newProvinceName, oldProvinceList[], pSearchable, wards:[...]}]
let _dvhcSearchTmr = null;
const _DVHC_BASE = 'https://cdn.jsdelivr.net/gh/trongthanh/wx-tra-cuu-dvhcvn@main/public/data/';

function qcagDesktopOpenDVHCLookup() {
  let modal = document.getElementById('qcagDVHCModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'qcagDVHCModal';
    modal.className = 'qcag-edit-items-modal hidden';
    modal.innerHTML = `
      <div class="qcag-dvhc-panel">
        <div class="qcag-dvhc-header">
          <span>🗺️ Tra cứu ĐVHC sau sáp nhập (34 tỉnh/thành)</span>
          <button onclick="qcagDesktopCloseDVHCLookup()" class="qcag-dvhc-close-btn" title="Đóng">✕</button>
        </div>
        <input id="qcagDVHCSearch" type="search" class="qcag-dvhc-search-input"
          placeholder="Nhập tên xã/phường mới, cũ hoặc tên tỉnh... (Nhấn Enter để tìm)" autocomplete="off"
          onkeydown="if(event.key==='Enter') qcagDVHCOnSearch(this.value)" />
        <div id="qcagDVHCStatus" class="qcag-dvhc-status">Đang tải dữ liệu...</div>
        <div id="qcagDVHCResults" class="qcag-dvhc-results"></div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  modal.classList.remove('hidden');
  if (!_dvhcIndex) {
    _qcagDVHCLoadData();
  } else {
    const total = _dvhcIndex.reduce((s, p) => s + p.wards.length, 0);
    const statusEl = document.getElementById('qcagDVHCStatus');
    if (statusEl) statusEl.textContent = `${total} đơn vị hành chính. Nhập để tìm.`;
  }
  setTimeout(() => {
    const inp = document.getElementById('qcagDVHCSearch');
    if (inp) { inp.value = ''; inp.focus(); }
    const res = document.getElementById('qcagDVHCResults');
    if (res) res.innerHTML = '';
  }, 50);
}

function qcagDesktopCloseDVHCLookup() {
  const modal = document.getElementById('qcagDVHCModal');
  if (modal) modal.classList.add('hidden');
}

function qcagDesktopToggleDVHCLookup() {
  const modal = document.getElementById('qcagDVHCModal');
  if (modal && !modal.classList.contains('hidden')) {
    qcagDesktopCloseDVHCLookup();
  } else {
    qcagDesktopOpenDVHCLookup();
  }
}

// Minimal RFC-4180 CSV parser that handles quoted fields with embedded newlines/commas
function _dvhcParseCsv(text) {
  const rows = [];
  let headers = null;
  let pos = 0;
  const len = text.length;

  function parseField() {
    if (pos < len && text[pos] === '"') {
      pos++; // skip opening quote
      let val = '';
      while (pos < len) {
        if (text[pos] === '"') {
          pos++;
          if (pos < len && text[pos] === '"') { val += '"'; pos++; } // escaped ""
          else break; // closing quote
        } else {
          val += text[pos++];
        }
      }
      return val;
    } else {
      let val = '';
      while (pos < len && text[pos] !== ',' && text[pos] !== '\n' && text[pos] !== '\r') {
        val += text[pos++];
      }
      return val;
    }
  }

  while (pos < len) {
    // skip leading CR
    while (pos < len && text[pos] === '\r') pos++;
    if (pos >= len) break;
    if (text[pos] === '\n') { pos++; continue; } // blank line

    // parse one row's fields
    const row = [];
    while (pos < len && text[pos] !== '\n' && text[pos] !== '\r') {
      row.push(parseField());
      if (pos < len && text[pos] === ',') pos++;
      else break;
    }
    // consume line ending
    while (pos < len && (text[pos] === '\r' || text[pos] === '\n')) {
      if (text[pos] === '\n') { pos++; break; }
      pos++;
    }
    if (!headers) {
      headers = row;
    } else if (row.length > 0) {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (row[i] || '').replace(/\n/g, ' ').trim(); });
      rows.push(obj);
    }
  }
  return rows;
}

async function _qcagDVHCLoadData() {
  const statusEl = document.getElementById('qcagDVHCStatus');
  if (statusEl) statusEl.textContent = 'Đang tải dữ liệu (3 tệp CSV)...';
  try {
    const [r1, r2, r3] = await Promise.all([
      fetch(_DVHC_BASE + 'new_wards.csv'),
      fetch(_DVHC_BASE + 'old_wards.csv'),
      fetch(_DVHC_BASE + 'ward_mappings.csv'),
    ]);
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error(`HTTP ${[r1,r2,r3].find(r=>!r.ok).status}`);
    const [t1, t2, t3] = await Promise.all([r1.text(), r2.text(), r3.text()]);

    // Build maps
    _dvhcNewWards = new Map();
    for (const row of _dvhcParseCsv(t1)) {
      _dvhcNewWards.set(row.ward_code, {
        wardName: row.ward_name,
        provinceName: row.province_name,
      });
    }

    _dvhcOldWards = new Map();
    for (const row of _dvhcParseCsv(t2)) {
      _dvhcOldWards.set(row.ward_code, {
        wardName: row.ward_name,
        districtName: row.district_name,
        provinceName: row.province_name,
      });
    }

    _dvhcMappings = new Map();
    for (const row of _dvhcParseCsv(t3)) {
      const nc = row.new_ward_code, oc = row.old_ward_code;
      if (!_dvhcMappings.has(nc)) _dvhcMappings.set(nc, []);
      _dvhcMappings.get(nc).push(oc);
    }

    // Build 2-level index grouped by new province
    const provinceMap = new Map(); // newProvinceName → {oldProvinces:Set, wards:[]}
    for (const [newCode, newInfo] of _dvhcNewWards) {
      const pName = newInfo.provinceName;
      if (!provinceMap.has(pName)) provinceMap.set(pName, { oldProvinces: new Set(), wards: [] });
      const pEntry = provinceMap.get(pName);

      const oldCodes  = _dvhcMappings.get(newCode) || [];
      const oldWards  = oldCodes.map(oc => _dvhcOldWards.get(oc)).filter(Boolean);

      // Track old provinces for this province group
      for (const ow of oldWards) pEntry.oldProvinces.add(ow.provinceName);

      // Build old ward labels with optional disambiguation
      const nameCounts = {};
      for (const ow of oldWards) nameCounts[ow.wardName] = (nameCounts[ow.wardName] || 0) + 1;
      const nameDistCounts = {};
      for (const ow of oldWards) {
        const k = ow.wardName + '|' + ow.districtName;
        nameDistCounts[k] = (nameDistCounts[k] || 0) + 1;
      }
      const oldWardLabels = oldWards.length === 0
        ? ['(không có thông tin)']
        : oldWards.map(ow => {
            if (nameCounts[ow.wardName] > 1) {
              const k = ow.wardName + '|' + ow.districtName;
              if (nameDistCounts[k] > 1) return `${ow.wardName} - ${ow.provinceName}`;
              return `${ow.wardName} - ${ow.districtName}`;
            }
            return ow.wardName;
          });

      // Build searchable string (newline-stripped values joined)
      const wardSearchable = [
        newInfo.wardName.toLowerCase(),
        ...oldWards.map(ow => ow.wardName.toLowerCase()),
        ...oldWards.map(ow => ow.districtName.toLowerCase()),
        ...oldWards.map(ow => ow.provinceName.toLowerCase()),
      ].join(' ');

      pEntry.wards.push({ newWardName: newInfo.wardName, oldWardLabels, wardSearchable });
    }

    // Flatten to sorted array
    _dvhcIndex = [];
    for (const [pName, pData] of provinceMap) {
      const oldProvinceList = [...pData.oldProvinces];
      const pSearchable = [pName.toLowerCase(), ...oldProvinceList.map(p => p.toLowerCase())].join(' ');
      pData.wards.sort((a, b) => a.newWardName.localeCompare(b.newWardName, 'vi'));
      _dvhcIndex.push({ newProvinceName: pName, oldProvinceList, pSearchable, wards: pData.wards });
    }
    _dvhcIndex.sort((a, b) => a.newProvinceName.localeCompare(b.newProvinceName, 'vi'));

    const total = _dvhcIndex.reduce((s, p) => s + p.wards.length, 0);
    if (statusEl) statusEl.textContent = `✅ ${total} đơn vị hành chính. Nhập để tìm.`;
  } catch (e) {
    if (statusEl) statusEl.textContent = '❌ Không tải được dữ liệu: ' + e.message;
  }
}

function qcagDVHCOnSearch(val) {
  // Search only when user confirms (Enter). Use whole-phrase matching, not incremental token matching.
  _qcagDVHCDoSearch(val.trim());
}

function _qcagDVHCDoSearch(q) {
  const resultsEl = document.getElementById('qcagDVHCResults');
  const statusEl  = document.getElementById('qcagDVHCStatus');
  if (!resultsEl) return;
  if (!q) { resultsEl.innerHTML = ''; return; }
  if (!_dvhcIndex) {
    resultsEl.innerHTML = '<div class="qcag-dvhc-empty">Dữ liệu đang tải, vui lòng chờ...</div>';
    return;
  }
  const ql = q.toLowerCase();

  const html = [];
  let totalWards = 0;

  for (const pEntry of _dvhcIndex) {
    // Province matches if the whole phrase appears in province searchable text
    const pMatches = pEntry.pSearchable.includes(ql);
    // A ward matches if the whole phrase appears in its searchable OR in the province searchable
    const matchedWards = pEntry.wards.filter(w => w.wardSearchable.includes(ql) || pEntry.pSearchable.includes(ql));
    if (!pMatches && matchedWards.length === 0) continue;

    // If province matched by name only (not by ward), show up to 30 wards
    const wardsToShow = matchedWards.length > 0
      ? matchedWards
      : (pMatches ? pEntry.wards.slice(0, 30) : []);
    if (wardsToShow.length === 0) continue;

    totalWards += wardsToShow.length;
    if (totalWards > 300) break; // safety cap

    const newProvHL  = _dvhcHighlight(pEntry.newProvinceName, q);
    const oldProvHL  = pEntry.oldProvinceList.map(p => _dvhcHighlight(p, q)).join(', ');
    const truncNote  = pMatches && matchedWards.length === 0 && pEntry.wards.length > 30
      ? `<div class="qcag-dvhc-more">Hiển thị 30/${pEntry.wards.length} xã/phường. Nhập tên xã để lọc.</div>`
      : '';

    const wardHtml = wardsToShow.map(w => {
      const newWardHL    = _dvhcHighlight(w.newWardName, q);
      const oldLabelsHL  = w.oldWardLabels.map(l => _dvhcHighlight(l, q)).join(', ');
      return `<div class="qcag-dvhc-ward-item">
        <span class="qcag-dvhc-ward-name">• ${newWardHL}</span>
        <span class="qcag-dvhc-ward-sources">Sáp nhập từ: ${oldLabelsHL}</span>
      </div>`;
    }).join('');

    html.push(`<div class="qcag-dvhc-province-group">
      <div class="qcag-dvhc-province-title">🏙️ <span class="qcag-dvhc-new-province">${newProvHL}</span>: <span class="qcag-dvhc-old-provinces">Sáp nhập từ (${oldProvHL})</span></div>
      <div class="qcag-dvhc-ward-list">${wardHtml}${truncNote}</div>
    </div>`);
  }

  if (html.length === 0) {
    resultsEl.innerHTML = '<div class="qcag-dvhc-empty">Không tìm thấy kết quả nào.</div>';
  } else {
    resultsEl.innerHTML = html.join('');
    if (totalWards > 300) {
      resultsEl.innerHTML += '<div class="qcag-dvhc-more">Quá nhiều kết quả. Hãy nhập cụ thể hơn.</div>';
    }
  }
  if (statusEl) statusEl.textContent = `${totalWards} xã/phường trong ${html.length} tỉnh`;
}

function _dvhcHighlight(text, query) {
  if (!text) return '';
  const safe = text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  if (!query) return safe;
  const ql = query.toLowerCase().trim();
  if (!ql) return safe;
  const esc = ql.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const re = new RegExp(esc, 'gi');
  return safe.replace(re, m => `<mark>${m}</mark>`);
}
