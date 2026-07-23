/**
 * App 2 Mobile Heineken — Production Approval Flow (Sale Duyệt Sản Xuất)
 * ======================================================================
 * Manages the workflow where quotations added to App 1's pending list
 * are presented to Sale Heineken for construction approval (Swipe to Approve / Edit Request / Reject).
 */

let _productionApprovalItems = [];
let _productionApprovalTab = 'pending'; // 'pending' | 'approved' | 'rejected'
let _currentZoomScale = 1;
let _currentPanX = 0;
let _currentPanY = 0;
let _isPanningImg = false;

function getProductionApprovalItems() {
    return _productionApprovalItems;
}

function normalizeSaleName(s) {
    try {
        return String(s || '').toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\(sale\)/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    } catch (_) {
        return String(s || '').toLowerCase().trim();
    }
}

function getBrandBadgeClass(brand) {
    const b = String(brand || '').toLowerCase().trim();
    if (b.includes('tiger')) {
        return 'bg-blue-600/30 text-blue-300 border border-blue-500/50';
    }
    if (b.includes('heineken')) {
        return 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/50';
    }
    if (b.includes('larue')) {
        return 'bg-amber-600/30 text-amber-300 border border-amber-500/50';
    }
    if (b.includes('bivina') || b.includes('bia việt') || b.includes('bia viet')) {
        return 'bg-red-600/30 text-red-300 border border-red-500/50';
    }
    if (b.includes('edelweiss')) {
        return 'bg-cyan-600/30 text-cyan-300 border border-cyan-500/50';
    }
    if (b.includes('strongbow')) {
        return 'bg-yellow-600/30 text-yellow-300 border border-yellow-500/50';
    }
    return 'bg-amber-500/20 text-amber-300 border border-amber-500/30';
}

function parseMqDesignImages(item) {
    let images = [];
    const rawDesign = item.designImages || item.design_images;
    if (rawDesign) {
        if (Array.isArray(rawDesign)) images = images.concat(rawDesign);
        else if (typeof rawDesign === 'string') {
            try { const p = JSON.parse(rawDesign); if (Array.isArray(p)) images = images.concat(p); } catch(_) {}
        }
    }
    const rawImages = item.images;
    if (rawImages) {
        let arr = [];
        if (Array.isArray(rawImages)) arr = rawImages;
        else if (typeof rawImages === 'string') {
            try { arr = JSON.parse(rawImages); } catch(_) {}
        }
        if (Array.isArray(arr)) {
            arr.forEach(img => {
                if (typeof img === 'string' && img.startsWith('http')) images.push(img);
                else if (img && typeof img.data === 'string' && img.data.startsWith('http')) images.push(img.data);
                else if (img && typeof img.url === 'string' && img.url.startsWith('http')) images.push(img.url);
            });
        }
    }
    const qcagUrl = item.qcag_image_url || item.qcagImageUrl;
    if (qcagUrl && typeof qcagUrl === 'string' && qcagUrl.startsWith('http')) images.push(qcagUrl);
    return Array.from(new Set(images.filter(img => typeof img === 'string' && img !== '...' && img.startsWith('http'))));
}

