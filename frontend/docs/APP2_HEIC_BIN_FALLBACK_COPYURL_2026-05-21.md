# App 2 HEIC and .bin Fallback Update

Date: 2026-05-21
Version: v2.4.7-heic-bin-copy-url
Status: implemented locally, tested locally, not deployed

## 1) Problem update

Latest finding:
- Client-side recovery from stored `.bin` image URL to JPG preview is not reliable enough.
- Main failure causes are inconsistent remote content-type, possible CORS limitations, and non-deterministic HEIC byte handling from stored `.bin` objects.

Observed UI impact:
- desktop/detail thumbnail may fail to render and show broken image state

## 2) Revised approach

Instead of trying to convert broken remote `.bin` images to JPG in browser runtime:
- treat the broken asset as HEIC / `.bin` fallback content
- show a clear fallback card in place of the broken thumbnail
- provide a `Copy URL` button so the operator can immediately copy the original image URL for manual inspection/share/escalation

This is safer than repeated browser-side remote conversion attempts.

## 3) Code changes

Files changed:
- `app/js/shared/image-utils.js`
- `index.html`

Behavior after change:
- `_imgBrokenFallback()` now renders a fallback card instead of plain “Không hiển thị được”.
- Fallback card labels likely broken HEIC / `.bin` sources as `HEIC / .bin`.
- Added `Copy URL` button with clipboard fallback logic.
- `index.html` cache-bust token for `image-utils.js` updated to `20260521a`.

## 4) Cost note for mobile Heineken

This revised approach is lower-risk and lower-cost than remote conversion retries.

Why it is cost-safe:
1. No Cloud Run image transcoding added.
2. No repeated client fetch-and-convert loop for broken `.bin` assets.
3. No extra backend storage mutation or re-encoding job introduced.

Operational tradeoff:
- user sees a fallback card instead of an actual preview for broken remote HEIC/.bin images
- but user can still recover the source URL immediately using `Copy URL`

Net effect:
- lower runtime complexity
- lower mobile CPU/network waste for Heineken sessions
- easier support/debug workflow when image object itself is malformed or not browser-renderable

## 5) Local validation

Executed:
- `node --check app/js/shared/image-utils.js`
- diagnostics check on modified files
- local smoke test for HTML wiring and fallback code presence

Smoke result:
- `SMOKE_OK`

CLI limitation:
- full visual browser confirmation still requires manual test with a real broken `.bin` / HEIC image in UI

## 6) Deployment guard

Per instruction:
- not deployed
- deploy only after explicit approval