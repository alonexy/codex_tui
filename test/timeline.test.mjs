import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, isProcessItem, turnItems, processSummary } from '../public/timeline.js';
test('identical real submissions remain separate within and across turns', () => {
  const timeline = new Timeline();
  const content = [{ type: 'text', text: '继续' }];
  for (const [turnId, id] of [['one', 'u1'], ['one', 'u2'], ['two', 'u3']]) timeline.event({ method: 'item/completed', params: { threadId: 'a', turnId, item: { id, type: 'userMessage', content } } });
  timeline.snapshot('a', { id: 'a', turns: [{ id: 'one', items: [{ id: 'item-1', type: 'userMessage', content }, { id: 'item-2', type: 'userMessage', content }] }] });
  assert.equal(timeline.thread('a').turns.flatMap(t => t.items).length, 3);
  timeline.snapshot('a', { id: 'a', turns: ['one', 'two'].map(id => ({ id, items: [{ id: 'item-1', type: 'userMessage', content }] })) });
  assert.equal(timeline.thread('a').turns.length, 2);
});
test('a live user message and temporary history ID render once, including after interruption', () => {
  const timeline = new Timeline();
  const content = [{ type: 'text', text: '同一条消息', text_elements: [] }];
  const item = { id: 'live-uuid', type: 'userMessage', content };
  timeline.event({ method: 'item/completed', params: { threadId: 'a', turnId: 'turn', item } });
  timeline.snapshot('a', { id: 'a', turns: [{ id: 'turn', items: [{ ...item, id: 'item-2' }] }] });
  assert.equal(timeline.thread('a').turns.flatMap(t => t.items).length, 1);
  timeline.event({ method: 'item/completed', params: { threadId: 'a', turnId: 'turn', item } });
  assert.equal(timeline.thread('a').turns.flatMap(t => t.items).length, 1);
  timeline.snapshot('a', { id: 'a', turns: [{ id: 'turn', items: [item] }] });
  assert.equal(timeline.thread('a').turns.flatMap(t => t.items).length, 1);
});
test('streamed assistant and user messages reconcile with history without duplicates', () => {
  const timeline = new Timeline();
  const user = { id: 'u', type: 'userMessage', content: [{ type: 'text', text: '问题' }] };
  timeline.event({ method: 'item/started', params: { threadId: 'a', item: user } });
  timeline.event({ method: 'item/agentMessage/delta', params: { threadId: 'a', itemId: 'reply', delta: '答' } });
  timeline.event({ method: 'item/agentMessage/delta', params: { threadId: 'a', itemId: 'reply', delta: '案' } });
  let items = timeline.thread('a').turns.flatMap(t => t.items);
  assert.equal(items.length, 2); assert.equal(items[1].text, '答案');
  timeline.snapshot('a', { id: 'a', turns: [{ items: [user, { id: 'reply', type: 'agentMessage', text: '答案' }] }] });
  items = timeline.thread('a').turns.flatMap(t => t.items);
  assert.equal(items.length, 2);
  timeline.event({ method: 'item/agentMessage/delta', params: { threadId: 'b', itemId: 'other', delta: '别的任务' } });
  assert.equal(timeline.thread('a').turns.flatMap(t => t.items).length, 2);
});

test('only explicit commentary hides assistant prose; final, unknown and questions stay outside', () => {
  for (const phase of [undefined, null, 'final_answer', 'future_phase']) assert.equal(isProcessItem({ type: 'agentMessage', phase }), false);
  assert.equal(isProcessItem({ type: 'agentMessage', phase: 'commentary' }), true);
  assert.equal(isProcessItem({ type: 'agentMessage', phase: 'commentary', questions: [{ id: 'question' }] }), false);
  assert.equal(isProcessItem({ type: 'userMessage' }), false);
  for (const type of ['plan', 'commandExecution', 'fileChange', 'reasoning', 'subAgentActivity', 'futureTool']) assert.equal(isProcessItem({ type }), true);
});

