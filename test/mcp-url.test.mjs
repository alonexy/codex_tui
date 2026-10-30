import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Broker } from '../src/broker.mjs';
import * as approvals from '../public/approval-state.js';
import { serveBridge, connectBridge } from '../src/bridge-api.mjs';
import { createWebServer } from '../src/http.mjs';

const request = (id = 42, overrides = {}) => ({
  id, method: 'mcpServer/elicitation/request', params: {
    threadId: 'temporary-thread', serverName: 'test-server', mode: 'url',
    message: 'Open the authorization page to connect.', elicitationId: 'test-elicitation',
    url: 'https://example.test/connect', ...overrides,
  },
});
function fixture() {
  const sent = [], desktop = [];
  const broker = new Broker(message => sent.push(message), message => desktop.push(message));
  broker.ready = true;
  return { broker, sent, desktop };
}

test('MCP URL actions preserve the original typed ID and omit content and metadata', () => {
  for (const id of [42, '42']) for (const action of ['accept', 'decline', 'cancel']) {
    const { broker, sent, desktop } = fixture(), incoming = request(id);
    broker.receive(incoming);
    assert.deepEqual(broker.snapshot().approvals, [incoming]);
    assert.deepEqual(desktop, [incoming]);
    assert.equal(approvals.isAnswerable(incoming), true);
    broker.answer(id, { action });
    assert.deepEqual(sent, [{ id, result: { action } }]);
    assert.deepEqual(broker.snapshot().approvals, []);
    assert.throws(() => broker.answer(id, { action }), /已处理/);
    assert.equal(sent.length, 1);
  }
});

test('MCP URL recognition requires native nonempty fields and a credential-free HTTPS URL', () => {
  assert.equal(typeof approvals.isMcpUrlElicitation, 'function');
  assert.equal(approvals.isMcpUrlElicitation(request()), true);
  const invalid = [
    ...['threadId', 'serverName', 'message', 'elicitationId', 'url']
      .flatMap(key => [undefined, null, '', ' \t', 42].map(value => ({ [key]: value }))),
    ...['form', 'openai/url', undefined].map(mode => ({ mode })),
    ...['http://example.test/connect', 'javascript:alert(1)', 'data:text/html,connect',
      '//example.test/connect', '/connect', 'https://', 'https:example.test/connect',
      'https://user@example.test/connect', 'https://user:password@example.test/connect',
      'https://:password@example.test/connect', 'https://example.test/connect\n',
      ' https://example.test/connect', 'https://example.test/con nect',
      'https://example.test\\connect'].map(url => ({ url })),
  ];
  for (const params of invalid) {
    const { broker, sent } = fixture(), incoming = request(42, params);
    broker.receive(incoming);
    assert.equal(approvals.isMcpUrlElicitation(incoming), false, JSON.stringify(params));
    assert.equal(approvals.isAnswerable(incoming), false, JSON.stringify(params));
    for (const action of ['accept', 'decline', 'cancel']) {
      assert.throws(() => broker.answer(42, { action }), /桌面处理/, JSON.stringify(params));
    }
    assert.deepEqual(sent, []);
    assert.deepEqual(broker.snapshot().approvals, [incoming]);
  }
  assert.equal(approvals.isMcpUrlElicitation({ ...request(), method: 'other/request' }), false);
});

test('MCP URL response validation rejects any content, metadata or extra fields without consuming pending requests', () => {
  const { broker, sent } = fixture();
  broker.receive(request());
  const invalid = [null, [], {}, { decision: 'accept' }, { action: 'always' },
    { action: 'ACCEPT' }, { action: null },
    ...['accept', 'decline', 'cancel'].flatMap(action => [
      ...[null, {}, [], undefined].map(content => ({ action, content })),
      { action, _meta: {} }, { action, other: true },
    ])];
  for (const result of invalid) {
    assert.throws(() => broker.answer(42, result), /无效/);
    assert.deepEqual(broker.snapshot().approvals, [request()]);
  }
  assert.deepEqual(sent, []);
  broker.answer(42, { action: 'accept' });
  assert.deepEqual(sent, [{ id: 42, result: { action: 'accept' } }]);
});

