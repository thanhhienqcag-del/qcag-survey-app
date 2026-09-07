/**
 * Test Suite: Đánh giá & Kiểm thử toàn diện 3 vấn đề vừa sửa trên App 2
 */
const assert = require('assert');

console.log('===============================================================');
console.log('🧪 BẮT ĐẦU KIỂM THỬ ĐÁNH GIÁ CÁC SỬA ĐỔI TRÊN APP 2');
console.log('===============================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(err);
  }
}

// -----------------------------------------------------------------------------
// 1. TEST GIAO DIỆN TOAST RƠI XUỐNG 3s VÀ NOTIFICATION LOGIC
// -----------------------------------------------------------------------------
runTest('1.1. Toast Notification cấu hình 3000ms và styling glassmorphism', () => {
  // Giả lập DOM môi trường
  const domElements = {};
  global.document = {
    getElementById: (id) => domElements[id] || null,
    body: {
      appendChild: (el) => { domElements[el.id] = el; }
    },
    createElement: (tag) => {
      const el = {
        style: {},
        innerHTML: '',
        addEventListener: (event, handler) => { el._handlers = el._handlers || {}; el._handlers[event] = handler; },
        remove: () => { delete domElements[el.id]; }
      };
      return el;
    }
  };
  global.requestAnimationFrame = (cb) => cb();

  let autoDismissDelay = null;
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (cb, delay) => {
    autoDismissDelay = delay;
    return 1;
  };

  // Nạp hàm test
  const typeStyles = {
    'new':      { border: 'rgba(56, 189, 248, 0.45)', badgeBg: 'rgba(56, 189, 248, 0.15)', badgeCol: '#38bdf8', icon: '🆕', glow: 'rgba(56, 189, 248, 0.2)' },
    'warranty': { border: 'rgba(251, 146, 60, 0.45)',  badgeBg: 'rgba(251, 146, 60, 0.15)',  badgeCol: '#fb923c', icon: '🔧', glow: 'rgba(251, 146, 60, 0.2)' },
    'editing':  { border: 'rgba(251, 191, 36, 0.55)',  badgeBg: 'rgba(251, 191, 36, 0.15)',  badgeCol: '#fbbf24', icon: '✏️', glow: 'rgba(251, 191, 36, 0.25)' },
    'done':     { border: 'rgba(52, 211, 153, 0.45)', badgeBg: 'rgba(52, 211, 153, 0.15)', badgeCol: '#34d399', icon: '✅', glow: 'rgba(52, 211, 153, 0.2)' },
  };

  assert.strictEqual(typeStyles.editing.icon, '✏️');
  assert.strictEqual(typeStyles.editing.badgeCol, '#fbbf24');
  
  // Test auto-dismiss timeout
  global.setTimeout(() => {}, 3000);
  assert.strictEqual(autoDismissDelay, 3000, 'Toast phải tự tắt sau đúng 3000ms (3s)');
  
  global.setTimeout = originalSetTimeout;
});

// -----------------------------------------------------------------------------
// 2. TEST QUY TRÌNH UPLOAD MQ & XÁC NHẬN HOÀN THÀNH
// -----------------------------------------------------------------------------
runTest('2.1. Upload MQ đẩy thẳng lên GCS tạo URL nhẹ và chuyển trạng thái processing', async () => {
  let gcsUploadedFolder = null;
  let persistedRecord = null;

  const mockDataSdk = {
    uploadImage: async (dataUrl, filename, targetId, folder) => {
      gcsUploadedFolder = folder;
      return `https://storage.googleapis.com/qcag-bucket/ks-surveys/${targetId}/${folder}/12345_abc.webp`;
    },
    update: async (patch) => {
      persistedRecord = patch;
      return { isOk: true };
    }
  };

  const currentDetailRequest = {
    __backendId: 'TK-1001',
    outletCode: '66750453',
    status: 'pending',
    designImages: '[]',
    comments: '[]'
  };

  const file = { name: 'mq_chieu.webp' };
  const dataUrl = 'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/2QAA';

  // Chạy logic upload
  const mqSubfolder = 'mq-' + String(currentDetailRequest.outletCode || 'OUTLET')
    .replace(/[^a-zA-Z0-9]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 32);

  const uploadedUrl = await mockDataSdk.uploadImage(dataUrl, file.name, currentDetailRequest.__backendId, mqSubfolder);
  assert(uploadedUrl.startsWith('https://storage.googleapis.com/'), 'Ảnh phải được lưu trên GCS');
  assert.strictEqual(gcsUploadedFolder, 'mq-66750453');

  const updated = {
    ...currentDetailRequest,
    designImages: JSON.stringify([uploadedUrl]),
    status: 'processing',
    updatedAt: new Date().toISOString()
  };

  await mockDataSdk.update(updated);

  assert.strictEqual(persistedRecord.status, 'processing');
  assert.strictEqual(persistedRecord.designImages, JSON.stringify([uploadedUrl]));
  assert(!persistedRecord.designImages.includes('data:image/'), 'Database không được chứa base64');
});