/** Full-Screen MQ Image Lightbox Viewer with Zooming, Drag & Pan, and Integrated 3 Action Buttons */
function openMqImagePreview(url, idKey, itemObj) {
    if (!url) return;
    _currentZoomScale = 1;
    _currentPanX = 0;
    _currentPanY = 0;

    let modal = document.getElementById('mqImageLightboxModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'mqImageLightboxModal';
        modal.className = 'fixed inset-0 z-[9999] bg-black/95 flex flex-col items-center justify-between p-3 select-none backdrop-blur-md';
        document.body.appendChild(modal);
    }

    const item = itemObj || _productionApprovalItems.find(i => (i.__backendId || i.id) == idKey);
    const outletName = item ? (item.outletName || 'Outlet') : 'Outlet';
    const quoteCode = item ? (item.quoteCode || '---') : '---';

    modal.innerHTML = `
        <!-- Top Bar: Title, Zoom & Close Controls -->
        <div class="w-full flex items-center justify-between z-50 pt-2 px-1">
            <div class="flex flex-col">
                <span class="text-xs font-mono font-bold text-gray-300">MÃ BÁO GIÁ: ${escapeHtml(quoteCode)}</span>
                <span class="text-sm font-bold text-white uppercase tracking-wide">${escapeHtml(outletName)}</span>
            </div>
            <div class="flex items-center gap-1.5">
                <button onclick="changeMqZoom(0.35)" class="w-9 h-9 bg-white/15 hover:bg-white/25 active:bg-white/40 text-white rounded-xl flex items-center justify-center font-bold text-base backdrop-blur border border-white/20 shadow" title="Phóng to">+</button>
                <button onclick="changeMqZoom(-0.35)" class="w-9 h-9 bg-white/15 hover:bg-white/25 active:bg-white/40 text-white rounded-xl flex items-center justify-center font-bold text-base backdrop-blur border border-white/20 shadow" title="Thu nhỏ">-</button>
                <button onclick="resetMqZoom()" class="w-9 h-9 bg-white/15 hover:bg-white/25 active:bg-white/40 text-white rounded-xl flex items-center justify-center font-bold text-xs backdrop-blur border border-white/20 shadow" title="Đặt lại">🔄</button>
                <button onclick="closeMqImagePreview()" class="w-9 h-9 bg-red-600/80 hover:bg-red-600 text-white rounded-xl flex items-center justify-center text-lg font-bold shadow-lg" title="Đóng">✕</button>
            </div>
        </div>

        <!-- Center: Zoomable & Draggable MQ Image -->
        <div class="flex-1 w-full flex items-center justify-center overflow-hidden my-2 relative cursor-grab active:cursor-grabbing" onclick="closeMqImagePreview()">
            <img id="mqLightboxImg" src="${escapeHtml(url)}" onmousedown="initMqImagePan(event)" ontouchstart="initMqImagePan(event)" class="max-h-[66vh] max-w-full object-contain rounded-xl shadow-2xl transition-transform duration-75" style="transform: translate(0px, 0px) scale(1);" onclick="event.stopPropagation();">
        </div>

        <!-- Bottom: Integrated 3 Action Buttons inside Lightbox -->
        ${(item && (item.productionApprovalStatus || 'pending') === 'pending') ? `
            <div class="w-full flex items-center gap-2 pb-2 z-50" onclick="event.stopPropagation()">
                <!-- Left: Swipe Slider Button -->
                <div id="swipeContainer_modal_${idKey}" class="flex-1 bg-emerald-950/60 border border-emerald-500/70 backdrop-blur-md rounded-2xl h-[46px] relative flex items-center px-1 overflow-hidden select-none shadow-lg shadow-emerald-500/20">
                    <div id="swipeFill_modal_${idKey}" class="absolute left-0 top-0 bottom-0 bg-gradient-to-r from-emerald-500/20 via-emerald-500/40 to-emerald-400/60 border-r border-emerald-300 rounded-l-2xl transition-all duration-75 pointer-events-none w-0"></div>
                    
                    <div id="swipeKnob_modal_${idKey}" onmousedown="initSwipeDragModal(event, '${idKey}')" ontouchstart="initSwipeDragModal(event, '${idKey}')" class="w-9 h-9 bg-emerald-500 text-white rounded-xl flex items-center justify-center font-bold text-xs shadow-md shadow-emerald-500/50 cursor-grab active:cursor-grabbing z-10 transition-transform">
                        ≫
                    </div>
                    <div id="swipeLabel_modal_${idKey}" class="absolute inset-0 flex items-center justify-center text-xs font-bold text-emerald-300 pointer-events-none pl-5 pr-1 text-center whitespace-nowrap overflow-hidden text-ellipsis tracking-wide transition-opacity">
                        Vuốt đồng ý
                    </div>
                </div>

                <!-- Middle: Edit Request Button -->
                <button onclick="closeMqImagePreview(); promptRequestEditProduction('${idKey}')" class="bg-amber-950/60 hover:bg-amber-900/80 active:bg-amber-800 border border-amber-500/70 backdrop-blur-md text-amber-300 font-bold text-xs h-[46px] px-3.5 rounded-2xl flex items-center justify-center shadow-lg shadow-amber-500/20 transition-all flex-shrink-0 whitespace-nowrap">
                    Sửa
                </button>

                <!-- Right: Reject Button -->
                <button onclick="closeMqImagePreview(); promptRejectProduction('${idKey}')" class="bg-red-950/60 hover:bg-red-900/80 active:bg-red-800 border border-red-500/70 backdrop-blur-md text-red-300 font-bold text-xs h-[46px] px-3.5 rounded-2xl flex items-center justify-center shadow-lg shadow-red-500/20 transition-all flex-shrink-0 whitespace-nowrap">
                    Từ chối
                </button>
            </div>
        ` : ''}
    `;

    modal.classList.remove('hidden');
}

function updateMqImageTransform() {
    const img = document.getElementById('mqLightboxImg');
    if (!img) return;
    if (_currentZoomScale <= 1) {
        _currentPanX = 0;
        _currentPanY = 0;
    }
    img.style.transform = `translate(${_currentPanX}px, ${_currentPanY}px) scale(${_currentZoomScale})`;
}

function changeMqZoom(delta) {
    _currentZoomScale += delta;
    if (_currentZoomScale < 0.8) _currentZoomScale = 0.8;
    if (_currentZoomScale > 4.5) _currentZoomScale = 4.5;
    updateMqImageTransform();
}

