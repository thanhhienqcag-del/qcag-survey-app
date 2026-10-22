// ====================================================================
// js/flows/mobile-qcag-flow.js — dedicated QCAG mobile behavior layer
// Keeps existing Heineken/mobile flow intact by applying role-based overrides
// Fully synchronized with Desktop QCAG logic & counts
// 100% Flat Monochrome SVGs (No 3D emojis)
// ====================================================================
'use strict';

(function qcagMobileFlowModule() {
  var _qmFilterTab = 'processing'; // 'processing' | 'new' | 'pendingEdit' | 'warranty' | 'done'
  var _qmTypeFilter = 'all';
  var _qmStatusFilter = 'processing';
  var _qmRegionFilter = 'all';
  var _qmSearch = '';
  var _qmListDisplayLimit = 40;

  var _regionDefs = [
    { key: 'all', label: 'Tất cả khu vực', selectLabel: 'Tất cả KV', pat: /.*/ },
    { key: 's4', label: 'S4 Hậu Giang', selectLabel: 'S4 Hậu Giang', pat: /south\s*4|\bs4\b/i },
    { key: 's5', label: 'S5 Cà Mau', selectLabel: 'S5 Cà Mau', pat: /south\s*5|\bs5\b/i },
    { key: 's16', label: 'S16 An Giang', selectLabel: 'S16 An Giang', pat: /south\s*16|\bs16\b/i },
    { key: 's17', label: 'S17 Kiên Giang', selectLabel: 'S17 Kiên Giang', pat: /south\s*17|\bs17\b/i },
    { key: '24', label: '24 Kiên Giang', selectLabel: '24 Kiên Giang', pat: /south\s*24|\b24\b/i },
    { key: 's19', label: 'S19 Bạc Liêu', selectLabel: 'S19 Bạc Liêu', pat: /south\s*19|\bs19\b/i },
    { key: 'mot8', label: 'MOT8 Phú Quốc', selectLabel: 'MOT8 Phú Quốc', pat: /mon?dern\W*on\W*team\W*8|\bmot8\b|modern\W*team\W*8/i },
    { key: 'npp', label: 'NPP', selectLabel: 'NPP', isNPP: true }
  ];

  function isQcagRole() {
    return !!(typeof currentSession !== 'undefined' && currentSession && String(currentSession.role || '').toLowerCase() === 'qcag');
  }

  function isDesktopViewport() {
    return (window.innerWidth || 0) >= 1024;
  }

  function isQcagMobileMode() {
    if (!isQcagRole()) return false;
    if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) return false;
    return !isDesktopViewport();
  }

  function hideEl(el) {
    if (!el) return;
    el.classList.add('hidden');
    el.classList.remove('flex');
    el.style.display = 'none';
  }

  function _parseJson(raw, fallback) {
    try {
      return JSON.parse(raw || '');
    } catch (_) {
      return fallback;
    }
  }

  function _hasPendingEdit(req) {
    if (!req) return false;
    if (typeof qcagDesktopIsPendingEditRequest === 'function') {
      return qcagDesktopIsPendingEditRequest(req);
    }
    var comments = _parseJson(req.comments, []);
    var lastEditIdx = -1;
    var lastResolvedIdx = -1;
    comments.forEach(function(c, idx) {
      if (!c) return;
      var t = String(c.type || '').toLowerCase();
      var txt = String(c.text || '').toLowerCase();
      if (t === 'edit-request' || txt.includes('yêu cầu chỉnh sửa') || txt.includes('yeu cau chinh sua')) {
        lastEditIdx = idx;
      }
      if (t === 'edit-resolved' || txt.includes('đã xử lý') || txt.includes('da xu ly')) {
        lastResolvedIdx = idx;
      }
    });
    return lastEditIdx > lastResolvedIdx;
  }

  function _isDone(req) {
    var status = String(req && req.status || 'pending').toLowerCase();
    var isDone = status === 'done' || status === 'processed';
    var t = String(req && req.type || 'new').toLowerCase();
    var hasEditRequest = _hasPendingEdit(req);

    if (t === 'warranty') {
      return isDone && !hasEditRequest;
    }
    var designImgs = _parseJson(req && req.designImages, []);
    var hasMq = Array.isArray(designImgs) && designImgs.length > 0;
    return isDone && hasMq && !hasEditRequest;
  }

  function _statusBadge(req) {
    if (_hasPendingEdit(req)) {
      return { label: 'Cần sửa Maquette', cls: 'pending-edit' };
    }
    if (typeof qcagDesktopStatusBadge === 'function') {
      return qcagDesktopStatusBadge(req);
    }
    var type = String(req && req.type || '').toLowerCase();
    var status = String(req && req.status || 'pending').toLowerCase();
    if (type === 'warranty') {
      return (status === 'done' || status === 'processed')
        ? { label: 'Đã xử lý', cls: 'done' }
        : { label: 'Chờ kiểm tra', cls: 'processing' };
    }
    if (status === 'done' || status === 'processed') return { label: 'Hoàn thành', cls: 'done' };
    var designImgs = _parseJson(req && req.designImages, []);
    if (!designImgs || !designImgs.length) return { label: 'Chờ thiết kế', cls: 'pending-design' };
    return { label: 'Đang xử lý', cls: 'processing' };
  }

  function _calculateWaitDays(dateRef) {
    if (!dateRef) return 0;
    if (typeof qcagCalculateWaitDays === 'function') {
      return qcagCalculateWaitDays(dateRef);
    }
    var d = new Date(dateRef);
    if (isNaN(d.getTime())) return 0;
    var startOfDayRef = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var now = new Date();
    var startOfDayNow = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var diffDays = Math.round((startOfDayNow - startOfDayRef) / 86400000);
    return Math.max(0, diffDays);
  }

  function _getEditRequestDate(req) {
    if (!req) return null;
    if (typeof qcagDesktopGetEditRequestDate === 'function') {
      return qcagDesktopGetEditRequestDate(req);
    }
    if (req.editingRequestedAt) return req.editingRequestedAt;
    if (req.editRequestedAt) return req.editRequestedAt;
    var comments = _parseJson(req.comments, []);
    if (Array.isArray(comments) && comments.length > 0) {
      for (var i = comments.length - 1; i >= 0; i--) {
        var c = comments[i] || {};
        var cType = String(c.commentType || c.type || '').toLowerCase();
        if (
          cType === 'edit-request' ||
          cType === 'request-edit' ||
          cType === 'pending-edit' ||
          cType.includes('sửa') ||
          cType.includes('chỉnh sửa') ||
          c.isEditRequest === true ||
          c.edit_request === true
        ) {
          var time = c.createdAt || c.timestamp || c.time || c.date;
          if (time) return time;
        }
      }
    }
    return req.updatedAt || req.updated_at || null;
  }

  function _getWaitBadgeHtml(req) {
    var isDoneItem = _isDone(req);
    if (isDoneItem) return '';
    var isPendingEdit = _hasPendingEdit(req);
    var editDate = isPendingEdit ? _getEditRequestDate(req) : null;
    var dateRef = (isPendingEdit && editDate) ? editDate : req.createdAt;
    if (!dateRef) return '';

    var waitDays = _calculateWaitDays(dateRef);
    var waitColor = waitDays <= 1 ? 'wait-green' : waitDays <= 3 ? 'wait-orange' : 'wait-red';
    var waitLabel = waitDays === 0 ? 'Hôm nay' : (waitDays === 1 ? '1 ngày' : waitDays + ' ngày');
    var editSepHtml = isPendingEdit ? '<span class="qcag-wait-sep">|</span><span class="qcag-wait-edit-tag">Sửa</span>' : '';

    return '<span class="qcag-wait-badge ' + waitColor + '" title="' + (isPendingEdit ? 'Chờ từ lúc yêu cầu chỉnh sửa' : 'Thời gian chờ xử lý') + '">' +
      '<svg class="qcag-wait-badge-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' +
      '<span class="qcag-wait-label">' + escapeHtml(waitLabel) + '</span>' +
      editSepHtml +
    '</span>';
  }

  function _calculateCounts() {
    var rawList = (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) ? allRequests.slice() : [];

    var processingCount = 0;
    var newCount = 0;
    var warrantyCount = 0;
    var doneCount = 0;
    var pendingEditCount = 0;

    rawList.forEach(function(r) {
      var t = String(r.type || 'new').toLowerCase();
      var status = String(r.status || 'pending').toLowerCase();
      var isDone = status === 'done' || status === 'processed';
      var designImgs = _parseJson(r.designImages, []);
      var needsMq = designImgs.length === 0;
      var needsEdit = _hasPendingEdit(r);

      if (needsEdit) pendingEditCount++;

      if (t === 'new') {
        var hasDesignAwaitingConfirm = Array.isArray(designImgs) && designImgs.length > 0 && !isDone;
        if (needsEdit || needsMq || hasDesignAwaitingConfirm) {
          processingCount++;
          newCount++;
        }
        if (isDone && Array.isArray(designImgs) && designImgs.length > 0 && !needsEdit) {
          doneCount++;
        }
      } else if (t === 'warranty') {
        if (!isDone) {
          processingCount++;
          warrantyCount++;
        } else if (!needsEdit) {
          doneCount++;
        }
      } else {
        if (!isDone) {
          processingCount++;
        } else {
          doneCount++;
        }
      }
    });

    return {
      processing: processingCount, // 198
      done: doneCount,             // 3022
      newCount: newCount,          // 197
      warrantyCount: warrantyCount, // 1
      pendingEdit: pendingEditCount
    };
  }

  function _calculateRegionCounts() {
    var rawList = (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) ? allRequests.slice() : [];

    var processingItems = rawList.filter(function(r) {
      try {
        var t = String(r.type || 'new').toLowerCase();
        var status = String(r.status || 'pending').toLowerCase();
        var isDone = status === 'done' || status === 'processed';
        if (t === 'new') {
          var designImgs = _parseJson(r.designImages, []);
          var needsMq = designImgs.length === 0;
          var needsEdit = _hasPendingEdit(r);
          var hasDesignAwaitingConfirm = Array.isArray(designImgs) && designImgs.length > 0 && !isDone;
          return needsEdit || needsMq || hasDesignAwaitingConfirm;
        }
        return !isDone;
      } catch (_) { return false; }
    });

    var counts = {
      all: processingItems.length
    };

    _regionDefs.forEach(function(def) {
      if (def.key === 'all') return;
      if (def.isNPP) {
        counts[def.key] = processingItems.filter(function(r) {
          var requester = _parseJson(r.requester, {});
          return String(requester.saleType || '').toLowerCase() === 'npp' || Boolean(requester.isNPP);
        }).length;
      } else {
        counts[def.key] = processingItems.filter(function(r) {
          var requester = _parseJson(r.requester, {});
          var isNPP = String(requester.saleType || '').toLowerCase() === 'npp' || Boolean(requester.isNPP);
          if (isNPP) return false;
          var reg = String(requester.region || r.region || '');
          return def.pat && def.pat.test(reg);
        }).length;
      }
    });

    return counts;
  }

  function updateQcagHomeCounts() {
    if (!isQcagMobileMode()) return;
    var counts = _calculateCounts();
    var pEl = document.getElementById('qmHomeCount_processing');
    if (pEl) pEl.textContent = counts.processing;
    var nEl = document.getElementById('qmHomeCount_new');
    if (nEl) nEl.textContent = counts.newCount;
    var wEl = document.getElementById('qmHomeCount_warranty');
    if (wEl) wEl.textContent = counts.warrantyCount;
    var dEl = document.getElementById('qmHomeCount_done');
    if (dEl) dEl.textContent = counts.done;

    var regionCounts = _calculateRegionCounts();
    _regionDefs.forEach(function(reg) {
      var cntEl = document.getElementById('qmRegionCnt_' + reg.key);
      if (cntEl) cntEl.textContent = regionCounts[reg.key] || 0;
    });
  }

  function patchHomeForQcagMobile() {
    const home = document.getElementById('homeScreen');
    if (!home || !isQcagMobileMode()) return;

    // Hide unnecessary sections for QCAG
    const statsNew = document.getElementById('homeStatsGrid');
    if (statsNew && statsNew.parentElement) hideEl(statsNew.parentElement);

    const statWarrantyPending = document.getElementById('statWarrantyPending');
    if (statWarrantyPending) {
      let wrap = statWarrantyPending;
      for (let i = 0; i < 3 && wrap; i++) wrap = wrap.parentElement;
      if (wrap) hideEl(wrap);
    }

    const note = document.getElementById('homeLoadNote');
    hideEl(note);

    const prodApprovalBtn = document.getElementById('productionApprovalBtn');
    if (prodApprovalBtn) hideEl(prodApprovalBtn);

    const draftsBtn = document.getElementById('draftsListBtn');
    if (draftsBtn) hideEl(draftsBtn);

    const installBtn = document.getElementById('homeInstallBtn');
    if (installBtn) hideEl(installBtn);

    const newBtn = document.querySelector('#homeActions button[onclick="startNewRequest()"]');
    if (newBtn) hideEl(newBtn);

    const warrantyBtn = document.querySelector('#homeActions button[onclick="startWarrantyCheck()"]');
    if (warrantyBtn) hideEl(warrantyBtn);

    const homeActions = document.getElementById('homeActions');
    if (homeActions) hideEl(homeActions);

    // Render QCAG Mobile Metric Cards (Structure created once)
    var existingStats = document.getElementById('qcagMobileStatsBlock');
    if (!existingStats) {
      existingStats = document.createElement('div');
      existingStats.id = 'qcagMobileStatsBlock';
      existingStats.className = 'qcag-mobile-stats-grid mb-4';
      existingStats.innerHTML = [
        '<div class="qcag-stat-card" onclick="window.__qcagMobileOpenTab(\'processing\')">',
        '  <div class="qcag-stat-num" id="qmHomeCount_processing">0</div>',
        '  <div class="qcag-stat-lbl">Đang xử lý</div>',
        '</div>',
        '<div class="qcag-stat-card" onclick="window.__qcagMobileOpenTab(\'new\')">',
        '  <div class="qcag-stat-num" id="qmHomeCount_new">0</div>',
        '  <div class="qcag-stat-lbl">Yêu cầu mới</div>',
        '</div>',
        '<div class="qcag-stat-card" onclick="window.__qcagMobileOpenTab(\'warranty\')">',
        '  <div class="qcag-stat-num" id="qmHomeCount_warranty">0</div>',
        '  <div class="qcag-stat-lbl">Bảo hành</div>',
        '</div>',
        '<div class="qcag-stat-card" onclick="window.__qcagMobileOpenTab(\'done\')">',
        '  <div class="qcag-stat-num" id="qmHomeCount_done">0</div>',
        '  <div class="qcag-stat-lbl">Hoàn thành</div>',
        '</div>'
      ].join('');
      var wrapper = home.querySelector('.hk-home-desktop-wrapper');
      if (wrapper) wrapper.appendChild(existingStats);
    }

    // Render QCAG Region Filter Section with | divider (Structure created once)
    var existingRegionSection = document.getElementById('qcagMobileRegionBlock');
    if (!existingRegionSection) {
      existingRegionSection = document.createElement('div');
      existingRegionSection.id = 'qcagMobileRegionBlock';
      existingRegionSection.className = 'qcag-mobile-region-section w-full max-w-xs lg:max-w-none mt-1 mb-4';
      existingRegionSection.innerHTML = [
        '<div class="qcag-region-header mb-2.5 flex items-center justify-between px-1">',
        '  <span class="text-[11px] font-bold text-slate-400 tracking-wider uppercase">LỌC THEO KHU VỰC</span>',
        '  <span class="text-[11px] text-slate-400">Đang xử lý</span>',
        '</div>',
        '<div class="qcag-region-grid">',
        _regionDefs.map(function(reg) {
          var isAll = reg.key === 'all';
          return [
            '<button type="button" class="qcag-region-card ' + (isAll ? 'col-span-2 is-all' : '') + '" onclick="window.__qcagMobileOpenRegionFilter(\'' + reg.key + '\')">',
            '  <span class="qcag-region-title truncate">' + escapeHtml(reg.label) + '</span>',
            '  <span class="qcag-region-sep">|</span>',
            '  <span class="qcag-region-cnt" id="qmRegionCnt_' + reg.key + '">0</span>',
            '</button>'
          ].join('');
        }).join(''),
        '</div>'
      ].join('');
      var wrapper = home.querySelector('.hk-home-desktop-wrapper');
      if (wrapper) wrapper.appendChild(existingRegionSection);
    }

    // Update real counts into DOM without full re-render
    updateQcagHomeCounts();

    const appTitle = document.querySelector('#homeScreen h1.text-sm');
    if (appTitle) appTitle.textContent = 'QCAG MOBILE — QUẢN LÝ KHẢO SÁT';
  }

  window.__qcagMobileOpenTab = function(tabKey) {
    _qmFilterTab = tabKey;
    _qmListDisplayLimit = 40;
    if (tabKey === 'processing') {
      _qmStatusFilter = 'processing';
      _qmTypeFilter = 'all';
    } else if (tabKey === 'new') {
      _qmStatusFilter = 'processing';
      _qmTypeFilter = 'new';
    } else if (tabKey === 'pendingEdit') {
      _qmStatusFilter = 'pendingEdit';
      _qmTypeFilter = 'all';
    } else if (tabKey === 'warranty') {
      _qmStatusFilter = 'processing';
      _qmTypeFilter = 'warranty';
    } else if (tabKey === 'done') {
      _qmStatusFilter = 'done';
      _qmTypeFilter = 'all';
    }
    _qmRegionFilter = 'all';
    showRequestList();
  };

  window.__qcagMobileOpenRegionFilter = function(regionKey) {
    _qmRegionFilter = regionKey;
    _qmListDisplayLimit = 40;
    _qmStatusFilter = 'processing';
    _qmTypeFilter = 'all';
    _qmFilterTab = 'processing';
    showRequestList();
  };

  function _getVisibleRequests() {
    var list = (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) ? allRequests.slice() : [];

    // Filter by Region
    if (_qmRegionFilter && _qmRegionFilter !== 'all') {
      var regDef = _regionDefs.find(function(r) { return r.key === _qmRegionFilter; });
      if (regDef) {
        if (regDef.isNPP) {
          list = list.filter(function(r) {
            var requester = _parseJson(r.requester, {});
            return String(requester.saleType || '').toLowerCase() === 'npp' || Boolean(requester.isNPP);
          });
        } else if (regDef.pat) {
          list = list.filter(function(r) {
            var requester = _parseJson(r.requester, {});
            var isNPP = String(requester.saleType || '').toLowerCase() === 'npp' || Boolean(requester.isNPP);
            if (isNPP) return false;
            var reg = String(requester.region || r.region || '');
            return regDef.pat.test(reg);
          });
        }
      }
    }

    // Filter by tab / type & status matching Desktop QCAG exactly
    if (!_qmSearch) {
      if (_qmFilterTab === 'new' || _qmTypeFilter === 'new') {
        list = list.filter(function(r) {
          var t = String(r.type || '').toLowerCase();
          if (t !== 'new') return false;
          if (_qmStatusFilter === 'done') return _isDone(r);
          var status = String(r.status || 'pending').toLowerCase();
          var isDone = status === 'done' || status === 'processed';
          var designImgs = _parseJson(r.designImages, []);
          var needsMq = designImgs.length === 0;
          var needsEdit = _hasPendingEdit(r);
          var hasDesignAwaitingConfirm = Array.isArray(designImgs) && designImgs.length > 0 && !isDone;
          return needsEdit || needsMq || hasDesignAwaitingConfirm;
        });
      } else if (_qmFilterTab === 'warranty' || _qmTypeFilter === 'warranty') {
        list = list.filter(function(r) {
          var t = String(r.type || '').toLowerCase();
          if (t !== 'warranty') return false;
          if (_qmStatusFilter === 'done') return _isDone(r);
          var status = String(r.status || 'pending').toLowerCase();
          var isDone = status === 'done' || status === 'processed';
          return !isDone;
        });
      } else if (_qmFilterTab === 'pendingEdit' || _qmStatusFilter === 'pendingEdit') {
        list = list.filter(_hasPendingEdit);
      } else if (_qmFilterTab === 'done' || _qmStatusFilter === 'done') {
        list = list.filter(_isDone);
      } else {
        // processing (all)
        list = list.filter(function(r) { return !_isDone(r); });
      }
    }

    if (_qmSearch) {
      var q = _qmSearch.trim().toLowerCase();
      list = list.filter(function (r) {
        var requester = _parseJson(r.requester, {});
        return String(r.tkCode || '').toLowerCase().includes(q) ||
          String(requester.saleName || requester.saleCode || requester.phone || '').toLowerCase().includes(q) ||
          String(requester.ssName || '').toLowerCase().includes(q) ||
          String(r.outletCode || '').toLowerCase().includes(q) ||
          String(r.outletName || '').toLowerCase().includes(q) ||
          String(r.designFilename || '').toLowerCase().includes(q);
      });
    }

    list.sort(function (a, b) {
      var aEdit = _hasPendingEdit(a) ? 1 : 0;
      var bEdit = _hasPendingEdit(b) ? 1 : 0;
      if (aEdit !== bEdit) return bEdit - aEdit;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });

    return list;
  }

  function _ensureQcagListToolbar() {
    var listScreen = document.getElementById('listScreen');
    if (!listScreen) return null;

    var oldSearchBar = listScreen.querySelector('.px-4.py-2.border-b.border-gray-100.bg-gray-50');
    hideEl(oldSearchBar);
    hideEl(document.getElementById('designFilterBanner'));
    hideEl(document.getElementById('listTab1Btn') && document.getElementById('listTab1Btn').parentElement);

    var existing = document.getElementById('qcagMobileListToolbar');
    if (existing) return existing;

    var container = document.createElement('div');
    container.id = 'qcagMobileListToolbar';
    container.className = 'qcag-mobile-list-toolbar';
    container.innerHTML = [
      '<!-- Row 1: Compact 5-Tab Grid (Fits 100% on screen) -->',
      '<div class="qcag-compact-tabs">',
      '  <button id="qmTabProcessing" class="qm-tab-chip active" type="button" data-tab="processing">Đang xử lý</button>',
      '  <button id="qmTabNew" class="qm-tab-chip" type="button" data-tab="new">Y/c mới</button>',
      '  <button id="qmTabEdit" class="qm-tab-chip" type="button" data-tab="pendingEdit">Cần sửa</button>',
      '  <button id="qmTabWarranty" class="qm-tab-chip" type="button" data-tab="warranty">Bảo hành</button>',
      '  <button id="qmTabDone" class="qm-tab-chip" type="button" data-tab="done">Hoàn tất</button>',
      '</div>',
      '<!-- Row 2: Compact Region Dropdown + Search Box -->',
      '<div class="qcag-compact-controls">',
      '  <div class="qcag-region-select-wrap" id="qmRegionWrap">',
      '    <select id="qmRegionSelect" class="hidden" style="display:none">',
      _regionDefs.map(function(reg) {
        return '<option value="' + reg.key + '">' + escapeHtml(reg.selectLabel || reg.label) + '</option>';
      }).join(''),
      '    </select>',
      '    <button type="button" id="qmRegionTrigger" class="qm-compact-select-btn" aria-expanded="false">',
      '      <span id="qmRegionLabel" class="qm-select-label truncate">Tất cả KV</span>',
      '      <svg class="qm-select-arrow" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M19 9l-7 7-7-7"/></svg>',
      '    </button>',
      '    <div id="qmRegionDropdownMenu" class="qm-region-dropdown-menu hidden" role="listbox">',
      _regionDefs.map(function(reg) {
        return '<div class="qm-region-option ' + (reg.key === 'all' ? 'active' : '') + '" data-value="' + reg.key + '">' + escapeHtml(reg.selectLabel || reg.label) + '</div>';
      }).join(''),
      '    </div>',
      '  </div>',
      '  <div class="qcag-search-wrap">',
      '    <svg class="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>',
      '    <input id="qmSearchInput" class="qm-compact-input" type="search" placeholder="Tìm TK, outlet, tên quán...">',
      '  </div>',
      '</div>',
      '<div id="qmListMeta" class="qm-meta-compact"></div>'
    ].join('');

    var requestListContainer = document.getElementById('requestListContainer');
    if (requestListContainer && requestListContainer.parentElement) {
      requestListContainer.parentElement.insertBefore(container, requestListContainer);
    }

    container.querySelectorAll('.qm-tab-chip').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tabKey = btn.getAttribute('data-tab');
        window.__qcagMobileOpenTab(tabKey);
      });
    });

    var trigger = container.querySelector('#qmRegionTrigger');
    var menu = container.querySelector('#qmRegionDropdownMenu');
    var regSelect = container.querySelector('#qmRegionSelect');

    function toggleMenu(show) {
      if (!menu || !trigger) return;
      var open = (typeof show === 'boolean') ? show : menu.classList.contains('hidden');
      if (open) {
        menu.classList.remove('hidden');
        trigger.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
      } else {
        menu.classList.add('hidden');
        trigger.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    }

    if (trigger) {
      trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleMenu();
      });
    }

    if (menu) {
      menu.querySelectorAll('.qm-region-option').forEach(function(opt) {
        opt.addEventListener('click', function(e) {
          e.stopPropagation();
          var val = opt.getAttribute('data-value') || 'all';
          _qmRegionFilter = val;
          if (regSelect) regSelect.value = val;
          toggleMenu(false);
          renderQcagMobileList();
        });
      });
    }

    document.addEventListener('click', function(e) {
      var wrap = document.getElementById('qmRegionWrap');
      if (wrap && !wrap.contains(e.target)) {
        toggleMenu(false);
      }
    });

    var searchDebounceTimer = null;
    container.querySelector('#qmSearchInput').addEventListener('input', function (e) {
      _qmSearch = String((e && e.target && e.target.value) || '').trim().toLowerCase();
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(function() {
        _qmListDisplayLimit = 40;
        renderQcagMobileList();
      }, 180);
    });

    return container;
  }

  function renderQcagMobileList() {
    if (!isQcagMobileMode()) return;

    var toolbar = _ensureQcagListToolbar();
    var listEl = document.getElementById('requestList');
    var emptyEl = document.getElementById('emptyState');
    if (!toolbar || !listEl || !emptyEl) return;

    toolbar.querySelectorAll('.qm-tab-chip').forEach(function(btn) {
      var tabKey = btn.getAttribute('data-tab');
      btn.classList.toggle('active', tabKey === _qmFilterTab);
    });

    var regSelect = document.getElementById('qmRegionSelect');
    if (regSelect) regSelect.value = _qmRegionFilter || 'all';

    var currentDef = _regionDefs.find(function(r) { return r.key === (_qmRegionFilter || 'all'); });
    var regLabel = document.getElementById('qmRegionLabel');
    if (regLabel && currentDef) {
      regLabel.textContent = currentDef.selectLabel || currentDef.label;
    }

    var menu = document.getElementById('qmRegionDropdownMenu');
    if (menu) {
      menu.querySelectorAll('.qm-region-option').forEach(function(opt) {
        opt.classList.toggle('active', opt.getAttribute('data-value') === (_qmRegionFilter || 'all'));
      });
    }

    var rows = _getVisibleRequests();
    var meta = document.getElementById('qmListMeta');
    var activeRegLabel = (_regionDefs.find(function(r) { return r.key === _qmRegionFilter; }) || {}).label || 'Tất cả';
    if (meta) meta.textContent = 'Hiển thị: ' + rows.length + ' yêu cầu · ' + activeRegLabel;

    if (!rows.length) {
      emptyEl.classList.remove('hidden');
      listEl.innerHTML = '';
      return;
    }

    emptyEl.classList.add('hidden');
    listEl.className = 'space-y-3';

    var limit = _qmListDisplayLimit || 40;
    var displayRows = rows.slice(0, limit);
    var hasMore = rows.length > limit;

    var cardsHtml = displayRows.map(function (r) {
      var dateStr = r.createdAt ? new Date(r.createdAt).toLocaleString('vi-VN') : '-';
      var badge = _statusBadge(r);
      var waitBadgeHtml = _getWaitBadgeHtml(r);
      var outletName = (r.outletName || '-').toString().toUpperCase();
      var code = r.tkCode || '-';
      var outletCode = r.outletCode || '-';
      var address = r.address || '';
      var reqInfo = _parseJson(r.requester, {});
      var region = reqInfo.region || r.region || '';
      var saleName = (reqInfo.saleName || reqInfo.name || reqInfo.phone || '-').toString().toUpperCase();
      var salePhone = reqInfo.phone || r.phone || '';
      var ssName = reqInfo.ssName ? String(reqInfo.ssName).toUpperCase() : (reqInfo.isTBA ? 'TBA' : '-');

      return [
        '<div class="qcag-mobile-card" onclick="showRequestDetail(\'' + String(r.__backendId || '').replace(/'/g, '&#39;') + '\')">',
        '  <div class="qcag-mobile-card-head">',
        '    <div class="qcag-mobile-outlet truncate mr-2">' + escapeHtml(outletName) + '</div>',
        '    <span class="qcag-mobile-badge ' + escapeHtml(badge.cls || '') + '">' + escapeHtml(badge.label || '-') + '</span>',
        '  </div>',
        '  <div class="qcag-mobile-code-row">Mã TK: <strong>' + escapeHtml(code) + '</strong> · Outlet: <strong>' + escapeHtml(outletCode) + '</strong>' + (region ? ' · <span class="text-slate-400">' + escapeHtml(region) + '</span>' : '') + '</div>',
        '  <div class="qcag-mobile-person-block text-xs mt-1.5 pt-1.5 border-t border-slate-700/50 space-y-0.5">',
        '    <div class="truncate text-slate-300"><span class="text-slate-400">Sale:</span> <strong class="text-slate-100">' + escapeHtml(saleName) + '</strong>' + (salePhone ? ' <span class="text-slate-400 text-[11px]">(' + escapeHtml(salePhone) + ')</span>' : '') + '</div>',
        '    <div class="truncate text-slate-300"><span class="text-slate-400">SS/SE:</span> <strong class="text-slate-100">' + escapeHtml(ssName) + '</strong></div>',
        '  </div>',
        (address ? '  <div class="qcag-mobile-addr-row text-xs text-slate-400 mt-1 truncate flex items-center gap-1.5"><svg class="w-3 h-3 text-slate-400 flex-shrink-0 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg><span>' + escapeHtml(address) + '</span></div>' : ''),
        '  <div class="qcag-mobile-footer-row flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-slate-700/40">',
        '    <div class="qcag-mobile-time flex items-center gap-1.5 text-slate-400 text-[11px]"><svg class="w-3 h-3 text-slate-400 flex-shrink-0 -mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span>' + escapeHtml(dateStr) + '</span></div>',
        '    <div class="flex-shrink-0">' + waitBadgeHtml + '</div>',
        '  </div>',
        '</div>'
      ].join('');
    }).join('');

    if (hasMore) {
      cardsHtml += [
        '<div class="pt-3 pb-8 text-center">',
        '  <button type="button" id="qmLoadMoreBtn" class="px-5 py-2.5 text-xs font-semibold rounded-xl bg-slate-800 text-slate-200 border border-slate-700 shadow-md hover:bg-slate-700 active:scale-95 transition-all">',
        '    Xem thêm (' + (rows.length - limit) + ' yêu cầu còn lại)',
        '  </button>',
        '</div>'
      ].join('');
    }

    listEl.innerHTML = cardsHtml;

    var loadMoreBtn = document.getElementById('qmLoadMoreBtn');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', function() {
        _qmListDisplayLimit = (_qmListDisplayLimit || 40) + 40;
        renderQcagMobileList();
      });
    }

    var pEl = document.getElementById('requestListPagination');
    if (pEl) pEl.innerHTML = '';
  }

  function renderQcagMobileNotifications() {
    if (!isQcagMobileMode()) return;
    var list = document.getElementById('notificationsList');
    var empty = document.getElementById('notificationsEmpty');
    if (!list || !empty) return;

    var notifications = [];
    (Array.isArray(allRequests) ? allRequests : []).forEach(function (req) {
      var comments = _parseJson(req.comments, []);
      comments.forEach(function (comment) {
        if (!comment || !comment.text) return;
        var role = String(comment.authorRole || '').toLowerCase();
        if (role === 'qcag' || role === 'system') return;
        var isEditReq = String(comment.type || '').toLowerCase() === 'edit-request' ||
                        String(comment.text || '').toLowerCase().includes('yêu cầu chỉnh sửa');
        notifications.push({
          requestId: req.__backendId,
          outletName: req.outletName || '-',
          outletCode: req.outletCode || '-',
          tkCode: req.tkCode || '-',
          text: String(comment.text || '').trim(),
          isEditReq: isEditReq,
          createdAt: comment.createdAt || req.updatedAt || req.createdAt
        });
      });
    });

    notifications.sort(function (a, b) {
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });

    if (!notifications.length) {
      empty.classList.remove('hidden');
      list.innerHTML = '';
      return;
    }

    empty.classList.add('hidden');
    list.className = 'space-y-2.5';
    list.innerHTML = notifications.map(function (item) {
      var date = item.createdAt ? new Date(item.createdAt).toLocaleString('vi-VN') : '-';
      var badgeCls = item.isEditReq ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' : 'bg-blue-500/20 text-blue-300 border-blue-500/30';
      var badgeSvg = item.isEditReq 
        ? '<svg class="w-2.5 h-2.5 inline-block -mt-0.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>'
        : '<svg class="w-2.5 h-2.5 inline-block -mt-0.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>';
      var badgeTxt = item.isEditReq ? 'Yêu cầu sửa' : 'Phản hồi Sale';

      return [
        '<div class="qcag-notif-item rounded-xl p-3 border cursor-pointer active:scale-[0.98] transition-transform" onclick="showRequestDetail(\'' + String(item.requestId || '').replace(/'/g, '&#39;') + '\')">',
        '  <div class="flex items-center justify-between gap-2 mb-1.5">',
        '    <div class="text-sm font-bold truncate flex-1">' + escapeHtml(item.outletName) + ' <span class="text-xs font-normal opacity-75">(' + escapeHtml(item.outletCode) + ')</span></div>',
        '    <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full border ' + badgeCls + '">' + badgeSvg + badgeTxt + '</span>',
        '  </div>',
        '  <div class="text-xs text-slate-300 line-clamp-2 leading-relaxed bg-black/20 rounded p-2 mb-2">' + escapeHtml(item.text) + '</div>',
        '  <div class="flex items-center justify-between text-[11px] text-slate-400">',
        '    <span>Mã TK: <strong class="text-slate-200">' + escapeHtml(item.tkCode) + '</strong></span>',
        '    <span>' + escapeHtml(date) + '</span>',
        '  </div>',
        '</div>'
      ].join('');
    }).join('');
  }

  function patchDetailForQcagMobile() {
    const detail = document.getElementById('detailScreen');
    if (!detail || detail.classList.contains('hidden') || !isQcagMobileMode()) return;

    const editFab = document.getElementById('editRequestFab');
    hideEl(editFab);

    const deleteBtn = document.querySelector('#detailScreen button[onclick="deleteCurrentRequest()"]');
    hideEl(deleteBtn);

    const designInputs = document.querySelectorAll('#detailContent input[onchange="uploadDesign(this)"]');
    designInputs.forEach(function (inp) {
      const label = inp.closest('label');
      hideEl(label);
    });

    const acceptanceInputs = document.querySelectorAll('#detailContent input[onchange="uploadAcceptance(this)"]');
    acceptanceInputs.forEach(function (inp) {
      const label = inp.closest('label');
      hideEl(label);
    });

    var existingActions = document.getElementById('qcagMobileDetailActions');
    if (existingActions) existingActions.remove();

    if (currentDetailRequest) {
      var subEl = document.getElementById('detailHeaderSubtitle');
      if (subEl) {
        var oName = (currentDetailRequest.outletName || currentDetailRequest.name || '').toUpperCase();
        var oCode = currentDetailRequest.outletCode || currentDetailRequest.outlet_code || '';
        var tkCode = currentDetailRequest.tkCode || '';
        var subParts = [];
        if (oName) subParts.push(oName);
        if (oCode) subParts.push(oCode);
        if (tkCode) subParts.push('(' + tkCode + ')');
        subEl.textContent = subParts.join(' • ');
        subEl.classList.remove('hidden');
      }
    }
  }

  window.__qcagMobileScrollToComments = function() {
    var commentsEl = document.getElementById('detailCommentsList') || document.querySelector('.qcag-comment-timeline');
    if (commentsEl) {
      commentsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var input = document.getElementById('detailCommentInput');
      if (input) setTimeout(function() { input.focus(); }, 300);
    }
  };

  function patchAccountForQcagMobile() {
    const account = document.getElementById('accountScreen');
    if (!account || account.classList.contains('hidden') || !isQcagMobileMode()) return;

    const ssCode = document.getElementById('accountSSCode');
    const ssName = document.getElementById('accountSSName');
    const region = document.getElementById('accountRegion');
    [ssCode, ssName, region].forEach(function (el) {
      if (!el) return;
      var group = el.closest('div');
      hideEl(group);
    });
    [ssCode, ssName, region].forEach(function (el) {
      if (!el) return;
      el.disabled = true;
      el.classList.add('opacity-60');
    });
  }

  function patchSessionBarForQcagMobile() {
    const bar = document.getElementById('sessionInfoBar');
    if (!bar || !isQcagMobileMode()) return;
    const phone = (currentSession && currentSession.phone) ? currentSession.phone : '';
    const name = (currentSession && currentSession.name) ? currentSession.name : 'QCAG Admin';
    const firstChar = (name.trim().charAt(0) || 'Q').toUpperCase();

    bar.innerHTML = [
      '<div class="qcag-mobile-user-row">',
      '  <div class="qcag-mobile-avatar">' + escapeHtml(firstChar) + '</div>',
      '  <div class="qcag-mobile-user-text">',
      '    <div class="qcag-mobile-user-name-line">',
      '      <span class="qcag-mobile-user-name">' + escapeHtml(name) + '</span>',
      '      <span class="qcag-mobile-role-pill">QCAG</span>',
      '    </div>',
      (phone ? '    <div class="qcag-mobile-user-sub">' + escapeHtml(phone) + '</div>' : ''),
      '  </div>',
      '</div>'
    ].join('');
  }

  function applyQcagMobileUI() {
    const enabled = isQcagMobileMode();
    document.body.classList.toggle('qcag-mobile-mode', enabled);

    if (!enabled) return;

    patchSessionBarForQcagMobile();

    // Only update the active screen to avoid lag & DOM thrashing!
    const activeScreen = document.querySelector('.screen:not(.hidden)');
    const activeId = activeScreen ? activeScreen.id : 'homeScreen';

    if (activeId === 'homeScreen') {
      patchHomeForQcagMobile();
      updateQcagHomeCounts();
    } else if (activeId === 'listScreen') {
      renderQcagMobileList();
    } else if (activeId === 'detailScreen') {
      patchDetailForQcagMobile();
    } else if (activeId === 'accountScreen') {
      patchAccountForQcagMobile();
    }
  }

  function patchActionGuards() {
    if (typeof window.startNewRequest === 'function' && !window.__qcagMobileStartNewPatched) {
      const original = window.startNewRequest;
      window.startNewRequest = function () {
        if (isQcagMobileMode()) {
          showToast('QCAG mobile không tạo yêu cầu mới. Vui lòng vào Danh sách.');
          showRequestList();
          return;
        }
        return original.apply(this, arguments);
      };
      window.__qcagMobileStartNewPatched = true;
    }

    if (typeof window.startWarrantyCheck === 'function' && !window.__qcagMobileWarrantyPatched) {
      const original = window.startWarrantyCheck;
      window.startWarrantyCheck = function () {
        if (isQcagMobileMode()) {
          showToast('QCAG mobile không tạo bảo hành. Vui lòng xem danh sách.');
          showRequestList();
          return;
        }
        return original.apply(this, arguments);
      };
      window.__qcagMobileWarrantyPatched = true;
    }

    if (typeof window.uploadDesign === 'function' && !window.__qcagMobileUploadDesignPatched) {
      const original = window.uploadDesign;
      window.uploadDesign = function (input) {
        if (isQcagMobileMode()) {
          if (input) input.value = '';
          showToast('QCAG mobile không hỗ trợ upload Maquette thiết kế.');
          return;
        }
        return original.apply(this, arguments);
      };
      window.__qcagMobileUploadDesignPatched = true;
    }

    if (typeof window.uploadAcceptance === 'function' && !window.__qcagMobileUploadAcceptancePatched) {
      const original = window.uploadAcceptance;
      window.uploadAcceptance = function (input) {
        if (isQcagMobileMode()) {
          if (input) input.value = '';
          showToast('QCAG mobile không hỗ trợ upload nghiệm thu.');
          return;
        }
        return original.apply(this, arguments);
      };
      window.__qcagMobileUploadAcceptancePatched = true;
    }
  }

  function patchNavigationHooks() {
    if (typeof window.showScreen === 'function' && !window.__qcagMobileShowScreenPatched) {
      const original = window.showScreen;
      window.showScreen = function (screenId) {
        const ret = original.apply(this, arguments);
        setTimeout(function() {
          if (!isQcagMobileMode()) return;
          patchSessionBarForQcagMobile();
          if (screenId === 'homeScreen') {
            patchHomeForQcagMobile();
            updateQcagHomeCounts();
          } else if (screenId === 'listScreen') {
            renderQcagMobileList();
          } else if (screenId === 'detailScreen') {
            patchDetailForQcagMobile();
          } else if (screenId === 'accountScreen') {
            patchAccountForQcagMobile();
          }
        }, 0);
        return ret;
      };
      window.__qcagMobileShowScreenPatched = true;
    }

    if (typeof window.showRequestDetail === 'function' && !window.__qcagMobileDetailPatched) {
      const original = window.showRequestDetail;
      window.showRequestDetail = function () {
        const ret = original.apply(this, arguments);
        Promise.resolve(ret).finally(function () {
          setTimeout(function() {
            if (isQcagMobileMode()) patchDetailForQcagMobile();
          }, 30);
        });
        return ret;
      };
      window.__qcagMobileDetailPatched = true;
    }

    if (typeof window.showRequestList === 'function' && !window.__qcagMobileShowListPatched) {
      const original = window.showRequestList;
      window.showRequestList = function () {
        const ret = original.apply(this, arguments);
        setTimeout(function() {
          if (isQcagMobileMode()) renderQcagMobileList();
        }, 0);
        return ret;
      };
      window.__qcagMobileShowListPatched = true;
    }

    if (typeof window.renderRequestList === 'function' && !window.__qcagMobileRenderListPatched) {
      const original = window.renderRequestList;
      window.renderRequestList = function () {
        if (isQcagMobileMode()) {
          renderQcagMobileList();
          return;
        }
        return original.apply(this, arguments);
      };
      window.__qcagMobileRenderListPatched = true;
    }

    if (typeof window.renderNotifications === 'function' && !window.__qcagMobileRenderNotificationsPatched) {
      const original = window.renderNotifications;
      window.renderNotifications = function () {
        if (isQcagMobileMode()) {
          renderQcagMobileNotifications();
          return;
        }
        return original.apply(this, arguments);
      };
      window.__qcagMobileRenderNotificationsPatched = true;
    }

    if (typeof window.launchApp === 'function' && !window.__qcagMobileLaunchPatched) {
      const original = window.launchApp;
      window.launchApp = function () {
        const ret = original.apply(this, arguments);
        setTimeout(applyQcagMobileUI, 0);
        return ret;
      };
      window.__qcagMobileLaunchPatched = true;
    }

    // Hook data update functions to refresh home stats instantly when data loads
    if (typeof window.updateRequestCount === 'function' && !window.__qcagMobileUpdateCountPatched) {
      const originalUpdateCount = window.updateRequestCount;
      window.updateRequestCount = function() {
        const ret = originalUpdateCount.apply(this, arguments);
        try {
          if (isQcagMobileMode()) {
            updateQcagHomeCounts();
          }
        } catch (_) {}
        return ret;
      };
      window.__qcagMobileUpdateCountPatched = true;
    }

    if (typeof window.updateHomeStats === 'function' && !window.__qcagMobileUpdateHomeStatsPatched) {
      const originalUpdateHome = window.updateHomeStats;
      window.updateHomeStats = function() {
        const ret = originalUpdateHome.apply(this, arguments);
        try {
          if (isQcagMobileMode()) {
            updateQcagHomeCounts();
          }
        } catch (_) {}
        return ret;
      };
      window.__qcagMobileUpdateHomeStatsPatched = true;
    }
  }

  window.isQcagMobileMode = isQcagMobileMode;
  window.applyQcagMobileUI = applyQcagMobileUI;
  window.updateQcagHomeCounts = updateQcagHomeCounts;
  window.renderQcagMobileList = renderQcagMobileList;
  window.renderQcagMobileNotifications = renderQcagMobileNotifications;

  patchActionGuards();
  patchNavigationHooks();

  document.addEventListener('DOMContentLoaded', function () {
    applyQcagMobileUI();
  });

  // Proactive background updater: As soon as IDB / network data arrives, home counts reflect immediately!
  [300, 800, 1500, 3000, 6000].forEach(function(delay) {
    setTimeout(function() {
      if (isQcagMobileMode()) {
        updateQcagHomeCounts();
      }
    }, delay);
  });

  window.addEventListener('resize', function () {
    applyQcagMobileUI();
  });
})();
