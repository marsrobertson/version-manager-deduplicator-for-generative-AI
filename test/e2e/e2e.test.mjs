// End-to-end: the built userscript in real Chromium against the mock ChatGPT.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startMock } from './mock-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(here, '../../dist/gencull.user.js'), 'utf8');
const SHOTS = join(here, '../../test-results');
const executablePath = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', (() => { try { return chromium.executablePath(); } catch { return null; } })()]
  .find(p => p && existsSync(p));

let browser;
before(async () => { browser = await chromium.launch({ executablePath }); mkdirSync(SHOTS, { recursive: true }); });
after(async () => { await browser?.close(); });

async function setup(mode) {
  const mock = await startMock({ mode });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  await context.addInitScript({ content: SCRIPT });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const state = async () => (await (await fetch(`${mock.url}/__state`)).json());
  return { mock, context, page, errors, state, done: async () => { await context.close(); await mock.close(); } };
}

const tid = (page, id) => page.getByTestId(id);
async function manual(page) { if (!(await tid(page, 'gc-queue-extras').isVisible())) await tid(page, 'gc-manual').click(); }
const tileNum = async (page, id) => Number((await tid(page, id).locator('.tnum').textContent()).replace(/\D/g, ''));
async function scan(page) {
  await tid(page, 'gc-scan').click();
  await page.waitForFunction(() => /Scanned \d+ items/.test(document.querySelector('#gencull-host')?.shadowRoot?.querySelector('[data-testid=gc-status]')?.textContent || ''), null, { timeout: 30000 });
}
async function deleteQueued(page, expectCount) {
  await tid(page, 'gc-delete-open').click();
  await tid(page, 'gc-del-confirm').fill('delete');
  await tid(page, 'gc-del-go').click();
  if (expectCount > 1) {
    await tid(page, 'gc-del-continue').click({ timeout: 20000 });
  }
  await page.waitForFunction(n => new RegExp(`Deleted ${n} files`).test(document.querySelector('#gencull-host').shadowRoot.querySelector('[data-testid=gc-del-result]')?.textContent || ''), expectCount, { timeout: 30000 });
}

test('known endpoints: scan, classify, dry run, delete references, cull a series', async () => {
  const t = await setup('known');
  const { page } = t;
  try {
    await page.goto(t.mock.url);
    await tid(page, 'gc-launcher').click();
    await scan(page);

    assert.equal(await tileNum(page, 'gc-tile-total'), 34);
    assert.equal(await tileNum(page, 'gc-tile-upload'), 14); // 13 images + 1 pdf
    assert.equal(await tileNum(page, 'gc-tile-generation'), 20);
    assert.equal(await tileNum(page, 'gc-tile-extras'), 8); // moodboard 4 + sketch 2 + 2 re-uploads of a generation
    await page.screenshot({ path: join(SHOTS, 'overview.png') });

    // Dry run: nothing is sent.
    await manual(page);
    await tid(page, 'gc-queue-extras').click();
    await assert.doesNotReject(tid(page, 'gc-queue-summary').filter({ hasText: 'Queued for deletion: 8 files' }).waitFor());
    await tid(page, 'gc-delete-open').click();
    await tid(page, 'gc-del-go').click();
    await tid(page, 'gc-del-result').filter({ hasText: 'Simulation: 8 files would be deleted' }).waitFor();
    assert.ok(!(await t.state()).log.some(l => l.includes('delete')), 'dry run sent a delete');
    await page.screenshot({ path: join(SHOTS, 'dry-run.png') });
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // For real: all uploaded reference images (the PDF must survive).
    await tid(page, 'gc-dryrun').uncheck();
    await tid(page, 'gc-tab-overview').click();
    await manual(page);
    await tid(page, 'gc-queue-refs').click();
    await tid(page, 'gc-queue-summary').filter({ hasText: 'Queued for deletion: 13 files' }).waitFor();
    const download = page.waitForEvent('download');
    await deleteQueued(page, 13);
    assert.match((await download).suggestedFilename(), /^gencull-deleted-.*\.json$/);
    let s = await t.state();
    assert.equal(s.files.length, 21);
    assert.ok(s.files.every(f => f.kind === 'generation' || f.name === 'notes.pdf'));
    assert.ok(s.log.some(l => l.startsWith('POST /backend-api/files/library/files/delete-batch')));
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // Look-alikes: v4 and v5 of the fox poster are near-identical.
    await tid(page, 'gc-tab-lookalikes').click();
    await tid(page, 'gc-fingerprint').click();
    await tid(page, 'gc-lookalike-group').first().waitFor({ timeout: 30000 });
    assert.ok(await tid(page, 'gc-lookalike-group').count() >= 1);
    await page.screenshot({ path: join(SHOTS, 'lookalikes.png') });

    // Cull the biggest series: star one keeper, reject the rest.
    await tid(page, 'gc-tab-series').click();
    await tid(page, 'gc-series-row').first().click();
    const tiles = tid(page, 'gc-gen-tile');
    assert.equal(await tiles.count(), 10);
    await tiles.nth(0).getByTestId('gc-reject').click();
    await tiles.nth(0).click({ modifiers: ['Shift'] }); // anchor for the range
    await tiles.nth(2).click({ modifiers: ['Shift'] });
    await tid(page, 'gc-queue-summary').filter({ hasText: 'Queued for deletion: 3 files' }).waitFor();
    await tiles.nth(9).locator('.star').click();
    await tid(page, 'gc-reject-unstarred').click();
    await tid(page, 'gc-queue-summary').filter({ hasText: 'Queued for deletion: 9 files' }).waitFor();
    await page.waitForFunction(() => [...document.querySelector('#gencull-host').shadowRoot.querySelectorAll('.gtile canvas')].filter(c => c.__state === 'done').length >= 8, null, { timeout: 20000 });
    await page.screenshot({ path: join(SHOTS, 'series.png') });
    await deleteQueued(page, 9);
    s = await t.state();
    assert.equal(s.files.filter(f => f.conv === 'conv-aaaa-1111').length, 1);
    assert.equal(s.files.length, 12);
    assert.deepEqual(t.errors, []);
  } finally { await t.done(); }
});

