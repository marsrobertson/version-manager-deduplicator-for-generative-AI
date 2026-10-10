const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

const FID = n => `file_00000000${String(n).padStart(4, '0')}abcdef1234567890`;
const LID = n => `libfile_${String(n).padStart(4, '0')}xyz`;

test('ids: file and libfile ids are recognised, look-alike words are not', () => {
  assert.ok(C.isFileId('file-AbC123dEf456GhI789'));
  assert.ok(C.isFileId(FID(1)));
  assert.ok(!C.isFileId('file-service'));
  assert.ok(!C.isFileId('file_name'));
  assert.ok(C.isLibId(LID(1)));
  const ids = C.collectIds({ a: `https://x/estuary/content?id=${FID(7)}&sig=1`, b: [{ c: 'file-service://file-AbC123dEf456GhI789' }], d: `libfile_${'9'.repeat(8)}` });
  assert.deepEqual([...ids.fileIds].sort(), ['file-AbC123dEf456GhI789', FID(7)].sort());
  assert.deepEqual([...ids.libIds], [`libfile_${'9'.repeat(8)}`]);
});

test('toMillis handles seconds, millis and ISO strings, rejects junk', () => {
  const now = Date.UTC(2026, 8, 27);
  assert.equal(C.toMillis(1758931200, now), 1758931200000);
  assert.equal(C.toMillis(1758931200000, now), 1758931200000);
  assert.equal(C.toMillis('2026-09-01T10:00:00Z', now), Date.UTC(2026, 8, 1, 10));
  assert.equal(C.toMillis(42, now), null);
  assert.equal(C.toMillis('soon', now), null);
});

test('normalizeLibraryItem reads nested and flat shapes', () => {
  const flat = C.normalizeLibraryItem({ id: LID(1), file_id: FID(1), name: 'moodboard.png', size: 3_500_000, mime_type: 'image/png', created_at: '2026-09-01T10:00:00Z' });
  assert.equal(flat.key, LID(1));
  assert.equal(flat.fileId, FID(1));
  assert.equal(flat.size, 3_500_000);
  assert.equal(flat.mime, 'image/png');
  const nested = C.normalizeLibraryItem({ node_id: LID(2), file: { id: FID(2), name: 'ref.jpg', size_bytes: '120000', content_type: 'image/jpeg' }, created_time: 1758931200, title: 'My chat' });
  assert.equal(nested.libraryFileId, LID(2));
  assert.equal(nested.fileId, FID(2));
  assert.equal(nested.name, 'ref.jpg');
  assert.equal(nested.size, 120000);
  assert.equal(nested.title, 'My chat');
  // Mentions a file id but is not a file.
  assert.equal(C.normalizeLibraryItem({ id: FID(3), role: 'user' }), null);
});

test('extractLibraryItems walks unknown wrappers but not into a file object', () => {
  const json = { data: { nodes: [
    { node_id: LID(1), file: { id: FID(1), name: 'a.png', size: 10, mime_type: 'image/png' } },
    { node_id: LID(2), file: { id: FID(2), name: 'b.png', size: 20, mime_type: 'image/png' } },
  ] }, next_page_token: 'abc' };
  const items = C.extractLibraryItems(json);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => i.key), [LID(1), LID(2)]);
});

test('kindSignal picks up explicit source fields and ignores conflicts', () => {
  assert.equal(C.kindSignal({ source: 'image_gen' }).kind, 'generation');
  assert.equal(C.kindSignal({ meta: { upload_source: 'user_upload' } }).kind, 'upload');
  assert.equal(C.kindSignal({ is_generated: true }).kind, 'generation');
  assert.equal(C.kindSignal({ source: 'image_gen', origin: 'upload' }).kind, null);
  assert.equal(C.kindSignal({ name: 'generated.png' }).kind, null);
});

