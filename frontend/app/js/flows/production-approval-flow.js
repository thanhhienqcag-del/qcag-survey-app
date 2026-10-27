/**
 * App 2 Mobile Heineken — Production Approval Flow (Sale Duyệt Sản Xuất)
 * ======================================================================
 * Manages the workflow where quotations added to App 1's pending list
 * are presented to Sale Heineken for construction approval (Swipe to Approve / Edit Request / Reject).
 */

let _productionApprovalItems = [];
let _productionApprovalBadgeCount = 0;
let _productionApprovalTab = 'pending'; // 'pending' | 'approved' | 'rejected'
let _productionApprovalCurrentIndex = 0; // Index of the single point currently being reviewed
let _productionApprovalActive = false;
let _currentZoomScale = 1;
let _currentPanX = 0;
let _currentPanY = 0;
let _isPanningImg = false;

function isQcagDesktopActive() {
    if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop()) return true;
    try {
        if (typeof window !== 'undefined' && (window.innerWidth || 0) >= 1024) {
            const raw = localStorage.getItem('ks_session');
            if (raw) {
                const s = JSON.parse(raw);
                if (s && String(s.role || '').toLowerCase() === 'qcag') return true;
            }
        }
    } catch (_) {}
    return false;
}

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
    // Only internal QCAG admins/managers can bypass sale filtering
    if (sessionRole === 'qcag' || sessionRole.includes('admin') || sessionRole.includes('manager')) {
        return true;
    }
    const sessionCode = String(session.saleCode || session.userCode || '').trim();
    const sessionPhone = String(session.phone || '').replace(/\D/g, '');
    const sessionName = session.saleName || session.name || session.username || '';

    const itemCode = String(item.saleCode || item.sale_code || '').trim();
    const itemPhone = String(item.salePhone || item.phone || '').replace(/\D/g, '');
    const itemSaleName = item.saleName || item.sale_name || '';

    const cleanSessionCode = sessionCode.replace(/^USR_(SALE|PHONE)_/i, '').trim();
    const cleanItemCode = itemCode.replace(/^USR_(SALE|PHONE)_/i, '').trim();

    // 1. Direct code match (exact or without USR_ prefix)
    if (cleanSessionCode && cleanItemCode && cleanSessionCode === cleanItemCode) {
        return true;
    }

    // 2. Phone match (Phone is unique to each sale, compare last 8 digits)
    const sPhoneEnd = sessionPhone.length >= 8 ? sessionPhone.slice(-8) : sessionPhone;
    const iPhoneEnd = itemPhone.length >= 8 ? itemPhone.slice(-8) : itemPhone;
    if (sPhoneEnd && iPhoneEnd && (sPhoneEnd === iPhoneEnd || sessionPhone.endsWith(iPhoneEnd) || itemPhone.endsWith(sPhoneEnd))) {
        return true;
    }

    // 3. If itemCode or cleanItemCode is a phone number that matches session phone
    if (cleanItemCode && sPhoneEnd) {
        const itemCodeDigits = cleanItemCode.replace(/\D/g, '');
        if (itemCodeDigits && itemCodeDigits.endsWith(sPhoneEnd)) {
            return true;
        }
    }

    // 4. Linked survey request (__ksReq) match
    if (item.__ksReq) {
        const ksReqId = String(item.__ksReq.requester_id || item.__ksReq.requesterId || '').replace(/^USR_(SALE|PHONE)_/i, '').trim();
        const ksPhone = String(item.__ksReq.phone || item.__ksReq.salePhone || item.__ksReq.sale_phone || '').replace(/\D/g, '');
        if (cleanSessionCode && ksReqId && cleanSessionCode === ksReqId) return true;
        if (sPhoneEnd && ksPhone && ksPhone.endsWith(sPhoneEnd)) return true;
        if (sessionName && item.__ksReq.requester && isNameMatch(sessionName, item.__ksReq.requester)) return true;
    }

    // 5. Name match fallback
    if (sessionName && itemSaleName) {
        if (isNameMatch(itemSaleName, sessionName) || isNameMatch(sessionName, itemSaleName)) return true;
    }

    return false;
}

function getBrandBadgeClass(brand) {
    const b = String(brand || '').toLowerCase().trim();
    if (b.includes('tiger')) return 'qcag-brand-badge brand-tiger';
    if (b.includes('heineken')) return 'qcag-brand-badge brand-heineken';
    if (b.includes('larue')) return 'qcag-brand-badge brand-larue';
    if (b.includes('bivina')) return 'qcag-brand-badge brand-bivina';
    if (b.includes('bia việt') || b.includes('bia viet')) return 'qcag-brand-badge brand-bia-viet';
    if (b.includes('edelweiss')) return 'qcag-brand-badge brand-edelweiss';
    if (b.includes('strongbow')) return 'qcag-brand-badge brand-strongbow';
    return 'qcag-brand-badge brand-default';
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

    // Primary design image sources: Prioritize quote's own direct images from App 1 database
    const primaryDesignSources = [
        item.images,
        item.quote_image_url,
        item.qcag_image_url,
        item.qcagImageUrl,
        item.designImages,
        item.design_images,
        item.design,
        item.image_url,
        item.image
    ];

    // Also check matched Survey Request (__ksReq) only if outlet matches
    if (item.__ksReq) {
        primaryDesignSources.push(
            item.__ksReq.designImages,
            item.__ksReq.design_images,
            item.__ksReq.qcag_image_url,
            item.__ksReq.qcagImageUrl,
            item.__ksReq.design
        );
    }

    if (Array.isArray(item.items)) {
        item.items.forEach(it => {
            if (it) {
                if (it.imageUrl) primaryDesignSources.push(it.imageUrl);
                if (it.images) primaryDesignSources.push(it.images);
                if (it.image) primaryDesignSources.push(it.image);
                if (it.design_images) primaryDesignSources.push(it.design_images);
                if (it.designImages) primaryDesignSources.push(it.designImages);
            }
        });
    }

    // Secondary fallback sources
    const fallbackSources = [
        item.survey_image,
        item.survey_images,
        item.surveyImage
    ];
    if (item.__ksReq) {
        fallbackSources.push(
            item.__ksReq.images,
            item.__ksReq.statusImages,
            item.__ksReq.status_images
        );
    }

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
    const qQuote = String(rawQuoteCode || q.quote_code || q.quoteCode || '').trim().toLowerCase();

    // 1. Match by Quote Code (nếu request đã được gán mã báo giá)
    if (qQuote && qQuote !== '---' && qQuote !== 'null') {
        const byQuote = allRequests.find(r => {
            if (!r) return false;
            const rQuote = String(r.quoteCode || r.quote_code || (r.bridge && r.bridge.quote_code) || '').trim().toLowerCase();
            return rQuote && rQuote === qQuote;
        });
        if (byQuote) return byQuote;
    }

    // 2. Sợi chỉ đỏ tk_code: Match by exact valid TK Code (e.g. 'TK26.00472')
    if (qTk && qTk.startsWith('tk') && qTkDigits.length >= 4) {
        const byTk = allRequests.find(r => {
            if (!r) return false;
            const rTk = String(r.tkCode || r.tk_code || '').trim().toLowerCase();
            const rTkDigits = rTk.replace(/\D/g, '');
            return qTk === rTk || (qTkDigits.length >= 4 && qTkDigits === rTkDigits);
        });
        if (byTk) return byTk;
    }

    // TUYỆT ĐỐI CẤM khớp theo Outlet Code hoặc Outlet Name vì một điểm bán có nhiều đợt khảo sát khác nhau
    return null;
}

let _desktopMqPreviewList = [];
let _desktopMqPreviewIndex = 0;

/** Full-Screen MQ Image Lightbox Viewer with Split-Screen for Desktop and Responsive Mobile Mode */
function openMqImagePreview(url, idKey, itemObj) {
    if (!url && !itemObj) return;
    _currentZoomScale = 1;
    _currentPanX = 0;
    _currentPanY = 0;

    let modal = document.getElementById('mqImageLightboxModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'mqImageLightboxModal';
        document.body.appendChild(modal);
    }

    const item = itemObj || _productionApprovalItems.find(i => (i.__backendId || i.id) == idKey) || {};
    const effectiveIdKey = idKey || item.__backendId || item.id;
    const isDesktop = (window.innerWidth >= 1024);

    // Prepare current list for Next / Prev navigation
    const currentTabItems = (typeof _productionApprovalItems !== 'undefined' && Array.isArray(_productionApprovalItems))
        ? _productionApprovalItems.filter(i => {
            const st = String(i.productionApprovalStatus || 'pending').toLowerCase();
            if (typeof _productionApprovalTab !== 'undefined') {
                if (_productionApprovalTab === 'approved') return st === 'approved';
                if (_productionApprovalTab === 'rejected') return st === 'rejected' || st === 'pending-edit';
            }
            return st === 'pending';
        })
        : [];
    _desktopMqPreviewList = (currentTabItems.length > 0) ? currentTabItems : (_productionApprovalItems || [item]);
    const foundIdx = _desktopMqPreviewList.findIndex(i => (i.__backendId || i.id) == effectiveIdKey);
    _desktopMqPreviewIndex = foundIdx >= 0 ? foundIdx : 0;

    if (isDesktop) {
        modal.className = 'fixed inset-0 z-[9999] flex flex-col select-none backdrop-blur-md desktop-mq-lightbox';
        renderDesktopMqSplitScreen(modal, item, url, effectiveIdKey);
        attachDesktopMqKeyHandler();
    } else {
        // Mobile vertical layout
        modal.className = 'fixed inset-0 z-[9999] bg-black/95 flex flex-col items-center justify-between p-3 select-none backdrop-blur-md';
        renderMobileMqLightbox(modal, item, url, effectiveIdKey);
    }

    modal.classList.remove('hidden');
}

