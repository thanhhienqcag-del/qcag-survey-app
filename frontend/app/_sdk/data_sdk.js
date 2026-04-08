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

    for (var i = 0; i < candidates.length; i++) {
      var base = candidates[i];
      var endpoint = _buildUrl(base, '/api/ks/requests');
      try {
        var res = await fetch(endpoint, { headers: headers });
        if (res.status === 304) {
          _activeBase = base;
          return null;
        }
        if (!res.ok) {
          errLast = new Error('HTTP ' + res.status + ' from ' + endpoint);
          continue;
        }
        var etag = res.headers.get('ETag');
        if (etag) _lastEtag = etag;
        var body = await res.json();
        if (!body.ok) throw new Error(body.error || 'fetch_failed');
        _activeBase = base;
        return Array.isArray(body.data) ? body.data : [];
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

  window.dataSdk = {
    async init(opts) {
      opts = opts || {};
      _onDataChanged = opts.onDataChanged || null;
      try {
        await _ensureActiveBase();
        _store = await _fetchStore();
        if (_onDataChanged) _onDataChanged(_cloneStoreRows());

        // Setup SSE listener for realtime invalidation events.
        try {
          if (!_es && typeof EventSource !== 'undefined') {
            _es = new EventSource(_buildUrl(_activeBase || '', '/events'));
            _es.addEventListener('invalidate', function (ev) {
              try {
                var payload = ev && ev.data ? JSON.parse(ev.data) : null;
                if (!payload) return;
                if (String(payload.resource || '').toLowerCase() === 'ks_requests') {
                  window.dataSdk.refresh().catch(function (e) {
                    console.error('[dataSdk] refresh after invalidate failed', e);
                  });
                }
              } catch (e) {}
            });
            try {
              window.addEventListener && window.addEventListener('beforeunload', function () {
                try { _es && _es.close(); } catch (_) {}
              });
            } catch (_) {}
          }
        } catch (e) {}

        return { isOk: true };
      } catch (e) {
        console.error('[dataSdk] init failed:', e);
        return { isOk: false };
      }
    },

    async refresh() {
      try {
        var newStore = await _fetchStore();
        if (newStore === null) return { isOk: true };
        _store = newStore;
        if (_onDataChanged) _onDataChanged(_cloneStoreRows());
        return { isOk: true };
      } catch (e) {
        console.error('[dataSdk] refresh failed:', e);
        return { isOk: false };
      }
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
        var created = result.data || newItem;
        _store.push(created);
        if (_onDataChanged) _onDataChanged(_cloneStoreRows());
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
        var savedRecord = result.data || updated;
        if (idx !== -1) _store[idx] = savedRecord; else _store.push(savedRecord);
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
