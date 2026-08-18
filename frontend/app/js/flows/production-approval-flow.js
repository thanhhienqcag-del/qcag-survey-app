/**
 * App 2 Mobile Heineken — Production Approval Flow (Sale Duyệt Sản Xuất)
 * ======================================================================
 * Manages the workflow where quotations added to App 1's pending list
 * are presented to Sale Heineken for construction approval (Swipe to Approve / Edit Request / Reject).
 */

let _productionApprovalItems = [];
let _productionApprovalBadgeCount = 0;
let _productionApprovalTab = 'pending'; // 'pending' | 'approved' | 'rejected'
let _productionApprovalActive = false;
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

function isNameMatch(n1, n2) {
    const s1 = normalizeSaleName(n1);
    const s2 = normalizeSaleName(n2);
    if (!s1 || !s2) return false;
    return s1 === s2;
}

function isSaleMatch(item, session) {
    if (!session) return true;
    const sessionRole = String(session.role || session.userRole || session.group || '').toLowerCase();
    if (sessionRole.includes('admin') || sessionRole.includes('manager') || sessionRole.includes('qcag') || sessionRole.includes('ss')) {
        return true;
    }
    const sessionCode = String(session.saleCode || session.userCode || '').trim();
    const sessionPhone = String(session.phone || '').replace(/\D/g, '');
    const sessionName = session.saleName || session.name || session.username || '';

    const itemCode = String(item.saleCode || item.sale_code || item.createdBy || item.created_by || '').trim();
    const itemPhone = String(item.salePhone || item.phone || '').replace(/\D/g, '');
    const itemSaleName = item.saleName || item.sale_name || item.createdByName || item.created_by_name || '';
    const itemRequester = item.requester || '';
    const itemSsName = item.ssName || item.ss_name || '';

    // 1. Unique ID match by saleCode
    if (sessionCode && itemCode && sessionCode === itemCode) return true;

    // 2. Unique ID match by phone number
    if (sessionPhone && sessionPhone.length >= 8 && itemPhone && itemPhone.length >= 8 && (sessionPhone.endsWith(itemPhone.slice(-8)) || itemPhone.endsWith(sessionPhone.slice(-8)))) return true;

    // 3. Match by name (sale name, requester, or SS name)
    if (sessionName) {
        if (itemSaleName && (isNameMatch(itemSaleName, sessionName) || isNameMatch(sessionName, itemSaleName))) return true;
        if (itemRequester && (isNameMatch(itemRequester, sessionName) || isNameMatch(sessionName, itemRequester))) return true;
        if (itemSsName && (isNameMatch(itemSsName, sessionName) || isNameMatch(sessionName, itemSsName))) return true;
    }

    return false;
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

function isValidImgUrl(val) {
    if (!val || typeof val !== 'string') return false;
    const s = val.trim();
    if (s === '...' || s === 'null' || s === 'undefined' || s === '[]' || s === '["..."]' || s.length < 5) return false;
    if (s.startsWith('["...') || s.startsWith('[\'...') || s.startsWith('["."') || s.startsWith('[".."')) return false;
    return s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:image/') || s.startsWith('blob:') || s.startsWith('/');
}

function parseMqDesignImages(item) {
    if (!item) return [];

    // Primary design image sources (prioritize design images uploaded by Desktop QCAG / Design)
    const primaryDesignSources = [
        item.designImages,
        item.design_images,
        item.qcag_image_url,
        item.qcagImageUrl,
        item.design,
        item.quote_image_url,
        item.image_url,
        item.images,
        item.image
    ];

    // Also check matched Survey Request (__ksReq) if attached
    if (item.__ksReq) {
        primaryDesignSources.push(
            item.__ksReq.designImages,
            item.__ksReq.design_images,
            item.__ksReq.qcag_image_url,
            item.__ksReq.qcagImageUrl,
            item.__ksReq.design,
            item.__ksReq.images,
            item.__ksReq.statusImages,
            item.__ksReq.status_images
        );
    }

    if (Array.isArray(item.items)) {
        item.items.forEach(it => {
            if (it) {
                if (it.design_images) primaryDesignSources.push(it.design_images);
                if (it.designImages) primaryDesignSources.push(it.designImages);
                if (it.imageUrl) primaryDesignSources.push(it.imageUrl);
                if (it.images) primaryDesignSources.push(it.images);
                if (it.image) primaryDesignSources.push(it.image);
            }
        });
    }

    // Secondary fallback sources
    const fallbackSources = [
        item.survey_image,
        item.survey_images,
        item.surveyImage
    ];

    function extractUrls(sourceList) {
        let rawList = [];
        sourceList.forEach(src => {
            if (!src) return;
            if (Array.isArray(src)) {
                rawList = rawList.concat(src);
            } else if (typeof src === 'string') {
                let trimmed = src.trim();
                if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
                    try {
                        let parsed = JSON.parse(trimmed);
                        // Handle double-stringified JSON
                        if (typeof parsed === 'string' && (parsed.startsWith('[') || parsed.startsWith('{'))) {
                            try { parsed = JSON.parse(parsed); } catch (_) { }
                        }
                        if (Array.isArray(parsed)) rawList = rawList.concat(parsed);
                        else if (typeof parsed === 'object' && parsed !== null) rawList.push(parsed);
                        else if (typeof parsed === 'string' && isValidImgUrl(parsed)) rawList.push(parsed);
                    } catch (_) { }
                } else if (isValidImgUrl(trimmed)) {
                    rawList.push(trimmed);
                }
            } else if (typeof src === 'object' && src !== null) {
                rawList.push(src);
            }
        });

        const clean = [];
        rawList.forEach(img => {
            if (!img) return;
            if (typeof img === 'string') {
                const trimmed = img.trim();
                if (isValidImgUrl(trimmed)) clean.push(trimmed);
            } else if (typeof img === 'object') {
                const url = img.data || img.url || img.src || img.link || img.base64 || img.image || img.img;
                if (typeof url === 'string') {
                    const trimmed = url.trim();
                    if (isValidImgUrl(trimmed)) clean.push(trimmed);
                }
            }
        });
        return Array.from(new Set(clean));
    }

    let result = extractUrls(primaryDesignSources);
    if (!result.length) {
        result = extractUrls(fallbackSources);
    }

    // Return at most 1 single design image
    return result.slice(0, 1);
}