/** Render Split-Screen Widescreen on Desktop Heineken */
function renderDesktopMqSplitScreen(modal, item, activeUrl, idKey) {
    const outletName = item.outletName || 'Outlet';
    const outletCode = item.outletCode || '---';
    const quoteCode = item.quoteCode || '---';
    const tkCode = item.tkCode || '---';
    const amountStr = formatVnd(item.amount || item.totalAmount || 0);

    const mqImages = parseMqDesignImages(item);
    const activeMqUrl = activeUrl || (mqImages.length > 0 ? mqImages[0] : '');

    let itemsList = [];
    try {
        itemsList = typeof item.items === 'string' ? JSON.parse(item.items) : (Array.isArray(item.items) ? item.items : []);
    } catch (_) { itemsList = []; }

    const isPending = ((item.productionApprovalStatus || 'pending') === 'pending');
    const isApproved = ((item.productionApprovalStatus || '') === 'approved');

    const hasPrev = _desktopMqPreviewIndex > 0;
    const hasNext = _desktopMqPreviewIndex < _desktopMqPreviewList.length - 1;
    const totalItems = _desktopMqPreviewList.length || 1;

    // Brand Badge
    const mainBrand = item.brand || item.brandName || (itemsList[0] && (itemsList[0].brand || itemsList[0].brandName)) || '';
    const brandClass = typeof getBrandBadgeClass === 'function' ? getBrandBadgeClass(mainBrand) : 'bg-slate-700 text-white';
    const brandBadgeHtml = mainBrand ? `<span class="px-2.5 py-1 text-xs font-bold rounded-lg ${brandClass} uppercase tracking-wide shadow-sm">${escapeHtml(mainBrand)}</span>` : '';

    // Sale & Date info
    const displaySaleName = item.saleName || item.requesterName || (item.__ksReq && (item.__ksReq.saleName || item.__ksReq.requester && item.__ksReq.requester.name)) || item.saleCode || 'Sale Heineken';
    const rawDate = item.dateStr || item.createdAt || item.created_at || (item.__ksReq && item.__ksReq.createdAt) || '';
    const displayDate = (function(str) {
        if (!str || str === '---') return 'Chưa có';
        try {
            const d = new Date(str);
            if (isNaN(d.getTime())) return str;
            const pad = n => String(n).padStart(2, '0');
            return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch (_) { return str; }
    })(rawDate);
    const displayAddress = item.address || item.outletAddress || (item.__ksReq && item.__ksReq.address) || '';

    modal.innerHTML = `
        <div class="desktop-mq-split-container flex flex-col h-full w-full overflow-hidden select-none">
            <!-- 1. TOP BAR HEADER (h-14) -->
            <div class="desktop-mq-topbar h-14 flex items-center justify-between px-4 flex-shrink-0 z-20">
                <!-- Trái: Nút Prev / Next & Chỉ số thứ tự đơn -->
                <div class="flex items-center gap-2">
                    <button onclick="navigateDesktopMqPreview(-1)" ${hasPrev ? '' : 'disabled'} class="desktop-mq-nav-btn ${hasPrev ? '' : 'opacity-40 cursor-not-allowed'}" title="Đơn trước (Phím ←)">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M15 19l-7-7 7-7"/></svg>
                        <span>Trước</span>
                    </button>
                    <span class="desktop-mq-counter-badge font-mono text-xs font-bold px-2.5 py-1 rounded-lg">
                        ${_desktopMqPreviewIndex + 1} / ${totalItems}
                    </span>
                    <button onclick="navigateDesktopMqPreview(1)" ${hasNext ? '' : 'disabled'} class="desktop-mq-nav-btn ${hasNext ? '' : 'opacity-40 cursor-not-allowed'}" title="Đơn tiếp theo (Phím →)">
                        <span>Tiếp</span>
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M9 5l7 7-7 7"/></svg>
                    </button>
                    <span class="desktop-mq-section-title text-[11px] hidden xl:inline ml-1">(Phím ← / →)</span>
                </div>

                <!-- Giữa: Tên Quán, Outlet Code, Mã Báo Giá, Mã Thiết Kế -->
                <div class="flex items-center gap-3 overflow-hidden px-2">
                    <span class="desktop-mq-outlet-name font-bold text-sm uppercase tracking-wide truncate max-w-[260px] xl:max-w-[360px]" title="${escapeHtml(outletName)}">${escapeHtml(outletName)}</span>
                    <span class="desktop-mq-outlet-code font-mono text-xs font-bold px-2 py-0.5 rounded text-sky-400 bg-sky-950/40 border border-sky-600/40 flex-shrink-0">#${escapeHtml(outletCode)}</span>
                    <div class="desktop-mq-header-meta flex items-center gap-2 text-xs font-mono flex-shrink-0">
                        <span>BG: <strong class="font-bold">${escapeHtml(quoteCode)}</strong></span>
                        ${tkCode && tkCode !== quoteCode ? `
                            <span class="opacity-40">•</span>
                            <span>TK: <strong class="font-bold">${escapeHtml(tkCode)}</strong></span>
                        ` : ''}
                    </div>
                </div>

                <!-- Phải: Zoom Controls & Close Button -->
                <div class="flex items-center gap-2 flex-shrink-0">
                    <div class="desktop-mq-zoom-group flex items-center rounded-xl p-1 gap-1 mr-1">
                        <button onclick="changeMqZoom(-0.3)" class="desktop-mq-tool-btn" title="Thu nhỏ (-)">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M20 12H4"/></svg>
                        </button>
                        <span id="mqZoomIndicator" class="font-mono text-xs font-bold px-1.5 min-w-[44px] text-center">${Math.round(_currentZoomScale * 100)}%</span>
                        <button onclick="changeMqZoom(0.3)" class="desktop-mq-tool-btn" title="Phóng to (+)">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/></svg>
                        </button>
                        <button onclick="resetMqZoom()" class="desktop-mq-tool-btn px-2 text-xs font-medium" title="Đặt lại kích thước chuẩn (Phím 0)">
                            <span>Fit</span>
                        </button>
                    </div>
                    <button onclick="closeMqImagePreview()" class="desktop-mq-close-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold text-xs" title="Đóng cửa sổ (Phím Esc)">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M6 18L18 6M6 6l12 12"/></svg>
                        <span>Đóng</span>
                    </button>
                </div>
            </div>

            <!-- 2. MAIN BODY (Split-Screen: Cột trái 70% Viewport MQ, Cột phải 30% Panel Chi tiết) -->
            <div class="desktop-mq-split-body flex-1 flex overflow-hidden min-h-0">
                <!-- CỘT TRÁI: VIEWPORT ẢNH MAQUETTE KHỔ RỘNG (~70%) -->
                <div class="desktop-mq-viewport flex-1 relative flex flex-col overflow-hidden select-none">
                    <!-- Image Display Area -->
                    <div id="mqViewportContainer" class="flex-1 w-full h-full flex items-center justify-center overflow-hidden relative select-none p-4" style="cursor: grab;" onwheel="handleMqWheelZoom(event)" onmousedown="initMqImagePan(event)" ontouchstart="initMqImagePan(event)" ondblclick="handleMqDoubleClick(event)">
                        <img id="mqLightboxImg" src="${escapeHtml(activeMqUrl)}" alt="Maquette Design" draggable="false" ondragstart="return false;" class="max-h-full max-w-full object-contain rounded-xl shadow-2xl pointer-events-auto select-none" style="transform: translate(0px, 0px) scale(1); -webkit-user-drag: none; cursor: grab;" onmousedown="initMqImagePan(event)" ontouchstart="initMqImagePan(event)" ondblclick="handleMqDoubleClick(event)">
                        
                        <!-- Floating Navigation Arrows -->
                        ${hasPrev ? `
                            <button type="button" onclick="event.stopPropagation(); navigateDesktopMqPreview(-1)" class="desktop-mq-floating-nav left-5" title="Đơn trước (Phím ←)">
                                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/></svg>
                            </button>
                        ` : ''}
                        ${hasNext ? `
                            <button type="button" onclick="event.stopPropagation(); navigateDesktopMqPreview(1)" class="desktop-mq-floating-nav right-5" title="Đơn kế tiếp (Phím →)">
                                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/></svg>
                            </button>
                        ` : ''}
                    </div>

                    <!-- Thumbnail Selector nếu đơn có nhiều ảnh MQ -->
                    ${mqImages.length > 1 ? `
                        <div class="desktop-mq-thumbs-bar flex items-center justify-center gap-2.5 p-2 z-10 flex-shrink-0">
                            ${mqImages.map((img, idx) => `
                                <img src="${escapeHtml(img)}" onclick="switchDesktopMqImage('${escapeHtml(img)}')" class="desktop-mq-thumb h-12 w-20 object-cover rounded-lg border-2 ${img === activeMqUrl ? 'border-sky-400 scale-105' : 'border-transparent opacity-60 hover:opacity-100'} cursor-pointer transition-all shadow-sm" alt="MQ ${idx + 1}">
                            `).join('')}
                        </div>
                    ` : ''}
                </div>

                <!-- CỘT PHẢI: PANEL THÔNG TIN CHI TIẾT & HẠNH ĐỘNG DUYỆT (~30%) -->
                <div class="desktop-mq-sidepanel w-[380px] xl:w-[420px] flex flex-col h-full border-l flex-shrink-0 z-10">
                    <!-- Header Panel: Tóm tắt Brand & Tổng Tiền -->
                    <div class="desktop-mq-panel-header p-4 border-b flex-shrink-0">
                        <div class="flex items-center justify-between mb-1.5">
                            <span class="desktop-mq-section-title text-xs font-bold uppercase tracking-wider">GIÁ TRỊ BÁO GIÁ</span>
                            ${brandBadgeHtml}
                        </div>
                        <div class="desktop-mq-total-amount text-2xl font-black font-['Be_Vietnam_Pro'] tracking-tight">
                            ${amountStr}
                        </div>
                    </div>

                    <!-- Scrollable Body: Thông tin & Bảng Hạng Mục Kỹ Thuật Đối Chiếu -->
                    <div class="desktop-mq-panel-scroll flex-1 overflow-y-auto p-4 space-y-4">
                        <!-- Khối 1: Thông tin Điểm bán & Sale phụ trách -->
                        <div class="desktop-mq-info-card p-3.5 rounded-xl border space-y-2.5 text-xs shadow-sm">
                            <div class="flex justify-between items-start gap-2">
                                <span class="desktop-mq-info-label shrink-0">Điểm bán:</span>
                                <span class="desktop-mq-info-val font-bold text-right truncate" title="${escapeHtml(outletName)}">${escapeHtml(outletName)}</span>
                            </div>
                            <div class="flex justify-between items-center gap-2">
                                <span class="desktop-mq-info-label shrink-0">Mã Outlet:</span>
                                <span class="font-mono font-bold text-sky-400">#${escapeHtml(outletCode)}</span>
                            </div>
                            ${displayAddress ? `
                                <div class="flex justify-between items-start gap-2">
                                    <span class="desktop-mq-info-label shrink-0">Địa chỉ:</span>
                                    <span class="desktop-mq-info-addr text-right font-medium">${escapeHtml(displayAddress)}</span>
                                </div>
                            ` : ''}
                            <div class="flex justify-between items-center gap-2">
                                <span class="desktop-mq-info-label shrink-0">Người gửi:</span>
                                <span class="desktop-mq-info-val font-bold">${escapeHtml(displaySaleName)}</span>
                            </div>
                            <div class="flex justify-between items-center gap-2">
                                <span class="desktop-mq-info-label shrink-0">Thời gian gửi:</span>
                                <span class="desktop-mq-info-val font-mono font-medium">${escapeHtml(displayDate)}</span>
                            </div>
                        </div>

                        <!-- Khối 2: Bảng Hạng Mục Thi Công (Kỹ thuật đối chiếu MQ) -->
                        <div>
                            <div class="flex items-center justify-between mb-2">
                                <span class="desktop-mq-section-title text-xs font-bold uppercase tracking-wider">
                                    Hạng mục thi công (${itemsList.length})
                                </span>
                                <span class="desktop-mq-section-title text-[11px]">Đối chiếu bản vẽ</span>
                            </div>

                            ${itemsList.length > 0 ? `
                                <div class="space-y-2">
                                    ${itemsList.map((it, itIdx) => {
                                        const itName = it.item_name || it.itemName || it.title || it.name || ('Hạng mục ' + (itIdx + 1));
                                        const itW = it.width || it.w || '';
                                        const itH = it.height || it.h || '';
                                        const itDim = (itW && itH) ? `${itW}m x ${itH}m` : (it.dimension || it.size || '');
                                        const itPrice = formatVnd(it.amount || it.total_price || it.totalPrice || it.unit_price || 0);
                                        const itQty = it.quantity || it.qty || 1;
                                        return `
                                            <div class="desktop-mq-item-row p-3 rounded-xl border text-xs shadow-sm">
                                                <div class="flex items-start justify-between gap-2 mb-1.5">
                                                    <span class="desktop-mq-item-name font-bold leading-snug">${itIdx + 1}. ${escapeHtml(itName)}</span>
                                                    <span class="desktop-mq-item-price font-black shrink-0">${itPrice}</span>
                                                </div>
                                                <div class="flex items-center justify-between text-[11px] desktop-mq-item-meta">
                                                    <span>${itDim ? `KT: <strong>${escapeHtml(itDim)}</strong>` : ''}</span>
                                                    <span>SL: <strong>${itQty}</strong></span>
                                                </div>
                                            </div>
                                        `;
                                    }).join('')}
                                </div>
                            ` : `
                                <div class="p-4 text-center text-xs text-gray-500 border rounded-xl italic">
                                    • Hạng mục sản xuất & thi công theo báo giá đã duyệt
                                </div>
                            `}
                        </div>
                    </div>

                    <!-- Footer Panel: CỤM 3 NÚT DUYỆT CHUẨN DESKTOP (Không dùng thanh vuốt!) -->
                    <div class="desktop-mq-panel-footer p-4 border-t flex-shrink-0">
                        ${isPending ? `
                            <div class="space-y-2.5">
                                <!-- Nút 1: ĐỒNG Ý SẢN XUẤT (Solid Emerald lớn) -->
                                <button type="button" onclick="handleDesktopApproveProduction('${idKey}')" class="desktop-mq-btn-approve w-full h-12 rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-lg transition-all cursor-pointer">
                                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
                                    <span>ĐỒNG Ý SẢN XUẤT</span>
                                </button>

                                <!-- Hàng 2 nút: Chỉnh sửa & Từ chối -->
                                <div class="flex items-center gap-2">
                                    <button type="button" onclick="closeMqImagePreview(); promptRequestEditProduction('${idKey}')" class="desktop-mq-btn-edit flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-sm">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                                        <span>Chỉnh sửa</span>
                                    </button>
                                    <button type="button" onclick="closeMqImagePreview(); promptRejectProduction('${idKey}')" class="desktop-mq-btn-reject flex-1 h-10 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-sm">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                                        <span>Từ chối</span>
                                    </button>
                                </div>
                            </div>
                        ` : `
                            <div class="p-3.5 rounded-xl text-center text-xs font-bold ${isApproved ? 'bg-emerald-950/50 text-emerald-400 border border-emerald-600/50' : 'bg-red-950/50 text-red-400 border border-red-600/50'}">
                                ${isApproved ? '✓ Đơn này đã được đồng ý sản xuất' : '✕ Đơn này đã bị từ chối sản xuất'}
                            </div>
                        `}
                    </div>
                </div>
            </div>
        </div>
    `;
}

/** Render Vertical Lightbox on Mobile devices */
function renderMobileMqLightbox(modal, item, activeUrl, idKey) {
    const outletName = item.outletName || 'Outlet';
    const quoteCode = item.quoteCode || '---';
    modal.innerHTML = `
        <!-- Top Bar: Title, Zoom & Close Controls -->
        <div class="w-full flex items-center justify-between z-50 pt-2 px-1">
            <div class="flex flex-col">
                <span class="text-xs font-mono font-bold text-gray-300">MÃ BÁO GIÁ: ${escapeHtml(quoteCode)}</span>
                <span class="text-sm font-bold text-white uppercase tracking-wide truncate max-w-[200px]">${escapeHtml(outletName)}</span>
            </div>
            <div class="flex items-center gap-1.5">
                <button onclick="changeMqZoom(0.35)" class="w-9 h-9 bg-white/15 text-white rounded-xl flex items-center justify-center font-bold text-base border border-white/20 shadow" title="Phóng to">+</button>
                <button onclick="changeMqZoom(-0.35)" class="w-9 h-9 bg-white/15 text-white rounded-xl flex items-center justify-center font-bold text-base border border-white/20 shadow" title="Thu nhỏ">-</button>
                <button onclick="resetMqZoom()" class="w-9 h-9 bg-white/15 text-white rounded-xl flex items-center justify-center border border-white/20 shadow" title="Đặt lại kích thước">
                    <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                </button>
                <button onclick="closeMqImagePreview()" class="w-9 h-9 bg-red-600/80 hover:bg-red-600 text-white rounded-xl flex items-center justify-center shadow-lg cursor-pointer" title="Đóng">
                    <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </div>
        </div>

        <!-- Center: Zoomable & Draggable MQ Image -->
        <div class="flex-1 w-full flex items-center justify-center overflow-hidden my-2 relative select-none" style="cursor: grab;" onmousedown="initMqImagePan(event)" ontouchstart="initMqImagePan(event)" ondblclick="handleMqDoubleClick(event)">
            <img id="mqLightboxImg" src="${escapeHtml(activeUrl)}" draggable="false" ondragstart="return false;" onmousedown="initMqImagePan(event)" ontouchstart="initMqImagePan(event)" ondblclick="handleMqDoubleClick(event)" class="max-h-[66vh] max-w-full object-contain rounded-xl shadow-2xl pointer-events-auto select-none" style="transform: translate(0px, 0px) scale(1); -webkit-user-drag: none; cursor: grab;">
        </div>

        <!-- Bottom: Integrated 3 Action Buttons on Mobile -->
        ${((item.productionApprovalStatus || 'pending') === 'pending') ? `
            <div class="w-full flex items-center gap-2 pb-2 z-50" onclick="event.stopPropagation()">
                <div id="swipeContainer_modal_${idKey}" onclick="handleSwipeContainerClick(event, '${idKey}', true)" class="prod-app-swipe-box prod-app-swipe-container flex-1 rounded-full h-[46px] relative flex items-center px-1 overflow-hidden select-none touch-none cursor-pointer" title="Nhấp chuột hoặc vuốt để đồng ý sản xuất">
                    <div id="swipeFill_modal_${idKey}" class="prod-app-swipe-fill absolute left-0 top-0 bottom-0 rounded-l-full transition-all duration-75 pointer-events-none w-0"></div>
                    <div id="swipeKnob_modal_${idKey}" onmousedown="initSwipeDragModal(event, '${idKey}')" ontouchstart="initSwipeDragModal(event, '${idKey}')" class="prod-app-swipe-knob w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs cursor-grab active:cursor-grabbing z-10 transition-transform">
                        <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg>
                    </div>
                    <div id="swipeLabel_modal_${idKey}" class="prod-app-swipe-label absolute inset-0 flex items-center justify-center text-xs font-bold pointer-events-none pl-6 pr-2 text-center whitespace-nowrap overflow-hidden text-ellipsis tracking-wider transition-opacity">
                        <span class="prod-app-swipe-text">Vuốt đồng ý</span>
                    </div>
                </div>
                <button onclick="closeMqImagePreview(); promptRequestEditProduction('${idKey}')" class="prod-app-btn-edit font-bold text-xs h-[46px] px-3.5 rounded-xl flex items-center justify-center transition-all flex-shrink-0 whitespace-nowrap">
                    Chỉnh sửa
                </button>
                <button onclick="closeMqImagePreview(); promptRejectProduction('${idKey}')" class="prod-app-btn-reject font-bold text-xs h-[46px] px-3.5 rounded-xl flex items-center justify-center transition-all flex-shrink-0 whitespace-nowrap">
                    Từ chối
                </button>
            </div>
        ` : ''}
    `;
}

/** Chuyển đơn Trước / Sau trên Desktop Split-Screen */
function navigateDesktopMqPreview(step) {
    if (!_desktopMqPreviewList || _desktopMqPreviewList.length === 0) return;
    const newIdx = _desktopMqPreviewIndex + step;
    if (newIdx < 0 || newIdx >= _desktopMqPreviewList.length) return;
    _desktopMqPreviewIndex = newIdx;
    const nextItem = _desktopMqPreviewList[newIdx];
    const nextIdKey = nextItem.__backendId || nextItem.id || _desktopMqPreviewIndex;
    const nextImgs = parseMqDesignImages(nextItem);
    const nextUrl = nextImgs.length > 0 ? nextImgs[0] : '';
    openMqImagePreview(nextUrl, nextIdKey, nextItem);
}

/** Chuyển ảnh Maquette con trong đơn có nhiều ảnh */
function switchDesktopMqImage(imgUrl) {
    const img = document.getElementById('mqLightboxImg');
    if (img) img.src = imgUrl;
    resetMqZoom();
    document.querySelectorAll('.desktop-mq-thumb').forEach(t => {
        if (t.src === imgUrl || t.getAttribute('src') === imgUrl) {
            t.classList.add('border-sky-400', 'scale-105');
            t.classList.remove('opacity-60', 'border-transparent');
        } else {
            t.classList.remove('border-sky-400', 'scale-105');
            t.classList.add('opacity-60', 'border-transparent');
        }
    });
}

/** Xử lý duyệt sản xuất trực tiếp trên Desktop Split-Screen */
function handleDesktopApproveProduction(idKey) {
    const item = _desktopMqPreviewList ? _desktopMqPreviewList[_desktopMqPreviewIndex] : null;
    const outletName = item ? (item.outletName || 'Điểm bán') : 'Điểm bán';

    approveProductionItem(idKey);

    if (typeof showToast === 'function') {
        showToast('Đã đồng ý sản xuất: ' + outletName);
    }

    if (typeof renderProductionApprovalList === 'function') {
        renderProductionApprovalList();
    }

    // Tự động chuyển tiếp sang đơn pending tiếp theo
    if (_desktopMqPreviewList && _desktopMqPreviewList.length > 0) {
        const remainingPending = _desktopMqPreviewList.filter(i => (i.productionApprovalStatus || 'pending') === 'pending');
        if (remainingPending.length > 0) {
            let nextPendingIdx = _desktopMqPreviewList.findIndex((i, idx) => idx > _desktopMqPreviewIndex && (i.productionApprovalStatus || 'pending') === 'pending');
            if (nextPendingIdx < 0) {
                nextPendingIdx = _desktopMqPreviewList.findIndex(i => (i.productionApprovalStatus || 'pending') === 'pending');
            }
            if (nextPendingIdx >= 0) {
                _desktopMqPreviewIndex = nextPendingIdx;
                const nextItem = _desktopMqPreviewList[nextPendingIdx];
                const nextIdKey = nextItem.__backendId || nextItem.id || nextPendingIdx;
                const nextImgs = parseMqDesignImages(nextItem);
                const nextUrl = nextImgs.length > 0 ? nextImgs[0] : '';
                setTimeout(() => {
                    openMqImagePreview(nextUrl, nextIdKey, nextItem);
                }, 220);
                return;
            }
        }
    }

    // Đã duyệt hết đơn trong tab
    if (typeof showToast === 'function') {
        showToast('Đã hoàn tất duyệt toàn bộ đơn chờ sản xuất!');
    }
    setTimeout(() => {
        closeMqImagePreview();
    }, 450);
}

/** Lăn bánh xe chuột để phóng to / thu nhỏ ảnh MQ */
function handleMqWheelZoom(event) {
    if (!event) return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.25 : -0.25;
    changeMqZoom(delta);
}

/** Lắng nghe phím tắt bàn phím (ArrowLeft/Right/Esc/Zoom) */
function attachDesktopMqKeyHandler() {
    if (window.__desktopMqKeyHandler) {
        window.removeEventListener('keydown', window.__desktopMqKeyHandler);
    }
    window.__desktopMqKeyHandler = function(e) {
        const modal = document.getElementById('mqImageLightboxModal');
        if (!modal || modal.classList.contains('hidden')) return;
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
        
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            navigateDesktopMqPreview(1);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            navigateDesktopMqPreview(-1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeMqImagePreview();
        } else if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            changeMqZoom(0.3);
        } else if (e.key === '-') {
            e.preventDefault();
            changeMqZoom(-0.3);
        } else if (e.key === '0') {
            e.preventDefault();
            resetMqZoom();
        }
    };
    window.addEventListener('keydown', window.__desktopMqKeyHandler);
}

