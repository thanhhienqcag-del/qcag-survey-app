// ====================================================================
// js/flows/login-flow.js — login, logout and session management
// ====================================================================
'use strict';

function loginGetQCAGPassword() {
  return localStorage.getItem(QCAG_PASSWORD_KEY) || 'qcag123';
}

function loginShowStep(showId) {
  ['loginStepCompany', 'loginStepHK1', 'loginStepHK2', 'loginStepQCAG'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle('hidden', id !== showId);
      el.classList.toggle('flex', id === showId);
    }
  });
}

function loginSelectCompany(company) {
  if (typeof window.updateAppTitle === 'function') {
    window.updateAppTitle(company);
  }
  if (company === 'heineken') {
    const saved = (() => {
      try { return JSON.parse(localStorage.getItem(HK_PROFILE_KEY) || '{}'); } catch (e) { return {}; }
    })();
    const pEl = document.getElementById('hkPhone');
    const cEl = document.getElementById('hkSaleCode');
    const nEl = document.getElementById('hkSaleName');
    if (saved.phone && pEl) pEl.value = saved.phone;
    if (saved.saleCode && cEl) cEl.value = saved.saleCode;
    if (saved.saleName && nEl) nEl.value = saved.saleName;

    // YÊU CẦU: Khi chọn công ty Heineken, luôn luôn bắt đầu từ Bước 1 dù cache còn lưu data
    loginShowStep('loginStepHK1');
  } else {
    loginShowStep('loginStepQCAG');
  }
}

function loginBack(showId, hideId) {
  if (showId === 'loginStepCompany' && typeof window.updateAppTitle === 'function') {
    window.updateAppTitle('');
  }
  loginShowStep(showId);
}

function loginHK1Next() {
  const phone = document.getElementById('hkPhone').value.trim();
  const saleCode = document.getElementById('hkSaleCode').value.trim();
  const saleName = document.getElementById('hkSaleName').value.trim();
  if (!phone || !saleCode || !saleName) { showToast('Vui lòng điền đầy đủ thông tin'); return; }
  // Require sale code to be exactly 8 digits
  if (saleCode.length !== 8) { showToast('Mã nhân viên phải đủ 8 chữ số'); return; }
  localStorage.setItem(HK_PROFILE_KEY, JSON.stringify({ phone, saleCode, saleName }));
  _loginSelectedRegion = '';
  document.querySelectorAll('.region-btn').forEach(b => b.classList.remove('selected'));
  loginSelectSaleType(_loginSelectedSaleType || '');
  loginShowStep('loginStepHK2');
}

