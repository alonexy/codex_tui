import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createWebServer } from '../src/http.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const artifacts = 'output/playwright/mermaid';
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'mermaid-smoke-'));
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`, password = 'mermaid-fixture-password';
const graph = `flowchart TD
  request["收到手机请求"] --> choice{"是否存在 Conversation？"}
  subgraph yes["有 Conversation：长期会话"]
    choice --> binding["保存固定绑定<br/>client_id<br/>agent_profile<br/>pi_service_id<br/>pi_session_id"]
    binding --> session["复用同一会话<br/>后续请求继续处理"]
    session --> history["读取历史记录<br/>流式展示最新内容"]
  end
  subgraph no["没有 Conversation：不建立跨请求绑定"]
    choice --> temporary["创建临时请求<br/>仅处理本次输入"]
    temporary --> finish["返回本次结果<br/>不保存长期绑定"]
  end
  history -.-> done["手机展示结果<br/>点击图形放大阅读"]
  finish -.-> done`;
const fenced = source => '```mermaid\n' + source + '\n```';
const item = { id: 'answer', type: 'agentMessage', text: '```mermaid\n' + graph, phase: 'final_answer' };
const tasks = [
  { id: 'one', name: 'Mermaid 手机阅读验收', cwd: '/fixture', turns: [{ id: 'turn', status: 'inProgress', items: [item] }] },
  { id: 'two', name: '另一个任务', cwd: '/fixture', turns: [{ id: 'other-turn', status: 'completed', items: [{ id: 'other', type: 'agentMessage', text: fenced('sequenceDiagram\n Alice->>Bob: 另一任务'), phase: 'final_answer' }] }] },
];
let cursor = 0, events = [];
const receipts = new Map();
const broker = {
  snapshot(after) { return { ready: true, bridgeId: 'mermaid-fixture', cursor, events: events.filter(event => event.cursor > after), active: { one: 'turn' }, approvals: [], capabilities: {} }; },
  submit(key, method, params) {
    let result;
    if (method === 'thread/list') result = { data: tasks, nextCursor: null };
    else if (method === 'thread/resume' || method === 'thread/read') result = { thread: tasks.find(task => task.id === params.threadId) };
    else throw Error(`Unexpected fixture command ${method}`);
    const receipt = { status: 'completed', result }; receipts.set(key, receipt); return receipt;
  },
  getCommand(key) { return receipts.get(key); },
};
const server = createWebServer(broker, { password, origin, audit: { record() {} }, uploadDirectory: temporary,
  readModels: async () => ({ models: [] }), modes: { read: async threadId => ({ threadId, collaborationMode: null }) } });
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const findings = { viewports: [], csp: [], requests: [], errors: [] };
let page;
try {
  for (const path of ['/mermaid.js', '/mermaid-renderer', '/vendor/mermaid-renderer.js']) assert.equal((await fetch(origin + path)).status, 401);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.request.post(origin + '/api/login', { headers: { Origin: origin }, data: { password } });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  await page.route(origin + '/api/projects', route => route.fulfill({ json: { projects: [], assignments: {} } }));
  await page.addInitScript(() => {
    if (window !== top) return;
    sessionStorage.setItem('codex-thread', 'one');
    window.violations = [];
    document.addEventListener('securitypolicyviolation', event => window.violations.push({
      directive: event.violatedDirective, blocked: event.blockedURI, source: event.sourceFile,
      line: event.lineNumber, sample: event.sample, target: event.target.nodeName,
    }));
  });
  page.on('pageerror', error => findings.errors.push(error.message));
  page.on('request', request => findings.requests.push(request.url()));
  const main = await page.goto(origin); const mainCsp = main.headers()['content-security-policy'];
  assert.match(mainCsp, /script-src 'self'; style-src 'self'/);
  await page.locator('.message-body pre').waitFor();
  assert.deepEqual(await page.evaluate(() => window.violations), [], 'baseline CSP before any Mermaid renderer loads');
  assert.equal(await page.locator('.mermaid-block').count(), 0);
  assert.equal(findings.requests.some(url => url.endsWith('/mermaid-renderer')), false, 'unclosed fences must not load Mermaid');
  function update(text) {
    item.text = text;
    events.push({ cursor: ++cursor, method: 'item/completed', params: { threadId: 'one', turnId: 'turn', item: { ...item } } });
  }
  update(fenced(graph));
  const preview = page.locator('.mermaid-preview').first();
  await preview.waitFor({ state: 'visible' });
  const svg = await preview.locator('img').evaluate(img => decodeURIComponent(img.src.split(',').slice(1).join(',')));
  assert.match(svg, /client_id/); assert.match(svg, /pi_session_id/); assert.doesNotMatch(svg, /foreignObject/);
  await writeFile(`${artifacts}/diagram.svg`, svg);
  const rendererResponse = await context.request.get(origin + '/mermaid-renderer');
  assert.equal(rendererResponse.status(), 200); assert.equal(rendererResponse.headers()['content-encoding'], 'gzip');
  assert.match(rendererResponse.headers()['content-security-policy'], /sandbox allow-scripts/);
  assert.match(rendererResponse.headers()['content-security-policy'], /connect-src 'none'/);
  assert.equal((await context.request.get(origin + '/vendor/mermaid-renderer.js')).status(), 404);
  findings.csp = [mainCsp, rendererResponse.headers()['content-security-policy']];
  await preview.evaluate(node => { window.originalDiagram = node; });
  update(fenced(graph) + '\n继续输出文字');
  await page.getByText('继续输出文字', { exact: true }).waitFor();
  assert.equal(await preview.evaluate(node => node === window.originalDiagram), true, 'streaming text must preserve the rendered DOM');
  assert.equal(findings.requests.filter(url => url.endsWith('/mermaid-renderer')).length, 1);
  await page.getByRole('button', { name: '查看源码', exact: true }).click();
  await page.getByRole('button', { name: '复制源码', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), graph + '\n');
  await page.getByRole('button', { name: '查看图形', exact: true }).click();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await preview.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `${artifacts}/preview-${width}.png` });
    await preview.click();
    const dialog = page.locator('.mermaid-dialog'); await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector('.mermaid-dialog output').value === '100%');
    if (width === 320) {
      const buttons = await dialog.locator('.mermaid-toolbar button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
      assert.equal(new Set(buttons).size, 1, '320px viewer toolbar stays on one row');
    }
    await page.screenshot({ path: `${artifacts}/fit-${width}.png` });
    await dialog.getByRole('button', { name: '放大图形', exact: true }).click();
    await dialog.getByRole('button', { name: '放大图形', exact: true }).click();
    assert.equal(await dialog.locator('output').textContent(), '225%');
    const viewport = dialog.locator('.mermaid-viewport'), bounds = await viewport.boundingBox();
    if (width === 390) {
      await viewport.evaluate(node => { node.scrollLeft = 0; node.scrollTop = 100; });
      await page.screenshot({ path: `${artifacts}/decision-390.png` });
    }
    const before = await viewport.evaluate(node => [node.scrollLeft, node.scrollTop]);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down(); await page.mouse.move(bounds.x + 25, bounds.y + 25, { steps: 8 }); await page.mouse.up();
    assert.notDeepEqual(await viewport.evaluate(node => [node.scrollLeft, node.scrollTop]), before);
    await page.screenshot({ path: `${artifacts}/zoom-${width}.png` });
    await dialog.getByRole('button', { name: '适配', exact: true }).click();
    assert.equal(await dialog.locator('output').textContent(), '100%');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await dialog.waitFor({ state: 'detached' }); findings.viewports.push(width);
  }
  // Actual touch contacts exercise pinch handling on a mobile viewport.
  await page.setViewportSize({ width: 390, height: 844 }); await preview.click();
  const client = await context.newCDPSession(page);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 140, y: 400, id: 1 }, { x: 230, y: 400, id: 2 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 80, y: 400, id: 1 }, { x: 300, y: 400, id: 2 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.ok(parseInt(await page.locator('.mermaid-dialog output').textContent()) > 100);
  await page.keyboard.press('Escape');
  await page.locator('#choose-task').click();
  await page.locator('[data-thread-id="two"] .task-card').click();
  await page.waitForFunction(() => decodeURIComponent(document.querySelector('.mermaid-preview img')?.src ?? '').includes('Alice'));
  assert.match(await page.locator('.mermaid-preview img').evaluate(img => decodeURIComponent(img.src)), /Alice/);
  assert.doesNotMatch(await page.locator('.mermaid-preview img').evaluate(img => decodeURIComponent(img.src)), /client_id/);
  await page.locator('#choose-task').click();
  await page.locator('[data-thread-id="one"] .task-card').click();
  await page.waitForFunction(() => decodeURIComponent(document.querySelector('.mermaid-preview img')?.src ?? '').includes('client_id'));
  // These cases use the same real app parser, renderer, headers and session.
  for (const [name, source] of [
    ['syntax-error', 'flowchart TD\nA[broken'],
    ['config', '%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\nA-->B'],
    ['frontmatter', '---\nconfig:\n securityLevel: loose\n---\nflowchart TD\nA-->B'],
    ['oversize', 'flowchart TD\n' + 'a'.repeat(16001)],
    ['too-many-edges', 'flowchart TD\n' + Array.from({ length: 161 }, (_, index) => `A${index} --> A${index + 1}`).join('\n')],
  ]) {
    update(fenced(source));
    await page.waitForFunction(expected => document.querySelector('.mermaid-block pre')?.textContent === expected, source + '\n');
    await page.waitForFunction(() => document.querySelector('.mermaid-block pre')?.hidden === false);
    await page.waitForFunction(() => /源码|自定义配置|图形过大/.test(document.querySelector('.mermaid-block > p')?.textContent ?? ''));
    assert.equal(await page.locator('.mermaid-block pre').textContent(), source + '\n', name);
  }
  const hostile = 'flowchart TD\nA["<img src=https://attacker.invalid/pixel onerror=alert(1)>"] --> B[安全文本]\nclick B "https://attacker.invalid/"';
  update(fenced(hostile));
  await page.waitForFunction(expected => document.querySelector('.mermaid-block pre')?.textContent === expected, hostile + '\n');
  await page.waitForFunction(() => /点击图形|暂不可用/.test(document.querySelector('.mermaid-block > p')?.textContent ?? ''));
  assert.equal(await page.locator('.message-body svg, .message-body iframe, .message-body script, .message-body a[href*="attacker"]').count(), 0);
  assert.equal(findings.requests.some(url => url.includes('attacker.invalid')), false);
  update(fenced('flowchart TD\nA[安全文本] --> B[结果]\nclick B "https://attacker.invalid/"'));
  await page.waitForFunction(() => document.querySelector('.mermaid-block pre')?.textContent.includes('A[安全文本]'));
  await page.locator('.mermaid-block').scrollIntoViewIfNeeded();
  await preview.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.message-body a[href*="attacker"]').count(), 0);
  update('```javascript\nconst html = "<script>alert(1)</script>";\n```');
  await page.locator('.copy-code').waitFor();
  assert.equal(await page.locator('.mermaid-block').count(), 0);
  assert.match(await page.locator('.message-body pre').textContent(), /<script>/);
  assert.deepEqual(await page.evaluate(() => window.violations), []);
  assert.deepEqual(findings.errors, []);
  // A failed local renderer download preserves source, then recovers on retry.
  item.text = fenced(graph); events = [];
  const retryPage = await context.newPage(); retryPage.setDefaultTimeout(22000);
  await retryPage.route(origin + '/api/projects', route => route.fulfill({ json: { projects: [], assignments: {} } }));
  await retryPage.route(origin + '/mermaid-renderer', route => route.fulfill({ status: 503, body: 'fixture unavailable' }));
  await retryPage.addInitScript(() => { if (window === top) sessionStorage.setItem('codex-thread', 'one'); });
  await retryPage.goto(origin);
  await retryPage.getByRole('button', { name: '重试图形', exact: true }).waitFor();
  assert.equal(await retryPage.locator('.mermaid-block pre').textContent(), graph + '\n');
  await retryPage.unroute(origin + '/mermaid-renderer');
  await retryPage.getByRole('button', { name: '重试图形', exact: true }).click();
  await retryPage.locator('.mermaid-preview').waitFor({ state: 'visible' });
  // Clipboard is unavailable on many plain-HTTP phone origins.
  await retryPage.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
  await retryPage.getByRole('button', { name: '复制源码', exact: true }).click();
  assert.equal(await retryPage.locator('.mermaid-block pre').isVisible(), true);
  await retryPage.getByRole('button', { name: '请长按源码复制', exact: true }).waitFor();
  findings.retry = 'renderer 503 -> source fallback -> retry success';
  findings.clipboardFallback = true;
  await writeFile(`${artifacts}/evidence.json`, JSON.stringify(findings, null, 2));
  console.log('PASS: real authenticated HTTP/CSP, lazy loading, SVG text/br, 320/390/1280, copy, zoom/pan/pinch/reset, task switch, stream reuse, safe source fallbacks and malicious input.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${artifacts}/failure.png` });
    console.error('Diagram status:', await page.locator('.mermaid-block > p').allTextContents());
  }
  console.error('Page errors:', findings.errors);
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true });
}
