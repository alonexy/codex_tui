import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createPlanMock } from './plan-mode-mock.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const artifacts = 'output/playwright/mode-sync';
await mkdir(artifacts, { recursive: true });
try {
  for (const width of [320, 390]) {
    const { server, state, calls, modeRead } = createPlanMock();
    state.threadSettings = {}; state.events = []; state.approvals = []; state.cursor = 0;
    delete state.capabilities.threadSettings;
    state.active['plan-demo'] = 'turn-one';
    const result = { threadId: 'plan-demo', collaborationMode: { mode: 'plan' }, turnId: 'turn-one', source: 'current-turn' };
    modeRead.set('plan-demo', result);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const choose = async id => {
      if (!await page.locator('#task-dialog').evaluate(element => element.open)) await page.locator('#choose-task').click();
      await page.locator(`.task-row[data-thread-id="${id}"] .task-card`).click();
      await page.waitForFunction(() => !document.querySelector('#task-dialog').open);
    };
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`); await choose('plan-demo');
      assert.equal(await page.locator('#compose').getAttribute('data-collaboration-mode'), 'plan');
      assert.equal(await page.locator('#plan-mode-label').innerText(), '本轮');
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#plan-mode-label').textContent === '本轮');
      await page.screenshot({ path: `${artifacts}/current-turn-${width}.png` });
      delete state.active['plan-demo']; modeRead.set('plan-demo', { ...result, source: 'last-turn' });
      state.events.push({ cursor: ++state.cursor, method: 'turn/completed', params: { threadId: 'plan-demo', turn: { id: 'turn-one', status: 'completed' } } });
      await page.waitForFunction(() => document.querySelector('#plan-mode-label').textContent === '最近一轮');
      assert.equal(await page.locator('#compose').getAttribute('data-collaboration-mode'), 'unknown');
      assert.equal(await page.locator('#plan-mode-value').innerText(), '计划');
      await page.screenshot({ path: `${artifacts}/last-turn-${width}.png` });
      await page.locator('#slash-toggle').click(); await page.locator('[data-command="/model"]').click();
      await page.waitForFunction(() => !document.querySelector('#model-choice').disabled);
      await page.locator('#model-choice').selectOption('mock-other'); await page.locator('#model-save').click();
      await page.locator('#message').fill('mock model override'); await page.locator('#send').click();
      await page.waitForFunction(() => !document.querySelector('#message').value);
      assert.equal(Object.hasOwn(calls.findLast(call => call.method === 'turn/start').params, 'collaborationMode'), false);
      await page.locator('#plan-mode').click(); await page.locator('#plan-mode-plan').click(); await choose('other-demo');
      assert.equal(await page.locator('#plan-mode-value').innerText(), '选择模式');
      assert.equal(await page.locator('#plan-mode-label').innerText(), '');
      await choose('plan-demo'); assert.equal(await page.locator('#plan-mode').getAttribute('value'), 'plan');
      assert.match(await page.locator('#plan-mode-label').innerText(), /下轮：计划/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: initial current-turn sync on old bridge, reload, completed-turn downgrade, historical model override isolation, task isolation and compact unavailable mode`);
    } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
  }
} finally { await browser.close(); }
