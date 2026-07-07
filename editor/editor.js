// Editor page: stitches captured frames into one image, provides annotation
// tools (crop, pen, highlighter, shapes, arrows, text, blur) with undo/redo,
// and exports to PNG / JPEG / PDF / clipboard / print.

import { getCaptureMeta, getFrames, pruneOldCaptures } from '../shared/db.js';
import { loadSettings, buildFilename } from '../shared/settings.js';
import { buildPdf, PAPER_SIZES } from './pdf.js';

// Chrome 2D canvas limits (conservative).
const MAX_CANVAS_DIM = 32767;
const MAX_CANVAS_AREA = 268435456; // 16384 * 16384

const $ = (sel) => document.querySelector(sel);

const stage = $('#stage');
const ctx = stage.getContext('2d');
const stageWrap = $('#stage-wrap');
const textInput = $('#text-input');

const state = {
  meta: null,
  settings: null,
  original: null,      // stitched base image (canvas, device px)
  canvasScale: 1,      // css px -> original canvas px
  downscaled: false,
  objects: [],
  selectedId: null,
  cropRect: null,      // {x,y,w,h} in image px; null until stitched
  undoStack: [],
  redoStack: [],
  tool: 'select',
  color: '#e8352a',
  strokeWidth: 4,
  zoom: 1,
  panX: 0,
  panY: 0,
  // transient pointer interaction
  action: null,        // {kind:'draw'|'move'|'resize'|'crop-select'|'pan', ...}
  pendingCrop: null,   // rect being selected while crop tool active
  editingTextId: null,
  idSeq: 1,
};

const blurCache = new WeakMap(); // blur object -> {sig, canvas}

/* ================= stitching ================= */

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return fatal('Missing capture id.');

  pruneOldCaptures().catch(() => {});

  const meta = await getCaptureMeta(id);
  if (!meta) return fatal('This capture no longer exists (captures are kept for 24 hours).');
  state.meta = meta;
  state.settings = await loadSettings();

  document.title = `${meta.title || 'Screenshot'} — FullPageCap`;
  $('#doc-title').textContent = meta.title || meta.url || 'Screenshot';

  const frames = await getFrames(id);
  if (!frames.length) return fatal('No captured frames were found.');

  const { totalWidth, totalHeight, vw, vh, clip } = meta.layout;

  // Device px per CSS px, measured from the actual first frame.
  const probe = await blobToImage(frames[0].blob);
  const winW = meta.layout.winW || (clip ? null : vw);
  const frameScale = winW ? probe.width / winW : probe.width / vw;

  let canvasScale = frameScale;
  let w = Math.round(totalWidth * canvasScale);
  let h = Math.round(totalHeight * canvasScale);
  if (w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM || w * h > MAX_CANVAS_AREA) {
    const s = Math.min(MAX_CANVAS_DIM / w, MAX_CANVAS_DIM / h, Math.sqrt(MAX_CANVAS_AREA / (w * h)));
    canvasScale *= s;
    w = Math.max(1, Math.floor(totalWidth * canvasScale));
    h = Math.max(1, Math.floor(totalHeight * canvasScale));
    state.downscaled = true;
  }
  state.canvasScale = canvasScale;

  const original = document.createElement('canvas');
  original.width = w;
  original.height = h;
  const octx = original.getContext('2d');
  octx.imageSmoothingQuality = 'high';

  const loadingText = $('#loading-text');
  for (let i = 0; i < frames.length; i++) {
    loadingText.textContent = `Stitching screenshot… ${i + 1}/${frames.length}`;
    const f = frames[i];
    const img = i === 0 ? probe : await blobToImage(f.blob);
    let sx = 0;
    let sy = 0;
    let sw = img.width;
    let sh = img.height;
    if (clip) {
      sx = clip.x * frameScale;
      sy = clip.y * frameScale;
      sw = clip.w * frameScale;
      sh = clip.h * frameScale;
    }
    octx.drawImage(
      img,
      sx, sy, sw, sh,
      Math.round(f.x * canvasScale),
      Math.round(f.y * canvasScale),
      Math.round(vw * canvasScale),
      Math.round(vh * canvasScale)
    );
    if (img !== probe && img.close) img.close();
  }
  if (probe.close) probe.close();

  state.original = original;
  state.cropRect = { x: 0, y: 0, w, h };

  $('#loading').hidden = true;
  resizeStage();
  zoomToFit();
  updateStatus();
  updateUndoButtons();

  if (meta.layout.truncated) {
    flashStatus('Page exceeded the maximum capture height — image was truncated.', true);
  } else if (state.downscaled) {
    flashStatus('Very large page — image was scaled down to fit canvas limits.', true);
  }

  if (meta.settings?.afterCapture === 'download') {
    const fmt = meta.settings.format === 'jpeg' ? 'jpeg' : meta.settings.format === 'pdf' ? 'pdf' : 'png';
    if (fmt === 'pdf') exportPdf();
    else exportImage(fmt);
  }
}

