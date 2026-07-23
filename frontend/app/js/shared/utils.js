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

  const tl = String(type || '').toLowerCase();
  if (tl.includes('logo')) {
    return allBrands.filter(b => !['Bivina', 'Bivina Export', 'Shopname'].includes(b));
  }
  // Prefer detecting "hộp"/"hộp đèn" before generic "bảng"
  if (tl.includes('hộp') || tl.includes('hop') || tl.includes('hộp đèn')) {
    return allBrands.filter(b => !['Heineken', 'Strongbow'].includes(b));
  }
  if (tl.includes('bảng')) {
    return allBrands.filter(b => !['Heineken', 'Strongbow'].includes(b));
  }

  return allBrands;
}

function sanitizeDecimalInput(el) {
  if (!el) return;
  const raw = String(el.value || '');
  const selStart = (typeof el.selectionStart === 'number') ? el.selectionStart : null;

  let v = raw.replace(/,/g, '.');
  v = v.replace(/[^0-9.]/g, '');
  const parts = v.split('.');
  if (parts.length > 2) v = parts.shift() + '.' + parts.join('');

  el.value = v;

  if (selStart !== null) {
    try {
      const beforeLeft = raw.slice(0, selStart);
      const cleanedLeft = beforeLeft.replace(/,/g, '.').replace(/[^0-9.]/g, '');
      const newPos = cleanedLeft.length;
      el.setSelectionRange(newPos, newPos);
    } catch (e) {
      // ignore — some input types or browsers may not support selection range
    }
  }
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

// Strip any non-digit characters (disallow decimal separator)
function sanitizeNoDecimalInput(el) {
  if (!el) return;
  el.value = String(el.value || '').replace(/[^0-9]/g, '');
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
  try { if (typeof window.scheduleDraftSave === 'function') window.scheduleDraftSave(800); } catch (e) {}
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

function normalizeVietnameseAccents(str) {
  if (typeof str !== 'string') return str;

  // Chuyển chuỗi về dạng Unicode dựng sẵn NFC chuẩn
  let text = str.normalize('NFC');

  // 1. Chuẩn hóa tổ hợp "oa" và "oe"
  // Quy tắc chuẩn tiếng Việt:
  // - Nếu có phụ âm kết thúc âm tiết (theo sau bởi ký tự chữ cái [a-zA-Z]),
  //   thì dấu phải đặt ở nguyên âm sau: oá, oà, oả, oã, oạ / oé, oè, oẻ, oẽ, oẹ.
  // - Nếu không có phụ âm kết thúc (đứng cuối từ/âm tiết), dấu đặt ở nguyên âm trước: óa, òa, ỏa, õa, ọa / óe, òe, ỏe, õe, ọe.

  // 1.1. Trường hợp theo sau bởi chữ cái -> Chuyển dấu từ O/E sang A/E (toàn, loài, hoét, khoẻ...)
  const oaToA = [
    [/óa(?=[a-zA-Z])/g, 'oá'], [/òa(?=[a-zA-Z])/g, 'oà'], [/ỏa(?=[a-zA-Z])/g, 'oả'], [/õa(?=[a-zA-Z])/g, 'oã'], [/ọa(?=[a-zA-Z])/g, 'oạ'],
    [/ÓA(?=[a-zA-Z])/g, 'OÁ'], [/ÒA(?=[a-zA-Z])/g, 'OÀ'], [/ỎA(?=[a-zA-Z])/g, 'OẢ'], [/ÕA(?=[a-zA-Z])/g, 'OÃ'], [/ỌA(?=[a-zA-Z])/g, 'OẠ']
  ];
  for (const [pattern, replacement] of oaToA) {
    text = text.replace(pattern, replacement);
  }

  const oeToE = [
    [/óe(?=[a-zA-Z])/g, 'oé'], [/òe(?=[a-zA-Z])/g, 'oè'], [/ỏe(?=[a-zA-Z])/g, 'oẻ'], [/õe(?=[a-zA-Z])/g, 'oẽ'], [/ọe(?=[a-zA-Z])/g, 'oẹ'],
    [/ÓE(?=[a-zA-Z])/g, 'OÉ'], [/ÒE(?=[a-zA-Z])/g, 'OÈ'], [/ỎE(?=[a-zA-Z])/g, 'OẺ'], [/ÕE(?=[a-zA-Z])/g, 'OẼ'], [/ỌE(?=[a-zA-Z])/g, 'OẸ']
  ];
  for (const [pattern, replacement] of oeToE) {
    text = text.replace(pattern, replacement);
  }

  // 1.2. Trường hợp KHÔNG theo sau bởi chữ cái -> Chuyển dấu từ A/E sang O/E (hòa, hóa, khỏe...)
  const oaToO = [
    [/oá(?![a-zA-Z])/g, 'óa'], [/oà(?![a-zA-Z])/g, 'òa'], [/oả(?![a-zA-Z])/g, 'ỏa'], [/oã(?![a-zA-Z])/g, 'õa'], [/oạ(?![a-zA-Z])/g, 'ọa'],
    [/OÁ(?![a-zA-Z])/g, 'ÓA'], [/OÀ(?![a-zA-Z])/g, 'ÒA'], [/OẢ(?![a-zA-Z])/g, 'ỎA'], [/OÃ(?![a-zA-Z])/g, 'ÕA'], [/OẠ(?![a-zA-Z])/g, 'ỌA']
  ];
  for (const [pattern, replacement] of oaToO) {
    text = text.replace(pattern, replacement);
  }

  const oeToO = [
    [/oé(?![a-zA-Z])/g, 'óe'], [/oè(?![a-zA-Z])/g, 'òe'], [/oẻ(?![a-zA-Z])/g, 'ỏe'], [/oẽ(?![a-zA-Z])/g, 'õe'], [/oẹ(?![a-zA-Z])/g, 'ọe'],
    [/OÉ(?![a-zA-Z])/g, 'ÓE'], [/OÈ(?![a-zA-Z])/g, 'ÒE'], [/OẺ(?![a-zA-Z])/g, 'ỎE'], [/OẼ(?![a-zA-Z])/g, 'ÕE'], [/OẸ(?![a-zA-Z])/g, 'ỌE']
  ];
  for (const [pattern, replacement] of oeToO) {
    text = text.replace(pattern, replacement);
  }

  // 2. Chuẩn hóa tổ hợp "uy" (uý, uỳ, uỷ, uỹ, uỵ -> úy, ùy, ủy, ũy, cụy)
  const uyMap = { 'uý': 'úy', 'uỳ': 'ùy', 'uỷ': 'ủy', 'uỹ': 'ũy', 'uỵ': 'ụy' };
  text = text.replace(/([qQ]?)u([ýỳỷỹỵ])(?![nNcCtT])/g, (match, prefix, accent) => {
    if (prefix) return match;
    const key = 'u' + accent;
    return uyMap[key] || match;
  });

  const uyMapUpper = { 'UÝ': 'ÚY', 'UỲ': 'ÙY', 'UỶ': 'ỦY', 'UỸ': 'ŨY', 'UỴ': 'ỤY' };
  text = text.replace(/([qQ]?)U([ÝỲỶỸỴ])(?![nNcCtT])/g, (match, prefix, accent) => {
    if (prefix) return match;
    const key = 'U' + accent;
    return uyMapUpper[key] || match;
  });

  return text;
}