let _panStartX = 0;
let _panStartY = 0;
let _panInitialX = 0;
let _panInitialY = 0;

function updateMqImageTransform(withTransition = false) {
    const img = document.getElementById('mqLightboxImg');
    if (!img) return;
    
    // Tắt transition khi đang kéo rê để đạt 60fps mượt mà, bật transition nhẹ khi zoom bằng nút bấm
    img.style.transition = withTransition ? 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none';
    img.style.transform = `translate(${_currentPanX}px, ${_currentPanY}px) scale(${_currentZoomScale})`;
    
    const indicator = document.getElementById('mqZoomIndicator');
    if (indicator) {
        indicator.textContent = Math.round(_currentZoomScale * 100) + '%';
    }

    const container = document.getElementById('mqViewportContainer');
    if (container && !_isPanningImg) {
        container.style.cursor = _currentZoomScale > 1 ? 'grab' : 'default';
        img.style.cursor = _currentZoomScale > 1 ? 'grab' : 'zoom-in';
    }
}

function changeMqZoom(delta) {
    _currentZoomScale += delta;
    if (_currentZoomScale < 0.7) _currentZoomScale = 0.7;
    if (_currentZoomScale > 5.5) _currentZoomScale = 5.5;
    if (_currentZoomScale <= 1.0) {
        _currentPanX = 0;
        _currentPanY = 0;
    }
    updateMqImageTransform(true);
}

function resetMqZoom() {
    _currentZoomScale = 1;
    _currentPanX = 0;
    _currentPanY = 0;
    updateMqImageTransform(true);
}

/** Click đúp chuột vào ảnh để phóng to nhanh 2.2x hoặc đưa về 1x */
function handleMqDoubleClick(event) {
    if (event) {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
    }
    if (_currentZoomScale > 1.2) {
        resetMqZoom();
    } else {
        _currentZoomScale = 2.2;
        if (event && event.clientX) {
            const viewport = document.getElementById('mqViewportContainer') || (event.currentTarget ? event.currentTarget.parentElement : null);
            if (viewport) {
                const rect = viewport.getBoundingClientRect();
                const clickX = event.clientX - (rect.left + rect.width / 2);
                const clickY = event.clientY - (rect.top + rect.height / 2);
                _currentPanX = Math.round(-clickX * 0.75);
                _currentPanY = Math.round(-clickY * 0.75);
            }
        }
        updateMqImageTransform(true);
    }
}

