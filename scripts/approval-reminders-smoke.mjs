import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const artifacts = process.env.APPROVAL_ARTIFACTS ?? 'output/playwright/approval-reminders';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], answers = [], calls = [], receipts = new Map();
const tasks = new Map([
  ['one', { id: 'one', name: '当前会话 · 代码检查', cwd: '/Code/alpha', status: { type: 'idle' } }],
  ['two', { id: 'two', name: '另一会话 · 项目整理', cwd: '/Code/beta', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }],
  ['unloaded', { id: 'unloaded', name: '历史会话 · 桌面权限请求', cwd: '/Code/archive', status: { type: 'idle' } }],
]);
let approvals = [], events = [], cursor = 0, ready = true, networkDown = false, bridgeId = 'mock-one', reset = false;
let holdHistory = false, heldHistoryKey = null;
const waiting = (id, flags) => {
  const status = { type: 'active', activeFlags: flags };
  if (tasks.has(id)) tasks.get(id).status = status;
  return { method: 'thread/status/changed', params: { threadId: id, status } };
};
const emit = (...items) => { events = items; cursor++; };
const request = (id, threadId, method = 'item/commandExecution/requestApproval') => ({ id, method, params: { threadId, command: 'npm test', cwd: '/Code/alpha', reason: '运行项目验证', ...(method === 'item/tool/requestUserInput' ? { questions: [{ id: 'q', question: '要保留哪个方案？' }] } : {}) } });
const history = id => ({ data: Array.from({ length: 28 }, (_, index) => ({ turnId: `turn-${index}`, item: { id: `${id}-${index}`, type: index % 2 ? 'userMessage' : 'agentMessage', ...(index % 2 ? { content: [{ type: 'text', text: `第 ${index + 1} 条用户消息` }] } : { text: `第 ${index + 1} 条处理记录\n检查已有实现与测试结果。\n此处保留足够长的消息，验证底部阅读时的提醒。` }) } })).reverse(), nextCursor: null });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost:9789/**', async route => {
    const req = route.request(), url = new URL(req.url());
    let data;
    if (url.pathname === '/api/state') {
      if (networkDown) { await route.abort('failed'); return; }
      data = { ready, bridgeId, reset, mode: 'desktop-shared', capabilities: { paginatedHistory: true, taskCommands: true }, approvals, active: { one: 'turn-current', two: 'turn-other' }, cursor, events: Number(url.searchParams.get('after')) < cursor ? events : [] };
      reset = false;
    } else if (url.pathname === '/api/projects') data = { projects: [{ id: 'alpha', name: 'Alpha 项目', roots: ['/Code/alpha'] }, { id: 'beta', name: 'Beta 项目', roots: ['/Code/beta'] }], assignments: {} };
    else if (url.pathname === '/api/devices') data = { devices: [] };
    else if (url.pathname === '/api/answer') { answers.push(req.postDataJSON()); data = { ok: true }; }
    else if (url.pathname === '/api/commands') {
      const body = req.postDataJSON(); calls.push(body);
      let result;
      if (body.method === 'thread/list') result = { data: [tasks.get('one'), tasks.get('two')], nextCursor: null };
      else if (body.method === 'thread/resume') result = { thread: tasks.get(body.params.threadId) };
      else if (body.method === 'thread/items/list') result = history(body.params.threadId);
      else if (body.method === 'thread/turns/list') result = { data: [], nextCursor: null };
      else throw Error(`Unexpected execution: ${body.method}`);
      receipts.set(body.key, { status: 'completed', result });
      if (holdHistory && body.method === 'thread/items/list') { heldHistoryKey = body.key; receipts.get(body.key).status = 'pending'; holdHistory = false; }
      data = { status: 'pending' };
    } else if (url.pathname.startsWith('/api/commands/')) data = receipts.get(url.pathname.split('/').pop());
    else {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      await route.fulfill({ body: await readFile(new URL('../public/' + file, import.meta.url)), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      return;
    }
    await route.fulfill({ body: JSON.stringify(data), contentType: 'application/json' });
  });
  const openSidebar = async () => { if (!(await page.locator('#task-dialog').evaluate(element => element.open))) await page.locator('#choose-task').click(); };
  const pending = id => page.locator(`.pending-task[data-pending-thread="${id}"]`);
  const choosePending = async id => { await openSidebar(); await pending(id).click(); await page.waitForFunction(() => !document.querySelector('#task-dialog').open); };
  const card = id => page.locator(`.approval-card[data-request-id="${id}"]`);
  const nextPoll = async () => { await page.waitForResponse(response => response.url().includes('/api/state?')); await page.waitForTimeout(80); };
  await page.goto('http://localhost:9789/');
  await openSidebar();
  await pending('two').waitFor();
  assert.match(await pending('two').innerText(), /待回答 · 需在桌面处理/, 'thread/list native waiting status is available before live events');
  await page.locator('.task-row[data-thread-id="one"] .task-card').click();
  await page.waitForFunction(() => !document.querySelector('#task-dialog').open);
  await page.locator('#message').fill('保留当前消息草稿');
  await page.locator('#image-files').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64') });
  await page.locator('#image-previews img').waitFor();
  await page.locator('#message').blur();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

  approvals = [request('command', 'one'), request('question', 'one', 'item/tool/requestUserInput'), request('files', 'two', 'item/fileChange/requestApproval')];
  holdHistory = true;
  emit(waiting('one', ['waitingOnApproval', 'waitingOnUserInput']), waiting('two', ['waitingOnApproval']), waiting('unloaded', ['waitingOnApproval']), { method: 'turn/completed', params: { threadId: 'one', turn: { status: 'completed' } } });
  await page.locator('#approval-reminder').waitFor({ state: 'visible' });
  assert.match(await page.locator('#approval-reminder').innerText(), /1 项待批准 · 1 项待回答/);
  assert.equal(await page.locator('#pending-count').innerText(), '3');
  assert.ok(heldHistoryKey, 'slow history must have started while the reminder is already rendered');
  assert.equal(receipts.get(heldHistoryKey).status, 'pending');
  assert.equal(await page.locator('#turn-loading').isVisible(), false, 'waiting must suppress the ordinary running indicator');
  assert.equal(await page.locator('#delivery-status').innerText(), '', 'avoid repeating the reminder below the composer');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const bounds = await page.locator('#approval-reminder').boundingBox();
    assert.ok(bounds.y >= 72 && bounds.y + bounds.height <= 844, `reminder visible at ${width}`);
    assert.ok((await page.locator('#open-current-approval').boundingBox()).height >= 44);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow at ${width}`);
    await page.screenshot({ path: `${artifacts}/bottom-${width}.png` });
  }
  receipts.get(heldHistoryKey).status = 'completed';
  await nextPoll();
  await page.locator('#open-current-approval').click();
  assert.equal(await card('command').evaluate(element => document.activeElement === element), true);
  const locatedY = await page.evaluate(() => scrollY);
  await nextPoll();
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - locatedY) < 3, 'polling must not pull approval reading to the bottom');
  await card('question').locator('input').fill('保留尚未提交的回答');
  await openSidebar();
  await page.locator('.project-group[data-project="beta"] summary').click();
  assert.equal(await page.locator('.project-group[data-project="beta"]').evaluate(element => element.open), false);
  assert.match(await page.locator('.project-group[data-project="beta"] summary').innerText(), /1 个会话待处理/);
  assert.match(await page.locator('[data-task-status="two"]').textContent(), /待批准/);
  await page.locator('#task-search').fill('完全不匹配');
  await page.locator('#project-filter').selectOption('alpha');
  assert.equal(await page.locator('.task-row').count(), 0);
  assert.equal(await page.locator('.pending-task').count(), 3);
  await page.locator('#task-dialog').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: `${artifacts}/sidebar-filtered-390.png` });
  await pending('two').click();
  await page.waitForFunction(() => !document.querySelector('#task-dialog').open);
  assert.equal(await card('files').count(), 1);
  assert.equal(await page.locator('#message').inputValue(), '');
  assert.equal(await page.locator('#image-previews img').count(), 0);
  await choosePending('one');
  assert.equal(await card('question').locator('input').inputValue(), '保留尚未提交的回答');
  assert.equal(await page.locator('#message').inputValue(), '保留当前消息草稿');
  assert.equal(await page.locator('#image-previews img').count(), 1);

  // Another desktop client resolves a request; the remaining input DOM must survive.
  await card('question').locator('input').focus();
  approvals = approvals.filter(item => item.id !== 'command');
  emit({ method: 'serverRequest/resolved', params: { threadId: 'one', requestId: 'command' } });
  await card('command').waitFor({ state: 'detached' });
  assert.equal(await card('question').locator('input').inputValue(), '保留尚未提交的回答');
  assert.equal(await card('question').locator('input').evaluate(element => document.activeElement === element), true);
  assert.match(await page.locator('#approval-reminder').innerText(), /^1 项待回答/);
  networkDown = true;
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('连接中断'));
  assert.match(await page.locator('#approval-reminder').innerText(), /待核对/);
  assert.equal(await card('question').locator('button').isDisabled(), true);
  assert.match(await page.locator('#connection-error').innerText(), /Failed to fetch/);
  await page.evaluate(() => { document.querySelector('#error').textContent = '尚未解决的其他操作错误'; });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.screenshot({ path: `${artifacts}/disconnected-390.png` });
  await page.locator('#open-current-approval').click();
  const reconnectY = await page.evaluate(() => scrollY);
  networkDown = false;
  await page.waitForFunction(() => document.querySelector('#status').textContent === '已连接');
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - reconnectY) < 3, 'reconnecting the current thread must preserve approval reading position');
  assert.equal(await page.locator('#connection-error').textContent(), '', 'only the recovered connection error is cleared');
  assert.equal(await page.locator('#error').textContent(), '尚未解决的其他操作错误');
  await page.evaluate(() => { document.querySelector('#error').textContent = ''; });
  await choosePending('one');
  await card('question').locator('button').click();
  assert.deepEqual(answers, [{ id: 'question', result: { answers: { q: { answers: ['保留尚未提交的回答'] } } } }]);
  await nextPoll();
  assert.equal(await card('question').locator('button').isDisabled(), true, 'submitted requests stay locked until snapshot resolution');
  approvals = approvals.filter(item => item.id !== 'question');
  emit(waiting('one', []), { method: 'serverRequest/resolved', params: { threadId: 'one', requestId: 'question' } });
  await page.locator('#approval-reminder').waitFor({ state: 'hidden' });
  await choosePending('unloaded');
  await page.waitForFunction(() => document.querySelector('#compose-hint').textContent === '');
  assert.match(await page.locator('#approvals').innerText(), /需在桌面处理/);
  assert.equal(await page.locator('#approvals button').count(), 0);
  assert.equal(await page.locator('#open-current-approval').isDisabled(), false);
  await page.screenshot({ path: `${artifacts}/desktop-only-390.png`, animations: 'disabled' });
  approvals.push(request('unknown-permission', 'unloaded', 'item/permissions/requestApproval'));
  await card('unknown-permission').waitFor();
  assert.match(await page.locator('#approval-reminder').innerText(), /需在桌面处理/);
  assert.equal(await card('unknown-permission').locator('button').count(), 0, 'unknown requests cannot expose an invented acceptance result');
  approvals = approvals.filter(item => item.id !== 'unknown-permission');
  emit(waiting('unloaded', []));
  await page.locator('#approval-reminder').waitFor({ state: 'hidden' });

  // A ready=false snapshot is also a disconnect, never proof of desktop approval.
  await choosePending('two');
  ready = false;
  await page.waitForFunction(() => document.querySelector('#approval-reminder-text').textContent.includes('待核对'));
  assert.equal(await card('files').getByRole('button', { name: '允许这一次' }).isDisabled(), true);
  ready = true; bridgeId = 'mock-two'; approvals = []; reset = true; emit(waiting('two', []));
  await card('files').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('#pending-count').hidden);
  assert.equal(answers.length, 1);
  assert.equal(calls.some(call => call.method.startsWith('turn/')), false, 'reminders must never send model messages or interrupts');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', widths: [320, 390], answers: answers.length, screenshots: artifacts, scenarios: 'current, multiple, other, filtered, unloaded, collapsed, navigation, slow-history, drafts, attachments, desktop-resolution, native-waits, network-disconnect, ready-false, reset, bridge-change' }));
} finally { await browser.close(); }
