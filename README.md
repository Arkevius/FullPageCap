# FullPageCap — Full Page Screen Capture

A feature-rich Chrome extension (Manifest V3) that captures an entire web
page — not just the visible part — then lets you annotate the result and
export it. A functional clone of the GoFullPage extension, built from
scratch with zero runtime dependencies.

## Features

**Capture**
- One-click capture from the toolbar button, or `Alt+Shift+P`
- Scrolls the page viewport-by-viewport (vertically *and* horizontally for
  wide pages) and stitches the frames into one seamless image
- Fixed and sticky elements (headers, cookie bars) are captured once at the
  top, then hidden so they don't repeat in every row
- Scrollbars hidden, CSS animations/transitions frozen during capture
- Detects pages that scroll inside an inner container (web-app layouts) and
  captures that container instead, cropping each frame to it
- Live progress badge on the toolbar icon (`3/7`)
- Handles Chrome's `captureVisibleTab` rate limit with pacing + retry
- Configurable extra delay per scroll step for lazy-loading pages
- Safety cap for infinite-scroll pages (default 50,000 px, configurable)
- High-DPI aware: stitches at full device-pixel resolution
- Very large pages are automatically scaled to Chrome's canvas limits

**Editor** (opens in a new tab after each capture)
- Pan (drag / scroll / middle-mouse) and zoom (Ctrl+scroll, buttons, `Fit`, `100%`)
- Annotation tools, all with single-key shortcuts:
  - Select / move / resize (`V`), Crop (`C`)
  - Pen (`P`), Highlighter (`H`)
  - Line (`L`), Arrow (`A`) — hold Shift to snap to 45° angles
  - Rectangle (`R`), Ellipse (`E`) — hold Shift for square/circle
  - Text (`T`) — click to place, double-click to re-edit
  - Blur/redact (`B`) — pixelates the region underneath
- 8 color swatches + custom color picker, adjustable stroke width
- Full undo/redo history (`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`)
- Delete selection with `Del`

**Export**
- Download as **PNG**, **JPEG** (quality configurable) or **PDF**
- PDF export uses a built-in dependency-free PDF writer; choose one long
  page, or paginated A4 / Letter
- **Copy to clipboard** and **Print**
- Filename templates: `{title}`, `{host}`, `{date}`, `{time}`, `{timestamp}`
- Optional auto-download immediately after capture

**Options page** — format, JPEG quality, PDF paper, filename template,
capture delay, fixed-element handling, scrollbar hiding, max capture height.

## Install (unpacked)

1. Clone this repo
2. Open `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked** and select the repo folder
4. Click the FullPageCap icon on any page (or press `Alt+Shift+P`)

## How it works

```
toolbar click / shortcut
        │
        ▼
background.js ──inject──▶ content.js   measures page, computes scroll grid,
        │                              hides scrollbars/fixed elements
        │  for each position:
        │    content.js scrolls & settles ──▶ captureVisibleTab (PNG)
        │    frame stored in IndexedDB
        ▼
editor/editor.html?id=…    reads frames from IndexedDB, stitches them onto a
                           canvas at device-pixel resolution, then provides
                           annotation + export (PNG/JPEG/clipboard/print, and
                           PDF via editor/pdf.js, a minimal PDF writer that
                           embeds JPEG streams directly)
```

Captures are kept in IndexedDB for 24 hours, then pruned.

## Repository layout

```
manifest.json          MV3 manifest
background.js          service worker: capture orchestration
content.js             injected on demand: measuring, scrolling, restoring
editor/                stitching + annotation editor + PDF writer
options/               options page (chrome.storage.sync)
shared/                settings & IndexedDB helpers shared by all contexts
scripts/gen-icons.mjs  dependency-free icon generator (writes icons/*.png)
test/                  end-to-end test (Playwright) + test page
```

## Development

```bash
npm install          # dev-only: playwright for the e2e test
npm test             # full end-to-end test in headless Chromium
npm run icons        # regenerate icons/*.png
```

The e2e test loads the extension in Chromium, captures a 3,623 px tall test
page with a fixed header, and verifies: the editor opens, the stitched size
is exact, the color bands are in order, annotations + undo work, crop works,
and the PNG/PDF downloads are valid files.

## Releasing

1. Bump `version` in `manifest.json` (and `package.json`), add a section to
   `CHANGELOG.md`, merge to `main`
2. Run the **Release** workflow (Actions tab → Release → Run workflow) with
   the tag, e.g. `v1.0.0`

The workflow verifies the tag matches the manifest version, creates the git
tag and GitHub Release with the changelog section as notes, and attaches a
ready-to-load zip of the extension.

## Permissions

- `activeTab`, `scripting` — inject the content script into the current tab
- `host_permissions: <all_urls>` — required so the `Alt+Shift+P` shortcut can
  capture without a toolbar click (custom commands don't grant `activeTab`)
- `storage` — settings sync
- `downloads` — save exports with templated filenames
- `clipboardWrite` — copy image to clipboard
