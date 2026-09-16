import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const artifacts = new URL('../output/playwright/session-archive/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const calls = [], errors = [], receipts = new Map(), lost = new Set(), archived = new Set();
const tasks = new Map([
  ['one', { id: 'one', name: '当前会话与未发送草稿', cwd: '/Code/alpha', turns: [] }],
  ['two', { id: 'two', name: '待归档的另一个会话', cwd: '/Code/alpha', turns: [] }],
  ['running', { id: 'running', name: '执行中的会话', cwd: '/Code/alpha', turns: [] }],
  ['waiting', { id: 'waiting', name: '等待批准的会话', cwd: '/Code/alpha', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turns: [] }],
]);
let nextStatus = 'completed', capability = true, cursor = 0;
const events = [];
const emit = (method, id) => events.push({ cursor: ++cursor, method, params: { threadId: id } });
function complete(body) {
  const id = body.params.threadId;
  if (body.method === 'thread/archive') archived.add(id);
  if (body.method === 'thread/unarchive') archived.delete(id);
  return body.method === 'thread/unarchive' ? { thread: tasks.get(id) } : {};
}
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost:9789/**', async route => {
    const request = route.request(), url = new URL(request.url());
    let data;
    if (url.pathname === '/api/state') data = { ready: true, mode: 'desktop-shared', bridgeId: 'fixture', capabilities: { taskCommands: true, taskArchive: capability }, active: { running: 'turn' }, approvals: [], cursor, events: events.filter(event => event.cursor > Number(url.searchParams.get('after'))) };
    else if (url.pathname === '/api/projects') data = { projects: [{ id: 'alpha', name: 'Alpha 项目', roots: ['/Code/alpha'] }], assignments: {} };
    else if (url.pathname === '/api/commands') {
      const body = request.postDataJSON(); calls.push(body);
      let result = {}, status = 'completed';
      if (body.method === 'thread/list') result = { data: [...tasks.values()].filter(task => archived.has(task.id) === !!body.params.archived), nextCursor: null };
      else if (body.method === 'thread/resume') {
        assert.equal(archived.has(body.params.threadId), false, 'archived thread must never be resumed');
        result = { thread: tasks.get(body.params.threadId), initialTurnsPage: { data: [] } };
      } else if (['thread/archive', 'thread/unarchive'].includes(body.method)) {
        status = nextStatus; nextStatus = 'completed';
        if (status === 'completed') result = complete(body);
        if (status === 'unknown') { status = 'pending'; lost.add(body.key); }
      } else throw Error(`Unexpected RPC ${body.method}`);
      receipts.set(body.key, { status, result, ...(status === 'failed' ? { error: { message: 'fixture rejected' } } : {}) });
      data = { status: 'pending' };
    } else if (url.pathname.startsWith('/api/commands/')) {
      const key = url.pathname.split('/').pop();
      if (lost.has(key)) { await route.abort('failed'); return; }
      data = receipts.get(key);
    } else {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      await route.fulfill({ body: await readFile(new URL('../public/' + file, import.meta.url)), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      return;
    }
    await route.fulfill({ body: JSON.stringify(data), contentType: 'application/json' });
  });
  const row = id => page.locator(`.task-row[data-thread-id="${id}"]`);
  const sidebar = async () => { if (!await page.locator('#task-dialog').evaluate(el => el.open)) await page.locator('#choose-task').click(); };
  const choose = async id => { await sidebar(); await row(id).locator('.task-card').click(); await page.waitForFunction(() => !document.querySelector('#task-dialog').open); };
  const confirm = async id => { await row(id).locator('.task-archive').click(); await page.locator('#archive-confirm').click(); };
  const closed = () => page.waitForFunction(() => !document.querySelector('#archive-dialog').open);
  await page.goto('http://localhost:9789/');
  await choose('one'); await page.locator('#message').fill('当前草稿保留');
  await page.locator('#image-files').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64') });
  await page.locator('#image-previews img').waitFor();
  await sidebar();
  for (const id of ['running', 'waiting']) {
    assert.equal(await row(id).locator('.task-archive').isDisabled(), true);
    assert.match(await row(id).locator('.task-archive').getAttribute('title'), /运行或等待/);
  }
  await row('two').locator('.task-favorite').click();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const dimensions = await row('two').locator('.task-rename, .task-archive').evaluateAll(elements => elements.map(el => ({ text: el.textContent.trim(), icon: !!el.querySelector('svg'), width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
    assert.ok(dimensions.every(el => !el.text && el.icon && el.width >= 44 && el.height >= 44));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('#task-dialog').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.screenshot({ path: new URL(`list-${width}.png`, artifacts).pathname });
  }
  await page.locator('#task-dialog').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: new URL('sidebar-top-390.png', artifacts).pathname });
  await row('two').locator('.task-archive').click();
  await page.screenshot({ path: new URL('confirmation-390.png', artifacts).pathname });
  await page.locator('#archive-cancel').click();
  assert.equal(calls.filter(call => call.method === 'thread/archive').length, 0);
  nextStatus = 'failed'; await confirm('two');
  await page.locator('#archive-error').filter({ hasText: 'fixture rejected' }).waitFor();
  assert.equal(await row('two').count(), 1); assert.equal(await page.locator('#message').inputValue(), '当前草稿保留');
  await page.locator('#archive-confirm').click(); await closed();
  assert.equal(await row('two').count(), 0);
  assert.equal(await page.locator('#conversation-title').textContent(), tasks.get('one').name);
  await page.locator('#archive-filter').selectOption('archived'); await row('two').waitFor();
  assert.equal(await row('one').count(), 0); assert.equal(await row('two').locator('.task-card').isDisabled(), true);
  await page.screenshot({ path: new URL('archived-390.png', artifacts).pathname });
  await confirm('two'); await closed();
  await page.locator('#archive-filter').selectOption('active'); await row('two').waitFor();
  assert.equal(await row('two').locator('.task-favorite').getAttribute('aria-pressed'), 'false');
  await confirm('one'); await closed();
  assert.equal(await page.locator('#conversation-title').textContent(), 'Codex');
  assert.equal(await page.locator('#image-previews').isVisible(), false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('codex-thread')), null);
  await page.locator('#archive-filter').selectOption('archived'); await row('one').waitFor();
  await confirm('one'); await closed();
  await page.locator('#archive-filter').selectOption('active'); await row('one').waitFor();
  await choose('one'); assert.equal(await page.locator('#message').inputValue(), '当前草稿保留');
  assert.equal(await page.locator('#image-previews img').count(), 1);
  await sidebar(); nextStatus = 'unknown'; await confirm('two');
  await page.locator('#archive-receipt').waitFor();
  const pending = calls.findLast(call => call.method === 'thread/archive');
  const beforeReload = calls.filter(call => call.method === 'thread/archive').length;
  await page.reload(); await page.locator('#workspace').waitFor();
  lost.delete(pending.key); receipts.set(pending.key, { status: 'completed', result: complete(pending) });
  await page.locator('#check-receipt').click();
  await sidebar(); await page.waitForFunction(() => !document.querySelector('.task-row[data-thread-id="two"]'));
  assert.equal(calls.filter(call => call.method === 'thread/archive').length, beforeReload);
  archived.delete('two'); emit('thread/unarchived', 'two'); await row('two').waitFor();
  archived.add('two'); emit('thread/archived', 'two'); await row('two').waitFor({ state: 'detached' });
  capability = false;
  await page.waitForFunction(() => document.querySelector('#archive-filter').disabled);
  assert.match(await page.locator('#archive-support').textContent(), /重启/);
  assert.equal(await row('one').locator('.task-archive').isDisabled(), true);
  assert.deepEqual(errors, []);
  const result = 'PASS: native archive/restore fixtures, cancel/failure/current/noncurrent/favorites/drafts, unknown receipt reload without replay, desktop notifications, running/approval guards, old bridge, 320/390px icon targets and no overflow. No real writes.';
  await writeFile(new URL('result.txt', artifacts), result + '\n');
  console.log(result);
} finally { await browser.close(); }
