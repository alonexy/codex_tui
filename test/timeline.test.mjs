import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../public/timeline.js';
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
