import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createPlanMock } from './plan-mode-mock.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const artifacts = 'output/playwright/mode-menu';
await mkdir(artifacts, { recursive: true });
try {
  for (const width of [320, 390, 1280]) {
    const { server, state, modeRead, calls } = createPlanMock();
    state.approvals = []; state.events = []; state.threadSettings = {}; state.cursor = 0;
    state.active['plan-demo'] = 'current-turn';
    modeRead.set('plan-demo', { threadId: 'plan-demo', source: 'current-turn', turnId: 'current-turn', collaborationMode: { mode: 'default' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const choose = async id => {
      if (!await page.locator('#task-dialog').evaluate(element => element.open)) await page.locator('#choose-task').click();
      await page.locator(`.task-row[data-thread-id="${id}"] .task-card`).click();
      await page.waitForFunction(() => !document.querySelector('#task-dialog').open);
    };
    const focused = () => page.evaluate(() => document.activeElement.id);
    const closed = () => page.locator('#plan-mode-menu').isHidden();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`); await choose('plan-demo');
      assert.equal(await page.locator('#plan-mode').evaluate(element => element.tagName), 'BUTTON');
      assert.equal(await page.locator('.composer-mode-bar select').count(), 0);
      assert.equal((await page.locator('.plan-mode-control').boundingBox()).height, 30);
      const closedGap = await page.evaluate(() => document.querySelector('.composer-box').getBoundingClientRect().top - document.querySelector('.composer-mode-bar').getBoundingClientRect().bottom);
      await page.locator('#plan-mode').click();
      assert.equal(await page.locator('#plan-mode').getAttribute('aria-expanded'), 'true');
      assert.deepEqual(await page.locator('#plan-mode-menu button').allTextContents(), ['执行', '计划']);
      assert.equal(await focused(), 'plan-mode', 'opening must not focus the message input');
      const geometry = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height }; };
        return { panel: rect('#plan-mode-menu'), source: rect('#plan-mode-label'), bar: rect('.composer-mode-bar'), box: rect('.composer-box'), position: getComputedStyle(document.querySelector('#plan-mode-menu')).position };
      });
      assert.equal(geometry.position, 'static');
      assert.ok(geometry.panel.y >= geometry.bar.bottom, 'panel follows the mode bar in normal flow');
      assert.ok(geometry.panel.y >= geometry.source.bottom, 'panel does not overlap the source label');
      assert.ok(geometry.box.y >= geometry.panel.bottom, 'panel does not overlap the composer');
      assert.ok(geometry.box.y - geometry.bar.bottom >= closedGap + geometry.panel.height, 'expanded content consumes layout height');
      for (const button of await page.locator('#plan-mode-menu button').all()) {
        const rect = await button.boundingBox(); assert.ok(rect.height >= 44); assert.equal(rect.width, 88);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${artifacts}/expanded-${width}.png` });
      await page.locator('#plan-mode-default').focus(); await page.keyboard.press('Escape');
      assert.equal(await closed(), true); assert.equal(await focused(), 'plan-mode');
      await page.locator('#plan-mode').click(); await page.locator('#plan-mode-plan').click();
      assert.equal(await closed(), true); assert.equal(await focused(), 'plan-mode');
      assert.equal(await page.locator('#plan-mode-value').innerText(), '计划');
      assert.match(await page.locator('#plan-mode-label').innerText(), /下轮：计划/);
      assert.equal(await page.locator('#compose').getAttribute('data-collaboration-mode'), 'default');
      await page.locator('#plan-mode').click();
      const pendingSource = await page.locator('#plan-mode-label').boundingBox(), pendingPanel = await page.locator('#plan-mode-menu').boundingBox(), pendingBox = await page.locator('.composer-box').boundingBox();
      assert.ok(pendingSource.y + pendingSource.height <= pendingPanel.y, 'wrapped pending-mode text must remain above the panel');
      assert.ok(pendingPanel.y + pendingPanel.height <= pendingBox.y);
      await page.screenshot({ path: `${artifacts}/pending-expanded-${width}.png` });
      await page.locator('#plan-mode-clear').click();
      assert.equal(await closed(), true);
      assert.equal(await page.locator('#plan-mode').getAttribute('value'), '');
      assert.equal(await focused(), 'plan-mode');
      await page.locator('#plan-mode').click(); await choose('other-demo');
      assert.equal(await closed(), true);
      await choose('plan-demo'); await page.locator('#plan-mode').click();
      await page.locator('#message').fill('mock steer'); await page.locator('#send').click();
      await page.waitForFunction(() => !document.querySelector('#message').value);
      assert.equal(await closed(), true);
      assert.equal(Object.hasOwn(calls.findLast(call => call.method === 'turn/steer').params, 'collaborationMode'), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: exactly two inline options, 30px capsule, non-overlapping source/panel/composer, layout expansion, Escape/focus, choice/clear, task switch and send close`);
    } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
  }
} finally { await browser.close(); }
