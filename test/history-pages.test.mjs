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
  const history = new HistoryPages(async (method, params) => {
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    calls.push({ method, params }); return responses.shift();
  });
  assert.deepEqual((await history.read('task')).entries.map(e => e.item.id), ['b', 'c']);
  assert.deepEqual((await history.read('task', true)).entries.map(e => e.item.id), ['a', 'b', 'c']);
  const latest = await history.read('task');
  assert.deepEqual(latest.entries.map(e => e.item.id), ['a', 'b', 'c', 'd']);
  assert.equal(latest.entries[2].item.content[0].text, 'updated');
  assert.equal(latest.cursor, null);
  assert.ok(calls.every(c => c.method === 'thread/items/list' && c.params.sortDirection === 'desc' && c.params.limit === 100));
  assert.equal(calls[1].params.cursor, 'older');
});

test('slow or unavailable turn metadata cannot hold messages or fabricate completion', async () => {
  let resolveMetadata, fail = false;
  const received = [];
  const history = new HistoryPages(async method => {
    if (method === 'thread/items/list') return { data: [entry('a')], nextCursor: null };
    if (fail) throw Error('metadata unavailable');
    return new Promise(resolve => { resolveMetadata = resolve; });
  }, (id, turns) => received.push({ id, turns }));
  const page = await history.read('task');
  assert.equal(page.thread.turns[0].status, undefined);
  assert.equal(page.entries.length, 1);
  resolveMetadata({ data: [{ id: 'turn', status: 'inProgress', startedAt: 100, items: [], itemsView: 'notLoaded' }], nextCursor: null });
  await history.metadataPending.get('task');
  assert.equal(page.thread.turns[0].status, 'inProgress');
  assert.equal(page.thread.turns[0].items.length, 1);
  assert.equal(page.thread.turns[0].itemsView, 'partial');
  assert.equal(received.length, 1);
  fail = true;
  assert.equal((await history.read('task')).entries.length, 1);
  await history.metadataPending.get('task');
  assert.equal(history.pages.get('task').thread.turns[0].durationMs, undefined);
});

test('loading older items while metadata is pending schedules metadata for the new turn', async () => {
  let release;
  const calls = [];
  const history = new HistoryPages(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/items/list') return { data: [{ turnId: params.cursor ? 'old' : 'new', item: entry(params.cursor ? 'a' : 'b').item }], nextCursor: params.cursor ? null : 'older' };
    if (calls.filter(call => call.method === 'thread/turns/list').length === 1) return new Promise(resolve => { release = resolve; });
    return { data: [{ id: 'new', status: 'completed' }, { id: 'old', status: 'completed', durationMs: 2000 }], nextCursor: null };
  });
  await history.read('task');
  await history.read('task', true);
  const first = history.metadataPending.get('task');
  release({ data: [{ id: 'new', status: 'completed', durationMs: 1000 }], nextCursor: null });
  await first;
  await history.metadataPending.get('task');
  assert.equal(history.pages.get('task').thread.turns[0].durationMs, 2000);
  assert.equal(calls.filter(call => call.method === 'thread/turns/list').length, 2);
  assert.ok(calls.filter(call => call.method === 'thread/turns/list').every(call => call.params.itemsView === 'notLoaded'));
});

test('metadata pagination is bounded when a provider never returns the requested turn', async () => {
  let reads = 0;
  const history = new HistoryPages(async method => method === 'thread/items/list'
    ? { data: [entry('a')], nextCursor: null }
    : { data: [], nextCursor: String(++reads) });
  await history.read('task');
  await history.metadataPending.get('task');
  assert.equal(reads, 4);
  assert.equal(history.pages.get('task').thread.turns[0].status, undefined);
});
