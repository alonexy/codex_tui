import test from 'node:test';
import assert from 'node:assert/strict';
import { Broker } from '../src/broker.mjs';

function fixture(options = {}) {
  const upstream = [], desktop = [];
  const broker = new Broker(message => upstream.push(message), message => desktop.push(message), options);
  broker.ready = true;
  return { broker, upstream, desktop };
}

test('over 5000 reads keep bounded receipts and preserve execution deduplication', () => {
  const { broker, upstream } = fixture();
  const params = { threadId: 'task', name: 'saved' };
  const execution = broker.submit('write-first', 'thread/name/set', params);
  broker.receive({ id: upstream.at(-1).id, result: {} });
  for (let i = 0; i < 5100; i++) {
    const method = i % 2 ? 'thread/list' : 'thread/resume';
    const receipt = broker.submit(`read-${String(i).padStart(5, '0')}`, method, { threadId: 'task' });
    broker.receive({ id: upstream.at(-1).id, result: method === 'thread/list' ? { data: [] } : { thread: { id: 'task' } } });
    assert.equal(receipt.status, 'completed');
  }
  assert.equal(broker.readCommands.size, 256);
  assert.equal(broker.getCommand('read-00000'), null);
  assert.equal(broker.getCommand('read-05099').status, 'completed');
  assert.equal(broker.commands.size, 1);
  assert.equal(broker.submit('write-first', 'thread/name/set', params), execution);
  assert.throws(() => broker.submit('write-first', 'thread/name/set', {}), /不同内容/);
  assert.equal(upstream.length, 5101);
  assert.equal(broker.submit('write-next', 'thread/name/set', params).status, 'pending');
  broker.close();
});

test('read timeout frees capacity and ignores late responses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { broker, upstream } = fixture({ rpcTimeoutMs: 10, maxRoutes: 1, maxReadReceipts: 1 });
  const receipt = broker.submit('read-first', 'thread/read', { threadId: 'task' });
  assert.throws(() => broker.submit('read-other', 'thread/list'), /未完成请求/);
  const oldId = upstream[0].id;
  t.mock.timers.tick(10);
  await Promise.resolve();
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.error.message, /读取超时/);
  assert.equal(broker.routes.size, 0);
  const next = broker.submit('read-other', 'thread/list');
  broker.receive({ id: oldId, result: { thread: { id: 'task', status: { type: 'active' } } } });
  assert.equal(receipt.status, 'failed');
  assert.equal(next.status, 'pending');
  assert.equal(broker.threadStatus.has('task'), false);
  broker.close();
});

test('execution timeout stays unknown, blocks replay and converges on a late reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const error of [undefined, { code: -1, message: 'rejected' }]) {
    const { broker, upstream } = fixture({ rpcTimeoutMs: 10, maxRoutes: 1 });
    const params = { threadId: 'task' };
    const receipt = broker.submit('write-start', 'turn/start', params);
    t.mock.timers.tick(10);
    await Promise.resolve();
    assert.equal(receipt.status, 'unknown');
    assert.match(receipt.error.message, /不要重复提交/);
    assert.equal(broker.submit('write-start', 'turn/start', params), receipt);
    assert.equal(upstream.length, 1);
    assert.throws(() => broker.submit('write-other', 'thread/name/set', params), /未完成请求/);
    broker.receive({ id: upstream[0].id, result: error ? undefined : { turn: { id: 'turn' } }, error });
    assert.equal(receipt.status, error ? 'failed' : 'completed');
    assert.equal(broker.routes.size, 0);
    assert.equal(broker.starting.has('task'), false);
    assert.equal(broker.submit('write-next', 'thread/name/set', params).status, 'pending');
    broker.close();
    await Promise.resolve();
  }
});

test('timeout rejection cannot overwrite a reply delivered before its microtask', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { broker, upstream } = fixture({ rpcTimeoutMs: 10 });
  const receipt = broker.submit('write-race', 'thread/archive', { threadId: 'task' });
  t.mock.timers.tick(10);
  broker.receive({ id: upstream[0].id, result: {} });
  await Promise.resolve();
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.error, undefined);
  assert.equal(broker.archived.has('task'), true);
  assert.equal(broker.archiving.has('task'), false);
});

