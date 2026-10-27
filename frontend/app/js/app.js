// ====================================================================
// js/app.js — application entry point: boot IIFE and dev helpers
// ====================================================================
'use strict';

const THEME_KEY = 'ks_theme';

function getSavedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch (e) {
    return null;
  }
}

function getPreferredTheme() {
  const saved = getSavedTheme();
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const THEME_SVG_MOON = '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
const THEME_SVG_SUN = '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>';

function updateThemeToggleButton() {
  const isDark = document.documentElement.classList.contains('theme-dark');
  const buttonIds = ['themeToggleBtn', 'accountThemeToggleBtn', 'qcagThemeToggleBtn'];
  buttonIds.forEach(id => {
    const button = document.getElementById(id);
    if (!button) return;
    const iconEl = button.querySelector('.theme-icon');
    const labelEl = button.querySelector('.theme-label');
    if (iconEl) {
      iconEl.innerHTML = isDark ? THEME_SVG_SUN : THEME_SVG_MOON;
    }
    if (labelEl) {
      if (id === 'qcagThemeToggleBtn') {
        labelEl.textContent = isDark ? 'Chế độ tối' : 'Chế độ sáng';
      } else {
        labelEl.textContent = isDark ? 'Sáng' : 'Tối';
      }
    }
    button.title = isDark ? 'Chuyển sang chế độ sáng' : 'Chuyển sang chế độ tối';
    button.setAttribute('aria-label', button.title);
  });
}

function applyTheme(theme) {
  const resolved = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.classList.toggle('theme-dark', resolved === 'dark');
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.setAttribute('data-theme', resolved);
  try { localStorage.setItem(THEME_KEY, resolved); } catch (e) {}
  updateThemeToggleButton();
}

window.toggleTheme = function toggleTheme() {
  const isDark = document.documentElement.classList.contains('theme-dark');
  applyTheme(isDark ? 'light' : 'dark');
};

(function initThemeMode() {
  applyTheme(getPreferredTheme());
})();

// ── Quản lý 4 Giao diện Độc lập (Four-Mode UI Switcher) ───────────────
window.getAppUIMode = function getAppUIMode() {
  const ses = (typeof currentSession !== 'undefined' && currentSession) ? currentSession : (() => {
    try { return JSON.parse(localStorage.getItem('ks_session') || 'null'); } catch (e) { return null; }
  })();
  const isQcag = !!(ses && String(ses.role || '').toLowerCase() === 'qcag');
  const isDesktop = (window.innerWidth >= 1024);
  if (!isQcag && !isDesktop) return 'hk-mobile';
  if (!isQcag && isDesktop) return 'hk-desktop';
  if (isQcag && isDesktop) return 'qcag-desktop';
  return 'qcag-mobile';
};

// ── Đồng bộ tiêu đề tab trình duyệt theo trạng thái luồng (Heineken / QC An Giang Design) ──
window.updateAppTitle = function updateAppTitle(targetRoleOrCompany) {
  try {
    const ses = (typeof currentSession !== 'undefined' && currentSession) ? currentSession : (() => {
      try { return JSON.parse(localStorage.getItem('ks_session') || 'null'); } catch (e) { return null; }
    })();
    const role = String(targetRoleOrCompany || (ses && ses.role) || '').toLowerCase();
    if (role === 'qcag') {
      document.title = 'QC An Giang Design';
    } else if (role === 'heineken') {
      document.title = 'Heineken';
    } else {
      const mode = (typeof window.getAppUIMode === 'function') ? window.getAppUIMode() : '';
      if (mode === 'qcag-desktop' || mode === 'qcag-mobile') {
        document.title = 'QC An Giang Design';
      } else if (mode === 'hk-desktop' || mode === 'hk-mobile') {
        document.title = 'Heineken';
      } else {
        document.title = 'Quản Lý Yêu Cầu Bảng Hiệu';
      }
    }
  } catch (_) {}
};

window.applyAppUIMode = function applyAppUIMode() {
  const mode = window.getAppUIMode();
  document.documentElement.setAttribute('data-app-mode', mode);

  // Cập nhật tiêu đề tab theo luồng
  if (typeof window.updateAppTitle === 'function') {
    window.updateAppTitle();
  }

  // Chỉ kích hoạt stylesheet của mode hiện tại, vô hiệu hóa các stylesheet khác (Zero Cross-Contamination)
  const modeCssMap = {
    'hk-mobile': document.getElementById('css-hk-mobile'),
    'hk-desktop': document.getElementById('css-hk-desktop'),
    'qcag-desktop': document.getElementById('css-qcag-desktop'),
    'qcag-mobile': document.getElementById('css-qcag-mobile')
  };

  Object.keys(modeCssMap).forEach(m => {
    const linkEl = modeCssMap[m];
    if (linkEl) {
      linkEl.disabled = (m !== mode);
    }
  });

  if (document.body) {
    document.body.classList.toggle('qcag-mobile-mode', mode === 'qcag-mobile');
  }
  return mode;
};

// Tự động cập nhật mode khi resize màn hình (có debounce)
let _uiModeResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_uiModeResizeTimer);
  _uiModeResizeTimer = setTimeout(() => {
    try { window.applyAppUIMode(); } catch (e) {}
  }, 120);
});

