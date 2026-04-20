// ====================================================================
// js/shared/sdk-init.js — SDK initialization and localStorage helpers
// ====================================================================
'use strict';

// ── LocalStorage helpers ─────────────────────────────────────────────

function generateBackendId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function saveAllRequestsToStorage() {
  try {
    localStorage.setItem('ks_requests', JSON.stringify(allRequests));
  } catch (e) {
    console.warn('Failed to save requests to localStorage', e);
  }
}

function loadAllRequestsFromStorage() {
  try {
    const raw = localStorage.getItem('ks_requests');
    if (raw) {
      allRequests = JSON.parse(raw);
    } else {
      allRequests = [];
    }
  } catch (e) {
    console.warn('Failed to load requests from localStorage', e);
    allRequests = [];
  }
}

// ── SDK initialization ────────────────────────────────────────────────

// ── Desktop banner notification system ──────────────────────────────
// Shows a non-blocking banner at top of screen when new/warranty/edit requests arrive.
// Auto-dismisses after 12 seconds; click navigates to the request.
var _ksBannerQueue = [];
var _ksBannerVisible = false;

function _ksShowDesktopBanner(title, body, backendId, type) {
  _ksBannerQueue.push({ title: title, body: body, backendId: backendId, type: type });
  if (!_ksBannerVisible) _ksProcessBannerQueue();
}

function _ksProcessBannerQueue() {
  if (_ksBannerQueue.length === 0) { _ksBannerVisible = false; return; }
  _ksBannerVisible = true;
  var item = _ksBannerQueue.shift();

  // Remove any existing banner
  var old = document.getElementById('ksDesktopBanner');
  if (old) old.remove();

  var colors = {
    'new':       'bg-blue-600',
    'warranty':  'bg-orange-600',
    'editing':   'bg-yellow-500 text-gray-900',
    'done':      'bg-green-600',
  };
  var bgClass = colors[item.type] || 'bg-blue-600';

  var banner = document.createElement('div');
  banner.id = 'ksDesktopBanner';
  banner.className = 'fixed top-0 left-0 right-0 z-[9999] ' + bgClass + ' text-white px-4 py-3 shadow-lg flex items-center justify-between cursor-pointer transition-all duration-300';
  banner.style.transform = 'translateY(-100%)';
  banner.innerHTML =
    '<div class="flex items-center gap-3 flex-1 min-w-0">' +
      '<span class="text-xl">' + (item.type === 'new' ? '🆕' : item.type === 'warranty' ? '🔧' : item.type === 'editing' ? '✏️' : '✅') + '</span>' +
      '<div class="min-w-0">' +
        '<div class="font-bold text-sm truncate">' + (item.title || '').replace(/</g, '&lt;') + '</div>' +
        '<div class="text-xs opacity-90 truncate">' + (item.body || '').replace(/</g, '&lt;') + '</div>' +
      '</div>' +
    '</div>' +
    '<button id="ksDesktopBannerClose" class="ml-3 text-white/80 hover:text-white text-lg font-bold leading-none">✕</button>';

  document.body.appendChild(banner);
  // Slide in
  requestAnimationFrame(function () {
    banner.style.transform = 'translateY(0)';
  });

  // Play notification sound (short beep via Web Audio API)
  try {
    var audioCtx = window.__ksAudioCtx || (window.__ksAudioCtx = new (window.AudioContext || window.webkitAudioContext)());
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } catch (_) {}

  // Click → navigate to request
  banner.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'ksDesktopBannerClose') {
      _ksDismissBanner(banner);
      return;
    }
    if (item.backendId) {
      try {
        if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop() && typeof showQCAGDesktopDetail === 'function') {
          showQCAGDesktopDetail(item.backendId);
        } else if (typeof showRequestDetail === 'function') {
          showRequestDetail(item.backendId);
        }
      } catch (_) {}
    }
    _ksDismissBanner(banner);
  });

  // Close button
  var closeBtn = document.getElementById('ksDesktopBannerClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      _ksDismissBanner(banner);
    });
  }

  // Auto-dismiss after 12 seconds
  setTimeout(function () { _ksDismissBanner(banner); }, 12000);
}

function _ksDismissBanner(banner) {
  if (!banner || !banner.parentNode) { _ksBannerVisible = false; _ksProcessBannerQueue(); return; }
  banner.style.transform = 'translateY(-100%)';
  setTimeout(function () {
    try { banner.remove(); } catch (_) {}
    _ksBannerVisible = false;
    _ksProcessBannerQueue();
  }, 350);
}