function resetMqZoom() {
    _currentZoomScale = 1;
    _currentPanX = 0;
    _currentPanY = 0;
    updateMqImageTransform();
}

function initMqImagePan(event) {
    if (event) event.stopPropagation();
    if (_currentZoomScale <= 1) return; // Only pan when zoomed in

    _isPanningImg = true;
    const startPageX = event.type.startsWith('touch') ? event.touches[0].clientX : event.clientX;
    const startPageY = event.type.startsWith('touch') ? event.touches[0].clientY : event.clientY;

    const origPanX = _currentPanX;
    const origPanY = _currentPanY;

    function onPanMove(e) {
        if (!_isPanningImg) return;
        const curPageX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
        const curPageY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;

        _currentPanX = origPanX + (curPageX - startPageX);
        _currentPanY = origPanY + (curPageY - startPageY);
        updateMqImageTransform();
    }

    function onPanEnd() {
        _isPanningImg = false;
        window.removeEventListener('mousemove', onPanMove);
        window.removeEventListener('mouseup', onPanEnd);
        window.removeEventListener('touchmove', onPanMove);
        window.removeEventListener('touchend', onPanEnd);
    }

    window.addEventListener('mousemove', onPanMove);
    window.addEventListener('mouseup', onPanEnd);
    window.addEventListener('touchmove', onPanMove);
    window.addEventListener('touchend', onPanEnd);
}

function closeMqImagePreview() {
    const modal = document.getElementById('mqImageLightboxModal');
    if (modal) modal.classList.add('hidden');
    resetMqZoom();
}

function extractQuotesFromPendingOrdersPayload(ordersList) {
    const results = [];
    if (!Array.isArray(ordersList)) return results;

    ordersList.forEach(order => {
        if (!order) return;
        let quotes = [];
        if (Array.isArray(order.quotes)) {
            quotes = order.quotes;
        } else if (typeof order.quotes === 'string') {
            try { quotes = JSON.parse(order.quotes); } catch (_) { quotes = []; }
        }

        quotes.forEach(q => {
            if (!q) return;
            const quoteCode = q.quote_code || q.quoteCode || q.id || '---';
            const idKey = 'po_q_' + quoteCode + '_' + (q.outlet_code || q.outletCode || '');
            results.push({
                __backendId: idKey,
                id: idKey,
                quoteCode: quoteCode,
                outletName: q.outlet_name || q.outletName || 'Outlet',
                outletCode: q.outlet_code || q.outletCode || '---',
                saleName: q.sale_name || q.saleName || '',
                ssName: q.ss_name || q.ssName || '',
                requester: q.requester || q.requesterName || order.requester || '',
                region: q.area || q.region || 'S16',
                amount: Number(q.total_amount || q.totalAmount || q.amount) || 0,
                items: q.items || [],
                images: q.images || [],
                designImages: q.design_images || q.designImages || [],
                qcagImageUrl: q.qcag_image_url || q.qcagImageUrl || null,
                productionApprovalStatus: q.productionApprovalStatus || order.productionApprovalStatus || 'pending',
                rejectReason: q.rejectReason || order.rejectReason || null,
                createdAt: q.created_at || order.created_at || new Date().toISOString()
            });
        });
    });
    return results;
}