function fatal(message) {
  $('#loading .spinner')?.remove();
  $('#loading-text').textContent = message;
}

function blobToImage(blob) {
  return createImageBitmap(blob);
}

/* ================= camera / rendering ================= */

function displayDpr() {
  return window.devicePixelRatio || 1;
}

function stageSize() {
  return { w: stageWrap.clientWidth, h: stageWrap.clientHeight };
}

function resizeStage() {
  const { w, h } = stageSize();
  const dpr = displayDpr();
  stage.width = Math.max(1, Math.round(w * dpr));
  stage.height = Math.max(1, Math.round(h * dpr));
  render();
}

function clampPan() {
  const { w, h } = stageSize();
  const crop = state.cropRect;
  if (!crop) return;
  const viewW = w / state.zoom;
  const viewH = h / state.zoom;
  if (crop.w <= viewW) {
    state.panX = (crop.w - viewW) / 2;
  } else {
    state.panX = Math.min(Math.max(state.panX, 0), crop.w - viewW);
  }
  if (crop.h <= viewH) {
    state.panY = (crop.h - viewH) / 2;
  } else {
    state.panY = Math.min(Math.max(state.panY, 0), crop.h - viewH);
  }
}

function zoomToFit() {
  const { w, h } = stageSize();
  const crop = state.cropRect;
  if (!crop) return;
  state.zoom = Math.min(w / crop.w, h / crop.h) * 0.98;
  state.panX = 0;
  state.panY = 0;
  clampPan();
  render();
}

function setZoom(newZoom, pivotScreen) {
  const crop = state.cropRect;
  if (!crop) return;
  newZoom = Math.min(8, Math.max(0.02, newZoom));
  const { w, h } = stageSize();
  const pivot = pivotScreen || { x: w / 2, y: h / 2 };
  // Keep the content point under the pivot stationary.
  const cx = pivot.x / state.zoom + state.panX;
  const cy = pivot.y / state.zoom + state.panY;
  state.zoom = newZoom;
  state.panX = cx - pivot.x / newZoom;
  state.panY = cy - pivot.y / newZoom;
  clampPan();
  render();
}

// screen (css px in stage) -> image coords
function toImage(sx, sy) {
  const crop = state.cropRect;
  return {
    x: sx / state.zoom + state.panX + crop.x,
    y: sy / state.zoom + state.panY + crop.y,
  };
}

// image coords -> screen css px
function toScreen(ix, iy) {
  const crop = state.cropRect;
  return {
    x: (ix - crop.x - state.panX) * state.zoom,
    y: (iy - crop.y - state.panY) * state.zoom,
  };
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(doRender);
}

function doRender() {
  renderQueued = false;
  if (!state.original) return;

  const dpr = displayDpr();
  const crop = state.cropRect;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#17181c';
  ctx.fillRect(0, 0, stage.width, stage.height);

  const k = dpr * state.zoom;
  ctx.setTransform(k, 0, 0, k, -k * (state.panX + crop.x), -k * (state.panY + crop.y));

  ctx.save();
  ctx.beginPath();
  ctx.rect(crop.x, crop.y, crop.w, crop.h);
  ctx.clip();

  ctx.imageSmoothingEnabled = state.zoom < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.original, 0, 0);

  for (const obj of state.objects) {
    drawObject(ctx, obj);
  }
  ctx.restore();

  // In-progress crop selection overlay
  const marquee = state.pendingCrop || (state.action?.kind === 'crop-select' && state.action.rect);
  if (state.tool === 'crop' && marquee) {
    drawCropOverlay(marquee);
  }

  drawSelection();
  $('#zoom-label').textContent = `${Math.round(state.zoom * 100)}%`;
}

function drawCropOverlay(rect) {
  const r = normRect(rect);
  const dpr = displayDpr();
  const a = toScreen(r.x, r.y);
  const b = toScreen(r.x + r.w, r.y + r.h);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { w, h } = stageSize();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.fill('evenodd');
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.setLineDash([]);
}

