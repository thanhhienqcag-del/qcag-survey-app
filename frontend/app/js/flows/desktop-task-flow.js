/**
 * App 2 Desktop QCAG — Task Management Flow (Nhiệm Vụ Thiết Kế Đơn Chờ Sản Xuất)
 * ==============================================================================
 * Connects App 1 Pending Orders (Danh Sách Chờ) with Desktop QCAG Designers.
 * Shows Task Badge in Desktop Header, Task List Modal, and Native Task Mode on Main Desktop UI.
 */
'use strict';

let _qcagPendingOrders = [];
let _qcagCurrentTaskOrder = null;
let _qcagTaskSse = null;
let _qcagTaskFetchTimer = null;

// Expose globally so desktop-qcag-flow.js can check task mode anytime
if (typeof window !== 'undefined') {
    window._qcagCurrentTaskOrder = null;
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getQuoteKey(q) {
    if (!q) return '';
    return String(q.__backendId || q.id || q.quote_code || q.quoteCode || q.tk_code || q.tkCode || q.outlet_code || Math.random()).trim();
}

function qcagTaskParseJson(raw, fallback) {
    if (!raw) return fallback;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
}

function qcagTaskGetActiveDesignImages(req) {
    if (!req) return [];
    if (typeof qcagDesktopGetActiveDesignImages === 'function') {
        try { return qcagDesktopGetActiveDesignImages(req) || []; } catch (_) {}
    }
    const raw = qcagTaskParseJson(req.designImages || req.design_images || req.images, []);
    return Array.isArray(raw) ? raw.filter(Boolean) : [];
}

function qcagTaskIsPendingEdit(req) {
    if (!req) return false;
    if (typeof qcagDesktopIsPendingEditRequest === 'function') {
        try { return qcagDesktopIsPendingEditRequest(req); } catch (_) {}
    }
    const status = String(req.productionApprovalStatus || req.status || '').toLowerCase();
    return status === 'pending-edit' || status === 'edit_requested' || status.includes('sửa');
}

function qcagGetCompletedTaskOrders() {
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem('qcag_completed_task_orders');
            if (raw) return JSON.parse(raw);
        }
    } catch (_) {}
    return {};
}

function qcagPruneStaleTaskStorage(activeOrders) {
    if (typeof localStorage === 'undefined' || !Array.isArray(activeOrders)) return;
    try {
        const activeIds = new Set(activeOrders.map(o => String(o.id || o.__backendId || '')).filter(Boolean));
        const activeCodes = new Set(activeOrders.map(o => String((typeof qcagGetTaskOrderCode === 'function' ? qcagGetTaskOrderCode(o) : '') || o.orderCode || o.code || '')).filter(Boolean));

        // 1. Dọn sạch map qcag_completed_task_orders của các đơn không còn tồn tại
        const rawCompleted = localStorage.getItem('qcag_completed_task_orders');
        if (rawCompleted) {
            const map = JSON.parse(rawCompleted);
            if (map && typeof map === 'object') {
                let changed = false;
                Object.keys(map).forEach(key => {
                    if (!key.startsWith('q_')) {
                        if (!activeIds.has(key) && !activeCodes.has(key)) {
                            delete map[key];
                            changed = true;
                        }
                    }
                });
                if (changed) {
                    localStorage.setItem('qcag_completed_task_orders', JSON.stringify(map));
                }
            }
        }

        // 2. Quét dọn các key rác theo orderId
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (!k) continue;
            if (k.startsWith('qcag_grid_checked_') || k.startsWith('qcag_production_unlocked_')) {
                const oid = k.replace('qcag_grid_checked_', '').replace('qcag_production_unlocked_', '');
                if (oid && !activeIds.has(oid) && !activeCodes.has(oid)) {
                    localStorage.removeItem(k);
                }
            } else if (k.startsWith('qcag_point_vfd_')) {
                const parts = k.split('_');
                const oid = parts[3];
                if (oid && !activeIds.has(oid) && !activeCodes.has(oid)) {
                    localStorage.removeItem(k);
                }
            }
        }
    } catch (_) {}
}

function qcagIsTaskOrderCompleted(orderId) {
    if (!orderId) return false;
    const map = qcagGetCompletedTaskOrders();
    return !!map[String(orderId)];
}
const isTaskOrderCompleted = qcagIsTaskOrderCompleted;

