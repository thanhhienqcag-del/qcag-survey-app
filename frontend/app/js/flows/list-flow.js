// ====================================================================
// js/flows/list-flow.js — request list rendering and tab controls
// ====================================================================
'use strict';

// ── Design-state helper ──────────────────────────────────────────────────
let currentDesignFilter = 'all'; // 'all'|'waiting'|'has_mq'|'editing'
let currentListSearchQuery = '';  // free-text search

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
  container.innerHTML = filtered.map(req => {
    const date = new Date(req.createdAt);
    const dateStr = date.toLocaleDateString('vi-VN');
    const dsState = getRequestDesignState(req);
    const badge = DESIGN_STATE_BADGE[dsState] || DESIGN_STATE_BADGE.waiting;
    let preview = '';
    try {
      const imgs = JSON.parse(req.designImages || '[]');
      if (imgs && imgs.length > 0) preview = imgs[0];
    } catch (e) { preview = ''; }

    const thumbHtml = preview
      ? `<img src="${preview}" onclick="event.stopPropagation(); viewDesign('${req.__backendId}')" title="Xem thiết kế" aria-label="Xem thiết kế" class="w-16 h-16 object-cover rounded-lg cursor-pointer">`
      : `<button onclick="event.stopPropagation(); showToast('Yêu cầu này chưa có MQ')" title="Không có MQ" aria-label="Không có MQ" class="w-16 h-16 bg-gray-100 rounded-lg flex items-center justify-center text-gray-400">
           <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V7M3 7l9 6 9-6"/></svg>
         </button>`;

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
  }).join('');
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