function drawSelection() {
  const obj = getObject(state.selectedId);
  if (!obj || state.tool !== 'select') return;
  const bounds = objectBounds(obj);
  const dpr = displayDpr();
  const a = toScreen(bounds.x, bounds.y);
  const b = toScreen(bounds.x + bounds.w, bounds.y + bounds.h);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = '#1a73e8';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(a.x - 4, a.y - 4, b.x - a.x + 8, b.y - a.y + 8);
  ctx.setLineDash([]);
  for (const hd of selectionHandles(obj)) {
    const p = toScreen(hd.x, hd.y);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1a73e8';
    ctx.beginPath();
    ctx.rect(p.x - 4, p.y - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
  }
}

/* ================= object drawing ================= */

function drawObject(c, obj) {
  c.save();
  switch (obj.type) {
    case 'pen':
    case 'highlight': {
      if (obj.points.length < 2) break;
      c.strokeStyle = obj.color;
      c.lineJoin = 'round';
      if (obj.type === 'highlight') {
        c.globalAlpha = 0.35;
        c.lineWidth = obj.width * 4;
        c.lineCap = 'butt';
      } else {
        c.lineWidth = obj.width;
        c.lineCap = 'round';
      }
      c.beginPath();
      c.moveTo(obj.points[0].x, obj.points[0].y);
      for (let i = 1; i < obj.points.length; i++) c.lineTo(obj.points[i].x, obj.points[i].y);
      c.stroke();
      break;
    }
    case 'line': {
      c.strokeStyle = obj.color;
      c.lineWidth = obj.width;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(obj.x1, obj.y1);
      c.lineTo(obj.x2, obj.y2);
      c.stroke();
      break;
    }
    case 'arrow': {
      c.strokeStyle = obj.color;
      c.fillStyle = obj.color;
      c.lineWidth = obj.width;
      c.lineCap = 'round';
      const head = Math.max(10, obj.width * 3.2);
      const ang = Math.atan2(obj.y2 - obj.y1, obj.x2 - obj.x1);
      const bx = obj.x2 - head * Math.cos(ang);
      const by = obj.y2 - head * Math.sin(ang);
      c.beginPath();
      c.moveTo(obj.x1, obj.y1);
      c.lineTo(bx, by);
      c.stroke();
      c.beginPath();
      c.moveTo(obj.x2, obj.y2);
      c.lineTo(obj.x2 - head * Math.cos(ang - 0.42), obj.y2 - head * Math.sin(ang - 0.42));
      c.lineTo(obj.x2 - head * Math.cos(ang + 0.42), obj.y2 - head * Math.sin(ang + 0.42));
      c.closePath();
      c.fill();
      break;
    }
    case 'rect': {
      const r = normRect(obj);
      c.strokeStyle = obj.color;
      c.lineWidth = obj.width;
      c.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'ellipse': {
      const r = normRect(obj);
      c.strokeStyle = obj.color;
      c.lineWidth = obj.width;
      c.beginPath();
      c.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(1, r.w / 2), Math.max(1, r.h / 2), 0, 0, Math.PI * 2);
      c.stroke();
      break;
    }
    case 'text': {
      c.fillStyle = obj.color;
      c.font = `600 ${obj.size}px system-ui, -apple-system, sans-serif`;
      c.textBaseline = 'top';
      const lines = obj.text.split('\n');
      lines.forEach((line, i) => c.fillText(line, obj.x, obj.y + i * obj.size * 1.25));
      break;
    }
    case 'blur': {
      const r = normRect(obj);
      if (r.w < 2 || r.h < 2) break;
      c.drawImage(pixelated(obj, r), r.x, r.y);
      break;
    }
  }
  c.restore();
}

function pixelated(obj, r) {
  const block = Math.max(6, obj.width * 3);
  const sig = `${r.x},${r.y},${r.w},${r.h},${block}`;
  const cached = blurCache.get(obj);
  if (cached && cached.sig === sig) return cached.canvas;

  const src = state.original;
  const sx = Math.max(0, Math.min(src.width - 1, Math.round(r.x)));
  const sy = Math.max(0, Math.min(src.height - 1, Math.round(r.y)));
  const sw = Math.max(1, Math.min(src.width - sx, Math.round(r.w)));
  const sh = Math.max(1, Math.min(src.height - sy, Math.round(r.h)));

  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.ceil(sw / block));
  small.height = Math.max(1, Math.ceil(sh / block));
  const sctx = small.getContext('2d');
  sctx.drawImage(src, sx, sy, sw, sh, 0, 0, small.width, small.height);

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r.w));
  out.height = Math.max(1, Math.round(r.h));
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = false;
  octx.drawImage(small, 0, 0, small.width, small.height, 0, 0, out.width, out.height);

  blurCache.set(obj, { sig, canvas: out });
  return out;
}

/* ================= geometry helpers ================= */

function normRect(r) {
  const x = r.w < 0 ? r.x + r.w : r.x;
  const y = r.h < 0 ? r.y + r.h : r.y;
  return { x, y, w: Math.abs(r.w), h: Math.abs(r.h) };
}

function measureText(obj) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `600 ${obj.size}px system-ui, -apple-system, sans-serif`;
  const lines = obj.text.split('\n');
  let w = 0;
  for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
  ctx.restore();
  return { w, h: lines.length * obj.size * 1.25 };
}

function objectBounds(obj) {
  switch (obj.type) {
    case 'pen':
    case 'highlight': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of obj.points) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      const pad = (obj.type === 'highlight' ? obj.width * 2 : obj.width / 2) + 2;
      return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    }
    case 'line':
    case 'arrow': {
      const x = Math.min(obj.x1, obj.x2);
      const y = Math.min(obj.y1, obj.y2);
      return { x, y, w: Math.abs(obj.x2 - obj.x1), h: Math.abs(obj.y2 - obj.y1) };
    }
    case 'text': {
      const m = measureText(obj);
      return { x: obj.x, y: obj.y, w: m.w, h: m.h };
    }
    default:
      return normRect(obj);
  }
}

