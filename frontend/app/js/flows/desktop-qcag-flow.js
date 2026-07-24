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
let _qcagDesktopOpenRequestSnapshot = null; // Snapshot of request when opened to freeze list position
let _qcagDesktopPendingCommentImages = [];
let _qcagCommentsCollapsed = false; // collapsible comment panel state
let _qcagDesktopSearchDebounce = null;
let _qcagDesktopFullRequestCache = {};
let _qcagDesktopFullRequestPending = {};
let _qcagDesktopImageBlobUrlCache = {};
let _qcagDesktopImageWarmPending = {};
let _qcagDesktopInitialWarmupPromise = null;
let _qcagDesktopBackgroundWarmScheduled = false;

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

// Normalize phone numbers: keep digits, convert +84 or leading 84 to leading 0
function qcagNormalizePhone(raw) {
  if (!raw && raw !== 0) return '';
  let s = String(raw || '').trim();
  if (!s) return '';
  // remove common separators
  s = s.replace(/[^+\d]/g, '');
  // Handle +84 or 84 country code -> replace with 0
  if (/^\+?84(\d{8,9})$/.test(s)) {
    s = s.replace(/^\+?84/, '0');
  }
  // If starts with '84' followed by digits and no plus
  if (/^84(\d{8,9})$/.test(s)) s = s.replace(/^84/, '0');
  // If it now starts with digits but missing leading zero (length 9 and starts with 9/1 etc.), prefix 0
  if (/^[1-9]\d{8}$/.test(s)) s = '0' + s;
  return s;
}

