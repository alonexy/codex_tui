import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const artifacts = new URL('../output/playwright/file-attachments/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const calls = [], uploads = [], errors = [], receipts = new Map(), files = {};
const tasks = new Map(['one', 'two'].map(id => [id, { id, name: id === 'one' ? '附件验收会话' : '另一个会话', cwd: '/work', turns: [] }]));
let failName = '报告.pdf', cursor = 0, unknown = false;
const events = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('codex-thread', 'one'));
  await page.route('http://phone.test/**', async route => {
    const req = route.request(), url = new URL(req.url()); let data;
    if (url.pathname === '/api/state') data = { ready: true, mode: 'desktop-shared', bridgeId: 'fixture', cursor, events: events.filter(event => event.cursor > Number(url.searchParams.get('after'))), active: {}, approvals: [] };
    else if (url.pathname === '/api/projects') data = { projects: [{ id: 'work', name: '工作区', roots: ['/work'] }], assignments: {} };
    else if (url.pathname === '/api/attachment-batches') data = { ok: true };
    else if (url.pathname === '/api/attachments') {
      const name = decodeURIComponent(req.headers()['x-attachment-name']);
      assert.equal(url.searchParams.has('name'), false);
      assert.equal(req.headers()['content-type'], 'application/octet-stream');
      uploads.push({ name, bytes: req.postDataBuffer().length, id: url.searchParams.get('id') });
      if (name === failName) { failName = ''; await route.fulfill({ status: 400, json: { error: 'fixture 上传失败' } }); return; }
      const id = randomUUID(), image = name.endsWith('.png'), path = `/private/uploads/${id}.${name.split('.').pop()}`;
      data = { id, name, size: req.postDataBuffer().length, kind: image ? 'image' : 'file', url: `/api/attachments/${id}`, input: image ? { type: 'localImage', path } : { type: 'mention', name, path } };
      files[path] = data;
    } else if (url.pathname === '/api/commands') {
      const call = req.postDataJSON(); calls.push(call); let result = {};
      if (call.method === 'thread/list') result = { data: [...tasks.values()], nextCursor: null };
      else if (['thread/resume', 'thread/read'].includes(call.method)) result = { thread: tasks.get(call.params.threadId) };
      else if (['turn/start', 'turn/steer'].includes(call.method)) {
        assert.ok(req.postDataBuffer().length < 4096, 'commands must contain only small attachment references');
        assert.equal(JSON.stringify(call).includes('DOCUMENT_SECRET'), false);
        const turn = { id: `turn-${calls.length}`, status: 'completed', items: [{ id: `item-${calls.length}`, type: 'userMessage', content: call.params.input }] };
        tasks.get(call.params.threadId).turns.push(turn); result = { turn };
        events.push({ cursor: ++cursor, method: 'item/completed', params: { threadId: call.params.threadId, turnId: turn.id, item: turn.items[0] } });
        if (unknown) { receipts.set(call.key, null); await route.abort('failed'); return; }
      } else throw Error(`Unexpected RPC ${call.method}`);
      receipts.set(call.key, { status: 'completed', result, files }); data = { status: 'pending' };
    } else if (url.pathname.startsWith('/api/commands/')) {
      data = receipts.get(url.pathname.split('/').pop());
      if (!data) { await route.abort('failed'); return; }
    } else {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      await route.fulfill({ body: await readFile(new URL('../public/' + name, import.meta.url)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }); return;
    }
    await route.fulfill({ json: data });
  });
  const select = async id => { await page.locator('#choose-task').click(); await page.locator(`.task-row[data-thread-id="${id}"] .task-card`).click(); await page.waitForFunction(() => !document.querySelector('#task-dialog').open); };
  const doc = { name: '设计说明 <script>.md', mimeType: 'text/markdown', buffer: Buffer.from('DOCUMENT_SECRET 中文内容') };
  const pdf = { name: '报告.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nDOCUMENT_SECRET\n%%EOF') };
  const png = { name: '截图.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64') };
  await page.goto('http://phone.test/'); await page.waitForFunction(() => !document.querySelector('#attach-image').disabled);
  assert.equal(await page.evaluate(() => isSecureContext), false, 'fixture covers plain HTTP crypto fallback');
  await page.locator('#image-files').setInputFiles([doc, pdf, png]);
  await page.waitForFunction(() => document.querySelectorAll('.upload-preview').length === 3);
  await page.locator('#message').fill('检查这些附件');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: new URL(`mixed-${width}.png`, artifacts).pathname });
  }
  await select('two'); assert.equal(await page.locator('.upload-preview').count(), 0);
  await page.locator('#message').fill('另一会话草稿'); await page.locator('#image-files').setInputFiles({ ...doc, name: '另一份.txt' });
  await select('one'); assert.equal(await page.locator('.upload-preview').count(), 3); assert.equal(await page.locator('#message').inputValue(), '检查这些附件');
  await page.locator('#send').click(); await page.locator('#error').filter({ hasText: 'fixture 上传失败' }).waitFor();
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 0); assert.equal(await page.locator('.upload-preview').count(), 3);
  await page.screenshot({ path: new URL('failed-upload-390.png', artifacts).pathname });
  await page.locator('#send').click(); await page.waitForFunction(() => document.querySelectorAll('.upload-preview').length === 0);
  assert.equal(uploads.filter(file => file.name === doc.name).length, 1, 'successful first upload must be reused');
  assert.equal(uploads.filter(file => file.name === pdf.name).length, 2);
  assert.equal(uploads.filter(file => file.name === pdf.name)[0].id, uploads.filter(file => file.name === pdf.name)[1].id, 'retry must retain upload identity');
  const sent = calls.find(call => call.method === 'turn/start'); assert.deepEqual(sent.params.input.map(item => item.type), ['text', 'mention', 'mention', 'localImage']);
  await page.locator('.file-attachment').first().waitFor(); assert.equal(await page.locator('.file-attachment').count(), 2); assert.equal(await page.locator('.message-body script').count(), 0);
  await page.screenshot({ path: new URL('history-390.png', artifacts).pathname });
  await select('two'); assert.equal(await page.locator('.upload-preview').count(), 1); assert.equal(await page.locator('#message').inputValue(), '另一会话草稿');
  await page.locator('#message').fill(''); await page.locator('#send').click(); await page.waitForFunction(() => document.querySelectorAll('.upload-preview').length === 0);
  assert.deepEqual(calls.filter(call => call.method === 'turn/start')[1].params.input.map(item => item.type), ['mention']);
  await page.locator('#image-files').setInputFiles(Array.from({ length: 11 }, (_, index) => ({ ...doc, name: `${index}.txt` })));
  await page.locator('#error').filter({ hasText: '最多 10 个附件' }).waitFor(); assert.equal(await page.locator('.upload-preview').count(), 0);
  await page.locator('#image-files').setInputFiles({ name: 'blocked.zip', mimeType: 'application/zip', buffer: Buffer.from('zip') });
  await page.locator('#error').filter({ hasText: '仅支持' }).waitFor(); assert.equal(await page.locator('.upload-preview').count(), 0);
  await page.locator('#image-files').setInputFiles({ ...doc, name: 'unknown.txt' }); unknown = true;
  await page.locator('#send').click(); await page.locator('#recovery-actions').waitFor();
  const beforeRecovery = calls.filter(call => call.method === 'turn/start').length;
  await page.locator('#check-receipt').click(); await page.waitForFunction(() => !document.querySelector('#check-receipt').disabled);
  assert.equal(calls.filter(call => call.method === 'turn/start').length, beforeRecovery, 'unknown native command must never replay');
  assert.equal(await page.locator('.upload-preview').count(), 1); assert.deepEqual(errors, []);
  await writeFile(new URL('result.json', artifacts), JSON.stringify({ result: 'passed', viewports: [320, 390], uploads, commandCount: beforeRecovery, errors }, null, 2));
  console.log('file attachment browser smoke passed');
} finally { await browser.close(); }
