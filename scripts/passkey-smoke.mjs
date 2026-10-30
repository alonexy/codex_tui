import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { Broker } from '../src/broker.mjs';
import { createWebServer } from '../src/http.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const origin = 'https://passkeys.example.test', password = 'isolated-passkey-password';
const directory = await mkdtemp('/private/tmp/passkey-browser-'), artifacts = 'output/playwright/passkey';
const task = { id: 'passkey-fixture', name: '通行密钥测试任务', cwd: '/mock', turns: [] };
const broker = new Broker(message => {
  const result = message.method === 'thread/list' ? { data: [task], nextCursor: null }
    : ['thread/read', 'thread/resume'].includes(message.method) ? { thread: task, initialTurnsPage: { data: [] } } : { data: [], nextCursor: null };
  queueMicrotask(() => broker.receive({ id: message.id, result }));
});
broker.ready = true;
let server, base, browser;
async function start(serviceOrigin = origin) {
  server = createWebServer(broker, { password, origin: serviceOrigin, passkeyPath: directory + '/passkeys.json', uploadDirectory: directory + '/uploads', readModels: async () => ({ models: [] }), modes: { read: async () => null, register() {} } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(serviceOrigin.startsWith('http:') ? Number(new URL(serviceOrigin).port) : 0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stop() { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; } }
const checks = [], errors = [];
try {
  await start();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // Virtual HTTPS origin, entirely routed to the isolated HTTP fixture. No DNS or TLS endpoint is contacted.
  await context.route(origin + '/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/projects') return route.fulfill({ json: { projects: [], assignments: {} } });
    try {
      const response = await fetch(base + url.pathname + url.search, { method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer() ?? undefined, redirect: 'manual' });
      const headers = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie(); if (cookies.length) headers['set-cookie'] = cookies.join('\n');
      await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
    } catch { await route.abort(); }
  });
  await context.addInitScript(() => sessionStorage.setItem('codex-thread', 'passkey-fixture'));
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const ready = async () => { await page.waitForURL(origin + '/'); await page.waitForFunction(() => !document.getElementById('workspace').hidden && !document.getElementById('send').disabled); };
  const passwordLogin = async () => { await page.locator('#password').fill(password); await page.locator('#login-submit').click(); await ready(); };
  const settings = async () => {
    if (!await page.locator('#task-dialog').evaluate(node => node.open)) await page.locator('#choose-task').click();
    await page.locator('#manage-passkeys').click();
    await page.waitForFunction(() => document.querySelector('#passkey-dialog').open && !document.querySelector('#passkey-refresh').disabled);
  };
  const logout = async () => {
    if (await page.locator('#passkey-dialog').count() && await page.locator('#passkey-dialog').evaluate(node => node.open)) await page.locator('#passkey-close').click();
    if (!await page.locator('#task-dialog').evaluate(node => node.open)) await page.locator('#choose-task').click();
    await page.locator('#logout').click(); await page.waitForURL(origin + '/login');
  };
  await page.goto(origin + '/login');
  await passwordLogin(); await settings();
  await page.locator('#passkey-password').fill('wrong-password'); await page.locator('#passkey-bind').click();
  await page.waitForFunction(() => document.getElementById('passkey-error').textContent.includes('密码不正确'));
  assert.equal(page.url(), origin + '/');
  await page.locator('#passkey-password').fill(password); await page.locator('#passkey-bind').click();
  await page.waitForFunction(() => document.getElementById('passkey-status').textContent.includes('已绑定'));
  assert.equal(await page.locator('#passkey-list article').count(), 1);
  assert.equal(await page.locator('#passkey-password').inputValue(), '');
  const credentials = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  assert.equal(credentials.credentials.length, 1); assert.equal(credentials.credentials[0].isResidentCredential, true);
  checks.push('password recheck and real virtual platform registration verified by production library');
  await mkdir(artifacts, { recursive: true });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: `${artifacts}/settings-${width}.png`, fullPage: true });
  }
  await logout();
  await page.locator('#passkey-login-button').click(); await ready();
  checks.push('logout preserves credential; explicit passkey action creates a new authenticated session');
  await logout(); await stop(); await start();
  await page.reload(); await page.locator('#passkey-login-button').click(); await ready();
  checks.push('same-password Web restart retains public credential and permits signed login');
  await settings(); page.once('dialog', dialog => dialog.accept());
  await page.locator('#passkey-list button').click(); await page.waitForURL(origin + '/login');
  await page.locator('#passkey-login-button').click();
  await page.waitForFunction(() => document.getElementById('passkey-login-error').textContent.includes('验证失败'));
  assert.equal(await page.locator('#login').isVisible(), true);
  checks.push('deleting credential revokes its session and denies later valid authenticator signatures');

  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
  await page.locator('#password').fill('keep-this-password-draft');
  await page.locator('#passkey-login-button').click(); await page.locator('#passkey-login-cancel').click();
  assert.equal(await page.locator('#password').inputValue(), 'keep-this-password-draft');
  assert.equal(await page.locator('#login-submit').isEnabled(), true);
  checks.push('cancel leaves password form and existing input usable');
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
  await page.route('**/passkey-client.js', route => route.fulfill({ status: 404, body: '' }));
  await page.reload(); await passwordLogin();
  checks.push('missing optional module does not block password login or workspace');
  await page.unroute('**/passkey-client.js'); await logout();
  await page.goto(origin + '/login');
  for (const width of [320, 390]) { await page.setViewportSize({ width, height: 844 }); await page.screenshot({ path: `${artifacts}/login-${width}.png`, fullPage: true }); }
  await context.close();

  await stop(); await start('http://127.0.0.1:19807');
  const httpContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const httpPage = await httpContext.newPage();
  await httpPage.goto(base + '/login');
  await httpPage.waitForFunction(() => document.getElementById('passkey-login-hint').textContent.includes('当前地址'));
  assert.equal(await httpPage.locator('#passkey-login-button').isDisabled(), true);
  assert.equal(await httpPage.locator('#login-submit').isEnabled(), true);
  await httpPage.screenshot({ path: `${artifacts}/http-disabled.png`, fullPage: true });
  const forbidden = await fetch(base + '/api/passkeys/authenticate/options', { method: 'POST', headers: { Origin: 'http://127.0.0.1:19807', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(forbidden.status, 503); checks.push('HTTP/IP backend rejects passkeys; UI explains HTTPS prerequisite and keeps password available');
  assert.deepEqual(errors, []);
  await writeFile(`${artifacts}/result.json`, JSON.stringify({ checks, errors, virtualAuthenticator: 'Chrome CDP CTAP2 platform with resident key and user verification', realSignatureVerification: true }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, artifacts }));
} finally { await browser?.close(); await stop(); await rm(directory, { recursive: true, force: true }); }
