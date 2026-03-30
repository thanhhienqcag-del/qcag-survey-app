// ====================================================================
// js/core/router.js — screen navigation and form tab switching
// ====================================================================
'use strict';

// ── Screen management ────────────────────────────────────────────────

function showScreen(screenId) {
  ['homeScreen', 'newRequestScreen', 'warrantyScreen', 'listScreen', 'notificationsScreen', 'accountScreen', 'detailScreen', 'qcagDesktopScreen'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === screenId) {
      el.classList.remove('hidden');
      el.classList.add('flex');
    } else {
      el.classList.add('hidden');
      el.classList.remove('flex');
    }
  });
  // manage floating add-item bubble visibility
  const bubble = document.getElementById('addItemBubble');
  if (bubble) {
    const shouldShow = (screenId === 'newRequestScreen') && (currentTab === 2);
    bubble.classList.toggle('hidden', !shouldShow);
  }

  if (typeof syncBottomNavVisibility === 'function') {
    syncBottomNavVisibility(screenId);
  }

  if (typeof setActiveMainTabByScreen === 'function') {
    setActiveMainTabByScreen(screenId);
  }
}

// ── Navigation ────────────────────────────────────────────────────────

function goHome() {
  resetForms();
  showScreen('homeScreen');
}

function startNewRequest() {
  lastRequestType = 'new';
  resetNewRequestForm();
  try { localStorage.removeItem(OUTLET_DRAFT_KEY); } catch (e) {}
  showScreen('newRequestScreen');

  // ── Pre-fill from saved outlet draft ─────────────────────────────────
  // Do not auto-fill from saved draft so each new request starts with default values.
  // Previously the app loaded OUTLET_DRAFT_KEY here; that behavior was removed to ensure fresh form on each creation.
}

function startWarrantyCheck() {
  lastRequestType = 'warranty';
  resetWarrantyForm();
  showScreen('warrantyScreen');
}

function showRequestList() {
  showScreen('listScreen');
  renderRequestList();
}

function showNotifications() {
  showScreen('notificationsScreen');
  if (typeof renderNotifications === 'function') renderNotifications();
}

function showAccount() {
  showScreen('accountScreen');
  if (typeof loadAccountProfile === 'function') loadAccountProfile();
}

// ── Form tab switching ────────────────────────────────────────────────

function switchTab(tab) {
  // enforce sequential completion: tab2 requires Tab1 complete; tab3 requires Tab1+Tab2
  const allowTab2 = (typeof isTab1Complete === 'function') ? isTab1Complete() : true;
  const allowTab3 = (typeof isTab1Complete === 'function' && typeof isTab2Complete === 'function') ? (isTab1Complete() && isTab2Complete()) : true;
  // Prevent switching to locked tabs
  if (tab === 2 && !allowTab2) { showToast('Hoàn thành Thông tin trước khi chuyển sang Hạng mục'); return; }
  if (tab === 3 && !allowTab3) { showToast('Hoàn thành Hạng mục trước khi chuyển sang Nội dung'); return; }
  currentTab = tab;
  [1, 2, 3].forEach(t => {
    const btn = document.getElementById(`tab${t}Btn`);
    const clsBase = 'flex-1 py-3 text-sm font-medium';
    if (t === tab) {
      btn.className = `${clsBase} tab-active`;
    } else {
      // decide locked vs inactive
      if (t === 2) {
        btn.className = `${clsBase} ${allowTab2 ? 'tab-inactive' : 'tab-locked'}`;
      } else if (t === 3) {
        btn.className = `${clsBase} ${allowTab3 ? 'tab-inactive' : 'tab-locked'}`;
      } else {
        btn.className = `${clsBase} tab-inactive`;
      }
    }
    document.getElementById(`tab${t}`).classList.toggle('hidden', t !== tab);
    if (t === tab) document.getElementById(`tab${t}`).classList.add('fade-in');
  });
  const bubble = document.getElementById('addItemBubble');
  if (bubble) {
    const parentVisible = !document.getElementById('newRequestScreen').classList.contains('hidden');
    bubble.classList.toggle('hidden', !(parentVisible && tab === 2));
  }
  // Update Tab 3 UI depending on items in Tab 2 (some logic lives in request-flow)
  if (tab === 3) {
    try { if (typeof updateTab3UI === 'function') updateTab3UI(); } catch (e) {}
  }
}

function switchWarrantyTab(tab) {
  currentWarrantyTab = tab;
  [1, 2].forEach(t => {
    document.getElementById(`wTab${t}Btn`).className = t === tab
      ? 'flex-1 py-3 text-sm font-medium tab-active'
      : 'flex-1 py-3 text-sm font-medium tab-inactive';
    document.getElementById(`wTab${t}`).classList.toggle('hidden', t !== tab);
    if (t === tab) document.getElementById(`wTab${t}`).classList.add('fade-in');
  });
}

// ── Combined form reset ───────────────────────────────────────────────

function resetForms() {
  resetNewRequestForm();
  resetWarrantyForm();
}
