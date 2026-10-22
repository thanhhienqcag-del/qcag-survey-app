/**
 * App 2 - Khảo Sát / QCAG Desktop: Advanced Analytics & Operations Forecasting Module
 * ====================================================================================
 * Hệ Thống Thống Kê & Dự Báo Năng Lực Vận Hành QCAG (v2.9.0):
 * - Phân tích chu kỳ 12 tháng & nhận diện thời điểm cao điểm (Peak Periods).
 * - Phân tích khối lượng, tiến độ và áp lực tồn đọng trên 7 Khu vực địa bàn.
 * - Cơ cấu thương hiệu Heineken / Tiger / Larue / Bia Việt / Bivina và vật tư hạng mục.
 * - Tích hợp Chart.js trực quan hóa đa chiều (Mixed Bar/Line, Horizontal Bar, Doughnut).
 * - Đồng bộ hoàn hảo 2 Theme (Dark Neon #0b1220 & Light Neutral #eef4f8) theo AGENTS.md.
 */
'use strict';

let _qcagStatsYearFilter = '2026';
let _qcagStatsRegionFilter = 'all';

// Chart.js instances cache
let _qcagChartTrend = null;
let _qcagChartRegion = null;
let _qcagChartBrand = null;

const QCAG_REGION_CONFIG = {
  s4: { label: 'S4 - Hậu Giang', short: 'S4', color: '#38bdf8' },
  s5: { label: 'S5 - Cà Mau', short: 'S5', color: '#818cf8' },
  s16: { label: 'S16 - An Giang', short: 'S16', color: '#34d399' },
  s17: { label: 'S17 - Kiên Giang', short: 'S17', color: '#fbbf24' },
  '24': { label: 'S24 - Kiên Giang', short: 'S24', color: '#f87171' },
  s19: { label: 'S19 - Bạc Liêu', short: 'S19', color: '#a78bfa' },
  mot8: { label: 'MOT8 - Phú Quốc', short: 'MOT8', color: '#fb923c' }
};

function qcagGetRegionKey(val) {
  const r = String(val || '').trim().toLowerCase();
  if (r.includes('s4') || r.includes('hậu giang')) return 's4';
  if (r.includes('s5') || r.includes('cà mau')) return 's5';
  if (r.includes('s16') || r.includes('an giang')) return 's16';
  if (r.includes('s17')) return 's17';
  if (r.includes('24') || r.includes('kiên giang')) return '24';
  if (r.includes('s19') || r.includes('bạc liêu')) return 's19';
  if (r.includes('mot8') || r.includes('phú quốc')) return 'mot8';
  return 'other';
}

function qcagIsDarkTheme() {
  return document.documentElement.classList.contains('theme-dark') ||
         document.body.classList.contains('theme-dark') ||
         document.documentElement.getAttribute('data-theme') === 'dark';
}

/**
 * Tính toán toàn bộ số liệu thống kê từ allRequests
 */
