// ====================================================================
// ks-idb.js - High-Performance Client IndexedDB Storage Layer for App 2
// Zero-dependency, async/await W3C IndexedDB wrapper
// Stores 10,000+ requests without 5MB localStorage quota limitations.
// ====================================================================
(function () {
  'use strict';

  var DB_NAME = 'ks_requests_db_v12';
  var DB_VERSION = 1;
  var STORE_REQUESTS = 'requests';
  var STORE_META = 'meta';

  var _dbPromise = null;

  function _openDb() {
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise(function (resolve, reject) {
      if (typeof window === 'undefined' || !window.indexedDB) {
        return reject(new Error('IndexedDB not supported'));
      }

      var req = window.indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE_REQUESTS)) {
          var store = db.createObjectStore(STORE_REQUESTS, { keyPath: '__key' });
          store.createIndex('tkCode', 'tkCode', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };

      req.onsuccess = function (ev) {
        resolve(ev.target.result);
      };

      req.onerror = function (ev) {
        _dbPromise = null;
        reject(ev.target.error || new Error('Failed to open IndexedDB'));
      };
    });

    return _dbPromise;
  }

  function _rowKey(row) {
    if (!row) return '';
    return String(row.__backendId || row.id || row.tkCode || row.tk_code || '');
  }

  var ksIdb = {
    isSupported: function () {
      return typeof window !== 'undefined' && Boolean(window.indexedDB);
    },

    // Lấy toàn bộ danh sách requests từ IndexedDB (vài ms cho 3,665 items)
    getAll: async function () {
      try {
        var db = await _openDb();
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE_REQUESTS, 'readonly');
          var store = tx.objectStore(STORE_REQUESTS);
          var req = store.getAll();
          req.onsuccess = function () {
            var items = req.result || [];
            // Sort theo createdAt DESC để nhất quán với server
            items.sort(function (a, b) {
              var ta = a.createdAt ? Date.parse(a.createdAt) : 0;
              var tb = b.createdAt ? Date.parse(b.createdAt) : 0;
              return tb - ta;
            });
            resolve(items);
          };
          req.onerror = function () {
            resolve([]);
          };
        });
      } catch (err) {
        console.warn('[ksIdb] getAll failed, fallback empty:', err);
        return [];
      }
    },

    // Lưu toàn bộ danh sách requests vào IndexedDB (dùng khi bootstrap / sync)
    setAll: async function (rows) {
      if (!Array.isArray(rows) || !rows.length) return false;
      try {
        var db = await _openDb();
        return new Promise(function (resolve) {
          var tx = db.transaction([STORE_REQUESTS], 'readwrite');
          var store = tx.objectStore(STORE_REQUESTS);
          store.clear(); // Xóa sạch để thay bằng snapshot mới chuẩn nhất
          for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var k = _rowKey(r);
            if (k) {
              r.__key = k;
              store.put(r);
            }
          }
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function (e) {
            console.warn('[ksIdb] setAll tx error:', e);
            resolve(false);
          };
        });
      } catch (err) {
        console.warn('[ksIdb] setAll error:', err);
        return false;
      }
    },

    // Upsert / cập nhật một phần danh sách requests (dùng cho delta sync ngầm)
    upsertMany: async function (rows) {
      if (!Array.isArray(rows) || !rows.length) return false;
      try {
        var db = await _openDb();
        return new Promise(function (resolve) {
          var tx = db.transaction(STORE_REQUESTS, 'readwrite');
          var store = tx.objectStore(STORE_REQUESTS);
          for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var k = _rowKey(r);
            if (k) {
              r.__key = k;
              store.put(r);
            }
          }
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        });
      } catch (err) {
        console.warn('[ksIdb] upsertMany error:', err);
        return false;
      }
    },

    // Lưu / lấy metadata đơn giản (ETag, lastSyncIso)
    getMeta: async function (key) {
      try {
        var db = await _openDb();
        return new Promise(function (resolve) {
          var tx = db.transaction(STORE_META, 'readonly');
          var store = tx.objectStore(STORE_META);
          var req = store.get(key);
          req.onsuccess = function () {
            resolve(req.result ? req.result.val : null);
          };
          req.onerror = function () { resolve(null); };
        });
      } catch (_) {
        return null;
      }
    },

    setMeta: async function (key, val) {
      try {
        var db = await _openDb();
        return new Promise(function (resolve) {
          var tx = db.transaction(STORE_META, 'readwrite');
          var store = tx.objectStore(STORE_META);
          store.put({ key: key, val: val });
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        });
      } catch (_) {
        return false;
      }
    },

    // Xóa toàn bộ dữ liệu nếu user đăng xuất / muốn hard reset
    clearAll: async function () {
      try {
        var db = await _openDb();
        return new Promise(function (resolve) {
          var tx = db.transaction([STORE_REQUESTS, STORE_META], 'readwrite');
          tx.objectStore(STORE_REQUESTS).clear();
          tx.objectStore(STORE_META).clear();
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        });
      } catch (_) {
        return false;
      }
    }
  };

  window.ksIdb = ksIdb;
})();
