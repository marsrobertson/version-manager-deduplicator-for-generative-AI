/*
 * GenCull core: pure logic, no DOM, no network.
 * Everything here is unit-tested in Node (test/core.test.js).
 *
 * ChatGPT has no public API for Library/storage, so the response shapes we
 * parse are undocumented and may change. The parsers are deliberately
 * tolerant: they look for id-like, name-like and size-like fields instead of
 * relying on one exact schema.
 */
const GCCore = (() => {
  'use strict';

  // ---------------------------------------------------------------- ids ----

  // file-AbC123... (older) and file_00000000abc... (newer). Requiring 10+
  // characters after the prefix keeps words like "file-service" out.
  const FILE_ID_SRC = '(?<![A-Za-z0-9])file[-_][A-Za-z0-9]{10,}';
  const LIB_ID_SRC = '(?<![A-Za-z0-9])libfile[-_][A-Za-z0-9]{6,}';
  const isFileId = v => typeof v === 'string' && new RegExp(`^${FILE_ID_SRC}$`).test(v);
  const isLibId = v => typeof v === 'string' && new RegExp(`^${LIB_ID_SRC}$`).test(v);

  function idsInString(s) {
    const lib = s.match(new RegExp(LIB_ID_SRC, 'g')) || [];
    const file = s.match(new RegExp(FILE_ID_SRC, 'g')) || [];
    return { lib, file };
  }

  /** Every file/libfile id mentioned anywhere inside a JSON value. */
  function collectIds(node, out = { fileIds: new Set(), libIds: new Set() }, depth = 0) {
    if (node == null || depth > 8) return out;
    if (typeof node === 'string') {
      let s = node;
      try { s = decodeURIComponent(node); } catch { /* keep raw */ }
      const { lib, file } = idsInString(s);
      lib.forEach(id => out.libIds.add(id));
      file.forEach(id => out.fileIds.add(id));
    } else if (typeof node === 'object') {
      for (const v of Object.values(node)) collectIds(v, out, depth + 1);
    }
    return out;
  }

  // ------------------------------------------------------------ helpers ----

  const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
  const nonEmptyString = v => typeof v === 'string' && v.trim() !== '';
  const looksLikeMime = v => typeof v === 'string' && /^[-\w.+]+\/[-\w.+]+$/.test(v.trim());
  const positiveNumber = v => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0;
  };
  const looksLikeUrl = v => typeof v === 'string' && /^(https?:\/\/|\/)/.test(v) && !/^\/\//.test(v);

  /**
   * Breadth-first lookup of the first value under one of `keys` that passes
   * `ok`. Own keys win over nested ones; arrays are not searched.
   */
  function pick(obj, keys, ok = v => v != null, maxDepth = 2) {
    let level = [obj];
    for (let d = 0; d <= maxDepth && level.length; d++) {
      for (const node of level) {
        for (const k of keys) {
          if (Object.prototype.hasOwnProperty.call(node, k) && ok(node[k])) return node[k];
        }
      }
      const next = [];
      for (const node of level) for (const v of Object.values(node)) if (isObj(v)) next.push(v);
      level = next;
    }
    return undefined;
  }

  const MIN_TS = Date.UTC(2015, 0, 1);
  function toMillis(v, now = Date.now()) {
    let t = NaN;
    if (typeof v === 'number') t = v < 1e11 ? v * 1000 : v;
    else if (typeof v === 'string' && v.trim()) {
      t = /^\d+(\.\d+)?$/.test(v.trim()) ? toMillis(Number(v), now) : Date.parse(v);
    }
    return Number.isFinite(t) && t >= MIN_TS && t <= now + 366 * 864e5 ? Math.round(t) : null;
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
  }

  // Names that repeat across *different* images, so name+size is not enough
  // to call two of them copies of the same file.
  const GENERIC_NAME_RE = /^(image|img|file|blob|untitled|photo|picture|pic|download|screenshot|unknown|upload|clipboard|pasted[ _-]?image|generated[ _-]?image|output|chatgpt[ _-]?image)(?:[ _-]*\(?\d{0,3}\)?)?\.[a-z0-9]{2,5}$/i;
  const isGenericName = name => !nonEmptyString(name) || GENERIC_NAME_RE.test(name.trim());
  // The name ChatGPT gives a generated image when you download it.
  const CHATGPT_DOWNLOAD_RE = /^ChatGPT Image\b/i;

  const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|heic|heif|bmp|tiff?)$/i;
  const isImage = it => (it.mime ? /^image\//i.test(it.mime) : IMAGE_EXT_RE.test(it.name || '')) || it.inImageGen === true;

  // --------------------------------------------------- response parsing ----

  // Not 'title': that is usually the conversation title and repeats across files.
  const NAME_KEYS = ['name', 'file_name', 'filename', 'fileName', 'display_name', 'displayName', 'original_name', 'originalName'];
  const SIZE_KEYS = ['size', 'size_bytes', 'sizeBytes', 'bytes', 'byte_size', 'byteSize', 'file_size', 'fileSize', 'file_size_bytes', 'content_length', 'contentLength', 'storage_size', 'storageSize', 'size_in_bytes'];
  const MIME_KEYS = ['mime_type', 'mimeType', 'content_type', 'contentType', 'media_type', 'mediaType', 'mimetype', 'type'];
  const CREATED_KEYS = ['created_at', 'createdAt', 'created_time', 'createdTime', 'creation_time', 'create_time', 'created', 'uploaded_at', 'uploadedAt', 'upload_time', 'record_creation_time', 'file_upload_time', 'timestamp', 'updated_at', 'updatedAt'];
  const CONV_KEYS = ['conversation_id', 'conversationId', 'source_conversation_id', 'conv_id', 'thread_id', 'threadId'];
  const MSG_KEYS = ['message_id', 'messageId', 'source_message_id'];
  const THUMB_KEYS = ['thumbnail_url', 'thumbnailUrl', 'thumb_url', 'thumbnail', 'preview_url', 'previewUrl', 'preview'];
  const FULL_KEYS = ['url', 'image_url', 'imageUrl', 'download_url', 'downloadUrl', 'signed_url', 'signedUrl', 'path'];

  function pickUrls(obj) {
    const thumb = pick(obj, THUMB_KEYS, looksLikeUrl, 1) ||
      pick(obj, ['path', 'url'], looksLikeUrl, 3); // e.g. encodings.thumbnail.path
    const full = pick(obj, FULL_KEYS, looksLikeUrl, 1);
    return { thumbUrl: thumb || '', url: full || '' };
  }

  // Keys and values that say whether a file was uploaded or generated.
  const SIGNAL_KEY_RE = /(^|_)(source|origin|created_by|creator|producer|author|role|kind|category|provenance|generated|is_generated|generation|user_upload|is_upload|file_source|upload_source)$/i;
  const GEN_VALUE_RE = /(image_?gen|dall[-_ ]?e|generat|text2im|t2i|assistant|tool_output|model_output)/i;
  const UPLOAD_VALUE_RE = /(upload|^user$|user_file|attach)/i;

  function kindSignal(obj) {
    const hits = { generation: [], upload: [] };
    const visit = (node, depth) => {
      if (!isObj(node) || depth > 3) return;
      for (const [k, v] of Object.entries(node)) {
        if (isObj(v)) { visit(v, depth + 1); continue; }
        if (!SIGNAL_KEY_RE.test(k)) continue;
        if (typeof v === 'boolean') {
          if (!v) continue;
          if (/generat/i.test(k)) hits.generation.push(`${k}=true`);
          else if (/upload/i.test(k)) hits.upload.push(`${k}=true`);
        } else if (typeof v === 'string') {
          if (GEN_VALUE_RE.test(v)) hits.generation.push(`${k}=${v}`);
          else if (UPLOAD_VALUE_RE.test(v)) hits.upload.push(`${k}=${v}`);
        }
      }
    };
    visit(obj, 0);
    if (hits.generation.length && !hits.upload.length) return { kind: 'generation', evidence: hits.generation.join(', ') };
    if (hits.upload.length && !hits.generation.length) return { kind: 'upload', evidence: hits.upload.join(', ') };
    return { kind: null, evidence: '' };
  }

  /** One Library/storage entry → normalised item, or null if it is not a file. */
  function normalizeLibraryItem(obj) {
    if (!isObj(obj)) return null;
    const libraryFileId = [obj.library_file_id, obj.libraryFileId, obj.id, obj.node_id, obj.nodeId].find(isLibId) ||
      pick(obj, ['library_file_id', 'libraryFileId'], isLibId, 1) || null;
    const fileId = [obj.file_id, obj.fileId, obj.id].find(isFileId) ||
      pick(obj, ['file_id', 'fileId', 'id', 'openai_file_id'], isFileId, 2) || null;
    if (!libraryFileId && !fileId) return null;
    const name = pick(obj, NAME_KEYS, nonEmptyString);
    const size = pick(obj, SIZE_KEYS, positiveNumber);
    const mime = pick(obj, MIME_KEYS, looksLikeMime);
    // Something that merely mentions a file id (a message, a folder) is not a file.
    if (!name && !size && !mime) return null;
    const signal = kindSignal(obj);
    const ids = collectIds(obj);
    return {
      key: libraryFileId || fileId,
      libraryFileId,
      fileId,
      allFileIds: [...ids.fileIds],
      name: name ? String(name).trim() : '',
      title: pick(obj, ['title'], nonEmptyString, 1) || '',
      size: size ? Number(size) : 0,
      mime: mime ? String(mime).trim().toLowerCase() : '',
      width: Number(pick(obj, ['width', 'image_width'], positiveNumber)) || 0,
      height: Number(pick(obj, ['height', 'image_height'], positiveNumber)) || 0,
      created: toMillis(pick(obj, CREATED_KEYS, v => toMillis(v) != null)),
      conversationId: pick(obj, CONV_KEYS, nonEmptyString) || '',
      messageId: pick(obj, MSG_KEYS, nonEmptyString) || '',
      ...pickUrls(obj),
      signal: signal.kind,
      signalEvidence: signal.evidence,
      fromLibrary: true,
      inImageGen: false,
    };
  }

  /**
   * All file-like entries in a list response. An object recognised as a file
   * is not searched further (its nested `file: {...}` is part of it), but
   * arrays inside it are, so folder-style trees still work.
   */
  function extractLibraryItems(json) {
    const out = [];
    const seen = new Set();
    const visit = (node, depth) => {
      if (node == null || typeof node !== 'object' || depth > 12 || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { node.forEach(n => visit(n, depth + 1)); return; }
      const item = normalizeLibraryItem(node);
      if (item) {
        out.push(item);
        for (const v of Object.values(node)) if (Array.isArray(v)) visit(v, depth + 1);
        return;
      }
      for (const v of Object.values(node)) visit(v, depth + 1);
    };
    visit(json, 0);
    return out;
  }

  /** Items of GET /backend-api/my/recent/image_gen (generated-images history). */
  function extractGenItems(json) {
    const arr = (isObj(json) && (json.items || json.data || json.results || json.images)) || (Array.isArray(json) ? json : []);
    return (Array.isArray(arr) ? arr : []).filter(isObj).map(o => {
      const ids = collectIds(o);
      return {
        genId: String(o.id ?? o.gen_id ?? ''),
        fileIds: [...ids.fileIds],
        libIds: [...ids.libIds],
        title: nonEmptyString(o.title) ? o.title : '',
        prompt: nonEmptyString(o.prompt) ? o.prompt : '',
        created: toMillis(pick(o, CREATED_KEYS, v => toMillis(v) != null, 1)),
        width: Number(o.width) || 0,
        height: Number(o.height) || 0,
        conversationId: pick(o, CONV_KEYS, nonEmptyString, 1) || '',
        messageId: pick(o, MSG_KEYS, nonEmptyString, 1) || '',
        ...pickUrls(o),
      };
    });
  }

  // ------------------------------------------------------------- merging ----

  /**
   * Join the Library listing with the generated-images history. Library
   * entries whose file id appears in the history are generations.
   */
  function mergeInventory(libraryItems, genItems) {
    const items = new Map();
    const byFileId = new Map();
    const index = it => {
      if (it.fileId) byFileId.set(it.fileId, it);
      for (const id of it.allFileIds || []) if (!byFileId.has(id)) byFileId.set(id, it);
    };
    for (const it of libraryItems) {
      const existing = items.get(it.key) || (it.fileId && byFileId.get(it.fileId));
      if (existing) {
        for (const [k, v] of Object.entries(it)) if (existing[k] == null || existing[k] === '' || existing[k] === 0) existing[k] = v;
        existing.allFileIds = [...new Set([...(existing.allFileIds || []), ...(it.allFileIds || [])])];
        index(existing);
      } else {
        const copy = { ...it };
        items.set(copy.key, copy);
        index(copy);
      }
    }
    let linked = 0;
    const seenGen = new Set();
    for (const g of genItems) {
      const dedupeKey = g.genId || g.fileIds[0];
      if (dedupeKey && seenGen.has(dedupeKey)) continue;
      if (dedupeKey) seenGen.add(dedupeKey);
      const match = g.fileIds.map(id => byFileId.get(id)).find(Boolean) ||
        g.libIds.map(id => items.get(id)).find(Boolean);
      const extra = {
        genId: g.genId, title: g.title, prompt: g.prompt, conversationId: g.conversationId,
        messageId: g.messageId, width: g.width, height: g.height, created: g.created,
        genUrl: g.url, genThumbUrl: g.thumbUrl,
      };
      if (match) {
        linked++;
        match.inImageGen = true;
        for (const [k, v] of Object.entries(extra)) if (v && !match[k]) match[k] = v;
      } else {
        const key = `gen:${g.fileIds[0] || g.genId}`;
        items.set(key, {
          key, libraryFileId: g.libIds[0] || null, fileId: g.fileIds[0] || null, allFileIds: g.fileIds,
          name: g.title || '', size: 0, mime: '', url: '', thumbUrl: '',
          signal: null, signalEvidence: '', fromLibrary: false, inImageGen: true, ...extra,
        });
      }
    }
    return { items: [...items.values()], linked, genCount: seenGen.size || genItems.length };
  }

  // ------------------------------------------------------ classification ----

  /**
   * Decide upload vs generation for every item.
   *
   * The strongest evidence is membership in the generated-images history.
   * Absence from it only proves "upload" if the history was read to the end
   * and most of it could be matched to Library entries; otherwise a broken
   * id match would make generations look like uploads, which is exactly the
   * mistake a bulk "delete all references" must never make.
   */
  function classify(items, ctx) {
    const { genComplete = false, genCount = 0, linked = 0 } = ctx || {};
    const linkRate = genCount ? linked / genCount : 0;
    const trustAbsence = genComplete && genCount > 0 && linked > 0 && linkRate >= 0.8;
    for (const it of items) {
      if (it.inImageGen) {
        Object.assign(it, { kind: 'generation', confidence: 'high', reason: 'in your generated-images history' });
      } else if (it.signal === 'generation') {
        Object.assign(it, { kind: 'generation', confidence: 'medium', reason: `marked as generated (${it.signalEvidence})` });
      } else if (trustAbsence) {
        Object.assign(it, { kind: 'upload', confidence: 'high', reason: 'not in your generated-images history' });
      } else if (it.signal === 'upload') {
        Object.assign(it, { kind: 'upload', confidence: 'medium', reason: `marked as uploaded (${it.signalEvidence})` });
      } else if (genCount > 0 && linked > 0) {
        Object.assign(it, { kind: 'upload', confidence: 'low', reason: 'not matched to a generation, but matching was incomplete' });
      } else {
        Object.assign(it, { kind: 'unknown', confidence: 'low', reason: 'no evidence either way' });
      }
      it.image = isImage(it);
    }
    return { linkRate, trustAbsence };
  }

  function summarize(items) {
    const s = {
      total: { n: 0, bytes: 0 }, upload: { n: 0, bytes: 0 }, generation: { n: 0, bytes: 0 },
      unknown: { n: 0, bytes: 0 }, unsized: 0,
    };
    for (const it of items) {
      s.total.n++; s.total.bytes += it.size || 0;
      const b = s[it.kind] || s.unknown;
      b.n++; b.bytes += it.size || 0;
      if (!it.size) s.unsized++;
    }
    return s;
  }

  // ----------------------------------------------------------- duplicates ----

  /**
   * Groups of identical files: same name and same byte size. A group is "confident" unless the name is
   * generic like image.png, where equal sizes can be a coincidence; those
   * groups need a content check (sha256) before anything is removed.
   */
  function copyGroups(items) {
    const groups = new Map();
    for (const it of items) {
      if (!it.name || !it.size) continue;
      // Not dimensions: only the generated-images history reports them, so a
      // re-uploaded copy of a generation would never match its original.
      const k = `${it.name.toLowerCase()}|${it.size}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const out = [];
    for (const [sig, list] of groups) {
      if (list.length < 2) continue;
      // Two different generations never share bytes by design, so equal
      // name+size between generations is more likely coincidence than a copy.
      const gens = list.filter(i => i.kind === 'generation').length;
      const doubtful = isGenericName(list[0].name) || gens > 1;
      if (doubtful) {
        // Split by content hash when hashes are known; unhashed ones stay unconfirmed.
        const byHash = new Map();
        const unhashed = [];
        for (const it of list) {
          if (it.sha256) { if (!byHash.has(it.sha256)) byHash.set(it.sha256, []); byHash.get(it.sha256).push(it); } else unhashed.push(it);
        }
        for (const [h, l] of byHash) if (l.length > 1) out.push(makeGroup(`${sig}|${h}`, l, true, 'same content (sha256)'));
        if (unhashed.length > 1) {
          out.push(makeGroup(sig, unhashed, false, gens > 1 ? 'same name and size, but several are generations; needs a content check' : 'same generic name and size; needs a content check'));
        }
      } else {
        out.push(makeGroup(sig, list, true, 'same file name and byte size'));
      }
    }
    return out.sort((a, b) => b.wasteBytes - a.wasteBytes);
  }

  function makeGroup(sig, list, confident, basis) {
    const sorted = [...list].sort((a, b) => (b.created || 0) - (a.created || 0));
    return {
      sig, confident, basis, items: sorted, name: sorted[0].name, size: sorted[0].size,
      kinds: [...new Set(sorted.map(i => i.kind))],
      wasteBytes: sorted[0].size * (sorted.length - 1),
    };
  }

  /**
   * Keys to remove so that one copy per confident group is left. The kept
   * copy is the generation if the group has one, else the oldest copy: a
   * re-uploaded generation is always younger than the original.
   */
  function planExtraCopies(groups, { keep = 'oldest' } = {}) {
    const keys = [];
    for (const g of groups) {
      if (!g.confident) continue;
      const ordered = keep === 'oldest' ? [...g.items].reverse() : g.items;
      const keeper = ordered.find(i => i.kind === 'generation') || ordered[0];
      for (const it of g.items) if (it !== keeper) keys.push(it.key);
    }
    return keys;
  }

  /** Keys of all uploaded images (your references). Documents are never included. */
  function planAllReferences(items, { allowUncertain = false } = {}) {
    return items
      .filter(it => it.kind === 'upload' && it.image && it.fromLibrary && (it.confidence === 'high' || allowUncertain))
      .map(it => it.key);
  }

  // --------------------------------------------------------------- series ----

  /** Generations grouped by conversation, oldest first: a version history. */
  function buildSeries(items) {
    const map = new Map();
    for (const it of items) {
      if (it.kind !== 'generation') continue;
      const id = it.conversationId || '(no conversation)';
      if (!map.has(id)) map.set(id, { id, title: '', items: [], bytes: 0 });
      const s = map.get(id);
      s.items.push(it);
      s.bytes += it.size || 0;
      if (!s.title && it.title) s.title = it.title;
    }
    for (const s of map.values()) s.items.sort((a, b) => (a.created || 0) - (b.created || 0));
    return [...map.values()].sort((a, b) => b.items.length - a.items.length || b.bytes - a.bytes);
  }

  // -------------------------------------------------- perceptual hashing ----

  function toGray(rgba, w, h) {
    const g = new Float64Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      const a = rgba[p + 3] / 255;
      // Composite on white so transparent areas do not read as black.
      const r = rgba[p] * a + 255 * (1 - a), gg = rgba[p + 1] * a + 255 * (1 - a), b = rgba[p + 2] * a + 255 * (1 - a);
      g[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
    }
    return g;
  }

  /** Area-average resize of a grayscale buffer. */
  function boxDownsample(src, w, h, tw, th) {
    const out = new Float64Array(tw * th);
    for (let ty = 0; ty < th; ty++) {
      const y0 = Math.floor(ty * h / th), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * h / th));
      for (let tx = 0; tx < tw; tx++) {
        const x0 = Math.floor(tx * w / tw), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * w / tw));
        let sum = 0, n = 0;
        for (let y = y0; y < y1 && y < h; y++) for (let x = x0; x < x1 && x < w; x++) { sum += src[y * w + x]; n++; }
        out[ty * tw + tx] = n ? sum / n : 0;
      }
    }
    return out;
  }

  /**
   * 64-bit difference hash (dHash): shrink to 9x8, compare each pixel with its
   * right neighbour. Robust to re-encoding and resizing; small edits flip
   * few bits. Returned as 16 hex chars.
   */
  function dhash(gray, w, h) {
    const s = boxDownsample(gray, w, h, 9, 8);
    let hex = '';
    for (let y = 0; y < 8; y++) {
      let byte = 0;
      for (let x = 0; x < 8; x++) byte = (byte << 1) | (s[y * 9 + x] > s[y * 9 + x + 1] ? 1 : 0);
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
  }

  function hamming(a, b) {
    let d = 0;
    for (let i = 0; i < 16; i += 8) {
      let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
      while (x) { x &= x - 1; d++; }
    }
    return d;
  }

  /**
   * Near-duplicate groups: entries whose hashes differ by <= threshold bits,
   * compared only within the same scope (e.g. conversation). Union-find, so
   * A~B and B~C land in one group.
   */
  function lookalikeGroups(entries, threshold = 4) {
    const hi = new Uint32Array(entries.length), lo = new Uint32Array(entries.length);
    entries.forEach((e, i) => { hi[i] = parseInt(e.hash.slice(0, 8), 16) >>> 0; lo[i] = parseInt(e.hash.slice(8, 16), 16) >>> 0; });
    const pop = x => { let d = 0; while (x) { x &= x - 1; d++; } return d; };
    const parent = entries.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const byScope = new Map();
    entries.forEach((e, i) => { const s = e.scope ?? ''; if (!byScope.has(s)) byScope.set(s, []); byScope.get(s).push(i); });
    for (const idx of byScope.values()) {
      for (let a = 0; a < idx.length; a++) {
        const i = idx[a];
        for (let b = a + 1; b < idx.length; b++) {
          const j = idx[b];
          if (pop((hi[i] ^ hi[j]) >>> 0) + pop((lo[i] ^ lo[j]) >>> 0) <= threshold) parent[find(i)] = find(j);
        }
      }
    }
    const groups = new Map();
    entries.forEach((e, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(e.key);
    });
    return [...groups.values()].filter(g => g.length > 1).sort((a, b) => b.length - a.length);
  }

  // ------------------------------------------- learning request templates ----

  const PLACEHOLDER = { lib: '{{libraryFileId}}', file: '{{fileId}}', name: '{{fileName}}' };
  const NAME_PARAM_RE = /^(file_?name|filename|name)$/i;

  function templString(s) {
    return s.replace(new RegExp(LIB_ID_SRC, 'g'), PLACEHOLDER.lib).replace(new RegExp(FILE_ID_SRC, 'g'), PLACEHOLDER.file);
  }
  const hasPlaceholder = s => typeof s === 'string' && s.includes('{{');

  /**
   * Turn one observed request (e.g. ChatGPT deleting a single file after
   * you clicked its delete button) into a reusable template by replacing the
   * ids in it with placeholders. Returns null if nothing id-like was found.
   */
  function templatize(req) {
    const u = new URL(req.url, 'https://placeholder.invalid');
    const path = u.pathname.split('/').map(seg => templString(decodeURIComponent(seg))).map(seg => (hasPlaceholder(seg) ? seg : encodeURIComponent(seg))).join('/');
    const params = [];
    for (const [k, v] of u.searchParams) {
      params.push([k, NAME_PARAM_RE.test(k) ? PLACEHOLDER.name : templString(v)]);
    }
    let body = null, batchPath = null;
    if (req.body != null && req.body !== '') {
      let parsed;
      try { parsed = JSON.parse(req.body); } catch { parsed = undefined; }
      if (parsed === undefined) {
        body = { raw: templString(String(req.body)) };
      } else {
        const t = (node, key) => {
          if (typeof node === 'string') return key && NAME_PARAM_RE.test(key) ? PLACEHOLDER.name : templString(node);
          if (Array.isArray(node)) return node.map(n => t(n));
          if (isObj(node)) { const o = {}; for (const [k, v] of Object.entries(node)) o[k] = t(v, k); return o; }
          return node;
        };
        const json = t(parsed);
        // A list of per-file entries means the endpoint accepts batches.
        const findBatch = (node, trail) => {
          if (Array.isArray(node)) {
            if (node.length && JSON.stringify(node[0]).includes('{{')) return trail;
            return null;
          }
          if (isObj(node)) for (const [k, v] of Object.entries(node)) { const f = findBatch(v, [...trail, k]); if (f) return f; }
          return null;
        };
        batchPath = findBatch(json, []);
        if (batchPath) {
          let arr = json; for (const k of batchPath) arr = arr[k];
          arr.splice(1); // keep one element as the per-item template
        }
        body = { json };
      }
    }
    const tpl = {
      method: String(req.method || 'GET').toUpperCase(),
      origin: u.origin === 'https://placeholder.invalid' ? '' : u.origin,
      path, params, body, batchPath,
    };
    const text = JSON.stringify([path, params, body]);
    if (!/\{\{(libraryFileId|fileId)\}\}/.test(text)) return null;
    tpl.needs = ['libraryFileId', 'fileId', 'fileName'].filter(k => text.includes(`{{${k}}}`));
    return tpl;
  }

  function fillString(s, item, enc) {
    return s.replace(/\{\{(libraryFileId|fileId|fileName)\}\}/g, (_, k) => {
      const v = item[k === 'fileName' ? 'name' : k];
      if (v == null || v === '') throw new Error(`missing ${k}`);
      return enc ? encodeURIComponent(v) : String(v);
    });
  }

  function fillJson(node, item) {
    if (typeof node === 'string') return hasPlaceholder(node) ? fillString(node, item, false) : node;
    if (Array.isArray(node)) return node.map(n => fillJson(n, item));
    if (isObj(node)) { const o = {}; for (const [k, v] of Object.entries(node)) o[k] = fillJson(v, item); return o; }
    return node;
  }

  /**
   * Concrete request(s) for deleting `items` with a learned template.
   * Batch templates produce one request per chunk, others one per item.
   * Throws if an item lacks an id the template needs.
   */
  function buildRequests(tpl, items, batchSize = 20) {
    const one = (item, bodyJson) => {
      const path = fillString(tpl.path, item, true);
      const qs = tpl.params.map(([k, v]) => `${encodeURIComponent(k)}=${hasPlaceholder(v) ? fillString(v, item, true) : encodeURIComponent(v)}`).join('&');
      return { method: tpl.method, url: `${tpl.origin}${path}${qs ? `?${qs}` : ''}`, body: bodyJson };
    };
    const reqs = [];
    if (tpl.batchPath && tpl.body?.json) {
      for (let i = 0; i < items.length; i += batchSize) {
        const chunk = items.slice(i, i + batchSize);
        const json = JSON.parse(JSON.stringify(tpl.body.json));
        let parent = json; for (const k of tpl.batchPath.slice(0, -1)) parent = parent[k];
        const last = tpl.batchPath[tpl.batchPath.length - 1];
        const elementTpl = parent[last][0];
        parent[last] = chunk.map(it => fillJson(elementTpl, it));
        // Anything outside the array that is per-item (rare) is filled from the first item.
        reqs.push({ ...one(chunk[0], JSON.stringify(fillJson(json, chunk[0]))), items: chunk });
      }
    } else {
      for (const it of items) {
        const body = tpl.body?.json !== undefined ? JSON.stringify(fillJson(tpl.body.json, it))
          : tpl.body?.raw !== undefined ? fillString(tpl.body.raw, it, false) : undefined;
        reqs.push({ ...one(it, body), items: [it] });
      }
    }
    return reqs;
  }

  /** Can this template delete this item (are the ids it needs present)? */
  const templateFits = (tpl, it) => tpl.needs.every(k => (k === 'fileName' ? it.name : it[k]));

  // ---------------------------------------------------------- pagination ----

  const CURSOR_KEYS = ['next_cursor', 'nextCursor', 'next_page_token', 'nextPageToken', 'next_token', 'nextToken', 'continuation_token', 'continuationToken', 'cursor', 'after', 'last_id'];
  const MORE_KEYS = ['has_more', 'hasMore', 'has_next', 'hasNext', 'has_next_page'];

  function readPageInfo(json) {
    const info = { cursor: null, cursorKey: null, hasMore: null, total: null };
    const scan = node => {
      if (!isObj(node)) return;
      for (const k of CURSOR_KEYS) {
        if (info.cursor == null && (typeof node[k] === 'string' || typeof node[k] === 'number') && String(node[k]) !== '') {
          info.cursor = String(node[k]); info.cursorKey = k;
        }
      }
      for (const k of MORE_KEYS) if (info.hasMore == null && typeof node[k] === 'boolean') info.hasMore = node[k];
      for (const k of ['total', 'total_count', 'totalCount', 'count']) if (info.total == null && typeof node[k] === 'number') info.total = node[k];
    };
    scan(json);
    if (isObj(json)) for (const v of Object.values(json)) if (isObj(v)) scan(v);
    return info;
  }

  const CURSOR_PARAMS = ['cursor', 'after', 'page_token', 'pageToken', 'next_cursor', 'starting_after', 'continuation_token', 'token'];

  /** Request parameter names worth trying for sending a cursor back. */
  function cursorParamCandidates(req, cursorKey, learned) {
    const out = [];
    const add = p => { if (p && !out.includes(p)) out.push(p); };
    add(learned);
    const u = new URL(req.url, 'https://placeholder.invalid');
    for (const p of CURSOR_PARAMS) if (u.searchParams.has(p)) add(p);
    if (req.body) { try { const b = JSON.parse(req.body); for (const p of CURSOR_PARAMS) if (isObj(b) && p in b) add(p); } catch { /* not json */ } }
    if (cursorKey) {
      add(cursorKey.replace(/^next_?/i, '').replace(/^Page/, 'page').replace(/^[A-Z]/, c => c.toLowerCase()) || null);
      add(cursorKey);
    }
    CURSOR_PARAMS.forEach(add);
    return out;
  }

  /** The request for the page after `req`, sending `cursor` in `param`. */
  function withCursor(req, param, cursor) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || !req.body) {
      const u = new URL(req.url, 'https://placeholder.invalid');
      u.searchParams.set(param, cursor);
      const url = u.origin === 'https://placeholder.invalid' ? `${u.pathname}${u.search}` : u.href;
      return { ...req, url };
    }
    let b; try { b = JSON.parse(req.body); } catch { return null; }
    if (!isObj(b)) return null;
    b[param] = cursor;
    return { ...req, body: JSON.stringify(b) };
  }

  /**
   * Given the previous page's cursor and the next request the page itself
   * made, find which parameter carried the cursor. A parameter that already
   * had the same value in the previous request (limit=6 when the cursor is
   * "6") is not it.
   */
  function learnCursorParam(cursor, nextReq, prevReq) {
    if (cursor == null) return null;
    const want = String(cursor);
    const params = r => {
      const out = new Map();
      if (!r) return out;
      for (const [k, v] of new URL(r.url, 'https://placeholder.invalid').searchParams) out.set(k, v);
      if (r.body) { try { const b = JSON.parse(r.body); if (isObj(b)) for (const [k, v] of Object.entries(b)) if (v != null && typeof v !== 'object') out.set(k, String(v)); } catch { /* not json */ } }
      return out;
    };
    const prev = params(prevReq);
    const hits = [...params(nextReq)].filter(([k, v]) => v === want && prev.get(k) !== want).map(([k]) => k);
    return hits.find(k => CURSOR_PARAMS.includes(k)) || hits[0] || null;
  }

  /** Remove cursor-ish params so a learned request starts at page one. */
  function firstPageOf(req) {
    const u = new URL(req.url, 'https://placeholder.invalid');
    for (const p of CURSOR_PARAMS) u.searchParams.delete(p);
    let body = req.body;
    if (body) {
      try {
        const b = JSON.parse(body);
        if (isObj(b)) { for (const p of CURSOR_PARAMS) if (p in b) b[p] = null; body = JSON.stringify(b); }
      } catch { /* keep */ }
    }
    const url = u.origin === 'https://placeholder.invalid' ? `${u.pathname}${u.search}` : u.href;
    return { ...req, url, body };
  }

  // ---------------------------------------------------------- diagnostics ----

  /** Structure of a JSON value with the data stripped, for bug reports. */
  function shapeOf(node, depth = 0) {
    if (depth > 6) return '…';
    if (node == null) return null;
    if (Array.isArray(node)) return node.length ? [shapeOf(node[0], depth + 1), `(${node.length} items)`] : [];
    if (isObj(node)) { const o = {}; for (const [k, v] of Object.entries(node)) o[k] = shapeOf(v, depth + 1); return o; }
    if (typeof node === 'string') {
      if (isLibId(node)) return 'libfile_…';
      if (isFileId(node)) return 'file_…';
      if (looksLikeUrl(node)) return 'url';
      if (looksLikeMime(node)) return node;
      if (toMillis(node) != null && /\d{4}-\d{2}-\d{2}/.test(node)) return 'date-string';
      return `string(${node.length})`;
    }
    return typeof node;
  }

  return {
    isFileId, isLibId, collectIds, pick, toMillis, formatBytes, isGenericName, isImage, CHATGPT_DOWNLOAD_RE,
    kindSignal, normalizeLibraryItem, extractLibraryItems, extractGenItems, mergeInventory, classify, summarize,
    copyGroups, planExtraCopies, planAllReferences, buildSeries,
    toGray, boxDownsample, dhash, hamming, lookalikeGroups,
    templatize, buildRequests, templateFits,
    readPageInfo, cursorParamCandidates, withCursor, learnCursorParam, firstPageOf,
    shapeOf,
  };
})();

if (typeof module === 'object' && module.exports) module.exports = GCCore;
