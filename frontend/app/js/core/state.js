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

// ── Submit guards ─────────────────────────────────────────────────────
let _isNewRequestSubmitting = false; // prevents double-submit in submitNewRequest()

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
  'Bảng hiflex 2 mặt (KHÔNG ĐÈN)',
  'Hộp đèn hiflex 1 mặt',
  'Hộp đèn hiflex 2 mặt',
  'Mái che di động',
  'Rèm Mái Che',
  'Logo indoor',
  'Logo Outdoor',
  'Hạng mục khác'
];

const tigerLogoSubTypes = [
  { id: 'Light Poster - Tranh đèn', name: 'Light Poster - Tranh đèn', shortName: 'Light Poster - Tranh đèn', width: 1.1, height: 0.8, fixedSize: true, fixedPoles: true, fixedAction: false },
  { id: 'Emlemd 2 mặt', name: 'Emlemd 2 mặt', shortName: 'Emlemd 2 mặt', width: 0.8, height: 0.77, fixedSize: true, fixedPoles: false, fixedAction: false },
  { id: 'Suqare Flat 1 mặt (treo tường)', name: 'Suqare Flat 1 mặt (treo tường)', shortName: 'Suqare Flat 1 mặt (treo tường)', width: 0.8, height: 0.71, fixedSize: true, fixedPoles: false, fixedAction: false }
];

const heinekenLogoSubTypes = [
  {
    id: 'Group Social (Model Ngôi Sao)',
    name: 'Group Social (Model Ngôi Sao)',
    shortName: 'Group Social (Model Ngôi Sao)',
    sizes: [
      { width: 0.6, height: 0.9 },
      { width: 0.8, height: 1.2 },
      { width: 1.0, height: 1.5 }
    ]
  },
  {
    id: 'Young Social (Model Lưới)',
    name: 'Young Social (Model Lưới)',
    shortName: 'Young Social (Model Lưới)',
    sizes: [
      { width: 0.68, height: 0.9 },
      { width: 0.9, height: 1.186 }
    ]
  }
];

const heinekenOutdoorSizes = [
  { width: 1.5, height: 0.75 },
  { width: 2.0, height: 1.0 },
  { width: 3.0, height: 1.5 },
  { width: 4.0, height: 2.0 },
  { width: 5.0, height: 2.5 }
];

const tigerOutdoorSizes = [
  { width: 1.5, height: 0.5 },
  { width: 2.4, height: 0.8 },
  { width: 3.0, height: 1.0 },
  { width: 3.9, height: 1.3 },
  { width: 4.5, height: 1.5 }
];

const allBrands = ['Heineken', 'Tiger', 'Bivina', 'Bivina Export', 'Bia Việt', 'Larue', 'Strongbow', 'Shopname'];

// ── LocalStorage keys ────────────────────────────────────────────────
const QCAG_PASSWORD_KEY = 'ks_qcag_pwd';
const SESSION_KEY = 'ks_session';
const HK_PROFILE_KEY = 'ks_hk_profile';
const OUTLET_DRAFT_KEY = 'ks_outlet_draft'; // saves outlet info + last items

// ── Session flow flags ────────────────────────────────────────────────
let _justLoggedIn = false; // true right after manual login → show step 1