// Track known request IDs so we only show banners for genuinely new arrivals
var _ksKnownRequestIds = {};
function _ksSnapshotKnownIds() {
  _ksKnownRequestIds = {};
  for (var i = 0; i < (allRequests || []).length; i++) {
    var r = allRequests[i];
    var bid = r.__backendId || r.id;
    _ksKnownRequestIds[bid] = {
      status: r.status || '',
      editingRequestedAt: r.editingRequestedAt || null,
      designImages: r.designImages || '[]',
    };
  }
}

// ── Global SSE invalidation hook (called from data_sdk) ──────────────
// Detect new/warranty/edit requests and show desktop banner instantly.
window.__ksOnInvalidate = function (payload) {
  if (!payload || payload.resource !== 'ks_requests') return;
  var action = payload.action;
  var data = payload.data;
  if (!data || !data.__backendId) return;

  var bid = data.__backendId;
  var prev = _ksKnownRequestIds[bid];
  var type = data.type || 'new';
  var outletLabel = data.outletName || data.outletCode || 'Outlet';

  // New request created
  if (action === 'create' && !prev) {
    if (type === 'warranty') {
      _ksShowDesktopBanner('Yêu cầu bảo hành mới', 'Outlet ' + outletLabel, bid, 'warranty');
    } else {
      _ksShowDesktopBanner('Yêu cầu khảo sát mới', 'Outlet ' + outletLabel, bid, 'new');
    }
    // Update snapshot
    _ksKnownRequestIds[bid] = { status: data.status || '', editingRequestedAt: data.editingRequestedAt || null, designImages: data.designImages || '[]' };
    return;
  }

  // Existing request updated
  if (prev) {
    // Editing requested (Sale asked for changes)
    if (data.editingRequestedAt && !prev.editingRequestedAt) {
      _ksShowDesktopBanner('Yêu cầu chỉnh sửa MQ', 'Outlet ' + outletLabel + ' yêu cầu chỉnh sửa', bid, 'editing');
    }
    // QCAG completed MQ (status → done)
    if (data.status === 'done' && prev.status !== 'done') {
      _ksShowDesktopBanner('MQ đã hoàn thành', 'Outlet ' + outletLabel + ' đã có mẫu quảng cáo', bid, 'done');
    }
    // Update snapshot
    _ksKnownRequestIds[bid] = { status: data.status || '', editingRequestedAt: data.editingRequestedAt || null, designImages: data.designImages || '[]' };
  }
};

async function initHomeAndLoad() {
  await initApp();
}

