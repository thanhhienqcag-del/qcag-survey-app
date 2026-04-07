// ====================================================================
// js/flows/list-flow.js — request list rendering and tab controls
// ====================================================================
'use strict';

// ── Design-state helper ──────────────────────────────────────────────────
let currentDesignFilter = 'all'; // 'all'|'waiting'|'has_mq'|'editing'
let currentListSearchQuery = '';  // free-text search
let currentMobileViewMode = 'gallery'; // 'list' | 'gallery'

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
  waiting: { label: 'Chờ TK',      cls: 'bg-gray-100 text-gray-500' },
  has_mq:  { label: 'Có MQ',        cls: 'bg-gray-900 text-white'    },
  editing: { label: 'Đang cập nhật', cls: 'bg-gray-700 text-white'    }
};

function showRequestListWithFilter(filter) {
  currentDesignFilter = filter || 'all';
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
  renderRequestList();
}

function onListSearch(val) {
  currentListSearchQuery = (val || '').trim().toLowerCase();
  renderRequestList();
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
    let imgs = [];
    try { imgs = JSON.parse(req.acceptanceImages || '[]'); } catch (e) {}
    if (!imgs || imgs.length === 0) warrantyPending++; else warrantyDone++;
  });

  allEl.textContent     = newRequests.length;
  waitEl.textContent    = waiting;
  hasMqEl.textContent   = hasMq;
  editingEl.textContent = editing;
  if (wPendEl) wPendEl.textContent = warrantyPending;
  if (wDoneEl) wDoneEl.textContent = warrantyDone;
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
  let filtered = allRequests.filter(r => r.type === currentListTab);

  // Restrict visibility: users only see requests they created
  filtered = filtered.filter(r => {
    try {
      const reqOwner = JSON.parse(r.requester || '{}');
      if (!currentSession || !currentSession.saleCode) return false;
      return (reqOwner.saleCode && reqOwner.saleCode === currentSession.saleCode);
    } catch (e) { return false; }
  });

  // Apply design-state / warranty-status filter
  if (currentDesignFilter === 'warranty_pending') {
    filtered = filtered.filter(r => {
      let imgs = []; try { imgs = JSON.parse(r.acceptanceImages || '[]'); } catch (e) {}
      return !imgs || imgs.length === 0;
    });
  } else if (currentDesignFilter === 'warranty_done') {
    filtered = filtered.filter(r => {
      let imgs = []; try { imgs = JSON.parse(r.acceptanceImages || '[]'); } catch (e) {}
      return imgs && imgs.length > 0;
    });
  } else if (currentDesignFilter !== 'all') {
    filtered = filtered.filter(r => getRequestDesignState(r) === currentDesignFilter);
  }

  // Apply text search (outlet name / code / address)
  if (currentListSearchQuery) {
    const q = currentListSearchQuery;
    filtered = filtered.filter(r =>
      (r.outletName  || '').toLowerCase().includes(q) ||
      (r.outletCode  || '').toLowerCase().includes(q) ||
      (r.address     || '').toLowerCase().includes(q)
    );
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

  // Track which entries need lazy image load (have placeholder ["..."])
  const lazyLoadIds = [];

  // Update container class for grid view if needed
  if (currentMobileViewMode === 'gallery') {
    container.className = 'grid grid-cols-2 gap-3';
  } else {
    container.className = 'space-y-3';
  }

  container.innerHTML = filtered.map(req => {
    const date = new Date(req.createdAt);
    const dateStr = date.toLocaleDateString('vi-VN');
    const dsState = getRequestDesignState(req);
    const badge = DESIGN_STATE_BADGE[dsState] || DESIGN_STATE_BADGE.waiting;
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
        <div onclick="showRequestDetail('${req.__backendId}')" class="bg-gray-50 rounded-xl relative active:bg-gray-100 cursor-pointer flex flex-col shadow-sm border border-gray-100 overflow-hidden">
          ${thumbHtml}
          <div class="p-3 flex-1 flex flex-col">
            <span class="absolute top-2 right-2 flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${badge.cls} shadow-sm z-10 opacity-90">${badge.label}</span>
            <div class="font-medium text-sm line-clamp-2 leading-snug mb-1">${req.outletName}</div>
            <div class="text-xs text-gray-500 truncate mb-1">${req.outletCode}</div>
            <div class="text-[10px] text-gray-400 mt-auto pt-1">${dateStr}</div>
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
           <div class="flex items-center gap-3">
             <div class="flex-shrink-0">${thumbHtml}</div>
             <div class="flex-1 min-w-0">
               <div class="flex items-center gap-2 mb-0.5">
                 <span class="font-medium truncate">${req.outletName}</span>
                 <span class="flex-shrink-0 text-xs px-1.5 py-0.5 rounded-full ${badge.cls}">${badge.label}</span>
               </div>
               <div class="text-sm text-gray-500 truncate">${req.outletCode}</div>
               <div class="text-xs text-gray-400 mt-0.5">${dateStr}</div>
             </div>
             <svg class="w-4 h-4 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
             </svg>
           </div>
         </div>
       `;
    }
  }).join('');

  // Store filtered list for gallery swipe-navigation between outlets
  window._dvOutletList = filtered.slice();

  // Preload first design image for every visible item so tap-to-view is instant
  requestAnimationFrame(() => {
    filtered.forEach(req => {
      try {
        const imgs = JSON.parse(req.designImages || '[]').filter(u => u && u !== '...');
        if (imgs[0]) { const p = new Image(); p.src = imgs[0]; }
      } catch (e) {}
    });
  });

  // Lazy-load real thumbnails for placeholder entries (sequential to avoid rate limits)
  if (lazyLoadIds.length > 0 && window.dataSdk && typeof window.dataSdk.getOne === 'function') {
    (async () => {
      for (const backendId of lazyLoadIds) {
        const el = document.getElementById('thumb-' + backendId);
        if (!el) continue; // list re-rendered, skip
        try {
          const r = await window.dataSdk.getOne(backendId);
          if (!r || !r.isOk || !r.data) continue;
          const imgs = JSON.parse(r.data.designImages || '[]').filter(u => u && u !== '...');
          if (!imgs.length) continue;
          // Update local store
          const idx = allRequests.findIndex(x => x.__backendId === backendId);
          if (idx !== -1) {
            ['designImages','statusImages','acceptanceImages','oldContentImages'].forEach(k => {
              if (r.data[k] && r.data[k] !== '["..."]') allRequests[idx][k] = r.data[k];
            });
          }
          // Replace skeleton with real thumbnail (if element still exists in DOM)
          const thumbEl = document.getElementById('thumb-' + backendId);
          if (!thumbEl) continue;
          
          if (currentMobileViewMode === 'gallery') {
            const img = document.createElement('img');
            img.src = imgs[0];
            img.className = 'w-full h-32 object-cover rounded-t-xl cursor-pointer';
            img.title = 'Xem thiết kế';
            img.onclick = (e) => { e.stopPropagation(); viewDesign(backendId); };
            thumbEl.replaceWith(img);
          } else {
            const img = document.createElement('img');
            img.src = imgs[0];
            img.className = 'w-16 h-16 object-cover rounded-lg cursor-pointer';
            img.title = 'Xem thiết kế';
            img.onclick = (e) => { e.stopPropagation(); viewDesign(backendId); };
            thumbEl.replaceWith(img);
          }
        } catch (e) { /* leave skeleton as-is */ }
      }
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