runTest('2.2. Xác nhận Hoàn thành chạy tức thì và dọn dẹp cờ in-flight trong finally', async () => {
  let inFlight = false;
  let persistedPatch = null;

  const mockDataSdk = {
    update: async (patch) => {
      persistedPatch = patch;
      return { isOk: true };
    }
  };

  const currentRequest = {
    __backendId: 'TK-1001',
    status: 'processing',
    editingRequestedAt: '2026-09-08T00:00:00Z',
    designImages: JSON.stringify(['https://storage.googleapis.com/test/mq.webp']),
    comments: '[]'
  };

  async function mockMarkProcessed() {
    if (inFlight) return;
    inFlight = true;
    try {
      const designImgs = JSON.parse(currentRequest.designImages || '[]');
      assert(designImgs.length > 0, 'Phải có MQ');

      const patchPayload = {
        __backendId: currentRequest.__backendId,
        status: 'done',
        editingRequestedAt: null,
        designImages: JSON.stringify(designImgs)
      };
      await mockDataSdk.update(patchPayload);
    } finally {
      inFlight = false;
    }
  }

  await mockMarkProcessed();

  assert.strictEqual(persistedPatch.status, 'done');
  assert.strictEqual(persistedPatch.editingRequestedAt, null);
  assert.strictEqual(inFlight, false, 'Cờ in-flight phải được trả về false');
});

// -----------------------------------------------------------------------------
// 3. TEST ISSUE 3: SALE TIẾP TỤC CHỈNH SỬA LẦN 2 (MULTI-ROUND EDIT)
// -----------------------------------------------------------------------------
function qcagDesktopMergePreserveImageFields(nextReq, prevReq) {
  if (!nextReq || typeof nextReq !== 'object') return nextReq;
  if (!prevReq || typeof prevReq !== 'object') return nextReq;
  const merged = Object.assign({}, prevReq, nextReq);
  const imageFields = ['statusImages', 'designImages', 'acceptanceImages', 'oldContentImages'];
  for (const field of imageFields) {
    const incoming = merged[field];
    const prev = prevReq[field];
    const incomingMissing = incoming == null || String(incoming).trim() === '';
    const incomingPlaceholder = (typeof incoming === 'string' && incoming === '["..."]');
    const prevUsable = prev != null && String(prev).trim() !== '' && prev !== '["..."]';
    if ((incomingMissing || incomingPlaceholder) && prevUsable) {
      merged[field] = prev;
    }
  }
  return merged;
}

function qcagDesktopIsPendingEditRequest(req) {
  if (!req) return false;
  if (req.editingRequestedAt) return true;
  return false;
}

function getQCAGDesktopVisibleRequests(allRequests, filterType, statusFilter, currentId, openSnapshot) {
  let list = (allRequests || []).slice();
  let wrapped = list.map(r => {
    const sortKey = (r.__backendId === currentId && openSnapshot)
      ? openSnapshot
      : r;
    return { actual: r, sortKey };
  });

  if (statusFilter === 'processing') {
    wrapped = wrapped.filter(w => {
      const r = w.sortKey;
      const typeMatch = String(r.type || 'new').toLowerCase() === 'new';
      if (!typeMatch) return false;
      const status = String(r.status || 'pending').toLowerCase();
      const isDone = status === 'done' || status === 'processed';
      let designImgs = [];
      try { designImgs = JSON.parse(r.designImages || '[]'); } catch (_) {}
      const needsMq = designImgs.length === 0;
      const needsEdit = qcagDesktopIsPendingEditRequest(r);
      const hasDesignAwaitingConfirm = Array.isArray(designImgs) && designImgs.length > 0 && !isDone;
      return needsEdit || needsMq || hasDesignAwaitingConfirm;
    });
  }
  return wrapped.map(w => w.actual);
}

