// ====================================================================
// js/shared/ui.js — toast notification and generic modal helpers
// ====================================================================
'use strict';

// Dismiss the on-screen keyboard before showing a modal overlay
function blurActiveInput() {
  try {
    const el = document.activeElement;
    if (el && typeof el.blur === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
      el.blur();
    }
  } catch (e) {}
}

let _toastTimer = null;
function showToast(message, durationMs) {
  const toast = document.getElementById('toast');
  const toastInner = document.getElementById('toastInner');
  if (!toastInner) return;
  document.getElementById('toastMessage').textContent = message;
  // Position at top of visual viewport so it's visible even when keyboard is open
  if (window.visualViewport) {
    const vp = window.visualViewport;
    toast.style.top = (vp.offsetTop + 24) + 'px';
    toast.style.left = vp.offsetLeft + 'px';
    toast.style.width = vp.width + 'px';
  }
  // Cancel any previous auto-hide timer so the new toast gets its full duration
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  // Drop from above: remove hidden translate/scale/opacity, add visible classes
  toastInner.classList.remove('opacity-0', 'scale-90', '-translate-y-20');
  toastInner.classList.add('opacity-100', 'scale-100', 'translate-y-0');
  _toastTimer = setTimeout(() => {
    _toastTimer = null;
    // hide by reverting to initial hidden state (move up + shrink + fade)
    toastInner.classList.remove('opacity-100', 'scale-100', 'translate-y-0');
    toastInner.classList.add('opacity-0', 'scale-90', '-translate-y-20');
    // Reset inline styles
    toast.style.top = '';
    toast.style.left = '';
    toast.style.width = '';
  }, durationMs || 2500);
}

// Toggle a modal backdrop class that blurs and disables the background
function enableModalBackdrop() {
  try {
    document.body.classList.add('modal-open');
  } catch (e) {}
}

function disableModalBackdrop() {
  try {
    document.body.classList.remove('modal-open');
  } catch (e) {}
}
