/**
 * QCAG Zero-Polling Auto-Update (Zero Extra Requests, Zero DB Traffic)
 * Listens to normal application fetch calls and checks the "X-Server-Boot" header.
 * When a new deployment is detected:
 * - If user is idle (not editing): safely reloads page.
 * - If user is editing a form/modal: shows a subtle "Cập nhật ngay" banner so work is not lost.
 */
(function () {
  if (typeof window === 'undefined' || window.__qcagZeroPollingInit) return;
  window.__qcagZeroPollingInit = true;

  var RELOAD_COOLDOWN_MS = 30 * 1000;
  var initialBootId = null;
  var updateDetected = false;
  var bannerDismissed = false;

  function isUserEditing() {
    var active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
      var type = String(active.type || '').toLowerCase();
      if (type !== 'search' && type !== 'checkbox' && type !== 'radio') {
        return true;
      }
    }
    var modals = document.querySelectorAll('.modal, [role="dialog"], .qcag-modal-overlay, .fixed.inset-0');
    for (var i = 0; i < modals.length; i++) {
      var el = modals[i];
      if (!el || el.id === 'qcagAutoUpdateBanner') continue;
      if (el.classList.contains('hidden')) continue;
      var style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0) {
        return true;
      }
    }
    return false;
  }

  function triggerSafeReload() {
    try {
      var lastReload = Number(sessionStorage.getItem('qcag_auto_reload_ts') || 0);
      if (Date.now() - lastReload < RELOAD_COOLDOWN_MS) return;
      sessionStorage.setItem('qcag_auto_reload_ts', String(Date.now()));
    } catch (_) {}
    window.location.reload();
  }

  function showUpdateBanner(autoReloading) {
    if (document.getElementById('qcagAutoUpdateBanner')) return;
    var isDark = document.documentElement.classList.contains('dark') ||
      document.body.classList.contains('dark-theme') ||
      document.documentElement.getAttribute('data-theme') === 'dark';

    var banner = document.createElement('div');
    banner.id = 'qcagAutoUpdateBanner';
    banner.style.cssText = [
      'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:999999;',
      'display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:10px;',
      'font-family:"Be Vietnam Pro",Inter,sans-serif;font-size:13px;font-weight:500;',
      'box-shadow:0 8px 24px rgba(0,0,0,0.22);border:1px solid;',
      isDark
        ? 'background:#111827;color:#e5e7eb;border-color:#06b6d4;'
        : 'background:#f8fafc;color:#0f172a;border-color:#cbd5e1;'
    ].join('');

    var iconSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="' + (isDark ? '#22d3ee' : '#0284c7') + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';

    if (autoReloading) {
      banner.innerHTML = iconSvg + '<span>Hệ thống có bản cập nhật mới, đang tải lại...</span>';
      document.body.appendChild(banner);
      return;
    }

    var btnStyle = isDark
      ? 'background:#0891b2;color:#ffffff;border:1px solid #22d3ee;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;'
      : 'background:#0284c7;color:#f8fafc;border:1px solid #0369a1;border-radius:6px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;';
    var closeStyle = 'background:transparent;border:none;cursor:pointer;font-size:16px;line-height:1;padding:0 2px;color:' + (isDark ? '#94a3b8' : '#475569') + ';';

    banner.innerHTML = iconSvg +
      '<span>Hệ thống vừa có bản cập nhật mới</span>' +
      '<button type="button" id="qcagAutoUpdateNowBtn" style="' + btnStyle + '">Cập nhật ngay</button>' +
      '<button type="button" id="qcagAutoUpdateCloseBtn" aria-label="Đóng" style="' + closeStyle + '">&times;</button>';
    document.body.appendChild(banner);

    var nowBtn = document.getElementById('qcagAutoUpdateNowBtn');
    if (nowBtn) nowBtn.addEventListener('click', triggerSafeReload);
    var closeBtn = document.getElementById('qcagAutoUpdateCloseBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        bannerDismissed = true;
        banner.remove();
      });
    }
  }

  function processBootId(bootId) {
    if (!bootId || typeof bootId !== 'string') return;
    var trimmed = bootId.trim();
    if (!trimmed) return;

    if (!initialBootId) {
      initialBootId = trimmed;
      return;
    }

    if (trimmed !== initialBootId) {
      updateDetected = true;
      if (!isUserEditing()) {
        showUpdateBanner(true);
        setTimeout(triggerSafeReload, 900);
      } else if (!bannerDismissed) {
        showUpdateBanner(false);
      }
    }
  }

  // Intercept standard window.fetch to inspect X-Server-Boot with ZERO extra calls
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    window.fetch = function () {
      return origFetch.apply(this, arguments).then(function (res) {
        try {
          if (res && res.headers) {
            var bootId = res.headers.get('x-server-boot') || res.headers.get('X-Server-Boot');
            if (bootId) processBootId(bootId);
          }
        } catch (_) {}
        return res;
      });
    };
  }

  // Intercept XMLHttpRequest to inspect X-Server-Boot
  if (typeof window.XMLHttpRequest === 'function') {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
      this.addEventListener('load', function () {
        try {
          var bootId = this.getResponseHeader('x-server-boot') || this.getResponseHeader('X-Server-Boot');
          if (bootId) processBootId(bootId);
        } catch (_) {}
      });
      return origOpen.apply(this, arguments);
    };
  }
})();