function loginSelectSaleType(type) {
  _loginSelectedSaleType = type || '';
  _loginTBAOn = (_loginSelectedSaleType === 'tba');

  const btnDSM = document.getElementById('btnSaleTypeDSM');
  const btnTBA = document.getElementById('btnSaleTypeTBA');
  const btnNPP = document.getElementById('btnSaleTypeNPP');

  if (btnDSM) btnDSM.classList.toggle('selected', _loginSelectedSaleType === 'dsm_sr');
  if (btnTBA) btnTBA.classList.toggle('selected', _loginSelectedSaleType === 'tba');
  if (btnNPP) btnNPP.classList.toggle('selected', _loginSelectedSaleType === 'npp');

  const regBlock = document.getElementById('loginRegionBlock');
  const ssBlock = document.getElementById('ssInfoBlock');
  const mrNote = document.getElementById('loginMultiRegionNote');
  const mrTitle = document.getElementById('loginMultiRegionTitle');
  const mrDesc = document.getElementById('loginMultiRegionDesc');

  const applySmoothAnimation = (el) => {
    if (!el) return;
    el.classList.remove('hidden', 'animate-smooth-in');
    void el.offsetWidth; // trigger reflow
    el.classList.add('animate-smooth-in');
  };

  if (!_loginSelectedSaleType) {
    if (regBlock) regBlock.classList.add('hidden');
    if (ssBlock) ssBlock.classList.add('hidden');
    if (mrNote) mrNote.classList.add('hidden');
    return;
  }

  if (_loginSelectedSaleType === 'dsm_sr') {
    if (mrNote) mrNote.classList.add('hidden');
    applySmoothAnimation(regBlock);
    applySmoothAnimation(ssBlock);
    const ssName = document.getElementById('hkSSName');
    if (ssName) {
      ssName.disabled = false;
      ssName.classList.remove('tba-disabled');
      ssName.placeholder = 'Nhập tên SS/SE';
    }
  } else if (_loginSelectedSaleType === 'tba') {
    if (regBlock) regBlock.classList.add('hidden');
    if (ssBlock) ssBlock.classList.add('hidden');
    if (mrTitle) mrTitle.textContent = 'TBA hoạt động đa khu vực';
    if (mrDesc) mrDesc.textContent = 'Bạn không cần chọn khu vực trước. Khi tạo từng yêu cầu khảo sát, bạn sẽ chọn khu vực trực tiếp cho từng điểm bán tương ứng.';
    applySmoothAnimation(mrNote);
  } else if (_loginSelectedSaleType === 'npp') {
    if (regBlock) regBlock.classList.add('hidden');
    if (ssBlock) ssBlock.classList.add('hidden');
    if (mrTitle) mrTitle.textContent = 'NPP hoạt động đa khu vực';
    if (mrDesc) mrDesc.textContent = 'Kênh Nhà phân phối hoạt động linh hoạt. Bạn sẽ chọn khu vực trực tiếp khi tạo từng yêu cầu khảo sát.';
    applySmoothAnimation(mrNote);
  }
}

// Backward-compatibility alias
function loginToggleTBA() {
  loginSelectSaleType(_loginTBAOn ? 'dsm_sr' : 'tba');
}

function loginSelectRegion(btn, region) {
  _loginSelectedRegion = region;
  document.querySelectorAll('.region-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function loginHK2Submit() {
  let saved = (() => {
    try { return JSON.parse(localStorage.getItem(HK_PROFILE_KEY) || '{}'); } catch (e) { return {}; }
  })();

  // Cứu dữ liệu từ input hoặc session nếu saved bị thiếu
  if (!saved.phone || !saved.saleCode) {
    const pVal = (document.getElementById('hkPhone') && document.getElementById('hkPhone').value.trim()) || '';
    const cVal = (document.getElementById('hkSaleCode') && document.getElementById('hkSaleCode').value.trim()) || '';
    const nVal = (document.getElementById('hkSaleName') && document.getElementById('hkSaleName').value.trim()) || '';
    const ses = (() => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); } catch (_) { return {}; } })();
    saved = {
      phone: saved.phone || pVal || ses.phone || '',
      saleCode: saved.saleCode || cVal || ses.saleCode || '',
      saleName: saved.saleName || nVal || ses.saleName || ses.name || ''
    };
    if (saved.phone && saved.saleCode) {
      try { localStorage.setItem(HK_PROFILE_KEY, JSON.stringify(saved)); } catch (_) {}
    }
  }

  // Khóa an toàn: Nếu vẫn không có thông tin cá nhân, bắt buộc quay lại Bước 1
  if (!saved.phone || !saved.saleCode) {
    showToast('Vui lòng nhập đầy đủ Số điện thoại và Mã nhân viên');
    loginShowStep('loginStepHK1');
    return;
  }

  if (!_loginSelectedSaleType) {
    showToast('Vui lòng chọn loại hình Sale');
    return;
  }

  const saleType = _loginSelectedSaleType;

  if (saleType === 'dsm_sr') {
    if (!_loginSelectedRegion) { showToast('Vui lòng chọn khu vực'); return; }
    const ssName = document.getElementById('hkSSName').value.trim();
    if (!ssName) { showToast('Vui lòng điền tên SS/SE'); return; }
    currentSession = {
      role: 'heineken',
      ...saved,
      saleType: 'dsm_sr',
      region: _loginSelectedRegion,
      isTBA: false,
      isNPP: false,
      ssCode: '',
      ssName
    };
  } else if (saleType === 'tba') {
    currentSession = {
      role: 'heineken',
      ...saved,
      saleType: 'tba',
      region: '',
      isTBA: true,
      isNPP: false,
      ssCode: '',
      ssName: ''
    };
  } else if (saleType === 'npp') {
    currentSession = {
      role: 'heineken',
      ...saved,
      saleType: 'npp',
      region: '',
      isTBA: false,
      isNPP: true,
      ssCode: '',
      ssName: ''
    };
  }

  _justLoggedIn = true;
  try { sessionStorage.removeItem('ks_logged_out'); } catch (_) {}
  localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
  if (typeof window.updateAppTitle === 'function') window.updateAppTitle('heineken');
  launchApp();
}

