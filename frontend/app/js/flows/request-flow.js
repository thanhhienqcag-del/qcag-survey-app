// ====================================================================
// js/flows/request-flow.js — new request form (items, validation, submit)
// ====================================================================
'use strict';

// Duplicate-outlet detection state
let duplicateOutletState = null; // { outletCode, existingRequest }
let userConfirmedNewForOutlet = false; // user chose "Hạng mục mới" for the detected duplicate
let otherOutletState = null;       // { outletCode, matches } — outlet owned by another sale
let userConfirmedTakeover = false;  // user chose "Đúng, tôi quản lý" for another sale's outlet

// ── Request item management ──────────────────────────────────────────

const NEW_REQUEST_DRAFTS_KEY = 'ks_new_request_drafts';
let _currentNewRequestDraftId = null;
// Session-scoped auto-saved draft id to avoid creating a new draft on every
// keystroke. This is used only for transient auto-saves when the user is
// composing a new request and hasn't explicitly opened/edited an existing draft.
let _sessionAutoDraftId = null;

function addRequestItem() {
  const id = Date.now();
  currentRequestItems.push({ id, type: '', brand: '', width: '', height: '', useOldSize: false, otherContent: '', poles: 0, action: '', note: '', survey: false });
  renderRequestItems();
  saveNewRequestDraft();
  setTimeout(() => {
    const el = document.getElementById(`requestItem-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 80);
}

function getNewRequestDrafts() {
  try {
    const raw = localStorage.getItem(NEW_REQUEST_DRAFTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function setNewRequestDrafts(drafts) {
  try {
    localStorage.setItem(NEW_REQUEST_DRAFTS_KEY, JSON.stringify(Array.isArray(drafts) ? drafts : []));
  } catch (e) {}
}

function getNewRequestDraftById(id) {
  const drafts = getNewRequestDrafts();
  return drafts.find(d => d.id === id) || null;
}

function saveNewRequestDraft() {
  try {
    if (!window.localStorage) return;
    const outletCode = (document.getElementById('outletCode') || { value: '' }).value.trim();
    const outletName = (document.getElementById('outletName') || { value: '' }).value.trim();
    const address = (document.getElementById('address') || { value: '' }).value.trim();
    const phone = (document.getElementById('phone') || { value: '' }).value.trim();
    const outletLat = (document.getElementById('outletLat') || { value: '' }).value;
    const outletLng = (document.getElementById('outletLng') || { value: '' }).value;
    const locationPreview = outletLat && outletLng ? ((document.getElementById('locationPreview') || {}).textContent || '').trim() : '';
    const signContent = (document.getElementById('signContent') || { value: '' }).value.trim();
    const oldContentExtra = (document.getElementById('oldContentExtra') || { value: '' }).value.trim();
    const draftItems = Array.isArray(currentRequestItems) ? currentRequestItems : [];
    const isEmpty = !outletCode && !outletName && !address && !phone && !signContent && !oldContentExtra && (!draftItems.length || draftItems.every(i => !i.type && !i.brand && !i.width && !i.height && !i.note));
    if (isEmpty) return; // do not save an empty draft

    const drafts = getNewRequestDrafts();
    // If we're editing an existing draft, reuse its id. Otherwise reuse a
    // session-scoped auto id if present (prevents creating many drafts while
    // typing), or generate a fresh unique id.
    const id = _currentNewRequestDraftId || _sessionAutoDraftId || `draft-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const existing = getNewRequestDraftById(id);
    const now = new Date().toISOString();
    const draft = {
      id,
      label: outletName ? `Outlet: ${outletName}` : (outletCode ? `Outlet: ${outletCode}` : 'Nháp chưa có tên'),
      outletCode,
      outletName,
      address,
      phone,
      outletLat,
      outletLng,
      locationPreview,
      signContent,
      isOldContent: !!isOldContent,
      oldContentExtra,
      currentRequestItems: draftItems,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    // Put newest draft at the front
    const nextDrafts = [draft].concat(drafts.filter(d => d.id !== id));
    setNewRequestDrafts(nextDrafts);
    // If editing an existing draft, set the current draft id so future saves
    // update the same draft. If this was an auto-save of a new draft, keep
    // it as the session auto id so subsequent auto-saves update it (and do
    // not create a new draft every keystroke).
    if (existing) {
      _currentNewRequestDraftId = id;
      _sessionAutoDraftId = null;
    } else {
      _sessionAutoDraftId = id;
    }
    updateDraftsButton();
  } catch (e) {}
}

function clearNewRequestDraft(id) {
  try {
    const drafts = getNewRequestDrafts().filter(d => d.id !== id);
    setNewRequestDrafts(drafts);
    if (_currentNewRequestDraftId === id) _currentNewRequestDraftId = null;
    // If the removed draft matches the session auto id, clear it
    if (_sessionAutoDraftId === id) _sessionAutoDraftId = null;
    updateDraftsButton();
  } catch (e) {}
}

function clearAllNewRequestDrafts() {
  try {
    setNewRequestDrafts([]);
    _currentNewRequestDraftId = null;
    _sessionAutoDraftId = null;
    updateDraftsButton();
  } catch (e) {}
}

function updateDraftsButton() {
  try {
    const btn = document.getElementById('draftsListBtn');
    const drafts = getNewRequestDrafts();
    if (!btn) return;
    const countEl = document.getElementById('draftsButtonCount');
    const headerCountEl = document.getElementById('newRequestDraftCount');
    const countText = drafts.length;
    if (countEl) countEl.textContent = countText;
    if (headerCountEl) headerCountEl.textContent = countText;
    // Always keep the button clickable so it can show a toast when there are no drafts.
    btn.disabled = false;
  } catch (e) {}
}

function renderDraftsList() {
  try {
    const container = document.getElementById('draftsListContainer');
    const noDrafts = document.getElementById('noDraftsMessage');
    if (!container || !noDrafts) return;
    const drafts = getNewRequestDrafts();
    container.innerHTML = '';
    if (!drafts.length) {
      noDrafts.textContent = 'Chưa có nháp lưu trữ.';
      return;
    }
    noDrafts.textContent = '';
    drafts.sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    // Render all drafts so the container can scroll to show them all.
    // The modal container limits visible height with CSS (max-h) and
    // enables scrolling; previously we sliced to 5 which prevented
    // scrolling to older drafts.
    drafts.forEach((draft, idx) => {
      const item = document.createElement('div');
      item.className = 'rounded-2xl border border-gray-200 p-3 bg-gray-50';
      // Determine display label: use outletName when present, otherwise "Nháp X" where X is ordinal in this list
      const displayLabel = (draft.outletName && String(draft.outletName).trim()) ? String(draft.outletName).trim() : `Nháp ${idx + 1}`;
      item.innerHTML = `
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-sm font-semibold text-gray-900 truncate">
              <svg class="w-4 h-4 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11" />
              </svg>
              <span>${escapeHtml(displayLabel)}</span>
            </div>
            <div class="text-[11px] text-gray-500 mt-0.5">${new Date(draft.updatedAt).toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit' })} · ${escapeHtml(draft.outletCode || draft.address || '')}</div>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" onclick="loadNewRequestDraft('${escapeHtml(draft.id)}')" class="px-3 py-1.5 bg-green-600 text-white text-[11px] font-semibold rounded-lg">Tiếp tục</button>
            <button type="button" onclick="deleteNewRequestDraft('${escapeHtml(draft.id)}')" class="px-3 py-1.5 bg-white text-red-600 border border-red-200 text-[11px] font-semibold rounded-lg">Xóa</button>
          </div>
        </div>
      `;
      container.appendChild(item);
    });
    // (no footer note needed — all drafts are rendered and container scrolls)
  } catch (e) {}
}

function openDraftsModal() {
  try {
    const drafts = getNewRequestDrafts();
    if (!drafts.length) {
      showToast('Chưa có bản nháp lưu');
      return;
    }
    renderDraftsList();
    const modal = document.getElementById('draftsModal');
    if (modal) modal.classList.remove('hidden');
    try { enableModalBackdrop(); } catch (e) {}
  } catch (e) {}
}

function closeDraftsModal() {
  try {
    const modal = document.getElementById('draftsModal');
    if (modal) modal.classList.add('hidden');
    try { disableModalBackdrop(); } catch (e) {}
  } catch (e) {}
}

function deleteNewRequestDraft(id) {
  try {
    clearNewRequestDraft(id);
    renderDraftsList();
  } catch (e) {}
}

function loadNewRequestDraft(id) {
  try {
    const draft = getNewRequestDraftById(id);
    if (!draft) {
      showToast('Không tìm thấy nháp');
      return;
    }
    _currentNewRequestDraftId = draft.id;
    resetNewRequestForm();
    document.getElementById('outletCode').value = draft.outletCode || '';
    document.getElementById('outletName').value = draft.outletName || '';
    document.getElementById('address').value = draft.address || '';
    document.getElementById('phone').value = draft.phone || '';
    document.getElementById('outletLat').value = draft.outletLat || '';
    document.getElementById('outletLng').value = draft.outletLng || '';
    document.getElementById('signContent').value = draft.signContent || '';
    document.getElementById('oldContentExtra').value = draft.oldContentExtra || '';
    isOldContent = !!draft.isOldContent;
    try {
      const oldEl = document.getElementById('oldContentSection');
      const newEl = document.getElementById('newContentSection');
      const toggle = document.getElementById('oldContentToggle');
      if (isOldContent) {
        if (oldEl) oldEl.classList.remove('hidden');
        if (newEl) newEl.classList.add('hidden');
        if (toggle) toggle.className = 'toggle-switch bg-gray-900 toggle-on rounded-full p-0.5 relative';
      } else {
        if (oldEl) oldEl.classList.add('hidden');
        if (newEl) newEl.classList.remove('hidden');
        if (toggle) toggle.className = 'toggle-switch bg-gray-300 rounded-full p-0.5 relative';
      }
    } catch (e) {}
    if (Array.isArray(draft.currentRequestItems) && draft.currentRequestItems.length > 0) {
      currentRequestItems = draft.currentRequestItems.map(i => ({ ...i, id: Number.isNaN(Number(i.id)) ? Date.now() + Math.random() : i.id }));
    } else {
      currentRequestItems = [];
      addRequestItem();
    }
    renderRequestItems();
    updateNewRequestHeaderOutletName();
    updateDraftsButton();
    closeDraftsModal();
    // When loading an existing draft, clear the session auto-id so
    // subsequent auto-saves update the loaded draft (via _currentNewRequestDraftId)
    _sessionAutoDraftId = null;
    showScreen('newRequestScreen');
    switchTab(1);
  } catch (e) {
    showToast('Không thể mở nháp');
  }
}

function saveDraftsOnPageUnload() {
  try { saveNewRequestDraft(); } catch (e) {}
}

window.addEventListener('beforeunload', saveDraftsOnPageUnload);

function removeRequestItem(id) {
  if (currentRequestItems.length > 1) {
    currentRequestItems = currentRequestItems.filter(item => item.id !== id);
    renderRequestItems();
  }
}

function updateRequestItem(id, field, value) {
  const item = currentRequestItems.find(i => i.id === id);
  if (item) {
    if (field === 'width' || field === 'height') {
      item[field] = value === '' ? '' : parseFloat(value);
    } else if (field === 'poles') {
      const v = parseInt(value, 10);
      item[field] = Number.isNaN(v) ? 0 : v;
    } else {
      item[field] = value;
    }

    if (field === 'type') {
      try {
        const tv = String(value || '');
        const tl = tv.toLowerCase();
        const isRem = tl.includes('rèm') || tl.includes('rem');
        const isMaiChe = !isRem && (tl.includes('mái che') || tl.includes('mai che') || tl.includes('mái hiên') || tl.includes('mai hien'));
        const isTranhDen = tl.includes('tranh đèn') || tl.includes('tranh den');
        const isEmlemd = tl.includes('emlemd') || tl.includes('emblemd');
        const isTigerSquare = tl.includes('tiger square');

        item.subType = '';

        if (isEmlemd || isMaiChe || isTranhDen || isTigerSquare) {
          item.brand = 'Tiger';
        } else {
          item.brand = '';
        }

        if (isTranhDen) {
          item.width = 1.1;
          item.height = 0.8;
          item.action = 'Làm mới';
          item.useOldSize = false;
        } else if (isEmlemd) {
          item.width = 0.8;
          item.height = 0.77;
          item.useOldSize = false;
        } else if (isTigerSquare) {
          item.width = 0.8;
          item.height = 0.71;
          item.useOldSize = false;
        } else {
          item.width = '';
          item.height = '';
        }

        if (tl.includes('logo outdoor') || tv === 'Logo Outdoor') {
          item.subType = '';
          item.width = '';
          item.height = '';
          item.brand = '';
          item.useOldSize = false;
        }

        // Mái che di động, Rèm Mái Che: mặc định hình thức 'Làm mới', vô hiệu hóa trụ (0)
        if (isMaiChe || isRem) {
          item.action = 'Làm mới';
          item.poles = 0;
        } else if (isTranhDen) {
          item.poles = 0;
          if (!item.action) item.action = 'Làm mới';
        } else if (!isEmlemd && !isTigerSquare) {
          item.action = '';
        }
      } catch (e) { item.brand = ''; }
    }

    if (field === 'brand') {
      try {
        const tl = String(item.type || '').toLowerCase();
        if (tl.includes('logo indoor') || item.type === 'Logo indoor') {
          item.subType = '';
          item.width = '';
          item.height = '';
        } else if (tl.includes('logo outdoor') || item.type === 'Logo Outdoor') {
          item.subType = '';
          item.useOldSize = false;
          item.width = '';
          item.height = '';
        }
      } catch (e) {}
    }

    if (field === 'subType') {
      try {
        const sub = String(value || '').toLowerCase();
        if (sub.includes('tranh đèn') || sub.includes('tranh den') || sub.includes('light poster')) {
          item.width = 1.1;
          item.height = 0.8;
          if (!item.action) item.action = 'Làm mới';
          item.poles = 0;
          item.useOldSize = false;
        } else if (sub.includes('emlemd') || sub.includes('emblemd')) {
          item.width = 0.8;
          item.height = 0.77;
          item.useOldSize = false;
        } else if (sub.includes('square') || sub.includes('suqare')) {
          item.width = 0.8;
          item.height = 0.71;
          item.useOldSize = false;
        } else if (sub.includes('group social') || sub.includes('ngôi sao') || sub.includes('ngoi sao')) {
          item.width = '';
          item.height = '';
          item.useOldSize = false;
        } else if (sub.includes('young social') || sub.includes('lưới') || sub.includes('luoi')) {
          item.width = '';
          item.height = '';
          item.useOldSize = false;
        } else {
          item.width = '';
          item.height = '';
        }
      } catch (e) {}
    }

    if (field === 'heinekenSizeSet') {
      try {
        const parts = String(value || '').split('x');
        if (parts.length === 2) {
          item.width = parseFloat(parts[0]);
          item.height = parseFloat(parts[1]);
          item.useOldSize = false;
        }
      } catch (e) {}
    }

    if (field === 'heinekenWidth') {
      try {
        const wVal = parseFloat(value);
        item.width = wVal;
        const pair = (typeof getMatchingHeinekenPair === 'function' ? getMatchingHeinekenPair(item.subType, 'width', wVal) : null);
        if (pair) {
          item.width = pair.width;
          item.height = pair.height;
        }
        item.useOldSize = false;
      } catch (e) {}
    }

    if (field === 'heinekenHeight') {
      try {
        const hVal = parseFloat(value);
        item.height = hVal;
        const pair = (typeof getMatchingHeinekenPair === 'function' ? getMatchingHeinekenPair(item.subType, 'height', hVal) : null);
        if (pair) {
          item.width = pair.width;
          item.height = pair.height;
        }
        item.useOldSize = false;
      } catch (e) {}
    }

    if (field === 'outdoorLogoWidth') {
      try {
        const wVal = parseFloat(value);
        item.width = wVal;
        const pair = (typeof getMatchingOutdoorLogoPair === 'function' ? getMatchingOutdoorLogoPair(item.brand, 'width', wVal) : null);
        if (pair) {
          item.width = pair.width;
          item.height = pair.height;
        }
        item.useOldSize = false;
      } catch (e) {}
    }

    if (field === 'outdoorLogoHeight') {
      try {
        const hVal = parseFloat(value);
        item.height = hVal;
        const pair = (typeof getMatchingOutdoorLogoPair === 'function' ? getMatchingOutdoorLogoPair(item.brand, 'height', hVal) : null);
        if (pair) {
          item.width = pair.width;
          item.height = pair.height;
        }
        item.useOldSize = false;
      } catch (e) {}
    }

    const tlAct = String(item.type || '').toLowerCase();
    const isFixedActionType = tlAct.includes('mái che') || tlAct.includes('mai che') || tlAct.includes('mái hiên') || tlAct.includes('mai hien') || tlAct.includes('rèm') || tlAct.includes('rem');
    if (field === 'action' && isFixedActionType) {
      item.action = 'Làm mới';
    }
    // Only re-render the whole items list when the change affects layout
    // (type, brand, subType, survey, useOldSize, action, heineken sizes, outdoor sizes). Avoid re-render on simple
    // numeric/text updates (width/height/poles/otherContent) to prevent
    // DOM replacement that blurs inputs on mobile.
    const layoutFields = ['type','brand','subType','survey','useOldSize','action','heinekenSizeSet','heinekenWidth','heinekenHeight','outdoorLogoWidth','outdoorLogoHeight'];
    const shouldRender = layoutFields.includes(field);
    if (shouldRender) renderRequestItems();
    try { saveNewRequestDraft(); } catch (e) {}
  }
}

function setPolesSilent(id, value) {
  const item = currentRequestItems.find(i => i.id === id);
  if (!item) return;
  if (isPolesDisabledType(item.type)) {
    item.poles = 0;
    const el = document.getElementById(`poles-${id}`);
    if (el) el.value = 0;
    try { showDefaultFieldToast(); } catch (e) {}
    try { saveNewRequestDraft(); } catch (e) {}
    return;
  }
  const v = parseInt(value, 10);
  item.poles = Number.isNaN(v) ? 0 : v;
  const el = document.getElementById(`poles-${id}`);
  if (el) el.value = item.poles;
  try { saveNewRequestDraft(); } catch (e) {}
}

function incrementPoles(id, delta) {
  const item = currentRequestItems.find(i => i.id === id);
  if (item && isPolesDisabledType(item.type, item)) {
    try { showDefaultFieldToast(); } catch (e) {}
    return;
  }
  const el = document.getElementById(`poles-${id}`);
  const cur = el ? (parseInt(el.value || '0', 10) || 0) : (currentRequestItems.find(i => i.id === id)?.poles || 0);
  setPolesSilent(id, cur + delta);
}

function toggleOldSize(id) {
  const item = currentRequestItems.find(i => i.id === id);
  if (item) {
    const tl = String(item.type || '').toLowerCase();
    const sub = String(item.subType || '').toLowerCase();
    const isLogoIndoor = (item.type === 'Logo indoor' || tl.includes('logo indoor'));
    const isLogoOutdoor = (item.type === 'Logo Outdoor' || tl.includes('logo outdoor'));
    const isLogoOutdoorFixed = isLogoOutdoor && (item.brand === 'Tiger' || item.brand === 'Heineken');
    const isFixedSubType = sub.includes('tranh đèn') || sub.includes('tranh den') || sub.includes('light poster') || sub.includes('emlemd') || sub.includes('emblemd') || sub.includes('square') || sub.includes('suqare') || (isLogoIndoor && (item.brand === 'Tiger' || item.brand === 'Heineken')) || isLogoOutdoorFixed;
    if (tl.includes('tranh đèn') || tl.includes('tranh den') || tl.includes('emlemd') || tl.includes('emblemd') || tl.includes('tiger square') || isFixedSubType) {
      try { showDefaultFieldToast(); } catch (e) {}
      return;
    }
    item.useOldSize = !item.useOldSize;
    renderRequestItems();
    try { saveNewRequestDraft(); } catch (e) {}
  }
}

function toggleSurvey(id) {
  const item = currentRequestItems.find(i => i.id === id);
  if (!item) return;
  item.survey = !item.survey;
  if (item.survey) {
    item.width = '';
    item.height = '';
    item.poles = 0;
    item.useOldSize = false;
  }
  renderRequestItems();
  try { saveNewRequestDraft(); } catch (e) {}
}

function renderRequestItems() {
  const container = document.getElementById('requestItems');
  // preserve focus if possible to avoid mobile keyboard flicker
  const active = document.activeElement;
  const activeId = active && active.id ? active.id : null;
  const activeSelectionStart = (active && typeof active.selectionStart === 'number') ? active.selectionStart : null;

  container.innerHTML = currentRequestItems.map((item, index) => {
    const brands = getBrandsForType(item.type);
    const isOther = item.type === 'Hạng mục khác';
    const tl = String(item.type || '').toLowerCase();
    const isRem = tl.includes('rèm') || tl.includes('rem');
    const isMaiChe = !isRem && (tl.includes('mái che') || tl.includes('mai che') || tl.includes('mái hiên') || tl.includes('mai hien'));
    const isTranhDenLegacy = tl.includes('tranh đèn') || tl.includes('tranh den');
    const isEmlemdLegacy = tl.includes('emlemd') || tl.includes('emblemd');
    const isTigerSquareLegacy = tl.includes('tiger square');
    const isFixedTiger = isEmlemdLegacy || isMaiChe || isTranhDenLegacy || isTigerSquareLegacy;

    const isLogoIndoor = (item.type === 'Logo indoor' || tl.includes('logo indoor'));
    const isLogoIndoorTiger = isLogoIndoor && (item.brand === 'Tiger');
    const isLogoIndoorHeineken = isLogoIndoor && (item.brand === 'Heineken');

    const isLogoOutdoor = (item.type === 'Logo Outdoor' || tl.includes('logo outdoor'));
    const isLogoOutdoorTiger = isLogoOutdoor && (item.brand === 'Tiger');
    const isLogoOutdoorHeineken = isLogoOutdoor && (item.brand === 'Heineken');
    const isLogoOutdoorFixed = isLogoOutdoorTiger || isLogoOutdoorHeineken;
    let outdoorSizesList = [];
    if (isLogoOutdoorHeineken) {
      outdoorSizesList = (typeof heinekenOutdoorSizes !== 'undefined' ? heinekenOutdoorSizes : []);
    } else if (isLogoOutdoorTiger) {
      outdoorSizesList = (typeof tigerOutdoorSizes !== 'undefined' ? tigerOutdoorSizes : []);
    }

    const sub = String(item.subType || '').toLowerCase();
    const isTranhDen = isTranhDenLegacy || (isLogoIndoorTiger && (sub.includes('tranh đèn') || sub.includes('tranh den') || sub.includes('light poster')));
    const isEmlemd = isEmlemdLegacy || (isLogoIndoorTiger && (sub.includes('emlemd') || sub.includes('emblemd')));
    const isTigerSquare = isTigerSquareLegacy || (isLogoIndoorTiger && (sub.includes('square') || sub.includes('suqare')));

    const isHeinekenGroupSocial = isLogoIndoorHeineken && (sub.includes('group social') || sub.includes('ngôi sao') || sub.includes('ngoi sao'));
    const isHeinekenYoungSocial = isLogoIndoorHeineken && (sub.includes('young social') || sub.includes('lưới') || sub.includes('luoi'));
    let hkSubObj = null;
    if (isHeinekenGroupSocial) {
      hkSubObj = (typeof heinekenLogoSubTypes !== 'undefined' ? heinekenLogoSubTypes[0] : null);
    } else if (isHeinekenYoungSocial) {
      hkSubObj = (typeof heinekenLogoSubTypes !== 'undefined' ? heinekenLogoSubTypes[1] : null);
    }

    let isFixedSize = false;
    let fixedWidth = null;
    let fixedHeight = null;
    let isFixedAction = isMaiChe || isRem;
    let noPoles = isPolesDisabledType(item.type, item);

    if (isTranhDen) {
      isFixedSize = true;
      fixedWidth = 1.1;
      fixedHeight = 0.8;
      noPoles = true;
    } else if (isEmlemd) {
      isFixedSize = true;
      fixedWidth = 0.8;
      fixedHeight = 0.77;
    } else if (isTigerSquare) {
      isFixedSize = true;
      fixedWidth = 0.8;
      fixedHeight = 0.71;
    }

    if (isFixedAction) { item.action = 'Làm mới'; }
    if (isFixedTiger) { item.brand = 'Tiger'; }
    if (isFixedSize) { item.width = fixedWidth; item.height = fixedHeight; }
    if (isLogoIndoorHeineken || isLogoOutdoorFixed) { item.useOldSize = false; }
    if (noPoles) { item.poles = 0; }
    const hasBrandAndAction = item.type && (item.type.includes('Bảng') || item.type.includes('Hộp đèn') || item.type.includes('Logo') || tl.includes('mái che') || tl.includes('mai che') || tl.includes('rèm') || tl.includes('rem'));
    return `
      <div id="requestItem-${item.id}" class="bg-gray-50 rounded-xl p-4">
        <div class="flex items-center justify-between mb-3">
          <span class="font-medium">Yêu cầu ${index + 1}</span>
          <div class="flex items-center gap-3">
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500">Yêu cầu khảo sát</span>
              <button onclick="toggleSurvey(${item.id})" class="toggle-switch ${item.survey ? 'bg-gray-900 toggle-on' : 'bg-gray-300'} rounded-full p-0.5 relative">
                <div class="toggle-slider w-5 h-5 bg-white rounded-full shadow"></div>
              </button>
            </div>
            ${currentRequestItems.length > 1 ? `
              <button onclick="removeRequestItem(${item.id})" class="text-red-500 p-1">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                </svg>
              </button>
            ` : ''}
          </div>
        </div>

        ${item.survey ? `
          <div class="survey-warning">Khảo sát có thể mất vài ngày. Trường hợp cần gấp, báo admin QCAG.</div>
        ` : ''}

        <div class="space-y-3">
          <div>
            <label class="block text-xs text-gray-500 mb-1">Loại bảng hiệu</label>
              <div class="custom-select" data-id="${item.id}" data-field="type">
              <button type="button" id="type-${item.id}" class="cs-trigger" onclick="toggleCustomSelect(event, ${item.id}, 'type')"><span class="cs-label">${item.type ? (item.type === 'Bảng hiflex 2 mặt (KHÔNG ĐÈN)' ? escapeHtml('Bảng hiflex 2 mặt ') + '<span class="text-red-600 font-semibold">(KHÔNG ĐÈN)</span>' : escapeHtml(item.type)) : 'Chọn loại bảng hiệu'}</span></button>
              <div class="cs-options hidden ${index >= 1 ? 'dropup' : ''}">
                ${signTypes.map(t => t === 'Bảng hiflex 2 mặt (KHÔNG ĐÈN)' ? `<div class="cs-option" data-value="${escapeHtml(t)}">${escapeHtml('Bảng hiflex 2 mặt ')}<span class="text-red-600 font-semibold">(KHÔNG ĐÈN)</span></div>` : `<div class="cs-option" data-value="${escapeHtml(t)}">${escapeHtml(t)}</div>`).join('')}
              </div>
            </div>
          </div>

          ${item.type && !isOther ? `
            ${hasBrandAndAction ? `
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-gray-500 mb-1">Brand</label>
                  ${isFixedTiger ? `
                    <div class="cs-fixed-box" onclick="showDefaultFieldToast(event)" title="Hạng mục này đã được mặc định những thông tin này không thể thay đổi">
                      <span>Tiger</span>
                      <svg class="w-3.5 h-3.5 opacity-40 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                    </div>
                    <input type="hidden" name="brand-${item.id}" value="Tiger">
                  ` : `
                    <div class="custom-select" data-id="${item.id}" data-field="brand">
                      <button type="button" id="brand-${item.id}" class="cs-trigger" onclick="toggleCustomSelect(event, ${item.id}, 'brand')"><span class="cs-label">${item.brand || 'Chọn brand'}</span></button>
                      <div class="cs-options hidden">
                        ${brands.map(b => `<div class="cs-option" data-value="${escapeHtml(b)}">${escapeHtml(b)}</div>`).join('')}
                      </div>
                    </div>
                  `}
                </div>
                <div>
                  <label class="block text-xs text-gray-500 mb-1">Hình thức</label>
                  ${isFixedAction ? `
                    <div class="cs-fixed-box" onclick="showDefaultFieldToast(event)" title="Hạng mục này đã được mặc định những thông tin này không thể thay đổi">
                      <span>Làm mới</span>
                      <svg class="w-3.5 h-3.5 opacity-40 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                    </div>
                    <input type="hidden" name="action-${item.id}" value="Làm mới">
                  ` : `
                    <div class="custom-select" data-id="${item.id}" data-field="action">
                      <button type="button" class="cs-trigger" onclick="toggleCustomSelect(event, ${item.id}, 'action')"><span class="cs-label">${item.action || 'Chọn hình thức'}</span></button>
                      <div class="cs-options hidden">
                        ${getActionsForItem(item.type, item).map(act => `<div class="cs-option" data-value="${escapeHtml(act)}">${escapeHtml(act)}</div>`).join('')}
                      </div>
                    </div>
                  `}
                </div>
              </div>
            ` : `
              <div>
                <label class="block text-xs text-gray-500 mb-1">Brand</label>
                ${isFixedTiger ? `
                  <div class="cs-fixed-box" onclick="showDefaultFieldToast(event)" title="Hạng mục này đã được mặc định những thông tin này không thể thay đổi">
                    <span>Tiger</span>
                    <svg class="w-3.5 h-3.5 opacity-40 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                  </div>
                  <input type="hidden" name="brand-${item.id}" value="Tiger">
                ` : `
                  <div class="custom-select" data-id="${item.id}" data-field="brand">
                    <button type="button" id="brand-${item.id}" class="cs-trigger" onclick="toggleCustomSelect(event, ${item.id}, 'brand')"><span class="cs-label">${item.brand || 'Chọn brand'}</span></button>
                    <div class="cs-options hidden">
                      ${brands.map(b => `<div class="cs-option" data-value="${escapeHtml(b)}">${escapeHtml(b)}</div>`).join('')}
                    </div>
                  </div>
                `}
              </div>
            `}

            ${isLogoIndoorTiger || isLogoIndoorHeineken ? `
              <div>
                <label class="block text-xs text-gray-500 mb-1">Phân loại</label>
                <div class="custom-select" data-id="${item.id}" data-field="subType">
                  <button type="button" id="subType-${item.id}" class="cs-trigger" onclick="toggleCustomSelect(event, ${item.id}, 'subType')">
                    <span class="cs-label">${item.subType ? escapeHtml(getLogoSubTypeLabel(item.subType)) : 'Chọn phân loại'}</span>
                  </button>
                  <div class="cs-options hidden">
                    ${(isLogoIndoorTiger ? tigerLogoSubTypes : (typeof heinekenLogoSubTypes !== 'undefined' ? heinekenLogoSubTypes : [])).map(s => `<div class="cs-option" data-value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</div>`).join('')}
                  </div>
                </div>
              </div>
            ` : ''}

            ${hasBrandAndAction ? `
              <div>
                ${item.action === 'Di dời' ? `
                  <label class="block text-xs text-amber-600 font-medium mb-1 flex items-center justify-between">
                    <span>Yêu cầu riêng</span>
                    <span class="text-[11px] text-red-500 font-semibold">* Bắt buộc: Tên quán lấy Logo</span>
                  </label>
                  <textarea id="note-${item.id}" onchange="updateRequestItem(${item.id}, 'note', this.value)" placeholder="Bắt buộc nhập tên quán nơi lấy Logo và yêu cầu khác nếu có..." rows="2" class="w-full px-3 py-2 border border-amber-300 rounded-lg bg-amber-50/40 text-xs resize-none focus:border-amber-500">${item.note || ''}</textarea>
                  <p class="text-[11px] text-amber-600 mt-1 flex items-center gap-1">
                    <svg class="w-3.5 h-3.5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                    <span>Bạn bắt buộc phải nhập tên quán nơi lấy Logo và yêu cầu khác nếu có</span>
                  </p>
                ` : item.action === 'Thu hồi' ? `
                  <label class="block text-xs text-amber-600 font-medium mb-1 flex items-center justify-between">
                    <span>Yêu cầu riêng</span>
                    <span class="text-[11px] text-red-500 font-semibold">* Bắt buộc: Nơi lưu trữ</span>
                  </label>
                  <textarea id="note-${item.id}" onchange="updateRequestItem(${item.id}, 'note', this.value)" placeholder="Bắt buộc nhập nơi lưu trữ và yêu cầu khác nếu có..." rows="2" class="w-full px-3 py-2 border border-amber-300 rounded-lg bg-amber-50/40 text-xs resize-none focus:border-amber-500">${item.note || ''}</textarea>
                  <p class="text-[11px] text-amber-600 mt-1 flex items-center gap-1">
                    <svg class="w-3.5 h-3.5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                    <span>Bạn bắt buộc phải nhập nơi lưu trữ và yêu cầu khác nếu có</span>
                  </p>
                ` : `
                  <label class="block text-xs text-gray-500 mb-1">Yêu cầu riêng (nếu có)</label>
                  <textarea id="note-${item.id}" onchange="updateRequestItem(${item.id}, 'note', this.value)" placeholder="Nhập yêu cầu riêng (ví dụ: sửa viền, thay khung...)" rows="2" class="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white text-xs resize-none">${item.note || ''}</textarea>
                `}
              </div>
            ` : ''}

            ${!item.survey ? `
            <div class="py-2">
              <div class="flex items-center justify-between text-sm text-gray-500 mb-2">
                <span class="${noPoles ? 'text-gray-400' : ''}">Số trụ</span>
                <span>Kích thước cũ</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-3">
                  <div class="flex items-center gap-2" ${noPoles ? `onclick="showDefaultFieldToast(event)"` : ''}>
                    <button type="button" ${noPoles ? `onclick="showDefaultFieldToast(event)"` : `onclick="incrementPoles(${item.id}, -1)"`} class="w-8 h-8 flex items-center justify-center bg-gray-100 rounded-lg text-sm font-semibold ${noPoles ? 'opacity-40 cursor-not-allowed text-gray-400' : ''}">-</button>
                    <input id="poles-${item.id}" type="text" ${noPoles ? `readonly onclick="showDefaultFieldToast(event)"` : ''} inputmode="numeric" pattern="\\d*" value="${noPoles ? 0 : (item.poles || 0)}" oninput="sanitizeIntegerInput(this)" onchange="setPolesSilent(${item.id}, this.value)" class="w-12 h-8 px-2 border border-gray-200 rounded-lg text-sm text-center ${noPoles ? 'opacity-50 bg-gray-100 cursor-not-allowed text-gray-400' : ''}">
                    <button type="button" ${noPoles ? `onclick="showDefaultFieldToast(event)"` : `onclick="incrementPoles(${item.id}, 1)"`} class="w-8 h-8 flex items-center justify-center bg-gray-100 rounded-lg text-sm font-semibold ${noPoles ? 'opacity-40 cursor-not-allowed text-gray-400' : ''}">+</button>
                    <span class="text-xs ${noPoles ? 'text-gray-400' : 'text-gray-500'}">trụ</span>
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <button onclick="toggleOldSize(${item.id})" class="toggle-switch ${item.useOldSize ? 'bg-gray-900 toggle-on' : 'bg-gray-300'} ${isFixedSize || isLogoIndoorHeineken || isLogoOutdoorFixed ? 'opacity-40 cursor-not-allowed' : ''} rounded-full p-0.5 relative">
                    <div class="toggle-slider w-5 h-5 bg-white rounded-full shadow"></div>
                  </button>
                </div>
              </div>
            </div>

            ${isLogoIndoorHeineken ? `
              ${!item.subType ? `
                <div class="py-2.5 px-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                  Vui lòng chọn Phân loại để chọn kích thước
                </div>
              ` : `
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs text-gray-500 mb-1">Ngang (m)</label>
                    <div class="custom-select" data-id="${item.id}" data-field="heinekenWidth">
                      <button type="button" id="width-${item.id}" class="cs-trigger" onclick="toggleCustomSelect(event, ${item.id}, 'heinekenWidth')">
                        <span class="cs-label font-medium">${item.width ? `${item.width}m` : 'Chọn ngang'}</span>
                      </button>
                      <div class="cs-options hidden dropup">
                        ${(hkSubObj ? hkSubObj.sizes : []).map(s => `
                          <div class="cs-option ${Math.abs(item.width - s.width) < 0.001 ? 'selected' : ''}" data-value="${s.width}">
                            ${s.width}m
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  </div>
                  <div>
                    <label class="block text-xs text-gray-500 mb-1">Cao (m)</label>
                    <div class="custom-select" data-id="${item.id}" data-field="heinekenHeight">
                      <button type="button" id="height-${item.id}" class="cs-trigger" onclick="toggleCustomSelect(event, ${item.id}, 'heinekenHeight')">
                        <span class="cs-label font-medium">${item.height ? `${item.height}m` : 'Chọn cao'}</span>
                      </button>
                      <div class="cs-options hidden dropup">
                        ${(hkSubObj ? hkSubObj.sizes : []).map(s => `
                          <div class="cs-option ${Math.abs(item.height - s.height) < 0.001 ? 'selected' : ''}" data-value="${s.height}">
                            ${s.height}m
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  </div>
                </div>
              `}
            ` : isLogoOutdoorFixed ? `
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-gray-500 mb-1">Ngang (m)</label>
                  <div class="custom-select" data-id="${item.id}" data-field="outdoorLogoWidth">
                    <button type="button" id="width-${item.id}" class="cs-trigger" onclick="toggleCustomSelect(event, ${item.id}, 'outdoorLogoWidth')">
                      <span class="cs-label font-medium">${item.width ? `${item.width}m` : 'Chọn ngang'}</span>
                    </button>
                    <div class="cs-options hidden dropup">
                      ${outdoorSizesList.map(s => `
                        <div class="cs-option ${Math.abs(item.width - s.width) < 0.001 ? 'selected' : ''}" data-value="${s.width}">
                          ${s.width}m
                        </div>
                      `).join('')}
                    </div>
                  </div>
                </div>
                <div>
                  <label class="block text-xs text-gray-500 mb-1">Cao (m)</label>
                  <div class="custom-select" data-id="${item.id}" data-field="outdoorLogoHeight">
                    <button type="button" id="height-${item.id}" class="cs-trigger" onclick="toggleCustomSelect(event, ${item.id}, 'outdoorLogoHeight')">
                      <span class="cs-label font-medium">${item.height ? `${item.height}m` : 'Chọn cao'}</span>
                    </button>
                    <div class="cs-options hidden dropup">
                      ${outdoorSizesList.map(s => `
                        <div class="cs-option ${Math.abs(item.height - s.height) < 0.001 ? 'selected' : ''}" data-value="${s.height}">
                          ${s.height}m
                        </div>
                      `).join('')}
                    </div>
                  </div>
                </div>
              </div>
            ` : !item.useOldSize ? `
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-gray-500 mb-1">Ngang (m)</label>
                  ${isFixedSize ? `
                    <div class="cs-fixed-box" onclick="showDefaultFieldToast(event)" title="Hạng mục này đã được mặc định những thông tin này không thể thay đổi">
                      <span>${fixedWidth}</span>
                      <svg class="w-3.5 h-3.5 opacity-40 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                    </div>
                    <input type="hidden" id="width-${item.id}" value="${fixedWidth}">
                  ` : `
                    <input id="width-${item.id}" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" value="${item.width}" oninput="sanitizeDecimalInput(this)" onchange="updateRequestItem(${item.id}, 'width', this.value)" class="w-full px-3 py-2.5 border border-gray-200 rounded-lg bg-white text-sm" placeholder="0.00">
                  `}
                </div>
                <div>
                  <label class="block text-xs text-gray-500 mb-1">Cao (m)</label>
                  ${isFixedSize ? `
                    <div class="cs-fixed-box" onclick="showDefaultFieldToast(event)" title="Hạng mục này đã được mặc định những thông tin này không thể thay đổi">
                      <span>${fixedHeight}</span>
                      <svg class="w-3.5 h-3.5 opacity-40 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                    </div>
                    <input type="hidden" id="height-${item.id}" value="${fixedHeight}">
                  ` : `
                    <input id="height-${item.id}" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" value="${item.height}" oninput="sanitizeDecimalInput(this)" onchange="updateRequestItem(${item.id}, 'height', this.value)" class="w-full px-3 py-2.5 border border-gray-200 rounded-lg bg-white text-sm" placeholder="0.00">
                  `}
                </div>
              </div>
            ` : `
              <div class="py-2 px-3 bg-gray-200 rounded-lg text-sm text-gray-600">
                Sử dụng theo kích thước cũ
              </div>
            `}
            ` : ''}
          ` : ''}

          ${isOther ? `
            <div>
              <label class="block text-xs text-gray-500 mb-1">Nội dung yêu cầu</label>
              <textarea id="otherContent-${item.id}" onchange="updateRequestItem(${item.id}, 'otherContent', this.value)" rows="3" class="w-full px-3 py-2.5 border border-gray-200 rounded-lg bg-white text-sm resize-none" placeholder="Mô tả chi tiết yêu cầu">${item.otherContent || ''}</textarea>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Attach event listeners for custom select options
  container.querySelectorAll('.custom-select').forEach(cs => {
    const id = cs.getAttribute('data-id');
    const field = cs.getAttribute('data-field');
    cs.querySelectorAll('.cs-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const value = opt.getAttribute('data-value') || '';
        chooseCustomOption(parseInt(id, 10), field, value);
      });
    });
  });
  // Attach realtime validation-clear listeners for dynamic item fields
  try {
    container.querySelectorAll('input, textarea, .cs-trigger').forEach(el => {
      // remove field-error on input/change/click
      const clear = () => { try { el.classList.remove('field-error'); } catch (e) {} };
      el.removeEventListener('input', clear);
      el.removeEventListener('change', clear);
      el.removeEventListener('click', clear);
      el.addEventListener('input', clear);
      el.addEventListener('change', clear);
      el.addEventListener('click', clear);
    });
  } catch (e) {}
  // try to restore focus to previously focused input (if it still exists)
  try {
    if (activeId) {
      const after = document.getElementById(activeId);
      if (after) {
        after.focus();
        if (activeSelectionStart !== null && typeof after.setSelectionRange === 'function') {
          try { after.setSelectionRange(activeSelectionStart, activeSelectionStart); } catch (e) {}
        }
      }
    }
  } catch (e) {}
  // If we're currently on Tab 3, refresh its UI because available item types changed
  try { if (typeof updateTab3UI === 'function' && currentTab === 3) updateTab3UI(); } catch (e) {}
  try { if (typeof initQuickFill === 'function') initQuickFill(); } catch (e) {}
}

// Attach realtime validation clearing for static fields on Tab1/Tab3
function attachValidationClearing() {
  try {
    const ids = ['outletCode','outletName','address','phone','signContent'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const clear = () => { try { el.classList.remove('field-error'); } catch (e) {} };
      el.removeEventListener('input', clear);
      el.removeEventListener('change', clear);
      el.addEventListener('input', clear);
      el.addEventListener('change', clear);
    });

    // file inputs: status/old content upload inputs remove error on change
    const statusInput = document.querySelector('#statusImagesPreview')?.parentElement?.querySelector('input[type=file]');
    if (statusInput) {
      statusInput.addEventListener('change', () => { try { document.getElementById('statusUploadLabel')?.classList.remove('field-error'); } catch (e) {} });
    }
    // Save drafts when basic fields change
    const autosaveIds = ['outletCode','outletName','address','phone','signContent','oldContentExtra'];
    autosaveIds.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const saver = () => { try { saveNewRequestDraft(); } catch (e) {} };
      el.removeEventListener('input', saver);
      el.removeEventListener('change', saver);
      el.addEventListener('input', saver);
      el.addEventListener('change', saver);
    });
    // oldContent image upload removed — no oldInput listener needed
  } catch (e) {}
}

// Run once after load to attach handlers for static fields
try { setTimeout(attachValidationClearing, 120); } catch (e) {}
try { setTimeout(updateDraftsButton, 120); } catch (e) {}

// Update the New Request header to show the Outlet name when provided
function updateNewRequestHeaderOutletName() {
  try {
    const el = document.getElementById('newRequestOutletName');
    const name = (document.getElementById('outletName') || { value: '' }).value || '';
    if (!el) return;
    el.textContent = name ? ('Outlet: ' + name) : '';
  } catch (e) {}
}

// keep header in sync when user types outlet name
try {
  const on = document.getElementById('outletName');
  if (on) {
    on.removeEventListener('input', updateNewRequestHeaderOutletName);
    on.addEventListener('input', updateNewRequestHeaderOutletName);
    on.removeEventListener('change', updateNewRequestHeaderOutletName);
    on.addEventListener('change', updateNewRequestHeaderOutletName);
  }
} catch (e) {}

// ── Old content toggle ────────────────────────────────────────────────

function toggleOldContent() {
  isOldContent = !isOldContent;
  const toggle = document.getElementById('oldContentToggle');
  toggle.className = `toggle-switch ${isOldContent ? 'bg-gray-900 toggle-on' : 'bg-gray-300'} rounded-full p-0.5 relative`;
  document.getElementById('newContentSection').classList.toggle('hidden', isOldContent);
  document.getElementById('oldContentSection').classList.toggle('hidden', !isOldContent);
  try { if (typeof updateTab3UI === 'function') updateTab3UI(); } catch (e) {}
}

// ── Validation ────────────────────────────────────────────────────────

function clearNewRequestFieldErrors() {
  try {
    document.querySelectorAll('#newRequestScreen .field-error').forEach(el => el.classList.remove('field-error'));
  } catch (e) {}
}

function markFieldError(el) {
  try { if (el) el.classList.add('field-error'); } catch (e) {}
}

function markItemCustomSelectError(itemId, field) {
  try {
    const trigger = document.querySelector(`#requestItem-${itemId} .custom-select[data-field="${field}"] .cs-trigger`);
    if (trigger) trigger.classList.add('field-error');
  } catch (e) {}
}

// Quiet checks used by tab-locking logic. Do not show toasts — return boolean.
function isTab1Complete() {
  try {
    const code = (document.getElementById('outletCode') || {}).value || '';
    const name = (document.getElementById('outletName') || {}).value || '';
    const address = (document.getElementById('address') || {}).value || '';
    const phone = (document.getElementById('phone') || {}).value || '';
    if (!code || !name || !address || !phone) return false;
    if (code !== 'New Outlet' && !/^\d{8}$/.test(code)) return false;
    // phone normalization
    const digits = (typeof normalizeVietnamPhone === 'function') ? normalizeVietnamPhone(phone) : String(phone || '').replace(/\D/g, '');
    if (digits.startsWith('02')) {
      if (digits.length !== 11) return false;
    } else {
      if (digits.length !== 10) return false;
    }
    return true;
  } catch (e) { return false; }
}

function isTab2Complete() {
  try {
    if (!Array.isArray(currentRequestItems) || currentRequestItems.length === 0) return false;
    for (const item of currentRequestItems) {
      if (!item.type) return false;
      if (item.type === 'Hạng mục khác') {
        if (!item.otherContent) return false;
      } else {
        if (!item.brand) return false;
        const isLogoIndoorWithSub = (item.type === 'Logo indoor' || String(item.type || '').toLowerCase().includes('logo indoor')) && (item.brand === 'Tiger' || item.brand === 'Heineken');
        if (isLogoIndoorWithSub && !item.subType) return false;
        if ((item.type.includes('Bảng') || item.type.includes('Hộp đèn') || item.type.includes('Logo') || isPolesDisabledType(item.type)) && !item.action) return false;
        if (item.action === 'Di dời' && !String(item.note || '').trim()) return false;
        if (item.action === 'Thu hồi' && !String(item.note || '').trim()) return false;
        if (!item.survey) {
          if (!item.useOldSize && (!item.width || !item.height)) return false;
          if (!isPolesDisabledType(item.type) && (!Number.isInteger(item.poles) || item.poles < 0)) return false;
        }
      }
    }
    return true;
  } catch (e) { return false; }
}

function validateTab1() {
  clearNewRequestFieldErrors();
  const code = document.getElementById('outletCode').value.trim();
  const name = document.getElementById('outletName').value.trim();
  const address = document.getElementById('address').value.trim();
  const phone = document.getElementById('phone').value.trim();
  let hasError = false;

  if (!code || !name || !address || !phone) {
    if (!code) { markFieldError(document.getElementById('outletCode')); hasError = true; }
    if (!name) { markFieldError(document.getElementById('outletName')); hasError = true; }
    if (!address) { markFieldError(document.getElementById('address')); hasError = true; }
    if (!phone) { markFieldError(document.getElementById('phone')); hasError = true; }
    showToast('Vui lòng điền đầy đủ thông tin');
    return;
  }
  // outlet code must be exactly 8 digits, allow literal 'New Outlet' when toggle is used
  try {
    if (code !== 'New Outlet' && !/^\d{8}$/.test(code)) {
      markFieldError(document.getElementById('outletCode'));
      hasError = true;
      showToast('Mã outlet phải là 8 chữ số');
      return;
    }
  } catch (e) {}
  // validate phone length: normally 10 digits; if starts with 02 allow 11 digits
  try {
    // normalize +84/84 prefixes to leading 0 just like the input sanitizer
    const digits = (typeof normalizeVietnamPhone === 'function') ? normalizeVietnamPhone(phone) : String(phone || '').replace(/\D/g, '');
    if (digits.startsWith('02')) {
      if (digits.length !== 11) {
        markFieldError(document.getElementById('phone'));
        hasError = true;
        showToast('Số điện thoại bắt đầu bằng 02 phải có 11 chữ số');
        return;
      }
    } else {
      if (digits.length !== 10) {
        markFieldError(document.getElementById('phone'));
        hasError = true;
        showToast('Số điện thoại phải có 10 chữ số');
        return;
      }
    }
  } catch (e) {}
  if (hasError) return;
  // Save outlet draft so next request pre-fills step 1 and skips it
  try {
    const prevDraft = JSON.parse(localStorage.getItem(OUTLET_DRAFT_KEY) || '{}');
    const draft = {
      ...prevDraft,
      outletCode: code,
      outletName: name,
      address,
      phone,
      outletLat: document.getElementById('outletLat').value || '',
      outletLng: document.getElementById('outletLng').value || '',
      locationPreview: document.getElementById('outletLat').value
        ? (document.getElementById('locationPreview').textContent || '').trim()
        : ''
    };
    localStorage.setItem(OUTLET_DRAFT_KEY, JSON.stringify(draft));
    _justLoggedIn = false; // after confirming step 1, subsequent requests skip it
  } catch (e) {}
  // If outlet matches an existing request, require explicit confirmation to continue
  checkOutletDuplicate();
  if (duplicateOutletState && !userConfirmedNewForOutlet) {
    // duplicate modal is shown by checkOutletDuplicate(); stop here until user picks an action
    return;
  }
  // Block if waiting for takeover confirmation of another sale's outlet
  if (otherOutletState && !userConfirmedTakeover) {
    return;
  }
  // Bypassed: Require outlet location selected before moving to Tab 2 (will validate on submit instead)
  switchTab(2);
}

function validateTab2() {
  clearNewRequestFieldErrors();
  let hasError = false;

  if (!Array.isArray(currentRequestItems) || currentRequestItems.length === 0) {
    showToast('Vui lòng thêm hạng mục yêu cầu');
    return;
  }

  for (const item of currentRequestItems) {
    if (!item.type) {
      markItemCustomSelectError(item.id, 'type');
      hasError = true;
      continue;
    }
    if (item.type !== 'Hạng mục khác') {
      if (!item.brand) {
        markItemCustomSelectError(item.id, 'brand');
        hasError = true;
      }
      const isLogoIndoorTiger = (item.type === 'Logo indoor' || String(item.type || '').toLowerCase().includes('logo indoor')) && (item.brand === 'Tiger');
      const isLogoIndoorHeineken = (item.type === 'Logo indoor' || String(item.type || '').toLowerCase().includes('logo indoor')) && (item.brand === 'Heineken');
      if ((isLogoIndoorTiger || isLogoIndoorHeineken) && !item.subType) {
        markItemCustomSelectError(item.id, 'subType');
        hasError = true;
      }
      // Hình thức (Làm mới / Thay bạt / Sửa chữa / Di dời / Thu hồi / Thay Poster) là bắt buộc cho Bảng, Hộp đèn, Logo, Mái che, Rèm
      if ((item.type.includes('Bảng') || item.type.includes('Hộp đèn') || item.type.includes('Logo') || isPolesDisabledType(item.type, item)) && !item.action) {
        markItemCustomSelectError(item.id, 'action');
        hasError = true;
      }
      if (item.action === 'Di dời' && !String(item.note || '').trim()) {
        markFieldError(document.getElementById(`note-${item.id}`));
        showToast('Vui lòng nhập tên quán nơi lấy Logo cho hạng mục Di dời');
        hasError = true;
      } else if (item.action === 'Thu hồi' && !String(item.note || '').trim()) {
        markFieldError(document.getElementById(`note-${item.id}`));
        showToast('Vui lòng nhập nơi lưu trữ cho hạng mục Thu hồi');
        hasError = true;
      }
      if (!item.survey) {
        if (!item.useOldSize) {
          if (!item.width) { markFieldError(document.getElementById(`width-${item.id}`)); hasError = true; }
          if (!item.height) { markFieldError(document.getElementById(`height-${item.id}`)); hasError = true; }
        }
        if (!isPolesDisabledType(item.type, item)) {
          if (!Number.isInteger(item.poles) || item.poles < 0) {
            markFieldError(document.getElementById(`poles-${item.id}`));
            hasError = true;
          }
        }
      }
    } else {
      if (!item.otherContent) {
        markFieldError(document.getElementById(`otherContent-${item.id}`));
        hasError = true;
      }
    }
  }

  if (hasError) {
    showToast('Vui lòng điền đầy đủ thông tin hạng mục');
    return;
  }
  switchTab(3);
}

// ── Submit ────────────────────────────────────────────────────────────

async function submitNewRequest() {
  // Guard: prevent concurrent/double submissions (e.g. impatient double-tap)
  if (_isNewRequestSubmitting) return;
  clearNewRequestFieldErrors();
  const content = document.getElementById('signContent').value.trim();
  let hasError = false;

  // Only require content when there is at least one signage item (Bảng or Hộp đèn)
  if (hasSignageItems() && !isOldContent && !content) {
    markFieldError(document.getElementById('signContent'));
    hasError = true;
  }
  // Old content image upload removed — no image validation needed for oldContent
  if (statusImages.length === 0) {
    markFieldError(document.getElementById('statusUploadLabel'));
    hasError = true;
  }
  // Require outlet location (lat/lng) to be set. If missing, show warning, display location container, and open manual location modal.
  const latVal = (document.getElementById('outletLat')||{value:''}).value || '';
  const lngVal = (document.getElementById('outletLng')||{value:''}).value || '';
  if (!latVal || !lngVal) {
    try {
      const container = document.getElementById('outletLocationContainer');
      if (container) container.classList.remove('hidden');
      markFieldError(document.getElementById('btn-locate-outlet') || document.getElementById('locationPreviewText'));
    } catch (e) {}
    showToast('Ảnh không có GPS (EXIF không chứa tọa độ), vui lòng bật định vị hoặc chọn vị trí thủ công.');
    try { if (typeof openLocationModal === 'function') openLocationModal(); } catch (e) {}
    return;
  }
  if (hasError) {
    showToast('Vui lòng điền đầy đủ nội dung bắt buộc');
    return;
  }

  const btn = document.getElementById('submitNewBtn');
  _isNewRequestSubmitting = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="inline-block animate-spin mr-2">⏳</span> Đang gửi yêu cầu...';
  showLoadingOverlay('Đang gửi yêu cầu...', 'Hệ thống đang tải hình và xử lý dữ liệu, vui lòng chờ trong giây lát');

  // Pre-generate __backendId so GCS folder name is consistent between create and patch
  const __preBackendId = 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

  // ── Use pre-compressed images (compressed on pick, not on submit) ──
  // handleStatusImages now compresses immediately when user selects photos.
  // _statusImageFiles contains either pre-compressed data URLs or File objects.
  let _compressedStatusDataUrls = [];
  for (const item of _statusImageFiles) {
    if (typeof item === 'string' && item.startsWith('data:')) {
      // Already compressed on pick
      _compressedStatusDataUrls.push(item);
    } else if (typeof item === 'string' && item.startsWith('blob:')) {
      // Blob URL still present — compression + fallback both failed or are pending.
      // Skip silently — this entry will be dropped.
      console.warn('[submit] skipping unresolved blob URL:', item.slice(0, 40));
    } else if (item instanceof File || item instanceof Blob) {
      // Fallback: compress now (shouldn't happen normally)
      try {
        const dataUrl = await _compressImageFile(item, 1600, 0.82);
        if (dataUrl) _compressedStatusDataUrls.push(dataUrl);
      } catch (e) {
        console.warn('[submit] compress fallback failed:', e);
        try {
          const raw = await new Promise((resolve, reject) => {
            const r = new FileReader(); r.onload = (ev) => resolve(ev.target.result); r.onerror = reject; r.readAsDataURL(item);
          });
          if (raw) _compressedStatusDataUrls.push(raw);
        } catch (_) {}
      }
    }
  }

  // Safety: if all images lost, abort
  if (_statusImageFiles.length > 0 && _compressedStatusDataUrls.length === 0) {
    hideLoadingOverlay();
    showToast('Lỗi xử lý ảnh — vui lòng thử lại');
    btn.disabled = false;
    btn.textContent = 'Xác nhận yêu cầu';
    _isNewRequestSubmitting = false;
    return;
  }

  const request = {
    type: 'new',
    outletCode: document.getElementById('outletCode').value.trim(),
    outletName: document.getElementById('outletName').value.trim(),
    address: document.getElementById('address').value.trim(),
    outletLat: document.getElementById('outletLat').value || '',
    outletLng: document.getElementById('outletLng').value || '',
    locationSource: (document.getElementById('locationSource') || {}).value || 'manual',
    phone: document.getElementById('phone').value.trim(),
    items: JSON.stringify(currentRequestItems),
    content: isOldContent ? '' : content,
    oldContent: isOldContent,
    oldContentExtra: isOldContent ? (document.getElementById('oldContentExtra')||{value:''}).value.trim() : '',
    statusImages: JSON.stringify(_compressedStatusDataUrls),  // ← Images included directly
    designImages: '[]',
    acceptanceImages: '[]',
    createdAt: new Date().toISOString(),
    status: 'pending',
    requester: JSON.stringify(currentSession || {}),
    __backendId: __preBackendId,
  };

  // NOTE: Images are now included directly in the POST body (compressed base64).
  // The backend uploads them to GCS atomically during request creation.
  // No more background PATCH needed — images are guaranteed to be saved.

  // If user previously confirmed "Hạng mục mới" for this outlet, ensure items are not identical to the latest existing request
  try {
    if (duplicateOutletState && userConfirmedNewForOutlet && duplicateOutletState.existingRequest) {
      const prevItems = JSON.parse(duplicateOutletState.existingRequest.items || '[]');
      if (areItemsEquivalent(prevItems, currentRequestItems)) {
        // Block submission and prompt user to edit or open old request
        showDuplicateItemsModal();
        btn.disabled = false;
        btn.textContent = 'Xác nhận yêu cầu';
        _isNewRequestSubmitting = false;
        return;
      }
    }
  } catch (e) {}

  // Save items to outlet draft for next request pre-fill
  try {
    const prevDraft = JSON.parse(localStorage.getItem(OUTLET_DRAFT_KEY) || '{}');
    localStorage.setItem(OUTLET_DRAFT_KEY, JSON.stringify({
      ...prevDraft,
      items: JSON.stringify(currentRequestItems)
    }));
  } catch (e) {}

  if (window.dataSdk) {
    const result = await window.dataSdk.create(request);
    if (result.isOk) {
      // store last created id for quick view
      try { lastCreatedRequestId = result.data && result.data.__backendId ? result.data.__backendId : (request.__backendId || null); } catch (e) {}
      try { blurActiveInput(); } catch (e) {}

      // Verify images were saved: the POST response should contain GCS URLs.
      // If the backend somehow returned without uploading (e.g. KS_GCS_BUCKET
      // not set), log a warning.  No background PATCH needed — the backend
      // POST handler uploads base64 → GCS atomically in ksAutoUploadImages().
      try {
        const savedImgs = (result.data && result.data.statusImages) || '[]';
        const parsed = JSON.parse(savedImgs);
        if (_compressedStatusDataUrls.length > 0 && (!Array.isArray(parsed) || parsed.length === 0)) {
          console.warn('[submit] WARNING: images were sent but server returned empty statusImages — check KS_GCS_BUCKET config');
        } else {
          console.log('[submit] images confirmed saved:', parsed.length, 'image(s)');
        }
      } catch (verifyErr) { console.warn('[submit] image verify parse error:', verifyErr); }

      // Fire push notification to QCAG team (best-effort, never blocks UI)
      // Uses the same-origin Vercel function /api/ks/push/send — this guarantees
      // the same VAPID keys that were used when QCAG subscribed, avoiding key-mismatch.
      try {
        const outletLabel = request.outletName || request.outletCode || 'Outlet';
        const tkCode = (result.data && result.data.__backendId) || request.__backendId || '';
        const senderName = (typeof currentSession !== 'undefined' && currentSession && (currentSession.saleName || currentSession.name || currentSession.phone)) || 'Sale Heineken';
        var pushUrl = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
          ? 'https://qcag-survey-app.vercel.app/api/ks/push/send'
          : '/api/ks/push/send';
        fetch(pushUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'QCAG — Yêu cầu mới từ Heineken',
            body: senderName + ' vừa gửi yêu cầu mới cho Outlet ' + outletLabel + '.',
            data: { backendId: tkCode },
            role: 'qcag',
          }),
        }).catch(function (e) { console.warn('[push/new-req]', e); });
      } catch (e) {
        console.warn('[push] new request notify error (non-fatal):', e);
      }

      // Reset form immediately so that if the user dismisses the modal via the
      // OS back gesture (instead of the official modal buttons) they land on a
      // clean, empty form — preventing accidental duplicate submissions.
      try { if (typeof clearNewRequestDraft === 'function') clearNewRequestDraft(_currentNewRequestDraftId); } catch (e) {}
      resetNewRequestForm();

      hideLoadingOverlay();
      if (typeof openConfirmSuccessModal === 'function') openConfirmSuccessModal();
      else document.getElementById('confirmModal').classList.remove('hidden');

      // Release the guard — form is now clean, future submissions are safe.
      _isNewRequestSubmitting = false;
      // NOTE: We intentionally do NOT re-enable the submit button here.
      // resetNewRequestForm() resets it; the modal is the only visible UI now.
      return;
    } else {
      hideLoadingOverlay();
      showToast('Lỗi tạo yêu cầu');
    }
  } else {
    request.__backendId = generateBackendId();
    allRequests.push(request);
    saveAllRequestsToStorage();
    updateRequestCount();
    lastCreatedRequestId = request.__backendId;
    try { blurActiveInput(); } catch (e) {}
    try { if (typeof clearNewRequestDraft === 'function') clearNewRequestDraft(_currentNewRequestDraftId); } catch (e) {}
    resetNewRequestForm();
    hideLoadingOverlay();
    if (typeof openConfirmSuccessModal === 'function') openConfirmSuccessModal();
    else document.getElementById('confirmModal').classList.remove('hidden');
    _isNewRequestSubmitting = false;
    return;
  }

  // Reached only on failure — re-enable the button so user can retry.
  hideLoadingOverlay();
  btn.disabled = false;
  btn.textContent = 'Xác nhận yêu cầu';
  _isNewRequestSubmitting = false;
}

