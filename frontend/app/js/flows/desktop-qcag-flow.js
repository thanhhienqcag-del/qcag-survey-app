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
    return { label: 'Chờ chỉnh sửa', cls: 'pending' };
  }

  const designImgs = qcagDesktopParseJson(req && req.designImages, []);
  if (!designImgs || designImgs.length === 0) {
    return { label: 'Chờ thiết kế', cls: 'pending' };
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
    itemsSec.innerHTML = qcagDesktopBuildItemsHtml(items);
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
  const designImgsRaw = qcagDesktopParseJson(updatedRequest.designImages, []);
  const designImgs = Array.isArray(designImgsRaw)
    ? designImgsRaw.map(qcagDesktopNormalizeImageUrl).filter(Boolean)
    : [];

  // Rebuild thumb grid in-place
  const previewEl = document.getElementById('qcagMQPreview');
  if (previewEl) {
    previewEl.innerHTML = designImgs.length > 0
      ? designImgs.map((img, i) => `
        <div class="qcag-thumb-item">
          <img src="${img}" onclick="showImageFull('${img}',false)">
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
      if (designImgs.length > 0) {
        completeBtn.disabled = false;
        completeBtn.classList.remove('qcag-complete-btn--disabled');
        completeBtn.removeAttribute('title');
      } else {
        completeBtn.disabled = true;
        completeBtn.classList.add('qcag-complete-btn--disabled');
        completeBtn.title = disabledTitle;
      }
    }
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
  const images = Array.isArray(comment.images) ? comment.images : [];
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
          ${images.length > 0 ? `<div class="qcag-comment-images">${images.map(img => `<img src="${img}" onclick="showImageFull('${img}',false)">`).join('')}</div>` : ''}
          ${readText ? `<div class="qcag-comment-read">${readText}</div>` : ''}
          <div class="qcag-comment-time-inbubble">${createdAt}</div>
        </div>
      </div>
    </div>
  `;
}

function qcagDesktopBuildItemsHtml(items) {
  if (!items.length) return '<div class="qcag-detail-muted">Không có hạng mục</div>';
  return `
    <div class="qcag-items-table">
      <div class="qcag-items-head">
        <div>STT</div><div>Loại bảng hiệu</div><div>Hình thức</div><div>Brand</div><div>Kích thước</div><div>Số trụ</div><div>Yêu cầu</div>
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
        return `<div class="qcag-items-row"><div>${idx + 1}</div><div>${escapeHtml(item.type || '-')}</div><div>${escapeHtml(item.action || '-')}</div><div>${escapeHtml(item.brand || '-')}</div><div>${sizeHtml}${sizeExtraNote}</div><div>${escapeHtml(poles)}</div><div>${escapeHtml(requestText)}</div></div>`;
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
  const designImgs = qcagDesktopParseJson(entry.designImages, []);
  const requester  = qcagDesktopParseJson(entry.requester, {});
  const reqCode    = (codeMap && codeMap[entry.__backendId]) || '-';
  const uploadedBy = entry.designUploadedBy || '-';
  const saleName   = requester.saleName || requester.phone || '-';
  const requestTime = entry.createdAt      ? new Date(entry.createdAt).toLocaleString('vi-VN')      : '-';
  const uploadTime  = entry.designUpdatedAt ? new Date(entry.designUpdatedAt).toLocaleString('vi-VN') : '-';

  let imgsHtml = '<div class="qcag-detail-muted">Không có ảnh</div>';
  if (designImgs.length === 1) {
    imgsHtml = `<div class="qcag-gallery-rep qcag-old-gallery-rep" onclick="showImageFull('${designImgs[0]}',false)"><img src="${designImgs[0]}" alt="MQ thiết kế cũ"></div>`;
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

  let request = allRequests.find(r => r.__backendId === id);
  if (!request) return;

  // Fetch full record to get image columns excluded from the list query
  if (window.dataSdk && typeof window.dataSdk.getOne === 'function') {
    try {
      const r = await window.dataSdk.getOne(id);
      if (r && r.isOk && r.data) {
        request = Object.assign({}, request, {
          statusImages:     r.data.statusImages     || request.statusImages,
          designImages:     r.data.designImages     || request.designImages,
          acceptanceImages: r.data.acceptanceImages || request.acceptanceImages,
          oldContentImages: r.data.oldContentImages || request.oldContentImages,
        });
        const idx = allRequests.findIndex(x => x.__backendId === id);
        if (idx !== -1) allRequests[idx] = request;
      }
    } catch (e) { /* use local data as fallback */ }
  }

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
  const statusImgs = qcagDesktopParseJson(request.statusImages, []);
  const designImgsRaw = qcagDesktopParseJson(request.designImages, []);
  const designImgs = Array.isArray(designImgsRaw)
    ? designImgsRaw.map(qcagDesktopNormalizeImageUrl).filter(Boolean)
    : [];
  const comments = qcagDesktopParseJson(request.comments, []);
  const isPendingEditRequest = qcagDesktopIsPendingEditRequest(request);
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
          <div class="qcag-card-title">Hạng mục yêu cầu</div>
          <div id="qcagItemsSection">${qcagDesktopBuildItemsHtml(items)}</div>
        </div>

        <div class="qcag-card qcag-card--no-frame">
          <div class="qcag-content-split">
              <div class="qcag-subcard">
                <div class="qcag-card-title">Nội dung bảng hiệu</div>
                <div class="qcag-subcard-body">
                  ${(() => {
                    try {
                      const isOld = !!request.oldContent;
                      const oldImgs = qcagDesktopParseJson(request.oldContentImages, []);
                      const oldExtra = request.oldContentExtra || '';
                      if (isOld) {
                        if (oldImgs.length > 0) {
                            const encOld = encodeURIComponent(JSON.stringify(oldImgs));
                            const firstOld = oldImgs[0];
                            const moreOld = oldImgs.length > 1 ? (oldImgs.length - 1) : 0;
                            let galleryHtml = '';
                            if (oldImgs.length === 1) {
                              galleryHtml = `<div class="qcag-gallery-rep" onclick="showImageFull('${firstOld}',false)"><img src="${firstOld}" alt="nội dung cũ"></div>`;
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
                    return `<div class="qcag-gallery-rep" onclick="showImageFull('${first}',false)"><img src="${first}" alt="hiện trạng"></div>`;
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
                        <img src="${img}" onclick="showImageFull('${img}',false)">
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

                    const btn = `<button onclick="qcagDesktopMarkProcessed()" class="qcag-complete-btn${designImgs.length === 0 ? ' qcag-complete-btn--disabled' : ''}" ${designImgs.length === 0 ? `disabled title="${escapeHtml(completeBtnDisabledTitle)}"` : ''}>${escapeHtml(completeBtnLabel)}</button>`;

                    return `<div class="qcag-mq-footer-left"><div class="${creatorClass}">${creatorLine}</div><div class="${editedClass}">${editedLine}</div></div><div class="qcag-mq-footer-right">${btn}</div>`;
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
      try {
        const req = updated.requester;
        const reqObj = typeof req === 'string' ? JSON.parse(req) : (req || {});
        requesterPhone = reqObj.phone || null;
      } catch (_) {}

      if (requesterPhone) {
        const outletLabel = updated.outletName || updated.outletCode || 'Outlet';
        const tkCode = updated.__backendId || updated.outletCode || '';
        const pushTitle = isPendingEdit ? 'QCAG — Đã hoàn thành chỉnh sửa' : 'QCAG — Đã có mẫu quảng cáo (MQ)';
        const pushBody = isPendingEdit
          ? `Yêu cầu ${tkCode} Outlet ${outletLabel} đã được chỉnh sửa. Vui lòng mở app để xem.`
          : `Yêu cầu ${tkCode} Outlet ${outletLabel} đã có MQ. Vui lòng mở app để xem.`;

        fetch('/api/ks/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: pushTitle,
            body: pushBody,
            data: { backendId: updated.__backendId },
            phone: requesterPhone,
          }),
        }).catch(function(e) { console.warn('[push/send]', e); });
      }
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
