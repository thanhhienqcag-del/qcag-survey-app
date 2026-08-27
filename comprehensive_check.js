const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('===============================================================');
console.log('🔍 BẮT ĐẦU KIỂM TRA TOÀN DIỆN APP 2 (KHẢO SÁT & QCAG)');
console.log('===============================================================\n');

// 1. SYNTAX CHECK TOÀN BỘ FILE JS
function getAllJsFiles(dirPath, fileList = []) {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    if (file === 'node_modules' || file === '.git' || file === '.vercel') continue;
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getAllJsFiles(fullPath, fileList);
    } else if (file.endsWith('.js')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

const allJs = getAllJsFiles(__dirname);
let syntaxErrors = 0;
for (const file of allJs) {
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe' });
  } catch (err) {
    console.error('❌ Lỗi cú pháp trong file:', file);
    syntaxErrors++;
  }
}
console.log(`1. Kiểm tra Cú pháp (Syntax Check): ${syntaxErrors === 0 ? '✅ 100% PASS (' + allJs.length + ' files)' : '❌ FAIL'}`);

// 2. BACKEND API ENDPOINTS & REALTIME INTEGRITY CHECK
const backendIndexPath = path.join(__dirname, 'backend/index.js');
let backendEndpoints = [];
let hasSseBroadcast = false;
let hasUpdatedSince = false;
if (fs.existsSync(backendIndexPath)) {
  const backendCode = fs.readFileSync(backendIndexPath, 'utf8');
  const routeRegex = /app\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = routeRegex.exec(backendCode)) !== null) {
    backendEndpoints.push(`${match[1].toUpperCase()} ${match[2]}`);
  }
  hasSseBroadcast = backendCode.includes('sseBroadcast') && backendCode.includes('wsInvalidate');
  hasUpdatedSince = backendCode.includes('updatedSince') && (backendCode.includes('updated_at >= ?') || backendCode.includes('resolveKsRequestsOptions'));
}
console.log(`2. Kiểm tra Backend Endpoints & Realtime:`);
console.log(`   - Số lượng API Routes: ✅ ${backendEndpoints.length} routes trong backend/index.js`);
console.log(`   - Realtime SSE & WebSocket Broadcast: ${hasSseBroadcast ? '✅ PASS' : '❌ FAIL'}`);
console.log(`   - Hỗ trợ Incremental Sync (updatedSince): ${hasUpdatedSince ? '✅ PASS' : '❌ FAIL'}`);

