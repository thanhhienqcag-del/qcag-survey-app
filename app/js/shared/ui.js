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
function showToast(message, durationMs) {
  const toast = document.getElementById('toast');
  const toastInner = document.getElementById('toastInner');
  if (!toastInner) return;
  document.getElementById('toastMessage').textContent = message;
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
  }, durationMs || 2500);
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

// ── Loading Overlay ──────────────────────────────────────────────────────
function showLoadingOverlay(message, subMessage) {
  var el = document.getElementById('loadingOverlay');
  if (!el) return;
  var msg = document.getElementById('loadingOverlayMsg');
  var sub = document.getElementById('loadingOverlaySub');
  if (msg) msg.textContent = message || 'Đang xử lý...';
  if (sub) { sub.textContent = subMessage || ''; sub.style.display = subMessage ? '' : 'none'; }
  el.classList.add('active');
}

function hideLoadingOverlay() {
  var el = document.getElementById('loadingOverlay');
  if (el) el.classList.remove('active');
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

    // Show/hide the small home-loading note so users know they can create while data loads
    try {
      var note = document.getElementById('homeLoadNote');
      if (note) note.style.display = window._homeStatsLoading ? '' : 'none';
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
    var pushUrl = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? 'https://qcag-survey-app.vercel.app/api/ks/push/send'
      : '/api/ks/push/send';
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