function fixture() {
  const lib = [
    // Reference uploaded 3 times: same name + size.
    ...[1, 2, 3].map(n => ({ id: LID(n), file_id: FID(n), name: 'moodboard.png', size: 3_500_000, mime_type: 'image/png', created_at: 1757000000 + n })),
    // Generic names with equal sizes: NOT proof of a copy.
    { id: LID(4), file_id: FID(4), name: 'image.png', size: 777, mime_type: 'image/png', created_at: 1757000010 },
    { id: LID(5), file_id: FID(5), name: 'image.png', size: 777, mime_type: 'image/png', created_at: 1757000011 },
    // Two generations.
    { id: LID(6), file_id: FID(6), name: 'ChatGPT Image Sep 1, 2026, 10_00_00 AM.png', size: 2_000_000, mime_type: 'image/png', created_at: 1757000020 },
    { id: LID(7), file_id: FID(7), name: 'ChatGPT Image Sep 1, 2026, 10_01_00 AM.png', size: 2_100_000, mime_type: 'image/png', created_at: 1757000030 },
    // A generation downloaded and uploaded again: same name+size as generation 6.
    { id: LID(8), file_id: FID(8), name: 'ChatGPT Image Sep 1, 2026, 10_00_00 AM.png', size: 2_000_000, mime_type: 'image/png', created_at: 1757000040 },
  ].map(C.normalizeLibraryItem);
  const gen = C.extractGenItems({ items: [
    { id: 'gen_a', url: `https://chatgpt.com/backend-api/estuary/content?id=${FID(6)}&sig=x`, title: 'Cat astronaut', conversation_id: 'conv-1', created_at: 1757000020, width: 1024, height: 1536 },
    { id: 'gen_b', url: `https://chatgpt.com/backend-api/estuary/content?id=${FID(7)}&sig=y`, title: 'Cat astronaut', conversation_id: 'conv-1', created_at: 1757000030, width: 1024, height: 1536 },
    { id: 'gen_c', url: `https://chatgpt.com/backend-api/estuary/content?id=${FID(99)}&sig=z`, title: 'Old dog', conversation_id: 'conv-2', created_at: 1756000000 },
  ], cursor: null });
  return { lib, gen };
}

test('merge + classify: history membership marks generations, absence marks uploads when trustworthy', () => {
  const { lib, gen } = fixture();
  const m = C.mergeInventory(lib, gen);
  assert.equal(m.linked, 2);
  assert.equal(m.genCount, 3);
  assert.equal(m.items.length, 9); // 8 library + 1 history-only generation
  const cls = C.classify(m.items, { genComplete: true, genCount: m.genCount, linked: m.linked });
  // 2 of 3 generations matched (67%) < 80%: absence is not trusted.
  assert.equal(cls.trustAbsence, false);
  const byKey = new Map(m.items.map(i => [i.key, i]));
  assert.equal(byKey.get(LID(6)).kind, 'generation');
  assert.equal(byKey.get(LID(6)).conversationId, 'conv-1');
  assert.equal(byKey.get(LID(1)).kind, 'upload');
  assert.equal(byKey.get(LID(1)).confidence, 'low');
  assert.deepEqual(C.planAllReferences(m.items), []);
  assert.equal(C.planAllReferences(m.items, { allowUncertain: true }).length, 6);
});

