// ====================================================================
// js/flows/production-confirm-flow.js — mobile production confirmation flow
// ====================================================================
'use strict';

(function productionConfirmFlowModule() {
  let _pcCurrentTab = 'pending'; // 'pending', 'accept', 'reject'
  let _pcItems = []; // fetched confirmable items
  let _rejectingItem = null; // { orderId, quoteCode } currently being rejected

  // Initialize and load confirmation data
  window.initProductionConfirmScreen = async function () {
    _pcCurrentTab = 'pending';
    _pcItems = [];
    _rejectingItem = null;
    updateTabButtonsUI();
    await fetchConfirmations();
  };

  // Switch between tabs: pending, accept, reject
  window.switchConfirmTab = function (tab) {
    _pcCurrentTab = tab;
    updateTabButtonsUI();
    renderList();
  };

  // Switch tab buttons style
  function updateTabButtonsUI() {
    const tabs = {
      pending: 'pcTabPendingBtn',
      accept: 'pcTabAcceptedBtn',
      reject: 'pcTabRejectedBtn'
    };
    Object.keys(tabs).forEach(k => {
      const btn = document.getElementById(tabs[k]);
      if (!btn) return;
      if (k === _pcCurrentTab) {
        btn.classList.add('border-amber-600', 'text-amber-600');
        btn.classList.remove('border-transparent', 'text-gray-500');
      } else {
        btn.classList.remove('border-amber-600', 'text-amber-600');
        btn.classList.add('border-transparent', 'text-gray-500');
      }
    });
  }

  // Fetch from App 2 backend
  async function fetchConfirmations() {
    const listEl = document.getElementById('productionConfirmList');
    if (listEl) {
      listEl.innerHTML = `
        <div class="flex flex-col items-center justify-center py-12 text-gray-400">
          <svg class="animate-spin -ml-1 mr-3 h-8 w-8 text-amber-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span class="text-xs mt-2">Đang tải danh sách chờ...</span>
        </div>
      `;
    }

    const phone = currentSession && currentSession.phone;
    if (!phone) {
      if (listEl) listEl.innerHTML = '<div class="p-8 text-center text-red-500 text-xs">Vui lòng đăng nhập lại để xem danh sách.</div>';
      return;
    }

    try {
      const backendBase = (window.__env && window.__env.BACKEND_URL) || 'https://ks-backend-493469512136.asia-southeast1.run.app';
      const response = await fetch(`${backendBase}/api/ks/sale-pending-confirmations?phone=${encodeURIComponent(phone)}`);
      const resJson = await response.json();

      if (resJson && resJson.ok) {
        _pcItems = resJson.data || [];
        // Update tab count badges
        const counts = { pending: 0, accept: 0, reject: 0 };
        _pcItems.forEach(item => {
          const status = item.saleConfirmStatus || 'pending';
          if (counts[status] !== undefined) counts[status]++;
        });
        
        const countPendingEl = document.getElementById('pcCountPending');
        const countAcceptedEl = document.getElementById('pcCountAccepted');
        const countRejectedEl = document.getElementById('pcCountRejected');
        
        if (countPendingEl) countPendingEl.textContent = counts.pending;
        if (countAcceptedEl) countAcceptedEl.textContent = counts.accept;
        if (countRejectedEl) countRejectedEl.textContent = counts.reject;

        // Also update home page button badge
        const badgeEl = document.getElementById('productionConfirmBadge');
        if (badgeEl) {
          badgeEl.textContent = counts.pending;
          badgeEl.classList.toggle('hidden', counts.pending === 0);
        }

        renderList();
      } else {
        if (listEl) listEl.innerHTML = '<div class="p-8 text-center text-red-500 text-xs">Lỗi tải dữ liệu từ máy chủ.</div>';
      }
    } catch (err) {
      console.error('fetchConfirmations failed:', err);
      if (listEl) listEl.innerHTML = '<div class="p-8 text-center text-red-500 text-xs">Lỗi kết nối.</div>';
    }
  }

  // Render list of items
  function renderList() {
    const listEl = document.getElementById('productionConfirmList');
    if (!listEl) return;

    const filtered = _pcItems.filter(item => {
      const s = item.saleConfirmStatus || 'pending';
      return s === _pcCurrentTab;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="flex flex-col items-center justify-center py-16 text-center">
          <span class="text-3xl">📭</span>
          <p class="text-sm font-semibold text-gray-500 mt-2">Không có điểm nào trong danh sách</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered.map(item => {
      const itemsHtml = (item.items || []).map(it => {
        const brandLabel = it.brand ? `<span class="inline-flex px-1 bg-amber-100 text-amber-800 text-[10px] font-bold rounded">${escapeHtml(it.brand)}</span>` : '';
        const sizeLabel = (it.width && it.height) ? `(${it.width} x ${it.height}m)` : '';
        return `
          <div class="flex items-start justify-between text-xs text-gray-600 border-b border-gray-100 py-1.5 last:border-b-0">
            <span>• ${escapeHtml(it.content || 'Hạng mục')} ${sizeLabel} ${brandLabel}</span>
            <span class="font-semibold text-gray-800 ml-2">x${it.quantity || 1}</span>
          </div>
        `;
      }).join('');

      // MQ design images view section
      let designImgsHtml = '';
      if (item.designImages && item.designImages.length > 0) {
        const imagesList = item.designImages.map(img => `
          <div class="relative w-16 h-16 rounded-xl overflow-hidden bg-gray-900 border border-gray-800 shadow-sm flex-shrink-0">
            <img src="${img}" class="w-full h-full object-cover cursor-pointer" onclick="showImageFull('${img.replace(/'/g, "\\'")}', false)" title="Xem ảnh lớn">
          </div>
        `).join('');
        designImgsHtml = `
          <div class="mt-3">
            <span class="text-[10px] font-bold text-gray-400 block mb-1.5 tracking-wider">MẪU THIẾT KẾ (MQ):</span>
            <div class="flex flex-wrap gap-2.5">
              ${imagesList}
            </div>
          </div>
        `;
      }

      let actionHtml = '';
      if (_pcCurrentTab === 'pending') {
        actionHtml = `
          <div class="flex items-center gap-2.5 mt-4 pt-3.5 border-t border-gray-100">
            <!-- Swipe to confirm track -->
            <div class="swipe-track flex-1 relative h-11 bg-green-50/80 border border-green-200 rounded-xl flex items-center justify-center overflow-hidden select-none" data-order-id="${item.orderId}" data-quote-code="${item.quoteCode}">
              <span class="swipe-text text-green-700 font-semibold text-[11px] pointer-events-none transition-opacity duration-200">Vuốt để đồng ý sản xuất ➜</span>
              <div class="swipe-handle absolute left-0.5 top-0.5 w-10 h-10 bg-green-600 rounded-lg flex items-center justify-center text-white cursor-pointer active:bg-green-700 shadow-md transition-shadow">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>
              </div>
            </div>
            
            <!-- Reject button -->
            <button onclick="openConfirmRejectModal('${item.orderId}', '${item.quoteCode}')" class="px-4.5 h-11 rounded-xl text-xs font-semibold text-white bg-red-600 active:bg-red-700 transition-colors flex items-center justify-center gap-1 shadow-sm">
              <span>✕</span> Từ chối
            </button>
          </div>
        `;
      } else if (_pcCurrentTab === 'accept') {
        const dateLabel = item.saleConfirmAt ? new Date(item.saleConfirmAt).toLocaleString('vi-VN') : '';
        actionHtml = `
          <div class="mt-3.5 pt-2.5 border-t border-gray-100 flex items-center justify-between text-xs">
            <span class="text-green-700 font-bold">✓ Đã đồng ý sản xuất</span>
            <span class="text-gray-400">${dateLabel}</span>
          </div>
        `;
      } else if (_pcCurrentTab === 'reject') {
        const dateLabel = item.saleConfirmAt ? new Date(item.saleConfirmAt).toLocaleString('vi-VN') : '';
        actionHtml = `
          <div class="mt-3.5 pt-2.5 border-t border-gray-100 text-xs">
            <div class="flex items-center justify-between">
              <span class="text-red-700 font-bold">✕ Đã từ chối</span>
              <span class="text-gray-400">${dateLabel}</span>
            </div>
            <div class="bg-red-50 text-red-800 rounded-lg p-2.5 mt-2 font-medium border border-red-100 italic">
              Lý do: ${escapeHtml(item.saleConfirmNote || 'Không có')}
            </div>
          </div>
        `;
      }

      const formattedAmount = typeof formatCurrency === 'function' ? formatCurrency(item.totalAmount) : (item.totalAmount + ' ₫');

      return `
        <div class="bg-white rounded-2xl p-4 border border-gray-200 shadow-sm transition-transform active:scale-[0.99]">
          <div class="flex items-center justify-between gap-3 mb-2.5">
            <span class="text-[10px] font-bold text-gray-400 tracking-wider">MÃ BÁO GIÁ: ${escapeHtml(item.quoteCode)}</span>
            <span class="text-xs font-bold text-amber-600">${formattedAmount}</span>
          </div>
          <h3 class="text-sm font-bold text-gray-900 truncate">${escapeHtml(item.outletName)}</h3>
          <p class="text-xs text-gray-500 mt-0.5 truncate">${escapeHtml(item.outletCode)} · ${escapeHtml(item.area)}</p>
          
          <div class="bg-gray-50 rounded-xl p-3.5 mt-3 space-y-1">
            ${itemsHtml}
          </div>
          
          ${designImgsHtml}
          
          ${actionHtml}
        </div>
      `;
    }).join('');

    // Bind touch/swipe handlers
    if (_pcCurrentTab === 'pending') {
      setTimeout(bindSwipeEvents, 50);
    }
  }

  // Bind Touch/Mouse events to the swipeable components
  function bindSwipeEvents() {
    const tracks = document.querySelectorAll('.swipe-track');
    tracks.forEach(track => {
      const handle = track.querySelector('.swipe-handle');
      const text = track.querySelector('.swipe-text');
      if (!handle) return;

      let isDragging = false;
      let startX = 0;
      let currentX = 0;

      // Touch events for mobile devices
      handle.addEventListener('touchstart', (e) => {
        isDragging = true;
        const touch = e.touches[0];
        const maxSlide = track.clientWidth - handle.clientWidth - 4;
        startX = touch.clientX;
        handle.style.transition = 'none';

        const onTouchMove = (moveEv) => {
          if (!isDragging) return;
          const currentTouch = moveEv.touches[0];
          const deltaX = currentTouch.clientX - startX;
          currentX = Math.max(0, Math.min(maxSlide, deltaX));
          handle.style.transform = `translateX(${currentX}px)`;
          if (text) {
            text.style.opacity = Math.max(0, 1 - (currentX / maxSlide)).toString();
          }
        };

        const onTouchEnd = () => {
          if (!isDragging) return;
          isDragging = false;

          window.removeEventListener('touchmove', onTouchMove);
          window.removeEventListener('touchend', onTouchEnd);

          if (currentX >= maxSlide * 0.85) {
            handle.style.transition = 'transform 0.15s ease-out';
            handle.style.transform = `translateX(${maxSlide}px)`;
            const orderId = track.getAttribute('data-order-id');
            const quoteCode = track.getAttribute('data-quote-code');
            confirmAcceptDirect(orderId, quoteCode);
          } else {
            handle.style.transition = 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
            handle.style.transform = 'translateX(0px)';
            currentX = 0;
            if (text) text.style.opacity = '1';
          }
        };

        window.addEventListener('touchmove', onTouchMove, { passive: false });
        window.addEventListener('touchend', onTouchEnd, { passive: true });
      }, { passive: true });

      // Mouse events for desktop/testing
      handle.addEventListener('mousedown', (e) => {
        isDragging = true;
        const maxSlide = track.clientWidth - handle.clientWidth - 4;
        startX = e.clientX;
        handle.style.transition = 'none';

        const onMouseMove = (moveEv) => {
          if (!isDragging) return;
          const deltaX = moveEv.clientX - startX;
          currentX = Math.max(0, Math.min(maxSlide, deltaX));
          handle.style.transform = `translateX(${currentX}px)`;
          if (text) {
            text.style.opacity = Math.max(0, 1 - (currentX / maxSlide)).toString();
          }
        };

        const onMouseUp = () => {
          if (!isDragging) return;
          isDragging = false;

          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);

          if (currentX >= maxSlide * 0.85) {
            handle.style.transition = 'transform 0.15s ease-out';
            handle.style.transform = `translateX(${maxSlide}px)`;
            const orderId = track.getAttribute('data-order-id');
            const quoteCode = track.getAttribute('data-quote-code');
            confirmAcceptDirect(orderId, quoteCode);
          } else {
            handle.style.transition = 'transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
            handle.style.transform = 'translateX(0px)';
            currentX = 0;
            if (text) text.style.opacity = '1';
          }
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    });
  }

  // Accept action direct (No confirm alert as requested)
  window.confirmAcceptDirect = async function (orderId, quoteCode) {
    const phone = currentSession && currentSession.phone;
    if (!phone) return;

    showLoadingOverlay('Đang lưu xác nhận...', 'Vui lòng chờ');
    try {
      const backendBase = (window.__env && window.__env.BACKEND_URL) || 'https://ks-backend-493469512136.asia-southeast1.run.app';
      const response = await fetch(`${backendBase}/api/ks/sale-pending-confirmations/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, quoteCode, status: 'accept', phone })
      });
      const resJson = await response.json();
      hideLoadingOverlay();
      if (resJson && resJson.ok) {
        showToast('✓ Đã đồng ý sản xuất thành công');
        await fetchConfirmations();
      } else {
        showToast('Lỗi lưu xác nhận');
        await fetchConfirmations();
      }
    } catch (err) {
      console.error('confirmAcceptDirect failed:', err);
      hideLoadingOverlay();
      showToast('Lỗi kết nối');
      await fetchConfirmations();
    }
  };

  // Reject modal trigger
  window.openConfirmRejectModal = function (orderId, quoteCode) {
    _rejectingItem = { orderId, quoteCode };
    const modal = document.getElementById('pcRejectModal');
    const input = document.getElementById('pcRejectInput');
    if (input) input.value = '';
    if (modal) {
      modal.classList.remove('hidden');
      setTimeout(() => { if (input) input.focus(); }, 150);
    }
  };

  window.closeConfirmRejectModal = function () {
    const modal = document.getElementById('pcRejectModal');
    if (modal) modal.classList.add('hidden');
    _rejectingItem = null;
  };

  window.submitConfirmReject = async function () {
    if (!_rejectingItem) return;
    const reason = (document.getElementById('pcRejectInput')?.value || '').trim();
    if (!reason) {
      showToast('Vui lòng nhập lý do từ chối');
      return;
    }
    const phone = currentSession && currentSession.phone;
    if (!phone) return;

    const { orderId, quoteCode } = _rejectingItem;
    closeConfirmRejectModal();

    showLoadingOverlay('Đang gửi lý do từ chối...', 'Vui lòng chờ');
    try {
      const backendBase = (window.__env && window.__env.BACKEND_URL) || 'https://ks-backend-493469512136.asia-southeast1.run.app';
      const response = await fetch(`${backendBase}/api/ks/sale-pending-confirmations/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, quoteCode, status: 'reject', note: reason, phone })
      });
      const resJson = await response.json();
      hideLoadingOverlay();
      if (resJson && resJson.ok) {
        showToast('✓ Đã từ chối sản xuất');
        await fetchConfirmations();
      } else {
        showToast('Lỗi lưu xác nhận từ chối');
      }
    } catch (err) {
      console.error('submitConfirmReject failed:', err);
      hideLoadingOverlay();
      showToast('Lỗi kết nối');
    }
  };

  // Function to background check/update pending confirmation badge on Home
  window.updateConfirmPendingBadge = async function () {
    const btn = document.getElementById('productionConfirmBtn');
    const badgeEl = document.getElementById('productionConfirmBadge');
    
    // Check role: only Heineken Sales get this button
    const isHeineken = currentSession && currentSession.role === 'heineken';
    if (!isHeineken) {
      if (btn) btn.classList.add('hidden');
      return;
    }

    if (btn) btn.classList.remove('hidden');

    const phone = currentSession && currentSession.phone;
    if (!phone) return;

    try {
      const backendBase = (window.__env && window.__env.BACKEND_URL) || 'https://ks-backend-493469512136.asia-southeast1.run.app';
      const response = await fetch(`${backendBase}/api/ks/sale-pending-confirmations?phone=${encodeURIComponent(phone)}`);
      const resJson = await response.json();

      if (resJson && resJson.ok) {
        const list = resJson.data || [];
        const pendingCount = list.filter(item => (item.saleConfirmStatus || 'pending') === 'pending').length;
        if (badgeEl) {
          badgeEl.textContent = pendingCount;
          badgeEl.classList.toggle('hidden', pendingCount === 0);
        }
      }
    } catch (err) {
      // quiet fail for background updates
    }
  };

  // Hook into SSE events: when pending_orders updates, update confirm badge/list in real time
  const origOnInvalidate = window.__ksOnInvalidate;
  window.__ksOnInvalidate = function (payload) {
    if (typeof origOnInvalidate === 'function') {
      origOnInvalidate(payload);
    }
    if (payload && payload.resource === 'pending_orders') {
      // If we are currently on the confirm screen, refresh list
      const screen = document.getElementById('productionConfirmScreen');
      const isVisible = screen && screen.classList.contains('flex') && !screen.classList.contains('hidden');
      if (isVisible) {
        fetchConfirmations();
      } else {
        updateConfirmPendingBadge();
      }
    }
  };

  // Escape HTML helper
  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

})();
