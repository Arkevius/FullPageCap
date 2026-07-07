#!/usr/bin/env node
// End-to-end smoke test: loads the extension in Chromium, captures a tall
// test page, and verifies the editor stitched it to the expected size.
//
//   npm install   (installs playwright; the browser itself is expected at
//                  PLAYWRIGHT_BROWSERS_PATH or the playwright default)
//   node test/e2e.mjs

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// -- tiny static server for the test page
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(readFileSync(join(root, 'test', 'page.html')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const userDataDir = mkdtempSync(join(tmpdir(), 'fpc-e2e-'));
// Use an explicitly provided browser build when the environment pins one
// (CHROMIUM_PATH), otherwise fall back to Playwright's own resolution.
const executablePath =
  process.env.CHROMIUM_PATH ||
  ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) =>
    existsSync(p)
  );

const context = await chromium.launchPersistentContext(userDataDir, {
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
  ],
});

try {
  // wait for the extension service worker
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  console.log('service worker:', sw.url());

  const page = await context.newPage();
  await page.goto(pageUrl, { waitUntil: 'load' });

  const editorPromise = context.waitForEvent('page', { timeout: 90000 });

  // collect background errors for diagnosis
  await sw.evaluate(() => {
    globalThis.__errs = [];
    const orig = console.error.bind(console);
    console.error = (...args) => {
      globalThis.__errs.push(args.map(String).join(' '));
      orig(...args);
    };
  });

  // trigger the capture exactly as the toolbar button would
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await globalThis.fpcStartCapture(tab.id);
  });

  const errs = await sw.evaluate(() => globalThis.__errs);
  if (errs.length) console.error('background errors:', errs);

  const editor = await editorPromise;
  await editor.waitForLoadState('domcontentloaded');
  console.log('editor page:', editor.url());
  if (!/editor\.html\?id=cap_/.test(editor.url())) fail('unexpected editor URL');

  // wait for stitching to finish
  await editor.waitForSelector('#loading', { state: 'hidden', timeout: 60000 });

  const result = await editor.evaluate(() => {
    const dims = document.querySelector('#status-dims').textContent;
    return { dims };
  });
  console.log('stitched:', result.dims);

  // page: 60px header offset irrelevant; 5 * 700 sections + 123 footer = 3623 css px
  const m = result.dims.match(/(\d+)\s*×\s*(\d+)/);
  if (!m) fail(`could not parse dimensions from "${result.dims}"`);
  const [w, h] = [Number(m[1]), Number(m[2])];
  if (w < 1200) fail(`stitched width ${w} too small`);
  if (Math.abs(h - 3623) > 30) fail(`stitched height ${h}, expected ~3623`);

  // sample stitched pixels: band colors at known offsets prove correct order
  const bands = await editor.evaluate(() => {
    // Sample the visible stage canvas (fit-zoomed, so the whole capture is
    // on screen) down its vertical center line.
    const stage = document.querySelector('#stage');
    const ctx = stage.getContext('2d');
    const samples = [];
    // sample a vertical strip down the middle of the fitted image
    for (const fy of [0.08, 0.25, 0.45, 0.62, 0.8, 0.99]) {
      const px = ctx.getImageData(
        Math.floor(stage.width / 2),
        Math.floor(stage.height * fy),
        1,
        1
      ).data;
      samples.push([px[0], px[1], px[2]]);
    }
    return samples;
  });
  console.log('color samples:', JSON.stringify(bands));

  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 90;
  // expected: band1 red, band2 orange, band3 green, band4 blue, band5 purple, footer black
  const expected = [
    [232, 53, 42],
    [255, 152, 0],
    [52, 168, 83],
    [26, 115, 232],
    [161, 66, 244],
    [0, 0, 0],
  ];
  expected.forEach((exp, i) => {
    if (!near(bands[i], exp)) {
      fail(`band ${i + 1}: got rgb(${bands[i]}), expected ~rgb(${exp})`);
    }
  });

  // fixed header must not repeat: sample where band 2 starts (y ≈ 760/3623)
  // was already covered by band sample 2 (0.25 → inside band 2, not dark header)

  await editor.screenshot({ path: join(root, 'test', 'editor-screenshot.png') });

  // -- annotation smoke: draw a rectangle, then undo it
  await editor.click('.tool-btn[data-tool="rect"]');
  const box = await editor.locator('#stage').boundingBox();
  await editor.mouse.move(box.x + 200, box.y + 200);
  await editor.mouse.down();
  await editor.mouse.move(box.x + 400, box.y + 320, { steps: 5 });
  await editor.mouse.up();
  let undoDisabled = await editor.locator('#btn-undo').isDisabled();
  if (undoDisabled) fail('undo should be enabled after drawing');
  await editor.click('#btn-undo');
  undoDisabled = await editor.locator('#btn-undo').isDisabled();
  if (!undoDisabled) fail('undo stack should be empty after undoing the only action');

  // -- crop: select an area and apply, dimensions must shrink
  await editor.click('.tool-btn[data-tool="crop"]');
  await editor.mouse.move(box.x + 550, box.y + 100);
  await editor.mouse.down();
  await editor.mouse.move(box.x + 750, box.y + 400, { steps: 5 });
  await editor.mouse.up();
  await editor.click('#crop-apply');
  const croppedDims = await editor.locator('#status-dims').textContent();
  console.log('after crop:', croppedDims);
  const cm = croppedDims.match(/(\d+)\s*×\s*(\d+)/);
  if (!cm || Number(cm[1]) >= w || Number(cm[2]) >= h) fail('crop did not shrink the image');
  await editor.keyboard.press('Control+z'); // restore full image

  // -- exports: PNG and PDF must download real files
  // Playwright reroutes downloads to its artifacts dir under a UUID name,
  // so match on MIME type rather than file extension.
  async function awaitDownload(mime) {
    for (let i = 0; i < 60; i++) {
      const items = await sw.evaluate(() => chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] }));
      const done = items.find((d) => d.state === 'complete' && d.mime === mime && d.exists);
      if (done) return done.filename;
      await new Promise((r) => setTimeout(r, 500));
    }
    fail(`download of ${mime} did not complete`);
  }

  await editor.click('#btn-download-png');
  const pngPath = await awaitDownload('image/png');
  const pngBytes = readFileSync(pngPath);
  if (pngBytes.length < 10000) fail(`PNG too small (${pngBytes.length} bytes)`);
  if (pngBytes.readUInt32BE(0) !== 0x89504e47) fail('PNG magic bytes missing');
  console.log(`PNG export ok: ${pngPath} (${pngBytes.length} bytes)`);

  await editor.click('#btn-download-pdf');
  const pdfPath = await awaitDownload('application/pdf');
  const pdfBytes = readFileSync(pdfPath);
  if (!pdfBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('PDF header missing');
  if (!pdfBytes.subarray(-32).includes('%%EOF')) fail('PDF trailer missing');
  console.log(`PDF export ok: ${pdfPath} (${pdfBytes.length} bytes)`);
  if (process.env.FPC_KEEP_EXPORTS) {
    writeFileSync(join(process.env.FPC_KEEP_EXPORTS, 'export.pdf'), pdfBytes);
    writeFileSync(join(process.env.FPC_KEEP_EXPORTS, 'export.png'), pngBytes);
  }

  console.log('PASS: stitch, annotate, undo, crop, PNG + PDF export all working');
} finally {
  await context.close();
  server.close();
}