// ── Background image upload — DEPRECATED ────────────────────────────────────
// No longer used for new requests.  Images are now included synchronously in
// the POST body (compressed base64) so they are uploaded atomically with
// request creation.  This function is kept only for backward compatibility
// with warranty-flow or potential future use.
async function _bgUploadAndPatch(backendId, tkCode, statusFiles) {
  if (!window.dataSdk) return;
  try {
    // Read all files as base64 data URLs (local operation, no network calls)
    const dataUrls = [];
    for (const file of statusFiles) {
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        if (dataUrl) dataUrls.push(dataUrl);
      } catch (e) {
        console.warn('[bg-upload] failed to read file (skipping):', e);
      }
    }
    if (dataUrls.length === 0) {
      console.warn('[bg-upload] no readable files — aborting patch for', backendId);
      return;
    }

    // Single PATCH: backend uploads base64 → GCS and saves URLs to Neon atomically.
    // Retry up to 3 times in case of transient network errors.
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await window.dataSdk.update({
        __backendId: backendId,
        statusImages: JSON.stringify(dataUrls),
        updatedAt: new Date().toISOString(),
      });
      if (result && result.isOk) {
        console.log('[bg-upload] status images patched OK for', backendId,
          '(' + dataUrls.length + ' image(s), attempt ' + attempt + ')');
        return;
      }
      if (attempt < MAX_RETRIES) {
        console.warn('[bg-upload] patch attempt', attempt, 'failed — retrying...');
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
    console.warn('[bg-upload] all', MAX_RETRIES, 'patch attempts failed for', backendId);
  } catch (e) {
    console.warn('[bg-upload] failed (non-fatal):', e);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

function viewLastCreatedRequest() {
  if (typeof closeConfirmSuccessModal === 'function') closeConfirmSuccessModal();
  else { try { document.getElementById('confirmModal').classList.add('hidden'); } catch (e) {} }
  try {
    if (typeof lastCreatedRequestId !== 'undefined' && lastCreatedRequestId) {
      showRequestDetail(lastCreatedRequestId);
    } else if (typeof currentDetailRequest !== 'undefined' && currentDetailRequest && currentDetailRequest.__backendId) {
      showRequestDetail(currentDetailRequest.__backendId);
    } else {
      showToast('Không tìm thấy yêu cầu để xem chi tiết');
    }
  } catch (e) { showToast('Không thể mở chi tiết yêu cầu'); }
}

// ── Modal actions ─────────────────────────────────────────────────────

function createAnotherRequest() {
  if (typeof closeConfirmSuccessModal === 'function') closeConfirmSuccessModal();
  else { try { document.getElementById('confirmModal').classList.add('hidden'); } catch (e) {} }
  if (lastRequestType === 'new') {
    resetNewRequestForm();
    switchTab(1);
  } else {
    resetWarrantyForm();
    switchWarrantyTab(1);
  }
}

function goHomeFromModal() {
  if (typeof closeConfirmSuccessModal === 'function') closeConfirmSuccessModal();
  else { try { document.getElementById('confirmModal').classList.add('hidden'); } catch (e) {} }
  goHome();
}

// ── Form reset ────────────────────────────────────────────────────────

function resetNewRequestForm() {
  clearNewRequestFieldErrors();
  document.getElementById('outletCode').value = '';
  document.getElementById('outletName').value = '';
  document.getElementById('address').value = '';
  document.getElementById('phone').value = '';
  document.getElementById('signContent').value = '';
  currentRequestItems = [];
  addRequestItem();
  isOldContent = false;
  statusImages.forEach(url => { try { URL.revokeObjectURL(url); } catch (e) {} });
  statusImages = [];
  _statusImageFiles = [];
  document.getElementById('oldContentToggle').className = 'toggle-switch bg-gray-300 rounded-full p-0.5 relative';
  document.getElementById('newContentSection').classList.remove('hidden');
  try { const e = document.getElementById('oldContentExtra'); if (e) e.value = ''; } catch (e) {}
  document.getElementById('oldContentSection').classList.add('hidden');
  document.getElementById('statusImagesPreview').innerHTML = '';
  document.getElementById('outletLat').value = '';
  document.getElementById('outletLng').value = '';
  try {
    const locSourceEl = document.getElementById('locationSource');
    if (locSourceEl) locSourceEl.value = 'manual';
    const locContainer = document.getElementById('outletLocationContainer');
    if (locContainer) locContainer.classList.add('hidden');
  } catch (e) {}
  try { if (typeof clearLocationPreview === 'function') clearLocationPreview(); else document.getElementById('locationPreview').textContent = 'Chưa có vị trí'; } catch (e) {}
  // ensure quick-fill UI is in initial (expanded) state
  try { if (typeof updateQuickFillCollapsed === 'function') updateQuickFillCollapsed(); } catch (e) {}
  // reset New Outlet toggle and related UI (ensure it is OFF)
  try {
    const nt = document.getElementById('newOutletToggle');
    const input = document.getElementById('outletCode');
    const pasteBtn = document.getElementById('outletPasteBtn');
    const lockIcon = document.getElementById('outletLockIcon');
    if (nt) {
      nt.className = 'toggle-switch bg-gray-300 rounded-full p-0.5 relative';
    }
    if (input) {
      try { input.readOnly = false; input.classList.remove('input-locked'); } catch (e) {}
      input.value = '';
    }
    if (pasteBtn) pasteBtn.style.display = '';
    if (lockIcon) lockIcon.style.display = 'none';
  } catch (e) {}
  try { localStorage.removeItem(OUTLET_DRAFT_KEY); } catch (e) {}
  // Always re-enable the submit button so a fresh form is ready for input.
  try {
    const sb = document.getElementById('submitNewBtn');
    if (sb) { sb.disabled = false; sb.textContent = 'Xác nhận yêu cầu'; }
  } catch (e) {}
  switchTab(1);
  try { if (typeof updateNewRequestHeaderOutletName === 'function') updateNewRequestHeaderOutletName(); } catch (e) {}
}

// Return true when we have at least one signage-related item
function hasSignageItems() {
  try {
    return Array.isArray(currentRequestItems) && currentRequestItems.some(i => {
      const t = String((i && i.type) || '').toLowerCase();
      return t.includes('bảng') || t.includes('hộp đèn') || t.includes('mái che') || t.includes('mai che') || t.includes('mái hiên') || t.includes('mai hien') || t.includes('rèm') || t.includes('rem');
    });
  } catch (e) { return false; }
}

// ── Duplicate outlet detection & handlers ───────────────────────────
function checkOutletDuplicate() {
  const codeEl = document.getElementById('outletCode');
  if (!codeEl) return;
  const code = (codeEl.value || '').trim();
  // reset when empty or changed
  if (!code) {
    duplicateOutletState = null;
    userConfirmedNewForOutlet = false;
    otherOutletState = null;
    userConfirmedTakeover = false;
    return;
  }
  // Only check duplicates for real outlet codes (exactly 8 digits).
  // If user selected 'New Outlet' we don't warn until they provide a real code.
  try {
    if (code === 'New Outlet') {
      duplicateOutletState = null;
      userConfirmedNewForOutlet = false;
      return;
    }
    if (!/^\d{8}$/.test(code)) {
      // not a full code yet — clear state and don't show modal
      duplicateOutletState = null;
      userConfirmedNewForOutlet = false;
      return;
    }
    // If the user already confirmed "Hạng mục mới" for this outlet, and
    // the code hasn't changed, keep that confirmation and skip re-showing the modal.
    if (userConfirmedNewForOutlet && duplicateOutletState && duplicateOutletState.outletCode === code) {
      return;
    }
    // Similarly, if user already confirmed takeover for this outlet, skip re-check.
    if (userConfirmedTakeover && otherOutletState && otherOutletState.outletCode === code) {
      return;
    }

    // Only consider requests that belong to the current session (same logic as list rendering)
    function isOwnedByCurrentSession(r) {
      try {
        const reqOwner = JSON.parse(r.requester || '{}');
        if (!currentSession || !currentSession.saleCode) return false;
        return (reqOwner.saleCode && reqOwner.saleCode === currentSession.saleCode);
      } catch (e) { return false; }
    }

    const matches = (allRequests || [])
      .filter(r => (r.type === 'new') && ((r.outletCode || '').toString().toLowerCase() === code.toLowerCase()) && isOwnedByCurrentSession(r))
      .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (matches && matches.length > 0) {
      const mostRecent = matches[0];
      // Always update state and show modal so user is warned each time they enter a duplicated code
      duplicateOutletState = { outletCode: code, existingRequest: mostRecent, existingRequests: matches };
      userConfirmedNewForOutlet = false;
      // Clear other-outlet state since own match takes priority
      otherOutletState = null;
      userConfirmedTakeover = false;
      showDuplicateOutletModal(matches);
    } else {
      duplicateOutletState = null;
      userConfirmedNewForOutlet = false;
      // No own requests — check if another sale created this outlet in the current year
      const currentYear = new Date().getFullYear();
      const otherMatches = (allRequests || []).filter(r => {
        if (r.type !== 'new') return false;
        if ((r.outletCode || '').toString().toLowerCase() !== code.toLowerCase()) return false;
        try {
          const reqOwner = JSON.parse(r.requester || '{}');
          if (!reqOwner.saleCode) return false;
          if (currentSession && currentSession.saleCode && reqOwner.saleCode === currentSession.saleCode) return false;
          return true;
        } catch (e) { return false; }
      }).filter(r => {
        try { return new Date(r.createdAt).getFullYear() === currentYear; } catch (e) { return false; }
      }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      if (otherMatches.length > 0) {
        otherOutletState = { outletCode: code, matches: otherMatches };
        userConfirmedTakeover = false;
        showOtherOutletModal(otherMatches);
      } else {
        otherOutletState = null;
        userConfirmedTakeover = false;
      }
    }
  } catch (e) {}
}

async function pasteToOutletCode() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      showToast('Trình duyệt không hỗ trợ clipboard API');
      return;
    }
    const text = (await navigator.clipboard.readText()) || '';
    const el = document.getElementById('outletCode');
    if (el) {
      const trimmed = (text || '').toString().trim();
      // Only accept exactly 8 digits; reject anything with letters or wrong length
      if (!/^\d{8}$/.test(trimmed)) {
        showToast('Nội dung dán không hợp lệ — mã outlet phải là 8 chữ số');
        return;
      }
      el.value = trimmed;
      try { sanitizeOutletCodeInput(el); } catch (e) { try { checkOutletDuplicate(); } catch (e) {} }
      showToast('Đã dán');
    }
  } catch (e) {
    showToast('Không thể dán — cho phép quyền clipboard trong trình duyệt');
  }
}

