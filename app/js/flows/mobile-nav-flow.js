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

function renderNotifications() {
	const list = document.getElementById('notificationsList');
	const empty = document.getElementById('notificationsEmpty');
	if (!list || !empty) return;

	const notifications = [];
	const sessionRole = (currentSession && currentSession.role) || '';
	const requests = getCurrentSessionOwnedRequests();

	requests.forEach(req => {
		let comments = [];
		try { comments = JSON.parse(req.comments || '[]'); } catch (e) { comments = []; }
		comments.forEach(comment => {
			if (!comment || !comment.text) return;
			const authorRole = (comment.authorRole || '').toLowerCase();
			if (authorRole && authorRole === sessionRole) return;
			notifications.push({
				requestId: req.__backendId,
				outletName: req.outletName || '-',
				outletCode: req.outletCode || '-',
				text: String(comment.text || '').trim(),
				author: comment.authorName || (authorRole === 'qcag' ? 'QCAG Admin' : 'Heineken'),
				authorRole: authorRole,
				createdAt: comment.createdAt || req.updatedAt || req.createdAt
			});
		});
	});

	notifications.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

	if (!notifications.length) {
		empty.classList.remove('hidden');
		list.innerHTML = '';
		return;
	}

	empty.classList.add('hidden');
	list.innerHTML = notifications.map(item => {
		const date = item.createdAt ? new Date(item.createdAt) : null;
		const dateLabel = date && !Number.isNaN(date.getTime())
			? date.toLocaleString('vi-VN', { hour12: false })
			: '';
		const roleLabel = item.authorRole === 'qcag' ? 'Admin QCAG' : 'Sale Heineken';
		return `
			<div class="bg-gray-50 rounded-xl p-3 border border-gray-200 active:bg-gray-100 cursor-pointer" onclick="showRequestDetail('${item.requestId}')">
				<div class="flex items-center justify-between gap-3">
					<div class="text-sm font-semibold text-gray-900 truncate">${item.outletName} (${item.outletCode})</div>
					<span class="text-[11px] px-2 py-0.5 rounded-full bg-gray-900 text-white flex-shrink-0">${roleLabel}</span>
				</div>
				<div class="text-sm text-gray-600 mt-1 line-clamp-2">${escapeHtml(item.text)}</div>
				<div class="text-xs text-gray-400 mt-2">${escapeHtml(item.author)} · ${dateLabel}</div>
			</div>
		`;
	}).join('');
}

function loadAccountProfile() {
	const phone = document.getElementById('accountPhone');
	const ssCode = document.getElementById('accountSSCode');
	const ssName = document.getElementById('accountSSName');
	const region = document.getElementById('accountRegion');
	if (!phone || !ssCode || !ssName || !region) return;

	phone.value = (currentSession && currentSession.phone) || '';
	ssCode.value = (currentSession && currentSession.ssCode) || '';
	ssName.value = (currentSession && currentSession.ssName) || '';
	region.value = (currentSession && currentSession.region) || '';

	const isHeineken = currentSession && currentSession.role === 'heineken';
	[ssCode, ssName, region].forEach(input => {
		input.disabled = !isHeineken;
		input.classList.toggle('opacity-60', !isHeineken);
	});
}

function saveAccountProfile() {
	if (!currentSession) return;
	const phone = (document.getElementById('accountPhone')?.value || '').trim();
	const ssCode = (document.getElementById('accountSSCode')?.value || '').trim();
	const ssName = (document.getElementById('accountSSName')?.value || '').trim();
	const region = (document.getElementById('accountRegion')?.value || '').trim();

	if (!phone) {
		showToast('Vui lòng nhập số điện thoại');
		return;
	}

	currentSession.phone = phone;
	if (currentSession.role === 'heineken') {
		currentSession.ssCode = ssCode;
		currentSession.ssName = ssName;
		currentSession.region = region;
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
