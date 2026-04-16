// sw.js — Root-scope Service Worker (iOS PWA + Android PWA push notifications)
// Must be served at / for full PWA standalone push support on iOS 16.4+
'use strict';

const CACHE_NAME = 'qcag-v2.4.1';

// ── Install: immediately activate ──────────────────────────────────────────────
self.addEventListener('install', function (event) {
  self.skipWaiting();
});

// ── Activate: take control + xóa cache phiên bản cũ ───────────────────────────
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME; })
            .map(function (key) { return caches.delete(key); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

// ── Message: allow client to force SW update ──────────────────────────────────
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Push: show OS notification ─────────────────────────────────────────────────
self.addEventListener('push', function (event) {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'QCAG', body: 'Bạn có thông báo mới' };
  }

  const title = payload.title || 'QCAG';
  // Use unique tag per notification so they stack (don't replace each other)
  const tag = payload.tag || ('qcag-' + Date.now());

  // Keep options minimal for maximum iOS/Android compatibility
  // NOTE: vibrate is NOT supported on iOS — omit it
  const options = {
    body: payload.body || '',
    icon: '/app/assets/logo-qcag-2.0-192.png',
    badge: '/app/assets/logo-qcag-2.0-192.png',
    tag: tag,
    data: payload.data || {}
  };

  // IMPORTANT: only ONE event.waitUntil() — combine all async work into Promise.all
  event.waitUntil(
    Promise.all([
      // Show the OS notification (lock screen, notification center)
      self.registration.showNotification(title, options),
      // Forward push data to any open app windows for in-app toast
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
        clientList.forEach(function (client) {
          try {
            client.postMessage({ type: 'PUSH_RECEIVED', title: title, body: options.body, data: options.data });
          } catch (_) {}
        });
      })
    ])
  );
});

// ── Notification click: focus or open app ─────────────────────────────────────
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      // Focus an existing QCAG window if available
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// ── Fetch: network-first, fallback to cache for HTML ─────────────────────────
self.addEventListener('fetch', function (event) {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Skip API calls and cross-origin requests
  if (url.pathname.startsWith('/api/') || url.origin !== location.origin) return;

  event.respondWith(
    fetch(event.request).catch(function () {
      return caches.match(event.request);
    })
  );
});