/** Robust Helper to Match a Quote with a Survey Request in allRequests */
function findMatchingKsRequest(q, rawQuoteCode) {
    if (typeof allRequests === 'undefined' || !Array.isArray(allRequests) || allRequests.length === 0) {
        return null;
    }
    const qTk = String(q.tk_code || q.tkCode || '').trim().toLowerCase();
    const qTkDigits = qTk.replace(/\D/g, '');
    const qCode = String(rawQuoteCode || q.quote_code || q.quoteCode || q.id || '').trim().toLowerCase();
    const qCodeDigits = qCode.replace(/\D/g, '');
    const qOutlet = String(q.outlet_code || q.outletCode || '').trim().toLowerCase();
    const qOutletDigits = qOutlet.replace(/\D/g, '');
    const qName = String(q.outlet_name || q.outletName || '').trim().toLowerCase();

    // 1. Match by TK code or Quote Code against r.tkCode / r.quoteCode
    if (qTk || qCode) {
        const byTk = allRequests.find(r => {
            if (!r) return false;
            const rTk = String(r.tkCode || r.tk_code || '').trim().toLowerCase();
            const rTkDigits = rTk.replace(/\D/g, '');
            const rQCode = String(r.quoteCode || r.quote_code || '').trim().toLowerCase();
            const rQDigits = rQCode.replace(/\D/g, '');
            
            if (qTk && rTk && (qTk === rTk || (qTkDigits.length >= 4 && qTkDigits === rTkDigits))) return true;
            if (qCode && rTk && (qCode === rTk || (qCodeDigits.length >= 4 && qCodeDigits === rTkDigits))) return true;
            if (qCode && rQCode && (qCode === rQCode || (qCodeDigits.length >= 4 && qCodeDigits === rQDigits))) return true;
            if (qTk && rQCode && (qTk === rQCode || (qTkDigits.length >= 4 && qTkDigits === rQDigits))) return true;
            return false;
        });
        if (byTk) return byTk;
    }

    // 2. Match by Outlet Code (unique per Heineken outlet)
    if (qOutlet) {
        const byOutlet = allRequests.find(r => {
            if (!r) return false;
            const rOutlet = String(r.outletCode || r.outlet_code || (r.requester && (r.requester.outletCode || r.requester.outlet_code)) || '').trim().toLowerCase();
            const rOutletDigits = rOutlet.replace(/\D/g, '');
            if (qOutlet === rOutlet) return true;
            if (qOutletDigits && qOutletDigits.length >= 5 && qOutletDigits === rOutletDigits) return true;
            return false;
        });
        if (byOutlet) return byOutlet;
    }

    // 3. Match by Outlet Name
    if (qName && qName.length >= 4) {
        const byName = allRequests.find(r => {
            if (!r) return false;
            const rName = String(r.outletName || r.outlet_name || (r.requester && (r.requester.outletName || r.requester.outlet_name)) || '').trim().toLowerCase();
            return rName && (rName === qName || rName.includes(qName) || qName.includes(rName));
        });
        if (byName) return byName;
    }

    return null;
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
                    Chỉnh sửa
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
            const rawQuoteCode = String(q.quote_code || q.quoteCode || q.id || '').trim();
            const rawTkCode = String(q.tk_code || q.tkCode || '').trim();
            const validTkCode = (rawTkCode && rawTkCode !== 'TK26.' && rawTkCode !== 'TK.' && !rawTkCode.endsWith('.')) ? rawTkCode : '';
            const displayCode = rawQuoteCode || validTkCode || '---';
            const idKey = 'po_q_' + displayCode + '_' + (q.outlet_code || q.outletCode || '');

            // Ensure local storage requests are loaded if allRequests is empty in memory
            if ((typeof allRequests === 'undefined' || !Array.isArray(allRequests) || allRequests.length === 0) && typeof loadAllRequestsFromStorage === 'function') {
                try { loadAllRequestsFromStorage(); } catch (_) { }
            }

            // Robust Match with App 2 Survey Requests (ks_requests)
            const ksReq = findMatchingKsRequest(q, rawQuoteCode);

            const resolvedTkCode = String(validTkCode || (ksReq ? (ksReq.tkCode || ksReq.tk_code || '') : '') || '').trim();
            const resolvedQuoteCode = String(rawQuoteCode || resolvedTkCode || '---').trim();
            const resolvedSaleCode = String(q.sale_code || q.saleCode || q.created_by || (order && (order.sale_code || order.saleCode || order.created_by)) || (ksReq ? (ksReq.saleCode || ksReq.sale_code || ksReq.userCode || ksReq.code || '') : '') || '').trim();
            const resolvedSalePhone = String(q.sale_phone || q.salePhone || (order && (order.sale_phone || order.salePhone)) || (ksReq ? (ksReq.phone || ksReq.salePhone || ksReq.sale_phone || '') : '') || '').replace(/\D/g, '');
            const resolvedSaleName = String(q.sale_name || q.saleName || q.created_by_name || (order && (order.created_by_name || order.sale_name)) || (ksReq ? (ksReq.saleName || ksReq.sale_name || ksReq.requester || ksReq.requesterName || ksReq.name || '') : '') || '').trim();
            const resolvedRequester = String(q.requester || q.requesterName || (order && order.requester) || (ksReq ? (ksReq.requester || ksReq.requesterName || resolvedSaleName || '') : '') || '').trim();
            const resolvedSsName = String(q.ss_name || q.ssName || (ksReq ? ksReq.ssName : '') || '').trim();

            // Prioritize direct images on quote payload, fallback to matched survey request
            const quoteImgs = q.images || q.quote_image_url || q.qcag_image_url || q.design_images || q.designImages || (ksReq ? (ksReq.design_images || ksReq.designImages || ksReq.images || ksReq.design || ksReq.qcag_image_url || ksReq.status_images || ksReq.statusImages) : []) || [];
            const designImgs = q.design_images || q.designImages || (ksReq ? (ksReq.design_images || ksReq.designImages || ksReq.design) : null) || (Array.isArray(quoteImgs) && quoteImgs.length > 0 ? quoteImgs : null) || [];

            results.push({
                __backendId: idKey,
                id: idKey,
                quoteCode: resolvedQuoteCode,
                tkCode: resolvedTkCode,
                outletName: q.outlet_name || q.outletName || (ksReq ? ksReq.outletName : 'Outlet'),
                outletCode: q.outlet_code || q.outletCode || (ksReq ? ksReq.outletCode : '---'),
                saleName: resolvedSaleName,
                saleCode: resolvedSaleCode,
                salePhone: resolvedSalePhone,
                ssName: resolvedSsName,
                requester: resolvedRequester,
                region: q.area || q.region || 'S16',
                amount: Number(q.total_amount || q.totalAmount || q.amount) || 0,
                items: q.items || [],
                images: quoteImgs,
                designImages: designImgs,
                design: ksReq ? (ksReq.design || ksReq.designImages || ksReq.design_images) : null,
                qcagImageUrl: q.qcag_image_url || q.qcagImageUrl || (ksReq ? ksReq.qcag_image_url : null) || null,
                productionApprovalStatus: q.productionApprovalStatus || (order && order.productionApprovalStatus) || 'pending',
                rejectReason: q.rejectReason || (order && order.rejectReason) || null,
                createdAt: q.created_at || (order && order.created_at) || new Date().toISOString(),
                __ksReq: ksReq || null,
                __ksReqBackendId: ksReq ? (ksReq.__backendId || ksReq.backend_id || ksReq.id) : null
            });
        });
    });
    return results;
}