function loginQCAGSubmit() {
  const phone = document.getElementById('qcPhone').value.trim();
  const qcName = (document.getElementById('qcName') && document.getElementById('qcName').value.trim()) || '';
  const pwd = document.getElementById('qcPassword').value;
  if (!phone) { showToast('Vui lòng nhập số điện thoại'); return; }
  if (pwd !== loginGetQCAGPassword()) { showToast('Mật khẩu không đúng'); return; }
  currentSession = { role: 'qcag', phone, name: qcName, fullname: qcName };
  _justLoggedIn = true;
  try { sessionStorage.removeItem('ks_logged_out'); } catch (_) {}
  localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
  if (typeof window.updateAppTitle === 'function') window.updateAppTitle('qcag');
  // Only show blocking loading on QCAG desktop login; mobile flow stays unchanged.
  if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
    showLoadingOverlay('Đang tải dữ liệu...', 'Vui lòng chờ trong giây lát');
  }
  launchApp();
}

function loginTogglePwd() {
  const inp = document.getElementById('qcPassword');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

function logout() {
  const modal = document.getElementById('logoutModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  } else {
    if (confirm('Bạn có chắc chắn muốn đăng xuất không?')) executeLogout();
  }
}

function closeLogoutModal() {
  const modal = document.getElementById('logoutModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

function executeLogout() {
  closeLogoutModal();
  try { sessionStorage.setItem('ks_logged_out', '1'); } catch (_) {}
  const prevRole = currentSession && currentSession.role;
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem('pending_orders_v1');
  localStorage.removeItem('pendingOrders');
  try {
    if (typeof _productionApprovalItems !== 'undefined') _productionApprovalItems = [];
    if (typeof _productionApprovalBadgeCount !== 'undefined') _productionApprovalBadgeCount = 0;
    const badge = document.getElementById('productionApprovalBadge');
    if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
  } catch (_) {}
  currentSession = null;
  if (typeof window.updateAppTitle === 'function') window.updateAppTitle('');
  try { if (typeof window.applyAppUIMode === 'function') window.applyAppUIMode(); } catch (e) { }
  const loginEl = document.getElementById('loginScreen');
  if (loginEl) { loginEl.classList.remove('hidden'); loginEl.classList.add('flex'); }
  ['homeScreen', 'newRequestScreen', 'warrantyScreen', 'listScreen', 'notificationsScreen', 'accountScreen', 'detailScreen', 'qcagDesktopScreen'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('flex');
  });
  if (typeof syncBottomNavVisibility === 'function') syncBottomNavVisibility('loginScreen');

  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(HK_PROFILE_KEY) || '{}'); } catch (e) { return {}; }
  })();
  const pEl = document.getElementById('hkPhone');
  const cEl = document.getElementById('hkSaleCode');
  const nEl = document.getElementById('hkSaleName');
  if (saved.phone && pEl) pEl.value = saved.phone;
  if (saved.saleCode && cEl) cEl.value = saved.saleCode;
  if (saved.saleName && nEl) nEl.value = saved.saleName;

  // YÊU CẦU: Khi đăng xuất, luôn luôn đưa về màn hình chọn công ty
  loginShowStep('loginStepCompany');
}

