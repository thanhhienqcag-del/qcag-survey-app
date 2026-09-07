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

// ── Floating Drop-down Toast Notification System ─────────────────────
// Shows a sleek, non-intrusive floating toast at the top center of the screen
// Auto-dismisses after 3 seconds; clicking navigates to the request.
var _ksBannerQueue = [];
var _ksBannerVisible = false;
var _ksRecentNotifs = {};

function _ksShowDesktopBanner(title, body, backendId, type) {
  // Deduplicate notifications arriving within 4 seconds (e.g. SSE + Web Push concurrent events)
  var key = (backendId || '') + ':' + (title || '') + ':' + (body || '');
  var now = Date.now();
  if (_ksRecentNotifs[key] && (now - _ksRecentNotifs[key] < 4000)) {
    return; // Suppress duplicate toast
  }
  _ksRecentNotifs[key] = now;
  for (var k in _ksRecentNotifs) {
    if (now - _ksRecentNotifs[k] > 10000) delete _ksRecentNotifs[k];
  }

  _ksBannerQueue.push({ title: title, body: body, backendId: backendId, type: type || 'new' });
  if (!_ksBannerVisible) _ksProcessBannerQueue();
}

function _ksProcessBannerQueue() {
  if (_ksBannerQueue.length === 0) { _ksBannerVisible = false; return; }
  _ksBannerVisible = true;
  var item = _ksBannerQueue.shift();

  // Remove any existing banner
  var old = document.getElementById('ksDesktopBanner');
  if (old) old.remove();

  var typeStyles = {
    'new': {
      border: 'rgba(56, 189, 248, 0.45)',
      badgeBg: 'rgba(56, 189, 248, 0.15)',
      glow: 'rgba(56, 189, 248, 0.2)',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>'
    },
    'warranty': {
      border: 'rgba(251, 146, 60, 0.45)',
      badgeBg: 'rgba(251, 146, 60, 0.15)',
      glow: 'rgba(251, 146, 60, 0.2)',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>'
    },
    'editing': {
      border: 'rgba(251, 191, 36, 0.55)',
      badgeBg: 'rgba(251, 191, 36, 0.15)',
      glow: 'rgba(251, 191, 36, 0.25)',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>'
    },
    'done': {
      border: 'rgba(52, 211, 153, 0.45)',
      badgeBg: 'rgba(52, 211, 153, 0.15)',
      glow: 'rgba(52, 211, 153, 0.2)',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>'
    },
  };
  var style = typeStyles[item.type] || typeStyles['new'];

  var banner = document.createElement('div');
  banner.id = 'ksDesktopBanner';
  banner.style.cssText = 'position: fixed; top: 16px; left: 50%; transform: translate(-50%, -24px) scale(0.95); opacity: 0; z-index: 99999; display: flex; align-items: center; gap: 12px; max-width: min(92vw, 440px); width: max-content; padding: 9px 14px; border-radius: 9999px; background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border: 1.5px solid ' + style.border + '; box-shadow: 0 10px 30px -4px rgba(0, 0, 0, 0.5), 0 0 16px ' + style.glow + '; cursor: pointer; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); pointer-events: auto; user-select: none; font-family: inherit;';
  
  banner.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:9999px;background:' + style.badgeBg + ';flex-shrink:0;">' + style.svg + '</div>' +
    '<div style="min-width:0;flex:1;line-height:1.25;">' +
      '<div style="font-size:13px;font-weight:700;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (item.title || '').replace(/</g, '&lt;') + '</div>' +
      '<div style="font-size:11.5px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;">' + (item.body || '').replace(/</g, '&lt;') + '</div>' +
    '</div>' +
    '<button id="ksDesktopBannerClose" style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:9999px;border:none;background:rgba(255,255,255,0.08);color:#94a3b8;font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0;margin-left:4px;transition:background 0.2s;" title="Đóng">✕</button>';

  document.body.appendChild(banner);
  // Animate in
  requestAnimationFrame(function () {
    banner.style.transform = 'translate(-50%, 0) scale(1)';
    banner.style.opacity = '1';
  });

  // Play notification sound (short soft beep via Web Audio API)
  try {
    var audioCtx = window.__ksAudioCtx || (window.__ksAudioCtx = new (window.AudioContext || window.webkitAudioContext)());
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.12;
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch (_) {}

  // Click → navigate to request
  banner.addEventListener('click', function (e) {
    if (e.target && (e.target.id === 'ksDesktopBannerClose' || e.target.closest('#ksDesktopBannerClose'))) {
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

  // Auto-dismiss after 3 seconds (3000ms)
  setTimeout(function () { _ksDismissBanner(banner); }, 3000);
}

function _ksDismissBanner(banner) {
  if (!banner || !banner.parentNode) { _ksBannerVisible = false; _ksProcessBannerQueue(); return; }
  banner.style.transform = 'translate(-50%, -24px) scale(0.95)';
  banner.style.opacity = '0';
  setTimeout(function () {
    try { banner.remove(); } catch (_) {}
    _ksBannerVisible = false;
    _ksProcessBannerQueue();
  }, 250);
}

// Track known request IDs so we only show banners for genuinely new arrivals
var _ksKnownRequestIds = {};

function _ksDedupeRequests(rows) {
  if (!Array.isArray(rows)) return [];
  var seen = {};
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    var key = r.__backendId || r.id || '';
    if (!key) {
      out.push(r);
      continue;
    }
    if (!seen[key]) {
      seen[key] = true;
      out.push(r);
    }
  }
  return out;
}

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
  if (!data || !data.__backendId) {
    if (window.dataSdk && typeof window.dataSdk.refresh === 'function') {
      window.dataSdk.refresh(true).catch(function () {});
    }
    return;
  }

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
  // Desktop QCAG: keep a blocking loading overlay visible until initial data load finishes.
  try {
    if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop() && typeof showLoadingOverlay === 'function') {
      showLoadingOverlay('Đang tải dữ liệu...', 'Vui lòng chờ trong giây lát');
    }
  } catch (e) {}

  // Instead of a blocking fullscreen overlay, mark home stats as loading
  // so counters show placeholders while data loads.
  try { if (typeof setHomeStatsLoading === 'function') setHomeStatsLoading(true); } catch (e) {}

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
        allRequests = _ksDedupeRequests(data);
        if (typeof _qcagDesktopFullRequestCache !== 'undefined' && typeof qcagDesktopMergePreserveImageFields === 'function') {
          (allRequests || []).forEach(r => {
            if (r && r.__backendId && _qcagDesktopFullRequestCache[r.__backendId]) {
              _qcagDesktopFullRequestCache[r.__backendId] = qcagDesktopMergePreserveImageFields(r, _qcagDesktopFullRequestCache[r.__backendId]);
            }
          });
        }
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
                const oldCommentsLen = (currentDetailRequest.comments || '').length;
                const newCommentsLen = (updated.comments || '').length;
                const oldDesignLen = (currentDetailRequest.designImages || '').length;
                const newDesignLen = (updated.designImages || '').length;
                const hasChanged = (newTs !== oldTs) ||
                                   (newCommentsLen !== oldCommentsLen) ||
                                   (newDesignLen !== oldDesignLen) ||
                                   (updated.status !== currentDetailRequest.status) ||
                                   (updated.editingRequestedAt !== currentDetailRequest.editingRequestedAt);

                if (hasChanged) {
                  if (typeof qcagDesktopGetFullRequest === 'function' && typeof _qcagDesktopInPlaceRefresh === 'function') {
                    qcagDesktopGetFullRequest(updated.__backendId, true).then(full => {
                      if (full) {
                        const statRank = s => (s === 'done' || s === 'processed') ? 2 : s === 'processing' ? 1 : 0;
                        const currS = String((currentDetailRequest && currentDetailRequest.__backendId === full.__backendId ? currentDetailRequest.status : '') || '').toLowerCase();
                        if (statRank(currS) > statRank(String(full.status || '').toLowerCase()) && !full.editingRequestedAt) return;
                        currentDetailRequest = full;
                        if (typeof qcagDesktopCacheRequest === 'function') qcagDesktopCacheRequest(full);
                        if (typeof _qcagDesktopOpenRequestSnapshot !== 'undefined') {
                          _qcagDesktopOpenRequestSnapshot = JSON.parse(JSON.stringify(full));
                        }
                        _qcagDesktopInPlaceRefresh(full);
                      }
                    }).catch(() => {});
                  } else if (typeof _qcagDesktopInPlaceRefresh === 'function') {
                    currentDetailRequest = updated;
                    if (typeof qcagDesktopCacheRequest === 'function') qcagDesktopCacheRequest(updated);
                    if (typeof _qcagDesktopOpenRequestSnapshot !== 'undefined') {
                      _qcagDesktopOpenRequestSnapshot = JSON.parse(JSON.stringify(updated));
                    }
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
        if (typeof updateNotifBadge === 'function') updateNotifBadge();
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

        // In-place refresh design modal comments if it's currently open
        try {
          const designModal = document.getElementById('designModal');
          if (designModal && !designModal.classList.contains('hidden') && typeof currentDetailRequest !== 'undefined' && currentDetailRequest) {
            const modalUpdated = (allRequests || []).find(r => r.__backendId === currentDetailRequest.__backendId);
            if (modalUpdated && typeof window.qcagRefreshDesignModalComments === 'function') {
              window.qcagRefreshDesignModalComments(modalUpdated);
            }
          }
        } catch (e) {
          console.warn('design modal comments in-place refresh failed', e);
        }
      }
    });
    if (typeof hideLoadingOverlay === 'function') hideLoadingOverlay();
    if (!result.isOk) {
      showToast('Lỗi kết nối dữ liệu');
    }
    try { if (typeof setHomeStatsLoading === 'function') setHomeStatsLoading(false); } catch (e) {}
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
    if (typeof updateNotifBadge === 'function') updateNotifBadge();
    const notifyEl = document.getElementById('notificationsScreen');
    if (notifyEl && notifyEl.classList.contains('flex') && typeof renderNotifications === 'function') {
      renderNotifications();
    }
    if (typeof hideLoadingOverlay === 'function') hideLoadingOverlay();
    try { if (typeof setHomeStatsLoading === 'function') setHomeStatsLoading(false); } catch (e) {}
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
