# Changelog

## 1.0.0 — 2026-07-07

Initial release.

### Capture
- Full-page capture from the toolbar button or `Alt+Shift+P`, scrolling
  viewport-by-viewport (vertically and horizontally) and stitching frames
  at full device-pixel resolution
- Fixed/sticky elements captured once at the top, then hidden so they do
  not repeat; scrollbars hidden and animations frozen during capture
- Inner-scroller detection for web-app layouts, with per-frame clipping
- `captureVisibleTab` rate-limit pacing with retry, live progress badge
- Configurable per-step delay for lazy-loading pages and a max-height
  safety cap for infinite-scroll pages

### Editor
- Pan/zoom viewport renderer with fit and 100% modes
- Tools: select/move/resize, crop, pen, highlighter, line, arrow
  (Shift snaps to 45°), rectangle, ellipse, text (double-click to
  re-edit), pixelating blur/redact
- Color swatches + custom color, stroke width control, full undo/redo

### Export
- PNG, JPEG (configurable quality), copy to clipboard, print
- PDF via a built-in dependency-free writer: one long page or paginated
  A4/Letter
- Filename templates: `{title}` `{host}` `{date}` `{time}` `{timestamp}`
- Optional auto-download right after capture

### Project
- Options page backed by `chrome.storage.sync`
- Dependency-free icon generator (`npm run icons`)
- Playwright end-to-end test (`npm test`) covering stitching accuracy,
  annotations, undo, crop, and PNG/PDF download validity