function qcagMarkTaskOrderCompleted(orderId, orderCode) {
    if (!orderId) return;
    try {
        const map = qcagGetCompletedTaskOrders();
        const info = {
            completedAt: new Date().toISOString(),
            completedBy: (typeof currentUser !== 'undefined' && currentUser && (currentUser.name || currentUser.username)) || 'Designer'
        };
        map[String(orderId)] = info;
        if (orderCode) map[String(orderCode)] = info;

        // Also map order's quotes if available and approve production for App 1
        let quoteCodes = [];
        let tkCodes = [];
        if (_qcagCurrentTaskOrder && Array.isArray(_qcagCurrentTaskOrder.quotes)) {
            _qcagCurrentTaskOrder.quotes.forEach(q => {
                const qCode = q.quote_code || q.quoteCode || q.id;
                const tkCode = q.tk_code || q.tkCode;
                if (qCode) {
                    quoteCodes.push(qCode);
                    map['q_' + String(qCode)] = info;
                    if (typeof localStorage !== 'undefined') {
                        localStorage.setItem('qcag_quote_approved_' + String(qCode).toLowerCase(), 'true');
                    }
                }
                if (tkCode) {
                    tkCodes.push(tkCode);
                    if (typeof localStorage !== 'undefined') {
                        localStorage.setItem('qcag_quote_approved_' + String(tkCode).toLowerCase(), 'true');
                    }
                }
            });
        }

        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('qcag_completed_task_orders', JSON.stringify(map));
            localStorage.setItem('qcag_production_unlocked_' + String(orderId), 'true');
            if (orderCode) localStorage.setItem('qcag_production_unlocked_' + String(orderCode), 'true');
            localStorage.setItem('qcag_sync_trigger', String(Date.now()));
            if (typeof BroadcastChannel !== 'undefined') {
                try {
                    const bc = new BroadcastChannel('qcag_order_sync');
                    bc.postMessage({
                        type: 'task_order_completed',
                        action: 'unlock_production_order',
                        orderId: String(orderId),
                        orderCode: String(orderCode || ''),
                        quoteCodes: quoteCodes,
                        tkCodes: tkCodes,
                        status: 'approved',
                        timestamp: Date.now()
                    });
                } catch (_) {}
            }
        }

        // Call backend APIs to approve production on App 2 & complete pending order on App 1
        const backends = [
            '', // Relative URL
            'https://qcag-backend-staging-493469512136.asia-southeast1.run.app',
            'https://ks-backend-staging-493469512136.asia-southeast1.run.app'
        ];

        // Mark pending order complete (File in sẵn sàng) on both backends
        // LƯU Ý QUAN TRỌNG: Designer hoàn thành file in TUYỆT ĐỐI KHÔNG DUYỆT SẢN XUẤT THAY CHO SALE HEINEKEN.
        // Trạng thái duyệt sản xuất chỉ được thực hiện bởi Sale Heineken trên App 2 mobile.

        // 2. Mark pending order complete on both backends
        const payload = {
            orderCode: orderCode || '',
            orderId: orderId,
            quoteCodes: quoteCodes,
            completedBy: info.completedBy,
            status: 'completed',
            is_completed: true
        };
        backends.forEach(base => {
            fetch((base ? base : '') + '/pending-orders/' + encodeURIComponent(orderId) + '/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => {});

            fetch((base ? base : '') + '/api/ks/pending-orders/' + encodeURIComponent(orderId) + '/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => {});
        });

    } catch (e) {
        console.warn('qcagMarkTaskOrderCompleted error:', e);
    }
}

function getQcagPendingOrders() {
    return _qcagPendingOrders;
}

function resolveApp1BackendUrl() {
    if (typeof window !== 'undefined' && window.__QCAG_APP1_BACKEND_URL) {
        return String(window.__QCAG_APP1_BACKEND_URL).replace(/\/+$/, '');
    }
    const isStaging = (typeof window !== 'undefined') && (
        (window.API_BASE_URL && window.API_BASE_URL.includes('staging')) ||
        (window.__env && window.__env.BACKEND_URL && window.__env.BACKEND_URL.includes('staging')) ||
        (window.location && (window.location.hostname.includes('staging') || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
    );
    return isStaging
        ? 'https://qcag-backend-staging-493469512136.asia-southeast1.run.app'
        : 'https://qcag-backend-493469512136.asia-southeast1.run.app';
}

function resolvePendingOrdersApiBase() {
    return resolveApp1BackendUrl();
}

function resolveApp2BackendUrlForTask() {
    if (typeof window !== 'undefined' && (window.API_BASE_URL || (window.__env && window.__env.BACKEND_URL))) {
        return String(window.API_BASE_URL || window.__env.BACKEND_URL).replace(/\/+$/, '');
    }
    const isStaging = (typeof window !== 'undefined') && (
        (window.location && (window.location.hostname.includes('staging') || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
    );
    return isStaging
        ? 'https://ks-backend-staging-493469512136.asia-southeast1.run.app'
        : 'https://ks-backend-493469512136.asia-southeast1.run.app';
}

async function qcagFetchProductionApprovalsFromDb() {
    try {
        const app2Base = resolveApp2BackendUrlForTask();

        const res = await fetch(app2Base + '/api/ks/requests/production-approvals').catch(() => null);
        if (res && res.ok) {
            const json = await res.json();
            if (json && json.ok && json.data) {
                const map = new Map();
                let itemsList = [];
                if (Array.isArray(json.data)) {
                    itemsList = json.data;
                } else if (typeof json.data === 'object') {
                    itemsList = Object.values(json.data);
                }

                itemsList.forEach(item => {
                    if (!item) return;
                    const st = item.productionApprovalStatus || item.production_approval_status || item.status || 'pending';
                    const payload = {
                        status: st,
                        reason: item.rejectReason || item.production_reject_reason || item.reason || null,
                        approvedBy: item.approvedBy || item.production_approved_by || null,
                        approvedAt: item.approvedAt || item.production_approved_at || null
                    };

                    const qCode = item.quoteCode || item.quote_code || item.tkCode || item.tk_code || item.id;
                    if (qCode) {
                        const raw = String(qCode).trim().toLowerCase();
                        const cleanCode = raw.replace(/^bg[-_]?/i, '');
                        if (cleanCode) map.set(cleanCode, payload);
                        map.set(raw, payload);
                    }
                    if (item.tkCode || item.tk_code) {
                        map.set(String(item.tkCode || item.tk_code).trim().toLowerCase(), payload);
                    }
                    if (item.outletCode || item.outlet_code) {
                        map.set(String(item.outletCode || item.outlet_code).trim().toLowerCase(), payload);
                    }
                });

                if (typeof window !== 'undefined') {
                    window._qcagProductionApprovalStatusMap = map;
                }
                return map;
            }
        }
    } catch (e) {
        console.warn('[DesktopTask] qcagFetchProductionApprovalsFromDb warning:', e);
    }
    return null;
}
if (typeof window !== 'undefined') window.qcagFetchProductionApprovalsFromDb = qcagFetchProductionApprovalsFromDb;

async function fetchQcagPendingOrders() {
    try {
        const base = resolvePendingOrdersApiBase();
        const isTaskActive = !!((typeof _qcagCurrentTaskOrder !== 'undefined' && _qcagCurrentTaskOrder) ||
                             (typeof document !== 'undefined' && document.getElementById('qcagTaskDropdown') && !document.getElementById('qcagTaskDropdown').classList.contains('hidden')));
        // Zero Oversized Transfers: Chỉ nạp /pending-orders?summary=1 (~20KB), KHÔNG nạp trước toàn bộ 6,400 quotations
        const [resOrders, approvalsMap] = await Promise.all([
            fetch(base + '/pending-orders?summary=1').catch(() => null),
            isTaskActive ? qcagFetchProductionApprovalsFromDb() : Promise.resolve(null)
        ]);

        if (resOrders && resOrders.ok) {
            const json = await resOrders.json();
            let orders = [];
            if (json && json.ok && Array.isArray(json.data)) {
                orders = json.data;
            } else if (Array.isArray(json)) {
                orders = json;
            }

            // Đồng bộ trạng thái duyệt sản xuất vào từng quote trong order
            orders.forEach(order => {
                let quotes = [];
                if (Array.isArray(order.quotes)) quotes = order.quotes;
                else if (typeof order.quotes === 'string') {
                    try { quotes = JSON.parse(order.quotes); } catch (_) { quotes = []; }
                }
                quotes.forEach(q => {
                    const code = String(q.quote_code || q.quoteCode || '').trim();
                    const outlet = String(q.outlet_code || q.outletCode || '').trim();

                    // Tra cứu trực tiếp từ bảng approvals nếu có
                    const appMap = approvalsMap || (typeof window !== 'undefined' ? window._qcagProductionApprovalStatusMap : null);
                    if (appMap) {
                        const qKey = code.toLowerCase();
                        const cleanCode = qKey.replace(/^bg[-_]?/i, '');
                        const qTk = String(q.tk_code || q.tkCode || '').trim().toLowerCase();
                        const qOutlet = outlet.toLowerCase();
                        const appr = (appMap.get(cleanCode) || appMap.get(qKey) || appMap.get(qTk) || appMap.get(qOutlet));
                        if (appr && appr.status) {
                            q.productionApprovalStatus = appr.status;
                            if (appr.reason) q.rejectReason = appr.reason;
                        }
                    }
                });
                order.quotes = quotes;
            });

            _qcagPendingOrders = orders;
            try {
                if (typeof localStorage !== 'undefined' && Array.isArray(orders)) {
                    localStorage.setItem('pending_orders_v1', JSON.stringify(orders));
                }
            } catch (_) {}

            // Tự động dọn sạch rác localStorage của các đơn hàng không còn tồn tại
            qcagPruneStaleTaskStorage(orders);
        }
    } catch (e) {
        console.warn('[DesktopTask] fetchQcagPendingOrders warning:', e);
    }

    // LocalStorage fallback if needed
    if ((!_qcagPendingOrders || _qcagPendingOrders.length === 0) && typeof localStorage !== 'undefined') {
        try {
            const local1 = localStorage.getItem('pending_orders_v1');
            const local2 = localStorage.getItem('pendingOrders');
            if (local1) _qcagPendingOrders = JSON.parse(local1);
            else if (local2) _qcagPendingOrders = JSON.parse(local2);
        } catch (_) {}
    }

    updateDesktopTaskBadge();
    
    // If Task Dropdown is currently open, refresh its list
    const taskDd = document.getElementById('qcagTaskDropdown');
    if (taskDd && !taskDd.classList.contains('hidden')) {
        renderQcagTaskList();
    }

    // If currently in Task Mode, update the banner stats and fresh re-render
    if (_qcagCurrentTaskOrder) {
        if (!_qcagCurrentTaskOrder._isProductionOrder) {
            const fresh = Array.isArray(_qcagPendingOrders) ? _qcagPendingOrders.find(o => String(o.id) === String(_qcagCurrentTaskOrder.id)) : null;
            if (fresh) {
                _qcagCurrentTaskOrder = fresh;
                if (typeof window !== 'undefined') window._qcagCurrentTaskOrder = fresh;
                updateDesktopTaskBannerUI();
                if (typeof _qcagDesktopLastRenderFingerprint !== 'undefined') {
                    _qcagDesktopLastRenderFingerprint = '';
                }
                if (typeof renderQCAGDesktopList === 'function') {
                    renderQCAGDesktopList(true);
                }
            } else {
                // ĐƠN HÀNG ĐÃ ĐƯỢC APP 1 CLEAR KHỎI DANH SÁCH CHỜ HOẶC TẠO THÀNH ĐƠN HÀNG SẢN XUẤT
                console.log('[DesktopTask] Active task order was cleared from pending orders. Exiting Task Mode.');
                if (typeof qcagCloseTaskGridView === 'function') qcagCloseTaskGridView();
                if (typeof qcagDesktopExitTaskMode === 'function') qcagDesktopExitTaskMode();
                if (typeof showToast === 'function') {
                    showToast('✓ Gói đơn hàng này đã được App 1 tạo thành Đơn hàng sản xuất và hoàn tất!');
                }
            }
        } else {
            updateDesktopTaskBannerUI();
            if (typeof _qcagDesktopLastRenderFingerprint !== 'undefined') {
                _qcagDesktopLastRenderFingerprint = '';
            }
            if (typeof renderQCAGDesktopList === 'function') {
                renderQCAGDesktopList(true);
            }
        }
    } else {
        // Normal Desktop QCAG Mode: danh sách khảo sát thường do dataSdk và init quản lý, không re-render đè khi fetch pending orders ngầm
    }
}

function updateDesktopTaskBadge() {
    const badge = document.getElementById('qcagDesktopTaskBadge');
    const btn = document.getElementById('qcagDesktopTaskBtn');
    if (!badge) return;

    const count = Array.isArray(_qcagPendingOrders) ? _qcagPendingOrders.length : 0;
    if (count > 0) {
        badge.textContent = String(count);
        badge.classList.remove('hidden');
        if (btn) btn.classList.add('has-tasks');
    } else {
        badge.classList.add('hidden');
        if (btn) btn.classList.remove('has-tasks');
    }
}

let _qcagTaskClickOutsideBound = false;
let _qcagTaskApp1Sse = null;

function closeDesktopTaskSSE() {
    if (_qcagTaskApp1Sse) {
        try { _qcagTaskApp1Sse.close(); } catch (_) {}
        _qcagTaskApp1Sse = null;
    }
}

let _qcagPendingOrdersNeedRefreshOnVisible = false;

function ensureDesktopTaskSSE() {
    if (typeof EventSource === 'undefined') return;

    // SSE Realtime connection (App 1 Backend - nơi phát sinh pending_orders & quotations)
    let _qcagPendingOrdersDebounce = null;
    const _debouncedFetchPendingOrders = () => {
        if (typeof document !== 'undefined' && document.hidden) {
            _qcagPendingOrdersNeedRefreshOnVisible = true;
            return;
        }
        if (_qcagPendingOrdersDebounce) clearTimeout(_qcagPendingOrdersDebounce);
        _qcagPendingOrdersDebounce = setTimeout(() => {
            fetchQcagPendingOrders();
        }, 250);
    };

    const handleSseMessage = async (e) => {
        try {
            if (!e || !e.data) return;
            const raw = String(e.data).trim();
            if (!raw || raw.startsWith(':')) return; // Bỏ qua comment / ping heartbeat

            let data = null;
            try { data = JSON.parse(raw); } catch (_) { return; } // Bỏ qua payload không phải JSON, cấm fetch vu vơ
            if (!data || typeof data !== 'object') return;

            const res = String(data.resource || data.type || '').toLowerCase();
            if (!res || res === 'ks_requests' || res === 'ping' || res === 'heartbeat') return;

            // TUYỆT ĐỐI KHÔNG thêm po_tay_quotations (PO tay là ngách riêng của App 1)
            const isRelevant = 
                res === 'pending_orders' || res === 'pending-orders' ||
                res === 'production-orders' || res === 'production_orders' ||
                res === 'orders' ||
                res === 'quotations' || res === 'quotation_items';

            if (!isRelevant) return;

            // 1. Invalidate toàn bộ RAM cache chi tiết báo giá cũ để đối soát luôn mới nhất
            if (typeof _qcagFullQuoteDetailCache !== 'undefined') {
                _qcagFullQuoteDetailCache.clear();
            }

            // 2. Xóa zombie quote_items trên các request objects
            if (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) {
                allRequests.forEach(r => { if (r) delete r.quote_items; });
            }
            if (typeof currentDetailRequest !== 'undefined' && currentDetailRequest) {
                delete currentDetailRequest.quote_items;
            }
            if (typeof _qcagDesktopFullRequestCache !== 'undefined') {
                Object.values(_qcagDesktopFullRequestCache).forEach(r => { if (r) delete r.quote_items; });
            }

            // 3. Nếu SSE gửi kèm chi tiết báo giá mới, nạp trực tiếp vào RAM cache
            let freshQuoteLoaded = false;
            const rawQ = data && (data.data || data);
            if (rawQ && (rawQ.items || rawQ.quote_items) && (rawQ.quote_code || rawQ.id || rawQ.tk_code)) {
                try {
                    const qObj = Object.assign({}, rawQ);
                    let items = qObj.items || qObj.quote_items;
                    if (typeof items === 'string') {
                        try { items = JSON.parse(items); } catch (_) { items = []; }
                    }
                    qObj.items = Array.isArray(items) ? items : [];
                    qObj.quote_items = qObj.items;

                    if (qObj.quote_code) _qcagFullQuoteDetailCache.set(String(qObj.quote_code).trim().toLowerCase(), qObj);
                    if (qObj.tk_code) _qcagFullQuoteDetailCache.set(String(qObj.tk_code).trim().toLowerCase(), qObj);
                    if (qObj.id) _qcagFullQuoteDetailCache.set(String(qObj.id).trim().toLowerCase(), qObj);
                    if (qObj.outlet_code) _qcagFullQuoteDetailCache.set(String(qObj.outlet_code).trim().toLowerCase(), qObj);

                    if (_qcagCurrentTaskOrder && Array.isArray(_qcagCurrentTaskOrder.quotes)) {
                        const matchInOrder = _qcagCurrentTaskOrder.quotes.find(oq => {
                            if (!oq) return false;
                            const oc = String(oq.quote_code || oq.quoteCode || '').trim().toLowerCase();
                            const otk = String(oq.tk_code || oq.tkCode || '').trim().toLowerCase();
                            return (qObj.quote_code && oc === String(qObj.quote_code).toLowerCase()) ||
                                   (qObj.tk_code && otk === String(qObj.tk_code).toLowerCase());
                        });
                        if (matchInOrder) {
                            matchInOrder.items = qObj.items;
                            matchInOrder.quote_items = qObj.items;
                        }
                    }
                    freshQuoteLoaded = true;
                } catch (_) {}
            }

            // 4. Nếu đang ở Task Mode và chưa có full quote trong SSE payload, nạp ngầm cho điểm đang mở (chống bão query ở chế độ thường)
            const isTaskActive = !!((typeof _qcagCurrentTaskOrder !== 'undefined' && _qcagCurrentTaskOrder) ||
                                 (typeof document !== 'undefined' && document.getElementById('qcagTaskDropdown') && !document.getElementById('qcagTaskDropdown').classList.contains('hidden')));
            if (isTaskActive && !freshQuoteLoaded && typeof qcagFetchTaskQuoteDetail === 'function') {
                const targetQuoteId = (data && (data.quote_code || data.code || data.id || (data.data && (data.data.quote_code || data.data.id)))) || null;
                if (targetQuoteId) {
                    await qcagFetchTaskQuoteDetail(targetQuoteId);
                } else if (typeof _qcagDesktopCurrentId !== 'undefined' && _qcagDesktopCurrentId) {
                    const curReq = (typeof currentDetailRequest !== 'undefined' && currentDetailRequest) || 
                                   (typeof allRequests !== 'undefined' && allRequests.find(r => r.__backendId === _qcagDesktopCurrentId || r.id === _qcagDesktopCurrentId));
                    const fetchId = curReq && (curReq.quoteCode || curReq.quote_code || curReq.tkCode || curReq.tk_code || curReq.outletCode);
                    if (fetchId) {
                        await qcagFetchTaskQuoteDetail(fetchId);
                    }
                }
            }

            _debouncedFetchPendingOrders();
        } catch (_) {
            // Không làm gì nếu parse lỗi để chống bão request
        }
    };

    if (!_qcagTaskApp1Sse) {
        try {
            const app1Base = resolvePendingOrdersApiBase();
            const sseApp1Url = (app1Base ? app1Base.replace(/\/+$/, '') : 'https://qcag-backend-staging-493469512136.asia-southeast1.run.app') + '/events';
            _qcagTaskApp1Sse = new EventSource(sseApp1Url);
            _qcagTaskApp1Sse.addEventListener('invalidate', handleSseMessage);
            _qcagTaskApp1Sse.onmessage = handleSseMessage;
        } catch (_) {}
    }
}

function initDesktopTaskFlow() {
    fetchQcagPendingOrders();

    // Zero Polling: Rely on Realtime SSE, no wasteful setInterval 20s
    if (_qcagTaskFetchTimer) {
        clearInterval(_qcagTaskFetchTimer);
        _qcagTaskFetchTimer = null;
    }

    ensureDesktopTaskSSE();

    // Idle management: Disconnect SSE when tab is hidden > 60s, reconnect on tab restore
    if (typeof document !== 'undefined' && !window.__qcagTaskVisibilityBound) {
        window.__qcagTaskVisibilityBound = true;
        let idleTimer = null;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                idleTimer = setTimeout(() => {
                    closeDesktopTaskSSE();
                }, 60000);
            } else {
                const wasClosed = !_qcagTaskApp1Sse || _qcagTaskApp1Sse.readyState === 2;
                if (idleTimer) {
                    clearTimeout(idleTimer);
                    idleTimer = null;
                }
                // Nếu chỉ chuyển tab xem app khác chốc lát (<60s), SSE vẫn giữ kết nối realtime 100%,
                // tuyệt đối không fetch lại làm giật lag UI khi user vừa focus tab
                if (wasClosed) {
                    ensureDesktopTaskSSE();
                    fetchQcagPendingOrders();
                    _qcagPendingOrdersNeedRefreshOnVisible = false;
                } else if (_qcagPendingOrdersNeedRefreshOnVisible) {
                    // Nếu tab vừa mở lại và trước đó có event SSE bị hoãn khi tab đang ẩn:
                    _qcagPendingOrdersNeedRefreshOnVisible = false;
                    fetchQcagPendingOrders();
                }
            }
        });
    }

    // Click outside dropdown handler
    if (!_qcagTaskClickOutsideBound && typeof document !== 'undefined') {
        _qcagTaskClickOutsideBound = true;
        document.addEventListener('click', function(e) {
            const wrap = document.getElementById('qcagTaskDropdownWrap');
            const dd = document.getElementById('qcagTaskDropdown');
            if (dd && !dd.classList.contains('hidden')) {
                if (!wrap || !wrap.contains(e.target)) {
                    qcagDesktopCloseTaskDropdown();
                }
            }
        });
    }
}

function qcagDesktopToggleTaskDropdown(e) {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    const dd = document.getElementById('qcagTaskDropdown');
    if (!dd) return;
    if (dd.classList.contains('hidden')) {
        qcagDesktopOpenTaskDropdown();
    } else {
        qcagDesktopCloseTaskDropdown();
    }
}

function qcagDesktopOpenTaskDropdown() {
    const dd = document.getElementById('qcagTaskDropdown');
    if (!dd) return;

    dd.classList.remove('hidden');
    fetchQcagPendingOrders().then(() => {
        renderQcagTaskList();
    });
    renderQcagTaskList();
}

function qcagDesktopCloseTaskDropdown() {
    const dd = document.getElementById('qcagTaskDropdown');
    if (dd) dd.classList.add('hidden');
}

// Aliases for backwards compatibility
function qcagDesktopOpenTaskModal() { qcagDesktopOpenTaskDropdown(); }
function qcagDesktopCloseTaskModal() { qcagDesktopCloseTaskDropdown(); }

function generateDeterministicOrderCodes(orders) {
    if (!Array.isArray(orders) || orders.length === 0) return orders;
    const sorted = orders.slice().sort((a, b) => {
        const tA = new Date(a.createdAt || 0).getTime();
        const tB = new Date(b.createdAt || 0).getTime();
        return tA - tB;
    });
    const dayCounterMap = {};
    sorted.forEach(ord => {
        const d = ord.createdAt ? new Date(ord.createdAt) : new Date();
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dayKey = `${dd}${mm}`;
        dayCounterMap[dayKey] = (dayCounterMap[dayKey] || 0) + 1;
        const seq = String(dayCounterMap[dayKey]).padStart(2, '0');
        const computedCode = `DS${dayKey}${seq}`;
        const existingCode = String(ord.orderCode || ord.order_code || '').trim();
        const finalCode = (existingCode && existingCode.startsWith(`DS${dayKey}`)) ? existingCode : computedCode;
        ord.orderCode = finalCode;
        ord.order_code = finalCode;
    });
    return orders;
}

function qcagGetTaskOrderCode(order) {
    if (!order) return 'DS-';
    if (order.orderCode || order.order_code || order.code) {
        return String(order.orderCode || order.order_code || order.code).trim();
    }
    const d = order.createdAt ? new Date(order.createdAt) : new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `DS${dd}${mm}01`;
}

function renderQcagTaskList() {
    const tbody = document.getElementById('qcagTaskListTbody');
    const emptyEl = document.getElementById('qcagTaskListEmpty');
    const countEl = document.getElementById('qcagTaskTotalCount');
    if (!tbody) return;

    generateDeterministicOrderCodes(_qcagPendingOrders);

    const orders = Array.isArray(_qcagPendingOrders) ? _qcagPendingOrders : [];
    if (countEl) countEl.textContent = `${orders.length} đơn chờ`;

    if (orders.length === 0) {
        tbody.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');

    let html = '';
    orders.forEach((order, idx) => {
        const orderCode = qcagGetTaskOrderCode(order);
        let quotes = [];
        if (Array.isArray(order.quotes)) quotes = order.quotes;
        else if (typeof order.quotes === 'string') {
            try { quotes = JSON.parse(order.quotes); } catch (_) { quotes = []; }
        }

        const totalPoints = quotes.length || order.totalPoints || 0;
        const createdDate = order.createdAt ? new Date(order.createdAt).toLocaleString('vi-VN') : '-';
        
        let uniqueAreas = [...new Set(quotes.map(q => q.area || q.khu_vuc || q.region).filter(Boolean))];
        if (uniqueAreas.length === 0 && order.areaList) uniqueAreas = [order.areaList];
        if (uniqueAreas.length === 0 && order.area_list) uniqueAreas = [order.area_list];
        const areasText = uniqueAreas.length > 0 ? uniqueAreas.join(', ') : '-';
        const createdBy = order.createdBy || order.created_by || 'Người tạo';

        let orderEditCount = 0;
        let orderRejCount = 0;
        quotes.forEach(q => {
            const st = String(q.productionApprovalStatus || q.status || '').toLowerCase();
            if (st === 'rejected') orderRejCount++;
            else if (st === 'pending-edit' || st === 'edit_requested' || st.includes('sửa')) orderEditCount++;
        });

        const hasIssue = (orderEditCount > 0 || orderRejCount > 0);
        let isCompleted = (order.status === 'completed' || order.task_status === 'completed' || !!order.is_completed || qcagIsTaskOrderCompleted(order.id) || qcagIsTaskOrderCompleted(orderCode));
        if (hasIssue) {
            isCompleted = false; // Thu hồi trạng thái đã xong nếu có điểm bị yêu cầu sửa hoặc từ chối
        }

        const isCurrentActive = _qcagCurrentTaskOrder && _qcagCurrentTaskOrder.id === order.id && !isCompleted;

        let rowClass = 'qcag-task-row border-b border-gray-800/80 transition-colors text-xs ';
        if (hasIssue) {
            rowClass += 'qcag-task-row-issue bg-amber-500/[0.08] hover:bg-amber-500/[0.14] border-amber-500/30 text-amber-100';
        } else if (isCompleted) {
            rowClass += 'qcag-task-row-completed bg-emerald-500/[0.08] hover:bg-emerald-500/[0.14] border-emerald-500/30 text-emerald-100';
        } else if (isCurrentActive) {
            rowClass += 'qcag-task-row-active bg-orange-500/10 hover:bg-orange-500/20';
        } else {
            rowClass += 'hover:bg-[#1a253a]';
        }

        let pointsBadgeHtml = '';
        if (hasIssue) {
            pointsBadgeHtml = `
                <span class="qcag-task-points-badge is-issue inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-400 font-bold text-xs" title="${orderRejCount} từ chối, ${orderEditCount} chờ sửa">
                    <svg class="w-3 h-3 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                    <span>${totalPoints} điểm (Lỗi: ${orderEditCount + orderRejCount})</span>
                </span>
            `;
        } else if (isCompleted) {
            pointsBadgeHtml = `
                <span class="qcag-task-points-badge is-done inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 font-bold text-xs">
                    <svg class="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
                    <span>${totalPoints} điểm</span>
                </span>
            `;
        } else {
            pointsBadgeHtml = `
                <span class="qcag-task-points-badge is-normal inline-flex items-center px-2 py-0.5 rounded-md bg-blue-500/10 border border-blue-500/25 text-blue-300 font-semibold text-xs">
                    ${totalPoints} điểm
                </span>
            `;
        }

        let actionBtnHtml = '';
        if (hasIssue) {
            actionBtnHtml = `
                <button onclick="qcagDesktopStartTaskMode('${order.id}')" class="qcag-task-btn is-edit inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-300 text-xs font-bold transition-all active:scale-95 shadow-sm" title="Có điểm bị Sale từ chối hoặc yêu cầu sửa Maquette. Bấm để sửa lại">
                    <svg class="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                    <span>Cần sửa (${orderEditCount + orderRejCount})</span>
                </button>
            `;
        } else if (isCompleted) {
            actionBtnHtml = `
                <button onclick="qcagDesktopStartTaskMode('${order.id}')" class="qcag-task-btn is-done inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 text-xs font-bold transition-all active:scale-95 shadow-sm" title="Nhiệm vụ đã hoàn tất. Bấm để xem lại">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
                    <span>Đã xong</span>
                </button>
            `;
        } else if (isCurrentActive) {
            actionBtnHtml = `
                <button onclick="qcagDesktopStartTaskMode('${order.id}')" class="qcag-task-btn is-active inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-orange-500 text-white font-bold text-xs transition-all active:scale-95 shadow-sm">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                    <span>Đang làm</span>
                </button>
            `;
        } else {
            actionBtnHtml = `
                <button onclick="qcagDesktopStartTaskMode('${order.id}')" class="qcag-task-btn is-work inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/40 text-orange-300 text-xs font-semibold transition-all active:scale-95 shadow-sm">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                    <span>Làm việc</span>
                </button>
            `;
        }

        html += `
            <tr class="${rowClass}">
                <td class="qcag-task-cell-stt px-3.5 py-3 text-gray-400 text-center w-10">${idx + 1}</td>
                <td class="qcag-task-cell-code px-3.5 py-3 whitespace-nowrap font-medium text-cyan-400" title="Mã gói nhiệm vụ">${escapeHtml(orderCode)}</td>
                <td class="qcag-task-cell-points px-3.5 py-3 whitespace-nowrap">
                    ${pointsBadgeHtml}
                </td>
                <td class="qcag-task-cell-area px-3.5 py-3 text-gray-200 font-medium truncate max-w-[180px]" title="${escapeHtml(areasText)}">${escapeHtml(areasText)}</td>
                <td class="qcag-task-cell-creator px-3.5 py-3 text-gray-300 font-medium truncate max-w-[160px]" title="${escapeHtml(createdBy)}">${escapeHtml(createdBy)}</td>
                <td class="qcag-task-cell-date px-3.5 py-3 text-gray-400 font-mono text-[11px] whitespace-nowrap">${escapeHtml(createdDate)}</td>
                <td class="qcag-task-cell-action px-3.5 py-3 text-center whitespace-nowrap w-32">
                    ${actionBtnHtml}
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

/** Extract matching or synthesized requests for an Order */
function qcagGetTaskOrderRequests(order) {
    if (!order) return [];
    let quotes = [];
    if (Array.isArray(order.quotes)) quotes = order.quotes;
    else if (typeof order.quotes === 'string') {
        try { quotes = JSON.parse(order.quotes); } catch (_) { quotes = []; }
    }
    if (quotes.length === 0) return [];

    const all = (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) ? allRequests : [];
    const result = [];
    const usedMatchedIds = new Set();
    const usedTkCodes = new Set();

    quotes.forEach((rawQ, idx) => {
        let q = rawQ;
        if (typeof q === 'string') {
            q = { quote_code: q.trim(), quoteCode: q.trim() };
        }
        if (!q || typeof q !== 'object') return;

        // Nếu quote thiếu thông tin nhưng có cache quotations, làm giàu ngay tại chỗ
        if (typeof window !== 'undefined' && Array.isArray(window.__qcagQuoteListCache)) {
            const rawQCode = String(q.quote_code || q.quoteCode || '').trim().toLowerCase();
            if (rawQCode) {
                const cachedQ = window.__qcagQuoteListCache.find(c => String(c.quote_code || c.quoteCode || c.code || '').trim().toLowerCase() === rawQCode);
                if (cachedQ) {
                    q = { ...cachedQ, ...q };
                }
            }
        }

        const qCodeNorm = String(q.quote_code || q.quoteCode || '').trim().toLowerCase();
        const tkCodeNorm = String(q.tk_code || q.tkCode || q.request_tk_code || '').trim().toLowerCase();
        const outletCodeNorm = String(q.outlet_code || q.outletCode || '').trim().toLowerCase();
        const backendIdNorm = String(q.__backendId || q.id || '').trim().toLowerCase();

        // 0. Kiểm tra nếu điểm này ĐÃ CÓ trong result (chống nhân đôi thẻ cùng 1 điểm/thiết kế)
        let existing = null;
        if (tkCodeNorm) {
            existing = result.find(r => String(r.tkCode || r.tk_code || '').trim().toLowerCase() === tkCodeNorm);
        }
        if (!existing && qCodeNorm) {
            existing = result.find(r => String(r.quoteCode || r.quote_code || '').trim().toLowerCase() === qCodeNorm);
        }
        if (!existing && backendIdNorm) {
            existing = result.find(r => String(r.__backendId || r.id || '').trim().toLowerCase() === backendIdNorm);
        }

        let qRejectReason = q.rejectReason || q.production_reject_reason || null;
        let qStatus = String(q.productionApprovalStatus || q.production_approval_status || q.approval_status || q.status || '').toLowerCase().trim();
        if (typeof window !== 'undefined' && window._qcagProductionApprovalStatusMap) {
            const map = window._qcagProductionApprovalStatusMap;
            const cleanCode = (qCodeNorm || '').replace(/^bg[-_]?/i, '');
            const appr = (map.get(cleanCode) || map.get(qCodeNorm) || map.get(tkCodeNorm) || map.get(outletCodeNorm));
            if (appr && appr.status) {
                qStatus = String(appr.status).toLowerCase().trim();
                if (appr.reason && !qRejectReason) qRejectReason = appr.reason;
            }
        }
        if (qStatus === 'done' || qStatus === 'hoàn thành' || qStatus === 'processed' || qStatus === 'da_duyet') {
            qStatus = 'approved';
        } else if (!qStatus) {
            qStatus = 'pending';
        }
        const rawQuoteItems = Array.isArray(q.items) ? q.items : (Array.isArray(q.quote_items) ? q.quote_items : (typeof q.items === 'string' ? (() => { try { return JSON.parse(q.items); } catch(_) { return []; } })() : []));

        if (existing) {
            // Thẻ điểm này đã tồn tại trong danh sách nhiệm vụ -> Cập nhật thông tin nếu cần, tuyệt đối không tạo thêm thẻ trùng
            if (!existing.quoteCode && qCodeNorm) existing.quoteCode = q.quote_code || q.quoteCode;
            if (rawQuoteItems.length > 0 && (!existing.quote_items || existing.quote_items.length === 0)) {
                existing.quote_items = rawQuoteItems;
            }
            if (qStatus) {
                existing.productionApprovalStatus = qStatus;
                if (qRejectReason) existing.rejectReason = qRejectReason;
                if (qStatus === 'pending-edit' || qStatus === 'edit_requested' || qStatus === 'rejected') {
                    existing.hasEditRequest = true;
                    existing.isPendingEdit = true;
                    if (qRejectReason) existing.editReason = qRejectReason;
                    if (!existing.editingRequestedAt) existing.editingRequestedAt = new Date().toISOString();
                }
            }
            return;
        }

        // 1. Ưu tiên cao nhất: Tìm theo tk_code (Sợi chỉ đỏ xuyên suốt hệ thống)
        let matched = null;
        if (tkCodeNorm) {
            matched = all.find(r => {
                if (!r) return false;
                const rTk = String(r.tkCode || r.tk_code || '').trim().toLowerCase();
                return rTk && rTk === tkCodeNorm;
            });
        }

        // 2. Ưu tiên 2: Tìm theo quote_code
        if (!matched && qCodeNorm) {
            matched = all.find(r => {
                if (!r) return false;
                const rQ = String(r.quoteCode || r.quote_code || r.code || '').trim().toLowerCase();
                return rQ && rQ === qCodeNorm;
            });
        }

        // 3. Ưu tiên 3: Tìm theo backendId / id
        if (!matched && backendIdNorm) {
            matched = all.find(r => {
                if (!r) return false;
                const rBackend = String(r.__backendId || r.id || '').trim().toLowerCase();
                return rBackend && rBackend === backendIdNorm;
            });
        }

        // 4. Ưu tiên 4: Tìm theo outletCode (chỉ khi chưa tìm thấy và outletCode hợp lệ)
        if (!matched && outletCodeNorm && outletCodeNorm !== 'chưa có code' && outletCodeNorm !== 'new outlet') {
            matched = all.find(r => {
                if (!r) return false;
                const rOutlet = String(r.outletCode || r.outlet_code || '').trim().toLowerCase();
                return rOutlet && rOutlet === outletCodeNorm;
            });
        }

        if (matched) {
            const rId = String(matched.__backendId || matched.id || matched.tkCode || '');
            // Nếu request khảo sát này đã được gắn vào một quote trước đó trong cùng đơn hàng
            if (usedMatchedIds.has(rId)) {
                const existingPoint = result.find(r => String(r.__backendId || r.id || r.tkCode || '') === rId);
                if (existingPoint) {
                    if (!existingPoint.quoteCode && qCodeNorm) existingPoint.quoteCode = q.quote_code || q.quoteCode;
                    if (rawQuoteItems.length > 0 && (!existingPoint.quote_items || existingPoint.quote_items.length === 0)) {
                        existingPoint.quote_items = rawQuoteItems;
                    }
                    if (qStatus) {
                        existingPoint.productionApprovalStatus = qStatus;
                        if (qRejectReason) existingPoint.rejectReason = qRejectReason;
                        if (qStatus === 'pending-edit' || qStatus === 'edit_requested' || qStatus === 'rejected') {
                            existingPoint.hasEditRequest = true;
                            existingPoint.isPendingEdit = true;
                            if (qRejectReason) existingPoint.editReason = qRejectReason;
                            if (!existingPoint.editingRequestedAt) existingPoint.editingRequestedAt = new Date().toISOString();
                        }
                    }
                }
                return;
            }

            if (rId) usedMatchedIds.add(rId);
            if (tkCodeNorm) usedTkCodes.add(tkCodeNorm);

            const isPointEdit = (qStatus === 'pending-edit' || qStatus === 'edit_requested' || qStatus === 'rejected');
            let matchedComments = Array.isArray(matched.comments) ? matched.comments.slice() : (typeof matched.comments === 'string' ? (() => { try { return JSON.parse(matched.comments); } catch(_) { return []; } })() : []);
            if (isPointEdit && qRejectReason) {
                const hasComment = matchedComments.some(c => (c.text && c.text.includes(qRejectReason)) || c.commentType === 'edit-request');
                if (!hasComment) {
                    matchedComments.push({
                        authorRole: 'sale',
                        authorName: q.sale_name || q.saleName || 'Sale Heineken',
                        commentType: 'edit-request',
                        text: qRejectReason,
                        createdAt: matched.editingRequestedAt || new Date().toISOString()
                    });
                }
            }

            // Clone và bổ sung thuộc tính quote - CHỈ PUSH ĐÚNG 1 LẦN
            const combined = {
                ...matched,
                __taskQuoteIdx: idx,
                status: isPointEdit ? 'pending' : (order.isProductionOrder ? 'done' : (matched.status || 'approved')),
                quoteCode: q.quote_code || q.quoteCode || matched.quoteCode || '',
                tkCode: q.tk_code || q.tkCode || matched.tkCode || '',
                outletName: matched.outletName || q.outlet_name || q.outletName || 'Outlet',
                outletCode: matched.outletCode || q.outlet_code || q.outletCode || '',
                productionApprovalStatus: qStatus,
                rejectReason: qRejectReason,
                hasEditRequest: isPointEdit || Boolean(matched.hasEditRequest),
                isPendingEdit: isPointEdit || Boolean(matched.isPendingEdit),
                editReason: qRejectReason || matched.editReason || null,
                editingRequestedAt: isPointEdit ? (matched.editingRequestedAt || new Date().toISOString()) : matched.editingRequestedAt,
                comments: JSON.stringify(matchedComments),
                quote_items: rawQuoteItems.length > 0 ? rawQuoteItems : (matched.quote_items || [])
            };
            result.push(combined);
        } else {
            // NẾU KHÔNG CÓ REQUEST GỐC: TẠO SYNTHETIC REQUEST TỪ BÁO GIÁ
            // Kiểm tra xem đã có thẻ của outletCode này trong result chưa (tránh synthetic trùng)
            if (outletCodeNorm && outletCodeNorm !== 'chưa có code' && outletCodeNorm !== 'new outlet') {
                const existingByOutlet = result.find(r => String(r.outletCode || '').trim().toLowerCase() === outletCodeNorm);
                if (existingByOutlet) {
                    if (!existingByOutlet.quoteCode && qCodeNorm) existingByOutlet.quoteCode = q.quote_code || q.quoteCode;
                    if (rawQuoteItems.length > 0 && (!existingByOutlet.quote_items || existingByOutlet.quote_items.length === 0)) {
                        existingByOutlet.quote_items = rawQuoteItems;
                    }
                    return;
                }
            }
            const synthId = String(q.__backendId || q.id || `task-quote-${q.quote_code || q.tk_code || idx}`);
            const imagesArr = Array.isArray(q.images) ? q.images : (Array.isArray(q.designImages) ? q.designImages : (Array.isArray(q.design_images) ? q.design_images : []));
            const normalizedItems = rawQuoteItems.map(it => ({
                type: it.type || it.product_name || it.item_type || it.content || 'Bảng hiệu',
                product_name: it.product_name || it.type || '',
                brand: it.brand || '-',
                width: it.width || it.w || '-',
                height: it.height || it.h || '-',
                quantity: it.quantity || it.qty || 1,
                poles: it.poles || 0,
                note: it.note || it.content || '',
                action: it.action || 'Sản xuất mới',
                survey: false
            }));

            // Tìm tên outlet nếu quote bị thiếu tên
            let fallbackOutletName = q.outlet_name || q.outletName || q.shop_name || q.shopName || '';
            let fallbackAddress = q.address || q.outlet_address || q.outletAddress || '';
            if (!fallbackOutletName && outletCodeNorm) {
                const anyReq = all.find(r => String(r.outletCode || r.outlet_code || '').trim().toLowerCase() === outletCodeNorm);
                if (anyReq) {
                    fallbackOutletName = anyReq.outletName || anyReq.outlet_name || '';
                    if (!fallbackAddress) fallbackAddress = anyReq.address || '';
                }
            }
            if (!fallbackOutletName) fallbackOutletName = q.outlet_code || 'Outlet';

            const isSynthEdit = (qStatus === 'pending-edit' || qStatus === 'edit_requested' || qStatus === 'rejected');
            let synthComments = typeof q.comments === 'string' ? (() => { try { return JSON.parse(q.comments); } catch(_) { return []; } })() : (Array.isArray(q.comments) ? q.comments.slice() : []);
            if (isSynthEdit && qRejectReason && !synthComments.some(c => c.commentType === 'edit-request')) {
                synthComments.push({
                    authorRole: 'sale',
                    authorName: q.sale_name || q.saleName || 'Sale Heineken',
                    commentType: 'edit-request',
                    text: qRejectReason,
                    createdAt: q.createdAt || order.createdAt || new Date().toISOString()
                });
            }

            const synthReq = {
                __backendId: synthId,
                id: synthId,
                _isSynthetic: true,
                isTaskMode: true,
                tkCode: q.tk_code || q.tkCode || q.request_tk_code || (q.quote_code ? ('BG-' + q.quote_code) : (q.quoteCode ? ('BG-' + q.quoteCode) : 'TK-NEW')),
                quoteCode: q.quote_code || q.quoteCode || '',
                outletName: q.outlet_name || q.outletName || fallbackOutletName || 'Outlet',
                outletCode: q.outlet_code || q.outletCode || '',
                phone: q.phone || q.outlet_phone || '',
                address: q.address || fallbackAddress || '',
                outletLat: q.lat || q.outlet_lat || q.outletLat || q.latitude || null,
                outletLng: q.lng || q.outlet_lng || q.outletLng || q.longitude || null,
                type: 'new',
                status: isSynthEdit ? 'pending' : (order.isProductionOrder ? 'done' : qStatus),
                productionApprovalStatus: qStatus,
                rejectReason: qRejectReason,
                hasEditRequest: isSynthEdit,
                isPendingEdit: isSynthEdit,
                editReason: qRejectReason,
                editingRequestedAt: isSynthEdit ? new Date().toISOString() : null,
                requester: JSON.stringify({
                    saleName: q.sale_name || q.saleName || '',
                    phone: q.phone || q.sale_phone || q.salePhone || '',
                    region: q.area || q.region || order.areaList || order.area || '',
                    ssName: q.ss_name || q.ssName || ''
                }),
                items: JSON.stringify(normalizedItems),
                quote_items: rawQuoteItems,
                designImages: imagesArr.length > 0 ? JSON.stringify(imagesArr) : (typeof q.design_images === 'string' ? q.design_images : JSON.stringify(q.design_images || q.designImages || [])),
                statusImages: typeof q.statusImages === 'string' ? q.statusImages : JSON.stringify(q.statusImages || []),
                acceptanceImages: JSON.stringify([]),
                oldContentImages: JSON.stringify([]),
                comments: JSON.stringify(synthComments),
                createdAt: q.createdAt || order.createdAt || order.created_at || new Date().toISOString()
            };
            result.push(synthReq);
        }
    });

    return result;
}

/** Update the HUD Banner for Task Mode on Main Desktop */
function updateDesktopTaskBannerUI() {
    const banner = document.getElementById('qcagDesktopTaskBanner');
    const screenEl = document.getElementById('qcagDesktopScreen') || document.querySelector('.qcag-desktop-shell');
    const filterBar = document.querySelector('.qcag-detail-filter-bar');
    const statusTabs = document.querySelector('.qcag-status-tabs');
    const listToolbar = document.querySelector('.qcag-list-toolbar');
    const leftListHeader = document.getElementById('qcagTaskLeftListHeader');
    const leftListCount = document.getElementById('qcagTaskLeftListCount');
    const bannerBadgeText = document.querySelector('#qcagDesktopTaskBanner .qcag-task-banner-badge span');

    if (!_qcagCurrentTaskOrder) {
        if (banner) banner.classList.add('hidden');
        if (screenEl) screenEl.classList.remove('qcag-task-mode-active');
        if (document.body) document.body.classList.remove('qcag-task-mode-active');
        if (filterBar) { filterBar.classList.remove('hidden'); filterBar.style.display = ''; }
        if (statusTabs) { statusTabs.classList.remove('hidden'); statusTabs.style.display = ''; }
        if (listToolbar) { listToolbar.classList.remove('hidden'); listToolbar.style.display = ''; }
        if (leftListHeader) leftListHeader.classList.add('hidden');
        return;
    }

    if (banner) banner.classList.remove('hidden');
    if (screenEl) screenEl.classList.add('qcag-task-mode-active');
    if (document.body) document.body.classList.add('qcag-task-mode-active');
    if (filterBar) { filterBar.classList.add('hidden'); filterBar.style.display = 'none'; }
    if (statusTabs) { statusTabs.classList.add('hidden'); statusTabs.style.display = 'none'; }
    if (listToolbar) { listToolbar.classList.add('hidden'); listToolbar.style.display = 'none'; }
    if (leftListHeader) leftListHeader.classList.remove('hidden');

    const reqs = qcagGetTaskOrderRequests(_qcagCurrentTaskOrder);
    const total = reqs.length;
    
    if (leftListCount) leftListCount.textContent = `${total} điểm`;

    let quotes = [];
    if (Array.isArray(_qcagCurrentTaskOrder.quotes)) quotes = _qcagCurrentTaskOrder.quotes;
    else if (typeof _qcagCurrentTaskOrder.quotes === 'string') {
        try { quotes = JSON.parse(_qcagCurrentTaskOrder.quotes); } catch (_) { quotes = []; }
    }

    let uniqueAreas = [...new Set(quotes.map(q => q.area || q.khu_vuc || q.region).filter(Boolean))];
    if (uniqueAreas.length === 0 && _qcagCurrentTaskOrder.areaList) uniqueAreas = [_qcagCurrentTaskOrder.areaList];
    if (uniqueAreas.length === 0 && _qcagCurrentTaskOrder.area) uniqueAreas = [_qcagCurrentTaskOrder.area];
    const areasText = uniqueAreas.length > 0 ? uniqueAreas.join(', ') : '-';
    const createdBy = _qcagCurrentTaskOrder.createdBy || _qcagCurrentTaskOrder.created_by || _qcagCurrentTaskOrder.created_by_name || 'Người tạo';
    const createdDate = (_qcagCurrentTaskOrder.createdAt || _qcagCurrentTaskOrder.created_at) ? new Date(_qcagCurrentTaskOrder.createdAt || _qcagCurrentTaskOrder.created_at).toLocaleTimeString('vi-VN') : '';

    const orderCode = qcagGetTaskOrderCode(_qcagCurrentTaskOrder);
    const titleEl = document.getElementById('qcagTaskBannerTitle');
    const metaEl = document.getElementById('qcagTaskBannerMeta');
    const progressEl = document.getElementById('qcagTaskBannerProgress');
    const confirmBtn = document.getElementById('qcagTaskConfirmBtn');
    const confirmBtnText = document.getElementById('qcagTaskConfirmBtnText');

    // If active order is a Production Order
    if (_qcagCurrentTaskOrder.isProductionOrder) {
        if (bannerBadgeText) bannerBadgeText.textContent = 'ĐƠN HÀNG SẢN XUẤT';
        if (titleEl) titleEl.innerHTML = `<span class="font-bold text-cyan-400 mr-1.5">${escapeHtml(orderCode)}</span>Số lượng: ${total} điểm`;
        const unit = _qcagCurrentTaskOrder.unit || _qcagCurrentTaskOrder.construction_unit || 'QCAG';
        const due = qcagOrdersFormatDate(_qcagCurrentTaskOrder.due_date);
        if (metaEl) metaEl.textContent = `Thi công: ${unit} | Hạn: ${due} | Khu vực: ${areasText}`;
        if (confirmBtn) confirmBtn.classList.add('hidden');
        if (progressEl) {
            progressEl.classList.remove('hidden');
            progressEl.className = 'qcag-task-banner-progress progress';
            progressEl.style.cssText = 'background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.4);color:#34d399;font-weight:bold;';
            progressEl.textContent = `✓ Đã hoàn tất thiết kế (${total}/${total} điểm)`;
        }
        return;
    }

    // Default Pending Order (Nhiệm vụ)
    if (bannerBadgeText) bannerBadgeText.textContent = 'NHIỆM VỤ ĐƠN HÀNG';
    const completedCount = reqs.filter(r => {
        try {
            const chk = qcagComputeTaskItemChecklist(r);
            return !!(chk && chk.isComplete);
        } catch (_) { return false; }
    }).length;

    if (titleEl) titleEl.innerHTML = `<span class="font-bold text-cyan-400 mr-1.5">${escapeHtml(orderCode)}</span>Số lượng: ${total} điểm`;
    if (metaEl) metaEl.textContent = `Khu vực: ${areasText} | Tạo bởi: ${createdBy}${createdDate ? ` (${createdDate})` : ''}`;

    const isAllCompleted = total > 0 && completedCount === total;

    if (isAllCompleted) {
        if (progressEl) progressEl.classList.add('hidden');
        if (confirmBtn) {
            confirmBtn.classList.remove('hidden');
            if (confirmBtnText) confirmBtnText.textContent = `Tổng duyệt in (${completedCount}/${total})`;
        }
    } else {
        if (confirmBtn) confirmBtn.classList.add('hidden');
        if (progressEl) {
            progressEl.classList.remove('hidden');
            progressEl.className = 'qcag-task-banner-progress';
            progressEl.style.cssText = '';
            if (completedCount > 0) {
                progressEl.classList.add('progress');
                progressEl.textContent = `Đang xử lý: ${completedCount}/${total} điểm`;
            } else {
                progressEl.classList.add('pending');
                progressEl.textContent = `Đang xử lý: 0/${total} điểm`;
            }
        }
    }
}

/** Switch into Task Mode on the Main Desktop UI */
function qcagDesktopStartTaskMode(orderId) {
    const order = _qcagPendingOrders.find(o => o.id === orderId);
    if (!order) return;

    _qcagCurrentTaskOrder = order;
    if (typeof window !== 'undefined') window._qcagCurrentTaskOrder = order;

    qcagDesktopCloseTaskModal();
    updateDesktopTaskBannerUI();

    // Reset pagination to first page
    if (typeof _qcagDesktopListPage !== 'undefined') _qcagDesktopListPage = 0;

    // Fetch checklists from Database for this task order
    qcagFetchTaskOrderChecklists(orderId);

    // Ensure approvals map is populated from DB (đồng bộ tức thì với App 1)
    if (typeof qcagFetchProductionApprovalsFromDb === 'function') {
        qcagFetchProductionApprovalsFromDb().then(map => {
            if (map && _qcagCurrentTaskOrder && typeof renderQCAGDesktopList === 'function') {
                renderQCAGDesktopList(true);
            }
        });
    }

    // Re-render standard list immediately with forceRebuild and cleared fingerprint
    if (typeof _qcagDesktopLastRenderFingerprint !== 'undefined') {
        _qcagDesktopLastRenderFingerprint = '';
    }
    if (typeof renderQCAGDesktopList === 'function') {
        renderQCAGDesktopList(true);
    }

    // Auto-select request in task (Ưu tiên điểm đang có yêu cầu chỉnh sửa)
    const taskReqs = qcagGetTaskOrderRequests(order);
    if (taskReqs.length > 0 && typeof openQCAGDesktopRequest === 'function') {
        const editReq = taskReqs.find(r => {
            const appr = (typeof qcagGetSaleProductionApprovalStatus === 'function') ? qcagGetSaleProductionApprovalStatus(r) : null;
            return (appr && (appr.key === 'pending-edit' || appr.key === 'rejected')) ||
                   r.hasEditRequest ||
                   r.isPendingEdit ||
                   (typeof qcagDesktopIsPendingEditRequest === 'function' && qcagDesktopIsPendingEditRequest(r));
        });
        const targetReq = editReq || taskReqs[0];
        openQCAGDesktopRequest(targetReq.__backendId || targetReq.id);

        // Lazy Load: Chỉ nạp trước chi tiết Báo giá cho điểm đang active, các điểm khác nạp theo yêu cầu (Rule 9)
        if (typeof qcagFetchTaskQuoteDetail === 'function') {
            const firstFetchId = targetReq.quoteCode || targetReq.tkCode;
            if (firstFetchId) {
                qcagFetchTaskQuoteDetail(firstFetchId);
            }
        }
    }

    if (typeof showToast === 'function') {
        showToast(`✓ Đang làm việc trên gói đơn: ${taskReqs.length} điểm`);
    }
}

// Alias for compatibility
function qcagDesktopOpenTaskWorkspace(orderId) {
    qcagDesktopStartTaskMode(orderId);
}

/** Exit Task Mode and return to full request list or orders list */
function qcagDesktopExitTaskMode() {
    const wasProductionOrder = !!(_qcagCurrentTaskOrder && _qcagCurrentTaskOrder._isProductionOrder);
    _qcagCurrentTaskOrder = null;
    if (typeof window !== 'undefined') window._qcagCurrentTaskOrder = null;

    updateDesktopTaskBannerUI();

    if (wasProductionOrder) {
        if (typeof qcagNavShowView === 'function') {
            qcagNavShowView('orders');
        }
        if (typeof showToast === 'function') {
            showToast('Đã đóng đơn hàng và quay lại danh sách đơn hàng.');
        }
        return;
    }

    if (typeof _qcagDesktopListPage !== 'undefined') _qcagDesktopListPage = 0;

    if (typeof renderQCAGDesktopList === 'function') {
        renderQCAGDesktopList();
    }

    if (typeof getQCAGDesktopVisibleRequests === 'function' && typeof openQCAGDesktopRequest === 'function') {
        const visible = getQCAGDesktopVisibleRequests();
        if (visible.length > 0) {
            openQCAGDesktopRequest(visible[0].__backendId);
        }
    }

    if (typeof showToast === 'function') {
        showToast('Đã thoát nhiệm vụ. Đang hiển thị tất cả yêu cầu.');
    }
}

function qcagDesktopCloseTaskWorkspace() {
    qcagDesktopExitTaskMode();
}

// ── Task Mode Checklist Feature (Kiểm Soát File In Sản Xuất) ───────────────
// ── Task Mode Checklist Feature ─────────────────────────────────────────────
// The redundant 4-tile card was superseded by per-card inline verification
// (item size checkbox, content_verified, edit_history_reviewed).
function qcagBuildTaskChecklistCardHtml(req) {
    return '';
}

function qcagRenderTaskChecklistCard(reqId) {
    const container = document.getElementById('qcagTaskChecklistContainer');
    if (container) container.innerHTML = '';
}

// ── Pre-flight Task Checklist State Manager (Database V11 Sync) ─────
let _qcagDbChecklistsCache = {}; // orderId -> { [tkCode]: checklistRecord }

async function qcagFetchTaskOrderChecklists(orderId) {
    if (!orderId) return;
    try {
        const endpoints = [
            `/api/ks/pending-orders/${encodeURIComponent(orderId)}/checklists`,
            `/pending-orders/${encodeURIComponent(orderId)}/checklists`
        ];
        let fetchedData = null;
        for (const ep of endpoints) {
            try {
                const res = await fetch(ep).then(r => r.json());
                if (res && res.ok && res.data) {
                    fetchedData = res.data;
                    break;
                }
            } catch (_) {}
        }

        if (fetchedData) {
            _qcagDbChecklistsCache[orderId] = fetchedData;
            // Sync to local memory & localStorage as fallback cache
            const gridSaved = qcagGetTaskGridSaved(orderId);
            Object.keys(fetchedData).forEach(tk => {
                const itm = fetchedData[tk];
                if (itm && itm.checklistData) {
                    try { localStorage.setItem('qcag_task_chk_' + tk, JSON.stringify(itm.checklistData)); } catch (_) {}
                }
                if (itm && typeof itm.printReady === 'boolean') {
                    if (itm.printReady) gridSaved[tk] = true;
                    else delete gridSaved[tk];
                }
            });
            try { localStorage.setItem('qcag_grid_checked_' + orderId, JSON.stringify(gridSaved)); } catch (_) {}

            if (typeof renderQCAGDesktopList === 'function') renderQCAGDesktopList();
            if (typeof updateDesktopTaskBannerUI === 'function') updateDesktopTaskBannerUI();
        }
    } catch (err) {
        console.warn('[qcagFetchTaskOrderChecklists] warning:', err);
    }
}

function qcagGetTaskItemChecklistKey(req) {
    if (!req) return '';
    return String(req.__backendId || req.id || req.tkCode || req.outletCode || '').trim();
}

function qcagGetTaskChecklistSaved(req) {
    const key = qcagGetTaskItemChecklistKey(req);
    if (!key) return {};

    // 1. Check DB Cache first if in task mode
    if (_qcagCurrentTaskOrder && _qcagDbChecklistsCache[_qcagCurrentTaskOrder.id]) {
        const orderCache = _qcagDbChecklistsCache[_qcagCurrentTaskOrder.id];
        const tk = String(req.tkCode || req.tk_code || key).trim();
        if (orderCache[tk] && orderCache[tk].checklistData && Object.keys(orderCache[tk].checklistData).length > 0) {
            return orderCache[tk].checklistData;
        }
    }

    // 2. Fallback to localStorage
    try {
        const raw = localStorage.getItem('qcag_task_chk_' + key);
        return raw ? JSON.parse(raw) : {};
    } catch (_) {
        return {};
    }
}

function qcagSaveTaskChecklist(req, data) {
    const key = qcagGetTaskItemChecklistKey(req);
    if (!key) return;

    // 1. Save to local storage for zero latency
    try {
        localStorage.setItem('qcag_task_chk_' + key, JSON.stringify(data || {}));
    } catch (_) {}

    // 2. Update memory cache and send to Database
    if (_qcagCurrentTaskOrder) {
        const orderId = _qcagCurrentTaskOrder.id;
        if (!_qcagDbChecklistsCache[orderId]) _qcagDbChecklistsCache[orderId] = {};
        const tk = String(req.tkCode || req.tk_code || key).trim();
        const state = qcagComputeTaskItemChecklist(req);

        _qcagDbChecklistsCache[orderId][tk] = {
            ...(_qcagDbChecklistsCache[orderId][tk] || {}),
            pendingOrderId: orderId,
            tkCode: tk,
            sizeVerified: state.isComplete,
            contentVerified: state.isComplete,
            historyReviewed: state.isComplete,
            checklistData: data,
            verifiedBy: (typeof currentSession !== 'undefined' && currentSession && (currentSession.saleName || currentSession.name || currentSession.phone)) || 'QCAG'
        };

        // Async persist to Database
        const payload = {
            tkCode: tk,
            sizeVerified: state.isComplete,
            contentVerified: state.isComplete,
            historyReviewed: state.isComplete,
            printReady: !!(_qcagDbChecklistsCache[orderId][tk] && _qcagDbChecklistsCache[orderId][tk].printReady),
            checklistData: data,
            verifiedBy: (typeof currentSession !== 'undefined' && currentSession && (currentSession.saleName || currentSession.name || currentSession.phone)) || 'QCAG'
        };

        const endpoints = [
            `/api/ks/pending-orders/${encodeURIComponent(orderId)}/checklists`,
            `/pending-orders/${encodeURIComponent(orderId)}/checklists`
        ];
        endpoints.forEach(ep => {
            fetch(ep, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => {});
        });
    }
}

// Bộ nhớ đệm RAM lưu chi tiết Báo giá đầy đủ vật tư (Lazy Loading per-item)
const _qcagFullQuoteDetailCache = new Map();
const _qcagFetchingQuoteDetailSet = new Set();
const _qcagQuoteFetchHistoryMap = new Map();

async function qcagFetchTaskQuoteDetail(quoteIdentifier) {
    if (!quoteIdentifier) return null;
    const cleanKey = String(quoteIdentifier).trim().toLowerCase();
    if (_qcagFullQuoteDetailCache.has(cleanKey)) {
        return _qcagFullQuoteDetailCache.get(cleanKey);
    }
    const now = Date.now();
    const lastFetchAt = _qcagQuoteFetchHistoryMap.get(cleanKey) || 0;
    if (now - lastFetchAt < 8000) {
        return null; // Chốt chặn: Không bao giờ spam request lặp lại trong 8 giây (Rule 9)
    }
    if (_qcagFetchingQuoteDetailSet.has(cleanKey)) {
        return null; // Tránh gửi request trùng lặp song song
    }
    _qcagFetchingQuoteDetailSet.add(cleanKey);
    _qcagQuoteFetchHistoryMap.set(cleanKey, now);

    try {
        const app1Base = resolvePendingOrdersApiBase();
        const res = await fetch(`${app1Base}/quotations/${encodeURIComponent(quoteIdentifier)}`).catch(() => null);
        if (res && res.ok) {
            const q = await res.json().catch(() => null);
            if (q) {
                let items = q.items;
                if (typeof items === 'string') {
                    try { items = JSON.parse(items); } catch (_) { items = []; }
                }
                q.items = Array.isArray(items) ? items : [];
                q.quote_items = q.items;

                _qcagFullQuoteDetailCache.set(cleanKey, q);
                if (q.quote_code) _qcagFullQuoteDetailCache.set(String(q.quote_code).trim().toLowerCase(), q);
                if (q.tk_code) _qcagFullQuoteDetailCache.set(String(q.tk_code).trim().toLowerCase(), q);
                if (q.id) _qcagFullQuoteDetailCache.set(String(q.id).trim().toLowerCase(), q);

                // Đồng bộ tức thì items mới vào _qcagCurrentTaskOrder.quotes
                if (_qcagCurrentTaskOrder && Array.isArray(_qcagCurrentTaskOrder.quotes)) {
                    const matchInOrder = _qcagCurrentTaskOrder.quotes.find(oq => {
                        if (!oq) return false;
                        const oc = String(oq.quote_code || oq.quoteCode || '').trim().toLowerCase();
                        const otk = String(oq.tk_code || oq.tkCode || '').trim().toLowerCase();
                        return (q.quote_code && oc === String(q.quote_code).toLowerCase()) ||
                               (q.tk_code && otk === String(q.tk_code).toLowerCase());
                    });
                    if (matchInOrder) {
                        matchInOrder.items = q.items;
                        matchInOrder.quote_items = q.items;
                    }
                }

                // Xóa zombie cache quote_items trên request đang xem
                if (typeof currentDetailRequest !== 'undefined' && currentDetailRequest) {
                    delete currentDetailRequest.quote_items;
                }

                // Cập nhật IN-PLACE giao diện đối soát cho request đang mở mà KHÔNG trigger đệ quy openQCAGDesktopRequest
                if (typeof _qcagDesktopCurrentId !== 'undefined' && _qcagDesktopCurrentId) {
                    const itemsSec = document.getElementById('qcagItemsSection');
                    const summaryEl = document.querySelector('.qcag-task-point-summary');
                    const activeReq = (typeof currentDetailRequest !== 'undefined' && currentDetailRequest) || 
                                   (typeof allRequests !== 'undefined' && allRequests.find(r => r.__backendId === _qcagDesktopCurrentId || r.id === _qcagDesktopCurrentId));
                    if (activeReq) {
                        delete activeReq.quote_items;
                        if (itemsSec && typeof qcagDesktopBuildItemsHtml === 'function') {
                            const canManageItems = (typeof qcagDesktopCanEditItems === 'function') ? qcagDesktopCanEditItems(activeReq) : false;
                            const parsedItems = (typeof qcagDesktopParseJson === 'function') ? qcagDesktopParseJson(activeReq.items, []) : (Array.isArray(activeReq.items) ? activeReq.items : []);
                            itemsSec.innerHTML = qcagDesktopBuildItemsHtml(parsedItems, canManageItems, activeReq);
                        }
                        if (summaryEl && typeof qcagCheckPointQuoteMatch === 'function') {
                            const matchInfo = qcagCheckPointQuoteMatch(activeReq);
                            if (matchInfo && matchInfo.hasQuote) {
                                if (matchInfo.isAllMatched) {
                                    summaryEl.innerHTML = '<span style="color:#10b981;font-weight:600;font-size:12px;display:inline-flex;align-items:center;gap:4px;"><svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg> Toàn bộ hạng mục đã khớp Báo giá</span>';
                                } else {
                                    summaryEl.innerHTML = `<span style="color:#ef4444;font-weight:600;font-size:12px;display:inline-flex;align-items:center;gap:4px;">✕ Có ${matchInfo.diffCount} hạng mục chưa khớp Báo giá</span>`;
                                }
                            }
                        }
                    }
                }

                // Tự động cập nhật tức thì badge trên thẻ danh sách bên trái
                if (typeof qcagUpdateTaskCardChecklistBadge === 'function') {
                    if (q.quote_code) qcagUpdateTaskCardChecklistBadge(q.quote_code);
                    if (q.tk_code) qcagUpdateTaskCardChecklistBadge(q.tk_code);
                    qcagUpdateTaskCardChecklistBadge(cleanKey);
                }

                return q;
            }
        }
    } catch (e) {
        console.warn('[DesktopTask] qcagFetchTaskQuoteDetail error:', e);
    } finally {
        _qcagFetchingQuoteDetailSet.delete(cleanKey);
    }
    return null;
}
if (typeof window !== 'undefined') {
    window.qcagFetchTaskQuoteDetail = qcagFetchTaskQuoteDetail;
}

/** Tự động làm mới badge đối soát trên thẻ danh sách bên trái mà không cần re-render toàn bộ danh sách */
function qcagUpdateTaskCardChecklistBadge(identifier) {
    if (!identifier) return;
    const cleanId = String(identifier).trim().toLowerCase();

    // 1. Tìm request tương ứng từ allRequests hoặc từ gói nhiệm vụ hiện tại
    let targetReq = null;
    if (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) {
        targetReq = allRequests.find(r => {
            if (!r) return false;
            const bId = String(r.__backendId || '').trim().toLowerCase();
            const id = String(r.id || '').trim().toLowerCase();
            const tk = String(r.tkCode || r.tk_code || '').trim().toLowerCase();
            const qCode = String(r.quoteCode || r.quote_code || '').trim().toLowerCase();
            return bId === cleanId || id === cleanId || tk === cleanId || qCode === cleanId;
        });
    }
    if (!targetReq && typeof _qcagCurrentTaskOrder !== 'undefined' && _qcagCurrentTaskOrder) {
        const tReqs = typeof qcagGetTaskOrderRequests === 'function' ? qcagGetTaskOrderRequests(_qcagCurrentTaskOrder) : [];
        targetReq = tReqs.find(r => {
            if (!r) return false;
            const bId = String(r.__backendId || '').trim().toLowerCase();
            const id = String(r.id || '').trim().toLowerCase();
            const tk = String(r.tkCode || r.tk_code || '').trim().toLowerCase();
            const qCode = String(r.quoteCode || r.quote_code || '').trim().toLowerCase();
            return bId === cleanId || id === cleanId || tk === cleanId || qCode === cleanId;
        });
    }
    if (!targetReq) return;

    // 2. Tìm phần tử thẻ trong DOM theo attribute data-req-id
    const candidates = [targetReq.__backendId, targetReq.id, targetReq.tkCode].filter(Boolean);
    let cardEl = null;
    for (const c of candidates) {
        cardEl = document.querySelector(`.qcag-request-item[data-req-id="${c}"]`);
        if (cardEl) break;
    }
    if (!cardEl) return;

    // 3. Cập nhật viền thẻ: Đã kiểm tra (viền xanh lá) vs Chưa kiểm tra (viền thường)
    const isVerified = typeof qcagIsTaskPointVerified === 'function' ? qcagIsTaskPointVerified(targetReq) : false;
    if (isVerified) {
        cardEl.classList.add('is-task-complete', 'qcag-task-card-done');
    } else {
        cardEl.classList.remove('is-task-complete', 'qcag-task-card-done');
    }

    // 4. Cập nhật badge duy nhất trên thẻ: Trạng thái phê duyệt từ Sale (Chờ Sale / Yêu cầu sửa / Từ chối / Đã duyệt)
    const saleAppr = (typeof qcagGetSaleProductionApprovalStatus === 'function') 
        ? qcagGetSaleProductionApprovalStatus(targetReq) 
        : { key: 'pending', label: 'Chờ Sale', cls: 'status-pending' };
    const newBadgeHtml = `<span class="qcag-status-badge qcag-sale-appr-badge ${saleAppr.cls}" style="font-size:10px;padding:2px 8px;">${escapeHtml(saleAppr.label)}</span>`;

    const currentBadge = cardEl.querySelector('.qcag-status-badge, .qcag-checklist-badge');
    if (currentBadge) {
        currentBadge.outerHTML = newBadgeHtml;
    }
}
if (typeof window !== 'undefined') {
    window.qcagUpdateTaskCardChecklistBadge = qcagUpdateTaskCardChecklistBadge;
}

function qcagGetTaskQuoteForRequest(req) {
    if (!req) return null;
    let quote = null;

    const rTk = String(req.tkCode || req.tk_code || '').trim().toLowerCase();
    const rQ = String(req.quoteCode || req.quote_code || req.code || '').trim().toLowerCase();
    const rOutlet = String(req.outletCode || req.outlet_code || '').trim().toLowerCase();
    const rBackend = String(req.__backendId || req.id || '').trim().toLowerCase();

    // 1. Ưu tiên tra cứu từ RAM cache chi tiết đầy đủ (Lazy Loaded)
    if (rQ && _qcagFullQuoteDetailCache.has(rQ)) return _qcagFullQuoteDetailCache.get(rQ);
    if (rTk && _qcagFullQuoteDetailCache.has(rTk)) return _qcagFullQuoteDetailCache.get(rTk);
    if (rBackend && _qcagFullQuoteDetailCache.has(rBackend)) return _qcagFullQuoteDetailCache.get(rBackend);

    // 2. Tra cứu từ quotes trong gói đơn nhiệm vụ hiện tại
    if (_qcagCurrentTaskOrder) {
        let quotes = [];
        if (Array.isArray(_qcagCurrentTaskOrder.quotes)) quotes = _qcagCurrentTaskOrder.quotes;
        else if (typeof _qcagCurrentTaskOrder.quotes === 'string') {
            try { quotes = JSON.parse(_qcagCurrentTaskOrder.quotes); } catch (_) { quotes = []; }
        }

        quote = quotes.find(q => {
            if (!q) return false;
            const qCode = String(q.quote_code || q.quoteCode || '').trim().toLowerCase();
            const qTk = String(q.tk_code || q.tkCode || '').trim().toLowerCase();
            const qOutlet = String(q.outlet_code || q.outletCode || '').trim().toLowerCase();
            const qBackend = String(q.__backendId || q.id || '').trim().toLowerCase();

            if (rBackend && qBackend && rBackend === qBackend) return true;
            if (rTk && qTk && rTk === qTk) return true;
            if (rQ && qCode && rQ === qCode) return true;
            if (rTk && qCode && rTk === qCode) return true;
            if (rQ && qTk && rQ === qTk) return true;
            if (rOutlet && qOutlet && rOutlet === qOutlet) return true;
            return false;
        });

        if (quote) {
            const qCode = String(quote.quote_code || quote.quoteCode || '').trim().toLowerCase();
            const qTk = String(quote.tk_code || quote.tkCode || '').trim().toLowerCase();
            const qId = String(quote.id || '').trim().toLowerCase();
            if (qCode && _qcagFullQuoteDetailCache.has(qCode)) return _qcagFullQuoteDetailCache.get(qCode);
            if (qTk && _qcagFullQuoteDetailCache.has(qTk)) return _qcagFullQuoteDetailCache.get(qTk);
            if (qId && _qcagFullQuoteDetailCache.has(qId)) return _qcagFullQuoteDetailCache.get(qId);
        }
    }

    // 3. Tra cứu từ global cache
    if (!quote) {
        const globalQuotes = Array.isArray(window.__qcagQuoteListCache) ? window.__qcagQuoteListCache : [];
        if (globalQuotes.length > 0) {
            quote = globalQuotes.find(g => {
                const gCode = String(g.quote_code || g.quoteCode || '').trim().toLowerCase();
                const gOutlet = String(g.outlet_code || g.outletCode || '').trim().toLowerCase();
                if (rQ && gCode && rQ === gCode) return true;
                if (rTk && gCode && rTk === gCode) return true;
                if (rOutlet && gOutlet && rOutlet === gOutlet) return true;
                return false;
            });
        }
    }

    // Nếu tìm thấy quote nhưng chưa có items, kích hoạt nạp ngầm chi tiết báo giá thật
    if (quote) {
        let qItems = quote.items || quote.quote_items;
        if (typeof qItems === 'string') {
            try { qItems = JSON.parse(qItems); } catch (_) { qItems = []; }
        }
    }

    return quote;
}
if (typeof window !== 'undefined') {
    window.qcagGetTaskQuoteForRequest = qcagGetTaskQuoteForRequest;
    window.qcagFindMatchingQuoteForRequest = qcagGetTaskQuoteForRequest;
}

function qcagCheckPointQuoteMatch(req) {
    if (!req) return { hasQuote: false, isAllMatched: false, diffCount: 0, isPendingDetail: false };
    let quoteItems = [];
    let foundQuote = null;

    // Luôn ưu tiên tra cứu Báo giá mới nhất từ RAM cache hoặc nguồn đồng bộ (Zero Zombie Cache)
    const q = (typeof qcagGetTaskQuoteForRequest === 'function') 
        ? qcagGetTaskQuoteForRequest(req) 
        : ((typeof qcagFindMatchingQuoteForRequest === 'function') ? qcagFindMatchingQuoteForRequest(req) : null);
    if (q) {
        foundQuote = q;
        quoteItems = Array.isArray(q.quote_items) && q.quote_items.length > 0 
            ? q.quote_items 
            : (Array.isArray(q.items) ? q.items : []);
    }

    // Nếu không tìm thấy bất kỳ Báo giá nào trong hệ thống
    if (!foundQuote) {
        return { hasQuote: false, isAllMatched: false, diffCount: 0, isPendingDetail: false };
    }

    // BÁO GIÁ ĐÃ CÓ: Nhưng items đang rỗng do API danh sách chỉ trả tóm tắt (Rule 9)
    if (quoteItems.length === 0) {
        // Chỉ kích hoạt nạp ngầm nếu đây là điểm đang được người dùng mở chi tiết trên màn hình
        const reqBackendId = req.__backendId || req.id;
        if (typeof _qcagDesktopCurrentId !== 'undefined' && _qcagDesktopCurrentId && (_qcagDesktopCurrentId === reqBackendId || _qcagDesktopCurrentId === req.tkCode)) {
            const fetchId = foundQuote.quote_code || foundQuote.id || req.quoteCode || req.tkCode;
            if (fetchId && typeof qcagFetchTaskQuoteDetail === 'function') {
                qcagFetchTaskQuoteDetail(fetchId);
            }
        }
        return { hasQuote: true, isAllMatched: false, diffCount: 0, isPendingDetail: true };
    }

    let items = [];
    if (Array.isArray(req.items)) items = req.items;
    else if (typeof req.items === 'string') {
        try { items = JSON.parse(req.items); } catch(_) { items = []; }
    }
    const signageItems = items.filter(it => (typeof qcagIsSignageProductionItem === 'function' ? qcagIsSignageProductionItem(it) : true));
    if (signageItems.length === 0) {
        return { hasQuote: true, isAllMatched: true, diffCount: 0, isPendingDetail: false };
    }

    const matchMap = (typeof qcagMatchSignageItemsWithQuotes === 'function')
        ? qcagMatchSignageItemsWithQuotes(signageItems, quoteItems)
        : new Map();

    let diffCount = 0;
    // Kiểm tra từng dòng khảo sát
    signageItems.forEach((item, rIdx) => {
        const matchedQ = matchMap.get(rIdx);
        if (!matchedQ) {
            diffCount++; // Khảo sát thiếu Báo giá
            return;
        }
        const parsedQ = matchedQ._parsed || qcagParseQuoteItemInfo(matchedQ);

        // Type match
        const reqTypeNorm = qcagNormalizeSignageType(item.type);
        const isTypeMatch = (reqTypeNorm === parsedQ.normType);
        if (!isTypeMatch) diffCount++;

        // Action match (Thay bạt vs Làm mới)
        const reqAct = String(item.action || 'Làm mới').toLowerCase().includes('thay') ? 'Thay bạt' : 'Làm mới';
        const qAct = String(parsedQ.displayAction || 'Làm mới').toLowerCase().includes('thay') ? 'Thay bạt' : 'Làm mới';
        if (reqAct !== qAct) diffCount++;

        // Brand match
        const qBr = String(matchedQ.brand || '-').toLowerCase().trim();
        const reqBr = String(item.brand || '-').toLowerCase().trim();
        if (qBr !== reqBr) diffCount++;

        // Size match (Cho phép sai số <= 5cm hoặc so sánh chính xác)
        const qW = parseFloat(matchedQ.width || matchedQ.w || 0);
        const qH = parseFloat(matchedQ.height || matchedQ.h || 0);
        const rawW = parseFloat(item.width || item.w || 0);
        const rawH = parseFloat(item.height || item.h || 0);
        const isSzMatch = (qW > 0 && qH > 0 && Math.abs(rawW - qW) <= 0.05 && Math.abs(rawH - qH) <= 0.05);
        if (!isSzMatch) diffCount++;
    });

    // Nếu Báo giá có nhiều dòng hơn Khảo sát (thừa dòng trong Báo giá)
    if (quoteItems.length > signageItems.length) {
        diffCount += (quoteItems.length - signageItems.length);
    }

    return {
        hasQuote: true,
        isAllMatched: (diffCount === 0),
        diffCount,
        isPendingDetail: false
    };
}

function qcagGetSaleProductionApprovalStatus(req) {
    if (!req) return { key: 'pending', label: 'Chờ duyệt', cls: 'status-pending' };

    let raw = '';
    // 1. Tra cứu ưu tiên từ cache Map toàn cục nếu có
    if (typeof window !== 'undefined' && window._qcagProductionApprovalStatusMap) {
        const map = window._qcagProductionApprovalStatusMap;
        const keys = [
            req.quoteCode, req.quote_code,
            req.tkCode, req.tk_code,
            req.outletCode, req.outlet_code,
            req.__backendId, req.id
        ].filter(Boolean);

        for (let i = 0; i < keys.length; i++) {
            const k = String(keys[i]).trim().toLowerCase();
            const cleanK = k.replace(/^bg[-_]?/i, '');
            const match = map.get(cleanK) || map.get(k);
            if (match && match.status) {
                raw = String(match.status).toLowerCase().trim();
                break;
            }
        }
    }

    // 2. Tra cứu từ thuộc tính của chính req nếu chưa có từ map
    if (!raw) {
        raw = String(
            req.productionApprovalStatus || 
            req.production_approval_status || 
            req.approval_status || 
            req.quoteStatus || 
            ''
        ).toLowerCase().trim();
    }

    if (raw === 'approved' || raw === 'đã duyệt' || raw === 'done' || raw === 'hoàn thành' || raw === 'processed' || raw === 'da_duyet') {
        return { key: 'approved', label: 'Đã duyệt', cls: 'status-approved' };
    }
    if (raw === 'pending-edit' || raw === 'edit_requested' || raw === 'request-edit' || raw.includes('sửa')) {
        return { key: 'pending-edit', label: 'Yêu cầu sửa', cls: 'status-edit' };
    }
    if (raw === 'rejected' || raw === 'từ chối' || raw === 'tu_choi') {
        return { key: 'rejected', label: 'Từ chối', cls: 'status-rejected' };
    }
    if (raw === 'pending' || raw === 'chờ duyệt' || raw === 'cho_duyet' || raw === 'chờ sale' || raw === 'cho_sale') {
        return { key: 'pending', label: 'Chờ Sale', cls: 'status-pending' };
    }
    return { key: 'pending', label: 'Chờ Sale', cls: 'status-pending' };
}
if (typeof window !== 'undefined') window.qcagGetSaleProductionApprovalStatus = qcagGetSaleProductionApprovalStatus;

function qcagIsTaskPointVerified(req) {
    if (!req) return false;
    if (_qcagCurrentTaskOrder && _qcagCurrentTaskOrder._isProductionOrder) return true;
    const orderId = _qcagCurrentTaskOrder ? (_qcagCurrentTaskOrder.id || _qcagCurrentTaskOrder.orderCode || 'default') : 'default';
    const ids = [req.__backendId, req.id, req.tkCode, req.quoteCode].filter(Boolean).map(String);
    if (ids.length === 0) return false;
    try {
        if (typeof localStorage === 'undefined') return false;
        return ids.some(k => localStorage.getItem('qcag_point_vfd_' + orderId + '_' + k) === 'true');
    } catch (_) { return false; }
}

function qcagToggleTaskPointVerified(reqId) {
    if (!reqId) return;
    const orderId = _qcagCurrentTaskOrder ? (_qcagCurrentTaskOrder.id || _qcagCurrentTaskOrder.orderCode || 'default') : 'default';

    // Tìm req để lấy tất cả các khóa định danh liên quan (__backendId, id, tkCode, quoteCode)
    let req = null;
    if (_qcagCurrentTaskOrder && typeof qcagGetTaskOrderRequests === 'function') {
        const reqs = qcagGetTaskOrderRequests(_qcagCurrentTaskOrder);
        req = reqs.find(r => (
            String(r.__backendId) === String(reqId) || 
            String(r.id) === String(reqId) || 
            String(r.tkCode) === String(reqId) ||
            (r.quoteCode && String(r.quoteCode) === String(reqId))
        ));
    }
    if (!req && typeof allRequests !== 'undefined') {
        req = allRequests.find(r => (
            String(r.__backendId) === String(reqId) || 
            String(r.id) === String(reqId) || 
            String(r.tkCode) === String(reqId) ||
            (r.quoteCode && String(r.quoteCode) === String(reqId))
        ));
    }

    const current = (typeof qcagIsTaskPointVerified === 'function' && req) 
        ? qcagIsTaskPointVerified(req)
        : ((typeof localStorage !== 'undefined') ? (localStorage.getItem('qcag_point_vfd_' + orderId + '_' + String(reqId)) === 'true') : false);
    const nextState = !current;

    const idsToSync = new Set([String(reqId)]);
    if (req) {
        if (req.__backendId) idsToSync.add(String(req.__backendId));
        if (req.id) idsToSync.add(String(req.id));
        if (req.tkCode) idsToSync.add(String(req.tkCode));
        if (req.quoteCode) idsToSync.add(String(req.quoteCode));
    }

    try {
        if (typeof localStorage !== 'undefined') {
            idsToSync.forEach(k => {
                const key = 'qcag_point_vfd_' + orderId + '_' + k;
                if (nextState) {
                    localStorage.setItem(key, 'true');
                } else {
                    localStorage.removeItem(key);
                }
            });
        }
    } catch (_) {}

    if (typeof showToast === 'function') {
        const name = req ? (req.outletName || reqId) : reqId;
        if (nextState) {
            showToast(`✓ Đã xác nhận kiểm tra: ${name}`);
        } else {
            showToast(`Đã hủy xác nhận: ${name}`);
        }
    }

    // Cập nhật DOM nút xác nhận nếu đang mở chi tiết điểm này
    const btn = document.getElementById('qcagVerifyPointBtn');
    if (btn) {
        const unverifiedIconSvg = `<svg class="qcag-verify-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;flex-shrink:0;"><circle cx="12" cy="12" r="9"/></svg>`;
        const verifiedIconSvg = `<svg class="qcag-verify-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;flex-shrink:0;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
        if (nextState) {
            btn.classList.add('verified');
            btn.innerHTML = `${verifiedIconSvg}<span class="qcag-verify-btn-label">Đã kiểm tra điểm này</span>`;
            btn.setAttribute('title', 'Bấm để hủy xác nhận điểm');
        } else {
            btn.classList.remove('verified');
            btn.innerHTML = `${unverifiedIconSvg}<span class="qcag-verify-btn-label">Xác nhận đã kiểm tra</span>`;
            btn.setAttribute('title', 'Bấm để xác nhận đã kiểm tra đối soát điểm này');
        }
    }

    // Re-render danh sách bên trái để cập nhật badge VÀ viền xanh lá (forceRebuild = true)
    if (typeof renderQCAGDesktopList === 'function') {
        renderQCAGDesktopList(true);
    }

    // Refresh HUD Task Banner
    if (typeof updateDesktopTaskBannerUI === 'function') {
        updateDesktopTaskBannerUI();
    }
}

function qcagComputeTaskItemChecklist(req) {
    if (!req) return { total: 1, checked: 0, isComplete: false, isPreComplete: false, isPointVerified: false, isRejected: false, isPendingEdit: false };

    // If viewing an official Production Order, 100% verified
    if (_qcagCurrentTaskOrder && _qcagCurrentTaskOrder._isProductionOrder) {
        return {
            total: 1,
            checked: 1,
            isPointVerified: true,
            isComplete: true,
            isPreComplete: true,
            isPendingEdit: false,
            isRejected: false,
            autoMatch: { hasQuote: true, isAllMatched: true }
        };
    }

    const isPointVerified = qcagIsTaskPointVerified(req);

    const saleAppr = (typeof qcagGetSaleProductionApprovalStatus === 'function') 
        ? qcagGetSaleProductionApprovalStatus(req) 
        : { key: String(req.productionApprovalStatus || 'pending').toLowerCase() };

    const isPendingEdit = (saleAppr.key === 'pending-edit') || (typeof qcagDesktopIsPendingEditRequest === 'function' && qcagDesktopIsPendingEditRequest(req));
    const isRejected = (saleAppr.key === 'rejected');

    const autoMatch = qcagCheckPointQuoteMatch(req);
    const isComplete = isPointVerified && !isPendingEdit && !isRejected;

    return {
        total: 1,
        checked: isPointVerified ? 1 : 0,
        isPointVerified,
        autoMatch,
        isPendingEdit,
        isRejected,
        isComplete,
        isPreComplete: isComplete
    };
}

function qcagToggleTaskChecklist(reqId, itemKey, isChecked) {
    // Backward compatibility shim
    if (typeof qcagToggleTaskPointVerified === 'function') {
        qcagToggleTaskPointVerified(reqId);
    }
}

function qcagNormalizeSignageType(typeStr) {
    const s = String(typeStr || '').toLowerCase().trim();
    if (s.includes('hộp đèn') || s.includes('hop den')) {
        if (s.includes('2 mặt') || s.includes('hai mặt') || s.includes('2 mat')) return 'hop_den_2_mat';
        return 'hop_den_1_mat';
    }
    if (s.includes('giả hộp') || s.includes('gia hop')) {
        if (s.includes('2 mặt') || s.includes('hai mặt') || s.includes('2 mat')) return 'bang_2_mat';
        return 'bang_gia_hop_1_mat';
    }
    if (s.includes('bảng') || s.includes('bang') || s.includes('hiflex') || s.includes('pano')) {
        if (s.includes('2 mặt') || s.includes('hai mặt') || s.includes('không đèn') || s.includes('khong den')) return 'bang_2_mat';
        return 'bang_1_mat';
    }
    if (s.includes('alu')) {
        return 'bang_alu';
    }
    if (s.includes('mái che') || s.includes('mai che') || s.includes('mái hiên') || s.includes('mai hien')) {
        return 'mai_che';
    }
    if (s.includes('rèm') || s.includes('rem')) {
        return 'rem_mai_che';
    }
    if (s.includes('shopname') || s.includes('shop name')) {
        return 'shopname';
    }
    if (s.includes('logo')) {
        if (s.includes('outdoor')) return 'logo_outdoor';
        return 'logo_indoor';
    }
    return s;
}

function qcagNormalizeBrand(brandStr) {
    const s = String(brandStr || '').toLowerCase().trim();
    if (!s || s === '-') return '';
    if (s.includes('bivina')) return 'bivina';
    if (s.includes('tiger')) return 'tiger';
    if (s.includes('heineken')) return 'heineken';
    if (s.includes('larue')) return 'larue';
    if (s.includes('bia việt') || s.includes('bia viet')) return 'bia viet';
    if (s.includes('strongbow')) return 'strongbow';
    if (s.includes('shopname') || s.includes('shop name')) return 'shopname';
    if (s.includes('edelweiss')) return 'edelweiss';
    return s;
}

/**
 * Phân tích chuỗi quy cách tên hạng mục từ Báo giá App 1 về định dạng chuẩn của App 2:
 * - Bóc tách Loại bảng hiệu: KHÔNG có chữ "Thay bạt" hay "Làm mới" (dùng cho hiển thị cột Loại bảng hiệu).
 * - Bóc tách Hình thức: "Thay bạt" hoặc "Làm mới" (dùng cho hiển thị cột Hình thức).
 * - rawFullName: Tên đầy đủ từ App 1 để gán vào tooltip title khi rê chuột.
 */
function qcagParseQuoteItemInfo(raw) {
    let rawStr = '';
    let brand = '';
    let action = '';
    let width = 0;
    let height = 0;

    if (typeof raw === 'string') {
        rawStr = raw.trim();
    } else if (raw && typeof raw === 'object') {
        rawStr = String(raw.type || raw.product_name || raw.content || raw.item_type || raw.name || '').trim();
        brand = String(raw.brand || '').trim();
        action = String(raw.action || '').trim();
        width = parseFloat(raw.width || raw.w || 0);
        height = parseFloat(raw.height || raw.h || 0);
    }

    const sLower = rawStr.toLowerCase();

    // 1. Phân tích Action (Hình thức)
    let parsedAction = action;
    if (!parsedAction) {
        if (sLower.includes('thay bạt') || sLower.includes('thay bat') || sLower.includes('thay da')) {
            parsedAction = 'Thay bạt';
        } else if (sLower.includes('thu hồi') || sLower.includes('thu hoi')) {
            parsedAction = 'Thu hồi';
        } else if (sLower.includes('di dời') || sLower.includes('di doi')) {
            parsedAction = 'Di dời';
        } else {
            parsedAction = 'Làm mới';
        }
    }

    // 2. Phân tích Loại bảng hiệu chuẩn App 2 (loại bỏ tiền tố/hành động Làm mới, Thay bạt, in 2 mặt, ...)
    let displayType = '';
    let normType = '';

    if (sLower.includes('hộp đèn') || sLower.includes('hop den')) {
        if (sLower.includes('2 mặt') || sLower.includes('hai mặt') || sLower.includes('2 mat')) {
            displayType = 'Hộp đèn hiflex 2 mặt';
            normType = 'hop_den_2_mat';
        } else {
            displayType = 'Hộp đèn hiflex 1 mặt';
            normType = 'hop_den_1_mat';
        }
    } else if (sLower.includes('giả hộp') || sLower.includes('gia hop')) {
        if (sLower.includes('2 mặt') || sLower.includes('hai mặt') || sLower.includes('2 mat')) {
            displayType = 'Bảng hiệu giả hộp hiflex 2 mặt';
            normType = 'bang_2_mat';
        } else {
            displayType = 'Bảng hiệu giả hộp hiflex 1 mặt';
            normType = 'bang_gia_hop_1_mat';
        }
    } else if (sLower.includes('bảng') || sLower.includes('bang') || sLower.includes('hiflex') || sLower.includes('pano')) {
        if (sLower.includes('2 mặt') || sLower.includes('hai mặt') || sLower.includes('không đèn') || sLower.includes('khong den')) {
            displayType = 'Bảng hiflex 2 mặt (KHÔNG ĐÈN)';
            normType = 'bang_2_mat';
        } else {
            displayType = 'Bảng hiflex 1 mặt';
            normType = 'bang_1_mat';
        }
    } else if (sLower.includes('alu')) {
        displayType = 'Bảng Alu Nhà Phân Phối';
        normType = 'bang_alu';
    } else if (sLower.includes('mái che') || sLower.includes('mai che') || sLower.includes('mái hiên') || sLower.includes('mai hien')) {
        displayType = 'Mái che di động';
        normType = 'mai_che';
    } else if (sLower.includes('rèm') || sLower.includes('rem')) {
        displayType = 'Rèm Mái Che';
        normType = 'rem_mai_che';
    } else if (sLower.includes('logo')) {
        if (sLower.includes('outdoor')) {
            displayType = 'Logo Outdoor';
            normType = 'logo_outdoor';
        } else {
            displayType = 'Logo indoor';
            normType = 'logo_indoor';
        }
    } else if (sLower.includes('shopname') || sLower.includes('shop name')) {
        displayType = 'Shopname';
        normType = 'shopname';
    } else {
        let clean = rawStr
            .replace(/^(thay bạt|làm mới|sản xuất mới|thi công|gia công)\s+/gi, '')
            .replace(/\s*\((in 2 mặt|in 1 mặt|in hai mặt|in một mặt|in bạt.*?)\)/gi, '')
            .trim();
        displayType = clean || rawStr;
        normType = sLower;
    }

    return {
        rawFullName: rawStr,
        displayType: displayType,
        displayAction: parsedAction,
        normType: normType,
        brand: brand,
        width: width,
        height: height
    };
}

function qcagGetQuoteItemAction(qItem) {
    if (!qItem) return 'Làm mới';
    if (qItem.action) return qItem.action;
    const info = qcagParseQuoteItemInfo(qItem);
    return info.displayAction || 'Làm mới';
}

/**
 * Ánh xạ Mã Code ngầm (Implicit Item Code) cho App 2 dựa trên loại bảng hiệu và hình thức:
 * Chuẩn hóa 100% khớp với danh mục item_code của Báo giá App 1.
 */
function qcagAssignImplicitItemCode(item) {
    if (!item) return '';
    if (item.code || item.item_code) return String(item.code || item.item_code).trim();
    const typeStr = String(item.type || '').toLowerCase().trim();
    const actStr = String(item.action || 'Làm mới').toLowerCase().trim();
    const isThayBat = actStr.includes('thay');

    // 1. Shopname
    if (typeStr.includes('shopname') || typeStr.includes('shop name')) {
        return 'SN_SIGNAGE';
    }

    // 2. Hộp đèn
    if (typeStr.includes('hộp đèn') || typeStr.includes('hop den')) {
        const is2Mat = (typeStr.includes('2 mặt') || typeStr.includes('hai mặt') || typeStr.includes('2 mat'));
        if (isThayBat) return '9.3'; // Thay bạt hộp đèn (chung 1 hoặc 2 mặt)
        return is2Mat ? '1.2' : '1.1'; // Làm mới hộp đèn 2 mặt (1.2) hoặc 1 mặt (1.1)
    }

    // 3. Bảng hiệu hiflex / pano / giả hộp
    if (typeStr.includes('bảng') || typeStr.includes('bang') || typeStr.includes('hiflex') || typeStr.includes('pano') || typeStr.includes('giả hộp')) {
        const is2Mat = (typeStr.includes('2 mặt') || typeStr.includes('hai mặt') || typeStr.includes('2 mat'));
        if (isThayBat) return '9.2'; // Thay bạt bảng hiệu hiflex (9.2)
        return is2Mat ? '2.2' : '2.1'; // Làm mới bảng hiệu 2 mặt (2.2) hoặc 1 mặt (2.1)
    }

    // 4. Logo LED
    if (typeStr.includes('logo')) {
        if (typeStr.includes('outdoor')) return 'LG2';
        return 'LG1';
    }

    // 5. Mái hiên / Mái che / Rèm
    if (typeStr.includes('rèm') || typeStr.includes('rem')) return 'N23';
    if (typeStr.includes('mái') || typeStr.includes('mai')) {
        return isThayBat ? 'N23' : 'MH4';
    }

    return '';
}

/**
 * Ghép cặp 1-1 thông minh giữa Hạng mục yêu cầu (App 2) và Báo giá (App 1):
 * Tuân thủ Quy trình 3 Lớp Bắt Cặp (Hybrid Matching Engine):
 * - Vòng 1: Khớp TUYỆT ĐỐI (Cùng Mã Code + Cùng Brand + Kích thước khớp <= 5cm).
 * - Vòng 2: Trùng Mã Code nhưng lệch Size ➔ Ghép cặp theo độ lệch khoảng cách Delta nhỏ nhất (Nearest Delta Pass).
 * - Vòng 3: Cứu cánh Khác Code (Thay bạt vs Làm mới) ➔ Ghép theo Cùng Loại biển hiệu (normType) + Cùng Brand.
 * - Khóa 1-1 chặt chẽ (Greedy Lock): 1 dòng Báo giá chỉ được gán cho 1 dòng Khảo sát.
 */
function qcagMatchSignageItemsWithQuotes(reqItems, quoteItems) {
    const rList = (Array.isArray(reqItems) ? reqItems : []).map((r, idx) => ({
        ...r,
        _rIdx: idx,
        _implicitCode: qcagAssignImplicitItemCode(r),
        _rNorm: qcagNormalizeSignageType(r.type),
        _rBrand: String(r.brand || '').toLowerCase().trim(),
        _rW: parseFloat(r.width || r.w || 0),
        _rH: parseFloat(r.height || r.h || 0),
        _rAct: String(r.action || 'Làm mới').toLowerCase().includes('thay') ? 'Thay bạt' : 'Làm mới'
    }));

    const qList = (Array.isArray(quoteItems) ? quoteItems : []).map((q, idx) => {
        const parsed = qcagParseQuoteItemInfo(q);
        const rawCode = String(q.item_code || q.code || '').trim();
        // Nhận diện shopname trong quote
        const isShopname = (String(q.brand || '').toLowerCase().includes('shopname') || String(q.product_name || q.type || '').toLowerCase().includes('shopname'));
        const effectiveCode = isShopname ? 'SN_SIGNAGE' : rawCode;

        return {
            ...q,
            _qIdx: idx,
            _parsed: parsed,
            _code: effectiveCode,
            _qNorm: parsed.normType,
            _qBrand: String(q.brand || '').toLowerCase().trim(),
            _qW: parseFloat(q.width || q.w || 0),
            _qH: parseFloat(q.height || q.h || 0),
            _qAct: String(parsed.displayAction || 'Làm mới').toLowerCase().includes('thay') ? 'Thay bạt' : 'Làm mới'
        };
    });

    const matchMap = new Map(); // rIdx -> matchedQuoteObject
    const usedQuoteIdxs = new Set();

    // ── VÒNG 1: Bắt cặp Hoàn Hảo (Cùng Code + Cùng Brand + Kích thước khớp <= 5cm) ──
    rList.forEach(r => {
        if (!r._implicitCode) return;
        const found = qList.find(q => {
            if (usedQuoteIdxs.has(q._qIdx)) return false;
            if (q._code !== r._implicitCode) return false;
            if (q._qBrand !== r._rBrand) return false;
            // Kiểm tra kích thước chênh lệch không quá 0.05m (5cm)
            const dW = Math.abs(q._qW - r._rW);
            const dH = Math.abs(q._qH - r._rH);
            return (dW <= 0.05 && dH <= 0.05);
        });

        if (found) {
            matchMap.set(r._rIdx, found);
            usedQuoteIdxs.add(found._qIdx);
        }
    });

    // ── VÒNG 2: Trùng Mã Code + Cùng Brand nhưng Lệch Size ➔ Bắt cặp theo Delta nhỏ nhất ──
    rList.forEach(r => {
        if (matchMap.has(r._rIdx) || !r._implicitCode) return;

        // Tìm tất cả các dòng báo giá cùng mã code và cùng brand chưa dùng
        const candidates = qList.filter(q => (
            !usedQuoteIdxs.has(q._qIdx) &&
            q._code === r._implicitCode &&
            q._qBrand === r._rBrand
        ));

        if (candidates.length > 0) {
            // Sắp xếp theo Delta khoảng cách kích thước tăng dần
            candidates.sort((a, b) => {
                const deltaA = Math.abs(a._qW - r._rW) + Math.abs(a._qH - r._rH);
                const deltaB = Math.abs(b._qW - r._rW) + Math.abs(b._qH - r._rH);
                return deltaA - deltaB;
            });
            const best = candidates[0];
            matchMap.set(r._rIdx, best);
            usedQuoteIdxs.add(best._qIdx);
        }
    });

    // ── VÒNG 3: Cứu cánh Khác Code (Thay bạt vs Làm mới hoặc lệch mã) ➔ Khớp theo Loại biển hiệu (normType) + Brand ──
    rList.forEach(r => {
        if (matchMap.has(r._rIdx)) return;

        // Ưu tiên 3.1: Cùng normType + Cùng Brand
        let candidates = qList.filter(q => (
            !usedQuoteIdxs.has(q._qIdx) &&
            q._qNorm === r._rNorm &&
            q._qBrand === r._rBrand
        ));

        // Ưu tiên 3.2: Cùng normType (kể cả khác brand nếu không còn lựa chọn)
        if (candidates.length === 0) {
            candidates = qList.filter(q => (
                !usedQuoteIdxs.has(q._qIdx) &&
                q._qNorm === r._rNorm
            ));
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => {
                const deltaA = Math.abs(a._qW - r._rW) + Math.abs(a._qH - r._rH);
                const deltaB = Math.abs(b._qW - r._rW) + Math.abs(b._qH - r._rH);
                return deltaA - deltaB;
            });
            const best = candidates[0];
            matchMap.set(r._rIdx, best);
            usedQuoteIdxs.add(best._qIdx);
        }
    });

    // ── VÒNG 4: Nếu cả 2 bên CHỈ CÓ ĐÚNG 1 HẠNG MỤC DUY NHẤT ➔ Cho phép ghép để hiển thị rõ sai lệch ──
    if (rList.length === 1 && qList.length === 1 && !matchMap.has(0)) {
        matchMap.set(0, qList[0]);
        usedQuoteIdxs.add(qList[0]._qIdx);
    }

    return matchMap;
}

function qcagFindMatchingQuoteItem(reqItem, quoteItems) {
    if (!reqItem || !Array.isArray(quoteItems) || quoteItems.length === 0) return null;
    const reqBrandNorm = String(reqItem.brand || '').toLowerCase().trim();
    const reqTypeNorm = qcagNormalizeSignageType(reqItem.type);

    // 1. Khớp cả Type và Brand
    let matched = quoteItems.find(q => {
        const parsed = qcagParseQuoteItemInfo(q);
        const qBrandNorm = String(q.brand || '').toLowerCase().trim();
        return qBrandNorm === reqBrandNorm && parsed.normType === reqTypeNorm;
    });

    // 2. Khớp theo Type (kể cả khác brand)
    if (!matched) {
        matched = quoteItems.find(q => {
            const parsed = qcagParseQuoteItemInfo(q);
            return parsed.normType === reqTypeNorm;
        });
    }

    // 3. Nếu quote chỉ có 1 item duy nhất: cho phép so sánh
    if (!matched && quoteItems.length === 1) {
        matched = quoteItems[0];
    }

    return matched || null;
}

/** Check if an item is an actual production signage / print item requiring inspection.
 * - Excludes non-print / structural / fee items: tole, tôn, trụ, giấy phép, xin phép, phí...
 * - EXCEPTION: Shopname is ALWAYS included for printing inspection in Task Flow (even without QC).
 * - Includes QC signage items: bảng hiệu, hộp đèn, hiflex, bạt, decal, mica, alu, chữ nổi, poster...
 */
function qcagIsSignageProductionItem(item) {
    if (!item) return false;
    const txt = String(item.type || item.product_name || item.content || item.item_type || item.item_code || '').toLowerCase().trim();
    const brand = String(item.brand || '').toLowerCase().trim();
    if (!txt && !brand) return false;

    // 1. Explicitly exclude non-print / structural / auxiliary / fee items
    if (txt.includes('tôn') || txt.includes('tole') || txt.includes('trụ') || txt.includes('tru ') || 
        txt.includes('giấy phép') || txt.includes('xin phép') || txt.includes('hồ sơ') || 
        txt.includes('phí gửi xe') || txt.includes('phí gởi xe') || txt.includes('phí') || 
        txt.includes('vận chuyển') || txt.includes('tháo dỡ')) {
        return false;
    }

    // 2. EXCEPTION: Shopname is ALWAYS included for printing inspection in Task Flow
    if (brand.includes('shopname') || brand.includes('shop name') || txt.includes('shopname') || txt.includes('shop name')) {
        return true;
    }

    // 3. EXCEPTION: Hạng mục khác is ALWAYS included
    if (txt.includes('hạng mục khác') || txt.includes('hang muc khac') || txt === 'khác' || txt === 'khac') {
        return true;
    }

    // 4. QC Signage Print Items (bảng hiệu, hộp đèn, hiflex, bạt, decal, mica, alu, chữ nổi, poster...)
    const isSignage = txt.includes('bảng') || txt.includes('bang') || txt.includes('hộp đèn') || txt.includes('hop den') ||
                      txt.includes('hiflex') || txt.includes('bạt') || txt.includes('bat') || txt.includes('decal') ||
                      txt.includes('mica') || txt.includes('alu') || txt.includes('chữ nổi') || txt.includes('chu noi') ||
                      txt.includes('poster') || txt.includes('standee') || txt.includes('in ấn') || txt.includes('in ');
    if (isSignage) return true;

    // Default fallback: If item has dimensions and brand and is not mechanical/sheet metal/poles, include it
    const w = parseFloat(item.width || item.w || 0);
    const h = parseFloat(item.height || item.h || 0);
    if (w > 0 && h > 0 && !txt.includes('kẽm') && !txt.includes('sắt') && !txt.includes('khung sắt')) {
        return true;
    }

    return false;
}

/** Get brand class for badges */
function qcagGetBrandBadgeClass(brand) {
    const b = String(brand || '').toLowerCase().trim();
    if (b.includes('heineken')) return 'brand-heineken';
    if (b.includes('tiger')) return 'brand-tiger';
    if (b.includes('bivina')) return 'brand-bivina';
    if (b.includes('bia việt') || b.includes('bia viet')) return 'brand-biaviet';
    if (b.includes('larue')) return 'brand-larue';
    if (b.includes('strongbow')) return 'brand-strongbow';
    if (b.includes('shopname')) return 'brand-shopname';
    return 'brand-default';
}

/** Render Quoted Items Table (App 1) with Smart Diff vs Request Items */
function qcagDesktopBuildQuoteItemsHtml(quoteItems, reqItems, request) {
    let list = Array.isArray(quoteItems) ? quoteItems.filter(qcagIsSignageProductionItem) : [];
    if (list.length === 0) {
        return '<div class="qcag-items-empty text-xs text-gray-400 py-3 text-center">Không có hạng mục sản xuất bảng hiệu trong báo giá</div>';
    }

    const reqId = request ? (request.__backendId || request.id || request.tkCode || '') : '';
    const saved = request && typeof qcagGetTaskChecklistSaved === 'function' ? qcagGetTaskChecklistSaved(request) : {};

    let reqList = [];
    if (Array.isArray(reqItems)) reqList = reqItems;
    else if (typeof reqItems === 'string') {
        try { reqList = JSON.parse(reqItems); } catch (_) { reqList = []; }
    }

    let html = `
        <div class="qcag-items-table qcag-quote-items-table">
            <div class="qcag-items-head qcag-quote-items-head">
                <div class="qcag-cell-stt">STT</div>
                <div>Loại bảng hiệu (Quy cách Báo Giá)</div>
                <div class="qcag-cell-center">Brand</div>
                <div>Kích thước Báo Giá</div>
                <div class="qcag-cell-center">Số lượng</div>
            </div>
            <div class="qcag-items-body">
    `;

    list.forEach((qItem, idx) => {
        const type = qItem.type || qItem.product_name || qItem.content || qItem.item_type || '-';
        const brand = qItem.brand || '-';
        const brandCls = (typeof qcagGetBrandBadgeClass === 'function') ? qcagGetBrandBadgeClass(brand) : 'brand-default';

        const qW = parseFloat(qItem.width || qItem.w || 0);
        const qH = parseFloat(qItem.height || qItem.h || 0);
        const sizeStr = (qW > 0 || qH > 0) ? (typeof qcagFormatDimensionText === 'function' ? qcagFormatDimensionText(qW, qH) : `${qW}m x ${qH}m`) : '-';

        // Check if there is a corresponding item in request items to detect size differences
        const reqItem = reqList[idx] || reqList.find(r => (r.brand && r.brand === brand) || (r.type && r.type === type));
        let diffBadgeHtml = '';
        let isDiff = false;
        if (reqItem) {
            const reqW = parseFloat(reqItem.width || reqItem.w || 0);
            const reqH = parseFloat(reqItem.height || reqItem.h || 0);
            if ((reqW > 0 || reqH > 0) && (reqW !== qW || reqH !== qH)) {
                isDiff = true;
                const reqSzStr = typeof qcagFormatDimensionText === 'function' ? qcagFormatDimensionText(reqW, reqH) : `${reqW}m x ${reqH}m`;
                diffBadgeHtml = `<span class="qcag-size-diff-badge" title="Kích thước báo giá (${sizeStr}) khác yêu cầu của Sale (${reqSzStr})">⚠️ Lệch YC: ${reqSzStr}</span>`;
            }
        }

        const isChecked = !!saved[`quote_item_${idx}_size`];

        html += `
            <div class="qcag-items-row qcag-quote-items-row ${isDiff ? 'qcag-row-diff' : ''}">
                <div class="qcag-cell-stt font-mono">${idx + 1}</div>
                <div class="qcag-type-val font-semibold text-emerald-400 text-xs">${escapeHtml(type)}</div>
                <div class="qcag-cell-center">
                    <span class="qcag-brand-badge ${brandCls}">${escapeHtml(brand)}</span>
                </div>
                <div class="qcag-items-cell-size ${isDiff ? 'qcag-size-warning' : ''}">
                    <div class="qcag-size-val">
                        <span class="qcag-size-text font-bold text-white">${escapeHtml(sizeStr)}</span>
                        ${diffBadgeHtml}
                    </div>
                </div>
                <div class="qcag-cell-center font-mono font-semibold text-xs">
                    <span class="qcag-quote-qty-badge">${escapeHtml(String(qItem.quantity || qItem.qty || 1))}</span>
                </div>
            </div>
        `;
    });

    html += `
            </div>
        </div>
    `;

    return html;
}

// ═══════════════════════════════════════════════════════════════════════════
// ── TASK GRID COMPLETION VIEW (5 Cards Per Row) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

function qcagGetTaskGridSaved(orderId) {
    if (!orderId) return {};
    let result = {};
    // 1. Read from DB cache if present
    if (_qcagDbChecklistsCache[orderId]) {
        const orderCache = _qcagDbChecklistsCache[orderId];
        Object.keys(orderCache).forEach(tk => {
            if (orderCache[tk] && orderCache[tk].printReady) {
                result[tk] = true;
            }
        });
    }
    // 2. Overlay with local storage
    try {
        const raw = localStorage.getItem('qcag_grid_checked_' + orderId);
        const loc = raw ? JSON.parse(raw) : {};
        result = { ...result, ...loc };
    } catch (_) {}
    return result;
}

function qcagSaveTaskGridSaved(orderId, saved) {
    if (!orderId) return;
    try {
        localStorage.setItem('qcag_grid_checked_' + orderId, JSON.stringify(saved || {}));
    } catch (_) {}

    // Persist print_ready state to Database for each request
    if (_qcagCurrentTaskOrder && _qcagCurrentTaskOrder.id === orderId) {
        const reqs = qcagGetTaskOrderRequests(_qcagCurrentTaskOrder);
        reqs.forEach(req => {
            const reqKey = String(req.__backendId || req.id || req.tkCode || '').trim();
            const isChecked = !!(saved && saved[reqKey]);
            const tk = String(req.tkCode || req.tk_code || reqKey).trim();

            if (!_qcagDbChecklistsCache[orderId]) _qcagDbChecklistsCache[orderId] = {};
            _qcagDbChecklistsCache[orderId][tk] = {
                ...(_qcagDbChecklistsCache[orderId][tk] || {}),
                pendingOrderId: orderId,
                tkCode: tk,
                printReady: isChecked
            };

            const payload = {
                tkCode: tk,
                printReady: isChecked,
                verifiedBy: (typeof currentSession !== 'undefined' && currentSession && (currentSession.saleName || currentSession.name || currentSession.phone)) || 'QCAG'
            };
            const endpoints = [
                `/api/ks/pending-orders/${encodeURIComponent(orderId)}/checklists`,
                `/pending-orders/${encodeURIComponent(orderId)}/checklists`
            ];
            endpoints.forEach(ep => {
                fetch(ep, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(() => {});
            });
        });
    }
}

function qcagNavigateTaskItem(direction) {
    if (!_qcagCurrentTaskOrder) return;
    const taskReqs = qcagGetTaskOrderRequests(_qcagCurrentTaskOrder);
    if (!taskReqs || taskReqs.length <= 1) return;

    const currentId = (typeof _qcagDesktopCurrentId !== 'undefined') ? _qcagDesktopCurrentId : null;
    let currIdx = taskReqs.findIndex(r => r.__backendId === currentId || r.id === currentId || r.tkCode === currentId);
    if (currIdx === -1) currIdx = 0;

    let targetIdx = currIdx + direction;
    if (targetIdx < 0) targetIdx = 0;
    if (targetIdx >= taskReqs.length) targetIdx = taskReqs.length - 1;

    if (targetIdx !== currIdx && taskReqs[targetIdx]) {
        if (typeof openQCAGDesktopRequest === 'function') {
            openQCAGDesktopRequest(taskReqs[targetIdx].__backendId);
        }
    }
}

// Global hotkeys for Desktop QCAG Task Mode (Alt + Left/Right)
if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
        if (!_qcagCurrentTaskOrder) return;
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable)) return;

        if (e.altKey && e.key === 'ArrowRight') {
            e.preventDefault();
            qcagNavigateTaskItem(1);
        } else if (e.altKey && e.key === 'ArrowLeft') {
            e.preventDefault();
            qcagNavigateTaskItem(-1);
        }
    });
}

