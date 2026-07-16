// ====================================================================
// js/flows/list-flow.js — request list rendering and tab controls
// ====================================================================
'use strict';

// ── Design-state helper ──────────────────────────────────────────────────
let currentDesignFilter = 'all'; // 'all'|'waiting'|'has_mq'|'editing'
let currentListSearchQuery = '';  // free-text search
let currentListSearchDebounce = null;
let currentMobileViewMode = 'gallery'; // 'list' | 'gallery'
let currentPage = 1;
const PAGE_SIZE = 12;

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
  if (t1) t1.className = 'flex-1 py-3 text-sm font-medium tab-inactive';
  if (t2) t2.className = 'flex-1 py-3 text-sm font-medium tab-active';
  if (nc) nc.className = 'ml-1 bg-gray-200 text-gray-700 text-xs px-1.5 py-0.5 rounded-full';
  if (wc) wc.className = 'ml-1 bg-gray-900 text-white text-xs px-1.5 py-0.5 rounded-full';
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
// Returns: 'waiting' | 'has_mq' | 'editing'
// Logic:
//   • editingRequestedAt set (images cleared by HK comment) → editing
//   • No design images → waiting
//   • Has design images → has_mq
function getRequestDesignState(req) {
  // Heineken đã comment yêu cầu sửa → ảnh đã bị xóa, cờ đã đặt
  if (req.editingRequestedAt) return 'editing';

  let designImgs = [];
  try { designImgs = JSON.parse(req.designImages || '[]'); } catch (e) {}
  if (!designImgs || designImgs.length === 0) return 'waiting';

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
  // When initial data is loading, show subtle placeholders instead of zeros.
  if (window._homeStatsLoading) {
    const ph = '…';
    if (allEl) allEl.textContent = ph;
    if (waitEl) waitEl.textContent = ph;
    if (hasMqEl) hasMqEl.textContent = ph;
    if (editingEl) editingEl.textContent = ph;
    if (wPendEl) wPendEl.textContent = ph;
    if (wDoneEl) wDoneEl.textContent = ph;
  }
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
    // defensive: ignore DOM update errors
    console.warn('Failed to update request counters', e);
  }
  // Ensure home stats update even if some list elements are missing
  try { updateHomeStats(); } catch (e) { console.warn('updateHomeStats error', e); }
}

