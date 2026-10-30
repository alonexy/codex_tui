import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Broker } from '../src/broker.mjs';
import { createWebServer } from '../src/http.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const origin = 'http://127.0.0.1:19794', artifacts = 'output/playwright/mcp-approval';
const tasks = ['one', 'two'].map(id => ({ id, name: `MCP 授权验收 ${id}`, cwd: '/mock', turns: [], status: { type: 'idle' } }));
const answers = [], errors = [], calls = [];
const broker = new Broker(message => {
  if (!message.method) { answers.push(message); return; }
  calls.push(message.method);
  let result;
  if (message.method === 'thread/list') result = { data: tasks, nextCursor: null };
  else if (['thread/read', 'thread/resume'].includes(message.method)) result = { thread: tasks.find(task => task.id === message.params.threadId), initialTurnsPage: { data: [] } };
  else if (['thread/items/list', 'thread/turns/list'].includes(message.method)) result = { data: [], nextCursor: null };
  else if (message.method === 'account/rateLimits/read') result = { rateLimits: null };
  else throw Error(`Unexpected execution: ${message.method}`);
  queueMicrotask(() => broker.receive({ id: message.id, result }));
});
broker.ready = true;
const request = (id, threadId = 'one', extra = {}) => ({ id, method: 'mcpServer/elicitation/request', params: {
  threadId, turnId: 'turn', serverName: 'cua_repl', mode: 'form',
  message: 'Allow Browser use to use full Chrome Developer Tools access on https://example.test?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: { connector_name: 'Browser use', tool_title: 'Use raw CDP on browser origin', tool_name: 'access_browser_origin_with_raw_cdp',
    full_cdp_access: true, origin: 'https://example.test', persist: 'always', riskLevel: 'high' }, ...extra,
} });
const server = createWebServer(broker, { password: 'isolated-mcp-smoke', origin, readModels: async () => ({ models: [] }), modes: { register() {}, read: async () => null } });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(19794, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  assert.equal((await context.request.post(`${origin}/api/login`, { headers: { Origin: origin }, data: { password: 'isolated-mcp-smoke' } })).status(), 200);
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/projects', route => route.fulfill({ json: { projects: [], assignments: {} } }));
  await page.addInitScript(() => sessionStorage.setItem('codex-thread', 'one'));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#status').textContent === '已连接');
  const card = id => page.locator(`.approval-card[data-request-id="${id}"]`);
  const choose = async id => {
    await page.locator('#choose-task').click();
    await page.locator(`.task-row[data-thread-id="${id}"] .task-card`).click();
    await page.waitForFunction(() => !document.querySelector('#task-dialog').open);
  };
  broker.receive(request(42)); broker.receive(request('other', 'two'));
  await card(42).waitFor();
  assert.match(await card(42).innerText(), /完整 Chrome DevTools 访问（完整 CDP 权限）/);
  assert.match(await card(42).innerText(), /风险等级.*高风险（high）.*持续授权（always）/s);
  assert.doesNotMatch(await card(42).innerText(), /允许这一次|需在桌面处理/);
  assert.match(await page.locator('#approval-reminder').innerText(), /1 项待批准/);
  assert.equal(answers.length, 0);
  await page.locator('#open-current-approval').click();
  await mkdir(artifacts, { recursive: true });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await card(42).locator('button').first().scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    for (const button of await card(42).locator('button').all()) {
      const bounds = await button.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.height >= 44);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${artifacts}/confirmation-${width}.png` });
    const distance = await card(42).locator('.mcp-approval-actions').evaluate(element =>
      element.getBoundingClientRect().bottom - document.querySelector('#interaction-dock').getBoundingClientRect().top + 20);
    await page.mouse.move(width / 2, 200);
    await page.mouse.wheel(0, distance);
    await page.waitForFunction(() => {
      const button = document.querySelector('.mcp-approval-actions button:last-child'), box = button.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button;
    });
    for (const button of await card(42).locator('button').all()) assert.ok(await button.evaluate(element => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
    }), 'approval actions are visible above the sticky composer');
    await page.screenshot({ path: `${artifacts}/actions-${width}.png` });
  }
  await page.locator('#message').fill('保留当前草稿');
  await page.locator('#choose-task').click();
  assert.match(await page.locator('.pending-task[data-pending-thread="two"]').innerText(), /1 项待批准/);
  await page.locator('.pending-task[data-pending-thread="two"]').click();
  await page.waitForFunction(() => !document.querySelector('#task-dialog').open);
  assert.equal(await card(42).count(), 1, 'pending panel preserves the current conversation');
  await card('other').getByRole('button', { name: '拒绝', exact: true }).click();
  await card('other').waitFor({ state: 'detached' });
  assert.deepEqual(answers, [{ id: 'other', result: { action: 'decline' } }]);
  await page.locator('#close-pending').click();
  await choose('one');
  assert.equal(await page.locator('#message').inputValue(), '保留当前草稿');
  broker.ready = false;
  await page.waitForFunction(() => document.querySelector('#status').textContent !== '已连接');
  assert.equal(await card(42).getByRole('button', { name: '允许并记住授权' }).isDisabled(), true);
  assert.match(await page.locator('#approval-reminder').innerText(), /待核对/);
  await page.screenshot({ path: `${artifacts}/disconnected-390.png`, fullPage: true });
  broker.ready = true;
  await page.waitForFunction(() => document.querySelector('#status').textContent === '已连接');
  await page.setViewportSize({ width: 320, height: 844 });
  await card(42).getByRole('button', { name: '允许并记住授权' }).click();
  await card(42).waitFor({ state: 'detached' });
  assert.deepEqual(answers.at(-1), { id: 42, result: { action: 'accept', content: {} } });
  assert.equal(answers.length, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  broker.receive(request('resolved'));
  await card('resolved').waitFor();
  broker.receive({ method: 'serverRequest/resolved', params: { requestId: 'resolved', threadId: 'one' } });
  await card('resolved').waitFor({ state: 'detached' });
  assert.equal(answers.length, 2);
  broker.receive(request('unsupported', 'one', { requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }));
  await card('unsupported').waitFor();
  assert.match(await card('unsupported').innerText(), /需在桌面处理/);
  assert.equal(await card('unsupported').locator('button').count(), 0);
  await page.screenshot({ path: `${artifacts}/unsupported-390.png`, fullPage: true });
  broker.receive(request('cancel'));
  await card('cancel').getByRole('button', { name: '取消', exact: true }).click();
  await card('cancel').waitFor({ state: 'detached' });
  assert.deepEqual(answers.at(-1), { id: 'cancel', result: { action: 'cancel' } });
  assert.deepEqual(errors, []);
  assert.ok(calls.every(method => !['turn/start', 'turn/steer'].includes(method)));
  await writeFile(`${artifacts}/report.json`, JSON.stringify({ widths: [320, 390], answers, errors, checks: ['scope', 'persistent consent', 'task ownership', 'draft preservation', 'disconnect', 'resolved', 'unsupported form', 'no automatic answer'] }, null, 2));
  console.log(`MCP approval smoke passed: ${artifacts}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
