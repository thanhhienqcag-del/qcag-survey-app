/**
 * App 2 Desktop QCAG — Production Orders Management Flow (Đơn Hàng Sản Xuất)
 * ===========================================================================
 * Quản lý đơn hàng sản xuất & thi công từ menu Hamburger:
 * - Xem danh sách đơn hàng sản xuất từ PostgreSQL Database (orders & order_quotes).
 * - Chuyển thẳng vào giao diện làm việc / đối soát như nhiệm vụ khi bấm vào đơn hàng.
 * - Hiển thị 100% thiết kế hoàn tất cho các đơn hàng đã tạo.
 * - Phân trang dạng x/y (Trang 1/15) và tìm kiếm tức thì.
 * - Hoàn toàn không dùng icon 3D/Emoji, 100% SVG Vector Icons phẳng chuyên nghiệp.
 * - Nút [Định Vị] (UI button sẵn sàng tích hợp Map).
 * - Nút [In PDF Thi Công] (Xuất file A4 thi công chuẩn 100% theo App 1).
 */
'use strict';

let _qcagProductionOrdersCache = [];
let _qcagCurrentSelectedOrder = null;
let _qcagOrdersCurrentPage = 1;
const _qcagOrdersPageSize = 10;
let _qcagOrdersSearchFilter = '';

// Map state variables (order locations map modal)
let _qcagCurrentOrderMapPoints = [];
let _qcagOrderMapInstance = null;
let _qcagOrderMapMarkers = [];
let _qcagOrderMapRoutePolyline = null;
let _isQcagOrderMapRouteActive = false;
let _qcagOrderMapStartDepot = null;
let _qcagOrderMapDepotMarker = null;
let _qcagCurrentOrderMapStartPointId = null;

function qcagGetOrdersApiBase() {
    if (typeof window !== 'undefined') {
        if (window.__env && window.__env.APP1_BACKEND_URL) {
            return String(window.__env.APP1_BACKEND_URL).replace(/\/+$/, '');
        }
        if (window.APP1_BACKEND_URL) {
            return String(window.APP1_BACKEND_URL).replace(/\/+$/, '');
        }
        try {
            const override = localStorage.getItem('app1_backend_url');
            if (override && override.trim()) return override.trim().replace(/\/+$/, '');
        } catch (_) {}
    }
    return 'https://qcag-backend-staging-493469512136.asia-southeast1.run.app';
}

function qcagGetKsApiBase() {
    if (typeof window !== 'undefined' && window.API_BASE_URL) {
        return String(window.API_BASE_URL).replace(/\/+$/, '');
    }
    return 'https://ks-backend-staging-493469512136.asia-southeast1.run.app';
}

function qcagOrdersEscapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function qcagOrdersFormatDate(dateStr) {
    if (!dateStr) return '-';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return String(dateStr);
        return d.toLocaleDateString('vi-VN');
    } catch (_) {
        return String(dateStr);
    }
}

// Fetch list of production orders from backend
async function qcagFetchProductionOrders() {
    try {
        const base = qcagGetOrdersApiBase();
        const res = await fetch(base + '/orders?summary=1', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store'
        }).catch(() => null);

        if (res && res.ok) {
            const json = await res.json().catch(() => null);
            if (json && json.ok && Array.isArray(json.data)) {
                _qcagProductionOrdersCache = json.data;
            } else if (Array.isArray(json)) {
                _qcagProductionOrdersCache = json;
            }
        }
    } catch (e) {
        console.warn('qcagFetchProductionOrders error:', e);
    }
    return _qcagProductionOrdersCache;
}

function qcagOrdersOnSearch(keyword) {
    _qcagOrdersSearchFilter = String(keyword || '').trim();
    _qcagOrdersCurrentPage = 1;
    qcagRenderProductionOrdersTable();
}

function qcagOrdersChangePage(delta) {
    qcagOrdersSetPage(_qcagOrdersCurrentPage + delta);
}

function qcagOrdersSetPage(newPage) {
    let orders = Array.isArray(_qcagProductionOrdersCache) ? _qcagProductionOrdersCache : [];
    if (_qcagOrdersSearchFilter) {
        const kw = _qcagOrdersSearchFilter.toLowerCase();
        orders = orders.filter(o => {
            const code = String(o.order_no || o.id || '').toLowerCase();
            const unit = String(o.unit || o.construction_unit || '').toLowerCase();
            const area = String(o.area || o.area_list || '').toLowerCase();
            const creator = String(o.created_by_name || o.created_by || '').toLowerCase();
            return code.includes(kw) || unit.includes(kw) || area.includes(kw) || creator.includes(kw);
        });
    }
    const totalPages = Math.max(1, Math.ceil(orders.length / _qcagOrdersPageSize));
    if (newPage < 1) newPage = 1;
    if (newPage > totalPages) newPage = totalPages;
    _qcagOrdersCurrentPage = newPage;
    qcagRenderProductionOrdersTable();
}

