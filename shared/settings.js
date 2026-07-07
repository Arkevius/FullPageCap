// Shared settings: defaults, load/save helpers, filename templating.

export const DEFAULT_SETTINGS = {
  format: 'png',              // 'png' | 'jpeg' | 'pdf'
  jpegQuality: 92,            // 1-100, used for JPEG export and PDF embedding
  filenameTemplate: '{title} - {date} {time}',
  captureDelay: 150,          // extra ms to wait after each scroll (lazy content)
  hideFixed: true,            // hide fixed/sticky elements after the first row
  hideScrollbars: true,
  maxCaptureHeight: 50000,    // CSS px safety cap for infinite pages (0 = no cap)
  afterCapture: 'editor',     // 'editor' | 'download'
  pdfPaper: 'image',          // 'image' (one long page) | 'a4' | 'letter'
};

export async function loadSettings() {
  const stored = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}

export function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'capture';
}

export function buildFilename(template, meta, ext) {
  const d = new Date(meta.ts || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  let host = '';
  try { host = new URL(meta.url).hostname; } catch { /* ignore */ }
  const fields = {
    title: meta.title || 'capture',
    url: host,
    host,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`,
    timestamp: String(d.getTime()),
  };
  const name = (template || DEFAULT_SETTINGS.filenameTemplate)
    .replace(/\{(\w+)\}/g, (m, key) => (key in fields ? fields[key] : m));
  return `${sanitizeFilename(name)}.${ext}`;
}
