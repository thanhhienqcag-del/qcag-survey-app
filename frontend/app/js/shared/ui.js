// ====================================================================
// js/shared/ui.js — toast notification and generic modal helpers
// ====================================================================
'use strict';

// Dismiss the on-screen keyboard before showing a modal overlay
function blurActiveInput() {
  try {
    const el = document.activeElement;
    if (el && typeof el.blur === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
      el.blur();
    }
  } catch (e) {}
}

let _toastTimer = null;

function _ksDetectToastType(msg, explicitType) {
  if (typeof explicitType === 'string' && explicitType) {
    const t = explicitType.toLowerCase().trim();
    if (t === 'success' || t === 'done' || t === 'ok') return 'done';
    if (t === 'warning' || t === 'warn' || t === 'warranty') return 'warning';
    if (t === 'error' || t === 'danger' || t === 'fail') return 'error';
    if (t === 'info' || t === 'new') return 'new';
    if (t === 'editing' || t === 'edit') return 'editing';
    return t;
  }
  const str = String(msg || '').toLowerCase();
  if (str.includes('✓') || str.includes('✅') || str.includes('thành công') || str.includes('đã lưu') || str.includes('đã copy') || str.includes('đã gửi') || str.includes('hoàn tất') || str.includes('hoàn thành')) {
    return 'done';
  }
  if (str.includes('❌') || str.includes('lỗi') || str.includes('không thể') || str.includes('thất bại') || str.includes('từ chối') || str.includes('bị từ chối')) {
    return 'error';
  }
  if (str.includes('⚠') || str.includes('chưa có') || str.includes('vui lòng') || str.includes('chưa') || str.includes('cảnh báo')) {
    return 'warning';
  }
  if (str.includes('đang') || str.includes('chỉnh sửa') || str.includes('yêu cầu')) {
    return 'editing';
  }
  return 'default';
}

