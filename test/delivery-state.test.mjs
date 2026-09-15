import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryState, deliveryLabel } from '../public/delivery-state.js';

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
test('pending submission survives reload and only its final receipt releases execution', () => {
  const store = storage(), original = new DeliveryState(store);
  original.begin('request-1', 'turn/start', 'task-1');
  const reloaded = new DeliveryState(store);
  assert.equal(reloaded.pending.threadId, 'task-1');
  assert.throws(() => reloaded.begin('request-2', 'turn/start', 'task-2'), /待确认/);
  assert.equal(reloaded.settle('request-2', 'completed'), false);
  assert.equal(reloaded.settle('request-1', 'pending'), false);
  assert.equal(reloaded.settle('request-1', 'completed'), true);
  assert.equal(new DeliveryState(store).pending, null);
  reloaded.begin('request-2', 'turn/start', 'task-2');
  assert.equal(reloaded.settle('request-2', 'failed'), true);
});
test('legacy receipt identifiers and unavailable storage fail safely', () => {
  const store = storage(); store.setItem('codex-pending', 'legacy-id');
  assert.equal(new DeliveryState(store).pending.key, 'legacy-id');
  const denied = new DeliveryState({ getItem() { throw Error(); }, setItem() { throw Error(); } });
  assert.throws(() => denied.begin('id', 'turn/start', 'task'), /会话存储/);
  assert.equal(denied.pending, null);
});
test('connection loss and unknown submission take precedence over stale running state', () => {
  assert.match(deliveryLabel({ connected: false, pending: true, running: true }), /发送结果待确认/);
  assert.equal(deliveryLabel({ connected: true, running: true, outcome: '已接收' }), '执行中');
  assert.equal(deliveryLabel({ connected: true, outcome: '已完成' }), '已完成');
});

test('only naming receipts persist the requested session name for reload recovery', () => {
  const store = storage(), state = new DeliveryState(store);
  for (const method of ['thread/start', 'thread/name/set']) {
    state.begin('key', method, 'task', '  会话名称  ');
    assert.equal(new DeliveryState(store).pending.name, '会话名称');
    state.settle('key', 'completed');
  }
  state.begin('message', 'turn/start', 'task', 'must not persist message text');
  assert.equal(Object.hasOwn(new DeliveryState(store).pending, 'name'), false);
});

test('creation-to-naming handoff survives reload without persisting thread messages', () => {
  const store = storage(), state = new DeliveryState(store);
  state.begin('create', 'thread/start', undefined, '新名称');
  state.settle('create', 'completed', { thread: { id: 'created', cwd: '/work', projectId: 'project', turns: [{ text: 'private message' }] } });
  const reloaded = new DeliveryState(store);
  assert.equal(reloaded.pending, null);
  assert.deepEqual(reloaded.createdNaming, { threadId: 'created', name: '新名称', cwd: '/work', projectId: 'project' });
  reloaded.begin('rename', 'thread/name/set', 'created', '新名称');
  reloaded.settle('rename', 'failed');
  assert.equal(new DeliveryState(store).createdNaming.name, '新名称');
  reloaded.begin('retry', 'thread/name/set', 'created', '新名称');
  reloaded.settle('retry', 'completed', {});
  assert.equal(new DeliveryState(store).createdNaming, null);
});

test('failed handoff storage retains the confirmed creation receipt instead of permitting replay', () => {
  const store = storage(), state = new DeliveryState(store);
  state.begin('create', 'thread/start', undefined, '新名称');
  store.setItem = () => { throw Error('storage denied'); };
  assert.throws(() => state.settle('create', 'completed', { thread: { id: 'created', cwd: '/work' } }), /storage denied/);
  assert.equal(state.pending.key, 'create');
  assert.equal(new DeliveryState(store).pending.key, 'create');
  assert.throws(() => state.begin('again', 'thread/start'), /待确认/);
});
