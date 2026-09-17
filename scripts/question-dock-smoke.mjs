import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createPlanMock } from './plan-mode-mock.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const artifacts = 'output/playwright/question-dock';
await mkdir(artifacts, { recursive: true });
try {
  for (const width of [320, 390, 1280]) {
    const { server, state, answers, calls } = createPlanMock();
    state.approvals[0].params.questions[0].options[0].description = '长选项说明，需要能在卡片内部滚动阅读。'.repeat(24);
    state.approvals.push({ id: 'ordinary', method: 'item/commandExecution/requestApproval', params: { threadId: 'plan-demo', command: 'echo mock' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.locator('#choose-task').click();
      await page.locator('.task-row[data-thread-id="plan-demo"] .task-card').click();
      const form = page.locator('#questions .question-form'); await form.waitFor();
      assert.equal(await page.locator('#approvals [data-request-id="ordinary"]').count(), 1);
      assert.equal(await page.locator('#compose form').count(), 0);
      await page.evaluate(() => {
        const history = document.querySelector('#history');
        const filler = document.createElement('div'); filler.style.height = '2400px'; filler.textContent = '长对话布局测试'; history.append(filler);
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      async function geometry(label, bottom = 844) {
        const result = await page.evaluate(() => {
          const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
          const hit = selector => { const el = document.querySelector(selector), r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); };
          const scroll = document.querySelector('.question-scroll');
          return { dock: rect('#interaction-dock'), questions: rect('#questions'), compose: rect('#compose'), scroll: rect('.question-scroll'), footer: rect('.question-footer'), nextHit: hit('.question-navigation button:last-child'), sendHit: hit('.question-send'), scrolls: scroll.scrollHeight > scroll.clientHeight, overflow: document.documentElement.scrollWidth > innerWidth };
        });
        assert.ok(result.dock.bottom <= bottom + 1, `${label}: dock below viewport ${JSON.stringify(result)}`);
        assert.ok(result.dock.top >= 72, `${label}: dock under header ${JSON.stringify(result)}`);
        assert.ok(Math.abs(result.questions.bottom - result.compose.top) < 2, `${label}: card not adjacent`);
        assert.ok(result.scroll.height >= 48 && result.scroll.bottom <= result.footer.top + 1, `${label}: question scroll and footer overlap`);
        assert.ok(result.nextHit && result.sendHit && !result.overflow, `${label}: buttons obscured or horizontal overflow ${JSON.stringify(result)}`);
        return result;
      }
      assert.ok((await geometry('expanded')).scrolls);
      await page.screenshot({ path: `${artifacts}/expanded-${width}.png` });
      await form.getByRole('button', { name: '收起', exact: true }).click();
      assert.match(await form.innerText(), /待回答 · 共 3 题/);
      assert.ok((await form.boundingBox()).height <= 48);
      await form.getByRole('button', { name: '展开回答', exact: true }).click();
      await form.getByRole('button', { name: '下一题', exact: true }).click();
      await form.getByRole('button', { name: '3 · 自行填写' }).click();
      await form.getByRole('textbox').fill('切换和收起后应保留');
      // A visual viewport shrink models an on-screen keyboard without changing protocol state.
      await page.evaluate(() => {
        const viewport = new EventTarget(); Object.assign(viewport, { height: 460, offsetTop: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        window.dispatchEvent(new Event('resize'));
      });
      await page.waitForTimeout(100);
      await geometry('keyboard', 460);
      await page.screenshot({ path: `${artifacts}/keyboard-${width}.png` });
      await form.getByRole('button', { name: '收起', exact: true }).click();
      await form.getByRole('button', { name: '展开回答', exact: true }).click();
      assert.equal(await form.getByRole('textbox').inputValue(), '切换和收起后应保留');
      assert.equal(answers.length, 0); assert.equal(calls.filter(call => call.method.startsWith('turn/')).length, 0);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: long conversation/options, dock adjacency, independent forms, ordinary approval position, internal scroll, visible navigation/submit, collapse draft, simulated keyboard`);
    } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
  }
} finally { await browser.close(); }
