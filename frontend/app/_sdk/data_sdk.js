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
  var _rtVisibilityBound = false;
  // Tăng pageSize lên 300 để load đủ dữ liệu trong 1 lần fetch.
  // Backend đã cho phép tối đa 300 records/page. storeMaxRows = 2000
  // để chứa đủ khi data tiếp tục tăng.
  var _requestsPageSize = 300;
  var _storeMaxRows = 999999;
  var _storeTruncated = false;
  var _storeTotalHint = 0;
  var _lastSyncIso = '';
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

  function _scheduleRefresh(delayMs) {
    // Debounced refresh: coalesce bursts of invalidate events and avoid
    // scheduling a refresh while one is already in-flight. Use a larger
    // default delay to reduce aggressive polling during event storms.
    var ms = Number(delayMs);
    if (!(ms >= 0)) ms = 1000; // default 1s debounce
    try {
      // If a refresh is already scheduled or currently running, skip scheduling
      // to prevent repeated HTTP fetches during high-frequency events.
      if (_refreshTimer || _refreshInFlight) return;
    } catch (e) {}
    _refreshTimer = setTimeout(function () {
      _refreshTimer = null;
      try {
        if (typeof document !== 'undefined' && document.hidden) return;
        if (window.dataSdk && typeof window.dataSdk.refresh === 'function') {
          window.dataSdk.refresh().catch(function (e) {
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
          // Reconnect after a gap — fetch fresh data to catch any missed events
          _scheduleRefresh(200);
        }
        _esEverConnected = true;
      };

      _es.addEventListener('invalidate', function (ev) {
        try {
          var payload = ev && ev.data ? JSON.parse(ev.data) : null;
          if (!payload) return;
          if (String(payload.resource || '').toLowerCase() === 'ks_requests') {
            _esRetryMs = 1000; // successful message → reset backoff
            var action = String(payload.action || '').toLowerCase();

            // ── Inline cache patch: instant UI update without HTTP round-trip ──
            // If the SSE payload contains `data`, patch the local store immediately
            // (like App-1 pattern).  A background refresh still fires to ensure
            // consistency, but the UI updates in <100ms instead of waiting for
            // the HTTP fetch to return.
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
                _scheduleRefresh(120);
                return;
              }
              if (payload.action === 'create') {
                // New row: add if not already present
                var exists = false;
                for (var pi = 0; pi < _store.length; pi++) {
                  if (_store[pi].__backendId === bid) { exists = true; _store[pi] = row; break; }
                }
                if (!exists) _store.push(row);
                if (_store.length > _storeMaxRows) {
                  _store = _store.slice(0, _storeMaxRows);
                  _storeTruncated = true;
                }
                patched = true;
              } else if (payload.action === 'update' || payload.action === 'upsert') {
                for (var ui = 0; ui < _store.length; ui++) {
                  if (_store[ui].__backendId === bid) {
                    // Merge fields (keep existing fields, overwrite changed ones)
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
            } else if (action === 'delete' && payload.id) {
              for (var di2 = 0; di2 < _store.length; di2++) {
                if (String(_store[di2].__backendId || '') === String(payload.id)) {
                  _store.splice(di2, 1);
                  patched = true;
                  break;
                }
              }
              if (patched && _onDataChanged) {
                _onDataChanged(_cloneStoreRows());
              }
            }

            // Fire global invalidation hook (for desktop banner notifications)
            if (typeof window.__ksOnInvalidate === 'function') {
              try { window.__ksOnInvalidate(payload); } catch (hookErr) {
                console.warn('[dataSdk] __ksOnInvalidate hook error:', hookErr);
              }
            }

            // Only full-refresh when payload is not enough to patch safely.
            if (!patched || (action !== 'create' && action !== 'update' && action !== 'upsert' && action !== 'delete')) {
              _scheduleRefresh(300);
            }
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

      // Refresh data when tab becomes visible again (mobile background → foreground)
      try {
        if (!_rtVisibilityBound) {
          _rtVisibilityBound = true;
          document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') {
              _clearEsRetry();
              _closeEs();
              return;
            }
            // Re-open SSE and fetch fresh data on tab focus.
            if (!_es || _es.readyState === 2 /* CLOSED */) _openSse();
            _scheduleRefresh(120);
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
  // 1) runtime env BACKEND_URL (set by /api/env at runtime when available)
  // 2) same-origin origin (works for Vercel + local app server)
  // 3) localhost ports for local dev fallback
  function _getBaseCandidates() {
    var candidates = [];
    try {
      if (window.__env && typeof window.__env.BACKEND_URL !== 'undefined') {
        var be = String(window.__env.BACKEND_URL || '').trim();
        if (be) candidates.push(_normalizeBase(be)); else candidates.push('');
      }
      if (window.__env && Array.isArray(window.__env.BACKEND_URL_CANDIDATES)) {
        window.__env.BACKEND_URL_CANDIDATES.forEach(function (u) {
          var x = String(u || '').trim();
          if (x) candidates.push(_normalizeBase(x));
        });
      } else if (window.__env && typeof window.__env.BACKEND_URL_CANDIDATES === 'string') {
        String(window.__env.BACKEND_URL_CANDIDATES || '')
          .split(',')
          .map(function (s) { return String(s || '').trim(); })
          .filter(Boolean)
          .forEach(function (u) { candidates.push(_normalizeBase(u)); });
      }
    } catch (e) {}
    try {
      if (typeof window !== 'undefined' && window.location && window.location.origin && !/^file:/i.test(window.location.origin)) {
        candidates.push(_normalizeBase(window.location.origin));
      }
    } catch (e) {}
    try {
      var host = (typeof window !== 'undefined' && window.location && window.location.hostname) ? window.location.hostname : '';
      if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
        candidates.push('https://localhost:3000');
        candidates.push('https://localhost:3001');
        candidates.push('https://localhost:3100');
        candidates.push('https://localhost:3101');
        candidates.push('https://localhost:3102');
        candidates.push('http://localhost:3000');
        candidates.push('http://localhost:3001');
        candidates.push('http://localhost:3100');
        candidates.push('http://localhost:3101');
        candidates.push('http://localhost:3102');
        candidates.push('http://127.0.0.1:3000');
        candidates.push('http://127.0.0.1:3100');
        candidates.push('http://127.0.0.1:3101');
        candidates.push('http://127.0.0.1:3102');
      }
    } catch (e) {}
    // last-resort: same-origin
    candidates.push('');
    return _unique(candidates.filter(function (x) { return x != null; }));
  }

  function _buildUrl(base, path) {
    var b = _normalizeBase(base);
    return (b ? b : '') + path;
  }

  function _saveCache() {
    try {
      if (typeof localStorage === 'undefined') return;
      var payload = {
        store: _store.slice(0, _storeMaxRows),
        lastSync: _lastSyncIso || _latestStoreTimestampIso(),
      };
      localStorage.setItem(_cacheStoreKey, JSON.stringify(payload));
      if (payload.lastSync) localStorage.setItem(_cacheSyncKey, payload.lastSync);
    } catch (_) {}
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
    } catch (_) {}
  }

  function _triggerStoreUpdated() {
    _setLastSyncIso(_latestStoreTimestampIso());
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
    var url = _buildUrl(base, '/api/ks/health');
    var dbHealthUrl = _buildUrl(base, '/db-health');
    var attempts = 2;
    for (var a = 0; a < attempts; a++) {
      try {
        var res = await fetch(url, { method: 'GET' });
        if (!res || !res.ok) throw new Error('health_failed');

        // Newer backends expose dbReady in /api/ks/health.
        try {
          var payload = await res.clone().json();
          if (payload && (payload.dbReady === false || payload.ok === false)) {
            throw new Error('db_not_ready');
          }
        } catch (_) {
          // ignore JSON parse errors (older/local health endpoints)
        }

        // Extra DB probe when endpoint exists.
        // If /db-health is 404 (local mock server), still consider base healthy.
        try {
          var dbRes = await fetch(dbHealthUrl, { method: 'GET' });
          if (dbRes && dbRes.status !== 404 && !dbRes.ok) {
            throw new Error('db_health_failed');
          }
        } catch (dbErr) {
          throw dbErr;
        }

        return true;
      } catch (e) {
        // ignore and retry
      }
      // small backoff between attempts
      await new Promise(function (r) { setTimeout(r, 150 * (a + 1)); });
    }
    return false;
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

  async function _fetchStore() {
    var headers = {};
    if (_lastEtag) headers['If-None-Match'] = _lastEtag;
    var errLast = null;
    var candidates = _unique([_activeBase].concat(_getBaseCandidates()).filter(function (x) { return x != null; }));
    _storeTruncated = false;
    _storeTotalHint = 0;
    if (!_activeBase) await _ensureActiveBase();

    for (var i = 0; i < candidates.length; i++) {
      var base = candidates[i];
      var endpoint = _buildUrl(base, '/api/ks/requests');
      try {
        var firstUrl = endpoint + '?limit=' + encodeURIComponent(String(_requestsPageSize)) + '&offset=0';
        var startTime = Date.now();
        var res = await _fetchWithDedup(firstUrl, { headers: headers });
        if (res.status === 304) {
          _activeBase = base;
          return [];
        }
        if (!res.ok) {
          errLast = new Error('HTTP ' + res.status + ' from ' + endpoint);
          continue;
        }
        var responseText = await res.clone().text();
        var body = JSON.parse(responseText);
        _logApiRequest(firstUrl, Array.isArray(body.data) ? body.data.length : 0, responseText.length, Date.now() - startTime);
        var etag = res.headers.get('ETag');
        if (etag) _lastEtag = etag;
        var allRows = Array.isArray(body.data) ? _normalizeRequestRows(body.data) : [];
        var paging = body.paging || null;
        var totalHint = Number(paging && paging.total);
        if (!(totalHint >= 0)) totalHint = allRows.length;
        _storeTotalHint = totalHint;

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
        if (!res.ok) {
          if (allowNotOk) return { ok: false, status: res.status, base: base, body: null };
          errLast = new Error('HTTP ' + res.status + ' from ' + url);
          continue;
        }
        var body = await res.json();
        _activeBase = base;
        return { ok: true, status: res.status, base: base, body: body };
      } catch (e) {
        errLast = e;
      }
    }

    throw errLast || new Error('Request failed for ' + path);
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
    if (!normalized.tkCode) normalized.tkCode = normalized.tk_code || normalized.code || null;
    if (!normalized.tkCode) normalized.tkCode = _deriveTkCodeFromRow(normalized);

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
      acceptanceImages: true
    };
    if (!protectedFields[key]) return false;
    if (incoming == null) return String(existing || '').trim().length > 0;
    if ((key === 'content' || key === 'oldContentExtra') && String(incoming).trim() === '' && String(existing || '').trim().length > 0) {
      return true;
    }
    if ((key === 'statusImages' || key === 'designImages' || key === 'acceptanceImages') && typeof incoming === 'string') {
      var trimmed = String(incoming).trim();
      if (trimmed === '[]' || trimmed === '["..."]') {
        var existingArr = _safeParseJsonArray(existing);
        return existingArr.length > 0 && !(existingArr.length === 1 && String(existingArr[0] || '').trim() === '...');
      }
    }
    return false;
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
    }

    for (var j = 0; j < incoming.length; j++) {
      var next = incoming[j] || {};
      var nid = next.__backendId || next.id;
      if (nid == null) continue;
      var key = String(nid);
      if (Object.prototype.hasOwnProperty.call(indexById, key)) {
        var idx = indexById[key];
        var prev = _store[idx] || {};
        var merged = Object.assign({}, prev);
        for (var field in next) {
          if (!Object.prototype.hasOwnProperty.call(next, field)) continue;
          if (_shouldPreserveExistingField(field, next[field], prev[field])) continue;
          merged[field] = next[field];
        }
        _store[idx] = merged;
        changed = true;
      } else {
        _store.unshift(next);
        changed = true;
      }
    }

    if (_store.length > _storeMaxRows) {
      _store = _store.slice(0, _storeMaxRows);
      _storeTruncated = true;
      changed = true;
    }
    return changed;
  }

  async function _fetchIncrementalStore() {
    var errLast = null;
    var candidates = _unique([_activeBase].concat(_getBaseCandidates()).filter(function (x) { return x != null; }));
    var sinceIso = _lastSyncIso || _latestStoreTimestampIso();
    if (!sinceIso) return [];
    for (var i = 0; i < candidates.length; i++) {
      var base = candidates[i];
      var endpoint = _buildUrl(base, '/api/ks/requests');
      var url = endpoint + '?updated_since=' + encodeURIComponent(sinceIso) + '&limit=' + encodeURIComponent(String(_requestsPageSize));
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
        return Array.isArray(body.data) ? _normalizeRequestRows(body.data) : [];
      } catch (e) {
        errLast = e;
      }
    }
    if (errLast) throw errLast;
    return [];
  }

  window.dataSdk = {
    async init(opts) {
      opts = opts || {};
      _onDataChanged = opts.onDataChanged || null;
      try {
        _loadCache();
        if (_store.length && _onDataChanged) {
          _onDataChanged(_cloneStoreRows());
        }
        await _ensureActiveBase();

        if (_store.length) {
          // Do not rehydrate the entire dataset on every reload. A single
          // incremental refresh is enough to surface newly created/updated rows
          // while keeping transfer volume low.
          try {
            var refreshResult = await this.refresh();
            if (!refreshResult || !refreshResult.isOk) {
              var bootstrapRows = await _fetchStore();
              if (bootstrapRows && bootstrapRows.length) {
                _store = _normalizeRequestRows(bootstrapRows);
                _triggerStoreUpdated();
              }
            }
          } catch (bootstrapErr) {
            console.warn('[dataSdk] incremental bootstrap failed, fallback to one-shot fetch:', bootstrapErr);
            try {
              var fallbackRows = await _fetchStore();
              if (fallbackRows && fallbackRows.length) {
                _store = _normalizeRequestRows(fallbackRows);
                _triggerStoreUpdated();
              }
            } catch (fallbackErr) {
              console.warn('[dataSdk] fallback bootstrap fetch failed:', fallbackErr);
            }
          }
        } else {
          var bootstrapRows = await _fetchStore();
          _store = _normalizeRequestRows(bootstrapRows);
          _triggerStoreUpdated();
        }

        // Setup SSE listener for realtime invalidation events (with reconnect).
        try { _openSse(); } catch (e) {}

        return { isOk: true };
      } catch (e) {
        console.error('[dataSdk] init failed:', e);
        return { isOk: false };
      }
    },

    async refresh() {
      if (typeof document !== 'undefined' && document.hidden) {
        return { isOk: false, reason: 'hidden' };
      }
      if (_refreshInFlight) {
        try { return await _refreshInFlight; } catch (e) { return { isOk: false }; }
      }

      _refreshInFlight = (async function () {
      try {
        var latest = [];
        try {
          latest = await _fetchIncrementalStore();
        } catch (_) {
          latest = [];
        }
        if (!latest.length) {
          return { isOk: true };
        }
        var changed = _mergeLatestRows(latest);
        if (changed) {
          _triggerStoreUpdated();
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
      try {
        if (!_activeBase) await _ensureActiveBase();
        var endpoint = _buildUrl(_activeBase || '', '/api/ks/requests');
        var offset = Math.max(0, _store.length);
        var url = endpoint + '?limit=' + encodeURIComponent(String(_requestsPageSize)) + '&offset=' + encodeURIComponent(String(offset));
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
          return { isOk: true, rows: 0, hasMore: false };
        }
        var newRows = pageRows;
        if (_store.length + newRows.length > _storeMaxRows) {
          newRows = newRows.slice(0, _storeMaxRows - _store.length);
          _storeTruncated = true;
        }
        _store = _store.concat(newRows);
        var paging = body.paging || null;
        if (paging && Number(paging.total) >= 0) {
          _storeTotalHint = Number(paging.total);
        }
        if (_storeTotalHint > _store.length) _storeTruncated = true;
        _triggerStoreUpdated();
        return { isOk: true, rows: newRows.length, hasMore: paging ? Boolean(paging.hasMore) : (pageRows.length === _requestsPageSize) };
      } catch (e) {
        console.error('[dataSdk] loadMore error:', e);
        return { isOk: false, error: e && e.message ? e.message : 'load_more_failed' };
      }
    },

    getStoreInfo() {
      return {
        rows: _store.length,
        maxRows: _storeMaxRows,
        totalHint: _storeTotalHint,
        truncated: _storeTruncated,
        pageSize: _requestsPageSize,
        hasMore: _storeTotalHint > _store.length
      };
    },

    async create(newItem) {
      if (!newItem) return { isOk: false };
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
          return { isOk: false };
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
        return { isOk: false };
      }
    },

    async update(updated) {
      if (!updated || !updated.__backendId) return { isOk: false };
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
        if (!response.ok) return { isOk: false };
        var result = response.body || {};
        if (!result.ok || !result.data) return { isOk: false };
        return { isOk: true, data: result.data };
      } catch (e) {
        console.error('[dataSdk] getOne error:', e);
        return { isOk: false };
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

    async delete(req) {
      if (!req || !req.__backendId) return { isOk: false };
      try {
        var response = await _fetchJsonWithRetry('/api/ks/requests/' + encodeURIComponent(req.__backendId), {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' }
        });
        var idx = _store.findIndex(function (r) { return r.__backendId === req.__backendId; });
        if (idx !== -1) _store.splice(idx, 1);
        if (_onDataChanged) _onDataChanged(_cloneStoreRows());
        return { isOk: true };
      } catch (e) {
        console.error('[dataSdk] delete error:', e);
        return { isOk: false };
      }
    }
  };
})();