test('classify trusts absence only with a complete, well-matched history', () => {
  const { lib, gen } = fixture();
  const m = C.mergeInventory(lib, gen.slice(0, 2));
  const cls = C.classify(m.items, { genComplete: true, genCount: m.genCount, linked: m.linked });
  assert.equal(cls.trustAbsence, true);
  const refs = C.planAllReferences(m.items);
  assert.equal(refs.length, 6);
  assert.ok(!refs.includes(LID(6)) && !refs.includes(LID(7)));
  // A PDF upload is a reference too, but never part of the bulk image cleanup.
  const pdf = C.normalizeLibraryItem({ id: LID(50), file_id: FID(50), name: 'notes.pdf', size: 5000, mime_type: 'application/pdf' });
  const m4 = C.mergeInventory([...lib, pdf], gen.slice(0, 2));
  C.classify(m4.items, { genComplete: true, genCount: m4.genCount, linked: m4.linked });
  assert.equal(m4.items.find(i => i.key === LID(50)).kind, 'upload');
  assert.ok(!C.planAllReferences(m4.items).includes(LID(50)));
  // Same data, but the history was cut short: never trust absence.
  const m2 = C.mergeInventory(lib, gen.slice(0, 2));
  assert.equal(C.classify(m2.items, { genComplete: false, genCount: m2.genCount, linked: m2.linked }).trustAbsence, false);
  // No history at all: everything unknown.
  const m3 = C.mergeInventory(lib, []);
  C.classify(m3.items, { genComplete: false, genCount: 0, linked: 0 });
  assert.ok(m3.items.every(i => i.kind === 'unknown'));
});

test('copyGroups: distinctive names are confident, generic names need a content check', () => {
  const { lib, gen } = fixture();
  const m = C.mergeInventory(lib, gen.slice(0, 2));
  C.classify(m.items, { genComplete: true, genCount: m.genCount, linked: m.linked });
  const groups = C.copyGroups(m.items);
  const mood = groups.find(g => g.name === 'moodboard.png');
  assert.ok(mood.confident);
  assert.equal(mood.items.length, 3);
  assert.equal(mood.wasteBytes, 7_000_000);
  const generic = groups.find(g => g.name === 'image.png');
  assert.equal(generic.confident, false);
  const reup = groups.find(g => g.name.startsWith('ChatGPT Image Sep 1, 2026, 10_00_00'));
  assert.ok(reup.confident, 'one generation plus its re-upload is a real copy');

  const extras = C.planExtraCopies(groups);
  // moodboard: keep the oldest (LID 1), drop 2 and 3. Re-upload group: keep the generation (LID 6), drop LID 8.
  assert.deepEqual(extras.sort(), [LID(2), LID(3), LID(8)].sort());
  assert.deepEqual(C.planExtraCopies(groups, { keep: 'newest' }).sort(), [LID(1), LID(2), LID(8)].sort());
  // Without the history nobody is known to be a generation: the oldest copy (the original) survives.
  for (const it of m.items) it.kind = 'unknown';
  assert.ok(!C.planExtraCopies(C.copyGroups(m.items)).includes(LID(6)));

  // Content hashes settle the generic group.
  const [a, b] = m.items.filter(i => i.name === 'image.png');
  a.sha256 = 'aa'; b.sha256 = 'bb';
  assert.equal(C.copyGroups(m.items).find(g => g.name === 'image.png'), undefined);
  b.sha256 = 'aa';
  assert.ok(C.copyGroups(m.items).find(g => g.name === 'image.png').confident);
});

test('two generations with equal name and size are not auto-deduplicated', () => {
  const mk = n => ({ key: `k${n}`, name: 'Cat.png', size: 100, kind: 'generation', fromLibrary: true, created: n });
  const groups = C.copyGroups([mk(1), mk(2)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].confident, false);
  assert.deepEqual(C.planExtraCopies(groups), []);
});

test('buildSeries groups generations per chat, oldest first', () => {
  const { lib, gen } = fixture();
  const m = C.mergeInventory(lib, gen);
  C.classify(m.items, { genComplete: true, genCount: m.genCount, linked: m.linked });
  const series = C.buildSeries(m.items);
  assert.equal(series[0].id, 'conv-1');
  assert.deepEqual(series[0].items.map(i => i.key), [LID(6), LID(7)]);
  assert.equal(series[0].title, 'Cat astronaut');
});