test('execution receipt limit preserves old IDs while reads remain available', () => {
  const { broker, upstream } = fixture({ maxWriteReceipts: 1 });
  const params = { threadId: 'task' };
  const receipt = broker.submit('write-first', 'thread/goal/clear', params);
  broker.receive({ id: upstream[0].id, result: {} });
  assert.throws(() => broker.submit('write-other', 'thread/goal/clear', params), /执行回执已满/);
  assert.equal(broker.submit('write-first', 'thread/goal/clear', params), receipt);
  assert.equal(broker.submit('read-first', 'thread/goal/get', params).status, 'pending');
  assert.equal(upstream.length, 2);
  broker.close();
});

test('pending read receipts are not evicted and disconnect distinguishes reads from executions', async () => {
  const { broker } = fixture({ maxReadReceipts: 1 });
  const read = broker.submit('read-first', 'thread/list');
  assert.throws(() => broker.submit('read-other', 'thread/list'), /未完成读取/);
  const write = broker.submit('write-first', 'thread/goal/clear', { threadId: 'task' });
  broker.close();
  await Promise.resolve();
  assert.equal(read.status, 'failed');
  assert.match(read.error.message, /读取失败/);
  assert.equal(write.status, 'unknown');
  assert.equal(broker.routes.size, 0);
});

test('desktop read timeouts release routes and route admission prevents unbounded accumulation', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { broker, upstream, desktop } = fixture({ rpcTimeoutMs: 10, maxRoutes: 1 });
  broker.fromDesktop({ id: 1, method: 'thread/list', params: {} });
  broker.fromDesktop({ id: 2, method: 'thread/list', params: {} });
  assert.equal(upstream.length, 1);
  assert.match(desktop[0].error.message, /未完成请求/);
  t.mock.timers.tick(10);
  assert.equal(broker.routes.size, 0);
  assert.equal(desktop[1].id, 1);
  assert.match(desktop[1].error.message, /读取超时/);
  broker.receive({ id: upstream[0].id, result: { data: [] } });
  assert.equal(desktop.length, 2);
});

for (const method of ['config/read', 'model/list']) {
  test(`desktop ${method} timeout releases capacity without expanding web access`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { broker, upstream, desktop } = fixture({ rpcTimeoutMs: 10, maxRoutes: 1 });
    assert.throws(() => broker.submit('web-read', method, {}), /不支持/);
    broker.fromDesktop({ id: 'desktop-read', method, params: {} });
    const oldId = upstream[0].id;
    t.mock.timers.tick(10);
    assert.equal(broker.routes.size, 0);
    assert.equal(desktop[0].id, 'desktop-read');
    assert.match(desktop[0].error.message, /读取超时/);
    broker.fromDesktop({ id: 'desktop-next', method, params: {} });
    assert.equal(upstream.length, 2);
    broker.receive({ id: oldId, result: { data: [] } });
    assert.equal(desktop.length, 1);
    assert.equal(broker.routes.size, 1);
    broker.receive({ id: upstream[1].id, result: { data: [] } });
    assert.equal(desktop[1].id, 'desktop-next');
    assert.equal(broker.routes.size, 0);
  });
}

test('a transport exception keeps execution uncertain and allows its late response', async () => {
  let request;
  const broker = new Broker(message => { request = message; throw new Error('transport failed'); });
  broker.ready = true;
  const receipt = broker.submit('write-first', 'thread/name/set', { threadId: 'task' });
  await Promise.resolve();
  assert.equal(receipt.status, 'unknown');
  broker.receive({ id: request.id, result: {} });
  assert.equal(receipt.status, 'completed');
});

test('synchronous admission rejection is explicit and never sends upstream', () => {
  const { broker, upstream } = fixture({ maxRoutes: 1 });
  for (const [key, method, params] of [
    ['invalid', 'thread/list', {}],
    ['invalid-method', 'unsupported', {}],
    ['invalid-params', 'thread/list', null],
  ]) {
    assert.throws(() => broker.submit(key, method, params), error => error.submission === 'rejected');
  }
  assert.equal(upstream.length, 0);
  const receipt = broker.submit('write-first', 'thread/name/set', { threadId: 'task', name: 'first' });
  assert.throws(() => broker.submit('write-other', 'thread/name/set', { threadId: 'task' }),
    error => error.submission === 'rejected' && /未完成请求/.test(error.message));
  assert.equal(broker.getCommand('write-other'), null);
  assert.equal(upstream.length, 1);
  assert.equal(receipt.status, 'pending');
  broker.close();
});