function qcagOpenTaskGridCompletionView() {
    if (!_qcagCurrentTaskOrder) {
        if (typeof showToast === 'function') showToast('Chưa chọn nhiệm vụ đơn hàng');
        return;
    }

    const screenEl = document.getElementById('qcagTaskGridScreen') || document.getElementById('qcagTaskGridModal');
    if (!screenEl) return;

    const reqs = qcagGetTaskOrderRequests(_qcagCurrentTaskOrder);
    const total = reqs.length;

    let quotes = [];
    if (Array.isArray(_qcagCurrentTaskOrder.quotes)) quotes = _qcagCurrentTaskOrder.quotes;
    else if (typeof _qcagCurrentTaskOrder.quotes === 'string') {
        try { quotes = JSON.parse(_qcagCurrentTaskOrder.quotes); } catch (_) { quotes = []; }
    }
    let uniqueAreas = [...new Set(quotes.map(q => q.area || q.khu_vuc || q.region).filter(Boolean))];
    if (uniqueAreas.length === 0 && _qcagCurrentTaskOrder.areaList) uniqueAreas = [_qcagCurrentTaskOrder.areaList];
    const areasText = uniqueAreas.length > 0 ? uniqueAreas.join(', ') : '-';
    const createdBy = _qcagCurrentTaskOrder.createdBy || _qcagCurrentTaskOrder.created_by || 'Người tạo';

    const titleEl = document.getElementById('qcagTaskGridOrderTitle');
    const subEl = document.getElementById('qcagTaskGridOrderSub');

    if (titleEl) titleEl.textContent = `Gói đơn: ${total} điểm • ${_qcagCurrentTaskOrder.order_no || _qcagCurrentTaskOrder.code || 'Nhiệm vụ'}`;
    if (subEl) subEl.textContent = `Khu vực: ${areasText} • Tạo bởi: ${createdBy} — Tích chọn từng thẻ để xác nhận đã sắp file in`;

    screenEl.classList.remove('hidden', 'qcag-screen-slide-out');
    screenEl.classList.add('qcag-screen-slide-in');
    _qcagGridCurrentPage = 1;
    renderTaskGridCards();
}