/** Khởi tạo Pan chuột kéo rê mượt mà, triệt tiêu hoàn toàn native ghost drag */
function initMqImagePan(event) {
    if (!event) return;
    
    // Bắt buộc preventDefault để triệt tiêu native HTML5 image ghost drag và text selection
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();

    // Chỉ cho phép nắm kéo khi đã phóng to > 1.0 (hoặc khi scale khác 1)
    if (_currentZoomScale <= 1.0) {
        return;
    }

    _isPanningImg = true;
    _panStartX = event.type.startsWith('touch') ? event.touches[0].clientX : event.clientX;
    _panStartY = event.type.startsWith('touch') ? event.touches[0].clientY : event.clientY;
    _panInitialX = _currentPanX;
    _panInitialY = _currentPanY;

    // Đổi con trỏ toàn trang sang grabbing
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    const container = document.getElementById('mqViewportContainer');
    if (container) container.style.cursor = 'grabbing';
    const img = document.getElementById('mqLightboxImg');
    if (img) {
        img.style.cursor = 'grabbing';
        img.style.transition = 'none'; // Không có transition trong lúc kéo -> trỏ chuột bám sát 100%
    }

    function onPanMove(e) {
        if (!_isPanningImg) return;
        if (e.cancelable) e.preventDefault();

        const curX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
        const curY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;

        _currentPanX = _panInitialX + (curX - _panStartX);
        _currentPanY = _panInitialY + (curY - _panStartY);

        updateMqImageTransform(false);
    }

    function onPanEnd() {
        if (!_isPanningImg) return;
        _isPanningImg = false;

        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        const c = document.getElementById('mqViewportContainer');
        if (c) c.style.cursor = _currentZoomScale > 1 ? 'grab' : 'default';
        const im = document.getElementById('mqLightboxImg');
        if (im) {
            im.style.cursor = _currentZoomScale > 1 ? 'grab' : 'zoom-in';
            im.style.transition = 'transform 0.15s ease-out';
        }

        window.removeEventListener('mousemove', onPanMove, { passive: false });
        window.removeEventListener('mouseup', onPanEnd);
        window.removeEventListener('touchmove', onPanMove, { passive: false });
        window.removeEventListener('touchend', onPanEnd);
        window.removeEventListener('touchcancel', onPanEnd);
    }

    window.addEventListener('mousemove', onPanMove, { passive: false });
    window.addEventListener('mouseup', onPanEnd);
    window.addEventListener('touchmove', onPanMove, { passive: false });
    window.addEventListener('touchend', onPanEnd);
    window.addEventListener('touchcancel', onPanEnd);
}

function closeMqImagePreview() {
    const modal = document.getElementById('mqImageLightboxModal');
    if (modal) modal.classList.add('hidden');
    resetMqZoom();
    if (window.__desktopMqKeyHandler) {
        window.removeEventListener('keydown', window.__desktopMqKeyHandler);
        window.__desktopMqKeyHandler = null;
    }
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
            // Strictly resolve Sale info from quotation payload first, fallback to survey request only. NEVER fallback to QCAG admin creator.
            const resolvedSaleCode = String(q.sale_code || q.saleCode || (ksReq ? (ksReq.saleCode || ksReq.sale_code || ksReq.userCode || ksReq.code || '') : '') || '').trim();
            const resolvedSalePhone = String(q.sale_phone || q.salePhone || (ksReq ? (ksReq.phone || ksReq.salePhone || ksReq.sale_phone || '') : '') || '').replace(/\D/g, '');
            const resolvedSaleName = String(q.sale_name || q.saleName || (ksReq ? (ksReq.saleName || ksReq.sale_name || ksReq.requester || ksReq.requesterName || ksReq.name || '') : '') || '').trim();
            const resolvedRequester = String(q.requester || q.requesterName || (ksReq ? (ksReq.requester || ksReq.requesterName || resolvedSaleName || '') : '') || '').trim();
            const resolvedSsName = String(q.ss_name || q.ssName || (ksReq ? (ksReq.ssName || ksReq.ss_name || '') : '') || '').trim();

            // Prioritize direct images on quote payload, fallback to matched survey request
            const quoteImgs = q.images || q.quote_image_url || q.qcag_image_url || null;
            const designImgs = (Array.isArray(quoteImgs) && quoteImgs.length > 0 ? quoteImgs : null) ||
                q.design_images || q.designImages ||
                (ksReq ? (ksReq.design_images || ksReq.designImages || ksReq.design) : null) || [];

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
                images: quoteImgs || [],
                designImages: designImgs,
                design: (Array.isArray(quoteImgs) && quoteImgs.length > 0 ? quoteImgs[0] : null) || (ksReq ? (ksReq.design || ksReq.designImages || ksReq.design_images) : null),
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

let _isAutoFetchingProductionImages = false;
const _attemptedMissingImagesSet = new Set();

/** Automatically Fetch Missing MQ Design Images Asynchronously from App 2 Database / Backend */
async function autoFetchMissingProductionImages() {
    // CHỈ fetch khi modal đang mở, tránh spam 20-40 requests nền khi người dùng ở màn hình khác
    if (!_productionApprovalActive) return;
    if (_isAutoFetchingProductionImages) return;
    if (!_productionApprovalItems || !_productionApprovalItems.length) return;

    const missingItems = _productionApprovalItems.filter(it => {
        const quoteCode = String(it.quoteCode || it.id || '');
        if (_attemptedMissingImagesSet.has(quoteCode)) return false;
        const imgs = parseMqDesignImages(it);
        return imgs.length === 0;
    });

    if (missingItems.length === 0) return;

    _isAutoFetchingProductionImages = true;
    try {
        let updatedAny = false;
        // Chỉ fetch tối đa 5 items một đợt để tránh nghẽn Main Thread và Network
        const batch = missingItems.slice(0, 5);
        for (const it of batch) {
            const quoteCode = String(it.quoteCode || it.id || '');
            _attemptedMissingImagesSet.add(quoteCode);
            try {
                let fullReq = null;
                // 1. If we have a known backend ID of the matched survey request, get it directly
                if (it.__ksReqBackendId && window.dataSdk && typeof window.dataSdk.getOne === 'function') {
                    const res = await window.dataSdk.getOne(it.__ksReqBackendId);
                    if (res && res.isOk && res.data) fullReq = res.data;
                }

                // 2. Fallback search by outlet code ONLY in App 2 backend
                if (!fullReq && window.dataSdk && typeof window.dataSdk.search === 'function') {
                    const searchTerm = it.outletCode && it.outletCode !== '---' ? it.outletCode : (it.tkCode && it.tkCode.startsWith('TK') ? it.tkCode : '');
                    if (searchTerm && searchTerm !== '---') {
                        const sRes = await window.dataSdk.search(searchTerm, 3);
                        if (sRes && sRes.isOk && Array.isArray(sRes.data) && sRes.data.length > 0) {
                            const match = sRes.data.find(r => {
                                if (it.outletCode && r.outletCode && it.outletCode !== '---') {
                                    return it.outletCode === r.outletCode;
                                }
                                if (it.tkCode && r.tkCode && it.tkCode.startsWith('TK')) {
                                    return it.tkCode === r.tkCode;
                                }
                                return false;
                            });
                            if (match) fullReq = match;
                        }
                    }
                }

                if (fullReq) {
                    const dImgs = fullReq.designImages || fullReq.design_images || fullReq.images;
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
    } finally {
        _isAutoFetchingProductionImages = false;
    }
}

let _productionApprovalFetchSeq = 0;

async function fetchProductionApprovals() {
    // Chưa đăng nhập: tuyệt đối không nạp dữ liệu không lọc (nguồn gây badge sai số)
    if (typeof currentSession === 'undefined' || !currentSession) {
        _productionApprovalFetchSeq++;
        _productionApprovalItems = [];
        _productionApprovalBadgeCount = 0;
        updateProductionApprovalBadge();
        return;
    }
    const fetchSeq = ++_productionApprovalFetchSeq;
    const sessionAtStart = currentSession;
    let allExtracted = [];

    // 1. Fetch pending orders (App 1 Backend or App 2 Backend fallback)
    const isStaging = (typeof window !== 'undefined' && (window.location.hostname.includes('staging') || window.location.hostname.includes('localhost') || window.location.hostname.includes('127.0.0.1')));
    const app1Base = isStaging
        ? 'https://qcag-backend-staging-493469512136.asia-southeast1.run.app'
        : 'https://qcag-backend-493469512136.asia-southeast1.run.app';

    const defaultApp2Backend = isStaging
        ? 'https://ks-backend-staging-493469512136.asia-southeast1.run.app'
        : 'https://ks-backend-493469512136.asia-southeast1.run.app';
    const app2Base = (typeof window !== 'undefined' && (window.API_BASE_URL || (window.__env && window.__env.BACKEND_URL)))
        ? String(window.API_BASE_URL || window.__env.BACKEND_URL).replace(/\/+$/, '')
        : defaultApp2Backend;

    try {
        const sessionCode = (typeof currentSession !== 'undefined' && currentSession) ? (currentSession.saleCode || currentSession.userCode || '') : '';
        const sessionPhone = (typeof currentSession !== 'undefined' && currentSession) ? (currentSession.phone || '') : '';
        const params = [];
        if (sessionCode) params.push('sale_code=' + encodeURIComponent(sessionCode));
        if (sessionPhone) params.push('sale_phone=' + encodeURIComponent(sessionPhone));
        if (!_productionApprovalActive) params.push('summary=1');
        const queryStr = params.length ? '?' + params.join('&') : '';

        // Try App 1 first
        let gotData = false;
        try {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), 2500) : null;
            const res = await fetch(app1Base + '/pending-orders' + queryStr, { signal: controller ? controller.signal : undefined }).catch(() => null);
            if (timer) clearTimeout(timer);
            if (res && res.ok) {
                const json = await res.json().catch(() => null);
                if (json && json.ok && Array.isArray(json.data) && json.data.length > 0) {
                    allExtracted = allExtracted.concat(extractQuotesFromPendingOrdersPayload(json.data));
                    gotData = true;
                }
            }
        } catch (_) { }

        // Fallback to App 2 backend if App 1 didn't yield quotes
        if (!gotData) {
            try {
                const controller2 = typeof AbortController !== 'undefined' ? new AbortController() : null;
                const timer2 = controller2 ? setTimeout(() => controller2.abort(), 2500) : null;
                const res2 = await fetch(app2Base + '/api/ks/pending-orders' + queryStr, { signal: controller2 ? controller2.signal : undefined }).catch(() => null);
                if (timer2) clearTimeout(timer2);
                if (res2 && res2.ok) {
                    const json2 = await res2.json().catch(() => null);
                    if (json2 && json2.ok && Array.isArray(json2.data) && json2.data.length > 0) {
                        allExtracted = allExtracted.concat(extractQuotesFromPendingOrdersPayload(json2.data));
                    }
                }
            } catch (_) { }
        }
    } catch (e) {
        // Pending-orders fetch error
    }

    // 2. Check localStorage backups (chỉ khi modal mở hoặc chưa có dữ liệu nào)
    if (_productionApprovalActive || allExtracted.length === 0) {
        try {
            if (typeof localStorage !== 'undefined') {
                const local1 = localStorage.getItem('pending_orders_v1');
                const local2 = localStorage.getItem('pendingOrders');
                if (local1) allExtracted = allExtracted.concat(extractQuotesFromPendingOrdersPayload(JSON.parse(local1)));
                if (local2) allExtracted = allExtracted.concat(extractQuotesFromPendingOrdersPayload(JSON.parse(local2)));
            }
        } catch (e) { console.warn('LocalStorage parse warning:', e); }
    }

    // 3. Fetch App 2 Backend production approvals
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
    // Bỏ kết quả cũ nếu đã có lần fetch mới hơn hoặc phiên đăng nhập đã đổi/đăng xuất
    if (fetchSeq !== _productionApprovalFetchSeq || typeof currentSession === 'undefined' || currentSession !== sessionAtStart) {
        return;
    }
    finalItems = finalItems.filter(item => isSaleMatch(item, sessionAtStart));

    _productionApprovalItems = finalItems;
    _productionApprovalBadgeCount = 0;
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
    const defaultApp2Backend = 'https://ks-backend-staging-493469512136.asia-southeast1.run.app';
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
    if (isQcagDesktopActive() && !_productionApprovalActive) {
        return;
    }
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
    _mqVerifiedState = {};

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
            btn.classList.toggle('active', t === tab);
        }
    });
    renderProductionApprovalList();
}