function launchApp() {
  try { if (typeof window.applyAppUIMode === 'function') window.applyAppUIMode(); } catch (e) { }
  const loginEl = document.getElementById('loginScreen');
  if (loginEl) { loginEl.classList.add('hidden'); loginEl.classList.remove('flex'); }
  updateSessionBar();
  if (typeof loadAccountProfile === 'function') loadAccountProfile();
  initHomeAndLoad();
  if (typeof fetchProductionApprovalBadgeCount === 'function') {
    fetchProductionApprovalBadgeCount();
  }
  // Best-effort: initialize push subscription after login
  try {
    if (window.pushHelpers && typeof window.pushHelpers.initPush === 'function') {
      const phone = currentSession && currentSession.phone || null;
      const role = currentSession && currentSession.role || null;
      const saleCode = currentSession && currentSession.saleCode || null;
      window.pushHelpers.initPush(phone, role, saleCode).then(function (res) {
        if (!res || !res.ok) {
          const e = res && res.error;
          if (e && e !== 'Push not supported' && e !== 'Notifications not supported' && e !== 'Permission not granted') {
            console.warn('[push] initPush failed:', e);
          }
        } else {
          console.log('[push] initPush succeeded');
        }
        try { updateHomePushBtn(); } catch (_) { }
      }).catch(function (err) {
        console.warn('[push] initPush exception:', err);
        try { updateHomePushBtn(); } catch (_) { }
      });
    }
  } catch (e) { }
  if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
    showScreen('qcagDesktopScreen'); // show skeleton behind overlay while data loads
    return;
  }
  showScreen('homeScreen');
  try { updateHomePushBtn(); } catch (_) { }
  try { updateHomeInstallBtn(); } catch (_) { }
}

function getUserInitial(name) {
  if (!name) return 'U';
  const parts = String(name).trim().split(/\s+/);
  const last = parts[parts.length - 1];
  return (last ? last[0] : parts[0][0]).toUpperCase();
}

function updateSessionBar() {
  const bar = document.getElementById('sessionInfoBar');
  if (!bar || !currentSession) return;
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s || ''));

  if (currentSession.role === 'heineken') {
    const saleType = currentSession.saleType || (currentSession.isTBA ? 'tba' : (currentSession.isNPP ? 'npp' : 'dsm_sr'));
    let pos = 'DSM / SR';
    let badgeCls = 'user-badge-sale';

    if (saleType === 'tba' || currentSession.isTBA) {
      pos = 'TBA';
      badgeCls = 'user-badge-tba';
    } else if (saleType === 'npp' || currentSession.isNPP) {
      pos = 'NPP';
      badgeCls = 'user-badge-npp';
    } else {
      pos = 'DSM / SR';
      badgeCls = 'user-badge-sale';
    }

    const rawName = currentSession.saleName || 'Sale Heineken';
    const initial = getUserInitial(rawName);
    const ssText = (currentSession.isTBA || currentSession.isNPP || saleType === 'tba' || saleType === 'npp') ? '' : (currentSession.ssName ? `SS: <strong>${esc(currentSession.ssName)}</strong>` : '');
    const region = currentSession.region ? esc(currentSession.region) : '';
    const regionLabel = region ? (region.toLowerCase().startsWith('khu vực') || region.toLowerCase().startsWith('kv') ? `<strong>${region}</strong>` : `Khu vực: <strong>${region}</strong>`) : '';

    bar.innerHTML = `
      <div class="session-user-card">
        <div class="user-avatar-circle" title="${esc(rawName)}">
          <span>${initial}</span>
        </div>
        <div class="user-meta-block">
          <div class="user-primary-line">
            <span class="user-full-name font-bold truncate leading-tight">${esc(rawName)}</span>
            <span class="user-role-badge ${badgeCls}">${pos}</span>
          </div>
          <div class="user-sub-line leading-tight">
            ${ssText ? `<div class="user-sub-row user-ss-row">${ssText}</div>` : ''}
            ${regionLabel ? `<div class="user-sub-row user-region-row">${regionLabel}</div>` : ''}
          </div>
        </div>
      </div>`;
  } else {
    bar.innerHTML = `
      <div class="session-user-card">
        <div class="user-avatar-circle user-avatar-admin" title="QCAG Admin">
          <span>QC</span>
        </div>
        <div class="user-meta-block">
          <div class="user-primary-line">
            <span class="user-full-name font-bold truncate leading-tight">QCAG Admin</span>
            <span class="user-role-badge user-badge-admin">Admin</span>
          </div>
          <div class="user-sub-line leading-tight">
            <div class="user-sub-row">Quản trị viên hệ thống</div>
          </div>
        </div>
      </div>`;
  }
}