// Render production orders table in qcagNavOrdersPanel
function qcagRenderProductionOrdersTable() {
    const tbody = document.getElementById('qcagOrdersTableBody');
    const countEl = document.getElementById('qcagNavOrdersCount');
    const badgeEl = document.getElementById('qcagNavOrdersBadge');
    const pageInfoEl = document.getElementById('qcagOrdersPaginationInfo');
    const prevBtn = document.getElementById('qcagOrdersPrevBtn');
    const nextBtn = document.getElementById('qcagOrdersNextBtn');
    if (!tbody) return;

    let orders = Array.isArray(_qcagProductionOrdersCache) ? _qcagProductionOrdersCache : [];
    if (countEl) countEl.textContent = `${orders.length} đơn hàng`;
    if (badgeEl) {
        badgeEl.textContent = orders.length;
        if (orders.length > 0) badgeEl.classList.remove('hidden');
        else badgeEl.classList.add('hidden');
    }

    if (_qcagOrdersSearchFilter) {
        const kw = _qcagOrdersSearchFilter.toLowerCase();
        orders = orders.filter(o => {
            const code = String(o.order_no || o.id || '').toLowerCase();
            const unit = String(o.unit || o.construction_unit || '').toLowerCase();
            const area = String(o.area || o.area_list || '').toLowerCase();
            const creator = String(o.created_by_name || o.created_by || '').toLowerCase();
            return code.includes(kw) || unit.includes(kw) || area.includes(kw) || creator.includes(kw);
        });
    }

    const totalItems = orders.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / _qcagOrdersPageSize));
    if (_qcagOrdersCurrentPage > totalPages) _qcagOrdersCurrentPage = totalPages;
    if (_qcagOrdersCurrentPage < 1) _qcagOrdersCurrentPage = 1;

    if (pageInfoEl) {
        pageInfoEl.textContent = `Trang ${_qcagOrdersCurrentPage}/${totalPages} (${totalItems} đơn hàng)`;
    }
    if (prevBtn) {
        prevBtn.disabled = _qcagOrdersCurrentPage <= 1;
    }
    if (nextBtn) {
        nextBtn.disabled = _qcagOrdersCurrentPage >= totalPages;
    }

    if (totalItems === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" class="p-8 text-center text-gray-400 text-xs">
                    <div class="flex flex-col items-center justify-center gap-2">
                        <svg class="w-8 h-8 opacity-40 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>
                        <span>Không tìm thấy đơn hàng sản xuất nào</span>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    const startIdx = (_qcagOrdersCurrentPage - 1) * _qcagOrdersPageSize;
    const pagedOrders = orders.slice(startIdx, startIdx + _qcagOrdersPageSize);

    let html = '';
    pagedOrders.forEach((o, idx) => {
        const globalIdx = startIdx + idx + 1;
        const orderNo = o.order_no || o.id || `ORD_${globalIdx}`;
        const unit = o.unit || o.construction_unit || 'Chưa gán đơn vị';
        const area = o.area || o.area_list || '-';
        const totalPoints = Number(o.total_points || (Array.isArray(o.quote_codes) ? o.quote_codes.length : 0)) || 1;
        const createdDate = o.created_at ? new Date(o.created_at).toLocaleString('vi-VN') : '-';
        const createdBy = o.created_by_name || o.created_by || 'Admin';

        html += `
            <tr class="qcag-order-row transition-colors cursor-pointer" onclick="qcagDesktopOpenProductionOrderWorkspace('${o.id}')">
                <td class="qcag-order-col-stt text-center w-12">${globalIdx}</td>
                <td class="qcag-order-col-no whitespace-nowrap">
                    <span class="qcag-order-no hover:underline">${qcagOrdersEscapeHtml(orderNo)}</span>
                </td>
                <td class="qcag-order-col-unit truncate max-w-[200px]" title="${qcagOrdersEscapeHtml(unit)}">
                    <span class="qcag-order-unit">${qcagOrdersEscapeHtml(unit)}</span>
                </td>
                <td class="qcag-order-col-area whitespace-nowrap">
                    <span class="qcag-order-area">${qcagOrdersEscapeHtml(area)}</span>
                </td>
                <td class="qcag-order-col-points whitespace-nowrap">
                    <div class="qcag-order-points">${totalPoints} điểm</div>
                    <div class="qcag-order-points-approved text-[11px]">Đã duyệt ${totalPoints}/${totalPoints}</div>
                </td>
                <td class="qcag-order-col-creator text-[11px] whitespace-nowrap">
                    <div class="qcag-order-creator">${qcagOrdersEscapeHtml(createdBy)}</div>
                    <div class="qcag-order-date text-[10px]">${createdDate}</div>
                </td>
                <td class="qcag-order-col-actions text-center whitespace-nowrap" onclick="event.stopPropagation()">
                    <div class="flex items-center justify-center gap-1.5">
                        <button onclick="qcagDesktopOpenProductionOrderWorkspace('${o.id}')" class="qcag-order-btn-detail inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-medium text-xs transition-all active:scale-95 shadow-sm" title="Mở giao diện làm việc như nhiệm vụ">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                            <span>Chi tiết</span>
                        </button>
                        <button onclick="qcagExportProductionOrderPdf('${o.id}')" class="qcag-order-btn-pdf inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-medium text-xs transition-all active:scale-95 shadow-sm" title="In PDF thi công A4">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 13h6m-6 4h4"/></svg>
                            <span>PDF</span>
                        </button>
                        <button onclick="qcagLocateProductionOrder('${o.id}')" class="qcag-order-btn-locate inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-medium text-xs transition-all active:scale-95 shadow-sm" title="Định vị đơn hàng trên bản đồ">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                            <span>Định vị</span>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    });

    if (pagedOrders.length < _qcagOrdersPageSize) {
        const missing = _qcagOrdersPageSize - pagedOrders.length;
        for (let i = 0; i < missing; i++) {
            html += `<tr class="qcag-table-row-placeholder" style="height:10%;pointer-events:none;"><td colspan="7" style="border:none;background:transparent;padding:0;">&nbsp;</td></tr>`;
        }
    }

    tbody.innerHTML = html;
}

// Open Production Order directly in Desktop Workspace (giao diện như nhiệm vụ)
async function qcagDesktopOpenProductionOrderWorkspace(orderId) {
    if (!orderId) return;
    try {
        let order = _qcagProductionOrdersCache.find(o => o.id === orderId || o.order_no === orderId);
        const base = qcagGetOrdersApiBase();
        const res = await fetch(`${base}/orders/${encodeURIComponent(orderId)}`);
        if (res.ok) {
            const json = await res.json();
            order = json.data || json || order;
        }

        if (!order) {
            alert('Không tìm thấy thông tin đơn hàng');
            return;
        }

        order._isProductionOrder = true;
        order.isProductionOrder = true;
        _qcagCurrentTaskOrder = order;
        if (typeof window !== 'undefined') window._qcagCurrentTaskOrder = order;

        // Close sidebar and panels
        if (typeof qcagCloseNavSidebar === 'function') qcagCloseNavSidebar();
        if (typeof qcagNavClosePanel === 'function') qcagNavClosePanel();

        // Update HUD banner
        if (typeof updateDesktopTaskBannerUI === 'function') updateDesktopTaskBannerUI();

        // Reset list pagination
        if (typeof _qcagDesktopListPage !== 'undefined') _qcagDesktopListPage = 0;

        // Re-render list
        if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();

        // Auto-select first request in the production order
        if (typeof qcagGetTaskOrderRequests === 'function') {
            const reqs = qcagGetTaskOrderRequests(order);
            if (reqs.length > 0 && typeof openQCAGDesktopRequest === 'function') {
                openQCAGDesktopRequest(reqs[0].__backendId);
            }
        }

        if (typeof showToast === 'function') {
            const total = (order.quotes && order.quotes.length) || order.total_points || 0;
            showToast(`Đang xem đơn hàng: ${order.order_no || order.id} (${total} điểm)`);
        }
    } catch (e) {
        console.error('qcagDesktopOpenProductionOrderWorkspace error:', e);
        alert('Lỗi khi mở giao diện đơn hàng: ' + e.message);
    }
}

// Alias for compatibility
async function qcagOpenProductionOrderDetail(orderId) {
    return qcagDesktopOpenProductionOrderWorkspace(orderId);
}

// Export Production Order PDF (Clone 100% logic of App 1)
async function qcagExportProductionOrderPdf(orderId) {
    try {
        let order = null;
        // Always fetch fresh order with enriched quotes from App 1 backend
        // so that order.quotes contains full objects (with items, address, etc.)
        try {
            const base = qcagGetOrdersApiBase();
            const res = await fetch(`${base}/orders/${encodeURIComponent(orderId)}`);
            if (res.ok) {
                const json = await res.json();
                order = json.data || json;
            }
        } catch (fetchErr) {
            console.warn('qcagExportProductionOrderPdf: fetch error', fetchErr);
        }
        // Fallback to cached selections if fetch failed
        if (!order) order = _qcagCurrentSelectedOrder;
        if (!order) {
            const cached = (_qcagProductionOrdersCache || []).find(o => String(o.id) === String(orderId) || String(o.order_no) === String(orderId));
            if (cached) order = cached;
        }
        if (!order) {
            if (typeof showToast === 'function') showToast('Không tìm thấy thông tin đơn hàng');
            return;
        }

        // Ensure quotes is array of objects (not strings)
        let quotes = Array.isArray(order.quotes) ? order.quotes : [];
        // Filter out bare strings - they indicate unenriched codes
        const hasObjects = quotes.some(q => q && typeof q === 'object');
        if (!hasObjects && quotes.length > 0) {
            // quotes are just code strings — try fetch enriched version
            try {
                const base = qcagGetOrdersApiBase();
                const res2 = await fetch(`${base}/orders/${encodeURIComponent(orderId)}`);
                if (res2.ok) {
                    const json2 = await res2.json();
                    const order2 = json2.data || json2;
                    if (order2 && Array.isArray(order2.quotes)) quotes = order2.quotes;
                }
            } catch (_) {}
        }
        const orderNumber = order.order_no || order.id || '';
        const unit = order.unit || order.construction_unit || '';
        const due = qcagOrdersFormatDate(order.due_date);

        // Ensure QRious library is loaded
        async function ensureQrLib() {
            if (typeof window.QRious === 'function') return Promise.resolve();
            return new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js';
                s.onload = () => resolve();
                s.onerror = () => reject(new Error('Không tải được thư viện QRious'));
                document.head.appendChild(s);
            });
        }
        await ensureQrLib();

        const printEl = document.createElement('div');
        printEl.id = 'print-production-container';
        printEl.style.background = '#fff';
        printEl.style.width = 'calc(190mm + 10px)';
        printEl.style.minHeight = '277mm';
        printEl.style.boxSizing = 'border-box';
        printEl.style.padding = '15px';
        printEl.style.margin = '0 auto';
        printEl.style.fontFamily = 'Segoe UI, Arial, sans-serif';
        printEl.style.color = '#111';
        printEl.style.fontSize = '12px';

        const headerHtml = `
            <div style="text-align:center;margin-bottom:8mm">
                <h1 style="margin:0;font-size:18px;">Danh sách thi công đơn hàng: <strong style="font-weight:700">${qcagOrdersEscapeHtml(orderNumber)}</strong></h1>
                <div style="font-size:12px;color:#555;margin-top:6px">Thi công: <strong>${qcagOrdersEscapeHtml(unit)}</strong> - Thời hạn thi công <strong>${qcagOrdersEscapeHtml(due)}</strong></div>
            </div>
            <div style="margin-bottom:6mm;font-size:12px;">Tổng điểm: ${quotes.length}</div>
        `;

        function renderManageOrderPointRowNoPrice(q, idx, qrDataUrl) {
            const items = Array.isArray(q.items) ? q.items : (() => { try { return JSON.parse(q.items || '[]'); } catch (_) { return []; } })();
            const hasCode21 = Array.isArray(items) && items.some(it => String((it.code || '')).replace(/^s/i, '').trim() === '2.1');
            const filteredItems = (Array.isArray(items) ? items : []).filter(it => {
                try {
                    const codeRaw = String(it.code || '').trim();
                    const codeNorm = codeRaw.replace(/^s/i, '').trim();
                    const content = String(it.content || '').toLowerCase();
                    if (content.includes('giấy phép') || content.includes('vận chuyển')) return false;
                    if (codeNorm === '9.17' || /^s9\.17$/i.test(codeRaw)) {
                        if (hasCode21) return false;
                    }
                } catch (e) {
                    return true;
                }
                return true;
            });

            let itemsTableHtml = '';
            if (filteredItems.length > 0) {
                itemsTableHtml = `
                    <table style="width:100%;border-collapse:collapse;margin-top:4px;font-size:11px;">
                        <thead>
                            <tr style="background:#f3f4f6;font-weight:bold;">
                                <th style="padding:4px 6px;text-align:left;border-bottom:1px solid #333;width:35px;">Mã</th>
                                <th style="padding:4px 6px;text-align:left;border-bottom:1px solid #333;">Hạng mục / Quy cách</th>
                                <th style="padding:4px 6px;text-align:left;border-bottom:1px solid #333;width:60px;">Brand</th>
                                <th style="padding:4px 6px;text-align:center;border-bottom:1px solid #333;width:75px;">Kích thước</th>
                                <th style="padding:4px 6px;text-align:center;border-bottom:1px solid #333;width:35px;">ĐVT</th>
                                <th style="padding:4px 6px;text-align:center;border-bottom:1px solid #333;width:30px;">SL</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${filteredItems.map(it => `
                                <tr>
                                    <td style="padding:4px 6px;border-bottom:1px solid #ddd;">${qcagOrdersEscapeHtml(it.code || '')}</td>
                                    <td style="padding:4px 6px;border-bottom:1px solid #ddd;">${qcagOrdersEscapeHtml(it.content || '')}</td>
                                    <td style="padding:4px 6px;border-bottom:1px solid #ddd;">${qcagOrdersEscapeHtml(it.brand || '')}</td>
                                    <td style="padding:4px 6px;border-bottom:1px solid #ddd;text-align:center;">${(it.width && it.height) ? `${it.width} x ${it.height}m` : ''}</td>
                                    <td style="padding:4px 6px;border-bottom:1px solid #ddd;text-align:center;">${qcagOrdersEscapeHtml(it.unit || '')}</td>
                                    <td style="padding:4px 6px;border-bottom:1px solid #ddd;text-align:center;">${it.quantity || it.qty || '1'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                `;
            }

            return `
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
                    <div style="flex:1;">
                        <div style="font-weight:bold;font-size:12px;">${idx}. ${qcagOrdersEscapeHtml(q.outlet_name || q.outletName || '')} <span style="font-weight:normal;color:#555;">(Mã: ${qcagOrdersEscapeHtml(q.outlet_code || q.outletCode || '')})</span></div>
                        <div style="font-size:11px;color:#333;margin-top:2px;">Địa chỉ: ${qcagOrdersEscapeHtml(q.address || '')}</div>
                        <div style="font-size:11px;color:#555;margin-top:1px;">Sale: ${qcagOrdersEscapeHtml(q.sale_name || q.saleName || '')} - SĐT: ${qcagOrdersEscapeHtml(q.outlet_phone || q.outletPhone || '')}</div>
                    </div>
                    ${qrDataUrl ? `<div style="margin-left:10px;text-align:center;"><img src="${qrDataUrl}" style="width:55px;height:55px;"/><div style="font-size:9px;color:#666;">QR Vị trí</div></div>` : ''}
                </div>
                ${itemsTableHtml}
            `;
        }

        let bodyHtml = '';
        for (let i = 0; i < quotes.length; i++) {
            const q = quotes[i];
            let qrDataUrl = '';
            try {
                const qrText = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((q.outlet_name || '') + ' ' + (q.address || ''))}`;
                const qr = new window.QRious({ value: qrText, size: 100 });
                qrDataUrl = qr.toDataURL();
            } catch (_) {}
            bodyHtml += `<div class="print-outlet" style="margin-bottom:5px;border:1px solid #333;border-radius:6px;padding:8px;page-break-inside:avoid;">${renderManageOrderPointRowNoPrice(q, i + 1, qrDataUrl)}</div>`;
        }

        printEl.innerHTML = headerHtml + bodyHtml;

        const styleTag = document.createElement('style');
        styleTag.id = 'print-production-style';
        styleTag.textContent = `
            @media print {
                body > *:not(#print-production-container) { display: none !important; }
                #print-production-container { box-shadow: none !important; margin: 0 auto !important; width: calc(190mm + 10px); padding: 15px; box-sizing: border-box; }
                #print-production-container .print-outlet { page-break-inside: avoid; margin-bottom: 5px; width: 100%; box-sizing: border-box; border: 1px solid #333; border-radius: 6px; padding: 8px; }
            }
        `;
        document.head.appendChild(styleTag);
        document.body.appendChild(printEl);

        const cleanup = () => {
            try { document.head.removeChild(styleTag); } catch (_) {}
            try { document.body.removeChild(printEl); } catch (_) {}
            window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        setTimeout(() => { window.print(); }, 50);

    } catch (e) {
        console.error('qcagExportProductionOrderPdf error:', e);
        alert('Không thể xuất file PDF thi công: ' + e.message);
    }
}

// Locate Production Order
function qcagLocateProductionOrder(orderId) {
    if (!orderId) return;
    openOrderLocationsMap(orderId);
}

let _qcagCurrentOrderMapFilter = 'all';
let _qcagCurrentOrderMapSearch = '';
let _qcagCurrentOrderMapActiveMarkerId = null;

function getApp2SavedDepots() {
    try {
        const saved = localStorage.getItem('qcag_saved_depots');
        if (saved) return JSON.parse(saved);
    } catch (_) {}
    return [];
}

function saveApp2CustomDepot(depot) {
    if (!depot || typeof depot.lat !== 'number' || typeof depot.lng !== 'number') return;
    try {
        let list = getApp2SavedDepots();
        list = list.filter(d => d.id !== depot.id && (Math.abs(d.lat - depot.lat) > 0.001 || Math.abs(d.lng - depot.lng) > 0.001));
        list.unshift(depot);
        if (list.length > 5) list = list.slice(0, 5);
        localStorage.setItem('qcag_saved_depots', JSON.stringify(list));
    } catch (_) {}
}

function renderApp2SavedDepots(depots, container) {
    if (!container) return;
    if (!depots || depots.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.classList.remove('hidden');
    const factoryIconSvg = '<svg class="w-3.5 h-3.5 text-slate-400 dark:text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>';
    container.innerHTML = `
            <div class="px-3 py-1.5 text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Xưởng sản xuất đã lưu</div>
            ${depots.map(d => {
                const isSelected = _qcagOrderMapStartDepot && (_qcagOrderMapStartDepot.id === d.id || (Math.abs(_qcagOrderMapStartDepot.lat - d.lat) < 0.0001 && Math.abs(_qcagOrderMapStartDepot.lng - d.lng) < 0.0001));
                return `
                <button type="button" class="order-map-depot-item ${isSelected ? 'active' : ''} w-full px-3 py-2 text-left flex items-center justify-between gap-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors cursor-pointer" data-depot-id="${d.id}" data-lat="${d.lat}" data-lng="${d.lng}" data-name="${d.name}">
                    <div class="flex items-center gap-2 min-w-0 flex-1">
                        ${factoryIconSvg}
                        <span class="font-medium text-slate-800 dark:text-slate-200 truncate">${d.name}</span>
                    </div>
                </button>
                `;
            }).join('')}
    `;

    // Update active state on static depot items
    document.querySelectorAll('#order-map-depot-menu .order-map-depot-item').forEach(btn => {
        const action = btn.dataset.depot;
        if (action === 'first_point') {
            if (!_qcagOrderMapStartDepot) btn.classList.add('active');
            else btn.classList.remove('active');
        } else if (action === 'pick_map') {
            if (_qcagOrderMapStartDepot && _qcagOrderMapStartDepot.isCustom && !_qcagOrderMapStartDepot.id) btn.classList.add('active');
            else btn.classList.remove('active');
        } else if (action === 'current_gps') {
            if (_qcagOrderMapStartDepot && _qcagOrderMapStartDepot.isGps) btn.classList.add('active');
            else btn.classList.remove('active');
        }
    });
}

function setApp2OrderMapStartDepot(depot, shouldRecalculate = true) {
    _qcagOrderMapStartDepot = depot;
    const labelEl = document.getElementById('order-map-depot-btn-label');
    if (labelEl) {
        labelEl.textContent = depot ? `Xuất phát: ${depot.name}` : 'Xuất phát: Mặc định';
    }

    updateApp2OrderMapDepotMarker();

    if (shouldRecalculate && _isQcagOrderMapRouteActive) {
        _isQcagOrderMapRouteActive = false;
        toggleApp2OrderMapRoute();
    }
}

function updateApp2OrderMapDepotMarker() {
    if (!_qcagOrderMapInstance) return;

    if (!_qcagOrderMapStartDepot || typeof _qcagOrderMapStartDepot.lat !== 'number' || typeof _qcagOrderMapStartDepot.lng !== 'number') {
        if (_qcagOrderMapDepotMarker) {
            _qcagOrderMapInstance.removeLayer(_qcagOrderMapDepotMarker);
            _qcagOrderMapDepotMarker = null;
        }
        return;
    }

    const { lat, lng, name } = _qcagOrderMapStartDepot;
    const customIcon = L.divIcon({
        className: 'qcag-depot-custom-pin',
        html: `<div style="background:#0f172a;border:2px solid #475569;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3);"><svg style="width:16px;height:16px;color:#38bdf8;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -14]
    });

    if (_qcagOrderMapDepotMarker) {
        _qcagOrderMapDepotMarker.setLatLng([lat, lng]);
        _qcagOrderMapDepotMarker.setIcon(customIcon);
    } else {
        _qcagOrderMapDepotMarker = L.marker([lat, lng], {
            icon: customIcon,
            draggable: true,
            zIndexOffset: 20000
        }).addTo(_qcagOrderMapInstance);

        _qcagOrderMapDepotMarker.bindPopup(`
            <div style="font-size:12px;font-family:inherit;">
                <strong>${name} (Điểm xuất phát)</strong>
                <div style="font-size:11px;color:#6b7280;margin-top:2px;">Kéo thả để tinh chỉnh toạ độ xưởng</div>
            </div>
        `);

        _qcagOrderMapDepotMarker.on('dragend', (e) => {
            const newPos = e.target.getLatLng();
            if (_qcagOrderMapStartDepot) {
                _qcagOrderMapStartDepot.lat = newPos.lat;
                _qcagOrderMapStartDepot.lng = newPos.lng;
            }
            if (_isQcagOrderMapRouteActive) {
                _isQcagOrderMapRouteActive = false;
                toggleApp2OrderMapRoute();
            }
        });
    }
}

function calculateApp2HaversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function solveApp2TspShortestRoute(points) {
    let gpsPoints = (points || []).filter(p => p.hasGps && typeof p.lat === 'number' && typeof p.lng === 'number');
    if (_qcagOrderMapStartDepot && typeof _qcagOrderMapStartDepot.lat === 'number' && typeof _qcagOrderMapStartDepot.lng === 'number') {
        gpsPoints = [_qcagOrderMapStartDepot, ...gpsPoints];
    }

    if (gpsPoints.length <= 1) {
        return { route: gpsPoints, totalKm: 0 };
    }

    const n = gpsPoints.length;
    const dist = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const d = calculateApp2HaversineKm(gpsPoints[i].lat, gpsPoints[i].lng, gpsPoints[j].lat, gpsPoints[j].lng);
            dist[i][j] = d;
            dist[j][i] = d;
        }
    }

    // Nearest Neighbor initial tour
    const visited = new Uint8Array(n);
    const tour = [0];
    visited[0] = 1;
    for (let step = 1; step < n; step++) {
        const last = tour[tour.length - 1];
        let bestNext = -1;
        let bestDist = Infinity;
        for (let candidate = 0; candidate < n; candidate++) {
            if (!visited[candidate] && dist[last][candidate] < bestDist) {
                bestDist = dist[last][candidate];
                bestNext = candidate;
            }
        }
        if (bestNext !== -1) {
            visited[bestNext] = 1;
            tour.push(bestNext);
        }
    }

    // 2-Opt local search refinement
    let improved = true;
    let iterations = 0;
    while (improved && iterations < 200) {
        improved = false;
        iterations++;
        for (let i = 0; i < n - 1; i++) {
            for (let k = i + 1; k < n; k++) {
                const a = tour[i];
                const b = tour[(i + 1) % n];
                const c = tour[k];
                const d = tour[(k + 1) % n];

                const currentDist = dist[a][b] + (k < n - 1 ? dist[c][d] : 0);
                const newDist = dist[a][c] + (k < n - 1 ? dist[b][d] : 0);

                if (newDist < currentDist - 1e-6) {
                    let left = i + 1;
                    let right = k;
                    while (left < right) {
                        const tmp = tour[left];
                        tour[left] = tour[right];
                        tour[right] = tmp;
                        left++;
                        right--;
                    }
                    improved = true;
                }
            }
        }
    }

    let totalKm = 0;
    for (let i = 0; i < tour.length - 1; i++) {
        totalKm += dist[tour[i]][tour[i + 1]];
    }

    const orderedRoute = tour.map(idx => gpsPoints[idx]);
    return { route: orderedRoute, totalKm };
}