function toggleNewOutlet() {
  try {
    const btn = document.getElementById('newOutletToggle');
    const input = document.getElementById('outletCode');
    const pasteBtn = document.getElementById('outletPasteBtn');
    const lockIcon = document.getElementById('outletLockIcon');
    if (!btn || !input) return;
    // toggle visual classes
    const isOn = btn.classList.contains('toggle-on');
    if (isOn) {
      btn.classList.remove('toggle-on');
      btn.classList.remove('bg-gray-900');
      btn.classList.add('bg-gray-300');
      window.isOutletLockedLocation = false;
      // if it was set by toggle, clear it
      if ((input.value || '').trim() === 'New Outlet') input.value = '';
      // unlock input: remove visual locked class and re-enable paste button
      try { input.readOnly = false; input.classList.remove('input-locked'); input.onclick = null; } catch (e) {}
      if (pasteBtn) pasteBtn.style.display = '';
      if (lockIcon) lockIcon.style.display = 'none';
    } else {
      btn.classList.add('toggle-on');
      btn.classList.remove('bg-gray-300');
      btn.classList.add('bg-gray-900');
      input.value = 'New Outlet';
      // lock input: add visual locked class and hide paste
      try {
        input.readOnly = true;
        input.classList.add('input-locked');
        input.onclick = function () { showToast('Không thể thay đổi trường này khi bật New Outlet. Vui lòng tắt New Outlet để nhập giá trị khác.'); };
      } catch (e) {}
      if (pasteBtn) pasteBtn.style.display = 'none';
      if (lockIcon) lockIcon.style.display = 'flex';
    }
    try { checkOutletDuplicate(); } catch (e) {}
  } catch (e) {}
}

