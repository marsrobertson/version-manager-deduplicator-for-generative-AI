// A fake chatgpt.com for end-to-end tests. It imitates the *reported* shapes
// of ChatGPT's internal endpoints; it is not a copy of the real service.
//
// Modes:
//   known  - the endpoints other open-source tools report (POST /files/library, delete-batch)
//   learn  - those endpoints are gone; only the fake storage page's own requests work,
//            with unusual names (nodes + page_token, DELETE /library/v2/items/:id)
//   nogen  - like known, but the generated-images history is unavailable
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------------ PNG ----

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, pixel, level = 6) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = pixel(x, y);
    const o = y * (w * 4 + 1) + 1 + x * 4;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}
function art(seed, noise = 0, level = 6) {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const cx = 20 + (seed * 37) % 56, cy = 20 + (seed * 53) % 56, rad = 12 + (seed % 5) * 4;
  const hue = [(seed * 67) % 256, (seed * 131) % 256, (seed * 29) % 256];
  return png(96, 96, (x, y) => {
    const inCircle = (x - cx) ** 2 + (y - cy) ** 2 < rad * rad;
    const stripe = Math.floor((x + y * (seed % 3 + 1)) / (8 + seed % 7)) % 2;
    let px = inCircle ? hue : stripe ? [hue[2], hue[0], hue[1]] : [20 + y * 2, 40 + x, 90];
    if (noise) px = px.map(v => Math.max(0, Math.min(255, v + Math.round((rnd() - 0.5) * noise))));
    return px;
  }, level);
}

// ----------------------------------------------------------------- data ----

let fileSeq = 0;
const fid = () => `file_00000000${(++fileSeq).toString(16).padStart(8, '0')}deadbeefcafe1234`;
const lid = f => `libfile_${f.slice(-20)}`;

function buildData() {
  fileSeq = 0;
  const files = [];
  const t0 = Date.UTC(2026, 7, 20) / 1000;
  let t = t0;
  const add = (props, bytes) => {
    const fileId = fid();
    files.push({ fileId, libId: lid(fileId), created: (t += 60), mime: 'image/png', ...props, bytes, size: bytes.length });
  };
  const series = [['conv-aaaa-1111', 'Neon fox poster', 10], ['conv-bbbb-2222', 'Album cover', 6], ['conv-cccc-3333', 'Logo sketch', 4]];
  let seed = 1;
  const firstGen = art(1);
  for (const [conv, title, n] of series) {
    for (let i = 0; i < n; i++) {
      // In the fox series, v5 is a near-identical re-roll of v4.
      const bytes = conv === 'conv-aaaa-1111' && i === 4 ? art(seed - 1, 6) : seed === 1 ? firstGen : art(seed);
      const hh = String(10 + Math.floor(seed / 60)).padStart(2, '0'), mm = String(seed % 60).padStart(2, '0');
      add({ kind: 'generation', conv, title, prompt: `${title}, take ${i + 1}`, name: `ChatGPT Image Sep 1, 2026, ${hh}_${mm}_00 AM.png` }, bytes);
      seed++;
    }
  }
  const mood = art(501), sketch = art(502), face = art(503);
  for (let i = 0; i < 5; i++) add({ kind: 'upload', name: 'moodboard.png' }, mood);
  for (let i = 0; i < 3; i++) add({ kind: 'upload', name: 'sketch.png' }, sketch);
  add({ kind: 'upload', name: 'face-ref.png' }, face);
  // Generation #1 downloaded and uploaded again, twice.
  for (let i = 0; i < 2; i++) add({ kind: 'upload', name: files[0].name }, firstGen);
  // Two different images that happen to share a generic name and byte size.
  add({ kind: 'upload', name: 'image.png' }, art(601, 0, 0));
  add({ kind: 'upload', name: 'image.png' }, art(602, 0, 0));
  add({ kind: 'upload', name: 'notes.pdf', mime: 'application/pdf' }, Buffer.from('%PDF-1.4 fake '.repeat(200)));
  return files;
}

// --------------------------------------------------------------- server ----

const STORAGE_PAGE = `<!doctype html><meta charset="utf-8"><title>Mock storage</title>
<body style="font-family:sans-serif;background:#212121;color:#eee">
<h1>Settings · Storage · Images (mock)</h1>
<ul id="list"></ul><button id="more">Load more</button>
<script>
let token = null, next = null;
async function auth() { if (!token) token = (await (await fetch('/api/auth/session')).json()).accessToken; return { authorization: 'Bearer ' + token, 'oai-device-id': 'dev-123', 'oai-language': 'en-US' }; }
async function load() {
  const url = '/backend-api/files/library/nodes?kind=image&limit=6' + (next ? '&page_token=' + encodeURIComponent(next) : '');
  const j = await (await fetch(url, { headers: await auth() })).json();
  next = j.next_page_token;
  for (const n of j.nodes) {
    const li = document.createElement('li');
    li.textContent = n.file.name + ' ';
    const b = document.createElement('button');
    b.textContent = 'Delete'; b.className = 'del'; b.dataset.id = n.node_id;
    b.onclick = async () => { const r = await fetch('/backend-api/library/v2/items/' + n.node_id, { method: 'DELETE', headers: await auth() }); if (r.ok) li.remove(); };
    li.append(b);
    document.getElementById('list').append(li);
  }
  document.getElementById('more').disabled = !next;
}
document.getElementById('more').onclick = load;
load();
</script>`;