function renderRequestList() {
  const hasSearch = !!currentListSearchQuery;
  let filtered = hasSearch ? allRequests.slice() : allRequests.filter(r => r.type === currentListTab);

  // Restrict visibility: users only see requests they created
  filtered = filtered.filter(r => {
    try {
      // Nếu là QCAG Admin, cho phép xem tất cả dữ liệu
      if (currentSession && currentSession.role === 'qcag') return true;

      const reqOwner = JSON.parse(r.requester || '{}');
      if (!currentSession || !currentSession.saleCode) return false;
      return (reqOwner.saleCode && reqOwner.saleCode === currentSession.saleCode);
    } catch (e) { return false; }
  });

  // Apply design-state / warranty-status filter
  if (!hasSearch && currentDesignFilter === 'warranty_pending') {
    filtered = filtered.filter(r => {
      let imgs = []; try { imgs = JSON.parse(r.acceptanceImages || '[]'); } catch (e) {}
      if (imgs && imgs.length > 0 && imgs[0] !== '...') return false;
      // Backward-compat: check designImages too
      try { const di = JSON.parse(r.designImages || '[]'); if (di.length > 0 && di[0] !== '...') return false; } catch (e) {}
      return true;
    });
  } else if (!hasSearch && currentDesignFilter === 'warranty_done') {
    filtered = filtered.filter(r => {
      let imgs = []; try { imgs = JSON.parse(r.acceptanceImages || '[]'); } catch (e) {}
      if (imgs && imgs.length > 0 && imgs[0] !== '...') return true;
      // Backward-compat: check designImages too
      try { const di = JSON.parse(r.designImages || '[]'); if (di.length > 0 && di[0] !== '...') return true; } catch (e) {}
      return false;
    });
  } else if (!hasSearch && currentDesignFilter !== 'all') {
    filtered = filtered.filter(r => getRequestDesignState(r) === currentDesignFilter);
  }

  // Apply text search (outlet name / code / address)
  if (currentListSearchQuery) {
    const q = currentListSearchQuery;
    filtered = filtered.filter(r => {
      let requester = {};
      try { requester = JSON.parse(r.requester || '{}') || {}; } catch (e) {}
      return (r.tkCode || '').toLowerCase().includes(q) ||
        (requester.saleName || requester.saleCode || requester.phone || '').toLowerCase().includes(q) ||
        (requester.ssName || '').toLowerCase().includes(q) ||
        (r.outletName  || '').toLowerCase().includes(q) ||
        (r.outletCode  || '').toLowerCase().includes(q) ||
        (r.designFilename || '').toLowerCase().includes(q);
    });
  }

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

  if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
    container.innerHTML = '';
    return;
  }

  emptyState.classList.add('hidden');

  // Pagination: slice to current page
  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / PAGE_SIZE);
  if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;
  const pageSlice = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Track which entries need lazy image load (have placeholder ["..."])
  const lazyLoadIds = [];

  // Update container class for grid view if needed
  if (currentMobileViewMode === 'gallery') {
    container.className = 'grid grid-cols-2 gap-3';
  } else {
    container.className = 'space-y-3';
  }

  container.innerHTML = pageSlice.map(req => {
    const date = new Date(req.createdAt);
    const dateStr = date.toLocaleDateString('vi-VN');
    const dsState = req.type === 'warranty' ? getWarrantyState(req) : getRequestDesignState(req);
    const badge = DESIGN_STATE_BADGE[dsState] || DESIGN_STATE_BADGE.waiting;
    const tkName = req.designCreatedBy || req.designLastEditedBy || null;
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
    let fallbackIconHtml = `<svg class="w-8 h-8 mx-auto mb-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V7M3 7l9 6 9-6"/></svg>`;
    
    // Check if gallery mode to determine thumb width/height
    if (currentMobileViewMode === 'gallery') {
       if (preview) {
         thumbHtml = `<img src="${preview}" onclick="event.stopPropagation(); viewDesign('${req.__backendId}')" title="Xem thiết kế" class="w-full h-32 object-cover rounded-t-xl cursor-pointer">`;
       } else if (hasDesignPlaceholder) {
         thumbHtml = `<div id="thumb-${req.__backendId}" class="w-full h-32 bg-gray-700 rounded-t-xl flex items-center justify-center p-4 text-center" style="animation:pulse 1.5s ease-in-out infinite">
              <svg class="w-8 h-8 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            </div>`;
       } else {
         thumbHtml = `<div onclick="event.stopPropagation(); showToast('Yêu cầu này chưa có MQ')" title="Không có MQ" class="w-full h-32 bg-gray-100 rounded-t-xl flex flex-col items-center justify-center text-gray-400 p-2 text-center cursor-pointer">
              ${fallbackIconHtml}
              <span class="text-xs">Chưa có MQ</span>
            </div>`;
       }

       return `
        <div onclick="showRequestDetail('${req.__backendId}')" class="bg-gray-50 rounded-xl active:bg-gray-100 cursor-pointer flex flex-col shadow-sm border border-gray-100 overflow-hidden">
          ${thumbHtml}
          <div class="p-2.5 flex-1 flex flex-col gap-0.5">
            <div class="font-semibold text-sm leading-tight line-clamp-2">${req.outletName}</div>
            <div class="text-[11px] text-gray-500 font-medium truncate">${req.outletCode}</div>
            <div class="text-[10px] text-gray-400">Gửi: ${dateStr}</div>
            ${tkName ? `<div class="text-[10px] text-gray-400 truncate">TK: ${tkName}</div>` : ''}
            ${lastUpdated ? `<div class="text-[10px] text-blue-500 truncate whitespace-nowrap">${lastUpdated}</div>` : ''}
            <div class="mt-auto pt-1.5">
              <span class="text-[10px] px-1.5 py-0.5 rounded-full ${badge.cls} shadow-sm">${badge.label}</span>
            </div>
          </div>
        </div>
      `;
    } else {
       // List Mode HTML
       if (preview) {
         thumbHtml = `<img src="${preview}" onclick="event.stopPropagation(); viewDesign('${req.__backendId}')" title="Xem thiết kế" class="w-16 h-16 object-cover rounded-lg cursor-pointer">`;
       } else if (hasDesignPlaceholder) {
         // Placeholder skeleton — will be replaced by lazy loader below
         thumbHtml = `<div id="thumb-${req.__backendId}" class="w-16 h-16 bg-gray-700 rounded-lg flex items-center justify-center" style="animation:pulse 1.5s ease-in-out infinite">
              <svg class="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            </div>`;
       } else {
         thumbHtml = `<button onclick="event.stopPropagation(); showToast('Yêu cầu này chưa có MQ')" title="Không có MQ" class="w-16 h-16 bg-gray-100 rounded-lg flex items-center justify-center text-gray-400">
              <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V7M3 7l9 6 9-6"/></svg>
            </button>`;
       }

       return `
         <div onclick="showRequestDetail('${req.__backendId}')" class="bg-gray-50 rounded-xl p-3 active:bg-gray-100 cursor-pointer">
           <div class="flex items-start gap-3">
             <div class="flex-shrink-0">${thumbHtml}</div>
             <div class="flex-1 min-w-0">
               <div class="font-semibold text-sm leading-tight mb-0.5">${req.outletName}</div>
               <div class="text-xs text-gray-500 font-medium truncate mb-0.5">${req.outletCode}</div>
               <div class="text-xs text-gray-400">Gửi: ${dateStr}</div>
               ${tkName ? `<div class="text-xs text-gray-400 truncate">TK: ${tkName}</div>` : ''}
               ${lastUpdated ? `<div class="text-xs text-blue-500 truncate whitespace-nowrap">${lastUpdated}</div>` : ''}
               <div class="mt-1.5">
                 <span class="text-xs px-1.5 py-0.5 rounded-full ${badge.cls}">${badge.label}</span>
               </div>
             </div>
             <svg class="w-4 h-4 text-gray-300 flex-shrink-0 mt-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
             </svg>
           </div>
         </div>
       `;
    }
  }).join('');

  // Update pagination controls
  const pgEl = document.getElementById('requestListPagination');
  if (pgEl) pgEl.innerHTML = totalPages > 1 ? renderPaginationHTML(currentPage, totalPages) : '';

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

          if (currentMobileViewMode === 'gallery') {
            img.className = 'w-full h-32 object-cover rounded-t-xl cursor-pointer';
          } else {
            img.className = 'w-16 h-16 object-cover rounded-lg cursor-pointer';
          }
          thumbEl.replaceWith(img);

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
}

