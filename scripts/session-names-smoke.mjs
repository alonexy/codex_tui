import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const artifacts = process.env.SESSION_NAMES_ARTIFACTS ?? '/tmp/session-names-evidence';
await mkdir(artifacts, { recursive: true });
const errors = [], calls = [], receipts = new Map(), lost = new Set();
const tasks = new Map([
  ['one', { id: 'one', name: '当前会话', cwd: '/Code/alpha', projectId: 'native-alpha', turns: [] }],
  ['two', { id: 'two', name: '另一个会话', cwd: '/Code/beta', projectId: 'native-beta', turns: [] }],
]);
let nextCreate = 'completed', nextRename = 'completed', sequence = 0, eventCursor = 0, events = [];
let taskCommands = true;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost:9789/**', async route => {
    const request = route.request(), url = new URL(request.url());
    let data;
    if (url.pathname === '/api/state') data = { ready: true, mode: 'desktop-shared', bridgeId: 'mock', capabilities: { taskCommands }, active: {}, approvals: [], cursor: eventCursor, events: Number(url.searchParams.get('after')) < eventCursor ? events : [] };
    else if (url.pathname === '/api/projects') data = { projects: [
      { id: 'alpha', serverId: 'native-alpha', name: 'Alpha 项目', roots: ['/Code/alpha', '/Code/shared'] },
      { id: 'beta', serverId: 'native-beta', name: 'Beta 项目', roots: ['/Code/beta'] },
    ], assignments: {} };
    else if (url.pathname === '/api/devices') data = { devices: [] };
    else if (url.pathname === '/api/commands') {
      const body = request.postDataJSON(); calls.push(body);
      let result = {}, status = 'completed';
      if (body.method === 'thread/list') result = { data: [...tasks.values()], nextCursor: null };
      else if (body.method === 'thread/start') {
        const thread = { id: `created-${++sequence}`, ...body.params, turns: [] };
        tasks.set(thread.id, thread); result = { thread }; status = nextCreate; nextCreate = 'completed';
      } else if (body.method === 'thread/name/set') {
        status = nextRename; nextRename = 'completed';
        if (status === 'completed') tasks.get(body.params.threadId).name = body.params.name;
      } else if (body.method === 'thread/resume') result = { thread: tasks.get(body.params.threadId), initialTurnsPage: { data: [] } };
      else throw Error(`Unexpected command: ${body.method}`);
      if (status === 'unknown') { lost.add(body.key); status = 'pending'; }
      receipts.set(body.key, { status, result, ...(status === 'failed' ? { error: { message: 'mock rename rejected' } } : {}) });
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
  const count = method => calls.filter(call => call.method === method).length;
  const closeSidebar = async () => { if (await page.locator('#task-dialog').evaluate(element => element.open)) await page.locator('#close-tasks').click(); };
  const openSidebar = async () => { if (!(await page.locator('#task-dialog').evaluate(element => element.open))) await page.locator('#choose-task').click(); };
  const choose = async id => { await openSidebar(); await row(id).locator('.task-card').click(); await page.waitForFunction(() => !document.querySelector('#task-dialog').open); };
  const waitFormClosed = () => page.waitForFunction(() => !document.querySelector('#command-dialog').open);
  const confirm = body => {
    lost.delete(body.key);
    const record = receipts.get(body.key); record.status = 'completed';
    if (body.method === 'thread/name/set') tasks.get(body.params.threadId).name = body.params.name;
  };
  await page.goto('http://localhost:9789/');
  await choose('one');
  await page.locator('#message').fill('保留消息草稿');
  await page.locator('#image-files').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64') });
  await page.locator('#image-previews img').waitFor();

  await openSidebar();
  await row('two').locator('.task-favorite').click();
  await row('two').locator('.task-rename').click();
  assert.equal(await page.locator('#command-argument').inputValue(), '另一个会话');
  await page.locator('#command-argument').fill('未提交名称');
  await page.locator('#command-cancel').click();
  await row('two').locator('.task-rename').click();
  assert.equal(await page.locator('#command-argument').inputValue(), '未提交名称');
  await page.locator('#command-argument').fill('   ');
  await page.locator('#command-save').click();
  assert.equal(count('thread/name/set'), 0);
  nextRename = 'failed';
  await page.locator('#command-argument').fill('其他会话新名称');
  await page.locator('#command-save').click();
  await page.waitForFunction(() => document.querySelector('#command-error').textContent.includes('rejected'));
  assert.equal(await page.locator('#command-argument').inputValue(), '其他会话新名称');
  await page.locator('#command-save').click();
  await waitFormClosed();
  assert.equal(await row('two').locator('strong').innerText(), '其他会话新名称');
  assert.equal(await row('two').locator('.task-card').isDisabled(), false, 'rename must release task navigation');
  assert.equal(await page.locator('#conversation-title').innerText(), '当前会话');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('codex-thread')), 'one');
  await closeSidebar();
  assert.equal(await page.locator('#message').inputValue(), '保留消息草稿');
  assert.equal(await page.locator('#image-previews img').count(), 1);

  await openSidebar();
  await row('one').locator('.task-rename').click();
  await page.locator('#command-argument').fill('当前会话新名称');
  await page.screenshot({ path: `${artifacts}/rename-mobile.png` });
  await page.locator('#command-save').click();
  await waitFormClosed();
  assert.equal(await page.locator('#conversation-title').getAttribute('title'), '当前会话新名称');
  assert.equal(await page.locator('#current').innerText(), '当前任务：当前会话新名称');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
    assert.equal(await page.locator('.task-card .task-rename').count(), 0);
    const boxes = await row('one').locator('.task-card, .task-rename').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, bottom: rect.bottom, right: rect.right, width: rect.width, height: rect.height }; }));
    assert.ok(boxes[0].bottom <= boxes[1].y && boxes[0].width > 140 && boxes[1].width >= 44 && boxes[1].height >= 44);
    if (width === 390) {
      await page.locator('#task-dialog').evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: `${artifacts}/sessions-mobile.png` });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await closeSidebar();

  await page.locator('#new').click();
  await page.locator('#new-name').fill('项目迭代会话');
  await page.locator('#project-choice').selectOption('alpha');
  assert.equal(await page.locator('#workspace-choice').isVisible(), false, 'creating within a project does not require choosing a directory');
  assert.match(await page.locator('#new-summary').innerText(), /包含 2 个目录，可跨目录工作/);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${artifacts}/project-new-${width}.png` });
  }
  await page.screenshot({ path: `${artifacts}/new-mobile.png` });
  await page.locator('#create').click();
  await page.waitForFunction(() => document.querySelector('#conversation-title').textContent === '项目迭代会话');
  assert.deepEqual(calls.find(call => call.method === 'thread/start').params, { cwd: '/Code/alpha', projectId: 'native-alpha', runtimeWorkspaceRoots: ['/Code/alpha', '/Code/shared'] });
  assert.equal(count('thread/start'), 1);
  await choose('one');
  assert.equal(await page.locator('#message').inputValue(), '保留消息草稿');
  assert.equal(await page.locator('#image-previews img').count(), 1);

  nextRename = 'failed';
  await page.locator('#new').click();
  await page.locator('#new-name').fill('失败后恢复名称');
  await page.locator('#project-workspace > summary').click();
  await page.locator('#workspace-choice').selectOption('/Code/shared');
  await page.locator('#create').click();
  await page.waitForFunction(() => document.querySelector('#command-error').textContent.includes('会话已创建'));
  assert.equal(await page.locator('#new-dialog').evaluate(element => element.open), false);
  const partialId = await page.evaluate(() => sessionStorage.getItem('codex-thread'));
  await page.screenshot({ path: `${artifacts}/partial-success-mobile.png` });
  await page.locator('#command-save').click();
  await waitFormClosed();
  assert.equal(count('thread/start'), 2);
  assert.deepEqual(calls.filter(call => call.method === 'thread/start')[1].params, { cwd: '/Code/shared', projectId: 'native-alpha', runtimeWorkspaceRoots: ['/Code/alpha', '/Code/shared'] });
  assert.equal(tasks.get(partialId).name, '失败后恢复名称');

  nextRename = 'unknown';
  await page.locator('#new').click();
  await page.locator('#new-name').fill('回执丢失名称');
  await page.locator('#create').click();
  await page.waitForFunction(() => document.querySelector('#command-error').textContent.includes('命名结果待确认'));
  const pendingRename = calls.findLast(call => call.method === 'thread/name/set');
  const beforeRecovery = calls.length;
  assert.equal(await page.locator('#command-save').isDisabled(), true);
  await page.screenshot({ path: `${artifacts}/unknown-mobile.png` });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#recovery-actions').hidden === false);
  confirm(pendingRename);
  await page.waitForFunction(() => document.querySelector('#conversation-title').textContent === '回执丢失名称');
  assert.equal(count('thread/start'), 3);
  assert.equal(calls.slice(beforeRecovery).filter(call => !['thread/list', 'thread/resume'].includes(call.method)).length, 0, 'reload must query, never replay');

  nextCreate = 'unknown';
  await page.locator('#new').click();
  await page.locator('#new-name').fill('创建回执恢复名称');
  await page.locator('#create').click();
  await page.waitForFunction(() => document.querySelector('#new-error').textContent.includes('创建结果待确认'));
  const pendingCreate = calls.findLast(call => call.method === 'thread/start');
  const renameCount = count('thread/name/set');
  await page.reload();
  confirm(pendingCreate);
  await page.waitForFunction(() => document.querySelector('#command-dialog')?.open);
  assert.equal(await page.locator('#command-argument').inputValue(), '创建回执恢复名称');
  assert.equal(count('thread/name/set'), renameCount, 'recovered creation must not silently submit a second operation');
  assert.equal(count('thread/start'), 4);
  // Reload at the exact two-step boundary: creation is confirmed, naming is not sent.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#command-dialog')?.open);
  assert.equal(await page.locator('#command-argument').inputValue(), '创建回执恢复名称');
  assert.equal(count('thread/start'), 4);
  await page.locator('#command-save').click();
  await waitFormClosed();
  assert.equal(await page.locator('#conversation-title').innerText(), '创建回执恢复名称');

  tasks.get('two').name = '桌面同步名称';
  events = [{ method: 'thread/name/updated', params: { threadId: 'two', threadName: '桌面同步名称' } }]; eventCursor++;
  await openSidebar();
  await page.waitForFunction(() => document.querySelector('.task-row[data-thread-id="two"] strong')?.textContent === '桌面同步名称');
  await closeSidebar();
  taskCommands = false;
  await page.waitForFunction(() => document.querySelector('#new-name-hint').textContent.includes('当前桥接不支持'));
  await page.locator('#new').click();
  await page.locator('#new-name').fill('旧桥接不支持名称');
  await page.locator('#create').click();
  await page.waitForFunction(() => document.querySelector('#new-error').textContent.includes('驻留桥接'));
  assert.equal(count('thread/start'), 4);
  await page.locator('#new-name').fill('   ');
  await page.locator('#create').click();
  await page.waitForFunction(() => !document.querySelector('#new-dialog').open);
  assert.equal(count('thread/start'), 5);
  assert.equal(calls.some(call => call.method.startsWith('turn/')), false);
  assert.deepEqual(errors, []);
  console.log(`PASS: optional create name, project component, current/noncurrent/favorite rename, whitespace/cancel/failure, drafts+images, partial success, lost start/name receipts and reload boundary, desktop events, old bridges, 320–1280px layout. Mock API only. Screenshots: ${artifacts}`);
} finally { await browser.close(); }
