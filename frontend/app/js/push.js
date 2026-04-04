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

  // Force-update SW if a new version is waiting (especially important on iOS PWA)
  if (reg.waiting) {
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
  reg.addEventListener('updatefound', function () {
    const newWorker = reg.installing;
    if (!newWorker) return;
    newWorker.addEventListener('statechange', function () {
      if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
        // New SW installed and waiting — force activate immediately
        newWorker.postMessage({ type: 'SKIP_WAITING' });
      }
    });
  });

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

async function saveSubscriptionToServer(subscription, phone, role, saleCode) {
  // Always call the frontend-local subscribe endpoint (same-origin serverless function)
  const res = await fetch('/api/ks/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, phone: phone || null, role: role || null, saleCode: saleCode || null })
  });
  return res.json();
}

async function initPush(phone, role, saleCode) {
  if (!('Notification' in window)) return { ok: false, error: 'Notifications not supported' };
  if (!('PushManager' in window)) return { ok: false, error: 'Push not supported' };
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, error: 'Permission not granted' };
    const sub = await subscribeForPush();
    // Save subscription to backend so server can push to this device
    await saveSubscriptionToServer(sub, phone, role, saleCode);
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
        // Use 8 seconds for push notifications so QCAG staff don't miss them
        showToast(msg, 8000);
      } else {
        console.info('[push] in-app message:', msg);
      }
    } catch (e) {}
  });
}

// Auto re-subscribe on page load if user already has a session saved
// This ensures subscriptions stay fresh after a new deployment without re-login
// Also handles the case where session is restored from localStorage (bootApp path)
// without going through launchApp() — e.g. Machine B that was never explicitly logged in.
(function autoInitPushOnLoad() {
  if (!('PushManager' in window) || !('serviceWorker' in navigator)) return;
  if (typeof Notification === 'undefined') return;
  // Skip only if user explicitly denied — 'granted' re-subscribes silently,
  // 'default' (never asked) will show the browser permission prompt once.
  if (Notification.permission === 'denied') return;

  function tryAutoSubscribe() {
    let session = null;
    try { session = JSON.parse(localStorage.getItem('ks_session') || 'null'); } catch (_) {}
    if (!session) return; // not logged in yet

    const phone    = session.phone    || null;
    const role     = session.role     || null;
    const saleCode = session.saleCode || null;

    initPush(phone, role, saleCode).then(function (res) {
      if (res && res.ok) {
        console.log('[push] auto re-subscribed on page load, phone:', phone, 'role:', role);
      } else {
        console.warn('[push] auto re-subscribe failed:', res && res.error);
      }
    }).catch(function (err) {
      console.warn('[push] auto re-subscribe exception:', err);
    });
  }

  // Wait for DOM to be ready before reading localStorage session
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryAutoSubscribe);
  } else {
    // Small delay to allow app.js to restore session first
    setTimeout(tryAutoSubscribe, 800);
  }
})();
