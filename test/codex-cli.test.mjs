import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { resolveCodexCli } from '../src/codex-cli.mjs';

async function fixture(t) {
  const resourcesPath = await mkdtemp('/private/tmp/codex-cli-');
  t.after(() => rm(resourcesPath, { recursive: true, force: true }));
  const modern = join(resourcesPath, 'codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const legacy = join(resourcesPath, 'codex');
  const executable = async path => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  };
  return { resourcesPath, modern, legacy, executable };
}

test('CLI resolver prefers the new signed app layout and supports the old layout', async t => {
  const f = await fixture(t);
  await f.executable(f.legacy);
  assert.equal(resolveCodexCli({ resourcesPath: f.resourcesPath, env: {} }), f.legacy);
  await f.executable(f.modern);
  assert.equal(resolveCodexCli({ resourcesPath: f.resourcesPath, env: {} }), f.modern);
});

test('explicit CLI override wins and a broken override cannot silently fall back', async t => {
  const f = await fixture(t);
  await f.executable(f.modern);
  await f.executable(f.legacy);
  assert.equal(resolveCodexCli({ resourcesPath: f.resourcesPath, env: { CODEX_REAL_CLI: f.legacy } }), f.legacy);
  for (const path of [join(f.resourcesPath, 'missing'), '']) {
    assert.throws(() => resolveCodexCli({ resourcesPath: f.resourcesPath, env: { CODEX_REAL_CLI: path } }), /CODEX_REAL_CLI/);
  }
});

test('missing or nonexecutable bundled CLI fails with actionable diagnostics', async t => {
  const f = await fixture(t);
  assert.throws(() => resolveCodexCli({ resourcesPath: f.resourcesPath, env: {} }), /CLI.*安装|安装.*CLI/);
  await writeFile(f.legacy, 'not executable', { mode: 0o600 });
  assert.throws(() => resolveCodexCli({ resourcesPath: f.resourcesPath, env: {} }), /CLI.*安装|安装.*CLI/);
});
