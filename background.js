// Background service worker: orchestrates the capture.
//
// Flow: user clicks the action (or presses the shortcut) -> inject content.js
// -> content script measures the page and reports scroll positions -> for each
// position we ask the content script to scroll, then call captureVisibleTab
// (throttled to respect Chrome's quota) -> frames are stored in IndexedDB ->
// the editor tab is opened to stitch, annotate and export.

import { loadSettings } from './shared/settings.js';
import { putCaptureMeta, putFrame, pruneOldCaptures } from './shared/db.js';

// chrome.tabs.captureVisibleTab is limited to 2 calls per second.
const MIN_CAPTURE_INTERVAL_MS = 600;

const activeCaptures = new Set(); // tab ids with a capture in flight

chrome.action.onClicked.addListener((tab) => startCapture(tab));
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) startCapture(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  pruneOldCaptures().catch(() => {});
});

// Programmatic trigger, e.g. from extension pages or the service worker
// console: fpcStartCapture(tabId).
globalThis.fpcStartCapture = async (tabId) => startCapture(await chrome.tabs.get(tabId));

function isCapturableUrl(url) {
  return /^(https?|file|ftp):/.test(url || '');
}

async function setBadge(tabId, text, color = '#1a73e8') {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // tab may be gone; ignore
  }
}

function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notifyError(tabId, message) {
  await setBadge(tabId, 'ERR', '#d93025');
  setTimeout(() => setBadge(tabId, ''), 4000);
  // Best effort in-page toast; fails silently on restricted pages.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (text) => {
        const el = document.createElement('div');
        el.textContent = `FullPageCap: ${text}`;
        el.style.cssText =
          'position:fixed;top:16px;right:16px;z-index:2147483647;background:#d93025;' +
          'color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:320px';
        document.documentElement.appendChild(el);
        setTimeout(() => el.remove(), 5000);
      },
      args: [message],
    });
  } catch {
    // ignore
  }
}

async function startCapture(tab) {
  const tabId = tab.id;
  if (activeCaptures.has(tabId)) return;

  if (!isCapturableUrl(tab.url)) {
    await notifyError(
      tabId,
      'This page cannot be captured (browser pages and the Web Store are restricted).'
    );
    return;
  }

  activeCaptures.add(tabId);
  const settings = await loadSettings();

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });

    const layout = await sendToTab(tabId, { type: 'fpc:prepare', settings });
    if (!layout || !layout.ok) {
      throw new Error(layout?.error || 'Could not measure the page.');
    }

    const captureId = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const total = layout.positions.length;
    const frames = [];
    let lastCaptureAt = 0;

    for (let i = 0; i < total; i++) {
      await setBadge(tabId, total > 1 ? `${i + 1}/${total}` : '...');

      const pos = await sendToTab(tabId, { type: 'fpc:scrollTo', index: i });
      if (!pos || !pos.ok) throw new Error(pos?.error || 'Lost contact with the page.');

      // Respect the captureVisibleTab rate limit.
      const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
      if (wait > 0) await sleep(wait);

      const dataUrl = await captureVisibleTabWithRetry(tab.windowId);
      lastCaptureAt = Date.now();

      const blob = await (await fetch(dataUrl)).blob();
      await putFrame(captureId, i, pos.x, pos.y, blob);
      frames.push({ index: i, x: pos.x, y: pos.y });
    }

    await sendToTab(tabId, { type: 'fpc:finish' }).catch(() => {});

    await putCaptureMeta({
      id: captureId,
      title: tab.title || '',
      url: tab.url || '',
      ts: Date.now(),
      layout: {
        totalWidth: layout.totalWidth,
        totalHeight: layout.totalHeight,
        vw: layout.vw,
        vh: layout.vh,
        winW: layout.winW,
        winH: layout.winH,
        dpr: layout.dpr,
        clip: layout.clip || null,
        truncated: layout.truncated,
      },
      frames,
      settings: {
        format: settings.format,
        jpegQuality: settings.jpegQuality,
        filenameTemplate: settings.filenameTemplate,
        pdfPaper: settings.pdfPaper,
        afterCapture: settings.afterCapture,
      },
    });

    await setBadge(tabId, '');
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`editor/editor.html?id=${captureId}`),
      index: tab.index + 1,
      openerTabId: tabId,
    });
  } catch (err) {
    await sendToTab(tabId, { type: 'fpc:finish' }).catch(() => {});
    console.error('[FullPageCap] capture failed:', err);
    await notifyError(tabId, err.message || 'Capture failed.');
  } finally {
    activeCaptures.delete(tabId);
  }
}

async function captureVisibleTabWithRetry(windowId, attempts = 4) {
  let delay = 500;
  for (let i = 0; ; i++) {
    try {
      // Always capture PNG; the export format is applied later in the editor.
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const msg = String(err?.message || err);
      const retriable = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|rate|dragging/i.test(msg);
      if (i >= attempts - 1 || !retriable) throw err;
      await sleep(delay);
      delay *= 2;
    }
  }
}