test('summaries use turn duration, unique successful paths and accurately scoped failures', () => {
  const items = [
    { id: 'edit-a', type: 'fileChange', status: 'completed', changes: [{ path: '/repo/a.js' }, { path: '/repo/b.js' }] },
    { id: 'edit-b', type: 'fileChange', status: 'completed', changes: [{ path: '/repo/a.js' }] },
    { id: 'edit-failed', type: 'fileChange', status: 'failed', changes: [{ path: '/repo/c.js' }] },
    { id: 'command', type: 'commandExecution', durationMs: 999999, status: 'failed', exitCode: 1 },
  ];
  const summary = processSummary({ status: 'completed', durationMs: 39004, items });
  assert.equal(summary.text, '执行过程 · 已完成 · 用时 39 秒 · 修改 2 个文件（已加载记录） · 有操作未成功');
  assert.equal(summary.attention, true);
  assert.equal(summary.error, '');
  assert.equal(summary.action, '');
  assert.ok(!processSummary({ items }).text.includes('用时'));
  assert.ok(!processSummary({ status: 'completed', items: [{ type: 'fileChange', changes: [{ path: '/repo/a' }] }] }).text.includes('修改'));
  assert.ok(!processSummary({ status: 'completed', itemsView: 'full', items }).text.includes('已加载记录'));
});

test('missing metadata stays unknown, running actions are short and interrupted turns stay visible', () => {
  const items = [{ type: 'commandExecution', command: 'a'.repeat(300), durationMs: 60000 }];
  assert.equal(processSummary({ items }).text, '执行过程');
  assert.equal(processSummary({ items }, true).action, '执行命令');
  assert.equal(processSummary({ status: 'inProgress', durationMs: 3000, items }).text, '执行过程 · 进行中');
  assert.equal(processSummary({ status: 'completed', startedAt: 100, completedAt: 165 }).text, '执行过程 · 已完成 · 用时 1 分 5 秒');
  assert.equal(processSummary({ status: 'completed', startedAt: 200, completedAt: 100, durationMs: -1 }).text, '执行过程 · 已完成');
  assert.equal(processSummary({ status: 'interrupted' }).attention, true);
  assert.equal(processSummary({ status: 'failed', error: { message: '模拟轮次失败' } }).error, '模拟轮次失败');
});

test('turn events and partial snapshots preserve confirmed completion and timing', () => {
  const timeline = new Timeline();
  timeline.event({ method: 'turn/started', params: { threadId: 'a', turn: { id: 'turn', startedAt: 100 } } });
  timeline.event({ method: 'item/started', params: { threadId: 'a', turnId: 'turn', item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '' } } });
  timeline.event({ method: 'item/agentMessage/delta', params: { threadId: 'a', turnId: 'turn', itemId: 'progress', delta: '开始检查' } });
  assert.equal(timeline.thread('a').turns[0].items[0].phase, 'commentary');
  timeline.event({ method: 'turn/completed', params: { threadId: 'a', turn: { id: 'turn', status: 'completed', durationMs: 4000, completedAt: 104 } } });
  timeline.metadata('a', [{ id: 'turn', status: 'inProgress', durationMs: null }]);
  timeline.snapshot('a', { id: 'a', turns: [{ id: 'turn', items: [], itemsView: 'partial' }] });
  timeline.metadata('a', [{ id: 'turn', status: 'completed', durationMs: null }]);
  const turn = timeline.thread('a').turns[0];
  assert.equal(turn.status, 'completed'); assert.equal(turn.durationMs, 4000);
  assert.equal(turn.startedAt, 100); assert.equal(turn.itemsView, 'partial');
  assert.equal(turn.items.length, 1);
  assert.equal(timeline.thread('b').turns.length, 0);
});

test('an empty failed turn has a visible status and duplicate item IDs are reconciled', () => {
  const timeline = new Timeline();
  timeline.event({ method: 'turn/completed', params: { threadId: 'a', turn: { id: 'failed', status: 'failed', error: { message: '模拟失败' } } } });
  assert.equal(timeline.thread('a').turns[0].status, 'failed');
  const items = [{ id: 'a', text: 'before' }, { id: 'b' }, { id: 'a', text: 'after' }];
  assert.deepEqual(turnItems({ items }), [{ id: 'a', text: 'after' }, { id: 'b' }]);
  timeline.snapshot('a', { id: 'a', turns: [{ id: 'turn', items }] });
  assert.equal(timeline.thread('a').turns[0].items.length, 2);
});