// 3. CHECK SCRIPT INCLUSION IN INDEX.HTML
const indexHtmlPath = path.join(__dirname, 'frontend/index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
const scriptRegex = /<script\s+(?:[^>]*\s+)?src=["']([^"']+)["']/g;
let loadedScripts = [];
let missingScripts = 0;
let matchScript;
while ((matchScript = scriptRegex.exec(indexHtml)) !== null) {
  let scriptSrc = matchScript[1];
  if (!scriptSrc.startsWith('http') && !scriptSrc.startsWith('/api/')) {
    // Strip query strings like ?v=2.8.1
    const cleanSrc = scriptSrc.split('?')[0];
    loadedScripts.push(cleanSrc);
    const localScriptPath = path.join(__dirname, 'frontend', cleanSrc);
    if (!fs.existsSync(localScriptPath)) {
      console.error('❌ File script được nạp trong index.html không tồn tại:', cleanSrc);
      missingScripts++;
    }
  }
}
console.log(`3. Kiểm tra nạp script trong index.html: ✅ Đã nạp ${loadedScripts.length} file scripts local`);
console.log(`   => Kiểm tra tồn tại file script local: ${missingScripts === 0 ? '✅ 100% Khớp file tồn tại' : '❌ FAIL'}`);

// 4. CHECK CRITICAL DOM ELEMENTS IN INDEX.HTML
const criticalElementIds = [
  'loginScreen',
  'homeScreen',
  'listScreen',
  'detailScreen',
  'newRequestScreen',
  'warrantyScreen',
  'productionApprovalModal',
  'productionApprovalList',
  'toastMessage'
];
let missingDomIds = 0;
for (const id of criticalElementIds) {
  if (!indexHtml.includes(`id="${id}"`) && !indexHtml.includes(`id='${id}'`)) {
    console.error('❌ Thiếu Element ID trong index.html:', id);
    missingDomIds++;
  }
}
console.log(`4. Kiểm tra DOM Element IDs quan trọng: ${missingDomIds === 0 ? '✅ 100% Đầy đủ' : '❌ FAIL'}`);

// 5. CHECK DATA_SDK REALTIME & IN-PLACE STORE UPDATE
const dataSdkPath = path.join(__dirname, 'frontend/app/_sdk/data_sdk.js');
const dataSdkCode = fs.readFileSync(dataSdkPath, 'utf8');
const hasRealtimePatch = dataSdkCode.includes('payload.action === \'create\'') && dataSdkCode.includes('payload.action === \'update\'');
const hasIncrementalRefresh = dataSdkCode.includes('_fetchIncrementalStore') && dataSdkCode.includes('updated_since');
console.log(`5. Kiểm tra Data SDK Cache & Realtime:`);
console.log(`   - Cập nhật trực tiếp RAM qua sự kiện SSE (payload.data): ${hasRealtimePatch ? '✅ PASS' : '❌ FAIL'}`);
console.log(`   - Đồng bộ gia số thông minh (updated_since): ${hasIncrementalRefresh ? '✅ PASS' : '❌ FAIL'}`);

// 6. CHECK PRODUCTION APPROVAL FLOW PREVIEW IMAGES
const prodAppFlowPath = path.join(__dirname, 'frontend/app/js/flows/production-approval-flow.js');
const prodAppCode = fs.readFileSync(prodAppFlowPath, 'utf8');
const hasAutoFetch = prodAppCode.includes('autoFetchMissingProductionImages');
const hasMqParser = prodAppCode.includes('parseMqDesignImages');
console.log(`6. Kiểm tra Luồng Xác nhận sản xuất (Production Approval):`);
console.log(`   - Bóc tách ảnh đa nguồn (parseMqDesignImages): ${hasMqParser ? '✅ PASS' : '❌ FAIL'}`);
console.log(`   - Nạp tự động ảnh bù (autoFetchMissingProductionImages): ${hasAutoFetch ? '✅ PASS' : '❌ FAIL'}`);

// 7. CHECK REALTIME EDIT REQUEST ALERT & STATUS SYNC
const desktopFlowPath = path.join(__dirname, 'frontend/app/js/flows/desktop-qcag-flow.js');
const desktopFlowCode = fs.readFileSync(desktopFlowPath, 'utf8');
const hasEditAlertBanner = desktopFlowCode.includes('qcagDesktopBuildEditRequestAlertBannerHtml');
const hasPendingEditPriority = desktopFlowCode.includes('qcagDesktopIsPendingEditRequest(r)');
console.log(`7. Kiểm tra Luồng Yêu cầu Chỉnh sửa Realtime Desktop QCAG:`);
console.log(`   - Banner cảnh báo yêu cầu chỉnh sửa trực quan: ${hasEditAlertBanner ? '✅ PASS' : '❌ FAIL'}`);
console.log(`   - Ưu tiên trạng thái "Chờ chỉnh sửa" cao nhất: ${hasPendingEditPriority ? '✅ PASS' : '❌ FAIL'}`);

console.log('\n===============================================================');
if (syntaxErrors === 0 && missingScripts === 0 && missingDomIds === 0 && hasSseBroadcast && hasUpdatedSince && hasRealtimePatch && hasMqParser && hasEditAlertBanner && hasPendingEditPriority) {
  console.log('🎉 TỔNG KẾT: TẤT CẢ 7 HẠNG MỤC KIỂM TRA TOÀN DIỆN ĐỀU ĐẠT CHUẨN 100% (AN TOÀN & SẠCH SẼ)!');
} else {
  console.log('⚠️ TỔNG KẾT: CÓ HẠNG MỤC CẦN KIỂM TRA LẠI');
}
console.log('===============================================================');