// ── Boot ──────────────────────────────────────────────────────────────
(function bootApp() {
  try {
    window.applyAppUIMode();
    if (typeof window.updateAppTitle === 'function') {
      window.updateAppTitle();
    }
    const ses = (() => {
      try { return JSON.parse(localStorage.getItem('ks_session') || 'null'); } catch (e) { return null; }
    })();
    if (ses) {
      // Luôn yêu cầu tài khoản Heineken (cả Desktop lẫn Mobile) bắt đầu từ Bước 2 chọn chức vụ
      if (ses.role === 'heineken') {
        const loginEl = document.getElementById('loginScreen');
        if (loginEl) { loginEl.classList.remove('hidden'); loginEl.classList.add('flex'); }
        // Prefill HK profile nếu có, hoặc khôi phục từ ses
        let saved = (() => { try { return JSON.parse(localStorage.getItem('ks_hk_profile') || '{}'); } catch (e) { return {}; } })();
        if ((!saved.phone || !saved.saleCode) && (ses.phone || ses.saleCode)) {
          saved = {
            phone: saved.phone || ses.phone || '',
            saleCode: saved.saleCode || ses.saleCode || '',
            saleName: saved.saleName || ses.saleName || ses.name || ''
          };
          try { localStorage.setItem('ks_hk_profile', JSON.stringify(saved)); } catch (_) {}
        }
        const pEl = document.getElementById('hkPhone');
        const cEl = document.getElementById('hkSaleCode');
        const nEl = document.getElementById('hkSaleName');
        if (saved.phone && pEl) pEl.value = saved.phone;
        if (saved.saleCode && cEl) cEl.value = saved.saleCode;
        if (saved.saleName && nEl) nEl.value = saved.saleName;

        // BẢO VỆ TUYỆT ĐỐI: Nếu thiếu Số điện thoại hoặc Mã nhân viên, bắt buộc quay lại Bước 1 để điền
        if (!saved.phone || !saved.saleCode || !saved.saleName) {
          if (typeof loginShowStep === 'function') loginShowStep('loginStepHK1');
          return;
        }

        // Prefill dữ liệu Bước 2 từ session khi đã có đầy đủ thông tin cá nhân
        const determinedSaleType = ses.saleType || (ses.isTBA ? 'tba' : (ses.isNPP ? 'npp' : 'dsm_sr'));
        if (typeof loginSelectSaleType === 'function') {
          loginSelectSaleType(determinedSaleType);
        }
        if (determinedSaleType === 'dsm_sr') {
          _loginSelectedRegion = ses.region || '';
          document.querySelectorAll('.region-btn').forEach(b => b.classList.toggle('selected', b.textContent.trim() === _loginSelectedRegion));
          const ssName = document.getElementById('hkSSName');
          if (ssName) { ssName.disabled = false; ssName.classList.remove('tba-disabled'); ssName.value = ses.ssName || ''; }
        }
        if (typeof loginShowStep === 'function') loginShowStep('loginStepHK2');
        return;
      }

      // Tài khoản khác (QCAG): khôi phục session bình thường
      currentSession = ses;
      const loginEl = document.getElementById('loginScreen');
      if (loginEl) { loginEl.classList.add('hidden'); loginEl.classList.remove('flex'); }
      updateSessionBar();
      if (typeof loadAccountProfile === 'function') loadAccountProfile();
      if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
        if (typeof openQCAGDesktop === 'function') openQCAGDesktop();
      } else {
        showScreen('homeScreen');
      }
      initApp();
    } else {
      // Chưa có session (chưa đăng nhập hoặc vừa đăng xuất): Hiển thị màn hình chọn công ty
      const saved = (() => { try { return JSON.parse(localStorage.getItem('ks_hk_profile') || '{}'); } catch (e) { return {}; } })();
      const loginEl = document.getElementById('loginScreen');
      if (loginEl) { loginEl.classList.remove('hidden'); loginEl.classList.add('flex'); }
      const pEl = document.getElementById('hkPhone');
      const cEl = document.getElementById('hkSaleCode');
      const nEl = document.getElementById('hkSaleName');
      if (saved.phone && pEl) pEl.value = saved.phone;
      if (saved.saleCode && cEl) cEl.value = saved.saleCode;
      if (saved.saleName && nEl) nEl.value = saved.saleName;
      if (typeof loginShowStep === 'function') loginShowStep('loginStepCompany');
    }
  } catch (err) {
    console.error('[bootApp] Error during startup recovery:', err);
    try {
      const loginEl = document.getElementById('loginScreen');
      if (loginEl) { loginEl.classList.remove('hidden'); loginEl.classList.add('flex'); }
      if (typeof loginShowStep === 'function') loginShowStep('loginStepCompany');
    } catch (_) {}
  }
})();

// Developer helper (removed): createSampleRequests — removed per request


// Handle soft keyboard overlaying fixed buttons
document.addEventListener('DOMContentLoaded', () => {
  if (window.visualViewport) {
    const updateLayout = () => {
      const footers = document.querySelectorAll('.fixed-bottom-kb-overlay');
      const diff = window.innerHeight - window.visualViewport.height;
      footers.forEach(f => {
        if (diff > 100) {
          f.style.transform = `translateY(-${diff}px)`;
        } else {
          f.style.transform = 'translateY(0)';
        }
      });
    };
    window.visualViewport.addEventListener('resize', updateLayout);
    window.visualViewport.addEventListener('scroll', updateLayout);
  }
});