async function fetchProductionApprovals() {
    let allExtracted = [];

    // 1. Check localStorage backups
    try {
        if (typeof localStorage !== 'undefined') {
            const local1 = localStorage.getItem('pending_orders_v1');
            const local2 = localStorage.getItem('pendingOrders');
            if (local1) allExtracted = allExtracted.concat(extractQuotesFromPendingOrdersPayload(JSON.parse(local1)));
            if (local2) allExtracted = allExtracted.concat(extractQuotesFromPendingOrdersPayload(JSON.parse(local2)));
        }
    } catch (e) { console.warn('LocalStorage parse warning:', e); }

    // 2. Fetch App 1 Backend pending orders
    const app1Base = 'https://qcag-backend-493469512136.asia-southeast1.run.app';
    try {
        const res = await fetch(app1Base + '/pending-orders');
        if (res.ok) {
            const json = await res.json();
            if (json && json.ok && Array.isArray(json.data)) {
                allExtracted = allExtracted.concat(extractQuotesFromPendingOrdersPayload(json.data));
            }
        }
    } catch (e) {
        console.warn('App 1 pending-orders fetch warning:', e);
    }

    // 3. Fetch App 2 Backend production approvals
    const app2Base = (typeof window !== 'undefined' && window.API_BASE_URL) ? String(window.API_BASE_URL).replace(/\/+$/, '') : '';
    try {
        const res2 = await fetch(app2Base + '/api/ks/requests/production-approvals');
        if (res2.ok) {
            const json2 = await res2.json();
            if (json2 && json2.ok && Array.isArray(json2.data)) {
                allExtracted = allExtracted.concat(json2.data);
            }
        }
    } catch (e) {
        console.warn('App 2 production-approvals fetch warning:', e);
    }

    // Deduplicate by quoteCode / id
    const dedupMap = new Map();
    allExtracted.forEach(item => {
        const key = item.quoteCode || item.__backendId || item.id;
        if (!dedupMap.has(key)) {
            dedupMap.set(key, item);
        }
    });

    let finalItems = Array.from(dedupMap.values());

    // 4. STRICT FILTERING BY LOGGED-IN SALE USER ONLY
    if (typeof currentSession !== 'undefined' && currentSession) {
        const userSaleName = normalizeSaleName(currentSession.saleName || currentSession.name || currentSession.username || '');
        const userPhone = String(currentSession.phone || '').trim();

        if (userSaleName) {
            finalItems = finalItems.filter(item => {
                const itemSale = normalizeSaleName(item.saleName || '');
                const itemRequester = normalizeSaleName(item.requester || '');

                if (itemSale) {
                    return itemSale.includes(userSaleName) || userSaleName.includes(itemSale);
                }
                if (itemRequester) {
                    return itemRequester.includes(userSaleName) || userSaleName.includes(itemRequester);
                }
                return false; // Strictly hide quotes that do not belong to this logged-in Sale!
            });
        }
    }

    _productionApprovalItems = finalItems;
    updateProductionApprovalBadge();
    const modal = document.getElementById('productionApprovalModal');
    if (modal && !modal.classList.contains('hidden')) {
        renderProductionApprovalList();
    }
}