function showDuplicateOutletModal(existingOrArray) {
  try { blurActiveInput(); } catch (e) {}
  try { enableModalBackdrop(); } catch (e) {}
  const modal = document.getElementById('duplicateOutletModal');
  const msg = document.getElementById('duplicateOutletMessage');
  if (!modal || !msg || !existingOrArray) return;
  try {
    const matches = Array.isArray(existingOrArray) ? existingOrArray : [existingOrArray];
    const count = matches.length;
    const nowYear = new Date().getFullYear();
    const matchesThisYear = matches.filter(m => {
      try { return new Date(m.createdAt).getFullYear() === nowYear; } catch (e) { return false; }
    });

    // If there are no requests in the current year but there are older requests,
    // do NOT show a warning modal — instead autofill Tab1 from the most recent previous request.
    if ((matchesThisYear.length === 0) && matches.length > 0) {
      // use the most recent overall (matches is already sorted by createdAt desc by caller)
      const mostRecent = matches[0];
      duplicateOutletState = { outletCode: (mostRecent.outletCode || '').toString(), existingRequest: mostRecent, existingRequests: matches };
      userConfirmedNewForOutlet = false;
      // autofill Tab1 fields silently
      try { fillOutletFieldsFromExisting(mostRecent); } catch (e) {}
      return;
    }

    if (matchesThisYear.length === 1) {
      const m = matchesThisYear[0];
      const t = (m && m.createdAt) ? new Date(m.createdAt).toLocaleString('vi-VN') : '';
      // show 'Vào lúc' then newline with the timestamp on next line
      try { msg.innerHTML = `Outlet này bạn đã yêu cầu vào lúc<br>${t}.`; } catch (e) { msg.textContent = `Outlet này bạn đã yêu cầu vào lúc ${t}.`; }
      // configure View button to open this specific request (label: Xem lại Yêu Cầu)
      try {
        const viewBtn = document.getElementById('dupViewBtn');
        if (viewBtn) {
          viewBtn.textContent = 'Xem lại Yêu Cầu';
          // reuse existing handler which hides modal and disables backdrop
          viewBtn.onclick = openExistingRequestFromDuplicateModal;
        }
      } catch (e) {}
      duplicateOutletState = { outletCode: (m.outletCode || '').toString(), existingRequest: m, existingRequests: matchesThisYear };
      userConfirmedNewForOutlet = false;
      modal.classList.remove('hidden');
      try { enableModalBackdrop(); } catch (e) {}
      return;
    }

    // 2 or more requests in current year — show count message and link to list
    if (matchesThisYear.length >= 2) {
      msg.textContent = `Bạn có ${matchesThisYear.length} yêu cầu trong năm ${nowYear}.`;
      try {
        const viewBtn = document.getElementById('dupViewBtn');
        if (viewBtn) {
          viewBtn.textContent = 'Xem danh sách';
          viewBtn.onclick = openOutletRequestListFromDuplicateModal;
        }
      } catch (e) {}
      // store most recent of this year as existingRequest for fallback open
      const mostRecentThisYear = matchesThisYear[0];
      duplicateOutletState = { outletCode: (mostRecentThisYear.outletCode || '').toString(), existingRequest: mostRecentThisYear, existingRequests: matchesThisYear };
      userConfirmedNewForOutlet = false;
      modal.classList.remove('hidden');
      try { enableModalBackdrop(); } catch (e) {}
      return;
    }
  } catch (e) {
    // fallback
    msg.textContent = 'Outlet này đã có yêu cầu trước đó.';
    modal.classList.remove('hidden');
    try { enableModalBackdrop(); } catch (e) {}
  }
}

