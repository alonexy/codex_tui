import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastTurnContext, threadModes } from '../src/thread-mode.mjs';

const line = (mode, turnId = 'last-turn') => JSON.stringify({ type: 'turn_context', payload: { turn_id: turnId, collaboration_mode: { mode, settings: { developer_instructions: 'DO NOT EXPOSE' } }, model: 'model', effort: 'high' } });
async function fixture(t, content) {
  const directory = await mkdtemp(join(tmpdir(), 'thread-mode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'rollout.jsonl'); await writeFile(path, content); return path;
}

test('reads the latest complete turn context metadata without exposing body or instructions', async t => {
  const path = await fixture(t, `${line('default', 'old')}\n${JSON.stringify({ type: 'response_item', payload: { text: 'private body' } })}\n${line('plan')}\n`);
  assert.deepEqual(await lastTurnContext(path), { mode: 'plan', turnId: 'last-turn' });
  await writeFile(path, `${line('plan')}\n${line(null, 'newer')}\n`);
  assert.equal(await lastTurnContext(path), null, 'newest unknown mode must not resurrect an older mode');
});

test('handles split records and giant response lines with bounded tail reads', async t => {
  const giant = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1200 * 1024) } });
  const path = await fixture(t, `${line('plan')}\n${giant}\n`);
  assert.equal(await lastTurnContext(path, 64 * 1024), null, 'mode outside the byte limit remains unavailable');
  assert.deepEqual(await lastTurnContext(path), { mode: 'plan', turnId: 'last-turn' });
  await writeFile(path, `${line('default')}\n${line('plan').slice(0, -8)}`);
  assert.deepEqual(await lastTurnContext(path), { mode: 'default', turnId: 'last-turn' });
});

test('only native registered IDs are readable; runtime wins and active turn identity determines provenance', async () => {
  let reads = 0;
  const modes = threadModes({ readContext: async path => { reads++; assert.equal(path, '/native/rollout.jsonl'); return { mode: 'plan', turnId: 'turn-1' }; } });
  assert.equal(await modes.read('foreign', {}), null);
  assert.equal(reads, 0);
  modes.register({ thread: { id: 'allowed', path: '/native/rollout.jsonl' } });
  modes.register({ thread: { id: 'allowed' } });
  assert.deepEqual(await modes.read('allowed', { active: {} }), { threadId: 'allowed', collaborationMode: { mode: 'plan' }, turnId: 'turn-1', source: 'last-turn' });
  assert.equal((await modes.read('allowed', { active: { allowed: 'turn-1' } })).source, 'current-turn');
  assert.equal((await modes.read('allowed', { active: { allowed: 'different-turn' } })).source, 'last-turn');
  assert.deepEqual(await modes.read('allowed', { threadSettings: { allowed: { collaborationMode: { mode: 'default' } } } }), { threadId: 'allowed', collaborationMode: { mode: 'default' }, source: 'runtime' });
  assert.equal(reads, 3);
  assert.deepEqual(await modes.read('allowed', { threadSettings: { allowed: { collaborationMode: null } } }), { threadId: 'allowed', collaborationMode: null, source: 'runtime' });
  modes.register({ thread: { id: 'fresh' } });
  assert.equal((await modes.read('fresh', {})).source, 'unavailable');
  assert.equal(reads, 3);
});

test('missing records fail closed without paths or filesystem error details', async () => {
  const modes = threadModes({ readContext: async () => { throw Error('private path'); } });
  modes.register({ thread: { id: 'missing', path: '/private/missing.jsonl' } });
  assert.deepEqual(await modes.read('missing', {}), { threadId: 'missing', collaborationMode: null, source: 'unavailable' });
});