test('MCP URL phone, desktop and resolved races emit at most one upstream answer', () => {
  for (const first of ['phone', 'desktop', 'resolved']) {
    const { broker, sent } = fixture();
    broker.receive(request());
    if (first === 'phone') broker.answer(42, { action: 'accept' });
    if (first === 'desktop') broker.fromDesktop({ id: 42, result: { action: 'decline' } });
    if (first === 'resolved') broker.receive({ method: 'serverRequest/resolved', params: {
      requestId: 42, threadId: 'temporary-thread',
    } });
    broker.fromDesktop({ id: 42, result: { action: 'cancel' } });
    assert.throws(() => broker.answer(42, { action: 'accept' }), /已处理/);
    assert.deepEqual(sent, first === 'resolved' ? [] : [{
      id: 42, result: { action: first === 'phone' ? 'accept' : 'decline' },
    }]);
    assert.deepEqual(broker.snapshot().approvals, []);
  }
});

test('MCP URL typed IDs stay distinct and disconnected brokers cannot answer pending requests', () => {
  const { broker, sent } = fixture();
  broker.receive(request(42)); broker.receive(request('42'));
  broker.answer('42', { action: 'cancel' });
  assert.deepEqual(broker.snapshot().approvals, [request(42)]);
  broker.ready = false;
  assert.throws(() => broker.answer(42, { action: 'accept' }), /连接/);
  broker.ready = true; broker.closed = true;
  assert.throws(() => broker.answer(42, { action: 'accept' }), /连接/);
  assert.deepEqual(sent, [{ id: '42', result: { action: 'cancel' } }]);
});

test('MCP URL reminders remain answerable without a persisted thread and clear after resolution', () => {
  const state = new approvals.ApprovalState();
  state.snapshot({ ready: true, approvals: [request()], events: [] });
  assert.equal(approvals.approvalLabel(state.get('temporary-thread')), '1 项待批准');
  state.disconnect();
  assert.match(approvals.approvalLabel(state.get('temporary-thread')), /待核对/);
  state.snapshot({ ready: true, approvals: [], events: [] });
  assert.equal(state.entries().size, 0);
});

test('HTTP and Unix bridge advertise MCP URL capability and forward only valid pending actions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-url-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { broker, sent } = fixture();
  const socket = join(directory, 'bridge.sock');
  const bridge = await serveBridge(broker, socket, 'desktop-shared');
  t.after(() => new Promise(resolve => bridge.close(resolve)));
  const client = connectBridge(socket);
  const origin = 'http://127.0.0.1:8787', password = 'isolated-url-test';
  const server = createWebServer(client, { password, origin });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const post = body => fetch(`${base}/api/answer`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  assert.equal((await client.snapshot()).capabilities?.mcpUrlElicitation, true);
  broker.receive(request());
  assert.equal((await post({ id: 42, result: { action: 'accept' } })).status, 401);
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers, body: JSON.stringify({ password }),
  });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const state = await (await fetch(`${base}/api/state`, { headers })).json();
  assert.equal(state.capabilities?.mcpUrlElicitation, true);
  assert.deepEqual(state.approvals, [request()]);
  assert.equal((await post({ id: '42', result: { action: 'accept' } })).status, 400);
  for (const result of [{ action: 'accept', content: {} }, { action: 'accept', _meta: {} }]) {
    assert.equal((await post({ id: 42, result })).status, 400);
    await assert.rejects(client.answer(42, result), /无效/);
  }
  assert.deepEqual(sent, []);
  for (const action of ['accept', 'decline', 'cancel']) {
    const id = `http-${action}`;
    broker.receive(request(id));
    assert.equal((await post({ id, result: { action } })).status, 200);
    assert.deepEqual(sent.at(-1), { id, result: { action } });
    assert.equal((await post({ id, result: { action } })).status, 400);
    const bridgeId = `bridge-${action}`;
    broker.receive(request(bridgeId));
    await client.answer(bridgeId, { action });
    assert.deepEqual(sent.at(-1), { id: bridgeId, result: { action } });
    await assert.rejects(client.answer(bridgeId, { action }), /已处理/);
  }
  broker.receive(request('unsafe', { url: 'javascript:alert(1)' }));
  assert.equal((await post({ id: 'unsafe', result: { action: 'accept' } })).status, 400);
  await assert.rejects(client.answer('unsafe', { action: 'accept' }), /桌面处理/);
  assert.equal(sent.length, 6);
});
