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
let _toastDismissAnimTimer = null;

function _ksDetectToastType(msg, explicitType) {
  if (typeof explicitType === 'string' && explicitType) {
    const t = explicitType.toLowerCase().trim();
    if (t === 'success' || t === 'done' || t === 'ok') return 'done';
    if (t === 'warning' || t === 'warn') return 'warning';
    if (t === 'warranty') return 'warranty';
    if (t === 'error' || t === 'danger' || t === 'fail') return 'error';
    if (t === 'info' || t === 'new') return 'new';
    if (t === 'editing' || t === 'edit') return 'editing';
    return t;
  }
  const str = String(msg || '').toLowerCase();
  if (str.includes('✓') || str.includes('✅') || str.includes('thành công') || str.includes('đã lưu') || str.includes('đã copy') || str.includes('đã sao chép') || str.includes('đã gửi') || str.includes('hoàn tất') || str.includes('hoàn thành') || str.includes('đã có') || str.includes('đã báo')) {
    return 'done';
  }
  if (str.includes('❌') || str.includes('lỗi') || str.includes('không thể') || str.includes('thất bại') || str.includes('từ chối') || str.includes('bị từ chối') || str.includes('chưa thể') || str.includes('mất kết nối')) {
    return 'error';
  }
  if (str.includes('bảo hành')) {
    return 'warranty';
  }
  if (str.includes('⚠') || str.includes('chưa có') || str.includes('vui lòng') || str.includes('chưa') || str.includes('cảnh báo') || str.includes('trống')) {
    return 'warning';
  }
  if (str.includes('đang') || str.includes('chỉnh sửa') || str.includes('yêu cầu')) {
    return 'editing';
  }
  return 'default';
}