function formatVnd(val) {
    const num = Number(val) || 0;
    return num.toLocaleString('vi-VN') + ' đ';
}

function showRejectionReasonTooltip(reason) {
    if (typeof showToast === 'function') {
        showToast('Lý do từ chối: ' + (reason || 'Chưa nhập lý do từ chối'));
    } else {
        alert('Lý do từ chối:\n\n' + (reason || 'Chưa nhập lý do từ chối'));
    }
}

function nextProductionApprovalItem() {
    const list = getFilteredProductionApprovalList();
    if (_productionApprovalCurrentIndex < list.length - 1) {
        _productionApprovalCurrentIndex++;
        renderProductionApprovalList();
    }
}

function prevProductionApprovalItem() {
    if (_productionApprovalCurrentIndex > 0) {
        _productionApprovalCurrentIndex--;
        renderProductionApprovalList();
    }
}

function getFilteredProductionApprovalList() {
    if (_productionApprovalTab === 'pending') {
        return _productionApprovalItems.filter(i => (i.productionApprovalStatus || 'pending') === 'pending');
    }
    if (_productionApprovalTab === 'approved') {
        return _productionApprovalItems.filter(i => i.productionApprovalStatus === 'approved');
    }
    if (_productionApprovalTab === 'rejected') {
        return _productionApprovalItems.filter(i => i.productionApprovalStatus === 'rejected');
    }
    return [];
}

function setSingleFocusMqImg(src) {
    const img = document.getElementById('singleFocusMqImg');
    if (img) img.src = src;
    const thumbs = document.querySelectorAll('.single-mq-thumb');
    thumbs.forEach(t => {
        if (t.getAttribute('data-src') === src) {
            t.classList.add('border-amber-400');
            t.classList.remove('border-transparent');
        } else {
            t.classList.remove('border-amber-400');
            t.classList.add('border-transparent');
        }
    });
}

let _mqVerifiedState = {};

function onToggleMqVerify(idKey) {
    const chk = document.getElementById('chkMqVerified_' + idKey);
    const isChecked = chk ? chk.checked : false;
    _mqVerifiedState[idKey] = isChecked;

    const btnApprove = document.getElementById('btnApproveSingle_' + idKey);
    const lblBadge = document.getElementById('lblMqVerified_' + idKey);
    const txtBadge = document.getElementById('txtMqVerified_' + idKey);
    const hintEl = document.getElementById('approvalStatusHint_' + idKey);

    if (lblBadge) {
        if (isChecked) {
            lblBadge.classList.add('verified');
        } else {
            lblBadge.classList.remove('verified');
        }
    }

    if (txtBadge) {
        txtBadge.textContent = isChecked ? '✓ Đã kiểm tra Maquette' : 'Xác nhận đã kiểm tra';
    }

    if (hintEl) {
        hintEl.innerHTML = isChecked ?
            `<span class="text-emerald-400 font-medium text-[11px]">Đã đối soát MQ — Sẵn sàng duyệt</span>` :
            `<span class="text-gray-400 font-normal text-[11px]">Cần tích xác nhận trước khi duyệt</span>`;
    }

    if (btnApprove) {
        btnApprove.disabled = !isChecked;
        if (isChecked) {
            btnApprove.classList.remove('prod-app-btn-disabled');
            btnApprove.classList.add('prod-app-btn-active');
            btnApprove.removeAttribute('title');
        } else {
            btnApprove.classList.add('prod-app-btn-disabled');
            btnApprove.classList.remove('prod-app-btn-active');
            btnApprove.setAttribute('title', 'Vui lòng tích ô Đã kiểm tra ở bên trái');
        }
    }
}
window.onToggleMqVerify = onToggleMqVerify;

function approveSingleProductionItem(idKey) {
    const item = _productionApprovalItems.find(i => (i.__backendId || i.id) == idKey);
    if (!item) return;

    const btn = document.getElementById('btnApproveSingle_' + idKey);
    if (btn) {
        btn.innerHTML = `
            <div class="flex items-center gap-2">
                <svg class="w-4 h-4 text-white animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                <span>Đang ghi nhận duyệt...</span>
            </div>
        `;
        btn.disabled = true;
    }

    delete _mqVerifiedState[idKey];
    approveProductionItem(idKey);

    setTimeout(() => {
        const remainingPending = _productionApprovalItems.filter(i => (i.productionApprovalStatus || 'pending') === 'pending');
        if (_productionApprovalCurrentIndex >= remainingPending.length) {
            _productionApprovalCurrentIndex = Math.max(0, remainingPending.length - 1);
        }
        renderProductionApprovalList();
    }, 450);
}

// Global keyboard navigation for single point approval on Desktop
if (typeof window !== 'undefined' && !window.__prodApprovalKeyHandlerAttached) {
    window.__prodApprovalKeyHandlerAttached = true;
    window.addEventListener('keydown', (e) => {
        if (!_productionApprovalActive) return;
        const modal = document.getElementById('productionApprovalModal');
        if (!modal || modal.classList.contains('hidden')) return;
        if (window.innerWidth < 1024) return;
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            nextProductionApprovalItem();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            prevProductionApprovalItem();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeProductionApprovalModal();
        }
    });
}