async function fetchApp2RoadRouteGeometry(points) {
    let gpsPoints = (points || []).filter(p => p.hasGps && typeof p.lat === 'number' && typeof p.lng === 'number');
    if (_qcagOrderMapStartDepot && typeof _qcagOrderMapStartDepot.lat === 'number' && typeof _qcagOrderMapStartDepot.lng === 'number') {
        gpsPoints = [_qcagOrderMapStartDepot, ...gpsPoints];
    }

    if (gpsPoints.length < 2) return null;

    try {
        const coordStr = gpsPoints.map(p => `${p.lng},${p.lat}`).join(';');
        const url = `https://router.project-osrm.org/trip/v1/driving/${coordStr}?overview=full&geometries=geojson&source=first&roundtrip=false`;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);
        
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (res.ok) {
            const data = await res.json();
            if (data && data.code === 'Ok' && Array.isArray(data.trips) && data.trips[0]) {
                const trip = data.trips[0];
                const distanceKm = trip.distance ? (trip.distance / 1000).toFixed(1) : 0;
                const durationMin = trip.duration ? Math.round(trip.duration / 60) : 0;
                
                let roadCoords = [];
                if (trip.geometry && Array.isArray(trip.geometry.coordinates)) {
                    roadCoords = trip.geometry.coordinates.map(c => [c[1], c[0]]);
                }

                let orderedWaypoints = gpsPoints;
                if (Array.isArray(data.waypoints)) {
                    const sortedWps = [...data.waypoints].sort((a, b) => (a.waypoint_index ?? 0) - (b.waypoint_index ?? 0));
                    orderedWaypoints = sortedWps.map(w => gpsPoints[w.trips_index ?? 0] || gpsPoints[0]);
                }

                return {
                    roadCoords,
                    distanceKm: parseFloat(distanceKm),
                    durationMin,
                    orderedWaypoints
                };
            }
        }
    } catch (err) {
        console.warn('OSRM Road Routing fetch error, fallback to 2-Opt:', err);
    }
    return null;
}

