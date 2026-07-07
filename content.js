// Content script: measures the page, walks it scroll-position by
// scroll-position on request from the background worker, and restores
// everything afterwards. Injected on demand; must be idempotent.

(() => {
  if (window.__fullPageCap) return;

  const state = {
    scroller: null,        // element whose scrollLeft/Top we drive (null = window)
    positions: [],
    originalScroll: { x: 0, y: 0 },
    styleEl: null,
    hiddenEls: [],         // [{ el, visibility }]
    settings: null,
    prepared: false,
    truncated: false,
  };

  window.__fullPageCap = state;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getWindowScroller() {
    return document.scrollingElement || document.documentElement;
  }

  // Some apps (Gmail-style layouts) keep <html> unscrollable and scroll an
  // inner element instead. If the window can't scroll, find the largest
  // scrollable element and capture that one.
  function pickScroller() {
    const winScroller = getWindowScroller();
    const canWindowScroll =
      winScroller.scrollHeight > window.innerHeight + 1 ||
      winScroller.scrollWidth > window.innerWidth + 1;
    if (canWindowScroll) return { el: null, node: winScroller };

    let best = null;
    let bestArea = 0;
    const els = document.querySelectorAll('body *');
    for (const el of els) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      const cs = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea && rect.width >= window.innerWidth * 0.5) {
        best = el;
        bestArea = area;
      }
    }
    if (best) return { el: best, node: best };
    return { el: null, node: winScroller };
  }

  function scrollDims(node, el) {
    if (el) {
      return {
        totalWidth: el.scrollWidth,
        totalHeight: el.scrollHeight,
        vw: el.clientWidth,
        vh: el.clientHeight,
      };
    }
    return {
      totalWidth: Math.max(node.scrollWidth, document.documentElement.scrollWidth),
      totalHeight: Math.max(node.scrollHeight, document.documentElement.scrollHeight),
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  }

  function setScroll(x, y) {
    if (state.scroller) {
      state.scroller.scrollLeft = x;
      state.scroller.scrollTop = y;
    } else {
      window.scrollTo(x, y);
    }
  }

  function getScroll() {
    if (state.scroller) {
      return { x: state.scroller.scrollLeft, y: state.scroller.scrollTop };
    }
    const n = getWindowScroller();
    return { x: n.scrollLeft, y: n.scrollTop };
  }

  function injectCaptureStyles(hideScrollbars) {
    const el = document.createElement('style');
    el.id = '__fpc-style';
    el.textContent = `
      html { scroll-behavior: auto !important; }
      ${hideScrollbars ? `
      ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
      * { scrollbar-width: none !important; }
      ` : ''}
      *, *::before, *::after {
        animation-play-state: paused !important;
        transition: none !important;
        caret-color: transparent !important;
      }
    `;
    document.documentElement.appendChild(el);
    state.styleEl = el;
  }

  // Hide fixed / sticky elements so headers and cookie bars don't repeat in
  // every stitched row. Called after the first row has been captured, so they
  // still appear once at the top of the final image.
  function hideFixedElements() {
    if (state.hiddenEls.length) return;
    const els = document.querySelectorAll('body *');
    for (const el of els) {
      if (el.id === '__fpc-style') continue;
      let pos;
      try {
        pos = getComputedStyle(el).position;
      } catch {
        continue;
      }
      if (pos === 'fixed' || pos === 'sticky') {
        state.hiddenEls.push({ el, visibility: el.style.visibility, priority: el.style.getPropertyPriority('visibility') });
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }

  function restoreFixedElements() {
    for (const { el, visibility, priority } of state.hiddenEls) {
      if (visibility) el.style.setProperty('visibility', visibility, priority || '');
      else el.style.removeProperty('visibility');
    }
    state.hiddenEls = [];
  }

  function computePositions(dims, maxHeight) {
    let { totalWidth, totalHeight, vw, vh } = dims;
    if (maxHeight > 0 && totalHeight > maxHeight) {
      totalHeight = maxHeight;
      state.truncated = true;
    }
    const positions = [];
    const rows = Math.max(1, Math.ceil(totalHeight / vh));
    const cols = Math.max(1, Math.ceil(totalWidth / vw));
    for (let r = 0; r < rows; r++) {
      // Last row aligns with the bottom edge (may overlap the previous row —
      // the stitcher places frames at their actual scroll offsets).
      const y = Math.min(r * vh, totalHeight - vh);
      for (let c = 0; c < cols; c++) {
        const x = Math.min(c * vw, totalWidth - vw);
        positions.push({ x: Math.max(0, x), y: Math.max(0, y), row: r, col: c });
      }
    }
    return { positions, totalWidth, totalHeight };
  }

  function restore() {
    restoreFixedElements();
    if (state.styleEl) {
      state.styleEl.remove();
      state.styleEl = null;
    }
    if (state.prepared) {
      setScroll(state.originalScroll.x, state.originalScroll.y);
    }
    state.prepared = false;
    state.positions = [];
    state.scroller = null;
  }

  async function prepare(settings) {
    state.settings = settings;
    state.truncated = false;

    const picked = pickScroller();
    state.scroller = picked.el;
    state.originalScroll = getScroll();

    injectCaptureStyles(settings.hideScrollbars !== false);

    // Let layout settle after hiding scrollbars (page width can change).
    await sleep(60);

    const dims = scrollDims(picked.node, picked.el);
    if (dims.totalHeight <= 0 || dims.vw <= 0 || dims.vh <= 0) {
      restore();
      return { ok: false, error: 'Page has no measurable size.' };
    }

    const { positions, totalWidth, totalHeight } = computePositions(
      dims,
      Number(settings.maxCaptureHeight) || 0
    );
    state.positions = positions;
    state.prepared = true;

    // When an inner element scrolls (not the window), captureVisibleTab still
    // grabs the whole viewport — the editor must crop each frame to the
    // scroller's on-screen box. Report that box (in CSS px, viewport-relative).
    let clip = null;
    if (picked.el) {
      const rect = picked.el.getBoundingClientRect();
      clip = {
        x: rect.left + picked.el.clientLeft,
        y: rect.top + picked.el.clientTop,
        w: picked.el.clientWidth,
        h: picked.el.clientHeight,
      };
    }

    return {
      ok: true,
      totalWidth,
      totalHeight,
      vw: dims.vw,
      vh: dims.vh,
      winW: window.innerWidth,
      winH: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      clip,
      positions: positions.map((p) => ({ x: p.x, y: p.y })),
      truncated: state.truncated,
    };
  }

  async function scrollToIndex(index) {
    if (!state.prepared) return { ok: false, error: 'Capture not prepared.' };
    const pos = state.positions[index];
    if (!pos) return { ok: false, error: `No position ${index}.` };

    // After the first row is in the can, hide fixed/sticky elements so they
    // don't repeat. (Row 0 may span several columns; keep them for all of it.)
    if (state.settings.hideFixed !== false && pos.row > 0) {
      hideFixedElements();
    }

    setScroll(pos.x, pos.y);

    // Wait for rendering plus a user-configurable delay for lazy content.
    const extra = Math.max(0, Number(state.settings.captureDelay) || 0);
    await sleep(80 + extra);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const actual = getScroll();
    return { ok: true, x: actual.x, y: actual.y };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('fpc:')) {
      return undefined;
    }
    (async () => {
      switch (msg.type) {
        case 'fpc:prepare':
          return prepare(msg.settings || {});
        case 'fpc:scrollTo':
          return scrollToIndex(msg.index);
        case 'fpc:finish':
          restore();
          return { ok: true };
        default:
          return { ok: false, error: `Unknown message ${msg.type}` };
      }
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // async
  });
})();