function renderDesktopSingleApprovalView(container, displayList, pendingItems, approvedItems, rejectedItems) {
    if (!displayList.length) {
        if (_productionApprovalTab === 'pending') {
            container.innerHTML = `
                <div class="prod-app-empty-desktop py-16 px-6 flex flex-col items-center justify-center text-center m-auto">
                    <div class="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center mb-4 shadow-lg shadow-emerald-500/10">
                        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M5 13l4 4L19 7"/></svg>
                    </div>
                    <h3 class="text-base font-bold text-gray-100 dark:text-gray-100 text-slate-800">Hoàn tất duyệt sản xuất!</h3>
                    <p class="text-xs text-gray-400 dark:text-gray-400 text-slate-500 mt-1 max-w-sm">Toàn bộ điểm bán chờ duyệt đã được thẩm định và xác nhận thi công.</p>
                    ${approvedItems.length > 0 ? `
                        <button type="button" onclick="setProductionApprovalTab('approved')" class="mt-5 px-5 py-2.5 bg-gray-800 dark:bg-gray-800 bg-slate-200 hover:bg-gray-700 dark:hover:bg-gray-700 hover:bg-slate-300 text-gray-200 dark:text-gray-200 text-slate-800 text-xs font-bold rounded-xl border border-gray-700 dark:border-gray-700 border-slate-300 transition-all cursor-pointer">
                            Xem các điểm đã đồng ý (${approvedItems.length})
                        </button>
                    ` : ''}
                </div>
            `;
        } else if (_productionApprovalTab === 'approved') {
            container.innerHTML = `
                <div class="prod-app-empty-desktop py-16 px-6 flex flex-col items-center justify-center text-center m-auto">
                    <div class="w-16 h-16 rounded-2xl bg-gray-800 dark:bg-gray-800 bg-slate-200 border border-gray-700 dark:border-gray-700 border-slate-300 text-gray-400 flex items-center justify-center mb-4">
                        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                    </div>
                    <h3 class="text-base font-bold text-gray-100 dark:text-gray-100 text-slate-800">Chưa có điểm nào đã đồng ý</h3>
                    <p class="text-xs text-gray-400 dark:text-gray-400 text-slate-500 mt-1 max-w-sm">Các điểm sau khi bạn xác nhận thi công sẽ được lưu trữ và hiển thị tại đây.</p>
                    <button type="button" onclick="setProductionApprovalTab('pending')" class="mt-5 px-5 py-2.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold rounded-xl transition-all cursor-pointer">
                        Quay lại danh sách Chờ duyệt (${pendingItems.length})
                    </button>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div class="prod-app-empty-desktop py-16 px-6 flex flex-col items-center justify-center text-center m-auto">
                    <div class="w-16 h-16 rounded-2xl bg-gray-800 dark:bg-gray-800 bg-slate-200 border border-gray-700 dark:border-gray-700 border-slate-300 text-gray-400 flex items-center justify-center mb-4">
                        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>
                    </div>
                    <h3 class="text-base font-bold text-gray-100 dark:text-gray-100 text-slate-800">Chưa có điểm nào bị từ chối</h3>
                    <p class="text-xs text-gray-400 dark:text-gray-400 text-slate-500 mt-1 max-w-sm">Danh sách các điểm bị từ chối sản xuất hoặc cần chỉnh sửa sẽ xuất hiện tại đây.</p>
                    <button type="button" onclick="setProductionApprovalTab('pending')" class="mt-5 px-5 py-2.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold rounded-xl transition-all cursor-pointer">
                        Quay lại danh sách Chờ duyệt (${pendingItems.length})
                    </button>
                </div>
            `;
        }
        return;
    }

    if (_productionApprovalCurrentIndex >= displayList.length) {
        _productionApprovalCurrentIndex = displayList.length - 1;
    }
    if (_productionApprovalCurrentIndex < 0) {
        _productionApprovalCurrentIndex = 0;
    }

    const item = displayList[_productionApprovalCurrentIndex];
    const idKey = item.__backendId || item.id || _productionApprovalCurrentIndex;
    const quoteCode = item.quoteCode || item.tkCode || '---';
    const amountStr = formatVnd(item.amount || item.totalAmount || 0);
    const outletName = item.outletName || 'Outlet';
    const outletCode = item.outletCode || '---';
    const region = item.region || 'S16';
    const rejectReason = item.rejectReason || item.production_reject_reason || '';
    const mqImages = parseMqDesignImages(item);
    let itemsList = [];
    try {
        itemsList = typeof item.items === 'string' ? JSON.parse(item.items) : (Array.isArray(item.items) ? item.items : []);
    } catch (_) { itemsList = []; }

    const isPending = (_productionApprovalTab === 'pending');
    const isApproved = (_productionApprovalTab === 'approved');
    const isVerified = isPending ? !!_mqVerifiedState[idKey] : true;

    container.innerHTML = `
        <div class="prod-app-single-wrapper flex flex-col h-full w-full select-none">
            <!-- 1. Main Content Split View (Widescreen 2 Cột - Tối Ưu Tầm Mắt) -->
            <div class="prod-app-single-body flex-1 grid grid-cols-12 gap-4 p-4 overflow-hidden min-h-0">
                <!-- Cột Trái: Trình Xem MQ Khổ Lớn (Col 7 / 12) -->
                <div class="col-span-7 flex flex-col h-full bg-[#111827] rounded-2xl border border-gray-800 overflow-hidden relative shadow-inner prod-app-mq-panel">
                    <!-- Header MQ: Thông tin Điểm Bán & Mã BG - Mã TK (thay thế text BẢN VẼ THIẾT KẾ MAQUETTE và chữ Phóng to) -->
                    <div class="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between bg-gray-900/60 prod-app-mq-header flex-shrink-0">
                        <!-- Thông tin Điểm bán: Tên Outlet và Mã Outlet cùng size, Mã Outlet màu xanh -->
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="text-sm font-bold text-gray-100 truncate" title="${escapeHtml(outletName)}">${escapeHtml(outletName)}</span>
                            <span class="text-sm font-bold font-mono prod-app-outlet-code text-sky-400 flex-shrink-0">#${escapeHtml(outletCode)}</span>
                        </div>

                        <!-- Mã BG và Mã TK thay thế chữ Phóng to -->
                        <div class="flex items-center gap-2.5 flex-shrink-0 text-xs font-mono text-gray-300">
                            <span>BG: <strong class="font-bold text-gray-100">${escapeHtml(quoteCode)}</strong></span>
                            ${item.tkCode && item.tkCode !== quoteCode ? `
                                <span class="text-gray-600">•</span>
                                <span>TK: <strong class="font-bold text-gray-300">${escapeHtml(item.tkCode)}</strong></span>
                            ` : ''}
                        </div>
                    </div>

                    <!-- Image Viewport -->
                    <div class="flex-1 flex items-center justify-center p-3 overflow-hidden bg-black/35 relative group cursor-zoom-in" onclick="${mqImages.length > 0 ? `openMqImagePreview(document.getElementById('singleFocusMqImg').src, '${idKey}')` : ''}">
                        ${mqImages.length > 0 ? `
                            <img id="singleFocusMqImg" src="${escapeHtml(mqImages[0])}" data-img-url="${escapeHtml(mqImages[0])}" class="max-h-full max-w-full object-contain rounded-xl shadow-md transition-transform duration-200 group-hover:scale-[1.01]" alt="Maquette Design">
                        ` : `
                            <div class="flex flex-col items-center justify-center text-gray-500 py-12">
                                <span class="text-xs">Chưa có ảnh Maquette thiết kế</span>
                            </div>
                        `}
                    </div>

                    <!-- Thumbnail Selector if multiple images -->
                    ${mqImages.length > 1 ? `
                        <div class="p-2 border-t border-gray-800 bg-gray-900/60 flex items-center gap-2 overflow-x-auto flex-shrink-0">
                            ${mqImages.map((img, iIdx) => `
                                <img src="${escapeHtml(img)}" data-src="${escapeHtml(img)}" onclick="setSingleFocusMqImg('${escapeHtml(img)}')" class="single-mq-thumb h-10 w-16 object-cover rounded-lg border-2 ${iIdx === 0 ? 'border-slate-300' : 'border-transparent'} hover:border-slate-500 cursor-pointer transition-all flex-shrink-0" alt="MQ Thumb ${iIdx + 1}">
                            `).join('')}
                        </div>
                    ` : ''}

                    <!-- Footer MQ: Thanh điều khiển vuốt & hành động y như Mobile, Vuốt dài nhất bên trái -->
                    <div class="prod-app-mq-footer-bar px-3 py-2 border-t border-gray-800 bg-[#0d1527] flex items-center gap-2.5 flex-shrink-0 min-h-[54px]">
                        ${isPending ? `
                            <!-- 1. Vuốt đồng ý (Dài nhất - flex-1) -->
                            <div id="swipeContainer_${idKey}" class="prod-app-swipe-box prod-app-swipe-container flex-1 rounded-full h-[40px] relative flex items-center px-1 overflow-hidden select-none touch-none cursor-pointer" title="Kéo nút sang phải để đồng ý sản xuất">
                                <!-- Gradient Progress Fill Bar -->
                                <div id="swipeFill_${idKey}" class="prod-app-swipe-fill absolute left-0 top-0 bottom-0 rounded-l-full transition-all duration-75 pointer-events-none w-0"></div>
                                
                                <!-- Knob -->
                                <div id="swipeKnob_${idKey}" onmousedown="initSwipeDrag(event, '${idKey}')" ontouchstart="initSwipeDrag(event, '${idKey}')" class="prod-app-swipe-knob w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs cursor-grab active:cursor-grabbing z-10 transition-transform">
                                    <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg>
                                </div>
                                <div id="swipeLabel_${idKey}" class="prod-app-swipe-label absolute inset-0 flex items-center justify-center text-xs font-bold pointer-events-none pl-7 pr-2 text-center whitespace-nowrap overflow-hidden text-ellipsis tracking-wider transition-opacity">
                                    <span class="prod-app-swipe-text">Vuốt đồng ý sản xuất</span>
                                </div>
                            </div>

                            <!-- 2. Nút Yêu cầu chỉnh sửa (Amber) -->
                            <button type="button" onclick="promptRequestEditProduction('${idKey}')" class="prod-app-btn-edit h-[40px] px-3.5 rounded-xl font-bold text-xs flex items-center justify-center transition-all flex-shrink-0 whitespace-nowrap cursor-pointer shadow-sm active:scale-95" title="Yêu cầu chỉnh sửa maquette hoặc báo giá">
                                <span>Yêu cầu chỉnh sửa</span>
                            </button>

                            <!-- 3. Nút Từ chối (Đỏ) -->
                            <button type="button" onclick="promptRejectProduction('${idKey}')" class="prod-app-btn-reject h-[40px] px-3.5 rounded-xl font-bold text-xs flex items-center justify-center transition-all flex-shrink-0 whitespace-nowrap cursor-pointer shadow-sm active:scale-95" title="Từ chối sản xuất điểm này">
                                <span>Từ chối</span>
                            </button>
                        ` : `
                            <div class="flex items-center justify-between w-full">
                                <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${isApproved ? 'bg-emerald-950/40 border border-emerald-700/60 text-emerald-400' : 'bg-red-950/40 border border-red-700/60 text-red-400'} font-bold text-xs">
                                    ${isApproved ? '✓ Đã đồng ý sản xuất' : '✕ Đã từ chối sản xuất'}
                                </span>
                                ${isApproved ? `
                                    <button type="button" onclick="undoApproveProduction('${idKey}')" class="px-3.5 py-1.5 rounded-lg border border-gray-600 bg-gray-800 text-gray-200 hover:bg-gray-700 font-semibold text-xs transition-all shadow-sm active:scale-95 cursor-pointer">
                                        <span>Hoàn tác về Chờ duyệt</span>
                                    </button>
                                ` : `
                                    <button type="button" onclick="undoApproveProduction('${idKey}')" class="px-3.5 py-1.5 rounded-lg border border-gray-600 bg-gray-800 text-gray-200 hover:bg-gray-700 font-semibold text-xs transition-all shadow-sm active:scale-95 cursor-pointer">
                                        <span>Xem xét lại</span>
                                    </button>
                                `}
                            </div>
                        `}
                    </div>
                </div>

                <!-- Cột Phải: Danh Sách Hạng Mục Thi Công (Col 5 / 12 - Rộng rãi & Rõ ràng) -->
                <div class="col-span-5 flex flex-col h-full bg-[#111827] rounded-2xl border border-gray-800 p-4 overflow-hidden prod-app-details-panel">
                    <!-- Header Hạng mục: Bỏ icon, tối giản -->
                    <div class="flex items-center justify-between pb-3 border-b border-gray-800 mb-3 flex-shrink-0">
                        <span class="text-xs font-bold text-gray-300 uppercase tracking-wider">Hạng mục thi công (${itemsList.length})</span>
                        <span class="text-[11px] text-gray-400 font-medium">Đối soát với Maquette</span>
                    </div>

                    ${rejectReason ? `
                        <div class="mb-3 p-2.5 rounded-xl bg-red-950/40 border border-red-800/60 text-red-300 text-xs flex-shrink-0">
                            <strong class="font-bold">Lý do từ chối:</strong> ${escapeHtml(rejectReason)}
                        </div>
                    ` : ''}

                    <!-- Items Specs List: Các dòng ngăn cách bởi 1 đường kẻ ngang tinh tế -->
                    <div class="flex-1 overflow-y-auto pr-1 divide-y divide-gray-800/80">
                        ${itemsList.length > 0 ? itemsList.map((it, itIdx) => {
                            const brand = it.brand || it.brandName || '';
                            const brandClass = getBrandBadgeClass(brand);
                            const itemName = it.name || it.content || it.type || it.hang_muc || it.item_name || it.title || 'Hạng mục';
                            let itemSize = it.size || it.dim || '';
                            if (!itemSize && (it.width || it.height)) {
                                itemSize = `${it.width || 0}m x ${it.height || 0}m`;
                            }
                            return `
                                <div class="py-3 px-1.5 text-xs text-gray-200 flex flex-col gap-1.5 hover:bg-gray-800/25 transition-colors">
                                    <div class="flex items-center justify-between gap-3">
                                        <span class="font-bold text-gray-100 text-[13.5px] leading-snug">${itIdx + 1}. ${escapeHtml(itemName)}</span>
                                        ${brand ? `<span class="px-2.5 py-1 text-xs font-bold rounded-lg ${brandClass} flex-shrink-0 tracking-wide uppercase shadow-sm">${escapeHtml(brand)}</span>` : ''}
                                    </div>
                                    ${itemSize ? `
                                        <div class="flex items-center gap-1.5 text-[11.5px] text-gray-400 font-mono mt-0.5">
                                            <span>Quy cách:</span>
                                            <span class="text-gray-200 font-medium px-2 py-0.5 rounded bg-gray-800/90 border border-gray-700/60">${escapeHtml(itemSize)}</span>
                                        </div>
                                    ` : ''}
                                </div>
                            `;
                        }).join('') : `
                            <div class="text-xs text-gray-500 italic py-6 text-center">• Hạng mục sản xuất & thi công theo báo giá đã duyệt</div>
                        `}
                    </div>

                    <!-- Footer Hạng mục: Tổng tiền nổi bật phù hợp với chế độ xem -->
                    <div class="prod-app-details-footer-bar px-4 py-2 mt-auto border-t border-gray-800 bg-[#0d1527] flex items-center justify-between flex-shrink-0 min-h-[54px] rounded-b-xl">
                        <div>
                            <span class="text-xs font-bold text-gray-200 uppercase tracking-wider">Tổng tiền:</span>
                        </div>
                        <div class="text-right">
                            <span class="prod-app-total-amount text-xl font-black tracking-tight">${amountStr}</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 2. Bottom Action Bar: Stepper Phân Trang Đưa Về Sát Cạnh Phải -->
            <div id="actionContainer_${idKey}" class="prod-app-single-actions px-5 py-2.5 border-t border-gray-800 bg-[#0f172a] flex items-center justify-between gap-4 flex-shrink-0">
                <!-- Hint phím tắt bên trái -->
                <div class="text-xs text-gray-400 font-medium hidden sm:flex items-center gap-2">
                    <span>Phím tắt:</span>
                    <span class="inline-flex items-center gap-1 text-[11px] text-gray-300">
                        <kbd class="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 font-mono">←</kbd>
                        <kbd class="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 font-mono">→</kbd>
                        chuyển điểm
                    </span>
                </div>

                <!-- Bộ Điều Hướng Stepper Phân Trang Sát Cạnh Phải -->
                <div class="flex items-center gap-1.5 bg-gray-900/90 p-1 rounded-xl border border-gray-800 shadow-inner ml-auto">
                    <button type="button" onclick="prevProductionApprovalItem()" ${_productionApprovalCurrentIndex === 0 ? 'disabled' : ''} class="prod-app-nav-btn px-3 py-1.5 rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 text-gray-200 disabled:opacity-25 disabled:pointer-events-none text-xs font-bold flex items-center gap-1 transition-all cursor-pointer shadow-sm active:scale-95" title="Xem điểm trước (Phím Mũi Tên Trái)">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/></svg>
                        <span>Trước</span>
                    </button>
                    <div class="px-3.5 py-1 font-mono font-bold text-xs text-gray-200 select-none">
                        Điểm ${_productionApprovalCurrentIndex + 1} / ${displayList.length}
                    </div>
                    <button type="button" onclick="nextProductionApprovalItem()" ${_productionApprovalCurrentIndex === displayList.length - 1 ? 'disabled' : ''} class="prod-app-nav-btn px-3 py-1.5 rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 text-gray-200 disabled:opacity-25 disabled:pointer-events-none text-xs font-bold flex items-center gap-1 transition-all cursor-pointer shadow-sm active:scale-95" title="Xem điểm tiếp theo (Phím Mũi Tên Phải)">
                        <span>Tiếp</span>
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/></svg>
                    </button>
                </div>
            </div>
        </div>
    `;
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

    // Desktop Single-Item Focus Inspection Mode (Duyệt từng điểm một)
    const isDesktop = (typeof window !== 'undefined') && ((window.innerWidth >= 1024) || (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches));
    if (isDesktop) {
        renderDesktopSingleApprovalView(container, displayList, pendingItems, approvedItems, rejectedItems);
        return;
    }

    if (!displayList.length) {
        container.innerHTML = `
            <div class="prod-app-empty py-16 text-center text-sm font-medium">
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
            <div class="prod-app-card rounded-2xl p-4 mb-4 relative">
                <!-- Header Row -->
                <div class="flex justify-between items-center mb-1">
                    <div class="flex items-center gap-1.5">
                        <span class="prod-app-quote-code text-xs font-mono font-bold tracking-wider">MÃ BÁO GIÁ: ${escapeHtml(quoteCode)}</span>
                        ${rejectReason ? `
                            <span onclick="showRejectionReasonTooltip('${escapeHtml(rejectReason)}')" class="inline-flex items-center cursor-pointer group" title="Rê chuột/Chạm để xem lý do từ chối">
                                <span class="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shadow-sm"></span>
                            </span>
                        ` : ''}
                    </div>
                    <span class="prod-app-amount text-sm font-bold">${amountStr}</span>
                </div>
                <!-- Outlet Row -->
                <div class="mb-3">
                    <h4 class="prod-app-outlet-name text-base font-bold uppercase tracking-wide">${escapeHtml(outletName)}</h4>
                    <div class="prod-app-outlet-meta text-xs">${escapeHtml(outletCode)} · ${escapeHtml(region)}</div>
                </div>

                <!-- Items & MQ Content Box -->
                <div class="prod-app-inner-box rounded-xl p-3 mb-3 space-y-3">
                    <!-- 1. MQ Design Image (TOP - CENTERED HORIZONTALLY, NO ICON / NO HEADER TEXT) -->
                    ${mqImages.length > 0 ? `
                        <div class="w-full flex justify-center items-center py-1">
                            <div class="flex gap-2 overflow-x-auto justify-center items-center max-w-full">
                                ${mqImages.map(img => `
                                    <img src="${escapeHtml(img)}" data-img-url="${escapeHtml(img)}" onclick="handleMqImageClick(this, '${idKey}')" class="prod-app-mq-img max-h-56 w-auto max-w-full rounded-xl object-contain shadow-md cursor-pointer hover:opacity-95 transition-opacity" alt="MQ Design">
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}

                    <!-- 2. Bullet Items List (BOTTOM - WITH SYSTEM BRAND BADGE COLORS) -->
                    <div class="${mqImages.length > 0 ? 'prod-app-divider pt-2' : ''} space-y-1.5">
                        ${itemsList.length > 0 ? itemsList.map(it => {
            const brand = it.brand || it.brandName || '';
            const brandClass = getBrandBadgeClass(brand);
            return `
                                <div class="prod-app-item-text text-xs flex items-start gap-1.5">
                                    <span class="prod-app-bullet mt-0.5">•</span>
                                    <span class="flex-1">${escapeHtml(it.name || it.type || it.content || 'Hạng mục thi công')} ${it.size ? `(${escapeHtml(it.size)})` : ''}</span>
                                    ${brand ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded-lg ${brandClass}">${escapeHtml(brand)}</span>` : ''}
                                </div>
                            `;
        }).join('') : '<div class="prod-app-empty-items text-xs italic">• Hạng mục sản xuất & thi công theo báo giá</div>'}
                    </div>
                </div>

                <!-- Unified 1-Row Action Control Bar (Comfortable Height 46px, NO Icons) -->
                ${_productionApprovalTab === 'pending' ? `
                    <div class="flex items-center gap-2 mt-3 w-full">
                        <!-- Left: Swipe Slider / Desktop Direct Click Button (Height 46px) -->
                        <div id="swipeContainer_${idKey}" onclick="handleSwipeContainerClick(event, '${idKey}', false)" class="prod-app-swipe-box prod-app-swipe-container flex-1 rounded-full h-[46px] relative flex items-center px-1 overflow-hidden select-none touch-none cursor-pointer" title="Nhấp chuột để đồng ý sản xuất (hoặc vuốt trên di động)">
                            <!-- Gradient Progress Fill Bar -->
                            <div id="swipeFill_${idKey}" class="prod-app-swipe-fill absolute left-0 top-0 bottom-0 rounded-l-full transition-all duration-75 pointer-events-none w-0"></div>
                            
                            <!-- Knob -->
                            <div id="swipeKnob_${idKey}" onmousedown="initSwipeDrag(event, '${idKey}')" ontouchstart="initSwipeDrag(event, '${idKey}')" class="prod-app-swipe-knob w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs cursor-grab active:cursor-grabbing z-10 transition-transform">
                                <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7"/></svg>
                            </div>
                            <div id="swipeLabel_${idKey}" class="prod-app-swipe-label absolute inset-0 flex items-center justify-center text-xs font-bold pointer-events-none pl-6 pr-2 text-center whitespace-nowrap overflow-hidden text-ellipsis tracking-wider transition-opacity">
                                <span class="prod-app-swipe-text">Vuốt đồng ý</span>
                            </div>
                        </div>

                        <!-- Middle: Edit Request Button -->
                        <button onclick="promptRequestEditProduction('${idKey}')" class="prod-app-btn-edit font-bold text-xs h-[46px] px-3.5 rounded-xl flex items-center justify-center transition-all flex-shrink-0 whitespace-nowrap">
                            Chỉnh sửa
                        </button>

                        <!-- Right: Reject Button (No Icon) -->
                        <button onclick="promptRejectProduction('${idKey}')" class="prod-app-btn-reject font-bold text-xs h-[46px] px-3.5 rounded-xl flex items-center justify-center transition-all flex-shrink-0 whitespace-nowrap">
                            Từ chối
                        </button>
                    </div>
                ` : `
                    <div class="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-gray-200 dark:border-gray-800">
                        <div class="flex items-center gap-2">
                            ${item.productionApprovalStatus === 'approved' ? `
                                <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700/60 text-emerald-700 dark:text-emerald-400 font-bold text-xs shadow-sm">
                                    <svg class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
                                    Đã đồng ý sản xuất
                                </span>
                            ` : `
                                <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-700/60 text-red-700 dark:text-red-400 font-bold text-xs shadow-sm cursor-pointer" onclick="showRejectionReasonTooltip('${escapeHtml(rejectReason)}')">
                                    <span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                                    Đã từ chối: ${escapeHtml(rejectReason || 'Không đồng ý')}
                                </span>
                            `}
                        </div>
                        ${item.productionApprovalStatus === 'approved' ? `
                            <button onclick="undoApproveProduction('${idKey}')" class="px-4 py-2 rounded-xl border border-amber-400 bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60 hover:border-amber-500 font-bold text-xs flex items-center gap-1.5 transition-all shadow-sm active:scale-95 cursor-pointer" title="Chuyển điểm này về lại danh sách Chờ duyệt">
                                <svg class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M3 10h10a5 5 0 015 5v2m0 0l-4-4m4 4l4-4M3 10l4-4m-4 4l4 4"/></svg>
                                <span>Hoàn tác</span>
                            </button>
                        ` : `
                            <button onclick="undoApproveProduction('${idKey}')" class="px-4 py-2 rounded-xl border border-blue-400 bg-blue-50 dark:bg-blue-950/50 text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60 hover:border-blue-500 font-bold text-xs flex items-center gap-1.5 transition-all shadow-sm active:scale-95 cursor-pointer" title="Đưa về lại danh sách Chờ duyệt">
                                <svg class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M3 10h10a5 5 0 015 5v2m0 0l-4-4m4 4l4-4M3 10l4-4m-4 4l4 4"/></svg>
                                <span>Xem xét lại</span>
                            </button>
                        `}
                    </div>
                `}
            </div>
        `;
    });

    container.innerHTML = html;
}

/** Direct Click handler for Mouse / Desktop pointer devices */
function handleSwipeContainerClick(event, idKey, isModal) {
    const isDesktop = (window.innerWidth >= 1024) || (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
    if (isDesktop) {
        event.stopPropagation();
        if (isModal) closeMqImagePreview();
        approveProductionItem(idKey);
    }
}

/** Swipe Drag Logic for Main Card List */
function initSwipeDrag(event, idKey) {
    if (event.cancelable) event.preventDefault();
    const knob = document.getElementById('swipeKnob_' + idKey);
    const container = document.getElementById('swipeContainer_' + idKey);
    const fill = document.getElementById('swipeFill_' + idKey);
    const label = document.getElementById('swipeLabel_' + idKey);
    if (!knob || !container) return;

    const knobWidth = knob.offsetWidth || 36;
    const maxDrag = Math.max(10, container.clientWidth - knobWidth - 8);
    const startX = event.type.startsWith('touch') ? event.touches[0].clientX : event.clientX;
    let deltaX = 0;
    let completed = false;

    knob.style.transition = 'none';
    if (fill) fill.style.transition = 'none';
    if (label) label.style.transition = 'none';

    function onMove(e) {
        if (completed) return;
        const currentX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
        deltaX = currentX - startX;
        if (deltaX < 0) deltaX = 0;
        if (deltaX > maxDrag) deltaX = maxDrag;

        const progress = deltaX / maxDrag;

        knob.style.transform = `translate3d(${deltaX}px, 0, 0) scale(1.05)`;
        if (fill) fill.style.width = `${deltaX + (knobWidth / 2) + 4}px`;
        if (label) {
            label.style.opacity = String(Math.max(0, 1 - progress * 1.8));
            label.style.transform = `translate3d(${deltaX * 0.12}px, 0, 0)`;
        }

        if (deltaX >= maxDrag * 0.88) {
            completed = true;
            cleanup();

            if (typeof navigator !== 'undefined' && navigator.vibrate) {
                try { navigator.vibrate(40); } catch (_) {}
            }

            knob.style.transition = 'transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1)';
            knob.style.transform = `translate3d(${maxDrag}px, 0, 0) scale(1.08)`;
            if (fill) {
                fill.style.transition = 'width 0.18s cubic-bezier(0.2, 0.9, 0.3, 1)';
                fill.style.width = '100%';
            }
            if (label) label.style.opacity = '0';

            knob.innerHTML = '<svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';

            setTimeout(() => {
                approveProductionItem(idKey);
            }, 200);
        }
    }

    function onEnd() {
        if (completed) return;
        cleanup();

        knob.style.transition = 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.25)';
        knob.style.transform = 'translate3d(0, 0, 0) scale(1)';
        if (fill) {
            fill.style.transition = 'width 0.35s ease-out';
            fill.style.width = '0px';
        }
        if (label) {
            label.style.transition = 'opacity 0.25s ease-out, transform 0.35s ease-out';
            label.style.opacity = '1';
            label.style.transform = 'translate3d(0, 0, 0)';
        }

        setTimeout(() => {
            if (!completed) {
                knob.style.transition = '';
                if (fill) fill.style.transition = '';
                if (label) label.style.transition = '';
            }
        }, 420);
    }

    function cleanup() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onEnd);
        window.removeEventListener('touchcancel', onEnd);
    }

    window.addEventListener('mousemove', onMove, { passive: false });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
}

