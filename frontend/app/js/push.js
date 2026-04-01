// app/js/push.js — Web Push client helper
'use strict';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function getVapidPublicKey() {
  // Always call the frontend-local push endpoint (same-origin serverless function)
  const res = await fetch('/api/push');
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'No VAPID key');
  return data.publicKey;
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('Service workers not supported');
  // Register at root scope so iOS 16.4+ PWA can show lock-screen push notifications
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return reg;
}

async function subscribeForPush() {
  if (!('PushManager' in window)) throw new Error('Push not supported');
  const reg = await registerServiceWorker();
  const vapidKey = await getVapidPublicKey();
  try {
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey)
    });
    return sub;
  } catch (err) {
    // If subscription exists but was created with a different VAPID key,
    // browsers throw InvalidStateError. Try to unsubscribe existing one then retry.
    if (err && err.name === 'InvalidStateError') {
      try {
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          await existing.unsubscribe();
        }
        // Retry subscribe
        const sub2 = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey)
        });
        return sub2;
      } catch (err2) {
        throw err2;
      }
    }
    throw err;
  }
}

async function saveSubscriptionToServer(subscription, phone, role) {
  // Always call the frontend-local subscribe endpoint (same-origin serverless function)
  const res = await fetch('/api/ks/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, phone: phone || null, role: role || null })
  });
  return res.json();
}

async function initPush(phone, role) {
  if (!('Notification' in window)) return { ok: false, error: 'Notifications not supported' };
  if (!('PushManager' in window)) return { ok: false, error: 'Push not supported' };
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, error: 'Permission not granted' };
    const sub = await subscribeForPush();
    // Save subscription to backend so server can push to this device
    await saveSubscriptionToServer(sub, phone, role);
    return { ok: true, subscription: sub };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Expose for console/testing
window.pushHelpers = { initPush, subscribeForPush, registerServiceWorker, getVapidPublicKey, saveSubscriptionToServer };

// Listen for push messages forwarded by the SW while the app is open (foreground toast)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'PUSH_RECEIVED') return;
    try {
      const title = event.data.title || 'QCAG';
      const body  = event.data.body  || '';
      const msg   = title + (body ? '\n' + body : '');
      if (typeof showToast === 'function') {
        showToast(msg);
      } else {
        console.info('[push] in-app message:', msg);
      }
    } catch (e) {}
  });
}
