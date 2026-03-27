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

function updateThemeToggleButton() {
  const isDark = document.documentElement.classList.contains('theme-dark');
  const buttonIds = ['themeToggleBtn', 'accountThemeToggleBtn', 'qcagThemeToggleBtn'];
  buttonIds.forEach(id => {
    const button = document.getElementById(id);
    if (!button) return;
    const iconEl = button.querySelector('.theme-icon');
    const labelEl = button.querySelector('.theme-label');
    if (iconEl) iconEl.textContent = isDark ? '☀️' : '🌙';
    if (labelEl) labelEl.textContent = isDark ? 'Sáng' : 'Tối';
    button.title = isDark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối';
    button.setAttribute('aria-label', button.title);
  });
}

function applyTheme(theme) {
  const resolved = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.classList.toggle('theme-dark', resolved === 'dark');
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

// ── Boot ──────────────────────────────────────────────────────────────
(function bootApp() {
  const ses = (() => {
    try { return JSON.parse(localStorage.getItem('ks_session') || 'null'); } catch (e) { return null; }
  })();
  if (ses) {
    // If this is a Heineken user opening on mobile, require re-confirmation of Step 2 (region / SS)
    const isMobile = /Mobi|Android/i.test(navigator.userAgent) || window.innerWidth <= 768;
    if (ses.role === 'heineken' && isMobile) {
      // show login screen and force Step 2 — prefill fields from saved profile/session
      const loginEl = document.getElementById('loginScreen');
      if (loginEl) { loginEl.classList.remove('hidden'); loginEl.classList.add('flex'); }
      // Prefill HK profile if available
      const saved = (() => { try { return JSON.parse(localStorage.getItem('ks_hk_profile') || '{}'); } catch (e) { return {}; } })();
      if (saved.phone) document.getElementById('hkPhone').value = saved.phone;
      if (saved.saleCode) document.getElementById('hkSaleCode').value = saved.saleCode;
      if (saved.saleName) document.getElementById('hkSaleName').value = saved.saleName;
      // Prefill Step 2 fields from session
      _loginSelectedRegion = ses.region || '';
      document.querySelectorAll('.region-btn').forEach(b => b.classList.toggle('selected', b.textContent.trim() === _loginSelectedRegion));
      // SS / TBA
      _loginTBAOn = !!ses.isTBA;
      const tbToggle = document.getElementById('tbToggle');
      if (tbToggle) tbToggle.classList.toggle('toggle-on', _loginTBAOn);
      const ssName = document.getElementById('hkSSName');
      const tbaNote = document.getElementById('tbaNote');
      if (_loginTBAOn) {
        if (ssName) { ssName.disabled = true; ssName.classList.add('tba-disabled'); ssName.placeholder = 'TBA không cần nhập thông tin SS/SE'; ssName.value = ''; }
        if (tbaNote) tbaNote.classList.remove('hidden');
      } else {
        if (ssName) { ssName.disabled = false; ssName.classList.remove('tba-disabled'); ssName.value = ses.ssName || ''; }
        if (tbaNote) tbaNote.classList.add('hidden');
      }
      loginShowStep('loginStepHK2');
      // Do NOT auto-launch — wait for the user to confirm by pressing "Vào hệ thống"
      return;
    }

    // non-mobile or non-Heineken: restore session as before
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
    const loginEl = document.getElementById('loginScreen');
    if (loginEl) { loginEl.classList.remove('hidden'); loginEl.classList.add('flex'); }
    loginShowStep('loginStepCompany');
  }
})();

// Developer helper (removed): createSampleRequests — removed per request


// Handle soft keyboard overlaying fixed buttons
document.addEventListener('DOMContentLoaded', () => {
  if (window.visualViewport) {
    let initialHeight = window.visualViewport.height;
    window.visualViewport.addEventListener('resize', () => {
      const isKeyboardOpen = window.visualViewport.height < initialHeight - 100;
      const diff = initialHeight - window.visualViewport.height;
      const footers = document.querySelectorAll('.fixed-bottom-kb-overlay');
      footers.forEach(f => {
        if (isKeyboardOpen) {
          f.style.transform = `translateY(-${diff}px)`;
        } else {
          f.style.transform = 'translateY(0)';
          initialHeight = window.visualViewport.height;
        }
      });
    });
  }
});

