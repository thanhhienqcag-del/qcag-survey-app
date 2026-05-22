// ====================================================================
// js/flows/mobile-qcag-flow.js — dedicated QCAG mobile behavior layer
// Keeps existing Heineken/mobile flow intact by applying role-based overrides
// ====================================================================
'use strict';

(function qcagMobileFlowModule() {
  var _qmTypeFilter = 'new';
  var _qmStatusFilter = 'processing';
  var _qmSearch = '';

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

  function patchHomeForQcagMobile() {
    const home = document.getElementById('homeScreen');
    if (!home) return;

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

    const newBtn = document.querySelector('#homeActions button[onclick="startNewRequest()"]');
    const warrantyBtn = document.querySelector('#homeActions button[onclick="startWarrantyCheck()"]');

    if (newBtn) {
      newBtn.classList.add('qcag-mobile-action-btn');
      newBtn.classList.remove('bg-gray-900', 'text-white');
      newBtn.classList.add('bg-blue-600', 'text-white');
      newBtn.onclick = function () { showRequestList(); };
      newBtn.innerHTML = [
        '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7h18M3 12h18M3 17h18"/></svg>',
        'Xem Danh Sách Yêu Cầu'
      ].join(' ');
    }

    if (warrantyBtn) {
      warrantyBtn.classList.add('qcag-mobile-action-btn');
      warrantyBtn.classList.remove('bg-gray-50', 'text-gray-900', 'border-2', 'border-gray-900');
      warrantyBtn.classList.add('bg-emerald-600', 'text-white', 'border', 'border-emerald-700');
      warrantyBtn.onclick = function () { showNotifications(); };
      warrantyBtn.innerHTML = [
        '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5"/></svg>',
        'Xem Thông Báo Bình Luận'
      ].join(' ');
    }

    const appTitle = document.querySelector('#homeScreen h1.text-sm');
    if (appTitle) appTitle.textContent = 'QCAG MOBILE - DANH SACH XU LY';
  }

  function _parseJson(raw, fallback) {
    try {
      return JSON.parse(raw || '');
    } catch (_) {
      return fallback;
    }
  }

  function _statusBadge(req) {
    if (typeof qcagDesktopStatusBadge === 'function') {
      return qcagDesktopStatusBadge(req);
    }
    var type = String(req && req.type || '').toLowerCase();
    var status = String(req && req.status || 'pending').toLowerCase();
    if (type === 'warranty') {
      return (status === 'done' || status === 'processed')
        ? { label: 'Da bao hanh', cls: 'done' }
        : { label: 'Cho kiem tra', cls: 'processing' };
    }
    if (status === 'done' || status === 'processed') return { label: 'Hoan thanh', cls: 'done' };
    var designImgs = _parseJson(req && req.designImages, []);
    if (!designImgs || !designImgs.length) return { label: 'Cho thiet ke', cls: 'pending-design' };
    return { label: 'Dang xu ly', cls: 'processing' };
  }

  function _isDone(req) {
    var status = String(req && req.status || 'pending').toLowerCase();
    if (String(req && req.type || '').toLowerCase() === 'warranty') {
      return status === 'done' || status === 'processed';
    }
    var hasEdit = (typeof qcagDesktopIsPendingEditRequest === 'function') ? qcagDesktopIsPendingEditRequest(req) : false;
    var designImgs = _parseJson(req && req.designImages, []);
    var hasMq = Array.isArray(designImgs) && designImgs.length > 0;
    return (status === 'done' || status === 'processed') && hasMq && !hasEdit;
  }

  function _getVisibleRequests() {
    var list = Array.isArray(allRequests) ? allRequests.slice() : [];

    list = list.filter(function (r) {
      return String(r.type || '').toLowerCase() === _qmTypeFilter;
    });

    if (_qmStatusFilter === 'done') {
      list = list.filter(_isDone);
    } else {
      list = list.filter(function (r) {
        return !_isDone(r);
      });
    }

    if (_qmSearch) {
      var q = _qmSearch;
      list = list.filter(function (r) {
        return String(r.tkCode || '').toLowerCase().includes(q) ||
          String(r.outletCode || '').toLowerCase().includes(q) ||
          String(r.outletName || '').toLowerCase().includes(q) ||
          String(r.address || '').toLowerCase().includes(q);
      });
    }

    list.sort(function (a, b) {
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
      '<div class="qcag-mobile-row">',
      '  <button id="qmTypeNew" class="qm-chip active" type="button">Yeu cau moi</button>',
      '  <button id="qmTypeWarranty" class="qm-chip" type="button">Bao hanh</button>',
      '</div>',
      '<div class="qcag-mobile-row">',
      '  <button id="qmStatusProcessing" class="qm-chip active" type="button">Dang xu ly</button>',
      '  <button id="qmStatusDone" class="qm-chip" type="button">Hoan thanh</button>',
      '</div>',
      '<div class="qcag-mobile-row">',
      '  <input id="qmSearchInput" class="qm-search" type="search" placeholder="Tim theo Ma TK, outlet code, ten outlet...">',
      '</div>',
      '<div id="qmListMeta" class="qm-meta"></div>'
    ].join('');

    var requestListContainer = document.getElementById('requestListContainer');
    if (requestListContainer && requestListContainer.parentElement) {
      requestListContainer.parentElement.insertBefore(container, requestListContainer);
    }

    container.querySelector('#qmTypeNew').addEventListener('click', function () {
      _qmTypeFilter = 'new';
      renderQcagMobileList();
    });
    container.querySelector('#qmTypeWarranty').addEventListener('click', function () {
      _qmTypeFilter = 'warranty';
      renderQcagMobileList();
    });
    container.querySelector('#qmStatusProcessing').addEventListener('click', function () {
      _qmStatusFilter = 'processing';
      renderQcagMobileList();
    });
    container.querySelector('#qmStatusDone').addEventListener('click', function () {
      _qmStatusFilter = 'done';
      renderQcagMobileList();
    });
    container.querySelector('#qmSearchInput').addEventListener('input', function (e) {
      _qmSearch = String((e && e.target && e.target.value) || '').trim().toLowerCase();
      renderQcagMobileList();
    });

    return container;
  }

  function renderQcagMobileList() {
    if (!isQcagMobileMode()) return;

    var toolbar = _ensureQcagListToolbar();
    var listEl = document.getElementById('requestList');
    var emptyEl = document.getElementById('emptyState');
    if (!toolbar || !listEl || !emptyEl) return;

    var typeNewBtn = document.getElementById('qmTypeNew');
    var typeWarrantyBtn = document.getElementById('qmTypeWarranty');
    var stProcBtn = document.getElementById('qmStatusProcessing');
    var stDoneBtn = document.getElementById('qmStatusDone');
    if (typeNewBtn) typeNewBtn.classList.toggle('active', _qmTypeFilter === 'new');
    if (typeWarrantyBtn) typeWarrantyBtn.classList.toggle('active', _qmTypeFilter === 'warranty');
    if (stProcBtn) stProcBtn.classList.toggle('active', _qmStatusFilter === 'processing');
    if (stDoneBtn) stDoneBtn.classList.toggle('active', _qmStatusFilter === 'done');

    var rows = _getVisibleRequests();
    var meta = document.getElementById('qmListMeta');
    if (meta) meta.textContent = rows.length + ' yeu cau';

    if (!rows.length) {
      emptyEl.classList.remove('hidden');
      listEl.innerHTML = '';
      return;
    }

    emptyEl.classList.add('hidden');
    listEl.className = 'space-y-3';
    listEl.innerHTML = rows.map(function (r) {
      var dateStr = r.createdAt ? new Date(r.createdAt).toLocaleString('vi-VN') : '-';
      var badge = _statusBadge(r);
      var outletName = (r.outletName || '-').toString().toUpperCase();
      var code = r.tkCode || '-';
      var outletCode = r.outletCode || '-';
      return [
        '<div class="qcag-mobile-card" onclick="showRequestDetail(\'' + String(r.__backendId || '').replace(/'/g, '&#39;') + '\')">',
        '  <div class="qcag-mobile-card-head">',
        '    <div class="qcag-mobile-outlet">' + escapeHtml(outletName) + '</div>',
        '    <span class="qcag-mobile-badge ' + escapeHtml(badge.cls || '') + '">' + escapeHtml(badge.label || '-') + '</span>',
        '  </div>',
        '  <div class="qcag-mobile-code-row">Ma TK: <strong>' + escapeHtml(code) + '</strong></div>',
        '  <div class="qcag-mobile-code-row">Outlet Code: <strong>' + escapeHtml(outletCode) + '</strong></div>',
        '  <div class="qcag-mobile-time">Thoi gian: ' + escapeHtml(dateStr) + '</div>',
        '</div>'
      ].join('');
    }).join('');

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
        notifications.push({
          requestId: req.__backendId,
          outletName: req.outletName || '-',
          outletCode: req.outletCode || '-',
          text: String(comment.text || '').trim(),
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
    list.innerHTML = notifications.map(function (item) {
      var date = item.createdAt ? new Date(item.createdAt).toLocaleString('vi-VN') : '-';
      return [
        '<div class="bg-gray-50 rounded-xl p-3 border border-gray-200 active:bg-gray-100 cursor-pointer" onclick="showRequestDetail(\'' + String(item.requestId || '').replace(/'/g, '&#39;') + '\')">',
        '  <div class="text-sm font-semibold text-gray-900 truncate">' + escapeHtml(item.outletName) + ' (' + escapeHtml(item.outletCode) + ')</div>',
        '  <div class="text-sm text-gray-600 mt-1 line-clamp-2">' + escapeHtml(item.text) + '</div>',
        '  <div class="text-xs text-gray-400 mt-2">Sale Heineken · ' + escapeHtml(date) + '</div>',
        '</div>'
      ].join('');
    }).join('');
  }

  function patchDetailForQcagMobile() {
    const detail = document.getElementById('detailScreen');
    if (!detail || detail.classList.contains('hidden')) return;

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
  }

  function patchAccountForQcagMobile() {
    const account = document.getElementById('accountScreen');
    if (!account || account.classList.contains('hidden')) return;

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
    const phone = (currentSession && currentSession.phone) ? currentSession.phone : '-';
    const name = (currentSession && currentSession.name) ? currentSession.name : 'QCAG';
    bar.innerHTML = '<div class="font-semibold text-gray-800 text-sm">' + name + ' (QCAG Mobile)</div>' +
      '<div class="text-gray-400 mt-0.5">Chi xem danh sach, chi tiet va binh luan · ' + phone + '</div>';
  }

  function applyQcagMobileUI() {
    const enabled = isQcagMobileMode();
    document.body.classList.toggle('qcag-mobile-mode', enabled);

    if (!enabled) return;

    patchSessionBarForQcagMobile();
    patchHomeForQcagMobile();
    patchDetailForQcagMobile();
    patchAccountForQcagMobile();
    renderQcagMobileList();
  }

  function patchActionGuards() {
    if (typeof window.startNewRequest === 'function' && !window.__qcagMobileStartNewPatched) {
      const original = window.startNewRequest;
      window.startNewRequest = function () {
        if (isQcagMobileMode()) {
          showToast('QCAG mobile khong tao yeu cau moi. Vui long vao Danh sach.');
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
          showToast('QCAG mobile khong tao bao hanh. Vui long xem danh sach.');
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
          showToast('QCAG mobile khong ho tro upload MQ.');
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
          showToast('QCAG mobile khong ho tro upload nghiem thu.');
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
      window.showScreen = function () {
        const ret = original.apply(this, arguments);
        setTimeout(applyQcagMobileUI, 0);
        return ret;
      };
      window.__qcagMobileShowScreenPatched = true;
    }

    if (typeof window.showRequestDetail === 'function' && !window.__qcagMobileDetailPatched) {
      const original = window.showRequestDetail;
      window.showRequestDetail = function () {
        const ret = original.apply(this, arguments);
        Promise.resolve(ret).finally(function () {
          setTimeout(applyQcagMobileUI, 30);
          setTimeout(applyQcagMobileUI, 120);
        });
        return ret;
      };
      window.__qcagMobileDetailPatched = true;
    }

    if (typeof window.showRequestList === 'function' && !window.__qcagMobileShowListPatched) {
      const original = window.showRequestList;
      window.showRequestList = function () {
        const ret = original.apply(this, arguments);
        setTimeout(renderQcagMobileList, 0);
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
  }

  window.isQcagMobileMode = isQcagMobileMode;
  window.applyQcagMobileUI = applyQcagMobileUI;
  window.renderQcagMobileList = renderQcagMobileList;
  window.renderQcagMobileNotifications = renderQcagMobileNotifications;

  patchActionGuards();
  patchNavigationHooks();

  document.addEventListener('DOMContentLoaded', function () {
    applyQcagMobileUI();
  });

  window.addEventListener('resize', function () {
    applyQcagMobileUI();
  });
})();