/** Swipe Drag Logic inside Lightbox Image Viewer Modal */
function initSwipeDragModal(event, idKey) {
    if (event.cancelable) event.preventDefault();
    const knob = document.getElementById('swipeKnob_modal_' + idKey);
    const container = document.getElementById('swipeContainer_modal_' + idKey);
    const fill = document.getElementById('swipeFill_modal_' + idKey);
    const label = document.getElementById('swipeLabel_modal_' + idKey);
    if (!knob || !container) return;

    const knobWidth = knob.offsetWidth || 36;
    const maxDrag = Math.max(10, container.clientWidth - knobWidth - 8);
    const startX = event.type.startsWith('touch') ? event.touches[0].clientX : event.clientX;
    let deltaX = 0;
    let completed = false;

    knob.style.transition = 'none';
    if (fill) fill.style.transition = 'none';
    if (label) label.style.transition = 'none';

    function onMove(e) {
        if (completed) return;
        const currentX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
        deltaX = currentX - startX;
        if (deltaX < 0) deltaX = 0;
        if (deltaX > maxDrag) deltaX = maxDrag;

        const progress = deltaX / maxDrag;

        knob.style.transform = `translate3d(${deltaX}px, 0, 0) scale(1.05)`;
        if (fill) fill.style.width = `${deltaX + (knobWidth / 2) + 4}px`;
        if (label) {
            label.style.opacity = String(Math.max(0, 1 - progress * 1.8));
            label.style.transform = `translate3d(${deltaX * 0.12}px, 0, 0)`;
        }

        if (deltaX >= maxDrag * 0.88) {
            completed = true;
            cleanup();

            if (typeof navigator !== 'undefined' && navigator.vibrate) {
                try { navigator.vibrate(40); } catch (_) {}
            }

            knob.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1)';
            knob.style.transform = `translate3d(${maxDrag}px, 0, 0) scale(1.08)`;
            if (fill) {
                fill.style.transition = 'width 0.2s cubic-bezier(0.2, 0.9, 0.3, 1)';
                fill.style.width = '100%';
            }
            if (label) label.style.opacity = '0';

            knob.innerHTML = '<svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';

            setTimeout(() => {
                closeMqImagePreview();
                approveProductionItem(idKey);
            }, 200);
        }
    }

    function onEnd() {
        if (completed) return;
        cleanup();

        knob.style.transition = 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.25)';
        knob.style.transform = 'translate3d(0, 0, 0) scale(1)';
        if (fill) {
            fill.style.transition = 'width 0.35s ease-out';
            fill.style.width = '0px';
        }
        if (label) {
            label.style.transition = 'opacity 0.25s ease-out, transform 0.35s ease-out';
            label.style.opacity = '1';
            label.style.transform = 'translate3d(0, 0, 0)';
        }

        setTimeout(() => {
            if (!completed) {
                knob.style.transition = '';
                if (fill) fill.style.transition = '';
                if (label) label.style.transition = '';
            }
        }, 420);
    }

    function cleanup() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onEnd);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onEnd);
        window.removeEventListener('touchcancel', onEnd);
    }

    window.addEventListener('mousemove', onMove, { passive: false });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
}