test('dhash is stable under brightness change and differs for different images', () => {
  const W = 32, H = 32;
  const img = f => { const g = new Float64Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = f(x, y); return g; };
  const a = C.dhash(img((x, y) => (x * 7 + y * 3) % 256), W, H);
  const brighter = C.dhash(img((x, y) => Math.min(255, ((x * 7 + y * 3) % 256) * 0.9 + 20)), W, H);
  const other = C.dhash(img((x, y) => ((W - x) * 11 + (y % 5) * 40) % 256), W, H);
  assert.equal(a.length, 16);
  assert.ok(C.hamming(a, brighter) <= 2, `brightness changed the hash by ${C.hamming(a, brighter)}`);
  assert.ok(C.hamming(a, other) > 10);
  assert.equal(C.hamming('ffffffffffffffff', '0000000000000000'), 64);
});

test('toGray composites transparency on white', () => {
  const rgba = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]);
  const g = C.toGray(rgba, 2, 1);
  assert.equal(Math.round(g[0]), 255);
  assert.equal(Math.round(g[1]), 0);
});

test('lookalikeGroups clusters within scope only', () => {
  const e = [
    { key: 'a', hash: '0000000000000000', scope: 'c1' },
    { key: 'b', hash: '0000000000000003', scope: 'c1' },
    { key: 'c', hash: '0000000000000001', scope: 'c2' },
    { key: 'd', hash: 'ffffffffffffffff', scope: 'c1' },
  ];
  assert.deepEqual(C.lookalikeGroups(e, 4), [['a', 'b']]);
  assert.deepEqual(C.lookalikeGroups(e.map(x => ({ ...x, scope: '' })), 4)[0].sort(), ['a', 'b', 'c']);
});

test('templatize + buildRequests: single-item delete with ids in path and query', () => {
  const tpl = C.templatize({
    method: 'POST',
    url: `https://chatgpt.com/backend-api/files/library/files/${LID(1)}/delete_stream?file_id=${FID(1)}&file_name=moodboard.png&soft_delete=true`,
    body: null,
  });
  assert.equal(tpl.path, '/backend-api/files/library/files/{{libraryFileId}}/delete_stream');
  assert.deepEqual(tpl.needs.sort(), ['fileId', 'fileName', 'libraryFileId']);
  const item = { libraryFileId: LID(9), fileId: FID(9), name: 'my ref (1).png' };
  const [req] = C.buildRequests(tpl, [item]);
  assert.equal(req.url, `https://chatgpt.com/backend-api/files/library/files/${LID(9)}/delete_stream?file_id=${FID(9)}&file_name=my%20ref%20(1).png&soft_delete=true`);
  assert.equal(req.method, 'POST');
  assert.ok(!C.templateFits(tpl, { libraryFileId: LID(1), fileId: FID(1) }), 'needs a name');
});

test('templatize + buildRequests: batch body becomes chunks', () => {
  const tpl = C.templatize({
    method: 'POST', url: 'https://chatgpt.com/backend-api/files/library/files/delete-batch',
    body: JSON.stringify({ files: [{ library_file_id: LID(1), file_id: FID(1) }, { library_file_id: LID(2), file_id: FID(2) }] }),
  });
  assert.deepEqual(tpl.batchPath, ['files']);
  const items = Array.from({ length: 5 }, (_, i) => ({ libraryFileId: LID(10 + i), fileId: FID(10 + i), name: 'x.png' }));
  const reqs = C.buildRequests(tpl, items, 2);
  assert.equal(reqs.length, 3);
  assert.deepEqual(JSON.parse(reqs[0].body), { files: [{ library_file_id: LID(10), file_id: FID(10) }, { library_file_id: LID(11), file_id: FID(11) }] });
  assert.equal(JSON.parse(reqs[2].body).files.length, 1);
});

test('templatize: DELETE by file id, and requests without ids are rejected', () => {
  const tpl = C.templatize({ method: 'DELETE', url: `/backend-api/files/${FID(1)}`, body: null });
  assert.equal(C.buildRequests(tpl, [{ fileId: FID(5) }])[0].url, `/backend-api/files/${FID(5)}`);
  assert.equal(C.templatize({ method: 'PATCH', url: '/backend-api/conversation/6f1c9d9e-1111-2222-3333-444455556666', body: '{"is_visible":false}' }), null);
});

