import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createWebServer } from '../src/http.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const artifacts = 'output/playwright/image-preview';
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'image-preview-'));
const imagePath = join(temporary, 'fixture.png');
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`, password = 'image-preview-fixture';
const prose = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段会话内容，用于检查图片关闭后的阅读位置。`).join('\n\n');
const item = { id: 'answer', type: 'agentMessage', text: `${prose}\n\n![图片预览验收](${imagePath})\n\n${prose}`, phase: 'final_answer' };
const remote = 'https://image-preview.test/fixture.png';
const attachment = { id: 'attachment', type: 'userMessage', content: [{ type: 'localImage', path: imagePath }, { type: 'image', url: remote }] };
const thread = { id: 'one', name: '图片预览验收', cwd: temporary, turns: [{ id: 'turn', status: 'inProgress', items: [item, attachment] }] };
let cursor = 0;
const events = [], receipts = new Map();
const broker = {
  snapshot(after) { return { ready: true, bridgeId: 'image-fixture', cursor, events: events.filter(event => event.cursor > after), active: { one: 'turn' }, approvals: [], capabilities: {} }; },
  submit(key, method) {
    let result;
    if (method === 'thread/list') result = { data: [thread], nextCursor: null };
    else if (['thread/resume', 'thread/read'].includes(method)) result = { thread };
    else throw Error(`Unexpected fixture command: ${method}`);
    const receipt = { status: 'completed', result }; receipts.set(key, receipt); return receipt;
  },
  getCommand(key) { return receipts.get(key); },
};
const server = createWebServer(broker, { password, origin, audit: { record() {} }, uploadDirectory: temporary,
  readModels: async () => ({ models: [] }), modes: { read: async threadId => ({ threadId, collaborationMode: null }) } });
