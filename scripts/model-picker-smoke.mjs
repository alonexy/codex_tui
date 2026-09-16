import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const artifacts = 'output/playwright/model-picker';
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const origin = 'http://localhost:9798';
const catalog = { source: 'desktop-cache', fetchedAt: '2026-09-15T01:00:00Z', stale: false, models: [
  { id: 'model-a', displayName: '模型 A', description: '支持中、高、极高三种推理强度。', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'medium', description: '兼顾速度与推理深度。' }, { effort: 'high', description: '为复杂任务提供更多推理时间。' }, { effort: 'xhigh', description: '提供更多推理时间。' }] },
  { id: 'model-b', displayName: '模型 B', description: '另一个模型，默认使用低强度。', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ effort: 'low', description: '更快响应。' }, { effort: 'future-effort', description: '目录提供的新强度，同样可选。' }] },
] };
const allCalls = [], errors = [];
try {
  for (const width of [320, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    page.on('pageerror', error => errors.push(error.message));
    const tasks = new Map([
      ['one', { id: 'one', name: '模型选择验收', cwd: '/mock/project', turns: [] }],
      ['two', { id: 'two', name: '另一条会话', cwd: '/mock/project', turns: [] }],
      ['external', { id: 'external', name: '目录外型号', cwd: '/mock/project', turns: [] }],
    ]);
    const settings = new Map([['one', { model: 'model-a', reasoningEffort: 'xhigh' }], ['two', { model: 'model-a', reasoningEffort: 'medium' }], ['external', { model: 'custom-model', reasoningEffort: null }]]);
    const active = {}, receipts = new Map(), calls = [];
    let mode = 'normal', heldRoute, rejectNextTurn = false;
    let eventCursor = 0, events = [];
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, origin, 'all browser traffic must remain in the isolated fixture');
      let data;
      if (url.pathname === '/api/models') {
        if (mode === 'hold') { heldRoute = route; return; }
        if (mode === 'fail') { await route.fulfill({ status: 503, json: { error: '模型目录暂不可用，请重试。' } }); return; }
        data = { ...catalog, stale: mode === 'stale', models: mode === 'empty' ? [] : catalog.models };
      } else if (url.pathname === '/api/state') data = { ready: true, mode: 'desktop-shared', bridgeId: 'model-picker-mock', capabilities: { taskCommands: true }, active, approvals: [], cursor: eventCursor, events: Number(url.searchParams.get('after')) < eventCursor ? events : [] };
      else if (url.pathname === '/api/projects') data = { projects: [], assignments: {} };
      else if (url.pathname === '/api/attachment-batches') data = { ok: true };
      else if (url.pathname === '/api/attachments') data = { input: { type: 'localImage', path: '/mock/upload.png' } };
      else if (url.pathname === '/api/commands') {
        const call = request.postDataJSON(); calls.push(call); allCalls.push({ width, ...call });
        const { method, params } = call;
        let result = {}, status = 'completed';
        if (method === 'thread/list') result = { data: [...tasks.values()], nextCursor: null };
        else if (method === 'thread/resume') result = { thread: { ...tasks.get(params.threadId), ...settings.get(params.threadId) }, ...settings.get(params.threadId), initialTurnsPage: { data: [] } };
        else if (method === 'thread/read') { assert.equal(params.includeTurns, false); result = { thread: { ...tasks.get(params.threadId), ...settings.get(params.threadId) } }; }
        else if (method === 'thread/name/set') tasks.get(params.threadId).name = params.name;
        else if (method === 'turn/start') {
          if (rejectNextTurn) { status = 'failed'; rejectNextTurn = false; }
          else { active[params.threadId] = 'mock-turn'; settings.set(params.threadId, { model: params.model, reasoningEffort: params.effort }); result = { turn: { id: 'mock-turn' } }; }
        } else if (method === 'turn/steer') { assert.equal(params.expectedTurnId, active[params.threadId]); result = { turnId: params.expectedTurnId }; }
        else throw Error(`Unexpected RPC: ${method}`);
        receipts.set(call.key, { status, result, ...(status === 'failed' ? { error: { message: '模拟模型拒绝，草稿保留' } } : {}) });
        data = { status: 'pending' };
      } else if (url.pathname.startsWith('/api/commands/')) data = receipts.get(url.pathname.split('/').pop());
      else {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        await route.fulfill({ body: await readFile(new URL(`../public/${file}`, import.meta.url)), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
        return;
      }
      await route.fulfill({ json: data });
    });
    const closed = id => page.waitForFunction(id => !document.getElementById(id).open, id);
    const choose = async id => {
      if (!(await page.locator('#task-dialog').evaluate(element => element.open))) await page.locator('#choose-task').click();
      await page.locator(`.task-row[data-thread-id="${id}"] .task-card`).click();
      await closed('task-dialog');
    };
    const openPicker = async () => {
      await page.locator('#slash-toggle').click();
      await page.locator('[data-command="/model"]').click();
      await page.locator('#model-dialog').waitFor();
    };
    const loaded = () => page.waitForFunction(() => document.querySelector('#model-source').textContent.includes('上次同步'));
    const selectedValues = id => page.locator(id).locator('option').evaluateAll(options => options.map(option => option.value));
    await page.goto(origin);
    await choose('one');
    // Desktop changes after selection; no event is available. Opening must read current metadata.
    settings.set('one', { model: 'model-a', reasoningEffort: 'medium' });
    await page.locator('#message').fill('保留消息和附件');
    await page.locator('#image-files').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64') });
    await page.locator('#image-previews img').waitFor();
    const writeCalls = () => calls.filter(call => !['thread/read', 'thread/list', 'thread/resume'].includes(call.method)).length;
    const initialWrites = writeCalls();
    await openPicker(); await loaded();
    assert.equal(await page.locator('#model-choice').inputValue(), 'model-a');
    assert.equal(await page.locator('#effort-choice').inputValue(), 'medium', 'old xhigh snapshot must be refreshed from thread/read');
    assert.equal(await page.locator('#model-save').isDisabled(), false);
    await page.screenshot({ path: `${artifacts}/sync-current-${width}.png`, animations: 'disabled' });
    for (const effort of ['high', 'medium']) {
      settings.set('one', { model: 'model-a', reasoningEffort: effort });
      events = [{ method: 'thread/settings/updated', params: { threadId: 'one', threadSettings: { model: 'model-a', effort } } }]; eventCursor++;
      await page.waitForFunction(effort => document.querySelector('#effort-choice').value === effort, effort);
    }
    assert.equal(await page.locator('#model-dialog input').count(), 0);
    assert.equal(await page.getByLabel('模型', { exact: true }).count(), 1);
    assert.equal(await page.getByLabel('推理强度', { exact: true }).count(), 1);
    await page.locator('#model-choice').selectOption('model-b');
    assert.equal(await page.locator('#effort-choice').inputValue(), 'low');
    assert.deepEqual(await selectedValues('#effort-choice'), ['low', 'future-effort']);
    await page.locator('#effort-choice').selectOption('future-effort');
    await page.locator('#model-cancel').click();
    assert.equal(await page.locator('#model-label').innerText(), '');
    await openPicker(); await loaded();
    assert.equal(await page.locator('#model-choice').inputValue(), 'model-a');
    await page.locator('#model-choice').selectOption('model-b');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflow at ${width}`);
    assert.ok(await page.locator('#model-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), `dialog overflow at ${width}`);
    for (const id of ['model-choice', 'effort-choice', 'model-save', 'model-cancel']) assert.ok((await page.locator(`#${id}`).boundingBox()).height >= 44, `${id} touch target`);
    await page.screenshot({ path: `${artifacts}/picker-${width}.png` });
    await writeFile(`${artifacts}/picker-${width}.aria.txt`, await page.locator('#model-dialog').ariaSnapshot());
    await page.locator('#model-save').click(); await closed('model-dialog');
    assert.equal(writeCalls(), initialWrites, 'choosing settings may read metadata but must not submit writes');
    assert.match(await page.locator('#model-label').innerText(), /下轮.*model-b.*低/);
    assert.equal(await page.locator('#message').inputValue(), '保留消息和附件');
    assert.equal(await page.locator('#image-previews img').count(), 1);

    await page.locator('#slash-toggle').click(); await page.locator('[data-command="/rename"]').click();
    await page.locator('#command-argument').fill('重命名兼容'); await page.locator('#command-save').click(); await closed('command-dialog');
    assert.equal(await page.locator('#conversation-title').innerText(), '重命名兼容');
    assert.equal(await page.locator('#message').inputValue(), '保留消息和附件');
    assert.equal(await page.locator('#image-previews img').count(), 1);

    await choose('two'); await openPicker(); await loaded();
    assert.equal(await page.locator('#model-choice').inputValue(), 'model-a');
    assert.equal(await page.locator('#effort-choice').inputValue(), 'medium');
    await page.locator('#model-cancel').click(); await choose('one');
    await openPicker(); await loaded(); assert.equal(await page.locator('#model-choice').inputValue(), 'model-b');
    await page.locator('#model-cancel').click();

    const pendingRequest = page.waitForRequest('**/api/models');
    mode = 'hold'; await openPicker();
    await pendingRequest;
    assert.equal(await page.locator('#model-save').isDisabled(), true);
    await page.locator('#model-cancel').click(); mode = 'normal';
    await openPicker(); await loaded();
    assert.ok(heldRoute); await heldRoute.fulfill({ status: 503, json: { error: '旧请求失败，不应覆盖新弹窗' } });
    assert.equal(await page.locator('#model-choice').inputValue(), 'model-b');
    assert.equal(await page.locator('#model-error').innerText(), '');
    mode = 'fail'; await page.locator('#model-reload').click();
    await page.waitForFunction(() => document.querySelector('#model-error').textContent.includes('暂不可用'));
    assert.equal(await page.locator('#model-save').isDisabled(), true);
    await page.screenshot({ path: `${artifacts}/failure-${width}.png` });
    mode = 'empty'; await page.locator('#model-reload').click();
    await page.waitForFunction(() => document.querySelector('#model-error').textContent.includes('没有可展示'));
    assert.equal(await page.locator('#model-save').isDisabled(), true);
    mode = 'stale'; await page.locator('#model-reload').click(); await loaded();
    await page.locator('#model-choice').selectOption('model-b');
    assert.match(await page.locator('#model-source').innerText(), /过期/);
    await page.screenshot({ path: `${artifacts}/stale-${width}.png` });
    await page.locator('#model-cancel').click(); mode = 'normal';
    await choose('external'); await openPicker(); await loaded();
    assert.match(await page.locator('#model-error').innerText(), /custom-model.*支持强度未知/);
    assert.equal(await page.locator('#model-save').isDisabled(), true);
    await page.screenshot({ path: `${artifacts}/unknown-${width}.png` });
    await page.locator('#model-cancel').click(); await choose('one');

    rejectNextTurn = true;
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#error').textContent.includes('模拟模型拒绝'));
    assert.equal(await page.locator('#message').inputValue(), '保留消息和附件');
    assert.equal(await page.locator('#image-previews img').count(), 1);
    await page.locator('#send').click(); await page.waitForFunction(() => document.querySelector('#message').value === '');
    const start = calls.findLast(call => call.method === 'turn/start');
    assert.equal(start.params.model, 'model-b'); assert.equal(start.params.effort, 'low');
    assert.deepEqual(start.params.input, [{ type: 'text', text: '保留消息和附件' }, { type: 'localImage', path: '/mock/upload.png' }]);
    assert.equal(await page.locator('#model-label').innerText(), '', 'confirmed setting is no longer an unsent override');
    settings.set('one', { model: 'model-a', reasoningEffort: 'medium' });
    await openPicker(); await loaded();
    assert.equal(await page.locator('#model-choice').inputValue(), 'model-a', 'old submitted overrides must not mask desktop changes');
    assert.equal(await page.locator('#effort-choice').inputValue(), 'medium');
    await page.locator('#model-choice').selectOption('model-a'); await page.locator('#model-save').click(); await closed('model-dialog');
    await page.locator('#message').fill('追加当前执行'); await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#message').value === '');
    const steer = calls.findLast(call => call.method === 'turn/steer');
    assert.ok(steer); assert.equal(Object.hasOwn(steer.params, 'model'), false); assert.equal(Object.hasOwn(steer.params, 'effort'), false);
    await page.screenshot({ path: `${artifacts}/pending-${width}.png` });
    assert.equal(calls.some(call => call.method === 'turn/interrupt'), false);
    await page.close();
    console.log(`PASS ${width}px: xhigh snapshot to current medium via thread/read, live settings events, accepted override cleanup, native selects, supported effort reset, cancel/session isolation, drafts+images, rename, stale/empty/failed/late catalog, unknown model, failed send, model+effort on start, neither on steer.`);
  }
  assert.deepEqual(errors, []);
  await writeFile(`${artifacts}/mock-rpc.json`, JSON.stringify(allCalls, null, 2));
  console.log(`PASS: mock API only; no real tasks, approvals, login credentials or live services. Artifacts: ${artifacts}`);
} finally { await browser.close(); }
