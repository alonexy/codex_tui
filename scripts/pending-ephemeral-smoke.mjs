import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Broker } from '../src/broker.mjs';
import { createWebServer } from '../src/http.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const origin = 'http://127.0.0.1:19795', artifacts = 'output/playwright/pending-ephemeral';
const task = { id: 'current', name: '当前会话', cwd: '/mock', turns: [], status: { type: 'idle' } };
const temporary = { id: 'temporary-thread', ephemeral: true, path: null, source: 'vscode', turns: [], status: { type: 'active', activeFlags: ['waitingOnApproval'] } };
const answers = [], calls = [], errors = [];
let urlCapability = true;
const broker = new Broker(message => {
  if (!message.method) { answers.push(message); return; }
  calls.push({ method: message.method, params: message.params });
  let result;
  if (message.method === 'thread/list') result = { data: message.params.archived ? [] : [task], nextCursor: null };
  else if (['thread/read', 'thread/resume'].includes(message.method)) result = { thread: message.params.threadId === temporary.id ? temporary : task, initialTurnsPage: { data: [] } };
  else if (['thread/items/list', 'thread/turns/list'].includes(message.method)) result = { data: [], nextCursor: null };
  else if (message.method === 'account/rateLimits/read') result = { rateLimits: null };
  else throw Error(`Unexpected execution: ${message.method}`);
  queueMicrotask(() => broker.receive({ id: message.id, result }));
});
broker.ready = true;
const snapshot = broker.snapshot.bind(broker);
broker.snapshot = after => {
  const state = snapshot(after);
  if (!urlCapability) delete state.capabilities.mcpUrlElicitation;
  return state;
};
const request = (id, extra = {}) => ({ id, method: 'mcpServer/elicitation/request', params: {
  threadId: temporary.id, serverName: 'codex_apps', mode: 'url', message: 'Connect Example on ChatGPT to use it in Codex.',
  elicitationId: `elicitation-${id}`, url: 'https://example.test/connect',
  _meta: { _codex_apps: { connector_auth_failure: { connector_name: 'Example', auth_reason: 'missing_link', install_url: 'https://example.test/connect' } } }, ...extra,
} });
const server = createWebServer(broker, { password: 'isolated-url-smoke', origin, readModels: async () => ({ models: [] }), modes: { register() {}, read: async () => null } });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(19795, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const navigations = [];
  await context.route('https://example.test/**', async route => {
    navigations.push({ url: route.request().url(), referer: route.request().headers().referer });
    await route.fulfill({ contentType: 'text/html', body: '<title>Isolated authorization fixture</title><p>Complete the mock flow yourself.</p>' });
  });
  await context.request.post(`${origin}/api/login`, { headers: { Origin: origin }, data: { password: 'isolated-url-smoke' } });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/projects', route => route.fulfill({ json: { projects: [], assignments: {} } }));
  await page.addInitScript(() => sessionStorage.setItem('codex-thread', 'current'));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#status').textContent === '已连接');
  await page.waitForFunction(() => document.querySelector('#conversation-title').textContent === '当前会话');
  await page.locator('#message').fill('保留当前会话草稿');
  const before = calls.length;
  broker.receive(request('temporary-request'));
  await page.locator('#choose-task').click();
  await page.locator('.pending-task[data-pending-thread="temporary-thread"]').click();
  const panel = page.locator('#pending-dialog');
  try { await panel.waitFor({ state: 'visible' }); }
  catch (error) {
    console.error('Pending entry did not open independent request panel:', await page.locator('#pending-error').innerText());
    throw error;
  }
  assert.match(await panel.innerText(), /https:\/\/example.test\/connect/);
  assert.equal(await page.locator('#message').inputValue(), '保留当前会话草稿');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('codex-thread')), 'current');
  assert.deepEqual(calls.slice(before).filter(call => ['thread/list', 'thread/resume', 'thread/unarchive'].includes(call.method)), []);
  assert.equal(answers.length, 0);
  assert.deepEqual(navigations, []);
  assert.match(await panel.innerText(), /Example.*codex_apps/s);
  assert.match(await panel.innerText(), /自行完成授权/);
  await mkdir(artifacts, { recursive: true });
  const card = id => panel.locator(`.approval-card[data-request-id="${id}"]`);
  const open = async (id = 'temporary-thread') => {
    if (await panel.isVisible()) await page.locator('#close-pending').click();
    await page.locator('#choose-task').click();
    await page.locator(`.pending-task[data-pending-thread="${id}"]`).click();
    await panel.waitFor({ state: 'visible' });
  };
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await panel.locator('.mcp-approval-actions').scrollIntoViewIfNeeded();
    for (const button of await panel.locator('button').all()) {
      await button.scrollIntoViewIfNeeded();
      assert.ok(await button.evaluate(element => {
        const box = element.getBoundingClientRect();
        return box.x >= 0 && box.right <= innerWidth && box.height >= 44 && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
      }), `panel button is hittable at ${width}`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${artifacts}/request-${width}.png` });
    await page.locator('#close-pending').click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await page.locator('#message').inputValue(), '保留当前会话草稿');
    await open();
  }

  // Old resident bridges allow viewing but never open an unanswerable authorization page.
  urlCapability = false;
  await card('temporary-request').getByRole('button', { name: '打开授权页' }).waitFor();
  await page.waitForFunction(() => document.querySelector('#pending-dialog [data-action="accept"]').disabled);
  assert.match(await panel.innerText(), /加载新版桥接/);
  await page.screenshot({ path: `${artifacts}/old-bridge-390.png` });
  assert.equal(answers.length, 0); assert.equal(navigations.length, 0);
  urlCapability = true;
  await page.waitForFunction(() => !document.querySelector('#pending-dialog [data-action="accept"]').disabled);

  // Blocked popup does not consume the request; retry opens exactly once with no opener/referrer.
  await page.evaluate(() => { window.originalOpen = window.open; window.open = () => null; });
  await card('temporary-request').getByRole('button', { name: '打开授权页' }).click();
  assert.match(await card('temporary-request').innerText(), /未打开授权页.*尚未提交回复/s);
  assert.equal(answers.length, 0);
  await page.evaluate(() => { window.open = window.originalOpen; });
  const popupPromise = context.waitForEvent('page');
  await card('temporary-request').getByRole('button', { name: '打开授权页' }).click();
  const popup = await popupPromise;
  await popup.waitForURL('https://example.test/connect');
  assert.equal(await popup.evaluate(() => window.opener), null);
  assert.equal(await popup.evaluate(() => document.referrer), '');
  assert.deepEqual(navigations, [{ url: 'https://example.test/connect', referer: undefined }]);
  await card('temporary-request').waitFor({ state: 'detached' });
  assert.deepEqual(answers, [{ id: 'temporary-request', result: { action: 'accept' } }]);
  assert.match(await page.locator('#pending-dialog-status').innerText(), /连接是否完成尚未确认/);
  await popup.close();

  for (const [id, name, action] of [['decline', '拒绝', 'decline'], ['cancel', '取消', 'cancel']]) {
    broker.receive(request(id));
    await card(id).getByRole('button', { name, exact: true }).click();
    await card(id).waitFor({ state: 'detached' });
    assert.deepEqual(answers.at(-1), { id, result: { action } });
  }
  assert.equal(navigations.length, 1);

  for (const [id, url] of [['scheme', 'javascript:alert(1)'], ['credentials', 'https://user:pass@example.test/connect']]) {
    broker.receive(request(id, { url }));
    await card(id).waitFor();
    assert.equal(await card(id).locator('button').count(), 0);
    assert.match(await card(id).innerText(), /需在桌面处理/);
    broker.receive({ method: 'serverRequest/resolved', params: { requestId: id } });
    await card(id).waitFor({ state: 'detached' });
  }

  broker.receive(request('offline'));
  await card('offline').waitFor();
  broker.ready = false;
  await page.waitForFunction(() => document.querySelector('#status').textContent !== '已连接');
  assert.equal(await card('offline').getByRole('button', { name: '打开授权页' }).isDisabled(), true);
  await page.screenshot({ path: `${artifacts}/disconnected-390.png` });
  await page.locator('#close-pending').click(); await open();
  assert.match(await panel.innerText(), /Connect Example/);
  broker.ready = true;
  await page.waitForFunction(() => document.querySelector('#status').textContent === '已连接');
  broker.receive({ method: 'serverRequest/resolved', params: { requestId: 'offline' } });
  await card('offline').waitFor({ state: 'detached' });

  // The desktop wins after the phone click but before its HTTP answer reaches the Broker.
  broker.receive(request('desktop-race'));
  await page.route('**/api/answer', async route => {
    broker.fromDesktop({ id: 'desktop-race', result: { action: 'cancel' } });
    await route.continue();
  });
  await card('desktop-race').getByRole('button', { name: '拒绝', exact: true }).click();
  await card('desktop-race').waitFor({ state: 'detached' });
  assert.deepEqual(answers.filter(answer => answer.id === 'desktop-race'), [{ id: 'desktop-race', result: { action: 'cancel' } }]);
  await page.unroute('**/api/answer');

  // A failed submission can only be retried manually, without opening the URL twice.
  broker.receive(request('retry'));
  let answerAttempts = 0;
  await page.route('**/api/answer', async route => {
    answerAttempts++;
    if (answerAttempts === 1) await route.fulfill({ status: 503, json: { error: 'isolated failure' } });
    else await route.continue();
  });
  const retryPopup = context.waitForEvent('page');
  await card('retry').getByRole('button', { name: '打开授权页' }).click();
  const opened = await retryPopup; await opened.waitForURL('https://example.test/connect');
  await card('retry').getByRole('button', { name: '重试提交同意前往' }).waitFor();
  assert.match(await card('retry').innerText(), /提交未确认.*重试只提交回复/s);
  const response = page.waitForResponse(value => value.url().includes('/api/state?'));
  await response;
  assert.equal(answerAttempts, 1);
  await card('retry').getByRole('button', { name: '重试提交同意前往' }).click();
  await card('retry').waitFor({ state: 'detached' });
  assert.equal(answerAttempts, 2); assert.equal(navigations.length, 2);
  assert.deepEqual(answers.filter(answer => answer.id === 'retry'), [{ id: 'retry', result: { action: 'accept' } }]);
  await opened.close(); await page.unroute('**/api/answer');

  broker.receive(request('double'));
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/answer', async route => { await held; await route.continue(); });
  await card('double').getByRole('button', { name: '取消', exact: true }).evaluate(button => { button.click(); button.click(); });
  assert.equal(await card('double').getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
  release();
  await card('double').waitFor({ state: 'detached' });
  assert.equal(answers.filter(answer => answer.id === 'double').length, 1);
  await page.unroute('**/api/answer');

  // The independent panel reuses native approval controls and preserves multi-question drafts.
  for (const [id, method, decision] of [
    ['command', 'item/commandExecution/requestApproval', 'accept'],
    ['files', 'item/fileChange/requestApproval', 'decline'],
  ]) {
    broker.receive({ id, method, params: { threadId: temporary.id, command: 'npm test', reason: 'Isolated native approval' } });
    await card(id).getByRole('button', { name: decision === 'accept' ? '允许这一次' : '拒绝', exact: true }).click();
    await card(id).waitFor({ state: 'detached' });
    assert.deepEqual(answers.at(-1), { id, result: { decision } });
    assert.equal(await page.evaluate(() => sessionStorage.getItem('codex-thread')), 'current');
  }
  broker.receive({ id: 'questions', method: 'item/tool/requestUserInput', params: { threadId: task.id, questions: [
    { id: 'first', question: 'First native question?' }, { id: 'second', question: 'Second native question?' },
  ] } });
  await open('current');
  await card('questions').locator('input[data-question-id="first"]').fill('First retained answer');
  await card('questions').getByRole('button', { name: '下一题' }).click();
  await card('questions').locator('input[data-question-id="second"]').fill('Second retained answer');
  await page.locator('#close-pending').click();
  const dockCard = page.locator('#questions .approval-card[data-request-id="questions"]');
  await dockCard.waitFor();
  assert.equal(await dockCard.locator('input[data-question-id="second"]').inputValue(), 'Second retained answer');
  await open('current');
  assert.equal(await card('questions').locator('input[data-question-id="first"]').inputValue(), 'First retained answer');
  assert.equal(await card('questions').locator('input[data-question-id="second"]').inputValue(), 'Second retained answer');
  assert.equal(await page.locator('#questions .approval-card[data-request-id="questions"]').count(), 0);
  await card('questions').getByRole('button', { name: '发送全部回答' }).click();
  await card('questions').waitFor({ state: 'detached' });
  assert.deepEqual(answers.at(-1), { id: 'questions', result: { answers: {
    first: { answers: ['First retained answer'] }, second: { answers: ['Second retained answer'] },
  } } });
  await page.locator('#close-pending').click();
  assert.equal(await page.locator('#message').inputValue(), '保留当前会话草稿');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('codex-thread')), 'current');
  assert.ok(!calls.some(call => call.params?.threadId === temporary.id), 'pending actions never resume or read temporary thread');
  assert.deepEqual(errors, []);
  await writeFile(`${artifacts}/report.json`, JSON.stringify({ widths: [320, 390], answers, navigations, errors, checks: ['ephemeral pending panel', 'draft preservation', 'no thread list/resume/unarchive', 'old bridge capability', 'blocked popup', 'opener and referrer isolation', 'accept is not completion', 'decline/cancel', 'unsafe URLs', 'disconnect', 'resolved', 'desktop race', 'manual retry without reopening', 'duplicate click', 'native command/file decisions without switching', 'multi-question drafts across panel and current dock'] }, null, 2));
  console.log(`Pending ephemeral smoke passed: ${artifacts}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