async function toggleApp2OrderMapRoute() {
    const badgeEl = document.getElementById('order-map-route-info-badge');
    const textEl = document.getElementById('order-map-route-info-text');
    const btnText = document.getElementById('order-map-toggle-route-text');
    const btn = document.getElementById('order-map-toggle-route-btn');

    if (_isQcagOrderMapRouteActive) {
        _isQcagOrderMapRouteActive = false;
        if (_qcagOrderMapRoutePolyline && _qcagOrderMapInstance) {
            try { _qcagOrderMapInstance.removeLayer(_qcagOrderMapRoutePolyline); } catch (_) {}
            _qcagOrderMapRoutePolyline = null;
        }
        if (badgeEl) badgeEl.classList.add('hidden');
        if (btnText) btnText.textContent = 'Lộ trình tối ưu';
        if (btn) {
            btn.classList.remove('ring-2', 'ring-blue-500', 'ring-emerald-500', 'bg-blue-950', 'bg-emerald-950');
            btn.classList.add('bg-slate-900/90');
        }
        return;
    }

    const gpsPoints = (_qcagCurrentOrderMapPoints || []).filter(p => p.hasGps);
    if (gpsPoints.length < 2 && !_qcagOrderMapStartDepot) {
        if (typeof showToast === 'function') showToast('Cần ít nhất 2 điểm có toạ độ GPS để vẽ lộ trình.');
        return;
    }

    if (btnText) btnText.textContent = 'Đang tính đường bộ...';
    if (btn) btn.disabled = true;

    // 1. Fetch real driving road geometry from workshop / first point
    const roadData = await fetchApp2RoadRouteGeometry(_qcagCurrentOrderMapPoints);

    if (btn) btn.disabled = false;

    let latlngs = [];
    let totalKm = 0;
    let durationStr = '';

    if (roadData && roadData.roadCoords && roadData.roadCoords.length > 0) {
        latlngs = roadData.roadCoords;
        totalKm = roadData.distanceKm;
        if (roadData.durationMin > 0) {
            const hours = Math.floor(roadData.durationMin / 60);
            const mins = roadData.durationMin % 60;
            durationStr = hours > 0 ? ` (~\${hours}g\${mins}p)` : ` (~\${mins} phút)`;
        }
    } else {
        // Fallback to 2-Opt if offline
        const tspFallback = solveApp2TspShortestRoute(_qcagCurrentOrderMapPoints);
        latlngs = (tspFallback.route || []).map(p => [p.lat, p.lng]);
        totalKm = parseFloat(tspFallback.totalKm.toFixed(1));
    }

    if (!latlngs || latlngs.length < 2 || !_qcagOrderMapInstance) {
        if (btnText) btnText.textContent = 'Lộ trình tối ưu';
        return;
    }

    _isQcagOrderMapRouteActive = true;
    if (_qcagOrderMapRoutePolyline) {
        try { _qcagOrderMapInstance.removeLayer(_qcagOrderMapRoutePolyline); } catch (_) {}
    }

    // Real road driving polyline
    const polyline = L.polyline(latlngs, {
        color: '#2563eb',
        weight: 4.5,
        opacity: 0.9,
        lineJoin: 'round',
        lineCap: 'round',
        smoothFactor: 1.0
    }).addTo(_qcagOrderMapInstance);

    _qcagOrderMapRoutePolyline = polyline;

    // Get start point name
    const startPt = (_qcagCurrentOrderMapPoints || []).find(p => String(p.id) === String(_qcagCurrentOrderMapStartPointId)) || gpsPoints[0];
    const startName = startPt ? `Từ #${startPt.index}` : '';

    if (badgeEl) badgeEl.classList.remove('hidden');
    if (textEl) textEl.textContent = `Đường bộ: ~${totalKm} km${durationStr} • ${gpsPoints.length} điểm ${startName ? '(' + startName + ')' : ''}`;
    if (btn) {
        btn.classList.remove('bg-slate-900/90');
        btn.classList.add('ring-2', 'ring-blue-500', 'bg-blue-950');
    }

    _qcagOrderMapInstance.fitBounds(polyline.getBounds(), { padding: [50, 50], maxZoom: 15 });
}

