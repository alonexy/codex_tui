import test from 'node:test';
import assert from 'node:assert/strict';
import { Broker } from '../src/broker.mjs';
import { ApprovalState, approvalLabel, isAnswerable } from '../public/approval-state.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveBridge, connectBridge } from '../src/bridge-api.mjs';
import { createWebServer } from '../src/http.mjs';

const request = (id = 42, overrides = {}) => ({ id, method: 'mcpServer/elicitation/request', params: {
  threadId: 'one', turnId: 'turn', serverName: 'cua_repl', mode: 'form',
  message: 'Allow full browser access?', requestedSchema: { type: 'object', properties: {} },
  _meta: { codex_approval_kind: 'mcp_tool_call', connector_name: 'Browser use', full_cdp_access: true, persist: 'always', riskLevel: 'high', origin: 'https://example.com' },
  ...overrides,
} });
function fixture() {
  const sent = [], desktop = [];
  const broker = new Broker(message => sent.push(message), message => desktop.push(message));
  broker.ready = true;
  return { broker, sent, desktop };
}

test('MCP empty form is visible and answerable with original typed ID and action response', () => {
  for (const id of [42, '42']) for (const action of ['accept', 'decline', 'cancel']) {
    const { broker, sent, desktop } = fixture(), incoming = request(id);
    broker.receive(incoming);
    assert.deepEqual(broker.snapshot().approvals, [incoming]);
    assert.deepEqual(desktop, [incoming]);
    assert.equal(isAnswerable(incoming), true);
    const result = action === 'accept' ? { action, content: {} } : { action };
    broker.answer(id, result);
    assert.deepEqual(sent, [{ id, result }]);
    assert.equal(broker.snapshot().approvals.length, 0);
    assert.throws(() => broker.answer(id, result), /已处理/);
  }
});

test('unsupported MCP forms remain visible but cannot be accepted or answered blindly', () => {
  const schemas = [null, [], {}, { type: 'object', properties: [] },
    { type: 'object', properties: { name: { type: 'string' } } },
    ...[{ required: ['missing'] }, { required: 'bad' }, { additionalProperties: false },
      { allOf: [] }, { minProperties: 1 }, { $ref: '#/other' }, { $schema: 'https://unknown.example' }]
      .map(extra => ({ type: 'object', properties: {}, ...extra }))];
  const overrides = [...schemas.map(requestedSchema => ({ requestedSchema })),
    ...['url', 'openai/form', 'openaiForm', undefined].map(mode => ({ mode }))];
  for (const params of overrides) {
    const { broker, sent } = fixture(), incoming = request(42, params);
    broker.receive(incoming);
    assert.equal(broker.snapshot().approvals.length, 1);
    assert.equal(isAnswerable(incoming), false, JSON.stringify(params));
    for (const action of ['accept', 'decline', 'cancel']) assert.throws(() => broker.answer(42, { action, content: {} }), /桌面处理/);
    assert.equal(sent.length, 0);
  }
});

test('MCP response validation rejects metadata, extra keys, invalid actions and nonempty content without consuming request', () => {
  const { broker, sent } = fixture();
  broker.receive(request());
  for (const result of [null, [], { decision: 'accept' }, { action: 'always' },
    { action: 'accept' }, { action: 'accept', content: null }, { action: 'accept', content: [] },
    { action: 'accept', content: { injected: true } }, { action: 'accept', content: {}, _meta: { persist: 'always' } },
    { action: 'decline', _meta: {} }, { action: 'cancel', other: true }, { action: 'decline', content: {} }]) {
    assert.throws(() => broker.answer(42, result), /无效/);
    assert.equal(broker.snapshot().approvals.length, 1);
  }
  assert.equal(sent.length, 0);
  broker.answer(42, { action: 'accept', content: {} });
  assert.equal(sent.length, 1);
});

test('MCP resolution, desktop races, typed IDs and disconnection cannot send a stale answer', () => {
  for (const first of ['desktop', 'phone', 'resolved']) {
    const { broker, sent } = fixture();
    broker.receive(request());
    if (first === 'phone') broker.answer(42, { action: 'decline' });
    if (first === 'resolved') broker.receive({ method: 'serverRequest/resolved', params: { requestId: 42, threadId: 'one' } });
    broker.fromDesktop({ id: 42, result: { action: 'cancel' } });
    assert.throws(() => broker.answer(42, { action: 'accept', content: {} }), /已处理/);
    assert.equal(sent.length, first === 'resolved' ? 0 : 1);
  }
  const { broker, sent } = fixture();
  broker.receive(request(42)); broker.receive(request('42'));
  broker.answer('42', { action: 'decline' });
  assert.deepEqual(broker.snapshot().approvals.map(value => value.id), [42]);
  broker.closed = true;
  assert.throws(() => broker.answer(42, { action: 'accept', content: {} }), /连接/);
  assert.equal(sent.length, 1);
});

test('MCP reminders keep task ownership, unsupported notices and resolved/disconnected lifetimes', () => {
  const state = new ApprovalState();
  state.snapshot({ ready: true, approvals: [request(), request('other', { threadId: 'two', mode: 'url' })], events: [] });
  assert.equal(approvalLabel(state.get('one')), '1 项待批准');
  assert.match(approvalLabel(state.get('two')), /需在桌面处理/);
  state.disconnect();
  assert.match(approvalLabel(state.get('one')), /待核对/);
  state.snapshot({ ready: true, approvals: [], events: [] });
  assert.equal(state.entries().size, 0);
});

test('authenticated HTTP and local bridge forward only validated, pending MCP responses upstream', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-approval-'));
  const { broker, sent } = fixture();
  const socket = join(directory, 'bridge.sock');
  const bridge = await serveBridge(broker, socket, 'desktop-shared');
  const origin = 'http://127.0.0.1:8787', password = 'isolated-mcp-test';
  const server = createWebServer(connectBridge(socket), { password, origin });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => bridge.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const post = (body, auth = headers) => fetch(`${base}/api/answer`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  broker.receive(request());
  const accepted = { id: 42, result: { action: 'accept', content: {} } };
  assert.equal((await post(accepted)).status, 401);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers, body: JSON.stringify({ password }) });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post(accepted, { ...headers, Origin: 'https://other.example' })).status, 403);
  assert.deepEqual((await (await fetch(`${base}/api/state`, { headers })).json()).approvals, [request()]);
  assert.equal((await post({ id: '42', result: accepted.result })).status, 400);
  assert.equal((await post({ id: 42, result: { ...accepted.result, _meta: { persist: 'always' } } })).status, 400);
  assert.equal(sent.length, 0);
  assert.equal((await post(accepted)).status, 200);
  assert.deepEqual(sent, [accepted]);
  assert.equal((await post(accepted)).status, 400);
  broker.receive(request('resolved'));
  broker.receive({ method: 'serverRequest/resolved', params: { requestId: 'resolved', threadId: 'one' } });
  assert.equal((await post({ id: 'resolved', result: { action: 'decline' } })).status, 400);
  broker.receive(request('declined'));
  assert.equal((await post({ id: 'declined', result: { action: 'decline' } })).status, 200);
  assert.deepEqual(sent.at(-1), { id: 'declined', result: { action: 'decline' } });
});