function qcagDesktopIsImagePlaceholder(value) {
  const v = String(value == null ? '' : value).trim();
  return /^\[["']\.+["']\]$/.test(v);
}

function qcagDesktopMergePreserveImageFields(nextReq, prevReq) {
  if (!nextReq || typeof nextReq !== 'object') return nextReq;
  if (!prevReq || typeof prevReq !== 'object') return nextReq;

  const merged = Object.assign({}, prevReq, nextReq);
  const imageFields = ['statusImages', 'designImages', 'acceptanceImages', 'oldContentImages'];

  for (const field of imageFields) {
    const incoming = merged[field];
    const prev = prevReq[field];
    const incomingMissing = incoming == null || String(incoming).trim() === '';
    const incomingPlaceholder = qcagDesktopIsImagePlaceholder(incoming);
    const prevUsable = prev != null && String(prev).trim() !== '' && !qcagDesktopIsImagePlaceholder(prev);
    if ((incomingMissing || incomingPlaceholder) && prevUsable) {
      merged[field] = prev;
    }
  }

  return merged;
}

// Global delegated handler for `.toggle-switch` elements to keep toggles responsive
(function qcagInitToggleSwitches() {
  if (typeof window === 'undefined' || !document) return;
  document.addEventListener('click', (ev) => {
    try {
      const btn = ev.target && (ev.target.closest ? ev.target.closest('.toggle-switch') : null);
      if (!btn) return;
      // If this toggle has its own onclick handler (inline or bound),
      // skip the global delegated toggle to avoid double-toggle.
      try {
        if (btn.getAttribute && btn.getAttribute('onclick')) return;
      } catch (e) {}
      // Prevent accidental form submissions
      ev.preventDefault();
      btn.classList.toggle('toggle-on');
      btn.classList.toggle('bg-gray-900');
      btn.classList.toggle('bg-gray-300');
    } catch (e) {}
  }, true);
})();

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
  const existing = _qcagDesktopFullRequestCache[req.__backendId];
  _qcagDesktopFullRequestCache[req.__backendId] = qcagDesktopMergePreserveImageFields(req, existing);
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
    _qcagDesktopImageBlobUrlCache[normalized] = normalized;
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
          merged = Object.assign({}, base, r.data);
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

function qcagDesktopScheduleBackgroundWarmup() {
  if (_qcagDesktopBackgroundWarmScheduled) return;
  _qcagDesktopBackgroundWarmScheduled = true;

  const runner = async () => {
    try {
      const currentId = _qcagDesktopCurrentId;
      if (!currentId) return;
      const full = await qcagDesktopGetFullRequest(currentId);
      if (full && _qcagDesktopCurrentId === currentId) {
        await qcagDesktopWarmRequestAssets(full);
      }
    } catch (_) {
    } finally {
      _qcagDesktopBackgroundWarmScheduled = false;
    }
  };

  try {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => { runner(); }, { timeout: 1200 });
      return;
    }
  } catch (_) {}

  setTimeout(() => { runner(); }, 250);
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
      if (Array.isArray(items) && items.some(it => it && it.type !== 'Hạng mục khác' && !!it.survey && !(it.surveySize && it.surveySize.width && it.surveySize.height))) {
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
          <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
            <label style="display:flex;gap:8px;align-items:center;">Khảo sát
              <button id="qcagEditSingleItemSurveyToggle" type="button" class="toggle-switch bg-gray-300 rounded-full p-0.5 relative" aria-pressed="false">
                <div class="toggle-slider w-5 h-5 bg-white rounded-full shadow"></div>
              </button>
            </label>
            <label style="display:flex;gap:8px;align-items:center;">Kích thước cũ
              <button id="qcagEditSingleItemUseOldSizeToggle" type="button" class="toggle-switch bg-gray-300 rounded-full p-0.5 relative" aria-pressed="false">
                <div class="toggle-slider w-5 h-5 bg-white rounded-full shadow"></div>
              </button>
            </label>
          </div>
          <div class="qcag-edit-grid-3" style="margin-top:8px">
            <label>Chiều ngang (m)
              <input id="qcagEditSingleItemWidth" type="text" inputmode="decimal" oninput="sanitizeDecimalInput(this)"/>
            </label>
            <label>Chiều cao (m)
              <input id="qcagEditSingleItemHeight" type="text" inputmode="decimal" oninput="sanitizeDecimalInput(this)"/>
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

  const previousBrand = brandEl.value || '';
  const previousAction = actionEl ? (actionEl.value || '') : '';

  const brands = getBrandsForType(selectedType);
  if (Array.isArray(brands) && brands.length > 0) {
    brandEl.innerHTML = `<option value="">Chọn brand</option>${brands.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}`;
    if (brands.includes(previousBrand)) {
      brandEl.value = previousBrand;
    } else if (brands.length === 1) {
      brandEl.value = brands[0];
    } else {
      brandEl.value = '';
    }
  } else {
    brandEl.innerHTML = '<option value="">Chọn brand</option>';
    brandEl.value = '';
  }
  try {
    if (actionEl) {
      const isLogoType = String(selectedType || '').toLowerCase().includes('logo') || String(selectedType || '').toLowerCase().includes('emblemd');
      const validActions = isLogoType ? ["Làm mới", "Sửa chữa"] : ["Làm mới", "Thay bạt"];
      if (isLogoType) {
        actionEl.innerHTML = `<option value="">Chọn hình thức</option><option value="Làm mới">Làm mới</option><option value="Sửa chữa">Sửa chữa</option>`;
      } else {
        actionEl.innerHTML = `<option value="">Chọn hình thức</option><option value="Làm mới">Làm mới</option><option value="Thay bạt">Thay bạt</option>`;
      }
      if (validActions.includes(previousAction)) {
        actionEl.value = previousAction;
      } else {
        actionEl.value = '';
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

  // Prefill toggles (survey / useOldSize)
  try {
    const sBtn = document.getElementById('qcagEditSingleItemSurveyToggle');
    const uBtn = document.getElementById('qcagEditSingleItemUseOldSizeToggle');
    if (sBtn) {
      if (item.survey) sBtn.className = 'toggle-switch bg-gray-900 toggle-on rounded-full p-0.5 relative';
      else sBtn.className = 'toggle-switch bg-gray-300 rounded-full p-0.5 relative';
    }
    if (uBtn) {
      if (item.useOldSize) uBtn.className = 'toggle-switch bg-gray-900 toggle-on rounded-full p-0.5 relative';
      else uBtn.className = 'toggle-switch bg-gray-300 rounded-full p-0.5 relative';
    }
  } catch (e) {}

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

  const sBtn = document.getElementById('qcagEditSingleItemSurveyToggle');
  const uBtn = document.getElementById('qcagEditSingleItemUseOldSizeToggle');
  const newSurvey = newType === 'Hạng mục khác' ? false : !!(sBtn && sBtn.classList.contains('toggle-on'));
  const newUseOldSize = !!(uBtn && uBtn.classList.contains('toggle-on'));

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
  if (newSurvey !== !!oldItem.survey) changes.push(`Khảo sát: ${oldItem.survey ? 'Có' : 'Không'} → ${newSurvey ? 'Có' : 'Không'}`);
  if (newUseOldSize !== !!oldItem.useOldSize) changes.push(`Kích thước cũ: ${oldItem.useOldSize ? 'Có' : 'Không'} → ${newUseOldSize ? 'Có' : 'Không'}`);

  items[idx] = {
    ...oldItem,
    type:         newType,
    brand:        newBrand,
    action:       newAction,
    note:         newNote,
    width:        newWidth  || oldItem.width  || undefined,
    height:       newHeight || oldItem.height || undefined,
    poles:        newPoles,
    survey:       newSurvey,
    useOldSize:   newUseOldSize,
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
              <input id="qcagEditItemWidth" type="text" inputmode="decimal" oninput="sanitizeDecimalInput(this); qcagEditItemsMaybeValidate()" />
            </label>
            <label>Chiều cao (m)
              <input id="qcagEditItemHeight" type="text" inputmode="decimal" oninput="sanitizeDecimalInput(this); qcagEditItemsMaybeValidate()" />
            </label>
            <label>Số trụ
              <input id="qcagEditItemPoles" type="number" min="0" step="1" value="0" oninput="sanitizeIntegerInput(this); qcagEditItemsMaybeValidate()" />
            </label>
          </div>
          
          <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
            <label style="display:flex;gap:8px;align-items:center;">Khảo sát
              <button id="qcagEditItemSurveyToggle" type="button" class="toggle-switch bg-gray-300 rounded-full p-0.5 relative" aria-pressed="false">
                <div class="toggle-slider w-5 h-5 bg-white rounded-full shadow"></div>
              </button>
            </label>
            <label style="display:flex;gap:8px;align-items:center;">Kích thước cũ
              <button id="qcagEditItemUseOldSizeToggle" type="button" class="toggle-switch bg-gray-300 rounded-full p-0.5 relative" aria-pressed="false">
                <div class="toggle-slider w-5 h-5 bg-white rounded-full shadow"></div>
              </button>
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

  const previousBrand = brandEl.value || '';
  const actionEl = document.getElementById('qcagEditItemAction');
  const previousAction = actionEl ? (actionEl.value || '') : '';

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
  if (brands.includes(previousBrand)) {
    brandEl.value = previousBrand;
  } else if (brands.length === 1) {
    brandEl.value = brands[0];
  } else {
    brandEl.value = '';
  }

  // Hide action for Logo types (logos don't require an action)
  try {
    if (actionEl) {
      const actionLabel = actionEl.parentElement;
      const isLogoType = String(selectedType || '').toLowerCase().includes('logo') || String(selectedType || '').toLowerCase().includes('emblemd');
      const validActions = isLogoType ? ["Làm mới", "Sửa chữa"] : ["Làm mới", "Thay bạt"];
      if (isLogoType) {
        actionEl.innerHTML = `<option value="">Chọn hình thức</option><option value="Làm mới">Làm mới</option><option value="Sửa chữa">Sửa chữa</option>`;
        if (actionLabel) actionLabel.style.display = '';
      } else {
        actionEl.innerHTML = `<option value="">Chọn hình thức</option><option value="Làm mới">Làm mới</option><option value="Thay bạt">Thay bạt</option>`;
        if (actionLabel) actionLabel.style.display = '';
      }
      if (validActions.includes(previousAction)) {
        actionEl.value = previousAction;
      } else {
        actionEl.value = '';
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
  const sBtn = document.getElementById('qcagEditItemSurveyToggle');
  const uBtn = document.getElementById('qcagEditItemUseOldSizeToggle');
  const survey = type === 'Hạng mục khác' ? false : !!(sBtn && sBtn.classList.contains('toggle-on'));
  const useOldSize = !!(uBtn && uBtn.classList.contains('toggle-on'));
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
    useOldSize: useOldSize,
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
    // CRITICAL: Build MINIMAL PATCH — do NOT spread full req.
    // req.statusImages may be the list-endpoint placeholder '["..."]' which
    // would overwrite real hiện trạng GCS URLs in DB if sent as-is.
    const updated = {
      __backendId: req.__backendId,
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

    // Merge only changed fields — preserve existing statusImages/designImages in allRequests
    const idx = allRequests.findIndex(r => r.__backendId === updated.__backendId);
    if (idx !== -1) Object.assign(allRequests[idx], updated);
  }

  _qcagRequestsVersion += 1;
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

function qcagDesktopGetDisplayBadge(req) {
  if (!req) return { label: '', cls: '' };
  try {
    const statusBadge = qcagDesktopStatusBadge(req);
    const stdTags = Array.isArray(req.standardTags) ? req.standardTags : (assignStandardTags(req) || []);
    if (Array.isArray(stdTags) && stdTags.indexOf('Chờ khảo sát') !== -1) {
      return { label: 'Chờ khảo sát', cls: 'pending survey' };
    }
    return statusBadge;
  } catch (e) {
    return { label: '', cls: '' };
  }
}

function getQCAGDesktopVisibleRequests() {
  let list = (allRequests || []).slice();
  const hasSearch = !!_qcagDesktopSearchQuery;

  // Wrap items so we filter and sort based on the snapshot (if it's the active request),
  // but keep the actual updated object for rendering.
  let wrapped = list.map(r => {
    const sortKey = (r.__backendId === _qcagDesktopCurrentId && _qcagDesktopOpenRequestSnapshot)
      ? _qcagDesktopOpenRequestSnapshot
      : r;
    return { actual: r, sortKey };
  });

  // Apply status filter:
  if (!hasSearch && _qcagDesktopStatusFilter === 'done') {
    wrapped = wrapped.filter(w => {
      const r = w.sortKey;
      const status = String(r.status || 'pending').toLowerCase();
      const isDone = status === 'done' || status === 'processed';
      if (!isDone) return false;
      if (String(r.type || '').toLowerCase() === 'warranty') return true;
      const designImgs = qcagDesktopParseJson(r.designImages, []);
      const hasMq = Array.isArray(designImgs) && designImgs.length > 0;
      const hasEditRequest = qcagDesktopIsPendingEditRequest(r);
      return hasMq && !hasEditRequest;
    });
  }

  // Only show requests based on the active tab (type) and processing rules
  if (!hasSearch && _qcagDesktopFilterType === 'new') {
    wrapped = wrapped.filter(w => {
      const r = w.sortKey;
      const typeMatch = String(r.type || '').toLowerCase() === 'new';
      if (!typeMatch) return false;
      if (_qcagDesktopStatusFilter === 'done') return true;
      const status = String(r.status || 'pending').toLowerCase();
      const isDone = status === 'done' || status === 'processed';
      const designImgs = qcagDesktopParseJson(r.designImages, []);
      const needsMq = designImgs.length === 0;
      const needsEdit = qcagDesktopIsPendingEditRequest(r);
      const hasDesignAwaitingConfirm = Array.isArray(designImgs) && designImgs.length > 0 && !isDone;
      return needsEdit || needsMq || hasDesignAwaitingConfirm;
    });
  } else if (!hasSearch && _qcagDesktopFilterType === 'warranty') {
    wrapped = wrapped.filter(w => {
      const r = w.sortKey;
      const t = String(r.type || '').toLowerCase();
      if (t !== 'warranty') return false;
      if (_qcagDesktopStatusFilter === 'done') return true;
      const status = String(r.status || 'pending').toLowerCase();
      const isDone = status === 'done' || status === 'processed';
      return !isDone;
    });
  }

  // Filter by region (support tokens like S4 -> 'South 4', MOT8 -> 'Modern On Team 8')
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
    wrapped = wrapped.filter(w => {
      const r = w.sortKey;
      const requester = qcagDesktopParseJson(r.requester, {});
      const regionRaw = String(requester.region || r.region || '');
      return pattern.test(regionRaw);
    });
  }

  if (_qcagDesktopSearchQuery) {
    const q = _qcagDesktopSearchQuery;
    wrapped = wrapped.filter(w => {
      const r = w.sortKey;
      const requester = qcagDesktopParseJson(r.requester, {});
      return String(r.tkCode || '').toLowerCase().includes(q) ||
        String(requester.saleName || requester.saleCode || requester.phone || '').toLowerCase().includes(q) ||
        String(requester.ssName || '').toLowerCase().includes(q) ||
        String(r.outletName || '').toLowerCase().includes(q) ||
        String(r.outletCode || '').toLowerCase().includes(q) ||
        String(r.designFilename || '').toLowerCase().includes(q);
    });
  }

  if (_qcagDesktopYearFilter !== null && !_qcagDesktopSearchQuery) {
    wrapped = wrapped.filter(w => {
      const r = w.sortKey;
      try { return new Date(r.createdAt || 0).getFullYear() === _qcagDesktopYearFilter; }
      catch (e) { return true; }
    });
  }

  if (_qcagDesktopSortMode === 'sale') {
    wrapped.sort((wa, wb) => {
      const a = wa.sortKey;
      const b = wb.sortKey;
      const ra = qcagDesktopParseJson(a.requester, {});
      const rb = qcagDesktopParseJson(b.requester, {});
      const na = String(ra.saleName || ra.phone || '').toLowerCase();
      const nb = String(rb.saleName || rb.phone || '').toLowerCase();
      return na.localeCompare(nb, 'vi');
    });
  } else if (_qcagDesktopSortMode === 'tag') {
    wrapped.sort((wa, wb) => {
      const a = wa.sortKey;
      const b = wb.sortKey;
      const badgeA = qcagDesktopGetDisplayBadge(a);
      const badgeB = qcagDesktopGetDisplayBadge(b);
      const ta = (badgeA && badgeA.label) || '';
      const tb = (badgeB && badgeB.label) || '';
      if (ta !== tb) return ta.localeCompare(tb, 'vi');
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      return timeB - timeA;
    });
  } else {
    wrapped.sort((wa, wb) => {
      const a = wa.sortKey;
      const b = wb.sortKey;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
  }

  const result = wrapped.map(w => w.actual);
  // Enrich each request with standardized tags (non-destructive)
  try {
    const enriched = result.map(r => ({ ...r, standardTags: assignStandardTags(r) }));
    return enriched;
  } catch (e) {
    return result;
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
  qcagDesktopScheduleBackgroundWarmup();

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
      // Exclude items that were pulled back to processing by an edit request.
      // Warranty requests are considered done when status is done/processed
      // even if they don't have MQ images.
      const hasEditRequest = qcagDesktopIsPendingEditRequest(r);
      if (t === 'warranty') return isDone && !hasEditRequest;
      const designImgs = qcagDesktopParseJson(r.designImages, []);
      const hasMq = Array.isArray(designImgs) && designImgs.length > 0;
      return isDone && hasMq && !hasEditRequest;
    }

    return true;
  }

  const newCount = list.filter(r => matchesStatusForType(r, 'new')).length;
  const warrantyCount = list.filter(r => matchesStatusForType(r, 'warranty')).length;
  // Compute processing vs done counts for the top-left status tabs
  const processingCount = list.filter(r => {
    try {
      const t = String(r.type || '').toLowerCase();
      const status = String(r.status || 'pending').toLowerCase();
      const isDone = status === 'done' || status === 'processed';
      if (t === 'new') {
        const designImgs = qcagDesktopParseJson(r.designImages, []);
        const needsMq = designImgs.length === 0;
        const needsEdit = qcagDesktopIsPendingEditRequest(r);
        const hasDesignAwaitingConfirm = Array.isArray(designImgs) && designImgs.length > 0 && !isDone;
        return needsEdit || needsMq || hasDesignAwaitingConfirm;
      }
      return !isDone;
    } catch (e) { return false; }
  }).length;
  const doneCount = list.filter(r => {
    try {
      const t = String(r.type || '').toLowerCase();
      const status = String(r.status || 'pending').toLowerCase();
      const isDone = status === 'done' || status === 'processed';
      if (t === 'new') {
        if (!isDone) return false;
        const designImgs = qcagDesktopParseJson(r.designImages, []);
        const hasMq = Array.isArray(designImgs) && designImgs.length > 0;
        const hasEditRequest = qcagDesktopIsPendingEditRequest(r);
        return hasMq && !hasEditRequest;
      }
      return isDone;
    } catch (e) { return false; }
  }).length;
  // Also compute pending warranty (non-done) to use for alerting the tab
  const pendingWarrantyCount = list.filter(r => {
    try {
      const t = String(r.type || '').toLowerCase();
      if (t !== 'warranty') return false;
      const status = String(r.status || 'pending').toLowerCase();
      return !(status === 'done' || status === 'processed');
    } catch (e) { return false; }
  }).length;

  const newSpan = document.getElementById('qcagNewCount');
  const warrantySpan = document.getElementById('qcagWarrantyCount');
  const procSpan = document.getElementById('qcagProcessingCount');
  const doneSpan = document.getElementById('qcagDoneCount');
  if (newSpan) newSpan.textContent = String(newCount);
  if (warrantySpan) {
    warrantySpan.textContent = String(warrantyCount);
    // Blink only when there are pending warranties and we're not viewing the 'done' tab
    const showBlink = (pendingWarrantyCount > 0) && (_qcagDesktopStatusFilter !== 'done');
    warrantySpan.classList.toggle('qcag-blink', !!showBlink);
  }
  if (procSpan) procSpan.textContent = String(processingCount);
  if (doneSpan) doneSpan.textContent = String(doneCount);
  // Add visual alert to the Warranty tab when there are pending warranties
  try {
    const warrantyBtn = document.getElementById('qcagFilterWarranty');
    if (warrantyBtn) {
      // Only show the red outline alert when there are pending warranties AND
      // the current status filter isn't 'done' — the 'Hoàn thành' view stays normal.
      warrantyBtn.classList.toggle('qcag-filter-alert', (pendingWarrantyCount > 0) && (_qcagDesktopStatusFilter !== 'done'));
    }
  } catch (e) {}
}

// Debug helper: inject a single pending warranty request for UI testing.
function qcagDesktopAddTestPendingWarranty() {
  try {
    if (typeof allRequests === 'undefined' || !Array.isArray(allRequests)) return null;
    // avoid duplicating test entries on repeated calls
    const existing = allRequests.find(r => String(r.__backendId || '').startsWith('test-warranty-'));
    if (existing) return existing;

    const id = 'test-warranty-' + Date.now();
    const req = {
      __backendId: id,
      code: id,
      type: 'warranty',
      status: 'pending',
      createdAt: new Date().toISOString(),
      sale: 'TEST SALE',
      ss: 'TEST SS',
      se: 'TEST SE',
      outlet_name: 'TEST OUTLET',
      items: JSON.stringify([{ name: 'Test Warranty Item', quantity: 1, width: 100, height: 200 }]),
      designImages: JSON.stringify([]),
      comments: JSON.stringify([])
    };

    // insert at the front so it's visible immediately
    allRequests.unshift(req);
    _qcagRequestsVersion = (_qcagRequestsVersion || 0) + 1;
    try { qcagDesktopCacheRequest(req); } catch (e) {}
    try { renderQCAGDesktopList(); } catch (e) {}
    try { qcagDesktopUpdateFilterCounts(); } catch (e) {}
    try { if (typeof showToast === 'function') showToast('✓ Đã thêm yêu cầu bảo hành thử (pending).'); } catch (e) {}
    return req;
  } catch (e) { return null; }
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

  listEl.innerHTML = requests.map(req => {
    const statusBadge = qcagDesktopStatusBadge(req);
    const activeCls = req.__backendId === _qcagDesktopCurrentId ? 'active' : '';
    const dateStr = req.createdAt ? new Date(req.createdAt).toLocaleString('vi-VN') : '';
    const requester = qcagDesktopParseJson(req.requester, {});
      const saleName = (requester.saleName || requester.phone || '-').toUpperCase();
    const region = requester.region || '-';
    const requestCode = req.tkCode || '-'; // Sử dụng tkCode từ server trả về

    const stdTags = Array.isArray(req.standardTags) ? req.standardTags : (assignStandardTags(req) || []);

    const displayBadge = qcagDesktopGetDisplayBadge(req);

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
          <div class="qcag-request-name">${escapeHtml(String(req.outletName || '-').toUpperCase())} • ${escapeHtml(req.outletCode || '-')}</div>
          <span class="qcag-status-badge ${displayBadge.cls}">${displayBadge.label}</span>
        </div>
        <div class="qcag-request-code"><span class="qcag-sale-name-highlight">${escapeHtml(String(saleName || '-').toUpperCase())}</span> • ${escapeHtml(region)}</div>
        <div class="qcag-request-ss">${(() => { const ss = (requester && requester.ssName) || ''; return ss && ss !== '-' ? 'Tên SS/SE: ' + escapeHtml(String(ss).toUpperCase()) : '<span class="qcag-ss-tba">Chức vụ TBA</span>'; })()}</div>
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
function _qcagDeleteWithReasonDialog(message) {
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
    const inputBg    = isDark ? '#1e293b' : '#f9fafb';
    const inputBdr   = isDark ? 'rgba(255,255,255,0.12)' : '#e5e7eb';
    overlay.innerHTML =
      `<div style="background:${cardBg};border:1px solid ${cardBorder};border-radius:16px;padding:24px 20px 20px;max-width:440px;width:88%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.4)">` +
        `<div style="width:48px;height:48px;border-radius:12px;background:rgba(239,68,68,0.12);display:flex;align-items:center;justify-content:center;margin:0 auto 14px">` +
          `<svg width="22" height="22" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>` +
        `</div>` +
        `<p style="margin-bottom:6px;font-size:15px;font-weight:600;color:${textColor};line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${message}</p>` +
        `<p style="margin-bottom:12px;font-size:12px;color:${subColor}">Vui lòng nhập lý do xóa để thông báo cho Sale.</p>` +
        `<textarea id="_qcagDelReasonInput" placeholder="Nhập lý do xóa (bắt buộc)..." rows="3" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;background:${inputBg};border:1px solid ${inputBdr};color:${textColor};font-size:13px;resize:none;margin-bottom:12px;outline:none;font-family:inherit"></textarea>` +
        `<div style="display:flex;gap:8px">` +
          `<button id="_qcagCancelBtn" style="flex:1;padding:11px;border-radius:10px;background:${cancelBg};border:${cancelBdr};cursor:pointer;font-size:14px;font-weight:500;color:${cancelClr}">Hủy</button>` +
          `<button id="_qcagConfirmBtn" style="flex:1;padding:11px;border-radius:10px;background:#ef4444;color:#fff;border:none;cursor:pointer;font-size:14px;font-weight:600">Xóa</button>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(overlay);
    const cleanup = (result, reason) => { document.body.removeChild(overlay); resolve({ confirmed: result, reason: reason || '' }); };
    overlay.querySelector('#_qcagConfirmBtn').onclick = () => {
      const reasonInput = overlay.querySelector('#_qcagDelReasonInput');
      const reason = (reasonInput ? reasonInput.value : '').trim();
      if (!reason) {
        if (reasonInput) { reasonInput.style.borderColor = '#ef4444'; reasonInput.focus(); }
        return;
      }
      cleanup(true, reason);
    };
    overlay.querySelector('#_qcagCancelBtn').onclick  = () => cleanup(false, '');
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false, ''); };
  });
}

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

// Custom Delete Reason Dialog
function _qcagDeleteReasonDialog(message) {
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
    const textareaBg = isDark ? '#1e293b' : '#f9fafb';
    const textareaBdr= isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #e5e7eb';

    overlay.innerHTML =
      `<div style="background:${cardBg};border:1px solid ${cardBorder};border-radius:16px;padding:24px 20px 20px;max-width:440px;width:88%;box-shadow:0 20px 60px rgba(0,0,0,0.4)">` +
        `<div style="width:48px;height:48px;border-radius:12px;background:rgba(239,68,68,0.12);display:flex;align-items:center;justify-content:center;margin:0 auto 14px">` +
          `<svg width="22" height="22" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>` +
        `</div>` +
        `<p style="margin-bottom:6px;font-size:15px;font-weight:600;color:${textColor};text-align:center;line-height:1.2">${message}</p>` +
        `<p style="margin-bottom:14px;font-size:12px;color:${subColor};text-align:center">Hành động này không thể hoàn tác. Vui lòng ghi rõ lý do xóa:</p>` +
        `<div style="margin-bottom:18px">` +
          `<textarea id="_qcagDeleteReasonInput" rows="3" style="width:100%;padding:10px;border-radius:8px;background:${textareaBg};border:${textareaBdr};color:${textColor};font-size:14px;resize:none" placeholder="Nhập lý do xóa yêu cầu..."></textarea>` +
        `</div>` +
        `<div style="display:flex;gap:8px">` +
          `<button id="_qcagCancelBtn" style="flex:1;padding:11px;border-radius:10px;background:${cancelBg};border:${cancelBdr};cursor:pointer;font-size:14px;font-weight:500;color:${cancelClr}">Hủy</button>` +
          `<button id="_qcagConfirmBtn" style="flex:1;padding:11px;border-radius:10px;background:#ef4444;color:#fff;border:none;cursor:pointer;font-size:14px;font-weight:600">Xóa</button>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#_qcagDeleteReasonInput').focus();

    const cleanup = (result) => { document.body.removeChild(overlay); resolve(result); };
    overlay.querySelector('#_qcagConfirmBtn').onclick = () => {
      const reason = overlay.querySelector('#_qcagDeleteReasonInput').value.trim();
      if (!reason) {
        showToast('Vui lòng nhập lý do xóa');
        return;
      }
      cleanup(reason);
    };
    overlay.querySelector('#_qcagCancelBtn').onclick  = () => cleanup(null);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };
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
    const { confirmed, reason } = await _qcagDeleteWithReasonDialog('Bạn có chắc muốn xóa yêu cầu này?');
    if (!confirmed) return;

    if (window.dataSdk && typeof window.dataSdk.delete === 'function') {
      const res = await window.dataSdk.delete(req, reason);
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

    // Lưu log xóa vào localStorage và gửi push notification cho Sale
    try {
      const reqObj = (() => { try { return JSON.parse(req.requester || '{}'); } catch (_) { return {}; } })();
      const saleCode = reqObj.saleCode || null;
      const outletLabel = req.outletName || req.outletCode || 'Outlet';
      if (saleCode) {
        const logKey = 'ks_qcag_del_log_' + saleCode;
        let delLog = [];
        try { delLog = JSON.parse(localStorage.getItem(logKey) || '[]'); } catch (_) { delLog = []; }
        delLog.unshift({ outletName: req.outletName || '-', outletCode: req.outletCode || '-', reason: reason, deletedAt: new Date().toISOString() });
        if (delLog.length > 30) delLog = delLog.slice(0, 30);
        localStorage.setItem(logKey, JSON.stringify(delLog));
      }
      if (typeof sendPushNotification === 'function') {
        sendPushNotification({
          title: 'Yêu cầu đã bị xóa',
          body: outletLabel + ' — Lý do: ' + reason,
          phone: reqObj.phone || null,
          saleCode: saleCode,
          data: { type: 'qcag_deleted', backendId: backendId }
        });
      }
    } catch (e) { /* non-fatal */ }

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
    // Build a SLIM patch: strip image fields that were not intentionally changed.
    // Many callers do `{ ...currentDetailRequest, [changedField]: newVal }` which
    // spreads all image fields unchanged. If those image fields hold the
    // list-endpoint placeholder '["..."]', sending them would overwrite real
    // GCS URLs in the database.
    //
    // Rule: remove an image field from the patch if its value is IDENTICAL to
    // the corresponding field on currentDetailRequest (i.e. the caller just
    // spread it in — it wasn't a deliberate change). Also strip any value that
    // is a sentinel placeholder regardless of origin.
    const IMAGE_FIELDS = ['statusImages', 'designImages', 'acceptanceImages', 'oldContentImages'];
    const PLACEHOLDER_RE = /^\[["']\.+["']\]$/;  // matches ["..."], ["...."], etc.
    const patchToSend = Object.assign({}, updated);
    for (const field of IMAGE_FIELDS) {
      if (!(field in patchToSend)) continue;
      const v = String(patchToSend[field] == null ? '' : patchToSend[field]);
      // Strip if it's a placeholder sentinel
      if (PLACEHOLDER_RE.test(v)) { delete patchToSend[field]; continue; }
      // Strip if the value is unchanged from currentDetailRequest (was just spread in)
      if (currentDetailRequest && patchToSend[field] === currentDetailRequest[field]) {
        delete patchToSend[field];
      }
    }
    const result = await window.dataSdk.update(patchToSend);
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

  const prevCached = _qcagDesktopFullRequestCache[updated.__backendId];
  const prevAll = allRequests.find(r => r.__backendId === updated.__backendId);
  const prevCurrent = (currentDetailRequest && currentDetailRequest.__backendId === updated.__backendId)
    ? currentDetailRequest
    : null;
  const prevBest = prevCached || prevCurrent || prevAll || null;
  const localUpdated = qcagDesktopMergePreserveImageFields(updated, prevBest);

  const idxAll = allRequests.findIndex(r => r.__backendId === updated.__backendId);
  if (idxAll !== -1) allRequests[idxAll] = localUpdated;
  currentDetailRequest = localUpdated;
  qcagDesktopCacheRequest(localUpdated);

  if (successMsg) showToast(successMsg);

  _qcagRequestsVersion += 1;
  _qcagRequestCodeCache.version = 0;

  if (!skipRerender) _qcagDesktopInPlaceRefresh(localUpdated);
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

  // 2. Refresh comment timeline & badge
  const timeline = document.getElementById('qcagCommentTimeline');
  const comments = qcagDesktopParseJson(updatedRequest.comments, []);
  if (timeline) {
    timeline.innerHTML = comments.length > 0
      ? comments.map((c, idx) => qcagDesktopCommentHtml(c, comments, idx)).join('')
      : '<div class="qcag-detail-muted">Chưa có bình luận</div>';
    setTimeout(() => { if (timeline) timeline.scrollTop = timeline.scrollHeight; }, 30);
  }

  const expandTab = document.getElementById('qcagExpandCommentsTab');
  if (expandTab) {
    expandTab.innerHTML = `
      ${comments.length > 0 ? `<span class="qcag-comments-count-badge">${comments.length}</span>` : ''}
      <span class="qcag-expand-comments-tab-label">Bình luận ▸</span>
    `;
  }

  // 3. Refresh MQ preview + complete button
  qcagDesktopRefreshMQInPlace(updatedRequest);

  // 4. Refresh old designs section for this outlet
  if (updatedRequest.__backendId) {
    qcagDesktopRefreshOldDesignSection(updatedRequest.__backendId);
  }

  // 5. Refresh sidebar request list
  renderQCAGDesktopList();
}

// ── In-place MQ section refresh (no scroll jump) ─────────────────────
function qcagDesktopRefreshMQInPlace(updatedRequest) {
  const _isWarrantyRefresh = String((updatedRequest && updatedRequest.type) || '').toLowerCase() === 'warranty';
  const designImgs = _isWarrantyRefresh
    ? qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(updatedRequest.acceptanceImages, []))
    : qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(updatedRequest.designImages, []));

  // Update filename title in-place
  const filenameEl = document.getElementById('qcagMQFilenameTitle');
  if (filenameEl) {
    if (!_isWarrantyRefresh && updatedRequest && updatedRequest.designFilename) {
      const cleanName = updatedRequest.designFilename.replace(/\.[^/.]+$/, "");
      filenameEl.textContent = `(${cleanName})`;
    } else {
      filenameEl.textContent = '';
    }
  }

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
  return items.some(item => {
    if (!item) return false;
    if (item.type === 'Hạng mục khác') return false;
    return item.survey && (!item.surveySize || !item.surveySize.width || !item.surveySize.height);
  });
}

function qcagDesktopBuildItemsHtml(items, canManageItems = false) {
  if (!items.length) return '<div class="qcag-detail-muted">Không có hạng mục</div>';
  return `
    <div class="qcag-items-table">
          <div class="qcag-items-head">
            <div>STT</div><div>Loại bảng hiệu</div><div>Hình thức</div><div>Brand</div><div>Kích thước</div><div>Số trụ</div><div>Yêu cầu</div><div></div>
          </div>
      ${items.map((item, idx) => {
        // Decide type color class for desktop QCAG view
        let typeClass = '';
        try {
          const tt = String(item.type || '').toLowerCase();
          // Prefer classifying as Bảng if the string contains 'bảng'
          if (tt.includes('bảng')) typeClass = 'qcag-type-bang';
          else if (tt.includes('hộp đèn') || tt.includes('hộp') || tt.includes('hop')) typeClass = 'qcag-type-hopden';
          else if (tt.includes('logo')) typeClass = 'qcag-type-logo';
        } catch (e) { typeClass = ''; }
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
        let brandClass = 'brand-default';
        try {
          const bb = String(item.brand || '').toLowerCase().trim();
          if (bb.indexOf('heineken') !== -1) brandClass = 'brand-heineken';
          else if (bb.indexOf('tiger') !== -1) brandClass = 'brand-tiger';
          else if (bb.indexOf('bivina') !== -1) brandClass = 'brand-bivina';
          else if (bb.indexOf('bia việt') !== -1 || bb.indexOf('bia viet') !== -1) brandClass = 'brand-biaviet';
          else if (bb.indexOf('larue') !== -1) brandClass = 'brand-larue';
          else if (bb.indexOf('strongbow') !== -1) brandClass = 'brand-strongbow';
          else if (bb.indexOf('shopname') !== -1) brandClass = 'brand-shopname';
        } catch (e) {}

        const badgesHtml = `${brandBadge}${addedBadgeHtml}${editedBadgeHtml}`;
        return `<div class="qcag-items-row"><div class="qcag-stt-cell"><div class="qcag-stt-num">${idx + 1}</div><div class="qcag-stt-badges">${badgesHtml}</div></div><div class="qcag-item-type ${typeClass}">${escapeHtml(item.type || '-')}</div><div>${escapeHtml(item.action || '-')}</div><div><span class="qcag-brand-badge ${brandClass}">${escapeHtml(item.brand || '-')}</span></div><div>${sizeHtml}${sizeExtraNote}</div><div>${escapeHtml(poles)}</div><div>${escapeHtml(requestText)}</div>${actionCell}</div>`;
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
  });

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      qcagDesktopSendComment();
    }
  });
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

var _qcagDesktopOutletOldDesignCache = {};
var _qcagDesktopOutletOldDesignFetching = {};

function extractDesignImagesFromReq(r) {
  if (!r) return [];
  const src = (typeof _qcagDesktopFullRequestCache !== 'undefined' && r.__backendId && _qcagDesktopFullRequestCache[r.__backendId]) || r;
  const raw = src.designImages || src.design_images || src.mqImages || src.mq_images;
  const parsed = qcagDesktopParseJson(raw, []);
  if (Array.isArray(parsed)) return parsed;
  return [];
}

function isCandidatePastDesign(r, currentId, targetOutletCode) {
  if (!r) return false;
  const reqId = r.__backendId || r.id;
  if (reqId === currentId) return false;
  
  const rOutlet = String(r.outletCode || r.outlet_code || '').trim().toLowerCase();
  if (!rOutlet || rOutlet === 'new outlet' || rOutlet !== targetOutletCode) return false;

  const st = String(r.status || r.qcagStatus || r.qcag_status || '').toLowerCase();
  const isDoneStatus = (st === 'done' || st === 'processed' || st === 'completed' || st === 'hoan_thanh' || st === 'approved' || r.isDone || r.is_done);
  
  const imgs = extractDesignImagesFromReq(r);
  const hasImages = imgs.length > 0;

  return isDoneStatus || hasImages;
}

function ksGetOldDesignsForOutlet(currentReq) {
  if (!currentReq) return [];
  const outletCode = String(currentReq.outletCode || currentReq.outlet_code || '').trim().toLowerCase();
  if (!outletCode || outletCode === 'new outlet') return [];
  const currentId = currentReq.__backendId || currentReq.id;

  const candidateMap = {};

  // Add items from allRequests
  (allRequests || []).forEach(r => {
    if (isCandidatePastDesign(r, currentId, outletCode)) {
      candidateMap[r.__backendId || r.id] = r;
    }
  });

  // Add items from outlet API cache
  if (_qcagDesktopOutletOldDesignCache[outletCode]) {
    _qcagDesktopOutletOldDesignCache[outletCode].forEach(r => {
      if (isCandidatePastDesign(r, currentId, outletCode)) {
        const id = r.__backendId || r.id;
        if (!candidateMap[id]) candidateMap[id] = r;
      }
    });
  }

  // Trigger background fetch for this outletCode if not fetched yet
  if (!_qcagDesktopOutletOldDesignFetching[outletCode]) {
    _qcagDesktopOutletOldDesignFetching[outletCode] = true;
    try {
      var base = (typeof window !== 'undefined' && window.API_BASE_URL) ? String(window.API_BASE_URL).replace(/\/+$/, '') : '';
      fetch(base + '/api/ks/requests?outlet_code=' + encodeURIComponent(outletCode))
        .then(res => res.json())
        .then(json => {
          if (json && json.ok && Array.isArray(json.data)) {
            const validRows = json.data.filter(r => isCandidatePastDesign(r, currentId, outletCode));
            _qcagDesktopOutletOldDesignCache[outletCode] = validRows;
            validRows.forEach(dr => {
              const id = dr.__backendId || dr.id;
              if (id) {
                if (typeof qcagDesktopCacheRequest === 'function') qcagDesktopCacheRequest(dr);
                const idx = (allRequests || []).findIndex(x => (x.__backendId || x.id) === id);
                if (idx === -1) {
                  allRequests.push(dr);
                } else {
                  allRequests[idx] = Object.assign({}, allRequests[idx], dr);
                }
              }
            });
            if (currentDetailRequest && (currentDetailRequest.__backendId || currentDetailRequest.id) === currentId) {
              qcagDesktopRefreshOldDesignSection(currentId);
            }
          }
        })
        .catch(e => {
          console.warn('[ksGetOldDesignsForOutlet] fetch error:', e);
        });
    } catch (_) {}
  }

  const candidates = Object.values(candidateMap);

  // Pre-fetch any unfetched candidate requests in background so past design images appear automatically
  candidates.forEach(r => {
    const id = r.__backendId || r.id;
    if (id && typeof _qcagDesktopFullRequestCache !== 'undefined' && !_qcagDesktopFullRequestCache[id]) {
      if (typeof qcagDesktopGetFullRequest === 'function') {
        qcagDesktopGetFullRequest(id).then(full => {
          if (full && currentDetailRequest && (currentDetailRequest.__backendId || currentDetailRequest.id) === currentId) {
            qcagDesktopRefreshOldDesignSection(currentId);
          }
        }).catch(() => {});
      }
    }
  });

  return candidates
    .filter(r => {
      const imgs = extractDesignImagesFromReq(r);
      if (imgs.length === 1 && imgs[0] === '...') return true;
      return imgs.length > 0;
    })
    .sort((a, b) => new Date(b.createdAt || b.created_at || 0).getTime() - new Date(a.createdAt || a.created_at || 0).getTime());
}

function qcagDesktopRefreshOldDesignSection(currentId) {
  if (!currentDetailRequest || (currentDetailRequest.__backendId || currentDetailRequest.id) !== currentId) return;
  const section = document.getElementById('qcagOldDesignSection');
  if (!section) return;
  try {
    const oldList = ksGetOldDesignsForOutlet(currentDetailRequest);
    if (oldList.length === 0) {
      section.innerHTML = '<div class="qcag-detail-muted">Outlet này chưa có thiết kế nào hoàn thành</div>';
      return;
    }
    const codeMap = qcagDesktopComputeRequestCodes();
    section.innerHTML = qcagRenderOldDesignViewer(oldList[0], 0, oldList.length, codeMap);
  } catch (e) {
    console.error('qcagOldDesignSection refresh error', e);
  }
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
  const fullEntry = (_qcagDesktopFullRequestCache && (entry.__backendId || entry.id) && _qcagDesktopFullRequestCache[entry.__backendId || entry.id]) || entry;
  const designImgs = qcagDesktopPrepareRenderImageList(extractDesignImagesFromReq(fullEntry));
  const requester  = typeof fullEntry.requester === 'object' && fullEntry.requester ? fullEntry.requester : qcagDesktopParseJson(fullEntry.requester, {});
  const reqCode    = (codeMap && codeMap[entry.__backendId || entry.id]) || entry.tkCode || entry.tk_code || '-';
  const uploadedBy = fullEntry.designUploadedBy || fullEntry.design_uploaded_by || fullEntry.designCreatedBy || fullEntry.design_created_by || '-';
  const saleName   = (requester.saleName || requester.sale_name || fullEntry.saleName || fullEntry.sale_name || requester.phone || '-').toUpperCase();
  const requestTime = (fullEntry.createdAt || fullEntry.created_at) ? new Date(fullEntry.createdAt || fullEntry.created_at).toLocaleString('vi-VN') : '-';
  const uploadTime  = (fullEntry.designUpdatedAt || fullEntry.design_updated_at || fullEntry.updatedAt || fullEntry.updated_at) ? new Date(fullEntry.designUpdatedAt || fullEntry.design_updated_at || fullEntry.updatedAt || fullEntry.updated_at).toLocaleString('vi-VN') : '-';

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

async function openQCAGDesktopRequest(id, keepPendingComment, forceRerender) {
  if (!shouldUseQCAGDesktop()) return;

  // Avoid forcing image re-load when clicking the already selected item unless forceRerender is true.
  if (id && id === _qcagDesktopCurrentId && !forceRerender) {
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

  const isSameReq = _qcagDesktopCurrentId === id;
  _qcagDesktopCurrentId = id;
  currentDetailRequest = request;
  if (!isSameReq) {
    _qcagDesktopOpenRequestSnapshot = request ? JSON.parse(JSON.stringify(request)) : null;
  }
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

  const showCompleteBtn = _qcagDesktopStatusFilter !== 'done';
  const editBtn = `<button onclick="window._editRequestOrigin='desktop'; openEditRequestSheet();" class="qcag-desktop-edit-btn">Yêu cầu chỉnh sửa</button>`;

  detailEl.innerHTML = `
    <div class="qcag-detail-layout${_qcagCommentsCollapsed ? ' qcag-chat-collapsed' : ''}" id="qcagDetailLayout">
      <div class="qcag-detail-left">
        <div class="qcag-card">
          <div class="qcag-card-header">
            <div class="qcag-card-title">Thông tin người yêu cầu</div>
            <div class="qcag-request-time">${request.createdAt ? escapeHtml(new Date(request.createdAt).toLocaleString('vi-VN')) : '-'}</div>
          </div>
          <div class="qcag-requester-grid">
            <div><span>Tên Sale</span><strong>${escapeHtml(String(requester.saleName || requester.saleName || requester.phone || '-').toUpperCase())}</strong></div>
            <div><span>Mã Sale</span><strong>${escapeHtml(requester.saleCode || '-')}</strong></div>
            <div><span>SĐT Sale</span><strong>${escapeHtml(requester.phone || '-')}</strong></div>
            <div><span>Khu vực</span><strong>${escapeHtml(requester.region || '-')}</strong></div>
            <div><span>Tên SS/SE</span><strong>${escapeHtml(String(requester.ssName || requester.ssName || '-').toUpperCase())}</strong></div>
          </div>
        </div>

        <div class="qcag-card">
          <div class="qcag-card-title" style="display:flex;align-items:center;justify-content:space-between;">
            <span>Thông tin Outlet</span>
            <button type="button" class="qcag-edit-outlet-btn" onclick="qcagDesktopOpenEditOutletModal()" title="Chỉnh sửa thông tin Outlet"><svg class="qcag-icon-pencil" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Sửa thông tin</button>
          </div>
            <div class="qcag-outlet-grid">
            <div class="ot-first"><span>Tên Outlet:</span><strong>${escapeHtml(String(request.outletName || '-').toUpperCase())}</strong></div>
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
              <div class="qcag-card-title" style="display:flex;align-items:center;justify-content:space-between;">
                <span>Hiện trạng Outlet</span>
                ${editBtn}
              </div>
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
                        return `<div class="qcag-gallery-rep" onclick="showImageFull('${first}',false)"><img src="${first}" alt="hiện trạng" onerror="_imgBrokenFallback(this)"></div>`;
                      }
                      return `<div class="qcag-gallery-rep" onclick="qcagOpenGalleryEncoded('${enc}',0)"><img src="${first}" alt="hiện trạng" onerror="_imgBrokenFallback(this)"><div class="qcag-img-more">+${more}</div></div>`;
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
              <div class="qcag-card-title">${isWarranty ? 'Nghiệm thu bảo hành' : 'Upload MQ thiết kế'}<span id="qcagMQFilenameTitle" class="qcag-mq-filename text-xs font-normal text-gray-500 ml-2" style="color: #6b7280; font-size: 12px; font-weight: normal; margin-left: 8px;">${(!isWarranty && request.designFilename) ? `(${escapeHtml(request.designFilename.replace(/\.[^/.]+$/, ""))})` : ''}</span></div>
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
                    const isPendingEdit = qcagDesktopIsPendingEditRequest(request);
                    const reqStatus = String(request.status || '').toLowerCase();
                    const isDone = (reqStatus === 'done' || reqStatus === 'processed') && !isPendingEdit;

                    const showCompleteBtn = _qcagDesktopStatusFilter !== 'done';
                    const completeDisabled = isDone || designImgs.length === 0 || isSurveySizeIncomplete;
                    const completeTitle = isDone
                      ? 'Yêu cầu đã hoàn thành'
                      : (isSurveySizeIncomplete
                        ? 'Vui l\u00f2ng x\u00e1c nh\u1eadn k\u00edch th\u01b0\u1edbc kh\u1ea3o s\u00e1t tr\u01b0\u1edbc khi ho\u00e0n th\u00e0nh'
                        : (designImgs.length === 0 ? escapeHtml(completeBtnDisabledTitle) : ''));

                    const warning = isSurveySizeIncomplete
                      ? '<div class="qcag-survey-warning">Vui l\u00f2ng x\u00e1c nh\u1eadn k\u00edch th\u01b0\u1edbc kh\u1ea3o s\u00e1t tr\u01b0\u1edbc khi ho\u00e0n th\u00e0nh.</div>'
                      : '';

                    const finalBtnLabel = isDone ? 'Đã hoàn thành' : completeBtnLabel;
                    const btn = showCompleteBtn
                      ? `<button onclick="qcagDesktopMarkProcessed()" class="qcag-complete-btn${completeDisabled ? ' qcag-complete-btn--disabled' : ''}" ${completeDisabled ? `disabled title="${completeTitle}"` : ''}>${escapeHtml(finalBtnLabel)}</button>`
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
                  try {
                    _qcagOldDesignIdx = 0;
                    const oldList = ksGetOldDesignsForOutlet(request);
                    if (oldList.length === 0) return '<div class="qcag-detail-muted">Outlet này chưa có thiết kế nào hoàn thành</div>';
                    const codeMap = qcagDesktopComputeRequestCodes();
                    return qcagRenderOldDesignViewer(oldList[0], 0, oldList.length, codeMap);
                  } catch(e) {
                    console.error('qcagOldDesignSection render error', e);
                    return '<div class="qcag-detail-muted">Outlet này chưa có thiết kế nào hoàn thành</div>';
                  }
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
            statusThumbEl.innerHTML = `<div class="qcag-gallery-rep" onclick="showImageFull('${first}',false)"><img src="${first}" alt="hiện trạng" onerror="_imgBrokenFallback(this)"></div>`;
          } else {
            statusThumbEl.innerHTML = `<div class="qcag-gallery-rep" onclick="qcagOpenGalleryEncoded('${enc}',0)"><img src="${first}" alt="hiện trạng" onerror="_imgBrokenFallback(this)"><div class="qcag-img-more">+${newSImgs.length - 1}</div></div>`;
          }
        }
      }
      // Refresh MQ / design / acceptance images + complete button state
      qcagDesktopRefreshMQInPlace(full);
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

  // Capture request identity BEFORE any await — prevents saving to the wrong
  // request (e.g. TKy) if the user switches away from TKx while the async
  // compress/upload is still in flight.
  const targetRequest = currentDetailRequest;
  const targetId = targetRequest.__backendId;

  // If statusImages is still the list-endpoint placeholder '["..."]', fetch the real
  // GCS URLs from the server first to avoid losing existing hiện trạng photos.
  let baseStatusImages = targetRequest.statusImages;
  if (baseStatusImages === '["..."]' && window.dataSdk && typeof window.dataSdk.getOne === 'function') {
    try {
      const r = await window.dataSdk.getOne(targetId);
      if (r && r.isOk && r.data && r.data.statusImages && r.data.statusImages !== '["..."]' && r.data.statusImages !== '[]') {
        baseStatusImages = r.data.statusImages;
        // Update local store with real value so subsequent renders are correct
        const bsIdx = allRequests.findIndex(x => x.__backendId === targetId);
        if (bsIdx !== -1) allRequests[bsIdx] = Object.assign({}, allRequests[bsIdx], { statusImages: baseStatusImages });
      }
    } catch (e) { /* proceed with existing data */ }
  }
  const currentImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(baseStatusImages, [])).slice();

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
    if (window.dataSdk && window.dataSdk.uploadImage && targetId) {
      try {
        const uploaded = await window.dataSdk.uploadImage(
          dataUrl, file.name || 'status.jpg', targetId, 'hien-trang'
        );
        if (typeof uploaded === 'string' && uploaded.trim()) {
          imageUrl = uploaded.trim();
        }
      } catch (e) { /* keep base64 fallback */ }
    }
    currentImgs.push(imageUrl);
  }

  // Spread targetRequest for all non-image fields, override statusImages with the
  // correct up-to-date list (real existing URLs + newly uploaded).
  // Drop designImages/acceptanceImages if they are still the list-endpoint
  // placeholder so they are NOT sent to PATCH and do not clear real DB values.
  const updated = { ...targetRequest, statusImages: JSON.stringify(currentImgs), updatedAt: new Date().toISOString() };
  if (updated.designImages === '["..."]') delete updated.designImages;
  if (updated.acceptanceImages === '["..."]') delete updated.acceptanceImages;
  const ok = await qcagDesktopPersistRequest(updated, 'Đã thêm ảnh hiện trạng', true);
  if (ok) {
    // Only update the UI section for the request that was active when upload started.
    // If the user has navigated to a different request, skip the DOM update entirely.
    if (_qcagDesktopCurrentId !== targetId) return;
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
          thumbGrid.innerHTML = `<div class="qcag-gallery-rep" onclick="showImageFull('${first}',false)"><img src="${first}" alt="hiện trạng" onerror="_imgBrokenFallback(this)"></div>`;
        } else {
          thumbGrid.innerHTML = `<div class="qcag-gallery-rep" onclick="qcagOpenGalleryEncoded('${enc}',0)"><img src="${first}" alt="hiện trạng" onerror="_imgBrokenFallback(this)"><div class="qcag-img-more">+${more}</div></div>`;
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

  // Capture request identity BEFORE any await — prevents saving to the wrong
  // request if the user switches to a different TK while async compression is in progress.
  const targetRequest = currentDetailRequest;
  const targetId = targetRequest.__backendId;

  // Compress immediately (WebP preferred) — much faster upload
  let dataUrl;
  try {
    dataUrl = await _compressImageFile(file, 2048, 0.92);
  } catch (_) {
    dataUrl = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
  }

  // Guard: if the user navigated to a different request during compression, abort.
  if (_qcagDesktopCurrentId !== targetId) return;

  const isWarrantyReq = String((targetRequest.type || '')).toLowerCase() === 'warranty';

  if (isWarrantyReq) {
    // Warranty type: upload to GCS immediately and append to acceptanceImages.
    let imageUrl = dataUrl;
    if (window.dataSdk && window.dataSdk.uploadImage && targetId) {
      showToast('Đang upload ảnh nghiệm thu...');
      try {
        const uploaded = await window.dataSdk.uploadImage(
          dataUrl, file.name || 'accept.jpg', targetId, 'nghiem-thu'
        );
        if (typeof uploaded === 'string' && uploaded.trim()) {
          imageUrl = qcagDesktopNormalizeImageUrl(uploaded);
        } else if (uploaded && typeof uploaded.url === 'string' && uploaded.url.trim()) {
          imageUrl = qcagDesktopNormalizeImageUrl(uploaded.url);
        }
      } catch (e) {
        console.warn('[qcagDesktopUploadMQ] GCS upload failed for acceptance, keeping base64:', e);
      }
    }
    // Guard after GCS upload await too
    if (_qcagDesktopCurrentId !== targetId) return;
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

  // Normal MQ flow:
  // Store compressed image as base64 only — GCS upload is DEFERRED to the
  // "Hoàn thành" / "Đã chỉnh sửa" confirm step (qcagDesktopMarkProcessed).
  // This ensures the user sees the image under the "chờ xác nhận" (processing)
  // tag first, and GCS storage only happens when they explicitly confirm.
  const isPendingEdit = qcagDesktopIsPendingEditRequest(currentDetailRequest);

  const updated = {
    ...currentDetailRequest,
    designImages: JSON.stringify([dataUrl]),
    designFilename: file.name,
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

  const ok = await qcagDesktopPersistRequest(updated, 'Đã tải MQ lên — nhấn "Hoàn thành" để xác nhận và lưu lên cloud', true);
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

  // ── Upload any still-base64 MQ images to GCS before finalizing ──────────
  // qcagDesktopUploadMQ defers GCS storage to this point so the user sees the
  // image under the "chờ xác nhận" (processing) state first.
  // On "Hoàn thành", we upload to GCS, replace the base64 with a GCS URL,
  // then persist status = 'done'.
  const _confirmBackendId = currentDetailRequest.__backendId;
  let finalDesignImages = designImgs.slice();
  if (finalDesignImages.some(img => typeof img === 'string' && img.startsWith('data:'))
      && window.dataSdk && window.dataSdk.uploadImage && _confirmBackendId) {
    showToast('Đang lưu MQ lên cloud...');
    const mqSubfolder = 'mq-' + String(currentDetailRequest.outletCode || 'OUTLET')
      .replace(/[^a-zA-Z0-9]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 32);
    const uploadedImgs = [];
    for (const img of finalDesignImages) {
      if (typeof img === 'string' && img.startsWith('data:')) {
        try {
          const uploaded = await window.dataSdk.uploadImage(img, 'mq.jpg', _confirmBackendId, mqSubfolder);
          if (typeof uploaded === 'string' && uploaded.trim()) {
            uploadedImgs.push(qcagDesktopNormalizeImageUrl(uploaded));
          } else if (uploaded && typeof uploaded.url === 'string' && uploaded.url.trim()) {
            uploadedImgs.push(qcagDesktopNormalizeImageUrl(uploaded.url));
          } else {
            uploadedImgs.push(img); // fallback: upload returned nothing useful
          }
        } catch (e) {
          console.warn('[qcagDesktopMarkProcessed] GCS upload failed, keeping base64:', e);
          uploadedImgs.push(img);
        }
      } else {
        uploadedImgs.push(img); // already a GCS URL — keep as-is
      }
    }
    finalDesignImages = uploadedImgs;
    // Guard: if the user switched to a different request during GCS upload, abort.
    if (!currentDetailRequest || currentDetailRequest.__backendId !== _confirmBackendId) {
      showToast('Đã hủy xác nhận: chuyển sang yêu cầu khác trong lúc đang lưu');
      return;
    }
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
  // Include designImages in the patch only when they changed (base64 → GCS URL).
  // If GCS upload failed and images are still base64, the DB already holds them
  // from qcagDesktopUploadMQ, so no need to re-send the large payload.
  const _finalDesignImgStr = JSON.stringify(finalDesignImages);
  if (_finalDesignImgStr !== JSON.stringify(designImgs)) {
    patchPayload.designImages = _finalDesignImgStr;
  }
  // Save pre-confirm snapshot for rollback
  const _rollbackRequest = { ...currentDetailRequest };
  // Local state gets full merge for UI — ensure finalDesignImages (GCS URLs) are used.
  const updated = { ...currentDetailRequest, ...patchPayload, designImages: _finalDesignImgStr };

  // Optimistically update local state BEFORE the await so that if an SSE event
  // arrives during the network round-trip the statRank guard correctly sees 'done'
  // and won't revert the UI to 'processing'.
  const idxAll = allRequests.findIndex(r => r.__backendId === updated.__backendId);
  if (idxAll !== -1) allRequests[idxAll] = updated;
  currentDetailRequest = updated;
  qcagDesktopCacheRequest(updated);
  qcagDesktopRefreshMQInPlace(updated);

  // Persist: send only the slim PATCH payload to backend
  if (window.dataSdk) {
    const result = await window.dataSdk.update(patchPayload);
    if (!result.isOk) {
      showToast('Không thể cập nhật request');
      // Rollback optimistic update on failure
      const idxRb = allRequests.findIndex(r => r.__backendId === _rollbackRequest.__backendId);
      if (idxRb !== -1) allRequests[idxRb] = _rollbackRequest;
      currentDetailRequest = _rollbackRequest;
      qcagDesktopCacheRequest(_rollbackRequest);
      qcagDesktopRefreshMQInPlace(_rollbackRequest);
      return;
    }
  }
  _qcagRequestsVersion += 1;
  _qcagRequestCodeCache.version = 0;

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
  const updated = { ...currentDetailRequest, designImages: JSON.stringify(imgs), designFilename: '', updatedAt: new Date().toISOString() };
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
    img.onclick = function (e) { e.stopPropagation(); try { showImageFull(images, false, i); } catch (err) { console.error(err); } };
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
let _qcagNavListSearchDebounce = null;
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
  const bar = document.getElementById('qcagNavListRegionBar');
  if (bar) {
    bar.querySelectorAll('.qcag-nav-region-btn').forEach(b => {
      b.classList.toggle('active', (b.dataset.region || '') === _qcagNavListRegionFilter.toLowerCase());
    });
  }
  qcagNavRenderList();
}

function qcagNavListOnSearch(val) {
  _qcagNavListSearchQ = (val || '').toLowerCase().trim();
  _qcagNavListCurrentPage = 1;
  _qcagNavListSelected.clear();
  if (_qcagNavListSearchDebounce) clearTimeout(_qcagNavListSearchDebounce);
  _qcagNavListSearchDebounce = setTimeout(() => {
    _qcagNavListSearchDebounce = null;
    _qcagNavListRender();
  }, 300);
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

function qcagNavListSelectAllVisible() {
  if (!_qcagNavListSelected) _qcagNavListSelected = new Set();
  
  const items = (_qcagNavListFiltered && _qcagNavListFiltered.length > 0)
    ? _qcagNavListFiltered
    : ((typeof allRequests !== 'undefined' ? allRequests : []) || []).map(r => ({ r }));

  items.forEach(item => {
    const r = item.r || item;
    const key = r.__backendId || JSON.stringify(r);
    _qcagNavListSelected.add(key);
  });

  _qcagNavListRenderBody();
}

function qcagNavListPrintPDF() {
  if (!_qcagNavListSelected || _qcagNavListSelected.size === 0) {
    alert('Vui lòng chọn ít nhất 1 dòng trong danh sách để in PDF.');
    return;
  }

  const reqs = (typeof allRequests !== 'undefined' ? allRequests : []) || [];
  const targets = reqs.filter(r => {
    const key = r.__backendId || JSON.stringify(r);
    return _qcagNavListSelected.has(key) || _qcagNavListSelected.has(r.__backendId);
  });

  if (!targets || targets.length === 0) {
    alert('Không tìm thấy dữ liệu yêu cầu được chọn để in PDF.');
    return;
  }

  const sheetsHtml = targets.map((r, idx) => {
    const requester = qcagDesktopParseJson(r.requester, {});
    const items = qcagDesktopParseJson(r.items, []);
    const itemArr = Array.isArray(items) ? items : [];
    const status = _qcagNavListBuildStatus(r);
    const isSurvey = (status.cls === 'survey' || (status.label || '').toLowerCase().includes('khảo sát'));

    const lat = parseFloat(r.outletLat);
    const lng = parseFloat(r.outletLng);
    const hasGps = !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0;
    const mapsUrl = hasGps 
      ? `https://www.google.com/maps?q=${lat},${lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.outletAddress || r.outletName || '')}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(mapsUrl)}`;

    const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString('vi-VN') : '-';

    const addressStr = (
      r.outletAddress || 
      r.address || 
      r.outlet_address || 
      r.outletLocation || 
      r.fullAddress || 
      requester.address || 
      requester.outletAddress || 
      requester.outlet_address || 
      requester.fullAddress || 
      (r.street ? `${r.street}${r.district ? ', ' + r.district : ''}${r.province ? ', ' + r.province : ''}` : '') || 
      '-'
    ).trim() || '-';

    const itemsRowsHtml = itemArr.map((it, iIdx) => {
      const rawName = (it.type || it.itemType || it.item_type || it.category || it.title || it.name || '').trim();
      const name = escapeHtml(rawName || `Hạng mục ${iIdx + 1}`);
      const brand = escapeHtml(it.brand || r.brand || '-');
      const qty = it.quantity || it.qty || 1;
      const specs = escapeHtml(it.specs || it.note || it.description || it.specifications || '-');
      const subItem = escapeHtml(it.subType || it.subItem || it.secondaryCategory || '');

      let dimCellHtml = '';
      if (isSurvey) {
        dimCellHtml = `
          <div style="display:flex; align-items:center; justify-content:center; gap:4px;">
            <div style="width:48px; height:24px; border:1.5px solid #475569; border-radius:3px; background:#ffffff;"></div>
            <span style="font-weight:800; font-size:11px; color:#475569;">x</span>
            <div style="width:48px; height:24px; border:1.5px solid #475569; border-radius:3px; background:#ffffff;"></div>
          </div>
        `;
      } else {
        const w = it.width ? `${it.width}` : '';
        const h = it.height ? `${it.height}` : '';
        const dimStr = (w || h) ? `${w} x ${h}` : '-';
        dimCellHtml = `<span class="std-dim-text">${escapeHtml(dimStr)}</span>`;
      }

      let subItemCellHtml = '';
      if (isSurvey) {
        subItemCellHtml = `<div style="width:100%; height:24px; border:1.5px solid #475569; border-radius:3px; background:#ffffff;"></div>`;
      } else {
        subItemCellHtml = subItem || '-';
      }

      return `
        <tr>
          <td class="text-center font-bold">${iIdx + 1}</td>
          <td style="width: 185px; max-width: 185px; padding: 4px 5px;">
            <div class="item-name" style="font-size: 9.5px; font-weight: 700; color: #111827; line-height: 1.25; word-break: break-word;">${name}</div>
            <div class="item-brand" style="font-size: 8.5px; font-weight: 500; color: #4b5563; margin-top: 1px; line-height: 1.2; word-break: break-word;">Brand: <strong>${brand}</strong></div>
          </td>
          <td class="text-center font-bold">${qty}</td>
          <td class="text-center">${dimCellHtml}</td>
          <td class="text-center">${subItemCellHtml}</td>
          <td class="item-specs">${specs}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="print-page">
        <!-- Page Header with Official QCAG SVG Logo -->
        <div class="print-header">
          <div class="header-left" style="display:flex; align-items:center; gap:12px;">
            <img src="app/assets/qcag-logo.svg" style="height:36px; max-width:140px; object-fit:contain;" alt="QCAG Logo" />
            <div>
              <h2 class="company-title" style="font-size:14px; font-weight:700; color:#111827; margin:0; line-height:1.2;">QUẢNG CÁO AN GIANG</h2>
              <div style="font-size:11px; font-weight:700; color:#111827; letter-spacing:0.2px;">PHIẾU KHẢO SÁT & YÊU CẦU THI CÔNG</div>
              <div class="header-sub" style="font-size:10px; color:#4b5563;">Mã TK: <strong>${escapeHtml(r.tkCode || '-')}</strong> | Ngày tạo: ${escapeHtml(dateStr)}</div>
            </div>
          </div>
          <div class="header-right">
            ${isSurvey 
              ? `<span class="badge-survey-print">PHIẾU KHẢO SÁT</span>` 
              : `<span class="badge-status-print">${escapeHtml(status.label)}</span>`
            }
          </div>
        </div>

        <!-- Info Grid (Outlet & Sale & QR) -->
        <div class="info-grid-container">
          <div class="info-box outlet-box">
            <h3 class="box-title">THÔNG TIN ĐIỂM BÁN (OUTLET)</h3>
            <table class="info-table">
              <tr><td class="lbl">Tên điểm bán:</td><td class="val highlight">${escapeHtml(r.outletName || '-')}</td></tr>
              <tr><td class="lbl">Mã Outlet:</td><td class="val font-mono">${escapeHtml(r.outletCode || '-')}</td></tr>
              <tr><td class="lbl">SĐT Outlet:</td><td class="val">${escapeHtml(r.outletPhone || requester.phone || '-')}</td></tr>
              <tr><td class="lbl">Địa chỉ:</td><td class="val">${escapeHtml(addressStr)}</td></tr>
            </table>
          </div>

          <div class="info-box sale-box">
            <h3 class="box-title">THÔNG TIN NHÂN SỰ (SALE / SS)</h3>
            <table class="info-table">
              <tr><td class="lbl">Tên Sale:</td><td class="val highlight">${escapeHtml(requester.saleName || requester.phone || '-')}</td></tr>
              <tr><td class="lbl">SĐT Sale:</td><td class="val">${escapeHtml(requester.salePhone || requester.phone || '-')}</td></tr>
              <tr><td class="lbl">Giám sát SS:</td><td class="val">${escapeHtml(requester.ssName || '-')}</td></tr>
              <tr><td class="lbl">Khu vực:</td><td class="val">${escapeHtml(requester.region || r.region || '-')}</td></tr>
            </table>
          </div>

          <div class="info-box qr-box">
            <h3 class="box-title">ĐỊNH VỊ MAPS</h3>
            <div class="qr-code-wrap">
              <img src="${qrUrl}" alt="QR Code Maps" class="qr-img" />
              <div class="qr-hint">Quét QR mở Google Maps</div>
            </div>
          </div>
        </div>

        <!-- Items Table -->
        <div class="items-table-container">
          <h3 class="items-section-title">DANH SÁCH HẠNG MỤC CẦN ${isSurvey ? 'KHẢO SÁT / ĐO ĐẠC' : 'THI CÔNG'}</h3>
          <table class="print-items-table">
            <thead>
              <tr>
                <th style="width: 28px; text-align:center;">STT</th>
                <th style="width: 185px; text-align:left;">Tên Hạng Mục & Brand</th>
                <th style="width: 32px; text-align:center;">SL</th>
                <th style="width: 120px; text-align:center;">Kích Thước (R x C)</th>
                <th style="width: 120px; text-align:center;">Hạng Mục Phụ</th>
                <th>Ghi Chú / Quy Cách</th>
              </tr>
            </thead>
            <tbody>
              ${itemsRowsHtml || '<tr><td colspan="6" style="text-align:center; padding: 12px;">Chưa có hạng mục chi tiết.</td></tr>'}
            </tbody>
          </table>
        </div>

        <!-- Field Survey & Technical Notes Section -->
        <div class="survey-field-notes-container" style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:4px; margin-bottom:4px;">
          <div class="survey-field-box" style="border:1px solid #1e293b; border-radius:4px; padding:6px 8px; background:#ffffff !important; height:185px; min-height:185px; display:flex; flex-direction:column; justify-content:space-between;">
            <div>
              <div style="font-weight:700; font-size:10px; color:#111827; border-bottom:1px solid #1e293b; padding-bottom:3px; margin-bottom:6px; text-transform:uppercase;">
                PHƯƠNG THỨC & ĐIỀU KIỆN THI CÔNG
              </div>
              <div style="font-size:10.5px; color:#111827; display:grid; grid-template-columns: 1fr 1fr; gap:5px 12px; margin-bottom:6px; font-weight:500;">
                <div>[ &nbsp; ] Cần kéo điện xa</div>
                <div>[ &nbsp; ] Cần thang / giàn giáo</div>
                <div>[ &nbsp; ] Cần xe cẩu / nâng</div>
                <div>[ &nbsp; ] Cần tháo dỡ bảng cũ</div>
                <div>[ &nbsp; ] Thi công trên cao</div>
                <div>[ &nbsp; ] Cấm tải</div>
              </div>
              <div style="font-weight:700; font-size:10px; color:#111827; margin-bottom:2px;">Công cụ / Phương án đặc biệt:</div>
            </div>
            <div>
              <div class="dotted-line"></div>
              <div class="dotted-line"></div>
              <div class="dotted-line"></div>
              <div class="dotted-line"></div>
            </div>
          </div>

          <div class="survey-field-box" style="border:1px solid #1e293b; border-radius:4px; padding:6px 8px; background:#ffffff !important; height:185px; min-height:185px; display:flex; flex-direction:column;">
            <div style="font-weight:700; font-size:10px; color:#111827; border-bottom:1px solid #1e293b; padding-bottom:3px; margin-bottom:4px; width:100%; text-transform:uppercase; text-align:left;">
              SƠ ĐỒ VỊ TRÍ LẮP ĐẶT (VẼ TAY)
            </div>
            <div style="flex:1; width:100%; border:none; background:#ffffff !important;"></div>
          </div>
        </div>

        <!-- 5-Line Sign Content Section -->
        <div style="margin-top:4px; margin-bottom:4px;">
          <div style="font-weight:700; font-size:10px; color:#111827; margin-bottom:2px; text-transform:uppercase;">Nội dung bảng hiệu:</div>
          <div class="dotted-line"></div>
          <div class="dotted-line"></div>
          <div class="dotted-line"></div>
          <div class="dotted-line"></div>
          <div class="dotted-line"></div>
        </div>

        <!-- Extra Notes & Surveyor Recommendations (5 Dotted Lines) -->
        <div class="extra-notes-container" style="margin-top:4px; margin-bottom:4px;">
          <div class="extra-notes-title" style="font-weight:700; font-size:10px; color:#111827; margin-bottom:2px; text-transform:uppercase;">Yêu cầu thêm nếu có:</div>
          <div class="dotted-line"></div>
          <div class="dotted-line"></div>
          <div class="dotted-line"></div>
          <div class="dotted-line"></div>
          <div class="dotted-line"></div>
        </div>

        <!-- Footer Signatures -->
        <div class="print-footer-signatures">
          <div class="sig-box">
            <div>NGƯỜI LẬP PHIẾU</div>
            <div class="sig-note">(Ký & ghi rõ họ tên)</div>
          </div>
          <div class="sig-box">
            <div>ĐẠI DIỆN ĐIỂM BÁN</div>
            <div class="sig-note">(Ký & ghi rõ họ tên)</div>
          </div>
          <div class="sig-box">
            <div>NGƯỜI KHẢO SÁT</div>
            <div class="sig-note">(Ký & ghi rõ họ tên)</div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  const printDocHtml = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <title>In PDF Danh Sách Yêu Cầu - QCAG</title>
      <style>
        @page {
          size: A4 portrait;
          margin: 6mm;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
          font-size: 10.5px;
          color: #111827;
          background: #ffffff;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .print-page {
          page-break-after: always;
          break-after: page;
          height: 278mm;
          max-height: 278mm;
          padding: 4px 6px;
          position: relative;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          overflow: hidden;
        }
        .print-page:last-child {
          page-break-after: avoid;
          break-after: avoid;
        }
        
        .print-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1.5px solid #1e293b;
          padding-bottom: 4px;
          margin-bottom: 6px;
        }
        .company-title {
          font-size: 14px;
          font-weight: 700;
          color: #111827;
          margin: 0;
          line-height: 1.2;
        }
        .header-sub {
          font-size: 10px;
          color: #4b5563;
          margin-top: 1px;
        }
        .badge-survey-print, .badge-status-print {
          background: #ffffff !important;
          color: #111827 !important;
          border: 1px solid #1e293b !important;
          font-weight: 700;
          font-size: 10.5px;
          padding: 2px 8px;
          border-radius: 4px;
        }

        .info-grid-container {
          display: grid;
          grid-template-columns: 1.25fr 1.25fr 0.8fr;
          gap: 6px;
          margin-bottom: 6px;
        }
        .info-box {
          border: 1px solid #1e293b;
          border-radius: 4px;
          padding: 5px 7px;
          background: #ffffff !important;
        }
        .box-title {
          font-size: 10px;
          font-weight: 700;
          color: #111827;
          margin-bottom: 4px;
          border-bottom: 1px solid #1e293b;
          padding-bottom: 2px;
          text-transform: uppercase;
        }
        .info-table { width: 100%; border-collapse: collapse; font-size: 10px; }
        .info-table td { padding: 1.5px 0; vertical-align: top; }
        .info-table .lbl { width: 75px; color: #4b5563; font-weight: 500; }
        .info-table .val { color: #111827; font-weight: 600; }
        .info-table .val.highlight { color: #111827; font-weight: 700; font-size: 11px; }
        .font-mono { font-family: monospace; }

        .qr-box {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
        }
        .qr-code-wrap { text-align: center; }
        .qr-img { width: 72px; height: 72px; border: 1px solid #1e293b; border-radius: 4px; padding: 1px; background: #fff; }
        .qr-hint { font-size: 8.5px; color: #4b5563; margin-top: 2px; font-weight: 600; }

        .items-section-title {
          font-size: 10.5px;
          font-weight: 700;
          color: #111827;
          margin-bottom: 4px;
          text-transform: uppercase;
        }
        .print-items-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10px;
          margin-bottom: 6px;
        }
        .print-items-table th {
          background: #ffffff !important;
          color: #111827;
          font-weight: 700;
          text-transform: uppercase;
          font-size: 9.5px;
          padding: 5px 6px;
          border: 1px solid #1e293b;
        }
        .print-items-table td {
          padding: 4px 6px;
          border: 1px solid #334155;
          vertical-align: middle;
        }
        .text-center { text-align: center; }
        .font-bold { font-weight: 700; }
        .item-name { font-weight: 700; color: #111827; font-size: 11px; }
        .item-brand { font-size: 9.5px; color: #4b5563; margin-top: 1px; }

        .dotted-line {
          border-bottom: 1px dashed #4b5563;
          height: 16px;
          margin-bottom: 3px;
        }

        .print-footer-signatures {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 10px;
          margin-top: auto;
          padding-top: 6px;
          text-align: center;
          border-top: 1px solid #1e293b;
        }
        .sig-box {
          font-weight: 700;
          font-size: 10px;
          color: #111827;
        }
        .sig-note {
          font-weight: 400;
          font-size: 8.5px;
          color: #4b5563;
          margin-top: 1px;
          margin-bottom: 35px;
        }
      </style>
    </head>
    <body>
      ${sheetsHtml}
      <script>
        function triggerPrintWhenImagesLoaded() {
          var imgs = Array.from(document.images);
          if (imgs.length === 0) {
            setTimeout(function() { window.print(); }, 150);
            return;
          }
          var loadedCount = 0;
          function onImgDone() {
            loadedCount++;
            if (loadedCount >= imgs.length) {
              setTimeout(function() { window.print(); }, 150);
            }
          }
          imgs.forEach(function(img) {
            if (img.complete && img.naturalWidth !== 0) {
              onImgDone();
            } else {
              img.onload = onImgDone;
              img.onerror = onImgDone;
            }
          });
          setTimeout(function() { window.print(); }, 1000);
        }
        if (document.readyState === 'complete') {
          triggerPrintWhenImagesLoaded();
        } else {
          window.addEventListener('load', triggerPrintWhenImagesLoaded);
        }
      </script>
    </body>
    </html>
  `;

  let iframe = document.getElementById('qcagNavPrintIframe');
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = 'qcagNavPrintIframe';
    iframe.style.position = 'fixed';
    iframe.style.top = '-9999px';
    iframe.style.left = '-9999px';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.border = '0';
    iframe.style.visibility = 'hidden';
    document.body.appendChild(iframe);
  }

  const pDoc = iframe.contentWindow.document;
  pDoc.open();
  pDoc.write(printDocHtml);
  pDoc.close();
}

function qcagNavListExportCSV() {
  const reqs = (typeof allRequests !== 'undefined' ? allRequests : []) || [];
  let targets = [];

  if (_qcagNavListSelected && _qcagNavListSelected.size > 0) {
    targets = reqs.filter(r => {
      const key = r.__backendId || JSON.stringify(r);
      return _qcagNavListSelected.has(key) || _qcagNavListSelected.has(r.__backendId);
    });
  } else if (_qcagNavListFiltered && _qcagNavListFiltered.length > 0) {
    targets = _qcagNavListFiltered.map(item => item.r || item);
  } else {
    targets = reqs;
  }

  if (!targets || targets.length === 0) {
    alert('Không có dữ liệu để xuất Excel.');
    return;
  }

  const rows = [
    ['STT', 'Mã TK', 'Ngày tạo', 'Khu vực', 'Sale', 'SĐT Sale', 'SS', 'Mã Outlet', 'Tên Outlet', 'SĐT Outlet', 'Địa chỉ', 'Brand', 'Trạng thái']
  ];

  targets.forEach((r, idx) => {
    const requester = qcagDesktopParseJson(r.requester, {});
    const status = _qcagNavListBuildStatus(r);
    const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString('vi-VN') : '-';

    rows.push([
      idx + 1,
      r.tkCode || '',
      dateStr,
      requester.region || r.region || '',
      requester.saleName || '',
      requester.salePhone || requester.phone || '',
      requester.ssName || '',
      r.outletCode || '',
      r.outletName || '',
      r.outletPhone || requester.phone || '',
      r.outletAddress || requester.address || '',
      _qcagNavListGetBrands(r),
      status.label || ''
    ]);
  });

  const csvContent = '\uFEFF' + rows.map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.setAttribute('download', `QCAG_DanhSach_YeuCau_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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

function qcagNavUpdateMetricsAndCounts(reqs) {
  const all = (typeof allRequests !== 'undefined' ? allRequests : []) || [];
  let total = all.length;
  let surveyCnt = 0;
  let processingCnt = 0;
  let doneCnt = 0;

  let cntSurvey = 0, cntDesign = 0, cntEdit = 0, cntConfirm = 0, cntProc = 0, cntPending = 0, cntDone = 0;

  all.forEach(r => {
    const status = _qcagNavListBuildStatus(r);
    if (status.cls === 'survey' || status.cls === 'pending') {
      surveyCnt++;
    } else if (status.cls === 'done') {
      doneCnt++;
    } else {
      processingCnt++;
    }

    if (status.cls === 'survey') cntSurvey++;
    else if (status.cls === 'pending-design') cntDesign++;
    else if (status.cls === 'pending-edit') cntEdit++;
    else if (status.cls === 'pending-confirm') cntConfirm++;
    else if (status.cls === 'processing') cntProc++;
    else if (status.cls === 'pending') cntPending++;
    else if (status.cls === 'done') cntDone++;
  });

  const kpiTot = document.getElementById('qcagNavKpiTotal');
  const kpiSurv = document.getElementById('qcagNavKpiSurvey');
  const kpiProc = document.getElementById('qcagNavKpiProcessing');
  const kpiDone = document.getElementById('qcagNavKpiDone');

  if (kpiTot) kpiTot.textContent = total;
  if (kpiSurv) kpiSurv.textContent = surveyCnt;
  if (kpiProc) kpiProc.textContent = processingCnt;
  if (kpiDone) kpiDone.textContent = doneCnt;

  const setCnt = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val > 0 ? `(${val})` : '';
  };
  setCnt('cntStatusSurvey', cntSurvey);
  setCnt('cntStatusDesign', cntDesign);
  setCnt('cntStatusEdit', cntEdit);
  setCnt('cntStatusConfirm', cntConfirm);
  setCnt('cntStatusProcessing', cntProc);
  setCnt('cntStatusPending', cntPending);
  setCnt('cntStatusDone', cntDone);
}

function qcagNavRenderList() {
  const reqs = (typeof allRequests !== 'undefined' ? allRequests : []) || [];
  const q = _qcagNavListSearchQ;

  const sf = _qcagNavListStatusFilter;
  const rf = _qcagNavListRegionFilter;
  const yf = _qcagNavListYearFilter;

  qcagNavUpdateMetricsAndCounts(reqs);

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
          String(r.tkCode            || '').toLowerCase().includes(q) ||
          String(requester.saleCode  || '').toLowerCase().includes(q) ||
          String(requester.saleName  || requester.phone || '').toLowerCase().includes(q) ||
          String(requester.ssName    || '').toLowerCase().includes(q) ||
          String(requester.region    || '').toLowerCase().includes(q) ||
          String(r.outletCode        || '').toLowerCase().includes(q) ||
          String(r.outletName        || '').toLowerCase().includes(q) ||
          String(r.outletAddress     || requester.address || '').toLowerCase().includes(q) ||
          _qcagNavListGetBrands(r).toLowerCase().includes(q)
        );
        if (!textMatch) return false;
      }
      // status filter
      if (sf && !q) {
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

function _qcagNavListGetBrandChipsHtml(r) {
  const items = qcagDesktopParseJson(r.items, []);
  const itemArr = Array.isArray(items) ? items : [];
  const brands = [...new Set(itemArr.map(it => it && it.brand).filter(Boolean))];

  const chips = brands.slice(0, 3).map(b => {
    const bLower = b.toLowerCase();
    let cls = 'brand-default';
    if (bLower.includes('heineken')) cls = 'brand-heineken';
    else if (bLower.includes('tiger')) cls = 'brand-tiger';
    else if (bLower.includes('larue')) cls = 'brand-larue';
    else if (bLower.includes('bia viet') || bLower.includes('bia việt')) cls = 'brand-biaviet';
    else if (bLower.includes('edelweiss')) cls = 'brand-edelweiss';
    else if (bLower.includes('strongbow')) cls = 'brand-strongbow';
    return `<span class="qcag-brand-chip ${cls}">${escapeHtml(b)}</span>`;
  }).join(' ');

  const extra = brands.length > 3 ? `<span class="qcag-brand-more">+${brands.length - 3}</span>` : '';
  const itemBadge = `<div class="qcag-item-count-badge font-medium text-xs text-gray-500 mt-0.5"><strong>${itemArr.length}</strong> hạng mục</div>`;

  return `<div class="qcag-brands-wrap flex flex-wrap gap-1">${chips}${extra}</div>${itemBadge}`;
}

function _qcagNavListRenderBody() {
  const tbody = document.getElementById('qcagNavListBody');
  if (!tbody) return;

  const page = _qcagNavListGetPage();

  if (page.length === 0) {
    const colspan = 7;
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="qcag-empty-cell">Không tìm thấy yêu cầu nào phù hợp.</td></tr>`;
    return;
  }

  tbody.innerHTML = page.map(({ r, idx }) => {
    const requester = qcagDesktopParseJson(r.requester, {});
    const status = _qcagNavListBuildStatus(r);
    const key = r.__backendId || JSON.stringify(r);
    const reqId = r.__backendId || key;
    const isSelected = _qcagNavListSelected.has(key);
    const hasGps = !!(r.outletLat && r.outletLng);
    const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString('vi-VN') : '-';

    const brandChipsHtml = _qcagNavListGetBrandChipsHtml(r);

    const mapsSvgPin = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1px;margin-right:3px;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

    const gpsBtn = hasGps
      ? `<a class="qcag-nav-act-btn act-map" href="https://www.google.com/maps?q=${parseFloat(r.outletLat)},${parseFloat(r.outletLng)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Xem vị trí trên bản đồ">${mapsSvgPin}Maps</a>`
      : '';

    return `<tr class="qcag-table-row ${isSelected ? 'is-selected' : ''}" data-key="${escapeHtml(key)}" onclick="qcagNavListToggleRowByKey('${escapeHtml(key)}')">
      <td class="cell-stt">${idx + 1}</td>
      <td class="cell-tk">
        <div class="qcag-tk-code">${escapeHtml(r.tkCode || '-')}</div>
        <div class="qcag-tk-date">${escapeHtml(dateStr)}</div>
      </td>
      <td class="cell-region-sale">
        <span class="qcag-region-chip">${escapeHtml(requester.region || r.region || '-')}</span>
        <div class="qcag-sale-name">${escapeHtml(requester.saleName || requester.phone || '-')}</div>
        <div class="qcag-ss-name">SS: ${escapeHtml(requester.ssName || '-')}</div>
      </td>
      <td class="cell-outlet">
        <div class="qcag-outlet-name" title="${escapeHtml(r.outletName || '')}">${escapeHtml(r.outletName || '-')}</div>
        <div class="qcag-outlet-code">Mã: ${escapeHtml(r.outletCode || '-')}</div>
        <div class="qcag-outlet-addr" title="${escapeHtml(r.outletAddress || requester.address || '')}">${escapeHtml(r.outletAddress || requester.address || '')}</div>
      </td>
      <td class="cell-brand">${brandChipsHtml}</td>
      <td class="cell-status">
        <span class="qcag-nav-status-badge ${escapeHtml(status.cls)}">
          <span class="status-dot"></span>${escapeHtml(status.label)}
        </span>
      </td>
      <td class="cell-actions">
        <div class="qcag-table-actions" onclick="event.stopPropagation()">
          <button class="qcag-nav-act-btn act-qv" onclick="qcagNavOpenQuickView('${escapeHtml(reqId)}', event)" title="Xem nhanh thông tin chi tiết">Xem nhanh</button>
          <button class="qcag-nav-act-btn act-open" onclick="qcagNavOpenInMainView('${escapeHtml(reqId)}', event)" title="Mở trên màn hình làm việc chính">Mở trang</button>
          ${gpsBtn}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function qcagNavListPrintSummaryPDF() {
  if (!_qcagNavListSelected || _qcagNavListSelected.size === 0) {
    alert('Vui lòng chọn ít nhất 1 dòng trong danh sách để in bảng danh sách.');
    return;
  }

  const reqs = (typeof allRequests !== 'undefined' ? allRequests : []) || [];
  const targets = reqs.filter(r => {
    const key = r.__backendId || JSON.stringify(r);
    return _qcagNavListSelected.has(key) || _qcagNavListSelected.has(r.__backendId);
  });

  if (!targets || targets.length === 0) {
    alert('Không tìm thấy dữ liệu yêu cầu được chọn để in bảng danh sách.');
    return;
  }

  const currentDateStr = new Date().toLocaleDateString('vi-VN');
  const ITEMS_PER_PAGE = 12;
  const pages = [];
  for (let i = 0; i < targets.length; i += ITEMS_PER_PAGE) {
    pages.push(targets.slice(i, i + ITEMS_PER_PAGE));
  }

  const sheetsHtml = pages.map((pageTargets, pageIdx) => {
    const rowsHtml = pageTargets.map((r, rIdx) => {
      const globalIdx = pageIdx * ITEMS_PER_PAGE + rIdx + 1;
      const requester = qcagDesktopParseJson(r.requester, {});
      const items = qcagDesktopParseJson(r.items, []);
      const itemArr = Array.isArray(items) ? items : [];
      const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString('vi-VN') : '-';

      const addressStr = (
        r.outletAddress || 
        r.address || 
        r.outlet_address || 
        r.outletLocation || 
        r.fullAddress || 
        requester.address || 
        requester.outletAddress || 
        requester.outlet_address || 
        requester.fullAddress || 
        (r.street ? `${r.street}${r.district ? ', ' + r.district : ''}${r.province ? ', ' + r.province : ''}` : '') || 
        '-'
      ).trim() || '-';

      const itemsSummaryHtml = itemArr.map((it, iIdx) => {
        const rawName = (it.type || it.itemType || it.item_type || it.category || it.title || it.name || '').trim();
        const name = escapeHtml(rawName || `Hạng mục ${iIdx + 1}`);
        const brand = escapeHtml(it.brand || r.brand || '');
        const brandText = brand ? ` (${brand})` : '';
        return `<div><strong>${iIdx + 1}.</strong> ${name}${brandText}</div>`;
      }).join('') || '<div>Chưa có hạng mục</div>';

      return `
        <tr>
          <td style="text-align:center; font-weight:700;">${globalIdx}</td>
          <td>
            <div style="font-weight:700; font-size:10px;">${escapeHtml(r.tkCode || '-')}</div>
            <div style="font-size:8.5px; color:#4b5563;">${escapeHtml(dateStr)}</div>
          </td>
          <td>
            <div class="outlet-name">${escapeHtml(r.outletName || '-')}</div>
            <div class="outlet-code">Mã: ${escapeHtml(r.outletCode || '-')}</div>
            <div class="outlet-phone">SĐT: ${escapeHtml(r.outletPhone || requester.phone || '-')}</div>
          </td>
          <td style="font-size:9.5px; word-break:break-word;">${escapeHtml(addressStr)}</td>
          <td>
            <div style="font-weight:700; font-size:9.5px;">${escapeHtml(requester.saleName || requester.phone || '-')}</div>
            <div style="font-size:8.5px; color:#4b5563;">SĐT: ${escapeHtml(requester.salePhone || requester.phone || '-')}</div>
            <div style="font-size:8.5px; color:#4b5563;">KV: ${escapeHtml(requester.region || r.region || '-')}</div>
          </td>
          <td style="font-size:9px; line-height:1.3;">${itemsSummaryHtml}</td>
          <td style="background:#ffffff;"></td>
        </tr>
      `;
    }).join('');

    return `
      <div class="summary-page">
        <!-- Header -->
        <div class="summary-header">
          <div style="display:flex; align-items:center; gap:12px;">
            <img src="app/assets/qcag-logo.svg" style="height:32px; max-width:130px; object-fit:contain;" alt="QCAG Logo" />
            <div>
              <h2 class="company-title">QUẢNG CÁO AN GIANG</h2>
              <div style="font-size:11px; font-weight:700; color:#111827;">DANH SÁCH TỔNG HỢP CÔNG VIỆC KHẢO SÁT & THI CÔNG (KHỔ NGANG A4)</div>
            </div>
          </div>
          <div style="text-align:right;">
            <div class="summary-meta">Ngày in: <strong>${currentDateStr}</strong></div>
            <div class="summary-meta">Tổng số điểm: <strong>${targets.length} điểm</strong> | Trang <strong>${pageIdx + 1} / ${pages.length}</strong></div>
          </div>
        </div>

        <!-- Table -->
        <table class="summary-table">
          <thead>
            <tr>
              <th style="width:28px;">STT</th>
              <th style="width:85px;">Mã TK & Ngày</th>
              <th style="width:160px;">Thông Tin Outlet</th>
              <th style="width:230px;">Địa Chỉ Điểm Bán</th>
              <th style="width:130px;">Sale / SS</th>
              <th>Danh Sách Hạng Mục Cần Làm</th>
              <th style="width:120px;">Ghi Chú Field</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    `;
  }).join('');

  const printDocHtml = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <title>Bảng Danh Sách Khảo Sát & Thi Công - QCAG</title>
      <style>
        @page {
          size: A4 landscape;
          margin: 6mm 8mm;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
          font-size: 9.5px;
          color: #111827;
          background: #ffffff;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .summary-page {
          page-break-after: always;
          break-after: page;
          padding: 2px;
          min-height: 192mm;
        }
        .summary-page:last-child {
          page-break-after: avoid;
          break-after: avoid;
        }

        .summary-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1.5px solid #111827;
          padding-bottom: 4px;
          margin-bottom: 6px;
        }
        .company-title {
          font-size: 13.5px;
          font-weight: 700;
          color: #111827;
          margin: 0;
        }
        .summary-meta {
          font-size: 9px;
          color: #374151;
        }

        .summary-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 9.5px;
        }
        .summary-table th {
          background: #f3f4f6 !important;
          color: #111827;
          font-weight: 700;
          text-transform: uppercase;
          font-size: 9px;
          padding: 5px 4px;
          border: 1px solid #1e293b;
          text-align: center;
        }
        .summary-table td {
          padding: 5px 6px;
          border: 1px solid #334155;
          vertical-align: top;
          line-height: 1.3;
        }

        .outlet-name { font-weight: 700; color: #111827; font-size: 10px; }
        .outlet-code { font-family: monospace; font-size: 8.5px; color: #4b5563; }
        .outlet-phone { font-size: 8.5px; color: #111827; font-weight: 600; }
      </style>
    </head>
    <body>
      ${sheetsHtml}
      <script>
        function triggerPrintWhenImagesLoaded() {
          const imgs = Array.from(document.images);
          let loaded = 0;
          const total = imgs.length;

          if (total === 0) {
            window.focus();
            window.print();
            return;
          }

          function checkAll() {
            loaded++;
            if (loaded >= total) {
              setTimeout(() => {
                window.focus();
                window.print();
              }, 150);
            }
          }

          imgs.forEach(img => {
            if (img.complete) {
              checkAll();
            } else {
              img.onload = checkAll;
              img.onerror = checkAll;
            }
          });
        }

        if (document.readyState === 'complete') {
          triggerPrintWhenImagesLoaded();
        } else {
          window.addEventListener('load', triggerPrintWhenImagesLoaded);
        }
      </script>
    </body>
    </html>
  `;

  let iframe = document.getElementById('qcagNavPrintIframe');
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = 'qcagNavPrintIframe';
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);
  }

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(printDocHtml);
  doc.close();
}

/* =====================================================
   QUICK-VIEW SIDE DRAWER LOGIC
   ===================================================== */
let _qcagNavQuickViewCurrentReqId = null;

function qcagNavOpenQuickView(reqId, event) {
  if (event) event.stopPropagation();
  const reqs = (typeof allRequests !== 'undefined' ? allRequests : []) || [];
  const req = reqs.find(r => (r.__backendId || JSON.stringify(r)) === reqId || r.__backendId === reqId);
  if (!req) return;

  _qcagNavQuickViewCurrentReqId = reqId;

  const backdrop = document.getElementById('qcagNavQuickViewBackdrop');
  const drawer = document.getElementById('qcagNavQuickViewDrawer');
  const tkCodeEl = document.getElementById('qcagQvTkCode');
  const outletTitleEl = document.getElementById('qcagQvOutletTitle');
  const bodyEl = document.getElementById('qcagNavQuickViewBody');

  if (tkCodeEl) tkCodeEl.textContent = req.tkCode || 'Mã TK';
  if (outletTitleEl) outletTitleEl.textContent = req.outletName || 'Thông tin Outlet';

  if (bodyEl) {
    bodyEl.innerHTML = _qcagNavBuildQuickViewBodyHtml(req);
  }

  if (backdrop) backdrop.classList.remove('hidden');
  if (drawer) drawer.classList.remove('hidden');
}

function qcagNavCloseQuickView() {
  const backdrop = document.getElementById('qcagNavQuickViewBackdrop');
  const drawer = document.getElementById('qcagNavQuickViewDrawer');
  if (backdrop) backdrop.classList.add('hidden');
  if (drawer) drawer.classList.add('hidden');
  _qcagNavQuickViewCurrentReqId = null;
}

function qcagNavOpenInMainView(reqId, event) {
  if (event) event.stopPropagation();
  qcagNavCloseQuickView();
  qcagNavClosePanel();
  if (typeof openQCAGDesktopRequest === 'function') {
    openQCAGDesktopRequest(reqId);
  }
}

function qcagNavOpenCurrentInMainView() {
  if (_qcagNavQuickViewCurrentReqId) {
    qcagNavOpenInMainView(_qcagNavQuickViewCurrentReqId);
  }
}

function _qcagNavBuildQuickViewBodyHtml(req) {
  const requester = qcagDesktopParseJson(req.requester, {});
  const items = qcagDesktopParseJson(req.items, []);
  const itemArr = Array.isArray(items) ? items : [];
  const status = _qcagNavListBuildStatus(req);
  const images = typeof qcagDesktopCollectRequestImageUrls === 'function' ? qcagDesktopCollectRequestImageUrls(req) : [];
  const createdDate = req.createdAt ? new Date(req.createdAt).toLocaleString('vi-VN') : 'N/A';

  const itemsHtml = itemArr.length > 0 ? itemArr.map((it, i) => {
    const dim = (it.width && it.height) ? `${it.width} x ${it.height} cm` : (it.size || 'N/A');
    const brand = it.brand ? `<span class="qcag-qv-item-brand">${escapeHtml(it.brand)}</span>` : '';
    return `
      <div class="qcag-qv-item-card">
        <div class="qcag-qv-item-header">
          <span class="qcag-qv-item-num">#${i + 1}</span>
          <span class="qcag-qv-item-name">${escapeHtml(it.type || it.name || 'Hạng mục')}</span>
          ${brand}
        </div>
        <div class="qcag-qv-item-specs">
          <div>📐 Kích thước: <strong>${escapeHtml(dim)}</strong></div>
          ${it.quantity ? `<div>🔢 Số lượng: <strong>${escapeHtml(it.quantity)}</strong></div>` : ''}
          ${it.material ? `<div>🛠️ Chất liệu: <span>${escapeHtml(it.material)}</span></div>` : ''}
          ${it.notes ? `<div class="qcag-qv-item-notes">📝 Ghi chú: ${escapeHtml(it.notes)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('') : '<div class="qcag-qv-empty">Không có thông tin hạng mục</div>';

  const photosHtml = images.length > 0 ? `
    <div class="qcag-qv-photos-grid">
      ${images.map(img => `
        <div class="qcag-qv-photo-item" onclick="if(typeof qcagOpenGallery==='function') qcagOpenGallery('${escapeHtml(img.url || img)}')">
          <img src="${escapeHtml(img.url || img)}" alt="Ảnh" loading="lazy">
          ${img.label ? `<span class="qcag-qv-photo-label">${escapeHtml(img.label)}</span>` : ''}
        </div>
      `).join('')}
    </div>
  ` : '<div class="qcag-qv-empty">Chưa có hình ảnh tài liệu</div>';

  const hasGps = !!(req.outletLat && req.outletLng);
  const gpsBtn = hasGps
    ? `<a class="qcag-qv-gps-link" href="https://www.google.com/maps?q=${parseFloat(req.outletLat)},${parseFloat(req.outletLng)}" target="_blank" rel="noopener">📍 Xem trên Google Maps (${req.outletLat.slice(0, 7)}, ${req.outletLng.slice(0, 7)})</a>`
    : '<span class="qcag-qv-no-gps">Không có tọa độ GPS</span>';

  return `
    <div class="qcag-qv-section">
      <div class="qcag-qv-status-row">
        <span class="qcag-nav-status-badge ${escapeHtml(status.cls)}">${escapeHtml(status.label)}</span>
        <span class="qcag-qv-date">🕒 Ngày tạo: ${escapeHtml(createdDate)}</span>
      </div>
    </div>

    <div class="qcag-qv-section">
      <h4 class="qcag-qv-sec-title">🏬 Điểm bán & Nhân sự phụ trách</h4>
      <div class="qcag-qv-info-grid">
        <div class="qcag-qv-info-item">
          <span class="lbl">Outlet Code:</span>
          <span class="val font-mono">${escapeHtml(req.outletCode || 'N/A')}</span>
        </div>
        <div class="qcag-qv-info-item">
          <span class="lbl">Khu vực:</span>
          <span class="val font-semibold text-blue-600">${escapeHtml(requester.region || req.region || 'N/A')}</span>
        </div>
        <div class="qcag-qv-info-item">
          <span class="lbl">Tên Sale:</span>
          <span class="val">${escapeHtml(requester.saleName || requester.phone || 'N/A')}</span>
        </div>
        <div class="qcag-qv-info-item">
          <span class="lbl">Tên SS:</span>
          <span class="val">${escapeHtml(requester.ssName || 'N/A')}</span>
        </div>
        <div class="qcag-qv-info-item full">
          <span class="lbl">Địa chỉ:</span>
          <span class="val">${escapeHtml(req.outletAddress || requester.address || 'N/A')}</span>
        </div>
        <div class="qcag-qv-info-item full">
          <span class="lbl">Tọa độ GPS:</span>
          <span class="val">${gpsBtn}</span>
        </div>
      </div>
    </div>

    <div class="qcag-qv-section">
      <h4 class="qcag-qv-sec-title">📦 Danh sách hạng mục thi công (${itemArr.length})</h4>
      <div class="qcag-qv-items-list">${itemsHtml}</div>
    </div>

    <div class="qcag-qv-section">
      <h4 class="qcag-qv-sec-title">🖼️ Hình ảnh tài liệu & Phối cảnh (${images.length})</h4>
      ${photosHtml}
    </div>
  `;
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

  const header = ['STT', 'Mã TK', 'Khu vực', 'Tên Sale', 'SĐT Sale', 'Tên SS', 'Outlet Code', 'Tên Outlet', 'SĐT Outlet', 'Brand', 'SL hạng mục', 'Trạng thái', 'Định vị (Google Maps)'];
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
    // Sale phone: try common requester fields
    const rawSalePhone = (requester && (requester.salePhone || requester.sale_phone || requester.phone || '')) || '';
    const salePhone = qcagNormalizePhone(rawSalePhone);
    const salePhoneCell = salePhone ? `="${salePhone}"` : '';

    // Outlet phone: try multiple locations (row fields, requester fields, nested outlet JSON)
    let rawOutletPhone = (r && (r.outletPhone || r.outlet_phone || r.phone || r.contact_phone || r.mobile)) || '';
    if (!rawOutletPhone && requester) rawOutletPhone = requester.outletPhone || requester.outlet_phone || requester.phone || requester.contact_phone || '';
    // Try parsing a nested outlet JSON block if present
    try {
      const parsedOutlet = qcagDesktopParseJson(r.outlet || r.outletData || r.outlet_block || '', null);
      if (parsedOutlet && typeof parsedOutlet === 'object') {
        rawOutletPhone = rawOutletPhone || parsedOutlet.phone || parsedOutlet.outlet_phone || parsedOutlet.contact_phone || parsedOutlet.mobile || parsedOutlet.phoneNumber || '';
      }
    } catch (e) {}
    const outletPhone = qcagNormalizePhone(rawOutletPhone);
    const outletPhoneCell = outletPhone ? `="${outletPhone}"` : '';
    csvRows.push([
      idx + 1,
      r.tkCode || '',
      requester.region || '',
      requester.saleName || '',
      salePhoneCell,
      requester.ssName || '',
      r.outletCode || '',
      r.outletName || '',
      outletPhoneCell,
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
  const map = L.map(container, { center: defaultCenter, zoom: 8, maxZoom: 25 });
  _qcagNavMapInstance = map;

  const _osmDesktop = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 25,
    maxNativeZoom: 19
  });
  const _satDesktop = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri — Sources: Esri, DigitalGlobe, GeoEye',
    maxZoom: 25,
    maxNativeZoom: 18
  });
  _osmDesktop.addTo(map);

  // Layer toggle control
  var _desktopMapSat = false;
  var layerCtrl = L.control({ position: 'topright' });
  layerCtrl.onAdd = function () {
    var div = L.DomUtil.create('div', 'leaflet-bar');
    div.innerHTML = '<a href="#" title="Chuyển sang vệ tinh" style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;font-size:11px;font-weight:600;background:#fff;color:#333;text-decoration:none;cursor:pointer" id="qcagMapLayerBtn">🛰️</a>';
    L.DomEvent.disableClickPropagation(div);
    div.querySelector('a').addEventListener('click', function (e) {
      e.preventDefault();
      if (_desktopMapSat) {
        map.removeLayer(_satDesktop);
        _osmDesktop.addTo(map);
        _desktopMapSat = false;
        this.title = 'Chuyển sang vệ tinh';
      } else {
        map.removeLayer(_osmDesktop);
        _satDesktop.addTo(map);
        _desktopMapSat = true;
        this.title = 'Chuyển sang bản đồ thường';
      }
    });
    return div;
  };
  layerCtrl.addTo(map);

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
