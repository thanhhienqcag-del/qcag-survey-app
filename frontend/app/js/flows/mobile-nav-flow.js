'use strict';

const MAIN_TAB_BY_SCREEN = {
	homeScreen: 'home',
	listScreen: 'list',
	notificationsScreen: 'notifications',
	accountScreen: 'account'
};

function isMainMobileScreen(screenId) {
	return !!MAIN_TAB_BY_SCREEN[screenId];
}

function setActiveMainTab(tab) {
	const map = {
		home: 'mainTabHome',
		list: 'mainTabList',
		notifications: 'mainTabNotifications',
		account: 'mainTabAccount'
	};
	Object.keys(map).forEach(key => {
		const button = document.getElementById(map[key]);
		if (!button) return;
		button.classList.toggle('active', key === tab);
	});
}

function setActiveMainTabByScreen(screenId) {
	const tab = MAIN_TAB_BY_SCREEN[screenId];
	if (tab) setActiveMainTab(tab);
}

function syncBottomNavVisibility(screenId) {
	const nav = document.getElementById('mobileMainNav');
	if (!nav) return;
	const mobileView = window.innerWidth <= 767;
	const show = mobileView && isMainMobileScreen(screenId) && !!currentSession;
	nav.classList.toggle('hidden', !show);
}

function openMainTab(tab) {
	if (tab === 'home') {
		showScreen('homeScreen');
		return;
	}
	if (tab === 'list') {
		showRequestList();
		return;
	}
	if (tab === 'notifications') {
		showNotifications();
		return;
	}
	if (tab === 'account') {
		showAccount();
	}
}

function getCurrentSessionOwnedRequests() {
	if (!currentSession) return [];
	if (!currentSession.saleCode) return [];
	return allRequests.filter(r => {
		try {
			const reqOwner = JSON.parse(r.requester || '{}');
			return reqOwner.saleCode && reqOwner.saleCode === currentSession.saleCode;
		} catch (e) {
			return false;
		}
	});
}

function updateNotifBadge() {
	const badge = document.getElementById('notifCountBadge');
	if (!badge) return;
	let count = 0;
	const requests = getCurrentSessionOwnedRequests();
	requests.forEach(req => {
		let comments = [];
		try { comments = JSON.parse(req.comments || '[]'); } catch (e) { comments = []; }
		comments.forEach(comment => {
			if (!comment || !comment.text) return;
			if ((comment.authorRole || '').toLowerCase() !== 'qcag') return;
			count++;
		});
	});
	const saleCode = currentSession && currentSession.saleCode;
	if (saleCode) {
		try {
			const delLog = JSON.parse(localStorage.getItem('ks_qcag_del_log_' + saleCode) || '[]');
			count += delLog.length;
		} catch (e) { /* ignore */ }
	}
	if (count > 0) {
		badge.textContent = count > 99 ? '99+' : String(count);
		badge.style.display = 'flex';
	} else {
		badge.style.display = 'none';
	}
}

function formatNotifSmartTime(dateStr) {
	if (!dateStr) return '';
	const date = new Date(dateStr);
	if (Number.isNaN(date.getTime())) return String(dateStr);
	const now = new Date();
	const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

	if (diffSec < 60) return 'Vừa xong';
	if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;

	const isToday = now.toDateString() === date.toDateString();
	const timeStr = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
	if (isToday) return `Hôm nay ${timeStr}`;

	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (yesterday.toDateString() === date.toDateString()) return `Hôm qua ${timeStr}`;

	return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + timeStr;
}

function getNotifMeta(item) {
	if (item.isDeleted) return { tag: 'Đã xóa' };
	const text = String(item.text || '').toLowerCase();
	if (text.startsWith('thêm hạng mục') || text.includes('thêm hạng mục')) return { tag: 'Thêm hạng mục' };
	if (text.includes('sửa hạng mục') || text.includes('chỉnh sửa hạng mục') || (text.includes('hạng mục') && (text.includes('sửa') || text.includes('chỉnh')))) return { tag: 'Chỉnh sửa hạng mục' };
	if (text.includes('xóa hạng mục')) return { tag: 'Xóa hạng mục' };
	if (text.includes('hạng mục')) return { tag: 'Hạng mục' };
	if (text.includes('sửa') || text.includes('chỉnh sửa') || text.includes('yêu cầu sửa') || item.isEdit) return { tag: 'Sửa thiết kế' };
	return { tag: 'Trao đổi' };
}