function qcagCloseTaskGridView() {
    const screenEl = document.getElementById('qcagTaskGridScreen') || document.getElementById('qcagTaskGridModal');
    if (!screenEl) return;

    screenEl.classList.remove('qcag-screen-slide-in');
    screenEl.classList.add('qcag-screen-slide-out');

    setTimeout(() => {
        screenEl.classList.add('hidden');
        screenEl.classList.remove('qcag-screen-slide-out');
    }, 220);
}

let _qcagGridCurrentPage = 1;
const QCAG_GRID_PAGE_SIZE = 18;

function qcagTaskGridGoPage(page) {
    if (!_qcagCurrentTaskOrder) return;
    const reqs = qcagGetTaskOrderRequests(_qcagCurrentTaskOrder);
    const totalCards = reqs.length;
    const totalPages = Math.max(1, Math.ceil(totalCards / QCAG_GRID_PAGE_SIZE));
    if (page < 1 || page > totalPages) return;
    _qcagGridCurrentPage = page;
    renderTaskGridCards();
    const wrapper = document.getElementById('qcagTaskGridCardsWrapper');
    if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.qcagTaskGridGoPage = qcagTaskGridGoPage;

function renderTaskGridCards() {
    if (!_qcagCurrentTaskOrder) return;
    const reqs = qcagGetTaskOrderRequests(_qcagCurrentTaskOrder);
    const orderId = _qcagCurrentTaskOrder.id;
    const gridSaved = qcagGetTaskGridSaved(orderId);

    const wrapper = document.getElementById('qcagTaskGridCardsWrapper');
    if (!wrapper) return;

    const totalCards = reqs.length;
    const totalPages = Math.max(1, Math.ceil(totalCards / QCAG_GRID_PAGE_SIZE));
    if (_qcagGridCurrentPage > totalPages) _qcagGridCurrentPage = totalPages;
    if (_qcagGridCurrentPage < 1) _qcagGridCurrentPage = 1;

    const startIdx = (_qcagGridCurrentPage - 1) * QCAG_GRID_PAGE_SIZE;
    const pageReqs = reqs.slice(startIdx, startIdx + QCAG_GRID_PAGE_SIZE);

    wrapper.innerHTML = pageReqs.map((req, idx) => {
        const globalIdx = startIdx + idx + 1;
        const reqId = String(req.__backendId || req.id || req.tkCode || '');
        const tk = String(req.tkCode || req.tk_code || '').trim();
        const qCode = String(req.quoteCode || req.quote_code || '').trim();
        const bId = String(req.__backendId || '').trim();
        const numId = String(req.id || '').trim();
        const isChecked = !!(gridSaved[reqId] || (tk && gridSaved[tk]) || (qCode && gridSaved[qCode]) || (bId && gridSaved[bId]) || (numId && gridSaved[numId]));

        // Prepare MQ design images vs status images
        let designImgs = [];
        let statusImgs = [];
        try {
            if (typeof qcagDesktopPrepareRenderImageList === 'function' && typeof qcagDesktopParseJson === 'function') {
                designImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(req.designImages || req.design_images, []));
                statusImgs = qcagDesktopPrepareRenderImageList(qcagDesktopParseJson(req.statusImages || req.status_images, []));
            }
        } catch (_) {}

        const hasMq = designImgs.length > 0;
        const imgUrl = hasMq ? designImgs[0] : (statusImgs.length > 0 ? statusImgs[0] : '');

        // Trạng thái phê duyệt Sale của điểm này
        const saleAppr = (typeof qcagGetSaleProductionApprovalStatus === 'function')
            ? qcagGetSaleProductionApprovalStatus(req)
            : { key: String(req.productionApprovalStatus || 'pending').toLowerCase() };
        const isPendingEdit = (saleAppr && (saleAppr.key === 'pending-edit' || String(saleAppr.key || '').includes('sửa')));
        const isRejected = (saleAppr && saleAppr.key === 'rejected');

        let tagHtml = '';
        if (isRejected) {
            tagHtml = `<div class="qcag-grid-card-tag tag-rejected" style="position:absolute;top:8px;right:8px;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(239,68,68,0.95);color:#fff;">✕ Sale từ chối</div>`;
        } else if (isPendingEdit) {
            tagHtml = `<div class="mq-editing-badge-overlay" style="top:8px;left:8px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>Đang chỉnh sửa</div>`;
        } else if (!hasMq && !imgUrl) {
            tagHtml = `<div class="qcag-grid-card-tag tag-no-img" style="position:absolute;top:8px;right:8px;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:700;background:rgba(100,116,139,0.95);color:#fff;">⚠️ Thiếu MQ</div>`;
        }

        return `
            <div class="qcag-grid-card ${isChecked ? 'is-checked' : ''} ${isRejected ? 'card-has-reject' : ''} ${isPendingEdit ? 'card-has-edit' : ''}" id="gridCard_${escapeHtml(reqId)}">
                <div class="qcag-grid-card-media mq-thumb-editing-wrap" onclick="if (typeof showImageFull === 'function' && '${escapeHtml(imgUrl)}') { window._dv_currentDesignReq = (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) ? allRequests.find(r => r && (String(r.__backendId) === '${escapeHtml(reqId)}' || String(r.id) === '${escapeHtml(reqId)}')) : null; showImageFull('${escapeHtml(imgUrl)}', false); }" title="${isPendingEdit ? 'Đang chỉnh sửa - Nhấn để phóng to ảnh tham chiếu' : 'Nhấn để phóng to ảnh full 100%'}">
                    ${imgUrl ? `
                        <img src="${escapeHtml(imgUrl)}" class="${isPendingEdit ? 'mq-img-editing' : ''}" alt="MQ ${escapeHtml(req.outletName || '')}" onerror="_imgBrokenFallback(this)" loading="lazy">
                        <button type="button" class="qcag-grid-zoom-btn" onclick="event.stopPropagation(); if (typeof showImageFull === 'function') { window._dv_currentDesignReq = (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) ? allRequests.find(r => r && (String(r.__backendId) === '${escapeHtml(reqId)}' || String(r.id) === '${escapeHtml(reqId)}')) : null; showImageFull('${escapeHtml(imgUrl)}', false); }" title="Xem ảnh full 100%">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
                        </button>
                    ` : `
                        <div class="qcag-grid-no-img">
                            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                            <span>Chưa có ảnh MQ</span>
                        </div>
                    `}
                    ${tagHtml}
                </div>

                <div class="qcag-grid-card-info" onclick="qcagToggleGridCard('${escapeHtml(reqId)}')">
                    <div class="qcag-grid-card-name" title="${escapeHtml(req.outletName || '')}">
                        <span class="qcag-grid-card-stt">#${globalIdx}</span>
                        <span class="truncate">${escapeHtml(String(req.outletName || '-').toUpperCase())}</span>
                    </div>
                    <div class="qcag-grid-card-code">
                        <span>${escapeHtml(req.outletCode || '-')}</span>
                        <span class="qcag-grid-card-sep">•</span>
                        <span>${escapeHtml(req.tkCode || '-')}</span>
                    </div>
                </div>

                <div class="qcag-grid-card-footer">
                    <div class="qcag-grid-chk-pill ${isChecked ? 'checked' : 'unchecked'}" id="gridChkPill_${escapeHtml(reqId)}" onclick="qcagToggleGridCard('${escapeHtml(reqId)}')">
                        <span>${isChecked ? '✓ Đã sắp file in' : 'Chưa sắp file in'}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    renderTaskGridPagination(totalCards, totalPages);
    qcagUpdateTaskGridCounter();
}

function renderTaskGridPagination(totalCards, totalPages) {
    const paginEl = document.getElementById('qcagTaskGridPagination');
    if (!paginEl) return;

    if (totalCards <= 0) {
        paginEl.innerHTML = '';
        return;
    }

    const startIdx = (_qcagGridCurrentPage - 1) * QCAG_GRID_PAGE_SIZE + 1;
    const endIdx = Math.min(_qcagGridCurrentPage * QCAG_GRID_PAGE_SIZE, totalCards);

    let pageBtnsHtml = '';

    // Nút Trang trước
    pageBtnsHtml += `
        <button type="button" class="qcag-grid-page-btn nav-btn" onclick="qcagTaskGridGoPage(${_qcagGridCurrentPage - 1})" ${_qcagGridCurrentPage <= 1 ? 'disabled' : ''} title="Trang trước">
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M15 19l-7-7 7-7"/></svg>
            <span>Trước</span>
        </button>
    `;

    // Hiển thị các số trang
    let startPage = Math.max(1, _qcagGridCurrentPage - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) {
        startPage = Math.max(1, endPage - 4);
    }

    if (startPage > 1) {
        pageBtnsHtml += `<button type="button" class="qcag-grid-page-btn" onclick="qcagTaskGridGoPage(1)">1</button>`;
        if (startPage > 2) pageBtnsHtml += `<span class="qcag-grid-page-ellipsis">...</span>`;
    }

    for (let p = startPage; p <= endPage; p++) {
        const isActive = (p === _qcagGridCurrentPage);
        pageBtnsHtml += `
            <button type="button" class="qcag-grid-page-btn ${isActive ? 'active' : ''}" onclick="qcagTaskGridGoPage(${p})">
                ${p}
            </button>
        `;
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) pageBtnsHtml += `<span class="qcag-grid-page-ellipsis">...</span>`;
        pageBtnsHtml += `<button type="button" class="qcag-grid-page-btn" onclick="qcagTaskGridGoPage(${totalPages})">${totalPages}</button>`;
    }

    // Nút Trang sau
    pageBtnsHtml += `
        <button type="button" class="qcag-grid-page-btn nav-btn" onclick="qcagTaskGridGoPage(${_qcagGridCurrentPage + 1})" ${_qcagGridCurrentPage >= totalPages ? 'disabled' : ''} title="Trang kế tiếp">
            <span>Sau</span>
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M9 5l7 7-7 7"/></svg>
        </button>
    `;

    paginEl.innerHTML = `
        <div class="qcag-task-grid-page-info">
            Hiển thị <strong>${startIdx} - ${endIdx}</strong> / <strong>${totalCards}</strong> điểm (Trang ${_qcagGridCurrentPage}/${totalPages} • 18 thẻ/trang)
        </div>
        <div class="qcag-task-grid-page-btns">
            ${pageBtnsHtml}
        </div>
    `;
}

function qcagToggleGridCard(reqId, forceVal) {
    if (!_qcagCurrentTaskOrder) return;
    const orderId = _qcagCurrentTaskOrder.id;
    const gridSaved = qcagGetTaskGridSaved(orderId);

    // Multi-key check hiện tại
    const req = (_qcagCurrentTaskOrder && typeof qcagGetTaskOrderRequests === 'function')
        ? qcagGetTaskOrderRequests(_qcagCurrentTaskOrder).find(r => (
            String(r.__backendId) === String(reqId) ||
            String(r.id) === String(reqId) ||
            String(r.tkCode) === String(reqId) ||
            (r.quoteCode && String(r.quoteCode) === String(reqId))
        ))
        : null;

    const tk = req ? String(req.tkCode || req.tk_code || '').trim() : '';
    const qCode = req ? String(req.quoteCode || req.quote_code || '').trim() : '';
    const bId = req ? String(req.__backendId || '').trim() : '';
    const numId = req ? String(req.id || '').trim() : '';

    const isCurrentlyChecked = !!(gridSaved[reqId] || (tk && gridSaved[tk]) || (qCode && gridSaved[qCode]) || (bId && gridSaved[bId]) || (numId && gridSaved[numId]));
    const nextVal = (typeof forceVal === 'boolean') ? forceVal : !isCurrentlyChecked;

    // Lưu đồng thời tất cả các khóa liên quan
    const keysToUpdate = new Set([String(reqId)]);
    if (tk) keysToUpdate.add(tk);
    if (qCode) keysToUpdate.add(qCode);
    if (bId) keysToUpdate.add(bId);
    if (numId) keysToUpdate.add(numId);

    keysToUpdate.forEach(k => {
        if (nextVal) gridSaved[k] = true;
        else delete gridSaved[k];
    });

    qcagSaveTaskGridSaved(orderId, gridSaved);

    // Update Card element in DOM in-place
    const cardEl = document.getElementById('gridCard_' + reqId);
    if (cardEl) {
        if (nextVal) {
            cardEl.classList.add('is-checked');
        } else {
            cardEl.classList.remove('is-checked');
        }

        const pillEl = cardEl.querySelector('#gridChkPill_' + reqId) || cardEl.querySelector('.qcag-grid-chk-pill');
        if (pillEl) {
            pillEl.className = 'qcag-grid-chk-pill ' + (nextVal ? 'checked' : 'unchecked');
            pillEl.innerHTML = `<span>${nextVal ? '✓ Đã sắp file in' : 'Chưa sắp file in'}</span>`;
        }
    }

    qcagUpdateTaskGridCounter();
}

/**
 * Kiểm tra tính hợp lệ toàn diện trước khi hoàn tất nhiệm vụ (Zero-Bypass Guard)
 */
function qcagGetTaskGridValidation(order) {
    if (!order) return { total: 0, checkedCount: 0, rejectedCount: 0, pendingEditCount: 0, missingImgCount: 0, canFinish: false };
    const reqs = qcagGetTaskOrderRequests(order);
    const total = reqs.length;
    const orderId = order.id;
    const gridSaved = qcagGetTaskGridSaved(orderId);

    let checkedCount = 0;
    let rejectedCount = 0;
    let pendingEditCount = 0;
    let missingImgCount = 0;

    reqs.forEach(r => {
        const reqId = String(r.__backendId || r.id || r.tkCode || '');
        const tk = String(r.tkCode || r.tk_code || '').trim();
        const qCode = String(r.quoteCode || r.quote_code || '').trim();
        const bId = String(r.__backendId || '').trim();
        const numId = String(r.id || '').trim();
        const isChecked = !!(gridSaved[reqId] || (tk && gridSaved[tk]) || (qCode && gridSaved[qCode]) || (bId && gridSaved[bId]) || (numId && gridSaved[numId]));
        if (isChecked) checkedCount++;

        // Kiểm tra trạng thái duyệt Sale
        const saleAppr = (typeof qcagGetSaleProductionApprovalStatus === 'function')
            ? qcagGetSaleProductionApprovalStatus(r)
            : { key: String(r.productionApprovalStatus || 'pending').toLowerCase() };
        if (saleAppr && saleAppr.key === 'rejected') rejectedCount++;
        else if (saleAppr && (saleAppr.key === 'pending-edit' || String(saleAppr.key || '').includes('sửa'))) pendingEditCount++;

        // Kiểm tra ảnh Maquette
        let activeImgs = qcagTaskGetActiveDesignImages(r);
        if (!activeImgs || activeImgs.length === 0) missingImgCount++;
    });

    const canFinish = total > 0 && checkedCount === total && rejectedCount === 0 && pendingEditCount === 0 && missingImgCount === 0;
    return { total, checkedCount, rejectedCount, pendingEditCount, missingImgCount, canFinish };
}

function qcagUpdateTaskGridCounter() {
    if (!_qcagCurrentTaskOrder) return;
    const v = qcagGetTaskGridValidation(_qcagCurrentTaskOrder);

    const counterValEl = document.getElementById('qcagTaskGridCounterVal');
    if (counterValEl) {
        let extraInfo = '';
        if (v.rejectedCount > 0) extraInfo += ` • <span style="color:#ef4444;font-weight:700;">${v.rejectedCount} bị từ chối</span>`;
        if (v.pendingEditCount > 0) extraInfo += ` • <span style="color:#f59e0b;font-weight:700;">${v.pendingEditCount} chờ sửa MQ</span>`;
        if (v.missingImgCount > 0) extraInfo += ` • <span style="color:#94a3b8;">${v.missingImgCount} chưa có MQ</span>`;
        counterValEl.innerHTML = `${v.checkedCount}/${v.total} điểm${extraInfo}`;
    }

    const finishBtn = document.getElementById('qcagTaskGridFinishBtn');
    if (finishBtn) {
        finishBtn.disabled = !v.canFinish;
        if (!v.canFinish) {
            if (v.rejectedCount > 0) finishBtn.title = `Không thể hoàn tất: Có ${v.rejectedCount} điểm bị Sale từ chối sản xuất!`;
            else if (v.pendingEditCount > 0) finishBtn.title = `Không thể hoàn tất: Có ${v.pendingEditCount} điểm đang chờ sửa Maquette và duyệt lại!`;
            else if (v.missingImgCount > 0) finishBtn.title = `Không thể hoàn tất: Còn ${v.missingImgCount} điểm chưa có ảnh Maquette!`;
            else finishBtn.title = `Cần tích chọn xác nhận đủ tất cả các thẻ file in (${v.checkedCount}/${v.total})`;
        } else {
            finishBtn.title = `Tất cả các điểm đã sẵn sàng. Bấm để hoàn tất nhiệm vụ!`;
        }
    }
}

function qcagTaskGridCheckAll(forceState) {
    if (!_qcagCurrentTaskOrder) return;
    const reqs = qcagGetTaskOrderRequests(_qcagCurrentTaskOrder);
    const orderId = _qcagCurrentTaskOrder.id;
    const gridSaved = qcagGetTaskGridSaved(orderId);

    const v = qcagGetTaskGridValidation(_qcagCurrentTaskOrder);
    const shouldCheckAll = (typeof forceState === 'boolean') ? forceState : (v.checkedCount < reqs.length);

    reqs.forEach(r => {
        const reqId = String(r.__backendId || r.id || r.tkCode || '');
        const tk = String(r.tkCode || r.tk_code || '').trim();
        const qCode = String(r.quoteCode || r.quote_code || '').trim();
        const bId = String(r.__backendId || '').trim();
        const numId = String(r.id || '').trim();

        const keys = [reqId, tk, qCode, bId, numId].filter(Boolean);
        keys.forEach(k => {
            if (shouldCheckAll) gridSaved[k] = true;
            else delete gridSaved[k];
        });
    });

    qcagSaveTaskGridSaved(orderId, gridSaved);
    renderTaskGridCards();

    if (typeof showToast === 'function') {
        showToast(shouldCheckAll ? `✓ Đã duyệt toàn bộ ${reqs.length} thẻ in!` : `Đã bỏ chọn tất cả thẻ in.`);
    }
}

function qcagTaskGridFinishTask() {
    if (!_qcagCurrentTaskOrder) return;
    const v = qcagGetTaskGridValidation(_qcagCurrentTaskOrder);

    // Chốt chặn an toàn (Zero-Bypass Guard)
    if (!v.canFinish) {
        if (v.rejectedCount > 0) {
            if (typeof showToast === 'function') showToast(`❌ Không thể hoàn tất: Có ${v.rejectedCount} điểm bị Sale từ chối!`);
            return;
        }
        if (v.pendingEditCount > 0) {
            if (typeof showToast === 'function') showToast(`⚠️ Không thể hoàn tất: Có ${v.pendingEditCount} điểm đang chờ sửa Maquette!`);
            return;
        }
        if (v.missingImgCount > 0) {
            if (typeof showToast === 'function') showToast(`⚠️ Không thể hoàn tất: Còn ${v.missingImgCount} điểm chưa upload ảnh Maquette!`);
            return;
        }
        if (v.checkedCount < v.total) {
            if (typeof showToast === 'function') showToast(`Cần tích chọn xác nhận đủ tất cả các thẻ file in (${v.checkedCount}/${v.total})!`);
            return;
        }
    }

    const orderId = _qcagCurrentTaskOrder.id;
    const orderCode = qcagGetTaskOrderCode(_qcagCurrentTaskOrder);

    // 1. Bắn tín hiệu duyệt hoàn tất và mở khóa đơn hàng về App 1 & Database
    qcagMarkTaskOrderCompleted(orderId, orderCode);

    // 2. Đánh dấu trạng thái 'completed' vào đối tượng order và danh sách nhiệm vụ
    _qcagCurrentTaskOrder.status = 'completed';
    _qcagCurrentTaskOrder.task_status = 'completed';
    _qcagCurrentTaskOrder.is_completed = true;

    if (Array.isArray(_qcagPendingOrders)) {
        const found = _qcagPendingOrders.find(o => String(o.id) === String(orderId) || qcagGetTaskOrderCode(o) === orderCode);
        if (found) {
            found.status = 'completed';
            found.task_status = 'completed';
            found.is_completed = true;
        }
    }

    // 3. Đóng màn hình duyệt lưới thẻ MQ
    qcagCloseTaskGridView();

    // 4. Trở về TRANG CHÍNH của App 2 (thoát chế độ nhiệm vụ để hiển thị lại giao diện chính)
    qcagDesktopExitTaskMode();

    // 5. Cập nhật lại dropdown nhiệm vụ, badge và banner UI
    updateDesktopTaskBadge();
    updateDesktopTaskBannerUI();
    renderQcagTaskList();

    if (typeof showToast === 'function') {
        showToast(`✓ Đã hoàn tất nhiệm vụ ${orderCode}! Đã đổi trạng thái ĐÃ XONG và bắn tín hiệu mở khóa xác nhận đơn hàng sang App 1.`);
    }
}

// Global exports on window
if (typeof window !== 'undefined') {
    window.fetchQcagPendingOrders = fetchQcagPendingOrders;
    window.renderQcagTaskList = renderQcagTaskList;
    window.updateDesktopTaskBadge = updateDesktopTaskBadge;
    window.qcagDesktopOpenTaskDropdown = qcagDesktopOpenTaskDropdown;
    window.qcagDesktopCloseTaskDropdown = qcagDesktopCloseTaskDropdown;
    window.qcagDesktopToggleTaskDropdown = qcagDesktopToggleTaskDropdown;
    window.qcagDesktopStartTaskMode = qcagDesktopStartTaskMode;
    window.qcagDesktopExitTaskMode = qcagDesktopExitTaskMode;
    window.qcagOpenTaskGridView = qcagOpenTaskGridCompletionView;
    window.qcagOpenTaskGridCompletionView = qcagOpenTaskGridCompletionView;
    window.qcagCloseTaskGridView = qcagCloseTaskGridView;
    window.qcagTaskGridFinishTask = qcagTaskGridFinishTask;
    window.qcagIsTaskOrderCompleted = qcagIsTaskOrderCompleted;
    window.isTaskOrderCompleted = qcagIsTaskOrderCompleted;
    window.qcagMarkTaskOrderCompleted = qcagMarkTaskOrderCompleted;
    window.qcagTaskBannerOpenLocationsMap = qcagTaskBannerOpenLocationsMap;
    window.qcagTaskBannerExportPdf = qcagTaskBannerExportPdf;
}

/**
 * Mở bản đồ định vị cho đơn hàng đang active trong Task Banner.
 * Ưu tiên dùng _qcagCurrentTaskOrder (set khi vào Task Mode).
 * Delegate hoàn toàn sang openOrderLocationsMap() trong desktop-orders-flow.js.
 */
async function qcagTaskBannerOpenLocationsMap() {
    const order = (typeof _qcagCurrentTaskOrder !== 'undefined' && _qcagCurrentTaskOrder)
        ? _qcagCurrentTaskOrder
        : (typeof window !== 'undefined' ? window._qcagCurrentTaskOrder : null);

    if (!order) {
        if (typeof showToast === 'function') showToast('Chưa có đơn hàng đang hoạt động để định vị.');
        return;
    }

    const orderId = order.id || order.order_no;
    if (!orderId) {
        if (typeof showToast === 'function') showToast('Đơn hàng không có ID hợp lệ để định vị.');
        return;
    }

    // openOrderLocationsMap is defined in desktop-orders-flow.js, loaded globally
    if (typeof openOrderLocationsMap === 'function') {
        await openOrderLocationsMap(String(orderId));
    } else {
        if (typeof showToast === 'function') showToast('Chức năng bản đồ chưa được tải. Vui lòng tải lại trang.');
        console.error('qcagTaskBannerOpenLocationsMap: openOrderLocationsMap not found');
    }
}

/**
 * Xuất PDF thi công cho đơn hàng đang active trong Task Banner.
 * Ưu tiên dùng _qcagCurrentTaskOrder (set khi vào Task Mode).
 * Delegate hoàn toàn sang qcagExportProductionOrderPdf() trong desktop-orders-flow.js.
 */
async function qcagTaskBannerExportPdf() {
    const order = (typeof _qcagCurrentTaskOrder !== 'undefined' && _qcagCurrentTaskOrder)
        ? _qcagCurrentTaskOrder
        : (typeof window !== 'undefined' ? window._qcagCurrentTaskOrder : null);

    if (!order) {
        if (typeof showToast === 'function') showToast('Chưa có đơn hàng đang hoạt động để xuất PDF.');
        return;
    }

    const orderId = order.id || order.order_no;
    if (!orderId) {
        if (typeof showToast === 'function') showToast('Đơn hàng không có ID hợp lệ để xuất PDF.');
        return;
    }

    // qcagExportProductionOrderPdf is defined in desktop-orders-flow.js, loaded globally
    if (typeof qcagExportProductionOrderPdf === 'function') {
        await qcagExportProductionOrderPdf(String(orderId));
    } else {
        if (typeof showToast === 'function') showToast('Chức năng xuất PDF chưa được tải. Vui lòng tải lại trang.');
        console.error('qcagTaskBannerExportPdf: qcagExportProductionOrderPdf not found');
    }
}

// Auto-initialize when loaded
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDesktopTaskFlow);
    } else {
        initDesktopTaskFlow();
    }
}

if (typeof window !== 'undefined') {
    window.qcagParseQuoteItemInfo = qcagParseQuoteItemInfo;
    window.qcagMatchSignageItemsWithQuotes = qcagMatchSignageItemsWithQuotes;
    window.qcagNormalizeSignageType = qcagNormalizeSignageType;
    window.qcagFindMatchingQuoteItem = qcagFindMatchingQuoteItem;
}


