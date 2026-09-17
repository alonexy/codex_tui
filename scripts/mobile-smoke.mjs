import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [], calls = [], receipts = new Map();
page.on('pageerror', error => errors.push(error.message));
const projects = [{ id: 'p1', serverId: 'server-p1', name: '组合项目', roots: ['/repo/api', '/repo/web'] }];
const thread = { id: 'task-1', projectId: 'server-p1', name: '手机验收任务', cwd: '/repo/api', turns: [{ id: 'initial', items: [{ id: 'reply', type: 'agentMessage', text: '# 验收内容\n\n' + '正常消息与长内容。\n'.repeat(20) }] }] };
let active = {}, events = [], cursor = 0, networkDown = false, loseReply = false, missingReceipt = false;
let sessions = [{ id: 'public-current', device: 'Chrome · Android', source: '192.0.2.1', createdAt: Date.now(), lastSeen: Date.now(), expiresAt: Date.now() + 100000, idleExpiresAt: Date.now() + 10000, current: true }, { id: 'public-other', device: 'Safari · iOS', source: '192.0.2.2', createdAt: Date.now(), lastSeen: Date.now(), expiresAt: Date.now() + 100000, idleExpiresAt: Date.now() + 10000, current: false }];
await page.addInitScript(() => sessionStorage.setItem('codex-thread', 'task-1'));
await page.route('http://phone.test/**', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.pathname.startsWith('/api/') && networkDown) { await route.abort('internetdisconnected'); return; }
  let data;
  if (url.pathname === '/api/state') data = { ready: true, mode: 'desktop-shared', capabilities: { paginatedHistory: true, taskCommands: true }, bridgeId: 'mock-bridge', cursor, events: events.filter(e => e.cursor > Number(url.searchParams.get('after'))), active, approvals: [] };
  else if (url.pathname === '/api/projects') data = { projects, assignments: {} };
  else if (url.pathname === '/api/sessions/list') data = { sessions };
  else if (url.pathname === '/api/sessions/revoke') { sessions = sessions.filter(s => s.id !== request.postDataJSON().id); data = { ok: true }; }
  else if (url.pathname === '/api/security-audit/list') data = { events: [], suppressed: 0, persistence: 'disabled', maxEvents: 200, maxFileBytes: 262144, retainedFiles: 2 };
  else if (url.pathname === '/api/commands') {
    const call = request.postDataJSON(); calls.push(call); let result = {};
    if (call.method === 'thread/list') result = { data: [thread], nextCursor: null };
    else if (call.method === 'thread/resume') result = { thread, model: 'test-model', sandbox: { type: 'workspaceWrite' } };
    else if (call.method === 'thread/items/list') result = { data: thread.turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))).reverse(), nextCursor: null };
    else if (call.method === 'thread/turns/list') result = { data: [], nextCursor: null };
    else if (call.method === 'thread/name/set') { thread.name = call.params.name; result = {}; }
    else if (call.method === 'turn/start' || call.method === 'turn/steer') {
      const item = { id: 'sent-' + calls.length, type: 'userMessage', content: call.params.input };
      const turn = { id: 'turn-' + calls.length, items: [item] };
      thread.turns.push(turn); active = { 'task-1': turn.id };
      events.push({ cursor: ++cursor, method: 'turn/started', params: { threadId: thread.id, turn: { id: turn.id } } });
      events.push({ cursor: ++cursor, method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item } });
      result = { turn: { id: turn.id } };
      receipts.set(call.key, { status: 'completed', result });
      if (loseReply) { loseReply = false; networkDown = true; await route.abort('internetdisconnected'); return; }
    }
    receipts.set(call.key, { status: 'completed', result }); data = { status: 'pending' };
  } else if (url.pathname.startsWith('/api/commands/')) {
    data = missingReceipt ? null : receipts.get(url.pathname.split('/').pop());
    if (!data) { await route.fulfill({ status: 404, json: { error: '没有此提交记录' } }); return; }
  } else {
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^[a-z-]+\.(js|css|html)$/.test(name)) { await route.fulfill({ status: 404, body: '' }); return; }
    await route.fulfill({ body: await readFile(new URL('../public/' + name, import.meta.url)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }); return;
  }
  await route.fulfill({ json: data });
});

