import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const mode of ['normal', 'blocked-script', 'storage-denied', 'no-js']) {
    const context = await browser.newContext({ javaScriptEnabled: mode !== 'no-js' });
    if (mode === 'storage-denied') await context.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw Error('Storage denied'); } }));
    const page = await context.newPage(); const requests = [];
    await page.route('http://localhost:9789/**', async route => {
      const req = route.request(); requests.push({ url: req.url(), method: req.method(), data: req.postData() });
      const path = new URL(req.url()).pathname;
      if (path === '/api/login') { await route.fulfill({ status: 401, body: JSON.stringify({ error: '测试拒绝' }), contentType: 'application/json' }); return; }
      if (path === '/login.js' && mode === 'blocked-script') { await route.abort(); return; }
      const name = path === '/login' ? 'login.html' : path.slice(1);
      await route.fulfill({ body: await readFile(new URL('../public/' + name, import.meta.url)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://localhost:9789/login');
    await page.locator('#password').fill('test-secret-do-not-leak');
    if (['blocked-script', 'no-js'].includes(mode)) {
      assert.equal(await page.locator('#login-submit').isDisabled(), true);
      await page.locator('#password').press('Enter');
      assert.ok(!requests.some(req => req.url.includes('test-secret')));
      assert.equal(await page.locator('#password').getAttribute('name'), null);
      assert.equal(await page.locator('#login').getAttribute('method'), 'post');
    } else {
      await page.locator('#login-submit').click();
      await page.waitForFunction(() => document.querySelector('#login-error').textContent === '测试拒绝');
      const login = requests.find(req => req.url.endsWith('/api/login'));
      assert.equal(login.method, 'POST');
      assert.equal(JSON.parse(login.data).password, 'test-secret-do-not-leak');
    }
    assert.ok(requests.every(req => !req.url.includes('test-secret')));
    assert.equal(new URL(page.url()).search, '');
    await context.close();
  }
  console.log('PASS: normal login, script blocked, JavaScript disabled, and storage denied never place passwords in URLs.');
} finally { await browser.close(); }