function extractQuoteCodeFromIdKey(idStr) {
    if (!idStr) return '';
    const str = String(idStr).trim();
    if (str.toUpperCase().startsWith('TK') || str.toUpperCase().startsWith('BG')) return str;
    const match = str.match(/(TK\d+\.\d+|BG\d+\.\d+|TK\d+|BG\d+)/i);
    if (match) return match[1];
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
            const tkCode = String(item.tkCode || '').trim();
            const payload = { status: 'approved', approvedAt: item.approvedAt };
            if (cleanCode) cache[cleanCode] = payload;
            if (rawCode) cache[rawCode] = payload;
            if (tkCode) cache[tkCode] = payload;
            localStorage.setItem('ks_production_approvals_cache', JSON.stringify(cache));
        }
    } catch (_) { }

    // Notify API backend
    const cleanTargetCode = extractQuoteCodeFromIdKey(idKey || item.quoteCode) || idKey;
    const targetCode = item.quoteCode || item.tkCode || cleanTargetCode;
    const base = (typeof window !== 'undefined' && (window.API_BASE_URL || (window.__env && window.__env.BACKEND_URL)))
        ? String(window.API_BASE_URL || window.__env.BACKEND_URL).replace(/\/+$/, '')
        : 'https://ks-backend-staging-493469512136.asia-southeast1.run.app';
    fetch(base + '/api/ks/requests/' + encodeURIComponent(targetCode) + '/approve-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'approved',
            quoteCode: item.quoteCode || cleanTargetCode,
            tkCode: item.tkCode || cleanTargetCode,
            outletCode: item.outletCode || item.outlet_code || '',
            outletName: item.outletName || item.outlet_name || '',
            approvedBy: (typeof currentSession !== 'undefined' && currentSession ? (currentSession.saleName || currentSession.phone) : 'Sale Heineken')
        })
    }).catch(err => console.warn('Approve API error:', err));

    // Trigger native App 2 toast notification & Instant Undo Toast
    const msg = 'Bạn đã xác nhận thi công ' + (item.outletName || 'Outlet');
    if (typeof showToast === 'function') {
        showToast(msg);
    }
    showApprovalUndoToast(idKey, item.outletName || 'Outlet');

    // In-place UI feedback: replace swipe bar with glowing green success badge immediately
    const actionContainer = document.getElementById('actionContainer_' + idKey);
    if (actionContainer) {
        actionContainer.innerHTML = `
            <div class="w-full text-xs text-center font-semibold flex items-center justify-center gap-1.5 text-emerald-400 py-2.5 px-3 bg-emerald-950/50 border border-emerald-500/60 rounded-2xl animate-pulse shadow-lg shadow-emerald-500/20">
                <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
                <span>Đã đồng ý sản xuất</span>
            </div>
        `;
    }

    updateProductionApprovalBadge();

    // Smoothly collapse card after 1.2s delay so Sale sees clear visual confirmation without sudden disappearance
    setTimeout(() => {
        const card = actionContainer ? actionContainer.closest('.prod-app-card') : null;
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

let _approvalUndoTimer = null;

/** Hiển thị thanh Toast Hoàn tác nổi góc dưới màn hình */
function showApprovalUndoToast(idKey, outletName) {
    if (_approvalUndoTimer) clearTimeout(_approvalUndoTimer);
    let toast = document.getElementById('productionApprovalUndoToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'productionApprovalUndoToast';
        toast.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 z-[10000] flex items-center gap-3 px-4 py-3 bg-gray-900/95 dark:bg-gray-950/95 text-white rounded-2xl shadow-2xl border border-emerald-500/50 backdrop-blur-md transition-all duration-300 text-xs font-medium';
        document.body.appendChild(toast);
    }

    toast.innerHTML = `
        <span class="flex items-center gap-2 text-emerald-400 font-bold">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping shrink-0"></span>
            <span>Đã đồng ý: <strong class="text-white font-semibold truncate max-w-[180px] inline-block align-bottom">${escapeHtml(outletName)}</strong></span>
        </span>
        <div class="h-4 w-[1px] bg-gray-700"></div>
        <button onclick="undoApproveProduction('${idKey}')" class="px-3.5 py-1.5 bg-amber-400 hover:bg-amber-300 active:bg-amber-500 text-gray-950 font-bold rounded-xl transition-all shadow-md flex items-center gap-1.5 active:scale-95 cursor-pointer">
            <svg class="w-3.5 h-3.5 text-gray-950" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M3 10h10a5 5 0 015 5v2m0 0l-4-4m4 4l4-4M3 10l4-4m-4 4l4 4"/></svg>
            <span>Hoàn tác</span>
        </button>
        <button onclick="dismissApprovalUndoToast()" class="text-gray-400 hover:text-white ml-0.5 p-1 rounded-lg hover:bg-white/10 transition-colors cursor-pointer flex items-center justify-center" aria-label="Đóng thông báo">
            <svg class="w-3.5 h-3.5 text-current" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
    `;

    toast.style.opacity = '1';
    toast.style.transform = 'translate(-50%, 0)';
    toast.classList.remove('hidden');

    _approvalUndoTimer = setTimeout(() => {
        dismissApprovalUndoToast();
    }, 8000);
}

/** Đóng thanh Toast Hoàn tác */
function dismissApprovalUndoToast() {
    if (_approvalUndoTimer) clearTimeout(_approvalUndoTimer);
    const toast = document.getElementById('productionApprovalUndoToast');
    if (toast) {
        toast.style.opacity = '0';
        toast.style.transform = 'translate(-50%, 20px)';
        setTimeout(() => toast.classList.add('hidden'), 300);
    }
}

/** Hoàn tác duyệt đơn: Chuyển điểm bán từ Approved về lại Pending */
function undoApproveProduction(idKey) {
    dismissApprovalUndoToast();
    const item = _productionApprovalItems.find(i => (i.__backendId || i.id) == idKey);
    if (!item) return;

    item.productionApprovalStatus = 'pending';
    delete item.approvedAt;

    // Remove from local storage approved cache
    try {
        if (typeof localStorage !== 'undefined') {
            const cache = JSON.parse(localStorage.getItem('ks_production_approvals_cache') || '{}');
            const cleanCode = extractQuoteCodeFromIdKey(idKey || item.quoteCode || item.__backendId || item.id);
            const rawCode = String(item.quoteCode || idKey || '').trim();
            const tkCode = String(item.tkCode || '').trim();
            if (cleanCode && cache[cleanCode]) delete cache[cleanCode];
            if (rawCode && cache[rawCode]) delete cache[rawCode];
            if (tkCode && cache[tkCode]) delete cache[tkCode];
            localStorage.setItem('ks_production_approvals_cache', JSON.stringify(cache));
        }
    } catch (_) { }

    // Notify API backend to revert
    const cleanTargetCode = extractQuoteCodeFromIdKey(idKey || item.quoteCode) || idKey;
    const targetCode = item.quoteCode || item.tkCode || cleanTargetCode;
    const base = (typeof window !== 'undefined' && (window.API_BASE_URL || (window.__env && window.__env.BACKEND_URL)))
        ? String(window.API_BASE_URL || window.__env.BACKEND_URL).replace(/\/+$/, '')
        : 'https://ks-backend-staging-493469512136.asia-southeast1.run.app';
    fetch(base + '/api/ks/requests/' + encodeURIComponent(targetCode) + '/revert-production-approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteCode: targetCode, tkCode: targetCode })
    }).catch(() => { });

    updateProductionApprovalBadge();
    setProductionApprovalTab('pending');
    renderProductionApprovalList();

    if (typeof showToast === 'function') {
        showToast('Đã hoàn tác: Điểm bán ' + (item.outletName || '') + ' đã quay lại danh sách Chờ duyệt');
    }
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

    const authorRole = (typeof currentSession !== 'undefined' && currentSession && currentSession.role) ? currentSession.role : 'heineken';
    const authorName = (typeof currentSession !== 'undefined' && currentSession ? (currentSession.saleName || currentSession.phone) : 'Sale Heineken');
    const reqObj = (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) ? allRequests.find(r => (r.__backendId || r.id) == idKey) : null;
    
    if (reqObj && window.dataSdk) {
        let commentsList = [];
        try {
            const rawComments = (currentDetailRequest && (currentDetailRequest.__backendId || currentDetailRequest.id) == idKey && currentDetailRequest.comments)
                ? currentDetailRequest.comments
                : reqObj.comments;
            commentsList = (typeof safeParseComments === 'function') ? safeParseComments(rawComments, []) : [];
        } catch (_) {}
        const newComment = {
            authorRole,
            authorName,
            text: item.rejectReason,
            commentType: 'edit-request',
            createdAt: new Date().toISOString()
        };
        commentsList.push(newComment);
        const commentsJson = JSON.stringify(commentsList);
        const editingRequestedAt = new Date().toISOString();
        reqObj.comments = commentsJson;
        reqObj.status = 'processing';
        reqObj.editingRequestedAt = editingRequestedAt;
        if (typeof currentDetailRequest !== 'undefined' && currentDetailRequest && (currentDetailRequest.__backendId || currentDetailRequest.id) == idKey) {
            Object.assign(currentDetailRequest, { comments: commentsJson, status: 'processing', editingRequestedAt });
        }
        window.dataSdk.update({
            __backendId: reqObj.__backendId,
            comments: commentsJson,
            editingRequestedAt: editingRequestedAt,
            status: 'processing',
            updatedAt: new Date().toISOString()
        }).catch(err => console.warn('dataSdk update error:', err));
    }

    // Send edit request to Desktop QCAG
    const base = (typeof window !== 'undefined' && (window.API_BASE_URL || (window.__env && window.__env.BACKEND_URL)))
        ? String(window.API_BASE_URL || window.__env.BACKEND_URL).replace(/\/+$/, '')
        : 'https://ks-backend-staging-493469512136.asia-southeast1.run.app';
    fetch(base + '/api/ks/requests/' + encodeURIComponent(idKey) + '/request-edit-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            note: item.rejectReason,
            comments: item.rejectReason,
            outletCode: item.outletCode || item.outlet_code || '',
            requestedBy: authorName
        })
    }).catch(err => console.warn('Edit request API error:', err));

    const editMsg = 'Bạn đã gửi yêu cầu chỉnh sửa ' + (item.outletName || 'Outlet');
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
        : 'https://ks-backend-staging-493469512136.asia-southeast1.run.app';
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

    const rejectMsg = 'Bạn đã từ chối sản xuất ' + (item.outletName || 'Outlet');
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
            // Chặn gọi nặng trên màn hình Desktop QCAG (tính năng duyệt sản xuất chỉ dành cho Mobile Sale)
            if (isQcagDesktopActive() && !_productionApprovalActive) {
                return;
            }
            if (_productionApprovalActive) {
                triggerSingleFetch(true);
            } else {
                fetchProductionApprovalBadgeCount();
            }
        }
    };

    // Refresh badge count when user returns to / focuses the app tab (Throttled 5s, chống double-fire)
    let _lastVisibilityBadgeSync = 0;
    const _throttledVisibilitySync = () => {
        if (isQcagDesktopActive() && !_productionApprovalActive) return;
        const now = Date.now();
        if (now - _lastVisibilityBadgeSync < 5000) return;
        _lastVisibilityBadgeSync = now;
        if (_productionApprovalActive) triggerSingleFetch();
        else fetchProductionApprovalBadgeCount();
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            _throttledVisibilitySync();
        }
    });

    window.addEventListener('focus', () => {
        _throttledVisibilitySync();
    });

    if (isQcagDesktopActive() && !_productionApprovalActive) {
        // Desktop QCAG: bỏ qua gọi khi tải trang ban đầu (chống bão query)
    } else {
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            fetchProductionApprovalBadgeCount();
        } else {
            document.addEventListener('DOMContentLoaded', fetchProductionApprovalBadgeCount);
        }
    }
}
