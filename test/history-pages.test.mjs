import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryPages } from '../public/history-pages.js';

const entry = (id, text = id) => ({ turnId: 'turn', item: { id, type: 'userMessage', content: [{ type: 'text', text }] } });
test('history pages preserve order, older messages and updated items without full-history calls', async () => {
  const responses = [
    { data: [entry('c'), entry('b')], nextCursor: 'older' },
    { data: [entry('b'), entry('a')], nextCursor: null },
    { data: [entry('d'), entry('c', 'updated')], nextCursor: 'older2' },
  ];
  const calls = [];
  const history = new HistoryPages(async (method, params) => { calls.push({ method, params }); return responses.shift(); });
  assert.deepEqual((await history.read('task')).entries.map(e => e.item.id), ['b', 'c']);
  assert.deepEqual((await history.read('task', true)).entries.map(e => e.item.id), ['a', 'b', 'c']);
  const latest = await history.read('task');
  assert.deepEqual(latest.entries.map(e => e.item.id), ['a', 'b', 'c', 'd']);
  assert.equal(latest.entries[2].item.content[0].text, 'updated');
  assert.equal(latest.cursor, null);
  assert.ok(calls.every(c => c.method === 'thread/items/list' && c.params.sortDirection === 'desc' && c.params.limit === 100));
  assert.equal(calls[1].params.cursor, 'older');
});