function selectionHandles(obj) {
  if (obj.type === 'line' || obj.type === 'arrow') {
    return [
      { id: 'p1', x: obj.x1, y: obj.y1 },
      { id: 'p2', x: obj.x2, y: obj.y2 },
    ];
  }
  if (obj.type === 'rect' || obj.type === 'ellipse' || obj.type === 'blur') {
    const r = normRect(obj);
    return [
      { id: 'nw', x: r.x, y: r.y },
      { id: 'ne', x: r.x + r.w, y: r.y },
      { id: 'sw', x: r.x, y: r.y + r.h },
      { id: 'se', x: r.x + r.w, y: r.y + r.h },
    ];
  }
  return [];
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx, py = a.y + t * dy;
  return Math.hypot(p.x - px, p.y - py);
}

function hitTest(pt) {
  const tol = 6 / state.zoom;
  for (let i = state.objects.length - 1; i >= 0; i--) {
    const obj = state.objects[i];
    switch (obj.type) {
      case 'line':
      case 'arrow':
        if (distToSegment(pt, { x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 }) <= obj.width / 2 + tol) {
          return obj;
        }
        break;
      case 'pen':
      case 'highlight': {
        const w = (obj.type === 'highlight' ? obj.width * 2 : obj.width / 2) + tol;
        for (let j = 1; j < obj.points.length; j++) {
          if (distToSegment(pt, obj.points[j - 1], obj.points[j]) <= w) return obj;
        }
        break;
      }
      default: {
        const b = objectBounds(obj);
        if (pt.x >= b.x - tol && pt.x <= b.x + b.w + tol && pt.y >= b.y - tol && pt.y <= b.y + b.h + tol) {
          return obj;
        }
      }
    }
  }
  return null;
}

function getObject(id) {
  return state.objects.find((o) => o.id === id) || null;
}

/* ================= undo / redo ================= */

function snapshot() {
  return JSON.stringify({ objects: state.objects, cropRect: state.cropRect });
}

function pushUndo() {
  state.undoStack.push(snapshot());
  if (state.undoStack.length > 100) state.undoStack.shift();
  state.redoStack.length = 0;
  updateUndoButtons();
}

function applySnapshot(snap) {
  const data = JSON.parse(snap);
  state.objects = data.objects;
  state.cropRect = data.cropRect;
  state.selectedId = null;
  clampPan();
  render();
  updateStatus();
}

function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(snapshot());
  applySnapshot(state.undoStack.pop());
  updateUndoButtons();
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(snapshot());
  applySnapshot(state.redoStack.pop());
  updateUndoButtons();
}

function updateUndoButtons() {
  $('#btn-undo').disabled = !state.undoStack.length;
  $('#btn-redo').disabled = !state.redoStack.length;
  $('#btn-delete').disabled = !state.selectedId;
}

/* ================= tools & pointer input ================= */

function setTool(tool) {
  state.tool = tool;
  state.selectedId = null;
  if (tool !== 'crop') {
    state.pendingCrop = null;
    $('#crop-bar').hidden = true;
  } else {
    $('#crop-bar').hidden = false;
    $('#crop-apply').disabled = true;
  }
  commitTextInput();
  document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  stage.className = `tool-${tool}`;
  updateUndoButtons();
  render();
}