test('learn mode: GenCull learns the listing and the delete from the storage page itself', async () => {
  const t = await setup('learn');
  const { page } = t;
  try {
    await page.goto(`${t.mock.url}/settings/storage`);
    await page.locator('#list li').nth(5).waitFor();
    await page.locator('#more').click();
    await page.locator('#list li').nth(11).waitFor();
    // A chat message that says "delete" and carries an attachment must not be learned.
    const someFile = (await t.state()).files[0];
    await page.evaluate(async fileId => {
      const { accessToken } = await (await fetch('/api/auth/session')).json();
      await fetch('/backend-api/conversation', { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'next', messages: [{ content: { parts: ['please delete the background'] }, metadata: { attachments: [{ id: fileId, name: 'ref.png' }] } }] }) });
    }, someFile.fileId);
    await page.locator('#list .del').first().click(); // one manual delete, like a user would
    await page.waitForFunction(() => document.querySelectorAll('#list li').length === 11);
    const learned = await page.evaluate(() => JSON.parse(localStorage.getItem('gencull:learned:v1')));
    assert.equal(learned.deletes.length, 1);
    assert.equal(learned.deletes[0].method, 'DELETE');
    assert.equal(JSON.stringify(learned).includes('test-token'), false, 'login token was persisted');

    await tid(page, 'gc-launcher').click();
    await tid(page, 'gc-tab-setup').click();
    await tid(page, 'gc-setup-list').filter({ hasText: 'page_token' }).waitFor();
    assert.match(await tid(page, 'gc-setup-list').textContent(), /GET \/backend-api\/files\/library\/nodes/);
    assert.match(await tid(page, 'gc-setup-delete').textContent(), /DELETE \/backend-api\/library\/v2\/items\/\{\{libraryFileId\}\}/);

    await scan(page);
    await tid(page, 'gc-tab-overview').click();
    assert.equal(await tileNum(page, 'gc-tile-total'), 32);
    assert.equal(await tileNum(page, 'gc-tile-generation'), 20);
    assert.equal(await tileNum(page, 'gc-tile-extras'), 8);

    await tid(page, 'gc-dryrun').uncheck();
    await manual(page);
    await tid(page, 'gc-queue-extras').click();
    await deleteQueued(page, 8);
    const s = await t.state();
    assert.equal(s.files.length, 34 - 1 - 8);
    assert.equal(s.log.filter(l => l.startsWith('DELETE /backend-api/library/v2/items/')).length, 9);
    assert.ok(!s.log.some(l => l.includes('delete-batch')), 'used an unlearned endpoint');
    assert.deepEqual(t.errors, []);
  } finally { await t.done(); }
});

