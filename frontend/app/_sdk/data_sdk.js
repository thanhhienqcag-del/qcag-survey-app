// ====================================================================
// _sdk/data_sdk.js - data SDK for KS app (Cloud Run / same-origin)
// ====================================================================
(function () {
  'use strict';

  var _store = [];
  var _onDataChanged = null;
  var _es = null;
  var _lastEtag = null;
  var _activeBase = null;

  // SSE reconnect state
  var _esRetryMs = 1000;
  var _esRetryTimer = null;
  var _esEverConnected = false;
  var _refreshTimer = null;
  var _refreshInFlight = null;
  var _refreshCooldownMs = 2000;
  var _lastRefreshIssuedAt = 0;
  var _rtVisibilityBound = false;
  // Page size 50 ensures super-fast initial payload (~35KB) and < 100ms render on 1,000,000 records
  var _requestsPageSize = 50;
  var _storeMaxRows = 999999;
  var _storeTruncated = false;
  var _storeTotalHint = 0;
  var _lastSyncIso = '';
  var _nextCursor = null;
  var _hasMore = true;
  var _isLoadingMore = false;
  var _pendingFetchPromises = {};
  // Bump cache version after data model / paging fixes to avoid stale local data
  var _cacheStoreKey = 'ks_requests_cache_v2';
  var _cacheSyncKey = 'ks_requests_last_sync_v2';
  var _currentFetchController = null;
  var _currentFetchRequest = null;

  (function _initAdaptiveLimits() {
    try {
      // Không giảm pageSize theo RAM thiết bị — payload nhỏ vì đã strip base64 ảnh.
      // Chỉ cho phép override thủ công qua localStorage nếu cần debug.
      if (typeof localStorage !== 'undefined') {
        var pageOverride = Number(localStorage.getItem('ks_requests_page_size'));
        if (Number.isFinite(pageOverride) && pageOverride > 0) {
          _requestsPageSize = Math.max(10, Math.min(300, Math.floor(pageOverride)));
        }
        var maxRowsOverride = Number(localStorage.getItem('ks_requests_max_rows'));
        if (Number.isFinite(maxRowsOverride) && maxRowsOverride > 0) {
          _storeMaxRows = Math.max(100, Math.floor(maxRowsOverride));
        }
      }
    } catch (_) {}
  })();

  function _withJitter(baseMs, pct) {
    var ms = Number(baseMs);
    if (!(ms > 0)) ms = 1000;
    var ratio = Number(pct);
    if (!(ratio > 0)) ratio = 0.3;
    var spread = Math.floor(ms * ratio);
    if (spread <= 0) return ms;
    return ms + Math.floor((Math.random() * (spread * 2 + 1)) - spread);
  }

  function _clearEsRetry() {
    try { if (_esRetryTimer) { clearTimeout(_esRetryTimer); _esRetryTimer = null; } } catch (e) {}
  }

  function _closeEs() {
    try { if (_es) { _es.close(); } } catch (e) {}
    _es = null;
  }

  function _scheduleRefresh(delayMs, force) {
    // Debounced refresh: coalesce bursts of invalidate events and avoid
    // scheduling a refresh while one is already in-flight.
    var ms = Number(delayMs);
    if (!(ms >= 0)) ms = 1000; // default 1s debounce
    var now = Date.now();
    try {
      if (!force) {
        if (_refreshTimer || _refreshInFlight) return;
        if (_lastRefreshIssuedAt && (now - _lastRefreshIssuedAt) < _refreshCooldownMs) return;
      }
    } catch (e) {}
    if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
    _lastRefreshIssuedAt = now;
    _refreshTimer = setTimeout(function () {
      _refreshTimer = null;
      try {
        if (typeof document !== 'undefined' && document.hidden) return;
        if (window.dataSdk && typeof window.dataSdk.refresh === 'function') {
          window.dataSdk.refresh(Boolean(force)).catch(function (e) {
            console.warn('[dataSdk] scheduled refresh failed', e);
          });
        }
      } catch (e) {}
    }, ms);
  }

  function _openSse() {
    _closeEs();
    if (typeof EventSource === 'undefined') return;
    var url = _buildUrl(_activeBase || '', '/events');
    try {
      _es = new EventSource(url);

      _es.onopen = function () {
        _esRetryMs = 1000; // reset backoff
        _clearEsRetry();
        if (_esEverConnected) {
          // Reconnect after a gap — fetch fresh data to catch any missed events (keep ETag for 304 fast check)
          _scheduleRefresh(400, false);
        }
        _esEverConnected = true;
      };

      _es.addEventListener('invalidate', function (ev) {
        try {
          var payload = ev && ev.data ? JSON.parse(ev.data) : null;
          if (!payload) return;
          _esRetryMs = 1000; // successful message → reset backoff

          // ── Always fire global invalidation hook for ALL resources ──
          if (typeof window.__ksOnInvalidate === 'function') {
            try { window.__ksOnInvalidate(payload); } catch (hookErr) {
              console.warn('[dataSdk] __ksOnInvalidate hook error:', hookErr);
            }
          }

          var resType = String(payload.resource || '').toLowerCase();
          var action = String(payload.action || '').toLowerCase();

          if (!resType || resType === 'ks_requests') {
            var patched = false;
            if (payload.data) {
              var row = _normalizeRequestRow(payload.data);
              var bid = row && row.__backendId;
              if (!bid) {
                if (action === 'delete' && payload.id) {
                  for (var di0 = 0; di0 < _store.length; di0++) {
                    if (String(_store[di0].__backendId || '') === String(payload.id)) {
                      _store.splice(di0, 1);
                      patched = true;
                      break;
                    }
                  }
                  if (patched && _onDataChanged) _onDataChanged(_cloneStoreRows());
                }
                _scheduleRefresh(120, true);
                return;
              }
              if (payload.action === 'create') {
                // New row: add to beginning of store if not already present
                var exists = false;
                for (var pi = 0; pi < _store.length; pi++) {
                  var pItem = _store[pi];
                  if (pItem.__backendId === bid || (pItem.tkCode && row.tkCode && pItem.tkCode === row.tkCode) || (pItem.id && row.id && String(pItem.id) === String(row.id))) {
                    exists = true;
                    _store[pi] = row;
                    break;
                  }
                }
                if (!exists) _store.unshift(row);
                if (_store.length > _storeMaxRows) {
                  _store = _store.slice(0, _storeMaxRows);
                  _storeTruncated = true;
                }
                patched = true;
              } else if (payload.action === 'update' || payload.action === 'upsert') {
                for (var ui = 0; ui < _store.length; ui++) {
                  var uItem = _store[ui];
                  var isMatch = (uItem.__backendId === bid) ||
                    (uItem.id && row.id && String(uItem.id) === String(row.id)) ||
                    (uItem.tkCode && row.tkCode && String(uItem.tkCode) === String(row.tkCode)) ||
                    (payload.id && (String(uItem.__backendId) === String(payload.id) || String(uItem.tkCode) === String(payload.id)));
                  if (isMatch) {
                    for (var key in row) {
                      if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
                      if (_shouldPreserveExistingField(key, row[key], _store[ui][key])) continue;
                      _store[ui][key] = row[key];
                    }
                    patched = true;
                    break;
                  }
                }
              } else if (payload.action === 'delete') {
                for (var di = 0; di < _store.length; di++) {
                  if (_store[di].__backendId === bid) { _store.splice(di, 1); patched = true; break; }
                }
              }
              if (patched && _onDataChanged) {
                _onDataChanged(_cloneStoreRows());
              }
            } else if (action === 'delete' && (payload.id || payload.backendId || payload.tkCode)) {
              var targetId = String(payload.id || '');
              var targetBid = String(payload.backendId || '');
              var targetTk = String(payload.tkCode || '');
              for (var di2 = _store.length - 1; di2 >= 0; di2--) {
                var sItem = _store[di2];
                var sBid = String(sItem.__backendId || '');
                var sId = String(sItem.id || '');
                var sTk = String(sItem.tkCode || '');
                if ((targetId && (sBid === targetId || sId === targetId || sTk === targetId)) ||
                    (targetBid && (sBid === targetBid || sId === targetBid || sTk === targetBid)) ||
                    (targetTk && (sBid === targetTk || sId === targetTk || sTk === targetTk))) {
                  _store.splice(di2, 1);
                  patched = true;
                }
              }
              if (patched) {
                _lastEtag = null;
                _triggerStoreUpdated();
              }
            }

            _scheduleRefresh(150, true);
          } else {
            // For all other resources (quotations, pending_orders, production-orders, etc.)
            _scheduleRefresh(150, true);
          }
        } catch (e) {}
      });

      _es.onerror = function () {
        _closeEs();
        _clearEsRetry();
        if (typeof document !== 'undefined' && document.hidden) return;
        var ms = _withJitter(_esRetryMs, 0.3);
        _esRetryMs = Math.min(30000, Math.floor(_esRetryMs * 1.7));
        _esRetryTimer = setTimeout(function () {
          _esRetryTimer = null;
          _openSse();
        }, ms);
      };

      try {
        window.addEventListener && window.addEventListener('beforeunload', function () {
          _closeEs();
          _clearEsRetry();
        });
      } catch (_) {}

      // Refresh data when tab becomes visible again
      try {
        if (!_rtVisibilityBound) {
          _rtVisibilityBound = true;
          var _idleEsTimer = null;
          document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') {
              // Idle management: Không ngắt SSE ngay lập tức khi chuyển tab chốc lát (tránh reconnect gián đoạn & lag UI)
              // Chỉ ngắt kết nối khi tab bị ẩn liên tục quá 60 giây
              if (_idleEsTimer) clearTimeout(_idleEsTimer);
              _idleEsTimer = setTimeout(function () {
                _clearEsRetry();
                _closeEs();
              }, 60000);
              return;
            }
            if (_idleEsTimer) {
              clearTimeout(_idleEsTimer);
              _idleEsTimer = null;
            }
            // Tab visible lại: kiểm tra SSE và luôn lên lịch refresh nhẹ nhàng (ETag check tốn 0 bytes nếu không đổi)
            if (!_es || _es.readyState === 2 /* CLOSED */) {
              _openSse();
              _scheduleRefresh(200, false);
            } else {
              // Ngay cả khi SSE đang mở, tab vừa quay lại từ nền nên luôn đồng bộ nhanh (coalesce/throttled)
              _scheduleRefresh(200, false);
            }
          });
        }
      } catch (_) {}
    } catch (e) {
      // Schedule a reconnect if EventSource constructor threw
      _clearEsRetry();
      var ctorRetryMs = _withJitter(_esRetryMs, 0.3);
      _esRetryTimer = setTimeout(function () {
        _esRetryTimer = null;
        _openSse();
      }, ctorRetryMs);
    }
  }

  function _normalizeBase(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function _unique(values) {
    var out = [];
    var seen = {};
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (seen[v]) continue;
      seen[v] = true;
      out.push(v);
    }
    return out;
  }

  // Priority candidates for backend base URL:
  // 1) runtime env BACKEND_URL (if valid external Production backend)
  // 2) Production Cloud Run backend (ks-backend)
  function _getBaseCandidates() {
    var prodBase = 'https://ks-backend-493469512136.asia-southeast1.run.app';
    var candidates = [];
    try {
      var override = '';
      try {
        override = (localStorage.getItem('ks_backend_url') || '').trim();
        if (override && override.includes('-staging')) {
          localStorage.removeItem('ks_backend_url');
          override = '';
        }
      } catch (_) {}
      if (override) candidates.push(_normalizeBase(override));

      if (window.__env && typeof window.__env.BACKEND_URL !== 'undefined') {
        var be = String(window.__env.BACKEND_URL || '').trim();
        if (be && !be.includes(':3000') && !be.includes(':3101') && !be.includes('-staging')) {
          candidates.push(_normalizeBase(be));
        }
      }
      if (typeof window.API_BASE_URL !== 'undefined') {
        var apiB = String(window.API_BASE_URL || '').trim();
        if (apiB && !apiB.includes(':3000') && !apiB.includes(':3101') && !apiB.includes('-staging')) {
          candidates.push(_normalizeBase(apiB));
        }
      }
      if (window.__env && Array.isArray(window.__env.BACKEND_URL_CANDIDATES)) {
        window.__env.BACKEND_URL_CANDIDATES.forEach(function (c) {
          var s = String(c || '').trim();
          if (s && !s.includes(':3000') && !s.includes(':3101') && !s.includes('-staging')) {
            candidates.push(_normalizeBase(s));
          }
        });
      }
      candidates.push(prodBase);
    } catch (e) {}
    return _unique(candidates.filter(Boolean));
  }

  function _buildUrl(base, path) {
    var b = _normalizeBase(base);
    return (b ? b : '') + path;
  }

  function _saveCache() {
    // 1. Primary storage: IndexedDB (supports 10,000+ items without 5MB quota cap)
    try {
      if (typeof window !== 'undefined' && window.ksIdb && window.ksIdb.isSupported()) {
        window.ksIdb.setAll(_store);
        if (_lastEtag) window.ksIdb.setMeta('etag', _lastEtag);
        var syncIso = _lastSyncIso || _latestStoreTimestampIso();
        if (syncIso) window.ksIdb.setMeta('lastSync', syncIso);
      }
    } catch (e) {
      console.warn('[dataSdk] IndexedDB save warning:', e);
    }

    // 2. Metadata fallback in localStorage
    try {
      if (typeof localStorage === 'undefined') return;
      var syncIso = _lastSyncIso || _latestStoreTimestampIso();
      if (syncIso) localStorage.setItem(_cacheSyncKey, syncIso);
    } catch (_) {}
  }

  async function _loadCacheAsync() {
    // 1. Try loading full catalog from IndexedDB
    try {
      if (typeof window !== 'undefined' && window.ksIdb && window.ksIdb.isSupported()) {
        var rows = await window.ksIdb.getAll();
        if (Array.isArray(rows) && rows.length > 0) {
          // Filter out any stale deleted/cancelled requests immediately upon cache load
          rows = rows.filter(function (r) {
            return !r.isDeleted && !r.is_deleted && r.deleteStatus !== 'approved' && r.delete_status !== 'approved' && r.status !== 'cancelled' && r.status !== 'deleted';
          });
          _store = _normalizeRequestRows(rows);
          _storeTruncated = false;
          _storeTotalHint = _store.length;
          var etag = await window.ksIdb.getMeta('etag');
          if (etag) _lastEtag = etag;
          var lastSync = await window.ksIdb.getMeta('lastSync');
          if (lastSync) _lastSyncIso = lastSync;
          console.log('[dataSdk] Restored ' + _store.length + ' requests instantly from IndexedDB cache.');
          return;
        }
      }
    } catch (e) {
      console.warn('[dataSdk] IndexedDB read failed, fallback to localStorage:', e);
    }

    // 2. Fallback: localStorage
    _loadCache();
  }

  function _loadCache() {
    try {
      if (typeof localStorage === 'undefined') return;
      var raw = localStorage.getItem(_cacheStoreKey);
      if (!raw) return;
      var payload = JSON.parse(raw);
      if (payload && Array.isArray(payload.store)) {
        _store = _normalizeRequestRows(payload.store).slice(0, _storeMaxRows);
        _storeTruncated = _store.length >= _storeMaxRows;
        _storeTotalHint = _store.length;
      }
      var savedLastSync = String(localStorage.getItem(_cacheSyncKey) || (payload && payload.lastSync) || '').trim();
      if (savedLastSync) {
        _lastSyncIso = savedLastSync;
      }
    } catch (_) {
      _store = [];
      _lastSyncIso = '';
    }
  }

  function _setLastSyncIso(iso) {
    if (!iso || typeof iso !== 'string') return;
    _lastSyncIso = iso;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(_cacheSyncKey, iso);
      }
      if (typeof window !== 'undefined' && window.ksIdb) {
        window.ksIdb.setMeta('lastSync', iso);
      }
    } catch (_) {}
  }

  var _lastFullReconcileAt = 0;
  var _lastServerTs = '';

  function _triggerStoreUpdated(explicitSyncIso) {
    _setLastSyncIso(explicitSyncIso || _lastServerTs || _latestStoreTimestampIso());
    _saveCache();
    if (_onDataChanged) {
      _onDataChanged(_cloneStoreRows());
    }
  }

  function _fetchWithDedup(url, options) {
    if (!url) return fetch(url, options || {});
    if (_pendingFetchPromises[url]) {
      return _pendingFetchPromises[url];
    }
    _abortInFlightFetch();
    var fetchOptions = _createFetchOptions(options);
    var promise = fetch(url, fetchOptions).finally(function () {
      if (_pendingFetchPromises[url] === promise) {
        delete _pendingFetchPromises[url];
      }
    });
    _pendingFetchPromises[url] = promise;
    return promise;
  }

  function _abortInFlightFetch() {
    try {
      if (_currentFetchController) {
        _currentFetchController.abort();
      }
    } catch (_) {}
    _currentFetchController = null;
    _currentFetchRequest = null;
  }

  function _createFetchOptions(options) {
    options = options || {};
    _abortInFlightFetch();
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (controller) {
      _currentFetchController = controller;
      _currentFetchRequest = controller.signal;
      return Object.assign({}, options, { signal: controller.signal });
    }
    return options;
  }

  function _logApiRequest(endpoint, rows, sizeBytes, durationMs) {
    try {
      var sizeKb = Math.round(Number(sizeBytes || 0) / 1024);
      console.log('[APP2 FETCH] endpoint=' + endpoint + ' | rows=' + rows + ' | sizeKB=' + sizeKb + ' | duration=' + durationMs + 'ms');
    } catch (_) {}
  }

  function _latestStoreTimestampIso() {
    try {
      var maxTs = 0;
      for (var i = 0; i < _store.length; i++) {
        var row = _store[i] || {};
        var tsRaw = row.updatedAt || row.createdAt || row.updated_at || row.created_at;
        if (!tsRaw) continue;
        var ts = Date.parse(String(tsRaw));
        if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
      }
      return maxTs > 0 ? new Date(maxTs).toISOString() : '';
    } catch (_) {
      return '';
    }
  }

  async function _isHealthyBase(base) {
    if (!base || base.includes(':3000')) return false;
    var url = _buildUrl(base, '/api/ks/health');
    var healthDirectUrl = _buildUrl(base, '/health');
    try {
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 1500) : null;
      var res = await fetch(url, { method: 'GET', signal: controller ? controller.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!res || !res.ok) {
        var resDirect = await fetch(healthDirectUrl, { method: 'GET' });
        if (!resDirect || !resDirect.ok) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async function _ensureActiveBase() {
    if (_activeBase && await _isHealthyBase(_activeBase)) {
      return _activeBase;
    }

    var candidates = _getBaseCandidates();
    for (var i = 0; i < candidates.length; i++) {
      if (await _isHealthyBase(candidates[i])) {
        _activeBase = candidates[i];
        return _activeBase;
      }
    }

    // last resort
    _activeBase = candidates[0] || '';
    return _activeBase;
  }

  function _getSaleQueryParams() {
    var _saleExtra = '';
    try {
      var _ses = JSON.parse(localStorage.getItem('ks_session') || 'null');
      if (!_ses && typeof window !== 'undefined' && window.currentSession) _ses = window.currentSession;
      var _isInternalQcag = _ses && (_ses.is_internal === true || String(_ses.company || '').toUpperCase() === 'QCAG' || ['qcag', 'admin', 'operator', 'design'].indexOf(String(_ses.role || '').toLowerCase()) !== -1);
      if (_ses && !_isInternalQcag) {
        var _phone = _ses.phone || _ses.salePhone || _ses.userPhone || '';
        var _code = _ses.saleCode || _ses.userCode || _ses.code || '';
        if (_phone) _saleExtra += '&sale_phone=' + encodeURIComponent(String(_phone).trim());
        if (_code) _saleExtra += '&sale_code=' + encodeURIComponent(String(_code).trim());
      }
    } catch (_) {}
    return _saleExtra;
  }

  function _getActiveUserKey() {
    try {
      var _ses = JSON.parse(localStorage.getItem('ks_session') || 'null');
      if (!_ses && typeof window !== 'undefined' && window.currentSession) _ses = window.currentSession;
      if (!_ses) return 'anonymous';
      var role = String(_ses.role || '').toLowerCase();
      if (role === 'qcag' || role === 'admin') return 'qcag_' + (_ses.phone || _ses.name || 'internal');
      var code = String(_ses.saleCode || _ses.userCode || _ses.code || '').trim().toLowerCase();
      var phone = String(_ses.phone || _ses.salePhone || '').replace(/\D/g, '');
      return 'sale_' + (code || phone || 'guest');
    } catch (_) {
      return 'anonymous';
    }
  }

  async function _fetchStore(forceFresh) {
    var headers = {};
    if (!forceFresh && _lastEtag) headers['If-None-Match'] = _lastEtag;
    var errLast = null;
    var candidates = _unique([_activeBase].concat(_getBaseCandidates()).filter(function (x) { return x != null; }));
    _storeTruncated = false;
    _storeTotalHint = 0;
    if (!_activeBase) await _ensureActiveBase();

    for (var i = 0; i < candidates.length; i++) {
      var base = candidates[i];
      var endpoint = _buildUrl(base, '/api/ks/requests');
      try {
        var _saleExtra = _getSaleQueryParams();
        var isQcagOrAll = !_saleExtra;
        var firstUrl = endpoint + (isQcagOrAll ? '?all=1&lite=1' : ('?' + _saleExtra.slice(1) + '&all=1&lite=1'));
        var startTime = Date.now();
        var res = await _fetchWithDedup(firstUrl, { headers: headers });
        if (res.status === 304) {
          _activeBase = base;
          console.log('[dataSdk] 304 Not Modified — 0 bytes transfer! Serving from fast cache.');
          return { notModified: true };
        }
        if (!res.ok) {
          errLast = new Error('HTTP ' + res.status + ' from ' + endpoint);
          continue;
        }
        var responseText = await res.clone().text();
        var body = JSON.parse(responseText);
        _logApiRequest(firstUrl, Array.isArray(body.data) ? body.data.length : 0, responseText.length, Date.now() - startTime);
        var etag = res.headers.get('ETag');
        if (etag) {
          _lastEtag = etag;
          if (typeof window !== 'undefined' && window.ksIdb) {
            window.ksIdb.setMeta('etag', etag);
          }
        }
        if (body && typeof body.server_ts === 'string' && body.server_ts) {
          _lastServerTs = body.server_ts;
        }
        var allRows = Array.isArray(body.data) ? _normalizeRequestRows(body.data) : [];
        var paging = body.paging || null;
        _nextCursor = (paging && paging.nextCursor) || null;
        _hasMore = paging && typeof paging.hasMore === 'boolean' ? paging.hasMore : (allRows.length === _requestsPageSize);
        var totalHint = Number(paging && paging.total);
        if (!(totalHint >= 0)) totalHint = allRows.length;
        _storeTotalHint = totalHint;
        if (totalHint > allRows.length) {
          _storeTruncated = true;
        }

        if (allRows.length > _storeMaxRows) {
          allRows = allRows.slice(0, _storeMaxRows);
          _storeTruncated = true;
        }

        _activeBase = base;
        return allRows;
      } catch (e) {
        errLast = e;
      }
    }

    throw errLast || new Error('Failed to fetch /api/ks/requests');
  }

  async function _fetchJsonWithRetry(path, options, allowNotOk) {
    var errLast = null;
    var candidates = _unique([_activeBase].concat(_getBaseCandidates()).filter(function (x) { return x != null; }));

    for (var i = 0; i < candidates.length; i++) {
      var base = candidates[i];
      var url = _buildUrl(base, path);
      try {
        var res = await fetch(url, options || {});
        var body = null;
        try {
          body = await res.json();
        } catch (_) {}

        if (!res.ok) {
          if (body && (body.message || body.error)) {
            var apiErr = new Error(body.message || body.error);
            apiErr.status = res.status;
            apiErr.body = body;
            throw apiErr;
          }
          if (allowNotOk) return { ok: false, status: res.status, base: base, body: body };
          errLast = new Error('HTTP ' + res.status + ' from ' + url);
          continue;
        }
        _activeBase = base;
        return { ok: true, status: res.status, base: base, body: body };
      } catch (e) {
        if (e && e.body) throw e;
        errLast = e;
      }
    }

    throw errLast || new Error('Request failed for ' + path);
  }

  var _pollTimer = null;
  function _startBackgroundPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
    // Backup heartbeat polling every 60s ONLY when SSE is dropped/inactive
    _pollTimer = setInterval(function () {
      try {
        if (typeof document !== 'undefined' && document.hidden) return;
        var sseActive = _es && _es.readyState === 1 /* OPEN */;
        if (!sseActive) {
          _openSse();
          if (window.dataSdk && typeof window.dataSdk.refresh === 'function') {
            window.dataSdk.refresh().catch(function () {});
          }
        }
      } catch (_) {}
    }, 60000);
    if (_pollTimer && _pollTimer.unref) _pollTimer.unref();
  }

  function _cloneStoreRows() {
    return _store.map(function (x) { return Object.assign({}, x); });
  }

  function _safeParseJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try { return JSON.parse(value) || []; } catch (e) { return []; }
  }

  function _deriveTkCodeFromRow(row) {
    if (!row || row.id == null) return null;
    var idNum = Number(row.id);
    if (!Number.isFinite(idNum) || idNum <= 0) return null;
    var tsRaw = row.createdAt || row.created_at || row.updatedAt || row.updated_at;
    var dt = tsRaw ? new Date(tsRaw) : new Date();
    if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) dt = new Date();
    var yy = String(dt.getFullYear()).slice(-2);
    return 'TK' + yy + '.' + String(Math.floor(idNum)).padStart(5, '0');
  }

  function _normalizeRequestRow(row) {
    if (!row || typeof row !== 'object') return row;
    var normalized = Object.assign({}, row);

    if (!normalized.__backendId) {
      normalized.__backendId = normalized.backend_id || normalized.backendId || (normalized.id != null ? ('db_' + normalized.id) : '');
    }
    if (!normalized.outletCode && normalized.outlet_code != null) normalized.outletCode = normalized.outlet_code;
    if (!normalized.outletName && normalized.outlet_name != null) normalized.outletName = normalized.outlet_name;
    if (!normalized.outletLat && normalized.outlet_lat != null) normalized.outletLat = normalized.outlet_lat;
    if (!normalized.outletLng && normalized.outlet_lng != null) normalized.outletLng = normalized.outlet_lng;
    if (!normalized.oldContentExtra && normalized.old_content_extra != null) normalized.oldContentExtra = normalized.old_content_extra;
    if (normalized.oldContent == null && normalized.old_content != null) normalized.oldContent = normalized.old_content;
    if (!normalized.statusImages && normalized.status_images != null) normalized.statusImages = normalized.status_images;
    if (!normalized.designImages && normalized.design_images != null) normalized.designImages = normalized.design_images;
    if (!normalized.acceptanceImages && normalized.acceptance_images != null) normalized.acceptanceImages = normalized.acceptance_images;
    if (!normalized.editingRequestedAt && normalized.editing_requested_at != null) normalized.editingRequestedAt = normalized.editing_requested_at;
    if (!normalized.createdAt && normalized.created_at != null) normalized.createdAt = normalized.created_at;
    if (!normalized.updatedAt && normalized.updated_at != null) normalized.updatedAt = normalized.updated_at;
    if (!normalized.outletPhone) {
      normalized.outletPhone = normalized.outlet_phone || normalized.outletPhone || normalized.outletContactPhone || normalized.phone || '';
    }
    if (!normalized.tkCode) normalized.tkCode = normalized.tk_code || normalized.code || null;
    if (!normalized.tkCode) normalized.tkCode = _deriveTkCodeFromRow(normalized);
    if (!normalized.region && normalized.region != null) normalized.region = normalized.region;
    if (!normalized.region && normalized.requester) {
      try {
        var _reqObj = typeof normalized.requester === 'string' ? JSON.parse(normalized.requester) : normalized.requester;
        if (_reqObj && _reqObj.region) normalized.region = _reqObj.region;
      } catch (_) {}
    }

    if (normalized.deleteRequested == null && normalized.delete_requested != null) {
      normalized.deleteRequested = Boolean(normalized.delete_requested);
    }
    if (!normalized.deleteReason && normalized.delete_reason != null) normalized.deleteReason = normalized.delete_reason;
    if (!normalized.deleteRequestedAt && normalized.delete_requested_at != null) normalized.deleteRequestedAt = normalized.delete_requested_at;
    if (!normalized.deleteRequestedBy && normalized.delete_requested_by != null) normalized.deleteRequestedBy = normalized.delete_requested_by;
    if (!normalized.deleteRequestedPhone && normalized.delete_requested_phone != null) normalized.deleteRequestedPhone = normalized.delete_requested_phone;
    if (!normalized.deleteRequestedSaleCode && normalized.delete_requested_sale_code != null) normalized.deleteRequestedSaleCode = normalized.delete_requested_sale_code;
    if (!normalized.deleteStatus && normalized.delete_status != null) normalized.deleteStatus = normalized.delete_status;
    if (!normalized.deleteRejectReason && normalized.delete_reject_reason != null) normalized.deleteRejectReason = normalized.delete_reject_reason;
    if (!normalized.quoteCode && (normalized.quote_code != null || normalized.quoteCode != null)) {
      normalized.quoteCode = normalized.quoteCode || normalized.quote_code;
    }
    if (!normalized.totalAmount && (normalized.total_amount != null || normalized.totalAmount != null)) {
      normalized.totalAmount = Number(normalized.totalAmount || normalized.total_amount || 0);
    }
    if (!normalized.bridge && (normalized.quoteCode || normalized.quote_code)) {
      var qc = normalized.quoteCode || normalized.quote_code;
      normalized.bridge = {
        quote_code: qc,
        quoteCode: qc,
        total_amount: Number(normalized.totalAmount || normalized.total_amount || 0),
        totalAmount: Number(normalized.totalAmount || normalized.total_amount || 0),
        spo_status: normalized.spo_status || normalized.spoStatus || 'Chưa có SPO',
        production_approval_status: normalized.production_approval_status || normalized.productionApprovalStatus || ''
      };
    }

    return normalized;
  }

  function _normalizeRequestRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(_normalizeRequestRow);
  }

  function _shouldPreserveExistingField(key, incoming, existing) {
    var protectedFields = {
      content: true,
      oldContentExtra: true,
      statusImages: true,
      designImages: true,
      acceptanceImages: true,
      comments: true,
      items: true
    };
    if (!protectedFields[key]) return false;
    if (incoming == null) return String(existing || '').trim().length > 0;
    if ((key === 'content' || key === 'oldContentExtra') && String(incoming).trim() === '' && String(existing || '').trim().length > 0) {
      return true;
    }
    if (key === 'items') {
      var hasValidItems = function (val) {
        if (!val) return false;
        if (Array.isArray(val)) return val.length > 0;
        if (typeof val === 'string') {
          var t = val.trim();
          return t !== '' && t !== '[]' && t !== 'null';
        }
        return false;
      };
      return !hasValidItems(incoming) && hasValidItems(existing);
    }
    if ((key === 'statusImages' || key === 'designImages' || key === 'acceptanceImages' || key === 'comments') && typeof incoming === 'string') {
      var trimmed = String(incoming).trim();
      if (trimmed === '[]' || trimmed === '["..."]') {
        var existingArr = _safeParseJsonArray(existing);
        return existingArr.length > 0 && !(existingArr.length === 1 && String(existingArr[0] || '').trim() === '...');
      }
    }
    return false;
  }

  function _isActiveProcessingRow(r) {
    if (!r) return false;
    var st = String(r.status || 'pending').trim().toLowerCase();
    var isDone = (st === 'done' || st === 'processed' || st === 'quoted' || st === 'completed' || st === 'cancelled');
    if (!isDone) return true;
    if (r.editingRequestedAt) return true;
    return false;
  }

  function _collectRowKeys(row, outSet) {
    if (!row || !outSet) return;
    if (row.__backendId) outSet[String(row.__backendId)] = true;
    if (row.id) outSet[String(row.id)] = true;
    if (row.tkCode) outSet[String(row.tkCode)] = true;
    if (row.tk_code) outSet[String(row.tk_code)] = true;
  }

  function _purgeStoreByKeys(keys) {
    var list = Array.isArray(keys) ? keys : [];
    if (!list.length) return false;
    var targetMap = {};
    for (var i = 0; i < list.length; i++) {
      var k = String(list[i] || '').trim();
      if (k) targetMap[k] = true;
    }
    var removedKeysMap = {};
    Object.keys(targetMap).forEach(function (k) { removedKeysMap[k] = true; });
    var changed = false;
    for (var s = _store.length - 1; s >= 0; s--) {
      var item = _store[s];
      if (!item || item._isOfflinePending) continue;
      var sBid = String(item.__backendId || '');
      var sId = String(item.id || '');
      var sTk = String(item.tkCode || item.tk_code || '');
      if ((sBid && targetMap[sBid]) || (sId && targetMap[sId]) || (sTk && targetMap[sTk])) {
        _collectRowKeys(item, removedKeysMap);
        _store.splice(s, 1);
        changed = true;
      }
    }
    var delKeyArr = Object.keys(removedKeysMap);
    if (delKeyArr.length > 0 && typeof window !== 'undefined' && window.ksIdb && typeof window.ksIdb.deleteKeys === 'function') {
      window.ksIdb.deleteKeys(delKeyArr);
    }
    return changed;
  }

  function _mergeLatestRows(latestRows) {
    var incoming = Array.isArray(latestRows) ? latestRows : [];
    if (!incoming.length) return false;
    var changed = false;
    var indexById = {};
    for (var i = 0; i < _store.length; i++) {
      var row = _store[i] || {};
      var id = row.__backendId || row.id;
      if (id != null) indexById[String(id)] = i;
      if (row.tkCode) indexById[String(row.tkCode)] = i;
    }

    var toAdd = [];
    var addedKeys = {};
    var validIncoming = [];
    var deletedKeysMap = {};

    for (var j = 0; j < incoming.length; j++) {
      var next = incoming[j] || {};
      var nid = next.__backendId || next.id || next.tkCode || next.tk_code;
      if (nid == null) continue;
      var key = String(nid);
      var tkKey = String(next.tkCode || next.tk_code || '');

      // Tombstone handler: If server reports this request is deleted / approved-for-delete / cancelled, purge it from local store & IDB
      if (next.is_deleted === true || next.isDeleted === true || next.delete_status === 'approved' || next.deleteStatus === 'approved' || next.status === 'cancelled' || next.status === 'deleted') {
        _collectRowKeys(next, deletedKeysMap);
        for (var di = _store.length - 1; di >= 0; di--) {
          var sItem = _store[di];
          if (!sItem) continue;
          var sBid = String(sItem.__backendId || sItem.id || '');
          var sTk = String(sItem.tkCode || sItem.tk_code || '');
          if ((key && sBid === key) || (tkKey && sTk && tkKey === sTk) || (tkKey && sBid === tkKey)) {
            _collectRowKeys(sItem, deletedKeysMap);
            _store.splice(di, 1);
            changed = true;
          }
        }
        continue;
      }

      validIncoming.push(next);
      var matchedIdx = Object.prototype.hasOwnProperty.call(indexById, key)
        ? indexById[key]
        : (tkKey && Object.prototype.hasOwnProperty.call(indexById, tkKey) ? indexById[tkKey] : -1);

      if (matchedIdx !== -1) {
        var prev = _store[matchedIdx] || {};
        var merged = Object.assign({}, prev);
        var rowChanged = false;
        for (var field in next) {
          if (!Object.prototype.hasOwnProperty.call(next, field)) continue;
          if (_shouldPreserveExistingField(field, next[field], prev[field])) continue;
          if (prev[field] !== next[field]) {
            merged[field] = next[field];
            rowChanged = true;
          }
        }
        if (rowChanged) {
          _store[matchedIdx] = merged;
          changed = true;
        }
      } else {
        if (!addedKeys[key] && (!tkKey || !addedKeys[tkKey])) {
          addedKeys[key] = true;
          if (tkKey) addedKeys[tkKey] = true;
          toAdd.push(next);
          changed = true;
        }
      }
    }

    if (toAdd.length > 0) {
      _store = toAdd.concat(_store);
    }

    if (_store.length > _storeMaxRows) {
      _store = _store.slice(0, _storeMaxRows);
      _storeTruncated = true;
      changed = true;
    }

    var deletedKeyArr = Object.keys(deletedKeysMap);
    if (typeof window !== 'undefined' && window.ksIdb) {
      if (deletedKeyArr.length > 0 && typeof window.ksIdb.deleteKeys === 'function') {
        window.ksIdb.deleteKeys(deletedKeyArr);
      }
      if (changed && validIncoming.length > 0 && typeof window.ksIdb.upsertMany === 'function') {
        window.ksIdb.upsertMany(validIncoming);
      }
    }
    return changed;
  }

  function _pruneStoreWithAuthoritativeCatalog(incomingRows) {
    var normalizedIncoming = _normalizeRequestRows(Array.isArray(incomingRows) ? incomingRows : []);
    var activeKeys = {};
    for (var ak = 0; ak < normalizedIncoming.length; ak++) {
      _collectRowKeys(normalizedIncoming[ak], activeKeys);
    }
    var pruned = false;
    var removedKeysMap = {};
    for (var pi = _store.length - 1; pi >= 0; pi--) {
      var pItem = _store[pi];
      if (!pItem || pItem._isOfflinePending) continue;
      var pBid = pItem.__backendId ? String(pItem.__backendId) : '';
      var pId = pItem.id ? String(pItem.id) : '';
      var pTk = pItem.tkCode ? String(pItem.tkCode) : (pItem.tk_code ? String(pItem.tk_code) : '');
      var isPresent = (pBid && activeKeys[pBid]) || (pId && activeKeys[pId]) || (pTk && activeKeys[pTk]);
      if (!isPresent) {
        _collectRowKeys(pItem, removedKeysMap);
        _store.splice(pi, 1);
        pruned = true;
      }
    }
    var removedArr = Object.keys(removedKeysMap);
    if (removedArr.length > 0 && typeof window !== 'undefined' && window.ksIdb && typeof window.ksIdb.deleteKeys === 'function') {
      window.ksIdb.deleteKeys(removedArr);
    }
    var mergedChanged = _mergeLatestRows(normalizedIncoming);
    return Boolean(mergedChanged || pruned);
  }

  async function _fetchRequestsByIds(ids) {
    if (_getSaleQueryParams()) return { rows: [], deletedIds: [] };
    var uniqueIds = _unique((Array.isArray(ids) ? ids : []).map(function (x) { return String(x || '').trim(); }).filter(Boolean));
    if (!uniqueIds.length) return { rows: [], deletedIds: [] };
    if (!_activeBase) await _ensureActiveBase();
    var candidates = _unique([_activeBase].concat(_getBaseCandidates()).filter(function (x) { return x != null; }));
    var allRows = [];
    var allDeletedIds = [];

    for (var c = 0; c < uniqueIds.length; c += 200) {
      var chunk = uniqueIds.slice(c, c + 200);
      var chunkDone = false;
      for (var i = 0; i < candidates.length && !chunkDone; i++) {
        var base = candidates[i];
        var endpoint = _buildUrl(base, '/api/ks/requests');
        var url = endpoint + '?ids=' + encodeURIComponent(chunk.join(',')) + '&lite=1';
        try {
          var startTime = Date.now();
          var res = await _fetchWithDedup(url, {});
          if (!res.ok) continue;
          var responseText = await res.clone().text();
          var body = JSON.parse(responseText);
          _logApiRequest(url, Array.isArray(body.data) ? body.data.length : 0, responseText.length, Date.now() - startTime);
          if (!body || !body.ok) continue;
          _activeBase = base;
          if (Array.isArray(body.data) && body.data.length) {
            allRows = allRows.concat(_normalizeRequestRows(body.data));
          }
          if (Array.isArray(body.deleted_ids) && body.deleted_ids.length) {
            allDeletedIds = allDeletedIds.concat(body.deleted_ids);
          }
          chunkDone = true;
        } catch (_) {}
      }
    }
    return { rows: allRows, deletedIds: allDeletedIds };
  }

  async function _reconcileWithServerMeta(meta) {
    if (!meta || _getSaleQueryParams()) return false;
    var changed = false;

    if (Array.isArray(meta.tombstones) && meta.tombstones.length > 0) {
      if (_purgeStoreByKeys(meta.tombstones)) changed = true;
    }

    if (!Array.isArray(meta.activeProcessingIds)) {
      return changed;
    }

    var serverActiveMap = {};
    for (var sa = 0; sa < meta.activeProcessingIds.length; sa++) {
      var sid = String(meta.activeProcessingIds[sa] || '').trim();
      if (sid) serverActiveMap[sid] = true;
    }

    var localByKey = {};
    var offlineCount = 0;
    for (var li = 0; li < _store.length; li++) {
      var lr = _store[li];
      if (!lr) continue;
      if (lr._isOfflinePending) offlineCount++;
      if (lr.tkCode) localByKey[String(lr.tkCode)] = lr;
      if (lr.id) localByKey[String(lr.id)] = lr;
      if (lr.__backendId) localByKey[String(lr.__backendId)] = lr;
    }

    var diffMap = {};
    // 1) Server active items missing locally OR locally stale as 'done'
    for (var sIdx = 0; sIdx < meta.activeProcessingIds.length; sIdx++) {
      var serverKey = String(meta.activeProcessingIds[sIdx] || '').trim();
      if (!serverKey) continue;
      var localMatch = localByKey[serverKey];
      if (!localMatch || !_isActiveProcessingRow(localMatch)) {
        diffMap[serverKey] = true;
      }
    }
    // 2) Locally active items absent from server active list (finished or deleted on server)
    for (var rIdx = 0; rIdx < _store.length; rIdx++) {
      var sr = _store[rIdx];
      if (!sr || sr._isOfflinePending) continue;
      if (_isActiveProcessingRow(sr)) {
        var rTk = String(sr.tkCode || '');
        var rId = String(sr.id || '');
        var rBid = String(sr.__backendId || '');
        var inServerActive = (rTk && serverActiveMap[rTk]) || (rId && serverActiveMap[rId]) || (rBid && serverActiveMap[rBid]);
        if (!inServerActive) {
          var pickKey = rTk || rId || rBid;
          if (pickKey) diffMap[pickKey] = true;
        }
      }
    }

    var diffIds = Object.keys(diffMap);
    var comparableLen = Math.max(0, _store.length - offlineCount);
    var countDrift = (typeof meta.totalActive === 'number') ? Math.abs(comparableLen - meta.totalActive) : 0;

    if (diffIds.length > 0 && diffIds.length <= 150) {
      var batchRes = await _fetchRequestsByIds(diffIds);
      if (batchRes.deletedIds && batchRes.deletedIds.length > 0) {
        if (_purgeStoreByKeys(batchRes.deletedIds)) changed = true;
      }
      if (batchRes.rows && batchRes.rows.length > 0) {
        if (_mergeLatestRows(batchRes.rows)) changed = true;
      }
      // Recount drift after targeted batch repair before deciding if full historical catalog heal is still required
      offlineCount = _store.filter(function (x) { return x && x._isOfflinePending; }).length;
      comparableLen = Math.max(0, _store.length - offlineCount);
      countDrift = (typeof meta.totalActive === 'number') ? Math.abs(comparableLen - meta.totalActive) : 0;
    }

    var needFullHeal = (diffIds.length > 150) || (countDrift > 0);
    if (needFullHeal && (!_lastFullReconcileAt || (Date.now() - _lastFullReconcileAt) > 120000)) {
      _lastFullReconcileAt = Date.now();
      try {
        console.log('[dataSdk] Full catalog self-heal triggered (diff=' + diffIds.length + ', countDrift=' + countDrift + ')');
        var fullRows = await _fetchStore(true);
        if (Array.isArray(fullRows) && fullRows.length) {
          if (_pruneStoreWithAuthoritativeCatalog(fullRows)) changed = true;
        }
      } catch (healErr) {
        console.warn('[dataSdk] Full self-heal skipped:', healErr);
      }
    }

    return changed;
  }

  async function _fetchIncrementalStore() {
    var errLast = null;
    var candidates = _unique([_activeBase].concat(_getBaseCandidates()).filter(function (x) { return x != null; }));
    var sinceIso = _lastSyncIso || _latestStoreTimestampIso();
    if (!sinceIso) {
      return { rows: [], tombstones: [], activeProcessingIds: null, totalActive: null, serverTs: null };
    }
    try {
      var dt = new Date(sinceIso);
      dt.setTime(dt.getTime() - 5 * 60 * 1000); // 5 minutes overlap for safety
      sinceIso = dt.toISOString();
    } catch (_) {}
    var _saleExtra = _getSaleQueryParams();
    var isInternalUser = !_saleExtra;
    for (var i = 0; i < candidates.length; i++) {
      var base = candidates[i];
      var endpoint = _buildUrl(base, '/api/ks/requests');
      var url = isInternalUser
        ? (endpoint + '?updated_since=' + encodeURIComponent(sinceIso) + '&lite=1&include_meta=1')
        : (endpoint + '?updated_since=' + encodeURIComponent(sinceIso) + '&limit=' + encodeURIComponent(String(_requestsPageSize)) + '&lite=1' + _saleExtra);
      try {
        var startTime = Date.now();
        var res = await _fetchWithDedup(url, {});
        if (!res.ok) {
          errLast = new Error('HTTP ' + res.status + ' from ' + url);
          continue;
        }
        var responseText = await res.clone().text();
        var body = JSON.parse(responseText);
        _logApiRequest(url, Array.isArray(body.data) ? body.data.length : 0, responseText.length, Date.now() - startTime);
        if (!body || !body.ok) throw new Error((body && body.error) || 'fetch_failed');
        _activeBase = base;
        if (typeof body.server_ts === 'string' && body.server_ts) {
          _lastServerTs = body.server_ts;
        }
        return {
          rows: Array.isArray(body.data) ? _normalizeRequestRows(body.data) : [],
          tombstones: Array.isArray(body.tombstones) ? body.tombstones : [],
          activeProcessingIds: Array.isArray(body.active_processing_ids) ? body.active_processing_ids : null,
          totalActive: typeof body.total_active === 'number' ? body.total_active : null,
          serverTs: typeof body.server_ts === 'string' ? body.server_ts : null
        };
      } catch (e) {
        errLast = e;
      }
    }
    if (errLast) throw errLast;
    return { rows: [], tombstones: [], activeProcessingIds: null, totalActive: null, serverTs: null };
  }

  window.dataSdk = {
    async clearUserCache() {
      _store = [];
      _lastSyncIso = '';
      _lastEtag = null;
      _storeTruncated = false;
      _storeTotalHint = 0;
      try { localStorage.removeItem(_cacheStoreKey); } catch (_) {}
      try { localStorage.removeItem(_cacheSyncKey); } catch (_) {}
      try { localStorage.removeItem('ks_requests'); } catch (_) {}
      try { localStorage.removeItem('ks_cached_user'); } catch (_) {}
      try {
        if (typeof window !== 'undefined' && window.ksIdb && typeof window.ksIdb.clearAll === 'function') {
          await window.ksIdb.clearAll();
        }
      } catch (_) {}
    },

    async init(opts) {
      opts = opts || {};
      _onDataChanged = opts.onDataChanged || null;
      try {
        var activeUser = _getActiveUserKey();
        var cachedUser = '';
        try { cachedUser = localStorage.getItem('ks_cached_user') || ''; } catch (_) {}
        if (activeUser !== 'anonymous' && cachedUser && activeUser !== cachedUser) {
          console.log('[dataSdk] Detected user account switch (' + cachedUser + ' -> ' + activeUser + '). Resetting local cache.');
          await this.clearUserCache();
        }
        try { if (activeUser !== 'anonymous') localStorage.setItem('ks_cached_user', activeUser); } catch (_) {}

        // Step 1: Instant load from IndexedDB (0ms UI latency, displays 100% of cached requests)
        await _loadCacheAsync();
        if (_store.length && _onDataChanged) {
          _onDataChanged(_cloneStoreRows());
        }
        await _ensureActiveBase();
        _openSse();

        // Step 2: Background incremental revalidation when IndexedDB cache is warm (avoids full 7,300-row re-download)
        if (_store.length) {
          var hasSyncCursor = Boolean(_lastSyncIso || _latestStoreTimestampIso());
          if (hasSyncCursor) {
            await this.refresh(true);
          } else {
            try {
              var fetchResult = await _fetchStore(false);
              if (fetchResult && fetchResult.notModified) {
                console.log('[dataSdk] Revalidation complete: Cache is 100% up to date (HTTP 304).');
              } else if (Array.isArray(fetchResult) && fetchResult.length) {
                if (_pruneStoreWithAuthoritativeCatalog(fetchResult)) {
                  _triggerStoreUpdated(_lastServerTs);
                }
              }
            } catch (fetchErr) {
              console.warn('[dataSdk] Revalidation fetch failed, checking incremental:', fetchErr);
              await this.refresh(true);
            }
          }
        } else {
          // Cold start (no cache): fetch full lite catalog
          var initialRows = await _fetchStore(true);
          if (Array.isArray(initialRows) && initialRows.length) {
            _store = _normalizeRequestRows(initialRows);
            _triggerStoreUpdated(_lastServerTs);
          }
        }

        // Instant SWR: First page loaded, background updates will arrive via SSE or polling
        try { _startBackgroundPolling(); } catch (e) {}

        return { isOk: true };
      } catch (e) {
        console.error('[dataSdk] init failed:', e);
        return { isOk: false };
      }
    },

    async refresh(force) {
      if (!force && typeof document !== 'undefined' && document.hidden) {
        return { isOk: false, reason: 'hidden' };
      }
      if (_refreshInFlight) {
        try { return await _refreshInFlight; } catch (e) { return { isOk: false }; }
      }
      var now = Date.now();
      if (!force && _lastRefreshIssuedAt && (now - _lastRefreshIssuedAt) < _refreshCooldownMs) {
        return { isOk: true, reason: 'cooldown' };
      }
      _lastRefreshIssuedAt = now;
      if (force) {
        _lastEtag = null;
      }

      _refreshInFlight = (async function () {
      try {
        var incResult = null;
        try {
          incResult = await _fetchIncrementalStore();
        } catch (incErr) {
          console.warn('[dataSdk] refresh incremental fetch failed:', incErr && incErr.message ? incErr.message : incErr);
          return { isOk: false };
        }
        var changed = false;
        if (incResult && Array.isArray(incResult.rows) && incResult.rows.length > 0) {
          if (_mergeLatestRows(incResult.rows)) changed = true;
        }
        var reconciled = false;
        try {
          reconciled = await _reconcileWithServerMeta(incResult);
        } catch (recErr) {
          console.warn('[dataSdk] reconcile warning:', recErr);
        }
        if (changed || reconciled) {
          _triggerStoreUpdated((incResult && incResult.serverTs) || _lastServerTs);
        } else if (incResult && incResult.serverTs) {
          _setLastSyncIso(incResult.serverTs);
        }
        return { isOk: true };
      } catch (e) {
        console.error('[dataSdk] refresh failed:', e);
        return { isOk: false };
      }
      })();

      try {
        return await _refreshInFlight;
      } finally {
        _refreshInFlight = null;
      }
    },

    async loadMore() {
      if (_isLoadingMore || !_hasMore) {
        return { isOk: true, rows: 0, hasMore: _hasMore };
      }
      _isLoadingMore = true;
      try {
        if (!_activeBase) await _ensureActiveBase();
        var endpoint = _buildUrl(_activeBase || '', '/api/ks/requests');
        var url = endpoint + '?limit=' + encodeURIComponent(String(_requestsPageSize)) + '&lite=1';
        if (_nextCursor) {
          url += '&cursor=' + encodeURIComponent(_nextCursor);
        }
        var startTime = Date.now();
        var res = await _fetchWithDedup(url, {});
        if (!res.ok) {
          throw new Error('HTTP ' + res.status + ' from ' + url);
        }
        var responseText = await res.clone().text();
        var body = JSON.parse(responseText);
        _logApiRequest(url, Array.isArray(body.data) ? body.data.length : 0, responseText.length, Date.now() - startTime);
        if (!body || !body.ok) throw new Error((body && body.error) || 'fetch_failed');
        var pageRows = Array.isArray(body.data) ? _normalizeRequestRows(body.data) : [];
        if (pageRows.length === 0) {
          _hasMore = false;
          _nextCursor = null;
          return { isOk: true, rows: 0, hasMore: false };
        }
        var paging = body.paging || null;
        _nextCursor = (paging && paging.nextCursor) || null;
        _hasMore = paging && typeof paging.hasMore === 'boolean' ? paging.hasMore : (pageRows.length === _requestsPageSize);
        if (paging && Number(paging.total) >= 0) {
          _storeTotalHint = Number(paging.total);
        }
        var newRows = pageRows;
        if (_store.length + newRows.length > _storeMaxRows) {
          newRows = newRows.slice(0, _storeMaxRows - _store.length);
          _storeTruncated = true;
        }
        _store = _store.concat(newRows);
        if (_storeTotalHint > _store.length) _storeTruncated = true;
        _triggerStoreUpdated();
        return { isOk: true, rows: newRows.length, hasMore: _hasMore };
      } catch (e) {
        console.error('[dataSdk] loadMore error:', e);
        return { isOk: false, error: e && e.message ? e.message : 'load_more_failed' };
      } finally {
        _isLoadingMore = false;
      }
    },

    getStoreInfo() {
      return {
        rows: _store.length,
        maxRows: _storeMaxRows,
        totalHint: _storeTotalHint,
        truncated: _storeTruncated,
        pageSize: _requestsPageSize,
        hasMore: _hasMore,
        isLoadingMore: _isLoadingMore
      };
    },

    // Helper to deeply normalize strings in payload
    _normalizePayloadStrings: function (obj) {
      if (typeof obj === 'string') {
        if (typeof window.normalizeVietnameseAccents === 'function') {
          return window.normalizeVietnameseAccents(obj);
        }
        return obj;
      }
      if (Array.isArray(obj)) {
        return obj.map(item => this._normalizePayloadStrings(item));
      }
      if (obj !== null && typeof obj === 'object') {
        var newObj = {};
        for (var key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            newObj[key] = this._normalizePayloadStrings(obj[key]);
          }
        }
        return newObj;
      }
      return obj;
    },

    async create(newItem) {
      if (!newItem) return { isOk: false };
      newItem = this._normalizePayloadStrings(newItem);
      if (!newItem.__backendId) {
        newItem = Object.assign({}, newItem, {
          __backendId: 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
        });
      }
      try {
        var response = await _fetchJsonWithRetry('/api/ks/requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newItem)
        });
        var result = response.body || {};
        if (!result.ok) {
          console.error('[dataSdk] create failed:', result);
          return { isOk: false, message: result.message || 'Lỗi tạo yêu cầu' };
        }
        var created = _normalizeRequestRow(result.data || newItem);
        // Do not optimistic-push here: SSE invalidate + refresh already patch store.
        // Optimistic push can create temporary duplicates when backend returns a
        // different __backendId than the client pre-generated one.
        setTimeout(function () {
          try {
            window.dataSdk.refresh().catch(function (e) {
              console.warn('[dataSdk] background refresh after create failed', e);
            });
          } catch (e) {}
        }, 0);
        return { isOk: true, data: created };
      } catch (e) {
        console.error('[dataSdk] create error:', e);
        var msg = (e && e.body && e.body.message) || (e && e.message) || 'Lỗi tạo yêu cầu';
        return { isOk: false, message: msg };
      }
    },

    async update(updated) {
      if (!updated || !updated.__backendId) return { isOk: false };
      updated = this._normalizePayloadStrings(updated);
      try {
        var response = await _fetchJsonWithRetry('/api/ks/requests/' + encodeURIComponent(updated.__backendId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updated)
        });
        var result = response.body || {};
        if (!result.ok) {
          console.error('[dataSdk] update failed:', result);
          return { isOk: false };
        }
        var idx = _store.findIndex(function (r) { return r.__backendId === updated.__backendId; });
        var savedRecord = _normalizeRequestRow(result.data || updated);
        if (idx !== -1) _store[idx] = savedRecord;
        else _store.push(savedRecord);
        if (_store.length > _storeMaxRows) {
          _store = _store.slice(0, _storeMaxRows);
          _storeTruncated = true;
        }
        if (_onDataChanged) _onDataChanged(_cloneStoreRows());
        return { isOk: true };
      } catch (e) {
        console.error('[dataSdk] update error:', e);
        return { isOk: false };
      }
    },

    async getOne(id) {
      if (!id) return { isOk: false };
      try {
        var response = await _fetchJsonWithRetry('/api/ks/requests/' + encodeURIComponent(id), {}, true);
        if (response && response.status === 304) {
          var cached = _store.find(function (r) {
            return String(r.__backendId || r.id || r.tkCode) === String(id);
          });
          if (cached) return { isOk: true, data: cached };
        }
        if (!response.ok) return { isOk: false };
        var result = response.body || {};
        if (!result.ok || !result.data) return { isOk: false };
        var fullItem = _normalizeRequestRow(result.data);
        var idx = _store.findIndex(function (r) {
          return String(r.__backendId || r.id || r.tkCode) === String(id);
        });
        if (idx !== -1) {
          if (_store[idx].oldContent && !fullItem.oldContent && !fullItem.content) {
            fullItem.oldContent = true;
          }
          _store[idx] = Object.assign({}, _store[idx], fullItem);
        } else {
          _store.unshift(fullItem);
          _triggerStoreUpdated();
        }
        if (typeof window !== 'undefined' && window.ksIdb) {
          window.ksIdb.upsertMany([fullItem]);
        }
        return { isOk: true, data: fullItem };
      } catch (e) {
        console.error('[dataSdk] getOne error:', e);
        return { isOk: false };
      }
    },

    async search(query, limit) {
      try {
        var q = String(query || '').trim();
        if (!q) return { isOk: true, data: [] };
        var l = Number(limit) || 100;
        var url = '/api/ks/requests?q=' + encodeURIComponent(q) + '&limit=' + encodeURIComponent(String(l));
        var response = await _fetchJsonWithRetry(url, {}, true);
        if (!response.ok) return { isOk: false, data: [] };
        var result = response.body || {};
        if (!result.ok || !Array.isArray(result.data)) return { isOk: false, data: [] };
        var mapped = _normalizeRequestRows(result.data);
        return { isOk: true, data: mapped };
      } catch (e) {
        console.error('[dataSdk] search error:', e);
        return { isOk: false, data: [] };
      }
    },

    async uploadImage(dataUrl, filename, backendId, subfolder) {
      try {
        var body = { dataUrl: dataUrl, filename: filename || 'attachment' };
        if (backendId) body.backendId = backendId;
        if (subfolder) body.folder = subfolder;
        if (backendId) {
          var match = _store.find(function (r) { return r && r.__backendId === backendId; });
          if (match && match.tkCode) body.tkCode = match.tkCode;
        }
        var response = await _fetchJsonWithRetry('/api/ks/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        var result = response.body || {};
        if (!result.ok) {
          console.error('[dataSdk] uploadImage failed:', result);
          return null;
        }
        return result.url;
      } catch (e) {
        console.error('[dataSdk] uploadImage error:', e);
        return null;
      }
    },

    async delete(req, reason) {
      if (!req) return { isOk: false };
      var idParam = req.__backendId || req.id || req.tkCode;
      if (!idParam) return { isOk: false };
      var targetBid = String(req.__backendId || '');
      var targetId = String(req.id || '');
      var targetTk = String(req.tkCode || '');
      var removeLocal = function () {
        for (var di = _store.length - 1; di >= 0; di--) {
          var item = _store[di];
          var b = String(item.__backendId || '');
          var i = String(item.id || '');
          var t = String(item.tkCode || '');
          if ((targetBid && b === targetBid) || (targetId && i === targetId) || (targetTk && t === targetTk)) {
            _store.splice(di, 1);
          }
        }
        _lastEtag = null;
        _triggerStoreUpdated();
      };
      try {
        var response = await _fetchJsonWithRetry('/api/ks/requests/' + encodeURIComponent(idParam), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason || '' })
        });
        removeLocal();
        return { isOk: true };
      } catch (e) {
        console.error('[dataSdk] delete error:', e);
        // Nếu server báo 404 hoặc không tìm thấy (bản ghi rác đã bị xóa trên DB), xóa sạch khỏi store local
        var status = e && (e.status || (e.response && e.response.status));
        var msg = String((e && e.message) || '');
        if (status === 404 || msg.indexOf('404') !== -1 || msg.indexOf('not_found') !== -1) {
          removeLocal();
          return { isOk: true, cleanedLocal: true };
        }
        return { isOk: false };
      }
    }
  };
})();
