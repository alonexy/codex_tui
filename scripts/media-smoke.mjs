import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('http://localhost:9789/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/attachments') { await route.fulfill({ json: { input: { type: 'localImage', path: '/private/upload.png' } } }); return; }
    const name = path === '/' ? 'index.html' : path.slice(1);
    const body = name === 'app.js' ? '' : await readFile(new URL('../public/' + name, import.meta.url));
    await route.fulfill({ body, contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://localhost:9789');
  await page.evaluate(async () => {
    document.querySelector('#workspace').hidden = false;
    window.currentTask = 'one'; window.uploads = [];
    window.SpeechRecognition = class {
      constructor() { window.speech = this; }
      start() {}
      stop() { this.onend(); }
      abort() { this.onend(); }
    };
    const { composerMedia } = await import('/composer-media.js');
    window.media = composerMedia({ getThread: () => window.currentTask, busy: () => false,
      api: async (path, data) => { window.uploads.push({ path, data }); return { type: 'localImage', path: '/private/upload.png' }; },
      changed() {}, error(e) { document.querySelector('#error').textContent = e.message; } });
    window.media.render();
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64');
  await page.locator('#image-files').setInputFiles({ name: '截图.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => window.media.hasImages());
  assert.equal(await page.locator('#image-previews img').count(), 1);
  assert.equal(await page.locator('#message').getAttribute('required'), null);
  await page.evaluate(() => { window.currentTask = 'two'; window.media.render(); });
  assert.equal(await page.locator('#image-previews img').count(), 0);
  await page.evaluate(() => { window.currentTask = 'one'; window.media.render(); });
  assert.deepEqual(await page.evaluate(() => window.media.input()), [{ type: 'localImage', path: '/private/upload.png' }]);
  await page.evaluate(() => window.media.input());
  assert.equal(await page.evaluate(() => window.uploads.filter(call => call.path === '/api/attachment-batches').length), 2, 'reconcile the same draft before retry');
  await page.getByRole('button', { name: '移除附件 截图.png' }).click();
  assert.equal(await page.locator('#image-previews img').count(), 0);
  await page.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([137,80,78,71])], 'paste.png', { type: 'image/png' }));
    document.querySelector('#message').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }));
  });
  await page.waitForFunction(() => window.media.hasImages());
  await page.locator('#voice-input').click();
  await page.evaluate(() => window.speech.onresult({ results: [[{ transcript: '测试语音输入' }]] }));
  assert.equal(await page.locator('#message').inputValue(), '测试语音输入');
  await page.locator('#voice-input').click();
  assert.equal(await page.locator('#voice-input').getAttribute('aria-pressed'), 'false');
  await page.locator('#voice-input').click();
  await page.evaluate(() => window.speech.onerror({ error: 'not-allowed' }));
  assert.ok((await page.locator('#error').innerText()).includes('麦克风权限'));
  await page.evaluate(() => { window.currentTask = 'two'; window.media.render(); });
  assert.equal(await page.locator('#voice-input').getAttribute('aria-pressed'), 'false');
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const boxes = await page.locator('#attach-image, #voice-input, #send, #quick-toggle, #slash-toggle').evaluateAll(elements => elements.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, right: r.right }; }));
    boxes.sort((a, b) => a.x - b.x);
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].x >= boxes[i - 1].right, 'composer buttons do not overlap');
  }
  console.log('PASS: image selection/paste/removal, per-task drafts, upload reuse, speech results/denial/stop, 320–768px layout (mock speech and upload).');
} finally { await browser.close(); }