function stagePoint(ev) {
  const rect = stage.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

stage.addEventListener('pointerdown', (ev) => {
  if (ev.button === 1 || (ev.button === 0 && ev.altKey)) {
    // middle mouse or alt+drag pans in any tool
    state.action = { kind: 'pan', startX: ev.clientX, startY: ev.clientY, panX: state.panX, panY: state.panY };
    stage.classList.add('panning');
    stage.setPointerCapture(ev.pointerId);
    return;
  }
  if (ev.button !== 0 || !state.original) return;
  stage.focus();
  commitTextInput();

  const sp = stagePoint(ev);
  const pt = toImage(sp.x, sp.y);
  stage.setPointerCapture(ev.pointerId);

  switch (state.tool) {
    case 'select': {
      const sel = getObject(state.selectedId);
      if (sel) {
        for (const hd of selectionHandles(sel)) {
          const hp = toScreen(hd.x, hd.y);
          if (Math.abs(hp.x - sp.x) <= 7 && Math.abs(hp.y - sp.y) <= 7) {
            pushUndo();
            state.action = { kind: 'resize', obj: sel, handle: hd.id, start: pt };
            return;
          }
        }
      }
      const hit = hitTest(pt);
      state.selectedId = hit ? hit.id : null;
      updateUndoButtons();
      if (hit) {
        pushUndo();
        state.action = { kind: 'move', obj: hit, start: pt, moved: false };
      } else {
        state.action = { kind: 'pan', startX: ev.clientX, startY: ev.clientY, panX: state.panX, panY: state.panY };
        stage.classList.add('panning');
      }
      render();
      break;
    }
    case 'crop': {
      state.pendingCrop = null;
      state.action = { kind: 'crop-select', rect: { x: pt.x, y: pt.y, w: 0, h: 0 } };
      $('#crop-apply').disabled = true;
      break;
    }
    case 'text': {
      openTextInput(pt);
      break;
    }
    case 'pen':
    case 'highlight': {
      pushUndo();
      const obj = {
        id: state.idSeq++,
        type: state.tool,
        points: [{ x: pt.x, y: pt.y }],
        color: state.color,
        width: state.strokeWidth,
      };
      state.objects.push(obj);
      state.action = { kind: 'draw', obj };
      break;
    }
    case 'line':
    case 'arrow': {
      pushUndo();
      const obj = {
        id: state.idSeq++,
        type: state.tool,
        x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y,
        color: state.color,
        width: state.strokeWidth,
      };
      state.objects.push(obj);
      state.action = { kind: 'draw', obj };
      break;
    }
    case 'rect':
    case 'ellipse':
    case 'blur': {
      pushUndo();
      const obj = {
        id: state.idSeq++,
        type: state.tool,
        x: pt.x, y: pt.y, w: 0, h: 0,
        color: state.color,
        width: state.strokeWidth,
      };
      state.objects.push(obj);
      state.action = { kind: 'draw', obj };
      break;
    }
  }
});

stage.addEventListener('pointermove', (ev) => {
  const action = state.action;
  if (!action) return;
  const sp = stagePoint(ev);
  const pt = toImage(sp.x, sp.y);

  switch (action.kind) {
    case 'pan': {
      state.panX = action.panX - (ev.clientX - action.startX) / state.zoom;
      state.panY = action.panY - (ev.clientY - action.startY) / state.zoom;
      clampPan();
      break;
    }
    case 'draw': {
      const obj = action.obj;
      if (obj.type === 'pen' || obj.type === 'highlight') {
        const last = obj.points[obj.points.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) > 1.5 / state.zoom) {
          obj.points.push({ x: pt.x, y: pt.y });
        }
      } else if (obj.type === 'line' || obj.type === 'arrow') {
        obj.x2 = pt.x;
        obj.y2 = pt.y;
        if (ev.shiftKey) snapAngle(obj);
      } else {
        obj.w = pt.x - obj.x;
        obj.h = pt.y - obj.y;
        if (ev.shiftKey) {
          const s = Math.max(Math.abs(obj.w), Math.abs(obj.h));
          obj.w = Math.sign(obj.w || 1) * s;
          obj.h = Math.sign(obj.h || 1) * s;
        }
      }
      break;
    }
    case 'move': {
      const dx = pt.x - action.start.x;
      const dy = pt.y - action.start.y;
      if (!action.moved && Math.hypot(dx, dy) < 2 / state.zoom) return;
      action.moved = true;
      moveObject(action.obj, dx, dy);
      action.start = pt;
      break;
    }
    case 'resize': {
      resizeObject(action.obj, action.handle, pt);
      break;
    }
    case 'crop-select': {
      action.rect.w = pt.x - action.rect.x;
      action.rect.h = pt.y - action.rect.y;
      break;
    }
  }
  render();
});

stage.addEventListener('pointerup', (ev) => {
  const action = state.action;
  state.action = null;
  stage.classList.remove('panning');
  if (!action) return;

  if (action.kind === 'draw') {
    const obj = action.obj;
    const b = objectBounds(obj);
    const tiny = 3 / state.zoom;
    const degenerate =
      (obj.type === 'pen' || obj.type === 'highlight')
        ? obj.points.length < 2
        : b.w < tiny && b.h < tiny;
    if (degenerate) {
      state.objects.pop();
      state.undoStack.pop();
      updateUndoButtons();
    }
    render();
  } else if (action.kind === 'move' && !action.moved) {
    // click without drag: not a real mutation
    state.undoStack.pop();
    updateUndoButtons();
  } else if (action.kind === 'crop-select') {
    const r = normRect(action.rect);
    if (r.w > 4 && r.h > 4) {
      const crop = state.cropRect;
      r.x = Math.max(crop.x, Math.min(crop.x + crop.w, r.x));
      r.y = Math.max(crop.y, Math.min(crop.y + crop.h, r.y));
      r.w = Math.min(r.w, crop.x + crop.w - r.x);
      r.h = Math.min(r.h, crop.y + crop.h - r.y);
      state.pendingCrop = r;
      $('#crop-apply').disabled = false;
    } else {
      state.pendingCrop = null;
      $('#crop-apply').disabled = true;
    }
    render();
  }
});

function snapAngle(obj) {
  const dx = obj.x2 - obj.x1;
  const dy = obj.y2 - obj.y1;
  const len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  obj.x2 = obj.x1 + len * Math.cos(ang);
  obj.y2 = obj.y1 + len * Math.sin(ang);
}