/** Automatically Fetch Missing MQ Design Images Asynchronously from App 2 Database / Backend */
async function autoFetchMissingProductionImages() {
    if (!_productionApprovalItems || !_productionApprovalItems.length) return;

    const missingItems = _productionApprovalItems.filter(it => {
        const imgs = parseMqDesignImages(it);
        return imgs.length === 0;
    });

    if (missingItems.length === 0) return;

    let updatedAny = false;
    for (const it of missingItems) {
        try {
            let fullReq = null;
            // 1. If we have a known backend ID of the matched survey request, get it directly
            if (it.__ksReqBackendId && window.dataSdk && typeof window.dataSdk.getOne === 'function') {
                const res = await window.dataSdk.getOne(it.__ksReqBackendId);
                if (res && res.isOk && res.data) fullReq = res.data;
            }

            // 2. Fallback search by outlet code or quote code in App 2 backend
            if (!fullReq && window.dataSdk && typeof window.dataSdk.search === 'function') {
                const searchTerm = it.outletCode && it.outletCode !== '---' ? it.outletCode : (it.quoteCode || it.tkCode);
                if (searchTerm && searchTerm !== '---') {
                    const sRes = await window.dataSdk.search(searchTerm, 5);
                    if (sRes && sRes.isOk && Array.isArray(sRes.data) && sRes.data.length > 0) {
                        fullReq = sRes.data[0];
                    }
                }
            }

            if (fullReq) {
                const dImgs = fullReq.designImages || fullReq.design_images || fullReq.images || fullReq.statusImages;
                if (dImgs && dImgs !== '[]' && dImgs !== '["..."]') {
                    it.designImages = dImgs;
                    it.design_images = dImgs;
                    it.__ksReq = fullReq;
                    updatedAny = true;
                }
            }
        } catch (err) {
            console.warn('[autoFetchMissingProductionImages] Fetch error for item:', it.quoteCode, err);
        }
    }

    if (updatedAny) {
        const modal = document.getElementById('productionApprovalModal');
        if (modal && !modal.classList.contains('hidden')) {
            renderProductionApprovalList();
        }
    }
}

