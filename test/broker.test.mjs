import test from 'node:test';
import assert from 'node:assert/strict';
import { Broker } from '../src/broker.mjs';

function fixture() {
  const upstream = [], desktop = [];
  const broker = new Broker(m => upstream.push(m), m => desktop.push(m));
  broker.ready = true;
  return { broker, upstream, desktop };
}

test('native archive and restore are deduplicated, preserve failed receipts and enforce ownership', async () => {
  const { broker, upstream } = fixture();
  assert.equal(broker.snapshot().capabilities.taskArchive, true);
  const receipt = broker.submit('archive-001', 'thread/archive', { threadId: 'task' });
  assert.equal(broker.submit('archive-001', 'thread/archive', { threadId: 'task' }), receipt);
  assert.equal(upstream.length, 1);
  broker.receive({ method: 'thread/archived', params: { threadId: 'task' } });
  broker.receive({ id: upstream[0].id, result: {} });
  assert.equal(receipt.status, 'completed');
  assert.throws(() => broker.submit('resume-001', 'thread/resume', { threadId: 'task' }), /已归档/);
  const restore = broker.submit('restore-001', 'thread/unarchive', { threadId: 'task' });
  broker.receive({ id: upstream[1].id, error: { code: -1, message: 'restore rejected' } });
  await Promise.resolve();
  assert.equal(restore.status, 'failed');
  assert.equal(broker.getCommand('restore-001'), restore);
  broker.submit('restore-002', 'thread/unarchive', { threadId: 'task' });
  broker.receive({ id: upstream[2].id, result: { thread: { id: 'task' } } });
  assert.doesNotThrow(() => broker.submit('resume-002', 'thread/resume', { threadId: 'task' }));
  const privateBroker = new Broker(() => {}, () => {}, { ownedThreads: new Set(['owned']) }); privateBroker.ready = true;
  for (const method of ['thread/archive', 'thread/unarchive']) assert.throws(() => privateBroker.submit('private-001', method, { threadId: 'foreign' }), /独立模式/);
});