function fillOutletFieldsFromExisting(ex) {
  if (!ex) return;
  try {
    const setIf = (id, val) => { const el = document.getElementById(id); if (el) el.value = (val == null ? '' : val); };
    setIf('outletCode', ex.outletCode || '');
    setIf('outletName', ex.outletName || '');
    setIf('address', ex.address || '');
    setIf('phone', ex.phone || '');
    if (ex.outletLat) setIf('outletLat', ex.outletLat);
    if (ex.outletLng) setIf('outletLng', ex.outletLng);
    if (ex.outletLat && ex.outletLng) {
      window.isOutletLockedLocation = true;
    }
    // update location preview if possible
    try {
      if (ex.outletLat && ex.outletLng && typeof setLocationPreview === 'function') {
        setLocationPreview(ex.address || '', parseFloat(ex.outletLat), parseFloat(ex.outletLng));
      } else {
        const lp = document.getElementById('locationPreview'); if (lp) lp.textContent = 'Chưa có vị trí';
      }
    } catch (e) {}
    try { if (typeof updateNewRequestHeaderOutletName === 'function') updateNewRequestHeaderOutletName(); } catch (e) {}
  } catch (e) {}
}

function openExistingRequestFromDuplicateModal() {
  // kept for backward compatibility — open the most recent existing request
  const modal = document.getElementById('duplicateOutletModal');
  if (modal) modal.classList.add('hidden');
  try { disableModalBackdrop(); } catch (e) {}
  try {
    if (duplicateOutletState && duplicateOutletState.existingRequest) {
      const id = duplicateOutletState.existingRequest.__backendId;
      if (id) showRequestDetail(id);
      return;
    }
  } catch (e) {}
  showToast('Không tìm thấy yêu cầu để mở');
}