async function initApp() {
  // Show loading overlay while waiting for remote data
  if (typeof showLoadingOverlay === 'function') {
    showLoadingOverlay('Đang tải dữ liệu...', 'Vui lòng chờ trong giây lát');
  }

  // Show cached data instantly so the list is never blank while network loads
  try {
    loadAllRequestsFromStorage();
    updateRequestCount();
    if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
      if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();
    }
    const listEl = document.getElementById('listScreen');
    if (listEl && listEl.classList.contains('flex')) renderRequestList();
  } catch (_e) {}

  if (window.elementSdk) {
    window.elementSdk.init({
      defaultConfig,
      onConfigChange: async (config) => {
        document.getElementById('appTitle').textContent = config.app_title || defaultConfig.app_title;
      },
      mapToCapabilities: (config) => ({
        recolorables: [],
        borderables: [],
        fontEditable: undefined,
        fontSizeable: undefined
      }),
      mapToEditPanelValues: (config) => new Map([
        ['app_title', config.app_title || defaultConfig.app_title]
      ])
    });
  }

  if (window.dataSdk) {
    const result = await window.dataSdk.init({
      onDataChanged: (data) => {
        allRequests = data;
        // Snapshot known IDs for banner detection (first call builds baseline)
        _ksSnapshotKnownIds();
        updateRequestCount();
        if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
          // Chỉ refresh list khi có dữ liệu mới từ SSE realtime.
          // KHÔNG gọi openQCAGDesktop() ở đây — nó sẽ re-render toàn bộ màn hình
          // sau mỗi lần PATCH, gây giật hình và nhảy tag loạn xạ.
          if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();

          // If a QCAG desktop detail is open, perform an in-place refresh of that
          // detail (avoids full re-render and preserves scroll / UI state).
          try {
            if (typeof currentDetailRequest !== 'undefined' && currentDetailRequest && currentDetailRequest.__backendId) {
              const updated = (allRequests || []).find(r => r.__backendId === currentDetailRequest.__backendId);
              if (updated) {
                const oldTs = currentDetailRequest.updatedAt ? new Date(currentDetailRequest.updatedAt).getTime() : 0;
                const newTs = updated.updatedAt ? new Date(updated.updatedAt).getTime() : 0;
                if (newTs !== oldTs) {
                  if (typeof qcagDesktopGetFullRequest === 'function' && typeof _qcagDesktopInPlaceRefresh === 'function') {
                    qcagDesktopGetFullRequest(updated.__backendId).then(full => {
                      if (full) {
                        // Don't downgrade status: if a confirm-complete PATCH arrived after
                        // this fetch was issued (upload-SSE race), skip the stale update.
                        const statRank = s => (s === 'done' || s === 'processed') ? 2 : s === 'processing' ? 1 : 0;
                        const currS = String((currentDetailRequest && currentDetailRequest.__backendId === full.__backendId ? currentDetailRequest.status : '') || '').toLowerCase();
                        if (statRank(currS) > statRank(String(full.status || '').toLowerCase())) return;
                        currentDetailRequest = full;
                        if (typeof qcagDesktopCacheRequest === 'function') qcagDesktopCacheRequest(full);
                        _qcagDesktopInPlaceRefresh(full);
                      }
                    }).catch(() => {});
                  } else if (typeof _qcagDesktopInPlaceRefresh === 'function') {
                    currentDetailRequest = updated;
                    if (typeof qcagDesktopCacheRequest === 'function') qcagDesktopCacheRequest(updated);
                    _qcagDesktopInPlaceRefresh(updated);
                  }
                }
              }
            }
          } catch (e) {
            console.warn('qcag desktop in-place refresh failed', e);
          }
        }
        if (document.getElementById('listScreen').classList.contains('flex')) {
          renderRequestList();
        }
        const notifyEl = document.getElementById('notificationsScreen');
        if (notifyEl && notifyEl.classList.contains('flex') && typeof renderNotifications === 'function') {
          renderNotifications();
        }
        // Update Heineken mobile detail view if it's open and data changed
        if (!(typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop())) {
          try {
            const detailEl = document.getElementById('detailScreen');
            if (detailEl && detailEl.classList.contains('flex') &&
                typeof currentDetailRequest !== 'undefined' && currentDetailRequest && currentDetailRequest.__backendId) {
              const detailUpdated = (allRequests || []).find(r => r.__backendId === currentDetailRequest.__backendId);
              if (detailUpdated) {
                const oldTs = currentDetailRequest.updatedAt ? new Date(currentDetailRequest.updatedAt).getTime() : 0;
                const newTs = detailUpdated.updatedAt ? new Date(detailUpdated.updatedAt).getTime() : 0;
                if (newTs !== oldTs && typeof showRequestDetail === 'function') {
                  showRequestDetail(detailUpdated.__backendId);
                }
              }
            }
          } catch (e) {
            console.warn('mobile detail in-place refresh failed', e);
          }
        }
      }
    });
    if (typeof hideLoadingOverlay === 'function') hideLoadingOverlay();
    if (!result.isOk) {
      showToast('Lỗi kết nối dữ liệu');
    }
  }

  // If no remote data SDK, load from localStorage as a fallback
  if (!window.dataSdk) {
    loadAllRequestsFromStorage();
    updateRequestCount();
    if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
      if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();
    }
    if (document.getElementById('listScreen').classList.contains('flex')) {
      renderRequestList();
    }
    const notifyEl = document.getElementById('notificationsScreen');
    if (notifyEl && notifyEl.classList.contains('flex') && typeof renderNotifications === 'function') {
      renderNotifications();
    }
    if (typeof hideLoadingOverlay === 'function') hideLoadingOverlay();
  }

  // Only ensure an initial request item when New Request screen is visible.
  // Avoid unconditionally creating an item here because `resetNewRequestForm`
  // and other flows create items as needed and this was causing duplicates.
  try {
    const newReqEl = document.getElementById('newRequestScreen');
    if (newReqEl && newReqEl.classList.contains('flex')) {
      if (!Array.isArray(currentRequestItems) || currentRequestItems.length === 0) addRequestItem();
    }
  } catch (e) {}
}