function renderNotifications() {
	const list = document.getElementById('notificationsList');
	const empty = document.getElementById('notificationsEmpty');
	if (!list || !empty) return;

	const notifications = [];
	const requests = getCurrentSessionOwnedRequests();

	requests.forEach(req => {
		let comments = [];
		try { comments = JSON.parse(req.comments || '[]'); } catch (e) { comments = []; }
		comments.forEach(comment => {
			if (!comment || !comment.text) return;
			const authorRole = (comment.authorRole || '').toLowerCase();
			// Sale chỉ thấy bình luận từ QCAG và hệ thống
			if (authorRole !== 'qcag' && authorRole !== 'system') return;
			notifications.push({
				requestId: req.__backendId,
				outletName: req.outletName || '-',
				outletCode: req.outletCode || '-',
				text: String(comment.text || '').trim(),
				author: comment.authorName || 'QCAG Admin',
				authorRole: authorRole,
				isDeleted: false,
				createdAt: comment.createdAt || req.updatedAt || req.createdAt
			});
		});
	});

	// Thêm thông báo yêu cầu đã bị xóa bởi QCAG (lưu trong localStorage)
	const saleCode = currentSession && currentSession.saleCode;
	if (saleCode) {
		try {
			const delLog = JSON.parse(localStorage.getItem('ks_qcag_del_log_' + saleCode) || '[]');
			delLog.forEach(evt => {
				notifications.push({
					requestId: null,
					outletName: evt.outletName || '-',
					outletCode: evt.outletCode || '-',
					text: evt.reason ? 'QCAG đã xóa yêu cầu. Lý do: ' + evt.reason : 'QCAG đã xóa yêu cầu',
					author: 'Admin QCAG',
					authorRole: 'qcag',
					isDeleted: true,
					createdAt: evt.deletedAt || new Date().toISOString()
				});
			});
		} catch (e) { /* ignore */ }
	}

	notifications.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

	// Cập nhật badge đếm thông báo ở bottom navigation và header
	const badge = document.getElementById('notifCountBadge');
	const headerBadge = document.getElementById('notifTotalCountHeader');
	const countText = notifications.length > 99 ? '99+' : String(notifications.length);

	if (badge) {
		if (notifications.length > 0) {
			badge.textContent = countText;
			badge.style.display = 'flex';
		} else {
			badge.style.display = 'none';
		}
	}
	if (headerBadge) {
		if (notifications.length > 0) {
			headerBadge.textContent = countText;
			headerBadge.classList.remove('hidden');
		} else {
			headerBadge.classList.add('hidden');
		}
	}

	if (!notifications.length) {
		empty.classList.remove('hidden');
		list.innerHTML = '';
		return;
	}

	empty.classList.add('hidden');
	const esc = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

	list.innerHTML = notifications.map(item => {
		const smartTime = formatNotifSmartTime(item.createdAt);
		const meta = getNotifMeta(item);

		let authorLabel = item.author || 'QCAG Admin';
		if (/^\d{8,12}$/.test(authorLabel)) {
			authorLabel = 'Admin QCAG';
		} else if (authorLabel.toLowerCase() === 'hệ thống') {
			authorLabel = 'Hệ thống QCAG';
		}

		const clickAttr = item.isDeleted
			? `onclick="showToast('Yêu cầu này đã bị xóa khỏi hệ thống')"`
			: `onclick="if (typeof shouldUseQCAGDesktop === 'function' && shouldUseQCAGDesktop() && typeof showQCAGDesktopDetail === 'function') { showQCAGDesktopDetail('${item.requestId}'); } else { showRequestDetail('${item.requestId}'); }"`;

		return `
			<div class="hk-notif-card" ${clickAttr}>
				<div class="hk-notif-top">
					<div class="hk-notif-main-info">
						<div class="hk-notif-outlet-title">${esc(item.outletName)}</div>
						<div class="hk-notif-outlet-code">Mã: ${esc(item.outletCode)}</div>
					</div>
					<span class="hk-notif-tag">${meta.tag}</span>
				</div>

				<div class="hk-notif-bubble">
					${esc(item.text)}
				</div>

				<div class="hk-notif-footer">
					<div class="hk-notif-author-info">
						<span class="hk-notif-author-name truncate max-w-[140px]">${esc(authorLabel)}</span>
						<span class="opacity-40">•</span>
						<span class="whitespace-nowrap">${smartTime}</span>
					</div>
					${!item.isDeleted ? `
					<span class="hk-notif-cta">
						<span>Chi tiết</span>
						<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M9 5l7 7-7 7"/></svg>
					</span>
					` : ''}
				</div>
			</div>
		`;
	}).join('');
}

