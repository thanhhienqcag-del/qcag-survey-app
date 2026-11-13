const requests = [
  {
    "id": "srv_1792817214086_wvkmp",
    "__backendId": "srv_1792817214086_wvkmp",
    "tkCode": "TK26.07834",
    "status": "done",
    "subStatus": "pending",
    "type": "new",
    "outletName": "ĐINH ĐÔNG",
    "editingRequestedAt": null
  },
  {
    "id": "srv_1792816655948_aoyry",
    "__backendId": "srv_1792816655948_aoyry",
    "tkCode": "TK26.07833",
    "status": "done",
    "subStatus": "pending",
    "type": "new",
    "outletName": "VŨ KHANG",
    "editingRequestedAt": null
  },
  {
    "id": "srv_1792817426143_559a9",
    "__backendId": "srv_1792817426143_559a9",
    "tkCode": "TK26.07835",
    "status": "pending",
    "subStatus": "pending",
    "type": "new",
    "outletName": "NHÂN NHI",
    "editingRequestedAt": null
  }
];

function qcagDesktopIsPendingEditRequest(req) {
  if (!req) return false;
  const s = String(req.status || req.productionApprovalStatus || req.production_approval_status || '').toLowerCase();
  if (s === 'pending-edit' || s === 'edit_requested' || s === 'request-edit') return true;
  if (req.editingRequestedAt || req.editing_requested_at || req.hasEditRequest || req.isEditPending) return true;
  return false;
}

function qcagDesktopGetRequestType(r) {
  return 'new';
}

const _qcagDesktopStatusFilter = 'processing';
const _qcagDesktopFilterType = 'new';
const _qcagDesktopCurrentId = 'srv_1792817426143_559a9';

let wrapped = requests.map(r => {
  return { actual: r, sortKey: r };
});

if (_qcagDesktopFilterType === 'new') {
  wrapped = wrapped.filter(w => {
    const r = w.sortKey;
    const typeMatch = qcagDesktopGetRequestType(r) === 'new';
    if (!typeMatch) return false;
    if (_qcagDesktopStatusFilter === 'done') return true;
    const status = String(r.status || 'pending').toLowerCase();
    const isDone = (status === 'done' || status === 'processed' || status === 'quoted' || status === 'completed');
    const needsEdit = qcagDesktopIsPendingEditRequest(r);
    if (isDone && !needsEdit) return false;
    return true;
  });
}

console.log('Filtered wrapped result:', wrapped.map(w => w.actual.outletName));