function showToast(message, typeOrDuration, maybeDuration) {
  const toast = document.getElementById('toast');
  const toastInner = document.getElementById('toastInner');
  const toastMsg = document.getElementById('toastMessage');
  if (!toastInner || !toastMsg) return;

  let type = 'default';
  let durationMs = 2500;

  if (typeof typeOrDuration === 'number') {
    durationMs = typeOrDuration;
  } else if (typeof typeOrDuration === 'string') {
    type = typeOrDuration;
    if (typeof maybeDuration === 'number') durationMs = maybeDuration;
  } else if (typeof maybeDuration === 'number') {
    durationMs = maybeDuration;
  }

  type = _ksDetectToastType(message, type);

  const isDark = document.documentElement.classList.contains('dark') ||
                 document.body.classList.contains('dark');

  const typeStyles = {
    done: {
      border: isDark ? 'rgba(52, 211, 153, 0.75)' : '#10b981',
      stroke: isDark ? '#34d399' : '#059669',
      glow: isDark ? '0 8px 24px -4px rgba(0, 0, 0, 0.5), 0 0 14px rgba(52, 211, 153, 0.3)' : '0 8px 20px -4px rgba(16, 185, 129, 0.25)',
      svg: '<svg class="w-4 h-4 flex-shrink-0 inline-block mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>'
    },
    warning: {
      border: isDark ? 'rgba(251, 191, 36, 0.75)' : '#f59e0b',
      stroke: isDark ? '#fbbf24' : '#d97706',
      glow: isDark ? '0 8px 24px -4px rgba(0, 0, 0, 0.5), 0 0 14px rgba(251, 191, 36, 0.3)' : '0 8px 20px -4px rgba(245, 158, 11, 0.25)',
      svg: '<svg class="w-4 h-4 flex-shrink-0 inline-block mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>'
    },
    editing: {
      border: isDark ? 'rgba(251, 191, 36, 0.75)' : '#f59e0b',
      stroke: isDark ? '#fbbf24' : '#d97706',
      glow: isDark ? '0 8px 24px -4px rgba(0, 0, 0, 0.5), 0 0 14px rgba(251, 191, 36, 0.3)' : '0 8px 20px -4px rgba(245, 158, 11, 0.25)',
      svg: '<svg class="w-4 h-4 flex-shrink-0 inline-block mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>'
    },
    error: {
      border: isDark ? 'rgba(248, 113, 113, 0.75)' : '#ef4444',
      stroke: isDark ? '#f87171' : '#dc2626',
      glow: isDark ? '0 8px 24px -4px rgba(0, 0, 0, 0.5), 0 0 14px rgba(248, 113, 113, 0.3)' : '0 8px 20px -4px rgba(239, 68, 68, 0.25)',
      svg: '<svg class="w-4 h-4 flex-shrink-0 inline-block mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>'
    },
    new: {
      border: isDark ? 'rgba(56, 189, 248, 0.75)' : '#0ea5e9',
      stroke: isDark ? '#38bdf8' : '#0284c7',
      glow: isDark ? '0 8px 24px -4px rgba(0, 0, 0, 0.5), 0 0 14px rgba(56, 189, 248, 0.3)' : '0 8px 20px -4px rgba(14, 165, 233, 0.25)',
      svg: '<svg class="w-4 h-4 flex-shrink-0 inline-block mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
    },
    default: {
      border: isDark ? 'rgba(249, 115, 22, 0.75)' : '#f97316',
      stroke: isDark ? '#fb923c' : '#ea580c',
      glow: isDark ? '0 8px 24px -4px rgba(0, 0, 0, 0.5), 0 0 14px rgba(249, 115, 22, 0.3)' : '0 8px 20px -4px rgba(249, 115, 22, 0.25)',
      svg: '<svg class="w-4 h-4 flex-shrink-0 inline-block mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
    }
  };

  const style = typeStyles[type] || typeStyles.default;
  const cleanMsg = String(message || '').trim().replace(/</g, '&lt;');
  toastMsg.innerHTML = '<span style="display:inline-flex;align-items:center;color:' + style.stroke + ';">' + style.svg + '</span>' + cleanMsg;
  toastInner.style.borderColor = style.border;
  toastInner.style.boxShadow = style.glow;

  // Position at top of visual viewport so it's visible even when keyboard is open
  if (window.visualViewport) {
    const vp = window.visualViewport;
    toast.style.top = (vp.offsetTop + 24) + 'px';
    toast.style.left = vp.offsetLeft + 'px';
    toast.style.width = vp.width + 'px';
  }
  // Cancel any previous auto-hide timer so the new toast gets its full duration
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  // Drop from above: remove hidden translate/scale/opacity, add visible classes
  toastInner.classList.remove('opacity-0', 'scale-90', '-translate-y-20');
  toastInner.classList.add('opacity-100', 'scale-100', 'translate-y-0');
  _toastTimer = setTimeout(() => {
    _toastTimer = null;
    // hide by reverting to initial hidden state (move up + shrink + fade)
    toastInner.classList.remove('opacity-100', 'scale-100', 'translate-y-0');
    toastInner.classList.add('opacity-0', 'scale-90', '-translate-y-20');
    // Reset inline styles
    toast.style.top = '';
    toast.style.left = '';
    toast.style.width = '';
  }, durationMs);
}

// Toggle a modal backdrop class that blurs and disables the background
function enableModalBackdrop() {
  try {
    document.body.classList.add('modal-open');
  } catch (e) {}
}

function disableModalBackdrop() {
  try {
    document.body.classList.remove('modal-open');
  } catch (e) {}
}

function openConfirmSuccessModal() {
  const m = document.getElementById('confirmModal');
  if (m) {
    m.classList.remove('hidden');
    enableModalBackdrop();
  }
}

function closeConfirmSuccessModal() {
  const m = document.getElementById('confirmModal');
  if (m) {
    m.classList.add('hidden');
    disableModalBackdrop();
  }
}

// ── Loading Overlay (Smart Debounce: Chống chớp giật cho các tác vụ siêu tốc < 300ms) ──
var _ksLoadingTimer = null;
var _ksLoadingShownAt = 0;
var _KS_DEBOUNCE_MS = 300;
var _KS_MIN_HOLD_MS = 350;