test('no generated-images history: bulk reference removal stays locked, copies keep the original', async () => {
  const t = await setup('nogen');
  const { page } = t;
  try {
    await page.goto(t.mock.url);
    await tid(page, 'gc-launcher').click();
    await scan(page);
    assert.equal(await tileNum(page, 'gc-tile-unknown'), 34);
    await manual(page);
    assert.ok(await tid(page, 'gc-queue-refs').isDisabled());
    assert.equal(await tid(page, 'gc-autopilot').count(), 1); // copies are still safe to automate
    await tid(page, 'gc-tab-references').click();
    assert.ok(await tid(page, 'gc-unlock').isVisible());
    await tid(page, 'gc-tab-overview').click();
    await manual(page);
    await tid(page, 'gc-queue-extras').click();
    await tid(page, 'gc-dryrun').uncheck();
    await deleteQueued(page, 8);
    const s = await t.state();
    // The original generation (oldest copy) survives; its two re-uploads are gone.
    const firstGen = s.files.find(f => f.kind === 'generation' && f.name.includes('10_01_00'));
    assert.ok(firstGen, 'original generation was deleted');
    assert.equal(s.files.filter(f => f.name === firstGen.name).length, 1);
    await page.screenshot({ path: join(SHOTS, 'nogen.png') });
    assert.deepEqual(t.errors, []);
  } finally { await t.done(); }
});

test('autopilot: one click removes copies and references, verifies, never touches generations', async () => {
  const t = await setup('known');
  const { page } = t;
  try {
    let dialog = '';
    page.on('dialog', d => { dialog = d.message(); d.accept(); });
    await page.goto(t.mock.url);
    await tid(page, 'gc-launcher').click();
    await tid(page, 'gc-dryrun').uncheck();
    await tid(page, 'gc-autopilot').click();
    await page.waitForFunction(() => /Autopilot done/.test(document.querySelector('#gencull-host').shadowRoot.querySelector('[data-testid=gc-status]')?.textContent || ''), null, { timeout: 60000 });
    assert.match(dialog, /delete 13 files/);
    const s = await t.state();
    assert.equal(s.files.length, 21);
    assert.equal(s.files.filter(f => f.kind === 'generation').length, 20);
    assert.ok(s.files.some(f => f.name === 'notes.pdf'));
    assert.deepEqual(t.errors, []);
  } finally { await t.done(); }
});

test('threads: delete a whole thread in one click, open its chat, download an image', async () => {
  const t = await setup('known');
  const { page } = t;
  try {
    await page.goto(t.mock.url);
    await tid(page, 'gc-launcher').click();
    await scan(page);
    await tid(page, 'gc-tab-series').click();
    await tid(page, 'gc-thread-delete').first().click();
    await tid(page, 'gc-queue-summary').filter({ hasText: 'Queued for deletion: 10 files' }).waitFor();
    await tid(page, 'gc-series-row').first().click();
    const tile = tid(page, 'gc-gen-tile').first();
    assert.match(await tile.locator('a.tact').getAttribute('href'), /^\/c\/conv-aaaa-1111#msg-/);
    const dl = page.waitForEvent('download');
    await tile.getByTestId('gc-download').click();
    assert.match((await dl).suggestedFilename(), /^ChatGPT Image .*\.png$/);
    // Full-size viewer with keyboard culling.
    await tile.click();
    await tid(page, 'gc-viewer').waitFor();
    await page.waitForFunction(() => document.querySelector('#gencull-host').shadowRoot.querySelector('.vcanvas')?.width === 96);
    await page.keyboard.press('x');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('x');
    await page.keyboard.press('Escape');
    await tid(page, 'gc-viewer').waitFor({ state: 'detached' });
    // Thumbnails are cached for next time.
    await page.waitForFunction(async () => {
      const db = await new Promise(r => { const q = indexedDB.open('gencull'); q.onsuccess = () => r(q.result); });
      return new Promise(r => { const c = db.transaction('thumbs').objectStore('thumbs').count(); c.onsuccess = () => r(c.result >= 5); });
    }, null, { timeout: 20000 });
    await page.screenshot({ path: join(SHOTS, 'threads.png') });
    assert.deepEqual(t.errors, []);
  } finally { await t.done(); }
});
