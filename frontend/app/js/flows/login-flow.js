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
  if (company === 'heineken') {
    const saved = (() => {
      try { return JSON.parse(localStorage.getItem(HK_PROFILE_KEY) || '{}'); } catch (e) { return {}; }
    })();
    if (saved.phone) document.getElementById('hkPhone').value = saved.phone;
    if (saved.saleCode) document.getElementById('hkSaleCode').value = saved.saleCode;
    if (saved.saleName) document.getElementById('hkSaleName').value = saved.saleName;
    loginShowStep('loginStepHK1');
  } else {
    loginShowStep('loginStepQCAG');
  }
}

function loginBack(showId, hideId) {
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
  // Preserve existing TBA state when moving between steps — reflect it in the UI
  _loginSelectedRegion = '';
  const ssNameInit = document.getElementById('hkSSName');
  const tbaNoteInit = document.getElementById('tbaNote');
  // Make toggle visual match stored state
  const tbToggleEl = document.getElementById('tbToggle');
  if (tbToggleEl) tbToggleEl.classList.toggle('toggle-on', !!_loginTBAOn);
  if (_loginTBAOn) {
    if (ssNameInit) {
      ssNameInit.disabled = true;
      ssNameInit.classList.add('tba-disabled');
      ssNameInit.placeholder = 'TBA không cần nhập thông tin SS/SE';
      ssNameInit.value = '';
    }
    if (tbaNoteInit) tbaNoteInit.classList.remove('hidden');
  } else {
    if (ssNameInit) {
      ssNameInit.disabled = false;
      ssNameInit.classList.remove('tba-disabled');
      ssNameInit.placeholder = 'Nhập tên SS';
    }
    if (tbaNoteInit) tbaNoteInit.classList.add('hidden');
  }
  document.querySelectorAll('.region-btn').forEach(b => b.classList.remove('selected'));
  loginShowStep('loginStepHK2');
}

function loginToggleTBA() {
  _loginTBAOn = !_loginTBAOn;
  document.getElementById('tbToggle').classList.toggle('toggle-on', _loginTBAOn);
  const ssName = document.getElementById('hkSSName');
  // When TBA is on, keep inputs visible but disabled and styled with dark bg + gray text,
  // and show the note inside the input as placeholder.
  if (_loginTBAOn) {
    if (ssName) {
      ssName.disabled = true;
      ssName.classList.add('tba-disabled');
      ssName.placeholder = 'TBA không cần nhập thông tin SS/SE';
      ssName.value = '';
    }
    const tbaNote = document.getElementById('tbaNote');
    if (tbaNote) tbaNote.classList.remove('hidden');
  } else {
    if (ssName) {
      ssName.disabled = false;
      ssName.classList.remove('tba-disabled');
      ssName.placeholder = 'Nhập tên SS';
    }
    const tbaNote = document.getElementById('tbaNote');
    if (tbaNote) tbaNote.classList.add('hidden');
  }
}

function loginSelectRegion(btn, region) {
  _loginSelectedRegion = region;
  document.querySelectorAll('.region-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function loginHK2Submit() {
  if (!_loginSelectedRegion) { showToast('Vui lòng chọn khu vực'); return; }
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(HK_PROFILE_KEY) || '{}'); } catch (e) { return {}; }
  })();
    if (!_loginTBAOn) {
    const ssName = document.getElementById('hkSSName').value.trim();
    if (!ssName) { showToast('Vui lòng điền tên SS/SE'); return; }
    currentSession = { role: 'heineken', ...saved, region: _loginSelectedRegion, isTBA: false, ssCode: '', ssName };
  } else {
    currentSession = { role: 'heineken', ...saved, region: _loginSelectedRegion, isTBA: true, ssCode: '', ssName: '' };
  }
  _justLoggedIn = true;
  localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
  launchApp();
}

function loginQCAGSubmit() {
  const phone = document.getElementById('qcPhone').value.trim();
  const qcName = (document.getElementById('qcName') && document.getElementById('qcName').value.trim()) || '';
  const pwd = document.getElementById('qcPassword').value;
  if (!phone) { showToast('Vui lòng nhập số điện thoại'); return; }
  if (pwd !== loginGetQCAGPassword()) { showToast('Mật khẩu không đúng'); return; }
  currentSession = { role: 'qcag', phone, name: qcName };
  _justLoggedIn = true;
  localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
  launchApp();
}

function loginTogglePwd() {
  const inp = document.getElementById('qcPassword');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

function logout() {
  localStorage.removeItem(SESSION_KEY);
  currentSession = null;
  const loginEl = document.getElementById('loginScreen');
  if (loginEl) { loginEl.classList.remove('hidden'); loginEl.classList.add('flex'); }
  ['homeScreen', 'newRequestScreen', 'warrantyScreen', 'listScreen', 'notificationsScreen', 'accountScreen', 'detailScreen', 'qcagDesktopScreen'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('flex');
  });
  if (typeof syncBottomNavVisibility === 'function') syncBottomNavVisibility('loginScreen');
  loginShowStep('loginStepCompany');
}

function launchApp() {
  const loginEl = document.getElementById('loginScreen');
  if (loginEl) { loginEl.classList.add('hidden'); loginEl.classList.remove('flex'); }
  updateSessionBar();
  if (typeof loadAccountProfile === 'function') loadAccountProfile();
  initHomeAndLoad();
  // Best-effort: initialize push subscription after login (if push helpers are available)
  try {
    if (window.pushHelpers && typeof window.pushHelpers.initPush === 'function') {
      const phone = currentSession && currentSession.phone ? currentSession.phone : null;
      const role  = currentSession && currentSession.role  ? currentSession.role  : null;
      window.pushHelpers.initPush(phone, role).then(function(res) {
        if (!res || !res.ok) {
          console.warn('[push] initPush failed:', res && res.error ? res.error : res);
          try { showToast('Push chưa kích hoạt: ' + (res && res.error ? res.error : 'unknown')); } catch (_) {}
        } else {
          console.log('[push] initPush succeeded');
        }
      }).catch(function(err) {
        console.warn('[push] initPush exception:', err);
        try { showToast('Push init lỗi: ' + String(err)); } catch (_) {}
      });
    }
  } catch (e) {}
  if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) {
    if (typeof openQCAGDesktop === 'function') openQCAGDesktop();
    return;
  }
  showScreen('homeScreen');
}

function updateSessionBar() {
  const bar = document.getElementById('sessionInfoBar');
  if (!bar || !currentSession) return;
  if (currentSession.role === 'heineken') {
    const pos = currentSession.isTBA ? 'TBA' : 'Sale';
    const ss = currentSession.isTBA ? '' : ` &nbsp;·&nbsp; SS/SE: <strong>${currentSession.ssName}</strong>`;
    bar.innerHTML = `
      <div class="font-semibold text-gray-800 text-sm">${currentSession.saleName} <span class="font-normal text-gray-400">(${pos})</span></div>
      <div class="text-gray-400 mt-0.5">${currentSession.region}${ss} &nbsp;·&nbsp; ${currentSession.phone}</div>`;
  } else {
    bar.innerHTML = `
      <div class="font-semibold text-gray-800 text-sm">QCAG Admin</div>
      <div class="text-gray-400 mt-0.5">${currentSession.phone}</div>`;
  }
}
