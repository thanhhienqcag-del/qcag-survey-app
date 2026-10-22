# Draft Autosave Feature Report

## Summary

Implemented a local draft autosave feature for the App-2 new request flow, including a compact draft button on the New Request screen and a main draft list button on the home screen. Both buttons now show a shared list-style icon and the current draft count.

## What changed

- Added a local draft storage mechanism using `localStorage` under the key `ks_new_request_drafts`.
- Implemented draft autosave when the user edits:
  - `Outlet Code`
  - `Tên Outlet`
  - `Địa chỉ`
  - `Số điện thoại`
  - `Nội dung bảng hiệu`
  - `Yêu cầu thêm`
  - request item fields and layout changes in Tab 2
  - old content toggle state
- Added a compact draft button in the New Request header:
  - displays only icon + count
  - uses shared list-style icon with the home draft button
  - rounded corners for better visibility
- Kept the home draft button behavior consistent and updated count display.
- When draft count is zero, clicking either draft button shows a toast `Chưa có bản nháp lưu` instead of opening the modal.
- Added a simplified draft modal layout and more compact draft cards.
- Ensured the draft buttons work in both light and dark mode, with dark-theme specific styling for the New Request header button.

## Files changed

- `frontend/index.html`
- `frontend/app/js/flows/request-flow.js`

## Notes

- The draft feature is entirely local and temporary: drafts are stored on the user device only and removed when deleted or when a request is successfully submitted.
- Draft count is kept visible in the UI and is updated even when zero.
- The modal remains disabled only in terms of showing content; the buttons still respond with a toast when no drafts exist.

## Next steps

- Consider adding an automatic load of the latest draft when opening the New Request screen.
- Optionally add a small badge or inactive styling when draft count is `0` to make the state more obvious visually.
