import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const artifacts = 'output/playwright/turn-process';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=';
const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const message = (id, text, phase) => ({ id, type: 'agentMessage', text, phase });
const edit = (id, paths, status = 'completed') => ({ id, type: 'fileChange', status, changes: paths.map(path => ({ path, kind: { type: 'update' }, diff: '+ checked' })) });
const tasks = [
  { id: 'one', name: '界面检查', cwd: '/repo', status: { type: 'idle' } },
  { id: 'two', name: '另一会话', cwd: '/repo', status: { type: 'idle' } },
];
const turns = [
  { id: 'done', status: 'completed', durationMs: 1200, items: [
    { ...user('u1', '检查手机端展示'), content: [{ type: 'text', text: '检查手机端展示' }, { type: 'image', url: image }] },
    message('p1', '我先检查布局，再验证交互。', 'commentary'),
    { id: 'c1', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'Passed', exitCode: 0 },
    edit('e1', ['/repo/view.js', '/repo/view.js']),
    message('a1', `检查完成。**正文保持可见**\n\n| 项目 | 结果 |\n| --- | --- |\n| 手机布局 | 通过 |\n![演示图片](${image})`, 'final_answer'),
    message('legacy', '旧记录未标明阶段，继续显示正文。', null),
  ] },
  { id: 'current', status: 'inProgress', startedAt: 100, items: [
    user('u2', '继续检查状态变化'),
    message('p2', '正在检查实时状态。', 'commentary'),
    { id: 'long', type: 'commandExecution', command: 'node scripts/check.mjs --fixture=' + 'sample'.repeat(30), status: 'inProgress', aggregatedOutput: '模拟长输出 abc123 '.repeat(4000) },
    { ...message('q2', '请选择要保留的界面方案。', 'commentary'), questions: [{ id: 'choice' }] },
  ] },
];
const older = [
  { turnId: 'older', item: user('old-user', '更早的请求') },
  { turnId: 'older', item: { id: 'old-tool', type: 'reasoning', summary: ['已检查较早记录'] } },
  { turnId: 'older', item: message('old-answer', '更早的最终回复', 'final_answer') },
  { turnId: 'done', item: user('earlier-item', '当前页之前的同轮消息') },
];
let events = [], cursor = 0, active = { one: 'current' }, networkDown = false, reset = false;
let metadataKey = null;
const receipts = new Map(), calls = [], errors = [];
const emit = (...items) => { events = items; cursor++; };
const itemEvent = item => {
  const items = turns[1].items, index = items.findIndex(existing => existing.id === item.id);
  if (index < 0) items.push(item); else items[index] = item;
  return { method: 'item/completed', params: { threadId: 'one', turnId: 'current', item } };
};
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('codex-thread', 'one'));
  await page.route('http://process.test/**', async route => {
    const request = route.request(), url = new URL(request.url());
    let data;
    if (url.pathname === '/api/state') {
      if (networkDown) { await route.abort('failed'); return; }
      data = { ready: true, bridgeId: 'mock-process', reset, capabilities: { paginatedHistory: true, taskCommands: true }, active, cursor,
        events: Number(url.searchParams.get('after')) < cursor ? events : [],
        approvals: [{ id: 'question', method: 'item/tool/requestUserInput', params: { threadId: 'one', questions: [{ id: 'q', question: '保留哪个方案？' }] } }] };
      reset = false;
    } else if (url.pathname === '/api/projects') data = { projects: [], assignments: {} };
    else if (url.pathname === '/api/commands') {
      const body = request.postDataJSON(); calls.push(body);
      let result, status = 'completed';
      if (body.method === 'thread/list') result = { data: tasks, nextCursor: null };
      else if (body.method === 'thread/resume') result = { thread: tasks.find(task => task.id === body.params.threadId) };
      else if (body.method === 'thread/items/list') {
        const entries = body.params.threadId === 'two' ? [
          { turnId: 'current', item: user('two-user', '另一会话的问题') },
          { turnId: 'current', item: { id: 'two-tool', type: 'subAgentActivity', kind: 'completed' } },
          { turnId: 'current', item: message('two-answer', '未知新阶段也保持可见', 'future-phase') },
        ] : body.params.cursor ? [...older, { turnId: 'done', item: turns[0].items[0] }]
          : turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item })));
        result = { data: [...entries].reverse(), nextCursor: body.params.threadId === 'one' && !body.params.cursor ? 'older' : null };
      } else if (body.method === 'thread/turns/list') {
        if (body.params.threadId === 'two') { receipts.set(body.key, { status: 'failed', error: { message: 'metadata unavailable' } }); data = { status: 'pending' }; }
        else {
          result = { data: [...turns.map(({ items, ...turn }) => ({ ...turn, items: [], itemsView: 'notLoaded' })), { id: 'older', status: 'completed', durationMs: 5000 }], nextCursor: null };
          if (!metadataKey) { metadataKey = body.key; status = 'pending'; }
        }
      } else throw Error(`Unexpected command: ${body.method}`);
      if (!data) { receipts.set(body.key, { status, result }); data = { status: 'pending' }; }
    } else if (url.pathname.startsWith('/api/commands/')) data = receipts.get(url.pathname.split('/').pop());
    else {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      await route.fulfill({ body: await readFile(new URL('../public/' + file, import.meta.url)), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); return;
    }
    await route.fulfill({ json: data });
  });
  const turn = id => page.locator(`.turn[data-turn-id="${id}"]`);
  const process = id => turn(id).locator('.turn-process');
  const summary = id => process(id).locator(':scope > summary');
  const switchTo = async id => {
    await page.locator('#choose-task').click();
    await page.locator(`.task-row[data-thread-id="${id}"] .task-card`).click();
    await page.waitForFunction(() => !document.querySelector('#task-dialog').open);
  };
  await page.goto('http://process.test');
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  assert.ok(metadataKey, 'metadata started without holding up history');
  assert.equal(await page.locator('.turn-process').count(), 2);
  assert.equal(await page.locator('.turn-process[open]').count(), 0);
  assert.equal(await page.locator('.tool-record pre').count(), 0);
  assert.equal(await turn('done').getByText('正文保持可见').isVisible(), true);
  assert.equal(await turn('done').getByText('旧记录未标明阶段，继续显示正文。').isVisible(), true);
  assert.equal(await turn('current').getByText('请选择要保留的界面方案。').isVisible(), true);
  assert.equal(await page.locator('#history img').count(), 2);
  assert.equal(await page.locator('.turn-process img').count(), 0);
  assert.equal(await page.locator('#history table').isVisible(), true);
  assert.ok(!(await summary('done').innerText()).includes('已完成'), 'tool completion is not proof of turn completion');
  assert.match(await summary('current').innerText(), /进行中/);
  assert.ok(!(await summary('current').innerText()).includes('--fixture'));
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await process('done').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no collapsed overflow at ${width}`);
    await page.screenshot({ path: `${artifacts}/collapsed-${width}.png` });
  }
  await summary('current').click();
  await process('current').locator('.tool-record > summary').click();
  await process('current').locator('.tool-record pre').waitFor();
  assert.ok((await process('current').locator('pre').textContent()).length > 40000);
  assert.ok((await process('current').locator('pre').boundingBox()).height <= 300);
  await page.evaluate(() => {
    window.savedProcess = document.querySelector('.turn[data-turn-id="current"] .turn-process');
    window.savedSummary = window.savedProcess.querySelector('summary');
    window.savedSummary.focus();
  });
  emit(itemEvent(edit('live-edit', ['/repo/a.js', '/repo/b.js'])), itemEvent(edit('repeat-edit', ['/repo/a.js'])));
  await page.waitForFunction(() => document.querySelector('.turn[data-turn-id="current"] .process-action').textContent === '修改文件');
  assert.equal(await page.evaluate(() => document.activeElement === window.savedSummary), true);
  assert.match(await summary('current').innerText(), /修改 2 个文件（已加载记录）/);
  emit(itemEvent({ id: 'failed-command', type: 'commandExecution', command: 'rg missing', status: 'failed', exitCode: 1 }));
  await page.waitForFunction(() => document.querySelector('.turn[data-turn-id="current"] .process-title').textContent.includes('有操作未成功'));
  assert.ok(!(await summary('current').innerText()).includes('执行失败'));
  emit(itemEvent(message('final-current', '实时最终回复保持在过程外面。', 'final_answer')),
    { method: 'turn/completed', params: { threadId: 'one', turn: { id: 'current', status: 'completed', durationMs: 39004, completedAt: 139 } } });
  turns[1].status = 'completed'; turns[1].durationMs = 39004; active = {};
  await page.waitForFunction(() => document.querySelector('.turn[data-turn-id="current"] .process-title').textContent.includes('已完成'));
  // The held read still contains inProgress: it must not undo the newer event.
  receipts.get(metadataKey).status = 'completed';
  await page.waitForFunction(() => document.querySelector('.turn[data-turn-id="done"] .process-title').textContent.includes('用时 1 秒'));
  assert.match(await summary('current').innerText(), /已完成 · 用时 39 秒/);
  assert.equal(await turn('current').getByText('实时最终回复保持在过程外面。').isVisible(), true);
  assert.equal(await process('current').evaluate(node => node === window.savedProcess && node.open), true);
  assert.equal(await page.evaluate(() => document.activeElement === window.savedSummary), true);
  assert.equal(await process('current').locator('.tool-record[open]').count(), 1);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await process('current').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no expanded overflow at ${width}`);
    await page.screenshot({ path: `${artifacts}/expanded-${width}.png` });
  }
  await page.locator('#older-history').click();
  await turn('older').waitFor();
  await page.waitForFunction(() => document.querySelector('.turn[data-turn-id="older"] .process-title').textContent.includes('用时 5 秒'));
  assert.equal(await turn('done').locator('.userMessage').count(), 2, 'overlapping page item appears once');
  assert.equal(await process('current').evaluate(node => node === window.savedProcess && node.open), true);
  await page.locator('#message').fill('保留草稿');
  await page.locator('#approvals input').fill('保留回答');
  await switchTo('two');
  assert.equal(await process('current').evaluate(node => node.open), false, 'same turn ID cannot share disclosure state across threads');
  assert.equal(await page.getByText('未知新阶段也保持可见').isVisible(), true);
  assert.equal(await summary('current').innerText(), '执行过程');
  assert.equal(await page.locator('#error').textContent(), '', 'metadata failure does not become a history failure');
  await switchTo('one');
  assert.equal(await process('current').evaluate(node => node === window.savedProcess && node.open), true);
  assert.equal(await page.locator('#message').inputValue(), '保留草稿');
  assert.equal(await page.locator('#approvals input').inputValue(), '保留回答');
  await page.locator('#message').focus();
  networkDown = true;
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('连接中断'));
  networkDown = false; reset = true;
  await page.waitForFunction(() => document.querySelector('#status').textContent === '已连接');
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  assert.equal(await process('current').evaluate(node => node === window.savedProcess && node.open), true);
  assert.equal(await page.locator('#message').evaluate(node => document.activeElement === node), true);
  assert.equal(await page.locator('#message').inputValue(), '保留草稿');
  emit({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'failed', status: 'failed', error: { message: '模拟轮次失败，请查看说明' } } } },
    { method: 'turn/completed', params: { threadId: 'one', turn: { id: 'stopped', status: 'interrupted' } } });
  await turn('failed').waitFor();
  assert.match(await summary('failed').innerText(), /执行失败.*模拟轮次失败/s);
  assert.match(await summary('stopped').innerText(), /已停止/);
  await summary('failed').click();
  assert.equal(await process('failed').getByText('暂无可用过程记录').isVisible(), true);
  await process('failed').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/failure-390.png` });
  assert.equal(calls.some(call => call.method.startsWith('turn/')), false, 'tests send no model turns or approvals');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', widths: [320, 390], screenshots: artifacts, scenarios: 'collapsed-per-turn, final-and-unknown-visible, questions, markdown-images-table, lazy-long-output, live-action, unique-files, tool-failure, completed-status, stale-metadata, stable-dom-focus, pagination, switch-isolation, metadata-failure, drafts-answers, reconnect, failed-interrupted-empty' }));
} finally { await browser.close(); }