function openOutletRequestListFromDuplicateModal() {
  // Hide modal and open request list filtered for this outlet
  const modal = document.getElementById('duplicateOutletModal');
  if (modal) modal.classList.add('hidden');
  try { disableModalBackdrop(); } catch (e) {}
  try {
    const code = duplicateOutletState && duplicateOutletState.outletCode ? duplicateOutletState.outletCode : null;
    if (!code) { showToast('Không tìm thấy mã outlet'); return; }
    // set list tab to 'new' and set global search query, then show list
    try { currentListTab = 'new'; } catch (e) {}
    try { currentListSearchQuery = (code || '').toString().trim().toLowerCase(); } catch (e) { currentListSearchQuery = ''; }
    // update UI search input if present
    try { const si = document.getElementById('listSearchInput'); if (si) si.value = code; } catch (e) {}
    // navigate to list screen and render
    showRequestList();
  } catch (e) { showToast('Không thể mở danh sách yêu cầu'); }
}

function closeDuplicateOutletModal() {
  try {
    const modal = document.getElementById('duplicateOutletModal');
    if (modal) modal.classList.add('hidden');
    try { disableModalBackdrop(); } catch (e) {}
    // reset duplicate state
    duplicateOutletState = null;
    userConfirmedNewForOutlet = false;
    otherOutletState = null;
    userConfirmedTakeover = false;
    // clear Tab 1 fields
    window.isOutletLockedLocation = false;
    try { document.getElementById('outletCode').value = ''; } catch (e) {}
    try { document.getElementById('outletName').value = ''; } catch (e) {}
    try { document.getElementById('address').value = ''; } catch (e) {}
    try { document.getElementById('phone').value = ''; } catch (e) {}
    try { document.getElementById('outletLat').value = ''; } catch (e) {}
    try { document.getElementById('outletLng').value = ''; } catch (e) {}
    // reset location preview if present
    try { const lp = document.getElementById('locationPreview'); if (lp) lp.textContent = 'Chưa có vị trí'; } catch (e) {}
    // if New Outlet toggle is on, turn it off
    try {
      const nt = document.getElementById('newOutletToggle');
      if (nt && nt.classList.contains('toggle-on')) toggleNewOutlet();
    } catch (e) {}
    // ensure paste button visible
    try { const pb = document.getElementById('outletPasteBtn'); if (pb) pb.style.display = ''; } catch (e) {}
  } catch (e) {}
  try { if (typeof updateNewRequestHeaderOutletName === 'function') updateNewRequestHeaderOutletName(); } catch (e) {}
}