async function qcagLocateProductionOrder(orderId) {
    if (!orderId) return;
    openOrderLocationsMap(orderId);
}

async function openOrderLocationsMap(orderId) {
    const modal = document.getElementById('order-locations-map-modal');
    if (!modal) return;

    let order = (_qcagProductionOrdersCache || []).find(o => String(o.id) === String(orderId) || String(o.order_no) === String(orderId));
    // Always fetch fresh order with enriched quotes (lat/lng from outlets table)
    try {
        const base = qcagGetOrdersApiBase();
        let res = await fetch(`${base}/orders/${encodeURIComponent(orderId)}`).catch(() => null);
        if (!res || !res.ok) {
            const ksBase = qcagGetKsApiBase();
            res = await fetch(`${ksBase}/orders/${encodeURIComponent(orderId)}`).catch(() => null);
        }
        if (res && res.ok) {
            const json = await res.json().catch(() => null);
            const freshOrder = json && (json.data || json);
            if (freshOrder && Array.isArray(freshOrder.quotes) && freshOrder.quotes.some(q => q && typeof q === 'object')) {
                order = freshOrder; // enriched quotes with lat/lng
            } else if (freshOrder && !order) {
                order = freshOrder;
            }
        }
    } catch (e) {
        console.warn('Error fetching full order for map:', e);
    }

    if (!order) {
        if (typeof showToast === 'function') showToast('Không tìm thấy thông tin đơn hàng');
        return;
    }

    _qcagCurrentSelectedOrder = order;
    modal.classList.remove('hidden');

    const spoNo = (order.order_no && order.order_no !== 'Chưa nhập số đơn hàng') ? order.order_no : (order.id || 'Đơn hàng');
    const dueStr = order.due_date && order.due_date !== 'Chưa nhập hạn thi công' ? order.due_date : '';
    const unitStr = (order.unit || order.construction_unit) && (order.unit !== 'Chưa nhập đơn vị thi công') ? (order.unit || order.construction_unit) : '';

    const titleEl = document.getElementById('order-map-modal-title');
    if (titleEl) titleEl.textContent = `Định Vị Điểm Bán — Đơn Hàng: ${spoNo}`;
    const badgeEl = document.getElementById('order-map-spo-badge');
    if (badgeEl) badgeEl.textContent = spoNo;

    let subText = 'Dữ liệu toạ độ GPS định vị khảo sát App 2';
    if (unitStr || dueStr) {
        subText = `${unitStr ? 'Đơn vị: ' + unitStr : ''}${unitStr && dueStr ? ' • ' : ''}${dueStr ? 'Hạn thi công: ' + dueStr : ''}`;
    }
    const subEl = document.getElementById('order-map-modal-subtitle');
    if (subEl) subEl.textContent = subText;

    // Quotes list
    let quotesList = Array.isArray(order.quotes) ? order.quotes : [];
    if (quotesList.length === 0 && order.items) {
        try {
            quotesList = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
        } catch (_) {}
    }
    if (!Array.isArray(quotesList)) quotesList = [];

    // Show loading in sidebar
    const listContainer = document.getElementById('order-map-points-list');
    if (listContainer) {
        listContainer.innerHTML = '<div class="p-8 text-center text-xs text-gray-400"><div class="inline-block animate-spin rounded-full h-5 w-5 border-2 border-emerald-500 border-t-transparent mb-2"></div><div>Đang kiểm tra toạ độ định vị...</div></div>';
    }

    // Get current requests cache in App 2
    let storeMap = new Map();
    try {
        const cached = localStorage.getItem('ks_requests_cache_v2');
        if (cached) {
            const arr = JSON.parse(cached);
            if (Array.isArray(arr)) {
                arr.forEach(r => {
                    const code = (r.outletCode || r.outlet_code || '').trim().toLowerCase();
                    if (code && !storeMap.has(code)) storeMap.set(code, r);
                    const idKey = String(r.id || r.__backendId || '');
                    if (idKey && !storeMap.has(idKey)) storeMap.set(idKey, r);
                });
            }
        }
    } catch (_) {}

    // Check missing outlet codes
    const missingOutletCodes = [];
    quotesList.forEach(q => {
        const oCode = String(q.outlet_code || q.outletCode || '').trim().toLowerCase();
        if (oCode && !storeMap.has(oCode) && oCode !== 'new outlet' && oCode !== 'chưa có code') {
            missingOutletCodes.push(oCode);
        }
    });

    // NOTE: Batch fetch từ App 2 /api/ks/outlet-locations bị tắt.
    // Dữ liệu lat/lng đã được backend App 1 enrich sẵn trong order.quotes
    // (từ bảng outlets khi gọi GET /orders/:id). Không cần fetch thêm.

    // Build matched points
    const points = [];
    const seenPointKeys = new Set();

    quotesList.forEach((q, idx) => {
        if (!q || typeof q !== 'object') return;

        const rawOutletCode = String(q.outlet_code || q.outletCode || '').trim();
        const rawOutletName = String(q.outlet_name || q.outletName || '').trim();
        const rawAddress = q.address || '';
        const rawPhone = q.outlet_phone || q.phone || '';
        const rawSaleName = q.sale_name || q.saleName || '';
        const rawSalePhone = q.sale_phone || q.salePhone || '';
        const rawArea = q.area || q.region || '';
        const quoteCode = String(q.quote_code || q.quoteCode || q.id || '').trim();
        const rawTkCode = String(q.tk_code || q.tkCode || '').trim();

        const pointKey = `${rawOutletCode}_${rawOutletName}_${quoteCode || idx}`;
        if (seenPointKeys.has(pointKey)) return;
        seenPointKeys.add(pointKey);

        let matched = null;
        if (rawOutletCode) {
            matched = storeMap.get(rawOutletCode.toLowerCase());
        }

        const directLat = parseFloat(q.outlet_lat || q.outletLat || q.lat || (matched ? (matched.outletLat || matched.lat) : null));
        const directLng = parseFloat(q.outlet_lng || q.outletLng || q.lng || (matched ? (matched.outletLng || matched.lng) : null));
        const hasGps = !isNaN(directLat) && !isNaN(directLng) && directLat !== 0 && directLng !== 0;

        points.push({
            id: `point_${idx}_${Date.now()}`,
            index: idx + 1,
            outletCode: rawOutletCode || (matched ? (matched.outletCode || matched.outlet_code) : 'Chưa có code'),
            outletName: rawOutletName || (matched ? (matched.outletName || matched.outlet_name) : 'Chưa đặt tên'),
            address: rawAddress || (matched ? matched.address : 'Chưa có địa chỉ'),
            phone: rawPhone || (matched ? matched.phone : ''),
            saleName: rawSaleName || (matched ? ((matched.requester && matched.requester.saleName) || matched.saleName) : ''),
            salePhone: rawSalePhone || (matched ? ((matched.requester && matched.requester.phone) || matched.salePhone) : ''),
            area: rawArea || (matched ? matched.region : ''),
            quoteCode: quoteCode,
            tkCode: rawTkCode || (matched ? (matched.tkCode || matched.tk_code) : ''),
            spoNumber: spoNo,
            lat: hasGps ? directLat : null,
            lng: hasGps ? directLng : null,
            hasGps: hasGps,
            matchedApp2: !!matched
        });
    });

    _qcagCurrentOrderMapPoints = points;
    _qcagCurrentOrderMapFilter = 'all';
    _qcagCurrentOrderMapSearch = '';
    _qcagCurrentOrderMapActiveMarkerId = null;

    const totalCount = points.length;
    const gpsCount = points.filter(p => p.hasGps).length;
    const noGpsCount = totalCount - gpsCount;

    const statTotalEl = document.getElementById('order-map-stat-total');
    if (statTotalEl) statTotalEl.textContent = `Tổng: ${totalCount} điểm`;
    const statGpsEl = document.getElementById('order-map-stat-has-gps');
    if (statGpsEl) statGpsEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"></span><span>${gpsCount} có GPS</span>`;
    const statNoGpsEl = document.getElementById('order-map-stat-no-gps');
    if (statNoGpsEl) statNoGpsEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block"></span><span>${noGpsCount} chưa GPS</span>`;

    const fAll = document.getElementById('order-map-filter-count-all');
    if (fAll) fAll.textContent = String(totalCount);
    const fGps = document.getElementById('order-map-filter-count-gps');
    if (fGps) fGps.textContent = String(gpsCount);
    const fNoGps = document.getElementById('order-map-filter-count-nogps');
    if (fNoGps) fNoGps.textContent = String(noGpsCount);

    renderApp2OrderMapSidebar();
    initApp2OrderLocationsLeafletMap(points);
    setupApp2OrderMapEvents();
}