function moveObject(obj, dx, dy) {
  switch (obj.type) {
    case 'pen':
    case 'highlight':
      for (const p of obj.points) { p.x += dx; p.y += dy; }
      break;
    case 'line':
    case 'arrow':
      obj.x1 += dx; obj.y1 += dy; obj.x2 += dx; obj.y2 += dy;
      break;
    default:
      obj.x += dx; obj.y += dy;
  }
}

function resizeObject(obj, handle, pt) {
  if (obj.type === 'line' || obj.type === 'arrow') {
    if (handle === 'p1') { obj.x1 = pt.x; obj.y1 = pt.y; }
    else { obj.x2 = pt.x; obj.y2 = pt.y; }
    return;
  }
  const r = normRect(obj);
  let { x, y, w, h } = r;
  if (handle.includes('w')) { w += x - pt.x; x = pt.x; }
  if (handle.includes('e')) { w = pt.x - x; }
  if (handle.includes('n')) { h += y - pt.y; y = pt.y; }
  if (handle.includes('s')) { h = pt.y - y; }
  obj.x = x; obj.y = y; obj.w = w; obj.h = h;
}

/* ================= text tool ================= */

function openTextInput(pt, existing) {
  commitTextInput();
  const size = existing ? existing.size : textSizeFromStroke();
  const color = existing ? existing.color : state.color;
  const screen = toScreen(existing ? existing.x : pt.x, existing ? existing.y : pt.y);

  textInput.value = existing ? existing.text : '';
  textInput.style.left = `${stage.offsetLeft + screen.x}px`;
  textInput.style.top = `${stage.offsetTop + screen.y}px`;
  textInput.style.fontSize = `${size * state.zoom}px`;
  textInput.style.fontWeight = '600';
  textInput.style.lineHeight = '1.25';
  textInput.style.color = color;
  textInput.hidden = false;
  textInput.dataset.x = existing ? existing.x : pt.x;
  textInput.dataset.y = existing ? existing.y : pt.y;
  textInput.dataset.size = size;
  textInput.dataset.color = color;
  state.editingTextId = existing ? existing.id : null;
  if (existing) {
    // Temporarily remove the object while it is being edited in the textarea.
    state.objects = state.objects.filter((o) => o !== existing);
    state.hiddenTextObj = existing;
    render();
  }
  autosizeTextInput();
  setTimeout(() => textInput.focus(), 0);
}

function textSizeFromStroke() {
  return Math.round(10 + state.strokeWidth * 3.5);
}

function autosizeTextInput() {
  textInput.style.height = 'auto';
  textInput.style.width = 'auto';
  textInput.style.height = `${textInput.scrollHeight}px`;
  textInput.style.width = `${Math.max(120, textInput.scrollWidth + 12)}px`;
}

textInput.addEventListener('input', autosizeTextInput);
textInput.addEventListener('keydown', (ev) => {
  ev.stopPropagation();
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    commitTextInput();
  } else if (ev.key === 'Escape') {
    textInput.hidden = true;
    if (state.hiddenTextObj) {
      state.objects.push(state.hiddenTextObj);
      state.hiddenTextObj = null;
      render();
    }
    textInput.value = '';
  }
});
textInput.addEventListener('blur', () => commitTextInput());

function commitTextInput() {
  if (textInput.hidden) return;
  const text = textInput.value.replace(/\s+$/, '');
  const restore = state.hiddenTextObj;
  state.hiddenTextObj = null;
  textInput.hidden = true;
  textInput.value = '';

  // The undo snapshot must include the pre-edit text object (it was removed
  // from the list when editing started), so put it back before snapshotting.
  if (restore) state.objects.push(restore);

  if (!text) {
    if (restore) {
      pushUndo(); // deleting the text by clearing it
      state.objects = state.objects.filter((o) => o !== restore);
    }
    render();
    return;
  }
  pushUndo();
  if (restore) state.objects = state.objects.filter((o) => o !== restore);
  state.objects.push({
    id: restore ? restore.id : state.idSeq++,
    type: 'text',
    x: Number(textInput.dataset.x),
    y: Number(textInput.dataset.y),
    text,
    color: textInput.dataset.color,
    size: Number(textInput.dataset.size),
  });
  render();
}

stage.addEventListener('dblclick', (ev) => {
  if (state.tool !== 'select') return;
  const sp = stagePoint(ev);
  const pt = toImage(sp.x, sp.y);
  const hit = hitTest(pt);
  if (hit && hit.type === 'text') {
    openTextInput(pt, hit);
  }
});

/* ================= crop ================= */