function continueWithNewOutlet() {
  const modal = document.getElementById('duplicateOutletModal');
  if (modal) modal.classList.add('hidden');
  try { disableModalBackdrop(); } catch (e) {}
  userConfirmedNewForOutlet = true;
  // Also clear any lingering other-outlet state
  otherOutletState = null;
  userConfirmedTakeover = false;
  // Fill only Tab 1 fields with the existing request's outlet info and close modal.
  try {
    if (duplicateOutletState && duplicateOutletState.existingRequest) {
      const ex = duplicateOutletState.existingRequest;
      const setIf = (id, val) => { const el = document.getElementById(id); if (el) el.value = (val == null ? '' : val); };
      setIf('outletCode', ex.outletCode || '');
      setIf('outletName', ex.outletName || '');
      setIf('address', ex.address || '');
      setIf('phone', ex.phone || '');
      if (ex.outletLat) setIf('outletLat', ex.outletLat);
      if (ex.outletLng) setIf('outletLng', ex.outletLng);
      // update location preview if possible
      try {
        if (ex.outletLat && ex.outletLng && typeof setLocationPreview === 'function') {
          setLocationPreview(ex.address || '', parseFloat(ex.outletLat), parseFloat(ex.outletLng));
        } else {
          const lp = document.getElementById('locationPreview'); if (lp) lp.textContent = 'Chưa có vị trí';
        }
      } catch (e) {}
    }
  } catch (e) {}
}

function areItemsEquivalent(a, b) {
  try {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i] || {};
      const bi = b[i] || {};
      // compare core fields
      if ((ai.type || '') !== (bi.type || '')) return false;
      if ((ai.brand || '') !== (bi.brand || '')) return false;
      if (Boolean(ai.useOldSize) !== Boolean(bi.useOldSize)) return false;
      const aw = parseFloat(ai.width || 0) || 0;
      const ah = parseFloat(ai.height || 0) || 0;
      const bw = parseFloat(bi.width || 0) || 0;
      const bh = parseFloat(bi.height || 0) || 0;
      if (Math.abs(aw - bw) > 0.0001) return false;
      if (Math.abs(ah - bh) > 0.0001) return false;
      if ((parseInt(ai.poles || 0,10) || 0) !== (parseInt(bi.poles || 0,10) || 0)) return false;
      if ((ai.action || '') !== (bi.action || '')) return false;
      if ((ai.otherContent || '') !== (bi.otherContent || '')) return false;
      if ((ai.note || '') !== (bi.note || '')) return false;
    }
    return true;
  } catch (e) { return false; }
}