function loadAccountProfile() {
	const phone = document.getElementById('accountPhone');
	const ssName = document.getElementById('accountSSName');
	const region = document.getElementById('accountRegion');
	if (!phone || !ssName || !region) return;

	phone.value = (currentSession && currentSession.phone) || '';

	const isHeineken = currentSession && currentSession.role === 'heineken';
	const saleType = (currentSession && (currentSession.saleType || (currentSession.isTBA ? 'tba' : (currentSession.isNPP ? 'npp' : 'dsm_sr')))) || 'dsm_sr';

	if (saleType === 'tba') {
		ssName.value = 'Chức vụ TBA';
		ssName.disabled = true;
		ssName.classList.add('opacity-60');
		region.value = 'Đa khu vực (Chọn khi tạo yêu cầu)';
		region.disabled = true;
		region.classList.add('opacity-60');
	} else if (saleType === 'npp') {
		ssName.value = 'Kênh Nhà phân phối (NPP)';
		ssName.disabled = true;
		ssName.classList.add('opacity-60');
		region.value = 'Đa khu vực (Chọn khi tạo yêu cầu)';
		region.disabled = true;
		region.classList.add('opacity-60');
	} else {
		ssName.value = (currentSession && currentSession.ssName) || '';
		region.value = (currentSession && currentSession.region) || '';
		[ssName, region].forEach(input => {
			input.disabled = !isHeineken;
			input.classList.toggle('opacity-60', !isHeineken);
		});
	}
}

function saveAccountProfile() {
	if (!currentSession) return;
	const phone = (document.getElementById('accountPhone')?.value || '').trim();
	const ssName = (document.getElementById('accountSSName')?.value || '').trim();
	const region = (document.getElementById('accountRegion')?.value || '').trim();

	if (!phone) {
		showToast('Vui lòng nhập số điện thoại');
		return;
	}

	currentSession.phone = phone;
	const saleType = currentSession.saleType || (currentSession.isTBA ? 'tba' : (currentSession.isNPP ? 'npp' : 'dsm_sr'));

	if (currentSession.role === 'heineken') {
		if (saleType === 'dsm_sr') {
			currentSession.ssName = ssName;
			currentSession.region = region;
		}
		try {
			const saved = JSON.parse(localStorage.getItem(HK_PROFILE_KEY) || '{}');
			localStorage.setItem(HK_PROFILE_KEY, JSON.stringify({ ...saved, phone }));
		} catch (e) {}
	}

	localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
	updateSessionBar();
	showToast('Đã cập nhật thông tin tài khoản');
}

window.addEventListener('resize', () => {
	const active = Object.keys(MAIN_TAB_BY_SCREEN).find(id => {
		const el = document.getElementById(id);
		return el && el.classList.contains('flex') && !el.classList.contains('hidden');
	});
	if (active) syncBottomNavVisibility(active);
});