test('archive blocks observed runs, pending starts and native desktop waits before upstream submission', () => {
  const { broker, upstream } = fixture();
  broker.receive({ method: 'turn/started', params: { threadId: 'running', turn: { id: 'turn' } } });
  broker.submit('start-001', 'turn/start', { threadId: 'starting' });
  broker.receive({ method: 'thread/status/changed', params: { threadId: 'waiting', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
  broker.receive({ id: 'approval', method: 'item/tool/requestUserInput', params: { threadId: 'approval' } });
  for (const id of ['running', 'starting', 'waiting', 'approval']) {
    const receipt = broker.submit(`archive-${id}`, 'thread/archive', { threadId: id });
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.error.message, /运行或等待/);
    assert.equal(broker.getCommand(`archive-${id}`), receipt);
  }
  assert.equal(upstream.length, 1);
});

test('desktop archive responses identify their task and stale lists cannot erase a newer native wait', () => {
  const { broker, upstream } = fixture();
  broker.fromDesktop({ id: 1, method: 'thread/archive', params: { threadId: 'desktop-task' } });
  broker.receive({ id: upstream[0].id, result: {} });
  assert.equal(broker.archived.has('desktop-task'), true);
  assert.equal(broker.archived.has(undefined), false);
  broker.submit('list-0001', 'thread/list', {});
  broker.receive({ method: 'thread/status/changed', params: { threadId: 'waiting', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
  broker.receive({ id: upstream[1].id, result: { data: [{ id: 'waiting', status: { type: 'idle' } }] } });
  assert.equal(broker.submit('archive-wait', 'thread/archive', { threadId: 'waiting' }).status, 'failed');
  broker.submit('archive-idle', 'thread/archive', { threadId: 'idle' });
  assert.throws(() => broker.submit('turn-idle', 'turn/start', { threadId: 'idle' }), /正在归档/);
});

test('goal and task commands share upstream, receipts and standalone ownership checks', () => {
  const { broker, upstream } = fixture();
  assert.equal(broker.snapshot().capabilities.taskCommands, true);
  const methods = ['thread/goal/get', 'thread/goal/set', 'thread/goal/clear', 'thread/name/set', 'thread/compact/start'];
  const privateBroker = new Broker(() => {}, () => {}, { ownedThreads: new Set(['owned']) });
  privateBroker.ready = true;
  methods.forEach((method, index) => {
    const params = { threadId: 'task', objective: 'test' };
    const receipt = broker.submit(`command-${index}`, method, params);
    assert.equal(broker.submit(`command-${index}`, method, params), receipt);
    assert.equal(upstream[index].method, method);
    broker.receive({ id: upstream[index].id, result: { goal: null } });
    assert.equal(receipt.status, 'completed');
    assert.throws(() => privateBroker.submit(`private-${index}`, method, params), /独立模式/);
  });
});

test('pagination uses the shared upstream and retains standalone ownership checks', () => {
  const { broker, upstream } = fixture();
  assert.equal(broker.snapshot().capabilities.paginatedHistory, true);
  broker.submit('page-0001', 'thread/items/list', { threadId: 'task', limit: 100 });
  assert.equal(upstream[0].method, 'thread/items/list');
  const privateBroker = new Broker(() => {}, () => {}, { ownedThreads: new Set(['owned']) });
  privateBroker.ready = true;
  assert.throws(() => privateBroker.submit('page-0002', 'thread/items/list', { threadId: 'desktop' }), /独立模式/);
  privateBroker.submit('page-0003', 'thread/turns/list', { threadId: 'owned' });
});

test('desktop initialize success makes the bridge ready without a separate notification', () => {
  const sent = [];
  const broker = new Broker(message => sent.push(message));
  broker.fromDesktop({ id: 1, method: 'initialize', params: { clientInfo: { name: 'desktop' } } });
  assert.equal(broker.snapshot().ready, false);
  broker.receive({ id: sent[0].id, result: { userAgent: 'codex' } });
  assert.equal(broker.snapshot().ready, true);
  assert.doesNotThrow(() => broker.submit('phone-001', 'thread/list', {}));
});

test('an initialized notification cannot turn a failed initialization into ready', () => {
  const sent = [];
  const broker = new Broker(message => sent.push(message));
  broker.fromDesktop({ id: 1, method: 'initialize', params: {} });
  broker.receive({ id: sent[0].id, error: { code: -1, message: 'failed' } });
  broker.fromDesktop({ method: 'initialized', params: {} });
  assert.equal(broker.snapshot().ready, false);
});

test('desktop and phone request IDs cannot collide; replies go only to their caller', () => {
  const { broker, upstream, desktop } = fixture();
  broker.fromDesktop({ id: 1, method: 'thread/list', params: {} });
  const command = broker.submit('phone-001', 'thread/list', {});
  assert.notEqual(upstream[0].id, upstream[1].id);
  broker.receive({ id: upstream[1].id, result: { data: [] } });
  assert.equal(command.status, 'completed');
  assert.equal(desktop.length, 0);
  broker.receive({ id: upstream[0].id, result: { data: ['desktop'] } });
  assert.deepEqual(desktop[0], { id: 1, result: { data: ['desktop'] } });
});

test('duplicate submission reuses the receipt and never sends a second turn', () => {
  const { broker, upstream } = fixture();
  const params = { threadId: 'a', input: [{ type: 'text', text: 'hello' }] };
  const first = broker.submit('phone-001', 'turn/start', params);
  assert.equal(broker.submit('phone-001', 'turn/start', params), first);
  assert.equal(upstream.length, 1);
  assert.throws(() => broker.submit('phone-001', 'turn/start', {}), /不同内容/);
  assert.throws(() => broker.submit('phone-002', 'turn/start', params), /正在运行/);
});

test('both approval races consume the server request once', () => {
  for (const first of ['phone', 'desktop']) {
    const { broker, upstream } = fixture();
    broker.receive({ id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'a' } });
    if (first === 'phone') {
      broker.answer(42, { decision: 'decline' });
      broker.fromDesktop({ id: 42, result: { decision: 'accept' } });
    } else {
      broker.fromDesktop({ id: 42, result: { decision: 'accept' } });
      assert.throws(() => broker.answer(42, { decision: 'decline' }), /已处理/);
    }
    assert.equal(upstream.length, 1);
    assert.equal(broker.snapshot().approvals.length, 0);
  }
});

test('desktop dynamic tool calls remain desktop-owned', () => {
  const { broker, upstream, desktop } = fixture();
  const request = { id: 'tool', method: 'item/tool/call', params: {} };
  broker.receive(request);
  assert.deepEqual(desktop, [request]);
  assert.equal(broker.snapshot().approvals.length, 0);
  assert.throws(() => broker.answer('tool', {}), /桌面处理/);
  broker.fromDesktop({ id: 'tool', result: { success: true } });
  assert.equal(upstream.length, 1);
});

test('steer requires the current turn; completion of an older turn does not clear a newer one', () => {
  const { broker } = fixture();
  broker.receive({ method: 'turn/started', params: { threadId: 'a', turn: { id: 'new' } } });
  broker.receive({ method: 'turn/completed', params: { threadId: 'a', turn: { id: 'old' } } });
  assert.equal(broker.snapshot().active.a, 'new');
  assert.throws(() => broker.submit('phone-001', 'turn/steer', { threadId: 'a', expectedTurnId: 'old' }), /轮次/);
  broker.submit('phone-002', 'turn/steer', { threadId: 'a', expectedTurnId: 'new' });
});

test('disconnect marks outstanding execution unknown; never replays on close', async () => {
  const { broker, upstream } = fixture();
  const record = broker.submit('phone-001', 'turn/start', { threadId: 'a' });
  broker.close();
  await Promise.resolve();
  assert.equal(record.status, 'unknown');
  assert.equal(upstream.length, 1);
  assert.equal(broker.snapshot().ready, false);
});

test('event cursor replays missed output and signals retention gaps', () => {
  const { broker } = fixture();
  for (let i = 0; i < 1002; i++) broker.record('delta', { delta: 'x' });
  assert.equal(broker.snapshot(0).reset, true);
  assert.equal(broker.snapshot(1000).events.length, 2);
  assert.equal(broker.snapshot(2000).reset, true);
});

test('standalone can only resume its own persisted threads', () => {
  const sent = [], saved = [];
  const broker = new Broker(m => sent.push(m), undefined, { ownedThreads: new Set(['owned']), saveOwnedThread: id => saved.push(id) });
  broker.ready = true;
  assert.throws(() => broker.submit('phone-001', 'thread/resume', { threadId: 'desktop' }), /桌面任务/);
  const list = broker.submit('phone-002', 'thread/list', {});
  broker.receive({ id: sent[0].id, result: { data: [{ id: 'owned' }, { id: 'desktop' }] } });
  assert.deepEqual(list.result.data, [{ id: 'owned' }]);
  broker.submit('phone-003', 'thread/start', {});
  broker.receive({ id: sent[1].id, result: { thread: { id: 'new' } } });
  assert.deepEqual(saved, ['new']);
  broker.submit('phone-004', 'thread/resume', { threadId: 'new' });
});

test('a concurrent history response cannot unlock a pending turn start', () => {
  const { broker, upstream } = fixture();
  broker.submit('phone-001', 'turn/start', { threadId: 'a' });
  broker.submit('phone-002', 'thread/read', { threadId: 'a' });
  broker.receive({ id: upstream[1].id, result: { thread: {} } });
  assert.throws(() => broker.submit('phone-003', 'turn/start', { threadId: 'a' }), /正在运行/);
});