let browser;
const findings = { checks: [], viewports: [], errors: [] };
try {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => findings.errors.push(error.message));
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 800;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#d6ecdf'; ctx.fillRect(0, 0, 1200, 800);
    ctx.fillStyle = '#204536'; ctx.font = 'bold 64px sans-serif'; ctx.fillText('IMAGE PREVIEW', 70, 130);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 ? '#789d8a' : '#aac9b6'; ctx.fillRect(70 + i * 175, 220, 150, 400);
      ctx.fillStyle = '#204536'; ctx.font = '32px sans-serif'; ctx.fillText(`${i + 1}`, 120 + i * 175, 690);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await writeFile(imagePath, Buffer.from(png, 'base64'));
  assert.equal((await fetch(origin + '/image-preview.js')).status, 401);
  const login = await context.request.post(origin + '/api/login', { headers: { Origin: origin }, data: { password } });
  assert.equal(login.status(), 200);
  const moduleResponse = await context.request.get(origin + '/image-preview.js');
  // Before the fix, allow the original bug assertion to provide the red signal.
  const hasModule = moduleResponse.status() === 200;
  await page.route(origin + '/api/projects', route => route.fulfill({ json: { projects: [], assignments: {} } }));
  let failureReleased = false;
  const heldRoutes = [];
  const remoteHeaders = [];
  await page.route(remote + '**', route => {
    remoteHeaders.push(route.request().headers());
    const url = route.request().url();
    if (url.endsWith('?slow') || (url.endsWith('?error') && !failureReleased)) { heldRoutes.push(route); return; }
    return route.fulfill(url.endsWith('?error') ? { status: 404 } : { contentType: 'image/png', headers: { 'Cache-Control': 'no-store' }, body: Buffer.from(png, 'base64') });
  });
  await page.route(origin + '/before', route => route.fulfill({ contentType: 'text/html', body: '<p>Previous page</p>' }));
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined });
    sessionStorage.setItem('codex-thread', 'one');
    window.violations = [];
    document.addEventListener('securitypolicyviolation', event => window.violations.push(event.violatedDirective));
  });
  await page.goto(origin + '/before');
  const main = await page.goto(origin);
  assert.match(main.headers()['content-security-policy'], /script-src 'self'; style-src 'self'/);
  await page.locator('.image-attachment img').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  const startUrl = page.url();
  await page.locator('.image-attachment').first().click();
  const opened = await page.evaluate(() => !!document.querySelector('#image-dialog')?.open);
  if (!opened) {
    await page.screenshot({ path: `${artifacts}/red-no-preview.png` });
    await writeFile(`${artifacts}/red.json`, JSON.stringify({ opened, pages: context.pages().length, url: page.url(), target: await page.locator('.image-attachment').first().getAttribute('target') }, null, 2));
  }
  assert.equal(opened, true, 'clicking a conversation image must open a closeable in-page preview');
  assert.equal(page.url(), startUrl);
  assert.equal(context.pages().length, 1, 'image click must not open another tab');
  assert.equal(hasModule, true, 'preview module must be served by authenticated HTTP');
  const dialog = page.locator('#image-dialog');
  const close = dialog.getByRole('button', { name: '返回会话', exact: true });
  const zoom = dialog.getByRole('button', { name: '查看原尺寸', exact: true });
  const closed = () => page.waitForFunction(() => !document.querySelector('#image-dialog').open && !document.body.classList.contains('image-preview-open'));
  await page.evaluate(() => {
    document.querySelector('#image-dialog').addEventListener('close', () => {
      if (!window.previewOpeningTrace) return;
      const trace = window.previewOpeningTrace;
      trace.closeY = scrollY; trace.closeRestoration = history.scrollRestoration;
      requestAnimationFrame(() => { trace.frameY = scrollY; });
    });
    addEventListener('popstate', () => {
      if (window.previewOpeningTrace) {
        window.previewOpeningTrace.popstateY = scrollY;
        window.previewOpeningTrace.popstateRestoration = history.scrollRestoration;
      }
    });
  });
  const positionImage = index => page.locator('.image-attachment').nth(index).evaluate(node => {
    node.scrollIntoView({ block: 'start' }); window.scrollBy(0, -80);
  });
  const open = async index => {
    await positionImage(index);
    await page.evaluate(() => {
      window.previewOpeningTrace = { preparedY: scrollY };
      const record = event => {
        if (!event.target.closest('.image-attachment')) return;
        window.previewOpeningTrace.clickedY = scrollY;
        document.removeEventListener('click', record, true);
      };
      document.addEventListener('click', record, true);
    });
    await page.locator('.image-attachment').nth(index).click({ position: { x: 12, y: 12 } });
    await page.waitForFunction(() => document.querySelector('#image-dialog').open);
    await page.evaluate(() => { window.previewOpeningTrace.savedTop = document.body.style.getPropertyValue('--image-preview-top'); });
  };
  const state = () => page.evaluate(() => ({ y: scrollY, draft: document.querySelector('#message').value, thread: sessionStorage.getItem('codex-thread'), url: location.href }));
  const preserved = async before => {
    const after = await state();
    if (Math.abs(after.y - before.y) > 1) console.error('Preview reading trace:', await page.evaluate(() => window.previewOpeningTrace));
    assert.ok(Math.abs(after.y - before.y) <= 1, `reading position: ${before.y} -> ${after.y}`);
    assert.equal(after.draft, before.draft); assert.equal(after.thread, before.thread); assert.equal(after.url, before.url);
  };
  await close.click(); await closed();
  await page.locator('#message').fill('图片预览前的草稿，保持不变');
  await page.locator('#message').blur();
  await positionImage(0);
  const before = await state();
  await open(0);
  await page.evaluate(() => { window.previewThumbnail = document.querySelector('.image-attachment'); window.previewThumbnailImage = window.previewThumbnail.querySelector('img'); });
  item.text += '\n\n流式更新到达：' + prose;
  events.push({ cursor: ++cursor, method: 'item/completed', params: { threadId: 'one', turnId: 'turn', item: { ...item } } });
  await page.waitForFunction(() => document.querySelector('#history').textContent.includes('流式更新到达'));
  assert.equal(await page.evaluate(() => document.querySelector('.image-attachment') === window.previewThumbnail && window.previewThumbnail.querySelector('img') === window.previewThumbnailImage), true, 'streaming keeps decoded thumbnail and preview trigger identity');
  assert.equal(await dialog.evaluate(node => node.open), true);
  await close.click(); await closed(); await preserved(before);
  assert.equal(await page.evaluate(() => document.activeElement === window.previewThumbnail), true, 'streaming preview returns focus to its still-connected trigger');
  findings.reading = { before: before.y, after: (await state()).y, trace: await page.evaluate(() => window.previewOpeningTrace) };
  findings.checks.push('streaming rerender preserves reading position, draft and selected thread');

  const baselineHistory = await page.evaluate(() => history.length);
  for (let i = 0; i < 3; i++) {
    await open(0);
    if (i === 1) await page.goBack();
    else if (i === 2) await page.keyboard.press('Escape');
    else await close.click();
    await closed(); await preserved(before);
    assert.equal(await page.evaluate(() => history.length), baselineHistory, 'repeated previews must reuse the temporary history slot');
  }
  await page.goForward();
  await page.waitForFunction(() => document.querySelector('#image-dialog').open);
  await page.goBack(); await closed(); await preserved(before);
  await open(0);
  await page.evaluate(() => {
    window.fastForwardComplete = false;
    window.addEventListener('popstate', () => {
      window.addEventListener('popstate', () => { window.fastForwardComplete = true; }, { once: true });
      history.forward();
    }, { once: true });
  });
  await close.click();
  await page.waitForFunction(() => window.fastForwardComplete && document.querySelector('#image-dialog').open);
  await page.goBack(); await closed(); await preserved(before);
  findings.checks.push('close button, Escape, browser back, forward and repeated history cycles');
  findings.checks.push('immediate forward while closing restores preview; randomUUID unavailable throughout');

  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 320 }]) {
    if (viewport.height < 400) {
      // Rotate an open preview; the existing composer covers the short landscape conversation.
      await open(0); await page.setViewportSize(viewport);
    } else { await page.setViewportSize(viewport); await open(0); }
    await page.waitForFunction(() => !document.querySelector('#image-dialog button:last-child').disabled);
    const geometry = await close.evaluate(button => {
      const box = button.getBoundingClientRect(), image = document.querySelector('#image-dialog img').getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height,
        hittable: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button,
        imageFits: image.x >= 0 && image.y >= box.bottom && image.right <= innerWidth && image.bottom <= innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.ok(geometry.width >= 44 && geometry.height >= 44 && geometry.hittable);
    assert.ok(geometry.imageFits); assert.equal(geometry.overflow, false);
    await page.screenshot({ path: `${artifacts}/preview-${viewport.width}x${viewport.height}.png` });
    await zoom.click();
    const natural = await dialog.locator('img').evaluate(image => ({ width: image.getBoundingClientRect().width, natural: image.naturalWidth }));
    assert.equal(natural.width, natural.natural);
    await dialog.locator('.image-preview-stage').evaluate(stage => { stage.scrollLeft = 200; stage.scrollTop = 100; });
    assert.ok(await dialog.locator('.image-preview-stage').evaluate(stage => stage.scrollLeft > 0));
    await page.screenshot({ path: `${artifacts}/detail-${viewport.width}x${viewport.height}.png` });
    await dialog.getByRole('button', { name: '适应屏幕' }).click();
    findings.viewports.push({ viewport, closeButton: geometry });
    await close.click(); await closed();
  }
  findings.checks.push('320/390/landscape fit, original-size scrolling and reachable 44px close button');

  await page.setViewportSize({ width: 390, height: 844 });
  await open(1);
  assert.match(await dialog.locator('img').getAttribute('src'), /^\/api\/images\//);
  assert.equal((await fetch(origin + await dialog.locator('img').getAttribute('src'))).status, 401);
  await close.click(); await closed();
  await open(2);
  await page.waitForFunction(() => !document.querySelector('#image-dialog button:last-child').disabled);
  await close.click(); await closed();
  assert.ok(remoteHeaders.length >= 1); assert.ok(remoteHeaders.every(headers => !headers.referer));
  const newRemote = async mode => {
    attachment.content[1].url = `${remote}?${mode}`;
    events.push({ cursor: ++cursor, method: 'item/completed', params: { threadId: 'one', turnId: 'turn', item: structuredClone(attachment) } });
    await page.waitForFunction(url => document.querySelectorAll('.image-attachment img')[2]?.src === url, attachment.content[1].url);
  };
  await newRemote('error'); await open(2);
  failureReleased = true;
  for (const route of heldRoutes.splice(0)) await route.fulfill({ status: 404 });
  await page.waitForFunction(() => document.querySelector('.image-preview-status').textContent.includes('失效'));
  await page.screenshot({ path: `${artifacts}/failed-390.png` });
  await close.click(); await closed();
  await newRemote('slow');
  // The failed thumbnail is replaced during the fresh streaming render above.
  await open(2);
  await page.waitForFunction(() => document.querySelector('.image-preview-status').textContent.includes('正在加载'));
  await page.screenshot({ path: `${artifacts}/loading-390.png` });
  await page.goBack(); await closed();
  for (const route of heldRoutes.splice(0)) await route.fulfill({ status: 404 });
  findings.checks.push('Markdown, localImage and HTTPS image paths; missing/slow image can close; image authentication and no-referrer preserved');
  assert.equal(context.pages().length, 1);
  assert.deepEqual(await page.evaluate(() => window.violations), []);
  assert.deepEqual(findings.errors, []);
  await page.goBack();
  assert.equal(page.url(), origin + '/before', 'no leftover preview entries before the previous page');
  findings.checks.push('back after all preview cycles reaches previous page without a history trap');
  await writeFile(`${artifacts}/results.json`, JSON.stringify(findings, null, 2));
  console.log(`image preview smoke passed: ${artifacts}`);
} finally {
  await browser?.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
