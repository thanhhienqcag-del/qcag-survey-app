// ====================================================================
// js/shared/utils.js — pure utility/helper functions
// ====================================================================
'use strict';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getBrandsForType(type) {
  try {
    const t = String(type || '');
    if (t.includes('Emblemd') || t === 'Logo indoor 2 mặt (Emblemd)') {
      return ['Tiger'];
    }
  } catch (e) {}

  if (String(type || '').includes('Logo')) {
    return allBrands.filter(b => !['Bivina', 'Bivina Export', 'Shopname'].includes(b));
  }

  if (String(type || '').includes('Bảng') || String(type || '').includes('Hộp đèn')) {
    return allBrands.filter(b => !['Heineken', 'Strongbow'].includes(b));
  }

  return allBrands;
}

function sanitizeDecimalInput(el) {
  if (!el) return;
  let v = String(el.value || '');
  v = v.replace(/,/g, '.');
  v = v.replace(/[^0-9.]/g, '');
  const parts = v.split('.');
  if (parts.length > 2) v = parts.shift() + '.' + parts.join('');
  el.value = v;
}

function sanitizeIntegerInput(el) {
  if (!el) return;
  const raw = String(el.value || '').trim();
  try {
    const digits = normalizeVietnamPhone(raw);
    if (digits.startsWith('02')) {
      el.value = digits.slice(0, 11);
    } else {
      el.value = digits.slice(0, 10);
    }
  } catch (e) {
    el.value = String(el.value || '').replace(/\D/g, '').slice(0, 10);
  }
}

function sanitizeOutletCodeInput(el) {
  if (!el) return;
  const raw = String(el.value || '');
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  el.value = digits;
  try { if (typeof checkOutletDuplicate === 'function') checkOutletDuplicate(); } catch (e) {}
}

function normalizeVietnamPhone(raw) {
  if (!raw) return '';
  let s = String(raw || '').trim();
  s = s.replace(/[\s\-().]/g, '');
  if (s.startsWith('+84')) {
    s = '0' + s.slice(3);
  } else if (s.startsWith('84') && !s.startsWith('0')) {
    s = '0' + s.slice(2);
  }
  s = s.replace(/\D/g, '');
  return s;
}

function toggleCustomSelect(e, id, field) {
  if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
  const container = document.querySelector(`.custom-select[data-id="${id}"][data-field="${field}"]`);
  if (!container) return;
  const options = container.querySelector('.cs-options');
  if (!options) return;

  const isHidden = options.classList.contains('hidden');
  closeAllCustomSelects();
  if (isHidden) options.classList.remove('hidden');
}

function chooseCustomOption(id, field, value) {
  updateRequestItem(id, field, value);
  closeAllCustomSelects();

  // Clear validation highlight for this custom-select trigger when user picks an option
  try {
    const trig = document.querySelector(`.custom-select[data-id="${id}"][data-field="${field}"] .cs-trigger`);
    if (trig) trig.classList.remove('field-error');
  } catch (e) {}

  try {
    if (field === 'type' && Array.isArray(currentRequestItems)) {
      const idx = currentRequestItems.findIndex(i => i.id === id);
      if (idx >= 1) {
        setTimeout(() => {
          const el = document.getElementById(`requestItem-${id}`);
          if (!el) return;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 80);
      }
    }
  } catch (e) {}
}

function closeAllCustomSelects() {
  document.querySelectorAll('.cs-options').forEach(el => el.classList.add('hidden'));
}

document.addEventListener('click', () => {
  closeAllCustomSelects();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllCustomSelects();
});