export function startMock({ mode = 'known', port = 0 } = {}) {
  const files = buildData();
  const byFile = () => new Map(files.map(f => [f.fileId, f]));
  const log = [];
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const remove = pred => { for (let i = files.length - 1; i >= 0; i--) if (pred(files[i])) files.splice(i, 1); };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    let body = '';
    for await (const c of req) body += c;
    log.push(`${req.method} ${p}${u.search}`);

    if (p === '/' || p === '/c' || p.startsWith('/c/')) return send(res, 200, '<!doctype html><title>Mock ChatGPT</title><body style="background:#212121;color:#eee;font-family:sans-serif"><h1>Mock ChatGPT</h1><a href="/settings/storage">storage</a></body>', 'text/html');
    if (p === '/settings/storage') return send(res, 200, STORAGE_PAGE, 'text/html');
    if (p === '/api/auth/session') return send(res, 200, { accessToken: 'test-token', user: { id: 'user-1' } });
    if (p === '/__state') return send(res, 200, { files: files.map(({ bytes, ...f }) => f), log });
    if (p.startsWith('/files-cdn/')) {
      const f = byFile().get(p.slice('/files-cdn/'.length));
      return f ? send(res, 200, f.bytes, f.mime) : send(res, 404, { detail: 'gone' });
    }
    if (!p.startsWith('/backend-api/')) return send(res, 404, { detail: 'not found' });
    if (req.headers.authorization !== 'Bearer test-token') return send(res, 401, { detail: 'unauthorized' });

    // Generated-images history.
    if (p === '/backend-api/my/recent/image_gen') {
      if (mode === 'nogen') return send(res, 404, { detail: 'not found' });
      const gens = files.filter(f => f.kind === 'generation').sort((a, b) => b.created - a.created);
      const limit = Math.min(Number(u.searchParams.get('limit')) || 8, 8);
      const start = Number(u.searchParams.get('after') || 0);
      const page = gens.slice(start, start + limit);
      return send(res, 200, {
        items: page.map(f => ({ id: `gen_${f.fileId.slice(13, 21)}`, url: `/backend-api/estuary/content?id=${f.fileId}&sig=s1`, title: f.title, prompt: f.prompt,
          created_at: f.created, width: 96, height: 96, conversation_id: f.conv, message_id: `msg-${f.fileId.slice(13, 21)}` })),
        cursor: start + limit < gens.length ? String(start + limit) : null,
      });
    }
    if (p === '/backend-api/estuary/content') {
      const f = byFile().get(u.searchParams.get('id'));
      return f ? send(res, 200, f.bytes, f.mime) : send(res, 404, { detail: 'gone' });
    }
    let m;
    if ((m = p.match(/^\/backend-api\/files\/download\/([^/]+)$/))) {
      const f = byFile().get(decodeURIComponent(m[1]));
      return f ? send(res, 200, { status: 'success', download_url: `/files-cdn/${f.fileId}` }) : send(res, 404, { detail: 'gone' });
    }

    // A chat message (never to be mistaken for a storage delete).
    if (p === '/backend-api/conversation' && req.method === 'POST') return send(res, 200, { ok: true });

    if (mode === 'learn') {
      if (p === '/backend-api/files/library/nodes') {
        if (u.searchParams.get('kind') !== 'image') return send(res, 400, { detail: 'kind is required' });
        const imgs = files.filter(f => f.mime.startsWith('image/')).sort((a, b) => b.created - a.created);
        const start = Number(u.searchParams.get('page_token') || 0);
        const limit = Math.min(Number(u.searchParams.get('limit')) || 6, 6);
        return send(res, 200, {
          nodes: imgs.slice(start, start + limit).map(f => ({ node_id: f.libId, created_time: new Date(f.created * 1000).toISOString(), file: { id: f.fileId, name: f.name, size_bytes: f.size, content_type: f.mime } })),
          next_page_token: start + limit < imgs.length ? String(start + limit) : null,
        });
      }
      if ((m = p.match(/^\/backend-api\/library\/v2\/items\/([^/]+)$/)) && req.method === 'DELETE') {
        const before = files.length;
        remove(f => f.libId === m[1]);
        return send(res, files.length < before ? 200 : 404, { ok: files.length < before });
      }
      return send(res, 404, { detail: 'not found' });
    }

    // "known" and "nogen" modes.
    if (p === '/backend-api/files/library' && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      const all = [...files].sort((a, b2) => b2.created - a.created);
      const start = Number(b.cursor || 0);
      const limit = Math.min(Number(b.limit) || 7, 7);
      return send(res, 200, {
        items: all.slice(start, start + limit).map(f => ({ id: f.libId, file_id: f.fileId, name: f.name, size: f.size, mime_type: f.mime, created_at: f.created })),
        cursor: start + limit < all.length ? String(start + limit) : null,
      });
    }
    if (p === '/backend-api/files/library/files/delete-batch' && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      const ids = new Set((b.files || []).map(x => `${x.library_file_id}|${x.file_id}`));
      remove(f => ids.has(`${f.libId}|${f.fileId}`));
      return send(res, 200, { success: true });
    }
    return send(res, 404, { detail: 'not found' });
  });

  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({ url, files, log, close: () => new Promise(r => server.close(r)) });
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] || 'known';
  startMock({ mode, port: 8787 }).then(({ url }) => console.log(`mock ChatGPT (${mode}) at ${url}`));
}