async function fetchProductionApprovals() {
    let allExtracted = [];

    // 1. Fetch App 1 Backend pending orders (full orders with quote images)
    const app1Base = 'https://qcag-backend-493469512136.asia-southeast1.run.app';
    try {
        const sessionCode = (typeof currentSession !== 'undefined' && currentSession) ? (currentSession.saleCode || currentSession.userCode || '') : '';
        const sessionPhone = (typeof currentSession !== 'undefined' && currentSession) ? (currentSession.phone || '') : '';
        let url1 = app1Base + '/pending-orders';
        const params = [];
        if (sessionCode) params.push('sale_code=' + encodeURIComponent(sessionCode));
        if (sessionPhone) params.push('sale_phone=' + encodeURIComponent(sessionPhone));
        if (params.length) url1 += '?' + params.join('&');

        const res = await fetch(url1);
        if (res.ok) {
            const json = await res.json();
            if (json && json.ok && Array.isArray(json.data)) {
                allExtracted = allExtracted.concat(extractQuotesFromPendingOrdersPayload(json.data));
            }
        }
    } catch (e) {
        console.warn('App 1 pending-orders fetch warning:', e);
    }

    // 2. Check localStorage backups
    try {
        if (typeof localStorage !== 'undefined') {
            const local1 = localStorage.getItem('pending_orders_v1');
            const local2 = localStorage.getItem('pendingOrders');
            if (local1) allExtracted = allExtracted.concat(extractQuotesFromPendingOrdersPayload(JSON.parse(local1)));
            if (local2) allExtracted = allExtracted.concat(extractQuotesFromPendingOrdersPayload(JSON.parse(local2)));
        }
    } catch (e) { console.warn('LocalStorage parse warning:', e); }

    // 3. Fetch App 2 Backend production approvals
    const defaultApp2Backend = 'https://ks-backend-493469512136.asia-southeast1.run.app';
    const app2Base = (typeof window !== 'undefined' && (window.API_BASE_URL || (window.__env && window.__env.BACKEND_URL)))
        ? String(window.API_BASE_URL || window.__env.BACKEND_URL).replace(/\/+$/, '')
        : defaultApp2Backend;
    try {
        const res2 = await fetch(app2Base + '/api/ks/requests/production-approvals');
        if (res2.ok) {
            const json2 = await res2.json();
            if (json2 && json2.ok && json2.data) {
                const map = (typeof json2.data === 'object' && !Array.isArray(json2.data)) ? json2.data : {};
                const list = Array.isArray(json2.data) ? json2.data : [];
                allExtracted = allExtracted.concat(list);

                // Merge status map and design_images from backend into allExtracted
                allExtracted.forEach(item => {
                    const rawCode = String(item.quoteCode || item.__backendId || item.id || '').trim();
                    const cleanCode = extractQuoteCodeFromIdKey(rawCode);
                    const tkCode = String(item.tkCode || item.tk_code || '').trim();
                    const outletCode = String(item.outletCode || item.outlet_code || '').trim();

                    const approvalObj = (cleanCode && map[cleanCode]) ||
                        (rawCode && map[rawCode]) ||
                        (tkCode && map[tkCode]) ||
                        (outletCode && map[outletCode]);

                    if (approvalObj) {
                        if (approvalObj.status) item.productionApprovalStatus = approvalObj.status;
                        if (approvalObj.reason) item.rejectReason = approvalObj.reason;
                        if (approvalObj.approvedBy) item.approvedBy = approvalObj.approvedBy;
                        if (approvalObj.approvedAt) item.approvedAt = approvalObj.approvedAt;
                        if (approvalObj.designImages) {
                            item.designImages = approvalObj.designImages;
                            item.design_images = approvalObj.designImages;
                        }
                    }
                });
            }
        }
    } catch (e) {
        console.warn('App 2 production-approvals fetch warning:', e);
    }

    // Merge instant local storage approvals cache
    try {
        if (typeof localStorage !== 'undefined') {
            const localCacheStr = localStorage.getItem('ks_production_approvals_cache');
            if (localCacheStr) {
                const localCache = JSON.parse(localCacheStr);
                let cacheChanged = false;
                allExtracted.forEach(item => {
                    const rawCode = String(item.quoteCode || item.__backendId || item.id || '').trim();
                    const cleanCode = extractQuoteCodeFromIdKey(rawCode);
                    const approvalCacheObj = (cleanCode && localCache[cleanCode]) || (rawCode && localCache[rawCode]);
                    
                    if (approvalCacheObj && approvalCacheObj.status) {
                        if (item.productionApprovalStatus === 'pending' || !item.productionApprovalStatus) {
                            item.productionApprovalStatus = approvalCacheObj.status;
                            if (approvalCacheObj.reason) item.rejectReason = approvalCacheObj.reason;
                            if (approvalCacheObj.approvedAt) item.approvedAt = approvalCacheObj.approvedAt;
                        } else if (item.productionApprovalStatus === approvalCacheObj.status) {
                            // Backend is already synced, prune cache entry
                            if (cleanCode && localCache[cleanCode]) { delete localCache[cleanCode]; cacheChanged = true; }
                            if (rawCode && localCache[rawCode]) { delete localCache[rawCode]; cacheChanged = true; }
                        }
                    }
                });
                if (cacheChanged) {
                    localStorage.setItem('ks_production_approvals_cache', JSON.stringify(localCache));
                }
            }
        }
    } catch (_) { }

    // Deduplicate by quoteCode / id - preserving rich fields (saleCode, salePhone, designImages) if available
    const dedupMap = new Map();
    allExtracted.forEach(item => {
        const key = item.quoteCode || item.__backendId || item.id;
        if (!dedupMap.has(key)) {
            dedupMap.set(key, item);
        } else {
            const existing = dedupMap.get(key);
            if (!existing.saleCode && item.saleCode) existing.saleCode = item.saleCode;
            if (!existing.salePhone && item.salePhone) existing.salePhone = item.salePhone;
            if (!existing.designImages && item.designImages) existing.designImages = item.designImages;
            if (!existing.images && item.images) existing.images = item.images;
            if (!existing.__ksReq && item.__ksReq) existing.__ksReq = item.__ksReq;
        }
    });

    let finalItems = Array.from(dedupMap.values());

    // 4. STRICT FILTERING BY LOGGED-IN SALE USER ONLY
    if (typeof currentSession !== 'undefined' && currentSession) {
        finalItems = finalItems.filter(item => isSaleMatch(item, currentSession));
    }

    _productionApprovalItems = finalItems;
    updateProductionApprovalBadge();

    const modal = document.getElementById('productionApprovalModal');
    if (modal && !modal.classList.contains('hidden')) {
        renderProductionApprovalList();
    }

    // Auto-fetch missing MQ images in background
    autoFetchMissingProductionImages();

    const pendingCount = finalItems.filter(i => (i.productionApprovalStatus || 'pending') === 'pending').length;
    const approvedCount = finalItems.filter(i => i.productionApprovalStatus === 'approved').length;


    try {
        if (window && window.localStorage) {
            window.localStorage.setItem('ks_production_approval_debug', JSON.stringify({
                count: _productionApprovalItems.length,
                sample: _productionApprovalItems.slice(0, 3).map(item => ({
                    quoteCode: item.quoteCode,
                    tkCode: item.tkCode,
                    saleCode: item.saleCode,
                    saleName: item.saleName,
                    salePhone: item.salePhone,
                    status: item.productionApprovalStatus
                }))
            }));
        }
    } catch (_) { }
}