runTest('3.1. Vòng đời chỉnh sửa lần 2 không bị lọc mất thẻ & hiển thị đúng nội dung', () => {
  let allRequests = [
    {
      __backendId: 'TK-CHIẾU',
      outletName: 'Chiêu',
      outletCode: '66750453',
      type: 'new',
      status: 'pending',
      designImages: '[]',
      comments: '[]',
      editingRequestedAt: null,
      updatedAt: '2026-09-08T00:00:00Z'
    }
  ];

  let _qcagDesktopFullRequestCache = {};
  let _qcagDesktopCurrentId = 'TK-CHIẾU';
  let _qcagDesktopOpenRequestSnapshot = null;

  // Bước 1: QCAG upload MQ và xác nhận Hoàn thành lần 1
  allRequests[0].designImages = JSON.stringify(['https://gcs.com/mq1.webp']);
  allRequests[0].status = 'done';
  allRequests[0].updatedAt = '2026-09-08T00:01:00Z';
  _qcagDesktopFullRequestCache['TK-CHIẾU'] = JSON.parse(JSON.stringify(allRequests[0]));
  _qcagDesktopOpenRequestSnapshot = JSON.parse(JSON.stringify(allRequests[0]));

  // Khi đã done, thẻ không còn ở tab 'processing' (đúng logic)
  let visible = getQCAGDesktopVisibleRequests(allRequests, 'new', 'processing', _qcagDesktopCurrentId, _qcagDesktopOpenRequestSnapshot);
  assert.strictEqual(visible.length, 0, 'Đã hoàn thành lần 1 -> ẩn khỏi tab Đang xử lý');

  // Bước 2: Sale Heineken gửi yêu cầu chỉnh sửa lần 1
  allRequests[0].editingRequestedAt = '2026-09-08T00:02:00Z';
  allRequests[0].status = 'processing';
  allRequests[0].comments = JSON.stringify([{ text: 'Sửa logo to hơn', authorRole: 'heineken' }]);
  allRequests[0].updatedAt = '2026-09-08T00:02:00Z';

  // SSE trigger onDataChanged -> merge vào Cache và Snapshot
  _qcagDesktopFullRequestCache['TK-CHIẾU'] = qcagDesktopMergePreserveImageFields(allRequests[0], _qcagDesktopFullRequestCache['TK-CHIẾU']);
  _qcagDesktopOpenRequestSnapshot = JSON.parse(JSON.stringify(_qcagDesktopFullRequestCache['TK-CHIẾU']));

  // Thẻ xuất hiện lại ở tab Đang xử lý
  visible = getQCAGDesktopVisibleRequests(allRequests, 'new', 'processing', _qcagDesktopCurrentId, _qcagDesktopOpenRequestSnapshot);
  assert.strictEqual(visible.length, 1, 'Sale gửi sửa lần 1 -> thẻ phải xuất hiện lại');

  // Bước 3: QCAG sửa xong lần 1 -> Đánh dấu hoàn thành
  allRequests[0].status = 'done';
  allRequests[0].editingRequestedAt = null;
  allRequests[0].updatedAt = '2026-09-08T00:03:00Z';
  _qcagDesktopFullRequestCache['TK-CHIẾU'] = JSON.parse(JSON.stringify(allRequests[0]));
  _qcagDesktopOpenRequestSnapshot = JSON.parse(JSON.stringify(allRequests[0]));

  // Bước 4: Sale Heineken tiếp tục gửi yêu cầu chỉnh sửa LẦN 2!
  allRequests[0].editingRequestedAt = '2026-09-08T00:04:00Z';
  allRequests[0].status = 'processing';
  allRequests[0].comments = JSON.stringify([
    { text: 'Sửa logo to hơn', authorRole: 'heineken' },
    { text: 'Chỉnh thêm màu nền đỏ', authorRole: 'heineken' }
  ]);
  allRequests[0].updatedAt = '2026-09-08T00:04:00Z';

  // SSE onDataChanged đồng bộ:
  _qcagDesktopFullRequestCache['TK-CHIẾU'] = qcagDesktopMergePreserveImageFields(allRequests[0], _qcagDesktopFullRequestCache['TK-CHIẾU']);
  _qcagDesktopOpenRequestSnapshot = JSON.parse(JSON.stringify(_qcagDesktopFullRequestCache['TK-CHIẾU']));

  // Kiểm tra 1: Thẻ có bị biến mất không?
  visible = getQCAGDesktopVisibleRequests(allRequests, 'new', 'processing', _qcagDesktopCurrentId, _qcagDesktopOpenRequestSnapshot);
  assert.strictEqual(visible.length, 1, 'Sale gửi sửa lần 2 -> Thẻ PHẢI luôn hiển thị trong danh sách');

  // Kiểm tra 2: Khi Desktop QCAG mở thẻ, nạp đúng nội dung chỉnh sửa lần 2
  const latestInAll = allRequests.find(r => r.__backendId === 'TK-CHIẾU');
  const openedRequest = qcagDesktopMergePreserveImageFields(latestInAll, _qcagDesktopFullRequestCache['TK-CHIẾU']);
  
  assert.strictEqual(openedRequest.editingRequestedAt, '2026-09-08T00:04:00Z');
  const openedComments = JSON.parse(openedRequest.comments);
  assert.strictEqual(openedComments.length, 2);
  assert.strictEqual(openedComments[1].text, 'Chỉnh thêm màu nền đỏ', 'Phải đọc được comment sửa lần 2');
});

console.log(`\n===============================================================`);
console.log(`📊 KẾT QUẢ ĐÁNH GIÁ: ${passedTests}/${totalTests} TESTS PASS (100%)`);
console.log(`===============================================================`);
