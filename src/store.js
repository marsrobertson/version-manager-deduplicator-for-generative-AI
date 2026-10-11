/* GenCull storage: IndexedDB for bulky data, localStorage for small settings. */
const GCStore = (() => {
  'use strict';
  const DB_NAME = 'gencull';
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          for (const name of ['kv', 'hashes', 'thumbs']) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch(err => { dbPromise = null; throw err; });
    }
    return dbPromise;
  }

  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const result = fn(t.objectStore(store));
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const get = (store, key) => tx(store, 'readonly', s => s.get(key)).catch(() => undefined);
  const set = (store, key, value) => tx(store, 'readwrite', s => { s.put(value, key); }).catch(() => undefined);
  const del = (store, key) => tx(store, 'readwrite', s => { s.delete(key); }).catch(() => undefined);

  async function getMany(store, keys) {
    const out = new Map();
    try {
      const d = await db();
      await new Promise((resolve, reject) => {
        const t = d.transaction(store, 'readonly');
        const s = t.objectStore(store);
        for (const k of keys) { const r = s.get(k); r.onsuccess = () => { if (r.result !== undefined) out.set(k, r.result); }; }
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    } catch { /* cache is optional */ }
    return out;
  }

  function lsGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  }
  function lsDel(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

  return { get, set, del, getMany, lsGet, lsSet, lsDel };
})();
