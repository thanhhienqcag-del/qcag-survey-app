// ====================================================================
// js/flows/desktop-qcag-flow.js — dedicated desktop UI for QCAG users
// ====================================================================
'use strict';

let _qcagDesktopFilterType = 'new';
let _qcagDesktopStatusFilter = 'processing';
let _qcagDesktopRegionFilter = 'all';
let _qcagDesktopSearchQuery = '';
let _qcagDesktopCurrentId = null;
let _qcagDesktopPendingCommentImages = [];
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

function qcagDesktopNormalizeImageUrl(url) {
  const v = String(url || '').trim();
  if (!v) return '';
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
    if (!Array.isArray(statusImgs) || statusImgs.length === 0) {
      tags.push('Đang chờ kiểm tra bảo hành');
    }
    // Possible rejection / expired indicators (best-effort detection)
    if (req.rejected === true || req.rejectedAt || String(req.status || '').toLowerCase() === 'rejected') {
      tags.push('Yêu cầu bị từ chối');
    }
    if (req.warrantyExpired === true || req.warrantyExpiredAt || String(req.status || '').toLowerCase() === 'expired') {
      tags.push('Đã hết hạn bảo hành');
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

  if (String(req.type || '').toLowerCase() === 'warranty' && (status === 'done' || status === 'processed')) {
    tags.push('Đã Bảo hành');
  }

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

function qcagDesktopHasPendingCategoryEdit(req) {
  if (!qcagDesktopIsPendingEditRequest(req)) return false;
  const comments = qcagDesktopParseJson(req && req.comments, []);
  if (!Array.isArray(comments)) return false;

  const latestIndex = (() => {
    for (let i = comments.length - 1; i >= 0; i -= 1) {
      const c = comments[i] || {};
      if (String(c.commentType || '').toLowerCase() === 'edit-request' && String(c.authorRole || '').toLowerCase() === 'heineken') {
        return i;
      }
    }
    return -1;
  })();

  if (latestIndex === -1) return false;
  const latest = comments[latestIndex] || {};
  const cats = Array.isArray(latest.editCategories) ? latest.editCategories : [];
  const normalized = cats.map(c => String(c || '').trim().toLowerCase());

  // Only treat explicit "thay đổi hạng mục" as permission to add/remove items.
  // Brand-change only grants inline brand editing (handled separately).
  const hasCategory = normalized.includes('thay đổi hạng mục') || normalized.includes('thay doi hang muc');
  if (!hasCategory) return false;

  // ensure not yet resolved by an edit-resolved comment after this edit request
  const hasResolvedAfter = comments.some((c, idx) => idx > latestIndex && String((c && c.commentType) || '').toLowerCase() === 'edit-resolved');
  return !hasResolvedAfter;
}

function qcagDesktopCanEditItems(req) {
  return qcagDesktopHasPendingCategoryEdit(req) && !qcagDesktopIsDone(req);
}

function qcagDesktopHasPendingBrandEdit(req) {
  if (!qcagDesktopIsPendingEditRequest(req)) return false;
  const comments = qcagDesktopParseJson(req && req.comments, []);
  if (!Array.isArray(comments)) return false;

  const latestIndex = (() => {
    for (let i = comments.length - 1; i >= 0; i -= 1) {
      const c = comments[i] || {};
      if (String(c.commentType || '').toLowerCase() === 'edit-request' && String(c.authorRole || '').toLowerCase() === 'heineken') {
        return i;
      }
    }
    return -1;
  })();

  if (latestIndex === -1) return false;
  const latest = comments[latestIndex] || {};
  const cats = Array.isArray(latest.editCategories) ? latest.editCategories : [];
  const normalized = cats.map(c => String(c || '').trim().toLowerCase());

  // Recognize several variants that teams might use to mark a brand-change
  const hasBrand = normalized.includes('đổi brand') || normalized.includes('thay đổi brand') || normalized.includes('đổi thương hiệu') || normalized.includes('change brand');
  if (!hasBrand) return false;

  const hasResolvedAfter = comments.some((c, idx) => idx > latestIndex && String((c && c.commentType) || '').toLowerCase() === 'edit-resolved');
  return !hasResolvedAfter;
}

function qcagDesktopIsDone(req) {
  if (!req) return false;
  const s = String((req.status || '')).toLowerCase();
  return s === 'done' || s === 'processed';
}

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

          <label>Hạng mục khác (nội dung)
            <input id="qcagEditItemOtherContent" type="text" placeholder="Chỉ với Hạng mục khác"/>
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
    if (after) after.classList.add('hidden');
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

  // show deferred input fields and enable confirm (final validation will enforce required fields)
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
    const actionLabel = document.getElementById('qcagEditItemAction') ? document.getElementById('qcagEditItemAction').parentElement : null;
    if (actionLabel) {
      if (String(selectedType || '').toLowerCase().includes('logo') || String(selectedType || '').toLowerCase().includes('emblemd')) {
        actionLabel.style.display = 'none';
      } else {
        actionLabel.style.display = '';
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

  // If logo type, action not required
  const isLogo = String(typeVal || '').toLowerCase().includes('logo') || String(typeVal || '').toLowerCase().includes('emblemd');

  if (!isLogo) {
    const actionVal = (actionEl || {}).value || '';
    if (!actionVal) { confirmBtn.disabled = true; return false; }
  }

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

function qcagDesktopRemoveItem(index) {
  if (!currentDetailRequest || !qcagDesktopCanEditItems(currentDetailRequest)) return;
  const items = qcagDesktopParseJson(currentDetailRequest.items, []);
  if (!Array.isArray(items) || index < 0 || index >= items.length) return;

  items.splice(index, 1);
  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);
  const now = new Date().toISOString();
  comments.push({authorRole: 'system', authorName: 'Hệ thống', text: `Đã xóa hạng mục số ${index + 1}`, createdAt: now});

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
  if (!qcagDesktopHasPendingBrandEdit(currentDetailRequest) || qcagDesktopIsDone(currentDetailRequest)) {
    showToast('Không có quyền thay đổi brand cho yêu cầu này');
    // re-render to restore previous state
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
    // Only clear design images if there were any at time of the request.
    const designImgs = qcagDesktopParseJson(req.designImages, []);
    const shouldClearMq = Array.isArray(designImgs) && designImgs.length > 0;

    const updated = {
      ...req,
      editingRequestedAt: req.editingRequestedAt || new Date().toISOString(),
      status: 'processing',
      updatedAt: new Date().toISOString()
    };

    if (shouldClearMq) {
      updated.designImages = '[]';
    }

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
      // Only treat as done if it has MQ and is explicitly done; edits pull back to processing
      const designImgs = qcagDesktopParseJson(r.designImages, []);
      const hasMq = Array.isArray(designImgs) && designImgs.length > 0;
      const hasEditRequest = qcagDesktopIsPendingEditRequest(r);
      return isDone && hasMq && !hasEditRequest;
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
      const statusImgs = qcagDesktopParseJson(r.statusImages, []);
      const needsAccept = statusImgs.length === 0;
      const needsEdit = qcagDesktopIsPendingEditRequest(r);
      const designImgs = qcagDesktopParseJson(r.designImages, []);
      const hasDesignAwaitingConfirm = Array.isArray(designImgs) && designImgs.length > 0 && !isDone;
      return needsEdit || needsAccept || hasDesignAwaitingConfirm;
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

  list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
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
  _qcagDesktopSearchQuery = String(value || '').trim().toLowerCase();
  if (_qcagDesktopSearchDebounce) clearTimeout(_qcagDesktopSearchDebounce);
  _qcagDesktopSearchDebounce = setTimeout(() => {
    renderQCAGDesktopList();
  }, 160);
}

function qcagDesktopSetTypeFilter(type) {
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
    _qcagDesktopCurrentId = requests[0] ? requests[0].__backendId : null;
  }
  if (_qcagDesktopCurrentId) {
    openQCAGDesktopRequest(_qcagDesktopCurrentId);
  } else {
    const detailEl = document.getElementById('qcagDesktopDetail');
    if (detailEl) detailEl.innerHTML = '<div class="qcag-detail-empty">Chưa có request phù hợp bộ lọc hiện tại</div>';
  }
}

function qcagDesktopSetRegionFilter(region) {
  _qcagDesktopRegionFilter = region || 'all';
  const regions = ['all', 'S4', 'S5', 'S16', 'S17', '24', 'S19', 'MOT8'];
  regions.forEach(r => {
    const btn = document.getElementById(`qcagRegion${r === 'all' ? 'All' : r}`);
    if (btn) btn.classList.toggle('active', r === _qcagDesktopRegionFilter);
  });
  renderQCAGDesktopList();
  const requests = getQCAGDesktopVisibleRequests();
  if (!requests.find(r => r.__backendId === _qcagDesktopCurrentId)) {
    _qcagDesktopCurrentId = requests[0] ? requests[0].__backendId : null;
  }
  if (_qcagDesktopCurrentId) {
    openQCAGDesktopRequest(_qcagDesktopCurrentId);
  } else {
    const detailEl = document.getElementById('qcagDesktopDetail');
    if (detailEl) detailEl.innerHTML = '<div class="qcag-detail-empty">Chưa có request phù hợp bộ lọc hiện tại</div>';
  }
}

function qcagDesktopSetStatusFilter(status) {
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
        const statusImgs = qcagDesktopParseJson(r.statusImages, []);
        const needsAccept = statusImgs.length === 0;
        const needsEdit = qcagDesktopIsPendingEditRequest(r);
        return needsEdit || needsAccept;
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

function renderQCAGDesktopList() {
  qcagDesktopUpdateFilterCounts();
  const listEl = document.getElementById('qcagDesktopRequestList');
  if (!listEl || !shouldUseQCAGDesktop()) return;

  const prevScrollTop = listEl.scrollTop || 0;

  const requests = getQCAGDesktopVisibleRequests();
  if (requests.length === 0) {
    listEl.innerHTML = '<div class="qcag-list-empty">Không có request</div>';
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

    return `
      <button class="qcag-request-item ${activeCls}" onclick="openQCAGDesktopRequest('${req.__backendId}')">
        <div class="qcag-request-item-top">
          <div class="qcag-request-name">${escapeHtml(req.outletName || '-')} • ${escapeHtml(req.outletCode || '-')}</div>
          <span class="qcag-status-badge ${displayBadge.cls}">${displayBadge.label}</span>
        </div>
        <div class="qcag-request-code">${escapeHtml(saleName)} • ${escapeHtml(region)}</div>
        <div class="qcag-request-ss">${(() => { const ss = (requester && requester.ssName) || ''; return ss && ss !== '-' ? 'Tên SS/SE: ' + escapeHtml(ss) : '<span class="qcag-ss-tba">Chức vụ TBA</span>'; })()}</div>
        <div class="qcag-request-design">Thời gian: ${escapeHtml(dateStr)}</div>
        <div class="qcag-request-date">Mã: ${escapeHtml(requestCode)}</div>
      </button>
    `;
  }).join('');

  if (prevScrollTop > 0) {
    listEl.scrollTop = prevScrollTop;
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
  const designImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(updatedRequest.designImages, []));

  // Rebuild thumb grid in-place
  const previewEl = document.getElementById('qcagMQPreview');
  if (previewEl) {
    previewEl.innerHTML = designImgs.length > 0
      ? designImgs.map((img, i) => `
        <div class="qcag-thumb-item">
          <img src="${img}" onclick="showImageFull(this.src,false)">
          <button type="button" class="qcag-thumb-remove" onclick="qcagDesktopRemoveDesignImage(${i})">✕</button>
        </div>`).join('')
      : '<div class="qcag-detail-muted">Chưa có MQ</div>';
  }

  // Update the complete button state
  const completeBtn = document.querySelector('.qcag-complete-btn');
  if (completeBtn) {
    const isPendingEdit = qcagDesktopIsPendingEditRequest(updatedRequest);
    const reqStatus = String(updatedRequest.status || '').toLowerCase();
    const isDone = (reqStatus === 'done' || reqStatus === 'processed') && !isPendingEdit;

    const isSurveySizeIncomplete = qcagDesktopIsSurveySizeIncomplete(updatedRequest);
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
        const actionCell = canManageItems ? `<div><button class="qcag-item-delete-btn" onclick="qcagDesktopRemoveItem(${idx})" title="Xóa hạng mục">✕</button></div>` : '';
        const brandBadge = item && item.brandChangedByQCAG
          ? `<span class="qcag-brand-changed-badge" title="${escapeHtml('Brand được ' + (item.brandChangedBy || 'QCAG') + ' QCAG đổi theo yêu cầu của sale')}"></span>`
          : '';
        const addedBadgeHtml = item && item.addedByQCAG
          ? `<span class="qcag-added-badge" title="${escapeHtml('Hạng mục được thêm bởi ' + (item.addedByQCAGBy || 'QCAG') + ' theo yêu cầu chỉnh sửa' + (item.type ? ': ' + item.type : ''))}"></span>`
          : '';
        const badgesHtml = `${brandBadge}${addedBadgeHtml}`;
        return `<div class="qcag-items-row"><div class="qcag-stt-cell"><div class="qcag-stt-num">${idx + 1}</div><div class="qcag-stt-badges">${badgesHtml}</div></div><div>${escapeHtml(item.type || '-')}</div><div>${escapeHtml(item.action || '-')}</div>${(() => {
          // If current request allows inline brand change, render a select control
          try {
            const canInline = typeof qcagDesktopHasPendingBrandEdit === 'function' && qcagDesktopHasPendingBrandEdit(currentDetailRequest) && !qcagDesktopIsDone(currentDetailRequest);
            if (canInline) {
              const brands = (typeof getBrandsForType === 'function' ? getBrandsForType(item.type || '') : Array.isArray(allBrands) ? allBrands : []) || [];
              const opts = (brands || []).map(b => `<option value="${escapeHtml(b)}"${String(b) === String(item.brand || '') ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('');
              return `<div style="display:flex;align-items:center;gap:8px;"><select id="qcagInlineBrandSelect_${idx}" class="qcag-inline-brand-select" onchange="qcagDesktopInlineChangeBrand(${idx}, this.value)"><option value="">Chọn brand</option>${opts}</select></div>`;
            }
          } catch (e) {}
          return `<div>${escapeHtml(item.brand || '-')}</div>`;
        })()}<div>${sizeHtml}${sizeExtraNote}</div><div>${escapeHtml(poles)}</div><div>${escapeHtml(requestText)}</div>${actionCell}</div>`;
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

function qcagDesktopRenderCommentPreview() {
  const wrap = document.getElementById('qcagCommentUploadPreview');
  if (!wrap) return;
  if (_qcagDesktopPendingCommentImages.length === 0) {
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
  const currentId = currentReq.__backendId;
  return (allRequests || [])
    .filter(r => {
      if (r.__backendId === currentId) return false;
      if (String(r.outletCode || '').trim().toLowerCase() !== outletCode) return false;
      const status = String(r.status || '').toLowerCase();
      if (status !== 'done' && status !== 'processed') return false;
      const imgs = qcagDesktopParseJson(r.designImages, []);
      return Array.isArray(imgs) && imgs.length > 0;
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
  const designImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(entry.designImages, []));
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

  let request = await qcagDesktopGetFullRequest(id);
  if (!request) return;

  // Warm assets in background, do not block UI updates while switching tabs.
  qcagDesktopWarmRequestAssets(request).catch(() => {});

  request = _qcagDesktopFullRequestCache[id] || request;

  const isSameReq = _qcagDesktopCurrentId === id;
  _qcagDesktopCurrentId = id;
  currentDetailRequest = request;
  if (!keepPendingComment) _qcagDesktopPendingCommentImages = [];

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
    <div class="qcag-detail-layout">
      <div class="qcag-detail-left">
        <div class="qcag-card">
          <div class="qcag-card-header">
            <div class="qcag-card-title">Thông tin người yêu cầu</div>
            <div class="qcag-request-time">${request.createdAt ? escapeHtml(new Date(request.createdAt).toLocaleString('vi-VN')) : '-'}</div>
          </div>
          <div class="qcag-requester-grid">
            <div><span>Tên Sale</span><strong>${escapeHtml(requester.saleName || requester.saleName || requester.phone || '-')}</strong></div>
            <div><span>Mã Sale</span><strong>${escapeHtml(requester.saleCode || '-')}</strong></div>
            <div><span>Khu vực</span><strong>${escapeHtml(requester.region || '-')}</strong></div>
            <div><span>Tên SS/SE</span><strong>${escapeHtml(requester.ssName || requester.ssName || '-')}</strong></div>
          </div>
        </div>

        <div class="qcag-card">
          <div class="qcag-card-title">Thông tin Outlet</div>
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

        <div class="qcag-card">
          <div class="qcag-card-title">
            <span>Hạng mục yêu cầu</span>
            ${canManageItems ? '<button type="button" class="qcag-add-item-btn" onclick="qcagDesktopOpenEditItemsModal()">+ Thêm hạng mục</button>' : ''}
          </div>
          <div id="qcagItemsSection">${qcagDesktopBuildItemsHtml(items, canManageItems)}</div>
        </div>

        <div class="qcag-card qcag-card--no-frame">
          <div class="qcag-content-split">
              <div class="qcag-subcard">
                <div class="qcag-card-title">Nội dung bảng hiệu</div>
                <div class="qcag-subcard-body">
                  ${(() => {
                    try {
                      const isOld = !!request.oldContent;
                      const oldImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(request.oldContentImages, []));
                      const oldExtra = request.oldContentExtra || '';
                      if (isOld) {
                        if (oldImgs.length > 0) {
                            const encOld = encodeURIComponent(JSON.stringify(oldImgs));
                            const firstOld = oldImgs[0];
                            const moreOld = oldImgs.length > 1 ? (oldImgs.length - 1) : 0;
                            let galleryHtml = '';
                            if (oldImgs.length === 1) {
                              galleryHtml = `<div class="qcag-gallery-rep" onclick="showImageFull(this.querySelector('img').src,false)"><img src="${firstOld}" alt="nội dung cũ"></div>`;
                            } else {
                              galleryHtml = `<div class="qcag-gallery-rep" onclick="qcagOpenGalleryEncoded('${encOld}',0)"><img src="${firstOld}" alt="nội dung cũ"><div class="qcag-img-more">${moreOld > 0 ? '+' + moreOld : ''}</div></div>`;
                            }
                            return galleryHtml + (oldExtra ? `<div class="qcag-supplement"><div class="qcag-supplement-title">Nội dung bổ sung:</div><div class="qcag-content-pre">${escapeHtml(oldExtra)}</div></div>` : '');
                          }
                        return (oldExtra ? `<div class="qcag-supplement"><div class="qcag-supplement-title">Nội dung bổ sung:</div><div class="qcag-content-pre">${escapeHtml(oldExtra)}</div></div>` : `<div class="qcag-detail-muted">Chưa có ảnh nội dung cũ</div>`);
                      }
                      return request.content ? `<div class="qcag-content-pre">${escapeHtml(request.content)}</div>` : `<div class="qcag-detail-muted">Không có mô tả</div>`;
                    } catch (e) { return `<div class="qcag-detail-muted">Không có mô tả</div>`; }
                  })()}
                </div>
              </div>

            <div class="qcag-subcard">
              <div class="qcag-card-title">Hiện trạng Outlet</div>
              <div class="qcag-subcard-body qcag-content-images">
                ${statusImgs.length > 0 ? (() => {
                  const enc = encodeURIComponent(JSON.stringify(statusImgs));
                  const first = statusImgs[0];
                  const moreCount = statusImgs.length > 1 ? (statusImgs.length - 1) : 0;
                  if (statusImgs.length === 1) {
                    return `<div class="qcag-gallery-rep" onclick="showImageFull(this.querySelector('img').src,false)"><img src="${first}" alt="hiện trạng"></div>`;
                  }
                  return `<div class="qcag-gallery-rep" onclick="qcagOpenGalleryEncoded('${enc}',0)"><img src="${first}" alt="hiện trạng"><div class="qcag-img-more">${moreCount > 0 ? '+' + moreCount : ''}</div></div>`;
                })() : '<div class="qcag-detail-muted">Chưa có ảnh nội dung</div>'}
              </div>
            </div>
          </div>
        </div>

        <div class="qcag-card">
          <div class="qcag-actions qcag-split-cards">
            <div class="qcag-subcard">
              <div class="qcag-card-title">Upload MQ thiết kế</div>
              <div class="qcag-subcard-body">
                <div class="qcag-action-block">
                  <label class="qcag-upload-square" title="Upload MQ thiết kế">
                    <input type="file" accept="image/*" multiple onchange="qcagDesktopUploadMQ(this)">
                    <div class="qcag-upload-plus">+</div>
                  </label>
                  <div id="qcagMQPreview" class="qcag-thumb-grid">
                    ${designImgs.length > 0 ? designImgs.map((img, i) => `
                      <div class="qcag-thumb-item">
                        <img src="${img}" onclick="showImageFull(this.src,false)">
                        <button type="button" class="qcag-thumb-remove" onclick="qcagDesktopRemoveDesignImage(${i})">✕</button>
                      </div>
                    `).join('') : '<div class="qcag-detail-muted">Chưa có MQ</div>'}
                  </div>
                </div>
                
                <div class="qcag-mq-footer">
                  ${(() => {
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
                      ? `Thiết Kế: ${escapeHtml(displayCreator)}${displayCreatorTime ? ' • ' + escapeHtml(new Date(displayCreatorTime).toLocaleString('vi-VN')) : ''}`
                      : 'Thiết Kế: Chưa có người thiết kế';

                    const editedLine = showEdited
                      ? `Chỉnh sửa: ${escapeHtml(lastEditedBy)}${lastEditedAt ? ' • ' + escapeHtml(new Date(lastEditedAt).toLocaleString('vi-VN')) : ''}`
                      : 'Chỉnh sửa: chưa có chỉnh sửa nào';

                    const creatorClass = displayCreator ? 'qcag-mq-created' : 'qcag-mq-created qcag-mq-empty';
                    const editedClass = showEdited ? 'qcag-mq-edited' : 'qcag-mq-edited qcag-mq-empty';

                    const isSurveySizeIncomplete = qcagDesktopIsSurveySizeIncomplete(request);
                    const showCompleteBtn = _qcagDesktopStatusFilter !== 'done';
                    const completeDisabled = designImgs.length === 0 || isSurveySizeIncomplete;
                    const completeTitle = isSurveySizeIncomplete
                      ? 'Vui lòng xác nhận kích thước khảo sát trước khi hoàn thành'
                      : (designImgs.length === 0 ? escapeHtml(completeBtnDisabledTitle) : '');

                    const warning = isSurveySizeIncomplete
                      ? '<div class="qcag-survey-warning">Vui lòng xác nhận kích thước khảo sát trước khi hoàn thành.</div>'
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

      <div class="qcag-detail-right">
        <div class="qcag-chat-card">
          <div class="qcag-chat-head">Trao đổi QCAG ↔ Sale Heineken</div>
          <div id="qcagCommentTimeline" class="qcag-comment-timeline">
            ${comments.length > 0 ? comments.map((c, idx) => qcagDesktopCommentHtml(c, comments, idx)).join('') : '<div class="qcag-detail-muted">Chưa có bình luận</div>'}
          </div>
          <div class="qcag-chat-input-wrap">
            <textarea id="qcagCommentInput" rows="3" placeholder="Nhập bình luận..."></textarea>
            <div id="qcagCommentUploadPreview" class="qcag-upload-preview hidden"></div>
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
  `;

  qcagDesktopRenderCommentPreview();

  if (prevLeftScroll > 0) {
    const newLeft = detailEl.querySelector('.qcag-detail-left');
    if (newLeft) newLeft.scrollTop = prevLeftScroll;
  }

  setTimeout(() => {
    const timeline = document.getElementById('qcagCommentTimeline');
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, 40);

  qcagDesktopSyncReadStatus(request);
}

async function qcagDesktopUploadMQ(input) {
  if (!currentDetailRequest || !input) return;
  const files = Array.from(input.files || []);
  if (files.length === 0) return;

  // Only keep a single MQ image: the most recently added file replaces any existing images
  const file = files[files.length - 1];
  const reader = new FileReader();
  let dataUrl = null;
  await new Promise(resolve => {
    reader.onload = (e) => { dataUrl = e.target.result; resolve(); };
    reader.readAsDataURL(file);
  });

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

  const currentImgs = [imageUrl];

  const isPendingEdit = qcagDesktopIsPendingEditRequest(currentDetailRequest);
  const comments = qcagDesktopParseJson(currentDetailRequest.comments, []);

  // If this upload is in response to an edit request, increment edit counter
  // and add an automatic system comment notifying the revision.
  let nextEditRevisionCount = currentDetailRequest.editRevisionCount || 0;
  if (isPendingEdit) {
    nextEditRevisionCount = (currentDetailRequest.editRevisionCount || 0) + 1;
    const now = new Date().toISOString();
    const displayTime = new Date(now).toLocaleString('vi-VN');
    const outletName = currentDetailRequest.outletName || '-';
    const autoCommentText = `Outlet ${outletName} đã được chỉnh sửa lần thứ ${nextEditRevisionCount} vào lúc ${displayTime}.`;
    comments.push({ authorRole: 'system', authorName: 'Hệ thống', text: autoCommentText, createdAt: now });
  }

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
    // Set status to 'processing' after an upload so the item shows as awaiting confirmation
    // (unless it is already completed). This ensures the badge becomes 'Chờ xác nhận'.
    status: (function () {
      const s = String(currentDetailRequest.status || 'pending').toLowerCase();
      if (s === 'done' || s === 'processed') return s;
      return 'processing';
    })(),
    comments: JSON.stringify(comments),
    editRevisionCount: nextEditRevisionCount,
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
  const isPendingEdit = qcagDesktopIsPendingEditRequest(currentDetailRequest);
  // Must have MQ before marking done
  const designImgs = qcagDesktopParseJson(currentDetailRequest.designImages, []);
  if (!designImgs || designImgs.length === 0) {
    showToast(isPendingEdit
      ? 'Vui lòng upload MQ thiết kế trước khi xác nhận đã chỉnh sửa'
      : 'Vui lòng upload MQ thiết kế trước khi hoàn thành');
    return;
  }
  const isSurveySizeIncomplete = qcagDesktopIsSurveySizeIncomplete(currentDetailRequest);
  if (isSurveySizeIncomplete) {
    showToast('Vui lòng xác nhận kích thước khảo sát trước khi hoàn thành');
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
  // If this was an edit flow, record the last editor
  if (isPendingEdit) {
    extraFields.designLastEditedBy = currentSession ? (currentSession.saleName || currentSession.name || currentSession.phone || 'QCAG') : 'QCAG';
    extraFields.designLastEditedAt = now;
  }

  const updated = {
    ...currentDetailRequest,
    status: 'done',
    processedAt: now,
    updatedAt: now,
    // Clear any pending edit request when QCAG marks done again after revision
    editingRequestedAt: null,
    comments: JSON.stringify(comments),
    ...extraFields
  };
  const persistOk = await qcagDesktopPersistRequest(updated, isPendingEdit ? 'Đã xác nhận chỉnh sửa' : 'Đã hoàn thành');

  // Fire push notification to Sale Heineken (best-effort, never blocks UI)
  if (persistOk) {
    try {
      let requesterPhone = null;
      let requesterSaleCode = null;
      let requesterObj = {};
      try {
        const req = updated.requester;
        requesterObj = typeof req === 'string' ? JSON.parse(req) : (req || {});
        requesterPhone = requesterObj.phone || null;
        requesterSaleCode = requesterObj.saleCode || null;
        // Normalize phone
        if (requesterPhone) {
          requesterPhone = String(requesterPhone).replace(/[\s\-\.]+/g, '');
          if (requesterPhone.startsWith('+84')) requesterPhone = '0' + requesterPhone.slice(3);
          else if (requesterPhone.startsWith('84') && requesterPhone.length >= 10) requesterPhone = '0' + requesterPhone.slice(2);
        }
      } catch (_) {}

      console.log('[push/done] requester saleCode:', requesterSaleCode, 'phone:', requesterPhone);

      const outletLabel = updated.outletName || updated.outletCode || 'Outlet';
      const tkCode = updated.__backendId || updated.outletCode || '';
      const pushTitle = isPendingEdit ? 'QCAG — Đã hoàn thành chỉnh sửa' : 'QCAG — Đã có mẫu quảng cáo (MQ)';
      const pushBody = isPendingEdit
        ? `Yêu cầu ${tkCode} Outlet ${outletLabel} đã được chỉnh sửa. Vui lòng mở app để xem.`
        : `Yêu cầu ${tkCode} Outlet ${outletLabel} đã có MQ. Vui lòng mở app để xem.`;

      // Build payload: prefer saleCode → phone fallback → role=heineken broadcast
      const pushPayload = {
        title: pushTitle,
        body: pushBody,
        data: { backendId: updated.__backendId },
      };
      if (requesterSaleCode) {
        pushPayload.saleCode = requesterSaleCode;
        // Also include phone so send.js can fallback to phone lookup
        // if subscription has no sale_code (e.g. older subscriptions)
        if (requesterPhone) pushPayload.phone = requesterPhone;
      } else if (requesterPhone) {
        pushPayload.phone = requesterPhone;
      } else {
        // No identifier in old request → broadcast to all Heineken
        console.warn('[push/done] no saleCode or phone in requester, falling back to role=heineken broadcast');
        pushPayload.role = 'heineken';
      }

      fetch('/api/ks/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pushPayload),
      }).then(function(r) {
        return r.json();
      }).then(function(result) {
        console.log('[push/done] result:', JSON.stringify(result), '| payload:', JSON.stringify(pushPayload));
        if (result && result.ok && result.sent > 0) {
          showToast('Đã gửi thông báo đến Sale (' + String(result.sent) + ' thiết bị)');
        } else if (result && result.sent === 0) {
          console.warn('[push/done] no subscriptions found, payload:', JSON.stringify(pushPayload));
          showToast('⚠ Sale chưa đăng ký nhận thông báo. Mời Sale mở lại app để đăng ký.');
        } else if (!result || !result.ok) {
          console.warn('[push/done] API error:', JSON.stringify(result));
          showToast('⚠ Lỗi gửi thông báo: ' + (result && result.error ? result.error : 'unknown'));
        }
      }).catch(function(e) {
        console.warn('[push/send] fetch error:', e);
        showToast('⚠ Không thể kết nối để gửi thông báo.');
      });
    } catch (e) {
      console.warn('[push] markDone push error (non-fatal):', e);
    }
  }
}

async function qcagDesktopPickCommentImages(input) {
  if (!input) return;
  const files = Array.from(input.files || []);
  for (const file of files) {
    const reader = new FileReader();
    await new Promise(resolve => {
      reader.onload = (e) => {
        _qcagDesktopPendingCommentImages.push(e.target.result);
        resolve();
      };
      reader.readAsDataURL(file);
    });
  }
  qcagDesktopRenderCommentPreview();
  input.value = '';
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
  const ok = await qcagDesktopPersistRequest(updated, 'Đã gửi bình luận');
  if (!ok) return;

  _qcagDesktopPendingCommentImages = [];
  ta.value = '';
  qcagDesktopRenderCommentPreview();

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