test('pagination helpers: read cursor, guess and learn the parameter', () => {
  const info = C.readPageInfo({ items: [], next_page_token: 'tok2', has_more: true });
  assert.equal(info.cursor, 'tok2');
  assert.equal(info.cursorKey, 'next_page_token');
  assert.equal(info.hasMore, true);
  const req = { method: 'GET', url: '/backend-api/files/library/nodes?kind=image&limit=5' };
  const cands = C.cursorParamCandidates(req, 'next_page_token', null);
  assert.equal(cands[0], 'page_token');
  assert.equal(C.withCursor(req, 'page_token', 'tok2').url, '/backend-api/files/library/nodes?kind=image&limit=5&page_token=tok2');
  const post = { method: 'POST', url: '/backend-api/files/library', body: JSON.stringify({ limit: 100, cursor: null }) };
  assert.deepEqual(JSON.parse(C.withCursor(post, 'cursor', 'c2').body), { limit: 100, cursor: 'c2' });
  assert.equal(C.learnCursorParam('tok2', { url: '/x?kind=image&page_token=tok2' }), 'page_token');
  // Offset-style cursors can equal the page size; the unchanged limit is not the cursor.
  assert.equal(C.learnCursorParam('6', { url: '/x?kind=image&limit=6&page_token=6' }, { url: '/x?kind=image&limit=6' }), 'page_token');
  assert.equal(C.learnCursorParam('6', { url: '/x?limit=6&offset=6' }, { url: '/x?limit=6' }), 'offset');
  assert.equal(C.firstPageOf({ method: 'GET', url: '/x?kind=image&after=zz' }).url, '/x?kind=image');
  assert.equal(C.cursorParamCandidates(post, 'cursor', null)[0], 'cursor');
});

test('shapeOf strips data', () => {
  const s = C.shapeOf({ id: LID(1), file: { id: FID(1), name: 'secret-plan.png', size: 5, url: 'https://x/y' }, items: [1, 2, 3] });
  assert.deepEqual(s, { id: 'libfile_…', file: { id: 'file_…', name: 'string(15)', size: 'number', url: 'url' }, items: ['number', '(3 items)'] });
});

test('formatBytes', () => {
  assert.equal(C.formatBytes(0), '0 B');
  assert.equal(C.formatBytes(3_500_000), '3.5 MB');
  assert.equal(C.formatBytes(20_000_000_000), '20.0 GB');
});

test('a history much bigger than storage still proves uploads once matching clearly works', () => {
  // Real account shape: 23k generations in history, only 5k of them in storage, 2.3k uploads.
  const lib = [], gen = [];
  for (let i = 0; i < 50; i++) lib.push(C.normalizeLibraryItem({ id: LID(i), file_id: FID(i), name: `g${i}.png`, size: 100 + i, mime_type: 'image/png' }));
  for (let i = 50; i < 60; i++) lib.push(C.normalizeLibraryItem({ id: LID(i), file_id: FID(i), name: `paste${i}.png`, size: 100 + i, mime_type: 'image/png' }));
  for (let i = 0; i < 230; i++) gen.push({ id: `g${i}`, url: `/backend-api/estuary/content?id=${FID(i < 50 ? i : 1000 + i)}` });
  const m = C.mergeInventory(lib, C.extractGenItems({ items: gen }));
  const cls = C.classify(m.items, { genComplete: true, genCount: m.genCount, linked: m.linked });
  assert.ok(cls.linkRate < 0.3);
  assert.equal(cls.trustAbsence, true);
  assert.equal(C.planAllReferences(m.items).length, 10);
  assert.equal(C.summarize(m.items).historyOnly, 180);
  assert.equal(C.summarize(m.items).total.n, 60);
});
