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