function calculateQcagAdvancedStats(yearFilter, regionFilter) {
  const all = (typeof allRequests !== 'undefined' && Array.isArray(allRequests)) ? allRequests : [];

  // Filter dataset by Year and Region
  const filtered = all.filter(r => {
    // Year filter
    if (yearFilter && yearFilter !== 'all') {
      try {
        const y = new Date(r.createdAt || 0).getFullYear();
        if (y !== parseInt(yearFilter, 10)) return false;
      } catch (_) { return false; }
    }

    // Region filter
    if (regionFilter && regionFilter !== 'all') {
      let reqRegion = '';
      try {
        const reqJson = typeof r.requester === 'string' ? JSON.parse(r.requester) : (r.requester || {});
        reqRegion = reqJson.region || r.region || '';
      } catch (_) { reqRegion = r.region || ''; }
      const key = qcagGetRegionKey(reqRegion);
      if (key !== regionFilter) return false;
    }

    return true;
  });

  const total = filtered.length;
  let newCount = 0;
  let warrantyCount = 0;
  let doneCount = 0;
  let processingCount = 0;
  let hasMqCount = 0;
  let hasQuoteCount = 0;

  // Monthly buckets for 12 months
  const monthlyData = Array.from({ length: 12 }, (_, i) => ({
    monthIdx: i,
    label: `T${i + 1}`,
    fullName: `Tháng ${i + 1}`,
    received: 0,
    done: 0
  }));

  // Regions map
  const regionsMap = {
    s4: { key: 's4', label: 'S4 - Hậu Giang', total: 0, new: 0, warranty: 0, done: 0, processing: 0, hasMq: 0, hasQuote: 0 },
    s5: { key: 's5', label: 'S5 - Cà Mau', total: 0, new: 0, warranty: 0, done: 0, processing: 0, hasMq: 0, hasQuote: 0 },
    s16: { key: 's16', label: 'S16 - An Giang', total: 0, new: 0, warranty: 0, done: 0, processing: 0, hasMq: 0, hasQuote: 0 },
    s17: { key: 's17', label: 'S17 Kiên Giang', total: 0, new: 0, warranty: 0, done: 0, processing: 0, hasMq: 0, hasQuote: 0 },
    '24': { key: '24', label: 'S24 - Kiên Giang', total: 0, new: 0, warranty: 0, done: 0, processing: 0, hasMq: 0, hasQuote: 0 },
    s19: { key: 's19', label: 'S19 - Bạc Liêu', total: 0, new: 0, warranty: 0, done: 0, processing: 0, hasMq: 0, hasQuote: 0 },
    mot8: { key: 'mot8', label: 'MOT8 - Phú Quốc', total: 0, new: 0, warranty: 0, done: 0, processing: 0, hasMq: 0, hasQuote: 0 }
  };

  // Brands map
  const brandsMap = {
    heineken: { label: 'Heineken', count: 0, color: '#10b981' },
    tiger: { label: 'Tiger', count: 0, color: '#3b82f6' },
    larue: { label: 'Larue', count: 0, color: '#f59e0b' },
    biaviet: { label: 'Bia Việt', count: 0, color: '#ef4444' },
    bivina: { label: 'Bivina', count: 0, color: '#fb923c' },
    edelweiss: { label: 'Edelweiss', count: 0, color: '#06b6d4' },
    other: { label: 'Khác / Chưa định', count: 0, color: '#64748b' }
  };

  // Categories map (bóc tách hạng mục vật tư)
  const itemsMap = {
    hiflex: { label: 'Bảng Bạt Hiflex', count: 0 },
    lightbox: { label: 'Hộp Đèn / Hút Nổi', count: 0 },
    alu3d: { label: 'Alu & Chữ Nổi LED', count: 0 },
    decal: { label: 'Decal / Dán Kính', count: 0 },
    other: { label: 'Hạng Mục Khác', count: 0 }
  };

  filtered.forEach(r => {
    const isWarranty = r.type === 'warranty';
    if (isWarranty) warrantyCount++;
    else newCount++;

    // Workflow status
    let isDone = false;
    if (typeof _qcagNavListBuildStatus === 'function') {
      const st = _qcagNavListBuildStatus(r);
      isDone = (st.cls === 'done');
    } else {
      isDone = (r.status === 'done' || r.isCompleted);
    }

    if (isDone) doneCount++;
    else processingCount++;

    // Design MQ check
    const hasMq = !!(r.mqImages && (Array.isArray(r.mqImages) ? r.mqImages.length > 0 : String(r.mqImages).length > 5));
    if (hasMq) hasMqCount++;

    // Quote check
    const hasQuote = !!(r.quote_code || r.poCode || r.quoteStatus);
    if (hasQuote) hasQuoteCount++;

    // Monthly distribution
    if (r.createdAt) {
      try {
        const d = new Date(r.createdAt);
        const m = d.getMonth();
        if (m >= 0 && m < 12) {
          monthlyData[m].received++;
          if (isDone) monthlyData[m].done++;
        }
      } catch (_) {}
    }

    // Region distribution
    let reqRegion = '';
    try {
      const reqJson = typeof r.requester === 'string' ? JSON.parse(r.requester) : (r.requester || {});
      reqRegion = reqJson.region || r.region || '';
    } catch (_) { reqRegion = r.region || ''; }
    const rKey = qcagGetRegionKey(reqRegion);
    if (regionsMap[rKey]) {
      const reg = regionsMap[rKey];
      reg.total++;
      if (isWarranty) reg.warranty++;
      else reg.new++;
      if (isDone) reg.done++;
      else reg.processing++;
      if (hasMq) reg.hasMq++;
      if (hasQuote) reg.hasQuote++;
    }

    // Brand distribution
    const str = `${r.outletName || ''} ${r.signContent || ''} ${r.brand || ''}`.toLowerCase();
    if (str.includes('heineken')) brandsMap.heineken.count++;
    else if (str.includes('tiger')) brandsMap.tiger.count++;
    else if (str.includes('larue')) brandsMap.larue.count++;
    else if (str.includes('bia việt') || str.includes('biaviet')) brandsMap.biaviet.count++;
    else if (str.includes('bivina')) brandsMap.bivina.count++;
    else if (str.includes('edelweiss')) brandsMap.edelweiss.count++;
    else brandsMap.other.count++;

    // Items categorization
    let itemsArr = [];
    try {
      itemsArr = typeof r.items === 'string' ? JSON.parse(r.items) : (Array.isArray(r.items) ? r.items : []);
    } catch (_) {}
    if (itemsArr.length > 0) {
      itemsArr.forEach(it => {
        const itStr = `${it.type || ''} ${it.title || ''} ${it.category || ''} ${it.name || ''}`.toLowerCase();
        if (itStr.includes('hộp đèn') || itStr.includes('hop den') || itStr.includes('hút nổi')) itemsMap.lightbox.count++;
        else if (itStr.includes('alu') || itStr.includes('chữ nổi') || itStr.includes('led') || itStr.includes('mica')) itemsMap.alu3d.count++;
        else if (itStr.includes('decal') || itStr.includes('kính') || itStr.includes('poster')) itemsMap.decal.count++;
        else if (itStr.includes('hiflex') || itStr.includes('bạt') || itStr.includes('bảng hiệu')) itemsMap.hiflex.count++;
        else itemsMap.other.count++;
      });
    } else {
      itemsMap.hiflex.count++;
    }
  });

  // Calculate Peak Month
  let peakMonth = monthlyData[0];
  monthlyData.forEach(m => {
    if (m.received > peakMonth.received) peakMonth = m;
  });

  // Capacity Stress Level
  let capacityLevel = { label: 'Tải Bình Thường', cls: 'level-normal', color: '#10b981', note: 'Xưởng thi công vận hành nhịp nhàng' };
  if (processingCount > 180) {
    capacityLevel = { label: 'Cao Điểm / Quá Tải', cls: 'level-danger', color: '#ef4444', note: 'Khuyến nghị tăng cường đội thợ & vật tư' };
  } else if (processingCount >= 80) {
    capacityLevel = { label: 'Tải Cao', cls: 'level-warning', color: '#f59e0b', note: 'Cần theo dõi tiến độ các vùng trọng điểm' };
  }

  // Sorted regions array by total descending
  const sortedRegions = Object.values(regionsMap).sort((a, b) => b.total - a.total);

  const completionRate = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const quoteRate = total > 0 ? Math.round((hasQuoteCount / total) * 100) : 0;

  return {
    total,
    newCount,
    warrantyCount,
    doneCount,
    processingCount,
    hasMqCount,
    hasQuoteCount,
    completionRate,
    quoteRate,
    peakMonth,
    capacityLevel,
    monthlyData,
    sortedRegions,
    brandsMap,
    itemsMap
  };
}