function closeOrderLocationsMapModal() {
    const modal = document.getElementById('order-locations-map-modal');
    if (modal) modal.classList.add('hidden');
    if (_qcagOrderMapRoutePolyline && _qcagOrderMapInstance) {
        try { _qcagOrderMapInstance.removeLayer(_qcagOrderMapRoutePolyline); } catch (_) {}
        _qcagOrderMapRoutePolyline = null;
    }
    _isQcagOrderMapRouteActive = false;
    const badgeEl = document.getElementById('order-map-route-info-badge');
    if (badgeEl) badgeEl.classList.add('hidden');
    const btnText = document.getElementById('order-map-toggle-route-text');
    if (btnText) btnText.textContent = 'Lộ trình tối ưu';
    const btn = document.getElementById('order-map-toggle-route-btn');
    if (btn) {
        btn.classList.remove('ring-2', 'ring-blue-500', 'ring-emerald-500', 'bg-blue-950', 'bg-emerald-950');
        btn.classList.add('bg-slate-900/90');
    }

    if (_qcagOrderMapInstance) {
        try { _qcagOrderMapInstance.remove(); } catch (_) {}
        _qcagOrderMapInstance = null;
    }
    _qcagOrderMapMarkers = [];
}

function renderApp2OrderMapSidebar() {
    const container = document.getElementById('order-map-points-list');
    if (!container) return;

    const q = (_qcagCurrentOrderMapSearch || '').toLowerCase().trim();
    const filtered = _qcagCurrentOrderMapPoints.filter(p => {
        if (_qcagCurrentOrderMapFilter === 'has_gps' && !p.hasGps) return false;
        if (_qcagCurrentOrderMapFilter === 'no_gps' && p.hasGps) return false;
        if (q) {
            const matchCode = p.outletCode.toLowerCase().includes(q);
            const matchName = p.outletName.toLowerCase().includes(q);
            const matchAddr = p.address.toLowerCase().includes(q);
            const matchSale = p.saleName.toLowerCase().includes(q);
            if (!matchCode && !matchName && !matchAddr && !matchSale) return false;
        }
        return true;
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="p-6 text-center text-xs text-gray-400">Không tìm thấy điểm bán phù hợp</div>';
        return;
    }

    container.innerHTML = filtered.map(p => {
        const isActive = p.id === _qcagCurrentOrderMapActiveMarkerId;
        const gpsDot = p.hasGps 
            ? '<span class="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" title="Có toạ độ định vị"></span>'
            : '<span class="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0" title="Chưa có toạ độ định vị"></span>';

        return `
            <div 
                class="p-2.5 rounded-xl border-2 ${isActive ? 'border-amber-500 shadow-sm ring-2 ring-amber-500/25' : 'border-gray-200 dark:border-slate-800 hover:border-gray-300 dark:hover:border-slate-700'} bg-white dark:bg-slate-900 transition-all cursor-pointer"
                data-point-id="${p.id}"
                onclick="focusApp2OrderMapPoint('${p.id}', false)"
            >
                <div class="flex items-center justify-between gap-1.5">
                    <div class="flex items-center gap-1.5 min-w-0 flex-1">
                        <span class="text-xs font-bold text-gray-900 dark:text-gray-100 truncate" title="${qcagOrdersEscapeHtml(p.outletName)}">
                            ${p.index}. ${qcagOrdersEscapeHtml(p.outletName)}
                        </span>
                        ${p.outletCode ? `<span class="text-[10px] font-mono font-bold text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-1.5 py-0.5 rounded flex-shrink-0">${qcagOrdersEscapeHtml(p.outletCode)}</span>` : ''}
                    </div>
                    ${gpsDot}
                </div>

                <div class="mt-1 space-y-0.5 text-[11px] text-gray-600 dark:text-gray-400">
                    <div class="line-clamp-2 leading-relaxed" title="${qcagOrdersEscapeHtml(p.address)}">
                        Địa chỉ: ${qcagOrdersEscapeHtml(p.address || 'Chưa có')}
                    </div>
                    ${p.saleName ? `<div class="text-gray-500 dark:text-gray-400 truncate">Sale: <span class="text-gray-800 dark:text-gray-200 font-medium">${qcagOrdersEscapeHtml(p.saleName)}</span>${p.salePhone ? ' (' + qcagOrdersEscapeHtml(p.salePhone) + ')' : ''}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function initApp2OrderLocationsLeafletMap(points) {
    const container = document.getElementById('order-locations-map-container');
    if (!container) return;

    if (typeof L === 'undefined') {
        container.innerHTML = '<div class="flex items-center justify-center h-full text-sm text-gray-500">Thư viện bản đồ Leaflet chưa sẵn sàng. Vui lòng tải lại trang.</div>';
        return;
    }

    if (_qcagOrderMapInstance) {
        try { _qcagOrderMapInstance.remove(); } catch (_) {}
        _qcagOrderMapInstance = null;
    }
    _qcagOrderMapMarkers = [];
    container.innerHTML = '';

    const defaultCenter = [10.3, 105.5];
    const map = L.map(container, {
        center: defaultCenter,
        zoom: 8,
        maxZoom: 20,
        preferCanvas: true,
        zoomAnimation: true,
        fadeAnimation: true,
        markerZoomAnimation: true,
        inertia: true,
        inertiaDeceleration: 3000,
        wheelPxPerZoomLevel: 80,
        wheelDebounceTime: 30
    });
    _qcagOrderMapInstance = map;

    const streetLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
        attribution: '© Google Maps',
        subdomains: '0123',
        maxZoom: 21,
        keepBuffer: 6,
        updateWhenIdle: false,
        updateWhenZooming: true
    });
    const satLayer = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
        attribution: '© Google Maps Satellite',
        subdomains: '0123',
        maxZoom: 21,
        keepBuffer: 6,
        updateWhenIdle: false,
        updateWhenZooming: true
    });
    
    streetLayer.addTo(map);
    let isSat = false;

    // Satellite / Street layer toggle button (Monochrome Flat SVG)
    const layerCtrl = L.control({ position: 'topright' });
    layerCtrl.onAdd = function () {
        const div = L.DomUtil.create('div', 'leaflet-bar');
        const layersSvg = '<svg class="w-4 h-4 text-slate-700 dark:text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/></svg>';
        div.innerHTML = `<a href="#" title="Chuyển sang ảnh vệ tinh" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;background:#fff;color:#333;text-decoration:none;cursor:pointer;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,0.15);" id="orderMapLayerToggleBtn">${layersSvg}</a>`;
        L.DomEvent.disableClickPropagation(div);
        div.querySelector('a').addEventListener('click', function (e) {
            e.preventDefault();
            if (isSat) {
                map.removeLayer(satLayer);
                streetLayer.addTo(map);
                isSat = false;
                this.title = 'Chuyển sang ảnh vệ tinh';
                this.style.background = '#ffffff';
            } else {
                map.removeLayer(streetLayer);
                satLayer.addTo(map);
                isSat = true;
                this.title = 'Chuyển sang bản đồ đường phố';
                this.style.background = '#e2e8f0';
            }
        });
        return div;
    };
    layerCtrl.addTo(map);

    const latlngs = [];

    points.forEach(p => {
        if (!p.hasGps) return;
        const lat = p.lat;
        const lng = p.lng;
        latlngs.push([lat, lng]);

        // Compact Numbered Badge Marker (Red color for high contrast on Google Maps)
        const pinHtml = `
            <div class="order-map-marker-pin" data-marker-id="${p.id}" style="display:flex;flex-direction:column;align-items:center;cursor:pointer;user-select:none;transform-origin:center center;">
                <div class="order-map-badge-circle" style="width:24px;height:24px;background:linear-gradient(135deg,#dc2626 0%,#ef4444 100%);color:#ffffff;border:2px solid #ffffff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,0.42);line-height:1;letter-spacing:-0.3px;transition:all 0.15s ease;">
                    ${p.index}
                </div>
                <div class="order-map-pin-label" style="display:none;margin-top:2px;background:rgba(15,23,42,0.92);color:#ffffff;padding:1px 5px;border-radius:4px;font-size:10px;font-weight:600;line-height:1.2;text-align:center;white-space:nowrap;border:1px solid rgba(255,255,255,0.3);max-width:120px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 4px rgba(0,0,0,0.25);pointer-events:none;">
                    ${qcagOrdersEscapeHtml(p.outletName)}
                </div>
            </div>
        `;
        const customIcon = L.divIcon({
            className: 'order-map-custom-pin',
            html: pinHtml,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            popupAnchor: [0, -14]
        });

        const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

        const popupContent = `
            <div style="min-width:240px;max-width:280px;font-family:inherit;line-height:1.45;color:#1f2937;">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                    <span style="background:#dc2626;color:#fff;font-weight:700;font-size:10px;padding:2px 6px;border-radius:4px;">#${p.index}</span>
                    <strong style="font-size:13px;color:#111827;">${qcagOrdersEscapeHtml(p.outletName)}</strong>
                </div>
                <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">Mã Outlet: <strong style="color:#059669;">${qcagOrdersEscapeHtml(p.outletCode)}</strong></div>
                <hr style="margin:6px 0;border:none;border-top:1px solid #e5e7eb;">
                <div style="font-size:11px;color:#4b5563;space-y:3px;">
                    <div>Địa chỉ: ${qcagOrdersEscapeHtml(p.address || 'Chưa có')}</div>
                    ${p.saleName ? `<div>Sale: ${qcagOrdersEscapeHtml(p.saleName)} ${p.salePhone ? '(' + qcagOrdersEscapeHtml(p.salePhone) + ')' : ''}</div>` : ''}
                    ${p.area ? `<div>Khu vực: ${qcagOrdersEscapeHtml(p.area)}</div>` : ''}
                </div>
                <div style="margin-top:8px;padding-top:6px;border-top:1px solid #f3f4f6;display:flex;gap:6px;">
                    <a href="${gmapsUrl}" target="_blank" rel="noopener noreferrer" style="flex:1;text-align:center;padding:5px 8px;background:#059669;color:#ffffff;border-radius:6px;font-size:11px;font-weight:600;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;">
                        <span>Chỉ đường trên Google Maps</span> ↗
                    </a>
                </div>
            </div>
        `;

        const tooltipContent = `
            <div style="font-size:11px;font-weight:700;color:#111827;padding:1px 2px;">#${p.index} • ${qcagOrdersEscapeHtml(p.outletName)}</div>
        `;

        const marker = L.marker([lat, lng], { icon: customIcon }).addTo(map);
        marker.bindPopup(popupContent, { autoPan: false, offset: [0, -10] });
        marker.bindTooltip(tooltipContent, { direction: 'top', offset: [0, -14] });

        marker.on('click', () => {
            focusApp2OrderMapPoint(p.id, true);
            const el = document.querySelector(`[data-point-id="${p.id}"]`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });

        _qcagOrderMapMarkers.push({ id: p.id, marker, point: p });
    });

    if (latlngs.length > 0) {
        map.fitBounds(L.latLngBounds(latlngs), { padding: [50, 50], maxZoom: 15, animate: false });
    }

    requestAnimationFrame(() => {
        try { map.invalidateSize(); } catch (_) {}
    });
    setTimeout(() => {
        try { map.invalidateSize(); } catch (_) {}
    }, 200);
}

function toggleApp2OrderMapLabels() {
    const labels = document.querySelectorAll('.order-map-pin-label');
    const textEl = document.getElementById('order-map-toggle-labels-text');
    if (!labels || labels.length === 0) return;
    const isCurrentlyHidden = labels[0].style.display === 'none';
    labels.forEach(lbl => {
        lbl.style.display = isCurrentlyHidden ? 'block' : 'none';
    });
    if (textEl) {
        textEl.textContent = isCurrentlyHidden ? 'Ẩn tên điểm' : 'Hiện tên điểm';
    }
}

function focusApp2OrderMapPoint(pointId, shouldMove = false) {
    if (_qcagCurrentOrderMapActiveMarkerId === pointId && !shouldMove) {
        _qcagCurrentOrderMapActiveMarkerId = null;
        renderApp2OrderMapSidebar();
        document.querySelectorAll('.order-map-badge-circle').forEach(el => {
            el.style.background = 'linear-gradient(135deg,#dc2626 0%,#ef4444 100%)';
            el.style.transform = 'scale(1)';
            el.style.borderColor = '#ffffff';
            el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.42)';
            el.style.zIndex = '1';
        });
        _qcagOrderMapMarkers.forEach(m => {
            if (m.marker && typeof m.marker.setZIndexOffset === 'function') {
                m.marker.setZIndexOffset(0);
            }
        });
        if (_qcagOrderMapInstance) {
            _qcagOrderMapInstance.closePopup();
        }
        return;
    }

    _qcagCurrentOrderMapActiveMarkerId = pointId;
    renderApp2OrderMapSidebar();

    // Reset all marker badges & z-indices
    document.querySelectorAll('.order-map-badge-circle').forEach(el => {
        el.style.background = 'linear-gradient(135deg,#dc2626 0%,#ef4444 100%)';
        el.style.transform = 'scale(1)';
        el.style.borderColor = '#ffffff';
        el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.42)';
        el.style.zIndex = '1';
    });
    _qcagOrderMapMarkers.forEach(m => {
        if (m.marker && typeof m.marker.setZIndexOffset === 'function') {
            m.marker.setZIndexOffset(0);
        }
    });

    const found = _qcagOrderMapMarkers.find(m => m.id === pointId);
    if (found && _qcagOrderMapInstance) {
        if (found.marker && typeof found.marker.setZIndexOffset === 'function') {
            found.marker.setZIndexOffset(10000);
        }
        const markerWrapper = document.querySelector(`[data-marker-id="${pointId}"]`);
        if (markerWrapper && markerWrapper.closest('.leaflet-marker-icon')) {
            markerWrapper.closest('.leaflet-marker-icon').style.zIndex = '10000';
        }

        const markerEl = document.querySelector(`[data-marker-id="${pointId}"] .order-map-badge-circle`);
        if (markerEl) {
            markerEl.style.background = 'linear-gradient(135deg,#d97706 0%,#f59e0b 100%)';
            markerEl.style.transform = 'scale(1.35)';
            markerEl.style.borderColor = '#fef3c7';
            markerEl.style.boxShadow = '0 0 0 3px rgba(245,158,11,0.55), 0 3px 8px rgba(0,0,0,0.45)';
            markerEl.style.zIndex = '1000';
        }

        if (shouldMove) {
            const latLng = found.marker.getLatLng();
            const targetZoom = Math.max(_qcagOrderMapInstance.getZoom(), 15);
            _qcagOrderMapInstance.setView(latLng, targetZoom, { animate: true, duration: 0.35 });
            found.marker.openPopup();
        } else {
            _qcagOrderMapInstance.closePopup();
        }
    } else {
        const pt = _qcagCurrentOrderMapPoints.find(p => p.id === pointId);
        if (pt && !pt.hasGps && typeof showToast === 'function') {
            showToast(`Điểm bán "${pt.outletName}" chưa có toạ độ khảo sát GPS.`);
        }
    }
}

