self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(event) {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { title: 'QCAG', body: 'Bạn có thông báo mới' }; }
  const title = payload.title || 'QCAG';
  const tag = payload.tag || ('qcag-' + Date.now());
  const options = {
    body: payload.body || '',
    icon: '/app/assets/logo-qcag-2.0-192.png',
    badge: '/app/assets/logo-qcag-2.0-192.png',
    tag: tag,
    data: payload.data || {}
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
        clientList.forEach(function (client) {
          try { client.postMessage({ type: 'PUSH_RECEIVED', title: title, body: options.body, data: options.data }); } catch (_) {}
        });
      })
    ])
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window' }).then(function(clientList) {
    if (clientList.length > 0) {
      let client = clientList[0];
      for (let i = 0; i < clientList.length; i++) {
        if (clientList[i].focused) { client = clientList[i]; break; }
      }
      return client.focus();
    }
    return clients.openWindow('/');
  }));
});