function showLoadingOverlay(message, subMessage, immediate) {
  var el = document.getElementById('loadingOverlay');
  if (!el) return;
  var msg = document.getElementById('loadingOverlayMsg');
  var sub = document.getElementById('loadingOverlaySub');
  if (msg) msg.textContent = message || 'Đang xử lý...';
  if (sub) { sub.textContent = subMessage || ''; sub.style.display = subMessage ? '' : 'none'; }

  if (immediate) {
    if (_ksLoadingTimer) { clearTimeout(_ksLoadingTimer); _ksLoadingTimer = null; }
    el.classList.add('active');
    _ksLoadingShownAt = Date.now();
  } else if (!_ksLoadingTimer && !el.classList.contains('active')) {
    _ksLoadingTimer = setTimeout(function() {
      _ksLoadingTimer = null;
      el.classList.add('active');
      _ksLoadingShownAt = Date.now();
    }, _KS_DEBOUNCE_MS);
  }
}

function hideLoadingOverlay() {
  if (_ksLoadingTimer) {
    clearTimeout(_ksLoadingTimer);
    _ksLoadingTimer = null;
  }
  var el = document.getElementById('loadingOverlay');
  if (!el) return;

  if (el.classList.contains('active')) {
    var elapsed = Date.now() - _ksLoadingShownAt;
    if (_ksLoadingShownAt > 0 && elapsed < _KS_MIN_HOLD_MS) {
      setTimeout(function() {
        el.classList.remove('active');
        _ksLoadingShownAt = 0;
      }, _KS_MIN_HOLD_MS - elapsed);
    } else {
      el.classList.remove('active');
      _ksLoadingShownAt = 0;
    }
  } else {
    _ksLoadingShownAt = 0;
  }
}

// Toggle per-home-stats loading state (non-blocking). When enabled,
// dashboard counters show a loading placeholder instead of zero.
function setHomeStatsLoading(on) {
  try {
    window._homeStatsLoading = !!on;
    // Toggle visual class on stat elements so they show pulse animation
    var ids = ['statAll','statWaiting','statHasMQ','statEditing','statWarrantyPending','statWarrantyDone','requestCount','newCount','warrantyCount'];
    ids.forEach(function(id) {
      try {
        var el = document.getElementById(id);
        if (!el) return;
        if (window._homeStatsLoading) {
          el.classList.add('stat-loading');
        } else {
          el.classList.remove('stat-loading');
        }
      } catch (e) {}
    });

    // Show/hide the small home-loading note: CHỈ hiển thị khi đang chờ tải VÀ chưa có dữ liệu
    try {
      var note = document.getElementById('homeLoadNote');
      if (note) {
        var reqs = (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) ? allRequests : [];
        var shouldShow = Boolean(window._homeStatsLoading && reqs.length === 0);
        note.style.display = shouldShow ? '' : 'none';
        note.classList.toggle('hidden', !shouldShow);
      }
    } catch (e) {}

    // banner removed — no-op

    if (typeof updateRequestCount === 'function') updateRequestCount();
    if (typeof updateHomeStats === 'function') updateHomeStats();
  } catch (e) {}
}
window.setHomeStatsLoading = setHomeStatsLoading;

// ── Push notification helper (frontend → /api/ks/push/send) ───────────
function sendPushNotification(opts) {
  // opts: { title, body, role, phone, saleCode, data }
  // Best-effort, never blocks UI
  try {
    var pushUrl = (location.hostname === 'qcag-survey-app.vercel.app')
      ? '/api/ks/push/send'
      : 'https://qcag-survey-app.vercel.app/api/ks/push/send';
    fetch(pushUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: opts.title || 'QCAG',
        body: opts.body || '',
        role: opts.role || undefined,
        phone: opts.phone || undefined,
        saleCode: opts.saleCode || undefined,
        data: opts.data || {},
      }),
    }).then(function (r) {
      if (!r.ok) return;
      return r.json().then(function (json) {
        if (json && json.ok && json.sent === 0) {
          // All subscriptions were stale/missing — inform the sender
          console.warn('[push] sent=0 — subscription hết hạn hoặc chưa đăng ký. Yêu cầu người dùng mở app rồi thử lại.');
          if (typeof showToast === 'function') {
            showToast('⚠️ Không gửi được thông báo. Yêu cầu người dùng mở app rồi thử lại.');
          }
        }
      });
    }).catch(function (e) { console.warn('[push/send]', e); });
  } catch (e) {
    console.warn('[push] sendPushNotification error (non-fatal):', e);
  }
}