$('#crop-apply').addEventListener('click', () => {
  if (!state.pendingCrop) return;
  pushUndo();
  state.cropRect = {
    x: Math.round(state.pendingCrop.x),
    y: Math.round(state.pendingCrop.y),
    w: Math.max(1, Math.round(state.pendingCrop.w)),
    h: Math.max(1, Math.round(state.pendingCrop.h)),
  };
  state.pendingCrop = null;
  setTool('select');
  zoomToFit();
  updateStatus();
  flashStatus('Cropped. Undo with Ctrl+Z.');
});

$('#crop-cancel').addEventListener('click', () => {
  state.pendingCrop = null;
  setTool('select');
});

/* ================= export ================= */

function compositeCanvas() {
  const crop = state.cropRect;
  const out = document.createElement('canvas');
  out.width = crop.w;
  out.height = crop.h;
  const c = out.getContext('2d');
  c.translate(-crop.x, -crop.y);
  c.drawImage(state.original, 0, 0);
  for (const obj of state.objects) drawObject(c, obj);
  return out;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to encode image.'))),
      type,
      quality
    );
  });
}

async function download(blob, ext) {
  const filename = buildFilename(
    state.settings.filenameTemplate,
    { title: state.meta.title, url: state.meta.url, ts: state.meta.ts },
    ext
  );
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename });
    flashStatus(`Saved ${filename}`);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function exportImage(format) {
  try {
    const canvas = compositeCanvas();
    const blob =
      format === 'jpeg'
        ? await canvasToBlob(canvas, 'image/jpeg', clampQuality())
        : await canvasToBlob(canvas, 'image/png');
    await download(blob, format === 'jpeg' ? 'jpg' : 'png');
  } catch (err) {
    flashStatus(`Export failed: ${err.message}`, true);
  }
}

function clampQuality() {
  const q = Number(state.settings.jpegQuality) || 92;
  return Math.min(1, Math.max(0.1, q / 100));
}

async function exportPdf() {
  try {
    const canvas = compositeCanvas();
    const paper = state.settings.pdfPaper || 'image';
    const pages = [];

    if (paper === 'a4' || paper === 'letter') {
      const size = PAPER_SIZES[paper];
      const pagePxHeight = Math.max(1, Math.round((canvas.width * size.h) / size.w));
      for (let y = 0; y < canvas.height; y += pagePxHeight) {
        const sliceH = Math.min(pagePxHeight, canvas.height - y);
        const slice = document.createElement('canvas');
        slice.width = canvas.width;
        slice.height = sliceH;
        slice.getContext('2d').drawImage(canvas, 0, -y);
        const jpegBytes = new Uint8Array(
          await (await canvasToBlob(slice, 'image/jpeg', clampQuality())).arrayBuffer()
        );
        pages.push({
          jpegBytes,
          pxWidth: slice.width,
          pxHeight: slice.height,
          ptWidth: size.w,
          ptHeight: (size.w * sliceH) / canvas.width,
        });
      }
    } else {
      // one long page; PDF pages are limited to 14400pt per side
      let ptW = canvas.width * 0.75;
      let ptH = canvas.height * 0.75;
      const s = Math.min(1, 14400 / ptW, 14400 / ptH);
      ptW *= s;
      ptH *= s;
      const jpegBytes = new Uint8Array(
        await (await canvasToBlob(canvas, 'image/jpeg', clampQuality())).arrayBuffer()
      );
      pages.push({ jpegBytes, pxWidth: canvas.width, pxHeight: canvas.height, ptWidth: ptW, ptHeight: ptH });
    }

    await download(buildPdf(pages), 'pdf');
  } catch (err) {
    flashStatus(`PDF export failed: ${err.message}`, true);
  }
}

async function copyToClipboard() {
  try {
    const canvas = compositeCanvas();
    const blob = await canvasToBlob(canvas, 'image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    flashStatus('Copied to clipboard.');
  } catch (err) {
    flashStatus(`Copy failed: ${err.message}`, true);
  }
}

async function printImage() {
  try {
    const canvas = compositeCanvas();
    const blob = await canvasToBlob(canvas, 'image/png');
    const url = URL.createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    doc.open();
    doc.write(
      `<!DOCTYPE html><html><head><title>Print</title><style>` +
        `body{margin:0}img{width:100%;display:block}` +
        `</style></head><body><img src="${url}"></body></html>`
    );
    doc.close();
    doc.querySelector('img').onload = () => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(() => {
        iframe.remove();
        URL.revokeObjectURL(url);
      }, 60000);
    };
  } catch (err) {
    flashStatus(`Print failed: ${err.message}`, true);
  }
}

/* ================= status bar ================= */

function updateStatus() {
  if (!state.cropRect) return;
  const { w, h } = state.cropRect;
  const scale = state.canvasScale;
  const cssW = Math.round(w / scale);
  const cssH = Math.round(h / scale);
  $('#status-dims').textContent =
    `${w} × ${h} px` + (Math.abs(scale - 1) > 0.01 ? ` (${cssW} × ${cssH} CSS px)` : '');
}