function updateProductionApprovalBadge() {
    const badge = document.getElementById('productionApprovalBadge');
    if (!badge) return;
    const pendingCount = _productionApprovalItems.filter(i => (i.productionApprovalStatus || 'pending') === 'pending').length;
    if (pendingCount > 0) {
        badge.textContent = String(pendingCount);
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function openProductionApprovalModal() {
    const modal = document.getElementById('productionApprovalModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    _productionApprovalTab = 'pending';
    fetchProductionApprovals();
    renderProductionApprovalList();
}

function closeProductionApprovalModal() {
    const modal = document.getElementById('productionApprovalModal');
    if (modal) modal.classList.add('hidden');
}

function setProductionApprovalTab(tab) {
    _productionApprovalTab = tab;
    // Update tab styling
    ['pending', 'approved', 'rejected'].forEach(t => {
        const btn = document.getElementById('prodAppTab_' + t);
        if (btn) {
            if (t === tab) {
                btn.className = 'flex-1 py-3 text-center text-sm font-bold text-orange-400 border-b-2 border-orange-500 transition-colors';
            } else {
                btn.className = 'flex-1 py-3 text-center text-sm font-medium text-gray-400 hover:text-gray-200 border-b-2 border-transparent transition-colors';
            }
        }
    });
    renderProductionApprovalList();
}

function formatVnd(val) {
    const num = Number(val) || 0;
    return num.toLocaleString('vi-VN') + ' đ';
}

function showRejectionReasonTooltip(reason) {
    alert('🔴 Lý do từ chối sản xuất:\n\n' + (reason || 'Chưa nhập lý do từ chối'));
}

function renderProductionApprovalList() {
    const container = document.getElementById('productionApprovalList');
    if (!container) return;

    // Update counts on tabs
    const pendingItems = _productionApprovalItems.filter(i => (i.productionApprovalStatus || 'pending') === 'pending');
    const approvedItems = _productionApprovalItems.filter(i => i.productionApprovalStatus === 'approved');
    const rejectedItems = _productionApprovalItems.filter(i => i.productionApprovalStatus === 'rejected');

    const countPendingEl = document.getElementById('prodAppCount_pending');
    const countApprovedEl = document.getElementById('prodAppCount_approved');
    const countRejectedEl = document.getElementById('prodAppCount_rejected');

    if (countPendingEl) countPendingEl.textContent = String(pendingItems.length);
    if (countApprovedEl) countApprovedEl.textContent = String(approvedItems.length);
    if (countRejectedEl) countRejectedEl.textContent = String(rejectedItems.length);

    let displayList = [];
    if (_productionApprovalTab === 'pending') displayList = pendingItems;
    else if (_productionApprovalTab === 'approved') displayList = approvedItems;
    else if (_productionApprovalTab === 'rejected') displayList = rejectedItems;

    if (!displayList.length) {
        container.innerHTML = `
            <div class="py-16 text-center text-gray-500 text-sm">
                Không có báo giá nào trong danh sách ${_productionApprovalTab === 'pending' ? 'chờ duyệt' : (_productionApprovalTab === 'approved' ? 'đã đồng ý' : 'đã từ chối')}.
            </div>
        `;
        return;
    }

    let html = '';
    displayList.forEach((item, idx) => {
        const idKey = item.__backendId || item.id || idx;
        const quoteCode = item.quoteCode || item.tkCode || '---';
        const amountStr = formatVnd(item.amount || item.totalAmount || 0);
        const outletName = item.outletName || 'Outlet';
        const outletCode = item.outletCode || '---';
        const region = item.region || 'S16';
        const rejectReason = item.rejectReason || item.production_reject_reason || '';

        // Parse items list
        let itemsList = [];
        try {
            itemsList = typeof item.items === 'string' ? JSON.parse(item.items) : (Array.isArray(item.items) ? item.items : []);
        } catch (_) { itemsList = []; }

        // Parse MQ images using robust helper
        const mqImages = parseMqDesignImages(item);

        html += `
            <div class="bg-[#1b2433] border border-gray-700/60 rounded-2xl p-4 mb-4 shadow-lg text-white relative">
                <!-- Header Row -->
                <div class="flex justify-between items-center mb-1">
                    <div class="flex items-center gap-1.5">
                        <span class="text-xs font-mono font-bold tracking-wider text-gray-300">MÃ BÁO GIÁ: ${escapeHtml(quoteCode)}</span>
                        ${rejectReason ? `
                            <span onclick="showRejectionReasonTooltip('${escapeHtml(rejectReason)}')" class="inline-flex items-center cursor-pointer group" title="Rê chuột/Chạm để xem lý do từ chối">
                                <span class="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shadow-sm"></span>
                            </span>
                        ` : ''}
                    </div>
                    <span class="text-sm font-bold text-orange-400">${amountStr}</span>
                </div>
                <!-- Outlet Row -->
                <div class="mb-3">
                    <h4 class="text-base font-bold text-white uppercase tracking-wide">${escapeHtml(outletName)}</h4>
                    <div class="text-xs text-gray-400">${escapeHtml(outletCode)} · ${escapeHtml(region)}</div>
                </div>

                <!-- Items & MQ Content Box -->
                <div class="bg-[#111827] rounded-xl p-3 mb-3 border border-gray-800 space-y-3">
                    <!-- 1. MQ Design Image (TOP - CENTERED HORIZONTALLY, NO ICON / NO HEADER TEXT) -->
                    ${mqImages.length > 0 ? `
                        <div class="w-full flex justify-center items-center py-1">
                            <div class="flex gap-2 overflow-x-auto justify-center items-center max-w-full">
                                ${mqImages.map(img => `
                                    <img src="${escapeHtml(img)}" onclick="openMqImagePreview('${escapeHtml(img)}', '${idKey}')" class="max-h-56 w-auto max-w-full rounded-xl border border-gray-700/80 object-contain shadow-md cursor-pointer hover:opacity-95 transition-opacity" alt="MQ Design">
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}

                    <!-- 2. Bullet Items List (BOTTOM - WITH DESKTOP QCAG BRAND BADGE COLORS) -->
                    <div class="${mqImages.length > 0 ? 'pt-2 border-t border-gray-800/80' : ''} space-y-1.5">
                        ${itemsList.length > 0 ? itemsList.map(it => {
                            const brand = it.brand || it.brandName || '';
                            const brandClass = getBrandBadgeClass(brand);
                            return `
                                <div class="text-xs text-gray-300 flex items-start gap-1.5">
                                    <span class="text-orange-400 mt-0.5">•</span>
                                    <span class="flex-1">${escapeHtml(it.name || it.type || it.content || 'Hạng mục thi công')} ${it.size ? `(${escapeHtml(it.size)})` : ''}</span>
                                    ${brand ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded-lg ${brandClass}">${escapeHtml(brand)}</span>` : ''}
                                </div>
                            `;
                        }).join('') : '<div class="text-xs text-gray-400 italic">• Hạng mục sản xuất & thi công theo báo giá</div>'}
                    </div>
                </div>

                <!-- Unified 1-Row Action Control Bar (Comfortable Height 46px, Glassmorphism Glow, NO Icons) -->
                ${_productionApprovalTab === 'pending' ? `
                    <div class="flex items-center gap-2 mt-3 w-full">
                        <!-- Left: Swipe Slider Button (Height 46px) -->
                        <div id="swipeContainer_${idKey}" class="flex-1 bg-emerald-950/40 border border-emerald-500/70 backdrop-blur-md rounded-2xl h-[46px] relative flex items-center px-1 overflow-hidden select-none shadow-md shadow-emerald-500/10">
                            <!-- Gradient Progress Fill Bar -->
                            <div id="swipeFill_${idKey}" class="absolute left-0 top-0 bottom-0 bg-gradient-to-r from-emerald-500/20 via-emerald-500/40 to-emerald-400/60 border-r border-emerald-300 rounded-l-2xl transition-all duration-75 pointer-events-none w-0"></div>
                            
                            <!-- Knob -->
                            <div id="swipeKnob_${idKey}" onmousedown="initSwipeDrag(event, '${idKey}')" ontouchstart="initSwipeDrag(event, '${idKey}')" class="w-9 h-9 bg-emerald-500 text-white rounded-xl flex items-center justify-center font-bold text-xs shadow-md shadow-emerald-500/50 cursor-grab active:cursor-grabbing z-10 transition-transform">
                                ≫
                            </div>
                            <div id="swipeLabel_${idKey}" class="absolute inset-0 flex items-center justify-center text-xs font-bold text-emerald-300 pointer-events-none pl-5 pr-1 text-center whitespace-nowrap overflow-hidden text-ellipsis tracking-wide transition-opacity">
                                Vuốt đồng ý
                            </div>
                        </div>

                        <!-- Middle: Edit Request Button (No Icon) -->
                        <button onclick="promptRequestEditProduction('${idKey}')" class="bg-amber-950/40 hover:bg-amber-900/60 active:bg-amber-800/80 border border-amber-500/70 backdrop-blur-md text-amber-300 font-bold text-xs h-[46px] px-3.5 rounded-2xl flex items-center justify-center shadow-md shadow-amber-500/10 transition-all flex-shrink-0 whitespace-nowrap">
                            Sửa
                        </button>

                        <!-- Right: Reject Button (No Icon) -->
                        <button onclick="promptRejectProduction('${idKey}')" class="bg-red-950/40 hover:bg-red-900/60 active:bg-red-800/80 border border-red-500/70 backdrop-blur-md text-red-300 font-bold text-xs h-[46px] px-3.5 rounded-2xl flex items-center justify-center shadow-md shadow-red-500/10 transition-all flex-shrink-0 whitespace-nowrap">
                            Từ chối
                        </button>
                    </div>
                ` : `
                    <div class="text-xs text-right font-semibold flex items-center justify-end gap-1.5 ${item.productionApprovalStatus === 'approved' ? 'text-emerald-400' : 'text-red-400'}">
                        ${item.productionApprovalStatus === 'approved' ? '✓ Đã đồng ý sản xuất' : `
                            <span class="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse cursor-pointer" onclick="showRejectionReasonTooltip('${escapeHtml(rejectReason)}')"></span>
                            <span>✕ Đã từ chối: ${escapeHtml(rejectReason || 'Không đồng ý')}</span>
                        `}
                    </div>
                `}
            </div>
        `;
    });

    container.innerHTML = html;
}

/** Swipe Drag Logic for Main Card List */
function initSwipeDrag(event, idKey) {
    event.preventDefault();
    const knob = document.getElementById('swipeKnob_' + idKey);
    const container = document.getElementById('swipeContainer_' + idKey);
    const fill = document.getElementById('swipeFill_' + idKey);
    const label = document.getElementById('swipeLabel_' + idKey);
    if (!knob || !container) return;

    const maxDrag = container.clientWidth - knob.clientWidth - 8;
    const startX = event.type.startsWith('touch') ? event.touches[0].clientX : event.clientX;

    knob.style.transition = 'none';
    if (fill) fill.style.transition = 'none';

    function onMove(e) {
        const currentX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
        let deltaX = currentX - startX;
        if (deltaX < 0) deltaX = 0;
        if (deltaX > maxDrag) deltaX = maxDrag;

        knob.style.transform = `translateX(${deltaX}px) scale(1.05)`;
        if (fill) fill.style.width = (deltaX + 24) + 'px';
        if (label) label.style.opacity = String(Math.max(0, 1 - (deltaX / maxDrag) * 1.5));

        if (deltaX >= maxDrag - 2) {
            cleanup();
            knob.style.transform = `translateX(${maxDrag}px) scale(1.1)`;
            if (fill) fill.style.width = '100%';
            approveProductionItem(idKey);
        }
    }

    function onEnd() {
        cleanup();
        knob.style.transition = 'transform 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.25)';
        knob.style.transform = 'translateX(0px) scale(1)';
        if (fill) { fill.style.transition = 'width 0.3s ease-out'; fill.style.width = '0px'; }
        if (label) { label.style.transition = 'opacity 0.25s ease-out'; label.style.opacity = '1'; }
        setTimeout(() => { knob.style.transition = ''; if (fill) fill.style.transition = ''; if (label) label.style.transition = ''; }, 360);
    }

    function cleanup() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onEnd);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove);
    window.addEventListener('touchend', onEnd);
}

/** Swipe Drag Logic inside Lightbox Image Viewer Modal */
function initSwipeDragModal(event, idKey) {
    event.preventDefault();
    const knob = document.getElementById('swipeKnob_modal_' + idKey);
    const container = document.getElementById('swipeContainer_modal_' + idKey);
    const fill = document.getElementById('swipeFill_modal_' + idKey);
    const label = document.getElementById('swipeLabel_modal_' + idKey);
    if (!knob || !container) return;

    const maxDrag = container.clientWidth - knob.clientWidth - 8;
    const startX = event.type.startsWith('touch') ? event.touches[0].clientX : event.clientX;

    knob.style.transition = 'none';
    if (fill) fill.style.transition = 'none';

    function onMove(e) {
        const currentX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
        let deltaX = currentX - startX;
        if (deltaX < 0) deltaX = 0;
        if (deltaX > maxDrag) deltaX = maxDrag;

        knob.style.transform = `translateX(${deltaX}px) scale(1.05)`;
        if (fill) fill.style.width = (deltaX + 24) + 'px';
        if (label) label.style.opacity = String(Math.max(0, 1 - (deltaX / maxDrag) * 1.5));

        if (deltaX >= maxDrag - 2) {
            cleanup();
            knob.style.transform = `translateX(${maxDrag}px) scale(1.1)`;
            if (fill) fill.style.width = '100%';
            closeMqImagePreview();
            approveProductionItem(idKey);
        }
    }

    function onEnd() {
        cleanup();
        knob.style.transition = 'transform 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.25)';
        knob.style.transform = 'translateX(0px) scale(1)';
        if (fill) { fill.style.transition = 'width 0.3s ease-out'; fill.style.width = '0px'; }
        if (label) { label.style.transition = 'opacity 0.25s ease-out'; label.style.opacity = '1'; }
        setTimeout(() => { knob.style.transition = ''; if (fill) fill.style.transition = ''; if (label) label.style.transition = ''; }, 360);
    }

    function cleanup() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onEnd);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove);
    window.addEventListener('touchend', onEnd);
}

function approveProductionItem(idKey) {
    const item = _productionApprovalItems.find(i => (i.__backendId || i.id) == idKey);
    if (!item) return;

    item.productionApprovalStatus = 'approved';
    item.approvedAt = new Date().toISOString();
    
    // Notify API backend
    const base = (typeof window !== 'undefined' && window.API_BASE_URL) ? String(window.API_BASE_URL).replace(/\/+$/, '') : '';
    fetch(base + '/api/ks/requests/' + encodeURIComponent(idKey) + '/approve-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'approved',
            approvedBy: (typeof currentSession !== 'undefined' && currentSession ? (currentSession.saleName || currentSession.phone) : 'Sale Heineken')
        })
    }).catch(err => console.warn('Approve API error:', err));

    // Trigger native App 2 toast notification (dark background with orange border & green checkmark)
    const msg = '✅ Bạn đã xác nhận thi công ' + (item.outletName || 'Outlet');
    if (typeof showToast === 'function') {
        showToast(msg);
    } else {
        alert(msg);
    }

    renderProductionApprovalList();
    updateProductionApprovalBadge();
}