// ── Push notification bell (mobile top bar) ───────────────────────────────────

function updateHomePushBtn() {
  const btn = document.getElementById('mobilePushBellBtn');
  const dot = document.getElementById('mobilePushBellDot');
  if (!btn) return;

  if (typeof Notification === 'undefined' || !('PushManager' in window)) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';

  const perm = Notification.permission;
  if (dot) {
    dot.className = 'mobile-push-bell-dot' + (perm === 'granted' ? ' on' : perm === 'denied' ? ' denied' : '');
  }
  btn.title = perm === 'granted' ? 'Thông báo đang bật'
    : perm === 'denied' ? 'Thông báo bị chặn'
      : 'Bật thông báo';
  btn.disabled = false;
}

async function homePushBtnClick() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    showToast('Thông báo đang bị chặn. Vào Cài đặt > Trình duyệt > Cho phép thông báo.');
    return;
  }
  if (!window.pushHelpers) { showToast('Trình duyệt không hỗ trợ thông báo đẩy'); return; }

  const phone = currentSession && currentSession.phone || null;
  const role = currentSession && currentSession.role || null;
  const saleCode = currentSession && currentSession.saleCode || null;
  try {
    const res = await window.pushHelpers.initPush(phone, role, saleCode);
    if (res && res.ok) {
      showToast('Thông báo đã được kích hoạt thành công', 'done');
    } else {
      const e = res && res.error || 'Không thể bật thông báo';
      if (e !== 'Push not supported' && e !== 'Notifications not supported') showToast('Lỗi: ' + e);
    }
  } catch (err) {
    showToast('Lỗi: ' + String(err));
  }
  updateHomePushBtn();
}

// ── Add to homescreen (PWA install) ───────────────────────────────────────────

let _deferredInstallPrompt = null;

// Capture the browser install prompt as early as possible
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  _deferredInstallPrompt = e;
  // Show the install button now that prompt is available
  const installBtn = document.getElementById('homeInstallBtn');
  if (installBtn) {
    installBtn.classList.remove('hidden');
    installBtn.classList.add('flex');
  }
});

// Hide install button once app is installed
window.addEventListener('appinstalled', function () {
  _deferredInstallPrompt = null;
  updateHomeInstallBtn();
});

function updateHomeInstallBtn() {
  const btn = document.getElementById('homeInstallBtn');
  if (!btn) return;

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || (window.navigator && window.navigator.standalone === true);

  if (isStandalone) {
    // Already installed — hide button
    btn.classList.add('hidden'); btn.classList.remove('flex');
    return;
  }
  if (isIos || _deferredInstallPrompt) {
    btn.classList.remove('hidden'); btn.classList.add('flex');
  } else {
    btn.classList.add('hidden'); btn.classList.remove('flex');
  }
}

async function homeInstallBtnClick() {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || (window.navigator && window.navigator.standalone === true);

  if (isStandalone) { showToast('App đã được cài đặt rồi!'); return; }

  if (_deferredInstallPrompt) {
    // Android/Chrome — trigger native install dialog immediately
    _deferredInstallPrompt.prompt();
    const { outcome } = await _deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      showToast('Đang cài đặt ứng dụng...', 'info');
      _deferredInstallPrompt = null;
    }
    updateHomeInstallBtn();
    return;
  }

  if (isIos) {
    showToast('Nhấn nút Chia sẻ ↑ → "Thêm vào màn hình chính" để cài app', 7000);
  } else {
    showToast('Mở trang trong Chrome/Safari và thử lại để cài app');
  }
}
