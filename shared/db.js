// IndexedDB storage for captures. Used by both the background service worker
// (writes frames as they are captured) and the editor page (reads them back).

const DB_NAME = 'fullpagecap';
const DB_VERSION = 1;
const CAPTURES = 'captures'; // { id, title, url, ts, layout }
const FRAMES = 'frames';     // { key: `${captureId}:${index}`, captureId, index, x, y, blob }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CAPTURES)) {
        db.createObjectStore(CAPTURES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(FRAMES)) {
        const store = db.createObjectStore(FRAMES, { keyPath: 'key' });
        store.createIndex('byCapture', 'captureId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export async function putCaptureMeta(meta) {
  const db = await openDb();
  try {
    const tx = db.transaction(CAPTURES, 'readwrite');
    tx.objectStore(CAPTURES).put(meta);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function getCaptureMeta(id) {
  const db = await openDb();
  try {
    const tx = db.transaction(CAPTURES, 'readonly');
    const req = tx.objectStore(CAPTURES).get(id);
    await txDone(tx);
    return req.result || null;
  } finally {
    db.close();
  }
}

export async function putFrame(captureId, index, x, y, blob) {
  const db = await openDb();
  try {
    const tx = db.transaction(FRAMES, 'readwrite');
    tx.objectStore(FRAMES).put({ key: `${captureId}:${index}`, captureId, index, x, y, blob });
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function getFrames(captureId) {
  const db = await openDb();
  try {
    const tx = db.transaction(FRAMES, 'readonly');
    const req = tx.objectStore(FRAMES).index('byCapture').getAll(captureId);
    await txDone(tx);
    const frames = req.result || [];
    frames.sort((a, b) => a.index - b.index);
    return frames;
  } finally {
    db.close();
  }
}

export async function deleteCapture(id) {
  const db = await openDb();
  try {
    const tx = db.transaction([CAPTURES, FRAMES], 'readwrite');
    tx.objectStore(CAPTURES).delete(id);
    const idx = tx.objectStore(FRAMES).index('byCapture');
    const cursorReq = idx.openCursor(id);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    await txDone(tx);
  } finally {
    db.close();
  }
}

// Remove captures older than maxAgeMs (default 24h) to keep disk usage bounded.
export async function pruneOldCaptures(maxAgeMs = 24 * 60 * 60 * 1000) {
  const db = await openDb();
  let stale = [];
  try {
    const tx = db.transaction(CAPTURES, 'readonly');
    const req = tx.objectStore(CAPTURES).getAll();
    await txDone(tx);
    const cutoff = Date.now() - maxAgeMs;
    stale = (req.result || []).filter((c) => (c.ts || 0) < cutoff).map((c) => c.id);
  } finally {
    db.close();
  }
  for (const id of stale) {
    await deleteCapture(id);
  }
}
