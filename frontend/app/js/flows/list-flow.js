// ====================================================================
// js/flows/list-flow.js — request list rendering and tab controls
// ====================================================================
'use strict';

// ── Design-state helper ──────────────────────────────────────────────────
let currentDesignFilter = 'all'; // 'all'|'waiting'|'has_mq'|'editing'
let currentListFilter = 'all';   // 'all'|'has_mq'|'no_mq'|'has_quote'|'no_quote'
let currentListSearchQuery = '';  // free-text search
let currentListSearchDebounce = null;
let currentMobileViewMode = 'gallery'; // 'list' | 'gallery'
let currentPage = 1;
const PAGE_SIZE = 12;

const HK_FILTER_LABELS = {
  all:       'Tất cả',
  has_mq:    'Đã có MQ',
  no_mq:     'Chưa có MQ',
  has_quote: 'Có Báo Giá',
  no_quote:  'Chưa Báo Giá'
};

function selectHkFilter(filterKey) {
  currentListFilter = filterKey || 'all';
  currentDesignFilter = 'all';
  currentPage = 1;
  const labelEl = document.getElementById('hkFilterTriggerLabel');
  if (labelEl) labelEl.textContent = HK_FILTER_LABELS[currentListFilter] || 'Tất cả';

  document.querySelectorAll('#hkFilterMenu .hk-dropdown-opt').forEach(opt => {
    opt.classList.toggle('active', opt.getAttribute('data-val') === currentListFilter);
  });

  updateHkDesktopFilterChipsUI();
  closeHkFilterDropdown();
  renderRequestList();
}

function toggleHkFilterDropdown(e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  closeHkPgDropdown();
  const wrap = document.getElementById('hkFilterDropdownWrap');
  const menu = document.getElementById('hkFilterMenu');
  const arrow = document.getElementById('hkFilterArrowIcon');
  if (!wrap || !menu) return;

  const isOpen = !menu.classList.contains('hidden');
  if (isOpen) {
    closeHkFilterDropdown();
  } else {
    menu.classList.remove('hidden');
    wrap.classList.add('open');
    if (arrow) arrow.style.transform = 'rotate(180deg)';
  }
}

function closeHkFilterDropdown() {
  const wrap = document.getElementById('hkFilterDropdownWrap');
  const menu = document.getElementById('hkFilterMenu');
  const arrow = document.getElementById('hkFilterArrowIcon');
  if (menu) menu.classList.add('hidden');
  if (wrap) wrap.classList.remove('open');
  if (arrow) arrow.style.transform = 'rotate(0deg)';
}

function toggleHkPgDropdown(e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  closeHkFilterDropdown();
  const wrap = document.getElementById('hkPgDropdownWrap');
  const menu = document.getElementById('hkPgMenu');
  const arrow = document.getElementById('hkPgArrowIcon');
  if (!wrap || !menu) return;

  const isOpen = !menu.classList.contains('hidden');
  if (isOpen) {
    closeHkPgDropdown();
  } else {
    menu.classList.remove('hidden');
    wrap.classList.add('open');
    if (arrow) arrow.style.transform = 'rotate(180deg)';
  }
}

function closeHkPgDropdown() {
  const wrap = document.getElementById('hkPgDropdownWrap');
  const menu = document.getElementById('hkPgMenu');
  const arrow = document.getElementById('hkPgArrowIcon');
  if (menu) menu.classList.add('hidden');
  if (wrap) wrap.classList.remove('open');
  if (arrow) arrow.style.transform = 'rotate(0deg)';
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', function(e) {
    const fWrap = document.getElementById('hkFilterDropdownWrap');
    if (fWrap && !fWrap.contains(e.target)) {
      closeHkFilterDropdown();
    }
    const pWrap = document.getElementById('hkPgDropdownWrap');
    if (pWrap && !pWrap.contains(e.target)) {
      closeHkPgDropdown();
    }
  });
}

const DESIGN_FILTER_LABELS = {
  all:              'Tất cả',
  waiting:          'Chờ Thiết Kế',
  has_mq:           'Có Mẫu QC',
  editing:          'Đang Chỉnh Sửa',
  warranty_pending: 'Đang chờ bảo hành',
  warranty_done:    'Đã bảo hành'
};

// Badge config: label + Tailwind classes
const DESIGN_STATE_BADGE = {
  waiting:          { label: 'Chờ TK',       cls: 'bg-gray-100 text-gray-500'   },
  has_mq:           { label: 'Có MQ',         cls: 'bg-gray-900 text-white'      },
  editing:          { label: 'Đang cập nhật', cls: 'bg-gray-700 text-white'      },
  warranty_pending: { label: 'Chờ BH',        cls: 'bg-amber-100 text-amber-700' },
  warranty_done:    { label: 'Đã BH',         cls: 'bg-green-600 text-white'     }
};

// Returns: 'warranty_pending' | 'warranty_done'
function getWarrantyState(req) {
  let acceptImgs = [];
  try { acceptImgs = JSON.parse(req.acceptanceImages || '[]'); } catch (e) {}
  if (acceptImgs && acceptImgs.length > 0 && acceptImgs[0] !== '...') return 'warranty_done';
  // Backward-compat: older records had acceptance photos uploaded to designImages by mistake
  let designImgs = [];
  try { designImgs = JSON.parse(req.designImages || '[]'); } catch (e) {}
  return (designImgs && designImgs.length > 0 && designImgs[0] !== '...') ? 'warranty_done' : 'warranty_pending';
}

/**
 * Chuẩn hóa URL từ Google Cloud Storage để hiển thị công khai
 */
function normalizeGcsUrl(url) {
  const v = String(url || '').trim();
  if (!v || v === '...') return '';
  return v.replace(/^https:\/\/storage\.cloud\.google\.com\/([^/]+)\/(.+)$/i, 'https://storage.googleapis.com/$1/$2');
}

function showRequestListWithFilter(filter) {
  currentDesignFilter = filter || 'all';
  currentPage = 1;
  showRequestList();
}

function showWarrantyListWithFilter(filter) {
  currentListTab = 'warranty';
  currentDesignFilter = filter || 'all';
  // Update tab button styles without resetting the filter
  const t1 = document.getElementById('listTab1Btn');
  const t2 = document.getElementById('listTab2Btn');
  const nc = document.getElementById('newCount');
  const wc = document.getElementById('warrantyCount');
  if (t1) t1.className = 'flex-1 py-2 text-xs sm:text-sm font-medium tab-inactive flex items-center justify-center gap-1.5';
  if (t2) t2.className = 'flex-1 py-2 text-xs sm:text-sm font-semibold tab-active flex items-center justify-center gap-1.5';
  if (nc) nc.className = 'bg-gray-200 text-gray-700 text-[11px] px-1.5 py-0.5 rounded-full font-normal';
  if (wc) wc.className = 'bg-gray-900 text-white text-[11px] px-1.5 py-0.5 rounded-full font-bold';
  showRequestList();
}

function clearDesignFilter() {
  currentDesignFilter = 'all';
  currentPage = 1;
  renderRequestList();
}

function onListSearch(val) {
  currentListSearchQuery = (val || '').trim().toLowerCase();
  currentPage = 1;
  if (currentListSearchDebounce) clearTimeout(currentListSearchDebounce);
  currentListSearchDebounce = setTimeout(() => {
    currentListSearchDebounce = null;
    renderRequestList();
  }, 300);
}
function _hasValidMq(req) {
  if (!req) return false;
  let designImgs = [];
  try {
    designImgs = Array.isArray(req.designImages) ? req.designImages : JSON.parse(req.designImages || '[]');
  } catch (e) {}
  return Array.isArray(designImgs) && designImgs.length > 0 && designImgs[0] && designImgs[0] !== '...';
}

// Returns: 'waiting' | 'has_mq' | 'editing'
// Logic:
//   • No design images → waiting
//   • Has design images + editingRequestedAt → editing
//   • Has design images → has_mq
function getRequestDesignState(req) {
  const hasMq = _hasValidMq(req);
  if (!hasMq) return 'waiting';
  if (req.editingRequestedAt) return 'editing';
  return 'has_mq';
}