let statusTimer = null;
function flashStatus(message, isError = false) {
  const el = $('#status-msg');
  el.textContent = message;
  el.className = isError ? 'error' : 'flash';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.textContent = '';
    el.className = '';
  }, isError ? 8000 : 4000);
}

/* ================= UI wiring ================= */

document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

document.querySelectorAll('.swatch').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.color = btn.dataset.color;
    document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b === btn));
    $('#color-custom').value = rgbToHex(btn.dataset.color);
    applyStyleToSelection();
  });
});

$('#color-custom').addEventListener('input', (ev) => {
  state.color = ev.target.value;
  document.querySelectorAll('.swatch').forEach((b) => b.classList.remove('active'));
  applyStyleToSelection();
});

// A slider drag fires many 'input' events; record a single undo entry per drag.
let strokeDragUndoPushed = false;
$('#stroke-width').addEventListener('input', (ev) => {
  state.strokeWidth = Number(ev.target.value);
  applyStyleToSelection(!strokeDragUndoPushed);
  if (getObject(state.selectedId)) strokeDragUndoPushed = true;
});
$('#stroke-width').addEventListener('change', () => {
  strokeDragUndoPushed = false;
});

function applyStyleToSelection(recordUndo = true) {
  const obj = getObject(state.selectedId);
  if (!obj) return;
  if (recordUndo) pushUndo();
  if ('color' in obj) obj.color = state.color;
  if (obj.type === 'text') obj.size = textSizeFromStroke();
  else if ('width' in obj) obj.width = state.strokeWidth;
  blurCache.delete(obj);
  render();
}

function rgbToHex(color) {
  return /^#([0-9a-f]{6})$/i.test(color) ? color : '#e8352a';
}

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-delete').addEventListener('click', deleteSelection);

function deleteSelection() {
  const obj = getObject(state.selectedId);
  if (!obj) return;
  pushUndo();
  state.objects = state.objects.filter((o) => o !== obj);
  state.selectedId = null;
  updateUndoButtons();
  render();
}

$('#btn-zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.25));
$('#btn-zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.25));
$('#btn-zoom-fit').addEventListener('click', zoomToFit);
$('#btn-zoom-100').addEventListener('click', () => setZoom(1));

$('#btn-download-png').addEventListener('click', () => exportImage('png'));
$('#btn-download-jpeg').addEventListener('click', () => exportImage('jpeg'));
$('#btn-download-pdf').addEventListener('click', exportPdf);
$('#btn-copy').addEventListener('click', copyToClipboard);
$('#btn-print').addEventListener('click', printImage);
$('#btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

stage.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (!state.original) return;
  if (ev.ctrlKey || ev.metaKey) {
    const factor = Math.pow(1.0015, -ev.deltaY);
    setZoom(state.zoom * factor, stagePoint(ev));
  } else {
    state.panX += (ev.shiftKey ? ev.deltaY : ev.deltaX) / state.zoom;
    state.panY += (ev.shiftKey ? 0 : ev.deltaY) / state.zoom;
    clampPan();
    render();
  }
}, { passive: false });

const TOOL_KEYS = {
  v: 'select', c: 'crop', p: 'pen', h: 'highlight', l: 'line',
  a: 'arrow', r: 'rect', e: 'ellipse', t: 'text', b: 'blur',
};

window.addEventListener('keydown', (ev) => {
  if (ev.target === textInput) return;
  const mod = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();

  if (mod && key === 'z') {
    ev.preventDefault();
    ev.shiftKey ? redo() : undo();
  } else if (mod && key === 'y') {
    ev.preventDefault();
    redo();
  } else if (mod && (key === '=' || key === '+')) {
    ev.preventDefault();
    setZoom(state.zoom * 1.25);
  } else if (mod && key === '-') {
    ev.preventDefault();
    setZoom(state.zoom / 1.25);
  } else if (mod && key === '0') {
    ev.preventDefault();
    zoomToFit();
  } else if (mod && key === 'c' && state.selectedId === null) {
    // plain Ctrl+C with nothing selected copies the image
    copyToClipboard();
  } else if (mod && key === 's') {
    ev.preventDefault();
    exportImage(state.settings?.format === 'jpeg' ? 'jpeg' : 'png');
  } else if (!mod && (ev.key === 'Delete' || ev.key === 'Backspace')) {
    if (state.selectedId !== null) {
      ev.preventDefault();
      deleteSelection();
    }
  } else if (!mod && ev.key === 'Escape') {
    if (state.tool === 'crop') {
      state.pendingCrop = null;
      setTool('select');
    } else {
      state.selectedId = null;
      updateUndoButtons();
      render();
    }
  } else if (!mod && !ev.altKey && TOOL_KEYS[key]) {
    setTool(TOOL_KEYS[key]);
  }
});

window.addEventListener('resize', resizeStage);
new ResizeObserver(resizeStage).observe(stageWrap);

setTool('select');
init().catch((err) => {
  console.error(err);
  fatal(`Failed to load capture: ${err.message}`);
});
