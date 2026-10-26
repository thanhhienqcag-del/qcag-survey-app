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
    if (!Array.isArray(allRequests)) return;
    const slim = allRequests.slice(0, 50).map(r => ({
      id: r.id,
      __backendId: r.__backendId,
      tkCode: r.tkCode,
      status: r.status,
      outletName: r.outletName,
      outletCode: r.outletCode,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }));
    localStorage.setItem('ks_requests', JSON.stringify(slim));
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

  // Route directly to unified pill banner singleton toast
  if (typeof showToast === 'function') {
    showToast(title, body, type || 'new', 4500);

    // Attach click-to-open behavior if backendId is provided
    if (backendId) {
      setTimeout(function () {
        var toastEl = document.getElementById('ksUnifiedToast');
        if (toastEl) {
          toastEl.style.cursor = 'pointer';
          toastEl.onclick = function (e) {
            if (e.target && (e.target.id === 'ksUnifiedToastClose' || e.target.closest('#ksUnifiedToastClose'))) {
              return;
            }
            try {
              if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop() && typeof showQCAGDesktopDetail === 'function') {
                showQCAGDesktopDetail(backendId);
              } else if (typeof showRequestDetail === 'function') {
                showRequestDetail(backendId);
              }
            } catch (_) {}
            if (typeof _ksDismissUnifiedToast === 'function') {
              _ksDismissUnifiedToast(toastEl);
            }
          };
        }
      }, 50);
    }
  }
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
// ── Global SSE invalidation hook (called from data_sdk) ──────────────
// Detect new/warranty/edit requests, quote updates, and show desktop banner/toast instantly.
window.__ksOnInvalidate = function (payload) {
  if (!payload) return;

  var resType = String(payload.resource || '').toLowerCase();

  // ── 2. Xử lý realtime Báo Giá từ App 1 (quote_ready hoặc resource quotations) ──
  if (payload.quote_ready || resType === 'quotations') {
    var targetTk = payload.tkCode || payload.tk_code || (payload.data && (payload.data.tk_code || payload.data.tkCode)) || '';
    var targetQuoteCode = payload.quote_code || payload.quoteCode || payload.id || (payload.data && (payload.data.quote_code || payload.data.quoteCode)) || '';
    var totalAmt = Number(payload.quote_total || (payload.data && (payload.data.total_amount || payload.data.totalAmount)) || 0);

    // Cache quote trực tiếp vào window._quoteDataMap
    window._quoteDataMap = window._quoteDataMap || {};
    if (payload.data && typeof payload.data === 'object') {
      if (targetTk) window._quoteDataMap[targetTk] = payload.data;
      if (targetQuoteCode) window._quoteDataMap[targetQuoteCode] = payload.data;
      if (payload.data.__backendId) window._quoteDataMap[payload.data.__backendId] = payload.data;
    }

    // In-Place Memory Patch: Gắn ngay báo giá vào thẻ request tương ứng trong allRequests
    var tkMatch = targetTk || payload.tkCode;
    var qMatch = targetQuoteCode || payload.quote_code;
    if (typeof allRequests !== 'undefined' && Array.isArray(allRequests) && (tkMatch || qMatch)) {
      var foundIdx = allRequests.findIndex(function (r) {
        if (!r) return false;
        var rTk = String(r.tkCode || r.tk_code || '').trim().toLowerCase();
        var rQ = String(r.quoteCode || r.quote_code || (r.bridge && r.bridge.quote_code) || '').trim().toLowerCase();
        if (tkMatch && rTk && rTk === String(tkMatch).trim().toLowerCase()) return true;
        if (qMatch && rQ && rQ === String(qMatch).trim().toLowerCase()) return true;
        return false;
      });

      if (foundIdx !== -1) {
        var reqObj = allRequests[foundIdx];
        reqObj.quoteCode = qMatch || reqObj.quoteCode;
        if (totalAmt > 0) reqObj.totalAmount = totalAmt;
        reqObj.bridge = Object.assign({}, reqObj.bridge || {}, {
          quote_code: qMatch || (reqObj.bridge && reqObj.bridge.quote_code),
          quoteCode: qMatch || (reqObj.bridge && reqObj.bridge.quoteCode),
          total_amount: totalAmt || (reqObj.bridge && reqObj.bridge.total_amount) || 0,
          totalAmount: totalAmt || (reqObj.bridge && reqObj.bridge.totalAmount) || 0,
          status: 'confirmed'
        });
        if (typeof saveAllRequestsToStorage === 'function') saveAllRequestsToStorage();

        // In-Place DOM Update ngay lập tức (không cần chờ fetch mạng)
        if (typeof renderRequestList === 'function') renderRequestList();
        if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop() && typeof renderQCAGDesktopList === 'function') {
          renderQCAGDesktopList();
        }
      }
    }

    // Tải đối soát nhắm mục tiêu tức thì qua B-Tree Index (< 10ms)
    if (typeof _fetchTargetedQuoteByTk === 'function' && (targetTk || targetQuoteCode)) {
      _fetchTargetedQuoteByTk(targetTk, targetQuoteCode).then(function (q) {
        if (q && typeof renderRequestList === 'function') {
          renderRequestList();
        }
      }).catch(function () {});
    } else if (typeof _fetchApp1QuoteListWithCache === 'function') {
      _fetchApp1QuoteListWithCache(true).then(function () {
        if (typeof renderRequestList === 'function') {
          renderRequestList();
        }
      }).catch(function () {});
    }

    if (payload.quote_ready) {
      var qOutlet = payload.outlet_name || (payload.data && (payload.data.outletName || payload.data.outletCode)) || 'Điểm bán';
      var qAmt = payload.amount_formatted ? (' — ' + payload.amount_formatted) : '';
      if (typeof _ksShowDesktopBanner === 'function' && payload.data && payload.data.__backendId) {
        _ksShowDesktopBanner('Đã có Báo Giá', 'Điểm bán ' + qOutlet + ' đã có báo giá' + qAmt, payload.data.__backendId, 'done');
      } else if (typeof showToast === 'function') {
        showToast('Đã có Báo Giá • Điểm bán ' + qOutlet + ' đã có báo giá' + qAmt, 'done', 4000);
      }
    }
    if (resType === 'quotations' && !payload.quote_ready) return;
  }

  if (resType !== 'ks_requests') return;
  var action = payload.action;
  var data = payload.data;

  // ── 3. Xử lý Yêu Cầu Chỉnh Sửa / Ghi Chú Chat (action: 'note' hoặc có payload.note) ──
  if (action === 'note' || payload.note) {
    var note = payload.note;
    var targetId = payload.id;
    if (note && targetId) {
      var reqList = (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) ? allRequests : [];
      var matchedReq = reqList.find(function (r) {
        return (r.tkCode && r.tkCode === targetId) || (r.__backendId && r.__backendId === targetId) || String(r.id) === String(targetId);
      });

      var noteText = String(note.text || note.noteText || '');
      var isEditReq = note.noteType === 'edit_requested' || note.noteType === 'edit-request' ||
                      /chỉnh\s+sửa|yêu\s+cầu\s+sửa/i.test(noteText) ||
                      (Array.isArray(note.editCategories) && note.editCategories.length > 0);

      if (isEditReq && matchedReq) {
        matchedReq.editingRequestedAt = note.createdAt || new Date().toISOString();
        if (typeof saveAllRequestsToStorage === 'function') saveAllRequestsToStorage();

        // Gắn tag chỉnh sửa in-place trên thẻ danh sách ngay lập tức
        var cardEl = document.querySelector('[data-req-id="' + matchedReq.__backendId + '"]') ||
                     document.querySelector('[data-req-id="' + targetId + '"]');
        if (cardEl) {
          var thumbWrap = cardEl.querySelector('.mq-thumb-wrapper, .qcag-thumb-wrap');
          if (thumbWrap && !thumbWrap.querySelector('.mq-editing-badge-overlay')) {
            var badge = document.createElement('div');
            badge.className = 'mq-editing-badge-overlay';
            badge.textContent = 'Đang chỉnh sửa';
            thumbWrap.appendChild(badge);
          }
          var img = cardEl.querySelector('.mq-card-img, .qcag-mq-img');
          if (img) img.classList.add('mq-img-editing');
        }

        // Cập nhật QCAG Desktop tasks nếu đang mở
        if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
          if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();
          if (typeof updateDesktopTaskBadge === 'function') updateDesktopTaskBadge();
        }

        var oLabel = matchedReq.outletName || matchedReq.outletCode || 'Điểm bán';
        if (typeof _ksShowDesktopBanner === 'function') {
          _ksShowDesktopBanner('Yêu cầu chỉnh sửa MQ', 'Điểm bán ' + oLabel + ' yêu cầu chỉnh sửa thiết kế', matchedReq.__backendId || targetId, 'editing');
        } else if (typeof showToast === 'function') {
          showToast('Yêu cầu chỉnh sửa MQ • Điểm bán ' + oLabel + ' yêu cầu chỉnh sửa thiết kế', 'editing', 3500);
        }
      }

      // Đẩy tin nhắn vào khung chat đang mở ngay lập tức (In-Place DOM Patch)
      if (typeof _appendCommentToActiveChat === 'function') {
        _appendCommentToActiveChat(note, targetId);
      }
    }
    return;
  }

  if (!data || !data.__backendId) {
    if (window.dataSdk && typeof window.dataSdk.refresh === 'function') {
      window.dataSdk.refresh(true).catch(function () {});
    }
    return;
  }

  var bid = data.__backendId;
  var prev = _ksKnownRequestIds[bid];
  var type = data.type || 'new';
  var outletLabel = data.outletName || data.outletCode || 'Điểm bán';

  // ── 1. Request mới (action: 'create'): Hiển thị thông báo + Hiện THẺ LẬP TỨC ──
  if (action === 'create' && !prev) {
    if (type === 'warranty') {
      _ksShowDesktopBanner('Yêu cầu bảo hành mới', 'Điểm bán ' + outletLabel, bid, 'warranty');
    } else {
      _ksShowDesktopBanner('Yêu cầu khảo sát mới', 'Điểm bán ' + outletLabel, bid, 'new');
    }
    // Cập nhật snapshot
    _ksKnownRequestIds[bid] = { status: data.status || '', editingRequestedAt: data.editingRequestedAt || null, designImages: data.designImages || '[]' };

    // In-Place Memory Update: Đưa vào đầu danh sách allRequests nếu chưa có
    if (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) {
      var existsIdx = allRequests.findIndex(function (r) {
        return r.__backendId === bid || (data.tkCode && r.tkCode === data.tkCode);
      });
      if (existsIdx === -1) {
        allRequests.unshift(data);
      } else {
        Object.assign(allRequests[existsIdx], data);
      }
      if (typeof saveAllRequestsToStorage === 'function') saveAllRequestsToStorage();
    }

    // In-Place DataSdk Store Update
    if (window.dataSdk && Array.isArray(window.dataSdk._store)) {
      var storeExists = window.dataSdk._store.some(function (r) { return r.__backendId === bid; });
      if (!storeExists) window.dataSdk._store.unshift(data);
    }

    // In-Place DOM Render: Thẻ xuất hiện ngay lập tức trên màn hình
    if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
      if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();
      if (typeof updateDesktopTaskBadge === 'function') updateDesktopTaskBadge();
      if (typeof renderQcagTaskList === 'function') {
        var taskDd = document.getElementById('qcagTaskDropdown');
        if (taskDd && !taskDd.classList.contains('hidden')) renderQcagTaskList();
      }
    } else {
      if (typeof renderRequestList === 'function') renderRequestList();
      if (typeof updateRequestCount === 'function') updateRequestCount();
      if (typeof setHomeStatsLoading === 'function') setHomeStatsLoading(false);
      if (typeof renderHomeStats === 'function') renderHomeStats();
    }
    return;
  }

  // Cập nhật request hiện hữu (action: 'update')
  if (prev) {
    // Editing requested (Sale asked for changes)
    if (data.editingRequestedAt && !prev.editingRequestedAt) {
      _ksShowDesktopBanner('Yêu cầu chỉnh sửa MQ', 'Điểm bán ' + outletLabel + ' yêu cầu chỉnh sửa thiết kế', bid, 'editing');
    }
    // QCAG completed MQ (status → done)
    if (data.status === 'done' && prev.status !== 'done') {
      _ksShowDesktopBanner('MQ đã hoàn thành', 'Điểm bán ' + outletLabel + ' đã hoàn tất mẫu quảng cáo', bid, 'done');
    }
    // Update snapshot
    _ksKnownRequestIds[bid] = { status: data.status || '', editingRequestedAt: data.editingRequestedAt || null, designImages: data.designImages || '[]' };
  }
};