function showDuplicateItemsModal() {
  try { blurActiveInput(); } catch (e) {}
  const modal = document.getElementById('duplicateItemsModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  try { enableModalBackdrop(); } catch (e) {}
}

function openExistingRequestFromDuplicateItemsModal() {
  const modal = document.getElementById('duplicateItemsModal');
  if (modal) modal.classList.add('hidden');
  try { disableModalBackdrop(); } catch (e) {}
  if (duplicateOutletState && duplicateOutletState.existingRequest) {
    const id = duplicateOutletState.existingRequest.__backendId;
    if (id) showRequestDetail(id);
  }
}

function closeDuplicateItemsModal() {
  const modal = document.getElementById('duplicateItemsModal');
  if (modal) modal.classList.add('hidden');
  try { disableModalBackdrop(); } catch (e) {}
}

// ── Other-sale outlet takeover ────────────────────────────────────────

function showOtherOutletModal(matches) {
  try { blurActiveInput(); } catch (e) {}
  const modal = document.getElementById('otherOutletModal');
  const msg = document.getElementById('otherOutletMessage');
  if (!modal || !msg || !matches || !matches.length) return;

  const nowYear = new Date().getFullYear();
  let otherName = '';
  try {
    const reqOwner = JSON.parse(matches[0].requester || '{}');
    otherName = reqOwner.saleName || reqOwner.saleCode || 'người khác';
  } catch (e) { otherName = 'người khác'; }

  if (matches.length === 1) {
    const t = matches[0].createdAt ? new Date(matches[0].createdAt).toLocaleString('vi-VN') : '';
    try {
      msg.innerHTML = `Outlet đã được tạo yêu cầu bởi <strong>${escapeHtml(otherName)}</strong> vào lúc ${t}.<br>Bạn có chắc giờ bạn sẽ quản lý Outlet này không?`;
    } catch (e) {
      msg.textContent = `Outlet đã được tạo yêu cầu bởi ${otherName} vào lúc ${t}. Bạn có chắc giờ bạn sẽ quản lý Outlet này không?`;
    }
  } else {
    try {
      msg.innerHTML = `Outlet này hiện có <strong>${matches.length}</strong> yêu cầu trong năm ${nowYear} do <strong>${escapeHtml(otherName)}</strong> yêu cầu.<br>Bạn có chắc muốn chuyển toàn bộ danh sách này để bạn quản lý không?`;
    } catch (e) {
      msg.textContent = `Outlet này hiện có ${matches.length} yêu cầu trong năm ${nowYear} do ${otherName} yêu cầu. Bạn có chắc muốn chuyển toàn bộ danh sách này để bạn quản lý không?`;
    }
  }

  modal.classList.remove('hidden');
}

async function confirmTakeoverOutlet() {
  const modal = document.getElementById('otherOutletModal');
  if (modal) modal.classList.add('hidden');

  if (!otherOutletState || !otherOutletState.matches || !currentSession) {
    userConfirmedTakeover = true;
    return;
  }

  const matches = otherOutletState.matches;
  const now = new Date().toISOString();
  const nowStr = new Date(now).toLocaleString('vi-VN');
  const newSaleName = currentSession.saleName || currentSession.saleCode || 'người mới';
  let oldSaleName = '';
  try {
    const reqOwner = JSON.parse(matches[0].requester || '{}');
    oldSaleName = reqOwner.saleName || reqOwner.saleCode || 'người cũ';
  } catch (e) { oldSaleName = 'người cũ'; }

  const autoCommentText = `Quyền quản lý outlet đã được chuyển từ ${oldSaleName} sang ${newSaleName} vào ${nowStr}.`;

  for (const req of matches) {
    let comments = [];
    try { comments = JSON.parse(req.comments || '[]'); } catch (e) { comments = []; }
    comments.push({ authorRole: 'system', authorName: 'Hệ thống', text: autoCommentText, createdAt: now });

    // CRITICAL: Build MINIMAL PATCH — exclude image fields.
    // req.statusImages/designImages may hold the list-endpoint placeholder '["..."]'
    // and must never overwrite real GCS URLs in the database.
    const updated = {
      __backendId: req.__backendId,
      requester: JSON.stringify(currentSession),
      comments: JSON.stringify(comments),
      updatedAt: now
    };

    // Merge only changed fields into local store (preserve existing image URLs)
    const idx = allRequests.findIndex(r => r.__backendId === req.__backendId);
    if (idx !== -1) Object.assign(allRequests[idx], updated);

    if (window.dataSdk && req.__backendId) {
      try { await window.dataSdk.update(updated); } catch (e) {}
    }
  }

  if (!window.dataSdk) {
    saveAllRequestsToStorage();
  }

  updateRequestCount();

  // Mark as confirmed takeover (so we don't re-prompt other-outlet checks)
  userConfirmedTakeover = true;
  // Clear otherOutletState now that takeover is applied
  otherOutletState = null;

  // Prepare duplicate state as these requests now belong to current user
  duplicateOutletState = { outletCode: (matches[0] && matches[0].outletCode) || '', existingRequest: matches[0], existingRequests: matches };

  // Auto-fill Tab 1 with the outlet's existing info (silent)
  try { fillOutletFieldsFromExisting(matches[0]); } catch (e) {}

  // Show the duplicate modal for the (now) owned requests so user can choose to view old request(s) or create a new item
  try { showDuplicateOutletModal(matches); } catch (e) {}

  const n = matches.length;
  showToast(`Đã chuyển ${n} yêu cầu về quản lý của bạn`);
}

function cancelTakeoverOutlet() {
  const modal = document.getElementById('otherOutletModal');
  if (modal) modal.classList.add('hidden');
  otherOutletState = null;
  userConfirmedTakeover = false;
  // Clear outlet code so user can try a different one
  try {
    const codeEl = document.getElementById('outletCode');
    if (codeEl && !codeEl.readOnly) codeEl.value = '';
  } catch (e) {}
}

// Update Tab 3 visibility based on whether there are signage items
function updateTab3UI() {
  const has = hasSignageItems();
  const newSection = document.getElementById('newContentSection');
  const toggleRow = (document.getElementById('oldContentToggle') || {}).parentElement;
  const quickWrapper = document.getElementById('quickFillWrapper');
  if (!newSection) return;
  if (has) {
    // If user selected to use old content, show only the upload section and keep the toggle visible
    const oldSection = document.getElementById('oldContentSection');
    if (isOldContent) {
      newSection.classList.add('hidden');
      if (oldSection) oldSection.classList.remove('hidden');
      if (toggleRow) toggleRow.classList.remove('hidden');
      if (quickWrapper) quickWrapper.classList.add('hidden');
    } else {
      // default: show new content input and quick-fill, hide old-content upload area
      newSection.classList.remove('hidden');
      if (oldSection) oldSection.classList.add('hidden');
      if (toggleRow) toggleRow.classList.remove('hidden');
      if (quickWrapper) quickWrapper.classList.remove('hidden');
      // ensure quick-fill is initialized
      try { initQuickFill(); } catch (e) {}
    }
  } else {
    // hide content input and the "use old content" toggle — user only uploads status images
    newSection.classList.add('hidden');
    if (toggleRow) toggleRow.classList.add('hidden');
    if (quickWrapper) quickWrapper.classList.add('hidden');
    // ensure form state not expecting content
    isOldContent = false;
  }
}

// ── Quick-fill samples for Tab 3 (fast content entry) ──────────────
const QUICK_SAMPLES = [
  'Tạp Hóa', 'Đại lý bia', 'Cửa hàng', 'Quán nhậu', 'Quán nhậu bình dân', 'Nhà hàng'
];

function buildQuickContent(sample) {
  const outletName = (document.getElementById('outletName') || {}).value || '';
  const address = (document.getElementById('address') || {}).value || '';
  const phone = (document.getElementById('phone') || {}).value || '';
  return `${sample}\n${outletName}\nĐC: ${address}\nĐT: ${phone}`.trim();
}

function initQuickFill() {
  const container = document.getElementById('quickSamples');
  if (!container) return;
  container.innerHTML = '';
  // If there is at least one survey item, expose the special quick option
  const hasSurvey = Array.isArray(currentRequestItems) && currentRequestItems.some(i => i && i.survey);
  if (hasSurvey) {
    const special = document.createElement('button');
    special.type = 'button';
    special.className = 'quick-sample';
    special.textContent = 'Theo khảo sát';
    special.setAttribute('data-value', '__survey__');
    special.addEventListener('click', (e) => {
      const ta = document.getElementById('signContent');
      if (!ta) return;
      ta.value = 'Theo khảo sát';
      ta.dataset.quickFilled = '1';
      updateQuickFillCollapsed(true);
    });
    container.appendChild(special);
  }

  QUICK_SAMPLES.forEach(s => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-sample';
    btn.textContent = s;
    btn.setAttribute('data-value', s);
    btn.addEventListener('click', (e) => {
      const val = e.currentTarget.getAttribute('data-value');
      const ta = document.getElementById('signContent');
      if (!ta) return;
      ta.value = buildQuickContent(val);
      // mark that this content came from quick-fill so we can show the edit hint
      ta.dataset.quickFilled = '1';
      // after filling, collapse to the compact pill
      updateQuickFillCollapsed(true);
    });
    container.appendChild(btn);
  });

  const ta = document.getElementById('signContent');
  if (ta) {
    ta.addEventListener('input', () => {
      // user-modified content — clear quick-fill mark
      if (ta.dataset && ta.dataset.quickFilled) delete ta.dataset.quickFilled;
      updateQuickFillCollapsed();
    });
  }

  const collapsed = document.getElementById('quickFillCollapsed');
  if (collapsed) {
    collapsed.addEventListener('click', () => updateQuickFillCollapsed(false));
  }

  const collapseBtn = document.getElementById('quickFillCollapseBtn');
  if (collapseBtn) collapseBtn.addEventListener('click', () => updateQuickFillCollapsed(true));

  // initialize state
  updateQuickFillCollapsed();
}

function updateQuickFillCollapsed(mode) {
  // mode === false -> force expand
  // mode === true -> force collapse
  // mode === undefined -> auto based on content
  const ta = document.getElementById('signContent');
  const collapsed = document.getElementById('quickFillCollapsed');
  const samples = document.getElementById('quickSamples');
  const collapseRow = document.getElementById('quickFillCollapseRow');
  const collapseBtn = document.getElementById('quickFillCollapseBtn');
  const note = document.getElementById('quickFillNote');
  if (!ta || !collapsed || !samples || !collapseRow || !collapseBtn || !note) return;
  const hasContent = ta.value.trim().length > 0;
  if (mode === false) {
    // explicit expand: show samples, show collapseBtn, hide collapsed pill
    samples.classList.remove('hidden');
    collapsed.classList.add('hidden');
    collapseBtn.classList.remove('hidden');
    note.classList.remove('hidden');
    return;
  }
  if (mode === true) {
    // explicit collapse: hide samples, show collapsed pill, hide collapseBtn (textarea remains visible)
    samples.classList.add('hidden');
    collapsed.classList.remove('hidden');
    collapseBtn.classList.add('hidden');
    // If content was filled by quick-fill, show an edit hint
    if (ta.dataset && ta.dataset.quickFilled) {
      note.textContent = 'Bạn có thể chỉnh sửa nội dung nếu cần';
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }
    return;
  }
  // auto mode: collapse when textarea has content, otherwise show samples
  if (hasContent) {
    samples.classList.add('hidden');
    collapsed.classList.remove('hidden');
    collapseBtn.classList.add('hidden');
    // if content exists and was quick-filled, show the edit hint; otherwise hide
    if (ta.dataset && ta.dataset.quickFilled) {
      note.textContent = 'Bạn có thể chỉnh sửa nội dung nếu cần';
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }
  } else {
    samples.classList.remove('hidden');
    collapsed.classList.add('hidden');
    collapseBtn.classList.remove('hidden');
    note.textContent = 'Chọn 1 nội dung để nhập nhanh nội dung';
    note.classList.remove('hidden');
  }
}

// Init quick-fill after DOM ready
document.addEventListener('DOMContentLoaded', () => initQuickFill());
