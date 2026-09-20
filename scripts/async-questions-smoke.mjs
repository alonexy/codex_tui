import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createPlanMock } from './plan-mode-mock.mjs';
import { parseQuestionReply } from '../public/async-questions.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const artifacts = 'output/playwright/async-questions';
await mkdir(artifacts, { recursive: true });
try {
  for (const width of [320, 390, 1280]) {
    const mock = createPlanMock();
    const { server, state, tasks, calls, event } = mock;
    state.approvals = []; state.active['plan-demo'] = 'mock-turn';
    event('thread/status/changed', { threadId: 'plan-demo', status: { type: 'active', activeFlags: [] } });
    const source = { id: 'async-source', type: 'agentMessage', text: '请确认接下来的处理方式。', phase: 'commentary', questions: [
      { title: '优先完成哪一部分？', options: ['先完成主要流程', '补齐所有边界'] },
      { title: '还有哪些需要保留的细节？' },
    ] };
    const turn = { id: 'mock-turn', status: 'inProgress', items: [source] };
    tasks.get('plan-demo').turns = [turn];
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const control = body => fetch(`${base}/mock/control`, { method: 'POST', body: JSON.stringify(body) });
    const turns = () => calls.filter(call => ['turn/start', 'turn/steer'].includes(call.method));
    try {
      await page.clock.install();
      await page.goto(base);
      await page.locator('#choose-task').click();
      await page.locator('.task-row[data-thread-id="plan-demo"] .task-card').click();
      const card = page.locator('#questions .async-question-card'); await card.waitFor();
      assert.equal(await page.locator('#history .question-history').count(), 2);
      assert.match(await page.locator('#approval-reminder-text').innerText(), /异步问题待回答/);
      assert.ok(!(await page.locator('#approvals').innerText()).includes('需在桌面处理'));
      await page.clock.fastForward(59_000);
      await card.getByRole('button', { name: '1 先完成主要流程' }).evaluate(button => button.click());
      await page.clock.fastForward(2_000);
      assert.equal(await card.locator('.question-body').isVisible(), true, 'click-only activation restarts idle time');
      await page.clock.fastForward(61_000);
      assert.equal(await card.locator('.question-body').isVisible(), false, 'idle async question collapses');
      assert.match(await card.locator('.question-top').innerText(), /待回答 · 共 2 题/);
      assert.equal(turns().length, 0, 'idle never submits');
      await card.getByRole('button', { name: '展开回答' }).click();
      await page.locator('#message').fill('普通输入草稿应保留');
      await card.getByRole('button', { name: '1 先完成主要流程' }).click();
      await card.getByRole('button', { name: '下一题', exact: true }).click();
      await card.getByRole('textbox').fill('保留我的输入与附件');
      await page.clock.fastForward(61_000);
      assert.equal(await card.locator('.question-body').isVisible(), true, 'focused text input prevents collapse');
      await page.locator('#message').focus();
      await page.clock.fastForward(45_000);
      await card.getByRole('button', { name: '上一题', exact: true }).click();
      await page.clock.fastForward(45_000);
      assert.equal(await card.locator('.question-body').isVisible(), true, 'interaction restarts the idle period');
      await page.clock.fastForward(16_000);
      assert.equal(await card.locator('.question-body').isVisible(), false);
      await card.getByRole('button', { name: '展开回答' }).click();
      await card.getByRole('button', { name: '下一题', exact: true }).click();
      assert.equal(await card.getByRole('textbox').inputValue(), '保留我的输入与附件', 'idle collapse preserves drafts and choices');
      assert.equal(await card.locator('.question-send').isEnabled(), true);
      assert.equal(turns().length, 0);
      await card.getByRole('textbox').focus();
      await page.waitForTimeout(1200);
      assert.equal(await card.getByRole('textbox').inputValue(), '保留我的输入与附件');
      assert.equal(await card.getByRole('textbox').evaluate(el => document.activeElement === el), true);
      if (width === 390) {
        await control({ action: 'ready', value: false });
        await page.waitForFunction(() => document.querySelector('#questions .question-send')?.disabled);
        assert.equal(turns().length, 0);
        await control({ action: 'ready', value: true });
        await page.waitForFunction(() => !document.querySelector('#questions .question-send')?.disabled);
        assert.equal(await card.getByRole('textbox').inputValue(), '保留我的输入与附件');
      }
      const geometry = await page.evaluate(() => {
        const q = document.querySelector('#questions').getBoundingClientRect(), c = document.querySelector('#compose').getBoundingClientRect();
        const send = document.querySelector('#questions .question-send'), r = send.getBoundingClientRect();
        return { adjacent: Math.abs(q.bottom - c.top) < 2, visible: send.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(geometry, { adjacent: true, visible: true, overflow: false });
      await page.screenshot({ path: `${artifacts}/questions-${width}.png` });
      await control({ action: 'reject-turn' });
      await card.locator('.question-send').click();
      await page.waitForFunction(() => document.querySelector('.async-question-card > [role="status"]')?.textContent.includes('发送失败'));
      assert.equal(await card.getByRole('textbox').inputValue(), '保留我的输入与附件');
      if (width === 390) await control({ action: 'hold-receipt' });
      await card.locator('.question-form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
      await page.waitForFunction(() => document.querySelector('.async-question-card')?.dataset.submission === 'waiting');
      assert.equal(await page.locator('#message').inputValue(), '普通输入草稿应保留');
      assert.equal(turns().length, 2);
      assert.equal(turns().at(-1).method, 'turn/steer');
      const replies = parseQuestionReply(turns().at(-1).params.input[0].text);
      assert.equal(replies.length, 2); assert.equal(replies[1].answer, '保留我的输入与附件');
      assert.equal(mock.answers.length, 0);
      await page.reload();
      await card.waitFor();
      assert.equal(await card.locator('.question-form').isVisible(), false);
      assert.equal(turns().length, 2, 'reload must not replay unknown or accepted replies');
      if (width === 390) {
        assert.match(await card.innerText(), /待确认/);
        await control({ action: 'release-receipt' });
      }
      await page.waitForFunction(() => document.querySelector('.async-question-card')?.textContent.includes('回答已提交'));
      // Desktop accepted input resolves questions even before its normal user-message echo arrives.
      const answer = { id: 'steering-answer', type: 'steeringUserMessage', status: 'accepted', serverUserMessageId: 'user-answer', input: turns().at(-1).params.input };
      turn.items.push(answer); event('item/completed', { threadId: 'plan-demo', turnId: turn.id, item: answer });
      await page.waitForFunction(() => document.querySelectorAll('#questions .async-question-card').length === 0);
      assert.equal(await page.locator('#approval-reminder').isVisible(), false);
      assert.equal(await page.locator('#history .question-answer').count(), 2);
      const echo = { id: 'user-answer', type: 'userMessage', content: answer.input };
      turn.items.push(echo); event('item/completed', { threadId: 'plan-demo', turnId: turn.id, item: echo });
      await page.waitForTimeout(1200);
      assert.equal(await page.locator('#history .question-answer').count(), 2);
      assert.ok(!(await page.locator('#history').innerText()).includes('<send_user_message_question_reply>'));
      await page.screenshot({ path: `${artifacts}/answered-${width}.png` });
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: dock geometry, pure freeform, stable draft/focus, steer failure/retry, receipt reload without replay, desktop accepted clear, identified echo dedup, readable history`);
    } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
  }
} finally { await browser.close(); }