// ── Update home screen dashboard stats ──────────────────────────────
function updateHomeStats() {
  const allEl      = document.getElementById('statAll');
  const waitEl     = document.getElementById('statWaiting');
  const hasMqEl    = document.getElementById('statHasMQ');
  const editingEl  = document.getElementById('statEditing');
  const wPendEl    = document.getElementById('statWarrantyPending');
  const wDoneEl    = document.getElementById('statWarrantyDone');
  if (!allEl) return; // home screen not rendered yet

  let waiting = 0, hasMq = 0, editing = 0;
  let warrantyPending = 0, warrantyDone = 0;
  // Only count requests owned by current session
  const ownedRequests = allRequests.filter(r => {
    try {
      const reqOwner = JSON.parse(r.requester || '{}');
      if (!currentSession || !currentSession.saleCode) return false;
      return (reqOwner.saleCode && reqOwner.saleCode === currentSession.saleCode);
    } catch (e) { return false; }
  });
  const newRequests = ownedRequests.filter(r => r.type === 'new');
  newRequests.forEach(req => {
    const state = getRequestDesignState(req);
    if (state === 'waiting') waiting++;
    else if (state === 'has_mq') hasMq++;
    else if (state === 'editing') editing++;
  });
  ownedRequests.filter(r => r.type === 'warranty').forEach(req => {
    let imgs = []; try { imgs = JSON.parse(req.acceptanceImages || '[]'); } catch (e) {}
    // Backward-compat: older records had acceptance images in designImages
    if (!imgs || imgs.length === 0 || imgs[0] === '...') {
      try { const di = JSON.parse(req.designImages || '[]'); if (di.length > 0 && di[0] !== '...') imgs = di; } catch (e) {}
    }
    if (!imgs || imgs.length === 0) warrantyPending++; else warrantyDone++;
  });

  allEl.textContent     = newRequests.length;
  waitEl.textContent    = waiting;
  hasMqEl.textContent   = hasMq;
  editingEl.textContent = editing;
  if (wPendEl) wPendEl.textContent = warrantyPending;
  if (wDoneEl) wDoneEl.textContent = warrantyDone;
  // When initial data is loading, show subtle placeholders instead of zeros (chỉ khi chưa có request nào).
  const reqs = (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) ? allRequests : [];
  if (window._homeStatsLoading && reqs.length === 0) {
    const ph = '…';
    if (allEl) allEl.textContent = ph;
    if (waitEl) waitEl.textContent = ph;
    if (hasMqEl) hasMqEl.textContent = ph;
    if (editingEl) editingEl.textContent = ph;
    if (wPendEl) wPendEl.textContent = ph;
    if (wDoneEl) wDoneEl.textContent = ph;
  }
  // Ẩn thông báo homeLoadNote ngay khi đã có dữ liệu hoặc không còn trạng thái loading
  try {
    const note = document.getElementById('homeLoadNote');
    if (note && (!window._homeStatsLoading || reqs.length > 0)) {
      note.style.display = 'none';
      note.classList.add('hidden');
    }
  } catch (e) {}
}

function updateRequestCount() {
  // Only count requests owned by current session
  const owned = allRequests.filter(r => {
    try {
      const reqOwner = JSON.parse(r.requester || '{}');
      if (!currentSession || !currentSession.saleCode) return false;
      return (reqOwner.saleCode && reqOwner.saleCode === currentSession.saleCode);
    } catch (e) { return false; }
  });
  const newCount = owned.filter(r => r.type === 'new').length;
  const warrantyCount = owned.filter(r => r.type === 'warranty').length;
  try {
    const rc = document.getElementById('requestCount');
    if (rc) rc.textContent = owned.length;
    const nc = document.getElementById('newCount');
    if (nc) nc.textContent = newCount;
    const wc = document.getElementById('warrantyCount');
    if (wc) wc.textContent = warrantyCount;
  } catch (e) {
    console.warn('Failed to update request counters', e);
  }
  try { updateHomeStats(); } catch (e) { console.warn('updateHomeStats error', e); }
  try { updateHkDesktopFilterChipsUI(); } catch (e) {}
}

