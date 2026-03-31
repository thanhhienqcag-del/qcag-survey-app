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

// Snapshot of last SDK data payload (used to detect changes and show mobile toast)
let _lastDataSdkSnapshot = null;

// ── SDK initialization ────────────────────────────────────────────────

async function initHomeAndLoad() {
  await initApp();
}

async function initApp() {
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
        // Detect changes compared to previous snapshot and show a mobile toast
        // when a request belonging to the current user receives an MQ,
        // is marked done, or gets an edit-resolved comment.
        try {
          const prev = Array.isArray(_lastDataSdkSnapshot) ? _lastDataSdkSnapshot : (Array.isArray(allRequests) ? allRequests : []);
          const prevMap = {};
          (prev || []).forEach(r => { if (r && r.__backendId) prevMap[r.__backendId] = r; });
          const newMap = {};
          (data || []).forEach(r => { if (r && r.__backendId) newMap[r.__backendId] = r; });

          // Only show toast for logged-in Heineken/mobile users (not QCAG desktop)
          const isHeineken = !!(typeof currentSession !== 'undefined' && currentSession && String(currentSession.role || '').toLowerCase() === 'heineken');
          if (isHeineken && currentSession && currentSession.phone) {
            for (const id in newMap) {
              try {
                const oldReq = prevMap[id];
                const newReq = newMap[id];
                if (!oldReq || !newReq) continue;
                const oldTs = oldReq.updatedAt ? new Date(oldReq.updatedAt).getTime() : 0;
                const newTs = newReq.updatedAt ? new Date(newReq.updatedAt).getTime() : 0;
                if (newTs <= oldTs) continue; // not newer

                // Make sure this request belongs to the current user (by phone)
                let reqObj = {};
                try { reqObj = (typeof newReq.requester === 'string') ? JSON.parse(newReq.requester || '{}') : (newReq.requester || {}); } catch (e) { reqObj = {}; }
                if (String(reqObj.phone || '') !== String(currentSession.phone || '')) continue;

                // 1) MQ uploaded: designImages changed from empty -> non-empty
                let oldDesign = [];
                let newDesign = [];
                try { oldDesign = JSON.parse(oldReq.designImages || '[]'); } catch (e) { oldDesign = []; }
                try { newDesign = JSON.parse(newReq.designImages || '[]'); } catch (e) { newDesign = []; }
                if (!Array.isArray(oldDesign)) oldDesign = [];
                if (!Array.isArray(newDesign)) newDesign = [];
                if (oldDesign.length === 0 && newDesign.length > 0) {
                  try { showToast('Yêu cầu của bạn đã có MQ. Mở app để xem.'); } catch (_) {}
                  break;
                }

                // 2) Status moved to done/processed
                const oldStatus = String(oldReq.status || '').toLowerCase();
                const newStatus = String(newReq.status || '').toLowerCase();
                if ((newStatus === 'done' || newStatus === 'processed') && oldStatus !== newStatus) {
                  try { showToast('Yêu cầu của bạn đã được hoàn thành.'); } catch (_) {}
                  break;
                }

                // 3) edit-resolved comment appended
                let oldComments = [];
                let newComments = [];
                try { oldComments = JSON.parse(oldReq.comments || '[]'); } catch (e) { oldComments = []; }
                try { newComments = JSON.parse(newReq.comments || '[]'); } catch (e) { newComments = []; }
                if (Array.isArray(newComments) && Array.isArray(oldComments) && newComments.length > oldComments.length) {
                  const last = newComments[newComments.length - 1] || {};
                  if (String(last.commentType || '').toLowerCase() === 'edit-resolved') {
                    try { showToast('QCAG đã hoàn tất chỉnh sửa theo yêu cầu.'); } catch (_) {}
                    break;
                  }
                }
              } catch (e) {
                // per-request safety: continue to next
                continue;
              }
            }
          }
        } catch (e) {
          console.warn('onDataChanged diff check failed', e);
        }

        allRequests = data;
        // keep a deep clone as previous snapshot so later diffs are stable
        try { _lastDataSdkSnapshot = data ? JSON.parse(JSON.stringify(data)) : []; } catch (e) { _lastDataSdkSnapshot = data || []; }
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
      }
    });
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
