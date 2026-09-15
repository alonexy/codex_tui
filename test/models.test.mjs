import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopModels } from '../src/models.mjs';

test('desktop model cache exposes only visible display metadata and supported efforts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'models_cache.json');
  const fetchedAt = '2026-09-15T01:00:00Z';
  const visible = { slug: 'model-a', display_name: 'Model A', description: 'Description', visibility: 'list', priority: 2,
    default_reasoning_level: 'future-effort', supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }, { effort: 'future-effort', description: 'New service option', private: 'secret' }],
    model_messages: { instructions: 'private-instructions' }, api_key: 'secret' };
  await writeFile(path, JSON.stringify({ fetched_at: fetchedAt, private: 'secret', models: [visible,
    { ...visible, slug: 'hidden', visibility: 'hide', priority: 0 }, { ...visible, slug: 'unknown', visibility: 'future' },
    { ...visible, slug: 'model-b', priority: 1, default_reasoning_level: 'unsupported', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'low' }, null, { effort: '' }] },
    { ...visible }, null, { visibility: 'list' },
  ] }));
  const result = await desktopModels({ path, now: () => Date.parse(fetchedAt) + 1000 });
  assert.deepEqual(result, { source: 'desktop-cache', fetchedAt: '2026-09-15T01:00:00.000Z', stale: false, models: [
    { id: 'model-b', displayName: 'Model A', description: 'Description', defaultReasoningEffort: null, supportedReasoningEfforts: [{ effort: 'low', description: '' }] },
    { id: 'model-a', displayName: 'Model A', description: 'Description', defaultReasoningEffort: 'future-effort', supportedReasoningEfforts: [{ effort: 'low', description: 'Fast' }, { effort: 'future-effort', description: 'New service option' }] },
  ] });
  assert.doesNotMatch(JSON.stringify(result), /secret|instructions|hidden|unknown|priority/);
  assert.equal((await desktopModels({ path, now: () => Date.parse(fetchedAt) + 86400001 })).stale, true);
  await writeFile(path, JSON.stringify({ fetched_at: 'invalid', models: [] }));
  assert.deepEqual(await desktopModels({ path }), { source: 'desktop-cache', fetchedAt: null, stale: true, models: [] });
});

test('cache failures have safe errors and the default location honors CODEX_HOME', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'models_cache.json');
  const safeError = error => { assert.match(error.message, /模型目录/); assert.doesNotMatch(error.message, /model-catalog-|ENOENT|private-prompt/); return true; };
  await assert.rejects(desktopModels({ path }), safeError);
  await writeFile(path, '{ private-prompt');
  await assert.rejects(desktopModels({ path }), safeError);
  await writeFile(path, '{"models":{}}');
  await assert.rejects(desktopModels({ path }), safeError);
  await writeFile(path, '{"models":[]}');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  try { assert.deepEqual((await desktopModels()).models, []); }
  finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});