/** Edit Request Handler (Gửi Yêu Cầu Sửa Về Desktop QCAG) */
function promptRequestEditProduction(idKey) {
    const item = _productionApprovalItems.find(i => (i.__backendId || i.id) == idKey);
    if (!item) return;

    window.__pendingEditIdKey = idKey;
    const modal = document.getElementById('requestEditNoteModal');
    if (modal) {
        document.getElementById('requestEditNoteInput').value = '';
        modal.classList.remove('hidden');
    } else {
        const note = prompt('Vui lòng nhập nội dung cần chỉnh sửa (sẽ gửi về Desktop QCAG):');
        if (note !== null) {
            confirmRequestEditProduction(idKey, note);
        }
    }
}

function closeRequestEditNoteModal() {
    const modal = document.getElementById('requestEditNoteModal');
    if (modal) modal.classList.add('hidden');
}

function submitRequestEditNote() {
    const idKey = window.__pendingEditIdKey;
    const input = document.getElementById('requestEditNoteInput');
    const note = input ? input.value.trim() : '';
    if (!note) {
        alert('Vui lòng nhập nội dung cần chỉnh sửa.');
        return;
    }
    closeRequestEditNoteModal();
    if (idKey) confirmRequestEditProduction(idKey, note);
}

function confirmRequestEditProduction(idKey, note) {
    const item = _productionApprovalItems.find(i => (i.__backendId || i.id) == idKey);
    if (!item) return;

    item.productionApprovalStatus = 'pending-edit';
    item.status = 'pending-edit';
    item.rejectReason = String(note || 'Yêu cầu chỉnh sửa').trim();

    // Send edit request to Desktop QCAG
    const base = (typeof window !== 'undefined' && window.API_BASE_URL) ? String(window.API_BASE_URL).replace(/\/+$/, '') : '';
    fetch(base + '/api/ks/requests/' + encodeURIComponent(idKey) + '/request-edit-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            note: item.rejectReason,
            requestedBy: (typeof currentSession !== 'undefined' && currentSession ? (currentSession.saleName || currentSession.phone) : 'Sale Heineken')
        })
    }).catch(err => console.warn('Edit request API error:', err));

    const editMsg = '⚙️ Bạn đã gửi yêu cầu chỉnh sửa ' + (item.outletName || 'Outlet');
    if (typeof showToast === 'function') {
        showToast(editMsg);
    } else {
        alert(editMsg);
    }

    renderProductionApprovalList();
    updateProductionApprovalBadge();
}