function _normalizeForMatch(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCardQuoteBadge(req) {
  if (!req) return { hasQuote: false, label: '', cls: '' };

  if (req.type === 'warranty') {
    const dsState = getWarrantyState(req);
    const b = DESIGN_STATE_BADGE[dsState] || DESIGN_STATE_BADGE.warranty_pending;
    return { hasQuote: false, isWarranty: true, label: b.label, cls: b.cls };
  }

  // Hàm tìm quote matching và resolve status
  function _resolveStatusFromQuote(matchedQ) {
    const resolver = (typeof window !== 'undefined' && typeof window._resolveQcagStatus === 'function')
      ? window._resolveQcagStatus
      : (typeof _resolveQcagStatus === 'function' ? _resolveQcagStatus : null);

    if (resolver) {
      const resolved = resolver(matchedQ);
      // Thêm border vào cls nếu chưa có
      const cls = resolved.cls.includes('border') ? resolved.cls : resolved.cls + ' border';
      return { hasQuote: true, label: resolved.label, cls: cls + ' font-bold' };
    }
    return { hasQuote: true, label: 'Chưa có SPO', cls: 'bg-slate-600/30 text-slate-300 border border-slate-500/50 font-bold' };
  }

  // 1. Direct check: embedded quote data từ backend
  let directQuote = null;
  if (req.bridge && (req.bridge.quote_code || req.bridge.quoteCode || (Array.isArray(req.bridge.items) && req.bridge.items.length > 0) || req.bridge.total_amount || req.bridge.totalAmount)) {
    directQuote = req.bridge;
  } else if (req.quoteCode || req.quote_code) {
    const qCodeTarget = String(req.quoteCode || req.quote_code || '').trim();
    if (qCodeTarget && qCodeTarget !== '---' && qCodeTarget !== 'null' && qCodeTarget !== 'undefined' && qCodeTarget !== 'Chưa có code') {
      if (Array.isArray(window.__qcagQuoteListCache)) {
        directQuote = window.__qcagQuoteListCache.find(q =>
          q && String(q.quote_code || q.quoteCode || '').trim() === qCodeTarget
        ) || null;
      }
      if (!directQuote && qCodeTarget) {
        directQuote = {
          quote_code: qCodeTarget,
          quoteCode: qCodeTarget,
          total_amount: req.totalAmount || req.total_amount || 0,
          spo_status: req.spo_status || req.spoStatus || 'Chưa có SPO',
          production_approval_status: req.productionApprovalStatus || req.production_approval_status || ''
        };
      }
    }
  }
  if (directQuote) return _resolveStatusFromQuote(directQuote);

  // 2. Check cached quotes using official tk_code only (Sợi chỉ đỏ tk_code)
  const cached = window.__qcagQuoteListCache;
  if (Array.isArray(cached) && cached.length > 0) {
    const rQCode = String(req.quoteCode || req.quote_code || '').trim();
    const rTkRaw = String(req.tkCode || req.tk_code || '').trim();
    const rTkDigits = rTkRaw.replace(/\D/g, '');

    let matchedQ = null;

    // Match 1: Quote Code (cao nhất)
    if (rQCode && rQCode !== '---' && rQCode !== 'Chưa có code') {
      matchedQ = cached.find(q => q && String(q.quote_code || q.quoteCode || q.id || '').trim() === rQCode) || null;
    }

    // Match 2: TK Code (Sợi chỉ đỏ liên kết App 1 - App 2 — đối chiếu dãy số định danh)
    if (!matchedQ && rTkDigits && rTkDigits.length >= 4) {
      matchedQ = cached.find(q => {
        if (!q) return false;
        const qTkRaw = String(q.tk_code || q.tkCode || q.request_tk_code || q.requestTkCode || '').trim();
        const qTkDigits = qTkRaw.replace(/\D/g, '');
        return (qTkRaw.toLowerCase() === rTkRaw.toLowerCase()) || (qTkDigits.length >= 4 && qTkDigits === rTkDigits);
      }) || null;
    }

    // Match 3: Outlet Code fallback
    if (!matchedQ) {
      const rOutlet = String(req.outletCode || req.outlet_code || '').trim();
      if (rOutlet && rOutlet !== '---' && rOutlet !== 'Chưa có code' && rOutlet !== 'null') {
        matchedQ = cached.find(q => {
          if (!q) return false;
          const qOutlet = String(q.outlet_code || q.outletCode || '').trim();
          return qOutlet && qOutlet.toLowerCase() === rOutlet.toLowerCase();
        }) || null;
      }
    }

    // Match 4: window._quoteDataMap RAM cache
    if (!matchedQ && window._quoteDataMap) {
      matchedQ = (req.__backendId && window._quoteDataMap[req.__backendId]) ||
                 (rTkRaw && window._quoteDataMap[rTkRaw]) ||
                 (rQCode && window._quoteDataMap[rQCode]) || null;
    }

    if (matchedQ) {
      return _resolveStatusFromQuote(matchedQ);
    }
  }

  // 3. If quotes list is NOT loaded yet (đang nạp báo giá từ App 1)
  if (!window.__qcagQuoteListLoaded) {
    if (typeof _fetchApp1QuoteListWithCache === 'function') {
      _fetchApp1QuoteListWithCache().then(() => {
        const listScreen = document.getElementById('listScreen');
        if (listScreen && !listScreen.classList.contains('hidden')) {
          if (typeof renderRequestList === 'function') renderRequestList();
        }
      }).catch(() => {});
    }
    return {
      isLoading: true,
      hasQuote: false,
      label: '...',
      cls: 'bg-slate-700/40 text-slate-400 font-mono tracking-widest animate-pulse px-2 border border-slate-600/30'
    };
  }

  // 4. Quote list finished loading and no quote found
  return { isLoading: false, hasQuote: false, label: '', cls: '' };
}

// Lắng nghe sự kiện nạp xong báo giá để tự động cập nhật nếu đang live ở màn hình danh sách
if (typeof window !== 'undefined') {
  window.addEventListener('qcag:quotes-loaded', () => {
    const listScreen = document.getElementById('listScreen');
    if (listScreen && !listScreen.classList.contains('hidden')) {
      if (typeof renderRequestList === 'function') {
        renderRequestList();
      }
    }
  });
}

// ── Desktop Heineken Workspace Controls & Helpers ───────────────────────────
let currentHkDesktopViewMode = 'grid'; // 'grid' | 'table'

function setHkDesktopViewMode(mode) {
  currentHkDesktopViewMode = mode === 'table' ? 'table' : 'grid';
  const gridBtn = document.getElementById('hkViewGridBtn');
  const tableBtn = document.getElementById('hkViewTableBtn');
  if (gridBtn) gridBtn.classList.toggle('active', currentHkDesktopViewMode === 'grid');
  if (tableBtn) tableBtn.classList.toggle('active', currentHkDesktopViewMode === 'table');
  renderRequestList();
}

function setHkDesktopFilter(filter) {
  if (currentListTab === 'warranty') {
    currentDesignFilter = filter || 'all';
    currentListFilter = 'all';
  } else {
    currentListFilter = filter || 'all';
    currentDesignFilter = 'all';
  }
  currentPage = 1;

  // Sync mobile filter trigger label & dropdown
  const labelEl = document.getElementById('hkFilterTriggerLabel');
  if (labelEl) {
    if (currentListTab === 'warranty') {
      labelEl.textContent = filter === 'warranty_pending' ? 'Chờ BH' : (filter === 'warranty_done' ? 'Đã BH' : 'Tất cả');
    } else {
      labelEl.textContent = HK_FILTER_LABELS[currentListFilter] || 'Tất cả';
    }
  }
  document.querySelectorAll('#hkFilterMenu .hk-dropdown-opt').forEach(opt => {
    opt.classList.toggle('active', opt.getAttribute('data-val') === currentListFilter);
  });

  updateHkDesktopFilterChipsUI();
  renderRequestList();
}

function onHkDesktopSearch(val) {
  currentListSearchQuery = (val || '').trim().toLowerCase();
  currentPage = 1;
  const clearBtn = document.getElementById('hkDesktopSearchClear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !currentListSearchQuery);
  const mobileInput = document.getElementById('listSearchInput');
  if (mobileInput && mobileInput.value !== val) mobileInput.value = val;
  renderRequestList();
}

function clearHkDesktopSearch() {
  const dsi = document.getElementById('hkDesktopSearchInput');
  if (dsi) dsi.value = '';
  const clearBtn = document.getElementById('hkDesktopSearchClear');
  if (clearBtn) clearBtn.classList.add('hidden');
  const mobileInput = document.getElementById('listSearchInput');
  if (mobileInput) mobileInput.value = '';
  currentListSearchQuery = '';
  currentPage = 1;
  renderRequestList();
}

function _renderHkDesktopCardHtml(req, preview, hasDesignPlaceholder, isEditing, dateStr, tkName, lastUpdated, badge) {
  let thumbHtml = '';
  if (preview) {
    thumbHtml = '<div class="hk-card-thumb mq-thumb-editing-wrap cursor-pointer" onclick="event.stopPropagation(); viewDesign(\'' + req.__backendId + '\')" title="' + (isEditing ? 'Đang chỉnh sửa - Bấm xem ảnh tham chiếu' : 'Xem Maquette lớn') + '">' +
      '<img src="' + preview + '" class="' + (isEditing ? 'mq-img-editing' : '') + '" alt="Maquette" loading="lazy">' +
      (isEditing ? '<span class="mq-editing-badge-overlay"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Đang chỉnh sửa</span>' : '') +
    '</div>';
  } else if (hasDesignPlaceholder) {
    thumbHtml = '<div id="thumb-' + req.__backendId + '" class="hk-card-thumb hk-card-thumb-empty" style="animation:pulse 1.5s ease-in-out infinite">' +
      '<svg class="w-7 h-7 text-gray-500 mb-1" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
      '<span class="text-[11px] text-gray-500 font-medium">Đang tải...</span>' +
    '</div>';
  } else if (isEditing) {
    thumbHtml = '<div onclick="event.stopPropagation(); showToast(\'Yêu cầu này đang chờ QCAG chỉnh sửa thiết kế\')" title="Chờ chỉnh sửa thiết kế" class="hk-card-thumb hk-card-thumb-editing cursor-pointer">' +
      '<svg class="w-7 h-7 mx-auto mb-1 text-amber-400" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
      '<span class="text-[11px] text-amber-400 font-semibold">Chờ Chỉnh sửa</span>' +
    '</div>';
  } else {
    thumbHtml = '<div onclick="event.stopPropagation(); showToast(\'Yêu cầu này chưa có MQ\')" title="Không có MQ" class="hk-card-thumb hk-card-thumb-empty cursor-pointer">' +
      '<svg class="w-7 h-7 text-gray-400 mb-1" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
      '<span class="text-[11px] text-gray-400 font-medium">Chưa có MQ</span>' +
    '</div>';
  }

  const displayTk = (tkName && String(tkName).trim() !== '-' && String(tkName).trim() !== 'Chưa nhận') ? tkName : 'Chưa có';
  const displayTime = lastUpdated || 'Chưa có';

  return '<div onclick="showRequestDetail(\'' + req.__backendId + '\')" class="hk-desktop-card" title="Bấm để xem chi tiết">' +
    thumbHtml +
    '<div class="hk-card-body">' +
      '<div class="hk-card-top-row">' +
        '<div class="hk-outlet-name" title="' + (req.outletName || '') + '">' + (req.outletName || 'Chưa có tên') + '</div>' +
        '<div class="hk-code-group">' +
          '<span class="hk-outlet-code"><span class="hk-code-label">Outlet Code:</span>' + (req.outletCode || '---') + '</span>' +
          (req.type === 'warranty' ? '<span class="hk-warranty-tag">Bảo hành</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="hk-card-meta-grid">' +
        '<div class="hk-meta-col">' +
          '<div class="hk-meta-item" title="Ngày gửi: ' + dateStr + '">' +
            '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>' +
            '<span>Gửi: ' + dateStr + '</span>' +
          '</div>' +
          '<div class="hk-meta-item ' + (lastUpdated ? 'text-sky-400' : 'opacity-60') + '" title="' + (lastUpdated ? ('Cập nhật: ' + lastUpdated) : 'Thời gian thiết kế: Chưa có') + '">' +
            '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>' +
            '<span class="truncate">' + displayTime + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="hk-meta-col">' +
          '<div class="hk-meta-item ' + (displayTk === 'Chưa có' ? 'opacity-60' : '') + '" title="Người thiết kế: ' + displayTk + '">' +
            '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>' +
            '<span class="truncate">TK: ' + displayTk + '</span>' +
          '</div>' +
          (badge.label ? ('<div class="hk-meta-item" title="Trạng thái: ' + badge.label + '">' +
            '<span class="hk-card-status-badge ' + badge.cls + '">' + badge.label + '</span>' +
          '</div>') : '') +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="hk-card-footer' + (!badge.hasQuote ? ' hk-card-footer-disabled' : '') + '"' +
      (badge.hasQuote ? ' onclick="event.stopPropagation(); openFullMobileQuoteModal(\'' + req.__backendId + '\')" title="Bấm để xem chi tiết báo giá"' : ' onclick="event.stopPropagation();" title="Yêu cầu này chưa có báo giá"') + '>' +
      ((req.delete_requested || req.deleteRequested) ? ('<span class="hk-delete-warn">' +
        '<span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping"></span> Chờ xóa' +
      '</span>') : '') +
      (badge.isLoading ?
        '<button type="button" disabled class="hk-card-quote-btn hk-card-quote-btn-disabled animate-pulse" title="Đang kiểm tra báo giá...">' +
          '<span class="font-mono tracking-widest">...</span>' +
        '</button>'
      : badge.hasQuote ?
        '<button type="button" class="hk-card-quote-btn" title="Bấm để xem chi tiết báo giá">' +
          '<span>Xem chi tiết báo giá</span>' +
          '<svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/></svg>' +
        '</button>'
      :
        '<button type="button" disabled class="hk-card-quote-btn hk-card-quote-btn-disabled" title="Chưa có báo giá">' +
          '<span>Chưa có báo giá</span>' +
        '</button>'
      ) +
    '</div>' +
  '</div>';
}

function _renderHkDesktopTableHtml(pageSlice) {
  const rows = pageSlice.map(req => {
    const date = new Date(req.createdAt);
    const dateStr = date.toLocaleDateString('vi-VN');
    const badge = getCardQuoteBadge(req);
    const isEditing = !!(req.editingRequestedAt || getRequestDesignState(req) === 'editing');
    const tkName = (req.designCreatedBy || req.designLastEditedBy) ? (req.designCreatedBy || req.designLastEditedBy) : 'Chưa có';
    let preview = '';
    try {
      const imgs = JSON.parse(req.designImages || '[]');
      if (imgs && imgs.length > 0 && imgs[0] !== '...') preview = imgs[0];
      if (!preview && req.type === 'warranty') {
        const aImgs = JSON.parse(req.acceptanceImages || '[]');
        if (aImgs && aImgs.length > 0 && aImgs[0] !== '...') preview = aImgs[0];
      }
    } catch (_) {}

    return '<tr onclick="showRequestDetail(\'' + req.__backendId + '\')" class="cursor-pointer">' +
      '<td class="w-14 text-center">' +
        (preview ? ('<div class="relative inline-block mq-thumb-editing-wrap"><img src="' + preview + '" onclick="event.stopPropagation(); viewDesign(\'' + req.__backendId + '\')" class="w-10 h-10 object-contain rounded bg-slate-900 border border-slate-700 mx-auto ' + (isEditing ? 'mq-img-editing' : '') + '" title="' + (isEditing ? 'Đang chỉnh sửa - Bấm xem Maquette' : 'Xem Maquette') + '">' +
        (isEditing ? '<span class="mq-editing-badge-overlay mq-editing-badge-overlay--mini" title="Đang chỉnh sửa">Sửa</span>' : '') + '</div>') :
        ('<div class="w-10 h-10 rounded bg-slate-800 border border-slate-700 flex items-center justify-center mx-auto text-gray-500">' +
          '<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
        '</div>')) +
      '</td>' +
      '<td><span class="hk-outlet-code">' + (req.outletCode || '---') + '</span></td>' +
      '<td>' +
        '<div class="font-bold text-sm">' + (req.outletName || '-') + '</div>' +
        '<div class="text-[11px] text-gray-400 truncate max-w-xs">' + (req.address || '') + '</div>' +
      '</td>' +
      '<td><span class="text-xs ' + (req.type === 'warranty' ? 'text-amber-400' : 'text-sky-400') + ' font-medium">' + (req.type === 'warranty' ? 'Bảo hành' : 'Yêu cầu mới') + '</span></td>' +
      '<td><span class="text-xs text-gray-400">' + dateStr + '</span></td>' +
      '<td><span class="text-xs font-medium">' + tkName + '</span></td>' +
      '<td>' + (badge.label ? ('<span class="hk-card-status-badge ' + badge.cls + '">' + badge.label + '</span>') : '-') + '</td>' +
      '<td class="text-right">' +
        (badge.isLoading ?
          '<button type="button" disabled class="hk-card-quote-btn hk-card-quote-btn-disabled animate-pulse" title="Đang kiểm tra...">' +
            '<span class="font-mono tracking-widest">...</span>' +
          '</button>'
        : badge.hasQuote ?
          '<button onclick="event.stopPropagation(); openFullMobileQuoteModal(\'' + req.__backendId + '\')" class="hk-card-quote-btn" title="Xem chi tiết báo giá">' +
            '<span>Xem báo giá</span>' +
            '<svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/></svg>' +
          '</button>'
        :
          '<button type="button" disabled class="hk-card-quote-btn hk-card-quote-btn-disabled" title="Chưa có báo giá">' +
            '<span>Chưa có báo giá</span>' +
          '</button>'
        ) +
      '</td>' +
    '</tr>';
  }).join('');

  return '<div class="hk-desktop-table-container">' +
    '<table class="hk-desktop-table-view">' +
      '<thead>' +
        '<tr>' +
          '<th class="w-14 text-center">MQ</th>' +
          '<th>Mã Outlet</th>' +
          '<th>Tên Điểm Bán / Địa chỉ</th>' +
          '<th>Loại</th>' +
          '<th>Ngày gửi</th>' +
          '<th>Thiết kế</th>' +
          '<th>Trạng thái</th>' +
          '<th class="text-right">Thao tác</th>' +
        '</tr>' +
      '</thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>' +
  '</div>';
}

function updateHkDesktopMiniPagination(page, total, totalItems) {
  const container = document.getElementById('hkDesktopMiniPagination');
  if (!container) return;

  const prevBtn = document.getElementById('hkMiniPrevBtn');
  const nextBtn = document.getElementById('hkMiniNextBtn');
  const input   = document.getElementById('hkMiniPageInput');
  const totalEl = document.getElementById('hkMiniPageTotal');

  if (total <= 1) {
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    if (input) {
      input.disabled = true;
      input.value = 1;
      input.max = 1;
      input.style.width = '24px';
    }
    if (totalEl) totalEl.textContent = '1';
    return;
  }

  if (prevBtn) prevBtn.disabled = (page <= 1);
  if (nextBtn) nextBtn.disabled = (page >= total);
  if (input) {
    input.disabled = false;
    input.value = page;
    input.max = total;
    input.style.width = (String(page).length > 2 ? '34px' : (String(page).length > 1 ? '28px' : '24px'));
  }
  if (totalEl) totalEl.textContent = total;
}

window.onHkMiniPageChange = function(val) {
  let page = parseInt(val, 10);
  if (isNaN(page) || page < 1) page = 1;
  const total = parseInt(document.getElementById('hkMiniPageTotal')?.textContent || '1', 10);
  if (page > total) page = total;
  const input = document.getElementById('hkMiniPageInput');
  if (input) input.value = page;
  if (typeof goToPage === 'function') goToPage(page);
};

function renderHkDesktopPagination(page, total, totalItems) {
  updateHkDesktopMiniPagination(page, total, totalItems);
  const container = document.getElementById('hkDesktopPagination');
  if (container) container.innerHTML = '';
}


function _isRequestOwnedBySession(r) {
  try {
    if (!r) return false;
    const role = (currentSession && currentSession.role) ? String(currentSession.role).toLowerCase() : '';
    if (role === 'qcag' || role === 'admin') return true;
    const reqOwner = typeof r.requester === 'object' && r.requester !== null
      ? r.requester
      : JSON.parse(r.requester || '{}');
    if (!currentSession) return false;
    const curCode = String(currentSession.saleCode || currentSession.userCode || '').trim().toLowerCase();
    const ownerCode = String(reqOwner.saleCode || reqOwner.userCode || '').trim().toLowerCase();
    if (curCode && ownerCode && curCode === ownerCode) return true;
    const curPhone = String(currentSession.phone || '').replace(/\D/g, '');
    const ownerPhone = String(reqOwner.phone || r.phone || '').replace(/\D/g, '');
    if (curPhone && ownerPhone && curPhone.length >= 9 && ownerPhone.length >= 9 && curPhone === ownerPhone) return true;
    return false;
  } catch (e) { return false; }
}

function updateHkDesktopFilterChipsUI() {
  const chipsWrap = document.getElementById('hkDesktopFilterChips');
  if (!chipsWrap) return;

  const isWarranty = currentListTab === 'warranty';

  // 1. Calculate owned requests for live chip badges
  const owned = (typeof allRequests !== 'undefined' && Array.isArray(allRequests))
    ? allRequests.filter(_isRequestOwnedBySession)
    : [];

  const ownedNew = owned.filter(r => r.type === 'new');
  const ownedWarranty = owned.filter(r => r.type === 'warranty');

  // Count badges for New
  const countAllNew = ownedNew.length;
  const countHasMq = ownedNew.filter(r => _hasValidMq(r)).length;
  const countNoMq = ownedNew.filter(r => !_hasValidMq(r)).length;
  const countHasQuote = ownedNew.filter(r => {
    const b = getCardQuoteBadge(r);
    return b && b.hasQuote;
  }).length;
  const countNoQuote = ownedNew.filter(r => {
    const b = getCardQuoteBadge(r);
    return !b || (!b.hasQuote && !b.isWarranty);
  }).length;

  // Count badges for Warranty
  const countAllWarranty = ownedWarranty.length;
  const countWarPending = ownedWarranty.filter(r => getWarrantyState(r) === 'warranty_pending').length;
  const countWarDone = ownedWarranty.filter(r => getWarrantyState(r) === 'warranty_done').length;

  // Set badge text
  const elAll = document.getElementById('hkChipCountAll');
  if (elAll) elAll.textContent = isWarranty ? countAllWarranty : countAllNew;

  const elHasMq = document.getElementById('hkChipCountHasMq');
  if (elHasMq) elHasMq.textContent = countHasMq;

  const elNoMq = document.getElementById('hkChipCountNoMq');
  if (elNoMq) elNoMq.textContent = countNoMq;

  const elHasQuote = document.getElementById('hkChipCountHasQuote');
  if (elHasQuote) elHasQuote.textContent = countHasQuote;

  const elNoQuote = document.getElementById('hkChipCountNoQuote');
  if (elNoQuote) elNoQuote.textContent = countNoQuote;

  const elWarPending = document.getElementById('hkChipCountWarPending');
  if (elWarPending) elWarPending.textContent = countWarPending;

  const elWarDone = document.getElementById('hkChipCountWarDone');
  if (elWarDone) elWarDone.textContent = countWarDone;

  // 2. Update active & visibility states of chips
  const chips = chipsWrap.querySelectorAll('.hk-filter-chip');
  chips.forEach(c => {
    const f = c.getAttribute('data-filter');

    if (isWarranty) {
      if (f === 'warranty_pending' || f === 'warranty_done' || f === 'all') {
        c.classList.remove('hidden');
      } else {
        c.classList.add('hidden');
      }

      if (f === 'all') {
        c.classList.toggle('active', currentDesignFilter === 'all');
      } else {
        c.classList.toggle('active', currentDesignFilter === f);
      }
    } else {
      if (f === 'has_mq' || f === 'no_mq' || f === 'has_quote' || f === 'no_quote' || f === 'all') {
        c.classList.remove('hidden');
      } else {
        c.classList.add('hidden');
      }

      if (f === 'all') {
        c.classList.toggle('active', currentListFilter === 'all' && currentDesignFilter === 'all');
      } else if (f === 'no_mq') {
        c.classList.toggle('active', currentListFilter === 'no_mq' || currentDesignFilter === 'waiting');
      } else {
        c.classList.toggle('active', currentListFilter === f);
      }
    }
  });
}

function updateHkDesktopToolbarUI(filteredCount, newTotal, warrantyTotal) {
  const totalBadge = document.getElementById('hkDesktopTotalBadge');
  if (totalBadge) totalBadge.textContent = (filteredCount || 0) + ' yêu cầu';

  const newCountEl = document.getElementById('hkDesktopNewCount');
  if (newCountEl) newCountEl.textContent = newTotal || 0;

  const warCountEl = document.getElementById('hkDesktopWarrantyCount');
  if (warCountEl) warCountEl.textContent = warrantyTotal || 0;

  const tabNew = document.getElementById('hkDesktopTabNew');
  const tabWar = document.getElementById('hkDesktopTabWarranty');
  if (tabNew && tabWar) {
    if (currentListTab === 'new') {
      tabNew.classList.add('active');
      tabWar.classList.remove('active');
    } else {
      tabWar.classList.add('active');
      tabNew.classList.remove('active');
    }
  }

  const userEl = document.getElementById('hkDesktopUserText');
  if (userEl && typeof currentSession !== 'undefined' && currentSession) {
    const name = currentSession.saleName || currentSession.name || 'Sale Heineken';
    const region = currentSession.region ? ' (' + currentSession.region + ')' : '';
    userEl.textContent = name + region;
  }

  updateHkDesktopFilterChipsUI();
}

function renderRequestList() {
  const hasSearch = !!currentListSearchQuery;
  let filtered = hasSearch ? allRequests.slice() : allRequests.filter(r => r.type === currentListTab);

  // Restrict visibility: users only see requests they created
  filtered = filtered.filter(_isRequestOwnedBySession);

  // Apply design-state / warranty-status filter
  if (!hasSearch && currentDesignFilter === 'warranty_pending') {
    filtered = filtered.filter(r => {
      let imgs = []; try { imgs = JSON.parse(r.acceptanceImages || '[]'); } catch (e) {}
      if (imgs && imgs.length > 0 && imgs[0] !== '...') return false;
      try { const di = JSON.parse(r.designImages || '[]'); if (di.length > 0 && di[0] !== '...') return false; } catch (e) {}
      return true;
    });
  } else if (!hasSearch && currentDesignFilter === 'warranty_done') {
    filtered = filtered.filter(r => {
      let imgs = []; try { imgs = JSON.parse(r.acceptanceImages || '[]'); } catch (e) {}
      if (imgs && imgs.length > 0 && imgs[0] !== '...') return true;
      try { const di = JSON.parse(r.designImages || '[]'); if (di.length > 0 && di[0] !== '...') return true; } catch (e) {}
      return false;
    });
  } else if (!hasSearch && currentDesignFilter !== 'all') {
    filtered = filtered.filter(r => getRequestDesignState(r) === currentDesignFilter);
  }

  // Apply dropdown filter (Đã có MQ | Chưa có MQ | Đã có Báo Giá | Chưa có Báo Giá)
  if (currentListFilter === 'has_mq') {
    filtered = filtered.filter(r => _hasValidMq(r));
  } else if (currentListFilter === 'no_mq') {
    // Chưa có MQ: chỉ các yêu cầu chưa có bản vẽ Maquette nào
    filtered = filtered.filter(r => !_hasValidMq(r));
  } else if (currentListFilter === 'has_quote') {
    filtered = filtered.filter(r => {
      const b = getCardQuoteBadge(r);
      return b && b.hasQuote;
    });
  } else if (currentListFilter === 'no_quote') {
    filtered = filtered.filter(r => {
      const b = getCardQuoteBadge(r);
      return !b || (!b.hasQuote && !b.isWarranty);
    });
  }

  // Apply text search (outlet name / code / address / designer / requester)
  if (currentListSearchQuery) {
    const q = currentListSearchQuery;
    filtered = filtered.filter(r => {
      let requester = {};
      try { requester = JSON.parse(r.requester || '{}') || {}; } catch (e) {}
      return (r.tkCode || '').toLowerCase().includes(q) ||
        (requester.saleName || requester.saleCode || requester.phone || '').toLowerCase().includes(q) ||
        (requester.ssName || '').toLowerCase().includes(q) ||
        (r.outletName || '').toLowerCase().includes(q) ||
        (r.outletCode || '').toLowerCase().includes(q) ||
        (r.designCreatedBy || '').toLowerCase().includes(q) ||
        (r.designLastEditedBy || '').toLowerCase().includes(q) ||
        (r.address || '').toLowerCase().includes(q) ||
        (r.designFilename || '').toLowerCase().includes(q);
    });
  }

  // Calculate stats for Desktop Toolbar & counters
  const ownedAll = (allRequests || []).filter(_isRequestOwnedBySession);
  const newTotalCount = ownedAll.filter(r => r.type === 'new').length;
  const warTotalCount = ownedAll.filter(r => r.type === 'warranty').length;
  updateHkDesktopToolbarUI(filtered.length, newTotalCount, warTotalCount);

  // Update filter banner
  const banner   = document.getElementById('designFilterBanner');
  const labelEl  = document.getElementById('designFilterLabel');
  if (banner && labelEl) {
    if (currentDesignFilter !== 'all') {
      banner.classList.remove('hidden');
      labelEl.textContent = DESIGN_FILTER_LABELS[currentDesignFilter] || currentDesignFilter;
    } else {
      banner.classList.add('hidden');
    }
  }
  const container = document.getElementById('requestList');
  const emptyState = document.getElementById('emptyState');
  const pgEl = document.getElementById('requestListPagination');
  const dpgEl = document.getElementById('hkDesktopPagination');
  const bpgEl = document.getElementById('requestListBottomPagination');

  // Update filtered count badge inside filter trigger button
  const countEl = document.getElementById('hkFilterBadgeCount') || document.getElementById('hkFilteredCountNum');
  if (countEl) {
    countEl.textContent = filtered.length;
    countEl.classList.toggle('active', currentListFilter !== 'all');
  }

  if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
    container.innerHTML = '';
    if (pgEl) pgEl.innerHTML = renderPaginationHTML(1, 1);
    if (bpgEl) bpgEl.innerHTML = '';
    if (dpgEl) dpgEl.innerHTML = '';
    updateHkDesktopMiniPagination(1, 1, 0);
    const totalBadge = document.getElementById('hkDesktopTotalBadge');
    if (totalBadge) totalBadge.textContent = '0 yêu cầu';
    return;
  }

  emptyState.classList.add('hidden');

  const isDesktop = window.innerWidth >= 1024;
  const effectivePageSize = isDesktop ? 16 : PAGE_SIZE;

  // Pagination: slice to current page
  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / effectivePageSize);
  if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;
  const pageSlice = filtered.slice((currentPage - 1) * effectivePageSize, currentPage * effectivePageSize);

  // Track which entries need lazy image load (have placeholder ["..."])
  const lazyLoadIds = [];

  if (isDesktop) {
    if (currentHkDesktopViewMode === 'table') {
      container.className = 'w-full';
      container.innerHTML = _renderHkDesktopTableHtml(pageSlice);
    } else {
      container.className = 'hk-desktop-grid-view';
      container.innerHTML = pageSlice.map(req => {
        const date = new Date(req.createdAt);
        const dateStr = date.toLocaleDateString('vi-VN');
        const badge = getCardQuoteBadge(req);
        const tkName = req.designCreatedBy || req.designLastEditedBy || null;
        const isEditing = !!(req.editingRequestedAt || getRequestDesignState(req) === 'editing');
        const lastUpdated = req.designLastEditedAt ? (() => {
          const d = new Date(req.designLastEditedAt);
          return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        })() : null;
        let preview = '';
        let hasDesignPlaceholder = false;
        try {
          const imgs = JSON.parse(req.designImages || '[]');
          if (imgs && imgs.length > 0) {
            if (imgs[0] === '...') {
              hasDesignPlaceholder = true;
              lazyLoadIds.push(req.__backendId);
            } else {
              preview = imgs[0];
            }
          }
          if (!preview && !hasDesignPlaceholder && req.type === 'warranty') {
            const aImgs = JSON.parse(req.acceptanceImages || '[]');
            if (aImgs && aImgs.length > 0) {
              if (aImgs[0] === '...') {
                hasDesignPlaceholder = true;
                lazyLoadIds.push(req.__backendId);
              } else {
                preview = aImgs[0];
              }
            }
          }
        } catch (e) { preview = ''; }

        return _renderHkDesktopCardHtml(req, preview, hasDesignPlaceholder, isEditing, dateStr, tkName, lastUpdated, badge);
      }).join('');
    }
    // Render desktop pagination
    renderHkDesktopPagination(currentPage, Math.max(1, totalPages), totalItems);
    if (pgEl) pgEl.innerHTML = '';
    if (bpgEl) bpgEl.innerHTML = '';
  } else {
    // Mobile rendering (100% preserve existing mobile layout)
    if (currentMobileViewMode === 'gallery') {
      container.className = 'grid grid-cols-2 gap-2.5 items-stretch';
    } else {
      container.className = 'space-y-2.5';
    }

    container.innerHTML = pageSlice.map(req => {
    const date = new Date(req.createdAt);
    const dateStr = date.toLocaleDateString('vi-VN');
    const badge = getCardQuoteBadge(req);
    const tkName = req.designCreatedBy || req.designLastEditedBy || null;
    const isEditing = !!(req.editingRequestedAt || getRequestDesignState(req) === 'editing');
    const lastUpdated = req.designLastEditedAt ? (() => {
      const d = new Date(req.designLastEditedAt);
      return d.toLocaleDateString('vi-VN', {day:'2-digit',month:'2-digit',year:'2-digit'}) + ' ' + d.toLocaleTimeString('vi-VN', {hour:'2-digit',minute:'2-digit'});
    })() : null;
    let preview = '';
    let hasDesignPlaceholder = false;
    try {
      const imgs = JSON.parse(req.designImages || '[]');
      if (imgs && imgs.length > 0) {
        if (imgs[0] === '...') {
          // List endpoint returned placeholder — lazy-load real URL after render
          hasDesignPlaceholder = true;
          lazyLoadIds.push(req.__backendId);
        } else {
          preview = imgs[0];
        }
      }
      // For warranty requests: if designImages is empty, fall back to acceptanceImages
      if (!preview && !hasDesignPlaceholder && req.type === 'warranty') {
        const aImgs = JSON.parse(req.acceptanceImages || '[]');
        if (aImgs && aImgs.length > 0) {
          if (aImgs[0] === '...') {
            hasDesignPlaceholder = true;
            lazyLoadIds.push(req.__backendId);
          } else {
            preview = aImgs[0];
          }
        }
      }
    } catch (e) { preview = ''; }

    let thumbHtml;
    let fallbackIconHtml = `<svg class="w-6 h-6 mx-auto mb-1 text-gray-400" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    
    // Check if gallery mode to determine thumb width/height
    if (currentMobileViewMode === 'gallery') {
       if (preview) {
         thumbHtml = `<div class="relative w-full h-20 mq-thumb-editing-wrap cursor-pointer" onclick="event.stopPropagation(); viewDesign('${req.__backendId}')" title="${isEditing ? 'Đang chỉnh sửa - Bấm xem ảnh tham chiếu' : 'Xem thiết kế'}">
              <img src="${preview}" class="w-full h-20 object-contain rounded-t-xl ${isEditing ? 'mq-img-editing' : ''}">
              ${isEditing ? `<span class="mq-editing-badge-overlay"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Đang chỉnh sửa</span>` : ''}
             </div>`;
       } else if (hasDesignPlaceholder) {
         thumbHtml = `<div id="thumb-${req.__backendId}" class="hk-card-thumb w-full h-20 rounded-t-xl flex items-center justify-center p-2 text-center" style="animation:pulse 1.5s ease-in-out infinite">
              <svg class="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
             </div>`;
       } else if (isEditing) {
         // Chờ chỉnh sửa: Đổi màu cho dễ nhận biết (Amber/Cam) + Icon chỉnh sửa
         thumbHtml = `<div onclick="event.stopPropagation(); showToast('Yêu cầu này đang chờ QCAG chỉnh sửa thiết kế')" title="Chờ chỉnh sửa thiết kế" class="hk-card-thumb hk-card-thumb-editing w-full h-20 rounded-t-xl flex flex-col items-center justify-center p-1.5 text-center cursor-pointer">
              <svg class="w-6 h-6 mx-auto mb-1" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              <span class="text-[11px] hk-card-thumb-text-editing">Chờ Chỉnh sửa</span>
             </div>`;
       } else {
         // Chưa có MQ: Giữ nguyên như hiện tại
         thumbHtml = `<div onclick="event.stopPropagation(); showToast('Yêu cầu này chưa có MQ')" title="Không có MQ" class="hk-card-thumb w-full h-20 rounded-t-xl flex flex-col items-center justify-center p-1.5 text-center cursor-pointer">
              ${fallbackIconHtml}
              <span class="text-[11px] hk-card-thumb-text">Chưa có MQ</span>
             </div>`;
       }

       return `
        <div onclick="showRequestDetail('${req.__backendId}')" class="hk-list-card bg-gray-50 active:bg-gray-100 cursor-pointer flex flex-col shadow-sm border border-gray-100 overflow-hidden rounded-xl h-full">
          ${thumbHtml}
          <div class="px-2 pt-2 pb-1 flex-1 flex flex-col gap-[2px]">
            <div class="hk-outlet-name line-clamp-2 leading-snug">${req.outletName}</div>
            <div class="hk-outlet-code text-[11px] font-medium truncate">${req.outletCode}</div>
            <div class="hk-card-date text-[10px]">Gửi: ${dateStr}</div>
            ${tkName ? `<div class="hk-card-tk text-[10px] truncate">TK: ${tkName}</div>` : ''}
            ${lastUpdated ? `<div class="hk-card-updated text-[10px] truncate whitespace-nowrap">${lastUpdated}</div>` : ''}
            <div class="mt-auto pt-1 flex flex-col gap-0.5 min-h-[16px]">
              ${badge.isLoading ? `
                <span class="text-[9.5px] px-2 py-0.5 rounded-full ${badge.cls} shadow-sm whitespace-nowrap overflow-hidden inline-block leading-tight font-mono tracking-widest">...</span>
              ` : (badge.hasQuote || badge.isWarranty) ? `
                <span class="text-[9.5px] px-1.5 py-0.5 rounded-full ${badge.cls} shadow-sm whitespace-nowrap overflow-hidden inline-block max-w-full leading-tight" style="text-overflow:ellipsis">${badge.label}</span>
              ` : ''}
              ${req.deleteRequested ? `<div class="hk-delete-pending-tag text-[9px] py-0.5">Đang chờ QCAG xóa</div>` : ''}
            </div>
          </div>
          ${badge.isLoading ? `
            <button type="button" class="hk-quote-link-btn hk-quote-empty-btn animate-pulse" title="Đang kiểm tra báo giá...">
              <span class="font-mono tracking-widest">...</span>
            </button>
          ` : badge.hasQuote ? `
            <button onclick="event.stopPropagation(); openFullMobileQuoteModal('${req.__backendId}')" class="hk-quote-link-btn">
              <span>Xem chi tiết báo giá</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          ` : `
            <button type="button" disabled class="hk-quote-link-btn hk-quote-empty-btn pointer-events-none opacity-60 cursor-not-allowed" title="Chưa có báo giá">
              <span>Chưa có báo giá</span>
            </button>
          `}
        </div>
      `;
    } else {
       // List Mode HTML
       if (preview) {
         thumbHtml = `<div class="relative w-20 h-14 mq-thumb-editing-wrap flex-shrink-0 cursor-pointer" onclick="event.stopPropagation(); viewDesign('${req.__backendId}')" title="${isEditing ? 'Đang chỉnh sửa - Bấm xem ảnh tham chiếu' : 'Xem thiết kế'}">
              <img src="${preview}" class="w-20 h-14 object-contain rounded-lg ${isEditing ? 'mq-img-editing' : ''}">
              ${isEditing ? `<span class="mq-editing-badge-overlay mq-editing-badge-overlay--mini">Sửa</span>` : ''}
             </div>`;
       } else if (hasDesignPlaceholder) {
         thumbHtml = `<div id="thumb-${req.__backendId}" class="hk-card-thumb w-20 h-14 rounded-lg flex items-center justify-center" style="animation:pulse 1.5s ease-in-out infinite">
              <svg class="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
             </div>`;
       } else if (isEditing) {
         thumbHtml = `<button onclick="event.stopPropagation(); showToast('Yêu cầu này đang chờ QCAG chỉnh sửa thiết kế')" title="Chờ chỉnh sửa thiết kế" class="hk-card-thumb hk-card-thumb-editing w-20 h-14 rounded-lg flex flex-col items-center justify-center p-1">
              <svg class="w-5 h-5 mb-0.5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              <span class="text-[9px] hk-card-thumb-text-editing leading-none">Chờ sửa</span>
             </button>`;
       } else {
         thumbHtml = `<button onclick="event.stopPropagation(); showToast('Yêu cầu này chưa có MQ')" title="Không có MQ" class="hk-card-thumb w-20 h-14 rounded-lg flex items-center justify-center">
              <svg class="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
             </button>`;
       }

       return `
         <div onclick="showRequestDetail('${req.__backendId}')" class="hk-list-card bg-gray-50 rounded-xl p-3 active:bg-gray-100 cursor-pointer flex flex-col">
           <div class="flex items-start gap-3">
             <div class="flex-shrink-0">${thumbHtml}</div>
             <div class="flex-1 min-w-0">
               <div class="hk-outlet-name leading-tight mb-0.5">${req.outletName}</div>
               <div class="hk-outlet-code text-xs font-medium truncate mb-0.5">${req.outletCode}</div>
               <div class="hk-card-date text-xs">Gửi: ${dateStr}</div>
               ${tkName ? `<div class="hk-card-tk text-xs truncate">TK: ${tkName}</div>` : ''}
               ${lastUpdated ? `<div class="hk-card-updated text-xs truncate whitespace-nowrap">${lastUpdated}</div>` : ''}
               <div class="mt-1.5 flex items-center gap-1.5 flex-wrap min-w-0">
                 ${badge.isLoading ? `
                   <span class="text-xs px-2 py-0.5 rounded-full ${badge.cls} shadow-sm whitespace-nowrap overflow-hidden inline-block font-mono tracking-widest">...</span>
                 ` : (badge.hasQuote || badge.isWarranty) ? `
                   <span class="text-xs px-1.5 py-0.5 rounded-full ${badge.cls} whitespace-nowrap overflow-hidden inline-block" style="max-width:100%;text-overflow:ellipsis">${badge.label}</span>
                 ` : ''}
                 ${req.deleteRequested ? `<span class="hk-delete-pending-badge">Đang chờ QCAG xóa</span>` : ''}
               </div>
             </div>
             <svg class="w-4 h-4 text-gray-300 flex-shrink-0 mt-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
             </svg>
           </div>
           ${badge.isLoading ? `
             <button type="button" class="hk-quote-link-btn hk-quote-empty-btn mt-auto animate-pulse" title="Đang kiểm tra báo giá...">
               <span class="font-mono tracking-widest">...</span>
             </button>
           ` : badge.hasQuote ? `
             <button onclick="event.stopPropagation(); openFullMobileQuoteModal('${req.__backendId}')" class="hk-quote-link-btn mt-auto">
               <span>Xem chi tiết báo giá</span>
               <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
             </button>
           ` : `
             <button type="button" disabled class="hk-quote-link-btn hk-quote-empty-btn mt-auto pointer-events-none opacity-60 cursor-not-allowed" title="Chưa có báo giá">
               <span>Chưa có báo giá</span>
             </button>
           `}
         </div>
       `;
    }
    }).join('');

    // Update pagination controls in header and bottom (Mobile)
    const pgHtml = renderPaginationHTML(currentPage, Math.max(1, totalPages));
    if (pgEl) pgEl.innerHTML = pgHtml;
    if (bpgEl) bpgEl.innerHTML = totalPages > 1 ? pgHtml : '';
    if (dpgEl) dpgEl.innerHTML = '';
  }

  // Store filtered list for gallery swipe-navigation between outlets
  window._dvOutletList = filtered.slice();

  // Preload only the current page first-thumbnail images.
  // Preloading the entire filtered dataset can freeze weak devices.
  requestAnimationFrame(() => {
    pageSlice.forEach(req => {
      try {
        const imgs = JSON.parse(req.designImages || '[]').filter(u => u && u !== '...');
        if (imgs.length > 0) {
          const p = new Image();
          p.src = imgs[0];
        }
      } catch (e) {}
    });
  });

  // Lazy-load real thumbnails for placeholder entries in parallel
  if (lazyLoadIds.length > 0 && window.dataSdk && typeof window.dataSdk.getOne === 'function') {
    (async () => {
      const lazyQueue = lazyLoadIds.slice(0, 8);
      const fetchPromises = lazyQueue.map(async (backendId) => {
        try {
          const r = await window.dataSdk.getOne(backendId);
          if (!r || !r.isOk || !r.data) return;

          const reqEntry = allRequests.find(x => x.__backendId === backendId);
          const isWarrantyEntry = reqEntry && reqEntry.type === 'warranty';

          // Lấy và chuẩn hóa danh sách ảnh
          let imgs = [];
          try { imgs = JSON.parse(r.data.designImages || '[]').filter(u => u && u !== '...'); } catch (e) {}

          if (isWarrantyEntry && imgs.length === 0) {
            try { imgs = JSON.parse(r.data.acceptanceImages || '[]').filter(u => u && u !== '...'); } catch (e) {}
          }
          if (!imgs.length) return;

          const thumbUrl = normalizeGcsUrl(imgs[0]);
          const thumbEl = document.getElementById('thumb-' + backendId);
          if (!thumbEl) return;

          const img = document.createElement('img');
          img.src = thumbUrl;
          img.title = 'Xem thiết kế';
          img.onclick = (e) => { e.stopPropagation(); viewDesign(backendId); };
          img.onerror = () => { img.src = 'app/assets/broken-image.png'; };

          if (window.innerWidth >= 1024) {
            img.className = 'w-full h-full object-contain cursor-pointer';
            thumbEl.innerHTML = '';
            thumbEl.style.animation = '';
            thumbEl.onclick = (e) => { e.stopPropagation(); viewDesign(backendId); };
            thumbEl.title = 'Xem Maquette lớn';
            thumbEl.appendChild(img);
          } else if (currentMobileViewMode === 'gallery') {
            img.className = 'w-full h-28 object-contain bg-slate-900 rounded-t-xl cursor-pointer';
            thumbEl.replaceWith(img);
          } else {
            img.className = 'w-20 h-14 object-contain bg-slate-900 rounded-lg cursor-pointer';
            thumbEl.replaceWith(img);
          }

          // Cập nhật local store để lần sau không cần load lại
          const localIdx = allRequests.findIndex(x => x.__backendId === backendId);
          if (localIdx !== -1) {
            ['designImages', 'statusImages', 'acceptanceImages', 'oldContentImages'].forEach(k => {
              if (r.data[k] && r.data[k] !== '["..."]') allRequests[localIdx][k] = r.data[k];
            });
          }
        } catch (e) {
          console.warn('Lazy load error:', e);
        }
      });
      await Promise.all(fetchPromises);
    })();
  }

  // Trigger Mobile Whats New modal (shown only once per version)
  try {
    if (typeof checkAndShowMobileWhatsNewModal === 'function') {
      setTimeout(() => checkAndShowMobileWhatsNewModal(), 500);
    }
  } catch (_) {}
}

function checkAndShowMobileWhatsNewModal() {
  const CURRENT_VERSION = 'v3.0.0';
  
  // Only show on Mobile view (< 768px or if mobile element exists)
  if (window.innerWidth >= 768) return;

  // Check if user has already seen this version
  let seenVersion = '';
  try {
    seenVersion = localStorage.getItem('ks_whats_new_version');
  } catch (_) {}

  if (seenVersion === CURRENT_VERSION) return;

  // Don't duplicate if already open
  if (document.getElementById('mobileWhatsNewModal')) return;

  const modalHtml = `
    <div id="mobileWhatsNewModal" class="fixed inset-0 z-[9999] bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn">
      <div class="w-full max-w-sm bg-slate-900 border border-slate-700/80 rounded-2xl p-5 shadow-2xl space-y-4 text-white relative overflow-hidden">
        
        <!-- Top Accent Light -->
        <div class="absolute -top-12 -right-12 w-32 h-32 bg-emerald-500/20 rounded-full blur-2xl pointer-events-none"></div>

        <!-- Header -->
        <div class="flex items-center justify-between">
          <span class="px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wider rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 shadow-sm">
            ✨ Cập nhật mới ${CURRENT_VERSION}
          </span>
          <button onclick="closeMobileWhatsNewModal('${CURRENT_VERSION}')" class="text-gray-400 hover:text-white text-lg font-bold w-7 h-7 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700 active:scale-95">✕</button>
        </div>

        <div>
          <h3 class="text-lg font-extrabold text-white leading-tight">Tính Năng Mới Đã Sẵn Sàng!</h3>
          <p class="text-xs text-gray-300 mt-1">Trải nghiệm ngay các cải tiến vượt trội giúp theo dõi báo giá & xác nhận sản xuất siêu tốc.</p>
        </div>

        <!-- Updates List -->
        <div class="space-y-3 pt-1">
          <!-- Update 1 -->
          <div class="bg-slate-800/90 border border-slate-700/60 rounded-xl p-3 flex items-start gap-3">
            <div class="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center text-base flex-shrink-0 font-bold">⚡</div>
            <div class="space-y-0.5">
              <h4 class="text-xs font-bold text-emerald-300">Báo Giá Tức Thì & Chi Tiết (0s)</h4>
              <p class="text-[11px] text-gray-300 leading-relaxed">
                Tự động nhận diện nhãn <strong class="text-emerald-400">Đã có báo giá</strong>, xem nhanh giá tổng 1 dòng và mở bảng báo giá chi tiết full-screen kèm ảnh Maquette.
              </p>
            </div>
          </div>

          <!-- Update 2 -->
          <div class="bg-slate-800/90 border border-slate-700/60 rounded-xl p-3 flex items-start gap-3">
            <div class="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center justify-center text-base flex-shrink-0 font-bold">🏭</div>
            <div class="space-y-0.5">
              <h4 class="text-xs font-bold text-amber-300">Xác Nhận Sản Xuất Cải Tiến</h4>
              <p class="text-[11px] text-gray-300 leading-relaxed">
                Luôn tự động mở tab <strong class="text-amber-400">Chờ duyệt</strong> đầu tiên và hiển thị ảnh Preview Maquette sắc nét cho từng thẻ sản xuất.
              </p>
            </div>
          </div>
        </div>

        <!-- Action Button -->
        <div class="pt-2">
          <button onclick="closeMobileWhatsNewModal('${CURRENT_VERSION}')" class="w-full py-3 px-4 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 active:scale-[0.98] text-slate-950 font-extrabold text-xs rounded-xl shadow-lg transition-all flex items-center justify-center gap-2">
            <span>🚀 Đã hiểu & Khám phá ngay</span>
          </button>
        </div>

      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function closeMobileWhatsNewModal(versionStr) {
  const modal = document.getElementById('mobileWhatsNewModal');
  if (modal) modal.remove();
  try {
    localStorage.setItem('ks_whats_new_version', versionStr || 'v3.0.0');
  } catch (_) {}
}

function switchListTab(tab) {
  currentListTab = tab;
  currentDesignFilter = 'all';        // reset design filter
  currentListFilter = 'all';          // reset dropdown filter
  currentListSearchQuery = '';        // reset search
  const si = document.getElementById('listSearchInput');
  if (si) si.value = '';
  const dsi = document.getElementById('hkDesktopSearchInput');
  if (dsi) dsi.value = '';
  const dclr = document.getElementById('hkDesktopSearchClear');
  if (dclr) dclr.classList.add('hidden');
  updateHkDesktopFilterChipsUI();
  const fl = document.getElementById('hkFilterTriggerLabel');
  if (fl) fl.textContent = 'Tất cả';
  document.querySelectorAll('#hkFilterMenu .hk-dropdown-opt').forEach(opt => {
    opt.classList.toggle('active', opt.getAttribute('data-val') === 'all');
  });
  closeHkFilterDropdown();
  closeHkPgDropdown();
  document.getElementById('listTab1Btn').className = tab === 'new' ? 'flex-1 py-2 text-xs sm:text-sm font-semibold tab-active flex items-center justify-center gap-1.5' : 'flex-1 py-2 text-xs sm:text-sm font-medium tab-inactive flex items-center justify-center gap-1.5';
  document.getElementById('listTab2Btn').className = tab === 'warranty' ? 'flex-1 py-2 text-xs sm:text-sm font-semibold tab-active flex items-center justify-center gap-1.5' : 'flex-1 py-2 text-xs sm:text-sm font-medium tab-inactive flex items-center justify-center gap-1.5';
  document.getElementById('newCount').className = tab === 'new' ? 'bg-gray-900 text-white text-[11px] px-1.5 py-0.5 rounded-full font-bold' : 'bg-gray-200 text-gray-700 text-[11px] px-1.5 py-0.5 rounded-full font-normal';
  document.getElementById('warrantyCount').className = tab === 'warranty' ? 'bg-gray-900 text-white text-[11px] px-1.5 py-0.5 rounded-full font-bold' : 'bg-gray-200 text-gray-700 text-[11px] px-1.5 py-0.5 rounded-full font-normal';
  currentPage = 1;
  renderRequestList();
}

function toggleMobileListViewMode() {
  currentMobileViewMode = currentMobileViewMode === 'list' ? 'gallery' : 'list';
  const icon = document.getElementById('viewModeIcon');
  if (icon) {
    if (currentMobileViewMode === 'list') {
      // Now in list mode → show grid icon so user can switch back to gallery
      icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/>`;
    } else {
      // Now in gallery mode → show list icon so user can switch to list
      icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>`;
    }
  }
  renderRequestList();
}

function goToPage(page) {
  currentPage = page;
  closeHkPgDropdown();
  renderRequestList();
  const c = document.getElementById('requestListContainer');
  if (c) c.scrollTop = 0;
}

function renderPaginationHTML(page, total) {
  const isSinglePage = total <= 1;
  let optionsHTML = '';
  for (let i = 1; i <= total; i++) {
    const isAct = i === page;
    optionsHTML += `
      <button 
        type="button" 
        onclick="goToPage(${i})" 
        class="hk-dropdown-opt ${isAct ? 'active' : ''}" 
        data-val="${i}"
      >
        <span>Trang ${i} / ${total}</span>
      </button>
    `;
  }

  const prevDisabled = page <= 1 || isSinglePage;
  const nextDisabled = page >= total || isSinglePage;

  return `
    <div class="hk-pg-bar flex items-center">
      <!-- Nút Trước -->
      <button 
        type="button" 
        onclick="${prevDisabled ? '' : `goToPage(${page - 1})`}" 
        ${prevDisabled ? 'disabled' : ''} 
        class="hk-pg-btn ${prevDisabled ? 'disabled' : ''}" 
        title="Trang trước" 
        aria-label="Trang trước"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M15 19l-7-7 7-7"/>
        </svg>
      </button>

      <!-- Dropdown Phân Trang Đồng Bộ: 1 / 2 (bỏ chữ Trang để tiết kiệm không gian) -->
      <div class="hk-pg-dropdown-wrap relative" id="hkPgDropdownWrap">
        <button 
          type="button" 
          id="hkPgTriggerBtn" 
          ${isSinglePage ? 'disabled' : 'onclick="toggleHkPgDropdown(event)"'} 
          class="hk-pg-pill flex items-center justify-center gap-0.5 px-2 py-1 text-xs font-semibold rounded-lg border border-gray-200 bg-gray-50 text-gray-700 ${isSinglePage ? 'cursor-default opacity-70' : 'active:bg-gray-100 cursor-pointer'} transition-all select-none"
          title="${isSinglePage ? 'Chỉ có 1 trang' : 'Chạm để chọn trang'}"
        >
          <span class="font-bold text-xs">${page}</span>
          <span class="opacity-40 text-[10px] mx-0.5">/</span>
          <span class="opacity-75 text-[11px]">${total}</span>
          ${!isSinglePage ? `
          <svg class="w-2.5 h-2.5 text-gray-400 transition-transform duration-150 ml-0.5" id="hkPgArrowIcon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M19 9l-7 7-7-7"/>
          </svg>
          ` : ''}
        </button>

        ${!isSinglePage ? `
        <!-- Menu Phân Trang Thả Xuống (Bo tròn 2 góc dưới) -->
        <div 
          id="hkPgMenu" 
          class="hk-dropdown-menu hidden absolute right-0 top-full mt-0 w-32 bg-white shadow-xl z-50 py-1 max-h-56 overflow-y-auto"
        >
          ${optionsHTML}
        </div>
        ` : ''}
      </div>

      <!-- Nút Sau -->
      <button 
        type="button" 
        onclick="${nextDisabled ? '' : `goToPage(${page + 1})`}" 
        ${nextDisabled ? 'disabled' : ''} 
        class="hk-pg-btn ${nextDisabled ? 'disabled' : ''}" 
        title="Trang sau" 
        aria-label="Trang sau"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M9 5l7 7-7 7"/>
        </svg>
      </button>
    </div>
  `;
}

// Responsive Desktop/Mobile re-render on resize
let _hkResizeDebounce = null;
window.addEventListener('resize', () => {
  if (_hkResizeDebounce) clearTimeout(_hkResizeDebounce);
  _hkResizeDebounce = setTimeout(() => {
    _hkResizeDebounce = null;
    const listScreen = document.getElementById('listScreen');
    if (listScreen && !listScreen.classList.contains('hidden')) {
      renderRequestList();
    }
  }, 200);
});
