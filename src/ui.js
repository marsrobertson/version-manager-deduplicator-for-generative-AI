/*
 * GenCull UI and orchestration. Plain DOM inside a shadow root: no
 * innerHTML (ChatGPT may enforce Trusted Types) and no page CSS leaks in.
 */
const GCApp = (() => {
  'use strict';
  const C = GCCore, N = GCNet, S = GCStore;
  const VERSION = '__VERSION__';
  const fmt = C.formatBytes;
  const num = n => Number(n || 0).toLocaleString();

  // ----------------------------------------------------------------- DOM ----

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') el.textContent = v;
      else if (typeof v !== 'string' && k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const btn = (label, onClick, props = {}) => h('button', { type: 'button', ...props, onclick: onClick }, label);
  // Element.append(null) inserts the text "null"; skip empty slots instead.
  const add = (el, ...kids) => el.append(...kids.flat().filter(k => k != null && k !== false));
  const plural = (n, word, many = `${word}s`) => `${num(n)} ${n === 1 ? word : many}`;

  function download(name, text, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name });
    root.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);

  // --------------------------------------------------------------- state ----

  const st = {
    open: false, tab: 'overview',
    items: [], byKey: new Map(), summary: null, cls: null, groups: [], series: [], lookalikes: null,
    marks: new Map(), // key -> { m: 'reject' | 'keep', why }
    scanning: false, scannedAt: null, genInfo: null, libInfo: null, abort: null,
    dryRun: S.lsGet('gencull:dryRun', true), unlock: false,
    fp: { running: false, done: 0, total: 0, scope: 'series', threshold: 5, abort: null },
    hashes: new Map(), // key -> { d: dhash, s: sha256 }
    openSeries: null, refsLimit: 150, queueLimit: 300, lastClicked: null,
    del: null,
    log: [],
  };

  function log(msg) {
    st.log.push(`${new Date().toLocaleTimeString()}  ${msg}`);
    console.info('%c[GenCull]', 'color:#8ab4ff;font-weight:bold', msg);
    if (st.log.length > 300) st.log.shift();
    if (logEl) { logEl.textContent = st.log.slice(-60).join('\n'); logEl.scrollTop = logEl.scrollHeight; }
  }
  function status(msg) {
    if (statusEl) statusEl.textContent = msg || '';
    if (toastEl && msg) { toastEl.textContent = `GenCull: ${msg}`; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), busy() ? 60000 : 6000); }
    updateLauncher();
  }
  const busy = () => st.scanning || st.fp.running || st.del?.phase === 'running' || st.auto;
  function updateLauncher() { if (launcherEl) launcherEl.textContent = busy() ? '⏳ GenCull working' : 'GenCull'; }
  let toastEl = null, toastTimer = null, launcherEl = null;

  // Marks survive reloads, so a long culling session can be resumed.
  let saveTimer = null;
  function saveMarks() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => S.set('kv', 'marks', [...st.marks.entries()]), 400);
  }
  async function loadMarks() {
    const saved = await S.get('kv', 'marks');
    if (Array.isArray(saved)) st.marks = new Map(saved);
    const backed = await S.get('kv', 'backedUp');
    if (Array.isArray(backed)) st.backedUp = new Set(backed);
  }

  // ------------------------------------------------------------- backup ----

  st.backedUp = new Set();
  const safeName = (t, max = 80) => String(t || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, max) || 'untitled';
  const extOf = it => (it.mime && it.mime.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '')) || (it.name.match(/\.([a-z0-9]{2,5})$/i)?.[1]) || 'png';
  /** Uploads not saved to your computer yet: Autopilot will not delete these. */
  const refsNeedingBackup = () => (st.cls?.trustAbsence ? C.planAllReferences(st.items) : []).filter(k => !st.backedUp.has(k));

  function backupPath(it, titles) {
    const folder = it.conversationId ? safeName(`${titles.get(it.conversationId) || 'Chat'} (${it.conversationId.slice(0, 8)})`)
      : it.kind === 'generation' ? 'Not linked to a chat' : 'Uploads and pastes';
    const date = it.created ? new Date(it.created).toISOString().slice(0, 10) : 'undated';
    const base = safeName((it.name || it.title || 'image').replace(/\.[a-z0-9]{2,5}$/i, ''), 60);
    // A short hash of the file's id keeps names unique, so a skip on re-run really means "this file is saved".
    let hsh = 0x811c9dc5;
    for (const ch of String(it.key)) hsh = Math.imul(hsh ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return [folder, `${date} ${base} ${hsh.toString(16).padStart(8, '0')}.${extOf(it)}`];
  }

  /**
   * Save images into a folder you pick, one subfolder per chat. Files that
   * are already there are skipped, so an interrupted backup can be resumed.
   */
  async function backupLibrary() {
    if (!window.showDirectoryPicker) { status('Saving to a folder needs Chrome or Edge.'); log('Backup needs the File System Access API (Chrome or Edge).'); return false; }
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'gencull-backup' }); } catch { status('Backup cancelled.'); return false; }
    const titles = new Map(st.series.map(x => [x.id, x.title]));
    const targets = st.items.filter(it => it.image && (st.backupHistory || it.fromLibrary));
    st.bk = { running: true, done: 0, saved: 0, skipped: 0, failed: 0, total: targets.length, abort: new AbortController() };
    render();
    const rows = [['folder', 'file', 'kind', 'size', 'created', 'chat', 'prompt']];
    const dirs = new Map();
    const sub = async name => { if (!dirs.has(name)) dirs.set(name, dir.getDirectoryHandle(name, { create: true })); return dirs.get(name); };
    try {
      await pool(targets, 3, async it => {
        const [folder, file] = backupPath(it, titles);
        try {
          const d = await sub(folder);
          let exists = false;
          try { const fh = await d.getFileHandle(file); exists = (await fh.getFile()).size > 0; } catch { /* not there yet */ }
          if (exists) st.bk.skipped++;
          else {
            const blob = await N.imageBlob(it, { full: true, signal: st.bk.abort.signal });
            if (!blob) { st.bk.failed++; return; }
            const w = await (await d.getFileHandle(file, { create: true })).createWritable();
            await w.write(blob); await w.close();
            st.bk.saved++;
          }
          st.backedUp.add(it.key);
          rows.push([folder, file, it.kind, it.size || '', it.created ? new Date(it.created).toISOString() : '', it.conversationId ? `${location.origin}/c/${it.conversationId}` : '', (it.prompt || '').replace(/\s+/g, ' ')]);
        } catch (e) { if (e.name === 'AbortError') throw e; st.bk.failed++; }
        finally {
          st.bk.done++;
          if (st.bk.done % 10 === 0 || st.bk.done === st.bk.total) { status(`Backup: ${num(st.bk.done)} / ${num(st.bk.total)} (${num(st.bk.saved)} saved, ${num(st.bk.skipped)} already there, ${num(st.bk.failed)} failed)`); S.set('kv', 'backedUp', [...st.backedUp]); }
        }
      }, st.bk.abort.signal);
      const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      const w = await (await dir.getFileHandle('index.csv', { create: true })).createWritable();
      await w.write(csv); await w.close();
    } finally {
      S.set('kv', 'backedUp', [...st.backedUp]);
      const b = st.bk; b.running = false;
      log(`Backup finished: ${num(b.saved)} saved, ${num(b.skipped)} already there, ${num(b.failed)} failed, of ${num(b.total)}.`);
      status(`Backup done: ${num(b.saved + b.skipped)} of ${num(b.total)} images are in your folder${b.failed ? `, ${num(b.failed)} failed (run again to retry)` : ''}.`);
      render();
    }
    return true;
  }

  const markOf = key => st.marks.get(key)?.m;
  function setMark(keys, m, why) {
    for (const k of keys) {
      if (m == null) st.marks.delete(k);
      else if (m === 'reject' && markOf(k) === 'keep' && why !== 'rejected by you') continue; // bulk actions never override a star
      else st.marks.set(k, { m, why: why || st.marks.get(k)?.why || '' });
    }
    saveMarks();
  }
  const queued = () => st.items.filter(it => markOf(it.key) === 'reject');

  function derive() {
    for (const it of st.items) { const hsh = st.hashes.get(it.key); if (hsh?.s) it.sha256 = hsh.s; }
    st.byKey = new Map(st.items.map(it => [it.key, it]));
    st.summary = C.summarize(st.items);
    st.groups = C.copyGroups(st.items.filter(it => it.fromLibrary));
    st.series = C.buildSeries(st.items);
  }

  // ---------------------------------------------------------------- scan ----

  async function scan() {
    if (st.scanning) return;
    st.scanning = true; st.abort = new AbortController();
    const signal = st.abort.signal;
    render();
    try {
      status('Checking your ChatGPT session…');
      const auth = await N.authHeaders(true);
      if (!auth.authorization) log('No session token found. Are you logged in to ChatGPT in this tab?');

      status('Reading your generated-images history…');
      let gen = { items: [], complete: false, error: null };
      try {
        const r = await N.listGenerated({ signal, onPage: p => status(`Generated-images history: ${num(p.total)} (page ${p.pages})`) });
        gen = { ...r, error: null };
        log(`Generated-images history: ${num(r.items.length)} images${r.complete ? '' : ' (INCOMPLETE)'}.`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        gen.error = String(e.message || e);
        log(`Could not read the generated-images history (${gen.error}). Uploads and generations cannot be told apart reliably without it.`);
      }

      status('Reading your Library / storage…');
      const lib = await N.listLibrary({ signal, onPage: p => status(`Storage listing: ${num(p.total)} files (page ${p.pages})`), onNote: log });
      if (lib.needsTeaching) {
        log('Could not find the storage listing automatically. See the Setup tab: open Settings → Storage → Images once while GenCull is running.');
        st.tab = 'setup';
      } else {
        for (const s of lib.sources) log(s.error ? `Storage source ${s.method} ${s.url} failed: ${s.error}` : `Storage source ${s.method} ${s.url}: ${num(s.count)} files in ${s.pages} pages${s.complete ? '' : ' (INCOMPLETE)'}.`);
      }

      const merged = C.mergeInventory(lib.items, gen.items);
      const cls = C.classify(merged.items, { genComplete: gen.complete && !gen.error, genCount: merged.genCount, linked: merged.linked });
      st.items = merged.items;
      st.cls = cls;
      st.genInfo = { count: gen.items.length, complete: gen.complete, error: gen.error, linked: merged.linked };
      st.libInfo = { count: lib.items.length, sources: lib.sources, complete: lib.complete, needsTeaching: lib.needsTeaching };
      st.hashes = await S.getMany('hashes', st.items.map(it => it.key));
      derive();
      st.lookalikes = null;
      st.scannedAt = Date.now();
      // Forget marks for files that are gone.
      for (const k of [...st.marks.keys()]) if (!st.byKey.has(k)) st.marks.delete(k);
      saveMarks();
      if (!cls.trustAbsence && st.summary.upload.n) log(`Upload/generation split is uncertain (history ${gen.complete ? 'complete' : 'incomplete'}, ${Math.round(cls.linkRate * 100)}% of generations matched to storage). Bulk "remove all references" is locked until you check the thumbnails.`);
      status(`Scanned ${num(st.items.length)} items.`);
    } catch (e) {
      status(e.name === 'AbortError' ? 'Scan stopped.' : `Scan failed: ${e.message || e}`);
      if (e.name !== 'AbortError') log(`Scan failed: ${e.stack || e}`);
    } finally {
      st.scanning = false; st.abort = null;
      render();
    }
  }

  // ---------------------------------------------------------- thumbnails ----

  const thumbCache = new Map(); // key -> canvas, LRU
  const thumbQueue = [];
  let thumbActive = 0;
  let io = null;

  function thumb(item, size = 150) {
    const ck = `${item.key}|${size}`;
    let cv = thumbCache.get(ck);
    if (cv) { thumbCache.delete(ck); thumbCache.set(ck, cv); } else {
      cv = h('canvas', { class: 'thumb', width: size, height: size, title: item.name || item.title || item.key });
      cv.__item = item; cv.__state = 'idle';
      thumbCache.set(ck, cv);
      while (thumbCache.size > 700) { const [k, old] = thumbCache.entries().next().value; thumbCache.delete(k); if (old.isConnected) { thumbCache.set(k, old); break; } }
    }
    if (cv.__state === 'idle' && io) io.observe(cv);
    return cv;
  }

  function onVisible(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      if (e.target.__state !== 'idle') continue;
      e.target.__state = 'queued';
      thumbQueue.push(e.target);
    }
    pumpThumbs();
  }

  function pumpThumbs() {
    while (thumbActive < 6 && thumbQueue.length) {
      const cv = thumbQueue.pop(); // newest first: what you are looking at now
      if (!cv.isConnected) { cv.__state = 'idle'; continue; }
      thumbActive++;
      drawThumb(cv).finally(() => { thumbActive--; pumpThumbs(); });
    }
  }

  function paintMessage(cv, text) {
    const g = cv.getContext('2d');
    g.fillStyle = '#26272b'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#8b8d98'; g.font = '11px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(text, cv.width / 2, cv.height / 2);
  }

  async function decode(blob, w, hgt) {
    const opts = { resizeQuality: 'medium' };
    if (!w && !hgt) return createImageBitmap(blob);
    if (w) opts.resizeWidth = w;
    if (hgt) opts.resizeHeight = hgt;
    return createImageBitmap(blob, opts);
  }

  async function hashBitmap(blob) {
    const bmp = await decode(blob, 32, 32);
    const c = h('canvas', { width: 32, height: 32 });
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, 32, 32);
    g.drawImage(bmp, 0, 0, 32, 32);
    bmp.close?.();
    const data = g.getImageData(0, 0, 32, 32).data;
    return C.dhash(C.toGray(data, 32, 32), 32, 32);
  }

  async function rememberHash(item, blob, withSha = false) {
    const prev = st.hashes.get(item.key) || {};
    const next = { ...prev };
    if (!next.d) { try { next.d = await hashBitmap(blob); } catch { /* not decodable */ } }
    if (withSha && !next.s) {
      const buf = await blob.arrayBuffer();
      const dig = await crypto.subtle.digest('SHA-256', buf);
      next.s = [...new Uint8Array(dig)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    if (next.d !== prev.d || next.s !== prev.s) { st.hashes.set(item.key, next); S.set('hashes', item.key, next); }
    return next;
  }

  // Per-image actions: open its chat, download the original.
  function tileActions(it) {
    const stop = fn => e => { e.stopPropagation(); fn(); };
    const m = markOf(it.key);
    return h('div', { class: 'tacts' },
      h('button', { type: 'button', class: `tact ${m === 'reject' ? 'on' : ''}`, title: m === 'reject' ? 'Unqueue' : 'Queue for deletion', 'data-testid': 'gc-reject', onclick: stop(() => { setMark([it.key], m === 'reject' ? null : 'reject', 'rejected by you'); render(); }) }, '✕'),
      it.conversationId ? h('a', { class: 'tact', href: `/c/${it.conversationId}${it.messageId ? `#${it.messageId}` : ''}`, target: '_blank', rel: 'noopener', title: 'Open the chat this image is from', onclick: e => e.stopPropagation() }, '↗') : null,
      h('button', { type: 'button', class: 'tact', title: 'Download full-size image', 'data-testid': 'gc-download', onclick: stop(() => downloadImage(it)) }, '⬇'));
  }

  async function downloadImage(it) {
    status(`Downloading ${it.name || 'image'}…`);
    const blob = await N.imageBlob(it, { full: true });
    if (!blob) { status('Download failed: ChatGPT did not return the image.'); return; }
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const base = (it.name || it.title || it.fileId || 'image').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[a-z0-9]{2,5}$/i, '');
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `${base}.${ext}` });
    root.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    status(`Downloaded ${base}.${ext}`);
  }

  // ------------------------------------------------- full-size viewer ----

  const fullCache = new Map(); // key -> Promise<Blob|null>, last few only
  function fullBlob(it) {
    if (!fullCache.has(it.key)) {
      fullCache.set(it.key, N.imageBlob(it, { full: true }).catch(() => null));
      while (fullCache.size > 8) fullCache.delete(fullCache.keys().next().value);
    }
    return fullCache.get(it.key);
  }

  let viewerEl = null;
  function openViewer(list, idx) {
    st.viewer = { list, idx };
    if (!viewerEl) {
      viewerEl = h('div', { class: 'viewer', 'data-testid': 'gc-viewer' });
      root.append(viewerEl);
      document.addEventListener('keydown', viewerKeys, true);
    }
    drawViewer();
  }
  function closeViewer() {
    st.viewer = null;
    document.removeEventListener('keydown', viewerKeys, true);
    viewerEl?.remove(); viewerEl = null;
    render();
  }
  function viewerKeys(e) {
    const v = st.viewer;
    if (!v || e.metaKey || e.ctrlKey || e.altKey) return;
    const it = v.list[v.idx];
    const act = {
      Escape: closeViewer,
      ArrowRight: () => { v.idx = Math.min(v.list.length - 1, v.idx + 1); drawViewer(); },
      ArrowLeft: () => { v.idx = Math.max(0, v.idx - 1); drawViewer(); },
      x: () => { setMark([it.key], markOf(it.key) === 'reject' ? null : 'reject', 'rejected by you'); drawViewer(); },
      s: () => { setMark([it.key], markOf(it.key) === 'keep' ? null : 'keep', 'kept by you'); drawViewer(); },
      d: () => downloadImage(it),
      o: () => { if (it.conversationId) window.open(`/c/${it.conversationId}${it.messageId ? `#${it.messageId}` : ''}`, '_blank', 'noopener'); },
    }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!act) return;
    e.preventDefault(); e.stopPropagation(); // keep ChatGPT from typing these keys
    act();
  }

  async function drawViewer() {
    const v = st.viewer;
    if (!v || !viewerEl) return;
    const it = v.list[v.idx];
    const m = markOf(it.key);
    const cv = h('canvas', { class: 'vcanvas' });
    const info = [it.name || it.title || '', it.size ? fmt(it.size) : '', it.created ? new Date(it.created).toLocaleString() : '', it.kind].filter(Boolean).join(' · ');
    viewerEl.replaceChildren(
      h('div', { class: 'vbar' },
        h('b', {}, `${v.idx + 1} / ${v.list.length}`),
        h('span', { class: `vstate ${m || ''}` }, m === 'reject' ? '✕ queued for deletion' : m === 'keep' ? '★ kept' : ''),
        h('span', { class: 'muted vinfo' }, info),
        h('span', { class: 'vbtns' },
          btn('← Prev', () => { v.idx = Math.max(0, v.idx - 1); drawViewer(); }, { disabled: v.idx === 0 }),
          btn('Next →', () => { v.idx = Math.min(v.list.length - 1, v.idx + 1); drawViewer(); }, { disabled: v.idx === v.list.length - 1 }),
          btn(m === 'reject' ? 'Unqueue (X)' : 'Delete (X)', () => { setMark([it.key], m === 'reject' ? null : 'reject', 'rejected by you'); drawViewer(); }, { class: m === 'reject' ? '' : 'danger', 'data-testid': 'gc-viewer-reject' }),
          btn(m === 'keep' ? 'Unstar (S)' : '★ Keep (S)', () => { setMark([it.key], m === 'keep' ? null : 'keep', 'kept by you'); drawViewer(); }),
          btn('⬇ (D)', () => downloadImage(it)),
          it.conversationId ? h('a', { class: 'link', href: `/c/${it.conversationId}${it.messageId ? `#${it.messageId}` : ''}`, target: '_blank', rel: 'noopener' }, 'Chat ↗ (O)') : null,
          btn('Close (Esc)', closeViewer))),
      it.prompt ? h('div', { class: 'vprompt' }, it.prompt) : null,
      h('div', { class: 'vstage' }, cv));
    const blob = await fullBlob(it);
    // Prefetch neighbours so arrowing through a series feels instant.
    if (v.list[v.idx + 1]) fullBlob(v.list[v.idx + 1]);
    if (st.viewer !== v || v.list[v.idx] !== it) return;
    if (!blob) { cv.width = 400; cv.height = 200; paintMessage(cv, 'could not load the full image'); return; }
    try {
      // Canvas, not <img>: ChatGPT's security policy may block blob: images.
      const bmp = await createImageBitmap(blob);
      cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close?.();
      cv.title = `${bmp.width}×${bmp.height}`;
    } catch { cv.width = 400; cv.height = 200; paintMessage(cv, 'cannot display this file type'); }
  }

  async function saveThumb(item, blob) {
    const bmp = await decode(blob, 240);
    const c = h('canvas', { width: bmp.width, height: bmp.height });
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    const small = await new Promise(res => c.toBlob(res, 'image/webp', 0.75));
    if (small) await S.set('thumbs', item.key, small);
  }

  async function drawThumb(cv) {
    const item = cv.__item;
    cv.__state = 'loading';
    paintMessage(cv, 'loading…');
    try {
      // Saved previews (about 10 KB each) make every later visit instant.
      const cached = await S.get('thumbs', item.key);
      const blob = cached || await N.imageBlob(item);
      if (!blob) { cv.__state = 'failed'; paintMessage(cv, 'no preview'); return; }
      const bmp = await decode(blob, cached ? 0 : Math.min(cv.width * 2, 400));
      const g = cv.getContext('2d');
      g.fillStyle = '#1b1c1f'; g.fillRect(0, 0, cv.width, cv.height);
      const r = Math.min(cv.width / bmp.width, cv.height / bmp.height);
      const w = bmp.width * r, hh = bmp.height * r;
      g.drawImage(bmp, (cv.width - w) / 2, (cv.height - hh) / 2, w, hh);
      bmp.close?.();
      cv.__state = 'done';
      if (!cached) saveThumb(item, blob).catch(() => {});
      if (!st.hashes.get(item.key)?.d) rememberHash(item, blob).catch(() => {});
    } catch {
      cv.__state = 'failed'; paintMessage(cv, 'no preview');
    }
  }

  // ----------------------------------------------------- bulk selections ----

  function selectExtraCopies() {
    const keys = C.planExtraCopies(st.groups);
    setMark(keys, 'reject', 'extra copy');
    log(`Queued ${num(keys.length)} extra copies (one copy of each file is kept).`);
    render();
  }
  function selectAllReferences() {
    const keys = C.planAllReferences(st.items, { allowUncertain: st.unlock });
    setMark(keys, 'reject', 'reference upload');
    log(`Queued ${num(keys.length)} uploaded references.`);
    render();
  }

  // Content check for groups where name+size alone is not proof.
  async function checkDoubtfulGroups() {
    const targets = st.groups.filter(g => !g.confident).flatMap(g => g.items).filter(it => !st.hashes.get(it.key)?.s);
    if (!targets.length) return;
    st.fp.running = true; st.fp.abort = new AbortController(); st.fp.done = 0; st.fp.total = targets.length;
    render();
    try {
      await pool(targets, 3, async it => {
        const blob = await N.imageBlob(it, { signal: st.fp.abort.signal, full: true });
        if (blob) await rememberHash(it, blob, true);
        st.fp.done++; status(`Checking contents: ${st.fp.done}/${st.fp.total}`);
      }, st.fp.abort.signal);
    } finally {
      st.fp.running = false; derive(); render();
    }
  }

  async function pool(list, n, fn, signal) {
    let i = 0;
    const worker = async () => { while (i < list.length && !signal?.aborted) { const it = list[i++]; try { await fn(it); } catch (e) { if (e.name === 'AbortError') return; } } };
    await Promise.all(Array.from({ length: n }, worker));
  }

  function fingerprintTargets() {
    return st.items.filter(it => it.image && !st.hashes.get(it.key)?.d);
  }

  async function fingerprint() {
    const targets = fingerprintTargets();
    st.fp.running = true; st.fp.abort = new AbortController(); st.fp.done = 0; st.fp.total = targets.length;
    render();
    try {
      await pool(targets, 4, async it => {
        try {
          const blob = await N.imageBlob(it, { signal: st.fp.abort.signal });
          if (blob) await rememberHash(it, blob);
        } finally {
          st.fp.done++;
          if (st.fp.done % 5 === 0 || st.fp.done === st.fp.total) { status(`Fingerprinting: ${num(st.fp.done)}/${num(st.fp.total)}`); updateProgress(); }
        }
      }, st.fp.abort.signal);
    } finally {
      st.fp.running = false;
      computeLookalikes();
      render();
    }
  }

  function computeLookalikes() {
    const entries = st.items
      .filter(it => it.image && st.hashes.get(it.key)?.d)
      .map(it => ({ key: it.key, hash: st.hashes.get(it.key).d, scope: st.fp.scope === 'series' ? (it.kind === 'generation' ? it.conversationId : '') : '' }));
    st.lookalikes = C.lookalikeGroups(entries, st.fp.threshold).map(g => g.map(k => st.byKey.get(k)).filter(Boolean));
  }

  /** Keep the newest generation of a group, else its oldest file (the original). */
  function keeperOf(group) {
    const byNew = [...group].sort((a, b) => (b.created || 0) - (a.created || 0));
    return byNew.find(i => i.kind === 'generation') || byNew[byNew.length - 1];
  }

  // -------------------------------------------------------------- delete ----

  function manifest(items, extra = {}) {
    return JSON.stringify({
      tool: `GenCull ${VERSION}`, createdAt: new Date().toISOString(), origin: location.origin, ...extra,
      items: items.map(it => ({
        name: it.name || it.title || '', size: it.size, kind: it.kind, confidence: it.confidence, reason: st.marks.get(it.key)?.why || '',
        created: it.created ? new Date(it.created).toISOString() : null, libraryFileId: it.libraryFileId, fileId: it.fileId,
        conversation: it.conversationId ? `${location.origin}/c/${it.conversationId}` : null,
      })),
    }, null, 2);
  }

  function startDelete() {
    const all = queued();
    if (!all.length) return;
    const { plan, impossible } = N.planDeletes(all);
    // Deletable items first, so the one-file test run uses a file that can be deleted.
    const items = [...[...plan.values()].flat(), ...impossible];
    st.del = { phase: 'confirm', items, plan: [...plan].map(([t, l]) => ({ label: t.label, n: l.length, learned: !!t.learnedAt })), impossible: impossible.length, results: [], typed: '' };
    st.tab = 'queue';
    render();
  }

  async function runDelete(items) {
    const d = st.del;
    d.abort = new AbortController();
    const res = await N.deleteItems(items, {
      dryRun: st.dryRun, signal: d.abort.signal,
      onResult: r => { d.results.push(r); updateProgress(); },
    });
    const ok = res.filter(r => r.ok && !r.dry);
    if (ok.length) {
      const gone = new Set(ok.map(r => r.item.key));
      st.items = st.items.filter(it => !gone.has(it.key));
      for (const k of gone) st.marks.delete(k);
      saveMarks();
      derive();
      if (st.lookalikes) st.lookalikes = st.lookalikes.map(g => g.filter(it => !gone.has(it.key))).filter(g => g.length > 1);
    }
    return res;
  }

  async function deleteCanary() {
    const d = st.del;
    if (!st.dryRun && d.typed.trim().toLowerCase() !== 'delete') return;
    d.phase = 'running'; render();
    if (st.dryRun) {
      await runDelete(d.items);
      d.phase = 'done';
      log(`Dry run: ${num(d.results.length)} files would be deleted. Nothing was sent.`);
      render();
      return;
    }
    download(`gencull-deleted-${stamp()}.json`, manifest(d.items, { note: 'Files GenCull was asked to delete in this run.' }));
    const [r] = await runDelete([d.items[0]]);
    d.canary = r;
    d.phase = r?.ok && d.items.length > 1 ? 'canary-ok' : 'done';
    log(r?.ok ? `Test delete OK: ${r.item.name || r.item.key} (${r.template}).` : `Test delete FAILED: ${r?.detail}`);
    render();
  }

  async function deleteRest() {
    const d = st.del;
    d.phase = 'running'; render();
    await runDelete(d.items.slice(1));
    d.phase = 'done';
    const ok = d.results.filter(r => r.ok).length;
    log(`Deleted ${num(ok)} of ${num(d.items.length)} files. ${num(d.results.length - ok)} failed or skipped.`);
    render();
  }

  // ----------------------------------------------------------- autopilot ----

  /**
   * One click: scan, queue the safe deletions (extra copies, and uploaded
   * reference images when the split is certain), delete one test file,
   * re-read the storage listing to prove it is really gone, then delete the
   * rest and rescan. Generations are never touched; culling needs your eye.
   */
  async function autopilot() {
    if (st.scanning || st.del?.phase === 'running' || st.auto) return;
    st.open = true;
    st.auto = true;
    try { await runAutopilot(); } finally { st.auto = false; updateLauncher(); render(); }
  }

  async function runAutopilot() {
    status('Autopilot started…');
    await scan();
    if (!st.scannedAt || st.libInfo?.needsTeaching) { log('Autopilot stopped: storage listing not found. See Setup.'); return; }
    // Pasted screenshots are all called image.png, so their copies need a byte check first.
    if (st.groups.some(g => !g.confident)) { status('Autopilot: checking contents of same-name, same-size files…'); await checkDoubtfulGroups(); }
    const extras = new Set(C.planExtraCopies(st.groups));
    // Uploads are only deleted once they are saved on your computer.
    const notBacked = refsNeedingBackup();
    const refs = (st.cls?.trustAbsence ? C.planAllReferences(st.items) : []).filter(k => st.backedUp.has(k));
    const keys = [...new Set([...extras, ...refs])].filter(k => markOf(k) !== 'keep');
    if (!keys.length) { log('Autopilot: nothing safe to delete automatically.'); status('Autopilot: nothing safe to delete.'); return; }
    const bytes = keys.reduce((t, k) => t + (st.byKey.get(k)?.size || 0), 0);
    const msg = `GenCull autopilot\n\n${st.dryRun ? 'DRY RUN (nothing is sent): ' : ''}delete ${num(keys.length)} files, ${fmt(bytes)}:\n` +
      `• ${num(extras.size)} extra copies (one copy of each file is kept)\n` +
      `• ${st.cls?.trustAbsence ? `${num(refs.length)} uploaded or pasted images that are backed up in your folder` : 'uploads skipped: upload/generation split is uncertain'}\n` +
      (notBacked.length ? `• ${num(notBacked.length)} uploads are NOT backed up yet and are left alone\n` : '') + '\n' +
      'Generations are not touched. A list of the files downloads first, and one test file is deleted and verified before the rest.\n\nContinue?';
    if (!window.confirm(msg)) { log('Autopilot cancelled.'); return; }
    setMark([...extras], 'reject', 'extra copy');
    setMark(refs.filter(k => !extras.has(k)), 'reject', 'reference upload');
    startDelete();
    const d = st.del;
    d.typed = 'delete';
    await deleteCanary();
    if (st.dryRun || d.phase !== 'canary-ok') return;
    status('Autopilot: checking the test file is really gone…');
    let stillListed = true;
    try {
      const again = await N.listLibrary({ onPage: p => status(`Autopilot: verifying (${num(p.total)} files read)`) });
      stillListed = again.items.some(it => it.key === d.canary.item.key);
    } catch (e) { log(`Autopilot: verification failed (${e.message || e}).`); }
    if (stillListed) {
      log('Autopilot paused: ChatGPT accepted the test delete but still lists the file. Check Settings → Storage, then press Continue in the Queue tab if it is gone there.');
      status('Autopilot paused: test file still listed.');
      render();
      return;
    }
    log('Autopilot: test file verified gone. Deleting the rest.');
    await deleteRest();
    const freed = d.results.filter(r => r.ok).reduce((t, r) => t + (r.item.size || 0), 0);
    await scan();
    log(`Autopilot done: freed ${fmt(freed)}.`);
    status(`Autopilot done: freed ${fmt(freed)}. Next: cull generations in Series (manual).`);
  }

  // -------------------------------------------------------------- render ----

  let host, root, drawer, bodyEl, statusEl, logEl, progressEl;

  function mount() {
    if (host) return;
    host = h('div', { id: 'gencull-host' });
    root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(h('style', { text: CSS }));
    }
    const launcher = launcherEl = h('button', { class: 'launcher', type: 'button', 'data-testid': 'gc-launcher', title: 'GenCull: clean up ChatGPT storage', onclick: () => { st.open = !st.open; render(); } }, 'GenCull');
    toastEl = h('div', { class: 'toast', 'data-testid': 'gc-toast', onclick: () => { st.open = true; render(); } });
    drawer = h('div', { class: 'drawer', 'data-testid': 'gc-drawer' });
    root.append(launcher, drawer, toastEl);
    (document.body || document.documentElement).append(host);
    // ChatGPT is a React app and may re-render <body>; put the panel back if it disappears.
    setInterval(() => { if (!host.isConnected) (document.body || document.documentElement).append(host); }, 2000);
    N.onLearn(what => {
      log(what === 'delete' ? 'Learned how your ChatGPT deletes a file.' : what === 'list' ? 'Learned a storage listing request.' : 'Forgot learned requests.');
      if (st.open && st.tab === 'setup') render();
    });
    loadMarks().then(render);
  }

  function render() {
    if (!drawer) return;
    drawer.classList.toggle('open', st.open);
    updateLauncher();
    if (!st.open) return;
    const scrollTop = bodyEl?.scrollTop || 0;
    const tabBefore = drawer.__tab;
    io?.disconnect();
    for (const cv of thumbQueue) cv.__state = 'idle';
    thumbQueue.length = 0;
    const q = queued();
    const qBytes = q.reduce((s, it) => s + (it.size || 0), 0);

    statusEl = h('div', { class: 'status', 'data-testid': 'gc-status' }, statusEl?.textContent || '');
    const header = h('div', { class: 'header' },
      h('div', { class: 'brand' }, h('b', {}, 'GenCull'), h('span', { class: 'muted' }, ' ChatGPT storage cleaner')),
      h('div', { class: 'actions' },
        st.scanning ? btn('Stop scan', () => st.abort?.abort(), { class: 'ghost' })
          : btn(st.scannedAt ? 'Rescan' : 'Scan my storage', scan, { class: 'primary', 'data-testid': 'gc-scan' }),
        h('label', { class: 'toggle', title: 'In dry-run mode nothing is ever deleted; you see what would be sent.' },
          h('input', { type: 'checkbox', checked: st.dryRun, 'data-testid': 'gc-dryrun', onchange: e => { st.dryRun = e.target.checked; S.lsSet('gencull:dryRun', st.dryRun); render(); } }),
          ' Dry run'),
        btn('✕', () => { st.open = false; render(); }, { class: 'ghost icon', title: 'Close' })),
    );
    const tabs = [['overview', 'Overview'], ['references', 'References'], ['series', 'Series'], ['lookalikes', 'Look-alikes'], ['queue', `Queue (${num(q.length)})`], ['setup', 'Setup']];
    const tabBar = h('div', { class: 'tabs' }, tabs.map(([id, label]) =>
      btn(label, () => { st.tab = id; render(); }, { class: st.tab === id ? 'tab on' : 'tab', 'data-testid': `gc-tab-${id}` })));

    bodyEl = h('div', { class: 'body' });
    io = new IntersectionObserver(onVisible, { root: bodyEl, rootMargin: '400px' });
    const view = { overview: viewOverview, references: viewReferences, series: viewSeries, lookalikes: viewLookalikes, queue: viewQueue, setup: viewSetup }[st.tab];
    bodyEl.append(view());

    const footer = h('div', { class: 'footer' },
      h('span', { 'data-testid': 'gc-queue-summary' }, `Queued for deletion: ${num(q.length)} files · ${fmt(qBytes)}`),
      q.length ? btn(st.dryRun ? 'Simulate delete…' : 'Delete…', startDelete, { class: st.dryRun ? '' : 'danger', 'data-testid': 'gc-delete-open' }) : null);
    logEl = h('pre', { class: 'log', 'data-testid': 'gc-log' }, st.log.slice(-60).join('\n'));

    drawer.replaceChildren(header, statusEl, tabBar, bodyEl, footer, h('details', { class: 'logwrap' }, h('summary', {}, 'Log'), logEl));
    drawer.__tab = st.tab;
    if (tabBefore === st.tab) bodyEl.scrollTop = scrollTop;
  }

  function updateProgress() {
    if (!progressEl) return;
    if (st.del?.phase === 'running') progressEl.textContent = `${num(st.del.results.length)} / ${num(st.del.items.length)} processed`;
    else if (st.fp.running) progressEl.textContent = `${num(st.fp.done)} / ${num(st.fp.total)}`;
  }

  const tile = (label, n, bytes, note, testid) => h('div', { class: 'tile', 'data-testid': testid },
    h('div', { class: 'tlabel' }, label), h('div', { class: 'tnum' }, num(n)), h('div', { class: 'tbytes' }, bytes == null ? '' : fmt(bytes)), note ? h('div', { class: note === 'confident' ? 'tnote good' : 'tnote' }, note) : null);

  function viewOverview() {
    if (!st.scannedAt) {
      return h('div', { class: 'intro' },
        h('p', {}, 'GenCull reads your ChatGPT storage (the same list you see in Settings → Storage), tells apart the reference images you uploaded from the images ChatGPT generated, finds repeat copies, and helps you cull failed generations.'),
        h('p', {}, 'It runs only in this tab, talks only to chatgpt.com, and deletes nothing without your confirmation. Dry run is on by default.'),
        st.scanning ? h('p', { class: 'muted' }, 'Scanning…') : btn('Scan my storage', scan, { class: 'big', 'data-testid': 'gc-scan-intro' }),
        st.scanning ? null : h('div', { class: 'bar' }, btn('Autopilot: remove copies & references', autopilot, { class: 'primary big', disabled: st.scanning || st.del?.phase === 'running', 'data-testid': 'gc-autopilot' }),
          h('span', { class: 'muted small' }, 'One click. Never touches generations.')));
    }
    const s = st.summary;
    const extras = C.planExtraCopies(st.groups);
    const extraBytes = extras.reduce((t, k) => t + (st.byKey.get(k)?.size || 0), 0);
    const certain = st.cls?.trustAbsence;
    const refKeys = C.planAllReferences(st.items, { allowUncertain: st.unlock });
    const refBytes = refKeys.reduce((t, k) => t + (st.byKey.get(k)?.size || 0), 0);
    const backedRefs = (certain ? C.planAllReferences(st.items) : []).filter(k => st.backedUp.has(k));
    const autoKeys = [...new Set([...extras, ...backedRefs])];
    const autoBytes = autoKeys.reduce((t, k) => t + (st.byKey.get(k)?.size || 0), 0);
    const autoRefs = backedRefs.length;
    const needBackup = refsNeedingBackup();
    const needBackupBytes = needBackup.reduce((t, k) => t + (st.byKey.get(k)?.size || 0), 0);
    const bk = st.bk;
    const doubtful = st.groups.filter(g => !g.confident).length;
    const maybeRefs = st.items.filter(it => it.image && it.fromLibrary && (it.kind === 'upload' || it.kind === 'unknown'));
    const busy = st.scanning || st.del?.phase === 'running' || st.auto || st.bk?.running;
    return h('div', {},
      h('div', { class: 'hero' },
        h('div', { class: 'herobig', 'data-testid': 'gc-hero' }, autoKeys.length ? `Autopilot can free ${fmt(autoBytes)}` : needBackup.length ? `Back up first, then free ${fmt(needBackupBytes)}` : 'Nothing to delete automatically'),
        h('div', { class: 'muted' }, autoKeys.length
          ? `${plural(extras.length, 'extra copy', 'extra copies')}${autoRefs ? ` and ${plural(autoRefs, 'backed-up upload')}` : ''}. Your generations are never touched.`
          : 'Use Manual tools below to cull generations.'),
        needBackup.length ? h('div', { class: 'note' }, `${plural(needBackup.length, 'image')} you uploaded or pasted (${fmt(needBackupBytes)}) are not saved on your computer yet. Autopilot only deletes them after a backup.`) : null,
        h('div', { class: 'bar' },
          bk?.running ? btn(`Stop backup (${num(bk.done)} / ${num(bk.total)})`, () => bk.abort.abort())
            : btn('Back up library to a folder…', backupLibrary, { class: autoKeys.length ? '' : 'primary big', disabled: busy, 'data-testid': 'gc-backup', title: 'Saves every image into a folder you pick, one subfolder per chat, plus index.csv. Re-running skips what is already saved.' }),
          h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: !!st.backupHistory, onchange: e => { st.backupHistory = e.target.checked; render(); } }), ` include ${num(s.historyOnly)} older generations not in storage`)),
        !certain && maybeRefs.length ? h('div', { class: 'warn' }, `${plural(maybeRefs.length, 'image')} (${fmt(maybeRefs.reduce((t, it) => t + (it.size || 0), 0))}) may be your uploads, but GenCull could not confirm it (${st.genInfo?.error ? 'generated-images history unavailable' : 'too few generations matched'}). Autopilot leaves them alone.`) : null,
        autoKeys.length ? btn(st.dryRun ? 'Autopilot (dry run: show what it would delete)' : `Autopilot: delete ${num(autoKeys.length)} files`, autopilot, { class: st.dryRun ? 'primary big' : 'danger big', disabled: busy, 'data-testid': 'gc-autopilot' }) : null,
        autoKeys.length && st.dryRun ? h('div', { class: 'muted small' }, 'Dry run is on (top right). Untick it to delete for real.') : null),
      h('div', { class: 'tiles' },
        tile('In storage', s.total.n, s.total.bytes, null, 'gc-tile-total'),
        tile('Uploads & pastes', s.upload.n, s.upload.bytes, s.upload.n ? (certain ? 'confident' : 'unconfirmed') : null, 'gc-tile-upload'),
        tile('Generations', s.generation.n, s.generation.bytes, null, 'gc-tile-generation'),
        s.unknown.n ? tile('Unknown', s.unknown.n, s.unknown.bytes, null, 'gc-tile-unknown') : null,
        tile('Extra copies', extras.length, extraBytes, doubtful ? `+${plural(doubtful, 'group needs', 'groups need')} a content check` : null, 'gc-tile-extras')),
      s.historyOnly ? h('div', { class: 'muted small' }, `${plural(s.historyOnly, 'older generation')} are in your image history but not in the storage list, so they are not counted here.`) : null,
      btn(st.manual ? 'Hide manual tools' : 'Manual tools…', () => { st.manual = !st.manual; render(); }, { class: 'ghost', 'data-testid': 'gc-manual' }),
      st.manual ? h('ol', { class: 'steps' },
        h('li', {}, h('div', {}, h('b', {}, 'Repeat copies. '), `${plural(extras.length, 'extra copy', 'extra copies')}, ${fmt(extraBytes)}. One copy of each is kept.`),
          btn('Queue extra copies', selectExtraCopies, { disabled: !extras.length, 'data-testid': 'gc-queue-extras' })),
        h('li', {}, h('div', {}, h('b', {}, 'Uploads & pastes. '), `${plural(refKeys.length, 'image')}, ${fmt(refBytes)}.`, !certain && maybeRefs.length ? ' Locked: unlock in the References tab after checking thumbnails.' : ''),
          btn('Queue all references', selectAllReferences, { disabled: !refKeys.length, 'data-testid': 'gc-queue-refs' })),
        h('li', {}, h('div', {}, h('b', {}, 'Cull generations. '), `${plural(st.series.length, 'chat')}. Star keepers, reject the rest.`),
          btn('Open series', () => { st.tab = 'series'; render(); })),
        h('li', {}, h('div', {}, h('b', {}, 'Look-alikes. '), 'Near-identical images.'),
          btn('Open look-alikes', () => { st.tab = 'lookalikes'; render(); }))) : null,
      scanFacts());
  }

  function scanFacts() {
    const g = st.genInfo, l = st.libInfo;
    return h('div', { class: 'facts' },
      h('div', {}, `Generated-images history: ${g.error ? `unavailable (${g.error})` : `${num(g.count)} images, ${g.complete ? 'read to the end' : 'INCOMPLETE'}, ${num(g.linked)} matched to storage entries`}`),
      h('div', {}, `Storage listing: ${l.needsTeaching ? 'not found (see Setup)' : `${num(l.count)} entries, ${l.complete ? 'read to the end' : 'INCOMPLETE'}`}`),
      h('div', { class: 'muted' }, `Scanned ${new Date(st.scannedAt).toLocaleString()}.`));
  }

  function refGroupsForView() {
    const grouped = new Set();
    const rows = [];
    for (const g of st.groups) {
      if (!g.items.some(it => it.kind !== 'generation')) continue;
      g.items.forEach(it => grouped.add(it.key));
      rows.push({ ...g, bytes: g.items.reduce((t, it) => t + (it.size || 0), 0) });
    }
    for (const it of st.items) {
      if (grouped.has(it.key) || !it.fromLibrary || (it.kind !== 'upload' && it.kind !== 'unknown')) continue;
      rows.push({ sig: it.key, confident: true, basis: 'single', items: [it], name: it.name, size: it.size, bytes: it.size || 0, kinds: [it.kind] });
    }
    return rows.sort((a, b) => b.bytes - a.bytes);
  }

  function viewReferences() {
    if (!st.scannedAt) return h('p', { class: 'muted' }, 'Scan first.');
    const rows = refGroupsForView();
    const certain = st.cls?.trustAbsence;
    const doubtful = st.groups.filter(g => !g.confident);
    const wrap = h('div', {},
      h('div', { class: certain ? 'note' : 'warn' }, certain
        ? 'Uploads were identified by checking every file against your generated-images history.'
        : `Uploads could not be identified with certainty (${st.genInfo?.error ? 'history unavailable' : `${Math.round((st.cls?.linkRate || 0) * 100)}% of generations matched`}). Look through the thumbnails below before removing all of them.`),
      !certain ? h('label', { class: 'unlock' }, h('input', { type: 'checkbox', checked: st.unlock, 'data-testid': 'gc-unlock', onchange: e => { st.unlock = e.target.checked; render(); } }),
        ' I checked the thumbnails: these are my uploaded references.') : null,
      h('div', { class: 'bar' },
        btn('Queue extra copies (keep 1 each)', selectExtraCopies),
        btn('Queue all references', selectAllReferences, { disabled: !certain && !st.unlock }),
        btn('Unqueue all references', () => { setMark(st.items.filter(it => it.kind !== 'generation').map(it => it.key), null); render(); }),
        doubtful.length ? btn(st.fp.running ? 'Checking…' : `Check contents of ${doubtful.length} doubtful groups`, checkDoubtfulGroups, { disabled: st.fp.running, title: 'Downloads those files and compares their bytes (sha256).' }) : null),
      h('div', { class: 'muted small' }, `${plural(rows.length, 'distinct file')}. Biggest first.`));
    const list = h('div', { class: 'rows' });
    for (const g of rows.slice(0, st.refsLimit)) {
      const keys = g.items.map(it => it.key);
      const rejected = keys.filter(k => markOf(k) === 'reject').length;
      const state = rejected === 0 ? 'none' : rejected === keys.length ? 'all' : 'extras';
      const setState = to => {
        setMark(keys, null);
        if (to === 'all') setMark(keys, 'reject', 'reference upload');
        if (to === 'extras') setMark(C.planExtraCopies([g]), 'reject', 'extra copy');
        render();
      };
      const kinds = g.kinds.join(' + ');
      list.append(h('div', { class: 'row', 'data-testid': 'gc-ref-row' },
        thumb(g.items[0], 56),
        h('div', { class: 'rmain' },
          h('div', { class: 'rname' }, g.name || '(no name)'),
          h('div', { class: 'muted small' },
            `${g.items.length > 1 ? `×${g.items.length} copies · ` : ''}${fmt(g.bytes)} · ${kinds} · ${g.items[0].confidence} confidence`,
            g.confident ? '' : ` · ${g.basis}`)),
        h('div', { class: 'seg' },
          btn('Keep', () => setState('none'), { class: state === 'none' ? 'on' : '' }),
          g.items.length > 1 ? btn('Keep 1', () => setState('extras'), { class: state === 'extras' ? 'on' : '', disabled: !g.confident }) : null,
          btn('Remove', () => setState('all'), { class: state === 'all' ? 'on bad' : '' }))));
    }
    wrap.append(list);
    if (rows.length > st.refsLimit) wrap.append(btn(`Show more (${num(rows.length - st.refsLimit)} left)`, () => { st.refsLimit += 300; render(); }));
    return wrap;
  }

  function viewSeries() {
    if (!st.scannedAt) return h('p', { class: 'muted' }, 'Scan first.');
    const s = st.openSeries && st.series.find(x => x.id === st.openSeries);
    if (!s) {
      // Threads that take up storage, biggest first. History-only ones cannot be deleted from storage anyway.
      const all = st.series.filter(x => st.showHistoryOnly || x.stored);
      const deletable = x => x.items.filter(it => it.fromLibrary && markOf(it.key) !== 'keep');
      const list = h('div', { class: 'rows' });
      for (const x of all.slice(0, st.seriesLimit || 200)) {
        const del = deletable(x);
        const rej = x.items.filter(it => markOf(it.key) === 'reject').length;
        const whole = del.length > 0 && del.every(it => markOf(it.key) === 'reject');
        list.append(h('div', { class: `row click ${whole ? 'queued' : ''}`, 'data-testid': 'gc-series-row', onclick: () => { st.openSeries = x.id; render(); } },
          thumb(x.items[x.items.length - 1], 56),
          h('div', { class: 'rmain' },
            h('div', { class: 'rname' }, x.title || (x.id === '(no conversation)' ? 'Not linked to a chat' : `Chat ${x.id.slice(0, 8)}`)),
            h('div', { class: 'muted small' }, `${num(x.stored)} in storage · ${fmt(x.storedBytes)}${x.items.length > x.stored ? ` · ${num(x.items.length - x.stored)} older not in storage` : ''}${rej ? ` · ✕ ${num(rej)} queued` : ''}`)),
          whole ? btn('Undo', e => { e.stopPropagation(); setMark(del.map(it => it.key), null); render(); })
            : btn('Delete whole thread', e => { e.stopPropagation(); setMark(del.map(it => it.key), 'reject', 'whole thread'); render(); }, { disabled: !del.length, 'data-testid': 'gc-thread-delete' })));
      }
      const wrap = h('div', {},
        h('div', { class: 'note' }, 'One row per chat, biggest first. "Delete whole thread" queues every image of that chat that is in storage (starred ones excepted). Click a row to pick images one by one. Then press Delete… at the bottom.'),
        h('label', { class: 'unlock' }, h('input', { type: 'checkbox', checked: !!st.showHistoryOnly, onchange: e => { st.showHistoryOnly = e.target.checked; render(); } }), ' Also show chats whose images are only in history'),
        h('div', { class: 'muted small' }, `${plural(all.length, 'chat')}.`),
        list);
      if (all.length > (st.seriesLimit || 200)) wrap.append(btn(`Show more (${num(all.length - (st.seriesLimit || 200))} left)`, () => { st.seriesLimit = (st.seriesLimit || 200) + 300; render(); }));
      return wrap;
    }
    const doTile = (it, i) => {
      const m = markOf(it.key);
      const el = h('div', { class: `gtile ${m === 'reject' ? 'rej' : ''} ${m === 'keep' ? 'kept' : ''}`, 'data-testid': 'gc-gen-tile', title: it.prompt || it.title || it.name || '' },
        thumb(it, 150),
        h('div', { class: 'gmeta' }, `v${i + 1}`, it.created ? ` · ${new Date(it.created).toLocaleDateString()}` : '', it.size ? ` · ${fmt(it.size)}` : ''),
        btn(m === 'keep' ? '★' : '☆', e => { e.stopPropagation(); setMark([it.key], m === 'keep' ? null : 'keep', 'kept by you'); render(); }, { class: 'star', title: 'Keep (protects from bulk actions)' }),
        m === 'reject' ? h('div', { class: 'x' }, '✕') : null,
        tileActions(it));
      el.addEventListener('click', e => {
        const idx = s.items.indexOf(it);
        if (e.shiftKey) {
          const anchor = st.lastClicked ?? idx;
          const [a, b] = [Math.min(idx, anchor), Math.max(idx, anchor)];
          setMark(s.items.slice(a, b + 1).map(x => x.key), 'reject', 'rejected by you');
          st.lastClicked = idx;
          render();
          return;
        }
        st.lastClicked = idx;
        openViewer(s.items, idx);
      });
      return el;
    };
    const rej = s.items.filter(it => markOf(it.key) === 'reject');
    return h('div', {},
      h('div', { class: 'bar' },
        btn('← All series', () => { st.openSeries = null; st.lastClicked = null; render(); }),
        s.id !== '(no conversation)' ? h('a', { href: `/c/${s.id}`, target: '_blank', rel: 'noopener', class: 'link' }, 'Open chat ↗') : null,
        btn('Reject all not starred', () => { setMark(s.items.filter(it => markOf(it.key) !== 'keep').map(it => it.key), 'reject', 'rejected by you'); render(); }, { 'data-testid': 'gc-reject-unstarred' }),
        btn('Clear marks', () => { setMark(s.items.map(it => it.key), null); render(); })),
      h('div', { class: 'muted small' }, `${s.title || s.id} · ${num(s.items.length)} images · ${num(rej.length)} rejected (${fmt(rej.reduce((t, it) => t + (it.size || 0), 0))}). Click = view full size (← → move, X delete, S keep, D download, O open chat). ✕ = queue, shift-click = queue a range, ☆ = keep.`),
      h('div', { class: 'grid' }, s.items.map(doTile)));
  }

  function viewLookalikes() {
    if (!st.scannedAt) return h('p', { class: 'muted' }, 'Scan first.');
    const targets = fingerprintTargets();
    const est = targets.reduce((t, it) => t + (it.thumbUrl || it.genThumbUrl ? 60e3 : (it.size || 2e6)), 0);
    progressEl = h('span', { class: 'muted' }, st.fp.running ? `${num(st.fp.done)} / ${num(st.fp.total)}` : '');
    const controls = h('div', { class: 'bar' },
      h('label', {}, 'Compare ',
        h('select', { onchange: e => { st.fp.scope = e.target.value; if (st.lookalikes) computeLookalikes(); render(); } },
          h('option', { value: 'series', selected: st.fp.scope === 'series' }, 'within each chat (uploads among uploads)'),
          h('option', { value: 'all', selected: st.fp.scope === 'all' }, 'across everything'))),
      h('label', { title: 'How many of 64 fingerprint bits may differ. 0 = identical, 5 = near-identical, 10+ = loose.' }, ' Strictness ',
        h('input', { type: 'range', min: 0, max: 12, value: String(st.fp.threshold), onchange: e => { st.fp.threshold = Number(e.target.value); if (st.lookalikes) computeLookalikes(); render(); } }),
        ` ${st.fp.threshold}`),
      st.fp.running ? btn('Stop', () => st.fp.abort?.abort())
        : btn(targets.length ? `Fingerprint ${num(targets.length)} images` : 'Find look-alikes', targets.length ? fingerprint : () => { computeLookalikes(); render(); }, { class: 'primary', 'data-testid': 'gc-fingerprint' }),
      progressEl);
    const wrap = h('div', {},
      h('div', { class: 'note' }, 'A fingerprint (dHash, a 64-bit sketch of the image) is computed once per image and cached in this browser. ',
        targets.length ? `This needs to download up to ~${fmt(est)} of images.` : 'All images are fingerprinted.'),
      controls);
    if (!st.lookalikes) return wrap;
    add(wrap, h('div', { class: 'muted small' }, `${plural(st.lookalikes.length, 'group')} of look-alikes.`),
      st.lookalikes.length ? btn('For every group: keep one, queue the rest', () => {
        for (const g of st.lookalikes) { const k = keeperOf(g); setMark(g.filter(it => it !== k).map(it => it.key), 'reject', 'look-alike'); }
        render();
      }, { 'data-testid': 'gc-lookalike-all' }) : null);
    for (const g of st.lookalikes.slice(0, 200)) {
      const keeper = keeperOf(g);
      wrap.append(h('div', { class: 'lgroup', 'data-testid': 'gc-lookalike-group' },
        h('div', { class: 'bar' }, h('span', { class: 'muted small' }, `${g.length} look-alikes`),
          btn('Keep ★, queue the rest', () => { setMark(g.filter(it => it !== keeper).map(it => it.key), 'reject', 'look-alike'); render(); })),
        h('div', { class: 'grid' }, g.map(it => {
          const m = markOf(it.key);
          const el = h('div', { class: `gtile ${m === 'reject' ? 'rej' : ''} ${it === keeper ? 'kept' : ''}` },
            thumb(it, 120),
            h('div', { class: 'gmeta' }, `${it.kind}${it.name ? ` · ${it.name}` : ''}`),
            m === 'reject' ? h('div', { class: 'x' }, '✕') : null,
            tileActions(it));
          el.addEventListener('click', () => openViewer(g, g.indexOf(it)));
          return el;
        }))));
    }
    return wrap;
  }

  function viewQueue() {
    const q = queued();
    const d = st.del;
    const wrap = h('div', {});
    if (d) wrap.append(viewDelete(d));
    const byWhy = new Map();
    for (const it of q) { const w = st.marks.get(it.key)?.why || 'queued'; const b = byWhy.get(w) || { n: 0, bytes: 0, gens: 0 }; b.n++; b.bytes += it.size || 0; if (it.kind === 'generation') b.gens++; byWhy.set(w, b); }
    wrap.append(
      h('div', { class: 'tiles' }, [...byWhy].map(([w, b]) => tile(w, b.n, b.bytes, b.gens ? `${num(b.gens)} generations` : null))),
      h('div', { class: 'bar' },
        btn('Download list (JSON)', () => download(`gencull-queue-${stamp()}.json`, manifest(q)), { disabled: !q.length }),
        btn('Clear queue', () => { setMark(q.map(it => it.key), null); render(); }, { disabled: !q.length }),
        q.length && !d ? btn(st.dryRun ? 'Simulate delete…' : `Delete ${num(q.length)} files…`, startDelete, { class: st.dryRun ? 'primary' : 'danger', 'data-testid': 'gc-delete-start' }) : null));
    const list = h('div', { class: 'rows' });
    for (const it of q.slice(0, st.queueLimit)) {
      list.append(h('div', { class: 'row' },
        thumb(it, 48),
        h('div', { class: 'rmain' },
          h('div', { class: 'rname' }, it.name || it.title || it.key),
          h('div', { class: 'muted small' }, `${fmt(it.size)} · ${it.kind} · ${st.marks.get(it.key)?.why || ''}${it.fromLibrary ? '' : ' · may not be deletable (not in storage listing)'}`)),
        btn('Unqueue', () => { setMark([it.key], null); render(); })));
    }
    wrap.append(list);
    if (q.length > st.queueLimit) wrap.append(btn(`Show more (${num(q.length - st.queueLimit)} left)`, () => { st.queueLimit += 500; render(); }));
    return wrap;
  }

  function viewDelete(d) {
    progressEl = h('span', { 'data-testid': 'gc-del-progress' }, d.results.length ? `${num(d.results.length)} / ${num(d.items.length)} processed` : '');
    const bytes = d.items.reduce((t, it) => t + (it.size || 0), 0);
    const gens = d.items.filter(it => it.kind === 'generation').length;
    const box = h('div', { class: `delbox ${st.dryRun ? '' : 'real'}`, 'data-testid': 'gc-delbox' });
    box.append(h('h3', {}, st.dryRun ? 'Simulate delete (dry run)' : 'Delete from ChatGPT storage'),
      h('div', {}, `${num(d.items.length)} files · ${fmt(bytes)}${gens ? ` · includes ${num(gens)} generations you rejected` : ''}`),
      h('ul', { class: 'small' },
        d.plan.map(p => h('li', {}, `${num(p.n)} via ${p.label}${p.learned ? '' : ' (not yet confirmed on your account)'}`)),
        d.impossible ? h('li', { class: 'warnt' }, `${num(d.impossible)} cannot be deleted: missing ids. Teach a delete in Setup.`) : null));
    if (d.phase === 'confirm') {
      if (st.dryRun) {
        box.append(h('p', { class: 'small' }, 'Dry run is on: nothing will be sent. Turn it off at the top to delete for real.'),
          h('div', { class: 'bar' }, btn('Run simulation', deleteCanary, { class: 'primary', 'data-testid': 'gc-del-go' }), btn('Cancel', () => { st.del = null; render(); })));
      } else {
        const input = h('input', { type: 'text', placeholder: 'type delete', 'data-testid': 'gc-del-confirm', value: d.typed, oninput: e => { d.typed = e.target.value; go.disabled = d.typed.trim().toLowerCase() !== 'delete'; } });
        const go = btn('Delete 1 test file first', deleteCanary, { class: 'danger', disabled: d.typed.trim().toLowerCase() !== 'delete', 'data-testid': 'gc-del-go' });
        box.append(h('p', { class: 'small' }, 'ChatGPT says deleted files are removed for good within 30 days. A list of everything in this run downloads first. Type ', h('b', {}, 'delete'), ' to continue.'),
          h('div', { class: 'bar' }, input, go, btn('Cancel', () => { st.del = null; render(); })));
      }
    } else if (d.phase === 'running') {
      box.append(h('div', { class: 'bar' }, h('span', {}, 'Working… '), progressEl, btn('Stop', () => d.abort?.abort())));
    } else if (d.phase === 'canary-ok') {
      const it = d.canary.item;
      box.append(h('p', {}, `Test delete succeeded: "${it.name || it.key}". Check Settings → Storage in another tab: the count should have dropped by one. If it did, continue.`),
        h('div', { class: 'bar' },
          btn(`Continue with ${num(d.items.length - 1)} more`, deleteRest, { class: 'danger', 'data-testid': 'gc-del-continue' }),
          btn('Stop here', () => { st.del = null; render(); })));
    } else if (d.phase === 'done') {
      const ok = d.results.filter(r => r.ok);
      const failed = d.results.filter(r => !r.ok);
      add(box, h('p', { 'data-testid': 'gc-del-result' }, d.results.some(r => r.dry)
        ? `Simulation: ${num(ok.length)} files would be deleted, ${num(failed.length)} could not be.`
        : `Deleted ${num(ok.length)} files (${fmt(ok.reduce((t, r) => t + (r.item.size || 0), 0))}). ${num(failed.length)} failed or skipped.`),
      failed.length ? h('ul', { class: 'small' }, failed.slice(0, 8).map(r => h('li', {}, `${r.item.name || r.item.key}: ${r.detail}`))) : null,
      d.results.some(r => r.dry) ? h('ul', { class: 'small' }, ok.slice(0, 3).map(r => h('li', {}, r.detail))) : null,
      h('div', { class: 'bar' },
        btn('Download results', () => download(`gencull-results-${stamp()}.json`, JSON.stringify(d.results.map(r => ({ name: r.item.name, fileId: r.item.fileId, libraryFileId: r.item.libraryFileId, ok: r.ok, dry: !!r.dry, status: r.status, detail: r.detail })), null, 2))),
        btn('Close', () => { st.del = null; render(); }),
        d.results.some(r => r.dry) ? null : btn('Rescan', () => { st.del = null; scan(); })));
    }
    return box;
  }

  function viewSetup() {
    const lists = N.learnedListSources();
    const dels = N.learned.deletes;
    return h('div', {},
      h('h3', {}, 'What GenCull knows about your ChatGPT'),
      h('ul', { class: 'facts' },
        h('li', { 'data-testid': 'gc-setup-list' }, lists.length ? `Storage listing: learned ${lists.length} request(s): ${lists.map(l => `${l.method} ${l.url.split('?')[0]}${l.cursorParam ? ` (pages via "${l.cursorParam}")` : ''}`).join('; ')}` : 'Storage listing: not learned yet (will try known endpoints).'),
        h('li', { 'data-testid': 'gc-setup-delete' }, dels.length ? `Delete: learned ${dels[0].method} ${dels[0].path}` : 'Delete: not learned yet. Will try known endpoints, which may be outdated.'),
        h('li', {}, `Reusable app headers: ${Object.keys(N.learned.headers).join(', ') || 'none yet'}`)),
      h('h3', {}, 'Teach it (one minute, recommended)'),
      h('ol', {},
        h('li', {}, 'Keep GenCull installed (or pasted) in this tab.'),
        h('li', {}, 'Open ChatGPT Settings → Storage → Images, or the Library page, and scroll the list a little. GenCull watches how ChatGPT loads it.'),
        h('li', {}, 'Delete ONE image you do not need with ChatGPT\'s own delete button. GenCull learns the exact delete request your account uses.'),
        h('li', {}, 'Come back here and press Rescan.')),
      h('p', { class: 'small muted' }, 'Only request shapes are stored (in this browser\'s localStorage). Your login token is kept in memory only.'),
      h('div', { class: 'bar' },
        btn('Forget learned requests', () => { N.forget(); render(); }),
        btn('Copy diagnostics', copyDiagnostics, { title: 'Structure of the responses with your data removed. Useful for a bug report.' })),
      h('h3', {}, 'Delete methods, in the order they are tried'),
      h('ul', { class: 'small' }, N.deleteTemplates().map(t => h('li', {}, `${t.method} ${t.path}${t.params.length ? `?${t.params.map(p => p[0]).join('&')}` : ''} — ${t.label}`))),
      h('p', { class: 'small muted' }, `GenCull ${VERSION}. Unofficial; uses ChatGPT's internal web endpoints, which can change without notice.`));
  }

  async function copyDiagnostics() {
    const s = st.summary;
    const diag = {
      version: VERSION, at: new Date().toISOString(), ...N.diagnostics(),
      scan: st.scannedAt ? {
        counts: s && { total: s.total.n, upload: s.upload.n, generation: s.generation.n, unknown: s.unknown.n, unsized: s.unsized },
        gen: st.genInfo, lib: st.libInfo && { count: st.libInfo.count, complete: st.libInfo.complete, sources: st.libInfo.sources },
        linkRate: st.cls?.linkRate, trustAbsence: st.cls?.trustAbsence,
        sampleItem: st.items[0] && C.shapeOf(Object.fromEntries(Object.entries(st.items[0]).filter(([k]) => !['name', 'title', 'prompt'].includes(k)))),
      } : null,
    };
    const text = JSON.stringify(diag, null, 2);
    try { await navigator.clipboard.writeText(text); log('Diagnostics copied to clipboard.'); } catch { download(`gencull-diagnostics-${stamp()}.json`, text); log('Diagnostics downloaded.'); }
  }

  // ----------------------------------------------------------------- CSS ----

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.launcher { position: fixed; right: 0; top: 42%; z-index: 2147483000; writing-mode: vertical-rl; transform: rotate(180deg);
  font: 600 12px/1 system-ui, -apple-system, sans-serif; letter-spacing: .04em; padding: 12px 7px; border: 1px solid #3a3b41;
  border-right: none; border-radius: 0 8px 8px 0; background: #17181b; color: #e8e8ec; cursor: pointer; }
.launcher:hover { background: #24252a; }
.drawer { position: fixed; top: 0; right: 0; height: 100vh; width: min(760px, 100vw); z-index: 2147483001; display: none; flex-direction: column;
  background: #121316; color: #e8e8ec; border-left: 1px solid #2c2d33; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: -12px 0 40px rgba(0,0,0,.35); }
.drawer.open { display: flex; }
.header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px 6px; flex-wrap: wrap; }
.brand b { font-size: 15px; }
.actions { display: flex; gap: 8px; align-items: center; }
.status { padding: 0 14px 6px; min-height: 18px; color: #a9abb6; font-size: 12px; }
.tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid #2c2d33; overflow-x: auto; }
.tab { background: none; border: none; color: #a9abb6; padding: 8px 10px; border-bottom: 2px solid transparent; border-radius: 0; }
.tab.on { color: #fff; border-bottom-color: #8ab4ff; }
.body { flex: 1; overflow: auto; padding: 12px 14px; }
.footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid #2c2d33; background: #15161a; }
.logwrap { padding: 0 14px 8px; font-size: 11px; color: #8b8d98; }
.log { margin: 4px 0 0; max-height: 110px; overflow: auto; white-space: pre-wrap; font: 11px/1.4 ui-monospace, Menlo, monospace; color: #a9abb6; }
button { font: inherit; color: #e8e8ec; background: #24252a; border: 1px solid #3a3b41; border-radius: 7px; padding: 5px 10px; cursor: pointer; }
button:hover:not(:disabled) { background: #2e2f35; }
button:disabled { opacity: .45; cursor: default; }
button.primary { background: #2b5bd7; border-color: #2b5bd7; color: #fff; }
button.primary:hover:not(:disabled) { background: #3a68e0; }
button.danger { background: #b3261e; border-color: #b3261e; color: #fff; }
button.ghost { background: none; }
button.icon { padding: 4px 8px; }
button.big { padding: 9px 16px; font-size: 14px; }
.toggle { display: flex; align-items: center; gap: 4px; color: #c9cad3; font-size: 12px; cursor: pointer; }
input[type=text], select { font: inherit; color: #e8e8ec; background: #1b1c20; border: 1px solid #3a3b41; border-radius: 6px; padding: 4px 8px; }
h3 { font-size: 13px; margin: 16px 0 8px; color: #fff; }
p { margin: 8px 0; }
.muted { color: #8b8d98; } .small { font-size: 12px; }
.intro { max-width: 560px; }
.hero { background: #172033; border: 1px solid #28406e; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.herobig { font-size: 20px; font-weight: 650; color: #fff; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin-bottom: 8px; }
.tile { background: #1a1b1f; border: 1px solid #2c2d33; border-radius: 10px; padding: 10px; }
.tlabel { font-size: 11px; color: #a9abb6; } .tnum { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; }
.tbytes { color: #c9cad3; font-variant-numeric: tabular-nums; } .tnote { font-size: 11px; color: #d8b35a; margin-top: 2px; } .tnote.good { color: #7fcf9a; }
.steps { padding-left: 18px; } .steps li { margin: 8px 0; } .steps li > div { margin-bottom: 4px; }
.warn { background: #33280f; border: 1px solid #6b5213; color: #f3d88b; border-radius: 8px; padding: 8px 10px; margin: 6px 0; font-size: 12px; }
.warnt { color: #f3d88b; }
.note { background: #172033; border: 1px solid #28406e; color: #c5d6ff; border-radius: 8px; padding: 8px 10px; margin: 6px 0; font-size: 12px; }
.facts { color: #a9abb6; font-size: 12px; margin-top: 14px; } .facts div, .facts li { margin: 2px 0; }
.bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0; }
.unlock { display: flex; gap: 6px; align-items: center; font-size: 12px; margin: 6px 0; }
.rows { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.row { display: flex; align-items: center; gap: 10px; padding: 6px; border-radius: 8px; background: #17181c; }
.row.click { cursor: pointer; } .row.queued { background: #2a1715; } .row.click:hover { background: #1f2025; }
.rmain { flex: 1; min-width: 0; } .rname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg { display: flex; } .seg button { border-radius: 0; margin-left: -1px; padding: 4px 8px; font-size: 12px; }
.seg button:first-child { border-radius: 7px 0 0 7px; } .seg button:last-child { border-radius: 0 7px 7px 0; }
.seg button.on { background: #34363d; color: #fff; } .seg button.on.bad { background: #5b1d19; border-color: #8a2b24; }
.thumb { display: block; border-radius: 6px; background: #1b1c1f; flex: none; }
.row .thumb { width: 48px; height: 48px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-top: 8px; }
.gtile { position: relative; background: #17181c; border: 2px solid transparent; border-radius: 9px; padding: 4px; cursor: pointer; }
.gtile .thumb { width: 100%; height: auto; aspect-ratio: 1; }
.gtile.rej { border-color: #b3261e; } .gtile.rej .thumb { opacity: .35; }
.gtile.kept { border-color: #d8b35a; }
.gmeta { font-size: 11px; color: #8b8d98; padding: 3px 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.star { position: absolute; top: 7px; right: 7px; padding: 1px 6px; font-size: 13px; background: rgba(0,0,0,.55); border: none; color: #f3d88b; }
.viewer { position: fixed; inset: 0; z-index: 2147483003; background: rgba(8,8,10,.96); display: flex; flex-direction: column; color: #e8e8ec; font: 13px/1.4 system-ui, -apple-system, sans-serif; }
.vbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #2c2d33; }
.vinfo { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vbtns { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.vstate.reject { color: #ff6b61; font-weight: 600; } .vstate.keep { color: #f3d88b; font-weight: 600; }
.vprompt { padding: 6px 14px; color: #a9abb6; font-size: 12px; max-height: 3.2em; overflow: hidden; }
.vstage { flex: 1; min-height: 0; display: grid; place-items: center; padding: 10px; overflow: auto; }
.vcanvas { max-width: 100%; max-height: 100%; object-fit: contain; image-rendering: auto; }
.tact.on { background: #b3261e; }
.tacts { position: absolute; bottom: 24px; right: 7px; display: flex; gap: 4px; }
.tact { font: 13px/1 system-ui, sans-serif; padding: 4px 7px; background: rgba(0,0,0,.65); border: none; border-radius: 6px; color: #fff; text-decoration: none; cursor: pointer; }
.tact:hover { background: #2b5bd7; }
.x { position: absolute; inset: 0; display: grid; place-items: center; font-size: 42px; color: #ff6b61; pointer-events: none; }
.lgroup { border: 1px solid #2c2d33; border-radius: 10px; padding: 6px 8px; margin: 8px 0; }
.delbox { border: 1px solid #28406e; background: #141b2b; border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
.delbox.real { border-color: #8a2b24; background: #211413; }
.delbox h3 { margin-top: 0; }
a.link { color: #8ab4ff; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 20px); z-index: 2147483002; max-width: min(560px, 90vw);
  background: #17181b; color: #e8e8ec; border: 1px solid #3a5bd7; border-radius: 10px; padding: 10px 14px; cursor: pointer;
  font: 13px/1.4 system-ui, -apple-system, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.4); opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; }
.toast.show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
`;

  function start() {
    N.install();
    // Pasted into the console of a loaded page: open right away so you can see it worked.
    const pasted = document.readyState === 'complete';
    const boot = () => {
      mount();
      if (pasted) st.open = true;
      render();
      status(`loaded (v${VERSION}). Click the GenCull tab on the right edge.`);
      console.info('%cGenCull %s is running. Look for the GenCull tab on the right edge of the page.', 'color:#8ab4ff;font-weight:bold;font-size:14px', VERSION);
    };
    if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, { once: true });
  }

  return { start, st, scan, autopilot };
})();
