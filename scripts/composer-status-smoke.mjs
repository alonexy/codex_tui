import assert from 'node:assert/strict';
import { createPlanMock } from './plan-mode-mock.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [320, 390, 1280]) {
    const { server, state, event } = createPlanMock();
    state.approvals = [];
    event('thread/status/changed', { threadId: 'plan-demo', status: { type: 'idle' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.locator('#choose-task').click();
      await page.locator('.task-row[data-thread-id="plan-demo"] .task-card').click();
      await page.waitForFunction(() => !document.querySelector('#send').disabled);
      await page.locator('#message').fill('模拟普通消息');
      await page.route('**/api/commands/*', async route => {
        await new Promise(resolve => setTimeout(resolve, 1200));
        await route.continue();
      });
      await page.evaluate(() => {
        window.statusSamples = [];
        const sample = () => {
          const status = document.querySelector('#delivery-status');
          window.statusSamples.push({ text: status.textContent, height: status.getBoundingClientRect().height, recovery: !document.querySelector('#recovery-actions').hidden });
        };
        sample();
        window.statusObserver = new MutationObserver(sample);
        window.statusObserver.observe(document.querySelector('#compose'), { attributes: true, childList: true, subtree: true, characterData: true });
      });
      await page.locator('#send').click();
      await page.waitForFunction(() => document.querySelector('#message').value === '' || document.querySelector('#error').textContent);
      assert.equal(await page.locator('#error').textContent(), '');
      await page.waitForFunction(() => !document.querySelector('#send').disabled);
      const samples = await page.evaluate(() => { window.statusObserver.disconnect(); return window.statusSamples; });
      const heights = [...new Set(samples.map(sample => sample.height))];
      console.log(JSON.stringify({ width, heights, states: [...new Set(samples.map(sample => sample.text))], recoveryFlashed: samples.some(sample => sample.recovery) }));
      assert.ok(!samples.some(sample => sample.recovery), 'ordinary successful sending must not flash recovery buttons');
      assert.ok(heights.every(height => height > 0) && Math.max(...heights) - Math.min(...heights) < 1, 'status row must keep its height during normal sending');
    } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
  }
} finally { await browser.close(); }
