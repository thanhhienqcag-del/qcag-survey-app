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

  // Priority:
  // 1) runtime env BACKEND_URL (set trong index.html)
  // 2) localhost:3001 (KS backend local dev)
  // 3) same-origin fallback
  function _getBaseCandidates() {
    var candidates = [];
    try {
      if (window.__env && window.__env.BACKEND_URL) {
        candidates.push(_normalizeBase(window.__env.BACKEND_URL));
      }
    } catch (e) {}
    candidates.push('http://localhost:3001');
    candidates.push('');
    return _unique(candidates.filter(function (x) { return x != null; }));
  }

  function _buildUrl(base, path) {
    var b = _normalizeBase(base);
    return (b ? b : '') + path;
  }

  async function _isHealthyBase(base) {
    try {
      var res = await fetch(_buildUrl(base, '/api/ks/health'), { method: 'GET' });
      return res.ok;
    } catch (e) {
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

  async function _fetchStore() {
    var headers = {};
    if (_lastEtag) headers['If-None-Match'] = _lastEtag;
    var errLast = null;
    var candidates = _unique([_activeBase].concat(_getBaseCandidates()).filter(Boolean));

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
    var candidates = _unique([_activeBase].concat(_getBaseCandidates()).filter(Boolean));

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
    }
  };
})();
