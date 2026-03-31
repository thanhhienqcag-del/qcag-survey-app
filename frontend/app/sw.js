self.addEventListener('push', function(event) {
  let payload = {};
  try { payload = event.data.json(); } catch (e) { payload = { title: 'QCAG', body: 'Bạn có thông báo mới' }; }
  const title = payload.title || 'QCAG';
  const options = {
    body: payload.body || '',
    icon: '/app/assets/logo-qcag-2.0-192.png',
    badge: '/app/assets/logo-qcag-2.0-192.png',
    data: payload.data || {}
  };
  // Show a system notification and also notify any open clients so the
  // in-app UI can display a toast when the app is in the foreground.
  event.waitUntil((async function() {
    try {
      await self.registration.showNotification(title, options);
    } catch (e) {
      // ignore showNotification errors — still try to post message to clients
    }
    try {
      const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        try {
          client.postMessage({ type: 'push', title: title, body: options.body || '', data: options.data || {} });
        } catch (e) {}
      }
    } catch (e) {}
  })());
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window' }).then(function(clientList) {
    if (clientList.length > 0) {
      let client = clientList[0];
      for (let i = 0; i < clientList.length; i++) {
        if (clientList[i].focused) {
          client = clientList[i];
          break;
        }
      }
      return client.focus();
    }
    return clients.openWindow('/');
  }));
});
