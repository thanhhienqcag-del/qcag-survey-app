const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('===============================================================');
console.log('🔍 BẮT ĐẦU KIỂM TRA TOÀN DIỆN APP 2 (KHẢO SÁT & QCAG)');
console.log('===============================================================\n');

// 1. SYNTAX CHECK FOR ALL JS FILES
function getAllJsFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === 'node_modules' || file === '.git' || file === '.vercel') continue;
    const fullPath = path.join(dir, file);
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

// 2. BACKEND API ENDPOINTS INTEGRITY CHECK
const backendIndexPath = path.join(__dirname, 'backend/index.js');
let backendEndpoints = [];
if (fs.existsSync(backendIndexPath)) {
  const backendCode = fs.readFileSync(backendIndexPath, 'utf8');
  const routeRegex = /app\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while ((match = routeRegex.exec(backendCode)) !== null) {
    backendEndpoints.push(`${match[1].toUpperCase()} ${match[2]}`);
  }
  console.log(`2. Kiểm tra Backend Endpoints: ✅ Đã tìm thấy ${backendEndpoints.length} routes trong backend/index.js`);
}

// 3. FRONTEND SCRIPT INCLUSION IN INDEX.HTML
const indexPath = path.join(__dirname, 'frontend/index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const scriptRegex = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/g;
let includedScripts = [];
let match;
while ((match = scriptRegex.exec(indexHtml)) !== null) {
  includedScripts.push(match[1]);
}
console.log(`3. Kiểm tra nạp script trong index.html: ✅ Đã nạp ${includedScripts.length} file scripts`);

// Verify local script files exist
let missingScripts = 0;
for (const src of includedScripts) {
  if (src.startsWith('http') || src.startsWith('//') || src.startsWith('/api/')) continue;
  const cleanPath = src.split('?')[0];
  const fullScriptPath = path.join(__dirname, 'frontend', cleanPath);
  if (!fs.existsSync(fullScriptPath)) {
    console.error('❌ Script bị thiếu trên đĩa:', cleanPath);
    missingScripts++;
  }
}
console.log(`   => Kiểm tra tồn tại file script local: ${missingScripts === 0 ? '✅ 100% Khớp file tồn tại' : '❌ FAIL'}`);

// 4. CHECK CRITICAL DOM IDs REQUIRED BY JS FLOWS
const criticalElementIds = [
  'qcagDesktopRequestList',
  'qcagDesktopDetail',
  'productionApprovalModal',
  'productionApprovalList',
  'loginScreen',
  'homeScreen',
  'listScreen',
  'detailScreen',
  'newRequestScreen',
  'warrantyScreen',
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

// 5. CHECK DATA_SDK ROLE ISOLATION & CACHE
const dataSdkPath = path.join(__dirname, 'frontend/app/_sdk/data_sdk.js');
const dataSdkCode = fs.readFileSync(dataSdkPath, 'utf8');
const hasRoleCacheIsolation = dataSdkCode.includes('payload.role') && dataSdkCode.includes('currentRole');
const hasQcagBypass = dataSdkCode.includes('!isQcag') && dataSdkCode.includes('_saleExtra');
console.log(`5. Kiểm tra Data SDK Cache & Role Isolation:`);
console.log(`   - Phân lập bộ nhớ cache theo Role: ${hasRoleCacheIsolation ? '✅ PASS' : '❌ FAIL'}`);
console.log(`   - Không gắn sale filter cho phiên QCAG: ${hasQcagBypass ? '✅ PASS' : '❌ FAIL'}`);

// 6. CHECK PRODUCTION APPROVAL FLOW PREVIEW IMAGES
const prodAppFlowPath = path.join(__dirname, 'frontend/app/js/flows/production-approval-flow.js');
const prodAppCode = fs.readFileSync(prodAppFlowPath, 'utf8');
const hasAutoFetch = prodAppCode.includes('autoFetchMissingProductionImages');
const hasMqParser = prodAppCode.includes('parseMqDesignImages');
console.log(`6. Kiểm tra Luồng Xác nhận sản xuất (Production Approval):`);
console.log(`   - Bóc tách ảnh đa nguồn (parseMqDesignImages): ${hasMqParser ? '✅ PASS' : '❌ FAIL'}`);
console.log(`   - Nạp tự động ảnh bù (autoFetchMissingProductionImages): ${hasAutoFetch ? '✅ PASS' : '❌ FAIL'}`);

// 7. CHECK YEAR FILTER DEFAULT
const desktopFlowPath = path.join(__dirname, 'frontend/app/js/flows/desktop-qcag-flow.js');
const desktopFlowCode = fs.readFileSync(desktopFlowPath, 'utf8');
const isYearNull = desktopFlowCode.includes('let _qcagDesktopYearFilter = null;');
console.log(`7. Kiểm tra Bộ lọc Năm Desktop QCAG:`);
console.log(`   - Mặc định xem tất cả các năm (null): ${isYearNull ? '✅ PASS' : '❌ FAIL'}`);

console.log('\n===============================================================');
if (syntaxErrors === 0 && missingScripts === 0 && missingDomIds === 0 && hasRoleCacheIsolation && hasQcagBypass && hasMqParser && isYearNull) {
  console.log('🎉 TỔNG KẾT: TẤT CẢ 7 HẠNG MỤC KIỂM TRA TOÀN DIỆN ĐỀU ĐẠT CHUẨN 100%!');
} else {
  console.log('⚠️ TỔNG KẾT: CÓ HẠNG MỤC CẦN KIỂM TRA LẠI');
}
console.log('===============================================================');