async function layout(label) {
  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('.composer-tools').getBoundingClientRect();
    const input = document.querySelector('#message').getBoundingClientRect();
    return { viewport: innerWidth, document: document.documentElement.scrollWidth, bar: { left: bar.left, right: bar.right, top: bar.top }, inputBottom: input.bottom, buttons: [...document.querySelectorAll('.composer-tools button')].filter(el => !el.hidden).map(el => { const r = el.getBoundingClientRect(); return { id: el.id, x: r.x, y: r.y, width: r.width, height: r.height }; }) };
  });
  assert.ok(geometry.document <= geometry.viewport + 1, `${label}: document overflows`);
  const centers = geometry.buttons.map(b => b.y + b.height / 2);
  assert.ok(Math.max(...centers) - Math.min(...centers) < 1, `${label}: button centers differ`);
  for (let i = 0; i < geometry.buttons.length; i++) {
    const button = geometry.buttons[i];
    assert.ok(button.width >= 44 && button.height >= 44, `${label}: ${button.id} touch target`);
    assert.ok(Math.abs(button.width - button.height) < 1, `${label}: ${button.id} is not circular`);
    assert.ok(button.x >= geometry.bar.left - 1 && button.x + button.width <= geometry.bar.right + 1, `${label}: ${button.id} outside toolbar`);
    assert.ok(button.y - geometry.inputBottom >= 8, `${label}: input overlaps toolbar`);
    if (i) assert.ok(button.x >= geometry.buttons[i - 1].x + geometry.buttons[i - 1].width, `${label}: overlapping buttons`);
  }
}
try {
  await page.goto('http://phone.test/');
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  await mkdir(new URL('../output/playwright/', import.meta.url), { recursive: true });
  for (const size of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await page.locator('#message').fill('手机草稿');
    await layout(`${size.width} idle`);
    const composerHeight = await page.locator('.composer-box').evaluate(el => el.offsetHeight);
    await page.locator('#quick-toggle').tap();
    assert.equal(await page.locator('#quick-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#message').evaluate(el => el === document.activeElement), false);
    assert.equal(await page.locator('.composer-box').evaluate(el => el.offsetHeight), composerHeight, 'quick menu does not resize composer');
    const menu = await page.locator('#quick-menu').boundingBox();
    assert.ok(menu.x >= 0 && menu.x + menu.width <= size.width && menu.y >= 0 && menu.y + menu.height <= size.height, 'quick menu stays on screen');
    assert.ok(await page.locator('#quick-menu button').evaluateAll(buttons => buttons.every(b => b.getBoundingClientRect().height >= 44)));
    await page.screenshot({ path: new URL(`../output/playwright/mobile-quick-${size.width}.png`, import.meta.url).pathname });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#quick-menu').isVisible(), false);
    await page.locator('#quick-toggle').tap();
    await page.locator('#message').tap();
    assert.equal(await page.locator('#quick-menu').isVisible(), false, 'outside tap dismisses quick menu');
    active = { 'task-1': 'external-turn' };
    await page.waitForFunction(() => !document.querySelector('#stop').hidden);
    await layout(`${size.width} running`);
    await page.screenshot({ path: new URL(`../output/playwright/mobile-${size.width}.png`, import.meta.url).pathname });
    active = {};
    await page.waitForFunction(() => document.querySelector('#stop').hidden);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#message').fill('保留草稿');
  await page.locator('#slash-toggle').tap();
  assert.equal(await page.locator('#message').evaluate(el => el === document.activeElement), false);
  await page.screenshot({ path: new URL('../output/playwright/mobile-commands.png', import.meta.url).pathname });
  await page.getByRole('button', { name: '/status', exact: false }).click();
  await page.locator('#close-status').click();
  assert.equal(await page.locator('#message').inputValue(), '保留草稿');
  await page.locator('#slash-toggle').tap();
  await page.getByRole('button', { name: '/rename', exact: false }).click();
  await page.locator('#command-argument').fill('表单重命名');
  await page.locator('#command-save').click();
  await page.waitForFunction(() => !document.querySelector('#command-dialog').open);
  assert.equal(await page.locator('#message').inputValue(), '保留草稿');
  assert.equal(calls.filter(c => c.method === 'thread/name/set').length, 1);

  await page.locator('#choose-task').click();
  await page.locator('.task-favorite').first().click();
  await page.locator('.project-group summary').first().click();
  await page.locator('#close-tasks').click();
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  await page.locator('#choose-task').click();
  assert.equal(await page.locator('.task-favorite').first().getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.project-group').first().evaluate(el => el.open), false);
  await page.locator('#close-tasks').click();
  await page.locator('#new').click();
  assert.equal(await page.locator('#workspace-choice').isVisible(), false);
  await page.locator('#project-workspace > summary').click();
  await page.locator('#workspace-choice').selectOption('/repo/web');
  assert.match(await page.locator('#new-summary').innerText(), /组合项目/);
  assert.match(await page.locator('#new-summary').innerText(), /包含 2 个目录，可跨目录工作/);
  assert.equal(await page.locator('#workspace-path').innerText(), '/repo/web');
  await page.screenshot({ path: new URL('../output/playwright/mobile-new-task.png', import.meta.url).pathname });
  await page.locator('#cancel-new').click();
  await page.locator('#new').click();
  assert.equal(await page.locator('#workspace-choice').isVisible(), false);
  assert.equal(await page.locator('#workspace-choice').inputValue(), '/repo/web');
  await page.locator('#cancel-new').click();

  await page.locator('#message').fill('长内容\n'.repeat(30));
  await page.setViewportSize({ width: 390, height: 400 });
  await page.waitForFunction(() => document.querySelector('#message').getBoundingClientRect().height <= 160);
  await layout('keyboard-sized viewport');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#message').fill('回执恢复只发送一次');
  loseReply = true;
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#delivery-status').textContent.includes('待确认'));
  assert.equal(await page.locator('#send').isDisabled(), true);
  await page.locator('#image-files').setInputFiles({ name: 'next-draft.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1f8AAAAASUVORK5CYII=', 'base64') });
  await page.waitForFunction(() => document.querySelector('#image-previews img')?.alt === 'next-draft.png');
  const submissions = calls.filter(c => c.method.startsWith('turn/')).length;
  networkDown = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !sessionStorage.getItem('codex-pending'));
  await page.waitForFunction(() => document.querySelector('#history').textContent.includes('回执恢复只发送一次'));
  assert.equal(calls.filter(c => c.method.startsWith('turn/')).length, submissions);
  assert.equal(await page.locator('#history .userMessage').count(), 1);
  assert.equal(await page.locator('#image-previews img').getAttribute('alt'), 'next-draft.png', 'a late receipt must preserve the next draft image');

  // A receipt lost with a bridge restart must never turn into an automatic retry.
  missingReceipt = true;
  await page.evaluate(() => sessionStorage.setItem('codex-pending', JSON.stringify({ key: 'lost-key', method: 'turn/start', threadId: 'task-1' })));
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#recovery-actions').hidden);
  assert.equal(await page.locator('#send').isDisabled(), true);
  assert.equal(calls.filter(c => c.method.startsWith('turn/')).length, submissions);
  missingReceipt = false;
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#reconcile').click();
  await page.locator('#choose-task').click();
  await page.locator('#manage-devices').click();
  await page.waitForFunction(() => document.querySelector('#device-dialog')?.open);
  await page.waitForFunction(() => document.querySelector('#device-list').textContent.includes('Safari'));
  assert.match(await page.locator('#device-dialog').innerText(), /Safari/);
  await page.screenshot({ path: new URL('../output/playwright/mobile-devices.png', import.meta.url).pathname });
  const revoke = page.locator('#device-dialog button[data-device-id="public-other"]');
  page.once('dialog', dialog => dialog.accept());
  await revoke.click();
  await page.waitForFunction(() => !document.querySelector('#device-dialog').textContent.includes('Safari'));
  assert.equal(sessions.length, 1);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
  await page.waitForFunction(() => !document.querySelector('#quick-toggle').disabled);
  await page.locator('#message').fill('快捷指令后仍保留的草稿');
  const beforePush = calls.filter(c => c.method.startsWith('turn/')).length;
  await page.locator('#quick-toggle').tap();
  await page.getByRole('button', { name: '推送远端', exact: true }).tap();
  await page.waitForFunction(() => !sessionStorage.getItem('codex-pending') && !document.querySelector('#quick-toggle').disabled);
  const pushCalls = calls.filter(c => c.method.startsWith('turn/')).slice(beforePush);
  assert.equal(pushCalls.length, 1, 'quick push sends once');
  assert.equal(pushCalls[0].params.input[0].text, '推送远端');
  assert.equal(await page.locator('#message').inputValue(), '快捷指令后仍保留的草稿');
  assert.equal(await page.locator('#quick-menu').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('PASS: mobile layouts 320/390/844, running controls, focus, long input, projects, command form, receipt recovery/no replay and device revocation (mock service).');
} finally { await context.close(); await browser.close(); }