function showToast(titleOrMessage, bodyOrTypeOrDuration, maybeTypeOrDuration, maybeDuration) {
  if (!titleOrMessage && titleOrMessage !== 0) return;

  let title = '';
  let body = '';
  let type = 'default';
  let durationMs = 3000;

  // Flexible argument parser
  if (typeof bodyOrTypeOrDuration === 'string' &&
      !['done', 'success', 'ok', 'warning', 'warn', 'error', 'editing', 'new', 'info', 'warranty', 'default'].includes(bodyOrTypeOrDuration.toLowerCase().trim()) &&
      isNaN(Number(bodyOrTypeOrDuration))) {
    // 2-line mode: showToast(title, body, type, duration)
    title = String(titleOrMessage || '').trim();
    body = String(bodyOrTypeOrDuration || '').trim();
    if (typeof maybeTypeOrDuration === 'string') {
      type = maybeTypeOrDuration;
      if (typeof maybeDuration === 'number') durationMs = maybeDuration;
    } else if (typeof maybeTypeOrDuration === 'number') {
      durationMs = maybeTypeOrDuration;
    }
  } else {
    // 1-line or delimited mode: showToast(message, type, duration)
    const raw = String(titleOrMessage || '').trim();
    if (raw.includes('\n')) {
      const parts = raw.split('\n');
      title = parts[0].trim();
      body = parts.slice(1).join(' ').trim();
    } else if (raw.includes(' • ')) {
      const parts = raw.split(' • ');
      title = parts[0].trim();
      body = parts.slice(1).join(' • ').trim();
    } else {
      title = raw;
      body = '';
    }

    if (typeof bodyOrTypeOrDuration === 'number') {
      durationMs = bodyOrTypeOrDuration;
    } else if (typeof bodyOrTypeOrDuration === 'string') {
      type = bodyOrTypeOrDuration;
      if (typeof maybeTypeOrDuration === 'number') durationMs = maybeTypeOrDuration;
    } else if (typeof maybeTypeOrDuration === 'number') {
      durationMs = maybeTypeOrDuration;
    }
  }

  // Remove crude emojis to keep SVG icons crisp & professional (Rule 2)
  title = title.replace(/[✓✅⚠️⚠❌🚀📦🔥]/g, '').trim();
  body = body.replace(/[✓✅⚠️⚠❌🚀📦🔥]/g, '').trim();

  type = _ksDetectToastType(title + ' ' + body, type);

  const isDark = document.documentElement.classList.contains('dark') ||
                 document.body.classList.contains('dark') ||
                 document.documentElement.classList.contains('theme-dark');

  const typeStyles = {
    done: {
      border: isDark ? 'rgba(52, 211, 153, 0.55)' : '#10b981',
      badgeBg: isDark ? 'rgba(52, 211, 153, 0.18)' : '#ecfdf5',
      stroke: isDark ? '#34d399' : '#059669',
      glow: isDark ? '0 10px 30px -4px rgba(0, 0, 0, 0.55), 0 0 16px rgba(52, 211, 153, 0.25)' : '0 10px 25px -4px rgba(16, 185, 129, 0.2)',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>'
    },
    warning: {
      border: isDark ? 'rgba(251, 191, 36, 0.65)' : '#f59e0b',
      badgeBg: isDark ? 'rgba(251, 191, 36, 0.18)' : '#fffbeb',
      stroke: isDark ? '#fbbf24' : '#d97706',
      glow: isDark ? '0 10px 30px -4px rgba(0, 0, 0, 0.55), 0 0 16px rgba(251, 191, 36, 0.25)' : '0 10px 25px -4px rgba(245, 158, 11, 0.2)',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>'
    },
    editing: {
      border: isDark ? 'rgba(251, 191, 36, 0.65)' : '#f59e0b',
      badgeBg: isDark ? 'rgba(251, 191, 36, 0.18)' : '#fffbeb',
      stroke: isDark ? '#fbbf24' : '#d97706',
      glow: isDark ? '0 10px 30px -4px rgba(0, 0, 0, 0.55), 0 0 16px rgba(251, 191, 36, 0.25)' : '0 10px 25px -4px rgba(245, 158, 11, 0.2)',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>'
    },
    warranty: {
      border: isDark ? 'rgba(251, 146, 60, 0.65)' : '#f97316',
      badgeBg: isDark ? 'rgba(251, 146, 60, 0.18)' : '#fff7ed',
      stroke: isDark ? '#fb923c' : '#ea580c',
      glow: isDark ? '0 10px 30px -4px rgba(0, 0, 0, 0.55), 0 0 16px rgba(251, 146, 60, 0.25)' : '0 10px 25px -4px rgba(249, 115, 22, 0.2)',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>'
    },
    error: {
      border: isDark ? 'rgba(248, 113, 113, 0.65)' : '#ef4444',
      badgeBg: isDark ? 'rgba(248, 113, 113, 0.18)' : '#fef2f2',
      stroke: isDark ? '#f87171' : '#dc2626',
      glow: isDark ? '0 10px 30px -4px rgba(0, 0, 0, 0.55), 0 0 16px rgba(248, 113, 113, 0.25)' : '0 10px 25px -4px rgba(239, 68, 68, 0.2)',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>'
    },
    new: {
      border: isDark ? 'rgba(56, 189, 248, 0.65)' : '#0ea5e9',
      badgeBg: isDark ? 'rgba(56, 189, 248, 0.18)' : '#f0f9ff',
      stroke: isDark ? '#38bdf8' : '#0284c7',
      glow: isDark ? '0 10px 30px -4px rgba(0, 0, 0, 0.55), 0 0 16px rgba(56, 189, 248, 0.25)' : '0 10px 25px -4px rgba(14, 165, 233, 0.2)',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
    },
    default: {
      border: isDark ? 'rgba(148, 163, 184, 0.45)' : '#cbd5e1',
      badgeBg: isDark ? 'rgba(148, 163, 184, 0.18)' : '#f1f5f9',
      stroke: isDark ? '#94a3b8' : '#475569',
      glow: isDark ? '0 10px 30px -4px rgba(0, 0, 0, 0.5), 0 0 16px rgba(148, 163, 184, 0.15)' : '0 10px 25px -4px rgba(15, 23, 42, 0.08)',
      svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
    }
  };

  const style = typeStyles[type] || typeStyles.default;

  // Triệt tiêu banner cũ nếu có để chống đè (Anti-Overlap)
  const oldBanner = document.getElementById('ksDesktopBanner');
  if (oldBanner) { try { oldBanner.remove(); } catch (_) {} }

  // Sử dụng Singleton Toast Container
  let toast = document.getElementById('ksUnifiedToast');
  if (!toast || !toast.parentNode) {
    toast = document.createElement('div');
    toast.id = 'ksUnifiedToast';
    document.body.appendChild(toast);
  }

  // Clear timers to prevent race conditions
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  if (_toastDismissAnimTimer) { clearTimeout(_toastDismissAnimTimer); _toastDismissAnimTimer = null; }

  const bgColor = isDark ? 'rgba(15, 23, 42, 0.95)' : '#f8fafc';
  const textColor = isDark ? '#f8fafc' : '#0f172a';
  const subTextColor = isDark ? '#cbd5e1' : '#475569';
  const closeBtnBg = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)';
  const closeBtnColor = isDark ? '#94a3b8' : '#64748b';

  toast.style.cssText = [
    'position: fixed',
    'top: 16px',
    'left: 50%',
    'transform: translate(-50%, 0) scale(1)',
    'z-index: 99999',
    'display: flex',
    'align-items: center',
    'gap: 12px',
    'max-width: min(92vw, 480px)',
    'width: max-content',
    'padding: 9px 14px',
    'border-radius: 9999px',
    'background: ' + bgColor,
    'color: ' + textColor,
    'border: 1.5px solid ' + style.border,
    'box-shadow: ' + style.glow,
    'backdrop-filter: blur(14px)',
    '-webkit-backdrop-filter: blur(14px)',
    'opacity: 1',
    'pointer-events: auto',
    'user-select: none',
    'font-family: inherit',
    'cursor: default',
    'transition: opacity 250ms cubic-bezier(0.16, 1, 0.3, 1), transform 250ms cubic-bezier(0.16, 1, 0.3, 1), border-color 200ms ease, box-shadow 200ms ease'
  ].join(';');

  const cleanTitle = title.replace(/</g, '&lt;');
  const cleanBody = body.replace(/</g, '&lt;');

  let textHtml = '';
  if (cleanBody) {
    textHtml = '<div style="min-width:0;flex:1;line-height:1.25;">' +
      '<div style="font-size:13px;font-weight:700;color:' + textColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + cleanTitle + '</div>' +
      '<div style="font-size:11.5px;color:' + subTextColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;">' + cleanBody + '</div>' +
    '</div>';
  } else {
    textHtml = '<div style="min-width:0;flex:1;line-height:1.3;">' +
      '<div style="font-size:13px;font-weight:600;color:' + textColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + cleanTitle + '</div>' +
    '</div>';
  }

  toast.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:9999px;background:' + style.badgeBg + ';color:' + style.stroke + ';flex-shrink:0;">' +
      style.svg +
    '</div>' +
    textHtml +
    '<button id="ksUnifiedToastClose" style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:9999px;border:none;background:' + closeBtnBg + ';color:' + closeBtnColor + ';font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0;margin-left:4px;transition:background 0.2s;" title="Đóng">✕</button>';

  const closeBtn = toast.querySelector('#ksUnifiedToastClose');
  if (closeBtn) {
    closeBtn.onclick = function (e) {
      e.stopPropagation();
      _ksDismissUnifiedToast(toast);
    };
  }

  _toastTimer = setTimeout(() => {
    _ksDismissUnifiedToast(toast);
  }, durationMs);
}

function _ksDismissUnifiedToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.style.transform = 'translate(-50%, -20px) scale(0.95)';
  toast.style.opacity = '0';
  _toastDismissAnimTimer = setTimeout(() => {
    try {
      if (toast && toast.parentNode) toast.remove();
    } catch (_) {}
  }, 250);
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
            showToast('Không thể gửi thông báo • Vui lòng nhắc người dùng mở ứng dụng rồi thử lại', 'warning');
          }
        }
      });
    }).catch(function (e) { console.warn('[push/send]', e); });
  } catch (e) {
    console.warn('[push] sendPushNotification error (non-fatal):', e);
  }
}
