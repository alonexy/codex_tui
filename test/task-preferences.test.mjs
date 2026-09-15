import test from 'node:test';
import assert from 'node:assert/strict';
import { taskPreferences } from '../public/task-preferences.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('project expansion, component directories, and favorites survive a new page', () => {
  const local = storage(), first = taskPreferences(local);
  first.setExpanded('project-a', false);
  first.rememberWorkspace('project-a', '/work/a/backend');
  first.rememberWorkspace('project-b', '/work/b');
  first.toggleFavorite({ id: 'task-1', name: '重要任务', cwd: '/work/a/backend', secret: 'must not persist', turns: [{ text: 'private message' }] });
  const restored = taskPreferences(local);
  assert.equal(restored.expanded('project-a'), false);
  assert.equal(restored.expanded('new-project'), true);
  assert.equal(restored.lastProject(), 'project-b');
  assert.equal(restored.workspace('project-a'), '/work/a/backend');
  assert.deepEqual(restored.favorites(), [{ id: 'task-1', name: '重要任务', cwd: '/work/a/backend' }]);
  restored.refreshFavorites([{ id: 'task-1', name: '更新标题', cwd: '/work/a/backend' }]);
  assert.equal(taskPreferences(local).favorites()[0].name, '更新标题');
  restored.toggleFavorite({ id: 'task-1' });
  assert.deepEqual(taskPreferences(local).favorites(), []);
});

test('storage failures preserve usable in-memory choices', () => {
  const preferences = taskPreferences({ getItem() { throw Error('disabled'); }, setItem() { throw Error('quota'); } });
  assert.doesNotThrow(() => {
    preferences.setExpanded('project', false);
    preferences.rememberWorkspace('', '/custom');
    preferences.toggleFavorite({ id: 'thread' });
  });
  assert.equal(preferences.expanded('project'), false);
  assert.equal(preferences.workspace(''), '/custom');
  assert.equal(preferences.isFavorite('thread'), true);
});

test('malformed persisted data is ignored without trusting arbitrary task fields', () => {
  assert.doesNotThrow(() => taskPreferences({ getItem: () => '{broken' }));
  const preferences = taskPreferences({ getItem: () => JSON.stringify({
    expansion: { good: false, bad: 'false' }, workspaces: { good: '/work', bad: 42 },
    favorites: [null, { id: 3 }, { id: 'valid', name: {}, turns: ['private'] }], lastProject: {},
  }) });
  assert.equal(preferences.expanded('good'), false);
  assert.equal(preferences.expanded('bad'), true);
  assert.equal(preferences.workspace('bad'), undefined);
  assert.equal(preferences.lastProject(), null);
  assert.deepEqual(preferences.favorites(), [{ id: 'valid' }]);
});
