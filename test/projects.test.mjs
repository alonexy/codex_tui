import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopProjects } from '../src/projects.mjs';

test('desktop project names, order, multiple roots and assignments are preserved without other settings', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-projects-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({
    secret: 'must not be returned',
    'local-projects': { a: { name: 'Example Project', rootPaths: ['/repo/core', '/repo/admin'] }, b: { name: 'Other', rootPaths: ['/repo/other'] } },
    'project-order': ['b', 'a'],
    'thread-project-assignments': { assigned: { projectKind: 'local', projectId: 'a' }, remote: { projectKind: 'remote', projectId: 'a' } },
    'projectless-thread-ids': ['loose'],
  }));
  assert.deepEqual(await desktopProjects(path), { projects: [{ id: 'b', name: 'Other', roots: ['/repo/other'] }, { id: 'a', name: 'Example Project', roots: ['/repo/core', '/repo/admin'] }], assignments: { assigned: 'a', loose: null } });
  await writeFile(path, JSON.stringify({
    'local-projects': { a: { name: 'Example Project', rootPaths: ['/repo/core', '/repo/admin'] } },
    'app-server-project-id-by-legacy-project-id-by-host': { [`local:${dir}`]: { a: 'native-project' }, 'local:/other': { a: 'wrong-host' } },
  }));
  assert.equal((await desktopProjects(path)).projects[0].serverId, 'native-project');
  await writeFile(path, '{}');
  await assert.rejects(desktopProjects(path), /项目配置不可用/);
});