function updateProductionApprovalBadge() {
    const badge = document.getElementById('productionApprovalBadge');
    if (!badge) return;
    const pendingCount = _productionApprovalItems.length > 0
        ? _productionApprovalItems.filter(i => (i.productionApprovalStatus || 'pending') === 'pending').length
        : _productionApprovalBadgeCount;
    if (pendingCount > 0) {
        badge.textContent = String(pendingCount);
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function resolveProductionApprovalBase() {
    const defaultApp2Backend = 'https://ks-backend-493469512136.asia-southeast1.run.app';
    return (typeof window !== 'undefined' && (window.API_BASE_URL || (window.__env && window.__env.BACKEND_URL)))
        ? String(window.API_BASE_URL || window.__env.BACKEND_URL).replace(/\/+$/, '')
        : defaultApp2Backend;
}

function handleMqImageClick(el, idKey) {
    if (!el) return;
    const url = el.getAttribute('data-img-url') || el.src;
    openMqImagePreview(url, idKey);
}

async function fetchProductionApprovalBadgeCount() {
    try {
        await fetchProductionApprovals();
    } catch (e) {
        console.warn('fetchProductionApprovalBadgeCount warning:', e);
    }
}

function openProductionApprovalModal() {
    const modal = document.getElementById('productionApprovalModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    _productionApprovalActive = true;

    // Load local storage requests backup if memory cache is uninitialized
    if ((typeof allRequests === 'undefined' || !Array.isArray(allRequests) || allRequests.length === 0) && typeof loadAllRequestsFromStorage === 'function') {
        try { loadAllRequestsFromStorage(); } catch (_) { }
    }

    // Always set and open 'pending' tab (Chờ duyệt) first
    setProductionApprovalTab('pending');

    fetchProductionApprovals().then(() => {
        renderProductionApprovalList();
    });
}

function closeProductionApprovalModal() {
    const modal = document.getElementById('productionApprovalModal');
    if (modal) modal.classList.add('hidden');
    _productionApprovalActive = false;
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
                                    <img src="${escapeHtml(img)}" data-img-url="${escapeHtml(img)}" onclick="handleMqImageClick(this, '${idKey}')" class="max-h-56 w-auto max-w-full rounded-xl border border-gray-700/80 object-contain shadow-md cursor-pointer hover:opacity-95 transition-opacity" alt="MQ Design">
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

                        <!-- Middle: Edit Request Button -->
                        <button onclick="promptRequestEditProduction('${idKey}')" class="bg-amber-950/40 hover:bg-amber-900/60 active:bg-amber-800/80 border border-amber-500/70 backdrop-blur-md text-amber-300 font-bold text-xs h-[46px] px-3.5 rounded-2xl flex items-center justify-center shadow-md shadow-amber-500/10 transition-all flex-shrink-0 whitespace-nowrap">
                            Chỉnh sửa
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

function extractQuoteCodeFromIdKey(idStr) {
    if (!idStr) return '';
    const str = String(idStr).trim();
    const m = str.match(/po_q_([A-Za-z0-9]+)_/);
    if (m && m[1]) return m[1];
    return str;
}

function approveProductionItem(idKey) {
    const item = _productionApprovalItems.find(i => (i.__backendId || i.id) == idKey);
    if (!item) return;

    item.productionApprovalStatus = 'approved';
    item.approvedAt = new Date().toISOString();

    // Save to instant local storage cache
    try {
        if (typeof localStorage !== 'undefined') {
            const cache = JSON.parse(localStorage.getItem('ks_production_approvals_cache') || '{}');
            const cleanCode = extractQuoteCodeFromIdKey(idKey || item.quoteCode || item.__backendId || item.id);
            const rawCode = String(item.quoteCode || idKey || '').trim();
            const payload = { status: 'approved', approvedAt: item.approvedAt };
            if (cleanCode) cache[cleanCode] = payload;
            if (rawCode) cache[rawCode] = payload;
            localStorage.setItem('ks_production_approvals_cache', JSON.stringify(cache));
        }
    } catch (_) { }

    // Notify API backend
    const cleanTargetCode = extractQuoteCodeFromIdKey(idKey || item.quoteCode) || idKey;
    const base = (typeof window !== 'undefined' && (window.API_BASE_URL || (window.__env && window.__env.BACKEND_URL)))
        ? String(window.API_BASE_URL || window.__env.BACKEND_URL).replace(/\/+$/, '')
        : 'https://ks-backend-493469512136.asia-southeast1.run.app';
    fetch(base + '/api/ks/requests/' + encodeURIComponent(cleanTargetCode) + '/approve-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'approved',
            outletCode: item.outletCode || item.outlet_code || '',
            approvedBy: (typeof currentSession !== 'undefined' && currentSession ? (currentSession.saleName || currentSession.phone) : 'Sale Heineken')
        })
    }).catch(err => console.warn('Approve API error:', err));

    // Trigger native App 2 toast notification
    const msg = '✅ Bạn đã xác nhận thi công ' + (item.outletName || 'Outlet');
    if (typeof showToast === 'function') {
        showToast(msg);
    }

    // In-place UI feedback: replace swipe bar with glowing green success badge immediately
    const actionContainer = document.getElementById('actionContainer_' + idKey);
    if (actionContainer) {
        actionContainer.innerHTML = `
            <div class="w-full text-xs text-center font-semibold flex items-center justify-center gap-1.5 text-emerald-400 py-2.5 px-3 bg-emerald-950/50 border border-emerald-500/60 rounded-2xl animate-pulse shadow-lg shadow-emerald-500/20">
                ✓ Đã đồng ý sản xuất
            </div>
        `;
    }

    updateProductionApprovalBadge();

    // Smoothly collapse card after 1.2s delay so Sale sees clear visual confirmation without sudden disappearance
    setTimeout(() => {
        const card = actionContainer ? actionContainer.closest('.bg-\\[\\#1b2433\\]') : null;
        const remainingPending = _productionApprovalItems.filter(i => (i.productionApprovalStatus || 'pending') === 'pending').length;

        if (card && _productionApprovalTab === 'pending') {
            card.style.transition = 'all 0.4s ease-out';
            card.style.opacity = '0';
            card.style.transform = 'scale(0.95)';
            card.style.maxHeight = '0px';
            card.style.marginBottom = '0px';
            card.style.paddingTop = '0px';
            card.style.paddingBottom = '0px';
            card.style.overflow = 'hidden';
            setTimeout(() => {
                if (remainingPending === 0) {
                    setProductionApprovalTab('approved');
                } else {
                    renderProductionApprovalList();
                }
            }, 420);
        } else {
            if (remainingPending === 0) {
                setProductionApprovalTab('approved');
            } else {
                renderProductionApprovalList();
            }
        }
    }, 1200);
}

/** Edit Request Handler (Gửi Yêu Cầu Sửa Về Desktop QCAG dùng chung openEditRequestSheet) */
function promptRequestEditProduction(idKey) {
    const item = _productionApprovalItems.find(i => (i.__backendId || i.id) == idKey);
    if (!item) return;

    window.__pendingEditIdKey = idKey;

    // Find target request object in allRequests for the unified openEditRequestSheet UI
    let reqObj = item.__ksReq || null;
    if (!reqObj && typeof findMatchingKsRequest === 'function') {
        reqObj = findMatchingKsRequest(item, item.quoteCode);
    }
    if (!reqObj && typeof allRequests !== 'undefined' && Array.isArray(allRequests)) {
        reqObj = allRequests.find(r => {
            if (!r) return false;
            if (r.__backendId && r.__backendId == idKey) return true;
            const rQCode = String(r.quoteCode || r.quote_code || r.backend_id || r.backendId || r.tkCode || r.tk_code || '').trim().toLowerCase();
            const iQCode = String(item.quoteCode || item.tkCode || '').trim().toLowerCase();
            if (rQCode && iQCode && rQCode === iQCode) return true;
            return false;
        });
    }

    if (reqObj) {
        window.currentDetailRequest = { ...reqObj, isProductionApproval: true };
    } else {
        // Fallback placeholder object for Production Approval Flow
        window.currentDetailRequest = {
            __backendId: idKey,
            isProductionApproval: true,
            outletName: item.outletName || 'Outlet',
            outletCode: item.outletCode || '---',
            comments: '[]'
        };
    }

    // Ensure reject sheet is closed before opening edit sheet
    closeProductionRejectSheet();

    // Open unified Edit Request Sheet UI
    if (typeof openEditRequestSheet === 'function') {
        openEditRequestSheet();
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
    const base = (typeof window !== 'undefined' && (window.API_BASE_URL || (window.__env && window.__env.BACKEND_URL)))
        ? String(window.API_BASE_URL || window.__env.BACKEND_URL).replace(/\/+$/, '')
        : 'https://ks-backend-493469512136.asia-southeast1.run.app';
    fetch(base + '/api/ks/requests/' + encodeURIComponent(idKey) + '/request-edit-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            note: item.rejectReason,
            comments: item.rejectReason,
            outletCode: item.outletCode || item.outlet_code || '',
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

/** Rejection Handler with Bottom Sheet UI (LÝ DO TỪ CHỐI SẢN XUẤT) */
function promptRejectProduction(idKey) {
    const cleanKey = extractQuoteCodeFromIdKey(idKey);
    const item = _productionApprovalItems.find(i => {
        if (!i) return false;
        if ((i.__backendId || i.id) == idKey) return true;
        const iQCode = String(i.quoteCode || i.quote_code || i.id || '').trim().toLowerCase();
        if (cleanKey && iQCode && cleanKey.toLowerCase() === iQCode) return true;
        return false;
    }) || { quoteCode: cleanKey || idKey, outletName: 'Outlet' };

    // Ensure edit sheet is closed before opening reject sheet
    if (typeof closeEditRequestSheet === 'function') closeEditRequestSheet();

    window.__pendingRejectIdKey = idKey;

    const labelEl = document.getElementById('productionRejectOutletLabel');
    if (labelEl) {
        labelEl.textContent = `Báo giá: ${item.quoteCode || '---'} | Outlet: ${item.outletName || '---'}`;
    }
    const inputEl = document.getElementById('productionRejectInput');
    if (inputEl) inputEl.value = '';

    const sheet = document.getElementById('productionRejectSheet');
    if (sheet) {
        sheet.classList.remove('hidden');
        requestAnimationFrame(() => sheet.classList.add('sheet-open'));
        setTimeout(() => { if (inputEl) inputEl.focus(); }, 150);
    } else {
        const reason = prompt('Vui lòng nhập lý do từ chối sản xuất:');
        if (reason !== null) {
            confirmRejectProduction(idKey, reason);
        }
    }
}

function closeProductionRejectSheet() {
    const sheet = document.getElementById('productionRejectSheet');
    if (!sheet) return;
    sheet.classList.remove('sheet-open');
    setTimeout(() => { sheet.classList.add('hidden'); }, 260);
}

function closeProductionRejectSheetOnBackdrop(e) {
    if (e.target === document.getElementById('productionRejectSheet')) {
        closeProductionRejectSheet();
    }
}

function submitProductionReject() {
    const idKey = window.__pendingRejectIdKey;
    const inputEl = document.getElementById('productionRejectInput');
    const reason = inputEl ? inputEl.value.trim() : '';
    if (!reason) {
        if (typeof showToast === 'function') showToast('Vui lòng nhập lý do từ chối sản xuất');
        else alert('Vui lòng nhập lý do từ chối sản xuất');
        return;
    }
    closeProductionRejectSheet();
    if (idKey) {
        confirmRejectProduction(idKey, reason);
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
    const base = (typeof window !== 'undefined' && (window.API_BASE_URL || (window.__env && window.__env.BACKEND_URL)))
        ? String(window.API_BASE_URL || window.__env.BACKEND_URL).replace(/\/+$/, '')
        : 'https://ks-backend-493469512136.asia-southeast1.run.app';
    fetch(base + '/api/ks/requests/' + encodeURIComponent(idKey) + '/reject-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'rejected',
            reason: item.rejectReason,
            outletCode: item.outletCode || item.outlet_code || '',
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

// Efficient Event-Driven Sync: Realtime SSE + Event-Driven Refresh (Throttled for Bandwidth Saving)
if (typeof window !== 'undefined') {
    let _lastFetchTime = 0;
    const triggerSingleFetch = (force) => {
        if (!_productionApprovalActive) return;
        const now = Date.now();
        if (!force && now - _lastFetchTime < 3000) return; // 3-second throttle for passive events
        _lastFetchTime = now;
        if (typeof fetchProductionApprovals === 'function') {
            fetchProductionApprovals().then(() => {
                if (typeof renderProductionApprovalsView === 'function') {
                    try { renderProductionApprovalsView(); } catch (_) { }
                }
            });
        }
    };

    // Realtime SSE listener: Update instantly when App 1 or App 2 adds/updates a pending order or approval status
    const origHook = window.__ksOnInvalidate;
    window.__ksOnInvalidate = function (payload) {
        if (typeof origHook === 'function') {
            try { origHook(payload); } catch (_) { }
        }
        const res = String(payload && payload.resource || '').toLowerCase();
        if (!res || res === 'pending_orders' || res === 'pending-orders' || res === 'production-orders' || res === 'ks_requests' || res === 'quotations' || res === 'ks_production_approvals') {
            fetchProductionApprovalBadgeCount();
            triggerSingleFetch(true); // Force immediate realtime update on screen!
        }
    };

    // Refresh badge count when user returns to / focuses the app tab
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            if (_productionApprovalActive) triggerSingleFetch();
            else fetchProductionApprovalBadgeCount();
        }
    });

    window.addEventListener('focus', () => {
        if (_productionApprovalActive) triggerSingleFetch();
        else fetchProductionApprovalBadgeCount();
    });

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        fetchProductionApprovalBadgeCount();
    } else {
        document.addEventListener('DOMContentLoaded', fetchProductionApprovalBadgeCount);
    }
}