async function initHomeAndLoad() {
  await initApp();
}

async function initApp() {
  // Chỉ hiển thị loading overlay chặn màn hình cho QCAG Desktop; Mobile Heineken tải ngầm và hiển thị dòng đỏ homeLoadNote
  if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
    if (typeof showLoadingOverlay === 'function') {
      showLoadingOverlay('Đang tải dữ liệu...', 'Đang đồng bộ danh sách khảo sát');
    }
  }
  try { if (typeof setHomeStatsLoading === 'function') setHomeStatsLoading(true); } catch (e) {}

  // Chốt chặn an toàn: Tuyệt đối không bao giờ để overlay treo màn hình quá 1.5s
  setTimeout(() => {
    if (typeof hideLoadingOverlay === 'function') hideLoadingOverlay();
  }, 1500);

  // Fast-path: Load full cached requests from IndexedDB (all 3,665+ rows, not truncated to 100)
  try {
    if (typeof window !== 'undefined' && window.ksIdb && window.ksIdb.isSupported()) {
      const cachedRows = await window.ksIdb.getAll();
      if (Array.isArray(cachedRows) && cachedRows.length > 0) {
        allRequests = _ksDedupeRequests(cachedRows);
        updateRequestCount();
        if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
          if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();
          if (typeof hideLoadingOverlay === 'function') hideLoadingOverlay();
        }
        const listEl = document.getElementById('listScreen');
        if (listEl && listEl.classList.contains('flex')) renderRequestList();
        try { if (typeof setHomeStatsLoading === 'function') setHomeStatsLoading(false); } catch (e) {}
      }
    }
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
    try {
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
        try { if (typeof setHomeStatsLoading === 'function') setHomeStatsLoading(false); } catch (e) {}
        if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
          // Debounce 100ms: gom các đợt bão packet realtime liên tiếp thành 1 lần render duy nhất
          if (typeof window._qcagDebouncedRenderTimer !== 'undefined' && window._qcagDebouncedRenderTimer) {
            clearTimeout(window._qcagDebouncedRenderTimer);
          }
          window._qcagDebouncedRenderTimer = setTimeout(() => {
            window._qcagDebouncedRenderTimer = null;
            if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();
            if (typeof updateDesktopTaskBadge === 'function') updateDesktopTaskBadge();
            if (typeof renderQcagTaskList === 'function') {
              const taskDd = document.getElementById('qcagTaskDropdown');
              if (taskDd && !taskDd.classList.contains('hidden')) renderQcagTaskList();
            }
          }, 100);

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
                const isPlaceholderDesign = updated.designImages === '["..."]';
                const hasDesignChanged = !isPlaceholderDesign && ((currentDetailRequest.designImages || '').length !== (updated.designImages || '').length);
                const hasChanged = (newTs !== oldTs) ||
                                   (newCommentsLen !== oldCommentsLen) ||
                                   hasDesignChanged ||
                                   (updated.status !== currentDetailRequest.status) ||
                                   (updated.editingRequestedAt !== currentDetailRequest.editingRequestedAt) ||
                                   (Boolean(updated.deleteRequested) !== Boolean(currentDetailRequest.deleteRequested));

                const isJustOptimisticallySaved = !!(window._qcagLastOptimisticSaveTs && 
                  (Date.now() - window._qcagLastOptimisticSaveTs < 4000) && 
                  window._qcagLastOptimisticSaveId === updated.__backendId);

                if (hasChanged && !isJustOptimisticallySaved) {
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
              } else {
                // Item đang mở đã bị xóa khỏi hệ thống qua realtime
                const deadBid = currentDetailRequest.__backendId;
                const deadTk = currentDetailRequest.tkCode;
                if (typeof _qcagDesktopFullRequestCache !== 'undefined') {
                  if (deadBid) delete _qcagDesktopFullRequestCache[deadBid];
                  if (deadTk) delete _qcagDesktopFullRequestCache[deadTk];
                }
                _qcagDesktopCurrentId = null;
                currentDetailRequest = null;
                const detailEl = document.getElementById('qcagDesktopDetail');
                if (detailEl) detailEl.innerHTML = '<div class="qcag-desktop-empty-placeholder">Chọn một yêu cầu khảo sát từ danh sách bên trái để xem chi tiết.</div>';
              }
            }
          } catch (e) {
            console.warn('qcag desktop in-place refresh failed', e);
          }
        }
        const listEl = document.getElementById('listScreen');
        if (listEl && listEl.classList.contains('flex')) {
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
              const detailUpdated = (allRequests || []).find(r => r.__backendId === currentDetailRequest.__backendId || (currentDetailRequest.tkCode && r.tkCode === currentDetailRequest.tkCode));
              if (detailUpdated) {
                const oldTs = currentDetailRequest.updatedAt ? new Date(currentDetailRequest.updatedAt).getTime() : 0;
                const newTs = detailUpdated.updatedAt ? new Date(detailUpdated.updatedAt).getTime() : 0;
                if (newTs !== oldTs && typeof showRequestDetail === 'function') {
                  showRequestDetail(detailUpdated.__backendId);
                }
              } else {
                // Khảo sát đã bị xóa bởi QCAG
                currentDetailRequest = null;
                if (typeof showScreen === 'function') showScreen('listScreen');
                if (typeof showToast === 'function') showToast('Khảo sát này đã được xóa');
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
    if (!result.isOk) {
      showToast('Lỗi kết nối dữ liệu');
    }
    } catch (sdkInitErr) {
      console.warn('[sdk-init] dataSdk.init error:', sdkInitErr);
    } finally {
      if (typeof hideLoadingOverlay === 'function') hideLoadingOverlay();
      try { if (typeof setHomeStatsLoading === 'function') setHomeStatsLoading(false); } catch (e) {}
    }
  }

  // If no remote data SDK, load from localStorage as a fallback
  if (!window.dataSdk) {
    loadAllRequestsFromStorage();
    updateRequestCount();
    if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
      if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();
    }
    const listScreenEl = document.getElementById('listScreen');
    if (listScreenEl && listScreenEl.classList.contains('flex')) {
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