function openAllApp2OrderPointsOnGoogleMaps() {
    const gpsPoints = (_qcagCurrentOrderMapPoints || []).filter(p => p.hasGps);
    if (gpsPoints.length === 0) {
        if (typeof showToast === 'function') showToast('Chưa có điểm bán nào có toạ độ GPS trong đơn hàng này.');
        return;
    }

    let orderedPoints = gpsPoints;
    if (gpsPoints.length > 1) {
        const tspResult = solveApp2TspShortestRoute(_qcagCurrentOrderMapPoints);
        if (tspResult && tspResult.route && tspResult.route.length > 0) {
            orderedPoints = tspResult.route;
        }
    }

    const coordsPath = orderedPoints.map(p => `${p.lat},${p.lng}`).join('/');
    const gmapsUrl = `https://www.google.com/maps/dir/${coordsPath}`;

    window.open(gmapsUrl, '_blank', 'noopener,noreferrer');
}

function exportApp2OrderLocationLinks() {
    const points = _qcagCurrentOrderMapPoints || [];
    const badgeEl = document.getElementById('order-map-spo-badge');
    const spoNo = badgeEl ? badgeEl.textContent.trim() : '';
    const orderTitle = spoNo ? `ĐƠN HÀNG ${spoNo}` : 'ĐƠN HÀNG';

    const gpsPoints = points.filter(p => p.hasGps);
    const noGpsPoints = points.filter(p => !p.hasGps);

    if (gpsPoints.length === 0) {
        if (typeof showToast === 'function') showToast('Chưa có điểm bán nào có toạ độ GPS để tải link.');
        return;
    }

    let text = `DANH SÁCH ĐỊNH VỊ — ${orderTitle}\n\n`;
    gpsPoints.forEach((p, idx) => {
        const gmapsLink = `https://www.google.com/maps?q=${p.lat},${p.lng}`;
        const outletPhoneStr = p.phone ? ` - ${p.phone}` : '';
        const saleStr = p.saleName ? `${p.saleName}${p.salePhone ? ' - ' + p.salePhone : ''}` : 'Chưa có';

        text += `${idx + 1}. ${p.outletName}${outletPhoneStr}\n`;
        text += `   Sale: ${saleStr}\n`;
        text += `   Định vị: ${gmapsLink}\n\n`;
    });

    if (noGpsPoints.length > 0) {
        text += `------------------------------------\n`;
        text += `ĐIỂM BÁN CHƯA CÓ ĐỊNH VỊ:\n\n`;
        noGpsPoints.forEach((p, idx) => {
            const outletPhoneStr = p.phone ? ` - ${p.phone}` : '';
            const saleStr = p.saleName ? `${p.saleName}${p.salePhone ? ' - ' + p.salePhone : ''}` : 'Chưa có';
            text += `${gpsPoints.length + idx + 1}. ${p.outletName}${outletPhoneStr}\n`;
            text += `   Sale: ${saleStr}\n`;
            text += `   Định vị: (Chưa có toạ độ GPS)\n\n`;
        });
    }

    const cleanTitle = orderTitle.replace(/[^\w\s\u00C0-\u1EF9-]/g, '').trim().replace(/\s+/g, '_');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Link_Dinh_Vi_${cleanTitle}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (typeof showToast === 'function') showToast('Đã tải xuống file danh sách link định vị Google Maps!');
}

