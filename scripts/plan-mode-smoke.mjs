import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createPlanMock } from './plan-mode-mock.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const artifacts = 'output/playwright/plan-mode';
await mkdir(artifacts, { recursive: true });
const errors = [];
try {
  for (const width of [320, 390]) {
    const { server, calls, answers } = createPlanMock();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const control = body => fetch(`${origin}/mock/control`, { method: 'POST', body: JSON.stringify(body) });
    const closed = id => page.waitForFunction(id => !document.getElementById(id).open, id);
    const choose = async id => {
      if (!await page.locator('#task-dialog').evaluate(element => element.open)) await page.locator('#choose-task').click();
      await page.locator(`.task-row[data-thread-id="${id}"] .task-card`).click(); await closed('task-dialog');
    };
    const send = async text => {
      await page.locator('#message').fill(text); await page.locator('#send').click();
      await page.waitForFunction(() => document.querySelector('#message').value === '');
    };
    const setMode = async mode => { await page.locator('#plan-mode').click(); await page.locator(`#plan-mode-${mode}`).click(); };
    try {
      await page.goto(origin); await choose('plan-demo');
      await page.waitForFunction(() => document.querySelector('#compose').dataset.collaborationMode === 'default');
      const defaultBorder = await page.locator('.composer-box').evaluate(element => getComputedStyle(element).borderColor);
      const card = page.locator('.question-form');
      await card.locator('.question-option').filter({ hasText: '先完成核心流程' }).click();
      assert.equal(answers.length, 0, 'choosing must not submit');
      assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'INPUT');
      await card.getByRole('button', { name: '下一题', exact: true }).click();
      await card.locator('.question-panel:not([hidden])').getByRole('button', { name: '3 · 自行填写' }).click();
      await card.getByRole('textbox', { name: '交互偏好：自行填写' }).fill('我想逐题浏览，并保留选择。');
      await card.getByRole('button', { name: '上一题', exact: true }).click();
      assert.equal(await card.locator('.question-panel:not([hidden]) [aria-pressed="true"]').textContent().then(value => value.includes('先完成核心流程')), true);
      await card.getByRole('button', { name: '下一题', exact: true }).click();
      assert.equal(await card.getByRole('textbox', { name: '交互偏好：自行填写' }).inputValue(), '我想逐题浏览，并保留选择。');
      await card.getByRole('button', { name: '下一题', exact: true }).click();
      assert.equal(await card.locator('.question-send').isDisabled(), true);
      await card.locator('input[type="password"]').fill('mock-private');
      assert.equal(await card.locator('.question-send').isDisabled(), false);
      assert.equal((await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))).includes('mock-private'), false);
      await choose('other-demo'); assert.equal(await card.count(), 0);
      await choose('plan-demo'); assert.equal(await card.locator('input[type="password"]').inputValue(), 'mock-private');
      await control({ action: 'ready', value: false });
      await page.waitForFunction(() => document.querySelector('.question-send').disabled);
      await control({ action: 'ready', value: true });
      await page.waitForFunction(() => !document.querySelector('.question-send').disabled);
      await control({ action: 'reject-answer' }); await card.locator('.question-send').click();
      await page.waitForFunction(() => document.querySelector('.approval-card [role="status"]').textContent.includes('提交未确认') || [...document.querySelectorAll('.approval-card [role="status"]')].some(element => element.textContent.includes('提交未确认')));
      assert.equal(await card.locator('input[type="password"]').inputValue(), 'mock-private');
      await card.locator('.question-send').evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(() => !document.querySelector('.question-form'));
      assert.equal(answers.length, 1);
      assert.deepEqual(answers[0].result.answers, { scope: { answers: ['先完成核心流程（推荐）'] }, style: { answers: ['我想逐题浏览，并保留选择。'] }, private: { answers: ['mock-private'] } });

      await setMode('plan');
      assert.equal(await page.locator('#compose').getAttribute('data-collaboration-mode'), 'default', 'unsent choice must not look like active plan mode');
      assert.match(await page.locator('#plan-mode-label').innerText(), /下轮：计划/);
      await choose('other-demo'); assert.equal(await page.locator('#plan-mode').getAttribute('value'), '');
      await choose('plan-demo'); assert.equal(await page.locator('#plan-mode').getAttribute('value'), 'plan');
      await control({ action: 'settings', mode: 'default', effort: 'high' });
      await page.waitForTimeout(1100);
      assert.equal(await page.locator('#plan-mode').getAttribute('value'), 'plan');
      await control({ action: 'reject-turn' });
      await page.locator('#message').fill('先制定计划'); await page.locator('#send').click();
      await page.waitForFunction(() => document.querySelector('#error').textContent.includes('模拟发送失败'));
      assert.equal(await page.locator('#plan-mode').getAttribute('value'), 'plan');
      assert.equal(await page.locator('#message').inputValue(), '先制定计划');
      await send('先制定计划');
      await page.waitForFunction(() => document.querySelector('#compose').dataset.collaborationMode === 'plan');
      assert.equal(await page.locator('#plan-mode-title').innerText(), '计划模式');
      assert.notEqual(await page.locator('.composer-box').evaluate(element => getComputedStyle(element).borderColor), defaultBorder);
      await page.screenshot({ path: `${artifacts}/active-plan-${width}.png` });
      const start = calls.findLast(call => call.method === 'turn/start');
      assert.deepEqual(start.params.collaborationMode, { mode: 'plan', settings: { model: 'mock-model', reasoning_effort: 'high', developer_instructions: null } });
      await setMode('default');
      assert.equal(await page.locator('#compose').getAttribute('data-collaboration-mode'), 'plan');
      assert.equal(await page.locator('#plan-mode-title').innerText(), '计划模式');
      assert.match(await page.locator('#plan-mode-label').innerText(), /下轮：执行/);
      await send('追加计划上下文');
      const steer = calls.findLast(call => call.method === 'turn/steer');
      assert.ok(steer); assert.equal(Object.hasOwn(steer.params, 'collaborationMode'), false);
      assert.equal(await page.locator('#plan-mode').getAttribute('value'), 'default');
      await control({ action: 'idle' });
      await page.waitForFunction(() => document.querySelector('#send').getAttribute('aria-label') === '发送新一轮');

      // Merge the chosen model and effort inside collaborationMode.settings.
      await page.locator('#slash-toggle').click(); await page.locator('[data-command="/model"]').click();
      await page.waitForFunction(() => !document.querySelector('#model-choice').disabled);
      await page.locator('#model-choice').selectOption('mock-other'); await page.locator('#model-save').click(); await closed('model-dialog');
      await send('开始执行');
      await page.waitForFunction(() => document.querySelector('#compose').dataset.collaborationMode === 'default');
      assert.equal(await page.locator('#plan-mode-title').innerText(), '模式');
      const merged = calls.findLast(call => call.method === 'turn/start');
      assert.equal(merged.params.collaborationMode.mode, 'default');
      assert.equal(merged.params.collaborationMode.settings.model, 'mock-other');
      assert.equal(merged.params.collaborationMode.settings.reasoning_effort, 'high');
      await control({ action: 'idle' });
      await page.waitForFunction(() => document.querySelector('#send').getAttribute('aria-label') === '发送新一轮');

      // Unknown receipts survive reload without resubmitting the turn.
      await setMode('plan'); await control({ action: 'hold-receipt' });
      await page.locator('#message').fill('等待回执'); await page.locator('#send').click();
      await page.waitForFunction(() => !!sessionStorage.getItem('codex-pending'));
      const count = calls.filter(call => call.method === 'turn/start').length;
      await page.reload(); await page.waitForFunction(() => document.querySelector('#delivery-status').textContent.includes('待确认'));
      await control({ action: 'release-receipt' });
      await page.waitForFunction(() => !sessionStorage.getItem('codex-pending'));
      assert.equal(calls.filter(call => call.method === 'turn/start').length, count);
      assert.equal(await page.locator('#plan-mode').getAttribute('value'), '');
      await control({ action: 'questions' }); await card.waitFor();
      assert.equal(await page.locator('#questions .question-form').count(), 1);
      assert.equal(await page.locator('#approvals .question-form').count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
      assert.ok(await card.evaluate(element => element.scrollWidth <= element.clientWidth));
      for (const button of await card.locator('button:visible').all()) assert.ok((await button.boundingBox()).height >= 44);
      await page.screenshot({ path: `${artifacts}/questions-${width}.png` });
      await writeFile(`${artifacts}/questions-${width}.aria.txt`, await card.ariaSnapshot());
      await card.locator('.question-send').evaluate(button => button.scrollIntoView({ block: 'center' }));
      assert.ok(await card.locator('.question-send').evaluate(button => {
        const rect = button.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button;
      }), `sticky composer must not cover the answer button at ${width}`);
      await page.screenshot({ path: `${artifacts}/answer-button-${width}.png` });
      await control({ action: 'resolve' }); await page.waitForFunction(() => !document.querySelector('.question-form'));
      assert.equal(answers.length, 1, 'desktop resolution does not send a phone answer');
      await control({ action: 'settings', mode: 'future-mode' });
      await page.waitForFunction(() => document.querySelector('#compose').dataset.collaborationMode === 'unknown');
      assert.equal(await page.locator('.composer-box').evaluate(element => getComputedStyle(element).borderColor), defaultBorder);
      assert.equal(await page.locator('#plan-mode-value').innerText(), '选择模式');
      assert.equal(await page.locator('#plan-mode-label').innerText(), '');
      console.log(`PASS ${width}px: mode isolation, native parameters, settings/model merge, steer, failed and recovered receipts, numbered/custom/secret answers, offline/retry/double submit, desktop resolution, touch targets and overflow`);
    } catch (error) {
      await page.screenshot({ path: `${artifacts}/failure-${width}.png` });
      console.error(JSON.stringify({ errors, calls: calls.map(call => call.method), feedback: await page.locator('#error').innerText(), delivery: await page.locator('#delivery-status').innerText() }));
      throw error;
    } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