function switchListTab(tab) {
  currentListTab = tab;
  currentDesignFilter = 'all';        // reset design filter
  currentListSearchQuery = '';        // reset search
  const si = document.getElementById('listSearchInput');
  if (si) si.value = '';
  document.getElementById('listTab1Btn').className = tab === 'new' ? 'flex-1 py-3 text-sm font-medium tab-active' : 'flex-1 py-3 text-sm font-medium tab-inactive';
  document.getElementById('listTab2Btn').className = tab === 'warranty' ? 'flex-1 py-3 text-sm font-medium tab-active' : 'flex-1 py-3 text-sm font-medium tab-inactive';
  document.getElementById('newCount').className = tab === 'new' ? 'ml-1 bg-gray-900 text-white text-xs px-1.5 py-0.5 rounded-full' : 'ml-1 bg-gray-200 text-gray-700 text-xs px-1.5 py-0.5 rounded-full';
  document.getElementById('warrantyCount').className = tab === 'warranty' ? 'ml-1 bg-gray-900 text-white text-xs px-1.5 py-0.5 rounded-full' : 'ml-1 bg-gray-200 text-gray-700 text-xs px-1.5 py-0.5 rounded-full';
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
  renderRequestList();
  const c = document.getElementById('requestListContainer');
  if (c) c.scrollTop = 0;
}

function renderPaginationHTML(page, total) {
  const btnBase = 'w-8 h-8 rounded-lg text-sm font-medium flex items-center justify-center';
  const activeCls = 'bg-gray-900 text-white';
  const inactiveCls = 'bg-gray-100 text-gray-600 active:bg-gray-200';
  const disabledCls = 'bg-gray-50 text-gray-300';
  let start = Math.max(1, page - 2);
  let end = Math.min(total, page + 2);
  if (end - start < 4) {
    if (start === 1) end = Math.min(total, start + 4);
    else start = Math.max(1, end - 4);
  }
  let html = `<div class="flex items-center gap-1.5 py-2">`;
  html += page > 1
    ? `<button onclick="goToPage(${page - 1})" class="${btnBase} ${inactiveCls}"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg></button>`
    : `<div class="${btnBase} ${disabledCls}"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg></div>`;
  if (start > 1) {
    html += `<button onclick="goToPage(1)" class="${btnBase} ${inactiveCls}">1</button>`;
    if (start > 2) html += `<span class="text-gray-400 text-sm px-1">…</span>`;
  }
  for (let i = start; i <= end; i++) {
    html += i === page
      ? `<div class="${btnBase} ${activeCls}">${i}</div>`
      : `<button onclick="goToPage(${i})" class="${btnBase} ${inactiveCls}">${i}</button>`;
  }
  if (end < total) {
    if (end < total - 1) html += `<span class="text-gray-400 text-sm px-1">…</span>`;
    html += `<button onclick="goToPage(${total})" class="${btnBase} ${inactiveCls}">${total}</button>`;
  }
  html += page < total
    ? `<button onclick="goToPage(${page + 1})" class="${btnBase} ${inactiveCls}"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg></button>`
    : `<div class="${btnBase} ${disabledCls}"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg></div>`;
  html += `<span class="text-xs text-gray-400 ml-1">${page}/${total}</span>`;
  html += `</div>`;
  return html;
}
