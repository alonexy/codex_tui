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

test('question receipts restore pending identities without allowing another submission', () => {
  for (const method of ['turn/start', 'turn/steer']) {
    const store = storage(), state = new DeliveryState(store);
    const ids = ['question-1', 'question-2'];
    state.begin('question-send', method, 'task', undefined, [...ids, ids[0]]);
    const restored = new DeliveryState(store);
    assert.deepEqual(restored.pending.questionIds, ids);
    for (const id of ids) assert.equal(restored.questionStatus('task', id), 'pending');
    assert.equal(restored.questionStatus('other-task', ids[0]), undefined);
    assert.equal(restored.questionStatus('task', 'other-question'), undefined);
    assert.equal(restored.settle('question-send', 'pending'), false);
    assert.equal(restored.settle('another-receipt', 'completed'), false);
    assert.throws(() => restored.begin('duplicate', method, 'task', undefined, ids), /待确认/);
    assert.equal(new DeliveryState(store).questionStatus('task', ids[0]), 'pending');
  }
});

test('completed question receipts suppress history lag and answered status never regresses', () => {
  const store = storage(), state = new DeliveryState(store);
  state.begin('question-send', 'turn/steer', 'task', undefined, ['question']);
  assert.equal(state.settle('question-send', 'completed'), true);
  const restored = new DeliveryState(store);
  assert.equal(restored.pending, null);
  assert.equal(restored.questionStatus('task', 'question'), 'submitted');
  restored.recordQuestions('task', [], 'answered');
  assert.equal(restored.questionStatus('task', 'question'), 'submitted');
  restored.recordQuestions('task', ['question'], 'answered');
  restored.recordQuestions('task', ['question'], 'submitted');
  restored.recordQuestions('task', ['question'], undefined);
  assert.equal(new DeliveryState(store).questionStatus('task', 'question'), 'answered');
  assert.equal(restored.questionStatus('other-task', 'question'), undefined);
});

test('question receipt storage persists identities and status without answer contents', () => {
  const store = storage(), state = new DeliveryState(store);
  const secretAnswer = 'PRIVATE-ANSWER-MUST-NOT-PERSIST';
  state.begin('question-send', 'turn/start', 'task', secretAnswer, ['question']);
  const pending = JSON.parse(store.getItem('codex-pending'));
  assert.deepEqual(Object.keys(pending).sort(), ['createdAt', 'key', 'method', 'questionIds', 'threadId']);
  assert.ok(!JSON.stringify(pending).includes(secretAnswer));
  state.settle('question-send', 'completed', { answer: secretAnswer, thread: { turns: [{ text: secretAnswer }] } });
  state.recordQuestions('task', ['question'], 'answered');
  assert.equal(store.getItem('codex-pending'), null);
  assert.equal(store.getItem('codex-created-name'), null);
  assert.deepEqual(JSON.parse(store.getItem('codex-question-submissions')), [['task', [['question', 'answered']]]]);
});

test('failed question receipts release pending state and permit an explicit retry', () => {
  const store = storage(), state = new DeliveryState(store);
  state.begin('failed-send', 'turn/steer', 'task', undefined, ['question']);
  assert.equal(state.settle('failed-send', 'failed'), true);
  const restored = new DeliveryState(store);
  assert.equal(restored.pending, null);
  assert.equal(restored.questionStatus('task', 'question'), undefined);
  restored.begin('retry-send', 'turn/steer', 'task', undefined, ['question']);
  assert.equal(restored.questionStatus('task', 'question'), 'pending');
  assert.equal(restored.settle('failed-send', 'completed'), false);
  assert.equal(restored.settle('retry-send', 'completed'), true);
  assert.equal(new DeliveryState(store).questionStatus('task', 'question'), 'submitted');
});

test('question submission storage failure retains the receipt until it can be safely settled', () => {
  const store = storage(), state = new DeliveryState(store);
  state.begin('question-send', 'turn/steer', 'task', undefined, ['question']);
  const write = store.setItem;
  store.setItem = (key, value) => {
    if (key === 'codex-question-submissions') throw Error('question storage denied');
    return write(key, value);
  };
  assert.throws(() => state.settle('question-send', 'completed'), /question storage denied/);
  assert.equal(state.pending.key, 'question-send');
  assert.equal(state.questionStatus('task', 'question'), 'pending');
  const restored = new DeliveryState(store);
  assert.equal(restored.pending.key, 'question-send');
  assert.equal(restored.questionStatus('task', 'question'), 'pending');
  assert.throws(() => restored.begin('duplicate', 'turn/steer', 'task'), /待确认/);
  store.setItem = write;
  assert.equal(restored.settle('question-send', 'completed'), true);
  assert.equal(new DeliveryState(store).questionStatus('task', 'question'), 'submitted');
});

test('failed receipt removal preserves pending identity after saving submitted status', () => {
  const store = storage(), state = new DeliveryState(store);
  state.begin('question-send', 'turn/start', 'task', undefined, ['question']);
  const remove = store.removeItem;
  store.removeItem = () => { throw Error('receipt removal denied'); };
  assert.throws(() => state.settle('question-send', 'completed'), /receipt removal denied/);
  assert.equal(state.pending.key, 'question-send');
  const restored = new DeliveryState(store);
  assert.equal(restored.questionStatus('task', 'question'), 'pending');
  assert.throws(() => restored.begin('duplicate', 'turn/start', 'task'), /待确认/);
  store.removeItem = remove;
  assert.equal(restored.settle('question-send', 'completed'), true);
  assert.equal(new DeliveryState(store).questionStatus('task', 'question'), 'submitted');
});
