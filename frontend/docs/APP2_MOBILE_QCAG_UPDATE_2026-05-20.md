# App 2 Mobile QCAG Update

Date: 2026-05-20
Version: v2.4.5-mobile-qcag-desktop-based
Status: implemented locally, tested locally, not deployed

## 1) Scope and flow study

Current behavior before this change:
- Mobile UI was effectively shared between Heineken and QCAG roles.
- QCAG mobile could still see actions intended for Heineken flow (new request / warranty).
- Detail screen could expose upload controls unsuitable for QCAG mobile operation.

Business flow requirement applied:
- QCAG mobile is a light operation mode:
  - check list/status/detail
  - read and reply comments
- QCAG mobile UI must follow QCAG desktop processing logic, not shared Heineken mobile list/profile assumptions.
- QCAG account view must not show sale/ss/region profile fields.
- QCAG mobile should not:
  - create new request
  - create warranty request
  - upload MQ/design
  - upload acceptance images
- Existing Heineken mobile flow must stay unchanged.

## 2) Implementation approach (safe, isolated)

To avoid breaking existing flow/UI, a dedicated layer was added instead of rewriting core files:
- New JS: app/js/flows/mobile-qcag-flow.js
- New CSS: app/css/mobile-qcag.css
- index.html only loads these two files (no destructive change to existing flows).

Behavior of the QCAG mobile layer (v2.4.5):
- Detect mode: role=qcag and non-desktop viewport.
- Apply class body.qcag-mobile-mode for theme/style control.
- Override home actions for QCAG mobile:
  - button 1 => open request list
  - button 2 => open notifications/comments
  - hide Heineken-style request/warranty stats blocks
- Replace shared mobile list rendering with QCAG dedicated renderer:
  - status tabs: Dang xu ly / Hoan thanh
  - type tabs: Yeu cau moi / Bao hanh
  - search fields: ma TK, outlet code, ten outlet, dia chi
  - card data: outlet, ma TK, outlet code, status, time only
  - remove sale/ss/region assumptions from list presentation
- Replace notifications rendering for QCAG mobile:
  - collect comment updates from requests and show latest updates feed
  - open detail directly from notification item
- Guard actions (soft-block with toast + redirect):
  - startNewRequest
  - startWarrantyCheck
- Disable uploads on detail for QCAG mobile:
  - hide upload design label/input
  - hide upload acceptance label/input
  - block uploadDesign/uploadAcceptance functions
- Keep comment workflow enabled.
- Hide account UI blocks for SS code / SS name / region in QCAG mobile mode.

## 3) Files changed

- index.html
  - add: app/css/mobile-qcag.css?v=20260520a
  - add: app/js/flows/mobile-qcag-flow.js?v=20260520a
- app/js/flows/mobile-qcag-flow.js (new)
- app/css/mobile-qcag.css (new)
- docs/APP2_MOBILE_QCAG_UPDATE_2026-05-20.md (updated for v2.4.5)

## 4) Local validation

Executed local checks:
- Syntax check
  - node --check app/js/flows/mobile-qcag-flow.js
  - node --check app/js/flows/list-flow.js
  - node --check app/js/flows/mobile-nav-flow.js
- Workspace diagnostics
  - no syntax error from modified files

Manual local flow checklist:
- QCAG login on mobile viewport
  - home switches to QCAG mobile behavior
  - no create-request / no warranty-create workflow
- List/detail open
  - can view requests and comments
  - can send comments
- Detail upload controls
  - MQ upload hidden/blocked
  - acceptance upload hidden/blocked
- Heineken mobile
  - existing flow remains available

## 5) Cost optimization notes (mobile Heineken operation)

Potential operating cost drivers:
- repeated list fetches on mobile background/foreground switching
- large image payloads and upload retries
- push traffic fan-out

Recommended optimizations (no risky refactor required):
1. Keep incremental sync first, full refresh only on staleness threshold.
2. Keep strict image compression client-side before upload (already used), plus size caps by role.
3. Reduce unnecessary polling while tab hidden; rely on SSE/push wake-ups.
4. Keep request list payload lightweight (no heavy image arrays in list endpoints).
5. Add cache TTL telemetry to monitor fetch frequency and payload growth by day.

Expected benefit:
- lower egress and DB query frequency on mobile Heineken sessions
- reduced Cloud Run CPU time under high mobile reconnect churn

## 6) Deployment guard

Per request from owner:
- this update is not deployed.
- deploy only after explicit approval.