/**
 * Render toàn bộ Dashboard thống kê vào #qcagStatsContentBody
 */
function renderApp2StatsPanel() {
  const body = document.getElementById('qcagStatsContentBody');
  if (!body) return;

  const totalBadge = document.getElementById('qcagStatsTotalBadge');
  const data = calculateQcagAdvancedStats(_qcagStatsYearFilter, _qcagStatsRegionFilter);

  if (totalBadge) {
    totalBadge.textContent = `${data.total} yêu cầu`;
  }

  const isDark = qcagIsDarkTheme();

  // 1. KPI Cards HTML
  const kpiCardsHtml = `
    <div class="qcag-stats-kpi-grid">
      <div class="qcag-stats-kpi-card">
        <div class="qcag-stats-kpi-header">
          <span class="qcag-stats-kpi-label">Tổng Khối Lượng Tiếp Nhận</span>
          <span class="qcag-stats-kpi-icon-wrap text-sky-400">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          </span>
        </div>
        <div class="qcag-stats-kpi-value-row">
          <span class="qcag-stats-kpi-number">${data.total}</span>
          <span class="qcag-stats-kpi-unit">điểm</span>
        </div>
        <div class="qcag-stats-kpi-sub">
          <span class="text-sky-400 font-semibold">${data.newCount}</span> mới · <span class="text-amber-400 font-semibold">${data.warrantyCount}</span> bảo hành
        </div>
      </div>

      <div class="qcag-stats-kpi-card">
        <div class="qcag-stats-kpi-header">
          <span class="qcag-stats-kpi-label">Thời Gian Cao Điểm Nhất</span>
          <span class="qcag-stats-kpi-icon-wrap text-amber-400">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </span>
        </div>
        <div class="qcag-stats-kpi-value-row">
          <span class="qcag-stats-kpi-number text-amber-400">${data.peakMonth.fullName}</span>
          <span class="qcag-stats-kpi-unit">đỉnh điểm</span>
        </div>
        <div class="qcag-stats-kpi-sub">
          Đạt <strong class="text-white">${data.peakMonth.received}</strong> yêu cầu tiếp nhận
        </div>
      </div>

      <div class="qcag-stats-kpi-card">
        <div class="qcag-stats-kpi-header">
          <span class="qcag-stats-kpi-label">Tỷ Lệ Hoàn Tất Toàn Bộ</span>
          <span class="qcag-stats-kpi-icon-wrap text-emerald-400">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </span>
        </div>
        <div class="qcag-stats-kpi-value-row">
          <span class="qcag-stats-kpi-number text-emerald-400">${data.completionRate}%</span>
          <span class="qcag-stats-kpi-unit">đạt được</span>
        </div>
        <div class="qcag-stats-kpi-sub">
          Đã xong <strong class="text-emerald-400">${data.doneCount}</strong> / ${data.total} điểm
        </div>
      </div>

      <div class="qcag-stats-kpi-card">
        <div class="qcag-stats-kpi-header">
          <span class="qcag-stats-kpi-label">Áp Lực Tồn Đọng &amp; Tải Xưởng</span>
          <span class="qcag-stats-kpi-icon-wrap" style="color: ${data.capacityLevel.color}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </span>
        </div>
        <div class="qcag-stats-kpi-value-row">
          <span class="qcag-stats-kpi-number" style="color: ${data.capacityLevel.color}">${data.processingCount}</span>
          <span class="qcag-stats-kpi-unit">đang xử lý</span>
        </div>
        <div class="qcag-stats-kpi-sub">
          <span class="qcag-stats-level-tag ${data.capacityLevel.cls}">${data.capacityLevel.label}</span>
          <span class="text-xs text-gray-400 ml-1.5 hidden xl:inline">${data.capacityLevel.note}</span>
        </div>
      </div>
    </div>
  `;

  // 2. Insight Banner HTML
  const insightBannerHtml = `
    <div class="qcag-stats-insight-banner">
      <div class="qcag-stats-insight-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      </div>
      <div class="qcag-stats-insight-text">
        <strong>Nhận định vận hành:</strong> 
        ${_qcagStatsYearFilter !== 'all' ? `Trong năm ${_qcagStatsYearFilter}, ` : ''}
        Giai đoạn <strong>${data.peakMonth.fullName}</strong> tiếp nhận khối lượng công việc lớn nhất (${data.peakMonth.received} yêu cầu).
        Khu vực <strong>${data.sortedRegions[0] ? data.sortedRegions[0].label : 'S5 Cà Mau'}</strong> dẫn đầu về số lượng điểm bán cần phục vụ (${data.sortedRegions[0] ? data.sortedRegions[0].total : 0} điểm).
        Hiện còn <strong>${data.processingCount}</strong> yêu cầu chưa hoàn thành, cần chủ động điều phối thợ thi công và dự trữ vật tư khung sắt, bạt hiflex trước mùa cao điểm.
      </div>
    </div>
  `;

  // 3. Matrix Table Rows HTML
  const matrixRowsHtml = data.sortedRegions.map((reg, idx) => {
    const pct = reg.total > 0 ? Math.round((reg.done / reg.total) * 100) : 0;
    const isTop = idx === 0;
    return `
      <tr class="qcag-stats-matrix-row ${isTop ? 'is-top-region' : ''}">
        <td class="cell-center text-gray-500 font-semibold">${idx + 1}</td>
        <td class="font-bold text-gray-200">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full" style="background: ${QCAG_REGION_CONFIG[reg.key] ? QCAG_REGION_CONFIG[reg.key].color : '#38bdf8'}"></span>
            <span>${reg.label}</span>
          </div>
        </td>
        <td class="cell-center font-bold text-gray-100">${reg.total}</td>
        <td class="cell-center text-sky-400 font-medium">${reg.new}</td>
        <td class="cell-center text-amber-400 font-medium">${reg.warranty}</td>
        <td class="cell-center text-purple-400 font-medium">${reg.processing}</td>
        <td class="cell-center text-emerald-400 font-medium">${reg.hasQuote}</td>
        <td class="cell-center font-bold text-green-400">${reg.done}</td>
        <td class="cell-center">
          <div class="flex items-center justify-center gap-2">
            <div class="w-16 h-2 rounded-full bg-gray-800 overflow-hidden">
              <div class="h-full bg-emerald-500 rounded-full" style="width: ${pct}%"></div>
            </div>
            <span class="text-xs font-bold text-emerald-400 font-mono w-9 text-right">${pct}%</span>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Top Items HTML
  const itemsListHtml = Object.values(data.itemsMap).map(it => `
    <div class="flex items-center justify-between text-xs py-1.5 border-b border-gray-800/50 last:border-b-0">
      <span class="text-gray-300 font-medium">${it.label}</span>
      <span class="font-bold text-sky-400 font-mono">${it.count}</span>
    </div>
  `).join('');

  // Assemble full Dashboard Layout
  body.innerHTML = `
    <div class="qcag-stats-dashboard">
      ${kpiCardsHtml}
      ${insightBannerHtml}

      <!-- Row 2: 12-Month Peak & Trend Chart -->
      <div class="qcag-stats-chart-card mb-4">
        <div class="qcag-stats-card-header">
          <div class="flex items-center gap-2">
            <div class="qcag-stats-card-indicator" style="background:#38bdf8"></div>
            <h3 class="qcag-stats-card-title">Phân Tích Khối Lượng &amp; Thời Gian Cao Điểm (12 Tháng)</h3>
          </div>
          <span class="text-xs text-gray-400">Đơn vị: Yêu cầu khảo sát / tháng</span>
        </div>
        <div class="qcag-stats-chart-container" style="height: 280px; position: relative;">
          <canvas id="qcagChartMonthlyTrendCanvas"></canvas>
        </div>
      </div>

      <!-- Row 3: 2 Columns (Regional Workload vs Brand & Materials) -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <!-- Col Left: Regional Workload Ranking -->
        <div class="qcag-stats-chart-card">
          <div class="qcag-stats-card-header">
            <div class="flex items-center gap-2">
              <div class="qcag-stats-card-indicator" style="background:#818cf8"></div>
              <h3 class="qcag-stats-card-title">Xếp Hạng Khối Lượng 7 Khu Vực</h3>
            </div>
            <span class="text-xs text-gray-400">Từ cao xuống thấp</span>
          </div>
          <div class="qcag-stats-chart-container" style="height: 260px; position: relative;">
            <canvas id="qcagChartRegionalCanvas"></canvas>
          </div>
        </div>

        <!-- Col Right: Brand Share & Top Items -->
        <div class="qcag-stats-chart-card flex flex-col justify-between">
          <div>
            <div class="qcag-stats-card-header">
              <div class="flex items-center gap-2">
                <div class="qcag-stats-card-indicator" style="background:#10b981"></div>
                <h3 class="qcag-stats-card-title">Cơ Cấu Thương Hiệu &amp; Hạng Mục</h3>
              </div>
              <span class="text-xs text-gray-400">${data.total} bảng hiệu</span>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
              <div class="qcag-stats-chart-container" style="height: 200px; position: relative;">
                <canvas id="qcagChartBrandCanvas"></canvas>
              </div>
              <div class="qcag-stats-items-breakdown">
                <div class="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">Hạng Mục Thi Công Phổ Biến</div>
                ${itemsListHtml}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Row 4: Detailed Matrix Table -->
      <div class="qcag-stats-chart-card">
        <div class="qcag-stats-card-header">
          <div class="flex items-center gap-2">
            <div class="qcag-stats-card-indicator" style="background:#f59e0b"></div>
            <h3 class="qcag-stats-card-title">Bảng Đối Soát Chi Tiết 7 Khu Vực Quản Lý</h3>
          </div>
          <span class="text-xs text-gray-400">Nguồn dữ liệu: Toàn bộ bảng ks_requests</span>
        </div>
        <div class="overflow-x-auto">
          <table class="qcag-stats-matrix-table">
            <thead>
              <tr>
                <th style="width: 45px; text-align: center;">STT</th>
                <th>Khu Vực Địa Bàn</th>
                <th style="width: 90px; text-align: center;">Tổng Điểm</th>
                <th style="width: 85px; text-align: center;">Y/C Mới</th>
                <th style="width: 85px; text-align: center;">Bảo Hành</th>
                <th style="width: 95px; text-align: center;">Đang Xử Lý</th>
                <th style="width: 95px; text-align: center;">Đã Báo Giá</th>
                <th style="width: 95px; text-align: center;">Hoàn Thành</th>
                <th style="width: 140px; text-align: center;">Tỷ Lệ Xong</th>
              </tr>
            </thead>
            <tbody>
              ${matrixRowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // 4. Initialize or update Chart.js instances
  setTimeout(() => {
    qcagRenderCharts(data, isDark);
  }, 50);
}

/**
 * Khởi tạo hoặc vẽ lại 3 Chart.js
 */
function qcagRenderCharts(data, isDark) {
  if (typeof Chart === 'undefined') {
    console.warn('[QCAG Stats] Chart.js chưa được nạp!');
    return;
  }

  const textColor = isDark ? '#94a3b8' : '#64748b';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(0, 0, 0, 0.06)';

  // --- CHART 1: 12-Month Peak & Trend (Mixed Bar + Line) ---
  const trendCanvas = document.getElementById('qcagChartMonthlyTrendCanvas');
  if (trendCanvas) {
    if (_qcagChartTrend) {
      _qcagChartTrend.destroy();
      _qcagChartTrend = null;
    }

    const labels = data.monthlyData.map(m => m.label);
    const receivedVals = data.monthlyData.map(m => m.received);
    const doneVals = data.monthlyData.map(m => m.done);

    _qcagChartTrend = new Chart(trendCanvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'line',
            label: 'Đã Hoàn Thành',
            data: doneVals,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.15)',
            borderWidth: 2.5,
            pointBackgroundColor: '#10b981',
            pointRadius: 4,
            tension: 0.35,
            order: 1
          },
          {
            type: 'bar',
            label: 'Yêu Cầu Tiếp Nhận',
            data: receivedVals,
            backgroundColor: isDark ? 'rgba(56, 189, 248, 0.55)' : 'rgba(37, 99, 235, 0.65)',
            borderColor: isDark ? '#38bdf8' : '#2563eb',
            borderWidth: 1.5,
            borderRadius: 6,
            order: 2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: { color: textColor, font: { family: 'Be Vietnam Pro', size: 11.5, weight: '600' } }
          },
          tooltip: {
            backgroundColor: isDark ? '#1f2937' : '#ffffff',
            titleColor: isDark ? '#f9fafb' : '#111827',
            bodyColor: isDark ? '#e5e7eb' : '#374151',
            borderColor: isDark ? '#374151' : '#e5e7eb',
            borderWidth: 1,
            padding: 10,
            callbacks: {
              title: (ctx) => `Tháng ${ctx[0].label.replace('T', '')}`
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: textColor, font: { family: 'Be Vietnam Pro', size: 11 } }
          },
          y: {
            grid: { color: gridColor },
            ticks: { color: textColor, font: { family: 'Be Vietnam Pro', size: 11 } },
            beginAtZero: true
          }
        }
      }
    });
  }

  // --- CHART 2: Regional Workload (Horizontal Bar) ---
  const regionCanvas = document.getElementById('qcagChartRegionalCanvas');
  if (regionCanvas) {
    if (_qcagChartRegion) {
      _qcagChartRegion.destroy();
      _qcagChartRegion = null;
    }

    const regLabels = data.sortedRegions.map(r => r.label);
    const regTotals = data.sortedRegions.map(r => r.total);
    const regDone = data.sortedRegions.map(r => r.done);

    _qcagChartRegion = new Chart(regionCanvas, {
      type: 'bar',
      data: {
        labels: regLabels,
        datasets: [
          {
            label: 'Đã hoàn thành',
            data: regDone,
            backgroundColor: isDark ? 'rgba(16, 185, 129, 0.7)' : '#10b981',
            borderRadius: 4
          },
          {
            label: 'Tổng yêu cầu',
            data: regTotals,
            backgroundColor: isDark ? 'rgba(99, 102, 241, 0.45)' : 'rgba(99, 102, 241, 0.65)',
            borderRadius: 4
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: { color: textColor, font: { family: 'Be Vietnam Pro', size: 11 } }
          }
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: { color: textColor, font: { family: 'Be Vietnam Pro', size: 10.5 } },
            beginAtZero: true
          },
          y: {
            grid: { display: false },
            ticks: { color: textColor, font: { family: 'Be Vietnam Pro', size: 11, weight: '600' } }
          }
        }
      }
    });
  }

  // --- CHART 3: Brand Portfolio (Doughnut) ---
  const brandCanvas = document.getElementById('qcagChartBrandCanvas');
  if (brandCanvas) {
    if (_qcagChartBrand) {
      _qcagChartBrand.destroy();
      _qcagChartBrand = null;
    }

    const brands = Object.values(data.brandsMap).filter(b => b.count > 0);
    const brandLabels = brands.map(b => b.label);
    const brandCounts = brands.map(b => b.count);
    const brandColors = brands.map(b => b.color);

    _qcagChartBrand = new Chart(brandCanvas, {
      type: 'doughnut',
      data: {
        labels: brandLabels,
        datasets: [
          {
            data: brandCounts,
            backgroundColor: brandColors,
            borderColor: isDark ? '#111827' : '#ffffff',
            borderWidth: 2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.label}: ${ctx.raw} bảng (${Math.round(ctx.raw / data.total * 100)}%)`
            }
          }
        }
      }
    });
  }
}

/**
 * Xử lý khi đổi bộ lọc năm
 */
function qcagStatsOnYearChange(year) {
  _qcagStatsYearFilter = year;
  renderApp2StatsPanel();
}

/**
 * Xử lý khi đổi bộ lọc khu vực
 */
function qcagStatsOnRegionChange(region) {
  _qcagStatsRegionFilter = region;
  renderApp2StatsPanel();
}
