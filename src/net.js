/*
 * GenCull network layer. Runs inside your logged-in ChatGPT tab and calls
 * the same internal endpoints the ChatGPT web app calls. None of them are a
 * public API; that is why this module can also *learn* the requests from
 * the app itself (watch the storage page list files, watch one manual
 * delete) instead of trusting hard-coded guesses.
 */
const GCNet = (() => {
  'use strict';
  const C = GCCore;
  const S = GCStore;
  // Keep the page's real fetch: our own calls go through it directly, so the
  // learning hook below only ever sees requests made by ChatGPT itself.
  const origFetch = window.fetch.bind(window);
  const LEARNED_KEY = 'gencull:learned:v1';
  const REUSABLE_HEADER_RE = /^(oai-device-id|oai-language|oai-client-version|oai-client-build-number|chatgpt-account-id)$/i;
  // Where Library/storage listings plausibly live. Conversation payloads also
  // mention files (attachments) and must not be mistaken for the Library.
  const LIST_PATH_RE = /\/backend-api\/.*(files|library|storage|assets|media|uploads|images)/i;
  const LIST_PATH_EXCLUDE_RE = /\/(conversation|conversations|my\/recent\/image_gen|download|estuary)\b/i;
  // Only the URL counts: a chat message that says "delete" must never be learned as a delete.
  const DELETE_HINT_RE = /(delete|remove|trash|purge)/i;
  const CHAT_PATH_RE = /\/(conversation|conversations|gizmos|projects|sentinel|codex)\b/i;

  const KNOWN_LIST_SOURCES = [
    { method: 'POST', url: '/backend-api/files/library', body: JSON.stringify({ limit: 100, cursor: null }), origin: 'known: seen in sand7000/chat-gpt-bulk-delete' },
    { method: 'GET', url: '/backend-api/files/library/nodes?limit=100', body: null, origin: 'known: named in johnvouros/ChatGPT-bulk-delete-chats#7' },
  ];
  const KNOWN_DELETE_TEMPLATES = [
    {
      method: 'POST', origin: '', path: '/backend-api/files/library/files/delete-batch', params: [],
      body: { json: { files: [{ library_file_id: '{{libraryFileId}}', file_id: '{{fileId}}' }] } },
      batchPath: ['files'], needs: ['libraryFileId', 'fileId'], label: 'known: delete-batch (used by GPT-Library-Cleaner 2.7)',
    },
    {
      method: 'POST', origin: '', path: '/backend-api/files/library/files/{{libraryFileId}}/delete_stream',
      params: [['file_id', '{{fileId}}'], ['file_name', '{{fileName}}'], ['soft_delete', 'true']],
      body: null, batchPath: null, needs: ['libraryFileId', 'fileId', 'fileName'], label: 'known: delete_stream (reported in ChatGPT-bulk-delete-chats#7)',
    },
  ];
  const IMAGE_GEN_URL = '/backend-api/my/recent/image_gen?limit=100';

  const learned = Object.assign({ lists: {}, deletes: [], headers: {} }, S.lsGet(LEARNED_KEY, {}));
  let memAuth = null, memAuthAt = 0;
  const listeners = new Set();
  const lastCursorBySource = new Map();
  const errors = [];

  const persist = () => S.lsSet(LEARNED_KEY, { lists: learned.lists, deletes: learned.deletes, headers: learned.headers });
  const emit = what => listeners.forEach(fn => { try { fn(what); } catch { /* listener bug */ } });
  const onLearn = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
  const noteError = (where, detail) => { errors.push({ at: new Date().toISOString(), where, detail: String(detail).slice(0, 300) }); if (errors.length > 50) errors.shift(); };

  function forget() {
    learned.lists = {}; learned.deletes = []; learned.headers = {};
    S.lsDel(LEARNED_KEY);
    emit('forget');
  }

  // ------------------------------------------------------------ learning ----

  function headersToObject(h) {
    const out = {};
    try { new Headers(h || {}).forEach((v, k) => { out[k.toLowerCase()] = v; }); } catch { /* odd header init */ }
    return out;
  }

  function absorbHeaders(h) {
    let changed = false;
    for (const [k, v] of Object.entries(h)) {
      if (k === 'authorization' && /^bearer /i.test(v)) { memAuth = v; memAuthAt = Date.now(); }
      else if (REUSABLE_HEADER_RE.test(k) && learned.headers[k] !== v) { learned.headers[k] = v; changed = true; }
    }
    if (changed) persist();
  }

  const sourceKey = (method, url, body) => {
    const first = C.firstPageOf({ method, url, body });
    const u = new URL(first.url, location.href);
    return `${method} ${u.pathname}?${[...u.searchParams.keys()].sort().join('&')} ${first.body ? Object.keys(safeJson(first.body) || {}).sort().join(',') : ''}`;
  };
  const safeJson = t => { try { return JSON.parse(t); } catch { return null; } };

  function observe(method, url, reqHeaders, body, res) {
    let u;
    try { u = new URL(url, location.href); } catch { return; }
    if (u.origin !== location.origin || !u.pathname.startsWith('/backend-api/')) return;
    absorbHeaders(reqHeaders);
    const bodyText = typeof body === 'string' ? body : null;

    const deleteLike = method === 'DELETE' || (method !== 'GET' && DELETE_HINT_RE.test(`${u.pathname}${u.search}`));
    if (deleteLike) {
      // Storage deletes only: never learn from chats, GPTs or projects.
      if (!res.ok || CHAT_PATH_RE.test(u.pathname) || !LIST_PATH_RE.test(u.pathname)) return;
      const tpl = C.templatize({ method, url: u.href, body: bodyText });
      if (!tpl) return;
      const sig = JSON.stringify([tpl.method, tpl.path, tpl.params.map(p => p[0]), tpl.body && Object.keys(tpl.body.json || {})]);
      learned.deletes = [{ ...tpl, sig, label: `learned from your ChatGPT tab (${new Date().toLocaleString()})`, learnedAt: Date.now() },
        ...learned.deletes.filter(d => d.sig !== sig)].slice(0, 5);
      persist();
      emit('delete');
      return;
    }

    if (!LIST_PATH_RE.test(u.pathname) || LIST_PATH_EXCLUDE_RE.test(u.pathname)) return;
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('json')) return;
    res.clone().text().then(text => {
      const json = safeJson(text);
      if (!json) return;
      const key = sourceKey(method, u.href, bodyText);
      // Did this request carry the cursor the previous page returned? Then we know the cursor parameter.
      const prev = lastCursorBySource.get(key);
      const param = prev ? C.learnCursorParam(prev.cursor, { url: u.href, body: bodyText }, prev.req) : null;
      const info = C.readPageInfo(json);
      if (info.cursor) lastCursorBySource.set(key, { cursor: info.cursor, req: { url: u.href, body: bodyText } });
      const items = C.extractLibraryItems(json);
      const existing = learned.lists[key];
      if (!items.length && !existing) return;
      const first = C.firstPageOf({ method, url: u.href, body: bodyText });
      const fu = new URL(first.url, location.href);
      learned.lists[key] = {
        method, url: `${fu.pathname}${fu.search}`,
        body: first.body, cursorParam: param || existing?.cursorParam || null,
        sampleCount: Math.max(items.length, existing?.sampleCount || 0),
        imageCount: Math.max(items.filter(C.isImage).length, existing?.imageCount || 0),
        shape: existing?.shape || C.shapeOf(json), learnedAt: Date.now(),
      };
      persist();
      emit('list');
    }).catch(() => { /* not our business */ });
  }

  function install() {
    if (window.__gencullHooked) return;
    window.__gencullHooked = true;
    window.fetch = async function gencullFetch(input, init) {
      const res = await origFetch(input, init);
      try {
        const isReq = typeof Request !== 'undefined' && input instanceof Request;
        const url = isReq ? input.url : String(input);
        const method = String(init?.method || (isReq ? input.method : 'GET')).toUpperCase();
        const headers = { ...(isReq ? headersToObject(input.headers) : {}), ...headersToObject(init?.headers) };
        let body = init?.body;
        if (body == null && isReq && method !== 'GET' && method !== 'HEAD') {
          input.clone().text().then(t => observe(method, url, headers, t, res)).catch(() => {});
        } else {
          observe(method, url, headers, typeof body === 'string' ? body : null, res);
        }
      } catch { /* never break the page */ }
      return res;
    };
    const XO = XMLHttpRequest.prototype;
    const open = XO.open, send = XO.send, setHeader = XO.setRequestHeader;
    XO.open = function (method, url, ...rest) { this.__gc = { method: String(method).toUpperCase(), url: String(url), headers: {} }; return open.call(this, method, url, ...rest); };
    XO.setRequestHeader = function (k, v) { if (this.__gc) this.__gc.headers[String(k).toLowerCase()] = String(v); return setHeader.call(this, k, v); };
    XO.send = function (body) {
      const meta = this.__gc;
      if (meta) {
        this.addEventListener('load', () => {
          try {
            const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : null;
            const fake = new Response(text, { status: this.status, headers: { 'content-type': this.getResponseHeader('content-type') || '' } });
            observe(meta.method, meta.url, meta.headers, typeof body === 'string' ? body : null, fake);
          } catch { /* ignore */ }
        });
      }
      return send.call(this, body);
    };
  }

  // ------------------------------------------------------------- requests ----

  async function authHeaders(force = false) {
    if (force || !memAuth || Date.now() - memAuthAt > 9 * 60 * 1000) {
      try {
        const r = await origFetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (j?.accessToken) { memAuth = `Bearer ${j.accessToken}`; memAuthAt = Date.now(); }
      } catch (e) { noteError('auth', e); }
    }
    return { ...learned.headers, ...(memAuth ? { authorization: memAuth } : {}) };
  }

  /** Authenticated same-origin request with 401 refresh and 429/5xx backoff. */
  async function api(method, url, body, { signal, accept = 'application/json', retries = 5 } = {}) {
    let forceAuth = false;
    for (let attempt = 0; ; attempt++) {
      const headers = { ...(await authHeaders(forceAuth)), accept };
      if (body != null) headers['content-type'] = 'application/json';
      const res = await origFetch(url, { method, headers, body: body ?? undefined, credentials: 'include', signal });
      if (res.status === 401 && attempt === 0) { forceAuth = true; continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 400, signal);
        continue;
      }
      return res;
    }
  }

  async function json(method, url, body, opts) {
    const res = await api(method, url, body, opts);
    const text = await res.text();
    if (!res.ok) { noteError(`${method} ${new URL(url, location.href).pathname}`, `HTTP ${res.status} ${text.slice(0, 120)}`); const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    const j = safeJson(text);
    if (j == null) throw new Error('response is not JSON');
    return j;
  }

  // -------------------------------------------------------------- listing ----

  /**
   * Read every page of a list endpoint. `extract` pulls items out of a page.
   * If the cursor parameter is unknown we try likely names and keep the one
   * that actually returns new items.
   */
  async function paginate(source, extract, { signal, onPage, maxPages = 4000, pauseMs = 120 } = {}) {
    let req = C.firstPageOf(source);
    let param = null, validated = false;
    let candidates = null, prevReq = null, prevCursor = null;
    const all = new Map();
    const seen = new Set();
    let pages = 0, complete = false;
    while (pages < maxPages) {
      const sig = `${req.method} ${req.url} ${req.body || ''}`;
      if (seen.has(sig)) break;
      seen.add(sig);
      const page = await json(req.method, req.url, req.body, { signal });
      const items = extract(page);
      let fresh = 0;
      for (const it of items) { const k = it.key || it.genId || JSON.stringify(it.fileIds); if (!all.has(k)) { all.set(k, it); fresh++; } }
      pages++;
      onPage?.({ pages, total: all.size });
      if (pages > 1 && !items.length) { complete = true; break; } // an empty last page
      if (pages > 1 && fresh === 0) {
        // The server ignored our cursor and sent page one again: wrong parameter name.
        if (!validated && candidates?.length) { param = candidates.shift(); req = C.withCursor(prevReq, param, prevCursor); continue; }
        complete = validated;
        break;
      }
      if (pages > 1) validated = true;
      const info = C.readPageInfo(page);
      if (!info.cursor || info.hasMore === false || !items.length) { complete = true; break; }
      if (!candidates) { candidates = C.cursorParamCandidates(req, info.cursorKey, source.cursorParam); param = candidates.shift(); }
      prevReq = req; prevCursor = info.cursor;
      req = C.withCursor(req, param, info.cursor);
      if (!req) break;
      await sleep(pauseMs, signal);
    }
    if (validated && param && source.key && learned.lists[source.key] && learned.lists[source.key].cursorParam !== param) {
      learned.lists[source.key].cursorParam = param; persist();
    }
    return { items: [...all.values()], pages, complete };
  }

  async function listGenerated(opts = {}) {
    return paginate({ method: 'GET', url: IMAGE_GEN_URL, body: null, cursorParam: 'after' }, C.extractGenItems, opts);
  }

  function learnedListSources() {
    return Object.entries(learned.lists)
      .map(([key, s]) => ({ ...s, key }))
      .sort((a, b) => b.imageCount - a.imageCount || b.sampleCount - a.sampleCount);
  }

  /**
   * Every Library/storage entry. Uses the requests learned from the storage
   * page when available, otherwise probes the endpoints other tools report.
   */
  async function listLibrary({ signal, onPage, onNote } = {}) {
    let sources = learnedListSources();
    const results = [];
    if (!sources.length) {
      for (const k of KNOWN_LIST_SOURCES) {
        try {
          const first = await json(k.method, k.url, k.body, { signal });
          if (C.extractLibraryItems(first).length) { sources = [k]; onNote?.(`Using ${k.origin}`); break; }
        } catch (e) { if (e.name === 'AbortError') throw e; }
      }
    }
    if (!sources.length) return { items: [], sources: [], complete: false, needsTeaching: true };
    const byKey = new Map();
    let complete = true;
    for (const src of sources) {
      try {
        const r = await paginate(src, C.extractLibraryItems, { signal, onPage });
        r.items.forEach(it => { if (!byKey.has(it.key)) byKey.set(it.key, it); });
        complete = complete && r.complete;
        results.push({ url: src.url, method: src.method, count: r.items.length, pages: r.pages, complete: r.complete });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        complete = false;
        results.push({ url: src.url, method: src.method, error: String(e.message || e) });
      }
    }
    return { items: [...byKey.values()], sources: results, complete, needsTeaching: false };
  }

  // --------------------------------------------------------------- images ----

  const IMG_TYPES = /^(image\/|application\/octet-stream|binary\/octet-stream)/i;

  async function fetchImage(url, signal, depth = 0) {
    const abs = new URL(url, location.href);
    const same = abs.origin === location.origin;
    const res = same ? await api('GET', abs.href, null, { signal, accept: 'image/*,application/json;q=0.9,*/*;q=0.8', retries: 2 })
      : await origFetch(abs.href, { credentials: 'omit', signal });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json') && depth < 2) {
      const j = safeJson(await res.text());
      const next = j && C.pick(j, ['download_url', 'downloadUrl', 'url', 'signed_url'], v => typeof v === 'string' && /^(https?:)?\//.test(v), 2);
      return next ? fetchImage(next, signal, depth + 1) : null;
    }
    if (IMG_TYPES.test(ct) || !ct) return res.blob();
    return null;
  }

  /** Raw bytes of an item's image, smallest known rendition first. */
  async function imageBlob(item, { signal, full = false } = {}) {
    const urls = full ? [item.url, item.genUrl] : [item.thumbUrl, item.genThumbUrl, item.genUrl, item.url];
    if (item.fileId) urls.push(`/backend-api/files/download/${encodeURIComponent(item.fileId)}`, `/backend-api/files/${encodeURIComponent(item.fileId)}/download`);
    for (const u of urls.filter(Boolean)) {
      try {
        const blob = await fetchImage(u, signal);
        if (blob && blob.size) return blob;
      } catch (e) { if (e.name === 'AbortError') throw e; }
    }
    return null;
  }

  // ------------------------------------------------------------- deleting ----

  function deleteTemplates() {
    return [...learned.deletes, ...KNOWN_DELETE_TEMPLATES];
  }

  /** Split items by the first template that can delete each of them. */
  function planDeletes(items) {
    const tpls = deleteTemplates();
    const plan = new Map();
    const impossible = [];
    for (const it of items) {
      const tpl = tpls.find(t => C.templateFits(t, it));
      if (!tpl) { impossible.push(it); continue; }
      if (!plan.has(tpl)) plan.set(tpl, []);
      plan.get(tpl).push(it);
    }
    return { plan, impossible };
  }

  /**
   * Delete items. With dryRun, only reports what would be sent. Stops after
   * three consecutive failures so a wrong guess cannot hammer the server.
   */
  async function deleteItems(items, { dryRun = true, signal, onResult, batchSize = 20, pauseMs = 600 } = {}) {
    const { plan, impossible } = planDeletes(items);
    const results = [];
    const done = new Set();
    const report = r => { results.push(r); done.add(r.item); onResult?.(r); };
    for (const it of impossible) report({ item: it, ok: false, status: 0, detail: 'no known way to delete this item (missing id); try teaching a delete' });
    let failStreak = 0, stopped = '';
    outer:
    for (const [tpl, list] of plan) {
      let reqs;
      try { reqs = C.buildRequests(tpl, list, batchSize); } catch (e) { noteError('build', e); continue; }
      for (const req of reqs) {
        if (signal?.aborted) { stopped = 'stopped by you'; break outer; }
        const path = new URL(req.url, location.href).pathname;
        if (dryRun) {
          for (const it of req.items) report({ item: it, ok: true, dry: true, status: 0, detail: `would ${req.method} ${path}`, template: tpl.label });
          continue;
        }
        let ok = false, status = 0, detail = '';
        try {
          const res = await api(req.method, req.url, req.body ?? null, { signal });
          status = res.status;
          const text = await res.text().catch(() => '');
          const j = safeJson(text);
          ok = res.ok && !(j && (j.success === false || j.ok === false || (j.error && !j.success)));
          detail = ok ? `${req.method} ${path}` : `HTTP ${res.status} ${text.slice(0, 160)}`;
          if (!ok) noteError(`delete ${path}`, detail);
        } catch (e) {
          if (e.name === 'AbortError') { stopped = 'stopped by you'; break outer; }
          detail = String(e.message || e);
          noteError('delete', detail);
        }
        for (const it of req.items) report({ item: it, ok, status, detail, template: tpl.label });
        failStreak = ok ? 0 : failStreak + 1;
        if (failStreak >= 3) { stopped = 'stopped after 3 failures in a row'; break outer; }
        // One request per file needs less spacing than one per batch of 20.
        await sleep(tpl.batchPath ? pauseMs : Math.min(pauseMs, 250), signal).catch(() => {});
      }
    }
    for (const it of items) if (!done.has(it)) report({ item: it, ok: false, status: 0, detail: `skipped: ${stopped || 'not attempted'}` });
    return results;
  }

  function diagnostics() {
    return {
      learnedLists: learnedListSources().map(s => ({ method: s.method, url: s.url.replace(/[?&].*$/, m => m.replace(/=[^&]*/g, '=…')), bodyKeys: s.body ? Object.keys(safeJson(s.body) || {}) : [], cursorParam: s.cursorParam, sampleCount: s.sampleCount, imageCount: s.imageCount, shape: s.shape })),
      learnedDeletes: learned.deletes.map(d => ({ method: d.method, path: d.path, params: d.params.map(p => p[0]), body: d.body, batchPath: d.batchPath, needs: d.needs })),
      reusableHeaders: Object.keys(learned.headers),
      errors: errors.slice(-20),
    };
  }

  return {
    install, onLearn, forget, learned, learnedListSources, deleteTemplates, KNOWN_DELETE_TEMPLATES,
    authHeaders, listGenerated, listLibrary, imageBlob, planDeletes, deleteItems, diagnostics,
  };
})();
