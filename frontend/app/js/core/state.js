// ====================================================================
// js/core/state.js — all global application state variables
// ====================================================================
'use strict';

// ── Session / Login ──────────────────────────────────────────────────
let currentSession = null; // { role:'heineken'|'qcag', phone, ... }
let _loginTBAOn = false;
let _loginSelectedRegion = '';

// ── Request data ─────────────────────────────────────────────────────
let allRequests = [];
let currentRequestItems = [];
let currentDetailRequest = null;
let lastRequestType = 'new';
let lastCreatedRequestId = null;
// sequence counter for request items (used to keep logical numbering)
let nextRequestItemSeq = 1;

// ── Form images ───────────────────────────────────────────────────────
let isOldContent = false;
let oldContentImages = [];
let statusImages = [];
let _statusImageFiles = []; // parallel array of File objects for upload (statusImages stores blob URLs for preview only)
let warrantyImages = [];

// ── Tab tracking ──────────────────────────────────────────────────────
let currentTab = 1;
let currentWarrantyTab = 1;
let currentListTab = 'new';

// ── App config ────────────────────────────────────────────────────────
const defaultConfig = {
  app_title: 'Quản Lý Yêu Cầu'
};

// ── Sign types & brand rules ─────────────────────────────────────────
const signTypes = [
  'Bảng hiflex 1 mặt',
  'Bảng hiflex 2 mặt dạng hộp',
  'Hộp đèn hiflex 1 mặt',
  'Hộp đèn hiflex 2 mặt',
  'Logo indoor',
  'Logo indoor 2 mặt (Emblemd)',
  'Logo Outdoor',
  'Hạng mục khác'
];

const allBrands = ['Heineken', 'Tiger', 'Bivina', 'Bivina Export', 'Bia Việt', 'Larue', 'Strongbow', 'Shopname'];

// ── LocalStorage keys ────────────────────────────────────────────────
const QCAG_PASSWORD_KEY = 'ks_qcag_pwd';
const SESSION_KEY = 'ks_session';
const HK_PROFILE_KEY = 'ks_hk_profile';
const OUTLET_DRAFT_KEY = 'ks_outlet_draft'; // saves outlet info + last items

// ── Session flow flags ────────────────────────────────────────────────
let _justLoggedIn = false; // true right after manual login → show step 1