function setupApp2OrderMapEvents() {
    const closeBtn = document.getElementById('close-order-locations-map-modal');
    if (closeBtn && !closeBtn._bound) {
        closeBtn._bound = true;
        closeBtn.addEventListener('click', closeOrderLocationsMapModal);
    }

    const toggleRouteBtn = document.getElementById('order-map-toggle-route-btn');
    if (toggleRouteBtn && !toggleRouteBtn._bound) {
        toggleRouteBtn._bound = true;
        toggleRouteBtn.addEventListener('click', toggleApp2OrderMapRoute);
    }

    const gmapsAllBtn = document.getElementById('order-map-open-gmaps-all-btn');
    if (gmapsAllBtn && !gmapsAllBtn._bound) {
        gmapsAllBtn._bound = true;
        gmapsAllBtn.addEventListener('click', openAllApp2OrderPointsOnGoogleMaps);
    }

    const exportLinksBtn = document.getElementById('order-map-export-links-btn');
    if (exportLinksBtn && !exportLinksBtn._bound) {
        exportLinksBtn._bound = true;
        exportLinksBtn.addEventListener('click', exportApp2OrderLocationLinks);
    }

    const toggleLabelsBtn = document.getElementById('order-map-toggle-labels-btn');
    if (toggleLabelsBtn && !toggleLabelsBtn._bound) {
        toggleLabelsBtn._bound = true;
        toggleLabelsBtn.addEventListener('click', toggleApp2OrderMapLabels);
    }

    const fitBtn = document.getElementById('order-map-fit-bounds-btn');
    if (fitBtn && !fitBtn._bound) {
        fitBtn._bound = true;
        fitBtn.addEventListener('click', () => {
            if (_qcagOrderMapInstance && _qcagOrderMapMarkers.length > 0) {
                const latlngs = _qcagOrderMapMarkers.map(m => m.marker.getLatLng());
                if (_qcagOrderMapDepotMarker) {
                    latlngs.push(_qcagOrderMapDepotMarker.getLatLng());
                }
                _qcagOrderMapInstance.fitBounds(L.latLngBounds(latlngs), { padding: [50, 50], maxZoom: 15 });
            }
        });
    }

    const searchInp = document.getElementById('order-map-search-input');
    if (searchInp && !searchInp._bound) {
        searchInp._bound = true;
        searchInp.addEventListener('input', (e) => {
            _qcagCurrentOrderMapSearch = e.target.value;
            renderApp2OrderMapSidebar();
        });
    }

    const filterBtns = document.querySelectorAll('.order-map-filter-btn');
    filterBtns.forEach(btn => {
        if (btn._bound) return;
        btn._bound = true;
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => {
                b.classList.remove('bg-white', 'dark:bg-slate-700', 'text-emerald-700', 'dark:text-emerald-300', 'shadow-xs', 'font-semibold');
                b.classList.add('text-gray-600', 'dark:text-gray-400', 'font-medium');
            });
            btn.classList.remove('text-gray-600', 'dark:text-gray-400', 'font-medium');
            btn.classList.add('bg-white', 'dark:bg-slate-700', 'text-emerald-700', 'dark:text-emerald-300', 'shadow-xs', 'font-semibold');

            _qcagCurrentOrderMapFilter = btn.dataset.filter || 'all';
            renderApp2OrderMapSidebar();
        });
    });
}

if (typeof window !== 'undefined') {
    window.qcagGetOrdersApiBase = qcagGetOrdersApiBase;
    window.qcagFetchProductionOrders = qcagFetchProductionOrders;
    window.qcagRenderProductionOrdersTable = qcagRenderProductionOrdersTable;
    window.qcagOrdersOnSearch = qcagOrdersOnSearch;
    window.qcagOrdersChangePage = qcagOrdersChangePage;
    window.qcagOrdersSetPage = qcagOrdersSetPage;
    window.qcagDesktopOpenProductionOrderWorkspace = qcagDesktopOpenProductionOrderWorkspace;
    window.qcagOpenProductionOrderDetail = qcagOpenProductionOrderDetail;
    window.qcagExportProductionOrderPdf = qcagExportProductionOrderPdf;
    window.qcagLocateProductionOrder = qcagLocateProductionOrder;
    window.openOrderLocationsMap = openOrderLocationsMap;
    window.closeOrderLocationsMapModal = closeOrderLocationsMapModal;
    window.focusApp2OrderMapPoint = focusApp2OrderMapPoint;
    window.toggleApp2OrderMapRoute = toggleApp2OrderMapRoute;
    window.solveApp2TspShortestRoute = solveApp2TspShortestRoute;
    window.setApp2OrderMapStartDepot = setApp2OrderMapStartDepot;
}
