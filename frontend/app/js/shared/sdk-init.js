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

async function initHomeAndLoad() {
  await initApp();
}

async function initApp() {
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