/** Rejection Handler with Automatic Deduction from Pending List */
function promptRejectProduction(idKey) {
    const item = _productionApprovalItems.find(i => (i.__backendId || i.id) == idKey);
    if (!item) return;

    const modal = document.getElementById('rejectReasonModal');
    if (modal) {
        window.__pendingRejectIdKey = idKey;
        document.getElementById('rejectReasonInput').value = '';
        modal.classList.remove('hidden');
    } else {
        const reason = prompt('Vui lòng nhập lý do từ chối sản xuất:');
        if (reason !== null) {
            confirmRejectProduction(idKey, reason);
        }
    }
}

function confirmRejectProduction(idKey, reason) {
    const item = _productionApprovalItems.find(i => (i.__backendId || i.id) == idKey);
    if (!item) return;

    item.productionApprovalStatus = 'rejected';
    item.rejectReason = String(reason || 'Không đồng ý sản xuất').trim();
    item.rejectedAt = new Date().toISOString();

    // Deduct / remove from local pending orders state & localStorage
    try {
        if (typeof localStorage !== 'undefined') {
            ['pending_orders_v1', 'pendingOrders'].forEach(storageKey => {
                const raw = localStorage.getItem(storageKey);
                if (raw) {
                    let orders = JSON.parse(raw);
                    if (Array.isArray(orders)) {
                        orders.forEach(order => {
                            if (Array.isArray(order.quotes)) {
                                order.quotes = order.quotes.filter(q => (q.quote_code || q.quoteCode || q.id) != item.quoteCode);
                                order.totalPoints = order.quotes.length;
                                order.totalAmount = order.quotes.reduce((acc, curr) => acc + (Number(curr.total_amount || curr.totalAmount || curr.amount) || 0), 0);
                            }
                        });
                        localStorage.setItem(storageKey, JSON.stringify(orders));
                    }
                }
            });
        }
    } catch (e) {
        console.warn('Deduction localStorage error:', e);
    }

    // Notify API backend
    const base = (typeof window !== 'undefined' && window.API_BASE_URL) ? String(window.API_BASE_URL).replace(/\/+$/, '') : '';
    fetch(base + '/api/ks/requests/' + encodeURIComponent(idKey) + '/reject-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'rejected',
            reason: item.rejectReason,
            rejectedBy: (typeof currentSession !== 'undefined' && currentSession ? (currentSession.saleName || currentSession.phone) : 'Sale Heineken')
        })
    }).catch(err => console.warn('Reject API error:', err));

    const rejectMsg = '❌ Bạn đã từ chối sản xuất ' + (item.outletName || 'Outlet');
    if (typeof showToast === 'function') {
        showToast(rejectMsg);
    } else {
        alert(rejectMsg);
    }

    renderProductionApprovalList();
    updateProductionApprovalBadge();
}

function closeRejectReasonModal() {
    const modal = document.getElementById('rejectReasonModal');
    if (modal) modal.classList.add('hidden');
}

function submitRejectReason() {
    const idKey = window.__pendingRejectIdKey;
    const input = document.getElementById('rejectReasonInput');
    const reason = input ? input.value.trim() : '';
    if (!reason) {
        alert('Vui lòng nhập lý do từ chối.');
        return;
    }
    closeRejectReasonModal();
    if (idKey) confirmRejectProduction(idKey, reason);
}

// Efficient Event-Driven Sync: Fetch ONCE on app load / login & when returning to app (tab focus/visibility).
// ZERO repeated setInterval polling to save 100% server resources and avoid Cloud Run costs!
if (typeof window !== 'undefined') {
    const triggerSingleFetch = () => {
        if (typeof fetchProductionApprovals === 'function') {
            fetchProductionApprovals();
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(triggerSingleFetch, 400);
    });

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(triggerSingleFetch, 200);
    }

    // Refresh ONLY when user returns to / focuses the app tab
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            triggerSingleFetch();
        }
    });

    window.addEventListener('focus', triggerSingleFetch);
}
