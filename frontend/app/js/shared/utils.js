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
    const tl = t.toLowerCase();
    // Bảng Alu Nhà Phân Phối hoặc khi đang ở kênh NPP: cố định brand Heineken
    if (tl.includes('alu') || t === 'Bảng Alu Nhà Phân Phối' || t === 'Bảng Alu NPP') {
      return ['Heineken'];
    }
    if (typeof currentSession !== 'undefined' && currentSession && (currentSession.saleType === 'npp' || currentSession.isNPP)) {
      return ['Heineken'];
    }
    if (tl.includes('emlemd') || tl.includes('emblemd') || t === 'Logo indoor - Emlemd 2 mặt' || t === 'Logo indoor 2 mặt (Emblemd)') {
      return ['Tiger'];
    }
    if (tl.includes('mái che di động') || tl.includes('mai che di dong') || tl.includes('mái hiên di động') || tl.includes('mai hien di dong') || t === 'Mái che di động') {
      return ['Tiger'];
    }
    if (tl.includes('rèm mái che') || tl.includes('rem mai che') || t === 'Rèm Mái Che') {
      return ['Tiger', 'Bivina', 'Bia Việt', 'Larue'];
    }
    if (tl.includes('tranh đèn') || tl.includes('tranh den') || t === 'Logo indoor - Tranh đèn') {
      return ['Tiger'];
    }
    if (tl.includes('tiger square') || t === 'Logo indoor - Tiger Square (1 mặt treo tường)') {
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

function getActionsForItem(type, item) {
  const tl = String(type || (item && item.type) || '').toLowerCase();
  const st = String((item && item.subType) || '').toLowerCase();
  const isAluNPP = tl === 'bảng alu npp' || tl.includes('alu');
  const isTranhDen = tl.includes('tranh đèn') || tl.includes('tranh den') || tl.includes('light poster') || st.includes('tranh đèn') || st.includes('tranh den') || st.includes('light poster');
  const isLogo = tl.includes('logo') || tl.includes('emblemd') || tl.includes('emlemd');
  const isRem = tl.includes('rèm') || tl.includes('rem');
  const isMaiChe = !isRem && (tl.includes('mái che') || tl.includes('mai che') || tl.includes('mái hiên') || tl.includes('mai hien'));

  if (isAluNPP) {
    return ['Làm mới', 'Sửa chữa'];
  }
  if (isMaiChe || isRem) {
    return ['Làm mới'];
  }
  if (isTranhDen) {
    return ['Làm mới', 'Thay Poster', 'Sửa chữa', 'Di dời', 'Thu hồi'];
  }
  if (isLogo) {
    return ['Làm mới', 'Sửa chữa', 'Di dời', 'Thu hồi'];
  }
  return ['Làm mới', 'Thay bạt'];
}

function isPolesDisabledType(type, item) {
  const t = String(type || (item && item.type) || '').toLowerCase();
  const st = String((item && item.subType) || '').toLowerCase();
  if (st.includes('tranh đèn') || st.includes('tranh den') || st.includes('light poster')) return true;
  return t.includes('mái che') || t.includes('mai che') || t.includes('mái hiên') || t.includes('mai hien') || t.includes('rèm') || t.includes('rem') || t.includes('tranh đèn') || t.includes('tranh den') || t.includes('light poster');
}

function getLogoSubTypeLabel(subType) {
  if (!subType) return '';
  const sl = String(subType).toLowerCase();
  if (sl.includes('tranh đèn') || sl.includes('tranh den') || sl.includes('light poster')) {
    return 'Light Poster - Tranh đèn';
  }
  if (sl.includes('emlemd') || sl.includes('emblemd')) {
    return 'Emlemd 2 mặt';
  }
  if (sl.includes('square') || sl.includes('suqare')) {
    return 'Suqare Flat 1 mặt (treo tường)';
  }
  if (sl.includes('group social') || sl.includes('ngôi sao') || sl.includes('ngoi sao')) {
    return 'Group Social (Model Ngôi Sao)';
  }
  if (sl.includes('young social') || sl.includes('lưới') || sl.includes('luoi')) {
    return 'Young Social (Model Lưới)';
  }
  return subType;
}

function getTigerSubTypeLabel(subType) {
  return getLogoSubTypeLabel(subType);
}

function getMatchingHeinekenPair(subType, changedField, value) {
  const s = String(subType || '').toLowerCase();
  let pairs = [];
  if (s.includes('group social') || s.includes('ngôi sao') || s.includes('ngoi sao')) {
    pairs = [
      { width: 0.6, height: 0.9 },
      { width: 0.8, height: 1.2 },
      { width: 1.0, height: 1.5 }
    ];
  } else if (s.includes('young social') || s.includes('lưới') || s.includes('luoi')) {
    pairs = [
      { width: 0.68, height: 0.9 },
      { width: 0.9, height: 1.186 }
    ];
  }
  if (!pairs.length) return null;
  const num = parseFloat(value);
  if (isNaN(num)) return null;

  if (changedField === 'width') {
    return pairs.find(p => Math.abs(p.width - num) < 0.001) || null;
  } else if (changedField === 'height') {
    return pairs.find(p => Math.abs(p.height - num) < 0.001) || null;
  }
  return null;
}

function getMatchingOutdoorLogoPair(brand, changedField, value) {
  const b = String(brand || '').toLowerCase();
  let pairs = [];
  if (b.includes('heineken')) {
    pairs = (typeof heinekenOutdoorSizes !== 'undefined' ? heinekenOutdoorSizes : [
      { width: 1.5, height: 0.75 },
      { width: 2.0, height: 1.0 },
      { width: 3.0, height: 1.5 },
      { width: 4.0, height: 2.0 },
      { width: 5.0, height: 2.5 }
    ]);
  } else if (b.includes('tiger')) {
    pairs = (typeof tigerOutdoorSizes !== 'undefined' ? tigerOutdoorSizes : [
      { width: 1.5, height: 0.5 },
      { width: 2.4, height: 0.8 },
      { width: 3.0, height: 1.0 },
      { width: 3.9, height: 1.3 },
      { width: 4.5, height: 1.5 }
    ]);
  }
  if (!pairs.length) return null;
  const num = parseFloat(value);
  if (isNaN(num)) return null;

  if (changedField === 'width') {
    return pairs.find(p => Math.abs(p.width - num) < 0.001) || null;
  } else if (changedField === 'height') {
    return pairs.find(p => Math.abs(p.height - num) < 0.001) || null;
  }
  return null;
}

function getItemDisplayName(item) {
  if (!item) return '-';
  const raw = String(item.type || item.product_name || item.name || '-').trim();
  const sLower = raw.toLowerCase();

  let formatted = raw;
  if (sLower.includes('shopname') || sLower.includes('shop name') || sLower.includes('tên quán')) {
    formatted = 'Shopname';
  } else if (sLower.includes('hộp đèn') || sLower.includes('hop den')) {
    if (sLower.includes('2 mặt') || sLower.includes('hai mặt') || sLower.includes('2 mat')) {
      formatted = 'Hộp đèn hiflex 2 mặt';
    } else {
      formatted = 'Hộp đèn hiflex 1 mặt';
    }
  } else if (sLower.includes('giả hộp') || sLower.includes('gia hop')) {
    if (sLower.includes('2 mặt') || sLower.includes('hai mặt') || sLower.includes('2 mat')) {
      formatted = 'Bảng hiệu giả hộp hiflex 2 mặt';
    } else {
      formatted = 'Bảng hiệu giả hộp hiflex 1 mặt';
    }
  } else if (sLower.includes('bảng hiệu hiflex') || sLower.includes('bang hieu hiflex') || sLower.includes('bảng hiflex') || sLower.includes('bang hiflex')) {
    if (sLower.includes('2 mặt') || sLower.includes('hai mặt') || sLower.includes('không đèn') || sLower.includes('khong den') || sLower.includes('2 mat')) {
      formatted = 'Bảng hiflex 2 mặt (KHÔNG ĐÈN)';
    } else {
      formatted = 'Bảng hiflex 1 mặt';
    }
  } else if (sLower.includes('alu')) {
    formatted = 'Bảng Alu Nhà Phân Phối';
  } else if (sLower.includes('mái che') || sLower.includes('mai che') || sLower.includes('mái hiên') || sLower.includes('mai hien')) {
    formatted = 'Mái che di động';
  } else if (sLower.includes('rèm') || sLower.includes('rem')) {
    formatted = 'Rèm Mái Che';
  } else if (sLower.includes('logo')) {
    if (sLower.includes('outdoor') || sLower.includes('ngoài trời') || sLower.includes('icon')) {
      formatted = 'Logo Outdoor';
    } else {
      formatted = 'Logo indoor';
    }
  } else {
    formatted = raw
      .replace(/^(thay bạt|làm mới|sản xuất mới|thi công|gia công)\s+/gi, '')
      .replace(/\s*\((in 2 mặt|in 1 mặt|in hai mặt|in một mặt|in bạt.*?)\)/gi, '')
      .trim() || raw;
  }

  if (item.subType && item.subType !== 'Khác') {
    const tl = formatted.toLowerCase();
    if (tl.includes('logo indoor') && !formatted.includes('-') && typeof getTigerSubTypeLabel === 'function') {
      return `${formatted} - ${getTigerSubTypeLabel(item.subType)}`;
    }
  }
  return formatted;
}

function showDefaultFieldToast(e) {
  if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
  if (e && typeof e.preventDefault === 'function') e.preventDefault();
  if (typeof showToast === 'function') {
    showToast('Hạng mục này đã được mặc định những thông tin này không thể thay đổi');
  }
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

  if (field === 'heinekenWidth' || field === 'heinekenHeight' || field === 'outdoorLogoWidth' || field === 'outdoorLogoHeight') {
    options.classList.add('dropup');
  }

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
    if (['heinekenWidth', 'heinekenHeight', 'outdoorLogoWidth', 'outdoorLogoHeight'].includes(field)) {
      const wTrig = document.getElementById(`width-${id}`);
      const hTrig = document.getElementById(`height-${id}`);
      if (wTrig) wTrig.classList.remove('field-error');
      if (hTrig) hTrig.classList.remove('field-error');
    }
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

/**
 * _resolveQcagStatus — Ánh xạ trạng thái QCAG theo đúng thuật toán computeQCAGStatus từ App 1.
 * Vòng đời: Chưa có báo giá -> Chưa có SPO -> Chờ Admin/ASM duyệt -> Chờ ra đơn hàng -> Đã ra đơn hàng -> Đang sản xuất -> Hoàn thành.
 */
function _resolveQcagStatus(q) {
  if (!q) return { label: 'Chưa có báo giá', cls: 'hk-status-badge hk-status-amber bg-amber-500/20 text-amber-300 border border-amber-500/40' };

  // Priority 0: Cancellation status
  const cancelSt = String(q.cancellation_status || q.cancellationStatus || '').toLowerCase().trim();
  if (cancelSt === 'requested') return { label: 'Báo hủy', cls: 'hk-status-badge hk-status-red bg-red-600/30 text-red-300 border border-red-500/50' };
  if (cancelSt === 'confirmed' || cancelSt === 'recreated') return { label: 'Chờ tạo đơn', cls: 'hk-status-badge hk-status-sky bg-sky-600/30 text-sky-300 border border-sky-500/50' };

  // Priority 1: Production Approval
  const prodAppr = String(q.production_approval_status || q.productionApprovalStatus || '').toLowerCase().trim();
  if (prodAppr === 'approved') return { label: 'Đã duyệt sản xuất', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
  if (prodAppr === 'rejected') return { label: 'Từ chối sản xuất', cls: 'hk-status-badge hk-status-red bg-red-600/30 text-red-300 border border-red-500/50' };
  if (prodAppr === 'pending' || prodAppr === 'pending_production') return { label: 'Chờ duyệt sản xuất', cls: 'hk-status-badge hk-status-sky bg-sky-600/30 text-sky-300 border border-sky-500/50' };

  // Priority 2: Explicit QCAG status from DB / UI
  const qcagStRaw = String(q.qcag_override_status || q.qcagOverrideStatus || q.qcag_status || q.qcagStatus || '').trim();
  const qcagStLower = qcagStRaw.toLowerCase();
  if (qcagStRaw) {
    if (qcagStLower.includes('tạm hủy') || qcagStLower.includes('tam huy')) return { label: 'Tạm Hủy', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };
    if (qcagStLower === 'hủy' || qcagStLower === 'huy' || qcagStLower.includes('báo hủy') || qcagStLower.includes('bao huy')) return { label: 'Báo hủy', cls: 'hk-status-badge hk-status-red bg-red-600/30 text-red-300 border border-red-500/50' };
    if (qcagStLower.includes('chờ tạo đơn') || qcagStLower.includes('cho tao don') || qcagStLower.includes('chờ đh') || qcagStLower.includes('cho dh')) return { label: 'Chờ tạo đơn', cls: 'hk-status-badge hk-status-sky bg-sky-600/30 text-sky-300 border border-sky-500/50' };
    if (qcagStLower.includes('thi công xong') || qcagStLower.includes('đã lắp đặt') || qcagStLower.includes('hoàn thành') || qcagStLower.includes('hoan thanh')) return { label: 'Hoàn thành', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
    if (qcagStLower.includes('đang sản xuất') || qcagStLower.includes('dang san xuat') || qcagStLower.includes('đang làm')) return { label: 'Đang sản xuất', cls: 'hk-status-badge hk-status-violet bg-violet-600/30 text-violet-300 border border-violet-500/50' };
    if (qcagStLower.includes('đã ra đơn') || qcagStLower.includes('da ra don')) return { label: 'Đã ra đơn hàng', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
    return { label: qcagStRaw, cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
  }

  // Priority 3: SPO Lifecycle (App 1 standard computeQCAGStatus)
  const spoNumber = String(q.spo_number || q.spoNumber || q.spo_no || q.spoNo || '').trim();
  const rawSpoStatus = String(q.spo_status || q.spoStatus || '').trim();
  const rs = rawSpoStatus.toLowerCase();
  const orderNumber = String(q.order_number || q.orderNumber || '').trim();
  const hasSpo = !!spoNumber;
  const hasOrder = !!orderNumber;

  if (!hasSpo) {
    return { label: 'Chưa có SPO', cls: 'hk-status-badge hk-status-slate bg-slate-600/30 text-slate-300 border border-slate-500/50' };
  }

  if (!rawSpoStatus) {
    return { label: 'Chưa cập nhật trạng thái', cls: 'hk-status-badge hk-status-slate bg-slate-600/30 text-slate-300 border border-slate-500/50' };
  }

  const HUY_STATUSES = [
    'sales rep rejected', 'sign maker rejected', 'sales admin rejected',
    'area sales manager rejected', 'sales admin cancelled',
    'sales supervisor cancelled', 'store keeper cancelled',
    'area sales manager cancelled', 'sales rep cancelled'
  ];
  if (HUY_STATUSES.includes(rs) || rs.includes('cancel') || rs.includes('reject') || rs.includes('từ chối') || rs.includes('hủy')) {
    if (hasOrder) return { label: 'Khẩn cấp', cls: 'hk-status-badge hk-status-red bg-red-600/30 text-red-300 border border-red-500/50' };
    return { label: 'Hủy', cls: 'hk-status-badge hk-status-red bg-red-600/30 text-red-300 border border-red-500/50' };
  }

  if (rs.includes('revised') || rs.includes('rivised') || rs.includes('sửa')) {
    if (!hasOrder) return { label: 'Chờ duyệt lại', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };
    return { label: 'Đang sửa SPO', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };
  }

  if (rs.includes('finish') || rs.includes('hoàn thành')) return { label: 'Hoàn thành', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
  if (rs === 'sales rep accepted' || rs.includes('sale đã nghiệm thu')) return { label: 'Sale đã nghiệm thu', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
  if (rs === 'sign maker installed signage' || rs.includes('chờ sale nghiệm thu')) return { label: 'Chờ sale nghiệm thu', cls: 'hk-status-badge hk-status-sky bg-sky-600/30 text-sky-300 border border-sky-500/50' };

  const isApprovedOrVariation = rs === 'area sales manager approved...' || rs.includes('checked variation') || rs.includes('approved') || rs.includes('duyệt');
  if (isApprovedOrVariation) {
    if (!hasOrder) return { label: 'Chờ ra đơn hàng', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };
    return { label: 'Đã ra đơn hàng', cls: 'hk-status-badge hk-status-emerald bg-emerald-600/30 text-emerald-300 border border-emerald-500/50' };
  }

  if (rs === 'sales supervisor verified') return { label: 'Chờ QCAG up MQ', cls: 'hk-status-badge hk-status-sky bg-sky-600/30 text-sky-300 border border-sky-500/50' };
  if (rs === 'sign maker checked marquette') return { label: 'Chờ Admin duyệt', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };
  if (rs === 'sales admin full checked') return { label: 'Chờ ASM duyệt', cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };

  // Fallback to Sale confirmation or raw SPO status
  if (q.is_confirmed == 1 || q.isConfirmed == 1) return { label: 'Sale đã xác nhận', cls: 'hk-status-badge hk-status-blue bg-blue-600/30 text-blue-300 border border-blue-500/50' };
  if (rawSpoStatus) return { label: rawSpoStatus, cls: 'hk-status-badge hk-status-amber bg-amber-600/30 text-amber-300 border border-amber-500/50' };

  // Mặc định khi đã có báo giá nhưng chưa có SPO
  return { label: 'Chưa có SPO', cls: 'hk-status-badge hk-status-slate bg-slate-600/30 text-slate-300 border border-slate-500/50' };
}
window._resolveQcagStatus = _resolveQcagStatus;

/**
 * Kiểm tra danh sách items có chứa ít nhất 1 hạng mục bảng hiệu/hộp đèn/mặt bạt hay không.
 * Nếu có ít nhất 1 item loại này, chắc chắn yêu cầu phải có nội dung bảng hiệu (mới hoặc cũ).
 */
function qcagHasSignageItems(items) {
  if (!items) return false;
  let arr = items;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch (_) { return false; }
  }
  if (!Array.isArray(arr) || arr.length === 0) return false;
  return arr.some(it => {
    if (!it) return false;
    const txt = String(it.type || it.product_name || it.name || it.item_type || it.content || it.category || '').toLowerCase().trim();
    // Loại trừ các mục thủ tục, hành chính, chi phí, hoặc thuần Logo
    if (txt.includes('giấy phép') || txt.includes('xin phép') || txt.includes('hồ sơ') ||
        txt.includes('phí') || txt.includes('vận chuyển') || txt.includes('tháo dỡ')) {
      return false;
    }
    if (txt.includes('logo') && !txt.includes('bảng') && !txt.includes('hộp đèn') && !txt.includes('alu') && !txt.includes('bạt')) {
      return false;
    }
    // Các hạng mục biển hiệu, hộp đèn, bạt in, alu, decal, mica, chữ nổi, mái che, rèm...
    return txt.includes('bảng') || txt.includes('bang') ||
           txt.includes('hộp đèn') || txt.includes('hop den') ||
           txt.includes('mái che') || txt.includes('mai che') ||
           txt.includes('mái hiên') || txt.includes('mai hien') ||
           txt.includes('rèm') || txt.includes('rem') ||
           txt.includes('alu') || txt.includes('hiflex') ||
           txt.includes('bạt') || txt.includes('bat') ||
           txt.includes('decal') || txt.includes('mica') ||
           txt.includes('chữ nổi') || txt.includes('chu noi') ||
           txt.includes('poster') || txt.includes('standee') ||
           txt.includes('in ấn') || txt.includes('in ');
  });
}
window.qcagHasSignageItems = qcagHasSignageItems;

/**
 * Phân giải chuẩn xác Nội dung bảng hiệu của một yêu cầu / báo giá.
 * NGUYÊN TẮC: Nếu có ít nhất 1 item bảng hiệu thì CHẮC CHẮN PHẢI CÓ NỘI DUNG.
 * - Nếu có text nội dung mới: hiển thị text đó (kèm badge Nội dung cũ nếu có cờ cũ).
 * - Nếu không có text nội dung mới nhưng có ít nhất 1 item bảng hiệu:
 *   Bắt buộc xem là "Nội dung cũ" (kèm yêu cầu thêm nếu có), tuyệt đối không để trống hay ghi "Không có nội dung".
 * - Chỉ khi hoàn toàn không có item bảng hiệu và không có chữ thì mới ghi "Hạng mục này không có nội dung".
 */
function qcagResolveSignageContent(req) {
  if (!req || typeof req !== 'object') {
    return {
      hasSignage: false,
      hasSignageContent: false,
      isOld: false,
      rawContent: '',
      oldExtra: '',
      displayText: 'Hạng mục này không có nội dung',
      oldImgs: []
    };
  }

  const checkBool = val => val === true || val === 1 || String(val).toLowerCase() === 'true' || String(val) === '1';

  // 1. Trích xuất items
  let items = req.items || [];
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (_) { items = []; }
  }
  const hasSignage = qcagHasSignageItems(items);

  // 2. Trích xuất cờ old_content
  let isOld = Boolean(
    checkBool(req.oldContent) || checkBool(req.old_content) ||
    checkBool(req.isOldContent) || checkBool(req.is_old_content) ||
    checkBool(req.useOldContent) || checkBool(req.use_old_content)
  );

  // 3. Trích xuất text content sạch
  let rawContent = (req.content || req.signContent || req.signboard_content || '').trim();
  if (rawContent.startsWith('[{') || rawContent === '[]' || rawContent === '{}' ||
      rawContent === 'null' || rawContent === 'undefined' || rawContent === '""') {
    rawContent = '';
  }

  // 4. Trích xuất oldContentExtra
  const oldExtra = String(req.oldContentExtra || req.old_content_extra || '').trim();

  // 5. Trích xuất oldContentImages
  let oldImgs = [];
  const rawOldImgs = req.oldContentImages || req.old_content_images;
  if (Array.isArray(rawOldImgs)) {
    oldImgs = rawOldImgs;
  } else if (typeof rawOldImgs === 'string') {
    try {
      const parsed = JSON.parse(rawOldImgs);
      if (Array.isArray(parsed)) oldImgs = parsed;
      else if (rawOldImgs.startsWith('http')) oldImgs = [rawOldImgs];
    } catch (_) {
      if (rawOldImgs.startsWith('http')) oldImgs = [rawOldImgs];
    }
  }

  const hasActualText = rawContent.length > 0;

  // QUY TẮC CỐT LÕI: Nếu có ít nhất 1 item bảng hiệu:
  // - Nếu chưa có text mới: BẮT BUỘC coi là Nội dung cũ (isOld = true)!
  if (hasSignage && !hasActualText) {
    isOld = true;
  }

  const hasSignageContent = hasActualText || isOld || hasSignage;

  let displayText = '';
  if (hasActualText) {
    if (isOld) {
      displayText = oldExtra ? `Nội dung cũ (${oldExtra}): ${rawContent}` : `[Nội dung cũ] ${rawContent}`;
    } else {
      displayText = rawContent;
    }
  } else if (isOld || hasSignage) {
    displayText = oldExtra ? `Nội dung cũ (${oldExtra})` : 'Nội dung cũ';
  } else {
    displayText = 'Hạng mục này không có nội dung';
  }

  return {
    hasSignage,
    hasSignageContent,
    isOld,
    rawContent,
    oldExtra,
    displayText,
    oldImgs
  };
}
window.qcagResolveSignageContent = qcagResolveSignageContent;

